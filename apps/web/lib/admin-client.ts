import type {
  AnnouncementInput,
  CreateTenantInput,
  PricingUpdateInput,
  QuotaUpdateInput,
  TemplateWriteInput,
  UpdateTenantInput,
} from '@geomix/shared';
import { authorizedRequest, type Envelope } from './api';
import type { SessionStorageLike } from './session';

export type TenantRow = {
  id: string;
  name: string;
  username: string;
  expiresAt: string;
  isActive: boolean;
  billingMode: 'SHADOW' | 'STRICT' | null;
  resolvedBillingMode: 'SHADOW' | 'STRICT';
  points: number;
  pointsReserved: number;
  money: string;
  quotas?: Array<{ key: string; used: string; limit: string }>;
};

export type PriceRow = {
  action: string;
  unitPoints: number;
  enabled: boolean;
  updatedAt: string;
};

export type AnnouncementRow = {
  id: string;
  content: string;
  enabled: boolean;
  sort: number;
};

export type TemplateRow = {
  id: string;
  kind: 'ARTICLE' | 'TITLE' | 'REWRITE';
  name: string;
  content: string;
  randomPool: boolean;
  sort: number;
  updatedAt: string;
};

export class AdminApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function freshKey(): string {
  return `adm${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 40);
}

export function httpAdmin(storage: SessionStorageLike) {
  return {
    listTenants: async () => {
      const data = await readJson<{ items: TenantRow[] }>(
        storage,
        'GET',
        '/admin/tenants?pageSize=50',
      );
      return data.items;
    },
    getTenant: (id: string) => readJson<TenantRow>(storage, 'GET', `/admin/tenants/${id}`),
    createTenant: (input: CreateTenantInput) =>
      readJson<TenantRow>(storage, 'POST', '/admin/tenants', input, freshKey()),
    updateTenant: (id: string, input: UpdateTenantInput) =>
      readJson<TenantRow>(storage, 'PATCH', `/admin/tenants/${id}`, input, freshKey()),
    updateQuotas: (id: string, input: QuotaUpdateInput) =>
      readJson<TenantRow>(storage, 'PUT', `/admin/tenants/${id}/quotas`, input, freshKey()),
    adjust: (tenantId: string, delta: number) =>
      readJson(storage, 'POST', '/admin/billing/adjust', {
        tenantId,
        delta,
        idempotencyKey: freshKey(),
      }),
    setMode: (tenantId: string, billingMode: 'SHADOW' | 'STRICT' | null) =>
      readJson(storage, 'POST', '/admin/billing/mode', { tenantId, billingMode }),
    listPrices: async () => {
      const data = await readJson<{ items: PriceRow[] }>(storage, 'GET', '/admin/pricing');
      return data.items;
    },
    updatePrice: (input: PricingUpdateInput) =>
      readJson<{ items: PriceRow[] }>(storage, 'PATCH', '/admin/pricing', input, freshKey()),
    listAnnouncements: async () => {
      const data = await readJson<{ items: AnnouncementRow[] }>(
        storage,
        'GET',
        '/admin/announcements',
      );
      return data.items;
    },
    createAnnouncement: (input: AnnouncementInput) =>
      readJson<AnnouncementRow>(storage, 'POST', '/admin/announcements', input, freshKey()),
    updateAnnouncement: (id: string, input: AnnouncementInput) =>
      readJson<AnnouncementRow>(storage, 'PATCH', `/admin/announcements/${id}`, input, freshKey()),
    listTemplates: async () => {
      const data = await readJson<{ items: TemplateRow[] }>(storage, 'GET', '/admin/templates');
      return data.items;
    },
    createTemplate: (input: TemplateWriteInput) =>
      readJson<TemplateRow>(storage, 'POST', '/admin/templates', input, freshKey()),
    updateTemplate: (id: string, input: TemplateWriteInput) =>
      readJson<TemplateRow>(storage, 'PATCH', `/admin/templates/${id}`, input, freshKey()),
  };
}

export type AdminClient = ReturnType<typeof httpAdmin>;

async function readJson<T>(
  storage: SessionStorageLike,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await authorizedRequest(
      storage,
      method,
      path,
      body,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
    );
  } catch {
    throw new AdminApiError(0, '无法连接接口');
  }
  const text = await response.text();
  if (!text) throw new AdminApiError(0, '接口没有返回内容');
  const payload = JSON.parse(text) as Envelope<T>;
  if (!response.ok || payload.code !== 0) {
    throw new AdminApiError(payload.code, payload.msg || '请求失败');
  }
  return payload.data;
}
