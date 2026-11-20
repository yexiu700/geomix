import { z } from 'zod';
import { GEO_MARKETS, type GeoMarket } from './brands';
import {
  GEO_RECIPES,
  GEO_TARGET_FORMATS,
  geoOutlineHeadingSchema,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoTargetFormat,
} from './geo-studio';

/**
 * GeoMix 2.0 写作诊断意见卡（GeoBrief）契约与竞品高引用 URL 提取/去重/SSRF 校验工具（Issue #326 / #330 / #332）。
 */

export const GEO_BRIEF_SOURCES = [
  'AUTO_GAP',
  'LOW_RANK',
  'SENTIMENT_RISK',
  'FANOUT_CLUSTER',
  'CITATION_COUNTER',
  'MANUAL',
] as const;
export type GeoBriefSource = (typeof GEO_BRIEF_SOURCES)[number];

export const GEO_BRIEF_SOURCE_LABELS: Record<GeoBriefSource, string> = {
  AUTO_GAP: '竞品霸榜缺口',
  LOW_RANK: '顺位落后',
  SENTIMENT_RISK: '负面/褒贬风险',
  FANOUT_CLUSTER: '拆解词专题缺口',
  CITATION_COUNTER: '高引用信源反制',
  MANUAL: '自由选题',
};

export const GEO_BRIEF_STATUSES = ['OPEN', 'WRITING', 'DONE', 'DISMISSED'] as const;
export type GeoBriefStatus = (typeof GEO_BRIEF_STATUSES)[number];

export const GEO_BRIEF_STATUS_LABELS: Record<GeoBriefStatus, string> = {
  OPEN: '待处理',
  WRITING: '写作中',
  DONE: '已完成',
  DISMISSED: '已忽略',
};

export const REWRITE_SIM_MAX_DEFAULT = 0.35;
export const REWRITE_MIN_SOURCE_CHARS = 200;
export const REWRITE_MAX_SOURCE_CHARS = 8000;

export type ExtractedSourceSite = 'wechat' | 'zhihu' | 'generic';

export type ExtractedSourceArticle = {
  site: ExtractedSourceSite;
  title: string;
  contentText: string;
  charCount: number;
  truncated: boolean;
};

// ==================== URL 规范化、SHA-256、HTML 提取与相似度（从 rewrites.ts / rewrite-batches.ts 抽取） ====================

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
  'clicktime',
  'enterid',
]);

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

export function resolveRewriteSimMax(env?: Record<string, string | undefined>): number {
  const raw = env?.REWRITE_SIM_MAX?.trim();
  if (!raw) return REWRITE_SIM_MAX_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0.05 || parsed >= 0.95) {
    return REWRITE_SIM_MAX_DEFAULT;
  }
  return parsed;
}

function isPrivateOrReservedIPv4Parts(parts: readonly [number, number, number, number]): boolean {
  const [a, b, c, d] = parts;
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIPv6ToGroups(raw: string): number[] | null {
  if (!raw || raw.includes('%')) return null;
  let normalized = raw;
  if (normalized.includes('.')) {
    const embedded = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
    if (!embedded) return null;
    const prefix = embedded[1] ?? '';
    const octets = [
      Number(embedded[2]),
      Number(embedded[3]),
      Number(embedded[4]),
      Number(embedded[5]),
    ];
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${prefix}${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  if (halves.length === 1) {
    if (left.length !== 8) return null;
  } else if (left.length + right.length >= 8) {
    return null;
  }

  const parseGroup = (token: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    return parseInt(token, 16);
  };

  const groups: number[] = [];
  for (const token of left) {
    const val = parseGroup(token);
    if (val === null) return null;
    groups.push(val);
  }
  if (halves.length === 2) {
    const zeros = 8 - left.length - right.length;
    for (let i = 0; i < zeros; i += 1) groups.push(0);
    for (const token of right) {
      const val = parseGroup(token);
      if (val === null) return null;
      groups.push(val);
    }
  }
  return groups.length === 8 ? groups : null;
}

function isPrivateOrReservedIPv6Groups(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) and ::1 (loopback)
  if (firstFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }
  const embeddedV4: [number, number, number, number] = [
    (g6 >> 8) & 0xff,
    g6 & 0xff,
    (g7 >> 8) & 0xff,
    g7 & 0xff,
  ];
  // IPv4-mapped ::ffff:0:0/96
  if (firstFiveZero && g5 === 0xffff) {
    return isPrivateOrReservedIPv4Parts(embeddedV4);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPrivateOrReservedIPv4Parts(embeddedV4);
  }
  // Deprecated IPv4-compatible ::/96
  if (firstFiveZero && g5 === 0) {
    return isPrivateOrReservedIPv4Parts(embeddedV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateOrReservedIPv4Parts(embeddedV4);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }
  // Unique local fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (fe80:: through febf::)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateOrReservedHostLiteral(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::'
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    return isPrivateOrReservedIPv4Parts([
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4]),
    ]);
  }
  if (host.includes(':')) {
    const groups = parseIPv6ToGroups(host);
    if (!groups) return true;
    return isPrivateOrReservedIPv6Groups(groups);
  }
  return false;
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
    if (attrs.trimEnd().endsWith('/')) continue;
    if (attrMatcher && !attrMatcher(attrs)) continue;

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
  const stripped = plain.replace(/\s*(?:[-_|—｜]\s*[^-_|—｜]{2,18})$/, '').trim();
  return (stripped.length >= 4 ? stripped : plain).slice(0, 120);
}

function htmlFragmentToPlainText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|h1|h2|h3|h4|h5|h6|blockquote|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');

  const decoded = decodeHtmlEntities(withBreaks).replace(/!\[[^\]]*\]\([^)]*\)/g, '');

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

export function computeChar5GramJaccard(sourceText: string, candidateText: string): number {
  const norm = (s: string) =>
    Array.from(s.toLowerCase())
      .filter((ch) => /[\u4e00-\u9fff0-9a-z]/.test(ch))
      .join('');

  const a = norm(sourceText);
  const b = norm(candidateText);
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

// ==================== Zod Schemas & DTOs ====================

export const geoBriefGenerateSchema = z.object({
  market: z.enum(GEO_MARKETS),
  sourceType: z.enum(GEO_BRIEF_SOURCES),
  observationIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  citationUrl: z.string().trim().url('参考引用链接格式不正确').max(2048).optional(),
  fanOutQueries: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  customPrompt: z.string().trim().min(2).max(300).optional(),
});

export type GeoBriefGenerateInput = z.infer<typeof geoBriefGenerateSchema>;

export const geoBriefFromCitationUrlSchema = z
  .object({
    market: z.enum(GEO_MARKETS),
    citationUrl: z.string().trim().url('请输入有效的高引用网页链接').max(2048).optional(),
    pastedTitle: z.string().trim().max(120).optional(),
    pastedContent: z.string().trim().min(20).max(50_000).optional(),
    targetPrompt: z.string().trim().min(2).max(300).optional(),
  })
  .refine(
    (data) => Boolean(data.citationUrl || data.pastedContent),
    '请提供目标网页链接或粘贴参考正文',
  );

export type GeoBriefFromCitationUrlInput = z.infer<typeof geoBriefFromCitationUrlSchema>;

export const geoBriefUpdateSchema = z
  .object({
    status: z.enum(GEO_BRIEF_STATUSES).optional(),
    recommendedRecipe: z.enum(GEO_RECIPES).optional(),
    targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
    suggestedTitle: z.string().trim().min(1).max(120).optional(),
    outlineH2: z.array(geoOutlineHeadingSchema).max(15).optional(),
    targetFanOuts: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    missingFactHints: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  })
  .refine((val) => Object.keys(val).length > 0, '至少修改一项意见卡字段');

export type GeoBriefUpdateInput = z.infer<typeof geoBriefUpdateSchema>;

export type GeoBriefChannelRecommendation = {
  channel: string;
  reason: string;
};

export type GeoBriefRecord = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  sourceType: GeoBriefSource;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  targetPrompt: string;
  priorityScore: number;
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
  status: GeoBriefStatus;
  createdAt: string;
  updatedAt: string;
};

export type GeoBriefListResponse = {
  items: GeoBriefRecord[];
  total: number;
};
