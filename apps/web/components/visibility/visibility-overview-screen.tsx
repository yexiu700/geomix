'use client';

import {
  VISIBILITY_ENGINES,
  isVisibilityEngine,
  type VisibilityEngineKey,
  type VisibilityOverviewResponse,
  type VisibilityProfileRecord,
} from '@geomix/shared';
import { Alert, Button, Space, Tabs, Typography } from 'antd';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM } from '../../lib/design-tokens';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { sanitizeEntityTitleSegment, useSyncTabTitle } from '../../lib/ux-foundation';
import { useTabFreshness } from '../../lib/tab-freshness';
import { httpVisibilityGateway, type VisibilityGateway } from '../../lib/visibility';
import { SignalEmpty } from '../geo/primitives';
import {
  VisibilityOverviewCitationsPanel,
  useOverviewCitations,
} from './visibility-overview-citations-panel';
import {
  DEFAULT_PROFILE_STORAGE_KEY,
  SKIP_DEFAULT_PROFILE_ONCE_KEY,
  buildOverviewRangeQuery,
  createDefaultFilter,
  createEmptyMetrics,
  deriveEngineBreakdown,
  isInvalidDateRange,
  readInitialProfileId,
  selectDailyTrendSeries,
  stripTitleSuffix,
  type OverviewFilterState,
} from './visibility-overview-helpers';
import {
  VisibilityEngineCoveragePanel,
  VisibilityOverviewKpiGrid,
  VisibilitySovSentimentPanel,
} from './visibility-overview-insights';
import {
  VisibilityOverviewOpportunitiesPanel,
  useOverviewOpportunities,
} from './visibility-overview-opportunities-panel';
import { VisibilityTrendPanel } from './visibility-trend-chart';

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

const OVERVIEW_DESCRIPTION =
  '全景追踪企业品牌在各大生成式 AI 引擎中的提及率、行业声量占比（Share of Voice）、推荐顺位与引用信源分布';

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

function readStoredDefaultProfileId(): string | null {
  return typeof window !== 'undefined' && window.localStorage
    ? window.localStorage.getItem(DEFAULT_PROFILE_STORAGE_KEY)
    : null;
}

function OverviewHeader({ title, onDiagnose }: { title: string; onDiagnose: () => void }) {
  return (
    <div className="gm-overview-header">
      <div>
        <h1 className="gm-overview-title">{title}</h1>
        <div className="gm-overview-desc">{OVERVIEW_DESCRIPTION}</div>
      </div>
      <Button type="primary" aria-label="发起可见度诊断" onClick={onDiagnose}>
        发起可见度诊断
      </Button>
    </div>
  );
}

function ProfileFilterSelect({
  selectRef,
  profileId,
  profiles,
  profilesLoaded,
  onChange,
}: {
  selectRef: RefObject<HTMLSelectElement | null>;
  profileId: string;
  profiles: VisibilityProfileRecord[];
  profilesLoaded: boolean;
  onChange: (nextProfileId: string) => void;
}) {
  const activeProf = profileId ? profiles.find((p) => p.id === profileId) : undefined;
  const hasMatchingOption = !profileId || Boolean(activeProf);
  const placeholderLabel = !profilesLoaded ? '正在加载监测档案…' : '当前监测档案';
  const profileTitle = activeProf
    ? `${activeProf.name}（${activeProf.brandName}）`
    : profileId
      ? placeholderLabel
      : '全部监测档案';
  return (
    <select
      ref={selectRef}
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
      value={profileId}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">全部监测档案</option>
      {!hasMatchingOption ? <option value={profileId}>{placeholderLabel}</option> : null}
      {profiles.map((prof) => (
        <option key={prof.id} value={prof.id}>
          {prof.name}（{prof.brandName}）
        </option>
      ))}
    </select>
  );
}

export function VisibilityOverviewScreen({
  title,
  tabId,
  href,
  active = true,
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
  active?: boolean;
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

  // ---- 画像 / 筛选闭环 ----
  const [profiles, setProfiles] = useState<VisibilityProfileRecord[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [filterDraft, setFilterDraft] = useState<OverviewFilterState>(() =>
    createDefaultFilter(urlProfileId),
  );
  const [appliedFilter, setAppliedFilter] = useState<OverviewFilterState>(() =>
    createDefaultFilter(urlProfileId),
  );
  const [filterError, setFilterError] = useState<string | null>(null);

  // ---- 总览指标闭环 ----
  const [overviewData, setOverviewData] = useState<VisibilityOverviewResponse>(() => ({
    profileId: urlProfileId ?? null,
    metrics: createEmptyMetrics(),
    trend: [],
    byEngine: [],
  }));
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [activeBottomTab, setActiveBottomTab] = useState<string>('citations');

  const userInteractedProfileRef = useRef(false);
  const initialUrlProfileIdRef = useRef(urlProfileId);
  const skipDefaultProfileRef = useRef<boolean>(false);
  const profileSelectRef = useRef<HTMLSelectElement | null>(null);

  // ---- 底部页签：各自持有请求 / 分页 / 竞态保护，父容器仅下发 appliedFilter ----
  const citations = useOverviewCitations({ client, appliedFilter, featureEnabled });
  const opportunities = useOverviewOpportunities({
    client,
    appliedFilter,
    featureEnabled,
    profiles,
    profilesLoaded,
    readOnly,
    onDispatch,
  });
  const { applyKeywordRefresh } = opportunities;

  const syncProfileRoute = useCallback(
    (nextProfileId: string) => {
      try {
        if (!nextProfileId) {
          effectiveStorage.setItem(SKIP_DEFAULT_PROFILE_ONCE_KEY, '1');
        } else {
          effectiveStorage.removeItem(SKIP_DEFAULT_PROFILE_ONCE_KEY);
        }
      } catch {
        // ignore storage errors
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
    const withUrlProfile = (curr: OverviewFilterState) =>
      curr.profileId === urlProfileId ? curr : { ...curr, profileId: urlProfileId };
    setFilterDraft(withUrlProfile);
    setAppliedFilter(withUrlProfile);
  }, [urlProfileId]);

  // Keep native <select> DOM value strictly synchronized across async profile loading & tab switches
  useEffect(() => {
    const el = profileSelectRef.current;
    if (el && el.value !== filterDraft.profileId) {
      el.value = filterDraft.profileId;
    }
  }, [filterDraft.profileId, profiles, profilesLoaded]);

  // 主链一「画像初始化」：加载档案列表；URL 未指定且用户未交互时应用默认档案（可被 skip-default-once 跳过一次）
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
          initialUrlProfileIdRef.current ||
          userInteractedProfileRef.current ||
          skipDefaultProfileRef.current ||
          res.items.length === 0
        ) {
          return;
        }
        const savedDefault = readStoredDefaultProfileId();
        if (savedDefault && res.items.some((p) => p.id === savedDefault)) {
          const withDefault = (curr: OverviewFilterState) =>
            curr.profileId ? curr : { ...curr, profileId: savedDefault };
          setFilterDraft(withDefault);
          setAppliedFilter(withDefault);
        }
      })
      .catch(() => {
        if (!cancelled) setProfilesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, effectiveStorage, featureEnabled]);

  const refreshReferenceOptions = useCallback(async () => {
    if (!featureEnabled) return;
    try {
      const [profileRes, kwList] = await Promise.all([
        client.listProfiles(),
        client.listKeywords().catch(() => null),
      ]);
      setProfiles(profileRes.items);
      setProfilesLoaded(true);
      if (kwList) applyKeywordRefresh(kwList);
    } catch {
      // keep existing dropdown options on transient error
    }
  }, [applyKeywordRefresh, client, featureEnabled]);

  // 主链二「总览拉取」：appliedFilter 变化即请求；清理时作废旧请求，避免晚返回覆盖新结果
  useEffect(() => {
    if (!featureEnabled) {
      setOverviewLoading(false);
      return;
    }
    let cancelled = false;
    setOverviewLoading(true);
    setBannerError(null);

    void client
      .getOverview(buildOverviewRangeQuery(appliedFilter))
      .then((res) => {
        if (cancelled) return;
        setOverviewData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const isNotFound =
          (err &&
            typeof err === 'object' &&
            'status' in err &&
            (err as { status?: number }).status === 404) ||
          (err instanceof Error && err.message.includes('不存在'));
        if (isNotFound && appliedFilter.profileId) {
          setFilterDraft((curr) => ({ ...curr, profileId: '' }));
          setAppliedFilter((curr) => ({ ...curr, profileId: '' }));
          syncProfileRoute('');
          void refreshReferenceOptions();
          setBannerError('所选监测档案已不存在，已自动切换至「全部监测档案」');
          return;
        }
        setBannerError(err instanceof Error ? err.message : '加载 AI 数据看板概览失败');
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, client, featureEnabled, refreshReferenceOptions, syncProfileRoute]);

  useTabFreshness({
    active,
    domains: ['visibility-profiles', 'keywords', 'visibility-runs'],
    onRefresh: (reason) => {
      void refreshReferenceOptions();
      if (reason === 'invalidated') {
        citations.retry();
      }
    },
  });

  const handleApplySearch = useCallback(() => {
    if (isInvalidDateRange(filterDraft)) {
      setFilterError('开始日期不能晚于结束日期，请调整起止时间后再查询');
      return;
    }
    setFilterError(null);
    setAppliedFilter({ ...filterDraft });
  }, [filterDraft]);

  const { setSourceKind: setCitationSourceKind } = citations;
  const handleResetFilters = useCallback(() => {
    userInteractedProfileRef.current = true;
    const clean = createDefaultFilter();
    setFilterError(null);
    setFilterDraft(clean);
    setCitationSourceKind('ALL');
    setAppliedFilter(clean);
    syncProfileRoute('');
  }, [setCitationSourceKind, syncProfileRoute]);

  const handleSelectEngine = useCallback((eng: VisibilityEngineKey | undefined) => {
    const nextEngine = eng ?? '';
    setFilterError(null);
    setFilterDraft((curr) => ({ ...curr, engine: nextEngine }));
    setAppliedFilter((curr) => ({ ...curr, engine: nextEngine }));
  }, []);

  const handleProfileChange = (nextProfileId: string) => {
    userInteractedProfileRef.current = true;
    setFilterError(null);
    const nextDraft: OverviewFilterState = { ...filterDraft, profileId: nextProfileId };
    setFilterDraft(nextDraft);
    if (isInvalidDateRange(nextDraft)) {
      setAppliedFilter((curr) => ({ ...curr, profileId: nextProfileId }));
    } else {
      setAppliedFilter(nextDraft);
    }
    syncProfileRoute(nextProfileId);
  };

  const handleQuickDays = (dayNum: OverviewFilterState['days']) => {
    setFilterError(null);
    const next: OverviewFilterState = { ...filterDraft, days: dayNum, from: '', to: '' };
    setFilterDraft(next);
    setAppliedFilter(next);
  };

  const dailyTrendSeries = useMemo(
    () => selectDailyTrendSeries(overviewData.trend, appliedFilter.engine),
    [appliedFilter.engine, overviewData.trend],
  );

  const engineBreakdown = useMemo(() => deriveEngineBreakdown(overviewData), [overviewData]);

  const metrics = overviewData.metrics;

  const filterContext = useMemo<VisibilityOverviewFilterContext>(
    () => ({
      ...buildOverviewRangeQuery(appliedFilter),
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

  const baseTitle = useMemo(() => stripTitleSuffix(title), [title]);

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
        <OverviewHeader title={resolvedTitle} onDiagnose={goToMonitors} />
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

  return (
    <section style={{ minWidth: 0 }}>
      <OverviewHeader title={resolvedTitle} onDiagnose={goToMonitors} />

      {/* Top Filter Bar */}
      <div
        className="gm-filterbar"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleApplySearch();
          }
        }}
      >
        <ProfileFilterSelect
          selectRef={profileSelectRef}
          profileId={filterDraft.profileId}
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          onChange={handleProfileChange}
        />

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
                onClick={() => handleQuickDays(dayNum)}
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

      <VisibilityOverviewKpiGrid metrics={metrics} loading={overviewLoading} />

      {/* Main Analysis Grid: Left SonarDial (360px) + Right Trend & SoV/Sentiment */}
      <div className="gm-overview-main-grid">
        <VisibilityEngineCoveragePanel
          byEngine={engineBreakdown}
          overallPct={metrics.visibilityPct}
          selectedEngine={selectedDialEngine}
          onSelectEngine={handleSelectEngine}
          loading={overviewLoading}
        />

        <div className="gm-overview-right-stack">
          <VisibilityTrendPanel points={dailyTrendSeries} loading={overviewLoading} />
          <VisibilitySovSentimentPanel
            metrics={metrics}
            brandGroups={overviewData.brandGroups ?? []}
          />
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
              label: `引用溯源（Citations · ${citations.tabCount}）`,
              children: <VisibilityOverviewCitationsPanel citations={citations} />,
            },
            {
              key: 'opportunities',
              label: `优化机会 & 搜索拆解词（Query Fan-Out · ${opportunities.tabCount}）`,
              children: (
                <VisibilityOverviewOpportunitiesPanel
                  opportunities={opportunities}
                  profileId={appliedFilter.profileId}
                  profilesLoaded={profilesLoaded}
                  readOnly={readOnly}
                />
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
