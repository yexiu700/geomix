import { z } from 'zod';
import type { GeoMarket } from './brands';
import type { GeoComplianceFlag } from './compliance';
import {
  extractMissingFactSlots,
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
        const rawSrc = (srcMatch?.[1] ?? srcMatch?.[2] ?? '').trim();
        if (!rawSrc || /[\u0000-\u001f\u007f\s"'<>]/.test(rawSrc) || /&#/i.test(rawSrc)) {
          return '';
        }
        const decodedSrc = decodeHtmlEntities(rawSrc).trim();
        if (
          !decodedSrc ||
          /[\u0000-\u001f\u007f\s"'<>]/.test(decodedSrc) ||
          !(
            /^https?:\/\//i.test(decodedSrc) ||
            (decodedSrc.startsWith('/') && !decodedSrc.startsWith('//'))
          )
        ) {
          return '';
        }
        const alt = escapeHtmlAttr((altMatch?.[1] ?? altMatch?.[2] ?? '').trim());
        return `<img src="${escapeHtmlAttr(decodedSrc)}" alt="${alt}" style="max-width:100%" />`;
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

// ==================== GEO 0–100 实时体检、JSON-LD 与 llms.txt 纯函数 ====================

export type EvaluateGeoArticleInput = {
  market: GeoMarket;
  locale?: string;
  localBrandName: string;
  category?: string;
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
const GFM_TABLE_PRESENT_RE = /^\|?.+\|.+\n\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/m;
const SPEC_METRIC_RE =
  /\b\d+(?:\.\d+)?\s*(?:W|dB|dBA|TB|GB|MB\/s|GB\/s|GbE|%|Wh|mAh|mm|cm|kg|ms|Hz|GHz|℃|°C|nm|lm)\b|\d+(?:\.\d+)?\s*(?:瓦|分贝|盘位|年|小时|元|万元|倍|千兆|万兆)|\b(?:ISO\s*\d+|UL\s*\d*|CE|FCC|RoHS|DDR[45]|NVMe|RAID\s*\d+|N\d{3,4})\b/gi;

function sanitizeJsonLdText(raw: string): string {
  return raw
    .replace(/<\s*\/\s*script/gi, '&lt;/script')
    .replace(/<[^>]+>/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstBodyParagraph(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
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

function extractFaqPairs(
  markdown: string,
  fallbackQuestion: string,
  fallbackAnswer: string,
): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  const normalized = markdown.replace(/\r\n/g, '\n');

  const qaRegex =
    /(?:\*\*|###\s*)?(?:Q|问)\s*[:：]\s*([^\n*]+)\*{0,2}\s*\n+(?:\*\*)?(?:A|答)\s*[:：]\s*\*{0,2}\s*([^\n]+(?:\n(?!\s*(?:\*\*|###|##|(?:Q|问)\s*[:：]))[^\n]+)*)/gi;
  let match: RegExpExecArray | null;
  while ((match = qaRegex.exec(normalized)) !== null) {
    const q = sanitizeJsonLdText(match[1] ?? '');
    const a = sanitizeJsonLdText(match[2] ?? '');
    if (q && a) {
      pairs.push({ question: q, answer: a });
    }
    if (pairs.length >= 6) break;
  }

  if (pairs.length === 0) {
    const q = sanitizeJsonLdText(fallbackQuestion) || 'Key Selection Question';
    const a = sanitizeJsonLdText(fallbackAnswer) || q;
    pairs.push({ question: q, answer: a });
  }
  return pairs;
}

export function buildGeoSchemaJsonLd(input: {
  market: GeoMarket;
  locale?: string;
  localBrandName: string;
  category?: string;
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

  if (input.market === 'GLOBAL' || input.category) {
    graph.push({
      '@type': 'Product',
      name: brandName,
      category: sanitizeJsonLdText(input.category || 'Consumer Hardware'),
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
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return ascii || 'geo-guide';
}

export function buildLlmsTxtSnippet(input: {
  market: GeoMarket;
  localBrandName: string;
  category?: string;
  ownedDomains?: readonly string[];
  title: string;
  targetPrompt: string;
  contentMarkdown: string;
}): string | null {
  if (input.market !== 'GLOBAL') return null;
  const brandName = input.localBrandName.trim() || 'Brand';
  const rawDomain = input.ownedDomains?.[0]?.trim() || '';
  const cleanDomain =
    rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') ||
    `${slugifyPathSegment(brandName)}.com`;
  const title = input.title.trim() || input.targetPrompt.trim() || `${brandName} Guide`;
  const summary =
    extractFirstBodyParagraph(input.contentMarkdown).slice(0, 160) ||
    `Verified product comparison and specifications for ${brandName}.`;
  const slug = slugifyPathSegment(title);

  return [
    `# ${brandName}`,
    '',
    `> Authoritative product specifications, independent benchmarks, and buying guides for ${brandName}${input.category ? ` (${input.category})` : ''}.`,
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
  const md = input.contentMarkdown.replace(/\r\n/g, '\n').trim();
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
  const hasTable = GFM_TABLE_PRESENT_RE.test(md);
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

  const hasFaq = /FAQ|常见问题|Frequently Asked Questions|\*\*Q[:：]|\*\*问[:：]/i.test(md);
  if (hasFaq) structuredScore += 3;
  else structuredHints.push('建议在文末补充 2–5 组 FAQ 问答块');

  // 3. Fact Density (max 25)
  const factHints: string[] = [];
  const specMatches = new Set(
    (md.match(SPEC_METRIC_RE) ?? []).map((s) => s.toLowerCase().replace(/\s+/g, '')),
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
  let brandFactPoints = 0;
  if (matchedFactsCount >= 2) {
    brandFactPoints = 10;
  } else if (matchedFactsCount === 1) {
    brandFactPoints = 8;
  } else if ((input.brandFactTexts ?? []).length > 0) {
    const anchors = (input.brandFactTexts ?? []).join(' ').match(SPEC_METRIC_RE) ?? [];
    const overlapped = new Set(
      anchors.map((a) => a.toLowerCase().replace(/\s+/g, '')).filter((a) => specMatches.has(a)),
    ).size;
    brandFactPoints = overlapped >= 2 ? 9 : overlapped === 1 ? 6 : 2;
  } else if (
    input.localBrandName &&
    mdLower.includes(input.localBrandName.toLowerCase()) &&
    specCount >= 2
  ) {
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
    deAiHints.push(`正文包含 ${missingSlots.length} 处 [待补充] 缺失事实槽位，补填后可立即提分`);
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
    const lingeringCnSuperlative = /全网第一|行业第一|国家级|世界级|最顶级|100\s*%|百分之百/.test(
      md,
    );
    if (cnAdFlags.length > 0 || lingeringCnSuperlative) {
      const penalty = Math.min(6, Math.max(cnAdFlags.length, lingeringCnSuperlative ? 1 : 0) * 3);
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
    schemaJsonLd: buildGeoSchemaJsonLd({
      market,
      locale: input.locale,
      localBrandName: input.localBrandName,
      category: input.category,
      title: input.title,
      targetPrompt: input.targetPrompt,
      contentMarkdown: md,
    }),
    llmsTxtSnippet: buildLlmsTxtSnippet({
      market,
      localBrandName: input.localBrandName,
      category: input.category,
      ownedDomains: input.ownedDomains,
      title: input.title,
      targetPrompt: input.targetPrompt,
      contentMarkdown: md,
    }),
    crawlerChecklist: buildCrawlerChecklist(market),
    recommendedChannels: buildRecommendedChannelsForMarket(market),
  };
}
