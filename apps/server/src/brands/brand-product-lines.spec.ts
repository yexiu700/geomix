import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  BRAND_MAX_PRODUCT_LINES,
  parseEnv,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { PrismaAuthStore } from '../auth/prisma-auth.store';
import { signToken } from '../auth/token';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, type IsolatedTestContext } from '../common/test-db';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

type StoredMarket = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  localCategory: string | null;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  seedPrompts: string[];
  supportedLocales: string[];
  controlPrompts: string[];
  monthlyRetestPointCap: number | null;
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

type StoredProductLine = {
  id: string;
  tenantId: string;
  brandId: string;
  name: string;
  localNamesJson: unknown;
  category: string;
  localCategoriesJson: unknown;
  seedPromptsJson: unknown;
  competitorsJson: unknown;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

type StoredFact = {
  id: string;
  tenantId: string;
  brandId: string;
  productLineId: string | null;
  slot: string;
  title: string;
  content: string;
  sourceType: string;
  sourceUrl: string | null;
  indexStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

function createProductLineTestStore(getTenantId: () => string | undefined) {
  const brands: StoredBrand[] = [];
  const productLines: StoredProductLine[] = [];
  const facts: StoredFact[] = [];
  let seq = 1;

  const presentBrand = (b: StoredBrand) => ({
    ...b,
    markets: [...b.markets].sort((x, y) => x.market.localeCompare(y.market)),
    _count: {
      facts: facts.filter((f) => f.brandId === b.id && f.tenantId === b.tenantId).length,
      mediaAssets: 0,
    },
  });

  const makeDelegates = () => ({
    brand: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const tid = getTenantId();
        const found = brands.find((b) => b.id === args.where.id && (!tid || b.tenantId === tid));
        return found ? presentBrand(found) : null;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id: string };
          data: {
            id?: string;
            truthAgreementSignedAt?: Date;
            truthAgreementIp?: string | null;
          };
        }) => {
          const tid = getTenantId();
          const b = brands.find((x) => x.id === args.where.id && (!tid || x.tenantId === tid));
          if (!b) return { count: 0 };
          if (args.data.truthAgreementSignedAt !== undefined) {
            b.truthAgreementSignedAt = args.data.truthAgreementSignedAt;
          }
          if (args.data.truthAgreementIp !== undefined) {
            b.truthAgreementIp = args.data.truthAgreementIp;
          }
          return { count: 1 };
        },
      ),
    },
    brandMarket: {
      update: vi.fn(async (args: { where: { id: string }; data: Partial<StoredMarket> }) => {
        const tid = getTenantId();
        for (const b of brands) {
          if (tid && b.tenantId !== tid) continue;
          const m = b.markets.find((row) => row.id === args.where.id);
          if (m) {
            Object.assign(m, args.data, { updatedAt: new Date() });
            return m;
          }
        }
        throw new Error('Market not found');
      }),
    },
    brandProductLine: {
      findMany: vi.fn(async (args: { where: { brandId: string; id?: { in: string[] } } }) => {
        const tid = getTenantId();
        return productLines
          .filter((pl) => {
            if (tid && pl.tenantId !== tid) return false;
            if (pl.brandId !== args.where.brandId) return false;
            if (args.where.id && !args.where.id.in.includes(pl.id)) return false;
            return true;
          })
          .sort(
            (a, b) =>
              a.sortOrder - b.sortOrder ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          );
      }),
      findFirst: vi.fn(async (args: { where: { id: string; brandId?: string } }) => {
        const tid = getTenantId();
        return (
          productLines.find(
            (pl) =>
              pl.id === args.where.id &&
              (!args.where.brandId || pl.brandId === args.where.brandId) &&
              (!tid || pl.tenantId === tid),
          ) ?? null
        );
      }),
      count: vi.fn(async (args: { where: { brandId: string } }) => {
        const tid = getTenantId();
        return productLines.filter(
          (pl) => pl.brandId === args.where.brandId && (!tid || pl.tenantId === tid),
        ).length;
      }),
      create: vi.fn(
        async (args: { data: Omit<StoredProductLine, 'id' | 'createdAt' | 'updatedAt'> }) => {
          const tid = getTenantId() ?? args.data.tenantId;
          if (
            productLines.some(
              (pl) => pl.brandId === args.data.brandId && pl.name === args.data.name,
            )
          ) {
            const dup = new Error('Unique constraint failed') as Error & { code: string };
            dup.code = 'P2002';
            throw dup;
          }
          const now = new Date();
          const row: StoredProductLine = {
            id: `pl_${seq++}`,
            ...args.data,
            tenantId: tid,
            createdAt: now,
            updatedAt: now,
          };
          productLines.push(row);
          return row;
        },
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<StoredProductLine> }) => {
        const tid = getTenantId();
        const target = productLines.find(
          (pl) => pl.id === args.where.id && (!tid || pl.tenantId === tid),
        );
        if (!target) throw new Error('Not found');
        if (
          args.data.name !== undefined &&
          productLines.some(
            (pl) =>
              pl.brandId === target.brandId && pl.name === args.data.name && pl.id !== target.id,
          )
        ) {
          const dup = new Error('Unique constraint failed') as Error & { code: string };
          dup.code = 'P2002';
          throw dup;
        }
        Object.assign(target, args.data, { updatedAt: new Date() });
        return target;
      }),
      deleteMany: vi.fn(async (args: { where: { id: string; brandId: string } }) => {
        const tid = getTenantId();
        const idx = productLines.findIndex(
          (pl) =>
            pl.id === args.where.id &&
            pl.brandId === args.where.brandId &&
            (!tid || pl.tenantId === tid),
        );
        if (idx === -1) return { count: 0 };
        const [removed] = productLines.splice(idx, 1);
        // Simulate PostgreSQL ON DELETE SET NULL on BrandFact
        for (const fact of facts) {
          if (fact.productLineId === removed!.id) {
            fact.productLineId = null;
          }
        }
        return { count: 1 };
      }),
    },
    brandFact: {
      findMany: vi.fn(
        async (args: {
          where: {
            brandId: string;
            OR?: Array<{ productLineId: string | null }>;
          };
        }) => {
          const tid = getTenantId();
          return facts.filter((f) => {
            if (f.brandId !== args.where.brandId) return false;
            if (tid && f.tenantId !== tid) return false;
            if (args.where.OR) {
              return args.where.OR.some(
                (clause) => (f.productLineId ?? null) === clause.productLineId,
              );
            }
            return true;
          });
        },
      ),
      create: vi.fn(async (args: { data: Omit<StoredFact, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const now = new Date();
        const row: StoredFact = {
          id: `fact_${seq++}`,
          ...args.data,
          productLineId: args.data.productLineId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        facts.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id?: string | { in: string[] }; brandId: string; indexStatus?: string };
          data: Partial<StoredFact>;
        }) => {
          const tid = getTenantId();
          let count = 0;
          for (const f of facts) {
            if (f.brandId !== args.where.brandId) continue;
            if (tid && f.tenantId !== tid) continue;
            if (args.where.indexStatus && f.indexStatus !== args.where.indexStatus) continue;
            if (typeof args.where.id === 'string' && f.id !== args.where.id) continue;
            if (
              args.where.id &&
              typeof args.where.id === 'object' &&
              !args.where.id.in.includes(f.id)
            ) {
              continue;
            }
            Object.assign(f, args.data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
    },
    brandFactChunk: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  });

  const delegates = makeDelegates();
  const scoped = {
    ...delegates,
    $transaction: vi.fn(async <T>(fn: (tx: typeof delegates) => Promise<T>) => fn(delegates)),
  };

  return {
    scoped,
    brands,
    productLines,
    facts,
    seedBrand: (b: StoredBrand) => brands.push(b),
    clear: () => {
      brands.splice(0, brands.length);
      productLines.splice(0, productLines.length);
      facts.splice(0, facts.length);
    },
  };
}

describe('BrandProductLines, BrandMarket monthlyRetestPointCap & Multi-Line Facts HTTP v2', () => {
  let app: INestApplication;
  let baseUrl: string;
  let jwtAccessSecret: string;
  let store: ReturnType<typeof createProductLineTestStore>;
  const savedEnv = { ...process.env };

  const makeToken = (userId: string, tenantId: string): string => {
    const now = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: userId,
        tid: tenantId,
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hash'),
        lms: Date.now(),
        iat: now,
        exp: now + 3600,
      },
      jwtAccessSecret,
    );
  };

  beforeAll(async () => {
    process.env.LLM_PROVIDER = 'fake';
    process.env.ALLOW_FAKE_OUTPUT = 'true';

    app = await createApiApp();
    jwtAccessSecret = parseEnv().JWT_ACCESS_SECRET;

    store = createProductLineTestStore(() => currentTenantId());
    const authStore = app.get(PrismaAuthStore);
    vi.spyOn(authStore, 'findUserById').mockImplementation(async (userId: string) => {
      if (userId === 'u_a') {
        return {
          id: 'u_a',
          tenantId: 'tenant_a',
          username: 'user_a',
          passwordHash: 'hash',
          nickname: 'A',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant A',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000 * 30),
        };
      }
      if (userId === 'u_b') {
        return {
          id: 'u_b',
          tenantId: 'tenant_b',
          username: 'user_b',
          passwordHash: 'hash',
          nickname: 'B',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant B',
          isActive: true,
          expiresAt: new Date(Date.now() + 86_400_000 * 30),
        };
      }
      if (userId === 'u_exp') {
        return {
          id: 'u_exp',
          tenantId: 'tenant_exp',
          username: 'user_exp',
          passwordHash: 'hash',
          nickname: 'Exp',
          role: 'MERCHANT',
          uiPrefs: null,
          tenantName: 'Tenant Exp',
          isActive: true,
          expiresAt: new Date(Date.now() - 86_400_000),
        };
      }
      return null;
    });
    vi.spyOn(authStore, 'latestRevokeAt').mockResolvedValue(null);

    const prismaService = app.get(PrismaService);
    vi.spyOn(prismaService, 'scoped', 'get').mockReturnValue(
      store.scoped as unknown as PrismaService['scoped'],
    );

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    store.clear();
    const now = new Date();
    store.seedBrand({
      id: 'brand_a1',
      tenantId: 'tenant_a',
      name: 'NovaTech',
      category: '智能硬件',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
      markets: [
        {
          id: 'bm_a1_global',
          tenantId: 'tenant_a',
          brandId: 'brand_a1',
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: 'NovaTech',
          localCategory: 'Smart Hardware',
          aliases: ['Nova'],
          ownedDomains: ['novatech.example'],
          competitors: [{ name: 'GenericComp', aliases: [], domains: ['generic.example'] }],
          seedPrompts: ['Best smart hardware 2026'],
          supportedLocales: ['en-US'],
          controlPrompts: [],
          monthlyRetestPointCap: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    store.seedBrand({
      id: 'brand_a2',
      tenantId: 'tenant_a',
      name: 'NovaTech Sub',
      category: '智能硬件',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
      markets: [],
    });
    store.seedBrand({
      id: 'brand_exp',
      tenantId: 'tenant_exp',
      name: 'ExpiredBrand',
      category: '智能硬件',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
      markets: [],
    });
  });

  async function req(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: { code: number; msg: string; data: unknown } }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      body: (await res.json()) as { code: number; msg: string; data: unknown },
    };
  }

  it('supports full product-line CRUD sorted by sortOrder ASC, enforces max 20, duplicate 409, and empty PATCH 400', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');

    const createB = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: '星曜 NAS 系列',
      localNamesJson: { GLOBAL: 'HeliosNAS' },
      category: '家庭 NAS',
      localCategoriesJson: { GLOBAL: 'Home NAS' },
      seedPromptsJson: { GLOBAL: ['Best home NAS 2026'] },
      competitorsJson: { GLOBAL: [{ name: 'Synology', domains: ['synology.example'] }] },
      sortOrder: 2,
    });
    expect(createB.status).toBe(200);
    expect(createB.body.code).toBe(0);
    const lineB = createB.body.data as { id: string; name: string; sortOrder: number };

    const createA = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: '星曜储能系列',
      localNamesJson: { GLOBAL: 'HeliosPower' },
      category: '便携储能电源',
      localCategoriesJson: { GLOBAL: 'Portable Power Station' },
      seedPromptsJson: { GLOBAL: ['Best portable power station 2026'] },
      competitorsJson: { GLOBAL: [{ name: 'Jackery', domains: ['jackery.example'] }] },
      sortOrder: 1,
    });
    expect(createA.status).toBe(200);
    const lineA = createA.body.data as { id: string; name: string; sortOrder: number };

    // GET sorted by sortOrder ASC
    const listRes = await req('GET', '/api/v2/brands/brand_a1/product-lines', tokenA);
    expect(listRes.status).toBe(200);
    const listed = (listRes.body.data as { items: Array<{ id: string }> }).items;
    expect(listed.map((i) => i.id)).toEqual([lineA.id, lineB.id]);

    // Duplicate name on POST -> 409
    const dupPost = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: '星曜储能系列',
      category: '储能',
    });
    expect(dupPost.status).toBe(409);
    expect(dupPost.body.code).toBe(BILLING_ERROR.CONFLICT);

    // Duplicate name on PATCH -> 409
    const dupPatch = await req(
      'PATCH',
      `/api/v2/brands/brand_a1/product-lines/${lineB.id}`,
      tokenA,
      { name: '星曜储能系列' },
    );
    expect(dupPatch.status).toBe(409);

    // Empty PATCH {} -> 400
    const emptyPatch = await req(
      'PATCH',
      `/api/v2/brands/brand_a1/product-lines/${lineA.id}`,
      tokenA,
      {},
    );
    expect(emptyPatch.status).toBe(400);
    expect(emptyPatch.body.code).toBe(API_ERROR.BAD_REQUEST);

    // Valid PATCH
    const updated = await req(
      'PATCH',
      `/api/v2/brands/brand_a1/product-lines/${lineA.id}`,
      tokenA,
      { localCategoriesJson: { GLOBAL: 'Solar Power Station' } },
    );
    expect(updated.status).toBe(200);
    expect(
      (updated.body.data as { localCategoriesJson: Record<string, string> }).localCategoriesJson,
    ).toEqual({
      GLOBAL: 'Solar Power Station',
    });

    // Fill up to BRAND_MAX_PRODUCT_LINES (20) -> 20th succeeds, 21st returns 400
    for (let i = 3; i <= BRAND_MAX_PRODUCT_LINES; i += 1) {
      const res = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
        name: `Line ${i}`,
        category: `Cat ${i}`,
        sortOrder: i,
      });
      expect(res.status).toBe(200);
    }
    const overCap = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'Line 21',
      category: 'Cat 21',
    });
    expect(overCap.status).toBe(400);
    expect(overCap.body.code).toBe(API_ERROR.BAD_REQUEST);

    // DELETE succeeds
    const deleted = await req(
      'DELETE',
      `/api/v2/brands/brand_a1/product-lines/${lineA.id}`,
      tokenA,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ deleted: 1, id: lineA.id });
  });

  it('enforces cross-tenant 404, cross-brand 404, and TenantActiveGuard 403/40301', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    const tokenB = makeToken('u_b', 'tenant_b');
    const tokenExp = makeToken('u_exp', 'tenant_exp');

    const created = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'Line A1',
      category: 'Power',
    });
    const lineA1 = (created.body.data as { id: string }).id;

    // Cross-tenant GET/POST/PATCH/DELETE -> 404
    expect((await req('GET', '/api/v2/brands/brand_a1/product-lines', tokenB)).status).toBe(404);
    expect(
      (
        await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenB, {
          name: 'Injected',
          category: 'X',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req('PATCH', `/api/v2/brands/brand_a1/product-lines/${lineA1}`, tokenB, {
          name: 'Hacked',
        })
      ).status,
    ).toBe(404);
    expect(
      (await req('DELETE', `/api/v2/brands/brand_a1/product-lines/${lineA1}`, tokenB)).status,
    ).toBe(404);

    // Cross-brand (same tenant, brand_a2) PATCH/DELETE -> 404
    expect(
      (
        await req('PATCH', `/api/v2/brands/brand_a2/product-lines/${lineA1}`, tokenA, {
          name: 'CrossBrand',
        })
      ).status,
    ).toBe(404);
    expect(
      (await req('DELETE', `/api/v2/brands/brand_a2/product-lines/${lineA1}`, tokenA)).status,
    ).toBe(404);

    // Expired tenant writes -> 403 / 40301
    const expPost = await req('POST', '/api/v2/brands/brand_exp/product-lines', tokenExp, {
      name: 'Exp Line',
      category: 'Cat',
    });
    expect(expPost.status).toBe(403);
    expect(expPost.body.code).toBe(API_ERROR.TENANT_EXPIRED);

    const expPatch = await req(
      'PATCH',
      `/api/v2/brands/brand_exp/product-lines/${lineA1}`,
      tokenExp,
      { name: 'Exp' },
    );
    expect(expPatch.status).toBe(403);
    expect(expPatch.body.code).toBe(API_ERROR.TENANT_EXPIRED);

    const expDel = await req(
      'DELETE',
      `/api/v2/brands/brand_exp/product-lines/${lineA1}`,
      tokenExp,
    );
    expect(expDel.status).toBe(403);
    expect(expDel.body.code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('validates and persists BrandMarket.monthlyRetestPointCap (rejects 0/-5/12.5, sets 50, clears to null)', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');

    for (const invalid of [0, -5, 12.5]) {
      const bad = await req('PATCH', '/api/v2/brands/brand_a1/markets/GLOBAL', tokenA, {
        monthlyRetestPointCap: invalid,
      });
      expect(bad.status).toBe(400);
    }

    const setRes = await req('PATCH', '/api/v2/brands/brand_a1/markets/GLOBAL', tokenA, {
      monthlyRetestPointCap: 50,
    });
    expect(setRes.status).toBe(200);
    expect(
      (setRes.body.data as { markets: Array<{ monthlyRetestPointCap: number | null }> }).markets[0]
        ?.monthlyRetestPointCap,
    ).toBe(50);

    const clearRes = await req('PATCH', '/api/v2/brands/brand_a1/markets/GLOBAL', tokenA, {
      monthlyRetestPointCap: null,
    });
    expect(clearRes.status).toBe(200);
    expect(
      (clearRes.body.data as { markets: Array<{ monthlyRetestPointCap: number | null }> })
        .markets[0]?.monthlyRetestPointCap,
    ).toBeNull();
  });

  it('isolates multi-line BrandFacts on same slot, blocks cross-brand productLineId, and preserves facts on line deletion', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');

    const lineARes = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'Power Line',
      category: 'Portable Power Station',
    });
    const lineBRes = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'NAS Line',
      category: 'Home NAS',
    });
    const lineOtherBrandRes = await req('POST', '/api/v2/brands/brand_a2/product-lines', tokenA, {
      name: 'Other Brand Line',
      category: 'Other',
    });

    const lineAId = (lineARes.body.data as { id: string }).id;
    const lineBId = (lineBRes.body.data as { id: string }).id;
    const lineOtherBrandId = (lineOtherBrandRes.body.data as { id: string }).id;

    // Reject cross-brand productLineId on PUT /facts -> 404
    const crossBrandPut = await req('PUT', '/api/v2/brands/brand_a1/facts', tokenA, {
      facts: [
        {
          slot: 'PRODUCT_SPECS',
          productLineId: lineOtherBrandId,
          content: 'Cross brand fact',
        },
      ],
    });
    expect(crossBrandPut.status).toBe(404);
    expect(crossBrandPut.body.code).toBe(AUTH_ERROR.NOT_FOUND);

    // Save 3 facts sharing PRODUCT_SPECS across null / lineA / lineB without clobbering
    const putRes = await req('PUT', '/api/v2/brands/brand_a1/facts', tokenA, {
      facts: [
        {
          slot: 'CREDENTIALS',
          productLineId: null,
          title: 'General Cert',
          content: 'UL2743 and ISO9001 certified brand-wide',
        },
        {
          slot: 'PRODUCT_SPECS',
          productLineId: lineAId,
          title: 'Power Specs',
          content: '2048Wh LiFePO4 battery with 2400W AC output',
        },
        {
          slot: 'PRODUCT_SPECS',
          productLineId: lineBId,
          title: 'NAS Specs',
          content: '4-bay Intel N100 NAS with 28dB acoustic rating',
        },
      ],
    });
    expect(putRes.status).toBe(200);
    const allFacts = (
      putRes.body.data as {
        items: Array<{ id: string; productLineId: string | null; content: string }>;
      }
    ).items;
    expect(allFacts).toHaveLength(3);
    expect(allFacts.find((f) => f.productLineId === lineAId)?.content).toContain('2048Wh');
    expect(allFacts.find((f) => f.productLineId === lineBId)?.content).toContain('4-bay');

    // GET /facts?productLineId=lineAId returns general + lineA, NEVER lineB
    const scopedGet = await req(
      'GET',
      `/api/v2/brands/brand_a1/facts?productLineId=${lineAId}`,
      tokenA,
    );
    expect(scopedGet.status).toBe(200);
    const scopedFacts = (
      scopedGet.body.data as { items: Array<{ productLineId: string | null; content: string }> }
    ).items;
    expect(scopedFacts).toHaveLength(2);
    expect(scopedFacts.some((f) => f.productLineId === null)).toBe(true);
    expect(scopedFacts.some((f) => f.productLineId === lineAId)).toBe(true);
    expect(scopedFacts.some((f) => f.productLineId === lineBId)).toBe(false);

    // Deleting Line A triggers SetNull (preserves historical fact with productLineId: null)
    const delRes = await req('DELETE', `/api/v2/brands/brand_a1/product-lines/${lineAId}`, tokenA);
    expect(delRes.status).toBe(200);

    const afterDelete = await req('GET', '/api/v2/brands/brand_a1/facts', tokenA);
    const remainingFacts = (
      afterDelete.body.data as { items: Array<{ productLineId: string | null; content: string }> }
    ).items;
    expect(remainingFacts).toHaveLength(3);
    expect(remainingFacts.find((f) => f.content.includes('2048Wh'))?.productLineId).toBeNull();
  });

  it('deduplicates repeated uncreated (slot, productLineId) tuples within a single PUT /facts payload', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');

    const lineRes = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'Case Study Line',
      category: 'Home NAS',
    });
    expect(lineRes.status).toBe(200);
    const lineId = (lineRes.body.data as { id: string }).id;

    const putRes = await req('PUT', '/api/v2/brands/brand_a1/facts', tokenA, {
      facts: [
        {
          slot: 'CASE_STUDIES',
          productLineId: lineId,
          title: 'Case v1',
          content: 'Case study v1 initial text',
        },
        {
          slot: 'CASE_STUDIES',
          productLineId: lineId,
          title: 'Case v2',
          content: 'Case study v2 latest text',
        },
      ],
    });
    expect(putRes.status).toBe(200);

    const caseFacts = (
      putRes.body.data as {
        items: Array<{
          slot: string;
          productLineId: string | null;
          title: string;
          content: string;
        }>;
      }
    ).items.filter((f) => f.slot === 'CASE_STUDIES' && f.productLineId === lineId);
    expect(caseFacts).toHaveLength(1);
    expect(caseFacts[0]?.title).toBe('Case v2');
    expect(caseFacts[0]?.content).toBe('Case study v2 latest text');
  });

  it('locks the parent Brand row inside scoped.$transaction before counting and creating a product line', async () => {
    const tokenA = makeToken('u_a', 'tenant_a');
    store.scoped.$transaction.mockClear();
    store.scoped.brand.updateMany.mockClear();
    store.scoped.brandProductLine.count.mockClear();
    store.scoped.brandProductLine.create.mockClear();

    const created = await req('POST', '/api/v2/brands/brand_a1/product-lines', tokenA, {
      name: 'Serialized Line',
      category: 'Smart Hardware',
    });
    expect(created.status).toBe(200);
    expect(store.scoped.$transaction).toHaveBeenCalledTimes(1);
    expect(store.scoped.brand.updateMany).toHaveBeenCalledWith({
      where: { id: 'brand_a1' },
      data: { id: 'brand_a1' },
    });

    const lockOrder = store.scoped.brand.updateMany.mock.invocationCallOrder[0]!;
    const countOrder = store.scoped.brandProductLine.count.mock.invocationCallOrder[0]!;
    const createOrder = store.scoped.brandProductLine.create.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(countOrder);
    expect(countOrder).toBeLessThan(createOrder);
  });
});

describe.runIf(process.env.GEOMIX_DB_INTEGRATION === '1')(
  'BrandProductLines real PG16 concurrency race protection (BRAND_MAX_PRODUCT_LINES = 20)',
  () => {
    let ctx: IsolatedTestContext;

    beforeAll(async () => {
      ctx = await createIsolatedTestContext('pl_race');
    }, 120_000);

    afterAll(async () => {
      await ctx?.close();
    }, 60_000);

    it('serializes 10 concurrent POST /product-lines at count=19 so strictly 1 succeeds and DB never exceeds 20', async () => {
      const { token } = await ctx.createTenantUser({ prefix: 'plrace' });

      const brandRes = await fetch(`${ctx.base}/api/v2/brands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'NovaRace',
          category: 'Smart Hardware',
          markets: ['GLOBAL'],
        }),
      });
      expect(brandRes.status).toBe(200);
      const brandBody = (await brandRes.json()) as { data: { id: string } };
      const brandId = brandBody.data.id;

      for (let i = 1; i <= BRAND_MAX_PRODUCT_LINES - 1; i += 1) {
        const res = await fetch(`${ctx.base}/api/v2/brands/${brandId}/product-lines`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: `Seed Line ${i}`,
            category: `Category ${i}`,
            sortOrder: i,
          }),
        });
        expect(res.status).toBe(200);
      }

      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          fetch(`${ctx.base}/api/v2/brands/${brandId}/product-lines`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: `Race Line ${idx + 1}`,
              category: 'Portable Power Station',
            }),
          }).then((r) => r.status),
        ),
      );

      expect(burst.filter((s) => s === 200)).toHaveLength(1);
      expect(burst.filter((s) => s === 400)).toHaveLength(9);

      const listRes = await fetch(`${ctx.base}/api/v2/brands/${brandId}/product-lines`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
      expect(listBody.data.items).toHaveLength(BRAND_MAX_PRODUCT_LINES);
    }, 60_000);
  },
);
