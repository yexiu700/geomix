import { z } from 'zod';
import {
  CRUD_ORDERS,
  CRUD_PAGE_SIZES,
  CrudQueryError,
  type CrudExportFormat,
  type CrudOrder,
  type CrudPageSize,
} from './crud';
import {
  ARTICLE_STATUSES,
  ARTICLE_STATUS_LABEL,
  articleCountsAsRemaining,
  isArticleStatus,
  type ArticleStatusName,
} from './writing-categories';
import { markdownToSanitizedHtml, stripHtmlToText } from './writing-tasks';

export const ARTICLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ARTICLE_TITLE_MAX = 120;
export const ARTICLE_HTML_MAX = 200_000;
export const ARTICLE_ZIP_EXPORT_LIMIT = 200;

export const ARTICLE_EXPORT_FORMATS = ['md', 'html', 'docx'] as const;
export type ArticleArchiveFormat = (typeof ARTICLE_EXPORT_FORMATS)[number];

export const ARTICLE_SORTS = ['createdAt', 'sendCount', 'videoCount'] as const;
export type ArticleSortName = (typeof ARTICLE_SORTS)[number];

export const ARTICLE_SOURCES = ['AI_TASK', 'REWRITE_SINGLE', 'REWRITE_BATCH', 'MANUAL'] as const;
export type ArticleSourceName = (typeof ARTICLE_SOURCES)[number];

export const ARTICLE_SOURCE_LABELS: Record<ArticleSourceName, string> = {
  AI_TASK: 'AI写作',
  REWRITE_SINGLE: '单篇复刻',
  REWRITE_BATCH: '批量复刻',
  MANUAL: '手动添加',
};

const optionalIdField = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return null;
    return val;
  })
  .refine((val) => val === null || ARTICLE_ID_PATTERN.test(val), '编号格式不正确');

const optionalCoverField = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return null;
    return val;
  })
  .refine(
    (val) =>
      val === null ||
      (val.length <= 1024 &&
        (val.startsWith('/') || /^https?:\/\//i.test(val)) &&
        !/^javascript:/i.test(val)),
    '封面地址格式不正确',
  );

export const articleCreateSchema = z.object({
  title: z
    .string({ required_error: '请填写文章标题' })
    .trim()
    .min(1, '请填写文章标题')
    .max(ARTICLE_TITLE_MAX, `文章标题不超过 ${ARTICLE_TITLE_MAX} 字`),
  categoryId: z
    .string({ required_error: '请选择归属分类' })
    .trim()
    .regex(ARTICLE_ID_PATTERN, '请选择归属分类'),
  mediaCategoryId: optionalIdField,
  coverUrl: optionalCoverField,
  status: z.enum(ARTICLE_STATUSES).default('NORMAL'),
  contentHtml: z
    .string({ required_error: '请填写文章正文' })
    .trim()
    .min(1, '请填写文章正文')
    .max(ARTICLE_HTML_MAX, '文章内容过长'),
});

export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;

export const articleUpdateSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, '请填写文章标题')
      .max(ARTICLE_TITLE_MAX, `文章标题不超过 ${ARTICLE_TITLE_MAX} 字`)
      .optional(),
    categoryId: z.string().trim().regex(ARTICLE_ID_PATTERN, '请选择归属分类').optional(),
    coverUrl: optionalCoverField,
    status: z.enum(ARTICLE_STATUSES).optional(),
    contentHtml: z
      .string()
      .trim()
      .min(1, '请填写文章正文')
      .max(ARTICLE_HTML_MAX, '文章内容过长')
      .optional(),
  })
  .refine(
    (val) =>
      val.title !== undefined ||
      val.categoryId !== undefined ||
      val.coverUrl !== undefined ||
      val.status !== undefined ||
      val.contentHtml !== undefined,
    '未提供需要修改的字段',
  );

export type ArticleUpdateInput = z.infer<typeof articleUpdateSchema>;

export const articleBulkStatusSchema = z.object({
  ids: z
    .array(z.string().trim().regex(ARTICLE_ID_PATTERN, '文章编号不合法'))
    .min(1, '请至少选择一篇文章')
    .max(100, '单次最多操作 100 篇文章'),
  status: z.enum(ARTICLE_STATUSES).default('NORMAL'),
});

export type ArticleBulkStatusInput = z.infer<typeof articleBulkStatusSchema>;

export const articleBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().trim().regex(ARTICLE_ID_PATTERN, '文章编号不合法'))
    .min(1, '请至少选择一篇文章')
    .max(100, '单次最多删除 100 篇文章'),
});

export type ArticleBulkDeleteInput = z.infer<typeof articleBulkDeleteSchema>;

export const articleZipExportSchema = z.object({
  format: z.enum(ARTICLE_EXPORT_FORMATS),
  ids: z
    .array(z.string().trim().regex(ARTICLE_ID_PATTERN, '文章编号不合法'))
    .max(ARTICLE_ZIP_EXPORT_LIMIT, `单次最多导出 ${ARTICLE_ZIP_EXPORT_LIMIT} 篇文章`)
    .optional(),
  categoryId: optionalIdField,
  taskId: optionalIdField,
  status: z.enum(ARTICLE_STATUSES).optional(),
  keyword: z.string().trim().max(100).optional(),
});

export type ArticleZipExportInput = z.infer<typeof articleZipExportSchema>;

export type ArticleManageQuery = {
  page: number;
  pageSize: CrudPageSize;
  categoryId?: string;
  taskId?: string;
  keyword: string;
  status?: ArticleStatusName;
  sendCount?: number;
  videoCount?: number;
  createdFrom?: string;
  createdTo?: string;
  sort: ArticleSortName;
  order: CrudOrder;
  export?: CrudExportFormat;
};

export type ArticleManageItem = {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  aiTaskId: string | null;
  aiTaskName: string | null;
  title: string;
  coverUrl: string | null;
  status: ArticleStatusName;
  source: ArticleSourceName;
  sendCount: number;
  videoCount: number;
  wordCount: number;
  countsAsRemaining: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ArticleDetailRecord = ArticleManageItem & {
  contentHtml: string;
  contentText: string;
  sourceUrl: string | null;
};

export type ArticleManageListResponse = {
  page: number;
  pageSize: number;
  total: number;
  categorySummary: {
    id: string;
    name: string;
    total: number;
    remaining: number;
  } | null;
  items: ArticleManageItem[];
};

function firstVal(val: unknown): string | undefined {
  if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : undefined;
  return typeof val === 'string' ? val : undefined;
}

function parseOptionalNonNegInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(raw.trim())) {
    throw new CrudQueryError(`${label}参数不合法`);
  }
  return Number(raw.trim());
}

function parseOptionalDateIso(raw: string | undefined, label: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.+-Z]+)?$/.test(trimmed)) {
    throw new CrudQueryError(`${label}格式不正确`);
  }
  const dt = new Date(trimmed);
  if (Number.isNaN(dt.getTime())) {
    throw new CrudQueryError(`${label}格式不正确`);
  }
  return trimmed;
}

export function parseArticleManageQuery(raw: Record<string, unknown>): ArticleManageQuery {
  const pageStr = firstVal(raw.page);
  const page = pageStr === undefined || pageStr === '' ? 1 : Number(pageStr);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
    throw new CrudQueryError('page 参数不合法');
  }

  const sizeStr = firstVal(raw.pageSize);
  const pageSize = sizeStr === undefined || sizeStr === '' ? 10 : Number(sizeStr);
  if (!(CRUD_PAGE_SIZES as readonly number[]).includes(pageSize)) {
    throw new CrudQueryError('pageSize 仅支持 10 / 25 / 50');
  }

  const categoryId = firstVal(raw.categoryId)?.trim() || undefined;
  if (categoryId && !ARTICLE_ID_PATTERN.test(categoryId)) {
    throw new CrudQueryError('分类编号不正确');
  }

  const taskId = firstVal(raw.taskId)?.trim() || undefined;
  if (taskId && !ARTICLE_ID_PATTERN.test(taskId)) {
    throw new CrudQueryError('任务编号不正确');
  }

  const keyword = (firstVal(raw.keyword) ?? '').trim().slice(0, 100);
  const statusRaw = firstVal(raw.status)?.trim();
  if (statusRaw && !isArticleStatus(statusRaw)) {
    throw new CrudQueryError('文章状态参数不合法');
  }

  const sendCount = parseOptionalNonNegInt(firstVal(raw.sendCount), '发送次数');
  const videoCount = parseOptionalNonNegInt(firstVal(raw.videoCount), '转视频次数');
  const createdFrom = parseOptionalDateIso(firstVal(raw.createdFrom), '开始时间');
  const createdTo = parseOptionalDateIso(firstVal(raw.createdTo), '结束时间');

  const sortRaw = (firstVal(raw.sort) ?? 'createdAt').trim();
  if (!(ARTICLE_SORTS as readonly string[]).includes(sortRaw)) {
    throw new CrudQueryError('sort 参数不合法');
  }

  const orderRaw = (firstVal(raw.order) ?? 'desc').trim();
  if (!(CRUD_ORDERS as readonly string[]).includes(orderRaw)) {
    throw new CrudQueryError('order 参数不合法');
  }

  const exportRaw = firstVal(raw.export)?.trim();
  if (exportRaw && exportRaw !== 'csv' && exportRaw !== 'xlsx') {
    throw new CrudQueryError('export 仅支持 csv 或 xlsx');
  }

  return {
    page,
    pageSize: pageSize as CrudPageSize,
    categoryId,
    taskId,
    keyword,
    status: statusRaw as ArticleStatusName | undefined,
    sendCount,
    videoCount,
    createdFrom,
    createdTo,
    sort: sortRaw as ArticleSortName,
    order: orderRaw as CrudOrder,
    export: exportRaw as CrudExportFormat | undefined,
  };
}

/**
 * 富文本白名单清洗：保留排版标签（h2, h3, p, ul, ol, li, blockquote, strong, em, br, img），
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
  const hasHtmlTag = /<\s*(p|h[1-6]|ul|ol|li|blockquote|div|strong|em|br|img)\b/i.test(trimmed);
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

  // Strip unknown tags while keeping allowed formatting tags
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

export function articleManageExportTable(rows: ArticleManageItem[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['分类名', '标题', '来源', '发送次数', '转视频次数', '状态', '计入剩余量', '创建时间'],
    rows: rows.map((row) => [
      row.categoryName ?? '未分类',
      row.title,
      ARTICLE_SOURCE_LABELS[row.source] ?? row.source,
      String(row.sendCount),
      String(row.videoCount),
      ARTICLE_STATUS_LABEL[row.status] ?? row.status,
      articleCountsAsRemaining(row.status, row.sendCount) ? '是' : '否',
      row.createdAt,
    ]),
  };
}

// ==================== Markdown / HTML / Docx 压缩包构建 ====================

export type ExportableArticleDoc = {
  id: string;
  title: string;
  categoryName?: string | null;
  coverUrl?: string | null;
  contentHtml: string;
  contentText: string;
  createdAt?: string;
};

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
    img { max-width: 100%; height: auto; border-radius: 6px; }
    .meta { color: #646a73; font-size: 13px; margin-bottom: 24px; }
  </style>
</head>
<body>
  <article>
    <h1>${safeTitle}</h1>
    <div class="meta">${doc.categoryName ? `分类：${escapeHtmlAttr(doc.categoryName)}` : 'GeoMix 导出文档'}</div>
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

// ==================== 标准 ZIP 打包与解析（UTF-8 文件名标记 0x0800） ====================

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
    view.setUint16(8, 0, true); // store (uncompressed)
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
  // Locate End of Central Directory (0x06054b50)
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
