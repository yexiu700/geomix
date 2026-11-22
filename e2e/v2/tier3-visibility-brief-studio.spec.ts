import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  extractItems,
  getTenantWallet,
  listBriefsApi,
  listMarketEnginesApi,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForBatchJobApi,
  waitForVisibilityRunApi,
  type ActionHomeDto,
  type GeoArticleDto,
  type GeoBatchJobDto,
  type GeoBriefDto,
  type GeoPublishRecordDto,
  type VisibilityRunDto,
} from './support/api-client';
import { assertNoConsoleOrPageErrors } from './support/assertions';
import {
  buildCnBrandPayload,
  buildFourBrandFacts,
  E2E_FIXTURE_HOST,
  E2E_SENTINELS,
  FIXTURE_URLS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import {
  openAuthenticatedPage,
  openBriefDrawerAndEdit,
  openVisibilityTab,
} from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 3 — Visibility ↔ Briefs ↔ Studio Seams',
  {
    tag: ['@tier3', '@F6', '@F9', '@F10', '@F11', '@F12', '@F14', '@F15', '@F17', '@M5'],
  },
  () => {
    test(
      'T3-10 Run completion briefsGeneratedAt idempotency & /home Top 3 priorityScore ordering',
      { tag: ['@tier3', '@F9', '@F11', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't310');
        const tenant = await provisionIsolatedTenant({ prefix: 't310', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        expect(onlineCn.length).toBeGreaterThan(0);

        const run = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [
              `家用 NAS 静音推荐 ${tag} ${E2E_SENTINELS.GAP}`,
              `家用 NAS 噪声与售后真实评价 ${tag} ${E2E_SENTINELS.NEGATIVE}`,
              `四盘位家用存储横评排行 ${tag} ${E2E_SENTINELS.LOW_RANK}`,
            ],
            engines: onlineCn.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't310run'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, run.id);

        const autoBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', run.id);
        const runBriefs = autoBriefs.filter((b) => b.sourceRunId === run.id);
        expect(runBriefs.length).toBeGreaterThanOrEqual(1);
        expect(runBriefs.length).toBeLessThanOrEqual(5);
        const initialBriefIds = runBriefs.map((b) => b.id).sort();

        // Wait & reload /home to confirm briefsGeneratedAt idempotency prevents duplicate briefs
        await new Promise((r) => setTimeout(r, 2000));
        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/home?brandId=${brand.id}&market=CN`,
        );
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await expect(page.getByTestId('home-top-briefs')).toBeVisible();
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }

        const runRefetched = unwrapOk(
          await requestV2<VisibilityRunDto>(`/brands/${brand.id}/visibility/runs/${run.id}`, {
            token: tenant.session.accessToken,
          }),
          'refetch run',
        );
        expect(runRefetched.briefsGeneratedAt).toBeTruthy();

        const briefsAfter = (await listBriefsApi(tenant.session, brand.id, 'CN')).filter(
          (b) => b.sourceRunId === run.id,
        );
        expect(briefsAfter.map((b) => b.id).sort()).toEqual(initialBriefIds);

        const home = unwrapOk(
          await requestV2<ActionHomeDto>(`/brands/${brand.id}/home?market=CN`, {
            token: tenant.session.accessToken,
          }),
          'GET /home',
        );
        expect(home.topBriefs.length).toBeGreaterThanOrEqual(1);
        expect(home.topBriefs.length).toBeLessThanOrEqual(3);
        for (let i = 0; i < home.topBriefs.length - 1; i += 1) {
          expect(home.topBriefs[i].priorityScore).toBeGreaterThanOrEqual(
            home.topBriefs[i + 1].priorityScore,
          );
        }
      },
    );

    test(
      'T3-11 All 5 Visibility signal points -> GeoBriefDrawer -> /studio?briefId=... with 0 pts charged',
      { tag: ['@tier3', '@F9', '@F10', '@F11', '@F15', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't311');
        const tenant = await provisionIsolatedTenant({
          prefix: 't311',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
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
            prompts: [
              `家庭静音 NAS 选型 ${tag} ${E2E_SENTINELS.GAP}`,
              `NAS 拆解词测试 ${tag} ${E2E_SENTINELS.FANOUT_SEMI}`,
              `高引用评测源测试 ${tag} ${E2E_SENTINELS.COMP_DOMAIN}`,
            ],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't311run'),
        );
        const doneRun = await waitForVisibilityRunApi(tenant.session, brand.id, run.id);
        await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', run.id);

        // Record balance AFTER the paid visibility run; all 5 brief operations below MUST charge 0 pts
        const balanceAfterRun = (await getTenantWallet(tenant.session)).points;
        expect(balanceAfterRun).toBeLessThan(100);

        const observations = doneRun.observations ?? [];
        expect(observations.length).toBeGreaterThan(0);

        // Signal Point 2: Answer Lens -> POST /briefs/generate with observationIds
        const obsBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'LOW_RANK',
              observationIds: [observations[0].id],
            },
          }),
          'Signal 2: observation brief',
        );
        expect(obsBrief.sourceObservationIds).toContain(observations[0].id);

        // Signal Point 3: High-Citation URL -> POST /briefs/from-citation-url
        const counterBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.competitorNasReview,
            },
          }),
          'Signal 3: citation counter brief',
        );
        expect(counterBrief.sourceType).toBe('CITATION_COUNTER');
        expect(counterBrief.sourceCitationUrl).toContain('nas-review');

        // Signal Point 4: Fan-Out cluster -> POST /briefs/generate with 3 split/deduped fanOutQueries
        const fanOutObs = observations.find((o) => o.fanOutQueries.length >= 2);
        const fanOutTerms =
          fanOutObs && fanOutObs.fanOutQueries.length >= 3
            ? fanOutObs.fanOutQueries.slice(0, 3)
            : ['安静NAS', '家用NAS功耗', '四盘位NAS'];
        const fanOutBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'FANOUT_CLUSTER',
              fanOutQueries: fanOutTerms,
            },
          }),
          'Signal 4: fan-out cluster brief',
        );
        expect(fanOutBrief.sourceType).toBe('FANOUT_CLUSTER');
        expect(fanOutBrief.targetFanOuts).toEqual(expect.arrayContaining(fanOutTerms));

        // Signal Point 5: Manual custom prompt brief
        const manualBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} 四盘位 RAID5 扩容避坑指南 ${tag}`,
            },
          }),
          'Signal 5: manual brief',
        );
        expect(manualBrief.sourceType).toBe('MANUAL');

        // Signal Point 1 (UI): Tab 1 Overview gap -> open GeoBriefDrawer -> edit title + H2 -> click write -> /studio?briefId=
        const editedTitle = `自定义优化标题-${tag}`;
        const editedH2 = `实测核心参数横向对比-${tag}`;

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/visibility?brandId=${brand.id}&market=CN`,
        );
        try {
          await openVisibilityTab(page, 'overview');
          const detailBtn = page.getByRole('button', { name: /查看详细意见|提写作意见/ }).first();
          await expect(detailBtn).toBeVisible({ timeout: 15_000 });
          await detailBtn.click();

          await openBriefDrawerAndEdit(page, {
            newTitle: editedTitle,
            newH2: editedH2,
            clickWrite: true,
          });

          await expect
            .poll(
              () => {
                const u = new URL(page.url());
                return u.pathname === '/studio' && Boolean(u.searchParams.get('briefId'));
              },
              { timeout: 15_000 },
            )
            .toBe(true);

          // Confirm zero points deducted across all 5 brief triggers + drawer handoff
          const balanceAfterBriefs = (await getTenantWallet(tenant.session)).points;
          expect(balanceAfterBriefs).toBe(balanceAfterRun);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-12 Multi-select 3 OPEN briefs -> GeoBatchJob completes 3/3 and syncs all briefs to DONE',
      { tag: ['@tier3', '@F11', '@F14', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't312');
        const tenant = await provisionIsolatedTenant({ prefix: 't312', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const createdBriefs: GeoBriefDto[] = [];
        for (let i = 1; i <= 3; i += 1) {
          const brief = unwrapOk(
            await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
              method: 'POST',
              token: tenant.session.accessToken,
              body: {
                market: 'CN',
                sourceType: 'MANUAL',
                customPrompt: `${brand.name} 批量专题 ${i} ${tag}`,
              },
            }),
            `create brief ${i}`,
          );
          createdBriefs.push(brief);
        }

        const job = unwrapOk(
          await requestV2<GeoBatchJobDto>(`/brands/${brand.id}/articles/batch`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't312batch') },
            body: {
              market: 'CN',
              briefIds: createdBriefs.map((b) => b.id),
            },
          }),
          'POST /articles/batch (3 briefs)',
        );
        const doneJob = await waitForBatchJobApi(tenant.session, brand.id, job.id);
        expect(doneJob.total).toBe(3);
        expect(doneJob.doneCount).toBe(3);
        expect(doneJob.failCount).toBe(0);

        const articlesRes = unwrapOk(
          await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
            `/brands/${brand.id}/articles?market=CN`,
            { token: tenant.session.accessToken },
          ),
          'GET articles',
        );
        const batchArticles = extractItems(articlesRes).filter((a) => a.batchJobId === job.id);
        expect(batchArticles).toHaveLength(3);
        expect(new Set(batchArticles.map((a) => a.id)).size).toBe(3);

        const allBriefsAfter = await listBriefsApi(tenant.session, brand.id, 'CN');
        for (const original of createdBriefs) {
          const updated = allBriefsAfter.find((b) => b.id === original.id);
          expect(updated?.status).toBe('DONE');
        }
      },
    );

    test(
      'T3-13 GeoBrief (OPEN -> DONE / DISMISSED) & GeoArticle (DRAFT -> READY -> PUBLISHED) lifecycles',
      { tag: ['@tier3', '@F11', '@F12', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't313');
        const tenant = await provisionIsolatedTenant({ prefix: 't313', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const b1 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} 生命周期写作主题 ${tag}`,
            },
          }),
          'create B1',
        );
        const b2 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} 待忽略主题 ${tag}`,
            },
          }),
          'create B2',
        );
        expect(b1.status).toBe('OPEN');
        expect(b2.status).toBe('OPEN');

        // Dismiss B2 -> must disappear from /home topBriefs
        const dismissed = unwrapOk(
          await requestV2<GeoBriefDto>(`/briefs/${b2.id}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { status: 'DISMISSED' },
          }),
          'PATCH B2 DISMISSED',
        );
        expect(dismissed.status).toBe('DISMISSED');

        const home = unwrapOk(
          await requestV2<ActionHomeDto>(`/brands/${brand.id}/home?market=CN`, {
            token: tenant.session.accessToken,
          }),
          'GET /home after dismiss',
        );
        expect(home.topBriefs.some((b) => b.id === b2.id)).toBe(false);

        // Stream B1 -> B1 transitions to DONE; article starts as DRAFT
        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't313sse'),
          body: {
            market: 'CN',
            briefId: b1.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: b1.targetPrompt,
          },
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;
        expect(article.status).toBe('DRAFT');

        const briefsAfter = await listBriefsApi(tenant.session, brand.id, 'CN');
        expect(briefsAfter.find((b) => b.id === b1.id)?.status).toBe('DONE');

        // DRAFT -> READY
        const readyArticle = unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { status: 'READY' },
          }),
          'PATCH article READY',
        );
        expect(readyArticle.status).toBe('READY');

        // READY -> PUBLISHED via publish-records
        const pub = unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${article.id}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://xingyaonas-${tag}.example/blog/lifecycle`,
              channel: '官网博客',
            },
          }),
          'POST publish-records',
        );
        expect(pub.articleId).toBe(article.id);

        const publishedArticle = unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
            token: tenant.session.accessToken,
          }),
          'GET article after publish',
        );
        expect(publishedArticle.status).toBe('PUBLISHED');
      },
    );

    test(
      'T3-21 Competitor domain edit reclassifies citation as COMPETITOR and launches Counter-Play',
      { tag: ['@tier3', '@F6', '@F10', '@F15', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't321');
        const tenant = await provisionIsolatedTenant({ prefix: 't321', initialPoints: 200 });

        const brand = await createBrandApi(tenant.session, {
          name: `星曜竞品域${tag}`,
          category: '家用NAS网络存储',
          markets: [
            {
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: `星曜竞品域${tag}`,
              aliases: [`XY-${tag}`],
              ownedDomains: [`xingyao-${tag}.example`],
              competitors: [{ name: '竞品甲', aliases: ['竞品甲Pro'], domains: [] }],
            },
          ],
        });
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );

        // Run 1: E2E_FIXTURE_HOST is NOT in competitor domains yet -> citation must NOT be COMPETITOR
        const run1 = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`竞品域名归类测试1 ${tag} ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't321r1'),
        );
        const done1 = await waitForVisibilityRunApi(tenant.session, brand.id, run1.id);
        const citations1 = (done1.observations ?? []).flatMap((o) => o.citations);
        const fixtureCit1 = citations1.find((c) => c.url.includes('/competitor/nas-review'));
        expect(fixtureCit1, 'Expected fixture citation in run 1').toBeTruthy();
        expect(fixtureCit1!.sourceKind).not.toBe('COMPETITOR');

        // Edit CN market to register E2E_FIXTURE_HOST under competitor 竞品甲
        unwrapOk(
          await requestV2(`/brands/${brand.id}/markets/CN`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: {
              competitors: [
                {
                  name: '竞品甲',
                  aliases: ['竞品甲Pro'],
                  domains: [E2E_FIXTURE_HOST],
                },
              ],
            },
          }),
          'PATCH CN market competitor domains',
        );

        // Run 2: same fixture URL must now be classified as COMPETITOR
        const run2 = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`竞品域名归类测试2 ${tag} ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't321r2'),
        );
        const done2 = await waitForVisibilityRunApi(tenant.session, brand.id, run2.id);
        const citations2 = (done2.observations ?? []).flatMap((o) => o.citations);
        const fixtureCit2 = citations2.find((c) => c.url.includes('/competitor/nas-review'));
        expect(fixtureCit2, 'Expected fixture citation in run 2').toBeTruthy();
        expect(fixtureCit2!.sourceKind).toBe('COMPETITOR');

        // Launch Counter-Play from that reclassified competitor URL
        const counterBrief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.competitorNasReview,
            },
          }),
          'POST /briefs/from-citation-url',
        );
        expect(counterBrief.sourceType).toBe('CITATION_COUNTER');
        expect(counterBrief.recommendedRecipe).toBe('CITATION_COUNTER');
        expect(counterBrief.matchedFactIds.length).toBeGreaterThan(0);
      },
    );
  },
);
