import type {
  KeywordDetailRecord,
  KeywordListQuery,
  KeywordRecord,
  QuestionSourceName,
} from '@geomix/shared';
import { authorizedRequest } from './api';
import { GatewayApiError, createEnvelopeUnwrapper } from './envelope';
import type { PriceItem } from './samples';
import type { SessionStorageLike } from './session';

export class KeywordApiError extends GatewayApiError {}

export type KeywordSavePayload = {
  main: string;
  brands: string;
  questionsText: string;
  questionItems?: Array<{ text: string; source?: QuestionSourceName }>;
};

export type KeywordGateway = {
  list(query: KeywordListQuery): Promise<{
    items: KeywordRecord[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  one(id: string): Promise<KeywordDetailRecord>;
  create(payload: KeywordSavePayload): Promise<{
    keyword: KeywordRecord;
    addedQuestions: number;
    skippedDuplicates: number;
  }>;
  update(
    id: string,
    payload: KeywordSavePayload,
  ): Promise<{
    keyword: KeywordRecord;
    addedQuestions: number;
    removedQuestions: number;
    skippedDuplicates: number;
  }>;
  bulkDelete(ids: string[]): Promise<{ affected: number }>;
  distill(payload: {
    main: string;
    brands: string;
    idempotencyKey: string;
  }): Promise<{ questions: string[]; charged: number; shadow: boolean }>;
  prices(): Promise<PriceItem[]>;
  download(
    query: KeywordListQuery,
    format: 'csv' | 'xlsx',
  ): Promise<{ filename: string; mime: string; body: Uint8Array }>;
};

function toQueryString(query: KeywordListQuery, format?: 'csv' | 'xlsx'): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', query.sort);
  params.set('order', query.order);
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.optStatus) params.set('optStatus', query.optStatus);
  if (format) params.set('export', format);
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(KeywordApiError, { requireData: false });

export function httpKeywordGateway(storage: SessionStorageLike): KeywordGateway {
  return {
    async list(query) {
      const res = await authorizedRequest(storage, 'GET', `/keywords?${toQueryString(query)}`);
      return unwrap(res);
    },
    async one(id) {
      const res = await authorizedRequest(storage, 'GET', `/keywords/${encodeURIComponent(id)}`);
      return unwrap(res);
    },
    async create(payload) {
      const res = await authorizedRequest(storage, 'POST', '/keywords', payload);
      return unwrap(res);
    },
    async update(id, payload) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/keywords/${encodeURIComponent(id)}`,
        payload,
      );
      return unwrap(res);
    },
    async bulkDelete(ids) {
      const res = await authorizedRequest(storage, 'POST', '/keywords/bulk', {
        action: 'delete',
        ids,
      });
      return unwrap(res);
    },
    async distill(payload) {
      const res = await authorizedRequest(
        storage,
        'POST',
        '/keywords/distill',
        { main: payload.main, brands: payload.brands },
        { 'idempotency-key': payload.idempotencyKey },
      );
      return unwrap(res);
    },
    async prices() {
      const res = await authorizedRequest(storage, 'GET', '/pricing');
      const data = await unwrap<{ items: PriceItem[] }>(res);
      return data.items;
    },
    async download(query, format) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/keywords?${toQueryString(query, format)}`,
      );
      if (!res.ok) {
        await unwrap(res);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        filename: `keywords.${format}`,
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        body: bytes,
      };
    },
  };
}
