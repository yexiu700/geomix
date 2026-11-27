import { z } from 'zod';
import {
  BRAND_ID_PATTERN,
  GEO_MARKETS,
  containsCjk,
  resolveGlobalCategoryLabel,
  type GeoMarket,
} from './brands';
import type { GeoComplianceFlag } from './compliance';
import {
  extractMissingFactSlots,
  markdownToSanitizedHtml,
  stripHtmlTagsLinear,
  stripHtmlToText,
  type GeoArticleStatus,
  type GeoRecipe,
  type GeoTargetFormat,
} from './geo-studio';
import {
  VISIBILITY_ENGINE_KEYS,
  VISIBILITY_ENGINE_LABELS,
  findRetiredVisibilityEngines,
} from './visibility';
import type {
  ChannelProvider,
  CrawlProbeReport,
  CrawlProbeStatus,
  DistributionSummaryDto,
  GeoRetestScheduleDto,
  RetestBudgetSummaryDto,
} from './distribution';

/**
 * GeoMix 2.0 交付包、GEO 0–100 体检、发布登记与复测闭环、行动首页契约（Issue #326 / #333）。
 * 同时承载从 articles.ts 抽取复用的 HTML 富文本清洗、字数统计、MD/HTML/DOCX/ZIP 导出工具。
 */

export const ARTICLE_EXPORT_FORMATS = ['md', 'html', 'docx'] as const;
export type ArticleArchiveFormat = (typeof ARTICLE_EXPORT_FORMATS)[number];

export type ExportableArticleDoc = {
  id: string;
  title: string;
  categoryName?: string | null;
  coverUrl?: string | null;
  contentHtml: string;
  contentText: string;
  contentMarkdown?: string;
  locale?: string;
  createdAt?: string;
};

// ==================== 富文本白名单清洗、字数统计与导出（从 articles.ts 抽取） ====================

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeSafeExportUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/[\u0000-\u001f\u007f\s"'<>]/.test(trimmed) || /&#/i.test(trimmed)) {
    return null;
  }
  const decoded = decodeHtmlEntities(trimmed).trim();
  if (!decoded || /[\u0000-\u001f\u007f\s"'<>]/.test(decoded)) {
    return null;
  }
  if (/^https?:\/\//i.test(decoded)) {
    try {
      const parsed = new URL(decoded);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname.length > 0
      ) {
        return decoded;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.startsWith('/\\')) {
    return decoded;
  }
  return null;
}

const DANGEROUS_PAIRED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'form',
  'textarea',
  'select',
  'noscript',
  'template',
  'math',
]);
const DANGEROUS_VOID_TAGS = new Set(['input', 'button']);
const SELF_CLOSING_DANGEROUS_TAGS = new Set(['embed', 'svg', 'math', 'input', 'button']);
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

function isAsciiHtmlStartChar(code: number): boolean {
  return isAsciiLetter(code) || code === 33 || code === 63;
}

function stripTrailingUnclosedTag(input: string): string {
  const lastGt = input.lastIndexOf('>');
  const tailStart = lastGt + 1;
  const len = input.length;
  let pos = tailStart;
  while (pos < len) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) return input;
    const nextIdx = lt + 1;
    if (nextIdx >= len) return input;
    const nextCode = input.charCodeAt(nextIdx);
    // HTML5 §13.2.5.6 (Tag open state): `<` only opens a tag, declaration, or PI when immediately
    // followed (with zero whitespace/newline skipping) by ASCII alpha, `!`, `?`, or `/` + HTML start char.
    if (isAsciiHtmlStartChar(nextCode)) {
      return input.slice(0, lt);
    }
    if (
      nextCode === 47 &&
      nextIdx + 1 < len &&
      isAsciiHtmlStartChar(input.charCodeAt(nextIdx + 1))
    ) {
      return input.slice(0, lt);
    }
    pos = nextIdx;
  }
  return input;
}

function stripHtmlComments(input: string): string {
  if (!input.includes('<!--')) return input;
  let out = '';
  let i = 0;
  const len = input.length;
  while (i < len) {
    const start = input.indexOf('<!--', i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, start);
    const end = input.indexOf('-->', start + 4);
    if (end === -1) {
      break;
    }
    i = end + 3;
  }
  return out;
}

function stripHtmlCdata(input: string): string {
  if (!input.includes('<![')) return input;
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  const len = input.length;
  while (i < len) {
    const start = lower.indexOf('<![cdata[', i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, start);
    const end = input.indexOf(']]>', start + 9);
    if (end === -1) {
      break;
    }
    i = end + 3;
  }
  return out;
}

function stripHtmlProcessingInstructions(input: string): string {
  if (!input.includes('<?')) return input;
  let out = '';
  let i = 0;
  const len = input.length;
  while (i < len) {
    const start = input.indexOf('<?', i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, start);
    const end = input.indexOf('?>', start + 2);
    if (end === -1) {
      break;
    }
    i = end + 2;
  }
  return out;
}

function stripHtmlDeclarations(input: string): string {
  if (!input.includes('<!')) return input;
  let out = '';
  let lastEmit = 0;
  let i = 0;
  const len = input.length;
  while (i < len) {
    const start = input.indexOf('<!', i);
    if (start === -1) break;
    if (start + 2 >= len || !isAsciiLetter(input.charCodeAt(start + 2))) {
      i = start + 2;
      continue;
    }
    out += input.slice(lastEmit, start);
    const end = input.indexOf('>', start + 3);
    if (end === -1) {
      lastEmit = len;
      break;
    }
    i = end + 1;
    lastEmit = i;
  }
  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function isAsciiTagNameChar(code: number): boolean {
  return isAsciiAlnum(code) || code === 45;
}

function replaceHtmlTagsLinear(
  input: string,
  replacer: (fullTag: string, isClosing: boolean, tagNameLower: string, rawAttrs: string) => string,
  tagFilter?: (tagNameLower: string, isClosing: boolean) => boolean,
): string {
  if (!input.includes('<')) return input;
  const len = input.length;
  let out = '';
  let lastEmit = 0;
  let cursor = 0;
  let cachedGt = -1;

  while (cursor < len) {
    const lt = input.indexOf('<', cursor);
    if (lt === -1) break;
    if (cachedGt <= lt) {
      cachedGt = input.indexOf('>', lt + 1);
    }
    if (cachedGt === -1) break;

    let p = lt + 1;
    const isClosing = p < cachedGt && input[p] === '/';
    if (isClosing) {
      p += 1;
    }

    if (p >= cachedGt || !isAsciiLetter(input.charCodeAt(p))) {
      cursor = lt + 1;
      continue;
    }

    const nameStart = p;
    p += 1;
    while (p < cachedGt && isAsciiTagNameChar(input.charCodeAt(p))) p += 1;

    const validBoundary = p === cachedGt || input[p] === '/' || input.charCodeAt(p) <= 32;
    if (!validBoundary) {
      cursor = Math.max(lt + 1, p);
      continue;
    }

    const tagNameLower = input.slice(nameStart, p).toLowerCase();
    if (tagFilter && !tagFilter(tagNameLower, isClosing)) {
      cursor = Math.max(lt + 1, p);
      continue;
    }

    const fullTag = input.slice(lt, cachedGt + 1);
    const rawAttrs = p < cachedGt ? input.slice(p, cachedGt) : '';
    const replacement = replacer(fullTag, isClosing, tagNameLower, rawAttrs);
    if (replacement !== fullTag) {
      out += input.slice(lastEmit, lt) + replacement;
      lastEmit = cachedGt + 1;
    }
    cursor = cachedGt + 1;
  }

  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function findClosingTagSpan(
  str: string,
  fromIndex: number,
  tag: string,
): { closeLt: number; closeGt: number } | null {
  const len = str.length;
  let pos = fromIndex;
  while (pos < len) {
    const lt = str.indexOf('<', pos);
    if (lt === -1) return null;
    let p = lt + 1;
    while (p < len && str.charCodeAt(p) <= 32) p += 1;
    if (str[p] !== '/') {
      pos = Math.max(lt + 1, p);
      continue;
    }
    p += 1;
    while (p < len && str.charCodeAt(p) <= 32) p += 1;
    const nameStart = p;
    while (p < len && isAsciiTagNameChar(str.charCodeAt(p))) p += 1;
    if (p > nameStart && str.slice(nameStart, p).toLowerCase() === tag) {
      if (p < len && (str[p] === '>' || str[p] === '/' || str.charCodeAt(p) <= 32)) {
        const closeGt = str.indexOf('>', p);
        if (closeGt === -1) return null;
        return { closeLt: lt, closeGt };
      }
    }
    pos = Math.max(lt + 1, p);
  }
  return null;
}

function findClosingTagEnd(str: string, fromIndex: number, tag: string): number {
  return findClosingTagSpan(str, fromIndex, tag)?.closeGt ?? -1;
}

function replacePairedHtmlTag(
  input: string,
  tagNames: readonly string[],
  replacer: (tag: string, rawAttrs: string, inner: string, full: string) => string,
): string {
  if (!input.includes('<')) return input;
  const targetSet = new Set(tagNames);
  const noCloseTags = new Set<string>();
  const len = input.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;
    let p = lt + 1;
    while (p < len && input.charCodeAt(p) <= 32) p += 1;
    if (p < len && input[p] === '/') {
      i = lt + 1;
      continue;
    }
    const nameStart = p;
    while (p < len && isAsciiTagNameChar(input.charCodeAt(p))) p += 1;
    const tag = p > nameStart ? input.slice(nameStart, p).toLowerCase() : '';
    const validBoundary =
      p < len && (input[p] === '>' || input[p] === '/' || input.charCodeAt(p) <= 32);

    if (!tag || !validBoundary || !targetSet.has(tag) || noCloseTags.has(tag)) {
      i = lt + 1;
      continue;
    }

    const gt = input.indexOf('>', p);
    if (gt === -1) break;

    const closeSpan = findClosingTagSpan(input, gt + 1, tag);
    if (!closeSpan) {
      noCloseTags.add(tag);
      if (noCloseTags.size === targetSet.size) break;
      i = gt + 1;
      continue;
    }

    out += input.slice(lastEmit, lt);
    const rawAttrs = input.slice(p, gt);
    const inner = input.slice(gt + 1, closeSpan.closeLt);
    const full = input.slice(lt, closeSpan.closeGt + 1);
    out += replacer(tag, rawAttrs, inner, full);
    i = closeSpan.closeGt + 1;
    lastEmit = i;
  }

  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function maxConsecutiveBackticks(text: string): number {
  let maxRun = 0;
  let cur = 0;
  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] === '`') {
      cur += 1;
      if (cur > maxRun) maxRun = cur;
    } else {
      cur = 0;
    }
  }
  return maxRun;
}

function findLineBounds(
  str: string,
  lineStart: number,
): { lineEnd: number; nextLineStart: number } {
  const nl = str.indexOf('\n', lineStart);
  if (nl === -1) {
    return { lineEnd: str.length, nextLineStart: str.length };
  }
  const lineEnd = nl > lineStart && str[nl - 1] === '\r' ? nl - 1 : nl;
  return { lineEnd, nextLineStart: nl + 1 };
}

function skipContainerPrefix(str: string, lineStart: number, lineEnd: number): number {
  let p = lineStart;
  while (p < lineEnd) {
    while (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
      p += 1;
    }
    if (p >= lineEnd) break;
    const ch = str[p]!;
    if (ch === '>') {
      p += 1;
      if (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
        p += 1;
      }
      continue;
    }
    if (
      (ch === '-' || ch === '*' || ch === '+') &&
      p + 1 < lineEnd &&
      (str[p + 1] === ' ' || str[p + 1] === '\t')
    ) {
      p += 1;
      while (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
        p += 1;
      }
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let q = p;
      while (q < lineEnd && q - p < 9 && str[q]! >= '0' && str[q]! <= '9') {
        q += 1;
      }
      if (
        q < lineEnd &&
        (str[q] === '.' || str[q] === ')') &&
        q + 1 < lineEnd &&
        (str[q + 1] === ' ' || str[q + 1] === '\t')
      ) {
        p = q + 1;
        while (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
          p += 1;
        }
        continue;
      }
    }
    break;
  }
  return p;
}

function skipBlockquoteContinuation(str: string, lineStart: number, lineEnd: number): number {
  let p = lineStart;
  while (p < lineEnd) {
    while (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
      p += 1;
    }
    if (p < lineEnd && str[p] === '>') {
      p += 1;
      if (p < lineEnd && (str[p] === ' ' || str[p] === '\t')) {
        p += 1;
      }
      continue;
    }
    break;
  }
  return p;
}

function sanitizeMarkdownRefLinkDefs(rawInput: string): string {
  if (!rawInput.includes(']:')) return rawInput;
  const input = rawInput.includes('\r') ? rawInput.replace(/\r\n?/g, '\n') : rawInput;
  const len = input.length;
  let out = '';
  let lineStart = 0;

  while (lineStart < len) {
    const { lineEnd, nextLineStart } = findLineBounds(input, lineStart);
    const pos = skipContainerPrefix(input, lineStart, lineEnd);

    if (pos >= lineEnd || input[pos] !== '[') {
      out += input.slice(lineStart, nextLineStart);
      lineStart = nextLineStart;
      continue;
    }

    let cur = pos + 1;
    let curLineEnd = lineEnd;
    let curNextLineStart = nextLineStart;
    let closeBracket = -1;
    let hasNonWs = false;

    while (cur < len) {
      if (cur >= curLineEnd) {
        if (curNextLineStart >= len) break;
        const nextBounds = findLineBounds(input, curNextLineStart);
        const contPos = skipBlockquoteContinuation(input, curNextLineStart, nextBounds.lineEnd);
        if (contPos >= nextBounds.lineEnd) {
          // Blank line / empty blockquote line terminates paragraph
          break;
        }
        curLineEnd = nextBounds.lineEnd;
        curNextLineStart = nextBounds.nextLineStart;
        cur = contPos;
        continue;
      }

      const ch = input[cur]!;
      if (ch === '\\' && cur + 1 < curLineEnd) {
        hasNonWs = true;
        cur += 2;
        continue;
      }
      if (ch === '[') {
        break;
      }
      if (ch === ']') {
        closeBracket = cur;
        break;
      }
      if (ch !== ' ' && ch !== '\t') {
        hasNonWs = true;
      }
      cur += 1;
    }

    if (
      closeBracket === -1 ||
      !hasNonWs ||
      closeBracket + 1 >= curLineEnd ||
      input[closeBracket + 1] !== ':'
    ) {
      out += input.slice(lineStart, nextLineStart);
      lineStart = nextLineStart;
      continue;
    }

    let destStart = closeBracket + 2;
    while (destStart < curLineEnd && (input[destStart] === ' ' || input[destStart] === '\t')) {
      destStart += 1;
    }

    let defEndLineEnd = curLineEnd;
    let defNextLineStart = curNextLineStart;

    if (destStart >= curLineEnd) {
      if (curNextLineStart >= len) {
        out += input.slice(lineStart, nextLineStart);
        lineStart = nextLineStart;
        continue;
      }
      const destLineBounds = findLineBounds(input, curNextLineStart);
      const destCont = skipBlockquoteContinuation(input, curNextLineStart, destLineBounds.lineEnd);
      if (destCont >= destLineBounds.lineEnd) {
        out += input.slice(lineStart, nextLineStart);
        lineStart = nextLineStart;
        continue;
      }
      destStart = destCont;
      defEndLineEnd = destLineBounds.lineEnd;
      defNextLineStart = destLineBounds.nextLineStart;
    }

    const rawRest = input.slice(destStart, defEndLineEnd);
    const parsed = parseMarkdownLinkDestination(rawRest);
    const trailingNl = input.slice(defEndLineEnd, defNextLineStart);
    if (parsed) {
      out += `${input.slice(lineStart, destStart)}${parsed.safeUrl}${parsed.titleSuffix}${trailingNl}`;
    } else {
      out += trailingNl;
    }
    lineStart = defNextLineStart;
  }

  return out;
}

function stripDangerousHtmlBlocksOnce(input: string): string {
  const noComments = stripHtmlDeclarations(
    stripHtmlProcessingInstructions(stripHtmlCdata(stripHtmlComments(input))),
  );
  if (!noComments.includes('<')) return noComments;

  const len = noComments.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;

  while (i < len) {
    const lt = noComments.indexOf('<', i);
    if (lt === -1) break;

    let p = lt + 1;
    const isClosing = p < len && noComments[p] === '/';
    if (isClosing) {
      p += 1;
    }

    const nameStart = p;
    while (p < len && isAsciiTagNameChar(noComments.charCodeAt(p))) p += 1;
    const tag = p > nameStart ? noComments.slice(nameStart, p).toLowerCase() : '';
    const validBoundary =
      p === len || noComments[p] === '>' || noComments[p] === '/' || noComments.charCodeAt(p) <= 32;

    if (
      !tag ||
      !validBoundary ||
      (!DANGEROUS_PAIRED_TAGS.has(tag) && !DANGEROUS_VOID_TAGS.has(tag))
    ) {
      i = lt + 1;
      continue;
    }

    out += noComments.slice(lastEmit, lt);

    const gt = noComments.indexOf('>', p);
    if (gt === -1) {
      // Unclosed dangerous tag running to EOF: strip remainder
      lastEmit = len;
      break;
    }

    if (isClosing || DANGEROUS_VOID_TAGS.has(tag)) {
      i = gt + 1;
      lastEmit = i;
      continue;
    }

    // Check self-closing dangerous foreign/void tag (<svg ... />, <embed ... />)
    let prevNonWs = gt - 1;
    while (prevNonWs >= p && noComments.charCodeAt(prevNonWs) <= 32) prevNonWs -= 1;
    if (SELF_CLOSING_DANGEROUS_TAGS.has(tag) && noComments[prevNonWs] === '/') {
      i = gt + 1;
      lastEmit = i;
      continue;
    }

    // Paired dangerous block: strip through matching </tag> or to EOF if unclosed
    const closeGt = findClosingTagEnd(noComments, gt + 1, tag);
    if (closeGt === -1) {
      lastEmit = len;
      break;
    }
    i = closeGt + 1;
    lastEmit = i;
  }

  if (lastEmit === 0) return noComments;
  return out + noComments.slice(lastEmit);
}

function stripDangerousHtmlBlocks(input: string): string {
  let out = input;
  let converged = false;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = stripDangerousHtmlBlocksOnce(out);
    if (next === out) {
      converged = true;
      break;
    }
    out = next;
  }
  if (!converged) {
    out = stripHtmlTagsLinear(stripDangerousHtmlBlocksOnce(out), '', true)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return out;
}

function encodeMarkdownUrlBackticks(url: string): string {
  return url.replace(/`/g, '%60');
}

function encodeMarkdownUrlToken(url: string): string {
  return url.replace(/\)/g, '%29').replace(/`/g, '%60');
}

function hasOddTrailingBackslashes(str: string): boolean {
  let count = 0;
  for (let i = str.length - 1; i >= 0 && str[i] === '\\'; i -= 1) {
    count += 1;
  }
  return (count & 1) === 1;
}

function isValidMarkdownTitleToken(token: string): boolean {
  if (token.length < 2) return false;
  const open = token[0];
  const close = token[token.length - 1];
  if (!((open === '"' && close === '"') || (open === "'" && close === "'"))) {
    return false;
  }
  const inner = token.slice(1, -1);
  if (inner.includes('\r') || inner.includes('\n') || inner.includes(close)) {
    return false;
  }
  if (hasOddTrailingBackslashes(inner)) {
    return false;
  }
  return true;
}

function findEscapedTitleQuoteChar(rawDest: string): '"' | "'" | null {
  const trimmed = rawDest.trim();
  if (!trimmed) return null;
  let candidate = '';
  if (trimmed.startsWith('<')) {
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle < 0) return null;
    candidate = trimmed.slice(closeAngle + 1).trim();
  } else {
    const wsIdx = trimmed.search(/\s/);
    if (wsIdx < 0) return null;
    candidate = trimmed.slice(wsIdx).trim();
  }
  if (candidate.length < 2) return null;
  const open = candidate[0];
  const close = candidate[candidate.length - 1];
  if (!((open === '"' && close === '"') || (open === "'" && close === "'"))) {
    return null;
  }
  const inner = candidate.slice(1, -1);
  if (inner.includes('\r') || inner.includes('\n') || inner.includes(close)) {
    return null;
  }
  return hasOddTrailingBackslashes(inner) ? open : null;
}

function sanitizeMarkdownTitleToken(quotedTitle: string): string {
  return quotedTitle
    .replace(/\\/g, '&#92;')
    .replace(/`/g, '&#96;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseMarkdownLinkDestination(
  rawDest: string,
): { safeUrl: string; titleSuffix: string } | null {
  const trimmed = rawDest.trim();
  if (!trimmed) return null;

  // Angle-bracket destination: <url> optionally followed by quoted title
  if (trimmed.startsWith('<')) {
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle < 0) return null;
    const innerUrl = trimmed.slice(1, closeAngle);
    if (hasOddTrailingBackslashes(innerUrl)) return null;
    const trailing = trimmed.slice(closeAngle + 1).trim();
    if (trailing && !isValidMarkdownTitleToken(trailing)) {
      return null;
    }
    const safeUrl = normalizeSafeExportUrl(innerUrl);
    if (!safeUrl) return null;
    return {
      safeUrl: encodeMarkdownUrlBackticks(safeUrl),
      titleSuffix: trailing ? ` ${sanitizeMarkdownTitleToken(trailing)}` : '',
    };
  }

  // Optional trailing quoted title: url "title" or url 'title'
  const titleMatch = trimmed.match(/^([^\s]+)\s+("[^"\r\n]*"|'[^'\r\n]*')$/);
  if (titleMatch) {
    const urlPart = titleMatch[1] ?? '';
    const titlePart = titleMatch[2] ?? '';
    if (!isValidMarkdownTitleToken(titlePart)) return null;
    const safeUrl = normalizeSafeExportUrl(urlPart);
    if (!safeUrl) return null;
    return {
      safeUrl: encodeMarkdownUrlBackticks(safeUrl),
      titleSuffix: ` ${sanitizeMarkdownTitleToken(titlePart)}`,
    };
  }

  const safeUrl = normalizeSafeExportUrl(trimmed);
  if (!safeUrl) return null;
  return { safeUrl: encodeMarkdownUrlBackticks(safeUrl), titleSuffix: '' };
}

function isUriSchemeChar(code: number): boolean {
  return isAsciiAlnum(code) || code === 43 || code === 45 || code === 46;
}

function isEmailLocalChar(code: number): boolean {
  if (isAsciiAlnum(code)) return true;
  return (
    code === 33 || // !
    code === 35 || // #
    code === 36 || // $
    code === 37 || // %
    code === 38 || // &
    code === 39 || // '
    code === 42 || // *
    code === 43 || // +
    code === 45 || // -
    code === 46 || // .
    code === 47 || // /
    code === 61 || // =
    code === 63 || // ?
    code === 94 || // ^
    code === 95 || // _
    code === 96 || // `
    code === 123 || // {
    code === 124 || // |
    code === 125 || // }
    code === 126 // ~
  );
}

function isSafeAllowedUriAutolinkInner(inner: string): boolean {
  if (!inner || inner.length > 2048) return false;
  if (inner.includes('`') || inner.includes('](')) return false;
  const colonIdx = inner.indexOf(':');
  if (colonIdx < 2 || colonIdx > 32) return false;
  const scheme = inner.slice(0, colonIdx).toLowerCase();
  const rest = inner.slice(colonIdx + 1);
  if (!rest) return false;
  if (scheme === 'http' || scheme === 'https') {
    return /^https?:\/\/[a-z0-9]/i.test(inner) && normalizeSafeExportUrl(inner) !== null;
  }
  if (scheme === 'mailto') {
    return !/["'<>]/.test(rest) && !/&#/i.test(rest);
  }
  if (scheme === 'tel') {
    return /^[0-9+\-.()*,;#=]+$/.test(rest);
  }
  return false;
}

function matchRawCommonMarkUriAutolinkEnd(input: string, pos: number, end: number): number {
  if (pos + 4 >= end || !isAsciiLetter(input.charCodeAt(pos + 1))) return -1;
  let p = pos + 2;
  const schemeLimit = Math.min(end, pos + 33);
  while (p < schemeLimit && isUriSchemeChar(input.charCodeAt(p))) {
    p += 1;
  }
  if (p - (pos + 1) < 2 || p >= end || input[p] !== ':') return -1;
  p += 1;
  while (p < end) {
    const code = input.charCodeAt(p);
    if (code === 62) return p + 1;
    if (code <= 32 || code === 127 || code === 60) return -1;
    p += 1;
  }
  return -1;
}

function matchCommonMarkUriAutolinkEnd(input: string, pos: number, end: number): number {
  const uriEnd = matchRawCommonMarkUriAutolinkEnd(input, pos, end);
  if (uriEnd === -1) return -1;
  return isSafeAllowedUriAutolinkInner(input.slice(pos + 1, uriEnd - 1)) ? uriEnd : -1;
}

function matchCommonMarkEmailAutolinkEnd(input: string, pos: number, end: number): number {
  if (pos + 4 >= end) return -1;
  let p = pos + 1;
  while (p < end && isEmailLocalChar(input.charCodeAt(p))) {
    p += 1;
  }
  if (p === pos + 1 || p >= end || input[p] !== '@') return -1;
  p += 1;

  while (p < end) {
    if (!isAsciiAlnum(input.charCodeAt(p))) return -1;
    let lastWasHyphen = false;
    while (p < end) {
      const code = input.charCodeAt(p);
      if (isAsciiAlnum(code)) {
        lastWasHyphen = false;
        p += 1;
      } else if (code === 45) {
        lastWasHyphen = true;
        p += 1;
      } else {
        break;
      }
    }
    if (lastWasHyphen) return -1;
    if (p < end && input[p] === '.') {
      p += 1;
      continue;
    }
    if (p < end && input[p] === '>') {
      return p + 1;
    }
    return -1;
  }
  return -1;
}

function matchCommonMarkAutolinkEnd(input: string, pos: number, end: number): number {
  const uriEnd = matchCommonMarkUriAutolinkEnd(input, pos, end);
  if (uriEnd !== -1) return uriEnd;
  return matchCommonMarkEmailAutolinkEnd(input, pos, end);
}

function fillInlineOpaqueEnds(
  input: string,
  pStart: number,
  pEnd: number,
  opaqueEnd: Int32Array,
): void {
  const firstTick = input.indexOf('`', pStart);
  const hasTicks = firstTick !== -1 && firstTick < pEnd;
  const firstLt = input.indexOf('<', pStart);
  const hasLt = firstLt !== -1 && firstLt < pEnd;
  if (!hasTicks && !hasLt) return;

  const closersByLen = new Map<number, number[]>();
  if (hasTicks) {
    let k = firstTick;
    while (k < pEnd) {
      if (input[k] === '`') {
        const runStart = k;
        while (k < pEnd && input[k] === '`') {
          k += 1;
        }
        const runLen = k - runStart;
        let list = closersByLen.get(runLen);
        if (!list) {
          list = [];
          closersByLen.set(runLen, list);
        }
        list.push(runStart);
        continue;
      }
      k += 1;
    }
  }

  const cursors = new Map<number, number>();
  let bsCount = 0;
  let i = pStart;

  // Unified CommonMark §6.1 / §6.5 leftmost-wins O(N) scan (code spans + URI/email autolinks)
  if (!hasTicks) {
    let pos = firstLt;
    while (pos < pEnd) {
      const lt = input.indexOf('<', pos);
      if (lt === -1 || lt >= pEnd) break;
      let bs = 0;
      let bp = lt - 1;
      while (bp >= pStart && input[bp] === '\\') {
        bs += 1;
        bp -= 1;
      }
      if ((bs & 1) === 0) {
        const autolinkEnd = matchCommonMarkAutolinkEnd(input, lt, pEnd);
        if (autolinkEnd !== -1) {
          opaqueEnd[lt] = autolinkEnd;
          pos = autolinkEnd;
          continue;
        }
      }
      pos = lt + 1;
    }
    return;
  }

  while (i < pEnd) {
    const ch = input[i];
    if (ch === '\\') {
      bsCount += 1;
      i += 1;
      continue;
    }
    if (ch === '<' && hasLt) {
      const escaped = (bsCount & 1) === 1;
      bsCount = 0;
      if (!escaped) {
        const autolinkEnd = matchCommonMarkAutolinkEnd(input, i, pEnd);
        if (autolinkEnd !== -1) {
          opaqueEnd[i] = autolinkEnd;
          i = autolinkEnd;
          continue;
        }
      }
      i += 1;
      continue;
    }
    if (ch === '`' && hasTicks) {
      const runStart = i;
      while (i < pEnd && input[i] === '`') {
        i += 1;
      }
      const runLen = i - runStart;
      const escapedFirst = (bsCount & 1) === 1;
      bsCount = 0;

      let openStart = runStart;
      let openLen = runLen;
      if (escapedFirst) {
        if (runLen < 2) continue;
        openStart = runStart + 1;
        openLen = runLen - 1;
      }

      const closers = closersByLen.get(openLen);
      if (closers) {
        const openEnd = openStart + openLen;
        let cur = cursors.get(openLen) ?? 0;
        while (cur < closers.length && closers[cur]! < openEnd) {
          cur += 1;
        }
        cursors.set(openLen, cur);
        if (cur < closers.length) {
          const closeStart = closers[cur]!;
          const spanEnd = closeStart + openLen;
          opaqueEnd[openStart] = spanEnd;
          i = spanEnd;
          continue;
        }
      }
      continue;
    }
    bsCount = 0;
    i += 1;
  }
}

const CM_ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const CM_SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const CM_THEMATIC_BREAK_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const CM_BACKTICK_FENCE_RE = /^ {0,3}`{3,}[^`]*$/;
const CM_TILDE_FENCE_RE = /^ {0,3}~{3,}/;
const CM_ANY_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const CM_LIST_INTERRUPT_RE = /^ {0,3}(?:[-*+]|0{0,8}1[.)])[ \t]+\S/;
const CM_LIST_ANY_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const GFM_TABLE_DELIM_CELL_RE = /^[ \t]*:?-+:?[ \t]*$/;

type IndexedMarkdownLine = {
  start: number;
  end: number;
  nextStart: number;
  quoteDepth: number;
  contentStart: number;
  inner: string;
  isBlank: boolean;
};

function parseBlockquoteLinePrefix(
  input: string,
  lineStart: number,
  lineEnd: number,
): { quoteDepth: number; contentStart: number } {
  let p = lineStart;
  let quoteDepth = 0;
  while (p < lineEnd) {
    let ws = 0;
    let q = p;
    while (q < lineEnd && input[q] === ' ' && ws < 3) {
      q += 1;
      ws += 1;
    }
    if (q < lineEnd && input[q] === '>') {
      quoteDepth += 1;
      p = q + 1;
      if (p < lineEnd && (input[p] === ' ' || input[p] === '\t')) {
        p += 1;
      }
      continue;
    }
    break;
  }
  return { quoteDepth, contentStart: p };
}

function parseIndexedMarkdownLines(input: string): IndexedMarkdownLine[] {
  const lines: IndexedMarkdownLine[] = [];
  const len = input.length;
  let lineStart = 0;
  while (lineStart < len) {
    let lineEnd = lineStart;
    while (lineEnd < len && input[lineEnd] !== '\n' && input[lineEnd] !== '\r') {
      lineEnd += 1;
    }
    let nextLineStart = lineEnd;
    if (nextLineStart < len) {
      if (
        input[nextLineStart] === '\r' &&
        nextLineStart + 1 < len &&
        input[nextLineStart + 1] === '\n'
      ) {
        nextLineStart += 2;
      } else {
        nextLineStart += 1;
      }
    }
    const { quoteDepth, contentStart } = parseBlockquoteLinePrefix(input, lineStart, lineEnd);
    const inner = input.slice(contentStart, lineEnd);
    lines.push({
      start: lineStart,
      end: lineEnd,
      nextStart: nextLineStart,
      quoteDepth,
      contentStart,
      inner,
      isBlank: inner.trim() === '',
    });
    lineStart = nextLineStart;
  }
  return lines;
}

function parseGfmDelimiterCellCount(inner: string): number {
  if (!inner.includes('|') || !inner.includes('-')) return 0;
  let leadingSpaces = 0;
  while (leadingSpaces < inner.length && inner[leadingSpaces] === ' ') {
    leadingSpaces += 1;
    if (leadingSpaces > 3) return 0;
  }
  let trimmed = inner.trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  if (!trimmed) return 0;
  const cells = trimmed.split('|');
  for (let c = 0; c < cells.length; c += 1) {
    if (!GFM_TABLE_DELIM_CELL_RE.test(cells[c]!)) return 0;
  }
  return cells.length;
}

function countGfmHeaderRowCells(inner: string): number {
  if (!inner.includes('|')) return 0;
  let leadingSpaces = 0;
  while (leadingSpaces < inner.length && inner[leadingSpaces] === ' ') {
    leadingSpaces += 1;
    if (leadingSpaces > 3) return 0;
  }
  let start = 0;
  let end = inner.length;
  while (start < end && (inner[start] === ' ' || inner[start] === '\t')) start += 1;
  while (end > start && (inner[end - 1] === ' ' || inner[end - 1] === '\t')) end -= 1;
  if (start >= end) return 0;

  let firstPipe = -1;
  let lastPipe = -1;
  let pipeCount = 0;
  let bsCount = 0;
  for (let p = start; p < end; p += 1) {
    const ch = inner[p];
    if (ch === '\\') {
      bsCount += 1;
      continue;
    }
    if (ch === '|' && (bsCount & 1) === 0) {
      if (firstPipe === -1) firstPipe = p;
      lastPipe = p;
      pipeCount += 1;
    }
    bsCount = 0;
  }
  if (pipeCount === 0) return 0;
  if (firstPipe === start && lastPipe === end - 1 && pipeCount === 1) return 0;

  let innerPipes = pipeCount;
  if (firstPipe === start) innerPipes -= 1;
  if (lastPipe === end - 1) innerPipes -= 1;
  return innerPipes + 1;
}

function isGfmTableInterruptingLine(inner: string): boolean {
  return (
    CM_ATX_HEADING_RE.test(inner) ||
    CM_THEMATIC_BREAK_RE.test(inner) ||
    CM_BACKTICK_FENCE_RE.test(inner) ||
    CM_TILDE_FENCE_RE.test(inner) ||
    CM_LIST_INTERRUPT_RE.test(inner)
  );
}

function computeGfmTableLines(lines: readonly IndexedMarkdownLine[]): Uint8Array {
  const isTable = new Uint8Array(lines.length);
  let i = 0;
  while (i + 1 < lines.length) {
    const header = lines[i]!;
    const delim = lines[i + 1]!;
    if (
      !header.isBlank &&
      !delim.isBlank &&
      header.quoteDepth === delim.quoteDepth &&
      !isGfmTableInterruptingLine(header.inner)
    ) {
      const delimCols = parseGfmDelimiterCellCount(delim.inner);
      if (delimCols > 0) {
        const headerCols = countGfmHeaderRowCells(header.inner);
        if (headerCols === delimCols) {
          isTable[i] = 1;
          isTable[i + 1] = 1;
          let j = i + 2;
          while (j < lines.length) {
            const row = lines[j]!;
            if (
              row.isBlank ||
              row.quoteDepth !== header.quoteDepth ||
              isGfmTableInterruptingLine(row.inner)
            ) {
              break;
            }
            isTable[j] = 1;
            j += 1;
          }
          i = j;
          continue;
        }
      }
    }
    i += 1;
  }
  return isTable;
}

function splitLineByUnescapedPipe(
  input: string,
  lineStart: number,
  lineEnd: number,
  scopeStarts: number[],
  scopeEnds: number[],
): void {
  let segStart = lineStart;
  let bsCount = 0;
  for (let p = lineStart; p < lineEnd; p += 1) {
    const ch = input[p];
    if (ch === '\\') {
      bsCount += 1;
      continue;
    }
    if (ch === '|' && (bsCount & 1) === 0) {
      if (p > segStart) {
        scopeStarts.push(segStart);
        scopeEnds.push(p);
      }
      segStart = p + 1;
    }
    bsCount = 0;
  }
  if (lineEnd > segStart) {
    scopeStarts.push(segStart);
    scopeEnds.push(lineEnd);
  }
}

function buildMarkdownMatcherTables(input: string): {
  matchBracket: Int32Array;
  matchParen: Int32Array;
  nextCloseParen: Int32Array;
} {
  const len = input.length;
  const matchBracket = new Int32Array(len).fill(-1);
  const matchParen = new Int32Array(len).fill(-1);
  const nextCloseParen = new Int32Array(len).fill(-1);
  const unescapedCloseParen = new Uint8Array(len);

  const scopeStarts: number[] = [];
  const scopeEnds: number[] = [];

  // Pass 1: split into exact CommonMark §4/§5 & verified GFM §4.10 table inline scopes
  const lines = parseIndexedMarkdownLines(input);
  const isGfmTableLine = computeGfmTableLines(lines);

  let curStart = -1;
  let curEnd = -1;
  let curQuoteDepth = -1;

  const flushScope = () => {
    if (curStart !== -1 && curEnd > curStart) {
      scopeStarts.push(curStart);
      scopeEnds.push(curEnd);
    }
    curStart = -1;
    curEnd = -1;
    curQuoteDepth = -1;
  };

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    if (line.isBlank) {
      flushScope();
      continue;
    }
    if (isGfmTableLine[li] === 1) {
      flushScope();
      splitLineByUnescapedPipe(input, line.contentStart, line.end, scopeStarts, scopeEnds);
      continue;
    }
    const isSetext =
      CM_SETEXT_UNDERLINE_RE.test(line.inner) &&
      (curStart === -1 || line.quoteDepth >= curQuoteDepth);
    if (
      CM_ATX_HEADING_RE.test(line.inner) ||
      isSetext ||
      CM_THEMATIC_BREAK_RE.test(line.inner) ||
      CM_BACKTICK_FENCE_RE.test(line.inner) ||
      CM_TILDE_FENCE_RE.test(line.inner)
    ) {
      flushScope();
      if (line.end > line.start) {
        scopeStarts.push(line.start);
        scopeEnds.push(line.end);
      }
      continue;
    }
    if (curStart !== -1) {
      // Interrupt an open paragraph ONLY per CommonMark §5.1 / §5.2 (deeper blockquote or 0–3sp unordered / 1. ordered list)
      if (line.quoteDepth > curQuoteDepth || CM_LIST_INTERRUPT_RE.test(line.inner)) {
        flushScope();
        curStart = line.start;
        curEnd = line.end;
        curQuoteDepth = line.quoteDepth;
      } else {
        // Same paragraph (including CommonMark §5.1 lazy blockquote continuation when quoteDepth < curQuoteDepth)
        curEnd = line.end;
        if (line.quoteDepth < curQuoteDepth) {
          curQuoteDepth = line.quoteDepth;
        }
      }
    } else {
      curStart = line.start;
      curEnd = line.end;
      curQuoteDepth = line.quoteDepth;
    }
  }
  flushScope();

  const opaqueEnd =
    input.includes('`') || input.includes('<') ? new Int32Array(len).fill(-1) : null;
  const bracketStack: number[] = [];
  const parenStack: number[] = [];

  for (let r = 0; r < scopeStarts.length; r += 1) {
    const start = scopeStarts[r]!;
    const end = scopeEnds[r]!;
    if (start >= end) continue;

    if (opaqueEnd) {
      fillInlineOpaqueEnds(input, start, end, opaqueEnd);
    }

    // CommonMark §6.1 / §6.3 / §6.5: inline code spans and URI/email autolinks take precedence over link/image brackets
    bracketStack.length = 0;
    let bi = start;
    while (bi < end) {
      if (opaqueEnd && opaqueEnd[bi] !== -1) {
        bi = opaqueEnd[bi]!;
        continue;
      }
      const ch = input[bi];
      if (ch === '\\' && bi + 1 < end) {
        bi += 2;
        continue;
      }
      if (ch === '[') {
        bracketStack.push(bi);
      } else if (ch === ']') {
        if (bracketStack.length > 0) {
          matchBracket[bracketStack.pop()!] = bi;
        }
      }
      bi += 1;
    }

    // Link destinations do NOT parse code spans, so match parens directly with backslash escapes
    parenStack.length = 0;
    let pi = start;
    while (pi < end) {
      const ch = input[pi];
      if (ch === '\\' && pi + 1 < end) {
        pi += 2;
        continue;
      }
      if (ch === '(') {
        parenStack.push(pi);
      } else if (ch === ')') {
        unescapedCloseParen[pi] = 1;
        if (parenStack.length > 0) {
          matchParen[parenStack.pop()!] = pi;
        }
      }
      pi += 1;
    }

    let nearest = -1;
    for (let idx = end - 1; idx >= start; idx -= 1) {
      if (unescapedCloseParen[idx] === 1) {
        nearest = idx;
      }
      nextCloseParen[idx] = nearest;
    }
  }

  return { matchBracket, matchParen, nextCloseParen };
}

function hasUnsafeMarkdownDestinationScheme(rawDest: string): boolean {
  if (parseMarkdownLinkDestination(rawDest) !== null) return false;

  const trimmed = rawDest.trim();
  if (!trimmed) return false;

  let urlToken: string;
  if (trimmed.startsWith('<')) {
    let closeAngle = -1;
    for (let i = 1; i < trimmed.length; i += 1) {
      if (i > 2049) return true;
      const ch = trimmed[i];
      if (ch === '\\' && i + 1 < trimmed.length) {
        i += 1;
        continue;
      }
      if (ch === '>') {
        closeAngle = i;
        break;
      }
    }
    urlToken = closeAngle >= 0 ? trimmed.slice(1, closeAngle) : trimmed.slice(1);
  } else {
    let endIdx = trimmed.length;
    for (let i = 0; i < trimmed.length; i += 1) {
      if (i > 2048) return true;
      const code = trimmed.charCodeAt(i);
      if (code <= 32 || code === 127) {
        let j = i + 1;
        while (
          j < trimmed.length &&
          (trimmed.charCodeAt(j) <= 32 || trimmed.charCodeAt(j) === 127)
        ) {
          if (j > 2049) return true;
          j += 1;
        }
        const nextCh = j < trimmed.length ? trimmed[j] : '';
        if (nextCh === '"' || nextCh === "'" || nextCh === '(') {
          endIdx = i;
          break;
        }
        i = j - 1;
      }
    }
    urlToken = trimmed.slice(0, endIdx);
  }

  if (!urlToken) return false;
  // Fail closed on oversized URL tokens (matching normalizeSafeExportUrl's 2048-char limit; no pre-decode truncation)
  if (urlToken.length > 2048) return true;

  // Decode CommonMark §6.3 destination backslash escapes, HTML5 scheme/whitespace named entities, and numeric entities
  const unescaped = urlToken.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  const decoded = decodeHtmlEntities(
    unescaped
      .replace(/&colon;/gi, ':')
      .replace(/&tab;/gi, '\t')
      .replace(/&newline;/gi, '\n')
      .replace(/&sol;/gi, '/')
      .replace(/&bsol;/gi, '\\'),
  )
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : '';
    })
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : '';
    });

  const compact = decoded.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!compact) return false;
  if (compact.startsWith('//') || compact.startsWith('/\\')) return true;

  let prefixEnd = compact.length;
  for (let i = 0; i < compact.length; i += 1) {
    const ch = compact[i];
    if (ch === '/' || ch === '?' || ch === '#') {
      prefixEnd = i;
      break;
    }
  }
  const schemePrefix = compact.slice(0, prefixEnd);

  // Fail-closed HTML5 entity guard in scheme position (blocks ALL HTML5 named/numeric entities before '/', '?', '#')
  if (/&[a-z][a-z0-9]{1,31};/i.test(schemePrefix) || /&#/i.test(schemePrefix)) {
    return true;
  }

  // Strict scheme allowlist
  const colonIdx = schemePrefix.indexOf(':');
  if (colonIdx >= 0) {
    const scheme = schemePrefix.slice(0, colonIdx).toLowerCase();
    return scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' && scheme !== 'tel';
  }

  return false;
}

function computeOpaqueCoverage(
  input: string,
  scopeStarts: readonly number[],
  scopeEnds: readonly number[],
  scratchOpaqueEnd: Int32Array,
): Uint8Array {
  const len = input.length;
  scratchOpaqueEnd.fill(-1);
  const covered = new Uint8Array(len);
  for (let r = 0; r < scopeStarts.length; r += 1) {
    const start = scopeStarts[r]!;
    const end = scopeEnds[r]!;
    if (start >= end) continue;
    fillInlineOpaqueEnds(input, start, end, scratchOpaqueEnd);
    let idx = start;
    while (idx < end) {
      const spanEnd = scratchOpaqueEnd[idx]!;
      if (spanEnd !== -1) {
        covered.fill(1, idx, spanEnd);
        idx = spanEnd;
      } else {
        idx += 1;
      }
    }
  }
  return covered;
}

function neutralizeResidualUnsafeLinkDestinations(input: string, replacement = ''): string {
  if (!input.includes('](')) return input;
  const len = input.length;
  const lines = parseIndexedMarkdownLines(input);
  const matchParen = new Int32Array(len).fill(-1);
  const nextCloseParen = new Int32Array(len).fill(-1);
  const unescapedCloseParen = new Uint8Array(len);

  // Build paragraph-level paren tables (handling multiline destinations) and View A blank-line paragraph scopes
  const viewAStarts: number[] = [];
  const viewAEnds: number[] = [];
  const parenStack: number[] = [];

  const flushParenPara = (paraStart: number, paraEnd: number) => {
    if (paraEnd <= paraStart) return;
    viewAStarts.push(paraStart);
    viewAEnds.push(paraEnd);
    parenStack.length = 0;
    let pi = paraStart;
    while (pi < paraEnd) {
      const ch = input[pi];
      if (ch === '\\' && pi + 1 < paraEnd) {
        pi += 2;
        continue;
      }
      if (ch === '(') {
        parenStack.push(pi);
      } else if (ch === ')') {
        unescapedCloseParen[pi] = 1;
        if (parenStack.length > 0) {
          matchParen[parenStack.pop()!] = pi;
        }
      }
      pi += 1;
    }
    let nearest = -1;
    for (let idx = paraEnd - 1; idx >= paraStart; idx -= 1) {
      if (unescapedCloseParen[idx] === 1) {
        nearest = idx;
      }
      nextCloseParen[idx] = nearest;
    }
  };

  let curParaStart = -1;
  let curParaEnd = -1;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    if (line.isBlank) {
      if (curParaStart !== -1) {
        flushParenPara(curParaStart, curParaEnd);
        curParaStart = -1;
        curParaEnd = -1;
      }
    } else {
      if (curParaStart === -1) curParaStart = line.start;
      curParaEnd = line.end;
    }
  }
  if (curParaStart !== -1) {
    flushParenPara(curParaStart, curParaEnd);
  }

  // Triple-view opaque-span intersection (strictly O(N)):
  // View A: full blank-line-separated paragraphs (NO pipe/2./4sp-/lazy->/fake-fence splits)
  // View B: block-interrupted (ATX/Setext/HR/fences/lists/blockquotes/ref-defs) + pipe-cell-split
  // View C: single-line unsplit
  const hasOpaqueMarkers = input.includes('`') || input.includes('<');
  let paraCovered: Uint8Array | null = null;
  let blockCellCovered: Uint8Array | null = null;
  let singleLineCovered: Uint8Array | null = null;

  if (hasOpaqueMarkers) {
    const scratchOpaqueEnd = new Int32Array(len);
    paraCovered = computeOpaqueCoverage(input, viewAStarts, viewAEnds, scratchOpaqueEnd);

    const viewBStarts: number[] = [];
    const viewBEnds: number[] = [];
    const viewCStarts: number[] = [];
    const viewCEnds: number[] = [];

    let bStart = -1;
    let bEnd = -1;
    let bQuoteDepth = -1;
    const flushViewB = () => {
      if (bStart !== -1 && bEnd > bStart) {
        viewBStarts.push(bStart);
        viewBEnds.push(bEnd);
      }
      bStart = -1;
      bEnd = -1;
      bQuoteDepth = -1;
    };

    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li]!;
      if (line.isBlank) {
        flushViewB();
        continue;
      }
      viewCStarts.push(line.start);
      viewCEnds.push(line.end);

      if (line.inner.includes('|')) {
        flushViewB();
        splitLineByUnescapedPipe(input, line.start, line.end, viewBStarts, viewBEnds);
      } else if (
        CM_ATX_HEADING_RE.test(line.inner) ||
        CM_SETEXT_UNDERLINE_RE.test(line.inner) ||
        CM_THEMATIC_BREAK_RE.test(line.inner) ||
        CM_ANY_FENCE_RE.test(line.inner) ||
        (line.inner.trimStart().startsWith('[') && line.inner.includes(']:'))
      ) {
        flushViewB();
        if (line.end > line.start) {
          viewBStarts.push(line.start);
          viewBEnds.push(line.end);
        }
      } else if (CM_LIST_ANY_RE.test(line.inner) || line.quoteDepth !== bQuoteDepth) {
        flushViewB();
        bStart = line.start;
        bEnd = line.end;
        bQuoteDepth = line.quoteDepth;
      } else {
        if (bStart === -1) {
          bStart = line.start;
          bQuoteDepth = line.quoteDepth;
        }
        bEnd = line.end;
      }
    }
    flushViewB();

    blockCellCovered = computeOpaqueCoverage(input, viewBStarts, viewBEnds, scratchOpaqueEnd);
    singleLineCovered = computeOpaqueCoverage(input, viewCStarts, viewCEnds, scratchOpaqueEnd);
  }

  let out = '';
  let lastEmit = 0;
  let bsCount = 0;
  let k = 0;
  while (k < len) {
    const ch = input[k];
    if (ch === '\\') {
      bsCount += 1;
      k += 1;
      continue;
    }
    const escaped = (bsCount & 1) === 1;
    bsCount = 0;

    if (!escaped && ch === ']' && k + 1 < len && input[k + 1] === '(') {
      const protectedInAllViews =
        paraCovered !== null &&
        paraCovered[k] === 1 &&
        blockCellCovered![k] === 1 &&
        singleLineCovered![k] === 1;
      if (!protectedInAllViews) {
        const openParen = k + 1;
        const destStart = openParen + 1;
        const balancedClose = matchParen[openParen]!;
        const fallbackClose = destStart < len ? nextCloseParen[destStart]! : -1;
        const closeParen = balancedClose !== -1 ? balancedClose : fallbackClose;
        if (closeParen !== -1) {
          const rawDest = input.slice(destStart, closeParen);
          if (hasUnsafeMarkdownDestinationScheme(rawDest)) {
            out += input.slice(lastEmit, k) + replacement;
            k = closeParen + 1;
            lastEmit = k;
            continue;
          }
        }
      }
    }
    k += 1;
  }

  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function failClosedDeepMarkdownLabel(rawLabel: string): string {
  const withoutTicks = rawLabel.replace(/`/g, '&#96;');
  const cleanedRefDefs = withoutTicks.includes(']:')
    ? sanitizeMarkdownRefLinkDefs(withoutTicks)
    : withoutTicks;
  const strippedUnsafe = neutralizeResidualUnsafeLinkDestinations(cleanedRefDefs, '');
  return strippedUnsafe.replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

function sanitizeNestedMarkdownLabel(rawLabel: string, recursionDepth: number): string {
  if (!rawLabel.includes('](') && !rawLabel.includes(']:')) {
    return rawLabel;
  }
  if (recursionDepth < 4) {
    return rawLabel.includes('](')
      ? sanitizeMarkdownLinksAndImages(rawLabel, recursionDepth + 1)
      : rawLabel;
  }
  return failClosedDeepMarkdownLabel(rawLabel);
}

function sanitizeMarkdownLinksAndImages(input: string, recursionDepth = 0): string {
  if (!input.includes('](')) return input;
  if (!input.includes('[')) {
    return recursionDepth === 0 ? neutralizeResidualUnsafeLinkDestinations(input) : input;
  }

  const { matchBracket, matchParen, nextCloseParen } = buildMarkdownMatcherTables(input);
  let out = '';
  let lastEmit = 0;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const bracketPos = input.indexOf('[', i);
    if (bracketPos === -1) break;

    const isImage = bracketPos > i && input[bracketPos - 1] === '!';
    const matchStart = isImage ? bracketPos - 1 : bracketPos;
    const labelStart = bracketPos + 1;
    const closeBracket = matchBracket[bracketPos]!;
    if (closeBracket === -1) {
      i = labelStart;
      continue;
    }

    const openParen = closeBracket + 1;
    if (openParen >= len || input[openParen] !== '(') {
      i = labelStart;
      continue;
    }

    const destStart = openParen + 1;
    const balancedCloseParen = matchParen[openParen]!;
    const fallbackCloseParen = destStart < len ? nextCloseParen[destStart]! : -1;
    const closeParen = balancedCloseParen !== -1 ? balancedCloseParen : fallbackCloseParen;

    if (closeParen === -1) {
      i = labelStart;
      continue;
    }

    const rawLabel = input.slice(labelStart, closeBracket);
    const rawDest = input.slice(destStart, closeParen);
    const parsed = parseMarkdownLinkDestination(rawDest);

    out += input.slice(lastEmit, matchStart);
    if (!parsed) {
      let stripEnd = closeParen + 1;
      const escapedQuote = findEscapedTitleQuoteChar(rawDest);
      if (escapedQuote) {
        // CommonMark §6.3: closing quote was backslash-escaped, so advance past its real closing quote + ')'
        // Strictly O(N) overall because every trigger itself contains an unescaped opening quote.
        let p = closeParen + 1;
        let bs = 0;
        let prevWasNl = false;
        while (p < len) {
          const ch = input[p]!;
          if (ch === '\n' || ch === '\r') {
            if (prevWasNl) break;
            prevWasNl = true;
            bs = 0;
            if (ch === '\r' && p + 1 < len && input[p + 1] === '\n') {
              p += 2;
            } else {
              p += 1;
            }
            continue;
          }
          if (ch !== ' ' && ch !== '\t') {
            prevWasNl = false;
          }
          if (ch === '\\') {
            bs += 1;
            p += 1;
            continue;
          }
          const isEsc = (bs & 1) === 1;
          bs = 0;
          if (!isEsc && ch === escapedQuote) {
            let q = p + 1;
            let nlSeen = false;
            while (q < len) {
              const qch = input[q]!;
              if (qch === ' ' || qch === '\t') {
                q += 1;
              } else if (!nlSeen && (qch === '\n' || qch === '\r')) {
                nlSeen = true;
                q += qch === '\r' && q + 1 < len && input[q + 1] === '\n' ? 2 : 1;
              } else {
                break;
              }
            }
            if (q < len && input[q] === ')') {
              stripEnd = q + 1;
            }
            break;
          }
          p += 1;
        }
      }
      if (!isImage) {
        out += sanitizeNestedMarkdownLabel(rawLabel, recursionDepth);
      }
      i = stripEnd;
      lastEmit = i;
      continue;
    }

    const cleanLabel = sanitizeNestedMarkdownLabel(rawLabel, recursionDepth);
    if (isImage) {
      out += `![${cleanLabel}](${parsed.safeUrl}${parsed.titleSuffix})`;
    } else if (cleanLabel || !rawLabel) {
      out += `[${cleanLabel}](${parsed.safeUrl}${parsed.titleSuffix})`;
    }
    i = closeParen + 1;
    lastEmit = i;
  }

  const result = lastEmit === 0 ? input : out + input.slice(lastEmit);
  return recursionDepth === 0 ? neutralizeResidualUnsafeLinkDestinations(result) : result;
}

function stripUnsafeUriAutolinks(input: string): string {
  if (!input.includes('<')) return input;
  const len = input.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;
  let cachedGt = -1;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;
    if (cachedGt <= lt) {
      cachedGt = input.indexOf('>', lt + 1);
    }
    if (cachedGt === -1) break;

    // 1. Strict fail-closed allowlist for CommonMark §6.5 URI autolinks (<scheme:...>)
    const rawUriEnd = matchRawCommonMarkUriAutolinkEnd(input, lt, len);
    if (rawUriEnd !== -1) {
      const inner = input.slice(lt + 1, rawUriEnd - 1);
      if (isSafeAllowedUriAutolinkInner(inner)) {
        i = rawUriEnd;
        continue;
      }
      out += input.slice(lastEmit, lt);
      i = rawUriEnd;
      lastEmit = i;
      continue;
    }

    // 2. Strip CommonMark §6.5 email autolinks containing backticks (prevents code-span parity blinding)
    const emailEnd = matchCommonMarkEmailAutolinkEnd(input, lt, len);
    if (emailEnd !== -1) {
      if (input.slice(lt + 1, emailEnd - 1).includes('`')) {
        out += input.slice(lastEmit, lt);
        i = emailEnd;
        lastEmit = i;
        continue;
      }
      i = emailEnd;
      continue;
    }

    // 3. Strip whitespace/entity/control-char obfuscated dangerous autolinks (<  javascript:...>, <&#106;avascript:...>, <javascript&colon;...>)
    let p = lt + 1;
    while (p < cachedGt && input.charCodeAt(p) <= 32) p += 1;
    const firstCh = input[p];
    if (
      firstCh === 'j' ||
      firstCh === 'J' ||
      firstCh === 'v' ||
      firstCh === 'V' ||
      firstCh === 'd' ||
      firstCh === 'D' ||
      firstCh === '&'
    ) {
      const scanLimit = Math.min(cachedGt, p + 128);
      let colonPos = -1;
      let hitDisqualifying = false;
      for (let q = p; q < scanLimit; q += 1) {
        const ch = input[q];
        if (ch === ':' && colonPos === -1) {
          colonPos = q;
          break;
        }
        if (ch === '<' || ch === '\r' || ch === '\n') {
          hitDisqualifying = true;
          break;
        }
      }
      const rawPrefix = hitDisqualifying
        ? ''
        : input.slice(p, colonPos !== -1 ? colonPos + 1 : scanLimit);
      if (
        rawPrefix &&
        (rawPrefix.includes(':') ||
          rawPrefix.includes('&#') ||
          rawPrefix.toLowerCase().includes('&colon;'))
      ) {
        const compact = decodeHtmlEntities(
          rawPrefix
            .replace(/&colon;/gi, ':')
            .replace(/&tab;/gi, '\t')
            .replace(/&newline;/gi, '\n'),
        )
          .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => {
            const cp = Number.parseInt(hex, 16);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          })
          .replace(/&#([0-9]+);?/g, (_m, dec: string) => {
            const cp = Number.parseInt(dec, 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          })
          .replace(/[\u0000-\u0020\u007f]+/g, '')
          .toLowerCase();
        if (
          compact.startsWith('javascript:') ||
          compact.startsWith('vbscript:') ||
          compact.startsWith('data:')
        ) {
          out += input.slice(lastEmit, lt);
          i = cachedGt + 1;
          lastEmit = i;
          continue;
        }
      }
    }

    i = lt + 1;
  }

  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function convertSafeRawAnchorsToMarkdown(input: string): string {
  if (!input.includes('<')) return input;
  const len = input.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;
    const p = lt + 1;
    const ch = p < len ? input[p] : '';
    if (ch !== 'a' && ch !== 'A') {
      i = lt + 1;
      continue;
    }
    const nextIdx = p + 1;
    const validBoundary =
      nextIdx < len &&
      (input[nextIdx] === '>' || input[nextIdx] === '/' || input.charCodeAt(nextIdx) <= 32);
    if (!validBoundary) {
      i = lt + 1;
      continue;
    }
    const gt = input.indexOf('>', nextIdx);
    if (gt === -1) break;
    const closeSpan = findClosingTagSpan(input, gt + 1, 'a');
    if (!closeSpan) {
      // No closing </a> anywhere ahead -> copy rest in O(N) and exit
      break;
    }

    const rawAttrs = input.slice(nextIdx, gt);
    const inner = closeSpan.closeLt > gt ? input.slice(gt + 1, closeSpan.closeLt) : '';
    const cleanText = stripHtmlTagsLinear(stripDangerousHtmlBlocks(inner)).trim();
    const hrefMatch = rawAttrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const safeHref = normalizeSafeExportUrl(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3]);
    out += input.slice(lastEmit, lt);
    if (!safeHref) {
      out += cleanText;
    } else if (cleanText) {
      out += `[${cleanText}](${encodeMarkdownUrlToken(safeHref)})`;
    }
    i = closeSpan.closeGt + 1;
    lastEmit = i;
  }

  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function sanitizeExportMarkdownSegment(segment: string): string {
  const bareSafeTags = new Set(['b', 'strong', 'em', 'i', 'u', 'sub', 'sup', 'br', 'code']);
  let out = segment;
  let converged = false;

  for (let pass = 0; pass < 10; pass += 1) {
    const prev = out;
    out = stripTrailingUnclosedTag(stripDangerousHtmlBlocks(out));

    // Neutralize Markdown reference link definitions with unsafe protocols (multiline & container-blocks) first
    // so stripping an unsafe <scheme:...> destination cannot turn a bad ref-def into a multiline consumer of the next safe ref-def.
    out = sanitizeMarkdownRefLinkDefs(out);

    // Strip non-allowlisted URI autolinks & backtick-poisoned email autolinks BEFORE link matching & opaque masking
    out = stripUnsafeUriAutolinks(out);

    // Neutralize Markdown images ![alt](dest) and links [label](dest) with unsafe URLs
    out = sanitizeMarkdownLinksAndImages(out);

    // Convert safe raw <img> to Markdown image and strip unsafe raw <img> (including on* handlers) in strict O(N)
    out = replaceHtmlTagsLinear(
      out,
      (_full, _isClosing, _tag, rawAttrs) => {
        let end = rawAttrs.length;
        while (end > 0 && rawAttrs.charCodeAt(end - 1) <= 32) end -= 1;
        if (end > 0 && rawAttrs[end - 1] === '/') end -= 1;
        const trimmedAttrs = rawAttrs.slice(0, end);
        const strippedAttrs = trimmedAttrs.replace(
          /(?:[\s/])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi,
          '',
        );
        const srcMatch = strippedAttrs.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        const altMatch = strippedAttrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const safeSrc = normalizeSafeExportUrl(srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3]);
        if (!safeSrc) return '';
        const alt = (altMatch?.[1] ?? altMatch?.[2] ?? '').replace(/[\r\n[\]]+/g, ' ').trim();
        return `![${alt}](${encodeMarkdownUrlToken(safeSrc)})`;
      },
      (tag, isClosing) => !isClosing && tag === 'img',
    );

    // Convert safe raw <a href="...">text</a> to Markdown link and strip unsafe links keeping text
    out = convertSafeRawAnchorsToMarkdown(out);

    // Strip remaining unsafe raw HTML tags in strict O(N) while preserving bare attribute-less formatting tags (e.g. <B>, <br>)
    out = replaceHtmlTagsLinear(out, (full, isClosing, tag, rawAttrs) => {
      const attrs = rawAttrs.trim();
      if (bareSafeTags.has(tag) && (attrs === '' || (!isClosing && attrs === '/'))) {
        return full;
      }
      return '';
    });

    // Strip any unclosed trailing raw HTML tag in O(N)
    out = stripTrailingUnclosedTag(out);

    if (out === prev) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    out = stripHtmlTagsLinear(stripDangerousHtmlBlocksOnce(out), '', true)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out = sanitizeMarkdownRefLinkDefs(out);
    out = out
      .replace(/&#x?[0-9a-f]+;?/gi, '')
      .replace(
        /(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a)\s*:/gi,
        '',
      )
      .replace(/\]\(/g, '] (')
      .replace(/\]:/g, '] :');
  }

  return out;
}

const ANY_OPEN_BACKTICK_FENCE_RE = /^( {0,3})(`{3,})([^`]*)$/;
const CLOSE_BACKTICK_FENCE_RE = /^ {0,3}(`{3,})[ \t]*$/;
const ANY_OPEN_TILDE_FENCE_RE = /^( {0,3})(~{3,})(.*)$/;
const CLOSE_TILDE_FENCE_RE = /^ {0,3}(~{3,})[ \t]*$/;
const LINE_HAS_FENCE_MARKER_RE = /`{3,}|~{3,}/;

function trimTrailingLineSpaces(input: string): string {
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let end = line.length;
    while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
      end -= 1;
    }
    if (end < line.length) {
      lines[i] = line.slice(0, end);
    }
  }
  return lines.join('\n');
}

type OpenHtmlSpecialState = 'comment' | 'pi' | 'cdata' | 'decl' | null;

function advanceOpenHtmlSpecial(line: string, state: OpenHtmlSpecialState): OpenHtmlSpecialState {
  const len = line.length;
  let cur = state;
  let i = 0;
  while (i < len) {
    if (cur === 'comment') {
      const close = line.indexOf('-->', i);
      if (close === -1) return 'comment';
      cur = null;
      i = close + 3;
      continue;
    }
    if (cur === 'pi') {
      const close = line.indexOf('?>', i);
      if (close === -1) return 'pi';
      cur = null;
      i = close + 2;
      continue;
    }
    if (cur === 'cdata') {
      const close = line.indexOf(']]>', i);
      if (close === -1) return 'cdata';
      cur = null;
      i = close + 3;
      continue;
    }
    if (cur === 'decl') {
      const close = line.indexOf('>', i);
      if (close === -1) return 'decl';
      cur = null;
      i = close + 1;
      continue;
    }
    const lt = line.indexOf('<', i);
    if (lt === -1) break;
    const nextCh = lt + 1 < len ? line[lt + 1] : '';
    if (nextCh === '!') {
      if (line.startsWith('<!--', lt)) {
        cur = 'comment';
        i = lt + 4;
        continue;
      }
      if (
        lt + 9 <= len &&
        line[lt + 2] === '[' &&
        line.slice(lt, lt + 9).toLowerCase() === '<![cdata['
      ) {
        cur = 'cdata';
        i = lt + 9;
        continue;
      }
      if (lt + 2 < len && isAsciiLetter(line.charCodeAt(lt + 2))) {
        cur = 'decl';
        i = lt + 3;
        continue;
      }
    } else if (nextCh === '?') {
      cur = 'pi';
      i = lt + 2;
      continue;
    }
    i = lt + 1;
  }
  return cur;
}

function sanitizeExportMarkdownOnce(normalized: string): string {
  // Preserve strictly valid top-level column-0 CommonMark §4.5 closed fenced code blocks (backtick or tilde) in O(N);
  // sanitize everything outside (including 1..3-space indented fences, list/blockquote-indented fences, Pandoc `{...}` raw blocks,
  // and fences preceded by CommonMark §4.6 HTML blocks or fence markers in the same contiguous non-blank block).
  const lines = normalized.split('\n');
  const outParts: string[] = [];
  let nonFenceBuf: string[] = [];
  let blockMayBeHtmlBlock = false;
  let blockHasFenceMarker = false;
  let openHtmlSpecial: OpenHtmlSpecialState = null;

  const pushNonFenceLine = (line: string) => {
    nonFenceBuf.push(line);
    if (line.trim() === '') {
      blockMayBeHtmlBlock = false;
      blockHasFenceMarker = false;
    } else {
      if (line.trimStart().startsWith('<')) {
        blockMayBeHtmlBlock = true;
      }
      if (LINE_HAS_FENCE_MARKER_RE.test(line)) {
        blockHasFenceMarker = true;
      }
    }
    openHtmlSpecial = advanceOpenHtmlSpecial(line, openHtmlSpecial);
  };

  const flushNonFence = () => {
    if (nonFenceBuf.length === 0) return;
    outParts.push(sanitizeExportMarkdownSegment(nonFenceBuf.join('\n')));
    nonFenceBuf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const backtickOpen = ANY_OPEN_BACKTICK_FENCE_RE.exec(line);
    const tildeOpen = backtickOpen ? null : ANY_OPEN_TILDE_FENCE_RE.exec(line);
    const openMatch = backtickOpen ?? tildeOpen;
    if (openMatch) {
      const indent = openMatch[1]!;
      const fenceChars = openMatch[2]!;
      const info = openMatch[3]!;
      const mustSanitizeFence = indent.length >= 1 || info.includes('{');

      if (
        !mustSanitizeFence &&
        (blockMayBeHtmlBlock || blockHasFenceMarker || openHtmlSpecial !== null)
      ) {
        pushNonFenceLine(line);
        blockHasFenceMarker = true;
        i += 1;
        continue;
      }

      const openLen = fenceChars.length;
      const closeRe = backtickOpen ? CLOSE_BACKTICK_FENCE_RE : CLOSE_TILDE_FENCE_RE;
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const closeMatch = closeRe.exec(lines[j]!);
        if (closeMatch && closeMatch[1]!.length >= openLen) {
          closeIdx = j;
          break;
        }
      }

      if (mustSanitizeFence) {
        // 1..3-space indented fence or Pandoc raw-attribute `{...}` fence:
        // push i..closeIdx (or EOF) into nonFenceBuf so closeIdx can NEVER be misparsed as a column-0 opener.
        const stop = closeIdx !== -1 ? closeIdx : lines.length - 1;
        for (let j = i; j <= stop; j += 1) {
          pushNonFenceLine(lines[j]!);
        }
        blockHasFenceMarker = true;
        i = stop + 1;
        continue;
      }

      if (closeIdx !== -1) {
        flushNonFence();
        const fenceLines = lines.slice(i, closeIdx + 1);
        const lastIdx = fenceLines.length - 1;
        let lastEnd = fenceLines[lastIdx]!.length;
        while (
          lastEnd > 0 &&
          (fenceLines[lastIdx]![lastEnd - 1] === ' ' || fenceLines[lastIdx]![lastEnd - 1] === '\t')
        ) {
          lastEnd -= 1;
        }
        fenceLines[lastIdx] = fenceLines[lastIdx]!.slice(0, lastEnd);
        outParts.push(fenceLines.join('\n'));
        blockMayBeHtmlBlock = false;
        blockHasFenceMarker = false;
        openHtmlSpecial = null;
        i = closeIdx + 1;
        continue;
      }

      // Unclosed column-0 fence: fail-closed and sanitize all remaining lines as normal Markdown
      for (let j = i; j < lines.length; j += 1) {
        pushNonFenceLine(lines[j]!);
      }
      break;
    }
    pushNonFenceLine(line);
    i += 1;
  }

  flushNonFence();
  return trimTrailingLineSpaces(outParts.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeExportMarkdown(rawMarkdown: string): string {
  let out = rawMarkdown.replace(/\r\n?/g, '\n');
  let converged = false;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = sanitizeExportMarkdownOnce(out);
    if (next === out) {
      converged = true;
      break;
    }
    out = next;
  }
  if (!converged) {
    out = trimTrailingLineSpaces(sanitizeExportMarkdownSegment(out))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return out;
}

function sanitizeExportMarkdownTitle(rawTitle: string): string {
  let clean = rawTitle.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return '';
  let converged = false;
  for (let pass = 0; pass < 10; pass += 1) {
    const prev = clean;
    clean = sanitizeExportMarkdownSegment(clean);
    clean = replaceHtmlTagsLinear(clean, () => '');
    clean = stripTrailingUnclosedTag(clean);
    clean = clean
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (clean === prev) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    clean = replaceHtmlTagsLinear(stripDangerousHtmlBlocksOnce(clean), () => '');
    clean = stripTrailingUnclosedTag(clean)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\]\(/g, '] (')
      .replace(/\]:/g, '] :')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return clean;
}

function escapeHtmlAttr(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXml(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (
      (code < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      continue;
    }
    out += ch;
  }
  return out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 富文本白名单清洗：保留排版标签（h1-h4, p, ul, ol, li, blockquote, pre, code, strong, b, em, i, u, br, hr, a, img, table/thead/tbody/tfoot/tr/th/td），
 * 剥离 script / style / iframe / object / embed / svg 及其内部文本、on* 事件与危险协议。若传入纯文本/Markdown 则转为安全 HTML。
 */
export function sanitizeRichArticleHtml(input: string): {
  contentHtml: string;
  contentText: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return { contentHtml: '', contentText: '' };
  }
  const hasHtmlTag =
    /<\s*(p|h[1-6]|ul|ol|li|blockquote|div|pre|code|strong|em|br|hr|a|img|table|thead|tbody|tfoot|tr|td|th|script|style|iframe|object|embed|svg)\b/i.test(
      trimmed,
    );
  if (!hasHtmlTag) {
    const html = markdownToSanitizedHtml(sanitizeExportMarkdown(trimmed));
    return { contentHtml: html, contentText: stripHtmlToText(html) };
  }

  const allowed = new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'strong',
    'b',
    'em',
    'i',
    'u',
    'br',
    'hr',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
  ]);

  let cleaned = trimmed;
  let converged = false;
  for (let pass = 0; pass < 10; pass += 1) {
    const prev = cleaned;
    cleaned = stripTrailingUnclosedTag(
      stripDangerousHtmlBlocks(cleaned)
        .replace(/(?:[\s/])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
        .replace(
          /(?:[\s/])(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi,
          '',
        ),
    );
    cleaned = replaceHtmlTagsLinear(
      cleaned,
      (_full, isClosing, _tag, rawAttrs) =>
        isClosing ? (rawAttrs.trim() === '' ? '</p>' : '') : `<p${rawAttrs}>`,
      (tag) => tag === 'div',
    );

    const openSafeLinkStack: boolean[] = [];

    cleaned = replaceHtmlTagsLinear(cleaned, (_full, isClosing, tag, rawAttrs) => {
      if (!allowed.has(tag)) return '';
      if (tag === 'b') return isClosing ? '</strong>' : '<strong>';
      if (tag === 'i') return isClosing ? '</em>' : '<em>';
      if (tag === 'a') {
        if (isClosing) {
          return openSafeLinkStack.pop() ? '</a>' : '';
        }
        const hrefMatch = rawAttrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        const safeHref = normalizeSafeExportUrl(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3]);
        if (!safeHref) {
          openSafeLinkStack.push(false);
          return '';
        }
        openSafeLinkStack.push(true);
        return `<a href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noopener noreferrer">`;
      }
      if (isClosing) return `</${tag}>`;
      if (tag === 'br') return '<br />';
      if (tag === 'hr') return '<hr />';
      if (tag === 'img') {
        const srcMatch = rawAttrs.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        const altMatch = rawAttrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const safeSrc = normalizeSafeExportUrl(srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3]);
        if (!safeSrc) {
          return '';
        }
        const alt = escapeHtmlAttr(
          decodeHtmlEntities((altMatch?.[1] ?? altMatch?.[2] ?? '').trim()),
        );
        return `<img src="${escapeHtmlAttr(safeSrc)}" alt="${alt}" style="max-width:100%" />`;
      }
      return `<${tag}>`;
    });

    cleaned = stripTrailingUnclosedTag(cleaned);
    if (cleaned === prev) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    const stripped = stripHtmlTagsLinear(stripDangerousHtmlBlocksOnce(cleaned), '', true)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
    cleaned = stripped ? `<p>${stripped}</p>` : '';
  }

  const contentText = stripHtmlToText(cleaned);
  return { contentHtml: cleaned.trim(), contentText };
}

export function countArticleWords(htmlOrText: string): number {
  const plain = stripHtmlToText(htmlOrText).replace(/\s+/g, '');
  return Array.from(plain).length;
}

function cleanTableCellText(rawHtml: string): string {
  return decodeHtmlEntities(
    stripHtmlTagsLinear(rawHtml.replace(/<\s*br\s*(?:\/\s*)?>/gi, ' '), ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHtmlTableRows(tableHtml: string): Array<{ isHeader: boolean; cells: string[] }> {
  const rows: Array<{ isHeader: boolean; cells: string[] }> = [];
  replacePairedHtmlTag(tableHtml, ['tr'], (_trTag, _trAttrs, rowInner) => {
    const cells: string[] = [];
    let isHeader = false;
    replacePairedHtmlTag(rowInner, ['th', 'td'], (cellTag, _cellAttrs, cellInner) => {
      if (cellTag === 'th') isHeader = true;
      cells.push(cleanTableCellText(cellInner));
      return '';
    });
    if (cells.length > 0) {
      rows.push({ isHeader, cells });
    }
    return '';
  });
  const maxCols = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  if (maxCols === 0) return [];
  return rows.map((row) => ({
    isHeader: row.isHeader,
    cells:
      row.cells.length < maxCols
        ? [...row.cells, ...Array<string>(maxCols - row.cells.length).fill('')]
        : row.cells,
  }));
}

function htmlTableToGfmMarkdown(tableHtml: string): string {
  const rows = parseHtmlTableRows(tableHtml);
  if (rows.length === 0) return '';
  const escapePipe = (val: string) => val.replace(/\|/g, '\\|');
  const firstRow = rows[0]!;
  const colCount = firstRow.cells.length;
  const lines: string[] = [
    `| ${firstRow.cells.map(escapePipe).join(' | ')} |`,
    `| ${Array<string>(colCount).fill('---').join(' | ')} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${row.cells.map(escapePipe).join(' | ')} |`);
  }
  return `\n\n${lines.join('\n')}\n\n`;
}

function resolveDocExportHtml(doc: ExportableArticleDoc): string {
  const rawHtml = doc.contentHtml ?? '';
  const rawMd = doc.contentMarkdown?.trim() ?? '';
  if (rawMd && (!rawHtml.trim() || (hasGfmTable(rawMd) && !/<\s*table\b/i.test(rawHtml)))) {
    return markdownToSanitizedHtml(sanitizeExportMarkdown(rawMd));
  }
  return sanitizeRichArticleHtml(rawHtml).contentHtml;
}

export function htmlToExportMarkdown(doc: ExportableArticleDoc): string {
  const safeMdTitle = sanitizeExportMarkdownTitle(doc.title);
  const safeCoverUrl = normalizeSafeExportUrl(doc.coverUrl);
  const mdCoverUrl = safeCoverUrl ? encodeMarkdownUrlToken(safeCoverUrl) : null;
  const rawMd = doc.contentMarkdown?.trim();
  if (rawMd) {
    const cleanMd = sanitizeExportMarkdown(rawMd);
    const startsWithH1 = /^#\s+/.test(cleanMd);
    const parts: string[] = [];
    if (!startsWithH1 && safeMdTitle) {
      parts.push(`# ${safeMdTitle}`);
    }
    if (mdCoverUrl) {
      parts.push(`![封面](${mdCoverUrl})`);
    }
    if (cleanMd) {
      parts.push(cleanMd);
    }
    return `${parts.join('\n\n')}\n`;
  }

  const lines: string[] = safeMdTitle ? [`# ${safeMdTitle}`] : [];
  if (mdCoverUrl) {
    if (lines.length > 0) lines.push('');
    lines.push(`![封面](${mdCoverUrl})`);
  }

  const sanitizedHtml = sanitizeRichArticleHtml(doc.contentHtml ?? '').contentHtml;
  const sanitizedPlain = decodeHtmlEntities(stripHtmlTagsLinear(sanitizedHtml));
  let preSentinel = 'GMPREBLK';
  while (sanitizedHtml.includes(preSentinel) || sanitizedPlain.includes(preSentinel)) {
    preSentinel += 'X';
  }
  const preservedPreBlocks: string[] = [];

  let md = sanitizedHtml;
  md = replacePairedHtmlTag(md, ['table'], (_tag, _attrs, _inner, full) =>
    htmlTableToGfmMarkdown(full),
  );
  md = replacePairedHtmlTag(md, ['pre'], (_tag, _attrs, inner) => {
    const code = decodeHtmlEntities(stripHtmlTagsLinear(inner).trim()).replace(/\r\n?/g, '\n');
    if (!code) return '';
    const idx = preservedPreBlocks.length;
    const fence = '`'.repeat(Math.max(3, maxConsecutiveBackticks(code) + 1));
    preservedPreBlocks.push(`\n\n${fence}\n${code}\n${fence}\n\n`);
    return `\n\n${preSentinel}${idx}END\n\n`;
  });
  md = replacePairedHtmlTag(md, ['code'], (_tag, _attrs, inner) => {
    const code = decodeHtmlEntities(stripHtmlTagsLinear(inner));
    return `\`${code}\``;
  });
  md = md.replace(/<\s*hr\s*(?:\/\s*)?>/gi, '\n\n---\n\n').replace(/<\s*br\s*(?:\/\s*)?>/gi, '\n');
  md = replaceHtmlTagsLinear(
    md,
    (_full, _isClosing, _tag, rawAttrs) => {
      const srcMatch = rawAttrs.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
      const altMatch = rawAttrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const safeSrc = normalizeSafeExportUrl(srcMatch?.[1] ?? srcMatch?.[2]);
      if (!safeSrc) return '';
      const alt = decodeHtmlEntities((altMatch?.[1] ?? altMatch?.[2] ?? '').trim()).replace(
        /[\r\n[\]]+/g,
        ' ',
      );
      return `\n\n![${alt}](${encodeMarkdownUrlToken(safeSrc)})\n\n`;
    },
    (tag, isClosing) => !isClosing && tag === 'img',
  );
  md = replacePairedHtmlTag(md, ['a'], (_tag, rawAttrs, inner) => {
    const label = decodeHtmlEntities(stripHtmlTagsLinear(inner).trim());
    const hrefMatch = rawAttrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const safeHref = normalizeSafeExportUrl(hrefMatch?.[1] ?? hrefMatch?.[2]);
    if (!safeHref) return label;
    return label ? `[${label}](${encodeMarkdownUrlToken(safeHref)})` : '';
  });
  md = replacePairedHtmlTag(md, ['h1', 'h2', 'h3', 'h4'], (tag, _attrs, inner) => {
    const level = Number(tag[1]);
    return `\n\n${'#'.repeat(level)} ${inner}\n\n`;
  });
  md = replacePairedHtmlTag(md, ['blockquote'], (_tag, _attrs, inner) => {
    const clean = decodeHtmlEntities(stripHtmlTagsLinear(inner).trim());
    return `\n\n> ${clean}\n\n`;
  });
  md = replacePairedHtmlTag(md, ['li'], (_tag, _attrs, inner) => {
    const clean = decodeHtmlEntities(stripHtmlTagsLinear(inner).trim());
    return `\n- ${clean}`;
  });
  md = replacePairedHtmlTag(md, ['strong', 'b'], (_tag, _attrs, inner) => `**${inner}**`);
  md = replacePairedHtmlTag(md, ['em', 'i'], (_tag, _attrs, inner) => `*${inner}*`);
  md = stripHtmlTagsLinear(md.replace(/<\s*\/\s*(p|ul|ol)\s*>/gi, '\n\n'));

  md = decodeHtmlEntities(md);
  for (let idx = 0; idx < preservedPreBlocks.length; idx += 1) {
    md = md.replaceAll(`${preSentinel}${idx}END`, preservedPreBlocks[idx]!);
  }
  md = trimTrailingLineSpaces(md)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (md) {
    const cleanDerivedMd = sanitizeExportMarkdown(md);
    if (cleanDerivedMd) {
      if (lines.length > 0) lines.push('');
      lines.push(cleanDerivedMd);
    }
  } else if (doc.contentText.trim()) {
    const cleanFallback = sanitizeExportMarkdown(doc.contentText.trim());
    if (cleanFallback) {
      if (lines.length > 0) lines.push('');
      lines.push(cleanFallback);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function htmlToExportDocument(doc: ExportableArticleDoc): string {
  const safeTitle = escapeHtmlAttr(doc.title.trim());
  const safeLocale = escapeHtmlAttr(doc.locale?.trim() || 'zh-CN');
  const exportHtml = resolveDocExportHtml(doc);
  const safeCoverUrl = normalizeSafeExportUrl(doc.coverUrl);
  const coverBlock = safeCoverUrl
    ? `<figure class="cover"><img src="${escapeHtmlAttr(safeCoverUrl)}" alt="${safeTitle}" /></figure>`
    : '';
  return `<!DOCTYPE html>
<html lang="${safeLocale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    body { max-width: 820px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.75; color: #1f2329; }
    h1 { font-size: 28px; margin-bottom: 16px; line-height: 1.35; }
    h2 { font-size: 21px; margin-top: 28px; margin-bottom: 12px; }
    h3 { font-size: 18px; margin-top: 22px; margin-bottom: 8px; }
    p, li { font-size: 16px; }
    blockquote { margin: 16px 0; padding: 10px 16px; border-left: 4px solid #1677ff; background: #f5f8ff; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { border: 1px solid #d9d9d9; padding: 8px 12px; text-align: left; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    .meta { color: #646a73; font-size: 13px; margin-bottom: 24px; }
  </style>
</head>
<body>
  <article>
    <h1>${safeTitle}</h1>
    <div class="meta">${doc.categoryName ? `标签：${escapeHtmlAttr(doc.categoryName)}` : 'GeoMix 导出文档'}</div>
    ${coverBlock}
    <div class="content">${exportHtml}</div>
  </article>
</body>
</html>
`;
}

type DocxTableRow = { isHeader: boolean; cells: string[] };
type DocxBlock =
  | { kind: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'blockquote' | 'code'; text: string }
  | { kind: 'table'; rows: DocxTableRow[] };

function extractDocxBlocks(doc: ExportableArticleDoc): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const trimmedTitle = doc.title.trim();
  if (trimmedTitle) {
    blocks.push({ kind: 'h1', text: trimmedTitle });
  }
  const html = resolveDocExportHtml(doc);
  const blockTags = new Set(['table', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'li', 'p']);
  const noCloseTags = new Set<string>();
  const len = html.length;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    let p = lt + 1;
    while (p < len && html.charCodeAt(p) <= 32) p += 1;
    if (p < len && html[p] === '/') {
      i = lt + 1;
      continue;
    }
    const nameStart = p;
    while (p < len && isAsciiTagNameChar(html.charCodeAt(p))) p += 1;
    const tag = p > nameStart ? html.slice(nameStart, p).toLowerCase() : '';
    const validBoundary =
      p < len && (html[p] === '>' || html[p] === '/' || html.charCodeAt(p) <= 32);
    if (!tag || !validBoundary || !blockTags.has(tag) || noCloseTags.has(tag)) {
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', p);
    if (gt === -1) break;
    const closeSpan = findClosingTagSpan(html, gt + 1, tag);
    if (!closeSpan) {
      noCloseTags.add(tag);
      i = gt + 1;
      continue;
    }

    if (tag === 'table') {
      const rows = parseHtmlTableRows(html.slice(lt, closeSpan.closeGt + 1));
      if (rows.length > 0) {
        blocks.push({ kind: 'table', rows });
      }
      i = closeSpan.closeGt + 1;
      continue;
    }

    const rawInner = html.slice(gt + 1, closeSpan.closeLt);
    const textVal =
      tag === 'pre'
        ? decodeHtmlEntities(stripHtmlTagsLinear(rawInner).trim())
        : decodeHtmlEntities(
            stripHtmlTagsLinear(rawInner.replace(/<\s*br\s*(?:\/\s*)?>/gi, ' '), ' '),
          )
            .replace(/\s+/g, ' ')
            .trim();
    if (textVal) {
      if (tag === 'h1') blocks.push({ kind: 'h1', text: textVal });
      else if (tag === 'h2') blocks.push({ kind: 'h2', text: textVal });
      else if (tag === 'h3') blocks.push({ kind: 'h3', text: textVal });
      else if (tag === 'h4') blocks.push({ kind: 'h4', text: textVal });
      else if (tag === 'blockquote') blocks.push({ kind: 'blockquote', text: textVal });
      else if (tag === 'pre') blocks.push({ kind: 'code', text: textVal });
      else if (tag === 'li') blocks.push({ kind: 'li', text: `• ${textVal}` });
      else blocks.push({ kind: 'p', text: textVal });
    }
    i = closeSpan.closeGt + 1;
  }

  if (blocks.length <= 1 && doc.contentText.trim()) {
    const safeFallbackText = stripDangerousHtmlBlocks(doc.contentText).trim();
    for (const line of safeFallbackText.split(/\r\n?|\n/)) {
      const trimmed = line.trim();
      if (trimmed) blocks.push({ kind: 'p', text: trimmed });
    }
  }
  return blocks;
}

function serializeDocxTable(rows: readonly DocxTableRow[]): string {
  const colCount = rows[0]?.cells.length ?? 0;
  if (colCount === 0) return '';
  const totalWidth = 9000;
  const colWidth = Math.max(900, Math.floor(totalWidth / colCount));
  const gridCols = Array.from({ length: colCount }, () => `<w:gridCol w:w="${colWidth}"/>`).join(
    '',
  );

  const rowsXml = rows
    .map((row) => {
      const trPr = row.isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      const cellsXml = row.cells
        .map((cell) => {
          const shd = row.isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>' : '';
          const boldXml = row.isHeader ? '<w:b/>' : '';
          return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${shd}</w:tcPr><w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:rPr>${boldXml}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
        })
        .join('');
      return `<w:tr>${trPr}${cellsXml}</w:tr>`;
    })
    .join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/></w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}

export function buildSingleDocxBytes(doc: ExportableArticleDoc): Uint8Array {
  const blocks = extractDocxBlocks(doc);
  const bodyNodesXml = blocks
    .map((b) => {
      if (b.kind === 'table') {
        return serializeDocxTable(b.rows);
      }
      const sizeHalfPt =
        b.kind === 'h1'
          ? 36
          : b.kind === 'h2'
            ? 28
            : b.kind === 'h3'
              ? 24
              : b.kind === 'code'
                ? 18
                : 22;
      const boldXml =
        b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3' || b.kind === 'h4' ? '<w:b/>' : '';
      const indentXml = b.kind === 'blockquote' ? '<w:ind w:left="480"/>' : '';
      return `<w:p><w:pPr><w:spacing w:after="160"/>${indentXml}</w:pPr><w:r><w:rPr>${boldXml}<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/></w:rPr><w:t xml:space="preserve">${escapeXml(b.text)}</w:t></w:r></w:p>`;
    })
    .join('');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyNodesXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
</w:document>`;

  return buildZipArchive([
    { path: '[Content_Types].xml', data: utf8Bytes(contentTypes) },
    { path: '_rels/.rels', data: utf8Bytes(rootRels) },
    { path: 'word/document.xml', data: utf8Bytes(documentXml) },
  ]);
}

function safeEntryFilename(index: number, title: string, ext: ArticleArchiveFormat): string {
  const prefix = String(index + 1).padStart(2, '0');
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const stem = cleaned || `article-${prefix}`;
  return `${prefix}-${stem}.${ext}`;
}

export function buildArticleExportZip(
  docs: ExportableArticleDoc[],
  format: ArticleArchiveFormat,
): Uint8Array {
  const entries = docs.map((doc, idx) => {
    const path = safeEntryFilename(idx, doc.title, format);
    if (format === 'md') {
      return { path, data: utf8Bytes(htmlToExportMarkdown(doc)) };
    }
    if (format === 'html') {
      return { path, data: utf8Bytes(htmlToExportDocument(doc)) };
    }
    return { path, data: buildSingleDocxBytes(doc) };
  });
  return buildZipArchive(entries);
}

function utf8Bytes(val: string): Uint8Array {
  return new TextEncoder().encode(val);
}

export function buildZipArchive(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const utf8Flag = 0x0800;

  for (const file of files) {
    const name = utf8Bytes(file.path);
    const crc = computeCrc32(file.data);
    const local = new Uint8Array(30 + name.length + file.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, utf8Flag, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, utf8Flag, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, p) => sum + p.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const totalLen = offset + centralSize + end.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

export function readZipStoreEntries(zipBytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let eocdPos = -1;
  for (let i = zipBytes.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error('Invalid ZIP archive: missing EOCD signature');
  }
  const entryCount = view.getUint16(eocdPos + 10, true);
  const centralOffset = view.getUint32(eocdPos + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries: { path: string; data: Uint8Array }[] = [];

  let ptr = centralOffset;
  for (let idx = 0; idx < entryCount; idx += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const expectedCrc = view.getUint32(ptr + 16, true);
    const size = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const path = decoder.decode(zipBytes.subarray(ptr + 46, ptr + 46 + nameLen));

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('Invalid ZIP local file header');
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zipBytes.subarray(dataStart, dataStart + size);
    const actualCrc = computeCrc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC32 mismatch for ${path}`);
    }
    entries.push({ path, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ==================== GEO 0–100 体检、发布复测与行动首页 DTO ====================

export const GEO_SCORE_DIMENSION_KEYS = [
  'directAnswer',
  'structuredExtractable',
  'factDensity',
  'fanOutCoverage',
  'deAiCompliance',
] as const;
export type GeoScoreDimensionKey = (typeof GEO_SCORE_DIMENSION_KEYS)[number];

export type GeoScoreDimensionDetail = {
  key: GeoScoreDimensionKey;
  label: string;
  score: number;
  maxScore: number;
  passed: boolean;
  hints: string[];
};

export type GeoScoreDetail = {
  dimensions: Record<GeoScoreDimensionKey, GeoScoreDimensionDetail>;
  coveredFanOuts: string[];
  missingFanOuts: string[];
};

export type GeoEvaluationResult = {
  geoScore: number;
  geoScoreDetail: GeoScoreDetail;
  uncoveredFanOuts?: string[];
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
  crawlerChecklist: Array<{ bot: string; purpose: string; recommended: boolean }>;
  recommendedChannels: Array<{ channel: string; reason: string }>;
};

export function isSafeHttpPublishedUrl(raw: string): boolean {
  const val = raw.trim();
  if (!val || val.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(val)) return false;
  try {
    const parsed = new URL(val);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export const publishRecordCreateSchema = z.object({
  publishedUrl: z
    .string()
    .trim()
    .min(1, '请输入已发布文章链接')
    .max(2048, '链接长度不能超过 2048 个字符')
    .refine(isSafeHttpPublishedUrl, '请输入有效的 http:// 或 https:// 已发布文章链接'),
  channel: z.string().trim().min(1, '请选择或填写发布渠道').max(60),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  autoRetest: z
    .object({
      enabled: z.boolean().default(true),
      milestones: z.array(z.number().int().min(1).max(365)).min(1).max(6).optional(),
      sampleCount: z.union([z.literal(1), z.literal(3)]).optional(),
    })
    .optional(),
});

export type PublishRecordCreateInput = z.infer<typeof publishRecordCreateSchema>;

export const publishRecordRetestSchema = z
  .object({
    engines: z
      .array(z.enum(VISIBILITY_ENGINE_KEYS))
      .min(1, '请至少选择 1 个监测引擎')
      .max(VISIBILITY_ENGINE_KEYS.length)
      .transform((arr) => [...new Set(arr)])
      .superRefine((arr, ctx) => {
        const retired = findRetiredVisibilityEngines(arr);
        if (retired.length > 0) {
          const labels = retired.map((key) => VISIBILITY_ENGINE_LABELS[key] ?? key).join('、');
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `以下 AI 引擎已下线，不再支持新建复测：${labels}`,
          });
        }
      })
      .optional(),
  })
  .optional()
  .default({});

export type PublishRecordRetestInput = z.infer<typeof publishRecordRetestSchema>;

export const geoEvaluateArticleInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    contentMarkdown: z.string().max(200_000).optional(),
    targetFanOuts: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
  })
  .optional()
  .default({});

export type GeoEvaluateArticleBodyInput = z.infer<typeof geoEvaluateArticleInputSchema>;

export const articleExportQuerySchema = z.object({
  format: z.enum(ARTICLE_EXPORT_FORMATS, {
    errorMap: () => ({ message: '仅支持 md、html、docx 导出格式' }),
  }),
});

export type ArticleExportQueryInput = z.infer<typeof articleExportQuerySchema>;

export const actionHomeQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  productLineId: z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    z.string().trim().regex(BRAND_ID_PATTERN, '产品线编号不合法').optional(),
  ),
  days: z.coerce.number().int().min(1).max(90).optional().default(14),
});

export type ActionHomeQueryInput = z.infer<typeof actionHomeQuerySchema>;

export type RetestMetricSnapshot = {
  mentionRate: number;
  avgPosition: number | null;
  sentiment: string | null;
  citationHit: boolean;
};

export type GeoPublishRecordDto = {
  id: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: string;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: RetestMetricSnapshot | null;
  afterMetrics: RetestMetricSnapshot | null;
  distributionTaskId?: string | null;
  crawlStatus?: CrawlProbeStatus;
  crawlCheckedAt?: string | null;
  crawlReportJson?: CrawlProbeReport | null;
  indexNowSubmitted?: boolean;
  retestSchedules?: GeoRetestScheduleDto[];
};

export type ActionHomeResponse = {
  brandId: string;
  brandMarketId: string;
  productLineId?: string | null;
  market: GeoMarket;
  health: {
    days: number;
    mentionRatePct: number;
    shareOfVoicePct: number;
    avgPosition: number | null;
    ownedCitationRatePct: number;
    completedChecks: number;
    hasSimulatedObservations?: boolean;
  };
  topBriefs: Array<{
    id: string;
    productLineId?: string | null;
    sourceType: string;
    priorityScore: number;
    diagnosisSummary: string;
    suggestedTitle: string;
    targetPrompt: string;
    recommendedRecipe: GeoRecipe;
    targetFormat: GeoTargetFormat;
    recommendedChannels: Array<{
      channel: string;
      reason: string;
      providerHint?: ChannelProvider;
      priority?: 'HIGH' | 'MEDIUM';
      citedExampleUrls?: string[];
    }>;
  }>;
  recentArticles: Array<{
    id: string;
    productLineId?: string | null;
    title: string;
    recipe: GeoRecipe;
    geoScore: number;
    status: GeoArticleStatus;
    updatedAt: string;
    publishRecord?: GeoPublishRecordDto | null;
  }>;
  distributionSummary?: DistributionSummaryDto;
  retestBudget?: RetestBudgetSummaryDto;
};

// ==================== GEO 0–100 实时体检、JSON-LD 与 llms.txt 纯函数 ====================

export type EvaluateGeoArticleInput = {
  market: GeoMarket;
  locale?: string;
  localBrandName: string;
  category?: string;
  localCategory?: string | null;
  ownedDomains?: readonly string[];
  title: string;
  targetPrompt: string;
  contentMarkdown: string;
  targetFanOuts?: readonly string[];
  matchedFactIds?: readonly string[];
  brandFactTexts?: readonly string[];
  complianceFlags?: readonly GeoComplianceFlag[];
};

const AI_CLICHE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /在数字化浪潮下/, label: '在数字化浪潮下' },
  { pattern: /随着科技的飞速发展|随着人工智能的快速发展/, label: '随着科技的飞速发展' },
  { pattern: /众所周知/, label: '众所周知' },
  { pattern: /综上所述|总而言之/, label: '综上所述' },
  { pattern: /不言而喻|毋庸置疑/, label: '不言而喻' },
  {
    pattern: /in today['’]s fast-paced digital world/i,
    label: "in today's fast-paced digital world",
  },
  { pattern: /in conclusion,\s*it is worth noting/i, label: 'in conclusion, it is worth noting' },
];

const LEGACY_PLACEHOLDER_RE = /\{训练词占位符\}|\{转化词占位符\}|【品牌\d+】/;
const GFM_DIVIDER_CELL_RE = /^[ \t]*:?-{3,}:?[ \t]*$/;

function isGfmTableDividerLine(line: string): boolean {
  if (!line.includes('|') || !line.includes('---')) return false;
  let trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells = trimmed.split('|');
  if (cells.length < 2) return false;
  for (const cell of cells) {
    if (!GFM_DIVIDER_CELL_RE.test(cell)) return false;
  }
  return true;
}

function hasGfmTable(markdown: string): boolean {
  if (!markdown.includes('|') || !markdown.includes('---')) return false;
  const lines = markdown.split(/\r\n?|\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = lines[i]!;
    if (!header.includes('|')) continue;
    const divider = lines[i + 1]!;
    if (!isGfmTableDividerLine(divider)) continue;
    let trimmedHeader = header.trim();
    if (trimmedHeader.startsWith('|')) trimmedHeader = trimmedHeader.slice(1);
    if (trimmedHeader.endsWith('|')) trimmedHeader = trimmedHeader.slice(0, -1);
    const headerCells = trimmedHeader.split('|');
    if (headerCells.length >= 2 && headerCells.some((cell) => cell.trim().length > 0)) {
      return true;
    }
  }
  return false;
}

const SPEC_METRIC_RE =
  /\b\d+(?:\.\d+)?[\s-]*(?:W|dB|dBA|TB|GB|MB\/s|GB\/s|GbE|Wh|mAh|mm|cm|kg|ms|Hz|GHz|nm|lm|RPM|USD|bays?|years?|yrs?|hours?|hrs?|cycles?)\b|\b\d+(?:\.\d+)?\s*(?:%|℃|°C)|(?<!\d)\d+(?:\.\d+)?\s*(?:瓦|分贝|盘位|年|小时|元|万元|倍|千兆|万兆)|\b(?:ISO\s*\d+|UL\s*\d*|CE|FCC|RoHS|DDR[45]|NVMe|RAID\s*\d+|N\d{3,4}|IP\d{2}|4K|LiFePO4)\b/gi;
const CN_LINGERING_SUPERLATIVE_RE =
  /全网第一|行业第一|国家级|世界级|最顶级|顶级|最强|唯一|第一|绝对|终极|100\s*%|百分之百/g;

function sanitizeJsonLdText(raw: string): string {
  return stripHtmlTagsLinear(raw.replace(/<\s*\/\s*script/gi, '&lt;/script'), ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function serializeJsonLdSafe(schema: Record<string, unknown>): string {
  return JSON.stringify(schema, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function extractFirstBodyParagraph(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buf.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('```')) {
      if (buf.length > 0) break;
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+[.、)]\s+/.test(line)) {
      if (buf.length > 0) break;
      continue;
    }
    buf.push(line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1'));
  }
  return buf.join(' ').trim();
}

function stripOuterBoldMarkers(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('**')) s = s.slice(2).trimStart();
  if (s.endsWith('**')) s = s.slice(0, -2).trimEnd();
  return s;
}

function stripListAndQuotePrefix(raw: string): { text: string; hadListPrefix: boolean } {
  let s = raw.trim();
  let hadListPrefix = false;
  for (let depth = 0; depth < 3; depth += 1) {
    let changed = false;
    while (s.startsWith('>')) {
      s = s.slice(1).trimStart();
      changed = true;
    }
    if (
      s.length >= 2 &&
      (s[0] === '-' || s[0] === '*' || s[0] === '+' || s[0] === '•') &&
      (s[1] === ' ' || s[1] === '\t')
    ) {
      s = s.slice(2).trimStart();
      hadListPrefix = true;
      changed = true;
      continue;
    }
    let p = 0;
    while (p < s.length && p < 4 && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) {
      p += 1;
    }
    if (p > 0 && p < s.length) {
      const sep = s[p];
      if (sep === '、') {
        s = s.slice(p + 1).trimStart();
        hadListPrefix = true;
        changed = true;
        continue;
      }
      if (
        (sep === '.' || sep === ')') &&
        p + 1 < s.length &&
        (s[p + 1] === ' ' || s[p + 1] === '\t')
      ) {
        s = s.slice(p + 2).trimStart();
        hadListPrefix = true;
        changed = true;
        continue;
      }
    }
    if (!changed) break;
  }
  return { text: s, hadListPrefix };
}

function stripFaqHeadingPrefix(raw: string): { text: string; isHeading: boolean } {
  const s = raw.trimStart();
  if (s.startsWith('####')) {
    const after = s.slice(4);
    if (after && (after[0] === ' ' || after[0] === '\t')) {
      return { text: after.trimStart(), isHeading: true };
    }
  } else if (s.startsWith('###')) {
    const after = s.slice(3);
    if (after && (after[0] === ' ' || after[0] === '\t')) {
      return { text: after.trimStart(), isHeading: true };
    }
  }
  return { text: s, isHeading: false };
}

function parseFaqQuestionLine(rawLine: string): string | null {
  const { text: withoutList } = stripListAndQuotePrefix(rawLine);
  const { text: withoutHeading } = stripFaqHeadingPrefix(withoutList);
  let s = withoutHeading.trim();
  if (!s) return null;
  if (s.startsWith('**')) {
    s = s.slice(2).trimStart();
  }
  const first = s[0];
  if (first !== 'Q' && first !== 'q' && first !== '问') return null;
  let p = 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  const digitStart = p;
  while (p < s.length && p - digitStart < 4 && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) {
    p += 1;
  }
  const hasNumber = p > digitStart;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  if (s.startsWith('**', p)) {
    p += 2;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  }
  if (p >= s.length) return null;
  const delim = s[p];
  const validDelim =
    delim === ':' ||
    delim === '：' ||
    (hasNumber && delim === '.' && p + 1 < s.length && (s[p + 1] === ' ' || s[p + 1] === '\t'));
  if (!validDelim) return null;
  const rest = stripOuterBoldMarkers(s.slice(p + 1));
  return rest || null;
}

function parseFaqAnswerStartLine(rawLine: string): string | null {
  const { text: withoutList } = stripListAndQuotePrefix(rawLine);
  let s = withoutList.trim();
  if (!s) return null;
  if (s.startsWith('**')) {
    s = s.slice(2).trimStart();
  }
  const first = s[0];
  if (first !== 'A' && first !== 'a' && first !== '答') return null;
  let p = 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  const digitStart = p;
  while (p < s.length && p - digitStart < 4 && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) {
    p += 1;
  }
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  if (s.startsWith('**', p)) {
    p += 2;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p += 1;
  }
  if (p >= s.length || (s[p] !== ':' && s[p] !== '：')) return null;
  return stripOuterBoldMarkers(s.slice(p + 1));
}

function isFaqSectionH2(rawLine: string): boolean {
  if (!/^##[ \t]+/.test(rawLine)) return false;
  const lower = rawLine.toLowerCase();
  return (
    lower.includes('faq') ||
    lower.includes('常见问题') ||
    lower.includes('高频问答') ||
    lower.includes('常见疑问') ||
    lower.includes('frequently asked questions')
  );
}

function parseFaqSectionQuestionLine(rawLine: string): string | null {
  const explicit = parseFaqQuestionLine(rawLine);
  if (explicit) return explicit;
  if (parseFaqAnswerStartLine(rawLine) !== null) return null;

  const trimmed = rawLine.trim();
  if (!trimmed || /^##[ \t]+/.test(trimmed)) return null;

  const { text: headingText, isHeading } = stripFaqHeadingPrefix(trimmed);
  if (isHeading) {
    const cleaned = stripOuterBoldMarkers(stripListAndQuotePrefix(headingText).text);
    return cleaned || null;
  }

  const { text: afterList, hadListPrefix } = stripListAndQuotePrefix(trimmed);
  if (hadListPrefix) {
    const isBoldQuestion =
      afterList.startsWith('**') && afterList.endsWith('**') && afterList.length > 4;
    const endsWithQuestionMark = afterList.endsWith('?') || afterList.endsWith('？');
    if (isBoldQuestion || endsWithQuestionMark) {
      const cleaned = stripOuterBoldMarkers(afterList);
      return cleaned || null;
    }
    return null;
  }

  if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
    const cleaned = stripOuterBoldMarkers(trimmed);
    return cleaned || null;
  }

  return null;
}

function extractFaqPairs(
  markdown: string,
  fallbackQuestion: string,
  fallbackAnswer: string,
): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  // Precompute whether each line lies inside a `## FAQ / 常见问题` section (O(N))
  const inFaqSection: boolean[] = new Array(lines.length).fill(false);
  let insideFaq = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (/^##[ \t]+/.test(line)) {
      insideFaq = isFaqSectionH2(line);
    } else if (insideFaq) {
      inFaqSection[idx] = true;
    }
  }

  // Pass 1: Explicit Q:/Q1:/问:/问1: pairs (with optional list, bold, or ###/#### heading wrappers)
  let i = 0;
  while (i < lines.length && pairs.length < 6) {
    const qRaw = parseFaqQuestionLine(lines[i]!);
    if (!qRaw) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') {
      j += 1;
    }
    if (j >= lines.length) break;

    const aFirstExplicit = parseFaqAnswerStartLine(lines[j]!);
    const nextTrimmedAtJ = lines[j]!.trim();
    const allowImplicitAnswer =
      aFirstExplicit === null &&
      (inFaqSection[i] || qRaw.endsWith('?') || qRaw.endsWith('？')) &&
      !/^#{2,4}[ \t]+/.test(nextTrimmedAtJ) &&
      parseFaqQuestionLine(nextTrimmedAtJ) === null &&
      !(inFaqSection[j] && parseFaqSectionQuestionLine(nextTrimmedAtJ) !== null);

    if (aFirstExplicit === null && !allowImplicitAnswer) {
      i += 1;
      continue;
    }

    const answerParts: string[] = [];
    if (aFirstExplicit !== null) {
      if (aFirstExplicit) answerParts.push(aFirstExplicit);
    } else if (nextTrimmedAtJ) {
      answerParts.push(nextTrimmedAtJ);
    }

    let k = j + 1;
    while (k < lines.length) {
      const nextTrimmed = lines[k]!.trim();
      if (
        !nextTrimmed ||
        nextTrimmed.startsWith('##') ||
        parseFaqQuestionLine(nextTrimmed) !== null ||
        (inFaqSection[k] && parseFaqSectionQuestionLine(nextTrimmed) !== null) ||
        (nextTrimmed.startsWith('**') && nextTrimmed.endsWith('**'))
      ) {
        break;
      }
      answerParts.push(nextTrimmed);
      k += 1;
    }
    const q = sanitizeJsonLdText(qRaw);
    const a = sanitizeJsonLdText(answerParts.join(' '));
    if (q && a) {
      pairs.push({ question: q, answer: a });
    }
    i = k;
  }

  // Pass 2: FAQ section entries without explicit `Q:` prefix (###, ####, 1. **...**, - **...**, **...**)
  if (pairs.length === 0) {
    let idx = 0;
    while (idx < lines.length && pairs.length < 6) {
      if (!inFaqSection[idx]) {
        idx += 1;
        continue;
      }
      const qRaw = parseFaqSectionQuestionLine(lines[idx]!);
      if (!qRaw) {
        idx += 1;
        continue;
      }
      let j = idx + 1;
      while (j < lines.length && inFaqSection[j] && lines[j]!.trim() === '') {
        j += 1;
      }
      const answerParts: string[] = [];
      while (j < lines.length && inFaqSection[j]) {
        const trimmed = lines[j]!.trim();
        if (!trimmed || trimmed.startsWith('##')) break;
        if (answerParts.length > 0 && parseFaqSectionQuestionLine(trimmed) !== null) break;
        if (answerParts.length === 0) {
          const explicitAns = parseFaqAnswerStartLine(trimmed);
          if (explicitAns !== null) {
            if (explicitAns) answerParts.push(explicitAns);
            j += 1;
            continue;
          }
          if (parseFaqSectionQuestionLine(trimmed) !== null) break;
        }
        answerParts.push(trimmed);
        j += 1;
      }
      const q = sanitizeJsonLdText(qRaw);
      const a = sanitizeJsonLdText(answerParts.join(' '));
      if (q && a) {
        pairs.push({ question: q, answer: a });
      }
      idx = j;
    }
  }

  if (pairs.length === 0) {
    const q = sanitizeJsonLdText(fallbackQuestion) || 'Key Selection Question';
    const a = sanitizeJsonLdText(fallbackAnswer) || q;
    pairs.push({ question: q, answer: a });
  }
  return pairs;
}

function resolveDeliveryCategory(
  market: GeoMarket,
  category?: string,
  localCategory?: string | null,
): string | null {
  const localTrimmed = localCategory?.trim() ?? '';
  const baseTrimmed = category?.trim() ?? '';
  if (market !== 'GLOBAL') {
    return localTrimmed || baseTrimmed || null;
  }
  if (localTrimmed && !containsCjk(localTrimmed)) {
    return localTrimmed;
  }
  if (baseTrimmed && !containsCjk(baseTrimmed)) {
    return baseTrimmed;
  }
  const mapped = resolveGlobalCategoryLabel(baseTrimmed, localTrimmed);
  // If raw input was unmapped CJK and fell back to generic 'product', let callers decide fallback/omission
  if (mapped === 'product') {
    return null;
  }
  return containsCjk(mapped) ? null : mapped;
}

export function buildGeoSchemaJsonLd(input: {
  market: GeoMarket;
  locale?: string;
  localBrandName: string;
  category?: string;
  localCategory?: string | null;
  title: string;
  targetPrompt: string;
  contentMarkdown: string;
}): Record<string, unknown> {
  const brandName = sanitizeJsonLdText(input.localBrandName || 'GeoMix Brand');
  const headline = sanitizeJsonLdText(input.title || input.targetPrompt);
  const firstParagraph = extractFirstBodyParagraph(input.contentMarkdown);
  const description = sanitizeJsonLdText(firstParagraph || headline).slice(0, 240);
  const inLanguage = sanitizeJsonLdText(
    input.locale || (input.market === 'GLOBAL' ? 'en-US' : 'zh-CN'),
  );
  const qaPairs = extractFaqPairs(input.contentMarkdown, input.targetPrompt, description);
  const resolvedCategory = resolveDeliveryCategory(
    input.market,
    input.category,
    input.localCategory,
  );

  const graph: Array<Record<string, unknown>> = [
    {
      '@type': 'Article',
      headline,
      description,
      inLanguage,
      author: {
        '@type': 'Organization',
        name: brandName,
      },
      publisher: {
        '@type': 'Organization',
        name: brandName,
      },
    },
    {
      '@type': 'FAQPage',
      inLanguage,
      mainEntity: qaPairs.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.answer,
        },
      })),
    },
  ];

  if (input.market === 'GLOBAL' || resolvedCategory) {
    graph.push({
      '@type': 'Product',
      name: brandName,
      category: sanitizeJsonLdText(
        resolvedCategory || (input.market === 'GLOBAL' ? 'Consumer Product' : 'Consumer Hardware'),
      ),
      description,
      brand: {
        '@type': 'Brand',
        name: brandName,
      },
    });
  }

  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  };
}

function slugifyPathSegment(text: string): string {
  const collapsed = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start += 1;
  while (end > start && collapsed[end - 1] === '-') end -= 1;
  const ascii = collapsed.slice(start, end).slice(0, 64);
  return ascii || 'geo-guide';
}

export function buildLlmsTxtSnippet(input: {
  market: GeoMarket;
  localBrandName: string;
  category?: string;
  localCategory?: string | null;
  ownedDomains?: readonly string[];
  title: string;
  targetPrompt: string;
  contentMarkdown: string;
}): string | null {
  if (input.market !== 'GLOBAL') return null;
  const brandName = input.localBrandName.replace(/[\r\n]+/g, ' ').trim() || 'Brand';
  const rawDomain = input.ownedDomains?.[0]?.trim() || '';
  const cleanDomain =
    rawDomain
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/[\s<>()[\]]+/g, '') || `${slugifyPathSegment(brandName)}.com`;
  const rawTitle = input.title.trim() || input.targetPrompt.trim() || `${brandName} Guide`;
  const title =
    rawTitle
      .replace(/[\r\n[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `${brandName} Guide`;
  const summary =
    extractFirstBodyParagraph(input.contentMarkdown)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 160) || `Verified product comparison and specifications for ${brandName}.`;
  const slug = slugifyPathSegment(title);
  const resolvedCategory = resolveDeliveryCategory('GLOBAL', input.category, input.localCategory);
  const categorySuffix = resolvedCategory
    ? ` (${resolvedCategory.replace(/[\r\n]+/g, ' ').trim()})`
    : '';

  return [
    `# ${brandName}`,
    '',
    `> Authoritative product specifications, independent benchmarks, and buying guides for ${brandName}${categorySuffix}.`,
    '',
    '## Featured GEO Guides',
    `- [${title}](https://${cleanDomain}/guides/${slug}): ${summary}`,
  ].join('\n');
}

export function buildCrawlerChecklist(
  market: GeoMarket,
): Array<{ bot: string; purpose: string; recommended: boolean }> {
  if (market === 'GLOBAL') {
    return [
      { bot: 'GPTBot', purpose: 'OpenAI ChatGPT retrieval & citation indexing', recommended: true },
      { bot: 'OAI-SearchBot', purpose: 'ChatGPT live web search citations', recommended: true },
      {
        bot: 'PerplexityBot',
        purpose: 'Perplexity answer citations & source verification',
        recommended: true,
      },
      { bot: 'ClaudeBot', purpose: 'Anthropic Claude web knowledge indexing', recommended: true },
      {
        bot: 'Google-Extended',
        purpose: 'Google AI Overviews & Gemini grounding',
        recommended: true,
      },
    ];
  }
  return [
    { bot: 'Bytespider', purpose: '豆包 / 今日头条内容检索与引用', recommended: true },
    { bot: 'Baiduspider', purpose: '文心一言 / 百度搜索索引', recommended: true },
    { bot: 'GPTBot', purpose: '海外/跨语种 AI 检索索引（官网可选）', recommended: false },
  ];
}

export function buildRecommendedChannelsForMarket(
  market: GeoMarket,
): Array<{ channel: string; reason: string }> {
  if (market === 'GLOBAL') {
    return [
      {
        channel: 'Official Blog / Docs',
        reason: 'Primary source for JSON-LD Schema & llms.txt citation',
      },
      {
        channel: 'Reddit',
        reason: 'High-trust community consensus frequently cited by Perplexity & ChatGPT',
      },
      {
        channel: 'Quora / Tech Review Media',
        reason: 'Long-tail Q&A authority for buyer comparison queries',
      },
    ];
  }
  return [
    { channel: '知乎', reason: '深度问答与参数对比实测在国内 AI 引擎中引用权重高' },
    { channel: '什么值得买 / 今日头条', reason: '豆包与 DeepSeek 高频抓取评测与选购清单阵地' },
    { channel: '微信公众号 / 官网专栏', reason: '沉淀品牌一手实测参数与长期权威信源' },
  ];
}

function isFanOutCovered(markdownLower: string, fanOut: string): boolean {
  const cleaned = fanOut.trim().toLowerCase();
  if (!cleaned) return true;
  if (markdownLower.includes(cleaned)) return true;
  const tokens = cleaned
    .split(/[\s,，、/|+_-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => markdownLower.includes(token));
  return matched.length >= Math.ceil(tokens.length * 0.6);
}

/**
 * 实时免费 GEO 0–100 五维体检纯函数（同时在 M4-A 生成/编辑及 M5 实时体检接口复用）。
 */
export function evaluateGeoArticle(input: EvaluateGeoArticleInput): GeoEvaluationResult {
  const md = input.contentMarkdown.replace(/\r\n?/g, '\n').trim();
  const mdLower = md.toLowerCase();
  const market = input.market;

  // 1. Direct Answer (max 20)
  const firstPara = extractFirstBodyParagraph(md);
  const directAnswerHints: string[] = [];
  let directAnswerScore = 0;
  if (!firstPara || firstPara.length < 12) {
    directAnswerHints.push('建议在开篇首段直接给出明确结论或选购建议（60–120 字以内）');
  } else {
    const startsWithCliche = AI_CLICHE_PATTERNS.some((c) => c.pattern.test(firstPara.slice(0, 40)));
    if (startsWithCliche) {
      directAnswerScore = 4;
      directAnswerHints.push('首段包含空泛 AI 套话，建议改为开门见山的直接结论');
    } else {
      const charLen = Array.from(firstPara).length;
      const firstSentence = firstPara.split(/[。！？.!?]/)[0] ?? firstPara;
      const firstSentenceLen = Array.from(firstSentence).length;
      const mentionsBrandOrMetric =
        (input.localBrandName &&
          firstPara.toLowerCase().includes(input.localBrandName.toLowerCase())) ||
        /\d+/.test(firstPara);
      if (charLen <= 180 || firstSentenceLen <= 110) {
        directAnswerScore = mentionsBrandOrMetric ? 20 : 17;
      } else if (charLen <= 280) {
        directAnswerScore = mentionsBrandOrMetric ? 16 : 14;
        directAnswerHints.push('首段略长，可进一步精简至 120 字以内直答核心问题');
      } else {
        directAnswerScore = 10;
        directAnswerHints.push('首段过长，建议提炼 60–100 字核心结论前置');
      }
    }
  }

  // 2. Structured Extractable (max 20)
  const structuredHints: string[] = [];
  let structuredScore = 0;
  const hasTable = hasGfmTable(md);
  if (hasTable) structuredScore += 8;
  else structuredHints.push('建议增加 Markdown 参数对比表以提升 AI 结构化抽取率');

  const h2Matches = md.match(/^##\s+.+$/gm) ?? [];
  if (h2Matches.length >= 3) structuredScore += 6;
  else if (h2Matches.length >= 1) {
    structuredScore += 3;
    structuredHints.push('建议补充至至少 3 个清晰 H2 二级标题拆解主题');
  } else {
    structuredHints.push('缺少二级标题（##），建议按子问题拆分为 3–5 个小节');
  }

  const hasList = /^[-*•]\s+.+$/m.test(md) || /^\d+[.、)]\s+.+$/m.test(md);
  if (hasList) structuredScore += 3;
  else structuredHints.push('建议增加要点清单方便 AI 快速摘录');

  const hasFaq =
    /FAQ|常见问题|高频问答|Frequently Asked Questions|\*\*Q\s*\d*\s*[:：]|\*\*问\s*\d*\s*[:：]|^#{3,4}[ \t]+(?:Q|问)\s*\d*\s*[:：]/im.test(
      md,
    );
  if (hasFaq) structuredScore += 3;
  else structuredHints.push('建议在文末补充 2–5 组 FAQ 问答块');

  // 3. Fact Density (max 25)
  const factHints: string[] = [];
  const specMatches = new Set(
    (md.match(SPEC_METRIC_RE) ?? []).map((s) => s.toLowerCase().replace(/[\s-]+/g, '')),
  );
  const specCount = specMatches.size;
  let numericPoints = 0;
  if (specCount >= 5) numericPoints = 15;
  else if (specCount === 4) numericPoints = 13;
  else if (specCount === 3) numericPoints = 11;
  else if (specCount === 2) numericPoints = 8;
  else if (specCount === 1) numericPoints = 5;
  else factHints.push('缺少量化规格参数或实测数值（如功耗 W、噪音 dB、容量 TB 等）');

  const matchedFactsCount = input.matchedFactIds?.length ?? 0;
  const mentionsBrand = Boolean(
    input.localBrandName.trim() && mdLower.includes(input.localBrandName.trim().toLowerCase()),
  );
  const factAnchors = (input.brandFactTexts ?? []).join(' ').match(SPEC_METRIC_RE) ?? [];
  const factOverlapCount = new Set(
    factAnchors
      .map((a) => a.toLowerCase().replace(/[\s-]+/g, ''))
      .filter((a) => specMatches.has(a)),
  ).size;
  const hasFactEvidence = specCount > 0 || factOverlapCount > 0 || mentionsBrand;

  let brandFactPoints = 0;
  if (!hasFactEvidence) {
    brandFactPoints = 0;
  } else if (matchedFactsCount >= 2) {
    brandFactPoints = specCount >= 2 || factOverlapCount >= 1 ? 10 : 6;
  } else if (matchedFactsCount === 1) {
    brandFactPoints = specCount >= 1 || factOverlapCount >= 1 ? 8 : 5;
  } else if ((input.brandFactTexts ?? []).length > 0) {
    brandFactPoints =
      factOverlapCount >= 2
        ? 9
        : factOverlapCount === 1
          ? 6
          : mentionsBrand && specCount >= 2
            ? 7
            : 2;
  } else if (mentionsBrand && specCount >= 2) {
    brandFactPoints = 7;
  }
  const missingSlots = extractMissingFactSlots(md);
  const factDensityScore = Math.max(
    0,
    Math.min(25, numericPoints + brandFactPoints - (missingSlots.length > 0 ? 2 : 0)),
  );
  if (factDensityScore < 15 && factHints.length === 0) {
    factHints.push('建议注入更多来自品牌事实卡的实测数据、认证资质或真实案例');
  }

  // 4. Fan-Out Coverage (max 20)
  const fanOutHints: string[] = [];
  const cleanedFanOuts = Array.from(
    new Set((input.targetFanOuts ?? []).map((q) => q.trim()).filter((q) => q.length > 0)),
  );
  const coveredFanOuts: string[] = [];
  const missingFanOuts: string[] = [];
  let fanOutScore = 0;
  if (cleanedFanOuts.length > 0) {
    for (const q of cleanedFanOuts) {
      if (isFanOutCovered(mdLower, q)) coveredFanOuts.push(q);
      else missingFanOuts.push(q);
    }
    fanOutScore = Math.round((coveredFanOuts.length / cleanedFanOuts.length) * 20);
    if (missingFanOuts.length > 0) {
      fanOutHints.push(`尚有 ${missingFanOuts.length} 个目标拆解词未覆盖，可一键补写小节`);
    }
  } else {
    fanOutScore = h2Matches.length >= 3 ? 18 : h2Matches.length >= 1 ? 12 : 4;
    if (fanOutScore < 14) {
      fanOutHints.push('可围绕高频衍生提问补充更多子章节以提升覆盖度');
    }
  }

  // 5. De-AI & Compliance (max 15)
  const deAiHints: string[] = [];
  let deAiScore = 15;
  if (missingSlots.length > 0) {
    deAiScore -= Math.min(8, missingSlots.length * 5);
    const token = input.market === 'GLOBAL' ? '[TBD]' : '[待补充]';
    deAiHints.push(`正文包含 ${missingSlots.length} 处 ${token} 缺失事实槽位，补填后可立即提分`);
  }
  if (LEGACY_PLACEHOLDER_RE.test(md)) {
    deAiScore -= 6;
    deAiHints.push('检测到遗留占位符残留，请清理后发布');
  }
  const matchedCliches = AI_CLICHE_PATTERNS.filter((c) => c.pattern.test(md));
  if (matchedCliches.length > 0) {
    deAiScore -= Math.min(8, matchedCliches.length * 4);
    deAiHints.push('检测到明显 AI 套话，建议使用「更客观去广告味」局部改写');
  }
  if (market === 'CN') {
    const cnAdFlags = (input.complianceFlags ?? []).filter(
      (f) => f.code === 'AD_LAW_SUPERLATIVE' || f.code === 'AD_LAW_FLAG',
    );
    const superlativeMatches = md.match(CN_LINGERING_SUPERLATIVE_RE) ?? [];
    if (cnAdFlags.length > 0 || superlativeMatches.length > 0) {
      const penalty = Math.min(6, Math.max(cnAdFlags.length, superlativeMatches.length) * 3);
      deAiScore -= penalty;
      deAiHints.push('国内轨检测到广告法极限词或风险词，请核对合规表达');
    }
  }
  deAiScore = Math.max(0, Math.min(15, deAiScore));

  const geoScore = Math.max(
    0,
    Math.min(100, directAnswerScore + structuredScore + factDensityScore + fanOutScore + deAiScore),
  );

  const geoScoreDetail: GeoScoreDetail = {
    dimensions: {
      directAnswer: {
        key: 'directAnswer',
        label: '首段直答',
        score: directAnswerScore,
        maxScore: 20,
        passed: directAnswerScore >= 14,
        hints: directAnswerHints,
      },
      structuredExtractable: {
        key: 'structuredExtractable',
        label: '结构化可抽取',
        score: structuredScore,
        maxScore: 20,
        passed: structuredScore >= 14,
        hints: structuredHints,
      },
      factDensity: {
        key: 'factDensity',
        label: '事实与量化密度',
        score: factDensityScore,
        maxScore: 25,
        passed: factDensityScore >= 15,
        hints: factHints,
      },
      fanOutCoverage: {
        key: 'fanOutCoverage',
        label: 'Fan-Out 覆盖率',
        score: fanOutScore,
        maxScore: 20,
        passed: fanOutScore >= 14,
        hints: fanOutHints,
      },
      deAiCompliance: {
        key: 'deAiCompliance',
        label: '去 AI 味与合规',
        score: deAiScore,
        maxScore: 15,
        passed: deAiScore >= 11,
        hints: deAiHints,
      },
    },
    coveredFanOuts,
    missingFanOuts,
  };

  return {
    geoScore,
    geoScoreDetail,
    uncoveredFanOuts: [...missingFanOuts],
    schemaJsonLd: buildGeoSchemaJsonLd({
      market,
      locale: input.locale,
      localBrandName: input.localBrandName,
      category: input.category,
      localCategory: input.localCategory,
      title: input.title,
      targetPrompt: input.targetPrompt,
      contentMarkdown: md,
    }),
    llmsTxtSnippet: buildLlmsTxtSnippet({
      market,
      localBrandName: input.localBrandName,
      category: input.category,
      localCategory: input.localCategory,
      ownedDomains: input.ownedDomains,
      title: input.title,
      targetPrompt: input.targetPrompt,
      contentMarkdown: md,
    }),
    crawlerChecklist: buildCrawlerChecklist(market),
    recommendedChannels: buildRecommendedChannelsForMarket(market),
  };
}
