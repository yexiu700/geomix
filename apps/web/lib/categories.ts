import {
  articleListQueryString,
  categoryListQueryString,
  CATEGORY_ID,
  type ArticleCategoryInput,
  type ArticleCategoryRecord,
  type ArticleListItem,
  type ArticleListQuery,
  type CategoryListQuery,
  type CrudExportFormat,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export type CategoryPage = {
  items: ArticleCategoryRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type ArticlePage = {
  category: ArticleCategoryRecord;
  items: ArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type CategoryFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

export type CategoryGateway = {
  list(query: CategoryListQuery): Promise<CategoryPage>;
  create(input: ArticleCategoryInput): Promise<ArticleCategoryRecord>;
  update(id: string, input: ArticleCategoryInput): Promise<ArticleCategoryRecord>;
  remove(ids: string[]): Promise<{ affected: number }>;
  download(query: CategoryListQuery, format: CrudExportFormat): Promise<CategoryFile>;
};

export type ArticleGateway = {
  list(query: ArticleListQuery): Promise<ArticlePage>;
};

export class CategoryApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CategoryApiError';
  }
}

export function categoryIdFromHref(href: string): string {
  const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  const value = new URLSearchParams(query).get('categoryId')?.trim() ?? '';
  return CATEGORY_ID.test(value) ? value : '';
}

export function httpCategoryGateway(storage: SessionStorageLike): CategoryGateway {
  return {
    list: (query) =>
      readJson<CategoryPage>(
        storage,
        'GET',
        `/writing/categories?${categoryListQueryString(query)}`,
      ),
    create: (input) =>
      readJson<ArticleCategoryRecord>(storage, 'POST', '/writing/categories', input),
    update: (id, input) =>
      readJson<ArticleCategoryRecord>(storage, 'PATCH', `/writing/categories/${id}`, input),
    remove: (ids) =>
      readJson<{ affected: number }>(storage, 'POST', '/writing/categories/bulk', {
        action: 'delete',
        ids,
      }),
    download: (query, format) =>
      downloadFile(
        storage,
        `/writing/categories?${categoryListQueryString({ ...query, export: format })}`,
        'geomix-article-categories',
      ),
  };
}

export function httpArticleGateway(storage: SessionStorageLike): ArticleGateway {
  return {
    list: (query) =>
      readJson<ArticlePage>(storage, 'GET', `/writing/articles?${articleListQueryString(query)}`),
  };
}

async function downloadFile(
  storage: SessionStorageLike,
  path: string,
  fallback: string,
): Promise<CategoryFile> {
  let response: Response;
  try {
    response = await authorizedRequest(storage, 'GET', path);
  } catch {
    throw new CategoryApiError(0, '无法连接接口');
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json') || type === '') await throwEnvelope(response);
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return {
    filename: match?.[1] ?? fallback,
    mime: type,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

async function readJson<T>(
  storage: SessionStorageLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await authorizedRequest(storage, method, path, body);
  } catch {
    throw new CategoryApiError(0, '无法连接接口');
  }
  return throwEnvelope<T>(response);
}

async function throwEnvelope<T>(response: Response): Promise<T> {
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new CategoryApiError(0, '无法连接接口');
  }
  if (payload.code !== 0 || payload.data === null || payload.data === undefined) {
    throw new CategoryApiError(payload.code, payload.msg || '请求失败');
  }
  return payload.data;
}
