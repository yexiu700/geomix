import { inflateRawSync, inflateSync } from 'node:zlib';

export type PdfExtractErrorReason = 'invalid_header' | 'encrypted' | 'empty_text' | 'corrupt';

export class PdfExtractError extends Error {
  constructor(
    public readonly reason: PdfExtractErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'PdfExtractError';
  }
}

const MAX_INFLATE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 20 * 1024 * 1024;
const MAX_CANDIDATE_STREAMS = 256;
const MAX_SCANNED_STREAMS = 2048;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_RAW_TEXT_CHARS = MAX_OUTPUT_CHARS * 2;
const MAX_TOTAL_CMAP_OPS = 65_536;
const MAX_CMAP_HEX_LEN = 8;
const MAX_CMAP_DST_HEX_LEN = 64;
const MAX_TOTAL_PDF_TOKENS = 200_000;
const MAX_LITERAL_STRING_BYTES = 131_072;
const MAX_HEX_STRING_CHARS = MAX_LITERAL_STRING_BYTES * 2;
const SKIP_STREAM_DICT_RE =
  /\/Subtype\s*\/(?:Image|Type1C|OpenType|CIDFontType0C)\b|\/Type\s*\/XRef\b|\/Length1\b/;
const LITERAL_DELIM_RE = /[()\\]/g;

interface CMapBudget {
  ops: number;
}

interface PdfExtractBudget {
  tokens: number;
  rawChars: number;
}

/**
 * 零依赖纯 Node PDF 文本提取器（仅使用 node:zlib），支持未压缩与 FlateDecode 内容流、
 * 字面量字符串、十六进制 UTF-16BE 字符串、TJ 字距数组与 /ToUnicode CMap 解码。
 */
export function extractTextFromPdf(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new PdfExtractError('invalid_header', 'PDF 文件格式无效');
  }

  let startOffset = 0;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    startOffset = 3;
  }
  while (
    startOffset < Math.min(buffer.length, 64) &&
    (buffer[startOffset] === 0x20 ||
      buffer[startOffset] === 0x09 ||
      buffer[startOffset] === 0x0a ||
      buffer[startOffset] === 0x0d)
  ) {
    startOffset += 1;
  }

  const head = buffer.subarray(startOffset, startOffset + 5).toString('ascii');
  if (head !== '%PDF-') {
    throw new PdfExtractError('invalid_header', '文件不是有效的 PDF 文档');
  }

  const rawLatin1 = buffer.toString('latin1');
  if (/\/Encrypt\b/.test(rawLatin1)) {
    throw new PdfExtractError('encrypted', '暂不支持解析加密或受密码保护的 PDF 文档');
  }

  const streams = collectCandidateStreams(buffer, rawLatin1);
  const cmap = new Map<string, string>();
  const textParts: string[] = [];

  const cmapBudget: CMapBudget = { ops: 0 };
  for (const content of streams) {
    if (cmapBudget.ops >= MAX_TOTAL_CMAP_OPS) break;
    if (content.includes('beginbfchar') || content.includes('beginbfrange')) {
      parseCMap(content, cmap, cmapBudget);
    }
  }

  const extractBudget: PdfExtractBudget = { tokens: 0, rawChars: 0 };
  for (const content of streams) {
    if (
      extractBudget.tokens >= MAX_TOTAL_PDF_TOKENS ||
      extractBudget.rawChars >= MAX_RAW_TEXT_CHARS
    ) {
      break;
    }
    if (content.includes('BT') && content.includes('ET')) {
      const extracted = extractTextFromContentStream(content, cmap, extractBudget);
      if (extracted) {
        textParts.push(extracted);
      }
    }
  }

  // Fallback for minimalist uncompressed PDFs with direct BT...ET outside stream objects
  if (
    textParts.length === 0 &&
    extractBudget.tokens < MAX_TOTAL_PDF_TOKENS &&
    extractBudget.rawChars < MAX_RAW_TEXT_CHARS &&
    rawLatin1.includes('BT') &&
    rawLatin1.includes('ET')
  ) {
    const direct = extractTextFromContentStream(rawLatin1, cmap, extractBudget);
    if (direct) {
      textParts.push(direct);
    }
  }

  const rawJoined = textParts.join('\n').slice(0, MAX_RAW_TEXT_CHARS);
  const cleaned = normalizeExtractedText(rawJoined).slice(0, MAX_OUTPUT_CHARS);
  const nonWsCount = cleaned.replace(/\s+/g, '').length;
  if (nonWsCount < 10) {
    throw new PdfExtractError(
      'empty_text',
      'PDF 中未提取到足够的文本内容（如为纯图片扫描件，请改为粘贴文字或上传 TXT/MD）',
    );
  }

  return cleaned;
}

const MAX_STREAM_DICT_LOOKBACK = 65_536;
const MAX_BFRANGE_ENTRIES = 2048;

function findStreamDictionary(rawLatin1: string, streamIdx: number, prevCursor = 0): string {
  const minPos = Math.max(prevCursor, streamIdx - MAX_STREAM_DICT_LOOKBACK);
  let i = streamIdx - 1;
  while (i >= minPos && /[\s\0]/.test(rawLatin1[i]!)) {
    i -= 1;
  }

  let lineStart = minPos;
  for (let p = i; p >= minPos; p -= 1) {
    const ch = rawLatin1.charCodeAt(p);
    if (ch === 10 || ch === 13) {
      lineStart = p + 1;
      break;
    }
  }
  const linePrefix = rawLatin1.slice(lineStart, i + 1);

  let closeIdx = -1;
  if (
    !linePrefix.includes('%') &&
    i >= minPos + 1 &&
    rawLatin1[i] === '>' &&
    rawLatin1[i - 1] === '>'
  ) {
    closeIdx = i - 1;
  } else {
    const searchWindow = rawLatin1.slice(minPos, streamIdx);
    const maskedWindow = searchWindow.replace(/%[^\r\n]*/g, (m) => ' '.repeat(m.length));
    const relClose = maskedWindow.lastIndexOf('>>');
    if (relClose === -1) return '';
    const trailing = maskedWindow.slice(relClose + 2);
    if (/\b(?:endobj|endstream)\b/.test(trailing)) return '';
    closeIdx = minPos + relClose;
  }

  let depth = 1;
  let pos = closeIdx - 1;
  while (pos >= minPos + 1 && depth > 0) {
    const prev = rawLatin1[pos - 1];
    const curr = rawLatin1[pos];
    if (prev === '>' && curr === '>') {
      depth += 1;
      pos -= 2;
      continue;
    }
    if (prev === '<' && curr === '<') {
      depth -= 1;
      if (depth === 0) {
        return rawLatin1.slice(pos - 1, closeIdx + 2);
      }
      pos -= 2;
      continue;
    }
    pos -= 1;
  }

  return '';
}

function collectCandidateStreams(buffer: Buffer, rawLatin1: string): string[] {
  const results: string[] = [];
  let cursor = 0;
  let lastStreamEnd = 0;
  let totalInflatedBytes = 0;
  let candidateStreams = 0;
  let scannedStreams = 0;

  while (cursor < rawLatin1.length) {
    const streamIdx = rawLatin1.indexOf('stream', cursor);
    if (streamIdx === -1) break;

    if (streamIdx > 0 && /[A-Za-z0-9_]/.test(rawLatin1[streamIdx - 1]!)) {
      cursor = streamIdx + 6;
      continue;
    }

    const afterKeyword = streamIdx + 6;
    const nextChar = rawLatin1[afterKeyword];
    const nextNextChar = rawLatin1[afterKeyword + 1];
    let dataStart = -1;
    if (nextChar === '\r' && nextNextChar === '\n') {
      dataStart = afterKeyword + 2;
    } else if (nextChar === '\n' || nextChar === '\r') {
      dataStart = afterKeyword + 1;
    } else {
      cursor = afterKeyword;
      continue;
    }

    const endIdx = rawLatin1.indexOf('endstream', dataStart);
    if (endIdx === -1) break;

    scannedStreams += 1;
    if (scannedStreams > MAX_SCANNED_STREAMS) {
      throw new PdfExtractError('corrupt', 'PDF 内容流数量超过安全上限');
    }

    let dataEnd = endIdx;
    if (dataEnd > dataStart && rawLatin1[dataEnd - 1] === '\n') dataEnd -= 1;
    if (dataEnd > dataStart && rawLatin1[dataEnd - 1] === '\r') dataEnd -= 1;

    const prevStreamEnd = lastStreamEnd;
    cursor = endIdx + 9;
    lastStreamEnd = cursor;

    if (dataEnd <= dataStart) {
      continue;
    }

    const dictText = findStreamDictionary(rawLatin1, streamIdx, prevStreamEnd);

    if (SKIP_STREAM_DICT_RE.test(dictText)) {
      continue;
    }

    const slice = buffer.subarray(dataStart, dataEnd);
    if (slice.length === 0) continue;

    candidateStreams += 1;
    if (candidateStreams > MAX_CANDIDATE_STREAMS) {
      throw new PdfExtractError('corrupt', 'PDF 解压后体积超过安全上限');
    }

    const remainingBudget = MAX_TOTAL_INFLATED_BYTES - totalInflatedBytes;
    if (remainingBudget <= 0) {
      throw new PdfExtractError('corrupt', 'PDF 解压后体积超过安全上限');
    }

    if (/\/FlateDecode\b/.test(dictText)) {
      const maxOutputLength = Math.min(MAX_INFLATE_BYTES, remainingBudget);
      const inflated = tryInflate(slice, maxOutputLength);
      if (inflated === 'too_large') {
        throw new PdfExtractError('corrupt', 'PDF 解压后体积超过安全上限');
      }
      if (inflated) {
        totalInflatedBytes += inflated.length;
        if (totalInflatedBytes > MAX_TOTAL_INFLATED_BYTES) {
          throw new PdfExtractError('corrupt', 'PDF 解压后体积超过安全上限');
        }
        results.push(inflated.toString('latin1'));
      }
    } else {
      if (slice.length > remainingBudget) {
        throw new PdfExtractError('corrupt', 'PDF 解压后体积超过安全上限');
      }
      totalInflatedBytes += slice.length;
      results.push(slice.toString('latin1'));
    }
  }

  return results;
}

function isBufferTooLargeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
  );
}

function tryInflate(slice: Buffer, maxOutputLength: number): Buffer | 'too_large' | null {
  try {
    return inflateSync(slice, { maxOutputLength });
  } catch (err) {
    if (isBufferTooLargeError(err)) return 'too_large';
    try {
      return inflateRawSync(slice, { maxOutputLength });
    } catch (rawErr) {
      if (isBufferTooLargeError(rawErr)) return 'too_large';
      return null;
    }
  }
}

function parseCMap(content: string, cmap: Map<string, string>, budget: CMapBudget): void {
  const BFCHAR_START = 'beginbfchar';
  const BFCHAR_END = 'endbfchar';
  let cursor = 0;
  while (cursor < content.length && budget.ops < MAX_TOTAL_CMAP_OPS) {
    const start = content.indexOf(BFCHAR_START, cursor);
    if (start === -1) break;
    const bodyStart = start + BFCHAR_START.length;
    const end = content.indexOf(BFCHAR_END, bodyStart);
    if (end === -1) break;
    const body = content.slice(bodyStart, end);
    cursor = end + BFCHAR_END.length;

    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pair: RegExpExecArray | null = pairRe.exec(body);
    while (pair !== null && budget.ops < MAX_TOTAL_CMAP_OPS) {
      budget.ops += 1;
      const rawSrc = pair[1] ?? '';
      const rawDst = pair[2] ?? '';
      if (
        rawSrc.length > 0 &&
        rawSrc.length <= MAX_CMAP_HEX_LEN &&
        rawDst.length > 0 &&
        rawDst.length <= MAX_CMAP_DST_HEX_LEN
      ) {
        const src = rawSrc.toUpperCase();
        const dst = decodeHexToUnicode(rawDst);
        if (src && dst) cmap.set(src, dst);
      }
      pair = pairRe.exec(body);
    }
  }

  const BFRANGE_START = 'beginbfrange';
  const BFRANGE_END = 'endbfrange';
  cursor = 0;
  while (cursor < content.length && budget.ops < MAX_TOTAL_CMAP_OPS) {
    const start = content.indexOf(BFRANGE_START, cursor);
    if (start === -1) break;
    const bodyStart = start + BFRANGE_START.length;
    const end = content.indexOf(BFRANGE_END, bodyStart);
    if (end === -1) break;
    const body = content.slice(bodyStart, end);
    cursor = end + BFRANGE_END.length;

    parseBfRangeBody(body, cmap, budget);
  }
}

function parseBfRangeBody(body: string, cmap: Map<string, string>, budget: CMapBudget): void {
  let i = 0;
  const len = body.length;

  const skipWs = () => {
    while (i < len) {
      const c = body.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0) {
        i += 1;
      } else {
        break;
      }
    }
  };

  const readHexToken = (): string | null => {
    skipWs();
    if (i >= len || body.charCodeAt(i) !== 60 /* '<' */) return null;
    const close = body.indexOf('>', i + 1);
    if (close === -1) {
      i = len;
      return null;
    }
    const innerLen = close - (i + 1);
    if (innerLen === 0 || innerLen > MAX_CMAP_HEX_LEN) {
      i = close + 1;
      return null;
    }
    const inner = body.slice(i + 1, close);
    i = close + 1;
    return /^[0-9a-fA-F]+$/.test(inner) ? inner : null;
  };

  while (i < len && budget.ops < MAX_TOTAL_CMAP_OPS) {
    const openIdx = body.indexOf('<', i);
    if (openIdx === -1) break;
    i = openIdx;
    budget.ops += 1;

    const startHex = readHexToken();
    if (!startHex) continue;

    const endHex = readHexToken();
    if (!endHex) continue;

    skipWs();
    if (i >= len) break;

    let dstScalarHex: string | undefined;
    let dstArrayBody: string | undefined;
    const nextCode = body.charCodeAt(i);
    if (nextCode === 60 /* '<' */) {
      const hex = readHexToken();
      if (hex === null) continue;
      dstScalarHex = hex;
    } else if (nextCode === 91 /* '[' */) {
      const arrEnd = body.indexOf(']', i + 1);
      if (arrEnd === -1) break;
      dstArrayBody = body.slice(i + 1, arrEnd);
      i = arrEnd + 1;
    } else {
      continue;
    }

    if (startHex.length > MAX_CMAP_HEX_LEN || endHex.length > MAX_CMAP_HEX_LEN) {
      continue;
    }

    const startCode = Number.parseInt(startHex, 16);
    const endCode = Number.parseInt(endHex, 16);
    if (
      !Number.isFinite(startCode) ||
      !Number.isFinite(endCode) ||
      endCode < startCode ||
      endCode - startCode > MAX_BFRANGE_ENTRIES
    ) {
      continue;
    }

    const width = startHex.length;
    if (dstScalarHex !== undefined) {
      if (dstScalarHex.length > MAX_CMAP_HEX_LEN) continue;
      const dstStart = Number.parseInt(dstScalarHex, 16);
      if (Number.isFinite(dstStart)) {
        for (let offset = 0; offset <= endCode - startCode; offset += 1) {
          if (budget.ops >= MAX_TOTAL_CMAP_OPS) break;
          budget.ops += 1;
          const srcKey = (startCode + offset).toString(16).toUpperCase().padStart(width, '0');
          const codePoint = dstStart + offset;
          if (codePoint > 0 && codePoint <= 0x10ffff) {
            cmap.set(srcKey, String.fromCodePoint(codePoint));
          }
        }
      }
    } else if (dstArrayBody !== undefined) {
      const hexItemRe = /<([0-9a-fA-F]+)>/g;
      const maxCount = Math.min(endCode - startCode + 1, MAX_BFRANGE_ENTRIES + 1);
      let offset = 0;
      let itemMatch: RegExpExecArray | null = hexItemRe.exec(dstArrayBody);
      while (itemMatch !== null && offset < maxCount && budget.ops < MAX_TOTAL_CMAP_OPS) {
        budget.ops += 1;
        const itemHex = itemMatch[1] ?? '';
        if (itemHex.length <= MAX_CMAP_DST_HEX_LEN) {
          const srcKey = (startCode + offset).toString(16).toUpperCase().padStart(width, '0');
          const dst = decodeHexToUnicode(itemHex);
          if (srcKey && dst) {
            cmap.set(srcKey, dst);
          }
        }
        offset += 1;
        itemMatch = hexItemRe.exec(dstArrayBody);
      }
    }
  }
}

function decodeHexToUnicode(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return '';
  if (clean.length === 2) {
    return String.fromCharCode(Number.parseInt(clean, 16));
  }
  let out = '';
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const codeUnit = Number.parseInt(clean.slice(i, i + 4), 16);
    if (Number.isFinite(codeUnit) && codeUnit > 0) {
      out += String.fromCharCode(codeUnit);
    }
  }
  return out;
}

type PdfToken =
  | { kind: 'string'; value: string }
  | {
      kind: 'array';
      items: Array<{ kind: 'string'; value: string } | { kind: 'number'; value: number }>;
    }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string };

function isPdfWsCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0;
}

function isPdfDelimiterOrWsCode(c: number): boolean {
  return (
    c === 32 ||
    c === 9 ||
    c === 10 ||
    c === 13 ||
    c === 12 ||
    c === 0 ||
    c === 40 /* '(' */ ||
    c === 41 /* ')' */ ||
    c === 60 /* '<' */ ||
    c === 62 /* '>' */ ||
    c === 91 /* '[' */ ||
    c === 93 /* ']' */ ||
    c === 123 /* '{' */ ||
    c === 125 /* '}' */ ||
    c === 47 /* '/' */ ||
    c === 37 /* '%' */
  );
}

function skipLiteralRemainder(input: string, startIndex: number, initialDepth: number): number {
  const len = input.length;
  let i = startIndex;
  let depth = initialDepth;
  while (i < len && depth > 0) {
    const c0 = input.charCodeAt(i);
    if (c0 === 92 /* '\\' */) {
      i = Math.min(i + 2, len);
      continue;
    }
    if (c0 === 40 /* '(' */) {
      depth += 1;
      i += 1;
      continue;
    }
    if (c0 === 41 /* ')' */) {
      depth -= 1;
      i += 1;
      continue;
    }
    LITERAL_DELIM_RE.lastIndex = i;
    const match = LITERAL_DELIM_RE.exec(input);
    if (!match) {
      return len;
    }
    const code = input.charCodeAt(match.index);
    if (code === 92 /* '\\' */) {
      i = Math.min(match.index + 2, len);
    } else if (code === 40 /* '(' */) {
      depth += 1;
      i = match.index + 1;
    } else {
      depth -= 1;
      i = match.index + 1;
    }
  }
  return i;
}

function skipPdfLiteralString(input: string, startIndex: number): number {
  return skipLiteralRemainder(input, startIndex + 1, 1);
}

function extractBtBlocks(stream: string, maxBlocks: number): string[] {
  const blocks: string[] = [];
  if (maxBlocks <= 0) return blocks;
  const len = stream.length;
  let i = 0;
  let inBlock = false;
  let blockStart = -1;
  let scannedTokens = 0;

  const pushBlockIfNonWs = (endIndex: number): boolean => {
    for (let p = blockStart; p < endIndex; p += 1) {
      if (!isPdfWsCode(stream.charCodeAt(p))) {
        blocks.push(stream.slice(blockStart, endIndex));
        return true;
      }
    }
    return false;
  };

  while (i < len) {
    const c = stream.charCodeAt(i);
    if (isPdfWsCode(c)) {
      i += 1;
      continue;
    }
    if (c === 37 /* '%' */) {
      while (i < len) {
        const cc = stream.charCodeAt(i);
        if (cc === 10 || cc === 13) break;
        i += 1;
      }
      continue;
    }
    if (c === 40 /* '(' */) {
      if (i + 1 < len && stream.charCodeAt(i + 1) === 41 /* ')' */) {
        i += 2;
      } else {
        i = skipPdfLiteralString(stream, i);
      }
      if (inBlock) {
        scannedTokens += 1;
        if (scannedTokens >= maxBlocks) {
          pushBlockIfNonWs(i);
          break;
        }
      }
      continue;
    }
    if (c === 60 /* '<' */) {
      if (i + 1 < len && stream.charCodeAt(i + 1) === 60) {
        i += 2;
        continue;
      }
      const end = stream.indexOf('>', i + 1);
      if (end === -1) break;
      i = end + 1;
      if (inBlock) {
        scannedTokens += 1;
        if (scannedTokens >= maxBlocks) {
          pushBlockIfNonWs(i);
          break;
        }
      }
      continue;
    }
    if (c === 62 /* '>' */) {
      i += i + 1 < len && stream.charCodeAt(i + 1) === 62 ? 2 : 1;
      continue;
    }
    if (c === 47 /* '/' */) {
      i += 1;
      while (i < len && !isPdfDelimiterOrWsCode(stream.charCodeAt(i))) i += 1;
      if (inBlock) {
        scannedTokens += 1;
        if (scannedTokens >= maxBlocks) {
          pushBlockIfNonWs(i);
          break;
        }
      }
      continue;
    }
    if (c === 91 /* '[' */ || c === 39 /* "'" */ || c === 34 /* '"' */) {
      i += 1;
      if (inBlock) {
        scannedTokens += 1;
        if (scannedTokens >= maxBlocks) {
          pushBlockIfNonWs(i);
          break;
        }
      }
      continue;
    }
    if (c === 93 /* ']' */ || c === 123 /* '{' */ || c === 125 /* '}' */ || c === 41 /* ')' */) {
      i += 1;
      continue;
    }

    const tokenStart = i;
    while (i < len) {
      const tc = stream.charCodeAt(i);
      if (isPdfDelimiterOrWsCode(tc) || tc === 39 || tc === 34) break;
      i += 1;
    }
    if (i - tokenStart === 2) {
      const c0 = stream.charCodeAt(tokenStart);
      const c1 = stream.charCodeAt(tokenStart + 1);
      if (c0 === 66 /* 'B' */ && c1 === 84 /* 'T' */) {
        if (!inBlock) {
          inBlock = true;
          blockStart = i;
        }
        continue;
      }
      if (c0 === 69 /* 'E' */ && c1 === 84 /* 'T' */) {
        if (inBlock) {
          if (pushBlockIfNonWs(tokenStart) && blocks.length >= maxBlocks) {
            break;
          }
          inBlock = false;
          blockStart = -1;
        }
        continue;
      }
    }
    if (inBlock) {
      scannedTokens += 1;
      if (scannedTokens >= maxBlocks) {
        pushBlockIfNonWs(i);
        break;
      }
    }
  }

  return blocks;
}

function extractTextFromContentStream(
  stream: string,
  cmap: Map<string, string>,
  budget: PdfExtractBudget,
): string {
  const remainingTokens = MAX_TOTAL_PDF_TOKENS - budget.tokens;
  if (remainingTokens <= 0 || budget.rawChars >= MAX_RAW_TEXT_CHARS) {
    return '';
  }

  const blocks = extractBtBlocks(stream, remainingTokens);
  const lines: string[] = [];

  const pushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const remaining = MAX_RAW_TEXT_CHARS - budget.rawChars;
    if (remaining <= 0) return;
    const clipped = trimmed.length > remaining ? trimmed.slice(0, remaining) : trimmed;
    lines.push(clipped);
    budget.rawChars += clipped.length + 1;
  };

  for (const block of blocks) {
    if (budget.tokens >= MAX_TOTAL_PDF_TOKENS || budget.rawChars >= MAX_RAW_TEXT_CHARS) {
      break;
    }
    budget.tokens += 1;
    const tokens = tokenizePdfBlock(block, cmap, budget);
    const operands: PdfToken[] = [];
    let currentLine = '';

    for (const token of tokens) {
      if (budget.rawChars + currentLine.length >= MAX_RAW_TEXT_CHARS) {
        break;
      }
      if (token.kind !== 'op') {
        operands.push(token);
        continue;
      }

      const op = token.value;
      if (op === 'Tj') {
        const last = operands[operands.length - 1];
        if (last && last.kind === 'string') {
          currentLine += last.value;
        }
      } else if (op === 'TJ') {
        const last = operands[operands.length - 1];
        if (last && last.kind === 'array') {
          for (const item of last.items) {
            if (budget.rawChars + currentLine.length >= MAX_RAW_TEXT_CHARS) {
              break;
            }
            if (item.kind === 'string') {
              currentLine += item.value;
            } else if (item.value < -150) {
              currentLine += ' ';
            }
          }
        }
      } else if (op === "'" || op === '"') {
        pushLine(currentLine);
        currentLine = '';
        if (budget.rawChars >= MAX_RAW_TEXT_CHARS) {
          operands.length = 0;
          break;
        }
        const last = operands[operands.length - 1];
        if (last && last.kind === 'string') {
          currentLine += last.value;
        }
      } else if (op === 'T*' || op === 'Td' || op === 'TD' || op === 'Tm') {
        const shouldBreak =
          op === 'T*' ||
          (op === 'Tm' && operands.length >= 6) ||
          ((op === 'Td' || op === 'TD') &&
            operands.length >= 2 &&
            operands[operands.length - 1]?.kind === 'number' &&
            Math.abs((operands[operands.length - 1] as { kind: 'number'; value: number }).value) >
              1);
        if (shouldBreak && currentLine.trim()) {
          pushLine(currentLine);
          currentLine = '';
        }
      }

      operands.length = 0;
    }

    if (currentLine.trim()) {
      pushLine(currentLine);
    }
  }

  return lines.join('\n');
}

function readHexString(
  input: string,
  startIndex: number,
): { hex: string; nextIndex: number } | null {
  const end = input.indexOf('>', startIndex + 1);
  if (end === -1) return null;
  const maxEnd = Math.min(end, startIndex + 1 + MAX_HEX_STRING_CHARS);
  return { hex: input.slice(startIndex + 1, maxEnd), nextIndex: end + 1 };
}

const EMPTY_STRING_TOKEN: { kind: 'string'; value: string } = { kind: 'string', value: '' };
const OTHER_OP_TOKEN: { kind: 'op'; value: string } = { kind: 'op', value: '' };

function tokenizePdfBlock(
  block: string,
  cmap: Map<string, string>,
  budget: PdfExtractBudget,
): PdfToken[] {
  const tokens: PdfToken[] = [];
  const len = block.length;
  let i = 0;

  while (i < len && budget.tokens < MAX_TOTAL_PDF_TOKENS) {
    const code = block.charCodeAt(i);
    if (isPdfWsCode(code)) {
      i += 1;
      continue;
    }
    if (code === 37 /* '%' */) {
      while (i < len) {
        const cc = block.charCodeAt(i);
        if (cc === 10 || cc === 13) break;
        i += 1;
      }
      continue;
    }
    if (code === 40 /* '(' */) {
      if (i + 1 < len && block.charCodeAt(i + 1) === 41 /* ')' */) {
        tokens.push(EMPTY_STRING_TOKEN);
        budget.tokens += 1;
        i += 2;
        continue;
      }
      const parsed = readLiteralString(block, i);
      tokens.push({ kind: 'string', value: parsed.value });
      budget.tokens += 1 + Math.floor(parsed.value.length / 32);
      i = parsed.nextIndex;
      continue;
    }
    if (code === 60 /* '<' */) {
      if (i + 1 < len && block.charCodeAt(i + 1) === 60) {
        budget.tokens += 1;
        i += 2;
        continue;
      }
      const hexToken = readHexString(block, i);
      if (!hexToken) break;
      tokens.push({ kind: 'string', value: decodePdfHexString(hexToken.hex, cmap) });
      budget.tokens += 1 + Math.floor(hexToken.hex.length / 32);
      i = hexToken.nextIndex;
      continue;
    }
    if (code === 62 /* '>' */ && i + 1 < len && block.charCodeAt(i + 1) === 62) {
      budget.tokens += 1;
      i += 2;
      continue;
    }
    if (code === 91 /* '[' */) {
      const items: Array<{ kind: 'string'; value: string } | { kind: 'number'; value: number }> =
        [];
      i += 1;
      budget.tokens += 1;
      while (
        i < len &&
        block.charCodeAt(i) !== 93 /* ']' */ &&
        budget.tokens < MAX_TOTAL_PDF_TOKENS
      ) {
        const curCode = block.charCodeAt(i);
        if (isPdfWsCode(curCode)) {
          i += 1;
          continue;
        }
        if (curCode === 37 /* '%' */) {
          while (i < len) {
            const cc = block.charCodeAt(i);
            if (cc === 10 || cc === 13) break;
            i += 1;
          }
          continue;
        }
        if (curCode === 40 /* '(' */) {
          if (i + 1 < len && block.charCodeAt(i + 1) === 41 /* ')' */) {
            items.push(EMPTY_STRING_TOKEN);
            budget.tokens += 1;
            i += 2;
            continue;
          }
          const parsed = readLiteralString(block, i);
          items.push({ kind: 'string', value: parsed.value });
          budget.tokens += 1 + Math.floor(parsed.value.length / 32);
          i = parsed.nextIndex;
          continue;
        }
        if (curCode === 60 /* '<' */ && (i + 1 >= len || block.charCodeAt(i + 1) !== 60)) {
          const hexToken = readHexString(block, i);
          if (!hexToken) break;
          items.push({ kind: 'string', value: decodePdfHexString(hexToken.hex, cmap) });
          budget.tokens += 1 + Math.floor(hexToken.hex.length / 32);
          i = hexToken.nextIndex;
          continue;
        }
        const numLen = scanPdfNumber(block, i);
        if (numLen > 0) {
          items.push({ kind: 'number', value: Number(block.slice(i, i + numLen)) });
          budget.tokens += 1;
          i += numLen;
          continue;
        }
        budget.tokens += 1;
        i += 1;
      }
      if (i < len && block.charCodeAt(i) === 93 /* ']' */) i += 1;
      tokens.push({ kind: 'array', items });
      continue;
    }
    if (code === 39 /* "'" */ || code === 34 /* '"' */) {
      tokens.push({ kind: 'op', value: code === 39 ? "'" : '"' });
      budget.tokens += 1;
      i += 1;
      continue;
    }
    if (code === 47 /* '/' */) {
      budget.tokens += 1;
      i += 1;
      while (i < len && !isPdfDelimiterOrWsCode(block.charCodeAt(i))) i += 1;
      continue;
    }
    const tokenStart = i;
    while (i < len) {
      const tc = block.charCodeAt(i);
      if (isPdfDelimiterOrWsCode(tc) || tc === 39 || tc === 34) break;
      i += 1;
    }
    if (i === tokenStart) {
      budget.tokens += 1;
      i += 1;
      continue;
    }
    const tokenLen = i - tokenStart;
    if (scanPdfNumber(block, tokenStart) === tokenLen) {
      tokens.push({ kind: 'number', value: Number(block.slice(tokenStart, i)) });
      budget.tokens += 1;
      continue;
    }
    let isOp = true;
    for (let p = tokenStart; p < i; p += 1) {
      const oc = block.charCodeAt(p);
      if (!((oc >= 65 && oc <= 90) || (oc >= 97 && oc <= 122) || oc === 42 /* '*' */)) {
        isOp = false;
        break;
      }
    }
    if (isOp) {
      if (tokenLen === 2 && block.charCodeAt(tokenStart) === 84 /* 'T' */) {
        const rawOp = block.slice(tokenStart, i);
        if (
          rawOp === 'Tj' ||
          rawOp === 'TJ' ||
          rawOp === 'T*' ||
          rawOp === 'Td' ||
          rawOp === 'TD' ||
          rawOp === 'Tm'
        ) {
          tokens.push({ kind: 'op', value: rawOp });
        } else if (tokens.length === 0 || tokens[tokens.length - 1] !== OTHER_OP_TOKEN) {
          tokens.push(OTHER_OP_TOKEN);
        }
      } else if (tokens.length === 0 || tokens[tokens.length - 1] !== OTHER_OP_TOKEN) {
        tokens.push(OTHER_OP_TOKEN);
      }
    }
    budget.tokens += 1;
  }

  return tokens;
}

function scanPdfNumber(input: string, start: number): number {
  let i = start;
  const len = input.length;
  if (i < len && (input[i] === '+' || input[i] === '-')) {
    i += 1;
  }
  let hasDigits = false;
  while (i < len && input.charCodeAt(i) >= 48 && input.charCodeAt(i) <= 57) {
    hasDigits = true;
    i += 1;
  }
  if (i < len && input[i] === '.') {
    i += 1;
    while (i < len && input.charCodeAt(i) >= 48 && input.charCodeAt(i) <= 57) {
      hasDigits = true;
      i += 1;
    }
  }
  return hasDigits ? i - start : 0;
}

function trimIncompleteTrailingUtf8(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let end = buf.length;
  let contBytes = 0;
  while (end > 0 && contBytes < 3 && (buf[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
    contBytes += 1;
  }
  if (end === 0) return buf;
  const lead = buf[end - 1]!;
  let expectedLen = 1;
  if ((lead & 0xe0) === 0xc0) expectedLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
  if (expectedLen > 1 && contBytes + 1 < expectedLen) {
    return buf.subarray(0, end - 1);
  }
  return buf;
}

function readLiteralString(
  input: string,
  startIndex: number,
): { value: string; nextIndex: number } {
  const len = input.length;
  let i = startIndex + 1;
  if (i < len && input.charCodeAt(i) === 41 /* ')' */) {
    return { value: '', nextIndex: i + 1 };
  }
  let depth = 1;
  const bytes: number[] = [];
  let truncated = false;
  let hasNonAscii = false;

  while (i < len && depth > 0) {
    if (bytes.length >= MAX_LITERAL_STRING_BYTES) {
      truncated = true;
      i = skipLiteralRemainder(input, i, depth);
      break;
    }

    const code = input.charCodeAt(i);
    if (code === 92 /* '\\' */) {
      if (i + 1 >= len) {
        i += 1;
        break;
      }
      const nextCode = input.charCodeAt(i + 1);
      if (nextCode === 13 && i + 2 < len && input.charCodeAt(i + 2) === 10) {
        i += 3;
        continue;
      }
      if (nextCode === 10 || nextCode === 13) {
        i += 2;
        continue;
      }
      if (nextCode === 110 /* 'n' */) {
        bytes.push(0x0a);
        i += 2;
        continue;
      }
      if (nextCode === 114 /* 'r' */) {
        bytes.push(0x0d);
        i += 2;
        continue;
      }
      if (nextCode === 116 /* 't' */) {
        bytes.push(0x09);
        i += 2;
        continue;
      }
      if (nextCode === 98 /* 'b' */) {
        bytes.push(0x08);
        i += 2;
        continue;
      }
      if (nextCode === 102 /* 'f' */) {
        bytes.push(0x0c);
        i += 2;
        continue;
      }
      if (nextCode >= 48 && nextCode <= 55) {
        let octVal = nextCode - 48;
        let octLen = 1;
        while (octLen < 3 && i + 1 + octLen < len) {
          const c = input.charCodeAt(i + 1 + octLen);
          if (c < 48 || c > 55) break;
          octVal = (octVal << 3) + (c - 48);
          octLen += 1;
        }
        const b = octVal & 0xff;
        if (b >= 0x80) hasNonAscii = true;
        bytes.push(b);
        i += 1 + octLen;
        continue;
      }
      const b = nextCode & 0xff;
      if (b >= 0x80) hasNonAscii = true;
      bytes.push(b);
      i += 2;
      continue;
    }
    if (code === 40 /* '(' */) {
      depth += 1;
      bytes.push(40);
      i += 1;
      continue;
    }
    if (code === 41 /* ')' */) {
      depth -= 1;
      if (depth > 0) bytes.push(41);
      i += 1;
      continue;
    }
    const b = code & 0xff;
    if (b >= 0x80) hasNonAscii = true;
    bytes.push(b);
    i += 1;
  }

  if (bytes.length === 0) {
    return { value: '', nextIndex: i };
  }
  if (!hasNonAscii && bytes.length <= 256) {
    return { value: String.fromCharCode(...bytes), nextIndex: i };
  }

  const rawBuf = Buffer.from(bytes);
  // Check UTF-16BE BOM
  if (rawBuf.length >= 2 && rawBuf[0] === 0xfe && rawBuf[1] === 0xff) {
    return { value: decodeUtf16Be(rawBuf.subarray(2)), nextIndex: i };
  }
  const utf8Buf = truncated ? trimIncompleteTrailingUtf8(rawBuf) : rawBuf;
  const utf8 = utf8Buf.toString('utf8');
  return { value: utf8.includes('\uFFFD') ? rawBuf.toString('latin1') : utf8, nextIndex: i };
}

function decodeUnmappedCodeUnit(code: number): string {
  if (!Number.isFinite(code) || code <= 0) return '';
  if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) return ' ';
  if (code >= 0x21 && code <= 0x7e) return String.fromCharCode(code);
  if (code >= 0xa0 && (code < 0xd800 || code > 0xdfff) && code < 0xfff0) {
    return String.fromCharCode(code);
  }
  return '';
}

function decodeHexWithCMap(
  paddedHex: string,
  unitHexLen: 2 | 4,
  cmap: Map<string, string>,
): { text: string; hits: number; total: number } {
  const total = paddedHex.length / unitHexLen;
  let text = '';
  let hits = 0;
  for (let i = 0; i < paddedHex.length; i += unitHexLen) {
    const key = paddedHex.slice(i, i + unitHexLen);
    const found = cmap.get(key);
    if (found !== undefined) {
      text += found;
      hits += 1;
    } else {
      text += decodeUnmappedCodeUnit(Number.parseInt(key, 16));
    }
  }
  return { text, hits, total };
}

function decodePdfHexString(rawHex: string, cmap: Map<string, string>): string {
  const clean = rawHex.replace(/\s+/g, '').toUpperCase();
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;

  if (padded.startsWith('FEFF')) {
    const buf = Buffer.from(padded.slice(4), 'hex');
    return decodeUtf16Be(buf);
  }

  if (cmap.size > 0) {
    const fourByte =
      padded.length % 4 === 0
        ? decodeHexWithCMap(padded, 4, cmap)
        : { text: '', hits: 0, total: 0 };
    const twoByte = decodeHexWithCMap(padded, 2, cmap);

    if (
      fourByte.hits > 0 &&
      (twoByte.hits === 0 || fourByte.hits / fourByte.total >= twoByte.hits / twoByte.total)
    ) {
      return fourByte.text;
    }
    if (twoByte.hits > 0) {
      return twoByte.text;
    }
  }

  const buf = Buffer.from(padded, 'hex');
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

function decodeUtf16Be(buf: Buffer): string {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const codeUnit = (buf[i]! << 8) | buf[i + 1]!;
    if (codeUnit > 0) out += String.fromCharCode(codeUnit);
  }
  return out;
}

function normalizeExtractedText(raw: string): string {
  let out = '';
  for (const ch of raw.replace(/\r\n/g, '\n')) {
    const code = ch.charCodeAt(0);
    if (ch === '\n' || ch === '\t' || (code >= 0x20 && code !== 0x7f)) {
      out += ch;
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
