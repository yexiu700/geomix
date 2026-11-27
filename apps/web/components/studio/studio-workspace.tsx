'use client';

import {
  BRAND_FACT_CARD_MAX,
  BRAND_FACT_SLOT_LABELS,
  GEO_MARKET_LABELS,
  GEO_WRITE_DEFAULT_UNIT_POINTS,
  GLOBAL_SUPPORTED_LOCALES,
  defaultTargetFormatForMarket,
  resolveEffectiveLocale,
  targetFormatsForMarket,
  type BrandFactRecord,
  type BrandFactSlot,
  type BrandFactsResponse,
  type BrandMediaAssetRecord,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefRecord,
  type GeoEvaluationResult,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoRewriteAction,
  type GeoTargetFormat,
  type MissingFactSlot,
  type PreflightItemCode,
  type PromptPreferenceRecord,
  type SupportedLocale,
} from '@geomix/shared';
import { Button, Drawer, Skeleton } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts, listBrandMedia, saveBrandFacts } from '../../lib/brands';
import { fetchBriefs, getBrief } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import {
  buildMarkdownImageToken,
  copyTextToClipboard,
  createBatchJob,
  createStudioIdempotencyKey,
  deleteArticle,
  evaluateArticleGeo,
  fetchArticles,
  fetchBatchJobs,
  getArticle,
  getBatchJob,
  getPromptPreferences,
  insertMarkdownAtCursor,
  mergeFactFeedbackContent,
  replaceMissingFactSlot,
  rewriteArticleSection,
  savePromptPreferences,
  streamGenerateArticle,
  updateArticle,
} from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import {
  selectActiveBrand,
  selectActiveBrandMarket,
  selectActiveProductLine,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { ProductLineSelectorPill } from '../brands/product-line-selector-pill';
import { QuickFactExtractModal } from '../brands/quick-fact-extract-modal';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { EmptyState } from '../ui';
import { StudioBatchTbdDrawer, type BatchTbdSubmitEntry } from './studio-batch-tbd-drawer';
import { batchReplaceMissingFactSlots, groupMissingFactSlots } from './studio-batch-tbd-helpers';
import { StudioEditorCanvas, type PartialStreamDraft } from './studio-editor-canvas';
import { StudioGeoEvaluator } from './studio-geo-evaluator';
import { StudioLeftPane } from './studio-left-pane';
import { StudioMediaPopover } from './studio-media-popover';
import { StudioPrewriteBar } from './studio-prewrite-bar';
import { StudioRightPane } from './studio-right-pane';

export type StudioWorkspaceExtensionSlots = {
  mediaToolbarSlot?: ReactNode;
  evaluatorSlot?: ReactNode;
};

const EMPTY_PREF: PromptPreferenceRecord = {
  customToneNote: null,
  customForbiddenWords: [],
  recipeOverrides: null,
  updatedAt: null,
};

function readStudioUrlParams(): {
  brandId: string | null;
  market: string | null;
  productLineId: string | null;
  briefId: string | null;
  articleId: string | null;
  batchJobId: string | null;
  fixCode: string | null;
  locateTerm: string | null;
} {
  if (typeof window === 'undefined') {
    return {
      brandId: null,
      market: null,
      productLineId: null,
      briefId: null,
      articleId: null,
      batchJobId: null,
      fixCode: null,
      locateTerm: null,
    };
  }
  const sp = new URLSearchParams(window.location.search);
  const rawMarket = sp.get('market')?.trim().toUpperCase() || null;
  return {
    brandId: sp.get('brandId')?.trim() || null,
    market: rawMarket === 'CN' || rawMarket === 'GLOBAL' ? rawMarket : null,
    productLineId: sp.get('productLineId')?.trim() || null,
    briefId: sp.get('briefId')?.trim() || null,
    articleId: sp.get('articleId')?.trim() || null,
    batchJobId: sp.get('batchJobId')?.trim() || null,
    fixCode: sp.get('fixCode')?.trim() || null,
    locateTerm: sp.get('locateTerm')?.trim() || null,
  };
}

function replaceStudioUrlParam(
  key: 'briefId' | 'articleId' | 'batchJobId' | 'fixCode' | 'locateTerm',
  value: string | null,
): void {
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

function formatStudioError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

function hasValidBrandFacts(items: readonly BrandFactRecord[]): boolean {
  return items.some((fact) => fact.content.trim().length > 0);
}

export function StudioWorkspace(slots?: StudioWorkspaceExtensionSlots): JSX.Element {
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeProductLine = selectActiveProductLine(state);
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
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [prewriteExpanded, setPrewriteExpanded] = useState<boolean>(false);
  const [focusMode, setFocusMode] = useState<boolean>(false);
  const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = useState<boolean>(false);
  const [mobileRightDrawerOpen, setMobileRightDrawerOpen] = useState<boolean>(false);
  const leftCollapseManualRef = useRef(false);

  // Queue & History Data
  const [briefs, setBriefs] = useState<GeoBriefRecord[]>([]);
  const [briefsLoading, setBriefsLoading] = useState(false);
  const [selectedBriefIds, setSelectedBriefIds] = useState<string[]>([]);
  const [articles, setArticles] = useState<GeoArticleRecord[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [articleStatusFilter, setArticleStatusFilter] = useState<GeoArticleStatus | ''>('');
  const [articleTagFilter, setArticleTagFilter] = useState('');
  const [batchJobs, setBatchJobs] = useState<GeoBatchJobRecord[]>([]);
  const [highlightedBatchJobId, setHighlightedBatchJobId] = useState<string | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [brandFacts, setBrandFacts] = useState<BrandFactRecord[]>([]);
  const [brandMedia, setBrandMedia] = useState<BrandMediaAssetRecord[]>([]);
  const [brandMediaLoading, setBrandMediaLoading] = useState(false);
  const [quickExtractModalOpen, setQuickExtractModalOpen] = useState(false);
  const [batchTbdDrawerOpen, setBatchTbdDrawerOpen] = useState(false);
  const [promptPreference, setPromptPreference] = useState<PromptPreferenceRecord>(EMPTY_PREF);
  const [prefsSaving, setPrefsSaving] = useState(false);

  const brandFactsRef = useRef<BrandFactRecord[]>([]);
  const brandFactsLoadedRef = useRef(false);
  const brandFactsPromiseRef = useRef<{
    seq: number;
    promise: Promise<BrandFactRecord[] | null>;
  } | null>(null);
  const checkingFactsRef = useRef(false);
  const streamingRef = useRef(false);
  const skipNextSelfWorkspaceRefreshRef = useRef(false);

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

  const availableLocalesRef = useRef(availableLocales);
  availableLocalesRef.current = availableLocales;
  const defaultTargetLocaleRef = useRef(defaultTargetLocale);
  defaultTargetLocaleRef.current = defaultTargetLocale;

  const showLocaleSelector = activeMarket === 'GLOBAL' && availableLocales.length > 1;

  // Pre-Write Form State
  const [linkedBrief, setLinkedBrief] = useState<GeoBriefRecord | null>(null);
  const [targetPrompt, setTargetPrompt] = useState('');
  const [outlineH2, setOutlineH2] = useState<GeoOutlineHeading[]>([]);
  const [targetFanOuts, setTargetFanOuts] = useState<string[]>([]);
  const [recipe, setRecipe] = useState<GeoRecipe>('AUTHORITY_GUIDE');
  const [targetFormat, setTargetFormat] = useState<GeoTargetFormat>(() =>
    defaultTargetFormatForMarket(activeMarket),
  );
  const [targetLocale, setTargetLocale] = useState<SupportedLocale>(() => defaultTargetLocale);

  useEffect(() => {
    setTargetLocale((prev) => (availableLocales.includes(prev) ? prev : defaultTargetLocale));
  }, [availableLocales, defaultTargetLocale]);

  // Active Article & Streaming State
  const [activeArticle, setActiveArticle] = useState<GeoArticleRecord | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [savingArticle, setSavingArticle] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamMarkdown, setStreamMarkdown] = useState('');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [partialDraft, setPartialDraft] = useState<PartialStreamDraft | null>(null);
  const [matchedFactIds, setMatchedFactIds] = useState<string[]>([]);

  // M5 Evaluator & Cross-Page Publish Handoff State
  const [evaluation, setEvaluation] = useState<GeoEvaluationResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [supplementingTerm, setSupplementingTerm] = useState<string | null>(null);
  const [navigatingPublish, setNavigatingPublish] = useState(false);

  // Anti-race AbortControllers & monotonic context/article sequences
  const centerPaneRef = useRef<HTMLElement | null>(null);
  const returnFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFixLocatorRef = useRef<{
    articleId: string;
    code?: PreflightItemCode;
    locateTerm?: string;
  } | null>(null);
  const contextSeqRef = useRef(0);
  const urlHydratedSeqRef = useRef(0);
  const articleSeqRef = useRef(0);
  const activeArticleIdRef = useRef<string | null>(null);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const streamCtrlRef = useRef<AbortController | null>(null);
  const mediaRefreshCtrlRef = useRef<AbortController | null>(null);
  const evalCtrlRef = useRef<AbortController | null>(null);
  const supplementCtrlRef = useRef<AbortController | null>(null);
  const evaluatingRef = useRef(false);
  const supplementingTermRef = useRef<string | null>(null);
  const insertingMediaRef = useRef(false);
  const hadActiveBatchRef = useRef(false);
  const editorCursorRef = useRef<number | null>(null);
  const pendingUsedMediaIdsRef = useRef<string[]>([]);
  const lastLoadedBrandIdRef = useRef<string | null>(null);
  const articleFiltersRef = useRef<{ status: GeoArticleStatus | ''; tag: string }>({
    status: '',
    tag: '',
  });
  const lastFilterFetchRef = useRef<{
    contextKey: string;
    status: GeoArticleStatus | '';
    tag: string;
  } | null>(null);
  const prevContextKeyRef = useRef<string | null>(null);
  const abortWalletTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFilterResetRef = useRef(false);
  const articlesRef = useRef<GeoArticleRecord[]>([]);
  const urlSyncCtrlRef = useRef<AbortController | null>(null);
  const pendingAutoSwitchArticleIdRef = useRef<string | null>(null);
  const lastNotifiedInvalidArticleIdRef = useRef<string | null>(null);
  const feedbackRef = useRef(feedback);

  feedbackRef.current = feedback;
  articlesRef.current = articles;
  articleFiltersRef.current = { status: articleStatusFilter, tag: articleTagFilter };

  const applyBriefToPrewrite = useCallback(
    (brief: GeoBriefRecord) => {
      setLinkedBrief(brief);
      setTargetPrompt(brief.targetPrompt);
      setRecipe(brief.recommendedRecipe);
      const validFormats = targetFormatsForMarket(activeMarket);
      setTargetFormat(
        validFormats.includes(brief.targetFormat)
          ? brief.targetFormat
          : defaultTargetFormatForMarket(activeMarket),
      );
      setOutlineH2(brief.outlineH2 ?? []);
      setTargetFanOuts(brief.targetFanOuts ?? []);
      setMatchedFactIds(brief.matchedFactIds ?? []);
      setPrewriteExpanded(true);
      setMobileLeftDrawerOpen(false);
      replaceStudioUrlParam('briefId', brief.id);
    },
    [activeMarket],
  );

  const clearArticleActionControllers = useCallback(() => {
    evalCtrlRef.current?.abort();
    evalCtrlRef.current = null;
    supplementCtrlRef.current?.abort();
    supplementCtrlRef.current = null;
    evaluatingRef.current = false;
    supplementingTermRef.current = null;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const compactMq = window.matchMedia('(min-width: 921px) and (max-width: 1359px)');
    const narrowMq = window.matchMedia('(max-width: 920px)');
    const syncBreakpoints = () => {
      setIsCompactRailViewport(compactMq.matches);
      setIsNarrowDrawerViewport(narrowMq.matches);
      if (narrowMq.matches) {
        setFocusMode(false);
      } else {
        setMobileLeftDrawerOpen(false);
        setMobileRightDrawerOpen(false);
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

  const resetActiveArticleContext = useCallback(
    (nextArticleId: string | null) => {
      if (activeArticleIdRef.current === nextArticleId) return;
      activeArticleIdRef.current = nextArticleId;
      articleSeqRef.current += 1;
      clearArticleActionControllers();
      insertingMediaRef.current = false;
      pendingUsedMediaIdsRef.current = [];
      setSavingArticle(false);
      setNavigatingPublish(false);
      setEvaluating(false);
      setEvaluation(null);
      setSupplementingTerm(null);
      setBatchTbdDrawerOpen(false);
      if (nextArticleId !== null) {
        setPrewriteExpanded(false);
      }
    },
    [clearArticleActionControllers],
  );

  const applyArticleToCanvas = useCallback(
    (article: GeoArticleRecord) => {
      resetActiveArticleContext(article.id);
      setActiveArticle(article);
      setDraftTitle(article.title);
      setDraftMarkdown(article.contentMarkdown);
      if (article.targetLocale && availableLocalesRef.current.includes(article.targetLocale)) {
        setTargetLocale(article.targetLocale);
      }
      setStreamError(null);
      setPartialDraft(null);
      setMobileLeftDrawerOpen(false);
      replaceStudioUrlParam('articleId', article.id);
    },
    [resetActiveArticleContext],
  );

  const loadWorkspaceData = useCallback(
    async (
      brandId: string,
      market: typeof activeMarket,
      seq: number,
      options?: { preserveSelection?: boolean; productLineId?: string | null },
    ) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;

      setBriefsLoading(true);
      setArticlesLoading(true);
      setBrandMediaLoading(true);

      const urlParams = readStudioUrlParams();
      const { status: currentStatus, tag: currentTag } = articleFiltersRef.current;
      const productLineId = options?.productLineId ?? null;

      const factsReq = getBrandFacts(brandId, {
        signal: ctrl.signal,
        ...(productLineId ? { productLineId } : {}),
      });
      brandFactsPromiseRef.current = {
        seq,
        promise: factsReq.then((res) => res.items).catch(() => null),
      };

      const [briefsRes, articlesRes, batchRes, factsRes, prefRes, mediaRes] =
        await Promise.allSettled([
          fetchBriefs(
            brandId,
            market,
            { status: 'OPEN', pageSize: 50, ...(productLineId ? { productLineId } : {}) },
            { signal: ctrl.signal },
          ),
          fetchArticles(
            brandId,
            market,
            {
              status: currentStatus || undefined,
              tag: currentTag.trim() || undefined,
              ...(productLineId ? { productLineId } : {}),
              pageSize: 50,
            },
            { signal: ctrl.signal },
          ),
          fetchBatchJobs(brandId, market, { signal: ctrl.signal }),
          factsReq,
          getPromptPreferences({ signal: ctrl.signal }),
          listBrandMedia(brandId, { signal: ctrl.signal }),
        ]);

      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;

      const loadedBriefs = briefsRes.status === 'fulfilled' ? briefsRes.value.items : [];
      const loadedArticles = articlesRes.status === 'fulfilled' ? articlesRes.value.items : [];
      const loadedBatches = batchRes.status === 'fulfilled' ? batchRes.value.items : [];

      setBriefs(loadedBriefs);
      setArticles(loadedArticles);
      setBatchJobs(loadedBatches);
      if (factsRes.status === 'fulfilled') {
        setBrandFacts(factsRes.value.items);
        brandFactsRef.current = factsRes.value.items;
        brandFactsLoadedRef.current = true;
      } else {
        brandFactsLoadedRef.current = false;
        if (brandFactsPromiseRef.current?.seq === seq) {
          brandFactsPromiseRef.current = null;
        }
      }
      if (prefRes.status === 'fulfilled') {
        setPromptPreference(prefRes.value);
      }
      if (mediaRes.status === 'fulfilled') {
        setBrandMedia(mediaRes.value.items);
      }
      setBriefsLoading(false);
      setArticlesLoading(false);
      setBrandMediaLoading(false);

      const shouldHydrateUrl = !options?.preserveSelection || urlHydratedSeqRef.current !== seq;
      if (!shouldHydrateUrl) return;

      const hydrationTasks: Promise<void>[] = [];

      // Hydrate ?batchJobId=
      if (urlParams.batchJobId) {
        setHighlightedBatchJobId(urlParams.batchJobId);
        if (!loadedBatches.some((j) => j.id === urlParams.batchJobId)) {
          hydrationTasks.push(
            getBatchJob(brandId, urlParams.batchJobId, { signal: ctrl.signal })
              .then((job) => {
                if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
                if (job.market === market) {
                  setBatchJobs((prev) =>
                    prev.some((p) => p.id === job.id) ? prev : [job, ...prev],
                  );
                }
              })
              .catch(() => undefined),
          );
        }
      }

      // Hydrate ?briefId=
      if (urlParams.briefId) {
        const localMatch = loadedBriefs.find((b) => b.id === urlParams.briefId);
        if (localMatch) {
          applyBriefToPrewrite(localMatch);
        } else {
          hydrationTasks.push(
            getBrief(urlParams.briefId, { signal: ctrl.signal })
              .then((fetched) => {
                if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
                if (
                  fetched.brandId === brandId &&
                  fetched.market === market &&
                  (!productLineId || (fetched.productLineId ?? null) === productLineId)
                ) {
                  applyBriefToPrewrite(fetched);
                } else {
                  replaceStudioUrlParam('briefId', null);
                }
              })
              .catch(() => undefined),
          );
        }
      }

      // Hydrate ?articleId= (single source of truth for article selection across refresh & shared links)
      if (urlParams.articleId) {
        if (urlParams.fixCode || urlParams.locateTerm) {
          pendingFixLocatorRef.current = {
            articleId: urlParams.articleId,
            code: (urlParams.fixCode as PreflightItemCode) || undefined,
            locateTerm: urlParams.locateTerm || undefined,
          };
          replaceStudioUrlParam('fixCode', null);
          replaceStudioUrlParam('locateTerm', null);
        }
        const localArt = loadedArticles.find((a) => a.id === urlParams.articleId);
        if (localArt) {
          lastNotifiedInvalidArticleIdRef.current = null;
          applyArticleToCanvas(localArt);
        } else {
          hydrationTasks.push(
            getArticle(urlParams.articleId, { signal: ctrl.signal })
              .then((fetched) => {
                if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
                const productLineMatches =
                  !productLineId || (fetched.productLineId ?? null) === productLineId;
                if (
                  fetched.brandId === brandId &&
                  fetched.market === market &&
                  productLineMatches
                ) {
                  lastNotifiedInvalidArticleIdRef.current = null;
                  setArticles((prev) =>
                    prev.some((a) => a.id === fetched.id) ? prev : [fetched, ...prev],
                  );
                  applyArticleToCanvas(fetched);
                  return;
                }

                // Bare /studio?articleId=... (or non-conflicting URL): auto-switch to article's brand/market if owned
                const curParams = readStudioUrlParams();
                const hasConflictingBrand = Boolean(
                  curParams.brandId && curParams.brandId !== fetched.brandId,
                );
                const hasConflictingMarket = Boolean(
                  curParams.market && curParams.market !== fetched.market,
                );
                const hasConflictingProductLine = Boolean(
                  curParams.productLineId &&
                  (fetched.productLineId ?? null) !== curParams.productLineId,
                );
                const needsBrandOrMarketSwitch =
                  fetched.brandId !== brandId || fetched.market !== market;
                const targetBrand = useWorkspaceStore
                  .getState()
                  .brands.find(
                    (b) =>
                      b.id === fetched.brandId &&
                      b.markets.some((m) => m.market === fetched.market),
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

                replaceStudioUrlParam('articleId', null);
                if (lastNotifiedInvalidArticleIdRef.current !== urlParams.articleId) {
                  lastNotifiedInvalidArticleIdRef.current = urlParams.articleId;
                  feedbackRef.current.notifyWarning(
                    !productLineMatches && fetched.brandId === brandId && fetched.market === market
                      ? '该文章不属于当前产品线，已清除链接中的文章参数'
                      : '该文章不属于当前品牌或市场，已清除链接中的文章参数',
                  );
                }
              })
              .catch(() => {
                if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
                replaceStudioUrlParam('articleId', null);
                if (lastNotifiedInvalidArticleIdRef.current !== urlParams.articleId) {
                  lastNotifiedInvalidArticleIdRef.current = urlParams.articleId;
                  feedbackRef.current.notifyWarning(
                    '未找到链接指定的文章（可能已删除或无权访问），已清除失效参数',
                  );
                }
              }),
          );
        }
      }

      if (hydrationTasks.length === 0) {
        urlHydratedSeqRef.current = seq;
      } else {
        void Promise.allSettled(hydrationTasks).then(() => {
          if (seq === contextSeqRef.current && !ctrl.signal.aborted) {
            urlHydratedSeqRef.current = seq;
          }
        });
      }
    },
    [applyArticleToCanvas, applyBriefToPrewrite],
  );

  // Brand / Market / ContextEpoch Switch Reset + Reload (Anti-Race)
  useEffect(() => {
    loadCtrlRef.current?.abort();
    urlSyncCtrlRef.current?.abort();
    urlSyncCtrlRef.current = null;
    streamCtrlRef.current?.abort();
    mediaRefreshCtrlRef.current?.abort();
    mediaRefreshCtrlRef.current = null;
    clearArticleActionControllers();
    pendingFixLocatorRef.current = null;
    setNavigatingPublish(false);
    if (abortWalletTimerRef.current) {
      clearTimeout(abortWalletTimerRef.current);
      abortWalletTimerRef.current = null;
    }
    activeArticleIdRef.current = null;
    articleSeqRef.current += 1;
    insertingMediaRef.current = false;
    setSavingArticle(false);
    setBatchSubmitting(false);
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
      setHighlightedBatchJobId(null);
      const curParams = readStudioUrlParams();
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
        replaceStudioUrlParam('briefId', null);
        replaceStudioUrlParam('articleId', null);
        replaceStudioUrlParam('batchJobId', null);
      } else if (!isPreservedAutoSwitch) {
        replaceStudioUrlParam('briefId', null);
        replaceStudioUrlParam('batchJobId', null);
      }
    }

    // Reset history filters on brand/market switch without triggering a duplicate filter fetch
    const hadNonEmptyFilters =
      articleFiltersRef.current.status !== '' || articleFiltersRef.current.tag !== '';
    articleFiltersRef.current = { status: '', tag: '' };
    lastFilterFetchRef.current = { contextKey, status: '', tag: '' };
    pendingFilterResetRef.current = hadNonEmptyFilters;
    setArticleStatusFilter('');
    setArticleTagFilter('');

    // Immediately reset brand/market-scoped state & sync targetFormat to activeMarket
    setBriefs([]);
    setArticles([]);
    setBatchJobs([]);
    setSelectedBriefIds([]);
    setLinkedBrief(null);
    setTargetPrompt('');
    setOutlineH2([]);
    setTargetFanOuts([]);
    setActiveArticle(null);
    setPrewriteExpanded(false);
    setFocusMode(false);
    setMobileLeftDrawerOpen(false);
    setMobileRightDrawerOpen(false);
    setDraftTitle('');
    setDraftMarkdown('');
    setStreaming(false);
    setStreamMarkdown('');
    setStreamError(null);
    setPartialDraft(null);
    setMatchedFactIds([]);
    setEvaluation(null);
    setEvaluating(false);
    setSupplementingTerm(null);
    setQuickExtractModalOpen(false);
    setBatchTbdDrawerOpen(false);
    checkingFactsRef.current = false;
    streamingRef.current = false;
    brandFactsPromiseRef.current = null;
    if (returnFocusTimerRef.current) {
      clearTimeout(returnFocusTimerRef.current);
      returnFocusTimerRef.current = null;
    }
    if (editorFocusTimerRef.current) {
      clearTimeout(editorFocusTimerRef.current);
      editorFocusTimerRef.current = null;
    }
    setTargetFormat(defaultTargetFormatForMarket(activeMarket));
    setTargetLocale(defaultTargetLocaleRef.current);
    hadActiveBatchRef.current = false;
    editorCursorRef.current = null;
    pendingUsedMediaIdsRef.current = [];
    const brandLineKey = activeBrandId ? `${activeBrandId}::${activeProductLineId ?? ''}` : null;
    if (lastLoadedBrandIdRef.current !== brandLineKey) {
      if (!lastLoadedBrandIdRef.current?.startsWith(`${activeBrandId ?? ''}::`)) {
        setBrandMedia([]);
      }
      setBrandFacts([]);
      brandFactsRef.current = [];
      brandFactsLoadedRef.current = false;
      lastLoadedBrandIdRef.current = brandLineKey;
    }

    if (!activeBrandId || !activeBrandMarketId) {
      setBriefsLoading(false);
      setArticlesLoading(false);
      setBrandMediaLoading(false);
      return;
    }

    void loadWorkspaceData(activeBrandId, activeMarket, seq, {
      productLineId: activeProductLineId,
    });

    return () => {
      loadCtrlRef.current?.abort();
      urlSyncCtrlRef.current?.abort();
      urlSyncCtrlRef.current = null;
      streamCtrlRef.current?.abort();
      mediaRefreshCtrlRef.current?.abort();
      mediaRefreshCtrlRef.current = null;
      if (abortWalletTimerRef.current) {
        clearTimeout(abortWalletTimerRef.current);
        abortWalletTimerRef.current = null;
      }
      if (returnFocusTimerRef.current) {
        clearTimeout(returnFocusTimerRef.current);
        returnFocusTimerRef.current = null;
      }
      if (editorFocusTimerRef.current) {
        clearTimeout(editorFocusTimerRef.current);
        editorFocusTimerRef.current = null;
      }
      clearArticleActionControllers();
      insertingMediaRef.current = false;
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

  // Reactive URL sync for ?articleId= (handles in-app navigation and browser Back/Forward)
  const syncArticleFromCurrentUrl = useCallback(() => {
    if (!activeBrandId || !activeBrandMarketId) return;
    const seq = contextSeqRef.current;
    if (urlHydratedSeqRef.current !== seq) return;

    const urlParams = readStudioUrlParams();
    if (!urlParams.articleId) {
      if (activeArticleIdRef.current !== null) {
        resetActiveArticleContext(null);
        setActiveArticle(null);
        setDraftTitle('');
        setDraftMarkdown('');
      }
      return;
    }

    if (urlParams.fixCode || urlParams.locateTerm) {
      pendingFixLocatorRef.current = {
        articleId: urlParams.articleId,
        code: (urlParams.fixCode as PreflightItemCode) || undefined,
        locateTerm: urlParams.locateTerm || undefined,
      };
      replaceStudioUrlParam('fixCode', null);
      replaceStudioUrlParam('locateTerm', null);
    }

    if (urlParams.articleId === activeArticleIdRef.current) {
      return;
    }

    const localArt = articlesRef.current.find((a) => a.id === urlParams.articleId);
    if (localArt) {
      lastNotifiedInvalidArticleIdRef.current = null;
      applyArticleToCanvas(localArt);
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
          applyArticleToCanvas(fetched);
          return;
        }
        const curParams = readStudioUrlParams();
        const hasConflictingBrand = Boolean(
          curParams.brandId && curParams.brandId !== fetched.brandId,
        );
        const hasConflictingMarket = Boolean(
          curParams.market && curParams.market !== fetched.market,
        );
        const hasConflictingProductLine = Boolean(
          curParams.productLineId && (fetched.productLineId ?? null) !== curParams.productLineId,
        );
        const needsBrandOrMarketSwitch =
          fetched.brandId !== activeBrandId || fetched.market !== activeMarket;
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
        replaceStudioUrlParam('articleId', null);
        if (lastNotifiedInvalidArticleIdRef.current !== targetArticleId) {
          lastNotifiedInvalidArticleIdRef.current = targetArticleId;
          feedbackRef.current.notifyWarning(
            !productLineMatches &&
              fetched.brandId === activeBrandId &&
              fetched.market === activeMarket
              ? '该文章不属于当前产品线，已清除链接中的文章参数'
              : '该文章不属于当前品牌或市场，已清除链接中的文章参数',
          );
        }
      })
      .catch(() => {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        replaceStudioUrlParam('articleId', null);
        if (lastNotifiedInvalidArticleIdRef.current !== targetArticleId) {
          lastNotifiedInvalidArticleIdRef.current = targetArticleId;
          feedbackRef.current.notifyWarning(
            '未找到链接指定的文章（可能已删除或无权访问），已清除失效参数',
          );
        }
      });
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    activeProductLineId,
    applyArticleToCanvas,
    resetActiveArticleContext,
  ]);

  useEffect(() => {
    if (consoleCtx?.urlSearch === undefined) return;
    syncArticleFromCurrentUrl();
  }, [consoleCtx?.urlSearch, syncArticleFromCurrentUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      syncArticleFromCurrentUrl();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [syncArticleFromCurrentUrl]);

  // Refetch articles ONLY when status/tag filters actually change (never wipes editor or aborts stream)
  useEffect(() => {
    if (!activeBrandId || !activeBrandMarketId) return;
    const contextKey = `${activeBrandId}::${activeBrandMarketId}::${activeMarket}::${activeProductLineId ?? ''}::${state.contextEpoch}`;
    if (pendingFilterResetRef.current) {
      if (articleStatusFilter === '' && articleTagFilter === '') {
        pendingFilterResetRef.current = false;
      }
      return;
    }
    const prev = lastFilterFetchRef.current;
    if (
      prev &&
      prev.contextKey === contextKey &&
      prev.status === articleStatusFilter &&
      prev.tag === articleTagFilter
    ) {
      return;
    }
    lastFilterFetchRef.current = {
      contextKey,
      status: articleStatusFilter,
      tag: articleTagFilter,
    };

    const seq = contextSeqRef.current;
    const ctrl = new AbortController();
    setArticlesLoading(true);
    void fetchArticles(
      activeBrandId,
      activeMarket,
      {
        status: articleStatusFilter || undefined,
        tag: articleTagFilter.trim() || undefined,
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
    articleStatusFilter,
    articleTagFilter,
  ]);

  // Active batch job polling
  const hasActiveBatchJob = useMemo(
    () => batchJobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING'),
    [batchJobs],
  );

  useTaskPolling({
    enabled: Boolean(activeBrandId && activeBrandMarket && hasActiveBatchJob),
    active: hasActiveBatchJob,
    intervalMs: 3_000,
    onPoll: async () => {
      if (!activeBrandId || !activeBrandMarket) return;
      const seq = contextSeqRef.current;
      try {
        const res = await fetchBatchJobs(activeBrandId, activeMarket);
        if (seq !== contextSeqRef.current) return;
        setBatchJobs(res.items);
        const stillActive = res.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
        if (hadActiveBatchRef.current && !stillActive) {
          hadActiveBatchRef.current = false;
          void loadWorkspaceData(activeBrandId, activeMarket, seq, {
            preserveSelection: true,
            productLineId: activeProductLineId,
          });
          void consoleCtx?.refreshWallet();
          invalidateFreshness('articles', 'briefs', 'points');
        } else if (stillActive) {
          hadActiveBatchRef.current = true;
        }
      } catch {
        // Silent retry on next poll tick
      }
    },
  });

  useEffect(() => {
    if (hasActiveBatchJob) {
      hadActiveBatchRef.current = true;
    }
  }, [hasActiveBatchJob]);

  const activeArticleId = activeArticle?.id ?? null;

  // Cross-tab freshness sync (briefs/articles/brand-facts/brand-media/product-lines)
  useTabFreshness({
    domains: ['briefs', 'articles', 'brand-facts', 'brand-media', 'product-lines'],
    active: Boolean(activeBrandId && activeBrandMarket && !streaming),
    refreshOnActivate: false,
    onRefresh: () => {
      if (skipNextSelfWorkspaceRefreshRef.current) {
        skipNextSelfWorkspaceRefreshRef.current = false;
        return;
      }
      if (!activeBrandId || !activeBrandMarket || streaming) return;
      void loadWorkspaceData(activeBrandId, activeMarket, contextSeqRef.current, {
        preserveSelection: true,
        productLineId: activeProductLineId,
      });
    },
  });

  const handleStartFreeTopic = () => {
    resetActiveArticleContext(null);
    setLinkedBrief(null);
    setActiveArticle(null);
    setPrewriteExpanded(true);
    setMobileLeftDrawerOpen(false);
    setDraftTitle('');
    setDraftMarkdown('');
    setOutlineH2([]);
    setTargetFanOuts([]);
    setMatchedFactIds([]);
    setStreamError(null);
    setPartialDraft(null);
    replaceStudioUrlParam('briefId', null);
    replaceStudioUrlParam('articleId', null);
  };

  const handleCopyPartialDraft = async () => {
    if (!partialDraft?.markdown) return;
    const copied = await copyTextToClipboard(partialDraft.markdown);
    if (copied) {
      feedback.notifySuccess('已复制已生成的正文片段');
    } else {
      feedback.notifyWarning('自动复制失败，请手动选中片段复制');
    }
  };

  const handleDismissPartialDraft = () => {
    setPartialDraft(null);
    if (!activeArticle) {
      setDraftMarkdown('');
    }
  };

  const executeStartStream = async () => {
    if (!activeBrandId || !activeBrandMarket || readOnly || streaming || streamingRef.current) {
      return;
    }
    const promptTrimmed = targetPrompt.trim();
    if (promptTrimmed.length < 2) return;

    streamingRef.current = true;
    streamCtrlRef.current?.abort();
    const ctrl = new AbortController();
    streamCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;

    setStreaming(true);
    setStreamMarkdown('');
    setStreamError(null);
    setPartialDraft(null);

    let completedArticle: GeoArticleRecord | null = null;
    let receivedErrorEvent = false;
    let streamedText = '';
    let failureReason: string | null = null;
    let failureRefunded = false;

    const preservePartialIfAny = (reason: string, refunded: boolean) => {
      if (streamedText.trim().length === 0) return;
      setPartialDraft({ markdown: streamedText, reason, refunded });
      if (!activeArticleIdRef.current) {
        setDraftMarkdown(streamedText);
      }
    };

    try {
      const safeTargetFormat = targetFormatsForMarket(activeMarket).includes(targetFormat)
        ? targetFormat
        : defaultTargetFormatForMarket(activeMarket);
      const effectiveProductLineId = linkedBrief?.productLineId ?? activeProductLineId ?? undefined;
      const result = await streamGenerateArticle(
        activeBrandId,
        {
          market: activeMarket,
          ...(linkedBrief ? { briefId: linkedBrief.id } : {}),
          ...(effectiveProductLineId ? { productLineId: effectiveProductLineId } : {}),
          ...(linkedBrief?.sourceCitationUrl
            ? { sourceCitationUrl: linkedBrief.sourceCitationUrl }
            : {}),
          recipe,
          targetFormat: safeTargetFormat,
          targetPrompt: promptTrimmed,
          ...(outlineH2.length > 0 ? { outlineH2 } : {}),
          ...(targetFanOuts.length > 0 ? { targetFanOuts } : {}),
          ...(showLocaleSelector && targetLocale ? { targetLocale } : {}),
        },
        {
          onMeta: (meta) => {
            if (seq !== contextSeqRef.current) return;
            if (Array.isArray(meta.matchedFactIds)) {
              setMatchedFactIds(meta.matchedFactIds);
            }
          },
          onDelta: (delta) => {
            if (seq !== contextSeqRef.current) return;
            streamedText += delta.text;
            setStreamMarkdown(streamedText);
          },
          onComplete: (complete) => {
            if (seq !== contextSeqRef.current) return;
            completedArticle = complete.article;
            setPartialDraft(null);
            setPrewriteExpanded(false);
            applyArticleToCanvas(complete.article);
            setArticles((prev) => [
              complete.article,
              ...prev.filter((a) => a.id !== complete.article.id),
            ]);
            if (linkedBrief) {
              setBriefs((prev) => prev.filter((b) => b.id !== linkedBrief.id));
              setLinkedBrief(null);
              replaceStudioUrlParam('briefId', null);
            }
          },
          onErrorEvent: (errEv) => {
            if (seq !== contextSeqRef.current) return;
            receivedErrorEvent = true;
            failureRefunded = Boolean(errEv.refunded);
            const suffix = errEv.refunded ? '（已自动退还冻结的 10 点）' : '';
            const msg = `${errEv.msg || '生成失败'}${suffix}`;
            failureReason = msg;
            setStreamError(msg);
            feedback.notifyError(msg);
          },
        },
        { signal: ctrl.signal },
      );

      if (seq !== contextSeqRef.current) return;

      if (result.aborted) {
        const abortMsg = '已中断本次生成并自动退还冻结点数';
        feedback.notifyWarning(abortMsg);
        preservePartialIfAny(abortMsg, true);
        invalidateFreshness('points');
        if (abortWalletTimerRef.current) {
          clearTimeout(abortWalletTimerRef.current);
        }
        abortWalletTimerRef.current = setTimeout(() => {
          abortWalletTimerRef.current = null;
          void consoleCtx?.refreshWallet();
        }, 800);
      } else if (completedArticle) {
        feedback.notifySuccess('GEO 文章生成完成');
        invalidateFreshness('articles', 'briefs', 'points');
      } else if (receivedErrorEvent) {
        preservePartialIfAny(failureReason ?? '流式生成中断', failureRefunded);
        invalidateFreshness('points');
      } else {
        const unexpectedMsg = '流式连接意外结束，请检查余额或重试';
        setStreamError(unexpectedMsg);
        preservePartialIfAny(unexpectedMsg, true);
        invalidateFreshness('points');
      }
      void consoleCtx?.refreshWallet();
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      const msg = formatStudioError(err, '流式生成文章失败');
      setStreamError(msg);
      feedback.notifyError(msg);
      preservePartialIfAny(msg, true);
      invalidateFreshness('points');
      void consoleCtx?.refreshWallet();
    } finally {
      if (seq === contextSeqRef.current) {
        streamingRef.current = false;
        setStreaming(false);
        setStreamMarkdown('');
      }
    }
  };

  const handleRequestStartStream = async () => {
    if (
      !activeBrandId ||
      !activeBrandMarket ||
      readOnly ||
      streaming ||
      streamingRef.current ||
      checkingFactsRef.current
    ) {
      return;
    }
    const promptTrimmed = targetPrompt.trim();
    if (promptTrimmed.length < 2) return;

    if (brandFactsLoadedRef.current) {
      if (!hasValidBrandFacts(brandFactsRef.current)) {
        setQuickExtractModalOpen(true);
        return;
      }
      void executeStartStream();
      return;
    }

    const seq = contextSeqRef.current;
    checkingFactsRef.current = true;
    let resolvedFacts: BrandFactRecord[] | null = null;
    try {
      const pending = brandFactsPromiseRef.current;
      if (pending && pending.seq === seq) {
        resolvedFacts = await pending.promise;
      } else {
        resolvedFacts = await getBrandFacts(activeBrandId, {
          ...(activeProductLineId ? { productLineId: activeProductLineId } : {}),
        })
          .then((res) => res.items)
          .catch(() => null);
      }
    } finally {
      if (seq === contextSeqRef.current) {
        checkingFactsRef.current = false;
      }
    }

    if (seq !== contextSeqRef.current) return;

    if (resolvedFacts !== null) {
      setBrandFacts(resolvedFacts);
      brandFactsRef.current = resolvedFacts;
      brandFactsLoadedRef.current = true;
      if (!hasValidBrandFacts(resolvedFacts)) {
        setQuickExtractModalOpen(true);
        return;
      }
    }

    void executeStartStream();
  };

  const handleQuickFactsSaved = (saved: BrandFactsResponse) => {
    skipNextSelfWorkspaceRefreshRef.current = true;
    const scopedItems = activeProductLineId
      ? saved.items.filter(
          (item) => item.productLineId == null || item.productLineId === activeProductLineId,
        )
      : saved.items;
    setBrandFacts(scopedItems);
    brandFactsRef.current = scopedItems;
    brandFactsLoadedRef.current = true;
    setQuickExtractModalOpen(false);
    void executeStartStream();
  };

  const handleAbortStream = () => {
    streamCtrlRef.current?.abort();
  };

  const persistDraftChanges = async (): Promise<boolean> => {
    if (!activeArticle || readOnly || savingArticle) return false;
    const targetArticle = activeArticle;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    const queuedMediaIds = [...pendingUsedMediaIdsRef.current];
    setSavingArticle(true);
    try {
      const updated = await updateArticle(targetArticle.id, {
        title: draftTitle.trim() || targetArticle.title,
        contentMarkdown: draftMarkdown,
        ...(queuedMediaIds.length > 0 ? { usedMediaIds: queuedMediaIds } : {}),
      });
      if (queuedMediaIds.length > 0) {
        invalidateFreshness('articles', 'brand-media');
      } else {
        invalidateFreshness('articles');
      }
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return false;
      pendingUsedMediaIdsRef.current = pendingUsedMediaIdsRef.current.filter(
        (id) => !queuedMediaIds.includes(id),
      );
      applyArticleToCanvas(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('文章修改已保存');
      if (queuedMediaIds.length > 0) {
        setBrandMedia((prev) =>
          prev.map((item) =>
            queuedMediaIds.includes(item.id) ? { ...item, usedCount: item.usedCount + 1 } : item,
          ),
        );
      }
      return true;
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return false;
      feedback.notifyError(formatStudioError(err, '保存文章失败'));
      return false;
    } finally {
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        setSavingArticle(false);
      }
    }
  };

  const handleSaveArticle = async (): Promise<void> => {
    await persistDraftChanges();
  };

  const handleRefreshBrandMedia = useCallback(async () => {
    if (!activeBrandId) return;
    mediaRefreshCtrlRef.current?.abort();
    const ctrl = new AbortController();
    mediaRefreshCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setBrandMediaLoading(true);
    try {
      const res = await listBrandMedia(activeBrandId, { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setBrandMedia(res.items);
    } catch {
      // Non-blocking refresh
    } finally {
      if (mediaRefreshCtrlRef.current === ctrl) {
        mediaRefreshCtrlRef.current = null;
      }
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setBrandMediaLoading(false);
      }
    }
  }, [activeBrandId]);

  const handleInsertMedia = async (asset: BrandMediaAssetRecord) => {
    if (!activeArticle || readOnly || insertingMediaRef.current) return;
    insertingMediaRef.current = true;
    const token = buildMarkdownImageToken(asset.title, asset.url);
    const nextMarkdown = insertMarkdownAtCursor(draftMarkdown, token, editorCursorRef.current);
    setDraftMarkdown(nextMarkdown);

    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    const articleId = activeArticle.id;
    const nextTitle = draftTitle.trim() || activeArticle.title;
    setSavingArticle(true);
    try {
      const updated = await updateArticle(articleId, {
        title: nextTitle,
        contentMarkdown: nextMarkdown,
        usedMediaIds: [asset.id],
      });
      invalidateFreshness('articles', 'brand-media');
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      pendingUsedMediaIdsRef.current = pendingUsedMediaIdsRef.current.filter(
        (id) => id !== asset.id,
      );
      applyArticleToCanvas(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setBrandMedia((prev) =>
        prev.map((item) =>
          item.id === asset.id ? { ...item, usedCount: item.usedCount + 1 } : item,
        ),
      );
      feedback.notifySuccess(
        asset.origin === 'AI_INLINE_GEN' ? 'AI 配图已生成并插入正文' : '已免费插入品牌实拍图',
      );
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      if (!pendingUsedMediaIdsRef.current.includes(asset.id)) {
        pendingUsedMediaIdsRef.current = [...pendingUsedMediaIdsRef.current, asset.id];
      }
      feedback.notifyError(formatStudioError(err, '插入图片保存失败，可点击「保存修改」重试'));
      throw err;
    } finally {
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        insertingMediaRef.current = false;
        setSavingArticle(false);
      }
    }
  };

  const handleAiImageGenerated = async (asset: BrandMediaAssetRecord) => {
    setBrandMedia((prev) => [asset, ...prev.filter((item) => item.id !== asset.id)]);
    void consoleCtx?.refreshWallet();
    invalidateFreshness('points', 'brand-media');
    await handleInsertMedia(asset);
  };

  const handleEditorCursorChange = useCallback((offset: number | null) => {
    editorCursorRef.current = offset;
  }, []);

  const handleDeleteArticle = async (article: GeoArticleRecord) => {
    const seq = contextSeqRef.current;
    try {
      await deleteArticle(article.id);
      invalidateFreshness('articles');
      if (seq !== contextSeqRef.current) return;
      setArticles((prev) => prev.filter((a) => a.id !== article.id));
      if (activeArticleIdRef.current === article.id) {
        resetActiveArticleContext(null);
        setActiveArticle(null);
        setDraftTitle('');
        setDraftMarkdown('');
        replaceStudioUrlParam('articleId', null);
      }
      feedback.notifySuccess('已删除成稿');
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      feedback.notifyError(formatStudioError(err, '删除成稿失败'));
    }
  };

  const handleBackfillMissingFact = async (
    slot: MissingFactSlot,
    value: string,
    options: { syncToFact: boolean; factSlot: BrandFactSlot },
  ) => {
    if (!activeArticle || !activeBrandId || readOnly) return;
    const targetArticle = activeArticle;
    const targetBrandId = activeBrandId;
    const targetProductLineId = targetArticle.productLineId ?? activeProductLineId ?? null;
    const targetTitle = draftTitle.trim() || targetArticle.title;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    const nextMarkdown = replaceMissingFactSlot(draftMarkdown, slot, value);
    let factsSynced = false;
    try {
      if (options.syncToFact) {
        let currentFacts = brandFacts;
        if (currentFacts.length === 0) {
          const loaded = await getBrandFacts(targetBrandId, {
            ...(targetProductLineId ? { productLineId: targetProductLineId } : {}),
          });
          currentFacts = loaded.items;
        }
        const existingFact = currentFacts.find(
          (f) => f.slot === options.factSlot && (f.productLineId ?? null) === targetProductLineId,
        );
        const mergedContent = mergeFactFeedbackContent(existingFact?.content, slot.hint, value);
        const factRes = await saveBrandFacts(targetBrandId, {
          facts: [
            {
              ...(existingFact ? { id: existingFact.id } : {}),
              slot: options.factSlot,
              title: existingFact?.title || BRAND_FACT_SLOT_LABELS[options.factSlot],
              content: mergedContent,
              sourceType: 'STUDIO_FEEDBACK',
              ...(targetProductLineId !== null ? { productLineId: targetProductLineId } : {}),
            },
          ],
          ...(!activeBrand?.truthAgreementSignedAt ? { truthAgreed: true } : {}),
        });
        if (factRes.truthAgreementSignedAt) {
          useWorkspaceStore
            .getState()
            .markBrandTruthSigned(targetBrandId, factRes.truthAgreementSignedAt);
        }
        factsSynced = true;
        if (seq === contextSeqRef.current) {
          const scopedItems = activeProductLineId
            ? factRes.items.filter(
                (item) => item.productLineId == null || item.productLineId === activeProductLineId,
              )
            : factRes.items;
          setBrandFacts(scopedItems);
          brandFactsRef.current = scopedItems;
          brandFactsLoadedRef.current = true;
        }
      }

      const updatedArticle = await updateArticle(targetArticle.id, {
        title: targetTitle,
        contentMarkdown: nextMarkdown,
      });
      if (factsSynced) {
        invalidateFreshness('brand-facts', 'articles');
      } else {
        invalidateFreshness('articles');
      }
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      applyArticleToCanvas(updatedArticle);
      setArticles((prev) => prev.map((a) => (a.id === updatedArticle.id ? updatedArticle : a)));
      feedback.notifySuccess(options.syncToFact ? '已回填正文并同步存入品牌事实卡' : '已回填正文');
    } catch (err) {
      if (factsSynced) {
        invalidateFreshness('brand-facts');
      }
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        feedback.notifyError(formatStudioError(err, '回填缺失事实失败'));
      }
      throw err;
    }
  };

  const handleBatchBackfillMissingFacts = async (
    entries: readonly BatchTbdSubmitEntry[],
    options: { syncToFact: boolean; factSlot: BrandFactSlot },
  ) => {
    if (!activeArticle || !activeBrandId || readOnly || entries.length === 0) return;
    const targetArticle = activeArticle;
    const targetBrandId = activeBrandId;
    const targetProductLineId = targetArticle.productLineId ?? activeProductLineId ?? null;
    const targetTitle = draftTitle.trim() || targetArticle.title;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;

    const flatReplacements = entries.flatMap((entry) =>
      entry.group.slots.map((slot) => ({ slot, value: entry.value })),
    );
    const nextMarkdown = batchReplaceMissingFactSlots(draftMarkdown, flatReplacements);
    let factsSynced = false;

    try {
      if (options.syncToFact) {
        // Must fetch latest server facts before merging so existing slot facts are never overwritten with stale/empty local cache
        const latest = await getBrandFacts(targetBrandId, {
          ...(targetProductLineId ? { productLineId: targetProductLineId } : {}),
        });
        const currentFacts = latest.items;

        const bySlot = new Map<BrandFactSlot, { existing?: BrandFactRecord; content: string }>();
        for (const entry of entries) {
          let bucket = bySlot.get(options.factSlot);
          if (!bucket) {
            const existing = currentFacts.find(
              (f) =>
                f.slot === options.factSlot && (f.productLineId ?? null) === targetProductLineId,
            );
            bucket = { existing, content: existing?.content ?? '' };
            bySlot.set(options.factSlot, bucket);
          }
          bucket.content = mergeFactFeedbackContent(bucket.content, entry.group.hint, entry.value);
        }

        const factItems = Array.from(bySlot.entries()).map(([slot, bucket]) => ({
          ...(bucket.existing ? { id: bucket.existing.id } : {}),
          slot,
          title: bucket.existing?.title || BRAND_FACT_SLOT_LABELS[slot],
          content: bucket.content.slice(0, BRAND_FACT_CARD_MAX),
          sourceType: 'STUDIO_FEEDBACK' as const,
          ...(bucket.existing?.sourceUrl ? { sourceUrl: bucket.existing.sourceUrl } : {}),
          ...(targetProductLineId !== null ? { productLineId: targetProductLineId } : {}),
        }));

        const factRes = await saveBrandFacts(targetBrandId, {
          facts: factItems,
          ...(!activeBrand?.truthAgreementSignedAt ? { truthAgreed: true } : {}),
        });
        if (factRes.truthAgreementSignedAt) {
          useWorkspaceStore
            .getState()
            .markBrandTruthSigned(targetBrandId, factRes.truthAgreementSignedAt);
        }
        factsSynced = true;
        if (seq === contextSeqRef.current) {
          const scopedItems = activeProductLineId
            ? factRes.items.filter(
                (item) => item.productLineId == null || item.productLineId === activeProductLineId,
              )
            : factRes.items;
          setBrandFacts(scopedItems);
          brandFactsRef.current = scopedItems;
          brandFactsLoadedRef.current = true;
        }
      }

      const updatedArticle = await updateArticle(targetArticle.id, {
        title: targetTitle,
        contentMarkdown: nextMarkdown,
      });
      skipNextSelfWorkspaceRefreshRef.current = true;
      if (factsSynced) {
        invalidateFreshness('brand-facts', 'articles');
      } else {
        invalidateFreshness('articles');
      }
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      applyArticleToCanvas(updatedArticle);
      setArticles((prev) => prev.map((a) => (a.id === updatedArticle.id ? updatedArticle : a)));
      setBatchTbdDrawerOpen(false);
      feedback.notifySuccess(
        options.syncToFact
          ? `已批量填入 ${entries.length} 组事实并同步反哺品牌事实卡`
          : `已批量填入 ${entries.length} 组事实并保存正文`,
      );
    } catch (err) {
      if (factsSynced) {
        invalidateFreshness('brand-facts');
      }
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        feedback.notifyError(formatStudioError(err, '批量回填缺失事实失败'));
      }
      throw err;
    }
  };

  const handleRewriteSection = async (
    selectedText: string,
    action: GeoRewriteAction,
  ): Promise<{ rewrittenText: string } | null> => {
    if (!activeArticle || readOnly) return null;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    try {
      const res = await rewriteArticleSection(activeArticle.id, {
        selectedText,
        action,
      });
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return null;
      return { rewrittenText: res.rewrittenText };
    } catch (err) {
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        feedback.notifyError(formatStudioError(err, '局部改写失败'));
      }
      return null;
    }
  };

  const handleApplyRewrittenText = async (
    original: string,
    rewritten: string,
  ): Promise<boolean> => {
    if (!activeArticle || readOnly) return false;
    const targetArticle = activeArticle;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    const nextTitle = draftTitle.trim() || targetArticle.title;
    const nextMarkdown = draftMarkdown.includes(original)
      ? draftMarkdown.replace(original, () => rewritten)
      : `${draftMarkdown}\n\n${rewritten}`;
    try {
      const updated = await updateArticle(targetArticle.id, {
        title: nextTitle,
        contentMarkdown: nextMarkdown,
      });
      invalidateFreshness('articles');
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return false;
      applyArticleToCanvas(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('已应用局部改写并重新计算 GEO 评分');
      return true;
    } catch (err) {
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        feedback.notifyError(formatStudioError(err, '应用改写结果失败'));
      }
      return false;
    }
  };

  const handleSavePromptPreference = async (input: {
    customToneNote: string | null;
    customForbiddenWords: string[];
  }) => {
    if (readOnly) return;
    setPrefsSaving(true);
    try {
      const saved = await savePromptPreferences(input);
      setPromptPreference(saved);
      feedback.notifySuccess('已保存高级写作偏好');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '保存高级写作偏好失败'));
    } finally {
      setPrefsSaving(false);
    }
  };

  const executeLaunchBatch = async (briefIds: readonly string[]) => {
    if (!activeBrandId || !activeBrandMarket || readOnly || batchSubmitting) return;
    if (briefIds.length < 2 || briefIds.length > 20) return;
    const seq = contextSeqRef.current;
    setBatchSubmitting(true);
    try {
      const idemKey = createStudioIdempotencyKey('batch');
      const job = await createBatchJob(
        activeBrandId,
        {
          market: activeMarket,
          briefIds: [...briefIds],
          ...(showLocaleSelector && targetLocale ? { targetLocale } : {}),
        },
        idemKey,
      );
      invalidateFreshness('briefs', 'articles', 'points');
      void consoleCtx?.refreshWallet();
      if (seq !== contextSeqRef.current) return;
      setSelectedBriefIds([]);
      setBatchJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setHighlightedBatchJobId(job.id);
      replaceStudioUrlParam('batchJobId', job.id);
      setBriefs((prev) => prev.filter((b) => !job.briefIds.includes(b.id)));
      hadActiveBatchRef.current = true;
      feedback.notifySuccess(`已启动 ${job.total} 篇批量写作任务`);
    } catch (err) {
      if (seq === contextSeqRef.current) {
        feedback.notifyError(formatStudioError(err, '启动批量写作失败'));
      }
    } finally {
      if (seq === contextSeqRef.current) {
        setBatchSubmitting(false);
      }
    }
  };

  const handleLaunchBatch = () => {
    if (!activeBrandId || !activeBrandMarket || readOnly || batchSubmitting) return;
    if (selectedBriefIds.length < 2 || selectedBriefIds.length > 20) return;
    const ids = [...selectedBriefIds];
    const totalPoints = ids.length * GEO_WRITE_DEFAULT_UNIT_POINTS;
    feedback.confirm({
      title: '确认启动批量 GEO 写作？',
      content: `将在「${GEO_MARKET_LABELS[activeMarket]}」对已选 ${ids.length} 篇写作意见发起批量生成，预计预冻 ${totalPoints} 点（单篇失败自动退还该篇点数）。`,
      okText: `确认生成（${totalPoints} 点）`,
      cancelText: '取消',
      onOk: () => executeLaunchBatch(ids),
    });
  };

  // ==================== M5: Real-Time GEO Evaluate, Fan-Out Supplement & Publish/Retest ====================

  const handleRefreshEvaluate = async () => {
    if (!activeArticle || readOnly || streaming || evaluatingRef.current) return;
    evaluatingRef.current = true;
    setEvaluating(true);
    evalCtrlRef.current?.abort();
    const ctrl = new AbortController();
    evalCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    const articleSeq = articleSeqRef.current;
    const targetArticle = activeArticle;
    const isStale = () =>
      ctrl.signal.aborted || seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current;
    try {
      const res = await evaluateArticleGeo(targetArticle.id, { signal: ctrl.signal });
      if (isStale()) return;
      setEvaluation(res);
      const merged: GeoArticleRecord = {
        ...targetArticle,
        geoScore: res.geoScore,
        geoScoreDetail: res.geoScoreDetail as unknown as Record<string, unknown>,
        schemaJsonLd: res.schemaJsonLd,
        llmsTxtSnippet: res.llmsTxtSnippet,
      };
      setActiveArticle((prev) => (prev && prev.id === merged.id ? { ...prev, ...merged } : prev));
      setArticles((prev) => prev.map((a) => (a.id === merged.id ? merged : a)));
      feedback.notifySuccess(`GEO 引用就绪度评分已更新：${res.geoScore} / 100`);
    } catch (err) {
      if (isStale()) return;
      feedback.notifyError(formatStudioError(err, '刷新 GEO 体检评分失败'));
    } finally {
      if (evalCtrlRef.current === ctrl) {
        evalCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current && articleSeq === articleSeqRef.current) {
        evaluatingRef.current = false;
        setEvaluating(false);
      }
    }
  };

  const handleSupplementFanOut = async (term: string) => {
    if (!activeArticle || readOnly || streaming || supplementingTermRef.current) return;
    supplementingTermRef.current = term;
    setSupplementingTerm(term);
    supplementCtrlRef.current?.abort();
    const ctrl = new AbortController();
    supplementCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    const articleSeq = articleSeqRef.current;
    const targetArticle = activeArticle;
    const baseTitle = draftTitle.trim() || targetArticle.title;
    const baseMarkdown = draftMarkdown;
    const isStale = () =>
      ctrl.signal.aborted || seq !== contextSeqRef.current || articleSeq !== articleSeqRef.current;
    try {
      const rewritten = await rewriteArticleSection(
        targetArticle.id,
        {
          action: 'ADD_EVIDENCE',
          selectedText:
            activeMarket === 'GLOBAL'
              ? `Add a verified benchmark section covering "${term}" with concrete brand specs.`
              : `请围绕搜索拆解词「${term}」补充一段带实测参数的小节`,
          instruction:
            activeMarket === 'GLOBAL'
              ? `Write a concise H2 section titled "## ${term}" with concrete brand specifications and objective comparisons.`
              : `围绕「${term}」补写一个 ## ${term} 实测分析小节，包含品牌真实参数与量化数据，去广告味。`,
          surroundingContext: baseMarkdown.slice(-1200),
        },
        { signal: ctrl.signal },
      );
      if (isStale()) return;

      const rawSection = rewritten.rewrittenText.trim();
      const hasHeading =
        /^##\s+/m.test(rawSection) && rawSection.toLowerCase().includes(term.toLowerCase());
      const sectionMarkdown = hasHeading
        ? rawSection
        : `## ${term}${activeMarket === 'GLOBAL' ? '' : ' 实测解析'}\n\n${rawSection}`;
      const nextMarkdown = `${baseMarkdown.trimEnd()}\n\n${sectionMarkdown}`;

      const updated = await updateArticle(
        targetArticle.id,
        {
          title: baseTitle,
          contentMarkdown: nextMarkdown,
        },
        { signal: ctrl.signal },
      );
      if (isStale()) return;

      const evalRes = await evaluateArticleGeo(updated.id, { signal: ctrl.signal });
      if (isStale()) return;

      const merged: GeoArticleRecord = {
        ...updated,
        geoScore: evalRes.geoScore,
        geoScoreDetail: evalRes.geoScoreDetail as unknown as Record<string, unknown>,
        schemaJsonLd: evalRes.schemaJsonLd,
        llmsTxtSnippet: evalRes.llmsTxtSnippet,
      };
      setEvaluation(evalRes);
      applyArticleToCanvas(merged);
      setArticles((prev) => prev.map((a) => (a.id === merged.id ? merged : a)));
      feedback.notifySuccess(`已围绕「${term}」补写小节并更新 GEO 评分（${evalRes.geoScore} 分）`);
      invalidateFreshness('articles');
    } catch (err) {
      if (isStale()) return;
      feedback.notifyError(formatStudioError(err, `补写「${term}」小节失败`));
    } finally {
      if (supplementCtrlRef.current === ctrl) {
        supplementCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current && articleSeq === articleSeqRef.current) {
        supplementingTermRef.current = null;
        setSupplementingTerm(null);
      }
    }
  };

  const focusEditorForFix = useCallback(
    (code?: PreflightItemCode, locateTerm?: string) => {
      if (returnFocusTimerRef.current) {
        clearTimeout(returnFocusTimerRef.current);
      }
      if (editorFocusTimerRef.current) {
        clearTimeout(editorFocusTimerRef.current);
        editorFocusTimerRef.current = null;
      }
      const trimmedTerm = locateTerm?.trim() || '';
      returnFocusTimerRef.current = setTimeout(() => {
        returnFocusTimerRef.current = null;
        const pane = centerPaneRef.current;
        if (!pane) return;
        const missingPill = pane.querySelector<HTMLElement>('[data-testid="missing-fact-pill"]');
        const missingBar = pane.querySelector<HTMLElement>(
          '[data-testid="studio-missing-fact-bar"]',
        );
        if ((code === 'MISSING_FACT_SLOTS' || (!code && !trimmedTerm)) && missingPill) {
          if (missingBar && typeof missingBar.scrollIntoView === 'function') {
            missingBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          missingPill.focus();
          feedback.notifyWarning('已定位到待补充事实胶囊，点击即可行内补填');
          return;
        }
        const focusAndSelect = (target: HTMLTextAreaElement | HTMLInputElement | null): boolean => {
          if (!target) return false;
          if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          target.focus();
          if (trimmedTerm && typeof target.setSelectionRange === 'function') {
            const idx = target.value.toLowerCase().indexOf(trimmedTerm.toLowerCase());
            if (idx >= 0) {
              target.setSelectionRange(idx, idx + trimmedTerm.length);
              return true;
            }
          }
          return false;
        };
        const focusBestField = (currentPane: HTMLElement) => {
          const textarea = currentPane.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="文章 Markdown 正文"]',
          );
          const titleInput = currentPane.querySelector<HTMLInputElement>(
            'input[aria-label="文章标题"]',
          );
          if (trimmedTerm) {
            if (textarea && textarea.value.toLowerCase().includes(trimmedTerm.toLowerCase())) {
              focusAndSelect(textarea);
              return;
            }
            if (titleInput && titleInput.value.toLowerCase().includes(trimmedTerm.toLowerCase())) {
              focusAndSelect(titleInput);
              return;
            }
          }
          focusAndSelect(textarea ?? titleInput);
        };
        const textarea = pane.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="文章 Markdown 正文"]',
        );
        if (textarea) {
          focusBestField(pane);
        } else {
          const editLabel = Array.from(
            pane.querySelectorAll<HTMLElement>('.ant-segmented-item'),
          ).find((el) => el.textContent?.includes('源码'));
          if (editLabel) {
            editLabel.click();
            if (editorFocusTimerRef.current) {
              clearTimeout(editorFocusTimerRef.current);
            }
            editorFocusTimerRef.current = setTimeout(() => {
              editorFocusTimerRef.current = null;
              const currentPane = centerPaneRef.current;
              if (!currentPane) return;
              focusBestField(currentPane);
            }, 40);
          } else {
            focusBestField(pane);
          }
        }
        feedback.notifyWarning(
          trimmedTerm
            ? `已定位到「${trimmedTerm}」，请修改后重新体检`
            : '请修正发布前体检阻断项后再前往发布',
        );
      }, 50);
    },
    [feedback],
  );

  useEffect(() => {
    if (!activeArticleId || streaming) return;
    const pending = pendingFixLocatorRef.current;
    if (!pending || pending.articleId !== activeArticleId) return;
    pendingFixLocatorRef.current = null;
    focusEditorForFix(pending.code, pending.locateTerm);
  }, [activeArticleId, streaming, focusEditorForFix]);

  const missingSlotGroups = useMemo(
    () => (streaming || !activeArticle ? [] : groupMissingFactSlots(draftMarkdown)),
    [streaming, activeArticle, draftMarkdown],
  );
  const missingSlotCount = missingSlotGroups.length;

  useEffect(() => {
    if (batchTbdDrawerOpen && missingSlotGroups.length === 0) {
      setBatchTbdDrawerOpen(false);
    }
  }, [batchTbdDrawerOpen, missingSlotGroups.length]);

  // Cold-load Skeleton (ZERO 0 点 / 免费体验期 / ¥0.00 flash!)
  if (state.brandsLoading) {
    return (
      <section
        className="gm-studio-page"
        aria-label="GEO 写作台"
        aria-busy="true"
        data-testid="studio-loading"
      >
        <div className="gm-studio-grid">
          <div className="gm-studio-pane">
            <div className="gm-studio-pane-body">
              <Skeleton active paragraph={{ rows: 5 }} />
            </div>
          </div>
          <div className="gm-studio-pane">
            <div className="gm-studio-pane-body">
              <SignalSkeleton variant="block" height={340} />
            </div>
          </div>
          <div className="gm-studio-pane">
            <div className="gm-studio-pane-body">
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (state.brandsError) {
    return (
      <section className="gm-studio-page gm-studio-page--empty" aria-label="GEO 写作台">
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
      <section className="gm-studio-page gm-studio-page--empty" aria-label="GEO 写作台">
        <div className="gm-panel">
          <EmptyState
            title="暂无品牌"
            description="先用 60 秒完成品牌与事实卡建档，即可在 GEO 写作台开启实时流式精写与双轨合规交付。"
            action={
              readOnly ? undefined : (
                <Button type="primary" onClick={() => consoleCtx?.openCreateBrandModal()}>
                  新建品牌
                </Button>
              )
            }
          />
        </div>
      </section>
    );
  }

  const isDirty = Boolean(
    activeArticle &&
    (draftTitle !== activeArticle.title || draftMarkdown !== activeArticle.contentMarkdown),
  );

  const isPrewriteCollapsed = Boolean(activeArticle) && !streaming && !prewriteExpanded;

  const handleNavigatePublish = async () => {
    if (!activeArticle || streaming || navigatingPublish) return;
    const targetArticleId = activeArticle.id;
    if (isDirty && !readOnly) {
      setNavigatingPublish(true);
      const savedOk = await persistDraftChanges();
      setNavigatingPublish(false);
      if (!savedOk) return;
    }
    setMobileRightDrawerOpen(false);
    consoleCtx?.navigateWorkspace(`/publish?articleId=${encodeURIComponent(targetArticleId)}`);
  };

  const renderLeftPane = (inDrawer: boolean) => (
    <StudioLeftPane
      collapsed={inDrawer ? false : leftCollapsed}
      hideCollapseToggle={inDrawer}
      onToggleCollapse={() => {
        leftCollapseManualRef.current = true;
        setLeftCollapsed((v) => !v);
      }}
      briefs={briefs}
      briefsLoading={briefsLoading}
      activeBriefId={linkedBrief?.id ?? null}
      selectedBriefIds={selectedBriefIds}
      onSelectedBriefIdsChange={setSelectedBriefIds}
      onSelectBrief={applyBriefToPrewrite}
      onStartFreeTopic={handleStartFreeTopic}
      onLaunchBatch={handleLaunchBatch}
      batchSubmitting={batchSubmitting}
      batchJobs={batchJobs}
      highlightedBatchJobId={highlightedBatchJobId}
      articles={articles}
      articlesLoading={articlesLoading}
      activeArticleId={activeArticle?.id ?? null}
      articleStatusFilter={articleStatusFilter}
      onArticleStatusFilterChange={setArticleStatusFilter}
      articleTagFilter={articleTagFilter}
      onArticleTagFilterChange={setArticleTagFilter}
      onSelectArticle={applyArticleToCanvas}
      onDeleteArticle={handleDeleteArticle}
      readOnly={readOnly}
    />
  );

  const renderRightPane = () => (
    <StudioRightPane
      activeMarket={activeMarket}
      article={activeArticle}
      streaming={streaming}
      prewriteExpanded={!isPrewriteCollapsed}
      brandFacts={brandFacts}
      matchedFactIds={matchedFactIds}
      missingSlotCount={missingSlotCount}
      navigatingPublish={navigatingPublish}
      onFocusMissingFacts={() => {
        setMobileRightDrawerOpen(false);
        setBatchTbdDrawerOpen(true);
      }}
      onNavigatePublish={() => void handleNavigatePublish()}
      readOnly={readOnly}
      evaluatorSlot={
        slots?.evaluatorSlot ?? (
          <StudioGeoEvaluator
            article={activeArticle}
            evaluation={evaluation}
            evaluating={evaluating}
            supplementingTerm={supplementingTerm}
            readOnly={readOnly}
            streaming={streaming}
            onRefreshEvaluate={handleRefreshEvaluate}
            onSupplementFanOut={handleSupplementFanOut}
          />
        )
      }
    />
  );

  const gridClassName = [
    'gm-studio-grid',
    focusMode
      ? 'gm-studio-grid-focus'
      : isNarrowDrawerViewport
        ? 'gm-studio-grid-narrow'
        : leftCollapsed
          ? 'gm-studio-grid-left-collapsed'
          : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="gm-studio-page" aria-label="GEO 写作台" data-testid="studio-workspace">
      <ProductLineSelectorPill compact className="gm-studio-pl-bar" disabled={streaming} />
      <div className={gridClassName}>
        {/* Left Pane: Pending Briefs + Batch Queue + History Articles */}
        {!focusMode && !isNarrowDrawerViewport ? renderLeftPane(false) : null}

        {/* Center Pane: Collapsible Prewrite Bar + Live SSE Editor & Preview */}
        <section
          ref={centerPaneRef}
          className="gm-studio-pane gm-studio-pane--center"
          aria-label="GEO 流式精写画布"
          data-testid="studio-center-pane"
        >
          <StudioPrewriteBar
            activeMarket={activeMarket}
            targetPrompt={targetPrompt}
            onTargetPromptChange={setTargetPrompt}
            linkedBrief={linkedBrief}
            onClearLinkedBrief={() => {
              setLinkedBrief(null);
              replaceStudioUrlParam('briefId', null);
            }}
            outlineH2={outlineH2}
            recipe={recipe}
            onRecipeChange={setRecipe}
            targetFormat={targetFormat}
            onTargetFormatChange={setTargetFormat}
            promptPreference={promptPreference}
            prefsSaving={prefsSaving}
            onSavePromptPreference={handleSavePromptPreference}
            streaming={streaming}
            streamError={streamError}
            onDismissStreamError={() => setStreamError(null)}
            onStartStream={() => void handleRequestStartStream()}
            onAbortStream={handleAbortStream}
            readOnly={readOnly}
            availableLocales={availableLocales}
            targetLocale={targetLocale}
            onTargetLocaleChange={setTargetLocale}
            collapsed={isPrewriteCollapsed}
            canCollapse={Boolean(activeArticle)}
            onToggleCollapsed={() => setPrewriteExpanded((prev) => !prev)}
            activeProductLineName={activeProductLine?.name ?? null}
            articleSummary={
              activeArticle
                ? {
                    targetPrompt: activeArticle.targetPrompt,
                    recipe: activeArticle.recipe,
                    targetFormat: activeArticle.targetFormat,
                    targetLocale: activeArticle.targetLocale ?? targetLocale,
                  }
                : null
            }
          />

          <StudioEditorCanvas
            article={activeArticle}
            streaming={streaming}
            streamMarkdown={streamMarkdown}
            partialDraft={partialDraft}
            onCopyPartialDraft={() => void handleCopyPartialDraft()}
            onRetryPartialDraft={() => void executeStartStream()}
            onDismissPartialDraft={handleDismissPartialDraft}
            draftTitle={draftTitle}
            draftMarkdown={draftMarkdown}
            dirty={isDirty}
            saving={savingArticle}
            onDraftTitleChange={setDraftTitle}
            onDraftMarkdownChange={setDraftMarkdown}
            onSaveArticle={handleSaveArticle}
            onBackfillMissingFact={handleBackfillMissingFact}
            onOpenBatchMissingFact={() => setBatchTbdDrawerOpen(true)}
            onRewriteSection={handleRewriteSection}
            onApplyRewrittenText={handleApplyRewrittenText}
            onCursorChange={handleEditorCursorChange}
            readOnly={readOnly}
            focusMode={focusMode}
            onToggleFocusMode={() => setFocusMode((v) => !v)}
            isNarrowDrawerViewport={isNarrowDrawerViewport}
            onOpenLeftDrawer={() => setMobileLeftDrawerOpen(true)}
            onOpenRightDrawer={() => setMobileRightDrawerOpen(true)}
            mediaToolbarSlot={
              slots?.mediaToolbarSlot ?? (
                <StudioMediaPopover
                  brandId={activeBrand.id}
                  market={activeMarket}
                  hasArticle={Boolean(activeArticle)}
                  mediaItems={brandMedia}
                  mediaLoading={brandMediaLoading}
                  readOnly={readOnly}
                  streaming={streaming}
                  onRefreshMedia={handleRefreshBrandMedia}
                  onInsertMedia={handleInsertMedia}
                  onAiImageGenerated={handleAiImageGenerated}
                  onAiImageError={() => {
                    void consoleCtx?.refreshWallet();
                  }}
                />
              )
            }
          />
        </section>

        {/* Right Pane: GEO Checkup & Compliance + Publish Handoff CTA */}
        {!focusMode && !isNarrowDrawerViewport ? renderRightPane() : null}
      </div>

      {/* Narrow Viewport Drawers (<= 920px) */}
      {isNarrowDrawerViewport ? (
        <>
          <Drawer
            placement="left"
            open={mobileLeftDrawerOpen}
            onClose={() => setMobileLeftDrawerOpen(false)}
            keyboard
            destroyOnHidden
            width={320}
            title="队列"
            classNames={{ body: 'gm-studio-drawer-body' }}
          >
            {renderLeftPane(true)}
          </Drawer>
          <Drawer
            placement="right"
            open={mobileRightDrawerOpen}
            onClose={() => setMobileRightDrawerOpen(false)}
            keyboard
            destroyOnHidden
            width={340}
            title="体检"
            classNames={{ body: 'gm-studio-drawer-body' }}
          >
            {renderRightPane()}
          </Drawer>
        </>
      ) : null}

      <QuickFactExtractModal
        open={quickExtractModalOpen}
        brandId={activeBrand.id}
        brandName={activeBrand.name}
        productLineId={activeProductLineId}
        productLineName={activeProductLine?.name ?? null}
        defaultDomain={activeBrandMarket.ownedDomains[0] ?? null}
        truthSignedAt={activeBrand.truthAgreementSignedAt}
        readOnly={readOnly}
        onClose={() => setQuickExtractModalOpen(false)}
        onSkipAndGenerate={() => {
          setQuickExtractModalOpen(false);
          void executeStartStream();
        }}
        onSaved={handleQuickFactsSaved}
      />

      <StudioBatchTbdDrawer
        open={batchTbdDrawerOpen}
        articleId={activeArticle?.id ?? null}
        groups={missingSlotGroups}
        readOnly={readOnly}
        onClose={() => setBatchTbdDrawerOpen(false)}
        onSubmit={handleBatchBackfillMissingFacts}
      />
    </section>
  );
}
