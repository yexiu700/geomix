import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR, BILLING_ERROR, createBrandSchema, parseEnv } from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { createApiApp } from '../common/create-api-app';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { BrandsService } from './brands.service';

type StoredMarket = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type StoredBrand = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  markets: StoredMarket[];
};

function createScopedStore(getTenantId: () => string | undefined) {
  const brands: StoredBrand[] = [];
  let seq = 1;

  const scoped = {
    brand: {
      findMany: vi.fn(async () => {
        const tid = getTenantId();
        return brands
          .filter((b) => !tid || b.tenantId === tid)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map((b) => ({
            ...b,
            markets: [...b.markets].sort((x, y) => x.market.localeCompare(y.market)),
          }));
      }),
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        const found = brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid));
        if (!found) return null;
        return {
          ...found,
          markets: [...found.markets].sort((x, y) => x.market.localeCompare(y.market)),
        };
      }),
      create: vi.fn(
        async (args: {
          data: {
            tenantId: string;
            name: string;
            category: string;
            truthAgreementSignedAt?: Date;
            markets: {
              create: Array<{
                tenantId: string;
                market: 'CN' | 'GLOBAL';
                locale: string;
                region: string;
                localBrandName: string;
                aliases: string[];
                ownedDomains: string[];
                competitors: unknown;
                seedPrompts: string[];
              }>;
            };
          };
        }) => {
          const tenantId = getTenantId() ?? args.data.tenantId;
          if (brands.some((b) => b.tenantId === tenantId && b.name === args.data.name)) {
            const dup = new Error('Unique constraint failed') as Error & { code: string };
            dup.code = 'P2002';
            throw dup;
          }
          const now = new Date();
          const brandId = `brand_${seq++}`;
          const nestedMarkets: StoredMarket[] = args.data.markets.create.map((m) => ({
            id: `bm_${seq++}`,
            tenantId: m.tenantId,
            brandId,
            market: m.market,
            locale: m.locale,
            region: m.region,
            localBrandName: m.localBrandName,
            aliases: m.aliases,
            ownedDomains: m.ownedDomains,
            competitors: m.competitors,
            seedPrompts: m.seedPrompts,
            createdAt: now,
            updatedAt: now,
          }));
          const record: StoredBrand = {
            id: brandId,
            tenantId,
            name: args.data.name,
            category: args.data.category,
            truthAgreementSignedAt: args.data.truthAgreementSignedAt ?? null,
            createdAt: now,
            updatedAt: now,
            markets: nestedMarkets,
          };
          brands.push(record);
          return {
            ...record,
            markets: [...record.markets].sort((x, y) => x.market.localeCompare(y.market)),
          };
        },
      ),
    },
    brandMarket: {
      create: vi.fn(
        async (args: {
          data: {
            tenantId: string;
            brandId: string;
            market: 'CN' | 'GLOBAL';
            locale: string;
            region: string;
            localBrandName: string;
            aliases: string[];
            ownedDomains: string[];
            competitors: unknown;
            seedPrompts: string[];
          };
        }) => {
          const brand = brands.find((b) => b.id === args.data.brandId);
          if (!brand) throw new Error('Brand missing');
          if (brand.markets.some((m) => m.market === args.data.market)) {
            const dup = new Error('Unique constraint failed') as Error & { code: string };
            dup.code = 'P2002';
            throw dup;
          }
          const now = new Date();
          const created: StoredMarket = {
            id: `bm_${seq++}`,
            tenantId: args.data.tenantId,
            brandId: args.data.brandId,
            market: args.data.market,
            locale: args.data.locale,
            region: args.data.region,
            localBrandName: args.data.localBrandName,
            aliases: args.data.aliases,
            ownedDomains: args.data.ownedDomains,
            competitors: args.data.competitors,
            seedPrompts: args.data.seedPrompts,
            createdAt: now,
            updatedAt: now,
          };
          brand.markets.push(created);
          brand.updatedAt = now;
          return created;
        },
      ),
    },
  };

  return { prisma: { scoped }, brands, clear: () => brands.splice(0, brands.length) };
}

describe('BrandsService unit tests (M1 v2 scaffold)', () => {
  let activeTenantId: string | undefined = 'tenant_a';
  const store = createScopedStore(() => activeTenantId);
  const service = new BrandsService(
    store.prisma as unknown as PrismaService,
    new ComplianceService(),
  );

  beforeEach(() => {
    store.clear();
    activeTenantId = 'tenant_a';
    vi.clearAllMocks();
  });

  it('creates Brand + nested BrandMarkets with explicit tenantId, default locale/region, and normalized domains', async () => {
    const parsed = createBrandSchema.parse({
      name: '青松储能',
      category: '便携储能',
      markets: [
        {
          market: 'CN',
          ownedDomains: ['https://WWW.QingSong.cn/products'],
          competitors: [{ name: '竞品甲', domains: ['https://www.rival-a.cn/item'] }],
        },
        'GLOBAL',
      ],
    });

    const created = await service.create('tenant_a', 'user_a', parsed);
    expect(created.name).toBe('青松储能');
    expect(created.markets).toHaveLength(2);
    expect(created.markets[0]).toMatchObject({
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '青松储能',
      ownedDomains: ['qingsong.cn'],
    });
    expect(created.markets[1]).toMatchObject({
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: '青松储能',
    });

    const createCall = store.prisma.scoped.brand.create.mock.calls[0]?.[0];
    expect(createCall?.data.markets.create.every((m) => m.tenantId === 'tenant_a')).toBe(true);
  });

  it('maps duplicate brand name to 409 conflict and enforces tenant isolation on enableMarket', async () => {
    const parsed = createBrandSchema.parse({
      name: '独角兽NAS',
      category: '私有云',
      markets: ['CN'],
    });
    const created = await service.create('tenant_a', 'user_a', parsed);

    await expect(service.create('tenant_a', 'user_a', parsed)).rejects.toMatchObject({
      status: 409,
      code: BILLING_ERROR.CONFLICT,
    });

    await expect(
      service.enableMarket('tenant_a', 'user_a', created.id, 'CN', {
        aliases: [],
        ownedDomains: [],
        competitors: [],
        seedPrompts: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: BILLING_ERROR.CONFLICT,
    });

    const updated = await service.enableMarket('tenant_a', 'user_a', created.id, 'GLOBAL', {
      localBrandName: 'Unicorn NAS',
      aliases: [],
      ownedDomains: ['https://unicorn-nas.com'],
      competitors: [],
      seedPrompts: [],
    });
    expect(updated.markets.map((m) => m.market)).toEqual(['CN', 'GLOBAL']);
    expect(updated.markets[1]?.ownedDomains).toEqual(['unicorn-nas.com']);

    activeTenantId = 'tenant_b';
    await expect(
      service.enableMarket('tenant_b', 'user_b', created.id, 'GLOBAL', {
        aliases: [],
        ownedDomains: [],
        competitors: [],
        seedPrompts: [],
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: AUTH_ERROR.NOT_FOUND,
    });
    expect((await service.list()).items).toEqual([]);
  });

  it('rejects prohibited seedPrompts with 403/40302 in both create and enableMarket', async () => {
    const prohibitedBrand = createBrandSchema.parse({
      name: '合规测试品牌',
      category: '智能硬件',
      markets: [{ market: 'CN', seedPrompts: ['线上赌博平台推荐哪家好'] }],
    });
    await expect(service.create('tenant_a', 'user_a', prohibitedBrand)).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(store.brands).toHaveLength(0);

    const safeBrand = await service.create(
      'tenant_a',
      'user_a',
      createBrandSchema.parse({
        name: '安全品牌',
        category: '智能硬件',
        markets: ['CN'],
      }),
    );
    await expect(
      service.enableMarket('tenant_a', 'user_a', safeBrand.id, 'GLOBAL', {
        localBrandName: 'Safe Brand',
        aliases: [],
        ownedDomains: [],
        competitors: [],
        seedPrompts: ['哪里买电子烟便宜'],
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect((await service.list()).items[0]?.markets.map((m) => m.market)).toEqual(['CN']);
  });
});

describe('API v1/v2 URI versioning & BrandsController HTTP guards', () => {
  let app: INestApplication;
  let baseUrl: string;
  let jwtAccessSecret: string;
  const store = createScopedStore(() => currentTenantId());

  beforeAll(async () => {
    app = await createApiApp();
    jwtAccessSecret = parseEnv().JWT_ACCESS_SECRET;

    const authStore = app.get(PrismaAuthStore);
    vi.spyOn(authStore, 'findUserById').mockImplementation(async (userId: string) => {
      if (userId === 'u_active') {
        return {
          id: 'u_active',
          tenantId: 'tenant_active',
          username: 'active',
          passwordHash: 'hash',
          nickname: 'Active',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Active Tenant',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      if (userId === 'u_expired') {
        return {
          id: 'u_expired',
          tenantId: 'tenant_expired',
          username: 'expired',
          passwordHash: 'hash',
          nickname: 'Expired',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Expired Tenant',
          isActive: true,
          expiresAt: new Date(Date.now() - 86_400_000),
        };
      }
      return null;
    });
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.prisma.scoped as unknown as PrismaService['scoped'],
    );

    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    store.clear();
  });

  function makeAccessToken(userId: string, tenantId: string): string {
    const nowSec = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: userId,
        tid: tenantId,
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hash'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      jwtAccessSecret,
    );
  }

  it('serves /api/v1/health alongside /api/v2/brands and enforces auth, validation, and TenantActiveGuard', async () => {
    // 1. Retained v1 health route works
    const healthRes = await fetch(`${baseUrl}/api/v1/health`);
    expect(healthRes.status).toBe(200);

    // 2. Anonymous GET /api/v2/brands returns 401
    const anonRes = await fetch(`${baseUrl}/api/v2/brands`);
    expect(anonRes.status).toBe(401);
    const anonBody = (await anonRes.json()) as { code: number };
    expect(anonBody.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    // 3. Active tenant GET/POST /api/v2/brands & POST /api/v2/brands/:id/markets/GLOBAL
    const activeToken = makeAccessToken('u_active', 'tenant_active');

    const createRes = await fetch(`${baseUrl}/api/v2/brands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: '极简测试品牌',
        category: '智能硬件',
        markets: [{ market: 'CN', ownedDomains: ['https://example.cn'] }],
      }),
    });
    expect(createRes.status).toBe(200);
    const createdBody = (await createRes.json()) as {
      code: number;
      data: { id: string; markets: Array<{ market: string }> };
    };
    expect(createdBody.code).toBe(0);
    expect(createdBody.data.markets.map((m) => m.market)).toEqual(['CN']);

    const listRes = await fetch(`${baseUrl}/api/v2/brands`, {
      headers: { authorization: `Bearer ${activeToken}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { code: number; data: { items: unknown[] } };
    expect(listBody.data.items).toHaveLength(1);

    const enableRes = await fetch(
      `${baseUrl}/api/v2/brands/${createdBody.data.id}/markets/GLOBAL`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${activeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ localBrandName: 'Minimal Brand', ownedDomains: ['example.com'] }),
      },
    );
    expect(enableRes.status).toBe(200);
    const enableBody = (await enableRes.json()) as {
      code: number;
      data: { markets: Array<{ market: string }> };
    };
    expect(enableBody.data.markets.map((m) => m.market)).toEqual(['CN', 'GLOBAL']);

    // 4. Invalid market returns 400
    const badMarketRes = await fetch(`${baseUrl}/api/v2/brands/${createdBody.data.id}/markets/EU`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(badMarketRes.status).toBe(400);

    // 5. Expired tenant: GET succeeds (200), POST blocked (403 / 40301)
    const expiredToken = makeAccessToken('u_expired', 'tenant_expired');
    const expGet = await fetch(`${baseUrl}/api/v2/brands`, {
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(expGet.status).toBe(200);

    const expPost = await fetch(`${baseUrl}/api/v2/brands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${expiredToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '到期测试', category: '硬件', markets: ['CN'] }),
    });
    expect(expPost.status).toBe(403);
    const expBody = (await expPost.json()) as { code: number };
    expect(expBody.code).toBe(API_ERROR.TENANT_EXPIRED);

    // 6. Prohibited seedPrompts rejected with 403 / 40302 on both create and enableMarket
    const badSeedCreate = await fetch(`${baseUrl}/api/v2/brands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: '正常品牌名',
        category: '消费电子',
        markets: [{ market: 'CN', seedPrompts: ['线上赌博平台推荐哪家好'] }],
      }),
    });
    expect(badSeedCreate.status).toBe(403);
    const badSeedCreateBody = (await badSeedCreate.json()) as { code: number };
    expect(badSeedCreateBody.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

    const safeOnlyCn = await fetch(`${baseUrl}/api/v2/brands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: '海外校验品牌',
        category: '消费电子',
        markets: ['CN'],
      }),
    });
    expect(safeOnlyCn.status).toBe(200);
    const safeOnlyCnBody = (await safeOnlyCn.json()) as { data: { id: string } };

    const badSeedMarket = await fetch(
      `${baseUrl}/api/v2/brands/${safeOnlyCnBody.data.id}/markets/GLOBAL`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${activeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localBrandName: 'Safe Global',
          seedPrompts: ['哪里买电子烟便宜'],
        }),
      },
    );
    expect(badSeedMarket.status).toBe(403);
    const badSeedMarketBody = (await badSeedMarket.json()) as { code: number };
    expect(badSeedMarketBody.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
  });
});
