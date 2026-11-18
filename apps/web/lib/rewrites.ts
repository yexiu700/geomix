import type {
  ArticleCategoryRecord,
  CrudExportFormat,
  MediaCategoryRecord,
  PromptTemplateRecord,
  RewriteBulkStatusInput,
  RewriteRecordItem,
  RewriteRecordListQuery,
  RewriteRecordListResponse,
  RewriteSingleCreateInput,
  RewriteSingleCreateResponse,
  RewriteUrlCheckResponse,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import { httpCategoryGateway } from './categories';
import {
  GatewayApiError,
  createEnvelopeUnwrapper,
  filenameFromContentDisposition as filenameFromDisposition,
} from './envelope';
import { httpGalleryGateway } from './gallery';
import { httpPromptGateway } from './prompts';
import type { SessionStorageLike } from './session';

export class RewriteApiError extends GatewayApiError {}

export type RewriteFormOptions = {
  categories: ArticleCategoryRecord[];
  mediaCategories: MediaCategoryRecord[];
  rewriteTemplates: PromptTemplateRecord[];
  unitPoints: number;
};

export type RewriteDownloadFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

export type RewriteSingleGateway = {
  list(query: RewriteRecordListQuery): Promise<RewriteRecordListResponse>;
  detail(id: string): Promise<RewriteRecordItem>;
  checkUrl(url: string): Promise<RewriteUrlCheckResponse>;
  createSingle(payload: RewriteSingleCreateInput): Promise<RewriteSingleCreateResponse>;
  bulkStatus(payload: RewriteBulkStatusInput): Promise<{ affected: number }>;
  bulkDelete(ids: string[]): Promise<{ affected: number }>;
  deleteOne(id: string): Promise<{ affected: number }>;
  downloadTable(
    query: RewriteRecordListQuery,
    format: CrudExportFormat,
  ): Promise<RewriteDownloadFile>;
  loadFormOptions(): Promise<RewriteFormOptions>;
};

export function buildRewriteListQueryString(
  query: RewriteRecordListQuery & { export?: CrudExportFormat },
): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.status) params.set('status', query.status);
  if (query.articleStatus) params.set('articleStatus', query.articleStatus);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(RewriteApiError);

export function httpRewriteSingleGateway(storage: SessionStorageLike): RewriteSingleGateway {
  const categoryGw = httpCategoryGateway(storage);
  const galleryGw = httpGalleryGateway(storage);
  const promptGw = httpPromptGateway(storage);

  return {
    async list(query) {
      const qs = buildRewriteListQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/rewrites?${qs}`);
      return unwrap<RewriteRecordListResponse>(res);
    },

    async detail(id) {
      const res = await authorizedRequest(storage, 'GET', `/rewrites/${encodeURIComponent(id)}`);
      return unwrap<RewriteRecordItem>(res);
    },

    async checkUrl(url) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/rewrites/check-url?url=${encodeURIComponent(url)}`,
      );
      return unwrap<RewriteUrlCheckResponse>(res);
    },

    async createSingle(payload) {
      const res = await authorizedRequest(storage, 'POST', '/rewrites', payload);
      return unwrap<RewriteSingleCreateResponse>(res);
    },

    async bulkStatus(payload) {
      const res = await authorizedRequest(storage, 'POST', '/rewrites/bulk-status', payload);
      return unwrap<{ affected: number }>(res);
    },

    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/rewrites/bulk-delete', { ids });
      return unwrap<{ affected: number }>(res);
    },

    async deleteOne(id) {
      const res = await authorizedRequest(storage, 'DELETE', `/rewrites/${encodeURIComponent(id)}`);
      return unwrap<{ affected: number }>(res);
    },

    async downloadTable(query, format) {
      const qs = buildRewriteListQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/rewrites?${qs}`);
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
          `geomix-rewrites.${format}`,
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
        authorizedRequest(storage, 'GET', '/rewrites?page=1&pageSize=1').then((r) =>
          unwrap<RewriteRecordListResponse>(r),
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
      };
    },
  };
}
