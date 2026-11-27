import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  deleteBrandMediaApi,
  extractItems,
  getAdminSession,
  getTenantWallet,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
  waitForBatchJobApi,
  waitForVisibilityRunApi,
  type BrandMediaAssetDto,
  type GeoArticleDto,
  type GeoBatchJobDto,
  type GeoBriefDto,
  type GeoPublishRecordDto,
  type VisibilityRunDto,
} from './support/api-client';
import {
  assertNoConsoleOrPageErrors,
  assertNoHorizontalOverflow,
  REQUIRED_VIEWPORTS,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import { openAuthenticatedPage, switchGlobalBrand } from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 5 — Adversarial Security, Billing, Isolation & UI Race Hardening',
  {
    tag: ['@tier5'],
  },
  () => {
    // ==================== Backend Adversarial (T5-B01 .. T5-B06) ====================

    test(
      'T5-B01 Delete-and-replay Idempotency-Key on POST /visibility/runs in STRICT mode returns 409/40902 (zero free runs at 0 balance)',
      { tag: ['@tier5', '@F2', '@F9'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b01');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5b01',
          billingMode: 'STRICT',
          initialPoints: 2,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available,
        );
        expect(onlineCn.length).toBeGreaterThanOrEqual(1);
        const engine = onlineCn[0]!.key;
        const idemKey = uniqueIdempotencyKey(testInfo, 't5b01_replay');

        // Run 1: 1 engine x 1 prompt = 2 pts -> settles wallet 2 -> 0
        const run1 = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`${brand.name} 四盘位 NAS 静音实测 ${tag}`],
            engines: [engine],
          },
          idemKey,
        );
        const done1 = await waitForVisibilityRunApi(tenant.session, brand.id, run1.id);
        expect(done1.status).toBe('COMPLETED');

        const walletAfterRun1 = await getTenantWallet(tenant.session);
        expect(walletAfterRun1.points).toBe(0);
        expect(walletAfterRun1.pointsReserved).toBe(0);

        // Delete completed Run 1
        const delRes = await requestV2(`/brands/${brand.id}/visibility/runs/${run1.id}`, {
          method: 'DELETE',
          token: tenant.session.accessToken,
        });
        expect(delRes.status).toBe(200);

        // Replay SAME Idempotency-Key at 0 balance with a brand new prompt -> MUST reject 409 / 40901
        const replayRes = await requestV2(`/brands/${brand.id}/visibility/runs`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': idemKey },
          body: {
            market: 'CN',
            prompts: [`免费套利二次监测问题 ${tag}`],
            engines: [engine],
          },
        });
        expect(replayRes.status).toBe(409);
        expect(replayRes.envelope?.code).toBe(40902);

        const walletAfterReplay = await getTenantWallet(tenant.session);
        expect(walletAfterReplay.points).toBe(0);
        expect(walletAfterReplay.pointsReserved).toBe(0);

        const runsRes = await requestV2<{ items: VisibilityRunDto[] }>(
          `/brands/${brand.id}/visibility/runs`,
          {
            token: tenant.session.accessToken,
          },
        );
        expect(runsRes.status).toBe(200);
        expect(extractItems<VisibilityRunDto>(runsRes.envelope?.data)).toHaveLength(0);
      },
    );

    test(
      'T5-B02 SSRF allowlist (sonargate), trailing-dot hostnames, and IPv4-compatible/translated IPv6 blocked with 400 on /facts/extract & /briefs/from-citation-url',
      { tag: ['@tier5', '@F6', '@F12'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b02');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5b02',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        const adversarialUrls = [
          'http://sonargate:8080/health',
          'http://localhost./',
          'http://metadata.google.internal./',
          'http://[::127.0.0.1]/',
          'http://[::ffff:0:127.0.0.1]/',
          'http://[2002:7f00::1]/',
          'http://[64:ff9b::1]/',
        ];

        for (const badUrl of adversarialUrls) {
          const extractRes = await requestV2(`/brands/${brand.id}/facts/extract`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: { sourceType: 'URL_EXTRACT', url: badUrl },
          });
          expect(extractRes.status, `facts/extract must reject ${badUrl} with 400`).toBe(400);

          const counterRes = await requestV2(`/brands/${brand.id}/briefs/from-citation-url`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: { market: 'CN', citationUrl: badUrl },
          });
          expect(counterRes.status, `briefs/from-citation-url must reject ${badUrl} with 400`).toBe(
            400,
          );
        }
      },
    );

    test(
      'T5-B03 Concurrent STRICT billing contention (10 pts vs 2 parallel streams) & duplicate Idempotency-Key batch race settle cleanly',
      { tag: ['@tier5', '@F2', '@F12'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b03');

        // Part A: Strictly 1 of 2 parallel 10-pt SSE streams succeeds on a 10-pt STRICT wallet
        const tightTenant = await provisionIsolatedTenant({
          prefix: 't5b03a',
          billingMode: 'STRICT',
          initialPoints: 10,
        });
        const tightBrand = await createBrandApi(tightTenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(
          tightTenant.session,
          tightBrand.id,
          buildFourBrandFacts(tightBrand.name),
        );

        const [stream1, stream2] = await Promise.all([
          consumeSsePost(`/brands/${tightBrand.id}/articles/stream`, {
            token: tightTenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b03_s1'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${tightBrand.name} 并发扣费测试一 ${tag}`,
            },
          }),
          consumeSsePost(`/brands/${tightBrand.id}/articles/stream`, {
            token: tightTenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b03_s2'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${tightBrand.name} 并发扣费测试二 ${tag}`,
            },
          }),
        ]);

        const statuses = [stream1.status, stream2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 402]);
        const winnerStream = stream1.status === 200 ? stream1 : stream2;
        const loserStream = stream1.status === 402 ? stream1 : stream2;
        expect(winnerStream.complete?.article.id).toBeTruthy();
        expect(loserStream.errorBody?.code).toBe(40201);

        const tightWallet = await getTenantWallet(tightTenant.session);
        expect(tightWallet.points).toBe(0);
        expect(tightWallet.pointsReserved).toBe(0);

        // Part B: 2 concurrent POST /articles/batch with identical Idempotency-Key never close winner's reservation
        const batchTenant = await provisionIsolatedTenant({
          prefix: 't5b03b',
          billingMode: 'STRICT',
          initialPoints: 50,
        });
        const batchBrand = await createBrandApi(batchTenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(
          batchTenant.session,
          batchBrand.id,
          buildFourBrandFacts(batchBrand.name),
        );

        const brief1 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${batchBrand.id}/briefs/generate`, {
            method: 'POST',
            token: batchTenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${batchBrand.name} 并发批量问题一 ${tag}`,
            },
          }),
          'generate brief 1',
        );
        const brief2 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${batchBrand.id}/briefs/generate`, {
            method: 'POST',
            token: batchTenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${batchBrand.name} 并发批量问题二 ${tag}`,
            },
          }),
          'generate brief 2',
        );

        const sharedBatchKey = uniqueIdempotencyKey(testInfo, 't5b03_batch_race');
        const [batchRes1, batchRes2] = await Promise.all([
          requestV2<GeoBatchJobDto>(`/brands/${batchBrand.id}/articles/batch`, {
            method: 'POST',
            token: batchTenant.session.accessToken,
            headers: { 'idempotency-key': sharedBatchKey },
            body: { market: 'CN', briefIds: [brief1.id, brief2.id] },
          }),
          requestV2<GeoBatchJobDto>(`/brands/${batchBrand.id}/articles/batch`, {
            method: 'POST',
            token: batchTenant.session.accessToken,
            headers: { 'idempotency-key': sharedBatchKey },
            body: { market: 'CN', briefIds: [brief1.id, brief2.id] },
          }),
        ]);

        expect(batchRes1.status).toBe(200);
        expect(batchRes2.status).toBe(200);
        const jobId = batchRes1.envelope.data.id;
        expect(batchRes2.envelope.data.id).toBe(jobId);

        const settledJob = await waitForBatchJobApi(batchTenant.session, batchBrand.id, jobId);
        expect(settledJob.status).toBe('COMPLETED');
        expect(settledJob.doneCount).toBe(2);
        expect(settledJob.failCount).toBe(0);

        const batchWallet = await getTenantWallet(batchTenant.session);
        expect(batchWallet.points).toBe(30);
        expect(batchWallet.pointsReserved).toBe(0);
      },
    );

    test(
      'T5-B04 Cross-brand & cross-market retestArticleId IDOR rejected with 404 and query/body market mismatch rejected with 400',
      { tag: ['@tier5', '@F9', '@F17'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b04');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5b04',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brandA = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        const brandB = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}b`));

        const cnEngines = (await listMarketEnginesApi(tenant.session, brandA.id, 'CN')).filter(
          (e) => e.available,
        );
        expect(cnEngines.length).toBeGreaterThanOrEqual(1);

        // Generate & publish an article under Brand B (CN) and under Brand A (GLOBAL)
        const sseB = await consumeSsePost(`/brands/${brandB.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b04_artb'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brandB.name} 独立复测隔离测试 ${tag}`,
          },
        });
        expect(sseB.status).toBe(200);
        const articleBId = sseB.complete!.article.id;
        unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${articleBId}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://brandb-${tag}.example/guide`,
              channel: '官网博客',
            },
          }),
          'publish Brand B article',
        );

        const sseAGlobal = await consumeSsePost(`/brands/${brandA.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b04_artagl'),
          body: {
            market: 'GLOBAL',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt: `Best NAS cross-market isolation test ${tag}`,
          },
        });
        expect(sseAGlobal.status).toBe(200);
        const articleAGlobalId = sseAGlobal.complete!.article.id;
        unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${articleAGlobalId}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://global-${tag}.example/review`,
              channel: '独立站 Blog',
            },
          }),
          'publish Brand A GLOBAL article',
        );

        // 1. Mismatched ?market=GLOBAL vs body.market='CN' -> 400
        const mismatchRes = await requestV2(`/brands/${brandA.id}/visibility/runs?market=GLOBAL`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't5b04_mm') },
          body: {
            market: 'CN',
            prompts: ['市场参数冲突测试'],
            engines: [cnEngines[0]!.key],
          },
        });
        expect(mismatchRes.status).toBe(400);

        // 2. Brand A CN run passing Brand B's articleId as retestArticleId -> 404
        const crossBrandRes = await requestV2(`/brands/${brandA.id}/visibility/runs`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't5b04_cb') },
          body: {
            market: 'CN',
            prompts: ['跨品牌复测越权测试'],
            engines: [cnEngines[0]!.key],
            triggerType: 'RETEST',
            retestArticleId: articleBId,
          },
        });
        expect(crossBrandRes.status).toBe(404);

        // 3. Brand A CN run passing Brand A GLOBAL's articleId as retestArticleId -> 404
        const crossMarketRes = await requestV2(`/brands/${brandA.id}/visibility/runs`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't5b04_cm') },
          body: {
            market: 'CN',
            prompts: ['跨市场复测越权测试'],
            engines: [cnEngines[0]!.key],
            triggerType: 'RETEST',
            retestArticleId: articleAGlobalId,
          },
        });
        expect(crossMarketRes.status).toBe(404);

        // Verify neither publish record was corrupted
        const pubB = extractItems<GeoPublishRecordDto>(
          (
            await requestV2<{ items: GeoPublishRecordDto[] }>(
              `/articles/${articleBId}/publish-records`,
              {
                token: tenant.session.accessToken,
              },
            )
          ).envelope?.data,
        );
        expect(pubB[0]?.afterMetrics).toBeNull();

        const pubAGlobal = extractItems<GeoPublishRecordDto>(
          (
            await requestV2<{ items: GeoPublishRecordDto[] }>(
              `/articles/${articleAGlobalId}/publish-records`,
              {
                token: tenant.session.accessToken,
              },
            )
          ).envelope?.data,
        );
        expect(pubAGlobal[0]?.afterMetrics).toBeNull();
      },
    );

    test(
      'T5-B05 PATCH /api/v2/articles/:id rejects prohibited contentHtml with 403/40302 and sanitizes CN superlatives',
      { tag: ['@tier5', '@F13'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b05');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5b05',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b05_art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 合规测试文章 ${tag}`,
          },
        });
        expect(sse.status).toBe(200);
        const articleId = sse.complete!.article.id;

        const badHtmlRes = await requestV2(`/articles/${articleId}`, {
          method: 'PATCH',
          token: tenant.session.accessToken,
          body: {
            contentHtml: '<p>非法赌博 洗钱 违禁内容绕过测试</p>',
          },
        });
        expect(badHtmlRes.status).toBe(403);
        expect(badHtmlRes.envelope?.code).toBe(40302);

        const afterRejected = unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
            token: tenant.session.accessToken,
          }),
          'GET article after rejected contentHtml',
        );
        expect(afterRejected.contentHtml).not.toContain('非法赌博');

        // CN superlatives in contentHtml must be replaced cleanly
        const superlativeRes = await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
          method: 'PATCH',
          token: tenant.session.accessToken,
          body: {
            contentHtml: '<p>这是全网第一的家用存储实测表现</p>',
          },
        });
        expect(superlativeRes.status).toBe(200);
        expect(superlativeRes.envelope.data.contentHtml).not.toContain('全网第一');
        expect(superlativeRes.envelope.data.contentHtml).toContain('较为靠前');

        // B-06-R (1): Numeric HTML entities (decimal & hex) for prohibited terms rejected 403/40302
        for (const entityHtml of [
          '<p>&#38750;&#27861;&#36172;&#21338; &#27927;&#38065;</p>',
          '<p>&#x975e;&#x6cd5;&#x8d4c;&#x535a;</p>',
        ]) {
          const entityRes = await requestV2(`/articles/${articleId}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { contentHtml: entityHtml },
          });
          expect(entityRes.status, `numeric entity ${entityHtml} must return 403`).toBe(403);
          expect(entityRes.envelope?.code).toBe(40302);
        }

        // B-06-R (2): <img alt="..."> prohibited terms rejected 403/40302 and CN superlatives replaced
        const badAltRes = await requestV2(`/articles/${articleId}`, {
          method: 'PATCH',
          token: tenant.session.accessToken,
          body: {
            contentHtml: `<img src="/api/v2/brands/${brand.id}/media/m1/file" alt="非法赌博 洗钱 全网第一" />`,
          },
        });
        expect(badAltRes.status).toBe(403);
        expect(badAltRes.envelope?.code).toBe(40302);

        const altSuperlativeRes = await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
          method: 'PATCH',
          token: tenant.session.accessToken,
          body: {
            contentHtml: `<img src="/api/v2/brands/${brand.id}/media/m1/file" alt="全网第一家用静音NAS" />`,
          },
        });
        expect(altSuperlativeRes.status).toBe(200);
        expect(altSuperlativeRes.envelope.data.contentHtml).not.toContain('全网第一');
        expect(altSuperlativeRes.envelope.data.contentHtml).toContain('较为靠前家用静音NAS');

        // B-06-R (3): Inline-tag split CN superlatives replaced cleanly across tags
        const splitSuperlativeRes = await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
          method: 'PATCH',
          token: tenant.session.accessToken,
          body: {
            contentHtml: '<p>全网<b>第一</b>与国<em>家</em>级实测存储方案</p>',
          },
        });
        expect(splitSuperlativeRes.status).toBe(200);
        expect(splitSuperlativeRes.envelope.data.contentHtml).toContain('较为靠前');
        expect(splitSuperlativeRes.envelope.data.contentHtml).toContain('行业内');
        expect(splitSuperlativeRes.envelope.data.contentHtml).not.toContain('第一');
        expect(splitSuperlativeRes.envelope.data.contentHtml).not.toContain('国家级');
      },
    );

    test(
      'T5-B06 Cross-tenant & cross-brand IDOR matrix enforces strict 404 isolation across all v2 resources',
      { tag: ['@tier5', '@F1', '@F6', '@F9', '@F12'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't5b06');
        const tenantA = await provisionIsolatedTenant({
          prefix: 't5b06a',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const tenantB = await provisionIsolatedTenant({
          prefix: 't5b06b',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });

        const brandA1 = await createBrandApi(tenantA.session, buildCnBrandPayload(`${tag}a1`));
        const brandA2 = await createBrandApi(tenantA.session, buildCnBrandPayload(`${tag}a2`));
        await upsertBrandFactsApi(tenantA.session, brandA1.id, buildFourBrandFacts(brandA1.name));

        const cleanupMedia: Array<{ brandId: string; mediaId: string }> = [];
        try {
          const mediaA2 = unwrapOk(
            await requestV2<BrandMediaAssetDto>(`/brands/${brandA2.id}/media/ai-gen`, {
              method: 'POST',
              token: tenantA.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't5b06_img') },
              body: { prompt: '白色四盘位存储设备外观图', title: `图-${tag}` },
            }),
            'create Brand A2 media',
          );
          cleanupMedia.push({ brandId: brandA2.id, mediaId: mediaA2.id });

          const briefA1 = unwrapOk(
            await requestV2<GeoBriefDto>(`/brands/${brandA1.id}/briefs/generate`, {
              method: 'POST',
              token: tenantA.session.accessToken,
              body: {
                market: 'CN',
                sourceType: 'MANUAL',
                customPrompt: `${brandA1.name} 隔离测试问题 A1`,
              },
            }),
            'create Brief A1',
          );
          const briefA2 = unwrapOk(
            await requestV2<GeoBriefDto>(`/brands/${brandA2.id}/briefs/generate`, {
              method: 'POST',
              token: tenantA.session.accessToken,
              body: {
                market: 'CN',
                sourceType: 'MANUAL',
                customPrompt: `${brandA2.name} 隔离测试问题 A2`,
              },
            }),
            'create Brief A2',
          );

          const sseA1 = await consumeSsePost(`/brands/${brandA1.id}/articles/stream`, {
            token: tenantA.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 't5b06_art'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${brandA1.name} 租户隔离文章`,
            },
          });
          expect(sseA1.status).toBe(200);
          const articleA1Id = sseA1.complete!.article.id;

          const cnEngines = (await listMarketEnginesApi(tenantA.session, brandA1.id, 'CN')).filter(
            (e) => e.available,
          );
          const runA1 = await createVisibilityRunApi(
            tenantA.session,
            brandA1.id,
            { market: 'CN', prompts: ['租户隔离监测'], engines: [cnEngines[0]!.key] },
            uniqueIdempotencyKey(testInfo, 't5b06_run'),
          );

          // Cross-tenant: Tenant B MUST get 404 on every Tenant A resource
          const crossTenantProbes: Array<{
            method: 'GET' | 'PATCH' | 'DELETE';
            path: string;
            body?: unknown;
          }> = [
            { method: 'GET', path: `/brands/${brandA1.id}` },
            { method: 'PATCH', path: `/brands/${brandA1.id}`, body: { name: '篡改名' } },
            { method: 'DELETE', path: `/brands/${brandA1.id}` },
            { method: 'GET', path: `/brands/${brandA1.id}/facts` },
            { method: 'GET', path: `/brands/${brandA2.id}/media` },
            { method: 'DELETE', path: `/brands/${brandA2.id}/media/${mediaA2.id}` },
            { method: 'GET', path: `/brands/${brandA1.id}/visibility/runs/${runA1.id}` },
            { method: 'GET', path: `/briefs/${briefA1.id}` },
            {
              method: 'PATCH',
              path: `/briefs/${briefA1.id}`,
              body: { suggestedTitle: '篡改标题' },
            },
            { method: 'GET', path: `/articles/${articleA1Id}` },
            { method: 'PATCH', path: `/articles/${articleA1Id}`, body: { title: '篡改文章' } },
            { method: 'DELETE', path: `/articles/${articleA1Id}` },
            { method: 'GET', path: `/articles/${articleA1Id}/publish-records` },
          ];
          for (const probe of crossTenantProbes) {
            const res = await requestV2(probe.path, {
              method: probe.method,
              token: tenantB.session.accessToken,
              body: probe.body,
            });
            expect(res.status, `Tenant B ${probe.method} ${probe.path} must return 404`).toBe(404);
          }

          // Cross-brand within Tenant A: Brand A1 endpoints reject Brand A2's mediaId & briefId
          const crossBrandMediaDel = await requestV2(`/brands/${brandA1.id}/media/${mediaA2.id}`, {
            method: 'DELETE',
            token: tenantA.session.accessToken,
          });
          expect(crossBrandMediaDel.status).toBe(404);

          const crossBrandBatch = await requestV2(`/brands/${brandA1.id}/articles/batch`, {
            method: 'POST',
            token: tenantA.session.accessToken,
            headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't5b06_cb_batch') },
            body: { market: 'CN', briefIds: [briefA1.id, briefA2.id] },
          });
          expect(crossBrandBatch.status).toBe(404);
        } finally {
          for (const m of cleanupMedia) {
            await deleteBrandMediaApi(tenantA.session, m.brandId, m.mediaId).catch(() => undefined);
          }
        }
      },
    );

    // ==================== Frontend / UI Adversarial (T5-UI-01 .. T5-UI-06) ====================

    test(
      'T5-UI-01 Deleted/foreign ?brandId= URL coercion & active-brand deletion fallback to next brand and 0-brand onboarding',
      { tag: ['@tier5', '@F1', '@F5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui01');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui01',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand1 = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}1`));
        const brand2 = await createBrandApi(tenant.session, buildDualMarketBrandPayload(`${tag}2`));

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          '/home?brandId=nonexistent_foreign_id_999&market=GLOBAL',
        );
        try {
          // Foreign ?brandId= must coerce cleanly to an owned brand and valid market
          await expect
            .poll(
              () => {
                const u = new URL(page.url());
                const bid = u.searchParams.get('brandId');
                const mkt = u.searchParams.get('market');
                return (
                  (bid === brand1.id && mkt === 'CN') ||
                  (bid === brand2.id && (mkt === 'CN' || mkt === 'GLOBAL'))
                );
              },
              { timeout: 15_000 },
            )
            .toBe(true);
          await expect(page.getByTestId('home-health-strip')).toBeVisible({ timeout: 15_000 });

          // Navigate to /brands with brand1 active and delete brand1 via UI confirm modal
          await page.goto(`/brands?brandId=${brand1.id}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brand1.name, {
            timeout: 15_000,
          });
          await page.getByTestId('brand-actions-trigger').click();
          await page.getByRole('menuitem', { name: '删除品牌' }).click();
          const modal1 = page.locator('.ant-modal-confirm:visible, .ant-modal:visible').last();
          await expect(modal1).toBeVisible();
          await modal1.getByRole('button', { name: '确认删除' }).click();

          // Immediately falls back to brand2
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brand2.name, {
            timeout: 15_000,
          });
          await expect
            .poll(() => new URL(page.url()).searchParams.get('brandId'), { timeout: 10_000 })
            .toBe(brand2.id);

          // Delete remaining brand2 -> clean 0-brand onboarding & URL strips brandId/market
          await page.getByTestId('brand-actions-trigger').click();
          await page.getByRole('menuitem', { name: '删除品牌' }).click();
          const modal2 = page.locator('.ant-modal-confirm:visible, .ant-modal:visible').last();
          await expect(modal2).toBeVisible();
          await modal2.getByRole('button', { name: '确认删除' }).click();

          await expect(
            page.getByRole('button', { name: /新建品牌|60 秒创建首个品牌|创建首个品牌/ }).first(),
          ).toBeVisible({ timeout: 15_000 });
          await expect
            .poll(
              () => {
                const sp = new URL(page.url()).searchParams;
                return sp.get('brandId') === null && sp.get('market') === null;
              },
              { timeout: 10_000 },
            )
            .toBe(true);

          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T5-UI-02 Studio cross-article rewrite preview reset, article B integrity & brand-switch URL param cleanup (W-01, W-05)',
      { tag: ['@tier5', '@F12', '@F14'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui02');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui02',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand1 = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}1`));
        const brand2 = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}2`));

        const sseA = await consumeSsePost(`/brands/${brand1.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5ui02_a'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand1.name} 第一篇测试稿 ${tag}`,
          },
        });
        expect(sseA.status).toBe(200);
        const artA = sseA.complete!.article;

        const sseB = await consumeSsePost(`/brands/${brand1.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5ui02_b'),
          body: {
            market: 'CN',
            recipe: 'COMPARISON_MATRIX',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand1.name} 第二篇独立稿 ${tag}`,
          },
        });
        expect(sseB.status).toBe(200);
        const artB = sseB.complete!.article;
        const originalBMarkdown = artB.contentMarkdown;

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand1.id}&market=CN&articleId=${artA.id}`,
        );
        try {
          await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 15_000 });
          const rewriteDropdownBtn = page.getByTestId('studio-rewrite-dropdown-btn');
          await expect(rewriteDropdownBtn).toBeVisible({ timeout: 15_000 });

          // Trigger inline rewrite preview on Article A via rewrite dropdown -> 去广告
          await rewriteDropdownBtn.click();
          await expect(page.getByTestId('studio-rewrite-menu-DE_AD')).toBeVisible({
            timeout: 10_000,
          });
          await page.getByTestId('studio-rewrite-menu-DE_AD').click();
          await expect(page.getByTestId('studio-rewrite-preview')).toBeVisible({
            timeout: 15_000,
          });

          // Switch to Article B in left pane -> preview MUST disappear immediately
          await page.getByText(artB.title).first().click();
          await expect(page.getByTestId('studio-rewrite-preview')).toHaveCount(0);

          const fetchedB = unwrapOk(
            await requestV2<GeoArticleDto>(`/articles/${artB.id}`, {
              token: tenant.session.accessToken,
            }),
            'GET artB after switch',
          );
          expect(fetchedB.contentMarkdown).toBe(originalBMarkdown);

          // Switch global header brand from Brand 1 to Brand 2 -> ?articleId= stripped, zero 404s
          await switchGlobalBrand(page, brand2.name);
          await expect
            .poll(() => {
              const sp = new URL(page.url()).searchParams;
              return (
                sp.get('brandId') === brand2.id &&
                sp.get('articleId') === null &&
                sp.get('briefId') === null &&
                sp.get('batchJobId') === null
              );
            })
            .toBe(true);

          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T5-UI-03 Duplicate missing-fact capsules, literal $& regex chars & Markdown XSS safety in Studio preview',
      { tag: ['@tier5', '@F14'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui03');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui03',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5ui03_art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 重复留槽与安全测试 ${tag}`,
          },
        });
        expect(sse.status).toBe(200);
        const articleId = sse.complete!.article.id;

        const patchedMarkdown = [
          `## 实测参数说明 (${tag})`,
          '',
          '第一处待补槽位：[待补充：如满载功耗(W)$1]。',
          '',
          '第二处待补槽位：[待补充：如满载功耗(W)$1]。',
          '',
          '安全链接探针：[click](javascript:alert(1)) <script>window.__xss=1</script>',
        ].join('\n');

        unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { contentMarkdown: patchedMarkdown },
          }),
          'PATCH duplicate slots + XSS probe',
        );

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand.id}&market=CN&articleId=${articleId}`,
        );
        try {
          const pills = page.getByTestId('missing-fact-pill');
          await expect(pills).toHaveCount(2, { timeout: 15_000 });

          // Preview DOM must render real studio-preview-body with zero javascript: href and zero <script> (W-09a)
          const preview = page.getByTestId('studio-preview-body');
          await expect(preview).toBeVisible({ timeout: 15_000 });
          await expect(preview).toContainText('安全链接探针');
          await expect(preview.locator('script')).toHaveCount(0);
          await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0);

          const xssCount = await page.evaluate(() => {
            const badLinks = document.querySelectorAll('a[href^="javascript:"]').length;
            const ranXss = Boolean((window as unknown as { __xss?: unknown }).__xss);
            return { badLinks, ranXss };
          });
          expect(xssCount).toEqual({ badLinks: 0, ranXss: false });

          // Click the 2nd pill and fill literal "$&" string without fact sync
          await pills.nth(1).click();
          const pop = page.locator('.ant-popover:visible, .ant-modal:visible').last();
          await expect(pop).toBeVisible();
          await pop.locator('input, textarea').first().fill('18.5W ($& test)');
          const syncCheckbox = pop.locator('input[type="checkbox"]').first();
          await expect(syncCheckbox).toBeVisible();
          if (await syncCheckbox.isChecked()) {
            await syncCheckbox.uncheck();
          }
          await pop.getByRole('button', { name: /确认填入|确认|保存/ }).click();

          const updated = await pollUntil(
            async () =>
              unwrapOk(
                await requestV2<GeoArticleDto>(`/articles/${articleId}`, {
                  token: tenant.session.accessToken,
                }),
                'GET updated duplicate-slot article',
              ),
            (a) => a.contentMarkdown.includes('18.5W ($& test)'),
            { timeoutMs: 15_000, label: 'T5-UI-03 2nd slot backfill' },
          );
          expect(updated.contentMarkdown).toContain('第一处待补槽位：[待补充：如满载功耗(W)$1]');
          expect(updated.contentMarkdown).toContain('第二处待补槽位：18.5W ($& test)');

          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T5-UI-04 Brand list HTTP 500 shows explicit error + Retry (never fake 0-brand empty state) on /visibility & /studio, and recovers on Retry (W-04)',
      { tag: ['@tier5', '@F5', '@F9', '@F12'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui04');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui04',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        const { context, page } = await openAuthenticatedPage(browser, tenant.session);
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        try {
          const failBrandsRoute = async (route: {
            request: () => { method: () => string };
            fulfill: (opts: { status: number; contentType: string; body: string }) => Promise<void>;
            continue: () => Promise<void>;
          }) => {
            if (route.request().method() === 'GET') {
              await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ code: 50000, msg: '模拟品牌服务异常', data: null }),
              });
              return;
            }
            await route.continue();
          };

          await page.route('**/api/v2/brands*', failBrandsRoute);

          // /visibility shows error + retry, NEVER "尚未创建品牌资产"
          await page.goto('/visibility', { waitUntil: 'domcontentloaded' });
          await expect(page.getByText('模拟品牌服务异常')).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText('尚未创建品牌资产')).toHaveCount(0);
          await expect(page.getByTestId('global-brand-switcher-retry')).toBeVisible();

          // /studio shows error + retry, NEVER "暂无品牌" / "尚未创建品牌资产"
          await page.goto('/studio', { waitUntil: 'domcontentloaded' });
          await expect(page.getByText('模拟品牌服务异常')).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText('暂无品牌')).toHaveCount(0);
          await expect(page.getByText('尚未创建品牌资产')).toHaveCount(0);

          // Unroute and click Retry -> Studio loads cleanly with the owned brand
          await page.unroute('**/api/v2/brands*', failBrandsRoute);
          await page
            .locator('.gm-signal-error')
            .getByRole('button', { name: /重\s*试/ })
            .click();
          await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 15_000 });
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brand.name);
          expect(pageErrors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T5-UI-05 Home drawer brief save race across rapid brand switch settles cleanly on Brand B without infinite skeleton (W-02)',
      { tag: ['@tier5', '@F5', '@F17'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui05');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui05',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const brandA = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}a`));
        const brandB = await createBrandApi(tenant.session, buildCnBrandPayload(`${tag}b`));

        unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brandA.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brandA.name} 抽屉竞态测试问题 ${tag}`,
            },
          }),
          'create Brand A brief',
        );

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/home?brandId=${brandA.id}&market=CN`,
        );
        try {
          await expect(page.getByTestId('home-health-strip')).toBeVisible({ timeout: 15_000 });
          await page.getByRole('button', { name: '查看详细意见' }).first().click();
          const drawer = page.getByTestId('geo-brief-drawer');
          await expect(drawer).toBeVisible({ timeout: 15_000 });

          await drawer.getByTestId('brief-drawer-title').fill(`竞态保存修改标题-${tag}`);

          // Delay PATCH /api/v2/briefs/* by 600ms so Brand B switch happens mid-flight
          await page.route('**/api/v2/briefs/*', async (route) => {
            if (route.request().method() === 'PATCH') {
              await new Promise((r) => setTimeout(r, 600));
            }
            await route.continue();
          });

          await drawer.getByTestId('brief-drawer-save-btn').click();
          // Close drawer and immediately switch header brand to Brand B
          await drawer.getByRole('button', { name: '关闭写作意见抽屉' }).click();
          await switchGlobalBrand(page, brandB.name);

          // Wait past the 600ms delayed PATCH and verify /home is settled on Brand B (never stuck in skeleton)
          await page.waitForTimeout(1_000);
          await expect(page.getByTestId('home-health-strip')).toBeVisible({ timeout: 10_000 });
          await expect(page.getByTestId('home-loading')).toHaveCount(0);
          expect(new URL(page.url()).searchParams.get('brandId')).toBe(brandB.id);
          await expect(page.getByTestId('global-brand-switcher')).toContainText(brandB.name);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T5-UI-06 Edge-state viewport overflow (1440x900 & 1280x800) with 70-char brand name & 120-char published URL across all workspaces & admin',
      { tag: ['@tier5', '@F4', '@F9', '@F12', '@F17'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't5ui06');
        const tenant = await provisionIsolatedTenant({
          prefix: 't5ui06',
          billingMode: 'SHADOW',
          initialPoints: 100,
        });
        const longName = `超长品牌名极限压力测试验证专用企业级存储解决方案旗舰系列${tag}`.slice(
          0,
          70,
        );
        const payload = buildCnBrandPayload(tag);
        payload.name = longName;
        const brand = await createBrandApi(tenant.session, payload);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't5ui06_art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 长标题极限布局检查`,
          },
        });
        expect(sse.status).toBe(200);
        const articleId = sse.complete!.article.id;
        const longUrl = `https://long-subdomain-${tag}.example.com/articles/2026/ultra-deep-benchmark-review-segment-alpha-beta-gamma-delta-epsilon-zeta-001`;
        expect(longUrl.length).toBeGreaterThanOrEqual(120);
        unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${articleId}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: { publishedUrl: longUrl, channel: '官网博客' },
          }),
          'register long publish URL',
        );

        const merchantUi = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/home?brandId=${brand.id}&market=CN`,
        );
        try {
          await expect(merchantUi.page.getByTestId('home-health-strip')).toBeVisible({
            timeout: 15_000,
          });
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });

          await merchantUi.page.goto(`/brands?brandId=${brand.id}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(merchantUi.page.getByTestId('fact-slot-PRODUCT_SPECS')).toBeVisible({
            timeout: 15_000,
          });
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });

          await merchantUi.page.goto(`/visibility?brandId=${brand.id}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(merchantUi.page.getByTestId('visibility-tab-overview')).toBeVisible({
            timeout: 15_000,
          });
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });
          await merchantUi.page.getByTestId('visibility-tab-runs').click();
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });
          await merchantUi.page.getByTestId('visibility-tab-citations').click();
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });

          await merchantUi.page.goto(
            `/studio?brandId=${brand.id}&market=CN&articleId=${articleId}`,
            { waitUntil: 'domcontentloaded' },
          );
          await expect(merchantUi.page.getByTestId('studio-workspace')).toBeVisible({
            timeout: 15_000,
          });
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });

          await merchantUi.page.goto('/account', { waitUntil: 'domcontentloaded' });
          await expect(merchantUi.page.getByRole('tab', { name: '点数明细' })).toBeVisible({
            timeout: 15_000,
          });
          await assertNoHorizontalOverflow(merchantUi.page, { viewports: REQUIRED_VIEWPORTS });
          assertNoConsoleOrPageErrors(merchantUi.errors);
        } finally {
          await merchantUi.context.close();
        }

        const adminSession = await getAdminSession();
        const adminUi = await openAuthenticatedPage(browser, adminSession, '/admin/tenants');
        try {
          await expect(adminUi.page.locator('table').first()).toBeVisible({ timeout: 15_000 });
          await assertNoHorizontalOverflow(adminUi.page, { viewports: REQUIRED_VIEWPORTS });
          assertNoConsoleOrPageErrors(adminUi.errors);
        } finally {
          await adminUi.context.close();
        }
      },
    );
  },
);
