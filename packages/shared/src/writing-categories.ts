import { z } from 'zod';
import {
  CRUD_PAGE_SIZES,
  type CrudExportFormat,
  type CrudOrder,
  type CrudPageSize,
  escapeLikeLiteral,
} from './crud';

/**
 * 文章分类。数量和剩余量不落库，由查询时的 SQL 聚合得出。
 * 剩余量 = 状态为正常（NORMAL）且发送次数为 0。来源不参与这个判断。
 */

export const CATEGORY_NAME_MAX = 40;
export const CATEGORY_ID = /^[a-z0-9]{20,32}$/;

export const ARTICLE_STATUSES = ['PENDING', 'NORMAL', 'DISABLED'] as const;
export type ArticleStatusName = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_STATUS_NORMAL: ArticleStatusName = 'NORMAL';
export const REMAINING_SEND_COUNT = 0;

export const ARTICLE_STATUS_LABEL: Record<ArticleStatusName, string> = {
  PENDING: '待审核',
  NORMAL: '正常',
  DISABLED: '停用',
};

export const CATEGORY_SORTS = ['createdAt', 'name', 'total', 'remaining'] as const;
export type CategorySort = (typeof CATEGORY_SORTS)[number];

/** 与路线中的聚合表达式一致。只由上面的常量拼出，不接受外部文本。 */
export const CATEGORY_REMAINING_EXPR = `COUNT(a.id) FILTER (WHERE a.status = '${ARTICLE_STATUS_NORMAL}' AND a."sendCount" = ${REMAINING_SEND_COUNT})`;

export function articleCountsAsRemaining(status: string, sendCount: number): boolean {
  return status === ARTICLE_STATUS_NORMAL && sendCount === REMAINING_SEND_COUNT;
}

/**
 * Prisma contains 和这里的 ILIKE 都会再包一层百分号。
 * 先转义用户输入里的 \ % _，避免一个百分号把整表搜出来。
 */
export function categoryNameLikePattern(keyword: string): string | null {
  if (!keyword) return null;
  return `%${escapeLikeLiteral(keyword)}%`;
}

export class CategoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryQueryError';
  }
}

const nameSchema = z
  .string()
  .trim()
  .min(1, '请填写文章分类')
  .max(CATEGORY_NAME_MAX, '文章分类最多 40 字')
  .refine((value) => !hasControl(value), '文章分类含有无法显示的字符');

export const articleCategoryInputSchema = z
  .object({
    name: nameSchema,
  })
  .strict();

export type ArticleCategoryInput = z.infer<typeof articleCategoryInputSchema>;

export const articleCategoryBulkSchema = z
  .object({
    action: z.literal('delete', { errorMap: () => ({ message: '操作不正确' }) }),
    ids: z
      .array(z.string().regex(CATEGORY_ID, '分类编号不正确'))
      .min(1, '请选择分类')
      .max(100, '一次最多 100 条'),
  })
  .strict();

export type ArticleCategoryBulkInput = z.infer<typeof articleCategoryBulkSchema>;

export type CategoryListQuery = {
  page: number;
  pageSize: CrudPageSize;
  sort: CategorySort;
  order: CrudOrder;
  keyword: string;
  export: CrudExportFormat | undefined;
};

export type ArticleCategoryRecord = {
  id: string;
  name: string;
  total: number;
  remaining: number;
  createdAt: string;
};

export type ArticleListQuery = {
  categoryId: string;
  page: number;
  pageSize: CrudPageSize;
};

export type ArticleListItem = {
  id: string;
  title: string;
  status: ArticleStatusName;
  sendCount: number;
  countsAsRemaining: boolean;
  createdAt: string;
};

export function parseCategoryListQuery(input: Record<string, unknown>): CategoryListQuery {
  return {
    page: readPage(input.page),
    pageSize: readPageSize(input.pageSize),
    sort: readSort(input.sort),
    order: readOrder(input.order),
    keyword: readKeyword(input.filter),
    export: readExport(input.export),
  };
}

export function categoryListQueryString(query: CategoryListQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', query.sort);
  params.set('order', query.order);
  if (query.keyword) params.set('filter', JSON.stringify({ keyword: query.keyword }));
  if (query.export) params.set('export', query.export);
  return params.toString();
}

export function parseArticleListQuery(input: Record<string, unknown>): ArticleListQuery {
  for (const key of Object.keys(input)) {
    if (key !== 'categoryId' && key !== 'page' && key !== 'pageSize' && key !== 'taskId') {
      throw new CategoryQueryError('参数不正确');
    }
  }
  if ('taskId' in input) readOptionalString(input.taskId);
  const categoryId = one(input.categoryId);
  if (!categoryId || !CATEGORY_ID.test(categoryId)) {
    throw new CategoryQueryError('分类编号不正确');
  }
  return {
    categoryId,
    page: readPage(input.page),
    pageSize: readPageSize(input.pageSize),
  };
}

export function articleListQueryString(query: ArticleListQuery): string {
  const params = new URLSearchParams();
  params.set('categoryId', query.categoryId);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  return params.toString();
}

export function categoryExportFilename(format: CrudExportFormat): string {
  return format === 'csv' ? 'geomix-article-categories.csv' : 'geomix-article-categories.xlsx';
}

export function categoryExportMime(format: CrudExportFormat): string {
  return format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

export function categoryExportTable(rows: ArticleCategoryRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['分类名称', '文章数量', '文章剩余量', '创建时间'],
    rows: rows.map((row) => [row.name, String(row.total), String(row.remaining), row.createdAt]),
  };
}

export function isArticleStatus(value: string): value is ArticleStatusName {
  return (ARTICLE_STATUSES as readonly string[]).includes(value);
}

function readKeyword(value: unknown): string {
  const raw = one(value);
  if (raw === undefined || raw === '') return '';
  if (raw.length > 500) throw new CategoryQueryError('筛选不正确');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CategoryQueryError('筛选不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CategoryQueryError('筛选不正确');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'keyword') throw new CategoryQueryError('筛选不正确');
  }
  if (!('keyword' in record)) return '';
  if (typeof record.keyword !== 'string') throw new CategoryQueryError('筛选不正确');
  const keyword = record.keyword.trim();
  if (keyword.length > CATEGORY_NAME_MAX || hasControl(keyword)) {
    throw new CategoryQueryError('筛选不正确');
  }
  return keyword;
}

function readPage(value: unknown): number {
  const raw = one(value);
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new CategoryQueryError('分页不正确');
  return Number(raw);
}

function readPageSize(value: unknown): CrudPageSize {
  const raw = one(value);
  if (raw === undefined || raw === '') return 10;
  if ((CRUD_PAGE_SIZES as readonly number[]).some((size) => String(size) === raw)) {
    return Number(raw) as CrudPageSize;
  }
  throw new CategoryQueryError('分页不正确');
}

function readSort(value: unknown): CategorySort {
  const raw = one(value);
  if (raw === undefined || raw === '') return 'createdAt';
  if ((CATEGORY_SORTS as readonly string[]).includes(raw)) return raw as CategorySort;
  throw new CategoryQueryError('排序不正确');
}

function readOrder(value: unknown): CrudOrder {
  const raw = one(value);
  if (raw === undefined || raw === '') return 'desc';
  if (raw === 'asc' || raw === 'desc') return raw;
  throw new CategoryQueryError('排序不正确');
}

function readExport(value: unknown): CrudExportFormat | undefined {
  const raw = one(value);
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'csv' || raw === 'xlsx') return raw;
  throw new CategoryQueryError('导出格式不正确');
}

function readOptionalString(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new CategoryQueryError('参数不正确');
}

function one(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CategoryQueryError('参数不正确');
  return value;
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
