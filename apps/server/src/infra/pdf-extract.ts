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
const MAX_OUTPUT_CHARS = 100_000;
const SKIP_STREAM_DICT_RE =
  /\/Subtype\s*\/(?:Image|Type1C|OpenType|CIDFontType0C)\b|\/Type\s*\/XRef\b|\/Length1\b/;

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

  for (const content of streams) {
    if (content.includes('beginbfchar') || content.includes('beginbfrange')) {
      parseCMap(content, cmap);
    }
  }

  for (const content of streams) {
    if (content.includes('BT') && content.includes('ET')) {
      const extracted = extractTextFromContentStream(content, cmap);
      if (extracted) {
        textParts.push(extracted);
      }
    }
  }

  // Fallback for minimalist uncompressed PDFs with direct BT...ET outside stream objects
  if (textParts.length === 0 && rawLatin1.includes('BT') && rawLatin1.includes('ET')) {
    const direct = extractTextFromContentStream(rawLatin1, cmap);
    if (direct) {
      textParts.push(direct);
    }
  }

  const cleaned = normalizeExtractedText(textParts.join('\n')).slice(0, MAX_OUTPUT_CHARS);
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

function findStreamDictionary(rawLatin1: string, streamIdx: number): string {
  const minPos = Math.max(0, streamIdx - MAX_STREAM_DICT_LOOKBACK);
  let i = streamIdx - 1;
  while (i >= minPos && /[\s\0]/.test(rawLatin1[i]!)) {
    i -= 1;
  }

  const lineStart = Math.max(
    minPos,
    rawLatin1.lastIndexOf('\n', i) + 1,
    rawLatin1.lastIndexOf('\r', i) + 1,
  );
  const linePrefix = rawLatin1.slice(lineStart, i + 1);

  let closeIdx = -1;
  if (!linePrefix.includes('%') && i >= 1 && rawLatin1[i] === '>' && rawLatin1[i - 1] === '>') {
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

    let dataEnd = endIdx;
    if (dataEnd > dataStart && rawLatin1[dataEnd - 1] === '\n') dataEnd -= 1;
    if (dataEnd > dataStart && rawLatin1[dataEnd - 1] === '\r') dataEnd -= 1;

    const dictText = findStreamDictionary(rawLatin1, streamIdx);

    cursor = endIdx + 9;

    if (SKIP_STREAM_DICT_RE.test(dictText)) {
      continue;
    }

    const slice = buffer.subarray(dataStart, dataEnd);
    if (slice.length === 0) continue;

    if (/\/FlateDecode\b/.test(dictText)) {
      const inflated = tryInflate(slice);
      if (inflated) {
        results.push(inflated.toString('latin1'));
      }
    } else {
      results.push(slice.toString('latin1'));
    }
  }

  return results;
}

function tryInflate(slice: Buffer): Buffer | null {
  try {
    return inflateSync(slice, { maxOutputLength: MAX_INFLATE_BYTES });
  } catch {
    try {
      return inflateRawSync(slice, { maxOutputLength: MAX_INFLATE_BYTES });
    } catch {
      return null;
    }
  }
}

function parseCMap(content: string, cmap: Map<string, string>): void {
  const bfCharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let match: RegExpExecArray | null = bfCharRe.exec(content);
  while (match !== null) {
    const body = match[1] ?? '';
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pair: RegExpExecArray | null = pairRe.exec(body);
    while (pair !== null) {
      const src = (pair[1] ?? '').toUpperCase();
      const dst = decodeHexToUnicode(pair[2] ?? '');
      if (src && dst) cmap.set(src, dst);
      pair = pairRe.exec(body);
    }
    match = bfCharRe.exec(content);
  }

  const bfRangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  match = bfRangeRe.exec(content);
  while (match !== null) {
    const body = match[1] ?? '';
    const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let entry: RegExpExecArray | null = entryRe.exec(body);
    while (entry !== null) {
      const startHex = entry[1] ?? '';
      const endHex = entry[2] ?? '';
      const dstScalarHex = entry[3];
      const dstArrayBody = entry[4];
      const startCode = Number.parseInt(startHex, 16);
      const endCode = Number.parseInt(endHex, 16);

      if (
        Number.isFinite(startCode) &&
        Number.isFinite(endCode) &&
        endCode >= startCode &&
        endCode - startCode <= MAX_BFRANGE_ENTRIES
      ) {
        const width = startHex.length;
        if (dstScalarHex !== undefined) {
          const dstStart = Number.parseInt(dstScalarHex, 16);
          if (Number.isFinite(dstStart)) {
            for (let offset = 0; offset <= endCode - startCode; offset += 1) {
              const srcKey = (startCode + offset).toString(16).toUpperCase().padStart(width, '0');
              const codePoint = dstStart + offset;
              if (codePoint > 0 && codePoint <= 0x10ffff) {
                cmap.set(srcKey, String.fromCodePoint(codePoint));
              }
            }
          }
        } else if (dstArrayBody !== undefined) {
          const dstItems: string[] = [];
          const hexItemRe = /<([0-9a-fA-F]+)>/g;
          let itemMatch: RegExpExecArray | null = hexItemRe.exec(dstArrayBody);
          const maxCount = Math.min(endCode - startCode + 1, MAX_BFRANGE_ENTRIES + 1);
          while (itemMatch !== null && dstItems.length < maxCount) {
            dstItems.push(itemMatch[1] ?? '');
            itemMatch = hexItemRe.exec(dstArrayBody);
          }
          for (let offset = 0; offset < dstItems.length; offset += 1) {
            const srcKey = (startCode + offset).toString(16).toUpperCase().padStart(width, '0');
            const dst = decodeHexToUnicode(dstItems[offset] ?? '');
            if (srcKey && dst) {
              cmap.set(srcKey, dst);
            }
          }
        }
      }
      entry = entryRe.exec(body);
    }
    match = bfRangeRe.exec(content);
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

function isPdfDelimiterOrWs(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\0' ||
    ch === '(' ||
    ch === ')' ||
    ch === '<' ||
    ch === '>' ||
    ch === '[' ||
    ch === ']' ||
    ch === '{' ||
    ch === '}' ||
    ch === '/' ||
    ch === '%'
  );
}

function skipPdfLiteralString(input: string, startIndex: number): number {
  let i = startIndex + 1;
  let depth = 1;
  while (i < input.length && depth > 0) {
    const ch = input[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function extractBtBlocks(stream: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  let inBlock = false;
  let blockStart = -1;

  while (i < stream.length) {
    const ch = stream[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\0') {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < stream.length && stream[i] !== '\n' && stream[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      i = skipPdfLiteralString(stream, i);
      continue;
    }
    if (ch === '<') {
      if (stream[i + 1] === '<') {
        i += 2;
        continue;
      }
      const end = stream.indexOf('>', i + 1);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '>') {
      i += stream[i + 1] === '>' ? 2 : 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < stream.length && !isPdfDelimiterOrWs(stream[i]!)) i += 1;
      continue;
    }
    if (
      ch === '[' ||
      ch === ']' ||
      ch === '{' ||
      ch === '}' ||
      ch === ')' ||
      ch === "'" ||
      ch === '"'
    ) {
      i += 1;
      continue;
    }

    const tokenStart = i;
    while (
      i < stream.length &&
      !isPdfDelimiterOrWs(stream[i]!) &&
      stream[i] !== "'" &&
      stream[i] !== '"'
    ) {
      i += 1;
    }
    const word = stream.slice(tokenStart, i);
    if (word === 'BT' && !inBlock) {
      inBlock = true;
      blockStart = i;
    } else if (word === 'ET' && inBlock) {
      blocks.push(stream.slice(blockStart, tokenStart));
      inBlock = false;
      blockStart = -1;
    }
  }

  return blocks;
}

function extractTextFromContentStream(stream: string, cmap: Map<string, string>): string {
  const blocks = extractBtBlocks(stream);
  const lines: string[] = [];

  for (const block of blocks) {
    const tokens = tokenizePdfBlock(block, cmap);
    const operands: PdfToken[] = [];
    let currentLine = '';

    for (const token of tokens) {
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
            if (item.kind === 'string') {
              currentLine += item.value;
            } else if (item.value < -150) {
              currentLine += ' ';
            }
          }
        }
      } else if (op === "'" || op === '"') {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
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
          lines.push(currentLine.trim());
          currentLine = '';
        }
      }

      operands.length = 0;
    }

    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }
  }

  return lines.join('\n');
}

function tokenizePdfBlock(block: string, cmap: Map<string, string>): PdfToken[] {
  const tokens: PdfToken[] = [];
  let i = 0;

  while (i < block.length) {
    const ch = block[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < block.length && block[i] !== '\n' && block[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      const parsed = readLiteralString(block, i);
      tokens.push({ kind: 'string', value: parsed.value });
      i = parsed.nextIndex;
      continue;
    }
    if (ch === '<') {
      if (block[i + 1] === '<') {
        i += 2;
        continue;
      }
      const end = block.indexOf('>', i + 1);
      if (end === -1) break;
      const hex = block.slice(i + 1, end);
      tokens.push({ kind: 'string', value: decodePdfHexString(hex, cmap) });
      i = end + 1;
      continue;
    }
    if (ch === '>' && block[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      const items: Array<{ kind: 'string'; value: string } | { kind: 'number'; value: number }> =
        [];
      i += 1;
      while (i < block.length && block[i] !== ']') {
        const cur = block[i]!;
        if (/\s/.test(cur)) {
          i += 1;
          continue;
        }
        if (cur === '(') {
          const parsed = readLiteralString(block, i);
          items.push({ kind: 'string', value: parsed.value });
          i = parsed.nextIndex;
          continue;
        }
        if (cur === '<' && block[i + 1] !== '<') {
          const end = block.indexOf('>', i + 1);
          if (end === -1) break;
          items.push({ kind: 'string', value: decodePdfHexString(block.slice(i + 1, end), cmap) });
          i = end + 1;
          continue;
        }
        const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(block.slice(i));
        if (numMatch) {
          items.push({ kind: 'number', value: Number(numMatch[0]) });
          i += numMatch[0].length;
          continue;
        }
        i += 1;
      }
      if (block[i] === ']') i += 1;
      tokens.push({ kind: 'array', items });
      continue;
    }
    if (ch === "'" || ch === '"') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < block.length && !/[\s()<>[\]{}/%]/.test(block[i]!)) i += 1;
      continue;
    }
    const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)(?=[\s()<>[\]{}/%]|$)/.exec(block.slice(i));
    if (numMatch) {
      tokens.push({ kind: 'number', value: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const opMatch = /^[A-Za-z*]+/.exec(block.slice(i));
    if (opMatch) {
      tokens.push({ kind: 'op', value: opMatch[0] });
      i += opMatch[0].length;
      continue;
    }
    i += 1;
  }

  return tokens;
}

function readLiteralString(
  input: string,
  startIndex: number,
): { value: string; nextIndex: number } {
  let i = startIndex + 1;
  let depth = 1;
  const bytes: number[] = [];

  while (i < input.length && depth > 0) {
    const ch = input[i]!;
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        i += 1;
        break;
      }
      if (next === '\r' && input[i + 2] === '\n') {
        i += 3;
        continue;
      }
      if (next === '\n' || next === '\r') {
        i += 2;
        continue;
      }
      if (next === 'n') {
        bytes.push(0x0a);
        i += 2;
        continue;
      }
      if (next === 'r') {
        bytes.push(0x0d);
        i += 2;
        continue;
      }
      if (next === 't') {
        bytes.push(0x09);
        i += 2;
        continue;
      }
      if (next === 'b') {
        bytes.push(0x08);
        i += 2;
        continue;
      }
      if (next === 'f') {
        bytes.push(0x0c);
        i += 2;
        continue;
      }
      if (/[0-7]/.test(next)) {
        const oct = input.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
        bytes.push(Number.parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
        continue;
      }
      bytes.push(next.charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      bytes.push(ch.charCodeAt(0));
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth > 0) bytes.push(ch.charCodeAt(0));
      i += 1;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i += 1;
  }

  const rawBuf = Buffer.from(bytes);
  // Check UTF-16BE BOM
  if (rawBuf.length >= 2 && rawBuf[0] === 0xfe && rawBuf[1] === 0xff) {
    return { value: decodeUtf16Be(rawBuf.subarray(2)), nextIndex: i };
  }
  const utf8 = rawBuf.toString('utf8');
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
