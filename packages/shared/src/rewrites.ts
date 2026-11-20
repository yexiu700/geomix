import { z } from 'zod';
import { ARTICLE_STATUS_LABEL, type ArticleStatusName } from './writing-categories';
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  cleanTitleText,
  postProcessArticleMarkdown,
  type ItemStatusName,
  type PromptAssemblyMessage,
} from './writing-tasks';

export const REWRITE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const REWRITE_SIM_MAX_DEFAULT = 0.35;
export const REWRITE_MIN_SOURCE_CHARS = 200;
export const REWRITE_MAX_SOURCE_CHARS = 8000;
export const REWRITE_IMAGE_MIN = 0;
export const REWRITE_IMAGE_MAX = 3;
export const REWRITE_IMAGE_DEFAULT = 2;
export const REWRITE_DEFAULT_UNIT_POINTS = 5;
export const REWRITE_DUPLICATE_WINDOW_HOURS = 24;
export const REWRITE_AUTO_CATEGORY_PREFIX = '爆文复刻';

export const REWRITE_RESULT_STATUSES = ['PENDING', 'NORMAL'] as const;
export type RewriteResultStatusName = (typeof REWRITE_RESULT_STATUSES)[number];

export const REWRITE_RESULT_STATUS_LABELS: Record<RewriteResultStatusName, string> = {
  PENDING: '待审核（推荐）',
  NORMAL: '正常（直接可用）',
};

export const REWRITE_SHORT_SOURCE_MSG = `源文有效正文不足 ${REWRITE_MIN_SOURCE_CHARS} 字，为避免复刻结果过短、缺乏小标题与深度，请更换长文链接或开启「粘贴原文」补充完整正文（本次不扣点数）`;

export type ExtractedSourceSite = 'wechat' | 'zhihu' | 'generic';

export type ExtractedSourceArticle = {
  site: ExtractedSourceSite;
  title: string;
  contentText: string;
  charCount: number;
  truncated: boolean;
};

export type RewriteComplianceFlags = {
  highSimilarity?: boolean;
  similarity?: number;
  retriedSimilarity?: boolean;
  duplicateRecentUrl?: boolean;
};

export type RewriteRecordItem = {
  id: string;
  batchId: string | null;
  url: string;
  urlHash: string;
  pastedText: boolean;
  sourceTitle: string | null;
  newTitle: string | null;
  categoryId: string | null;
  categoryName: string | null;
  mediaCategoryId: string | null;
  mediaCategoryName: string | null;
  templateId: string;
  templateName: string | null;
  status: ItemStatusName;
  error: string | null;
  similarity: number | null;
  highSimilarity: boolean;
  articleId: string | null;
  articleStatus: ArticleStatusName | null;
  rewrittenAt: string | null;
  createdAt: string;
};

export type RewriteRecordListQuery = {
  page: number;
  pageSize: number;
  keyword?: string;
  categoryId?: string;
  status?: ItemStatusName;
  articleStatus?: ArticleStatusName;
};

export type RewriteRecordListResponse = {
  page: number;
  pageSize: number;
  total: number;
  unitPoints: number;
  items: RewriteRecordItem[];
};

export type RewriteSingleCreateResponse = {
  record: RewriteRecordItem;
  duplicateRecentWarning: string | null;
  settledPoints: number;
};

export type RewriteUrlCheckResponse = {
  canonicalUrl: string;
  urlHash: string;
  duplicateRecent: boolean;
  recentRecordId: string | null;
  recentCreatedAt: string | null;
  warning: string | null;
};

const TRACKING_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'spm',
  'from',
  'isappinstalled',
  'scene',
  ' clicktime',
  'enterid',
]);

/**
 * Pure FIPS 180-4 SHA-256 hex digest (works identically in browser & Node without node:crypto).
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const totalLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export function canonicalizeRewriteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('paste://')) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('链接格式不正确，请输入以 http:// 或 https:// 开头的完整网址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http 或 https 公开网页链接');
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  const keys = Array.from(parsed.searchParams.keys());
  for (const key of keys) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

export function computeRewriteUrlHash(rawUrl: string): string {
  const canonical = canonicalizeRewriteUrl(rawUrl);
  return sha256Hex(canonical);
}

export function countSourceNonWhitespaceChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length;
}

export function buildDefaultRewriteCategoryName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${REWRITE_AUTO_CATEGORY_PREFIX}-${stamp}`;
}

export function resolveRewriteSimMax(env?: Record<string, string | undefined>): number {
  const raw = env?.REWRITE_SIM_MAX?.trim();
  if (!raw) return REWRITE_SIM_MAX_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0.05 || parsed >= 0.95) {
    return REWRITE_SIM_MAX_DEFAULT;
  }
  return parsed;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;|&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&middot;/gi, '·')
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec);
      return Number.isSafeInteger(code) && code > 31 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 31 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    });
}

const STRIP_PAIRED_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'picture',
  'object',
  'embed',
  'form',
  'button',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
  'figcaption',
];

const VOID_MEDIA_TAG_RE = /<(?:img|source|input|track|area|meta|link)\b[^>]*\/?>/gi;

const NOISE_ATTR_RE =
  /\b(?:id|class)\s*=\s*["'][^"']*(?:qr_code|qrcode|js_pc_qr_code|rich_media_meta_list|profile_container|reward_area|js_tags|js_toobar|ContentItem-actions|RichContent-actions|Post-TopicsAndReviewer|Post-Sub|AuthorInfo|comment-list|related-articles|share-box|copyright-notice|ad-banner|ads-box|sidebar|breadcrumb)[^"']*["']/i;

const BOILERPLATE_LINE_PATTERNS = [
  /扫码关注/,
  /长按识别.{0,12}二维码/,
  /关注公众号/,
  /点击上方蓝字/,
  /微信搜索.{0,20}关注/,
  /转载请(?:联系|注明)/,
  /免责声明[:：]/,
  /阅读原文$/,
  /^(?:编辑|责编|来源|作者)[:：\s].{0,30}$/,
];

function stripMediaAndNoiseElements(rawHtml: string): string {
  let html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of STRIP_PAIRED_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    html = html.replace(re, ' ');
  }
  html = html.replace(VOID_MEDIA_TAG_RE, ' ');
  return html;
}

/**
 * Extracts inner HTML of the first element whose opening tag matches `tagNames` and `attrMatcher`,
 * balancing nested tags of the same tagName accurately.
 */
function extractBalancedElementInner(
  html: string,
  tagNames: readonly string[],
  attrMatcher?: (attrs: string) => boolean,
): string | null {
  const tagGroup = tagNames.join('|');
  const openSearch = new RegExp(`<(${tagGroup})\\b([^>]*)>`, 'gi');
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openSearch.exec(html)) !== null) {
    const matchedTag = openMatch[1]!.toLowerCase();
    const attrs = openMatch[2] ?? '';
    if (attrs.trimEnd().endsWith('/')) {
      continue;
    }
    if (attrMatcher && !attrMatcher(attrs)) {
      continue;
    }

    const innerStart = openMatch.index + openMatch[0].length;
    const sameTagRe = new RegExp(`<(\\/?)(${matchedTag})\\b([^>]*)>`, 'gi');
    sameTagRe.lastIndex = innerStart;
    let depth = 1;
    let tok: RegExpExecArray | null;
    while ((tok = sameTagRe.exec(html)) !== null) {
      const isClosing = tok[1] === '/';
      const tokAttrs = tok[3] ?? '';
      if (!isClosing && !tokAttrs.trimEnd().endsWith('/')) {
        depth += 1;
      } else if (isClosing) {
        depth -= 1;
        if (depth === 0) {
          return html.slice(innerStart, tok.index);
        }
      }
    }
    return html.slice(innerStart);
  }
  return null;
}

function removeNoiseBlocks(html: string): string {
  let current = html;
  for (let guard = 0; guard < 24; guard += 1) {
    const tagRe = /<(div|section|p|span|ul)\b([^>]*)>/gi;
    let found: { start: number; end: number } | null = null;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(current)) !== null) {
      const tag = match[1]!.toLowerCase();
      const attrs = match[2] ?? '';
      if (!NOISE_ATTR_RE.test(attrs)) continue;
      if (attrs.trimEnd().endsWith('/')) {
        found = { start: match.index, end: match.index + match[0].length };
        break;
      }
      const sameRe = new RegExp(`<(\\/?)(${tag})\\b([^>]*)>`, 'gi');
      sameRe.lastIndex = match.index + match[0].length;
      let depth = 1;
      let tok: RegExpExecArray | null;
      let closeEnd = current.length;
      while ((tok = sameRe.exec(current)) !== null) {
        if (tok[1] === '/') {
          depth -= 1;
          if (depth === 0) {
            closeEnd = tok.index + tok[0].length;
            break;
          }
        } else if (!(tok[3] ?? '').trimEnd().endsWith('/')) {
          depth += 1;
        }
      }
      found = { start: match.index, end: closeEnd };
      break;
    }
    if (!found) break;
    current = `${current.slice(0, found.start)} ${current.slice(found.end)}`;
  }
  return current;
}

function hasId(attrs: string, id: string): boolean {
  const re = new RegExp(`\\bid\\s*=\\s*["']${id}["']`, 'i');
  return re.test(attrs);
}

function hasClassToken(attrs: string, token: string): boolean {
  const m = /\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (!m) return false;
  const tokens = m[1]!.split(/\s+/);
  return tokens.some((item) => item === token || item.toLowerCase() === token.toLowerCase());
}

function extractMetaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]+content\\s*=\\s*["']([^"']+)["'][^>]*>|<meta\\b[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`,
    'i',
  );
  const m = re.exec(html);
  const raw = m?.[1] ?? m?.[2];
  return raw ? cleanExtractedTitle(raw) : null;
}

function cleanExtractedTitle(rawHtmlOrText: string): string {
  const plain = decodeHtmlEntities(rawHtmlOrText.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  // Strip common site suffixes like " - 知乎", " _ 行业资讯网", " | 专栏"
  const stripped = plain.replace(/\s*(?:[-_|—｜]\s*[^-_|—｜]{2,18})$/, '').trim();
  return (stripped.length >= 4 ? stripped : plain).slice(0, 120);
}

function htmlFragmentToPlainText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|h1|h2|h3|h4|h5|h6|blockquote|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');

  const decoded = decodeHtmlEntities(withBreaks)
    // Remove residual markdown image syntax if source text contained raw markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BOILERPLATE_LINE_PATTERNS.some((pat) => pat.test(line)))
    .filter((line) => !/^https?:\/\/\S+$/i.test(line));

  return lines.join('\n\n').trim();
}

function pickReadabilityBestBlock(cleanedHtml: string): string {
  const semantic =
    extractBalancedElementInner(cleanedHtml, ['article']) ??
    extractBalancedElementInner(
      cleanedHtml,
      ['div', 'section'],
      (attrs) =>
        hasId(attrs, 'artibody') ||
        hasId(attrs, 'content_views') ||
        hasId(attrs, 'article-content') ||
        hasClassToken(attrs, 'article-content') ||
        hasClassToken(attrs, 'article-body') ||
        hasClassToken(attrs, 'post-content') ||
        hasClassToken(attrs, 'entry-content') ||
        hasClassToken(attrs, 'detail-content'),
    ) ??
    extractBalancedElementInner(cleanedHtml, ['main']);

  if (semantic && countSourceNonWhitespaceChars(htmlFragmentToPlainText(semantic)) >= 80) {
    return semantic;
  }

  // Score candidate div/section containers by paragraph density minus link density
  const blockOpenRe = /<(div|section)\b([^>]*)>/gi;
  let bestScore = -1;
  let bestInner: string | null = null;
  let m: RegExpExecArray | null;
  let scanned = 0;

  while ((m = blockOpenRe.exec(cleanedHtml)) !== null && scanned < 60) {
    scanned += 1;
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? '';
    if (NOISE_ATTR_RE.test(attrs) || attrs.trimEnd().endsWith('/')) continue;
    const start = m.index + m[0].length;
    const sameRe = new RegExp(`<(\\/?)(${tag})\\b([^>]*)>`, 'gi');
    sameRe.lastIndex = start;
    let depth = 1;
    let tok: RegExpExecArray | null;
    let end = cleanedHtml.length;
    while ((tok = sameRe.exec(cleanedHtml)) !== null) {
      if (tok[1] === '/') {
        depth -= 1;
        if (depth === 0) {
          end = tok.index;
          break;
        }
      } else if (!(tok[3] ?? '').trimEnd().endsWith('/')) {
        depth += 1;
      }
    }
    const inner = cleanedHtml.slice(start, end);
    const pCount = (inner.match(/<p\b/gi) ?? []).length;
    const linkMatches = inner.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
    const linkChars = linkMatches.reduce(
      (sum, anchor) => sum + countSourceNonWhitespaceChars(anchor.replace(/<[^>]+>/g, '')),
      0,
    );
    const textChars = countSourceNonWhitespaceChars(htmlFragmentToPlainText(inner));
    const score = textChars - linkChars * 2 + pCount * 25;
    if (score > bestScore && textChars >= 40) {
      bestScore = score;
      bestInner = inner;
    }
  }

  if (bestInner) return bestInner;
  const bodyInner = extractBalancedElementInner(cleanedHtml, ['body']);
  return bodyInner ?? cleanedHtml;
}

export function detectSourceSite(rawHtml: string, rawUrl?: string): ExtractedSourceSite {
  const host = (() => {
    if (!rawUrl) return '';
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (
    host === 'mp.weixin.qq.com' ||
    host.endsWith('.weixin.qq.com') ||
    /\bid\s*=\s*["']js_content["']/i.test(rawHtml)
  ) {
    return 'wechat';
  }
  if (
    host === 'zhihu.com' ||
    host.endsWith('.zhihu.com') ||
    /\bclass\s*=\s*["'][^"']*(?:Post-RichTextContainer|RichContent-inner)[^"']*["']/i.test(rawHtml)
  ) {
    return 'zhihu';
  }
  return 'generic';
}

export function truncateSourceText(
  text: string,
  maxChars = REWRITE_MAX_SOURCE_CHARS,
): { text: string; charCount: number; truncated: boolean } {
  const total = countSourceNonWhitespaceChars(text);
  if (total <= maxChars) {
    return { text, charCount: total, truncated: false };
  }
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  let acc = 0;
  for (const para of paragraphs) {
    const pChars = countSourceNonWhitespaceChars(para);
    if (acc + pChars <= maxChars) {
      kept.push(para);
      acc += pChars;
    } else {
      const remaining = Math.max(0, maxChars - acc);
      if (remaining > 0) {
        let sliceOut = '';
        let taken = 0;
        for (const ch of Array.from(para)) {
          sliceOut += ch;
          if (!/\s/.test(ch)) {
            taken += 1;
            if (taken >= remaining) break;
          }
        }
        kept.push(sliceOut.trim());
        acc += taken;
      }
      break;
    }
  }
  const finalText = kept.filter(Boolean).join('\n\n').trim();
  return {
    text: finalText,
    charCount: countSourceNonWhitespaceChars(finalText),
    truncated: true,
  };
}

/**
 * F04b §1.2 站点专用 HTML 正文提取器：
 * - 微信公众号（#activity-name + #js_content）
 * - 知乎专栏/回答（.Post-Title / .QuestionHeader-title + .Post-RichTextContainer / .RichContent-inner）
 * - 通用资讯页（Readability 段落密度与语义容器兜底）
 * 彻底剥离所有原图（<img>/<picture>/<svg>/<video>/<iframe>）、二维码与关注引导块。
 */
export function extractArticleFromHtml(rawHtml: string, rawUrl?: string): ExtractedSourceArticle {
  const site = detectSourceSite(rawHtml, rawUrl);
  const metaTitle =
    extractMetaContent(rawHtml, 'og:title') ?? extractMetaContent(rawHtml, 'twitter:title');
  const docTitleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml);
  const docTitle = docTitleMatch ? cleanExtractedTitle(docTitleMatch[1]!) : '';

  const stripped = removeNoiseBlocks(stripMediaAndNoiseElements(rawHtml));

  let title = '';
  let bodyFragment: string | null = null;

  if (site === 'wechat') {
    const wxTitle = extractBalancedElementInner(
      stripped,
      ['h1', 'h2', 'div'],
      (attrs) => hasId(attrs, 'activity-name') || hasClassToken(attrs, 'rich_media_title'),
    );
    title = wxTitle ? cleanExtractedTitle(wxTitle) : metaTitle || docTitle;
    bodyFragment = extractBalancedElementInner(stripped, ['div', 'section'], (attrs) =>
      hasId(attrs, 'js_content'),
    );
  } else if (site === 'zhihu') {
    const zhTitle = extractBalancedElementInner(
      stripped,
      ['h1', 'h2', 'div'],
      (attrs) => hasClassToken(attrs, 'Post-Title') || hasClassToken(attrs, 'QuestionHeader-title'),
    );
    title = zhTitle ? cleanExtractedTitle(zhTitle) : metaTitle || docTitle;
    bodyFragment = extractBalancedElementInner(
      stripped,
      ['div', 'article'],
      (attrs) =>
        hasClassToken(attrs, 'Post-RichTextContainer') ||
        hasClassToken(attrs, 'Post-RichText') ||
        hasClassToken(attrs, 'RichContent-inner'),
    );
  }

  if (!bodyFragment) {
    bodyFragment = pickReadabilityBestBlock(stripped);
  }

  if (!title) {
    const h1Inner = extractBalancedElementInner(stripped, ['h1']);
    title =
      (h1Inner ? cleanExtractedTitle(h1Inner) : '') || metaTitle || docTitle || '未命名源文章';
  }

  const rawText = htmlFragmentToPlainText(bodyFragment);
  const truncatedResult = truncateSourceText(rawText, REWRITE_MAX_SOURCE_CHARS);

  return {
    site,
    title,
    contentText: truncatedResult.text,
    charCount: truncatedResult.charCount,
    truncated: truncatedResult.truncated,
  };
}

export function normalizePastedSource(input: {
  pastedTitle?: string;
  pastedContent: string;
}): ExtractedSourceArticle {
  // Strip any pasted HTML tags/images just in case user pasted rich HTML markup
  const cleaned = removeNoiseBlocks(stripMediaAndNoiseElements(input.pastedContent));
  const plain = htmlFragmentToPlainText(cleaned);
  const lines = plain
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const explicitTitle = input.pastedTitle?.trim()
    ? decodeHtmlEntities(input.pastedTitle.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
    : '';
  const derivedTitle =
    explicitTitle || (lines[0] && lines[0].length <= 60 ? lines[0] : '粘贴原文素材');
  const truncatedResult = truncateSourceText(plain, REWRITE_MAX_SOURCE_CHARS);

  return {
    site: 'generic',
    title: derivedTitle,
    contentText: truncatedResult.text,
    charCount: truncatedResult.charCount,
    truncated: truncatedResult.truncated,
  };
}

/**
 * F04b §1.4 5-gram 字符级 Jaccard 相似度。
 */
export function computeChar5GramJaccard(sourceText: string, candidateText: string): number {
  const norm = (s: string) =>
    Array.from(s.toLowerCase())
      .filter((ch) => /[\u4e00-\u9fff0-9a-z]/.test(ch))
      .join('');

  const a = norm(sourceText);
  const b = norm(candidateText);
  if (!a && !b) return 0;
  if (!a || !b) return 0;

  const shingles = (str: string): Set<string> => {
    const chars = Array.from(str);
    if (chars.length <= 5) {
      return new Set([chars.join('')]);
    }
    const set = new Set<string>();
    for (let i = 0; i <= chars.length - 5; i += 1) {
      set.add(chars.slice(i, i + 5).join(''));
    }
    return set;
  };

  const setA = shingles(a);
  const setB = shingles(b);
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  if (union <= 0) return 0;
  return Number((intersection / union).toFixed(4));
}

export function renderRewriteTemplateContent(
  templateContent: string,
  vars: {
    brand?: string;
    companyName?: string;
    mainKeyword?: string;
    question?: string;
  },
): string {
  const brandLabel = vars.brand?.trim() || '读者可自行核对的服务方案';
  const companyLabel = vars.companyName?.trim() || '相关服务机构';
  const keywordLabel = vars.mainKeyword?.trim() || '核心议题';
  const questionLabel = vars.question?.trim() || '实际应用与选型要点';

  return templateContent
    .replace(/\{转化词占位符\}/g, brandLabel)
    .replace(/\{公司名称\}/g, companyLabel)
    .replace(/\{训练词占位符\}/g, keywordLabel)
    .replace(/\{问题\}/g, questionLabel);
}

export function assembleRewriteMessages(input: {
  templateContent: string;
  sourceTitle: string;
  sourceText: string;
  brand?: string;
  companyName?: string;
  retryHighSimilarity?: boolean;
}): PromptAssemblyMessage[] {
  const renderedInstruction = renderRewriteTemplateContent(input.templateContent, {
    brand: input.brand,
    companyName: input.companyName,
    mainKeyword: input.sourceTitle,
    question: `${input.sourceTitle}有哪些可核对的实践要点？`,
  });

  const brandConstraint = input.brand?.trim()
    ? `可在合适段落自然提及「${input.brand.trim()}」作为读者进一步了解的参考对象（全文不超过 2 次），严禁将原文推荐的其他品牌直接替换成「${input.brand.trim()}」，严禁贬低任何品牌。`
    : '本次未指定特定品牌词，请保持客观中立的方法论阐述，不要编造品牌推荐结论。';

  const retryDirective = input.retryHighSimilarity
    ? '\n【重要二次重写要求】上一版草稿与原文连续片段重合度偏高。请彻底重排论述顺序，改用「背景痛点拆解 → 关键评估维度 → 落地执行清单」全新三段式结构，换用全新的句式组织语言，严禁照搬原文连续 5 字以上的原句表达。'
    : '';

  const systemContent = [
    '你是 GeoMix 内容结构重组与原创改写助手。',
    renderedInstruction,
    brandConstraint,
    '输出格式硬性要求：',
    '1. 第一行只输出一个全新的中文标题（15～35 字，不要与源标题相同，不要加引号或 # 号）。',
    '2. 空一行后输出 Markdown 正文，包含 3 个左右的二级小标题（## 小标题），并在文末附带「## 常见问题（FAQ）」小节（2～3 组紧扣正文细节与核心卖点的具体问答，严禁使用“结合公开说明及自身场景逐项比对”等空泛套话），全文 800～1400 字。',
    '3. 完全剔除原文中的图片提示、二维码、关注引导、微信号、电话号码及外部网址。',
    retryDirective,
  ]
    .filter(Boolean)
    .join('\n');

  const userContent = [
    `【参考源标题】${input.sourceTitle}`,
    '【参考源正文】',
    input.sourceText,
  ].join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

const GENERIC_SOURCE_TITLES = new Set(['未命名源文章', '粘贴原文素材', '行业实践方案']);

const TOPIC_SUFFIX_RE =
  /(?:[，,\s]*(?:实测与选购避坑指南|实测与选型避坑指南|选购与避坑指南|实测与选购指南|实操与避坑指南|选型与避坑指南|避坑与选购指南|对比评测与选购指南|横向对比评测|对比评测|深度评测|深度解析|深度解读|全面解析|全面解读|避坑指南|选购指南|选型指南|实操指南|落地指南|使用指南|购买指南|入门指南|完全指南|避坑攻略|选购攻略|实操攻略|避坑记录|核对指南|评估指南|实测对比|实测评测|实测|评测|解读|解析|指南|攻略|避坑))+$/u;

const SHORT_PREFIX_TAG_RE =
  /^(?:手工粘贴|原创|深度|干货|实测|评测|专题|快讯|推荐|精选|重磅|一线|最新)$/;

const TEMPLATE_TITLE_TAIL_RE =
  /(?:[:：]?\s*(?:的)?(?:落地评估维度与执行核对指南|实操拆解[:：].*|核心要点梳理与实操建议|有哪些(?:核心选型与使用)?注意事项[？?]?))+$/u;

function trimTopicAtCleanBoundary(raw: string, maxChars = 18): string {
  const chars = Array.from(raw.trim());
  if (chars.length <= maxChars) {
    return chars.join('').trim();
  }

  const minChars = Math.max(4, Math.floor(maxChars * 0.55));
  const isAsciiTokenChar = (ch: string | undefined) => Boolean(ch && /[A-Za-z0-9]/.test(ch));

  let end = maxChars;
  // Never slice in the middle of an ASCII word or number token
  if (isAsciiTokenChar(chars[end - 1]) && isAsciiTokenChar(chars[end])) {
    let backed = end;
    while (backed > minChars && isAsciiTokenChar(chars[backed - 1])) {
      backed -= 1;
    }
    if (backed >= minChars) {
      end = backed;
    } else {
      let forward = end;
      while (
        forward < chars.length &&
        forward - maxChars <= 4 &&
        isAsciiTokenChar(chars[forward])
      ) {
        forward += 1;
      }
      end = forward;
    }
  }

  // Prefer breaking at clause punctuation (comma/enumeration) near the upper bound, not intra-phrase spaces
  for (let i = Math.min(end, chars.length); i >= minChars; i -= 1) {
    const ch = chars[i - 1];
    if (ch && /[、，,]/.test(ch)) {
      end = i - 1;
      break;
    }
  }

  // Balance common Chinese/ASCII brackets so we never leave an unclosed bracket
  const pairs: Record<string, string> = {
    '(': ')',
    '（': '）',
    '【': '】',
    '「': '」',
    '《': '》',
  };
  const closeSet = new Set(Object.values(pairs));
  const openIdx: number[] = [];
  for (let i = 0; i < end; i += 1) {
    const ch = chars[i]!;
    if (pairs[ch]) openIdx.push(i);
    else if (closeSet.has(ch) && openIdx.length > 0) openIdx.pop();
  }
  if (openIdx.length > 0 && openIdx[0]! >= 4) {
    end = openIdx[0]!;
  }

  return chars
    .slice(0, end)
    .join('')
    .replace(/[的与和及在从对为、，,\s-]+$/u, '')
    .trim();
}

/**
 * 从源标题（或改写后标题）中提取语义完整的核心主题词，避免按固定字符数硬截断词组或叠加「围绕」。
 */
export function extractRewriteTopic(sourceTitle: string, fallbackTitle?: string): string {
  const cleanText = (raw: string) =>
    raw
      .replace(/["'“”‘’《》【】「」『』<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:围绕|关于|针对|对于)\s*/u, '')
      .trim();

  let candidate = cleanText(sourceTitle);
  if (!candidate || GENERIC_SOURCE_TITLES.has(candidate)) {
    const fb = cleanText(fallbackTitle ?? '')
      .replace(TEMPLATE_TITLE_TAIL_RE, '')
      .trim();
    candidate = fb;
  }
  if (!candidate) return '行业实践方案';

  const segments = candidate
    .split(/[:：|｜]|——|—|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length > 1) {
    const first = segments[0]!;
    const second = segments[1]!;
    if (
      (Array.from(first).length <= 6 || SHORT_PREFIX_TAG_RE.test(first)) &&
      Array.from(second).length >= 4
    ) {
      candidate = second;
    } else if (Array.from(first).length >= 5) {
      candidate = first;
    }
  }

  const strippedSuffix = candidate
    .replace(TOPIC_SUFFIX_RE, '')
    .replace(/[的与和及]+$/u, '')
    .trim();
  if (Array.from(strippedSuffix).length >= 5) {
    candidate = strippedSuffix;
  }

  const trimmed = trimTopicAtCleanBoundary(candidate, 18);
  return trimmed || '行业实践方案';
}

/**
 * FakeLLM 开发/测试态占位改写生成器：
 * 提取源标题中的核心主题词，用全新三段式结构生成低重合度（Jaccard < 0.2）带二级标题的原创重组文稿。
 */
export function buildFakeRewriteMarkdown(input: {
  sourceTitle: string;
  sourceText: string;
  brand?: string;
  variant?: number;
}): string {
  const cleanTopic = extractRewriteTopic(input.sourceTitle);
  const brand = input.brand?.trim();
  const v = input.variant ?? 0;

  const newTitle =
    v === 0
      ? cleanTitleText(`${cleanTopic}：落地评估维度与执行核对指南`, cleanTopic)
      : cleanTitleText(`${cleanTopic}实操拆解：关键核对标准与推进步骤`, cleanTopic);

  const brandSentence = brand
    ? `在实际比对服务支持与交付细节时，团队也可以把${brand}公开披露的适用边界纳入核对清单，结合自身预算周期审慎验证。`
    : '在实际比对服务支持与交付细节时，团队应以公开可查的合同边界与验收记录作为决策依据，避免依赖口头承诺。';

  return [
    newTitle,
    '',
    `## 一、${cleanTopic}的核心认知与常见误区`,
    `许多团队在初次接触${cleanTopic}议题时，往往容易把注意力集中在表面指标，而忽视了业务场景匹配度与长期维护成本。要想让投入真正转化为稳定产出，首先需要厘清当前阶段的真实约束条件，把可量化的公开事实与尚未验证的假设区分开来。`,
    '从日常协作经验来看，提前梳理内部需求优先级、明确输入输出标准，能够显著减少后续反复返工的沟通损耗，也能帮助各方建立一致的预期基准。',
    '',
    '## 二、分阶段推进的四项核对要点',
    `围绕${cleanTopic}开展方案选型与内部评审时，建议按以下四个维度逐一核查：第一，核对适用场景边界，确认工具或流程能否覆盖高频刚需环节；第二，检查交付周期与异常处理机制，确保出现波动时具备清晰的回退预案；第三，审视数据留存与权限隔离规范；第四，小范围试运行并记录客观反馈。`,
    brandSentence,
    '',
    '## 三、持续复盘与风险边界提示',
    '任何方案在正式落地后都需要配合周期性的指标复盘。建议以双周或月度为单位，统计实际执行率、人工介入频次以及问题闭环耗时，用真实运行记录指导下一步优化方向。',
    '需要特别留意的是，公开资料中的经验总结仅代表特定阶段的条件结论，不同规模的组织在照搬前务必先完成小样本测试，切勿脱离自身资源条件盲目扩模。',
  ].join('\n');
}

export function parseRewrittenMarkdown(
  rawOutput: string,
  context: { sourceTitle: string; brand?: string },
): {
  newTitle: string;
  contentHtml: string;
  contentText: string;
  charCount: number;
} {
  let trimmed = rawOutput.replace(/\r\n/g, '\n').trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (fenced) {
    trimmed = fenced[1]!.trim();
  }

  const lines = trimmed.split('\n');
  let titleLineIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines[i]!.trim();
    if (!candidate) continue;
    titleLineIdx = i;
    break;
  }

  let rawTitle = '';
  let bodyMarkdown = trimmed;
  if (titleLineIdx >= 0) {
    const firstLine = lines[titleLineIdx]!.trim();
    // If first line is a heading (# Title) or a short standalone title line (not ## subheading)
    if (/^#\s+/.test(firstLine) || (!/^#{2,}\s+/.test(firstLine) && firstLine.length <= 60)) {
      rawTitle = firstLine
        .replace(/^#+\s*/, '')
        .replace(/^标题[:：]\s*/, '')
        .trim();
      bodyMarkdown = lines
        .slice(titleLineIdx + 1)
        .join('\n')
        .trim();
    }
  }

  const extractedTopic = extractRewriteTopic(context.sourceTitle);
  const topicFallback = cleanTitleText(`${extractedTopic}核心要点梳理与实操建议`, extractedTopic);
  const newTitle = cleanTitleText(rawTitle, topicFallback);
  const faqTopic =
    extractRewriteTopic(context.sourceTitle, newTitle)
      .replace(/^(?:围绕|关于|针对|对于)\s*/u, '')
      .trim() || '相关方案';

  const processed = postProcessArticleMarkdown(bodyMarkdown || trimmed, {
    mainKeyword: faqTopic,
    question: `${faqTopic}有哪些核心选型与使用注意事项？`,
    brand: context.brand,
  });

  // Extra hard guarantee: strip any <img> tag that might ever sneak through before gallery injection
  const htmlWithoutImgs = processed.contentHtml.replace(/<img\b[^>]*\/?>/gi, '');
  return {
    newTitle,
    contentHtml: htmlWithoutImgs,
    contentText: processed.contentText,
    charCount: processed.charCount,
  };
}

export const rewriteSingleCreateSchema = z
  .object({
    pastedText: z.boolean().default(false),
    url: z.string().trim().max(2048, '链接长度不能超过 2048 个字符').optional().default(''),
    pastedTitle: z.string().trim().max(120, '源标题不超过 120 个字符').optional().default(''),
    pastedContent: z
      .string()
      .max(50_000, '粘贴原文长度不能超过 50000 个字符')
      .optional()
      .default(''),
    mediaCategoryId: z
      .union([
        z.string().regex(REWRITE_ID_PATTERN, '请选择有效的文章配图图库分类'),
        z.literal(''),
        z.null(),
      ])
      .optional()
      .transform((val) => (val && val.length > 0 ? val : null)),
    imageCount: z
      .number()
      .int()
      .min(REWRITE_IMAGE_MIN, `配图张数最少 ${REWRITE_IMAGE_MIN} 张`)
      .max(REWRITE_IMAGE_MAX, `配图张数最多 ${REWRITE_IMAGE_MAX} 张`)
      .default(REWRITE_IMAGE_DEFAULT),
    templateId: z.string().regex(REWRITE_ID_PATTERN, '请选择爆文改写指令'),
    categoryId: z
      .union([z.string().regex(REWRITE_ID_PATTERN, '文章分类不正确'), z.literal(''), z.null()])
      .optional()
      .transform((val) => (val && val.length > 0 ? val : null)),
    autoCategoryName: z
      .string()
      .trim()
      .max(40, '自动新建分类名称不超过 40 个字符')
      .optional()
      .default(''),
    resultStatus: z.enum(REWRITE_RESULT_STATUSES).default('PENDING'),
    brand: z.string().trim().max(40, '融入品牌词不超过 40 个字符').optional().default(''),
  })
  .superRefine((val, ctx) => {
    if (val.imageCount > 0 && !val.mediaCategoryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaCategoryId'],
        message: '请选择文章配图的企业画像图库分类（不配图时请将配图张数设为 0）',
      });
    }
    if (!val.pastedText) {
      if (!val.url || val.url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: '请输入公开文章链接（http/https）',
        });
      } else if (!/^https?:\/\//i.test(val.url.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: '仅支持 http:// 或 https:// 开头的公开文章链接',
        });
      }
    } else {
      const charCount = countSourceNonWhitespaceChars(val.pastedContent ?? '');
      if (charCount < REWRITE_MIN_SOURCE_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pastedContent'],
          message: `粘贴原文有效字数不足 ${REWRITE_MIN_SOURCE_CHARS} 字（当前 ${charCount} 字），请补充完整正文`,
        });
      }
      if (val.url && val.url.trim().length > 0 && !/^https?:\/\//i.test(val.url.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: '参考源链接需以 http:// 或 https:// 开头（也可留空）',
        });
      }
    }
  });

export type RewriteSingleCreateInput = z.infer<typeof rewriteSingleCreateSchema>;

export const rewriteBulkStatusSchema = z.object({
  ids: z
    .array(z.string().regex(REWRITE_ID_PATTERN, '记录编号不正确'))
    .min(1, '请至少选择一条复刻记录')
    .max(200, '单次最多操作 200 条记录'),
  status: z.enum(['NORMAL', 'DISABLED']),
});

export type RewriteBulkStatusInput = z.infer<typeof rewriteBulkStatusSchema>;

export const rewriteBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().regex(REWRITE_ID_PATTERN, '记录编号不正确'))
    .min(1, '请至少选择一条复刻记录')
    .max(200, '单次最多删除 200 条记录'),
});

export type RewriteBulkDeleteInput = z.infer<typeof rewriteBulkDeleteSchema>;

export function parseRewriteListQuery(raw: Record<string, unknown>): RewriteRecordListQuery {
  const pageRaw = typeof raw.page === 'string' ? Number(raw.page) : Number(raw.page ?? 1);
  const sizeRaw =
    typeof raw.pageSize === 'string' ? Number(raw.pageSize) : Number(raw.pageSize ?? 20);
  const page = Number.isSafeInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const pageSize = Number.isSafeInteger(sizeRaw) && sizeRaw >= 1 && sizeRaw <= 100 ? sizeRaw : 20;

  const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim().slice(0, 100) : '';
  const categoryId =
    typeof raw.categoryId === 'string' && REWRITE_ID_PATTERN.test(raw.categoryId.trim())
      ? raw.categoryId.trim()
      : undefined;

  const statusRaw = typeof raw.status === 'string' ? raw.status.trim() : '';
  const status = (ITEM_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as ItemStatusName)
    : undefined;

  const articleStatusRaw = typeof raw.articleStatus === 'string' ? raw.articleStatus.trim() : '';
  const articleStatus =
    articleStatusRaw === 'PENDING' ||
    articleStatusRaw === 'NORMAL' ||
    articleStatusRaw === 'DISABLED'
      ? articleStatusRaw
      : undefined;

  return {
    page,
    pageSize,
    ...(keyword ? { keyword } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(status ? { status } : {}),
    ...(articleStatus ? { articleStatus } : {}),
  };
}

export function rewriteExportTable(items: readonly RewriteRecordItem[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: [
      '文章分类',
      '来源方式',
      '源链接',
      '源标题',
      '复刻新标题',
      '复刻状态',
      '文章状态',
      '5-gram相似度',
      '改写时间',
    ],
    rows: items.map((item) => [
      item.categoryName ?? '未分类',
      item.pastedText ? '粘贴原文' : '链接抓取',
      item.url.startsWith('paste://') ? '（粘贴原文无链接）' : item.url,
      item.sourceTitle ?? '',
      item.newTitle ?? '',
      ITEM_STATUS_LABELS[item.status] ?? item.status,
      item.articleStatus ? (ARTICLE_STATUS_LABEL[item.articleStatus] ?? item.articleStatus) : '-',
      item.similarity !== null ? `${(item.similarity * 100).toFixed(1)}%` : '-',
      item.rewrittenAt ?? item.createdAt,
    ]),
  };
}
