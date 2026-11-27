import { Injectable } from '@nestjs/common';
import {
  NEAR_MISS_TIERS,
  NEAR_MISS_TIER_EN_LABELS,
  NEAR_MISS_TIER_LABELS,
  VISIBILITY_ENGINE_LABELS,
  formatShanghaiDateTime,
  resolveEffectiveLocale,
  type ConfidenceLevel,
  type DidDirection,
  type DistributionMode,
  type GeoMarket,
  type GeoRoiReportMilestonePoint,
  type GeoRoiReportSummaryDto,
  type PublicGeoRoiReportSummaryDto,
  type SupportedLocale,
} from '@geomix/shared';
import { formatUtcDate, localizeRoiReportChannelLabel } from './roi-report-aggregator';

export type RoiReportHtmlRenderInput = {
  title: string;
  brandName: string;
  category: string;
  market: GeoMarket;
  locale: SupportedLocale | string;
  whiteLabelOrg: string | null;
  periodStart: Date | string;
  periodEnd: Date | string;
  generatedAt: Date | string;
  summary: GeoRoiReportSummaryDto | PublicGeoRoiReportSummaryDto;
  /** Default true for authenticated /export.html; set false for public mode */
  includePointsRoi?: boolean;
};

type ReportLang = 'zh' | 'en';

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

const CONFIDENCE_LABELS: Record<ReportLang, Record<ConfidenceLevel, string>> = {
  zh: {
    HIGH: '高置信',
    MEDIUM: '中置信',
    LOW: '低置信',
    INSUFFICIENT: '样本不足',
  },
  en: {
    HIGH: 'High Confidence',
    MEDIUM: 'Medium Confidence',
    LOW: 'Low Confidence',
    INSUFFICIENT: 'Insufficient Sample',
  },
};

const DID_DIRECTION_LABELS: Record<ReportLang, Record<DidDirection, string>> = {
  zh: {
    POSITIVE: '正向净增益',
    NEGATIVE: '负向变化',
    NEUTRAL: '无显著净差',
  },
  en: {
    POSITIVE: 'Positive Net Lift',
    NEGATIVE: 'Negative Lift',
    NEUTRAL: 'Neutral',
  },
};

const MARKET_LABELS: Record<ReportLang, Record<GeoMarket, string>> = {
  zh: {
    CN: '中国市场 (CN)',
    GLOBAL: '海外市场 (GLOBAL)',
  },
  en: {
    CN: 'China (CN)',
    GLOBAL: 'Global (GLOBAL)',
  },
};

const MODE_LABELS: Record<ReportLang, Record<DistributionMode, string>> = {
  zh: {
    L1_API: 'L1 直连发布',
    L2_EXTENSION: 'L2 插件同步',
    L3_COMMUNITY_ASSIST: 'L3 社区辅助',
    L3_PR_PACKET: 'L3 PR 协作包',
  },
  en: {
    L1_API: 'L1 Direct API',
    L2_EXTENSION: 'L2 Extension',
    L3_COMMUNITY_ASSIST: 'L3 Community',
    L3_PR_PACKET: 'L3 PR Packet',
  },
};

type Dict = {
  poweredBy: string;
  brandLabel: string;
  categoryLabel: string;
  marketLabel: string;
  periodLabel: string;
  generatedAtLabel: string;
  kpiMentionRate: string;
  kpiCitationRate: string;
  kpiOwnedCitationRate: string;
  kpiDidNetLift: string;
  kpiNoControlData: string;
  kpiObservationsSuffix: string;
  wilsonPrefix: string;
  didDetailPrefix: string;
  didControlPrefix: string;
  sectionTrendTitle: string;
  sectionTrendAria: string;
  trendEmpty: string;
  legendTreatment: string;
  legendWilsonBand: string;
  legendControl: string;
  sectionFunnelTitle: string;
  sectionFunnelAria: string;
  funnelPublishedTotal: string;
  funnelL1: string;
  funnelL2: string;
  funnelL3: string;
  funnelCrawlOk: string;
  funnelIndexNow: string;
  funnelNoData: string;
  sectionEngineTitle: string;
  engineColName: string;
  engineColObs: string;
  engineColMention: string;
  engineColCitation: string;
  engineColOwned: string;
  engineColAvgPos: string;
  engineEmpty: string;
  sectionChannelTitle: string;
  channelColName: string;
  channelColMode: string;
  channelColPublished: string;
  channelColRetested: string;
  channelColCitationHits: string;
  channelColCitationRate: string;
  channelColDelta: string;
  channelEmpty: string;
  sectionNearMissTitle: string;
  nearMissTotal: string;
  nearMissBoosts: string;
  nearMissConverted: string;
  nearMissColTier: string;
  nearMissColCount: string;
  sectionPointsTitle: string;
  pointsTotalSpent: string;
  pointsArticlesPublished: string;
  pointsCitationsGained: string;
  pointsPerArticle: string;
  pointsPerCitation: string;
  footerGeneratedPrefix: string;
  simulatedBanner: string;
  na: string;
  unitPoints: string;
};

const DICTIONARIES: Record<ReportLang, Dict> = {
  zh: {
    poweredBy: '由 GeoMix 提供支持',
    brandLabel: '品牌',
    categoryLabel: '类目',
    marketLabel: '市场',
    periodLabel: '统计周期',
    generatedAtLabel: '生成时间',
    kpiMentionRate: 'AI 提及率',
    kpiCitationRate: '总引用率',
    kpiOwnedCitationRate: '官网引用率',
    kpiDidNetLift: 'DiD 归因净增益',
    kpiNoControlData: '暂无对照数据',
    kpiObservationsSuffix: '次有效观测',
    wilsonPrefix: 'Wilson 95% 区间',
    didDetailPrefix: '处理组 Δ',
    didControlPrefix: '对照组 Δ',
    sectionTrendTitle: '复测里程碑趋势（T+0 → T+30）与 Wilson 95% 置信带',
    sectionTrendAria: 'T+0 到 T+30 复测提及率趋势与 Wilson 95% 置信带图',
    trendEmpty: '该周期内暂无已完成的里程碑复测数据',
    legendTreatment: '目标问句提及率',
    legendWilsonBand: 'Wilson 95% 置信带',
    legendControl: '对照组提及率',
    sectionFunnelTitle: '多渠道分发漏斗（L1 / L2 / L3）与抓取索引效率',
    sectionFunnelAria: 'L1、L2、L3 分发层级占比与 T+1 抓取成功率、IndexNow 提交率漏斗图',
    funnelPublishedTotal: '周期发布总量',
    funnelL1: 'L1 直连 API',
    funnelL2: 'L2 插件同步',
    funnelL3: 'L3 社区 / PR',
    funnelCrawlOk: 'T+1 抓取可达率',
    funnelIndexNow: 'IndexNow 提交成功率',
    funnelNoData: '该周期内暂无分发发布记录',
    sectionEngineTitle: 'AI 引擎明细表现',
    engineColName: 'AI 引擎',
    engineColObs: '观测次数',
    engineColMention: '提及率（Wilson 95% 区间）',
    engineColCitation: '总引用率',
    engineColOwned: '官网引用率',
    engineColAvgPos: '平均顺位',
    engineEmpty: '该周期内暂无有效 AI 引擎观测记录',
    sectionChannelTitle: '渠道引用命中排行',
    channelColName: '分发渠道',
    channelColMode: '模式',
    channelColPublished: '发布篇数',
    channelColRetested: '已复测',
    channelColCitationHits: '引用命中',
    channelColCitationRate: '引用命中率（Wilson 95% 区间）',
    channelColDelta: '平均提及率变化',
    channelEmpty: '该周期内暂无渠道发布与复测数据',
    sectionNearMissTitle: 'Near-Miss 机会识别与补强转化',
    nearMissTotal: '识别机会总数',
    nearMissBoosts: '已创建补强意见卡',
    nearMissConverted: '已转化为引用',
    nearMissColTier: '机会分层',
    nearMissColCount: '数量',
    sectionPointsTitle: '点数投入与产出效率（ROI）',
    pointsTotalSpent: '周期消耗点数',
    pointsArticlesPublished: '周期发布文章数',
    pointsCitationsGained: '新增引用命中数',
    pointsPerArticle: '单篇发布成本',
    pointsPerCitation: '单次引用命中成本',
    footerGeneratedPrefix: '报告生成于',
    simulatedBanner:
      '数据口径提示：本报告统计周期内包含模拟采集观测，仅供功能演示或沙盒对比参考，不代表真实 AI 引擎线上表现。',
    na: '—',
    unitPoints: '点',
  },
  en: {
    poweredBy: 'Powered by GeoMix',
    brandLabel: 'Brand',
    categoryLabel: 'Category',
    marketLabel: 'Market',
    periodLabel: 'Reporting Period',
    generatedAtLabel: 'Generated',
    kpiMentionRate: 'AI Mention Rate',
    kpiCitationRate: 'Citation Rate',
    kpiOwnedCitationRate: 'Owned Citation Rate',
    kpiDidNetLift: 'DiD Net Lift',
    kpiNoControlData: 'No Control Data',
    kpiObservationsSuffix: 'observations',
    wilsonPrefix: 'Wilson 95% CI',
    didDetailPrefix: 'Treatment Δ',
    didControlPrefix: 'Control Δ',
    sectionTrendTitle: 'Retest Milestone Trend (T+0 to T+30) & Wilson 95% CI Band',
    sectionTrendAria:
      'Retest mention rate milestone trend from T+0 to T+30 with Wilson 95% CI band',
    trendEmpty: 'No completed retest milestone data in this reporting period',
    legendTreatment: 'Treatment Mention Rate',
    legendWilsonBand: 'Wilson 95% CI',
    legendControl: 'Control Group Rate',
    sectionFunnelTitle: 'Distribution Funnel (L1 / L2 / L3) & Indexing Efficiency',
    sectionFunnelAria:
      'Distribution funnel across L1, L2, L3 tiers with T+1 crawl and IndexNow bars',
    funnelPublishedTotal: 'Total Published',
    funnelL1: 'L1 Direct API',
    funnelL2: 'L2 Extension',
    funnelL3: 'L3 Community / PR',
    funnelCrawlOk: 'T+1 Crawl OK Rate',
    funnelIndexNow: 'IndexNow Acceptance Rate',
    funnelNoData: 'No distribution publish records in this reporting period',
    sectionEngineTitle: 'AI Engine Breakdown',
    engineColName: 'AI Engine',
    engineColObs: 'Observations',
    engineColMention: 'Mention Rate (Wilson 95% CI)',
    engineColCitation: 'Citation Rate',
    engineColOwned: 'Owned Citation',
    engineColAvgPos: 'Avg Rank',
    engineEmpty: 'No completed AI engine observations in this reporting period',
    sectionChannelTitle: 'Channel Citation Hit Ranking',
    channelColName: 'Channel',
    channelColMode: 'Mode',
    channelColPublished: 'Published',
    channelColRetested: 'Retested',
    channelColCitationHits: 'Citation Hits',
    channelColCitationRate: 'Citation Hit Rate (Wilson 95% CI)',
    channelColDelta: 'Avg Mention Delta',
    channelEmpty: 'No channel publishing or retest records in this reporting period',
    sectionNearMissTitle: 'Near-Miss Opportunity & Boost Conversion',
    nearMissTotal: 'Total Opportunities',
    nearMissBoosts: 'Boost Briefs Created',
    nearMissConverted: 'Converted to Cited',
    nearMissColTier: 'Near-Miss Tier',
    nearMissColCount: 'Count',
    sectionPointsTitle: 'Points Spend & ROI Efficiency',
    pointsTotalSpent: 'Total Points Spent',
    pointsArticlesPublished: 'Articles Published',
    pointsCitationsGained: 'Citation Hits Gained',
    pointsPerArticle: 'Points / Published Article',
    pointsPerCitation: 'Points / Citation Hit',
    footerGeneratedPrefix: 'Generated at',
    simulatedBanner:
      'Notice: This reporting period includes simulated collector observations for demonstration/preview reference only and does not represent live AI engine answers.',
    na: 'N/A',
    unitPoints: 'pts',
  },
};

export function escapeHtml(raw: unknown): string {
  const text = raw === null || raw === undefined ? '' : String(raw);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function safeNum(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, safeNum(value, min)));
}

function svgCoord(value: number): string {
  return clamp(value, -10_000, 10_000).toFixed(2);
}

function formatPct(rate01: number | null | undefined, na: string): string {
  if (typeof rate01 !== 'number' || !Number.isFinite(rate01)) return na;
  return `${(clamp(rate01, 0, 1) * 100).toFixed(1)}%`;
}

function safeLookup<T>(
  dict: Readonly<Record<string, T>>,
  key: string | null | undefined,
): T | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(dict, key)) {
    return undefined;
  }
  return dict[key];
}

function formatSignedPp(delta01: number | null | undefined, na: string, maxAbs = 1): string {
  if (typeof delta01 !== 'number' || !Number.isFinite(delta01)) return na;
  const bound = Math.max(0, safeNum(maxAbs, 1));
  const pp = clamp(delta01, -bound, bound) * 100;
  const sign = pp > 0 ? '+' : '';
  return `${sign}${pp.toFixed(1)}pp`;
}

function formatInt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return String(Math.max(0, Math.round(value)));
}

function formatDecimal(value: number | null | undefined, digits: number, na: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return na;
  return value.toFixed(digits);
}

function resolveEngineLabel(engineKey: string, lang: ReportLang): string {
  const normalized = engineKey.trim();
  if (lang === 'en') {
    return safeLookup(ENGINE_EN_LABELS, normalized) ?? normalized;
  }
  const zhLabels = VISIBILITY_ENGINE_LABELS as Readonly<Record<string, string>>;
  return safeLookup(zhLabels, normalized) ?? normalized;
}

function resolveChannelLabel(
  channel: string,
  provider: GeoRoiReportSummaryDto['channelRanking'][number]['provider'],
  lang: ReportLang,
): string {
  return localizeRoiReportChannelLabel(channel, provider, lang);
}

function renderMilestoneTrendSvg(
  points: readonly GeoRoiReportMilestonePoint[],
  dict: Dict,
): string {
  const width = 680;
  const height = 240;
  const padLeft = 52;
  const padRight = 28;
  const padTop = 34;
  const padBottom = 42;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const sorted = [...points].sort((a, b) => safeNum(a.milestoneDay) - safeNum(b.milestoneDay));
  if (sorted.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(dict.sectionTrendAria)}">
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-dasharray="6 4"/>
  <text x="${svgCoord(width / 2)}" y="${svgCoord(height / 2 + 4)}" text-anchor="middle" font-size="13" fill="#64748b">${escapeHtml(dict.trendEmpty)}</text>
</svg>`;
  }

  const xForIndex = (idx: number): number => {
    if (sorted.length === 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (sorted.length - 1)) * plotWidth;
  };
  const yForRate = (rate01: number): number => {
    return padTop + (1 - clamp(rate01, 0, 1)) * plotHeight;
  };

  const gridTicks = [0, 0.25, 0.5, 0.75, 1];
  const gridLines = gridTicks
    .map((tick) => {
      const y = svgCoord(yForRate(tick));
      const label = `${Math.round(tick * 100)}%`;
      return `<line x1="${svgCoord(padLeft)}" y1="${y}" x2="${svgCoord(width - padRight)}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>
  <text x="${svgCoord(padLeft - 8)}" y="${svgCoord(yForRate(tick) + 4)}" text-anchor="end" font-size="10" fill="#64748b">${escapeHtml(label)}</text>`;
    })
    .join('\n  ');

  const upperCoords: string[] = [];
  const lowerCoords: string[] = [];
  const lineCoords: string[] = [];
  const controlCoords: string[] = [];
  const whiskers: string[] = [];
  const markers: string[] = [];
  const xLabels: string[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const pt = sorted[i]!;
    const x = xForIndex(i);
    const rate = clamp(pt.mentionRate, 0, 1);
    const lower = clamp(pt.wilson?.lower ?? rate, 0, 1);
    const upper = clamp(pt.wilson?.upper ?? rate, 0, 1);
    const y = yForRate(rate);
    const yLower = yForRate(lower);
    const yUpper = yForRate(upper);

    upperCoords.push(`${svgCoord(x)},${svgCoord(yUpper)}`);
    lowerCoords.unshift(`${svgCoord(x)},${svgCoord(yLower)}`);
    lineCoords.push(`${svgCoord(x)},${svgCoord(y)}`);

    whiskers.push(
      `<line x1="${svgCoord(x)}" y1="${svgCoord(yUpper)}" x2="${svgCoord(x)}" y2="${svgCoord(yLower)}" stroke="#0284c7" stroke-width="1.5" opacity="0.65"/>
  <line x1="${svgCoord(x - 4)}" y1="${svgCoord(yUpper)}" x2="${svgCoord(x + 4)}" y2="${svgCoord(yUpper)}" stroke="#0284c7" stroke-width="1.5" opacity="0.65"/>
  <line x1="${svgCoord(x - 4)}" y1="${svgCoord(yLower)}" x2="${svgCoord(x + 4)}" y2="${svgCoord(yLower)}" stroke="#0284c7" stroke-width="1.5" opacity="0.65"/>`,
    );

    markers.push(
      `<circle cx="${svgCoord(x)}" cy="${svgCoord(y)}" r="4.2" fill="#0284c7" stroke="#ffffff" stroke-width="1.5"/>
  <text x="${svgCoord(x)}" y="${svgCoord(Math.max(padTop + 10, y - 10))}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#0f172a">${escapeHtml(`${(rate * 100).toFixed(1)}%`)}</text>`,
    );

    const dayLabel = `T+${Math.max(0, Math.round(safeNum(pt.milestoneDay)))}`;
    xLabels.push(
      `<text x="${svgCoord(x)}" y="${svgCoord(height - 16)}" text-anchor="middle" font-size="11" fill="#334155">${escapeHtml(dayLabel)}</text>`,
    );

    if (typeof pt.controlMentionRate === 'number' && Number.isFinite(pt.controlMentionRate)) {
      const cy = yForRate(pt.controlMentionRate);
      controlCoords.push(`${svgCoord(x)},${svgCoord(cy)}`);
    }
  }

  const bandPolygon =
    sorted.length >= 2
      ? `<polygon points="${[...upperCoords, ...lowerCoords].join(' ')}" fill="rgba(14,165,233,0.16)" stroke="none"/>`
      : '';
  const treatmentLine =
    sorted.length >= 2
      ? `<polyline points="${lineCoords.join(' ')}" fill="none" stroke="#0284c7" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
      : '';
  const hasControl = controlCoords.length > 0;
  const controlSeries =
    controlCoords.length >= 2
      ? `<polyline points="${controlCoords.join(' ')}" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="5 4"/>`
      : controlCoords.length === 1
        ? (() => {
            const [cx, cy] = controlCoords[0]!.split(',');
            return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#64748b"/>`;
          })()
        : '';

  const legendItems = [
    `<rect x="${svgCoord(padLeft)}" y="10" width="12" height="3" fill="#0284c7"/>
  <text x="${svgCoord(padLeft + 18)}" y="15" font-size="11" fill="#334155">${escapeHtml(dict.legendTreatment)}</text>`,
    `<rect x="${svgCoord(padLeft + 170)}" y="7" width="12" height="9" fill="rgba(14,165,233,0.22)" stroke="#0284c7" stroke-width="0.6"/>
  <text x="${svgCoord(padLeft + 188)}" y="15" font-size="11" fill="#334155">${escapeHtml(dict.legendWilsonBand)}</text>`,
  ];
  if (hasControl) {
    legendItems.push(
      `<line x1="${svgCoord(padLeft + 340)}" y1="11.5" x2="${svgCoord(padLeft + 354)}" y2="11.5" stroke="#64748b" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="${svgCoord(padLeft + 360)}" y="15" font-size="11" fill="#334155">${escapeHtml(dict.legendControl)}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(dict.sectionTrendAria)}">
  <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#ffffff"/>
  ${legendItems.join('\n  ')}
  ${gridLines}
  ${bandPolygon}
  ${whiskers.join('\n  ')}
  ${controlSeries}
  ${treatmentLine}
  ${markers.join('\n  ')}
  ${xLabels.join('\n  ')}
</svg>`;
}

function renderDistributionFunnelSvg(funnel: GeoRoiReportSummaryDto['funnel'], dict: Dict): string {
  const width = 680;
  const height = 200;
  const barX = 180;
  const barW = 420;
  const total = Math.max(0, Math.round(safeNum(funnel.publishedTotal)));
  const l1 = Math.max(0, Math.round(safeNum(funnel.l1Count)));
  const l2 = Math.max(0, Math.round(safeNum(funnel.l2Count)));
  const l3 = Math.max(0, Math.round(safeNum(funnel.l3Count)));
  const tierSum = Math.max(1, l1 + l2 + l3);

  const l1W = total > 0 ? (l1 / tierSum) * barW : 0;
  const l2W = total > 0 ? (l2 / tierSum) * barW : 0;
  const l3W = total > 0 && l3 > 0 ? Math.max(0, barW - l1W - l2W) : 0;

  const crawlRate =
    typeof funnel.crawlOkRate === 'number' && Number.isFinite(funnel.crawlOkRate)
      ? clamp(funnel.crawlOkRate, 0, 1)
      : null;
  const indexNowRate =
    typeof funnel.indexNowRate === 'number' && Number.isFinite(funnel.indexNowRate)
      ? clamp(funnel.indexNowRate, 0, 1)
      : null;

  const crawlW = crawlRate !== null ? crawlRate * barW : 0;
  const indexW = indexNowRate !== null ? indexNowRate * barW : 0;

  const crawlText =
    crawlRate !== null
      ? `${(crawlRate * 100).toFixed(1)}% (${formatInt(funnel.crawlOkCount)}/${formatInt(funnel.crawlCheckedCount)})`
      : dict.na;
  const indexText =
    indexNowRate !== null
      ? `${(indexNowRate * 100).toFixed(1)}% (${formatInt(funnel.indexNowSuccessCount)}/${formatInt(funnel.indexNowAttemptedCount)})`
      : dict.na;

  const tierLegend = `${dict.funnelL1}: ${l1}  ·  ${dict.funnelL2}: ${l2}  ·  ${dict.funnelL3}: ${l3}`;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(dict.sectionFunnelAria)}">
  <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#ffffff"/>
  <text x="16" y="34" font-size="12" font-weight="600" fill="#0f172a">${escapeHtml(dict.funnelPublishedTotal)}</text>
  <rect x="${svgCoord(barX)}" y="18" width="${svgCoord(barW)}" height="24" rx="4" fill="#f1f5f9"/>
  ${l1W > 0 ? `<rect x="${svgCoord(barX)}" y="18" width="${svgCoord(l1W)}" height="24" rx="4" fill="#0284c7"/>` : ''}
  ${l2W > 0 ? `<rect x="${svgCoord(barX + l1W)}" y="18" width="${svgCoord(l2W)}" height="24" fill="#7c3aed"/>` : ''}
  ${l3W > 0 ? `<rect x="${svgCoord(barX + l1W + l2W)}" y="18" width="${svgCoord(l3W)}" height="24" rx="4" fill="#d97706"/>` : ''}
  <text x="${svgCoord(barX + barW + 10)}" y="34" font-size="12" font-weight="600" fill="#0f172a">${escapeHtml(String(total))}</text>
  <text x="${svgCoord(barX)}" y="58" font-size="10.5" fill="#475569">${escapeHtml(tierLegend)}</text>

  <text x="16" y="102" font-size="12" font-weight="600" fill="#0f172a">${escapeHtml(dict.funnelCrawlOk)}</text>
  <rect x="${svgCoord(barX)}" y="86" width="${svgCoord(barW)}" height="22" rx="4" fill="#f1f5f9"/>
  ${crawlW > 0 ? `<rect x="${svgCoord(barX)}" y="86" width="${svgCoord(crawlW)}" height="22" rx="4" fill="#059669"/>` : ''}
  <text x="${svgCoord(barX + barW + 10)}" y="101" font-size="11" font-weight="600" fill="#0f172a">${escapeHtml(crawlText)}</text>

  <text x="16" y="152" font-size="12" font-weight="600" fill="#0f172a">${escapeHtml(dict.funnelIndexNow)}</text>
  <rect x="${svgCoord(barX)}" y="136" width="${svgCoord(barW)}" height="22" rx="4" fill="#f1f5f9"/>
  ${indexW > 0 ? `<rect x="${svgCoord(barX)}" y="136" width="${svgCoord(indexW)}" height="22" rx="4" fill="#2563eb"/>` : ''}
  <text x="${svgCoord(barX + barW + 10)}" y="151" font-size="11" font-weight="600" fill="#0f172a">${escapeHtml(indexText)}</text>
</svg>`;
}

export function renderRoiReportHtml(input: RoiReportHtmlRenderInput): string {
  const market: GeoMarket = input.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
  const effectiveLocale = resolveEffectiveLocale(input.locale, market);
  const lang: ReportLang = effectiveLocale === 'zh-CN' ? 'zh' : 'en';
  const dict = DICTIONARIES[lang];

  const periodStartText = formatUtcDate(input.periodStart) || dict.na;
  const periodEndText = formatUtcDate(input.periodEnd) || dict.na;
  const generatedAtText = formatShanghaiDateTime(input.generatedAt) || dict.na;
  const whiteLabelOrg = input.whiteLabelOrg?.trim() || null;

  const mastheadBadge = whiteLabelOrg
    ? escapeHtml(whiteLabelOrg)
    : `${escapeHtml(input.brandName)} · ${escapeHtml(dict.poweredBy)}`;
  const footerLine = whiteLabelOrg
    ? `${escapeHtml(whiteLabelOrg)} · ${escapeHtml(dict.footerGeneratedPrefix)} ${escapeHtml(generatedAtText)}`
    : `${escapeHtml(input.brandName)} · ${escapeHtml(dict.poweredBy)} · ${escapeHtml(dict.footerGeneratedPrefix)} ${escapeHtml(generatedAtText)}`;

  const fontStack =
    lang === 'zh'
      ? '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
      : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  const { summary } = input;
  const ov = summary.overview;
  const confLabel =
    safeLookup(CONFIDENCE_LABELS[lang], ov.confidenceLevel) ?? CONFIDENCE_LABELS[lang].INSUFFICIENT;
  const wilsonSummary = `${dict.wilsonPrefix}: ${formatPct(ov.mentionWilson.lower, dict.na)} – ${formatPct(ov.mentionWilson.upper, dict.na)} (${formatInt(ov.mentionHits)}/${formatInt(ov.totalObservations)})`;

  const didCardValue = ov.did ? formatSignedPp(ov.did.netLift, dict.na, 2) : dict.kpiNoControlData;
  const didDirectionLabel = ov.did
    ? (safeLookup(DID_DIRECTION_LABELS[lang], ov.did.direction) ?? dict.na)
    : '';
  const didCardSub = ov.did
    ? `${didDirectionLabel} · ${dict.didDetailPrefix} ${formatSignedPp(ov.did.treatmentDelta, dict.na)} / ${dict.didControlPrefix} ${formatSignedPp(ov.did.controlDelta, dict.na)}`
    : `${formatInt(ov.totalObservations)} ${dict.kpiObservationsSuffix}`;

  const engineRowsHtml =
    summary.byEngine.length > 0
      ? summary.byEngine
          .map((item) => {
            const label = resolveEngineLabel(item.engine, lang);
            const wilsonStr = `${formatPct(item.mentionRate, dict.na)} (${formatPct(item.mentionWilson.lower, dict.na)}–${formatPct(item.mentionWilson.upper, dict.na)})`;
            return `<tr>
            <td><strong>${escapeHtml(label)}</strong></td>
            <td class="num">${escapeHtml(formatInt(item.observations))}</td>
            <td class="num">${escapeHtml(wilsonStr)}</td>
            <td class="num">${escapeHtml(formatPct(item.citationRate, dict.na))}</td>
            <td class="num">${escapeHtml(formatPct(item.ownedCitationRate, dict.na))}</td>
            <td class="num">${escapeHtml(formatDecimal(item.avgPosition, 1, dict.na))}</td>
          </tr>`;
          })
          .join('\n')
      : `<tr><td colspan="6" class="empty-cell">${escapeHtml(dict.engineEmpty)}</td></tr>`;

  const channelRowsHtml =
    summary.channelRanking.length > 0
      ? summary.channelRanking
          .map((item) => {
            const label = resolveChannelLabel(item.channel, item.provider, lang);
            const modeLabel =
              (item.mode ? safeLookup(MODE_LABELS[lang], item.mode) : undefined) ?? dict.na;
            const rateStr =
              item.citationHitRate !== null
                ? item.citationHitWilson
                  ? `${formatPct(item.citationHitRate, dict.na)} (${formatPct(item.citationHitWilson.lower, dict.na)}–${formatPct(item.citationHitWilson.upper, dict.na)})`
                  : formatPct(item.citationHitRate, dict.na)
                : dict.na;
            return `<tr>
            <td><strong>${escapeHtml(label)}</strong></td>
            <td>${escapeHtml(modeLabel)}</td>
            <td class="num">${escapeHtml(formatInt(item.publishedCount))}</td>
            <td class="num">${escapeHtml(formatInt(item.completedRetestCount))}</td>
            <td class="num">${escapeHtml(formatInt(item.citationHitCount))}</td>
            <td class="num">${escapeHtml(rateStr)}</td>
            <td class="num">${escapeHtml(formatSignedPp(item.avgMentionRateDelta, dict.na))}</td>
          </tr>`;
          })
          .join('\n')
      : `<tr><td colspan="7" class="empty-cell">${escapeHtml(dict.channelEmpty)}</td></tr>`;

  const nearMissLabels = (
    lang === 'zh' ? NEAR_MISS_TIER_LABELS : NEAR_MISS_TIER_EN_LABELS
  ) as Readonly<Record<string, string>>;
  const nearMissRowsHtml = NEAR_MISS_TIERS.map((tier) => {
    const count =
      safeLookup(summary.nearMiss.tierCounts as Readonly<Record<string, number>>, tier) ?? 0;
    const tierLabel = safeLookup(nearMissLabels, tier) ?? tier;
    return `<tr>
      <td>${escapeHtml(tierLabel)}</td>
      <td class="num">${escapeHtml(formatInt(count))}</td>
    </tr>`;
  }).join('\n');

  const pointsRoi =
    input.includePointsRoi !== false && 'pointsRoi' in summary && summary.pointsRoi
      ? summary.pointsRoi
      : null;

  const pointsRoiSectionHtml = pointsRoi
    ? `<section class="section-card">
      <h2>${escapeHtml(dict.sectionPointsTitle)}</h2>
      <div class="mini-grid">
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.pointsTotalSpent)}</div>
          <div class="mini-value">${escapeHtml(formatInt(pointsRoi.totalPointsSpent))} ${escapeHtml(dict.unitPoints)}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.pointsArticlesPublished)}</div>
          <div class="mini-value">${escapeHtml(formatInt(pointsRoi.articlesPublished))}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.pointsCitationsGained)}</div>
          <div class="mini-value">${escapeHtml(formatInt(pointsRoi.citationHitsGained))}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.pointsPerArticle)}</div>
          <div class="mini-value">${escapeHtml(pointsRoi.pointsPerPublishedArticle !== null ? `${formatDecimal(pointsRoi.pointsPerPublishedArticle, 1, dict.na)} ${dict.unitPoints}` : dict.na)}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.pointsPerCitation)}</div>
          <div class="mini-value">${escapeHtml(pointsRoi.pointsPerCitationHit !== null ? `${formatDecimal(pointsRoi.pointsPerCitationHit, 1, dict.na)} ${dict.unitPoints}` : dict.na)}</div>
        </div>
      </div>
    </section>`
    : '';

  const trendSvg = renderMilestoneTrendSvg(summary.milestoneTrend, dict);
  const funnelSvg = renderDistributionFunnelSvg(summary.funnel, dict);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(effectiveLocale)}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(input.title)}</title>
  <style>
    @page {
      size: A4;
      margin: 14mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #f8fafc;
      color: #0f172a;
      font-family: ${fontStack};
      font-size: 14px;
      line-height: 1.55;
    }
    .report-shell {
      max-width: 900px;
      margin: 24px auto;
      padding: 32px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
    }
    .report-header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 18px;
      margin-bottom: 24px;
    }
    .brand-badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: #0284c7;
      background: #e0f2fe;
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 24px;
      line-height: 1.3;
      color: #0f172a;
    }
    h2 {
      margin: 0 0 14px 0;
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
      border-left: 3px solid #0284c7;
      padding-left: 10px;
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
      font-size: 12.5px;
      color: #475569;
    }
    .meta-pill {
      display: inline-block;
      font-size: 11.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      background: #f1f5f9;
      color: #0f172a;
    }
    .simulated-banner {
      margin-bottom: 18px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid #f59e0b;
      background: #fffbeb;
      color: #92400e;
      font-size: 12.5px;
      font-weight: 500;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .kpi-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px;
      background: #f8fafc;
    }
    .kpi-label {
      font-size: 12px;
      color: #475569;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 22px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 4px;
    }
    .kpi-sub {
      font-size: 11px;
      color: #64748b;
    }
    .section-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 20px;
      background: #ffffff;
    }
    .chart-card {
      overflow: hidden;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .mini-stat {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 12px;
      background: #f8fafc;
    }
    .mini-label {
      font-size: 11.5px;
      color: #475569;
      margin-bottom: 4px;
    }
    .mini-value {
      font-size: 17px;
      font-weight: 700;
      color: #0f172a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
    }
    th {
      background: #f8fafc;
      color: #334155;
      font-weight: 600;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .empty-cell {
      text-align: center;
      color: #64748b;
      padding: 18px 10px;
    }
    .report-footer {
      margin-top: 24px;
      padding-top: 14px;
      border-top: 1px solid #e2e8f0;
      font-size: 11.5px;
      color: #64748b;
      text-align: center;
    }
    @media print {
      html, body {
        background: #ffffff !important;
        color: #0f172a !important;
        margin: 0;
        padding: 0;
        font-size: 11pt;
      }
      .report-shell {
        max-width: none;
        margin: 0;
        padding: 0;
        box-shadow: none;
        border: none;
      }
      .section-card,
      .kpi-card,
      .chart-card,
      tr {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      h2, h3 {
        break-after: avoid;
        page-break-after: avoid;
      }
      thead {
        display: table-header-group;
      }
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <header class="report-header">
      <div class="brand-badge">${mastheadBadge}</div>
      <h1>${escapeHtml(input.title)}</h1>
      <div class="meta-row">
        <span><strong>${escapeHtml(dict.brandLabel)}:</strong> ${escapeHtml(input.brandName)}</span>
        <span><strong>${escapeHtml(dict.categoryLabel)}:</strong> ${escapeHtml(input.category)}</span>
        <span><strong>${escapeHtml(dict.marketLabel)}:</strong> ${escapeHtml(safeLookup(MARKET_LABELS[lang], market) ?? market)}</span>
        <span><strong>${escapeHtml(dict.periodLabel)}:</strong> ${escapeHtml(periodStartText)} ~ ${escapeHtml(periodEndText)}</span>
        <span><strong>${escapeHtml(dict.generatedAtLabel)}:</strong> ${escapeHtml(generatedAtText)}</span>
        <span class="meta-pill">${escapeHtml(confLabel)}</span>
      </div>
    </header>

    ${ov.hasSimulatedObservations ? `<div class="simulated-banner" role="note">${escapeHtml(dict.simulatedBanner)}</div>` : ''}

    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(dict.kpiMentionRate)}</div>
        <div class="kpi-value">${escapeHtml(formatPct(ov.mentionRate, dict.na))}</div>
        <div class="kpi-sub">${escapeHtml(wilsonSummary)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(dict.kpiCitationRate)}</div>
        <div class="kpi-value">${escapeHtml(formatPct(ov.citationRate, dict.na))}</div>
        <div class="kpi-sub">${escapeHtml(`${formatInt(ov.citationHits)}/${formatInt(ov.totalObservations)} ${dict.kpiObservationsSuffix}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(dict.kpiOwnedCitationRate)}</div>
        <div class="kpi-value">${escapeHtml(formatPct(ov.ownedCitationRate, dict.na))}</div>
        <div class="kpi-sub">${escapeHtml(`${formatInt(ov.ownedCitationHits)}/${formatInt(ov.totalObservations)} ${dict.kpiObservationsSuffix}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(dict.kpiDidNetLift)}</div>
        <div class="kpi-value">${escapeHtml(didCardValue)}</div>
        <div class="kpi-sub">${escapeHtml(didCardSub)}</div>
      </div>
    </section>

    <section class="section-card chart-card">
      <h2>${escapeHtml(dict.sectionTrendTitle)}</h2>
      ${trendSvg}
    </section>

    <section class="section-card chart-card">
      <h2>${escapeHtml(dict.sectionFunnelTitle)}</h2>
      ${funnelSvg}
    </section>

    <section class="section-card">
      <h2>${escapeHtml(dict.sectionEngineTitle)}</h2>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(dict.engineColName)}</th>
            <th class="num">${escapeHtml(dict.engineColObs)}</th>
            <th class="num">${escapeHtml(dict.engineColMention)}</th>
            <th class="num">${escapeHtml(dict.engineColCitation)}</th>
            <th class="num">${escapeHtml(dict.engineColOwned)}</th>
            <th class="num">${escapeHtml(dict.engineColAvgPos)}</th>
          </tr>
        </thead>
        <tbody>
          ${engineRowsHtml}
        </tbody>
      </table>
    </section>

    <section class="section-card">
      <h2>${escapeHtml(dict.sectionChannelTitle)}</h2>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(dict.channelColName)}</th>
            <th>${escapeHtml(dict.channelColMode)}</th>
            <th class="num">${escapeHtml(dict.channelColPublished)}</th>
            <th class="num">${escapeHtml(dict.channelColRetested)}</th>
            <th class="num">${escapeHtml(dict.channelColCitationHits)}</th>
            <th class="num">${escapeHtml(dict.channelColCitationRate)}</th>
            <th class="num">${escapeHtml(dict.channelColDelta)}</th>
          </tr>
        </thead>
        <tbody>
          ${channelRowsHtml}
        </tbody>
      </table>
    </section>

    <section class="section-card">
      <h2>${escapeHtml(dict.sectionNearMissTitle)}</h2>
      <div class="mini-grid">
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.nearMissTotal)}</div>
          <div class="mini-value">${escapeHtml(formatInt(summary.nearMiss.totalOpportunities))}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.nearMissBoosts)}</div>
          <div class="mini-value">${escapeHtml(formatInt(summary.nearMiss.boostBriefsCreated))}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-label">${escapeHtml(dict.nearMissConverted)}</div>
          <div class="mini-value">${escapeHtml(formatInt(summary.nearMiss.convertedToCited))}</div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(dict.nearMissColTier)}</th>
            <th class="num">${escapeHtml(dict.nearMissColCount)}</th>
          </tr>
        </thead>
        <tbody>
          ${nearMissRowsHtml}
        </tbody>
      </table>
    </section>

    ${pointsRoiSectionHtml}

    <footer class="report-footer">${footerLine}</footer>
  </main>
</body>
</html>
`;
}

@Injectable()
export class RoiReportHtmlRenderer {
  render(input: RoiReportHtmlRenderInput): string {
    return renderRoiReportHtml(input);
  }
}
