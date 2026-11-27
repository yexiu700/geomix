'use client';

import {
  CRAWL_PROBE_STATUS_LABELS,
  DEFAULT_RETEST_MILESTONE_DAYS,
  RETEST_SCHEDULE_STATUS_LABELS,
  UX_GLOSSARY_TOOLTIPS,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  VISIBILITY_SENTIMENT_LABELS,
  enginesForMarket,
  formatShanghaiDate,
  formatShanghaiDateTime,
  isSafeHttpPublishedUrl,
  type ConfidenceLevel,
  type CrawlProbeReport,
  type CrawlProbeStatus,
  type DidDirection,
  type GeoArticleRecord,
  type GeoMarket,
  type GeoPublishRecordDto,
  type GeoRetestScheduleDto,
  type PublishRecordCreateInput,
  type RetestSampleCount,
  type RetestScheduleConfigInput,
  type RetestScheduleStatus,
  type VisibilitySentiment,
  type WilsonInterval,
} from '@geomix/shared';
import { Button, Checkbox, Input, Spin, Tag } from 'antd';
import type { FormEvent, JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authorizedRequest } from '../../lib/api';
import { truncateMiddle } from '../../lib/design-tokens';
import {
  getRetestBudget,
  triggerCrawlProbe,
  updateRetestSchedules,
  type RetestBudgetEstimateDto,
} from '../../lib/distribution';
import { GatewayApiError, unwrapEnvelope } from '../../lib/envelope';
import { formatRetestDeltaSummary } from '../../lib/home';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { fetchVisibilityEngines, filterEnginesForMarket } from '../../lib/visibility';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalPill, type SignalTone } from '../geo/primitives';
import { Explain, StatusBadge, type StatusTone } from '../ui';

export type StudioPublishRetestProps = {
  activeMarket: GeoMarket;
  article: GeoArticleRecord | null;
  publishRecords: readonly GeoPublishRecordDto[];
  recordsLoading: boolean;
  retestingRecordId: string | null;
  pollingRetestRecordId: string | null;
  readOnly: boolean;
  onCreatePublishRecord: (input: PublishRecordCreateInput) => Promise<boolean | void>;
  onTriggerRetest: (record: GeoPublishRecordDto) => Promise<void>;
  onPublishRecordUpdated?: (record: GeoPublishRecordDto) => void;
};

type CrawlOverridePatch = Pick<
  GeoPublishRecordDto,
  'crawlStatus' | 'crawlCheckedAt' | 'crawlReportJson'
>;

type CrawlOverrideEntry = {
  baseRecord: GeoPublishRecordDto;
  patch: CrawlOverridePatch;
};

type ScheduleOverrideEntry = {
  baseRecord: GeoPublishRecordDto;
  items: GeoRetestScheduleDto[];
};

const CN_CHANNELS = [
  '官网博客',
  '知乎',
  '什么值得买',
  '今日头条',
  '微信公众号',
  '小红书',
  '媒体评测',
  '其他',
] as const;

const GLOBAL_CHANNELS = [
  'Official Blog / Docs',
  'Reddit',
  'Quora',
  'Tech Review Media',
  'YouTube',
  'Other',
] as const;

function formatActionError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

async function fetchLiveVisibilityUnitPrice(signal?: AbortSignal): Promise<number> {
  if (typeof window === 'undefined') return VISIBILITY_DEFAULT_UNIT_POINTS;
  try {
    const response = await authorizedRequest(window.sessionStorage, 'GET', '/pricing', {
      signal,
    });
    const data = await unwrapEnvelope<{
      items: Array<{ action: string; unitPoints: number; enabled?: boolean }>;
    }>(response);
    const row = data.items.find((item) => item.action === 'visibility_check');
    if (
      row &&
      typeof row.unitPoints === 'number' &&
      Number.isFinite(row.unitPoints) &&
      row.unitPoints > 0
    ) {
      return row.unitPoints;
    }
  } catch {
    // Fallback gracefully on unauthenticated/expired tenant or network failure
  }
  return VISIBILITY_DEFAULT_UNIT_POINTS;
}

function crawlStatusTone(status: CrawlProbeStatus): StatusTone {
  switch (status) {
    case 'OK':
      return 'success';
    case 'WARNING':
      return 'warning';
    case 'BLOCKED':
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function scheduleStatusTone(status: RetestScheduleStatus): StatusTone {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'RUNNING':
    case 'PENDING':
      return 'active';
    case 'SKIPPED_INSUFFICIENT_POINTS':
    case 'SKIPPED_NO_ENGINE':
    case 'SKIPPED_BUDGET_CAP':
      return 'warning';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  HIGH: '高置信',
  MEDIUM: '中置信',
  LOW: '低置信',
  INSUFFICIENT: '样本不足',
};

const CONFIDENCE_TONE: Record<ConfidenceLevel, SignalTone> = {
  HIGH: 'cited',
  MEDIUM: 'info',
  LOW: 'warning',
  INSUFFICIENT: 'neutral',
};

const DID_DIRECTION_LABELS: Record<DidDirection, string> = {
  POSITIVE: '正向净增益',
  NEGATIVE: '负向变化',
  NEUTRAL: '无显著净差',
};

const DID_DIRECTION_TONE: Record<DidDirection, SignalTone> = {
  POSITIVE: 'cited',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
};

function resolveConfidenceTone(level: unknown): SignalTone {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(CONFIDENCE_TONE, level)
    ? CONFIDENCE_TONE[level as ConfidenceLevel]
    : 'neutral';
}

function resolveConfidenceLabel(level: unknown): string {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(CONFIDENCE_LABELS, level)
    ? CONFIDENCE_LABELS[level as ConfidenceLevel]
    : '样本不足';
}

function resolveDidDirectionTone(direction: unknown): SignalTone {
  return typeof direction === 'string' &&
    Object.prototype.hasOwnProperty.call(DID_DIRECTION_TONE, direction)
    ? DID_DIRECTION_TONE[direction as DidDirection]
    : 'neutral';
}

function resolveDidDirectionLabel(direction: unknown): string {
  return typeof direction === 'string' &&
    Object.prototype.hasOwnProperty.call(DID_DIRECTION_LABELS, direction)
    ? DID_DIRECTION_LABELS[direction as DidDirection]
    : '无显著净差';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidWilson(wilson: WilsonInterval | null | undefined): wilson is WilsonInterval {
  return Boolean(
    wilson &&
    isFiniteNumber(wilson.lower) &&
    isFiniteNumber(wilson.upper) &&
    isFiniteNumber(wilson.trials) &&
    wilson.trials > 0,
  );
}

function formatDidPp(fraction: number): string {
  const pp = fraction * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function formatLiveBudgetText(budget: RetestBudgetEstimateDto): string {
  if (budget.activeEngineCount <= 0) {
    return '当前市场暂无在线引擎，节点到期时将自动跳过且不产生扣费。';
  }
  const controlNote =
    budget.includeControlPrompts && budget.effectiveControlPromptCount > 0
      ? `（含 ${budget.effectiveControlPromptCount} 条对照）`
      : '';
  if (budget.pendingMilestoneCount <= 0) {
    if (budget.perRunPoints <= 0) {
      return '当前无待执行自动节点，节点开启后将按实时引擎定价核算预算上限。';
    }
    return `当前无待执行自动节点；单次复测上限 ${budget.totalPromptCount} 问句${controlNote} × ${budget.activeEngineCount} 活跃引擎 × ${budget.sampleCount} 次采样 × ${budget.unitPrice} 点 = ${budget.perRunPoints} 点（余额不足自动温和跳过，绝不透支）。`;
  }
  if (budget.totalEstimatedPoints <= 0) {
    return `当前 ${budget.pendingMilestoneCount} 个待执行节点将按当前计费规则自动运行，余额不足时自动温和跳过。`;
  }
  return `预计预算上限：${budget.pendingMilestoneCount} 节点 × ${budget.totalPromptCount} 问句${controlNote} × ${budget.activeEngineCount} 活跃引擎 × ${budget.sampleCount} 次采样 × ${budget.unitPrice} 点 = 上限 ${budget.totalEstimatedPoints} 点（单次 ${budget.perRunPoints} 点）；余额不足时自动温和跳过，绝不透支。`;
}

function formatBudgetCeilingText(params: {
  enabledMilestones: number;
  onlineEngineCount: number;
  sampleCount: RetestSampleCount;
  unitPrice: number;
}): string {
  const { enabledMilestones, onlineEngineCount, sampleCount, unitPrice } = params;
  if (onlineEngineCount <= 0) {
    return '当前市场暂无在线引擎，节点到期时将自动跳过且不产生扣费。';
  }
  if (enabledMilestones <= 0) {
    const perRun = onlineEngineCount * sampleCount * unitPrice;
    return `当前无待执行自动节点；单次复测上限 ${onlineEngineCount} 活跃引擎 × ${sampleCount} 次采样 × ${unitPrice} 点 = ${perRun} 点（余额不足自动温和跳过，绝不透支）。`;
  }
  const ceiling = enabledMilestones * onlineEngineCount * sampleCount * unitPrice;
  return `预计预算上限：${enabledMilestones} 节点 × ${onlineEngineCount} 活跃引擎 × ${sampleCount} 次采样 × ${unitPrice} 点 = 上限 ${ceiling} 点；余额不足时自动温和跳过，绝不透支。`;
}

function formatPercent(val: number): string {
  if (!Number.isFinite(val)) return '—';
  return Number.isInteger(val) ? `${val}%` : `${val.toFixed(1)}%`;
}

function formatMentionDelta(before: number | undefined, after: number): string | null {
  if (typeof before !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  const diff = Number((after - before).toFixed(1));
  if (diff > 0) return `+${diff}%`;
  if (diff < 0) return `${diff}%`;
  return '持平';
}

function formatSentimentLabel(sentiment: string | null | undefined): string | null {
  if (!sentiment) return null;
  const known = VISIBILITY_SENTIMENT_LABELS[sentiment as VisibilitySentiment];
  return known ?? sentiment;
}

function hasCrawlDiagnostics(
  status: CrawlProbeStatus,
  report: CrawlProbeReport | null | undefined,
): boolean {
  if (!report) return false;
  return (
    status === 'BLOCKED' ||
    status === 'FAILED' ||
    status === 'WARNING' ||
    report.metaNoindex ||
    report.jsonLdParseErrors.length > 0 ||
    report.issues.length > 0 ||
    Boolean(report.errorMessage) ||
    report.canonicalMatches === false ||
    report.robotsMatrix.some((item) => !item.allowed)
  );
}

function resolveFallbackSchedule(
  schedules: GeoRetestScheduleDto[],
): GeoRetestScheduleDto | undefined {
  return (
    schedules.find((s) => s.status === 'PENDING') ??
    schedules.find((s) => s.status === 'CANCELLED') ??
    schedules[0]
  );
}

export function StudioPublishRetest({
  activeMarket,
  article,
  publishRecords,
  recordsLoading,
  retestingRecordId,
  pollingRetestRecordId,
  readOnly,
  onCreatePublishRecord,
  onTriggerRetest,
  onPublishRecordUpdated,
}: StudioPublishRetestProps): JSX.Element {
  const feedback = useUxFeedback();
  const channelOptions = activeMarket === 'GLOBAL' ? GLOBAL_CHANNELS : CN_CHANNELS;

  const [urlInput, setUrlInput] = useState('');
  const [channel, setChannel] = useState<string>(channelOptions[0]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form auto-retest toggle & sampling config (default: enabled=true, sampleCount=1)
  const [autoRetestEnabled, setAutoRetestEnabled] = useState(true);
  const [formSampleCount, setFormSampleCount] = useState<RetestSampleCount>(1);
  const [formAdvancedOpen, setFormAdvancedOpen] = useState(false);

  // Live pricing & online engine count for PRD D3 budget ceiling disclosure
  const [visibilityUnitPrice, setVisibilityUnitPrice] = useState<number>(
    VISIBILITY_DEFAULT_UNIT_POINTS,
  );
  const [onlineEngineCount, setOnlineEngineCount] = useState<number>(
    () => enginesForMarket(activeMarket).length,
  );

  // Local reconciled overrides so crawl probes & schedule toggles update UI immediately,
  // keyed by the original publishRecords prop object reference so fresher server props win automatically.
  const [crawlOverrides, setCrawlOverrides] = useState<Record<string, CrawlOverrideEntry>>({});
  const [scheduleOverrides, setScheduleOverrides] = useState<Record<string, ScheduleOverrideEntry>>(
    {},
  );
  const [probingRecordId, setProbingRecordId] = useState<string | null>(null);
  const [updatingScheduleRecordId, setUpdatingScheduleRecordId] = useState<string | null>(null);
  const [expandedCrawlIds, setExpandedCrawlIds] = useState<Record<string, boolean>>({});
  const [expandedAdvancedIds, setExpandedAdvancedIds] = useState<Record<string, boolean>>({});
  const [liveBudgets, setLiveBudgets] = useState<Record<string, RetestBudgetEstimateDto>>({});

  const submittingRef = useRef(false);
  const probingRef = useRef(false);
  const updatingScheduleRef = useRef(false);
  const contextKeyRef = useRef(0);
  const crawlCtrlRef = useRef<AbortController | null>(null);
  const scheduleCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    contextKeyRef.current += 1;
    submittingRef.current = false;
    probingRef.current = false;
    updatingScheduleRef.current = false;
    crawlCtrlRef.current?.abort();
    crawlCtrlRef.current = null;
    scheduleCtrlRef.current?.abort();
    scheduleCtrlRef.current = null;
    setSubmitting(false);
    setChannel(activeMarket === 'GLOBAL' ? GLOBAL_CHANNELS[0] : CN_CHANNELS[0]);
    setUrlInput('');
    setUrlError(null);
    setAutoRetestEnabled(true);
    setFormSampleCount(1);
    setFormAdvancedOpen(false);
    setCrawlOverrides({});
    setScheduleOverrides({});
    setProbingRecordId(null);
    setUpdatingScheduleRecordId(null);
    setExpandedCrawlIds({});
    setExpandedAdvancedIds({});
    setLiveBudgets({});
    return () => {
      submittingRef.current = false;
      probingRef.current = false;
      updatingScheduleRef.current = false;
      crawlCtrlRef.current?.abort();
      scheduleCtrlRef.current?.abort();
    };
  }, [activeMarket, article?.id]);

  // Fetch live visibility_check price & online engine count strictly scoped to [articleBrandId, activeMarket]
  const articleBrandId = article?.brandId ?? null;
  const articleMatchesMarket = Boolean(article && article.market === activeMarket);
  useEffect(() => {
    setOnlineEngineCount(enginesForMarket(activeMarket).length);
    if (!articleBrandId || !articleMatchesMarket) {
      return;
    }
    const ctrl = new AbortController();

    void (async () => {
      const [priceRes, enginesRes] = await Promise.allSettled([
        fetchLiveVisibilityUnitPrice(ctrl.signal),
        fetchVisibilityEngines(articleBrandId, activeMarket, { signal: ctrl.signal }),
      ]);
      if (ctrl.signal.aborted) return;

      if (priceRes.status === 'fulfilled') {
        setVisibilityUnitPrice(priceRes.value);
      }
      if (enginesRes.status === 'fulfilled') {
        const marketEngines = filterEnginesForMarket(enginesRes.value.engines, activeMarket);
        const availableCount = marketEngines.filter((engine) => engine.available).length;
        setOnlineEngineCount(availableCount);
      } else {
        setOnlineEngineCount(enginesForMarket(activeMarket).length);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [articleBrandId, articleMatchesMarket, activeMarket]);

  const effectiveEntries = useMemo(() => {
    return publishRecords.map((raw) => {
      const crawlEntry = crawlOverrides[raw.id];
      const scheduleEntry = scheduleOverrides[raw.id];
      const crawlPatch = crawlEntry && crawlEntry.baseRecord === raw ? crawlEntry.patch : undefined;
      const schedulePatch =
        scheduleEntry && scheduleEntry.baseRecord === raw ? scheduleEntry.items : undefined;
      if (!crawlPatch && !schedulePatch) {
        return { raw, rec: raw };
      }
      return {
        raw,
        rec: {
          ...raw,
          ...(crawlPatch ?? {}),
          ...(schedulePatch ? { retestSchedules: schedulePatch } : {}),
        },
      };
    });
  }, [publishRecords, crawlOverrides, scheduleOverrides]);

  const budgetQueryKey = useMemo(() => {
    return effectiveEntries
      .map(({ rec }) => {
        const schedules = rec.retestSchedules ?? [];
        const pending = schedules.filter((s) => s.status === 'PENDING');
        const fallbackSchedule = resolveFallbackSchedule(schedules);
        const sampleCount = fallbackSchedule?.sampleCount ?? 1;
        const includeControlPrompts = Boolean(fallbackSchedule?.includeControlPrompts);
        const days = pending
          .map((s) => s.milestoneDay)
          .sort((a, b) => a - b)
          .join(',');
        return `${rec.id}|${sampleCount}|${includeControlPrompts ? '1' : '0'}|${days}`;
      })
      .join(';');
  }, [effectiveEntries]);

  useEffect(() => {
    if (effectiveEntries.length === 0 || (article && !articleMatchesMarket)) {
      setLiveBudgets({});
      return;
    }
    setLiveBudgets({});
    const ctrl = new AbortController();
    const seq = contextKeyRef.current;

    void Promise.allSettled(
      effectiveEntries.map(async ({ rec }) => {
        const schedules = rec.retestSchedules ?? [];
        const pending = schedules.filter((s) => s.status === 'PENDING');
        const fallbackSchedule = resolveFallbackSchedule(schedules);
        const sampleCount: RetestSampleCount = fallbackSchedule?.sampleCount ?? 1;
        const includeControlPrompts = Boolean(fallbackSchedule?.includeControlPrompts);
        const pendingDays = pending.map((s) => s.milestoneDay).sort((a, b) => a - b);
        const res = await getRetestBudget(
          rec.id,
          {
            sampleCount,
            includeControlPrompts,
            ...(pendingDays.length > 0 ? { milestones: pendingDays } : {}),
          },
          { storage: window.sessionStorage, signal: ctrl.signal },
        );
        return { recordId: rec.id, budget: res };
      }),
    ).then((results) => {
      if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
      const next: Record<string, RetestBudgetEstimateDto> = {};
      for (const item of results) {
        if (item.status === 'fulfilled' && item.value?.budget) {
          next[item.value.recordId] = item.value.budget;
        }
      }
      setLiveBudgets(next);
    });

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetQueryKey, activeMarket, article?.id, articleMatchesMarket]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!article || readOnly || submittingRef.current) return;
    const trimmedUrl = urlInput.trim();
    if (!isSafeHttpPublishedUrl(trimmedUrl)) {
      setUrlError('请输入有效的 http:// 或 https:// 已发布文章链接');
      return;
    }
    submittingRef.current = true;
    const seq = contextKeyRef.current;
    setUrlError(null);
    setSubmitting(true);

    // Payload compatibility rule: omit `autoRetest` when in default state (enabled=true, sampleCount=1)
    // so server defaults to [7, 14, 30] / sampleCount=1 AND existing specs asserting exact payload pass.
    const payload: PublishRecordCreateInput =
      autoRetestEnabled && formSampleCount === 1
        ? {
            publishedUrl: trimmedUrl,
            channel: channel || channelOptions[0],
          }
        : !autoRetestEnabled
          ? {
              publishedUrl: trimmedUrl,
              channel: channel || channelOptions[0],
              autoRetest: { enabled: false },
            }
          : {
              publishedUrl: trimmedUrl,
              channel: channel || channelOptions[0],
              autoRetest: {
                enabled: true,
                milestones: [...DEFAULT_RETEST_MILESTONE_DAYS],
                sampleCount: formSampleCount,
              },
            };

    try {
      const result = await onCreatePublishRecord(payload);
      if (seq === contextKeyRef.current && result !== false) {
        setUrlInput('');
      }
    } catch {
      // Preserve urlInput on rejection and swallow unhandled rejection cleanly
    } finally {
      if (seq === contextKeyRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const handleCrawlRecheck = useCallback(
    async (rawRecord: GeoPublishRecordDto) => {
      if (readOnly || probingRef.current) return;
      probingRef.current = true;
      const seq = contextKeyRef.current;
      crawlCtrlRef.current?.abort();
      const ctrl = new AbortController();
      crawlCtrlRef.current = ctrl;
      setProbingRecordId(rawRecord.id);

      try {
        const updated = await triggerCrawlProbe(rawRecord.id, { signal: ctrl.signal });
        if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
        setCrawlOverrides((prev) => ({
          ...prev,
          [rawRecord.id]: {
            baseRecord: rawRecord,
            patch: {
              crawlStatus: updated.crawlStatus,
              crawlCheckedAt: updated.crawlCheckedAt,
              crawlReportJson: updated.crawlReportJson,
            },
          },
        }));
        if (updated.retestSchedules) {
          setScheduleOverrides((prev) => ({
            ...prev,
            [rawRecord.id]: {
              baseRecord: rawRecord,
              items: updated.retestSchedules ?? [],
            },
          }));
        }
        setExpandedCrawlIds((prev) => ({ ...prev, [rawRecord.id]: true }));
        onPublishRecordUpdated?.(updated);
        invalidateFreshness('publish-records');
        feedback.notifySuccess(
          `抓取与结构化体检已完成：${CRAWL_PROBE_STATUS_LABELS[updated.crawlStatus ?? 'PENDING']}`,
        );
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
        feedback.notifyError(formatActionError(err, '执行抓取体检失败，请稍后重试'));
      } finally {
        if (crawlCtrlRef.current === ctrl) {
          crawlCtrlRef.current = null;
        }
        if (seq === contextKeyRef.current) {
          probingRef.current = false;
          setProbingRecordId(null);
        }
      }
    },
    [readOnly, onPublishRecordUpdated, feedback],
  );

  const handleUpdateSchedules = useCallback(
    async (
      rawRecord: GeoPublishRecordDto,
      effectiveRecord: GeoPublishRecordDto,
      input: RetestScheduleConfigInput,
      successText: string,
    ) => {
      if (readOnly || updatingScheduleRef.current) return;
      updatingScheduleRef.current = true;
      const seq = contextKeyRef.current;
      scheduleCtrlRef.current?.abort();
      const ctrl = new AbortController();
      scheduleCtrlRef.current = ctrl;
      setUpdatingScheduleRecordId(rawRecord.id);

      try {
        const res = await updateRetestSchedules(rawRecord.id, input, { signal: ctrl.signal });
        if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
        setScheduleOverrides((prev) => ({
          ...prev,
          [rawRecord.id]: {
            baseRecord: rawRecord,
            items: res.items,
          },
        }));
        onPublishRecordUpdated?.({
          ...effectiveRecord,
          retestSchedules: res.items,
        });
        invalidateFreshness('publish-records');
        feedback.notifySuccess(successText);
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
        feedback.notifyError(formatActionError(err, '更新自动复测计划失败，请稍后重试'));
      } finally {
        if (scheduleCtrlRef.current === ctrl) {
          scheduleCtrlRef.current = null;
        }
        if (seq === contextKeyRef.current) {
          updatingScheduleRef.current = false;
          setUpdatingScheduleRecordId(null);
        }
      }
    },
    [readOnly, onPublishRecordUpdated, feedback],
  );

  const formBudgetText = useMemo(
    () =>
      formatBudgetCeilingText({
        enabledMilestones: autoRetestEnabled ? DEFAULT_RETEST_MILESTONE_DAYS.length : 0,
        onlineEngineCount,
        sampleCount: formSampleCount,
        unitPrice: visibilityUnitPrice,
      }),
    [autoRetestEnabled, onlineEngineCount, formSampleCount, visibilityUnitPrice],
  );

  return (
    <div className="gm-studio-publish-box" data-testid="studio-publish-retest">
      <div className="gm-studio-delivery-subhead">
        <span className="gm-studio-section-label">发布登记</span>
        {effectiveEntries.length > 0 ? (
          <StatusBadge tone="success" className="gm-studio-nowrap">
            已登记 {effectiveEntries.length} 条
          </StatusBadge>
        ) : null}
      </div>

      {!article ? (
        <div className="gm-studio-item-meta">选择成稿后可登记发布链接并追踪复测。</div>
      ) : (
        <>
          <form
            className="gm-studio-publish-form"
            data-testid="publish-record-form"
            onSubmit={(e) => void handleSubmit(e)}
          >
            {/* URL Input MUST remain the first <input> inside publish-record-form */}
            <Input
              size="small"
              aria-label="已发布文章 URL"
              placeholder="https://example.com/guides/geo-article"
              value={urlInput}
              disabled={readOnly || submitting}
              status={urlError ? 'error' : undefined}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (urlError) setUrlError(null);
              }}
            />
            {urlError ? (
              <div className="gm-studio-inline-error" role="alert">
                {urlError}
              </div>
            ) : null}

            <div className="gm-studio-publish-row">
              <select
                aria-label="发布渠道"
                className="gm-select gm-studio-publish-channel-select"
                value={channel}
                disabled={readOnly || submitting}
                onChange={(e) => setChannel(e.target.value)}
              >
                {channelOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <Button
                size="small"
                type={effectiveEntries.length === 0 ? 'primary' : 'default'}
                htmlType="submit"
                loading={submitting}
                disabled={readOnly || !urlInput.trim()}
                className="gm-studio-nowrap"
              >
                登记发布
              </Button>
            </div>

            {/* Y24: Auto-retest checkbox + collapsible 高级 sampling & budget disclosure */}
            <div className="gm-studio-publish-subcard">
              <div className="gm-studio-row gm-studio-row--wrap gm-studio-row--between">
                <div className="gm-studio-row">
                  <Checkbox
                    data-testid="publish-auto-retest-checkbox"
                    checked={autoRetestEnabled}
                    disabled={readOnly || submitting}
                    onChange={(e) => setAutoRetestEnabled(e.target.checked)}
                    className="gm-studio-publish-checkbox"
                  >
                    自动追踪
                  </Checkbox>
                  <Explain
                    text={
                      autoRetestEnabled
                        ? formBudgetText
                        : '已关闭自动追踪，登记后不创建定时复测计划，后续可随时在下方重新开启。'
                    }
                  />
                </div>

                {autoRetestEnabled ? (
                  <Button
                    size="small"
                    type="text"
                    autoInsertSpace={false}
                    data-testid="publish-form-advanced-toggle"
                    aria-expanded={formAdvancedOpen}
                    onClick={() => setFormAdvancedOpen((v) => !v)}
                  >
                    {formAdvancedOpen ? '收起高级' : '高级'}
                  </Button>
                ) : null}
              </div>

              {autoRetestEnabled && formAdvancedOpen ? (
                <>
                  <div className="gm-studio-sample-toggle-group">
                    {([1, 3] as const).map((cnt) => {
                      const selected = formSampleCount === cnt;
                      return (
                        <Button
                          key={cnt}
                          size="small"
                          type="default"
                          aria-pressed={selected}
                          disabled={readOnly || submitting}
                          onClick={() => setFormSampleCount(cnt)}
                          className={`gm-studio-sample-btn${selected ? ' gm-studio-sample-btn--selected' : ''}`}
                        >
                          {cnt === 1 ? '1 次' : '3次采样'}
                        </Button>
                      );
                    })}
                    <Explain text={UX_GLOSSARY_TOOLTIPS.highConfidenceSampling} />
                  </div>
                  <div data-testid="publish-form-budget-ceiling" className="gm-studio-text-muted">
                    {formBudgetText}
                  </div>
                </>
              ) : null}
            </div>
          </form>

          {recordsLoading && effectiveEntries.length === 0 ? (
            <div className="gm-studio-item-meta">
              <Spin size="small" /> 正在加载发布记录…
            </div>
          ) : null}

          {effectiveEntries.length > 0 ? (
            <div className="gm-studio-publish-list">
              {effectiveEntries.map(({ raw, rec }, idx) => {
                const isPollingThis = pollingRetestRecordId === rec.id;
                const isSubmittingThis = retestingRecordId === rec.id;
                const isProbingThis = probingRecordId === rec.id;
                const isUpdatingSchedThis = updatingScheduleRecordId === rec.id;
                const delta = formatRetestDeltaSummary(rec.beforeMetrics, rec.afterMetrics);
                const safeHref = isSafeHttpPublishedUrl(rec.publishedUrl)
                  ? rec.publishedUrl
                  : undefined;

                const crawlStatus: CrawlProbeStatus = rec.crawlStatus ?? 'PENDING';
                const report = rec.crawlReportJson ?? null;
                const gptBot = report?.robotsMatrix.find((r) => r.bot === 'GPTBot');
                const perplexityBot = report?.robotsMatrix.find((r) => r.bot === 'PerplexityBot');
                const hasDiag = hasCrawlDiagnostics(crawlStatus, report);
                const defaultCrawlExpanded =
                  crawlStatus === 'BLOCKED' || crawlStatus === 'FAILED' || hasDiag;
                const isDiagExpanded = expandedCrawlIds[rec.id] ?? defaultCrawlExpanded;
                const isAdvExpanded = Boolean(expandedAdvancedIds[rec.id]);

                const schedules = rec.retestSchedules ?? [];
                const scheduleByDay = new Map<number, GeoRetestScheduleDto>();
                for (const sched of schedules) {
                  scheduleByDay.set(sched.milestoneDay, sched);
                }
                const milestoneDays = Array.from(
                  new Set<number>([
                    ...DEFAULT_RETEST_MILESTONE_DAYS,
                    ...schedules.map((s) => s.milestoneDay),
                  ]),
                ).sort((a, b) => a - b);

                const activePendingSchedules = schedules.filter((s) => s.status === 'PENDING');
                const hasPendingSchedules = activePendingSchedules.length > 0;
                const fallbackSchedule = resolveFallbackSchedule(schedules);
                const currentSampleCount: RetestSampleCount = fallbackSchedule?.sampleCount ?? 1;
                const currentIncludeControlPrompts = Boolean(
                  fallbackSchedule?.includeControlPrompts,
                );
                const liveBudget = liveBudgets[rec.id] ?? null;
                const cardBudgetText = liveBudget
                  ? formatLiveBudgetText(liveBudget)
                  : formatBudgetCeilingText({
                      enabledMilestones: activePendingSchedules.length,
                      onlineEngineCount,
                      sampleCount: currentSampleCount,
                      unitPrice: visibilityUnitPrice,
                    });

                return (
                  <div
                    key={rec.id}
                    className="gm-studio-publish-item"
                    data-testid={`publish-record-item-${rec.id}`}
                  >
                    <div className="gm-studio-delivery-subhead">
                      <Tag className="gm-studio-tag-wrap">{rec.channel}</Tag>
                      <span className="gm-studio-item-meta">
                        {formatShanghaiDateTime(rec.publishedAt)}
                      </span>
                    </div>

                    {safeHref ? (
                      <a
                        className="gm-studio-publish-link"
                        href={safeHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={rec.publishedUrl}
                      >
                        {truncateMiddle(rec.publishedUrl, 34)}
                      </a>
                    ) : (
                      <span className="gm-studio-item-meta">
                        {truncateMiddle(rec.publishedUrl, 34)}
                      </span>
                    )}

                    {/* Y25: T+1 Crawl & Schema Probe Badges (collapsed by default, auto-expanded on anomaly/recheck) */}
                    <div
                      data-testid={`publish-crawl-badges-${rec.id}`}
                      className="gm-studio-publish-subcard"
                    >
                      <div className="gm-studio-row gm-studio-row--wrap gm-studio-row--between">
                        <div className="gm-studio-row">
                          <span className="gm-studio-publish-subcard-title">抓取体检</span>
                          <StatusBadge tone={crawlStatusTone(crawlStatus)}>
                            {CRAWL_PROBE_STATUS_LABELS[crawlStatus]}
                          </StatusBadge>
                          <Explain
                            text={
                              rec.crawlCheckedAt
                                ? `${UX_GLOSSARY_TOOLTIPS.crawlSchemaProbe} 最近体检：${formatShanghaiDateTime(rec.crawlCheckedAt)}（免费体检）`
                                : `${UX_GLOSSARY_TOOLTIPS.crawlSchemaProbe} 尚未完成体检，可点击右侧「重新检测」（免费体检）。`
                            }
                          />
                        </div>
                        <div className="gm-studio-row gm-studio-row--wrap">
                          {report ? (
                            <Button
                              size="small"
                              type="link"
                              autoInsertSpace={false}
                              data-testid={`publish-crawl-detail-toggle-${rec.id}`}
                              aria-expanded={isDiagExpanded}
                              className="gm-studio-link-compact"
                              onClick={() =>
                                setExpandedCrawlIds((prev) => ({
                                  ...prev,
                                  [rec.id]: !isDiagExpanded,
                                }))
                              }
                            >
                              {isDiagExpanded ? '收起' : '详情'}
                            </Button>
                          ) : null}
                          <Button
                            size="small"
                            data-testid={`publish-crawl-recheck-btn-${rec.id}`}
                            loading={isProbingThis}
                            disabled={readOnly || Boolean(probingRecordId)}
                            onClick={() => void handleCrawlRecheck(raw)}
                            className="gm-studio-sample-btn"
                          >
                            重新检测
                          </Button>
                        </div>
                      </div>

                      {isDiagExpanded && report ? (
                        <>
                          <div className="gm-studio-row gm-studio-row--wrap">
                            <StatusBadge
                              tone={
                                report.httpStatus !== null &&
                                report.httpStatus >= 200 &&
                                report.httpStatus < 300
                                  ? 'success'
                                  : report.httpStatus !== null && report.httpStatus < 400
                                    ? 'warning'
                                    : 'danger'
                              }
                            >
                              {report.httpStatus !== null
                                ? `HTTP ${report.httpStatus}`
                                : 'HTTP 异常'}
                            </StatusBadge>

                            {gptBot ? (
                              <StatusBadge tone={gptBot.allowed ? 'success' : 'danger'}>
                                {gptBot.allowed ? 'GPTBot 允许' : 'GPTBot 拦截'}
                              </StatusBadge>
                            ) : null}

                            {perplexityBot ? (
                              <StatusBadge tone={perplexityBot.allowed ? 'success' : 'danger'}>
                                {perplexityBot.allowed
                                  ? 'PerplexityBot 允许'
                                  : 'PerplexityBot 拦截'}
                              </StatusBadge>
                            ) : null}

                            {report.metaNoindex ? (
                              <StatusBadge tone="danger">meta noindex</StatusBadge>
                            ) : null}

                            {report.jsonLdParseErrors.length > 0 ? (
                              <StatusBadge tone="danger">JSON-LD 解析异常</StatusBadge>
                            ) : report.jsonLdTypes.length > 0 ? (
                              report.jsonLdTypes.slice(0, 3).map((schemaType) => (
                                <StatusBadge
                                  key={schemaType}
                                  tone="active"
                                  className="gm-studio-tag-wrap"
                                >
                                  JSON-LD: {schemaType}
                                </StatusBadge>
                              ))
                            ) : (
                              <StatusBadge tone="danger">缺少 JSON-LD</StatusBadge>
                            )}

                            {rec.indexNowSubmitted ? (
                              <StatusBadge tone="active">IndexNow 已提交</StatusBadge>
                            ) : null}
                          </div>

                          {hasDiag ? (
                            <div
                              data-testid={`publish-crawl-diagnostics-${rec.id}`}
                              className="gm-studio-crawl-diag"
                            >
                              {report.errorMessage ? (
                                <div className="gm-studio-text-danger">
                                  请求异常：{report.errorMessage}
                                </div>
                              ) : null}

                              {report.issues.length > 0 ? (
                                <ul className="gm-studio-crawl-issues">
                                  {report.issues.map((issue, issueIdx) => (
                                    <li
                                      key={`${issue}-${issueIdx}`}
                                      className="gm-studio-text-danger"
                                    >
                                      {issue}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}

                              {report.jsonLdParseErrors.length > 0 ? (
                                <div className="gm-studio-text-danger">
                                  JSON-LD 错误：{report.jsonLdParseErrors.join('；')}
                                </div>
                              ) : null}

                              {report.canonicalMatches === false ? (
                                <div className="gm-studio-text-danger">
                                  Canonical 不一致：{report.canonicalUrl || '未声明'}
                                </div>
                              ) : null}

                              {report.robotsMatrix.length > 0 ? (
                                <div className="gm-studio-row gm-studio-row--wrap">
                                  {report.robotsMatrix.map((botRow) => (
                                    <span
                                      key={botRow.bot}
                                      className={`gm-studio-bot-chip ${
                                        botRow.allowed
                                          ? 'gm-studio-bot-chip--allowed'
                                          : 'gm-studio-bot-chip--blocked'
                                      }`}
                                    >
                                      {botRow.bot}: {botRow.allowed ? '允许' : '拦截'}
                                      {!botRow.allowed && botRow.matchedRule
                                        ? ` (${botRow.matchedRule})`
                                        : ''}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    {/* Y24: Stepped Auto-Retest Timeline with collapsible 高级 controls */}
                    <div
                      data-testid={`publish-retest-timeline-${rec.id}`}
                      className="gm-studio-publish-subcard"
                    >
                      <div className="gm-studio-row gm-studio-row--wrap gm-studio-row--between">
                        <div className="gm-studio-row">
                          <span className="gm-studio-publish-subcard-title">复测计划</span>
                          <Explain text={cardBudgetText} />
                        </div>
                        <Button
                          size="small"
                          type="text"
                          autoInsertSpace={false}
                          data-testid={`publish-retest-advanced-toggle-${rec.id}`}
                          aria-expanded={isAdvExpanded}
                          onClick={() =>
                            setExpandedAdvancedIds((prev) => ({
                              ...prev,
                              [rec.id]: !isAdvExpanded,
                            }))
                          }
                        >
                          {isAdvExpanded ? '收起高级' : '高级'}
                        </Button>
                      </div>

                      {isAdvExpanded ? (
                        <>
                          <div className="gm-studio-row gm-studio-row--wrap gm-studio-row--between">
                            <div
                              data-testid={`publish-retest-sample-toggle-${rec.id}`}
                              className="gm-studio-sample-toggle-group"
                            >
                              {([1, 3] as const).map((cnt) => {
                                const selected = currentSampleCount === cnt;
                                return (
                                  <Button
                                    key={cnt}
                                    size="small"
                                    type="default"
                                    aria-pressed={selected}
                                    loading={isUpdatingSchedThis && currentSampleCount !== cnt}
                                    disabled={
                                      readOnly ||
                                      Boolean(updatingScheduleRecordId) ||
                                      !hasPendingSchedules
                                    }
                                    title={
                                      !hasPendingSchedules
                                        ? '当前无待执行复测节点，请先开启至少一个节点后再切换采样模式'
                                        : undefined
                                    }
                                    onClick={() => {
                                      if (!hasPendingSchedules || cnt === currentSampleCount)
                                        return;
                                      void handleUpdateSchedules(
                                        raw,
                                        rec,
                                        { sampleCount: cnt },
                                        `已切换为 ${cnt === 1 ? '1 次标准采样' : '3 次高置信采样'}`,
                                      );
                                    }}
                                    className={`gm-studio-sample-btn${selected ? ' gm-studio-sample-btn--selected' : ''}`}
                                  >
                                    {cnt === 1 ? '1 次' : '3次采样'}
                                  </Button>
                                );
                              })}
                              <Explain text={UX_GLOSSARY_TOOLTIPS.highConfidenceSampling} />
                            </div>

                            <Checkbox
                              data-testid={`publish-retest-control-toggle-${rec.id}`}
                              checked={currentIncludeControlPrompts}
                              disabled={
                                readOnly ||
                                Boolean(updatingScheduleRecordId) ||
                                !hasPendingSchedules
                              }
                              onChange={(e) => {
                                if (!hasPendingSchedules) return;
                                const nextChecked = e.target.checked;
                                void handleUpdateSchedules(
                                  raw,
                                  rec,
                                  { includeControlPrompts: nextChecked },
                                  nextChecked
                                    ? '已开启对照组 DiD 归因复测'
                                    : '已关闭对照组 DiD 归因复测',
                                );
                              }}
                              className="gm-studio-publish-checkbox gm-studio-publish-checkbox--muted"
                            >
                              对照组 DiD
                            </Checkbox>
                            {liveBudget?.includeControlPrompts &&
                            liveBudget.effectiveControlPromptCount > 0 ? (
                              <StatusBadge tone="active">
                                含 {liveBudget.effectiveControlPromptCount} 条对照
                              </StatusBadge>
                            ) : null}
                          </div>

                          <div
                            data-testid={`publish-retest-budget-${rec.id}`}
                            className="gm-studio-text-muted"
                          >
                            {cardBudgetText}
                          </div>

                          {liveBudget?.includeControlPrompts &&
                          liveBudget.configuredControlPromptCount === 0 ? (
                            <div
                              data-testid={`publish-retest-zero-controls-hint-${rec.id}`}
                              className="gm-studio-text-warning"
                            >
                              当前品牌市场尚未配置对照组问句，本次将仅监测目标问句；可前往品牌设置添加最多
                              5 条对照组问句以计算 DiD 净增益。
                            </div>
                          ) : null}

                          {liveBudget &&
                          liveBudget.billingMode === 'STRICT' &&
                          liveBudget.perRunPoints > 0 &&
                          !liveBudget.sufficientForNextRun ? (
                            <div
                              data-testid={`publish-retest-insufficient-hint-${rec.id}`}
                              className="gm-studio-text-warning"
                            >
                              当前可用余额低于下次复测上限（{liveBudget.perRunPoints}{' '}
                              点），到期时将自动温和跳过且不产生扣费。
                            </div>
                          ) : null}
                        </>
                      ) : null}

                      <div className="gm-studio-stack">
                        {/* T+0 Baseline Node */}
                        <div className="gm-studio-milestone-node gm-studio-milestone-node--inline">
                          <div className="gm-studio-row">
                            <Tag className="gm-studio-tag-nowrap">T+0 基准</Tag>
                            <span className="gm-num gm-studio-text-muted">
                              {formatShanghaiDate(rec.publishedAt)}
                            </span>
                          </div>
                          <span className="gm-num gm-studio-text-secondary">
                            {rec.beforeMetrics
                              ? `提及率 ${formatPercent(rec.beforeMetrics.mentionRate)}`
                              : '待建立基准'}
                          </span>
                        </div>

                        {/* T+7 / T+14 / T+30 Milestone Nodes */}
                        {milestoneDays.map((day) => {
                          const sched = scheduleByDay.get(day);
                          const activePendingDays = activePendingSchedules.map(
                            (s) => s.milestoneDay,
                          );

                          return (
                            <div
                              key={day}
                              data-testid={`publish-retest-node-${rec.id}-T${day}`}
                              className="gm-studio-milestone-node"
                            >
                              <div className="gm-studio-row gm-studio-row--wrap gm-studio-row--between">
                                <div className="gm-studio-row gm-studio-row--wrap">
                                  <span className="gm-num gm-studio-milestone-day">T+{day}</span>
                                  {sched ? (
                                    <StatusBadge tone={scheduleStatusTone(sched.status)}>
                                      {RETEST_SCHEDULE_STATUS_LABELS[sched.status]}
                                    </StatusBadge>
                                  ) : (
                                    <Tag className="gm-studio-tag-nowrap">未启用</Tag>
                                  )}
                                </div>

                                {sched?.status === 'PENDING' ? (
                                  <Button
                                    size="small"
                                    type="link"
                                    danger
                                    className="gm-studio-link-compact"
                                    disabled={readOnly || Boolean(updatingScheduleRecordId)}
                                    onClick={() =>
                                      void handleUpdateSchedules(
                                        raw,
                                        rec,
                                        { cancelMilestoneDays: [day] },
                                        `已取消 T+${day} 自动复测节点`,
                                      )
                                    }
                                  >
                                    取消
                                  </Button>
                                ) : !sched || sched.status === 'CANCELLED' ? (
                                  <Button
                                    size="small"
                                    type="link"
                                    className="gm-studio-link-compact"
                                    disabled={readOnly || Boolean(updatingScheduleRecordId)}
                                    onClick={() => {
                                      const nextSampleCount: RetestSampleCount = hasPendingSchedules
                                        ? currentSampleCount
                                        : (sched?.sampleCount ?? currentSampleCount);
                                      const nextIncludeControlPrompts = hasPendingSchedules
                                        ? currentIncludeControlPrompts
                                        : Boolean(
                                            sched
                                              ? sched.includeControlPrompts
                                              : currentIncludeControlPrompts,
                                          );
                                      void handleUpdateSchedules(
                                        raw,
                                        rec,
                                        {
                                          enabled: true,
                                          milestones: Array.from(
                                            new Set([...activePendingDays, day]),
                                          ).sort((a, b) => a - b),
                                          sampleCount: nextSampleCount,
                                          includeControlPrompts: nextIncludeControlPrompts,
                                        },
                                        `已开启 T+${day} 自动复测节点`,
                                      );
                                    }}
                                  >
                                    {sched ? '重新开启' : '开启'}
                                  </Button>
                                ) : null}
                              </div>

                              {sched?.status === 'PENDING' ? (
                                <div className="gm-studio-text-muted">
                                  预计执行：
                                  <span className="gm-num">{formatShanghaiDate(sched.dueAt)}</span>
                                  {' · '}
                                  {sched.sampleCount === 3 ? '3 次采样' : '1 次采样'}
                                </div>
                              ) : null}

                              {sched?.status === 'COMPLETED' && sched.metricsSnapshot ? (
                                <div className="gm-studio-milestone-metrics">
                                  <span className="gm-num">
                                    提及率 {formatPercent(sched.metricsSnapshot.mentionRate)}
                                    {(() => {
                                      const diff = formatMentionDelta(
                                        rec.beforeMetrics?.mentionRate,
                                        sched.metricsSnapshot.mentionRate,
                                      );
                                      return diff ? ` (${diff})` : '';
                                    })()}
                                  </span>
                                  <span
                                    className={
                                      sched.metricsSnapshot.citationHit
                                        ? 'gm-studio-milestone-cited'
                                        : 'gm-studio-text-muted'
                                    }
                                  >
                                    {sched.metricsSnapshot.citationHit ? '引文命中' : '未命中引文'}
                                  </span>
                                  <span className="gm-num">
                                    顺位{' '}
                                    {typeof sched.metricsSnapshot.avgPosition === 'number' &&
                                    Number.isFinite(sched.metricsSnapshot.avgPosition)
                                      ? `#${sched.metricsSnapshot.avgPosition.toFixed(1)}`
                                      : '未上榜'}
                                  </span>
                                  {formatSentimentLabel(sched.metricsSnapshot.sentiment) ? (
                                    <span>
                                      情感 {formatSentimentLabel(sched.metricsSnapshot.sentiment)}
                                    </span>
                                  ) : null}
                                  {sched.executedAt ? (
                                    <span className="gm-studio-text-muted">
                                      {formatShanghaiDateTime(sched.executedAt)}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}

                              {sched?.status === 'COMPLETED' &&
                              isValidWilson(sched.metricsSnapshot?.wilson) ? (
                                <div
                                  data-testid={`publish-retest-wilson-${rec.id}-T${day}`}
                                  className="gm-studio-milestone-stats-row"
                                >
                                  <span className="gm-num">
                                    95% CI [{(sched.metricsSnapshot.wilson.lower * 100).toFixed(1)}
                                    %, {(sched.metricsSnapshot.wilson.upper * 100).toFixed(1)}%]（n=
                                    {sched.metricsSnapshot.wilson.trials}）
                                  </span>
                                  <SignalPill
                                    tone={resolveConfidenceTone(
                                      sched.metricsSnapshot.wilson.confidenceLevel,
                                    )}
                                  >
                                    {resolveConfidenceLabel(
                                      sched.metricsSnapshot.wilson.confidenceLevel,
                                    )}
                                  </SignalPill>
                                  {sched.metricsSnapshot.wilson.confidenceLevel === 'LOW' ||
                                  sched.metricsSnapshot.wilson.trials < 5 ? (
                                    <span className="gm-studio-text-warning">
                                      样本较少，建议开启 3× 采样
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}

                              {sched?.status === 'COMPLETED' &&
                              sched.controlMetricsJson?.did &&
                              isFiniteNumber(sched.controlMetricsJson.did.netLift) &&
                              isFiniteNumber(sched.controlMetricsJson.did.treatmentDelta) &&
                              isFiniteNumber(sched.controlMetricsJson.did.controlDelta) ? (
                                <div
                                  data-testid={`publish-retest-did-${rec.id}-T${day}`}
                                  className="gm-studio-milestone-stats-row gm-studio-milestone-stats-row--did"
                                >
                                  <SignalPill
                                    tone={resolveDidDirectionTone(
                                      sched.controlMetricsJson.did.direction,
                                    )}
                                  >
                                    DiD 净增益 {formatDidPp(sched.controlMetricsJson.did.netLift)} ·{' '}
                                    {resolveDidDirectionLabel(
                                      sched.controlMetricsJson.did.direction,
                                    )}
                                  </SignalPill>
                                  <span className="gm-num gm-studio-text-muted">
                                    处理组 Δ{' '}
                                    {formatDidPp(sched.controlMetricsJson.did.treatmentDelta)} ·
                                    对照组 Δ{' '}
                                    {formatDidPp(sched.controlMetricsJson.did.controlDelta)}
                                  </span>
                                </div>
                              ) : null}

                              {sched?.status === 'SKIPPED_INSUFFICIENT_POINTS' ||
                              ((sched?.status === 'SKIPPED_NO_ENGINE' ||
                                sched?.status === 'FAILED') &&
                                sched.skipReason) ? (
                                <div
                                  className={
                                    sched.status === 'FAILED'
                                      ? 'gm-studio-inline-error'
                                      : 'gm-studio-text-warning'
                                  }
                                >
                                  {sched.skipReason ?? '余额不足，已自动温和跳过本次复测（未扣费）'}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Single-Primary CTA on idx===0 */}
                    <div className="gm-studio-row">
                      <Button
                        size="small"
                        type={idx === 0 ? 'primary' : 'default'}
                        block
                        data-testid={
                          idx === 0 ? 'publish-retest-btn' : `publish-retest-btn-${rec.id}`
                        }
                        loading={isSubmittingThis || isPollingThis}
                        disabled={
                          readOnly || Boolean(retestingRecordId) || Boolean(pollingRetestRecordId)
                        }
                        onClick={() => void onTriggerRetest(rec)}
                        className="gm-studio-nowrap"
                      >
                        {isPollingThis ? '复测中…' : '立即复测'}
                      </Button>
                      <Explain text="新发内容通常需 7–14 天进入 AI 检索，建议启用上方自动追踪。" />
                    </div>

                    {isPollingThis ? (
                      <div className="gm-studio-item-meta">
                        等待复测结果返回并回写 Before → After 对比…
                      </div>
                    ) : null}

                    {rec.beforeMetrics || rec.afterMetrics ? (
                      <div className="gm-studio-retest-panel" data-testid="publish-before-after">
                        <div className="gm-studio-retest-title">
                          <span>发布前 / 发布后对比</span>
                          <span className="gm-studio-retest-badge">Before → After</span>
                        </div>
                        <div className="gm-studio-retest-grid">
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">AI 提及率</span>
                            <span className="gm-studio-retest-val gm-num">
                              {delta.mentionLabel}
                            </span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">平均顺位</span>
                            <span className="gm-studio-retest-val gm-num">
                              {delta.positionLabel}
                            </span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">信源引用</span>
                            <span className="gm-studio-retest-val">{delta.citationLabel}</span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">情感倾向</span>
                            <span className="gm-studio-retest-val">{delta.sentimentLabel}</span>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
