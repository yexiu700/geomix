import type { VisibilityTrendPoint } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SOURCE_BREAKDOWN,
  buildOverviewRangeQuery,
  createDefaultFilter,
  createEmptyMetrics,
  deriveEngineBreakdown,
  formatShortDate,
  getPointSovPct,
  isInvalidDateRange,
  normalizePageSize,
  readInitialProfileId,
  selectDailyTrendSeries,
  stripTitleSuffix,
  sumSourceBreakdown,
} from './visibility-overview-helpers';

function point(overrides: Partial<VisibilityTrendPoint> = {}): VisibilityTrendPoint {
  return {
    date: '2026-11-18',
    engine: 'all',
    completedChecks: 4,
    mentionedChecks: 2,
    visibilityPct: 50,
    shareOfVoicePct: 40,
    ...overrides,
  };
}

describe('readInitialProfileId', () => {
  it('returns undefined for missing href or query string', () => {
    expect(readInitialProfileId()).toBeUndefined();
    expect(readInitialProfileId('')).toBeUndefined();
    expect(readInitialProfileId('/visibility/overview')).toBeUndefined();
  });

  it('extracts and trims the profileId query parameter', () => {
    expect(readInitialProfileId('/visibility/overview?profileId=vprof_a')).toBe('vprof_a');
    expect(readInitialProfileId('/visibility/overview?x=1&profileId=%20vprof_b%20')).toBe(
      'vprof_b',
    );
    expect(readInitialProfileId('/visibility/overview?profileId=vprof%2Fc')).toBe('vprof/c');
  });

  it('treats empty or whitespace-only profileId as absent', () => {
    expect(readInitialProfileId('/visibility/overview?profileId=')).toBeUndefined();
    expect(readInitialProfileId('/visibility/overview?profileId=%20%20')).toBeUndefined();
    expect(readInitialProfileId('/visibility/overview?other=1')).toBeUndefined();
  });
});

describe('normalizePageSize', () => {
  it('keeps the supported CRUD page sizes', () => {
    expect(normalizePageSize(10)).toBe(10);
    expect(normalizePageSize(25)).toBe(25);
    expect(normalizePageSize(50)).toBe(50);
  });

  it('falls back to 10 for any other value', () => {
    expect(normalizePageSize(20)).toBe(10);
    expect(normalizePageSize(0)).toBe(10);
    expect(normalizePageSize(-5)).toBe(10);
    expect(normalizePageSize(Number.NaN)).toBe(10);
  });
});

describe('getPointSovPct', () => {
  it('returns null for zero-sample days even when a SoV value is present', () => {
    expect(getPointSovPct(point({ completedChecks: 0, shareOfVoicePct: 30 }))).toBeNull();
  });

  it('returns null when SoV is missing, null or non-finite', () => {
    expect(getPointSovPct(point({ shareOfVoicePct: undefined }))).toBeNull();
    expect(getPointSovPct(point({ shareOfVoicePct: null }))).toBeNull();
    expect(getPointSovPct(point({ shareOfVoicePct: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(getPointSovPct(point({ shareOfVoicePct: Number.NaN }))).toBeNull();
  });

  it('returns the finite SoV for sampled days (including 0%)', () => {
    expect(getPointSovPct(point({ shareOfVoicePct: 66.7 }))).toBe(66.7);
    expect(getPointSovPct(point({ shareOfVoicePct: 0 }))).toBe(0);
  });
});

describe('formatShortDate', () => {
  it('formats YYYY-MM-DD keys (and longer ISO strings) to MM-DD', () => {
    expect(formatShortDate('2026-11-18')).toBe('11-18');
    expect(formatShortDate('2026-01-02T08:00:00.000Z')).toBe('01-02');
  });

  it('returns short keys unchanged', () => {
    expect(formatShortDate('11-18')).toBe('11-18');
    expect(formatShortDate('')).toBe('');
  });
});

describe('filter helpers', () => {
  it('creates the default 14-day filter with optional profile', () => {
    expect(createDefaultFilter()).toEqual({
      profileId: '',
      engine: '',
      days: 14,
      from: '',
      to: '',
    });
    expect(createDefaultFilter('vprof_a').profileId).toBe('vprof_a');
  });

  it('flags only from > to as an invalid date range', () => {
    expect(isInvalidDateRange({ from: '2026-11-18', to: '2026-11-10' })).toBe(true);
    expect(isInvalidDateRange({ from: '2026-11-10', to: '2026-11-18' })).toBe(false);
    expect(isInvalidDateRange({ from: '2026-11-10', to: '2026-11-10' })).toBe(false);
    expect(isInvalidDateRange({ from: '2026-11-10', to: '' })).toBe(false);
  });

  it('builds the shared range query with +08:00 day boundaries and drops empty fields', () => {
    expect(buildOverviewRangeQuery(createDefaultFilter())).toEqual({ days: 14 });
    expect(
      buildOverviewRangeQuery({
        profileId: 'vprof_a',
        engine: 'deepseek',
        days: 7,
        from: '2026-11-01',
        to: '2026-11-07',
      }),
    ).toEqual({
      profileId: 'vprof_a',
      engine: 'deepseek',
      days: 7,
      from: '2026-11-01T00:00:00+08:00',
      to: '2026-11-07T23:59:59.999+08:00',
    });
    expect(buildOverviewRangeQuery({ ...createDefaultFilter(), engine: 'unknown' })).toEqual({
      days: 14,
    });
  });
});

describe('trend & breakdown derivation', () => {
  const trend: VisibilityTrendPoint[] = [
    point({ date: '2026-11-17', engine: 'all' }),
    point({ date: '2026-11-17', engine: 'deepseek', completedChecks: 2, mentionedChecks: 2 }),
    point({ date: '2026-11-18', engine: 'deepseek', completedChecks: 2, mentionedChecks: 0 }),
    point({ date: '2026-11-18', engine: 'doubao', completedChecks: 0, mentionedChecks: 0 }),
  ];

  it('prefers the selected engine series, then the aggregated series, then raw points', () => {
    expect(selectDailyTrendSeries(trend, 'deepseek')).toHaveLength(2);
    expect(selectDailyTrendSeries(trend, '')).toEqual([trend[0]]);
    expect(selectDailyTrendSeries(trend, 'kimi')).toEqual([trend[0]]);
    const noAll = trend.slice(1);
    expect(selectDailyTrendSeries(noAll, '')).toBe(noAll);
  });

  it('uses server byEngine when provided, otherwise aggregates per-engine trend points', () => {
    const byEngine = [
      {
        engine: 'kimi' as const,
        completedChecks: 1,
        mentionedChecks: 1,
        visibilityPct: 100,
        avgPosition: 1,
      },
    ];
    expect(deriveEngineBreakdown({ byEngine, trend })).toBe(byEngine);

    const derived = deriveEngineBreakdown({ byEngine: [], trend });
    expect(derived).toEqual([
      {
        engine: 'deepseek',
        completedChecks: 4,
        mentionedChecks: 2,
        visibilityPct: 50,
        avgPosition: null,
      },
    ]);
  });

  it('sums citation source breakdowns and creates zeroed metrics', () => {
    expect(sumSourceBreakdown(EMPTY_SOURCE_BREAKDOWN)).toBe(0);
    expect(sumSourceBreakdown({ OWNED: 1, COMPETITOR: 2, SOCIAL: 3, AUTHORITY: 4, OTHER: 5 })).toBe(
      15,
    );
    const empty = createEmptyMetrics('星海');
    expect(empty.completedChecks).toBe(0);
    expect(empty.shareOfVoice.entries).toEqual([
      { name: '星海', isBrand: true, mentions: 0, sharePct: 0 },
    ]);
  });

  it('strips the profile suffix from tab titles', () => {
    expect(stripTitleSuffix('AI数据看板 · 阿尔法档案')).toBe('AI数据看板');
    expect(stripTitleSuffix('AI数据看板')).toBe('AI数据看板');
    expect(stripTitleSuffix('')).toBe('AI数据看板');
  });
});
