import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  CHANNEL_PROVIDERS,
  CONFIDENCE_LEVELS,
  CRAWL_PROBE_STATUSES,
  RETEST_SCHEDULE_STATUSES,
  computeWilsonInterval,
  crawlProbeReportSchema,
  differenceInDifferencesSchema,
  isSupportedLocale,
  supportedLocalesForMarket,
  wilsonIntervalSchema,
  type ChannelProvider,
  type ConfidenceLevel,
  type CrawlProbeReport,
  type CrawlProbeStatus,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefChannelRecommendation,
  type GeoComplianceFlag,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoPublishRecordDto,
  type GeoRecipe,
  type GeoRetestControlMetricsSnapshot,
  type GeoRetestMetricsSnapshot,
  type GeoRetestScheduleDto,
  type GeoTargetFormat,
  type PromptPreferenceRecord,
  type RetestMetricSnapshot,
  type RetestSampleCount,
  type RetestScheduleStatus,
  type SupportedLocale,
  type TaskStatusName,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';

export function resolveStudioTargetLocale(params: {
  market: GeoMarket;
  requestedLocale?: string | null;
  brandMarketLocale?: string | null;
  supportedLocales?: readonly string[] | null;
}): SupportedLocale {
  const marketAllowed = supportedLocalesForMarket(params.market);
  const marketAllowedSet = new Set<string>(marketAllowed);

  const fallbackLocale: SupportedLocale =
    params.market === 'CN'
      ? 'zh-CN'
      : isSupportedLocale(params.brandMarketLocale) &&
          marketAllowedSet.has(params.brandMarketLocale.trim())
        ? (params.brandMarketLocale.trim() as SupportedLocale)
        : 'en-US';

  const dedupedSupported: SupportedLocale[] = [];
  for (const item of params.supportedLocales ?? []) {
    if (isSupportedLocale(item)) {
      const normalized = item.trim() as SupportedLocale;
      if (marketAllowedSet.has(normalized) && !dedupedSupported.includes(normalized)) {
        dedupedSupported.push(normalized);
      }
    }
  }
  const effectiveSupportedLocales: SupportedLocale[] =
    dedupedSupported.length > 0 ? dedupedSupported : [fallbackLocale];

  const requestedRaw =
    typeof params.requestedLocale === 'string' ? params.requestedLocale.trim() : '';
  if (requestedRaw.length > 0) {
    if (!isSupportedLocale(requestedRaw)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `不支持的目标语种：${requestedRaw}`);
    }
    if (!marketAllowedSet.has(requestedRaw)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `目标语种 ${requestedRaw} 与当前市场（${params.market}）不匹配`,
      );
    }
    if (!effectiveSupportedLocales.includes(requestedRaw)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `该品牌市场尚未开启目标语种 ${requestedRaw}，请先在品牌设置中启用`,
      );
    }
    return requestedRaw;
  }

  return effectiveSupportedLocales.includes(fallbackLocale)
    ? fallbackLocale
    : (effectiveSupportedLocales[0] ?? fallbackLocale);
}

export function deriveGeoArticleId(tenantId: string, idempotencyKey: string): string {
  const hash = createHash('sha256').update(`${tenantId}::article::${idempotencyKey}`).digest('hex');
  return `ga_${hash.slice(0, 24)}`;
}

export function deriveGeoBatchJobId(tenantId: string, idempotencyKey: string): string {
  const hash = createHash('sha256').update(`${tenantId}::batch::${idempotencyKey}`).digest('hex');
  return `gb_${hash.slice(0, 24)}`;
}

export function normalizeComplianceFlags(
  raw: Prisma.JsonValue | null | undefined,
): GeoComplianceFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoComplianceFlag[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const code = typeof obj.code === 'string' ? obj.code : 'AD_LAW_FLAG';
    const market: GeoMarket = obj.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const term = typeof obj.term === 'string' ? obj.term : '';
    const severity =
      obj.severity === 'blocked' ||
      obj.severity === 'replaced' ||
      obj.severity === 'warning' ||
      obj.severity === 'info'
        ? obj.severity
        : 'warning';
    const message = typeof obj.message === 'string' ? obj.message : '';
    out.push({
      code: code as GeoComplianceFlag['code'],
      market,
      term,
      ...(typeof obj.replacement === 'string' ? { replacement: obj.replacement } : {}),
      severity,
      message,
    });
  }
  return out;
}

export function normalizeOutlineJson(
  raw: Prisma.JsonValue | null | undefined,
): GeoOutlineHeading[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoOutlineHeading[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const heading = typeof obj.heading === 'string' ? obj.heading.trim() : '';
    if (!heading) continue;
    const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';
    const fanOutRef =
      typeof obj.fanOutRef === 'string' && obj.fanOutRef.trim() ? obj.fanOutRef.trim() : undefined;
    out.push({
      heading,
      intent,
      ...(fanOutRef ? { fanOutRef } : {}),
    });
  }
  return out;
}

export function normalizeJsonRecord(
  raw: Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function extractCompetitorNames(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

export type GeoArticleRowWithMarket = {
  id: string;
  brandId: string;
  brandMarketId: string;
  productLineId?: string | null;
  briefId: string | null;
  batchJobId: string | null;
  recipe: string;
  targetFormat: string;
  targetLocale?: string | null;
  title: string;
  targetPrompt: string;
  outlineJson: Prisma.JsonValue;
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: Prisma.JsonValue;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: Prisma.JsonValue;
  tags: string[];
  status: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  complianceFlags: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

export function presentGeoArticle(
  row: GeoArticleRowWithMarket,
  fallbackMarket?: GeoMarket,
): GeoArticleRecord {
  const market: GeoMarket =
    row.brandMarket?.market === 'GLOBAL' || fallbackMarket === 'GLOBAL' ? 'GLOBAL' : 'CN';
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    productLineId: row.productLineId ?? null,
    market,
    briefId: row.briefId,
    batchJobId: row.batchJobId,
    recipe: row.recipe as GeoRecipe,
    targetFormat: row.targetFormat as GeoTargetFormat,
    targetLocale: isSupportedLocale(row.targetLocale)
      ? (row.targetLocale.trim() as SupportedLocale)
      : null,
    title: row.title,
    targetPrompt: row.targetPrompt,
    outlineJson: normalizeOutlineJson(row.outlineJson),
    contentMarkdown: row.contentMarkdown,
    contentHtml: row.contentHtml,
    schemaJsonLd: normalizeJsonRecord(row.schemaJsonLd),
    llmsTxtSnippet: row.llmsTxtSnippet,
    geoScore: row.geoScore,
    geoScoreDetail: normalizeJsonRecord(row.geoScoreDetail),
    tags: [...row.tags],
    status: row.status as GeoArticleStatus,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    complianceFlags: normalizeComplianceFlags(row.complianceFlags),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type GeoBatchJobRowWithMarket = {
  id: string;
  brandId: string;
  brandMarketId: string;
  briefIds: string[];
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  brandMarket?: { market: string } | null;
};

export function presentGeoBatchJob(
  row: GeoBatchJobRowWithMarket,
  fallbackMarket?: GeoMarket,
): GeoBatchJobRecord {
  const market: GeoMarket =
    row.brandMarket?.market === 'GLOBAL' || fallbackMarket === 'GLOBAL' ? 'GLOBAL' : 'CN';
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    briefIds: [...row.briefIds],
    total: row.total,
    doneCount: row.doneCount,
    failCount: row.failCount,
    unitPrice: row.unitPrice,
    reservationId: row.reservationId,
    status: row.status as TaskStatusName,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export function presentPromptPreference(
  row: {
    customToneNote: string | null;
    customForbiddenWords: string[];
    recipeOverrides: Prisma.JsonValue | null;
    updatedAt: Date;
  } | null,
): PromptPreferenceRecord {
  if (!row) {
    return {
      customToneNote: null,
      customForbiddenWords: [],
      recipeOverrides: null,
      updatedAt: null,
    };
  }
  let overrides: Record<string, string> | null = null;
  if (
    row.recipeOverrides &&
    typeof row.recipeOverrides === 'object' &&
    !Array.isArray(row.recipeOverrides)
  ) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.recipeOverrides as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v;
    }
    overrides = Object.keys(clean).length > 0 ? clean : null;
  }
  return {
    customToneNote: row.customToneNote,
    customForbiddenWords: [...row.customForbiddenWords],
    recipeOverrides: overrides,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function normalizeRetestMetricSnapshot(
  raw: Prisma.JsonValue | null | undefined,
): RetestMetricSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const mentionRate =
    typeof obj.mentionRate === 'number' && Number.isFinite(obj.mentionRate)
      ? obj.mentionRate
      : null;
  if (mentionRate === null) return null;
  const avgPosition =
    typeof obj.avgPosition === 'number' && Number.isFinite(obj.avgPosition)
      ? obj.avgPosition
      : null;
  const sentiment =
    typeof obj.sentiment === 'string' && obj.sentiment.trim() ? obj.sentiment : null;
  const citationHit = Boolean(obj.citationHit);
  return {
    mentionRate,
    avgPosition,
    sentiment,
    citationHit,
  };
}

const CRAWL_PROBE_STATUS_SET = new Set<string>(CRAWL_PROBE_STATUSES);
const RETEST_SCHEDULE_STATUS_SET = new Set<string>(RETEST_SCHEDULE_STATUSES);
const CONFIDENCE_LEVEL_SET = new Set<string>(CONFIDENCE_LEVELS);

export function normalizeGeoRetestMetricsSnapshot(
  raw: Prisma.JsonValue | null | undefined,
): GeoRetestMetricsSnapshot | null {
  const base = normalizeRetestMetricSnapshot(raw);
  if (!base) return null;
  const obj = raw as Record<string, unknown>;
  const out: GeoRetestMetricsSnapshot = { ...base };
  if (
    typeof obj.sampleCount === 'number' &&
    Number.isInteger(obj.sampleCount) &&
    obj.sampleCount >= 0
  ) {
    out.sampleCount = obj.sampleCount;
  }
  if (typeof obj.hitCount === 'number' && Number.isInteger(obj.hitCount) && obj.hitCount >= 0) {
    out.hitCount = obj.hitCount;
  }
  const parsedWilson = wilsonIntervalSchema.safeParse(obj.wilson);
  if (parsedWilson.success) {
    out.wilson = parsedWilson.data;
  } else if (out.sampleCount !== undefined && out.hitCount !== undefined && out.sampleCount > 0) {
    out.wilson = computeWilsonInterval(out.hitCount, out.sampleCount);
  }
  if (typeof obj.confidenceLevel === 'string' && CONFIDENCE_LEVEL_SET.has(obj.confidenceLevel)) {
    out.confidenceLevel = obj.confidenceLevel as ConfidenceLevel;
  } else if (out.wilson) {
    out.confidenceLevel = out.wilson.confidenceLevel;
  }
  return out;
}

export function normalizeGeoRetestControlMetricsSnapshot(
  raw: Prisma.JsonValue | null | undefined,
): GeoRetestControlMetricsSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const currentMentionRate =
    typeof obj.currentMentionRate === 'number' && Number.isFinite(obj.currentMentionRate)
      ? obj.currentMentionRate
      : null;
  if (currentMentionRate === null) return null;

  const baselineMentionRate =
    typeof obj.baselineMentionRate === 'number' && Number.isFinite(obj.baselineMentionRate)
      ? obj.baselineMentionRate
      : null;

  const controlPrompts = Array.isArray(obj.controlPrompts)
    ? obj.controlPrompts
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];

  const sampleCount =
    typeof obj.sampleCount === 'number' && Number.isInteger(obj.sampleCount) && obj.sampleCount >= 0
      ? obj.sampleCount
      : 0;

  const hitCount =
    typeof obj.hitCount === 'number' && Number.isInteger(obj.hitCount) && obj.hitCount >= 0
      ? obj.hitCount
      : 0;

  const parsedWilson = wilsonIntervalSchema.safeParse(obj.wilson);
  const wilson = parsedWilson.success
    ? parsedWilson.data
    : sampleCount > 0
      ? computeWilsonInterval(hitCount, sampleCount)
      : undefined;

  const parsedDid =
    obj.did === null || obj.did === undefined
      ? null
      : differenceInDifferencesSchema.safeParse(obj.did);
  const did = parsedDid && parsedDid.success ? parsedDid.data : null;

  return {
    controlPrompts,
    baselineMentionRate,
    currentMentionRate,
    sampleCount,
    hitCount,
    ...(wilson ? { wilson } : {}),
    did,
  };
}

export function normalizeCrawlProbeReport(
  raw: Prisma.JsonValue | null | undefined,
): CrawlProbeReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = crawlProbeReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type GeoRetestScheduleRow = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: number;
  includeControlPrompts?: boolean;
  dueAt: Date;
  status: string;
  visibilityRunId: string | null;
  metricsSnapshotJson: Prisma.JsonValue | null;
  controlMetricsJson?: Prisma.JsonValue | null;
  skipReason: string | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function presentRetestSchedule(row: GeoRetestScheduleRow): GeoRetestScheduleDto {
  const sampleCount: RetestSampleCount = row.sampleCount === 3 ? 3 : 1;
  const status: RetestScheduleStatus = RETEST_SCHEDULE_STATUS_SET.has(row.status)
    ? (row.status as RetestScheduleStatus)
    : 'PENDING';
  return {
    id: row.id,
    publishRecordId: row.publishRecordId,
    milestoneDay: row.milestoneDay,
    sampleCount,
    includeControlPrompts: Boolean(row.includeControlPrompts),
    dueAt: row.dueAt.toISOString(),
    status,
    visibilityRunId: row.visibilityRunId ?? null,
    metricsSnapshot: normalizeGeoRetestMetricsSnapshot(row.metricsSnapshotJson),
    controlMetricsJson: normalizeGeoRetestControlMetricsSnapshot(row.controlMetricsJson),
    skipReason: row.skipReason ?? null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type GeoPublishRecordRow = {
  id: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: Prisma.JsonValue | null;
  afterMetrics: Prisma.JsonValue | null;
  distributionTaskId?: string | null;
  crawlStatus?: string | null;
  crawlCheckedAt?: Date | null;
  crawlReportJson?: Prisma.JsonValue | null;
  indexNowSubmitted?: boolean | null;
  retestSchedules?: GeoRetestScheduleRow[];
};

export function presentPublishRecord(row: GeoPublishRecordRow): GeoPublishRecordDto {
  const crawlStatus: CrawlProbeStatus =
    typeof row.crawlStatus === 'string' && CRAWL_PROBE_STATUS_SET.has(row.crawlStatus)
      ? (row.crawlStatus as CrawlProbeStatus)
      : 'PENDING';
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    articleId: row.articleId,
    publishedUrl: row.publishedUrl,
    channel: row.channel,
    publishedAt: row.publishedAt.toISOString(),
    baselineRunId: row.baselineRunId,
    latestRetestRunId: row.latestRetestRunId,
    beforeMetrics: normalizeRetestMetricSnapshot(row.beforeMetrics),
    afterMetrics: normalizeRetestMetricSnapshot(row.afterMetrics),
    distributionTaskId: row.distributionTaskId ?? null,
    crawlStatus,
    crawlCheckedAt: row.crawlCheckedAt ? row.crawlCheckedAt.toISOString() : null,
    crawlReportJson: normalizeCrawlProbeReport(row.crawlReportJson),
    indexNowSubmitted: Boolean(row.indexNowSubmitted),
    retestSchedules: Array.isArray(row.retestSchedules)
      ? row.retestSchedules.map(presentRetestSchedule)
      : [],
  };
}

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);

export function normalizeRecommendedChannels(
  raw: Prisma.JsonValue | null | undefined,
): GeoBriefChannelRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoBriefChannelRecommendation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const channel = typeof obj.channel === 'string' ? obj.channel.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!channel) continue;

    const entry: GeoBriefChannelRecommendation = { channel, reason };
    if (typeof obj.providerHint === 'string' && CHANNEL_PROVIDER_SET.has(obj.providerHint)) {
      entry.providerHint = obj.providerHint as ChannelProvider;
    }
    if (obj.priority === 'HIGH' || obj.priority === 'MEDIUM') {
      entry.priority = obj.priority;
    }
    if (Array.isArray(obj.citedExampleUrls)) {
      const urls = obj.citedExampleUrls
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map((u) => u.trim())
        .slice(0, 3);
      if (urls.length > 0) {
        entry.citedExampleUrls = urls;
      }
    }
    out.push(entry);
  }
  return out;
}
