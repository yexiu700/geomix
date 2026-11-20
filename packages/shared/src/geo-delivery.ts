import { z } from 'zod';
import type { GeoMarket } from './brands';
import {
  markdownToSanitizedHtml,
  stripHtmlToText,
  type GeoArticleStatus,
  type GeoRecipe,
  type GeoTargetFormat,
} from './geo-studio';

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
  createdAt?: string;
};

// ==================== 富文本白名单清洗、字数统计与导出（从 articles.ts 抽取） ====================

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
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
    if (code < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') continue;
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
 * 富文本白名单清洗：保留排版标签（h2, h3, h4, p, ul, ol, li, blockquote, strong, em, br, img, table/thead/tbody/tr/th/td），
 * 剥离 script / iframe / style / on* 事件与危险协议。若传入纯文本/Markdown 则转为安全 HTML。
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
    /<\s*(p|h[1-6]|ul|ol|li|blockquote|div|strong|em|br|img|table|tr|td|th)\b/i.test(trimmed);
  if (!hasHtmlTag) {
    const html = markdownToSanitizedHtml(trimmed);
    return { contentHtml: html, contentText: stripHtmlToText(html) };
  }

  let cleaned = trimmed
    .replace(
      /<\s*(script|style|iframe|object|embed|form|input|button)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button)[^>]*\/?\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
    .replace(/<\s*h1(\b[^>]*)>/gi, '<h2$1>')
    .replace(/<\s*\/\s*h1\s*>/gi, '</h2>')
    .replace(/<\s*div(\b[^>]*)>/gi, '<p$1>')
    .replace(/<\s*\/\s*div\s*>/gi, '</p>');

  cleaned = cleaned.replace(
    /<\/?([a-z0-9-]+)(\b[^>]*)?>/gi,
    (full, rawTag: string, rawAttrs: string | undefined) => {
      const tag = rawTag.toLowerCase();
      const isClosing = full.startsWith('</');
      const allowed = new Set([
        'p',
        'h2',
        'h3',
        'h4',
        'ul',
        'ol',
        'li',
        'blockquote',
        'strong',
        'b',
        'em',
        'i',
        'u',
        'br',
        'img',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ]);
      if (!allowed.has(tag)) return '';
      if (tag === 'b') return isClosing ? '</strong>' : '<strong>';
      if (tag === 'i') return isClosing ? '</em>' : '<em>';
      if (isClosing) return `</${tag}>`;
      if (tag === 'br') return '<br />';
      if (tag === 'img') {
        const srcMatch = (rawAttrs ?? '').match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
        const altMatch = (rawAttrs ?? '').match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? '').trim();
        if (!src || /^javascript:/i.test(src)) return '';
        const alt = escapeHtmlAttr((altMatch?.[1] ?? altMatch?.[2] ?? '').trim());
        return `<img src="${escapeHtmlAttr(src)}" alt="${alt}" style="max-width:100%" />`;
      }
      return `<${tag}>`;
    },
  );

  const contentText = stripHtmlToText(cleaned);
  return { contentHtml: cleaned.trim(), contentText };
}

export function countArticleWords(htmlOrText: string): number {
  const plain = stripHtmlToText(htmlOrText).replace(/\s+/g, '');
  return Array.from(plain).length;
}

export function htmlToExportMarkdown(doc: ExportableArticleDoc): string {
  const lines: string[] = [`# ${doc.title.trim()}`];
  if (doc.coverUrl) {
    lines.push('', `![封面](${doc.coverUrl})`);
  }

  let md = doc.contentHtml
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(
      /<\s*img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\balt=["']([^"']*)["'][^>]*\/?\s*>/gi,
      '\n\n![$2]($1)\n\n',
    )
    .replace(/<\s*img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?\s*>/gi, '\n\n![]($1)\n\n')
    .replace(/<\s*h2[^>]*>([\s\S]*?)<\s*\/\s*h2\s*>/gi, '\n\n## $1\n\n')
    .replace(/<\s*h3[^>]*>([\s\S]*?)<\s*\/\s*h3\s*>/gi, '\n\n### $1\n\n')
    .replace(/<\s*h4[^>]*>([\s\S]*?)<\s*\/\s*h4\s*>/gi, '\n\n#### $1\n\n')
    .replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/\s*blockquote\s*>/gi, (_m, inner: string) => {
      const clean = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '').trim());
      return `\n\n> ${clean}\n\n`;
    })
    .replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_m, inner: string) => {
      const clean = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '').trim());
      return `\n- ${clean}`;
    })
    .replace(/<\s*(strong|b)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '**$2**')
    .replace(/<\s*(em|i)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '*$2*')
    .replace(/<\s*\/\s*(p|ul|ol)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  md = decodeHtmlEntities(md)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (md) {
    lines.push('', md);
  } else if (doc.contentText.trim()) {
    lines.push('', doc.contentText.trim());
  }
  return `${lines.join('\n')}\n`;
}

export function htmlToExportDocument(doc: ExportableArticleDoc): string {
  const safeTitle = escapeHtmlAttr(doc.title.trim());
  const coverBlock = doc.coverUrl
    ? `<figure class="cover"><img src="${escapeHtmlAttr(doc.coverUrl)}" alt="${safeTitle}" /></figure>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
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
    <div class="content">${doc.contentHtml}</div>
  </article>
</body>
</html>
`;
}

type DocxBlock = { kind: 'h1' | 'h2' | 'h3' | 'p' | 'li'; text: string };

function extractDocxBlocks(doc: ExportableArticleDoc): DocxBlock[] {
  const blocks: DocxBlock[] = [{ kind: 'h1', text: doc.title.trim() }];
  const blockRegex = /<\s*(h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(doc.contentHtml)) !== null) {
    const tag = match[1]!.toLowerCase();
    const textVal = decodeHtmlEntities(
      match[2]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (!textVal) continue;
    if (tag === 'h2') blocks.push({ kind: 'h2', text: textVal });
    else if (tag === 'h3') blocks.push({ kind: 'h3', text: textVal });
    else if (tag === 'li') blocks.push({ kind: 'li', text: `• ${textVal}` });
    else blocks.push({ kind: 'p', text: textVal });
  }
  if (blocks.length === 1 && doc.contentText.trim()) {
    for (const line of doc.contentText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) blocks.push({ kind: 'p', text: trimmed });
    }
  }
  return blocks;
}

export function buildSingleDocxBytes(doc: ExportableArticleDoc): Uint8Array {
  const blocks = extractDocxBlocks(doc);
  const paragraphsXml = blocks
    .map((b) => {
      const sizeHalfPt = b.kind === 'h1' ? 36 : b.kind === 'h2' ? 28 : b.kind === 'h3' ? 24 : 22;
      const boldXml = b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3' ? '<w:b/>' : '';
      return `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr>${boldXml}<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/></w:rPr><w:t xml:space="preserve">${escapeXml(b.text)}</w:t></w:r></w:p>`;
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
  <w:body>${paragraphsXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
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
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
  crawlerChecklist: Array<{ bot: string; purpose: string; recommended: boolean }>;
  recommendedChannels: Array<{ channel: string; reason: string }>;
};

export const publishRecordCreateSchema = z.object({
  publishedUrl: z.string().trim().url('请输入有效的已发布文章链接').max(2048),
  channel: z.string().trim().min(1, '请选择或填写发布渠道').max(60),
  publishedAt: z.string().datetime({ offset: true }).optional(),
});

export type PublishRecordCreateInput = z.infer<typeof publishRecordCreateSchema>;

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
};

export type ActionHomeResponse = {
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  health: {
    days: number;
    mentionRatePct: number;
    shareOfVoicePct: number;
    avgPosition: number | null;
    ownedCitationRatePct: number;
    completedChecks: number;
  };
  topBriefs: Array<{
    id: string;
    sourceType: string;
    priorityScore: number;
    diagnosisSummary: string;
    suggestedTitle: string;
    targetPrompt: string;
    recommendedRecipe: GeoRecipe;
    targetFormat: GeoTargetFormat;
    recommendedChannels: Array<{ channel: string; reason: string }>;
  }>;
  recentArticles: Array<{
    id: string;
    title: string;
    recipe: GeoRecipe;
    geoScore: number;
    status: GeoArticleStatus;
    updatedAt: string;
    publishRecord?: GeoPublishRecordDto | null;
  }>;
};
