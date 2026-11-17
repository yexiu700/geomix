import type {
  PromptCloneInput,
  PromptKindName,
  PromptListQuery,
  PromptListResponse,
  PromptOptionsResponse,
  PromptTemplateRecord,
  PromptWriteInput,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export class PromptApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'PromptApiError';
  }
}

export type PromptGateway = {
  list(query: PromptListQuery): Promise<PromptListResponse>;
  listSystem(kind?: PromptKindName): Promise<{ items: PromptTemplateRecord[] }>;
  options(kind: PromptKindName): Promise<PromptOptionsResponse>;
  create(payload: PromptWriteInput): Promise<PromptTemplateRecord>;
  update(id: string, payload: PromptWriteInput): Promise<PromptTemplateRecord>;
  clone(id: string, payload?: PromptCloneInput): Promise<PromptTemplateRecord>;
  bulkDelete(ids: string[]): Promise<{ deleted: number }>;
  download(
    query: PromptListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
};

function buildQueryString(query: PromptListQuery & { export?: 'csv' | 'xlsx' }): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.kind) params.set('kind', query.kind);
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.export) params.set('export', query.export);
  return params.toString();
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new PromptApiError(response.status, -1, '服务响应为空');
  const json = JSON.parse(text) as Envelope<T>;
  if (!response.ok || json.code !== 0) {
    throw new PromptApiError(response.status, json.code ?? -1, json.msg || '操作失败');
  }
  return json.data;
}

export function httpPromptGateway(storage: SessionStorageLike): PromptGateway {
  return {
    async list(query) {
      const qs = buildQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/prompts?${qs}`);
      return unwrap(res);
    },
    async listSystem(kind) {
      const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      const res = await authorizedRequest(storage, 'GET', `/prompts/system${qs}`);
      return unwrap(res);
    },
    async options(kind) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/prompts/options?kind=${encodeURIComponent(kind)}`,
      );
      return unwrap(res);
    },
    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/prompts', payload);
      return unwrap(res);
    },
    async update(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/prompts/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async clone(id, payload) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/prompts/${encodeURIComponent(id)}/clone`,
        payload ?? {},
      );
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/prompts/bulk-delete', { ids });
      return unwrap(res);
    },
    async download(query, format) {
      const qs = buildQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/prompts?${qs}`);
      if (!res.ok) {
        await unwrap(res);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: `prompts.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: bytes,
      };
    },
  };
}
