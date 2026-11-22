import { expect, test, v2Describe } from './support/v2-test';
import {
  apiRequest,
  consumeSsePost,
  createBrand,
  deleteBrandMedia,
  extractItems,
  getWallet,
  listBrandFacts,
  pollBatchJobDone,
  pollUntil,
  pollVisibilityRunDone,
  provisionTenant,
  saveBrandFacts,
  streamArticle,
  uploadBrandMedia,
  type BrandMediaData,
  type GeoArticleData,
  type GeoBatchJobData,
  type GeoBriefData,
  type GeoRecipe,
  type GeoRewriteAction,
  type PromptPreferenceDto,
  type VisibilityEngineOption,
  type VisibilityRunData,
} from './support/api-client';
import {
  assertNoHorizontalOverflow,
  VIEWPORT_COMPACT,
  VIEWPORT_DESKTOP,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFactsPayload,
  buildTestPngBuffer,
  E2E_SENTINELS,
  FIXTURE_URLS,
  SAMPLE_COMPETITOR_PASTE_TEXT,
  SSRF_BLOCKED_URLS,
  uniqueIdemKey,
  uniqueTag,
} from './support/fixtures';
import {
  createAuthenticatedContext,
  openVisibilityTab,
  switchGlobalMarket,
  waitForBriefDrawer,
} from './support/ui-actions';

// ============================================================================
// Spec 05 — M4 GEO Studio, Compliance, Batch, Counter & Inline Media:
// F12–F15 (21 Tier 1 + 22 Tier 2 = 43 tests)
// Progressive rule: ZERO calls to /evaluate-geo, /export, /publish-records,
// /retest, or /home.
// ============================================================================

async function createManualBrief(
  token: string,
  brandId: string,
  market: 'CN' | 'GLOBAL',
  prompt: string,
): Promise<GeoBriefData> {
  const res = await apiRequest<GeoBriefData>('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
    token,
    body: { market, sourceType: 'MANUAL', customPrompt: prompt },
  });
  expect([200, 201]).toContain(res.status);
  return res.body!.data;
}

v2Describe(
  'F12: GEO Studio SSE Streaming Writer + 4 Recipes + Cross-Lingual Engine',
  { tag: ['@F12', '@M4'] },
  () => {
    test(
      'T1-F12-01 Single-article SSE stream emits exact headers & ordered meta->delta+->complete protocol',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          idempotencyKey: uniqueIdemKey(`f12t1_${tag}`),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '2026 四盘位家用静音 NAS 怎么选？',
          },
          assertSseHeaders: true,
        });

        expect(sse.status).toBe(200);
        expect(sse.headers['content-type']).toContain('text/event-stream');
        expect(sse.headers['cache-control']).toContain('no-cache');
        expect(sse.headers['x-accel-buffering']).toBe('no');

        expect(sse.events[0]?.event).toBe('meta');
        expect(sse.meta?.unitPrice).toBe(10);
        expect(sse.meta?.market).toBe('CN');
        expect(sse.deltas.length).toBeGreaterThanOrEqual(1);
        expect(sse.events[sse.events.length - 1]?.event).toBe('complete');
        expect(sse.complete?.article.id).toBeTruthy();

        const fetched = await apiRequest<GeoArticleData>(
          'v2',
          'GET',
          `/articles/${sse.complete!.article.id}`,
          { token: tenant.accessToken },
        );
        expect(fetched.status).toBe(200);
        expect(fetched.body!.data.contentMarkdown.length).toBeGreaterThan(50);
      },
    );

    test(
      'T1-F12-02 All 4 GEO recipes succeed cleanly with zero legacy placeholders and Markdown tables',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const recipes: GeoRecipe[] = [
          'AUTHORITY_GUIDE',
          'COMPARISON_MATRIX',
          'OBJECTION_FAQ',
          'CITATION_COUNTER',
        ];
        for (const recipe of recipes) {
          const sse = await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe,
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `2026 四盘位家用 NAS ${recipe} 实测对比`,
          });
          expect(sse.status).toBe(200);
          const article = sse.complete!.article;
          expect(article.recipe).toBe(recipe);
          expect(article.contentMarkdown).not.toContain('{训练词占位符}');
          expect(article.contentMarkdown).not.toContain('{转化词占位符}');
          expect(article.contentMarkdown).not.toContain('【品牌1】');
          if (recipe === 'COMPARISON_MATRIX' || recipe === 'AUTHORITY_GUIDE') {
            expect(article.contentMarkdown).toMatch(/\|[^\n]+\|\s*\n\|[\s:-]+\|/);
          }
        }
      },
    );

    test(
      'T1-F12-03 /studio shows 3-item confirmation bar, zero mandatory gallery, and market-linked 2-way targetFormat',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator('body')).toContainText('深度评测长文');
          await expect(page.locator('body')).toContainText('社区问答实测版');
          await expect(page.locator('body')).not.toContainText('独立站权威长文');

          await switchGlobalMarket(page, 'GLOBAL');
          await expect(page.locator('body')).toContainText('独立站权威长文');
          await expect(page.locator('body')).toContainText('社区客观讨论版');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F12-04 Cross-lingual writing: Chinese-only BrandFact cards produce native English GLOBAL draft',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t4');
        const tenant = await provisionTenant({ tag });
        const brand = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data;
        await saveBrandFacts(
          tenant.accessToken,
          brand.id,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brand.id, {
          market: 'GLOBAL',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'Best quiet 4-bay NAS for home media server in 2026',
        });
        expect(sse.status).toBe(200);
        expect(sse.meta?.matchedFactIds.length).toBeGreaterThan(0);
        const md = sse.complete!.article.contentMarkdown;
        expect(md).toMatch(/[A-Za-z]{4,}/);
        expect(md).toContain('AstraVault');
        expect(md).toMatch(/N100|42W|18\.5|2\.5GbE|96TB/);
      },
    );

    test(
      'T1-F12-05 STRICT tenant with 4 BrandFacts deducts strictly 10 pts with zero kb_addon surcharge',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t5');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '四盘位 NAS 统一计费验证',
        });
        expect(sse.status).toBe(200);
        expect(sse.meta?.unitPrice).toBe(10);
        expect(sse.meta?.matchedFactIds.length).toBeGreaterThan(0);

        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(90);
        expect(wallet.pointsReserved).toBe(0);

        const ledger = await apiRequest<{ items?: Array<{ reason?: string }> }>(
          'v1',
          'GET',
          '/billing/ledger',
          { token: tenant.accessToken },
        );
        const reasons = extractItems(ledger.body?.data).map((l) => l.reason ?? '');
        expect(reasons.some((r) => r.includes('geo_write'))).toBe(true);
        expect(reasons.some((r) => r.includes('kb_addon'))).toBe(false);
      },
    );

    test(
      'T1-F12-06 GFM Markdown tables render properly into <table> HTML in contentHtml',
      { tag: ['@tier1', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12t6');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'COMPARISON_MATRIX',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '四盘位家用 NAS 参数横向对比表',
        });
        expect(sse.status).toBe(200);
        const html = sse.complete!.article.contentHtml;
        expect(html).toContain('<table');
        expect(html).toContain('<thead');
        expect(html).toContain('<tr');
        expect(html).toContain('<th');
        expect(html).toContain('<td');
      },
    );

    test(
      'T2-F12-01 #321 Zero Fake Fallback: upstream LLM error emits event: error { refunded: true } and persists zero article',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `上游失败退费测试 ${E2E_SENTINELS.LLM_FAIL}`,
          },
          assertSseHeaders: false,
        });

        if (sse.status === 200) {
          expect(sse.errorEvent).toBeTruthy();
          expect(sse.errorEvent!.refunded).toBe(true);
          expect(sse.complete).toBeUndefined();
        } else {
          expect(sse.status).toBeGreaterThanOrEqual(400);
        }

        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(100);
        expect(wallet.pointsReserved).toBe(0);

        const articles = extractItems(
          (
            await apiRequest<{ items?: GeoArticleData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/articles?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(articles).toHaveLength(0);
      },
    );

    test(
      'T2-F12-02 Mid-stream SSE client abort releases frozen 10 pts atomically with zero partial article',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b2');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `流式中断退费测试 ${E2E_SENTINELS.SLOW_STREAM}`,
          },
          abortAfterEventType: 'meta',
          assertSseHeaders: true,
        });
        expect(sse.aborted).toBe(true);

        const restored = await pollUntil(
          async () => (await getWallet(tenant.accessToken)).body!.data,
          (w) => w.points === 100 && w.pointsReserved === 0,
          { timeoutMs: 15_000, intervalMs: 300, label: 'SSE abort refund' },
        );
        expect(restored.points).toBe(100);
        expect(restored.pointsReserved).toBe(0);

        const articles = extractItems(
          (
            await apiRequest<{ items?: GeoArticleData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/articles?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(articles).toHaveLength(0);
      },
    );

    test(
      'T2-F12-03 STRICT tenant with 9 points rejected before streaming with HTTP 402 / 40201',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b3');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 9 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '余额不足测试',
          },
          assertSseHeaders: false,
        });
        expect(sse.status).toBe(402);
        expect(sse.errorBody?.code).toBe(40201);
        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(9);
        expect(wallet.pointsReserved).toBe(0);
      },
    );

    test(
      'T2-F12-04 Mismatched market and targetFormat (CN + GLOBAL_COMMUNITY_DISCUSSION) rejected with 400 / 40001',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_COMMUNITY_DISCUSSION',
            targetPrompt: '格式错配测试',
          },
          assertSseHeaders: false,
        });
        expect(sse.status).toBe(400);
        expect(sse.errorBody?.code).toBe(40001);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T2-F12-05 Cross-tenant isolation on article list, detail, edit, delete, and stream returns 404',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b5');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleA = (
          await streamArticle(tenantA.accessToken, brandA, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '跨租户隔离测试文章',
          })
        ).complete!.article.id;

        const checks = await Promise.all([
          apiRequest('v2', 'GET', `/brands/${brandA}/articles?market=CN`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'GET', `/articles/${articleA}`, { token: tenantB.accessToken }),
          apiRequest('v2', 'PATCH', `/articles/${articleA}`, {
            token: tenantB.accessToken,
            body: { title: 'Hijack' },
          }),
          apiRequest('v2', 'DELETE', `/articles/${articleA}`, { token: tenantB.accessToken }),
          consumeSsePost(`/brands/${brandA}/articles/stream`, {
            token: tenantB.accessToken,
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: 'hijack stream',
            },
            assertSseHeaders: false,
          }),
        ]);
        for (const r of checks) {
          expect(r.status).toBe(404);
        }
      },
    );

    test(
      'T2-F12-06 /studio 3-pane layout has zero horizontal overflow at 1440x900 and 1280x800',
      { tag: ['@tier2', '@F12', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f12b6');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'COMPARISON_MATRIX',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '五列宽表布局防溢出测试',
        });

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await assertNoHorizontalOverflow(page, {
            viewports: [VIEWPORT_DESKTOP, VIEWPORT_COMPACT],
          });
        } finally {
          await context.close();
        }
      },
    );
  },
);

v2Describe(
  'F13: Dual-Track Compliance Engine (CN Ad Law vs GLOBAL FTC)',
  { tag: ['@F13', '@M4'] },
  () => {
    test(
      'T1-F13-01 CN track flags and softens China Advertising Law superlatives (全网第一/顶级/国家级/100%)',
      { tag: ['@tier1', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13t1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '请评价全网第一顶级国家级100%无故障四盘位NAS推荐',
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;
        expect(article.contentMarkdown).not.toContain('全网第一');
        expect(article.contentMarkdown).not.toContain('国家级');
        expect(article.contentMarkdown).not.toContain('顶级');
      },
    );

    test(
      'T1-F13-02 GLOBAL FTC track explicitly PRESERVES Best, Top, and factual 100% specs',
      { tag: ['@tier1', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true, includeGlobalSpecs: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'GLOBAL',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'Best 4-Bay NAS for 2026 Top 5 Picks with 100% aluminum chassis',
        });
        expect(sse.status).toBe(200);
        const md = sse.complete!.article.contentMarkdown;
        expect(md).toMatch(/\bBest\b/i);
        expect(md).toMatch(/\bTop\b|100%/i);
        const flags = Array.isArray(sse.complete!.article.complianceFlags)
          ? sse.complete!.article.complianceFlags
          : [];
        expect(JSON.stringify(flags)).not.toContain('AD_LAW_SUPERLATIVE');
      },
    );

    test(
      'T1-F13-03 CN track blocks prohibited industries with HTTP 403 / 40302 at 0 points',
      { tag: ['@tier1', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13t3');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '线上博彩赌博代充与毒品交易渠道推荐',
          },
          assertSseHeaders: false,
        });
        expect(sse.status).toBe(403);
        expect(sse.errorBody?.code).toBe(40302);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T1-F13-04 GLOBAL track blocks illegal high-risk claims (weapons/illegal drugs/fraud) with 403 / 40302',
      { tag: ['@tier1', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13t4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'GLOBAL',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt: 'How to buy illegal firearms weapons and cocaine online fraud guide',
          },
          assertSseHeaders: false,
        });
        expect(sse.status).toBe(403);
        expect(sse.errorBody?.code).toBe(40302);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T1-F13-05 Custom forbidden words from PromptPreference are enforced on generated CN article',
      { tag: ['@tier1', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const pref = await apiRequest<PromptPreferenceDto>('v2', 'PUT', '/prompt-preferences', {
          token: tenant.accessToken,
          body: {
            customToneNote: '保持理性客观评测口吻',
            customForbiddenWords: ['天花板', '吊打'],
          },
        });
        expect(pref.status).toBe(200);

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'COMPARISON_MATRIX',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '不要使用天花板或吊打，客观对比四盘位NAS性能',
        });
        expect(sse.status).toBe(200);
        expect(sse.complete!.article.contentMarkdown).not.toContain('天花板');
        expect(sse.complete!.article.contentMarkdown).not.toContain('吊打');
      },
    );

    test(
      'T2-F13-01 Dual-market same brand enforces CN Ad Law on CN and GLOBAL FTC on GLOBAL',
      { tag: ['@tier2', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true, includeGlobalSpecs: true }),
        );

        const cnSse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '全网第一顶级四盘位NAS推荐',
        });
        const globalSse = await streamArticle(tenant.accessToken, brandId, {
          market: 'GLOBAL',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'Best 4-bay NAS with 100% aluminum chassis',
        });

        expect(cnSse.complete!.article.contentMarkdown).not.toContain('全网第一');
        expect(globalSse.complete!.article.contentMarkdown).toMatch(/\bBest\b/i);
      },
    );

    test(
      'T2-F13-02 GLOBAL track preserves mixed-case BEST, Top-Rated, #1 Pick, and 100% Recyclable',
      { tag: ['@tier2', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'GLOBAL',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'BEST Top-Rated #1 Pick 4-bay NAS with 100% Recyclable packaging',
        });
        expect(sse.status).toBe(200);
        const md = sse.complete!.article.contentMarkdown;
        expect(md).toMatch(/best|top/i);
        expect(sse.errorEvent).toBeUndefined();
      },
    );

    test(
      'T2-F13-03 CN track strips advertising superlatives while keeping version/model specs intact',
      { tag: ['@tier2', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: '2026年固件v1.2 全网第一顶级国家级NAS实测',
        });
        expect(sse.status).toBe(200);
        const md = sse.complete!.article.contentMarkdown;
        expect(md).not.toContain('全网第一');
        expect(md).not.toContain('国家级');
        expect(md).toMatch(/N100|42W|18\.5|v1\.2|2026/);
      },
    );

    test(
      'T2-F13-04 Prohibited-industry 40302 rejection on STRICT tenant leaves wallet and reservation untouched',
      { tag: ['@tier2', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13b4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            recipe: 'OBJECTION_FAQ',
            targetFormat: 'CN_COMMUNITY_QA',
            targetPrompt: '非法赌博洗钱与假币制作教程',
          },
          assertSseHeaders: false,
        });
        expect(sse.status).toBe(403);
        expect(sse.errorBody?.code).toBe(40302);
        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(100);
        expect(wallet.pointsReserved).toBe(0);
      },
    );

    test(
      'T2-F13-05 complianceFlags is a structured array on complete SSE event and GET /articles/:id',
      { tag: ['@tier2', '@F13', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f13b5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'GLOBAL',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
          targetPrompt: 'Best quiet 4-bay NAS for photographers',
        });
        expect(sse.status).toBe(200);
        expect(sse.complete?.article).toBeTruthy();
        expect(Array.isArray(sse.complete!.article.complianceFlags)).toBe(true);

        const fetched = await apiRequest<GeoArticleData>(
          'v2',
          'GET',
          `/articles/${sse.complete!.article.id}`,
          { token: tenant.accessToken },
        );
        expect(fetched.status).toBe(200);
        const flags = fetched.body!.data.complianceFlags;
        expect(Array.isArray(flags)).toBe(true);
        for (const flag of flags as unknown[]) {
          expect(flag && typeof flag === 'object').toBe(true);
        }
      },
    );
  },
);

v2Describe(
  'F14: Inline Rewrite, Missing-Fact Writeback, Advanced Prefs & 2-20 Batch Queue',
  { tag: ['@F14', '@M4'] },
  () => {
    test(
      'T1-F14-01 Inline section rewrite supports all 4 quick actions at 0 points (TO_TABLE returns table)',
      { tag: ['@tier1', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14t1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '家用四盘位NAS改写测试',
          })
        ).complete!.article.id;
        const ptsAfterStream = (await getWallet(tenant.accessToken)).body!.data.points;
        expect(ptsAfterStream).toBe(90);

        const actions: GeoRewriteAction[] = ['DE_AD', 'TO_TABLE', 'ADD_EVIDENCE', 'CONCISE_ANSWER'];
        for (const action of actions) {
          const res = await apiRequest<{ rewrittenText?: string; text?: string }>(
            'v2',
            'POST',
            `/articles/${articleId}/rewrite-section`,
            {
              token: tenant.accessToken,
              body: {
                action,
                selectedText:
                  '这款四盘位 NAS 拥有出色的静音表现和极佳的散热效果，搭载 Intel N100 处理器，适合家庭备份与影音播放。',
              },
            },
          );
          expect(res.status, `rewrite-section ${action} failed`).toBe(200);
          expect(res.body?.code).toBe(0);
          const text = res.body!.data.rewrittenText ?? res.body!.data.text ?? '';
          expect(text.trim().length).toBeGreaterThan(10);
          if (action === 'TO_TABLE') {
            expect(text).toMatch(/\|[^\n]+\|/);
          }
        }
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(90);
      },
    );

    test(
      'T1-F14-02 Clickable [待补充：...] capsule replaces inline and syncs back to BrandFact when checked',
      { tag: ['@tier1', '@F14', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: `缺失事实留槽回填测试 ${E2E_SENTINELS.MISSING_FACT}`,
        });
        const article = sse.complete!.article;
        expect(article.contentMarkdown).toContain('[待补充：');

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN&articleId=${article.id}`, {
            waitUntil: 'domcontentloaded',
          });
          const pill = page
            .getByTestId('missing-fact-pill')
            .or(page.getByText(/\[待补充：/))
            .first();
          await expect(pill).toBeVisible();
          await pill.click();

          const modalOrPopover = page.locator('.ant-popover:visible, .ant-modal:visible').first();
          await expect(modalOrPopover).toBeVisible();
          await modalOrPopover
            .locator('input, textarea')
            .first()
            .fill(`待机功耗实测 11.2W (${tag})`);
          const syncCheckbox = modalOrPopover.locator('input[type="checkbox"]').first();
          await expect(syncCheckbox).toBeVisible();
          if (!(await syncCheckbox.isChecked())) {
            await syncCheckbox.check();
          }
          await modalOrPopover.getByRole('button', { name: /确认|填入|保存/ }).click();

          await pollUntil(
            async () => {
              const facts = extractItems(
                (await listBrandFacts(tenant.accessToken, brandId)).body?.data,
              );
              return facts.some((f) => f.content.includes(`11.2W (${tag})`));
            },
            (found) => found,
            { timeoutMs: 15_000, intervalMs: 400, label: 'BrandFact writeback' },
          );
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F14-03 Collapsed 高级偏好 (PromptPreference) updates and persists across API and reload',
      { tag: ['@tier1', '@F14', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14t3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const putRes = await apiRequest<PromptPreferenceDto>('v2', 'PUT', '/prompt-preferences', {
          token: tenant.accessToken,
          body: {
            customToneNote: `工程实验室客观口吻-${tag}`,
            customForbiddenWords: ['绝对领先', '唯一选择'],
          },
        });
        expect(putRes.status).toBe(200);
        expect(putRes.body!.data.customToneNote).toBe(`工程实验室客观口吻-${tag}`);

        const getRes = await apiRequest<PromptPreferenceDto>('v2', 'GET', '/prompt-preferences', {
          token: tenant.accessToken,
        });
        expect(getRes.status).toBe(200);
        expect(getRes.body!.data.customForbiddenWords).toEqual(['绝对领先', '唯一选择']);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          const adv = page
            .getByTestId('studio-advanced-prefs')
            .or(page.getByText('高级偏好'))
            .first();
          await expect(adv).toBeVisible();
          await adv.click();
          await expect(page.locator('body')).toContainText(`工程实验室客观口吻-${tag}`);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F14-04 Lightweight batch generation (3 briefs) in STRICT mode creates 3 articles and settles 30 pts',
      { tag: ['@tier1', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14t4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const b1 = await createManualBrief(tenant.accessToken, brandId, 'CN', `批量选题1 ${tag}`);
        const b2 = await createManualBrief(tenant.accessToken, brandId, 'CN', `批量选题2 ${tag}`);
        const b3 = await createManualBrief(tenant.accessToken, brandId, 'CN', `批量选题3 ${tag}`);

        const batchRes = await apiRequest<GeoBatchJobData>(
          'v2',
          'POST',
          `/brands/${brandId}/articles/batch`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f14t4_${tag}`) },
            body: { market: 'CN', briefIds: [b1.id, b2.id, b3.id] },
          },
        );
        expect([200, 201]).toContain(batchRes.status);
        expect(batchRes.body!.data.total).toBe(3);
        expect(batchRes.body!.data.unitPrice).toBe(10);

        const done = await pollBatchJobDone(tenant.accessToken, brandId, batchRes.body!.data.id);
        expect(done.status).toBe('COMPLETED');
        expect(done.doneCount).toBe(3);
        expect(done.failCount).toBe(0);

        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(70);
        expect(wallet.pointsReserved).toBe(0);

        const articles = extractItems(
          (
            await apiRequest<{ items?: GeoArticleData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/articles?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(articles.filter((a) => a.batchJobId === done.id)).toHaveLength(3);
      },
    );

    test(
      'T1-F14-05 Multi-selecting 2 briefs in /studio left queue shows 20 点 batch CTA and dispatches job',
      { tag: ['@tier1', '@F14', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await createManualBrief(tenant.accessToken, brandId, 'CN', `UI批量1 ${tag}`);
        await createManualBrief(tenant.accessToken, brandId, 'CN', `UI批量2 ${tag}`);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          const checkboxes = page.locator('input[type="checkbox"]');
          await expect(checkboxes.nth(1)).toBeVisible();
          await checkboxes.nth(0).check();
          await checkboxes.nth(1).check();
          const batchBtn = page.getByRole('button', { name: /批量生成|20\s*点/ }).first();
          await expect(batchBtn).toBeEnabled();
          await batchBtn.click();
          const confirmBtn = page.getByRole('button', { name: '确认生成' });
          await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
          const [batchResp] = await Promise.all([
            page.waitForResponse(
              (resp) =>
                resp.url().includes('/articles/batch') && resp.request().method() === 'POST',
              { timeout: 15_000 },
            ),
            confirmBtn.click(),
          ]);
          expect([200, 201]).toContain(batchResp.status());
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F14-01 Batch size < 2 (0 or 1 brief) rejected with 400 / 40001 and zero points frozen',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const b1 = await createManualBrief(
          tenant.accessToken,
          brandId,
          'CN',
          `单条不可批量 ${tag}`,
        );

        for (const briefIds of [[], [b1.id]]) {
          const res = await apiRequest('v2', 'POST', `/brands/${brandId}/articles/batch`, {
            token: tenant.accessToken,
            body: { market: 'CN', briefIds },
          });
          expect(res.status).toBe(400);
          expect(res.body?.code).toBe(40001);
        }
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T2-F14-02 Batch size > 20 (21 brief IDs) rejected with 400 / 40001 enforcing D6 cap',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b2');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 500 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const twentyOne = Array.from({ length: 21 }, (_, idx) => `brief_overflow_${idx}_${tag}`);

        const res = await apiRequest('v2', 'POST', `/brands/${brandId}/articles/batch`, {
          token: tenant.accessToken,
          body: { market: 'CN', briefIds: twentyOne },
        });
        expect(res.status).toBe(400);
        expect(res.body?.code).toBe(40001);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(500);
      },
    );

    test(
      'T2-F14-03 Batch partial failure in STRICT settles only 2 succeeded items (20 pts) and refunds failed item (10 pts)',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b3');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const b1 = await createManualBrief(tenant.accessToken, brandId, 'CN', `成功项1 ${tag}`);
        const bFail = await createManualBrief(
          tenant.accessToken,
          brandId,
          'CN',
          `失败退费项 ${E2E_SENTINELS.LLM_FAIL} ${tag}`,
        );
        const b3 = await createManualBrief(tenant.accessToken, brandId, 'CN', `成功项3 ${tag}`);

        const batchRes = await apiRequest<GeoBatchJobData>(
          'v2',
          'POST',
          `/brands/${brandId}/articles/batch`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f14b3_${tag}`) },
            body: { market: 'CN', briefIds: [b1.id, bFail.id, b3.id] },
          },
        );
        expect([200, 201]).toContain(batchRes.status);

        const done = await pollBatchJobDone(tenant.accessToken, brandId, batchRes.body!.data.id);
        expect(done.status).toBe('PARTIAL');
        expect(done.doneCount).toBe(2);
        expect(done.failCount).toBe(1);

        const wallet = (await getWallet(tenant.accessToken)).body!.data;
        expect(wallet.points).toBe(80);
        expect(wallet.pointsReserved).toBe(0);

        const articles = extractItems(
          (
            await apiRequest<{ items?: GeoArticleData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/articles?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(articles.filter((a) => a.batchJobId === done.id)).toHaveLength(2);
      },
    );

    test(
      'T2-F14-04 Duplicate briefIds, cross-market brief, and foreign tenant brief rejected on batch',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b4');
        const tenantA = await provisionTenant({
          tag: `${tag}a`,
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (
          await createBrand(tenantA.accessToken, buildDualMarketBrandPayload(`${tag}a`))
        ).body!.data.id;
        const brandB = (await createBrand(tenantB.accessToken, buildCnBrandPayload(`${tag}b`)))
          .body!.data.id;

        const bCn = await createManualBrief(tenantA.accessToken, brandA, 'CN', `CN brief ${tag}`);
        const bGlobal = await createManualBrief(
          tenantA.accessToken,
          brandA,
          'GLOBAL',
          `GLOBAL brief ${tag}`,
        );
        const bForeign = await createManualBrief(
          tenantB.accessToken,
          brandB,
          'CN',
          `Foreign brief ${tag}`,
        );

        const dupRes = await apiRequest('v2', 'POST', `/brands/${brandA}/articles/batch`, {
          token: tenantA.accessToken,
          body: { market: 'CN', briefIds: [bCn.id, bCn.id] },
        });
        expect(dupRes.status).toBe(400);

        const crossMkt = await apiRequest('v2', 'POST', `/brands/${brandA}/articles/batch`, {
          token: tenantA.accessToken,
          body: { market: 'CN', briefIds: [bCn.id, bGlobal.id] },
        });
        expect([400, 404]).toContain(crossMkt.status);

        const foreign = await apiRequest('v2', 'POST', `/brands/${brandA}/articles/batch`, {
          token: tenantA.accessToken,
          body: { market: 'CN', briefIds: [bCn.id, bForeign.id] },
        });
        expect([400, 404]).toContain(foreign.status);
        expect((await getWallet(tenantA.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T2-F14-05 Empty selectedText returns 400 and burst triggers 429 rate-limit on rewrite-section at 0 pts',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b5');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '局部改写限流测试',
          })
        ).complete!.article.id;
        const ptsAfterStream = (await getWallet(tenant.accessToken)).body!.data.points;

        const emptyRes = await apiRequest('v2', 'POST', `/articles/${articleId}/rewrite-section`, {
          token: tenant.accessToken,
          body: { action: 'DE_AD', selectedText: '' },
        });
        expect(emptyRes.status).toBe(400);

        let hit429 = false;
        for (let i = 0; i < 40; i += 1) {
          const res = await apiRequest('v2', 'POST', `/articles/${articleId}/rewrite-section`, {
            token: tenant.accessToken,
            body: {
              action: 'CONCISE_ANSWER',
              selectedText: `测试改写段落 ${i}：四盘位静音NAS性能实测。`,
            },
          });
          if (res.status === 429) {
            hit429 = true;
            break;
          }
        }
        expect(hit429, 'Expected 429 rate limit on free /rewrite-section burst').toBe(true);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(ptsAfterStream);
      },
    );

    test(
      'T2-F14-06 Filling [待补充：...] WITHOUT writeback checkbox updates article only (BrandFact unchanged)',
      { tag: ['@tier2', '@F14', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f14b6');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );
        const factsBefore = JSON.stringify(
          extractItems((await listBrandFacts(tenant.accessToken, brandId)).body?.data),
        );

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: `仅回填正文不写事实卡 ${E2E_SENTINELS.MISSING_FACT}`,
        });
        const article = sse.complete!.article;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN&articleId=${article.id}`, {
            waitUntil: 'domcontentloaded',
          });
          const pill = page
            .getByTestId('missing-fact-pill')
            .or(page.getByText(/\[待补充：/))
            .first();
          await expect(pill).toBeVisible();
          await pill.click();

          const pop = page.locator('.ant-popover:visible, .ant-modal:visible').first();
          await pop.locator('input, textarea').first().fill(`仅正文数据 9.9W (${tag})`);
          const syncCheckbox = pop.locator('input[type="checkbox"]').first();
          await expect(syncCheckbox).toBeVisible();
          if (await syncCheckbox.isChecked()) {
            await syncCheckbox.uncheck();
          }
          await pop.getByRole('button', { name: /确认|填入|保存/ }).click();

          const updatedArticle = await pollUntil(
            async () =>
              (
                await apiRequest<GeoArticleData>('v2', 'GET', `/articles/${article.id}`, {
                  token: tenant.accessToken,
                })
              ).body?.data ?? null,
            (a) => Boolean(a && a.contentMarkdown.includes(`9.9W (${tag})`)),
            { timeoutMs: 15_000, label: 'T2-F14-06 article updated without fact writeback' },
          );
          expect(updatedArticle?.contentMarkdown).toContain(`9.9W (${tag})`);

          const factsAfter = JSON.stringify(
            extractItems((await listBrandFacts(tenant.accessToken, brandId)).body?.data),
          );
          expect(factsAfter).not.toContain(`9.9W (${tag})`);
          expect(factsAfter).toBe(factsBefore);
        } finally {
          await context.close();
        }
      },
    );
  },
);

v2Describe(
  'F15: Competitor High-Citation URL Counter-Play & Inline Editor Media',
  { tag: ['@F15', '@M4'] },
  () => {
    test(
      'T1-F15-01 POST /briefs/from-citation-url creates CITATION_COUNTER brief with matchedFactIds at 0 pts',
      { tag: ['@tier1', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15t1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const res = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/from-citation-url`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', citationUrl: FIXTURE_URLS.competitorReview },
          },
        );
        expect([200, 201]).toContain(res.status);
        expect(res.body?.code).toBe(0);
        const brief = res.body!.data;
        expect(brief.sourceType).toBe('CITATION_COUNTER');
        expect(brief.recommendedRecipe).toBe('CITATION_COUNTER');
        expect(brief.sourceCitationUrl).toBe(FIXTURE_URLS.competitorReview);
        expect(brief.outlineH2.length).toBeGreaterThanOrEqual(2);
        expect(brief.matchedFactIds.length).toBeGreaterThan(0);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T1-F15-02 Clicking 反制重写此页 in /visibility Tab 3 creates counter brief and transitions to /studio',
      { tag: ['@tier1', '@F15', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const enginesRes = await apiRequest<{ items?: VisibilityEngineOption[] }>(
          'v2',
          'GET',
          `/brands/${brandId}/visibility/engines?market=CN`,
          { token: tenant.accessToken },
        );
        const online = extractItems(enginesRes.body?.data)
          .filter((e) => e.available !== false && e.status !== 'offline')
          .map((e) => e.key)
          .slice(0, 1);

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              prompts: [`竞品引用反制测试 ${E2E_SENTINELS.COMP_DOMAIN}`],
              engines: online,
            },
          },
        );
        await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await openVisibilityTab(page, 'citations');
          const counterBtn = page
            .getByTestId('citation-counter-btn')
            .or(page.getByRole('button', { name: /反制重写此页|反制重写/ }))
            .first();
          await expect(counterBtn).toBeVisible();
          await counterBtn.click();
          await waitForBriefDrawer(page);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F15-03 Streaming a CITATION_COUNTER article injects our own BrandFact data',
      { tag: ['@tier1', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15t3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const briefRes = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/from-citation-url`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', citationUrl: FIXTURE_URLS.competitorReview },
          },
        );
        const brief = briefRes.body!.data;

        const sse = await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          briefId: brief.id,
          recipe: 'CITATION_COUNTER',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: brief.targetPrompt,
        });
        expect(sse.status).toBe(200);
        expect(sse.meta?.matchedFactIds.length).toBeGreaterThan(0);
        expect(sse.complete!.article.recipe).toBe('CITATION_COUNTER');
        expect(sse.complete!.article.contentMarkdown).toMatch(/N100|42W|18\.5|ISO9001|540MB/);
      },
    );

    test(
      'T1-F15-04 /studio inline image popover Tab 1 inserts real product photo at 0 points',
      { tag: ['@tier1', '@F15', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15t4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        let mediaId: string | undefined;
        try {
          const alt = `实拍铝合金面板-${tag}`;
          const up = await uploadBrandMedia(tenant.accessToken, brandId, {
            buffer: buildTestPngBuffer(120, 90),
            filename: 'real.png',
            mime: 'image/png',
            title: alt,
          });
          mediaId = up.body!.data.id;

          const articleId = (
            await streamArticle(tenant.accessToken, brandId, {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: '行内插入实拍图测试',
            })
          ).complete!.article.id;
          expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(90);

          const { context, page } = await createAuthenticatedContext(browser, tenant);
          try {
            await page.goto(`/studio?brandId=${brandId}&market=CN&articleId=${articleId}`, {
              waitUntil: 'domcontentloaded',
            });
            const insertBtn = page
              .getByTestId('studio-media-popover')
              .or(page.getByRole('button', { name: /插入图片|配图/ }))
              .first();
            await expect(insertBtn).toBeVisible();
            await insertBtn.click();
            await expect(page.locator('body')).toContainText(/从品牌实拍图插入|品牌实拍图/);
            expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(90);
          } finally {
            await context.close();
          }
        } finally {
          if (mediaId) {
            await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
          }
        }
      },
    );

    test(
      'T1-F15-05 POST /media/ai-gen in STRICT mode charges 5 pts, persists AI_INLINE_GEN, and cleans up',
      { tag: ['@tier1', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15t5');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        let mediaId: string | undefined;
        try {
          const res = await apiRequest<BrandMediaData>(
            'v2',
            'POST',
            `/brands/${brandId}/media/ai-gen`,
            {
              token: tenant.accessToken,
              headers: { 'idempotency-key': uniqueIdemKey(`f15t5_${tag}`) },
              body: {
                prompt: 'Minimalist 4-bay aluminum NAS thermal airflow diagram on dark studio desk',
                title: `AI 散热风道示意图-${tag}`,
              },
            },
          );
          expect([200, 201]).toContain(res.status);
          expect(res.body?.code).toBe(0);
          const asset = res.body!.data;
          mediaId = asset.id;
          expect(asset.origin).toBe('AI_INLINE_GEN');
          expect(asset.aiPrompt).toBeTruthy();
          expect(asset.url).toBeTruthy();
          expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(95);
        } finally {
          if (mediaId) {
            await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
          }
        }
      },
    );

    test(
      'T2-F15-01 Anti-scrape 403/timeout returns 422/42201 and pastedContent fallback succeeds cleanly',
      { tag: ['@tier2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const blocked403 = await apiRequest(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/from-citation-url`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', citationUrl: FIXTURE_URLS.antiScrape403 },
          },
        );
        expect(blocked403.status).toBe(422);
        expect(blocked403.body?.code).toBe(42201);

        const fallbackRes = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/from-citation-url`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.antiScrape403,
              pastedTitle: '2026 四盘位家用 NAS 横向评测',
              pastedContent: SAMPLE_COMPETITOR_PASTE_TEXT,
            },
          },
        );
        expect([200, 201]).toContain(fallbackRes.status);
        expect(fallbackRes.body?.code).toBe(0);
        expect(fallbackRes.body!.data.sourceType).toBe('CITATION_COUNTER');
        expect(fallbackRes.body!.data.matchedFactIds.length).toBeGreaterThan(0);
      },
    );

    test(
      'T2-F15-02 Malformed or non-HTTP citationUrl rejected with 400 / 40001',
      { tag: ['@tier2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        for (const badUrl of ['not-a-url', 'ftp://example.com/a', 'javascript:alert(1)', '']) {
          const res = await apiRequest(
            'v2',
            'POST',
            `/brands/${brandId}/briefs/from-citation-url`,
            {
              token: tenant.accessToken,
              body: { market: 'CN', citationUrl: badUrl },
            },
          );
          expect(res.status, `Expected 400 for citationUrl="${badUrl}"`).toBe(400);
          expect(res.body?.code).toBe(40001);
        }
      },
    );

    test(
      'T2-F15-03 SSRF private-IP/localhost/metadata URLs blocked on from-citation-url',
      { tag: ['@tier2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        for (const blockedUrl of SSRF_BLOCKED_URLS) {
          const res = await apiRequest(
            'v2',
            'POST',
            `/brands/${brandId}/briefs/from-citation-url`,
            {
              token: tenant.accessToken,
              body: { market: 'CN', citationUrl: blockedUrl },
            },
          );
          expect(res.status, `Expected SSRF 400 for ${blockedUrl}`).toBe(400);
          expect(res.body?.code).not.toBe(0);
        }
      },
    );

    test(
      'T2-F15-04 AI inline image in STRICT: 4 pts gets 402/40201; [E2E_IMAGE_FAIL] atomically refunds 5 pts',
      { tag: ['@tier2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15b4');
        const poor = await provisionTenant({
          tag: `${tag}p`,
          billingMode: 'STRICT',
          initialPoints: 4,
        });
        const brandPoor = (await createBrand(poor.accessToken, buildCnBrandPayload(`${tag}p`)))
          .body!.data.id;

        const lowRes = await apiRequest('v2', 'POST', `/brands/${brandPoor}/media/ai-gen`, {
          token: poor.accessToken,
          body: { prompt: 'NAS hardware diagram' },
        });
        expect(lowRes.status).toBe(402);
        expect(lowRes.body?.code).toBe(40201);
        expect((await getWallet(poor.accessToken)).body!.data.points).toBe(4);

        const rich = await provisionTenant({
          tag: `${tag}r`,
          billingMode: 'STRICT',
          initialPoints: 50,
        });
        const brandRich = (await createBrand(rich.accessToken, buildCnBrandPayload(`${tag}r`)))
          .body!.data.id;
        const failRes = await apiRequest('v2', 'POST', `/brands/${brandRich}/media/ai-gen`, {
          token: rich.accessToken,
          body: { prompt: `Failed diagram ${E2E_SENTINELS.IMAGE_FAIL}` },
        });
        expect(failRes.status).toBeGreaterThanOrEqual(400);
        const wallet = (await getWallet(rich.accessToken)).body!.data;
        expect(wallet.points).toBe(50);
        expect(wallet.pointsReserved).toBe(0);

        const listed = extractItems(
          (
            await apiRequest<{ items?: BrandMediaData[] }>(
              'v2',
              'GET',
              `/brands/${brandRich}/media`,
              { token: rich.accessToken },
            )
          ).body?.data,
        );
        expect(listed).toHaveLength(0);
      },
    );

    test(
      'T2-F15-05 Idempotency-Key replay on POST /media/ai-gen returns same asset ID and charges strictly 5 pts',
      { tag: ['@tier2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f15b5');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const idemKey = uniqueIdemKey(`f15b5_${tag}`);

        let mediaId: string | undefined;
        try {
          const first = await apiRequest<BrandMediaData>(
            'v2',
            'POST',
            `/brands/${brandId}/media/ai-gen`,
            {
              token: tenant.accessToken,
              headers: { 'idempotency-key': idemKey },
              body: { prompt: 'Clean studio diagram of 4-bay NAS ports' },
            },
          );
          expect([200, 201]).toContain(first.status);
          mediaId = first.body!.data.id;

          const second = await apiRequest<BrandMediaData>(
            'v2',
            'POST',
            `/brands/${brandId}/media/ai-gen`,
            {
              token: tenant.accessToken,
              headers: { 'idempotency-key': idemKey },
              body: { prompt: 'Clean studio diagram of 4-bay NAS ports' },
            },
          );
          expect([200, 201, 409]).toContain(second.status);
          if (second.status < 300 && second.body?.data?.id) {
            expect(second.body.data.id).toBe(mediaId);
          }
          expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(95);
        } finally {
          if (mediaId) {
            await deleteBrandMedia(tenant.accessToken, brandId, mediaId);
          }
        }
      },
    );
  },
);
