import { expect, test, v2Describe } from './support/v2-test';
import {
  adminAdjustPoints,
  apiRawFetch,
  apiRequest,
  createBrand,
  enableBrandMarket,
  extractItems,
  getAdminSession,
  getBrand,
  getWallet,
  getWebBase,
  listBrands,
  provisionTenant,
  setTenantBillingMode,
  type BrandData,
  type PricingItemData,
} from './support/api-client';
import {
  assertNoColdLoadFlicker,
  assertNoForbiddenLegacyText,
  assertNoHorizontalOverflow,
  VIEWPORT_COMPACT,
  VIEWPORT_DESKTOP,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildGlobalMarketConfig,
  CN_ENGINE_KEYS,
  LEGACY_FORBIDDEN_MENUS,
  uniqueIdemKey,
  uniqueTag,
} from './support/fixtures';
import {
  attachErrorCollector,
  createAuthenticatedContext,
  expectUrlContext,
  navigateWorkspace,
  openAccountWorkspace,
  switchGlobalBrand,
  switchGlobalMarket,
} from './support/ui-actions';

// ============================================================================
// Spec 01 — M1 Foundation: F1–F5 (25 Tier 1 + 27 Tier 2 = 52 tests)
// Progressive rule: ZERO calls to F6–F17 endpoints (/facts, /media, /visibility,
// /briefs, /articles, /batch-jobs, /prompt-preferences, /publish-records, /home).
// ============================================================================

v2Describe('F1: Brand + BrandMarket Dual-Market Domain Schema', { tag: ['@F1', '@M1'] }, () => {
  test(
    'T1-F01-01 Create CN-only Brand persists core fields and nested BrandMarket(CN)',
    { tag: ['@tier1', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01t1');
      const tenant = await provisionTenant({ tag });
      const payload = buildCnBrandPayload(tag);

      const created = await createBrand(tenant.accessToken, payload);
      expect([200, 201]).toContain(created.status);
      expect(created.body?.code).toBe(0);
      const brand = created.body!.data;
      expect(brand.id).toBeTruthy();
      expect(brand.name).toBe(payload.name);
      expect(brand.category).toBe(payload.category);
      expect(brand.markets).toHaveLength(1);
      expect(brand.markets[0].market).toBe('CN');
      expect(brand.markets[0].locale).toBe('zh-CN');
      expect(brand.markets[0].region).toBe('CN');
      expect(brand.markets[0].competitors[0].domains).toContain('jikong.example');

      const fetched = await getBrand(tenant.accessToken, brand.id);
      expect(fetched.status).toBe(200);
      expect(fetched.body?.code).toBe(0);
      expect(fetched.body!.data.id).toBe(brand.id);
      expect(fetched.body!.data.markets).toHaveLength(1);
      expect(fetched.body!.data.markets[0].ownedDomains).toEqual(brand.markets[0].ownedDomains);

      const listed = await listBrands(tenant.accessToken);
      expect(listed.status).toBe(200);
      const items = extractItems(listed.body?.data);
      expect(items.some((item) => item.id === brand.id)).toBe(true);
    },
  );

  test(
    'T1-F01-02 Create dual-market (CN + GLOBAL) Brand with isolated per-market metadata',
    { tag: ['@tier1', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01t2');
      const tenant = await provisionTenant({ tag });

      const created = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      expect(created.body?.code).toBe(0);

      const fetched = await getBrand(tenant.accessToken, created.body!.data.id);
      expect(fetched.status).toBe(200);
      const markets = fetched.body!.data.markets;
      expect(markets).toHaveLength(2);

      const cn = markets.find((m) => m.market === 'CN');
      const global = markets.find((m) => m.market === 'GLOBAL');
      expect(cn).toBeTruthy();
      expect(global).toBeTruthy();
      expect(cn!.id).not.toBe(global!.id);
      expect(cn!.locale).toBe('zh-CN');
      expect(global!.locale).toBe('en-US');
      expect(cn!.localBrandName).not.toBe(global!.localBrandName);
      expect(cn!.ownedDomains).not.toEqual(global!.ownedDomains);
      expect(cn!.competitors[0].name).not.toBe(global!.competitors[0].name);
      expect(Array.isArray(cn!.seedPrompts)).toBe(true);
      expect(Array.isArray(global!.seedPrompts)).toBe(true);
    },
  );

  test(
    'T1-F01-03 Enable second market on an existing single-market brand',
    { tag: ['@tier1', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01t3');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      const brandId = created.body!.data.id;
      const originalCn = created.body!.data.markets[0];

      const enabled = await enableBrandMarket(
        tenant.accessToken,
        brandId,
        'GLOBAL',
        buildGlobalMarketConfig(tag),
      );
      expect([200, 201]).toContain(enabled.status);
      expect(enabled.body?.code).toBe(0);

      const fetched = await getBrand(tenant.accessToken, brandId);
      expect(fetched.status).toBe(200);
      expect(fetched.body!.data.markets).toHaveLength(2);
      const cnAfter = fetched.body!.data.markets.find((m) => m.market === 'CN');
      const globalAfter = fetched.body!.data.markets.find((m) => m.market === 'GLOBAL');
      expect(cnAfter?.localBrandName).toBe(originalCn.localBrandName);
      expect(cnAfter?.ownedDomains).toEqual(originalCn.ownedDomains);
      expect(globalAfter?.locale).toBe('en-US');
    },
  );

  test(
    'T1-F01-04 Update BrandMarket locale/region extensibility fields without touching CN',
    { tag: ['@tier1', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01t4');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      const brandId = created.body!.data.id;
      const cnBefore = created.body!.data.markets.find((m) => m.market === 'CN')!;

      const patched = await apiRequest<BrandData>(
        'v2',
        'PATCH',
        `/brands/${brandId}/markets/GLOBAL`,
        {
          token: tenant.accessToken,
          body: {
            locale: 'en-GB',
            region: 'GB',
            localBrandName: `AstraVault UK ${tag}`,
            aliases: ['AV-UK', 'AstraVault Britain'],
            ownedDomains: [`uk-${tag}.example`],
            competitors: [{ name: 'BritNAS', aliases: ['BN4'], domains: ['britnas.example'] }],
          },
        },
      );
      expect(patched.status).toBe(200);
      expect(patched.body?.code).toBe(0);

      const fetched = await getBrand(tenant.accessToken, brandId);
      expect(fetched.status).toBe(200);
      const globalAfter = fetched.body!.data.markets.find((m) => m.market === 'GLOBAL')!;
      const cnAfter = fetched.body!.data.markets.find((m) => m.market === 'CN')!;
      expect(globalAfter.locale).toBe('en-GB');
      expect(globalAfter.region).toBe('GB');
      expect(globalAfter.localBrandName).toBe(`AstraVault UK ${tag}`);
      expect(globalAfter.ownedDomains).toEqual([`uk-${tag}.example`]);
      expect(globalAfter.competitors[0].domains).toContain('britnas.example');
      expect(cnAfter.localBrandName).toBe(cnBefore.localBrandName);
      expect(cnAfter.locale).toBe('zh-CN');
    },
  );

  test(
    'T1-F01-05 Deleting a Brand cascades cleanly without leaving orphan lookups',
    { tag: ['@tier1', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01t5');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      const brandId = created.body!.data.id;

      const del = await apiRequest('v2', 'DELETE', `/brands/${brandId}`, {
        token: tenant.accessToken,
      });
      expect(del.status).toBe(200);
      expect(del.body?.code).toBe(0);

      const afterGet = await getBrand(tenant.accessToken, brandId);
      expect(afterGet.status).toBe(404);

      const listed = await listBrands(tenant.accessToken);
      expect(extractItems(listed.body?.data).some((b) => b.id === brandId)).toBe(false);
    },
  );

  test(
    'T2-F01-01 Strict multi-tenant isolation on Brand and BrandMarket read/update/delete',
    { tag: ['@tier2', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01b1');
      const tenantA = await provisionTenant({ tag: `${tag}a` });
      const tenantB = await provisionTenant({ tag: `${tag}b` });
      const created = await createBrand(tenantA.accessToken, buildCnBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      const brandAId = created.body!.data.id;

      const getAsB = await getBrand(tenantB.accessToken, brandAId);
      const patchAsB = await apiRequest('v2', 'PATCH', `/brands/${brandAId}`, {
        token: tenantB.accessToken,
        body: { name: 'Hijacked' },
      });
      const delAsB = await apiRequest('v2', 'DELETE', `/brands/${brandAId}`, {
        token: tenantB.accessToken,
      });
      const patchMarketAsB = await apiRequest('v2', 'PATCH', `/brands/${brandAId}/markets/CN`, {
        token: tenantB.accessToken,
        body: { localBrandName: 'Hijacked CN' },
      });

      expect(getAsB.status).toBe(404);
      expect(patchAsB.status).toBe(404);
      expect(delAsB.status).toBe(404);
      expect(patchMarketAsB.status).toBe(404);

      const listB = await listBrands(tenantB.accessToken);
      expect(extractItems(listB.body?.data).some((b) => b.id === brandAId)).toBe(false);

      const stillIntact = await getBrand(tenantA.accessToken, brandAId);
      expect(stillIntact.status).toBe(200);
      expect(stillIntact.body!.data.name).toBe(created.body!.data.name);
    },
  );

  test(
    'T2-F01-02 Expired tenant blocked by TenantActiveGuard on Brand mutations',
    { tag: ['@tier2', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01b2');
      const expired = await provisionTenant({ tag, expired: true });

      const res = await createBrand(expired.accessToken, buildCnBrandPayload(tag));
      expect(res.status).toBe(403);
      expect(res.body?.code).toBe(40301);
    },
  );

  test(
    'T2-F01-03 Duplicate (tenantId, name) brand creation rejected while other tenant succeeds',
    { tag: ['@tier2', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01b3');
      const tenantA = await provisionTenant({ tag: `${tag}a` });
      const tenantB = await provisionTenant({ tag: `${tag}b` });
      const sharedName = `AeroNAS-${tag}`;

      const first = await createBrand(
        tenantA.accessToken,
        buildCnBrandPayload(tag, { name: sharedName }),
      );
      expect([200, 201]).toContain(first.status);

      const dup = await createBrand(
        tenantA.accessToken,
        buildCnBrandPayload(`${tag}d`, { name: sharedName }),
      );
      expect([400, 409]).toContain(dup.status);
      expect(dup.body?.code).not.toBe(0);

      const tenantBCreate = await createBrand(
        tenantB.accessToken,
        buildCnBrandPayload(`${tag}b`, { name: sharedName }),
      );
      expect([200, 201]).toContain(tenantBCreate.status);
      expect(tenantBCreate.body?.code).toBe(0);
    },
  );

  test(
    'T2-F01-04 Duplicate (brandId, market) market activation rejected cleanly',
    { tag: ['@tier2', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01b4');
      const tenant = await provisionTenant({ tag });
      const created = await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
      expect([200, 201]).toContain(created.status);
      const brandId = created.body!.data.id;

      const dup = await enableBrandMarket(tenant.accessToken, brandId, 'CN', {
        localBrandName: 'Duplicate CN',
        ownedDomains: ['dup.example'],
      });
      expect([400, 409]).toContain(dup.status);
      expect(dup.body?.code).not.toBe(0);

      const fetched = await getBrand(tenant.accessToken, brandId);
      expect(fetched.body!.data.markets.filter((m) => m.market === 'CN')).toHaveLength(1);
    },
  );

  test(
    'T2-F01-05 Invalid market enum value rejected with 400 / 40001',
    { tag: ['@tier2', '@F1', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f01b5');
      const tenant = await provisionTenant({ tag });

      const badBody = await createBrand(tenant.accessToken, {
        name: `BadMarket-${tag}`,
        category: 'NAS',
        markets: [
          {
            market: 'EU',
            localBrandName: 'Bad',
            ownedDomains: ['bad.example'],
          },
        ],
      });
      expect(badBody.status).toBe(400);
      expect(badBody.body?.code).toBe(40001);

      const valid = await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
      const badPath = await enableBrandMarket(tenant.accessToken, valid.body!.data.id, 'EU', {
        localBrandName: 'EU Brand',
        ownedDomains: ['eu.example'],
      });
      expect(badPath.status).toBe(400);
      expect(badPath.body?.code).toBe(40001);
    },
  );
});

v2Describe('F2: Simplified Unified Billing & Pricing', { tag: ['@F2', '@M1'] }, () => {
  test(
    'T1-F02-01 Public pricing list exposes ONLY the 4 v2.1 paid actions with exact default prices',
    { tag: ['@tier1', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f02t1') });
      const res = await apiRequest<{ items?: PricingItemData[] } | PricingItemData[]>(
        'v1',
        'GET',
        '/pricing',
        { token: tenant.accessToken },
      );
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);

      const items = extractItems(res.body?.data);
      const byAction = new Map(items.map((item) => [item.action, item.unitPoints]));
      expect(items).toHaveLength(4);
      expect(byAction.get('geo_write')).toBe(10);
      expect(byAction.get('visibility_check')).toBe(2);
      expect(byAction.get('inline_image_gen')).toBe(5);
      expect(byAction.get('geo_variant')).toBe(2);

      for (const removed of [
        'kb_addon',
        'distill',
        'ai_write',
        'rewrite_single',
        'rewrite_batch',
        'image_gen',
      ]) {
        expect(byAction.has(removed), `Legacy action ${removed} must not exist`).toBe(false);
      }
    },
  );

  test(
    'T1-F02-02 Default tenant billing mode inherits BILLING_MODE=SHADOW',
    { tag: ['@tier1', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const tenant = await provisionTenant({
        tag: uniqueTag(testInfo, 'f02t2'),
        billingMode: null,
        initialPoints: 500,
      });
      const res = await getWallet(tenant.accessToken);
      expect(res.status).toBe(200);
      expect(res.body?.code).toBe(0);
      expect(res.body!.data.billingMode).toBe('SHADOW');
      expect(res.body!.data.points).toBe(500);
      expect(res.body!.data.pointsReserved).toBe(0);
    },
  );

  test(
    'T1-F02-03 Admin pricing management updates geo_write and restores default cleanly',
    { tag: ['@tier1', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const admin = getAdminSession();
      const merchant = await provisionTenant({ tag: uniqueTag(testInfo, 'f02t3') });

      try {
        const patch12 = await apiRequest('v1', 'PATCH', '/admin/pricing', {
          token: admin.accessToken,
          body: { action: 'geo_write', unitPoints: 12, enabled: true },
        });
        expect(patch12.status).toBe(200);
        expect(patch12.body?.code).toBe(0);

        const publicPricing = await apiRequest<{ items?: PricingItemData[] } | PricingItemData[]>(
          'v1',
          'GET',
          '/pricing',
          { token: merchant.accessToken },
        );
        const geoWrite = extractItems(publicPricing.body?.data).find(
          (i) => i.action === 'geo_write',
        );
        expect(geoWrite?.unitPoints).toBe(12);
      } finally {
        const restore = await apiRequest('v1', 'PATCH', '/admin/pricing', {
          token: admin.accessToken,
          body: { action: 'geo_write', unitPoints: 10, enabled: true },
        });
        expect(restore.status).toBe(200);
      }

      const verified = await apiRequest<{ items?: PricingItemData[] } | PricingItemData[]>(
        'v1',
        'GET',
        '/pricing',
        { token: merchant.accessToken },
      );
      expect(
        extractItems(verified.body?.data).find((i) => i.action === 'geo_write')?.unitPoints,
      ).toBe(10);
    },
  );

  test(
    'T1-F02-04 Admin switches tenant billing mode to STRICT and adjusts points idempotently',
    { tag: ['@tier1', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f02t4');
      const tenant = await provisionTenant({ tag, billingMode: null, initialPoints: 100 });

      const modeRes = await setTenantBillingMode(tenant.tenantId, 'STRICT');
      expect(modeRes.status).toBe(200);
      expect(modeRes.body?.code).toBe(0);

      const adjRes = await adminAdjustPoints({
        tenantId: tenant.tenantId,
        delta: 50,
        idempotencyKey: uniqueIdemKey(`f02t4_${tag}`),
        remark: 'E2E topup',
      });
      expect(adjRes.status).toBe(200);
      expect(adjRes.body?.code).toBe(0);

      const wallet = await getWallet(tenant.accessToken);
      expect(wallet.body!.data.billingMode).toBe('STRICT');
      expect(wallet.body!.data.points).toBe(150);

      const ledger = await apiRequest<{ items?: Array<{ reason?: string; delta?: number }> }>(
        'v1',
        'GET',
        '/billing/ledger',
        { token: tenant.accessToken },
      );
      expect(ledger.status).toBe(200);
      const entries = extractItems(ledger.body?.data);
      expect(entries.some((e) => e.reason === 'admin_topup' && e.delta === 50)).toBe(true);
    },
  );

  test(
    'T1-F02-05 Admin LLM cost report API and /admin/llm-costs UI operate cleanly on v2 schema',
    { tag: ['@tier1', '@F2', '@M1'] },
    async ({ browser }) => {
      const admin = getAdminSession();
      const apiRes = await apiRequest<Record<string, unknown>>('v1', 'GET', '/admin/llm-costs', {
        token: admin.accessToken,
      });
      expect(apiRes.status).toBe(200);
      expect(apiRes.body?.code).toBe(0);
      expect(apiRes.body?.data).toBeTruthy();

      const { context, page } = await createAuthenticatedContext(browser, admin);
      try {
        await page.goto('/admin/llm-costs', { waitUntil: 'domcontentloaded' });
        const region = page.getByRole('region', { name: 'LLM成本日报' });
        await expect(region).toContainText('总调用次数');
        await expect(region).toContainText('总 Token 消耗');
        await expect(page.getByRole('button', { name: '导出 CSV' })).toBeEnabled();
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T2-F02-01 Legacy pricing actions (kb_addon, ai_write) rejected on admin pricing update',
    { tag: ['@tier2', '@F2', '@M1'] },
    async () => {
      const admin = getAdminSession();
      for (const action of ['kb_addon', 'ai_write']) {
        const res = await apiRequest('v1', 'PATCH', '/admin/pricing', {
          token: admin.accessToken,
          body: { action, unitPoints: 5, enabled: true },
        });
        expect(res.status).toBe(400);
        expect(res.body?.code).not.toBe(0);
      }

      const list = await apiRequest<{ items?: PricingItemData[] } | PricingItemData[]>(
        'v1',
        'GET',
        '/pricing',
        { token: admin.accessToken },
      );
      expect(extractItems(list.body?.data)).toHaveLength(4);
    },
  );

  test(
    'T2-F02-02 Zero or negative unit price rejected on admin pricing update',
    { tag: ['@tier2', '@F2', '@M1'] },
    async () => {
      const admin = getAdminSession();
      for (const unitPoints of [0, -5]) {
        const res = await apiRequest('v1', 'PATCH', '/admin/pricing', {
          token: admin.accessToken,
          body: { action: 'geo_write', unitPoints, enabled: true },
        });
        expect(res.status).toBe(400);
        expect(res.body?.code).toBe(40001);
      }
    },
  );

  test(
    'T2-F02-03 Non-admin merchant accessing admin endpoints receives 404 (AdminGuard)',
    { tag: ['@tier2', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const merchant = await provisionTenant({ tag: uniqueTag(testInfo, 'f02b3') });
      const checks = await Promise.all([
        apiRequest('v1', 'GET', '/admin/pricing', { token: merchant.accessToken }),
        apiRequest('v1', 'POST', '/admin/billing/mode', {
          token: merchant.accessToken,
          body: { tenantId: merchant.tenantId, billingMode: 'STRICT' },
        }),
        apiRequest('v1', 'POST', '/admin/billing/adjust', {
          token: merchant.accessToken,
          body: {
            tenantId: merchant.tenantId,
            delta: 10,
            idempotencyKey: uniqueIdemKey('unauth'),
          },
        }),
        apiRequest('v1', 'GET', '/admin/llm-costs', { token: merchant.accessToken }),
        apiRequest('v1', 'GET', '/admin/tenants', { token: merchant.accessToken }),
      ]);
      for (const res of checks) {
        expect(res.status).toBe(404);
      }
    },
  );

  test(
    'T2-F02-04 Admin billing adjust idempotency replay credits once and rejects malformed keys',
    { tag: ['@tier2', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f02b4');
      const tenant = await provisionTenant({ tag, initialPoints: 100 });
      const idemKey = uniqueIdemKey(`f02b4_${tag}`);

      const first = await adminAdjustPoints({
        tenantId: tenant.tenantId,
        delta: 20,
        idempotencyKey: idemKey,
      });
      expect(first.status).toBe(200);

      const replay = await adminAdjustPoints({
        tenantId: tenant.tenantId,
        delta: 20,
        idempotencyKey: idemKey,
      });
      expect([200, 409]).toContain(replay.status);

      const wallet = await getWallet(tenant.accessToken);
      expect(wallet.body!.data.points).toBe(120);

      for (const badKey of ['ab', 'close:foo']) {
        const bad = await adminAdjustPoints({
          tenantId: tenant.tenantId,
          delta: 10,
          idempotencyKey: badKey,
        });
        expect(bad.status).toBe(400);
        expect(bad.body?.code).toBe(40001);
      }
    },
  );

  test(
    'T2-F02-05 Removed /api/v1/admin/templates API and /admin/templates UI are no longer exposed',
    { tag: ['@tier2', '@F2', '@M1'] },
    async ({ browser }) => {
      const admin = getAdminSession();
      const apiRes = await apiRequest('v1', 'GET', '/admin/templates', {
        token: admin.accessToken,
      });
      expect(apiRes.status).toBe(404);

      const { context, page } = await createAuthenticatedContext(browser, admin);
      try {
        const navRes = await page.goto('/admin/templates', { waitUntil: 'domcontentloaded' });
        const status = navRes?.status() ?? 200;
        if (status === 200) {
          expect(new URL(page.url()).pathname).not.toBe('/admin/templates');
        } else {
          expect(status).toBe(404);
        }
        await page.goto('/admin/pricing', { waitUntil: 'domcontentloaded' });
        const adminNav = page.getByRole('navigation', { name: '管理菜单' });
        await expect(adminNav.getByRole('link', { name: '系统模板' })).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'T2-F02-06 Account points CSV export returns valid UTF-8 CSV with zero kb_addon entries',
    { tag: ['@tier2', '@F2', '@M1'] },
    async ({}, testInfo) => {
      const tenant = await provisionTenant({
        tag: uniqueTag(testInfo, 'f02b6'),
        initialPoints: 100,
      });
      const res = await apiRawFetch('v1', 'GET', '/me/points?export=csv', {
        token: tenant.accessToken,
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type'] ?? '').toContain('text/csv');
      expect(res.headers['content-disposition'] ?? '').toContain('attachment');
      const csvText = res.buffer.toString('utf8');
      expect(csvText.trim().length).toBeGreaterThan(0);
      expect(csvText).not.toContain('kb_addon');
      expect(csvText).not.toContain('知识库加价');
    },
  );
});

v2Describe(
  'F3: @geomix/shared v2 Contracts & API v1/v2 Coexistence',
  { tag: ['@F3', '@M1'] },
  () => {
    test(
      'T1-F03-01 Retained v1 /api/v1/health and /api/v1/account routes remain live',
      { tag: ['@tier1', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f03t1') });
        const health = await apiRequest('v1', 'GET', '/health');
        expect(health.status).toBe(200);
        expect(health.body?.code).toBe(0);

        const account = await apiRequest<{ username?: string; user?: { username?: string } }>(
          'v1',
          'GET',
          '/account',
          { token: tenant.accessToken },
        );
        expect(account.status).toBe(200);
        expect(account.body?.code).toBe(0);
        expect(JSON.stringify(account.body?.data)).toContain(tenant.username);
      },
    );

    test(
      'T1-F03-02 New /api/v2/brands uses standard { code: 0, msg, data } envelope',
      { tag: ['@tier1', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f03t2') });
        const res = await listBrands(tenant.accessToken);
        expect(res.status).toBe(200);
        expect(res.body?.code).toBe(0);
        expect(typeof res.body?.msg).toBe('string');
        expect(Array.isArray(extractItems(res.body?.data))).toBe(true);
      },
    );

    test(
      'T1-F03-03 Retained v1 /me/rights, /me/verification, /announcements coexist with /api/v2/brands',
      { tag: ['@tier1', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f03t3') });
        const [rights, verify, announce, brands] = await Promise.all([
          apiRequest('v1', 'GET', '/me/rights', { token: tenant.accessToken }),
          apiRequest('v1', 'GET', '/me/verification', { token: tenant.accessToken }),
          apiRequest('v1', 'GET', '/announcements', { token: tenant.accessToken }),
          listBrands(tenant.accessToken),
        ]);
        for (const r of [rights, verify, announce, brands]) {
          expect(r.status).toBe(200);
          expect(r.body?.code).toBe(0);
        }
      },
    );

    test(
      'T1-F03-04 Dual-market defaults and canonical engine catalog use tongyi (not qwen)',
      { tag: ['@tier1', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f03t4');
        const tenant = await provisionTenant({ tag });
        const brand = await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
        expect([200, 201]).toContain(brand.status);

        const cn = brand.body!.data.markets.find((m) => m.market === 'CN')!;
        const global = brand.body!.data.markets.find((m) => m.market === 'GLOBAL')!;
        expect(cn.locale).toBe('zh-CN');
        expect(cn.region).toBe('CN');
        expect(global.locale).toBe('en-US');
        expect(global.region).toBe('US');

        const rights = await apiRequest<Record<string, unknown>>('v1', 'GET', '/me/rights', {
          token: tenant.accessToken,
        });
        expect(rights.status).toBe(200);
        const serialized = JSON.stringify(rights.body?.data).toLowerCase();
        expect(serialized).not.toContain('"qwen"');
        expect(CN_ENGINE_KEYS).toContain('tongyi');
        expect(CN_ENGINE_KEYS).toHaveLength(4);
      },
    );

    test(
      'T1-F03-05 Removed obsolete v1 business endpoints return 404',
      { tag: ['@tier1', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f03t5') });
        const removedPaths = [
          '/keywords',
          '/questions',
          '/knowledge',
          '/gallery',
          '/ai-tasks',
          '/rewrite/single',
          '/images',
        ];
        for (const path of removedPaths) {
          const res = await apiRequest('v1', 'GET', path, { token: tenant.accessToken });
          expect(res.status, `Expected removed v1 route ${path} to return 404`).toBe(404);
        }
      },
    );

    test(
      'T2-F03-01 Empty, duplicate, or missing market specifications in brand creation return 400 / 40001',
      { tag: ['@tier2', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f03b1');
        const tenant = await provisionTenant({ tag });

        const emptyMarkets = await createBrand(tenant.accessToken, {
          name: `Empty-${tag}`,
          category: 'NAS',
          markets: [],
        });
        expect(emptyMarkets.status).toBe(400);
        expect(emptyMarkets.body?.code).toBe(40001);

        const dupMarkets = await createBrand(tenant.accessToken, {
          name: `Dup-${tag}`,
          category: 'NAS',
          markets: [
            { market: 'CN', localBrandName: 'A', ownedDomains: ['a.example'] },
            { market: 'CN', localBrandName: 'B', ownedDomains: ['b.example'] },
          ],
        });
        expect(dupMarkets.status).toBe(400);
        expect(dupMarkets.body?.code).toBe(40001);

        const missingMarket = await createBrand(tenant.accessToken, {
          name: `Missing-${tag}`,
          category: 'NAS',
          markets: [{ localBrandName: 'A', ownedDomains: ['a.example'] }],
        });
        expect(missingMarket.status).toBe(400);
        expect(missingMarket.body?.code).toBe(40001);
      },
    );

    test(
      'T2-F03-02 Patching an unenabled GLOBAL market on CN-only brand returns 404/400 without mutating CN',
      { tag: ['@tier2', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f03b2');
        const tenant = await provisionTenant({ tag });
        const created = await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
        const brandId = created.body!.data.id;
        const cnBefore = created.body!.data.markets[0];

        const res = await apiRequest('v2', 'PATCH', `/brands/${brandId}/markets/GLOBAL`, {
          token: tenant.accessToken,
          body: { localBrandName: 'Ghost Global' },
        });
        expect([400, 404]).toContain(res.status);
        expect(res.body?.code).not.toBe(0);

        const after = await getBrand(tenant.accessToken, brandId);
        expect(after.body!.data.markets).toHaveLength(1);
        expect(after.body!.data.markets[0].localBrandName).toBe(cnBefore.localBrandName);
      },
    );

    test(
      'T2-F03-03 Malformed Idempotency-Key header rejected with 400 / 40001',
      { tag: ['@tier2', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const admin = getAdminSession();
        const tag = uniqueTag(testInfo, 'f03b3');
        for (const badKey of ['bad key!!', 'x', 'close:hack']) {
          const res = await apiRequest('v1', 'POST', '/admin/tenants', {
            token: admin.accessToken,
            headers: { 'idempotency-key': badKey },
            body: {
              name: `BadIdem ${tag}`,
              username: `e2bad_${tag}`.slice(0, 30),
              password: 'GeoMix-E2E-Password-123!',
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              initialPoints: 100,
            },
          });
          expect(res.status, `Expected 400 for Idempotency-Key "${badKey}"`).toBe(400);
          expect(res.body?.code).toBe(40001);
        }
      },
    );

    test(
      'T2-F03-04 Unauthenticated, malformed Bearer, and tampered JWT requests to /api/v2/brands return 401',
      { tag: ['@tier2', '@F3', '@M1'] },
      async () => {
        const noAuth = await apiRequest('v2', 'GET', '/brands');
        const badBearer = await apiRequest('v2', 'GET', '/brands', {
          headers: { authorization: 'Bearer not-a-jwt' },
        });
        const tampered = await apiRequest('v2', 'POST', '/brands', {
          headers: {
            authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.invalid_signature',
          },
          body: { name: 'Tampered', category: 'NAS', markets: [] },
        });
        expect(noAuth.status).toBe(401);
        expect(badBearer.status).toBe(401);
        expect(tampered.status).toBe(401);
      },
    );

    test(
      'T2-F03-05 Invalid path ID and malformed JSON payload rejected safely with 400 (never 500)',
      { tag: ['@tier2', '@F3', '@M1'] },
      async ({}, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f03b5') });
        const badId = await apiRequest('v2', 'POST', '/brands/bad%20id!!/markets/CN', {
          token: tenant.accessToken,
          body: { localBrandName: 'X', ownedDomains: ['x.example'] },
        });
        expect([400, 404]).toContain(badId.status);
        expect(badId.status).not.toBe(500);

        const badJson = await apiRequest('v2', 'POST', '/brands', {
          token: tenant.accessToken,
          rawBody: '{invalid',
        });
        expect(badJson.status).toBe(400);
        expect(badJson.rawText).not.toContain('SyntaxError: Unexpected token');
      },
    );
  },
);

v2Describe(
  'F4: Minimalist 5-Workspace Web Shell & Route Consolidation',
  { tag: ['@F4', '@M1'] },
  () => {
    test(
      'T1-F04-01 Left sidebar shows strictly 4 flat business items + bottom-left /account avatar entry',
      { tag: ['@tier1', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04t1');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          const sider = page.locator('aside.ant-layout-sider');
          await expect(sider).toBeVisible();
          await expect(sider).toContainText('GeoMix');
          await expect(sider.locator('.ant-menu-submenu')).toHaveCount(0);

          const navItems = sider.locator('.ant-menu-item');
          await expect(navItems).toHaveCount(5);
          for (const label of ['首页', '品牌', '诊断', '写作', '发布']) {
            await expect(sider.getByText(label, { exact: true }).first()).toBeVisible();
          }
          await expect(page.getByTestId('sider-account-entry')).toBeVisible();
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F04-02 Clicking all 5 workspaces updates URL, breadcrumb, and preserves native Back/Forward',
      { tag: ['@tier1', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04t2');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        const collector = attachErrorCollector(page);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await navigateWorkspace(page, '品牌', /\/brands(?:[?#]|$)/);
          await navigateWorkspace(page, '诊断', /\/visibility(?:[?#]|$)/);
          await navigateWorkspace(page, '写作', /\/studio(?:[?#]|$)/);
          await navigateWorkspace(page, '发布', /\/publish(?:[?#]|$)/);
          await openAccountWorkspace(page);
          await expect(page).toHaveURL(/\/account(?:[?#]|$)/);

          await page.goBack();
          await expect(page).toHaveURL(/\/publish(?:[?#]|$)/);
          await page.goForward();
          await expect(page).toHaveURL(/\/account(?:[?#]|$)/);
          expect(collector.errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F04-03 Legacy routes return 307/308 redirects to consolidated v2 workspaces',
      { tag: ['@tier1', '@F4', '@M1'] },
      async ({ request }) => {
        const webBase = getWebBase();
        const matrix: Array<[string, string]> = [
          ['/dashboard', '/home'],
          ['/visibility/overview', '/visibility'],
          ['/visibility/monitors', '/visibility'],
          ['/me/points', '/account'],
          ['/me/rights', '/account'],
          ['/me/verify', '/account'],
        ];
        for (const [from, to] of matrix) {
          const res = await request.get(`${webBase}${from}`, { maxRedirects: 0 });
          expect([307, 308], `Expected redirect for ${from}`).toContain(res.status());
          const location = res.headers()['location'] ?? '';
          expect(new URL(location, webBase).pathname, `Redirect target for ${from}`).toBe(to);
        }
      },
    );

    test(
      'T1-F04-04 /account consolidates Points, Rights, Verification tabs and submits Verification',
      { tag: ['@tier1', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04t4');
        const tenant = await provisionTenant({ tag });
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        const collector = attachErrorCollector(page);
        try {
          await page.goto('/account', { waitUntil: 'domcontentloaded' });
          await expect(page.getByRole('tab', { name: '点数明细' })).toBeVisible();
          await expect(page.getByRole('tab', { name: '账号权益' })).toBeVisible();
          await expect(page.getByRole('tab', { name: '扩展配对' })).toBeVisible();
          await expect(page.getByRole('tab', { name: '实名认证' })).toHaveCount(0);

          await page.getByRole('tab', { name: '账号权益' }).click();
          await expect(page.locator('.gm-right-card[aria-label="点数"]')).toBeVisible();

          await page.getByRole('tab', { name: '扩展配对' }).click();
          await expect(page.getByTestId('extension-pairing-panel')).toBeVisible();
          expect(collector.errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F04-05 Top shell contains zero multi-tab TabBar, draft note, mode switch, or LayoutPanel',
      { tag: ['@tier1', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04t5');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          for (const route of ['/home', '/brands', '/visibility', '/studio']) {
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await expect(page.locator('.gm-tabs, .gm-tabbar')).toHaveCount(0);
            await expect(page.locator('.gm-draft-note')).toHaveCount(0);
            await expect(page.locator('.gm-mode')).toHaveCount(0);
            await expect(page.getByRole('button', { name: '布局', exact: true })).toHaveCount(0);
            await expect(page.getByRole('button', { name: '多标签', exact: true })).toHaveCount(0);
          }
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-01 /me/money (¥0.00 balance page) is completely hidden from UI and redirects cleanly',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser, request }, testInfo) => {
        const webBase = getWebBase();
        const redirectRes = await request.get(`${webBase}/me/money`, { maxRedirects: 0 });
        expect([307, 308, 404]).toContain(redirectRes.status());
        if (redirectRes.status() !== 404) {
          expect(new URL(redirectRes.headers()['location'] ?? '', webBase).pathname).toBe(
            '/account',
          );
        }

        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f04b1') });
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/account', { waitUntil: 'domcontentloaded' });
          await expect(page.getByRole('tab', { name: '余额明细' })).toHaveCount(0);
          await expect(page.locator('body')).not.toContainText('¥0.00');
          await expect(page.locator('body')).not.toContainText('账户余额');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-02 Legacy 15+ removed menus and command-palette entries are completely absent',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04b2');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await assertNoForbiddenLegacyText(page, LEGACY_FORBIDDEN_MENUS);

          const paletteBtn = page.getByRole('button', { name: '打开指令面板' });
          await expect(paletteBtn).toBeVisible();
          await paletteBtn.click();
          const listbox = page.getByRole('listbox', { name: '指令列表' });
          await expect(listbox).toBeVisible();
          const paletteText = await listbox.innerText();
          for (const removed of [
            '/dashboard',
            '/image',
            '/me/money',
            '/material/keywords',
            '/rewrite/single',
          ]) {
            expect(paletteText).not.toContain(removed);
          }
          await page.keyboard.press('Escape');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-03 Direct visits to retired v1 routes fail safely without uncaught pageerror',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f04b3') });
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        try {
          for (const retired of [
            '/material/keywords',
            '/material/gallery',
            '/writing/tasks',
            '/rewrite/single',
            '/image',
          ]) {
            const res = await page.goto(retired, { waitUntil: 'domcontentloaded' });
            expect([200, 307, 308, 404]).toContain(res?.status() ?? 200);
          }
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-04 1440x900 desktop viewport has zero horizontal overflow across all 5 workspaces',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04b4');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));
        const { context, page } = await createAuthenticatedContext(browser, tenant, {
          viewport: VIEWPORT_DESKTOP,
        });
        try {
          for (const route of ['/home', '/brands', '/visibility', '/studio', '/account']) {
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await assertNoHorizontalOverflow(page, { viewports: [VIEWPORT_DESKTOP] });
          }
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-05 1280x800 compact laptop viewport has zero horizontal overflow across all 5 workspaces',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f04b5');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag));
        const { context, page } = await createAuthenticatedContext(browser, tenant, {
          viewport: VIEWPORT_COMPACT,
        });
        try {
          for (const route of ['/home', '/brands', '/visibility', '/studio', '/account']) {
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await assertNoHorizontalOverflow(page, {
              viewports: [VIEWPORT_COMPACT],
              checkSelectorNotClipped:
                '[data-testid="global-brand-switcher"], [data-testid="global-market-switcher"]',
            });
          }
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F04-06 Unauthenticated visits to all 5 protected workspaces redirect to /login with zero 500s',
      { tag: ['@tier2', '@F4', '@M1'] },
      async ({ browser }) => {
        const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP });
        const page = await context.newPage();
        const server500s: string[] = [];
        page.on('response', (res) => {
          if (res.status() >= 500) {
            server500s.push(`${res.status()} ${res.url()}`);
          }
        });
        try {
          for (const route of ['/home', '/brands', '/visibility', '/studio', '/account']) {
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await expect(page).toHaveURL(/\/login/);
          }
          expect(server500s).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  },
);

v2Describe(
  'F5: Global Brand + CN/GLOBAL Market Switcher & Skeleton Loading',
  { tag: ['@F5', '@M1'] },
  () => {
    test(
      'T1-F05-01 Header displays active Brand dropdown + CN/GLOBAL toggle synced to URL',
      { tag: ['@tier1', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05t1');
        const tenant = await provisionTenant({ tag });
        const brand = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brand.name);
          await expect(page.getByTestId('global-market-switcher')).toContainText('国内');
          await expect(page.getByTestId('global-market-switcher')).toContainText('海外');
          await expectUrlContext(page, { brandId: brand.id, market: 'CN' });
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F05-02 Switching Brand and Market persists in URL, localStorage, navigation, and reload',
      { tag: ['@tier1', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05t2');
        const tenant = await provisionTenant({ tag });
        await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}a`));
        const brandB = (
          await createBrand(tenant.accessToken, buildDualMarketBrandPayload(`${tag}b`))
        ).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await switchGlobalBrand(page, brandB.name);
          await switchGlobalMarket(page, 'GLOBAL');
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });

          const stored = await page.evaluate(() =>
            window.localStorage.getItem('geomix.workspace.v2'),
          );
          expect(stored).toContain(brandB.id);
          expect(stored).toContain('GLOBAL');

          await navigateWorkspace(page, '品牌', /\/brands/);
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });
          await navigateWorkspace(page, '诊断', /\/visibility/);
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });
          await navigateWorkspace(page, '写作', /\/studio/);
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });
          await navigateWorkspace(page, '发布', /\/publish/);
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });

          await page.reload({ waitUntil: 'domcontentloaded' });
          await expectUrlContext(page, { brandId: brandB.id, market: 'GLOBAL' });
          const brandBGlobalLabel =
            brandB.markets.find((m) => m.market === 'GLOBAL')?.localBrandName ?? brandB.name;
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandBGlobalLabel);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F05-03 Single-market brand renders + 开启另一市场 trigger and activates GLOBAL market',
      { tag: ['@tier1', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05t3');
        const tenant = await provisionTenant({ tag });
        const brand = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/home?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
          const enableBtn = page.getByTestId('enable-other-market-btn');
          await expect(enableBtn).toBeVisible();
          await enableBtn.click();

          const dialog = page.getByRole('dialog', {
            name: /开启海外|开启国内|开启海外市场|开启另一市场/,
          });
          await expect(dialog).toBeVisible();
          await dialog.getByLabel('当地品牌名称').fill(`AstraVault ${tag}`);
          await dialog.getByRole('button', { name: /^(?:开启|确认开启)$/ }).click();

          await expectUrlContext(page, { brandId: brand.id, market: 'GLOBAL' });
          await expect(enableBtn).toHaveCount(0);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F05-04 Cold load shows Skeleton placeholders while brands & wallet APIs are in-flight',
      { tag: ['@tier1', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05t4');
        const tenant = await provisionTenant({ tag, initialPoints: 777 });
        const brand = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        await page.route('**/api/v2/brands*', async (route) => {
          await gate;
          await route.continue();
        });
        await page.route('**/api/v1/billing/wallet*', async (route) => {
          await gate;
          await route.continue();
        });

        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await expect(page.locator('.ant-skeleton, [aria-busy="true"]').first()).toBeVisible();
          await page.waitForTimeout(400);
          release();
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brand.name);
          await expect(page.getByTestId('header-points-pill')).toContainText('777');
        } finally {
          release();
          await context.close();
        }
      },
    );

    test(
      'T1-F05-05 Fresh 0-brand tenant automatically enters 60-second first-brand onboarding state',
      { tag: ['@tier1', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f05t5') });
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto('/home', { waitUntil: 'domcontentloaded' });
          await expect(
            page.getByRole('button', { name: /新建品牌|60 秒创建首个品牌/ }).first(),
          ).toBeVisible();
          const bodyText = await page.evaluate(() => document.body.innerText);
          expect(bodyText).not.toContain('NaN');
          expect(bodyText).not.toContain('undefined');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F05-01 0-brand tenant visiting /visibility and /studio sees guided onboarding with zero 4xx/5xx spam',
      { tag: ['@tier2', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tenant = await provisionTenant({ tag: uniqueTag(testInfo, 'f05b1') });
        const { context, page } = await createAuthenticatedContext(browser, tenant);
        const apiFailures: string[] = [];
        page.on('response', (res) => {
          if (res.url().includes('/api/') && res.status() >= 400) {
            apiFailures.push(`${res.status()} ${res.url()}`);
          }
        });
        try {
          for (const route of ['/visibility', '/studio']) {
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await expect(
              page
                .getByRole('button', {
                  name: /60 秒创建首个品牌|创建首个品牌|立即创建首个品牌|建品牌/,
                })
                .first(),
            ).toBeVisible();
          }
          expect(apiFailures).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F05-02 Unavailable ?market=GLOBAL URL param on CN-only brand auto-coerces to CN',
      { tag: ['@tier2', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05b2');
        const tenant = await provisionTenant({ tag });
        const brand = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/home?brandId=${brand.id}&market=GLOBAL`, {
            waitUntil: 'domcontentloaded',
          });
          await expectUrlContext(page, { brandId: brand.id, market: 'CN' });
          await expect(page.getByTestId('enable-other-market-btn')).toBeVisible();
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F05-03 Stale/nonexistent brandId in URL and localStorage recovers gracefully to owned brand',
      { tag: ['@tier2', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05b3');
        const tenant = await provisionTenant({ tag });
        const owned = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant, {
          preseedWorkspace: { activeBrandId: 'nonexistent_brand_123', activeMarket: 'CN' },
        });
        const collector = attachErrorCollector(page);
        try {
          await page.goto('/home?brandId=nonexistent_brand_123&market=CN', {
            waitUntil: 'domcontentloaded',
          });
          await expectUrlContext(page, { brandId: owned.id, market: 'CN' });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(owned.name);
          expect(collector.errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F05-04 Zero 0 点 / 免费体验期 / ¥0.00 flicker during throttled cold load on /home and /account',
      { tag: ['@tier2', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05b4');
        const tenant = await provisionTenant({ tag, initialPoints: 888 });
        await createBrand(tenant.accessToken, buildCnBrandPayload(tag));

        await assertNoColdLoadFlicker(browser, tenant, '/home', {
          holdMs: 900,
          expectedPointsText: '888',
        });
        await assertNoColdLoadFlicker(browser, tenant, '/account', {
          holdMs: 900,
          expectedPointsText: '888',
        });
      },
    );

    test(
      'T2-F05-05 Rapid consecutive brand switches ignore stale delayed Brand A responses',
      { tag: ['@tier2', '@F5', '@M1'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f05b5');
        const tenant = await provisionTenant({ tag });
        const brandA = (await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}a`))).body!
          .data;
        const brandB = (await createBrand(tenant.accessToken, buildCnBrandPayload(`${tag}b`))).body!
          .data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        await page.route(`**/api/v2/brands/${brandA.id}*`, async (route) => {
          await new Promise((r) => setTimeout(r, 900));
          await route.continue();
        });

        try {
          await page.goto(`/brands?brandId=${brandA.id}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await switchGlobalBrand(page, brandB.name);
          await page.waitForTimeout(1200);
          await expectUrlContext(page, { brandId: brandB.id, market: 'CN' });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandB.name);
        } finally {
          await context.close();
        }
      },
    );
  },
);
