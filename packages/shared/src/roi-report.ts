import { z } from 'zod';
import { BRAND_ID_PATTERN, GEO_MARKETS, type GeoMarket } from './brands';
import {
  isSafeDistributionHttpUrl,
  type ChannelProvider,
  type DistributionMode,
} from './distribution';
import { SUPPORTED_LOCALE_CODES, type SupportedLocale } from './locales';
import {
  differenceInDifferencesSchema,
  wilsonIntervalSchema,
  type ConfidenceLevel,
  type DifferenceInDifferencesResult,
  type WilsonInterval,
} from './stats';
import {
  CITATION_SOURCE_KINDS,
  type CitationSourceKind,
  type VisibilityEngineKey,
} from './visibility';

/**
 * GeoMix v2.2 Near-Miss 4 层掘金与月度 GEO ROI 报告契约（Issue #367 / #368 / #369 / #372）：
 * - 4 层双信号 Near-Miss 分层定义与补强意见卡输入校验
 * - GeoRoiReport 不可变汇总快照 DTO、创建与分享 Schema
 * - 白名单脱敏 PublicGeoRoiReportDto 与 sanitizeSummaryForPublicReport()（零 tenantId/userId/pointsRoi 泄漏）
 */

export const NEAR_MISS_TIERS = [
  'OPENED_NOT_CITED',
  'RETRIEVED_NOT_CITED',
  'CRAWLED_NOT_CITED',
  'MENTIONED_NOT_OWNED',
] as const;
export type NearMissTier = (typeof NEAR_MISS_TIERS)[number];

export const NEAR_MISS_TIER_LABELS: Record<NearMissTier, string> = {
  OPENED_NOT_CITED: 'AI 点开未引用（Tier 1）',
  RETRIEVED_NOT_CITED: 'AI 召回未引用（Tier 2）',
  CRAWLED_NOT_CITED: '可抓取未进引文（Tier 3A）',
  MENTIONED_NOT_OWNED: '提及未引官网（Tier 3B）',
};

export const NEAR_MISS_TIER_EN_LABELS: Record<NearMissTier, string> = {
  OPENED_NOT_CITED: 'Opened, Not Cited (Tier 1)',
  RETRIEVED_NOT_CITED: 'Retrieved, Not Cited (Tier 2)',
  CRAWLED_NOT_CITED: 'Crawled, Not Cited (Tier 3A)',
  MENTIONED_NOT_OWNED: 'Mentioned, Owned Not Cited (Tier 3B)',
};

const optionalNearMissProductLineIdQuerySchema = z.preprocess(
  (value) =>
    value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
  z.string().trim().regex(BRAND_ID_PATTERN, '产品线编号格式不正确').optional(),
);

const optionalNearMissProductLineIdBodySchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().regex(BRAND_ID_PATTERN, '产品线编号格式不正确').nullable().optional(),
);

export const nearMissQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  productLineId: optionalNearMissProductLineIdQuerySchema,
  days: z.coerce.number().int().min(1).max(90).default(30),
  tier: z.enum(NEAR_MISS_TIERS).optional(),
  sourceKind: z.enum(CITATION_SOURCE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type NearMissQueryInput = z.input<typeof nearMissQuerySchema>;
export type ParsedNearMissQuery = z.output<typeof nearMissQuerySchema>;

export type NearMissItemDto = {
  id: string;
  tier: NearMissTier;
  opportunityScore: number;
  url: string | null;
  domain: string | null;
  title: string | null;
  snippet: string | null;
  sourceKind: CitationSourceKind;
  isOwned: boolean;
  engines: string[];
  prompts: string[];
  observationIds: string[];
  openedCount: number;
  retrievedCount: number;
  publishRecordId?: string | null;
  lastSeenAt: string;
};

export type NearMissListResponse = {
  brandId: string;
  market: GeoMarket;
  days: number;
  total: number;
  tierCounts: Record<NearMissTier, number>;
  hasRawRetrievalSignals: boolean;
  items: NearMissItemDto[];
};

export const createNearMissBoostBriefSchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  productLineId: optionalNearMissProductLineIdBodySchema,
  tier: z.enum(NEAR_MISS_TIERS),
  targetPrompt: z.string().trim().min(2, '目标问题至少 2 字').max(300),
  sourceUrl: z
    .string()
    .trim()
    .max(2048)
    .refine(isSafeDistributionHttpUrl, '请输入有效的 http:// 或 https:// 网页链接')
    .optional(),
  sourceTitle: z.string().trim().max(200).optional(),
  observationIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
});
export type CreateNearMissBoostBriefInput = z.infer<typeof createNearMissBoostBriefSchema>;

// ==================== Monthly GEO ROI Report Contracts ====================

export const DEFAULT_ROI_REPORT_SHARE_TTL_DAYS = 30 as const;

export type GeoRoiReportEngineMetric = {
  engine: VisibilityEngineKey | string;
  observations: number;
  mentionRate: number;
  citationRate: number;
  ownedCitationRate: number;
  avgPosition: number | null;
  mentionWilson: WilsonInterval;
};

export type GeoRoiReportFunnelSummary = {
  publishedTotal: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  crawlCheckedCount: number;
  crawlOkCount: number;
  crawlOkRate: number | null;
  indexNowAttemptedCount: number;
  indexNowSuccessCount: number;
  indexNowRate: number | null;
};

export type GeoRoiReportChannelRank = {
  channel: string;
  provider?: ChannelProvider | null;
  mode?: DistributionMode | null;
  publishedCount: number;
  completedRetestCount: number;
  citationHitCount: number;
  citationHitRate: number | null;
  citationHitWilson: WilsonInterval | null;
  avgMentionRateDelta: number | null;
};

export type GeoRoiReportMilestonePoint = {
  milestoneDay: number;
  trials: number;
  hits: number;
  mentionRate: number;
  wilson: WilsonInterval;
  controlMentionRate?: number | null;
  did?: DifferenceInDifferencesResult | null;
};

export type GeoRoiReportNearMissSummary = {
  totalOpportunities: number;
  boostBriefsCreated: number;
  convertedToCited: number;
  tierCounts: Record<NearMissTier, number>;
};

export type GeoRoiReportPointsSummary = {
  totalPointsSpent: number;
  articlesPublished: number;
  citationHitsGained: number;
  pointsPerPublishedArticle: number | null;
  pointsPerCitationHit: number | null;
};

export type GeoRoiReportSummaryDto = {
  version: 1;
  overview: {
    totalObservations: number;
    mentionHits: number;
    mentionRate: number;
    mentionWilson: WilsonInterval;
    citationHits: number;
    citationRate: number;
    ownedCitationHits: number;
    ownedCitationRate: number;
    confidenceLevel: ConfidenceLevel;
    did: DifferenceInDifferencesResult | null;
    simulatedObservations?: number;
    hasSimulatedObservations?: boolean;
  };
  byEngine: GeoRoiReportEngineMetric[];
  nearMiss: GeoRoiReportNearMissSummary;
  funnel: GeoRoiReportFunnelSummary;
  channelRanking: GeoRoiReportChannelRank[];
  milestoneTrend: GeoRoiReportMilestonePoint[];
  pointsRoi?: GeoRoiReportPointsSummary;
};

export type PublicGeoRoiReportSummaryDto = Omit<GeoRoiReportSummaryDto, 'pointsRoi'>;

const ROI_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function isValidCalendarDateInput(value: string): boolean {
  const match = ROI_DATE_PREFIX_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

export const roiReportDateInputSchema = z
  .string()
  .trim()
  .refine(isValidCalendarDateInput, '日期格式必须为有效的 YYYY-MM-DD 或 ISO-8601 时间戳');

export const createGeoRoiReportSchema = z
  .object({
    market: z.enum(GEO_MARKETS).optional(),
    title: z.string().trim().min(1, '请填写报告标题').max(120, '报告标题最多 120 字符').optional(),
    periodStart: roiReportDateInputSchema,
    periodEnd: roiReportDateInputSchema,
    locale: z.enum(SUPPORTED_LOCALE_CODES).optional(),
    whiteLabelOrg: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().max(80, '白标机构名称最多 80 字符').nullable().optional(),
    ),
  })
  .refine((v) => new Date(v.periodStart).getTime() <= new Date(v.periodEnd).getTime(), {
    message: '开始时间不能晚于结束时间',
    path: ['periodEnd'],
  });
export type CreateGeoRoiReportInput = z.input<typeof createGeoRoiReportSchema>;
export type ParsedCreateGeoRoiReportInput = z.output<typeof createGeoRoiReportSchema>;

export const createGeoRoiReportShareSchema = z
  .object({
    ttlDays: z.number().int().min(1).max(90).optional().default(DEFAULT_ROI_REPORT_SHARE_TTL_DAYS),
  })
  .optional()
  .default({ ttlDays: DEFAULT_ROI_REPORT_SHARE_TTL_DAYS });
export type CreateGeoRoiReportShareInput = z.input<typeof createGeoRoiReportShareSchema>;

/** 控制台已鉴权视角（绝不暴露 shareTokenHash） */
export type GeoRoiReportRecordDto = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  title: string;
  periodStart: string;
  periodEnd: string;
  locale: SupportedLocale;
  whiteLabelOrg: string | null;
  summary: GeoRoiReportSummaryDto;
  shareActive: boolean;
  shareExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeoRoiReportShareResultDto = {
  reportId: string;
  sharePath: string;
  shareUrl: string;
  expiresAt: string;
};

/** 公开免登录白标视角（严格白名单脱敏：绝不含 tenantId / userId / shareTokenHash / pointsRoi） */
export type PublicGeoRoiReportDto = {
  title: string;
  brandName: string;
  category: string;
  market: GeoMarket;
  locale: SupportedLocale;
  whiteLabelOrg: string | null;
  periodStart: string;
  periodEnd: string;
  summary: PublicGeoRoiReportSummaryDto;
  generatedAt: string;
  expiresAt: string;
};

export const geoRoiReportOverviewSchema = z.object({
  totalObservations: z.number().int().min(0),
  mentionHits: z.number().int().min(0),
  mentionRate: z.number().min(0).max(1),
  mentionWilson: wilsonIntervalSchema,
  citationHits: z.number().int().min(0),
  citationRate: z.number().min(0).max(1),
  ownedCitationHits: z.number().int().min(0),
  ownedCitationRate: z.number().min(0).max(1),
  confidenceLevel: wilsonIntervalSchema.shape.confidenceLevel,
  did: differenceInDifferencesSchema.nullable(),
});

function pickWilsonInterval(w: WilsonInterval): WilsonInterval {
  return {
    hits: w.hits,
    trials: w.trials,
    rate: w.rate,
    lower: w.lower,
    upper: w.upper,
    halfWidth: w.halfWidth,
    z: w.z,
    confidenceLevel: w.confidenceLevel,
  };
}

function pickDid(did: DifferenceInDifferencesResult): DifferenceInDifferencesResult {
  return {
    treatmentDelta: did.treatmentDelta,
    controlDelta: did.controlDelta,
    netLift: did.netLift,
    direction: did.direction,
  };
}

function pickFunnel(funnel: GeoRoiReportFunnelSummary): GeoRoiReportFunnelSummary {
  return {
    publishedTotal: funnel.publishedTotal,
    l1Count: funnel.l1Count,
    l2Count: funnel.l2Count,
    l3Count: funnel.l3Count,
    crawlCheckedCount: funnel.crawlCheckedCount,
    crawlOkCount: funnel.crawlOkCount,
    crawlOkRate: funnel.crawlOkRate,
    indexNowAttemptedCount: funnel.indexNowAttemptedCount,
    indexNowSuccessCount: funnel.indexNowSuccessCount,
    indexNowRate: funnel.indexNowRate,
  };
}

/**
 * 公开只读分享脱敏：严格剔除 pointsRoi 及任何未白名单字段（含全部嵌套对象深层白名单）。
 */
export function sanitizeSummaryForPublicReport(
  summary: GeoRoiReportSummaryDto,
): PublicGeoRoiReportSummaryDto {
  return {
    version: 1,
    overview: {
      totalObservations: summary.overview.totalObservations,
      mentionHits: summary.overview.mentionHits,
      mentionRate: summary.overview.mentionRate,
      mentionWilson: pickWilsonInterval(summary.overview.mentionWilson),
      citationHits: summary.overview.citationHits,
      citationRate: summary.overview.citationRate,
      ownedCitationHits: summary.overview.ownedCitationHits,
      ownedCitationRate: summary.overview.ownedCitationRate,
      confidenceLevel: summary.overview.confidenceLevel,
      did: summary.overview.did ? pickDid(summary.overview.did) : null,
    },
    byEngine: summary.byEngine.map((item) => ({
      engine: item.engine,
      observations: item.observations,
      mentionRate: item.mentionRate,
      citationRate: item.citationRate,
      ownedCitationRate: item.ownedCitationRate,
      avgPosition: item.avgPosition,
      mentionWilson: pickWilsonInterval(item.mentionWilson),
    })),
    nearMiss: {
      totalOpportunities: summary.nearMiss.totalOpportunities,
      boostBriefsCreated: summary.nearMiss.boostBriefsCreated,
      convertedToCited: summary.nearMiss.convertedToCited,
      tierCounts: {
        OPENED_NOT_CITED: summary.nearMiss.tierCounts.OPENED_NOT_CITED,
        RETRIEVED_NOT_CITED: summary.nearMiss.tierCounts.RETRIEVED_NOT_CITED,
        CRAWLED_NOT_CITED: summary.nearMiss.tierCounts.CRAWLED_NOT_CITED,
        MENTIONED_NOT_OWNED: summary.nearMiss.tierCounts.MENTIONED_NOT_OWNED,
      },
    },
    funnel: pickFunnel(summary.funnel),
    channelRanking: summary.channelRanking.map((item) => ({
      channel: item.channel,
      ...(item.provider !== undefined ? { provider: item.provider } : {}),
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      publishedCount: item.publishedCount,
      completedRetestCount: item.completedRetestCount,
      citationHitCount: item.citationHitCount,
      citationHitRate: item.citationHitRate,
      citationHitWilson: item.citationHitWilson ? pickWilsonInterval(item.citationHitWilson) : null,
      avgMentionRateDelta: item.avgMentionRateDelta,
    })),
    milestoneTrend: summary.milestoneTrend.map((point) => ({
      milestoneDay: point.milestoneDay,
      trials: point.trials,
      hits: point.hits,
      mentionRate: point.mentionRate,
      wilson: pickWilsonInterval(point.wilson),
      ...(point.controlMentionRate !== undefined
        ? { controlMentionRate: point.controlMentionRate }
        : {}),
      ...(point.did !== undefined ? { did: point.did ? pickDid(point.did) : null } : {}),
    })),
  };
}
