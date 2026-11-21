import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  BRAND_FACT_CORE_SLOTS,
  CN_RECOMMENDED_CHANNELS,
  GEO_BRIEF_SOURCES,
  GEO_BRIEF_STATUSES,
  GEO_RECIPES,
  GEO_TARGET_FORMATS,
  defaultRecipeForBriefSource,
  defaultTargetFormatForMarket,
  geoOutlineHeadingSchema,
  normalizeFanOutQueries,
  recommendBriefTargetFormat,
  recommendChannelsForMarket,
  targetFormatsForMarket,
  type BrandFactSlot,
  type CitationSourceKind,
  type GeoBriefChannelRecommendation,
  type GeoBriefRecord,
  type GeoBriefSource,
  type GeoBriefStatus,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoTargetFormat,
} from '@geomix/shared';

const BRACKETED_METADATA_TAG = /\[[A-Z][A-Z0-9_-]{1,31}\]/g;

const CN_CHANNEL_FORBIDDEN_IN_GLOBAL = [
  '小红书',
  '什么值得买',
  '知乎',
  '字节头条',
  '抖音',
  '微信公众号',
  '微博',
] as const;

export type GeoBriefRow = {
  id: string;
  brandId: string;
  brandMarketId: string;
  sourceType: string;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  targetPrompt: string;
  priorityScore: number;
  diagnosisSummary: string;
  recommendedRecipe: string;
  targetFormat: string;
  suggestedTitle: string;
  outlineH2: Prisma.JsonValue;
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: Prisma.JsonValue;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

export type ParsedCompetitorHit = {
  name: string;
  mentioned: boolean;
  position: number | null;
};

export type BriefSignalCitation = {
  url: string;
  domain: string;
  title: string | null;
  sourceKind: CitationSourceKind;
};

export type BriefSignalObservation = {
  id: string;
  runId: string;
  promptText: string;
  engine: string;
  answerText: string | null;
  brandMentioned: boolean | null;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: Prisma.JsonValue;
  fanOutQueries: string[];
  citations: BriefSignalCitation[];
};

export type BriefMatchedFact = {
  factId: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
};

export type BriefSynthesisContext = {
  market: GeoMarket;
  brandName: string;
  localBrandName: string;
  category: string;
  sourceType: GeoBriefSource;
  priorityScore: number;
  targetPrompt: string;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  sourceCitationTitle?: string | null;
  competitorFocus: string[];
  targetFanOuts: string[];
  observations: readonly BriefSignalObservation[];
  citations: readonly BriefSignalCitation[];
  matchedFacts: readonly BriefMatchedFact[];
  presentFactSlots: ReadonlySet<BrandFactSlot>;
};

export type BriefDraft = {
  diagnosisSummary: string;
  recommendedRecipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  suggestedTitle: string;
  outlineH2: GeoOutlineHeading[];
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: GeoBriefChannelRecommendation[];
};

export function cleanPromptForDisplay(raw: string): string {
  return raw.replace(BRACKETED_METADATA_TAG, ' ').replace(/\s+/g, ' ').trim();
}

export function dedupeTrimmed(values: readonly string[], maxItems = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseObservationCompetitorHits(raw: Prisma.JsonValue): ParsedCompetitorHit[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedCompetitorHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const mentioned = rec.mentioned === true;
    const position =
      typeof rec.position === 'number' && Number.isFinite(rec.position) ? rec.position : null;
    out.push({ name, mentioned, position });
  }
  return out;
}

export function parseStoredOutlineH2(raw: Prisma.JsonValue): GeoOutlineHeading[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoOutlineHeading[] = [];
  for (const entry of raw) {
    const parsed = geoOutlineHeadingSchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

export function parseStoredChannels(raw: Prisma.JsonValue): GeoBriefChannelRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoBriefChannelRecommendation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const channel = typeof rec.channel === 'string' ? rec.channel.trim() : '';
    const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
    if (!channel || !reason) continue;
    out.push({ channel: channel.slice(0, 80), reason: reason.slice(0, 300) });
  }
  return out;
}

function toMarket(raw?: string | null): GeoMarket {
  return raw === 'GLOBAL' ? 'GLOBAL' : 'CN';
}

function toBriefSource(raw: string): GeoBriefSource {
  return (GEO_BRIEF_SOURCES as readonly string[]).includes(raw)
    ? (raw as GeoBriefSource)
    : 'MANUAL';
}

function toBriefStatus(raw: string): GeoBriefStatus {
  return (GEO_BRIEF_STATUSES as readonly string[]).includes(raw) ? (raw as GeoBriefStatus) : 'OPEN';
}

function toRecipe(raw: string): GeoRecipe {
  return (GEO_RECIPES as readonly string[]).includes(raw) ? (raw as GeoRecipe) : 'AUTHORITY_GUIDE';
}

function toTargetFormat(raw: string, market: GeoMarket): GeoTargetFormat {
  if (
    (GEO_TARGET_FORMATS as readonly string[]).includes(raw) &&
    targetFormatsForMarket(market).includes(raw as GeoTargetFormat)
  ) {
    return raw as GeoTargetFormat;
  }
  return defaultTargetFormatForMarket(market);
}

export function presentBrief(row: GeoBriefRow, fallbackMarket?: GeoMarket): GeoBriefRecord {
  const market = toMarket(row.brandMarket?.market ?? fallbackMarket ?? 'CN');
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    sourceType: toBriefSource(row.sourceType),
    sourceRunId: row.sourceRunId ?? null,
    sourceObservationIds: row.sourceObservationIds ?? [],
    sourceCitationUrl: row.sourceCitationUrl ?? null,
    targetPrompt: row.targetPrompt,
    priorityScore: row.priorityScore,
    diagnosisSummary: row.diagnosisSummary,
    recommendedRecipe: toRecipe(row.recommendedRecipe),
    targetFormat: toTargetFormat(row.targetFormat, market),
    suggestedTitle: row.suggestedTitle,
    outlineH2: parseStoredOutlineH2(row.outlineH2),
    targetFanOuts: row.targetFanOuts ?? [],
    competitorFocus: row.competitorFocus ?? [],
    matchedFactIds: row.matchedFactIds ?? [],
    missingFactHints: row.missingFactHints ?? [],
    recommendedChannels: parseStoredChannels(row.recommendedChannels),
    status: toBriefStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function summarizeCitationKinds(citations: readonly BriefSignalCitation[]) {
  const counts: Record<CitationSourceKind, number> = {
    OWNED: 0,
    COMPETITOR: 0,
    SOCIAL: 0,
    AUTHORITY: 0,
    ECOMMERCE: 0,
    OTHER: 0,
  };
  for (const cite of citations) {
    counts[cite.sourceKind] = (counts[cite.sourceKind] ?? 0) + 1;
  }
  return counts;
}

export function buildMissingFactHints(
  presentSlots: ReadonlySet<BrandFactSlot>,
  sourceType: GeoBriefSource,
  category: string,
): string[] {
  const hints: string[] = [];
  const slotHintMap: Record<BrandFactSlot, string> = {
    PRODUCT_SPECS: `建议补充「核心产品与参数」实测数值（如${category}关键性能指标、功耗/噪音/响应时延与版本规格），可显著提升 AI 引用率`,
    DIFFERENTIATORS: '建议补充「差异化卖点」与竞品的客观对比边界及适用人群，避免回答沦为泛泛描述',
    CREDENTIALS:
      '建议补充「权威资质与背书」（认证编号、专利、权威媒体评测或行业奖项），增强可信度锚点',
    CASE_STUDIES: '建议补充「真实客户案例」与可量化落地效果数据，支撑场景化推荐结论',
    EXTRA_DOC: '可按需补充白皮书或长文档资料用于深度问答',
  };

  for (const slot of BRAND_FACT_CORE_SLOTS) {
    if (!presentSlots.has(slot)) {
      hints.push(slotHintMap[slot]);
    }
  }

  if (sourceType === 'SENTIMENT_RISK') {
    hints.push('建议补充针对高频争议点的实测复核数据、固件/版本改进记录及售后保障条款');
  } else if (sourceType === 'LOW_RANK') {
    hints.push('建议补充与头部竞品同工况下的横向实测参数表（价格带、核心规格、长期成本）');
  } else if (sourceType === 'CITATION_COUNTER') {
    hints.push('建议补充超越目标高引用页的新增维度实测结论与最新 2026 版本信息');
  }

  if (hints.length === 0) {
    hints.push(`建议补充 2026 最新批次${category}第三方实测数据与对比样张，进一步拉开事实密度优势`);
  }

  return dedupeTrimmed(hints, 3);
}

function buildChineseDiagnosisSummary(
  ctx: BriefSynthesisContext,
  citationCounts: Record<CitationSourceKind, number>,
): string {
  const displayPrompt =
    cleanPromptForDisplay(ctx.targetPrompt).slice(0, 72) ||
    `${ctx.localBrandName || ctx.brandName}${ctx.category}`;
  const engines = dedupeTrimmed(
    ctx.observations.map((o) => o.engine),
    5,
  );
  const engineLabel =
    engines.length > 0
      ? engines.join('、')
      : ctx.market === 'GLOBAL'
        ? '海外主流 AI 引擎'
        : '国内主流 AI 引擎';
  const compLabel =
    ctx.competitorFocus.length > 0 ? ctx.competitorFocus.slice(0, 3).join('、') : '头部竞品';
  const totalCitations = ctx.citations.length;
  const citationNote =
    totalCitations === 0
      ? '本次引擎未返回外部引用链接，已基于回答正文、竞品露出差距与品牌事实卡生成可执行写作方案。'
      : citationCounts.OWNED === 0
        ? `当前共监测到 ${totalCitations} 条引用且自有官网引用为 0，AI 主要采信竞品页与第三方评测/社区信源。`
        : `当前共监测到 ${totalCitations} 条引用（含自有阵地 ${citationCounts.OWNED} 条），需进一步提升高权重评测与问答覆盖。`;

  switch (ctx.sourceType) {
    case 'AUTO_GAP':
      return `在「${displayPrompt}」问题下，${engineLabel}未提及 ${ctx.localBrandName}，而 ${compLabel} 占据了主要推荐席位。${citationNote}`;
    case 'SENTIMENT_RISK':
      return `在「${displayPrompt}」问答中，${engineLabel}对 ${ctx.localBrandName} 出现负面或褒贬参半评价，需立即用可核验实测事实澄清痛点。${citationNote}`;
    case 'LOW_RANK': {
      const positions = ctx.observations
        .map((o) => o.brandPosition)
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
      const avgPos =
        positions.length > 0
          ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1)
          : '3+';
      return `在「${displayPrompt}」问题中，${ctx.localBrandName} 虽获提及但平均顺位仅排 #${avgPos}，落后于 ${compLabel} 的参数与场景背书。${citationNote}`;
    }
    case 'CITATION_COUNTER': {
      const citeHint = ctx.sourceCitationUrl
        ? `高引用来源（${safeHostFromUrl(ctx.sourceCitationUrl)}）`
        : '第三方高引用评测页';
      return `${citeHint}在「${displayPrompt}」场景下被 AI 反复引用，我方自有阵地缺少可替代的结构化深度对照内容。${citationNote}`;
    }
    case 'FANOUT_CLUSTER': {
      const fanLabel = ctx.targetFanOuts.slice(0, 3).join('、') || displayPrompt;
      return `监测发现 AI 在回答时高频拆解「${fanLabel}」等长尾子词，当前缺少聚合覆盖这些细分意图的专题权威稿。${citationNote}`;
    }
    case 'MANUAL':
    default:
      return `围绕「${displayPrompt}」定向策划 ${ctx.localBrandName}（${ctx.category}）GEO 权威内容，强化首段直答与品牌事实密度。${citationNote}`;
  }
}

function safeHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 48);
  }
}

function extractEnglishTopic(ctx: BriefSynthesisContext): string {
  const cleaned = cleanPromptForDisplay(ctx.targetPrompt);
  const asciiMatches = cleaned.match(/[A-Za-z0-9][A-Za-z0-9\s\-+/.&]{3,}/g);
  if (asciiMatches && asciiMatches.length > 0) {
    const joined = asciiMatches.join(' ').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{4,}/.test(joined)) {
      return joined.slice(0, 64);
    }
  }
  const brandAscii = /[A-Za-z]{2,}/.test(ctx.localBrandName)
    ? ctx.localBrandName
    : /[A-Za-z]{2,}/.test(ctx.brandName)
      ? ctx.brandName
      : 'Brand';
  const catAscii = /[A-Za-z]{3,}/.test(ctx.category) ? ctx.category : 'Solutions';
  return `${brandAscii} ${catAscii}`.trim().slice(0, 64);
}

function stripEnglishTitleLeadingTokens(
  topic: string,
  options: { stripYear?: boolean; stripSuperlative?: boolean },
): string {
  let normalized = topic.trim();
  let prev: string;
  do {
    prev = normalized;
    if (options.stripYear) {
      normalized = normalized.replace(/^2026\b[\s:-]*/i, '').trim();
    }
    if (options.stripSuperlative) {
      normalized = normalized.replace(/^(?:best|top)\b[\s:-]*/i, '').trim();
    }
  } while (normalized !== prev);
  if (options.stripYear) {
    normalized = normalized.replace(/(?:\s+in)?\s+2026$/i, '').trim();
  }
  return normalized;
}

function buildEnglishTitle(ctx: BriefSynthesisContext, recipe: GeoRecipe): string {
  const topic = extractEnglishTopic(ctx);
  const brand = /[A-Za-z]{2,}/.test(ctx.localBrandName) ? ctx.localBrandName : ctx.brandName;
  const fallbackTopic = `${brand} ${/[A-Za-z]{3,}/.test(ctx.category) ? ctx.category : 'Solutions'}`;
  const topicNoYear = stripEnglishTitleLeadingTokens(topic, { stripYear: true }) || fallbackTopic;
  const topicNoYearOrSuperlative =
    stripEnglishTitleLeadingTokens(topic, { stripYear: true, stripSuperlative: true }) ||
    fallbackTopic;
  const comp = ctx.competitorFocus.find((c) => /[A-Za-z]{2,}/.test(c)) ?? ctx.competitorFocus[0];

  let raw: string;
  switch (recipe) {
    case 'COMPARISON_MATRIX':
      raw = comp
        ? `${brand} vs ${comp}: 2026 Best ${topicNoYearOrSuperlative} Comparison & Benchmarks`
        : `2026 Top ${topicNoYearOrSuperlative} Comparison Matrix: ${brand} vs Leading Alternatives`;
      break;
    case 'OBJECTION_FAQ':
      raw = `${brand} Honest Review & FAQ: Real-World Benchmarks for ${topic}`;
      break;
    case 'CITATION_COUNTER':
      raw = `2026 In-Depth ${topicNoYear} Analysis: Verified ${brand} Benchmarks & Buying Guide`;
      break;
    case 'AUTHORITY_GUIDE':
    default:
      raw = `2026 Best ${topicNoYearOrSuperlative} Buying Guide: Why ${brand} Stands Out`;
      break;
  }

  return raw.replace(/\s+/g, ' ').trim().slice(0, 118);
}

function buildChineseTitle(ctx: BriefSynthesisContext, recipe: GeoRecipe): string {
  const brand = ctx.localBrandName || ctx.brandName;
  const cleanedTopic = cleanPromptForDisplay(ctx.targetPrompt)
    .replace(/[？?]+$/, '')
    .replace(/^2026(?:年)?\s*/, '')
    .trim();
  const topic = (cleanedTopic || `${brand}${ctx.category}`).slice(0, 42);
  const comp = ctx.competitorFocus[0];

  let raw: string;
  switch (recipe) {
    case 'COMPARISON_MATRIX':
      raw = comp
        ? `2026 ${topic}实测横评：${brand}与${comp}核心参数对比与选型结论`
        : `2026 ${topic}横向对比评测：${brand}核心规格与分场景选购指南`;
      break;
    case 'OBJECTION_FAQ':
      raw = `${brand}${ctx.category}真实表现与高频疑问实测答疑（2026 客观复核版）`;
      break;
    case 'CITATION_COUNTER':
      raw = `2026 ${topic}深度实测报告：${brand}关键参数对比与避坑清单`;
      break;
    case 'AUTHORITY_GUIDE':
    default:
      raw = `2026 ${topic}权威选购指南：${brand}核心实测与分人群推荐`;
      break;
  }

  return raw.replace(/\s+/g, ' ').trim().slice(0, 118);
}

function buildEnglishOutline(
  ctx: BriefSynthesisContext,
  recipe: GeoRecipe,
  fanOuts: readonly string[],
): GeoOutlineHeading[] {
  const brand = /[A-Za-z]{2,}/.test(ctx.localBrandName) ? ctx.localBrandName : ctx.brandName;
  const topic = extractEnglishTopic(ctx);
  const comp = ctx.competitorFocus[0] ?? 'Key Competitors';
  const ref0 = fanOuts[0];
  const ref1 = fanOuts[1];
  const ref2 = fanOuts[2];

  const base: GeoOutlineHeading[] =
    recipe === 'OBJECTION_FAQ'
      ? [
          {
            heading: `Quick Verdict: Addressing Common Concerns About ${brand}`,
            intent:
              'Lead with a direct, verifiable 60-word summary answering top buyer objections.',
            ...(ref0 ? { fanOutRef: ref0 } : {}),
          },
          {
            heading: `Verified Specs & Lab Benchmarks for ${topic}`,
            intent:
              'Present measurable hardware/service metrics sourced directly from BrandFact cards.',
            ...(ref1 ? { fanOutRef: ref1 } : {}),
          },
          {
            heading: `Objective Comparison: ${brand} vs ${comp} Trade-Offs`,
            intent: 'Provide a balanced pros/cons table covering price, reliability, and support.',
            ...(ref2 ? { fanOutRef: ref2 } : {}),
          },
          {
            heading: `Frequently Asked Questions & Real Customer Outcomes`,
            intent:
              'Answer 5 high-intent follow-up questions in concise, quotable 80-150 word blocks.',
          },
        ]
      : recipe === 'COMPARISON_MATRIX'
        ? [
            {
              heading: `Executive Summary: Top Picks for ${topic}`,
              intent: 'State clear buyer recommendations by use case in the opening paragraph.',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `Side-by-Side Comparison Matrix: ${brand} vs ${comp}`,
              intent:
                'Build a structured Markdown comparison table across specs, pricing, and warranty.',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `Hands-On Performance & Real-World Efficiency Analysis`,
              intent:
                'Detail verified measurements, differentiators, and scenario fit from brand facts.',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `Buyer Decision Guide & Frequently Asked Questions`,
              intent:
                'Clarify who should choose each option and address remaining fan-out sub-queries.',
            },
          ]
        : [
            {
              heading: `Direct Answer: How to Choose the Best ${
                stripEnglishTitleLeadingTokens(topic, {
                  stripYear: true,
                  stripSuperlative: true,
                }) || topic
              } in 2026`,
              intent: 'Deliver a quotable first-paragraph conclusion and buyer shortlist.',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `Core Specs & Differentiators: What Sets ${brand} Apart`,
              intent: 'Inject verified specifications, certifications, and measurable benchmarks.',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `Head-to-Head Evaluation Against ${comp}`,
              intent: 'Compare key criteria in a structured table to earn AI comparison citations.',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `Use-Case Recommendations & Buyer FAQ`,
              intent:
                'Map buyer scenarios, real customer proof points, and Schema-ready FAQ answers.',
            },
          ];

  return base.map((item) => ({
    heading: item.heading.slice(0, 158),
    intent: item.intent.slice(0, 295),
    ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
  }));
}

function buildChineseOutline(
  ctx: BriefSynthesisContext,
  recipe: GeoRecipe,
  fanOuts: readonly string[],
): GeoOutlineHeading[] {
  const brand = ctx.localBrandName || ctx.brandName;
  const comp = ctx.competitorFocus.slice(0, 2).join('、') || '主流竞品';
  const ref0 = fanOuts[0];
  const ref1 = fanOuts[1];
  const ref2 = fanOuts[2];

  const base: GeoOutlineHeading[] =
    recipe === 'OBJECTION_FAQ'
      ? [
          {
            heading: `核心结论直答：关于${brand}高频顾虑的实测核验`,
            intent: '首段 60 字内直接回应用户最担心的痛点，给出清晰可引用的客观结论。',
            ...(ref0 ? { fanOutRef: ref0 } : {}),
          },
          {
            heading: `关键指标拆解：${brand}核心实测参数与权威背书`,
            intent: '引用品牌事实卡中的量化规格、认证资质与最新批次表现澄清误解。',
            ...(ref1 ? { fanOutRef: ref1 } : {}),
          },
          {
            heading: `横向客观对照：${brand}与${comp}适用边界分析`,
            intent: '用对比表格客观列出优缺点及适用人群，去广告味增强 AI 采信度。',
            ...(ref2 ? { fanOutRef: ref2 } : {}),
          },
          {
            heading: `高频痛点答疑与真实客户落地反馈（FAQ）`,
            intent: '以 80–150 字独立可切片问答块回应长尾拆解词，便于引擎直接摘录。',
          },
        ]
      : recipe === 'COMPARISON_MATRIX'
        ? [
            {
              heading: `首段直答与分人群选购结论（2026 实测）`,
              intent: '开篇给出明确选型建议表，帮助 AI 快速抽取推荐顺位。',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `核心参数横向对比表：${brand} vs ${comp}`,
              intent: '使用标准 Markdown 对比表逐项对比规格、价格带、实测表现与质保。',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `差异化卖点与真实场景体验深测`,
              intent: '结合品牌事实卡输出可核验的量化差异点与典型客户使用效果。',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `选型避坑清单与常见疑问解答`,
              intent: '覆盖其余搜索拆解词并补充买前决策 FAQ，提升完整度与引用就绪度。',
            },
          ]
        : [
            {
              heading: `首段核心结论：2026 ${ctx.category}选购决策要点`,
              intent: '前 100 字直答目标用户问题，提炼核心指标与分预算建议。',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `${brand}核心产品规格、资质背书与实测亮点`,
              intent: '注入品牌事实卡真实数据，构建高密度事实锚点。',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `与${comp}关键维度横向对比表`,
              intent: '以结构化对比表呈现各自优势与适用场景，反超竞品露出。',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `高频追问 FAQ 与不同人群落地建议`,
              intent: '集中回应 AI 搜索拆解子词，输出可切片问答段落。',
            },
          ];

  return base.map((item) => ({
    heading: item.heading.slice(0, 158),
    intent: item.intent.slice(0, 295),
    ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
  }));
}

export function buildDeterministicBriefDraft(ctx: BriefSynthesisContext): BriefDraft {
  const citationCounts = summarizeCitationKinds(ctx.citations);
  const socialHeavy =
    citationCounts.SOCIAL > 0 && citationCounts.SOCIAL >= citationCounts.AUTHORITY;
  const recommendedRecipe = defaultRecipeForBriefSource(ctx.sourceType);
  const targetFormat = recommendBriefTargetFormat(ctx.market, ctx.sourceType, { socialHeavy });
  const targetFanOuts = normalizeFanOutQueries(ctx.targetFanOuts).slice(0, 12);
  const competitorFocus = dedupeTrimmed(ctx.competitorFocus, 10);
  const matchedFactIds = dedupeTrimmed(
    ctx.matchedFacts.map((f) => f.factId),
    20,
  );
  const missingFactHints = buildMissingFactHints(
    ctx.presentFactSlots,
    ctx.sourceType,
    ctx.category,
  );
  const diagnosisSummary = buildChineseDiagnosisSummary(ctx, citationCounts);
  const suggestedTitle =
    ctx.market === 'GLOBAL'
      ? buildEnglishTitle(ctx, recommendedRecipe)
      : buildChineseTitle(ctx, recommendedRecipe);
  const outlineH2 =
    ctx.market === 'GLOBAL'
      ? buildEnglishOutline(ctx, recommendedRecipe, targetFanOuts)
      : buildChineseOutline(ctx, recommendedRecipe, targetFanOuts);
  const recommendedChannels = recommendChannelsForMarket(ctx.market, {
    sourceType: ctx.sourceType,
    socialCitations: citationCounts.SOCIAL,
    authorityCitations: citationCounts.AUTHORITY,
    competitorCitations: citationCounts.COMPETITOR,
    ecommerceCitations: citationCounts.ECOMMERCE,
    citationsEmpty: ctx.citations.length === 0,
  });

  return {
    diagnosisSummary,
    recommendedRecipe,
    targetFormat,
    suggestedTitle,
    outlineH2,
    targetFanOuts,
    competitorFocus,
    matchedFactIds,
    missingFactHints,
    recommendedChannels,
  };
}

export const llmBriefOutputSchema = z.object({
  diagnosisSummary: z.string().trim().min(6).max(600),
  recommendedRecipe: z.enum(GEO_RECIPES).optional(),
  targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
  suggestedTitle: z.string().trim().min(4).max(120),
  outlineH2: z.array(geoOutlineHeadingSchema).min(3).max(15),
  missingFactHints: z.array(z.string().trim().min(2).max(200)).max(10).optional(),
  recommendedChannels: z
    .array(
      z.object({
        channel: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(4).max(300),
      }),
    )
    .min(1)
    .max(5)
    .optional(),
});

export type LlmBriefOutput = z.infer<typeof llmBriefOutputSchema>;

export function extractJsonCandidate(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('llm_json_missing_braces');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function hasForbiddenCnChannel(text: string): boolean {
  return CN_CHANNEL_FORBIDDEN_IN_GLOBAL.some((token) => text.includes(token));
}

/**
 * 将真实 LLM 返回的结构化 JSON 校验并标准化为严格符合双市场约束的 BriefDraft。
 * 若关键市场语种约束未满足（例如 GLOBAL 标题或大纲非英文、或诊断非中文），返回 null 供上层重试或报 502。
 */
export function finalizeRealLlmBriefDraft(
  parsed: LlmBriefOutput,
  ctx: BriefSynthesisContext,
): BriefDraft | null {
  const diagnosisSummary = cleanPromptForDisplay(parsed.diagnosisSummary);
  if (!/[\u4e00-\u9fa5]/.test(diagnosisSummary)) {
    return null;
  }

  const suggestedTitle = cleanPromptForDisplay(parsed.suggestedTitle).slice(0, 120);
  if (ctx.market === 'GLOBAL') {
    if (!/[A-Za-z]{4,}/.test(suggestedTitle)) return null;
    if (parsed.outlineH2.some((item) => !/[A-Za-z]{3,}/.test(item.heading))) return null;
  } else {
    if (!/[\u4e00-\u9fa5]/.test(suggestedTitle)) return null;
    if (!/[\u4e00-\u9fa5]/.test(parsed.outlineH2[0]?.heading ?? '')) return null;
  }

  const citationCounts = summarizeCitationKinds(ctx.citations);
  const recommendedRecipe = parsed.recommendedRecipe ?? defaultRecipeForBriefSource(ctx.sourceType);
  const allowedFormats = targetFormatsForMarket(ctx.market);
  const targetFormat =
    parsed.targetFormat && allowedFormats.includes(parsed.targetFormat)
      ? parsed.targetFormat
      : recommendBriefTargetFormat(ctx.market, ctx.sourceType, {
          socialHeavy: citationCounts.SOCIAL > 0,
        });

  let channels = parsed.recommendedChannels ?? [];
  if (ctx.market === 'GLOBAL') {
    channels = channels.filter(
      (c) => !hasForbiddenCnChannel(c.channel) && !hasForbiddenCnChannel(c.reason),
    );
  } else {
    channels = channels.filter((c) => c.channel.length > 0);
    if (channels.length === 0) {
      channels = recommendChannelsForMarket('CN', {
        sourceType: ctx.sourceType,
        citationsEmpty: ctx.citations.length === 0,
      });
    }
  }
  if (channels.length === 0) {
    channels = recommendChannelsForMarket(ctx.market, {
      sourceType: ctx.sourceType,
      socialCitations: citationCounts.SOCIAL,
      authorityCitations: citationCounts.AUTHORITY,
      competitorCitations: citationCounts.COMPETITOR,
      ecommerceCitations: citationCounts.ECOMMERCE,
      citationsEmpty: ctx.citations.length === 0,
    });
  }

  const targetFanOuts = normalizeFanOutQueries(ctx.targetFanOuts).slice(0, 12);
  const competitorFocus = dedupeTrimmed(ctx.competitorFocus, 10);
  const matchedFactIds = dedupeTrimmed(
    ctx.matchedFacts.map((f) => f.factId),
    20,
  );
  const missingFactHints =
    parsed.missingFactHints && parsed.missingFactHints.length > 0
      ? dedupeTrimmed(parsed.missingFactHints, 5)
      : buildMissingFactHints(ctx.presentFactSlots, ctx.sourceType, ctx.category);

  return {
    diagnosisSummary,
    recommendedRecipe,
    targetFormat,
    suggestedTitle,
    outlineH2: parsed.outlineH2.slice(0, 15),
    targetFanOuts,
    competitorFocus,
    matchedFactIds,
    missingFactHints,
    recommendedChannels: channels.slice(0, 5),
  };
}

export { CN_RECOMMENDED_CHANNELS };
