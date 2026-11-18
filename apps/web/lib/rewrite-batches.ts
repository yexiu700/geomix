import type {
  ArticleCategoryRecord,
  CrudExportFormat,
  MediaCategoryRecord,
  PromptTemplateRecord,
  RewriteBatchCreateInput,
  RewriteBatchDetailResponse,
  RewriteBatchItem,
  RewriteBatchListQuery,
  RewriteBatchListResponse,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import { httpCategoryGateway } from './categories';
import {
  createEnvelopeUnwrapper,
  filenameFromContentDisposition as filenameFromDisposition,
} from './envelope';
import { httpGalleryGateway } from './gallery';
import { httpPromptGateway } from './prompts';
import { RewriteApiError, type RewriteDownloadFile } from './rewrites';
import type { SessionStorageLike } from './session';

export type RewriteBatchFormOptions = {
  categories: ArticleCategoryRecord[];
  mediaCategories: MediaCategoryRecord[];
  rewriteTemplates: PromptTemplateRecord[];
  unitPoints: number;
  remoteSearchEnabled: boolean;
};

export type RewriteBatchGateway = {
  list(query: RewriteBatchListQuery): Promise<RewriteBatchListResponse>;
  detail(id: string): Promise<RewriteBatchDetailResponse>;
  create(payload: RewriteBatchCreateInput): Promise<RewriteBatchDetailResponse>;
  pause(id: string): Promise<RewriteBatchItem>;
  resume(id: string): Promise<RewriteBatchItem>;
  cancel(id: string): Promise<RewriteBatchItem>;
  deleteOne(id: string): Promise<{ affected: number }>;
  bulkDelete(ids: string[]): Promise<{ affected: number }>;
  downloadTable(
    query: RewriteBatchListQuery,
    format: CrudExportFormat,
  ): Promise<RewriteDownloadFile>;
  loadFormOptions(): Promise<RewriteBatchFormOptions>;
};

export function buildRewriteBatchListQueryString(
  query: RewriteBatchListQuery & { export?: CrudExportFormat },
): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  if (query.status) params.set('status', query.status);
  if (query.sourceType) params.set('sourceType', query.sourceType);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(RewriteApiError);

export function httpRewriteBatchGateway(storage: SessionStorageLike): RewriteBatchGateway {
  const categoryGw = httpCategoryGateway(storage);
  const galleryGw = httpGalleryGateway(storage);
  const promptGw = httpPromptGateway(storage);

  return {
    async list(query) {
      const qs = buildRewriteBatchListQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/rewrite-batches?${qs}`);
      return unwrap<RewriteBatchListResponse>(res);
    },

    async detail(id) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/rewrite-batches/${encodeURIComponent(id)}`,
      );
      return unwrap<RewriteBatchDetailResponse>(res);
    },

    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/rewrite-batches', payload);
      return unwrap<RewriteBatchDetailResponse>(res);
    },

    async pause(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/rewrite-batches/${encodeURIComponent(id)}/pause`,
      );
      return unwrap<RewriteBatchItem>(res);
    },

    async resume(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/rewrite-batches/${encodeURIComponent(id)}/resume`,
      );
      return unwrap<RewriteBatchItem>(res);
    },

    async cancel(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/rewrite-batches/${encodeURIComponent(id)}/cancel`,
      );
      return unwrap<RewriteBatchItem>(res);
    },

    async deleteOne(id) {
      const res = await authorizedRequest(
        storage,
        'DELETE',
        `/rewrite-batches/${encodeURIComponent(id)}`,
      );
      return unwrap<{ affected: number }>(res);
    },

    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/rewrite-batches/bulk-delete', {
        ids,
      });
      return unwrap<{ affected: number }>(res);
    },

    async downloadTable(query, format) {
      const qs = buildRewriteBatchListQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/rewrite-batches?${qs}`);
      if (!res.ok) {
        const text = await res.text();
        let msg = '导出失败';
        try {
          const parsed = JSON.parse(text) as Envelope<unknown>;
          if (parsed.msg) msg = parsed.msg;
        } catch {
          // ignore
        }
        throw new RewriteApiError(res.status, -1, msg);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: filenameFromDisposition(
          res.headers.get('content-disposition'),
          `geomix-rewrite-batches.${format}`,
        ),
        mime: res.headers.get('content-type') || 'application/octet-stream',
        body: bytes,
      };
    },

    async loadFormOptions() {
      const loadAllCategories = async (): Promise<ArticleCategoryRecord[]> => {
        const first = await categoryGw.list({
          page: 1,
          pageSize: 50,
          sort: 'createdAt',
          order: 'desc',
          keyword: '',
          export: undefined,
        });
        const items = [...first.items];
        const totalPages = Math.min(5, Math.ceil(first.total / 50));
        if (totalPages > 1) {
          const rest = await Promise.allSettled(
            Array.from({ length: totalPages - 1 }, (_, idx) =>
              categoryGw.list({
                page: idx + 2,
                pageSize: 50,
                sort: 'createdAt',
                order: 'desc',
                keyword: '',
                export: undefined,
              }),
            ),
          );
          for (const entry of rest) {
            if (entry.status === 'fulfilled') {
              items.push(...entry.value.items);
            }
          }
        }
        return items;
      };

      const [catRes, mediaRes, promptRes, listPreview] = await Promise.allSettled([
        loadAllCategories(),
        galleryGw.listCategories({ page: 1, pageSize: 100 }),
        promptGw.options('REWRITE'),
        authorizedRequest(storage, 'GET', '/rewrite-batches?page=1&pageSize=10').then((r) =>
          unwrap<RewriteBatchListResponse>(r),
        ),
      ]);

      return {
        categories: catRes.status === 'fulfilled' ? catRes.value : [],
        mediaCategories: mediaRes.status === 'fulfilled' ? mediaRes.value.items : [],
        rewriteTemplates:
          promptRes.status === 'fulfilled'
            ? [...promptRes.value.user, ...promptRes.value.system]
            : [],
        unitPoints: listPreview.status === 'fulfilled' ? listPreview.value.unitPoints : 5,
        remoteSearchEnabled:
          listPreview.status === 'fulfilled' ? listPreview.value.remoteSearchEnabled : false,
      };
    },
  };
}
