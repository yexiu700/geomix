import {
  computeVisibilityPct,
  isVisibilityEngine,
  type CrudPageSize,
  type RecomputedRunMetrics,
  type VisibilityCitationSourceBreakdown,
  type VisibilityEngineBreakdownItem,
  type VisibilityEngineKey,
  type VisibilityOverviewQuery,
  type VisibilityOverviewResponse,
  type VisibilityTrendPoint,
} from '@geomix/shared';

/** localStorage：用户在诊断页设定的默认监测档案。 */
export const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';
/** sessionStorage：用户主动切到「全部监测档案」后，下次进入看板跳过默认档案一次。 */
export const SKIP_DEFAULT_PROFILE_ONCE_KEY = 'geomix:visibility:overview:skip-default-once';

export type OverviewFilterState = {
  profileId: string;
  engine: string;
  days: 7 | 14 | 30;
  from: string;
  to: string;
};

export type TrendSeriesPoint = VisibilityTrendPoint;

export function createDefaultFilter(profileId = ''): OverviewFilterState {
  return { profileId, engine: '', days: 14, from: '', to: '' };
}

export function readInitialProfileId(href?: string): string | undefined {
  if (!href) return undefined;
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return undefined;
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const val = params.get('profileId')?.trim();
  return val || undefined;
}

export function createEmptyMetrics(brandName = '本品牌'): RecomputedRunMetrics {
  return {
    completedChecks: 0,
    mentionedChecks: 0,
    visibilityPct: 0,
    shareOfVoice: {
      totalMentions: 0,
      brandMentions: 0,
      brandSharePct: 0,
      entries: [{ name: brandName, isBrand: true, mentions: 0, sharePct: 0 }],
    },
    avgPosition: null,
    sentimentSummary: {
      positive: 0,
      neutral: 0,
      mixed: 0,
      negative: 0,
      total: 0,
      positivePct: 0,
      negativePct: 0,
    },
    totalCitations: 0,
    ownedCitations: 0,
    ownedCitationChecks: 0,
    ownedCitationRatePct: 0,
    ownedCitationCheckRatePct: 0,
    topDomains: [],
  };
}

export const EMPTY_SOURCE_BREAKDOWN: VisibilityCitationSourceBreakdown = {
  OWNED: 0,
  COMPETITOR: 0,
  SOCIAL: 0,
  AUTHORITY: 0,
  OTHER: 0,
};

export function sumSourceBreakdown(breakdown: VisibilityCitationSourceBreakdown): number {
  return (
    breakdown.OWNED +
    breakdown.COMPETITOR +
    breakdown.SOCIAL +
    breakdown.AUTHORITY +
    breakdown.OTHER
  );
}

export function formatShortDate(dateKey: string): string {
  return dateKey.length >= 10 ? dateKey.slice(5, 10) : dateKey;
}

export function normalizePageSize(val: number): CrudPageSize {
  if (val === 10 || val === 25 || val === 50) return val;
  return 10;
}

export function getPointSovPct(pt: TrendSeriesPoint): number | null {
  if (pt.completedChecks <= 0) return null;
  if (typeof pt.shareOfVoicePct === 'number' && Number.isFinite(pt.shareOfVoicePct)) {
    return pt.shareOfVoicePct;
  }
  return null;
}

export function isInvalidDateRange(filter: Pick<OverviewFilterState, 'from' | 'to'>): boolean {
  return Boolean(filter.from && filter.to && filter.from > filter.to);
}

/**
 * 将已应用筛选转换为看板各接口共用的查询参数（日期按 +08:00 自然日边界展开）。
 */
export function buildOverviewRangeQuery(filter: OverviewFilterState): VisibilityOverviewQuery {
  const engine = isVisibilityEngine(filter.engine) ? filter.engine : undefined;
  return {
    ...(filter.profileId ? { profileId: filter.profileId } : {}),
    ...(engine ? { engine } : {}),
    days: filter.days,
    ...(filter.from ? { from: `${filter.from}T00:00:00+08:00` } : {}),
    ...(filter.to ? { to: `${filter.to}T23:59:59.999+08:00` } : {}),
  };
}

/** 选取趋势图主序列：优先所选引擎，其次聚合序列 `all`，最后回退原始数据。 */
export function selectDailyTrendSeries(
  trend: VisibilityOverviewResponse['trend'],
  engine: string,
): TrendSeriesPoint[] {
  if (isVisibilityEngine(engine)) {
    const exact = trend.filter((pt) => pt.engine === engine);
    if (exact.length > 0) return exact;
  }
  const allSeries = trend.filter((pt) => pt.engine === 'all');
  if (allSeries.length > 0) return allSeries;
  return trend;
}

/** 引擎维度拆解：优先使用服务端 `byEngine`，否则按趋势点聚合。 */
export function deriveEngineBreakdown(
  overview: Pick<VisibilityOverviewResponse, 'byEngine' | 'trend'>,
): VisibilityEngineBreakdownItem[] {
  if (overview.byEngine && overview.byEngine.length > 0) {
    return overview.byEngine;
  }
  const byEng = new Map<VisibilityEngineKey, { completed: number; mentioned: number }>();
  for (const pt of overview.trend) {
    if (pt.engine === 'all' || !isVisibilityEngine(pt.engine)) continue;
    const cell = byEng.get(pt.engine) ?? { completed: 0, mentioned: 0 };
    cell.completed += pt.completedChecks;
    cell.mentioned += pt.mentionedChecks;
    byEng.set(pt.engine, cell);
  }
  return [...byEng.entries()]
    .filter(([, cell]) => cell.completed > 0)
    .map(([engine, cell]) => ({
      engine,
      completedChecks: cell.completed,
      mentionedChecks: cell.mentioned,
      visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
      avgPosition: null,
    }))
    .sort((a, b) => b.visibilityPct - a.visibilityPct || b.completedChecks - a.completedChecks);
}

/** 去掉页签标题中的 ` · 档案名` 后缀，得到看板基础标题。 */
export function stripTitleSuffix(title: string): string {
  const sepIdx = title.indexOf(' · ');
  return sepIdx > 0 ? title.slice(0, sepIdx) : title || 'AI数据看板';
}
