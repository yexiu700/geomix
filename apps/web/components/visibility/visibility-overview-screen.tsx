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
  type VisibilityBrandShareOfVoiceGroup,
  type VisibilityTrendPoint,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Space, Table, Tabs, Tooltip, Typography, message } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM, formatPct, truncateMiddle } from '../../lib/design-tokens';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { sanitizeEntityTitleSegment, useSyncTabTitle } from '../../lib/ux-foundation';
import { httpVisibilityGateway, type VisibilityGateway } from '../../lib/visibility';
import { TableClampText } from '../crud/table-clamp-text';
import {
  EngineChipList,
  SignalEmpty,
  SignalError,
  SignalKpiCard,
  SignalPill,
  SignalSkeleton,
  SourceKindChip,
} from '../geo/primitives';
import { SonarDial } from '../geo/sonar-dial';

const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';
const SKIP_DEFAULT_PROFILE_ONCE_KEY = 'geomix:visibility:overview:skip-default-once';

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
  maxWidth: '100%',
};

const DATE_INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
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

type TrendSeriesPoint = VisibilityTrendPoint;

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

function getPointSovPct(pt: TrendSeriesPoint): number | null {
  if (pt.completedChecks <= 0) return null;
  if (typeof pt.shareOfVoicePct === 'number' && Number.isFinite(pt.shareOfVoicePct)) {
    return pt.shareOfVoicePct;
  }
  return null;
}

function VisibilityTrendChartSvg({
  points,
  activeIndex,
  onHoverIndex,
}: {
  points: TrendSeriesPoint[];
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

  const sovSegments: string[][] = [];
  let currentSovSegment: string[] = [];
  points.forEach((pt, idx) => {
    const sov = getPointSovPct(pt);
    if (sov === null) {
      if (currentSovSegment.length > 0) {
        sovSegments.push(currentSovSegment);
        currentSovSegment = [];
      }
      return;
    }
    const cx = padLeft + idx * colW + colW / 2;
    currentSovSegment.push(`${cx},${yPct(sov)}`);
  });
  if (currentSovSegment.length > 0) {
    sovSegments.push(currentSovSegment);
  }

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
              stroke={GM.chart.grid}
              strokeDasharray={tick === 0 ? undefined : '4 4'}
            />
            <text
              x={padLeft - 8}
              y={y + 4}
              textAnchor="end"
              fontSize="11"
              className="gm-num"
              fill={GM.chart.axis}
            >
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
              fill={isHovered ? GM.bg.hover : 'transparent'}
            />
            <rect
              x={barX}
              y={pt.completedChecks > 0 ? totalTop : padTop + plotH - 2}
              width={barW}
              height={pt.completedChecks > 0 ? totalH : 2}
              rx={3}
              fill="rgba(255,255,255,0.08)"
            />
            {pt.mentionedChecks > 0 ? (
              <rect
                x={barX}
                y={mentionTop}
                width={barW}
                height={mentionH}
                rx={3}
                fill="rgba(61,224,200,0.32)"
              />
            ) : null}
            {idx % labelStep === 0 || idx === points.length - 1 ? (
              <text
                x={cx}
                y={height - 12}
                textAnchor="middle"
                fontSize="11"
                className="gm-num"
                fill={isHovered ? GM.fg.f1 : GM.chart.axis}
                fontWeight={isHovered ? '600' : '400'}
              >
                {formatShortDate(pt.date)}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Share of Voice % dashed polylines (gapped when sample count is 0) */}
      {sovSegments.map((seg, segIdx) =>
        seg.length > 1 ? (
          <polyline
            key={`sov-seg-${segIdx}`}
            data-testid="visibility-sov-line"
            fill="none"
            stroke={GM.chart.c1}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            points={seg.join(' ')}
          />
        ) : null,
      )}

      {/* Visibility % solid polyline */}
      {points.length > 1 ? (
        <polyline fill="none" stroke={GM.sig.cited} strokeWidth="2" points={visPolyline} />
      ) : null}

      {/* Data nodes */}
      {points.map((pt, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const cy = yPct(pt.visibilityPct);
        const sov = getPointSovPct(pt);
        const isHovered = activeIndex === idx;
        return (
          <g key={`${pt.date}-nodes`} onMouseEnter={() => onHoverIndex(idx)}>
            {sov !== null ? (
              <circle
                data-testid={`visibility-sov-node-${pt.date}`}
                cx={cx}
                cy={yPct(sov)}
                r={isHovered ? 4.5 : 3}
                fill={GM.bg.surface}
                stroke={GM.chart.c1}
                strokeWidth="1.5"
                className="gm-trend-node"
              />
            ) : null}
            <circle
              cx={cx}
              cy={cy}
              r={isHovered ? 4.5 : 3}
              fill={GM.bg.surface}
              stroke={GM.sig.cited}
              strokeWidth="2"
              className="gm-trend-node"
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
  const [profilesLoaded, setProfilesLoaded] = useState(false);
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
  const [citationsError, setCitationsError] = useState<string | null>(null);
  const [citationRetryTick, setCitationRetryTick] = useState<number>(0);
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

  const userInteractedProfileRef = useRef(false);
  const initialUrlProfileIdRef = useRef(urlProfileId);
  const skipDefaultProfileRef = useRef<boolean>(false);
  const profileSelectRef = useRef<HTMLSelectElement | null>(null);

  const syncProfileRoute = useCallback(
    (nextProfileId: string) => {
      if (!nextProfileId) {
        try {
          effectiveStorage.setItem(SKIP_DEFAULT_PROFILE_ONCE_KEY, '1');
        } catch {
          // ignore storage errors
        }
      } else {
        try {
          effectiveStorage.removeItem(SKIP_DEFAULT_PROFILE_ONCE_KEY);
        } catch {
          // ignore storage errors
        }
      }
      if (!tabId || !onDispatch) return;
      const targetHref = nextProfileId
        ? `/visibility/overview?profileId=${encodeURIComponent(nextProfileId)}`
        : '/visibility/overview';
      if (href !== targetHref && tabId !== targetHref) {
        onDispatch({ type: 'navigate', id: tabId, href: targetHref });
      }
    },
    [effectiveStorage, href, onDispatch, tabId],
  );

  // Sync URL ?profileId=... if changed externally
  useEffect(() => {
    if (!urlProfileId) return;
    setFilterDraft((curr) =>
      curr.profileId === urlProfileId ? curr : { ...curr, profileId: urlProfileId },
    );
    setAppliedFilter((curr) =>
      curr.profileId === urlProfileId ? curr : { ...curr, profileId: urlProfileId },
    );
  }, [urlProfileId]);

  // Keep native <select> DOM value strictly synchronized across async profile loading & tab switches
  useEffect(() => {
    const el = profileSelectRef.current;
    if (el && el.value !== filterDraft.profileId) {
      el.value = filterDraft.profileId;
    }
  }, [filterDraft.profileId, profiles, profilesLoaded]);

  // Load profiles list and optionally initialize default profile if URL didn't specify one
  useEffect(() => {
    if (!featureEnabled) return;
    let cancelled = false;
    try {
      if (effectiveStorage.getItem(SKIP_DEFAULT_PROFILE_ONCE_KEY) === '1') {
        skipDefaultProfileRef.current = true;
        effectiveStorage.removeItem(SKIP_DEFAULT_PROFILE_ONCE_KEY);
      }
    } catch {
      // ignore storage errors
    }
    void client
      .listProfiles()
      .then((res) => {
        if (cancelled) return;
        setProfiles(res.items);
        setProfilesLoaded(true);
        if (
          !initialUrlProfileIdRef.current &&
          !userInteractedProfileRef.current &&
          !skipDefaultProfileRef.current &&
          res.items.length > 0
        ) {
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
      .catch(() => {
        if (!cancelled) setProfilesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, effectiveStorage, featureEnabled]);

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
    setCitationsError(null);

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
        setCitationsError(err instanceof Error ? err.message : '加载引用溯源排行榜失败');
      })
      .finally(() => {
        if (!cancelled) setCitationsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    appliedFilter,
    citationPage,
    citationPageSize,
    citationRetryTick,
    citationSourceKind,
    client,
    featureEnabled,
  ]);

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
    userInteractedProfileRef.current = true;
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
    syncProfileRoute('');
  }, [syncProfileRoute]);

  const handleSelectEngine = useCallback((eng: VisibilityEngineKey | undefined) => {
    const nextEngine = eng ?? '';
    setFilterError(null);
    setFilterDraft((curr) => ({ ...curr, engine: nextEngine }));
    setCitationPage(1);
    setAppliedFilter((curr) => ({ ...curr, engine: nextEngine }));
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

  const maxCitationCount = useMemo(
    () => citationsData.items.reduce((acc, item) => Math.max(acc, item.citationCount), 0),
    [citationsData.items],
  );

  const baseTitle = useMemo(() => {
    const sepIdx = title.indexOf(' · ');
    return sepIdx > 0 ? title.slice(0, sepIdx) : title || 'AI数据看板';
  }, [title]);

  const resolvedTitle = useMemo(() => {
    if (!appliedFilter.profileId) {
      return baseTitle;
    }
    const activeProfile = profiles.find((p) => p.id === appliedFilter.profileId);
    if (activeProfile) {
      return `${baseTitle} · ${activeProfile.name}`;
    }
    const safeIdSegment = sanitizeEntityTitleSegment(appliedFilter.profileId, '当前监测档案');
    const segment = safeIdSegment === '当前监测档案' ? '当前监测档案' : `档案 ${safeIdSegment}`;
    return `${baseTitle} · ${segment}`;
  }, [appliedFilter.profileId, baseTitle, profiles]);

  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  if (!featureEnabled) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {resolvedTitle}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="当前站点尚未开启 AI 数据看板功能，如需启用请联系管理员开启 FEATURE_VISIBILITY。"
        />
      </section>
    );
  }

  const selectedDialEngine = isVisibilityEngine(appliedFilter.engine)
    ? appliedFilter.engine
    : undefined;

  if (
    profilesLoaded &&
    profiles.length === 0 &&
    !overviewLoading &&
    metrics.completedChecks === 0 &&
    !bannerError
  ) {
    return (
      <section style={{ minWidth: 0 }}>
        <div className="gm-overview-header">
          <div>
            <h1 className="gm-overview-title">{resolvedTitle}</h1>
            <div className="gm-overview-desc">
              全景追踪企业品牌在各大生成式 AI 引擎中的提及率、行业声量占比（Share of
              Voice）、推荐顺位与引用信源分布
            </div>
          </div>
          <Button type="primary" aria-label="发起可见度诊断" onClick={goToMonitors}>
            发起可见度诊断
          </Button>
        </div>
        <div className="gm-panel">
          <SignalEmpty
            title="暂无品牌监测档案"
            description="创建监测档案并发起多引擎可见度诊断后，即可在此查看 AI 提及率、声呐盘与引用溯源。"
            actionText="发起可见度诊断"
            onAction={goToMonitors}
          />
        </div>
      </section>
    );
  }

  const sentimentTotal = metrics.sentimentSummary.total;
  const sentimentRows = [
    {
      key: 'positive',
      label: '正面',
      count: metrics.sentimentSummary.positive,
      color: GM.sentiment.positive,
    },
    {
      key: 'neutral',
      label: '中性',
      count: metrics.sentimentSummary.neutral,
      color: GM.sentiment.neutral,
    },
    {
      key: 'mixed',
      label: '褒贬参半',
      count: metrics.sentimentSummary.mixed,
      color: GM.sentiment.mixed,
    },
    {
      key: 'negative',
      label: '负面',
      count: metrics.sentimentSummary.negative,
      color: GM.sentiment.negative,
    },
  ];

  return (
    <section style={{ minWidth: 0 }}>
      {/* Page Header */}
      <div className="gm-overview-header">
        <div>
          <h1 className="gm-overview-title">{resolvedTitle}</h1>
          <div className="gm-overview-desc">
            全景追踪企业品牌在各大生成式 AI 引擎中的提及率、行业声量占比（Share of
            Voice）、推荐顺位与引用信源分布
          </div>
        </div>
        <Button type="primary" aria-label="发起可见度诊断" onClick={goToMonitors}>
          发起可见度诊断
        </Button>
      </div>

      {/* Top Filter Bar */}
      <div
        className="gm-filterbar"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleApplySearch();
          }
        }}
      >
        {(() => {
          const activeProf = filterDraft.profileId
            ? profiles.find((p) => p.id === filterDraft.profileId)
            : undefined;
          const hasMatchingOption = !filterDraft.profileId || Boolean(activeProf);
          const profileTitle = activeProf
            ? `${activeProf.name}（${activeProf.brandName}）`
            : filterDraft.profileId
              ? !profilesLoaded
                ? '正在加载监测档案…'
                : '当前监测档案'
              : '全部监测档案';
          return (
            <select
              ref={profileSelectRef}
              aria-label="看板监测档案"
              title={profileTitle}
              style={{
                ...COMPACT_SELECT_STYLE,
                minWidth: 220,
                maxWidth: 320,
                width: 'auto',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              value={filterDraft.profileId}
              onChange={(e) => {
                const nextProfileId = e.target.value;
                userInteractedProfileRef.current = true;
                setFilterError(null);
                setCitationPage(1);
                const nextDraft: OverviewFilterState = {
                  ...filterDraft,
                  profileId: nextProfileId,
                };
                setFilterDraft(nextDraft);
                if (nextDraft.from && nextDraft.to && nextDraft.from > nextDraft.to) {
                  setAppliedFilter((curr) => ({ ...curr, profileId: nextProfileId }));
                } else {
                  setAppliedFilter(nextDraft);
                }
                syncProfileRoute(nextProfileId);
              }}
            >
              <option value="">全部监测档案</option>
              {!hasMatchingOption ? (
                <option value={filterDraft.profileId}>
                  {!profilesLoaded ? '正在加载监测档案…' : '当前监测档案'}
                </option>
              ) : null}
              {profiles.map((prof) => (
                <option key={prof.id} value={prof.id}>
                  {prof.name}（{prof.brandName}）
                </option>
              ))}
            </select>
          );
        })()}

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
              <button
                key={dayNum}
                type="button"
                className={isSelected ? 'gm-day-pill gm-day-pill-active' : 'gm-day-pill'}
                aria-label={`近${dayNum}天`}
                aria-pressed={isSelected}
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
              </button>
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
          <span style={{ color: GM.fg.f3, fontSize: 12 }}>至</span>
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
      <div className="gm-overview-kpi-grid">
        <SignalKpiCard
          testId="kpi-visibility"
          label="品牌提及率（Visibility %）"
          value={formatPct(metrics.visibilityPct)}
          tone="cited"
          numerator={metrics.mentionedChecks}
          denominator={metrics.completedChecks}
          caption="提及 / 有效观测"
          loading={overviewLoading}
        />
        <SignalKpiCard
          testId="kpi-sov"
          label="品牌声量占比（Share of Voice %）"
          value={formatPct(metrics.shareOfVoice.brandSharePct)}
          tone="cited"
          numerator={metrics.shareOfVoice.brandMentions}
          denominator={metrics.shareOfVoice.totalMentions}
          caption="本品牌 / 赛道总声量"
          loading={overviewLoading}
        />
        <SignalKpiCard
          testId="kpi-position"
          label="平均推荐顺位（Avg Position）"
          value={metrics.avgPosition !== null ? `#${metrics.avgPosition.toFixed(1)}` : '—'}
          tone="info"
          caption={
            metrics.avgPosition !== null
              ? '顺位越靠前代表 AI 首推权重越高'
              : '当前筛选周期内暂无命中顺位'
          }
          loading={overviewLoading}
        />
        <SignalKpiCard
          testId="kpi-owned-citation"
          label="自有域名引用率（Owned Citation %）"
          value={formatPct(metrics.ownedCitationRatePct)}
          tone="cited"
          numerator={metrics.ownedCitations}
          denominator={metrics.totalCitations}
          caption={`自有引用 · 正面情感 ${metrics.sentimentSummary.positivePct.toFixed(1)}%`}
          loading={overviewLoading}
        />
      </div>

      {/* Main Analysis Grid: Left SonarDial (360px) + Right Trend & SoV/Sentiment */}
      <div className="gm-overview-main-grid">
        {/* Left: Engine Coverage SonarDial */}
        <div className="gm-panel">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div>
              <div className="gm-panel-title">引擎覆盖</div>
              <div className="gm-panel-sub">
                {selectedDialEngine
                  ? `已筛选：${VISIBILITY_ENGINE_LABELS[selectedDialEngine] ?? selectedDialEngine}（再点取消）`
                  : '点击辐条可按 AI 引擎联动筛选'}
              </div>
            </div>
            {selectedDialEngine ? (
              <Button size="small" onClick={() => handleSelectEngine(undefined)}>
                清除引擎
              </Button>
            ) : null}
          </div>

          <SonarDial
            byEngine={engineBreakdown}
            overallPct={metrics.visibilityPct}
            selectedEngine={selectedDialEngine}
            onSelectEngine={handleSelectEngine}
            loading={overviewLoading}
          />

          <div className="gm-sonar-legend">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: GM.sig.cited,
                  display: 'inline-block',
                }}
              />
              已提及
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  border: `1px dashed ${GM.sig.absent}`,
                  display: 'inline-block',
                }}
              />
              未观测
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: GM.phosphor, fontSize: 10, lineHeight: 1 }}>▲</span>
              扫描
            </span>
          </div>
        </div>

        {/* Right Stack: Trend Card + SoV/Sentiment Card */}
        <div className="gm-overview-right-stack">
          {/* Upper Card: Visibility & SoV Trend */}
          <div className="gm-panel">
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
                <div className="gm-panel-title">可见度与声量变化趋势</div>
                <div className="gm-panel-sub gm-num">
                  {activeTrendPoint
                    ? `${activeTrendPoint.date}：检测 ${activeTrendPoint.completedChecks} 次 · 提及 ${activeTrendPoint.mentionedChecks} 次 · 提及率 ${activeTrendPoint.visibilityPct.toFixed(1)}% · 声量占比 ${
                        getPointSovPct(activeTrendPoint) !== null
                          ? `${getPointSovPct(activeTrendPoint)!.toFixed(1)}%`
                          : '—'
                      }`
                    : '展示周期内每日品牌提及率（实线）、声量占比（虚线）与有效检测量（柱状）'}
                </div>
              </div>
              <Space size={10} wrap style={{ fontSize: 12, color: GM.fg.f2 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    style={{
                      width: 10,
                      height: 2,
                      background: GM.sig.cited,
                      display: 'inline-block',
                    }}
                  />
                  提及率 %
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    style={{
                      width: 10,
                      height: 2,
                      borderTop: `1.5px dashed ${GM.chart.c1}`,
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
                      background: 'rgba(61,224,200,0.32)',
                      display: 'inline-block',
                    }}
                  />
                  检测/提及量
                </span>
              </Space>
            </div>

            {overviewLoading ? (
              <SignalSkeleton variant="block" height={220} />
            ) : !hasTrendActivity ? (
              <div data-testid="visibility-trend-empty">
                <SignalEmpty
                  title="当前筛选范围内暂无有效 AI 检测趋势记录"
                  description="切换时间窗口或前往「AI可见度诊断」发起新一轮多引擎监测后即可查看趋势曲线。"
                />
              </div>
            ) : (
              <VisibilityTrendChartSvg
                points={dailyTrendSeries}
                activeIndex={hoveredTrendIdx}
                onHoverIndex={setHoveredTrendIdx}
              />
            )}
          </div>

          {/* Lower Card: Share of Voice + Sentiment */}
          <div className="gm-panel">
            <div className="gm-overview-subgrid">
              {/* Left: Competitor Share of Voice */}
              <div style={{ minWidth: 0 }}>
                <div className="gm-panel-title" style={{ marginBottom: 8 }}>
                  品牌 vs 竞品声量对比榜（Share of Voice）
                </div>
                {(() => {
                  const brandGroups: VisibilityBrandShareOfVoiceGroup[] =
                    overviewData.brandGroups ?? [];
                  const renderSovRow = (
                    entry: RecomputedRunMetrics['shareOfVoice']['entries'][number],
                    idx: number,
                    denominatorChecks: number,
                  ) => {
                    const visPct = computeVisibilityPct(entry.mentions, denominatorChecks);
                    return (
                      <Tooltip
                        key={`${entry.isBrand ? 'brand' : 'comp'}-${entry.name}-${idx}`}
                        title={`提及 ${entry.mentions} 次 · 可见率 ${visPct.toFixed(1)}%`}
                      >
                        <div
                          data-testid={
                            entry.isBrand ? 'sov-brand-row' : `sov-comp-row-${entry.name}`
                          }
                          className="gm-sov-row"
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              minWidth: 0,
                            }}
                          >
                            <Tooltip title={entry.name}>
                              <span
                                className="gm-clamp-1"
                                style={{ fontSize: 13, color: GM.fg.f1 }}
                              >
                                {entry.name}
                              </span>
                            </Tooltip>
                            {entry.isBrand ? <SignalPill tone="cited">我方</SignalPill> : null}
                          </div>
                          <div className="gm-sov-track">
                            <div
                              className="gm-sov-fill"
                              style={{
                                width: `${Math.max(0, Math.min(100, entry.sharePct))}%`,
                                background: entry.isBrand ? GM.sig.cited : GM.sig.competitor,
                              }}
                            />
                          </div>
                          <span
                            className="gm-num"
                            style={{
                              fontSize: 12,
                              textAlign: 'right',
                              color: entry.isBrand ? GM.sig.cited : GM.fg.f2,
                            }}
                          >
                            <span className="gm-sr-only">{`声量 ${entry.sharePct.toFixed(1)}%`}</span>
                            <span aria-hidden="true">{entry.sharePct.toFixed(1)}%</span>
                          </span>
                        </div>
                      </Tooltip>
                    );
                  };

                  if (brandGroups.length > 1) {
                    return (
                      <div style={{ display: 'grid', gap: 10 }}>
                        {brandGroups.map((group) => (
                          <div
                            key={group.brandName}
                            data-testid={`sov-group-${group.brandName}`}
                            style={{
                              display: 'grid',
                              gap: 4,
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: '1px solid var(--gm-line-1)',
                              background: 'var(--gm-bg-elevated)',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                flexWrap: 'wrap',
                                marginBottom: 2,
                              }}
                            >
                              <span style={{ fontSize: 12, fontWeight: 600, color: GM.fg.f1 }}>
                                {group.brandName}
                              </span>
                              <span className="gm-num" style={{ fontSize: 11, color: GM.fg.f3 }}>
                                观测 {group.completedChecks} 次 · 提及率{' '}
                                {group.visibilityPct.toFixed(1)}%
                              </span>
                            </div>
                            {group.shareOfVoice.entries.map((entry, idx) =>
                              renderSovRow(entry, idx, group.completedChecks),
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  }

                  if (metrics.shareOfVoice.entries.length === 0) {
                    return <SignalEmpty title="暂无品牌与竞品对比数据" />;
                  }

                  return (
                    <div style={{ display: 'grid', gap: 4 }}>
                      {metrics.shareOfVoice.entries.map((entry, idx) =>
                        renderSovRow(entry, idx, metrics.completedChecks),
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Right: Sentiment Distribution */}
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  <div className="gm-panel-title">本品牌情感倾向分布</div>
                  <div className="gm-panel-sub gm-num">共 {sentimentTotal} 次情感评估</div>
                </div>

                {sentimentTotal > 0 ? (
                  <div className="gm-sentiment-bar">
                    {sentimentRows.map((row) =>
                      row.count > 0 ? (
                        <div
                          key={row.key}
                          style={{
                            width: `${(row.count / sentimentTotal) * 100}%`,
                            background: row.color,
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                ) : (
                  <div className="gm-sentiment-bar" />
                )}

                <div className="gm-sentiment-legend">
                  {sentimentRows.map((row) => {
                    const pct = sentimentTotal > 0 ? (row.count / sentimentTotal) * 100 : 0;
                    return (
                      <div
                        key={row.key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                          color: GM.fg.f2,
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: row.color,
                              flex: 'none',
                            }}
                          />
                          <span>{row.label}</span>
                        </span>
                        <span className="gm-num" style={{ color: GM.fg.f1 }}>
                          {row.count} ({pct.toFixed(1)}%)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Analytics Tabs (Citations + Opportunities + extensible slot) */}
      <div className="gm-panel">
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
                    <button
                      type="button"
                      className={
                        citationSourceKind === 'ALL'
                          ? 'gm-source-pill-btn gm-source-pill-btn-active'
                          : 'gm-source-pill-btn'
                      }
                      aria-label="来源分类-全部"
                      aria-pressed={citationSourceKind === 'ALL'}
                      onClick={() => {
                        setCitationSourceKind('ALL');
                        setCitationPage(1);
                      }}
                    >
                      <span>全部信源</span>
                      <span className="gm-num">（{allCitationTotal}）</span>
                    </button>
                    {CITATION_SOURCE_KINDS.map((kind) => {
                      const count = breakdownCounts[kind] ?? 0;
                      const active = citationSourceKind === kind;
                      return (
                        <button
                          key={kind}
                          type="button"
                          className={
                            active
                              ? 'gm-source-pill-btn gm-source-pill-btn-active'
                              : 'gm-source-pill-btn'
                          }
                          aria-label={`来源分类-${CITATION_SOURCE_LABELS[kind]}`}
                          aria-pressed={active}
                          onClick={() => {
                            setCitationSourceKind(kind);
                            setCitationPage(1);
                          }}
                        >
                          <SourceKindChip kind={kind} />
                          <span className="gm-num">（{count}）</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Paginated Domain & URL Leaderboard */}
                  {citationsError ? (
                    <SignalError
                      message={citationsError}
                      onRetry={() => setCitationRetryTick((t) => t + 1)}
                    />
                  ) : citationsLoading && citationsData.items.length === 0 ? (
                    <SignalSkeleton variant="row" rows={5} />
                  ) : (
                    <div className="gm-table-scroll">
                      <Table<VisibilityCitationSummaryItem>
                        rowKey="domain"
                        size="middle"
                        loading={citationsLoading}
                        dataSource={citationsData.items}
                        scroll={{ x: 980 }}
                        locale={{
                          emptyText: (
                            <SignalEmpty title="当前筛选条件下暂无 AI 引用信源记录，完成可见度监测后将自动汇总高权重引用域名与具体落地页" />
                          ),
                        }}
                        pagination={{
                          current: citationPage,
                          pageSize: citationPageSize,
                          total: citationsData.total,
                          showSizeChanger: true,
                          showTotal: (count) => `共 ${count} 条`,
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
                            width: 64,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (_val, _row, index) => (
                              <span className="gm-num" style={{ color: GM.fg.f3 }}>
                                #{(citationPage - 1) * citationPageSize + index + 1}
                              </span>
                            ),
                          },
                          {
                            key: 'domain',
                            dataIndex: 'domain',
                            title: '引用域名',
                            width: 220,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (domain: string) => {
                              const truncated =
                                domain.length > 40 ? truncateMiddle(domain, 40) : domain;
                              return domain.length > 40 ? (
                                <Tooltip title={domain}>
                                  <span className="gm-mono" style={{ color: GM.fg.f1 }}>
                                    {truncated}
                                  </span>
                                </Tooltip>
                              ) : (
                                <span className="gm-mono" style={{ color: GM.fg.f1 }}>
                                  {domain}
                                </span>
                              );
                            },
                          },
                          {
                            key: 'sourceKind',
                            dataIndex: 'sourceKind',
                            title: '信源分类',
                            width: 120,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (kind: CitationSourceKind) => <SourceKindChip kind={kind} />,
                          },
                          {
                            key: 'citationCount',
                            dataIndex: 'citationCount',
                            title: '被引用次数',
                            width: 120,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (count: number) => {
                              const pct =
                                maxCitationCount > 0
                                  ? Math.round((count / maxCitationCount) * 100)
                                  : 0;
                              return (
                                <div
                                  className="gm-count-bar-cell gm-num"
                                  style={{ '--p': `${pct}%` } as CSSProperties}
                                >
                                  {count} 次
                                </div>
                              );
                            },
                          },
                          {
                            key: 'questionCount',
                            dataIndex: 'questionCount',
                            title: '覆盖问题数',
                            width: 110,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (count: number) => <span className="gm-num">{count} 题</span>,
                          },
                          {
                            key: 'topUrls',
                            title: '热门被引用页面（Top URLs）',
                            width: 340,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (_val, row) => {
                              if (row.topUrls.length === 0) {
                                return <span style={{ color: GM.fg.f3 }}>—</span>;
                              }
                              const isExpanded = Boolean(expandedDomains[row.domain]);
                              const visibleUrls = isExpanded
                                ? row.topUrls
                                : row.topUrls.slice(0, 2);
                              return (
                                <div style={{ display: 'grid', gap: 4 }}>
                                  {visibleUrls.map((u) => (
                                    <div
                                      key={u.url}
                                      style={{
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        alignItems: 'center',
                                        gap: 6,
                                        fontSize: 12,
                                      }}
                                    >
                                      <span className="gm-num" style={{ color: GM.fg.f3 }}>
                                        {u.count} 次
                                      </span>
                                      {u.title ? (
                                        <span style={{ color: GM.fg.f1, fontWeight: 500 }}>
                                          {u.title}
                                        </span>
                                      ) : null}
                                      <Tooltip title={u.url}>
                                        <a
                                          href={u.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="gm-mono"
                                          style={{ color: GM.status.info }}
                                        >
                                          {truncateMiddle(u.url, 56)}
                                        </a>
                                      </Tooltip>
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
                  )}
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
                    className="gm-filterbar"
                    style={{ justifyContent: 'space-between', marginBottom: 0 }}
                  >
                    <Space wrap size={8}>
                      <span style={{ fontSize: 13, color: GM.fg.f2 }}>目标主词：</span>
                      <select
                        aria-label="目标主词"
                        style={{
                          ...COMPACT_SELECT_STYLE,
                          minWidth: 180,
                          maxWidth: 280,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
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
                      <SignalPill tone={selectedOpportunityTitles.length > 0 ? 'info' : 'neutral'}>
                        <span className="gm-num">已选 {selectedOpportunityTitles.length} 条</span>
                      </SignalPill>
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
                    <div className="gm-panel-title" style={{ marginBottom: 8 }}>
                      竞品命中但本品牌未提及（内容缺口问题）
                    </div>
                    <div className="gm-table-scroll">
                      <Table<VisibilityOpportunityGapItem>
                        rowKey="promptText"
                        size="small"
                        loading={opportunitiesLoading}
                        dataSource={opportunitiesData.gaps}
                        pagination={false}
                        scroll={{ x: 920 }}
                        locale={{
                          emptyText: (
                            <SignalEmpty title="当前筛选条件下暂无竞品命中但本品牌未提及的缺口问题" />
                          ),
                        }}
                        columns={[
                          {
                            key: 'select',
                            title: '选择',
                            width: 56,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
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
                            width: 340,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (text: string) => (
                              <TableClampText
                                text={text}
                                lines={2}
                                strong
                                maxWidth={320}
                                style={{ color: GM.fg.f1 }}
                              />
                            ),
                          },
                          {
                            key: 'competitors',
                            dataIndex: 'competitors',
                            title: '命中竞品',
                            width: 220,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (comps: string[]) => (
                              <Space size={[4, 4]} wrap>
                                {comps.slice(0, 3).map((c) => (
                                  <SignalPill key={c} tone="competitor">
                                    {c}
                                  </SignalPill>
                                ))}
                                {comps.length > 3 ? (
                                  <Tooltip title={comps.slice(3).join('、')}>
                                    <span>
                                      <SignalPill tone="neutral">
                                        <span className="gm-num">+{comps.length - 3}</span>
                                      </SignalPill>
                                    </span>
                                  </Tooltip>
                                ) : null}
                              </Space>
                            ),
                          },
                          {
                            key: 'engines',
                            dataIndex: 'engines',
                            title: '出现引擎',
                            width: 200,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (engines: VisibilityEngineKey[]) => (
                              <EngineChipList engines={engines} max={3} />
                            ),
                          },
                          {
                            key: 'observationCount',
                            dataIndex: 'observationCount',
                            title: '出现次数',
                            width: 96,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (count: number) => <span className="gm-num">{count} 次</span>,
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Section 2: Query Fan-Out */}
                  <div style={{ minWidth: 0 }}>
                    <div className="gm-panel-title" style={{ marginBottom: 8 }}>
                      高频搜索拆解词（Query Fan-Out）
                    </div>
                    <div className="gm-table-scroll">
                      <Table<VisibilityFanOutItem>
                        rowKey="query"
                        size="small"
                        loading={opportunitiesLoading}
                        dataSource={opportunitiesData.fanOutQueries}
                        pagination={false}
                        scroll={{ x: 1040 }}
                        locale={{
                          emptyText: (
                            <SignalEmpty title="当前筛选条件下暂无 AI 引擎搜索拆解词（Query Fan-Out）记录" />
                          ),
                        }}
                        columns={[
                          {
                            key: 'select',
                            title: '选择',
                            width: 56,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
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
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (q: string) => (
                              <TableClampText
                                text={q}
                                lines={2}
                                strong
                                maxWidth={224}
                                style={{ color: GM.fg.f1 }}
                              />
                            ),
                          },
                          {
                            key: 'frequency',
                            dataIndex: 'frequency',
                            title: '出现频次',
                            width: 96,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (freq: number) => (
                              <SignalPill tone="info">
                                <span className="gm-num">{freq} 次</span>
                              </SignalPill>
                            ),
                          },
                          {
                            key: 'brandMentionedPct',
                            dataIndex: 'brandMentionedPct',
                            title: '品牌覆盖率',
                            width: 136,
                            align: 'right',
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (pct?: number) => {
                              if (typeof pct !== 'number') {
                                return <span style={{ color: GM.fg.f3 }}>—</span>;
                              }
                              const clamped = Math.max(0, Math.min(100, pct));
                              return (
                                <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                                  {formatPct(pct)}
                                  <span
                                    className="gm-cov-mini-bar"
                                    style={{ '--p': `${clamped}%` } as CSSProperties}
                                  />
                                </span>
                              );
                            },
                          },
                          {
                            key: 'engines',
                            dataIndex: 'engines',
                            title: '引擎',
                            width: 180,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (engines: VisibilityEngineKey[]) => (
                              <EngineChipList engines={engines} max={3} />
                            ),
                          },
                          {
                            key: 'sourcePrompts',
                            dataIndex: 'sourcePrompts',
                            title: '来源问题预览',
                            width: 340,
                            onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                            render: (prompts: string[]) =>
                              prompts.length > 0 ? (
                                <TableClampText
                                  text={prompts.join('；')}
                                  lines={2}
                                  maxWidth={320}
                                  style={{ color: GM.fg.f3, fontSize: 12 }}
                                />
                              ) : (
                                <span style={{ color: GM.fg.f3 }}>—</span>
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
