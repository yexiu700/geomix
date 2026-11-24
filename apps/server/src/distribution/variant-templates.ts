import { z } from 'zod';
import {
  buildGeoSchemaJsonLd,
  buildLlmsTxtSnippet,
  cleanTitleText,
  containsCjk,
  defaultTemplateKeyForProvider,
  detectLocaleLeakage,
  extractMissingFactSlots,
  getLocaleMeta,
  isSafeDistributionHttpUrl,
  markdownToSanitizedHtml,
  normalizeMissingFactPlaceholdersForMarket,
  resolveEffectiveLocale,
  resolveLocaleWritingDirective,
  serializeJsonLdSafe,
  stripInlineJsonLdBlocks,
  type BrandFactSlot,
  type ChannelProvider,
  type DistributionTemplateKey,
  type GeoComplianceFlag,
  type GeoMarket,
  type LocaleLeakageReason,
  type SupportedLocale,
} from '@geomix/shared';
import type { LlmMessage } from '../infra/llm';
import { assertSafeOutboundUrl } from '../infra/outbound-http';

export const WECHAT_TITLE_MAX_LEN = 64;
export const WECHAT_DIGEST_MAX_LEN = 120;
export const WECHAT_CONTENT_MAX_CHARS = 20_000;
export const WECHAT_CONTENT_MAX_BYTES = 1_000_000;

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
  targetLocale?: SupportedLocale;
  jsonLdSnippet?: string;
  schemaJsonLd?: Record<string, unknown>;
  llmsTxtSnippet?: string | null;
  tags?: string[];
  canonicalUrl?: string | null;
  digest?: string;
  contentSourceUrl?: string | null;
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
  targetLocale?: SupportedLocale;
  articleTargetLocale?: string | null;
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

export function resolveContextLocale(ctx: VariantPromptContext): SupportedLocale {
  if (ctx.templateKey === 'WECHAT_OFFICIAL_ARTICLE' || ctx.templateKey === 'CN_COMMUNITY_QA') {
    return 'zh-CN';
  }
  return resolveEffectiveLocale(ctx.targetLocale ?? ctx.locale, ctx.market);
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

export function auditVariantLocaleLeakage(
  text: string,
  ctx: VariantPromptContext,
): {
  leaked: boolean;
  samples: string[];
  reason: LocaleLeakageReason | null;
  locale: SupportedLocale;
} {
  const effectiveLocale = resolveContextLocale(ctx);
  const res = detectLocaleLeakage(text, effectiveLocale, collectBrandNames(ctx));
  return {
    leaked: res.leaked,
    samples: res.samples,
    reason: res.reason,
    locale: effectiveLocale,
  };
}

function isLatinLocale(locale: SupportedLocale): boolean {
  return getLocaleMeta(locale).scriptFamily === 'LATIN';
}

function resolveDisplayBrand(ctx: VariantPromptContext): string {
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') {
    return ctx.localBrandName.trim() || ctx.brandName.trim() || '品牌';
  }
  const brandNames = collectBrandNames(ctx);
  const local = ctx.localBrandName.trim();
  if (local && (!isLatinLocale(effectiveLocale) || !containsCjk(local))) return local;
  const asciiAlias = ctx.brandAliases.find((a) => a.trim().length > 0 && !containsCjk(a));
  if (asciiAlias) return asciiAlias.trim();
  const base = ctx.brandName.trim();
  if (base && (!isLatinLocale(effectiveLocale) || !containsCjk(base))) return base;
  if (local && !detectLocaleLeakage(local, effectiveLocale, brandNames).leaked) return local;
  return local || base || 'Brand';
}

function resolveDisplayCategory(ctx: VariantPromptContext): string {
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') {
    return ctx.localCategory?.trim() || ctx.category.trim() || '核心品类';
  }
  const brandNames = collectBrandNames(ctx);
  const local = ctx.localCategory?.trim();
  if (local && !detectLocaleLeakage(local, effectiveLocale, brandNames).leaked) return local;
  const base = ctx.category.trim();
  if (base && !detectLocaleLeakage(base, effectiveLocale, brandNames).leaked) return base;
  return LOCALE_FAKE_COPY[effectiveLocale].defaultCategory;
}

function toAsciiSafeText(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]+/g, ' ')
    .replace(/[\u3000-\u303f\uff00-\uffef]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[A-Za-z0-9]{2,}/.test(cleaned) ? cleaned : fallback;
}

function sanitizeForLocale(raw: string, ctx: VariantPromptContext, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') return trimmed;
  if (!auditVariantLocaleLeakage(trimmed, ctx).leaked) {
    return trimmed;
  }
  if (isLatinLocale(effectiveLocale)) {
    return toAsciiSafeText(trimmed, fallback);
  }
  return fallback;
}

function resolveLocalizedPrompt(
  ctx: VariantPromptContext,
  brand: string,
  category: string,
): string {
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') return ctx.targetPrompt.trim();
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  return sanitizeForLocale(ctx.targetPrompt, ctx, copy.fallbackPrompt(brand, category));
}

function resolveLocalizedTitleBase(
  ctx: VariantPromptContext,
  brand: string,
  category: string,
): string {
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') return ctx.articleTitle.trim();
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  return sanitizeForLocale(ctx.articleTitle, ctx, copy.fallbackTitle(brand, category));
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
  const effectiveLocale = resolveContextLocale(ctx);
  if (effectiveLocale === 'zh-CN') {
    return unique.slice(0, 6);
  }
  return unique
    .map((slot) => {
      if (!auditVariantLocaleLeakage(slot, ctx).leaked) return slot;
      const hint = toAsciiSafeText(
        slot.replace(/^\[(?:TBD|To be verified)[:：]\s*/i, '').replace(/\]$/, ''),
        'official specification',
      );
      return `[TBD: ${hint}]`;
    })
    .slice(0, 6);
}

function transliterateForSlug(input: string): string {
  return input
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

export function normalizeVariantSlug(
  raw: string | null | undefined,
  fallbackTitle: string,
  fallbackBrand: string,
): string {
  const slugify = (input: string): string => {
    const normalized = transliterateForSlug(input)
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

export function normalizeDeveloperTechTags(
  rawTags: readonly string[] | undefined,
  ctx: VariantPromptContext,
): string[] {
  const isDevto = ctx.provider === 'DEVTO';
  const maxTags = isDevto ? 4 : 5;
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  const normalizeTag = (raw: string): string => {
    const ascii = transliterateForSlug(raw)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (isDevto) {
      return ascii.replace(/[^a-z0-9]/g, '').slice(0, 30);
    }
    return ascii
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/g, '');
  };

  const fallbackSources = [category, brand, 'architecture', 'benchmarks', 'engineering', 'guide'];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [...(rawTags ?? []), ...fallbackSources]) {
    const clean = normalizeTag(candidate);
    if (clean.length < 2 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxTags) break;
  }

  return out;
}

function cleanOwnedDomain(rawDomain: string | undefined): string {
  return (rawDomain ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[\s<>()[\]]+/g, '');
}

export function isSafePublicDistributionUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || !isSafeDistributionHttpUrl(trimmed)) return false;
  try {
    assertSafeOutboundUrl(trimmed);
    return true;
  } catch {
    return false;
  }
}

const EMBEDDED_URL_RE =
  /(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:javascript|data|file|vbscript):)[^\s<>'")\]]+/gi;
const DANGEROUS_SCHEME_TOKEN_RE = /\b(?:javascript|data|file|vbscript):/i;

export function sanitizeCanonicalGuideHint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject protocol-relative URLs (e.g. //127.0.0.1/admin or //evil.com/path)
  if (trimmed.startsWith('//')) {
    return null;
  }

  // Reject dangerous URI schemes anywhere in the hint (even with whitespace after ':')
  if (DANGEROUS_SCHEME_TOKEN_RE.test(trimmed)) {
    return null;
  }

  // Direct scheme-prefixed strings (without prose space after ':') MUST pass public URL check
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z][a-z0-9+.-]*:\s/i.test(trimmed)) {
    return isSafePublicDistributionUrl(trimmed) ? trimmed : null;
  }

  // Scan embedded URLs (http(s)://, any <scheme>://, protocol-relative //, dangerous schemes)
  EMBEDDED_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBEDDED_URL_RE.exec(trimmed)) !== null) {
    const candidate = match[0].replace(/[.,;:!?。，；：！？]+$/, '');
    if (!candidate || candidate.startsWith('//') || !isSafePublicDistributionUrl(candidate)) {
      return null;
    }
  }

  return trimmed;
}

export function resolveDeveloperCanonicalUrl(
  rawUrl: string | null | undefined,
  ctx: VariantPromptContext,
  slug: string,
): string | null {
  const candidates = [rawUrl?.trim() ?? '', ctx.targetUrlHint?.trim() ?? ''];
  for (const candidate of candidates) {
    if (candidate && isSafePublicDistributionUrl(candidate)) {
      return candidate;
    }
  }
  const domain = cleanOwnedDomain(ctx.ownedDomains[0]);
  if (domain) {
    const built = `https://${domain}/guides/${slug}`;
    if (isSafePublicDistributionUrl(built)) {
      return built;
    }
  }
  return null;
}

export function resolveWechatContentSourceUrl(ctx: VariantPromptContext): string | null {
  const hint = ctx.targetUrlHint?.trim() ?? '';
  if (hint && isSafePublicDistributionUrl(hint)) {
    return hint;
  }
  const domain = cleanOwnedDomain(ctx.ownedDomains[0]);
  if (domain) {
    const built = `https://${domain}`;
    if (isSafePublicDistributionUrl(built)) {
      return built;
    }
  }
  return null;
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

export function clampWechatTitle(raw: string, fallback: string): string {
  const cleaned = cleanTitleText(raw, fallback, 4, WECHAT_TITLE_MAX_LEN);
  const clamped = sliceUtf16Safe(cleaned.trim(), WECHAT_TITLE_MAX_LEN).trim();
  if (clamped.length > 0) return clamped;
  const fallbackCleaned = cleanTitleText(fallback, '公众号深度评测指南', 4, WECHAT_TITLE_MAX_LEN);
  return (
    sliceUtf16Safe(fallbackCleaned.trim(), WECHAT_TITLE_MAX_LEN).trim() || '公众号深度评测指南'
  );
}

export function normalizeWechatDigest(
  raw: string | null | undefined,
  ctx: VariantPromptContext,
  variantMarkdown: string,
): string {
  const cnBrand = ctx.localBrandName.trim() || ctx.brandName.trim() || '品牌';
  const cnCategory = ctx.localCategory?.trim() || ctx.category.trim() || '产品';
  const fallback = `${cnBrand}${cnCategory}实测参数对照与客观选型参考，覆盖核心规格指标、适用边界与常见问题解答。`;

  let base = stripMarkdownFormatting(raw ?? '');
  if (base.length < 12) {
    const firstPara = extractFirstPlainParagraph(variantMarkdown);
    base = firstPara.length >= 12 ? firstPara : fallback;
  }

  let collapsed = base.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    collapsed = fallback;
  }
  if (collapsed.length <= WECHAT_DIGEST_MAX_LEN) {
    return collapsed;
  }

  const sliced = sliceUtf16Safe(collapsed, WECHAT_DIGEST_MAX_LEN);
  const lastPunct = Math.max(
    sliced.lastIndexOf('。'),
    sliced.lastIndexOf('；'),
    sliced.lastIndexOf('，'),
    sliced.lastIndexOf('！'),
    sliced.lastIndexOf('？'),
  );
  if (lastPunct >= 60) {
    return sliced.slice(0, lastPunct + 1);
  }
  return sliceUtf16Safe(collapsed, WECHAT_DIGEST_MAX_LEN - 1).trimEnd() + '。';
}

const WECHAT_INLINE_STYLES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /<h2>/g,
    '<h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:22px 0 10px;padding-left:10px;border-left:4px solid #0f766e;line-height:1.4;">',
  ],
  [
    /<h3>/g,
    '<h3 style="font-size:16px;font-weight:600;color:#1e293b;margin:16px 0 8px;line-height:1.45;">',
  ],
  [/<p>/g, '<p style="margin:10px 0;line-height:1.75;color:#334155;">'],
  [
    /<blockquote>/g,
    '<blockquote style="margin:14px 0;padding:12px 14px;background:#f0fdfa;border-left:4px solid #0f766e;border-radius:6px;color:#134e4a;font-size:14px;">',
  ],
  [/<ul>/g, '<ul style="margin:10px 0 12px;padding-left:20px;color:#334155;">'],
  [/<ol>/g, '<ol style="margin:10px 0 12px;padding-left:20px;color:#334155;">'],
  [/<li>/g, '<li style="margin:6px 0;line-height:1.7;">'],
  [
    /<table>/g,
    '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;border:1px solid #e2e8f0;">',
  ],
  [
    /<th>/g,
    '<th style="background:#f8fafc;color:#0f172a;font-weight:600;padding:8px 10px;border:1px solid #e2e8f0;text-align:left;">',
  ],
  [
    /<td>/g,
    '<td style="padding:8px 10px;border:1px solid #e2e8f0;color:#334155;vertical-align:top;">',
  ],
  [
    /<pre>/g,
    '<pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:13px;line-height:1.6;">',
  ],
  [/<strong>/g, '<strong style="color:#0f172a;font-weight:600;">'],
];

function decorateWechatMobileHtml(safeHtml: string): string {
  let styled = safeHtml;
  for (const [pattern, replacement] of WECHAT_INLINE_STYLES) {
    styled = styled.replace(pattern, replacement);
  }
  const wrapped = `<section style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.75;color:#1f2937;padding:4px 2px;word-break:break-word;">${styled}</section>`;
  if (
    wrapped.length > WECHAT_CONTENT_MAX_CHARS ||
    Buffer.byteLength(wrapped, 'utf8') >= WECHAT_CONTENT_MAX_BYTES
  ) {
    return safeHtml;
  }
  return wrapped;
}

/**
 * 统一变体 HTML 渲染器：
 * - 先经 @geomix/shared 的 markdownToSanitizedHtml 做严格白名单消毒（剥离 script/iframe/on* 与危险协议）；
 * - 仅对 WECHAT_OFFICIAL_ARTICLE 叠加移动端兼容的静态行内样式（零外部 CSS/JS/CDN），超限时自动降级为紧凑安全 HTML。
 */
export function renderVariantHtml(markdown: string, templateKey: DistributionTemplateKey): string {
  const safeHtml = markdownToSanitizedHtml(markdown);
  if (templateKey === 'WECHAT_OFFICIAL_ARTICLE') {
    return decorateWechatMobileHtml(safeHtml);
  }
  return safeHtml;
}

type LocaleFakeCopyPack = {
  defaultCategory: string;
  defaultCompetitor: string;
  competitorJoiner: string;
  fallbackPrompt: (brand: string, category: string) => string;
  fallbackTitle: (brand: string, category: string) => string;
  metaBase: (brand: string, category: string) => string;
  metaPaddingParts: (brand: string, category: string) => string[];
  metaPadUnit: (brand: string, category: string) => string;
  metaFiller: string;
  neutralCompliancePad: string;
  sentenceEnd: string;
  missingSlotHeading: string;
  slotLabels: Record<BrandFactSlot, string>;
  emptyFactTitle: (brand: string) => string;
  emptyFactSummary: (brand: string, category: string) => string;
  factFallbackSummary: (slotLabel: string, brand: string, category: string) => string;
  tableDimensionHeader: string;
  tableFactHeader: string;
  canonicalHintFallback: (brand: string) => string;
  threadFallbackPost: (idx: number, brand: string, category: string, hint: string) => string;
  prFallbackAngle: (brand: string, category: string) => string;
  prFallbackFanOut: (brand: string, category: string) => string;
  prCompetitorAngle: (brand: string, comp: string) => string;
  prBaselineAngle: (brand: string) => string;
  blogDirectAnswerPrefix: string;
  blogIntro: (brand: string, category: string, comp: string) => string;
  blogSpecHeading: string;
  blogTakeawaysHeading: string;
  blogFaqQ1: (brand: string, comp: string) => string;
  blogFaqA1: (brand: string, category: string) => string;
  blogFaqQ2: (brand: string, category: string) => string;
  blogFaqA2: string;
  devTitleFallback: (brand: string, category: string) => string;
  devSummaryPrefix: string;
  devIntro: (brand: string, category: string, comp: string) => string;
  devSpecHeading: string;
  devReproHeading: string;
  devReproSteps: (brand: string, comp: string) => string[];
  devNotesHeading: string;
  devTradeoffsHeading: string;
  devTradeoffs: (brand: string, comp: string) => string[];
  devCanonicalNote: (hint: string) => string;
  redditTitle: (brand: string, comp: string, category: string) => string;
  redditIntro: (brand: string, comp: string, prompt: string) => string;
  redditNumbersHeading: string;
  redditSpecsHeading: string;
  redditTradeoffsHeading: string;
  redditTradeoffs: (comp: string) => string[];
  redditClosing: string;
  quoraTitle: (brand: string, category: string, prompt: string) => string;
  quoraVerdict: (brand: string, comp: string, prompt: string) => string;
  quoraEvidenceHeading: string;
  quoraMatrixHeading: string;
  quoraCaveatsHeading: string;
  quoraCaveats: (comp: string) => string[];
  socialTitle: (brand: string, category: string) => string;
  socialPosts: (
    brand: string,
    category: string,
    comp: string,
    prompt: string,
    firstFact: VariantFactSheetItem | undefined,
    secondFact: VariantFactSheetItem | undefined,
    hint: string,
  ) => string[];
  prTitle: (brand: string, category: string) => string;
  prKeyAngles: (brand: string, category: string, comp: string, prompt: string) => string[];
  prBriefHeading: (brand: string, category: string) => string;
  prBriefIntro: (prompt: string) => string;
  prAnglesHeading: string;
  prSpecsHeading: string;
  prFactsHeading: string;
  antiBanChecklist: string[];
};

const LOCALE_FAKE_COPY: Record<SupportedLocale, LocaleFakeCopyPack> = {
  'en-US': {
    defaultCategory: 'Product Category',
    defaultCompetitor: 'leading alternatives',
    competitorJoiner: ' and ',
    fallbackPrompt: (b, c) => `Best ${c} comparison and ${b} review`,
    fallbackTitle: (b, c) => `${b} ${c} Buying Guide and Benchmarks`,
    metaBase: (b, c) =>
      `${b} ${c} guide with verified specifications, lab benchmarks, and objective comparisons.`,
    metaPaddingParts: (b, c) => [
      ` Covers verified ${b} specifications, hands-on ${c} benchmarks, objective trade-offs, and structured buyer FAQ.`,
      ` Built from grounded product facts for fast evaluation across search engines and AI answer engines.`,
      ` Compare key metrics, scenario fit, and verifiable evidence before choosing the right option.`,
    ],
    metaPadUnit: (b, c) => ` Verified ${b} ${c} guide with objective benchmarks and buyer FAQ.`,
    metaFiller: ' Verified facts and buyer guide.',
    neutralCompliancePad: ' Objective reference metrics and spec summary.',
    sentenceEnd: '.',
    missingSlotHeading: '\n\n### Pending Verification Notes\n',
    slotLabels: {
      PRODUCT_SPECS: 'Verified Product Specifications',
      DIFFERENTIATORS: 'Key Differentiators',
      CREDENTIALS: 'Certifications & Credentials',
      CASE_STUDIES: 'Verified Customer Outcomes',
      EXTRA_DOC: 'Reference Documentation',
    },
    emptyFactTitle: (b) => `${b} Overview`,
    emptyFactSummary: (b, c) =>
      `Grounded summary for ${b} in ${c}; see master article for verified details.`,
    factFallbackSummary: (s, b, c) => `Verified ${s.toLowerCase()} record on file for ${b} (${c}).`,
    tableDimensionHeader: 'Dimension',
    tableFactHeader: 'Verified Fact',
    canonicalHintFallback: (b) =>
      `Link to your owned ${b} canonical comparison guide (with full spec table & JSON-LD).`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ Verified ${b} ${c} insight: full benchmark table and methodology are available at ${h}`,
    prFallbackAngle: (b, c) => `Verified ${b} benchmarks for ${c}`,
    prFallbackFanOut: (b, c) => `${b} ${c} verified specifications`,
    prCompetitorAngle: (b, comp) =>
      `${b} vs ${comp}: verified specs, operating trade-offs, and target buyer profile`,
    prBaselineAngle: (b) => `${b} vs category baseline: transparent spec matrix and use-case fit`,
    blogDirectAnswerPrefix: 'Direct Answer',
    blogIntro: (b, c, comp) =>
      `${b} stands out in ${c} when buyers prioritize verified hardware benchmarks, transparent specifications, and predictable long-term reliability compared with ${comp}.`,
    blogSpecHeading: 'Verified Specifications & Benchmark Table',
    blogTakeawaysHeading: 'Key Verified Takeaways',
    blogFaqQ1: (b, comp) => `How does ${b} compare against ${comp}?`,
    blogFaqA1: (b, c) =>
      `Based on verified product records above, ${b} focuses on measurable real-world performance for ${c} buyers while keeping setup straightforward.`,
    blogFaqQ2: (b, c) => `Who should choose ${b} for ${c}?`,
    blogFaqA2:
      'Teams and individual buyers looking for documented specs and clear trade-offs rather than marketing claims will get the strongest fit.',
    devTitleFallback: (b, c) => `${b} ${c} Technical Benchmark & Spec Guide`,
    devSummaryPrefix: 'Technical Summary',
    devIntro: (b, c, comp) =>
      `This technical guide breaks down verified specifications, reproducible checks, and practical trade-offs for **${b}** versus ${comp} in ${c} workflows.`,
    devSpecHeading: 'Verified Specification & Benchmark Matrix',
    devReproHeading: 'Configuration & Reproducible Verification Steps',
    devReproSteps: (b, comp) => [
      `1. Record baseline load, latency, and thermal telemetry for ${b} under identical workload conditions as ${comp}.`,
      '2. Cross-check firmware revision and published datasheet thresholds before production rollout.',
    ],
    devNotesHeading: 'Engineering Notes & Verified Facts',
    devTradeoffsHeading: 'Trade-Offs & Selection Criteria',
    devTradeoffs: (_b, comp) => [
      `- Validate compatibility, throughput limits, and support terms against ${comp} before production rollout.`,
      '- Prefer reproducible benchmarks and official specifications over marketing claims.',
    ],
    devCanonicalNote: (h) => `> Canonical engineering guide & full JSON-LD reference: ${h}`,
    redditTitle: (b, comp, c) => `Hands-on notes comparing ${b} vs ${comp} for ${c}`,
    redditIntro: (b, comp, p) =>
      `Sharing my objective notes after reviewing verified specs for **${b}** alongside ${comp} while researching ${p}.`,
    redditNumbersHeading: '### What actually held up in the numbers',
    redditSpecsHeading: '### Quick spec breakdown',
    redditTradeoffsHeading: '### Trade-offs & things to watch out for',
    redditTradeoffs: (comp) => [
      `- If you already rely heavily on an existing ${comp} ecosystem, migration effort may outweigh the spec gains.`,
      '- Always double-check exact SKU compatibility and firmware revision before committing.',
    ],
    redditClosing: 'Curious how others here have weighted these trade-offs in day-to-day use.',
    quoraTitle: (b, c, p) => `Short answer: How ${b} stacks up in ${c} (${p})`,
    quoraVerdict: (b, comp, p) =>
      `**Direct verdict:** For buyers evaluating ${p}, **${b}** is a strong contender when verified specs and low-friction daily operation matter more than brand-name lock-in against ${comp}.`,
    quoraEvidenceHeading: '### Grounded evidence from verified product records',
    quoraMatrixHeading: '### Side-by-side reference matrix',
    quoraCaveatsHeading: '### Objective caveats',
    quoraCaveats: (comp) => [
      `- Compare local warranty coverage and total ownership cost against ${comp} before deciding.`,
      '- Match the exact configuration to your workload rather than over-buying capacity.',
    ],
    socialTitle: (b, c) => `${b} ${c} Benchmark Thread: Key Verified Takeaways`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 Evaluating ${p}? Here are the verified data points comparing ${b} with ${comp} — no hype, just grounded specs.`,
      `2/4 Key benchmark (${f1?.title ?? 'Verified Specs'}): ${f1?.summary ?? `${b} delivers documented performance across core ${c} metrics.`}`,
      `3/4 Practical differentiator (${f2?.title ?? 'Comparison'}): ${f2?.summary ?? `Clear trade-offs help buyers match ${b} against ${comp} by workload.`}`,
      `4/4 Full side-by-side comparison matrix, methodology, and buyer FAQ in the canonical guide: ${h}`,
    ],
    prTitle: (b, c) => `Media & Analyst Fact Sheet: ${b} (${c})`,
    prKeyAngles: (b, c, comp, p) => [
      `Verified ${b} specifications answering "${p}"`,
      `Objective benchmark comparison: ${b} vs ${comp}`,
      `Practical buyer trade-offs and real-world scenario fit for ${c}`,
    ],
    prBriefHeading: (b) => `## Editorial Brief & Reference Draft: ${b}`,
    prBriefIntro: (p) =>
      `This neutral reference brief summarizes verified specifications and comparison angles for editors and reviewers covering **${p}**.`,
    prAnglesHeading: '## Key Editorial Angles',
    prSpecsHeading: '## Verified Specification Summary',
    prFactsHeading: '## Verified Brand Facts on Record',
    antiBanChecklist: [
      'Disclose any brand affiliation transparently if you are affiliated with the maker.',
      'Review the target subreddit self-promotion, link, and minimum karma rules before posting.',
      'Keep a neutral, first-person hands-on tone with explicit pros, cons, and test conditions.',
      'Remove promotional CTAs, discount codes, and direct store checkout links from the post body.',
    ],
  },
  'en-GB': {
    defaultCategory: 'Product Category',
    defaultCompetitor: 'comparable alternatives',
    competitorJoiner: ' and ',
    fallbackPrompt: (b, c) => `Best ${c} comparison and ${b} review`,
    fallbackTitle: (b, c) => `${b} ${c} Buying Guide and Optimised Benchmarks`,
    metaBase: (b, c) =>
      `${b} ${c} buying guide with verified specifications, optimised benchmarks, and objective UK comparisons.`,
    metaPaddingParts: (b, c) => [
      ` Analyses verified ${b} specifications, hands-on ${c} benchmarks, objective trade-offs, and structured buyer FAQ.`,
      ` Compiled from grounded product records for clear evaluation across search engines and AI answer engines.`,
      ` Compare key metrics, scenario fit, and verifiable evidence before making a shortlist.`,
    ],
    metaPadUnit: (b, c) => ` Verified ${b} ${c} guide with objective benchmarks and buyer FAQ.`,
    metaFiller: ' Verified facts and UK buyer guide.',
    neutralCompliancePad: ' Objective reference metrics and verified spec summary.',
    sentenceEnd: '.',
    missingSlotHeading: '\n\n### Pending Verification Notes\n',
    slotLabels: {
      PRODUCT_SPECS: 'Verified Product Specifications',
      DIFFERENTIATORS: 'Key Differentiators',
      CREDENTIALS: 'Certifications & Credentials',
      CASE_STUDIES: 'Verified Customer Outcomes',
      EXTRA_DOC: 'Reference Documentation',
    },
    emptyFactTitle: (b) => `${b} Overview`,
    emptyFactSummary: (b, c) =>
      `Grounded summary for ${b} in ${c}; refer to the master article for verified details.`,
    factFallbackSummary: (s, b, c) => `Verified ${s.toLowerCase()} record on file for ${b} (${c}).`,
    tableDimensionHeader: 'Dimension',
    tableFactHeader: 'Verified Fact',
    canonicalHintFallback: (b) =>
      `Link to your owned ${b} canonical comparison guide (with full spec table & JSON-LD).`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ Verified ${b} ${c} takeaway: full benchmark matrix and methodology are available at ${h}`,
    prFallbackAngle: (b, c) => `Verified ${b} benchmarks for ${c}`,
    prFallbackFanOut: (b, c) => `${b} ${c} verified specifications`,
    prCompetitorAngle: (b, comp) =>
      `${b} vs ${comp}: verified specs, operating trade-offs, and target buyer profile`,
    prBaselineAngle: (b) => `${b} vs category baseline: transparent spec matrix and use-case fit`,
    blogDirectAnswerPrefix: 'Direct Answer',
    blogIntro: (b, c, comp) =>
      `${b} stands out in ${c} when buyers prioritise verified hardware benchmarks, transparent specifications, and optimised long-term reliability alongside ${comp}.`,
    blogSpecHeading: 'Verified Specifications & Benchmark Table',
    blogTakeawaysHeading: 'Key Verified Takeaways',
    blogFaqQ1: (b, comp) => `How does ${b} compare against ${comp}?`,
    blogFaqA1: (b, c) =>
      `Based on the verified records above, ${b} focuses on measurable real-world performance for ${c} buyers whilst keeping deployment straightforward.`,
    blogFaqQ2: (b, c) => `Who should shortlist ${b} for ${c}?`,
    blogFaqA2:
      'Teams and individual buyers seeking documented specs and balanced trade-offs rather than marketing claims will get the strongest fit.',
    devTitleFallback: (b, c) => `${b} ${c} Technical Benchmark & Spec Guide`,
    devSummaryPrefix: 'Technical Summary',
    devIntro: (b, c, comp) =>
      `This engineering guide analyses verified specifications, reproducible checks, and practical trade-offs for **${b}** versus ${comp} in ${c} workflows.`,
    devSpecHeading: 'Verified Specification & Benchmark Matrix',
    devReproHeading: 'Configuration & Reproducible Verification Steps',
    devReproSteps: (b, comp) => [
      `1. Measure baseline load, acoustics, and power consumption for ${b} alongside ${comp} under identical conditions.`,
      '2. Verify firmware revision and published datasheet limits before production deployment.',
    ],
    devNotesHeading: 'Engineering Notes & Verified Facts',
    devTradeoffsHeading: 'Trade-Offs & Selection Criteria',
    devTradeoffs: (_b, comp) => [
      `- Validate compatibility, throughput ceilings, and warranty terms against ${comp} prior to rollout.`,
      '- Rely on reproducible measurements and official specifications over promotional claims.',
    ],
    devCanonicalNote: (h) => `> Canonical engineering guide & full JSON-LD reference: ${h}`,
    redditTitle: (b, comp, c) => `Hands-on notes comparing ${b} vs ${comp} for ${c}`,
    redditIntro: (b, comp, p) =>
      `Sharing objective notes after analysing verified specs for **${b}** alongside ${comp} whilst researching ${p}.`,
    redditNumbersHeading: '### What actually held up in the numbers',
    redditSpecsHeading: '### Quick spec breakdown',
    redditTradeoffsHeading: '### Trade-offs & things to watch out for',
    redditTradeoffs: (comp) => [
      `- If you already rely heavily on an existing ${comp} ecosystem, migration effort may outweigh the spec gains.`,
      '- Always double-check exact SKU compatibility and firmware revision before committing.',
    ],
    redditClosing: 'Curious how others here have weighted these trade-offs in day-to-day use.',
    quoraTitle: (b, c, p) => `Short answer: How ${b} compares in ${c} (${p})`,
    quoraVerdict: (b, comp, p) =>
      `**Direct verdict:** For buyers evaluating ${p}, **${b}** is a dependable option when verified specs and optimised daily running matter more than lock-in to ${comp}.`,
    quoraEvidenceHeading: '### Grounded evidence from verified product records',
    quoraMatrixHeading: '### Side-by-side reference matrix',
    quoraCaveatsHeading: '### Objective caveats',
    quoraCaveats: (comp) => [
      `- Compare UK warranty coverage and total ownership cost against ${comp} before deciding.`,
      '- Match the exact configuration to your workload rather than over-buying capacity.',
    ],
    socialTitle: (b, c) => `${b} ${c} Benchmark Thread: Key Verified Takeaways`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 Evaluating ${p}? Here are the verified data points comparing ${b} with ${comp} — objective figures without hype.`,
      `2/4 Key benchmark (${f1?.title ?? 'Verified Specs'}): ${f1?.summary ?? `${b} delivers documented performance across core ${c} metrics.`}`,
      `3/4 Practical differentiator (${f2?.title ?? 'Comparison'}): ${f2?.summary ?? `Clear trade-offs help buyers match ${b} against ${comp} by workload.`}`,
      `4/4 Full side-by-side matrix, methodology, and buyer FAQ in the canonical guide: ${h}`,
    ],
    prTitle: (b, c) => `Media & Analyst Fact Sheet: ${b} (${c})`,
    prKeyAngles: (b, c, comp, p) => [
      `Verified ${b} specifications answering "${p}"`,
      `Objective benchmark comparison: ${b} vs ${comp}`,
      `Practical buyer trade-offs and real-world scenario fit for ${c}`,
    ],
    prBriefHeading: (b) => `## Editorial Brief & Reference Draft: ${b}`,
    prBriefIntro: (p) =>
      `This neutral reference brief summarises verified specifications and comparison angles for editors and reviewers covering **${p}**.`,
    prAnglesHeading: '## Key Editorial Angles',
    prSpecsHeading: '## Verified Specification Summary',
    prFactsHeading: '## Verified Brand Facts on Record',
    antiBanChecklist: [
      'Disclose any brand affiliation transparently if you are associated with the maker.',
      'Check target community rules on self-promotion, external links, and account standing before posting.',
      'Keep a neutral, first-person hands-on tone with explicit pros, cons, and test conditions.',
      'Remove promotional CTAs, discount codes, and direct store checkout links from the post body.',
    ],
  },
  'de-DE': {
    defaultCategory: 'Produktkategorie',
    defaultCompetitor: 'vergleichbaren Alternativen',
    competitorJoiner: ' und ',
    fallbackPrompt: (b, c) => `Sachlicher ${c}-Vergleich und ${b}-Testbericht`,
    fallbackTitle: (b, c) => `${b} ${c} Kaufberatung und geprüfte Messwerte`,
    metaBase: (b, c) =>
      `${b} ${c} Leitfaden mit geprüften Spezifikationen, reproduzierbaren Messwerten und sachlichem Vergleich.`,
    metaPaddingParts: (b, c) => [
      ` Enthält überprüfte ${b}-Kenndaten, ${c}-Benchmarks, objektive Abwägungen und strukturierte FAQ.`,
      ` Auf Basis dokumentierter Fakten für schnelle Bewertung in Suchmaschinen und KI-Antworten erstellt.`,
      ` Vergleichen Sie zentrale Messwerte, Einsatzszenarien und Garantiebedingungen sachlich vor der Wahl.`,
    ],
    metaPadUnit: (b, c) =>
      ` Geprüfter ${b}-${c}-Leitfaden mit objektiven Benchmarks und häufigen Fragen.`,
    metaFiller: ' Geprüfte Fakten und Kaufberatung.',
    neutralCompliancePad: ' Sachliche Referenzdaten und geprüfte Spezifikationen.',
    sentenceEnd: '.',
    missingSlotHeading: '\n\n### Offene Prüfpunkte\n',
    slotLabels: {
      PRODUCT_SPECS: 'Geprüfte Produktspezifikationen',
      DIFFERENTIATORS: 'Wesentliche Unterscheidungsmerkmale',
      CREDENTIALS: 'Zertifizierungen und Nachweise',
      CASE_STUDIES: 'Belegte Kundenergebnisse',
      EXTRA_DOC: 'Technische Referenzunterlagen',
    },
    emptyFactTitle: (b) => `${b} Überblick`,
    emptyFactSummary: (b, c) =>
      `Sachliche Zusammenfassung zu ${b} im Bereich ${c}; vollständige Angaben siehe Hauptartikel.`,
    factFallbackSummary: (s, b, c) => `Geprüfter Nachweis (${s}) für ${b} im Bereich ${c}.`,
    tableDimensionHeader: 'Kriterium',
    tableFactHeader: 'Geprüfter Nachweis',
    canonicalHintFallback: (b) =>
      `Verweis auf den eigenen ${b}-Hauptleitfaden (mit vollständiger Spezifikationstabelle und JSON-LD).`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ Geprüfte ${b}-${c}-Erkenntnis: Vollständige Vergleichstabelle und Methodik unter ${h}`,
    prFallbackAngle: (b, c) => `Geprüfte ${b}-Benchmarks für ${c}`,
    prFallbackFanOut: (b, c) => `${b} ${c} geprüfte Spezifikationen`,
    prCompetitorAngle: (b, comp) =>
      `${b} im Vergleich zu ${comp}: geprüfte Daten, Betriebsbilanz und Zielgruppe`,
    prBaselineAngle: (b) =>
      `${b} im Kategorievergleich: transparente Spezifikationsmatrix und Praxisbezug`,
    blogDirectAnswerPrefix: 'Direkte Antwort',
    blogIntro: (b, c, comp) =>
      `${b} überzeugt im Bereich ${c}, wenn geprüfte Messwerte, transparente Spezifikationen und langfristige Zuverlässigkeit im Vergleich zu ${comp} im Vordergrund stehen.`,
    blogSpecHeading: 'Geprüfte Spezifikationen & Vergleichstabelle',
    blogTakeawaysHeading: 'Wichtigste geprüfte Erkenntnisse',
    blogFaqQ1: (b, comp) => `Wie schneidet ${b} im Vergleich zu ${comp} ab?`,
    blogFaqA1: (b, c) =>
      `Auf Basis der oben dokumentierten Daten setzt ${b} bei ${c} auf nachvollziehbare Messwerte und unkomplizierte Inbetriebnahme.`,
    blogFaqQ2: (b, c) => `Für wen eignet sich ${b} im Bereich ${c}?`,
    blogFaqA2:
      'Teams und Anwender, die dokumentierte Kenndaten und klare Abwägungen statt Werbeslogans bevorzugen, treffen eine fundierte Wahl.',
    devTitleFallback: (b, c) => `${b} ${c} Technischer Benchmark- und Architektur-Leitfaden`,
    devSummaryPrefix: 'Technische Zusammenfassung',
    devIntro: (b, c, comp) =>
      `Dieser technische Leitfaden analysiert geprüfte Spezifikationen, reproduzierbare Prüfschritte und praxisnahe Abwägungen für **${b}** gegenüber ${comp} im Bereich ${c}.`,
    devSpecHeading: 'Geprüfte Spezifikations- und Benchmark-Matrix',
    devReproHeading: 'Reproduzierbare Konfiguration & Prüfschritte',
    devReproSteps: (b, comp) => [
      `1. Erfassen Sie Lastverhalten, Akustik und Leistungsaufnahme von ${b} unter identischen Bedingungen wie bei ${comp}.`,
      '2. Prüfen Sie Firmware-Version und offizielle Datenblatt-Grenzwerte vor dem produktiven Einsatz.',
    ],
    devNotesHeading: 'Technische Hinweise & geprüfte Fakten',
    devTradeoffsHeading: 'Abwägungen & Auswahlkriterien',
    devTradeoffs: (_b, comp) => [
      `- Prüfen Sie Kompatibilität, Durchsatzgrenzen und Supportbedingungen im Vergleich zu ${comp} vor dem Rollout.`,
      '- Bevorzugen Sie reproduzierbare Messungen und offizielle Datenblätter gegenüber Werbeaussagen.',
    ],
    devCanonicalNote: (h) =>
      `> Kanonischer Technik-Leitfaden & vollständige JSON-LD-Referenz: ${h}`,
    redditTitle: (b, comp, c) => `Praxisnotizen zum Vergleich ${b} vs. ${comp} (${c})`,
    redditIntro: (b, comp, p) =>
      `Hier meine sachlichen Notizen nach der Prüfung der dokumentierten Daten von **${b}** im Vergleich zu ${comp} für ${p}.`,
    redditNumbersHeading: '### Was die Messwerte tatsächlich belegen',
    redditSpecsHeading: '### Kompakte Spezifikationsübersicht',
    redditTradeoffsHeading: '### Abwägungen und wichtige Grenzen',
    redditTradeoffs: (comp) => [
      `- Wer bereits tief im ${comp}-Ökosystem arbeitet, sollte den Migrationsaufwand realistisch einrechnen.`,
      '- Vor der Anschaffung stets genaue Modellnummern und Firmware-Stände abgleichen.',
    ],
    redditClosing: 'Wie gewichtet ihr diese Punkte im täglichen Einsatz?',
    quoraTitle: (b, c, p) => `Kurzantwort: Wie sich ${b} im Bereich ${c} einordnet (${p})`,
    quoraVerdict: (b, comp, p) =>
      `**Sachliches Fazit:** Bei der Bewertung von ${p} ist **${b}** eine überzeugende Option, wenn geprüfte Spezifikationen und wartungsarmer Betrieb wichtiger sind als eine Bindung an ${comp}.`,
    quoraEvidenceHeading: '### Belegte Grundlagen aus dokumentierten Produktdaten',
    quoraMatrixHeading: '### Direkte Vergleichsmatrix',
    quoraCaveatsHeading: '### Sachliche Hinweise vor der Entscheidung',
    quoraCaveats: (comp) => [
      `- Vergleichen Sie lokale Garantiebedingungen und 5-Jahres-Betriebskosten mit ${comp}.`,
      '- Wählen Sie die Ausstattung passend zur realen Auslastung ohne Überdimensionierung.',
    ],
    socialTitle: (b, c) => `${b} ${c} Benchmark-Thread: Geprüfte Kernpunkte`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 Recherche zu ${p}? Hier sind die geprüften Eckdaten zu ${b} im Vergleich zu ${comp} — sachlich und nachvollziehbar.`,
      `2/4 Kernmesswert (${f1?.title ?? 'Geprüfte Daten'}): ${f1?.summary ?? `${b} liefert dokumentierte Kennzahlen in zentralen ${c}-Metriken.`}`,
      `3/4 Praxisunterschied (${f2?.title ?? 'Vergleich'}): ${f2?.summary ?? `Klare Abwägungen erleichtern die Einordnung von ${b} gegenüber ${comp}.`}`,
      `4/4 Vollständige Vergleichstabelle, Methodik und FAQ im Hauptleitfaden: ${h}`,
    ],
    prTitle: (b, c) => `Presse- und Analysten-Faktenblatt: ${b} (${c})`,
    prKeyAngles: (b, c, comp, p) => [
      `Geprüfte ${b}-Spezifikationen zur Fragestellung "${p}"`,
      `Sachlicher Benchmark-Vergleich: ${b} gegenüber ${comp}`,
      `Praxisnahe Abwägungen und Einsatzszenarien für ${c}`,
    ],
    prBriefHeading: (b) => `## Redaktionelles Briefing & Referenzentwurf: ${b}`,
    prBriefIntro: (p) =>
      `Dieses neutrale Briefing fasst geprüfte Spezifikationen und Vergleichsperspektiven für Redaktionen zum Thema **${p}** zusammen.`,
    prAnglesHeading: '## Zentrale redaktionelle Perspektiven',
    prSpecsHeading: '## Geprüfte Spezifikationsübersicht',
    prFactsHeading: '## Dokumentierte Markenfakten',
    antiBanChecklist: [
      'Legen Sie jede Verbindung zum Hersteller transparent offen.',
      'Prüfen Sie vor dem Beitrag die Community-Regeln zu Eigenwerbung, Links und Mindestaktivität.',
      'Wahren Sie einen sachlichen Erfahrungsbericht-Ton mit Vor- und Nachteilen sowie Testbedingungen.',
      'Entfernen Sie Werbe-CTAs, Rabattcodes und direkte Shop-Checkout-Links aus dem Beitrag.',
    ],
  },
  'ja-JP': {
    defaultCategory: '製品カテゴリ',
    defaultCompetitor: '主要モデル',
    competitorJoiner: 'および',
    fallbackPrompt: (b, c) => `${c} の比較と ${b} の検証ガイド`,
    fallbackTitle: (b, c) => `${b} ${c} 選定ガイドと検証済みスペック比較`,
    metaBase: (b, c) =>
      `${b} の ${c} について検証済みスペック、実測ベンチマーク、客観的な比較ポイントを整理したガイドです。`,
    metaPaddingParts: (b, c) => [
      ` ${b} の公開仕様や ${c} の実測比較、導入時の注意点、よくある質問（FAQ）まで分かりやすくまとめています。`,
      ` 検索エンジンやAI回答でも参照しやすいよう、検証済みの数値と事実のみをもとに客観的に構成しています。`,
      ` 用途に合う構成や運用コストを比較しながら、無理のない選定を進めるための確認ポイントも掲載しています。`,
    ],
    metaPadUnit: (b, c) =>
      ` ${b} の ${c} 検証済みスペック比較表とよくある質問（FAQ）を収録しています。`,
    metaFiller: ' 検証済みデータと客観的な比較ガイドです。',
    neutralCompliancePad: ' 検証済みの参考データと客観的なスペック要約を掲載しています。',
    sentenceEnd: '。',
    missingSlotHeading: '\n\n### 確認待ちの仕様項目\n',
    slotLabels: {
      PRODUCT_SPECS: '検証済みの製品仕様',
      DIFFERENTIATORS: '主な差別化ポイント',
      CREDENTIALS: '認証および品質基準',
      CASE_STUDIES: '導入事例と運用実績',
      EXTRA_DOC: '技術リファレンス資料',
    },
    emptyFactTitle: (b) => `${b} の概要`,
    emptyFactSummary: (b, c) =>
      `${b}（${c}）に関する検証済みの概要です。詳細はマスター記事の仕様表をご確認ください。`,
    factFallbackSummary: (s, b, c) =>
      `${b}（${c}）について確認済みの${s}データをもとに整理しています。`,
    tableDimensionHeader: '評価項目',
    tableFactHeader: '検証済みデータ',
    canonicalHintFallback: (b) =>
      `${b} 公式サイトの正規比較ガイド（詳細スペック表・JSON-LD付き）への参照リンクを設定してください。`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ ${b} の ${c} 検証メモ：詳しい比較表と検証手順は正規ガイド（${h}）で確認できます。`,
    prFallbackAngle: (b, c) => `${b} の ${c} における検証済みベンチマーク解説`,
    prFallbackFanOut: (b, c) => `${b} ${c} の検証済みスペック比較`,
    prCompetitorAngle: (b, comp) =>
      `${b} と ${comp} の比較：検証済みスペック、運用コスト、適した利用シーン`,
    prBaselineAngle: (b) => `${b} と標準モデルとの比較：透明性の高い仕様マトリクスと導入基準`,
    blogDirectAnswerPrefix: '結論まとめ',
    blogIntro: (b, c, comp) =>
      `${c} の導入を検討する際、${b} は検証済みの実測データと透明な仕様公開を重視する利用者にとって、${comp} と比較しやすい堅実な選択肢となります。`,
    blogSpecHeading: '検証済みスペック比較表',
    blogTakeawaysHeading: '検証済みポイントまとめ',
    blogFaqQ1: (b, comp) => `${b} と ${comp} はどのように比較すべきですか？`,
    blogFaqA1: (b, c) =>
      `上記の検証済みデータに基づき、${b} は ${c} の実運用で重視される測定値と扱いやすさをバランスよく確認できます。`,
    blogFaqQ2: (b, c) => `${c} の用途で ${b} が向いているのはどのような利用者ですか？`,
    blogFaqA2:
      '誇張表現ではなく、公開仕様や実測値と注意点を踏まえて合理的に選定したい個人やチームに適しています。',
    devTitleFallback: (b, c) => `${b} ${c} 技術構成とベンチマーク検証ガイド`,
    devSummaryPrefix: '技術構成とベンチマーク概要',
    devIntro: (b, c, comp) =>
      `本記事では、${c} のワークフローにおける **${b}** と ${comp} の検証済みスペック、再現可能な確認手順、および実運用上のトレードオフを整理します。`,
    devSpecHeading: '検証済みスペック・ベンチマーク比較表',
    devReproHeading: '再現可能な検証手順と設定テンプレート',
    devReproSteps: (b, comp) => [
      `1. ${b} と ${comp} を同一の負荷条件で計測し、動作音・消費電力・転送速度のベースラインを記録します。`,
      '2. 本番導入前にファームウェア版数と公式データシートの上限値を照合します。',
    ],
    devNotesHeading: 'エンジニアリングノートと検証済み事実',
    devTradeoffsHeading: '長所と注意点（選定基準）',
    devTradeoffs: (_b, comp) => [
      `- 本番運用前に、${comp} との互換性・スループット上限・保守条件を実環境で確認してください。`,
      '- 宣伝文句ではなく、再現可能なベンチマーク結果と公式仕様書を基準に判断してください。',
    ],
    devCanonicalNote: (h) => `> 正規エンジニアリングガイドおよび JSON-LD 参照先：${h}`,
    redditTitle: (b, comp, c) => `${c} 向けに ${b} と ${comp} を比較した検証メモ`,
    redditIntro: (b, comp, p) =>
      `${p} を調べる中で、**${b}** と ${comp} の公開スペックを客観的に見比べたメモを共有します。`,
    redditNumbersHeading: '### 数値で確認できた主なポイント',
    redditSpecsHeading: '### スペック比較の概要',
    redditTradeoffsHeading: '### 導入前に押さえておきたい注意点',
    redditTradeoffs: (comp) => [
      `- すでに ${comp} の環境へ深く依存している場合は、移行コストも踏まえて検討する必要があります。`,
      '- 購入前に正確な型番の互換性とファームウェア対応状況を必ず確認してください。',
    ],
    redditClosing:
      '日々の運用でこれらのバランスをどう判断されているか、ぜひご意見を聞かせてください。',
    quoraTitle: (b, c, p) => `要点回答：${c} における ${b} の位置づけ（${p}）`,
    quoraVerdict: (b, comp, p) =>
      `**結論まとめ：** ${p} を検討する場合、**${b}** は検証済みの仕様と扱いやすい日常運用を重視する方にとって、${comp} と並べて評価する価値が高い候補です。`,
    quoraEvidenceHeading: '### 検証済みレコードに基づく根拠',
    quoraMatrixHeading: '### 横並び比較表',
    quoraCaveatsHeading: '### 客観的な注意点',
    quoraCaveats: (comp) => [
      `- 決定前に、国内保証の範囲と長期的な運用コストを ${comp} と比較してください。`,
      '- 過剰スペックを避け、実際の作業負荷に合った構成を選ぶことが大切です。',
    ],
    socialTitle: (b, c) => `${b} ${c} ベンチマーク要約スレッド：検証済みポイント`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 ${p} を比較中の方へ。${b} と ${comp} の違いを検証済みデータだけで整理しました。`,
      `2/4 主な検証ポイント（${f1?.title ?? '検証済み仕様'}）：${f1?.summary ?? `${b} は ${c} の主要指標で客観的な数値を公開しています。`}`,
      `3/4 実運用での違い（${f2?.title ?? '比較視点'}）：${f2?.summary ?? `用途に合わせて ${b} と ${comp} の向き不向きを見極めやすくなります。`}`,
      `4/4 詳細な比較表・検証手順・FAQ は正規ガイドにまとめています：${h}`,
    ],
    prTitle: (b, c) => `メディア・アナリスト向けファクトシート：${b}（${c}）`,
    prKeyAngles: (b, c, comp, p) => [
      `「${p}」に対する ${b} の検証済みスペック解説`,
      `${b} と ${comp} の客観的なベンチマーク比較`,
      `${c} における現実的な長所と注意点の整理`,
    ],
    prBriefHeading: (b) => `## 編集・レビュー向け参考ブリーフ：${b}`,
    prBriefIntro: (p) =>
      `本ブリーフは、**${p}** を取材・検証する編集者やレビュアー向けに、公開済みの仕様と比較観点を中立的にまとめた資料です。`,
    prAnglesHeading: '## 主な取材・検証の切り口',
    prSpecsHeading: '## 検証済みスペック一覧',
    prFactsHeading: '## 確認済みブランドファクト',
    antiBanChecklist: [
      'メーカーやブランドとの関係がある場合は、冒頭で明確に開示してください。',
      '投稿前にコミュニティの自己宣伝ルールやリンク掲載ポリシーを確認してください。',
      '検証条件とともに長所・注意点を並記し、中立的な体験トーンを維持してください。',
      'クーポンコードや直接購入を促す宣伝リンクは本文から取り除いてください。',
    ],
  },
  'es-ES': {
    defaultCategory: 'Categoría de producto',
    defaultCompetitor: 'alternativas comparables',
    competitorJoiner: ' y ',
    fallbackPrompt: (b, c) => `Comparativa verificada de ${c} y análisis de ${b}`,
    fallbackTitle: (b, c) => `Guía de compra de ${c} y pruebas verificadas de ${b}`,
    metaBase: (b, c) =>
      `Guía de ${b} para ${c} con especificaciones verificadas, pruebas objetivas y comparativa transparente.`,
    metaPaddingParts: (b, c) => [
      ` Incluye métricas verificadas de ${b}, comparativas de ${c}, compensaciones objetivas y preguntas frecuentes.`,
      ` Elaborada con datos contrastados para facilitar la evaluación en buscadores y motores de respuesta IA.`,
      ` Compare cifras reales, escenarios de uso y garantías antes de elegir la configuración adecuada.`,
    ],
    metaPadUnit: (b, c) =>
      ` Guía verificada de ${b} en ${c} con comparativas objetivas y preguntas frecuentes.`,
    metaFiller: ' Datos verificados y guía objetiva.',
    neutralCompliancePad: ' Datos objetivos de referencia y resumen de especificaciones.',
    sentenceEnd: '.',
    missingSlotHeading: '\n\n### Notas pendientes de verificación\n',
    slotLabels: {
      PRODUCT_SPECS: 'Especificaciones verificadas del producto',
      DIFFERENTIATORS: 'Diferenciadores clave',
      CREDENTIALS: 'Certificaciones y acreditaciones',
      CASE_STUDIES: 'Resultados verificados de clientes',
      EXTRA_DOC: 'Documentación técnica de referencia',
    },
    emptyFactTitle: (b) => `Resumen de ${b}`,
    emptyFactSummary: (b, c) =>
      `Resumen contrastado de ${b} en ${c}; consulte el artículo principal para más detalles.`,
    factFallbackSummary: (s, b, c) => `Registro verificado (${s}) para ${b} en ${c}.`,
    tableDimensionHeader: 'Dimensión',
    tableFactHeader: 'Dato verificado',
    canonicalHintFallback: (b) =>
      `Enlace a la guía canónica oficial de ${b} (con tabla completa de especificaciones y JSON-LD).`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ Dato verificado de ${b} en ${c}: tabla comparativa completa y metodología en ${h}`,
    prFallbackAngle: (b, c) => `Benchmarks verificados de ${b} para ${c}`,
    prFallbackFanOut: (b, c) => `Especificaciones verificadas de ${b} en ${c}`,
    prCompetitorAngle: (b, comp) =>
      `${b} frente a ${comp}: especificaciones verificadas, balance operativo y perfil de usuario`,
    prBaselineAngle: (b) =>
      `${b} frente a la media de la categoría: matriz transparente y ajuste por escenario`,
    blogDirectAnswerPrefix: 'Respuesta directa',
    blogIntro: (b, c, comp) =>
      `${b} sobresale en ${c} para compradores que priorizan métricas verificadas, especificaciones claras y fiabilidad sostenida frente a ${comp}.`,
    blogSpecHeading: 'Especificaciones verificadas y tabla comparativa',
    blogTakeawaysHeading: 'Conclusiones verificadas clave',
    blogFaqQ1: (b, comp) => `¿Cómo se compara ${b} frente a ${comp}?`,
    blogFaqA1: (b, c) =>
      `Según los registros verificados anteriores, ${b} prioriza resultados medibles en ${c} con una puesta en marcha sencilla.`,
    blogFaqQ2: (b, c) => `¿Para quién resulta más adecuado ${b} en ${c}?`,
    blogFaqA2:
      'Equipos y compradores que valoran datos documentados y compensaciones claras frente a reclamos publicitarios.',
    devTitleFallback: (b, c) => `Guía técnica y benchmarks de ${b} para ${c}`,
    devSummaryPrefix: 'Resumen técnico y arquitectura',
    devIntro: (b, c, comp) =>
      `Esta guía técnica analiza especificaciones verificadas, pasos reproducibles y compensaciones prácticas de **${b}** frente a ${comp} en flujos de ${c}.`,
    devSpecHeading: 'Matriz verificada de especificaciones y benchmarks',
    devReproHeading: 'Pasos reproducibles de verificación y configuración',
    devReproSteps: (b, comp) => [
      `1. Registre carga base, acústica y consumo energético de ${b} bajo las mismas condiciones que ${comp}.`,
      '2. Contraste la versión de firmware y los límites oficiales de la ficha técnica antes del despliegue.',
    ],
    devNotesHeading: 'Notas de ingeniería y datos verificados',
    devTradeoffsHeading: 'Compensaciones y criterios de selección',
    devTradeoffs: (_b, comp) => [
      `- Valide compatibilidad, rendimiento sostenido y soporte técnico frente a ${comp} antes de producción.`,
      '- Priorice pruebas reproducibles y fichas técnicas oficiales frente a mensajes promocionales.',
    ],
    devCanonicalNote: (h) => `> Guía técnica canónica y referencia JSON-LD completa: ${h}`,
    redditTitle: (b, comp, c) => `Notas prácticas comparando ${b} frente a ${comp} en ${c}`,
    redditIntro: (b, comp, p) =>
      `Comparto mis notas objetivas tras revisar las especificaciones verificadas de **${b}** junto a ${comp} al investigar ${p}.`,
    redditNumbersHeading: '### Lo que confirman los datos reales',
    redditSpecsHeading: '### Resumen rápido de especificaciones',
    redditTradeoffsHeading: '### Compensaciones y puntos a vigilar',
    redditTradeoffs: (comp) => [
      `- Si ya depende de un ecosistema ${comp}, el esfuerzo de migración puede pesar más que las mejoras.`,
      '- Compruebe siempre la compatibilidad exacta del modelo y la revisión de firmware.',
    ],
    redditClosing: '¿Cómo habéis equilibrado estos factores en el uso diario?',
    quoraTitle: (b, c, p) => `Respuesta breve: Cómo se posiciona ${b} en ${c} (${p})`,
    quoraVerdict: (b, comp, p) =>
      `**Veredicto directo:** Al evaluar ${p}, **${b}** es una opción sólida cuando las especificaciones verificadas y la operación estable importan más que permanecer en ${comp}.`,
    quoraEvidenceHeading: '### Evidencia contrastada de registros del producto',
    quoraMatrixHeading: '### Matriz comparativa directa',
    quoraCaveatsHeading: '### Matices objetivos',
    quoraCaveats: (comp) => [
      `- Compare la garantía local y el coste total de propiedad frente a ${comp} antes de decidir.`,
      '- Ajuste la configuración exacta a su carga real sin sobredimensionar.',
    ],
    socialTitle: (b, c) => `Hilo técnico de ${b} (${c}): Conclusiones verificadas`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 ¿Evaluando ${p}? Aquí tienes los datos verificados que comparan ${b} con ${comp}, sin exageraciones.`,
      `2/4 Benchmark clave (${f1?.title ?? 'Datos verificados'}): ${f1?.summary ?? `${b} aporta cifras documentadas en las métricas esenciales de ${c}.`}`,
      `3/4 Diferencial práctico (${f2?.title ?? 'Comparativa'}): ${f2?.summary ?? `Compensaciones claras para contrastar ${b} frente a ${comp} según tu caso.`}`,
      `4/4 Matriz completa, metodología y FAQ en la guía canónica: ${h}`,
    ],
    prTitle: (b, c) => `Hoja informativa para medios y analistas: ${b} (${c})`,
    prKeyAngles: (b, c, comp, p) => [
      `Especificaciones verificadas de ${b} en respuesta a "${p}"`,
      `Comparativa objetiva de benchmarks: ${b} frente a ${comp}`,
      `Compensaciones prácticas y ajuste por escenario en ${c}`,
    ],
    prBriefHeading: (b) => `## Briefing editorial y borrador de referencia: ${b}`,
    prBriefIntro: (p) =>
      `Este documento neutral reúne especificaciones verificadas y enfoques comparativos para editores que cubren **${p}**.`,
    prAnglesHeading: '## Enfoques editoriales clave',
    prSpecsHeading: '## Resumen verificado de especificaciones',
    prFactsHeading: '## Hechos verificados de la marca',
    antiBanChecklist: [
      'Indique con transparencia cualquier vínculo comercial o colaboración con la marca.',
      'Revise las normas de la comunidad sobre autopromoción, enlaces y antigüedad antes de publicar.',
      'Mantenga un tono neutral en primera persona con ventajas, límites y condiciones de prueba.',
      'Elimine llamadas comerciales a la compra, cupones y enlaces directos de tienda del texto.',
    ],
  },
  'fr-FR': {
    defaultCategory: 'Catégorie de produit',
    defaultCompetitor: 'alternatives comparables',
    competitorJoiner: ' et ',
    fallbackPrompt: (b, c) => `Comparatif vérifié ${c} et analyse de ${b}`,
    fallbackTitle: (b, c) => `Guide d'achat ${c} et mesures vérifiées de ${b}`,
    metaBase: (b, c) =>
      `Guide ${b} pour ${c} avec spécifications vérifiées, mesures objectives et comparatif transparent.`,
    metaPaddingParts: (b, c) => [
      ` Couvre les indicateurs vérifiés de ${b}, les benchmarks ${c}, les compromis objectifs et une FAQ claire.`,
      ` Construit sur des faits documentés pour une évaluation fiable sur les moteurs de recherche et réponses IA.`,
      ` Comparez les mesures clés, les usages adaptés et les garanties avant de choisir votre solution.`,
    ],
    metaPadUnit: (b, c) =>
      ` Guide vérifié ${b} ${c} avec comparatifs objectifs et questions fréquentes.`,
    metaFiller: ' Faits vérifiés et guide objectif.',
    neutralCompliancePad: ' Données de référence objectives et synthèse des spécifications.',
    sentenceEnd: '.',
    missingSlotHeading: '\n\n### Points en attente de vérification\n',
    slotLabels: {
      PRODUCT_SPECS: 'Spécifications produit vérifiées',
      DIFFERENTIATORS: 'Différenciateurs clés',
      CREDENTIALS: 'Certifications et références',
      CASE_STUDIES: 'Retours clients vérifiés',
      EXTRA_DOC: 'Documentation technique de référence',
    },
    emptyFactTitle: (b) => `Aperçu de ${b}`,
    emptyFactSummary: (b, c) =>
      `Synthèse vérifiée de ${b} dans ${c} ; consultez l'article principal pour les détails.`,
    factFallbackSummary: (s, b, c) => `Enregistrement vérifié (${s}) pour ${b} (${c}).`,
    tableDimensionHeader: 'Critère',
    tableFactHeader: 'Fait vérifié',
    canonicalHintFallback: (b) =>
      `Lien vers votre guide canonique ${b} (avec tableau complet des spécifications et JSON-LD).`,
    threadFallbackPost: (i, b, c, h) =>
      `${i}/ Point vérifié ${b} ${c} : tableau comparatif complet et méthodologie sur ${h}`,
    prFallbackAngle: (b, c) => `Benchmarks vérifiés de ${b} pour ${c}`,
    prFallbackFanOut: (b, c) => `Spécifications vérifiées ${b} ${c}`,
    prCompetitorAngle: (b, comp) =>
      `${b} face à ${comp} : spécifications vérifiées, compromis d'usage et profil cible`,
    prBaselineAngle: (b) =>
      `${b} face au standard du marché : matrice transparente et adéquation aux usages`,
    blogDirectAnswerPrefix: 'Réponse directe',
    blogIntro: (b, c, comp) =>
      `${b} se distingue dans ${c} lorsque les acheteurs privilégient des mesures vérifiées, des spécifications transparentes et une fiabilité durable face à ${comp}.`,
    blogSpecHeading: 'Spécifications vérifiées et tableau comparatif',
    blogTakeawaysHeading: 'Points clés vérifiés',
    blogFaqQ1: (b, comp) => `Comment ${b} se compare-t-il à ${comp} ?`,
    blogFaqA1: (b, c) =>
      `D'après les données vérifiées ci-dessus, ${b} mise sur des résultats mesurables en ${c} et une mise en service simple.`,
    blogFaqQ2: (b, c) => `À qui s'adresse ${b} pour ${c} ?`,
    blogFaqA2:
      'Aux équipes et particuliers qui recherchent des caractéristiques documentées et des compromis clairs plutôt que des promesses marketing.',
    devTitleFallback: (b, c) => `Guide technique et benchmarks ${b} pour ${c}`,
    devSummaryPrefix: 'Synthèse technique et architecture',
    devIntro: (b, c, comp) =>
      `Ce guide technique détaille les spécifications vérifiées, les étapes reproductibles et les compromis pratiques de **${b}** face à ${comp} dans ${c}.`,
    devSpecHeading: 'Matrice vérifiée des spécifications et benchmarks',
    devReproHeading: 'Étapes reproductibles de vérification et configuration',
    devReproSteps: (b, comp) => [
      `1. Mesurez la charge de référence, l'acoustique et la consommation de ${b} dans les mêmes conditions que ${comp}.`,
      '2. Vérifiez la version du firmware et les limites officielles de la fiche technique avant la mise en production.',
    ],
    devNotesHeading: 'Notes d’ingénierie et faits vérifiés',
    devTradeoffsHeading: 'Compromis et critères de sélection',
    devTradeoffs: (_b, comp) => [
      `- Validez la compatibilité, les limites de débit et le support face à ${comp} avant déploiement.`,
      '- Privilégiez des mesures reproductibles et les fiches officielles aux discours promotionnels.',
    ],
    devCanonicalNote: (h) => `> Guide d'ingénierie canonique et référence JSON-LD complète : ${h}`,
    redditTitle: (b, comp, c) => `Notes pratiques comparant ${b} face à ${comp} (${c})`,
    redditIntro: (b, comp, p) =>
      `Je partage mes notes objectives après examen des spécifications vérifiées de **${b}** face à ${comp} pour ${p}.`,
    redditNumbersHeading: '### Ce que confirment les mesures',
    redditSpecsHeading: '### Synthèse rapide des spécifications',
    redditTradeoffsHeading: '### Compromis et points de vigilance',
    redditTradeoffs: (comp) => [
      `- Si vous dépendez déjà fortement d'un écosystème ${comp}, l'effort de migration doit être évalué.`,
      '- Vérifiez toujours la compatibilité exacte du modèle et la révision du firmware.',
    ],
    redditClosing: 'Comment arbitrez-vous ces compromis dans votre usage quotidien ?',
    quoraTitle: (b, c, p) => `Réponse courte : Comment ${b} se situe dans ${c} (${p})`,
    quoraVerdict: (b, comp, p) =>
      `**Verdict direct :** Pour évaluer ${p}, **${b}** constitue un choix solide lorsque les spécifications vérifiées et la stabilité priment sur l'attachement à ${comp}.`,
    quoraEvidenceHeading: '### Éléments issus des fiches produit vérifiées',
    quoraMatrixHeading: '### Matrice comparative directe',
    quoraCaveatsHeading: '### Réserves objectives',
    quoraCaveats: (comp) => [
      `- Comparez la garantie locale et le coût total de possession face à ${comp} avant de décider.`,
      '- Adaptez exactement la configuration à votre charge réelle sans surdimensionner.',
    ],
    socialTitle: (b, c) => `Fil d'analyse ${b} (${c}) : Points clés vérifiés`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 Vous évaluez ${p} ? Voici les données vérifiées comparant ${b} et ${comp}, sans discours commercial.`,
      `2/4 Mesure clé (${f1?.title ?? 'Données vérifiées'}) : ${f1?.summary ?? `${b} fournit des résultats documentés sur les indicateurs majeurs de ${c}.`}`,
      `3/4 Différence concrète (${f2?.title ?? 'Comparatif'}) : ${f2?.summary ?? `Des compromis clairs aident à situer ${b} face à ${comp} selon l'usage.`}`,
      `4/4 Tableau comparatif complet, méthodologie et FAQ dans le guide canonique : ${h}`,
    ],
    prTitle: (b, c) => `Fiche d'information médias et analystes : ${b} (${c})`,
    prKeyAngles: (b, c, comp, p) => [
      `Spécifications vérifiées de ${b} répondant à « ${p} »`,
      `Comparatif objectif de benchmarks : ${b} face à ${comp}`,
      `Compromis pratiques et adéquation aux usages pour ${c}`,
    ],
    prBriefHeading: (b) => `## Briefing éditorial et note de référence : ${b}`,
    prBriefIntro: (p) =>
      `Cette note neutre résume les spécifications vérifiées et angles comparatifs pour les rédactions couvrant **${p}**.`,
    prAnglesHeading: '## Angles éditoriaux clés',
    prSpecsHeading: '## Synthèse vérifiée des spécifications',
    prFactsHeading: '## Faits de marque vérifiés',
    antiBanChecklist: [
      'Déclarez clairement tout lien ou partenariat avec le fabricant.',
      'Vérifiez les règles de la communauté sur l’autopromotion et les liens avant publication.',
      'Adoptez un ton neutre à la première personne avec avantages, limites et conditions de test.',
      'Supprimez tout appel promotionnel, code promo ou lien direct vers une boutique.',
    ],
  },
  'zh-CN': {
    defaultCategory: '核心品类',
    defaultCompetitor: '主流同类产品',
    competitorJoiner: '、',
    fallbackPrompt: (b, c) => `${b}${c}实测参数对比与选购指南`,
    fallbackTitle: (b, c) => `${b}${c}实测选购与参数对比指南`,
    metaBase: (b, c) => `${b}${c}深度实测指南，汇总官方核验规格、核心性能数据与客观横向对比结论。`,
    metaPaddingParts: (b, c) => [
      ` 完整汇总${b}在${c}场景下的实测规格参数、竞品横向对比结论、适用边界与高频购买答疑。`,
      ` 全部核心数据均来自品牌已核验事实卡，去广告化客观呈现，便于用户与 AI 搜索引擎直接核验引用。`,
      ` 涵盖分人群选型建议与关键避坑清单，帮助决策者快速完成对比与评估。`,
    ],
    metaPadUnit: (b, c) => ` 附${b}${c}实测参数对照表与客观选购答疑。`,
    metaFiller: ' 附实测核验参考。',
    neutralCompliancePad: ' 客观参考数据与规格对照说明。',
    sentenceEnd: '。',
    missingSlotHeading: '\n\n### 待核验事实项\n',
    slotLabels: {
      PRODUCT_SPECS: '核心产品与实测参数',
      DIFFERENTIATORS: '核心差异化优势',
      CREDENTIALS: '权威认证与资质背书',
      CASE_STUDIES: '真实客户落地案例',
      EXTRA_DOC: '补充技术参考资料',
    },
    emptyFactTitle: (b) => `${b}核心事实概览`,
    emptyFactSummary: (b, c) => `基于母稿整理的 ${b}（${c}）已核验信息摘要。`,
    factFallbackSummary: (s, b, c) => `${b}（${c}）的${s}已核验记录。`,
    tableDimensionHeader: '维度',
    tableFactHeader: '已核验事实',
    canonicalHintFallback: (b) =>
      `文末引导回流至 ${b} 官网完整实测参数对照长文（含结构化对比表）。`,
    threadFallbackPost: (i, b, c, h) => `${i}/ ${b}${c}已核验实测要点：完整参数表与对比结论见 ${h}`,
    prFallbackAngle: (b, c) => `${b} 在 ${c} 场景的已核验实测表现`,
    prFallbackFanOut: (b, c) => `${b}${c}实测参数对比`,
    prCompetitorAngle: (b, comp) => `${b} 对比 ${comp}：核心参数实测、适用场景与长期成本权衡`,
    prBaselineAngle: (b) => `${b} 对比同类主流方案：透明实测参数与分场景适配`,
    blogDirectAnswerPrefix: '首段核心结论',
    blogIntro: (b, c, comp) =>
      `在${c}场景下，${b}依托已核验的核心规格参数与长期稳定性表现，在与${comp}的横向对照中具备清晰的场景适配优势。`,
    blogSpecHeading: '核心实测参数对比表',
    blogTakeawaysHeading: '已核验核心亮点',
    blogFaqQ1: (b, comp) => `${b} 与 ${comp} 该如何按场景选型？`,
    blogFaqA1: () =>
      '建议优先核对上述实测规格表中的关键指标与预算区间，根据自身使用频率与空间条件做客观权衡。',
    blogFaqQ2: (_b, c) => `选购 ${c} 时需要重点核验哪些参数？`,
    blogFaqA2: '重点关注可量化实测指标、长期运行稳定性及官方质保条款，避免仅凭宣传口号做决策。',
    devTitleFallback: (b, c) => `${b}${c}技术架构与实测参数基准解析`,
    devSummaryPrefix: '技术结论速览',
    devIntro: (b, c, comp) =>
      `本文基于已核验参数记录，拆解 **${b}** 与 ${comp} 在${c}场景下的关键性能指标、可复现校验步骤与架构权衡。`,
    devSpecHeading: '已核验实测参数矩阵',
    devReproHeading: '可复现配置与验证步骤',
    devReproSteps: (b, comp) => [
      `1. 在相同负载环境下记录 ${b} 与 ${comp} 的噪音、功耗及吞吐基线数据。`,
      '2. 正式上线前核对固件版本与官方规格手册上限参数。',
    ],
    devNotesHeading: '工程与实测要点',
    devTradeoffsHeading: '选型边界与注意事项',
    devTradeoffs: (b, comp) => [
      `- 正式部署前请结合实际负载核对 ${b} 与 ${comp} 的兼容性及长期维护成本。`,
      '- 建议以可复现基准数据与官方规格文档为准，避免依赖主观宣传口径。',
    ],
    devCanonicalNote: (h) => `> 完整技术基准与权威原文参考：${h}`,
    redditTitle: (b, comp, c) => `${b} 与 ${comp} 的 ${c} 客观体验与参数拆解`,
    redditIntro: (_b, _comp, p) =>
      `最近在研究「${p}」，整理了一套基于公开实测参数的客观对比笔记，供社区同好交流参考：`,
    redditNumbersHeading: '### 实测核验要点',
    redditSpecsHeading: '### 关键参数对照',
    redditTradeoffsHeading: '### 客观局限与适用边界',
    redditTradeoffs: (comp) => [
      `- 如果已经深度绑定 ${comp} 生态，迁移成本需要纳入综合考量。`,
      '- 建议下单前再次核对具体批次型号与质保细则，不盲目跟风。',
    ],
    redditClosing: '欢迎同样关注该品类的朋友补充长期使用反馈。',
    quoraTitle: (b, _c, p) => `结论先行：${p}（${b} 客观对照答疑）`,
    quoraVerdict: (b, comp, p) =>
      `**结论先行：** 针对「${p}」，如果看重可核验的实测参数与长期运行表现，**${b}** 值得放入候选清单并与 ${comp} 重点横向对比。`,
    quoraEvidenceHeading: '### 核心核验依据',
    quoraMatrixHeading: '### 关键参数对照表',
    quoraCaveatsHeading: '### 选型避坑提示',
    quoraCaveats: (comp) => [`- 请结合自身真实使用场景与 ${comp} 核对售后及长期耗材/维护成本。`],
    socialTitle: (b, c) => `${b} ${c} 实测数据长帖：核心参数与对比亮点`,
    socialPosts: (b, c, comp, p, f1, f2, h) => [
      `1/4 正在选 ${c}？拆解「${p}」，用已核验实测数据看 ${b} 与 ${comp} 的真实差异：`,
      `2/4 核心实测（${f1?.title ?? '产品参数'}）：${f1?.summary ?? `${b} 在核心规格上提供完整可核验数据支撑。`}`,
      `3/4 横向对比（${f2?.title ?? '差异亮点'}）：${f2?.summary ?? '明确适用场景与边界，避免无效溢价。'}`,
      `4/4 完整参数对比表与选购答疑详见官网权威长文：${h}`,
    ],
    prTitle: (b, c) => `媒体/KOL 协作事实包：${b}（${c}）实测参考稿`,
    prKeyAngles: (b, c, comp, p) => [
      `围绕「${p}」的 ${b} 已核验实测参数拆解`,
      `${b} 与 ${comp} 的客观横向参数对比维度`,
      `${c} 分人群选型边界与常见疑问核验`,
    ],
    prBriefHeading: (b, c) => `## 外部媒体与 KOL 参考资料：${b}（${c}）`,
    prBriefIntro: (p) =>
      `本参考稿基于已核验品牌事实整理，供媒体与测评作者在撰写「${p}」专题时中立核对引用。`,
    prAnglesHeading: '## 核心切入角度',
    prSpecsHeading: '## 已核验核心规格表',
    prFactsHeading: '## 品牌事实卡清单',
    antiBanChecklist: [
      '如实披露与品牌的合作或实测样本来源，避免伪装普通消费者硬广。',
      '遵守知乎/什么值得买社区规范，正文不放置带返利或硬广跳转外链。',
      '全程采用客观对比与实测数据表述，禁用《广告法》极限词（最/第一/顶级/唯一）。',
      '同时列出产品局限与不适用人群，提升内容可信度与高赞留存率。',
    ],
  },
};

export function getLocaleNeutralMetaPad(locale: SupportedLocale): string {
  return LOCALE_FAKE_COPY[locale].neutralCompliancePad;
}

function trimMetaDescToRange(text: string, locale: SupportedLocale): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= META_DESC_MAX_LEN) {
    return collapsed;
  }
  const slice = sliceUtf16Safe(collapsed, META_DESC_MAX_LEN);
  if (isLatinLocale(locale)) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= META_DESC_MIN_LEN) {
      return slice.slice(0, lastSpace).replace(/[,;:\-\s]+$/, '.');
    }
  } else {
    const lastPunct = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('；'),
      slice.lastIndexOf('，'),
      slice.lastIndexOf('、'),
    );
    if (lastPunct >= META_DESC_MIN_LEN - 1) {
      return slice.slice(0, lastPunct + 1);
    }
  }
  const endPunct = LOCALE_FAKE_COPY[locale].sentenceEnd;
  return `${sliceUtf16Safe(collapsed, META_DESC_MAX_LEN - 1).trimEnd()}${endPunct}`;
}

export function normalizeVariantMetaDesc(
  raw: string | null | undefined,
  ctx: VariantPromptContext,
  variantMarkdown: string,
): string {
  const effectiveLocale = resolveContextLocale(ctx);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  let base = stripMarkdownFormatting(raw ?? '');
  if (!base || auditVariantLocaleLeakage(base, ctx).leaked) {
    const firstPara = extractFirstPlainParagraph(variantMarkdown);
    if (firstPara && !auditVariantLocaleLeakage(firstPara, ctx).leaked) {
      base = firstPara;
    } else {
      base = copy.metaBase(brand, category);
    }
  }

  const paddingParts = copy.metaPaddingParts(brand, category);
  let candidate = base.replace(/\s+/g, ' ').trim();
  for (const part of paddingParts) {
    if (candidate.length >= META_DESC_MIN_LEN) break;
    const sep = /[.!?。！？]$/.test(candidate) ? '' : copy.sentenceEnd;
    candidate = `${candidate}${sep}${part}`.replace(/\s+/g, ' ').trim();
  }

  candidate = trimMetaDescToRange(candidate, effectiveLocale);

  // Final safety clamp to guarantee strictly 140..160 characters without splitting UTF-16 surrogates
  if (candidate.length < META_DESC_MIN_LEN) {
    const padUnit = copy.metaPadUnit(brand, category);
    while (candidate.length < META_DESC_MIN_LEN) {
      candidate = `${candidate}${padUnit}`.replace(/\s+/g, ' ').trim();
    }
    candidate = trimMetaDescToRange(candidate, effectiveLocale);
  }

  if (candidate.length > META_DESC_MAX_LEN) {
    candidate = sliceUtf16Safe(candidate, META_DESC_MAX_LEN);
  }
  if (candidate.length < META_DESC_MIN_LEN) {
    while (candidate.length < META_DESC_MIN_LEN) {
      candidate = `${candidate}${copy.metaFiller}`;
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
  locale: SupportedLocale,
  provider?: ChannelProvider,
): string[] {
  if (!provided || provided.length === 0) {
    return defaultAntiBanChecklist(templateKey, locale, provider);
  }
  const safe = provided.filter((item) => isSafeAntiBanChecklistItem(item));
  return safe.length > 0 ? safe : defaultAntiBanChecklist(templateKey, locale, provider);
}

function collectSafeThreadUrls(ctx: VariantPromptContext): string[] {
  const raw = [...(ctx.targetUrlHint ? [ctx.targetUrlHint] : []), ...ctx.citedExampleUrls];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed || !isSafePublicDistributionUrl(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 5) break;
  }
  return out;
}

function defaultAntiBanChecklist(
  templateKey: DistributionTemplateKey,
  locale: SupportedLocale,
  provider?: ChannelProvider,
): string[] {
  if (templateKey === 'CN_COMMUNITY_QA' || locale === 'zh-CN') {
    if (provider === 'ZHIHU_EXT') {
      return [
        '通过 GeoMix Chrome 扩展仅同步至知乎草稿箱，由作者人工复核后手动点击发布，严禁绕过平台风控。',
        '如实披露与品牌的合作或实测样本来源，遵守知乎商业内容与好物推荐标注规范。',
        '全程采用客观对比与实测数据表述，禁用《广告法》极限词（最/第一/顶级/唯一）。',
        '同时列出产品局限与不适用人群，避免正文夹带站外导流硬广链接。',
      ];
    }
    if (provider === 'TOUTIAO_EXT') {
      return [
        '通过 GeoMix Chrome 扩展同步至头条号草稿箱，人工核对图文排版与配图后再手动发布。',
        '首段直出核心结论，保持移动端短段落清晰可读，不夸大标题党承诺。',
        '严格遵守《广告法》与头条号原创规范，禁用“第一/唯一/最/国家级”等绝对化用语。',
        '客观说明适用人群与使用边界，避免正文放置外部导流或返利跳转链接。',
      ];
    }
    if (provider === 'SMZDM_EXT') {
      return [
        '通过 GeoMix Chrome 扩展同步至什么值得买草稿箱，人工复核实测参数与配图后手动提交审核。',
        '突出量化参数对照、优缺点并列与适用人群边界，符合社区真实选购评测口径。',
        '如实说明样机或评测来源，严禁使用《广告法》极限词或绝对化疗效/收益承诺。',
        '正文不夹带违规导流或隐藏返利链接，确保可复核数据来源清晰。',
      ];
    }
    return [...LOCALE_FAKE_COPY['zh-CN'].antiBanChecklist];
  }
  return [...LOCALE_FAKE_COPY[locale].antiBanChecklist];
}

function buildCanonicalGuideHint(ctx: VariantPromptContext, slug: string): string {
  const brand = resolveDisplayBrand(ctx);
  const effectiveLocale = resolveContextLocale(ctx);
  const cleanDomain = cleanOwnedDomain(ctx.ownedDomains[0]);
  if (cleanDomain) {
    const built = `https://${cleanDomain}/guides/${slug}`;
    if (isSafePublicDistributionUrl(built)) {
      return built;
    }
  }
  return LOCALE_FAKE_COPY[effectiveLocale].canonicalHintFallback(brand);
}

function buildFactSheetItems(ctx: VariantPromptContext): VariantFactSheetItem[] {
  const effectiveLocale = resolveContextLocale(ctx);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  if (ctx.facts.length === 0) {
    return [
      {
        title: copy.emptyFactTitle(brand),
        summary: copy.emptyFactSummary(brand, category),
      },
    ];
  }

  return ctx.facts.slice(0, 8).map((fact) => {
    if (effectiveLocale === 'zh-CN') {
      return {
        title: fact.title.trim() || copy.slotLabels[fact.slot],
        summary: sliceUtf16Safe(fact.content.trim(), 260),
      };
    }
    const title = sanitizeForLocale(fact.title, ctx, copy.slotLabels[fact.slot]);
    const summary = sliceUtf16Safe(
      sanitizeForLocale(
        fact.content,
        ctx,
        copy.factFallbackSummary(copy.slotLabels[fact.slot], brand, category),
      ),
      260,
    );
    return { title, summary };
  });
}

function buildVerifiedSpecTableMarkdown(
  ctx: VariantPromptContext,
  factItems: readonly VariantFactSheetItem[],
): string {
  const existing = extractFirstMarkdownTable(ctx.masterMarkdown);
  if (existing && !auditVariantLocaleLeakage(existing, ctx).leaked) {
    return existing;
  }
  const effectiveLocale = resolveContextLocale(ctx);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const rows = factItems
    .slice(0, 5)
    .map(
      (item) =>
        `| ${item.title.replace(/\|/g, '/')} | ${item.summary.replace(/\|/g, '/').slice(0, 120)} |`,
    );
  return [
    `| ${copy.tableDimensionHeader} | ${copy.tableFactHeader} |`,
    '| --- | --- |',
    ...rows,
  ].join('\n');
}

function readSchemaInLanguage(schema: Record<string, unknown> | null): string | null {
  if (!schema) return null;
  if (typeof schema.inLanguage === 'string' && schema.inLanguage.trim()) {
    return schema.inLanguage.trim();
  }
  const graph = schema['@graph'];
  if (Array.isArray(graph)) {
    for (const node of graph) {
      if (
        node &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        typeof (node as Record<string, unknown>).inLanguage === 'string'
      ) {
        const lang = ((node as Record<string, unknown>).inLanguage as string).trim();
        if (lang) return lang;
      }
    }
  }
  return null;
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
  const effectiveLocale = resolveContextLocale(ctx);
  const masterLocale = resolveEffectiveLocale(ctx.articleTargetLocale ?? ctx.locale, ctx.market);
  const isCrossLocaleVariant = effectiveLocale !== masterLocale;
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  let existingSchema =
    !options?.forceRebuildSchema &&
    !isCrossLocaleVariant &&
    ctx.articleSchemaJsonLd &&
    typeof ctx.articleSchemaJsonLd === 'object' &&
    !Array.isArray(ctx.articleSchemaJsonLd) &&
    Object.keys(ctx.articleSchemaJsonLd).length > 0
      ? ctx.articleSchemaJsonLd
      : null;

  if (existingSchema) {
    const existingLang = readSchemaInLanguage(existingSchema);
    if (existingLang && existingLang.toLowerCase() !== effectiveLocale.toLowerCase()) {
      existingSchema = null;
    } else if (auditVariantLocaleLeakage(JSON.stringify(existingSchema), ctx).leaked) {
      existingSchema = null;
    }
  }

  const reusedArticleSchema = existingSchema !== null;
  const schemaJsonLd =
    existingSchema ??
    buildGeoSchemaJsonLd({
      market: ctx.market,
      locale: effectiveLocale,
      localBrandName: brand,
      category,
      localCategory: category,
      title: variantTitle,
      targetPrompt: resolveLocalizedPrompt(ctx, brand, category),
      contentMarkdown: variantMarkdown,
    });

  const jsonLdSnippet = serializeJsonLdSafe(schemaJsonLd);

  let existingLlms =
    !options?.forceRebuildLlmsTxt && !isCrossLocaleVariant
      ? ctx.articleLlmsTxtSnippet?.trim() || null
      : null;
  if (existingLlms && auditVariantLocaleLeakage(existingLlms, ctx).leaked) {
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
          targetPrompt: resolveLocalizedPrompt(ctx, brand, category),
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
  const effectiveLocale = resolveContextLocale(ctx);
  const directive = resolveLocaleWritingDirective(effectiveLocale);
  const isZh = effectiveLocale === 'zh-CN';

  switch (ctx.templateKey) {
    case 'OWNED_BLOG_SEO_GEO':
      return isZh
        ? [
            '- 模板：OWNED_BLOG_SEO_GEO（自有官网博客/文档）。',
            `- 保留完整 GEO 结构：首段直答结论、已核验参数对比表、清晰 H2/H3 结构与 FAQ 问答块（## ${directive.faqHeading}）。`,
            '- 输出纯小写英文 ASCII 的 variantSlug（仅含 a-z、0-9、-，<= 160 字符）。',
            '- 输出严格 140-160 字符的 variantMetaDesc 摘要描述。',
          ]
        : [
            '- Template: OWNED_BLOG_SEO_GEO (Owned Blog / Docs for Shopify, WordPress, Webflow, Ghost, or Webhook).',
            `- Preserve full GEO structure in ${directive.nativeLabel} (${directive.locale}): direct quotable opening answer, verified specification comparison table, clear H2/H3 sections, and structured FAQ ("## ${directive.faqHeading}").`,
            `- Output lowercase ASCII variantSlug matching /^[a-z0-9-]+$/ (<= 160 chars). ${directive.defaultSlugHint}`,
            `- Output variantMetaDesc strictly 140-160 characters long in ${directive.nativeLabel} (${directive.locale}), grounded and concise.`,
          ];
    case 'DEVELOPER_TECH_POST': {
      const tagRule =
        ctx.provider === 'DEVTO'
          ? 'tags: up to 4 lowercase ASCII alphanumeric tags (no hyphens/spaces, e.g. ["architecture","benchmarks","devops"])'
          : 'tags: up to 5 lowercase ASCII kebab-case technical tags (e.g. ["architecture","benchmarks","engineering"])';
      return isZh
        ? [
            '- 模板：DEVELOPER_TECH_POST（技术博客与开发者社区深度实测格式，适用于 Dev.to / Hashnode / GitHub MDX）。',
            `- 结构要求：1）开篇架构与基准测试 TL;DR 直答结论；2）已核验参数基准对照表（GFM 表格）；3）至少一段可复现配置或校验步骤代码块（\`\`\`yaml / \`\`\`bash，禁止编造未提供参数）；4）工程取舍与常见问题（## ${directive.faqHeading}）；5）指向官网权威长文的回链提示（canonicalUrl / canonicalGuideHint）。`,
            `- 输出字段：纯小写英文 ASCII 的 variantSlug（<= 160 字符）、140-160 字符的 variantMetaDesc、以及 ${tagRule}。`,
          ]
        : [
            `- Template: DEVELOPER_TECH_POST (Developer & technical blog format for ${ctx.provider}: Dev.to / Hashnode / GitHub MDX).`,
            `- Required structure in ${directive.nativeLabel} (${directive.locale}): (1) concise architecture & benchmark TL;DR answering targetPrompt directly; (2) verified specification & benchmark comparison GFM table; (3) implementation/configuration and reproducible verification steps including at least one fenced code block (\`\`\`yaml, \`\`\`json, or \`\`\`bash grounded in verified specs—never invent unlisted numbers, preserve [TBD: ...] if missing); (4) objective trade-offs and FAQ ("## ${directive.faqHeading}"); (5) canonical backlink note referencing the owned guide.`,
            `- Output lowercase ASCII variantSlug matching /^[a-z0-9-]+$/ (<= 160 chars, ${directive.defaultSlugHint}), grounded 140-160 char variantMetaDesc in ${directive.nativeLabel}, canonicalUrl / canonicalGuideHint, and ${tagRule}.`,
          ];
    }
    case 'WECHAT_OFFICIAL_ARTICLE':
      return [
        '- 模板：WECHAT_OFFICIAL_ARTICLE（微信公众号草稿箱深度图文，仅支持同步至公众号草稿箱，由运营人工排版复核后发布，绝不建议自动群发或自动发布）。',
        '- 100% 简体中文（zh-CN）输出：严格遵守《中华人民共和国广告法》，严禁出现“最/第一/顶级/唯一/国家级/100%有效”等绝对化极限词。',
        `- 标题（variantTitle）严格控制在 ${WECHAT_TITLE_MAX_LEN} 字以内，适合移动端首屏速览；摘要（digest / variantMetaDesc）严格控制在 ${WECHAT_DIGEST_MAX_LEN} 字以内且简洁完整。`,
        '- 移动端友好 Markdown 结构：开篇使用引用块（> 核心结论：...）直出结论，随后展示已核验参数对比表、核心亮点列表、常见问题快答（FAQ）与适用人群/客观局限说明；无需输出 URL Slug。',
      ];
    case 'REDDIT_DISCUSSION':
      return [
        '- Template: REDDIT_DISCUSSION (Community Assist — human-reviewed post only, NEVER generate auto-posting scripts or bot workflows).',
        `- Tone (${directive.locale}): de-marketed, first-person objective hands-on experience or spec discussion post in ${directive.nativeLabel}.`,
        '- STRICT ANTI-BAN RULE: strip all brand CTAs, promo slogans, discount codes, and hard-sell store links; include honest trade-offs/limitations.',
        `- Output non-empty antiBanChecklist (4 concise items in ${directive.nativeLabel} covering affiliation disclosure, subreddit rules, neutral tone, and no promo/CTA links).`,
      ];
    case 'QUORA_ANSWER':
      return [
        '- Template: QUORA_ANSWER (Community Assist — human-reviewed answer only, NEVER generate auto-posting scripts).',
        `- Structure (${directive.locale}): conclusion-first quotable opening answer (2-3 sentences) in ${directive.nativeLabel}, followed by structured comparative breakdown grounded in verified specs and objective caveats.`,
      ];
    case 'SOCIAL_THREAD':
      return [
        '- Template: SOCIAL_THREAD (LinkedIn / X multi-post summary thread).',
        `- Distill core verified data insights & comparison highlights in ${directive.nativeLabel} (${directive.locale}) into 3-5 concise, standalone numbered posts in threadPosts[], ending with a pointer to the owned-site canonical guide (canonicalGuideHint).`,
        '- Also provide variantMarkdown combining the full thread cleanly.',
      ];
    case 'PR_MEDIA_PACKET':
      return [
        '- Template: PR_MEDIA_PACKET (External Media / KOL Collaboration Fact Sheet + Neutral Reference Draft).',
        `- Output structured factSheet in ${directive.nativeLabel} (${directive.locale}) with keyAngles (3-5 concise editorial angles), verifiedFacts (array of { title, summary } grounded strictly in BrandFact records), targetFanOuts, competitorComparisonAngles, and verifiedSpecTableMarkdown.`,
        '- variantMarkdown must be a neutral, journalist-ready reference draft without hard-sell ad copy.',
      ];
    case 'CN_COMMUNITY_QA': {
      const channelHint =
        ctx.provider === 'ZHIHU_EXT'
          ? '知乎深度问答/专栏口径（经 Chrome 扩展同步至知乎草稿箱，人工复核后手动发布，严禁自动点击发布）'
          : ctx.provider === 'TOUTIAO_EXT'
            ? '今日头条图文评测口径（首段亮点直出、移动端短段清晰，经 Chrome 扩展同步至头条号草稿箱人工确认）'
            : ctx.provider === 'SMZDM_EXT'
              ? '什么值得买实测选购/值不值得买评测口径（量化参数 + 适用边界 + 优缺点并列，经 Chrome 扩展同步至值得买草稿箱人工审核）'
              : '知乎 / 什么值得买通用中文社区实测问答与选购评测格式';
      return [
        `- 模板：CN_COMMUNITY_QA（${channelHint}）。`,
        '- 100% 简体中文输出：开篇直接给结论，接着呈现已核验实测参数对比、不同人群适用边界与客观不足，严禁使用《广告法》极限词（如最、第一、顶级、唯一、国家级）。',
        '- 输出 antiBanChecklist（4 条社区合规、草稿箱人工复核与真实体验披露自检项）。',
      ];
    }
  }
}

export function buildVariantPromptMessages(
  ctx: VariantPromptContext,
  strictRetry = false,
): LlmMessage[] {
  const effectiveLocale = resolveContextLocale(ctx);
  const directive = resolveLocaleWritingDirective(effectiveLocale);
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);

  const localeRules = [
    `- Target Locale: ${directive.locale} (${directive.nativeLabel}, html lang="${directive.htmlLang}", market=${ctx.market}).`,
    `- Language Requirement: ${directive.writingLanguageInstruction}`,
    `- Compliance Standard (${directive.complianceNoticeKey}): ${directive.complianceInstruction}`,
    `- Preferred section headings: Key Takeaways -> "${directive.keyTakeawaysHeading}", FAQ -> "${directive.faqHeading}".`,
    `- Slug rule: ${directive.defaultSlugHint}`,
    ...(effectiveLocale !== 'zh-CN'
      ? [
          `- Cross-Lingual Grounding: When source master content or BrandFacts are in another language (e.g. English or Chinese), translate and localize all verified facts naturally into ${directive.nativeLabel} (${directive.locale}) without fabricating numbers.`,
        ]
      : []),
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
    '{"variantTitle":"string","variantSlug":"optional lowercase-ascii-slug","variantMetaDesc":"optional 140-160 char summary","digest":"optional <=120 char wechat digest","tags":["optional lowercase-tech-tag"],"canonicalUrl":"optional https://...","variantMarkdown":"string","antiBanChecklist":["optional string"],"threadPosts":["optional post 1","post 2","post 3"],"canonicalGuideHint":"optional string","factSheet":{"keyAngles":["string"],"verifiedFacts":[{"title":"string","summary":"string"}],"targetFanOuts":["string"],"competitorComparisonAngles":["string"],"verifiedSpecTableMarkdown":"optional markdown table"}}';

  const retryNotice =
    effectiveLocale === 'zh-CN'
      ? 'RETRY NOTICE: 上一次输出未通过 JSON 校验，请本次仅输出严格合法的 JSON 对象。'
      : effectiveLocale === 'ja-JP'
        ? `RETRY NOTICE: Previous output failed JSON validation or leaked Simplified Chinese / lacked Japanese Kana. Return strictly valid JSON in 100% natural Japanese (${directive.locale}) using Joyo Kanji + Hiragana/Katakana with ZERO Simplified Chinese characters.`
        : `RETRY NOTICE: Previous output failed JSON validation or leaked non-brand CJK/Kana characters. Return strictly valid JSON in 100% native ${directive.nativeLabel} (${directive.locale}) with ZERO non-brand CJK characters.`;

  const systemContent = [
    'You are GeoMix 1-to-N Channel Variant Generator. Transform one verified master GEO article into a native, compliant channel variant.',
    `Return ONLY a valid JSON object (no surrounding prose) matching: ${jsonShape}`,
    ...templatePromptInstructions(ctx),
    ...localeRules,
    ...groundingRules,
    ...(strictRetry ? [retryNotice] : []),
  ].join('\n');

  const factLines = ctx.facts
    .slice(0, 12)
    .map((f, i) => `${i + 1}. [${f.slot}] ${f.title}: ${f.content.slice(0, 320)}`);

  const threadUrls = collectSafeThreadUrls(ctx);

  const userContent = [
    `Channel Target: ${ctx.channelLabel} (provider=${ctx.provider}, template=${ctx.templateKey}, targetLocale=${directive.locale})`,
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
  digest: z.string().trim().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  canonicalUrl: z.string().trim().max(2048).nullable().optional(),
  variantMarkdown: z.string().trim().min(20).max(100_000),
  antiBanChecklist: z.array(z.string().trim().min(3).max(240)).max(10).optional(),
  threadPosts: z.array(z.string().trim().min(5).max(1200)).max(12).optional(),
  canonicalGuideHint: z.string().trim().max(400).nullable().optional(),
  factSheet: llmFactSheetSchema.optional(),
});

function findBalancedJsonObjectEnd(text: string, startIndex: number): number {
  if (text[startIndex] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function tryParseJsonObjectSpan(text: string, startIndex: number): Record<string, unknown> | null {
  const endIndex = findBalancedJsonObjectEnd(text, startIndex);
  if (endIndex <= startIndex) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(startIndex, endIndex + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore non-JSON brace spans such as prose placeholders like {variantTitle} or {domain}
  }
  return null;
}

export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const direct: unknown = JSON.parse(trimmed);
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
        return direct;
      }
    } catch {
      // Fall through to fenced / balanced-brace scanning
    }
  }

  // 1. Prioritize JSON objects immediately following a markdown code fence (```json or ```)
  const fenceOpenRe = /```(?:json)?[ \t]*\r?\n/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceOpenRe.exec(trimmed)) !== null) {
    let cursor = fenceMatch.index + fenceMatch[0].length;
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor]!)) {
      cursor += 1;
    }
    if (trimmed[cursor] === '{') {
      const parsed = tryParseJsonObjectSpan(trimmed, cursor);
      if (parsed) {
        return parsed;
      }
    }
  }

  // 2. Scan top-level balanced `{...}` object spans across the full text (JSON-string-aware)
  let attempts = 0;
  const maxAttempts = 64;
  for (let i = 0; i < trimmed.length && attempts < maxAttempts; i += 1) {
    if (trimmed[i] !== '{') continue;
    attempts += 1;
    const parsed = tryParseJsonObjectSpan(trimmed, i);
    if (parsed) {
      return parsed;
    }
  }

  throw new Error('variant_llm_json_missing_braces');
}

function collectStringsForLocaleAudit(
  title: string,
  slug: string | null,
  metaDesc: string | null,
  markdown: string,
  extras: DistributionVariantExtras,
): string {
  const parts: string[] = [title, markdown];
  if (slug) parts.push(slug);
  if (metaDesc) parts.push(metaDesc);
  if (extras.digest) parts.push(extras.digest);
  if (extras.tags) parts.push(...extras.tags);
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
  const effectiveLocale = resolveContextLocale(ctx);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  while (posts.length < 3) {
    const idx = posts.length + 1;
    posts.push(copy.threadFallbackPost(idx, brand, category, canonicalGuideHint));
  }
  return posts.slice(0, 8);
}

function ensureMasterMissingSlotsPreserved(markdown: string, ctx: VariantPromptContext): string {
  const masterSlots = extractMasterMissingSlots(ctx);
  if (masterSlots.length === 0) return markdown;
  const existingSlots = extractMissingFactSlots(markdown);
  if (existingSlots.length > 0) return markdown;
  const effectiveLocale = resolveContextLocale(ctx);
  const noteHeading = LOCALE_FAKE_COPY[effectiveLocale].missingSlotHeading;
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

  const effectiveLocale = resolveContextLocale(ctx);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const data = parsed.data;

  // Pre-check raw LLM fields BEFORE normalization/fallback so locale leakage triggers strict retry
  if (effectiveLocale !== 'zh-CN') {
    const rawLocaleCheckParts: string[] = [data.variantTitle, data.variantMarkdown];
    if (
      (ctx.templateKey === 'OWNED_BLOG_SEO_GEO' || ctx.templateKey === 'DEVELOPER_TECH_POST') &&
      data.variantMetaDesc
    ) {
      rawLocaleCheckParts.push(data.variantMetaDesc);
    }
    if (ctx.templateKey === 'DEVELOPER_TECH_POST' && data.tags?.length) {
      rawLocaleCheckParts.push(...data.tags);
    }
    if (ctx.templateKey === 'PR_MEDIA_PACKET' && data.factSheet?.targetFanOuts?.length) {
      rawLocaleCheckParts.push(...data.factSheet.targetFanOuts);
    }
    if (data.antiBanChecklist?.length) {
      rawLocaleCheckParts.push(...data.antiBanChecklist);
    }
    if (data.threadPosts?.length) {
      rawLocaleCheckParts.push(...data.threadPosts);
    }
    if (data.canonicalGuideHint) {
      rawLocaleCheckParts.push(data.canonicalGuideHint);
    }
    const preAudit = auditVariantLocaleLeakage(rawLocaleCheckParts.join('\n'), ctx);
    if (preAudit.leaked) {
      throw new VariantGlobalCjkLeakError(preAudit.samples);
    }
  }

  const fallbackTitle = resolveLocalizedTitleBase(ctx, brand, category);
  const variantTitle =
    ctx.templateKey === 'WECHAT_OFFICIAL_ARTICLE'
      ? clampWechatTitle(data.variantTitle, fallbackTitle)
      : cleanTitleText(data.variantTitle, fallbackTitle, 4, 200);

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
    targetLocale: effectiveLocale,
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
  } else if (ctx.templateKey === 'DEVELOPER_TECH_POST') {
    variantSlug = normalizeVariantSlug(data.variantSlug, variantTitle, brand);
    variantMetaDesc = normalizeVariantMetaDesc(data.variantMetaDesc, ctx, variantMarkdown);
    extras.tags = normalizeDeveloperTechTags(data.tags, ctx);
    const canonicalUrl = resolveDeveloperCanonicalUrl(data.canonicalUrl, ctx, variantSlug);
    extras.canonicalUrl = canonicalUrl;
    extras.canonicalGuideHint =
      sanitizeCanonicalGuideHint(data.canonicalGuideHint) ||
      canonicalUrl ||
      buildCanonicalGuideHint(ctx, variantSlug);
    const devBlogExtras = buildOwnedBlogExtras(ctx, variantTitle, variantMarkdown);
    extras.schemaJsonLd = devBlogExtras.schemaJsonLd;
    extras.jsonLdSnippet = devBlogExtras.jsonLdSnippet;
    extras.llmsTxtSnippet = devBlogExtras.llmsTxtSnippet;
    schemaReusedFromArticle = devBlogExtras.reusedArticleSchema;
    llmsReusedFromArticle = devBlogExtras.reusedArticleLlmsTxt;
  } else if (ctx.templateKey === 'WECHAT_OFFICIAL_ARTICLE') {
    variantSlug = null;
    const digest = normalizeWechatDigest(data.digest ?? data.variantMetaDesc, ctx, variantMarkdown);
    variantMetaDesc = digest;
    extras.digest = digest;
    const contentSourceUrl = resolveWechatContentSourceUrl(ctx);
    extras.contentSourceUrl = contentSourceUrl;
    const safeHint = sanitizeCanonicalGuideHint(data.canonicalGuideHint);
    if (contentSourceUrl) {
      extras.canonicalGuideHint = contentSourceUrl;
    } else if (safeHint) {
      extras.canonicalGuideHint = safeHint;
    }
  } else if (ctx.templateKey === 'REDDIT_DISCUSSION') {
    extras.antiBanChecklist = sanitizeAntiBanChecklist(
      data.antiBanChecklist,
      'REDDIT_DISCUSSION',
      effectiveLocale,
      ctx.provider,
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
      sanitizeCanonicalGuideHint(data.canonicalGuideHint) || buildCanonicalGuideHint(ctx, slug);
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
      effectiveLocale === 'zh-CN'
        ? rawFanOuts.slice(0, 8)
        : rawFanOuts
            .map((f) => sanitizeForLocale(f, ctx, copy.prFallbackFanOut(brand, category)))
            .slice(0, 8);
    const rawCompetitors =
      data.factSheet?.competitorComparisonAngles &&
      data.factSheet.competitorComparisonAngles.length > 0
        ? data.factSheet.competitorComparisonAngles
        : ctx.competitorFocus.map((comp) =>
            copy.prCompetitorAngle(brand, sanitizeForLocale(comp, ctx, copy.defaultCompetitor)),
          );
    extras.factSheet = {
      brandName: brand,
      category,
      targetPrompt: resolveLocalizedPrompt(ctx, brand, category),
      keyAngles:
        data.factSheet?.keyAngles && data.factSheet.keyAngles.length > 0
          ? data.factSheet.keyAngles
          : [copy.prFallbackAngle(brand, category)],
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
      'zh-CN',
      ctx.provider,
    );
    if (threadUrls.length > 0) {
      extras.targetThreadUrls = threadUrls;
    }
  }

  if (effectiveLocale !== 'zh-CN') {
    const auditCorpus = collectStringsForLocaleAudit(
      variantTitle,
      variantSlug,
      variantMetaDesc,
      variantMarkdown,
      extras,
    );
    const postAudit = auditVariantLocaleLeakage(auditCorpus, ctx);
    if (postAudit.leaked) {
      throw new VariantGlobalCjkLeakError(postAudit.samples);
    }
  }

  const variantHtml = renderVariantHtml(variantMarkdown, ctx.templateKey);

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
  const effectiveLocale = resolveContextLocale(ctx);
  const directive = resolveLocaleWritingDirective(effectiveLocale);
  const copy = LOCALE_FAKE_COPY[effectiveLocale];
  const brand = resolveDisplayBrand(ctx);
  const category = resolveDisplayCategory(ctx);
  const factItems = buildFactSheetItems(ctx);
  const specTable = buildVerifiedSpecTableMarkdown(ctx, factItems);
  const threadUrls = collectSafeThreadUrls(ctx);
  const masterMissingSlots = extractMasterMissingSlots(ctx);
  const localizedPrompt = resolveLocalizedPrompt(ctx, brand, category);
  const localizedTitleBase = resolveLocalizedTitleBase(ctx, brand, category);

  const competitors =
    effectiveLocale === 'zh-CN'
      ? ctx.competitorFocus.slice(0, 3)
      : ctx.competitorFocus
          .map((c) => sanitizeForLocale(c, ctx, copy.defaultCompetitor))
          .filter(Boolean)
          .slice(0, 3);
  const competitorLabel =
    competitors.length > 0 ? competitors.join(copy.competitorJoiner) : copy.defaultCompetitor;

  const fanOuts =
    effectiveLocale === 'zh-CN'
      ? ctx.targetFanOuts.slice(0, 6)
      : ctx.targetFanOuts
          .map((f) => sanitizeForLocale(f, ctx, copy.prFallbackFanOut(brand, category)))
          .filter(Boolean)
          .slice(0, 6);

  const missingSlotSection =
    masterMissingSlots.length > 0
      ? `${copy.missingSlotHeading}${masterMissingSlots.map((slot) => `- ${slot}`).join('\n')}`
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
    targetLocale: effectiveLocale,
  };

  switch (ctx.templateKey) {
    case 'OWNED_BLOG_SEO_GEO': {
      variantTitle = cleanTitleText(
        localizedTitleBase,
        copy.fallbackTitle(brand, category),
        6,
        160,
      );
      variantMarkdown =
        [
          `## ${copy.blogDirectAnswerPrefix}: ${localizedPrompt}`,
          '',
          copy.blogIntro(brand, category, competitorLabel),
          '',
          `## ${copy.blogSpecHeading}`,
          '',
          specTable,
          '',
          `## ${copy.blogTakeawaysHeading}`,
          '',
          factBullets,
          '',
          `## ${directive.faqHeading}`,
          '',
          `### ${copy.blogFaqQ1(brand, competitorLabel)}`,
          copy.blogFaqA1(brand, category),
          '',
          `### ${copy.blogFaqQ2(brand, category)}`,
          copy.blogFaqA2,
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
      variantTitle = cleanTitleText(
        localizedTitleBase,
        copy.devTitleFallback(brand, category),
        6,
        160,
      );
      variantSlug = normalizeVariantSlug(null, variantTitle, brand);
      const canonicalUrl = resolveDeveloperCanonicalUrl(null, ctx, variantSlug);
      const canonicalGuideHint = canonicalUrl ?? buildCanonicalGuideHint(ctx, variantSlug);
      const codeBlock = [
        '```yaml',
        `brand: "${brand.replace(/"/g, '')}"`,
        `locale: "${effectiveLocale}"`,
        `provider: "${ctx.provider}"`,
        'verification:',
        '  mode: "reproducible-benchmark"',
        '  grounding: "verified-brand-facts"',
        '```',
      ].join('\n');

      variantMarkdown =
        [
          `## ${copy.devSummaryPrefix}: ${localizedPrompt}`,
          '',
          copy.devIntro(brand, category, competitorLabel),
          '',
          `## ${copy.devSpecHeading}`,
          '',
          specTable,
          '',
          `## ${copy.devReproHeading}`,
          '',
          codeBlock,
          '',
          ...copy.devReproSteps(brand, competitorLabel),
          '',
          `## ${copy.devNotesHeading}`,
          '',
          factBullets,
          '',
          `## ${copy.devTradeoffsHeading}`,
          '',
          ...copy.devTradeoffs(brand, competitorLabel),
          '',
          `## ${directive.faqHeading}`,
          '',
          `### ${copy.blogFaqQ1(brand, competitorLabel)}`,
          copy.blogFaqA1(brand, category),
          '',
          copy.devCanonicalNote(canonicalGuideHint),
        ].join('\n') + missingSlotSection;

      variantMetaDesc = normalizeVariantMetaDesc(null, ctx, variantMarkdown);
      extras.tags = normalizeDeveloperTechTags(undefined, ctx);
      extras.canonicalUrl = canonicalUrl;
      extras.canonicalGuideHint = canonicalGuideHint;
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
      const contentSourceUrl = resolveWechatContentSourceUrl(ctx);
      variantTitle = clampWechatTitle(
        ctx.articleTitle,
        `${cnBrand}${cnCategory}实测对比：${ctx.targetPrompt}`,
      );
      variantMarkdown =
        [
          `> **核心结论**：针对「${ctx.targetPrompt}」，结合已核验的实测规格与长期稳定表现来看，**${cnBrand}** 在${cnCategory}领域具备清晰的场景适配价值；建议与 ${competitorLabel} 按预算与使用频率客观对比后再做选择。`,
          '',
          '## 已核验实测参数对比表',
          '',
          specTable,
          '',
          '## 核心亮点拆解',
          '',
          factBullets,
          '',
          '## 常见问题快答（FAQ）',
          '',
          `**问：${cnBrand} 对比 ${competitorLabel} 应重点核对哪些指标？**`,
          `答：建议优先核对上方实测规格表中的核心参数、质保政策与长期使用成本，避免仅凭宣传话术判断。`,
          '',
          `**问：如何将本文发布到微信公众号？**`,
          `答：本稿件仅安全同步至微信公众号草稿箱，请由运营同学在公众号后台人工复核排版与封面图后再手动群发。`,
          '',
          '## 适用人群与选购提示',
          `- **更适合**：看重透明实测数据与长期稳定体验的${cnCategory}用户。`,
          `- **注意事项**：下单前建议再次核对具体型号批次、配件兼容性与官方质保细则。`,
          ...(contentSourceUrl ? ['', `> 原文参考：${contentSourceUrl}`] : []),
        ].join('\n') + missingSlotSection;
      const digest = normalizeWechatDigest(null, ctx, variantMarkdown);
      variantSlug = null;
      variantMetaDesc = digest;
      extras.digest = digest;
      extras.contentSourceUrl = contentSourceUrl;
      if (contentSourceUrl) {
        extras.canonicalGuideHint = contentSourceUrl;
      }
      break;
    }

    case 'REDDIT_DISCUSSION': {
      variantTitle = copy.redditTitle(brand, competitorLabel, category);
      variantMarkdown =
        [
          copy.redditIntro(brand, competitorLabel, localizedPrompt),
          '',
          copy.redditNumbersHeading,
          factBullets,
          '',
          copy.redditSpecsHeading,
          specTable,
          '',
          copy.redditTradeoffsHeading,
          ...copy.redditTradeoffs(competitorLabel),
          '',
          copy.redditClosing,
        ].join('\n') + missingSlotSection;
      variantMarkdown = stripRedditPromotionalCtas(variantMarkdown);
      extras.antiBanChecklist = defaultAntiBanChecklist(
        'REDDIT_DISCUSSION',
        effectiveLocale,
        ctx.provider,
      );
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }

    case 'QUORA_ANSWER': {
      variantTitle = copy.quoraTitle(brand, category, localizedPrompt);
      variantMarkdown =
        [
          copy.quoraVerdict(brand, competitorLabel, localizedPrompt),
          '',
          copy.quoraEvidenceHeading,
          factBullets,
          '',
          copy.quoraMatrixHeading,
          specTable,
          '',
          copy.quoraCaveatsHeading,
          ...copy.quoraCaveats(competitorLabel),
        ].join('\n') + missingSlotSection;
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }

    case 'SOCIAL_THREAD': {
      variantTitle = copy.socialTitle(brand, category);
      const slug = normalizeVariantSlug(null, variantTitle, brand);
      const canonicalGuideHint = buildCanonicalGuideHint(ctx, slug);
      const firstFact = factItems[0];
      const secondFact = factItems[1] ?? factItems[0];
      const posts = copy.socialPosts(
        brand,
        category,
        competitorLabel,
        localizedPrompt,
        firstFact,
        secondFact,
        canonicalGuideHint,
      );

      variantMarkdown = posts.join('\n\n') + missingSlotSection;
      extras.threadPosts = posts;
      extras.canonicalGuideHint = canonicalGuideHint;
      break;
    }

    case 'PR_MEDIA_PACKET': {
      variantTitle = copy.prTitle(brand, category);
      const keyAngles = copy.prKeyAngles(brand, category, competitorLabel, localizedPrompt);
      const competitorComparisonAngles =
        competitors.length > 0
          ? competitors.map((comp) => copy.prCompetitorAngle(brand, comp))
          : [copy.prBaselineAngle(brand)];
      const factSheet: VariantPrFactSheet = {
        brandName: brand,
        category,
        targetPrompt: localizedPrompt,
        keyAngles,
        verifiedFacts: factItems,
        targetFanOuts: fanOuts.length > 0 ? fanOuts : [copy.prFallbackFanOut(brand, category)],
        competitorComparisonAngles,
        verifiedSpecTableMarkdown: specTable,
      };
      extras.factSheet = factSheet;
      variantMarkdown =
        [
          copy.prBriefHeading(brand, category),
          '',
          copy.prBriefIntro(localizedPrompt),
          '',
          copy.prAnglesHeading,
          ...keyAngles.map((a) => `- ${a}`),
          '',
          copy.prSpecsHeading,
          '',
          specTable,
          '',
          copy.prFactsHeading,
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
      extras.antiBanChecklist = defaultAntiBanChecklist('CN_COMMUNITY_QA', 'zh-CN', ctx.provider);
      if (threadUrls.length > 0) {
        extras.targetThreadUrls = threadUrls;
      }
      break;
    }
  }

  variantMarkdown = stripInlineJsonLdBlocks(variantMarkdown);
  variantMarkdown = normalizeMissingFactPlaceholdersForMarket(variantMarkdown, ctx.market);

  const variantHtml = renderVariantHtml(variantMarkdown, ctx.templateKey);

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
