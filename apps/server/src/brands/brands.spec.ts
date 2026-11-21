import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR, createBrandSchema, parseEnv } from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { QuotaService } from '../billing/quota.service';
import { createApiApp } from '../common/create-api-app';
import { ComplianceService, type AuditWriter } from '../infra/compliance';
import { StorageService } from '../infra/storage';
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
  truthAgreementIp: string | null;
  createdAt: Date;
  updatedAt: Date;
  markets: StoredMarket[];
};

type StoredMedia = {
  id: string;
  tenantId: string;
  brandId: string;
  objectKey: string;
  thumbKey: string | null;
  bytes: number;
};

function createBrandTestStore(getTenantId: () => string | undefined) {
  const brands: StoredBrand[] = [];
  const media: StoredMedia[] = [];
  let seq = 1;

  const presentRow = (b: StoredBrand) => ({
    ...b,
    markets: [...b.markets].sort((x, y) => x.market.localeCompare(y.market)),
    _count: {
      facts: 0,
      mediaAssets: media.filter((m) => m.brandId === b.id && m.tenantId === b.tenantId).length,
    },
  });

  const scoped = {
    brand: {
      findMany: vi.fn(async () => {
        const tid = getTenantId();
        return brands
          .filter((b) => !tid || b.tenantId === tid)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map(presentRow);
      }),
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        const found = brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid));
        return found ? presentRow(found) : null;
      }),
      create: vi.fn(
        async (args: {
          data: {
            tenantId: string;
            name: string;
            category: string;
            truthAgreementSignedAt?: Date;
            truthAgreementIp?: string | null;
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
            truthAgreementIp: args.data.truthAgreementIp ?? null,
            createdAt: now,
            updatedAt: now,
            markets: nestedMarkets,
          };
          brands.push(record);
          return presentRow(record);
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: {
            name?: string;
            category?: string;
            truthAgreementSignedAt?: Date;
            truthAgreementIp?: string | null;
          };
        }) => {
          const tid = getTenantId();
          const found = brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid));
          if (!found) {
            const err = new Error('Not found') as Error & { code: string };
            err.code = 'P2025';
            throw err;
          }
          if (
            args.data.name !== undefined &&
            brands.some(
              (b) =>
                b.tenantId === found.tenantId && b.id !== found.id && b.name === args.data.name,
            )
          ) {
            const dup = new Error('Unique constraint failed') as Error & { code: string };
            dup.code = 'P2002';
            throw dup;
          }
          if (args.data.name !== undefined) found.name = args.data.name;
          if (args.data.category !== undefined) found.category = args.data.category;
          if (args.data.truthAgreementSignedAt !== undefined) {
            found.truthAgreementSignedAt = args.data.truthAgreementSignedAt;
          }
          if (args.data.truthAgreementIp !== undefined) {
            found.truthAgreementIp = args.data.truthAgreementIp;
          }
          found.updatedAt = new Date();
          return presentRow(found);
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
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<Omit<StoredMarket, 'id' | 'tenantId' | 'brandId' | 'market' | 'createdAt'>>;
        }) => {
          const tid = getTenantId();
          for (const brand of brands) {
            if (tid && brand.tenantId !== tid) continue;
            const market = brand.markets.find((m) => m.id === args.where.id);
            if (market) {
              Object.assign(market, args.data, { updatedAt: new Date() });
              brand.updatedAt = new Date();
              return market;
            }
          }
          throw new Error('Market not found');
        },
      ),
    },
  };

  let activeRunCount = 0;
  let activeBatchCount = 0;
  let runningObsCount = 0;

  const base = {
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => {
      const tx = {
        brand: {
          findFirst: async (args: { where: { id: string; tenantId: string } }) =>
            brands.find((b) => b.id === args.where.id && b.tenantId === args.where.tenantId) ??
            null,
          deleteMany: async (args: { where: { id: string; tenantId: string } }) => {
            const idx = brands.findIndex(
              (b) => b.id === args.where.id && b.tenantId === args.where.tenantId,
            );
            if (idx === -1) return { count: 0 };
            brands.splice(idx, 1);
            for (let i = media.length - 1; i >= 0; i -= 1) {
              if (
                media[i]!.brandId === args.where.id &&
                media[i]!.tenantId === args.where.tenantId
              ) {
                media.splice(i, 1);
              }
            }
            return { count: 1 };
          },
        },
        visibilityRun: {
          count: vi.fn(async () => activeRunCount),
        },
        geoBatchJob: {
          count: vi.fn(async () => activeBatchCount),
        },
        visibilityObservation: {
          count: vi.fn(async () => runningObsCount),
        },
        brandMediaAsset: {
          findMany: async (args: { where: { tenantId: string; brandId: string } }) =>
            media.filter(
              (m) => m.tenantId === args.where.tenantId && m.brandId === args.where.brandId,
            ),
        },
      };
      return fn(tx);
    }),
  };

  return {
    prisma: { scoped, base },
    brands,
    media,
    setActiveCounts: (counts: { runs?: number; batches?: number; runningObs?: number }) => {
      if (counts.runs !== undefined) activeRunCount = counts.runs;
      if (counts.batches !== undefined) activeBatchCount = counts.batches;
      if (counts.runningObs !== undefined) runningObsCount = counts.runningObs;
    },
    clear: () => {
      brands.splice(0, brands.length);
      media.splice(0, media.length);
      activeRunCount = 0;
      activeBatchCount = 0;
      runningObsCount = 0;
    },
  };
}

describe('BrandsService unit tests (F6 full CRUD & dual-market identity)', () => {
  let activeTenantId: string | undefined = 'tenant_a';
  const store = createBrandTestStore(() => activeTenantId);
  const auditWriter: AuditWriter = { write: vi.fn(async () => undefined) };
  const quotaRelease = vi.fn(async () => ({ used: 0n, limit: 1024n }));
  const storageDelete = vi.fn(async () => undefined);
  const service = new BrandsService(
    store.prisma as unknown as PrismaService,
    new ComplianceService(auditWriter),
    { release: quotaRelease } as unknown as QuotaService,
    { delete: storageDelete } as unknown as StorageService,
  );

  beforeEach(() => {
    store.clear();
    activeTenantId = 'tenant_a';
    vi.clearAllMocks();
  });

  it('creates Brand + BrandMarkets with category-aware seedPrompts (#313), top-level aliases, and truthAgreementIp', async () => {
    const parsed = createBrandSchema.parse({
      name: '青松储能',
      category: '便携储能',
      aliases: ['QingSong Power'],
      markets: [
        {
          market: 'CN',
          ownedDomains: ['https://WWW.QingSong.cn/products'],
          competitors: [{ name: '正浩', domains: ['https://www.ecoflow.com/cn'] }],
        },
        'GLOBAL',
      ],
      truthAgreed: true,
    });

    const created = await service.create('tenant_a', 'user_a', parsed, '203.0.113.10');
    expect(created.name).toBe('青松储能');
    expect(created.truthAgreementSignedAt).not.toBeNull();
    expect(store.brands[0]?.truthAgreementIp).toBe('203.0.113.10');
    expect(created.markets).toHaveLength(2);
    expect(created.markets[0]).toMatchObject({
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      aliases: ['QingSong Power'],
      ownedDomains: ['qingsong.cn'],
    });
    expect(created.markets[0]!.seedPrompts.length).toBeGreaterThanOrEqual(5);
    expect(created.markets[0]!.seedPrompts.every((p) => !/源头厂家|批发|OEM/.test(p))).toBe(true);
    expect(created.markets[1]!.seedPrompts.length).toBeGreaterThanOrEqual(5);
    expect(created.markets[1]!.seedPrompts.some((p) => /portable power station/i.test(p))).toBe(
      true,
    );
    expect(
      created.markets[1]!.seedPrompts.every((p) => !/factory|wholesale|\boem\b/i.test(p)),
    ).toBe(true);
  });

  it('supports getById, update, partial updateMarket, resolveBrandMarket, and compliance audit logging', async () => {
    const created = await service.create(
      'tenant_a',
      'user_a',
      createBrandSchema.parse({
        name: '独角兽NAS',
        category: '私有云',
        markets: [{ market: 'CN', ownedDomains: ['unicorn.cn'] }],
      }),
    );

    const fetched = await service.getById(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.factCount).toBe(0);
    expect(fetched.mediaCount).toBe(0);

    const singleResolved = await service.resolveBrandMarket(created.id);
    expect(singleResolved.market.market).toBe('CN');

    const updatedBrand = await service.update('tenant_a', 'user_a', created.id, {
      name: '独角兽存储',
    });
    expect(updatedBrand.name).toBe('独角兽存储');

    const enabledGlobal = await service.enableMarket('tenant_a', 'user_a', created.id, 'GLOBAL', {
      localBrandName: 'Unicorn Storage',
      aliases: [],
      ownedDomains: ['unicorn.io'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: [],
    });
    expect(enabledGlobal.markets.map((m) => m.market)).toEqual(['CN', 'GLOBAL']);
    expect(enabledGlobal.markets[1]!.seedPrompts.some((p) => p.includes('Synology'))).toBe(true);

    // Ambiguous dual-market resolution without explicit market -> 400
    await expect(service.resolveBrandMarket(created.id)).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });
    const explicitResolved = await service.resolveBrandMarket(created.id, 'GLOBAL');
    expect(explicitResolved.market.localBrandName).toBe('Unicorn Storage');

    // Partial updateMarket preserves ownedDomains & competitors
    const patchedMarket = await service.updateMarket('tenant_a', 'user_a', created.id, 'GLOBAL', {
      localBrandName: 'Unicorn Cloud',
    });
    const globalMarket = patchedMarket.markets.find((m) => m.market === 'GLOBAL')!;
    expect(globalMarket.localBrandName).toBe('Unicorn Cloud');
    expect(globalMarket.ownedDomains).toEqual(['unicorn.io']);
    expect(globalMarket.competitors).toHaveLength(1);

    // Prohibited industry on update logs audit event and throws 403/40302
    await expect(
      service.update('tenant_a', 'user_a', created.id, { category: '线上赌博平台' }),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(auditWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_a',
        userId: 'user_a',
        action: 'forbidden_blocked',
      }),
    );

    // Cross-tenant isolation -> 404
    activeTenantId = 'tenant_b';
    await expect(service.getById(created.id)).rejects.toMatchObject({
      status: 404,
      code: AUTH_ERROR.NOT_FOUND,
    });
    await expect(
      service.updateMarket('tenant_b', 'user_b', created.id, 'CN', { localBrandName: 'Hack' }),
    ).rejects.toMatchObject({
      status: 404,
      code: AUTH_ERROR.NOT_FOUND,
    });
  });

  it('atomically deletes Brand, releases exact STORAGE_BYTES quota, and removes storage objects', async () => {
    const created = await service.create(
      'tenant_a',
      'user_a',
      createBrandSchema.parse({ name: '待删品牌', category: '智能硬件', markets: ['CN'] }),
    );
    store.media.push(
      {
        id: 'm1',
        tenantId: 'tenant_a',
        brandId: created.id,
        objectKey: 'tenants/tenant_a/brand-media-1.jpg',
        thumbKey: 'tenants/tenant_a/brand-media-1-thumb.jpg',
        bytes: 4096,
      },
      {
        id: 'm2',
        tenantId: 'tenant_a',
        brandId: created.id,
        objectKey: 'tenants/tenant_a/brand-media-2.jpg',
        thumbKey: null,
        bytes: 2048,
      },
    );

    const res = await service.remove('tenant_a', created.id);
    expect(res).toEqual({ deleted: 1, id: created.id, releasedBytes: 6144 });
    expect(quotaRelease).toHaveBeenCalledWith('tenant_a', 'STORAGE_BYTES', 6144, expect.anything());
    expect(storageDelete).toHaveBeenCalledWith('tenant_a', 'brand-media-1.jpg');
    expect(storageDelete).toHaveBeenCalledWith('tenant_a', 'brand-media-1-thumb.jpg');
    expect(storageDelete).toHaveBeenCalledWith('tenant_a', 'brand-media-2.jpg');

    await expect(service.remove('tenant_a', created.id)).rejects.toMatchObject({
      status: 404,
      code: AUTH_ERROR.NOT_FOUND,
    });
  });

  it('blocks deleting a brand while active VisibilityRun or GeoBatchJob exists (B-09)', async () => {
    const created = await service.create(
      'tenant_a',
      'u_1',
      {
        name: '活动任务品牌',
        category: '家用 NAS',
        aliases: [],
        ownedDomains: ['active-brand.example'],
        competitors: [],
        markets: [
          {
            market: 'CN',
            aliases: [],
            ownedDomains: ['active-brand.example'],
            competitors: [],
            seedPrompts: [],
          },
        ],
      },
      null,
    );

    store.setActiveCounts({ runs: 1, batches: 0 });
    await expect(service.remove('tenant_a', created.id)).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });

    store.setActiveCounts({ runs: 0, batches: 1, runningObs: 0 });
    await expect(service.remove('tenant_a', created.id)).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });

    // B-12: CANCELLED run with in-flight RUNNING observation must still block brand deletion
    store.setActiveCounts({ runs: 0, batches: 0, runningObs: 1 });
    await expect(service.remove('tenant_a', created.id)).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });

    store.setActiveCounts({ runs: 0, batches: 0, runningObs: 0 });
    const removed = await service.remove('tenant_a', created.id);
    expect(removed.deleted).toBe(1);
  });
});

describe('API v1/v2 URI versioning & BrandsController HTTP CRUD + Guard Matrix', () => {
  let app: INestApplication;
  let baseUrl: string;
  let jwtAccessSecret: string;
  const store = createBrandTestStore(() => currentTenantId());

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
      if (userId === 'u_inactive') {
        return {
          id: 'u_inactive',
          tenantId: 'tenant_inactive',
          username: 'inactive',
          passwordHash: 'hash',
          nickname: 'Inactive',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Inactive Tenant',
          isActive: false,
          expiresAt: new Date(Date.now() + 86_400_000),
        };
      }
      return null;
    });
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.prisma.scoped as unknown as PrismaService['scoped'],
    );
    vi.spyOn(prismaService, 'base', 'get').mockReturnValue(
      store.prisma.base as unknown as PrismaService['base'],
    );

    const quotaService = app.get(QuotaService);
    vi.spyOn(quotaService, 'release').mockResolvedValue({ used: 0n, limit: 1024n });

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

  it('completes full CRUD round-trip and enforces guard, validation, and compliance matrices', async () => {
    const healthRes = await fetch(`${baseUrl}/api/v1/health`);
    expect(healthRes.status).toBe(200);

    const anonRes = await fetch(`${baseUrl}/api/v2/brands`);
    expect(anonRes.status).toBe(401);

    const activeToken = makeAccessToken('u_active', 'tenant_active');
    const authHeaders = {
      authorization: `Bearer ${activeToken}`,
      'content-type': 'application/json',
    };

    // POST /api/v2/brands
    const createRes = await fetch(`${baseUrl}/api/v2/brands`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: '极简测试品牌',
        category: '家用NAS',
        markets: [{ market: 'CN', ownedDomains: ['https://www.example.cn/docs'] }],
      }),
    });
    expect(createRes.status).toBe(200);
    const createdBody = (await createRes.json()) as {
      code: number;
      data: { id: string; markets: Array<{ market: string; ownedDomains: string[] }> };
    };
    expect(createdBody.code).toBe(0);
    const brandId = createdBody.data.id;
    expect(createdBody.data.markets[0]?.ownedDomains).toEqual(['example.cn']);

    // GET /api/v2/brands/:id
    const getRes = await fetch(`${baseUrl}/api/v2/brands/${brandId}`, {
      headers: { authorization: `Bearer ${activeToken}` },
    });
    expect(getRes.status).toBe(200);

    // PATCH /api/v2/brands/:id
    const patchRes = await fetch(`${baseUrl}/api/v2/brands/${brandId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ name: '极简测试品牌Pro' }),
    });
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as { data: { name: string } };
    expect(patchedBody.data.name).toBe('极简测试品牌Pro');

    // POST /api/v2/brands/:id/markets/GLOBAL
    const enableRes = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/GLOBAL`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ localBrandName: 'Minimal Pro', ownedDomains: ['example.com'] }),
    });
    expect(enableRes.status).toBe(200);

    // PATCH /api/v2/brands/:id/markets/GLOBAL
    const patchMarketRes = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/GLOBAL`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        competitors: [{ name: 'Synology', domains: ['https://www.synology.com'] }],
      }),
    });
    expect(patchMarketRes.status).toBe(200);
    const patchMarketBody = (await patchMarketRes.json()) as {
      data: { markets: Array<{ market: string; ownedDomains: string[]; competitors: unknown[] }> };
    };
    const globalM = patchMarketBody.data.markets.find((m) => m.market === 'GLOBAL');
    expect(globalM?.ownedDomains).toEqual(['example.com']);
    expect(globalM?.competitors).toHaveLength(1);

    // Validation: 11 competitors -> 400, invalid domain -> 400, empty PATCH -> 400, bad market -> 400
    const tooManyComp = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/CN`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        competitors: Array.from({ length: 11 }, (_, i) => ({ name: `C${i + 1}`, domains: [] })),
      }),
    });
    expect(tooManyComp.status).toBe(400);

    const badDomain = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/CN`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ ownedDomains: ['not-a-domain'] }),
    });
    expect(badDomain.status).toBe(400);

    const emptyPatch = await fetch(`${baseUrl}/api/v2/brands/${brandId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);

    const badMarket = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/EU`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ localBrandName: 'EU' }),
    });
    expect(badMarket.status).toBe(400);

    // Compliance: prohibited content -> 403 / 40302
    const forbiddenPatch = await fetch(`${baseUrl}/api/v2/brands/${brandId}/markets/CN`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ seedPrompts: ['线上赌博平台推荐哪家好'] }),
    });
    expect(forbiddenPatch.status).toBe(403);
    expect(((await forbiddenPatch.json()) as { code: number }).code).toBe(
      API_ERROR.FORBIDDEN_INDUSTRY,
    );

    // Expired tenant guard matrix: GET 200, all write routes 403 / 40301
    const expiredToken = makeAccessToken('u_expired', 'tenant_expired');
    const expHeaders = {
      authorization: `Bearer ${expiredToken}`,
      'content-type': 'application/json',
    };
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands`, {
          headers: { authorization: `Bearer ${expiredToken}` },
        })
      ).status,
    ).toBe(200);
    for (const [method, path, payload] of [
      ['POST', '/api/v2/brands', { name: '到期', category: '硬件', markets: ['CN'] }],
      ['PATCH', `/api/v2/brands/${brandId}`, { name: '到期改名' }],
      ['DELETE', `/api/v2/brands/${brandId}`, undefined],
      ['POST', `/api/v2/brands/${brandId}/markets/GLOBAL`, {}],
      ['PATCH', `/api/v2/brands/${brandId}/markets/CN`, { localBrandName: 'X' }],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: expHeaders,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      expect(res.status, `${method} ${path} should be 403 for expired tenant`).toBe(403);
      expect(((await res.json()) as { code: number }).code).toBe(API_ERROR.TENANT_EXPIRED);
    }

    // Inactive tenant: both GET and POST blocked with 403/40301
    const inactiveToken = makeAccessToken('u_inactive', 'tenant_inactive');
    expect(
      (
        await fetch(`${baseUrl}/api/v2/brands`, {
          headers: { authorization: `Bearer ${inactiveToken}` },
        })
      ).status,
    ).toBe(403);

    // DELETE /api/v2/brands/:id -> then GET returns 404
    const delRes = await fetch(`${baseUrl}/api/v2/brands/${brandId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${activeToken}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { data: { deleted: number; id: string } };
    expect(delBody.data).toMatchObject({ deleted: 1, id: brandId });

    const afterDelGet = await fetch(`${baseUrl}/api/v2/brands/${brandId}`, {
      headers: { authorization: `Bearer ${activeToken}` },
    });
    expect(afterDelGet.status).toBe(404);
  });
});
