export type NearMissGapCode =
  | 'MISSING_DIRECT_ANSWER'
  | 'MISSING_COMPARISON_TABLE'
  | 'MISSING_FAQ_OR_SCHEMA'
  | 'LOW_BRAND_FACT_COVERAGE';

export type NearMissPageDiagnosis = {
  fetched: boolean;
  fetchStatus: 'OK' | 'SKIPPED_NO_URL' | 'FETCH_FALLBACK';
  fetchFallbackReason?: string;
  pageTitle: string | null;
  hasDirectAnswer: boolean;
  hasComparisonTable: boolean;
  hasFaqSection: boolean;
  hasStructuredJsonLd: boolean;
  jsonLdTypes: string[];
  brandMentionedOnPage: boolean;
  coveredFactCount: number;
  totalFactCount: number;
  missingGaps: NearMissGapCode[];
  existingHeadings: string[];
  extractedExcerpt: string;
};

export const NEAR_MISS_GAP_LABELS: Record<NearMissGapCode, string> = {
  MISSING_DIRECT_ANSWER: '首段直答缺失',
  MISSING_COMPARISON_TABLE: '缺少参数对比表',
  MISSING_FAQ_OR_SCHEMA: '缺少 FAQ/JSON-LD',
  LOW_BRAND_FACT_COVERAGE: '核心事实卡覆盖不足',
};

export const NEAR_MISS_GAP_HINTS: Record<NearMissGapCode, string> = {
  MISSING_DIRECT_ANSWER:
    '首段直答缺失：建议在文章开头 60–120 字直接给出结论、核心参数与适用建议，便于 AI 直接摘录',
  MISSING_COMPARISON_TABLE:
    '缺少参数对比表：建议增加与主流竞品的 Markdown 横向对比表（规格、价格带、实测功耗/性能与质保）',
  MISSING_FAQ_OR_SCHEMA:
    '缺少 FAQ/JSON-LD：建议在文末补充 3–5 组高频问答 FAQ 并嵌入 Article + FAQPage JSON-LD 结构化数据',
  LOW_BRAND_FACT_COVERAGE:
    '核心事实卡覆盖不足：建议在正文注入更多品牌事实卡中的量化规格、权威认证与真实客户案例',
};

const MAX_HTML_SCAN_CHARS = 256_000;
const MAX_JSON_LD_SCAN_CHARS = 512_000;
const MAX_PLAIN_TEXT_CHARS = 32_000;
const MAX_HEADINGS = 12;
const MAX_HEADINGS_SCANNED = 64;
const MAX_LEAD_PARAGRAPHS = 6;
const MAX_JSON_LD_BLOCKS = 64;
const MAX_JSON_LD_BYTES = 200_000;

const STRUCTURED_SCHEMA_TYPES = new Set([
  'faqpage',
  'article',
  'blogposting',
  'newsarticle',
  'techarticle',
  'howto',
  'product',
]);

const FLAG_RAW_SKIP = 1;
const FLAG_HEADING_CAPTURE = 2;
const FLAG_HEADING_ANY = 4;
const FLAG_NOISE_LANDMARK = 8;
const FLAG_PARA_BREAK = 16;
const FLAG_LINE_BREAK = 32;
const FLAG_CELL_SPACE = 64;
const FLAG_STRUCT = 128;

const TAG_FLAGS: Record<string, number> = {
  script: FLAG_RAW_SKIP,
  style: FLAG_RAW_SKIP,
  noscript: FLAG_RAW_SKIP,
  template: FLAG_RAW_SKIP,
  svg: FLAG_RAW_SKIP,
  title: FLAG_STRUCT,
  h1: FLAG_HEADING_CAPTURE | FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  h2: FLAG_HEADING_CAPTURE | FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  h3: FLAG_HEADING_CAPTURE | FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  h4: FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  h5: FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  h6: FLAG_HEADING_ANY | FLAG_PARA_BREAK,
  nav: FLAG_NOISE_LANDMARK | FLAG_PARA_BREAK,
  footer: FLAG_NOISE_LANDMARK | FLAG_PARA_BREAK,
  aside: FLAG_NOISE_LANDMARK | FLAG_PARA_BREAK,
  p: FLAG_PARA_BREAK,
  div: FLAG_PARA_BREAK,
  section: FLAG_PARA_BREAK,
  article: FLAG_PARA_BREAK,
  main: FLAG_PARA_BREAK,
  header: FLAG_PARA_BREAK,
  blockquote: FLAG_PARA_BREAK,
  pre: FLAG_PARA_BREAK,
  ul: FLAG_PARA_BREAK,
  ol: FLAG_PARA_BREAK,
  li: FLAG_PARA_BREAK,
  dl: FLAG_PARA_BREAK,
  dt: FLAG_PARA_BREAK,
  dd: FLAG_PARA_BREAK,
  figure: FLAG_PARA_BREAK,
  figcaption: FLAG_PARA_BREAK,
  details: FLAG_PARA_BREAK | FLAG_STRUCT,
  summary: FLAG_PARA_BREAK | FLAG_STRUCT,
  table: FLAG_PARA_BREAK | FLAG_STRUCT,
  thead: FLAG_PARA_BREAK,
  tbody: FLAG_PARA_BREAK,
  tfoot: FLAG_PARA_BREAK,
  hr: FLAG_PARA_BREAK,
  br: FLAG_LINE_BREAK,
  tr: FLAG_LINE_BREAK | FLAG_STRUCT,
  td: FLAG_CELL_SPACE | FLAG_STRUCT,
  th: FLAG_CELL_SPACE | FLAG_STRUCT,
};

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  ldquo: '"',
  rdquo: '"',
  lsquo: "'",
  rsquo: "'",
  apos: "'",
  mdash: '—',
  middot: '·',
};
const HTML_ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g;

const CLICHE_LEAD_RE =
  /^(?:随着|近年来|在当今|在现代|众所周知|in today'?s|in recent years|with the rapid)/i;
const VERDICT_CUE_RE =
  /推荐|建议|结论|适合|核心|对比|实测|best|recommend|verdict|summary|ideal for|choose/i;
const FAQ_CUE_RE = /\bFAQ\b|Frequently Asked Questions|常见问题|高频问答|常见疑问/i;
const QUESTION_LINE_RE = /^(?:Q\d*|问\d*)\s*[:：]/i;
const NUMERIC_UNIT_RE =
  /\d+(?:\.\d+)?\s*(?:db|w|kw|gb|tb|mb|gbe|ms|mm|cm|kg|mah|hz|khz|%|元|小时|年|盘位|nm|lm|usd|\$)/gi;
const ASCII_TOKEN_RE = /[a-z][a-z0-9-]{3,}/gi;
const CJK_SEQ_RE = /[\u4e00-\u9fa5]{2,}/g;

const KEYWORD_STOPWORDS = new Set([
  'with',
  'from',
  'that',
  'this',
  'have',
  'will',
  'your',
  'their',
  'about',
  'which',
  'when',
  'where',
  'more',
  'than',
  'into',
  'also',
  'very',
  'just',
  'some',
  'other',
  'product',
  'brand',
  'guide',
  'specs',
  '产品',
  '参数',
  '品牌',
  '支持',
  '提供',
  '具有',
  '采用',
  '实现',
  '进行',
  '以及',
  '可以',
  '用于',
  '我们',
]);

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphaNum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

function isTagBoundaryCode(code: number): boolean {
  return code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13;
}

function isTagBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return isTagBoundaryCode(ch.charCodeAt(0));
}

function findFirstNonWhitespaceInSlice(str: string, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (!isAsciiWhitespace(str.charCodeAt(i))) return i;
  }
  return -1;
}

function findLastNonWhitespaceInSlice(str: string, start: number, end: number): number {
  for (let i = end - 1; i >= start; i -= 1) {
    if (!isAsciiWhitespace(str.charCodeAt(i))) return i;
  }
  return -1;
}

function decodeHtmlEntitiesFast(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(HTML_ENTITY_RE, (full, dec?: string, hex?: string, named?: string) => {
    if (dec) {
      const code = Number(dec);
      return Number.isSafeInteger(code) && code > 31 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    if (hex) {
      const code = parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 31 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    if (named) {
      return NAMED_HTML_ENTITIES[named.toLowerCase()] ?? full;
    }
    return full;
  });
}

function collapseSpaces(input: string): string {
  return decodeHtmlEntitiesFast(input).replace(/\s+/g, ' ').trim();
}

/**
 * 线性时间（O(m)）解析 `<script ...>` 开标签属性，精确匹配独立 `type` 属性，
 * 自动跳过 `data-type`、布尔属性及引号内包含的干扰字符。
 */
function extractTypeAttrFromScriptOpenTag(openTagAttrs: string): string {
  const len = openTagAttrs.length;
  let i = 0;

  while (i < len) {
    while (
      i < len &&
      (isAsciiWhitespace(openTagAttrs.charCodeAt(i)) || openTagAttrs.charCodeAt(i) === 47)
    ) {
      i += 1;
    }
    if (i >= len) break;

    const nameStart = i;
    while (i < len) {
      const ch = openTagAttrs.charCodeAt(i);
      if (isAsciiWhitespace(ch) || ch === 61 || ch === 47 || ch === 62) break;
      i += 1;
    }
    const attrName = openTagAttrs.slice(nameStart, i).toLowerCase();
    if (!attrName) {
      i += 1;
      continue;
    }

    while (i < len && isAsciiWhitespace(openTagAttrs.charCodeAt(i))) {
      i += 1;
    }

    // Boolean attribute (no '=')
    if (i >= len || openTagAttrs.charCodeAt(i) !== 61) {
      continue;
    }

    // Consume '=' and optional whitespace
    i += 1;
    while (i < len && isAsciiWhitespace(openTagAttrs.charCodeAt(i))) {
      i += 1;
    }
    if (i >= len) break;

    let value = '';
    const quoteCode = openTagAttrs.charCodeAt(i);
    if (quoteCode === 34 || quoteCode === 39) {
      const quoteChar = quoteCode === 34 ? '"' : "'";
      const closeIdx = openTagAttrs.indexOf(quoteChar, i + 1);
      if (closeIdx < 0) {
        value = openTagAttrs.slice(i + 1).trim();
        i = len;
      } else {
        value = openTagAttrs.slice(i + 1, closeIdx).trim();
        i = closeIdx + 1;
      }
    } else {
      const valStart = i;
      while (i < len) {
        const ch = openTagAttrs.charCodeAt(i);
        if (isAsciiWhitespace(ch) || ch === 62) break;
        i += 1;
      }
      value = openTagAttrs.slice(valStart, i).trim();
    }

    if (attrName === 'type') {
      return value;
    }
  }

  return '';
}

function collectJsonLdTypes(node: unknown, out: string[], seen: Set<string>, depth = 0): void {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdTypes(item, out, seen, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const rawType = obj['@type'];
  if (typeof rawType === 'string') {
    const trimmed = rawType.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  } else if (Array.isArray(rawType)) {
    for (const entry of rawType) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          out.push(trimmed);
        }
      }
    }
  }
  if (Array.isArray(obj['@graph'])) {
    collectJsonLdTypes(obj['@graph'], out, seen, depth + 1);
  }
}

function parseScriptJsonLdBlock(
  attrs: string,
  body: string,
  out: string[],
  seen: Set<string>,
): void {
  const mediaType = extractTypeAttrFromScriptOpenTag(attrs).split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/ld+json') return;
  const jsonText = body.trim();
  if (!jsonText || jsonText.length > MAX_JSON_LD_BYTES) return;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    collectJsonLdTypes(parsed, out, seen);
  } catch {
    // Malformed JSON-LD is treated gracefully as absent
  }
}

/**
 * 线性时间（O(n)，无回溯正则）扫描 HTML 中的 `<script type="application/ld+json">` 块并收集 `@type`。
 */
export function extractJsonLdTypesFromHtml(rawHtml: string): string[] {
  const html =
    rawHtml.length > MAX_JSON_LD_SCAN_CHARS ? rawHtml.slice(0, MAX_JSON_LD_SCAN_CHARS) : rawHtml;
  if (!/<script/i.test(html)) {
    return [];
  }
  const lower = html.toLowerCase();
  const types: string[] = [];
  const seen = new Set<string>();

  let pos = 0;
  let scannedBlocks = 0;
  while (pos < lower.length && scannedBlocks < MAX_JSON_LD_BLOCKS) {
    const start = lower.indexOf('<script', pos);
    if (start < 0) break;
    const afterTag = lower[start + 7];
    if (!isTagBoundaryChar(afterTag)) {
      pos = start + 7;
      continue;
    }

    const openEnd = lower.indexOf('>', start + 7);
    if (openEnd < 0) break;

    const closeStart = lower.indexOf('</script', openEnd + 1);
    if (closeStart < 0) break;

    scannedBlocks += 1;
    parseScriptJsonLdBlock(
      html.slice(start + 7, openEnd),
      html.slice(openEnd + 1, closeStart),
      types,
      seen,
    );

    const closeEnd = lower.indexOf('>', closeStart + 8);
    pos = closeEnd >= 0 ? closeEnd + 1 : lower.length;
  }

  return types;
}

type LinearHtmlScanResult = {
  pageTitle: string | null;
  firstH1: string | null;
  existingHeadings: string[];
  plainText: string;
  leadParagraphs: string[];
  hasHtmlTable: boolean;
  hasDetailsSummary: boolean;
  jsonLdTypes: string[];
  unclosedScriptStart: number;
};

function flushLeadBuffer(currentLeadParts: string[], leadParagraphs: string[]): void {
  if (currentLeadParts.length === 0) return;
  if (leadParagraphs.length >= MAX_LEAD_PARAGRAPHS) {
    currentLeadParts.length = 0;
    return;
  }
  const raw = currentLeadParts.join('');
  currentLeadParts.length = 0;
  if (raw.includes('\n')) {
    const subParas = raw.split(/\r?\n[ \t]*\r?\n+/);
    for (const sub of subParas) {
      if (leadParagraphs.length >= MAX_LEAD_PARAGRAPHS) break;
      const cleaned = collapseSpaces(sub);
      if (cleaned) leadParagraphs.push(cleaned);
    }
    return;
  }
  const cleaned = collapseSpaces(raw);
  if (cleaned) {
    leadParagraphs.push(cleaned);
  }
}

function flushHeadingBuffer(
  tag: string,
  headingParts: string[],
  existingHeadings: string[],
  seenHeadingsLower: Set<string>,
  currentFirstH1: string | null,
): string | null {
  const cleaned = collapseSpaces(headingParts.join(''));
  headingParts.length = 0;
  if (cleaned.length < 2) return currentFirstH1;
  let firstH1 = currentFirstH1;
  if (tag === 'h1' && !firstH1) {
    firstH1 = cleaned.slice(0, 300);
  }
  if (existingHeadings.length < MAX_HEADINGS && cleaned.length <= 160) {
    const key = cleaned.toLowerCase();
    if (!seenHeadingsLower.has(key)) {
      seenHeadingsLower.add(key);
      existingHeadings.push(cleaned);
    }
  }
  return firstH1;
}

/**
 * 单遍严格线性时间 O(n) HTML 扫描器（零回溯正则、零闭包堆捕获）：
 * 同时提取 `<title>`、`<h1>`-`<h3>` 标题、可见正文文本、首段候选、`<table>` 信号、
 * `<details>/<summary>` 信号与 `<script type="application/ld+json">` 结构化数据。
 */
function scanHtmlLinear(boundedHtml: string): LinearHtmlScanResult {
  const len = boundedHtml.length;
  let lowerHtml: string | null = null;

  let titleDone = false;
  let inTitle = false;
  const titleParts: string[] = [];
  let titleChars = 0;

  let firstH1: string | null = null;
  let activeHeadingTag: string | null = null;
  const headingParts: string[] = [];
  let headingChars = 0;
  let allHeadingDepth = 0;
  const existingHeadings: string[] = [];
  const seenHeadingsLower = new Set<string>();
  let scannedHeadings = 0;
  let scannedH1s = 0;

  let noiseLandmarkDepth = 0;
  const leadParagraphs: string[] = [];
  const currentLeadParts: string[] = [];
  let currentLeadChars = 0;

  const bodyParts: string[] = [];
  let bodyChars = 0;
  let lastSep = 2; // 0 = none, 1 = space, 2 = '\n\n', 3 = '\n'

  let tableCount = 0;
  let trCount = 0;
  let thCount = 0;
  let tdCount = 0;
  let hasDetails = false;
  let hasSummary = false;

  const jsonLdTypes: string[] = [];
  const seenJsonLdTypes = new Set<string>();
  let scannedJsonLdBlocks = 0;
  let unclosedScriptStart = -1;

  let pos = 0;
  while (pos < len) {
    const ltIdx = boundedHtml.indexOf('<', pos);
    const textEnd = ltIdx < 0 ? len : ltIdx;

    if (textEnd > pos) {
      if (inTitle) {
        if (titleChars < 1024) {
          const seg = boundedHtml.slice(pos, textEnd);
          titleParts.push(seg);
          titleChars += seg.length;
        }
      } else {
        const needHeading = activeHeadingTag !== null && headingChars < 512;
        const needBody = bodyChars < MAX_PLAIN_TEXT_CHARS;
        const needLead =
          leadParagraphs.length < MAX_LEAD_PARAGRAPHS &&
          noiseLandmarkDepth === 0 &&
          allHeadingDepth === 0 &&
          currentLeadChars < 2048;

        if (needHeading || needBody || needLead) {
          const firstNonWs = findFirstNonWhitespaceInSlice(boundedHtml, pos, textEnd);
          if (firstNonWs < 0) {
            if (needHeading && headingParts.length > 0) {
              headingParts.push(' ');
              headingChars += 1;
            }
            if (needBody && bodyChars > 0 && lastSep === 0) {
              bodyParts.push(' ');
              bodyChars += 1;
              lastSep = 1;
            }
            if (needLead && currentLeadParts.length > 0) {
              currentLeadParts.push(' ');
              currentLeadChars += 1;
            }
          } else {
            if (needHeading) {
              const headingStart = headingParts.length === 0 ? firstNonWs : pos;
              const remaining = 512 - headingChars;
              const headingEnd = Math.min(textEnd, headingStart + remaining);
              const chunk = boundedHtml.slice(headingStart, headingEnd);
              headingParts.push(chunk);
              headingChars += chunk.length;
            }
            if (needBody) {
              if (bodyChars > 0 && lastSep === 0 && firstNonWs > pos) {
                bodyParts.push(' ');
                bodyChars += 1;
                lastSep = 1;
              }
              if (bodyChars < MAX_PLAIN_TEXT_CHARS) {
                const bodyEnd = findLastNonWhitespaceInSlice(boundedHtml, firstNonWs, textEnd) + 1;
                const hasTrailingWs = bodyEnd < textEnd;
                const remaining = MAX_PLAIN_TEXT_CHARS - bodyChars;
                const contentLen = bodyEnd - firstNonWs;
                if (contentLen >= remaining) {
                  bodyParts.push(boundedHtml.slice(firstNonWs, firstNonWs + remaining));
                  bodyChars += remaining;
                  lastSep = 0;
                } else {
                  bodyParts.push(boundedHtml.slice(firstNonWs, bodyEnd));
                  bodyChars += contentLen;
                  if (hasTrailingWs && bodyChars < MAX_PLAIN_TEXT_CHARS) {
                    bodyParts.push(' ');
                    bodyChars += 1;
                    lastSep = 1;
                  } else {
                    lastSep = 0;
                  }
                }
              }
            }
            if (needLead) {
              const leadStart = currentLeadParts.length === 0 ? firstNonWs : pos;
              const remaining = 2048 - currentLeadChars;
              const leadEnd = Math.min(textEnd, leadStart + remaining);
              const chunk = boundedHtml.slice(leadStart, leadEnd);
              currentLeadParts.push(chunk);
              currentLeadChars += chunk.length;
            }
          }
        }
      }
    }

    if (ltIdx < 0) break;
    if (ltIdx + 1 >= len) {
      unclosedScriptStart = ltIdx;
      break;
    }
    const nextCode = boundedHtml.charCodeAt(ltIdx + 1);

    // HTML comment or declaration (`<!-- ... -->`, `<!DOCTYPE ...>`)
    if (nextCode === 33) {
      if (boundedHtml.startsWith('<!--', ltIdx)) {
        const commentEnd = boundedHtml.indexOf('-->', ltIdx + 4);
        if (commentEnd < 0) break;
        pos = commentEnd + 3;
      } else {
        const declEnd = boundedHtml.indexOf('>', ltIdx + 2);
        if (declEnd < 0) break;
        pos = declEnd + 1;
      }
      continue;
    }

    // Processing instruction (`<?xml ... ?>`)
    if (nextCode === 63) {
      const piEnd = boundedHtml.indexOf('>', ltIdx + 2);
      if (piEnd < 0) break;
      pos = piEnd + 1;
      continue;
    }

    const isClosing = nextCode === 47;
    const nameStart = isClosing ? ltIdx + 2 : ltIdx + 1;
    if (nameStart >= len) break;
    const firstNameCode = boundedHtml.charCodeAt(nameStart);
    if (!isAsciiLetter(firstNameCode)) {
      if (!inTitle && bodyChars < MAX_PLAIN_TEXT_CHARS) {
        bodyParts.push('<');
        bodyChars += 1;
        lastSep = 0;
      }
      pos = ltIdx + 1;
      continue;
    }

    let hasUpper = firstNameCode <= 90;
    let nameEnd = nameStart + 1;
    while (nameEnd < len) {
      const code = boundedHtml.charCodeAt(nameEnd);
      if (!isAsciiAlphaNum(code)) break;
      if (code >= 65 && code <= 90) hasUpper = true;
      nameEnd += 1;
    }

    if (nameEnd < len && !isTagBoundaryCode(boundedHtml.charCodeAt(nameEnd))) {
      if (!inTitle && bodyChars < MAX_PLAIN_TEXT_CHARS) {
        bodyParts.push('<');
        bodyChars += 1;
        lastSep = 0;
      }
      pos = ltIdx + 1;
      continue;
    }

    const openEnd = boundedHtml.indexOf('>', nameEnd);
    if (openEnd < 0) {
      if (!isClosing) {
        const rawOpenName = boundedHtml.slice(nameStart, nameEnd);
        const lowerOpenName = hasUpper ? rawOpenName.toLowerCase() : rawOpenName;
        if (lowerOpenName === 'script' || (nameEnd === len && 'script'.startsWith(lowerOpenName))) {
          unclosedScriptStart = ltIdx;
        }
      }
      break;
    }

    // Fast path for 1-character tags (<p>, <a>, <b>, <i>, etc.) without slicing
    if (nameEnd - nameStart === 1) {
      if (firstNameCode === 112 || firstNameCode === 80) {
        if (currentLeadParts.length > 0) {
          flushLeadBuffer(currentLeadParts, leadParagraphs);
          currentLeadChars = 0;
        }
        if (bodyChars > 0 && bodyChars < MAX_PLAIN_TEXT_CHARS && lastSep !== 2) {
          bodyParts.push('\n\n');
          bodyChars += 2;
          lastSep = 2;
        }
      }
      pos = openEnd + 1;
      continue;
    }

    const rawName = boundedHtml.slice(nameStart, nameEnd);
    const tagName = hasUpper ? rawName.toLowerCase() : rawName;
    const flags = TAG_FLAGS[tagName] ?? 0;

    if (flags === 0) {
      pos = openEnd + 1;
      continue;
    }

    if (isClosing) {
      if ((flags & FLAG_STRUCT) !== 0 && tagName === 'title' && inTitle) {
        inTitle = false;
        titleDone = true;
      } else if ((flags & FLAG_HEADING_ANY) !== 0) {
        if (activeHeadingTag === tagName) {
          firstH1 = flushHeadingBuffer(
            activeHeadingTag,
            headingParts,
            existingHeadings,
            seenHeadingsLower,
            firstH1,
          );
          activeHeadingTag = null;
          headingChars = 0;
        }
        allHeadingDepth = Math.max(0, allHeadingDepth - 1);
      } else if ((flags & FLAG_NOISE_LANDMARK) !== 0) {
        noiseLandmarkDepth = Math.max(0, noiseLandmarkDepth - 1);
      }

      if ((flags & (FLAG_PARA_BREAK | FLAG_LINE_BREAK)) !== 0 && currentLeadParts.length > 0) {
        flushLeadBuffer(currentLeadParts, leadParagraphs);
        currentLeadChars = 0;
      }
      if (bodyChars > 0 && bodyChars < MAX_PLAIN_TEXT_CHARS) {
        if ((flags & FLAG_PARA_BREAK) !== 0) {
          if (lastSep !== 2) {
            bodyParts.push('\n\n');
            bodyChars += 2;
            lastSep = 2;
          }
        } else if ((flags & FLAG_LINE_BREAK) !== 0) {
          if (lastSep !== 2 && lastSep !== 3) {
            bodyParts.push('\n');
            bodyChars += 1;
            lastSep = 3;
          }
        } else if ((flags & FLAG_CELL_SPACE) !== 0 && lastSep === 0) {
          bodyParts.push(' ');
          bodyChars += 1;
          lastSep = 1;
        }
      }
      pos = openEnd + 1;
      continue;
    }

    const selfClosing = openEnd > nameEnd && boundedHtml.charCodeAt(openEnd - 1) === 47;

    if ((flags & FLAG_RAW_SKIP) !== 0) {
      if (selfClosing) {
        pos = openEnd + 1;
        continue;
      }
      if (lowerHtml === null) {
        lowerHtml = boundedHtml.toLowerCase();
      }
      const closeNeedle = `</${tagName}`;
      const closeStart = lowerHtml.indexOf(closeNeedle, openEnd + 1);
      if (closeStart < 0) {
        if (tagName === 'script') {
          unclosedScriptStart = ltIdx;
        }
        break;
      }
      if (tagName === 'script' && scannedJsonLdBlocks < MAX_JSON_LD_BLOCKS) {
        scannedJsonLdBlocks += 1;
        parseScriptJsonLdBlock(
          boundedHtml.slice(nameEnd, openEnd),
          boundedHtml.slice(openEnd + 1, closeStart),
          jsonLdTypes,
          seenJsonLdTypes,
        );
      }
      const closeEnd = lowerHtml.indexOf('>', closeStart + closeNeedle.length);
      pos = closeEnd >= 0 ? closeEnd + 1 : len;
      continue;
    }

    if ((flags & FLAG_STRUCT) !== 0) {
      if (tagName === 'title') {
        if (!selfClosing && !titleDone) {
          inTitle = true;
        }
        pos = openEnd + 1;
        continue;
      }
      if (tagName === 'table') {
        if (tableCount < 1) tableCount += 1;
      } else if (tagName === 'tr') {
        if (trCount < 2) trCount += 1;
      } else if (tagName === 'th') {
        if (thCount < 1) thCount += 1;
      } else if (tagName === 'td') {
        if (tdCount < 4) tdCount += 1;
      } else if (tagName === 'details') {
        hasDetails = true;
      } else if (tagName === 'summary') {
        hasSummary = true;
      }
    }

    if (currentLeadParts.length > 0) {
      if ((flags & FLAG_PARA_BREAK) !== 0 || tagName === 'tr') {
        flushLeadBuffer(currentLeadParts, leadParagraphs);
        currentLeadChars = 0;
      } else if ((flags & FLAG_LINE_BREAK) !== 0 && currentLeadChars < 2048) {
        currentLeadParts.push(' ');
        currentLeadChars += 1;
      }
    }

    if (!selfClosing) {
      if ((flags & FLAG_HEADING_ANY) !== 0) {
        allHeadingDepth += 1;
        if ((flags & FLAG_HEADING_CAPTURE) !== 0) {
          if (activeHeadingTag !== null) {
            firstH1 = flushHeadingBuffer(
              activeHeadingTag,
              headingParts,
              existingHeadings,
              seenHeadingsLower,
              firstH1,
            );
            activeHeadingTag = null;
            headingChars = 0;
          }
          const canCaptureMoreHeadings =
            scannedHeadings < MAX_HEADINGS_SCANNED && existingHeadings.length < MAX_HEADINGS;
          const canCaptureFirstH1 =
            tagName === 'h1' && firstH1 === null && scannedH1s < MAX_HEADINGS_SCANNED;
          if (canCaptureMoreHeadings || canCaptureFirstH1) {
            scannedHeadings += 1;
            if (tagName === 'h1') scannedH1s += 1;
            activeHeadingTag = tagName;
            headingParts.length = 0;
            headingChars = 0;
          }
        }
      } else if ((flags & FLAG_NOISE_LANDMARK) !== 0) {
        noiseLandmarkDepth += 1;
      }
    }

    if (bodyChars > 0 && bodyChars < MAX_PLAIN_TEXT_CHARS) {
      if ((flags & FLAG_PARA_BREAK) !== 0) {
        if (lastSep !== 2) {
          bodyParts.push('\n\n');
          bodyChars += 2;
          lastSep = 2;
        }
      } else if ((flags & FLAG_LINE_BREAK) !== 0) {
        if (lastSep !== 2 && lastSep !== 3) {
          bodyParts.push('\n');
          bodyChars += 1;
          lastSep = 3;
        }
      } else if ((flags & FLAG_CELL_SPACE) !== 0 && lastSep === 0) {
        bodyParts.push(' ');
        bodyChars += 1;
        lastSep = 1;
      }
    }

    pos = openEnd + 1;
  }

  if (activeHeadingTag !== null) {
    firstH1 = flushHeadingBuffer(
      activeHeadingTag,
      headingParts,
      existingHeadings,
      seenHeadingsLower,
      firstH1,
    );
  }
  if (currentLeadParts.length > 0) {
    flushLeadBuffer(currentLeadParts, leadParagraphs);
  }

  const rawTitle = titleParts.length > 0 ? collapseSpaces(titleParts.join('')).slice(0, 300) : '';
  const pageTitle = rawTitle || firstH1 || null;
  const plainText = bodyParts.length > 0 ? decodeHtmlEntitiesFast(bodyParts.join('')).trim() : '';
  const hasHtmlTable = tableCount >= 1 && trCount >= 2 && (thCount >= 1 || tdCount >= 4);

  return {
    pageTitle,
    firstH1,
    existingHeadings,
    plainText,
    leadParagraphs,
    hasHtmlTable,
    hasDetailsSummary: hasDetails && hasSummary,
    jsonLdTypes,
    unclosedScriptStart,
  };
}

function hasMarkdownTable(text: string): boolean {
  if (!text.includes('|')) return false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = lines[i]!.trim();
    const divider = lines[i + 1]!.trim();
    if (!header.startsWith('|') || !header.endsWith('|')) continue;
    if (!divider.startsWith('|') || !divider.endsWith('|')) continue;
    const cells = divider
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length >= 2 && cells.every((c) => c.length >= 2 && /^:?-{2,}:?$/.test(c))) {
      return true;
    }
  }
  return false;
}

function countQuestionLinesCapped(text: string, cap: number): number {
  let count = 0;
  let pos = 0;
  const len = text.length;
  while (pos < len && count < cap) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? len : nl;
    let start = pos;
    while (start < end && isAsciiWhitespace(text.charCodeAt(start))) {
      start += 1;
    }
    if (end - start >= 2) {
      const ch = text.charCodeAt(start);
      // Fast pre-filter: 'Q' (81), 'q' (113), or '问' (38382)
      if (ch === 81 || ch === 113 || ch === 38382) {
        const line = text.slice(start, Math.min(end, start + 16));
        if (QUESTION_LINE_RE.test(line)) {
          count += 1;
        }
      }
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return count;
}

function detectDirectAnswerLead(
  leadParagraphs: readonly string[],
  plainText: string,
  pageTitle: string | null,
  firstH1: string | null,
  normalizedBrandTerms: readonly string[],
): boolean {
  const normalizedTitle = (pageTitle ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedH1 = (firstH1 ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  const candidates =
    leadParagraphs.length > 0
      ? leadParagraphs
      : plainText
          .slice(0, 4000)
          .split(/\r?\n[ \t]*\r?\n+/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter((p) => p.length > 0);

  let firstParagraph: string | null = null;
  for (const para of candidates) {
    const lowerPara = para.toLowerCase();
    if (normalizedTitle && lowerPara === normalizedTitle) continue;
    if (normalizedH1 && lowerPara === normalizedH1) continue;
    firstParagraph = para;
    break;
  }
  if (!firstParagraph) return false;

  const nonWsLen = Array.from(firstParagraph.replace(/\s+/g, '')).length;
  if (nonWsLen < 20) return false;

  const firstSentenceMatch = firstParagraph.match(/^[^。！？.!?\n]+[。！？.!?]?/);
  const firstSentenceLen = firstSentenceMatch
    ? Array.from(firstSentenceMatch[0].replace(/\s+/g, '')).length
    : nonWsLen;
  if (nonWsLen > 260 && firstSentenceLen > 120) return false;

  if (CLICHE_LEAD_RE.test(firstParagraph)) return false;

  const lower = firstParagraph.toLowerCase();
  const mentionsBrand = normalizedBrandTerms.some(
    (term) => term.length > 0 && lower.includes(term),
  );
  const hasMetric = /\d/.test(firstParagraph);
  const hasVerdict = VERDICT_CUE_RE.test(firstParagraph);

  return mentionsBrand || hasMetric || hasVerdict;
}

function extractFactAnchors(
  title: string,
  content: string,
): {
  numericAnchors: string[];
  keywordAnchors: string[];
} {
  const combined = `${title} ${content}`;
  const numericSet = new Set<string>();
  for (const m of combined.matchAll(NUMERIC_UNIT_RE)) {
    const token = m[0].replace(/\s+/g, '').toLowerCase();
    if (token.length >= 2) numericSet.add(token);
  }

  const keywordSet = new Set<string>();
  for (const m of combined.matchAll(ASCII_TOKEN_RE)) {
    const token = m[0].toLowerCase();
    if (!KEYWORD_STOPWORDS.has(token)) {
      keywordSet.add(token);
    }
  }
  for (const m of combined.matchAll(CJK_SEQ_RE)) {
    const seq = m[0];
    if (seq.length <= 6) {
      if (!KEYWORD_STOPWORDS.has(seq)) keywordSet.add(seq);
    } else {
      // Sample 2-4 char chunks for long CJK phrases
      for (let i = 0; i + 2 <= Math.min(seq.length, 16); i += 2) {
        const sub = seq.slice(i, i + 2);
        if (!KEYWORD_STOPWORDS.has(sub)) keywordSet.add(sub);
      }
    }
  }

  return {
    numericAnchors: [...numericSet].slice(0, 12),
    keywordAnchors: [...keywordSet].slice(0, 20),
  };
}

export function diagnoseNearMissPageHtml(input: {
  rawHtml: string;
  pageUrl: string;
  brandNames: readonly string[];
  brandFacts: ReadonlyArray<{ id: string; slot: string; title: string; content: string }>;
}): NearMissPageDiagnosis {
  const boundedHtml =
    input.rawHtml.length > MAX_HTML_SCAN_CHARS
      ? input.rawHtml.slice(0, MAX_HTML_SCAN_CHARS)
      : input.rawHtml;

  const scanned = scanHtmlLinear(boundedHtml);
  const { pageTitle, firstH1, existingHeadings, plainText, leadParagraphs } = scanned;
  const hasStructuredInHead = scanned.jsonLdTypes.some((t) =>
    STRUCTURED_SCHEMA_TYPES.has(t.toLowerCase()),
  );
  const hasFaqInHead = scanned.jsonLdTypes.some((t) => t.toLowerCase() === 'faqpage');

  let jsonLdTypes = scanned.jsonLdTypes;
  if (input.rawHtml.length > MAX_HTML_SCAN_CHARS && (!hasStructuredInHead || !hasFaqInHead)) {
    const tailStart =
      scanned.unclosedScriptStart >= 0 ? scanned.unclosedScriptStart : MAX_HTML_SCAN_CHARS;
    const tailTypes = extractJsonLdTypesFromHtml(
      input.rawHtml.slice(tailStart, MAX_JSON_LD_SCAN_CHARS),
    );
    if (tailTypes.length > 0) {
      const seen = new Set(scanned.jsonLdTypes);
      jsonLdTypes = [...scanned.jsonLdTypes];
      for (const t of tailTypes) {
        if (!seen.has(t)) {
          seen.add(t);
          jsonLdTypes.push(t);
        }
      }
    }
  }
  const extractedExcerpt = plainText.slice(0, 6000);

  const normalizedBrandTerms = Array.from(
    new Set(input.brandNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2)),
  );

  // 1. Direct answer lead
  const hasDirectAnswer = detectDirectAnswerLead(
    leadParagraphs,
    plainText,
    pageTitle,
    firstH1,
    normalizedBrandTerms,
  );

  // 2. Comparison table (single-pass HTML tag scan or Markdown table)
  const hasComparisonTable = scanned.hasHtmlTable || hasMarkdownTable(plainText);

  // 3. FAQ section & structured JSON-LD
  const lowerTypes = new Set(jsonLdTypes.map((t) => t.toLowerCase()));
  const hasStructuredJsonLd = [...lowerTypes].some((t) => STRUCTURED_SCHEMA_TYPES.has(t));
  const hasFaqPageJsonLd = lowerTypes.has('faqpage');

  const questionHeadingsCount = existingHeadings.filter((h) => /[?？]\s*$/.test(h)).length;
  const hasFaqSection =
    scanned.hasDetailsSummary ||
    existingHeadings.some((h) => FAQ_CUE_RE.test(h)) ||
    questionHeadingsCount >= 2 ||
    FAQ_CUE_RE.test(plainText) ||
    countQuestionLinesCapped(plainText, 2) >= 2;

  // 4. BrandFact + brand name coverage
  const pageTextLower = `${pageTitle ?? ''}\n${plainText}`.toLowerCase();
  const brandMentionedOnPage = normalizedBrandTerms.some((term) => pageTextLower.includes(term));

  const nonEmptyFacts = input.brandFacts.filter(
    (f) => f.title.trim().length > 0 || f.content.trim().length > 0,
  );
  let pageTextCompact: string | null = null;
  let coveredFactCount = 0;
  for (const fact of nonEmptyFacts) {
    const { numericAnchors, keywordAnchors } = extractFactAnchors(fact.title, fact.content);
    if (numericAnchors.length > 0) {
      if (pageTextCompact === null) {
        pageTextCompact = pageTextLower.replace(/\s+/g, '');
      }
      if (numericAnchors.some((tok) => pageTextCompact!.includes(tok))) {
        coveredFactCount += 1;
        continue;
      }
    }
    let kwHits = 0;
    for (const kw of keywordAnchors) {
      if (pageTextLower.includes(kw)) {
        kwHits += 1;
        if (kwHits >= 2) break;
      }
    }
    if (kwHits >= 2) {
      coveredFactCount += 1;
    }
  }

  const totalFactCount = nonEmptyFacts.length;
  const hasLowFactCoverage =
    !brandMentionedOnPage ||
    totalFactCount === 0 ||
    coveredFactCount < Math.min(2, totalFactCount) ||
    coveredFactCount / totalFactCount < 0.5;

  const missingGaps: NearMissGapCode[] = [];
  if (!hasDirectAnswer) missingGaps.push('MISSING_DIRECT_ANSWER');
  if (!hasComparisonTable) missingGaps.push('MISSING_COMPARISON_TABLE');
  if (!hasStructuredJsonLd || (!hasFaqSection && !hasFaqPageJsonLd)) {
    missingGaps.push('MISSING_FAQ_OR_SCHEMA');
  }
  if (hasLowFactCoverage) missingGaps.push('LOW_BRAND_FACT_COVERAGE');

  return {
    fetched: true,
    fetchStatus: 'OK',
    pageTitle,
    hasDirectAnswer,
    hasComparisonTable,
    hasFaqSection,
    hasStructuredJsonLd,
    jsonLdTypes,
    brandMentionedOnPage,
    coveredFactCount,
    totalFactCount,
    missingGaps,
    existingHeadings,
    extractedExcerpt,
  };
}
