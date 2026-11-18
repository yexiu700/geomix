import {
  ARTICLE_ID_PATTERN,
  type AiTaskRecord,
  type ArticleBulkStatusInput,
  type ArticleCategoryRecord,
  type ArticleCreateInput,
  type ArticleDetailRecord,
  type ArticleManageListResponse,
  type ArticleManageQuery,
  type ArticleUpdateInput,
  type ArticleZipExportInput,
  type CrudExportFormat,
  type MediaAssetRecord,
  type MediaCategoryRecord,
} from '@geomix/shared';
import { authorizedRequest } from './api';
import { httpAiTaskGateway } from './ai-tasks';
import { httpCategoryGateway } from './categories';
import { GatewayApiError, createEnvelopeUnwrapper } from './envelope';
import { httpGalleryGateway } from './gallery';
import type { SessionStorageLike } from './session';

export class ArticleManageApiError extends GatewayApiError {}

export type ArticleFormOptions = {
  categories: ArticleCategoryRecord[];
  tasks: AiTaskRecord[];
  mediaCategories: MediaCategoryRecord[];
};

export type ArticleDownloadFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

export type ArticleManageGateway = {
  list(query: ArticleManageQuery): Promise<ArticleManageListResponse>;
  detail(id: string): Promise<ArticleDetailRecord>;
  create(payload: ArticleCreateInput): Promise<ArticleDetailRecord>;
  update(id: string, payload: ArticleUpdateInput): Promise<ArticleDetailRecord>;
  approve(id: string): Promise<ArticleDetailRecord>;
  bulkStatus(payload: ArticleBulkStatusInput): Promise<{ updated: number }>;
  bulkDelete(ids: string[]): Promise<{ deleted: number }>;
  deleteOne(id: string): Promise<{ deleted: number }>;
  downloadTable(query: ArticleManageQuery, format: CrudExportFormat): Promise<ArticleDownloadFile>;
  exportZip(payload: ArticleZipExportInput): Promise<ArticleDownloadFile>;
  loadFormOptions(): Promise<ArticleFormOptions>;
  listGalleryAssets(categoryId: string): Promise<MediaAssetRecord[]>;
  uploadCoverAsset(categoryId: string, file: File): Promise<MediaAssetRecord>;
};

export function articleQueryFromHref(href: string): {
  categoryId?: string;
  taskId?: string;
} {
  const qs = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  const params = new URLSearchParams(qs);
  const rawCategoryId = params.get('categoryId')?.trim();
  const rawTaskId = params.get('taskId')?.trim();
  return {
    categoryId: rawCategoryId && ARTICLE_ID_PATTERN.test(rawCategoryId) ? rawCategoryId : undefined,
    taskId: rawTaskId && ARTICLE_ID_PATTERN.test(rawTaskId) ? rawTaskId : undefined,
  };
}

export function buildArticleManageQueryString(query: ArticleManageQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.taskId) params.set('taskId', query.taskId);
  if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
  if (query.status) params.set('status', query.status);
  if (query.sendCount !== undefined) params.set('sendCount', String(query.sendCount));
  if (query.videoCount !== undefined) params.set('videoCount', String(query.videoCount));
  if (query.createdFrom) params.set('createdFrom', query.createdFrom);
  if (query.createdTo) params.set('createdTo', query.createdTo);
  params.set('sort', query.sort);
  params.set('order', query.order);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(ArticleManageApiError);

async function readBinaryDownload(
  response: Response,
  fallbackFilename: string,
): Promise<ArticleDownloadFile> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || contentType.includes('application/json')) {
    await unwrap(response);
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return {
    filename: match?.[1] ?? fallbackFilename,
    mime: contentType || 'application/octet-stream',
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

export function httpArticleManageGateway(storage: SessionStorageLike): ArticleManageGateway {
  const categoryGw = httpCategoryGateway(storage);
  const aiTaskGw = httpAiTaskGateway(storage);
  const galleryGw = httpGalleryGateway(storage);

  return {
    async list(query) {
      const qs = buildArticleManageQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/articles?${qs}`);
      return unwrap(res);
    },
    async detail(id) {
      const res = await authorizedRequest(storage, 'GET', `/articles/${encodeURIComponent(id)}`);
      return unwrap(res);
    },
    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/articles', payload);
      return unwrap(res);
    },
    async update(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/articles/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async approve(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/articles/${encodeURIComponent(id)}/approve`,
        {},
      );
      return unwrap(res);
    },
    async bulkStatus(payload) {
      const res = await authorizedRequest(storage, 'POST', '/articles/bulk-status', payload);
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/articles/bulk-delete', { ids });
      return unwrap(res);
    },
    async deleteOne(id) {
      const res = await authorizedRequest(storage, 'DELETE', `/articles/${encodeURIComponent(id)}`);
      return unwrap(res);
    },
    async downloadTable(query, format) {
      const qs = buildArticleManageQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/articles?${qs}`);
      return readBinaryDownload(res, `geomix-articles.${format}`);
    },
    async exportZip(payload) {
      const res = await authorizedRequest(storage, 'POST', '/articles/export-zip', payload);
      return readBinaryDownload(res, `geomix-articles-${payload.format}.zip`);
    },
    async loadFormOptions() {
      const [cats, tasks, gals] = await Promise.all([
        categoryGw.list({
          page: 1,
          pageSize: 50,
          keyword: '',
          sort: 'createdAt',
          order: 'desc',
          export: undefined,
        }),
        aiTaskGw.list({
          page: 1,
          pageSize: 50,
          keyword: '',
          sort: 'createdAt',
          order: 'desc',
        }),
        galleryGw.listCategories({ page: 1, pageSize: 100, q: '' }),
      ]);
      return {
        categories: cats.items,
        tasks: tasks.items,
        mediaCategories: gals.items,
      };
    },
    async listGalleryAssets(categoryId) {
      if (!categoryId) return [];
      const res = await galleryGw.listAssets({
        page: 1,
        pageSize: 24,
        categoryId,
        q: '',
      });
      return res.items;
    },
    async uploadCoverAsset(categoryId, file) {
      const uploaded = await galleryGw.uploadAssets(categoryId, [file]);
      const item = uploaded.items[0];
      if (!item) {
        throw new ArticleManageApiError(500, -1, '封面图片上传失败');
      }
      return item.asset;
    },
  };
}
