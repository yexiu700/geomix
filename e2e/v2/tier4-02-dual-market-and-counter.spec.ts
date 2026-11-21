import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  deleteBrandMediaApi,
  extractItems,
  listBriefsApi,
  listMarketEnginesApi,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  uploadBrandPhotoApi,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForVisibilityRunApi,
  type ActionHomeDto,
  type GeoArticleDto,
  type GeoBriefDto,
  type VisibilityRunDto,
} from './support/api-client';
import { assertNoConsoleOrPageErrors } from './support/assertions';
import {
  buildCnBrandPayload,
  buildFourBrandFacts,
  buildTestPngBuffer,
  E2E_SENTINELS,
  FIXTURE_URLS,
  SAMPLE_COMPETITOR_PASTE_TEXT,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import {
  expectUrlContext,
  navigateWorkspace,
  openAuthenticatedPage,
  openVisibilityTab,
  switchGlobalMarket,
} from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 4 — Dual-Market Isolation & Competitor URL Counter-Play',
  {
    tag: [
      '@tier4',
      '@F5',
      '@F6',
      '@F7',
      '@F8',
      '@F9',
      '@F10',
      '@F11',
      '@F12',
      '@F15',
      '@F17',
      '@M5',
    ],
  },
  () => {
    test(
      'S4-03 Dual-market single brand (CN + GLOBAL): shared facts & photos with strict run/brief/article/home isolation',
      { tag: ['@tier4', '@F5', '@F7', '@F8', '@F9', '@F11', '@F12', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's403');
        const tenant = await provisionIsolatedTenant({ prefix: 's403', initialPoints: 250 });

        const brand = await createBrandApi(tenant.session, {
          name: `云帆割草机${tag}`,
          category: '智能割草机器人',
          markets: [
            {
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: `云帆割草机${tag}`,
              aliases: [`YF-M1-${tag}`],
              ownedDomains: [`yunfan-${tag}.example`],
              competitors: [
                { name: '九号割草', aliases: ['Navimow'], domains: ['navimow.example'] },
              ],
            },
            {
              market: 'GLOBAL',
              locale: 'en-US',
              region: 'US',
              localBrandName: `SailBot Robotics ${tag}`,
              aliases: [`SB-M1-${tag}`],
              ownedDomains: [`sailbot-${tag}.example`],
              competitors: [
                { name: 'LawnPilot', aliases: ['LawnPilot X'], domains: ['lawnpilot.example'] },
              ],
            },
          ],
        });

        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: 'RTK 双目视觉割草参数',
            content:
              '厘米级 RTK + 视觉融合无边界导航，爬坡角度 45%，IPX6 防水，单次续航 180 分钟。',
            sourceType: 'MANUAL',
          },
          {
            slot: 'CREDENTIALS',
            title: '认证背书',
            content: '通过 CE、FCC 与 TÜV 安全认证，整机质保 3 年。',
            sourceType: 'MANUAL',
          },
        ]);

        const photoTitle = `sailbot-deck-${tag}`;
        let uploadedMediaId: string | null = null;

        try {
          const uploaded = await uploadBrandPhotoApi(tenant.session, brand.id, {
            filename: 'sailbot-deck.png',
            title: photoTitle,
            buffer: buildTestPngBuffer(80, 60),
          });
          uploadedMediaId = uploaded.id;

          // Step 1: Produce CN monitor, brief, and article
          const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
            (e) => e.available || e.status === 'online',
          );
          const cnRun = await createVisibilityRunApi(
            tenant.session,
            brand.id,
            {
              market: 'CN',
              prompts: [`无边界智能割草机器人 2026 推荐 ${tag} ${E2E_SENTINELS.GAP}`],
              engines: onlineCn.slice(0, 2).map((e) => e.key),
            },
            uniqueIdempotencyKey(testInfo, 's403cnr'),
          );
          await waitForVisibilityRunApi(tenant.session, brand.id, cnRun.id);
          const cnBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', cnRun.id);
          expect(cnBriefs.length).toBeGreaterThan(0);

          const cnSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 's403cna'),
            body: {
              market: 'CN',
              briefId: cnBriefs[0].id,
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: cnBriefs[0].targetPrompt,
            },
          });
          expect(cnSse.status).toBe(200);
          const cnArticle = cnSse.complete!.article;

          // Step 2: Verify GLOBAL is completely empty BEFORE running GLOBAL workflow (zero CN leakage)
          const glRunsBefore = extractItems(
            unwrapOk(
              await requestV2<{ items?: VisibilityRunDto[] } | VisibilityRunDto[]>(
                `/brands/${brand.id}/visibility/runs?market=GLOBAL`,
                { token: tenant.session.accessToken },
              ),
              'GET GLOBAL runs before',
            ),
          );
          const glBriefsBefore = await listBriefsApi(tenant.session, brand.id, 'GLOBAL');
          const glHomeBefore = unwrapOk(
            await requestV2<ActionHomeDto>(`/brands/${brand.id}/home?market=GLOBAL`, {
              token: tenant.session.accessToken,
            }),
            'GET GLOBAL home before',
          );
          expect(glRunsBefore).toHaveLength(0);
          expect(glBriefsBefore).toHaveLength(0);
          expect(glHomeBefore.recentArticles).toHaveLength(0);

          // Step 3: Produce GLOBAL monitor, brief, and article
          const onlineGl = (await listMarketEnginesApi(tenant.session, brand.id, 'GLOBAL')).filter(
            (e) => e.available || e.status === 'online',
          );
          const glRun = await createVisibilityRunApi(
            tenant.session,
            brand.id,
            {
              market: 'GLOBAL',
              prompts: [`Best wire-free RTK robot lawn mower 2026 ${tag} ${E2E_SENTINELS.GAP}`],
              engines: onlineGl.slice(0, 2).map((e) => e.key),
            },
            uniqueIdempotencyKey(testInfo, 's403glr'),
          );
          await waitForVisibilityRunApi(tenant.session, brand.id, glRun.id);
          const glBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'GLOBAL', glRun.id);
          expect(glBriefs.length).toBeGreaterThan(0);

          const glSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 's403gla'),
            body: {
              market: 'GLOBAL',
              briefId: glBriefs[0].id,
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
              targetPrompt: glBriefs[0].targetPrompt,
            },
          });
          expect(glSse.status).toBe(200);
          const glArticle = glSse.complete!.article;

          // Step 4: Toggle GLOBAL -> CN -> GLOBAL in UI with reloads, verifying shared assets & isolated outputs
          const { context, page, errors } = await openAuthenticatedPage(
            browser,
            tenant.session,
            `/brands?brandId=${brand.id}&market=GLOBAL`,
          );
          try {
            await expect(page.locator('body')).toContainText('RTK 双目视觉割草参数');
            await expect(page.locator('body')).toContainText(photoTitle);

            await navigateWorkspace(page, '行动首页', /\/home/);
            await expectUrlContext(page, {
              brandId: brand.id,
              market: 'GLOBAL',
              pathname: '/home',
            });
            await expect(page.getByTestId('home-recent-articles')).toContainText(glArticle.title);
            await expect(page.getByTestId('home-recent-articles')).not.toContainText(
              cnArticle.title,
            );

            await switchGlobalMarket(page, 'CN');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expectUrlContext(page, { brandId: brand.id, market: 'CN', pathname: '/home' });
            await expect(page.getByTestId('home-recent-articles')).toContainText(cnArticle.title);
            await expect(page.getByTestId('home-recent-articles')).not.toContainText(
              glArticle.title,
            );

            await switchGlobalMarket(page, 'GLOBAL');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expectUrlContext(page, {
              brandId: brand.id,
              market: 'GLOBAL',
              pathname: '/home',
            });
            await expect(page.getByTestId('home-recent-articles')).toContainText(glArticle.title);
            assertNoConsoleOrPageErrors(errors);
          } finally {
            await context.close();
          }
        } finally {
          if (uploadedMediaId) {
            await deleteBrandMediaApi(tenant.session, brand.id, uploadedMediaId).catch(
              () => undefined,
            );
          }
        }
      },
    );

    test(
      'S4-04 Competitor high-citation URL Counter-Play + 403/login-wall anti-scrape pastedContent fallback + SSRF block',
      { tag: ['@tier4', '@F9', '@F10', '@F11', '@F12', '@F15', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's404');
        const tenant = await provisionIsolatedTenant({ prefix: 's404', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const run = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`四盘位家用 NAS 权威评测对比 ${tag} ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 's404run'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, run.id);

        // 1. Verify Tab 3 High-Citation URL counter button & create CITATION_COUNTER brief
        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/visibility?brandId=${brand.id}&market=CN`,
        );
        try {
          await openVisibilityTab(page, 'citations');
          const counterBtn = page
            .getByTestId('citation-counter-btn')
            .or(page.getByRole('button', { name: /反制重写此页|反制重写/ }))
            .first();
          await expect(counterBtn).toBeVisible({ timeout: 15_000 });
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }

        const counterBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.competitorNasReview,
            },
          }),
          'POST /briefs/from-citation-url (valid fixture)',
        );
        expect(counterBrief.sourceType).toBe('CITATION_COUNTER');
        expect(counterBrief.recommendedRecipe).toBe('CITATION_COUNTER');
        expect(counterBrief.matchedFactIds.length).toBeGreaterThan(0);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's404sse'),
          body: {
            market: 'CN',
            briefId: counterBrief.id,
            recipe: 'CITATION_COUNTER',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: counterBrief.targetPrompt,
          },
        });
        expect(sse.status).toBe(200);
        const surpassingArticle: GeoArticleDto = sse.complete!.article;
        expect(surpassingArticle.recipe).toBe('CITATION_COUNTER');
        expect(sse.meta?.matchedFactIds.length).toBeGreaterThan(0);

        // 2. Anti-scrape 403 & login-wall -> clean 4xx (never 500) + pastedContent fallback succeeds
        const res403 = await requestV2(`/brands/${brand.id}/briefs/from-citation-url`, {
          method: 'POST',
          token: tenant.session.accessToken,
          body: { market: 'CN', citationUrl: FIXTURE_URLS.antiScrape403 },
        });
        expect(res403.status).toBeGreaterThanOrEqual(400);
        expect(res403.status).toBeLessThan(500);
        expect(res403.envelope.code).not.toBe(0);

        const resLoginWall = await requestV2(`/brands/${brand.id}/briefs/from-citation-url`, {
          method: 'POST',
          token: tenant.session.accessToken,
          body: { market: 'CN', citationUrl: FIXTURE_URLS.antiScrapeLoginWall },
        });
        expect(resLoginWall.status).toBeGreaterThanOrEqual(400);
        expect(resLoginWall.status).toBeLessThan(500);
        expect(resLoginWall.envelope.code).not.toBe(0);

        const fallbackBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.antiScrape403,
              pastedContent: SAMPLE_COMPETITOR_PASTE_TEXT,
            },
          }),
          'POST /briefs/from-citation-url with pastedContent fallback',
        );
        expect(fallbackBrief.sourceType).toBe('CITATION_COUNTER');
        expect(fallbackBrief.outlineH2.length).toBeGreaterThan(0);

        // 3. SSRF private/loopback/metadata URLs strictly rejected with 4xx
        for (const blockedUrl of [
          FIXTURE_URLS.ssrfLoopback,
          FIXTURE_URLS.ssrfMetadata,
          FIXTURE_URLS.ssrfPrivate10,
        ]) {
          const ssrfRes = await requestV2(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: { market: 'CN', citationUrl: blockedUrl },
          });
          expect(
            ssrfRes.status,
            `SSRF URL ${blockedUrl} must be blocked with 4xx`,
          ).toBeGreaterThanOrEqual(400);
          expect(ssrfRes.status, `SSRF URL ${blockedUrl} must not 500`).toBeLessThan(500);
          expect(ssrfRes.envelope.code).not.toBe(0);
        }
      },
    );
  },
);
