import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AI_TASK_MAX_CONSECUTIVE_FAILS,
  AI_TASK_MIN_CHARS_DEFAULT,
  AI_TASK_TENANT_CONCURRENCY,
  FAKE_MARK,
  KB_DETAIL_FIELD_KEYS,
  KB_FULL_INJECT_MAX,
  KB_TOP_K_CHUNKS,
  assembleArticleMessages,
  assembleTitleMessages,
  buildFakeArticleMarkdown,
  buildFakeTitleText,
  cleanTitleText,
  emptyKbDetailFields,
  formatKnowledgeFactCard,
  injectGalleryImages,
  pickDirectionAndCopyType,
  pickTaskBrand,
  postProcessArticleMarkdown,
  requiresKbVectorIndex,
  seededShuffle,
  type KbDetailFields,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ComplianceService } from '../infra/compliance';
import { LlmService, type LlmCallResult, type LlmMessage } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { KnowledgeIndexRunner } from '../material/knowledge-index.runner';
import { PrismaService } from '../prisma/prisma.service';
import { ensureBuiltInSystemTemplates } from './system-templates.helper';

export const AI_TASK_HANDLER = Symbol('AI_TASK_HANDLER');
export const AI_TASK_ENQUEUER = Symbol('AI_TASK_ENQUEUER');

export interface AiTaskHandler {
  process(payload: { tenantId: string; taskId: string }): Promise<void>;
  recoverStuckTasks?(): Promise<number>;
}

export interface AiTaskEnqueuer {
  enqueueAiTask(job: { tenantId: string; taskId: string }): Promise<void>;
}

type ClaimOutcome =
  | { kind: 'stopped' }
  | { kind: 'busy' }
  | { kind: 'drain' }
  | {
      kind: 'claimed';
      itemId: string;
      seq: number;
      attempts: number;
      spawnSibling: boolean;
    };

function readDetailFields(raw: unknown): KbDetailFields {
  const base = emptyKbDetailFields();
  if (!raw || typeof raw !== 'object') return base;
  for (const key of KB_DETAIL_FIELD_KEYS) {
    const val = (raw as Record<string, unknown>)[key];
    if (typeof val === 'string') {
      base[key] = val;
    }
  }
  return base;
}

function readCoverWhenNoImage(env: Record<string, string | undefined>): boolean {
  const raw = env.COVER_WHEN_NO_IMAGE?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return true;
}

function readMinChars(env: Record<string, string | undefined>): number {
  const raw = env.AI_TASK_MIN_CHARS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return AI_TASK_MIN_CHARS_DEFAULT;
  const val = Number(raw);
  return Number.isSafeInteger(val) && val >= 50 && val <= 5000 ? val : AI_TASK_MIN_CHARS_DEFAULT;
}

function readRetryDelayMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_TASK_RETRY_DELAY_MS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return 50;
  const val = Number(raw);
  return Number.isSafeInteger(val) && val >= 0 && val <= 10_000 ? val : 50;
}

export function readTaskLlmTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_TASK_LLM_TIMEOUT_MS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return 20_000;
  const val = Number(raw);
  return Number.isSafeInteger(val) && val >= 100 && val <= 120_000 ? val : 20_000;
}

export function readStaleRunningMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_TASK_STALE_RUNNING_MS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return 60_000;
  const val = Number(raw);
  return Number.isSafeInteger(val) && val >= 1_000 && val <= 600_000 ? val : 60_000;
}

function safeErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 200);
  }
  return '单篇生成失败';
}

@Injectable()
export class AiTaskRunner implements AiTaskHandler {
  private readonly logger = new Logger(AiTaskRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(KnowledgeIndexRunner) private readonly kbIndexer: KnowledgeIndexRunner,
    @Optional() @Inject(AI_TASK_ENQUEUER) private readonly enqueuer?: AiTaskEnqueuer,
  ) {}

  async process(payload: { tenantId: string; taskId: string }): Promise<void> {
    await ensureBuiltInSystemTemplates(this.prisma).catch((err: unknown) => {
      this.logger.warn(
        `ensureBuiltInSystemTemplates skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });

    for (;;) {
      const claimed = await this.claimNextItem(payload.tenantId, payload.taskId);
      if (claimed.kind === 'stopped' || claimed.kind === 'busy') {
        return;
      }
      if (claimed.kind === 'drain') {
        await this.finalizeIfComplete(payload.tenantId, payload.taskId);
        return;
      }

      if (claimed.spawnSibling && this.enqueuer) {
        await this.enqueuer
          .enqueueAiTask({ tenantId: payload.tenantId, taskId: payload.taskId })
          .catch((err: unknown) => {
            this.logger.warn(
              `sibling enqueue skipped: ${err instanceof Error ? err.message : 'unknown'}`,
            );
          });
      }

      await this.executeClaimedItem({
        tenantId: payload.tenantId,
        taskId: payload.taskId,
        itemId: claimed.itemId,
        seq: claimed.seq,
        attempts: claimed.attempts,
      });
    }
  }

  async recoverStuckTasks(): Promise<number> {
    const now = Date.now();
    const queuedCutoff = new Date(now - 10_000);
    const staleRunningCutoff = new Date(now - readStaleRunningMs(process.env));

    const candidates = await this.prisma.base.aiTask.findMany({
      where: {
        OR: [{ status: 'QUEUED', createdAt: { lt: queuedCutoff } }, { status: 'RUNNING' }],
      },
      orderBy: { createdAt: 'asc' },
      take: 25,
      select: {
        id: true,
        tenantId: true,
        status: true,
        items: {
          select: { status: true, startedAt: true },
        },
      },
    });

    let recovered = 0;
    for (const task of candidates) {
      const pendingCount = task.items.filter((i) => i.status === 'PENDING').length;
      const runningItems = task.items.filter((i) => i.status === 'RUNNING');
      const freshRunningCount = runningItems.filter(
        (i) => i.startedAt && i.startedAt >= staleRunningCutoff,
      ).length;
      const staleRunningCount = runningItems.length - freshRunningCount;

      const needsDrive =
        task.status === 'QUEUED' ||
        staleRunningCount > 0 ||
        (pendingCount > 0 && freshRunningCount === 0) ||
        (pendingCount === 0 && runningItems.length === 0);

      if (!needsDrive) continue;

      if (this.enqueuer) {
        await this.enqueuer
          .enqueueAiTask({ tenantId: task.tenantId, taskId: task.id })
          .then(() => {
            recovered += 1;
          })
          .catch((err: unknown) => {
            this.logger.warn(
              `recoverStuckTasks enqueue failed for ${task.id}: ${err instanceof Error ? err.message : 'unknown'}`,
            );
          });
      } else {
        await this.process({ tenantId: task.tenantId, taskId: task.id });
        recovered += 1;
      }
    }
    return recovered;
  }

  private async claimNextItem(tenantId: string, taskId: string): Promise<ClaimOutcome> {
    return this.prisma.base.$transaction(async (tx) => {
      const taskRows = await tx.$queryRaw<
        Array<{ id: string; tenantId: string; status: string; target: number }>
      >`
        SELECT id, "tenantId", status::text AS status, target
        FROM "AiTask"
        WHERE id = ${taskId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const task = taskRows[0];
      if (!task) return { kind: 'stopped' };

      if (task.status === 'PAUSED') {
        return { kind: 'stopped' };
      }
      if (task.status === 'CANCELLED') {
        await tx.aiTaskItem.updateMany({
          where: { taskId, status: 'PENDING' },
          data: { status: 'SKIPPED', finishedAt: new Date() },
        });
        return { kind: 'drain' };
      }
      if (task.status === 'COMPLETED' || task.status === 'PARTIAL' || task.status === 'FAILED') {
        return { kind: 'drain' };
      }

      // Recover stale RUNNING items from crashed/restarted workers
      const staleCutoff = new Date(Date.now() - readStaleRunningMs(process.env));
      await tx.aiTaskItem.updateMany({
        where: {
          task: { tenantId },
          status: 'RUNNING',
          startedAt: { lt: staleCutoff },
        },
        data: { status: 'PENDING' },
      });

      const runningCountRows = await tx.$queryRaw<Array<{ cnt: number }>>`
        SELECT COUNT(*)::int AS cnt
        FROM "AiTaskItem" i
        JOIN "AiTask" t ON t.id = i."taskId"
        WHERE t."tenantId" = ${tenantId} AND i.status = 'RUNNING'
      `;
      const runningForTenant = runningCountRows[0]?.cnt ?? 0;
      if (runningForTenant >= AI_TASK_TENANT_CONCURRENCY) {
        return { kind: 'busy' };
      }

      const pendingRows = await tx.$queryRaw<Array<{ id: string; seq: number; attempts: number }>>`
        SELECT id, seq, attempts
        FROM "AiTaskItem"
        WHERE "taskId" = ${taskId} AND status = 'PENDING'
        ORDER BY seq ASC
        LIMIT 2
        FOR UPDATE SKIP LOCKED
      `;

      const picked = pendingRows[0];
      if (!picked) {
        const taskRunning = await tx.aiTaskItem.count({
          where: { taskId, status: 'RUNNING' },
        });
        return taskRunning === 0 ? { kind: 'drain' } : { kind: 'busy' };
      }

      const nextAttempts = picked.attempts + 1;
      await tx.aiTaskItem.update({
        where: { id: picked.id },
        data: {
          status: 'RUNNING',
          attempts: nextAttempts,
          startedAt: new Date(),
        },
      });
      if (task.status === 'QUEUED') {
        await tx.aiTask.update({
          where: { id: taskId },
          data: { status: 'RUNNING' },
        });
      }

      const spawnSibling =
        pendingRows.length > 1 && runningForTenant + 1 < AI_TASK_TENANT_CONCURRENCY;

      return {
        kind: 'claimed',
        itemId: picked.id,
        seq: picked.seq,
        attempts: nextAttempts,
        spawnSibling,
      };
    }, TX_OPTIONS);
  }

  private async executeClaimedItem(input: {
    tenantId: string;
    taskId: string;
    itemId: string;
    seq: number;
    attempts: number;
  }): Promise<void> {
    const task = await this.prisma.base.aiTask.findFirst({
      where: { id: input.taskId, tenantId: input.tenantId },
      include: {
        keyword: true,
        kb: true,
      },
    });
    if (!task) return;

    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: {
        tenantId: input.tenantId,
        refType: 'ai_task',
        refId: task.id,
      },
    });

    try {
      // 1. Select least-used Question with FOR UPDATE SKIP LOCKED
      const question = await this.pickLeastUsedQuestion(input.tenantId, task.keywordId);
      if (!question) {
        throw new Error('训练主词下暂无可用问题');
      }

      const seqIndex = Math.max(0, input.seq - 1);
      const kb = task.kb;

      // 2. Brand rotation
      const brand = pickTaskBrand({
        brands: task.keyword.brands,
        seqIndex,
        seed: task.seed,
        kbBrandShort: kb?.brandShort,
        mainKeyword: task.keyword.main,
      });

      // 3. Content template (explicit or seeded Fisher-Yates shuffle bag)
      const contentTemplate = await this.pickArticleTemplate(
        input.tenantId,
        task.contentTplId,
        seqIndex,
        task.seed,
      );

      // 4. Creative direction & copyType rotation (DETAIL KB only)
      const dirPair =
        kb && kb.mode === 'DETAIL'
          ? pickDirectionAndCopyType({
              directions: kb.directions,
              copyTypes: kb.copyTypes,
              seqIndex,
              seed: task.seed,
            })
          : { direction: null, copyType: null, directionPrompt: null };

      // 5. Knowledge Base Injection (DETAIL fact card | SUMMARY <=6000 full | SUMMARY >6000 pgvector Top-5)
      const kbSection = await this.buildKbSection({
        tenantId: input.tenantId,
        kb,
        questionText: question.text,
        mainKeyword: task.keyword.main,
      });

      // 6. Body LLM generation + compliance + <MIN_CHARS retry once
      const minChars = readMinChars(process.env);
      const bodyOutcome = await this.generateAndCleanBody({
        tenantId: input.tenantId,
        itemId: input.itemId,
        attempts: input.attempts,
        templateContent: contentTemplate.content,
        mainKeyword: task.keyword.main,
        brand,
        companyName: kb?.companyName,
        allowedBrands: task.keyword.brands,
        question: question.text,
        direction: dirPair.direction,
        directionPrompt: dirPair.directionPrompt,
        copyType: dirPair.copyType,
        kbSection,
        minChars,
      });

      // 7. Title generation (question verbatim when titleTplId is null; else LLM title scene)
      const finalTitle = await this.generateAndCleanTitle({
        tenantId: input.tenantId,
        itemId: input.itemId,
        attempts: input.attempts,
        titleTplId: task.titleTplId,
        mainKeyword: task.keyword.main,
        brand,
        companyName: kb?.companyName,
        question: question.text,
        bodyText: bodyOutcome.contentText,
      });

      // 8. Gallery image selection (least-used) & HTML block injection + cover
      const coverWhenNoImage = readCoverWhenNoImage(process.env);
      const imageInjected = await this.pickAndInjectImages({
        tenantId: input.tenantId,
        mediaCategoryId: task.mediaCategoryId,
        imageCount: task.imageCount,
        coverWhenNoImage,
        contentHtml: bodyOutcome.contentHtml,
        title: finalTitle,
      });

      // 9. Check task wasn't cancelled while generating, then persist Article + Quota + Settle
      const persisted = await this.persistSuccess({
        tenantId: input.tenantId,
        taskId: task.id,
        itemId: input.itemId,
        keywordId: task.keywordId,
        categoryId: task.categoryId,
        resultStatus: task.resultStatus,
        questionId: question.id,
        templateId: contentTemplate.id,
        direction: dirPair.direction,
        copyType: dirPair.copyType,
        brand,
        title: finalTitle,
        contentHtml: imageInjected.contentHtml,
        contentText: bodyOutcome.contentText,
        coverUrl: imageInjected.coverUrl,
        complianceFlags: bodyOutcome.complianceFlags,
        model: bodyOutcome.model,
        tokensIn: bodyOutcome.tokensIn,
        tokensOut: bodyOutcome.tokensOut,
      });

      if (persisted === 'cancelled') {
        await this.finalizeIfComplete(input.tenantId, task.id);
        return;
      }

      if (reservation) {
        const split = await this.resolveUnitSplit(task.unitPrice, Boolean(task.kbId));
        await this.billing.settleAiWriteUnit({
          tenantId: input.tenantId,
          reservationId: reservation.id,
          unitKey: `ai_task_item:${input.itemId}`,
          taskName: task.name,
          aiWritePoints: split.aiWritePoints,
          kbAddonPoints: split.kbAddonPoints,
          withKnowledgeBase: split.withKnowledgeBase,
        });
      }
    } catch (error) {
      await this.handleItemFailure({
        tenantId: input.tenantId,
        taskId: task.id,
        taskName: task.name,
        unitPrice: task.unitPrice,
        reservationId: reservation?.id ?? null,
        itemId: input.itemId,
        error,
      });
    }
  }

  private async pickLeastUsedQuestion(
    tenantId: string,
    keywordId: string,
  ): Promise<{ id: string; text: string } | null> {
    return this.prisma.base.$transaction(async (tx) => {
      let rows = await tx.$queryRaw<Array<{ id: string; text: string }>>`
        SELECT id, text
        FROM "Question"
        WHERE "tenantId" = ${tenantId} AND "keywordId" = ${keywordId}
        ORDER BY "usedCount" ASC, random()
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) {
        rows = await tx.$queryRaw<Array<{ id: string; text: string }>>`
          SELECT id, text
          FROM "Question"
          WHERE "tenantId" = ${tenantId} AND "keywordId" = ${keywordId}
          ORDER BY "usedCount" ASC, random()
          LIMIT 1
          FOR UPDATE
        `;
      }
      const picked = rows[0];
      if (!picked) return null;
      await tx.question.update({
        where: { id: picked.id },
        data: {
          usedCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
      return picked;
    }, TX_OPTIONS);
  }

  private async pickArticleTemplate(
    tenantId: string,
    contentTplId: string | null,
    seqIndex: number,
    seed: number,
  ): Promise<{ id: string; content: string }> {
    if (contentTplId) {
      const explicit = await this.prisma.base.promptTemplate.findFirst({
        where: {
          id: contentTplId,
          kind: 'ARTICLE',
          OR: [{ tenantId: null }, { tenantId }],
        },
        select: { id: true, content: true },
      });
      if (explicit) return explicit;
    }

    const pool = await this.prisma.base.promptTemplate.findMany({
      where: {
        kind: 'ARTICLE',
        randomPool: true,
        OR: [{ tenantId: null }, { tenantId }],
      },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      select: { id: true, content: true },
    });
    if (pool.length === 0) {
      throw new Error('暂无可用的文章创作指令模板');
    }
    const shuffled = seededShuffle(pool, seed);
    return shuffled[seqIndex % shuffled.length]!;
  }

  private async buildKbSection(input: {
    tenantId: string;
    kb: {
      id: string;
      mode: 'DETAIL' | 'SUMMARY';
      companyName: string | null;
      brandShort: string | null;
      fields: Prisma.JsonValue | null;
      summaryText: string | null;
    } | null;
    questionText: string;
    mainKeyword: string;
  }): Promise<string | null> {
    const kb = input.kb;
    if (!kb) return null;

    if (kb.mode === 'DETAIL') {
      return formatKnowledgeFactCard({
        companyName: kb.companyName ?? '',
        brandShort: kb.brandShort ?? '',
        fields: readDetailFields(kb.fields),
      });
    }

    const summary = (kb.summaryText ?? '').trim();
    if (!summary) return null;
    if (!requiresKbVectorIndex('SUMMARY', summary)) {
      return `【企业背景资料】\n${summary}`;
    }

    const topChunks = await this.kbIndexer.searchTopChunks({
      tenantId: input.tenantId,
      kbId: kb.id,
      queryText: `${input.questionText} ${input.mainKeyword}`,
      topK: KB_TOP_K_CHUNKS,
    });
    if (topChunks.length > 0) {
      return topChunks
        .map((chunk, idx) => `【资料片段 ${idx + 1}】\n${chunk.content.trim()}`)
        .join('\n\n');
    }
    return `【企业背景资料】\n${Array.from(summary).slice(0, KB_FULL_INJECT_MAX).join('')}`;
  }

  private async callLlmWithRetry(input: {
    tenantId: string;
    scene: 'body' | 'title';
    messages: LlmMessage[];
    idempotencyKey: string;
    temperature: number;
    maxTokens: number;
  }): Promise<LlmCallResult> {
    const baseDelay = readRetryDelayMs(process.env);
    const configuredTimeoutMs = readTaskLlmTimeoutMs(process.env);
    const sceneTimeoutMs =
      input.scene === 'title' ? Math.min(10_000, configuredTimeoutMs) : configuredTimeoutMs;
    const startedAt = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        return await this.llm.complete({
          tenantId: input.tenantId,
          scene: input.scene,
          messages: input.messages,
          idempotencyKey:
            attempt === 0 ? input.idempotencyKey : `${input.idempotencyKey}:r${attempt}`,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          timeoutMs: sceneTimeoutMs,
          maxRetries: 0,
        });
      } catch (err) {
        lastErr = err;
        const isTimeout = err instanceof ProviderError && err.kind === PROVIDER_KIND.TIMEOUT;
        const retryable = err instanceof ProviderError ? err.retryable : true;
        const elapsedMs = Date.now() - startedAt;
        if (
          !retryable ||
          isTimeout ||
          attempt >= 1 ||
          elapsedMs >= Math.max(500, Math.floor(sceneTimeoutMs / 2))
        ) {
          throw err;
        }
        if (baseDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
        }
      }
    }
    throw lastErr;
  }

  private async generateAndCleanBody(input: {
    tenantId: string;
    itemId: string;
    attempts: number;
    templateContent: string;
    mainKeyword: string;
    brand: string;
    companyName?: string | null;
    allowedBrands: readonly string[];
    question: string;
    direction: string | null;
    directionPrompt: string | null;
    copyType: string | null;
    kbSection: string | null;
    minChars: number;
  }): Promise<{
    contentHtml: string;
    contentText: string;
    complianceFlags: Prisma.InputJsonValue | undefined;
    model: string;
    tokensIn: number;
    tokensOut: number;
  }> {
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastModel = 'fake-quality';

    for (let lengthPass = 0; lengthPass < 2; lengthPass += 1) {
      const assembled = assembleArticleMessages({
        templateContent: input.templateContent,
        mainKeyword: input.mainKeyword,
        brand: input.brand,
        companyName: input.companyName,
        allowedBrands: input.allowedBrands,
        question: input.question,
        directionPrompt: input.directionPrompt,
        copyType: input.copyType,
        kbSection: input.kbSection,
        extraLengthHint: lengthPass > 0,
      });

      const completion = await this.callLlmWithRetry({
        tenantId: input.tenantId,
        scene: 'body',
        messages: assembled.messages,
        idempotencyKey: `ai_body:${input.itemId}:a${input.attempts}:p${lengthPass}`,
        temperature: 0.8,
        maxTokens: 2000,
      });

      totalTokensIn += completion.tokensIn;
      totalTokensOut += completion.tokensOut;
      lastModel = completion.model;

      let rawMarkdown = completion.text;
      if (
        completion.fake &&
        rawMarkdown.startsWith(FAKE_MARK) &&
        Array.from(rawMarkdown).length < input.minChars
      ) {
        rawMarkdown = buildFakeArticleMarkdown({
          question: input.question,
          mainKeyword: input.mainKeyword,
          brand: input.brand,
          companyName: input.companyName,
          direction: input.direction,
          copyType: input.copyType,
          hasKb: Boolean(input.kbSection),
          kbSnippet: input.kbSection,
        });
      }

      const scanReport = this.compliance.scan(rawMarkdown);
      if (scanReport.blocked) {
        throw new Error('生成结果命中违禁内容，已拦截');
      }

      const processed = postProcessArticleMarkdown(scanReport.text, {
        question: input.question,
        mainKeyword: input.mainKeyword,
        brand: input.brand,
      });

      if (processed.charCount >= input.minChars) {
        const flagsRecord: Record<string, unknown> = {};
        if (scanReport.flags.length > 0) {
          flagsRecord.extremeFlags = scanReport.flags.map((f) => f.label);
        }
        if (scanReport.hits.length > 0) {
          flagsRecord.replacedLabels = scanReport.hits.map((h) => h.label);
        }
        if (assembled.unknownPlaceholders.length > 0) {
          flagsRecord.unknownPlaceholders = assembled.unknownPlaceholders;
        }
        const complianceFlags =
          Object.keys(flagsRecord).length > 0 ? (flagsRecord as Prisma.InputJsonValue) : undefined;

        return {
          contentHtml: processed.contentHtml,
          contentText: processed.contentText,
          complianceFlags,
          model: lastModel,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
        };
      }
    }

    throw new Error(`生成正文字数不足 ${input.minChars} 字`);
  }

  private async generateAndCleanTitle(input: {
    tenantId: string;
    itemId: string;
    attempts: number;
    titleTplId: string | null;
    mainKeyword: string;
    brand: string;
    companyName?: string | null;
    question: string;
    bodyText: string;
  }): Promise<string> {
    if (!input.titleTplId) {
      const scan = this.compliance.scan(input.question);
      const base = scan.blocked ? input.question : scan.text;
      return base.trim().slice(0, 120) || input.question;
    }

    const tpl = await this.prisma.base.promptTemplate.findFirst({
      where: {
        id: input.titleTplId,
        kind: 'TITLE',
        OR: [{ tenantId: null }, { tenantId: input.tenantId }],
      },
      select: { id: true, content: true },
    });
    if (!tpl) {
      return input.question.trim().slice(0, 120);
    }

    const assembled = assembleTitleMessages({
      templateContent: tpl.content,
      mainKeyword: input.mainKeyword,
      brand: input.brand,
      companyName: input.companyName,
      question: input.question,
      bodyExcerpt: input.bodyText,
    });

    const completion = await this.callLlmWithRetry({
      tenantId: input.tenantId,
      scene: 'title',
      messages: assembled.messages,
      idempotencyKey: `ai_title:${input.itemId}:a${input.attempts}`,
      temperature: 0.5,
      maxTokens: 200,
    });

    const candidate =
      completion.fake && completion.text.startsWith(FAKE_MARK)
        ? buildFakeTitleText(input.question, input.mainKeyword)
        : completion.text;

    const cleaned = cleanTitleText(candidate, input.question);
    const scan = this.compliance.scan(cleaned);
    if (scan.blocked) {
      return cleanTitleText(input.question, input.question);
    }
    return cleanTitleText(scan.text, input.question);
  }

  private async pickAndInjectImages(input: {
    tenantId: string;
    mediaCategoryId: string;
    imageCount: number;
    coverWhenNoImage: boolean;
    contentHtml: string;
    title: string;
  }): Promise<{ contentHtml: string; coverUrl: string | null }> {
    const fetchLimit = input.imageCount > 0 ? input.imageCount : input.coverWhenNoImage ? 1 : 0;
    if (fetchLimit <= 0) {
      return { contentHtml: input.contentHtml, coverUrl: null };
    }

    return this.prisma.base.$transaction(async (tx) => {
      let assets = await tx.$queryRaw<Array<{ id: string; url: string }>>`
        SELECT id, url
        FROM "MediaAsset"
        WHERE "tenantId" = ${input.tenantId} AND "categoryId" = ${input.mediaCategoryId}
        ORDER BY "usedCount" ASC, random()
        LIMIT ${fetchLimit}
        FOR UPDATE SKIP LOCKED
      `;
      if (assets.length < fetchLimit) {
        assets = await tx.$queryRaw<Array<{ id: string; url: string }>>`
          SELECT id, url
          FROM "MediaAsset"
          WHERE "tenantId" = ${input.tenantId} AND "categoryId" = ${input.mediaCategoryId}
          ORDER BY "usedCount" ASC, random()
          LIMIT ${fetchLimit}
          FOR UPDATE
        `;
      }

      const injected = injectGalleryImages({
        contentHtml: input.contentHtml,
        assets,
        title: input.title,
        imageCount: input.imageCount,
        coverWhenNoImage: input.coverWhenNoImage,
      });

      if (injected.usedAssetIds.length > 0) {
        await tx.mediaAsset.updateMany({
          where: { id: { in: injected.usedAssetIds }, tenantId: input.tenantId },
          data: { usedCount: { increment: 1 } },
        });
      }

      return {
        contentHtml: injected.contentHtml,
        coverUrl: injected.coverUrl,
      };
    }, TX_OPTIONS);
  }

  private async persistSuccess(input: {
    tenantId: string;
    taskId: string;
    itemId: string;
    keywordId: string;
    categoryId: string;
    resultStatus: 'PENDING' | 'NORMAL' | 'DISABLED';
    questionId: string;
    templateId: string;
    direction: string | null;
    copyType: string | null;
    brand: string;
    title: string;
    contentHtml: string;
    contentText: string;
    coverUrl: string | null;
    complianceFlags: Prisma.InputJsonValue | undefined;
    model: string;
    tokensIn: number;
    tokensOut: number;
  }): Promise<'saved' | 'cancelled'> {
    return this.prisma.base.$transaction(async (tx) => {
      const taskRows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status
        FROM "AiTask"
        WHERE id = ${input.taskId} AND "tenantId" = ${input.tenantId}
        FOR UPDATE
      `;
      const taskStatus = taskRows[0]?.status;
      if (taskStatus === 'CANCELLED') {
        await tx.aiTaskItem.update({
          where: { id: input.itemId },
          data: { status: 'SKIPPED', finishedAt: new Date() },
        });
        return 'cancelled';
      }

      const existingItem = await tx.aiTaskItem.findUnique({
        where: { id: input.itemId },
        select: { articleId: true, status: true },
      });
      if (existingItem?.articleId && existingItem.status === 'SUCCESS') {
        return 'saved';
      }

      const now = new Date();
      const article = await tx.article.create({
        data: {
          tenantId: input.tenantId,
          categoryId: input.categoryId,
          title: input.title,
          contentHtml: input.contentHtml,
          contentText: input.contentText,
          coverUrl: input.coverUrl,
          status: input.resultStatus,
          source: 'AI_TASK',
          aiTaskId: input.taskId,
          complianceFlags: input.complianceFlags,
        },
      });

      await tx.aiTaskItem.update({
        where: { id: input.itemId },
        data: {
          questionId: input.questionId,
          templateId: input.templateId,
          direction: input.direction,
          copyType: input.copyType,
          brand: input.brand,
          title: input.title,
          status: 'SUCCESS',
          model: input.model,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          error: null,
          articleId: article.id,
          finishedAt: now,
        },
      });

      await this.quota.applyArticleEvent(input.tenantId, 'AI_TASK', 'create', tx);

      await tx.keyword.updateMany({
        where: {
          id: input.keywordId,
          tenantId: input.tenantId,
          optStatus: 'NONE',
        },
        data: { optStatus: 'OPTIMIZING' },
      });

      await tx.aiTask.update({
        where: { id: input.taskId },
        data: {
          doneCount: { increment: 1 },
          lastWrittenAt: now,
        },
      });

      return 'saved';
    }, TX_OPTIONS);
  }

  private async resolveUnitSplit(
    unitPrice: number,
    hasKb: boolean,
  ): Promise<{ aiWritePoints: number; kbAddonPoints: number; withKnowledgeBase: boolean }> {
    if (!hasKb) {
      return { aiWritePoints: unitPrice, kbAddonPoints: 0, withKnowledgeBase: false };
    }
    const prices = await this.billing.listPrices();
    const baseCfg = prices.find((p) => p.action === 'ai_write')?.unitPoints ?? 10;
    if (unitPrice <= baseCfg) {
      return { aiWritePoints: unitPrice, kbAddonPoints: 0, withKnowledgeBase: false };
    }
    return {
      aiWritePoints: baseCfg,
      kbAddonPoints: unitPrice - baseCfg,
      withKnowledgeBase: true,
    };
  }

  private async handleItemFailure(input: {
    tenantId: string;
    taskId: string;
    taskName: string;
    unitPrice: number;
    reservationId: string | null;
    itemId: string;
    error: unknown;
  }): Promise<void> {
    const errMsg = safeErrorText(input.error);

    if (input.reservationId) {
      await this.billing
        .releaseUnit({
          tenantId: input.tenantId,
          reservationId: input.reservationId,
          unitKey: `ai_task_item:${input.itemId}`,
          amount: input.unitPrice,
          title: `退还预扣-${input.taskName}`,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `releaseUnit on ${input.itemId} skipped: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
    }

    await this.prisma.base.$transaction(async (tx) => {
      const taskRows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status
        FROM "AiTask"
        WHERE id = ${input.taskId} AND "tenantId" = ${input.tenantId}
        FOR UPDATE
      `;
      const taskStatus = taskRows[0]?.status;
      if (!taskStatus) return;

      const current = await tx.aiTaskItem.findUnique({
        where: { id: input.itemId },
        select: { status: true },
      });
      if (!current || current.status === 'SUCCESS' || current.status === 'SKIPPED') {
        return;
      }

      if (current.status !== 'FAILED') {
        await tx.aiTaskItem.update({
          where: { id: input.itemId },
          data: {
            status: 'FAILED',
            error: errMsg,
            finishedAt: new Date(),
          },
        });
        await tx.aiTask.update({
          where: { id: input.taskId },
          data:
            taskStatus === 'PAUSED'
              ? { failCount: { increment: 1 } }
              : { failCount: { increment: 1 }, lastError: errMsg },
        });
      }

      const [recentFinished, pendingLeft] = await Promise.all([
        tx.aiTaskItem.findMany({
          where: {
            taskId: input.taskId,
            status: { in: ['SUCCESS', 'FAILED'] },
          },
          orderBy: [{ finishedAt: 'desc' }, { seq: 'desc' }],
          take: AI_TASK_MAX_CONSECUTIVE_FAILS,
          select: { status: true },
        }),
        tx.aiTaskItem.count({
          where: { taskId: input.taskId, status: 'PENDING' },
        }),
      ]);

      if (
        pendingLeft > 0 &&
        recentFinished.length === AI_TASK_MAX_CONSECUTIVE_FAILS &&
        recentFinished.every((row) => row.status === 'FAILED') &&
        (taskStatus === 'QUEUED' || taskStatus === 'RUNNING')
      ) {
        await tx.aiTask.update({
          where: { id: input.taskId },
          data: {
            status: 'PAUSED',
            lastError: `模型服务异常：连续失败 ${AI_TASK_MAX_CONSECUTIVE_FAILS} 篇，任务已自动暂停（${errMsg}）`,
          },
        });
      }
    }, TX_OPTIONS);
  }

  async finalizeIfComplete(tenantId: string, taskId: string): Promise<void> {
    const summary = await this.prisma.base.$transaction(async (tx) => {
      const taskRows = await tx.$queryRaw<
        Array<{ id: string; status: string; target: number; doneCount: number; failCount: number }>
      >`
        SELECT id, status::text AS status, target, "doneCount", "failCount"
        FROM "AiTask"
        WHERE id = ${taskId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const task = taskRows[0];
      if (!task) return null;

      if (task.status === 'PAUSED') return null;

      const [pending, running, success, failed] = await Promise.all([
        tx.aiTaskItem.count({ where: { taskId, status: 'PENDING' } }),
        tx.aiTaskItem.count({ where: { taskId, status: 'RUNNING' } }),
        tx.aiTaskItem.count({ where: { taskId, status: 'SUCCESS' } }),
        tx.aiTaskItem.count({ where: { taskId, status: 'FAILED' } }),
      ]);

      if (task.status !== 'CANCELLED' && (pending > 0 || running > 0)) {
        return null;
      }

      let nextStatus = task.status;
      if (task.status !== 'CANCELLED') {
        if (success >= task.target) {
          nextStatus = 'COMPLETED';
        } else if (success > 0) {
          nextStatus = 'PARTIAL';
        } else {
          nextStatus = 'FAILED';
        }
      }

      await tx.aiTask.update({
        where: { id: taskId },
        data: {
          status: nextStatus as 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED',
          doneCount: success,
          failCount: failed,
        },
      });

      return { closeReservation: running === 0 };
    }, TX_OPTIONS);

    if (!summary?.closeReservation) return;

    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: {
        tenantId,
        refType: 'ai_task',
        refId: taskId,
      },
    });
    if (reservation && reservation.status === 'OPEN') {
      await this.billing.close({ tenantId, reservationId: reservation.id });
    }
  }
}
