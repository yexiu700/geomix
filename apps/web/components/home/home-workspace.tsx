'use client';

import type {
  ActionHomeResponse,
  BrandFactRecord,
  GeoBriefRecord,
  GeoBriefUpdateInput,
  GeoMarket,
  GeoPublishRecordDto,
} from '@geomix/shared';
import { Button, Skeleton } from 'antd';
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
import { ProductLineSelectorPill } from '../brands/product-line-selector-pill';
import { GeoBriefDrawer } from '../briefs/geo-brief-drawer';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { EmptyState, KpiStrip, PageHeader } from '../ui';
import { HomeCrawlAlertBanner } from './home-crawl-alert-banner';
import { HomeDistributionSummary } from './home-distribution-summary';
import { HomeHealthStrip } from './home-health-strip';
import { HomeRecentArticles } from './home-recent-articles';
import { HomeRoiReportModal } from './home-roi-report-modal';
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
  const activeProductLineId = state.activeProductLineId;
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

  // Monthly GEO ROI Report modal state
  const [roiModalOpen, setRoiModalOpen] = useState(false);

  const contextSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const drawerCtrlRef = useRef<AbortController | null>(null);
  const retestCtrlRef = useRef<AbortController | null>(null);
  const retestingRecordsRef = useRef<Set<string>>(new Set());
  const factsBrandRef = useRef<string | null>(null);

  const loadHome = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      opts?: { silent?: boolean; productLineId?: string | null },
    ) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;

      if (!opts?.silent) {
        setHomeLoading(true);
      }
      setHomeError(null);

      try {
        const res = await fetchActionHome(brandId, market, {
          signal: ctrl.signal,
          productLineId: opts?.productLineId,
        });
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

  // Brand / Market / ProductLine / ContextEpoch switch anti-race reset & reload
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
    setRoiModalOpen(false);

    const nextFactsKey = activeBrandId ? `${activeBrandId}::${activeProductLineId ?? ''}` : null;
    if (factsBrandRef.current !== nextFactsKey) {
      setBrandFacts([]);
      factsBrandRef.current = null;
    }

    if (!activeBrandId || !activeBrandMarketId) {
      setHomeLoading(false);
      return;
    }

    void loadHome(activeBrandId, activeMarket, seq, { productLineId: activeProductLineId });

    return () => {
      loadCtrlRef.current?.abort();
      drawerCtrlRef.current?.abort();
      retestCtrlRef.current?.abort();
      retestCtrlRef.current = null;
      retestingRecords.clear();
    };
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    activeProductLineId,
    state.contextEpoch,
    loadHome,
  ]);

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
        const refreshed = await fetchActionHome(activeBrandId, activeMarket, {
          productLineId: activeProductLineId,
        });
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
          const recheck = await fetchActionHome(activeBrandId, activeMarket, {
            productLineId: activeProductLineId,
          });
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
    domains: [
      'brands',
      'product-lines',
      'visibility-runs',
      'briefs',
      'articles',
      'distributions',
      'publish-records',
    ],
    active: Boolean(activeBrandId && activeBrandMarket),
    refreshOnActivate: false,
    onRefresh: () => {
      if (!activeBrandId || !activeBrandMarket) return;
      void loadHome(activeBrandId, activeMarket, contextSeqRef.current, {
        silent: true,
        productLineId: activeProductLineId,
      });
    },
  });

  const handleOpenBriefDrawer = async (briefId: string) => {
    if (!activeBrandId) return;
    drawerCtrlRef.current?.abort();
    const ctrl = new AbortController();
    drawerCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;

    setLoadingBriefId(briefId);
    const factsKey = `${activeBrandId}::${activeProductLineId ?? ''}`;
    const shouldFetchFacts = factsBrandRef.current !== factsKey;
    if (shouldFetchFacts) setBrandFactsLoading(true);

    try {
      const [brief, factsRes] = await Promise.all([
        getBrief(briefId, { signal: ctrl.signal }),
        shouldFetchFacts
          ? getBrandFacts(activeBrandId, {
              signal: ctrl.signal,
              productLineId: activeProductLineId,
            })
          : Promise.resolve(null),
      ]);
      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
      if (factsRes) {
        setBrandFacts(factsRes.items);
        factsBrandRef.current = factsKey;
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
    const seq = contextSeqRef.current;
    const targetBrandId = activeBrandId;
    const targetMarket = activeMarket;
    const targetProductLineId = activeProductLineId;
    const hasMarket = Boolean(activeBrandMarket);
    const saved = await updateBrief(briefId, patch);
    invalidateFreshness('briefs');
    if (seq !== contextSeqRef.current) return saved;
    setDrawerBrief(saved);
    if (targetBrandId && hasMarket) {
      void loadHome(targetBrandId, targetMarket, seq, {
        silent: true,
        productLineId: targetProductLineId,
      });
    }
    return saved;
  };

  const handleDismissDrawerBrief = async (brief: GeoBriefRecord): Promise<void> => {
    const seq = contextSeqRef.current;
    const targetBrandId = activeBrandId;
    const targetMarket = activeMarket;
    const targetProductLineId = activeProductLineId;
    const hasMarket = Boolean(activeBrandMarket);
    await dismissBrief(brief.id);
    invalidateFreshness('briefs');
    if (seq !== contextSeqRef.current) return;
    setDrawerOpen(false);
    setDrawerBrief(null);
    feedback.notifySuccess('已忽略该写作建议');
    if (targetBrandId && hasMarket) {
      void loadHome(targetBrandId, targetMarket, seq, {
        silent: true,
        productLineId: targetProductLineId,
      });
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
    homeData.brandMarketId === activeBrandMarket.id &&
    (homeData.productLineId ?? null) === (activeProductLineId ?? null),
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
        <KpiStrip items={[]} loading skeletonCount={4} aria-label="品牌健康信号条加载中" />
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
        <div className="gm-home-loading-rows">
          <SignalSkeleton variant="row" rows={5} />
        </div>
      </section>
    );
  }

  // 2. Brand store load error
  if (state.brandsError) {
    return (
      <section className="gm-home-page" aria-label="行动首页">
        <SignalError
          message={state.brandsError}
          onRetry={() => void useWorkspaceStore.getState().loadBrands()}
        />
      </section>
    );
  }

  // 3. Zero-brand onboarding state (exact CTA "60 秒创建首个品牌", zero /home API calls!)
  if (state.brandsLoaded && state.brands.length === 0) {
    return (
      <section className="gm-home-page" aria-label="行动首页" data-testid="home-onboarding">
        <EmptyState
          size="full"
          title="欢迎使用 GeoMix 行动首页"
          description="先用 60 秒创建首个品牌并提炼 4 块真实产品事实卡，即可开启国内 / 海外隔离的 AI 可见度监测、优先写作建议与发布复测闭环。"
          action={
            readOnly ? undefined : (
              <Button type="primary" onClick={() => consoleCtx?.openCreateBrandModal()}>
                60 秒创建首个品牌
              </Button>
            )
          }
        />
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
            onRetry={() =>
              void loadHome(activeBrand.id, activeMarket, contextSeqRef.current, {
                productLineId: activeProductLineId,
              })
            }
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
      <PageHeader
        title="行动首页"
        description={`${activeBrandMarket.localBrandName} · ${activeBrand.category} · 近 ${resolvedData.health.days} 天（已完成 ${resolvedData.health.completedChecks} 次有效检测）`}
        tags={
          <span className="gm-home-chip">
            {activeMarket === 'GLOBAL' ? '海外市场（GLOBAL）' : '国内市场（CN）'}
          </span>
        }
        extra={
          <>
            <Button
              size="small"
              data-testid="home-cta-write"
              disabled={readOnly}
              onClick={() => consoleCtx?.navigateWorkspace('/studio')}
            >
              直接写 GEO 文章
            </Button>
            <Button
              size="small"
              data-testid="home-open-roi-report-btn"
              onClick={() => setRoiModalOpen(true)}
            >
              生成月度 GEO ROI 报告
            </Button>
            {missingMarket ? (
              <Button
                size="small"
                disabled={readOnly}
                onClick={() => consoleCtx?.openEnableMarketModal(missingMarket)}
              >
                + 开启{missingMarket === 'GLOBAL' ? '海外' : '国内'}市场
              </Button>
            ) : null}
          </>
        }
        action={
          <Button
            type="primary"
            data-testid="home-cta-monitor"
            disabled={readOnly}
            onClick={() => consoleCtx?.navigateWorkspace('/visibility?tab=runs')}
          >
            发起新一轮监测
          </Button>
        }
      />

      {/* Progressive Multi-Product-Line Switcher (renders null for single-category brands) */}
      <ProductLineSelectorPill />

      {/* Block 1: Honest Brand Health Signal Strip */}
      <HomeHealthStrip activeMarket={activeMarket} health={resolvedData.health} />

      {/* Hoisted P0 Crawl Alert Banner (directly below KpiStrip, above Top 3 Briefs, zero duplicate) */}
      <HomeCrawlAlertBanner
        alerts={resolvedData.distributionSummary?.crawlAlerts ?? []}
        onOpenArticle={(articleId) =>
          consoleCtx?.navigateWorkspace(`/studio?articleId=${encodeURIComponent(articleId)}`)
        }
      />

      {/* Block 2: Today's Top 3 Priority Briefs */}
      <HomeTopBriefs
        topBriefs={resolvedData.topBriefs}
        loadingBriefId={loadingBriefId}
        readOnly={readOnly}
        onOpenBriefDrawer={(briefId) => void handleOpenBriefDrawer(briefId)}
        onWriteBrief={handleWriteBrief}
        onViewAllBriefs={() => consoleCtx?.navigateWorkspace('/visibility?tab=overview')}
        onWriteArticle={() => consoleCtx?.navigateWorkspace('/studio')}
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

      {/* Block 4: Distribution Tracking & Channel Attribution (v2.1 #355 + v2.2 #372 CI/DiD + #387 Budget Board) */}
      <HomeDistributionSummary
        summary={resolvedData.distributionSummary}
        retestBudget={resolvedData.retestBudget}
        recentArticles={resolvedData.recentArticles}
        hideCrawlAlerts
        onOpenArticle={(articleId) =>
          consoleCtx?.navigateWorkspace(`/studio?articleId=${encodeURIComponent(articleId)}`)
        }
        onOpenPoints={() => consoleCtx?.navigateWorkspace('/account?tab=points')}
        onOpenBudgetSettings={() => consoleCtx?.navigateWorkspace('/brands?section=identity')}
        onOpenStudio={() => consoleCtx?.navigateWorkspace('/studio')}
        onOpenRoiReportModal={() => setRoiModalOpen(true)}
      />

      <HomeRoiReportModal
        open={roiModalOpen}
        brandId={activeBrand.id}
        brandName={activeBrandMarket.localBrandName}
        market={activeMarket}
        readOnly={readOnly}
        onClose={() => setRoiModalOpen(false)}
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
