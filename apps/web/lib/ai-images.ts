import {
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  type AiImageCreateInput,
  type AiImageJobItem,
  type AiImageJobListQuery,
  type AiImageJobListResponse,
  type AiImageOptimizePromptInput,
  type AiImageOptimizePromptResponse,
  type AiImageSaveToGalleryInput,
  type CrudExportFormat,
  type KeywordRecord,
  type KnowledgeBaseRecord,
  type MediaAssetRecord,
  type MediaCategoryRecord,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import { httpGalleryGateway } from './gallery';
import { httpKeywordGateway } from './keywords';
import { httpKnowledgeGateway } from './knowledge';
import type { SessionStorageLike } from './session';

export class AiImageApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiImageApiError';
  }
}

export type AiImageDownloadFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

export type AiImageFormOptions = {
  mediaCategories: MediaCategoryRecord[];
  galleryAssets: MediaAssetRecord[];
  keywords: KeywordRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  unitPoints: number;
};

export type AiImageGateway = {
  list(query: AiImageJobListQuery): Promise<AiImageJobListResponse>;
  detail(id: string): Promise<AiImageJobItem>;
  optimizePrompt(input: AiImageOptimizePromptInput): Promise<AiImageOptimizePromptResponse>;
  create(input: AiImageCreateInput): Promise<AiImageJobItem>;
  saveToGallery(
    id: string,
    input: AiImageSaveToGalleryInput,
  ): Promise<{
    savedCount: number;
    categoryId: string;
    categoryName: string;
    job: AiImageJobItem;
  }>;
  deleteOne(id: string): Promise<{ deletedCount: number }>;
  bulkDelete(ids: string[]): Promise<{ deletedCount: number }>;
  downloadTable(query: AiImageJobListQuery, format: CrudExportFormat): Promise<AiImageDownloadFile>;
  loadFormOptions(): Promise<AiImageFormOptions>;
  listGalleryAssets?: (categoryId?: string) => Promise<MediaAssetRecord[]>;
};

export function buildAiImageListQueryString(
  query: AiImageJobListQuery & { export?: CrudExportFormat },
): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  if (query.status) params.set('status', query.status);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new AiImageApiError(response.status, -1, '服务响应为空');
  const json = JSON.parse(text) as Envelope<T>;
  if (!response.ok || json.code !== 0 || json.data === null || json.data === undefined) {
    throw new AiImageApiError(response.status, json.code ?? -1, json.msg || '操作失败');
  }
  return json.data;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = /filename="?([^";]+)"?/i.exec(header);
  return m?.[1]?.trim() || fallback;
}

export function httpAiImageGateway(storage: SessionStorageLike): AiImageGateway {
  const galleryGw = httpGalleryGateway(storage);
  const keywordGw = httpKeywordGateway(storage);
  const kbGw = httpKnowledgeGateway(storage);

  return {
    async list(query) {
      const qs = buildAiImageListQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/image-jobs?${qs}`);
      return unwrap<AiImageJobListResponse>(res);
    },

    async detail(id) {
      const res = await authorizedRequest(storage, 'GET', `/image-jobs/${encodeURIComponent(id)}`);
      return unwrap<AiImageJobItem>(res);
    },

    async optimizePrompt(input) {
      const res = await authorizedRequest(storage, 'POST', '/image-jobs/optimize-prompt', input);
      return unwrap<AiImageOptimizePromptResponse>(res);
    },

    async create(input) {
      const res = await authorizedRequest(storage, 'POST', '/image-jobs', input);
      return unwrap<AiImageJobItem>(res);
    },

    async saveToGallery(id, input) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/image-jobs/${encodeURIComponent(id)}/save-to-gallery`,
        input,
      );
      return unwrap<{
        savedCount: number;
        categoryId: string;
        categoryName: string;
        job: AiImageJobItem;
      }>(res);
    },

    async deleteOne(id) {
      const res = await authorizedRequest(
        storage,
        'DELETE',
        `/image-jobs/${encodeURIComponent(id)}`,
      );
      return unwrap<{ deletedCount: number }>(res);
    },

    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/image-jobs/bulk-delete', { ids });
      return unwrap<{ deletedCount: number }>(res);
    },

    async downloadTable(query, format) {
      const qs = buildAiImageListQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/image-jobs?${qs}`);
      if (!res.ok) {
        const text = await res.text();
        let msg = '导出生图记录失败';
        try {
          const parsed = JSON.parse(text) as Envelope<unknown>;
          if (parsed?.msg) msg = parsed.msg;
        } catch {
          // ignore
        }
        throw new AiImageApiError(res.status, -1, msg);
      }
      const ab = await res.arrayBuffer();
      const fallback = `geomix-ai-images.${format}`;
      return {
        filename: filenameFromDisposition(res.headers.get('content-disposition'), fallback),
        mime: res.headers.get('content-type') || 'application/octet-stream',
        body: new Uint8Array(ab),
      };
    },

    async loadFormOptions() {
      const [catRes, assetRes, kwRes, kbRes, jobList] = await Promise.all([
        galleryGw.listCategories({ page: 1, pageSize: 100 }).catch(() => ({ items: [] })),
        galleryGw.listAssets({ page: 1, pageSize: 100 }).catch(() => ({ items: [] })),
        keywordGw
          .list({ page: 1, pageSize: 50, keyword: '', sort: 'createdAt', order: 'desc' })
          .catch(() => ({ items: [] })),
        kbGw.list({ page: 1, pageSize: 50 }).catch(() => ({ items: [] })),
        authorizedRequest(storage, 'GET', '/image-jobs?page=1&pageSize=10')
          .then((r) => unwrap<AiImageJobListResponse>(r))
          .catch(() => null),
      ]);

      return {
        mediaCategories: catRes.items,
        galleryAssets: assetRes.items,
        keywords: kwRes.items,
        knowledgeBases: kbRes.items,
        unitPoints: jobList?.unitPoints ?? AI_IMAGE_DEFAULT_UNIT_POINTS,
      };
    },

    async listGalleryAssets(categoryId) {
      const res = await galleryGw.listAssets({
        page: 1,
        pageSize: 100,
        categoryId: categoryId || undefined,
      });
      return res.items;
    },
  };
}
