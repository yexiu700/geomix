import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  VISIBILITY_ENGINE_LABELS,
  buildSingleDocxBytes,
  computeWilsonInterval,
  evaluateGeoArticle,
  htmlToExportDocument,
  htmlToExportMarkdown,
  isEngineAllowedForMarket,
  stripHtmlToText,
  type ActionHomeQueryInput,
  type ActionHomeResponse,
  type ArticleArchiveFormat,
  type CrawlProbeStatus,
  type DistributionChannelAttributionItem,
  type DistributionCrawlAlertItem,
  type DistributionSummaryDto,
  type DistributionUpcomingRetestItem,
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
  type RetestSampleCount,
  type RetestScheduleStatus,
  type VisibilityEngineKey,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readGeoEvaluateRateLimit,
} from '../common/free-action-rate-limiter';
import {
  RetestSchedulerService,
  ensureRetestSchedulesForPublishRecord,
} from '../distribution/retest-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { VisibilityService } from '../visibility/visibility.service';
import { computeRetestMetricSnapshot } from './retest-metrics-hook.service';
import {
  normalizeComplianceFlags,
  normalizeCrawlProbeReport,
  normalizeGeoRetestMetricsSnapshot,
  normalizeRecommendedChannels,
  normalizeRetestMetricSnapshot,
  presentPublishRecord,
} from './studio.mapper';
import type { StudioAuthContext } from './studio.service';

export type CreatePublishRecordServiceInput = PublishRecordCreateInput & {
  distributionTaskId?: string | null;
  indexNowSubmitted?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CRAWL_ALERT_PRIORITY: Record<string, number> = {
  BLOCKED: 0,
  FAILED: 1,
  WARNING: 2,
};

function roundDecimals(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function meanOrNull(values: readonly number[], digits: number): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sum = finite.reduce((acc, v) => acc + v, 0);
  return roundDecimals(sum / finite.length, digits);
}

function pickDominantChannelSentiment(counts: {
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
}): string | null {
  const ordered: ReadonlyArray<['positive' | 'neutral' | 'mixed' | 'negative', number]> = [
    ['positive', counts.positive],
    ['neutral', counts.neutral],
    ['mixed', counts.mixed],
    ['negative', counts.negative],
  ];
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, count] of ordered) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestCount > 0 ? bestKey : null;
}

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
    @Optional()
    @Inject(RetestSchedulerService)
    private readonly retestScheduler?: RetestSchedulerService,
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
      include: {
        retestSchedules: {
          orderBy: { milestoneDay: 'asc' },
        },
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map(presentPublishRecord) };
  }

  async createPublishRecord(
    articleId: string,
    input: CreatePublishRecordServiceInput,
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
        distributionTaskId: input.distributionTaskId ?? null,
        indexNowSubmitted: Boolean(input.indexNowSubmitted),
      },
    });

    if (article.status !== 'PUBLISHED') {
      await this.prisma.scoped.geoArticle.update({
        where: { id: article.id },
        data: { status: 'PUBLISHED' },
      });
    }

    const retestSchedules = this.retestScheduler
      ? await this.retestScheduler.ensureSchedulesForPublishRecord(created, input.autoRetest)
      : await ensureRetestSchedulesForPublishRecord(this.prisma.scoped, created, input.autoRetest);

    return {
      ...presentPublishRecord(created),
      retestSchedules,
    };
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

    const [topBriefRows, recentArticleRows, distributionSummary] = await Promise.all([
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
            include: {
              retestSchedules: {
                orderBy: { milestoneDay: 'asc' },
              },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
      this.buildDistributionSummary(brand.id, market.id),
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
      distributionSummary,
    };
  }

  private async buildDistributionSummary(
    brandId: string,
    brandMarketId: string,
  ): Promise<DistributionSummaryDto> {
    const now = new Date();
    const sevenDaysAhead = new Date(now.getTime() + 7 * DAY_MS);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);

    const hasScheduleDelegate =
      typeof (this.prisma.scoped as unknown as { geoRetestSchedule?: { findMany?: unknown } })
        .geoRetestSchedule?.findMany === 'function';

    const fetchAlertBucket = (crawlStatus: 'BLOCKED' | 'FAILED' | 'WARNING') =>
      this.prisma.scoped.geoPublishRecord.findMany({
        where: {
          brandId,
          brandMarketId,
          crawlStatus,
        },
        include: {
          article: { select: { title: true } },
        },
        orderBy: [{ crawlCheckedAt: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: 5,
      });

    const [blockedRows, failedRows, warningRows, upcomingRows, attributionRows] = await Promise.all(
      [
        fetchAlertBucket('BLOCKED'),
        fetchAlertBucket('FAILED'),
        fetchAlertBucket('WARNING'),
        hasScheduleDelegate
          ? this.prisma.scoped.geoRetestSchedule.findMany({
              where: {
                brandId,
                brandMarketId,
                OR: [
                  { status: { in: ['PENDING', 'RUNNING'] }, dueAt: { lte: sevenDaysAhead } },
                  { status: 'SKIPPED_INSUFFICIENT_POINTS', updatedAt: { gte: fourteenDaysAgo } },
                ],
              },
              include: {
                publishRecord: {
                  select: {
                    id: true,
                    articleId: true,
                    channel: true,
                    article: { select: { title: true } },
                  },
                },
              },
              orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
              take: 5,
            })
          : Promise.resolve([]),
        this.prisma.scoped.geoPublishRecord.findMany({
          where: {
            brandId,
            brandMarketId,
          },
          include: {
            retestSchedules: {
              where: { status: 'COMPLETED' },
              orderBy: [{ milestoneDay: 'desc' }, { executedAt: 'desc' }],
            },
          },
          orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
          take: 500,
        }),
      ],
    );

    const seenAlertIds = new Set<string>();
    const alertRows = [...blockedRows, ...failedRows, ...warningRows].filter((row) => {
      if (seenAlertIds.has(row.id)) return false;
      seenAlertIds.add(row.id);
      return true;
    });

    const crawlAlerts: DistributionCrawlAlertItem[] = alertRows
      .sort((a, b) => {
        const prioA = CRAWL_ALERT_PRIORITY[a.crawlStatus] ?? 99;
        const prioB = CRAWL_ALERT_PRIORITY[b.crawlStatus] ?? 99;
        if (prioA !== prioB) return prioA - prioB;
        const timeA = (a.crawlCheckedAt ?? a.publishedAt).getTime();
        const timeB = (b.crawlCheckedAt ?? b.publishedAt).getTime();
        return timeB - timeA;
      })
      .slice(0, 5)
      .map((row) => {
        const report = normalizeCrawlProbeReport(row.crawlReportJson);
        const issues =
          report && report.issues.length > 0
            ? report.issues
            : report?.errorMessage
              ? [report.errorMessage]
              : [];
        return {
          publishRecordId: row.id,
          articleId: row.articleId,
          articleTitle: row.article?.title ?? '',
          channel: row.channel,
          publishedUrl: row.publishedUrl,
          crawlStatus: row.crawlStatus as CrawlProbeStatus,
          crawlCheckedAt: row.crawlCheckedAt ? row.crawlCheckedAt.toISOString() : null,
          issues,
        };
      });

    const upcomingRetests: DistributionUpcomingRetestItem[] = upcomingRows.map((row) => ({
      scheduleId: row.id,
      publishRecordId: row.publishRecordId,
      articleId: row.publishRecord?.articleId ?? '',
      articleTitle: row.publishRecord?.article?.title ?? '',
      channel: row.publishRecord?.channel ?? '',
      milestoneDay: row.milestoneDay,
      sampleCount: (row.sampleCount === 3 ? 3 : 1) as RetestSampleCount,
      dueAt: row.dueAt.toISOString(),
      status: row.status as RetestScheduleStatus,
      skipReason: row.skipReason ?? null,
    }));

    type ChannelBucket = {
      channel: string;
      publishedCount: number;
      crawlOkCount: number;
      completedRetestCount: number;
      citationHitCount: number;
      mentionDeltas: number[];
      positions: number[];
      positionDeltas: number[];
      sentimentCounts: { positive: number; neutral: number; mixed: number; negative: number };
      retestRunIds: Set<string>;
    };

    const buckets = new Map<string, ChannelBucket>();
    for (const row of attributionRows) {
      let bucket = buckets.get(row.channel);
      if (!bucket) {
        bucket = {
          channel: row.channel,
          publishedCount: 0,
          crawlOkCount: 0,
          completedRetestCount: 0,
          citationHitCount: 0,
          mentionDeltas: [],
          positions: [],
          positionDeltas: [],
          sentimentCounts: { positive: 0, neutral: 0, mixed: 0, negative: 0 },
          retestRunIds: new Set<string>(),
        };
        buckets.set(row.channel, bucket);
      }

      bucket.publishedCount += 1;
      if (row.crawlStatus === 'OK') {
        bucket.crawlOkCount += 1;
      }

      const completedSchedules = Array.isArray(row.retestSchedules) ? row.retestSchedules : [];
      let latestAfter = null;
      let linkedRunId: string | null = row.latestRetestRunId ?? null;

      for (const sched of completedSchedules) {
        const snap = normalizeGeoRetestMetricsSnapshot(sched.metricsSnapshotJson);
        if (snap) {
          latestAfter = snap;
          linkedRunId = sched.visibilityRunId ?? linkedRunId;
          break;
        }
      }

      if (!latestAfter) {
        latestAfter = normalizeRetestMetricSnapshot(row.afterMetrics);
      }

      if (!latestAfter) continue;

      bucket.completedRetestCount += 1;
      if (linkedRunId) {
        bucket.retestRunIds.add(linkedRunId);
      }
      if (latestAfter.citationHit) {
        bucket.citationHitCount += 1;
      }

      const before = normalizeRetestMetricSnapshot(row.beforeMetrics);
      if (
        before &&
        Number.isFinite(latestAfter.mentionRate) &&
        Number.isFinite(before.mentionRate)
      ) {
        bucket.mentionDeltas.push(latestAfter.mentionRate - before.mentionRate);
      }
      if (typeof latestAfter.avgPosition === 'number' && Number.isFinite(latestAfter.avgPosition)) {
        bucket.positions.push(latestAfter.avgPosition);
        if (typeof before?.avgPosition === 'number' && Number.isFinite(before.avgPosition)) {
          bucket.positionDeltas.push(latestAfter.avgPosition - before.avgPosition);
        }
      }
      if (
        latestAfter.sentiment === 'positive' ||
        latestAfter.sentiment === 'neutral' ||
        latestAfter.sentiment === 'mixed' ||
        latestAfter.sentiment === 'negative'
      ) {
        bucket.sentimentCounts[latestAfter.sentiment] += 1;
      }
    }

    // PRD D5 zero-citation graceful degradation: check whether upstream runs returned ANY citations
    const candidateRunIds = new Set<string>();
    for (const bucket of buckets.values()) {
      if (bucket.completedRetestCount > 0 && bucket.citationHitCount === 0) {
        for (const runId of bucket.retestRunIds) {
          candidateRunIds.add(runId);
        }
      }
    }

    const runsWithCitations = new Set<string>();
    const hasObsDelegate =
      typeof (this.prisma.scoped as unknown as { visibilityObservation?: { findMany?: unknown } })
        .visibilityObservation?.findMany === 'function';

    if (candidateRunIds.size > 0 && hasObsDelegate) {
      const citedObs = await this.prisma.scoped.visibilityObservation.findMany({
        where: {
          runId: { in: [...candidateRunIds] },
          status: 'SUCCESS',
        },
        select: {
          runId: true,
          citations: {
            select: { id: true },
            take: 1,
          },
        },
      });
      for (const obs of citedObs) {
        if (Array.isArray(obs.citations) && obs.citations.length > 0) {
          runsWithCitations.add(obs.runId);
        }
      }
    }

    const channelAttribution: DistributionChannelAttributionItem[] = [...buckets.values()]
      .map((bucket) => {
        const sentimentTotal =
          bucket.sentimentCounts.positive +
          bucket.sentimentCounts.neutral +
          bucket.sentimentCounts.mixed +
          bucket.sentimentCounts.negative;

        let citationHitRate: number | null = null;
        if (bucket.completedRetestCount > 0) {
          if (bucket.citationHitCount > 0) {
            citationHitRate = roundDecimals(
              bucket.citationHitCount / bucket.completedRetestCount,
              3,
            );
          } else {
            const hasUpstreamCitations = [...bucket.retestRunIds].some((id) =>
              runsWithCitations.has(id),
            );
            citationHitRate = hasUpstreamCitations ? 0 : null;
          }
        }

        const citationHitWilson =
          citationHitRate !== null && bucket.completedRetestCount > 0
            ? computeWilsonInterval(bucket.citationHitCount, bucket.completedRetestCount)
            : null;

        const positiveSentimentRate =
          sentimentTotal > 0
            ? roundDecimals(bucket.sentimentCounts.positive / sentimentTotal, 3)
            : null;

        return {
          channel: bucket.channel,
          publishedCount: bucket.publishedCount,
          crawlOkCount: bucket.crawlOkCount,
          completedRetestCount: bucket.completedRetestCount,
          citationHitCount: bucket.citationHitCount,
          citationHitRate,
          citationHitWilson,
          avgMentionRateDelta: meanOrNull(bucket.mentionDeltas, 1),
          avgPosition: meanOrNull(bucket.positions, 1),
          avgPositionDelta: meanOrNull(bucket.positionDeltas, 1),
          positiveSentimentRate,
          sentimentSummary: pickDominantChannelSentiment(bucket.sentimentCounts),
        };
      })
      .sort((a, b) => {
        if (b.publishedCount !== a.publishedCount) return b.publishedCount - a.publishedCount;
        if (b.completedRetestCount !== a.completedRetestCount) {
          return b.completedRetestCount - a.completedRetestCount;
        }
        return a.channel.localeCompare(b.channel);
      });

    return {
      crawlAlerts,
      upcomingRetests,
      channelAttribution,
    };
  }
}
