'use client';

import {
  NEAR_MISS_TIERS,
  NEAR_MISS_TIER_EN_LABELS,
  NEAR_MISS_TIER_LABELS,
  SITE_NAME,
  VISIBILITY_ENGINE_LABELS,
  formatShanghaiDateTime,
  type ConfidenceLevel,
  type DidDirection,
  type DistributionMode,
  type GeoMarket,
  type PublicGeoRoiReportDto,
} from '@geomix/shared';
import { App, Button, ConfigProvider, Skeleton, Tag } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { GM, GM_ANTD_THEME } from '../../lib/design-tokens';
import { GatewayApiError } from '../../lib/envelope';
import { fetchPublicRoiReport, formatUtcCalendarDate, formatUtcDateTime } from '../../lib/reports';
import { SignalPill, type SignalTone } from '../geo/primitives';

export type PublicRoiReportViewProps = {
  token: string;
};

type LoadErrorKind = 'not_found' | 'rate_limited' | 'generic';

type CopyDict = {
  reportBadge: string;
  readOnlyNotice: string;
  poweredBy: string;
  printBtn: string;
  brandLabel: string;
  categoryLabel: string;
  periodLabel: string;
  generatedAtLabel: string;
  validThroughLabel: string;
  marketLabels: Record<GeoMarket, string>;
  confidenceLabels: Record<ConfidenceLevel, string>;
  didDirectionLabels: Record<DidDirection, string>;
  modeLabels: Record<DistributionMode, string>;
  overviewTitle: string;
  kpiMentionRate: string;
  kpiCitationRate: string;
  kpiOwnedCitationRate: string;
  kpiObservations: string;
  kpiDidLift: string;
  wilsonPrefix: string;
  lowSampleHint: string;
  didTreatmentPrefix: string;
  didControlPrefix: string;
  noControlData: string;
  engineSectionTitle: string;
  engineColName: string;
  engineColObs: string;
  engineColMentionWilson: string;
  engineColCitation: string;
  engineColOwnedCitation: string;
  engineColPosition: string;
  engineEmpty: string;
  nearMissSectionTitle: string;
  nearMissTotal: string;
  nearMissBriefs: string;
  nearMissConverted: string;
  nearMissTierBreakdown: string;
  funnelSectionTitle: string;
  funnelPublished: string;
  funnelL1: string;
  funnelL2: string;
  funnelL3: string;
  funnelCrawlOk: string;
  funnelIndexNow: string;
  channelSectionTitle: string;
  channelColName: string;
  channelColMode: string;
  channelColPublished: string;
  channelColRetests: string;
  channelColHits: string;
  channelColHitRate: string;
  channelColMentionDelta: string;
  channelEmpty: string;
  milestoneSectionTitle: string;
  milestoneColDay: string;
  milestoneColSample: string;
  milestoneColMentionWilson: string;
  milestoneColControl: string;
  milestoneColDid: string;
  milestoneEmpty: string;
  footerReadOnly: string;
  na: string;
};

const EN_COPY: CopyDict = {
  reportBadge: 'Monthly GEO ROI Report',
  readOnlyNotice: 'Read-only executive snapshot - No sign-in required',
  poweredBy: `Powered by ${SITE_NAME}`,
  printBtn: 'Print / Save PDF',
  brandLabel: 'Brand',
  categoryLabel: 'Category',
  periodLabel: 'Reporting Period',
  generatedAtLabel: 'Generated At',
  validThroughLabel: 'Link Valid Through',
  marketLabels: {
    CN: 'China (CN)',
    GLOBAL: 'Global (GLOBAL)',
  },
  confidenceLabels: {
    HIGH: 'High Confidence',
    MEDIUM: 'Medium Confidence',
    LOW: 'Low Confidence',
    INSUFFICIENT: 'Insufficient Sample',
  },
  didDirectionLabels: {
    POSITIVE: 'Positive Net Lift',
    NEGATIVE: 'Negative Lift',
    NEUTRAL: 'Neutral',
  },
  modeLabels: {
    L1_API: 'L1 Direct API',
    L2_EXTENSION: 'L2 Extension Sync',
    L3_COMMUNITY_ASSIST: 'L3 Community Assist',
    L3_PR_PACKET: 'L3 PR Media Kit',
  },
  overviewTitle: 'Executive Overview & Statistical Confidence',
  kpiMentionRate: 'Brand Mention Rate',
  kpiCitationRate: 'Citation Rate',
  kpiOwnedCitationRate: 'Owned Citation Rate',
  kpiObservations: 'Total Observations',
  kpiDidLift: 'Control-Group DiD Net Lift',
  wilsonPrefix: 'Wilson 95% CI',
  lowSampleHint: 'Low sample size (n < 5) - consider 3x sampling on retests to narrow CI.',
  didTreatmentPrefix: 'Treatment',
  didControlPrefix: 'Control',
  noControlData: 'No control-group retest recorded in this period.',
  engineSectionTitle: 'Visibility Breakdown by AI Engine',
  engineColName: 'AI Engine',
  engineColObs: 'Observations',
  engineColMentionWilson: 'Mention Rate (Wilson 95% CI)',
  engineColCitation: 'Citation Rate',
  engineColOwnedCitation: 'Owned Citation Rate',
  engineColPosition: 'Avg Rank',
  engineEmpty: 'No AI engine observations recorded in this period.',
  nearMissSectionTitle: 'Near-Miss Opportunity Conversion',
  nearMissTotal: 'Total Opportunities',
  nearMissBriefs: 'Boost Briefs Created',
  nearMissConverted: 'Converted to Cited',
  nearMissTierBreakdown: '4-Tier Breakdown',
  funnelSectionTitle: 'Distribution & Crawlability Funnel',
  funnelPublished: 'Published Total',
  funnelL1: 'L1 Direct API',
  funnelL2: 'L2 Extension',
  funnelL3: 'L3 Assist / PR',
  funnelCrawlOk: 'Crawl OK Rate',
  funnelIndexNow: 'IndexNow Success Rate',
  channelSectionTitle: 'Channel Attribution Ranking',
  channelColName: 'Channel',
  channelColMode: 'Mode',
  channelColPublished: 'Published',
  channelColRetests: 'Completed Retests',
  channelColHits: 'Citation Hits',
  channelColHitRate: 'Citation Hit Rate (95% CI)',
  channelColMentionDelta: 'Avg Mention Delta',
  channelEmpty: 'No channel attribution records in this period.',
  milestoneSectionTitle: 'Retest Milestone Trend (D+7 / D+14 / D+30)',
  milestoneColDay: 'Milestone',
  milestoneColSample: 'Hits / Trials',
  milestoneColMentionWilson: 'Mention Rate (Wilson 95% CI)',
  milestoneColControl: 'Control Mention Rate',
  milestoneColDid: 'DiD Net Lift',
  milestoneEmpty: 'No completed retest milestones in this period.',
  footerReadOnly: 'External read-only GEO ROI report',
  na: '-',
};

const ZH_COPY: CopyDict = {
  reportBadge: '月度 GEO ROI 报告',
  readOnlyNotice: '对外只读复盘快照 · 无需登录账号',
  poweredBy: `由 ${SITE_NAME} 提供支持`,
  printBtn: '打印 / 保存 PDF',
  brandLabel: '品牌',
  categoryLabel: '类目',
  periodLabel: '统计周期',
  generatedAtLabel: '生成时间',
  validThroughLabel: '链接有效期至',
  marketLabels: {
    CN: '中国市场 (CN)',
    GLOBAL: '海外市场 (GLOBAL)',
  },
  confidenceLabels: {
    HIGH: '高置信',
    MEDIUM: '中置信',
    LOW: '低置信',
    INSUFFICIENT: '样本不足',
  },
  didDirectionLabels: {
    POSITIVE: '正向净增益',
    NEGATIVE: '负向变化',
    NEUTRAL: '无显著净差',
  },
  modeLabels: {
    L1_API: 'L1 直连发布',
    L2_EXTENSION: 'L2 插件同步',
    L3_COMMUNITY_ASSIST: 'L3 社区辅助',
    L3_PR_PACKET: 'L3 PR 协作包',
  },
  overviewTitle: '核心表现总览与统计置信度',
  kpiMentionRate: '品牌提及率',
  kpiCitationRate: '引文命中率',
  kpiOwnedCitationRate: '自有官网引用率',
  kpiObservations: '累计监测观测数',
  kpiDidLift: '对照组 DiD 净增益',
  wilsonPrefix: 'Wilson 95% 置信区间',
  lowSampleHint: '当前样本量较少（n < 5），建议在复测中开启 3× 采样以收窄置信区间。',
  didTreatmentPrefix: '处理组',
  didControlPrefix: '对照组',
  noControlData: '本周期暂未启用对照组复测。',
  engineSectionTitle: '各 AI 引擎可见度明细',
  engineColName: 'AI 引擎',
  engineColObs: '观测数',
  engineColMentionWilson: '提及率（Wilson 95% CI）',
  engineColCitation: '引文命中率',
  engineColOwnedCitation: '官网引用率',
  engineColPosition: '平均顺位',
  engineEmpty: '当前统计周期暂无 AI 引擎观测记录。',
  nearMissSectionTitle: '差一步被引用（Near-Miss）转化漏斗',
  nearMissTotal: '识别机会总数',
  nearMissBriefs: '已生成补强意见卡',
  nearMissConverted: '已转化为正式引用',
  nearMissTierBreakdown: '四层机会分布',
  funnelSectionTitle: '内容分发与抓取体检漏斗',
  funnelPublished: '已发布总数',
  funnelL1: 'L1 直连发布',
  funnelL2: 'L2 插件同步',
  funnelL3: 'L3 社区 / PR',
  funnelCrawlOk: '抓取健康率',
  funnelIndexNow: 'IndexNow 成功率',
  channelSectionTitle: '渠道归因排行',
  channelColName: '渠道',
  channelColMode: '模式',
  channelColPublished: '已发布',
  channelColRetests: '已完成复测',
  channelColHits: '引文命中',
  channelColHitRate: '引文命中率（95% CI）',
  channelColMentionDelta: '平均提及率变化',
  channelEmpty: '当前统计周期暂无渠道归因数据。',
  milestoneSectionTitle: '阶梯复测趋势（D+7 / D+14 / D+30）',
  milestoneColDay: '复测节点',
  milestoneColSample: '命中 / 样本数',
  milestoneColMentionWilson: '提及率（Wilson 95% CI）',
  milestoneColControl: '对照组提及率',
  milestoneColDid: 'DiD 净增益',
  milestoneEmpty: '当前统计周期暂无已完成复测节点。',
  footerReadOnly: '对外只读 GEO ROI 复盘报告',
  na: '—',
};

const ENGINE_EN_LABELS: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  doubao: 'Doubao',
  yuanbao: 'Tencent Yuanbao',
  tongyi: 'Qwen (Tongyi)',
  wenxin: 'ERNIE Bot',
  nami: 'Nami AI',
  kimi: 'Kimi',
  zhipu: 'Zhipu GLM',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  gemini: 'Gemini',
  google_aio: 'Google AI Overviews',
};

const CONFIDENCE_TONE: Record<ConfidenceLevel, SignalTone> = {
  HIGH: 'cited',
  MEDIUM: 'info',
  LOW: 'warning',
  INSUFFICIENT: 'neutral',
};

const DID_DIRECTION_TONE: Record<DidDirection, SignalTone> = {
  POSITIVE: 'cited',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
};

function classifyLoadError(err: unknown): LoadErrorKind {
  if (err instanceof GatewayApiError) {
    if (err.status === 404) return 'not_found';
    if (err.status === 429) return 'rate_limited';
  }
  return 'generic';
}

function formatInt(value: number | null | undefined, isZh: boolean, na: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return na;
  return new Intl.NumberFormat(isZh ? 'zh-CN' : 'en-US').format(Math.round(value));
}

function formatPctRatio(value: number | null | undefined, na: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return na;
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPpRatio(value: number | null | undefined, na: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return na;
  const pp = value * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function formatPosition(value: number | null | undefined, na: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return na;
  return `#${value.toFixed(1)}`;
}

function resolveEngineLabel(engineKey: string, isZh: boolean): string {
  if (isZh) {
    const zhMap = VISIBILITY_ENGINE_LABELS as Readonly<Record<string, string>>;
    return Object.hasOwn(zhMap, engineKey) ? (zhMap[engineKey] ?? engineKey) : engineKey;
  }
  return Object.hasOwn(ENGINE_EN_LABELS, engineKey)
    ? (ENGINE_EN_LABELS[engineKey] ?? engineKey)
    : engineKey;
}

export function PublicRoiReportView({ token }: PublicRoiReportViewProps): JSX.Element {
  const [report, setReport] = useState<PublicGeoRoiReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadErrorKind | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const isZh = report ? report.locale === 'zh-CN' : false;
  const copy = isZh ? ZH_COPY : EN_COPY;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const data = await fetchPublicRoiReport(token, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setReport(data);
        setLoadError(null);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setReport(null);
        setLoadError(classifyLoadError(err));
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [token, reloadNonce]);

  useEffect(() => {
    if (!report || typeof document === 'undefined') return;
    const prevTitle = document.title;
    const prevLang = document.documentElement.lang;
    const org = report.whiteLabelOrg?.trim();
    document.documentElement.lang = report.locale;
    document.title = org ? `${report.title} - ${org}` : `${report.title} - ${SITE_NAME}`;
    return () => {
      document.title = prevTitle;
      document.documentElement.lang = prevLang;
    };
  }, [report]);

  const handlePrint = () => {
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const orgLabel = report?.whiteLabelOrg?.trim() || null;
  const formatTimestamp = (iso: string) =>
    isZh ? formatShanghaiDateTime(iso) : formatUtcDateTime(iso, EN_COPY.na);

  return (
    <ConfigProvider
      locale={isZh ? zhCN : enUS}
      theme={GM_ANTD_THEME}
      button={{ autoInsertSpace: false }}
    >
      <App>
        <main
          className="gm-public-roi-report"
          data-testid="public-roi-report-page"
          style={{ padding: '28px 20px 64px' }}
        >
          <div
            style={{
              maxWidth: 1040,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              minWidth: 0,
            }}
          >
            {loading ? (
              <section
                className="gm-panel"
                aria-busy="true"
                data-testid="public-roi-report-loading"
                style={{
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                }}
              >
                <Skeleton active title={{ width: '44%' }} paragraph={{ rows: 2 }} />
                <Skeleton active title={{ width: '30%' }} paragraph={{ rows: 4 }} />
                <Skeleton active title={{ width: '36%' }} paragraph={{ rows: 5 }} />
              </section>
            ) : loadError || !report ? (
              <section
                className="gm-panel"
                data-testid="public-roi-report-error"
                style={{
                  padding: '36px 28px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 14,
                  maxWidth: 680,
                  margin: '40px auto 0',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: GM.fg.f3,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                  }}
                >
                  GEO ROI Report
                </div>

                {loadError === 'not_found' ? (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Report Link Unavailable
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      This GEO ROI report link is invalid, expired, or has been revoked. Please
                      contact the report owner to request a new share link.
                    </p>
                  </>
                ) : loadError === 'rate_limited' ? (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Too Many Requests
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      We received too many requests in a short period. Please wait a moment and try
                      reloading this report.
                    </p>
                    <Button
                      type="primary"
                      data-testid="public-roi-retry-btn"
                      onClick={() => setReloadNonce((n) => n + 1)}
                      style={{ marginTop: 4 }}
                    >
                      Retry
                    </Button>
                  </>
                ) : (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Unable to Load Report
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      We encountered a temporary issue while loading this report. Please check your
                      network connection and try again.
                    </p>
                    <Button
                      type="primary"
                      data-testid="public-roi-retry-btn"
                      onClick={() => setReloadNonce((n) => n + 1)}
                      style={{ marginTop: 4 }}
                    >
                      Retry
                    </Button>
                  </>
                )}
              </section>
            ) : (
              <>
                {/* 1. Masthead / Header */}
                <header
                  className="gm-panel gm-roi-print-section gm-roi-print-keep"
                  data-testid="public-roi-header"
                  style={{
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      {orgLabel ? (
                        <Tag
                          color="purple"
                          data-testid="public-roi-whitelabel-badge"
                          style={{
                            margin: 0,
                            fontWeight: 600,
                            overflowWrap: 'anywhere',
                            whiteSpace: 'normal',
                          }}
                        >
                          {orgLabel}
                        </Tag>
                      ) : (
                        <Tag
                          color="cyan"
                          data-testid="public-roi-powered-by-badge"
                          style={{ margin: 0, fontWeight: 600 }}
                        >
                          {report.brandName} - {copy.poweredBy}
                        </Tag>
                      )}
                      <Tag
                        color={report.market === 'GLOBAL' ? 'blue' : 'geekblue'}
                        style={{ margin: 0 }}
                      >
                        {copy.marketLabels[report.market]}
                      </Tag>
                      <span style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.reportBadge}</span>
                    </div>

                    <Button
                      type="primary"
                      size="small"
                      className="gm-print-hide"
                      data-testid="public-roi-print-btn"
                      onClick={handlePrint}
                    >
                      {copy.printBtn}
                    </Button>
                  </div>

                  <h1
                    data-testid="public-roi-title"
                    style={{
                      margin: 0,
                      fontSize: 24,
                      lineHeight: 1.35,
                      fontWeight: 700,
                      color: GM.fg.f1,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {report.title}
                  </h1>

                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px 18px',
                      fontSize: 12.5,
                      color: GM.fg.f2,
                    }}
                  >
                    <span>
                      {copy.brandLabel}:{' '}
                      <strong style={{ color: GM.fg.f1 }}>{report.brandName}</strong>
                    </span>
                    {report.category ? (
                      <span>
                        {copy.categoryLabel}:{' '}
                        <strong style={{ color: GM.fg.f1 }}>{report.category}</strong>
                      </span>
                    ) : null}
                    <span className="gm-num" data-testid="public-roi-period">
                      {copy.periodLabel}: {formatUtcCalendarDate(report.periodStart, copy.na)} ~{' '}
                      {formatUtcCalendarDate(report.periodEnd, copy.na)}
                    </span>
                    <span className="gm-num">
                      {copy.generatedAtLabel}: {formatTimestamp(report.generatedAt)}
                    </span>
                    <span className="gm-num">
                      {copy.validThroughLabel}: {formatTimestamp(report.expiresAt)}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.readOnlyNotice}</div>
                </header>

                {/* 2. Executive Overview & Statistical Confidence */}
                <section
                  className="gm-panel gm-roi-print-section gm-roi-print-keep"
                  data-testid="public-roi-overview"
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
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
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.overviewTitle}
                    </h2>
                    <SignalPill tone={CONFIDENCE_TONE[report.summary.overview.confidenceLevel]}>
                      {copy.confidenceLabels[report.summary.overview.confidenceLevel]}
                    </SignalPill>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div
                      className="gm-roi-print-card"
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.kpiMentionRate}</div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 24, fontWeight: 700, color: GM.fg.f1, marginTop: 4 }}
                      >
                        {formatPctRatio(report.summary.overview.mentionRate, copy.na)}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 4 }}
                      >
                        {copy.wilsonPrefix}: [
                        {formatPctRatio(report.summary.overview.mentionWilson.lower, copy.na)},{' '}
                        {formatPctRatio(report.summary.overview.mentionWilson.upper, copy.na)}] (
                        {formatInt(report.summary.overview.mentionHits, isZh, copy.na)}/
                        {formatInt(report.summary.overview.totalObservations, isZh, copy.na)})
                      </div>
                    </div>

                    <div
                      className="gm-roi-print-card"
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.kpiCitationRate}</div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 24, fontWeight: 700, color: GM.sig.cited, marginTop: 4 }}
                      >
                        {formatPctRatio(report.summary.overview.citationRate, copy.na)}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 4 }}
                      >
                        {formatInt(report.summary.overview.citationHits, isZh, copy.na)} /{' '}
                        {formatInt(report.summary.overview.totalObservations, isZh, copy.na)}
                      </div>
                    </div>

                    <div
                      className="gm-roi-print-card"
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>
                        {copy.kpiOwnedCitationRate}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 24, fontWeight: 700, color: GM.fg.f1, marginTop: 4 }}
                      >
                        {formatPctRatio(report.summary.overview.ownedCitationRate, copy.na)}
                      </div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 4 }}
                      >
                        {formatInt(report.summary.overview.ownedCitationHits, isZh, copy.na)} /{' '}
                        {formatInt(report.summary.overview.totalObservations, isZh, copy.na)}
                      </div>
                    </div>

                    <div
                      className="gm-roi-print-card"
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.kpiObservations}</div>
                      <div
                        className="gm-num"
                        style={{ fontSize: 24, fontWeight: 700, color: GM.fg.f1, marginTop: 4 }}
                      >
                        {formatInt(report.summary.overview.totalObservations, isZh, copy.na)}
                      </div>
                      <div style={{ fontSize: 11.5, color: GM.fg.f3, marginTop: 4 }}>
                        {copy.confidenceLabels[report.summary.overview.confidenceLevel]}
                      </div>
                    </div>

                    <div
                      className="gm-roi-print-card"
                      data-testid="public-roi-did-card"
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.kpiDidLift}</div>
                      {report.summary.overview.did ? (
                        <>
                          <div
                            className="gm-num"
                            style={{
                              fontSize: 24,
                              fontWeight: 700,
                              color:
                                report.summary.overview.did.direction === 'POSITIVE'
                                  ? GM.sig.cited
                                  : report.summary.overview.did.direction === 'NEGATIVE'
                                    ? GM.status.danger
                                    : GM.fg.f2,
                              marginTop: 4,
                            }}
                          >
                            {formatSignedPpRatio(report.summary.overview.did.netLift, copy.na)}
                          </div>
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <SignalPill
                              tone={DID_DIRECTION_TONE[report.summary.overview.did.direction]}
                            >
                              {copy.didDirectionLabels[report.summary.overview.did.direction]}
                            </SignalPill>
                          </div>
                          <div
                            className="gm-num"
                            style={{ fontSize: 11.5, color: GM.fg.f2, marginTop: 4 }}
                          >
                            {copy.didTreatmentPrefix}:{' '}
                            {formatSignedPpRatio(
                              report.summary.overview.did.treatmentDelta,
                              copy.na,
                            )}{' '}
                            / {copy.didControlPrefix}:{' '}
                            {formatSignedPpRatio(report.summary.overview.did.controlDelta, copy.na)}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: GM.fg.f3, marginTop: 8 }}>
                          {copy.noControlData}
                        </div>
                      )}
                    </div>
                  </div>

                  {report.summary.overview.mentionWilson.trials > 0 &&
                  (report.summary.overview.confidenceLevel === 'LOW' ||
                    report.summary.overview.mentionWilson.trials < 5) ? (
                    <div
                      data-testid="public-roi-low-sample-hint"
                      style={{
                        fontSize: 12,
                        color: GM.status.warning,
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'rgba(242, 184, 75, 0.08)',
                        border: '1px solid rgba(242, 184, 75, 0.25)',
                      }}
                    >
                      {copy.lowSampleHint}
                    </div>
                  ) : null}
                </section>

                {/* 3. Engine Breakdown */}
                <section
                  className="gm-panel gm-roi-print-section gm-roi-print-table-section"
                  data-testid="public-roi-engines"
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                    {copy.engineSectionTitle}
                  </h2>

                  {report.summary.byEngine.length === 0 ? (
                    <div style={{ fontSize: 13, color: GM.fg.f3 }}>{copy.engineEmpty}</div>
                  ) : (
                    <div className="gm-roi-table-wrap">
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: 13,
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              borderBottom: '1px solid var(--gm-line-2, rgba(255,255,255,0.1))',
                              textAlign: 'left',
                              color: GM.fg.f3,
                              fontSize: 12,
                            }}
                          >
                            <th style={{ padding: '8px 10px' }}>{copy.engineColName}</th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.engineColObs}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.engineColMentionWilson}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.engineColCitation}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.engineColOwnedCitation}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.engineColPosition}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.summary.byEngine.map((row) => (
                            <tr
                              key={row.engine}
                              style={{
                                borderBottom: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                              }}
                            >
                              <td style={{ padding: '10px', fontWeight: 600, color: GM.fg.f1 }}>
                                {resolveEngineLabel(row.engine, isZh)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatInt(row.observations, isZh, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPctRatio(row.mentionRate, copy.na)} [
                                {formatPctRatio(row.mentionWilson.lower, copy.na)},{' '}
                                {formatPctRatio(row.mentionWilson.upper, copy.na)}]
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPctRatio(row.citationRate, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPctRatio(row.ownedCitationRate, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPosition(row.avgPosition, copy.na)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 4. Near-Miss Conversion & Distribution Funnel */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                    gap: 16,
                    minWidth: 0,
                  }}
                >
                  <section
                    className="gm-panel gm-roi-print-section gm-roi-print-keep"
                    data-testid="public-roi-near-miss"
                    style={{
                      padding: '20px 24px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.nearMissSectionTitle}
                    </h2>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gap: 8,
                      }}
                    >
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>{copy.nearMissTotal}</div>
                        <div
                          className="gm-num"
                          style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                        >
                          {formatInt(report.summary.nearMiss.totalOpportunities, isZh, copy.na)}
                        </div>
                      </div>
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>{copy.nearMissBriefs}</div>
                        <div
                          className="gm-num"
                          style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                        >
                          {formatInt(report.summary.nearMiss.boostBriefsCreated, isZh, copy.na)}
                        </div>
                      </div>
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>
                          {copy.nearMissConverted}
                        </div>
                        <div
                          className="gm-num"
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: GM.sig.cited,
                            marginTop: 2,
                          }}
                        >
                          {formatInt(report.summary.nearMiss.convertedToCited, isZh, copy.na)}
                        </div>
                      </div>
                    </div>

                    <div style={{ fontSize: 12, color: GM.fg.f3, marginTop: 2 }}>
                      {copy.nearMissTierBreakdown}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {NEAR_MISS_TIERS.map((tier) => (
                        <div
                          key={tier}
                          className="gm-roi-print-card"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            padding: '6px 10px',
                            borderRadius: 6,
                            background: 'var(--gm-bg-elevated, #171B1A)',
                            border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                            fontSize: 12.5,
                          }}
                        >
                          <span style={{ color: GM.fg.f2 }}>
                            {isZh ? NEAR_MISS_TIER_LABELS[tier] : NEAR_MISS_TIER_EN_LABELS[tier]}
                          </span>
                          <span className="gm-num" style={{ fontWeight: 600, color: GM.fg.f1 }}>
                            {formatInt(
                              report.summary.nearMiss.tierCounts[tier] ?? 0,
                              isZh,
                              copy.na,
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section
                    className="gm-panel gm-roi-print-section gm-roi-print-keep"
                    data-testid="public-roi-funnel"
                    style={{
                      padding: '20px 24px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.funnelSectionTitle}
                    </h2>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                        gap: 8,
                      }}
                    >
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>
                          {copy.funnelPublished}
                        </div>
                        <div
                          className="gm-num"
                          style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                        >
                          {formatInt(report.summary.funnel.publishedTotal, isZh, copy.na)}
                        </div>
                      </div>
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>{copy.funnelCrawlOk}</div>
                        <div
                          className="gm-num"
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: GM.sig.cited,
                            marginTop: 2,
                          }}
                        >
                          {formatPctRatio(report.summary.funnel.crawlOkRate, copy.na)}
                        </div>
                        <div className="gm-num" style={{ fontSize: 11, color: GM.fg.f3 }}>
                          {formatInt(report.summary.funnel.crawlOkCount, isZh, copy.na)} /{' '}
                          {formatInt(report.summary.funnel.crawlCheckedCount, isZh, copy.na)}
                        </div>
                      </div>
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>{copy.funnelIndexNow}</div>
                        <div
                          className="gm-num"
                          style={{ fontSize: 18, fontWeight: 700, color: GM.fg.f1, marginTop: 2 }}
                        >
                          {formatPctRatio(report.summary.funnel.indexNowRate, copy.na)}
                        </div>
                        <div className="gm-num" style={{ fontSize: 11, color: GM.fg.f3 }}>
                          {formatInt(report.summary.funnel.indexNowSuccessCount, isZh, copy.na)} /{' '}
                          {formatInt(report.summary.funnel.indexNowAttemptedCount, isZh, copy.na)}
                        </div>
                      </div>
                      <div
                        className="gm-roi-print-card"
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: 'var(--gm-bg-elevated, #171B1A)',
                          border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 3,
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ color: GM.fg.f3 }}>{copy.funnelL1}</span>
                          <span className="gm-num" style={{ color: GM.fg.f1, fontWeight: 600 }}>
                            {formatInt(report.summary.funnel.l1Count, isZh, copy.na)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ color: GM.fg.f3 }}>{copy.funnelL2}</span>
                          <span className="gm-num" style={{ color: GM.fg.f1, fontWeight: 600 }}>
                            {formatInt(report.summary.funnel.l2Count, isZh, copy.na)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ color: GM.fg.f3 }}>{copy.funnelL3}</span>
                          <span className="gm-num" style={{ color: GM.fg.f1, fontWeight: 600 }}>
                            {formatInt(report.summary.funnel.l3Count, isZh, copy.na)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>

                {/* 5. Channel Attribution Ranking */}
                <section
                  className="gm-panel gm-roi-print-section gm-roi-print-table-section"
                  data-testid="public-roi-channels"
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                    {copy.channelSectionTitle}
                  </h2>

                  {report.summary.channelRanking.length === 0 ? (
                    <div style={{ fontSize: 13, color: GM.fg.f3 }}>{copy.channelEmpty}</div>
                  ) : (
                    <div className="gm-roi-table-wrap">
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr
                            style={{
                              borderBottom: '1px solid var(--gm-line-2, rgba(255,255,255,0.1))',
                              textAlign: 'left',
                              color: GM.fg.f3,
                              fontSize: 12,
                            }}
                          >
                            <th style={{ padding: '8px 10px' }}>{copy.channelColName}</th>
                            <th style={{ padding: '8px 10px' }}>{copy.channelColMode}</th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.channelColPublished}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.channelColRetests}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.channelColHits}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.channelColHitRate}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.channelColMentionDelta}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.summary.channelRanking.map((row, idx) => (
                            <tr
                              key={`${row.channel}-${idx}`}
                              style={{
                                borderBottom: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                              }}
                            >
                              <td
                                style={{
                                  padding: '10px',
                                  fontWeight: 600,
                                  color: GM.fg.f1,
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {row.channel}
                              </td>
                              <td style={{ padding: '10px', color: GM.fg.f2 }}>
                                {row.mode
                                  ? Object.hasOwn(copy.modeLabels, row.mode)
                                    ? copy.modeLabels[row.mode]
                                    : row.mode
                                  : copy.na}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatInt(row.publishedCount, isZh, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatInt(row.completedRetestCount, isZh, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatInt(row.citationHitCount, isZh, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {row.citationHitRate !== null
                                  ? row.citationHitWilson
                                    ? `${formatPctRatio(row.citationHitRate, copy.na)} [${formatPctRatio(row.citationHitWilson.lower, copy.na)}, ${formatPctRatio(row.citationHitWilson.upper, copy.na)}]`
                                    : formatPctRatio(row.citationHitRate, copy.na)
                                  : copy.na}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatSignedPpRatio(row.avgMentionRateDelta, copy.na)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 6. Milestone Trend */}
                <section
                  className="gm-panel gm-roi-print-section gm-roi-print-table-section"
                  data-testid="public-roi-milestones"
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                    {copy.milestoneSectionTitle}
                  </h2>

                  {report.summary.milestoneTrend.length === 0 ? (
                    <div style={{ fontSize: 13, color: GM.fg.f3 }}>{copy.milestoneEmpty}</div>
                  ) : (
                    <div className="gm-roi-table-wrap">
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr
                            style={{
                              borderBottom: '1px solid var(--gm-line-2, rgba(255,255,255,0.1))',
                              textAlign: 'left',
                              color: GM.fg.f3,
                              fontSize: 12,
                            }}
                          >
                            <th style={{ padding: '8px 10px' }}>{copy.milestoneColDay}</th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.milestoneColSample}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.milestoneColMentionWilson}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.milestoneColControl}
                            </th>
                            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                              {copy.milestoneColDid}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.summary.milestoneTrend.map((point) => (
                            <tr
                              key={point.milestoneDay}
                              style={{
                                borderBottom: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                              }}
                            >
                              <td className="gm-num" style={{ padding: '10px', fontWeight: 600 }}>
                                D+{point.milestoneDay}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatInt(point.hits, isZh, copy.na)} /{' '}
                                {formatInt(point.trials, isZh, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPctRatio(point.mentionRate, copy.na)} [
                                {formatPctRatio(point.wilson.lower, copy.na)},{' '}
                                {formatPctRatio(point.wilson.upper, copy.na)}]
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {formatPctRatio(point.controlMentionRate, copy.na)}
                              </td>
                              <td
                                className="gm-num"
                                style={{ padding: '10px', textAlign: 'right' }}
                              >
                                {point.did
                                  ? formatSignedPpRatio(point.did.netLift, copy.na)
                                  : copy.na}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 7. Footer */}
                <footer
                  data-testid="public-roi-footer"
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '4px 6px',
                    fontSize: 12,
                    color: GM.fg.f3,
                  }}
                >
                  <span style={{ overflowWrap: 'anywhere' }}>
                    {orgLabel
                      ? `${orgLabel} - ${copy.footerReadOnly}`
                      : `${copy.poweredBy} - ${copy.footerReadOnly}`}
                  </span>
                  <span className="gm-num">
                    {copy.validThroughLabel}: {formatTimestamp(report.expiresAt)}
                  </span>
                </footer>
              </>
            )}
          </div>
        </main>
      </App>
    </ConfigProvider>
  );
}
