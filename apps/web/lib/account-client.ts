import {
  pointListQueryString,
  type PointListQuery,
  type RightsCard,
  type VerificationInput,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export type PointItem = {
  id: string;
  title: string;
  delta: number;
  listPrice: number;
  phrase: string;
  pointsText: string;
  createdAt: string;
  status: string;
};

export type LedgerPage<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

export type WalletSummary = {
  points: number;
  pointsReserved: number;
  available: number;
  money: string;
  billingMode: string;
  billingModeSource: 'tenant' | 'global';
  tenantBillingMode: string | null;
};

export type RightsView = {
  points: number;
  pointsReserved?: number;
  available?: number;
  billingMode: string;
  cards: RightsCard[];
  models: Array<{ key: string; label: string; count: number }>;
};

export type VerificationView = {
  companyName: string;
  creditCode: string;
  contact: string;
  phone: string;
  status: string;
  placeholder: boolean;
  updatedAt: string;
};

export class AccountApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountApiError';
  }
}

export function httpWallet(storage: SessionStorageLike): Promise<WalletSummary> {
  return readJson(storage, 'GET', '/billing/wallet');
}

export function httpPoints(
  storage: SessionStorageLike,
  query: PointListQuery,
): Promise<LedgerPage<PointItem>> {
  return readJson(storage, 'GET', `/me/points?${pointListQueryString(query)}`);
}

export function httpDownloadPoints(
  storage: SessionStorageLike,
  query: PointListQuery,
  format: 'csv' | 'xlsx',
): Promise<{ filename: string; mime: string; body: Uint8Array }> {
  return downloadTable(
    storage,
    `/me/points?${pointListQueryString({ ...query, export: format })}`,
    `geomix-points.${format}`,
  );
}

export function httpRights(storage: SessionStorageLike): Promise<RightsView> {
  return readJson(storage, 'GET', '/me/rights');
}

export function httpVerification(storage: SessionStorageLike): Promise<VerificationView | null> {
  return readJson(storage, 'GET', '/me/verification');
}

export function httpSubmitVerification(
  storage: SessionStorageLike,
  input: VerificationInput,
): Promise<VerificationView> {
  return readJson(storage, 'POST', '/me/verification', input);
}

export async function httpAnnouncements(storage: SessionStorageLike): Promise<string[]> {
  const data = await readJson<{ items: Array<{ content: string }> }>(
    storage,
    'GET',
    '/announcements',
  );
  return data.items.map((item) => item.content);
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
    throw new AccountApiError(0, '无法连接接口');
  }
  const text = await response.text();
  if (!text) throw new AccountApiError(0, '接口没有返回内容');
  const payload = JSON.parse(text) as Envelope<T>;
  if (!response.ok || payload.code !== 0) {
    throw new AccountApiError(payload.code, payload.msg || '请求失败');
  }
  return payload.data;
}

async function downloadTable(
  storage: SessionStorageLike,
  path: string,
  fallbackFilename: string,
): Promise<{ filename: string; mime: string; body: Uint8Array }> {
  let response: Response;
  try {
    response = await authorizedRequest(storage, 'GET', path);
  } catch {
    throw new AccountApiError(0, '无法连接接口');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (text) {
      const payload = JSON.parse(text) as Envelope<unknown>;
      throw new AccountApiError(payload.code, payload.msg || '导出失败');
    }
    throw new AccountApiError(response.status, '导出失败');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime = response.headers.get('content-type') ?? 'application/octet-stream';
  return { filename: fallbackFilename, mime, body: bytes };
}
