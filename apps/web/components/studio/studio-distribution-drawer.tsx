'use client';

import {
  CHANNEL_PROVIDER_LABELS,
  DISTRIBUTION_TASK_STATUS_LABELS,
  GEO_MARKET_LABELS,
  PRICING_DEFAULTS,
  buildRecommendedChannelsForMarket,
  defaultTemplateKeyForProvider,
  evaluateDistributionPreflight,
  formatShanghaiDateTime,
  isSafeDistributionHttpUrl,
  type ChannelConnectionDto,
  type ChannelProvider,
  type DistributionPreflightResult,
  type DistributionTaskStatus,
  type DistributionVariantTargetInput,
  type GeoArticleRecord,
  type GeoBriefChannelRecommendation,
  type GeoBriefRecord,
  type GeoEvaluationResult,
  type GeoMarket,
  type PreflightItemCode,
  type PublishRecordCreateInput,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Drawer, Input, Modal, Select, Space, Tabs, Tag } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authorizedRequest } from '../../lib/api';
import { getBrief } from '../../lib/briefs';
import {
  createDistributionIdempotencyKey,
  createPrShareLink,
  generateDistributionVariants,
  isPreflightBlockedError,
  listArticleDistributions,
  listChannelConnections,
  publishDistributionTask,
  revokePrShareLink,
  runArticlePreflight,
  updateDistributionTask,
  type ArticleDistributionTaskItem,
} from '../../lib/distribution';
import { GatewayApiError, unwrapEnvelope } from '../../lib/envelope';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalPill, SignalSkeleton } from '../geo/primitives';

export type StudioDistributionDrawerProps = {
  open: boolean;
  brandId: string | null;
  brandMarketId: string | null;
  market: GeoMarket;
  contextEpoch: number;
  article: GeoArticleRecord | null;
  draftTitle: string;
  draftMarkdown: string;
  brandNames?: readonly string[];
  matchedFactCount?: number;
  evaluation?: GeoEvaluationResult | null;
  linkedBrief?: GeoBriefRecord | null;
  readOnly: boolean;
  walletAvailable?: number | null;
  onClose: () => void;
  onReturnToEditor: (code?: PreflightItemCode) => void;
  onNavigateBrands?: () => void;
  onRefreshWallet?: () => Promise<void> | void;
  onPublishRecordsSynced?: (articleId: string) => Promise<void> | void;
  onCreatePublishRecord?: (input: PublishRecordCreateInput) => Promise<boolean | void>;
};

type SelectableTargetOption = {
  key: string;
  group: 'L1' | 'L3_COMMUNITY' | 'L3_PR';
  provider: ChannelProvider;
  connectionId?: string;
  channelLabel: string;
  description: string;
  siteBaseUrl?: string;
  connectionStatus?: ChannelConnectionDto['status'];
  targetUrlHint?: string;
  recommendedPriority?: 'HIGH' | 'MEDIUM';
};

type VariantDraftState = {
  variantTitle: string;
  variantSlug: string;
  variantMetaDesc: string;
  variantMarkdown: string;
  connectionId: string | null;
};

type GeneratedPrShareInfo = {
  shareUrl: string;
  expiresAt: string;
};

type ParsedFactSheet = {
  brandName?: string;
  category?: string;
  targetPrompt?: string;
  keyAngles: string[];
  verifiedFacts: Array<{ title: string; summary: string }>;
  competitorComparisonAngles: string[];
};

const DEFAULT_GEO_VARIANT_UNIT_PRICE =
  PRICING_DEFAULTS.find((item) => item.action === 'geo_variant')?.unitPoints ?? 2;

function formatDrawerError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

function taskStatusTone(
  status: DistributionTaskStatus,
): 'cited' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'PUBLISHED':
      return 'cited';
    case 'PUBLISHING':
      return 'info';
    case 'DRAFT_PUSHED':
    case 'READY_TO_PUBLISH':
      return 'warning';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function parseFactSheet(extras: Record<string, unknown>): ParsedFactSheet | null {
  const raw = extras.factSheet;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const verifiedFacts: Array<{ title: string; summary: string }> = [];
  if (Array.isArray(obj.verifiedFacts)) {
    for (const item of obj.verifiedFacts) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.title === 'string' && typeof rec.summary === 'string') {
        verifiedFacts.push({ title: rec.title, summary: rec.summary });
      }
    }
  }
  return {
    brandName: typeof obj.brandName === 'string' ? obj.brandName : undefined,
    category: typeof obj.category === 'string' ? obj.category : undefined,
    targetPrompt: typeof obj.targetPrompt === 'string' ? obj.targetPrompt : undefined,
    keyAngles: readStringArray(obj.keyAngles),
    verifiedFacts,
    competitorComparisonAngles: readStringArray(obj.competitorComparisonAngles),
  };
}

function buildDraftFromTask(task: ArticleDistributionTaskItem): VariantDraftState {
  return {
    variantTitle: task.variantTitle,
    variantSlug: task.variantSlug ?? '',
    variantMetaDesc: task.variantMetaDesc ?? '',
    variantMarkdown: task.variantMarkdown,
    connectionId: task.connectionId,
  };
}

function findMatchingRecommendation(
  provider: ChannelProvider,
  recommendations: readonly GeoBriefChannelRecommendation[],
): GeoBriefChannelRecommendation | undefined {
  const direct = recommendations.find((r) => r.providerHint === provider);
  if (direct) return direct;
  const lower = (s: string) => s.toLowerCase();
  if (provider === 'REDDIT_ASSIST') {
    return recommendations.find((r) => lower(r.channel).includes('reddit'));
  }
  if (provider === 'QUORA_ASSIST') {
    return recommendations.find((r) => lower(r.channel).includes('quora'));
  }
  if (provider === 'SOCIAL_THREAD_ASSIST') {
    return recommendations.find(
      (r) =>
        lower(r.channel).includes('linkedin') ||
        lower(r.channel).includes('x') ||
        lower(r.channel).includes('twitter') ||
        r.channel.includes('社媒'),
    );
  }
  if (provider === 'CN_COMMUNITY_ASSIST') {
    return recommendations.find(
      (r) =>
        r.channel.includes('知乎') || r.channel.includes('值得买') || r.channel.includes('社区'),
    );
  }
  if (provider === 'PR_PACKET') {
    return recommendations.find(
      (r) =>
        lower(r.channel).includes('pr') ||
        lower(r.channel).includes('kol') ||
        r.channel.includes('媒体') ||
        r.channel.includes('评测'),
    );
  }
  return undefined;
}

async function fetchLiveGeoVariantUnitPrice(): Promise<number> {
  if (typeof window === 'undefined') return DEFAULT_GEO_VARIANT_UNIT_PRICE;
  try {
    const response = await authorizedRequest(window.sessionStorage, 'GET', '/pricing');
    const data = await unwrapEnvelope<{
      items: Array<{ action: string; unitPoints: number; enabled?: boolean }>;
    }>(response);
    const row = data.items.find((item) => item.action === 'geo_variant');
    if (
      row &&
      typeof row.unitPoints === 'number' &&
      Number.isFinite(row.unitPoints) &&
      row.unitPoints >= 0
    ) {
      return row.unitPoints;
    }
  } catch {
    // Fallback gracefully for expired/readOnly tenant (403) or network failure
  }
  return DEFAULT_GEO_VARIANT_UNIT_PRICE;
}

export function StudioDistributionDrawer({
  open,
  brandId,
  brandMarketId,
  market,
  contextEpoch,
  article,
  draftTitle,
  draftMarkdown,
  brandNames,
  matchedFactCount,
  evaluation,
  linkedBrief,
  readOnly,
  walletAvailable,
  onClose,
  onReturnToEditor,
  onNavigateBrands,
  onRefreshWallet,
  onPublishRecordsSynced,
  onCreatePublishRecord,
}: StudioDistributionDrawerProps): JSX.Element {
  const feedback = useUxFeedback();

  // Core drawer data
  const [hydrating, setHydrating] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<DistributionPreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [connections, setConnections] = useState<ChannelConnectionDto[]>([]);
  const [tasks, setTasks] = useState<ArticleDistributionTaskItem[]>([]);
  const [hydratedBrief, setHydratedBrief] = useState<GeoBriefRecord | null>(null);
  const [unitPrice, setUnitPrice] = useState<number>(DEFAULT_GEO_VARIANT_UNIT_PRICE);

  // Interactive workbench state
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<string[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [pointsConfirmOpen, setPointsConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [publishingTaskId, setPublishingTaskId] = useState<string | null>(null);
  const [publishBlockedNoticeByTask, setPublishBlockedNoticeByTask] = useState<
    Record<string, string>
  >({});
  const [prActionTaskId, setPrActionTaskId] = useState<string | null>(null);
  const [quickRegisteringTaskId, setQuickRegisteringTaskId] = useState<string | null>(null);

  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantDraftState>>({});
  const [generatedPrShareByTask, setGeneratedPrShareByTask] = useState<
    Record<string, GeneratedPrShareInfo>
  >({});
  const [quickRegisterUrls, setQuickRegisterUrls] = useState<Record<string, string>>({});
  const [checkedChecklistByTask, setCheckedChecklistByTask] = useState<Record<string, string[]>>(
    {},
  );

  const sessionSeqRef = useRef(0);
  const pollMutationEpochRef = useRef(0);
  const hydrateCtrlRef = useRef<AbortController | null>(null);
  const actionCtrlRef = useRef<AbortController | null>(null);
  const taskActionCtrlsRef = useRef<Set<AbortController>>(new Set());
  const pollCtrlRef = useRef<AbortController | null>(null);
  const prevPublishingIdsRef = useRef<Set<string>>(new Set());
  const generatingRef = useRef(false);
  const pendingVariantIdemKeyRef = useRef<string | null>(null);
  const publishingTasksRef = useRef<Set<string>>(new Set());
  const prActionTasksRef = useRef<Set<string>>(new Set());
  const savingTasksRef = useRef<Set<string>>(new Set());
  const quickRegisteringTasksRef = useRef<Set<string>>(new Set());

  const abortAllTaskActions = useCallback(() => {
    for (const ctrl of taskActionCtrlsRef.current) {
      ctrl.abort();
    }
    taskActionCtrlsRef.current.clear();
  }, []);

  const bumpPollEpoch = useCallback(() => {
    pollMutationEpochRef.current += 1;
    pollCtrlRef.current?.abort();
    pollCtrlRef.current = null;
  }, []);

  const resetAllDrawerState = useCallback(() => {
    hydrateCtrlRef.current?.abort();
    hydrateCtrlRef.current = null;
    actionCtrlRef.current?.abort();
    actionCtrlRef.current = null;
    abortAllTaskActions();
    bumpPollEpoch();
    sessionSeqRef.current += 1;
    prevPublishingIdsRef.current.clear();
    generatingRef.current = false;
    pendingVariantIdemKeyRef.current = null;
    publishingTasksRef.current.clear();
    prActionTasksRef.current.clear();
    savingTasksRef.current.clear();
    quickRegisteringTasksRef.current.clear();

    setHydrating(false);
    setDrawerError(null);
    setPreflight(null);
    setPreflightLoading(false);
    setConnections([]);
    setTasks([]);
    setHydratedBrief(null);
    setUnitPrice(DEFAULT_GEO_VARIANT_UNIT_PRICE);
    setSelectedTargetKeys([]);
    setActiveTaskId(null);
    setAckWarnings(false);
    setPointsConfirmOpen(false);
    setGenerating(false);
    setSavingTaskId(null);
    setPublishingTaskId(null);
    setPublishBlockedNoticeByTask({});
    setPrActionTaskId(null);
    setQuickRegisteringTaskId(null);
    setVariantDrafts({});
    setGeneratedPrShareByTask({});
    setQuickRegisterUrls({});
    setCheckedChecklistByTask({});
  }, [abortAllTaskActions, bumpPollEpoch]);

  const syncTasksState = useCallback((nextTasks: ArticleDistributionTaskItem[]) => {
    setTasks(nextTasks);
    setVariantDrafts((prev) => {
      const next: Record<string, VariantDraftState> = {};
      for (const t of nextTasks) {
        next[t.id] = prev[t.id] ?? buildDraftFromTask(t);
      }
      return next;
    });
    setActiveTaskId((prev) => {
      if (prev && nextTasks.some((t) => t.id === prev)) return prev;
      return nextTasks[0]?.id ?? null;
    });
  }, []);

  const buildLocalPreflightFallback = useCallback((): DistributionPreflightResult | null => {
    if (!article) return null;
    return evaluateDistributionPreflight({
      market,
      title: draftTitle || article.title,
      contentMarkdown: draftMarkdown || article.contentMarkdown,
      brandNames,
      complianceFlags: article.complianceFlags,
      geoScore: evaluation?.geoScore ?? article.geoScore,
      matchedFactCount,
    });
  }, [
    article,
    brandNames,
    draftMarkdown,
    draftTitle,
    evaluation?.geoScore,
    market,
    matchedFactCount,
  ]);

  const reloadConnections = useCallback(async () => {
    if (!open || !brandId || !brandMarketId) return;
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    taskActionCtrlsRef.current.add(ctrl);
    try {
      const res = await listChannelConnections(brandId, market, {
        storage: window.sessionStorage,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      setConnections(res.items);
    } catch {
      // Non-blocking silent refresh
    } finally {
      taskActionCtrlsRef.current.delete(ctrl);
    }
  }, [brandId, brandMarketId, market, open]);

  // Ensure unmount always invalidates active session and aborts all in-flight work
  useEffect(() => {
    const publishingTasks = publishingTasksRef.current;
    const prActionTasks = prActionTasksRef.current;
    const savingTasks = savingTasksRef.current;
    const quickRegisteringTasks = quickRegisteringTasksRef.current;
    return () => {
      sessionSeqRef.current += 1;
      generatingRef.current = false;
      pendingVariantIdemKeyRef.current = null;
      publishingTasks.clear();
      prActionTasks.clear();
      savingTasks.clear();
      quickRegisteringTasks.clear();
      hydrateCtrlRef.current?.abort();
      hydrateCtrlRef.current = null;
      actionCtrlRef.current?.abort();
      actionCtrlRef.current = null;
      abortAllTaskActions();
      bumpPollEpoch();
    };
  }, [abortAllTaskActions, bumpPollEpoch]);

  // Full reset whenever context or article changes, or drawer closes
  useEffect(() => {
    if (!open || !article) {
      resetAllDrawerState();
      return undefined;
    }

    resetAllDrawerState();
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    hydrateCtrlRef.current = ctrl;
    setHydrating(true);
    setPreflightLoading(true);

    const effectiveTitle = draftTitle || article.title;
    const effectiveMarkdown = draftMarkdown || article.contentMarkdown;
    const reqOpts = { storage: window.sessionStorage, signal: ctrl.signal };

    const preflightPromise = readOnly
      ? Promise.resolve(buildLocalPreflightFallback())
      : runArticlePreflight(
          article.id,
          { title: effectiveTitle, contentMarkdown: effectiveMarkdown },
          reqOpts,
        ).catch(() => buildLocalPreflightFallback());

    const distributionsPromise = listArticleDistributions(article.id, reqOpts);

    const connectionsPromise =
      brandId && brandMarketId
        ? listChannelConnections(brandId, market, reqOpts)
        : Promise.resolve({ items: [] as ChannelConnectionDto[] });

    const briefPromise =
      article.briefId && linkedBrief?.id !== article.briefId
        ? getBrief(article.briefId, reqOpts).catch(() => null)
        : Promise.resolve(null);

    const pricingPromise = readOnly
      ? Promise.resolve(DEFAULT_GEO_VARIANT_UNIT_PRICE)
      : fetchLiveGeoVariantUnitPrice();

    void Promise.allSettled([
      preflightPromise,
      distributionsPromise,
      connectionsPromise,
      briefPromise,
      pricingPromise,
    ]).then(([preflightRes, distRes, connRes, briefRes, priceRes]) => {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;

      if (preflightRes.status === 'fulfilled' && preflightRes.value) {
        setPreflight(preflightRes.value);
      } else {
        setPreflight(buildLocalPreflightFallback());
      }
      setPreflightLoading(false);

      if (distRes.status === 'fulfilled') {
        bumpPollEpoch();
        syncTasksState(distRes.value.items);
        prevPublishingIdsRef.current = new Set(
          distRes.value.items.filter((t) => t.status === 'PUBLISHING').map((t) => t.id),
        );
      } else {
        setDrawerError(formatDrawerError(distRes.reason, '加载已有渠道变体失败'));
      }

      if (connRes.status === 'fulfilled') {
        setConnections(connRes.value.items);
      }

      if (briefRes.status === 'fulfilled' && briefRes.value) {
        setHydratedBrief(briefRes.value);
      }

      if (priceRes.status === 'fulfilled' && typeof priceRes.value === 'number') {
        setUnitPrice(priceRes.value);
      }

      setHydrating(false);
    });

    return () => {
      sessionSeqRef.current += 1;
      ctrl.abort();
      actionCtrlRef.current?.abort();
      actionCtrlRef.current = null;
      abortAllTaskActions();
      bumpPollEpoch();
    };
    // Hydrate strictly when drawer opens or article/context identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brandId, brandMarketId, market, contextEpoch, article?.id]);

  useTabFreshness({
    active: open && Boolean(brandId && brandMarketId),
    domains: ['channel-connections'],
    refreshOnActivate: false,
    onRefresh: () => {
      void reloadConnections();
    },
  });

  // Poll PUBLISHING tasks via useTaskPolling (NEVER raw setInterval)
  const hasPublishingTask = useMemo(
    () => tasks.some((item) => item.status === 'PUBLISHING'),
    [tasks],
  );

  useTaskPolling({
    enabled: open && Boolean(article?.id) && hasPublishingTask,
    active: open,
    intervalMs: 2_500,
    onPoll: async () => {
      if (!article) return;
      const seq = sessionSeqRef.current;
      const pollEpoch = pollMutationEpochRef.current;
      pollCtrlRef.current?.abort();
      const pollCtrl = new AbortController();
      pollCtrlRef.current = pollCtrl;
      try {
        const res = await listArticleDistributions(article.id, {
          storage: window.sessionStorage,
          signal: pollCtrl.signal,
        });
        if (
          pollCtrl.signal.aborted ||
          seq !== sessionSeqRef.current ||
          pollEpoch !== pollMutationEpochRef.current
        ) {
          return;
        }

        const prevPublishing = prevPublishingIdsRef.current;
        let publishedJustCompleted = false;
        let draftPushCompleted = false;
        const failedMessages: string[] = [];

        for (const item of res.items) {
          if (prevPublishing.has(item.id) && item.status !== 'PUBLISHING') {
            if (item.status === 'PUBLISHED') {
              publishedJustCompleted = true;
            } else if (item.status === 'DRAFT_PUSHED') {
              draftPushCompleted = true;
            } else if (item.status === 'FAILED') {
              failedMessages.push(item.lastError || `「${item.channelLabel}」推送失败`);
            }
          }
        }

        prevPublishingIdsRef.current = new Set(
          res.items.filter((t) => t.status === 'PUBLISHING').map((t) => t.id),
        );
        syncTasksState(res.items);

        if (publishedJustCompleted) {
          feedback.notifySuccess('已上线发布，已自动同步至发布记录并排期 T+7/14/30 复测');
          invalidateFreshness('publish-records', 'distributions', 'articles');
          void onPublishRecordsSynced?.(article.id);
          void onRefreshWallet?.();
        }
        if (draftPushCompleted) {
          feedback.notifySuccess('草稿已推送至目标站点后台，可点击管理页链接审核上线');
          if (!publishedJustCompleted) {
            invalidateFreshness('distributions');
          }
        }
        if (failedMessages.length > 0) {
          for (const msg of failedMessages) {
            feedback.notifyError(msg);
          }
          if (!publishedJustCompleted && !draftPushCompleted) {
            invalidateFreshness('distributions');
          }
        }
      } catch {
        // Silent retry on next polling tick
      } finally {
        if (pollCtrlRef.current === pollCtrl) {
          pollCtrlRef.current = null;
        }
      }
    },
  });

  const effectiveRecommendedChannels = useMemo<readonly GeoBriefChannelRecommendation[]>(() => {
    if (hydratedBrief?.recommendedChannels && hydratedBrief.recommendedChannels.length > 0) {
      return hydratedBrief.recommendedChannels;
    }
    if (linkedBrief?.recommendedChannels && linkedBrief.recommendedChannels.length > 0) {
      return linkedBrief.recommendedChannels;
    }
    if (evaluation?.recommendedChannels && evaluation.recommendedChannels.length > 0) {
      return evaluation.recommendedChannels;
    }
    return buildRecommendedChannelsForMarket(market);
  }, [
    evaluation?.recommendedChannels,
    hydratedBrief?.recommendedChannels,
    linkedBrief?.recommendedChannels,
    market,
  ]);

  const targetOptions = useMemo<SelectableTargetOption[]>(() => {
    const list: SelectableTargetOption[] = [];

    // Group 1: Connected L1 Official Sites
    for (const conn of connections) {
      if (conn.status === 'DISABLED') continue;
      list.push({
        key: `l1:${conn.id}`,
        group: 'L1',
        provider: conn.provider,
        connectionId: conn.id,
        channelLabel: conn.displayName,
        description: CHANNEL_PROVIDER_LABELS[conn.provider] ?? conn.provider,
        siteBaseUrl: conn.siteBaseUrl,
        connectionStatus: conn.status,
      });
    }

    // Group 2: L3 Community Assist (Market-specific, human-assist only)
    const communityProviders: ChannelProvider[] =
      market === 'GLOBAL'
        ? ['REDDIT_ASSIST', 'QUORA_ASSIST', 'SOCIAL_THREAD_ASSIST']
        : ['CN_COMMUNITY_ASSIST'];

    for (const provider of communityProviders) {
      const rec = findMatchingRecommendation(provider, effectiveRecommendedChannels);
      const firstSafeCitedUrl = rec?.citedExampleUrls?.find((u) => isSafeDistributionHttpUrl(u));
      list.push({
        key: `l3:${provider}`,
        group: 'L3_COMMUNITY',
        provider,
        channelLabel: CHANNEL_PROVIDER_LABELS[provider],
        description:
          provider === 'CN_COMMUNITY_ASSIST'
            ? '生成知乎 / 什么值得买去广告评测讨论稿，人工合规辅发 · 不自动发帖'
            : '生成去营销高价值讨论稿与防封自检清单，人工合规辅发 · 不自动发帖',
        targetUrlHint: firstSafeCitedUrl,
        recommendedPriority: rec?.priority,
      });
    }

    // Group 3: L3 External PR / KOL Media Packet
    const prRec = findMatchingRecommendation('PR_PACKET', effectiveRecommendedChannels);
    list.push({
      key: 'l3:PR_PACKET',
      group: 'L3_PR',
      provider: 'PR_PACKET',
      channelLabel: CHANNEL_PROVIDER_LABELS.PR_PACKET,
      description: '生成结构化 Fact Sheet 与 30 天免登录外部供稿页，支持媒体 / KOL 回传上线链接',
      recommendedPriority: prRec?.priority,
    });

    return list;
  }, [connections, effectiveRecommendedChannels, market]);

  const selectedTargets = useMemo(
    () => targetOptions.filter((opt) => selectedTargetKeys.includes(opt.key)),
    [selectedTargetKeys, targetOptions],
  );

  const toggleTargetKey = (key: string) => {
    pendingVariantIdemKeyRef.current = null;
    setSelectedTargetKeys((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  };

  const handleRerunPreflight = async () => {
    if (!article) return;
    setPublishBlockedNoticeByTask({});
    if (readOnly) {
      const fallback = buildLocalPreflightFallback();
      if (fallback) {
        setPreflight(fallback);
        if (fallback.ok) {
          feedback.notifySuccess('发布前体检已通过');
        } else {
          feedback.notifyWarning(`检测到 ${fallback.blockers.length} 项发布前硬拦截项`);
        }
      }
      return;
    }
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    taskActionCtrlsRef.current.add(ctrl);
    setPreflightLoading(true);
    try {
      const res = await runArticlePreflight(
        article.id,
        {
          title: draftTitle || article.title,
          contentMarkdown: draftMarkdown || article.contentMarkdown,
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      setPreflight(res);
      if (res.ok) {
        feedback.notifySuccess('发布前体检已通过');
      } else {
        feedback.notifyWarning(`检测到 ${res.blockers.length} 项发布前硬拦截项`);
      }
    } catch {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      const fallback = buildLocalPreflightFallback();
      if (fallback) setPreflight(fallback);
    } finally {
      taskActionCtrlsRef.current.delete(ctrl);
      if (!ctrl.signal.aborted && seq === sessionSeqRef.current) {
        setPreflightLoading(false);
      }
    }
  };

  const handleConfirmGenerateVariants = async () => {
    if (!article || selectedTargets.length === 0 || readOnly || generatingRef.current) return;
    generatingRef.current = true;
    const ctrl = new AbortController();
    actionCtrlRef.current = ctrl;
    const seq = sessionSeqRef.current;
    bumpPollEpoch();

    const payloadTargets: DistributionVariantTargetInput[] = selectedTargets.map((opt) => ({
      provider: opt.provider,
      ...(opt.connectionId ? { connectionId: opt.connectionId } : {}),
      channelLabel: opt.channelLabel,
      ...(opt.targetUrlHint ? { targetUrlHint: opt.targetUrlHint } : {}),
      templateKey: defaultTemplateKeyForProvider(opt.provider),
    }));

    setGenerating(true);
    setDrawerError(null);
    try {
      const idempotencyKey =
        pendingVariantIdemKeyRef.current ?? createDistributionIdempotencyKey('var');
      pendingVariantIdemKeyRef.current = idempotencyKey;
      const res = await generateDistributionVariants(
        article.id,
        { targets: payloadTargets },
        { storage: window.sessionStorage, signal: ctrl.signal, idempotencyKey },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;

      pendingVariantIdemKeyRef.current = null;
      if (typeof res.unitPrice === 'number' && Number.isFinite(res.unitPrice)) {
        setUnitPrice(res.unitPrice);
      }
      setPointsConfirmOpen(false);
      setSelectedTargetKeys([]);
      bumpPollEpoch();

      // Reload authoritative list (includes publishRecords relation)
      try {
        const refreshed = await listArticleDistributions(article.id, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
        bumpPollEpoch();
        syncTasksState(refreshed.items);
        if (res.tasks[0]?.id) {
          setActiveTaskId(res.tasks[0].id);
        }
      } catch {
        if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
        bumpPollEpoch();
        const appended: ArticleDistributionTaskItem[] = res.tasks.map((t) => ({
          ...t,
          publishRecords: [],
        }));
        setTasks((prev) => [
          ...appended,
          ...prev.filter((old) => !appended.some((a) => a.id === old.id)),
        ]);
        setVariantDrafts((prev) => {
          const next = { ...prev };
          for (const t of appended) {
            next[t.id] = prev[t.id] ?? buildDraftFromTask(t);
          }
          return next;
        });
        if (appended[0]?.id) setActiveTaskId(appended[0].id);
      }

      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;

      invalidateFreshness('distributions', 'points');
      void onRefreshWallet?.();

      if (res.failures.length > 0) {
        feedback.notifyWarning(
          `已生成 ${res.tasks.length} 个渠道变体，${res.failures.length} 个失败${res.refundedPoints > 0 ? `（已自动退还 ${res.refundedPoints} 点）` : ''}`,
        );
      } else {
        feedback.notifySuccess(`已成功生成 ${res.tasks.length} 个渠道变体`);
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      const msg = formatDrawerError(err, '生成渠道变体失败');
      setDrawerError(msg);
      feedback.notifyError(msg);
    } finally {
      if (actionCtrlRef.current === ctrl) {
        actionCtrlRef.current = null;
      }
      if (seq === sessionSeqRef.current) {
        generatingRef.current = false;
        if (!ctrl.signal.aborted) {
          setGenerating(false);
        }
      }
    }
  };

  const handleSaveVariantDraft = async (task: ArticleDistributionTaskItem) => {
    const draft = variantDrafts[task.id];
    if (!draft || readOnly || savingTasksRef.current.has(task.id)) return;
    savingTasksRef.current.add(task.id);
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    taskActionCtrlsRef.current.add(ctrl);
    bumpPollEpoch();
    setSavingTaskId(task.id);
    setDrawerError(null);
    try {
      const updated = await updateDistributionTask(
        task.id,
        {
          variantTitle: draft.variantTitle.trim() || task.variantTitle,
          variantMarkdown: draft.variantMarkdown,
          ...(task.mode === 'L1_API'
            ? {
                variantSlug: draft.variantSlug.trim() || null,
                variantMetaDesc: draft.variantMetaDesc.trim() || null,
                connectionId: draft.connectionId,
              }
            : {}),
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      bumpPollEpoch();
      setTasks((prev) =>
        prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      if (updated.preflightJson) {
        setPreflight(updated.preflightJson);
      }
      invalidateFreshness('distributions');
      feedback.notifySuccess(`已保存「${task.channelLabel}」变体修改`);
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      const msg = formatDrawerError(err, '保存变体修改失败');
      setDrawerError(msg);
      feedback.notifyError(msg);
    } finally {
      taskActionCtrlsRef.current.delete(ctrl);
      if (seq === sessionSeqRef.current) {
        savingTasksRef.current.delete(task.id);
        if (!ctrl.signal.aborted) {
          setSavingTaskId((prev) => (prev === task.id ? null : prev));
        }
      }
    }
  };

  const handlePublishL1 = async (task: ArticleDistributionTaskItem, publishAsDraft: boolean) => {
    if (!article || readOnly || publishingTasksRef.current.has(task.id)) return;
    publishingTasksRef.current.add(task.id);
    const draft = variantDrafts[task.id];
    const targetConnectionId = draft?.connectionId ?? task.connectionId ?? undefined;
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    taskActionCtrlsRef.current.add(ctrl);
    bumpPollEpoch();
    setPublishingTaskId(task.id);
    setPublishBlockedNoticeByTask((prev) => {
      if (!(task.id in prev)) return prev;
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    setDrawerError(null);

    try {
      const updated = await publishDistributionTask(
        task.id,
        {
          publishAsDraft,
          ...(targetConnectionId ? { connectionId: targetConnectionId } : {}),
          acknowledgePreflightWarnings: ackWarnings,
        },
        {
          storage: window.sessionStorage,
          signal: ctrl.signal,
          idempotencyKey: createDistributionIdempotencyKey('pub'),
        },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;

      bumpPollEpoch();
      if (updated.status === 'PUBLISHING') {
        prevPublishingIdsRef.current.add(updated.id);
      }

      setTasks((prev) =>
        prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      invalidateFreshness('distributions');

      if (updated.status === 'PUBLISHED') {
        feedback.notifySuccess('已上线发布，正在同步发布记录');
        invalidateFreshness('publish-records', 'articles');
        void onPublishRecordsSynced?.(article.id);
        void onRefreshWallet?.();
      } else if (updated.status === 'DRAFT_PUSHED') {
        feedback.notifySuccess('已推送为站点草稿');
      } else {
        feedback.notifySuccess(
          publishAsDraft
            ? '已提交草稿推送任务，正在同步状态…'
            : '已提交正式发布任务，正在同步状态…',
        );
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      if (isPreflightBlockedError(err)) {
        const nextPreflight: DistributionPreflightResult = err.preflight ?? {
          ok: false,
          blockers: err.blockers,
          warnings: err.warnings,
        };
        setPreflight(nextPreflight);
        setPublishBlockedNoticeByTask((prev) => ({
          ...prev,
          [task.id]:
            err.message || '发布前校验未通过，请先返回编辑器补填缺失事实，或勾选风险确认后再推送。',
        }));
        feedback.notifyWarning('发布已被体检门禁拦截，请查看 Step 1 拦截明细');
        return;
      }
      const msg = formatDrawerError(err, '触发站点推送失败');
      setDrawerError(msg);
      feedback.notifyError(msg);
    } finally {
      taskActionCtrlsRef.current.delete(ctrl);
      if (seq === sessionSeqRef.current) {
        publishingTasksRef.current.delete(task.id);
        if (!ctrl.signal.aborted) {
          setPublishingTaskId((prev) => (prev === task.id ? null : prev));
        }
      }
    }
  };

  const handleQuickRegisterUrl = async (task: ArticleDistributionTaskItem) => {
    if (
      !article ||
      readOnly ||
      !onCreatePublishRecord ||
      quickRegisteringTasksRef.current.has(task.id)
    ) {
      return;
    }
    const rawUrl = (quickRegisterUrls[task.id] ?? '').trim();
    if (!isSafeDistributionHttpUrl(rawUrl)) {
      feedback.notifyWarning('请输入有效的 http:// 或 https:// 已发链接');
      return;
    }
    quickRegisteringTasksRef.current.add(task.id);
    const seq = sessionSeqRef.current;
    setQuickRegisteringTaskId(task.id);
    try {
      const ok = await onCreatePublishRecord({
        channel: task.channelLabel.trim().slice(0, 60),
        publishedUrl: rawUrl,
        autoRetest: { enabled: true },
      });
      if (seq !== sessionSeqRef.current) return;
      if (ok !== false) {
        setQuickRegisterUrls((prev) => ({ ...prev, [task.id]: '' }));
        invalidateFreshness('publish-records', 'distributions', 'articles');
        void onPublishRecordsSynced?.(article.id);
      }
    } finally {
      if (seq === sessionSeqRef.current) {
        quickRegisteringTasksRef.current.delete(task.id);
        setQuickRegisteringTaskId((prev) => (prev === task.id ? null : prev));
      }
    }
  };

  const handleCreatePrShare = async (task: ArticleDistributionTaskItem) => {
    if (readOnly || prActionTasksRef.current.has(task.id)) return;
    prActionTasksRef.current.add(task.id);
    const seq = sessionSeqRef.current;
    const ctrl = new AbortController();
    taskActionCtrlsRef.current.add(ctrl);
    bumpPollEpoch();
    setPrActionTaskId(task.id);
    setDrawerError(null);
    try {
      const res = await createPrShareLink(
        task.id,
        { ttlDays: 30 },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      bumpPollEpoch();
      setGeneratedPrShareByTask((prev) => ({
        ...prev,
        [task.id]: { shareUrl: res.shareUrl, expiresAt: res.expiresAt },
      }));
      setTasks((prev) =>
        prev.map((item) =>
          item.id === task.id
            ? { ...item, shareLinkActive: true, shareExpiresAt: res.expiresAt }
            : item,
        ),
      );
      invalidateFreshness('distributions');
      feedback.notifySuccess('已生成 30 天免登录外部供稿链接');
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      const msg = formatDrawerError(err, '生成外部供稿链接失败');
      setDrawerError(msg);
      feedback.notifyError(msg);
    } finally {
      taskActionCtrlsRef.current.delete(ctrl);
      if (seq === sessionSeqRef.current) {
        prActionTasksRef.current.delete(task.id);
        if (!ctrl.signal.aborted) {
          setPrActionTaskId((prev) => (prev === task.id ? null : prev));
        }
      }
    }
  };

  const handleRevokePrShare = (task: ArticleDistributionTaskItem) => {
    if (readOnly || prActionTasksRef.current.has(task.id)) return;
    const seq = sessionSeqRef.current;
    feedback.confirm({
      title: '确认撤销外部供稿链接？',
      content: '撤销后该免登录链接将立即返回 404，外部媒体或 KOL 将无法继续打开或回传链接。',
      okText: '确认撤销',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (seq !== sessionSeqRef.current || prActionTasksRef.current.has(task.id)) return;
        prActionTasksRef.current.add(task.id);
        const ctrl = new AbortController();
        taskActionCtrlsRef.current.add(ctrl);
        bumpPollEpoch();
        setPrActionTaskId(task.id);
        try {
          await revokePrShareLink(task.id, {
            storage: window.sessionStorage,
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
          bumpPollEpoch();
          setGeneratedPrShareByTask((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
          setTasks((prev) =>
            prev.map((item) =>
              item.id === task.id
                ? { ...item, shareLinkActive: false, shareExpiresAt: null }
                : item,
            ),
          );
          invalidateFreshness('distributions');
          feedback.notifySuccess('已撤销外部供稿链接');
        } catch (err) {
          if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
          feedback.notifyError(formatDrawerError(err, '撤销供稿链接失败'));
        } finally {
          taskActionCtrlsRef.current.delete(ctrl);
          if (seq === sessionSeqRef.current) {
            prActionTasksRef.current.delete(task.id);
            if (!ctrl.signal.aborted) {
              setPrActionTaskId((prev) => (prev === task.id ? null : prev));
            }
          }
        }
      },
    });
  };

  const totalEstimatedPoints = selectedTargets.length * unitPrice;
  const l1Options = targetOptions.filter((o) => o.group === 'L1');
  const communityOptions = targetOptions.filter((o) => o.group === 'L3_COMMUNITY');
  const prOptions = targetOptions.filter((o) => o.group === 'L3_PR');

  const renderTaskEditorBody = (task: ArticleDistributionTaskItem) => {
    const draft = variantDrafts[task.id] ?? buildDraftFromTask(task);
    const isTaskLocked =
      readOnly ||
      task.status === 'PUBLISHING' ||
      task.status === 'PUBLISHED' ||
      task.status === 'ARCHIVED';
    const matchingL1Connections = connections.filter(
      (c) => c.provider === task.provider && c.status !== 'DISABLED',
    );
    const rawSelectedConnId = draft.connectionId ?? null;
    const boundConnection = rawSelectedConnId
      ? (connections.find((c) => c.id === rawSelectedConnId) ?? null)
      : null;
    const hasActiveBoundConn = Boolean(
      rawSelectedConnId && matchingL1Connections.some((c) => c.id === rawSelectedConnId),
    );
    const disabledBoundConn =
      !hasActiveBoundConn &&
      boundConnection &&
      boundConnection.provider === task.provider &&
      boundConnection.status === 'DISABLED'
        ? boundConnection
        : null;
    const missingBoundConn = Boolean(
      rawSelectedConnId && !hasActiveBoundConn && !disabledBoundConn,
    );
    const l1ConnectionOptions = [
      ...matchingL1Connections.map((c) => ({
        value: c.id,
        label: `${c.displayName} (${c.siteBaseUrl})`,
        disabled: false,
      })),
      ...(disabledBoundConn
        ? [
            {
              value: disabledBoundConn.id,
              label: `${disabledBoundConn.displayName}（已停用）`,
              disabled: true,
            },
          ]
        : []),
    ];
    const safeSelectedConnValue = hasActiveBoundConn
      ? (rawSelectedConnId ?? undefined)
      : disabledBoundConn
        ? disabledBoundConn.id
        : undefined;
    const extras = task.variantExtrasJson ?? {};
    const antiBanChecklist = readStringArray(extras.antiBanChecklist);
    const threadPosts = readStringArray(extras.threadPosts);
    const targetThreadUrls = [
      ...new Set([
        ...readStringArray(extras.targetThreadUrls),
        ...(task.targetUrlHint ? [task.targetUrlHint] : []),
      ]),
    ].filter((u) => isSafeDistributionHttpUrl(u));
    const factSheet = parseFactSheet(extras);
    const generatedShare = generatedPrShareByTask[task.id];
    const checkedItems = checkedChecklistByTask[task.id] ?? [];
    const taskPublishBlockedNotice = publishBlockedNoticeByTask[task.id] ?? null;

    const updateDraftField = <K extends keyof VariantDraftState>(
      key: K,
      value: VariantDraftState[K],
    ) => {
      setVariantDrafts((prev) => ({
        ...prev,
        [task.id]: {
          ...(prev[task.id] ?? buildDraftFromTask(task)),
          [key]: value,
        },
      }));
    };

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        {/* Task Header Status Bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 'var(--gm-radius-sm)',
            border: '1px solid var(--gm-line-1)',
            background: 'var(--gm-bg-base)',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Tag color="geekblue" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {CHANNEL_PROVIDER_LABELS[task.provider] ?? task.provider}
            </Tag>
            <SignalPill tone={taskStatusTone(task.status)}>
              {DISTRIBUTION_TASK_STATUS_LABELS[task.status]}
            </SignalPill>
            {task.indexNowStatus ? (
              <Tag color="cyan" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                IndexNow: {task.indexNowStatus}
              </Tag>
            ) : null}
          </div>
          {task.publishedAt ? (
            <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
              发布于 {formatShanghaiDateTime(task.publishedAt)}
            </span>
          ) : null}
        </div>

        {task.status === 'PUBLISHING' ? (
          <Alert
            type="info"
            showIcon
            message="正在通过官方 API 推送至目标站点，系统将自动轮询同步最新状态…"
          />
        ) : null}

        {task.lastError ? (
          <Alert
            type="error"
            showIcon
            message="上次推送失败"
            description={task.lastError}
            style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          />
        ) : null}

        {taskPublishBlockedNotice && task.mode === 'L1_API' ? (
          <Alert
            type="error"
            showIcon
            message="推送被发布前体检门禁拦截"
            description={taskPublishBlockedNotice}
            style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            action={
              <Button
                size="small"
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => onReturnToEditor(preflight?.blockers[0]?.code)}
              >
                返回编辑器补填
              </Button>
            }
          />
        ) : null}

        {/* Remote Links (Admin Draft & Published URL) */}
        {(task.remoteAdminUrl && isSafeDistributionHttpUrl(task.remoteAdminUrl)) ||
        (task.remotePublishedUrl && isSafeDistributionHttpUrl(task.remotePublishedUrl)) ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              padding: '8px 12px',
              borderRadius: 'var(--gm-radius-sm)',
              border: '1px solid var(--gm-line-2)',
              background: 'var(--gm-bg-elevated)',
              fontSize: 12,
            }}
          >
            {task.remoteAdminUrl && isSafeDistributionHttpUrl(task.remoteAdminUrl) ? (
              <a
                href={task.remoteAdminUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--gm-info)', overflowWrap: 'anywhere' }}
              >
                打开站点后台草稿 / 管理页 ↗
              </a>
            ) : null}
            {task.remotePublishedUrl && isSafeDistributionHttpUrl(task.remotePublishedUrl) ? (
              <a
                href={task.remotePublishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--gm-success)', overflowWrap: 'anywhere' }}
              >
                查看已上线公开文章 ↗
              </a>
            ) : null}
          </div>
        ) : null}

        {/* Editable Variant Fields */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>变体标题</div>
          <Input
            aria-label="变体标题"
            disabled={isTaskLocked}
            value={draft.variantTitle}
            onChange={(e) => updateDraftField('variantTitle', e.target.value)}
          />
        </div>

        {task.mode === 'L1_API' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                URL Slug（英文短链）
              </div>
              <Input
                aria-label="URL Slug"
                disabled={isTaskLocked}
                placeholder="例如：best-quiet-4-bay-nas-2026"
                value={draft.variantSlug}
                onChange={(e) => updateDraftField('variantSlug', e.target.value)}
              />
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                目标站点连接
              </div>
              <Select
                aria-label="目标站点连接"
                style={{ width: '100%' }}
                disabled={isTaskLocked || matchingL1Connections.length === 0}
                placeholder={
                  missingBoundConn ? '原绑定连接已删除，请重新选择可用连接' : '选择已绑定的站点连接'
                }
                value={safeSelectedConnValue}
                options={l1ConnectionOptions}
                onChange={(val) =>
                  updateDraftField('connectionId', typeof val === 'string' ? val : null)
                }
              />
              {disabledBoundConn || missingBoundConn ? (
                <div style={{ fontSize: 11, color: 'var(--gm-warning)', marginTop: 4 }}>
                  原绑定连接已停用或删除，请重新选择可用连接
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {task.mode === 'L1_API' ? (
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'var(--gm-fg-2)',
                marginBottom: 4,
              }}
            >
              <span>摘要描述（Meta Description）</span>
              <span className="gm-num" style={{ color: 'var(--gm-fg-3)' }}>
                {draft.variantMetaDesc.length} / 160 字
              </span>
            </div>
            <Input.TextArea
              aria-label="摘要描述"
              rows={2}
              maxLength={320}
              disabled={isTaskLocked}
              placeholder="建议 140–160 字符，直接概述核心数据与结论"
              value={draft.variantMetaDesc}
              onChange={(e) => updateDraftField('variantMetaDesc', e.target.value)}
            />
          </div>
        ) : null}

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
            变体正文（Markdown）
          </div>
          <Input.TextArea
            aria-label="变体正文 Markdown"
            rows={7}
            disabled={isTaskLocked}
            value={draft.variantMarkdown}
            onChange={(e) => updateDraftField('variantMarkdown', e.target.value)}
          />
        </div>

        {/* Save Variant Button + Provider-Specific Actions */}
        {task.mode === 'L1_API' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Button
              data-testid="distribution-save-variant-btn"
              loading={savingTaskId === task.id}
              disabled={isTaskLocked}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => void handleSaveVariantDraft(task)}
            >
              保存变体修改
            </Button>
            <Button
              data-testid="distribution-publish-draft-btn"
              loading={publishingTaskId === task.id}
              disabled={
                readOnly ||
                task.status === 'PUBLISHING' ||
                task.status === 'PUBLISHED' ||
                task.status === 'ARCHIVED'
              }
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => void handlePublishL1(task, true)}
            >
              推送为草稿（推荐）
            </Button>
            <Button
              type="primary"
              data-testid="distribution-publish-live-btn"
              loading={publishingTaskId === task.id}
              disabled={
                readOnly ||
                task.status === 'PUBLISHING' ||
                task.status === 'PUBLISHED' ||
                task.status === 'ARCHIVED'
              }
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => void handlePublishL1(task, false)}
            >
              立即上线发布
            </Button>
          </div>
        ) : null}

        {task.mode === 'L3_COMMUNITY_ASSIST' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 12,
              borderRadius: 'var(--gm-radius-md)',
              border: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-base)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              <Button
                type="primary"
                data-testid="distribution-copy-community-btn"
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => {
                  void copyTextToClipboard(draft.variantMarkdown).then((ok) => {
                    if (ok) feedback.notifySuccess('已复制去营销讨论稿');
                    else feedback.notifyError('复制失败，请检查剪贴板权限');
                  });
                }}
              >
                一键复制去营销讨论稿
              </Button>
            </div>

            {targetThreadUrls.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  打开高频被引原帖（人工参与讨论）
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {targetThreadUrls.map((url, idx) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gm-mono"
                      style={{
                        fontSize: 12,
                        color: 'var(--gm-info)',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      打开高频被引原帖 #{idx + 1} ↗
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            {threadPosts.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  分条社媒长帖（共 {threadPosts.length} 条）
                </div>
                {threadPosts.map((post, idx) => (
                  <div
                    key={`${idx}-${post.slice(0, 16)}`}
                    style={{
                      padding: 8,
                      borderRadius: 'var(--gm-radius-sm)',
                      border: '1px solid var(--gm-line-1)',
                      background: 'var(--gm-bg-elevated)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        flex: '1 1 240px',
                        minWidth: 0,
                        fontSize: 12,
                        color: 'var(--gm-fg-2)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {post}
                    </div>
                    <Button
                      size="small"
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      onClick={() => {
                        void copyTextToClipboard(post).then((ok) => {
                          if (ok) feedback.notifySuccess(`已复制第 ${idx + 1} 条分帖`);
                        });
                      }}
                    >
                      复制
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {antiBanChecklist.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  社区合规防封自检清单
                </div>
                {antiBanChecklist.map((item) => {
                  const isChecked = checkedItems.includes(item);
                  return (
                    <Checkbox
                      key={item}
                      checked={isChecked}
                      onChange={(e) => {
                        setCheckedChecklistByTask((prev) => {
                          const cur = prev[task.id] ?? [];
                          return {
                            ...prev,
                            [task.id]: e.target.checked
                              ? [...new Set([...cur, item])]
                              : cur.filter((x) => x !== item),
                          };
                        });
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>{item}</span>
                    </Checkbox>
                  );
                })}
              </div>
            ) : null}

            {/* Quick Register Published URL */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                发布后快速登记链接（自动开启 T+7/14/30 定时复测）
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Input
                  aria-label="已发布社区链接"
                  style={{ flex: '1 1 240px', minWidth: 0 }}
                  disabled={readOnly}
                  placeholder="粘贴人工发帖后的公开链接，例如 https://www.reddit.com/r/..."
                  value={quickRegisterUrls[task.id] ?? ''}
                  onChange={(e) =>
                    setQuickRegisterUrls((prev) => ({ ...prev, [task.id]: e.target.value }))
                  }
                />
                <Button
                  type="primary"
                  data-testid="distribution-quick-register-btn"
                  loading={quickRegisteringTaskId === task.id}
                  disabled={readOnly || !(quickRegisterUrls[task.id] ?? '').trim()}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => void handleQuickRegisterUrl(task)}
                >
                  登记已发链接
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {task.mode === 'L3_PR_PACKET' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 12,
              borderRadius: 'var(--gm-radius-md)',
              border: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-base)',
            }}
          >
            {factSheet ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  结构化媒体 Fact Sheet 预览
                </div>
                {factSheet.keyAngles.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
                    {factSheet.keyAngles.map((angle) => (
                      <Tag
                        key={angle}
                        color="blue"
                        style={{
                          margin: 0,
                          maxWidth: '100%',
                          whiteSpace: 'normal',
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        {angle}
                      </Tag>
                    ))}
                  </div>
                ) : null}
                {factSheet.verifiedFacts.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    {factSheet.verifiedFacts.map((fact) => (
                      <div
                        key={fact.title}
                        style={{
                          fontSize: 12,
                          color: 'var(--gm-fg-2)',
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        <strong style={{ color: 'var(--gm-fg-1)' }}>{fact.title}：</strong>
                        {fact.summary}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              <Button
                type="primary"
                data-testid="distribution-pr-share-btn"
                loading={prActionTaskId === task.id}
                disabled={readOnly || task.status === 'ARCHIVED'}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => void handleCreatePrShare(task)}
              >
                {task.shareLinkActive || generatedShare
                  ? '重新生成 30 天免登录供稿链接'
                  : '生成 30 天免登录供稿链接'}
              </Button>
              {task.shareLinkActive || generatedShare ? (
                <Button
                  danger
                  data-testid="distribution-pr-revoke-btn"
                  loading={prActionTaskId === task.id}
                  disabled={readOnly}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => handleRevokePrShare(task)}
                >
                  撤销链接
                </Button>
              ) : null}
            </div>

            {generatedShare ? (
              <div
                style={{
                  padding: 10,
                  borderRadius: 'var(--gm-radius-sm)',
                  border: '1px solid var(--gm-phosphor-a40)',
                  background: 'var(--gm-phosphor-a08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                  免登录外部供稿链接（仅生成时明文展示一次，有效期至{' '}
                  {formatShanghaiDateTime(generatedShare.expiresAt)}）：
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <code
                    data-testid="distribution-pr-share-url"
                    className="gm-mono"
                    style={{
                      flex: '1 1 240px',
                      minWidth: 0,
                      color: 'var(--gm-fg-1)',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                    }}
                  >
                    {generatedShare.shareUrl}
                  </code>
                  <Button
                    size="small"
                    type="primary"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() => {
                      void copyTextToClipboard(generatedShare.shareUrl).then((ok) => {
                        if (ok) feedback.notifySuccess('已复制 30 天免登录供稿链接');
                        else feedback.notifyError('复制失败，请手动复制');
                      });
                    }}
                  >
                    复制链接
                  </Button>
                </div>
              </div>
            ) : task.shareLinkActive ? (
              <Alert
                type="info"
                showIcon
                message={`当前已有生效中的免登录供稿链接（有效期至 ${formatShanghaiDateTime(task.shareExpiresAt)}）`}
                description="出于安全原因，系统仅保存链接哈希值且不再明文回显。如需重新获取明文链接，请点击「重新生成 30 天免登录供稿链接」签发新链接（旧链接将自动失效）。"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        destroyOnHidden
        title={null}
        closable={false}
        footer={null}
        width="min(880px, calc(100vw - 32px))"
        styles={{
          wrapper: { maxWidth: '100vw' },
          body: {
            padding: 0,
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        <div
          data-testid="studio-distribution-drawer"
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minWidth: 0,
            maxWidth: '100%',
            overflowX: 'hidden',
            background: 'var(--gm-bg-surface)',
            color: 'var(--gm-fg-1)',
          }}
        >
          {/* Pinned Header */}
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-elevated)',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 280px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  多渠道分发与变体工作台
                </span>
                <Tag color="cyan" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {market === 'CN' ? '🇨🇳' : '🌐'} {GEO_MARKET_LABELS[market]}
                </Tag>
              </div>
              {article ? (
                <div
                  className="gm-clamp-1"
                  style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 4 }}
                >
                  当前成稿：{draftTitle || article.title}
                </div>
              ) : null}
            </div>
            <Button
              size="small"
              aria-label="关闭分发工作台"
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={onClose}
            >
              关闭
            </Button>
          </div>

          {/* Scrollable Body */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxSizing: 'border-box',
            }}
          >
            {drawerError ? (
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setDrawerError(null)}
                message={drawerError}
                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
              />
            ) : null}

            {hydrating && !preflight ? (
              <SignalSkeleton variant="block" height={180} />
            ) : (
              <>
                {/* Step 1: Preflight Health Card */}
                <div
                  data-testid="distribution-preflight-card"
                  style={{
                    padding: 14,
                    borderRadius: 'var(--gm-radius-md)',
                    border: '1px solid var(--gm-line-2)',
                    background: 'var(--gm-bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    minWidth: 0,
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                        Step 1 · 发布前硬校验（Preflight）
                      </span>
                      {preflight ? (
                        preflight.ok ? (
                          preflight.warnings.length > 0 ? (
                            <SignalPill tone="warning">有待优化提示</SignalPill>
                          ) : (
                            <SignalPill tone="cited">门禁校验通过</SignalPill>
                          )
                        ) : (
                          <SignalPill tone="danger">存在硬拦截项</SignalPill>
                        )
                      ) : null}
                    </div>
                    <Button
                      size="small"
                      loading={preflightLoading}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      onClick={() => void handleRerunPreflight()}
                    >
                      重新体检
                    </Button>
                  </div>

                  {preflight && preflight.blockers.length > 0 ? (
                    <div
                      data-testid="distribution-preflight-blockers"
                      style={{
                        padding: 12,
                        borderRadius: 'var(--gm-radius-sm)',
                        border: '1px solid var(--gm-danger)',
                        background: 'rgba(240, 96, 93, 0.08)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {preflight.blockers.map((blocker) => (
                        <div key={blocker.code} style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: 'var(--gm-danger)',
                              overflowWrap: 'anywhere',
                              wordBreak: 'break-word',
                            }}
                          >
                            {blocker.message}
                          </div>
                          {blocker.details && blocker.details.length > 0 ? (
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 6,
                                marginTop: 4,
                              }}
                            >
                              {blocker.details.map((detail) => (
                                <Tag
                                  key={detail}
                                  color="red"
                                  style={{
                                    margin: 0,
                                    maxWidth: '100%',
                                    overflowWrap: 'anywhere',
                                    whiteSpace: 'normal',
                                  }}
                                >
                                  {detail}
                                </Tag>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}

                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          marginTop: 4,
                        }}
                      >
                        <Button
                          size="small"
                          type="primary"
                          danger
                          data-testid="distribution-back-to-editor-btn"
                          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                          onClick={() => onReturnToEditor(preflight.blockers[0]?.code)}
                        >
                          返回编辑器定位补填
                        </Button>
                        <Checkbox
                          data-testid="distribution-ack-warnings-checkbox"
                          checked={ackWarnings}
                          onChange={(e) => setAckWarnings(e.target.checked)}
                        >
                          <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                            我已确认风险，仍要强制继续推送
                          </span>
                        </Checkbox>
                      </div>
                    </div>
                  ) : null}

                  {preflight && preflight.warnings.length > 0 ? (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 'var(--gm-radius-sm)',
                        border: '1px solid var(--gm-warning)',
                        background: 'rgba(242, 184, 75, 0.08)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      {preflight.warnings.map((w) => (
                        <div
                          key={w.code}
                          style={{
                            fontSize: 12,
                            color: 'var(--gm-warning)',
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                          }}
                        >
                          • {w.message}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {preflight && preflight.ok && preflight.warnings.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                      未发现缺失事实占位符、跨市场语言泄露或严重合规风险，可直接生成变体并推送。
                    </div>
                  ) : null}
                </div>

                {/* Step 2: Citation-Driven Channel Selector */}
                <div
                  style={{
                    padding: 14,
                    borderRadius: 'var(--gm-radius-md)',
                    border: '1px solid var(--gm-line-2)',
                    background: 'var(--gm-bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                      Step 2 · 引用驱动目标渠道选择（1 → N 变体改写）
                    </span>
                    <Button
                      type="primary"
                      data-testid="distribution-generate-variants-btn"
                      loading={generating}
                      disabled={selectedTargets.length === 0 || readOnly || generating}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      onClick={() => {
                        pendingVariantIdemKeyRef.current = createDistributionIdempotencyKey('var');
                        setPointsConfirmOpen(true);
                      }}
                    >
                      生成渠道变体
                      {selectedTargets.length > 0 ? `（已选 ${selectedTargets.length}）` : ''}
                    </Button>
                  </div>

                  {/* Citation-Driven Highlights */}
                  {effectiveRecommendedChannels.length > 0 ? (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 'var(--gm-radius-sm)',
                        border: '1px solid var(--gm-line-1)',
                        background: 'var(--gm-bg-base)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-phosphor)' }}>
                        AI 高频被引阵地推荐
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
                          gap: 8,
                        }}
                      >
                        {effectiveRecommendedChannels.map((rec) => {
                          const safeUrls = (rec.citedExampleUrls ?? [])
                            .filter((u) => isSafeDistributionHttpUrl(u))
                            .slice(0, 3);
                          return (
                            <div
                              key={rec.channel}
                              style={{
                                padding: 8,
                                borderRadius: 'var(--gm-radius-xs)',
                                border: '1px solid var(--gm-line-1)',
                                background: 'var(--gm-bg-elevated)',
                                minWidth: 0,
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginBottom: 4,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    color: 'var(--gm-fg-1)',
                                    minWidth: 0,
                                    overflowWrap: 'anywhere',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {rec.channel}
                                </span>
                                {rec.priority ? (
                                  <Tag
                                    color={rec.priority === 'HIGH' ? 'gold' : 'blue'}
                                    style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}
                                  >
                                    {rec.priority === 'HIGH' ? '高优先被引' : '推荐阵地'}
                                  </Tag>
                                ) : null}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: 'var(--gm-fg-2)',
                                  overflowWrap: 'anywhere',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {rec.reason}
                              </div>
                              {safeUrls.length > 0 ? (
                                <div
                                  style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: 6,
                                    marginTop: 4,
                                  }}
                                >
                                  {safeUrls.map((url, idx) => (
                                    <a
                                      key={url}
                                      href={url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="gm-mono"
                                      style={{
                                        fontSize: 11,
                                        color: 'var(--gm-info)',
                                        overflowWrap: 'anywhere',
                                        wordBreak: 'break-word',
                                      }}
                                    >
                                      高频被引原帖 #{idx + 1} ↗
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Group 1: Connected L1 Official Sites */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-2)' }}>
                      1. 已连接自有站点（L1 官方 API · 支持一键推草稿 / 上线）
                    </div>
                    {l1Options.length === 0 ? (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 'var(--gm-radius-sm)',
                          border: '1px dashed var(--gm-line-strong)',
                          display: 'flex',
                          flexWrap: 'wrap',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                          当前市场尚未绑定 Shopify / WordPress / Webflow / Webhook 渠道连接。
                        </span>
                        {onNavigateBrands ? (
                          <Button
                            size="small"
                            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                            onClick={() => {
                              onClose();
                              onNavigateBrands();
                            }}
                          >
                            前往品牌资产配置渠道连接
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
                          gap: 8,
                        }}
                      >
                        {l1Options.map((opt) => {
                          const selected = selectedTargetKeys.includes(opt.key);
                          return (
                            <div
                              key={opt.key}
                              role="presentation"
                              data-testid={`distribution-target-${opt.key}`}
                              onClick={() => {
                                if (!readOnly) toggleTargetKey(opt.key);
                              }}
                              style={{
                                padding: 10,
                                borderRadius: 'var(--gm-radius-sm)',
                                border: selected
                                  ? '1px solid var(--gm-phosphor)'
                                  : '1px solid var(--gm-line-2)',
                                background: selected
                                  ? 'var(--gm-bg-selected)'
                                  : 'var(--gm-bg-base)',
                                cursor: readOnly ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                minWidth: 0,
                                boxSizing: 'border-box',
                              }}
                            >
                              <span style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={selected}
                                  disabled={readOnly}
                                  aria-label={opt.channelLabel}
                                  onChange={() => toggleTargetKey(opt.key)}
                                />
                              </span>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    alignItems: 'center',
                                    gap: 6,
                                    minWidth: 0,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 600,
                                      color: 'var(--gm-fg-1)',
                                      minWidth: 0,
                                      overflowWrap: 'anywhere',
                                      wordBreak: 'break-word',
                                    }}
                                  >
                                    {opt.channelLabel}
                                  </span>
                                  <Tag style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                    {opt.description}
                                  </Tag>
                                  {opt.connectionStatus === 'INVALID' ? (
                                    <Tag
                                      color="red"
                                      style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}
                                    >
                                      连接异常
                                    </Tag>
                                  ) : null}
                                </div>
                                {opt.siteBaseUrl ? (
                                  <div
                                    className="gm-mono"
                                    style={{
                                      fontSize: 11,
                                      color: 'var(--gm-fg-3)',
                                      marginTop: 4,
                                      overflowWrap: 'anywhere',
                                      wordBreak: 'break-word',
                                    }}
                                  >
                                    {opt.siteBaseUrl}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Group 2: L3 Community Assist */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-2)' }}>
                      2. 社区合规辅发（L3 人工辅发 · 不自动发帖）
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
                        gap: 8,
                      }}
                    >
                      {communityOptions.map((opt) => {
                        const selected = selectedTargetKeys.includes(opt.key);
                        return (
                          <div
                            key={opt.key}
                            role="presentation"
                            data-testid={`distribution-target-${opt.provider}`}
                            onClick={() => {
                              if (!readOnly) toggleTargetKey(opt.key);
                            }}
                            style={{
                              padding: 10,
                              borderRadius: 'var(--gm-radius-sm)',
                              border: selected
                                ? '1px solid var(--gm-phosphor)'
                                : '1px solid var(--gm-line-2)',
                              background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-base)',
                              cursor: readOnly ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              minWidth: 0,
                              boxSizing: 'border-box',
                            }}
                          >
                            <span style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={selected}
                                disabled={readOnly}
                                aria-label={opt.channelLabel}
                                onChange={() => toggleTargetKey(opt.key)}
                              />
                            </span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  alignItems: 'center',
                                  gap: 6,
                                  minWidth: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: 'var(--gm-fg-1)',
                                    minWidth: 0,
                                    overflowWrap: 'anywhere',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {opt.channelLabel}
                                </span>
                                {opt.recommendedPriority === 'HIGH' ? (
                                  <Tag
                                    color="gold"
                                    style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}
                                  >
                                    高频被引
                                  </Tag>
                                ) : null}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: 'var(--gm-fg-3)',
                                  marginTop: 4,
                                  overflowWrap: 'anywhere',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {opt.description}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Group 3: L3 PR Packet */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-2)' }}>
                      3. 外部媒体 / KOL 协作包（L3 PR Packet）
                    </div>
                    {prOptions.map((opt) => {
                      const selected = selectedTargetKeys.includes(opt.key);
                      return (
                        <div
                          key={opt.key}
                          role="presentation"
                          data-testid="distribution-target-PR_PACKET"
                          onClick={() => {
                            if (!readOnly) toggleTargetKey(opt.key);
                          }}
                          style={{
                            padding: 10,
                            borderRadius: 'var(--gm-radius-sm)',
                            border: selected
                              ? '1px solid var(--gm-phosphor)'
                              : '1px solid var(--gm-line-2)',
                            background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-base)',
                            cursor: readOnly ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            minWidth: 0,
                            boxSizing: 'border-box',
                          }}
                        >
                          <span style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selected}
                              disabled={readOnly}
                              aria-label={opt.channelLabel}
                              onChange={() => toggleTargetKey(opt.key)}
                            />
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: 'var(--gm-fg-1)',
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                              }}
                            >
                              {opt.channelLabel}
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--gm-fg-3)',
                                marginTop: 4,
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                              }}
                            >
                              {opt.description}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Step 3: Multi-Channel Variant Tab Editor */}
                <div
                  data-testid="distribution-variant-tabs"
                  style={{
                    padding: 14,
                    borderRadius: 'var(--gm-radius-md)',
                    border: '1px solid var(--gm-line-2)',
                    background: 'var(--gm-bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    minWidth: 0,
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                    Step 3 · 多渠道变体编辑与一键分发
                  </div>

                  {tasks.length === 0 ? (
                    <SignalEmpty
                      title="尚未生成渠道变体"
                      description="在上方勾选目标自有站点、社区辅发或 PR 协作包，点击「生成渠道变体」即可并行改写多渠道版本。"
                    />
                  ) : (
                    <Tabs
                      className="gm-vis-tabs"
                      destroyOnHidden
                      activeKey={activeTaskId ?? tasks[0]?.id}
                      onChange={setActiveTaskId}
                      items={tasks.map((task) => ({
                        key: task.id,
                        label: (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              maxWidth: 220,
                            }}
                          >
                            <span
                              style={{
                                maxWidth: 140,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {task.channelLabel}
                            </span>
                            <Tag style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                              {DISTRIBUTION_TASK_STATUS_LABELS[task.status]}
                            </Tag>
                          </span>
                        ),
                        children: renderTaskEditorBody(task),
                      }))}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </Drawer>

      {/* Points Confirmation Modal */}
      <Modal
        open={pointsConfirmOpen}
        title="确认生成多渠道变体"
        width="min(520px, calc(100vw - 32px))"
        destroyOnHidden
        keyboard={!generating}
        maskClosable={!generating}
        onCancel={() => {
          pendingVariantIdemKeyRef.current = null;
          setPointsConfirmOpen(false);
        }}
        footer={
          <Space wrap>
            <Button
              disabled={generating}
              onClick={() => {
                pendingVariantIdemKeyRef.current = null;
                setPointsConfirmOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              data-testid="distribution-points-confirm-submit-btn"
              loading={generating}
              disabled={readOnly || selectedTargets.length === 0}
              onClick={() => void handleConfirmGenerateVariants()}
            >
              确认生成
            </Button>
          </Space>
        }
      >
        <div
          data-testid="distribution-points-confirm-modal"
          style={{
            minWidth: 0,
            maxWidth: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--gm-fg-1)' }}>
            即将为当前成稿并行生成 <strong className="gm-num">{selectedTargets.length}</strong>{' '}
            个目标渠道的专属变体：
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
            {selectedTargets.map((opt) => (
              <Tag
                key={opt.key}
                color="geekblue"
                style={{
                  margin: 0,
                  maxWidth: '100%',
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word',
                }}
              >
                {opt.channelLabel}
              </Tag>
            ))}
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 'var(--gm-radius-sm)',
              border: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-base)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
            }}
          >
            {unitPrice === 0 ? (
              <div style={{ color: 'var(--gm-success)', fontWeight: 600 }}>
                限时免费（0 积分，不扣减点数）
              </div>
            ) : (
              <div>
                预计消耗：
                <strong className="gm-num" style={{ color: 'var(--gm-phosphor)' }}>
                  {selectedTargets.length} × {unitPrice} = {totalEstimatedPoints} 点
                </strong>
                （单价 <span className="gm-num">{unitPrice}</span>{' '}
                点/渠道，生成失败自动退还对应点数）
              </div>
            )}

            {typeof walletAvailable === 'number' ? (
              <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                当前可用余额：
                {walletAvailable > 0 ? (
                  <strong className="gm-num">{walletAvailable} 点</strong>
                ) : (
                  <strong className="gm-num">0 积分</strong>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );
}
