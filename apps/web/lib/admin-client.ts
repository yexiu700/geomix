import type {
  AnnouncementInput,
  CreateTenantInput,
  ListMarketingLeadsQuery,
  LlmDailyCostReport,
  MarketingLeadDto,
  PricingAction,
  PricingBatchUpdateInput,
  PricingUpdateInput,
  QuotaUpdateInput,
  UpdateMarketingLeadStatusInput,
  UpdateTenantInput,
} from '@geomix/shared';
import { authorizedRequest } from './api';
import { unwrapEnvelope } from './envelope';
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
  action: PricingAction;
  unitPoints: number;
  enabled: boolean;
  updatedAt: string;
  label?: string;
  unit?: string;
  description?: string;
};

export type AnnouncementRow = {
  id: string;
  content: string;
  enabled: boolean;
  sort: number;
  operatorId?: string | null;
  operatorName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type AdminLeadsQuery = Partial<ListMarketingLeadsQuery>;

export type MarketingLeadListResult = {
  items: MarketingLeadDto[];
  total: number;
  page: number;
  pageSize: number;
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
    updatePrices: (input: PricingBatchUpdateInput) =>
      readJson<{ items: PriceRow[] }>(storage, 'PUT', '/admin/pricing', input, freshKey()),
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
    deleteAnnouncement: (id: string) =>
      readJson<{ deleted: boolean; id: string }>(
        storage,
        'DELETE',
        `/admin/announcements/${id}`,
        undefined,
        freshKey(),
      ),
    llmCosts: (query?: { days?: number; includeFake?: boolean; tenantId?: string }) => {
      const params = new URLSearchParams();
      if (query?.days !== undefined) params.set('days', String(query.days));
      if (query?.includeFake !== undefined) params.set('includeFake', String(query.includeFake));
      if (query?.tenantId) params.set('tenantId', query.tenantId);
      const qs = params.toString();
      return readJson<LlmDailyCostReport>(
        storage,
        'GET',
        qs ? `/admin/llm-costs?${qs}` : '/admin/llm-costs',
      );
    },
    listAdminLeads: (query?: AdminLeadsQuery) => {
      const params = new URLSearchParams();
      if (query?.page !== undefined) params.set('page', String(query.page));
      if (query?.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
      if (query?.status) params.set('status', query.status);
      if (query?.targetMarket) params.set('targetMarket', query.targetMarket);
      const keyword = query?.keyword?.trim();
      if (keyword) params.set('keyword', keyword);
      const qs = params.toString();
      return readJson<MarketingLeadListResult>(
        storage,
        'GET',
        qs ? `/admin/leads?${qs}` : '/admin/leads',
      );
    },
    updateAdminLead: (id: string, input: UpdateMarketingLeadStatusInput) =>
      readJson<MarketingLeadDto>(
        storage,
        'PATCH',
        `/admin/leads/${encodeURIComponent(id)}`,
        input,
        freshKey(),
      ),
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
  return unwrapEnvelope<T>(response, {
    createError: (_status, code, message) => new AdminApiError(code, message),
  });
}
