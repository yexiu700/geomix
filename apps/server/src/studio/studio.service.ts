import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  defaultTargetFormatForMarket,
  evaluateGeoArticle,
  markdownToSanitizedHtml,
  sanitizeRichArticleHtml,
  targetFormatsForMarket,
  type GeoArticleListQuery,
  type GeoArticleListResponse,
  type GeoArticleRecord,
  type GeoArticleStreamInput,
  type GeoArticleUpdateInput,
  type GeoBatchCreateInput,
  type GeoBatchJobListResponse,
  type GeoBatchJobRecord,
  type GeoBatchListQuery,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoRewriteSectionInput,
  type GeoRewriteSectionResponse,
  type GeoTargetFormat,
  type PromptPreferenceInput,
  type PromptPreferenceRecord,
} from '@geomix/shared';
import type { RetrievedBrandFactSnippet } from '../brands/brand-fact-index.runner';
import { BrandsService } from '../brands/brands.service';
import { BillingService, type ReservationView } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readRewriteSectionRateLimit,
} from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { GEO_BATCH_ENQUEUER, type GeoBatchEnqueuer } from './geo-batch.runner';
import {
  StudioGenerationService,
  type StudioBrandContext,
  type StudioMarketContext,
} from './studio-generation.service';
import {
  deriveGeoArticleId,
  deriveGeoBatchJobId,
  extractCompetitorNames,
  normalizeComplianceFlags,
  normalizeOutlineJson,
  presentGeoArticle,
  presentGeoBatchJob,
  presentPromptPreference,
} from './studio.mapper';

export type StudioAuthContext = {
  tenantId: string;
  userId: string;
};

export type SseRequestLike = {
  on(event: 'aborted', listener: () => void): void;
  off?(event: 'aborted', listener: () => void): void;
  removeListener?(event: 'aborted', listener: () => void): void;
};

export type SseResponseLike = {
  writableEnded?: boolean;
  headersSent?: boolean;
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
  off?(event: 'close', listener: () => void): void;
  removeListener?(event: 'close', listener: () => void): void;
};

export type PreparedStudioStream =
  | {
      kind: 'replay';
      article: GeoArticleRecord;
      unitPrice: number;
      billingMode: 'SHADOW' | 'STRICT';
      market: GeoMarket;
      recipe: GeoRecipe;
      targetFormat: GeoTargetFormat;
      matchedFactIds: string[];
    }
  | {
      kind: 'generate';
      tenantId: string;
      articleId: string;
      brand: StudioBrandContext;
      market: StudioMarketContext;
      briefId: string | null;
      markedBriefWriting: boolean;
      recipe: GeoRecipe;
      targetFormat: GeoTargetFormat;
      targetPrompt: string;
      title?: string;
      outlineH2: GeoOutlineHeading[];
      targetFanOuts: string[];
      factSnippets: RetrievedBrandFactSnippet[];
      matchedFactIds: string[];
      customToneNote: string | null;
      customForbiddenWords: string[];
      recipeOverride: string | null;
      sourceCitationUrl?: string;
      pastedReferenceText?: string;
      wordCountTarget?: number;
      unitPrice: number;
      reservation: ReservationView;
    };

@Injectable()
export class StudioService {
  private readonly logger = new Logger(StudioService.name);
  private readonly inFlightStreams = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(FreeActionRateLimiter) private readonly rateLimiter: FreeActionRateLimiter,
    @Inject(StudioGenerationService) private readonly generation: StudioGenerationService,
    @Optional()
    @Inject(GEO_BATCH_ENQUEUER)
    private readonly batchEnqueuer?: GeoBatchEnqueuer,
  ) {}

  async listArticles(brandId: string, query: GeoArticleListQuery): Promise<GeoArticleListResponse> {
    const resolved = await this.brands.resolveBrandMarket(brandId, query.market);
    const where: Prisma.GeoArticleWhereInput = {
      brandId: resolved.brand.id,
      brandMarketId: resolved.market.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.briefId ? { briefId: query.briefId } : {}),
      ...(query.batchJobId ? { batchJobId: query.batchJobId } : {}),
      ...(query.keyword
        ? {
            OR: [
              { title: { contains: query.keyword, mode: 'insensitive' } },
              { targetPrompt: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.scoped.geoArticle.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: query.pageSize,
      }),
      this.prisma.scoped.geoArticle.count({ where }),
    ]);

    return {
      items: rows.map((row) => presentGeoArticle(row, resolved.market.market)),
      total,
    };
  }

  async getArticle(articleId: string): Promise<GeoArticleRecord> {
    const row = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: { brandMarket: { select: { market: true } } },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }
    return presentGeoArticle(row);
  }

  async updateArticle(
    articleId: string,
    input: GeoArticleUpdateInput,
    auth: StudioAuthContext,
  ): Promise<GeoArticleRecord> {
    const existing = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brand: { select: { id: true, name: true, category: true } },
        brandMarket: {
          select: {
            id: true,
            market: true,
            locale: true,
            localBrandName: true,
            ownedDomains: true,
          },
        },
        brief: { select: { targetFanOuts: true, matchedFactIds: true } },
      },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    const market = existing.brandMarket.market as GeoMarket;
    const pref = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId: auth.tenantId },
    });
    const customForbiddenWords = pref?.customForbiddenWords ?? [];

    const checkParts = [input.title ?? '', input.contentMarkdown ?? ''].filter((s) => s.length > 0);
    if (checkParts.length > 0) {
      await this.compliance.assertAllowed({
        text: checkParts.join('\n'),
        action: 'geo_article_update',
        market,
        customForbiddenWords,
        tenantId: auth.tenantId,
        userId: auth.userId,
      });
    }

    const data: Prisma.GeoArticleUpdateInput = {};
    let nextTitle = existing.title;
    let nextMarkdown = existing.contentMarkdown;
    let nextFlags = normalizeComplianceFlags(existing.complianceFlags);

    if (input.title !== undefined) {
      const titleScan = this.compliance.scan(input.title, { market, customForbiddenWords });
      nextTitle = titleScan.text.trim() || input.title.trim();
      data.title = nextTitle;
    }

    if (input.outlineJson !== undefined) {
      data.outlineJson = input.outlineJson as unknown as Prisma.InputJsonValue;
    }
    if (input.tags !== undefined) {
      data.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
    }
    if (input.status !== undefined) {
      data.status = input.status;
    }

    let shouldRecomputeEval = false;
    if (input.contentMarkdown !== undefined) {
      const bodyScan = this.compliance.scan(input.contentMarkdown, {
        market,
        customForbiddenWords,
      });
      nextMarkdown = bodyScan.text;
      nextFlags = bodyScan.geoFlags;
      data.contentMarkdown = nextMarkdown;
      data.contentHtml = markdownToSanitizedHtml(nextMarkdown);
      data.complianceFlags = nextFlags as unknown as Prisma.InputJsonValue;
      shouldRecomputeEval = true;
    } else if (input.contentHtml !== undefined) {
      const sanitized = sanitizeRichArticleHtml(input.contentHtml);
      data.contentHtml = sanitized.contentHtml;
    }

    if (input.title !== undefined) {
      shouldRecomputeEval = true;
    }

    if (shouldRecomputeEval) {
      const brandFacts = await this.prisma.scoped.brandFact.findMany({
        where: { brandId: existing.brandId },
        select: { id: true, content: true },
      });
      const evaluation = evaluateGeoArticle({
        market,
        locale: existing.brandMarket.locale,
        localBrandName: existing.brandMarket.localBrandName,
        category: existing.brand.category,
        ownedDomains: existing.brandMarket.ownedDomains,
        title: nextTitle,
        targetPrompt: existing.targetPrompt,
        contentMarkdown: nextMarkdown,
        targetFanOuts: existing.brief?.targetFanOuts ?? [],
        matchedFactIds: existing.brief?.matchedFactIds.length
          ? existing.brief.matchedFactIds
          : brandFacts.map((f) => f.id),
        brandFactTexts: brandFacts.map((f) => f.content),
        complianceFlags: nextFlags,
      });
      data.geoScore = evaluation.geoScore;
      data.geoScoreDetail = evaluation.geoScoreDetail as unknown as Prisma.InputJsonValue;
      data.schemaJsonLd = evaluation.schemaJsonLd as unknown as Prisma.InputJsonValue;
      data.llmsTxtSnippet = evaluation.llmsTxtSnippet;
    }

    const updated = await this.prisma.scoped.geoArticle.update({
      where: { id: existing.id },
      data,
      include: { brandMarket: { select: { market: true } } },
    });

    const newlyEmbeddedMediaIds =
      input.contentMarkdown !== undefined
        ? diffNewlyEmbeddedBrandMediaIds(existing.contentMarkdown, nextMarkdown, existing.brandId)
        : [];
    const mediaIdsToIncrement = [
      ...new Set([...(input.usedMediaIds ?? []), ...newlyEmbeddedMediaIds]),
    ];

    if (mediaIdsToIncrement.length > 0) {
      await this.prisma.scoped.brandMediaAsset.updateMany({
        where: {
          brandId: existing.brandId,
          id: { in: mediaIdsToIncrement },
        },
        data: { usedCount: { increment: 1 } },
      });
    }

    return presentGeoArticle(updated);
  }

  async deleteArticle(articleId: string): Promise<{ deleted: boolean; id: string }> {
    const existing = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }
    await this.prisma.scoped.geoArticle.delete({ where: { id: existing.id } });
    return { deleted: true, id: existing.id };
  }

  /**
   * Phase 1（在写入任何 SSE 响应头之前完成所有校验、合规拦截、幂等探测与积分预扣）。
   * 任何异常都将经 ApiExceptionFilter 以标准 HTTP JSON 返回。
   */
  async prepareStreamArticle(
    brandId: string,
    input: GeoArticleStreamInput,
    idempotencyKey: string,
    auth: StudioAuthContext,
  ): Promise<PreparedStudioStream> {
    const resolved = await this.brands.resolveBrandMarket(brandId, input.market);
    const market = resolved.market.market;
    const targetFormat: GeoTargetFormat =
      input.targetFormat ?? defaultTargetFormatForMarket(market);
    if (!targetFormatsForMarket(market).includes(targetFormat)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标阵地形态与所选市场不匹配');
    }

    let brief: {
      id: string;
      status: string;
      suggestedTitle: string;
      outlineH2: Prisma.JsonValue;
      targetFanOuts: string[];
      sourceCitationUrl: string | null;
    } | null = null;
    if (input.briefId) {
      brief = await this.prisma.scoped.geoBrief.findFirst({
        where: {
          id: input.briefId,
          brandId: resolved.brand.id,
          brandMarketId: resolved.market.id,
        },
        select: {
          id: true,
          status: true,
          suggestedTitle: true,
          outlineH2: true,
          targetFanOuts: true,
          sourceCitationUrl: true,
        },
      });
      if (!brief) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作意见不存在或不属于当前品牌市场');
      }
    }

    const pref = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId: auth.tenantId },
    });
    const customForbiddenWords = pref?.customForbiddenWords ?? [];
    const effectiveToneNote = input.customToneNote ?? pref?.customToneNote ?? null;

    const outlineH2: GeoOutlineHeading[] =
      input.outlineH2 && input.outlineH2.length > 0
        ? input.outlineH2.map((h) => ({
            heading: h.heading,
            intent: h.intent ?? '',
            ...(h.fanOutRef ? { fanOutRef: h.fanOutRef } : {}),
          }))
        : normalizeOutlineJson(brief?.outlineH2);
    const targetFanOuts =
      input.targetFanOuts && input.targetFanOuts.length > 0
        ? input.targetFanOuts
        : (brief?.targetFanOuts ?? []);

    // Prohibited content pre-check BEFORE reserving points (403/40302)
    await this.compliance.assertAllowed({
      text: [
        input.targetPrompt,
        input.title ?? '',
        effectiveToneNote ?? '',
        input.pastedReferenceText ?? '',
        ...outlineH2.map((h) => h.heading),
      ].join('\n'),
      action: 'geo_write_stream',
      market,
      customForbiddenWords,
      tenantId: auth.tenantId,
      userId: auth.userId,
    });

    const articleId = deriveGeoArticleId(auth.tenantId, idempotencyKey);
    const inFlightKey = `${auth.tenantId}::${articleId}`;
    if (this.inFlightStreams.has(inFlightKey)) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '同幂等键写作流正在执行中，请勿重复提交');
    }

    const unitPrice = await this.billing.unitPrice('geo_write');

    // Idempotency replay check: if article already exists for this key, replay with 0 charge!
    const existing = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: { brandMarket: { select: { market: true } } },
    });
    if (existing) {
      if (
        existing.brandId !== resolved.brand.id ||
        existing.brandMarketId !== resolved.market.id ||
        existing.recipe !== input.recipe ||
        existing.targetFormat !== targetFormat ||
        existing.targetPrompt !== input.targetPrompt
      ) {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '相同 Idempotency-Key 不能用于不同的写作参数',
        );
      }
      const replayBillingMode = await this.resolveReplayBillingMode(articleId);
      const presented = presentGeoArticle(existing);
      return {
        kind: 'replay',
        article: presented,
        unitPrice,
        billingMode: replayBillingMode,
        market,
        recipe: presented.recipe,
        targetFormat: presented.targetFormat,
        matchedFactIds: [],
      };
    }

    // Acquire concurrency lock before async fact retrieval & billing.reserve
    if (this.inFlightStreams.has(inFlightKey)) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '同幂等键写作流正在执行中，请勿重复提交');
    }
    this.inFlightStreams.add(inFlightKey);

    try {
      const queryText = [input.targetPrompt, ...targetFanOuts].join(' ');
      const factSnippets = await this.generation.retrieveFacts(
        auth.tenantId,
        resolved.brand.id,
        queryText,
      );
      const matchedFactIds = [...new Set(factSnippets.map((f) => f.factId))];

      const reservation = await this.billing.reserve({
        tenantId: auth.tenantId,
        refType: 'geo_article',
        refId: articleId,
        amount: unitPrice,
      });
      if (reservation.status === 'CLOSED') {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '该幂等键对应的写作任务已结束，请更换新的 Idempotency-Key 重试',
        );
      }

      let markedBriefWriting = false;
      if (brief && brief.status === 'OPEN') {
        const updated = await this.prisma.scoped.geoBrief.updateMany({
          where: { id: brief.id, status: 'OPEN' },
          data: { status: 'WRITING' },
        });
        markedBriefWriting = updated.count > 0;
      }

      const recipeOverrides =
        pref?.recipeOverrides &&
        typeof pref.recipeOverrides === 'object' &&
        !Array.isArray(pref.recipeOverrides)
          ? (pref.recipeOverrides as Record<string, unknown>)
          : null;
      const overrideRaw = recipeOverrides?.[input.recipe];

      return {
        kind: 'generate',
        tenantId: auth.tenantId,
        articleId,
        brand: {
          id: resolved.brand.id,
          name: resolved.brand.name,
          category: resolved.brand.category,
        },
        market: {
          id: resolved.market.id,
          market,
          locale: resolved.market.locale,
          region: resolved.market.region,
          localBrandName: resolved.market.localBrandName,
          aliases: resolved.market.aliases,
          ownedDomains: resolved.market.ownedDomains,
          competitors: resolved.market.competitors.map((c) => c.name),
        },
        briefId: brief?.id ?? null,
        markedBriefWriting,
        recipe: input.recipe,
        targetFormat,
        targetPrompt: input.targetPrompt,
        title: input.title ?? brief?.suggestedTitle,
        outlineH2,
        targetFanOuts,
        factSnippets,
        matchedFactIds,
        customToneNote: effectiveToneNote,
        customForbiddenWords,
        recipeOverride: typeof overrideRaw === 'string' ? overrideRaw : null,
        sourceCitationUrl: input.sourceCitationUrl ?? brief?.sourceCitationUrl ?? undefined,
        pastedReferenceText: input.pastedReferenceText,
        wordCountTarget: input.wordCountTarget,
        unitPrice,
        reservation,
      };
    } catch (err) {
      this.inFlightStreams.delete(inFlightKey);
      throw err;
    }
  }

  private async resolveReplayBillingMode(articleId: string): Promise<'SHADOW' | 'STRICT'> {
    try {
      const resRow = await this.prisma.scoped.pointReservation?.findFirst?.({
        where: { refType: 'geo_article', refId: articleId },
        select: { shadow: true },
      });
      if (resRow && typeof resRow.shadow === 'boolean') {
        return resRow.shadow ? 'SHADOW' : 'STRICT';
      }
    } catch {
      // Fallback below
    }
    return process.env.BILLING_MODE?.trim().toUpperCase() === 'STRICT' ? 'STRICT' : 'SHADOW';
  }

  /**
   * Phase 2（SSE 流式推送与单一原子 settle-or-refund 状态机）。
   * 写入 SSE 响应头后永不向外抛异常。
   */
  async executeStreamArticle(
    prepared: PreparedStudioStream,
    res: SseResponseLike,
    req: SseRequestLike,
  ): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    if (prepared.kind === 'replay') {
      writeSseEvent(res, 'meta', {
        reservationId: `replay_${prepared.article.id}`,
        unitPrice: prepared.unitPrice,
        billingMode: prepared.billingMode,
        market: prepared.market,
        recipe: prepared.recipe,
        targetFormat: prepared.targetFormat,
        matchedFactIds: prepared.matchedFactIds,
      });
      writeSseEvent(res, 'delta', { text: prepared.article.contentMarkdown });
      writeSseEvent(res, 'complete', {
        article: prepared.article,
        geoScore: prepared.article.geoScore,
        geoScoreDetail: prepared.article.geoScoreDetail,
        schemaJsonLd: prepared.article.schemaJsonLd,
        llmsTxtSnippet: prepared.article.llmsTxtSnippet,
      });
      if (!res.writableEnded) res.end();
      return;
    }

    const abortController = new AbortController();
    let clientDisconnected = false;
    const onResClose = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        abortController.abort(new Error('client_disconnected'));
      }
    };
    const onReqAborted = () => {
      clientDisconnected = true;
      abortController.abort(new Error('client_aborted'));
    };
    res.on('close', onResClose);
    req.on('aborted', onReqAborted);

    let settlementState: 'PENDING' | 'SETTLED' | 'REFUNDED' = 'PENDING';
    const refundOnce = async (reasonTitle: string): Promise<boolean> => {
      if (settlementState !== 'PENDING') return settlementState === 'REFUNDED';
      settlementState = 'REFUNDED';
      try {
        await this.billing.releaseUnit({
          tenantId: prepared.tenantId,
          reservationId: prepared.reservation.id,
          unitKey: `geo_article:${prepared.articleId}`,
          amount: prepared.unitPrice,
          title: reasonTitle,
        });
      } catch {
        // close() below releases any remaining frozen points idempotently
      }
      await this.billing
        .close({ tenantId: prepared.tenantId, reservationId: prepared.reservation.id })
        .catch(() => undefined);
      if (prepared.markedBriefWriting && prepared.briefId) {
        await this.prisma.scoped.geoBrief
          .updateMany({
            where: { id: prepared.briefId, status: 'WRITING' },
            data: { status: 'OPEN' },
          })
          .catch(() => undefined);
      }
      return true;
    };

    try {
      writeSseEvent(res, 'meta', {
        reservationId: prepared.reservation.id,
        unitPrice: prepared.unitPrice,
        billingMode: prepared.reservation.shadow ? 'SHADOW' : 'STRICT',
        market: prepared.market.market,
        recipe: prepared.recipe,
        targetFormat: prepared.targetFormat,
        matchedFactIds: prepared.matchedFactIds,
      });

      const generated = await this.generation.streamArticle({
        tenantId: prepared.tenantId,
        articleId: prepared.articleId,
        brand: prepared.brand,
        market: prepared.market,
        recipe: prepared.recipe,
        targetFormat: prepared.targetFormat,
        targetPrompt: prepared.targetPrompt,
        title: prepared.title,
        outlineH2: prepared.outlineH2,
        targetFanOuts: prepared.targetFanOuts,
        factSnippets: prepared.factSnippets,
        matchedFactIds: prepared.matchedFactIds,
        customToneNote: prepared.customToneNote,
        customForbiddenWords: prepared.customForbiddenWords,
        recipeOverride: prepared.recipeOverride,
        sourceCitationUrl: prepared.sourceCitationUrl,
        pastedReferenceText: prepared.pastedReferenceText,
        wordCountTarget: prepared.wordCountTarget,
        reservationShadow: prepared.reservation.shadow,
        signal: abortController.signal,
        onDelta: (text) => {
          if (clientDisconnected || abortController.signal.aborted || res.writableEnded) return;
          writeSseEvent(res, 'delta', { text });
        },
      });

      if (clientDisconnected || abortController.signal.aborted) {
        throw new ProviderError(PROVIDER_KIND.CANCELLED, '客户端已中断生成', 'client_abort');
      }

      const created = await this.prisma.scoped.geoArticle.create({
        data: {
          id: prepared.articleId,
          tenantId: prepared.tenantId,
          brandId: prepared.brand.id,
          brandMarketId: prepared.market.id,
          briefId: prepared.briefId,
          recipe: prepared.recipe,
          targetFormat: prepared.targetFormat,
          title: generated.title,
          targetPrompt: prepared.targetPrompt,
          outlineJson: prepared.outlineH2 as unknown as Prisma.InputJsonValue,
          contentMarkdown: generated.contentMarkdown,
          contentHtml: generated.contentHtml,
          schemaJsonLd: generated.evaluation.schemaJsonLd as unknown as Prisma.InputJsonValue,
          llmsTxtSnippet: generated.evaluation.llmsTxtSnippet,
          geoScore: generated.evaluation.geoScore,
          geoScoreDetail: generated.evaluation.geoScoreDetail as unknown as Prisma.InputJsonValue,
          tags: [],
          status: 'DRAFT',
          model: generated.model,
          tokensIn: generated.tokensIn,
          tokensOut: generated.tokensOut,
          complianceFlags: generated.complianceFlags as unknown as Prisma.InputJsonValue,
        },
        include: { brandMarket: { select: { market: true } } },
      });

      try {
        await this.billing.settleGeoWriteUnit({
          tenantId: prepared.tenantId,
          reservationId: prepared.reservation.id,
          unitKey: `geo_article:${prepared.articleId}`,
          subject: created.title,
          geoWritePoints: prepared.unitPrice,
        });
        await this.billing.close({
          tenantId: prepared.tenantId,
          reservationId: prepared.reservation.id,
        });
        settlementState = 'SETTLED';
      } catch (settleErr) {
        // Delete orphaned article so a refunded stream never leaves a persisted article
        await this.prisma.scoped.geoArticle
          .deleteMany({ where: { id: created.id } })
          .catch(() => undefined);
        throw settleErr;
      }

      if (prepared.briefId) {
        await this.prisma.scoped.geoBrief
          .updateMany({
            where: { id: prepared.briefId },
            data: { status: 'DONE' },
          })
          .catch(() => undefined);
      }

      await this.quota
        .applyArticleEvent(prepared.tenantId, 'GEO_STREAM', 'create')
        .catch(() => undefined);

      const presented = presentGeoArticle(created, prepared.market.market);
      if (!clientDisconnected && !res.writableEnded) {
        writeSseEvent(res, 'complete', {
          article: presented,
          geoScore: presented.geoScore,
          geoScoreDetail: presented.geoScoreDetail,
          schemaJsonLd: presented.schemaJsonLd,
          llmsTxtSnippet: presented.llmsTxtSnippet,
        });
      }
    } catch (err) {
      const refunded = await refundOnce(
        clientDisconnected ? '取消流式写作退还预扣' : '写作生成失败退还预扣',
      );
      if (!clientDisconnected && !res.writableEnded) {
        const mapped = mapStreamError(err);
        writeSseEvent(res, 'error', {
          code: mapped.code,
          msg: mapped.msg,
          refunded,
        });
      }
    } finally {
      try {
        if (settlementState === 'PENDING') {
          await refundOnce('异常中断退还预扣');
        }
        detachListener(res, 'close', onResClose);
        detachListener(req, 'aborted', onReqAborted);
        if (!res.writableEnded) {
          res.end();
        }
      } finally {
        this.inFlightStreams.delete(`${prepared.tenantId}::${prepared.articleId}`);
      }
    }
  }

  async rewriteSection(
    articleId: string,
    input: GeoRewriteSectionInput,
    auth: StudioAuthContext,
  ): Promise<GeoRewriteSectionResponse> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brand: { select: { id: true, name: true, category: true } },
        brandMarket: {
          select: {
            id: true,
            market: true,
            locale: true,
            region: true,
            localBrandName: true,
            aliases: true,
            ownedDomains: true,
            competitors: true,
          },
        },
      },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    const market = article.brandMarket.market as GeoMarket;
    const pref = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId: auth.tenantId },
    });
    const customForbiddenWords = pref?.customForbiddenWords ?? [];

    await this.compliance.assertAllowed({
      text: `${input.selectedText}\n${input.instruction ?? ''}`,
      action: 'geo_rewrite_section',
      market,
      customForbiddenWords,
      tenantId: auth.tenantId,
      userId: auth.userId,
    });

    this.rateLimiter.assertAllowed('rewrite_section', auth.tenantId, readRewriteSectionRateLimit());

    try {
      const result = await this.generation.rewriteSection({
        tenantId: auth.tenantId,
        articleId: article.id,
        brand: article.brand,
        market: {
          id: article.brandMarket.id,
          market,
          locale: article.brandMarket.locale,
          region: article.brandMarket.region,
          localBrandName: article.brandMarket.localBrandName,
          aliases: article.brandMarket.aliases,
          ownedDomains: article.brandMarket.ownedDomains,
          competitors: extractCompetitorNames(article.brandMarket.competitors),
        },
        action: input.action,
        selectedText: input.selectedText,
        instruction: input.instruction,
        surroundingContext: input.surroundingContext,
        customToneNote: pref?.customToneNote ?? null,
        customForbiddenWords,
      });

      return {
        rewrittenText: result.rewrittenText,
        action: input.action,
        complianceFlags: result.complianceFlags,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof ProviderError) {
        throw new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, err.message);
      }
      throw err;
    }
  }

  async createBatchJob(
    brandId: string,
    input: GeoBatchCreateInput,
    idempotencyKey: string,
    auth: StudioAuthContext,
  ): Promise<GeoBatchJobRecord> {
    const resolved = await this.brands.resolveBrandMarket(brandId, input.market);
    const market = resolved.market.market;
    if (input.targetFormat && !targetFormatsForMarket(market).includes(input.targetFormat)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标阵地形态与所选市场不匹配');
    }

    const batchJobId = deriveGeoBatchJobId(auth.tenantId, idempotencyKey);
    const existing = await this.prisma.scoped.geoBatchJob.findFirst({
      where: { id: batchJobId },
      include: { brandMarket: { select: { market: true } } },
    });
    if (existing) {
      const sameBriefs =
        existing.brandId === resolved.brand.id &&
        existing.brandMarketId === resolved.market.id &&
        existing.briefIds.length === input.briefIds.length &&
        existing.briefIds.every((id, idx) => id === input.briefIds[idx]);
      if (!sameBriefs) {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '相同 Idempotency-Key 不能用于不同的批量写作参数',
        );
      }
      return presentGeoBatchJob(existing, market);
    }

    const briefs = await this.prisma.scoped.geoBrief.findMany({
      where: {
        id: { in: input.briefIds },
        brandId: resolved.brand.id,
        brandMarketId: resolved.market.id,
      },
      select: {
        id: true,
        status: true,
        targetPrompt: true,
        suggestedTitle: true,
      },
    });
    if (briefs.length !== input.briefIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '部分写作意见不存在或不属于当前品牌市场');
    }
    if (briefs.some((b) => b.status === 'DISMISSED')) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '已忽略的写作意见不能加入批量队列');
    }

    const pref = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId: auth.tenantId },
    });
    await this.compliance.assertAllowed({
      text: briefs.map((b) => `${b.targetPrompt}\n${b.suggestedTitle}`).join('\n'),
      action: 'geo_batch_create',
      market,
      customForbiddenWords: pref?.customForbiddenWords,
      tenantId: auth.tenantId,
      userId: auth.userId,
    });

    const unitPrice = await this.billing.unitPrice('geo_write');
    const totalAmount = unitPrice * input.briefIds.length;
    const reservation = await this.billing.reserve({
      tenantId: auth.tenantId,
      refType: 'geo_batch',
      refId: batchJobId,
      amount: totalAmount,
    });

    const replayedByReservation = await this.prisma.scoped.geoBatchJob.findFirst({
      where: { reservationId: reservation.id },
      include: { brandMarket: { select: { market: true } } },
    });
    if (replayedByReservation) {
      return presentGeoBatchJob(replayedByReservation, market);
    }
    if (reservation.status === 'CLOSED') {
      throw new ApiError(
        409,
        BILLING_ERROR.CONFLICT,
        '该幂等键对应的批量任务已结束，请更换新的 Idempotency-Key 重试',
      );
    }

    let createdRow: Prisma.GeoBatchJobGetPayload<object> | null = null;
    try {
      createdRow = await this.prisma.base.$transaction(async (tx) => {
        const job = await tx.geoBatchJob.create({
          data: {
            id: batchJobId,
            tenantId: auth.tenantId,
            brandId: resolved.brand.id,
            brandMarketId: resolved.market.id,
            briefIds: [...input.briefIds],
            total: input.briefIds.length,
            doneCount: 0,
            failCount: 0,
            unitPrice,
            reservationId: reservation.id,
            status: 'QUEUED',
          },
        });
        await tx.geoBrief.updateMany({
          where: {
            tenantId: auth.tenantId,
            id: { in: input.briefIds },
            status: 'OPEN',
          },
          data: { status: 'WRITING' },
        });
        return job;
      });

      if (this.batchEnqueuer) {
        await this.batchEnqueuer.enqueueGeoBatch({
          tenantId: auth.tenantId,
          jobId: createdRow.id,
          recipe: input.recipe,
          targetFormat: input.targetFormat,
        });
      }
      return presentGeoBatchJob(createdRow, market);
    } catch (err) {
      this.logger.warn(
        `createBatchJob failed after reserve job=${batchJobId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      if (createdRow) {
        await this.prisma.scoped.geoBatchJob
          .deleteMany({ where: { id: createdRow.id } })
          .catch(() => undefined);
        await this.prisma.scoped.geoBrief
          .updateMany({
            where: { id: { in: input.briefIds }, status: 'WRITING' },
            data: { status: 'OPEN' },
          })
          .catch(() => undefined);
      }
      await this.billing
        .close({ tenantId: auth.tenantId, reservationId: reservation.id })
        .catch(() => undefined);
      throw err;
    }
  }

  async listBatchJobs(brandId: string, query: GeoBatchListQuery): Promise<GeoBatchJobListResponse> {
    const resolved = await this.brands.resolveBrandMarket(brandId, query.market);
    const where: Prisma.GeoBatchJobWhereInput = {
      brandId: resolved.brand.id,
      brandMarketId: resolved.market.id,
    };
    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.scoped.geoBatchJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: query.pageSize,
      }),
      this.prisma.scoped.geoBatchJob.count({ where }),
    ]);

    return {
      items: rows.map((row) => presentGeoBatchJob(row, resolved.market.market)),
      total,
    };
  }

  async getBatchJob(
    brandId: string,
    jobId: string,
    market?: GeoMarket,
  ): Promise<GeoBatchJobRecord> {
    const brand = await this.brands.getById(brandId);
    const row = await this.prisma.scoped.geoBatchJob.findFirst({
      where: {
        id: jobId,
        brandId: brand.id,
        ...(market
          ? {
              brandMarket: { market },
            }
          : {}),
      },
      include: { brandMarket: { select: { market: true } } },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '批量写作任务不存在');
    }
    return presentGeoBatchJob(row);
  }

  async getPromptPreferences(tenantId: string): Promise<PromptPreferenceRecord> {
    const row = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId },
    });
    return presentPromptPreference(row);
  }

  async upsertPromptPreferences(
    tenantId: string,
    input: PromptPreferenceInput,
    auth: StudioAuthContext,
  ): Promise<PromptPreferenceRecord> {
    const toneNote =
      input.customToneNote === undefined
        ? undefined
        : input.customToneNote && input.customToneNote.trim().length > 0
          ? input.customToneNote.trim()
          : null;
    const forbiddenWords =
      input.customForbiddenWords === undefined
        ? undefined
        : [...new Set(input.customForbiddenWords.map((w) => w.trim()).filter(Boolean))];
    const recipeOverrides =
      input.recipeOverrides === undefined
        ? undefined
        : input.recipeOverrides && Object.keys(input.recipeOverrides).length > 0
          ? input.recipeOverrides
          : null;

    const textToCheck = [toneNote ?? '', ...Object.values(recipeOverrides ?? {})]
      .filter(Boolean)
      .join('\n');
    if (textToCheck) {
      await this.compliance.assertAllowed({
        text: textToCheck,
        action: 'prompt_preference_update',
        tenantId,
        userId: auth.userId,
      });
    }

    const existing = await this.prisma.scoped.promptPreference.findFirst({
      where: { tenantId },
    });

    const row = existing
      ? await this.prisma.scoped.promptPreference.update({
          where: { tenantId },
          data: {
            ...(toneNote !== undefined ? { customToneNote: toneNote } : {}),
            ...(forbiddenWords !== undefined ? { customForbiddenWords: forbiddenWords } : {}),
            ...(recipeOverrides !== undefined
              ? {
                  recipeOverrides:
                    recipeOverrides === null
                      ? Prisma.DbNull
                      : (recipeOverrides as unknown as Prisma.InputJsonValue),
                }
              : {}),
          },
        })
      : await this.prisma.scoped.promptPreference.create({
          data: {
            tenantId,
            customToneNote: toneNote ?? null,
            customForbiddenWords: forbiddenWords ?? [],
            recipeOverrides:
              recipeOverrides && Object.keys(recipeOverrides).length > 0
                ? (recipeOverrides as unknown as Prisma.InputJsonValue)
                : recipeOverrides === null
                  ? Prisma.DbNull
                  : undefined,
          },
        });

    return presentPromptPreference(row);
  }
}

function writeSseEvent(res: SseResponseLike, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mapStreamError(err: unknown): { code: number; msg: string } {
  if (err instanceof ApiError) {
    return { code: err.code, msg: err.message };
  }
  if (err instanceof ProviderError) {
    return {
      code: API_ERROR.UPSTREAM_UNAVAILABLE,
      msg: err.message || '上游模型服务暂不可用，已自动退还本次冻结点数',
    };
  }
  return {
    code: 50000,
    msg: '写作生成失败，已自动退还本次冻结点数',
  };
}

function detachListener(
  emitter: {
    off?: (event: never, listener: () => void) => void;
    removeListener?: (event: never, listener: () => void) => void;
  },
  event: string,
  listener: () => void,
): void {
  if (typeof emitter.off === 'function') {
    (emitter.off as (e: string, l: () => void) => void)(event, listener);
  } else if (typeof emitter.removeListener === 'function') {
    (emitter.removeListener as (e: string, l: () => void) => void)(event, listener);
  }
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBrandMediaIdsFromMarkdown(markdown: string, brandId: string): string[] {
  if (!markdown || !brandId) return [];
  const escapedBrandId = escapeRegExp(brandId);
  const encodedBrandId = escapeRegExp(encodeURIComponent(brandId));
  const brandSegment =
    encodedBrandId === escapedBrandId ? escapedBrandId : `(?:${escapedBrandId}|${encodedBrandId})`;
  const pattern = new RegExp(
    `/api/v2/brands/${brandSegment}/media/([A-Za-z0-9_-]{1,64})/(?:file|thumb)(?=[?)"'\\s]|$)`,
    'g',
  );
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

function diffNewlyEmbeddedBrandMediaIds(
  previousMarkdown: string,
  nextMarkdown: string,
  brandId: string,
): string[] {
  const nextIds = extractBrandMediaIdsFromMarkdown(nextMarkdown, brandId);
  if (nextIds.length === 0) return [];
  const prevSet = new Set(extractBrandMediaIdsFromMarkdown(previousMarkdown, brandId));
  return nextIds.filter((id) => !prevSet.has(id));
}
