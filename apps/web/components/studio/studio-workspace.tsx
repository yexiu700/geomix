'use client';

import {
  BRAND_FACT_SLOT_LABELS,
  GEO_MARKET_LABELS,
  GEO_WRITE_DEFAULT_UNIT_POINTS,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  defaultTargetFormatForMarket,
  targetFormatsForMarket,
  type BrandFactRecord,
  type BrandFactSlot,
  type BrandMediaAssetRecord,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefRecord,
  type GeoEvaluationResult,
  type GeoOutlineHeading,
  type GeoPublishRecordDto,
  type GeoRecipe,
  type GeoRewriteAction,
  type GeoTargetFormat,
  type MissingFactSlot,
  type PromptPreferenceRecord,
  type PublishRecordCreateInput,
  type VisibilityEngineAvailabilityItem,
  type VisibilityEngineKey,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Modal, Skeleton, Space, Tooltip } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts, listBrandMedia, saveBrandFacts } from '../../lib/brands';
import { fetchBriefs, getBrief } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import {
  buildMarkdownImageToken,
  copyTextToClipboard,
  createBatchJob,
  createPublishRecord,
  createStudioIdempotencyKey,
  deleteArticle,
  evaluateArticleGeo,
  fetchArticles,
  fetchBatchJobs,
  fetchPublishRecords,
  getArticle,
  getBatchJob,
  getPromptPreferences,
  insertMarkdownAtCursor,
  mergeFactFeedbackContent,
  replaceMissingFactSlot,
  rewriteArticleSection,
  savePromptPreferences,
  streamGenerateArticle,
  triggerPublishRetest,
  updateArticle,
} from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
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
import { CitationCounterModal } from '../briefs/citation-counter-modal';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { StudioDeliveryPack } from './studio-delivery-pack';
import { StudioEditorCanvas, type PartialStreamDraft } from './studio-editor-canvas';
import { StudioGeoEvaluator } from './studio-geo-evaluator';
import { StudioLeftPane } from './studio-left-pane';
import { StudioMediaPopover } from './studio-media-popover';
import { StudioPrewriteBar } from './studio-prewrite-bar';
import { StudioPublishRetest } from './studio-publish-retest';
import { StudioRightPane } from './studio-right-pane';

export type StudioWorkspaceExtensionSlots = {
  counterEntrySlot?: ReactNode;
  mediaToolbarSlot?: ReactNode;
  evaluatorSlot?: ReactNode;
  deliveryPackSlot?: ReactNode;
  publishRetestSlot?: ReactNode;
};

const EMPTY_PREF: PromptPreferenceRecord = {
  customToneNote: null,
  customForbiddenWords: [],
  recipeOverrides: null,
  updatedAt: null,
};

function readStudioUrlParams(): {
  briefId: string | null;
  articleId: string | null;
  batchJobId: string | null;
} {
  if (typeof window === 'undefined') {
    return { briefId: null, articleId: null, batchJobId: null };
  }
  const sp = new URLSearchParams(window.location.search);
  return {
    briefId: sp.get('briefId'),
    articleId: sp.get('articleId'),
    batchJobId: sp.get('batchJobId'),
  };
}

function replaceStudioUrlParam(
  key: 'briefId' | 'articleId' | 'batchJobId',
  value: string | null,
): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
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

export function StudioWorkspace(slots?: StudioWorkspaceExtensionSlots): JSX.Element {
  const state = useWorkspaceStore();
  const activeBrand = selectActiveBrand(state);
  const activeBrandMarket = selectActiveBrandMarket(state);
  const activeBrandId = activeBrand?.id ?? null;
  const activeBrandMarketId = activeBrandMarket?.id ?? null;
  const activeMarket = state.activeMarket;
  const consoleCtx = useConsoleContext();
  const readOnly = consoleCtx?.readOnly ?? false;
  const feedback = useUxFeedback();

  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(min-width: 900px) and (max-width: 1199px)').matches;
  });
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
  const [counterModalOpen, setCounterModalOpen] = useState(false);
  const [promptPreference, setPromptPreference] = useState<PromptPreferenceRecord>(EMPTY_PREF);
  const [prefsSaving, setPrefsSaving] = useState(false);

  // Pre-Write Form State
  const [linkedBrief, setLinkedBrief] = useState<GeoBriefRecord | null>(null);
  const [targetPrompt, setTargetPrompt] = useState('');
  const [outlineH2, setOutlineH2] = useState<GeoOutlineHeading[]>([]);
  const [targetFanOuts, setTargetFanOuts] = useState<string[]>([]);
  const [recipe, setRecipe] = useState<GeoRecipe>('AUTHORITY_GUIDE');
  const [targetFormat, setTargetFormat] = useState<GeoTargetFormat>(() =>
    defaultTargetFormatForMarket(activeMarket),
  );
  const [wordCountTarget, setWordCountTarget] = useState<number | undefined>(undefined);

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

  // M5 Delivery, Evaluator & Publish/Retest State
  const [evaluation, setEvaluation] = useState<GeoEvaluationResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [supplementingTerm, setSupplementingTerm] = useState<string | null>(null);
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

  // Anti-race AbortControllers & monotonic context/article sequences
  const contextSeqRef = useRef(0);
  const urlHydratedSeqRef = useRef(0);
  const articleSeqRef = useRef(0);
  const activeArticleIdRef = useRef<string | null>(null);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const streamCtrlRef = useRef<AbortController | null>(null);
  const mediaRefreshCtrlRef = useRef<AbortController | null>(null);
  const pubRecordsCtrlRef = useRef<AbortController | null>(null);
  const evalCtrlRef = useRef<AbortController | null>(null);
  const supplementCtrlRef = useRef<AbortController | null>(null);
  const publishCtrlRef = useRef<AbortController | null>(null);
  const retestCtrlRef = useRef<AbortController | null>(null);
  const retestEnginesCtrlRef = useRef<AbortController | null>(null);
  const evaluatingRef = useRef(false);
  const supplementingTermRef = useRef<string | null>(null);
  const retestingRecordsRef = useRef<Set<string>>(new Set());
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
      replaceStudioUrlParam('briefId', brief.id);
    },
    [activeMarket],
  );

  const clearArticleActionControllers = useCallback(() => {
    evalCtrlRef.current?.abort();
    evalCtrlRef.current = null;
    supplementCtrlRef.current?.abort();
    supplementCtrlRef.current = null;
    publishCtrlRef.current?.abort();
    publishCtrlRef.current = null;
    retestCtrlRef.current?.abort();
    retestCtrlRef.current = null;
    retestEnginesCtrlRef.current?.abort();
    retestEnginesCtrlRef.current = null;
    evaluatingRef.current = false;
    supplementingTermRef.current = null;
    retestingRecordsRef.current.clear();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 900px) and (max-width: 1199px)');
    const syncNarrowRail = () => {
      if (!leftCollapseManualRef.current) {
        setLeftCollapsed(mq.matches);
      }
    };
    mq.addEventListener('change', syncNarrowRail);
    return () => mq.removeEventListener('change', syncNarrowRail);
  }, []);

  const resetActiveArticleContext = useCallback(
    (nextArticleId: string | null) => {
      if (activeArticleIdRef.current === nextArticleId) return;
      activeArticleIdRef.current = nextArticleId;
      articleSeqRef.current += 1;
      clearArticleActionControllers();
      insertingMediaRef.current = false;
      pendingUsedMediaIdsRef.current = [];
      setSavingArticle(false);
      setEvaluating(false);
      setSupplementingTerm(null);
      setRetestingRecordId(null);
      setRetestModalRecord(null);
    },
    [clearArticleActionControllers],
  );

  const applyArticleToCanvas = useCallback(
    (article: GeoArticleRecord) => {
      resetActiveArticleContext(article.id);
      setActiveArticle(article);
      setDraftTitle(article.title);
      setDraftMarkdown(article.contentMarkdown);
      setStreamError(null);
      setPartialDraft(null);
      replaceStudioUrlParam('articleId', article.id);
    },
    [resetActiveArticleContext],
  );

  const loadWorkspaceData = useCallback(
    async (
      brandId: string,
      market: typeof activeMarket,
      seq: number,
      options?: { preserveSelection?: boolean },
    ) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;

      setBriefsLoading(true);
      setArticlesLoading(true);
      setBrandMediaLoading(true);

      const urlParams = readStudioUrlParams();
      const { status: currentStatus, tag: currentTag } = articleFiltersRef.current;

      const [briefsRes, articlesRes, batchRes, factsRes, prefRes, mediaRes] =
        await Promise.allSettled([
          fetchBriefs(brandId, market, { status: 'OPEN', pageSize: 50 }, { signal: ctrl.signal }),
          fetchArticles(
            brandId,
            market,
            {
              status: currentStatus || undefined,
              tag: currentTag.trim() || undefined,
              pageSize: 50,
            },
            { signal: ctrl.signal },
          ),
          fetchBatchJobs(brandId, market, { signal: ctrl.signal }),
          getBrandFacts(brandId, { signal: ctrl.signal }),
          getPromptPreferences({ signal: ctrl.signal }),
          listBrandMedia(brandId, { signal: ctrl.signal }),
        ]);

      if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;

      const loadedBriefs = briefsRes.status === 'fulfilled' ? briefsRes.value.items : [];
      const loadedArticles = articlesRes.status === 'fulfilled' ? articlesRes.value.items : [];
      const loadedBatches = batchRes.status === 'fulfilled' ? batchRes.value.items : [];
      const loadedFacts = factsRes.status === 'fulfilled' ? factsRes.value.items : [];

      setBriefs(loadedBriefs);
      setArticles(loadedArticles);
      setBatchJobs(loadedBatches);
      setBrandFacts(loadedFacts);
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
                if (fetched.brandId === brandId && fetched.market === market) {
                  applyBriefToPrewrite(fetched);
                }
              })
              .catch(() => undefined),
          );
        }
      }

      // Hydrate ?articleId=
      if (urlParams.articleId) {
        const localArt = loadedArticles.find((a) => a.id === urlParams.articleId);
        if (localArt) {
          applyArticleToCanvas(localArt);
        } else {
          hydrationTasks.push(
            getArticle(urlParams.articleId, { signal: ctrl.signal })
              .then((fetched) => {
                if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
                if (fetched.brandId === brandId && fetched.market === market) {
                  applyArticleToCanvas(fetched);
                }
              })
              .catch(() => undefined),
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
    streamCtrlRef.current?.abort();
    mediaRefreshCtrlRef.current?.abort();
    mediaRefreshCtrlRef.current = null;
    pubRecordsCtrlRef.current?.abort();
    pubRecordsCtrlRef.current = null;
    clearArticleActionControllers();
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
    const contextKey = `${activeBrandId ?? ''}::${activeBrandMarketId ?? ''}::${activeMarket}::${state.contextEpoch}`;
    const brandMarketKey =
      activeBrandId && activeBrandMarketId
        ? `${activeBrandId}::${activeBrandMarketId}::${activeMarket}`
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
      replaceStudioUrlParam('briefId', null);
      replaceStudioUrlParam('articleId', null);
      replaceStudioUrlParam('batchJobId', null);
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
    setPublishRecords([]);
    setPublishRecordsLoading(false);
    setRetestingRecordId(null);
    setPendingRetest(null);
    setRetestModalRecord(null);
    setRetestEngines([]);
    setRetestCheckedEngines([]);
    setRetestEnginesError(null);
    setCounterModalOpen(false);
    setTargetFormat(defaultTargetFormatForMarket(activeMarket));
    hadActiveBatchRef.current = false;
    editorCursorRef.current = null;
    pendingUsedMediaIdsRef.current = [];
    if (lastLoadedBrandIdRef.current !== activeBrandId) {
      setBrandMedia([]);
      lastLoadedBrandIdRef.current = activeBrandId;
    }

    if (!activeBrandId || !activeBrandMarketId) {
      setBriefsLoading(false);
      setArticlesLoading(false);
      setBrandMediaLoading(false);
      return;
    }

    void loadWorkspaceData(activeBrandId, activeMarket, seq);

    return () => {
      loadCtrlRef.current?.abort();
      streamCtrlRef.current?.abort();
      mediaRefreshCtrlRef.current?.abort();
      mediaRefreshCtrlRef.current = null;
      pubRecordsCtrlRef.current?.abort();
      pubRecordsCtrlRef.current = null;
      if (abortWalletTimerRef.current) {
        clearTimeout(abortWalletTimerRef.current);
        abortWalletTimerRef.current = null;
      }
      clearArticleActionControllers();
      insertingMediaRef.current = false;
    };
  }, [
    activeBrandId,
    activeBrandMarketId,
    activeMarket,
    state.contextEpoch,
    loadWorkspaceData,
    clearArticleActionControllers,
  ]);

  // Refetch articles ONLY when status/tag filters actually change (never wipes editor or aborts stream)
  useEffect(() => {
    if (!activeBrandId || !activeBrandMarketId) return;
    const contextKey = `${activeBrandId}::${activeBrandMarketId}::${activeMarket}::${state.contextEpoch}`;
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
          void loadWorkspaceData(activeBrandId, activeMarket, seq, { preserveSelection: true });
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

  // Load publish records whenever active article changes
  const activeArticleId = activeArticle?.id ?? null;
  useEffect(() => {
    pubRecordsCtrlRef.current?.abort();
    pubRecordsCtrlRef.current = null;
    setEvaluation(null);
    setPublishRecords([]);
    setPendingRetest((prev) => (prev && prev.articleId === activeArticleId ? prev : null));

    if (!activeArticleId || !activeBrandId || !activeBrandMarketId) {
      setPublishRecordsLoading(false);
      return;
    }

    const seq = contextSeqRef.current;
    const ctrl = new AbortController();
    pubRecordsCtrlRef.current = ctrl;
    setPublishRecordsLoading(true);
    void fetchPublishRecords(activeArticleId, { signal: ctrl.signal })
      .then((res) => {
        if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
        setPublishRecords(res.items);
      })
      .catch(() => {
        // Silent fallback on empty/aborted fetch
      })
      .finally(() => {
        if (seq === contextSeqRef.current && !ctrl.signal.aborted) {
          setPublishRecordsLoading(false);
        }
      });

    return () => ctrl.abort();
  }, [activeArticleId, activeBrandId, activeBrandMarketId]);

  // Poll pending retest run until afterMetrics writeback or terminal status
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
          invalidateFreshness('publish-records', 'visibility-runs', 'points');
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
          invalidateFreshness('publish-records', 'visibility-runs', 'points');
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
          invalidateFreshness('publish-records', 'visibility-runs', 'points');
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

  // Cross-tab freshness sync
  useTabFreshness({
    domains: ['briefs', 'articles', 'brand-facts', 'brand-media', 'publish-records'],
    active: Boolean(activeBrandId && activeBrandMarket && !streaming),
    refreshOnActivate: false,
    onRefresh: () => {
      if (!activeBrandId || !activeBrandMarket || streaming) return;
      void loadWorkspaceData(activeBrandId, activeMarket, contextSeqRef.current, {
        preserveSelection: true,
      });
    },
  });

  const handleStartFreeTopic = () => {
    resetActiveArticleContext(null);
    setLinkedBrief(null);
    setActiveArticle(null);
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

  const handleStartStream = async () => {
    if (!activeBrandId || !activeBrandMarket || readOnly || streaming) return;
    const promptTrimmed = targetPrompt.trim();
    if (promptTrimmed.length < 2) return;

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
      const result = await streamGenerateArticle(
        activeBrandId,
        {
          market: activeMarket,
          ...(linkedBrief ? { briefId: linkedBrief.id } : {}),
          ...(linkedBrief?.sourceCitationUrl
            ? { sourceCitationUrl: linkedBrief.sourceCitationUrl }
            : {}),
          recipe,
          targetFormat: safeTargetFormat,
          targetPrompt: promptTrimmed,
          ...(outlineH2.length > 0 ? { outlineH2 } : {}),
          ...(targetFanOuts.length > 0 ? { targetFanOuts } : {}),
          ...(wordCountTarget ? { wordCountTarget } : {}),
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
        setStreaming(false);
        setStreamMarkdown('');
      }
    }
  };

  const handleAbortStream = () => {
    streamCtrlRef.current?.abort();
  };

  const handleSaveArticle = async () => {
    if (!activeArticle || readOnly || savingArticle) return;
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
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
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
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      feedback.notifyError(formatStudioError(err, '保存文章失败'));
    } finally {
      if (seq === contextSeqRef.current && artSeq === articleSeqRef.current) {
        setSavingArticle(false);
      }
    }
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

  const handleCounterBriefCreated = (created: GeoBriefRecord) => {
    setCounterModalOpen(false);
    setBriefs((prev) => [created, ...prev.filter((b) => b.id !== created.id)]);
    applyBriefToPrewrite(created);
    feedback.notifySuccess('已生成竞品高引用反制意见，已载入写前确认条（0 点免费）');
    invalidateFreshness('briefs');
  };

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

  const handleChangeStatus = async (status: GeoArticleStatus) => {
    if (!activeArticle || readOnly) return;
    const targetArticle = activeArticle;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    try {
      const updated = await updateArticle(targetArticle.id, { status });
      invalidateFreshness('articles');
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      setActiveArticle(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('已更新文章状态');
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      feedback.notifyError(formatStudioError(err, '更新文章状态失败'));
    }
  };

  const handleChangeTags = async (tags: string[]) => {
    if (!activeArticle || readOnly) return;
    const targetArticle = activeArticle;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    try {
      const updated = await updateArticle(targetArticle.id, { tags });
      invalidateFreshness('articles');
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      setActiveArticle(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      if (seq !== contextSeqRef.current || artSeq !== articleSeqRef.current) return;
      feedback.notifyError(formatStudioError(err, '更新标签失败'));
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
    const targetTitle = draftTitle.trim() || targetArticle.title;
    const seq = contextSeqRef.current;
    const artSeq = articleSeqRef.current;
    const nextMarkdown = replaceMissingFactSlot(draftMarkdown, slot, value);
    let factsSynced = false;
    try {
      if (options.syncToFact) {
        let currentFacts = brandFacts;
        if (currentFacts.length === 0) {
          const loaded = await getBrandFacts(targetBrandId);
          currentFacts = loaded.items;
        }
        const existingFact = currentFacts.find((f) => f.slot === options.factSlot);
        const mergedContent = mergeFactFeedbackContent(existingFact?.content, slot.hint, value);
        const factRes = await saveBrandFacts(targetBrandId, {
          facts: [
            {
              ...(existingFact ? { id: existingFact.id } : {}),
              slot: options.factSlot,
              title: existingFact?.title || BRAND_FACT_SLOT_LABELS[options.factSlot],
              content: mergedContent,
              sourceType: 'STUDIO_FEEDBACK',
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
          setBrandFacts(factRes.items);
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
      const nextArticle: GeoArticleRecord = { ...targetArticle, status: 'PUBLISHED' };
      setActiveArticle((prev) =>
        prev && prev.id === nextArticle.id ? { ...prev, status: 'PUBLISHED' } : prev,
      );
      setArticles((prev) => prev.map((a) => (a.id === nextArticle.id ? nextArticle : a)));
      feedback.notifySuccess('已登记发布链接并标记文章为「已发布」');
      invalidateFreshness('publish-records', 'articles');
      return true;
    } catch (err) {
      if (isStale()) return false;
      feedback.notifyError(formatStudioError(err, '登记发布记录失败'));
      return false;
    } finally {
      if (publishCtrlRef.current === ctrl) {
        publishCtrlRef.current = null;
      }
    }
  };

  const loadRetestEngines = useCallback(async (brandId: string, market: typeof activeMarket) => {
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
      setRetestEnginesError(formatStudioError(err, '加载 AI 引擎列表失败'));
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
      feedback.notifyError(formatStudioError(err, '发起排名复测失败'));
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
      <section className="gm-studio-page" aria-label="GEO 写作台">
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
      <section className="gm-studio-page" aria-label="GEO 写作台">
        <div className="gm-panel">
          <SignalEmpty
            title="尚未创建品牌资产"
            description="先用 60 秒完成品牌与事实卡建档，即可在 GEO 写作台开启实时流式精写与双轨合规交付。"
            actionText={readOnly ? undefined : '立即创建首个品牌'}
            onAction={readOnly ? undefined : () => consoleCtx?.openCreateBrandModal()}
          />
        </div>
      </section>
    );
  }

  const isDirty = Boolean(
    activeArticle &&
    (draftTitle !== activeArticle.title || draftMarkdown !== activeArticle.contentMarkdown),
  );

  const onlineRetestEngineKeys = retestEngines.filter((eng) => eng.available).map((eng) => eng.key);
  const validRetestCheckedEngines = retestCheckedEngines.filter((key) =>
    onlineRetestEngineKeys.includes(key),
  );
  const retestEstimatedPoints = validRetestCheckedEngines.length * VISIBILITY_DEFAULT_UNIT_POINTS;

  return (
    <section className="gm-studio-page" aria-label="GEO 写作台" data-testid="studio-workspace">
      <div className={`gm-studio-grid${leftCollapsed ? ' gm-studio-grid-left-collapsed' : ''}`}>
        {/* Left Pane: Pending Briefs + Batch Queue + History Articles */}
        <StudioLeftPane
          collapsed={leftCollapsed}
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
          counterEntrySlot={
            slots?.counterEntrySlot ?? (
              <Button
                size="small"
                data-testid="studio-counter-url-btn"
                disabled={readOnly || streaming}
                onClick={() => setCounterModalOpen(true)}
              >
                竞品 URL 反制
              </Button>
            )
          }
        />

        {/* Center Pane: 3-Item Prewrite Bar + Live SSE Editor & Preview */}
        <main
          className="gm-studio-pane"
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
            wordCountTarget={wordCountTarget}
            onWordCountTargetChange={setWordCountTarget}
            promptPreference={promptPreference}
            prefsSaving={prefsSaving}
            onSavePromptPreference={handleSavePromptPreference}
            streaming={streaming}
            streamError={streamError}
            onDismissStreamError={() => setStreamError(null)}
            onStartStream={() => void handleStartStream()}
            onAbortStream={handleAbortStream}
            readOnly={readOnly}
          />

          <StudioEditorCanvas
            article={activeArticle}
            streaming={streaming}
            streamMarkdown={streamMarkdown}
            partialDraft={partialDraft}
            onCopyPartialDraft={() => void handleCopyPartialDraft()}
            onRetryPartialDraft={() => void handleStartStream()}
            onDismissPartialDraft={handleDismissPartialDraft}
            draftTitle={draftTitle}
            draftMarkdown={draftMarkdown}
            dirty={isDirty}
            saving={savingArticle}
            onDraftTitleChange={setDraftTitle}
            onDraftMarkdownChange={setDraftMarkdown}
            onSaveArticle={handleSaveArticle}
            onBackfillMissingFact={handleBackfillMissingFact}
            onRewriteSection={handleRewriteSection}
            onApplyRewrittenText={handleApplyRewrittenText}
            onCursorChange={handleEditorCursorChange}
            readOnly={readOnly}
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
        </main>

        {/* Right Pane: GEO Score + Dual-Track Compliance + Status/Tags + M5 Slots */}
        <StudioRightPane
          activeMarket={activeMarket}
          article={activeArticle}
          brandFacts={brandFacts}
          matchedFactIds={matchedFactIds}
          onChangeStatus={handleChangeStatus}
          onChangeTags={handleChangeTags}
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
          deliveryPackSlot={
            slots?.deliveryPackSlot ?? (
              <StudioDeliveryPack
                activeMarket={activeMarket}
                localBrandName={activeBrandMarket.localBrandName}
                category={activeBrand.category}
                localCategory={activeBrandMarket.localCategory}
                ownedDomains={activeBrandMarket.ownedDomains}
                article={activeArticle}
                evaluation={evaluation}
                linkedBriefChannels={linkedBrief?.recommendedChannels}
                streaming={streaming}
              />
            )
          }
          publishRetestSlot={
            slots?.publishRetestSlot ?? (
              <StudioPublishRetest
                activeMarket={activeMarket}
                article={activeArticle}
                publishRecords={publishRecords}
                recordsLoading={publishRecordsLoading}
                retestingRecordId={retestingRecordId}
                pollingRetestRecordId={pendingRetest?.recordId ?? null}
                readOnly={readOnly}
                onCreatePublishRecord={handleCreatePublishRecord}
                onTriggerRetest={handleOpenRetestModal}
              />
            )
          }
        />
      </div>

      <CitationCounterModal
        open={counterModalOpen}
        brandId={activeBrand.id}
        market={activeMarket}
        readOnly={readOnly}
        mode="url"
        onClose={() => setCounterModalOpen(false)}
        onCreated={handleCounterBriefCreated}
      />

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
        <div
          data-testid="publish-retest-modal"
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
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

          <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
            预计预冻 <strong className="gm-num">{retestEstimatedPoints}</strong> 点（
            <span className="gm-num">{validRetestCheckedEngines.length}</span> 引擎 ×{' '}
            <span className="gm-num">{VISIBILITY_DEFAULT_UNIT_POINTS}</span> 点/次）
          </div>
        </div>
      </Modal>
    </section>
  );
}
