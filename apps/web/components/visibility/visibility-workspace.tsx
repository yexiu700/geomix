'use client';

import type {
  CitationSourceKind,
  GeoMarket,
  TaskStatusName,
  VisibilityCitationListResponse,
  VisibilityEngineAvailabilityItem,
  VisibilityEngineKey,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewResponse,
  VisibilityRunDetailRecord,
  VisibilityRunRecord,
} from '@geomix/shared';
import { GEO_MARKET_LABELS, sanitizeEntityTitleSegment } from '@geomix/shared';
import { Button, Skeleton, Tabs, Tag, Typography } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  cancelVisibilityRun,
  createVisibilityIdempotencyKey,
  createVisibilityRun,
  deleteVisibilityRun,
  fetchVisibilityCitations,
  fetchVisibilityEngines,
  fetchVisibilityOpportunities,
  fetchVisibilityOverview,
  fetchVisibilityRunDetail,
  fetchVisibilityRuns,
  filterEnginesForMarket,
  parsePromptLines,
  pauseVisibilityRun,
  resumeVisibilityRun,
} from '../../lib/visibility';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { VisibilityCitationsTab } from './visibility-citations-tab';
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

  // Anti-race AbortControllers + monotonic sequence counter
  const contextSeqRef = useRef(0);
  const prevContextKeyRef = useRef<string | null>(null);
  const overviewCtrlRef = useRef<AbortController | null>(null);
  const enginesCtrlRef = useRef<AbortController | null>(null);
  const runsCtrlRef = useRef<AbortController | null>(null);
  const runDetailCtrlRef = useRef<AbortController | null>(null);
  const citationsCtrlRef = useRef<AbortController | null>(null);
  const opportunitiesCtrlRef = useRef<AbortController | null>(null);
  const hadLiveRunsRef = useRef(false);
  const daysRef = useRef(days);
  daysRef.current = days;

  const abortAllControllers = useCallback(() => {
    overviewCtrlRef.current?.abort();
    enginesCtrlRef.current?.abort();
    runsCtrlRef.current?.abort();
    runDetailCtrlRef.current?.abort();
    citationsCtrlRef.current?.abort();
    opportunitiesCtrlRef.current?.abort();
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
    hadLiveRunsRef.current = false;

    const activeBrandMarketId = activeBrandMarket?.id ?? null;
    if (!activeBrandId || !activeBrandMarketId) {
      setOverviewLoading(false);
      setEnginesLoading(false);
      setRunsLoading(false);
      setCitationsLoading(false);
      setOpportunitiesLoading(false);
      return;
    }

    const windowDays = daysRef.current;
    void loadOverview(activeBrandId, activeMarket, seq, windowDays, undefined);
    void loadEngines(activeBrandId, activeMarket, seq);
    void loadRuns(activeBrandId, activeMarket, seq, { page: 1, status: '', keyword: '' }, false);
    void loadCitations(activeBrandId, activeMarket, seq, windowDays, undefined);
    void loadOpportunities(activeBrandId, activeMarket, seq, windowDays);
  }, [
    abortAllControllers,
    activeBrandId,
    activeBrandMarket?.id,
    activeMarket,
    loadCitations,
    loadEngines,
    loadOpportunities,
    loadOverview,
    loadRuns,
    state.contextEpoch,
  ]);

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

  // Refetch overview/citations/opportunities when time window or engine/source filters change
  const handleDaysChange = (nextDays: number) => {
    setDays(nextDays);
    if (!activeBrandId) return;
    const seq = contextSeqRef.current;
    void loadOverview(activeBrandId, activeMarket, seq, nextDays, selectedEngine);
    void loadCitations(activeBrandId, activeMarket, seq, nextDays, sourceFilter);
    void loadOpportunities(activeBrandId, activeMarket, seq, nextDays);
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
    setActiveTab(tab);
    syncUrlParams({ tab });
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
      void consoleCtx?.refreshWallet();
    }
  }, [
    activeBrandId,
    activeMarket,
    consoleCtx,
    days,
    hasLiveRuns,
    loadCitations,
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
    domains: ['visibility-runs', 'brands'],
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
        <div className="gm-overview-kpi-grid">
          <SignalSkeleton variant="kpi" />
          <SignalSkeleton variant="kpi" />
          <SignalSkeleton variant="kpi" />
          <SignalSkeleton variant="kpi" />
        </div>
        <div className="gm-panel">
          <SignalSkeleton variant="block" height={300} />
        </div>
      </section>
    );
  }

  // Zero-brand onboarding state
  if (!activeBrand || !activeBrandMarket) {
    return (
      <section className="gm-vis-page" aria-label="可见度诊断">
        <div className="gm-panel">
          <SignalEmpty
            title="尚未创建品牌资产"
            description="先用 60 秒完成品牌与竞品配置，即可开启国内 8 引擎与海外 5 引擎 AI 可见度诊断。"
            actionText={readOnly ? undefined : '立即创建首个品牌'}
            onAction={readOnly ? undefined : () => consoleCtx?.openCreateBrandModal()}
          />
        </div>
      </section>
    );
  }

  const missingMarket: GeoMarket | null =
    activeBrand.markets.length < 2 ? (activeMarket === 'CN' ? 'GLOBAL' : 'CN') : null;

  const tabItems = [
    {
      key: 'overview',
      label: <span data-testid="visibility-tab-overview">诊断总览与写作建议</span>,
      children: (
        <VisibilityOverviewTab
          activeMarket={activeMarket}
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
        />
      ),
    },
  ];

  return (
    <section
      className="gm-vis-page"
      aria-label="可见度诊断"
      data-brand-id={activeBrand.id}
      data-market={activeMarket}
    >
      {/* Top Context Header Bar */}
      <div className="gm-panel gm-vis-header">
        <div className="gm-vis-header-left">
          <Typography.Title level={4} style={{ margin: 0 }}>
            可见度诊断
          </Typography.Title>
          <Tag color="geekblue">{activeBrandMarket.localBrandName || activeBrand.name}</Tag>
          <Tag>
            {GEO_MARKET_LABELS[activeMarket]} · {activeBrandMarket.locale}
          </Tag>
        </div>

        <div className="gm-vis-header-right">
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

          <Button type="primary" disabled={readOnly} onClick={handleJumpToRunsCreate}>
            发起新监测
          </Button>
        </div>
      </div>

      {/* 3-Tab Workspace */}
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={tabItems}
        className="gm-vis-tabs"
      />
    </section>
  );
}
