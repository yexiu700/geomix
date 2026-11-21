import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  deleteBrandMediaApi,
  extractItems,
  getAdminPricing,
  getAdminSession,
  getTenantPointLogs,
  getTenantWallet,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  requestV2Binary,
  unwrapOk,
  updateAdminPricing,
  upsertBrandFactsApi,
  waitForBatchJobApi,
  waitForVisibilityRunApi,
  type ActionHomeDto,
  type BrandMediaAssetDto,
  type GeoArticleDto,
  type GeoBatchJobDto,
  type GeoBriefDto,
  type GeoEvaluationDto,
  type GeoPublishRecordDto,
  type VisibilityRunDto,
} from './support/api-client';
import {
  assertGeoScoreValid,
  assertNoConsoleOrPageErrors,
  assertValidDocxWithTable,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildFourBrandFacts,
  E2E_SENTINELS,
  FIXTURE_URLS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import { openAuthenticatedPage } from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 3 — Delivery, Retest & Billing Contracts',
  {
    tag: ['@tier3', '@F2', '@F4', '@F9', '@F12', '@F14', '@F15', '@F16', '@F17', '@M5'],
  },
  () => {
    test(
      'T3-14 Publish Record -> one-click RETEST -> afterMetrics writeback -> /home Before/After badge',
      { tag: ['@tier3', '@F9', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't314');
        const tenant = await provisionIsolatedTenant({
          prefix: 't314',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const prompt = `${brand.name} 四盘位 NAS 静音实测对比 ${tag} ${E2E_SENTINELS.GAP}`;
        const baseRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [prompt],
            engines: onlineCn.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 't314base'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, baseRun.id);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't314art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: prompt,
          },
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;

        const pubRecord = unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${article.id}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://xingyaonas-${tag}.example/blog/retest-loop`,
              channel: '官网博客',
            },
          }),
          'POST publish-records',
        );
        expect(pubRecord.afterMetrics).toBeNull();

        const retestPayload = unwrapOk(
          await requestV2<{ run?: VisibilityRunDto; id?: string }>(
            `/publish-records/${pubRecord.id}/retest`,
            {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't314ret') },
              body: { engines: onlineCn.slice(0, 2).map((e) => e.key) },
            },
          ),
          'POST /publish-records/:id/retest',
        );
        const retestRunId = retestPayload.run?.id ?? retestPayload.id;
        expect(retestRunId).toBeTruthy();

        const doneRetest = await waitForVisibilityRunApi(tenant.session, brand.id, retestRunId!);
        expect(doneRetest.triggerType).toBe('RETEST');
        expect(doneRetest.retestArticleId).toBe(article.id);

        const updatedRecord = await pollUntil(
          async () => {
            const list = unwrapOk(
              await requestV2<{ items?: GeoPublishRecordDto[] } | GeoPublishRecordDto[]>(
                `/articles/${article.id}/publish-records`,
                { token: tenant.session.accessToken },
              ),
              'GET publish-records',
            );
            return extractItems(list).find((r) => r.id === pubRecord.id) ?? null;
          },
          (rec) =>
            rec !== null && rec.latestRetestRunId === retestRunId && rec.afterMetrics !== null,
          { timeoutMs: 20_000, label: 'publishRecord afterMetrics writeback' },
        );
        expect(updatedRecord?.afterMetrics).not.toBeNull();

        const home = unwrapOk(
          await requestV2<ActionHomeDto>(`/brands/${brand.id}/home?market=CN`, {
            token: tenant.session.accessToken,
          }),
          'GET /home',
        );
        const homeArticle = home.recentArticles.find((a) => a.id === article.id);
        expect(homeArticle).toBeTruthy();
        expect(homeArticle?.publishRecord?.afterMetrics).not.toBeNull();

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/home?brandId=${brand.id}&market=CN`,
        );
        try {
          const recentCard = page.getByTestId('home-recent-articles');
          await expect(recentCard).toBeVisible();
          await expect(recentCard).toContainText(article.title);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-15 STRICT vs SHADOW billing ledgers (2/10/5 pts) & /account hides ¥0.00 / 余额明细',
      { tag: ['@tier3', '@F2', '@F4', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't315');
        const strictTenant = await provisionIsolatedTenant({
          prefix: 't315s',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const shadowTenant = await provisionIsolatedTenant({
          prefix: 't315h',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });

        const cleanupMedia: Array<{
          session: typeof strictTenant.session;
          brandId: string;
          mediaId: string;
        }> = [];

        try {
          for (const [label, tenant] of [
            ['strict', strictTenant],
            ['shadow', shadowTenant],
          ] as const) {
            const brand = await createBrandApi(
              tenant.session,
              buildCnBrandPayload(`${tag}${label}`),
            );
            const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
              (e) => e.available || e.status === 'online',
            );
            expect(onlineCn.length).toBeGreaterThanOrEqual(2);

            // 1. Visibility check: 2 engines * 1 prompt * 2 pts = 4 pts
            const run = await createVisibilityRunApi(
              tenant.session,
              brand.id,
              {
                market: 'CN',
                prompts: [`计费对账监测 ${tag}-${label}`],
                engines: onlineCn.slice(0, 2).map((e) => e.key),
              },
              uniqueIdempotencyKey(testInfo, `t315r_${label}`),
            );
            await waitForVisibilityRunApi(tenant.session, brand.id, run.id);

            // 2. GEO article SSE: 10 pts
            const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
              token: tenant.session.accessToken,
              idempotencyKey: uniqueIdempotencyKey(testInfo, `t315a_${label}`),
              body: {
                market: 'CN',
                recipe: 'AUTHORITY_GUIDE',
                targetFormat: 'CN_DEEP_REVIEW',
                targetPrompt: `${brand.name} 计费对账实测文章`,
              },
            });
            expect(sse.status).toBe(200);

            // 3. Inline AI image: 5 pts
            const img = unwrapOk(
              await requestV2<BrandMediaAssetDto>(`/brands/${brand.id}/media/ai-gen`, {
                method: 'POST',
                token: tenant.session.accessToken,
                headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, `t315i_${label}`) },
                body: {
                  prompt: '简约白色桌面 NAS 外观配图',
                  title: `计费图 ${tag}-${label}`,
                },
              }),
              `POST media/ai-gen (${label})`,
            );
            cleanupMedia.push({ session: tenant.session, brandId: brand.id, mediaId: img.id });
          }

          // STRICT wallet: 100 - (2 + 2) - 10 - 5 = 81 (visibility_check settles 2 pts per observation)
          const strictWallet = await getTenantWallet(strictTenant.session);
          expect(strictWallet.points).toBe(81);
          expect(strictWallet.pointsReserved).toBe(0);
          const strictLogs = await getTenantPointLogs(strictTenant.session, 50);
          const strictNegEntries = strictLogs.items.filter((i) => i.delta < 0);
          const strictNegDeltasSorted = strictNegEntries.map((i) => i.delta).sort((a, b) => a - b);
          expect(strictNegDeltasSorted).toEqual([-10, -5, -2, -2]);
          expect(strictNegDeltasSorted.reduce((sum, d) => sum + d, 0)).toBe(-19);
          expect(
            strictNegEntries.every((i) => i.status === 'SETTLED' && i.listPrice === -i.delta),
          ).toBe(true);

          // SHADOW wallet: unchanged 100 with delta === 0 listPrice records (2, 2, 10, 5)
          const shadowWallet = await getTenantWallet(shadowTenant.session);
          expect(shadowWallet.points).toBe(100);
          expect(shadowWallet.pointsReserved).toBe(0);
          const shadowLogs = await getTenantPointLogs(shadowTenant.session, 50);
          const shadowEntries = shadowLogs.items.filter((i) => i.delta === 0 && i.listPrice > 0);
          const shadowListPricesSorted = shadowEntries
            .map((i) => i.listPrice)
            .sort((a, b) => a - b);
          expect(shadowListPricesSorted).toEqual([2, 2, 5, 10]);
          expect(shadowListPricesSorted.reduce((sum, p) => sum + p, 0)).toBe(19);
          expect(shadowEntries.every((i) => i.status === 'SETTLED')).toBe(true);

          // Open /account as STRICT merchant: verify points tab & complete absence of ¥0.00 / 余额明细
          const { context, page, errors } = await openAuthenticatedPage(
            browser,
            strictTenant.session,
            '/account',
          );
          try {
            await expect(page.locator('body')).toContainText('81');
            await expect(page.getByRole('tab', { name: '点数明细' })).toBeVisible();
            await expect(page.getByRole('tab', { name: /余额明细/ })).toHaveCount(0);
            const bodyText = await page.locator('body').innerText();
            expect(bodyText).not.toContain('¥0.00');
            assertNoConsoleOrPageErrors(errors);
          } finally {
            await context.close();
          }
        } finally {
          for (const item of cleanupMedia) {
            await deleteBrandMediaApi(item.session, item.brandId, item.mediaId).catch(
              () => undefined,
            );
          }
        }
      },
    );

    test(
      'T3-16 GeoBatchJob partial failure atomically refunds failed item (#321 zero fake template)',
      { tag: ['@tier3', '@F2', '@F14', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't316');
        const tenant = await provisionIsolatedTenant({
          prefix: 't316',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const prompts = [
          `${brand.name} 批量成功主题1 ${tag}`,
          `${brand.name} 批量故障主题2 ${tag} ${E2E_SENTINELS.LLM_FAIL}`,
          `${brand.name} 批量成功主题3 ${tag}`,
        ];
        const briefs: GeoBriefDto[] = [];
        for (const p of prompts) {
          briefs.push(
            unwrapOk(
              await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
                method: 'POST',
                token: tenant.session.accessToken,
                body: { market: 'CN', sourceType: 'MANUAL', customPrompt: p },
              }),
              'create batch brief',
            ),
          );
        }

        const job = unwrapOk(
          await requestV2<GeoBatchJobDto>(`/brands/${brand.id}/articles/batch`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't316batch') },
            body: { market: 'CN', briefIds: briefs.map((b) => b.id) },
          }),
          'POST /articles/batch (1 failing item)',
        );
        const done = await waitForBatchJobApi(tenant.session, brand.id, job.id);
        expect(done.total).toBe(3);
        expect(done.doneCount).toBe(2);
        expect(done.failCount).toBe(1);

        const articlesRes = unwrapOk(
          await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
            `/brands/${brand.id}/articles?market=CN`,
            { token: tenant.session.accessToken },
          ),
          'GET articles after partial batch',
        );
        const jobArticles = extractItems(articlesRes).filter((a) => a.batchJobId === job.id);
        expect(jobArticles).toHaveLength(2);
        expect(jobArticles.some((a) => a.briefId === briefs[1].id)).toBe(false);

        // 100 - 30 frozen + 10 refunded = 80
        const wallet = await getTenantWallet(tenant.session);
        expect(wallet.points).toBe(80);
        expect(wallet.pointsReserved).toBe(0);
      },
    );

    test(
      'T3-17 All 7 free rate-limited v2 endpoints strictly charge 0 points in STRICT mode',
      { tag: ['@tier3', '@F2', '@F7', '@F11', '@F14', '@F15', '@F16', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't317');
        const tenant = await provisionIsolatedTenant({
          prefix: 't317',
          billingMode: 'STRICT',
          initialPoints: 50,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        // Stream 1 baseline article (50 -> 40 pts)
        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't317base'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 四盘位 NAS 实测指南`,
          },
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;

        const balanceBefore = (await getTenantWallet(tenant.session)).points;
        expect(balanceBefore).toBe(40);

        // 1. POST /facts/extract
        unwrapOk(
          await requestV2(`/brands/${brand.id}/facts/extract`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              sourceType: 'MANUAL',
              rawText: `${brand.name} 搭载 Intel N100、双 2.5GbE 网口与 18.5dB 静音风道，通过 ISO9001 认证。`,
            },
          }),
          '1. POST /facts/extract',
        );

        // 2. POST /briefs/generate
        unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} 免费意见卡测试 ${tag}`,
            },
          }),
          '2. POST /briefs/generate',
        );

        // 3. POST /briefs/from-citation-url
        unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              citationUrl: FIXTURE_URLS.competitorNasReview,
            },
          }),
          '3. POST /briefs/from-citation-url',
        );

        // 4. POST /articles/:id/rewrite-section
        unwrapOk(
          await requestV2(`/articles/${article.id}/rewrite-section`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              action: 'DE_AD',
              selectedText: article.contentMarkdown.slice(0, 180),
            },
          }),
          '4. POST /articles/:id/rewrite-section',
        );

        // 5. POST /articles/:id/evaluate-geo
        const evalRes = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${article.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          '5. POST /articles/:id/evaluate-geo',
        );
        assertGeoScoreValid(evalRes.geoScore, evalRes.geoScoreDetail);

        // 6. GET /articles/:id/export?format=docx
        const docxRes = await requestV2Binary(`/articles/${article.id}/export?format=docx`, {
          token: tenant.session.accessToken,
        });
        expect(docxRes.status).toBe(200);
        assertValidDocxWithTable(docxRes.bytes);

        // 7. POST /articles/:id/publish-records
        unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${article.id}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://xingyaonas-${tag}.example/blog/free-check`,
              channel: '官网博客',
            },
          }),
          '7. POST /articles/:id/publish-records',
        );

        const balanceAfter = (await getTenantWallet(tenant.session)).points;
        expect(balanceAfter).toBe(balanceBefore);
      },
    );

    test(
      'T3-18 Admin /admin/pricing live update reflects in SSE billing and restores cleanly in finally',
      { tag: ['@tier3', '@F2', '@F12', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't318');
        const pricingItems = await getAdminPricing();
        const actions = pricingItems.map((i) => i.action).sort();
        expect(actions).toEqual(['geo_write', 'inline_image_gen', 'visibility_check']);
        expect(actions).not.toContain('kb_addon');

        const originalPrice = pricingItems.find((i) => i.action === 'geo_write')?.unitPoints ?? 10;

        const tenant = await provisionIsolatedTenant({
          prefix: 't318',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        try {
          await updateAdminPricing('geo_write', 15, true);

          const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 't318p15'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${brand.name} 动态定价实测文章`,
            },
          });
          expect(sse.status).toBe(200);
          expect(sse.meta?.unitPrice).toBe(15);

          const wallet = await getTenantWallet(tenant.session);
          expect(wallet.points).toBe(85);

          const { context, page, errors } = await openAuthenticatedPage(
            browser,
            getAdminSession(),
            '/admin/pricing',
          );
          try {
            await expect(page.locator('body')).toContainText('GEO 靶向写作', { timeout: 15_000 });
            const bodyText = await page.locator('body').innerText();
            expect(bodyText).toContain('GEO 靶向写作');
            expect(bodyText).toContain('AI 可见性监测');
            expect(bodyText).toContain('行内 AI 配图');
            expect(bodyText).not.toContain('kb_addon');
            expect(bodyText).not.toContain('知识库加价');
            assertNoConsoleOrPageErrors(errors);
          } finally {
            await context.close();
          }
        } finally {
          await updateAdminPricing('geo_write', originalPrice, true);
        }
      },
    );

    test(
      'T3-22 Idempotency-Key replay protection prevents double-charging across all 5 billable v2 endpoints',
      { tag: ['@tier3', '@F2', '@F9', '@F12', '@F14', '@F15', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't322');
        const tenant = await provisionIsolatedTenant({
          prefix: 't322',
          billingMode: 'STRICT',
          initialPoints: 200,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const singleEngine = [onlineCn[0].key];
        const createdMediaIds: string[] = [];

        try {
          // 1. POST /visibility/runs (1 engine * 1 prompt = 2 pts)
          const b0 = (await getTenantWallet(tenant.session)).points;
          const runKey = uniqueIdempotencyKey(testInfo, 't322run');
          const run1 = await createVisibilityRunApi(
            tenant.session,
            brand.id,
            { market: 'CN', prompts: [`幂等测试 ${tag}`], engines: singleEngine },
            runKey,
          );
          await waitForVisibilityRunApi(tenant.session, brand.id, run1.id);
          await requestV2(`/brands/${brand.id}/visibility/runs`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': runKey },
            body: { market: 'CN', prompts: [`幂等测试 ${tag}`], engines: singleEngine },
          });
          const b1 = (await getTenantWallet(tenant.session)).points;
          expect(b0 - b1, 'POST /visibility/runs must charge only once on duplicate key').toBe(2);

          // 2. POST /articles/stream (10 pts)
          const streamKey = uniqueIdempotencyKey(testInfo, 't322sse');
          const streamBody = {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 幂等流式写作 ${tag}`,
          };
          const s1 = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: streamKey,
            body: streamBody,
          });
          expect(s1.status).toBe(200);
          const article = s1.complete!.article;

          await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: streamKey,
            body: streamBody,
            assertSseHeaders: false,
          });
          const b2 = (await getTenantWallet(tenant.session)).points;
          expect(b1 - b2, 'POST /articles/stream must charge only once on duplicate key').toBe(10);

          // 3. POST /articles/batch (2 briefs = 20 pts)
          const br1 = unwrapOk(
            await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
              method: 'POST',
              token: tenant.session.accessToken,
              body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `幂等批量1 ${tag}` },
            }),
            'brief 1',
          );
          const br2 = unwrapOk(
            await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
              method: 'POST',
              token: tenant.session.accessToken,
              body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `幂等批量2 ${tag}` },
            }),
            'brief 2',
          );
          const batchKey = uniqueIdempotencyKey(testInfo, 't322batch');
          const batch1 = unwrapOk(
            await requestV2<GeoBatchJobDto>(`/brands/${brand.id}/articles/batch`, {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': batchKey },
              body: { market: 'CN', briefIds: [br1.id, br2.id] },
            }),
            'batch 1',
          );
          await waitForBatchJobApi(tenant.session, brand.id, batch1.id);
          await requestV2(`/brands/${brand.id}/articles/batch`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': batchKey },
            body: { market: 'CN', briefIds: [br1.id, br2.id] },
          });
          const b3 = (await getTenantWallet(tenant.session)).points;
          expect(b2 - b3, 'POST /articles/batch must charge only once on duplicate key').toBe(20);

          // 4. POST /media/ai-gen (5 pts)
          const imgKey = uniqueIdempotencyKey(testInfo, 't322img');
          const imgBody = { prompt: '四盘位 NAS 金属外观', title: `幂等图 ${tag}` };
          const img1 = unwrapOk(
            await requestV2<BrandMediaAssetDto>(`/brands/${brand.id}/media/ai-gen`, {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': imgKey },
              body: imgBody,
            }),
            'ai-gen 1',
          );
          createdMediaIds.push(img1.id);
          await requestV2(`/brands/${brand.id}/media/ai-gen`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': imgKey },
            body: imgBody,
          });
          const b4 = (await getTenantWallet(tenant.session)).points;
          expect(b3 - b4, 'POST /media/ai-gen must charge only once on duplicate key').toBe(5);

          // 5. POST /publish-records/:id/retest (1 engine * 1 prompt = 2 pts)
          const pub = unwrapOk(
            await requestV2<GeoPublishRecordDto>(`/articles/${article.id}/publish-records`, {
              method: 'POST',
              token: tenant.session.accessToken,
              body: {
                publishedUrl: `https://xingyaonas-${tag}.example/blog/idem`,
                channel: '官网博客',
              },
            }),
            'create publish record',
          );
          const retestKey = uniqueIdempotencyKey(testInfo, 't322ret');
          const ret1 = unwrapOk(
            await requestV2<{ run?: VisibilityRunDto; id?: string }>(
              `/publish-records/${pub.id}/retest`,
              {
                method: 'POST',
                token: tenant.session.accessToken,
                headers: { 'idempotency-key': retestKey },
                body: { engines: singleEngine },
              },
            ),
            'retest 1',
          );
          const retRunId = ret1.run?.id ?? ret1.id;
          expect(retRunId).toBeTruthy();
          await waitForVisibilityRunApi(tenant.session, brand.id, retRunId!);
          await requestV2(`/publish-records/${pub.id}/retest`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': retestKey },
            body: { engines: singleEngine },
          });
          const b5 = (await getTenantWallet(tenant.session)).points;
          expect(
            b4 - b5,
            'POST /publish-records/:id/retest must charge only once on duplicate key',
          ).toBe(2);
        } finally {
          for (const mediaId of createdMediaIds) {
            await deleteBrandMediaApi(tenant.session, brand.id, mediaId).catch(() => undefined);
          }
        }
      },
    );
  },
);
