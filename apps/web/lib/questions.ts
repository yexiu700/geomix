import {
  questionListQueryString,
  type KeywordRecord,
  type QuestionBatchCreateInput,
  type QuestionBatchResult,
  type QuestionListQuery,
  type QuestionRecord,
  type QuestionUpdateInput,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export class QuestionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'QuestionApiError';
  }
}

export type QuestionGateway = {
  list(query: QuestionListQuery): Promise<{
    items: QuestionRecord[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  listKeywords(): Promise<KeywordRecord[]>;
  batchCreate(payload: QuestionBatchCreateInput): Promise<QuestionBatchResult>;
  update(id: string, payload: QuestionUpdateInput): Promise<QuestionRecord>;
  bulkDelete(ids: string[]): Promise<{ affected: number }>;
  download(
    query: QuestionListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
};

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new QuestionApiError(response.status, -1, '服务响应为空');
  const json = JSON.parse(text) as Envelope<T>;
  if (!response.ok || json.code !== 0) {
    throw new QuestionApiError(response.status, json.code ?? -1, json.msg || '操作失败');
  }
  return json.data;
}

export function httpQuestionGateway(storage: SessionStorageLike): QuestionGateway {
  return {
    async list(query) {
      const qs = questionListQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/questions?${qs}`);
      return unwrap(res);
    },
    async listKeywords() {
      const res = await authorizedRequest(
        storage,
        'GET',
        '/keywords?page=1&pageSize=50&sort=createdAt&order=desc',
      );
      const data = await unwrap<{ items: KeywordRecord[] }>(res);
      return data.items;
    },
    async batchCreate(payload) {
      const res = await authorizedRequest(storage, 'POST', '/questions', payload);
      return unwrap(res);
    },
    async update(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/questions/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/questions/bulk', {
        action: 'delete',
        ids,
      });
      return unwrap(res);
    },
    async download(query, format) {
      const qs = questionListQueryString({ ...query, export: format });
      const res = await authorizedRequest(storage, 'GET', `/questions?${qs}`);
      if (!res.ok) {
        await unwrap(res);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: `questions.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: bytes,
      };
    },
  };
}
