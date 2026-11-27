import { expect, test, type Locator } from '@playwright/test';
import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  enableBrandMarketApi,
  extractItems,
  getWebBase,
  listBrandFactsApi,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  setTenantExpiry,
  unwrapOk,
  upsertBrandFactsApi,
  waitForVisibilityRunApi,
  type BrandDto,
  type BrandFactDto,
  type GeoMarket,
  type MintedSession,
} from './v2/support/api-client';
import {
  assertNoConsoleOrPageErrors,
  assertNoHorizontalOverflow,
  assertValidJsonLd,
  assertValidLlmsTxt,
} from './v2/support/assertions';
import {
  FIXTURE_URLS,
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  buildGlobalMarketConfig,
  buildSizedFactText,
  uniqueIdemKey,
  uniqueTag,
} from './v2/support/fixtures';
import {
  attachErrorCollector,
  createAuthenticatedContext,
  switchGlobalBrand,
} from './v2/support/ui-actions';

// ============================================================================
// Run r2 — UX Upgrade & Multi-Product-Line E2E Suite (Epic #388: #384-#387)
// Opaque-box tests strictly derived from ORIGINAL_REQUEST.md, PROJECT.md & PRD.
// ============================================================================

const WEB_BASE = getWebBase();
const FIXTURE_BASE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || '3099'}`;

const STUDIO_RESPONSIVE_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 900, height: 800 },
] as const;

const MULTI_LINE_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

type BrandProductLineWire = {
  id: string;
  brandId: string;
  name: string;
  localNamesJson?: Record<string, string>;
  category: string;
  localCategoriesJson?: Record<string, string>;
  seedPromptsJson?: Record<string, string[]>;
  competitorsJson?: Record<string, Array<{ name: string; aliases?: string[]; domains?: string[] }>>;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
};

type BrandMarketExtendedWire = BrandDto['markets'][number] & {
  localCategory?: string | null;
  monthlyRetestPointCap?: number | null;
};

type BrandExtendedWire = Omit<BrandDto, 'markets'> & {
  markets: BrandMarketExtendedWire[];
};

type BrandFactExtendedWire = BrandFactDto & {
  productLineId?: string | null;
};

type GeoBriefExtendedWire = {
  id: string;
  brandId: string;
  market: GeoMarket;
  targetPrompt: string;
  productLineId?: string | null;
};

type GeoArticleExtendedWire = {
  id: string;
  brandId?: string;
  market?: GeoMarket;
  title: string;
  contentMarkdown: string;
  schemaJsonLd?: unknown;
  llmsTxtSnippet?: string | null;
  productLineId?: string | null;
};

type VisibilityRunExtendedWire = {
  id: string;
  status: string;
  productLineId?: string | null;
};

type RetestScheduleWire = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  status: string;
  visibilityRunId: string | null;
  skipReason: string | null;
  executedAt?: string | null;
};

type PublishRecordWire = {
  id: string;
  publishedUrl: string;
  channel: string;
  crawlStatus?: string;
  retestSchedules?: RetestScheduleWire[];
};

type RetestBudgetSummaryWire = {
  monthKey: string;
  capPoints: number | null;
  usedPoints: number;
  remainingPoints: number | null;
  skippedCount: number;
};

type ActionHomeWire = {
  retestBudget?: RetestBudgetSummaryWire | null;
  distributionSummary?: {
    retestBudget?: RetestBudgetSummaryWire | null;
    upcomingRetests?: Array<{
      id: string;
      status: string;
      milestoneDay: number;
      skipReason?: string | null;
    }>;
  } | null;
};

type ChannelConnectionWire = {
  id: string;
  brandId: string;
  market: GeoMarket;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  status: string;
  credentialHint: string;
};

type PublicPrPacketWire = Record<string, unknown> & {
  brandName?: string;
  category?: string;
  market?: GeoMarket;
  locale?: string;
  verifiedFacts?: Array<{ slot?: string; title?: string; content?: string }>;
};

type PreflightWire = {
  ok?: boolean;
  blockers?: Array<{ code?: string; message?: string }>;
  warnings?: Array<{ code?: string; message?: string }>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCleanDualMarketBrandPayload(
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = buildDualMarketBrandPayload(tag);
  const baseMarkets = (base.markets as Array<Record<string, unknown>>) || [];
  const cleanMarkets = baseMarkets.map((m) =>
    m.market === 'GLOBAL'
      ? {
          ...m,
          localCategory: 'Smart Hardware',
        }
      : m,
  );
  return {
    ...base,
    markets: cleanMarkets,
    ...overrides,
  };
}

async function triggerMaintenance(kind: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${FIXTURE_BASE}/__e2e/maintenance/${encodeURIComponent(kind)}`, {
    method: 'POST',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Maintenance trigger '${kind}' failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function createProductLineApi(
  token: string,
  brandId: string,
  payload: Record<string, unknown>,
): Promise<BrandProductLineWire> {
  const res = await requestV2<BrandProductLineWire>(`/brands/${brandId}/product-lines`, {
    method: 'POST',
    token,
    body: payload,
  });
  return unwrapOk(res, `POST /brands/${brandId}/product-lines`);
}

async function listProductLinesApi(
  token: string,
  brandId: string,
): Promise<BrandProductLineWire[]> {
  const res = await requestV2<{ items?: BrandProductLineWire[] } | BrandProductLineWire[]>(
    `/brands/${brandId}/product-lines`,
    { token },
  );
  return extractItems(unwrapOk(res, `GET /brands/${brandId}/product-lines`));
}

async function pickOnlineEngines(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
  maxCount = 2,
): Promise<string[]> {
  const engines = await listMarketEnginesApi(session, brandId, market);
  const available = engines.filter((e) => e.available !== false).map((e) => e.key);
  expect(available.length, `At least 1 ${market} visibility engine must be online`).toBeGreaterThan(
    0,
  );
  return available.slice(0, maxCount);
}

async function seedArticleViaSse(
  token: string,
  brandId: string,
  body: Record<string, unknown>,
  idemPrefix: string,
): Promise<{
  article: GeoArticleExtendedWire;
  matchedFactIds: string[];
}> {
  const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
    token,
    idempotencyKey: uniqueIdemKey(idemPrefix),
    body,
    timeoutMs: 45_000,
  });
  const article = sse.complete?.article as GeoArticleExtendedWire | undefined;
  expect(
    article?.id,
    `SSE article stream (${idemPrefix}) must return complete.article.id`,
  ).toBeTruthy();
  const metaEvent = sse.events.find((ev) => ev.event === 'meta')?.data as
    { matchedFactIds?: string[] } | undefined;
  const matchedFactIds = Array.isArray(sse.meta?.matchedFactIds)
    ? sse.meta.matchedFactIds
    : Array.isArray(metaEvent?.matchedFactIds)
      ? metaEvent.matchedFactIds
      : [];
  return { article: article!, matchedFactIds };
}

async function pollRetestScheduleStatus(
  token: string,
  articleId: string,
  publishRecordId: string,
  milestoneDay: number,
  targetStatuses: readonly string[],
  timeoutMs = 45_000,
): Promise<RetestScheduleWire> {
  return pollUntil(
    async () => {
      const res = await requestV2<{ items?: PublishRecordWire[] } | PublishRecordWire[]>(
        `/articles/${articleId}/publish-records`,
        { token },
      );
      const records = extractItems(unwrapOk(res, `GET /articles/${articleId}/publish-records`));
      const rec = records.find((r) => r.id === publishRecordId);
      const sched = rec?.retestSchedules?.find((s) => s.milestoneDay === milestoneDay);
      if (!sched) {
        throw new Error(
          `Retest schedule milestone=${milestoneDay} missing on publishRecord=${publishRecordId}`,
        );
      }
      return sched;
    },
    (sched) => targetStatuses.includes(sched.status),
    {
      timeoutMs,
      intervalMs: 500,
      label: `retestSchedule:${publishRecordId}:T+${milestoneDay}`,
    },
  );
}

function extractRetestBudget(home: ActionHomeWire): RetestBudgetSummaryWire | null {
  return home.retestBudget ?? home.distributionSummary?.retestBudget ?? null;
}

async function createDevtoConnectionApi(
  token: string,
  brandId: string,
  displayName: string,
  apiKey: string,
): Promise<ChannelConnectionWire> {
  const res = await requestV2<ChannelConnectionWire>(`/brands/${brandId}/connections`, {
    method: 'POST',
    token,
    body: {
      market: 'GLOBAL',
      provider: 'DEVTO',
      displayName,
      siteBaseUrl: 'https://dev.to',
      credentials: { apiKey },
      configJson: {
        tags: ['geo', 'hardware'],
      },
    },
  });
  return unwrapOk(res, `POST /brands/${brandId}/connections (${displayName})`);
}

async function clickFirstVisible(locator: Locator): Promise<void> {
  await expect(locator.first()).toBeVisible({ timeout: 15_000 });
  await locator.first().click();
}

// ============================================================================
// Tier 1 — Feature Coverage (Category-Partition API & Core Contracts)
// ============================================================================

test.describe('Tier 1 — UX Polish & Multi-Product-Line Feature Coverage', () => {
  test('UX-T1-01: GLOBAL CJK identity hard block (400) & allowCjkGlobalIdentity override across brand and market endpoints', async ({}, testInfo) => {
    test.setTimeout(90_000);
    const tag = uniqueTag(testInfo, 'uxt101');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt101', initialPoints: 100 });
    const token = tenant.session.accessToken;

    // 1. POST /brands with GLOBAL CJK localBrandName -> 400
    const badBrandNameRes = await requestV2('/brands', {
      method: 'POST',
      token,
      body: {
        name: `AstraVolt ${tag}`,
        category: 'Portable Power Station',
        markets: [
          {
            market: 'GLOBAL',
            ...buildGlobalMarketConfig(tag, {
              localBrandName: `星曜海外测试${tag}`,
              localCategory: 'Portable Power Station',
            }),
          },
        ],
      },
    });
    expect(badBrandNameRes.status, 'GLOBAL CJK localBrandName must return 400').toBe(400);
    expect(badBrandNameRes.envelope.code).not.toBe(0);

    // 2. POST /brands with GLOBAL CJK localCategory -> 400
    const badBrandCategoryRes = await requestV2('/brands', {
      method: 'POST',
      token,
      body: {
        name: `AstraVoltCat ${tag}`,
        category: 'Portable Power Station',
        markets: [
          {
            market: 'GLOBAL',
            ...buildGlobalMarketConfig(tag, {
              localBrandName: `AstraVoltCat ${tag}`,
              localCategory: '便携储能电源',
            }),
          },
        ],
      },
    });
    expect(badBrandCategoryRes.status, 'GLOBAL CJK localCategory must return 400').toBe(400);
    expect(badBrandCategoryRes.envelope.code).not.toBe(0);

    // 3. POST /brands with allowCjkGlobalIdentity: true -> 200 & persists CJK values
    const overrideBrandRes = await requestV2<BrandExtendedWire>('/brands', {
      method: 'POST',
      token,
      body: {
        name: `星曜出海品牌${tag}`,
        category: '便携储能电源',
        markets: [
          {
            market: 'GLOBAL',
            ...buildGlobalMarketConfig(tag, {
              localBrandName: `星曜出海${tag}`,
              localCategory: '便携储能电源',
              allowCjkGlobalIdentity: true,
            }),
          },
        ],
      },
    });
    const overrideBrand = unwrapOk(
      overrideBrandRes,
      'POST /brands GLOBAL with allowCjkGlobalIdentity: true',
    );
    const overrideGlobal = overrideBrand.markets.find((m) => m.market === 'GLOBAL');
    expect(overrideGlobal?.localBrandName).toBe(`星曜出海${tag}`);

    // 4. CN market with CJK identity remains completely unaffected (200 without override)
    const cnBrand = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}cn`));
    const cnMarket = cnBrand.markets.find((m) => m.market === 'CN');
    expect(cnMarket?.localBrandName).toContain('星曜智储');

    // 5. POST /brands/:id/markets/GLOBAL with CJK localBrandName -> 400
    const badEnableGlobal = await requestV2(`/brands/${cnBrand.id}/markets/GLOBAL`, {
      method: 'POST',
      token,
      body: buildGlobalMarketConfig(`${tag}g1`, {
        localBrandName: `星曜中文名${tag}`,
        localCategory: 'Portable Power Station',
      }),
    });
    expect(badEnableGlobal.status, 'POST /markets/GLOBAL with CJK localBrandName must be 400').toBe(
      400,
    );

    // 6. POST /brands/:id/markets/GLOBAL with pure English -> 200
    const enBrandName = `NordVolt ${tag}`;
    const enabledBrand = (await enableBrandMarketApi(
      tenant.session,
      cnBrand.id,
      'GLOBAL',
      buildGlobalMarketConfig(`${tag}g2`, {
        localBrandName: enBrandName,
        localCategory: 'Portable Power Station',
      }),
    )) as BrandExtendedWire;
    expect(enabledBrand.markets.find((m) => m.market === 'GLOBAL')?.localBrandName).toBe(
      enBrandName,
    );

    // 7. PATCH /brands/:id/markets/GLOBAL with CJK localBrandName (no override) -> 400 & unchanged
    const badPatchName = await requestV2(`/brands/${cnBrand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: { localBrandName: `被拦截中文${tag}` },
    });
    expect(badPatchName.status, 'PATCH /markets/GLOBAL CJK localBrandName must be 400').toBe(400);

    const badPatchCategory = await requestV2(`/brands/${cnBrand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: { localCategory: '非法中文品类' },
    });
    expect(badPatchCategory.status, 'PATCH /markets/GLOBAL CJK localCategory must be 400').toBe(
      400,
    );

    const checkUnchanged = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${cnBrand.id}`, { token }),
      'GET brand after rejected PATCH',
    );
    expect(checkUnchanged.markets.find((m) => m.market === 'GLOBAL')?.localBrandName).toBe(
      enBrandName,
    );

    // 8. PATCH /brands/:id/markets/GLOBAL with allowCjkGlobalIdentity: true -> 200 & persisted
    const okPatchOverride = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${cnBrand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: {
          localBrandName: `显式放行中文${tag}`,
          allowCjkGlobalIdentity: true,
        },
      }),
      'PATCH /markets/GLOBAL with allowCjkGlobalIdentity: true',
    );
    expect(okPatchOverride.markets.find((m) => m.market === 'GLOBAL')?.localBrandName).toBe(
      `显式放行中文${tag}`,
    );
  });

  test('UX-T1-02: BrandProductLine full CRUD, fact-card productLineId scope filtering & onDelete SetNull historical preservation', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 'uxt102');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt102', initialPoints: 200 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));

    // 1. POST two product lines
    const lineA = await createProductLineApi(token, brand.id, {
      name: `Power Station ${tag}`,
      localNamesJson: { CN: '星曜便携储能', GLOBAL: 'AstraVolt Power' },
      category: '便携储能电源',
      localCategoriesJson: { CN: '便携储能电源', GLOBAL: 'Portable Power Station' },
      seedPromptsJson: {
        CN: ['2026 便携储能电源哪家好？'],
        GLOBAL: ['Best portable power station 2026'],
      },
      competitorsJson: {
        GLOBAL: [{ name: 'Jackery', domains: ['jackery.example'] }],
      },
      sortOrder: 0,
    });
    const lineB = await createProductLineApi(token, brand.id, {
      name: `Home NAS ${tag}`,
      localNamesJson: { CN: '星曜家用NAS', GLOBAL: 'AstraVault NAS' },
      category: '家用NAS网络存储',
      localCategoriesJson: { CN: '家用NAS网络存储', GLOBAL: 'Home NAS' },
      sortOrder: 1,
    });

    // 2. GET ordered by sortOrder ASC
    const listed = await listProductLinesApi(token, brand.id);
    expect(listed.map((l) => l.id)).toEqual([lineA.id, lineB.id]);

    // 3. PATCH Line A
    const updatedName = `Power Station Pro ${tag}`;
    const patchedLineA = unwrapOk(
      await requestV2<BrandProductLineWire>(`/brands/${brand.id}/product-lines/${lineA.id}`, {
        method: 'PATCH',
        token,
        body: {
          name: updatedName,
          localCategoriesJson: { CN: '户外便携储能电源', GLOBAL: 'Portable Power Station' },
        },
      }),
      'PATCH /product-lines/:lineId',
    );
    expect(patchedLineA.name).toBe(updatedName);
    expect(patchedLineA.localCategoriesJson?.GLOBAL).toBe('Portable Power Station');

    // 4. Fact-card productLineId assignment (general null + Line A + Line B with same slot)
    const generalMarker = `GENERAL_CERT_${tag}`;
    const lineAMarker = `LINEA_SPEC_${tag}`;
    const lineBMarker = `LINEB_SPEC_${tag}`;
    await upsertBrandFactsApi(
      tenant.session,
      brand.id,
      [
        {
          slot: 'CREDENTIALS',
          title: 'Brand Global Credentials',
          content: `Verified brand-wide ISO9001 certificate ${generalMarker} valid globally.`,
          sourceType: 'MANUAL',
          productLineId: null,
        },
        {
          slot: 'PRODUCT_SPECS',
          title: 'Power Station Specs',
          content: `2048Wh LiFePO4 battery output 3600W inverter ${lineAMarker}.`,
          sourceType: 'MANUAL',
          productLineId: lineA.id,
        },
        {
          slot: 'PRODUCT_SPECS',
          title: 'Home NAS Specs',
          content: `8-bay 10GbE silent aluminum chassis ${lineBMarker}.`,
          sourceType: 'MANUAL',
          productLineId: lineB.id,
        },
      ],
      true,
    );

    const allFacts = (await listBrandFactsApi(tenant.session, brand.id)) as BrandFactExtendedWire[];
    const generalFact = allFacts.find((f) => f.content.includes(generalMarker));
    const lineAFact = allFacts.find((f) => f.content.includes(lineAMarker));
    const lineBFact = allFacts.find((f) => f.content.includes(lineBMarker));
    expect(generalFact?.productLineId ?? null).toBeNull();
    expect(lineAFact?.productLineId).toBe(lineA.id);
    expect(lineBFact?.productLineId).toBe(lineB.id);

    // Filtered GET /facts?productLineId=lineA.id must never contain Line B's exclusive fact
    const lineAFactsRes = await requestV2<
      { items?: BrandFactExtendedWire[] } | BrandFactExtendedWire[]
    >(`/brands/${brand.id}/facts?productLineId=${lineA.id}`, { token });
    const lineAFacts = extractItems(unwrapOk(lineAFactsRes, 'GET /facts?productLineId=lineA'));
    expect(lineAFacts.some((f) => f.id === lineAFact!.id)).toBe(true);
    expect(lineAFacts.some((f) => f.id === lineBFact!.id)).toBe(false);

    // 5. Seed VisibilityRun, GeoBrief, and GeoArticle bound to Line A
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 1);
    const run = (await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [`Best portable power station for RV camping ${tag}`],
        productLineId: lineA.id,
      },
      uniqueIdemKey('uxt102-run'),
    )) as VisibilityRunExtendedWire;
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const briefRes = await requestV2<GeoBriefExtendedWire>(`/brands/${brand.id}/briefs/generate`, {
      method: 'POST',
      token,
      body: {
        market: 'GLOBAL',
        sourceType: 'MANUAL',
        customPrompt: `Portable power station winter performance guide ${tag}`,
        productLineId: lineA.id,
      },
    });
    const brief = unwrapOk(briefRes, 'POST /briefs/generate with productLineId');
    expect(brief.productLineId).toBe(lineA.id);

    const { article } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Portable power station 3600W benchmark ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        productLineId: lineA.id,
      },
      'uxt102-art',
    );
    expect(article.productLineId).toBe(lineA.id);

    // 6. DELETE Line A -> verify onDelete: SetNull preserves facts, runs, briefs & articles
    unwrapOk(
      await requestV2(`/brands/${brand.id}/product-lines/${lineA.id}`, {
        method: 'DELETE',
        token,
      }),
      'DELETE /product-lines/:lineAId',
    );

    const remainingLines = await listProductLinesApi(token, brand.id);
    expect(remainingLines.map((l) => l.id)).toEqual([lineB.id]);

    const factsAfterDelete = (await listBrandFactsApi(
      tenant.session,
      brand.id,
    )) as BrandFactExtendedWire[];
    const preservedFact = factsAfterDelete.find((f) => f.id === lineAFact!.id);
    expect(preservedFact, 'Fact must survive product-line deletion via SetNull').toBeTruthy();
    expect(preservedFact?.productLineId ?? null).toBeNull();

    const preservedRun = unwrapOk(
      await requestV2<VisibilityRunExtendedWire>(`/brands/${brand.id}/visibility/runs/${run.id}`, {
        token,
      }),
      'GET visibility run after product-line deletion',
    );
    expect(preservedRun.id).toBe(run.id);
    expect(preservedRun.productLineId ?? null).toBeNull();

    const briefsAfterDelete = extractItems(
      unwrapOk(
        await requestV2<{ items?: GeoBriefExtendedWire[] } | GeoBriefExtendedWire[]>(
          `/brands/${brand.id}/briefs?market=GLOBAL`,
          { token },
        ),
        'GET briefs after product-line deletion',
      ),
    );
    const preservedBrief = briefsAfterDelete.find((b) => b.id === brief.id);
    expect(preservedBrief, 'Brief must survive product-line deletion via SetNull').toBeTruthy();
    expect(preservedBrief?.productLineId ?? null).toBeNull();

    const preservedArticle = unwrapOk(
      await requestV2<GeoArticleExtendedWire>(`/articles/${article.id}`, { token }),
      'GET article after product-line deletion',
    );
    expect(preservedArticle.id).toBe(article.id);
    expect(preservedArticle.productLineId ?? null).toBeNull();
  });

  test('UX-T1-03: Dual-product-line fact isolation (0 cross-line bleed incl. >6k vector doc), scoped visibility/briefs/studio, JSON-LD, llms.txt & PR packet category + 15-key whitelist', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'uxt103');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt103', initialPoints: 300 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(
      tenant.session,
      buildCleanDualMarketBrandPayload(tag, {
        name: `HeliosGroup ${tag}`,
        category: 'Smart Hardware',
      }),
    );

    const lineA = await createProductLineApi(token, brand.id, {
      name: 'Power Station Series',
      localNamesJson: { CN: '星曜储能系列', GLOBAL: `HeliosPower ${tag}` },
      category: '便携储能电源',
      localCategoriesJson: { CN: '便携储能电源', GLOBAL: 'Portable Power Station' },
      seedPromptsJson: {
        GLOBAL: [`Best portable power station for off-grid backup ${tag}`],
      },
      competitorsJson: {
        GLOBAL: [{ name: 'Jackery', domains: ['jackery.example'] }],
      },
      sortOrder: 0,
    });

    const lineB = await createProductLineApi(token, brand.id, {
      name: 'Home NAS Series',
      localNamesJson: { CN: '星曜NAS系列', GLOBAL: `HeliosVault ${tag}` },
      category: '家用NAS网络存储',
      localCategoriesJson: { CN: '家用NAS网络存储', GLOBAL: 'Home NAS' },
      seedPromptsJson: {
        GLOBAL: [`Best quiet 4-bay home NAS storage ${tag}`],
      },
      competitorsJson: {
        GLOBAL: [{ name: 'Synology', domains: ['synology.example'] }],
      },
      sortOrder: 1,
    });

    const generalToken = `GEN_ISO9901_${tag}`;
    const lineAToken = `LINEA_ALPHACELL_3600W_${tag}`;
    const lineADiffToken = `LINEA_SOLAR_MPPT_1200W_${tag}`;
    const lineBToken = `LINEB_VAULTCORE_8BAY_RAID_${tag}`;
    const lineBVectorToken = `LINEB_VECTOR_SECRET_${tag}`;

    const savedFacts = (await upsertBrandFactsApi(
      tenant.session,
      brand.id,
      [
        {
          slot: 'CREDENTIALS',
          title: 'Global Master Certifications',
          content: `UL-2743 and ISO-9901 master certification ${generalToken} across all product lines.`,
          sourceType: 'MANUAL',
          productLineId: null,
        },
        {
          slot: 'PRODUCT_SPECS',
          title: 'Portable Power Station Hardware Specs',
          content: `2048Wh LiFePO4 battery pack, 3600W pure sine wave inverter ${lineAToken}, 4000+ cycles.`,
          sourceType: 'MANUAL',
          productLineId: lineA.id,
        },
        {
          slot: 'DIFFERENTIATORS',
          title: 'Portable Power Station Solar Charging',
          content: `Dual MPPT 1200W solar fast input ${lineADiffToken}, 10ms EPS switchover.`,
          sourceType: 'MANUAL',
          productLineId: lineA.id,
        },
        {
          slot: 'PRODUCT_SPECS',
          title: 'Home NAS Storage Hardware Specs',
          content: `8-bay 10GbE ECC RAID appliance ${lineBToken}, 18.5dB ultra-quiet aluminum enclosure.`,
          sourceType: 'MANUAL',
          productLineId: lineB.id,
        },
        {
          slot: 'EXTRA_DOC',
          title: 'Home NAS Long Benchmark Dossier',
          content: buildSizedFactText(6_400, lineBVectorToken),
          sourceType: 'MANUAL',
          productLineId: lineB.id,
        },
      ],
      true,
    )) as BrandFactExtendedWire[];

    const generalFactIds = new Set(
      savedFacts.filter((f) => (f.productLineId ?? null) === null).map((f) => f.id),
    );
    const lineAFactIds = new Set(
      savedFacts.filter((f) => f.productLineId === lineA.id).map((f) => f.id),
    );
    const lineBFactIds = new Set(
      savedFacts.filter((f) => f.productLineId === lineB.id).map((f) => f.id),
    );
    expect(generalFactIds.size).toBe(1);
    expect(lineAFactIds.size).toBe(2);
    expect(lineBFactIds.size).toBe(2);

    // Wait for Line B's >6k EXTRA_DOC fact to finish async pgvector indexing BEFORE generating Line A's article
    const lineBExtraDoc = savedFacts.find(
      (f) => f.slot === 'EXTRA_DOC' && f.productLineId === lineB.id,
    );
    expect(lineBExtraDoc?.id, 'Line B >6k EXTRA_DOC fact must be saved').toBeTruthy();

    const readyLineBExtraDoc = await pollUntil(
      async () => {
        const facts = (await listBrandFactsApi(
          tenant.session,
          brand.id,
        )) as BrandFactExtendedWire[];
        return facts.find((f) => f.id === lineBExtraDoc!.id) ?? null;
      },
      (f) => f !== null && f.indexStatus === 'READY',
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: 'Line B >6k EXTRA_DOC pgvector READY',
      },
    );
    expect(readyLineBExtraDoc?.indexStatus).toBe('READY');

    // Scoped visibility runs for Line A & Line B
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 1);
    const runA = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [`Best portable power station with 3600W inverter ${tag}`],
        productLineId: lineA.id,
      },
      uniqueIdemKey('uxt103-runA'),
    );
    const runB = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [`Best 8-bay home NAS storage with 10GbE ${tag}`],
        productLineId: lineB.id,
      },
      uniqueIdemKey('uxt103-runB'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, runA.id, 45_000);
    await waitForVisibilityRunApi(tenant.session, brand.id, runB.id, 45_000);

    // Assert visibility runs, overview, near-miss, and briefs scoping
    const lineARuns = extractItems(
      unwrapOk(
        await requestV2<{ items?: VisibilityRunExtendedWire[] } | VisibilityRunExtendedWire[]>(
          `/brands/${brand.id}/visibility/runs?market=GLOBAL&productLineId=${lineA.id}`,
          { token },
        ),
        'GET scoped visibility runs (Line A)',
      ),
    );
    expect(lineARuns.some((r) => r.id === runA.id)).toBe(true);
    expect(lineARuns.some((r) => r.id === runB.id)).toBe(false);

    unwrapOk(
      await requestV2(
        `/brands/${brand.id}/visibility/overview?market=GLOBAL&productLineId=${lineA.id}`,
        { token },
      ),
      'GET scoped visibility overview (Line A)',
    );
    unwrapOk(
      await requestV2(
        `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&productLineId=${lineA.id}`,
        { token },
      ),
      'GET scoped visibility near-miss (Line A)',
    );

    const lineABrief = unwrapOk(
      await requestV2<GeoBriefExtendedWire>(`/brands/${brand.id}/briefs/generate`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          sourceType: 'MANUAL',
          customPrompt: `Portable power station camping review ${tag}`,
          productLineId: lineA.id,
        },
      }),
      'POST Line A brief',
    );
    const lineBBrief = unwrapOk(
      await requestV2<GeoBriefExtendedWire>(`/brands/${brand.id}/briefs/generate`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          sourceType: 'MANUAL',
          customPrompt: `Home NAS RAID5 throughput review ${tag}`,
          productLineId: lineB.id,
        },
      }),
      'POST Line B brief',
    );
    const scopedBriefsA = extractItems(
      unwrapOk(
        await requestV2<{ items?: GeoBriefExtendedWire[] } | GeoBriefExtendedWire[]>(
          `/brands/${brand.id}/briefs?market=GLOBAL&productLineId=${lineA.id}`,
          { token },
        ),
        'GET scoped briefs (Line A)',
      ),
    );
    expect(scopedBriefsA.some((b) => b.id === lineABrief.id)).toBe(true);
    expect(scopedBriefsA.some((b) => b.id === lineBBrief.id)).toBe(false);

    // Stream article for Line A -> verify merged Line A + general facts matched, 0 cross-line bleed + JSON-LD + llms.txt
    const { article: articleA, matchedFactIds } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Best portable power station with 3600W LiFePO4 battery and 1200W solar ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        productLineId: lineA.id,
      },
      'uxt103-artA',
    );
    expect(articleA.productLineId).toBe(lineA.id);

    expect(
      matchedFactIds.length,
      'Line A article generation must match at least 1 Line A or brand-general fact',
    ).toBeGreaterThan(0);
    const matchedLineACount = matchedFactIds.filter((id) => lineAFactIds.has(id)).length;
    const matchedGeneralCount = matchedFactIds.filter((id) => generalFactIds.has(id)).length;
    expect(
      matchedLineACount,
      `Line A generation must positively match at least 1 Line A fact (matchedFactIds=${matchedFactIds.join(',')})`,
    ).toBeGreaterThan(0);
    expect(
      matchedGeneralCount,
      `Line A generation must include merged brand-general (productLineId: null) fact (matchedFactIds=${matchedFactIds.join(',')})`,
    ).toBeGreaterThan(0);
    for (const leakedId of matchedFactIds) {
      expect(
        lineBFactIds.has(leakedId),
        `Line B fact ${leakedId} must never match during Line A generation`,
      ).toBe(false);
    }

    const fetchedArticleA = unwrapOk(
      await requestV2<GeoArticleExtendedWire>(`/articles/${articleA.id}`, { token }),
      'GET Line A article',
    );
    expect(fetchedArticleA.contentMarkdown).not.toContain(lineBToken);
    expect(fetchedArticleA.contentMarkdown).not.toContain(lineBVectorToken);

    const lineAArticles = extractItems(
      unwrapOk(
        await requestV2<{ items?: GeoArticleExtendedWire[] } | GeoArticleExtendedWire[]>(
          `/brands/${brand.id}/articles?market=GLOBAL&productLineId=${lineA.id}`,
          { token },
        ),
        'GET Line A articles',
      ),
    );
    const lineBArticles = extractItems(
      unwrapOk(
        await requestV2<{ items?: GeoArticleExtendedWire[] } | GeoArticleExtendedWire[]>(
          `/brands/${brand.id}/articles?market=GLOBAL&productLineId=${lineB.id}`,
          { token },
        ),
        'GET Line B articles',
      ),
    );
    expect(lineAArticles.some((a) => a.id === articleA.id)).toBe(true);
    expect(lineBArticles.some((a) => a.id === articleA.id)).toBe(false);

    // JSON-LD & llms.txt reflect Line A's effective category, never Line B's
    assertValidJsonLd(fetchedArticleA.schemaJsonLd);
    const jsonLdStr =
      typeof fetchedArticleA.schemaJsonLd === 'string'
        ? fetchedArticleA.schemaJsonLd
        : JSON.stringify(fetchedArticleA.schemaJsonLd);
    expect(jsonLdStr).toContain('Portable Power Station');
    expect(jsonLdStr).not.toContain('Home NAS');

    expect(fetchedArticleA.llmsTxtSnippet).toBeTruthy();
    assertValidLlmsTxt(fetchedArticleA.llmsTxtSnippet!);
    expect(fetchedArticleA.llmsTxtSnippet!).toContain('Portable Power Station');
    expect(fetchedArticleA.llmsTxtSnippet!).not.toContain('Home NAS');

    // Public PR Packet: category === 'Portable Power Station', 0 Line B facts, strict 15-key whitelist
    const prVarRes = await requestV2<{ tasks: Array<{ id: string }> }>(
      `/articles/${articleA.id}/distributions/variants`,
      {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey('uxt103-pr') },
        body: {
          targets: [{ provider: 'PR_PACKET', channelLabel: 'PR Media Kit' }],
        },
      },
    );
    const prTaskId = unwrapOk(prVarRes, 'POST PR_PACKET variant').tasks[0]?.id;
    expect(prTaskId).toBeTruthy();

    const shareData = unwrapOk(
      await requestV2<{ token: string; shareUrl: string }>(`/distributions/${prTaskId}/pr-share`, {
        method: 'POST',
        token,
        body: { ttlDays: 30 },
      }),
      'POST pr-share',
    );
    const prToken = shareData.token || shareData.shareUrl.split('/').pop()!;

    const publicPrRes = await requestV2<PublicPrPacketWire>(`/public/pr-packets/${prToken}`);
    const packet = unwrapOk(publicPrRes, 'GET unauthenticated /public/pr-packets/:token');
    expect(packet.category, 'PR packet category must resolve to Line A effective category').toBe(
      'Portable Power Station',
    );

    const packetKeys = Object.keys(packet);
    expect(
      packetKeys.length,
      `Public PR packet must obey strict 15-key whitelist (got ${packetKeys.length}: ${packetKeys.join(', ')})`,
    ).toBeLessThanOrEqual(15);

    const forbiddenKeys = [
      'tenantId',
      'brandId',
      'articleId',
      'taskId',
      'productLineId',
      'userId',
      'username',
      'credentialsCiphertext',
      'shareTokenHash',
      'email',
      'phone',
      'passwordHash',
    ];
    for (const key of forbiddenKeys) {
      expect(packetKeys).not.toContain(key);
    }

    const packetJson = JSON.stringify(packet);
    const packetVerifiedText = JSON.stringify(packet.verifiedFacts ?? []);
    expect(
      packetVerifiedText.includes(lineAToken) ||
        packetVerifiedText.includes(lineADiffToken) ||
        packetVerifiedText.includes(generalToken) ||
        packetJson.includes(lineAToken) ||
        packetJson.includes(lineADiffToken) ||
        packetJson.includes(generalToken),
      'Public PR packet must positively include Line A or brand-general verified facts',
    ).toBe(true);
    expect(packetJson).not.toContain(tenant.tenantId);
    expect(packetJson).not.toContain(lineBToken);
    expect(packetJson).not.toContain(lineBVectorToken);
    expect(packetJson).not.toContain('Home NAS');
  });

  test('UX-T1-04: Monthly retest budget soft cap (SKIPPED_BUDGET_CAP), /home retestBudget, manual actions unblocked & clearing cap allows COMPLETED', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'uxt104');
    // Default SHADOW billing mode verifies estimated/list point accounting works even in SHADOW
    const tenant = await provisionIsolatedTenant({
      prefix: 'uxt104',
      billingMode: 'SHADOW',
      initialPoints: 300,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const { article } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Best quiet 4-bay private cloud NAS ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      'uxt104-art',
    );

    // 1. Set tight cap monthlyRetestPointCap: 1
    const patchedMarket = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { monthlyRetestPointCap: 1 },
      }),
      'PATCH monthlyRetestPointCap = 1',
    );
    expect(patchedMarket.markets.find((m) => m.market === 'GLOBAL')?.monthlyRetestPointCap).toBe(1);

    // 2. Backdated publish record with autoRetest disabled to avoid cron race
    const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const pub1 = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${article.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-cap-1`,
          channel: 'Official Blog',
          publishedAt: tenDaysAgoIso,
          autoRetest: { enabled: false },
        },
      }),
      'POST backdated publish record #1',
    );

    // 3. Enable T+7 schedule and synchronously trigger maintenance sweep
    unwrapOk(
      await requestV2(`/publish-records/${pub1.id}/retest-schedules`, {
        method: 'PATCH',
        token,
        body: { enabled: true, sampleCount: 1, milestones: [7] },
      }),
      'PATCH retest-schedules T+7 enabled',
    );
    await triggerMaintenance('retest-schedule-sweep');

    const skippedSchedule = await pollRetestScheduleStatus(
      token,
      article.id,
      pub1.id,
      7,
      ['SKIPPED_BUDGET_CAP'],
      45_000,
    );
    expect(skippedSchedule.status).toBe('SKIPPED_BUDGET_CAP');
    expect(skippedSchedule.skipReason && skippedSchedule.skipReason.trim().length).toBeGreaterThan(
      0,
    );
    expect(skippedSchedule.visibilityRunId).toBeNull();

    // 4. Verify /home retestBudget contract
    const homeData = unwrapOk(
      await requestV2<ActionHomeWire>(`/brands/${brand.id}/home?market=GLOBAL&days=14`, { token }),
      'GET /home after SKIPPED_BUDGET_CAP',
    );
    const budget = extractRetestBudget(homeData);
    expect(budget, '/home response must include retestBudget summary').toBeTruthy();
    expect(budget!.monthKey).toMatch(/^\d{4}-\d{2}$/);
    expect(budget!.capPoints).toBe(1);
    expect(budget!.usedPoints).toBeGreaterThanOrEqual(0);
    expect(budget!.remainingPoints).not.toBeNull();
    expect(budget!.skippedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify manual actions are NEVER blocked by the soft monthly cap
    const manualRetestRes = await requestV2(`/publish-records/${pub1.id}/retest`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': uniqueIdemKey('uxt104-manual-retest') },
      body: {},
    });
    expect(manualRetestRes.status, 'Manual retest must not be blocked by soft cap').toBe(200);
    expect(manualRetestRes.envelope.code).toBe(0);

    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 1);
    const manualVisRes = await requestV2(`/brands/${brand.id}/visibility/runs`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': uniqueIdemKey('uxt104-manual-vis') },
      body: {
        market: 'GLOBAL',
        engines,
        prompts: [`Manual visibility check under budget cap ${tag}`],
      },
    });
    expect(manualVisRes.status, 'Manual visibility run must not be blocked by soft cap').toBe(200);
    expect(manualVisRes.envelope.code).toBe(0);

    const { article: manualArticle } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Manual studio writing under budget cap ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      'uxt104-manual-art',
    );
    expect(manualArticle.id).toBeTruthy();

    // 6. Clear cap (null) and verify a newly due schedule executes to COMPLETED
    const clearedMarket = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { monthlyRetestPointCap: null },
      }),
      'PATCH monthlyRetestPointCap = null',
    );
    expect(clearedMarket.markets.find((m) => m.market === 'GLOBAL')?.monthlyRetestPointCap).toBe(
      null,
    );

    const pub2 = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${article.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-cap-2`,
          channel: 'Official Blog',
          publishedAt: tenDaysAgoIso,
          autoRetest: { enabled: false },
        },
      }),
      'POST backdated publish record #2',
    );
    unwrapOk(
      await requestV2(`/publish-records/${pub2.id}/retest-schedules`, {
        method: 'PATCH',
        token,
        body: { enabled: true, sampleCount: 1, milestones: [7] },
      }),
      'PATCH retest-schedules T+7 enabled on pub2',
    );
    await triggerMaintenance('retest-schedule-sweep');

    const completedSchedule = await pollRetestScheduleStatus(
      token,
      article.id,
      pub2.id,
      7,
      ['COMPLETED'],
      60_000,
    );
    expect(completedSchedule.status).toBe('COMPLETED');
    expect(completedSchedule.visibilityRunId).toBeTruthy();

    // Confirm SHADOW list-price accounting incremented monthly usedPoints after COMPLETED execution
    const homeAfterCompleted = unwrapOk(
      await requestV2<ActionHomeWire>(`/brands/${brand.id}/home?market=GLOBAL&days=14`, { token }),
      'GET /home after COMPLETED retest schedule',
    );
    const budgetAfterCompleted = extractRetestBudget(homeAfterCompleted);
    expect(
      budgetAfterCompleted,
      '/home must return retestBudget summary after COMPLETED retest',
    ).toBeTruthy();
    expect(
      budgetAfterCompleted!.usedPoints,
      'retestBudget.usedPoints must be > 0 after COMPLETED retest under SHADOW accounting',
    ).toBeGreaterThan(0);
  });

  test('UX-T1-05: Channel connection DISABLED <-> ACTIVE state transitions via PATCH /connections/:id', async ({}, testInfo) => {
    test.setTimeout(90_000);
    const tag = uniqueTag(testInfo, 'uxt105');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt105', initialPoints: 100 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    const conn = await createDevtoConnectionApi(
      token,
      brand.id,
      `Devto Toggle ${tag}`,
      'devto_e2e_toggle_secret_105',
    );

    // Test connection so it enters ACTIVE
    const testRes = unwrapOk(
      await requestV2<{ ok: boolean; status: string }>(
        `/brands/${brand.id}/connections/${conn.id}/test`,
        { method: 'POST', token, body: {} },
      ),
      'POST /connections/:id/test',
    );
    expect(testRes.ok).toBe(true);
    expect(testRes.status).toBe('ACTIVE');

    // Disable -> DISABLED
    const disabled = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections/${conn.id}`, {
        method: 'PATCH',
        token,
        body: { status: 'DISABLED' },
      }),
      'PATCH connection DISABLED',
    );
    expect(disabled.status).toBe('DISABLED');

    const listAfterDisable = unwrapOk(
      await requestV2<{ items: ChannelConnectionWire[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      ),
      'GET connections after DISABLED',
    ).items;
    expect(listAfterDisable.find((c) => c.id === conn.id)?.status).toBe('DISABLED');

    // Re-enable -> ACTIVE
    const reenabled = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections/${conn.id}`, {
        method: 'PATCH',
        token,
        body: { status: 'ACTIVE' },
      }),
      'PATCH connection ACTIVE',
    );
    expect(reenabled.status).toBe('ACTIVE');

    const listAfterEnable = unwrapOk(
      await requestV2<{ items: ChannelConnectionWire[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      ),
      'GET connections after ACTIVE',
    ).items;
    expect(listAfterEnable.find((c) => c.id === conn.id)?.status).toBe('ACTIVE');
  });
});

// ============================================================================
// Tier 2 — Boundary, Corner & Security Negative Cases
// ============================================================================

test.describe('Tier 2 — Boundary, Corner & Security Negative Cases', () => {
  test('UX-T2-01: Max 20 product lines (20th ok, 21st 400), duplicate name (409) & invalid monthlyRetestPointCap (400 / null 200)', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 'uxt201');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt201', initialPoints: 100 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));

    // Create Line 01 first, then immediately verify duplicate name -> 409
    const line01 = await createProductLineApi(token, brand.id, {
      name: `Series-01-${tag}`,
      category: 'Category 01',
      sortOrder: 0,
    });
    const dupCreateRes = await requestV2(`/brands/${brand.id}/product-lines`, {
      method: 'POST',
      token,
      body: {
        name: `Series-01-${tag}`,
        category: 'Category 01 Dup',
      },
    });
    expect(dupCreateRes.status, 'Duplicate product line name must return 409').toBe(409);

    // Create Lines 02..20 (reaching BRAND_MAX_PRODUCT_LINES = 20)
    const createdLines: BrandProductLineWire[] = [line01];
    for (let i = 2; i <= 20; i += 1) {
      const idx = String(i).padStart(2, '0');
      const line = await createProductLineApi(token, brand.id, {
        name: `Series-${idx}-${tag}`,
        category: `Category ${idx}`,
        sortOrder: i - 1,
      });
      createdLines.push(line);
    }
    expect(createdLines).toHaveLength(20);
    expect((await listProductLinesApi(token, brand.id)).length).toBe(20);

    // 21st product line MUST fail with 400
    const line21Res = await requestV2(`/brands/${brand.id}/product-lines`, {
      method: 'POST',
      token,
      body: {
        name: `Series-21-${tag}`,
        category: 'Category 21',
        sortOrder: 20,
      },
    });
    expect(line21Res.status, '21st product line must be rejected with 400').toBe(400);

    // PATCH duplicate name -> 409; empty PATCH -> 400
    const dupPatchRes = await requestV2(`/brands/${brand.id}/product-lines/${createdLines[1].id}`, {
      method: 'PATCH',
      token,
      body: { name: `Series-01-${tag}` },
    });
    expect(dupPatchRes.status, 'PATCH duplicate product line name must return 409').toBe(409);

    const emptyPatchRes = await requestV2(
      `/brands/${brand.id}/product-lines/${createdLines[1].id}`,
      {
        method: 'PATCH',
        token,
        body: {},
      },
    );
    expect(emptyPatchRes.status, 'Empty PATCH body on product line must return 400').toBe(400);

    // Invalid monthlyRetestPointCap values -> 400; valid -> 200; null -> 200
    for (const invalidCap of [0, -5, 12.5]) {
      const badCapRes = await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { monthlyRetestPointCap: invalidCap },
      });
      expect(
        badCapRes.status,
        `monthlyRetestPointCap=${String(invalidCap)} must be rejected with 400`,
      ).toBe(400);
    }

    const validCapRes = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { monthlyRetestPointCap: 50 },
      }),
      'PATCH monthlyRetestPointCap = 50',
    );
    expect(validCapRes.markets.find((m) => m.market === 'GLOBAL')?.monthlyRetestPointCap).toBe(50);

    const clearCapRes = unwrapOk(
      await requestV2<BrandExtendedWire>(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { monthlyRetestPointCap: null },
      }),
      'PATCH monthlyRetestPointCap = null',
    );
    expect(
      clearCapRes.markets.find((m) => m.market === 'GLOBAL')?.monthlyRetestPointCap,
    ).toBeNull();
  });

  test('UX-T2-02: Multi-tenant IDOR (404), cross-brand/tenant productLineId attach rejection & expired tenant 403/40301', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 'uxt202');

    const tenantA = await provisionIsolatedTenant({ prefix: 'uxt202a', initialPoints: 150 });
    const tenantB = await provisionIsolatedTenant({ prefix: 'uxt202b', initialPoints: 150 });
    const tokenA = tenantA.session.accessToken;
    const tokenB = tenantB.session.accessToken;

    const brandA1 = await createBrandApi(
      tenantA.session,
      buildCleanDualMarketBrandPayload(`${tag}a1`),
    );
    const brandA2 = await createBrandApi(
      tenantA.session,
      buildCleanDualMarketBrandPayload(`${tag}a2`),
    );
    const brandB1 = await createBrandApi(
      tenantB.session,
      buildCleanDualMarketBrandPayload(`${tag}b1`),
    );

    const lineA1 = await createProductLineApi(tokenA, brandA1.id, {
      name: `LineA1-${tag}`,
      category: 'Portable Power Station',
    });
    const lineA2 = await createProductLineApi(tokenA, brandA2.id, {
      name: `LineA2-${tag}`,
      category: 'Home NAS',
    });
    const lineB1 = await createProductLineApi(tokenB, brandB1.id, {
      name: `LineB1-${tag}`,
      category: 'Smart Lock',
    });
    const connA1 = await createDevtoConnectionApi(
      tokenA,
      brandA1.id,
      `ConnA1 ${tag}`,
      'devto_e2e_idor_secret_202',
    );

    // 1. Multi-tenant IDOR: Tenant B hitting Tenant A's product-lines & connections -> 404
    const idorGet = await requestV2(`/brands/${brandA1.id}/product-lines`, { token: tokenB });
    expect(idorGet.status, 'Foreign tenant GET /product-lines must return 404').toBe(404);

    const idorPost = await requestV2(`/brands/${brandA1.id}/product-lines`, {
      method: 'POST',
      token: tokenB,
      body: { name: 'Injected', category: 'Injected' },
    });
    expect(idorPost.status, 'Foreign tenant POST /product-lines must return 404').toBe(404);

    const idorPatch = await requestV2(`/brands/${brandA1.id}/product-lines/${lineA1.id}`, {
      method: 'PATCH',
      token: tokenB,
      body: { name: 'Hijacked' },
    });
    expect(idorPatch.status, 'Foreign tenant PATCH /product-lines/:lineId must return 404').toBe(
      404,
    );

    const idorDelete = await requestV2(`/brands/${brandA1.id}/product-lines/${lineA1.id}`, {
      method: 'DELETE',
      token: tokenB,
    });
    expect(idorDelete.status, 'Foreign tenant DELETE /product-lines/:lineId must return 404').toBe(
      404,
    );

    const idorConnPatch = await requestV2(`/brands/${brandA1.id}/connections/${connA1.id}`, {
      method: 'PATCH',
      token: tokenB,
      body: { status: 'DISABLED' },
    });
    expect(idorConnPatch.status, 'Foreign tenant PATCH /connections/:id must return 404').toBe(404);

    // 2. Cross-brand & cross-tenant productLineId rejected (400 or 404) across facts/visibility/briefs/studio
    const engines = await pickOnlineEngines(tenantA.session, brandA1.id, 'GLOBAL', 1);
    for (const [label, foreignLineId] of [
      ['cross-brand', lineA2.id],
      ['cross-tenant', lineB1.id],
    ] as const) {
      const badFactRes = await requestV2(`/brands/${brandA1.id}/facts`, {
        method: 'PUT',
        token: tokenA,
        body: {
          truthAgreed: true,
          facts: [
            {
              slot: 'PRODUCT_SPECS',
              title: 'Foreign Line Fact',
              content: 'Should be rejected for cross-brand productLineId.',
              sourceType: 'MANUAL',
              productLineId: foreignLineId,
            },
          ],
        },
      });
      expect([400, 404], `PUT /facts with ${label} productLineId must be 400 or 404`).toContain(
        badFactRes.status,
      );

      const badVisRes = await requestV2(`/brands/${brandA1.id}/visibility/runs`, {
        method: 'POST',
        token: tokenA,
        headers: { 'Idempotency-Key': uniqueIdemKey(`uxt202-vis-${label}`) },
        body: {
          market: 'GLOBAL',
          engines,
          prompts: [`Cross line visibility check ${tag}`],
          productLineId: foreignLineId,
        },
      });
      expect(
        [400, 404],
        `POST /visibility/runs with ${label} productLineId must be 400 or 404`,
      ).toContain(badVisRes.status);

      const badBriefRes = await requestV2(`/brands/${brandA1.id}/briefs/generate`, {
        method: 'POST',
        token: tokenA,
        body: {
          market: 'GLOBAL',
          sourceType: 'MANUAL',
          customPrompt: `Cross line brief check ${tag}`,
          productLineId: foreignLineId,
        },
      });
      expect(
        [400, 404],
        `POST /briefs/generate with ${label} productLineId must be 400 or 404`,
      ).toContain(badBriefRes.status);

      const badStreamRes = await requestV2(`/brands/${brandA1.id}/articles/stream`, {
        method: 'POST',
        token: tokenA,
        headers: { 'Idempotency-Key': uniqueIdemKey(`uxt202-art-${label}`) },
        body: {
          market: 'GLOBAL',
          targetPrompt: `Cross line stream check ${tag}`,
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          productLineId: foreignLineId,
        },
      });
      expect(
        [400, 404],
        `POST /articles/stream with ${label} productLineId must be 400 or 404`,
      ).toContain(badStreamRes.status);
    }

    // 3. Expired tenant TenantActiveGuard -> 403 (code: 40301)
    const tenantC = await provisionIsolatedTenant({ prefix: 'uxt202c', initialPoints: 100 });
    const tokenC = tenantC.session.accessToken;
    const brandC = await createBrandApi(
      tenantC.session,
      buildCleanDualMarketBrandPayload(`${tag}c`),
    );
    const lineC = await createProductLineApi(tokenC, brandC.id, {
      name: `LineC-${tag}`,
      category: 'Portable Power Station',
    });
    const connC = await createDevtoConnectionApi(
      tokenC,
      brandC.id,
      `ConnC ${tag}`,
      'devto_e2e_expired_secret_202',
    );

    const pastIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setTenantExpiry(tenantC.tenantId, pastIso, true);

    const expPost = await requestV2(`/brands/${brandC.id}/product-lines`, {
      method: 'POST',
      token: tokenC,
      body: { name: 'Expired Line', category: 'Portable Power Station' },
    });
    expect(expPost.status).toBe(403);
    expect(expPost.envelope.code).toBe(40301);

    const expPatch = await requestV2(`/brands/${brandC.id}/product-lines/${lineC.id}`, {
      method: 'PATCH',
      token: tokenC,
      body: { name: 'Expired Rename' },
    });
    expect(expPatch.status).toBe(403);
    expect(expPatch.envelope.code).toBe(40301);

    const expDel = await requestV2(`/brands/${brandC.id}/product-lines/${lineC.id}`, {
      method: 'DELETE',
      token: tokenC,
    });
    expect(expDel.status).toBe(403);
    expect(expDel.envelope.code).toBe(40301);

    const expConn = await requestV2(`/brands/${brandC.id}/connections/${connC.id}`, {
      method: 'PATCH',
      token: tokenC,
      body: { status: 'DISABLED' },
    });
    expect(expConn.status).toBe(403);
    expect(expConn.envelope.code).toBe(40301);
  });

  test('UX-T2-03: GLOBAL CJK edge cases (English brand + CJK localBrandName; CJK brand + omitted localBrandName) & multi-occurrence [待补充]/[TBD] slot integrity', async ({}, testInfo) => {
    test.setTimeout(90_000);
    const tag = uniqueTag(testInfo, 'uxt203');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt203', initialPoints: 150 });
    const token = tenant.session.accessToken;

    // Edge 1: Pure English brand.name + CJK localBrandName on GLOBAL -> 400
    const edge1 = await requestV2('/brands', {
      method: 'POST',
      token,
      body: {
        name: `PureEnglishBrand ${tag}`,
        category: 'Home NAS',
        markets: [
          {
            market: 'GLOBAL',
            ...buildGlobalMarketConfig(tag, {
              localBrandName: `中文覆盖名${tag}`,
              localCategory: 'Home NAS',
            }),
          },
        ],
      },
    });
    expect(edge1.status, 'English brand with CJK GLOBAL localBrandName must return 400').toBe(400);

    // Edge 2: CJK brand.name + omitted localBrandName on GLOBAL -> 400 (fallback must still be blocked)
    const globalWithoutName = buildGlobalMarketConfig(`${tag}omit`, {
      localCategory: 'Home NAS',
    });
    delete globalWithoutName.localBrandName;

    const edge2 = await requestV2('/brands', {
      method: 'POST',
      token,
      body: {
        name: `纯中文母品牌${tag}`,
        category: 'Home NAS',
        markets: [
          {
            market: 'GLOBAL',
            ...globalWithoutName,
          },
        ],
      },
    });
    expect(edge2.status, 'CJK brand.name with omitted GLOBAL localBrandName must return 400').toBe(
      400,
    );

    // Edge 3: CN-only CJK brand enabling GLOBAL without localBrandName -> 400
    const cnBrand = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}cn`));
    const edge3 = await requestV2(`/brands/${cnBrand.id}/markets/GLOBAL`, {
      method: 'POST',
      token,
      body: globalWithoutName,
    });
    expect(edge3.status, 'Enabling GLOBAL omitting localBrandName on CJK brand must be 400').toBe(
      400,
    );

    // Edge 4: Multi-occurrence [待补充：...] / [TBD] slot preservation & preflight clearing
    await upsertBrandFactsApi(tenant.session, cnBrand.id, buildFourBrandFacts(cnBrand.name), true);
    const { article } = await seedArticleViaSse(
      token,
      cnBrand.id,
      {
        market: 'CN',
        targetPrompt: `静音四盘位 NAS 实测噪音与待机功耗指南 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'uxt203-art',
    );

    const multiSlotMd = [
      `# ${cnBrand.name} 实测对比`,
      '',
      '| 指标 | 实测值 | 备注 |',
      '| --- | --- | --- |',
      '| 1 米噪音 | [待补充：实测噪音] | 暗室 24℃ |',
      '| 夜间模式噪音 | [待补充：实测噪音] | 风扇静音档 |',
      '| 待机功耗 | [TBD: standby power] | 四盘休眠 |',
      '',
      '总结：连续 4 小时测试后噪音仍维持在 [待补充：实测噪音] 水平，表现稳定。',
    ].join('\n');

    unwrapOk(
      await requestV2(`/articles/${article.id}`, {
        method: 'PATCH',
        token,
        body: { contentMarkdown: multiSlotMd },
      }),
      'PATCH multi-slot markdown',
    );

    const preflightBlocked = unwrapOk(
      await requestV2<PreflightWire>(`/articles/${article.id}/preflight`, {
        method: 'POST',
        token,
        body: {},
      }),
      'POST preflight with multiple [待补充]/[TBD] slots',
    );
    expect(
      preflightBlocked.ok,
      'Preflight must return ok: false when unresolved [待补充]/[TBD] slots exist',
    ).toBe(false);
    expect(
      (preflightBlocked.blockers ?? []).some((b) => b.code === 'MISSING_FACT_SLOTS'),
      `Preflight blockers must contain MISSING_FACT_SLOTS (got: ${JSON.stringify(preflightBlocked.blockers ?? [])})`,
    ).toBe(true);

    // Replace all occurrences cleanly (preserving table pipes and surrounding punctuation)
    const resolvedMd = multiSlotMd
      .replaceAll('[待补充：实测噪音]', '18.5dB')
      .replaceAll('[TBD: standby power]', '11.2W');
    const updated = unwrapOk(
      await requestV2<GeoArticleExtendedWire>(`/articles/${article.id}`, {
        method: 'PATCH',
        token,
        body: { contentMarkdown: resolvedMd },
      }),
      'PATCH resolved markdown',
    );

    expect(updated.contentMarkdown.match(/18\.5dB/g)?.length).toBe(3);
    expect(updated.contentMarkdown.match(/11\.2W/g)?.length).toBe(1);
    expect(updated.contentMarkdown).not.toMatch(/\[待补充|\[TBD/i);
    expect(updated.contentMarkdown).toContain('| 1 米噪音 | 18.5dB | 暗室 24℃ |');
    expect(updated.contentMarkdown).toContain('| 待机功耗 | 11.2W | 四盘休眠 |');

    // Re-check POST /preflight after resolving all slots -> zero MISSING_FACT_SLOTS blockers remain
    const preflightCleared = unwrapOk(
      await requestV2<PreflightWire>(`/articles/${article.id}/preflight`, {
        method: 'POST',
        token,
        body: {},
      }),
      'POST preflight after resolving all [待补充]/[TBD] slots',
    );
    expect(
      (preflightCleared.blockers ?? []).some((b) => b.code === 'MISSING_FACT_SLOTS'),
      `Preflight must report zero MISSING_FACT_SLOTS blockers after resolution (got: ${JSON.stringify(preflightCleared.blockers ?? [])})`,
    ).toBe(false);
  });
});

// ============================================================================
// Tier 3 — Cross-Feature UI Integration Workflows
// ============================================================================

test.describe('Tier 3 — Cross-Feature UI Integration Workflows', () => {
  test('UX-T3-01: /studio responsive breakpoints, folded prewrite, Focus Mode, AI rewrite dropdown & Bubble Toolbar, right dual-tab', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'uxt301');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt301', initialPoints: 200 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const { article: draftArticle } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `家用四盘位私有云 NAS 静音与散热实测 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'uxt301-draft',
    );

    const { article: publishedArticle } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `小型工作室 4K 影音 NAS 选购清单 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'uxt301-pub',
    );
    unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${publishedArticle.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-studio-pub`,
          channel: '知乎专栏',
          autoRetest: { enabled: false },
        },
      }),
      'Seed publish record on publishedArticle',
    );

    // Start Steps 1-4 at 1440x900 so all 3 panes are open by default (>= 1360px)
    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: { width: 1440, height: 900 },
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    try {
      // 1. Existing draft article auto-collapses prewrite bar
      await page.goto(`/studio?brandId=${brand.id}&market=CN&articleId=${draftArticle.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });

      const collapsedBar = page.getByTestId('studio-prewrite-collapsed-bar');
      await expect(collapsedBar).toBeVisible({ timeout: 15_000 });

      // Expand prewrite bar reveals full config (studio-format-* and studio-advanced-prefs)
      await clickFirstVisible(collapsedBar.getByRole('button', { name: /配置|重写|展开/ }));
      await expect(page.locator('[data-testid^="studio-format-"]').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId('studio-advanced-prefs')).toBeVisible();

      // Clicking "+ 自由选题" auto-expands prewrite config with target prompt input
      await page.getByTestId('studio-free-topic-btn').click();
      await expect(
        page.locator('input[aria-label="目标问题"], textarea[aria-label="目标问题"]').first(),
      ).toBeVisible({ timeout: 10_000 });

      // Re-open draft article from left queue
      await page.getByTestId(`studio-article-item-${draftArticle.id}`).click();
      await expect(collapsedBar).toBeVisible({ timeout: 10_000 });

      // 2. Right pane on /studio shows GEO 体检 with UX_TERMS (AI 追问覆盖度) & sticky 发布中心 CTA;
      //    Published article with publish records on /publish auto-activates 发布追踪与复测
      const rightPane = page.getByTestId('studio-right-pane');
      await expect(rightPane).toBeVisible();
      await expect(page.getByTestId('geo-score-value')).toBeVisible({ timeout: 15_000 });
      await expect(rightPane).toContainText('AI 追问覆盖度');

      await page.getByTestId('studio-go-publish-btn').click();
      await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });
      await expect(page.getByTestId('publish-workspace')).toBeVisible({ timeout: 15_000 });

      // Published article with publish records auto-activates 发布追踪与复测 (studio-publish-retest immediately visible)
      await page.goto(`/publish?brandId=${brand.id}&market=CN&articleId=${publishedArticle.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-publish-retest')).toBeVisible({ timeout: 15_000 });

      // Switch back to draft article for Focus Mode & AI rewrite tests
      await page.goto(`/studio?brandId=${brand.id}&market=CN&articleId=${draftArticle.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-center-pane')).toBeVisible({ timeout: 15_000 });

      // 3. Focus Mode toggle expands center editor >= 75% viewport width & restores on toggle back
      const focusToggle = page
        .getByTestId('studio-focus-mode-btn')
        .or(page.getByRole('button', { name: /专注编辑|退出专注|宽屏/ }))
        .first();
      await expect(focusToggle).toBeVisible({ timeout: 10_000 });
      await focusToggle.click();
      await page.waitForTimeout(150);

      const centerFocusBox = await page.getByTestId('studio-center-pane').boundingBox();
      expect(centerFocusBox, 'studio-center-pane bounding box must exist').toBeTruthy();
      expect(
        centerFocusBox!.width,
        `Focus mode center pane width (${Math.round(centerFocusBox!.width)}px) must be >= 75% of 1440px`,
      ).toBeGreaterThanOrEqual(1440 * 0.75);

      await focusToggle.click();
      await page.waitForTimeout(150);
      await expect(page.getByTestId('studio-right-pane')).toBeVisible();

      // 4. AI Rewrite toolbar dropdown (✨ AI 改写 ▾) & Selection Bubble Toolbar (Escape dismiss)
      const rewriteDropdown = page
        .getByTestId('studio-rewrite-dropdown-btn')
        .or(page.getByRole('button', { name: /AI\s*改写/ }))
        .first();
      await expect(rewriteDropdown).toBeVisible({ timeout: 10_000 });
      await rewriteDropdown.click();
      const dropdownMenuItem = page
        .locator('.ant-dropdown:visible, [role="menu"]:visible')
        .getByText(/更客观|去广告味|对比表格|转表格/)
        .first();
      await expect(dropdownMenuItem).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');

      // Trigger text selection inside editor (supports Markdown textarea or rendered preview)
      const markdownEditor = page.locator('textarea[aria-label="文章 Markdown 正文"]').first();
      const previewBody = page.getByTestId('studio-preview-body');
      if (await markdownEditor.isVisible()) {
        await markdownEditor.evaluate((el: HTMLTextAreaElement) => {
          el.focus();
          el.setSelectionRange(0, Math.min(36, el.value.length));
          el.dispatchEvent(new Event('select', { bubbles: true }));
          el.dispatchEvent(
            new MouseEvent('mouseup', { bubbles: true, clientX: 480, clientY: 320 }),
          );
        });
      } else {
        await expect(previewBody).toBeVisible({ timeout: 10_000 });
        await previewBody.evaluate((container) => {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          let node: Node | null = walker.nextNode();
          while (node && (node.textContent ?? '').trim().length < 12) {
            node = walker.nextNode();
          }
          if (node) {
            const range = document.createRange();
            const len = (node.textContent ?? '').length;
            range.setStart(node, 0);
            range.setEnd(node, Math.min(24, len));
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            const rect = range.getBoundingClientRect();
            container.dispatchEvent(
              new MouseEvent('mouseup', {
                bubbles: true,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height / 2),
              }),
            );
            document.dispatchEvent(new Event('selectionchange'));
          }
        });
      }

      const bubbleToolbar = page
        .getByTestId('studio-selection-bubble')
        .or(page.locator('[role="toolbar"]').filter({ hasText: /更客观|转表格|补数据|精简直答/ }))
        .first();
      await expect(bubbleToolbar).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');
      await expect(bubbleToolbar).toBeHidden({ timeout: 10_000 });

      // 5. Responsive breakpoints: 1280x800 (< 1360px auto-collapsed left rail), 1024x768, 900x800 (<= 920px drawers)
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/studio?brandId=${brand.id}&market=CN&articleId=${draftArticle.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('studio-center-pane')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('studio-prewrite-collapsed-bar')).toBeVisible({
        timeout: 15_000,
      });
      const expandQueueRailBtn = page.getByRole('button', { name: /展开队列/ }).first();
      await expect(
        expandQueueRailBtn,
        'At 1280x800 (< 1360px), opening an existing article must auto-collapse left queue to 44px rail',
      ).toBeVisible({ timeout: 10_000 });
      await expandQueueRailBtn.click();
      await expect(page.getByTestId(`studio-article-item-${draftArticle.id}`)).toBeVisible({
        timeout: 10_000,
      });

      await assertNoHorizontalOverflow(page, { viewports: STUDIO_RESPONSIVE_VIEWPORTS });

      await page.setViewportSize({ width: 900, height: 800 });
      await page.waitForTimeout(150);

      const narrowCenterBox = await page.getByTestId('studio-center-pane').boundingBox();
      expect(narrowCenterBox, 'Center pane must remain readable at 900x800').toBeTruthy();
      expect(narrowCenterBox!.width).toBeGreaterThanOrEqual(480);

      const queueDrawerBtn = page.getByRole('button', { name: /队列/ }).first();
      await expect(queueDrawerBtn).toBeVisible({ timeout: 10_000 });
      await queueDrawerBtn.click();
      await expect(page.getByTestId(`studio-article-item-${draftArticle.id}`)).toBeVisible({
        timeout: 10_000,
      });
      await page.keyboard.press('Escape');
      await expect(page.locator('.ant-drawer-content:visible')).toHaveCount(0, { timeout: 5_000 });

      const checkupDrawerBtn = page.getByRole('button', { name: /体检/ }).first();
      await expect(checkupDrawerBtn).toBeVisible({ timeout: 10_000 });
      await checkupDrawerBtn.click();
      await expect(page.getByTestId('geo-score-value')).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');

      await page.setViewportSize({ width: 1440, height: 900 });
      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });

  test('UX-T3-02: Cold-start <QuickFactExtractModal> (escape hatch & URL extract auto-resume) + deduplicated [TBD] batch-fill slide-over drawer', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'uxt302');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt302', initialPoints: 300 });
    const token = tenant.session.accessToken;

    // Two fresh 0-fact CN brands
    const brandEscape = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}esc`));
    const brandExtract = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}ext`));

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: { width: 1440, height: 900 },
      preseedWorkspace: { activeBrandId: brandEscape.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    try {
      // ── Flow A: 0-fact brand -> <QuickFactExtractModal> -> 跳过并直接生成 escape hatch ──
      await page.goto(`/studio?brandId=${brandEscape.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });

      const promptInputA = page
        .locator('input[aria-label="目标问题"], textarea[aria-label="目标问题"]')
        .first();
      await expect(promptInputA).toBeVisible({ timeout: 10_000 });
      await promptInputA.fill(`零事实卡冷启动跳过测试 ${tag}`);
      await page.getByTestId('studio-stream-btn').click();

      // Scope to .ant-modal-content:visible so both .ant-modal-body and .ant-modal-footer are covered
      const modalA = page.locator('.ant-modal-content:visible').last();
      await expect(modalA).toBeVisible({ timeout: 15_000 });
      await modalA.getByRole('button', { name: /跳过|跳过并直接生成/ }).click();
      await expect(modalA).toBeHidden({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const text = (await page.getByTestId('geo-score-value').innerText()).trim();
            const m = text.match(/\d+/);
            return m ? Number(m[0]) : 0;
          },
          { timeout: 45_000 },
        )
        .toBeGreaterThan(0);

      // ── Flow B: 0-fact brand -> <QuickFactExtractModal> -> URL extract -> save -> auto-resume SSE ──
      await page.goto(`/studio?brandId=${brandExtract.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });

      const promptInputB = page
        .locator('input[aria-label="目标问题"], textarea[aria-label="目标问题"]')
        .first();
      await expect(promptInputB).toBeVisible({ timeout: 10_000 });
      await promptInputB.fill(`官网链接抽取后自动续跑写作测试 ${tag}`);
      await page.getByTestId('studio-stream-btn').click();

      const modalB = page.locator('.ant-modal-content:visible').last();
      await expect(modalB).toBeVisible({ timeout: 15_000 });

      const urlTab = modalB.getByRole('tab', { name: /官网链接|URL/ }).first();
      if (await urlTab.isVisible()) {
        await urlTab.click();
      }
      const urlInput = modalB
        .locator('input[aria-label="官网链接"], input[placeholder*="http"], input[type="url"]')
        .first();
      await expect(urlInput).toBeVisible({ timeout: 10_000 });
      await urlInput.fill(FIXTURE_URLS.cnProduct);

      // Wait for POST /api/v2/brands/:id/facts/extract to complete BEFORE checking truth agreement & saving
      const [extractRes] = await Promise.all([
        page.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            res.url().includes(`/api/v2/brands/${brandExtract.id}/facts/extract`),
          { timeout: 30_000 },
        ),
        clickFirstVisible(modalB.getByRole('button', { name: /提炼|抽取|开始提取|解析/ })),
      ]);
      expect(
        extractRes.status(),
        'POST /facts/extract inside QuickFactExtractModal must return HTTP 200',
      ).toBe(200);

      // Wait for truth agreement checkbox & save button
      const truthCheckbox = modalB.locator('input[type="checkbox"]').last();
      await expect(truthCheckbox).toBeVisible({ timeout: 25_000 });
      if (!(await truthCheckbox.isChecked())) {
        await truthCheckbox.check();
      }
      await clickFirstVisible(
        modalB
          .getByTestId('quick-fact-save-btn')
          .or(modalB.getByRole('button', { name: /保存继续|保存并.*生成|保存事实卡|确认保存/ })),
      );
      await expect(modalB).toBeHidden({ timeout: 20_000 });

      // Confirm facts persisted and SSE auto-resumed to produce a scored article
      const extractedFacts = await listBrandFactsApi(tenant.session, brandExtract.id);
      expect(
        extractedFacts.length,
        'QuickFactExtractModal must persist extracted facts',
      ).toBeGreaterThanOrEqual(1);

      await expect
        .poll(
          async () => {
            const listRes = await requestV2<
              { items?: GeoArticleExtendedWire[] } | GeoArticleExtendedWire[]
            >(`/brands/${brandExtract.id}/articles?market=CN`, { token });
            return extractItems(unwrapOk(listRes, 'GET articles after auto-resume')).length;
          },
          { timeout: 45_000 },
        )
        .toBeGreaterThanOrEqual(1);

      const articlesAfterExtract = extractItems(
        unwrapOk(
          await requestV2<{ items?: GeoArticleExtendedWire[] } | GeoArticleExtendedWire[]>(
            `/brands/${brandExtract.id}/articles?market=CN`,
            { token },
          ),
          'GET Brand B articles',
        ),
      );
      const articleId = articlesAfterExtract[0]!.id;

      // ── Flow C: Deduplicated [TBD] Batch-Fill Slide-Over Drawer ──
      // 3 total tokens across 2 unique hints: 满载功耗 (x2) + 质保周期 (x1)
      const tbdMarkdown = [
        `# ${brandExtract.name} 深度实测报告`,
        '',
        '## 功耗与稳定性',
        '实测四盘位满载功耗为 [待补充：满载功耗] ，连续运行 4 小时后的峰值仍是 [待补充：满载功耗] 。',
        '',
        '## 售后保障',
        '官方整机质保周期为 [待补充：质保周期] ，覆盖核心主板与电源模块。',
      ].join('\n');

      unwrapOk(
        await requestV2(`/articles/${articleId}`, {
          method: 'PATCH',
          token,
          body: { contentMarkdown: tbdMarkdown },
        }),
        'PATCH article with 3 [待补充] slots (2 unique hints)',
      );

      await page.goto(`/studio?brandId=${brandExtract.id}&market=CN&articleId=${articleId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-missing-fact-bar')).toBeVisible({ timeout: 15_000 });

      // Verify publish handoff CTA keeps data-testid="studio-go-publish-btn" before fill
      await expect(page.getByTestId('studio-go-publish-btn')).toBeVisible();

      // Open deduplicated batch-fill slide-over drawer
      const batchFillTrigger = page
        .getByTestId('studio-batch-tbd-open-btn')
        .or(
          page.getByRole('button', {
            name: /补齐事实|补齐\s*2\s*组待补充事实|批量补填|补齐.*待补充/,
          }),
        )
        .first();
      await expect(batchFillTrigger).toBeVisible({ timeout: 10_000 });
      await batchFillTrigger.click();

      // Scope to .ant-drawer-content:visible so both .ant-drawer-body and .ant-drawer-footer are covered
      const batchDrawer = page.locator('.ant-drawer-content:visible').last();
      await expect(batchDrawer).toBeVisible({ timeout: 10_000 });

      // Assert deduplication: exactly 2 text input groups (not 3!) and duplicate hint shows occurrence count 2
      await expect(batchDrawer).toContainText('满载功耗');
      await expect(batchDrawer).toContainText('质保周期');
      await expect(batchDrawer).toContainText(/2\s*处|×\s*2|x\s*2/);

      const drawerTextInputs = batchDrawer.locator(
        'input[type="text"]:not([role="combobox"]), textarea',
      );
      await expect(drawerTextInputs).toHaveCount(2);
      await drawerTextInputs.nth(0).fill('42W');
      await drawerTextInputs.nth(1).fill('3 年质保');

      // Unconditionally assert sync-to-facts toggle/checkbox is visible and enabled
      const syncToggle = batchDrawer
        .locator('input[type="checkbox"], button[role="switch"]')
        .first();
      await expect(
        syncToggle,
        'Batch-fill drawer must render visible syncToFact toggle/checkbox',
      ).toBeVisible({ timeout: 10_000 });
      const isSwitch = (await syncToggle.getAttribute('role')) === 'switch';
      if (isSwitch) {
        if ((await syncToggle.getAttribute('aria-checked')) !== 'true') {
          await syncToggle.click();
        }
      } else if (!(await syncToggle.isChecked())) {
        await syncToggle.check();
      }

      await clickFirstVisible(
        batchDrawer.getByTestId('batch-tbd-submit-btn').or(
          batchDrawer.getByRole('button', {
            name: /全部保存|一键填入全部并保存|全部填入并保存|确认填入/,
          }),
        ),
      );
      await expect(batchDrawer).toBeHidden({ timeout: 15_000 });

      // Post-assertions: missing bar gone, footer CTA shows 去发布
      await expect(page.getByTestId('studio-missing-fact-bar')).toBeHidden({ timeout: 10_000 });
      await expect(page.getByTestId('missing-fact-pill')).toHaveCount(0);
      await expect(page.getByTestId('studio-go-publish-btn')).toContainText(/去发布|前往发布中心/);

      // API verification: all 3 occurrences replaced cleanly & synced to brand fact cards
      const patchedArticle = unwrapOk(
        await requestV2<GeoArticleExtendedWire>(`/articles/${articleId}`, { token }),
        'GET article after batch-fill',
      );
      expect(patchedArticle.contentMarkdown.match(/42W/g)?.length).toBe(2);
      expect(patchedArticle.contentMarkdown.match(/3 年质保/g)?.length).toBe(1);
      expect(patchedArticle.contentMarkdown).not.toMatch(/\[待补充|\[TBD/i);

      const syncedFacts = await listBrandFactsApi(tenant.session, brandExtract.id);
      const joinedFacts = syncedFacts.map((f) => `${f.title} ${f.content}`).join('\n');
      expect(joinedFacts).toContain('42W');
      expect(joinedFacts).toContain('3 年质保');

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });

  test('UX-T3-03: /brands channel disable via confirm() -> /studio hidden + inline <ChannelConnectionCreateModal> -> re-enable + GLOBAL CJK UI guard & override', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'uxt303');
    const tenant = await provisionIsolatedTenant({ prefix: 'uxt303', initialPoints: 200 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const { article } = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Best 4-bay quiet NAS for studios ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      'uxt303-art',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: { width: 1440, height: 900 },
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const collector = attachErrorCollector(page);

    try {
      // 1. Open /brands GLOBAL and create a Webhook connection
      await page.goto(`/brands?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('brand-channel-connections')).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('add-channel-connection-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeVisible();
      await page.getByTestId('channel-provider-select').click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option', {
          hasText: /Webhook/,
        })
        .click();
      await page.getByLabel('连接名称').fill('E2E Disable Webhook');
      await page.getByLabel('站点地址').fill('https://webhook.e2e.example/webhook/publish');
      await page.getByLabel('Webhook 签名密钥').fill('whsec_e2e_disable_secret_303');
      await page.getByTestId('channel-connection-submit-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeHidden({ timeout: 15_000 });

      const connsBefore = unwrapOk(
        await requestV2<{ items: ChannelConnectionWire[] }>(
          `/brands/${brand.id}/connections?market=GLOBAL`,
          { token },
        ),
        'GET connections after create',
      ).items;
      const webhookConn = connsBefore.find((c) => c.displayName === 'E2E Disable Webhook');
      expect(webhookConn?.id).toBeTruthy();

      // 2. Disable via useUxFeedback().confirm() modal
      const webhookCard = page.getByTestId(`channel-connection-card-${webhookConn!.id}`);
      await expect(webhookCard).toBeVisible({ timeout: 10_000 });
      await clickFirstVisible(
        webhookCard
          .getByTestId(`channel-connection-toggle-btn-${webhookConn!.id}`)
          .or(webhookCard.getByRole('button', { name: /停用/ })),
      );

      const confirmModal = page.locator('.ant-modal-confirm:visible').first();
      await expect(confirmModal).toBeVisible({ timeout: 10_000 });
      await clickFirstVisible(confirmModal.getByRole('button', { name: /确认停用|确定|确认/ }));
      await expect(confirmModal).toBeHidden({ timeout: 10_000 });

      await expect(webhookCard).toContainText(/已停用/);
      await expect
        .poll(async () => {
          const list = unwrapOk(
            await requestV2<{ items: ChannelConnectionWire[] }>(
              `/brands/${brand.id}/connections?market=GLOBAL`,
              { token },
            ),
            'GET connections after disable',
          ).items;
          return list.find((c) => c.id === webhookConn!.id)?.status;
        })
        .toBe('DISABLED');

      // 3. /publish distribution workbench hides disabled target, shows disabled hint & supports inline bind
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${article.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-go-publish-btn')).toBeVisible({
        timeout: 20_000,
      });
      await page.getByTestId('studio-go-publish-btn').click();
      await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });

      const distDrawer = page.getByTestId('publish-distribution-workbench');
      await expect(distDrawer).toBeVisible({ timeout: 15_000 });
      await expect(distDrawer.getByTestId(`distribution-target-l1:${webhookConn!.id}`)).toHaveCount(
        0,
      );
      await expect(distDrawer).toContainText(/已停用\s*1\s*个|1\s*个.*停用/);

      // Inline <ChannelConnectionCreateModal> without navigating away from /publish
      await clickFirstVisible(
        distDrawer.getByRole('button', { name: /快捷绑站|绑定自有站|添加.*连接|立即绑定/ }),
      );
      // Scope inlineModal to .ant-modal-content:visible wrapping channel-connection-modal so footer submit btn is included
      const inlineModal = page
        .locator('.ant-modal-content:visible')
        .filter({ has: page.getByTestId('channel-connection-modal') })
        .last();
      await expect(inlineModal).toBeVisible({ timeout: 10_000 });
      expect(page.url()).toContain('/publish');

      await inlineModal.getByTestId('channel-provider-select').click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option', {
          hasText: /WordPress/,
        })
        .click();
      await inlineModal.getByLabel('连接名称').fill('Studio Inline WP');
      await inlineModal.getByLabel('站点地址').fill('https://wp.e2e.example');
      await inlineModal.getByLabel('WordPress 用户名').fill('editor');
      await inlineModal.getByLabel('WordPress Application Password').fill('wp_e2e_app_pass_123456');
      await inlineModal.getByTestId('channel-connection-submit-btn').click();
      await expect(inlineModal).toBeHidden({ timeout: 15_000 });
      expect(page.url()).toContain('/publish');
      await expect(distDrawer).toContainText('Studio Inline WP', { timeout: 15_000 });

      // 4. Return to /brands and re-enable original Webhook connection
      await page.goto(`/brands?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      const webhookCardAgain = page.getByTestId(`channel-connection-card-${webhookConn!.id}`);
      await expect(webhookCardAgain).toBeVisible({ timeout: 15_000 });
      await clickFirstVisible(
        webhookCardAgain
          .getByTestId(`channel-connection-toggle-btn-${webhookConn!.id}`)
          .or(webhookCardAgain.getByRole('button', { name: /重新启用|启用/ })),
      );
      await expect
        .poll(async () => {
          const list = unwrapOk(
            await requestV2<{ items: ChannelConnectionWire[] }>(
              `/brands/${brand.id}/connections?market=GLOBAL`,
              { token },
            ),
            'GET connections after re-enable',
          ).items;
          return list.find((c) => c.id === webhookConn!.id)?.status;
        })
        .toBe('ACTIVE');

      // Assert ZERO console/page errors across Steps 1-4 before Step 5's intentional 400 negative test
      assertNoConsoleOrPageErrors(collector);
      const errorCountBeforeStep5 = collector.errors.length;

      // 5. GLOBAL CJK UI guard block + explicit checkbox override + reload persistence
      const originalGlobalName =
        brand.markets.find((m) => m.market === 'GLOBAL')?.localBrandName ?? '';
      const localNameInput = page.locator('input[aria-label="当地品牌名"]').first();
      await expect(localNameInput).toBeVisible({ timeout: 10_000 });
      await localNameInput.fill('青松海外拦截测试');

      const saveBtn = page
        .getByRole('button', { name: /保存修改/ })
        .or(page.getByRole('button', { name: /保存.*市场/ }))
        .first();
      await expect(saveBtn).toBeVisible({ timeout: 10_000 });
      await saveBtn.click();

      const errorFeedback = page
        .getByTestId('brand-market-error')
        .or(
          page.locator(
            '.ant-alert-error:visible, .ant-form-item-explain-error:visible, .ant-message-error:visible',
          ),
        )
        .first();
      await expect(errorFeedback).toBeVisible({ timeout: 10_000 });

      const afterBlockedSave = unwrapOk(
        await requestV2<BrandExtendedWire>(`/brands/${brand.id}`, { token }),
        'GET brand after UI CJK block',
      );
      expect(afterBlockedSave.markets.find((m) => m.market === 'GLOBAL')?.localBrandName).toBe(
        originalGlobalName,
      );

      // Check explicit override checkbox and save again
      const overrideCheckbox = page
        .getByTestId('allow-cjk-global-identity-checkbox')
        .or(page.getByLabel(/保留中文|我的海外品牌名本身包含中文字符/))
        .first();
      await expect(overrideCheckbox).toBeVisible({ timeout: 10_000 });
      await overrideCheckbox.check();
      await saveBtn.click();

      await expect
        .poll(async () => {
          const b = unwrapOk(
            await requestV2<BrandExtendedWire>(`/brands/${brand.id}`, { token }),
            'GET brand after UI CJK override save',
          );
          return b.markets.find((m) => m.market === 'GLOBAL')?.localBrandName;
        })
        .toBe('青松海外拦截测试');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('input[aria-label="当地品牌名"]').first()).toHaveValue(
        '青松海外拦截测试',
        { timeout: 15_000 },
      );

      // Filter ONLY intentional 400 console error emitted during Step 5's negative CJK validation attempt
      const step5Errors = collector.errors.slice(errorCountBeforeStep5);
      const unexpectedStep5Errors = step5Errors.filter((msg) => !/status of 400\b/.test(msg));
      assertNoConsoleOrPageErrors(unexpectedStep5Errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// Tier 4 — Real-World End-to-End Application Journey
// ============================================================================

test.describe('Tier 4 — Real-World Multi-Product-Line & Budget End-to-End Journey', () => {
  test('UX-T4-01: Single-category zero-noise -> dual product lines -> progressive pills & brand-switch reset -> incognito /share/pr effective category -> /home budget progress bar & SKIPPED_BUDGET_CAP', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const tag = uniqueTag(testInfo, 'uxt401');
    const tenant = await provisionIsolatedTenant({
      prefix: 'uxt401',
      billingMode: 'SHADOW',
      initialPoints: 300,
    });
    const token = tenant.session.accessToken;

    const brand1 = await createBrandApi(
      tenant.session,
      buildCleanDualMarketBrandPayload(`${tag}b1`, {
        name: `VanguardGroup ${tag}`,
        category: 'Smart Hardware',
      }),
    );
    const brand2 = await createBrandApi(
      tenant.session,
      buildCleanDualMarketBrandPayload(`${tag}b2`, {
        name: `SingleLineBrand ${tag}`,
        category: 'Audio Gear',
      }),
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: MULTI_LINE_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand1.id, activeMarket: 'GLOBAL' },
    });
    const collector = attachErrorCollector(page);
    const network404s: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 404 && res.url().includes('/api/v2/')) {
        network404s.push(`${res.request().method()} ${res.url()}`);
      }
    });

    try {
      // ── Step 1: Single-category zero-noise (0 product-line pills on /home, /visibility, /studio) ──
      const zeroNoiseChecks: Array<{ route: string; readySelector: string }> = [
        {
          route: `/home?brandId=${brand1.id}&market=GLOBAL`,
          readySelector: '[data-testid="home-health-strip"]',
        },
        {
          route: `/visibility?brandId=${brand1.id}&market=GLOBAL`,
          readySelector:
            '[data-testid="visibility-workspace"], .gm-workspace-main [role="tablist"]',
        },
        {
          route: `/studio?brandId=${brand1.id}&market=GLOBAL`,
          readySelector: '[data-testid="studio-workspace"]',
        },
      ];
      for (const { route, readySelector } of zeroNoiseChecks) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(readySelector).first()).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 15_000 });
        await expect(
          page.getByTestId('product-line-switcher'),
          `0 product-line switcher pills expected on ${route} for single-category brand`,
        ).toHaveCount(0);
        await expect(
          page.getByTestId('product-line-option-all'),
          `0 product-line-option-all pills expected on ${route}`,
        ).toHaveCount(0);
        await assertNoHorizontalOverflow(page, { viewports: MULTI_LINE_VIEWPORTS });
      }

      // ── Step 2: Create 2 product lines on /brands, tag facts, save & reload monthlyRetestPointCap ──
      await page.goto(`/brands?brandId=${brand1.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      const productLinesSection = page
        .getByTestId('brand-product-lines-section')
        .or(page.locator('#brand-section-product-lines'))
        .first();
      await expect(productLinesSection).toBeVisible({ timeout: 20_000 });

      const createLineInUi = async (name: string, category: string) => {
        await clickFirstVisible(
          productLinesSection.getByTestId('brand-add-product-line-btn').or(
            productLinesSection.getByRole('button', {
              name: /新增产线|新增产品线|添加产品线|新建产品线/,
            }),
          ),
        );
        const openDialog = page
          .locator('.ant-modal-content:visible, .ant-drawer-content:visible')
          .last();
        const nameInput = openDialog
          .getByLabel(/产品线名称/)
          .or(
            openDialog.locator('input[aria-label*="产品线名称"], input[placeholder*="产品线名称"]'),
          )
          .or(productLinesSection.getByLabel(/产品线名称/))
          .or(
            productLinesSection.locator(
              'input[aria-label*="产品线名称"], input[placeholder*="产品线名称"]',
            ),
          )
          .first();
        await expect(nameInput).toBeVisible({ timeout: 10_000 });
        await nameInput.fill(name);

        const categoryInput = openDialog
          .getByLabel(/品类/)
          .or(openDialog.locator('input[aria-label*="品类"], input[placeholder*="品类"]'))
          .or(productLinesSection.getByLabel(/品类/))
          .or(productLinesSection.locator('input[aria-label*="品类"], input[placeholder*="品类"]'))
          .first();
        await expect(categoryInput).toBeVisible({ timeout: 10_000 });
        await categoryInput.fill(category);

        const submitBtn = openDialog
          .getByRole('button', { name: /保存|确认创建|确定|创建/ })
          .or(productLinesSection.getByRole('button', { name: /保存|确认创建|确定|创建/ }))
          .first();
        await expect(submitBtn).toBeVisible({ timeout: 10_000 });
        await submitBtn.click();
        await expect(openDialog).toBeHidden({ timeout: 15_000 });
        await expect(productLinesSection).toContainText(name, { timeout: 15_000 });
      };

      await createLineInUi('Power Station Series', 'Portable Power Station');
      await createLineInUi('Home NAS Series', 'Home NAS');

      const lines = await listProductLinesApi(token, brand1.id);
      const lineA = lines.find((l) => l.name === 'Power Station Series');
      const lineB = lines.find((l) => l.name === 'Home NAS Series');
      expect(lineA?.id, 'Power Station Series must be persisted').toBeTruthy();
      expect(lineB?.id, 'Home NAS Series must be persisted').toBeTruthy();

      // Ensure explicit GLOBAL localCategoriesJson on both lines
      unwrapOk(
        await requestV2(`/brands/${brand1.id}/product-lines/${lineA!.id}`, {
          method: 'PATCH',
          token,
          body: { localCategoriesJson: { GLOBAL: 'Portable Power Station', CN: '便携储能电源' } },
        }),
        'Ensure Line A GLOBAL category',
      );
      unwrapOk(
        await requestV2(`/brands/${brand1.id}/product-lines/${lineB!.id}`, {
          method: 'PATCH',
          token,
          body: { localCategoriesJson: { GLOBAL: 'Home NAS', CN: '家用NAS网络存储' } },
        }),
        'Ensure Line B GLOBAL category',
      );

      // Tag line-scoped + general facts and verify scope selector renders on /brands facts section
      const lineAFactToken = `LINEA_T4_POWER_3600W_${tag}`;
      const lineBFactToken = `LINEB_T4_NAS_8BAY_${tag}`;
      await upsertBrandFactsApi(
        tenant.session,
        brand1.id,
        [
          {
            slot: 'CREDENTIALS',
            title: 'Brand Master Credentials',
            content: `Global ISO-9001 certified manufacturing ${tag}.`,
            sourceType: 'MANUAL',
            productLineId: null,
          },
          {
            slot: 'PRODUCT_SPECS',
            title: 'Power Station Specs',
            content: `2048Wh LiFePO4 3600W pure sine wave portable power ${lineAFactToken}.`,
            sourceType: 'MANUAL',
            productLineId: lineA!.id,
          },
          {
            slot: 'PRODUCT_SPECS',
            title: 'Home NAS Specs',
            content: `8-bay 10GbE RAID storage appliance ${lineBFactToken}.`,
            sourceType: 'MANUAL',
            productLineId: lineB!.id,
          },
        ],
        true,
      );

      // Save & reload monthlyRetestPointCap in /brands UI (expand 对照组 collapsible panel if collapsed per Y8)
      const controlToggle = page.getByTestId('brand-advanced-control-toggle');
      if (
        (await controlToggle.count()) > 0 &&
        (await controlToggle.getAttribute('aria-expanded')) === 'false'
      ) {
        await controlToggle.click();
      }
      const budgetInput = page
        .locator(
          'input[aria-label*="自动复测"], input[aria-label*="预算上限"], [data-testid="market-retest-cap-input"] input, input[data-testid="market-retest-cap-input"]',
        )
        .first();
      await expect(budgetInput).toBeVisible({ timeout: 10_000 });
      await budgetInput.fill('120');
      await clickFirstVisible(
        page
          .getByRole('button', { name: /保存修改/ })
          .or(page.getByRole('button', { name: /保存.*市场/ })),
      );
      await expect
        .poll(async () => {
          const b = unwrapOk(
            await requestV2<BrandExtendedWire>(`/brands/${brand1.id}`, { token }),
            'GET brand1 after UI budget cap save',
          );
          return b.markets.find((m) => m.market === 'GLOBAL')?.monthlyRetestPointCap;
        })
        .toBe(120);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const controlToggleAfterReload = page.getByTestId('brand-advanced-control-toggle');
      await expect(controlToggleAfterReload).toBeVisible({ timeout: 15_000 });
      if ((await controlToggleAfterReload.getAttribute('aria-expanded')) === 'false') {
        await controlToggleAfterReload.click();
      }
      await expect(
        page
          .locator(
            'input[aria-label*="自动复测"], input[aria-label*="预算上限"], [data-testid="market-retest-cap-input"] input, input[data-testid="market-retest-cap-input"]',
          )
          .first(),
      ).toHaveValue('120', { timeout: 15_000 });
      const factsSection = page.locator('#brand-section-facts');
      await expect(factsSection).toBeVisible({ timeout: 15_000 });
      await expect(factsSection).toContainText('Power Station Series');
      await expect(factsSection).toContainText('Home NAS Series');

      // ── Step 3: Progressive product-line pills across /visibility, /studio, /home + brand switch reset ──
      const selectLinePill = async (lineName: string) => {
        const switcher = page
          .getByTestId('product-line-switcher')
          .or(page.locator('[role="radiogroup"], .ant-segmented').filter({ hasText: /^全部/ }))
          .first();
        await expect(switcher).toBeVisible({ timeout: 15_000 });
        await expect(switcher).toContainText('Power Station Series');
        await expect(switcher).toContainText('Home NAS Series');
        await switcher.getByText(lineName, { exact: true }).click();
      };

      await page.goto(`/visibility?brandId=${brand1.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await selectLinePill('Power Station Series');

      await page.goto(`/studio?brandId=${brand1.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await selectLinePill('Power Station Series');

      await page.goto(`/home?brandId=${brand1.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await selectLinePill('Power Station Series');

      // Switch to Brand 2 (0 product lines) -> wait for /home fetch to settle, assert activeProductLineId reset with 0 404s
      const [brand2HomeRes] = await Promise.all([
        page.waitForResponse(
          (res) =>
            res.request().method() === 'GET' &&
            res.url().includes(`/api/v2/brands/${brand2.id}/home`),
          { timeout: 20_000 },
        ),
        switchGlobalBrand(
          page,
          brand2.markets?.find((m) => m.market === 'GLOBAL')?.localBrandName ?? brand2.name,
        ),
      ]);
      expect(brand2HomeRes.status(), 'Brand 2 /home fetch after brand switch must return 200').toBe(
        200,
      );
      expect(
        new URL(brand2HomeRes.url()).searchParams.get('productLineId'),
        'Brand switch must clear activeProductLineId before fetching Brand 2 /home',
      ).toBeNull();
      await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('product-line-switcher')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId('product-line-option-all')).toHaveCount(0);
      expect(network404s, 'Brand switch must reset activeProductLineId with zero 404s').toEqual([]);

      // ── Step 4: Incognito /share/pr/[token] renders Line A effective category & 0 Line B bleed ──
      const { article: lineAArticle } = await seedArticleViaSse(
        token,
        brand1.id,
        {
          market: 'GLOBAL',
          targetPrompt: `Best portable power station with 3600W output ${tag}`,
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          productLineId: lineA!.id,
        },
        'uxt401-artA',
      );
      const prTaskId = unwrapOk(
        await requestV2<{ tasks: Array<{ id: string }> }>(
          `/articles/${lineAArticle.id}/distributions/variants`,
          {
            method: 'POST',
            token,
            headers: { 'Idempotency-Key': uniqueIdemKey('uxt401-pr') },
            body: {
              targets: [{ provider: 'PR_PACKET', channelLabel: 'PR Media Kit' }],
            },
          },
        ),
        'POST Line A PR_PACKET variant',
      ).tasks[0]?.id;
      expect(prTaskId).toBeTruthy();

      const prShareUrl = unwrapOk(
        await requestV2<{ shareUrl: string }>(`/distributions/${prTaskId}/pr-share`, {
          method: 'POST',
          token,
          body: { ttlDays: 30 },
        }),
        'POST Line A pr-share',
      ).shareUrl;
      expect(prShareUrl).toMatch(new RegExp(`^${escapeRegExp(WEB_BASE)}/share/pr/[A-Za-z0-9_-]+$`));

      const incognitoCtx = await browser.newContext({ viewport: MULTI_LINE_VIEWPORTS[0] });
      const incognitoPage = await incognitoCtx.newPage();
      const incognitoCollector = attachErrorCollector(incognitoPage);
      try {
        await incognitoPage.goto(prShareUrl, { waitUntil: 'domcontentloaded' });
        await expect(incognitoPage.getByTestId('pr-share-page')).toBeVisible({ timeout: 20_000 });
        await expect(incognitoPage.getByTestId('pr-share-fact-table')).toBeVisible({
          timeout: 20_000,
        });
        expect(incognitoPage.url()).not.toContain('/login');
        const prBodyText = await incognitoPage.getByTestId('pr-share-page').innerText();
        expect(prBodyText).toContain('Portable Power Station');
        expect(
          prBodyText,
          'Public PR share page must positively render Line A verified fact token',
        ).toContain(lineAFactToken);
        expect(prBodyText).not.toContain('Home NAS');
        expect(prBodyText).not.toContain(lineBFactToken);
        assertNoConsoleOrPageErrors(incognitoCollector);
      } finally {
        await incognitoCtx.close();
      }

      // ── Step 5: Trigger SKIPPED_BUDGET_CAP & verify /home budget progress bar + badge ──
      unwrapOk(
        await requestV2(`/brands/${brand1.id}/markets/GLOBAL`, {
          method: 'PATCH',
          token,
          body: { monthlyRetestPointCap: 1 },
        }),
        'PATCH brand1 monthlyRetestPointCap = 1',
      );
      const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const pubRec = unwrapOk(
        await requestV2<PublishRecordWire>(`/articles/${lineAArticle.id}/publish-records`, {
          method: 'POST',
          token,
          body: {
            publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-t4-budget`,
            channel: 'Official Blog',
            publishedAt: tenDaysAgoIso,
            autoRetest: { enabled: false },
          },
        }),
        'POST backdated publish record for T4 budget board',
      );
      unwrapOk(
        await requestV2(`/publish-records/${pubRec.id}/retest-schedules`, {
          method: 'PATCH',
          token,
          body: { enabled: true, sampleCount: 1, milestones: [7] },
        }),
        'Enable T+7 schedule on T4 publish record',
      );
      await triggerMaintenance('retest-schedule-sweep');
      await pollRetestScheduleStatus(token, lineAArticle.id, pubRec.id, 7, ['SKIPPED_BUDGET_CAP']);

      await page.goto(`/home?brandId=${brand1.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      const distSummary = page.getByTestId('home-distribution-summary');
      await expect(distSummary).toBeVisible({ timeout: 20_000 });
      await expect(distSummary).toContainText(/月度自动复测预算|本月自动复测|复测预算/);
      await expect(distSummary).toContainText(/预算上限|已跳过/);
      const budgetProgressBar = distSummary
        .locator('.ant-progress, [role="progressbar"], [data-testid*="retest-budget"]')
        .first();
      await expect(
        budgetProgressBar,
        '/home distribution summary must display a visible monthly retest budget progress bar',
      ).toBeVisible({ timeout: 10_000 });

      await assertNoHorizontalOverflow(page, { viewports: MULTI_LINE_VIEWPORTS });
      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });
});
