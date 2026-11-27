import type { Prisma } from '@prisma/client';
import {
  CHANNEL_PROVIDERS,
  CHANNEL_PROVIDER_EN_LABELS,
  CHANNEL_PROVIDER_LABELS,
  DISTRIBUTION_MODES,
  FAKE_MARK,
  classifyCitationSource,
  computeDifferenceInDifferences,
  computeWilsonInterval,
  defaultDistributionModeForProvider,
  differenceInDifferencesSchema,
  isRetiredVisibilityEngine,
  isSimulatedCollectorKind,
  localizePublicChannelLabel,
  normalizeVisibilityDomain,
  parseEnv,
  resolveEffectiveLocale,
  wilsonIntervalSchema,
  type ChannelProvider,
  type DifferenceInDifferencesResult,
  type DistributionMode,
  type GeoMarket,
  type GeoRoiReportChannelRank,
  type GeoRoiReportEngineMetric,
  type GeoRoiReportFunnelSummary,
  type GeoRoiReportMilestonePoint,
  type GeoRoiReportNearMissSummary,
  type GeoRoiReportPointsSummary,
  type GeoRoiReportRecordDto,
  type GeoRoiReportSummaryDto,
  type NearMissTier,
  type SupportedLocale,
  type WilsonInterval,
} from '@geomix/shared';
import {
  normalizeGeoRetestControlMetricsSnapshot,
  normalizeGeoRetestMetricsSnapshot,
  normalizeRetestMetricSnapshot,
} from '../studio/studio.mapper';
import { isEffectiveBrandMention, parseProfileCompetitors } from '../visibility/visibility.mapper';
import { canonicalizeNearMissUrl } from '../visibility/visibility-near-miss.service';

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);
const DISTRIBUTION_MODE_SET = new Set<string>(DISTRIBUTION_MODES);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function roundDecimals(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function round4(value: number): number {
  return roundDecimals(value, 4);
}

function round2(value: number): number {
  return roundDecimals(value, 2);
}

function normalizePromptKey(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

const CJK_CHAR_RE = /[\u4e00-\u9fff]/;

const MANUAL_ZH_CHANNEL_TO_EN: Readonly<Record<string, string>> = {
  微信公众号草稿箱: 'WeChat Official Drafts',
  微信公众号: 'WeChat Official Drafts',
  知乎: 'Zhihu',
  今日头条: 'Toutiao',
  什么值得买: 'SMZDM',
  小红书: 'Xiaohongshu',
  官方博客: 'Official Blog',
  手动发布: 'Manual Channel',
  外部渠道: 'Manual Channel',
};

const PROVIDER_ZH_TO_EN_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CHANNEL_PROVIDERS.map((provider) => [
    CHANNEL_PROVIDER_LABELS[provider],
    CHANNEL_PROVIDER_EN_LABELS[provider],
  ]),
);

/**
 * 将周期边界日期按 UTC 格式化为 YYYY-MM-DD（不使用字符串切片，也不叠加东八区偏移），
 * 避免 2026-10-31T23:59:59.999Z 被展示为 2026-11-01。
 */
export function formatUtcDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPrototypePropertyKey(key: string): boolean {
  if (!key) return false;
  return key in Object.prototype || key.toLowerCase() in Object.prototype;
}

function safeChannelRecordLookup(
  dict: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  if (!key || !Object.hasOwn(dict, key)) {
    return undefined;
  }
  const value = dict[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 统一将报告渠道名按语言环境本地化（同时供 HTML 导出与公开分享 DTO 使用）：
 * - 非中文（en-US 等）：无论 provider 是否为 null，均保证输出零 CJK 字符；
 * - zh-CN：已知 provider 优先输出中文渠道名（如 SHOPIFY -> Shopify 博客）；
 * - 显式防御 Object.prototype 原型键（如 constructor / toString / __proto__ / valueOf），
 *   避免下游字典索引返回函数或原型对象。
 */
export function localizeRoiReportChannelLabel(
  channel: string,
  provider: ChannelProvider | null | undefined,
  locale: SupportedLocale | 'zh' | 'en',
): string {
  const trimmed = typeof channel === 'string' ? channel.trim() : '';
  const isZh = locale === 'zh-CN' || locale === 'zh';
  const validProvider =
    typeof provider === 'string' && Object.hasOwn(CHANNEL_PROVIDER_LABELS, provider)
      ? (provider as ChannelProvider)
      : null;
  const protoKey = isPrototypePropertyKey(trimmed);

  if (!isZh) {
    let candidate = trimmed;
    if (validProvider && !protoKey) {
      const localized = localizePublicChannelLabel(trimmed, 'GLOBAL', validProvider);
      if (typeof localized === 'string') {
        candidate = localized.trim();
      }
    }
    if (!candidate) {
      return (
        (validProvider
          ? safeChannelRecordLookup(CHANNEL_PROVIDER_EN_LABELS, validProvider)
          : undefined) ?? 'External Channel'
      );
    }
    if (!validProvider || CJK_CHAR_RE.test(candidate)) {
      const manualEn = safeChannelRecordLookup(MANUAL_ZH_CHANNEL_TO_EN, candidate);
      if (manualEn) {
        return manualEn;
      }
      const providerEn = safeChannelRecordLookup(PROVIDER_ZH_TO_EN_LABELS, candidate);
      if (providerEn) {
        return providerEn;
      }
      if (CJK_CHAR_RE.test(candidate)) {
        return 'External Channel';
      }
    }
    return candidate;
  }

  if (validProvider) {
    if (!protoKey) {
      const localized = localizePublicChannelLabel(trimmed, 'CN', validProvider);
      if (typeof localized === 'string' && localized.trim().length > 0 && localized !== trimmed) {
        return localized;
      }
    }
    if (!trimmed || !CJK_CHAR_RE.test(trimmed)) {
      return (
        safeChannelRecordLookup(CHANNEL_PROVIDER_LABELS, validProvider) ?? (trimmed || '外部渠道')
      );
    }
    return trimmed;
  }
  return trimmed || '外部渠道';
}

/**
 * 将生产快照中固定为 0..100 百分比标度的提及率（visibilityPct）确定性转换为 [0, 1] 比例（四位小数）。
 * 严禁使用 `> 1` 阈值猜测，确保 1%（1）恒为 0.01、0.5%（0.5）恒为 0.005。
 */
export function normalizePercentToRate01(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return round4(clamp01(raw / 100));
}

export type RoiReportObservationInput = {
  id: string;
  runId?: string;
  engine: string;
  promptText: string;
  status?: string;
  collectorKind?: string | null;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  checkedAt?: Date | null;
  createdAt: Date;
  citations: ReadonlyArray<{
    url: string;
    domain: string;
    sourceKind?: string | null;
    position?: number;
  }>;
};

export type RoiReportRetrievedSourceInput = {
  id: string;
  observationId: string;
  url: string;
  wasOpened: boolean;
  wasCited: boolean;
  observation?: { status?: string } | null;
};

export type RoiReportBoostBriefInput = {
  id: string;
  sourceCitationUrl: string | null;
  targetPrompt: string | null;
  createdAt: Date;
  articles?: ReadonlyArray<{
    id: string;
    publishRecords?: ReadonlyArray<{
      id: string;
      publishedUrl: string;
      afterMetrics?: Prisma.JsonValue | null;
      retestSchedules?: ReadonlyArray<{
        metricsSnapshotJson?: Prisma.JsonValue | null;
      }>;
    }>;
  }>;
};

export type RoiReportPublishRecordInput = {
  id: string;
  articleId: string;
  channel: string;
  publishedUrl: string;
  publishedAt: Date;
  crawlStatus?: string | null;
  crawlCheckedAt?: Date | null;
  indexNowSubmitted?: boolean | null;
  beforeMetrics?: Prisma.JsonValue | null;
  afterMetrics?: Prisma.JsonValue | null;
  distributionTask?: {
    id?: string;
    provider?: string | null;
    mode?: string | null;
    indexNowStatus?: string | null;
  } | null;
  retestSchedules?: ReadonlyArray<{
    id?: string;
    milestoneDay: number;
    status?: string;
    metricsSnapshotJson?: Prisma.JsonValue | null;
    controlMetricsJson?: Prisma.JsonValue | null;
    executedAt?: Date | null;
  }>;
};

export type RoiReportCompletedScheduleInput = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  status?: string;
  metricsSnapshotJson?: Prisma.JsonValue | null;
  controlMetricsJson?: Prisma.JsonValue | null;
  executedAt?: Date | null;
  publishRecord?: {
    id: string;
    channel: string;
    publishedUrl: string;
    crawlStatus?: string | null;
    beforeMetrics?: Prisma.JsonValue | null;
    afterMetrics?: Prisma.JsonValue | null;
    distributionTask?: {
      provider?: string | null;
      mode?: string | null;
    } | null;
  } | null;
};

export type RoiReportPointLogInput = {
  action: string;
  unitKey?: string | null;
  delta: number;
  listPrice: number;
  detail?: Prisma.JsonValue | null;
  reservationId?: string | null;
};

export type RoiReportAttributionScope = {
  brandId: string;
  brandMarketId: string;
  reservationIds?: ReadonlySet<string>;
  runIds?: ReadonlySet<string>;
  observationIds?: ReadonlySet<string>;
  articleIds?: ReadonlySet<string>;
  taskIds?: ReadonlySet<string>;
};

export type BuildGeoRoiReportSummaryInput = {
  brandMarket: {
    localBrandName: string;
    aliases: readonly string[];
    ownedDomains: readonly string[];
    competitors: unknown;
  };
  allBrandOwnedDomains?: readonly string[];
  observations: readonly RoiReportObservationInput[];
  uncitedRetrievedSources: readonly RoiReportRetrievedSourceInput[];
  nearMissBoostBriefs: readonly RoiReportBoostBriefInput[];
  periodPublishRecords: readonly RoiReportPublishRecordInput[];
  periodCompletedSchedules: readonly RoiReportCompletedScheduleInput[];
  pointLogs: readonly RoiReportPointLogInput[];
  attributionScope?: RoiReportAttributionScope;
};

function parseProvider(raw: string | null | undefined): ChannelProvider | null {
  if (typeof raw !== 'string') return null;
  return CHANNEL_PROVIDER_SET.has(raw) ? (raw as ChannelProvider) : null;
}

function parseDistributionMode(
  rawMode: string | null | undefined,
  provider: ChannelProvider | null,
): DistributionMode | null {
  if (typeof rawMode === 'string' && DISTRIBUTION_MODE_SET.has(rawMode)) {
    return rawMode as DistributionMode;
  }
  if (provider) {
    return defaultDistributionModeForProvider(provider);
  }
  return null;
}

function isIndexNowSuccessStatus(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const upper = raw.trim().toUpperCase();
  return (
    upper === 'OK' ||
    upper === 'SUCCESS' ||
    upper === 'SUBMITTED' ||
    upper === '200' ||
    upper === '202'
  );
}

function isIndexNowSkippedStatus(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const upper = raw.trim().toUpperCase();
  return upper === 'SKIPPED' || upper.startsWith('SKIPPED:');
}

function extractNormalizedSnapshotMentionRate01(
  snap: NonNullable<ReturnType<typeof normalizeGeoRetestMetricsSnapshot>>,
): number {
  if (snap.sampleCount !== undefined && snap.hitCount !== undefined && snap.sampleCount > 0) {
    return round4(clamp01(snap.hitCount / snap.sampleCount));
  }
  if (snap.wilson && snap.wilson.trials > 0) {
    return round4(clamp01(snap.wilson.rate));
  }
  return normalizePercentToRate01(snap.mentionRate);
}

function extractSnapshotMentionRate01(raw: Prisma.JsonValue | null | undefined): number | null {
  const snap = normalizeGeoRetestMetricsSnapshot(raw);
  if (!snap) return null;
  return extractNormalizedSnapshotMentionRate01(snap);
}

function extractControlRate01(
  ctrl: NonNullable<ReturnType<typeof normalizeGeoRetestControlMetricsSnapshot>>,
): number {
  if (ctrl.sampleCount > 0) {
    return round4(clamp01(ctrl.hitCount / ctrl.sampleCount));
  }
  if (ctrl.wilson && ctrl.wilson.trials > 0) {
    return round4(clamp01(ctrl.wilson.rate));
  }
  return normalizePercentToRate01(ctrl.currentMentionRate);
}

type DidSampleEntry = {
  weight: number;
  treatmentBaseline?: number;
  treatmentCurrent?: number;
  controlBaseline?: number;
  controlCurrent?: number;
  precomputed?: DifferenceInDifferencesResult;
};

function aggregateDidEntries(
  entries: readonly DidSampleEntry[],
): DifferenceInDifferencesResult | null {
  if (entries.length === 0) return null;

  const withRawRates = entries.filter(
    (
      e,
    ): e is DidSampleEntry & {
      treatmentBaseline: number;
      treatmentCurrent: number;
      controlBaseline: number;
      controlCurrent: number;
    } =>
      e.treatmentBaseline !== undefined &&
      e.treatmentCurrent !== undefined &&
      e.controlBaseline !== undefined &&
      e.controlCurrent !== undefined,
  );

  if (withRawRates.length > 0) {
    let totalWeight = 0;
    let sumTBase = 0;
    let sumTCurr = 0;
    let sumCBase = 0;
    let sumCCurr = 0;

    for (const entry of withRawRates) {
      const w = entry.weight > 0 ? entry.weight : 1;
      totalWeight += w;
      sumTBase += entry.treatmentBaseline * w;
      sumTCurr += entry.treatmentCurrent * w;
      sumCBase += entry.controlBaseline * w;
      sumCCurr += entry.controlCurrent * w;
    }

    return computeDifferenceInDifferences({
      treatmentBaseline: sumTBase / totalWeight,
      treatmentCurrent: sumTCurr / totalWeight,
      controlBaseline: sumCBase / totalWeight,
      controlCurrent: sumCCurr / totalWeight,
    });
  }

  const withPrecomputed = entries.filter(
    (e): e is DidSampleEntry & { precomputed: DifferenceInDifferencesResult } =>
      e.precomputed !== undefined,
  );
  if (withPrecomputed.length === 0) return null;

  let totalWeight = 0;
  let sumTDelta = 0;
  let sumCDelta = 0;
  let sumNetLift = 0;
  for (const entry of withPrecomputed) {
    const w = entry.weight > 0 ? entry.weight : 1;
    totalWeight += w;
    sumTDelta += entry.precomputed.treatmentDelta * w;
    sumCDelta += entry.precomputed.controlDelta * w;
    sumNetLift += entry.precomputed.netLift * w;
  }

  const treatmentDelta = round4(sumTDelta / totalWeight);
  const controlDelta = round4(sumCDelta / totalWeight);
  const netLift = round4(sumNetLift / totalWeight);
  const direction: DifferenceInDifferencesResult['direction'] =
    netLift > 1e-6 ? 'POSITIVE' : netLift < -1e-6 ? 'NEGATIVE' : 'NEUTRAL';

  return {
    treatmentDelta,
    controlDelta,
    netLift,
    direction,
  };
}

function pointLogMatchesScope(
  log: RoiReportPointLogInput,
  scope: RoiReportAttributionScope | undefined,
): boolean {
  if (!scope) return true;

  const reservationIds = scope.reservationIds ?? new Set<string>();
  const runIds = scope.runIds ?? new Set<string>();
  const observationIds = scope.observationIds ?? new Set<string>();
  const articleIds = scope.articleIds ?? new Set<string>();
  const taskIds = scope.taskIds ?? new Set<string>();

  if (log.reservationId && reservationIds.has(log.reservationId)) {
    return true;
  }

  let hasExplicitEntityRef = Boolean(log.reservationId);

  const detail =
    log.detail && typeof log.detail === 'object' && !Array.isArray(log.detail)
      ? (log.detail as Record<string, unknown>)
      : null;

  if (detail) {
    const detailBrandMarketId =
      typeof detail.brandMarketId === 'string' ? detail.brandMarketId.trim() : '';
    const detailBrandId = typeof detail.brandId === 'string' ? detail.brandId.trim() : '';
    const detailRunId = typeof detail.runId === 'string' ? detail.runId.trim() : '';
    const detailObsId = typeof detail.observationId === 'string' ? detail.observationId.trim() : '';
    const detailArticleId = typeof detail.articleId === 'string' ? detail.articleId.trim() : '';
    const detailTaskId = typeof detail.taskId === 'string' ? detail.taskId.trim() : '';

    if (detailBrandMarketId) {
      hasExplicitEntityRef = true;
      if (detailBrandMarketId === scope.brandMarketId) return true;
      return false;
    }
    if (detailBrandId) {
      hasExplicitEntityRef = true;
      if (detailBrandId !== scope.brandId) return false;
      return true;
    }
    if (detailRunId) {
      hasExplicitEntityRef = true;
      if (runIds.has(detailRunId)) return true;
    }
    if (detailObsId) {
      hasExplicitEntityRef = true;
      if (observationIds.has(detailObsId)) return true;
    }
    if (detailArticleId) {
      hasExplicitEntityRef = true;
      if (articleIds.has(detailArticleId)) return true;
    }
    if (detailTaskId) {
      hasExplicitEntityRef = true;
      if (taskIds.has(detailTaskId)) return true;
    }
  }

  const unitKey = typeof log.unitKey === 'string' ? log.unitKey.trim() : '';
  if (unitKey.startsWith('geo_article:')) {
    hasExplicitEntityRef = true;
    const id = unitKey.slice('geo_article:'.length).split(':')[0] ?? '';
    if (articleIds.has(id)) return true;
  } else if (unitKey.startsWith('visibility_obs:')) {
    hasExplicitEntityRef = true;
    const id = unitKey.slice('visibility_obs:'.length).split(':')[0] ?? '';
    if (observationIds.has(id)) return true;
  } else if (unitKey.startsWith('geo_dist_task:')) {
    hasExplicitEntityRef = true;
    const id = unitKey.slice('geo_dist_task:'.length).split(':')[0] ?? '';
    if (taskIds.has(id)) return true;
  }

  return !hasExplicitEntityRef;
}

/**
 * 聚合构建月度 GEO ROI 不可变快照（GeoRoiReportSummaryDto）。
 * 所有比率严格统一在 [0, 1] 标度，所有置信区间使用 Wilson 95% CI，零 NaN / Infinity。
 */
export function buildGeoRoiReportSummary(
  input: BuildGeoRoiReportSummaryInput,
): GeoRoiReportSummaryDto {
  const ownedDomainSet = new Set<string>();
  for (const raw of [...(input.allBrandOwnedDomains ?? []), ...input.brandMarket.ownedDomains]) {
    const normalized = normalizeVisibilityDomain(raw);
    if (normalized) ownedDomainSet.add(normalized);
  }
  const ownedDomains = [...ownedDomainSet];

  const competitors = parseProfileCompetitors(input.brandMarket.competitors);
  const competitorNames = competitors.map((c) => c.name);
  const competitorDomains = competitors.flatMap((c) => c.domains);

  const observations = input.observations.filter(
    (obs) =>
      (obs.status === undefined || obs.status === 'SUCCESS') &&
      !isRetiredVisibilityEngine(obs.engine.trim()),
  );

  // ==================== 1. Overview & 2. By Engine ====================
  type EngineBucket = {
    engine: string;
    observations: number;
    mentionHits: number;
    citationHits: number;
    ownedCitationHits: number;
    positions: number[];
  };
  const engineBuckets = new Map<string, EngineBucket>();

  // For Near-Miss Tier 3B & Boost conversion lookup
  type PromptAgg = {
    mentioned: boolean;
    ownedCitations: number;
    nonOwnedCitations: number;
  };
  const promptAggMap = new Map<string, PromptAgg>();

  const citedUrlLatestTime = new Map<string, number>();
  const ownedCitedPromptLatestTime = new Map<string, number>();

  let mentionHits = 0;
  let citationHits = 0;
  let ownedCitationHits = 0;
  let simulatedObservations = 0;

  for (const obs of observations) {
    if (
      isSimulatedCollectorKind(obs.collectorKind) ||
      Boolean(obs.answerText?.trimStart().startsWith(FAKE_MARK))
    ) {
      simulatedObservations += 1;
    }
    const effectiveMention = isEffectiveBrandMention(obs, {
      brandName: input.brandMarket.localBrandName,
      brandAliases: input.brandMarket.aliases,
      competitorNames,
    });
    const citations = Array.isArray(obs.citations) ? obs.citations : [];
    const hasCitation = citations.length > 0;

    let obsOwnedCount = 0;
    let obsNonOwnedCount = 0;
    const obsTimeMs = (obs.checkedAt ?? obs.createdAt).getTime();

    for (const cite of citations) {
      const kind = classifyCitationSource(cite.url || cite.domain, {
        ownedDomains,
        competitorDomains,
      });
      if (kind === 'OWNED') {
        obsOwnedCount += 1;
      } else {
        obsNonOwnedCount += 1;
      }
      const canonical = canonicalizeNearMissUrl(cite.url);
      if (canonical) {
        const prev = citedUrlLatestTime.get(canonical) ?? -Infinity;
        if (obsTimeMs > prev) citedUrlLatestTime.set(canonical, obsTimeMs);
      }
    }

    const hasOwnedCitation = obsOwnedCount > 0;

    if (effectiveMention) mentionHits += 1;
    if (hasCitation) citationHits += 1;
    if (hasOwnedCitation) ownedCitationHits += 1;

    const promptKey = normalizePromptKey(obs.promptText);
    if (promptKey) {
      const agg = promptAggMap.get(promptKey) ?? {
        mentioned: false,
        ownedCitations: 0,
        nonOwnedCitations: 0,
      };
      if (effectiveMention) agg.mentioned = true;
      agg.ownedCitations += obsOwnedCount;
      agg.nonOwnedCitations += obsNonOwnedCount;
      promptAggMap.set(promptKey, agg);

      if (hasOwnedCitation) {
        const prev = ownedCitedPromptLatestTime.get(promptKey) ?? -Infinity;
        if (obsTimeMs > prev) ownedCitedPromptLatestTime.set(promptKey, obsTimeMs);
      }
    }

    const engineKey = obs.engine.trim();
    if (engineKey) {
      let bucket = engineBuckets.get(engineKey);
      if (!bucket) {
        bucket = {
          engine: engineKey,
          observations: 0,
          mentionHits: 0,
          citationHits: 0,
          ownedCitationHits: 0,
          positions: [],
        };
        engineBuckets.set(engineKey, bucket);
      }
      bucket.observations += 1;
      if (effectiveMention) {
        bucket.mentionHits += 1;
        if (
          typeof obs.brandPosition === 'number' &&
          Number.isFinite(obs.brandPosition) &&
          obs.brandPosition >= 1
        ) {
          bucket.positions.push(obs.brandPosition);
        }
      }
      if (hasCitation) bucket.citationHits += 1;
      if (hasOwnedCitation) bucket.ownedCitationHits += 1;
    }
  }

  const totalObservations = observations.length;
  const mentionWilson = computeWilsonInterval(mentionHits, totalObservations);
  const mentionRate = mentionWilson.rate;
  const citationRate = totalObservations > 0 ? round4(citationHits / totalObservations) : 0;
  const ownedCitationRate =
    totalObservations > 0 ? round4(ownedCitationHits / totalObservations) : 0;

  const byEngine: GeoRoiReportEngineMetric[] = [...engineBuckets.values()]
    .map((bucket) => {
      const wilson = computeWilsonInterval(bucket.mentionHits, bucket.observations);
      const avgPosition =
        bucket.positions.length > 0
          ? round2(bucket.positions.reduce((acc, v) => acc + v, 0) / bucket.positions.length)
          : null;
      return {
        engine: bucket.engine,
        observations: bucket.observations,
        mentionRate: wilson.rate,
        citationRate: round4(bucket.citationHits / bucket.observations),
        ownedCitationRate: round4(bucket.ownedCitationHits / bucket.observations),
        avgPosition,
        mentionWilson: wilson,
      };
    })
    .sort(
      (a, b) =>
        b.observations - a.observations ||
        b.mentionRate - a.mentionRate ||
        a.engine.localeCompare(b.engine),
    );

  // ==================== 3. Funnel ====================
  let l1Count = 0;
  let l2Count = 0;
  let l3Count = 0;
  let crawlCheckedCount = 0;
  let crawlOkCount = 0;
  let indexNowAttemptedCount = 0;
  let indexNowSuccessCount = 0;

  for (const record of input.periodPublishRecords) {
    const provider = parseProvider(record.distributionTask?.provider);
    const mode =
      parseDistributionMode(record.distributionTask?.mode, provider) ?? 'L3_COMMUNITY_ASSIST';

    if (mode === 'L1_API') {
      l1Count += 1;
    } else if (mode === 'L2_EXTENSION') {
      l2Count += 1;
    } else {
      l3Count += 1;
    }

    const crawlStatus = (record.crawlStatus ?? 'PENDING').toUpperCase();
    if (crawlStatus !== 'PENDING' || record.crawlCheckedAt != null) {
      crawlCheckedCount += 1;
      if (crawlStatus === 'OK') {
        crawlOkCount += 1;
      }
    }

    const indexNowStatus = record.distributionTask?.indexNowStatus;
    const indexNowAttempted =
      Boolean(record.indexNowSubmitted) ||
      (typeof indexNowStatus === 'string' &&
        indexNowStatus.trim().length > 0 &&
        !isIndexNowSkippedStatus(indexNowStatus));
    if (indexNowAttempted) {
      indexNowAttemptedCount += 1;
      if (Boolean(record.indexNowSubmitted) || isIndexNowSuccessStatus(indexNowStatus)) {
        indexNowSuccessCount += 1;
      }
    }
  }

  const funnel: GeoRoiReportFunnelSummary = {
    publishedTotal: input.periodPublishRecords.length,
    l1Count,
    l2Count,
    l3Count,
    crawlCheckedCount,
    crawlOkCount,
    crawlOkRate: crawlCheckedCount > 0 ? round4(crawlOkCount / crawlCheckedCount) : null,
    indexNowAttemptedCount,
    indexNowSuccessCount,
    indexNowRate:
      indexNowAttemptedCount > 0 ? round4(indexNowSuccessCount / indexNowAttemptedCount) : null,
  };

  // ==================== 4. Channel Ranking ====================
  type RecordAttributionState = {
    publishRecordId: string;
    channel: string;
    provider: ChannelProvider | null;
    mode: DistributionMode | null;
    publishedInPeriod: boolean;
    publishedUrl: string;
    crawlStatus: string;
    beforeMetricsRaw: Prisma.JsonValue | null;
    afterMetricsRaw: Prisma.JsonValue | null;
    completedSnapshots: Array<{
      executedAtMs: number;
      milestoneDay: number;
      snap: NonNullable<ReturnType<typeof normalizeGeoRetestMetricsSnapshot>>;
    }>;
  };

  const recordStates = new Map<string, RecordAttributionState>();

  for (const rec of input.periodPublishRecords) {
    const provider = parseProvider(rec.distributionTask?.provider);
    const mode = parseDistributionMode(rec.distributionTask?.mode, provider);
    const state: RecordAttributionState = {
      publishRecordId: rec.id,
      channel: rec.channel.trim() || 'Unknown',
      provider,
      mode,
      publishedInPeriod: true,
      publishedUrl: rec.publishedUrl,
      crawlStatus: (rec.crawlStatus ?? 'PENDING').toUpperCase(),
      beforeMetricsRaw: rec.beforeMetrics ?? null,
      afterMetricsRaw: rec.afterMetrics ?? null,
      completedSnapshots: [],
    };
    for (const sched of rec.retestSchedules ?? []) {
      if (sched.status !== undefined && sched.status !== 'COMPLETED') continue;
      const snap = normalizeGeoRetestMetricsSnapshot(sched.metricsSnapshotJson);
      if (snap) {
        state.completedSnapshots.push({
          executedAtMs: sched.executedAt ? sched.executedAt.getTime() : 0,
          milestoneDay: sched.milestoneDay,
          snap,
        });
      }
    }
    recordStates.set(rec.id, state);
  }

  for (const sched of input.periodCompletedSchedules) {
    if (sched.status !== undefined && sched.status !== 'COMPLETED') continue;
    const pub = sched.publishRecord;
    if (!pub) continue;

    let state = recordStates.get(pub.id);
    if (!state) {
      const provider = parseProvider(pub.distributionTask?.provider);
      const mode = parseDistributionMode(pub.distributionTask?.mode, provider);
      state = {
        publishRecordId: pub.id,
        channel: pub.channel.trim() || 'Unknown',
        provider,
        mode,
        publishedInPeriod: false,
        publishedUrl: pub.publishedUrl,
        crawlStatus: (pub.crawlStatus ?? 'PENDING').toUpperCase(),
        beforeMetricsRaw: pub.beforeMetrics ?? null,
        afterMetricsRaw: pub.afterMetrics ?? null,
        completedSnapshots: [],
      };
      recordStates.set(pub.id, state);
    }

    const snap = normalizeGeoRetestMetricsSnapshot(sched.metricsSnapshotJson);
    if (snap) {
      state.completedSnapshots.push({
        executedAtMs: sched.executedAt ? sched.executedAt.getTime() : 0,
        milestoneDay: sched.milestoneDay,
        snap,
      });
    }
  }

  type ChannelBucket = {
    channel: string;
    provider: ChannelProvider | null;
    mode: DistributionMode | null;
    publishedCount: number;
    completedRetestCount: number;
    citationHitCount: number;
    mentionDeltas: number[];
  };
  const channelBuckets = new Map<string, ChannelBucket>();

  // Track Tier 3A CRAWLED_NOT_CITED unique keys at the same time
  const tier3aKeys = new Set<string>();

  for (const state of recordStates.values()) {
    let bucket = channelBuckets.get(state.channel);
    if (!bucket) {
      bucket = {
        channel: state.channel,
        provider: state.provider,
        mode: state.mode,
        publishedCount: 0,
        completedRetestCount: 0,
        citationHitCount: 0,
        mentionDeltas: [],
      };
      channelBuckets.set(state.channel, bucket);
    }
    if (!bucket.provider && state.provider) bucket.provider = state.provider;
    if (!bucket.mode && state.mode) bucket.mode = state.mode;
    if (state.publishedInPeriod) {
      bucket.publishedCount += 1;
    }

    state.completedSnapshots.sort(
      (a, b) => b.executedAtMs - a.executedAtMs || b.milestoneDay - a.milestoneDay,
    );

    const latestSnap = state.completedSnapshots[0]?.snap ?? null;
    const afterSnap = latestSnap ?? normalizeRetestMetricSnapshot(state.afterMetricsRaw);

    const anyCitationHit =
      state.completedSnapshots.some((item) => item.snap.citationHit) ||
      Boolean(afterSnap?.citationHit);

    if (state.crawlStatus === 'OK' && state.completedSnapshots.length > 0 && !anyCitationHit) {
      const key = canonicalizeNearMissUrl(state.publishedUrl) || `publish:${state.publishRecordId}`;
      tier3aKeys.add(key);
    }

    if (!afterSnap) continue;

    bucket.completedRetestCount += 1;
    if (anyCitationHit) {
      bucket.citationHitCount += 1;
    }

    const beforeSnap = normalizeRetestMetricSnapshot(state.beforeMetricsRaw);
    if (
      beforeSnap &&
      Number.isFinite(beforeSnap.mentionRate) &&
      Number.isFinite(afterSnap.mentionRate)
    ) {
      const before01 = normalizePercentToRate01(beforeSnap.mentionRate);
      const after01 = latestSnap
        ? extractNormalizedSnapshotMentionRate01(latestSnap)
        : normalizePercentToRate01(afterSnap.mentionRate);
      bucket.mentionDeltas.push(after01 - before01);
    }
  }

  const channelRanking: GeoRoiReportChannelRank[] = [...channelBuckets.values()]
    .map((bucket) => {
      const citationHitRate =
        bucket.completedRetestCount > 0
          ? round4(bucket.citationHitCount / bucket.completedRetestCount)
          : null;
      const citationHitWilson =
        bucket.completedRetestCount > 0
          ? computeWilsonInterval(bucket.citationHitCount, bucket.completedRetestCount)
          : null;
      const avgMentionRateDelta =
        bucket.mentionDeltas.length > 0
          ? round4(
              bucket.mentionDeltas.reduce((acc, v) => acc + v, 0) / bucket.mentionDeltas.length,
            )
          : null;

      return {
        channel: bucket.channel,
        provider: bucket.provider,
        mode: bucket.mode,
        publishedCount: bucket.publishedCount,
        completedRetestCount: bucket.completedRetestCount,
        citationHitCount: bucket.citationHitCount,
        citationHitRate,
        citationHitWilson,
        avgMentionRateDelta,
      };
    })
    .sort((a, b) => {
      if (a.citationHitRate !== null && b.citationHitRate === null) return -1;
      if (a.citationHitRate === null && b.citationHitRate !== null) return 1;
      if (
        a.citationHitRate !== null &&
        b.citationHitRate !== null &&
        b.citationHitRate !== a.citationHitRate
      ) {
        return b.citationHitRate - a.citationHitRate;
      }
      if (b.citationHitCount !== a.citationHitCount) return b.citationHitCount - a.citationHitCount;
      if (b.publishedCount !== a.publishedCount) return b.publishedCount - a.publishedCount;
      return a.channel.localeCompare(b.channel);
    });

  // ==================== 5. Near-Miss 4-Tier & Boost Conversion ====================
  const retrievedUrlOpened = new Map<string, boolean>();
  for (const row of input.uncitedRetrievedSources) {
    if (row.wasCited) continue;
    if (row.observation?.status && row.observation.status !== 'SUCCESS') continue;
    const key = canonicalizeNearMissUrl(row.url);
    if (!key) continue;
    const prev = retrievedUrlOpened.get(key) ?? false;
    retrievedUrlOpened.set(key, prev || Boolean(row.wasOpened));
  }

  let openedNotCitedCount = 0;
  let retrievedNotCitedCount = 0;
  for (const wasOpened of retrievedUrlOpened.values()) {
    if (wasOpened) {
      openedNotCitedCount += 1;
    } else {
      retrievedNotCitedCount += 1;
    }
  }

  let mentionedNotOwnedCount = 0;
  for (const agg of promptAggMap.values()) {
    if (agg.mentioned && agg.ownedCitations === 0 && agg.nonOwnedCitations > 0) {
      mentionedNotOwnedCount += 1;
    }
  }

  const tierCounts: Record<NearMissTier, number> = {
    OPENED_NOT_CITED: openedNotCitedCount,
    RETRIEVED_NOT_CITED: retrievedNotCitedCount,
    CRAWLED_NOT_CITED: tier3aKeys.size,
    MENTIONED_NOT_OWNED: mentionedNotOwnedCount,
  };

  let convertedToCited = 0;
  for (const brief of input.nearMissBoostBriefs) {
    let converted = false;

    for (const article of brief.articles ?? []) {
      for (const pub of article.publishRecords ?? []) {
        const afterSnap = normalizeRetestMetricSnapshot(pub.afterMetrics);
        if (afterSnap?.citationHit) {
          converted = true;
          break;
        }
        for (const sched of pub.retestSchedules ?? []) {
          const snap = normalizeGeoRetestMetricsSnapshot(sched.metricsSnapshotJson);
          if (snap?.citationHit) {
            converted = true;
            break;
          }
        }
        if (converted) break;
      }
      if (converted) break;
    }

    if (!converted) {
      const briefTimeMs = brief.createdAt.getTime();
      const sourceCanonical = brief.sourceCitationUrl
        ? canonicalizeNearMissUrl(brief.sourceCitationUrl)
        : '';
      if (sourceCanonical) {
        const latestCiteMs = citedUrlLatestTime.get(sourceCanonical);
        if (latestCiteMs !== undefined && latestCiteMs >= briefTimeMs) {
          converted = true;
        }
      }
      if (!converted && brief.targetPrompt) {
        const promptKey = normalizePromptKey(brief.targetPrompt);
        const latestOwnedMs = ownedCitedPromptLatestTime.get(promptKey);
        if (latestOwnedMs !== undefined && latestOwnedMs >= briefTimeMs) {
          converted = true;
        }
      }
    }

    if (converted) {
      convertedToCited += 1;
    }
  }

  const nearMiss: GeoRoiReportNearMissSummary = {
    totalOpportunities:
      tierCounts.OPENED_NOT_CITED +
      tierCounts.RETRIEVED_NOT_CITED +
      tierCounts.CRAWLED_NOT_CITED +
      tierCounts.MENTIONED_NOT_OWNED,
    boostBriefsCreated: input.nearMissBoostBriefs.length,
    convertedToCited,
    tierCounts,
  };

  // ==================== 6. Milestone Trend & Overview DiD ====================
  const allDidEntries: DidSampleEntry[] = [];

  type MilestoneBucket = {
    milestoneDay: number;
    trials: number;
    hits: number;
    controlTrials: number;
    controlHits: number;
    controlRateSum: number;
    controlRateWeight: number;
    didEntries: DidSampleEntry[];
  };
  const milestoneBuckets = new Map<number, MilestoneBucket>();

  // Track T+0 baseline across unique publish records that have beforeMetrics
  const baselineRatesByRecord = new Map<string, number>();
  const baselineControlRates: number[] = [];

  for (const state of recordStates.values()) {
    const before = normalizeRetestMetricSnapshot(state.beforeMetricsRaw);
    if (before && Number.isFinite(before.mentionRate)) {
      baselineRatesByRecord.set(
        state.publishRecordId,
        normalizePercentToRate01(before.mentionRate),
      );
    }
  }

  for (const sched of input.periodCompletedSchedules) {
    if (sched.status !== undefined && sched.status !== 'COMPLETED') continue;
    const snap = normalizeGeoRetestMetricsSnapshot(sched.metricsSnapshotJson);
    if (!snap) continue;

    let mBucket = milestoneBuckets.get(sched.milestoneDay);
    if (!mBucket) {
      mBucket = {
        milestoneDay: sched.milestoneDay,
        trials: 0,
        hits: 0,
        controlTrials: 0,
        controlHits: 0,
        controlRateSum: 0,
        controlRateWeight: 0,
        didEntries: [],
      };
      milestoneBuckets.set(sched.milestoneDay, mBucket);
    }

    const trials = snap.sampleCount !== undefined && snap.sampleCount > 0 ? snap.sampleCount : 1;
    const currentRate01 = extractSnapshotMentionRate01(sched.metricsSnapshotJson) ?? 0;
    const hits =
      snap.hitCount !== undefined && snap.sampleCount !== undefined && snap.sampleCount > 0
        ? Math.min(trials, snap.hitCount)
        : Math.round(currentRate01 * trials);

    mBucket.trials += trials;
    mBucket.hits += hits;

    const beforeSnap = normalizeRetestMetricSnapshot(sched.publishRecord?.beforeMetrics);
    if (beforeSnap && Number.isFinite(beforeSnap.mentionRate) && sched.publishRecord) {
      if (!baselineRatesByRecord.has(sched.publishRecord.id)) {
        baselineRatesByRecord.set(
          sched.publishRecord.id,
          normalizePercentToRate01(beforeSnap.mentionRate),
        );
      }
    }

    const ctrl = normalizeGeoRetestControlMetricsSnapshot(sched.controlMetricsJson);
    if (ctrl) {
      const ctrlRate01 = extractControlRate01(ctrl);
      const ctrlWeight = ctrl.sampleCount > 0 ? ctrl.sampleCount : 1;
      if (ctrl.sampleCount > 0) {
        mBucket.controlTrials += ctrl.sampleCount;
        mBucket.controlHits += Math.min(ctrl.sampleCount, ctrl.hitCount);
      }
      mBucket.controlRateSum += ctrlRate01 * ctrlWeight;
      mBucket.controlRateWeight += ctrlWeight;

      if (ctrl.baselineMentionRate !== null && Number.isFinite(ctrl.baselineMentionRate)) {
        const ctrlBase01 = normalizePercentToRate01(ctrl.baselineMentionRate);
        baselineControlRates.push(ctrlBase01);

        if (beforeSnap && Number.isFinite(beforeSnap.mentionRate)) {
          const tBase01 = normalizePercentToRate01(beforeSnap.mentionRate);
          const tCurr01 = currentRate01;
          const didEntry: DidSampleEntry = {
            weight: trials,
            treatmentBaseline: tBase01,
            treatmentCurrent: tCurr01,
            controlBaseline: ctrlBase01,
            controlCurrent: ctrlRate01,
            ...(ctrl.did ? { precomputed: ctrl.did } : {}),
          };
          mBucket.didEntries.push(didEntry);
          allDidEntries.push(didEntry);
        } else if (ctrl.did) {
          const didEntry: DidSampleEntry = { weight: trials, precomputed: ctrl.did };
          mBucket.didEntries.push(didEntry);
          allDidEntries.push(didEntry);
        }
      } else if (ctrl.did) {
        const didEntry: DidSampleEntry = { weight: trials, precomputed: ctrl.did };
        mBucket.didEntries.push(didEntry);
        allDidEntries.push(didEntry);
      }
    }
  }

  const milestoneTrend: GeoRoiReportMilestonePoint[] = [];

  if (baselineRatesByRecord.size > 0) {
    const rates = [...baselineRatesByRecord.values()];
    const trials = rates.length;
    const avgRate = rates.reduce((acc, r) => acc + r, 0) / trials;
    const hits = Math.min(trials, Math.max(0, Math.round(avgRate * trials)));
    const wilson = computeWilsonInterval(hits, trials);
    const baselineControlMentionRate =
      baselineControlRates.length > 0
        ? round4(baselineControlRates.reduce((acc, r) => acc + r, 0) / baselineControlRates.length)
        : null;

    milestoneTrend.push({
      milestoneDay: 0,
      trials,
      hits,
      mentionRate: round4(avgRate),
      wilson,
      controlMentionRate: baselineControlMentionRate,
      did: null,
    });
  }

  const sortedMilestones = [...milestoneBuckets.values()].sort(
    (a, b) => a.milestoneDay - b.milestoneDay,
  );
  for (const mBucket of sortedMilestones) {
    const wilson = computeWilsonInterval(mBucket.hits, mBucket.trials);
    const controlMentionRate =
      mBucket.controlTrials > 0
        ? round4(clamp01(mBucket.controlHits / mBucket.controlTrials))
        : mBucket.controlRateWeight > 0
          ? round4(clamp01(mBucket.controlRateSum / mBucket.controlRateWeight))
          : null;
    const did = aggregateDidEntries(mBucket.didEntries);

    milestoneTrend.push({
      milestoneDay: mBucket.milestoneDay,
      trials: mBucket.trials,
      hits: mBucket.hits,
      mentionRate: wilson.rate,
      wilson,
      controlMentionRate,
      did,
    });
  }

  const overviewDid = aggregateDidEntries(allDidEntries);

  // ==================== 7. Points ROI ====================
  let totalPointsSpent = 0;
  for (const log of input.pointLogs) {
    if (!pointLogMatchesScope(log, input.attributionScope)) continue;
    const spend = log.delta < 0 ? -log.delta : Math.max(0, log.listPrice);
    if (Number.isFinite(spend) && spend > 0) {
      totalPointsSpent += Math.round(spend);
    }
  }

  const distinctPublishedArticleIds = new Set(
    input.periodPublishRecords.map((r) => r.articleId).filter(Boolean),
  );
  const articlesPublished = distinctPublishedArticleIds.size;
  const citationHitsGained = channelRanking.reduce((acc, item) => acc + item.citationHitCount, 0);

  const pointsRoi: GeoRoiReportPointsSummary = {
    totalPointsSpent,
    articlesPublished,
    citationHitsGained,
    pointsPerPublishedArticle:
      articlesPublished > 0 ? round2(totalPointsSpent / articlesPublished) : null,
    pointsPerCitationHit:
      citationHitsGained > 0 ? round2(totalPointsSpent / citationHitsGained) : null,
  };

  return {
    version: 1,
    overview: {
      totalObservations,
      mentionHits,
      mentionRate,
      mentionWilson,
      citationHits,
      citationRate,
      ownedCitationHits,
      ownedCitationRate,
      confidenceLevel: mentionWilson.confidenceLevel,
      did: overviewDid,
      ...(simulatedObservations > 0
        ? { simulatedObservations, hasSimulatedObservations: true }
        : {}),
    },
    byEngine,
    nearMiss,
    funnel,
    channelRanking,
    milestoneTrend,
    pointsRoi,
  };
}

function safeInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function safeRate01(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? round4(clamp01(value)) : fallback;
}

function safeNullableRate01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? round4(clamp01(value)) : null;
}

function safeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWilsonOrFallback(raw: unknown, hits: number, trials: number): WilsonInterval {
  const parsed = wilsonIntervalSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return computeWilsonInterval(hits, trials);
}

function parseDidOrNull(raw: unknown): DifferenceInDifferencesResult | null {
  if (raw === null || raw === undefined) return null;
  const parsed = differenceInDifferencesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * 防御性反序列化持久化 `GeoRoiReport.summaryJson`，保证读路径绝不重算、绝不抛异常。
 */
export function parseStoredSummaryJson(raw: unknown): GeoRoiReportSummaryDto {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawOverview =
    obj.overview && typeof obj.overview === 'object' && !Array.isArray(obj.overview)
      ? (obj.overview as Record<string, unknown>)
      : {};

  const totalObservations = safeInt(rawOverview.totalObservations);
  const mentionHits = safeInt(rawOverview.mentionHits);
  const mentionWilson = parseWilsonOrFallback(
    rawOverview.mentionWilson,
    mentionHits,
    totalObservations,
  );
  const citationHits = safeInt(rawOverview.citationHits);
  const ownedCitationHits = safeInt(rawOverview.ownedCitationHits);
  const simulatedObservations = safeInt(rawOverview.simulatedObservations);
  const hasSimulatedObservations =
    rawOverview.hasSimulatedObservations === true || simulatedObservations > 0;

  const byEngine: GeoRoiReportEngineMetric[] = Array.isArray(obj.byEngine)
    ? obj.byEngine
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => {
          const obs = safeInt(item.observations);
          const mRate = safeRate01(item.mentionRate);
          const wilson = parseWilsonOrFallback(item.mentionWilson, Math.round(mRate * obs), obs);
          return {
            engine: typeof item.engine === 'string' ? item.engine : 'unknown',
            observations: obs,
            mentionRate: mRate,
            citationRate: safeRate01(item.citationRate),
            ownedCitationRate: safeRate01(item.ownedCitationRate),
            avgPosition: safeNullableNumber(item.avgPosition),
            mentionWilson: wilson,
          };
        })
    : [];

  const rawNearMiss =
    obj.nearMiss && typeof obj.nearMiss === 'object' && !Array.isArray(obj.nearMiss)
      ? (obj.nearMiss as Record<string, unknown>)
      : {};
  const rawTierCounts =
    rawNearMiss.tierCounts &&
    typeof rawNearMiss.tierCounts === 'object' &&
    !Array.isArray(rawNearMiss.tierCounts)
      ? (rawNearMiss.tierCounts as Record<string, unknown>)
      : {};
  const tierCounts: Record<NearMissTier, number> = {
    OPENED_NOT_CITED: safeInt(rawTierCounts.OPENED_NOT_CITED),
    RETRIEVED_NOT_CITED: safeInt(rawTierCounts.RETRIEVED_NOT_CITED),
    CRAWLED_NOT_CITED: safeInt(rawTierCounts.CRAWLED_NOT_CITED),
    MENTIONED_NOT_OWNED: safeInt(rawTierCounts.MENTIONED_NOT_OWNED),
  };

  const rawFunnel =
    obj.funnel && typeof obj.funnel === 'object' && !Array.isArray(obj.funnel)
      ? (obj.funnel as Record<string, unknown>)
      : {};

  const channelRanking: GeoRoiReportChannelRank[] = Array.isArray(obj.channelRanking)
    ? obj.channelRanking
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => {
          const completedRetestCount = safeInt(item.completedRetestCount);
          const citationHitCount = safeInt(item.citationHitCount);
          const parsedW = wilsonIntervalSchema.safeParse(item.citationHitWilson);
          const provider = parseProvider(typeof item.provider === 'string' ? item.provider : null);
          const mode = parseDistributionMode(
            typeof item.mode === 'string' ? item.mode : null,
            provider,
          );
          return {
            channel: typeof item.channel === 'string' ? item.channel : 'Unknown',
            ...(item.provider !== undefined ? { provider } : {}),
            ...(item.mode !== undefined ? { mode } : {}),
            publishedCount: safeInt(item.publishedCount),
            completedRetestCount,
            citationHitCount,
            citationHitRate: safeNullableRate01(item.citationHitRate),
            citationHitWilson: parsedW.success ? parsedW.data : null,
            avgMentionRateDelta: safeNullableNumber(item.avgMentionRateDelta),
          };
        })
    : [];

  const milestoneTrend: GeoRoiReportMilestonePoint[] = Array.isArray(obj.milestoneTrend)
    ? obj.milestoneTrend
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => {
          const trials = safeInt(item.trials);
          const hits = safeInt(item.hits);
          const wilson = parseWilsonOrFallback(item.wilson, hits, trials);
          return {
            milestoneDay: safeInt(item.milestoneDay),
            trials,
            hits,
            mentionRate: safeRate01(item.mentionRate, wilson.rate),
            wilson,
            ...(item.controlMentionRate !== undefined
              ? { controlMentionRate: safeNullableRate01(item.controlMentionRate) }
              : {}),
            ...(item.did !== undefined ? { did: parseDidOrNull(item.did) } : {}),
          };
        })
    : [];

  const rawPoints =
    obj.pointsRoi && typeof obj.pointsRoi === 'object' && !Array.isArray(obj.pointsRoi)
      ? (obj.pointsRoi as Record<string, unknown>)
      : null;

  const pointsRoi: GeoRoiReportPointsSummary | undefined = rawPoints
    ? {
        totalPointsSpent: safeInt(rawPoints.totalPointsSpent),
        articlesPublished: safeInt(rawPoints.articlesPublished),
        citationHitsGained: safeInt(rawPoints.citationHitsGained),
        pointsPerPublishedArticle: safeNullableNumber(rawPoints.pointsPerPublishedArticle),
        pointsPerCitationHit: safeNullableNumber(rawPoints.pointsPerCitationHit),
      }
    : undefined;

  return {
    version: 1,
    overview: {
      totalObservations,
      mentionHits,
      mentionRate: safeRate01(rawOverview.mentionRate, mentionWilson.rate),
      mentionWilson,
      citationHits,
      citationRate: safeRate01(rawOverview.citationRate),
      ownedCitationHits,
      ownedCitationRate: safeRate01(rawOverview.ownedCitationRate),
      confidenceLevel: mentionWilson.confidenceLevel,
      did: parseDidOrNull(rawOverview.did),
      ...(hasSimulatedObservations
        ? { simulatedObservations, hasSimulatedObservations: true }
        : {}),
    },
    byEngine,
    nearMiss: {
      totalOpportunities: safeInt(
        rawNearMiss.totalOpportunities,
        tierCounts.OPENED_NOT_CITED +
          tierCounts.RETRIEVED_NOT_CITED +
          tierCounts.CRAWLED_NOT_CITED +
          tierCounts.MENTIONED_NOT_OWNED,
      ),
      boostBriefsCreated: safeInt(rawNearMiss.boostBriefsCreated),
      convertedToCited: safeInt(rawNearMiss.convertedToCited),
      tierCounts,
    },
    funnel: {
      publishedTotal: safeInt(rawFunnel.publishedTotal),
      l1Count: safeInt(rawFunnel.l1Count),
      l2Count: safeInt(rawFunnel.l2Count),
      l3Count: safeInt(rawFunnel.l3Count),
      crawlCheckedCount: safeInt(rawFunnel.crawlCheckedCount),
      crawlOkCount: safeInt(rawFunnel.crawlOkCount),
      crawlOkRate: safeNullableRate01(rawFunnel.crawlOkRate),
      indexNowAttemptedCount: safeInt(rawFunnel.indexNowAttemptedCount),
      indexNowSuccessCount: safeInt(rawFunnel.indexNowSuccessCount),
      indexNowRate: safeNullableRate01(rawFunnel.indexNowRate),
    },
    channelRanking,
    milestoneTrend,
    ...(pointsRoi ? { pointsRoi } : {}),
  };
}

export type GeoRoiReportRowForMapper = {
  id: string;
  brandId: string;
  brandMarketId: string;
  title: string;
  periodStart: Date;
  periodEnd: Date;
  locale: string;
  whiteLabelOrg: string | null;
  summaryJson: Prisma.JsonValue;
  shareTokenHash: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

/**
 * 格式化控制台已鉴权视角 DTO（绝不暴露 shareTokenHash）。
 */
export function presentGeoRoiReport(
  row: GeoRoiReportRowForMapper,
  fallbackMarket?: GeoMarket,
  now: Date = new Date(),
): GeoRoiReportRecordDto {
  const market: GeoMarket =
    row.brandMarket?.market === 'GLOBAL' || fallbackMarket === 'GLOBAL' ? 'GLOBAL' : 'CN';
  const locale: SupportedLocale = resolveEffectiveLocale(row.locale, market);
  const shareActive = Boolean(
    row.shareTokenHash &&
    !row.shareRevokedAt &&
    row.shareExpiresAt &&
    row.shareExpiresAt.getTime() > now.getTime(),
  );
  const shareExpiresAt =
    !row.shareRevokedAt && row.shareExpiresAt ? row.shareExpiresAt.toISOString() : null;

  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    title: row.title,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    locale,
    whiteLabelOrg: row.whiteLabelOrg ?? null,
    summary: parseStoredSummaryJson(row.summaryJson),
    shareActive,
    shareExpiresAt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildSafeRoiReportExportFilename(
  title: string,
  id: string,
): {
  filename: string;
  contentDisposition: string;
} {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, '');
  const safeIdSuffix = id.replace(/[^A-Za-z0-9_-]/g, '').slice(-6) || 'report';
  const stem = cleaned || `geo-roi-report-${safeIdSuffix}`;
  const filename = `${stem}.html`;
  const asciiFallback =
    stem
      .replace(/[^\x20-\x7e]+/g, '')
      .replace(/["\\]/g, '')
      .replace(/\.{2,}/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || `geo-roi-report-${safeIdSuffix}`;
  const encodedFilename = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const contentDisposition = `attachment; filename="${asciiFallback}.html"; filename*=UTF-8''${encodedFilename}`;
  return { filename, contentDisposition };
}

export function resolvePublicAppUrl(): string {
  try {
    const env = parseEnv();
    if (env.PUBLIC_APP_URL) return env.PUBLIC_APP_URL;
    const fallback = env.WEB_ORIGIN.split(',')[0]?.trim() || 'http://localhost:3000';
    return fallback.replace(/\/+$/, '');
  } catch {
    const rawPublic = process.env.PUBLIC_APP_URL?.trim();
    if (rawPublic) return rawPublic.replace(/\/+$/, '');
    const rawWebOrigin = process.env.WEB_ORIGIN?.split(',')[0]?.trim();
    if (rawWebOrigin) return rawWebOrigin.replace(/\/+$/, '');
    return 'http://localhost:3000';
  }
}
