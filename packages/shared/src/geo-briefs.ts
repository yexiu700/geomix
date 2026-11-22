import { z } from 'zod';
import { GEO_MARKETS, type GeoMarket } from './brands';
import {
  GEO_RECIPES,
  GEO_TARGET_FORMATS,
  geoOutlineHeadingSchema,
  stripHtmlTagsLinear,
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
  // 6to4 2002::/16
  if (g0 === 0x2002) {
    const sixToFourV4: [number, number, number, number] = [
      (g1 >> 8) & 0xff,
      g1 & 0xff,
      (g2 >> 8) & 0xff,
      g2 & 0xff,
    ];
    return isPrivateOrReservedIPv4Parts(sixToFourV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateOrReservedIPv4Parts(embeddedV4);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }
  // Discard prefix 100::/64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true;
  }
  // Unique local fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (fe80:: through febf::)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateOrReservedHostLiteral(hostname: string): boolean {
  let host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  while (host.endsWith('.')) host = host.slice(0, -1);
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

const RAW_TEXT_STRIP_TAGS = ['script', 'style', 'noscript', 'template'] as const;

const STRUCTURAL_STRIP_TAGS = [
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
] as const;

const VOID_MEDIA_TAGS = ['img', 'source', 'input', 'track', 'area', 'meta', 'link'] as const;
const VOID_MEDIA_TAG_SET = new Set<string>(VOID_MEDIA_TAGS);

const NOISE_CONTAINER_TAGS = ['div', 'section', 'p', 'span', 'ul'] as const;
const NOISE_CONTAINER_TAG_SET = new Set<string>(NOISE_CONTAINER_TAGS);

const BLOCK_CLOSE_NEWLINE_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'tr',
]);

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

function isTagNameBoundaryChar(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === '>' ||
    ch === '/' ||
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f'
  );
}

function isAsciiWsCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isAsciiAlphaNumCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function escapeRegExpLiteral(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findCloseTagEndLinear(
  lower: string,
  tag: string,
  from: number,
): { start: number; end: number } | null {
  const needle = `</${tag}`;
  let cursor = from;
  while (cursor < lower.length) {
    const start = lower.indexOf(needle, cursor);
    if (start === -1) return null;
    let i = start + needle.length;
    while (i < lower.length && isAsciiWsCode(lower.charCodeAt(i))) {
      i += 1;
    }
    if (lower[i] === '>') {
      return { start, end: i + 1 };
    }
    cursor = start + needle.length;
  }
  return null;
}

function stripCommentsLinear(html: string): string {
  if (!html.includes('<!--')) return html;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<!--', cursor);
    if (start === -1) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, start));
    const end = html.indexOf('-->', start + 4);
    if (end === -1) {
      break;
    }
    cursor = end + 3;
  }
  return parts.join('');
}

function stripRawTextTagLinear(html: string, lower: string, tag: string): string {
  const openNeedle = `<${tag}`;
  if (!lower.includes(openNeedle)) return html;

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) {
      parts.push(html.slice(cursor));
      break;
    }
    const afterName = start + openNeedle.length;
    if (!isTagNameBoundaryChar(lower[afterName])) {
      parts.push(html.slice(cursor, afterName));
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, start), ' ');
    const closeMatch = findCloseTagEndLinear(lower, tag, openEnd + 1);
    if (!closeMatch) {
      break;
    }
    cursor = closeMatch.end;
  }
  return parts.join('');
}

function stripPairedStructuralTagLinear(html: string, lower: string, tag: string): string {
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  if (!lower.includes(closeNeedle) || !lower.includes(openNeedle)) {
    return html;
  }

  const openStack: number[] = [];
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  let nextOpen = lower.indexOf(openNeedle, 0);
  let nextClose = lower.indexOf(closeNeedle, 0);

  while (pos < lower.length) {
    if (nextOpen !== -1 && nextOpen < pos) {
      nextOpen = lower.indexOf(openNeedle, pos);
    }
    if (nextClose !== -1 && nextClose < pos) {
      nextClose = lower.indexOf(closeNeedle, pos);
    }
    if (nextOpen === -1 && nextClose === -1) break;

    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      const afterName = nextOpen + openNeedle.length;
      if (!isTagNameBoundaryChar(lower[afterName])) {
        pos = afterName;
        continue;
      }
      const openEnd = lower.indexOf('>', afterName);
      if (openEnd === -1) {
        break;
      }
      openStack.push(nextOpen);
      pos = openEnd + 1;
      continue;
    }

    const afterCloseName = nextClose + closeNeedle.length;
    let i = afterCloseName;
    while (i < lower.length && isAsciiWsCode(lower.charCodeAt(i))) {
      i += 1;
    }
    if (lower[i] === '>') {
      const matchedStart = openStack.pop();
      if (matchedStart !== undefined) {
        ranges.push([matchedStart, i + 1]);
      }
      pos = i + 1;
    } else {
      pos = afterCloseName;
    }
  }

  if (ranges.length === 0) return html;
  ranges.sort((a, b) => a[0] - b[0]);

  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start > cursor) {
      parts.push(html.slice(cursor, start));
    }
    parts.push(' ');
    cursor = end;
  }
  if (cursor < html.length) {
    parts.push(html.slice(cursor));
  }
  return parts.join('');
}

function stripVoidMediaTagsLinear(html: string, lower: string): string {
  if (!html.includes('<')) return html;
  if (!VOID_MEDIA_TAGS.some((tag) => lower.includes(`<${tag}`))) return html;
  const parts: string[] = [];
  let cursor = 0;
  let lastEmit = 0;
  let cachedGt = -1;
  let cachedNextLt = html.indexOf('<', 0);

  while (cursor < html.length) {
    if (cachedNextLt !== -1 && cachedNextLt < cursor) {
      cachedNextLt = html.indexOf('<', cursor);
    }
    const lt = cachedNextLt;
    if (lt === -1) break;
    if (cachedGt < lt + 1) {
      cachedGt = html.indexOf('>', lt + 1);
      if (cachedGt === -1) break;
    }
    const gt = cachedGt;
    const afterLt = html.indexOf('<', lt + 1);
    if (afterLt !== -1 && afterLt < gt) {
      cachedNextLt = afterLt;
      cursor = afterLt;
      continue;
    }

    let p = lt + 1;
    const nameStart = p;
    while (p < gt && isAsciiAlphaNumCode(html.charCodeAt(p))) p += 1;
    if (p > nameStart && isTagNameBoundaryChar(html[p])) {
      const tag = html.slice(nameStart, p).toLowerCase();
      if (VOID_MEDIA_TAG_SET.has(tag)) {
        if (lt > lastEmit) parts.push(html.slice(lastEmit, lt));
        parts.push(' ');
        lastEmit = gt + 1;
      }
    }
    cursor = gt + 1;
  }

  if (lastEmit === 0) return html;
  if (lastEmit < html.length) parts.push(html.slice(lastEmit));
  return parts.join('');
}

function stripMediaAndNoiseElements(rawHtml: string): string {
  let html = stripCommentsLinear(rawHtml);
  let lower = html.toLowerCase();
  for (const tag of RAW_TEXT_STRIP_TAGS) {
    const next = stripRawTextTagLinear(html, lower, tag);
    if (next !== html) {
      html = next;
      lower = html.toLowerCase();
    }
  }
  for (const tag of STRUCTURAL_STRIP_TAGS) {
    const next = stripPairedStructuralTagLinear(html, lower, tag);
    if (next !== html) {
      html = next;
      lower = html.toLowerCase();
    }
  }
  return stripVoidMediaTagsLinear(html, lower);
}

function findBalancedTagCloseLinear(
  lower: string,
  tag: string,
  from: number,
): { closeStart: number; closeEnd: number } | null {
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  let depth = 1;
  let pos = from;
  let nextOpen = lower.indexOf(openNeedle, pos);
  let nextClose = lower.indexOf(closeNeedle, pos);

  while (pos < lower.length) {
    if (nextOpen !== -1 && nextOpen < pos) {
      nextOpen = lower.indexOf(openNeedle, pos);
    }
    if (nextClose !== -1 && nextClose < pos) {
      nextClose = lower.indexOf(closeNeedle, pos);
    }
    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const afterName = nextOpen + openNeedle.length;
      if (!isTagNameBoundaryChar(lower[afterName])) {
        pos = afterName;
        continue;
      }
      const openEnd = lower.indexOf('>', afterName);
      if (openEnd === -1) return null;
      const attrs = lower.slice(afterName, openEnd);
      if (!attrs.trimEnd().endsWith('/')) {
        depth += 1;
      }
      pos = openEnd + 1;
      continue;
    }

    const afterCloseName = nextClose + closeNeedle.length;
    if (!isTagNameBoundaryChar(lower[afterCloseName])) {
      pos = afterCloseName;
      continue;
    }
    const closeGt = lower.indexOf('>', afterCloseName);
    if (closeGt === -1) return null;
    depth -= 1;
    if (depth === 0) {
      return { closeStart: nextClose, closeEnd: closeGt + 1 };
    }
    pos = closeGt + 1;
  }

  return null;
}

function extractBalancedElementInner(
  html: string,
  tagNames: readonly string[],
  attrMatcher?: (attrs: string) => boolean,
  precomputedLower?: string,
): string | null {
  if (!html.includes('<')) return null;
  const lower = precomputedLower ?? html.toLowerCase();
  const normalizedTags = tagNames.map((t) => t.toLowerCase());
  if (!normalizedTags.some((t) => lower.includes(`<${t}`))) return null;
  const tagSet = new Set(normalizedTags);
  let cursor = 0;
  let cachedGt = -1;
  let cachedNextLt = html.indexOf('<', 0);

  while (cursor < html.length) {
    if (cachedNextLt !== -1 && cachedNextLt < cursor) {
      cachedNextLt = html.indexOf('<', cursor);
    }
    const lt = cachedNextLt;
    if (lt === -1) return null;
    if (cachedGt < lt + 1) {
      cachedGt = html.indexOf('>', lt + 1);
      if (cachedGt === -1) return null;
    }
    const gt = cachedGt;
    const afterLt = html.indexOf('<', lt + 1);
    if (afterLt !== -1 && afterLt < gt) {
      cachedNextLt = afterLt;
      cursor = afterLt;
      continue;
    }

    let p = lt + 1;
    const nameStart = p;
    while (p < gt && isAsciiAlphaNumCode(html.charCodeAt(p))) p += 1;
    if (p > nameStart && isTagNameBoundaryChar(html[p])) {
      const matchedTag = lower.slice(nameStart, p);
      if (tagSet.has(matchedTag)) {
        const attrs = html.slice(p, gt);
        if (!attrs.trimEnd().endsWith('/') && (!attrMatcher || attrMatcher(attrs))) {
          const innerStart = gt + 1;
          const closed = findBalancedTagCloseLinear(lower, matchedTag, innerStart);
          return closed ? html.slice(innerStart, closed.closeStart) : html.slice(innerStart);
        }
      }
    }
    cursor = gt + 1;
  }
  return null;
}

function removeNoiseBlocks(html: string): string {
  if (!html.includes('<')) return html;
  const lower = html.toLowerCase();
  if (!lower.includes('id') && !lower.includes('class')) return html;
  if (!NOISE_CONTAINER_TAGS.some((tag) => lower.includes(`<${tag}`))) return html;
  const parts: string[] = [];
  let cursor = 0;
  let lastEmit = 0;
  let cachedGt = -1;
  let cachedNextLt = html.indexOf('<', 0);
  let removed = 0;

  while (cursor < html.length && removed < 24) {
    if (cachedNextLt !== -1 && cachedNextLt < cursor) {
      cachedNextLt = html.indexOf('<', cursor);
    }
    const lt = cachedNextLt;
    if (lt === -1) break;
    if (cachedGt < lt + 1) {
      cachedGt = html.indexOf('>', lt + 1);
      if (cachedGt === -1) break;
    }
    const gt = cachedGt;
    const afterLt = html.indexOf('<', lt + 1);
    if (afterLt !== -1 && afterLt < gt) {
      cachedNextLt = afterLt;
      cursor = afterLt;
      continue;
    }

    let p = lt + 1;
    const nameStart = p;
    while (p < gt && isAsciiAlphaNumCode(html.charCodeAt(p))) p += 1;
    if (p > nameStart && isTagNameBoundaryChar(html[p])) {
      const tag = lower.slice(nameStart, p);
      if (NOISE_CONTAINER_TAG_SET.has(tag)) {
        const attrs = html.slice(p, gt);
        if (NOISE_ATTR_RE.test(attrs)) {
          let closeEnd = gt + 1;
          if (!attrs.trimEnd().endsWith('/')) {
            const closed = findBalancedTagCloseLinear(lower, tag, gt + 1);
            closeEnd = closed ? closed.closeEnd : html.length;
          }
          if (lt > lastEmit) parts.push(html.slice(lastEmit, lt));
          parts.push(' ');
          lastEmit = closeEnd;
          cursor = closeEnd;
          removed += 1;
          continue;
        }
      }
    }
    cursor = gt + 1;
  }

  if (lastEmit === 0) return html;
  if (lastEmit < html.length) parts.push(html.slice(lastEmit));
  return parts.join('');
}

function hasId(attrs: string, id: string): boolean {
  const re = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExpLiteral(id)}["']`, 'i');
  return re.test(attrs);
}

function hasClassToken(attrs: string, token: string): boolean {
  const m = /\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (!m) return false;
  const tokens = m[1]!.split(/\s+/);
  return tokens.some((item) => item === token || item.toLowerCase() === token.toLowerCase());
}

function extractMetaContent(html: string, key: string): string | null {
  const lower = html.toLowerCase();
  const keyLower = key.toLowerCase();
  if (!lower.includes(keyLower) || !lower.includes('<meta')) {
    return null;
  }
  const keyRe = new RegExp(
    `\\b(?:property|name)\\s*=\\s*(?:"${escapeRegExpLiteral(key)}"|'${escapeRegExpLiteral(key)}')`,
    'i',
  );
  let cursor = 0;
  let cachedCloseIdx = -1;
  let cachedNextLt = html.indexOf('<', 0);

  while (cursor < lower.length) {
    const start = lower.indexOf('<meta', cursor);
    if (start === -1) return null;
    const afterName = start + 5;
    if (!isTagNameBoundaryChar(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    if (cachedCloseIdx < afterName) {
      cachedCloseIdx = html.indexOf('>', afterName);
      if (cachedCloseIdx === -1) return null;
    }
    const closeIdx = cachedCloseIdx;
    if (cachedNextLt !== -1 && cachedNextLt < afterName) {
      cachedNextLt = html.indexOf('<', afterName);
    }
    if (cachedNextLt !== -1 && cachedNextLt < closeIdx) {
      cursor = cachedNextLt;
      continue;
    }
    const tagSlice = html.slice(start, closeIdx + 1);
    if (keyRe.test(tagSlice)) {
      const contentMatch = /\bcontent\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tagSlice);
      const raw = contentMatch?.[1] ?? contentMatch?.[2];
      if (raw) return cleanExtractedTitle(raw);
    }
    cursor = closeIdx + 1;
  }
  return null;
}

function extractFirstTagContentLinear(rawHtml: string, lower: string, tag: string): string | null {
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  if (!lower.includes(closeNeedle) || !lower.includes(openNeedle)) {
    return null;
  }
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) return null;
    const afterName = start + openNeedle.length;
    if (!isTagNameBoundaryChar(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) return null;
    const closeMatch = findCloseTagEndLinear(lower, tag, openEnd + 1);
    if (!closeMatch) return null;
    return rawHtml.slice(openEnd + 1, closeMatch.start);
  }
  return null;
}

function extractAllTagContentsLinear(
  rawHtml: string,
  lower: string,
  tag: string,
  maxMatches: number,
): string[] {
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;
  if (!lower.includes(closeNeedle) || !lower.includes(openNeedle)) {
    return [];
  }
  const results: string[] = [];
  let cursor = 0;
  while (cursor < lower.length && results.length < maxMatches) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) break;
    const afterName = start + openNeedle.length;
    if (!isTagNameBoundaryChar(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) break;
    const closeMatch = findCloseTagEndLinear(lower, tag, openEnd + 1);
    if (!closeMatch) break;
    results.push(rawHtml.slice(openEnd + 1, closeMatch.start));
    cursor = closeMatch.end;
  }
  return results;
}

function cleanExtractedTitle(rawHtmlOrText: string): string {
  const plain = decodeHtmlEntities(stripHtmlTagsLinear(rawHtmlOrText, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = plain.replace(/\s*(?:[-_|—｜]\s*[^-_|—｜]{2,18})$/, '').trim();
  return (stripped.length >= 4 ? stripped : plain).slice(0, 120);
}

function stripMarkdownImagesLinear(input: string): string {
  if (!input.includes('![')) return input;
  const parts: string[] = [];
  let cursor = 0;
  let lastEmit = 0;
  while (cursor < input.length) {
    const start = input.indexOf('![', cursor);
    if (start === -1) break;
    const closeBracket = input.indexOf(']', start + 2);
    if (closeBracket === -1) break;
    if (input[closeBracket + 1] !== '(') {
      cursor = closeBracket + 1;
      continue;
    }
    const closeParen = input.indexOf(')', closeBracket + 2);
    if (closeParen === -1) break;
    if (start > lastEmit) parts.push(input.slice(lastEmit, start));
    lastEmit = closeParen + 1;
    cursor = closeParen + 1;
  }
  if (lastEmit === 0) return input;
  if (lastEmit < input.length) parts.push(input.slice(lastEmit));
  return parts.join('');
}

function convertFragmentTagsToPlainLinear(fragment: string): string {
  if (!fragment.includes('<')) return fragment;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < fragment.length) {
    const lt = fragment.indexOf('<', cursor);
    if (lt === -1) {
      parts.push(fragment.slice(cursor));
      break;
    }
    const gt = fragment.indexOf('>', lt + 1);
    if (gt === -1) {
      parts.push(fragment.slice(cursor));
      break;
    }
    if (lt > cursor) {
      parts.push(fragment.slice(cursor, lt));
    }

    let p = lt + 1;
    let isClosing = false;
    if (p < gt && fragment.charCodeAt(p) === 47) {
      isClosing = true;
      p += 1;
    }
    const nameStart = p;
    while (p < gt && isAsciiAlphaNumCode(fragment.charCodeAt(p))) p += 1;
    const tagName = p > nameStart ? fragment.slice(nameStart, p).toLowerCase() : '';

    if (!isClosing && tagName === 'br') {
      parts.push('\n');
    } else if (isClosing && BLOCK_CLOSE_NEWLINE_TAGS.has(tagName)) {
      parts.push('\n');
    } else if (!isClosing && tagName === 'li') {
      parts.push('• ');
    }
    cursor = gt + 1;
  }
  return parts.join('');
}

function htmlFragmentToPlainText(fragment: string): string {
  const withBreaks = convertFragmentTagsToPlainLinear(fragment);
  const decoded = stripMarkdownImagesLinear(decodeHtmlEntities(withBreaks));

  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BOILERPLATE_LINE_PATTERNS.some((pat) => pat.test(line)))
    .filter((line) => !/^https?:\/\/\S+$/i.test(line));

  return lines.join('\n\n').trim();
}

function countAnchorTextCharsLinear(inner: string): number {
  const lower = inner.toLowerCase();
  if (!lower.includes('<a') || !lower.includes('</a')) return 0;
  let total = 0;
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf('<a', cursor);
    if (start === -1) break;
    const afterName = start + 2;
    if (!isTagNameBoundaryChar(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) break;
    const closeMatch = findCloseTagEndLinear(lower, 'a', openEnd + 1);
    if (!closeMatch) break;
    total += countSourceNonWhitespaceChars(
      stripHtmlTagsLinear(inner.slice(openEnd + 1, closeMatch.start)),
    );
    cursor = closeMatch.end;
  }
  return total;
}

function pickReadabilityBestBlock(cleanedHtml: string): string {
  const lower = cleanedHtml.toLowerCase();
  const semantic =
    extractBalancedElementInner(cleanedHtml, ['article'], undefined, lower) ??
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
      lower,
    ) ??
    extractBalancedElementInner(cleanedHtml, ['main'], undefined, lower);

  if (semantic && countSourceNonWhitespaceChars(htmlFragmentToPlainText(semantic)) >= 80) {
    return semantic;
  }

  let bestScore = -1;
  let bestInner: string | null = null;
  if (lower.includes('<div') || lower.includes('<section')) {
    let scanned = 0;
    let cursor = 0;
    let cachedGt = -1;
    let cachedNextLt = cleanedHtml.indexOf('<', 0);

    while (cursor < cleanedHtml.length && scanned < 60) {
      if (cachedNextLt !== -1 && cachedNextLt < cursor) {
        cachedNextLt = cleanedHtml.indexOf('<', cursor);
      }
      const lt = cachedNextLt;
      if (lt === -1) break;
      if (cachedGt < lt + 1) {
        cachedGt = cleanedHtml.indexOf('>', lt + 1);
        if (cachedGt === -1) break;
      }
      const gt = cachedGt;
      const afterLt = cleanedHtml.indexOf('<', lt + 1);
      if (afterLt !== -1 && afterLt < gt) {
        cachedNextLt = afterLt;
        cursor = afterLt;
        continue;
      }

      let p = lt + 1;
      const nameStart = p;
      while (p < gt && isAsciiAlphaNumCode(cleanedHtml.charCodeAt(p))) p += 1;
      if (p > nameStart && isTagNameBoundaryChar(cleanedHtml[p])) {
        const tag = lower.slice(nameStart, p);
        if (tag === 'div' || tag === 'section') {
          scanned += 1;
          const attrs = cleanedHtml.slice(p, gt);
          if (!NOISE_ATTR_RE.test(attrs) && !attrs.trimEnd().endsWith('/')) {
            const start = gt + 1;
            const closed = findBalancedTagCloseLinear(lower, tag, start);
            const end = closed ? closed.closeStart : cleanedHtml.length;
            const inner = cleanedHtml.slice(start, end);
            const pCount = (inner.match(/<p\b/gi) ?? []).length;
            const linkChars = countAnchorTextCharsLinear(inner);
            const textChars = countSourceNonWhitespaceChars(htmlFragmentToPlainText(inner));
            const score = textChars - linkChars * 2 + pCount * 25;
            if (score > bestScore && textChars >= 40) {
              bestScore = score;
              bestInner = inner;
            }
            if (!closed) break;
          }
        }
      }
      cursor = gt + 1;
    }
  }

  if (bestInner) return bestInner;
  const bodyInner = extractBalancedElementInner(cleanedHtml, ['body'], undefined, lower);
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
    (rawHtml.toLowerCase().includes('js_content') && /\bid\s*=\s*["']js_content["']/i.test(rawHtml))
  ) {
    return 'wechat';
  }
  if (
    host === 'zhihu.com' ||
    host.endsWith('.zhihu.com') ||
    ((rawHtml.includes('Post-RichTextContainer') || rawHtml.includes('RichContent-inner')) &&
      /\bclass\s*=\s*["'][^"']{0,200}(?:Post-RichTextContainer|RichContent-inner)[^"']{0,200}["']/i.test(
        rawHtml,
      ))
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
  const rawLower = rawHtml.toLowerCase();
  const metaTitle =
    extractMetaContent(rawHtml, 'og:title') ?? extractMetaContent(rawHtml, 'twitter:title');
  const docTitleRaw = extractFirstTagContentLinear(rawHtml, rawLower, 'title');
  const docTitle = docTitleRaw ? cleanExtractedTitle(docTitleRaw) : '';

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
    ? decodeHtmlEntities(stripHtmlTagsLinear(input.pastedTitle, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
    : '';
  const firstLineTitle =
    lines[0]
      ?.replace(/^#+\s*/, '')
      .replace(/\s*#+$/, '')
      .trim() ?? '';
  const derivedTitle =
    explicitTitle ||
    (firstLineTitle && firstLineTitle.length <= 60 ? firstLineTitle : '粘贴原文素材');
  const truncatedResult = truncateSourceText(plain, REWRITE_MAX_SOURCE_CHARS);

  return {
    site: 'generic',
    title: derivedTitle,
    contentText: truncatedResult.text,
    charCount: truncatedResult.charCount,
    truncated: truncatedResult.truncated,
  };
}

function pushUniqueHeading(target: string[], seen: Set<string>, raw: string, maxHeadings: number) {
  if (target.length >= maxHeadings) return;
  const cleaned = decodeHtmlEntities(stripHtmlTagsLinear(raw, ' '))
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/#+$/g, '')
    .trim()
    .slice(0, 120);
  if (cleaned.length < 2) return;
  const key = cleaned.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(cleaned);
}

/**
 * 从竞品高引用网页 HTML 中提取 H2/H3 议题骨架（纯字符串解析，零第三方依赖）。
 */
export function extractSourceHeadingsFromHtml(rawHtml: string, maxHeadings = 8): string[] {
  const limit = Math.max(1, Math.min(20, Math.floor(maxHeadings)));
  const stripped = removeNoiseBlocks(stripMediaAndNoiseElements(rawHtml));
  const strippedLower = stripped.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();

  for (const heading of extractAllTagContentsLinear(stripped, strippedLower, 'h2', limit * 4)) {
    if (out.length >= limit) break;
    pushUniqueHeading(out, seen, heading, limit);
  }

  if (out.length < 2) {
    for (const heading of extractAllTagContentsLinear(stripped, strippedLower, 'h3', limit * 4)) {
      if (out.length >= limit) break;
      pushUniqueHeading(out, seen, heading, limit);
    }
  }

  return out;
}

/**
 * 从粘贴的参考正文（Markdown 或纯文本编号章节）中提取议题骨架。
 */
export function extractSourceHeadingsFromText(rawText: string, maxHeadings = 8): string[] {
  const limit = Math.max(1, Math.min(20, Math.floor(maxHeadings)));
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (out.length >= limit) break;
    const trimmed = line.trim();
    const mdHeading = /^#{2,3}\s+(.+)$/.exec(trimmed);
    if (mdHeading) {
      pushUniqueHeading(out, seen, mdHeading[1] ?? '', limit);
    }
  }

  if (out.length < 2) {
    for (const line of lines) {
      if (out.length >= limit) break;
      const trimmed = line.trim();
      const numbered = /^(?:[一二三四五六七八九十]+[、.．]|\d{1,2}[.、)）])\s*([^\n]{2,60})$/.exec(
        trimmed,
      );
      if (numbered) {
        pushUniqueHeading(out, seen, numbered[1] ?? '', limit);
      }
    }
  }

  return out;
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

export const GEO_BRIEF_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const GEO_BRIEF_SOURCE_PRIORITY_RANK: Record<GeoBriefSource, number> = {
  AUTO_GAP: 6,
  SENTIMENT_RISK: 5,
  LOW_RANK: 4,
  CITATION_COUNTER: 3,
  FANOUT_CLUSTER: 2,
  MANUAL: 1,
};

export type GeoBriefPriorityInput = {
  sourceType: GeoBriefSource;
  competitorEngineHits?: number;
  competitorCount?: number;
  negativeCount?: number;
  mixedCount?: number;
  avgPosition?: number | null;
  citationCount?: number;
  ownedCitationCount?: number;
  isCompetitorSource?: boolean;
  fanOutCount?: number;
};

function clampInt(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * 按 PRD §4.3 规则计算写作诊断意见卡 0–100 优先级分数：
 * - P1 AUTO_GAP: 90–100（多引擎竞品霸榜 >=2 → 95–100；单引擎竞品缺口 → 90–94；纯盲区 → 90）
 * - P2 SENTIMENT_RISK: 80–89（negative → 85–89；mixed → 80–84）
 * - P3 LOW_RANK: 70–79（avgPosition >= 3）
 * - P5 CITATION_COUNTER: 60–75
 * - P4 FANOUT_CLUSTER: 60–69
 * - MANUAL: 50–65（默认 55）
 */
export function computeGeoBriefPriorityScore(input: GeoBriefPriorityInput): number {
  const competitorEngineHits = Math.max(0, Math.floor(input.competitorEngineHits ?? 0));
  const competitorCount = Math.max(0, Math.floor(input.competitorCount ?? 0));

  switch (input.sourceType) {
    case 'AUTO_GAP': {
      if (competitorEngineHits >= 2) {
        return clampInt(95, 100, 93 + competitorEngineHits * 2 + Math.min(3, competitorCount));
      }
      if (competitorEngineHits === 1) {
        return clampInt(90, 94, 90 + Math.min(4, Math.max(1, competitorCount)));
      }
      return 90;
    }
    case 'SENTIMENT_RISK': {
      const negativeCount = Math.max(0, Math.floor(input.negativeCount ?? 0));
      const mixedCount = Math.max(0, Math.floor(input.mixedCount ?? 0));
      if (negativeCount > 0) {
        return clampInt(85, 89, 85 + Math.min(4, negativeCount * 2));
      }
      return clampInt(80, 84, 80 + Math.min(4, Math.max(1, mixedCount)));
    }
    case 'LOW_RANK': {
      const avgPos =
        typeof input.avgPosition === 'number' && Number.isFinite(input.avgPosition)
          ? input.avgPosition
          : 4;
      return clampInt(
        70,
        79,
        70 + Math.min(5, Math.max(1, Math.round(avgPos))) + Math.min(4, competitorEngineHits),
      );
    }
    case 'CITATION_COUNTER': {
      const citationCount = Math.max(1, Math.floor(input.citationCount ?? 1));
      const ownedBonus = (input.ownedCitationCount ?? 0) === 0 ? 1 : 0;
      const compBonus = input.isCompetitorSource ? 4 : 0;
      return clampInt(60, 75, 62 + Math.min(8, citationCount * 3) + compBonus + ownedBonus);
    }
    case 'FANOUT_CLUSTER': {
      const fanOutCount = Math.max(1, Math.floor(input.fanOutCount ?? 3));
      return clampInt(60, 69, 60 + Math.min(9, fanOutCount));
    }
    case 'MANUAL':
    default:
      return 55;
  }
}

export function compareGeoBriefPriority(
  a: { priorityScore: number; sourceType?: GeoBriefSource; createdAt?: string | Date },
  b: { priorityScore: number; sourceType?: GeoBriefSource; createdAt?: string | Date },
): number {
  if (b.priorityScore !== a.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }
  if (a.sourceType && b.sourceType && a.sourceType !== b.sourceType) {
    return (
      GEO_BRIEF_SOURCE_PRIORITY_RANK[b.sourceType] - GEO_BRIEF_SOURCE_PRIORITY_RANK[a.sourceType]
    );
  }
  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return timeB - timeA;
}

export function defaultRecipeForBriefSource(sourceType: GeoBriefSource): GeoRecipe {
  switch (sourceType) {
    case 'SENTIMENT_RISK':
      return 'OBJECTION_FAQ';
    case 'LOW_RANK':
      return 'COMPARISON_MATRIX';
    case 'CITATION_COUNTER':
      return 'CITATION_COUNTER';
    case 'AUTO_GAP':
    case 'FANOUT_CLUSTER':
    case 'MANUAL':
    default:
      return 'AUTHORITY_GUIDE';
  }
}

export function recommendBriefTargetFormat(
  market: GeoMarket,
  sourceType: GeoBriefSource,
  options?: { socialHeavy?: boolean },
): GeoTargetFormat {
  const preferCommunity = sourceType === 'SENTIMENT_RISK' || Boolean(options?.socialHeavy);
  if (market === 'GLOBAL') {
    return preferCommunity ? 'GLOBAL_COMMUNITY_DISCUSSION' : 'GLOBAL_AUTHORITY_GUIDE';
  }
  return preferCommunity ? 'CN_COMMUNITY_QA' : 'CN_DEEP_REVIEW';
}

export const CN_RECOMMENDED_CHANNELS = [
  '字节头条/抖音图文',
  '知乎',
  '什么值得买',
  '微信公众号',
  '小红书',
  '官网',
] as const;

export const GLOBAL_RECOMMENDED_CHANNELS = [
  'Independent Blog/Docs (llms.txt + JSON-LD)',
  'Reddit',
  'Quora',
  'Trustpilot/G2',
  'Independent Review Media',
] as const;

export type ChannelRecommendationContext = {
  sourceType?: GeoBriefSource;
  socialCitations?: number;
  authorityCitations?: number;
  competitorCitations?: number;
  ecommerceCitations?: number;
  citationsEmpty?: boolean;
};

/**
 * 严格按 CN / GLOBAL 双市场隔离推荐投放渠道（GLOBAL 绝不混入任何国内平台名称）。
 */
export function recommendChannelsForMarket(
  market: GeoMarket,
  ctx?: ChannelRecommendationContext,
): GeoBriefChannelRecommendation[] {
  const sourceType = ctx?.sourceType ?? 'AUTO_GAP';
  const socialHeavy = (ctx?.socialCitations ?? 0) > 0 || sourceType === 'SENTIMENT_RISK';
  const authorityHeavy = (ctx?.authorityCitations ?? 0) > 0 || sourceType === 'CITATION_COUNTER';
  const emptyNoteCn = ctx?.citationsEmpty
    ? '（本次引擎未返回外部引用链接，优先布局高权重检索阵地补齐信源覆盖）'
    : '';
  const emptyNoteGlobal = ctx?.citationsEmpty
    ? ' (no external citations returned in this run; prioritize crawlable primary sources)'
    : '';

  if (market === 'GLOBAL') {
    const channels: GeoBriefChannelRecommendation[] = [];
    channels.push({
      channel: 'Independent Blog/Docs (llms.txt + JSON-LD)',
      reason: `Publish structured specs, comparison tables, and validated Article/FAQPage JSON-LD for ChatGPT, Perplexity, and Google AIO${emptyNoteGlobal}.`,
    });
    if (socialHeavy) {
      channels.push({
        channel: 'Reddit',
        reason:
          'Address buyer skepticism with transparent benchmarks and non-promotional community answers that AI engines frequently cite.',
      });
      channels.push({
        channel: 'Trustpilot/G2',
        reason:
          'Reinforce verified customer sentiment and concrete resolution cases to offset mixed or negative AI summaries.',
      });
    } else if (authorityHeavy) {
      channels.push({
        channel: 'Independent Review Media',
        reason:
          'Counter high-citation third-party roundups with deeper hands-on test methodology and up-to-date benchmark tables.',
      });
      channels.push({
        channel: 'Reddit',
        reason:
          'Capture high-intent comparison threads and long-tail follow-up questions surfaced in AI fan-out queries.',
      });
    } else {
      channels.push({
        channel: 'Reddit',
        reason:
          'Provide objective side-by-side discussions in category subreddits where Perplexity and ChatGPT harvest consensus.',
      });
      channels.push({
        channel: 'Quora',
        reason:
          'Cover direct buyer questions and fan-out sub-queries with concise, quotable first-paragraph answers.',
      });
    }
    return channels.slice(0, 3);
  }

  const channels: GeoBriefChannelRecommendation[] = [];
  if (socialHeavy) {
    channels.push({
      channel: '知乎',
      reason: `针对用户顾虑发布结构化实测答疑，覆盖豆包、DeepSeek 高频引用的问答语料${emptyNoteCn}。`,
    });
    channels.push({
      channel: '小红书',
      reason: '通过真实使用场景与细节实拍拆解，纠偏社区口碑并提升买前检索信任度。',
    });
    channels.push({
      channel: '官网',
      reason: '同步沉淀参数说明与权威背书页，为 AI 引擎提供可核验的一手事实信源。',
    });
  } else if (authorityHeavy) {
    channels.push({
      channel: '字节头条/抖音图文',
      reason: `强化豆包及头条系搜索生态的高权深度评测供给，直接对标竞品高引用长文${emptyNoteCn}。`,
    });
    channels.push({
      channel: '什么值得买',
      reason: '以量化横向对比表与性价比结论切入消费决策阵地，承接高意图比价查询。',
    });
    channels.push({
      channel: '微信公众号',
      reason: '沉淀完整长文与专业评测报告，补充高质量中文语义索引。',
    });
  } else {
    channels.push({
      channel: '字节头条/抖音图文',
      reason: `豆包与国内主流 AI 引擎高频抓取阵地，适合首段直答 + 参数对比表长文${emptyNoteCn}。`,
    });
    channels.push({
      channel: '知乎',
      reason: '高权重问答与专业测评社区，易被 DeepSeek 等模型直接引用推荐。',
    });
    channels.push({
      channel: '什么值得买',
      reason: '覆盖真实选购与横向横评场景，强化品牌在推荐清单中的顺位。',
    });
  }
  return channels.slice(0, 3);
}

const optionalBooleanQuerySchema = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const norm = val.trim().toLowerCase();
    if (norm === 'true' || norm === '1') return true;
    if (norm === 'false' || norm === '0') return false;
  }
  return val;
}, z.boolean().optional());

const optionalBoundedInt = (min: number, max: number, fallback: number) =>
  z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return fallback;
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      return Number(val.trim());
    }
    return val;
  }, z.number().int().min(min).max(max));

export const geoBriefListQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  status: z.enum(GEO_BRIEF_STATUSES).optional(),
  sourceType: z.enum(GEO_BRIEF_SOURCES).optional(),
  sourceRunId: z.string().trim().regex(GEO_BRIEF_ID_PATTERN, '监测任务编号格式不正确').optional(),
  runId: z.string().trim().regex(GEO_BRIEF_ID_PATTERN, '监测任务编号格式不正确').optional(),
  includeDismissed: optionalBooleanQuerySchema,
  page: optionalBoundedInt(1, 1000, 1),
  pageSize: optionalBoundedInt(1, 100, 50),
});

export type GeoBriefListQuery = z.infer<typeof geoBriefListQuerySchema>;

export const geoBriefGenerateSchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  sourceType: z.enum(GEO_BRIEF_SOURCES),
  observationIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  citationUrl: z.string().trim().url('参考引用链接格式不正确').max(2048).optional(),
  fanOutQueries: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  customPrompt: z.string().trim().min(2).max(300).optional(),
});

export type GeoBriefGenerateInput = z.infer<typeof geoBriefGenerateSchema>;

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const geoBriefFromCitationUrlSchema = z
  .object({
    market: z.enum(GEO_MARKETS).optional(),
    citationUrl: z
      .string()
      .trim()
      .min(1, '请输入有效的高引用网页链接')
      .max(2048, '网页链接过长')
      .refine(isHttpOrHttpsUrl, '仅支持以 http:// 或 https:// 开头的公开网页链接')
      .optional(),
    pastedTitle: z.string().trim().max(120).optional(),
    pastedContent: z.string().trim().min(20, '参考正文至少 20 字').max(50_000).optional(),
    targetPrompt: z.string().trim().min(2).max(300).optional(),
  })
  .refine(
    (data) => Boolean(data.citationUrl || data.pastedContent),
    '请提供目标网页链接或粘贴参考正文',
  );

export type GeoBriefFromCitationUrlInput = z.input<typeof geoBriefFromCitationUrlSchema>;
export type ParsedGeoBriefFromCitationUrlInput = z.output<typeof geoBriefFromCitationUrlSchema>;

export const geoBriefUpdateSchema = z
  .object({
    status: z.enum(GEO_BRIEF_STATUSES).optional(),
    recommendedRecipe: z.enum(GEO_RECIPES).optional(),
    targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
    suggestedTitle: z.string().trim().min(1).max(120).optional(),
    outlineH2: z.array(geoOutlineHeadingSchema).max(15).optional(),
    targetFanOuts: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    competitorFocus: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
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
