import {
  moneyListQueryString,
  pointListQueryString,
  type MoneyListQuery,
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

export type MoneyItem = {
  id: string;
  title: string;
  amount: string;
  remark: string;
  createdAt: string;
};

export type LedgerPage<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

export type RightsView = {
  points: number;
  money: string;
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

export function httpPoints(
  storage: SessionStorageLike,
  query: PointListQuery,
): Promise<LedgerPage<PointItem>> {
  return readJson(storage, 'GET', `/me/points?${pointListQueryString(query)}`);
}

export function httpMoney(
  storage: SessionStorageLike,
  query: MoneyListQuery,
): Promise<LedgerPage<MoneyItem>> {
  return readJson(storage, 'GET', `/me/money?${moneyListQueryString(query)}`);
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
