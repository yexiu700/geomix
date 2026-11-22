import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  VISIBILITY_ENGINE_LABELS,
  buildSingleDocxBytes,
  evaluateGeoArticle,
  htmlToExportDocument,
  htmlToExportMarkdown,
  isEngineAllowedForMarket,
  stripHtmlToText,
  type ActionHomeQueryInput,
  type ActionHomeResponse,
  type ArticleArchiveFormat,
  type ExportableArticleDoc,
  type GeoArticleStatus,
  type GeoEvaluateArticleBodyInput,
  type GeoEvaluationResult,
  type GeoMarket,
  type GeoPublishRecordDto,
  type GeoRecipe,
  type GeoTargetFormat,
  type PublishRecordCreateInput,
  type PublishRecordRetestInput,
  type VisibilityEngineKey,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readGeoEvaluateRateLimit,
} from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { VisibilityService } from '../visibility/visibility.service';
import { computeRetestMetricSnapshot } from './retest-metrics-hook.service';
import {
  normalizeComplianceFlags,
  normalizeRecommendedChannels,
  presentPublishRecord,
} from './studio.mapper';
import type { StudioAuthContext } from './studio.service';

export type ExportedArticlePayload = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  contentDisposition: string;
};

const E2E_SENTINEL_RE = /\[E2E_[A-Z0-9_]+\]/gi;

function normalizePromptForBaseline(raw: string): string {
  return raw.replace(E2E_SENTINEL_RE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildSafeExportFilename(
  title: string,
  id: string,
  ext: ArticleArchiveFormat,
): {
  filename: string;
  contentDisposition: string;
} {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const stem = cleaned || `geo-article-${id.slice(-6)}`;
  const filename = `${stem}.${ext}`;
  const asciiFallback =
    stem
      .replace(/[^\x20-\x7e]+/g, '')
      .replace(/["\\]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || `geo-article-${id.slice(-6)}`;
  const contentDisposition = `attachment; filename="${asciiFallback}.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  return { filename, contentDisposition };
}

/**
 * GeoMix 2.0 M5 交付与闭环服务（Issue #333 / F16–F17）：
 * 100% 使用 prisma.scoped 实现严格租户隔离：
 * - 实时免费 GEO 0–100 体检与 JSON-LD / llms.txt 刷新
 * - MD / HTML / OOXML .docx（含 <w:tbl>）导出
 * - 发布 URL 登记（基线指标快照 + PUBLISHED 状态流转）
 * - 一键定向复测（RETEST VisibilityRun + 幂等）
 * - 行动首页（/home）单品牌单市场三块聚合
 */
@Injectable()
export class GeoDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Inject(VisibilityService) private readonly visibility: VisibilityService,
    @Optional()
    @Inject(FreeActionRateLimiter)
    private readonly rateLimiter?: FreeActionRateLimiter,
  ) {}

  async evaluateGeo(
    articleId: string,
    input: GeoEvaluateArticleBodyInput,
    auth: StudioAuthContext,
  ): Promise<GeoEvaluationResult> {
    this.rateLimiter?.assertAllowed('geo_evaluate', auth.tenantId, readGeoEvaluateRateLimit());

    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brand: {
          include: {
            facts: {
              select: { id: true, title: true, content: true },
            },
          },
        },
        brandMarket: true,
        brief: {
          select: {
            id: true,
            targetFanOuts: true,
            matchedFactIds: true,
            recommendedChannels: true,
          },
        },
      },
    });

    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    const market: GeoMarket = article.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const hasInlineOverride =
      input.title !== undefined ||
      input.contentMarkdown !== undefined ||
      input.targetFanOuts !== undefined;

    const evalTitle = input.title?.trim() || article.title;
    const evalMarkdown = input.contentMarkdown ?? article.contentMarkdown;
    const evalFanOuts = input.targetFanOuts ?? article.brief?.targetFanOuts ?? [];
    const matchedFactIds = article.brief?.matchedFactIds?.length
      ? article.brief.matchedFactIds
      : article.brand.facts.map((f) => f.id);
    const brandFactTexts = article.brand.facts.map((f) => `${f.title} ${f.content}`);

    const evaluation = evaluateGeoArticle({
      market,
      locale: article.brandMarket.locale,
      localBrandName: article.brandMarket.localBrandName,
      category: article.brand.category,
      localCategory: article.brandMarket.localCategory,
      ownedDomains: article.brandMarket.ownedDomains,
      title: evalTitle,
      targetPrompt: article.targetPrompt,
      contentMarkdown: evalMarkdown,
      targetFanOuts: evalFanOuts,
      matchedFactIds,
      brandFactTexts,
      complianceFlags: normalizeComplianceFlags(article.complianceFlags),
    });

    const briefChannels = normalizeRecommendedChannels(article.brief?.recommendedChannels);
    const result: GeoEvaluationResult = {
      ...evaluation,
      recommendedChannels:
        briefChannels.length > 0 ? briefChannels : evaluation.recommendedChannels,
    };

    if (!hasInlineOverride) {
      await this.prisma.scoped.geoArticle.update({
        where: { id: article.id },
        data: {
          geoScore: result.geoScore,
          geoScoreDetail: result.geoScoreDetail as unknown as Prisma.InputJsonValue,
          schemaJsonLd: result.schemaJsonLd as unknown as Prisma.InputJsonValue,
          llmsTxtSnippet: result.llmsTxtSnippet,
        },
      });
    }

    return result;
  }

  async exportArticle(
    articleId: string,
    format: ArticleArchiveFormat,
  ): Promise<ExportedArticlePayload> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brandMarket: {
          select: { locale: true, market: true },
        },
      },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    const doc: ExportableArticleDoc = {
      id: article.id,
      title: article.title,
      categoryName: article.tags[0] ?? null,
      contentHtml: article.contentHtml,
      contentText: stripHtmlToText(article.contentHtml || article.contentMarkdown),
      contentMarkdown: article.contentMarkdown,
      locale:
        article.brandMarket?.locale ||
        (article.brandMarket?.market === 'GLOBAL' ? 'en-US' : 'zh-CN'),
      createdAt: article.createdAt.toISOString(),
    };

    const { filename, contentDisposition } = buildSafeExportFilename(
      article.title,
      article.id,
      format,
    );

    if (format === 'md') {
      const md = htmlToExportMarkdown(doc);
      return {
        buffer: Buffer.from(md, 'utf8'),
        contentType: 'text/markdown; charset=utf-8',
        filename,
        contentDisposition,
      };
    }

    if (format === 'html') {
      const html = htmlToExportDocument(doc);
      return {
        buffer: Buffer.from(html, 'utf8'),
        contentType: 'text/html; charset=utf-8',
        filename,
        contentDisposition,
      };
    }

    const docxBytes = buildSingleDocxBytes(doc);
    return {
      buffer: Buffer.from(docxBytes),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename,
      contentDisposition,
    };
  }

  async listPublishRecords(articleId: string): Promise<{ items: GeoPublishRecordDto[] }> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      select: { id: true },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    const rows = await this.prisma.scoped.geoPublishRecord.findMany({
      where: { articleId: article.id },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map(presentPublishRecord) };
  }

  async createPublishRecord(
    articleId: string,
    input: PublishRecordCreateInput,
    auth: StudioAuthContext,
  ): Promise<GeoPublishRecordDto> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brandMarket: true,
      },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在');
    }

    // Prefer latest completed/partial MANUAL run as baseline; fall back to any completed/partial run
    let baselineRun = await this.prisma.scoped.visibilityRun.findFirst({
      where: {
        brandId: article.brandId,
        brandMarketId: article.brandMarketId,
        triggerType: 'MANUAL',
        status: { in: ['COMPLETED', 'PARTIAL'] },
      },
      include: {
        observations: {
          where: { status: 'SUCCESS' },
          include: {
            citations: {
              orderBy: { position: 'asc' },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (!baselineRun) {
      baselineRun = await this.prisma.scoped.visibilityRun.findFirst({
        where: {
          brandId: article.brandId,
          brandMarketId: article.brandMarketId,
          status: { in: ['COMPLETED', 'PARTIAL'] },
        },
        include: {
          observations: {
            where: { status: 'SUCCESS' },
            include: {
              citations: {
                orderBy: { position: 'asc' },
              },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
      });
    }

    let beforeMetrics: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (baselineRun && baselineRun.observations.length > 0) {
      const targetNorm = normalizePromptForBaseline(article.targetPrompt);
      const matchedObs = baselineRun.observations.filter(
        (obs) => normalizePromptForBaseline(obs.promptText) === targetNorm,
      );
      const subset = matchedObs.length > 0 ? matchedObs : baselineRun.observations;
      const snapshot = computeRetestMetricSnapshot(subset, article.brandMarket, input.publishedUrl);
      if (snapshot) {
        beforeMetrics = snapshot as unknown as Prisma.InputJsonValue;
      }
    }

    const publishedAt = input.publishedAt ? new Date(input.publishedAt) : new Date();
    const created = await this.prisma.scoped.geoPublishRecord.create({
      data: {
        tenantId: auth.tenantId,
        brandId: article.brandId,
        brandMarketId: article.brandMarketId,
        articleId: article.id,
        publishedUrl: input.publishedUrl,
        channel: input.channel,
        publishedAt,
        baselineRunId: baselineRun?.id ?? null,
        latestRetestRunId: null,
        beforeMetrics,
        afterMetrics: Prisma.DbNull,
      },
    });

    if (article.status !== 'PUBLISHED') {
      await this.prisma.scoped.geoArticle.update({
        where: { id: article.id },
        data: { status: 'PUBLISHED' },
      });
    }

    return presentPublishRecord(created);
  }

  async retestPublishRecord(
    recordId: string,
    input: PublishRecordRetestInput,
    idempotencyKey: string,
    auth: StudioAuthContext,
  ): Promise<VisibilityRunDetailRecord> {
    const record = await this.prisma.scoped.geoPublishRecord.findFirst({
      where: { id: recordId },
      include: {
        article: {
          select: {
            id: true,
            title: true,
            targetPrompt: true,
          },
        },
        brandMarket: true,
      },
    });

    if (!record) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '发布记录不存在');
    }

    const market: GeoMarket = record.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    let engines: VisibilityEngineKey[];

    if (input.engines && input.engines.length > 0) {
      for (const engine of input.engines) {
        if (!isEngineAllowedForMarket(engine, market)) {
          const label = VISIBILITY_ENGINE_LABELS[engine] ?? engine;
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            `AI 引擎「${label}」不属于当前市场（${market}）`,
          );
        }
      }
      engines = [...input.engines];
    } else {
      const availability = await this.visibility.listEngines(record.brandId, market);
      engines = availability.engines.filter((item) => item.available).map((item) => item.key);
      if (engines.length === 0) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '当前市场暂无可用的在线监测引擎');
      }
    }

    const promptCandidate = record.article.targetPrompt.trim();
    const prompt =
      promptCandidate.length >= 2
        ? promptCandidate.slice(0, 300)
        : record.article.title.trim().slice(0, 300) || record.brandMarket.localBrandName;

    const run = await this.visibility.createRun(
      record.brandId,
      {
        market,
        name: `复测：${record.article.title.slice(0, 40)}`,
        engines,
        prompts: [prompt],
        triggerType: 'RETEST',
        retestArticleId: record.articleId,
      },
      `retest:${idempotencyKey}`,
      auth.userId,
      market,
    );

    // SQL NULL-safe guard: never overwrite afterMetrics if worker already completed this run
    // or if this request is an Idempotency-Key replay for an already-linked run.
    await this.prisma.scoped.geoPublishRecord.updateMany({
      where: {
        id: record.id,
        OR: [{ latestRetestRunId: null }, { latestRetestRunId: { not: run.id } }],
      },
      data: {
        latestRetestRunId: run.id,
        afterMetrics: Prisma.DbNull,
      },
    });

    return run;
  }

  async getActionHome(brandId: string, query: ActionHomeQueryInput): Promise<ActionHomeResponse> {
    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    const days = query.days ?? 14;

    let health: ActionHomeResponse['health'] = {
      days,
      mentionRatePct: 0,
      shareOfVoicePct: 0,
      avgPosition: null,
      ownedCitationRatePct: 0,
      completedChecks: 0,
    };

    try {
      const overview = await this.visibility.overview(brand.id, {
        market: market.market,
        days,
      });
      health = {
        days,
        mentionRatePct: overview.metrics.visibilityPct,
        shareOfVoicePct: overview.metrics.shareOfVoice.brandSharePct,
        avgPosition: overview.metrics.avgPosition,
        ownedCitationRatePct: overview.metrics.ownedCitationRatePct,
        completedChecks: overview.metrics.completedChecks,
      };
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        throw err;
      }
    }

    const [topBriefRows, recentArticleRows] = await Promise.all([
      this.prisma.scoped.geoBrief.findMany({
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          status: 'OPEN',
        },
        orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
      this.prisma.scoped.geoArticle.findMany({
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
        },
        include: {
          publishRecords: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
    ]);

    return {
      brandId: brand.id,
      brandMarketId: market.id,
      market: market.market,
      health,
      topBriefs: topBriefRows.map((row) => ({
        id: row.id,
        sourceType: row.sourceType,
        priorityScore: row.priorityScore,
        diagnosisSummary: row.diagnosisSummary,
        suggestedTitle: row.suggestedTitle,
        targetPrompt: row.targetPrompt,
        recommendedRecipe: row.recommendedRecipe as GeoRecipe,
        targetFormat: row.targetFormat as GeoTargetFormat,
        recommendedChannels: normalizeRecommendedChannels(row.recommendedChannels),
      })),
      recentArticles: recentArticleRows.map((row) => ({
        id: row.id,
        title: row.title,
        recipe: row.recipe as GeoRecipe,
        geoScore: row.geoScore,
        status: row.status as GeoArticleStatus,
        updatedAt: row.updatedAt.toISOString(),
        publishRecord: row.publishRecords[0] ? presentPublishRecord(row.publishRecords[0]) : null,
      })),
    };
  }
}
