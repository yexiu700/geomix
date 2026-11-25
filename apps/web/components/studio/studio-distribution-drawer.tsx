'use client';

import {
  CHANNEL_PROVIDER_LABELS,
  DISTRIBUTION_TASK_STATUS_LABELS,
  GEO_MARKET_LABELS,
  GLOBAL_SUPPORTED_LOCALES,
  L2_EXTENSION_PROVIDERS,
  PRICING_DEFAULTS,
  SUPPORTED_LOCALES,
  UX_GLOSSARY_TOOLTIPS,
  UX_TERMS,
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
  type SupportedLocale,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBadge } from '../ui';
import { authorizedRequest } from '../../lib/api';
import { getBrief } from '../../lib/briefs';
import {
  createDistributionIdempotencyKey,
  createDistributionVariantJob,
  createPrShareLink,
  getDistributionVariantJob,
  isPreflightBlockedError,
  listArticleDistributions,
  listChannelConnections,
  listDistributionVariantJobs,
  publishDistributionTask,
  revokePrShareLink,
  runArticlePreflight,
  updateDistributionTask,
  type ArticleDistributionTaskItem,
  type GeoVariantJobDto,
} from '../../lib/distribution';
import { GatewayApiError, unwrapEnvelope } from '../../lib/envelope';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import { ChannelConnectionCreateModal } from '../brands/channel-connection-create-modal';
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
  supportedLocales?: readonly SupportedLocale[];
  defaultTargetLocale?: SupportedLocale | null;
  readOnly: boolean;
  walletAvailable?: number | null;
  onClose: () => void;
  onReturnToEditor: (code?: PreflightItemCode, locateTerm?: string) => void;
  onNavigateBrands?: () => void;
  onNavigateExtensionPairing?: () => void;
  onNavigateAccount?: () => void;
  onRefreshWallet?: () => Promise<void> | void;
  onPublishRecordsSynced?: (articleId: string) => Promise<void> | void;
  onCreatePublishRecord?: (input: PublishRecordCreateInput) => Promise<boolean | void>;
};

type SelectableTargetOption = {
  key: string;
  group: 'L1' | 'L2_EXTENSION' | 'L3_COMMUNITY' | 'L3_PR';
  provider: ChannelProvider;
  connectionId?: string;
  channelLabel: string;
  description: string;
  siteBaseUrl?: string;
  connectionStatus?: ChannelConnectionDto['status'];
  targetLocale?: SupportedLocale | null;
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

function isBlockedIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Groups(raw: string): number[] | null {
  const addr = (raw.toLowerCase().split('%')[0] ?? '').trim();
  if (!addr || !/^[0-9a-f:]+$/.test(addr)) return null;
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const parsePart = (tokens: string[]): number[] | null => {
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      out.push(Number.parseInt(token, 16));
    }
    return out;
  };
  const leftNums = parsePart(left);
  const rightNums = parsePart(right);
  if (!leftNums || !rightNums) return null;
  if (parts.length === 1) {
    return leftNums.length === 8 ? leftNums : null;
  }
  const missing = 8 - (leftNums.length + rightNums.length);
  if (missing < 1) return null;
  return [...leftNums, ...Array<number>(missing).fill(0), ...rightNums];
}

function isBlockedIpv6(unbracketedHost: string): boolean {
  const groups = parseIpv6Groups(unbracketedHost);
  if (!groups) return true;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return true;
  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return true;
  // IPv4-mapped IPv6 (::ffff:0:0/96) & IPv4-compatible IPv6 (::/96)
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return true;
  }
  // Link-local fe80::/10, ULA fc00::/7 (fc00::/8 & fd00::/8), multicast ff00::/8
  const first = groups[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function isSafePublicExternalHttpUrl(raw: string, options?: { requireHttps?: boolean }): boolean {
  if (!isSafeDistributionHttpUrl(raw)) return false;
  const trimmed = raw.trim();
  const authorityMatch = /^https?:\/\/([^/?#]+)/i.exec(trimmed);
  if (!authorityMatch?.[1]) return false;
  const authority = authorityMatch[1];
  if (authority.includes('@')) return false;
  const rawHost = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
    : (authority.split(':')[0] ?? '').replace(/\.+$/, '').toLowerCase();
  if (!rawHost) return false;
  if (!rawHost.startsWith('[')) {
    if (!rawHost.includes('.')) return false;
    const labels = rawHost.split('.');
    const allNumericOrHex = labels.every((lbl) => /^(?:0x[0-9a-f]+|\d+)$/i.test(lbl));
    if (
      allNumericOrHex &&
      (labels.length !== 4 || labels.some((lbl) => !/^(?:0|[1-9]\d{0,2})$/.test(lbl)))
    ) {
      return false;
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (options?.requireHttps && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const rawParsedHost = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!rawParsedHost) return false;

    if (rawParsedHost.startsWith('[') && rawParsedHost.endsWith(']')) {
      return !isBlockedIpv6(rawParsedHost.slice(1, -1));
    }
    if (rawParsedHost.includes(':')) {
      return !isBlockedIpv6(rawParsedHost);
    }
    if (
      rawParsedHost === 'localhost' ||
      rawParsedHost.endsWith('.localhost') ||
      rawParsedHost.endsWith('.local') ||
      rawParsedHost.endsWith('.internal') ||
      rawParsedHost.endsWith('.localdomain') ||
      rawParsedHost.endsWith('.home.arpa')
    ) {
      return false;
    }
    if (!rawParsedHost.includes('.')) return false;
    if (isBlockedIpv4(rawParsedHost)) return false;
    return true;
  } catch {
    return false;
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
  if (provider === 'ZHIHU_EXT') {
    return recommendations.find((r) => r.channel.includes('知乎'));
  }
  if (provider === 'TOUTIAO_EXT') {
    return recommendations.find((r) => r.channel.includes('头条'));
  }
  if (provider === 'SMZDM_EXT') {
    return recommendations.find((r) => r.channel.includes('值得买'));
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
  supportedLocales,
  defaultTargetLocale,
  readOnly,
  walletAvailable,
  onClose,
  onReturnToEditor,
  onNavigateBrands,
  onNavigateExtensionPairing,
  onNavigateAccount,
  onRefreshWallet,
  onPublishRecordsSynced,
  onCreatePublishRecord,
}: StudioDistributionDrawerProps): JSX.Element {
  const feedback = useUxFeedback();
  const articleMatchesContext = Boolean(
    article && article.market === market && (!brandId || article.brandId === brandId),
  );

  const effectiveSupportedLocales = useMemo<SupportedLocale[]>(() => {
    if (market !== 'GLOBAL') return ['zh-CN'];
    const raw = supportedLocales ?? [];
    const valid = raw.filter((code) =>
      (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(code),
    );
    return valid.length > 0 ? [...new Set(valid)] : ['en-US'];
  }, [market, supportedLocales]);

  const showVariantLocaleSelector = market === 'GLOBAL' && effectiveSupportedLocales.length > 1;
  const effectiveArticleLocale: SupportedLocale | undefined =
    market === 'CN'
      ? 'zh-CN'
      : article?.targetLocale &&
          (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(article.targetLocale)
        ? article.targetLocale
        : defaultTargetLocale &&
            (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(defaultTargetLocale)
          ? defaultTargetLocale
          : undefined;

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
  const [variantTargetLocale, setVariantTargetLocale] = useState<SupportedLocale | undefined>(() =>
    article?.targetLocale && effectiveSupportedLocales.includes(article.targetLocale)
      ? article.targetLocale
      : defaultTargetLocale && effectiveSupportedLocales.includes(defaultTargetLocale)
        ? defaultTargetLocale
        : effectiveSupportedLocales[0],
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [pointsConfirmOpen, setPointsConfirmOpen] = useState(false);
  const [inlineBindModalOpen, setInlineBindModalOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const skipNextSelfConnectionsRefreshRef = useRef(false);
  const [activeVariantJob, setActiveVariantJob] = useState<GeoVariantJobDto | null>(null);
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
  const variantJobPollCtrlRef = useRef<AbortController | null>(null);
  const lastVariantJobDoneCountRef = useRef(0);
  const notifiedVariantJobIdsRef = useRef<Set<string>>(new Set());
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
    variantJobPollCtrlRef.current?.abort();
    variantJobPollCtrlRef.current = null;
    abortAllTaskActions();
    bumpPollEpoch();
    sessionSeqRef.current += 1;
    prevPublishingIdsRef.current.clear();
    lastVariantJobDoneCountRef.current = 0;
    notifiedVariantJobIdsRef.current.clear();
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
    setInlineBindModalOpen(false);
    setGenerating(false);
    setActiveVariantJob(null);
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

  const finalizeVariantJob = useCallback(
    async (job: GeoVariantJobDto, articleId: string, seq: number, signal?: AbortSignal) => {
      if (notifiedVariantJobIdsRef.current.has(job.id)) return;
      notifiedVariantJobIdsRef.current.add(job.id);
      lastVariantJobDoneCountRef.current = job.doneCount;

      try {
        const refreshed = await listArticleDistributions(articleId, {
          storage: window.sessionStorage,
          signal,
        });
        if (signal?.aborted || seq !== sessionSeqRef.current) return;
        bumpPollEpoch();
        syncTasksState(refreshed.items);
        if (job.taskIds[0]) {
          setActiveTaskId(job.taskIds[0]);
        }
      } catch {
        // Non-blocking fallback; user can still inspect existing list
      }

      if (signal?.aborted || seq !== sessionSeqRef.current) return;

      invalidateFreshness('distributions', 'points');
      void onRefreshWallet?.();

      const failCount = job.failCount || job.failures.length;
      if (job.status === 'FAILED' || (job.doneCount === 0 && failCount > 0)) {
        const refundNote = job.refundedPoints > 0 ? `（已自动退还 ${job.refundedPoints} 点）` : '';
        feedback.notifyError(job.lastError || `生成渠道变体失败${refundNote}`);
      } else if (failCount > 0) {
        feedback.notifyWarning(
          `已生成 ${job.doneCount} 个渠道变体，${failCount} 个失败${job.refundedPoints > 0 ? `（已自动退还 ${job.refundedPoints} 点）` : ''}`,
        );
      } else {
        feedback.notifySuccess(`已成功生成 ${job.doneCount} 个渠道变体`);
      }
    },
    [bumpPollEpoch, feedback, onRefreshWallet, syncTasksState],
  );

  const buildLocalPreflightFallback = useCallback((): DistributionPreflightResult | null => {
    if (!article) return null;
    return evaluateDistributionPreflight({
      market,
      targetLocale: effectiveArticleLocale,
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
    effectiveArticleLocale,
    evaluation?.geoScore,
    market,
    matchedFactCount,
  ]);

  const reloadConnections = useCallback(async () => {
    if (!open || !articleMatchesContext || !brandId || !brandMarketId) return;
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
  }, [articleMatchesContext, brandId, brandMarketId, market, open]);

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
      variantJobPollCtrlRef.current?.abort();
      variantJobPollCtrlRef.current = null;
      abortAllTaskActions();
      bumpPollEpoch();
    };
  }, [abortAllTaskActions, bumpPollEpoch]);

  // Full reset whenever context or article changes, or drawer closes
  useEffect(() => {
    if (
      !open ||
      !article ||
      article.market !== market ||
      (brandId && article.brandId !== brandId)
    ) {
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

    setVariantTargetLocale(
      article.targetLocale && effectiveSupportedLocales.includes(article.targetLocale)
        ? article.targetLocale
        : defaultTargetLocale && effectiveSupportedLocales.includes(defaultTargetLocale)
          ? defaultTargetLocale
          : effectiveSupportedLocales[0],
    );

    const preflightPromise = readOnly
      ? Promise.resolve(buildLocalPreflightFallback())
      : runArticlePreflight(
          article.id,
          {
            title: effectiveTitle,
            contentMarkdown: effectiveMarkdown,
            ...(effectiveArticleLocale ? { targetLocale: effectiveArticleLocale } : {}),
          },
          reqOpts,
        ).catch(() => buildLocalPreflightFallback());

    const distributionsPromise = listArticleDistributions(article.id, reqOpts);

    const variantJobsPromise = listDistributionVariantJobs(article.id, reqOpts).catch(() => ({
      items: [] as GeoVariantJobDto[],
    }));

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
      variantJobsPromise,
    ]).then(([preflightRes, distRes, connRes, briefRes, priceRes, jobsRes]) => {
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

      if (jobsRes.status === 'fulfilled') {
        const runningJob = jobsRes.value.items.find(
          (j) => j.status === 'QUEUED' || j.status === 'RUNNING',
        );
        if (runningJob) {
          lastVariantJobDoneCountRef.current = runningJob.doneCount;
          setActiveVariantJob(runningJob);
        }
      }

      setHydrating(false);
    });

    return () => {
      sessionSeqRef.current += 1;
      ctrl.abort();
      actionCtrlRef.current?.abort();
      actionCtrlRef.current = null;
      variantJobPollCtrlRef.current?.abort();
      variantJobPollCtrlRef.current = null;
      abortAllTaskActions();
      bumpPollEpoch();
    };
    // Hydrate strictly when drawer opens or article/context identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    brandId,
    brandMarketId,
    market,
    contextEpoch,
    article?.id,
    article?.market,
    article?.brandId,
  ]);

  useTabFreshness({
    active: open && articleMatchesContext && Boolean(brandId && brandMarketId),
    domains: ['channel-connections'],
    refreshOnActivate: false,
    onRefresh: () => {
      if (skipNextSelfConnectionsRefreshRef.current) {
        skipNextSelfConnectionsRefreshRef.current = false;
        return;
      }
      void reloadConnections();
    },
  });

  // Poll active async variant generation job via useTaskPolling (NEVER raw setInterval)
  const isVariantJobRunning = Boolean(
    activeVariantJob &&
    (activeVariantJob.status === 'QUEUED' || activeVariantJob.status === 'RUNNING'),
  );

  useTaskPolling({
    enabled: open && articleMatchesContext && Boolean(article?.id) && isVariantJobRunning,
    active: open && articleMatchesContext,
    intervalMs: 1_500,
    onPoll: async () => {
      if (!article || !activeVariantJob) return;
      const seq = sessionSeqRef.current;
      variantJobPollCtrlRef.current?.abort();
      const pollCtrl = new AbortController();
      variantJobPollCtrlRef.current = pollCtrl;
      try {
        const latest = await getDistributionVariantJob(article.id, activeVariantJob.id, {
          storage: window.sessionStorage,
          signal: pollCtrl.signal,
        });
        if (pollCtrl.signal.aborted || seq !== sessionSeqRef.current) return;

        setActiveVariantJob(latest);
        const stillRunning = latest.status === 'QUEUED' || latest.status === 'RUNNING';
        if (stillRunning) {
          if (latest.doneCount > lastVariantJobDoneCountRef.current) {
            lastVariantJobDoneCountRef.current = latest.doneCount;
            try {
              const refreshed = await listArticleDistributions(article.id, {
                storage: window.sessionStorage,
                signal: pollCtrl.signal,
              });
              if (!pollCtrl.signal.aborted && seq === sessionSeqRef.current) {
                bumpPollEpoch();
                syncTasksState(refreshed.items);
              }
            } catch {
              // Silent retry on next poll tick
            }
          }
          return;
        }

        await finalizeVariantJob(latest, article.id, seq, pollCtrl.signal);
      } catch {
        // Silent retry on next polling tick
      } finally {
        if (variantJobPollCtrlRef.current === pollCtrl) {
          variantJobPollCtrlRef.current = null;
        }
      }
    },
  });

  // Poll PUBLISHING tasks via useTaskPolling (NEVER raw setInterval)
  const hasPublishingTask = useMemo(
    () => tasks.some((item) => item.status === 'PUBLISHING'),
    [tasks],
  );

  useTaskPolling({
    enabled: open && articleMatchesContext && Boolean(article?.id) && hasPublishingTask,
    active: open && articleMatchesContext,
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

  const disabledConnectionsCount = useMemo(
    () => connections.filter((conn) => conn.status === 'DISABLED').length,
    [connections],
  );

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
        targetLocale: conn.targetLocale ?? null,
      });
    }

    // Group 1.5 (CN Only): L2 Chrome Extension Draft Queue
    if (market === 'CN') {
      for (const provider of L2_EXTENSION_PROVIDERS) {
        const rec = findMatchingRecommendation(provider, effectiveRecommendedChannels);
        const firstSafeCitedUrl = rec?.citedExampleUrls?.find((u) =>
          isSafePublicExternalHttpUrl(u),
        );
        list.push({
          key: `l2:${provider}`,
          group: 'L2_EXTENSION',
          provider,
          channelLabel: CHANNEL_PROVIDER_LABELS[provider],
          description:
            '入队至 Chrome 扩展待发草稿队列，自动填充平台草稿箱，人工核对后手动发布并回传链接',
          targetUrlHint: firstSafeCitedUrl,
          recommendedPriority: rec?.priority,
        });
      }
    }

    // Group 2: L3 Community Assist (Market-specific, human-assist only)
    const communityProviders: ChannelProvider[] =
      market === 'GLOBAL'
        ? ['REDDIT_ASSIST', 'QUORA_ASSIST', 'SOCIAL_THREAD_ASSIST']
        : ['CN_COMMUNITY_ASSIST'];

    for (const provider of communityProviders) {
      const rec = findMatchingRecommendation(provider, effectiveRecommendedChannels);
      const firstSafeCitedUrl = rec?.citedExampleUrls?.find((u) => isSafePublicExternalHttpUrl(u));
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
    if (!article || !articleMatchesContext) return;
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
          ...(effectiveArticleLocale ? { targetLocale: effectiveArticleLocale } : {}),
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
    if (
      !article ||
      !articleMatchesContext ||
      selectedTargets.length === 0 ||
      readOnly ||
      generatingRef.current
    )
      return;
    generatingRef.current = true;
    const ctrl = new AbortController();
    actionCtrlRef.current = ctrl;
    const seq = sessionSeqRef.current;
    bumpPollEpoch();

    const payloadTargets: DistributionVariantTargetInput[] = selectedTargets.map((opt) => {
      const resolvedTargetLocale =
        market === 'CN'
          ? opt.targetLocale === 'zh-CN'
            ? 'zh-CN'
            : undefined
          : showVariantLocaleSelector
            ? (variantTargetLocale ?? opt.targetLocale ?? undefined)
            : (opt.targetLocale ?? undefined);
      return {
        provider: opt.provider,
        ...(opt.connectionId ? { connectionId: opt.connectionId } : {}),
        channelLabel: opt.channelLabel,
        ...(opt.targetUrlHint ? { targetUrlHint: opt.targetUrlHint } : {}),
        ...(resolvedTargetLocale ? { targetLocale: resolvedTargetLocale } : {}),
        templateKey: defaultTemplateKeyForProvider(opt.provider),
      };
    });

    setGenerating(true);
    setDrawerError(null);
    try {
      const idempotencyKey =
        pendingVariantIdemKeyRef.current ?? createDistributionIdempotencyKey('var');
      pendingVariantIdemKeyRef.current = idempotencyKey;
      const job = await createDistributionVariantJob(
        article.id,
        { targets: payloadTargets },
        { storage: window.sessionStorage, signal: ctrl.signal, idempotencyKey },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;

      pendingVariantIdemKeyRef.current = null;
      if (typeof job.unitPrice === 'number' && Number.isFinite(job.unitPrice)) {
        setUnitPrice(job.unitPrice);
      }
      setPointsConfirmOpen(false);
      setSelectedTargetKeys([]);
      bumpPollEpoch();

      lastVariantJobDoneCountRef.current = job.doneCount;
      setActiveVariantJob(job);

      const running = job.status === 'QUEUED' || job.status === 'RUNNING';
      if (running) {
        invalidateFreshness('points');
        void onRefreshWallet?.();
        feedback.notifySuccess(
          job.replayed
            ? '检测到相同生成任务正在进行中，已自动接续查看实时进度'
            : `已提交 ${job.total} 个渠道变体生成任务，正在后台并行生成…`,
        );
      } else {
        await finalizeVariantJob(job, article.id, seq, ctrl.signal);
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      if (err instanceof GatewayApiError && err.status >= 400 && err.status !== 504) {
        pendingVariantIdemKeyRef.current = null;
      }
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

  const handleMarkExtensionTaskReady = async (task: ArticleDistributionTaskItem) => {
    if (readOnly || savingTasksRef.current.has(task.id)) return;
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
        { status: 'READY_TO_PUBLISH' },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      bumpPollEpoch();
      setTasks((prev) =>
        prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      invalidateFreshness('distributions');
      feedback.notifySuccess(`「${task.channelLabel}」已标记为待扩展拉取`);
    } catch (err) {
      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      const msg = formatDrawerError(err, '更新扩展队列状态失败');
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
  const l2ExtensionOptions = targetOptions.filter((o) => o.group === 'L2_EXTENSION');
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
    const isWechatTask = task.provider === 'WECHAT_OFFICIAL';
    const isGithubMdxTask = task.provider === 'GITHUB_MDX';
    const isDevtoOrHashnode = task.provider === 'DEVTO' || task.provider === 'HASHNODE';
    const canonicalUrlRaw =
      typeof extras.canonicalUrl === 'string' ? extras.canonicalUrl.trim() : '';
    const safeCanonicalUrl = isSafePublicExternalHttpUrl(canonicalUrlRaw) ? canonicalUrlRaw : null;
    const safeRemoteAdminUrl =
      task.remoteAdminUrl &&
      isSafePublicExternalHttpUrl(task.remoteAdminUrl, { requireHttps: isGithubMdxTask })
        ? task.remoteAdminUrl
        : null;
    const safeRemotePublishedUrl =
      task.remotePublishedUrl && isSafePublicExternalHttpUrl(task.remotePublishedUrl)
        ? task.remotePublishedUrl
        : null;
    const extraTags = readStringArray(extras.tags);
    const hasWechat40164Error =
      isWechatTask && Boolean(task.lastError && task.lastError.includes('40164'));
    const taskLocaleMeta = task.targetLocale ? SUPPORTED_LOCALES[task.targetLocale] : null;
    const antiBanChecklist = readStringArray(extras.antiBanChecklist);
    const threadPosts = readStringArray(extras.threadPosts);
    const targetThreadUrls = [
      ...new Set([
        ...readStringArray(extras.targetThreadUrls),
        ...(task.targetUrlHint ? [task.targetUrlHint] : []),
      ]),
    ].filter((u) => isSafePublicExternalHttpUrl(u));
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
      <div className="gm-dist-task-body">
        {/* Task Header Status Bar */}
        <div className="gm-dist-status-bar">
          <div className="gm-dist-row">
            <Tag className="gm-studio-tag-nowrap">
              {CHANNEL_PROVIDER_LABELS[task.provider] ?? task.provider}
            </Tag>
            <SignalPill tone={taskStatusTone(task.status)}>
              {DISTRIBUTION_TASK_STATUS_LABELS[task.status]}
            </SignalPill>
            {task.targetLocale && taskLocaleMeta ? (
              <StatusBadge
                tone="active"
                data-testid="distribution-task-locale-tag"
                className="gm-studio-nowrap"
              >
                {task.targetLocale} · {taskLocaleMeta.nativeLabel}
              </StatusBadge>
            ) : null}
            {task.indexNowStatus ? (
              <StatusBadge tone="active" className="gm-studio-nowrap">
                IndexNow: {task.indexNowStatus}
              </StatusBadge>
            ) : null}
          </div>
          {task.publishedAt ? (
            <span className="gm-dist-muted">发布于 {formatShanghaiDateTime(task.publishedAt)}</span>
          ) : null}
        </div>

        {isWechatTask ? (
          <Alert
            type="info"
            showIcon
            data-testid="distribution-wechat-draft-only-notice"
            message="仅推送至微信公众号草稿箱，绝不自动群发"
            description="推送后请前往微信公众平台后台人工复核排版并手动群发；如遇错误码 40164，请将服务器出口 IP 加入公众号 IP 白名单。"
          />
        ) : null}

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
            description={
              hasWechat40164Error
                ? `${task.lastError}（处理指引：前往微信公众平台「设置与开发 → 基本配置 → IP 白名单」添加服务器出口 IP 后重试）`
                : task.lastError
            }
            className="gm-dist-wrap"
          />
        ) : null}

        {taskPublishBlockedNotice && task.mode === 'L1_API' ? (
          <Alert
            type="error"
            showIcon
            message="推送被发布前体检门禁拦截"
            description={taskPublishBlockedNotice}
            className="gm-dist-wrap"
            action={
              <Button
                size="small"
                className="gm-dist-nowrap"
                onClick={() => {
                  const first = preflight?.blockers[0];
                  const term = first?.matches?.[0]?.matchedText;
                  if (term) onReturnToEditor(first?.code, term);
                  else onReturnToEditor(first?.code);
                }}
              >
                返回编辑器补填
              </Button>
            }
          />
        ) : null}

        {/* WeChat Official Draft media_id Display */}
        {isWechatTask && task.status === 'DRAFT_PUSHED' && task.remotePostId ? (
          <div data-testid="distribution-wechat-media-id" className="gm-dist-info-bar">
            <div className="gm-dist-min0 gm-dist-wrap">
              <span className="gm-dist-text-secondary">公众号草稿 media_id：</span>
              <code className="gm-mono gm-dist-text-primary">{task.remotePostId}</code>
            </div>
            <Button
              size="small"
              className="gm-dist-nowrap"
              onClick={() => {
                if (!task.remotePostId) return;
                void copyTextToClipboard(task.remotePostId).then((ok) => {
                  if (ok) feedback.notifySuccess('已复制草稿 media_id');
                });
              }}
            >
              复制 media_id
            </Button>
          </div>
        ) : null}

        {/* Dev.to / Hashnode Canonical URL & Tags Preview */}
        {isDevtoOrHashnode && (canonicalUrlRaw || extraTags.length > 0) ? (
          <div data-testid="distribution-canonical-preview" className="gm-dist-info-stack">
            {canonicalUrlRaw ? (
              <div className="gm-dist-wrap">
                <span className="gm-dist-text-secondary">Canonical URL 回指：</span>
                {safeCanonicalUrl ? (
                  <a
                    href={safeCanonicalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gm-mono gm-dist-link-info"
                  >
                    {safeCanonicalUrl} ↗
                  </a>
                ) : (
                  <span className="gm-mono gm-dist-text-primary">{canonicalUrlRaw}</span>
                )}
              </div>
            ) : null}
            {extraTags.length > 0 ? (
              <div className="gm-dist-row gm-dist-row--tight">
                <span className="gm-dist-text-secondary">规范化标签：</span>
                {extraTags.map((tag) => (
                  <Tag key={tag} className="gm-studio-tag-reset">
                    #{tag}
                  </Tag>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Remote Links (Admin Draft / GitHub PR Review Link & Published URL) */}
        {safeRemoteAdminUrl || safeRemotePublishedUrl ? (
          <div className="gm-dist-remote-links">
            {safeRemoteAdminUrl ? (
              <a
                href={safeRemoteAdminUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={isGithubMdxTask ? 'distribution-github-pr-link' : undefined}
                className="gm-dist-link-info"
              >
                {isGithubMdxTask
                  ? `查看 GitHub PR 审核链接${task.remotePostId ? ` (${task.remotePostId})` : ''} ↗`
                  : isWechatTask
                    ? '前往微信公众平台草稿箱 ↗'
                    : '打开站点后台草稿 / 管理页 ↗'}
              </a>
            ) : null}
            {safeRemotePublishedUrl ? (
              <a
                href={safeRemotePublishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="gm-dist-link-success"
              >
                查看已上线公开文章 ↗
              </a>
            ) : null}
          </div>
        ) : null}

        {/* Editable Variant Fields */}
        <div className="gm-dist-min0">
          <div className="gm-dist-label">变体标题</div>
          <Input
            aria-label="变体标题"
            disabled={isTaskLocked}
            value={draft.variantTitle}
            onChange={(e) => updateDraftField('variantTitle', e.target.value)}
          />
        </div>

        {task.mode === 'L1_API' ? (
          <div className="gm-dist-grid-2">
            {!isWechatTask ? (
              <div className="gm-dist-min0">
                <div className="gm-dist-label">URL Slug（英文短链）</div>
                <Input
                  aria-label="URL Slug"
                  disabled={isTaskLocked}
                  placeholder="例如：best-quiet-4-bay-nas-2026"
                  value={draft.variantSlug}
                  onChange={(e) => updateDraftField('variantSlug', e.target.value)}
                />
              </div>
            ) : null}

            <div className="gm-dist-min0">
              <div className="gm-dist-label">目标站点连接</div>
              <Select
                aria-label="目标站点连接"
                className="gm-dist-full"
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
                <div className="gm-studio-text-warning">
                  原绑定连接已停用或删除，请重新选择可用连接
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {task.mode === 'L1_API' ? (
          <div className="gm-dist-min0">
            <div className="gm-dist-label-row">
              <span>
                {isWechatTask ? '公众号摘要（Digest，≤120 字）' : '摘要描述（Meta Description）'}
              </span>
              <span className="gm-num gm-dist-muted">
                {draft.variantMetaDesc.length} / {isWechatTask ? 120 : 160} 字
              </span>
            </div>
            <Input.TextArea
              aria-label="摘要描述"
              rows={2}
              maxLength={isWechatTask ? 120 : 320}
              disabled={isTaskLocked}
              placeholder={
                isWechatTask
                  ? '公众号草稿箱摘要，最多 120 字'
                  : '建议 140–160 字符，直接概述核心数据与结论'
              }
              value={draft.variantMetaDesc}
              onChange={(e) => updateDraftField('variantMetaDesc', e.target.value)}
            />
          </div>
        ) : null}

        <div className="gm-dist-min0">
          <div className="gm-dist-label">变体正文（Markdown）</div>
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
          <div className="gm-dist-col">
            <div className="gm-dist-row">
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                className="gm-dist-nowrap"
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              <Button
                type={isWechatTask ? 'primary' : 'default'}
                data-testid="distribution-publish-draft-btn"
                loading={publishingTaskId === task.id}
                disabled={
                  readOnly ||
                  task.status === 'PUBLISHING' ||
                  task.status === 'PUBLISHED' ||
                  task.status === 'ARCHIVED'
                }
                className="gm-dist-nowrap"
                onClick={() => void handlePublishL1(task, true)}
              >
                {isWechatTask
                  ? '推送至公众号草稿箱'
                  : isGithubMdxTask
                    ? '创建 GitHub Draft PR（推荐）'
                    : '推送为草稿（推荐）'}
              </Button>
              {!isWechatTask ? (
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
                  className="gm-dist-nowrap"
                  onClick={() => void handlePublishL1(task, false)}
                >
                  {isGithubMdxTask ? '直接提交至目标分支' : '立即上线发布'}
                </Button>
              ) : null}
            </div>

            {isWechatTask && task.status === 'DRAFT_PUSHED' && onCreatePublishRecord ? (
              <div className="gm-dist-subcard">
                <div className="gm-dist-subhead">
                  在公众号后台人工群发后，可在此登记文章链接以开启自动复测
                </div>
                <div className="gm-dist-row">
                  <Input
                    aria-label="已发布公众号链接"
                    className="gm-dist-flex-input"
                    disabled={readOnly}
                    placeholder="粘贴公众号已群发文章链接，例如 https://mp.weixin.qq.com/s/..."
                    value={quickRegisterUrls[task.id] ?? ''}
                    onChange={(e) =>
                      setQuickRegisterUrls((prev) => ({ ...prev, [task.id]: e.target.value }))
                    }
                  />
                  <Button
                    size="small"
                    type="primary"
                    loading={quickRegisteringTaskId === task.id}
                    disabled={readOnly || !(quickRegisterUrls[task.id] ?? '').trim()}
                    className="gm-dist-nowrap"
                    onClick={() => void handleQuickRegisterUrl(task)}
                  >
                    登记已发链接
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {task.mode === 'L2_EXTENSION' ? (
          <div data-testid="distribution-l2-extension-panel" className="gm-dist-panel-box">
            <Alert
              type={task.status === 'PUBLISHED' ? 'success' : 'info'}
              showIcon
              message={
                task.status === 'PUBLISHED'
                  ? '已由 Chrome 扩展回传公网链接并纳入追踪'
                  : '已入队等待 Chrome 扩展拉取（写入平台草稿箱，人工审核后手动发布）'
              }
              description={
                task.status === 'PUBLISHED'
                  ? '该国内平台发布链接已同步至发布记录，并自动创建 T+7 / T+14 / T+30 复测日程。'
                  : '打开已配对的 GeoMix Chrome 扩展即可拉取此变体并填充到目标平台草稿箱；扩展绝不读取 Cookie，绝不自动点击最终发布。'
              }
            />

            <div className="gm-dist-row">
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                className="gm-dist-nowrap"
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              {task.status === 'DRAFT_VARIANT' ? (
                <Button
                  type="primary"
                  data-testid="distribution-l2-mark-ready-btn"
                  loading={savingTaskId === task.id}
                  disabled={readOnly}
                  className="gm-dist-nowrap"
                  onClick={() => void handleMarkExtensionTaskReady(task)}
                >
                  标记待扩展拉取
                </Button>
              ) : null}
              <Button
                data-testid="distribution-l2-copy-btn"
                className="gm-dist-nowrap"
                onClick={() => {
                  void copyTextToClipboard(draft.variantMarkdown).then((ok) => {
                    if (ok) feedback.notifySuccess('已复制国内平台变体正文');
                    else feedback.notifyError('复制失败，请检查剪贴板权限');
                  });
                }}
              >
                复制正文
              </Button>
              {onNavigateExtensionPairing || onNavigateBrands ? (
                <Button
                  size="small"
                  data-testid="distribution-l2-pair-brands-btn"
                  className="gm-dist-nowrap"
                  onClick={() => {
                    onClose();
                    (onNavigateExtensionPairing ?? onNavigateBrands)?.();
                  }}
                >
                  前往品牌资产配对 Chrome 扩展
                </Button>
              ) : null}
              {onNavigateAccount ? (
                <Button
                  size="small"
                  data-testid="distribution-l2-pair-account-btn"
                  className="gm-dist-nowrap"
                  onClick={() => {
                    onClose();
                    onNavigateAccount();
                  }}
                >
                  前往账户管理扩展令牌
                </Button>
              ) : null}
            </div>

            {targetThreadUrls.length > 0 ? (
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">参考高频被引原帖</div>
                <div className="gm-dist-row">
                  {targetThreadUrls.map((url, idx) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gm-mono gm-dist-thread-link"
                    >
                      参考原帖 #{idx + 1} ↗
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            {antiBanChecklist.length > 0 ? (
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">平台合规防封自检清单</div>
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
                      <span className="gm-dist-check-label">{item}</span>
                    </Checkbox>
                  );
                })}
              </div>
            ) : null}

            {onCreatePublishRecord ? (
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">
                  手动回传已发链接（也可直接在 Chrome 扩展内一键回传）
                </div>
                <div className="gm-dist-row">
                  <Input
                    aria-label="已发布平台链接"
                    className="gm-dist-flex-input"
                    disabled={readOnly}
                    placeholder="粘贴平台发布后的公网链接，自动开启 T+7/14/30 复测"
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
                    className="gm-dist-nowrap"
                    onClick={() => void handleQuickRegisterUrl(task)}
                  >
                    登记已发链接
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {task.mode === 'L3_COMMUNITY_ASSIST' ? (
          <div className="gm-dist-panel-box">
            <div className="gm-dist-row">
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                className="gm-dist-nowrap"
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              <Button
                type="primary"
                data-testid="distribution-copy-community-btn"
                className="gm-dist-nowrap"
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
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">打开高频被引原帖（人工参与讨论）</div>
                <div className="gm-dist-row">
                  {targetThreadUrls.map((url, idx) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gm-mono gm-dist-thread-link"
                    >
                      打开高频被引原帖 #{idx + 1} ↗
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            {threadPosts.length > 0 ? (
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">分条社媒长帖（共 {threadPosts.length} 条）</div>
                {threadPosts.map((post, idx) => (
                  <div key={`${idx}-${post.slice(0, 16)}`} className="gm-dist-thread-post">
                    <div className="gm-dist-thread-text">{post}</div>
                    <Button
                      size="small"
                      className="gm-dist-nowrap"
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
              <div className="gm-dist-col gm-dist-col--sm">
                <div className="gm-dist-subhead">社区合规防封自检清单</div>
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
                      <span className="gm-dist-check-label">{item}</span>
                    </Checkbox>
                  );
                })}
              </div>
            ) : null}

            {/* Quick Register Published URL */}
            <div className="gm-dist-col gm-dist-col--sm">
              <div className="gm-dist-subhead">
                发布后快速登记链接（自动开启 T+7/14/30 定时复测）
              </div>
              <div className="gm-dist-row">
                <Input
                  aria-label="已发布社区链接"
                  className="gm-dist-flex-input"
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
                  className="gm-dist-nowrap"
                  onClick={() => void handleQuickRegisterUrl(task)}
                >
                  登记已发链接
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {task.mode === 'L3_PR_PACKET' ? (
          <div className="gm-dist-panel-box">
            {factSheet ? (
              <div className="gm-dist-col gm-dist-col--md gm-dist-min0">
                <div className="gm-dist-subhead">结构化媒体 Fact Sheet 预览</div>
                {factSheet.keyAngles.length > 0 ? (
                  <div className="gm-dist-row gm-dist-row--tight gm-dist-min0">
                    {factSheet.keyAngles.map((angle) => (
                      <Tag key={angle} className="gm-studio-tag-wrap">
                        {angle}
                      </Tag>
                    ))}
                  </div>
                ) : null}
                {factSheet.verifiedFacts.length > 0 ? (
                  <div className="gm-dist-col gm-dist-col--xs gm-dist-min0">
                    {factSheet.verifiedFacts.map((fact) => (
                      <div key={fact.title} className="gm-dist-fact-row">
                        <strong className="gm-dist-text-primary">{fact.title}：</strong>
                        {fact.summary}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="gm-dist-row">
              <Button
                data-testid="distribution-save-variant-btn"
                loading={savingTaskId === task.id}
                disabled={isTaskLocked}
                className="gm-dist-nowrap"
                onClick={() => void handleSaveVariantDraft(task)}
              >
                保存变体修改
              </Button>
              <Button
                type="primary"
                data-testid="distribution-pr-share-btn"
                loading={prActionTaskId === task.id}
                disabled={readOnly || task.status === 'ARCHIVED'}
                className="gm-dist-nowrap"
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
                  className="gm-dist-nowrap"
                  onClick={() => handleRevokePrShare(task)}
                >
                  撤销链接
                </Button>
              ) : null}
            </div>

            {generatedShare ? (
              <div className="gm-dist-pr-share-box">
                <div className="gm-dist-check-label">
                  免登录外部供稿链接（仅生成时明文展示一次，有效期至{' '}
                  {formatShanghaiDateTime(generatedShare.expiresAt)}）：
                </div>
                <div className="gm-dist-row">
                  <code data-testid="distribution-pr-share-url" className="gm-mono gm-dist-pr-code">
                    {generatedShare.shareUrl}
                  </code>
                  <Button
                    size="small"
                    type="primary"
                    className="gm-dist-nowrap"
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
        <div data-testid="studio-distribution-drawer" className="gm-dist-drawer-root">
          {/* Pinned Header */}
          <div className="gm-dist-drawer-head">
            <div className="gm-dist-drawer-head-col">
              <div className="gm-dist-row">
                <span className="gm-dist-drawer-title">多渠道分发与变体工作台</span>
                <StatusBadge tone="active" className="gm-studio-nowrap">
                  {market === 'CN' ? '🇨🇳' : '🌐'} {GEO_MARKET_LABELS[market]}
                </StatusBadge>
              </div>
              {article ? (
                <div className="gm-clamp-1 gm-dist-drawer-subtitle">
                  当前成稿：{draftTitle || article.title}
                </div>
              ) : null}
            </div>
            <Button
              size="small"
              aria-label="关闭分发工作台"
              className="gm-dist-nowrap"
              onClick={onClose}
            >
              关闭
            </Button>
          </div>

          {/* Scrollable Body */}
          <div className="gm-dist-drawer-body">
            {drawerError ? (
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setDrawerError(null)}
                message={drawerError}
                className="gm-dist-wrap"
              />
            ) : null}

            {hydrating && !preflight ? (
              <SignalSkeleton variant="block" height={180} />
            ) : (
              <>
                {/* Step 1: Preflight Health Card */}
                <div data-testid="distribution-preflight-card" className="gm-dist-section-card">
                  <div className="gm-dist-row gm-dist-row--between">
                    <div className="gm-dist-row">
                      <span className="gm-dist-card-title">Step 1 · 发布前硬校验（Preflight）</span>
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
                      className="gm-dist-nowrap"
                      onClick={() => void handleRerunPreflight()}
                    >
                      重新体检
                    </Button>
                  </div>

                  {preflight && preflight.blockers.length > 0 ? (
                    <div
                      data-testid="distribution-preflight-blockers"
                      className="gm-dist-preflight-blockers"
                    >
                      {preflight.blockers.map((blocker) => (
                        <div key={blocker.code} className="gm-dist-min0">
                          <div className="gm-dist-preflight-blocker-msg">{blocker.message}</div>
                          {blocker.details && blocker.details.length > 0 ? (
                            <div className="gm-dist-details-row">
                              {blocker.details.map((detail) => (
                                <StatusBadge
                                  key={detail}
                                  tone="danger"
                                  className="gm-studio-tag-wrap"
                                >
                                  {detail}
                                </StatusBadge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}

                      <div className="gm-dist-preflight-actions">
                        <Button
                          size="small"
                          type="primary"
                          danger
                          data-testid="distribution-back-to-editor-btn"
                          className="gm-dist-nowrap"
                          onClick={() => {
                            const first = preflight.blockers[0];
                            const term = first?.matches?.[0]?.matchedText;
                            if (term) onReturnToEditor(first?.code, term);
                            else onReturnToEditor(first?.code);
                          }}
                        >
                          返回编辑器定位补填
                        </Button>
                        <Checkbox
                          data-testid="distribution-ack-warnings-checkbox"
                          checked={ackWarnings}
                          onChange={(e) => setAckWarnings(e.target.checked)}
                        >
                          <span className="gm-dist-check-label">
                            我已确认风险，仍要强制继续推送
                          </span>
                        </Checkbox>
                      </div>
                    </div>
                  ) : null}

                  {preflight && preflight.warnings.length > 0 ? (
                    <div
                      data-testid="distribution-preflight-warnings"
                      className="gm-dist-preflight-warnings"
                    >
                      {preflight.warnings.map((w) => (
                        <div key={w.code} className="gm-dist-min0">
                          <div className="gm-dist-row gm-dist-row--between">
                            <div className="gm-dist-preflight-warning-msg">• {w.message}</div>
                            {w.code === 'GLOBAL_CLAIM_WARNING' ? (
                              <Button
                                size="small"
                                data-testid="distribution-warning-locate-btn"
                                className="gm-dist-nowrap"
                                onClick={() =>
                                  onReturnToEditor(
                                    'GLOBAL_CLAIM_WARNING',
                                    w.matches?.[0]?.matchedText,
                                  )
                                }
                              >
                                返回编辑器定位修改
                              </Button>
                            ) : null}
                          </div>
                          {w.details && w.details.length > 0 ? (
                            <div className="gm-dist-details-row">
                              {w.details.map((detail) => (
                                <StatusBadge
                                  key={detail}
                                  tone="warning"
                                  className="gm-studio-tag-wrap"
                                >
                                  {detail}
                                </StatusBadge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {preflight && preflight.ok && preflight.warnings.length === 0 ? (
                    <div className="gm-dist-check-label">
                      未发现缺失事实占位符、跨市场语言泄露或严重合规风险，可直接生成变体并推送。
                    </div>
                  ) : null}
                </div>

                {/* Step 2: Citation-Driven Channel Selector */}
                <div className="gm-dist-section-card gm-dist-section-card--spacious">
                  <div className="gm-dist-row gm-dist-row--between">
                    <span className="gm-dist-card-title">
                      Step 2 · 引用驱动目标渠道选择（1 → N 变体改写）
                    </span>
                    <Button
                      type="primary"
                      data-testid="distribution-generate-variants-btn"
                      loading={generating || isVariantJobRunning}
                      disabled={
                        selectedTargets.length === 0 ||
                        readOnly ||
                        generating ||
                        isVariantJobRunning
                      }
                      className="gm-dist-nowrap"
                      onClick={() => {
                        pendingVariantIdemKeyRef.current = createDistributionIdempotencyKey('var');
                        setPointsConfirmOpen(true);
                      }}
                    >
                      {isVariantJobRunning
                        ? `并行生成中（${(activeVariantJob?.doneCount ?? 0) + (activeVariantJob?.failCount ?? 0)}/${activeVariantJob?.total ?? 0}）`
                        : `生成渠道变体${selectedTargets.length > 0 ? `（已选 ${selectedTargets.length}）` : ''}`}
                    </Button>
                  </div>

                  {showVariantLocaleSelector ? (
                    <div className="gm-dist-locale-bar">
                      <span className="gm-dist-locale-label">变体目标语种：</span>
                      <Select<SupportedLocale>
                        size="small"
                        aria-label="变体目标语种"
                        data-testid="distribution-target-locale-select"
                        className="gm-dist-locale-select"
                        disabled={readOnly || generating || isVariantJobRunning}
                        value={variantTargetLocale}
                        options={effectiveSupportedLocales.map((code) => {
                          const meta = SUPPORTED_LOCALES[code];
                          return {
                            value: code,
                            label: `${meta.labelZh} (${code}) · ${meta.nativeLabel}`,
                          };
                        })}
                        onChange={(val) => setVariantTargetLocale(val)}
                      />
                    </div>
                  ) : null}

                  {/* Async Variant Generation Progress Card (#363) */}
                  {activeVariantJob ? (
                    <div
                      data-testid="distribution-variant-job-progress"
                      className={`gm-dist-job-card${
                        activeVariantJob.status === 'FAILED'
                          ? ' gm-dist-job-card--failed'
                          : activeVariantJob.status === 'PARTIAL'
                            ? ' gm-dist-job-card--partial'
                            : ''
                      }`}
                    >
                      <div className="gm-dist-row gm-dist-row--between">
                        <div className="gm-dist-row">
                          <SignalPill
                            tone={
                              activeVariantJob.status === 'COMPLETED'
                                ? 'cited'
                                : activeVariantJob.status === 'FAILED'
                                  ? 'danger'
                                  : activeVariantJob.status === 'PARTIAL'
                                    ? 'warning'
                                    : 'info'
                            }
                          >
                            {activeVariantJob.status === 'QUEUED'
                              ? '任务排队中'
                              : activeVariantJob.status === 'RUNNING'
                                ? '后台并行生成中'
                                : activeVariantJob.status === 'COMPLETED'
                                  ? '渠道变体已全部生成'
                                  : activeVariantJob.status === 'PARTIAL'
                                    ? '部分渠道生成完成'
                                    : '渠道变体生成失败'}
                          </SignalPill>
                          <span className="gm-dist-check-label">
                            成功{' '}
                            <strong className="gm-num gm-dist-text-primary">
                              {activeVariantJob.doneCount}
                            </strong>{' '}
                            / <span className="gm-num">{activeVariantJob.total}</span> 个渠道
                            {activeVariantJob.failCount > 0 ? (
                              <>
                                {' '}
                                · 失败{' '}
                                <strong className="gm-num gm-dist-text-danger">
                                  {activeVariantJob.failCount}
                                </strong>{' '}
                                个
                              </>
                            ) : null}
                            {activeVariantJob.refundedPoints > 0 ? (
                              <>
                                {' '}
                                · 已自动退还{' '}
                                <strong className="gm-num gm-dist-text-success">
                                  {activeVariantJob.refundedPoints}
                                </strong>{' '}
                                点
                              </>
                            ) : null}
                          </span>
                        </div>
                        {!isVariantJobRunning ? (
                          <Button
                            size="small"
                            type="text"
                            className="gm-dist-nowrap"
                            onClick={() => setActiveVariantJob(null)}
                          >
                            收起进度
                          </Button>
                        ) : null}
                      </div>

                      <Progress
                        size="small"
                        percent={
                          activeVariantJob.total > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  ((activeVariantJob.doneCount + activeVariantJob.failCount) /
                                    activeVariantJob.total) *
                                    100,
                                ),
                              )
                            : 0
                        }
                        status={
                          activeVariantJob.status === 'FAILED'
                            ? 'exception'
                            : activeVariantJob.status === 'COMPLETED'
                              ? 'success'
                              : isVariantJobRunning
                                ? 'active'
                                : 'normal'
                        }
                      />

                      {isVariantJobRunning ? (
                        <div className="gm-dist-muted">
                          刷新页面或关闭抽屉后任务仍会在后台继续，重新打开即可恢复进度；单渠道失败将自动退还对应点数。
                        </div>
                      ) : null}

                      {activeVariantJob.failures.length > 0 ? (
                        <div className="gm-dist-col gm-dist-col--xs">
                          {activeVariantJob.failures.map((item) => (
                            <div
                              key={`${item.index}-${item.provider}`}
                              className="gm-dist-job-failure-item"
                            >
                              • 「{item.channelLabel}」生成失败：{item.error}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Citation-Driven Highlights */}
                  {effectiveRecommendedChannels.length > 0 ? (
                    <div className="gm-dist-rec-box">
                      <div className="gm-dist-rec-title">AI 高频被引阵地推荐</div>
                      <div className="gm-dist-grid-rec">
                        {effectiveRecommendedChannels.map((rec) => {
                          const safeUrls = (rec.citedExampleUrls ?? [])
                            .filter((u) => isSafePublicExternalHttpUrl(u))
                            .slice(0, 3);
                          return (
                            <div key={rec.channel} className="gm-dist-rec-item">
                              <div className="gm-dist-rec-item-head">
                                <span className="gm-dist-rec-name">{rec.channel}</span>
                                {rec.priority ? (
                                  <StatusBadge
                                    tone={rec.priority === 'HIGH' ? 'warning' : 'active'}
                                    className="gm-studio-nowrap"
                                  >
                                    {rec.priority === 'HIGH' ? '高优先被引' : '推荐阵地'}
                                  </StatusBadge>
                                ) : null}
                              </div>
                              <div className="gm-studio-text-secondary">{rec.reason}</div>
                              {safeUrls.length > 0 ? (
                                <div className="gm-studio-row gm-studio-row--wrap">
                                  {safeUrls.map((url, idx) => (
                                    <a
                                      key={url}
                                      href={url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="gm-mono gm-studio-cited-link"
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
                  <div className="gm-dist-l1-section">
                    <div className="gm-dist-l1-head-row">
                      <div className="gm-studio-publish-subcard-title">
                        <Tooltip title={UX_GLOSSARY_TOOLTIPS.channelModeL1}>
                          <span className="gm-studio-glossary-trigger">
                            1. {UX_TERMS.channelModeL1}（已连接自有站点 · 支持一键推草稿 / 上线）
                          </span>
                        </Tooltip>
                      </div>
                      {brandId && brandMarketId ? (
                        <Button
                          size="small"
                          type="default"
                          data-testid="studio-inline-bind-connection-btn"
                          disabled={readOnly}
                          className="gm-brand-btn-nowrap"
                          onClick={() => setInlineBindModalOpen(true)}
                        >
                          快捷绑站
                        </Button>
                      ) : null}
                    </div>
                    {disabledConnectionsCount > 0 ? (
                      <div
                        className="gm-dist-l1-disabled-hint"
                        data-testid="studio-distribution-disabled-conns-hint"
                      >
                        已停用 {disabledConnectionsCount} 个连接（已自动隐藏，可在「品牌资产 →
                        发布渠道」重新启用）
                      </div>
                    ) : null}
                    {l1Options.length === 0 ? (
                      <div className="gm-dist-l1-empty-box">
                        <span className="gm-dist-l1-empty-text">
                          {market === 'CN'
                            ? '当前市场尚未绑定微信公众号草稿箱 / WordPress / Webhook 渠道连接。'
                            : '当前市场尚未绑定 Shopify / WordPress / Webflow / Ghost / Dev.to / Hashnode / GitHub MDX / Webhook 渠道连接。'}
                        </span>
                        {onNavigateBrands ? (
                          <Button
                            size="small"
                            className="gm-brand-btn-nowrap"
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
                      <div className="gm-dist-grid-cards">
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
                              className={`gm-dist-target-card${selected ? ' gm-dist-target-card--selected' : ''}${readOnly ? ' gm-dist-target-card--readonly' : ''}`}
                            >
                              <span
                                className="gm-dist-target-check"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Checkbox
                                  checked={selected}
                                  disabled={readOnly}
                                  aria-label={opt.channelLabel}
                                  onChange={() => toggleTargetKey(opt.key)}
                                />
                              </span>
                              <div className="gm-dist-target-content">
                                <div className="gm-dist-row gm-dist-row--tight gm-dist-min0">
                                  <span className="gm-dist-target-name">{opt.channelLabel}</span>
                                  <Tag className="gm-studio-tag-nowrap">{opt.description}</Tag>
                                  {opt.targetLocale ? (
                                    <StatusBadge tone="active" className="gm-studio-nowrap">
                                      {opt.targetLocale}
                                    </StatusBadge>
                                  ) : null}
                                  {opt.connectionStatus === 'INVALID' ? (
                                    <StatusBadge tone="danger" className="gm-studio-nowrap">
                                      连接异常
                                    </StatusBadge>
                                  ) : null}
                                </div>
                                {opt.siteBaseUrl ? (
                                  <div className="gm-mono gm-studio-text-muted">
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

                  {/* Group 1.5 (CN Only): L2 Chrome Extension Queue */}
                  {l2ExtensionOptions.length > 0 ? (
                    <div
                      data-testid="distribution-l2-extension-group"
                      className="gm-dist-col gm-dist-col--md"
                    >
                      <div className="gm-dist-row gm-dist-row--between">
                        <span className="gm-dist-group-title">
                          国内平台浏览器扩展队列（L2 Chrome 扩展 · 写入草稿箱人工确认，不自动发布）
                        </span>
                        {onNavigateExtensionPairing || onNavigateBrands ? (
                          <Button
                            size="small"
                            type="link"
                            className="gm-dist-link-btn"
                            onClick={() => {
                              onClose();
                              (onNavigateExtensionPairing ?? onNavigateBrands)?.();
                            }}
                          >
                            管理扩展配对令牌 →
                          </Button>
                        ) : null}
                      </div>
                      <div className="gm-dist-grid-cards">
                        {l2ExtensionOptions.map((opt) => {
                          const selected = selectedTargetKeys.includes(opt.key);
                          return (
                            <div
                              key={opt.key}
                              role="presentation"
                              data-testid={`distribution-target-${opt.provider}`}
                              onClick={() => {
                                if (!readOnly) toggleTargetKey(opt.key);
                              }}
                              className={`gm-dist-target-card${selected ? ' gm-dist-target-card--selected' : ''}${readOnly ? ' gm-dist-target-card--readonly' : ''}`}
                            >
                              <span
                                className="gm-dist-target-check"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Checkbox
                                  checked={selected}
                                  disabled={readOnly}
                                  aria-label={opt.channelLabel}
                                  onChange={() => toggleTargetKey(opt.key)}
                                />
                              </span>
                              <div className="gm-dist-target-content">
                                <div className="gm-dist-row gm-dist-row--tight gm-dist-min0">
                                  <span className="gm-dist-target-name">{opt.channelLabel}</span>
                                  <StatusBadge tone="active" className="gm-studio-nowrap">
                                    Chrome 扩展
                                  </StatusBadge>
                                  {opt.recommendedPriority === 'HIGH' ? (
                                    <StatusBadge tone="warning" className="gm-studio-nowrap">
                                      高频被引
                                    </StatusBadge>
                                  ) : null}
                                </div>
                                <div className="gm-studio-text-muted">{opt.description}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Group 2: L3 Community Assist */}
                  <div className="gm-dist-col gm-dist-col--md">
                    <div className="gm-studio-publish-subcard-title">
                      <Tooltip title={UX_GLOSSARY_TOOLTIPS.channelModeL3Community}>
                        <span className="gm-studio-glossary-trigger">
                          2. {UX_TERMS.channelModeL3Community}（人工辅发 · 不自动发帖）
                        </span>
                      </Tooltip>
                    </div>
                    <div className="gm-dist-grid-cards">
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
                            className={`gm-dist-target-card${selected ? ' gm-dist-target-card--selected' : ''}${readOnly ? ' gm-dist-target-card--readonly' : ''}`}
                          >
                            <span
                              className="gm-dist-target-check"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Checkbox
                                checked={selected}
                                disabled={readOnly}
                                aria-label={opt.channelLabel}
                                onChange={() => toggleTargetKey(opt.key)}
                              />
                            </span>
                            <div className="gm-dist-target-content">
                              <div className="gm-dist-row gm-dist-row--tight gm-dist-min0">
                                <span className="gm-dist-target-name">{opt.channelLabel}</span>
                                {opt.recommendedPriority === 'HIGH' ? (
                                  <StatusBadge tone="warning" className="gm-studio-nowrap">
                                    高频被引
                                  </StatusBadge>
                                ) : null}
                              </div>
                              <div className="gm-studio-text-muted">{opt.description}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Group 3: L3 PR Packet */}
                  <div className="gm-dist-col gm-dist-col--md">
                    <div className="gm-studio-publish-subcard-title">
                      <Tooltip title={UX_GLOSSARY_TOOLTIPS.channelModeL3Pr}>
                        <span className="gm-studio-glossary-trigger">
                          3. {UX_TERMS.channelModeL3Pr}（外部媒体协作包 · 免登录链接）
                        </span>
                      </Tooltip>
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
                          className={`gm-dist-target-card${selected ? ' gm-dist-target-card--selected' : ''}${readOnly ? ' gm-dist-target-card--readonly' : ''}`}
                        >
                          <span
                            className="gm-dist-target-check"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Checkbox
                              checked={selected}
                              disabled={readOnly}
                              aria-label={opt.channelLabel}
                              onChange={() => toggleTargetKey(opt.key)}
                            />
                          </span>
                          <div className="gm-dist-target-content">
                            <div className="gm-dist-target-name">{opt.channelLabel}</div>
                            <div className="gm-dist-target-desc">{opt.description}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Step 3: Multi-Channel Variant Tab Editor */}
                <div data-testid="distribution-variant-tabs" className="gm-dist-section-card">
                  <div className="gm-dist-card-title">Step 3 · 多渠道变体编辑与一键分发</div>

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
                          <span className="gm-dist-tab-label">
                            <span className="gm-dist-tab-name">{task.channelLabel}</span>
                            <Tag className="gm-studio-tag-nowrap">
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

      {brandId && brandMarketId ? (
        <ChannelConnectionCreateModal
          open={inlineBindModalOpen}
          brandId={brandId}
          activeMarket={market}
          readOnly={readOnly}
          supportedLocales={effectiveSupportedLocales}
          onClose={() => setInlineBindModalOpen(false)}
          onSaved={(saved) => {
            setConnections((prev) => [saved, ...prev.filter((c) => c.id !== saved.id)]);
            skipNextSelfConnectionsRefreshRef.current = true;
            try {
              invalidateFreshness('channel-connections');
            } finally {
              skipNextSelfConnectionsRefreshRef.current = false;
            }
          }}
          onTested={(connId, res) => {
            setConnections((prev) =>
              prev.map((item) =>
                item.id === connId
                  ? {
                      ...item,
                      status: res.status,
                      lastTestedAt: res.testedAt,
                      lastError: res.ok ? null : res.message,
                    }
                  : item,
              ),
            );
            skipNextSelfConnectionsRefreshRef.current = true;
            try {
              invalidateFreshness('channel-connections');
            } finally {
              skipNextSelfConnectionsRefreshRef.current = false;
            }
          }}
        />
      ) : null}

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
        <div data-testid="distribution-points-confirm-modal" className="gm-dist-confirm-modal">
          <div className="gm-dist-confirm-summary">
            即将为当前成稿并行生成 <strong className="gm-num">{selectedTargets.length}</strong>{' '}
            个目标渠道的专属变体：
          </div>

          <div className="gm-dist-row gm-dist-row--tight gm-dist-min0">
            {selectedTargets.map((opt) => (
              <Tag key={opt.key} className="gm-studio-tag-wrap">
                {opt.channelLabel}
              </Tag>
            ))}
          </div>

          <div className="gm-dist-confirm-box">
            {unitPrice === 0 ? (
              <div className="gm-dist-confirm-free">限时免费（0 积分，不扣减点数）</div>
            ) : (
              <div>
                预计消耗：
                <strong className="gm-num gm-dist-text-phosphor">
                  {selectedTargets.length} × {unitPrice} = {totalEstimatedPoints} 点
                </strong>
                （单价 <span className="gm-num">{unitPrice}</span>{' '}
                点/渠道，生成失败自动退还对应点数）
              </div>
            )}

            {typeof walletAvailable === 'number' ? (
              <div className="gm-dist-check-label">
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
