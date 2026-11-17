import {
  KB_AGREEMENT_KIND,
  KB_AGREEMENT_VERSION,
  type AgreementStatusView,
  type KnowledgeBaseListQuery,
  type KnowledgeBaseListResponse,
  type KnowledgeBaseRecord,
  type KnowledgeWriteInput,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export class KnowledgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeApiError';
  }
}

export type KnowledgeGateway = {
  list(query: KnowledgeBaseListQuery): Promise<KnowledgeBaseListResponse>;
  detail(id: string): Promise<KnowledgeBaseRecord>;
  create(payload: KnowledgeWriteInput): Promise<KnowledgeBaseRecord>;
  update(id: string, payload: KnowledgeWriteInput): Promise<KnowledgeBaseRecord>;
  bulkDelete(ids: string[]): Promise<{ deleted: number }>;
  getAgreementStatus(): Promise<AgreementStatusView>;
  signAgreement(): Promise<AgreementStatusView>;
  download(
    query: KnowledgeBaseListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
};

function buildQueryString(query: KnowledgeBaseListQuery & { export?: 'csv' | 'xlsx' }): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.mode) params.set('mode', query.mode);
  if (query.export) params.set('export', query.export);
  return params.toString();
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new KnowledgeApiError(response.status, -1, '服务响应为空');
  const json = JSON.parse(text) as Envelope<T>;
  if (!response.ok || json.code !== 0) {
    throw new KnowledgeApiError(response.status, json.code ?? -1, json.msg || '操作失败');
  }
  return json.data;
}

export function httpKnowledgeGateway(storage: SessionStorageLike): KnowledgeGateway {
  return {
    async list(query) {
      const qs = buildQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/knowledge-bases?${qs}`);
      return unwrap(res);
    },
    async detail(id) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/knowledge-bases/${encodeURIComponent(id)}`,
      );
      return unwrap(res);
    },
    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/knowledge-bases', payload);
      return unwrap(res);
    },
    async update(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/knowledge-bases/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/knowledge-bases/bulk-delete', {
        ids,
      });
      return unwrap(res);
    },
    async getAgreementStatus() {
      const qs = new URLSearchParams({
        kind: KB_AGREEMENT_KIND,
        version: KB_AGREEMENT_VERSION,
      }).toString();
      const res = await authorizedRequest(storage, 'GET', `/agreements/status?${qs}`);
      return unwrap(res);
    },
    async signAgreement() {
      const res = await authorizedRequest(storage, 'POST', '/agreements/sign', {
        kind: KB_AGREEMENT_KIND,
        version: KB_AGREEMENT_VERSION,
      });
      return unwrap(res);
    },
    async download(query, format) {
      const qs = buildQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/knowledge-bases?${qs}`);
      if (!res.ok) {
        await unwrap(res);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: `knowledge-bases.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: bytes,
      };
    },
  };
}
