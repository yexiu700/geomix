import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  RATE_LIMIT_MESSAGE,
  parseEnv,
  type MarketingLeadDto,
  type MarketingLeadMarket,
  type MarketingLeadStatus,
  type PublicPricingPayload,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import {
  MarketingService,
  type MarketingLeadListResult,
  type MarketingRateLimitStore,
} from './marketing.service';

type LeadRow = {
  id: string;
  locale: string;
  name: string;
  email: string;
  companyBrand: string;
  websiteUrl: string | null;
  targetMarket: MarketingLeadMarket;
  monthlyGoal: string | null;
  estimatedPts: number | null;
  notes: string | null;
  sourcePage: string | null;
  status: MarketingLeadStatus;
  adminNote: string | null;
  sourceIpHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PricingRow = {
  action: string;
  unitPoints: number;
  enabled: boolean;
  updatedAt: Date;
};

type Envelope<T> = {
  code: number;
  msg: string;
  data: T;
};

type StringContainsFilter = {
  contains: string;
  mode?: 'insensitive' | 'default';
};

type LeadWhereInput = {
  status?: MarketingLeadStatus;
  targetMarket?: MarketingLeadMarket;
  AND?: LeadWhereInput[];
  OR?: LeadWhereInput[];
  email?: StringContainsFilter;
  companyBrand?: StringContainsFilter;
  name?: StringContainsFilter;
};

type OrderByItem = Partial<Record<'createdAt' | 'id', 'asc' | 'desc'>>;

type LeadSelect = Partial<Record<keyof LeadRow, boolean>>;

type PricingSelect = Partial<Record<keyof PricingRow, boolean>>;

const EXPECTED_LEAD_DTO_KEYS = [
  'adminNote',
  'companyBrand',
  'createdAt',
  'email',
  'estimatedPts',
  'id',
  'locale',
  'monthlyGoal',
  'name',
  'notes',
  'sourcePage',
  'status',
  'targetMarket',
  'updatedAt',
  'websiteUrl',
];

function mintAccessToken(
  secret: string,
  user: { id: string; tenantId: string; role: 'ADMIN' | 'MERCHANT' },
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return signToken(
    {
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      typ: 'access',
      fp: passwordFingerprint('hashed_pw'),
      lms: Date.now(),
      iat: nowSec,
      exp: nowSec + 3600,
    },
    secret,
  );
}

function unescapeLike(value: string): string {
  return value.replace(/\\([%_\\])/g, '$1');
}

function matchesContains(haystack: string, filter: StringContainsFilter): boolean {
  const needle = unescapeLike(filter.contains);
  if (filter.mode === 'insensitive') {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
  return haystack.includes(needle);
}

function matchesLeadWhere(row: LeadRow, where?: LeadWhereInput): boolean {
  if (!where) return true;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.targetMarket !== undefined && row.targetMarket !== where.targetMarket) return false;
  if (where.email && !matchesContains(row.email, where.email)) return false;
  if (where.companyBrand && !matchesContains(row.companyBrand, where.companyBrand)) return false;
  if (where.name && !matchesContains(row.name, where.name)) return false;
  if (where.AND && !where.AND.every((sub) => matchesLeadWhere(row, sub))) return false;
  if (where.OR && !where.OR.some((sub) => matchesLeadWhere(row, sub))) return false;
  return true;
}

function applySelect<T extends Record<string, unknown>>(
  row: T,
  select?: Partial<Record<keyof T, boolean>>,
): Partial<T> {
  if (!select) return { ...row };
  const out: Partial<T> = {};
  for (const [key, include] of Object.entries(select)) {
    if (include) {
      out[key as keyof T] = row[key as keyof T];
    }
  }
  return out;
}

function compareOrder(a: LeadRow, b: LeadRow, orderBy?: OrderByItem | OrderByItem[]): number {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  for (const clause of list) {
    if (clause.createdAt) {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      if (diff !== 0) return clause.createdAt === 'desc' ? -diff : diff;
    }
    if (clause.id) {
      const diff = a.id.localeCompare(b.id);
      if (diff !== 0) return clause.id === 'desc' ? -diff : diff;
    }
  }
  return 0;
}

describe('MarketingModule HTTP & Security Integration (#379)', () => {
  const savedEnv = { ...process.env };
  const leads = new Map<string, LeadRow>();
  let pricingRows: PricingRow[] = [];
  let leadSeq = 0;
  let clockMs = Date.parse('2026-11-24T00:00:00.000Z');

  let app: INestApplication | undefined;
  let baseUrl = '';
  let marketingService: MarketingService | undefined;
  let adminToken = '';
  let expiredAdminToken = '';
  let merchantToken = '';
  let expiredMerchantToken = '';

  const future = new Date('2099-12-31T00:00:00.000Z');
  const past = new Date('2020-01-01T00:00:00.000Z');

  const authUsers = new Map([
    [
      'user_admin',
      {
        id: 'user_admin',
        tenantId: 'tenant_admin',
        username: 'admin',
        passwordHash: 'hashed_pw',
        nickname: 'Admin',
        role: 'ADMIN' as const,
        uiPrefs: null,
        tenant: {
          id: 'tenant_admin',
          name: 'Platform Admin',
          isActive: true,
          expiresAt: future,
        },
      },
    ],
    [
      'user_expired_admin',
      {
        id: 'user_expired_admin',
        tenantId: 'tenant_expired_admin',
        username: 'admin-expired',
        passwordHash: 'hashed_pw',
        nickname: 'Expired Admin',
        role: 'ADMIN' as const,
        uiPrefs: null,
        tenant: {
          id: 'tenant_expired_admin',
          name: 'Expired Platform Admin',
          isActive: true,
          expiresAt: past,
        },
      },
    ],
    [
      'user_merchant',
      {
        id: 'user_merchant',
        tenantId: 'tenant_a',
        username: 'merchant',
        passwordHash: 'hashed_pw',
        nickname: 'Merchant',
        role: 'MERCHANT' as const,
        uiPrefs: null,
        tenant: {
          id: 'tenant_a',
          name: 'Tenant A',
          isActive: true,
          expiresAt: future,
        },
      },
    ],
    [
      'user_expired_merchant',
      {
        id: 'user_expired_merchant',
        tenantId: 'tenant_expired',
        username: 'merchant-expired',
        passwordHash: 'hashed_pw',
        nickname: 'Expired Merchant',
        role: 'MERCHANT' as const,
        uiPrefs: null,
        tenant: {
          id: 'tenant_expired',
          name: 'Expired Tenant',
          isActive: true,
          expiresAt: past,
        },
      },
    ],
  ]);

  // Deliberately omits marketingLead & pricingItem to verify prisma.base is NEVER used by MarketingService.
  const fakeBase = {
    $disconnect: async () => undefined,
    user: {
      findUnique: async (args: { where: { id?: string } }) => {
        if (!args.where.id) return null;
        return authUsers.get(args.where.id) ?? null;
      },
    },
    auditLog: {
      findMany: async () => [],
    },
  };

  const fakeScoped = {
    $disconnect: async () => undefined,
    marketingLead: {
      create: async (args: {
        data: {
          locale?: string;
          name: string;
          email: string;
          companyBrand: string;
          websiteUrl?: string | null;
          targetMarket?: MarketingLeadMarket;
          monthlyGoal?: string | null;
          estimatedPts?: number | null;
          notes?: string | null;
          sourcePage?: string | null;
          status?: MarketingLeadStatus;
          adminNote?: string | null;
          sourceIpHash?: string | null;
        };
        select?: LeadSelect;
      }) => {
        leadSeq += 1;
        clockMs += 1000;
        const now = new Date(clockMs);
        const row: LeadRow = {
          id: `lead_${String(leadSeq).padStart(4, '0')}`,
          locale: args.data.locale ?? 'en',
          name: args.data.name,
          email: args.data.email,
          companyBrand: args.data.companyBrand,
          websiteUrl: args.data.websiteUrl ?? null,
          targetMarket: args.data.targetMarket ?? 'GLOBAL',
          monthlyGoal: args.data.monthlyGoal ?? null,
          estimatedPts: args.data.estimatedPts ?? null,
          notes: args.data.notes ?? null,
          sourcePage: args.data.sourcePage ?? null,
          status: args.data.status ?? 'NEW',
          adminNote: args.data.adminNote ?? null,
          sourceIpHash: args.data.sourceIpHash ?? null,
          createdAt: now,
          updatedAt: now,
        };
        leads.set(row.id, row);
        return applySelect(row, args.select);
      },
      findUnique: async (args: { where: { id: string }; select?: LeadSelect }) => {
        const row = leads.get(args.where.id);
        return row ? applySelect(row, args.select) : null;
      },
      findMany: async (args?: {
        where?: LeadWhereInput;
        orderBy?: OrderByItem | OrderByItem[];
        skip?: number;
        take?: number;
        select?: LeadSelect;
      }) => {
        const filtered = Array.from(leads.values()).filter((row) =>
          matchesLeadWhere(row, args?.where),
        );
        filtered.sort((a, b) => compareOrder(a, b, args?.orderBy));
        const start = args?.skip ?? 0;
        const end = args?.take !== undefined ? start + args.take : undefined;
        return filtered.slice(start, end).map((row) => applySelect(row, args?.select));
      },
      count: async (args?: { where?: LeadWhereInput }) => {
        return Array.from(leads.values()).filter((row) => matchesLeadWhere(row, args?.where))
          .length;
      },
      update: async (args: {
        where: { id: string };
        data: { status?: MarketingLeadStatus; adminNote?: string | null };
        select?: LeadSelect;
      }) => {
        const existing = leads.get(args.where.id);
        if (!existing) {
          throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
            code: 'P2025',
            clientVersion: '5.22.0',
          });
        }
        const updated: LeadRow = {
          ...existing,
          status: args.data.status !== undefined ? args.data.status : existing.status,
          adminNote: args.data.adminNote !== undefined ? args.data.adminNote : existing.adminNote,
          updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1000)),
        };
        leads.set(updated.id, updated);
        return applySelect(updated, args.select);
      },
    },
    pricingItem: {
      findMany: async (args?: {
        where?: { enabled?: boolean };
        orderBy?: { action?: 'asc' | 'desc' };
        select?: PricingSelect;
      }) => {
        const filtered = pricingRows.filter((row) =>
          args?.where?.enabled !== undefined ? row.enabled === args.where.enabled : true,
        );
        if (args?.orderBy?.action) {
          filtered.sort((a, b) =>
            args.orderBy?.action === 'desc'
              ? b.action.localeCompare(a.action)
              : a.action.localeCompare(b.action),
          );
        }
        return filtered.map((row) => applySelect(row, args?.select));
      },
    },
  };

  function seedLead(overrides: Partial<LeadRow> & { id: string; createdAt: Date }): LeadRow {
    const row: LeadRow = {
      id: overrides.id,
      locale: overrides.locale ?? 'en',
      name: overrides.name ?? 'Jane Doe',
      email: overrides.email ?? 'jane@example.com',
      companyBrand: overrides.companyBrand ?? 'Example Brand',
      websiteUrl: overrides.websiteUrl ?? 'https://example.com',
      targetMarket: overrides.targetMarket ?? 'GLOBAL',
      monthlyGoal: overrides.monthlyGoal ?? '10 articles/mo',
      estimatedPts: overrides.estimatedPts ?? 500,
      notes: overrides.notes ?? null,
      sourcePage: overrides.sourcePage ?? '/demo',
      status: overrides.status ?? 'NEW',
      adminNote: overrides.adminNote ?? null,
      sourceIpHash: overrides.sourceIpHash ?? 'a'.repeat(64),
      createdAt: overrides.createdAt,
      updatedAt: overrides.updatedAt ?? overrides.createdAt,
    };
    leads.set(row.id, row);
    return row;
  }

  async function requestJson<T>(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; headers: Headers; body: Envelope<T>; rawText: string }> {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    let serializedBody: string | undefined;
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
      serializedBody = JSON.stringify(init.body);
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: serializedBody,
    });
    const rawText = await response.text();
    const body = JSON.parse(rawText) as Envelope<T>;
    return { status: response.status, headers: response.headers, body, rawText };
  }

  beforeAll(async () => {
    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };
    prismaSvc.base = fakeBase;
    prismaSvc.scoped = fakeScoped;
    marketingService = app.get(MarketingService);

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
    adminToken = mintAccessToken(secret, {
      id: 'user_admin',
      tenantId: 'tenant_admin',
      role: 'ADMIN',
    });
    expiredAdminToken = mintAccessToken(secret, {
      id: 'user_expired_admin',
      tenantId: 'tenant_expired_admin',
      role: 'ADMIN',
    });
    merchantToken = mintAccessToken(secret, {
      id: 'user_merchant',
      tenantId: 'tenant_a',
      role: 'MERCHANT',
    });
    expiredMerchantToken = mintAccessToken(secret, {
      id: 'user_expired_merchant',
      tenantId: 'tenant_expired',
      role: 'MERCHANT',
    });
  });

  beforeEach(() => {
    leads.clear();
    pricingRows = [];
    leadSeq = 0;
    clockMs = Date.parse('2026-11-24T00:00:00.000Z');
    marketingService?.resetRateLimits();
    delete process.env.AUTH_TRUST_PROXY;
    delete process.env.MARKETING_LEAD_IP_SALT;
    delete process.env.MARKETING_LEAD_IP_RATE_LIMIT_MAX;
    delete process.env.MARKETING_LEAD_IP_RATE_LIMIT_WINDOW_SECONDS;
    delete process.env.MARKETING_LEAD_EMAIL_RATE_LIMIT_MAX;
    delete process.env.MARKETING_LEAD_EMAIL_RATE_LIMIT_WINDOW_SECONDS;
  });

  afterAll(async () => {
    marketingService?.resetRateLimits();
    if (app) {
      await app.close();
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  it('1. POST /api/v2/public/leads happy path: normalizes fields, stores salted SHA-256 sourceIpHash, zero SSRF, omits sourceIpHash in response', async () => {
    process.env.MARKETING_LEAD_IP_SALT = 'unit-test-marketing-salt';
    const assertAllowedSpy = vi.spyOn(OutboundHttpClient.prototype, 'assertAllowedUrl');
    const requestSpy = vi.spyOn(OutboundHttpClient.prototype, 'request');

    const res = await requestJson<{ accepted: boolean; id?: string }>('/api/v2/public/leads', {
      method: 'POST',
      body: {
        locale: 'zh-CN',
        name: '  Alice Wang  ',
        email: '  Alice.Wang@Acme.COM  ',
        companyBrand: 'Acme Solar',
        websiteUrl: 'https://acme-solar.example/products',
        targetMarket: 'BOTH',
        monthlyGoal: '20 articles',
        estimatedPts: 640,
        notes: 'Need demo',
        sourcePage: '/zh/demo',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Object.keys(res.body.data).sort()).toEqual(['accepted', 'id']);
    expect(res.body.data.accepted).toBe(true);
    expect(typeof res.body.data.id).toBe('string');
    expect(res.rawText).not.toContain('sourceIpHash');

    const stored = leads.get(res.body.data.id ?? '');
    expect(stored).toBeDefined();
    expect(stored?.locale).toBe('zh-CN');
    expect(stored?.name).toBe('Alice Wang');
    expect(stored?.email).toBe('alice.wang@acme.com');
    expect(stored?.companyBrand).toBe('Acme Solar');
    expect(stored?.websiteUrl).toBe('https://acme-solar.example/products');
    expect(stored?.targetMarket).toBe('BOTH');
    expect(stored?.monthlyGoal).toBe('20 articles');
    expect(stored?.estimatedPts).toBe(640);
    expect(stored?.notes).toBe('Need demo');
    expect(stored?.sourcePage).toBe('/zh/demo');
    expect(stored?.status).toBe('NEW');

    const unsalted = createHash('sha256').update('127.0.0.1', 'utf8').digest('hex');
    const expectedSalted = createHash('sha256')
      .update('unit-test-marketing-salt:127.0.0.1', 'utf8')
      .digest('hex');
    expect(stored?.sourceIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.sourceIpHash).not.toBe('127.0.0.1');
    expect(stored?.sourceIpHash).not.toBe(unsalted);
    expect(stored?.sourceIpHash).toBe(expectedSalted);

    expect(assertAllowedSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
    assertAllowedSpy.mockRestore();
    requestSpy.mockRestore();
  });

  it('2. POST /api/v2/public/leads accepts minimal payload with blank optionals and works with logged-in or invalid Bearer tokens', async () => {
    const res = await requestJson<{ accepted: boolean; id?: string }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { authorization: `Bearer ${merchantToken}` },
      body: {
        name: 'Bob Chen',
        email: 'bob@nordic.example',
        companyBrand: 'NordicAudio',
        websiteUrl: '   ',
        notes: '',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.accepted).toBe(true);
    const stored = leads.get(res.body.data.id ?? '');
    expect(stored?.locale).toBe('en');
    expect(stored?.targetMarket).toBe('GLOBAL');
    expect(stored?.status).toBe('NEW');
    expect(stored?.websiteUrl).toBeNull();
    expect(stored?.notes).toBeNull();

    const staleTokenRes = await requestJson<{ accepted: boolean; id?: string }>(
      '/api/v2/public/leads',
      {
        method: 'POST',
        headers: { authorization: 'Bearer invalid-stale-token' },
        body: {
          name: 'Carol Lin',
          email: 'carol@nordic.example',
          companyBrand: 'NordicAudio Labs',
        },
      },
    );
    expect(staleTokenRes.status).toBe(200);
    expect(staleTokenRes.body.data.accepted).toBe(true);
    expect(leads.size).toBe(2);
  });

  it('3. POST /api/v2/public/leads silently drops non-empty honeypot with 0 DB writes and does not burn email bucket', async () => {
    process.env.AUTH_TRUST_PROXY = 'true';
    process.env.MARKETING_LEAD_EMAIL_RATE_LIMIT_MAX = '1';

    const botRes = await requestJson<{ accepted: boolean; id?: string }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.5' },
      body: {
        name: 'Spam Bot',
        email: 'victim@company.example',
        companyBrand: 'Spam Inc',
        honeypot: 'http://spam.bot',
      },
    });

    expect(botRes.status).toBe(200);
    expect(botRes.body.code).toBe(0);
    expect(botRes.body.data).toEqual({ accepted: true });
    expect('id' in botRes.body.data).toBe(false);
    expect(leads.size).toBe(0);

    const legitRes = await requestJson<{ accepted: boolean; id?: string }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.6' },
      body: {
        name: 'Real Victim',
        email: 'victim@company.example',
        companyBrand: 'Company Inc',
      },
    });
    expect(legitRes.status).toBe(200);
    expect(legitRes.body.data.accepted).toBe(true);
    expect(typeof legitRes.body.data.id).toBe('string');
    expect(leads.size).toBe(1);
  });

  it('4. POST /api/v2/public/leads treats whitespace-only honeypot as a normal submission', async () => {
    const res = await requestJson<{ accepted: boolean; id?: string }>('/api/v2/public/leads', {
      method: 'POST',
      body: {
        name: 'Dan Li',
        email: 'dan@example.org',
        companyBrand: 'Dan Robotics',
        honeypot: '   \t ',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.accepted).toBe(true);
    expect(typeof res.body.data.id).toBe('string');
    expect(leads.size).toBe(1);
  });

  it('5. POST /api/v2/public/leads enforces IP rate limit BEFORE honeypot drop and returns 429 + Retry-After', async () => {
    process.env.MARKETING_LEAD_IP_RATE_LIMIT_MAX = '2';

    const first = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      body: {
        name: 'Bot 1',
        email: 'bot1@example.com',
        companyBrand: 'Bot Co',
        honeypot: 'filled-1',
      },
    });
    const second = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      body: {
        name: 'Bot 2',
        email: 'bot2@example.com',
        companyBrand: 'Bot Co',
        honeypot: 'filled-2',
      },
    });
    const third = await requestJson<null>('/api/v2/public/leads', {
      method: 'POST',
      body: {
        name: 'Real User',
        email: 'real@example.com',
        companyBrand: 'Real Co',
      },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(leads.size).toBe(0);

    expect(third.status).toBe(429);
    expect(third.body.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(third.body.msg).toBe(RATE_LIMIT_MESSAGE);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('6. POST /api/v2/public/leads ignores X-Forwarded-For unless AUTH_TRUST_PROXY=true', async () => {
    process.env.MARKETING_LEAD_IP_RATE_LIMIT_MAX = '1';

    const res1 = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body: { name: 'U1', email: 'u1@example.com', companyBrand: 'B1' },
    });
    const res2 = await requestJson<null>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.11' },
      body: { name: 'U2', email: 'u2@example.com', companyBrand: 'B2' },
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(429);

    marketingService?.resetRateLimits();
    process.env.AUTH_TRUST_PROXY = 'true';

    const trusted1 = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body: { name: 'U3', email: 'u3@example.com', companyBrand: 'B3' },
    });
    const trusted2 = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.11' },
      body: { name: 'U4', email: 'u4@example.com', companyBrand: 'B4' },
    });
    expect(trusted1.status).toBe(200);
    expect(trusted2.status).toBe(200);
  });

  it('7. POST /api/v2/public/leads enforces case-insensitive email rate limit across distinct IPs', async () => {
    process.env.AUTH_TRUST_PROXY = 'true';
    process.env.MARKETING_LEAD_IP_RATE_LIMIT_MAX = '20';
    process.env.MARKETING_LEAD_EMAIL_RATE_LIMIT_MAX = '2';

    const r1 = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.21' },
      body: { name: 'Alice', email: 'Alice@Acme.com', companyBrand: 'Acme' },
    });
    const r2 = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.22' },
      body: { name: 'Alice', email: 'alice@acme.com', companyBrand: 'Acme' },
    });
    const r3 = await requestJson<null>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.23' },
      body: { name: 'Alice', email: '  ALICE@ACME.COM ', companyBrand: 'Acme' },
    });
    const otherEmail = await requestJson<{ accepted: boolean }>('/api/v2/public/leads', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.24' },
      body: { name: 'Bob', email: 'bob@acme.com', companyBrand: 'Acme' },
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.body.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(otherEmail.status).toBe(200);
    expect(leads.size).toBe(3);
  });

  it('8. POST /api/v2/public/leads rejects invalid emails, unsafe URLs, unknown fields, and malformed params with 400 (0 DB writes)', async () => {
    process.env.MARKETING_LEAD_IP_RATE_LIMIT_MAX = '50';

    const invalidPayloads: unknown[] = [
      { name: 'A', email: 'not-an-email', companyBrand: 'Acme' },
      {
        name: 'A',
        email: 'a@acme.com',
        companyBrand: 'Acme',
        websiteUrl: 'http://127.0.0.1/admin',
      },
      {
        name: 'A',
        email: 'a@acme.com',
        companyBrand: 'Acme',
        websiteUrl: 'http://10.0.0.1/secret',
      },
      {
        name: 'A',
        email: 'a@acme.com',
        companyBrand: 'Acme',
        websiteUrl: 'http://169.254.169.254/latest/meta-data/',
      },
      {
        name: 'A',
        email: 'a@acme.com',
        companyBrand: 'Acme',
        websiteUrl: 'http://localhost:3000',
      },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', websiteUrl: 'http://[::1]/' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', websiteUrl: 'javascript:alert(1)' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', websiteUrl: 'data:text/html,hi' },
      {
        name: 'A',
        email: 'a@acme.com',
        companyBrand: 'Acme',
        websiteUrl: 'https://user:pass@acme.com',
      },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', role: 'ADMIN' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', targetMarket: 'MARS' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', locale: 'fr' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', sourcePage: '//evil.com' },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', estimatedPts: -1 },
      { name: 'A', email: 'a@acme.com', companyBrand: 'Acme', estimatedPts: 10.5 },
      { name: 'Bad\u0007Name', email: 'a@acme.com', companyBrand: 'Acme' },
    ];

    for (const payload of invalidPayloads) {
      const res = await requestJson<null>('/api/v2/public/leads', {
        method: 'POST',
        body: payload,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(API_ERROR.BAD_REQUEST);
    }

    expect(leads.size).toBe(0);
  });

  it('9. GET /api/v2/public/pricing falls back cleanly to PRICING_DEFAULTS, 7 free actions, and Demo quota when DB is empty', async () => {
    const res = await requestJson<PublicPricingPayload>('/api/v2/public/pricing');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Object.keys(res.body.data).sort()).toEqual(['demoTrial', 'freeActions', 'items']);

    expect(res.body.data.items.map((item) => [item.action, item.unitPoints])).toEqual(
      PRICING_DEFAULTS.map((entry) => [entry.action, entry.unitPoints]),
    );
    expect(res.body.data.freeActions.map((entry) => entry.action)).toEqual([
      ...FREE_RATE_LIMITED_ACTIONS,
    ]);
    expect(res.body.data.demoTrial).toEqual({
      points: DEMO_TENANT_POINTS,
      validDays: DEMO_TENANT_VALID_DAYS,
    });
  });

  it('10. GET /api/v2/public/pricing merges active overrides, ignores disabled/invalid/unknown rows, and leaks zero internal fields', async () => {
    const now = new Date('2026-11-24T00:00:00.000Z');
    pricingRows = [
      { action: 'geo_write', unitPoints: 15, enabled: true, updatedAt: now },
      { action: 'geo_variant', unitPoints: 0, enabled: true, updatedAt: now },
      { action: 'visibility_check', unitPoints: 99, enabled: false, updatedAt: now },
      { action: 'inline_image_gen', unitPoints: 0, enabled: true, updatedAt: now },
      { action: 'kb_addon', unitPoints: 50, enabled: true, updatedAt: now },
    ];

    const anon = await requestJson<PublicPricingPayload>('/api/v2/public/pricing');
    const authed = await requestJson<PublicPricingPayload>('/api/v2/public/pricing', {
      headers: { authorization: `Bearer ${merchantToken}` },
    });

    for (const res of [anon, authed]) {
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Object.keys(res.body.data).sort()).toEqual(['demoTrial', 'freeActions', 'items']);
      expect(res.body.data.items).toHaveLength(4);

      const byAction = new Map(res.body.data.items.map((item) => [item.action, item.unitPoints]));
      expect(byAction.get('geo_write')).toBe(15);
      expect(byAction.get('geo_variant')).toBe(0);
      expect(byAction.get('visibility_check')).toBe(2);
      expect(byAction.get('inline_image_gen')).toBe(5);
      expect(byAction.has('kb_addon' as never)).toBe(false);

      const serialized = JSON.stringify(res.body.data);
      for (const forbidden of [
        'billingMode',
        'SHADOW',
        'STRICT',
        'tenantId',
        'cost',
        'wallet',
        'enabled',
        'updatedAt',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('11. GET /api/v1/admin/leads enforces 401 for anonymous/forged and 404 for active/expired MERCHANT', async () => {
    const anon = await requestJson<null>('/api/v1/admin/leads');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const forged = await requestJson<null>('/api/v1/admin/leads', {
      headers: { authorization: 'Bearer forged.jwt.token' },
    });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const activeMerchant = await requestJson<null>('/api/v1/admin/leads', {
      headers: { authorization: `Bearer ${merchantToken}` },
    });
    expect(activeMerchant.status).toBe(404);
    expect(activeMerchant.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    const expiredMerchant = await requestJson<null>('/api/v1/admin/leads', {
      headers: { authorization: `Bearer ${expiredMerchantToken}` },
    });
    expect(expiredMerchant.status).toBe(404);
    expect(expiredMerchant.body.code).toBe(AUTH_ERROR.NOT_FOUND);
  });

  it('12. GET /api/v1/admin/leads lists newest-first with status/market/LIKE-escaped keyword filters, pagination, and zero sourceIpHash leakage', async () => {
    seedLead({
      id: 'lead_1',
      name: 'Lin Wei',
      email: 'lin@cn-brand.example',
      companyBrand: 'Huaxia Cloud',
      targetMarket: 'CN',
      status: 'NEW',
      createdAt: new Date('2026-11-20T01:00:00.000Z'),
    });
    seedLead({
      id: 'lead_2',
      name: 'Mia Olsen',
      email: 'mia@nordic.example',
      companyBrand: 'Nordic_Audio',
      targetMarket: 'GLOBAL',
      status: 'CONTACTED',
      createdAt: new Date('2026-11-21T01:00:00.000Z'),
    });
    seedLead({
      id: 'lead_3',
      name: 'Noah Park',
      email: 'noah@nordicx.example',
      companyBrand: 'NordicXAudio',
      targetMarket: 'GLOBAL',
      status: 'CONTACTED',
      createdAt: new Date('2026-11-22T01:00:00.000Z'),
    });
    seedLead({
      id: 'lead_4',
      name: 'Sara Chen',
      email: 'sara@dual.example',
      companyBrand: 'DualPath Labs',
      targetMarket: 'BOTH',
      status: 'TRIAL_PROVISIONED',
      createdAt: new Date('2026-11-23T01:00:00.000Z'),
    });

    const authHeaders = { authorization: `Bearer ${adminToken}` };

    const all = await requestJson<MarketingLeadListResult>('/api/v1/admin/leads', {
      headers: authHeaders,
    });
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(4);
    expect(all.body.data.items.map((item) => item.id)).toEqual([
      'lead_4',
      'lead_3',
      'lead_2',
      'lead_1',
    ]);
    expect(all.rawText).not.toContain('sourceIpHash');
    for (const item of all.body.data.items) {
      expect(Object.keys(item).sort()).toEqual(EXPECTED_LEAD_DTO_KEYS);
    }

    const byStatus = await requestJson<MarketingLeadListResult>('/api/v1/admin/leads?status=NEW', {
      headers: authHeaders,
    });
    expect(byStatus.body.data.items.map((item) => item.id)).toEqual(['lead_1']);

    const byMarket = await requestJson<MarketingLeadListResult>(
      '/api/v1/admin/leads?targetMarket=CN',
      { headers: authHeaders },
    );
    expect(byMarket.body.data.items.map((item) => item.id)).toEqual(['lead_1']);

    // Literal underscore in keyword MUST match Nordic_Audio and NOT NordicXAudio.
    const byKeyword = await requestJson<MarketingLeadListResult>(
      '/api/v1/admin/leads?keyword=NORDIC_AUDIO',
      { headers: authHeaders },
    );
    expect(byKeyword.body.data.items.map((item) => item.id)).toEqual(['lead_2']);

    const combined = await requestJson<MarketingLeadListResult>(
      '/api/v1/admin/leads?status=CONTACTED&targetMarket=GLOBAL&keyword=mia%40nordic',
      { headers: authHeaders },
    );
    expect(combined.body.data.total).toBe(1);
    expect(combined.body.data.items[0]?.id).toBe('lead_2');

    const paged = await requestJson<MarketingLeadListResult>(
      '/api/v1/admin/leads?page=2&pageSize=2',
      { headers: authHeaders },
    );
    expect(paged.body.data.total).toBe(4);
    expect(paged.body.data.page).toBe(2);
    expect(paged.body.data.pageSize).toBe(2);
    expect(paged.body.data.items.map((item) => item.id)).toEqual(['lead_2', 'lead_1']);
  });

  it('13. GET /api/v1/admin/leads rejects invalid, unknown, or duplicated query params with 400', async () => {
    const authHeaders = { authorization: `Bearer ${adminToken}` };
    const badQueries = [
      '/api/v1/admin/leads?unknown=1',
      '/api/v1/admin/leads?status=NEW&status=ARCHIVED',
      '/api/v1/admin/leads?page=1.5',
      '/api/v1/admin/leads?pageSize=101',
      '/api/v1/admin/leads?status=BOGUS',
    ];

    for (const url of badQueries) {
      const res = await requestJson<null>(url, { headers: authHeaders });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(API_ERROR.BAD_REQUEST);
    }
  });

  it('14. PATCH /api/v1/admin/leads/:id enforces 401 anon, 404 active/expired MERCHANT, and 403 expired ADMIN write', async () => {
    seedLead({
      id: 'lead_rbac_1',
      createdAt: new Date('2026-11-24T00:00:00.000Z'),
    });

    const anon = await requestJson<null>('/api/v1/admin/leads/lead_rbac_1', {
      method: 'PATCH',
      body: { status: 'CONTACTED' },
    });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const activeMerchant = await requestJson<null>('/api/v1/admin/leads/lead_rbac_1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${merchantToken}` },
      body: { status: 'CONTACTED' },
    });
    expect(activeMerchant.status).toBe(404);
    expect(activeMerchant.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    const expiredMerchant = await requestJson<null>('/api/v1/admin/leads/lead_rbac_1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${expiredMerchantToken}` },
      body: { status: 'CONTACTED' },
    });
    expect(expiredMerchant.status).toBe(404);
    expect(expiredMerchant.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    const expiredAdmin = await requestJson<null>('/api/v1/admin/leads/lead_rbac_1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${expiredAdminToken}` },
      body: { status: 'CONTACTED' },
    });
    expect(expiredAdmin.status).toBe(403);
    expect(expiredAdmin.body.code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('15. PATCH /api/v1/admin/leads/:id returns 404 for unknown ID and 400 for malformed ID or invalid body', async () => {
    seedLead({
      id: 'lead_val_1',
      createdAt: new Date('2026-11-24T00:00:00.000Z'),
    });
    const authHeaders = { authorization: `Bearer ${adminToken}` };

    const missing = await requestJson<null>('/api/v1/admin/leads/lead_missing_999', {
      method: 'PATCH',
      headers: authHeaders,
      body: { status: 'CONTACTED' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    const malformedId = await requestJson<null>('/api/v1/admin/leads/lead$$bad!', {
      method: 'PATCH',
      headers: authHeaders,
      body: { status: 'CONTACTED' },
    });
    expect(malformedId.status).toBe(400);
    expect(malformedId.body.code).toBe(API_ERROR.BAD_REQUEST);

    const badBodies: unknown[] = [
      {},
      { status: 'UNKNOWN' },
      { status: 'CONTACTED', sourceIpHash: 'x' },
    ];
    for (const body of badBodies) {
      const res = await requestJson<null>('/api/v1/admin/leads/lead_val_1', {
        method: 'PATCH',
        headers: authHeaders,
        body,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(API_ERROR.BAD_REQUEST);
    }
  });

  it('16. PATCH /api/v1/admin/leads/:id updates status/adminNote, clears adminNote with empty string or null, and omits sourceIpHash', async () => {
    const initial = seedLead({
      id: 'lead_patch_1',
      status: 'NEW',
      adminNote: null,
      createdAt: new Date('2026-11-24T00:00:00.000Z'),
    });
    const authHeaders = { authorization: `Bearer ${adminToken}` };

    const step1 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { status: 'CONTACTED' },
    });
    expect(step1.status).toBe(200);
    expect(step1.body.data.status).toBe('CONTACTED');
    expect(step1.body.data.adminNote).toBeNull();
    expect(Object.keys(step1.body.data).sort()).toEqual(EXPECTED_LEAD_DTO_KEYS);
    expect(step1.rawText).not.toContain('sourceIpHash');

    const step2 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { adminNote: 'Scheduled call' },
    });
    expect(step2.status).toBe(200);
    expect(step2.body.data.status).toBe('CONTACTED');
    expect(step2.body.data.adminNote).toBe('Scheduled call');

    const step3 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { status: 'TRIAL_PROVISIONED', adminNote: 'Demo tenant created' },
    });
    expect(step3.status).toBe(200);
    expect(step3.body.data.status).toBe('TRIAL_PROVISIONED');
    expect(step3.body.data.adminNote).toBe('Demo tenant created');
    expect(Date.parse(step3.body.data.updatedAt)).toBeGreaterThan(initial.updatedAt.getTime());

    const step4 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { adminNote: '' },
    });
    expect(step4.status).toBe(200);
    expect(step4.body.data.adminNote).toBeNull();

    const step5 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { adminNote: 'Re-added' },
    });
    expect(step5.body.data.adminNote).toBe('Re-added');

    const step6 = await requestJson<MarketingLeadDto>('/api/v1/admin/leads/lead_patch_1', {
      method: 'PATCH',
      headers: authHeaders,
      body: { adminNote: null },
    });
    expect(step6.status).toBe(200);
    expect(step6.body.data.adminNote).toBeNull();
    expect(leads.get('lead_patch_1')?.adminNote).toBeNull();
  });

  it('17. enforces strict API version isolation (wrong version routes return 404)', async () => {
    const v1Leads = await requestJson<null>('/api/v1/public/leads', {
      method: 'POST',
      body: { name: 'A', email: 'a@acme.com', companyBrand: 'Acme' },
    });
    const v1Pricing = await requestJson<null>('/api/v1/public/pricing');
    const v2Admin = await requestJson<null>('/api/v2/admin/leads', {
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(v1Leads.status).toBe(404);
    expect(v1Pricing.status).toBe(404);
    expect(v2Admin.status).toBe(404);
  });

  it('18. falls back to in-memory FreeActionRateLimiter when Redis store throws', async () => {
    const failingRedisStore: MarketingRateLimitStore = {
      async consume() {
        throw new Error('Redis connection refused');
      },
      async close() {
        return undefined;
      },
    };
    const fakePrisma = {
      scoped: fakeScoped,
    } as unknown as PrismaService;

    const svc = new MarketingService(fakePrisma, {
      redisStore: failingRedisStore,
      env: {
        MARKETING_LEAD_IP_RATE_LIMIT_MAX: '2',
        MARKETING_LEAD_EMAIL_RATE_LIMIT_MAX: '10',
      },
    });

    const first = await svc.submitLead(
      { name: 'R1', email: 'r1@example.com', companyBrand: 'Fallback Co' },
      '198.51.100.1',
    );
    const second = await svc.submitLead(
      { name: 'R2', email: 'r2@example.com', companyBrand: 'Fallback Co' },
      '198.51.100.1',
    );
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    await expect(
      svc.submitLead(
        { name: 'R3', email: 'r3@example.com', companyBrand: 'Fallback Co' },
        '198.51.100.1',
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: AUTH_ERROR.TOO_MANY_REQUESTS,
    } satisfies Partial<ApiError>);

    await svc.onModuleDestroy();
  });
});
