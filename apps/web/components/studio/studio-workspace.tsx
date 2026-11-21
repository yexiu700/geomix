'use client';

import {
  BRAND_FACT_SLOT_LABELS,
  defaultTargetFormatForMarket,
  targetFormatsForMarket,
  type BrandFactRecord,
  type BrandFactSlot,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefRecord,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoRewriteAction,
  type GeoTargetFormat,
  type MissingFactSlot,
  type PromptPreferenceRecord,
} from '@geomix/shared';
import { Skeleton } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrandFacts, saveBrandFacts } from '../../lib/brands';
import { fetchBriefs, getBrief } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import {
  createBatchJob,
  createStudioIdempotencyKey,
  deleteArticle,
  fetchArticles,
  fetchBatchJobs,
  getArticle,
  getBatchJob,
  getPromptPreferences,
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
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalSkeleton } from '../geo/primitives';
import { useConsoleContext } from '../shell/console-context';
import { StudioEditorCanvas } from './studio-editor-canvas';
import { StudioLeftPane } from './studio-left-pane';
import { StudioPrewriteBar } from './studio-prewrite-bar';
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

  const [leftCollapsed, setLeftCollapsed] = useState(false);

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
  const [matchedFactIds, setMatchedFactIds] = useState<string[]>([]);

  // Anti-race AbortControllers & monotonic context sequence
  const contextSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const streamCtrlRef = useRef<AbortController | null>(null);
  const hadActiveBatchRef = useRef(false);
  const articleFiltersRef = useRef<{ status: GeoArticleStatus | ''; tag: string }>({
    status: '',
    tag: '',
  });
  const lastFilterFetchRef = useRef<{
    contextKey: string;
    status: GeoArticleStatus | '';
    tag: string;
  } | null>(null);
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

  const applyArticleToCanvas = useCallback((article: GeoArticleRecord) => {
    setActiveArticle(article);
    setDraftTitle(article.title);
    setDraftMarkdown(article.contentMarkdown);
    setStreamError(null);
    replaceStudioUrlParam('articleId', article.id);
  }, []);

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

      const urlParams = readStudioUrlParams();
      const { status: currentStatus, tag: currentTag } = articleFiltersRef.current;

      const [briefsRes, articlesRes, batchRes, factsRes, prefRes] = await Promise.allSettled([
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
      setBriefsLoading(false);
      setArticlesLoading(false);

      if (options?.preserveSelection) return;

      // Hydrate ?batchJobId=
      if (urlParams.batchJobId) {
        setHighlightedBatchJobId(urlParams.batchJobId);
        if (!loadedBatches.some((j) => j.id === urlParams.batchJobId)) {
          void getBatchJob(brandId, urlParams.batchJobId, { signal: ctrl.signal })
            .then((job) => {
              if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
              if (job.market === market) {
                setBatchJobs((prev) => (prev.some((p) => p.id === job.id) ? prev : [job, ...prev]));
              }
            })
            .catch(() => undefined);
        }
      }

      // Hydrate ?briefId=
      if (urlParams.briefId) {
        const localMatch = loadedBriefs.find((b) => b.id === urlParams.briefId);
        if (localMatch) {
          applyBriefToPrewrite(localMatch);
        } else {
          void getBrief(urlParams.briefId, { signal: ctrl.signal })
            .then((fetched) => {
              if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
              if (fetched.brandId === brandId && fetched.market === market) {
                applyBriefToPrewrite(fetched);
              }
            })
            .catch(() => undefined);
        }
      }

      // Hydrate ?articleId=
      if (urlParams.articleId) {
        const localArt = loadedArticles.find((a) => a.id === urlParams.articleId);
        if (localArt) {
          applyArticleToCanvas(localArt);
        } else {
          void getArticle(urlParams.articleId, { signal: ctrl.signal })
            .then((fetched) => {
              if (seq !== contextSeqRef.current || ctrl.signal.aborted) return;
              if (fetched.brandId === brandId && fetched.market === market) {
                applyArticleToCanvas(fetched);
              }
            })
            .catch(() => undefined);
        }
      }
    },
    [applyArticleToCanvas, applyBriefToPrewrite],
  );

  // Brand / Market / ContextEpoch Switch Reset + Reload (Anti-Race)
  useEffect(() => {
    loadCtrlRef.current?.abort();
    streamCtrlRef.current?.abort();
    const seq = ++contextSeqRef.current;
    const contextKey = `${activeBrandId ?? ''}::${activeBrandMarketId ?? ''}::${activeMarket}::${state.contextEpoch}`;

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
    setActiveArticle(null);
    setDraftTitle('');
    setDraftMarkdown('');
    setStreaming(false);
    setStreamMarkdown('');
    setStreamError(null);
    setMatchedFactIds([]);
    setTargetFormat(defaultTargetFormatForMarket(activeMarket));
    hadActiveBatchRef.current = false;

    if (!activeBrandId || !activeBrandMarketId) {
      setBriefsLoading(false);
      setArticlesLoading(false);
      return;
    }

    void loadWorkspaceData(activeBrandId, activeMarket, seq);

    return () => {
      loadCtrlRef.current?.abort();
      streamCtrlRef.current?.abort();
    };
  }, [activeBrandId, activeBrandMarketId, activeMarket, state.contextEpoch, loadWorkspaceData]);

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

  // Cross-tab freshness sync
  useTabFreshness({
    domains: ['briefs', 'articles', 'brand-facts'],
    active: Boolean(activeBrandId && activeBrandMarket && !streaming),
    onRefresh: () => {
      if (!activeBrandId || !activeBrandMarket || streaming) return;
      void loadWorkspaceData(activeBrandId, activeMarket, contextSeqRef.current, {
        preserveSelection: true,
      });
    },
  });

  const handleStartFreeTopic = () => {
    setLinkedBrief(null);
    setActiveArticle(null);
    setDraftTitle('');
    setDraftMarkdown('');
    setOutlineH2([]);
    setTargetFanOuts([]);
    setMatchedFactIds([]);
    setStreamError(null);
    replaceStudioUrlParam('briefId', null);
    replaceStudioUrlParam('articleId', null);
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

    let completedArticle: GeoArticleRecord | null = null;
    let receivedErrorEvent = false;

    try {
      const safeTargetFormat = targetFormatsForMarket(activeMarket).includes(targetFormat)
        ? targetFormat
        : defaultTargetFormatForMarket(activeMarket);
      const result = await streamGenerateArticle(
        activeBrandId,
        {
          market: activeMarket,
          ...(linkedBrief ? { briefId: linkedBrief.id } : {}),
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
            setStreamMarkdown((prev) => prev + delta.text);
          },
          onComplete: (complete) => {
            if (seq !== contextSeqRef.current) return;
            completedArticle = complete.article;
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
            const suffix = errEv.refunded ? '（已自动退还冻结的 10 点）' : '';
            const msg = `${errEv.msg || '生成失败'}${suffix}`;
            setStreamError(msg);
            feedback.notifyError(msg);
          },
        },
        { signal: ctrl.signal },
      );

      if (seq !== contextSeqRef.current) return;

      if (result.aborted) {
        feedback.notifyWarning('已中断本次生成并自动退还冻结点数');
      } else if (completedArticle) {
        feedback.notifySuccess('GEO 文章生成完成');
        invalidateFreshness('articles', 'briefs', 'points');
      } else if (!receivedErrorEvent) {
        setStreamError('流式连接意外结束，请检查余额或重试');
      }
      void consoleCtx?.refreshWallet();
    } catch (err) {
      if (seq !== contextSeqRef.current) return;
      const msg = formatStudioError(err, '流式生成文章失败');
      setStreamError(msg);
      feedback.notifyError(msg);
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
    if (!activeArticle || readOnly) return;
    setSavingArticle(true);
    try {
      const updated = await updateArticle(activeArticle.id, {
        title: draftTitle.trim() || activeArticle.title,
        contentMarkdown: draftMarkdown,
      });
      applyArticleToCanvas(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('文章修改已保存');
      invalidateFreshness('articles');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '保存文章失败'));
    } finally {
      setSavingArticle(false);
    }
  };

  const handleDeleteArticle = async (article: GeoArticleRecord) => {
    await deleteArticle(article.id);
    setArticles((prev) => prev.filter((a) => a.id !== article.id));
    if (activeArticle?.id === article.id) {
      setActiveArticle(null);
      setDraftTitle('');
      setDraftMarkdown('');
      replaceStudioUrlParam('articleId', null);
    }
    feedback.notifySuccess('已删除成稿');
    invalidateFreshness('articles');
  };

  const handleChangeStatus = async (status: GeoArticleStatus) => {
    if (!activeArticle || readOnly) return;
    try {
      const updated = await updateArticle(activeArticle.id, { status });
      setActiveArticle(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('已更新文章状态');
      invalidateFreshness('articles');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '更新文章状态失败'));
    }
  };

  const handleChangeTags = async (tags: string[]) => {
    if (!activeArticle || readOnly) return;
    try {
      const updated = await updateArticle(activeArticle.id, { tags });
      setActiveArticle(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      invalidateFreshness('articles');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '更新标签失败'));
    }
  };

  const handleBackfillMissingFact = async (
    slot: MissingFactSlot,
    value: string,
    options: { syncToFact: boolean; factSlot: BrandFactSlot },
  ) => {
    if (!activeArticle || !activeBrandId || readOnly) return;
    const nextMarkdown = replaceMissingFactSlot(draftMarkdown, slot, value);
    try {
      if (options.syncToFact) {
        let currentFacts = brandFacts;
        if (currentFacts.length === 0) {
          const loaded = await getBrandFacts(activeBrandId);
          currentFacts = loaded.items;
        }
        const existingFact = currentFacts.find((f) => f.slot === options.factSlot);
        const mergedContent = mergeFactFeedbackContent(existingFact?.content, slot.hint, value);
        const factRes = await saveBrandFacts(activeBrandId, {
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
        setBrandFacts(factRes.items);
        if (factRes.truthAgreementSignedAt) {
          useWorkspaceStore
            .getState()
            .markBrandTruthSigned(activeBrandId, factRes.truthAgreementSignedAt);
        }
        invalidateFreshness('brand-facts');
      }

      const updatedArticle = await updateArticle(activeArticle.id, {
        contentMarkdown: nextMarkdown,
      });
      applyArticleToCanvas(updatedArticle);
      setArticles((prev) => prev.map((a) => (a.id === updatedArticle.id ? updatedArticle : a)));

      feedback.notifySuccess(options.syncToFact ? '已回填正文并同步存入品牌事实卡' : '已回填正文');
      invalidateFreshness('articles');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '回填缺失事实失败'));
      throw err;
    }
  };

  const handleRewriteSection = async (
    selectedText: string,
    action: GeoRewriteAction,
  ): Promise<{ rewrittenText: string } | null> => {
    if (!activeArticle || readOnly) return null;
    try {
      const res = await rewriteArticleSection(activeArticle.id, {
        selectedText,
        action,
      });
      return { rewrittenText: res.rewrittenText };
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '局部改写失败'));
      return null;
    }
  };

  const handleApplyRewrittenText = async (original: string, rewritten: string) => {
    if (!activeArticle || readOnly) return;
    const nextMarkdown = draftMarkdown.includes(original)
      ? draftMarkdown.replace(original, rewritten)
      : `${draftMarkdown}\n\n${rewritten}`;
    try {
      const updated = await updateArticle(activeArticle.id, { contentMarkdown: nextMarkdown });
      applyArticleToCanvas(updated);
      setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      feedback.notifySuccess('已应用局部改写并重新计算 GEO 评分');
      invalidateFreshness('articles');
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '应用改写结果失败'));
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

  const handleLaunchBatch = async () => {
    if (!activeBrandId || !activeBrandMarket || readOnly || batchSubmitting) return;
    if (selectedBriefIds.length < 2 || selectedBriefIds.length > 20) return;
    setBatchSubmitting(true);
    try {
      const idemKey = createStudioIdempotencyKey('batch');
      const job = await createBatchJob(
        activeBrandId,
        {
          market: activeMarket,
          briefIds: [...selectedBriefIds],
        },
        idemKey,
      );
      setSelectedBriefIds([]);
      setBatchJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setHighlightedBatchJobId(job.id);
      replaceStudioUrlParam('batchJobId', job.id);
      setBriefs((prev) => prev.filter((b) => !job.briefIds.includes(b.id)));
      hadActiveBatchRef.current = true;
      feedback.notifySuccess(`已启动 ${job.total} 篇批量写作任务`);
      invalidateFreshness('briefs', 'articles', 'points');
      void consoleCtx?.refreshWallet();
    } catch (err) {
      feedback.notifyError(formatStudioError(err, '启动批量写作失败'));
    } finally {
      setBatchSubmitting(false);
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

  return (
    <section className="gm-studio-page" aria-label="GEO 写作台" data-testid="studio-workspace">
      <div className={`gm-studio-grid${leftCollapsed ? ' gm-studio-grid-left-collapsed' : ''}`}>
        {/* Left Pane: Pending Briefs + Batch Queue + History Articles */}
        <StudioLeftPane
          collapsed={leftCollapsed}
          onToggleCollapse={() => setLeftCollapsed((v) => !v)}
          briefs={briefs}
          briefsLoading={briefsLoading}
          activeBriefId={linkedBrief?.id ?? null}
          selectedBriefIds={selectedBriefIds}
          onSelectedBriefIdsChange={setSelectedBriefIds}
          onSelectBrief={applyBriefToPrewrite}
          onStartFreeTopic={handleStartFreeTopic}
          onLaunchBatch={() => void handleLaunchBatch()}
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
          counterEntrySlot={slots?.counterEntrySlot}
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
            readOnly={readOnly}
            mediaToolbarSlot={slots?.mediaToolbarSlot}
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
          evaluatorSlot={slots?.evaluatorSlot}
          deliveryPackSlot={slots?.deliveryPackSlot}
          publishRetestSlot={slots?.publishRetestSlot}
        />
      </div>
    </section>
  );
}
