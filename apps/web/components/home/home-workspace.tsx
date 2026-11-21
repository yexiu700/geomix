'use client';

import type {
  ActionHomeResponse,
  BrandFactRecord,
  GeoBriefRecord,
  GeoBriefUpdateInput,
  GeoMarket,
  GeoPublishRecordDto,
} from '@geomix/shared';
import { Button, Skeleton, Tag } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts } from '../../lib/brands';
import { dismissBrief, getBrief, updateBrief } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import { fetchActionHome } from '../../lib/home';
import { triggerPublishRetest } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import { fetchVisibilityRunDetail } from '../../lib/visibility';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { GeoBriefDrawer } from '../briefs/geo-brief-drawer';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { HomeHealthStrip } from './home-health-strip';
import { HomeRecentArticles } from './home-recent-articles';
import { HomeTopBriefs } from './home-top-briefs';

function formatHomeError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) return err.message || fallback;
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

export function HomeWorkspace(): JSX.Element {
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeBrandId = activeBrand?.id ?? null;
  const activeBrandMarketId = activeBrandMarket?.id ?? null;
  const activeMarket = state.activeMarket;
  const consoleCtx = useConsoleContext();
  const readOnly = consoleCtx?.readOnly ?? false;
  const feedback = useUxFeedback();

  const [homeData, setHomeData] = useState<ActionHomeResponse | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);

  // GeoBriefDrawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerBrief, setDrawerBrief] = useState<GeoBriefRecord | null>(null);
  const [loadingBriefId, setLoadingBriefId] = useState<string | null>(null);
  const [brandFacts, setBrandFacts] = useState<BrandFactRecord[]>([]);
  const [brandFactsLoading, setBrandFactsLoading] = useState(false);

  // One-click retest polling state
  const [retestingRecordId, setRetestingRecordId] = useState<string | null>(null);
  const [pendingRetestRuns, setPendingRetestRuns] = useState<
    Array<{ recordId: string; runId: string }>
  >([]);

  const contextSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const drawerCtrlRef = useRef<AbortController | null>(null);
  const retestCtrlRef = useRef<AbortController | null>(null);
  const retestingRecordsRef = useRef<Set<string>>(new Set());
  const factsBrandRef = useRef<string | null>(null);

  const loadHome = useCallback(
    async (brandId: string, market: GeoMarket, seq: number, opts?: { silent?: boolean }) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;

      if (!opts?.silent) {
        setHomeLoading(true);
      }
      setHomeError(null);

      try {
        const res = await fetchActionHome(brandId, market, { signal: ctrl.signal });
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        setHomeData(res);
      } catch (err) {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        setHomeError(formatHomeError(err, '加载行动首页失败，请稍后重试'));
      } finally {
        if (seq === contextSeqRef.current && !ctrl.signal.aborted) {
          setHomeLoading(false);
        }
      }
    },
    [],
  );

  // Brand / Market / ContextEpoch switch anti-race reset & reload
  useEffect(() => {
    loadCtrlRef.current?.abort();
    drawerCtrlRef.current?.abort();
    retestCtrlRef.current?.abort();
    retestCtrlRef.current = null;
    const retestingRecords = retestingRecordsRef.current;
    retestingRecords.clear();
    const seq = ++contextSeqRef.current;

    setHomeData(null);
    setHomeError(null);
    setDrawerOpen(false);
    setDrawerBrief(null);
    setLoadingBriefId(null);
    setBrandFactsLoading(false);
    setRetestingRecordId(null);
    setPendingRetestRuns([]);

    if (factsBrandRef.current !== activeBrandId) {
      setBrandFacts([]);
      factsBrandRef.current = null;
    }

    if (!activeBrandId || !activeBrandMarketId) {
      setHomeLoading(false);
      return;
    }

    void loadHome(activeBrandId, activeMarket, seq);

    return () => {
      loadCtrlRef.current?.abort();
      drawerCtrlRef.current?.abort();
      retestCtrlRef.current?.abort();
      retestCtrlRef.current = null;
      retestingRecords.clear();
    };
  }, [activeBrandId, activeBrandMarketId, activeMarket, state.contextEpoch, loadHome]);

  // Poll pending retest runs triggered from /home recent articles
  const pollingRecordIds = useMemo(
    () => new Set(pendingRetestRuns.map((item) => item.recordId)),
    [pendingRetestRuns],
  );

  useTaskPolling({
    enabled: Boolean(activeBrandId && activeBrandMarket && pendingRetestRuns.length > 0),
    active: pendingRetestRuns.length > 0,
    intervalMs: 2_500,
    onPoll: async () => {
      if (!activeBrandId || !activeBrandMarket || pendingRetestRuns.length === 0) return;
      const seq = contextSeqRef.current;
      try {
        const refreshed = await fetchActionHome(activeBrandId, activeMarket);
        if (seq !== contextSeqRef.current) return;
        setHomeData(refreshed);

        const succeededIds = new Set<string>();
        const failedIds = new Set<string>();
        const terminalNoMetricsIds = new Set<string>();
        const terminalCandidates: Array<{
          recordId: string;
          runId: string;
          zeroSuccess: boolean;
        }> = [];

        for (const pending of pendingRetestRuns) {
          const matchedArticle = refreshed.recentArticles.find(
            (a) => a.publishRecord?.id === pending.recordId,
          );
          if (
            matchedArticle?.publishRecord?.afterMetrics &&
            matchedArticle.publishRecord.latestRetestRunId === pending.runId
          ) {
            succeededIds.add(pending.recordId);
            continue;
          }
          try {
            const detail = await fetchVisibilityRunDetail(
              activeBrandId,
              pending.runId,
              activeMarket,
            );
            if (seq !== contextSeqRef.current) return;
            if (detail.status === 'FAILED' || detail.status === 'CANCELLED') {
              failedIds.add(pending.recordId);
            } else if (detail.status === 'COMPLETED' || detail.status === 'PARTIAL') {
              terminalCandidates.push({
                recordId: pending.recordId,
                runId: pending.runId,
                zeroSuccess: detail.doneCount === 0,
              });
            }
          } catch {
            // Keep polling on transient lookup failure
          }
        }

        let hadZeroSuccess = false;
        if (terminalCandidates.length > 0 && seq === contextSeqRef.current) {
          const recheck = await fetchActionHome(activeBrandId, activeMarket);
          if (seq !== contextSeqRef.current) return;
          setHomeData(recheck);
          for (const candidate of terminalCandidates) {
            const matched = recheck.recentArticles.find(
              (a) => a.publishRecord?.id === candidate.recordId,
            );
            if (
              matched?.publishRecord?.afterMetrics &&
              matched.publishRecord.latestRetestRunId === candidate.runId
            ) {
              succeededIds.add(candidate.recordId);
            } else {
              terminalNoMetricsIds.add(candidate.recordId);
              if (candidate.zeroSuccess) hadZeroSuccess = true;
            }
          }
        }

        const doneIds = new Set([...succeededIds, ...failedIds, ...terminalNoMetricsIds]);
        if (doneIds.size > 0 && seq === contextSeqRef.current) {
          setPendingRetestRuns((prev) => prev.filter((item) => !doneIds.has(item.recordId)));
          void consoleCtx?.refreshWallet();
          invalidateFreshness('publish-records', 'visibility-runs', 'points');
          if (succeededIds.size > 0) {
            feedback.notifySuccess('复测已完成，已刷新最新排名对比');
          }
          if (failedIds.size > 0) {
            feedback.notifyWarning('本次复测未成功完成，已按规则退还异常引擎点数');
          }
          if (terminalNoMetricsIds.size > 0) {
            feedback.notifyWarning(
              hadZeroSuccess
                ? '复测已结束，本次无引擎返回有效观测结果'
                : '复测已结束，暂未生成对比指标',
            );
          }
        }
      } catch {
        // Silent retry on next poll tick
      }
    },
  });

  useTabFreshness({
    domains: ['brands', 'visibility-runs', 'briefs', 'articles', 'publish-records'],
    active: Boolean(activeBrandId && activeBrandMarket),
    onRefresh: () => {
      if (!activeBrandId || !activeBrandMarket) return;
      void loadHome(activeBrandId, activeMarket, contextSeqRef.current, { silent: true });
    },
  });

  const handleOpenBriefDrawer = async (briefId: string) => {
    if (!activeBrandId) return;
    drawerCtrlRef.current?.abort();
    const ctrl = new AbortController();
    drawerCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;

    setLoadingBriefId(briefId);
    const shouldFetchFacts = factsBrandRef.current !== activeBrandId;
    if (shouldFetchFacts) setBrandFactsLoading(true);

    try {
      const [brief, factsRes] = await Promise.all([
        getBrief(briefId, { signal: ctrl.signal }),
        shouldFetchFacts
          ? getBrandFacts(activeBrandId, { signal: ctrl.signal })
          : Promise.resolve(null),
      ]);
      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
      if (factsRes) {
        setBrandFacts(factsRes.items);
        factsBrandRef.current = activeBrandId;
      }
      setDrawerBrief(brief);
      setDrawerOpen(true);
    } catch (err) {
      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
      feedback.notifyError(formatHomeError(err, '加载写作意见详情失败'));
    } finally {
      if (seq === contextSeqRef.current && !ctrl.signal.aborted) {
        setLoadingBriefId(null);
        setBrandFactsLoading(false);
      }
    }
  };

  const handleSaveDrawerBrief = async (
    briefId: string,
    patch: GeoBriefUpdateInput,
  ): Promise<GeoBriefRecord> => {
    const saved = await updateBrief(briefId, patch);
    setDrawerBrief(saved);
    invalidateFreshness('briefs');
    if (activeBrandId && activeBrandMarket) {
      void loadHome(activeBrandId, activeMarket, contextSeqRef.current, { silent: true });
    }
    return saved;
  };

  const handleDismissDrawerBrief = async (brief: GeoBriefRecord): Promise<void> => {
    await dismissBrief(brief.id);
    setDrawerOpen(false);
    setDrawerBrief(null);
    feedback.notifySuccess('已忽略该写作建议');
    invalidateFreshness('briefs');
    if (activeBrandId && activeBrandMarket) {
      void loadHome(activeBrandId, activeMarket, contextSeqRef.current, { silent: true });
    }
  };

  const handleWriteBrief = (briefId: string) => {
    consoleCtx?.navigateWorkspace(`/studio?briefId=${encodeURIComponent(briefId)}`);
  };

  const handleTriggerArticleRetest = async (record: GeoPublishRecordDto) => {
    if (
      !activeBrandId ||
      readOnly ||
      retestingRecordsRef.current.size > 0 ||
      retestingRecordsRef.current.has(record.id)
    ) {
      return;
    }
    retestingRecordsRef.current.add(record.id);
    setRetestingRecordId(record.id);
    retestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    retestCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    try {
      const run = await triggerPublishRetest(record.id, undefined, undefined, {
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setPendingRetestRuns((prev) => [
        ...prev.filter((item) => item.recordId !== record.id),
        { recordId: record.id, runId: run.id },
      ]);
      void consoleCtx?.refreshWallet();
      invalidateFreshness('visibility-runs', 'points');
      feedback.notifySuccess('已发起定向复测，完成后自动回写 Before → After 对比');
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      feedback.notifyError(formatHomeError(err, '发起复测失败'));
      void consoleCtx?.refreshWallet();
    } finally {
      if (retestCtrlRef.current === ctrl) {
        retestCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current) {
        retestingRecordsRef.current.delete(record.id);
        setRetestingRecordId(null);
      }
    }
  };

  const hasFreshHomeData = Boolean(
    homeData &&
    activeBrand &&
    activeBrandMarket &&
    homeData.brandId === activeBrand.id &&
    homeData.brandMarketId === activeBrandMarket.id,
  );

  // 1. Cold-load & brand/market-switch Skeleton (ZERO 0% / 0 点 / 免费体验期 / ¥0.00 / stale-brand flash!)
  if (
    state.brandsLoading ||
    (Boolean(activeBrand && activeBrandMarket) && (homeLoading || !homeError) && !hasFreshHomeData)
  ) {
    return (
      <section
        className="gm-home-page"
        aria-label="行动首页"
        aria-busy="true"
        data-testid="home-loading"
      >
        <div className="gm-panel gm-home-block">
          <div className="gm-home-kpi-grid">
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
            <SignalSkeleton variant="kpi" />
          </div>
        </div>
        <div className="gm-panel gm-home-block">
          <div className="gm-home-brief-grid">
            <div className="gm-home-brief-card">
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
            <div className="gm-home-brief-card">
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
            <div className="gm-home-brief-card">
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
          </div>
        </div>
        <div className="gm-panel gm-home-block">
          <SignalSkeleton variant="row" rows={5} />
        </div>
      </section>
    );
  }

  // 2. Brand store load error
  if (state.brandsError) {
    return (
      <section className="gm-home-page" aria-label="行动首页">
        <div className="gm-panel">
          <SignalError
            message={state.brandsError}
            onRetry={() => void useWorkspaceStore.getState().loadBrands()}
          />
        </div>
      </section>
    );
  }

  // 3. Zero-brand onboarding state (exact CTA "60 秒创建首个品牌", zero /home API calls!)
  if (state.brandsLoaded && state.brands.length === 0) {
    return (
      <section className="gm-home-page" aria-label="行动首页" data-testid="home-onboarding">
        <div className="gm-panel">
          <SignalEmpty
            title="欢迎使用 GeoMix 行动首页"
            description="先用 60 秒创建首个品牌并提炼 4 块真实产品事实卡，即可开启国内 / 海外隔离的 AI 可见度监测、优先写作建议与发布复测闭环。"
            actionText={readOnly ? undefined : '60 秒创建首个品牌'}
            onAction={readOnly ? undefined : () => consoleCtx?.openCreateBrandModal()}
          />
        </div>
      </section>
    );
  }

  if (!activeBrand || !activeBrandMarket) {
    return (
      <section className="gm-home-page" aria-label="行动首页" aria-busy="true">
        <div className="gm-panel">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      </section>
    );
  }

  // 4. Action Home fetch error
  if (homeError && !hasFreshHomeData) {
    return (
      <section className="gm-home-page" aria-label="行动首页">
        <div className="gm-panel">
          <SignalError
            message={homeError}
            onRetry={() => void loadHome(activeBrand.id, activeMarket, contextSeqRef.current)}
          />
        </div>
      </section>
    );
  }

  const resolvedData: ActionHomeResponse = homeData ?? {
    brandId: activeBrand.id,
    brandMarketId: activeBrandMarket.id,
    market: activeMarket,
    health: {
      days: 14,
      mentionRatePct: 0,
      shareOfVoicePct: 0,
      avgPosition: null,
      ownedCitationRatePct: 0,
      completedChecks: 0,
    },
    topBriefs: [],
    recentArticles: [],
  };

  const missingMarket: GeoMarket | null =
    activeBrand.markets.length < 2 ? (activeMarket === 'CN' ? 'GLOBAL' : 'CN') : null;

  return (
    <section className="gm-home-page" aria-label="行动首页" data-testid="home-workspace">
      <header className="gm-home-context-bar">
        <div className="gm-home-context-info">
          <h1 className="gm-home-page-title">{activeBrandMarket.localBrandName}</h1>
          <Tag color={activeMarket === 'GLOBAL' ? 'blue' : 'cyan'} style={{ margin: 0 }}>
            {activeMarket === 'GLOBAL' ? '🌐 海外市场（Global）' : '🇨🇳 国内市场（CN）'}
          </Tag>
          <span className="gm-home-context-category">{activeBrand.category}</span>
        </div>

        {missingMarket ? (
          <Button
            size="small"
            disabled={readOnly}
            onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
          >
            + 开启{missingMarket === 'GLOBAL' ? '海外' : '国内'}市场
          </Button>
        ) : null}
      </header>

      {/* Block 1: Brand Health Signal Strip */}
      <HomeHealthStrip
        activeMarket={activeMarket}
        health={resolvedData.health}
        readOnly={readOnly}
        onStartMonitor={() => consoleCtx?.navigateWorkspace('/visibility?tab=runs')}
        onWriteArticle={() => consoleCtx?.navigateWorkspace('/studio')}
      />

      {/* Block 2: Today's Top 3 Priority Briefs */}
      <HomeTopBriefs
        topBriefs={resolvedData.topBriefs}
        loadingBriefId={loadingBriefId}
        readOnly={readOnly}
        onOpenBriefDrawer={(briefId) => void handleOpenBriefDrawer(briefId)}
        onWriteBrief={handleWriteBrief}
        onViewAllBriefs={() => consoleCtx?.navigateWorkspace('/visibility?tab=overview')}
        onStartMonitor={() => consoleCtx?.navigateWorkspace('/visibility?tab=runs')}
      />

      {/* Block 3: Recent 5 Articles & Retest Tracker */}
      <HomeRecentArticles
        recentArticles={resolvedData.recentArticles}
        retestingRecordId={retestingRecordId}
        pollingRecordIds={pollingRecordIds}
        readOnly={readOnly}
        onOpenArticle={(articleId) =>
          consoleCtx?.navigateWorkspace(`/studio?articleId=${encodeURIComponent(articleId)}`)
        }
        onTriggerRetest={(rec) => void handleTriggerArticleRetest(rec)}
        onOpenStudio={() => consoleCtx?.navigateWorkspace('/studio')}
      />

      <GeoBriefDrawer
        open={drawerOpen}
        brief={drawerBrief}
        brandFacts={brandFacts}
        brandFactsLoading={brandFactsLoading}
        readOnly={readOnly}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerBrief(null);
        }}
        onSave={handleSaveDrawerBrief}
        onDismiss={handleDismissDrawerBrief}
        onWrite={(savedBrief) => handleWriteBrief(savedBrief.id)}
      />
    </section>
  );
}
