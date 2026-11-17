import {
  type MediaAssetListQuery,
  type MediaAssetListResponse,
  type MediaCategoryListQuery,
  type MediaCategoryListResponse,
  type MediaCategoryRecord,
  type MediaCategoryWriteInput,
  type MediaUploadResponse,
} from '@geomix/shared';
import { authorizedRequest, refreshAccessToken, type Envelope } from './api';
import { apiBase, readAccessToken, type SessionStorageLike } from './session';

export class GalleryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'GalleryApiError';
  }
}

export type GalleryGateway = {
  listCategories(query: MediaCategoryListQuery): Promise<MediaCategoryListResponse>;
  createCategory(payload: MediaCategoryWriteInput): Promise<MediaCategoryRecord>;
  updateCategory(id: string, payload: MediaCategoryWriteInput): Promise<MediaCategoryRecord>;
  deleteCategories(ids: string[]): Promise<{ deleted: number }>;
  downloadCategories(
    query: MediaCategoryListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
  listAssets(query: MediaAssetListQuery): Promise<MediaAssetListResponse>;
  uploadAssets(
    categoryId: string,
    files: File[],
    onProgress?: (percent: number) => void,
  ): Promise<MediaUploadResponse>;
  deleteAssets(ids: string[]): Promise<{ deleted: number; releasedBytes: number }>;
  downloadAssets(
    query: MediaAssetListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
};

export function resolveMediaUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (
    /^https?:\/\//i.test(pathOrUrl) ||
    pathOrUrl.startsWith('data:') ||
    pathOrUrl.startsWith('blob:')
  ) {
    return pathOrUrl;
  }
  const origin = apiBase().replace(/\/api\/v1$/, '');
  if (pathOrUrl.startsWith('/')) {
    return `${origin}${pathOrUrl}`;
  }
  return `${origin}/${pathOrUrl}`;
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new GalleryApiError(response.status, -1, '服务响应为空');
  const json = JSON.parse(text) as Envelope<T>;
  if (!response.ok || json.code !== 0) {
    throw new GalleryApiError(response.status, json.code ?? -1, json.msg || '操作失败');
  }
  return json.data;
}

function categoryQueryString(query: MediaCategoryListQuery & { export?: 'csv' | 'xlsx' }): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.q) params.set('q', query.q);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

function assetQueryString(query: MediaAssetListQuery & { export?: 'csv' | 'xlsx' }): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.q) params.set('q', query.q);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

export function httpGalleryGateway(storage: SessionStorageLike): GalleryGateway {
  return {
    async listCategories(query) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/media-categories?${categoryQueryString(query)}`,
      );
      return unwrap(res);
    },
    async createCategory(payload) {
      const res = await authorizedRequest(storage, 'POST', '/media-categories', payload);
      return unwrap(res);
    },
    async updateCategory(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/media-categories/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async deleteCategories(ids) {
      const res = await authorizedRequest(storage, 'POST', '/media-categories/bulk', { ids });
      return unwrap(res);
    },
    async downloadCategories(query, format) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/media-categories?${categoryQueryString({ ...query, export: format })}`,
      );
      if (!res.ok) await unwrap(res);
      return {
        filename: `media-categories.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async listAssets(query) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/media-assets?${assetQueryString(query)}`,
      );
      return unwrap(res);
    },
    async uploadAssets(categoryId, files, onProgress) {
      onProgress?.(25);
      const sendForm = async (token: string): Promise<Response> => {
        const form = new FormData();
        form.set('categoryId', categoryId);
        for (const file of files) {
          form.append('files', file, file.name);
        }
        return fetch(`${apiBase()}/media-assets/upload`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: form,
        });
      };
      const token = readAccessToken(storage);
      if (!token) throw new GalleryApiError(401, 40100, '未登录');
      let res = await sendForm(token);
      if (res.status === 401) {
        const nextToken = await refreshAccessToken(storage);
        if (nextToken) res = await sendForm(nextToken);
      }
      onProgress?.(90);
      const data = await unwrap<MediaUploadResponse>(res);
      onProgress?.(100);
      return data;
    },
    async deleteAssets(ids) {
      const res = await authorizedRequest(storage, 'POST', '/media-assets/bulk', { ids });
      return unwrap(res);
    },
    async downloadAssets(query, format) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/media-assets?${assetQueryString({ ...query, export: format })}`,
      );
      if (!res.ok) await unwrap(res);
      return {
        filename: `media-assets.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
  };
}
