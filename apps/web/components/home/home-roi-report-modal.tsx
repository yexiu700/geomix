'use client';

import {
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_CODES,
  formatShanghaiDateTime,
  type ConfidenceLevel,
  type DidDirection,
  type GeoMarket,
  type GeoRoiReportRecordDto,
  type SupportedLocale,
} from '@geomix/shared';
import { Alert, Button, Input, Modal } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GatewayApiError } from '../../lib/envelope';
import {
  buildDefaultRoiPeriod,
  createGeoRoiReport,
  createGeoRoiReportShare,
  exportGeoRoiReportHtml,
  fetchGeoRoiReports,
  formatUtcCalendarDate,
  printStandaloneReportHtml,
  resolveShareAbsoluteUrl,
  revokeGeoRoiReportShare,
  type GeoRoiReportShareCreatedDto,
} from '../../lib/reports';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { hasOpenFloatingOverlay, triggerBlobDownload } from '../../lib/ux-foundation';
import { isSafeHttpUrl } from '../../lib/visibility';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { EmptyState, StatusBadge, type StatusTone } from '../ui';

export type HomeRoiReportModalProps = {
  open: boolean;
  brandId: string;
  brandName: string;
  market: GeoMarket;
  readOnly: boolean;
  onClose: () => void;
};

const REPORT_LOCALE_OPTIONS: ReadonlyArray<{ value: SupportedLocale; label: string }> =
  SUPPORTED_LOCALE_CODES.map((code) => {
    const info = SUPPORTED_LOCALES[code];
    return {
      value: code,
      label:
        code === 'zh-CN'
          ? '中文报告（zh-CN）'
          : code === 'en-US'
            ? 'English Report（en-US）'
            : `${info.labelZh} / ${info.nativeLabel}（${code}）`,
    };
  });

const CONFIDENCE_LABELS_ZH: Record<ConfidenceLevel, string> = {
  HIGH: '高置信',
  MEDIUM: '中置信',
  LOW: '低置信',
  INSUFFICIENT: '样本不足',
};

const CONFIDENCE_TONE: Record<ConfidenceLevel, StatusTone> = {
  HIGH: 'success',
  MEDIUM: 'active',
  LOW: 'warning',
  INSUFFICIENT: 'neutral',
};

const DID_DIRECTION_LABELS_ZH: Record<DidDirection, string> = {
  POSITIVE: '正向净增益',
  NEGATIVE: '负向变化',
  NEUTRAL: '无显著净差',
};

const DID_DIRECTION_TONE: Record<DidDirection, StatusTone> = {
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

function formatErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError && err.message.trim()) return err.message.trim();
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

function formatRatioPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatRatioPp(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const pp = value * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function formatSafeCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.round(value));
}

export function HomeRoiReportModal({
  open,
  brandId,
  brandName,
  market,
  readOnly,
  onClose,
}: HomeRoiReportModalProps): JSX.Element {
  const feedback = useUxFeedback();
  const defaultPeriod = useMemo(() => buildDefaultRoiPeriod(), []);
  const defaultLocale: SupportedLocale = market === 'GLOBAL' ? 'en-US' : 'zh-CN';

  const [periodStart, setPeriodStart] = useState(defaultPeriod.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.periodEnd);
  const [locale, setLocale] = useState<SupportedLocale>(defaultLocale);
  const [whiteLabelOrg, setWhiteLabelOrg] = useState('');
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [reports, setReports] = useState<GeoRoiReportRecordDto[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [sharingReportId, setSharingReportId] = useState<string | null>(null);
  const [revokingReportId, setRevokingReportId] = useState<string | null>(null);
  const [cachedShares, setCachedShares] = useState<Record<string, GeoRoiReportShareCreatedDto>>({});

  const seqRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const listCtrlRef = useRef<AbortController | null>(null);

  // Sync default locale and reset state when brandId / market changes
  useEffect(() => {
    seqRef.current += 1;
    listCtrlRef.current?.abort();
    const nextPeriod = buildDefaultRoiPeriod();
    setPeriodStart(nextPeriod.periodStart);
    setPeriodEnd(nextPeriod.periodEnd);
    setLocale(market === 'GLOBAL' ? 'en-US' : 'zh-CN');
    setWhiteLabelOrg('');
    setTitle('');
    setFormError(null);
    setReports([]);
    setSelectedReportId(null);
    setLoading(false);
    setLoadError(null);
    setGenerating(false);
    setExportingKey(null);
    setSharingReportId(null);
    setRevokingReportId(null);
    setCachedShares({});
  }, [brandId, market]);

  const loadReports = useCallback(async () => {
    listCtrlRef.current?.abort();
    const ctrl = new AbortController();
    listCtrlRef.current = ctrl;
    const seq = seqRef.current;

    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchGeoRoiReports(brandId, { market, limit: 20 }, { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== seqRef.current) return;
      setReports(res.items);
      setSelectedReportId((prev) => {
        if (prev && res.items.some((r) => r.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== seqRef.current) return;
      setLoadError(formatErrorMessage(err, '加载已生成 ROI 报告失败'));
    } finally {
      if (!ctrl.signal.aborted && seq === seqRef.current) {
        setLoading(false);
      }
    }
  }, [brandId, market]);

  useEffect(() => {
    if (!open) {
      seqRef.current += 1;
      listCtrlRef.current?.abort();
      setCachedShares({});
      setGenerating(false);
      setSharingReportId(null);
      setRevokingReportId(null);
      setExportingKey(null);
      setLoading(false);
      setFormError(null);
      return;
    }
    void loadReports();
    return () => {
      listCtrlRef.current?.abort();
    };
  }, [open, loadReports]);

  const selectedReport = useMemo(
    () => reports.find((item) => item.id === selectedReportId) ?? reports[0] ?? null,
    [reports, selectedReportId],
  );

  const handleGenerate = async () => {
    if (readOnly || generating) return;
    if (!periodStart || !periodEnd) {
      setFormError('请选择完整的起止统计日期');
      return;
    }
    if (periodStart > periodEnd) {
      setFormError('开始日期不能晚于结束日期');
      return;
    }

    const trimmedOrg = whiteLabelOrg.trim();
    const trimmedTitle = title.trim();
    if (trimmedOrg.length > 80) {
      setFormError('白标机构名称最多 80 字符');
      return;
    }
    if (trimmedTitle.length > 120) {
      setFormError('报告标题最多 120 字符');
      return;
    }

    setFormError(null);
    setGenerating(true);
    const seq = seqRef.current;
    try {
      const created = await createGeoRoiReport(brandId, {
        market,
        periodStart,
        periodEnd,
        locale,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(trimmedOrg ? { whiteLabelOrg: trimmedOrg } : {}),
      });
      if (seq !== seqRef.current) return;
      setReports((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setSelectedReportId(created.id);
      setTitle('');
      invalidateFreshness('roi-reports');
      feedback.notifySuccess('月度 GEO ROI 报告已生成');
    } catch (err) {
      if (seq !== seqRef.current) return;
      const msg = formatErrorMessage(err, '生成月度 GEO ROI 报告失败');
      setFormError(msg);
      feedback.notifyError(msg);
    } finally {
      if (seq === seqRef.current) {
        setGenerating(false);
      }
    }
  };

  const handleDownloadHtml = async (report: GeoRoiReportRecordDto) => {
    if (exportingKey) return;
    const key = `dl:${report.id}`;
    const seq = seqRef.current;
    setExportingKey(key);
    try {
      const file = await exportGeoRoiReportHtml(report.id);
      if (seq !== seqRef.current || !openRef.current) return;
      const ok = triggerBlobDownload({
        filename: file.filename,
        mime: file.mime,
        body: file.blob,
      });
      if (ok) {
        feedback.notifySuccess(`已下载独立 HTML 报告：${file.filename}`);
      } else {
        feedback.notifyWarning('浏览器未允许自动下载，请稍后重试');
      }
    } catch (err) {
      if (seq !== seqRef.current || !openRef.current) return;
      feedback.notifyError(formatErrorMessage(err, '导出独立 HTML 报告失败'));
    } finally {
      if (seq === seqRef.current) {
        setExportingKey((curr) => (curr === key ? null : curr));
      }
    }
  };

  const handlePrintPdf = async (report: GeoRoiReportRecordDto) => {
    if (exportingKey) return;
    const key = `print:${report.id}`;
    const seq = seqRef.current;
    setExportingKey(key);
    try {
      const file = await exportGeoRoiReportHtml(report.id);
      if (seq !== seqRef.current || !openRef.current) return;
      const ok = printStandaloneReportHtml(file.html);
      if (ok) {
        feedback.notifySuccess('已打开打印预览，可在弹窗中选择「另存为 PDF」');
      } else {
        feedback.notifyWarning('打印窗口被浏览器拦截，请先下载 HTML 文件后使用浏览器打印保存 PDF');
      }
    } catch (err) {
      if (seq !== seqRef.current || !openRef.current) return;
      feedback.notifyError(formatErrorMessage(err, '加载打印视图失败'));
    } finally {
      if (seq === seqRef.current) {
        setExportingKey((curr) => (curr === key ? null : curr));
      }
    }
  };

  const handleCreateShare = async (report: GeoRoiReportRecordDto) => {
    if (readOnly || sharingReportId) return;
    setSharingReportId(report.id);
    const seq = seqRef.current;
    try {
      const share = await createGeoRoiReportShare(report.id, { ttlDays: 30 });
      if (seq !== seqRef.current || !openRef.current) return;
      setCachedShares((prev) => ({ ...prev, [report.id]: share }));
      setReports((prev) =>
        prev.map((item) =>
          item.id === report.id
            ? { ...item, shareActive: true, shareExpiresAt: share.expiresAt }
            : item,
        ),
      );
      invalidateFreshness('roi-reports');
      const resolvedUrl = resolveShareAbsoluteUrl(share);
      const copied = await copyTextToClipboard(resolvedUrl);
      if (seq !== seqRef.current || !openRef.current) return;
      if (copied) {
        feedback.notifySuccess('已生成对外分享链接并复制到剪贴板（有效期 30 天）');
      } else {
        feedback.notifySuccess('已生成对外分享链接，请点击下方按钮复制或打开');
      }
    } catch (err) {
      if (seq !== seqRef.current || !openRef.current) return;
      feedback.notifyError(formatErrorMessage(err, '生成分享链接失败'));
    } finally {
      if (seq === seqRef.current) {
        setSharingReportId(null);
      }
    }
  };

  const handleCopyCachedShare = async (share: GeoRoiReportShareCreatedDto) => {
    const resolvedUrl = resolveShareAbsoluteUrl(share);
    const ok = await copyTextToClipboard(resolvedUrl);
    if (ok) {
      feedback.notifySuccess('分享链接已复制到剪贴板');
    } else {
      feedback.notifyWarning('复制失败，请手动选中链接文本复制');
    }
  };

  const handleRevokeShare = (report: GeoRoiReportRecordDto) => {
    if (readOnly || revokingReportId) return;
    feedback.confirm({
      title: '确认撤销该报告的公开分享链接？',
      content: '撤销后，原分享链接将立即失效并返回 404，已发送给外部客户或团队的链接无法再访问。',
      okText: '确认撤销',
      okButtonProps: { danger: true },
      onOk: async () => {
        setRevokingReportId(report.id);
        const seq = seqRef.current;
        try {
          await revokeGeoRoiReportShare(report.id);
          if (seq !== seqRef.current) return;
          setCachedShares((prev) => {
            const next = { ...prev };
            delete next[report.id];
            return next;
          });
          setReports((prev) =>
            prev.map((item) =>
              item.id === report.id ? { ...item, shareActive: false, shareExpiresAt: null } : item,
            ),
          );
          invalidateFreshness('roi-reports');
          feedback.notifySuccess('分享链接已撤销失效');
        } catch (err) {
          if (seq !== seqRef.current) return;
          feedback.notifyError(formatErrorMessage(err, '撤销分享链接失败'));
        } finally {
          if (seq === seqRef.current) {
            setRevokingReportId(null);
          }
        }
      },
    });
  };

  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const ownWrap = bodyRef.current?.closest('.ant-modal-wrap') ?? undefined;
      if (hasOpenFloatingOverlay(ownWrap)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const selectedShare = selectedReport ? (cachedShares[selectedReport.id] ?? null) : null;
  const selectedShareUrl = selectedShare ? resolveShareAbsoluteUrl(selectedShare) : null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      keyboard
      footer={null}
      destroyOnHidden
      width="min(860px, calc(100vw - 32px))"
      styles={{ body: { overflowX: 'hidden', maxHeight: '72vh', overflowY: 'auto' } }}
      title={
        <div className="gm-roi-modal-title">
          <span>月度 GEO ROI 报告中心</span>
          <span className="gm-home-chip">
            {brandName} · {market === 'GLOBAL' ? '海外市场（GLOBAL）' : '国内市场（CN）'}
          </span>
        </div>
      }
    >
      <div ref={bodyRef} className="gm-roi-modal-body" data-testid="home-roi-report-modal">
        {/* 1. Create New Report Form */}
        <section className="gm-roi-card" data-testid="roi-report-create-form">
          <div className="gm-roi-card-head">
            <strong className="gm-roi-section-title">新建月度 GEO ROI 快照报告</strong>
            <span className="gm-roi-muted">
              包含 Wilson 95% 置信区间、对照组 DiD 净增益、Near-Miss 转化与渠道归因（免费导出）
            </span>
          </div>

          <div className="gm-roi-grid-3">
            <label className="gm-roi-field">
              <span className="gm-roi-field-label">统计开始日期</span>
              <input
                type="date"
                aria-label="统计开始日期"
                data-testid="roi-report-period-start"
                className="gm-roi-date-input"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={readOnly || generating}
              />
            </label>

            <label className="gm-roi-field">
              <span className="gm-roi-field-label">统计结束日期</span>
              <input
                type="date"
                aria-label="统计结束日期"
                data-testid="roi-report-period-end"
                className="gm-roi-date-input"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={readOnly || generating}
              />
            </label>

            <label className="gm-roi-field">
              <span className="gm-roi-field-label">报告语言</span>
              <select
                aria-label="报告语言"
                data-testid="roi-report-locale"
                className="gm-select gm-roi-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as SupportedLocale)}
                disabled={readOnly || generating}
              >
                {REPORT_LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="gm-roi-grid-2">
            <div className="gm-roi-field">
              <span className="gm-roi-field-label">白标机构名称（选填）</span>
              <Input
                aria-label="白标机构名称"
                data-testid="roi-report-whitelabel"
                maxLength={80}
                placeholder="例如：Acme Growth Agency（留空则展示 GeoMix）"
                value={whiteLabelOrg}
                onChange={(e) => setWhiteLabelOrg(e.target.value)}
                disabled={readOnly || generating}
              />
            </div>

            <div className="gm-roi-field">
              <span className="gm-roi-field-label">自定义报告标题（选填）</span>
              <Input
                aria-label="自定义报告标题"
                data-testid="roi-report-title"
                maxLength={120}
                placeholder="留空则按品牌、语言与周期自动命名"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={readOnly || generating}
              />
            </div>
          </div>

          {formError ? (
            <Alert type="error" showIcon message={formError} data-testid="roi-report-form-error" />
          ) : null}

          <div className="gm-roi-card-foot">
            <span className="gm-roi-muted">
              {readOnly
                ? '当前为只读状态，仅可浏览或下载已有报告。'
                : '生成后将冻结当前周期汇总快照，支持随时导出与白标分享。'}
            </span>
            <Button
              type="primary"
              data-testid="roi-report-generate-btn"
              loading={generating}
              disabled={readOnly || generating}
              onClick={() => void handleGenerate()}
            >
              生成月度 GEO ROI 报告
            </Button>
          </div>
        </section>

        {/* 2. Saved Reports History & Selected Preview */}
        <section className="gm-roi-section" aria-label="历史 ROI 报告列表">
          <div className="gm-roi-card-head">
            <strong className="gm-roi-section-title">已保存的 ROI 报告（{reports.length}）</strong>
            <Button size="small" onClick={() => void loadReports()} loading={loading}>
              刷新列表
            </Button>
          </div>

          {loadError ? (
            <SignalError message={loadError} onRetry={() => void loadReports()} />
          ) : loading && reports.length === 0 ? (
            <SignalSkeleton variant="row" rows={3} />
          ) : reports.length === 0 ? (
            <EmptyState
              size="compact"
              title="暂无已生成的月度 GEO ROI 报告"
              description="选择统计时间窗口与报告语言，点击上方「生成月度 GEO ROI 报告」即可创建首份可验证复盘报告。"
            />
          ) : (
            <>
              {/* Report selector list */}
              <div className="gm-roi-list" data-testid="roi-report-list">
                {reports.map((report) => {
                  const isSelected = selectedReport?.id === report.id;
                  return (
                    <div
                      key={report.id}
                      data-testid={`roi-report-item-${report.id}`}
                      onClick={() => setSelectedReportId(report.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedReportId(report.id);
                        }
                      }}
                      className={`gm-roi-item${isSelected ? ' gm-roi-item--selected' : ''}`}
                    >
                      <div className="gm-roi-item-main">
                        <div className="gm-roi-item-top">
                          <span className="gm-roi-item-title">{report.title}</span>
                          <span className="gm-home-chip">{report.locale}</span>
                          {report.whiteLabelOrg ? (
                            <span className="gm-home-chip">白标：{report.whiteLabelOrg}</span>
                          ) : null}
                          {report.shareActive ? (
                            <StatusBadge tone="success" label="已开启分享" />
                          ) : null}
                        </div>
                        <div className="gm-roi-item-meta">
                          <span className="gm-num">
                            周期：{formatUtcCalendarDate(report.periodStart)} ~{' '}
                            {formatUtcCalendarDate(report.periodEnd)}
                          </span>
                          <span className="gm-num">
                            生成于：{formatShanghaiDateTime(report.createdAt)}
                          </span>
                        </div>
                      </div>

                      <div className="gm-roi-item-right">
                        <span className="gm-num gm-roi-item-rate">
                          提及率 {formatRatioPct(report.summary.overview.mentionRate)}
                        </span>
                        <StatusBadge
                          tone={CONFIDENCE_TONE[report.summary.overview.confidenceLevel]}
                          label={CONFIDENCE_LABELS_ZH[report.summary.overview.confidenceLevel]}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Selected report KPI preview & actions */}
              {selectedReport ? (
                <div className="gm-roi-detail-card" data-testid="roi-report-detail-card">
                  <div className="gm-roi-card-head">
                    <div className="gm-roi-detail-heading">
                      <div className="gm-roi-detail-title">{selectedReport.title}</div>
                      <div className="gm-num gm-roi-detail-sub">
                        统计周期：{formatUtcCalendarDate(selectedReport.periodStart)} 至{' '}
                        {formatUtcCalendarDate(selectedReport.periodEnd)} · 语言：
                        {selectedReport.locale}
                      </div>
                      {selectedReport.summary.overview.hasSimulatedObservations ? (
                        <StatusBadge
                          tone="warning"
                          data-testid="roi-simulated-badge"
                          label="含模拟采集数据"
                        />
                      ) : null}
                    </div>

                    <div className="gm-roi-detail-actions">
                      <Button
                        size="small"
                        data-testid="roi-report-download-html-btn"
                        loading={exportingKey === `dl:${selectedReport.id}`}
                        disabled={Boolean(exportingKey)}
                        onClick={() => void handleDownloadHtml(selectedReport)}
                      >
                        下载独立 HTML
                      </Button>
                      <Button
                        size="small"
                        data-testid="roi-report-print-pdf-btn"
                        loading={exportingKey === `print:${selectedReport.id}`}
                        disabled={Boolean(exportingKey)}
                        onClick={() => void handlePrintPdf(selectedReport)}
                      >
                        打印 / 保存 PDF
                      </Button>
                      <Button
                        size="small"
                        data-testid="roi-report-share-btn"
                        loading={sharingReportId === selectedReport.id}
                        disabled={readOnly || Boolean(sharingReportId) || Boolean(revokingReportId)}
                        onClick={() => void handleCreateShare(selectedReport)}
                      >
                        {selectedReport.shareActive ? '重新生成分享链接' : '生成并复制分享链接'}
                      </Button>
                      {selectedReport.shareActive ? (
                        <Button
                          size="small"
                          danger
                          data-testid="roi-report-revoke-share-btn"
                          loading={revokingReportId === selectedReport.id}
                          disabled={
                            readOnly || Boolean(sharingReportId) || Boolean(revokingReportId)
                          }
                          onClick={() => handleRevokeShare(selectedReport)}
                        >
                          撤销分享链接
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {/* Summary 4 KPI tiles */}
                  <div className="gm-roi-kpi-grid">
                    <div className="gm-roi-kpi-tile">
                      <div className="gm-roi-kpi-label">品牌提及率（Wilson 95% CI）</div>
                      <div className="gm-num gm-roi-kpi-value">
                        {formatRatioPct(selectedReport.summary.overview.mentionRate)}
                      </div>
                      <div className="gm-num gm-roi-kpi-sub">
                        [{formatRatioPct(selectedReport.summary.overview.mentionWilson.lower)},{' '}
                        {formatRatioPct(selectedReport.summary.overview.mentionWilson.upper)}] · n=
                        {formatSafeCount(selectedReport.summary.overview.mentionWilson.trials)}
                      </div>
                    </div>

                    <div className="gm-roi-kpi-tile">
                      <div className="gm-roi-kpi-label">对照组 DiD 净增益</div>
                      {selectedReport.summary.overview.did ? (
                        <>
                          <div
                            className={`gm-num gm-roi-kpi-value gm-roi-kpi-value--${selectedReport.summary.overview.did.direction.toLowerCase()}`}
                          >
                            {formatRatioPp(selectedReport.summary.overview.did.netLift)}
                          </div>
                          <div className="gm-roi-kpi-badge">
                            <StatusBadge
                              tone={
                                DID_DIRECTION_TONE[selectedReport.summary.overview.did.direction]
                              }
                              label={
                                DID_DIRECTION_LABELS_ZH[
                                  selectedReport.summary.overview.did.direction
                                ]
                              }
                            />
                          </div>
                        </>
                      ) : (
                        <div className="gm-roi-kpi-empty">暂未启用对照组复测</div>
                      )}
                    </div>

                    <div className="gm-roi-kpi-tile">
                      <div className="gm-roi-kpi-label">Near-Miss 补强转化</div>
                      <div className="gm-num gm-roi-kpi-value">
                        {formatSafeCount(selectedReport.summary.nearMiss.convertedToCited)} /{' '}
                        {formatSafeCount(selectedReport.summary.nearMiss.totalOpportunities)}
                      </div>
                      <div className="gm-num gm-roi-kpi-sub">
                        已建补强卡{' '}
                        {formatSafeCount(selectedReport.summary.nearMiss.boostBriefsCreated)} 张
                      </div>
                    </div>

                    <div className="gm-roi-kpi-tile">
                      <div className="gm-roi-kpi-label">分发与可抓取漏斗</div>
                      <div className="gm-num gm-roi-kpi-value">
                        {formatSafeCount(selectedReport.summary.funnel.publishedTotal)} 篇
                      </div>
                      <div className="gm-num gm-roi-kpi-sub">
                        可抓取率 {formatRatioPct(selectedReport.summary.funnel.crawlOkRate)}
                      </div>
                    </div>
                  </div>

                  {/* Share URL banner */}
                  {selectedShare && selectedShareUrl ? (
                    <div className="gm-roi-share-box" data-testid="roi-report-share-box">
                      <div className="gm-roi-share-title">
                        公开免登录分享链接（仅本次展示明文，有效期至{' '}
                        {formatShanghaiDateTime(selectedShare.expiresAt)}）
                      </div>
                      <div className="gm-roi-share-row">
                        <code
                          data-testid="roi-report-share-url"
                          className="gm-mono gm-roi-share-code"
                        >
                          {selectedShareUrl}
                        </code>
                        <Button
                          size="small"
                          data-testid="roi-report-copy-share-btn"
                          onClick={() => void handleCopyCachedShare(selectedShare)}
                        >
                          复制链接
                        </Button>
                        {isSafeHttpUrl(selectedShareUrl) ? (
                          <a
                            href={selectedShareUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="roi-report-open-share-link"
                            className="gm-roi-share-link"
                          >
                            打开分享页 ↗
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : selectedReport.shareActive ? (
                    <Alert
                      type="info"
                      showIcon
                      data-testid="roi-report-share-active-notice"
                      message={
                        selectedReport.shareExpiresAt
                          ? `该报告已开启对外只读分享（有效期至 ${formatShanghaiDateTime(selectedReport.shareExpiresAt)}）`
                          : '该报告已开启对外只读分享'
                      }
                      description="出于安全策略，分享令牌仅在首次创建时展示明文；如需重新获取可点击「重新生成分享链接」，或随时撤销失效。"
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
