'use client';

import type {
  BrandFactRecord,
  CitationSourceKind,
  GeoBriefGenerateInput,
  GeoBriefRecord,
  GeoBriefSource,
  GeoBriefUpdateInput,
  GeoMarket,
  NearMissItemDto,
  NearMissListResponse,
  NearMissTier,
  TaskStatusName,
  VisibilityCitationListResponse,
  VisibilityEngineAvailabilityItem,
  VisibilityEngineKey,
  VisibilityObservationRecord,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewResponse,
  VisibilityRunDetailRecord,
  VisibilityRunRecord,
} from '@geomix/shared';
import { GEO_MARKET_LABELS, sanitizeEntityTitleSegment } from '@geomix/shared';
import { Button, Skeleton, Tabs } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts } from '../../lib/brands';
import {
  createBriefFromCitationUrl,
  createBriefFromNearMiss,
  deriveObservationBriefSource,
  dismissBrief,
  fetchBriefs,
  generateBrief,
  isCitationCounterFallbackError,
  updateBrief,
} from '../../lib/briefs';
import { buildWorkspaceHref } from '../../lib/routes';
import { createBatchJob, createStudioIdempotencyKey } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  cancelVisibilityRun,
  createVisibilityIdempotencyKey,
  createVisibilityRun,
  deleteVisibilityRun,
  fetchVisibilityCitations,
  fetchVisibilityEngines,
  fetchVisibilityNearMiss,
  fetchVisibilityOpportunities,
  fetchVisibilityOverview,
  fetchVisibilityRunDetail,
  fetchVisibilityRuns,
  filterEnginesForMarket,
  isSafeHttpUrl,
  parsePromptLines,
  pauseVisibilityRun,
  resumeVisibilityRun,
} from '../../lib/visibility';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { BriefListPanel, type BriefStatusFilterValue } from '../briefs/brief-list-panel';
import { CitationCounterModal } from '../briefs/citation-counter-modal';
import { GeoBriefDrawer } from '../briefs/geo-brief-drawer';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { EmptyState, KpiStrip, PageHeader } from '../ui';
import { VisibilityCitationsTab, type RankedCitationRow } from './visibility-citations-tab';
import {
  VisibilityNearMissPanel,
  buildNearMissBoostInput,
  type NearMissOwnershipFilter,
} from './visibility-near-miss-panel';
import { VisibilityOverviewTab } from './visibility-overview-tab';
import { VisibilityRunsTab } from './visibility-runs-tab';

type VisibilityTabKey = 'overview' | 'runs' | 'citations';

const DAY_WINDOWS = [7, 14, 30] as const;

function readInitialTab(): VisibilityTabKey {
  if (typeof window === 'undefined') return 'overview';
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (raw === 'runs' || raw === 'citations' || raw === 'overview') return raw;
  return 'overview';
}

function readInitialRunId(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('runId')?.trim();
  return raw || null;
}

function syncUrlParams(updates: { tab?: VisibilityTabKey; runId?: string | null }): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (updates.tab) {
      url.searchParams.set('tab', updates.tab);
    }
    if (updates.runId !== undefined) {
      if (updates.runId) url.searchParams.set('runId', updates.runId);
      else url.searchParams.delete('runId');
    }
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // Ignore history errors in restricted environments
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

export function VisibilityWorkspace(): JSX.Element {
  const consoleCtx = useConsoleContext();
  const feedback = useUxFeedback();
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeBrandId = activeBrand?.id ?? null;
  const activeMarket: GeoMarket = activeBrandMarket?.market ?? state.activeMarket;
  const readOnly = Boolean(consoleCtx?.readOnly);

  const [activeTab, setActiveTab] = useState<VisibilityTabKey>(() => readInitialTab());
  const [days, setDays] = useState<number>(14);
  const [selectedEngine, setSelectedEngine] = useState<VisibilityEngineKey | undefined>(undefined);

  // Overview state
  const [overview, setOverview] = useState<VisibilityOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Engines state
  const [engines, setEngines] = useState<VisibilityEngineAvailabilityItem[]>([]);
  const [enginesLoading, setEnginesLoading] = useState(false);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [checkedEngines, setCheckedEngines] = useState<VisibilityEngineKey[]>([]);

  // Create run form state
  const [runName, setRunName] = useState('');
  const [promptsText, setPromptsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Runs list & detail state
  const [runs, setRuns] = useState<VisibilityRunRecord[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const runsPageSize = 25;
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaskStatusName | ''>('');
  const [keywordFilter, setKeywordFilter] = useState('');

  const currentContextKey = activeBrandId ? `${activeBrandId}::${activeMarket}` : null;
  const [activeRunState, setActiveRunState] = useState<{
    id: string;
    contextKey: string | null;
  } | null>(() => {
    const initialId = readInitialRunId();
    return initialId ? { id: initialId, contextKey: null } : null;
  });
  const activeRunId =
    activeRunState &&
    (activeRunState.contextKey === null || activeRunState.contextKey === currentContextKey)
      ? activeRunState.id
      : null;
  const [activeRunDetail, setActiveRunDetail] = useState<VisibilityRunDetailRecord | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [actionLoadingRunId, setActionLoadingRunId] = useState<string | null>(null);

  // Observation filters inside RunWorkspace
  const [obsEngineFilter, setObsEngineFilter] = useState('');
  const [obsMentionFilter, setObsMentionFilter] = useState<'all' | 'mentioned' | 'unmentioned'>(
    'all',
  );
  const [obsSentimentFilter, setObsSentimentFilter] = useState('');

  // Citations & Fan-Out state
  const [citations, setCitations] = useState<VisibilityCitationListResponse | null>(null);
  const [citationsLoading, setCitationsLoading] = useState(false);
  const [citationsError, setCitationsError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<CitationSourceKind | undefined>(undefined);

  const [opportunities, setOpportunities] = useState<VisibilityOpportunitiesResponse | null>(null);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null);
  const [selectedFanOuts, setSelectedFanOuts] = useState<string[]>([]);

  // v2.2 Near-Miss state
  const [nearMiss, setNearMiss] = useState<NearMissListResponse | null>(null);
  const [nearMissLoading, setNearMissLoading] = useState(false);
  const [nearMissError, setNearMissError] = useState<string | null>(null);
  const [nearMissTierFilter, setNearMissTierFilter] = useState<NearMissTier | undefined>(undefined);
  const [nearMissOwnershipFilter, setNearMissOwnershipFilter] =
    useState<NearMissOwnershipFilter>('ALL');

  // M3 GeoBrief list, drawer & BrandFact lookup state
  const [briefs, setBriefs] = useState<GeoBriefRecord[]>([]);
  const [briefsTotal, setBriefsTotal] = useState(0);
  const [briefsLoading, setBriefsLoading] = useState(false);
  const [briefsError, setBriefsError] = useState<string | null>(null);
  const [briefSourceFilter, setBriefSourceFilter] = useState<GeoBriefSource | ''>('');
  const [briefStatusFilter, setBriefStatusFilter] = useState<BriefStatusFilterValue>('OPEN');
  const [selectedBriefIds, setSelectedBriefIds] = useState<string[]>([]);
  const [activeBrief, setActiveBrief] = useState<GeoBriefRecord | null>(null);
  const [citationFallback, setCitationFallback] = useState<{
    url: string;
    title: string;
    errorMessage: string;
  } | null>(null);
  const [generatingBriefKey, setGeneratingBriefKey] = useState<string | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [brandFacts, setBrandFacts] = useState<BrandFactRecord[]>([]);
  const [brandFactsLoading, setBrandFactsLoading] = useState(false);

  // Anti-race AbortControllers + monotonic sequence counter
  const contextSeqRef = useRef(0);
  const prevContextKeyRef = useRef<string | null>(null);
  const overviewCtrlRef = useRef<AbortController | null>(null);
  const enginesCtrlRef = useRef<AbortController | null>(null);
  const runsCtrlRef = useRef<AbortController | null>(null);
  const runDetailCtrlRef = useRef<AbortController | null>(null);
  const citationsCtrlRef = useRef<AbortController | null>(null);
  const opportunitiesCtrlRef = useRef<AbortController | null>(null);
  const nearMissCtrlRef = useRef<AbortController | null>(null);
  const briefsCtrlRef = useRef<AbortController | null>(null);
  const briefGenCtrlRef = useRef<AbortController | null>(null);
  const factsCtrlRef = useRef<AbortController | null>(null);
  const brandFactsLoadedBrandIdRef = useRef<string | null>(null);
  const postRunBriefTimerRef = useRef<number | null>(null);
  const hadLiveRunsRef = useRef(false);
  const daysRef = useRef(days);
  daysRef.current = days;
  const nearMissFilterRef = useRef<{
    tier: NearMissTier | undefined;
    ownership: NearMissOwnershipFilter;
  }>({ tier: nearMissTierFilter, ownership: nearMissOwnershipFilter });
  nearMissFilterRef.current = { tier: nearMissTierFilter, ownership: nearMissOwnershipFilter };
  const briefFilterRef = useRef<{
    status: BriefStatusFilterValue;
    sourceType: GeoBriefSource | '';
  }>({ status: briefStatusFilter, sourceType: briefSourceFilter });
  briefFilterRef.current = { status: briefStatusFilter, sourceType: briefSourceFilter };

  const abortAllControllers = useCallback(() => {
    overviewCtrlRef.current?.abort();
    enginesCtrlRef.current?.abort();
    runsCtrlRef.current?.abort();
    runDetailCtrlRef.current?.abort();
    citationsCtrlRef.current?.abort();
    opportunitiesCtrlRef.current?.abort();
    nearMissCtrlRef.current?.abort();
    briefsCtrlRef.current?.abort();
    briefGenCtrlRef.current?.abort();
    factsCtrlRef.current?.abort();
    if (postRunBriefTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(postRunBriefTimerRef.current);
      postRunBriefTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => () => abortAllControllers(), [abortAllControllers]);

  const loadOverview = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      windowDays: number,
      engine?: VisibilityEngineKey,
    ) => {
      overviewCtrlRef.current?.abort();
      const ctrl = new AbortController();
      overviewCtrlRef.current = ctrl;
      setOverviewLoading(true);
      setOverviewError(null);
      try {
        const data = await fetchVisibilityOverview(
          brandId,
          market,
          { days: windowDays, engine },
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setOverview(data);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setOverviewError(extractErrorMessage(err, '加载可见度总览失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setOverviewLoading(false);
        }
      }
    },
    [],
  );

  const loadEngines = useCallback(async (brandId: string, market: GeoMarket, seq: number) => {
    enginesCtrlRef.current?.abort();
    const ctrl = new AbortController();
    enginesCtrlRef.current = ctrl;
    setEnginesLoading(true);
    setEnginesError(null);
    try {
      const res = await fetchVisibilityEngines(brandId, market, { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      const scoped = filterEnginesForMarket(res.engines, market);
      setEngines(scoped);
      // Pre-check ONLY online healthy engines for the active market
      setCheckedEngines(scoped.filter((e) => e.available).map((e) => e.key));
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
      setEnginesError(extractErrorMessage(err, '加载 AI 引擎列表失败'));
    } finally {
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setEnginesLoading(false);
      }
    }
  }, []);

  const loadRunDetail = useCallback(
    async (brandId: string, runId: string, market: GeoMarket, seq: number, silent = false) => {
      runDetailCtrlRef.current?.abort();
      const ctrl = new AbortController();
      runDetailCtrlRef.current = ctrl;
      if (!silent) {
        setRunDetailLoading(true);
        setRunDetailError(null);
      }
      try {
        const detail = await fetchVisibilityRunDetail(brandId, runId, market, {
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setActiveRunDetail(detail);
        setRunDetailError(null);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setRunDetailError(extractErrorMessage(err, '加载监测任务详情失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setRunDetailLoading(false);
        }
      }
    },
    [],
  );

  const loadRuns = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      params: { page: number; status: TaskStatusName | ''; keyword: string },
      silent = false,
    ) => {
      runsCtrlRef.current?.abort();
      const ctrl = new AbortController();
      runsCtrlRef.current = ctrl;
      if (!silent) {
        setRunsLoading(true);
        setRunsError(null);
      }
      try {
        const res = await fetchVisibilityRuns(
          brandId,
          market,
          {
            page: params.page,
            pageSize: runsPageSize,
            ...(params.status ? { status: params.status } : {}),
            ...(params.keyword.trim() ? { keyword: params.keyword.trim() } : {}),
          },
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setRuns(res.items);
        setRunsTotal(res.total);
        setRunsError(null);
        const runContextKey = `${brandId}::${market}`;
        setActiveRunState((curr) => {
          if (
            curr &&
            (curr.contextKey === null || curr.contextKey === runContextKey) &&
            res.items.some((r) => r.id === curr.id)
          ) {
            return curr.contextKey === runContextKey
              ? curr
              : { id: curr.id, contextKey: runContextKey };
          }
          const firstId = res.items[0]?.id ?? null;
          return firstId ? { id: firstId, contextKey: runContextKey } : null;
        });
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setRunsError(extractErrorMessage(err, '加载监测任务列表失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setRunsLoading(false);
        }
      }
    },
    [],
  );

  const loadCitations = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      windowDays: number,
      kind?: CitationSourceKind,
    ) => {
      citationsCtrlRef.current?.abort();
      const ctrl = new AbortController();
      citationsCtrlRef.current = ctrl;
      setCitationsLoading(true);
      setCitationsError(null);
      try {
        const res = await fetchVisibilityCitations(
          brandId,
          market,
          { days: windowDays, ...(kind ? { sourceKind: kind } : {}) },
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setCitations(res);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setCitationsError(extractErrorMessage(err, '加载引用信源失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setCitationsLoading(false);
        }
      }
    },
    [],
  );

  const loadOpportunities = useCallback(
    async (brandId: string, market: GeoMarket, seq: number, windowDays: number) => {
      opportunitiesCtrlRef.current?.abort();
      const ctrl = new AbortController();
      opportunitiesCtrlRef.current = ctrl;
      setOpportunitiesLoading(true);
      setOpportunitiesError(null);
      try {
        const res = await fetchVisibilityOpportunities(
          brandId,
          market,
          { days: windowDays, limit: 50 },
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setOpportunities(res);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setOpportunitiesError(extractErrorMessage(err, '加载搜索拆解词与缺口失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setOpportunitiesLoading(false);
        }
      }
    },
    [],
  );

  const loadNearMiss = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      windowDays: number,
      tier?: NearMissTier,
      ownership: NearMissOwnershipFilter = 'ALL',
    ) => {
      nearMissCtrlRef.current?.abort();
      const ctrl = new AbortController();
      nearMissCtrlRef.current = ctrl;
      setNearMissLoading(true);
      setNearMissError(null);
      try {
        // Backend Zod only accepts CitationSourceKind ('OWNED' | ...), never 'THIRD_PARTY'.
        // For THIRD_PARTY, omit sourceKind & tier so client filters !isOwned and recomputes all 4 tierCounts accurately.
        const queryParams =
          ownership === 'THIRD_PARTY'
            ? { days: windowDays, limit: 100 }
            : {
                days: windowDays,
                ...(tier ? { tier } : {}),
                ...(ownership === 'OWNED' ? { sourceKind: 'OWNED' as const } : {}),
                limit: 50,
              };
        const res = await fetchVisibilityNearMiss(brandId, market, queryParams, {
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setNearMiss(res);
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setNearMissError(extractErrorMessage(err, '加载差一步被引用（Near-Miss）机会失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setNearMissLoading(false);
        }
      }
    },
    [],
  );

  const loadBriefs = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      filters: { status: BriefStatusFilterValue; sourceType: GeoBriefSource | '' },
      silent = false,
    ) => {
      briefsCtrlRef.current?.abort();
      const ctrl = new AbortController();
      briefsCtrlRef.current = ctrl;
      if (!silent) {
        setBriefsLoading(true);
        setBriefsError(null);
      }
      try {
        const res = await fetchBriefs(
          brandId,
          market,
          {
            ...(filters.status !== 'ACTIVE' ? { status: filters.status } : {}),
            ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
            includeDismissed: filters.status === 'DISMISSED',
            pageSize: 50,
          },
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setBriefs(res.items);
        setBriefsTotal(res.total);
        setBriefsError(null);
        setSelectedBriefIds((prev) => {
          const validIds = new Set(res.items.filter((b) => b.status === 'OPEN').map((b) => b.id));
          const next = prev.filter((id) => validIds.has(id));
          return next.length === prev.length ? prev : next;
        });
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
        setBriefsError(extractErrorMessage(err, '加载写作建议列表失败'));
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setBriefsLoading(false);
        }
      }
    },
    [],
  );

  // Synchronous reset + fresh load on global brand/market/epoch switch
  useEffect(() => {
    abortAllControllers();
    contextSeqRef.current += 1;
    const seq = contextSeqRef.current;

    const nextContextKey = activeBrandId ? `${activeBrandId}::${activeMarket}` : null;
    const contextChanged =
      prevContextKeyRef.current !== null && prevContextKeyRef.current !== nextContextKey;
    prevContextKeyRef.current = nextContextKey;

    setOverview(null);
    setOverviewError(null);
    setSelectedEngine(undefined);

    setEngines([]);
    setEnginesError(null);
    setCheckedEngines([]);

    setRunName('');
    setSubmitting(false);
    setSubmitError(null);
    setPromptsText('');
    setActionLoadingRunId(null);

    setRuns([]);
    setRunsTotal(0);
    setRunsPage(1);
    setRunsError(null);
    setStatusFilter('');
    setKeywordFilter('');

    if (contextChanged) {
      setActiveRunState(null);
      syncUrlParams({ runId: null });
    } else if (nextContextKey) {
      setActiveRunState((curr) =>
        curr && curr.contextKey === null ? { id: curr.id, contextKey: nextContextKey } : curr,
      );
    }
    setActiveRunDetail(null);
    setRunDetailLoading(false);
    setRunDetailError(null);
    setObsEngineFilter('');
    setObsMentionFilter('all');
    setObsSentimentFilter('');

    setCitations(null);
    setCitationsError(null);
    setSourceFilter(undefined);

    setOpportunities(null);
    setOpportunitiesError(null);
    setSelectedFanOuts([]);

    setNearMiss(null);
    setNearMissError(null);
    setNearMissTierFilter(undefined);
    setNearMissOwnershipFilter('ALL');

    // Reset all M3 brief & drawer states synchronously to prevent stale cross-brand leakage
    setBriefs([]);
    setBriefsTotal(0);
    setBriefsError(null);
    setBriefSourceFilter('');
    setBriefStatusFilter('OPEN');
    setSelectedBriefIds([]);
    setActiveBrief(null);
    setCitationFallback(null);
    setGeneratingBriefKey(null);
    setBatchSubmitting(false);
    setBrandFacts([]);
    setBrandFactsLoading(false);
    brandFactsLoadedBrandIdRef.current = null;
    hadLiveRunsRef.current = false;

    const activeBrandMarketId = activeBrandMarket?.id ?? null;
    if (!activeBrandId || !activeBrandMarketId) {
      setOverviewLoading(false);
      setEnginesLoading(false);
      setRunsLoading(false);
      setCitationsLoading(false);
      setOpportunitiesLoading(false);
      setNearMissLoading(false);
      setBriefsLoading(false);
      return;
    }

    const windowDays = daysRef.current;
    void loadOverview(activeBrandId, activeMarket, seq, windowDays, undefined);
    void loadEngines(activeBrandId, activeMarket, seq);
    void loadRuns(activeBrandId, activeMarket, seq, { page: 1, status: '', keyword: '' }, false);
    void loadCitations(activeBrandId, activeMarket, seq, windowDays, undefined);
    void loadOpportunities(activeBrandId, activeMarket, seq, windowDays);
    void loadNearMiss(activeBrandId, activeMarket, seq, windowDays, undefined, 'ALL');
    void loadBriefs(activeBrandId, activeMarket, seq, { status: 'OPEN', sourceType: '' }, false);
  }, [
    abortAllControllers,
    activeBrandId,
    activeBrandMarket?.id,
    activeMarket,
    loadBriefs,
    loadCitations,
    loadEngines,
    loadNearMiss,
    loadOpportunities,
    loadOverview,
    loadRuns,
    state.contextEpoch,
  ]);

  // Lazily fetch BrandFacts when GeoBriefDrawer opens so matchedFactIds resolve to human-readable titles (never CUIDs)
  useEffect(() => {
    if (!activeBrief) return;
    if (brandFactsLoadedBrandIdRef.current === activeBrief.brandId) return;
    factsCtrlRef.current?.abort();
    const ctrl = new AbortController();
    factsCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    const targetBrandId = activeBrief.brandId;
    setBrandFactsLoading(true);
    void getBrandFacts(targetBrandId, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setBrandFacts(res.items);
        brandFactsLoadedBrandIdRef.current = targetBrandId;
      })
      .catch(() => {
        // Fallback count message handles failed fact lookup without exposing CUIDs
      })
      .finally(() => {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setBrandFactsLoading(false);
        }
      });
  }, [activeBrief]);

  // Load selected run detail whenever activeRunId changes within the active brand+market context
  useEffect(() => {
    if (!activeBrandId || !activeRunId) {
      runDetailCtrlRef.current?.abort();
      setActiveRunDetail(null);
      setRunDetailError(null);
      setRunDetailLoading(false);
      return;
    }
    const seq = contextSeqRef.current;
    void loadRunDetail(activeBrandId, activeRunId, activeMarket, seq, false);
    return () => {
      runDetailCtrlRef.current?.abort();
    };
  }, [activeBrandId, activeMarket, activeRunId, loadRunDetail]);

  // Refetch overview/citations/opportunities/near-miss when time window or engine/source filters change
  const handleDaysChange = (nextDays: number) => {
    setDays(nextDays);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadOverview(activeBrandId, activeMarket, seq, nextDays, selectedEngine);
    void loadCitations(activeBrandId, activeMarket, seq, nextDays, sourceFilter);
    void loadOpportunities(activeBrandId, activeMarket, seq, nextDays);
    void loadNearMiss(
      activeBrandId,
      activeMarket,
      seq,
      nextDays,
      nearMissTierFilter,
      nearMissOwnershipFilter,
    );
  };

  const handleSelectEngine = (nextEngine: VisibilityEngineKey | undefined) => {
    setSelectedEngine(nextEngine);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadOverview(activeBrandId, activeMarket, seq, days, nextEngine);
  };

  const handleSourceFilterChange = (nextKind: CitationSourceKind | undefined) => {
    setSourceFilter(nextKind);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadCitations(activeBrandId, activeMarket, seq, days, nextKind);
  };

  const handleNearMissTierChange = (nextTier: NearMissTier | undefined) => {
    const currentOwnership = nearMissFilterRef.current.ownership;
    nearMissFilterRef.current = { tier: nextTier, ownership: currentOwnership };
    setNearMissTierFilter(nextTier);
    if (!activeBrandId) return;
    if (currentOwnership === 'THIRD_PARTY') return;
    const seq = contextSeqRef.current;
    void loadNearMiss(activeBrandId, activeMarket, seq, days, nextTier, currentOwnership);
  };

  const handleNearMissOwnershipChange = (nextOwnership: NearMissOwnershipFilter) => {
    const currentTier = nearMissFilterRef.current.tier;
    nearMissFilterRef.current = { tier: currentTier, ownership: nextOwnership };
    setNearMissOwnershipFilter(nextOwnership);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadNearMiss(activeBrandId, activeMarket, seq, days, currentTier, nextOwnership);
  };

  const handleResetNearMissFilters = () => {
    nearMissFilterRef.current = { tier: undefined, ownership: 'ALL' };
    setNearMissTierFilter(undefined);
    setNearMissOwnershipFilter('ALL');
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadNearMiss(activeBrandId, activeMarket, seq, days, undefined, 'ALL');
  };

  const handleRunsFilterChange = (next: {
    page?: number;
    status?: TaskStatusName | '';
    keyword?: string;
  }) => {
    const page = next.page ?? 1;
    const status = next.status ?? statusFilter;
    const keyword = next.keyword ?? keywordFilter;
    setRunsPage(page);
    setStatusFilter(status);
    setKeywordFilter(keyword);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadRuns(activeBrandId, activeMarket, seq, { page, status, keyword }, false);
  };

  const handleTabChange = (nextKey: string) => {
    const tab = (
      nextKey === 'runs' || nextKey === 'citations' ? nextKey : 'overview'
    ) as VisibilityTabKey;
    const prevTab = activeTab;
    setActiveTab(tab);
    syncUrlParams({ tab });
    if (tab === 'overview' && prevTab !== 'overview' && activeBrandId && activeBrandMarket?.id) {
      void loadBriefs(
        activeBrandId,
        activeMarket,
        contextSeqRef.current,
        { status: briefStatusFilter, sourceType: briefSourceFilter },
        true,
      );
    }
  };

  const handleSelectRun = (runId: string) => {
    const isSameRunRetry =
      runId === activeRunId && Boolean(runDetailError) && Boolean(activeBrandId);
    setActiveRunState({ id: runId, contextKey: currentContextKey });
    setObsEngineFilter('');
    setObsMentionFilter('all');
    setObsSentimentFilter('');
    syncUrlParams({ runId });
    if (isSameRunRetry && activeBrandId) {
      void loadRunDetail(activeBrandId, runId, activeMarket, contextSeqRef.current, false);
    }
  };

  // Detect live runs for background polling
  const hasLiveRuns = useMemo(() => {
    if (
      activeRunDetail &&
      (activeRunDetail.status === 'QUEUED' || activeRunDetail.status === 'RUNNING')
    ) {
      return true;
    }
    return runs.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
  }, [activeRunDetail, runs]);

  useEffect(() => {
    if (hasLiveRuns) {
      hadLiveRunsRef.current = true;
    } else if (hadLiveRunsRef.current && activeBrandId) {
      hadLiveRunsRef.current = false;
      const seq = contextSeqRef.current;
      void loadOverview(activeBrandId, activeMarket, seq, days, selectedEngine);
      void loadCitations(activeBrandId, activeMarket, seq, days, sourceFilter);
      void loadOpportunities(activeBrandId, activeMarket, seq, days);
      void loadNearMiss(
        activeBrandId,
        activeMarket,
        seq,
        days,
        nearMissFilterRef.current.tier,
        nearMissFilterRef.current.ownership,
      );
      void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
      if (typeof window !== 'undefined') {
        if (postRunBriefTimerRef.current !== null) {
          window.clearTimeout(postRunBriefTimerRef.current);
        }
        postRunBriefTimerRef.current = window.setTimeout(() => {
          postRunBriefTimerRef.current = null;
          if (seq !== contextSeqRef.current) return;
          void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
        }, 1500);
      }
      void consoleCtx?.refreshWallet();
    }
  }, [
    activeBrandId,
    activeMarket,
    consoleCtx,
    days,
    hasLiveRuns,
    loadBriefs,
    loadCitations,
    loadNearMiss,
    loadOpportunities,
    loadOverview,
    selectedEngine,
    sourceFilter,
  ]);

  useTaskPolling({
    enabled: Boolean(activeBrandId && hasLiveRuns),
    intervalMs: 4_000,
    onPoll: async () => {
      if (!activeBrandId) return;
      const seq = contextSeqRef.current;
      await loadRuns(
        activeBrandId,
        activeMarket,
        seq,
        { page: runsPage, status: statusFilter, keyword: keywordFilter },
        true,
      );
      if (activeRunId) {
        await loadRunDetail(activeBrandId, activeRunId, activeMarket, seq, true);
      }
    },
  });

  useTabFreshness({
    active: true,
    domains: ['visibility-runs', 'brands', 'briefs', 'publish-records'],
    onRefresh: async () => {
      if (!activeBrandId) return;
      const seq = contextSeqRef.current;
      await Promise.all([
        loadOverview(activeBrandId, activeMarket, seq, days, selectedEngine),
        loadRuns(
          activeBrandId,
          activeMarket,
          seq,
          { page: runsPage, status: statusFilter, keyword: keywordFilter },
          true,
        ),
        loadCitations(activeBrandId, activeMarket, seq, days, sourceFilter),
        loadOpportunities(activeBrandId, activeMarket, seq, days),
        loadNearMiss(
          activeBrandId,
          activeMarket,
          seq,
          days,
          nearMissFilterRef.current.tier,
          nearMissFilterRef.current.ownership,
        ),
        loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true),
      ]);
    },
  });

  // Mutations
  const handleSubmitRun = async () => {
    if (!activeBrandId || readOnly || submitting) return;
    const prompts = parsePromptLines(promptsText);
    const marketEngines = filterEnginesForMarket(engines, activeMarket);
    const onlineSet = new Set(marketEngines.filter((e) => e.available).map((e) => e.key));
    const selectedOnline = checkedEngines.filter((k) => onlineSet.has(k));

    if (prompts.length === 0) {
      setSubmitError('请至少输入一条不少于 2 个字的监测问题');
      return;
    }
    if (selectedOnline.length === 0) {
      setSubmitError('请至少勾选一个已上线的 AI 引擎');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    const seq = contextSeqRef.current;
    try {
      const idempotencyKey = createVisibilityIdempotencyKey();
      const created = await createVisibilityRun(
        activeBrandId,
        {
          market: activeMarket,
          ...(runName.trim() ? { name: runName.trim() } : {}),
          prompts,
          engines: selectedOnline,
        },
        idempotencyKey,
      );
      if (seq !== contextSeqRef.current) return;
      feedback.notifySuccess('监测任务已提交，正在后台依次采集各引擎回答');
      setRunName('');
      setActiveRunState({ id: created.id, contextKey: `${activeBrandId}::${activeMarket}` });
      setActiveRunDetail(created);
      syncUrlParams({ tab: 'runs', runId: created.id });
      invalidateFreshness('visibility-runs');
      invalidateFreshness('points');
      void consoleCtx?.refreshWallet();
      void loadRuns(
        activeBrandId,
        activeMarket,
        seq,
        { page: 1, status: statusFilter, keyword: keywordFilter },
        true,
      );
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      const msg = extractErrorMessage(err, '发起监测任务失败');
      setSubmitError(msg);
      feedback.notifyError(msg);
    } finally {
      if (seq === contextSeqRef.current) {
        setSubmitting(false);
      }
    }
  };

  const handlePauseRun = async (run: VisibilityRunRecord) => {
    if (!activeBrandId || readOnly) return;
    setActionLoadingRunId(run.id);
    const seq = contextSeqRef.current;
    try {
      const updated = await pauseVisibilityRun(activeBrandId, run.id, activeMarket);
      if (seq !== contextSeqRef.current) return;
      if (activeRunId === run.id) setActiveRunDetail(updated);
      feedback.notifySuccess('已暂停监测任务');
      void loadRuns(
        activeBrandId,
        activeMarket,
        seq,
        { page: runsPage, status: statusFilter, keyword: keywordFilter },
        true,
      );
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      feedback.notifyError(extractErrorMessage(err, '暂停监测任务失败'));
    } finally {
      if (seq === contextSeqRef.current) {
        setActionLoadingRunId(null);
      }
    }
  };

  const handleResumeRun = async (run: VisibilityRunRecord) => {
    if (!activeBrandId || readOnly) return;
    setActionLoadingRunId(run.id);
    const seq = contextSeqRef.current;
    try {
      const updated = await resumeVisibilityRun(activeBrandId, run.id, activeMarket);
      if (seq !== contextSeqRef.current) return;
      if (activeRunId === run.id) setActiveRunDetail(updated);
      feedback.notifySuccess('已恢复监测任务运行');
      void loadRuns(
        activeBrandId,
        activeMarket,
        seq,
        { page: runsPage, status: statusFilter, keyword: keywordFilter },
        true,
      );
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      feedback.notifyError(extractErrorMessage(err, '恢复监测任务失败'));
    } finally {
      if (seq === contextSeqRef.current) {
        setActionLoadingRunId(null);
      }
    }
  };

  const handleCancelRun = (run: VisibilityRunRecord) => {
    if (!activeBrandId || readOnly) return;
    const title = sanitizeEntityTitleSegment(run.name, '监测任务');
    feedback.confirm({
      title: '确认终止监测任务？',
      content: `终止「${title}」后，尚未执行的监测项将被跳过，对应冻结点数会自动退还。`,
      okText: '确认终止',
      okButtonProps: { danger: true },
      onOk: async () => {
        setActionLoadingRunId(run.id);
        const seq = contextSeqRef.current;
        try {
          const updated = await cancelVisibilityRun(activeBrandId, run.id, activeMarket);
          if (seq !== contextSeqRef.current) return;
          if (activeRunId === run.id) setActiveRunDetail(updated);
          feedback.notifySuccess('监测任务已终止');
          invalidateFreshness('visibility-runs');
          invalidateFreshness('points');
          void consoleCtx?.refreshWallet();
          void loadRuns(
            activeBrandId,
            activeMarket,
            seq,
            { page: runsPage, status: statusFilter, keyword: keywordFilter },
            true,
          );
        } catch (err) {
          if (seq !== contextSeqRef.current) return;
          feedback.notifyError(extractErrorMessage(err, '终止监测任务失败'));
        } finally {
          if (seq === contextSeqRef.current) {
            setActionLoadingRunId(null);
          }
        }
      },
    });
  };

  const handleDeleteRun = (run: VisibilityRunRecord) => {
    if (!activeBrandId || readOnly) return;
    const title = sanitizeEntityTitleSegment(run.name, '监测任务');
    feedback.confirm({
      title: '确认删除该监测记录？',
      content: `删除「${title}」后，该任务下的回答与引用记录将同步移除且不可恢复。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        setActionLoadingRunId(run.id);
        const seq = contextSeqRef.current;
        try {
          await deleteVisibilityRun(activeBrandId, run.id, activeMarket);
          if (seq !== contextSeqRef.current) return;
          feedback.notifySuccess('监测任务已删除');
          if (activeRunId === run.id) {
            setActiveRunState(null);
            setActiveRunDetail(null);
            syncUrlParams({ runId: null });
          }
          void loadRuns(
            activeBrandId,
            activeMarket,
            seq,
            { page: runsPage, status: statusFilter, keyword: keywordFilter },
            false,
          );
          void loadOverview(activeBrandId, activeMarket, seq, days, selectedEngine);
          void loadCitations(activeBrandId, activeMarket, seq, days, sourceFilter);
          void loadOpportunities(activeBrandId, activeMarket, seq, days);
          void loadNearMiss(
            activeBrandId,
            activeMarket,
            seq,
            days,
            nearMissFilterRef.current.tier,
            nearMissFilterRef.current.ownership,
          );
        } catch (err) {
          if (seq !== contextSeqRef.current) return;
          feedback.notifyError(extractErrorMessage(err, '删除监测任务失败'));
        } finally {
          if (seq === contextSeqRef.current) {
            setActionLoadingRunId(null);
          }
        }
      },
    });
  };

  const handleJumpToRunsCreate = () => {
    setActiveTab('runs');
    syncUrlParams({ tab: 'runs' });
    if (typeof document !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('vis-prompts-textarea')?.focus();
      }, 60);
    }
  };

  // ==================== M3 GeoBrief Actions ====================

  const handleBriefSourceFilterChange = (nextSource: GeoBriefSource | '') => {
    setBriefSourceFilter(nextSource);
    if (!activeBrandId) return;
    void loadBriefs(
      activeBrandId,
      activeMarket,
      contextSeqRef.current,
      { status: briefStatusFilter, sourceType: nextSource },
      false,
    );
  };

  const handleBriefStatusFilterChange = (nextStatus: BriefStatusFilterValue) => {
    setBriefStatusFilter(nextStatus);
    setSelectedBriefIds([]);
    if (!activeBrandId) return;
    void loadBriefs(
      activeBrandId,
      activeMarket,
      contextSeqRef.current,
      { status: nextStatus, sourceType: briefSourceFilter },
      false,
    );
  };

  const handleGenerateBrief = async (
    triggerKey: string,
    input: GeoBriefGenerateInput,
    options?: { clearFanOuts?: boolean },
  ) => {
    if (!activeBrandId || readOnly || generatingBriefKey !== null) return;
    briefGenCtrlRef.current?.abort();
    const ctrl = new AbortController();
    briefGenCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setGeneratingBriefKey(triggerKey);
    try {
      const created = await generateBrief(activeBrandId, input, { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setActiveBrief(created);
      if (options?.clearFanOuts) {
        setSelectedFanOuts([]);
      }
      feedback.notifySuccess('已生成 GEO 写作意见（0 点免费）');
      invalidateFreshness('briefs');
      void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
      feedback.notifyError(extractErrorMessage(err, '生成写作意见失败，请稍后重试'));
    } finally {
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setGeneratingBriefKey(null);
      }
    }
  };

  const handleGenerateFromGap = (gap: VisibilityOpportunitiesResponse['gaps'][number]) => {
    void handleGenerateBrief(`gap:${gap.promptText}`, {
      market: activeMarket,
      sourceType: 'AUTO_GAP',
      customPrompt: gap.promptText.slice(0, 300),
    });
  };

  const handleGenerateFromObservation = (obs: VisibilityObservationRecord) => {
    void handleGenerateBrief(`obs:${obs.id}`, {
      market: activeMarket,
      sourceType: deriveObservationBriefSource(obs),
      observationIds: [obs.id],
    });
  };

  const handleGenerateFromCitation = async (row: RankedCitationRow) => {
    if (!activeBrandId || readOnly || generatingBriefKey !== null) return;
    if (!isSafeHttpUrl(row.url)) return;

    briefGenCtrlRef.current?.abort();
    const ctrl = new AbortController();
    briefGenCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setGeneratingBriefKey(`cite:${row.key}`);

    const trimmedTitle = row.title?.trim() ?? '';

    try {
      const created = await createBriefFromCitationUrl(
        activeBrandId,
        {
          market: activeMarket,
          citationUrl: row.url,
          ...(trimmedTitle.length >= 2 ? { targetPrompt: trimmedTitle.slice(0, 300) } : {}),
        },
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setActiveBrief(created);
      feedback.notifySuccess('已生成高引用信源反制意见（0 点免费）');
      invalidateFreshness('briefs');
      void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
      if (isCitationCounterFallbackError(err)) {
        setCitationFallback({
          url: row.url,
          title: row.title?.trim() ?? '',
          errorMessage: extractErrorMessage(
            err,
            '目标页面触发反爬或抓取超时，请粘贴参考正文继续生成反制意见',
          ),
        });
      } else {
        feedback.notifyError(extractErrorMessage(err, '生成竞品反制意见失败，请稍后重试'));
      }
    } finally {
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setGeneratingBriefKey(null);
      }
    }
  };

  const handleGenerateFromFanOuts = (queries: readonly string[]) => {
    if (queries.length === 0) return;
    void handleGenerateBrief(
      'fanout:cluster',
      {
        market: activeMarket,
        sourceType: 'FANOUT_CLUSTER',
        fanOutQueries: queries.slice(0, 20),
      },
      { clearFanOuts: true },
    );
  };

  const handleBoostFromNearMiss = async (item: NearMissItemDto) => {
    if (!activeBrandId || readOnly || generatingBriefKey !== null) return;
    briefGenCtrlRef.current?.abort();
    const ctrl = new AbortController();
    briefGenCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setGeneratingBriefKey(`near-miss:${item.id}`);
    try {
      const payload = buildNearMissBoostInput(item, activeMarket);
      const created = await createBriefFromNearMiss(activeBrandId, payload, {
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      invalidateFreshness('briefs');
      feedback.notifySuccess('已生成补强意见卡（免费），正在前往 GEO 写作台');
      void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
      handleNavigateToStudioWithBrief(created);
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== contextSeqRef.current) return;
      feedback.notifyError(extractErrorMessage(err, '生成补强意见卡失败，请稍后重试'));
    } finally {
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setGeneratingBriefKey(null);
      }
    }
  };

  const handleSaveBrief = async (
    briefId: string,
    patch: GeoBriefUpdateInput,
  ): Promise<GeoBriefRecord> => {
    const seq = contextSeqRef.current;
    const updated = await updateBrief(briefId, patch);
    if (seq === contextSeqRef.current) {
      setActiveBrief((curr) => (curr?.id === updated.id ? updated : curr));
      setBriefs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      feedback.notifySuccess('写作意见已保存');
      invalidateFreshness('briefs');
    }
    return updated;
  };

  const handleDismissBrief = async (brief: GeoBriefRecord): Promise<void> => {
    const seq = contextSeqRef.current;
    try {
      await dismissBrief(brief.id);
      if (seq !== contextSeqRef.current) return;
      if (activeBrief?.id === brief.id) {
        setActiveBrief(null);
      }
      setSelectedBriefIds((prev) => prev.filter((id) => id !== brief.id));
      feedback.notifySuccess('已忽略该写作意见');
      invalidateFreshness('briefs');
      if (activeBrandId) {
        void loadBriefs(activeBrandId, activeMarket, seq, briefFilterRef.current, true);
      }
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      feedback.notifyError(extractErrorMessage(err, '忽略写作意见失败'));
    }
  };

  const handleNavigateToStudioWithBrief = (brief: GeoBriefRecord) => {
    const href = buildWorkspaceHref('/studio', brief.brandId, brief.market, { briefId: brief.id });
    setActiveBrief(null);
    if (consoleCtx?.navigateWorkspace) {
      consoleCtx.navigateWorkspace(href);
    } else if (typeof window !== 'undefined') {
      window.location.assign(href);
    }
  };

  const handleBatchWriteBriefs = async (briefIds: readonly string[]) => {
    if (!activeBrandId || readOnly || batchSubmitting) return;
    if (briefIds.length < 2 || briefIds.length > 20) return;
    setBatchSubmitting(true);
    const seq = contextSeqRef.current;
    try {
      const idemKey = createStudioIdempotencyKey('batch');
      const job = await createBatchJob(
        activeBrandId,
        { market: activeMarket, briefIds: [...briefIds] },
        idemKey,
      );
      if (seq !== contextSeqRef.current) return;
      setSelectedBriefIds([]);
      feedback.notifySuccess(`已提交 ${job.total} 篇批量写作任务，正在前往 GEO 写作台查看进度`);
      invalidateFreshness('briefs', 'articles', 'points');
      void consoleCtx?.refreshWallet();
      const href = buildWorkspaceHref('/studio', activeBrandId, activeMarket, {
        batchJobId: job.id,
      });
      if (consoleCtx?.navigateWorkspace) {
        consoleCtx.navigateWorkspace(href);
      } else if (typeof window !== 'undefined') {
        window.location.assign(href);
      }
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      const msg = err instanceof Error && err.message.trim() ? err.message : '发起批量写作任务失败';
      feedback.notifyError(msg);
    } finally {
      if (seq === contextSeqRef.current) {
        setBatchSubmitting(false);
      }
    }
  };

  // Cold-load skeleton (ZERO 0% / 0 点 / 免费体验期 flash!)
  if (state.brandsLoading) {
    return (
      <section
        className="gm-vis-page"
        aria-label="可见度诊断"
        aria-busy="true"
        data-testid="visibility-loading"
      >
        <div className="gm-panel">
          <Skeleton active title={{ width: '28%' }} paragraph={{ rows: 1 }} />
        </div>
        <KpiStrip items={[]} loading skeletonCount={4} aria-label="可见度核心指标加载中" />
        <div className="gm-panel">
          <SignalSkeleton variant="block" height={300} />
        </div>
      </section>
    );
  }

  if (state.brandsError) {
    return (
      <section className="gm-vis-page" aria-label="可见度诊断">
        <SignalError
          message={state.brandsError}
          onRetry={() =>
            void useWorkspaceStore.getState().loadBrands({
              storage: window.sessionStorage,
              persistStorage: window.localStorage,
            })
          }
        />
      </section>
    );
  }

  // Zero-brand onboarding state
  if (!activeBrand || !activeBrandMarket) {
    return (
      <section className="gm-vis-page" aria-label="可见度诊断">
        <EmptyState
          size="full"
          title="尚未创建品牌资产"
          description="先用 60 秒完成品牌与竞品配置，即可开启国内 8 引擎与海外 5 引擎 AI 可见度诊断。"
          action={
            readOnly ? undefined : (
              <Button type="primary" onClick={() => consoleCtx?.openCreateBrandModal()}>
                立即创建首个品牌
              </Button>
            )
          }
        />
      </section>
    );
  }

  const missingMarket: GeoMarket | null =
    activeBrand.markets.length < 2 ? (activeMarket === 'CN' ? 'GLOBAL' : 'CN') : null;

  const nearMissPanelNode = (
    <VisibilityNearMissPanel
      data={nearMiss}
      loading={nearMissLoading}
      error={nearMissError}
      tierFilter={nearMissTierFilter}
      onTierFilterChange={handleNearMissTierChange}
      ownershipFilter={nearMissOwnershipFilter}
      onOwnershipFilterChange={handleNearMissOwnershipChange}
      onResetFilters={handleResetNearMissFilters}
      onRetry={() => {
        if (!activeBrandId) return;
        void loadNearMiss(
          activeBrandId,
          activeMarket,
          contextSeqRef.current,
          days,
          nearMissFilterRef.current.tier,
          nearMissFilterRef.current.ownership,
        );
      }}
      readOnly={readOnly}
      boostingItemId={
        generatingBriefKey?.startsWith('near-miss:') ? generatingBriefKey.slice(10) : null
      }
      onBoostItem={(item) => void handleBoostFromNearMiss(item)}
    />
  );

  const tabItems = [
    {
      key: 'overview',
      label: <span data-testid="visibility-tab-overview">诊断总览与写作建议</span>,
      children: (
        <VisibilityOverviewTab
          activeMarket={activeMarket}
          days={days}
          overview={overview}
          opportunities={opportunities}
          loading={overviewLoading}
          error={overviewError}
          selectedEngine={selectedEngine}
          onSelectEngine={handleSelectEngine}
          onRetry={() => {
            if (!activeBrandId) return;
            void loadOverview(
              activeBrandId,
              activeMarket,
              contextSeqRef.current,
              days,
              selectedEngine,
            );
          }}
          onSwitchToRuns={handleJumpToRunsCreate}
          readOnly={readOnly}
          briefsSlot={
            <BriefListPanel
              briefs={briefs}
              total={briefsTotal}
              loading={briefsLoading}
              error={briefsError}
              onRetry={() => {
                if (!activeBrandId) return;
                void loadBriefs(
                  activeBrandId,
                  activeMarket,
                  contextSeqRef.current,
                  briefFilterRef.current,
                  false,
                );
              }}
              sourceFilter={briefSourceFilter}
              onSourceFilterChange={handleBriefSourceFilterChange}
              statusFilter={briefStatusFilter}
              onStatusFilterChange={handleBriefStatusFilterChange}
              selectedBriefIds={selectedBriefIds}
              onSelectedBriefIdsChange={setSelectedBriefIds}
              gaps={opportunities?.gaps ?? []}
              generatingGapPrompt={
                generatingBriefKey?.startsWith('gap:') ? generatingBriefKey.slice(4) : null
              }
              onGenerateFromGap={handleGenerateFromGap}
              readOnly={readOnly}
              completedChecks={overview?.metrics?.completedChecks ?? 0}
              onOpenBrief={(brief) => setActiveBrief(brief)}
              onWriteBrief={handleNavigateToStudioWithBrief}
              onDismissBrief={handleDismissBrief}
              onBatchWrite={(ids) => {
                void handleBatchWriteBriefs(ids);
              }}
              batchSubmitting={batchSubmitting}
              onSwitchToRuns={handleJumpToRunsCreate}
              onRefresh={() => {
                if (!activeBrandId) return;
                void loadBriefs(
                  activeBrandId,
                  activeMarket,
                  contextSeqRef.current,
                  briefFilterRef.current,
                  false,
                );
              }}
            />
          }
          nearMissSlot={activeTab === 'overview' ? nearMissPanelNode : null}
        />
      ),
    },
    {
      key: 'runs',
      label: <span data-testid="visibility-tab-runs">监测任务与问答透视</span>,
      children: (
        <VisibilityRunsTab
          activeMarket={activeMarket}
          activeBrandMarket={activeBrandMarket}
          readOnly={readOnly}
          runName={runName}
          onRunNameChange={setRunName}
          promptsText={promptsText}
          onPromptsTextChange={setPromptsText}
          engines={engines}
          enginesLoading={enginesLoading}
          enginesError={enginesError}
          onRetryEngines={() => {
            if (!activeBrandId) return;
            void loadEngines(activeBrandId, activeMarket, contextSeqRef.current);
          }}
          checkedEngines={checkedEngines}
          onCheckedEnginesChange={setCheckedEngines}
          submitting={submitting}
          submitError={submitError}
          onSubmitRun={() => void handleSubmitRun()}
          runs={runs}
          runsTotal={runsTotal}
          runsPage={runsPage}
          runsPageSize={runsPageSize}
          runsLoading={runsLoading}
          runsError={runsError}
          statusFilter={statusFilter}
          keywordFilter={keywordFilter}
          onStatusFilterChange={(next) => handleRunsFilterChange({ page: 1, status: next })}
          onKeywordFilterChange={(next) => handleRunsFilterChange({ page: 1, keyword: next })}
          onPageChange={(page) => handleRunsFilterChange({ page })}
          onRefreshRuns={() => {
            if (!activeBrandId) return;
            void loadRuns(
              activeBrandId,
              activeMarket,
              contextSeqRef.current,
              { page: runsPage, status: statusFilter, keyword: keywordFilter },
              false,
            );
          }}
          activeRunId={activeRunId}
          activeRunDetail={activeRunDetail}
          runDetailLoading={runDetailLoading}
          runDetailError={runDetailError}
          onSelectRun={handleSelectRun}
          onPauseRun={(run) => void handlePauseRun(run)}
          onResumeRun={(run) => void handleResumeRun(run)}
          onCancelRun={handleCancelRun}
          onDeleteRun={handleDeleteRun}
          actionLoadingRunId={actionLoadingRunId}
          obsEngineFilter={obsEngineFilter}
          onObsEngineFilterChange={setObsEngineFilter}
          obsMentionFilter={obsMentionFilter}
          onObsMentionFilterChange={setObsMentionFilter}
          obsSentimentFilter={obsSentimentFilter}
          onObsSentimentFilterChange={setObsSentimentFilter}
          onResetObsFilters={() => {
            setObsEngineFilter('');
            setObsMentionFilter('all');
            setObsSentimentFilter('');
          }}
          renderObservationAction={(obs) => (
            <Button
              size="small"
              data-testid="answer-brief-btn"
              disabled={readOnly || generatingBriefKey !== null}
              loading={generatingBriefKey === `obs:${obs.id}`}
              onClick={() => handleGenerateFromObservation(obs)}
            >
              针对此条提写作意见
            </Button>
          )}
        />
      ),
    },
    {
      key: 'citations',
      label: <span data-testid="visibility-tab-citations">信源阵地与竞品洞察</span>,
      children: (
        <VisibilityCitationsTab
          citations={citations}
          citationsLoading={citationsLoading}
          citationsError={citationsError}
          sourceFilter={sourceFilter}
          onSourceFilterChange={handleSourceFilterChange}
          onRetryCitations={() => {
            if (!activeBrandId) return;
            void loadCitations(
              activeBrandId,
              activeMarket,
              contextSeqRef.current,
              days,
              sourceFilter,
            );
          }}
          runs={runs}
          traceRunId={activeRunId}
          onTraceRunChange={handleSelectRun}
          traceObservations={activeRunDetail?.observations ?? []}
          traceLoading={runDetailLoading}
          onInspectObservationInRunsTab={() => {
            setActiveTab('runs');
            syncUrlParams({ tab: 'runs' });
          }}
          opportunities={opportunities}
          opportunitiesLoading={opportunitiesLoading}
          opportunitiesError={opportunitiesError}
          onRetryOpportunities={() => {
            if (!activeBrandId) return;
            void loadOpportunities(activeBrandId, activeMarket, contextSeqRef.current, days);
          }}
          selectedFanOuts={selectedFanOuts}
          onSelectedFanOutsChange={setSelectedFanOuts}
          renderCitationAction={(row) =>
            row.sourceKind !== 'OWNED' && isSafeHttpUrl(row.url) ? (
              <Button
                size="small"
                data-testid="citation-counter-btn"
                disabled={readOnly || generatingBriefKey !== null}
                loading={generatingBriefKey === `cite:${row.key}`}
                onClick={() => void handleGenerateFromCitation(row)}
              >
                反制重写此页
              </Button>
            ) : null
          }
          renderFanOutBatchAction={(selectedQueries) => (
            <Button
              size="small"
              data-testid="fanout-cluster-btn"
              disabled={readOnly || selectedQueries.length === 0 || generatingBriefKey !== null}
              loading={generatingBriefKey === 'fanout:cluster'}
              onClick={() => handleGenerateFromFanOuts(selectedQueries)}
            >
              合并生成专题意见（{selectedQueries.length}）
            </Button>
          )}
          nearMissSlot={activeTab === 'citations' ? nearMissPanelNode : null}
        />
      ),
    },
  ];

  return (
    <section
      className="gm-vis-page"
      aria-label="可见度诊断"
      data-testid="visibility-workspace"
      data-brand-id={activeBrand.id}
      data-market={activeMarket}
    >
      <PageHeader
        title="可见度诊断"
        description="监测品牌在各 AI 引擎中的提及率、推荐顺位、引用阵地与竞品声量对比"
        tags={
          <>
            <span className="gm-vis-context-chip">
              {activeBrandMarket.localBrandName || activeBrand.name}
            </span>
            <span className="gm-vis-context-chip gm-vis-context-chip--muted">
              {GEO_MARKET_LABELS[activeMarket]} · {activeBrandMarket.locale}
            </span>
          </>
        }
        extra={
          <>
            <div className="gm-vis-day-group" role="group" aria-label="统计时间窗口">
              {DAY_WINDOWS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`gm-day-pill${days === d ? ' gm-day-pill-active' : ''}`}
                  onClick={() => handleDaysChange(d)}
                >
                  {d} 天
                </button>
              ))}
            </div>
            {missingMarket && !readOnly ? (
              <Button size="small" onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}>
                {missingMarket === 'GLOBAL' ? '+ 开启海外市场' : '+ 开启国内市场'}
              </Button>
            ) : null}
          </>
        }
        action={
          <Button
            type={activeTab === 'runs' ? 'default' : 'primary'}
            disabled={readOnly}
            onClick={handleJumpToRunsCreate}
          >
            发起新监测
          </Button>
        }
      />

      {/* 3-Tab Workspace */}
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={tabItems}
        className="gm-vis-tabs"
      />

      {/* M3 Diagnosis-to-Brief Drawer */}
      <GeoBriefDrawer
        open={Boolean(activeBrief)}
        brief={activeBrief}
        brandFacts={brandFacts}
        brandFactsLoading={brandFactsLoading}
        readOnly={readOnly}
        onClose={() => setActiveBrief(null)}
        onSave={handleSaveBrief}
        onDismiss={handleDismissBrief}
        onWrite={handleNavigateToStudioWithBrief}
      />

      {/* M4-B Anti-Scrape Pasted-Content Fallback Modal */}
      {activeBrandId ? (
        <CitationCounterModal
          open={Boolean(citationFallback)}
          brandId={activeBrandId}
          market={activeMarket}
          readOnly={readOnly}
          mode="fallback"
          initialUrl={citationFallback?.url ?? ''}
          initialTitle={citationFallback?.title ?? ''}
          initialTargetPrompt={citationFallback?.title ?? ''}
          initialErrorMessage={citationFallback?.errorMessage ?? null}
          onClose={() => setCitationFallback(null)}
          onCreated={(created) => {
            setCitationFallback(null);
            setActiveBrief(created);
            feedback.notifySuccess('已基于参考正文生成反制意见（0 点免费）');
            invalidateFreshness('briefs');
            void loadBriefs(
              activeBrandId,
              activeMarket,
              contextSeqRef.current,
              briefFilterRef.current,
              true,
            );
          }}
        />
      ) : null}
    </section>
  );
}
