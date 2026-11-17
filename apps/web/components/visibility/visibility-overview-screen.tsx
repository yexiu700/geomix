'use client';

import {
  CITATION_SOURCE_KINDS,
  CITATION_SOURCE_LABELS,
  CRUD_PAGE_SIZES,
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINE_LABELS,
  computeVisibilityPct,
  isCitationSourceKind,
  isVisibilityEngine,
  type CitationSourceKind,
  type CrudPageSize,
  type KeywordRecord,
  type RecomputedRunMetrics,
  type VisibilityCitationListResponse,
  type VisibilityCitationSourceBreakdown,
  type VisibilityCitationSummaryItem,
  type VisibilityEngineBreakdownItem,
  type VisibilityEngineKey,
  type VisibilityFanOutItem,
  type VisibilityOpportunitiesResponse,
  type VisibilityOpportunityGapItem,
  type VisibilityOverviewResponse,
  type VisibilityProfileRecord,
  type VisibilityTrendPoint,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { httpVisibilityGateway, type VisibilityGateway } from '../../lib/visibility';
import { citationSourceBadgeColor } from './visibility-monitors-screen';

const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 13,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
  maxWidth: '100%',
};

const DATE_INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 13,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
  maxWidth: '100%',
};

export type VisibilityOverviewFilterContext = {
  profileId?: string;
  engine?: VisibilityEngineKey;
  days: number;
  from?: string;
  to?: string;
  readOnly: boolean;
  tabId?: string;
  gateway: VisibilityGateway;
  onDispatch?: (action: ShellAction) => void;
};

export type VisibilityAnalyticsTabSpec = {
  key: string;
  label: ReactNode;
  render: (ctx: VisibilityOverviewFilterContext) => ReactNode;
};

type OverviewFilterState = {
  profileId: string;
  engine: string;
  days: 7 | 14 | 30;
  from: string;
  to: string;
};

type TrendSeriesPoint = VisibilityTrendPoint & {
  shareOfVoicePct?: number;
};

function readInitialProfileId(href?: string): string | undefined {
  if (!href) return undefined;
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return undefined;
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const val = params.get('profileId')?.trim();
  return val || undefined;
}

function createEmptyMetrics(brandName = '本品牌'): RecomputedRunMetrics {
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

const EMPTY_SOURCE_BREAKDOWN: VisibilityCitationSourceBreakdown = {
  OWNED: 0,
  COMPETITOR: 0,
  SOCIAL: 0,
  AUTHORITY: 0,
  OTHER: 0,
};

function formatShortDate(dateKey: string): string {
  return dateKey.length >= 10 ? dateKey.slice(5, 10) : dateKey;
}

function normalizePageSize(val: number): CrudPageSize {
  if (val === 10 || val === 25 || val === 50) return val;
  return 10;
}

function VisibilityTrendChartSvg({
  points,
  periodSoVPct,
  activeIndex,
  onHoverIndex,
}: {
  points: TrendSeriesPoint[];
  periodSoVPct: number;
  activeIndex: number | null;
  onHoverIndex: (idx: number | null) => void;
}) {
  const width = 740;
  const height = 248;
  const padLeft = 44;
  const padRight = 20;
  const padTop = 24;
  const padBottom = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const pctTicks = [0, 25, 50, 75, 100];
  const maxObs = Math.max(4, ...points.map((p) => p.completedChecks));

  const colW = plotW / Math.max(1, points.length);
  const barW = Math.max(6, Math.min(22, Math.floor(colW * 0.42)));

  const yPct = (pct: number) => {
    const clamped = Math.max(0, Math.min(100, pct));
    return padTop + plotH - (clamped / 100) * plotH;
  };

  const yObs = (count: number) => {
    const ratio = Math.max(0, Math.min(1, count / maxObs));
    return padTop + plotH - ratio * plotH * 0.78;
  };

  const visPolyline = points
    .map((pt, idx) => {
      const cx = padLeft + idx * colW + colW / 2;
      return `${cx},${yPct(pt.visibilityPct)}`;
    })
    .join(' ');

  const sovPolyline = points
    .map((pt, idx) => {
      const cx = padLeft + idx * colW + colW / 2;
      const sov = typeof pt.shareOfVoicePct === 'number' ? pt.shareOfVoicePct : periodSoVPct;
      return `${cx},${yPct(sov)}`;
    })
    .join(' ');

  const labelStep = points.length > 16 ? 4 : points.length > 9 ? 2 : 1;

  return (
    <svg
      data-testid="visibility-trend-svg"
      role="img"
      aria-label="近 N 日品牌可见度与声量趋势图"
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', maxHeight: 265, display: 'block' }}
      onMouseLeave={() => onHoverIndex(null)}
    >
      {/* Y-axis gridlines (0% - 100%) */}
      {pctTicks.map((tick) => {
        const y = yPct(tick);
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke="#edf2f7"
              strokeDasharray={tick === 0 ? undefined : '4 4'}
            />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#64748b">
              {tick}%
            </text>
          </g>
        );
      })}

      {/* Daily observation & mention bars */}
      {points.map((pt, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const barX = cx - barW / 2;
        const totalTop = yObs(pt.completedChecks);
        const totalH = Math.max(2, padTop + plotH - totalTop);
        const mentionTop = yObs(pt.mentionedChecks);
        const mentionH = Math.max(0, padTop + plotH - mentionTop);
        const isHovered = activeIndex === idx;

        return (
          <g key={pt.date} onMouseEnter={() => onHoverIndex(idx)} style={{ cursor: 'pointer' }}>
            <rect
              x={padLeft + idx * colW}
              y={padTop}
              width={colW}
              height={plotH}
              fill={isHovered ? 'rgba(22, 119, 255, 0.05)' : 'transparent'}
            />
            <rect
              x={barX}
              y={pt.completedChecks > 0 ? totalTop : padTop + plotH - 2}
              width={barW}
              height={pt.completedChecks > 0 ? totalH : 2}
              rx={3}
              fill="#dbeafe"
            />
            {pt.mentionedChecks > 0 ? (
              <rect x={barX} y={mentionTop} width={barW} height={mentionH} rx={3} fill="#93c5fd" />
            ) : null}
            {idx % labelStep === 0 || idx === points.length - 1 ? (
              <text
                x={cx}
                y={height - 12}
                textAnchor="middle"
                fontSize="11"
                fill={isHovered ? '#1677ff' : '#475569'}
                fontWeight={isHovered ? '600' : '400'}
              >
                {formatShortDate(pt.date)}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Share of Voice % polyline */}
      {points.length > 1 ? (
        <polyline
          fill="none"
          stroke="#722ed1"
          strokeWidth="2"
          strokeDasharray="5 3"
          points={sovPolyline}
          opacity="0.82"
        />
      ) : null}

      {/* Visibility % solid polyline */}
      {points.length > 1 ? (
        <polyline fill="none" stroke="#1677ff" strokeWidth="2.5" points={visPolyline} />
      ) : null}

      {/* Data nodes */}
      {points.map((pt, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const cy = yPct(pt.visibilityPct);
        const sov = typeof pt.shareOfVoicePct === 'number' ? pt.shareOfVoicePct : periodSoVPct;
        return (
          <g key={`${pt.date}-nodes`} onMouseEnter={() => onHoverIndex(idx)}>
            <circle cx={cx} cy={yPct(sov)} r={2.8} fill="#722ed1" />
            <circle
              cx={cx}
              cy={cy}
              r={activeIndex === idx ? 5 : 3.6}
              fill="#ffffff"
              stroke="#1677ff"
              strokeWidth="2.2"
            />
          </g>
        );
      })}
    </svg>
  );
}

export function VisibilityOverviewScreen({
  title,
  tabId,
  href,
  readOnly = false,
  featureEnabled = true,
  storage,
  gateway,
  extraAnalyticsTabs,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  href?: string;
  readOnly?: boolean;
  featureEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: VisibilityGateway;
  extraAnalyticsTabs?: VisibilityAnalyticsTabSpec[];
  onDispatch?: (action: ShellAction) => void;
}) {
  const effectiveStorage = useMemo<SessionStorageLike>(() => {
    if (storage) return storage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
    const mem = new Map<string, string>();
    return {
      getItem: (key) => mem.get(key) ?? null,
      setItem: (key, value) => {
        mem.set(key, value);
      },
      removeItem: (key) => {
        mem.delete(key);
      },
    };
  }, [storage]);

  const client = useMemo(
    () => gateway ?? httpVisibilityGateway(effectiveStorage),
    [effectiveStorage, gateway],
  );

  const urlProfileId = useMemo(() => readInitialProfileId(href), [href]);

  const [profiles, setProfiles] = useState<VisibilityProfileRecord[]>([]);
  const [filterDraft, setFilterDraft] = useState<OverviewFilterState>(() => ({
    profileId: urlProfileId ?? '',
    engine: '',
    days: 14,
    from: '',
    to: '',
  }));
  const [appliedFilter, setAppliedFilter] = useState<OverviewFilterState>(() => ({
    profileId: urlProfileId ?? '',
    engine: '',
    days: 14,
    from: '',
    to: '',
  }));
  const [filterError, setFilterError] = useState<string | null>(null);

  const [overviewData, setOverviewData] = useState<VisibilityOverviewResponse>(() => ({
    profileId: urlProfileId ?? null,
    metrics: createEmptyMetrics(),
    trend: [],
    byEngine: [],
  }));
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [hoveredTrendIdx, setHoveredTrendIdx] = useState<number | null>(null);

  // Citations leaderboard state
  const [activeBottomTab, setActiveBottomTab] = useState<string>('citations');
  const [citationSourceKind, setCitationSourceKind] = useState<CitationSourceKind | 'ALL'>('ALL');
  const [citationPage, setCitationPage] = useState<number>(1);
  const [citationPageSize, setCitationPageSize] = useState<CrudPageSize>(10);
  const [citationsLoading, setCitationsLoading] = useState<boolean>(true);
  const [citationsData, setCitationsData] = useState<VisibilityCitationListResponse>(() => ({
    page: 1,
    pageSize: 10,
    total: 0,
    totalCitations: 0,
    sourceBreakdown: EMPTY_SOURCE_BREAKDOWN,
    items: [],
  }));
  const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>({});

  // Opportunities & Query Fan-Out state
  const [opportunitiesLoading, setOpportunitiesLoading] = useState<boolean>(false);
  const [opportunitiesData, setOpportunitiesData] = useState<VisibilityOpportunitiesResponse>({
    gaps: [],
    fanOutQueries: [],
  });
  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [selectedKeywordId, setSelectedKeywordId] = useState<string>('');
  const [selectedOpportunityTitles, setSelectedOpportunityTitles] = useState<string[]>([]);
  const [importingQuestions, setImportingQuestions] = useState<boolean>(false);
  const [opportunityFeedback, setOpportunityFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Sync URL ?profileId=... if changed
  useEffect(() => {
    if (!urlProfileId) return;
    setFilterDraft((curr) =>
      curr.profileId === urlProfileId ? curr : { ...curr, profileId: urlProfileId },
    );
    setAppliedFilter((curr) =>
      curr.profileId === urlProfileId ? curr : { ...curr, profileId: urlProfileId },
    );
  }, [urlProfileId]);

  // Load profiles list and optionally initialize default profile if URL didn't specify one
  useEffect(() => {
    if (!featureEnabled) return;
    let cancelled = false;
    void client
      .listProfiles()
      .then((res) => {
        if (cancelled) return;
        setProfiles(res.items);
        if (!urlProfileId && res.items.length > 0) {
          const savedDefault =
            typeof window !== 'undefined' && window.localStorage
              ? window.localStorage.getItem(DEFAULT_PROFILE_STORAGE_KEY)
              : null;
          if (savedDefault && res.items.some((p) => p.id === savedDefault)) {
            setFilterDraft((curr) =>
              curr.profileId ? curr : { ...curr, profileId: savedDefault },
            );
            setAppliedFilter((curr) =>
              curr.profileId ? curr : { ...curr, profileId: savedDefault },
            );
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, featureEnabled, urlProfileId]);

  // Load overview data when appliedFilter changes
  useEffect(() => {
    if (!featureEnabled) {
      setOverviewLoading(false);
      return;
    }
    let cancelled = false;
    setOverviewLoading(true);
    setBannerError(null);

    const engine = isVisibilityEngine(appliedFilter.engine) ? appliedFilter.engine : undefined;
    const fromIso = appliedFilter.from ? `${appliedFilter.from}T00:00:00+08:00` : undefined;
    const toIso = appliedFilter.to ? `${appliedFilter.to}T23:59:59.999+08:00` : undefined;

    void client
      .getOverview({
        ...(appliedFilter.profileId ? { profileId: appliedFilter.profileId } : {}),
        ...(engine ? { engine } : {}),
        days: appliedFilter.days,
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIso ? { to: toIso } : {}),
      })
      .then((res) => {
        if (cancelled) return;
        setOverviewData(res);
        setHoveredTrendIdx(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setBannerError(err instanceof Error ? err.message : '加载 AI 数据看板概览失败');
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, client, featureEnabled]);

  // Load citations leaderboard when appliedFilter or citation filters/pagination change
  useEffect(() => {
    if (!featureEnabled) {
      setCitationsLoading(false);
      return;
    }
    let cancelled = false;
    setCitationsLoading(true);

    const engine = isVisibilityEngine(appliedFilter.engine) ? appliedFilter.engine : undefined;
    const sourceKind =
      citationSourceKind !== 'ALL' && isCitationSourceKind(citationSourceKind)
        ? citationSourceKind
        : undefined;
    const fromIso = appliedFilter.from ? `${appliedFilter.from}T00:00:00+08:00` : undefined;
    const toIso = appliedFilter.to ? `${appliedFilter.to}T23:59:59.999+08:00` : undefined;

    void client
      .listCitations({
        ...(appliedFilter.profileId ? { profileId: appliedFilter.profileId } : {}),
        ...(engine ? { engine } : {}),
        ...(sourceKind ? { sourceKind } : {}),
        days: appliedFilter.days,
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIso ? { to: toIso } : {}),
        page: citationPage,
        pageSize: citationPageSize,
      })
      .then((res) => {
        if (cancelled) return;
        setCitationsData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setBannerError(err instanceof Error ? err.message : '加载引用溯源排行榜失败');
      })
      .finally(() => {
        if (!cancelled) setCitationsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, citationPage, citationPageSize, citationSourceKind, client, featureEnabled]);

  // Load tenant keywords for target keyword selection in opportunities tab
  useEffect(() => {
    if (!featureEnabled) return;
    let cancelled = false;
    void client
      .listKeywords()
      .then((list) => {
        if (cancelled) return;
        setKeywords(list);
        setSelectedKeywordId((curr) =>
          curr && list.some((k) => k.id === curr) ? curr : (list[0]?.id ?? ''),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, featureEnabled]);

  // Load opportunities (competitor gaps + fan-out queries) when appliedFilter changes
  useEffect(() => {
    if (!featureEnabled || !client.listOpportunities) {
      setOpportunitiesLoading(false);
      return;
    }
    let cancelled = false;
    setOpportunitiesLoading(true);

    const engine = isVisibilityEngine(appliedFilter.engine) ? appliedFilter.engine : undefined;
    const fromIso = appliedFilter.from ? `${appliedFilter.from}T00:00:00+08:00` : undefined;
    const toIso = appliedFilter.to ? `${appliedFilter.to}T23:59:59.999+08:00` : undefined;

    void client
      .listOpportunities({
        ...(appliedFilter.profileId ? { profileId: appliedFilter.profileId } : {}),
        ...(engine ? { engine } : {}),
        days: appliedFilter.days,
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIso ? { to: toIso } : {}),
        limit: 50,
      })
      .then((res) => {
        if (cancelled) return;
        setOpportunitiesData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setOpportunitiesData({ gaps: [], fanOutQueries: [] });
      })
      .finally(() => {
        if (!cancelled) setOpportunitiesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, client, featureEnabled]);

  const toggleOpportunityTitle = useCallback((titleText: string, checked: boolean) => {
    setSelectedOpportunityTitles((curr) => {
      if (checked) {
        return curr.includes(titleText) ? curr : [...curr, titleText];
      }
      return curr.filter((item) => item !== titleText);
    });
  }, []);

  const handleImportOpportunityQuestions = useCallback(async () => {
    if (readOnly || !selectedKeywordId || selectedOpportunityTitles.length === 0) return;
    if (!client.importOpportunityQuestions) return;
    setImportingQuestions(true);
    setOpportunityFeedback(null);
    try {
      const result = await client.importOpportunityQuestions({
        keywordId: selectedKeywordId,
        titles: selectedOpportunityTitles,
      });
      const feedbackText = `已导入「写作标题」：新增 ${result.insertedCount} 条，跳过重复 ${result.skippedCount} 条`;
      setOpportunityFeedback({ type: 'success', text: feedbackText });
      void message.success(feedbackText);
      setSelectedOpportunityTitles([]);
    } catch (err: unknown) {
      const errText = err instanceof Error ? err.message : '导入写作标题失败';
      setOpportunityFeedback({ type: 'error', text: errText });
      void message.error(errText);
    } finally {
      setImportingQuestions(false);
    }
  }, [client, readOnly, selectedKeywordId, selectedOpportunityTitles]);

  const goToWritingTasks = useCallback(() => {
    const targetHref = selectedKeywordId
      ? `/writing/tasks?keywordId=${encodeURIComponent(selectedKeywordId)}`
      : '/writing/tasks';
    onDispatch?.({ type: 'open', href: targetHref });
  }, [onDispatch, selectedKeywordId]);

  const handleApplySearch = useCallback(() => {
    if (filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to) {
      setFilterError('开始日期不能晚于结束日期，请调整起止时间后再查询');
      return;
    }
    setFilterError(null);
    setCitationPage(1);
    setAppliedFilter({ ...filterDraft });
  }, [filterDraft]);

  const handleResetFilters = useCallback(() => {
    const clean: OverviewFilterState = {
      profileId: '',
      engine: '',
      days: 14,
      from: '',
      to: '',
    };
    setFilterError(null);
    setFilterDraft(clean);
    setCitationSourceKind('ALL');
    setCitationPage(1);
    setAppliedFilter(clean);
  }, []);

  // Derive daily primary trend series
  const dailyTrendSeries = useMemo<TrendSeriesPoint[]>(() => {
    const selectedEng = isVisibilityEngine(appliedFilter.engine) ? appliedFilter.engine : null;
    if (selectedEng) {
      const exact = overviewData.trend.filter((pt) => pt.engine === selectedEng);
      if (exact.length > 0) return exact;
    }
    const allSeries = overviewData.trend.filter((pt) => pt.engine === 'all');
    if (allSeries.length > 0) return allSeries;
    return overviewData.trend;
  }, [appliedFilter.engine, overviewData.trend]);

  const hasTrendActivity = useMemo(
    () => dailyTrendSeries.length > 0 && dailyTrendSeries.some((pt) => pt.completedChecks > 0),
    [dailyTrendSeries],
  );

  // Derive per-engine breakdown (uses overviewData.byEngine when available, else aggregates trend)
  const engineBreakdown = useMemo<VisibilityEngineBreakdownItem[]>(() => {
    if (overviewData.byEngine && overviewData.byEngine.length > 0) {
      return overviewData.byEngine;
    }
    const byEng = new Map<VisibilityEngineKey, { completed: number; mentioned: number }>();
    for (const pt of overviewData.trend) {
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
  }, [overviewData.byEngine, overviewData.trend]);

  const metrics = overviewData.metrics;
  const activeTrendPoint =
    hoveredTrendIdx !== null ? (dailyTrendSeries[hoveredTrendIdx] ?? null) : null;

  const breakdownCounts = citationsData.sourceBreakdown ?? EMPTY_SOURCE_BREAKDOWN;
  const allCitationTotal =
    breakdownCounts.OWNED +
    breakdownCounts.COMPETITOR +
    breakdownCounts.SOCIAL +
    breakdownCounts.AUTHORITY +
    breakdownCounts.OTHER;

  const filterContext = useMemo<VisibilityOverviewFilterContext>(
    () => ({
      ...(appliedFilter.profileId ? { profileId: appliedFilter.profileId } : {}),
      ...(isVisibilityEngine(appliedFilter.engine) ? { engine: appliedFilter.engine } : {}),
      days: appliedFilter.days,
      ...(appliedFilter.from ? { from: `${appliedFilter.from}T00:00:00+08:00` } : {}),
      ...(appliedFilter.to ? { to: `${appliedFilter.to}T23:59:59.999+08:00` } : {}),
      readOnly,
      tabId,
      gateway: client,
      onDispatch,
    }),
    [appliedFilter, client, onDispatch, readOnly, tabId],
  );

  function goToMonitors() {
    const targetHref = appliedFilter.profileId
      ? `/visibility/monitors?profileId=${encodeURIComponent(appliedFilter.profileId)}`
      : '/visibility/monitors';
    onDispatch?.({ type: 'open', href: targetHref, sourceId: tabId });
  }

  if (!featureEnabled) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="当前站点尚未开启 AI 数据看板功能，如需启用请联系管理员开启 FEATURE_VISIBILITY。"
        />
      </section>
    );
  }

  return (
    <section style={{ minWidth: 0 }}>
      {/* Page Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            全景追踪企业品牌在各大生成式 AI 引擎中的提及率、行业声量占比（Share of
            Voice）、推荐顺位与引用信源分布
          </Typography.Text>
        </div>
        <Button type="primary" aria-label="发起可见度诊断" onClick={goToMonitors}>
          发起可见度诊断
        </Button>
      </div>

      {/* Top Filter Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: 12,
          marginBottom: 12,
          borderRadius: 10,
          border: '1px solid #e6eaf0',
          background: '#f8fafc',
        }}
      >
        <select
          aria-label="看板监测档案"
          style={{ ...COMPACT_SELECT_STYLE, width: 190 }}
          value={filterDraft.profileId}
          onChange={(e) => {
            const nextProfileId = e.target.value;
            setFilterDraft((curr) => ({ ...curr, profileId: nextProfileId }));
          }}
        >
          <option value="">全部监测档案</option>
          {profiles.map((prof) => (
            <option key={prof.id} value={prof.id}>
              {prof.name}（{prof.brandName}）
            </option>
          ))}
        </select>

        <select
          aria-label="看板AI引擎"
          style={{ ...COMPACT_SELECT_STYLE, width: 150 }}
          value={filterDraft.engine}
          onChange={(e) => setFilterDraft((curr) => ({ ...curr, engine: e.target.value }))}
        >
          <option value="">全部 AI 引擎</option>
          {VISIBILITY_ENGINES.map((eng) => (
            <option key={eng.key} value={eng.key}>
              {eng.label}
            </option>
          ))}
        </select>

        {/* Quick Days Pills */}
        <Space size={4} wrap>
          {([7, 14, 30] as const).map((dayNum) => {
            const isSelected = !filterDraft.from && !filterDraft.to && filterDraft.days === dayNum;
            return (
              <Button
                key={dayNum}
                size="small"
                type={isSelected ? 'primary' : 'default'}
                aria-label={`近${dayNum}天`}
                onClick={() => {
                  setFilterError(null);
                  const next: OverviewFilterState = {
                    ...filterDraft,
                    days: dayNum,
                    from: '',
                    to: '',
                  };
                  setFilterDraft(next);
                  setCitationPage(1);
                  setAppliedFilter(next);
                }}
              >
                近 {dayNum} 天
              </Button>
            );
          })}
        </Space>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <input
            type="date"
            aria-label="开始日期"
            style={DATE_INPUT_STYLE}
            value={filterDraft.from}
            onChange={(e) => setFilterDraft((curr) => ({ ...curr, from: e.target.value }))}
          />
          <span style={{ color: '#64748b', fontSize: 12 }}>至</span>
          <input
            type="date"
            aria-label="结束日期"
            style={DATE_INPUT_STYLE}
            value={filterDraft.to}
            onChange={(e) => setFilterDraft((curr) => ({ ...curr, to: e.target.value }))}
          />
        </div>

        <Button type="primary" aria-label="查询看板数据" onClick={handleApplySearch}>
          查询
        </Button>
        <Button aria-label="重置看板筛选" onClick={handleResetFilters}>
          重置
        </Button>
      </div>

      {filterError ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setFilterError(null)}
          message={filterError}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {bannerError ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setBannerError(null)}
          message={bannerError}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {/* 4 Core KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div className="gm-right-card" data-testid="kpi-visibility">
          <div className="label">品牌提及率（Visibility %）</div>
          <div className="value" style={{ color: '#1677ff' }}>
            {metrics.visibilityPct.toFixed(1)}%
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
            提及 {metrics.mentionedChecks} 次 / 有效观测 {metrics.completedChecks} 次
          </div>
        </div>

        <div className="gm-right-card" data-testid="kpi-sov">
          <div className="label">品牌声量占比（Share of Voice %）</div>
          <div className="value" style={{ color: '#722ed1' }}>
            {metrics.shareOfVoice.brandSharePct.toFixed(1)}%
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
            本品牌 {metrics.shareOfVoice.brandMentions} 次 / 赛道总声量{' '}
            {metrics.shareOfVoice.totalMentions} 次
          </div>
        </div>

        <div className="gm-right-card" data-testid="kpi-position">
          <div className="label">平均推荐顺位（Avg Position）</div>
          <div className="value" style={{ color: '#0f766e' }}>
            {metrics.avgPosition !== null ? `#${metrics.avgPosition.toFixed(1)}` : '—'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
            {metrics.avgPosition !== null
              ? '顺位越靠前代表 AI 首推权重越高'
              : '当前筛选周期内暂无命中顺位'}
          </div>
        </div>

        <div className="gm-right-card" data-testid="kpi-owned-citation">
          <div className="label">自有域名引用率（Owned Citation %）</div>
          <div className="value" style={{ color: '#0891b2' }}>
            {metrics.ownedCitationRatePct.toFixed(1)}%
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
            自有引用 {metrics.ownedCitations}/{metrics.totalCitations} 次 · 正面情感{' '}
            {metrics.sentimentSummary.positivePct.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Charts & Competitive Landscape Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))',
          gap: 14,
          marginBottom: 16,
        }}
      >
        {/* Left: Trend Chart */}
        <div
          style={{
            padding: 16,
            borderRadius: 10,
            border: '1px solid #e6eaf0',
            background: '#ffffff',
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 10,
            }}
          >
            <div>
              <Typography.Text strong style={{ fontSize: 15 }}>
                可见度与声量变化趋势
              </Typography.Text>
              <div style={{ fontSize: 12, color: '#64748b' }}>
                {activeTrendPoint
                  ? `${activeTrendPoint.date}：检测 ${activeTrendPoint.completedChecks} 次 · 提及 ${activeTrendPoint.mentionedChecks} 次 · 提及率 ${activeTrendPoint.visibilityPct.toFixed(1)}%`
                  : `展示周期内每日品牌提及率（实线）、声量占比（虚线）与有效检测量（柱状）`}
              </div>
            </div>
            <Space size={10} wrap style={{ fontSize: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: '#1677ff',
                    display: 'inline-block',
                  }}
                />
                提及率 %
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 10,
                    height: 3,
                    background: '#722ed1',
                    display: 'inline-block',
                  }}
                />
                声量占比 %
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: '#93c5fd',
                    display: 'inline-block',
                  }}
                />
                检测/提及量
              </span>
            </Space>
          </div>

          {overviewLoading ? (
            <div style={{ padding: '48px 0', textAlign: 'center', color: '#64748b' }}>
              正在聚合趋势数据…
            </div>
          ) : !hasTrendActivity ? (
            <div
              data-testid="visibility-trend-empty"
              style={{
                padding: '44px 16px',
                textAlign: 'center',
                borderRadius: 8,
                background: '#f8fafc',
                border: '1px dashed #d9e2ef',
              }}
            >
              <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                当前筛选范围内暂无有效 AI 检测趋势记录
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                切换时间窗口或前往「AI可见度诊断」发起新一轮多引擎监测后即可查看趋势曲线。
              </Typography.Text>
            </div>
          ) : (
            <VisibilityTrendChartSvg
              points={dailyTrendSeries}
              periodSoVPct={metrics.shareOfVoice.brandSharePct}
              activeIndex={hoveredTrendIdx}
              onHoverIndex={setHoveredTrendIdx}
            />
          )}
        </div>

        {/* Right: Competitor SoV + Sentiment + Per-Engine Breakdown */}
        <div
          style={{
            padding: 16,
            borderRadius: 10,
            border: '1px solid #e6eaf0',
            background: '#ffffff',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {/* Share of Voice Leaderboard */}
          <div>
            <Typography.Text strong style={{ fontSize: 15, display: 'block', marginBottom: 8 }}>
              品牌 vs 竞品声量对比榜（Share of Voice）
            </Typography.Text>
            {metrics.shareOfVoice.entries.length === 0 ? (
              <Typography.Text type="secondary">暂无品牌与竞品对比数据</Typography.Text>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {metrics.shareOfVoice.entries.map((entry, idx) => {
                  const visPct = computeVisibilityPct(entry.mentions, metrics.completedChecks);
                  return (
                    <div
                      key={`${entry.isBrand ? 'brand' : 'comp'}-${entry.name}`}
                      data-testid={entry.isBrand ? 'sov-brand-row' : `sov-comp-row-${entry.name}`}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: entry.isBrand ? '1px solid #91caff' : '1px solid #f0f2f5',
                        background: entry.isBrand ? '#f0f7ff' : '#fafafa',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                          marginBottom: 4,
                        }}
                      >
                        <Space size={6} wrap>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            #{idx + 1}
                          </Typography.Text>
                          <Typography.Text strong>{entry.name}</Typography.Text>
                          {entry.isBrand ? <Tag color="blue">本品牌</Tag> : <Tag>竞品</Tag>}
                        </Space>
                        <Space size={8} style={{ fontSize: 12 }}>
                          <span>提及 {entry.mentions} 次</span>
                          <span style={{ color: '#64748b' }}>可见率 {visPct.toFixed(1)}%</span>
                          <strong style={{ color: entry.isBrand ? '#1677ff' : '#d97706' }}>
                            声量 {entry.sharePct.toFixed(1)}%
                          </strong>
                        </Space>
                      </div>
                      <div
                        style={{
                          width: '100%',
                          height: 7,
                          borderRadius: 999,
                          background: '#e5e7eb',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.max(0, Math.min(100, entry.sharePct))}%`,
                            height: '100%',
                            borderRadius: 999,
                            background: entry.isBrand ? '#1677ff' : '#f59e0b',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sentiment Distribution Bar */}
          <div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
              }}
            >
              <Typography.Text strong style={{ fontSize: 14 }}>
                本品牌情感倾向分布
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {metrics.sentimentSummary.total} 次情感评估
              </Typography.Text>
            </div>

            {metrics.sentimentSummary.total > 0 ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    width: '100%',
                    height: 10,
                    borderRadius: 999,
                    overflow: 'hidden',
                    background: '#f1f5f9',
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      width: `${(metrics.sentimentSummary.positive / metrics.sentimentSummary.total) * 100}%`,
                      background: '#0d9488',
                    }}
                  />
                  <div
                    style={{
                      width: `${(metrics.sentimentSummary.neutral / metrics.sentimentSummary.total) * 100}%`,
                      background: '#64748b',
                    }}
                  />
                  <div
                    style={{
                      width: `${(metrics.sentimentSummary.mixed / metrics.sentimentSummary.total) * 100}%`,
                      background: '#d97706',
                    }}
                  />
                  <div
                    style={{
                      width: `${(metrics.sentimentSummary.negative / metrics.sentimentSummary.total) * 100}%`,
                      background: '#e11d48',
                    }}
                  />
                </div>
              </>
            ) : null}

            <Space size={[6, 6]} wrap style={{ fontSize: 12 }}>
              <Tag color="cyan">正面 {metrics.sentimentSummary.positive}</Tag>
              <Tag>中性 {metrics.sentimentSummary.neutral}</Tag>
              <Tag color="orange">褒贬参半 {metrics.sentimentSummary.mixed}</Tag>
              <Tag color="red">负面 {metrics.sentimentSummary.negative}</Tag>
            </Space>
          </div>

          {/* Per-Engine Breakdown */}
          <div>
            <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 6 }}>
              各 AI 引擎可见度表现明细
            </Typography.Text>
            {engineBreakdown.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前条件下暂无分引擎观测明细
              </Typography.Text>
            ) : (
              <div style={{ width: '100%', overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    minWidth: 320,
                    borderCollapse: 'collapse',
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e6eaf0', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 4px', fontWeight: 500 }}>
                        引擎
                      </th>
                      <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500 }}>
                        观测数
                      </th>
                      <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500 }}>
                        提及率
                      </th>
                      <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500 }}>
                        平均顺位
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {engineBreakdown.map((item) => (
                      <tr key={item.engine} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 4px' }}>
                          {VISIBILITY_ENGINE_LABELS[item.engine] ?? item.engine}
                        </td>
                        <td style={{ textAlign: 'right', padding: '6px 4px' }}>
                          {item.mentionedChecks}/{item.completedChecks}
                        </td>
                        <td style={{ textAlign: 'right', padding: '6px 4px' }}>
                          <Tag
                            color={
                              item.visibilityPct >= 50
                                ? 'success'
                                : item.visibilityPct > 0
                                  ? 'processing'
                                  : 'default'
                            }
                            style={{ marginInlineEnd: 0 }}
                          >
                            {item.visibilityPct.toFixed(1)}%
                          </Tag>
                        </td>
                        <td style={{ textAlign: 'right', padding: '6px 4px' }}>
                          {item.avgPosition !== null ? `#${item.avgPosition.toFixed(1)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Analytics Tabs (Citations + extensible slot for Issue #60) */}
      <div
        style={{
          padding: 16,
          borderRadius: 10,
          border: '1px solid #e6eaf0',
          background: '#ffffff',
          minWidth: 0,
        }}
      >
        <Tabs
          activeKey={activeBottomTab}
          onChange={setActiveBottomTab}
          tabBarExtraContent={
            <Button size="small" onClick={goToMonitors}>
              去诊断明细查看更多
            </Button>
          }
          items={[
            {
              key: 'citations',
              label: `引用溯源（Citations · ${citationsData.totalCitations ?? allCitationTotal}）`,
              children: (
                <div style={{ minWidth: 0 }}>
                  {/* Source Category Breakdown Pills */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    <Button
                      size="small"
                      type={citationSourceKind === 'ALL' ? 'primary' : 'default'}
                      aria-label="来源分类-全部"
                      onClick={() => {
                        setCitationSourceKind('ALL');
                        setCitationPage(1);
                      }}
                    >
                      全部信源（{allCitationTotal}）
                    </Button>
                    {CITATION_SOURCE_KINDS.map((kind) => {
                      const count = breakdownCounts[kind] ?? 0;
                      const active = citationSourceKind === kind;
                      return (
                        <Button
                          key={kind}
                          size="small"
                          type={active ? 'primary' : 'default'}
                          aria-label={`来源分类-${CITATION_SOURCE_LABELS[kind]}`}
                          onClick={() => {
                            setCitationSourceKind(kind);
                            setCitationPage(1);
                          }}
                        >
                          {CITATION_SOURCE_LABELS[kind]}（{count}）
                        </Button>
                      );
                    })}
                  </div>

                  {/* Paginated Domain & URL Leaderboard */}
                  <div style={{ width: '100%', overflowX: 'auto' }}>
                    <Table<VisibilityCitationSummaryItem>
                      rowKey="domain"
                      size="middle"
                      loading={citationsLoading}
                      dataSource={citationsData.items}
                      scroll={{ x: 740 }}
                      locale={{
                        emptyText:
                          '当前筛选条件下暂无 AI 引用信源记录，完成可见度监测后将自动汇总高权重引用域名与具体落地页',
                      }}
                      pagination={{
                        current: citationPage,
                        pageSize: citationPageSize,
                        total: citationsData.total,
                        showSizeChanger: true,
                        pageSizeOptions: CRUD_PAGE_SIZES.map(String),
                        onChange: (nextPage, nextSize) => {
                          const normalized = normalizePageSize(nextSize);
                          setCitationPage(normalized === citationPageSize ? nextPage : 1);
                          setCitationPageSize(normalized);
                        },
                      }}
                      columns={[
                        {
                          key: 'rank',
                          title: '排名',
                          width: 68,
                          render: (_val, _row, index) =>
                            `#${(citationPage - 1) * citationPageSize + index + 1}`,
                        },
                        {
                          key: 'domain',
                          dataIndex: 'domain',
                          title: '引用域名',
                          width: 200,
                          render: (domain: string) => (
                            <Typography.Text strong>{domain}</Typography.Text>
                          ),
                        },
                        {
                          key: 'sourceKind',
                          dataIndex: 'sourceKind',
                          title: '信源分类',
                          width: 120,
                          render: (kind: CitationSourceKind) => (
                            <Tag color={citationSourceBadgeColor(kind)}>
                              {CITATION_SOURCE_LABELS[kind]}
                            </Tag>
                          ),
                        },
                        {
                          key: 'citationCount',
                          dataIndex: 'citationCount',
                          title: '被引用次数',
                          width: 110,
                          render: (count: number) => <strong>{count} 次</strong>,
                        },
                        {
                          key: 'questionCount',
                          dataIndex: 'questionCount',
                          title: '覆盖问题数',
                          width: 110,
                          render: (count: number) => `${count} 题`,
                        },
                        {
                          key: 'topUrls',
                          title: '热门被引用页面（Top URLs）',
                          render: (_val, row) => {
                            if (row.topUrls.length === 0) {
                              return <Typography.Text type="secondary">—</Typography.Text>;
                            }
                            const isExpanded = Boolean(expandedDomains[row.domain]);
                            const visibleUrls = isExpanded ? row.topUrls : row.topUrls.slice(0, 2);
                            return (
                              <div style={{ display: 'grid', gap: 4 }}>
                                {visibleUrls.map((u) => (
                                  <div key={u.url} style={{ fontSize: 12, wordBreak: 'break-all' }}>
                                    <Tag style={{ marginInlineEnd: 6 }}>{u.count} 次</Tag>
                                    {u.title ? (
                                      <strong style={{ marginInlineEnd: 6 }}>{u.title}</strong>
                                    ) : null}
                                    <span style={{ color: '#475569' }}>{u.url}</span>
                                  </div>
                                ))}
                                {row.topUrls.length > 2 ? (
                                  <div>
                                    <Button
                                      type="link"
                                      size="small"
                                      style={{ paddingInline: 0 }}
                                      onClick={() =>
                                        setExpandedDomains((curr) => ({
                                          ...curr,
                                          [row.domain]: !isExpanded,
                                        }))
                                      }
                                    >
                                      {isExpanded
                                        ? '收起页面列表'
                                        : `展开全部 ${row.topUrls.length} 个被引用页面`}
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            );
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
              ),
            },
            {
              key: 'opportunities',
              label: `优化机会 & 搜索拆解词（Query Fan-Out · ${opportunitiesData.gaps.length + opportunitiesData.fanOutQueries.length}）`,
              children: (
                <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
                  {/* Feedback Banner */}
                  {opportunityFeedback ? (
                    <Alert
                      type={opportunityFeedback.type}
                      message={opportunityFeedback.text}
                      showIcon
                      closable
                      onClose={() => setOpportunityFeedback(null)}
                    />
                  ) : null}

                  {/* Action Bar */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: '1px solid #e6eaf0',
                      background: '#f8fafc',
                    }}
                  >
                    <Space wrap size={8}>
                      <Typography.Text style={{ fontSize: 13 }}>目标主词：</Typography.Text>
                      <select
                        aria-label="目标主词"
                        style={{ ...COMPACT_SELECT_STYLE, minWidth: 180 }}
                        value={selectedKeywordId}
                        disabled={keywords.length === 0 || readOnly}
                        onChange={(e) => setSelectedKeywordId(e.target.value)}
                      >
                        {keywords.length === 0 ? (
                          <option value="">暂无可用主词</option>
                        ) : (
                          keywords.map((kw) => (
                            <option key={kw.id} value={kw.id}>
                              {kw.main}
                            </option>
                          ))
                        )}
                      </select>
                      <Tag color={selectedOpportunityTitles.length > 0 ? 'blue' : 'default'}>
                        已选 {selectedOpportunityTitles.length} 条
                      </Tag>
                      {selectedOpportunityTitles.length > 0 ? (
                        <Button
                          size="small"
                          onClick={() => setSelectedOpportunityTitles([])}
                          disabled={importingQuestions}
                        >
                          清空勾选
                        </Button>
                      ) : null}
                    </Space>

                    <Space wrap size={8}>
                      <Button
                        type="primary"
                        loading={importingQuestions}
                        disabled={
                          readOnly ||
                          selectedOpportunityTitles.length === 0 ||
                          !selectedKeywordId ||
                          importingQuestions
                        }
                        onClick={() => void handleImportOpportunityQuestions()}
                      >
                        一键加入写作标题
                      </Button>
                      <Button onClick={goToWritingTasks}>去创建写作任务</Button>
                    </Space>
                  </div>

                  {/* Section 1: Competitor Gaps */}
                  <div style={{ minWidth: 0 }}>
                    <Typography.Text
                      strong
                      style={{ fontSize: 14, display: 'block', marginBottom: 8 }}
                    >
                      竞品命中但本品牌未提及（内容缺口问题）
                    </Typography.Text>
                    <div style={{ width: '100%', overflowX: 'auto' }}>
                      <Table<VisibilityOpportunityGapItem>
                        rowKey="promptText"
                        size="small"
                        loading={opportunitiesLoading}
                        dataSource={opportunitiesData.gaps}
                        pagination={false}
                        scroll={{ x: 680 }}
                        locale={{
                          emptyText: '当前筛选条件下暂无竞品命中但本品牌未提及的缺口问题',
                        }}
                        columns={[
                          {
                            key: 'select',
                            title: '选择',
                            width: 56,
                            render: (_val, row) => (
                              <Checkbox
                                aria-label={`勾选缺口问题-${row.promptText}`}
                                checked={selectedOpportunityTitles.includes(row.promptText)}
                                disabled={readOnly}
                                onChange={(e) =>
                                  toggleOpportunityTitle(row.promptText, e.target.checked)
                                }
                              />
                            ),
                          },
                          {
                            key: 'promptText',
                            dataIndex: 'promptText',
                            title: '缺口问题（Prompt）',
                            render: (text: string) => (
                              <Typography.Text strong>{text}</Typography.Text>
                            ),
                          },
                          {
                            key: 'competitors',
                            dataIndex: 'competitors',
                            title: '命中竞品',
                            width: 200,
                            render: (comps: string[]) => (
                              <Space size={[4, 4]} wrap>
                                {comps.map((c) => (
                                  <Tag key={c} color="orange" style={{ marginInlineEnd: 0 }}>
                                    {c}
                                  </Tag>
                                ))}
                              </Space>
                            ),
                          },
                          {
                            key: 'engines',
                            dataIndex: 'engines',
                            title: '出现引擎',
                            width: 180,
                            render: (engines: VisibilityEngineKey[]) => (
                              <Space size={[4, 4]} wrap>
                                {engines.map((eng) => (
                                  <Tag key={eng} style={{ marginInlineEnd: 0 }}>
                                    {VISIBILITY_ENGINE_LABELS[eng] ?? eng}
                                  </Tag>
                                ))}
                              </Space>
                            ),
                          },
                          {
                            key: 'observationCount',
                            dataIndex: 'observationCount',
                            title: '出现次数',
                            width: 96,
                            render: (count: number) => `${count} 次`,
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Section 2: Query Fan-Out */}
                  <div style={{ minWidth: 0 }}>
                    <Typography.Text
                      strong
                      style={{ fontSize: 14, display: 'block', marginBottom: 8 }}
                    >
                      高频搜索拆解词（Query Fan-Out）
                    </Typography.Text>
                    <div style={{ width: '100%', overflowX: 'auto' }}>
                      <Table<VisibilityFanOutItem>
                        rowKey="query"
                        size="small"
                        loading={opportunitiesLoading}
                        dataSource={opportunitiesData.fanOutQueries}
                        pagination={false}
                        scroll={{ x: 680 }}
                        locale={{
                          emptyText: '当前筛选条件下暂无 AI 引擎搜索拆解词（Query Fan-Out）记录',
                        }}
                        columns={[
                          {
                            key: 'select',
                            title: '选择',
                            width: 56,
                            render: (_val, row) => (
                              <Checkbox
                                aria-label={`勾选拆解词-${row.query}`}
                                checked={selectedOpportunityTitles.includes(row.query)}
                                disabled={readOnly}
                                onChange={(e) =>
                                  toggleOpportunityTitle(row.query, e.target.checked)
                                }
                              />
                            ),
                          },
                          {
                            key: 'query',
                            dataIndex: 'query',
                            title: '搜索拆解词（Fan-Out Query）',
                            width: 240,
                            render: (q: string) => <Typography.Text strong>{q}</Typography.Text>,
                          },
                          {
                            key: 'frequency',
                            dataIndex: 'frequency',
                            title: '出现频次',
                            width: 96,
                            render: (freq: number) => <Tag color="blue">{freq} 次</Tag>,
                          },
                          {
                            key: 'brandMentionedPct',
                            dataIndex: 'brandMentionedPct',
                            title: '品牌覆盖率',
                            width: 110,
                            render: (pct?: number) =>
                              typeof pct === 'number' ? `${pct.toFixed(1)}%` : '—',
                          },
                          {
                            key: 'engines',
                            dataIndex: 'engines',
                            title: '引擎',
                            width: 160,
                            render: (engines: VisibilityEngineKey[]) => (
                              <Space size={[4, 4]} wrap>
                                {engines.map((eng) => (
                                  <Tag key={eng} style={{ marginInlineEnd: 0 }}>
                                    {VISIBILITY_ENGINE_LABELS[eng] ?? eng}
                                  </Tag>
                                ))}
                              </Space>
                            ),
                          },
                          {
                            key: 'sourcePrompts',
                            dataIndex: 'sourcePrompts',
                            title: '来源问题预览',
                            render: (prompts: string[]) =>
                              prompts.length > 0 ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {prompts.join('；')}
                                </Typography.Text>
                              ) : (
                                '—'
                              ),
                          },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              ),
            },
            ...(extraAnalyticsTabs ?? []).map((spec) => ({
              key: spec.key,
              label: spec.label,
              children: spec.render(filterContext),
            })),
          ]}
        />
      </div>
    </section>
  );
}
