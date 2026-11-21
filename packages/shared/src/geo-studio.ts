import { z } from 'zod';
import { FAKE_MARK } from './adapters';
import { GEO_MARKETS, type GeoMarket } from './brands';
import type { GeoComplianceFlag } from './compliance';
import type { TaskStatusName } from './task-status';

/**
 * GeoMix 2.0 GEO 靶向写作台契约（Issue #326 / #331）。
 * 定义 4 大 GEO 配方、双市场目标阵地形态、SSE 流式写作协议、行内改写、2–20 篇批量队列、
 * 高级偏好，以及从 writing-tasks.ts 抽取复用的 Markdown→HTML 与正文后处理纯函数。
 */

export const GEO_RECIPES = [
  'AUTHORITY_GUIDE',
  'COMPARISON_MATRIX',
  'OBJECTION_FAQ',
  'CITATION_COUNTER',
] as const;
export type GeoRecipe = (typeof GEO_RECIPES)[number];

export const GEO_RECIPE_LABELS: Record<GeoRecipe, string> = {
  AUTHORITY_GUIDE: '权威选购指南',
  COMPARISON_MATRIX: '竞品公平对照评测',
  OBJECTION_FAQ: '痛点澄清与实测答疑',
  CITATION_COUNTER: '高引用信源超越稿',
};

export const GEO_TARGET_FORMATS = [
  'CN_DEEP_REVIEW',
  'CN_COMMUNITY_QA',
  'GLOBAL_AUTHORITY_GUIDE',
  'GLOBAL_COMMUNITY_DISCUSSION',
] as const;
export type GeoTargetFormat = (typeof GEO_TARGET_FORMATS)[number];

export const GEO_TARGET_FORMAT_LABELS: Record<GeoTargetFormat, string> = {
  CN_DEEP_REVIEW: '深度评测长文（头条/公众号/值得买）',
  CN_COMMUNITY_QA: '社区问答实测版（知乎/小红书）',
  GLOBAL_AUTHORITY_GUIDE: '独立站权威长文（含 Schema）',
  GLOBAL_COMMUNITY_DISCUSSION: '社区客观讨论版（Reddit/Quora 反硬广口吻）',
};

export function targetFormatsForMarket(market: GeoMarket): readonly GeoTargetFormat[] {
  return market === 'GLOBAL'
    ? (['GLOBAL_AUTHORITY_GUIDE', 'GLOBAL_COMMUNITY_DISCUSSION'] as const)
    : (['CN_DEEP_REVIEW', 'CN_COMMUNITY_QA'] as const);
}

export function defaultTargetFormatForMarket(market: GeoMarket): GeoTargetFormat {
  return market === 'GLOBAL' ? 'GLOBAL_AUTHORITY_GUIDE' : 'CN_DEEP_REVIEW';
}

export const GEO_ARTICLE_STATUSES = ['DRAFT', 'READY', 'PUBLISHED'] as const;
export type GeoArticleStatus = (typeof GEO_ARTICLE_STATUSES)[number];

export const GEO_ARTICLE_STATUS_LABELS: Record<GeoArticleStatus, string> = {
  DRAFT: '草稿',
  READY: '可发布',
  PUBLISHED: '已发布',
};

export const GEO_REWRITE_ACTIONS = ['DE_AD', 'TO_TABLE', 'ADD_EVIDENCE', 'CONCISE_ANSWER'] as const;
export type GeoRewriteAction = (typeof GEO_REWRITE_ACTIONS)[number];

export const GEO_REWRITE_ACTION_LABELS: Record<GeoRewriteAction, string> = {
  DE_AD: '更客观去广告味',
  TO_TABLE: '转为对比表格',
  ADD_EVIDENCE: '补充数据论据',
  CONCISE_ANSWER: '精简直答',
};

export const GEO_BATCH_MIN = 2 as const;
export const GEO_BATCH_MAX = 20 as const;
export const GEO_WRITE_DEFAULT_UNIT_POINTS = 10 as const;
export const GEO_TITLE_MIN = 10 as const;
export const GEO_TITLE_MAX = 60 as const;

export type PromptAssemblyMessage = {
  role: 'system' | 'user';
  content: string;
};

// ==================== 标题清洗与 Markdown→HTML 后处理（从 writing-tasks.ts 抽取） ====================

const KB_PROMPT_WRAPPER_LINE_PATTERNS = [
  /^【企业背景资料】\s*$/,
  /^【资料片段\s*\d+】\s*$/,
  /^只能使用以下事实，不得编造参数、资质或案例[:：]?\s*$/,
  /^——\s*企业事实（只能使用以下内容，不得超范围编造）\s*——\s*$/,
  /^——\s*本篇写作参数\s*——\s*$/,
  /^——\s*输出要求\s*——\s*$/,
  /^企业主体[:：]\s*.*$/,
];

const KB_OPEN_TO_CLOSE: Record<string, string> = {
  '(': ')',
  '（': '）',
  '【': '】',
  '「': '」',
  '《': '》',
};
const KB_CLOSE_SET = new Set(Object.values(KB_OPEN_TO_CLOSE));

const TITLE_COMPOUND_WORDS = new Set([
  '指南',
  '攻略',
  '解析',
  '解读',
  '评测',
  '测评',
  '对比',
  '建议',
  '方案',
  '要点',
  '清单',
  '步骤',
  '方法',
  '技巧',
  '标准',
  '边界',
  '事项',
  '实操',
  '避坑',
  '选型',
  '选购',
  '科普',
  '介绍',
  '说明',
  '推荐',
  '总结',
  '手册',
  '教程',
  '分析',
  '策略',
  '维度',
  '区别',
  '优势',
  '原理',
  '参数',
  '配置',
  '表现',
  '体验',
  '场景',
  '品牌',
  '产品',
  '服务',
  '支持',
  '快充',
  '充电',
  '实用',
  '问题',
  '注意',
  '常见',
  '核心',
  '评估',
  '参考',
  '方式',
  '选择',
  '使用',
  '落地',
  '执行',
  '核对',
  '梳理',
]);

function isAsciiWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9]/.test(ch));
}

function isPartOfAsciiToken(chars: readonly string[], index: number): boolean {
  const ch = chars[index];
  if (!ch) return false;
  if (isAsciiWordChar(ch)) return true;
  if (ch === '.' || ch === '_' || ch === '-') {
    return isAsciiWordChar(chars[index - 1]) && isAsciiWordChar(chars[index + 1]);
  }
  return false;
}

export function trimTitleAtCleanBoundary(
  raw: string,
  maxLen: number = GEO_TITLE_MAX,
  minLen: number = GEO_TITLE_MIN,
): string {
  const trimmed = raw.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= maxLen) {
    return trimmed;
  }

  const minBreak = Math.max(4, Math.min(minLen, Math.floor(maxLen * 0.55)));
  let end = maxLen;

  if (isPartOfAsciiToken(chars, end - 1) && isPartOfAsciiToken(chars, end)) {
    let backed = end;
    while (backed > minBreak && isPartOfAsciiToken(chars, backed - 1)) {
      backed -= 1;
    }
    if (backed >= minBreak && (backed === 0 || !isPartOfAsciiToken(chars, backed - 1))) {
      end = backed;
    }
  }

  const punctMinBreak = Math.max(minBreak, Math.floor(maxLen * 0.55));
  for (let i = Math.min(end, chars.length); i >= punctMinBreak; i -= 1) {
    const ch = chars[i - 1];
    if (!ch) continue;
    if (/[。！？]/.test(ch)) {
      end = i;
      break;
    }
    if (/[；;：:，,、|｜—]/.test(ch) && !isPartOfAsciiToken(chars, i - 1)) {
      end = i - 1;
      break;
    }
  }

  while (end > minBreak && end < chars.length) {
    const prev = chars[end - 1] ?? '';
    const next = chars[end] ?? '';
    if (TITLE_COMPOUND_WORDS.has(`${prev}${next}`)) {
      end -= 1;
      continue;
    }
    const fourCharWindow = chars
      .slice(Math.max(0, end - 3), Math.min(chars.length, end + 3))
      .join('');
    if (
      (prev === '注' && next === '意') ||
      (fourCharWindow.includes('注意事项') &&
        ((chars[end - 2] === '注' && prev === '意' && next === '事') ||
          (prev === '事' && next === '项')))
    ) {
      end -= 1;
      continue;
    }
    break;
  }

  const openIdx: number[] = [];
  for (let i = 0; i < end; i += 1) {
    const ch = chars[i]!;
    if (KB_OPEN_TO_CLOSE[ch]) {
      openIdx.push(i);
    } else if (KB_CLOSE_SET.has(ch) && openIdx.length > 0) {
      openIdx.pop();
    }
  }
  if (openIdx.length > 0 && openIdx[0]! >= 4) {
    end = openIdx[0]!;
  }

  const candidate = chars
    .slice(0, end)
    .join('')
    .replace(/[，,、：:；;—\-\s的与和及并或]+$/u, '')
    .trim();

  if (candidate.length > 0) {
    return candidate;
  }
  return chars.slice(0, maxLen).join('').trim();
}

/** 清理模型产出的单行标题：去引号/书名号/换行，在完整词组或标点边界处收敛至 minLen..maxLen。 */
export function cleanTitleText(
  raw: string,
  fallbackQuestion: string,
  minLen: number = GEO_TITLE_MIN,
  maxLen: number = GEO_TITLE_MAX,
): string {
  const firstLine =
    raw
      .split(/\r\n?|\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  let cleaned = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^(标题\s*[:：]\s*)/i, '')
    .replace(/["'“”‘’《》〈〉【】「」『』`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (Array.from(cleaned).length > maxLen) {
    cleaned = trimTitleAtCleanBoundary(cleaned, maxLen, minLen);
  }
  if (Array.from(cleaned).length === 0) {
    const fb = fallbackQuestion.replace(/["'“”‘’《》【】]/g, '').trim();
    return trimTitleAtCleanBoundary(fb, maxLen, minLen);
  }
  if (Array.from(cleaned).length < Math.min(6, minLen)) {
    const fb = fallbackQuestion.replace(/["'“”‘’《》【】]/g, '').trim();
    if (fb.length > cleaned.length) {
      return trimTitleAtCleanBoundary(fb, maxLen, minLen);
    }
  }
  return cleaned;
}

const PLEASANTRY_LINE =
  /^(好的|当然|没问题|收到|以下为您|以下是|下面为您|为您整理|这是一篇|根据您的要求)[^\n]*\n+/u;
const LEADING_H1 = /^#\s+[^\n]+\n+/u;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const LANDLINE_PATTERN = /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g;
const WECHAT_PATTERN = /(?:微信号?|WeChat|wechat|VX|vx)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]{4,23}/g;
const URL_PATTERN = /https?:\/\/[^\s)>"'】）]+/gi;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeMarkdownUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s"'<>]/.test(trimmed)) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) return true;
  return false;
}

function renderEmphasisOnEscaped(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function parseInlineMarkdownTarget(
  rawDest: string,
): { kind: 'safe'; url: string } | { kind: 'unsafe' } | { kind: 'literal' } {
  const trimmed = rawDest.trim();
  if (!trimmed) return { kind: 'literal' };

  // Angle-bracket destination: <url> optionally followed by quoted title
  if (trimmed.startsWith('<')) {
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle < 0) return { kind: 'literal' };
    const innerUrl = trimmed.slice(1, closeAngle).trim();
    const trailing = trimmed.slice(closeAngle + 1).trim();
    if (trailing && !/^(?:"[^"\r\n]*"|'[^'\r\n]*')$/.test(trailing)) {
      return { kind: 'literal' };
    }
    return isSafeMarkdownUrl(innerUrl) ? { kind: 'safe', url: innerUrl } : { kind: 'unsafe' };
  }

  // No whitespace inside destination: direct URL token
  if (!/\s/.test(trimmed)) {
    return isSafeMarkdownUrl(trimmed) ? { kind: 'safe', url: trimmed } : { kind: 'unsafe' };
  }

  // Optional quoted title after URL: url "title" or url 'title'
  const titled = /^([^\s]+)[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*')$/.exec(trimmed);
  if (titled) {
    const urlPart = titled[1] ?? '';
    return isSafeMarkdownUrl(urlPart) ? { kind: 'safe', url: urlPart } : { kind: 'unsafe' };
  }

  // Explicit unsafe scheme with embedded spaces/control chars (e.g. javascript:alert("hi there"))
  const compact = trimmed.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  if (
    compact.startsWith('javascript:') ||
    compact.startsWith('vbscript:') ||
    compact.startsWith('data:')
  ) {
    return { kind: 'unsafe' };
  }

  return { kind: 'literal' };
}

function renderNonCodeInline(segment: string, recursionDepth = 0): string {
  // Linear O(N) scanner for Markdown images ![alt](url) and links [label](url)
  // with precomputed balanced bracket/parenthesis tables (zero backtracking / zero ReDoS).
  if (!segment.includes('[')) {
    return renderEmphasisOnEscaped(escapeHtml(segment));
  }

  const len = segment.length;
  const matchBracket = new Int32Array(len).fill(-1);
  const matchParen = new Int32Array(len).fill(-1);
  const bracketStack: number[] = [];
  const parenStack: number[] = [];

  for (let p = 0; p < len; p += 1) {
    const ch = segment[p];
    if (ch === '\\' && p + 1 < len) {
      p += 1;
      continue;
    }
    if (ch === '[') {
      bracketStack.push(p);
    } else if (ch === ']') {
      if (bracketStack.length > 0) {
        matchBracket[bracketStack.pop()!] = p;
      }
    } else if (ch === '(') {
      parenStack.push(p);
    } else if (ch === ')') {
      if (parenStack.length > 0) {
        matchParen[parenStack.pop()!] = p;
      }
    }
  }

  let out = '';
  let plainStart = 0;
  let i = 0;

  while (i < len) {
    const isImage = segment[i] === '!' && i + 1 < len && segment[i + 1] === '[';
    const isLink = !isImage && segment[i] === '[';
    if (!isImage && !isLink) {
      i += 1;
      continue;
    }

    const bracketPos = isImage ? i + 1 : i;
    const labelStart = bracketPos + 1;
    const closeBracket = matchBracket[bracketPos]!;
    if (closeBracket === -1 || (!isImage && closeBracket === labelStart)) {
      i += 1;
      continue;
    }

    const openParen = closeBracket + 1;
    if (openParen >= len || segment[openParen] !== '(') {
      i += 1;
      continue;
    }

    const closeParen = matchParen[openParen]!;
    if (closeParen === -1) {
      i += 1;
      continue;
    }

    const destStart = openParen + 1;
    const destLen = closeParen - destStart;
    let target: { kind: 'safe'; url: string } | { kind: 'unsafe' } | { kind: 'literal' };
    if (destLen > 2560) {
      const headCompact = segment
        .slice(destStart, destStart + 64)
        .replace(/[\u0000-\u0020\u007f]+/g, '')
        .toLowerCase();
      target =
        headCompact.startsWith('javascript:') ||
        headCompact.startsWith('vbscript:') ||
        headCompact.startsWith('data:') ||
        headCompact.startsWith('<javascript:') ||
        headCompact.startsWith('<vbscript:') ||
        headCompact.startsWith('<data:')
          ? { kind: 'unsafe' }
          : { kind: 'literal' };
    } else {
      target = parseInlineMarkdownTarget(segment.slice(destStart, closeParen));
    }
    if (target.kind === 'literal') {
      i += 1;
      continue;
    }

    const rawLabel = segment.slice(labelStart, closeBracket);

    if (i > plainStart) {
      out += renderEmphasisOnEscaped(escapeHtml(segment.slice(plainStart, i)));
    }

    if (isImage) {
      if (target.kind === 'safe') {
        out += `<img src="${escapeHtml(target.url)}" alt="${escapeHtml(rawLabel)}" style="max-width:100%" />`;
      } else {
        out += escapeHtml(rawLabel);
      }
    } else {
      const renderedLabel =
        recursionDepth < 2 && rawLabel.includes('![')
          ? renderNonCodeInline(rawLabel, recursionDepth + 1)
          : renderEmphasisOnEscaped(escapeHtml(rawLabel));
      if (target.kind === 'safe') {
        out += `<a href="${escapeHtml(target.url)}" target="_blank" rel="noopener noreferrer">${renderedLabel}</a>`;
      } else {
        out += renderedLabel;
      }
    }

    i = closeParen + 1;
    plainStart = i;
  }

  if (plainStart < len) {
    out += renderEmphasisOnEscaped(escapeHtml(segment.slice(plainStart)));
  }
  return out;
}

function renderInlineMarkdown(line: string): string {
  const codeRe = /`([^`\n]+)`/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(line)) !== null) {
    if (match.index > lastIndex) {
      out += renderNonCodeInline(line.slice(lastIndex, match.index));
    }
    out += `<code>${escapeHtml(match[1] ?? '')}</code>`;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    out += renderNonCodeInline(line.slice(lastIndex));
  }
  return out;
}

const GFM_TABLE_DELIMITER_RE = /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/;

function splitGfmTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isGfmTableHeaderPair(headerLine: string, delimiterLine: string | undefined): boolean {
  if (!delimiterLine) return false;
  if (!headerLine.includes('|')) return false;
  const delimTrimmed = delimiterLine.trim();
  if (!GFM_TABLE_DELIMITER_RE.test(delimTrimmed)) return false;
  const headerCells = splitGfmTableCells(headerLine);
  const delimCells = splitGfmTableCells(delimTrimmed);
  return headerCells.length >= 2 && headerCells.length === delimCells.length;
}

/**
 * 将清洗后的 Markdown 转为严格白名单 XSS 安全 HTML（支持 GFM table、代码块、标题、列表、引用、安全图片/链接与行内强调）。
 */
export function markdownToSanitizedHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraphBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuf.length === 0) return;
    blocks.push(`<p>${paragraphBuf.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraphBuf = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }
    blocks.push(
      `<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${listType}>`,
    );
    listType = null;
    listItems = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();

    // Fenced code blocks ``` ... ```
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    // GFM Table: header row + delimiter row + 0..N body rows
    if (isGfmTableHeaderPair(line, lines[i + 1])) {
      flushParagraph();
      flushList();
      const headerCells = splitGfmTableCells(line);
      const colCount = headerCells.length;
      i += 2; // skip header & delimiter
      const bodyRows: string[][] = [];
      while (i < lines.length) {
        const candidate = (lines[i] ?? '').trim();
        if (!candidate || !candidate.includes('|')) break;
        if (
          /^#{1,6}\s+/.test(candidate) ||
          candidate.startsWith('```') ||
          candidate.startsWith('>')
        ) {
          break;
        }
        const cells = splitGfmTableCells(candidate);
        if (cells.length === 0) break;
        const normalized: string[] = [];
        for (let c = 0; c < colCount; c += 1) {
          normalized.push(cells[c] ?? '');
        }
        bodyRows.push(normalized);
        i += 1;
      }
      i -= 1; // outer loop will increment
      const theadHtml = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>`;
      const tbodyHtml =
        bodyRows.length > 0
          ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '<tbody></tbody>';
      blocks.push(`<table>${theadHtml}${tbodyHtml}</table>`);
      continue;
    }

    const h4 = /^####+\s+(.+)$/.exec(line);
    if (h4) {
      flushParagraph();
      flushList();
      blocks.push(`<h4>${renderInlineMarkdown(h4[1]!.trim())}</h4>`);
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      flushParagraph();
      flushList();
      blocks.push(`<h3>${renderInlineMarkdown(h3[1]!.trim())}</h3>`);
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInlineMarkdown(h2[1]!.trim())}</h2>`);
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInlineMarkdown(h1[1]!.trim())}</h2>`);
      continue;
    }
    const ul = /^[-*•]\s+(.+)$/.exec(line);
    if (ul) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(ul[1]!.trim());
      continue;
    }
    const ol = /^\d+[.、)]\s+(.+)$/.exec(line);
    if (ol) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(ol[1]!.trim());
      continue;
    }
    const quote = /^>\s*(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${renderInlineMarkdown(quote[1]!.trim())}</p></blockquote>`);
      continue;
    }
    flushList();
    paragraphBuf.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join('\n');
}

/**
 * Strictly linear O(N) replacement for `/<[^>]+>/g` (allowEmpty=false) and `/<[^>]*>/g` (allowEmpty=true).
 * Immediately terminates in O(1) once no closing `>` remains, eliminating O(N^2) ReDoS on runs of `<`.
 */
export function stripHtmlTagsLinear(input: string, replacement = '', allowEmpty = false): string {
  if (!input.includes('<')) return input;
  const len = input.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;
  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (!allowEmpty && gt === lt + 1) {
      i = lt + 1;
      continue;
    }
    out += input.slice(lastEmit, lt);
    if (replacement) out += replacement;
    i = gt + 1;
    lastEmit = i;
  }
  if (lastEmit === 0) return input;
  return out + input.slice(lastEmit);
}

function decodeValidHtmlCodePoint(codePoint: number): string | null {
  if (!Number.isFinite(codePoint) || codePoint < 0x0001 || codePoint > 0x10ffff) return null;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  return String.fromCodePoint(codePoint);
}

const BASIC_HTML_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeBasicHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(
    /&(?:#x([0-9a-fA-F]{1,8})|#(\d{1,8})|(nbsp|amp|lt|gt|quot|apos));/gi,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex) {
        return decodeValidHtmlCodePoint(Number.parseInt(hex, 16)) ?? match;
      }
      if (dec) {
        return decodeValidHtmlCodePoint(Number.parseInt(dec, 10)) ?? match;
      }
      if (named) {
        return BASIC_HTML_ENTITIES[named.toLowerCase()] ?? match;
      }
      return match;
    },
  );
}

export function stripHtmlToText(html: string): string {
  return decodeBasicHtmlEntities(
    stripHtmlTagsLinear(
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(th|td)>/gi, ' ')
        .replace(/<\/(p|h2|h3|h4|li|blockquote|tr|pre)>/gi, '\n'),
    ),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ==================== 缺失事实显式留槽解析与回填（F14） ====================

export const MISSING_FACT_CAPSULE_RE = /\[待补充[:：]([^\]\n]{1,120})\]/g;

export type MissingFactSlot = {
  raw: string;
  hint: string;
  index: number;
  start: number;
  end: number;
};

export function extractMissingFactSlots(markdown: string): MissingFactSlot[] {
  const slots: MissingFactSlot[] = [];
  const re = new RegExp(MISSING_FACT_CAPSULE_RE.source, 'g');
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(markdown)) !== null) {
    slots.push({
      raw: match[0],
      hint: (match[1] ?? '').trim(),
      index: idx,
      start: match.index,
      end: match.index + match[0].length,
    });
    idx += 1;
  }
  return slots;
}

export function replaceMissingFactSlot(
  markdown: string,
  target: { raw: string; index?: number },
  replacement: string,
): string {
  const cleanReplacement = replacement.trim();
  const slots = extractMissingFactSlots(markdown);
  const chosen =
    typeof target.index === 'number' &&
    slots[target.index] &&
    slots[target.index]!.raw === target.raw
      ? slots[target.index]!
      : slots.find((s) => s.raw === target.raw);
  if (!chosen) {
    const fallbackPos = markdown.indexOf(target.raw);
    if (fallbackPos < 0) return markdown;
    return (
      markdown.slice(0, fallbackPos) +
      cleanReplacement +
      markdown.slice(fallbackPos + target.raw.length)
    );
  }
  return markdown.slice(0, chosen.start) + cleanReplacement + markdown.slice(chosen.end);
}

/**
 * 正文后处理：去开头客套话与重复一级标题、去手机号/固话/微信号/外部裸网址（保留 Markdown 图片链接）、
 * 按市场补齐二级标题与 FAQ、转白名单 HTML。
 */
export function postProcessArticleMarkdown(
  rawMarkdown: string,
  context?: { question?: string; mainKeyword?: string; brand?: string; market?: GeoMarket },
): {
  cleanedMarkdown: string;
  contentHtml: string;
  contentText: string;
  charCount: number;
} {
  const market: GeoMarket = context?.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
  let md = rawMarkdown.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(md);
  if (fenced) {
    md = fenced[1]!.trim();
  }
  for (let i = 0; i < 3; i += 1) {
    const next = md.replace(PLEASANTRY_LINE, '').replace(LEADING_H1, '').trim();
    if (next === md) break;
    md = next;
  }

  // Mask Markdown images ![alt](url) so URL_PATTERN does not strip product/inline images.
  const preservedImages: string[] = [];
  md = md.replace(/!\[[^\]]*\]\((?:https?:\/\/|\/)[^)\s]+\)/gi, (imgToken) => {
    const key = `__GM_IMG_${preservedImages.length}__`;
    preservedImages.push(imgToken);
    return key;
  });

  md = md
    .split('\n')
    .filter((line) => !KB_PROMPT_WRAPPER_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join('\n')
    .replaceAll(FAKE_MARK, '')
    .replace(/只能使用以下事实，不得编造参数、资质或案例[:：]?\s*/g, '')
    .replace(/——\s*企业事实（只能使用以下内容，不得超范围编造）\s*——\s*/g, '')
    .replace(/([（(][^（）()\n]{1,40}[）)])(?:\s*\1)+/g, '$1')
    .replace(URL_PATTERN, '')
    .replace(WECHAT_PATTERN, '')
    .replace(MOBILE_PATTERN, '')
    .replace(LANDLINE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  for (let i = 0; i < preservedImages.length; i += 1) {
    md = md.replaceAll(`__GM_IMG_${i}__`, preservedImages[i]!);
  }

  if (!/^##\s+/m.test(md)) {
    const heading =
      market === 'GLOBAL'
        ? context?.mainKeyword
          ? `## ${context.mainKeyword} Key Takeaways`
          : '## Key Takeaways'
        : context?.mainKeyword
          ? `## ${context.mainKeyword}核心要点解析`
          : '## 核心要点解析';
    md = `${heading}\n\n${md}`;
  }

  if (!/FAQ|常见问题|Frequently Asked Questions/i.test(md)) {
    if (market === 'GLOBAL') {
      const q =
        context?.question?.trim() || 'What key metrics should buyers evaluate before deciding?';
      const brandLabel = context?.brand?.trim() || context?.mainKeyword?.trim() || 'this solution';
      md = `${md}\n\n## Frequently Asked Questions (FAQ)\n**Q: ${q}**\nA: Compare verified specifications, real-world test figures, and long-term maintenance costs for ${brandLabel} against your primary workload requirements.`;
    } else {
      const q = context?.question?.trim() || '实际选购与使用时应重点关注哪些指标？';
      const kw = context?.mainKeyword?.trim() || '当前方案';
      const brandNote = context?.brand?.trim()
        ? `可优先对照「${context.brand.trim()}」在文中所列核心材质、工艺参数与真实使用场景体验，结合预算与日常使用频率做取舍。`
        : `建议优先核对「${kw}」的核心参数、实际适配场景与长期维护成本，避免只看单一指标做决定。`;
      md = `${md}\n\n## 常见问题（FAQ）\n**问：${q}**\n答：${brandNote}`;
    }
  }

  const contentHtml = markdownToSanitizedHtml(md);
  const contentText = stripHtmlToText(contentHtml);
  return {
    cleanedMarkdown: md,
    contentHtml,
    contentText,
    charCount: Array.from(contentText.replace(/\s+/g, '')).length,
  };
}

// ==================== Zod Schemas & DTOs ====================

export const geoOutlineHeadingSchema = z.object({
  heading: z.string().trim().min(1, '请填写小节标题').max(160),
  intent: z.string().trim().max(300).default(''),
  fanOutRef: z.string().trim().max(200).optional(),
});

export type GeoOutlineHeading = z.infer<typeof geoOutlineHeadingSchema>;

export const geoArticleStreamSchema = z
  .object({
    market: z.enum(GEO_MARKETS),
    briefId: z.string().trim().min(1).max(64).optional(),
    recipe: z.enum(GEO_RECIPES),
    targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
    targetPrompt: z.string().trim().min(2, '目标问题至少 2 字').max(300),
    title: z.string().trim().min(1).max(120).optional(),
    outlineH2: z.array(geoOutlineHeadingSchema).max(15).optional(),
    targetFanOuts: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    sourceCitationUrl: z.string().trim().url().max(2048).optional(),
    pastedReferenceText: z.string().trim().max(50_000).optional(),
    wordCountTarget: z.number().int().min(600).max(4000).optional(),
    customToneNote: z.string().trim().max(500).optional(),
  })
  .refine(
    (val) => !val.targetFormat || targetFormatsForMarket(val.market).includes(val.targetFormat),
    {
      message: '目标阵地形态与所选市场不匹配',
      path: ['targetFormat'],
    },
  );

export type GeoArticleStreamInput = z.input<typeof geoArticleStreamSchema>;

export const geoArticleUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    contentMarkdown: z.string().max(100_000).optional(),
    contentHtml: z.string().max(150_000).optional(),
    outlineJson: z.array(geoOutlineHeadingSchema).max(15).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    status: z.enum(GEO_ARTICLE_STATUSES).optional(),
    usedMediaIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  })
  .refine((val) => Object.keys(val).length > 0, '至少修改一项文章内容');

export type GeoArticleUpdateInput = z.infer<typeof geoArticleUpdateSchema>;

export const geoArticleListQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  status: z.enum(GEO_ARTICLE_STATUSES).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  briefId: z.string().trim().min(1).max(64).optional(),
  batchJobId: z.string().trim().min(1).max(64).optional(),
  keyword: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type GeoArticleListQuery = z.infer<typeof geoArticleListQuerySchema>;

export const geoBatchListQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type GeoBatchListQuery = z.infer<typeof geoBatchListQuerySchema>;

export const geoRewriteSectionSchema = z.object({
  selectedText: z.string().trim().min(1, '请先选中需要改写的段落').max(4000),
  action: z.enum(GEO_REWRITE_ACTIONS),
  instruction: z.string().trim().max(300).optional(),
  surroundingContext: z.string().trim().max(2000).optional(),
});

export type GeoRewriteSectionInput = z.infer<typeof geoRewriteSectionSchema>;

export const geoBatchCreateSchema = z
  .object({
    market: z.enum(GEO_MARKETS),
    briefIds: z
      .array(z.string().trim().min(1).max(64))
      .min(GEO_BATCH_MIN, `批量生成至少勾选 ${GEO_BATCH_MIN} 条意见卡`)
      .max(GEO_BATCH_MAX, `单次批量生成最多 ${GEO_BATCH_MAX} 篇`)
      .refine((ids) => new Set(ids).size === ids.length, '批量生成的意见卡不能重复'),
    recipe: z.enum(GEO_RECIPES).optional(),
    targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
  })
  .refine(
    (val) => !val.targetFormat || targetFormatsForMarket(val.market).includes(val.targetFormat),
    {
      message: '目标阵地形态与所选市场不匹配',
      path: ['targetFormat'],
    },
  );

export type GeoBatchCreateInput = z.infer<typeof geoBatchCreateSchema>;

export const promptPreferenceSchema = z.object({
  customToneNote: z.string().trim().max(1000).nullable().optional(),
  customForbiddenWords: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  recipeOverrides: z.record(z.string(), z.string().max(2000)).nullable().optional(),
});

export type PromptPreferenceInput = z.infer<typeof promptPreferenceSchema>;

export type GeoArticleRecord = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  briefId: string | null;
  batchJobId: string | null;
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  title: string;
  targetPrompt: string;
  outlineJson: GeoOutlineHeading[];
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: Record<string, unknown>;
  tags: string[];
  status: GeoArticleStatus;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  complianceFlags: GeoComplianceFlag[];
  createdAt: string;
  updatedAt: string;
};

export type GeoArticleListResponse = {
  items: GeoArticleRecord[];
  total: number;
};

export type GeoRewriteSectionResponse = {
  rewrittenText: string;
  action: GeoRewriteAction;
  complianceFlags: GeoComplianceFlag[];
  model: string;
  tokensIn: number;
  tokensOut: number;
};

export type GeoBatchJobRecord = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  briefIds: string[];
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: TaskStatusName;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type GeoBatchJobListResponse = {
  items: GeoBatchJobRecord[];
  total: number;
};

export type PromptPreferenceRecord = {
  customToneNote: string | null;
  customForbiddenWords: string[];
  recipeOverrides: Record<string, string> | null;
  updatedAt: string | null;
};

export type GeoStreamMetaEvent = {
  reservationId: string;
  unitPrice: number;
  billingMode: 'SHADOW' | 'STRICT';
  market: GeoMarket;
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  matchedFactIds: string[];
};

export type GeoStreamDeltaEvent = {
  text: string;
};

export type GeoStreamCompleteEvent = {
  article: GeoArticleRecord;
  geoScore: number;
  geoScoreDetail: Record<string, unknown>;
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
};

export type GeoStreamErrorEvent = {
  code: number;
  msg: string;
  refunded: boolean;
};
