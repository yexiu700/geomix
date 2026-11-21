/**
 * 零依赖 HTML 正文提取工具（供品牌官网事实提炼与竞品高引用页解析复用）。
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
};

const RAW_TEXT_NOISE_TAGS = ['script', 'style', 'noscript', 'template'] as const;

const STRUCTURAL_NOISE_TAGS = [
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'form',
  'button',
  'nav',
  'footer',
  'aside',
] as const;

const BOILERPLATE_LINE_RE =
  /^(?:首页|返回顶部|关于我们|联系我们|隐私政策|服务协议|版权所有|Copyright\b|All rights reserved|Cookie\s+Policy|Privacy\s+Policy|Terms\s+of\s+Service|Sign\s+in|Log\s+in|Menu|Navigation)$/i;

const BLOCK_CLOSE_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'tr',
  'div',
  'section',
  'header',
  'blockquote',
  'dd',
  'dt',
  'pre',
]);

const BLOCK_OPEN_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'tr',
  'div',
  'section',
  'blockquote',
  'dt',
  'hr',
]);

export function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (match, hex, dec, named) => {
    if (hex) {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (dec) {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (named) {
      const found = NAMED_ENTITIES[named.toLowerCase()];
      return found ?? match;
    }
    return match;
  });
}

function isTagNameBoundary(ch: string | undefined): boolean {
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

function findCloseTagEnd(
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
    while (
      i < lower.length &&
      (lower[i] === ' ' ||
        lower[i] === '\t' ||
        lower[i] === '\n' ||
        lower[i] === '\r' ||
        lower[i] === '\f')
    ) {
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
    parts.push(html.slice(cursor, start), ' ');
    const end = html.indexOf('-->', start + 4);
    if (end === -1) {
      break;
    }
    cursor = end + 3;
  }
  return parts.join('');
}

function stripRawTextNoiseTag(html: string, lower: string, tag: string): string {
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
    if (!isTagNameBoundary(lower[afterName])) {
      parts.push(html.slice(cursor, afterName));
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, start), '\n');
    const closeMatch = findCloseTagEnd(lower, tag, openEnd + 1);
    if (!closeMatch) {
      break;
    }
    cursor = closeMatch.end;
  }
  return parts.join('');
}

function stripStructuralNoiseTag(html: string, lower: string, tag: string): string {
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
      if (!isTagNameBoundary(lower[afterName])) {
        pos = afterName;
        continue;
      }
      const openEnd = lower.indexOf('>', afterName);
      if (openEnd === -1) {
        // No closing '>' remains anywhere in the string; no further open or close tags can terminate.
        break;
      }
      openStack.push(nextOpen);
      pos = openEnd + 1;
      continue;
    }

    // Handle closing tag
    const afterCloseName = nextClose + closeNeedle.length;
    let i = afterCloseName;
    while (
      i < lower.length &&
      (lower[i] === ' ' ||
        lower[i] === '\t' ||
        lower[i] === '\n' ||
        lower[i] === '\r' ||
        lower[i] === '\f')
    ) {
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
      parts.push('\n');
    } else if (parts.length === 0 || parts[parts.length - 1] !== '\n') {
      parts.push('\n');
    }
    cursor = end;
  }
  if (cursor < html.length) {
    parts.push(html.slice(cursor));
  }
  return parts.join('');
}

function stripNoiseBlocks(html: string, initialLower: string): { html: string; lower: string } {
  let out = stripCommentsLinear(html);
  let lower = out === html ? initialLower : out.toLowerCase();
  for (const tag of RAW_TEXT_NOISE_TAGS) {
    const next = stripRawTextNoiseTag(out, lower, tag);
    if (next !== out) {
      out = next;
      lower = out.toLowerCase();
    }
  }
  for (const tag of STRUCTURAL_NOISE_TAGS) {
    const next = stripStructuralNoiseTag(out, lower, tag);
    if (next !== out) {
      out = next;
      lower = out.toLowerCase();
    }
  }
  return { html: out, lower };
}

function extractTagContent(
  html: string,
  lower: string,
  tagName: 'article' | 'main' | 'body',
): string | null {
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;
  if (!lower.includes(closeNeedle) || !lower.includes(openNeedle)) {
    return null;
  }

  let best = '';
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) break;
    const afterName = start + openNeedle.length;
    if (!isTagNameBoundary(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) break;
    const closeMatch = findCloseTagEnd(lower, tagName, openEnd + 1);
    if (!closeMatch) break;

    const candidate = html.slice(openEnd + 1, closeMatch.start);
    if (candidate.length > best.length) {
      best = candidate;
    }
    cursor = closeMatch.end;
  }
  return best || null;
}

function extractFirstTagContent(
  rawHtml: string,
  lower: string,
  tagName: 'title' | 'h1',
): string | null {
  const openNeedle = `<${tagName}`;
  if (!lower.includes(`</${tagName}`) || !lower.includes(openNeedle)) {
    return null;
  }
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) return null;
    const afterName = start + openNeedle.length;
    if (!isTagNameBoundary(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    const openEnd = lower.indexOf('>', afterName);
    if (openEnd === -1) return null;
    const closeMatch = findCloseTagEnd(lower, tagName, openEnd + 1);
    if (!closeMatch) return null;
    return rawHtml.slice(openEnd + 1, closeMatch.start);
  }
  return null;
}

function extractOgTitle(rawHtml: string, lower: string): string | null {
  if (!lower.includes('og:title') || !lower.includes('<meta')) {
    return null;
  }
  let cursor = 0;
  let cachedCloseIdx = -1;
  let cachedNextLt = rawHtml.indexOf('<', 0);
  while (cursor < lower.length) {
    const start = lower.indexOf('<meta', cursor);
    if (start === -1) return null;
    const afterName = start + 5;
    if (!isTagNameBoundary(lower[afterName])) {
      cursor = afterName;
      continue;
    }
    if (cachedCloseIdx < afterName) {
      cachedCloseIdx = rawHtml.indexOf('>', afterName);
      if (cachedCloseIdx === -1) return null;
    }
    const closeIdx = cachedCloseIdx;
    if (cachedNextLt !== -1 && cachedNextLt < afterName) {
      cachedNextLt = rawHtml.indexOf('<', afterName);
    }
    if (cachedNextLt !== -1 && cachedNextLt < closeIdx) {
      cursor = cachedNextLt;
      continue;
    }
    const tagSlice = rawHtml.slice(start, closeIdx + 1);
    if (/property\s*=\s*(?:"og:title"|'og:title')/i.test(tagSlice)) {
      const contentMatch = /\bcontent\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tagSlice);
      const val = contentMatch?.[1] ?? contentMatch?.[2];
      if (val) return val;
    }
    cursor = closeIdx + 1;
  }
  return null;
}

function stripTagsLinear(input: string): string {
  if (!input.includes('<')) return input;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const lt = input.indexOf('<', cursor);
    if (lt === -1) {
      parts.push(input.slice(cursor));
      break;
    }
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) {
      parts.push(input.slice(cursor));
      break;
    }
    if (lt > cursor) {
      parts.push(input.slice(cursor, lt));
    }
    parts.push(' ');
    cursor = gt + 1;
  }
  return parts.join('');
}

function extractTitle(rawHtml: string, lower: string): string {
  const ogTitle = extractOgTitle(rawHtml, lower);
  const titleText =
    ogTitle ??
    extractFirstTagContent(rawHtml, lower, 'title') ??
    extractFirstTagContent(rawHtml, lower, 'h1') ??
    '';

  const cleaned = decodeHtmlEntities(stripTagsLinear(titleText)).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.replace(/\s*[-|—–·_]\s*[^-|—–·_]{2,30}$/, '').trim() || cleaned;
}

function isAsciiWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isAsciiAlphaNum(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function convertHtmlTagsLinear(fragment: string): string {
  if (!fragment.includes('<')) return fragment;
  const parts: string[] = [];
  let cursor = 0;
  let lastClosedCell = false;

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
      const between = fragment.slice(cursor, lt);
      if (lastClosedCell && between.trim().length > 0) {
        lastClosedCell = false;
      }
      parts.push(between);
    }

    let p = lt + 1;
    while (p < gt && isAsciiWs(fragment.charCodeAt(p))) p += 1;
    let isClosing = false;
    if (p < gt && fragment.charCodeAt(p) === 47) {
      isClosing = true;
      p += 1;
      while (p < gt && isAsciiWs(fragment.charCodeAt(p))) p += 1;
    }
    const nameStart = p;
    while (p < gt && isAsciiAlphaNum(fragment.charCodeAt(p))) p += 1;
    const tagName = p > nameStart ? fragment.slice(nameStart, p).toLowerCase() : '';

    if (!isClosing && tagName === 'br') {
      parts.push('\n');
      lastClosedCell = false;
    } else if (!isClosing && (tagName === 'td' || tagName === 'th')) {
      parts.push(lastClosedCell ? ' | ' : ' ');
      lastClosedCell = false;
    } else if (isClosing && (tagName === 'td' || tagName === 'th')) {
      parts.push(' ');
      lastClosedCell = true;
    } else if (isClosing && BLOCK_CLOSE_TAGS.has(tagName)) {
      parts.push('\n');
      lastClosedCell = false;
    } else if (!isClosing && BLOCK_OPEN_TAGS.has(tagName)) {
      parts.push('\n');
      lastClosedCell = false;
    } else {
      parts.push(' ');
      lastClosedCell = false;
    }

    cursor = gt + 1;
  }

  return parts.join('');
}

function htmlFragmentToLines(fragment: string): string[] {
  const withStructure = convertHtmlTagsLinear(fragment);

  const decoded = decodeHtmlEntities(withStructure).replace(/\r\n/g, '\n');
  const lines: string[] = [];
  for (const rawLine of decoded.split('\n')) {
    let line = rawLine.replace(/[ \t\f\v]+/g, ' ').trim();
    if (!line) continue;
    if (line.includes('|')) {
      line = line
        .replace(/ ?\| ?/g, ' | ')
        .replace(/^\|\s*|\s*\|$/g, '')
        .trim();
      if (!line) continue;
    }
    if (BOILERPLATE_LINE_RE.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

export function extractPlainTextFromHtml(rawHtml: string): { title: string; text: string } {
  const html = typeof rawHtml === 'string' ? rawHtml : '';
  const rawLower = html.toLowerCase();
  const title = extractTitle(html, rawLower);
  const { html: cleaned, lower: cleanedLower } = stripNoiseBlocks(html, rawLower);

  const article = extractTagContent(cleaned, cleanedLower, 'article');
  const main = extractTagContent(cleaned, cleanedLower, 'main');
  const body = extractTagContent(cleaned, cleanedLower, 'body');

  let chosen = cleaned;
  for (const candidate of [article, main, body]) {
    if (!candidate) continue;
    const candidateText = htmlFragmentToLines(candidate).join('\n');
    if (nonWhitespaceLength(candidateText) >= 80) {
      chosen = candidate;
      break;
    }
  }

  const lines = htmlFragmentToLines(chosen);
  const text = lines.join('\n').trim();
  return { title, text };
}
