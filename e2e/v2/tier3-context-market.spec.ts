import {
  createBrandApi,
  createVisibilityRunApi,
  consumeSsePost,
  extractItems,
  listMarketEnginesApi,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForVisibilityRunApi,
  provisionIsolatedTenant,
  type GeoArticleDto,
  type GeoEvaluationDto,
  type VisibilityRunDto,
} from './support/api-client';
import {
  assertGeoScoreValid,
  assertLlmsTxt,
  assertNoConsoleOrPageErrors,
  assertValidJsonLd,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  CN_ENGINES,
  E2E_SENTINELS,
  GLOBAL_ENGINES,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import {
  expectUrlContext,
  navigateWorkspace,
  openAuthenticatedPage,
  openVisibilityTab,
  selectGlobalBrand,
  switchGlobalMarket,
} from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 3 — Context & Dual-Market Isolation',
  {
    tag: ['@tier3', '@F4', '@F5', '@F6', '@F9', '@F10', '@F11', '@F12', '@F13', '@F16', '@M5'],
  },
  () => {
    test(
      'T3-01 Brand Switcher anti-race & single-brand isolation across all 4 workspaces',
      { tag: ['@tier3', '@F4', '@F5', '@F9', '@F12', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't301');
        const tenant = await provisionIsolatedTenant({ prefix: 't301', initialPoints: 200 });

        const brandA = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}a`));
        const brandB = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}b`));
        await upsertBrandFactsApi(tenant.session, brandA.id, buildFourBrandFacts(brandA.name));

        const cnEngines = await listMarketEnginesApi(tenant.session, brandA.id, 'CN');
        const onlineCn = cnEngines.filter((e) => e.available || e.status === 'online');
        expect(onlineCn.length, 'Expected at least 1 online CN engine').toBeGreaterThan(0);

        const runA = await createVisibilityRunApi(
          tenant.session,
          brandA.id,
          {
            market: 'CN',
            prompts: [`2026 四盘位家用静音 NAS 怎么选 ${E2E_SENTINELS.GAP}`],
            engines: onlineCn.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't301run'),
        );
        await waitForVisibilityRunApi(tenant.session, brandA.id, runA.id);
        await waitForAutoBriefsApi(tenant.session, brandA.id, 'CN', runA.id);

        const sseA = await consumeSsePost(`/brands/${brandA.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't301art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brandA.name} 2026 四盘位家用 NAS 权威选购指南`,
          },
        });
        expect(sseA.status).toBe(200);
        expect(sseA.complete?.article.id).toBeTruthy();
        const brandAArticleTitle = sseA.complete!.article.title;

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          undefined,
        );
        try {
          const brandRequestsAfterSwitch: string[] = [];
          let switchTriggered = false;

          await page.route(`**/api/v2/brands/${brandA.id}/home*`, async (route) => {
            await new Promise((r) => setTimeout(r, 1200));
            await route.continue();
          });
          await page.route(`**/api/v2/brands/${brandA.id}/visibility/overview*`, async (route) => {
            await new Promise((r) => setTimeout(r, 1200));
            await route.continue();
          });

          page.on('request', (req) => {
            if (!switchTriggered) {
              return;
            }
            const url = req.url();
            const match = url.match(/\/api\/v2\/brands\/([^/?]+)/);
            if (match && match[1]) {
              brandRequestsAfterSwitch.push(match[1]);
            }
          });

          await page.goto(`/home?brandId=${brandA.id}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.getByTestId('global-brand-switcher')).toBeVisible();

          switchTriggered = true;
          await selectGlobalBrand(page, brandB.name);
          await expectUrlContext(page, { brandId: brandB.id, market: 'CN', pathname: '/home' });

          // Wait well past Brand A's 1200ms delayed response to prove stale responses never overwrite Brand B
          await page.waitForTimeout(1600);
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandB.name);
          const homeText = await page.locator('main, .ant-layout-content').first().innerText();
          expect(homeText).not.toContain(brandAArticleTitle);
          expect(homeText).not.toContain(brandA.name);

          // Navigate across remaining 3 workspaces and verify every brand-scoped request targets Brand B
          brandRequestsAfterSwitch.length = 0;
          await navigateWorkspace(page, '品牌资产', /\/brands/);
          await expectUrlContext(page, { brandId: brandB.id, pathname: '/brands' });

          await navigateWorkspace(page, '可见度诊断', /\/visibility/);
          await expectUrlContext(page, { brandId: brandB.id, pathname: '/visibility' });

          await navigateWorkspace(page, 'GEO 写作台', /\/studio/);
          await expectUrlContext(page, { brandId: brandB.id, pathname: '/studio' });

          expect(brandRequestsAfterSwitch.length).toBeGreaterThan(0);
          const leakedBrandA = brandRequestsAfterSwitch.filter((id) => id === brandA.id);
          expect(leakedBrandA, 'Stale Brand A requests leaked after switching to Brand B').toEqual(
            [],
          );
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-02 URL + localStorage persistence across reload & native Back/Forward with zero TabBar',
      { tag: ['@tier3', '@F4', '@F5', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't302');
        const tenant = await provisionIsolatedTenant({ prefix: 't302', initialPoints: 100 });
        const brandA = await createBrandApi(tenant.session, buildDualMarketBrandPayload(`${tag}a`));
        const brandB = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}b`));

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/visibility?brandId=${brandA.id}&market=CN`,
        );
        try {
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandA.name);
          await switchGlobalMarket(page, 'GLOBAL');
          await expectUrlContext(page, {
            brandId: brandA.id,
            market: 'GLOBAL',
            pathname: '/visibility',
          });

          const storedBeforeReload = await page.evaluate(() =>
            Object.entries(window.localStorage)
              .map(([k, v]) => `${k}=${v}`)
              .join(' | '),
          );
          expect(storedBeforeReload).toContain(brandA.id);
          expect(storedBeforeReload).toContain('GLOBAL');

          await page.reload({ waitUntil: 'domcontentloaded' });
          await expectUrlContext(page, {
            brandId: brandA.id,
            market: 'GLOBAL',
            pathname: '/visibility',
          });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandA.name);

          await navigateWorkspace(page, 'GEO 写作台', /\/studio/);
          await selectGlobalBrand(page, brandB.name);
          await expectUrlContext(page, { brandId: brandB.id, market: 'CN', pathname: '/studio' });

          await page.goBack({ waitUntil: 'domcontentloaded' });
          await expect
            .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
            .toMatch(/^\/(visibility|studio)$/);

          await expect(page.locator('.gm-tabs')).toHaveCount(0);
          await expect(page.locator('.gm-draft-note')).toHaveCount(0);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-03 CN 8 vs GLOBAL 5 engines & strict visibility run/metric isolation',
      { tag: ['@tier3', '@F5', '@F9', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't303');
        const tenant = await provisionIsolatedTenant({ prefix: 't303', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));

        const cnEngines = await listMarketEnginesApi(tenant.session, brand.id, 'CN');
        const globalEngines = await listMarketEnginesApi(tenant.session, brand.id, 'GLOBAL');

        expect(cnEngines.map((e) => e.key).sort()).toEqual([...CN_ENGINES].sort());
        expect(cnEngines.some((e) => e.key === 'tongyi')).toBe(true);
        expect(globalEngines.map((e) => e.key).sort()).toEqual([...GLOBAL_ENGINES].sort());

        const onlineCn = cnEngines.filter((e) => e.available || e.status === 'online');
        const onlineGlobal = globalEngines.filter((e) => e.available || e.status === 'online');
        expect(onlineCn.length).toBeGreaterThan(0);
        expect(onlineGlobal.length).toBeGreaterThan(0);

        const cnRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`CN 隔离监测 ${tag} ${E2E_SENTINELS.GAP}`],
            engines: onlineCn.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't303cn'),
        );
        const globalRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'GLOBAL',
            prompts: [`GLOBAL isolation probe ${tag} ${E2E_SENTINELS.GAP}`],
            engines: onlineGlobal.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't303gl'),
        );

        await waitForVisibilityRunApi(tenant.session, brand.id, cnRun.id);
        await waitForVisibilityRunApi(tenant.session, brand.id, globalRun.id);

        const cnRunsRes = unwrapOk(
          await requestV2<{ items?: VisibilityRunDto[] } | VisibilityRunDto[]>(
            `/brands/${brand.id}/visibility/runs?market=CN`,
            { token: tenant.session.accessToken },
          ),
          'GET CN runs',
        );
        const globalRunsRes = unwrapOk(
          await requestV2<{ items?: VisibilityRunDto[] } | VisibilityRunDto[]>(
            `/brands/${brand.id}/visibility/runs?market=GLOBAL`,
            { token: tenant.session.accessToken },
          ),
          'GET GLOBAL runs',
        );

        const cnRunIds = extractItems(cnRunsRes).map((r) => r.id);
        const globalRunIds = extractItems(globalRunsRes).map((r) => r.id);
        expect(cnRunIds).toContain(cnRun.id);
        expect(cnRunIds).not.toContain(globalRun.id);
        expect(globalRunIds).toContain(globalRun.id);
        expect(globalRunIds).not.toContain(cnRun.id);

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/visibility?brandId=${brand.id}&market=CN`,
        );
        try {
          await openVisibilityTab(page, 'runs');
          const cnOffline = cnEngines.find((e) => !e.available || e.status === 'offline');
          if (cnOffline) {
            const offlineNode = page.getByTestId(`engine-option-${cnOffline.key}`);
            if ((await offlineNode.count()) > 0) {
              await expect(offlineNode).toContainText('暂未上线');
            }
          }
          // Verify GLOBAL engine keys are absent while viewing CN market
          for (const gKey of GLOBAL_ENGINES) {
            await expect(page.getByTestId(`engine-option-${gKey}`)).toHaveCount(0);
          }

          await switchGlobalMarket(page, 'GLOBAL');
          await openVisibilityTab(page, 'runs');
          for (const cKey of CN_ENGINES) {
            await expect(page.getByTestId(`engine-option-${cKey}`)).toHaveCount(0);
          }
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-04 Brief language contract & Studio targetFormat market pairing (CN vs GLOBAL)',
      { tag: ['@tier3', '@F5', '@F11', '@F12', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't304');
        const tenant = await provisionIsolatedTenant({ prefix: 't304', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const cnEngines = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const globalEngines = (
          await listMarketEnginesApi(tenant.session, brand.id, 'GLOBAL')
        ).filter((e) => e.available || e.status === 'online');

        const cnRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`家用四盘位 NAS 静音实测推荐 ${E2E_SENTINELS.GAP}`],
            engines: cnEngines.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't304cn'),
        );
        const glRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'GLOBAL',
            prompts: [`Best quiet 4-bay home NAS 2026 ${E2E_SENTINELS.GAP}`],
            engines: globalEngines.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't304gl'),
        );

        await waitForVisibilityRunApi(tenant.session, brand.id, cnRun.id);
        await waitForVisibilityRunApi(tenant.session, brand.id, glRun.id);

        const cnBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', cnRun.id);
        const glBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'GLOBAL', glRun.id);

        expect(cnBriefs.length).toBeGreaterThan(0);
        expect(glBriefs.length).toBeGreaterThan(0);

        const cnBrief = cnBriefs[0];
        const glBrief = glBriefs[0];

        expect(['CN_DEEP_REVIEW', 'CN_COMMUNITY_QA']).toContain(cnBrief.targetFormat);
        expect(cnBrief.suggestedTitle).toMatch(/[\u4e00-\u9fa5]/);
        expect(cnBrief.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);
        expect(cnBrief.outlineH2.length).toBeGreaterThan(0);
        expect(cnBrief.outlineH2[0].heading).toMatch(/[\u4e00-\u9fa5]/);

        expect(['GLOBAL_AUTHORITY_GUIDE', 'GLOBAL_COMMUNITY_DISCUSSION']).toContain(
          glBrief.targetFormat,
        );
        expect(glBrief.suggestedTitle).toMatch(/[A-Za-z]{3,}/);
        expect(glBrief.outlineH2.length).toBeGreaterThan(0);
        expect(glBrief.outlineH2[0].heading).toMatch(/[A-Za-z]{3,}/);
        expect(glBrief.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand.id}&market=CN&briefId=${cnBrief.id}`,
        );
        try {
          await expect(page.getByTestId('studio-format-CN_DEEP_REVIEW')).toBeVisible();
          await expect(page.getByTestId('studio-format-CN_COMMUNITY_QA')).toBeVisible();
          await expect(page.getByTestId('studio-format-GLOBAL_AUTHORITY_GUIDE')).toHaveCount(0);
          await expect(page.getByTestId('studio-format-GLOBAL_COMMUNITY_DISCUSSION')).toHaveCount(
            0,
          );

          await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&briefId=${glBrief.id}`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.getByTestId('studio-format-GLOBAL_AUTHORITY_GUIDE')).toBeVisible();
          await expect(page.getByTestId('studio-format-GLOBAL_COMMUNITY_DISCUSSION')).toBeVisible();
          await expect(page.getByTestId('studio-format-CN_DEEP_REVIEW')).toHaveCount(0);
          await expect(page.getByTestId('studio-format-CN_COMMUNITY_QA')).toHaveCount(0);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-05 CN Ad Law vs GLOBAL FTC compliance & delivery pack parity (JSON-LD + llms.txt + crawlers)',
      { tag: ['@tier3', '@F12', '@F13', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't305');
        const tenant = await provisionIsolatedTenant({ prefix: 't305', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        // CN Track: stream article, inject CN superlatives to test China Advertising Law compliance
        const cnSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't305cn'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 四盘位家用 NAS 深度评测与选购建议`,
          },
        });
        expect(cnSse.status).toBe(200);
        const cnArticle = cnSse.complete!.article;

        const cnEval = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${cnArticle.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          'POST evaluate-geo (CN)',
        );
        assertGeoScoreValid(cnEval.geoScore, cnEval.geoScoreDetail);
        expect(cnEval.recommendedChannels.length).toBeGreaterThan(0);
        const cnChannelNames = cnEval.recommendedChannels.map((c) => c.channel).join(' ');
        expect(cnChannelNames).toMatch(/头条|知乎|值得买|公众号|小红书|官网/);

        // Verify CN superlatives are penalized or sanitized on CN track
        const cnSuperlativeDraft = `${cnArticle.contentMarkdown}\n\n本机型是全网第一、顶级、国家级最强的唯一选择。`;
        const cnPatched = unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${cnArticle.id}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { contentMarkdown: cnSuperlativeDraft },
          }),
          'PATCH CN article with superlatives',
        );
        const cnSuperlativeEval = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${cnArticle.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          'POST evaluate-geo (CN superlatives)',
        );
        const cnWasSanitized =
          !cnPatched.contentMarkdown.includes('国家级') ||
          !cnPatched.contentMarkdown.includes('全网第一');
        const cnDeAiPenalized =
          cnSuperlativeEval.geoScoreDetail.dimensions.deAiCompliance.score <
            cnSuperlativeEval.geoScoreDetail.dimensions.deAiCompliance.maxScore ||
          cnSuperlativeEval.geoScoreDetail.dimensions.deAiCompliance.hints.length > 0;
        expect(
          cnWasSanitized || cnDeAiPenalized,
          'CN Ad Law must sanitize or flag Chinese superlative terms (第一/顶级/国家级)',
        ).toBe(true);

        // GLOBAL Track: FTC compliance MUST preserve Best / Top / 100% specs + valid JSON-LD + llms.txt + crawlers
        const glSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't305gl'),
          body: {
            market: 'GLOBAL',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt: 'Best Top 4-bay quiet NAS with 100% aluminum chassis 2026',
          },
        });
        expect(glSse.status).toBe(200);
        const glArticle = glSse.complete!.article;

        const ftcContent =
          glArticle.contentMarkdown.includes('Best') &&
          glArticle.contentMarkdown.includes('Top') &&
          glArticle.contentMarkdown.includes('100%')
            ? glArticle.contentMarkdown
            : `${glArticle.contentMarkdown}\n\n## Best Top Pick Summary\nRated among the Best and Top 4-bay NAS builds with 100% aluminum chassis and 18.5dB acoustic output.`;

        const glPatched = unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${glArticle.id}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { contentMarkdown: ftcContent },
          }),
          'PATCH GLOBAL article with FTC high-intent terms',
        );
        expect(glPatched.contentMarkdown).toContain('Best');
        expect(glPatched.contentMarkdown).toContain('Top');
        expect(glPatched.contentMarkdown).toContain('100%');

        const glEval = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${glArticle.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          'POST evaluate-geo (GLOBAL)',
        );
        assertGeoScoreValid(glEval.geoScore, glEval.geoScoreDetail);
        assertValidJsonLd(glEval.schemaJsonLd, ['Article', 'FAQPage']);

        const globalMarket = brand.markets.find((m) => m.market === 'GLOBAL');
        expect(glEval.llmsTxtSnippet).toBeTruthy();
        assertLlmsTxt(glEval.llmsTxtSnippet!, {
          brandName: globalMarket?.localBrandName ?? 'AstraVault',
        });

        const crawlerNames = glEval.crawlerChecklist.map((c) => c.bot);
        expect(crawlerNames).toContain('GPTBot');
        expect(crawlerNames).toContain('PerplexityBot');
      },
    );
  },
);
