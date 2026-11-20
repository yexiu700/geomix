import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  FAKE_MARK,
  PRICING_DEFAULTS,
  REWRITE_DEFAULT_UNIT_POINTS,
  REWRITE_DUPLICATE_WINDOW_HOURS,
  REWRITE_MIN_SOURCE_CHARS,
  REWRITE_SHORT_SOURCE_MSG,
  assembleRewriteMessages,
  buildDefaultRewriteCategoryName,
  buildFakeRewriteMarkdown,
  canonicalizeRewriteUrl,
  computeChar5GramJaccard,
  computeRewriteUrlHash,
  escapeLikeLiteral,
  extractArticleFromHtml,
  injectGalleryImages,
  normalizePastedSource,
  parseRewrittenMarkdown,
  resolveRewriteSimMax,
  sha256Hex,
  type ArticleStatusName,
  type ItemStatusName,
  type RewriteBulkStatusInput,
  type RewriteComplianceFlags,
  type RewriteRecordItem,
  type RewriteRecordListQuery,
  type RewriteRecordListResponse,
  type RewriteSingleCreateInput,
  type RewriteSingleCreateResponse,
  type RewriteUrlCheckResponse,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, isUniqueViolation } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { ensureBuiltInSystemTemplates } from '../writing/system-templates.helper';

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

type LoadedRewriteRow = Prisma.RewriteRecordGetPayload<{
  include: {
    category: { select: { id: true; name: true } };
    mediaCategory: { select: { id: true; name: true } };
    template: { select: { id: true; name: true } };
    article: { select: { id: true; status: true; complianceFlags: true } };
  };
}>;

const REWRITE_INCLUDE = {
  category: { select: { id: true, name: true } },
  mediaCategory: { select: { id: true, name: true } },
  template: { select: { id: true, name: true } },
  article: { select: { id: true, status: true, complianceFlags: true } },
} as const;

function readHighSimilarityFlag(
  rawFlags: Prisma.JsonValue | null | undefined,
  similarity: number | null,
  simMax: number,
): boolean {
  if (rawFlags && typeof rawFlags === 'object' && !Array.isArray(rawFlags)) {
    const flag = (rawFlags as Record<string, unknown>).highSimilarity;
    if (typeof flag === 'boolean') return flag;
  }
  if (typeof similarity === 'number' && similarity > simMax) {
    return true;
  }
  return false;
}

function presentRecord(row: LoadedRewriteRow, simMax: number): RewriteRecordItem {
  return {
    id: row.id,
    batchId: row.batchId,
    url: row.url,
    urlHash: row.urlHash,
    pastedText: row.pastedText,
    sourceTitle: row.sourceTitle,
    newTitle: row.newTitle,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    mediaCategoryId: row.mediaCategoryId,
    mediaCategoryName: row.mediaCategory?.name ?? null,
    templateId: row.templateId,
    templateName: row.template?.name ?? null,
    status: row.status as ItemStatusName,
    error: row.error,
    similarity: row.similarity,
    highSimilarity: readHighSimilarityFlag(row.article?.complianceFlags, row.similarity, simMax),
    articleId: row.article?.id ?? row.articleId,
    articleStatus: (row.article?.status as ArticleStatusName | undefined) ?? null,
    rewrittenAt: row.rewrittenAt ? row.rewrittenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapExecutionError(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof ProviderError) {
    if (err.kind === PROVIDER_KIND.SSRF) {
      return new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '目标地址不允许访问（仅支持公开 http/https 页面，内网与私有地址已拦截，本次未扣点数）',
      );
    }
    if (err.kind === PROVIDER_KIND.NOT_PUBLIC || err.kind === PROVIDER_KIND.ROBOTS) {
      return new ApiError(
        422,
        API_ERROR.UPSTREAM_UNAVAILABLE,
        '目标页面需登录验证或不允许直接抓取，请开启「粘贴原文」手工补充正文（本次未扣点数）',
      );
    }
    if (err.kind === PROVIDER_KIND.CONTRACT) {
      return new ApiError(
        422,
        API_ERROR.BAD_REQUEST,
        '目标链接返回的不是公开 HTML 文章页面（本次未扣点数）',
      );
    }
    return new ApiError(
      422,
      API_ERROR.UPSTREAM_UNAVAILABLE,
      '外部页面或改写服务暂时不可用，请稍后重试或开启「粘贴原文」（本次未扣点数）',
    );
  }
  const msg =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim().slice(0, 180)
      : '单篇爆文复刻失败（本次未扣点数）';
  return new ApiError(422, API_ERROR.UPSTREAM_UNAVAILABLE, msg);
}

@Injectable()
export class RewritesService {
  private readonly logger = new Logger(RewritesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(PublicFetchService) private readonly publicFetch: PublicFetchService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  private buildWhere(
    tenantId: string,
    query: RewriteRecordListQuery,
  ): Prisma.RewriteRecordWhereInput {
    const where: Prisma.RewriteRecordWhereInput = {
      tenantId,
      batchId: null,
    };
    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.articleStatus) {
      where.article = { status: query.articleStatus };
    }
    if (query.keyword) {
      const escaped = escapeLikeLiteral(query.keyword);
      where.OR = [
        { newTitle: { contains: escaped, mode: 'insensitive' } },
        { sourceTitle: { contains: escaped, mode: 'insensitive' } },
        { url: { contains: escaped, mode: 'insensitive' } },
        { category: { name: { contains: escaped, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  private async resolveUnitPoints(): Promise<number> {
    const item = await this.prisma.base.pricingItem.findUnique({
      where: { action: 'rewrite_single' },
    });
    if (!item) {
      const fallback = PRICING_DEFAULTS.find((p) => p.action === 'rewrite_single');
      return fallback?.unitPoints ?? REWRITE_DEFAULT_UNIT_POINTS;
    }
    if (!item.enabled) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '单篇复刻计费项当前未启用');
    }
    return item.unitPoints;
  }

  async list(query: RewriteRecordListQuery): Promise<RewriteRecordListResponse> {
    const tenantId = requireTenant();
    const simMax = resolveRewriteSimMax(process.env);
    const where = this.buildWhere(tenantId, query);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows, unitPoints] = await Promise.all([
      this.prisma.base.rewriteRecord.count({ where }),
      this.prisma.base.rewriteRecord.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
        include: REWRITE_INCLUDE,
      }),
      this.resolveUnitPoints().catch(() => REWRITE_DEFAULT_UNIT_POINTS),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      unitPoints,
      items: rows.map((row) => presentRecord(row, simMax)),
    };
  }

  async collectForExport(query: RewriteRecordListQuery): Promise<RewriteRecordItem[]> {
    const tenantId = requireTenant();
    const simMax = resolveRewriteSimMax(process.env);
    const where = this.buildWhere(tenantId, query);
    const rows = await this.prisma.base.rewriteRecord.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CRUD_EXPORT_LIMIT,
      include: REWRITE_INCLUDE,
    });
    return rows.map((row) => presentRecord(row, simMax));
  }

  async detail(id: string): Promise<RewriteRecordItem> {
    const tenantId = requireTenant();
    const simMax = resolveRewriteSimMax(process.env);
    const row = await this.prisma.base.rewriteRecord.findFirst({
      where: { id, tenantId },
      include: REWRITE_INCLUDE,
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '复刻记录不存在');
    }
    return presentRecord(row, simMax);
  }

  async checkDuplicateUrl(rawUrl: string): Promise<RewriteUrlCheckResponse> {
    const tenantId = requireTenant();
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeRewriteUrl(rawUrl);
    } catch {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请输入有效的 http/https 链接');
    }
    if (!canonicalUrl || canonicalUrl.startsWith('paste://')) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请输入有效的 http/https 链接');
    }
    const urlHash = computeRewriteUrlHash(canonicalUrl);
    const windowStart = new Date(Date.now() - REWRITE_DUPLICATE_WINDOW_HOURS * 3600_000);
    const recent = await this.prisma.base.rewriteRecord.findFirst({
      where: {
        tenantId,
        urlHash,
        status: 'SUCCESS',
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    return {
      canonicalUrl,
      urlHash,
      duplicateRecent: Boolean(recent),
      recentRecordId: recent?.id ?? null,
      recentCreatedAt: recent ? recent.createdAt.toISOString() : null,
      warning: recent
        ? `该链接在 ${REWRITE_DUPLICATE_WINDOW_HOURS} 小时内已成功复刻过，继续提交可能产生重复主题稿件`
        : null,
    };
  }

  async createSingle(
    input: RewriteSingleCreateInput,
    userId?: string,
  ): Promise<RewriteSingleCreateResponse> {
    const tenantId = requireTenant();
    await ensureBuiltInSystemTemplates(this.prisma);

    // 1. Validate optional mediaCategory + available gallery images (required when imageCount > 0)
    let mediaCat: { id: string; name: string } | null = null;
    if (input.mediaCategoryId) {
      mediaCat = await this.prisma.base.mediaCategory.findFirst({
        where: { id: input.mediaCategoryId, tenantId },
        select: { id: true, name: true },
      });
      if (!mediaCat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选配图分类不存在');
      }
      if (input.imageCount > 0) {
        const assetCount = await this.prisma.base.mediaAsset.count({
          where: { tenantId, categoryId: mediaCat.id },
        });
        if (assetCount < 1) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            '所选配图分类下暂无可用图片，请先前往企业画像图库上传图片或将配图张数设为 0',
          );
        }
      }
    } else if (input.imageCount > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '请选择文章配图的企业画像图库分类（不配图时请将配图张数设为 0）',
      );
    }

    // 2. Validate REWRITE prompt template
    const template = await this.prisma.base.promptTemplate.findFirst({
      where: {
        id: input.templateId,
        OR: [{ tenantId }, { tenantId: null }],
      },
      select: { id: true, name: true, kind: true, content: true },
    });
    if (!template) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选改写指令不存在');
    }
    if (template.kind !== 'REWRITE') {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '爆文改写指令仅允许选择「流量复刻」类型的模板',
      );
    }

    // 3. Validate optional target ArticleCategory or autoCategoryName
    if (input.categoryId) {
      const existingCat = await this.prisma.base.articleCategory.findFirst({
        where: { id: input.categoryId, tenantId },
        select: { id: true },
      });
      if (!existingCat) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所选文章分类不存在');
      }
    }
    const autoCategoryName = input.autoCategoryName?.trim() || buildDefaultRewriteCategoryName();
    if (!input.categoryId) {
      await this.compliance.assertAllowed({
        text: autoCategoryName,
        action: 'rewrite_category',
        tenantId,
        userId,
      });
    }

    // 4. Compliance pre-check on brand and pasted inputs
    const brand = input.brand?.trim() ?? '';
    if (brand) {
      await this.compliance.assertAllowed({
        text: brand,
        action: 'rewrite_brand',
        tenantId,
        userId,
      });
    }
    if (input.pastedText) {
      await this.compliance.assertAllowed({
        text: `${input.pastedTitle ?? ''}\n${input.pastedContent}`,
        action: 'rewrite_pasted_source',
        tenantId,
        userId,
      });
    }

    // 5. Canonicalize URL & check 24h duplicate
    let canonicalUrl: string;
    try {
      if (input.pastedText && !input.url?.trim()) {
        canonicalUrl = `paste://${sha256Hex(input.pastedContent).slice(0, 24)}`;
      } else {
        canonicalUrl = canonicalizeRewriteUrl(input.url);
      }
    } catch {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请输入有效的 http/https 公开文章链接');
    }
    const urlHash = computeRewriteUrlHash(canonicalUrl);

    const windowStart = new Date(Date.now() - REWRITE_DUPLICATE_WINDOW_HOURS * 3600_000);
    const recentDup = await this.prisma.base.rewriteRecord.findFirst({
      where: {
        tenantId,
        urlHash,
        status: 'SUCCESS',
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const duplicateRecentWarning = recentDup
      ? `该链接在 ${REWRITE_DUPLICATE_WINDOW_HOURS} 小时内已成功复刻过，请注意避免重复发稿`
      : null;

    // 6. Reserve points (5 pts default) and create RUNNING RewriteRecord
    const unitPoints = await this.resolveUnitPoints();
    const record = await this.prisma.base.rewriteRecord.create({
      data: {
        tenantId,
        batchId: null,
        url: canonicalUrl,
        urlHash,
        pastedText: input.pastedText,
        sourceTitle: input.pastedText && input.pastedTitle ? input.pastedTitle.trim() : null,
        categoryId: input.categoryId,
        mediaCategoryId: mediaCat?.id ?? null,
        templateId: template.id,
        status: 'RUNNING',
      },
    });

    const unitKey = `rewrite_single:${record.id}`;
    let reservationId: string;
    try {
      const reservation = await this.billing.reserveSync({
        tenantId,
        refType: 'rewrite_single',
        unitKey,
        amount: unitPoints,
      });
      reservationId = reservation.id;
    } catch (reserveErr) {
      await this.prisma.base.rewriteRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined);
      throw reserveErr;
    }

    const simMax = resolveRewriteSimMax(process.env);

    const syncStartedAt = Date.now();
    try {
      // 7. Fetch or normalize source text
      const extracted = input.pastedText
        ? normalizePastedSource({
            pastedTitle: input.pastedTitle,
            pastedContent: input.pastedContent,
          })
        : await (async () => {
            const page = await this.publicFetch.fetch(canonicalUrl);
            return extractArticleFromHtml(page.body, page.url || canonicalUrl);
          })();

      if (extracted.charCount < REWRITE_MIN_SOURCE_CHARS) {
        throw new ApiError(
          422,
          API_ERROR.BAD_REQUEST,
          `${REWRITE_SHORT_SOURCE_MSG}（当前有效正文仅 ${extracted.charCount} 字）`,
        );
      }

      // Compliance check on extracted source text
      await this.compliance.assertAllowed({
        text: `${extracted.title}\n${extracted.contentText}`,
        action: 'rewrite_fetched_source',
        tenantId,
        userId,
      });

      // 8. Rewrite via LLM + 5-gram Jaccard check (1 retry if > simMax and within HTTP budget)
      const runPass = async (retryHighSimilarity: boolean, passIdx: number) => {
        const messages = assembleRewriteMessages({
          templateContent: template.content,
          sourceTitle: extracted.title,
          sourceText: extracted.contentText,
          brand: brand || undefined,
          retryHighSimilarity,
        });
        const completion = await this.llm.complete({
          tenantId,
          scene: 'rewrite',
          messages,
          idempotencyKey: `${unitKey}:p${passIdx}`,
          temperature: retryHighSimilarity ? 0.85 : 0.75,
          maxTokens: 2400,
          timeoutMs: retryHighSimilarity ? 25_000 : 45_000,
          maxRetries: 0,
          preferFastModel: true,
          disableThinking: true,
        });
        if (completion.fake && !this.llm.usesFakePrimary('rewrite')) {
          throw new ApiError(
            503,
            API_ERROR.UPSTREAM_UNAVAILABLE,
            '大模型复刻服务响应超时或暂时不可用，未扣除点数，请稍后重试',
          );
        }
        const rawMd =
          completion.fake && completion.text.startsWith(FAKE_MARK)
            ? buildFakeRewriteMarkdown({
                sourceTitle: extracted.title,
                sourceText: extracted.contentText,
                brand: brand || undefined,
                variant: passIdx,
              })
            : completion.text;

        const parsed = parseRewrittenMarkdown(rawMd, {
          sourceTitle: extracted.title,
          brand: brand || undefined,
        });

        // Hard compliance check + soft extreme-word cleanup on generated rewrite
        const titleCompliance = await this.compliance.assertAllowed({
          text: parsed.newTitle,
          action: 'rewrite_output_title',
          tenantId,
          userId,
        });
        await this.compliance.assertAllowed({
          text: parsed.contentText,
          action: 'rewrite_output_body',
          tenantId,
          userId,
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
      if (best.similarity > simMax && Date.now() - syncStartedAt < 12_000) {
        retriedSimilarity = true;
        try {
          const second = await runPass(true, 1);
          if (second.similarity <= best.similarity) {
            best = second;
          }
        } catch {
          // Keep first pass result if optional similarity-reduction retry times out or fails
        }
      }

      const highSimilarity = best.similarity > simMax;
      const complianceFlags: RewriteComplianceFlags & { extremeFlags?: string[] } = {
        similarity: best.similarity,
        ...(highSimilarity ? { highSimilarity: true } : {}),
        ...(retriedSimilarity ? { retriedSimilarity: true } : {}),
        ...(duplicateRecentWarning ? { duplicateRecentUrl: true } : {}),
        ...(best.softFlags.length > 0
          ? { extremeFlags: Array.from(new Set(best.softFlags.map((f) => f.label))) }
          : {}),
      };

      // 9. Inject 1..3 gallery images & persist Article + RewriteRecord in DB transaction
      // IMPORTANT: Do NOT consume AI_WRITE quota (Issue #19: 复刻成功不计入「AI写作数量」)
      const persistedId = await this.prisma.base.$transaction(async (tx) => {
        let targetCategoryId = input.categoryId;
        if (!targetCategoryId) {
          const existingByName = await tx.articleCategory.findFirst({
            where: { tenantId, name: autoCategoryName },
            select: { id: true },
          });
          if (existingByName) {
            targetCategoryId = existingByName.id;
          } else {
            try {
              const createdCat = await tx.articleCategory.create({
                data: { tenantId, name: autoCategoryName },
                select: { id: true },
              });
              targetCategoryId = createdCat.id;
            } catch (catErr) {
              if (!isUniqueViolation(catErr)) throw catErr;
              const raced = await tx.articleCategory.findFirstOrThrow({
                where: { tenantId, name: autoCategoryName },
                select: { id: true },
              });
              targetCategoryId = raced.id;
            }
          }
        }

        let finalContentHtml = best.contentHtml;
        let coverUrl: string | null = null;
        if (mediaCat && input.imageCount > 0) {
          const fetchLimit = Math.max(1, input.imageCount);
          const assets = await tx.$queryRaw<Array<{ id: string; url: string }>>`
            SELECT id, url
            FROM "MediaAsset"
            WHERE "tenantId" = ${tenantId} AND "categoryId" = ${mediaCat.id}
            ORDER BY "usedCount" ASC, "createdAt" ASC
            LIMIT ${fetchLimit}
            FOR UPDATE
          `;

          const injected = injectGalleryImages({
            contentHtml: best.contentHtml,
            assets,
            title: best.newTitle,
            imageCount: input.imageCount,
            coverWhenNoImage: true,
          });

          finalContentHtml = injected.contentHtml;
          coverUrl = injected.coverUrl;

          if (injected.usedAssetIds.length > 0) {
            await tx.mediaAsset.updateMany({
              where: { id: { in: injected.usedAssetIds }, tenantId },
              data: { usedCount: { increment: 1 } },
            });
          }
        }

        const article = await tx.article.create({
          data: {
            tenantId,
            categoryId: targetCategoryId,
            title: best.newTitle,
            contentHtml: finalContentHtml,
            contentText: best.contentText,
            coverUrl,
            status: input.resultStatus,
            source: 'REWRITE_SINGLE',
            sourceUrl: canonicalUrl.startsWith('paste://') ? null : canonicalUrl,
            complianceFlags: complianceFlags as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        await tx.rewriteRecord.update({
          where: { id: record.id },
          data: {
            sourceTitle: extracted.title,
            newTitle: best.newTitle,
            categoryId: targetCategoryId,
            status: 'SUCCESS',
            error: null,
            similarity: best.similarity,
            articleId: article.id,
            rewrittenAt: new Date(),
          },
        });

        return record.id;
      }, TX_OPTIONS);

      // 10. Settle reserved 5 points
      await this.billing.settle({
        tenantId,
        reservationId,
        unitKey,
        action: 'rewrite_single',
        amount: unitPoints,
        title: `单篇复刻-${best.newTitle.slice(0, 24)}`,
        detail: {
          recordId: record.id,
          url: canonicalUrl,
          pastedText: input.pastedText,
          similarity: best.similarity,
        },
      });
      await this.billing.close({ tenantId, reservationId });

      const savedRow = await this.prisma.base.rewriteRecord.findFirstOrThrow({
        where: { id: persistedId, tenantId },
        include: REWRITE_INCLUDE,
      });

      return {
        record: presentRecord(savedRow, simMax),
        duplicateRecentWarning,
        settledPoints: unitPoints,
      };
    } catch (execErr) {
      const apiErr = mapExecutionError(execErr);
      await this.refundAndMarkFailed({
        tenantId,
        recordId: record.id,
        reservationId,
        unitKey,
        unitPoints,
        errorMessage: apiErr.message,
      });
      throw apiErr;
    }
  }

  private async refundAndMarkFailed(input: {
    tenantId: string;
    recordId: string;
    reservationId: string;
    unitKey: string;
    unitPoints: number;
    errorMessage: string;
  }): Promise<void> {
    try {
      await this.billing.releaseUnit({
        tenantId: input.tenantId,
        reservationId: input.reservationId,
        unitKey: input.unitKey,
        amount: input.unitPoints,
        title: '单篇复刻失败退回',
      });
      await this.billing.close({
        tenantId: input.tenantId,
        reservationId: input.reservationId,
      });
    } catch (refundErr) {
      this.logger.error(
        `refund rewrite reservation ${input.reservationId} failed: ${
          refundErr instanceof Error ? refundErr.message : 'unknown'
        }`,
      );
    }

    await this.prisma.base.rewriteRecord
      .update({
        where: { id: input.recordId },
        data: {
          status: 'FAILED',
          error: input.errorMessage.slice(0, 240),
        },
      })
      .catch(() => undefined);
  }

  async bulkUpdateArticleStatus(input: RewriteBulkStatusInput): Promise<{ affected: number }> {
    const tenantId = requireTenant();
    const uniqueIds = Array.from(new Set(input.ids));
    const records = await this.prisma.base.rewriteRecord.findMany({
      where: {
        tenantId,
        batchId: null,
        id: { in: uniqueIds },
        articleId: { not: null },
      },
      select: { articleId: true },
    });
    const articleIds = Array.from(
      new Set(records.map((r) => r.articleId).filter((id): id is string => Boolean(id))),
    );
    if (articleIds.length === 0) {
      return { affected: 0 };
    }
    const updated = await this.prisma.base.article.updateMany({
      where: { tenantId, id: { in: articleIds } },
      data: { status: input.status },
    });
    return { affected: updated.count };
  }

  async bulkDelete(ids: readonly string[]): Promise<{ affected: number }> {
    const tenantId = requireTenant();
    const uniqueIds = Array.from(new Set(ids));
    const deleted = await this.prisma.base.rewriteRecord.deleteMany({
      where: {
        tenantId,
        batchId: null,
        id: { in: uniqueIds },
      },
    });
    return { affected: deleted.count };
  }
}
