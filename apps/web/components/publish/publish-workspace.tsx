'use client';

import {
  GEO_ARTICLE_STATUSES,
  GEO_ARTICLE_STATUS_LABELS,
  GEO_MARKET_LABELS,
  GLOBAL_SUPPORTED_LOCALES,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  resolveEffectiveLocale,
  type BrandFactRecord,
  type GeoArticlePublishFilter,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBriefRecord,
  type GeoMarket,
  type GeoPublishRecordDto,
  type PreflightItemCode,
  type PublishRecordCreateInput,
  type SupportedLocale,
  type VisibilityEngineAvailabilityItem,
  type VisibilityEngineKey,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Drawer, Modal, Skeleton, Space, Tabs, Tooltip } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts } from '../../lib/brands';
import { getBrief } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import {
  createPublishRecord,
  fetchArticles,
  fetchPublishRecords,
  getArticle,
  triggerPublishRetest,
  updateArticle,
} from '../../lib/studio';
import {
  invalidateFreshness,
  useTabFreshness,
  type FreshnessDomain,
} from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  fetchVisibilityEngines,
  fetchVisibilityRunDetail,
  filterEnginesForMarket,
} from '../../lib/visibility';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { ProductLineSelectorPill } from '../brands/product-line-selector-pill';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { StudioDeliveryPack } from '../studio/studio-delivery-pack';
import { DistributionWorkbench } from '../studio/studio-distribution-drawer';
import { StudioPublishRetest } from '../studio/studio-publish-retest';
import { StatusBadge } from '../ui';
import { PublishArticleQueue } from './publish-article-queue';

export type PublishTabKey = 'distribute' | 'tracking' | 'delivery';

function parsePublishTab(raw: string | null | undefined): PublishTabKey | null {
  if (raw === 'distribute' || raw === 'tracking' || raw === 'delivery') {
    return raw;
  }
  return null;
}

function defaultTabForArticle(article: GeoArticleRecord): PublishTabKey {
  if (
    article.hasCrawlAlert ||
    article.status === 'PUBLISHED' ||
    (article.publishRecordCount ?? 0) > 0
  ) {
    return 'tracking';
  }
  return 'distribute';
}

function readPublishUrlParams(): {
  brandId: string | null;
  market: string | null;
  productLineId: string | null;
  articleId: string | null;
  tab: PublishTabKey | null;
} {
  if (typeof window === 'undefined') {
    return {
      brandId: null,
      market: null,
      productLineId: null,
      articleId: null,
      tab: null,
    };
  }
  const sp = new URLSearchParams(window.location.search);
  const rawMarket = sp.get('market')?.trim().toUpperCase() || null;
  return {
    brandId: sp.get('brandId')?.trim() || null,
    market: rawMarket === 'CN' || rawMarket === 'GLOBAL' ? rawMarket : null,
    productLineId: sp.get('productLineId')?.trim() || null,
    articleId: sp.get('articleId')?.trim() || null,
    tab: parsePublishTab(sp.get('tab')?.trim()),
  };
}

function replacePublishUrlParam(key: 'articleId' | 'tab', value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  } catch {
    // Ignore history restrictions in constrained test environments
  }
}

function formatPublishError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

export function PublishWorkspace(): JSX.Element {
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

  const [isCompactRailViewport, setIsCompactRailViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(min-width: 921px) and (max-width: 1359px)').matches;
  });
  const [isNarrowDrawerViewport, setIsNarrowDrawerViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 920px)').matches;
  });
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = useState(false);
  const leftCollapseManualRef = useRef(false);

  const [articles, setArticles] = useState<GeoArticleRecord[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [publishFilter, setPublishFilter] = useState<GeoArticlePublishFilter>('ALL');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [brandFacts, setBrandFacts] = useState<BrandFactRecord[]>([]);
  const [activeArticle, setActiveArticle] = useState<GeoArticleRecord | null>(null);
  const [linkedBrief, setLinkedBrief] = useState<GeoBriefRecord | null>(null);
  const [activeTab, setActiveTab] = useState<PublishTabKey>('distribute');

  const [publishRecords, setPublishRecords] = useState<GeoPublishRecordDto[]>([]);
  const [publishRecordsLoading, setPublishRecordsLoading] = useState(false);
  const [retestingRecordId, setRetestingRecordId] = useState<string | null>(null);
  const [pendingRetest, setPendingRetest] = useState<{
    recordId: string;
    runId: string;
    articleId: string;
  } | null>(null);
  const [retestModalRecord, setRetestModalRecord] = useState<GeoPublishRecordDto | null>(null);
  const [retestEngines, setRetestEngines] = useState<VisibilityEngineAvailabilityItem[]>([]);
  const [retestEnginesLoading, setRetestEnginesLoading] = useState(false);
  const [retestEnginesError, setRetestEnginesError] = useState<string | null>(null);
  const [retestCheckedEngines, setRetestCheckedEngines] = useState<VisibilityEngineKey[]>([]);

  const contextSeqRef = useRef(0);
  const urlHydratedSeqRef = useRef(0);
  const articleSeqRef = useRef(0);
  const activeArticleIdRef = useRef<string | null>(null);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const urlSyncCtrlRef = useRef<AbortController | null>(null);
  const pubRecordsCtrlRef = useRef<AbortController | null>(null);
  const briefCtrlRef = useRef<AbortController | null>(null);
  const publishCtrlRef = useRef<AbortController | null>(null);
  const retestCtrlRef = useRef<AbortController | null>(null);
  const retestEnginesCtrlRef = useRef<AbortController | null>(null);
  const retestingRecordsRef = useRef<Set<string>>(new Set());
  const prevContextKeyRef = useRef<string | null>(null);
  const filterFetchInitializedRef = useRef(false);
  const lastFilterFetchRef = useRef<{
    contextKey: string;
    publishFilter: GeoArticlePublishFilter;
    keyword: string;
  } | null>(null);
  const articleFiltersRef = useRef<{ publishFilter: GeoArticlePublishFilter; keyword: string }>({
    publishFilter: 'ALL',
    keyword: '',
  });
  const articlesRef = useRef<GeoArticleRecord[]>([]);
  const userChoseTabForArticleRef = useRef<string | null>(null);
  const pendingAutoSwitchArticleIdRef = useRef<string | null>(null);
  const lastNotifiedInvalidArticleIdRef = useRef<string | null>(null);
  const skipNextSelfArticlesRefreshRef = useRef(false);
  const skipNextSelfPublishRecordsRefreshRef = useRef(false);
  const feedbackRef = useRef(feedback);

  feedbackRef.current = feedback;
  articlesRef.current = articles;
  articleFiltersRef.current = { publishFilter, keyword: keywordFilter };

  const supportedLocalesKey = (activeBrandMarket?.supportedLocales ?? []).join(',');

  const availableLocales = useMemo<SupportedLocale[]>(() => {
    if (activeMarket === 'CN') return ['zh-CN'];
    const raw = supportedLocalesKey ? supportedLocalesKey.split(',') : [];
    const validGlobal = raw.filter((code): code is SupportedLocale =>
      (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(code),
    );
    if (validGlobal.length > 0) return [...new Set(validGlobal)];
    return [resolveEffectiveLocale(activeBrandMarket?.locale, 'GLOBAL')];
  }, [activeBrandMarket?.locale, activeMarket, supportedLocalesKey]);

  const defaultTargetLocale = useMemo<SupportedLocale>(() => {
    const preferred = resolveEffectiveLocale(activeBrandMarket?.locale, activeMarket);
    return availableLocales.includes(preferred) ? preferred : (availableLocales[0] ?? 'en-US');
  }, [activeBrandMarket?.locale, activeMarket, availableLocales]);

  const clearArticleActionControllers = useCallback(() => {
    publishCtrlRef.current?.abort();
    publishCtrlRef.current = null;
    retestCtrlRef.current?.abort();
    retestCtrlRef.current = null;
    retestEnginesCtrlRef.current?.abort();
    retestEnginesCtrlRef.current = null;
    briefCtrlRef.current?.abort();
    briefCtrlRef.current = null;
    retestingRecordsRef.current.clear();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const compactMq = window.matchMedia('(min-width: 921px) and (max-width: 1359px)');
    const narrowMq = window.matchMedia('(max-width: 920px)');
    const syncBreakpoints = () => {
      setIsCompactRailViewport(compactMq.matches);
      setIsNarrowDrawerViewport(narrowMq.matches);
      if (!narrowMq.matches) {
        setMobileLeftDrawerOpen(false);
      }
    };
    syncBreakpoints();
    compactMq.addEventListener('change', syncBreakpoints);
    narrowMq.addEventListener('change', syncBreakpoints);
    return () => {
      compactMq.removeEventListener('change', syncBreakpoints);
      narrowMq.removeEventListener('change', syncBreakpoints);
    };
  }, []);

  useEffect(() => {
    if (leftCollapseManualRef.current) return;
    if (isCompactRailViewport && activeArticle !== null) {
      setLeftCollapsed(true);
    } else if (!isCompactRailViewport) {
      setLeftCollapsed(false);
    }
  }, [isCompactRailViewport, activeArticle]);

  const selectArticleInWorkspace = useCallback(
    (
      article: GeoArticleRecord,
      options?: { explicitTab?: PublishTabKey | null; preserveManualTab?: boolean },
    ) => {
      const sameArticle = activeArticleIdRef.current === article.id;
      if (!sameArticle) {
        activeArticleIdRef.current = article.id;
        articleSeqRef.current += 1;
        clearArticleActionControllers();
        setPublishRecords([]);
        setLinkedBrief(null);
        setRetestingRecordId(null);
        setRetestModalRecord(null);
      }

      setActiveArticle(article);
      setMobileLeftDrawerOpen(false);
      replacePublishUrlParam('articleId', article.id);

      const urlTab = readPublishUrlParams().tab;
      const desiredTab = options?.explicitTab ?? (sameArticle ? urlTab : null);
      if (desiredTab) {
        userChoseTabForArticleRef.current = article.id;
        setActiveTab(desiredTab);
        replacePublishUrlParam('tab', desiredTab);
      } else if (!options?.preserveManualTab || userChoseTabForArticleRef.current !== article.id) {
        userChoseTabForArticleRef.current = null;
        const nextDefault = defaultTabForArticle(article);
        setActiveTab(nextDefault);
        replacePublishUrlParam('tab', null);
      }
    },
    [clearArticleActionControllers],
  );

  const loadWorkspaceData = useCallback(
    async (
      brandId: string,
      market: GeoMarket,
      seq: number,
      options?: { preserveSelection?: boolean; productLineId?: string | null },
    ) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;
      setArticlesLoading(true);

      const urlParams = readPublishUrlParams();
      const { publishFilter: curFilter, keyword: curKeyword } = articleFiltersRef.current;
      const productLineId = options?.productLineId ?? null;

      const [articlesRes, factsRes] = await Promise.allSettled([
        fetchArticles(
          brandId,
          market,
          {
            ...(curFilter !== 'ALL' ? { publishFilter: curFilter } : {}),
            ...(curKeyword.trim() ? { keyword: curKeyword.trim() } : {}),
            ...(productLineId ? { productLineId } : {}),
            pageSize: 50,
          },
          { signal: ctrl.signal },
        ),
        getBrandFacts(brandId, {
          signal: ctrl.signal,
          ...(productLineId ? { productLineId } : {}),
        }),
      ]);

      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;

      const loadedArticles = articlesRes.status === 'fulfilled' ? articlesRes.value.items : [];
      setArticles(loadedArticles);
      if (factsRes.status === 'fulfilled') {
        setBrandFacts(factsRes.value.items);
      }
      setArticlesLoading(false);

      const shouldHydrateUrl = !options?.preserveSelection || urlHydratedSeqRef.current !== seq;
      if (!shouldHydrateUrl) return;

      if (urlParams.articleId) {
        const localMatch = loadedArticles.find((a) => a.id === urlParams.articleId);
        if (localMatch) {
          lastNotifiedInvalidArticleIdRef.current = null;
          selectArticleInWorkspace(localMatch, { explicitTab: urlParams.tab });
          urlHydratedSeqRef.current = seq;
          return;
        }

        try {
          const fetched = await getArticle(urlParams.articleId, { signal: ctrl.signal });
          if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
          const productLineMatches =
            !productLineId || (fetched.productLineId ?? null) === productLineId;
          if (fetched.brandId === brandId && fetched.market === market && productLineMatches) {
            lastNotifiedInvalidArticleIdRef.current = null;
            setArticles((prev) =>
              prev.some((a) => a.id === fetched.id) ? prev : [fetched, ...prev],
            );
            selectArticleInWorkspace(fetched, { explicitTab: urlParams.tab });
            urlHydratedSeqRef.current = seq;
            return;
          }

          const curParams = readPublishUrlParams();
          const hasConflictingBrand = Boolean(
            curParams.brandId && curParams.brandId !== fetched.brandId,
          );
          const hasConflictingMarket = Boolean(
            curParams.market && curParams.market !== fetched.market,
          );
          const hasConflictingProductLine = Boolean(
            curParams.productLineId && (fetched.productLineId ?? null) !== curParams.productLineId,
          );
          const needsBrandOrMarketSwitch = fetched.brandId !== brandId || fetched.market !== market;
          const targetBrand = useWorkspaceStore
            .getState()
            .brands.find(
              (b) => b.id === fetched.brandId && b.markets.some((m) => m.market === fetched.market),
            );
          if (
            needsBrandOrMarketSwitch &&
            !hasConflictingBrand &&
            !hasConflictingMarket &&
            !hasConflictingProductLine &&
            targetBrand
          ) {
            pendingAutoSwitchArticleIdRef.current = fetched.id;
            useWorkspaceStore
              .getState()
              .setActiveBrand(fetched.brandId, fetched.market, window.localStorage, {
                preserveItemParams: true,
              });
            return;
          }

          replacePublishUrlParam('articleId', null);
          if (lastNotifiedInvalidArticleIdRef.current !== urlParams.articleId) {
            lastNotifiedInvalidArticleIdRef.current = urlParams.articleId;
            feedbackRef.current.notifyWarning(
              !productLineMatches && fetched.brandId === brandId && fetched.market === market
                ? '该文章不属于当前产品线，已清除链接中的文章参数'
                : '该文章不属于当前品牌或市场，已清除链接中的文章参数',
            );
          }
        } catch {
          if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
          replacePublishUrlParam('articleId', null);
          if (lastNotifiedInvalidArticleIdRef.current !== urlParams.articleId) {
            lastNotifiedInvalidArticleIdRef.current = urlParams.articleId;
            feedbackRef.current.notifyWarning(
              '未找到链接指定的文章（可能已删除或无权访问），已清除失效参数',
            );
          }
        }
      }

      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
      if (!activeArticleIdRef.current && loadedArticles.length > 0) {
        selectArticleInWorkspace(loadedArticles[0]!, { explicitTab: urlParams.tab });
      }
      urlHydratedSeqRef.current = seq;
    },
    [selectArticleInWorkspace],
  );

  // Brand / Market / ProductLine / ContextEpoch Switch Reset + Reload (Anti-Race)
  useEffect(() => {
    loadCtrlRef.current?.abort();
    urlSyncCtrlRef.current?.abort();
    urlSyncCtrlRef.current = null;
    pubRecordsCtrlRef.current?.abort();
    pubRecordsCtrlRef.current = null;
    clearArticleActionControllers();
    activeArticleIdRef.current = null;
    articleSeqRef.current += 1;

    const seq = ++contextSeqRef.current;
    const contextKey = `${activeBrandId ?? ''}::${activeBrandMarketId ?? ''}::${activeMarket}::${activeProductLineId ?? ''}::${state.contextEpoch}`;
    const brandMarketKey =
      activeBrandId && activeBrandMarketId
        ? `${activeBrandId}::${activeBrandMarketId}::${activeMarket}::${activeProductLineId ?? ''}`
        : null;
    const contextChanged =
      prevContextKeyRef.current !== null &&
      brandMarketKey !== null &&
      prevContextKeyRef.current !== brandMarketKey;
    if (brandMarketKey !== null) {
      prevContextKeyRef.current = brandMarketKey;
    }

    if (contextChanged) {
      const curParams = readPublishUrlParams();
      const isPreservedAutoSwitch = Boolean(
        pendingAutoSwitchArticleIdRef.current &&
        curParams.articleId === pendingAutoSwitchArticleIdRef.current,
      );
      if (isPreservedAutoSwitch) {
        pendingAutoSwitchArticleIdRef.current = null;
      }
      const curProductLineId = curParams.productLineId ?? null;
      const urlTargetsNewContext = Boolean(
        curParams.articleId &&
        (!curParams.brandId || curParams.brandId === activeBrandId) &&
        (!curParams.market || curParams.market === activeMarket) &&
        curProductLineId === (activeProductLineId ?? null),
      );
      if (!isPreservedAutoSwitch && !urlTargetsNewContext) {
        replacePublishUrlParam('articleId', null);
        replacePublishUrlParam('tab', null);
      }
    }

    filterFetchInitializedRef.current = true;
    articleFiltersRef.current = { publishFilter: 'ALL', keyword: '' };
    lastFilterFetchRef.current = { contextKey, publishFilter: 'ALL', keyword: '' };
    setPublishFilter('ALL');
    setKeywordFilter('');
    setArticles([]);
    setBrandFacts([]);
    setActiveArticle(null);
    setLinkedBrief(null);
    setActiveTab('distribute');
    setPublishRecords([]);
    setPublishRecordsLoading(false);
    setRetestingRecordId(null);
    setPendingRetest(null);
    setRetestModalRecord(null);
    setRetestEngines([]);
    setRetestCheckedEngines([]);
    setRetestEnginesError(null);
    setMobileLeftDrawerOpen(false);
    userChoseTabForArticleRef.current = null;

    if (!activeBrandId || !activeBrandMarketId) {
      setArticlesLoading(false);
      return;
    }

    void loadWorkspaceData(activeBrandId, activeMarket, seq, {
      productLineId: activeProductLineId,
    });

    return () => {
      loadCtrlRef.current?.abort();
      urlSyncCtrlRef.current?.abort();
      urlSyncCtrlRef.current = null;
      pubRecordsCtrlRef.current?.abort();
      pubRecordsCtrlRef.current = null;
      clearArticleActionControllers();
    };
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    activeProductLineId,
    state.contextEpoch,
    loadWorkspaceData,
    clearArticleActionControllers,
  ]);

  // Refetch articles when queue filter or search keyword changes
  useEffect(() => {
    if (!activeBrandId || !activeBrandMarketId) return;
    if (!filterFetchInitializedRef.current) return;
    const contextKey = `${activeBrandId}::${activeBrandMarketId}::${activeMarket}::${activeProductLineId ?? ''}::${state.contextEpoch}`;
    const prev = lastFilterFetchRef.current;
    if (
      prev &&
      prev.contextKey === contextKey &&
      prev.publishFilter === publishFilter &&
      prev.keyword === keywordFilter
    ) {
      return;
    }
    lastFilterFetchRef.current = {
      contextKey,
      publishFilter,
      keyword: keywordFilter,
    };

    const seq = contextSeqRef.current;
    const ctrl = new AbortController();
    setArticlesLoading(true);
    void fetchArticles(
      activeBrandId,
      activeMarket,
      {
        ...(publishFilter !== 'ALL' ? { publishFilter } : {}),
        ...(keywordFilter.trim() ? { keyword: keywordFilter.trim() } : {}),
        ...(activeProductLineId ? { productLineId: activeProductLineId } : {}),
        pageSize: 50,
      },
      { signal: ctrl.signal },
    )
      .then((res) => {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        setArticles(res.items);
      })
      .catch(() => undefined)
      .finally(() => {
        if (seq === contextSeqRef.current && !ctrl.signal.aborted) {
          setArticlesLoading(false);
        }
      });

    return () => ctrl.abort();
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    activeProductLineId,
    state.contextEpoch,
    publishFilter,
    keywordFilter,
  ]);

  // Reactive URL sync for ?articleId= & ?tab=
  const syncFromCurrentUrl = useCallback(() => {
    if (!activeBrandId || !activeBrandMarketId) return;
    const seq = contextSeqRef.current;
    if (urlHydratedSeqRef.current !== seq) return;

    const urlParams = readPublishUrlParams();
    if (urlParams.articleId && urlParams.articleId === activeArticleIdRef.current) {
      if (urlParams.tab) {
        userChoseTabForArticleRef.current = urlParams.articleId;
        setActiveTab(urlParams.tab);
      }
      return;
    }

    if (!urlParams.articleId) {
      if (urlParams.tab && activeArticleIdRef.current) {
        userChoseTabForArticleRef.current = activeArticleIdRef.current;
        setActiveTab(urlParams.tab);
      }
      return;
    }

    const localArt = articlesRef.current.find((a) => a.id === urlParams.articleId);
    if (localArt) {
      lastNotifiedInvalidArticleIdRef.current = null;
      selectArticleInWorkspace(localArt, { explicitTab: urlParams.tab });
      return;
    }

    urlSyncCtrlRef.current?.abort();
    const ctrl = new AbortController();
    urlSyncCtrlRef.current = ctrl;
    const targetArticleId = urlParams.articleId;

    void getArticle(targetArticleId, { signal: ctrl.signal })
      .then((fetched) => {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        const productLineMatches =
          !activeProductLineId || (fetched.productLineId ?? null) === activeProductLineId;
        if (
          fetched.brandId === activeBrandId &&
          fetched.market === activeMarket &&
          productLineMatches
        ) {
          lastNotifiedInvalidArticleIdRef.current = null;
          setArticles((prev) =>
            prev.some((a) => a.id === fetched.id) ? prev : [fetched, ...prev],
          );
          selectArticleInWorkspace(fetched, { explicitTab: urlParams.tab });
          return;
        }
        replacePublishUrlParam('articleId', null);
      })
      .catch(() => {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        replacePublishUrlParam('articleId', null);
      });
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    activeProductLineId,
    selectArticleInWorkspace,
  ]);

  useEffect(() => {
    if (consoleCtx?.urlSearch === undefined) return;
    syncFromCurrentUrl();
  }, [consoleCtx?.urlSearch, syncFromCurrentUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      syncFromCurrentUrl();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [syncFromCurrentUrl]);

  const reloadPublishRecords = useCallback(async (articleId: string) => {
    pubRecordsCtrlRef.current?.abort();
    const ctrl = new AbortController();
    pubRecordsCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    setPublishRecordsLoading(true);
    try {
      const res = await fetchPublishRecords(articleId, { signal: ctrl.signal });
      if (
        ctrl.signal.aborted ||
        seq !== contextSeqRef.current ||
        artSeq !== articleSeqRef.current
      ) {
        return;
      }
      setPublishRecords(res.items);
      if (
        res.items.length > 0 &&
        userChoseTabForArticleRef.current !== articleId &&
        !readPublishUrlParams().tab
      ) {
        setActiveTab('tracking');
      }
    } catch {
      // Silent fallback on aborted or empty fetch
    } finally {
      if (
        pubRecordsCtrlRef.current === ctrl &&
        !ctrl.signal.aborted &&
        seq === contextSeqRef.current &&
        artSeq === articleSeqRef.current
      ) {
        setPublishRecordsLoading(false);
      }
    }
  }, []);

  const activeArticleId = activeArticle?.id ?? null;
  const activeBriefId = activeArticle?.briefId ?? null;
  const activeArticleMatchesContext = Boolean(
    activeArticle &&
    activeArticle.market === activeMarket &&
    activeArticle.brandId === activeBrandId,
  );

  useEffect(() => {
    pubRecordsCtrlRef.current?.abort();
    pubRecordsCtrlRef.current = null;
    briefCtrlRef.current?.abort();
    briefCtrlRef.current = null;
    setPublishRecords([]);
    setLinkedBrief(null);
    setPendingRetest((prev) => (prev && prev.articleId === activeArticleId ? prev : null));

    if (
      !activeArticleId ||
      !activeBrandId ||
      !activeBrandMarketId ||
      !activeArticleMatchesContext
    ) {
      setPublishRecordsLoading(false);
      return;
    }

    void reloadPublishRecords(activeArticleId);

    if (activeBriefId) {
      const briefCtrl = new AbortController();
      briefCtrlRef.current = briefCtrl;
      const seq = contextSeqRef.current;
      const artSeq = articleSeqRef.current;
      void getBrief(activeBriefId, { signal: briefCtrl.signal })
        .then((brief) => {
          if (
            briefCtrl.signal.aborted ||
            seq !== contextSeqRef.current ||
            artSeq !== articleSeqRef.current
          ) {
            return;
          }
          setLinkedBrief(brief);
        })
        .catch(() => undefined);
    }

    return () => {
      pubRecordsCtrlRef.current?.abort();
      briefCtrlRef.current?.abort();
    };
  }, [
    activeArticleId,
    activeBriefId,
    activeArticleMatchesContext,
    activeBrandId,
    activeBrandMarketId,
    reloadPublishRecords,
  ]);

  const broadcastSelfArticlesFreshness = useCallback((...domains: FreshnessDomain[]) => {
    skipNextSelfArticlesRefreshRef.current = true;
    try {
      invalidateFreshness(...domains);
    } finally {
      skipNextSelfArticlesRefreshRef.current = false;
    }
  }, []);

  const broadcastSelfPublishRecordsFreshness = useCallback((...domains: FreshnessDomain[]) => {
    skipNextSelfPublishRecordsRefreshRef.current = true;
    try {
      invalidateFreshness(...domains);
    } finally {
      skipNextSelfPublishRecordsRefreshRef.current = false;
    }
  }, []);

  useTabFreshness({
    domains: ['articles', 'brand-facts', 'product-lines'],
    active: Boolean(activeBrandId && activeBrandMarket),
    refreshOnActivate: false,
    onRefresh: () => {
      if (skipNextSelfArticlesRefreshRef.current) {
        skipNextSelfArticlesRefreshRef.current = false;
        return;
      }
      if (!activeBrandId || !activeBrandMarket) return;
      void loadWorkspaceData(activeBrandId, activeMarket, contextSeqRef.current, {
        preserveSelection: true,
        productLineId: activeProductLineId,
      });
    },
  });

  useTabFreshness({
    domains: ['publish-records', 'distributions'],
    active: Boolean(activeBrandId && activeBrandMarket),
    refreshOnActivate: false,
    onRefresh: () => {
      if (skipNextSelfPublishRecordsRefreshRef.current) {
        skipNextSelfPublishRecordsRefreshRef.current = false;
        return;
      }
      const openArticleId = activeArticleIdRef.current;
      if (openArticleId) {
        void reloadPublishRecords(openArticleId);
      }
    },
  });

  // Poll pending manual retest run until afterMetrics writeback or terminal status
  useTaskPolling({
    enabled: Boolean(activeBrandId && activeBrandMarket && pendingRetest),
    active: Boolean(pendingRetest),
    intervalMs: 2_500,
    onPoll: async () => {
      if (!activeBrandId || !activeBrandMarket || !pendingRetest) return;
      const seq = contextSeqRef.current;
      const articleSeq = articleSeqRef.current;
      const currentPending = pendingRetest;
      try {
        const res = await fetchPublishRecords(currentPending.articleId);
        if (seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current) return;
        setPublishRecords(res.items);
        const matched = res.items.find((r) => r.id === currentPending.recordId);
        if (matched?.afterMetrics && matched.latestRetestRunId === currentPending.runId) {
          setPendingRetest(null);
          void consoleCtx?.refreshWallet();
          broadcastSelfPublishRecordsFreshness('publish-records', 'visibility-runs', 'points');
          feedback.notifySuccess('复测完成，已生成发布前 / 发布后排名对比');
          return;
        }
        const detail = await fetchVisibilityRunDetail(
          activeBrandId,
          currentPending.runId,
          activeMarket,
        );
        if (seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current) return;
        if (detail.status === 'FAILED' || detail.status === 'CANCELLED') {
          setPendingRetest(null);
          void consoleCtx?.refreshWallet();
          broadcastSelfPublishRecordsFreshness('publish-records', 'visibility-runs', 'points');
          feedback.notifyWarning('本次复测未成功完成，已按规则退还异常引擎点数');
          return;
        }
        if (detail.status === 'COMPLETED' || detail.status === 'PARTIAL') {
          const recheck = await fetchPublishRecords(currentPending.articleId);
          if (seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current) return;
          setPublishRecords(recheck.items);
          const recheckMatched = recheck.items.find((r) => r.id === currentPending.recordId);
          setPendingRetest(null);
          void consoleCtx?.refreshWallet();
          broadcastSelfPublishRecordsFreshness('publish-records', 'visibility-runs', 'points');
          if (
            recheckMatched?.afterMetrics &&
            recheckMatched.latestRetestRunId === currentPending.runId
          ) {
            feedback.notifySuccess('复测完成，已生成发布前 / 发布后排名对比');
          } else if (detail.doneCount === 0) {
            feedback.notifyWarning('复测已结束，本次无引擎返回有效观测结果');
          } else {
            feedback.notifyWarning('复测已结束，暂未生成对比指标');
          }
        }
      } catch {
        // Silent retry on next poll tick
      }
    },
  });

  const handleSelectTab = (next: string) => {
    const parsed = parsePublishTab(next);
    if (!parsed) return;
    userChoseTabForArticleRef.current = activeArticle?.id ?? '__none__';
    setActiveTab(parsed);
    replacePublishUrlParam('tab', parsed);
  };

  const handleChangeStatus = async (status: GeoArticleStatus) => {
    if (!activeArticle || readOnly) return;
    const targetArticle = activeArticle;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    try {
      const updated = await updateArticle(targetArticle.id, { status });
      broadcastSelfArticlesFreshness('articles');
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      setActiveArticle((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      setArticles((prev) =>
        prev.map((a) => (a.id === updated.id ? { ...a, status: updated.status } : a)),
      );
      feedback.notifySuccess('已更新文章状态');
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      feedback.notifyError(formatPublishError(err, '更新文章状态失败'));
    }
  };

  const handleCreatePublishRecord = async (input: PublishRecordCreateInput): Promise<boolean> => {
    if (!activeArticle || readOnly) return false;
    publishCtrlRef.current?.abort();
    const ctrl = new AbortController();
    publishCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    const articleSeq = articleSeqRef.current;
    const targetArticle = activeArticle;
    const isStale = () =>
      ctrl.signal.aborted || seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current;
    try {
      const created = await createPublishRecord(targetArticle.id, input, { signal: ctrl.signal });
      if (isStale()) return false;
      setPublishRecords((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      const nextCount = (targetArticle.publishRecordCount ?? 0) + 1;
      const nextArticle: GeoArticleRecord = {
        ...targetArticle,
        status: 'PUBLISHED',
        publishRecordCount: nextCount,
      };
      setActiveArticle((prev) =>
        prev && prev.id === nextArticle.id
          ? { ...prev, status: 'PUBLISHED', publishRecordCount: nextCount }
          : prev,
      );
      setArticles((prev) =>
        prev.map((a) =>
          a.id === nextArticle.id
            ? { ...a, status: 'PUBLISHED', publishRecordCount: nextCount }
            : a,
        ),
      );
      feedback.notifySuccess('已登记发布链接并标记文章为「已发布」');
      broadcastSelfPublishRecordsFreshness('publish-records');
      broadcastSelfArticlesFreshness('articles');
      return true;
    } catch (err) {
      if (isStale()) return false;
      feedback.notifyError(formatPublishError(err, '登记发布记录失败'));
      return false;
    } finally {
      if (publishCtrlRef.current === ctrl) {
        publishCtrlRef.current = null;
      }
    }
  };

  const handleDistributionPublishRecordsSynced = useCallback(
    async (articleId: string) => {
      if (activeArticleIdRef.current !== articleId) return;
      await reloadPublishRecords(articleId);
      setActiveArticle((prev) =>
        prev && prev.id === articleId ? { ...prev, status: 'PUBLISHED' } : prev,
      );
      setArticles((prev) =>
        prev.map((a) => (a.id === articleId ? { ...a, status: 'PUBLISHED' } : a)),
      );
      broadcastSelfPublishRecordsFreshness('publish-records', 'distributions');
      broadcastSelfArticlesFreshness('articles');
      void consoleCtx?.refreshWallet();
    },
    [
      broadcastSelfArticlesFreshness,
      broadcastSelfPublishRecordsFreshness,
      consoleCtx,
      reloadPublishRecords,
    ],
  );

  const handlePublishRecordUpdated = useCallback((updated: GeoPublishRecordDto) => {
    setPublishRecords((prev) => {
      const next = prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r));
      const nextHasAlert = next.some(
        (rec) => rec.crawlStatus === 'BLOCKED' || rec.crawlStatus === 'FAILED',
      );
      setActiveArticle((cur) =>
        cur && cur.id === updated.articleId
          ? { ...cur, hasCrawlAlert: nextHasAlert, publishRecordCount: next.length }
          : cur,
      );
      setArticles((list) =>
        list.map((a) =>
          a.id === updated.articleId
            ? { ...a, hasCrawlAlert: nextHasAlert, publishRecordCount: next.length }
            : a,
        ),
      );
      return next;
    });
    skipNextSelfPublishRecordsRefreshRef.current = true;
    queueMicrotask(() => {
      skipNextSelfPublishRecordsRefreshRef.current = false;
    });
  }, []);

  const loadRetestEngines = useCallback(async (brandId: string, market: GeoMarket) => {
    retestEnginesCtrlRef.current?.abort();
    const ctrl = new AbortController();
    retestEnginesCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setRetestEnginesLoading(true);
    setRetestEnginesError(null);
    try {
      const res = await fetchVisibilityEngines(brandId, market, { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      const scoped = filterEnginesForMarket(res.engines, market);
      setRetestEngines(scoped);
      setRetestCheckedEngines(scoped.filter((eng) => eng.available).map((eng) => eng.key));
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setRetestEnginesError(formatPublishError(err, '加载 AI 引擎列表失败'));
    } finally {
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setRetestEnginesLoading(false);
      }
    }
  }, []);

  const handleOpenRetestModal = async (record: GeoPublishRecordDto) => {
    if (
      !activeArticle ||
      !activeBrandId ||
      readOnly ||
      retestingRecordsRef.current.size > 0 ||
      retestingRecordsRef.current.has(record.id)
    ) {
      return;
    }
    setRetestModalRecord(record);
    await loadRetestEngines(activeBrandId, activeMarket);
  };

  const handleTriggerRetest = async (
    record: GeoPublishRecordDto,
    engines?: readonly VisibilityEngineKey[],
  ) => {
    if (
      !activeArticle ||
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
    const articleSeq = articleSeqRef.current;
    const isStale = () =>
      ctrl.signal.aborted || seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current;
    try {
      const payload = engines && engines.length > 0 ? { engines: [...engines] } : undefined;
      const run = await triggerPublishRetest(record.id, payload, undefined, {
        signal: ctrl.signal,
      });
      if (isStale()) return;
      setPublishRecords((prev) =>
        prev.map((r) =>
          r.id === record.id ? { ...r, latestRetestRunId: run.id, afterMetrics: null } : r,
        ),
      );
      setPendingRetest({ recordId: record.id, runId: run.id, articleId: record.articleId });
      void consoleCtx?.refreshWallet();
      invalidateFreshness('visibility-runs', 'points');
      feedback.notifySuccess('已发起定向复测，完成后将自动展示发布前 / 发布后对比');
    } catch (err) {
      if (isStale()) return;
      feedback.notifyError(formatPublishError(err, '发起排名复测失败'));
      void consoleCtx?.refreshWallet();
    } finally {
      if (retestCtrlRef.current === ctrl) {
        retestCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current && articleSeq === articleSeqRef.current) {
        retestingRecordsRef.current.delete(record.id);
        setRetestingRecordId(null);
      }
    }
  };

  const handleReturnToEditorForFix = useCallback(
    (code?: PreflightItemCode, locateTerm?: string) => {
      if (!activeArticle) return;
      const qs = new URLSearchParams({ articleId: activeArticle.id });
      if (code) qs.set('fixCode', code);
      if (locateTerm?.trim()) qs.set('locateTerm', locateTerm.trim().slice(0, 64));
      consoleCtx?.navigateWorkspace(`/studio?${qs.toString()}`);
    },
    [activeArticle, consoleCtx],
  );

  const brandNames = useMemo(() => {
    const names = [
      activeBrand?.name,
      activeBrandMarket?.localBrandName,
      ...(activeBrandMarket?.aliases ?? []),
    ].filter((v): v is string => Boolean(v && v.trim()));
    return [...new Set(names)];
  }, [activeBrand?.name, activeBrandMarket?.aliases, activeBrandMarket?.localBrandName]);

  const crawlAlertCount = useMemo(() => articles.filter((a) => a.hasCrawlAlert).length, [articles]);

  const scopedPublishRecords =
    activeArticleMatchesContext && activeArticle
      ? publishRecords.filter((rec) => rec.articleId === activeArticle.id)
      : [];
  const hasCrawlAlert =
    scopedPublishRecords.some(
      (rec) => rec.crawlStatus === 'BLOCKED' || rec.crawlStatus === 'FAILED',
    ) || Boolean(activeArticle?.hasCrawlAlert);

  const onlineRetestEngineKeys = retestEngines.filter((eng) => eng.available).map((eng) => eng.key);
  const validRetestCheckedEngines = retestCheckedEngines.filter((key) =>
    onlineRetestEngineKeys.includes(key),
  );
  const retestEstimatedPoints = validRetestCheckedEngines.length * VISIBILITY_DEFAULT_UNIT_POINTS;

  if (state.brandsLoading) {
    return (
      <section
        className="gm-publish-page"
        aria-label="发布中心"
        aria-busy="true"
        data-testid="publish-loading"
      >
        <div className="gm-publish-grid">
          <div className="gm-studio-pane">
            <div className="gm-studio-pane-body">
              <Skeleton active paragraph={{ rows: 5 }} />
            </div>
          </div>
          <div className="gm-publish-main">
            <div className="gm-studio-pane-body">
              <SignalSkeleton variant="block" height={340} />
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (state.brandsError) {
    return (
      <section className="gm-studio-page gm-studio-page--empty" aria-label="发布中心">
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

  if (!activeBrand || !activeBrandMarket) {
    return (
      <section className="gm-studio-page gm-studio-page--empty" aria-label="发布中心">
        <div className="gm-panel">
          <SignalEmpty
            title="尚未创建品牌资产"
            description="先用 60 秒完成品牌与事实卡建档，并在 GEO 写作台完成创作后，即可在这里多渠道分发与追踪复测。"
            actionText={readOnly ? undefined : '立即创建首个品牌'}
            onAction={readOnly ? undefined : () => consoleCtx?.openCreateBrandModal()}
          />
        </div>
      </section>
    );
  }

  const matchedFactCount =
    (linkedBrief?.matchedFactIds?.length ?? 0) > 0
      ? linkedBrief!.matchedFactIds!.length
      : brandFacts.length;

  const renderQueue = (inDrawer: boolean) => (
    <PublishArticleQueue
      collapsed={inDrawer ? false : leftCollapsed}
      hideCollapseToggle={inDrawer}
      onToggleCollapse={() => {
        leftCollapseManualRef.current = true;
        setLeftCollapsed((v) => !v);
      }}
      articles={articles}
      articlesLoading={articlesLoading}
      activeArticleId={activeArticle?.id ?? null}
      publishFilter={publishFilter}
      onPublishFilterChange={setPublishFilter}
      keyword={keywordFilter}
      onKeywordChange={setKeywordFilter}
      crawlAlertCount={crawlAlertCount}
      onSelectArticle={(article) => selectArticleInWorkspace(article)}
      onNavigateStudio={() => consoleCtx?.navigateWorkspace('/studio')}
    />
  );

  const gridClassName = [
    'gm-publish-grid',
    isNarrowDrawerViewport
      ? 'gm-publish-grid--narrow'
      : leftCollapsed
        ? 'gm-publish-grid--left-collapsed'
        : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="gm-publish-page" aria-label="发布中心" data-testid="publish-workspace">
      <ProductLineSelectorPill compact className="gm-studio-pl-bar" />

      <div className={gridClassName}>
        {!isNarrowDrawerViewport ? renderQueue(false) : null}

        <main className="gm-publish-main" data-testid="publish-main-pane">
          {isNarrowDrawerViewport ? (
            <div className="gm-publish-mobile-bar">
              <Button size="small" onClick={() => setMobileLeftDrawerOpen(true)}>
                成稿发布队列 ({articles.length})
              </Button>
            </div>
          ) : null}

          {articlesLoading && !activeArticle ? (
            <div className="gm-publish-empty-wrap">
              <SignalSkeleton variant="block" height={280} />
            </div>
          ) : !activeArticle ? (
            <div className="gm-publish-empty-wrap">
              <SignalEmpty
                title="请选择一篇成稿开始发布"
                description="在左侧成稿队列选择已有文章，或前往 GEO 写作台撰写新文章后再回到发布中心。"
                actionText="前往 GEO 写作台"
                onAction={() => consoleCtx?.navigateWorkspace('/studio')}
              />
            </div>
          ) : (
            <>
              <div className="gm-publish-header" data-testid="publish-article-header">
                <div className="gm-publish-header-main">
                  <h2 className="gm-publish-title gm-clamp-1" title={activeArticle.title}>
                    {activeArticle.title}
                  </h2>
                  <div className="gm-publish-header-meta">
                    <StatusBadge tone="active">
                      {activeMarket === 'CN' ? '🇨🇳' : '🌐'} {GEO_MARKET_LABELS[activeMarket]}
                      {activeArticle.targetLocale ? ` · ${activeArticle.targetLocale}` : ''}
                    </StatusBadge>
                    <StatusBadge
                      tone={
                        activeArticle.geoScore >= 85
                          ? 'success'
                          : activeArticle.geoScore >= 60
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      GEO {activeArticle.geoScore} 分
                    </StatusBadge>
                    <select
                      aria-label="成稿状态"
                      className="gm-select gm-publish-status-select"
                      value={activeArticle.status}
                      disabled={readOnly}
                      onChange={(e) => void handleChangeStatus(e.target.value as GeoArticleStatus)}
                    >
                      {GEO_ARTICLE_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {GEO_ARTICLE_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="gm-publish-header-actions">
                  <Button
                    size="small"
                    data-testid="publish-back-to-studio-btn"
                    onClick={() =>
                      consoleCtx?.navigateWorkspace(
                        `/studio?articleId=${encodeURIComponent(activeArticle.id)}`,
                      )
                    }
                  >
                    返回写作台编辑
                  </Button>
                </div>
              </div>

              <div className="gm-publish-tabs-wrap">
                <Tabs
                  className="gm-vis-tabs gm-publish-tabs"
                  activeKey={activeTab}
                  onChange={handleSelectTab}
                  destroyOnHidden={false}
                  items={[
                    {
                      key: 'distribute',
                      label: <span data-testid="publish-tab-distribute">多渠道分发</span>,
                      children: (
                        <DistributionWorkbench
                          open={activeArticleMatchesContext}
                          brandId={activeBrand.id}
                          brandMarketId={activeBrandMarket.id}
                          market={activeMarket}
                          contextEpoch={state.contextEpoch}
                          article={activeArticle}
                          draftTitle={activeArticle.title}
                          draftMarkdown={activeArticle.contentMarkdown}
                          brandNames={brandNames}
                          matchedFactCount={matchedFactCount}
                          linkedBrief={linkedBrief}
                          supportedLocales={availableLocales}
                          defaultTargetLocale={activeArticle.targetLocale ?? defaultTargetLocale}
                          readOnly={readOnly}
                          walletAvailable={consoleCtx?.wallet?.available ?? null}
                          onReturnToEditor={handleReturnToEditorForFix}
                          onNavigateBrands={() => consoleCtx?.navigateWorkspace('/brands')}
                          onNavigateExtensionPairing={() =>
                            consoleCtx?.navigateWorkspace('/account?tab=extension')
                          }
                          onNavigateAccount={() =>
                            consoleCtx?.navigateWorkspace('/account?tab=extension')
                          }
                          onRefreshWallet={() => consoleCtx?.refreshWallet()}
                          onPublishRecordsSynced={handleDistributionPublishRecordsSynced}
                          onCreatePublishRecord={handleCreatePublishRecord}
                        />
                      ),
                    },
                    {
                      key: 'tracking',
                      label: (
                        <span className="gm-publish-tab-label" data-testid="publish-tab-tracking">
                          <span>
                            {scopedPublishRecords.length > 0
                              ? `发布追踪与复测 (${scopedPublishRecords.length})`
                              : '发布追踪与复测'}
                          </span>
                          {hasCrawlAlert ? (
                            <span
                              className="gm-studio-tab-alert-dot"
                              aria-label="存在抓取异常"
                              data-testid="publish-tracking-crawl-alert-dot"
                            />
                          ) : null}
                        </span>
                      ),
                      children: (
                        <StudioPublishRetest
                          activeMarket={activeMarket}
                          article={activeArticleMatchesContext ? activeArticle : null}
                          publishRecords={scopedPublishRecords}
                          recordsLoading={publishRecordsLoading}
                          retestingRecordId={retestingRecordId}
                          pollingRetestRecordId={pendingRetest?.recordId ?? null}
                          readOnly={readOnly}
                          onCreatePublishRecord={handleCreatePublishRecord}
                          onTriggerRetest={handleOpenRetestModal}
                          onPublishRecordUpdated={handlePublishRecordUpdated}
                        />
                      ),
                    },
                    {
                      key: 'delivery',
                      label: <span data-testid="publish-tab-delivery">手动交付包</span>,
                      children: (
                        <StudioDeliveryPack
                          activeMarket={activeMarket}
                          localBrandName={activeBrandMarket.localBrandName}
                          category={activeBrand.category}
                          localCategory={activeBrandMarket.localCategory}
                          ownedDomains={activeBrandMarket.ownedDomains}
                          brandNames={brandNames}
                          matchedFactCount={matchedFactCount}
                          readOnly={readOnly}
                          article={activeArticle}
                          evaluation={null}
                          linkedBriefChannels={linkedBrief?.recommendedChannels}
                          streaming={false}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            </>
          )}
        </main>
      </div>

      {isNarrowDrawerViewport ? (
        <Drawer
          placement="left"
          open={mobileLeftDrawerOpen}
          onClose={() => setMobileLeftDrawerOpen(false)}
          keyboard
          destroyOnHidden
          width={320}
          title="成稿发布队列"
          classNames={{ body: 'gm-studio-drawer-body' }}
        >
          {renderQueue(true)}
        </Drawer>
      ) : null}

      <Modal
        open={Boolean(retestModalRecord)}
        title={`确认定向复测 · 选择 AI 引擎（${GEO_MARKET_LABELS[activeMarket]}）`}
        width={560}
        destroyOnHidden
        onCancel={() => {
          retestEnginesCtrlRef.current?.abort();
          setRetestModalRecord(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                retestEnginesCtrlRef.current?.abort();
                setRetestModalRecord(null);
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              data-testid="publish-retest-confirm-btn"
              disabled={
                readOnly ||
                retestEnginesLoading ||
                validRetestCheckedEngines.length === 0 ||
                !retestModalRecord
              }
              onClick={() => {
                if (!retestModalRecord || validRetestCheckedEngines.length === 0) return;
                const targetRecord = retestModalRecord;
                const chosenEngines = [...validRetestCheckedEngines];
                setRetestModalRecord(null);
                void handleTriggerRetest(targetRecord, chosenEngines);
              }}
            >
              确认发起复测（{retestEstimatedPoints} 点）
            </Button>
          </Space>
        }
      >
        <div data-testid="publish-retest-modal" className="gm-studio-stack gm-studio-stack--lg">
          <div className="gm-studio-text-secondary">
            默认仅勾选当前市场已上线健康引擎，避免盲扣未上线引擎点数；异常项自动全额退还。
          </div>

          <div className="gm-vis-label-row">
            <span className="gm-vis-field-label">
              已选 <span className="gm-num">{validRetestCheckedEngines.length}</span> / 在线{' '}
              <span className="gm-num">{onlineRetestEngineKeys.length}</span> / 共{' '}
              <span className="gm-num">{retestEngines.length}</span>
            </span>
            <Space size={8}>
              <Button
                size="small"
                type="link"
                disabled={retestEnginesLoading || onlineRetestEngineKeys.length === 0}
                onClick={() => setRetestCheckedEngines([...onlineRetestEngineKeys])}
              >
                全选在线引擎
              </Button>
              <Button
                size="small"
                type="link"
                disabled={retestEnginesLoading || validRetestCheckedEngines.length === 0}
                onClick={() => setRetestCheckedEngines([])}
              >
                清空
              </Button>
            </Space>
          </div>

          {retestEnginesError ? (
            <Alert
              type="error"
              showIcon
              message={retestEnginesError}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    if (activeBrandId) {
                      void loadRetestEngines(activeBrandId, activeMarket);
                    }
                  }}
                >
                  重试
                </Button>
              }
            />
          ) : retestEnginesLoading && retestEngines.length === 0 ? (
            <SignalSkeleton variant="block" height={92} />
          ) : (
            <div className="gm-vis-engine-grid">
              {retestEngines.map((eng) => {
                const isChecked = eng.available && validRetestCheckedEngines.includes(eng.key);
                const cardClass = [
                  'gm-engine-card',
                  isChecked ? 'gm-engine-card-checked' : '',
                  !eng.available ? 'gm-engine-card-offline' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const card = (
                  <label
                    key={eng.key}
                    data-testid={`retest-engine-option-${eng.key}`}
                    data-engine-status={eng.available ? 'online' : 'offline'}
                    className={cardClass}
                  >
                    <Checkbox
                      checked={isChecked}
                      disabled={!eng.available || readOnly}
                      onChange={() => {
                        if (!eng.available) return;
                        setRetestCheckedEngines((prev) =>
                          prev.includes(eng.key)
                            ? prev.filter((k) => k !== eng.key)
                            : [...prev, eng.key],
                        );
                      }}
                    />
                    <span className="gm-vis-engine-label">{eng.label}</span>
                    {!eng.available ? <span className="gm-vis-offline-badge">暂未上线</span> : null}
                  </label>
                );
                return !eng.available ? (
                  <Tooltip key={eng.key} title="该引擎暂未上线，不可勾选且不消耗点数">
                    {card}
                  </Tooltip>
                ) : (
                  card
                );
              })}
            </div>
          )}

          <div className="gm-studio-text-secondary">
            预计预冻 <strong className="gm-num">{retestEstimatedPoints}</strong> 点（
            <span className="gm-num">{validRetestCheckedEngines.length}</span> 引擎 ×{' '}
            <span className="gm-num">{VISIBILITY_DEFAULT_UNIT_POINTS}</span> 点/次）
          </div>
        </div>
      </Modal>
    </section>
  );
}
