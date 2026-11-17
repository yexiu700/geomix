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
  cleanQuestionDisplay,
  KEYWORD_ID_PATTERN,
  normalizeQuestionKey,
  type QuestionSourceName,
} from './keywords';

export const QUESTION_ID_PATTERN = /^[a-z0-9_-]{3,40}$/i;
export const QUESTION_TEXT_MAX = 120;
export const QUESTION_EMPTY_KEYWORD_MSG = '请选择蒸馏主词';
export const QUESTION_EMPTY_LINES_MSG = '请输入至少一条拓展问题';

export const QUESTION_SORTS = ['createdAt', 'usedCount', 'text'] as const;
export type QuestionSort = (typeof QUESTION_SORTS)[number];

export const QUESTION_SOURCE_LABELS: Record<QuestionSourceName, string> = {
  AI: 'AI蒸馏',
  COMBO: '手动组合',
  MANUAL: '手动添加',
};

export type QuestionRecord = {
  id: string;
  keywordId: string;
  keywordMain: string;
  text: string;
  source: QuestionSourceName;
  usedCount: number;
  included: boolean;
  createdAt: string;
};

export type QuestionBatchResult = {
  createdCount: number;
  skippedCount: number;
  items: QuestionRecord[];
};

export type QuestionListQuery = {
  page: number;
  pageSize: CrudPageSize;
  keyword: string;
  keywordId?: string;
  included?: boolean;
  createdAtFrom?: string;
  createdAtTo?: string;
  sort: QuestionSort;
  order: CrudOrder;
  export?: CrudExportFormat;
};

export const questionBatchCreateSchema = z.object({
  keywordId: z
    .string()
    .trim()
    .min(1, QUESTION_EMPTY_KEYWORD_MSG)
    .regex(KEYWORD_ID_PATTERN, QUESTION_EMPTY_KEYWORD_MSG),
  questionsText: z.string().max(100_000),
});

export type QuestionBatchCreateInput = z.infer<typeof questionBatchCreateSchema>;

export const questionUpdateSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, '请输入问题内容')
    .max(QUESTION_TEXT_MAX, `单条问题不超过 ${QUESTION_TEXT_MAX} 个字符`),
});

export type QuestionUpdateInput = z.infer<typeof questionUpdateSchema>;

export const questionBulkSchema = z.object({
  action: z.literal('delete'),
  ids: z
    .array(z.string().regex(QUESTION_ID_PATTERN, '问题编号不合法'))
    .min(1, '请先勾选要删除的问题')
    .max(200, '单次最多操作 200 条'),
});

export type QuestionBulkInput = z.infer<typeof questionBulkSchema>;

export function parseBatchQuestionLines(rawText: string): {
  items: string[];
  duplicateInInputCount: number;
} {
  const seen = new Set<string>();
  const items: string[] = [];
  let duplicateInInputCount = 0;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const stripped = rawLine
      .trim()
      .replace(/^(?:\d+[.、)）]\s*|[-*•]\s*)/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cleaned = cleanQuestionDisplay(stripped);
    if (!cleaned) continue;
    const key = normalizeQuestionKey(cleaned);
    if (!key) continue;
    if (seen.has(key)) {
      duplicateInInputCount += 1;
      continue;
    }
    seen.add(key);
    items.push(cleaned);
  }

  return { items, duplicateInInputCount };
}

function readDateBound(value: unknown, field: string, endOfDay: boolean): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new CrudQueryError(`${field} 日期格式不合法`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const iso = endOfDay ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) throw new CrudQueryError(`${field} 日期格式不合法`);
    return new Date(parsed).toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new CrudQueryError(`${field} 日期格式不合法`);
  return new Date(parsed).toISOString();
}

export function parseQuestionListQuery(raw: Record<string, unknown>): QuestionListQuery {
  const pageRaw = raw.page === undefined || raw.page === '' ? 1 : Number(raw.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1 || pageRaw > 10_000) {
    throw new CrudQueryError('页码不合法');
  }

  const sizeRaw = raw.pageSize === undefined || raw.pageSize === '' ? 10 : Number(raw.pageSize);
  if (!CRUD_PAGE_SIZES.includes(sizeRaw as CrudPageSize)) {
    throw new CrudQueryError('分页大小仅支持 10 / 25 / 50');
  }

  const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim().slice(0, 100) : '';

  let keywordId: string | undefined;
  if (raw.keywordId !== undefined && raw.keywordId !== '') {
    if (typeof raw.keywordId !== 'string' || !KEYWORD_ID_PATTERN.test(raw.keywordId.trim())) {
      throw new CrudQueryError('主词筛选编号不合法');
    }
    keywordId = raw.keywordId.trim();
  }

  let included: boolean | undefined;
  if (raw.included !== undefined && raw.included !== '') {
    if (raw.included === 'true' || raw.included === true) included = true;
    else if (raw.included === 'false' || raw.included === false) included = false;
    else throw new CrudQueryError('收录状态筛选不合法');
  }

  const createdAtFrom = readDateBound(raw.createdAtFrom, 'createdAtFrom', false);
  const createdAtTo = readDateBound(raw.createdAtTo, 'createdAtTo', true);

  const sortRaw = raw.sort === undefined || raw.sort === '' ? 'createdAt' : raw.sort;
  if (typeof sortRaw !== 'string' || !QUESTION_SORTS.includes(sortRaw as QuestionSort)) {
    throw new CrudQueryError('排序字段不合法');
  }

  const orderRaw = raw.order === undefined || raw.order === '' ? 'desc' : raw.order;
  if (typeof orderRaw !== 'string' || !CRUD_ORDERS.includes(orderRaw as CrudOrder)) {
    throw new CrudQueryError('排序方向不合法');
  }

  let exportFmt: CrudExportFormat | undefined;
  if (raw.export !== undefined && raw.export !== '') {
    if (raw.export !== 'csv' && raw.export !== 'xlsx') {
      throw new CrudQueryError('导出格式仅支持 csv / xlsx');
    }
    exportFmt = raw.export;
  }

  return {
    page: pageRaw,
    pageSize: sizeRaw as CrudPageSize,
    keyword,
    keywordId,
    included,
    createdAtFrom,
    createdAtTo,
    sort: sortRaw as QuestionSort,
    order: orderRaw as CrudOrder,
    export: exportFmt,
  };
}

export function questionListQueryString(query: Partial<QuestionListQuery>): string {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.keywordId) params.set('keywordId', query.keywordId);
  if (query.included !== undefined) params.set('included', String(query.included));
  if (query.createdAtFrom) params.set('createdAtFrom', query.createdAtFrom);
  if (query.createdAtTo) params.set('createdAtTo', query.createdAtTo);
  if (query.sort) params.set('sort', query.sort);
  if (query.order) params.set('order', query.order);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

export function questionExportTable(rows: QuestionRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['序号', '主词', '问题', '收录状态', '来源', '使用次数', '创建时间'],
    rows: rows.map((row, idx) => [
      String(idx + 1),
      row.keywordMain,
      row.text,
      row.included ? '已收录' : '未收录',
      QUESTION_SOURCE_LABELS[row.source],
      String(row.usedCount),
      row.createdAt,
    ]),
  };
}
