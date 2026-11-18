import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  FAKE_MARK,
  PRICING_DEFAULTS,
  REWRITE_BATCH_CANDIDATE_MULTIPLIER,
  REWRITE_BATCH_CONCURRENCY,
  REWRITE_BATCH_DEFAULT_UNIT_POINTS,
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_SHORT_SOURCE_MSG,
  REWRITE_MIN_SOURCE_CHARS,
  assembleRewriteMessages,
  batchRewriteImageCountForText,
  buildFakeRewriteMarkdown,
  canonicalizeRewriteUrl,
  checkBatchCandidateExclusion,
  computeChar5GramJaccard,
  computeRewriteUrlHash,
  extractArticleFromHtml,
  injectGalleryImages,
  isPrivateOrReservedHostLiteral,
  parseBatchLinkList,
  parseRewrittenMarkdown,
  resolveRewriteBatchTimeouts,
  resolveRewriteSimMax,
  type RewriteComplianceFlags,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { SearchService } from '../infra/search';
import { PrismaService } from '../prisma/prisma.service';
import { ensureBuiltInSystemTemplates } from '../writing/system-templates.helper';

export const REWRITE_BATCH_HANDLER = Symbol('REWRITE_BATCH_HANDLER');
export const REWRITE_BATCH_ENQUEUER = Symbol('REWRITE_BATCH_ENQUEUER');

export interface RewriteBatchHandler {
  process(payload: { tenantId: string; batchId: string }): Promise<void>;
}

export interface RewriteBatchEnqueuer {
  enqueueRewriteBatch(job: { tenantId: string; batchId: string }): Promise<void>;
}

type ClaimStep =
  | { kind: 'stopped' }
  | { kind: 'wait' }
  | { kind: 'drain'; cancelled: boolean }
  | {
      kind: 'claimed';
      recordId: string;
      url: string;
      sourceTitle: string | null;
    };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readableCandidateError(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.kind === PROVIDER_KIND.SSRF) {
      return '内网或受限地址已拦截（未扣点）';
    }
    if (err.kind === PROVIDER_KIND.NOT_PUBLIC || err.kind === PROVIDER_KIND.ROBOTS) {
      return '源页面触发反爬或需登录访问（已跳过，未扣点）';
    }
    if (err.kind === PROVIDER_KIND.TIMEOUT || err.kind === PROVIDER_KIND.CANCELLED) {
      return '源页面响应或改写超时（已跳过，未扣点）';
    }
    if (err.kind === PROVIDER_KIND.CONTRACT) {
      return '目标链接不是有效公开 HTML 页面（已跳过，未扣点）';
    }
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return '单篇抓取或改写超时（已跳过，未扣点）';
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 180);
  }
  return '候选文章抓取或改写失败（已跳过，未扣点）';
}

@Injectable()
export class RewriteBatchRunner implements RewriteBatchHandler {
  private readonly logger = new Logger(RewriteBatchRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(PublicFetchService) private readonly publicFetch: PublicFetchService,
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  private async resolveUnitPoints(): Promise<number> {
    const item = await this.prisma.base.pricingItem.findUnique({
      where: { action: 'rewrite_batch' },
    });
    if (!item) {
      const fallback = PRICING_DEFAULTS.find((p) => p.action === 'rewrite_batch');
      return fallback?.unitPoints ?? REWRITE_BATCH_DEFAULT_UNIT_POINTS;
    }
    return item.unitPoints;
  }

  private async findReservationId(tenantId: string, batchId: string): Promise<string | null> {
    const row = await this.prisma.base.pointReservation.findUnique({
      where: { refType_refId: { refType: 'rewrite_batch', refId: batchId } },
      select: { id: true, tenantId: true },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return row.id;
  }

  async process(payload: { tenantId: string; batchId: string }): Promise<void> {
    const { tenantId, batchId } = payload;
    await ensureBuiltInSystemTemplates(this.prisma);

    const batch = await this.prisma.base.rewriteBatch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        template: { select: { id: true, content: true } },
      },
    });
    if (!batch) return;
    if (
      batch.status === 'PAUSED' ||
      batch.status === 'COMPLETED' ||
      batch.status === 'PARTIAL' ||
      batch.status === 'FAILED' ||
      batch.status === 'CANCELLED'
    ) {
      return;
    }

    const reservationId = await this.findReservationId(tenantId, batchId);
    const { batchTimeoutMs, itemTimeoutMs } = resolveRewriteBatchTimeouts(process.env);
    const deadlineMs = Date.now() + batchTimeoutMs;

    // Recover any stale RUNNING records from crashed workers
    const staleCutoff = new Date(Date.now() - Math.max(120_000, itemTimeoutMs * 2));
    await this.prisma.base.rewriteRecord.updateMany({
      where: {
        batchId,
        tenantId,
        status: 'RUNNING',
        createdAt: { lt: staleCutoff },
      },
      data: { status: 'PENDING' },
    });

    // Step 1: Initialize candidate RewriteRecord rows if none exist yet
    const existingCount = await this.prisma.base.rewriteRecord.count({
      where: { batchId, tenantId },
    });

    if (existingCount === 0) {
      await this.prisma.base.rewriteBatch.updateMany({
        where: { id: batchId, tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'RUNNING', note: '正在寻源并校验公开文章候选链接…' },
      });

      let rawCandidates: Array<{ url: string; urlHash: string; titleHint: string | null }> = [];
      try {
        rawCandidates = await this.discoverCandidates(
          {
            tenantId,
            sourceType: batch.sourceType,
            keyword: batch.keyword,
            maxCount: batch.maxCount,
            linkList: batch.linkList,
          },
          Math.min(itemTimeoutMs, Math.max(300, deadlineMs - Date.now())),
        );
      } catch (searchErr) {
        const reason = readableCandidateError(searchErr);
        await this.closeAndFinish({
          tenantId,
          batchId,
          reservationId,
          status: 'FAILED',
          note: `寻源失败或超时：${reason}（预冻点数已全额退还）`,
        });
        return;
      }

      if (rawCandidates.length === 0) {
        await this.closeAndFinish({
          tenantId,
          batchId,
          reservationId,
          status: 'FAILED',
          note: '未找到可用的新候选链接（可能均已成功复刻过或被过滤），预冻点数已全额退还',
        });
        return;
      }

      await this.prisma.base.$transaction(async (tx) => {
        const current = await tx.rewriteBatch.findFirst({
          where: { id: batchId, tenantId },
          select: { status: true },
        });
        if (!current || current.status === 'CANCELLED') return;
        const already = await tx.rewriteRecord.count({ where: { batchId, tenantId } });
        if (already > 0) return;

        await tx.rewriteRecord.createMany({
          data: rawCandidates.map((cand) => ({
            tenantId,
            batchId,
            url: cand.url,
            urlHash: cand.urlHash,
            pastedText: false,
            sourceTitle: cand.titleHint,
            categoryId: batch.categoryId,
            mediaCategoryId: batch.mediaCategoryId,
            templateId: batch.templateId,
            status: 'PENDING',
          })),
        });
        await tx.rewriteBatch.update({
          where: { id: batchId },
          data: { status: 'RUNNING', note: null },
        });
      });
    } else if (batch.status === 'QUEUED') {
      await this.prisma.base.rewriteBatch.updateMany({
        where: { id: batchId, tenantId, status: 'QUEUED' },
        data: { status: 'RUNNING' },
      });
    }

    // Step 2: Process candidate records concurrently (up to REWRITE_BATCH_CONCURRENCY = 2)
    const unitPoints = await this.resolveUnitPoints();
    const simMax = resolveRewriteSimMax(process.env);
    let timedOut = false;

    const workerLoop = async () => {
      for (;;) {
        if (Date.now() >= deadlineMs) {
          timedOut = true;
          return;
        }

        const step = await this.claimCandidate(tenantId, batchId);
        if (step.kind === 'stopped' || step.kind === 'drain') {
          return;
        }
        if (step.kind === 'wait') {
          await sleepMs(25);
          continue;
        }

        const remainingMs = Math.max(200, deadlineMs - Date.now());
        const perItemBudgetMs = Math.min(itemTimeoutMs, remainingMs);

        await this.executeCandidate({
          tenantId,
          batchId,
          batchName: batch.name,
          categoryId: batch.categoryId,
          mediaCategoryId: batch.mediaCategoryId,
          templateContent: batch.template.content,
          brandHint: batch.brand?.trim() ?? '',
          resultStatus: batch.resultStatus === 'NORMAL' ? 'NORMAL' : 'PENDING',
          recordId: step.recordId,
          url: step.url,
          sourceTitleHint: step.sourceTitle,
          reservationId,
          unitPoints,
          simMax,
          timeoutMs: perItemBudgetMs,
        });
      }
    };

    const workerCount = Math.min(REWRITE_BATCH_CONCURRENCY, Math.max(1, batch.maxCount));
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

    // Step 3: Finalize batch status and release any unused reserved points
    await this.finalizeBatch({
      tenantId,
      batchId,
      reservationId,
      timedOut,
    });
  }

  private async discoverCandidates(
    input: {
      tenantId: string;
      sourceType: string;
      keyword: string;
      maxCount: number;
      linkList: string[];
    },
    timeoutMs: number,
  ): Promise<Array<{ url: string; urlHash: string; titleHint: string | null }>> {
    const cap = Math.min(150, input.maxCount * REWRITE_BATCH_CANDIDATE_MULTIPLIER);
    let initial: Array<{ url: string; urlHash: string; titleHint: string | null }> = [];

    if (input.sourceType === 'link_list') {
      const parsed = parseBatchLinkList(input.linkList, REWRITE_BATCH_LINK_LIST_MAX);
      initial = parsed.candidates.slice(0, cap).map((c) => ({
        url: c.url,
        urlHash: c.urlHash,
        titleHint: null,
      }));
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await this.search.search({
          keyword: input.keyword,
          limit: cap,
          signal: controller.signal,
        });
        const seen = new Set<string>();
        for (const hit of result.hits) {
          // Strictly only use hit.url (and optional hit.title hint); NEVER use hit.snippet as body!
          let canonical: string;
          try {
            canonical = canonicalizeRewriteUrl(hit.url);
          } catch {
            continue;
          }
          let host = '';
          try {
            host = new URL(canonical).hostname;
          } catch {
            continue;
          }
          if (isPrivateOrReservedHostLiteral(host) || !host.includes('.')) continue;
          if (checkBatchCandidateExclusion(canonical)) continue;
          const urlHash = computeRewriteUrlHash(canonical);
          if (seen.has(urlHash)) continue;
          seen.add(urlHash);
          initial.push({
            url: canonical,
            urlHash,
            titleHint: hit.title?.trim() ? hit.title.trim().slice(0, 160) : null,
          });
          if (initial.length >= cap) break;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (initial.length === 0) return [];

    // Exclude URLs already successfully rewritten by this tenant
    const existingSuccess = await this.prisma.base.rewriteRecord.findMany({
      where: {
        tenantId: input.tenantId,
        status: 'SUCCESS',
        urlHash: { in: initial.map((c) => c.urlHash) },
      },
      select: { urlHash: true },
    });
    const doneSet = new Set(existingSuccess.map((r) => r.urlHash));
    return initial.filter((c) => !doneSet.has(c.urlHash));
  }

  private async claimCandidate(tenantId: string, batchId: string): Promise<ClaimStep> {
    return this.prisma.base.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: string; maxCount: number; doneCount: number }>
      >`
        SELECT id, status::text AS status, "maxCount", "doneCount"
        FROM "RewriteBatch"
        WHERE id = ${batchId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const batch = rows[0];
      if (!batch) return { kind: 'stopped' };

      if (batch.status === 'PAUSED') {
        return { kind: 'stopped' };
      }
      if (batch.status === 'CANCELLED') {
        await tx.rewriteRecord.updateMany({
          where: { batchId, tenantId, status: 'PENDING' },
          data: { status: 'SKIPPED', error: '任务已手动终止（未扣点）' },
        });
        return { kind: 'drain', cancelled: true };
      }
      if (batch.status === 'COMPLETED' || batch.status === 'PARTIAL' || batch.status === 'FAILED') {
        return { kind: 'drain', cancelled: false };
      }

      if (batch.doneCount >= batch.maxCount) {
        await tx.rewriteRecord.updateMany({
          where: { batchId, tenantId, status: 'PENDING' },
          data: { status: 'SKIPPED', error: '已凑满目标改写篇数，自动停止后续抓取（未扣点）' },
        });
        return { kind: 'drain', cancelled: false };
      }

      const runningCount = await tx.rewriteRecord.count({
        where: { batchId, tenantId, status: 'RUNNING' },
      });

      // Avoid speculative extra HTTP fetches once doneCount + runningCount already covers maxCount
      if (batch.doneCount + runningCount >= batch.maxCount && runningCount > 0) {
        return { kind: 'wait' };
      }

      const nextRows = await tx.$queryRaw<
        Array<{ id: string; url: string; sourceTitle: string | null }>
      >`
        SELECT id, url, "sourceTitle"
        FROM "RewriteRecord"
        WHERE "batchId" = ${batchId} AND "tenantId" = ${tenantId} AND status = 'PENDING'
        ORDER BY "createdAt" ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const next = nextRows[0];
      if (!next) {
        if (runningCount > 0) {
          return { kind: 'wait' };
        }
        return { kind: 'drain', cancelled: false };
      }

      await tx.rewriteRecord.update({
        where: { id: next.id },
        data: { status: 'RUNNING', error: null },
      });

      return {
        kind: 'claimed',
        recordId: next.id,
        url: next.url,
        sourceTitle: next.sourceTitle,
      };
    });
  }

  private async executeCandidate(input: {
    tenantId: string;
    batchId: string;
    batchName: string;
    categoryId: string;
    mediaCategoryId: string | null;
    templateContent: string;
    brandHint: string;
    resultStatus: 'PENDING' | 'NORMAL';
    recordId: string;
    url: string;
    sourceTitleHint: string | null;
    reservationId: string | null;
    unitPoints: number;
    simMax: number;
    timeoutMs: number;
  }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const fetchPromise = (async () => {
        const page = await this.publicFetch.fetch(input.url, controller.signal);
        const extracted = extractArticleFromHtml(page.body, page.url || input.url);
        const effectiveTitle = extracted.title || input.sourceTitleHint || '行业技术观察';

        if (extracted.charCount < REWRITE_MIN_SOURCE_CHARS) {
          throw new Error(`${REWRITE_BATCH_SHORT_SOURCE_MSG}（当前仅 ${extracted.charCount} 字）`);
        }

        await this.compliance.assertAllowed({
          text: `${effectiveTitle}\n${extracted.contentText}`,
          action: 'rewrite_batch_source',
          tenantId: input.tenantId,
        });

        const unitKey = `rewrite_batch_item:${input.recordId}`;
        const runPass = async (retryHighSimilarity: boolean, passIdx: number) => {
          if (controller.signal.aborted) {
            throw new ProviderError(PROVIDER_KIND.TIMEOUT, '单篇改写超时', 'timeout');
          }
          const messages = assembleRewriteMessages({
            templateContent: input.templateContent,
            sourceTitle: effectiveTitle,
            sourceText: extracted.contentText,
            brand: input.brandHint || undefined,
            retryHighSimilarity,
          });
          const completion = await this.llm.complete({
            tenantId: input.tenantId,
            scene: 'rewrite',
            messages,
            idempotencyKey: `${unitKey}:p${passIdx}`,
            temperature: retryHighSimilarity ? 0.85 : 0.75,
            maxTokens: 2800,
            timeoutMs: retryHighSimilarity ? 25_000 : 40_000,
            maxRetries: 0,
            signal: controller.signal,
          });
          const rawMd =
            completion.fake && completion.text.startsWith(FAKE_MARK)
              ? buildFakeRewriteMarkdown({
                  sourceTitle: effectiveTitle,
                  sourceText: extracted.contentText,
                  brand: input.brandHint || undefined,
                  variant: passIdx,
                })
              : completion.text;

          const parsed = parseRewrittenMarkdown(rawMd, {
            sourceTitle: effectiveTitle,
            brand: input.brandHint || undefined,
          });

          const titleCompliance = await this.compliance.assertAllowed({
            text: parsed.newTitle,
            action: 'rewrite_batch_title',
            tenantId: input.tenantId,
          });
          await this.compliance.assertAllowed({
            text: parsed.contentText,
            action: 'rewrite_batch_body',
            tenantId: input.tenantId,
          });
          const htmlScan = this.compliance.scan(parsed.contentHtml);
          const textScan = this.compliance.scan(parsed.contentText);

          const cleanTitle = titleCompliance.text.trim() || parsed.newTitle;
          const cleanHtml = (htmlScan.text || parsed.contentHtml).replace(/<img\b[^>]*\/?>/gi, '');
          const cleanText = textScan.text || parsed.contentText;
          const similarity = computeChar5GramJaccard(extracted.contentText, cleanText);

          return {
            newTitle: cleanTitle,
            contentHtml: cleanHtml,
            contentText: cleanText,
            similarity,
            softFlags: [...titleCompliance.flags, ...textScan.flags],
          };
        };

        let best = await runPass(false, 0);
        let retriedSimilarity = false;
        if (best.similarity > input.simMax) {
          retriedSimilarity = true;
          const second = await runPass(true, 1);
          if (second.similarity <= best.similarity) {
            best = second;
          }
        }

        const highSimilarity = best.similarity > input.simMax;
        const complianceFlags: RewriteComplianceFlags & { extremeFlags?: string[] } = {
          similarity: best.similarity,
          ...(highSimilarity ? { highSimilarity: true } : {}),
          ...(retriedSimilarity ? { retriedSimilarity: true } : {}),
          ...(best.softFlags.length > 0
            ? { extremeFlags: Array.from(new Set(best.softFlags.map((f) => f.label))) }
            : {}),
        };

        const imageCount = input.mediaCategoryId
          ? batchRewriteImageCountForText(extracted.charCount)
          : 0;

        // Atomically persist Article + RewriteRecord + increment doneCount ONLY if doneCount < maxCount
        const committed = await this.prisma.base.$transaction(async (tx) => {
          const lockedRows = await tx.$queryRaw<
            Array<{ status: string; maxCount: number; doneCount: number }>
          >`
            SELECT status::text AS status, "maxCount", "doneCount"
            FROM "RewriteBatch"
            WHERE id = ${input.batchId} AND "tenantId" = ${input.tenantId}
            FOR UPDATE
          `;
          const lockedBatch = lockedRows[0];
          if (
            !lockedBatch ||
            lockedBatch.status === 'CANCELLED' ||
            lockedBatch.doneCount >= lockedBatch.maxCount
          ) {
            await tx.rewriteRecord.update({
              where: { id: input.recordId },
              data: {
                status: 'SKIPPED',
                sourceTitle: effectiveTitle,
                error:
                  lockedBatch?.status === 'CANCELLED'
                    ? '任务已终止，本篇未入库且未扣点'
                    : '已凑满最大改写量，本篇自动跳过未扣点',
              },
            });
            return false;
          }

          let finalContentHtml = best.contentHtml;
          let coverUrl: string | null = null;
          if (input.mediaCategoryId && imageCount > 0) {
            const assets = await tx.$queryRaw<Array<{ id: string; url: string }>>`
              SELECT id, url
              FROM "MediaAsset"
              WHERE "tenantId" = ${input.tenantId} AND "categoryId" = ${input.mediaCategoryId}
              ORDER BY "usedCount" ASC, "createdAt" ASC
              LIMIT ${imageCount}
              FOR UPDATE
            `;

            const injected = injectGalleryImages({
              contentHtml: best.contentHtml,
              assets,
              title: best.newTitle,
              imageCount,
              coverWhenNoImage: true,
            });

            finalContentHtml = injected.contentHtml;
            coverUrl = injected.coverUrl;

            if (injected.usedAssetIds.length > 0) {
              await tx.mediaAsset.updateMany({
                where: { id: { in: injected.usedAssetIds }, tenantId: input.tenantId },
                data: { usedCount: { increment: 1 } },
              });
            }
          }

          const article = await tx.article.create({
            data: {
              tenantId: input.tenantId,
              categoryId: input.categoryId,
              title: best.newTitle,
              contentHtml: finalContentHtml,
              contentText: best.contentText,
              coverUrl,
              status: input.resultStatus,
              source: 'REWRITE_BATCH',
              sourceUrl: input.url,
              complianceFlags: complianceFlags as Prisma.InputJsonValue,
            },
            select: { id: true },
          });

          await tx.rewriteRecord.update({
            where: { id: input.recordId },
            data: {
              sourceTitle: effectiveTitle,
              newTitle: best.newTitle,
              status: 'SUCCESS',
              error: null,
              similarity: best.similarity,
              articleId: article.id,
              rewrittenAt: new Date(),
            },
          });

          const nextDone = lockedBatch.doneCount + 1;
          await tx.rewriteBatch.update({
            where: { id: input.batchId },
            data: { doneCount: nextDone },
          });

          if (nextDone >= lockedBatch.maxCount) {
            await tx.rewriteRecord.updateMany({
              where: { batchId: input.batchId, tenantId: input.tenantId, status: 'PENDING' },
              data: {
                status: 'SKIPPED',
                error: '已凑满目标改写篇数，自动停止后续抓取（未扣点）',
              },
            });
          }

          return true;
        });

        if (committed && input.reservationId) {
          await this.billing.settle({
            tenantId: input.tenantId,
            reservationId: input.reservationId,
            unitKey,
            action: 'rewrite_batch',
            amount: input.unitPoints,
            title: `批量爆文复刻-${input.batchName}`,
            detail: {
              batchId: input.batchId,
              recordId: input.recordId,
              url: input.url,
              similarity: best.similarity,
            },
          });
        }
      })();

      const timeoutGuard = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new ProviderError(PROVIDER_KIND.TIMEOUT, '单篇抓取或改写超时', 'timeout')),
          { once: true },
        );
      });

      await Promise.race([fetchPromise, timeoutGuard]);
    } catch (err) {
      const reason = readableCandidateError(err);
      await this.prisma.base.rewriteRecord
        .updateMany({
          where: {
            id: input.recordId,
            tenantId: input.tenantId,
            status: { in: ['PENDING', 'RUNNING'] },
          },
          data: {
            status: 'SKIPPED',
            error: reason,
          },
        })
        .catch((updateErr: unknown) => {
          this.logger.warn(
            `failed to mark skipped record ${input.recordId}: ${
              updateErr instanceof Error ? updateErr.message : 'unknown'
            }`,
          );
        });
    } finally {
      clearTimeout(timer);
    }
  }

  private async finalizeBatch(input: {
    tenantId: string;
    batchId: string;
    reservationId: string | null;
    timedOut: boolean;
  }): Promise<void> {
    const batch = await this.prisma.base.rewriteBatch.findFirst({
      where: { id: input.batchId, tenantId: input.tenantId },
      select: { id: true, status: true, maxCount: true, doneCount: true, note: true },
    });
    if (!batch) return;

    // If paused by user and not timed out, leave reservation open for resume
    if (batch.status === 'PAUSED' && !input.timedOut) {
      return;
    }

    if (input.timedOut) {
      await this.prisma.base.rewriteRecord.updateMany({
        where: {
          batchId: input.batchId,
          tenantId: input.tenantId,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        data: {
          status: 'SKIPPED',
          error: '任务总时长达到超时保护上限，自动停止并退还剩余预冻点数',
        },
      });
    }

    const remainingActive = await this.prisma.base.rewriteRecord.count({
      where: {
        batchId: input.batchId,
        tenantId: input.tenantId,
        status: { in: ['PENDING', 'RUNNING'] },
      },
    });
    if (remainingActive > 0 && batch.status !== 'CANCELLED' && batch.doneCount < batch.maxCount) {
      return;
    }

    const latest = await this.prisma.base.rewriteBatch.findFirst({
      where: { id: input.batchId, tenantId: input.tenantId },
      select: { status: true, maxCount: true, doneCount: true },
    });
    if (!latest) return;

    if (latest.status === 'CANCELLED') {
      await this.closeAndFinish({
        tenantId: input.tenantId,
        batchId: input.batchId,
        reservationId: input.reservationId,
        status: 'CANCELLED',
        note: `任务已终止（已完成 ${latest.doneCount}/${latest.maxCount} 篇），未消耗预冻点数已退还`,
      });
      return;
    }

    if (latest.doneCount >= latest.maxCount) {
      await this.closeAndFinish({
        tenantId: input.tenantId,
        batchId: input.batchId,
        reservationId: input.reservationId,
        status: 'COMPLETED',
        note: null,
      });
      return;
    }

    if (input.timedOut) {
      await this.closeAndFinish({
        tenantId: input.tenantId,
        batchId: input.batchId,
        reservationId: input.reservationId,
        status: latest.doneCount > 0 ? 'PARTIAL' : 'FAILED',
        note:
          latest.doneCount > 0
            ? `任务执行超时收尾（实际完成 ${latest.doneCount}/${latest.maxCount} 篇），差额冻结点数已退还`
            : '任务寻源或页面抓取超时，预冻点数已全额退还',
      });
      return;
    }

    if (latest.doneCount > 0) {
      await this.closeAndFinish({
        tenantId: input.tenantId,
        batchId: input.batchId,
        reservationId: input.reservationId,
        status: 'PARTIAL',
        note: `候选不足（实际 ${latest.doneCount}/${latest.maxCount} 篇），差额预冻点数已退还`,
      });
      return;
    }

    await this.closeAndFinish({
      tenantId: input.tenantId,
      batchId: input.batchId,
      reservationId: input.reservationId,
      status: 'FAILED',
      note: '全部候选链接均无法公开抓取有效正文，预冻点数已全额退还',
    });
  }

  private async closeAndFinish(input: {
    tenantId: string;
    batchId: string;
    reservationId: string | null;
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
    note: string | null;
  }): Promise<void> {
    if (input.reservationId) {
      await this.billing
        .close({
          tenantId: input.tenantId,
          reservationId: input.reservationId,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `close reservation ${input.reservationId} failed: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          );
        });
    }

    await this.prisma.base.rewriteBatch.updateMany({
      where: { id: input.batchId, tenantId: input.tenantId },
      data: {
        status: input.status,
        note: input.note,
      },
    });
  }
}
