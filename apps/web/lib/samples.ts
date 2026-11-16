import {
  crudListQueryString,
  type CrudExportFormat,
  type CrudListQuery,
  type SampleInput,
  type SampleRecord,
} from '@geomix/shared';

export type { SampleRecord };
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export type SamplePage = {
  items: SampleRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type PriceItem = {
  action: string;
  unitPoints: number;
  enabled: boolean;
  label: string;
};

export type SampleFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

export type SampleGateway = {
  list(query: CrudListQuery): Promise<SamplePage>;
  create(input: SampleInput): Promise<SampleRecord>;
  update(id: string, input: SampleInput): Promise<SampleRecord>;
  bulk(action: 'delete' | 'enable' | 'disable', ids: string[]): Promise<{ affected: number }>;
  prices(): Promise<PriceItem[]>;
  download(query: CrudListQuery, format: CrudExportFormat): Promise<SampleFile>;
};

export class SampleApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SampleApiError';
  }
}

export function httpSampleGateway(storage: SessionStorageLike): SampleGateway {
  return {
    list: (query) =>
      readJson<SamplePage>(storage, 'GET', `/workbench/samples?${crudListQueryString(query)}`),
    create: (input) => readJson<SampleRecord>(storage, 'POST', '/workbench/samples', input),
    update: (id, input) =>
      readJson<SampleRecord>(storage, 'PATCH', `/workbench/samples/${id}`, input),
    bulk: (action, ids) =>
      readJson<{ affected: number }>(storage, 'POST', '/workbench/samples/bulk', { action, ids }),
    prices: async () => {
      const data = await readJson<{ items: PriceItem[] }>(storage, 'GET', '/pricing');
      return data.items;
    },
    download: async (query, format) => {
      const response = await authorizedRequest(
        storage,
        'GET',
        `/workbench/samples?${crudListQueryString({ ...query, export: format })}`,
      );
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('application/json') || type === '') {
        await throwEnvelope(response);
      }
      const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
      return {
        filename: match?.[1] ?? 'geomix-samples',
        mime: type,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

async function readJson<T>(
  storage: SessionStorageLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await authorizedRequest(storage, method, path, body);
  } catch {
    throw new SampleApiError(0, '无法连接接口');
  }
  return throwEnvelope<T>(response);
}

async function throwEnvelope<T>(response: Response): Promise<T> {
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new SampleApiError(0, '无法连接接口');
  }
  if (payload.code !== 0 || payload.data === null || payload.data === undefined) {
    throw new SampleApiError(payload.code, payload.msg || '请求失败');
  }
  return payload.data;
}
