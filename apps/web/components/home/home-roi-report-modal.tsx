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
import { Alert, Button, Input, Modal, Tag } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM } from '../../lib/design-tokens';
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
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { triggerBlobDownload } from '../../lib/ux-foundation';
import { isSafeHttpUrl } from '../../lib/visibility';
import { useUxFeedback } from '../crud/ux-feedback';
import {
  SignalEmpty,
  SignalError,
  SignalPill,
  SignalSkeleton,
  type SignalTone,
} from '../geo/primitives';

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

const CONFIDENCE_TONE: Record<ConfidenceLevel, SignalTone> = {
  HIGH: 'cited',
  MEDIUM: 'info',
  LOW: 'warning',
  INSUFFICIENT: 'neutral',
};

const DID_DIRECTION_LABELS_ZH: Record<DidDirection, string> = {
  POSITIVE: '正向净增益',
  NEGATIVE: '负向变化',
  NEUTRAL: '无显著净差',
};

const DID_DIRECTION_TONE: Record<DidDirection, SignalTone> = {
  POSITIVE: 'cited',
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
    setLoadError(null);
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
      listCtrlRef.current?.abort();
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
    setExportingKey(key);
    try {
      const file = await exportGeoRoiReportHtml(report.id);
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
      feedback.notifyError(formatErrorMessage(err, '导出独立 HTML 报告失败'));
    } finally {
      setExportingKey((curr) => (curr === key ? null : curr));
    }
  };

  const handlePrintPdf = async (report: GeoRoiReportRecordDto) => {
    if (exportingKey) return;
    const key = `print:${report.id}`;
    setExportingKey(key);
    try {
      const file = await exportGeoRoiReportHtml(report.id);
      const ok = printStandaloneReportHtml(file.html);
      if (ok) {
        feedback.notifySuccess('已打开打印预览，可在弹窗中选择「另存为 PDF」');
      } else {
        feedback.notifyWarning('打印窗口被浏览器拦截，请先下载 HTML 文件后使用浏览器打印保存 PDF');
      }
    } catch (err) {
      feedback.notifyError(formatErrorMessage(err, '加载打印视图失败'));
    } finally {
      setExportingKey((curr) => (curr === key ? null : curr));
    }
  };

  const handleCreateShare = async (report: GeoRoiReportRecordDto) => {
    if (readOnly || sharingReportId) return;
    setSharingReportId(report.id);
    const seq = seqRef.current;
    try {
      const share = await createGeoRoiReportShare(report.id, { ttlDays: 30 });
      if (seq !== seqRef.current) return;
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
      if (copied) {
        feedback.notifySuccess('已生成对外分享链接并复制到剪贴板（有效期 30 天）');
      } else {
        feedback.notifySuccess('已生成对外分享链接，请点击下方按钮复制或打开');
      }
    } catch (err) {
      if (seq !== seqRef.current) return;
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

  const selectedShare = selectedReport ? (cachedShares[selectedReport.id] ?? null) : null;
  const selectedShareUrl = selectedShare ? resolveShareAbsoluteUrl(selectedShare) : null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width="min(860px, calc(100vw - 32px))"
      styles={{ body: { overflowX: 'hidden', maxHeight: '72vh', overflowY: 'auto' } }}
      title={
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span>月度 GEO ROI 报告中心</span>
          <Tag color={market === 'GLOBAL' ? 'blue' : 'cyan'} style={{ margin: 0 }}>
            {brandName} · {market === 'GLOBAL' ? '海外市场（GLOBAL）' : '国内市场（CN）'}
          </Tag>
        </div>
      }
    >
      <div
        data-testid="home-roi-report-modal"
        style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
      >
        {/* 1. Create New Report Form */}
        <section
          data-testid="roi-report-create-form"
          style={{
            padding: 14,
            borderRadius: 8,
            background: 'var(--gm-bg-elevated, #171B1A)',
            border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <strong style={{ fontSize: 13.5, color: GM.fg.f1 }}>新建月度 GEO ROI 快照报告</strong>
            <span style={{ fontSize: 12, color: GM.fg.f3 }}>
              包含 Wilson 95% 置信区间、对照组 DiD 净增益、Near-Miss 转化与渠道归因（免费导出）
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
              minWidth: 0,
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: GM.fg.f2 }}>统计开始日期</span>
              <input
                type="date"
                aria-label="统计开始日期"
                data-testid="roi-report-period-start"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={readOnly || generating}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: GM.fg.f2 }}>统计结束日期</span>
              <input
                type="date"
                aria-label="统计结束日期"
                data-testid="roi-report-period-end"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={readOnly || generating}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: GM.fg.f2 }}>报告语言</span>
              <select
                aria-label="报告语言"
                data-testid="roi-report-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value as SupportedLocale)}
                disabled={readOnly || generating}
                style={{ ...NATIVE_SELECT_STYLE, width: '100%', boxSizing: 'border-box' }}
              >
                {REPORT_LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 10,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: GM.fg.f2 }}>白标机构名称（选填）</span>
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: GM.fg.f2 }}>自定义报告标题（选填）</span>
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

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 12, color: GM.fg.f3 }}>
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
        <section
          aria-label="历史 ROI 报告列表"
          style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <strong style={{ fontSize: 13.5, color: GM.fg.f1 }}>
              已保存的 ROI 报告（{reports.length}）
            </strong>
            <Button size="small" onClick={() => void loadReports()} loading={loading}>
              刷新列表
            </Button>
          </div>

          {loadError ? (
            <SignalError message={loadError} onRetry={() => void loadReports()} />
          ) : loading && reports.length === 0 ? (
            <SignalSkeleton variant="row" rows={3} />
          ) : reports.length === 0 ? (
            <SignalEmpty
              title="暂无已生成的月度 GEO ROI 报告"
              description="选择统计时间窗口与报告语言，点击上方「生成月度 GEO ROI 报告」即可创建首份可验证复盘报告。"
            />
          ) : (
            <>
              {/* Report selector list */}
              <div
                data-testid="roi-report-list"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
              >
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
                      style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        cursor: 'pointer',
                        background: isSelected
                          ? 'var(--gm-bg-selected, rgba(197, 240, 74, 0.07))'
                          : 'var(--gm-bg-surface, #111413)',
                        border: isSelected
                          ? '1px solid var(--gm-phosphor-a40, rgba(197, 240, 74, 0.4))'
                          : '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          minWidth: 0,
                          flex: '1 1 280px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: GM.fg.f1,
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {report.title}
                          </span>
                          <Tag style={{ margin: 0 }}>{report.locale}</Tag>
                          {report.whiteLabelOrg ? (
                            <Tag color="purple" style={{ margin: 0 }}>
                              白标：{report.whiteLabelOrg}
                            </Tag>
                          ) : null}
                          {report.shareActive ? (
                            <Tag color="green" style={{ margin: 0 }}>
                              已开启分享
                            </Tag>
                          ) : null}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '2px 12px',
                            fontSize: 12,
                            color: GM.fg.f3,
                          }}
                        >
                          <span className="gm-num">
                            周期：{formatUtcCalendarDate(report.periodStart)} ~{' '}
                            {formatUtcCalendarDate(report.periodEnd)}
                          </span>
                          <span className="gm-num">
                            生成于：{formatShanghaiDateTime(report.createdAt)}
                          </span>
                        </div>
                      </div>

                      <div
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
                      >
                        <span className="gm-num" style={{ fontSize: 12, color: GM.sig.cited }}>
                          提及率 {formatRatioPct(report.summary.overview.mentionRate)}
                        </span>
                        <SignalPill tone={CONFIDENCE_TONE[report.summary.overview.confidenceLevel]}>
                          {CONFIDENCE_LABELS_ZH[report.summary.overview.confidenceLevel]}
                        </SignalPill>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Selected report KPI preview & actions */}
              {selectedReport ? (
                <div
                  data-testid="roi-report-detail-card"
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    background: 'var(--gm-bg-elevated, #171B1A)',
                    border: '1px solid var(--gm-line-2, rgba(255,255,255,0.1))',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: GM.fg.f1,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {selectedReport.title}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 12, color: GM.fg.f3, marginTop: 2 }}
                      >
                        统计周期：{formatUtcCalendarDate(selectedReport.periodStart)} 至{' '}
                        {formatUtcCalendarDate(selectedReport.periodEnd)} · 语言：
                        {selectedReport.locale}
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
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
                        type="primary"
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
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: 'var(--gm-bg-surface, #111413)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>
                        品牌提及率（Wilson 95% CI）
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                      >
                        {formatRatioPct(selectedReport.summary.overview.mentionRate)}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 2 }}
                      >
                        [{formatRatioPct(selectedReport.summary.overview.mentionWilson.lower)},{' '}
                        {formatRatioPct(selectedReport.summary.overview.mentionWilson.upper)}] · n=
                        {formatSafeCount(selectedReport.summary.overview.mentionWilson.trials)}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: 'var(--gm-bg-surface, #111413)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>对照组 DiD 净增益</div>
                      {selectedReport.summary.overview.did ? (
                        <>
                          <div
                            className="gm-num"
                            style={{
                              fontSize: 18,
                              fontWeight: 700,
                              color:
                                selectedReport.summary.overview.did.direction === 'POSITIVE'
                                  ? GM.sig.cited
                                  : selectedReport.summary.overview.did.direction === 'NEGATIVE'
                                    ? GM.status.danger
                                    : GM.fg.f2,
                              marginTop: 2,
                            }}
                          >
                            {formatRatioPp(selectedReport.summary.overview.did.netLift)}
                          </div>
                          <div style={{ marginTop: 2 }}>
                            <SignalPill
                              tone={
                                DID_DIRECTION_TONE[selectedReport.summary.overview.did.direction]
                              }
                            >
                              {
                                DID_DIRECTION_LABELS_ZH[
                                  selectedReport.summary.overview.did.direction
                                ]
                              }
                            </SignalPill>
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: GM.fg.f3, marginTop: 6 }}>
                          暂未启用对照组复测
                        </div>
                      )}
                    </div>

                    <div
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: 'var(--gm-bg-surface, #111413)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>Near-Miss 补强转化</div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                      >
                        {formatSafeCount(selectedReport.summary.nearMiss.convertedToCited)} /{' '}
                        {formatSafeCount(selectedReport.summary.nearMiss.totalOpportunities)}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 2 }}
                      >
                        已建补强卡{' '}
                        {formatSafeCount(selectedReport.summary.nearMiss.boostBriefsCreated)} 张
                      </div>
                    </div>

                    <div
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: 'var(--gm-bg-surface, #111413)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>分发与可抓取漏斗</div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                      >
                        {formatSafeCount(selectedReport.summary.funnel.publishedTotal)} 篇
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 2 }}
                      >
                        可抓取率 {formatRatioPct(selectedReport.summary.funnel.crawlOkRate)}
                      </div>
                    </div>
                  </div>

                  {/* Share URL banner */}
                  {selectedShare && selectedShareUrl ? (
                    <div
                      data-testid="roi-report-share-box"
                      style={{
                        padding: '10px 12px',
                        borderRadius: 6,
                        background: 'rgba(61, 224, 200, 0.08)',
                        border: '1px solid rgba(61, 224, 200, 0.28)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.sig.cited, fontWeight: 600 }}>
                        公开免登录分享链接（仅本次展示明文，有效期至{' '}
                        {formatShanghaiDateTime(selectedShare.expiresAt)}）
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 8,
                          minWidth: 0,
                        }}
                      >
                        <code
                          data-testid="roi-report-share-url"
                          className="gm-mono"
                          style={{
                            flex: '1 1 280px',
                            minWidth: 0,
                            overflowWrap: 'anywhere',
                            padding: '4px 8px',
                            borderRadius: 4,
                            background: 'var(--gm-bg-base, #0A0C0B)',
                            color: GM.fg.f1,
                          }}
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
                            style={{ fontSize: 12, color: GM.phosphor, whiteSpace: 'nowrap' }}
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
