import type {
  AiTaskCreateInput,
  AiTaskDetailRecord,
  AiTaskListQuery,
  AiTaskListResponse,
  ArticleCategoryRecord,
  CrudExportFormat,
  KeywordRecord,
  KnowledgeBaseRecord,
  MediaCategoryRecord,
  PromptOptionsResponse,
} from '@geomix/shared';
import { authorizedRequest } from './api';
import { httpCategoryGateway } from './categories';
import { GatewayApiError, createEnvelopeUnwrapper } from './envelope';
import { httpGalleryGateway } from './gallery';
import { httpKeywordGateway } from './keywords';
import { httpKnowledgeGateway } from './knowledge';
import { httpPromptGateway } from './prompts';
import { httpSampleGateway, type PriceItem } from './samples';
import type { SessionStorageLike } from './session';

export class AiTaskApiError extends GatewayApiError {}

export type AiTaskFormOptions = {
  categories: ArticleCategoryRecord[];
  keywords: KeywordRecord[];
  mediaCategories: MediaCategoryRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  articlePrompts: PromptOptionsResponse;
  titlePrompts: PromptOptionsResponse;
  prices: PriceItem[];
  generationMode: { bodySimulated: boolean; titleSimulated: boolean };
};

export type AiTaskGateway = {
  list(query: AiTaskListQuery): Promise<AiTaskListResponse>;
  detail(id: string): Promise<AiTaskDetailRecord>;
  create(payload: AiTaskCreateInput): Promise<AiTaskDetailRecord>;
  pause(id: string): Promise<AiTaskDetailRecord>;
  resume(id: string): Promise<AiTaskDetailRecord>;
  cancel(id: string): Promise<AiTaskDetailRecord>;
  bulkDelete(ids: string[]): Promise<{ deleted: number }>;
  download(
    query: AiTaskListQuery,
    format: CrudExportFormat,
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
  loadFormOptions(): Promise<AiTaskFormOptions>;
};

export function buildAiTaskQueryString(query: AiTaskListQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
  if (query.status) params.set('status', query.status);
  if (query.sort) params.set('sort', query.sort);
  if (query.order) params.set('order', query.order);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(AiTaskApiError);

export function httpAiTaskGateway(storage: SessionStorageLike): AiTaskGateway {
  const categoryGw = httpCategoryGateway(storage);
  const keywordGw = httpKeywordGateway(storage);
  const galleryGw = httpGalleryGateway(storage);
  const knowledgeGw = httpKnowledgeGateway(storage);
  const promptGw = httpPromptGateway(storage);
  const sampleGw = httpSampleGateway(storage);

  return {
    async list(query) {
      const qs = buildAiTaskQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/ai-tasks?${qs}`);
      return unwrap(res);
    },
    async detail(id) {
      const res = await authorizedRequest(storage, 'GET', `/ai-tasks/${encodeURIComponent(id)}`);
      return unwrap(res);
    },
    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/ai-tasks', payload);
      return unwrap(res);
    },
    async pause(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/ai-tasks/${encodeURIComponent(id)}/pause`,
        {},
      );
      return unwrap(res);
    },
    async resume(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/ai-tasks/${encodeURIComponent(id)}/resume`,
        {},
      );
      return unwrap(res);
    },
    async cancel(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/ai-tasks/${encodeURIComponent(id)}/cancel`,
        {},
      );
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/ai-tasks/bulk-delete', { ids });
      return unwrap(res);
    },
    async download(query, format) {
      const qs = buildAiTaskQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/ai-tasks?${qs}`);
      if (!res.ok) {
        await unwrap(res);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: `ai-tasks.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: bytes,
      };
    },
    async loadFormOptions() {
      const [cats, kws, gals, kbs, articlePrompts, titlePrompts, prices, generationMode] =
        await Promise.all([
          categoryGw.list({
            page: 1,
            pageSize: 50,
            keyword: '',
            sort: 'createdAt',
            order: 'desc',
            export: undefined,
          }),
          keywordGw.list({ page: 1, pageSize: 50, keyword: '', sort: 'createdAt', order: 'desc' }),
          galleryGw.listCategories({ page: 1, pageSize: 100, q: '' }),
          knowledgeGw.list({ page: 1, pageSize: 100 }),
          promptGw.options('ARTICLE'),
          promptGw.options('TITLE'),
          sampleGw.prices(),
          authorizedRequest(storage, 'GET', '/ai-tasks/generation-mode').then(
            unwrap<AiTaskFormOptions['generationMode']>,
          ),
        ]);
      return {
        categories: cats.items,
        keywords: kws.items,
        mediaCategories: gals.items,
        knowledgeBases: kbs.items,
        articlePrompts,
        titlePrompts,
        prices,
        generationMode,
      };
    },
  };
}
