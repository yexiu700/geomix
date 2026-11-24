import { z } from 'zod';
import {
  buildGeoSchemaJsonLd,
  buildLlmsTxtSnippet,
  cleanTitleText,
  containsCjk,
  defaultTemplateKeyForProvider,
  extractMissingFactSlots,
  isSafeDistributionHttpUrl,
  markdownToSanitizedHtml,
  normalizeMissingFactPlaceholdersForMarket,
  serializeJsonLdSafe,
  stripInlineJsonLdBlocks,
  type BrandFactSlot,
  type ChannelProvider,
  type DistributionTemplateKey,
  type GeoComplianceFlag,
  type GeoMarket,
} from '@geomix/shared';
import type { LlmMessage } from '../infra/llm';

export type VariantFactSheetItem = {
  title: string;
  summary: string;
};

export type VariantPrFactSheet = {
  brandName: string;
  category: string;
  targetPrompt: string;
  keyAngles: string[];
  verifiedFacts: VariantFactSheetItem[];
  targetFanOuts: string[];
  competitorComparisonAngles: string[];
  verifiedSpecTableMarkdown?: string;
};

export type DistributionVariantExtras = {
  templateKey: DistributionTemplateKey;
  jsonLdSnippet?: string;
  schemaJsonLd?: Record<string, unknown>;
  llmsTxtSnippet?: string | null;
  antiBanChecklist?: string[];
  targetThreadUrls?: string[];
  threadPosts?: string[];
  canonicalGuideHint?: string | null;
  factSheet?: VariantPrFactSheet;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  complianceFlags?: GeoComplianceFlag[];
};

export type VariantBrandFactInput = {
  id: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
};

export type VariantPromptContext = {
  market: GeoMarket;
  locale: string;
  brandName: string;
  localBrandName: string;
  brandAliases: string[];
  category: string;
  localCategory?: string | null;
  ownedDomains: string[];
  competitors: string[];
  articleTitle: string;
  targetPrompt: string;
  masterMarkdown: string;
  articleSchemaJsonLd?: Record<string, unknown> | null;
  articleLlmsTxtSnippet?: string | null;
  facts: readonly VariantBrandFactInput[];
  targetFanOuts: string[];
  competitorFocus: string[];
  citedExampleUrls: string[];
  provider: ChannelProvider;
  templateKey: DistributionTemplateKey;
  channelLabel: string;
  targetUrlHint?: string | null;
  customToneNote?: string | null;
  customForbiddenWords?: readonly string[];
};

export type GeneratedVariantDraft = {
  templateKey: DistributionTemplateKey;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: DistributionVariantExtras;
  schemaReusedFromArticle?: boolean;
  llmsReusedFromArticle?: boolean;
};

export class VariantGlobalCjkLeakError extends Error {
  readonly samples: string[];

  constructor(samples: string[]) {
    super(`GLOBAL 市场渠道变体包含非品牌中文字符: ${samples.join(', ')}`);
    this.name = 'VariantGlobalCjkLeakError';
    this.samples = samples;
  }
}

export function resolveVariantTemplateKey(target: {
  provider: ChannelProvider;
  templateKey?: DistributionTemplateKey;
}): DistributionTemplateKey {
  return target.templateKey ?? defaultTemplateKeyForProvider(target.provider);
}

const CJK_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g;

const META_DESC_MIN_LEN = 140;
const META_DESC_MAX_LEN = 160;
const SLUG_MAX_LEN = 160;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectBrandNames(ctx: VariantPromptContext): string[] {
  return [...new Set([ctx.brandName, ctx.localBrandName, ...ctx.brandAliases])]
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function findNonBrandCjkLeaks(text: string, brandNames: readonly string[]): string[] {
  const cjkNames = [
    ...new Set(
      brandNames.map((name) => name.trim()).filter((name) => name.length > 0 && containsCjk(name)),
    ),
  ].sort((a, b) => b.length - a.length);

  let stripped = text;
  for (const name of cjkNames) {
    stripped = stripped.replace(new RegExp(escapeRegExp(name), 'g'), ' ');
  }
  if (!containsCjk(stripped)) return [];
  return [...new Set(stripped.match(CJK_RUN_RE) ?? [])].slice(0, 8);
}

function resolveDisplayBrand(ctx: VariantPromptContext): string {
  if (ctx.market === 'GLOBAL') {
    const local = ctx.localBrandName.trim();
    if (local && !containsCjk(local)) return local;
    const asciiAlias = ctx.brandAliases.find((a) => a.trim().length > 0 && !containsCjk(a));
    if (asciiAlias) return asciiAlias.trim();
    const base = ctx.brandName.trim();
    if (base && !containsCjk(base)) return base;
    return local || base || 'Brand';
  }
  return ctx.localBrandName.trim() || ctx.brandName.trim() || '品牌';
}

function resolveDisplayCategory(ctx: VariantPromptContext): string {
  if (ctx.market === 'GLOBAL') {
    const local = ctx.localCategory?.trim();
    if (local && !containsCjk(local)) return local;
    const base = ctx.category.trim();
    if (base && !containsCjk(base)) return base;
    return 'Product Category';
  }
  return ctx.localCategory?.trim() || ctx.category.trim() || '核心品类';
}

function toAsciiSafeText(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u3400-\u9fff\uf900-\ufaff]+/g, ' ')
    .replace(/[\u3000-\u303f\uff00-\uffef]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[A-Za-z0-9]{2,}/.test(cleaned) ? cleaned : fallback;
}

function resolveGlobalPrompt(ctx: VariantPromptContext, brand: string, category: string): string {
  const prompt = ctx.targetPrompt.trim();
  if (prompt && !containsCjk(prompt)) return prompt;
  return toAsciiSafeText(prompt, `Best ${category} comparison and ${brand} review`);
}

function resolveGlobalTitleBase(
  ctx: VariantPromptContext,
  brand: string,
  category: string,
): string {
  const title = ctx.articleTitle.trim();
  if (title && !containsCjk(title)) return title;
  return toAsciiSafeText(title, `${brand} ${category} Buying Guide and Benchmarks`);
}

function stripMarkdownFormatting(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\|.*\|$/gm, ' ')
    .replace(/[*_`~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstPlainParagraph(markdown: string): string {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.length > 0 &&
        !block.startsWith('#') &&
        !block.startsWith('|') &&
        !block.startsWith('```') &&
        !block.startsWith('---'),
    );
  for (const block of blocks) {
    const plain = stripMarkdownFormatting(block);
    if (plain.length >= 24) return plain;
  }
  return stripMarkdownFormatting(markdown);
}

function extractFirstMarkdownTable(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const tableLines: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(trimmed);
      inTable = true;
    } else if (inTable) {
      break;
    }
  }
  return tableLines.length >= 3 ? tableLines.join('\n') : undefined;
}

function extractMasterMissingSlots(ctx: VariantPromptContext): string[] {
  const raw = `${ctx.articleTitle}\n${ctx.masterMarkdown}`;
  const normalized = normalizeMissingFactPlaceholdersForMarket(raw, ctx.market);
  const slots = extractMissingFactSlots(normalized);
  const unique = [...new Set(slots.map((s) => s.raw))];
  if (ctx.market !== 'GLOBAL') {
    return unique.slice(0, 6);
  }
  const brandNames = collectBrandNames(ctx);
  return unique
    .map((slot) => {
      if (findNonBrandCjkLeaks(slot, brandNames).length === 0) return slot;
      const hint = toAsciiSafeText(
        slot.replace(/^\[(?:TBD|To be verified)[:：]\s*/i, '').replace(/\]$/, ''),
        'official specification',
      );
      return `[TBD: ${hint}]`;
    })
    .slice(0, 6);
}

export function normalizeVariantSlug(
  raw: string | null | undefined,
  fallbackTitle: string,
  fallbackBrand: string,
): string {
  const slugify = (input: string): string => {
    const normalized = input
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LEN)
      .replace(/-+$/g, '');
    return normalized;
  };

  const candidates = [raw ?? '', fallbackTitle, `${fallbackBrand}-geo-guide`, 'geo-guide'];
  for (const candidate of candidates) {
    const slug = slugify(candidate);
    if (slug.length >= 3) {
      return slug;
    }
  }
  return 'geo-guide';
}

export function sliceUtf16Safe(str: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (str.length <= maxLen) return str;
  let end = maxLen;
  const lastCode = str.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, end);
}

function trimMetaDescToRange(text: string, isGlobal: boolean): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= META_DESC_MAX_LEN) {
    return collapsed;
  }
  const slice = sliceUtf16Safe(collapsed, META_DESC_MAX_LEN);
  if (isGlobal) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= META_DESC_MIN_LEN) {
      return slice.slice(0, lastSpace).replace(/[,;:\-\s]+$/, '.');
    }
  } else {
    const lastPunct = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('；'),
      slice.lastIndexOf('，'),
    );
    if (lastPunct >= META_DESC_MIN_LEN - 1) {
      return slice.slice(0, lastPunct + 1);
    }
  }
  return `${sliceUtf16Safe(collapsed, META_DESC_MAX_LEN - 1).trimEnd()}.`;
}

export function normalizeVariantMetaDesc(
  raw: string | null | undefined,
  ctx: VariantPromptContext,
  variantMarkdown: string,
): string {
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const brandNames = collectBrandNames(ctx);

  let base = stripMarkdownFormatting(raw ?? '');
  if (!base || (ctx.market === 'GLOBAL' && findNonBrandCjkLeaks(base, brandNames).length > 0)) {
    const firstPara = extractFirstPlainParagraph(variantMarkdown);
    if (
      firstPara &&
      (ctx.market !== 'GLOBAL' || findNonBrandCjkLeaks(firstPara, brandNames).length === 0)
    ) {
      base = firstPara;
    } else if (ctx.market === 'GLOBAL') {
      base = `${brand} ${category} guide with verified specifications, lab benchmarks, and objective comparisons.`;
    } else {
      base = `${brand}${category}深度实测指南，汇总官方核验规格、核心性能数据与客观横向对比结论。`;
    }
  }

  const paddingParts =
    ctx.market === 'GLOBAL'
      ? [
          ` Covers verified ${brand} specifications, hands-on ${category} benchmarks, objective trade-offs, and structured buyer FAQ.`,
          ` Built from grounded product facts for fast evaluation across search engines and AI answer engines.`,
          ` Compare key metrics, scenario fit, and verifiable evidence before choosing the right option.`,
        ]
      : [
          ` 完整汇总${brand}在${category}场景下的实测规格参数、竞品横向对比结论、适用边界与高频购买答疑。`,
          ` 全部核心数据均来自品牌已核验事实卡，去广告化客观呈现，便于用户与 AI 搜索引擎直接核验引用。`,
          ` 涵盖分人群选型建议与关键避坑清单，帮助决策者快速完成对比与评估。`,
        ];

  let candidate = base.replace(/\s+/g, ' ').trim();
  for (const part of paddingParts) {
    if (candidate.length >= META_DESC_MIN_LEN) break;
    const sep = /[.!?。！？]$/.test(candidate) ? '' : ctx.market === 'GLOBAL' ? '.' : '。';
    candidate = `${candidate}${sep}${part}`.replace(/\s+/g, ' ').trim();
  }

  candidate = trimMetaDescToRange(candidate, ctx.market === 'GLOBAL');

  // Final safety clamp to guarantee strictly 140..160 characters without splitting UTF-16 surrogates
  if (candidate.length < META_DESC_MIN_LEN) {
    const padUnit =
      ctx.market === 'GLOBAL'
        ? ` Verified ${brand} ${category} guide with objective benchmarks and buyer FAQ.`
        : ` 附${brand}${category}实测参数对照表与客观选购答疑。`;
    while (candidate.length < META_DESC_MIN_LEN) {
      candidate = `${candidate}${padUnit}`.replace(/\s+/g, ' ').trim();
    }
    candidate = trimMetaDescToRange(candidate, ctx.market === 'GLOBAL');
  }

  if (candidate.length > META_DESC_MAX_LEN) {
    candidate = sliceUtf16Safe(candidate, META_DESC_MAX_LEN);
  }
  if (candidate.length < META_DESC_MIN_LEN) {
    const filler =
      ctx.market === 'GLOBAL' ? ' Verified facts and buyer guide.' : ' 附实测核验参考。';
    while (candidate.length < META_DESC_MIN_LEN) {
      candidate = `${candidate}${filler}`;
    }
    candidate = sliceUtf16Safe(candidate, META_DESC_MAX_LEN);
  }

  return candidate;
}

const REDDIT_CTA_LINE_PATTERNS: readonly RegExp[] = [
  /\b(?:buy\s+now|shop\s+now|order\s+now|order\s+today|sign\s+up\s+today|claim\s+your\s+discount|click\s+here\s+to\s+(?:buy|order|shop)|limited[- ]time\s+offer|promo\s*code|discount\s*code|coupon\s*code|use\s+code\s+[A-Z0-9_-]{3,}|get\s+\d+%\s+off|visit\s+our\s+(?:official\s+)?store)\b/i,
  /\[(?:buy|shop|order|claim|official\s+store|get\s+\d+%)[^[\]]*\]\(https?:\/\/[^\s)]+\)/i,
  /(?:立即购买|点击下单|限时优惠|领券立减|优惠码|官方商城直达|马上下单|立即抢购)/,
];

const REDDIT_INLINE_CTA_PATTERNS: readonly RegExp[] = [
  /\[(?:buy|shop|order|claim|official\s+store|get\s+\d+%)[^[\]]*\]\(https?:\/\/[^\s)]+\)/gi,
  /\b(?:use\s+(?:(?:promo|discount|coupon)\s*)?code\s+[A-Z0-9_-]{2,}|(?:promo|discount|coupon)\s*code\b|limited[- ]time\s+offer\b|order\s+(?:now|today)\b|buy\s+now\b|shop\s+now\b|sign\s+up\s+today\b|claim\s+your\s+discount\b|click\s+here\s+to\s+(?:buy|order|shop)\b|get\s+\d+%\s+off\b|visit\s+our\s+(?:official\s+)?store\b)(?:https?:\/\/\S+(?<![.!?])|[^.!?\n])*[.!?]?/gi,
  /(?:立即购买|点击下单|限时优惠|领券立减|优惠码|官方商城直达|马上下单|立即抢购)[^。！？!\n]*[。！？!]?/g,
];

export function stripRedditPromotionalCtas(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const cleanedLines: string[] = [];
  for (const line of lines) {
    if (REDDIT_CTA_LINE_PATTERNS.some((re) => re.test(line))) {
      // If the line is purely or primarily a promotional CTA, drop it;
      // otherwise strip the promotional phrase while keeping factual context.
      let stripped = line;
      for (const inlineRe of REDDIT_INLINE_CTA_PATTERNS) {
        stripped = stripped.replace(inlineRe, '');
      }
      stripped = stripped
        .replace(/\s{2,}/g, ' ')
        .replace(/[\s—–\-,;:，；：]+$/, '')
        .trim();
      if (stripped.length < 20 || REDDIT_CTA_LINE_PATTERNS.some((re) => re.test(stripped))) {
        continue;
      }
      cleanedLines.push(stripped);
    } else {
      cleanedLines.push(line);
    }
  }
  return cleanedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ANTI_BAN_UNSAFE_AUTOMATION_RE =
  /(?:\b(?:auto[- ]?post(?:ing|ed|s)?|auto[- ]?submit(?:ting|ted|s)?|automated\s+(?:posting|submission|submissions|commenting|replies)|praw|scrape\s+(?:the\s+)?subreddit|headless\s+browser)\b|(?<![a-z0-9-])bot(?:s|\s+script)?\b|(?:自动发帖|自动发布脚本|爬虫脚本|机器人批量发帖|自动化刷帖))/gi;

const ANTI_BAN_PROHIBITION_BEFORE_RE =
  /(?:\b(?:do\s+not|don't|never|avoid|no|prohibit(?:ed)?|forbid(?:den)?|refrain\s+from)\b|(?:禁止|不要|切勿|严禁|不得|避免))/i;

const ANTI_BAN_POSITIVE_IMPERATIVE_RE =
  /(?:\b(?:us(?:e|ing)|run(?:ning)?|deploy(?:ing)?|schedul(?:e|ing)|space\s+out|configur(?:e|ing)|set(?:ting)?\s+up|build(?:ing)?|creat(?:e|ing)|writ(?:e|ing)|post(?:ing)?|automat(?:e|ing)|try(?:ing)?)\b|(?:使用|运行|部署|定时|配置|编写))/i;

const ANTI_BAN_PURPOSE_CLAUSE_RE =
  /(?:(?:\bto\s+)?\b(?:avoid|prevent|don't|do\s+not|never)\s+(?:get(?:ting)?\s+|being\s+)?(?:a\s+|an\s+)?(?:(?:account|subreddit|spam)\s+bans?|(?:shadow)?ban(?:ned|ning|s)?|(?:spam\s+)?detection|flagged(?:\s+for\s+spam)?)\b|(?:避免|不要|防止)(?:被)?(?:封(?:号|禁)|限流|删帖|风控|检测|判定))/gi;

const ANTI_BAN_MEANS_CONNECTOR_RE = /\b(?:by|when|while|via|through|if)\b/i;

function isSafeAntiBanChecklistItem(item: string): boolean {
  for (const match of item.matchAll(ANTI_BAN_UNSAFE_AUTOMATION_RE)) {
    const matchIndex = match.index ?? 0;
    const rawPrefix = item.slice(0, matchIndex);
    const clauseParts = rawPrefix.split(/[.!?;:。；：\n]/);
    const clausePrefix = (clauseParts[clauseParts.length - 1] ?? '').replace(
      ANTI_BAN_PURPOSE_CLAUSE_RE,
      ' ',
    );
    const prohibitionMatch = ANTI_BAN_PROHIBITION_BEFORE_RE.exec(clausePrefix);
    if (!prohibitionMatch) {
      return false;
    }
    const positiveMatch = ANTI_BAN_POSITIVE_IMPERATIVE_RE.exec(clausePrefix);
    if (positiveMatch && positiveMatch.index < prohibitionMatch.index) {
      return false;
    }
    const between = clausePrefix.slice(prohibitionMatch.index + prohibitionMatch[0].length);
    if (ANTI_BAN_MEANS_CONNECTOR_RE.test(between)) {
      return false;
    }
    const segments = between.split(/[,，—–:;；：]/);
    if (segments.length > 1) {
      const lastSegment = segments[segments.length - 1] ?? '';
      const afterPositive = ANTI_BAN_POSITIVE_IMPERATIVE_RE.exec(lastSegment);
      if (afterPositive) {
        const afterProhibition = ANTI_BAN_PROHIBITION_BEFORE_RE.exec(lastSegment);
        if (!afterProhibition || afterPositive.index < afterProhibition.index) {
          return false;
        }
      }
    }
  }
  return true;
}

function sanitizeAntiBanChecklist(
  provided: readonly string[] | undefined,
  templateKey: DistributionTemplateKey,
  market: GeoMarket,
): string[] {
  if (!provided || provided.length === 0) {
    return defaultAntiBanChecklist(templateKey, market);
  }
  const safe = provided.filter((item) => isSafeAntiBanChecklistItem(item));
  return safe.length > 0 ? safe : defaultAntiBanChecklist(templateKey, market);
}

function collectSafeThreadUrls(ctx: VariantPromptContext): string[] {
  const raw = [...(ctx.targetUrlHint ? [ctx.targetUrlHint] : []), ...ctx.citedExampleUrls];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed || !isSafeDistributionHttpUrl(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 5) break;
  }
  return out;
}

function defaultAntiBanChecklist(
  templateKey: DistributionTemplateKey,
  market: GeoMarket,
): string[] {
  if (templateKey === 'CN_COMMUNITY_QA' || market === 'CN') {
    return [
      '如实披露与品牌的合作或实测样本来源，避免伪装普通消费者硬广。',
      '遵守知乎/什么值得买社区规范，正文不放置带返利或硬广跳转外链。',
      '全程采用客观对比与实测数据表述，禁用《广告法》极限词（最/第一/顶级/唯一）。',
      '同时列出产品局限与不适用人群，提升内容可信度与高赞留存率。',
    ];
  }
  return [
    'Disclose any brand affiliation transparently if you are affiliated with the maker.',
    'Review the target subreddit self-promotion, link, and minimum karma rules before posting.',
    'Keep a neutral, first-person hands-on tone with explicit pros, cons, and test conditions.',
    'Remove promotional CTAs, discount codes, and direct store checkout links from the post body.',
  ];
}

function buildCanonicalGuideHint(ctx: VariantPromptContext, slug: string): string {
  const brand = resolveDisplayBrand(ctx);
  const rawDomain = ctx.ownedDomains[0]?.trim() ?? '';
  const cleanDomain = rawDomain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[\s<>()[\]]+/g, '');
  if (cleanDomain) {
    return `https://${cleanDomain}/guides/${slug}`;
  }
  return ctx.market === 'GLOBAL'
    ? `Link to your owned ${brand} canonical comparison guide (with full spec table & JSON-LD).`
    : `文末引导回流至 ${brand} 官网完整实测参数对照长文（含结构化对比表）。`;
}

function buildFactSheetItems(ctx: VariantPromptContext): VariantFactSheetItem[] {
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const slotLabelsEn: Record<BrandFactSlot, string> = {
    PRODUCT_SPECS: 'Verified Product Specifications',
    DIFFERENTIATORS: 'Key Differentiators',
    CREDENTIALS: 'Certifications & Credentials',
    CASE_STUDIES: 'Verified Customer Outcomes',
    EXTRA_DOC: 'Reference Documentation',
  };
  const slotLabelsCn: Record<BrandFactSlot, string> = {
    PRODUCT_SPECS: '核心产品与实测参数',
    DIFFERENTIATORS: '核心差异化优势',
    CREDENTIALS: '权威认证与资质背书',
    CASE_STUDIES: '真实客户落地案例',
    EXTRA_DOC: '补充技术参考资料',
  };

  if (ctx.facts.length === 0) {
    return ctx.market === 'GLOBAL'
      ? [
          {
            title: `${brand} Overview`,
            summary: `Grounded summary for ${brand} in ${category}; see master article for verified details.`,
          },
        ]
      : [
          {
            title: `${brand}核心事实概览`,
            summary: `基于母稿整理的 ${brand}（${category}）已核验信息摘要。`,
          },
        ];
  }

  return ctx.facts.slice(0, 8).map((fact) => {
    if (ctx.market === 'GLOBAL') {
      const title = !containsCjk(fact.title)
        ? fact.title.trim()
        : toAsciiSafeText(fact.title, slotLabelsEn[fact.slot]);
      const summary = !containsCjk(fact.content)
        ? sliceUtf16Safe(fact.content.trim(), 260)
        : sliceUtf16Safe(
            toAsciiSafeText(
              fact.content,
              `Verified ${slotLabelsEn[fact.slot].toLowerCase()} record on file for ${brand} (${category}).`,
            ),
            260,
          );
      return { title, summary };
    }
    return {
      title: fact.title.trim() || slotLabelsCn[fact.slot],
      summary: sliceUtf16Safe(fact.content.trim(), 260),
    };
  });
}

function buildVerifiedSpecTableMarkdown(
  ctx: VariantPromptContext,
  factItems: readonly VariantFactSheetItem[],
): string {
  const existing = extractFirstMarkdownTable(ctx.masterMarkdown);
  if (
    existing &&
    (ctx.market !== 'GLOBAL' || findNonBrandCjkLeaks(existing, collectBrandNames(ctx)).length === 0)
  ) {
    return existing;
  }
  const rows = factItems
    .slice(0, 5)
    .map(
      (item) =>
        `| ${item.title.replace(/\|/g, '/')} | ${item.summary.replace(/\|/g, '/').slice(0, 120)} |`,
    );
  if (ctx.market === 'GLOBAL') {
    return ['| Dimension | Verified Fact |', '| --- | --- |', ...rows].join('\n');
  }
  return ['| 维度 | 已核验事实 |', '| --- | --- |', ...rows].join('\n');
}

export function buildOwnedBlogExtras(
  ctx: VariantPromptContext,
  variantTitle: string,
  variantMarkdown: string,
  options?: { forceRebuildSchema?: boolean; forceRebuildLlmsTxt?: boolean },
): Pick<DistributionVariantExtras, 'schemaJsonLd' | 'jsonLdSnippet' | 'llmsTxtSnippet'> & {
  reusedArticleSchema: boolean;
  reusedArticleLlmsTxt: boolean;
} {
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const brandNames = collectBrandNames(ctx);

  let existingSchema =
    !options?.forceRebuildSchema &&
    ctx.articleSchemaJsonLd &&
    typeof ctx.articleSchemaJsonLd === 'object' &&
    !Array.isArray(ctx.articleSchemaJsonLd) &&
    Object.keys(ctx.articleSchemaJsonLd).length > 0
      ? ctx.articleSchemaJsonLd
      : null;

  if (
    existingSchema &&
    ctx.market === 'GLOBAL' &&
    findNonBrandCjkLeaks(JSON.stringify(existingSchema), brandNames).length > 0
  ) {
    existingSchema = null;
  }

  const reusedArticleSchema = existingSchema !== null;
  const schemaJsonLd =
    existingSchema ??
    buildGeoSchemaJsonLd({
      market: ctx.market,
      locale: ctx.locale,
      localBrandName: brand,
      category,
      localCategory: category,
      title: variantTitle,
      targetPrompt:
        ctx.market === 'GLOBAL' ? resolveGlobalPrompt(ctx, brand, category) : ctx.targetPrompt,
      contentMarkdown: variantMarkdown,
    });

  const jsonLdSnippet = serializeJsonLdSafe(schemaJsonLd);

  let existingLlms = !options?.forceRebuildLlmsTxt
    ? ctx.articleLlmsTxtSnippet?.trim() || null
    : null;
  if (
    existingLlms &&
    ctx.market === 'GLOBAL' &&
    findNonBrandCjkLeaks(existingLlms, brandNames).length > 0
  ) {
    existingLlms = null;
  }

  const reusedArticleLlmsTxt = ctx.market === 'GLOBAL' && existingLlms !== null;
  const llmsTxtSnippet =
    ctx.market === 'GLOBAL'
      ? existingLlms ||
        buildLlmsTxtSnippet({
          market: ctx.market,
          localBrandName: brand,
          category,
          localCategory: category,
          ownedDomains: ctx.ownedDomains,
          title: variantTitle,
          targetPrompt: resolveGlobalPrompt(ctx, brand, category),
          contentMarkdown: variantMarkdown,
        })
      : null;

  return {
    schemaJsonLd,
    jsonLdSnippet,
    llmsTxtSnippet,
    reusedArticleSchema,
    reusedArticleLlmsTxt,
  };
}

function templatePromptInstructions(ctx: VariantPromptContext): string[] {
  const isGlobal = ctx.market === 'GLOBAL';
  switch (ctx.templateKey) {
    case 'OWNED_BLOG_SEO_GEO':
      return isGlobal
        ? [
            '- Template: OWNED_BLOG_SEO_GEO (Owned Blog / Docs for Shopify, WordPress, Webflow, or Webhook).',
            '- Preserve full GEO structure: direct quotable opening answer, verified specification comparison table, clear H2/H3 sections, and structured FAQ.',
            '- Output lowercase ASCII variantSlug matching /^[a-z0-9-]+$/ (<= 160 chars).',
            '- Output variantMetaDesc strictly 140-160 characters long, grounded and concise.',
          ]
        : [
            '- 模板：OWNED_BLOG_SEO_GEO（自有官网博客/文档）。',
            '- 保留完整 GEO 结构：首段直答结论、已核验参数对比表、清晰 H2/H3 结构与 FAQ 问答块。',
            '- 输出纯小写英文 ASCII 的 variantSlug（仅含 a-z、0-9、-，<= 160 字符）。',
            '- 输出严格 140-160 字符的 variantMetaDesc 摘要描述。',
          ];
    case 'DEVELOPER_TECH_POST':
      return isGlobal
        ? [
            '- Template: DEVELOPER_TECH_POST (Developer & technical blog format for Dev.to, Hashnode, or GitHub MDX).',
            '- Structure: concise architecture/benchmark summary, verified technical comparison table, reproducible configuration or spec callouts, and canonical reference back to the owned guide.',
            '- Output lowercase ASCII variantSlug matching /^[a-z0-9-]+$/ (<= 160 chars) and grounded 140-160 char variantMetaDesc.',
          ]
        : [
            '- 模板：DEVELOPER_TECH_POST（技术博客与开发者社区深度实测格式）。',
            '- 结构：开篇核心技术结论、已核验参数基准对照表、关键架构/配置要点与权威原文回链。',
            '- 输出纯小写英文 ASCII 的 variantSlug（<= 160 字符）与 140-160 字符的 variantMetaDesc。',
          ];
    case 'WECHAT_OFFICIAL_ARTICLE':
      return [
        '- 模板：WECHAT_OFFICIAL_ARTICLE（微信公众号草稿箱深度图文）。',
        '- 100% 简体中文输出：开篇一句直答结论，随后展示已核验参数对比表、分人群选购建议与客观局限说明；严禁使用《广告法》极限词（如最、第一、顶级、唯一、国家级）。',
        '- 输出 100-120 字以内的公众号摘要（variantMetaDesc），无需强制 URL Slug。',
      ];
    case 'REDDIT_DISCUSSION':
      return [
        '- Template: REDDIT_DISCUSSION (Community Assist — human-reviewed post only, NEVER generate auto-posting scripts or bot workflows).',
        '- Tone: de-marketed, first-person objective hands-on experience or spec discussion post.',
        '- STRICT ANTI-BAN RULE: strip all brand CTAs, promo slogans, discount codes, and hard-sell store links; include honest trade-offs/limitations.',
        '- Output non-empty antiBanChecklist (4 concise items covering affiliation disclosure, subreddit rules, neutral tone, and no promo/CTA links).',
      ];
    case 'QUORA_ANSWER':
      return [
        '- Template: QUORA_ANSWER (Community Assist — human-reviewed answer only, NEVER generate auto-posting scripts).',
        '- Structure: conclusion-first quotable opening answer (2-3 sentences), followed by structured comparative breakdown grounded in verified specs and objective caveats.',
      ];
    case 'SOCIAL_THREAD':
      return [
        '- Template: SOCIAL_THREAD (LinkedIn / X multi-post summary thread).',
        '- Distill core verified data insights & comparison highlights into 3-5 concise, standalone numbered posts in threadPosts[], ending with a pointer to the owned-site canonical guide (canonicalGuideHint).',
        '- Also provide variantMarkdown combining the full thread cleanly.',
      ];
    case 'PR_MEDIA_PACKET':
      return [
        '- Template: PR_MEDIA_PACKET (External Media / KOL Collaboration Fact Sheet + Neutral Reference Draft).',
        '- Output structured factSheet with keyAngles (3-5 concise editorial angles), verifiedFacts (array of { title, summary } grounded strictly in BrandFact records), targetFanOuts, competitorComparisonAngles, and verifiedSpecTableMarkdown.',
        '- variantMarkdown must be a neutral, journalist-ready reference draft without hard-sell ad copy.',
      ];
    case 'CN_COMMUNITY_QA':
      return [
        '- 模板：CN_COMMUNITY_QA（知乎 / 什么值得买实测问答与选购评测格式）。',
        '- 100% 简体中文输出：开篇直接给结论，接着呈现已核验实测参数对比、不同人群适用边界与客观不足，严禁使用《广告法》极限词（如最、第一、顶级、唯一、国家级）。',
        '- 输出 antiBanChecklist（4 条社区合规与真实体验披露自检项）。',
      ];
  }
}

export function buildVariantPromptMessages(
  ctx: VariantPromptContext,
  strictRetry = false,
): LlmMessage[] {
  const isGlobal = ctx.market === 'GLOBAL';
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  const marketRules = isGlobal
    ? [
        `- Market: GLOBAL (locale: ${ctx.locale || 'en-US'}). FTC objective review style (natural terms like "Best" or "Top" are allowed when grounded).`,
        '- Output 100% native English. ZERO non-brand Chinese/CJK characters are allowed anywhere in variantTitle, variantSlug, variantMetaDesc, variantMarkdown, antiBanChecklist, threadPosts, or factSheet.',
        '- Cross-lingually translate any Chinese source BrandFact items into natural English without inventing numbers.',
      ]
    : [
        '- Market: CN (zh-CN). Strictly follow China Advertising Law: zero absolute superlatives (最/第一/顶级/唯一/国家级/100%有效).',
        '- Output 100% Simplified Chinese (except ASCII variantSlug when applicable).',
      ];

  const groundingRules = [
    '- SINGLE SOURCE OF TRUTH: Use ONLY the master GeoArticle and verified BrandFact records provided below.',
    '- NEVER fabricate specifications, benchmark numbers, prices, certifications, awards, or unverified claims.',
    '- Faithfully preserve any existing [TBD: ...] or [待补充：...] placeholders from the master article rather than inventing missing values.',
    '- Do NOT embed <script type="application/ld+json"> inside variantMarkdown.',
    ...(ctx.customToneNote?.trim()
      ? [`- Brand tone guidance: ${ctx.customToneNote.trim().slice(0, 300)}`]
      : []),
    ...(ctx.customForbiddenWords && ctx.customForbiddenWords.length > 0
      ? [`- Forbidden words to avoid: ${ctx.customForbiddenWords.slice(0, 20).join(', ')}`]
      : []),
  ];

  const jsonShape =
    '{"variantTitle":"string","variantSlug":"optional lowercase-ascii-slug","variantMetaDesc":"optional 140-160 char summary","variantMarkdown":"string","antiBanChecklist":["optional string"],"threadPosts":["optional post 1","post 2","post 3"],"canonicalGuideHint":"optional string","factSheet":{"keyAngles":["string"],"verifiedFacts":[{"title":"string","summary":"string"}],"targetFanOuts":["string"],"competitorComparisonAngles":["string"],"verifiedSpecTableMarkdown":"optional markdown table"}}';

  const systemContent = [
    'You are GeoMix 1-to-N Channel Variant Generator. Transform one verified master GEO article into a native, compliant channel variant.',
    `Return ONLY a valid JSON object (no surrounding prose) matching: ${jsonShape}`,
    ...templatePromptInstructions(ctx),
    ...marketRules,
    ...groundingRules,
    ...(strictRetry
      ? [
          isGlobal
            ? 'RETRY NOTICE: Your previous output failed JSON validation or leaked non-brand CJK characters. Return strictly valid JSON in 100% native English with ZERO CJK characters.'
            : 'RETRY NOTICE: 上一次输出未通过 JSON 校验，请本次仅输出严格合法的 JSON 对象。',
        ]
      : []),
  ].join('\n');

  const factLines = ctx.facts
    .slice(0, 12)
    .map((f, i) => `${i + 1}. [${f.slot}] ${f.title}: ${f.content.slice(0, 320)}`);

  const threadUrls = collectSafeThreadUrls(ctx);

  const userContent = [
    `Channel Target: ${ctx.channelLabel} (provider=${ctx.provider}, template=${ctx.templateKey})`,
    `Brand: ${brand} (category=${category}, market=${ctx.market})`,
    `Target Prompt: ${ctx.targetPrompt}`,
    ctx.competitorFocus.length > 0
      ? `Competitors: ${ctx.competitorFocus.slice(0, 6).join(', ')}`
      : '',
    ctx.targetFanOuts.length > 0
      ? `Target Fan-Out Sub-Queries: ${ctx.targetFanOuts.slice(0, 8).join(' | ')}`
      : '',
    threadUrls.length > 0 ? `Cited Target URLs: ${threadUrls.join(' , ')}` : '',
    `--- Master GeoArticle Title ---\n${ctx.articleTitle}`,
    `--- Master GeoArticle Markdown ---\n${ctx.masterMarkdown.slice(0, 9000)}`,
    factLines.length > 0
      ? `--- Verified BrandFact Records ---\n${factLines.join('\n')}`
      : '--- Verified BrandFact Records: none ---',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

const llmFactSheetSchema = z.object({
  keyAngles: z.array(z.string().trim().min(2).max(240)).max(8).optional(),
  verifiedFacts: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        summary: z.string().trim().min(2).max(400),
      }),
    )
    .max(12)
    .optional(),
  targetFanOuts: z.array(z.string().trim().min(2).max(200)).max(12).optional(),
  competitorComparisonAngles: z.array(z.string().trim().min(2).max(240)).max(8).optional(),
  verifiedSpecTableMarkdown: z.string().trim().max(4000).optional(),
});

const llmVariantOutputSchema = z.object({
  variantTitle: z.string().trim().min(3).max(200),
  variantSlug: z.string().trim().max(200).nullable().optional(),
  variantMetaDesc: z.string().trim().max(500).nullable().optional(),
  variantMarkdown: z.string().trim().min(20).max(100_000),
  antiBanChecklist: z.array(z.string().trim().min(3).max(240)).max(10).optional(),
  threadPosts: z.array(z.string().trim().min(5).max(1200)).max(12).optional(),
  canonicalGuideHint: z.string().trim().max(400).nullable().optional(),
  factSheet: llmFactSheetSchema.optional(),
});

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('variant_llm_json_missing_braces');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function collectStringsForGlobalCjkAudit(
  title: string,
  slug: string | null,
  metaDesc: string | null,
  markdown: string,
  extras: DistributionVariantExtras,
): string {
  const parts: string[] = [title, markdown];
  if (slug) parts.push(slug);
  if (metaDesc) parts.push(metaDesc);
  if (extras.jsonLdSnippet) parts.push(extras.jsonLdSnippet);
  if (extras.llmsTxtSnippet) parts.push(extras.llmsTxtSnippet);
  if (extras.antiBanChecklist) parts.push(...extras.antiBanChecklist);
  if (extras.threadPosts) parts.push(...extras.threadPosts);
  if (extras.canonicalGuideHint) parts.push(extras.canonicalGuideHint);
  if (extras.factSheet) {
    parts.push(
      extras.factSheet.brandName,
      extras.factSheet.category,
      extras.factSheet.targetPrompt,
      ...extras.factSheet.keyAngles,
      ...extras.factSheet.targetFanOuts,
      ...extras.factSheet.competitorComparisonAngles,
      ...extras.factSheet.verifiedFacts.flatMap((item) => [item.title, item.summary]),
    );
    if (extras.factSheet.verifiedSpecTableMarkdown) {
      parts.push(extras.factSheet.verifiedSpecTableMarkdown);
    }
  }
  return parts.join('\n');
}

function ensureThreadPosts(
  provided: readonly string[] | undefined,
  markdown: string,
  ctx: VariantPromptContext,
  canonicalGuideHint: string,
): string[] {
  const cleaned = (provided ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length >= 3) {
    return cleaned.slice(0, 8);
  }
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => stripMarkdownFormatting(p))
    .filter((p) => p.length >= 16);
  const posts: string[] = [...cleaned];
  for (const para of paragraphs) {
    if (posts.length >= 4) break;
    if (!posts.includes(para)) {
      posts.push(sliceUtf16Safe(para, 280));
    }
  }
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  while (posts.length < 3) {
    const idx = posts.length + 1;
    posts.push(
      ctx.market === 'GLOBAL'
        ? `${idx}/ Verified ${brand} ${category} insight: full benchmark table and methodology are available at ${canonicalGuideHint}`
        : `${idx}/ ${brand}${category}已核验实测要点：完整参数表与对比结论见 ${canonicalGuideHint}`,
    );
  }
  return posts.slice(0, 8);
}

function ensureMasterMissingSlotsPreserved(markdown: string, ctx: VariantPromptContext): string {
  const masterSlots = extractMasterMissingSlots(ctx);
  if (masterSlots.length === 0) return markdown;
  const existingSlots = extractMissingFactSlots(markdown);
  if (existingSlots.length > 0) return markdown;
  const noteHeading =
    ctx.market === 'GLOBAL' ? '\n\n### Pending Verification Notes\n' : '\n\n### 待核验事实项\n';
  return `${markdown.trimEnd()}${noteHeading}${masterSlots.map((slot) => `- ${slot}`).join('\n')}`;
}

export function finalizeRealLlmVariantDraft(
  rawText: string,
  ctx: VariantPromptContext,
): GeneratedVariantDraft {
  const parsedJson = extractJsonObject(rawText);
  const parsed = llmVariantOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`variant_llm_schema_invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }

  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const brandNames = collectBrandNames(ctx);
  const data = parsed.data;

  // Pre-check raw LLM fields in GLOBAL mode BEFORE normalization/ASCII fallback so CJK leaks trigger strict retry
  if (ctx.market === 'GLOBAL') {
    const rawGlobalCheckParts: string[] = [data.variantTitle];
    if (ctx.templateKey === 'OWNED_BLOG_SEO_GEO' && data.variantMetaDesc) {
      rawGlobalCheckParts.push(data.variantMetaDesc);
    }
    if (ctx.templateKey === 'PR_MEDIA_PACKET' && data.factSheet?.targetFanOuts?.length) {
      rawGlobalCheckParts.push(...data.factSheet.targetFanOuts);
    }
    if (data.antiBanChecklist?.length) {
      rawGlobalCheckParts.push(...data.antiBanChecklist);
    }
    if (data.threadPosts?.length) {
      rawGlobalCheckParts.push(...data.threadPosts);
    }
    if (data.canonicalGuideHint) {
      rawGlobalCheckParts.push(data.canonicalGuideHint);
    }
    if (rawGlobalCheckParts.length > 0) {
      const preLeaks = findNonBrandCjkLeaks(rawGlobalCheckParts.join('\n'), brandNames);
      if (preLeaks.length > 0) {
        throw new VariantGlobalCjkLeakError(preLeaks);
      }
    }
  }

  const variantTitle = cleanTitleText(
    data.variantTitle,
    ctx.market === 'GLOBAL' ? resolveGlobalTitleBase(ctx, brand, category) : ctx.articleTitle,
    4,
    200,
  );

  let variantMarkdown = stripInlineJsonLdBlocks(data.variantMarkdown);
  variantMarkdown = normalizeMissingFactPlaceholdersForMarket(variantMarkdown, ctx.market);
  variantMarkdown = ensureMasterMissingSlotsPreserved(variantMarkdown, ctx);

  if (ctx.templateKey === 'REDDIT_DISCUSSION') {
    variantMarkdown = stripRedditPromotionalCtas(variantMarkdown);
    if (variantMarkdown.trim().length < 20) {
      throw new Error('variant_llm_reddit_markdown_empty_after_cta_strip');
    }
  }

  const threadUrls = collectSafeThreadUrls(ctx);
  const extras: DistributionVariantExtras = {
    templateKey: ctx.templateKey,
  };

  let variantSlug: string | null = null;
  let variantMetaDesc: string | null = null;
  let schemaReusedFromArticle = false;
  let llmsReusedFromArticle = false;

  if (ctx.templateKey === 'OWNED_BLOG_SEO_GEO') {
    variantSlug = normalizeVariantSlug(data.variantSlug, variantTitle, brand);
    variantMetaDesc = normalizeVariantMetaDesc(data.variantMetaDesc, ctx, variantMarkdown);
    const blogExtras = buildOwnedBlogExtras(ctx, variantTitle, variantMarkdown);
    extras.schemaJsonLd = blogExtras.schemaJsonLd;
    extras.jsonLdSnippet = blogExtras.jsonLdSnippet;
    extras.llmsTxtSnippet = blogExtras.llmsTxtSnippet;
    schemaReusedFromArticle = blogExtras.reusedArticleSchema;
    llmsReusedFromArticle = blogExtras.reusedArticleLlmsTxt;
  } else if (ctx.templateKey === 'REDDIT_DISCUSSION') {
    extras.antiBanChecklist = sanitizeAntiBanChecklist(
      data.antiBanChecklist,
      'REDDIT_DISCUSSION',
      ctx.market,
    );
    if (threadUrls.length > 0) {
      extras.targetThreadUrls = threadUrls;
    }
  } else if (ctx.templateKey === 'QUORA_ANSWER') {
    if (threadUrls.length > 0) {
      extras.targetThreadUrls = threadUrls;
    }
  } else if (ctx.templateKey === 'SOCIAL_THREAD') {
    const slug = normalizeVariantSlug(data.variantSlug, variantTitle, brand);
    const canonicalGuideHint =
      data.canonicalGuideHint?.trim() || buildCanonicalGuideHint(ctx, slug);
    extras.threadPosts = ensureThreadPosts(
      data.threadPosts,
      variantMarkdown,
      ctx,
      canonicalGuideHint,
    );
    extras.canonicalGuideHint = canonicalGuideHint;
  } else if (ctx.templateKey === 'PR_MEDIA_PACKET') {
    const fallbackFacts = buildFactSheetItems(ctx);
    const verifiedFacts =
      data.factSheet?.verifiedFacts && data.factSheet.verifiedFacts.length > 0
        ? data.factSheet.verifiedFacts
        : fallbackFacts;
    const rawFanOuts =
      data.factSheet?.targetFanOuts && data.factSheet.targetFanOuts.length > 0
        ? data.factSheet.targetFanOuts
        : ctx.targetFanOuts;
    const safeFanOuts =
      ctx.market === 'GLOBAL'
        ? rawFanOuts.map((f) => toAsciiSafeText(f, `${brand} ${category} evaluation`)).slice(0, 8)
        : rawFanOuts.slice(0, 8);
    const rawCompetitors =
      data.factSheet?.competitorComparisonAngles &&
      data.factSheet.competitorComparisonAngles.length > 0
        ? data.factSheet.competitorComparisonAngles
        : ctx.competitorFocus.map((comp) =>
            ctx.market === 'GLOBAL'
              ? `${brand} vs ${toAsciiSafeText(comp, 'leading alternatives')}: verified spec and value comparison`
              : `${brand} 与 ${comp} 核心实测参数与适用场景对照`,
          );
    extras.factSheet = {
      brandName: brand,
      category,
      targetPrompt:
        ctx.market === 'GLOBAL' ? resolveGlobalPrompt(ctx, brand, category) : ctx.targetPrompt,
      keyAngles:
        data.factSheet?.keyAngles && data.factSheet.keyAngles.length > 0
          ? data.factSheet.keyAngles
          : [
              ctx.market === 'GLOBAL'
                ? `Verified ${brand} benchmarks for ${category}`
                : `${brand} 在 ${category} 场景的已核验实测表现`,
            ],
      verifiedFacts,
      targetFanOuts: safeFanOuts,
      competitorComparisonAngles: rawCompetitors,
      verifiedSpecTableMarkdown:
        data.factSheet?.verifiedSpecTableMarkdown?.trim() ||
        buildVerifiedSpecTableMarkdown(ctx, verifiedFacts),
    };
  } else if (ctx.templateKey === 'CN_COMMUNITY_QA') {
    extras.antiBanChecklist = sanitizeAntiBanChecklist(
      data.antiBanChecklist,
      'CN_COMMUNITY_QA',
      'CN',
    );
    if (threadUrls.length > 0) {
      extras.targetThreadUrls = threadUrls;
    }
  }

  if (ctx.market === 'GLOBAL') {
    const auditCorpus = collectStringsForGlobalCjkAudit(
      variantTitle,
      variantSlug,
      variantMetaDesc,
      variantMarkdown,
      extras,
    );
    const leaks = findNonBrandCjkLeaks(auditCorpus, brandNames);
    if (leaks.length > 0) {
      throw new VariantGlobalCjkLeakError(leaks);
    }
  }

  const variantHtml = markdownToSanitizedHtml(variantMarkdown);

  return {
    templateKey: ctx.templateKey,
    variantTitle,
    variantSlug,
    variantMetaDesc,
    variantMarkdown,
    variantHtml,
    variantExtrasJson: extras,
    schemaReusedFromArticle,
    llmsReusedFromArticle,
  };
}

export function buildDeterministicFakeVariantDraft(
  ctx: VariantPromptContext,
): GeneratedVariantDraft {
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const factItems = buildFactSheetItems(ctx);
  const specTable = buildVerifiedSpecTableMarkdown(ctx, factItems);
  const threadUrls = collectSafeThreadUrls(ctx);
  const masterMissingSlots = extractMasterMissingSlots(ctx);
  const globalPrompt = resolveGlobalPrompt(ctx, brand, category);
  const globalTitleBase = resolveGlobalTitleBase(ctx, brand, category);
  const competitors =
    ctx.market === 'GLOBAL'
      ? ctx.competitorFocus
          .map((c) => toAsciiSafeText(c, 'leading alternatives'))
          .filter(Boolean)
          .slice(0, 3)
      : ctx.competitorFocus.slice(0, 3);
  const competitorLabel =
    competitors.length > 0
      ? competitors.join(ctx.market === 'GLOBAL' ? ' and ' : '、')
      : ctx.market === 'GLOBAL'
        ? 'leading alternatives'
        : '主流同类产品';
  const fanOuts =
    ctx.market === 'GLOBAL'
      ? ctx.targetFanOuts
          .map((f) => toAsciiSafeText(f, `${category} benchmark comparison`))
          .filter(Boolean)
          .slice(0, 6)
      : ctx.targetFanOuts.slice(0, 6);

  const missingSlotSection =
    masterMissingSlots.length > 0
      ? ctx.market === 'GLOBAL'
        ? `\n\n### Pending Verification Notes\n${masterMissingSlots.map((slot) => `- ${slot}`).join('\n')}`
        : `\n\n### 待核验事实项\n${masterMissingSlots.map((slot) => `- ${slot}`).join('\n')}`
      : '';

  const factBullets = factItems
    .slice(0, 5)
    .map((item) => `- **${item.title}**: ${item.summary}`)
    .join('\n');

  let variantTitle: string;
  let variantSlug: string | null = null;
  let variantMetaDesc: string | null = null;
  let variantMarkdown: string;
  let schemaReusedFromArticle = false;
  let llmsReusedFromArticle = false;
  const extras: DistributionVariantExtras = {
    templateKey: ctx.templateKey,
  };

  switch (ctx.templateKey) {
    case 'OWNED_BLOG_SEO_GEO': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? cleanTitleText(globalTitleBase, `${brand} ${category} Buying Guide`, 6, 160)
          : cleanTitleText(ctx.articleTitle, `${brand}${category}实测选购与参数对比指南`, 6, 160);
      variantMarkdown =
        ctx.market === 'GLOBAL'
          ? [
              `## Direct Answer: ${globalPrompt}`,
              '',
              `${brand} stands out in ${category} when buyers prioritize verified hardware benchmarks, transparent specifications, and predictable long-term reliability compared with ${competitorLabel}.`,
              '',
              '## Verified Specifications & Benchmark Table',
              '',
              specTable,
              '',
              '## Key Verified Takeaways',
              '',
              factBullets,
              '',
              '## Frequently Asked Questions (FAQ)',
              '',
              `### How does ${brand} compare against ${competitorLabel}?`,
              `Based on verified product records above, ${brand} focuses on measurable real-world performance for ${category} buyers while keeping setup straightforward.`,
              '',
              `### Who should choose ${brand} for ${category}?`,
              `Teams and individual buyers looking for documented specs and clear trade-offs rather than marketing claims will get the strongest fit.`,
            ].join('\n') + missingSlotSection
          : [
              `## 首段核心结论：${ctx.targetPrompt}`,
              '',
              `在${category}场景下，${brand}依托已核验的核心规格参数与长期稳定性表现，在与${competitorLabel}的横向对照中具备清晰的场景适配优势。`,
              '',
              '## 核心实测参数对比表',
              '',
              specTable,
              '',
              '## 已核验核心亮点',
              '',
              factBullets,
              '',
              '## 常见问题解答（FAQ）',
              '',
              `### ${brand} 与 ${competitorLabel} 该如何按场景选型？`,
              `建议优先核对上述实测规格表中的关键指标与预算区间，根据自身使用频率与空间条件做客观权衡。`,
              '',
              `### 选购 ${category} 时需要重点核验哪些参数？`,
              `重点关注可量化实测指标、长期运行稳定性及官方质保条款，避免仅凭宣传口号做决策。`,
            ].join('\n') + missingSlotSection;

      variantSlug = normalizeVariantSlug(null, variantTitle, brand);
      variantMetaDesc = normalizeVariantMetaDesc(null, ctx, variantMarkdown);
      const blogExtras = buildOwnedBlogExtras(ctx, variantTitle, variantMarkdown);
      extras.schemaJsonLd = blogExtras.schemaJsonLd;
      extras.jsonLdSnippet = blogExtras.jsonLdSnippet;
      extras.llmsTxtSnippet = blogExtras.llmsTxtSnippet;
      schemaReusedFromArticle = blogExtras.reusedArticleSchema;
      llmsReusedFromArticle = blogExtras.reusedArticleLlmsTxt;
      break;
    }

    case 'DEVELOPER_TECH_POST': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? cleanTitleText(
              globalTitleBase,
              `${brand} ${category} Technical Benchmark & Spec Guide`,
              6,
              160,
            )
          : cleanTitleText(
              ctx.articleTitle,
              `${brand}${category}技术架构与实测参数基准解析`,
              6,
              160,
            );
      variantMarkdown =
        ctx.market === 'GLOBAL'
          ? [
              `## Technical Summary: ${globalPrompt}`,
              '',
              `This technical guide breaks down verified specifications and practical trade-offs for **${brand}** versus ${competitorLabel} in ${category} workflows.`,
              '',
              '## Verified Specification & Benchmark Matrix',
              '',
              specTable,
              '',
              '## Engineering Notes & Verified Facts',
              '',
              factBullets,
              '',
              '## Trade-Offs & Selection Criteria',
              '',
              `- Validate compatibility, throughput limits, and support terms against ${competitorLabel} before production rollout.`,
              '- Prefer reproducible benchmarks and official specifications over marketing claims.',
            ].join('\n') + missingSlotSection
          : [
              `## 技术结论速览：${ctx.targetPrompt}`,
              '',
              `本文基于已核验参数记录，拆解 **${brand}** 与 ${competitorLabel} 在${category}场景下的关键性能指标与架构权衡。`,
              '',
              '## 已核验实测参数矩阵',
              '',
              specTable,
              '',
              '## 工程与实测要点',
              '',
              factBullets,
              '',
              '## 选型边界与注意事项',
              '',
              `- 正式部署前请结合实际负载核对 ${brand} 与 ${competitorLabel} 的兼容性及长期维护成本。`,
            ].join('\n') + missingSlotSection;

      variantSlug = normalizeVariantSlug(null, variantTitle, brand);
      variantMetaDesc = normalizeVariantMetaDesc(null, ctx, variantMarkdown);
      const devBlogExtras = buildOwnedBlogExtras(ctx, variantTitle, variantMarkdown);
      extras.schemaJsonLd = devBlogExtras.schemaJsonLd;
      extras.jsonLdSnippet = devBlogExtras.jsonLdSnippet;
      extras.llmsTxtSnippet = devBlogExtras.llmsTxtSnippet;
      schemaReusedFromArticle = devBlogExtras.reusedArticleSchema;
      llmsReusedFromArticle = devBlogExtras.reusedArticleLlmsTxt;
      break;
    }

    case 'WECHAT_OFFICIAL_ARTICLE': {
      const cnBrand = ctx.localBrandName.trim() || ctx.brandName.trim() || '品牌';
      const cnCategory = ctx.localCategory?.trim() || ctx.category.trim() || '产品';
      variantTitle = cleanTitleText(
        ctx.articleTitle,
        `${cnBrand}${cnCategory}实测对比：围绕「${ctx.targetPrompt}」的选购参考`,
        6,
        64,
      );
      variantMarkdown =
        [
          `## 首段核心结论`,
          '',
          `针对「${ctx.targetPrompt}」，结合已核验的实测规格与长期稳定表现来看，**${cnBrand}** 在${cnCategory}领域具备清晰的场景适配价值；建议与 ${competitorLabel} 按预算与使用频率客观对比后再做选择。`,
          '',
          '## 已核验实测参数对比表',
          '',
          specTable,
          '',
          '## 核心亮点拆解',
          '',
          factBullets,
          '',
          '## 适用人群与选购提示',
          `- **更适合**：看重透明实测数据与长期稳定体验的${cnCategory}用户。`,
          `- **注意事项**：下单前建议再次核对具体型号批次、配件兼容性与官方质保细则。`,
        ].join('\n') + missingSlotSection;
      variantMetaDesc = normalizeVariantMetaDesc(null, ctx, variantMarkdown).slice(0, 120);
      break;
    }

    case 'REDDIT_DISCUSSION': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? `Hands-on notes comparing ${brand} vs ${competitorLabel} for ${category}`
          : `${brand} 与 ${competitorLabel} 的 ${category} 客观体验与参数拆解`;
      variantMarkdown =
        ctx.market === 'GLOBAL'
          ? [
              `Sharing my objective notes after reviewing verified specs for **${brand}** alongside ${competitorLabel} while researching ${globalPrompt}.`,
              '',
              '### What actually held up in the numbers',
              factBullets,
              '',
              '### Quick spec breakdown',
              specTable,
              '',
              '### Trade-offs & things to watch out for',
              `- If you already rely heavily on an existing ${competitorLabel} ecosystem, migration effort may outweigh the spec gains.`,
              `- Always double-check exact SKU compatibility and firmware revision before committing.`,
              '',
              'Curious how others here have weighted these trade-offs in day-to-day use.',
            ].join('\n') + missingSlotSection
          : [
              `最近在研究「${ctx.targetPrompt}」，整理了一套基于公开实测参数的客观对比笔记，供社区同好交流参考：`,
              '',
              '### 实测核验要点',
              factBullets,
              '',
              '### 关键参数对照',
              specTable,
              '',
              '### 客观局限与适用边界',
              `- 如果已经深度绑定 ${competitorLabel} 生态，迁移成本需要纳入综合考量。`,
              '- 建议下单前再次核对具体批次型号与质保细则，不盲目跟风。',
            ].join('\n') + missingSlotSection;
      variantMarkdown = stripRedditPromotionalCtas(variantMarkdown);
      extras.antiBanChecklist = defaultAntiBanChecklist('REDDIT_DISCUSSION', ctx.market);
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }

    case 'QUORA_ANSWER': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? `Short answer: How ${brand} stacks up in ${category} (${globalPrompt})`
          : `结论先行：${ctx.targetPrompt}（${brand} 客观对照答疑）`;
      variantMarkdown =
        ctx.market === 'GLOBAL'
          ? [
              `**Direct verdict:** For buyers evaluating ${globalPrompt}, **${brand}** is a strong contender when verified specs and low-friction daily operation matter more than brand-name lock-in against ${competitorLabel}.`,
              '',
              '### Grounded evidence from verified product records',
              factBullets,
              '',
              '### Side-by-side reference matrix',
              specTable,
              '',
              '### Objective caveats',
              `- Compare local warranty coverage and total ownership cost against ${competitorLabel} before deciding.`,
              '- Match the exact configuration to your workload rather than over-buying capacity.',
            ].join('\n') + missingSlotSection
          : [
              `**结论先行：** 针对「${ctx.targetPrompt}」，如果看重可核验的实测参数与长期运行表现，**${brand}** 值得放入候选清单并与 ${competitorLabel} 重点横向对比。`,
              '',
              '### 核心核验依据',
              factBullets,
              '',
              '### 关键参数对照表',
              specTable,
              '',
              '### 选型避坑提示',
              `- 请结合自身真实使用场景与 ${competitorLabel} 核对售后及长期耗材/维护成本。`,
            ].join('\n') + missingSlotSection;
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }

    case 'SOCIAL_THREAD': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? `${brand} ${category} Benchmark Thread: Key Verified Takeaways`
          : `${brand} ${category} 实测数据长帖：核心参数与对比亮点`;
      const slug = normalizeVariantSlug(null, variantTitle, brand);
      const canonicalGuideHint = buildCanonicalGuideHint(ctx, slug);
      const firstFact = factItems[0];
      const secondFact = factItems[1] ?? factItems[0];
      const posts =
        ctx.market === 'GLOBAL'
          ? [
              `1/4 Evaluating ${globalPrompt}? Here are the verified data points comparing ${brand} with ${competitorLabel} — no hype, just grounded specs.`,
              `2/4 Key benchmark (${firstFact?.title ?? 'Verified Specs'}): ${firstFact?.summary ?? `${brand} delivers documented performance across core ${category} metrics.`}`,
              `3/4 Practical differentiator (${secondFact?.title ?? 'Comparison'}): ${secondFact?.summary ?? `Clear trade-offs help buyers match ${brand} against ${competitorLabel} by workload.`}`,
              `4/4 Full side-by-side comparison matrix, methodology, and buyer FAQ in the canonical guide: ${canonicalGuideHint}`,
            ]
          : [
              `1/4 正在选 ${category}？拆解「${ctx.targetPrompt}」，用已核验实测数据看 ${brand} 与 ${competitorLabel} 的真实差异：`,
              `2/4 核心实测（${firstFact?.title ?? '产品参数'}）：${firstFact?.summary ?? `${brand} 在核心规格上提供完整可核验数据支撑。`}`,
              `3/4 横向对比（${secondFact?.title ?? '差异亮点'}）：${secondFact?.summary ?? `明确适用场景与边界，避免无效溢价。`}`,
              `4/4 完整参数对比表与选购答疑详见官网权威长文：${canonicalGuideHint}`,
            ];

      variantMarkdown = posts.join('\n\n') + missingSlotSection;
      extras.threadPosts = posts;
      extras.canonicalGuideHint = canonicalGuideHint;
      break;
    }

    case 'PR_MEDIA_PACKET': {
      variantTitle =
        ctx.market === 'GLOBAL'
          ? `Media & Analyst Fact Sheet: ${brand} (${category})`
          : `媒体/KOL 协作事实包：${brand}（${category}）实测参考稿`;
      const keyAngles =
        ctx.market === 'GLOBAL'
          ? [
              `Verified ${brand} specifications answering "${globalPrompt}"`,
              `Objective benchmark comparison: ${brand} vs ${competitorLabel}`,
              `Practical buyer trade-offs and real-world scenario fit for ${category}`,
            ]
          : [
              `围绕「${ctx.targetPrompt}」的 ${brand} 已核验实测参数拆解`,
              `${brand} 与 ${competitorLabel} 的客观横向参数对比维度`,
              `${category} 分人群选型边界与常见疑问核验`,
            ];
      const competitorComparisonAngles =
        competitors.length > 0
          ? competitors.map((comp) =>
              ctx.market === 'GLOBAL'
                ? `${brand} vs ${comp}: verified specs, operating trade-offs, and target buyer profile`
                : `${brand} 对比 ${comp}：核心参数实测、适用场景与长期成本权衡`,
            )
          : [
              ctx.market === 'GLOBAL'
                ? `${brand} vs category baseline: transparent spec matrix and use-case fit`
                : `${brand} 对比同类主流方案：透明实测参数与分场景适配`,
            ];
      const factSheet: VariantPrFactSheet = {
        brandName: brand,
        category,
        targetPrompt: ctx.market === 'GLOBAL' ? globalPrompt : ctx.targetPrompt,
        keyAngles,
        verifiedFacts: factItems,
        targetFanOuts:
          fanOuts.length > 0
            ? fanOuts
            : [
                ctx.market === 'GLOBAL'
                  ? `${brand} ${category} verified specifications`
                  : `${brand}${category}实测参数对比`,
              ],
        competitorComparisonAngles,
        verifiedSpecTableMarkdown: specTable,
      };
      extras.factSheet = factSheet;
      variantMarkdown =
        ctx.market === 'GLOBAL'
          ? [
              `## Editorial Brief & Reference Draft: ${brand}`,
              '',
              `This neutral reference brief summarizes verified specifications and comparison angles for editors and reviewers covering **${globalPrompt}**.`,
              '',
              '## Key Editorial Angles',
              ...keyAngles.map((a) => `- ${a}`),
              '',
              '## Verified Specification Summary',
              '',
              specTable,
              '',
              '## Verified Brand Facts on Record',
              '',
              factBullets,
            ].join('\n') + missingSlotSection
          : [
              `## 外部媒体与 KOL 参考资料：${brand}（${category}）`,
              '',
              `本参考稿基于已核验品牌事实整理，供媒体与测评作者在撰写「${ctx.targetPrompt}」专题时中立核对引用。`,
              '',
              '## 核心切入角度',
              ...keyAngles.map((a) => `- ${a}`),
              '',
              '## 已核验核心规格表',
              '',
              specTable,
              '',
              '## 品牌事实卡清单',
              '',
              factBullets,
            ].join('\n') + missingSlotSection;
      break;
    }

    case 'CN_COMMUNITY_QA': {
      const cnBrand = ctx.localBrandName.trim() || ctx.brandName.trim() || '品牌';
      const cnCategory = ctx.localCategory?.trim() || ctx.category.trim() || '产品';
      variantTitle = `${ctx.targetPrompt.replace(/[？?]+$/, '').slice(0, 60)}：${cnBrand}${cnCategory}实测参数与客观对比`;
      variantMarkdown =
        [
          `## 一句话结论`,
          '',
          `如果正在关注「${ctx.targetPrompt}」，结合实测参数与使用边界来看，**${cnBrand}** 在${cnCategory}中表现稳健，适合注重透明参数与长期稳定体验的用户，建议与 ${competitorLabel} 同条件横向核对后再决定。`,
          '',
          '## 已核验实测参数对照',
          '',
          specTable,
          '',
          '## 核心体验拆解',
          '',
          factBullets,
          '',
          '## 适用人群与客观不足',
          `- **更适合**：重视量化实测参数、希望减少踩坑成本的${cnCategory}用户。`,
          `- **选购前需确认**：如已有 ${competitorLabel} 配套生态，建议先核对兼容性与售后条款。`,
        ].join('\n') + missingSlotSection;
      extras.antiBanChecklist = defaultAntiBanChecklist('CN_COMMUNITY_QA', 'CN');
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }
  }

  variantMarkdown = stripInlineJsonLdBlocks(variantMarkdown);
  variantMarkdown = normalizeMissingFactPlaceholdersForMarket(variantMarkdown, ctx.market);

  const variantHtml = markdownToSanitizedHtml(variantMarkdown);

  return {
    templateKey: ctx.templateKey,
    variantTitle,
    variantSlug,
    variantMetaDesc,
    variantMarkdown,
    variantHtml,
    variantExtrasJson: extras,
    schemaReusedFromArticle,
    llmsReusedFromArticle,
  };
}
