import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  deleteBrandMediaApi,
  extractItems,
  getTenantWallet,
  listBrandMediaApi,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  uploadBrandPhotoApi,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForVisibilityRunApi,
  type BrandMediaAssetDto,
  type GeoArticleDto,
  type GeoBriefDto,
  type GeoPublishRecordDto,
  type VisibilityRunDto,
} from './support/api-client';
import { assertNoConsoleOrPageErrors } from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  buildTestPngBuffer,
  E2E_SENTINELS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import { openAuthenticatedPage } from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 4 — Product Media + Optional AI Image & Sentiment Crisis Response',
  {
    tag: ['@tier4', '@F2', '@F8', '@F9', '@F11', '@F12', '@F13', '@F15', '@F17', '@M5'],
  },
  () => {
    test(
      'S4-07 Product photo library (flat, 0 mandatory binding) + free real photo insert + optional 5-pt AI diagram (15 pts total)',
      { tag: ['@tier4', '@F2', '@F8', '@F12', '@F15', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's407');
        const tenant = await provisionIsolatedTenant({
          prefix: 's407',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const createdMediaIds: string[] = [];
        try {
          // 1. Stream pure-text article BEFORE uploading any photos (proves 0 mandatory media binding: 100 -> 90)
          const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 's407art'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${brand.name} 四盘位静音 NAS 纯文本评测`,
            },
          });
          expect(sse.status).toBe(200);
          const article = sse.complete!.article;
          expect((await getTenantWallet(tenant.session)).points).toBe(90);

          // 2. Upload 2 real PNG photos directly to flat /brands media pool (0 category nesting, 0 pts)
          const photo1 = await uploadBrandPhotoApi(tenant.session, brand.id, {
            filename: `front-${tag}.png`,
            title: `星曜智储机身正面实拍-${tag}`,
            buffer: buildTestPngBuffer(96, 64),
          });
          const photo2 = await uploadBrandPhotoApi(tenant.session, brand.id, {
            filename: `rear-${tag}.png`,
            title: `双2.5GbE背部接口实拍-${tag}`,
            buffer: buildTestPngBuffer(96, 64),
          });
          createdMediaIds.push(photo1.id, photo2.id);
          expect(photo1.origin).toBe('PRODUCT_UPLOAD');
          expect(photo2.origin).toBe('PRODUCT_UPLOAD');

          // 3. Generate optional AI inline diagram (5 pts: 90 -> 85)
          const aiDiagram = unwrapOk(
            await requestV2<BrandMediaAssetDto>(`/brands/${brand.id}/media/ai-gen`, {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's407ai') },
              body: {
                prompt: '极简四盘位静音风道散热气流方向剖面示意图',
                title: `散热风道原理图-${tag}`,
              },
            }),
            'POST /media/ai-gen (5 pts)',
          );
          createdMediaIds.push(aiDiagram.id);
          expect(aiDiagram.origin).toBe('AI_INLINE_GEN');
          expect((await getTenantWallet(tenant.session)).points).toBe(85);

          // 4. Insert both real product photo (free) & AI diagram into article
          const enrichedMd = `${article.contentMarkdown}\n\n![${photo1.title}](${photo1.url})\n\n![${aiDiagram.title}](${aiDiagram.url})`;
          const savedArticle = unwrapOk(
            await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
              method: 'PATCH',
              token: tenant.session.accessToken,
              body: {
                contentMarkdown: enrichedMd,
                usedMediaIds: [photo1.id, aiDiagram.id],
              },
            }),
            'PATCH article with real photo + AI diagram',
          );
          expect(savedArticle.contentMarkdown).toContain(photo1.url);
          expect(savedArticle.contentMarkdown).toContain(aiDiagram.url);

          // Total strict settlement: 10 (article) + 0 (real photos) + 5 (AI diagram) = 15 pts -> 85 remaining
          expect((await getTenantWallet(tenant.session)).points).toBe(85);

          const mediaList = await listBrandMediaApi(tenant.session, brand.id);
          expect(mediaList.some((m) => m.id === photo1.id && m.origin === 'PRODUCT_UPLOAD')).toBe(
            true,
          );
          expect(mediaList.some((m) => m.id === aiDiagram.id && m.origin === 'AI_INLINE_GEN')).toBe(
            true,
          );

          // Verify /brands flat product photo zone renders both without nested category hierarchy
          const { context, page, errors } = await openAuthenticatedPage(
            browser,
            tenant.session,
            `/brands?brandId=${brand.id}&market=CN`,
          );
          try {
            await expect(page.getByTestId('brand-media-dropzone')).toBeVisible();
            await expect(page.locator('body')).toContainText(photo1.title);
            await expect(page.locator('body')).toContainText(aiDiagram.title);
            assertNoConsoleOrPageErrors(errors);
          } finally {
            await context.close();
          }
        } finally {
          for (const mediaId of createdMediaIds) {
            await deleteBrandMediaApi(tenant.session, brand.id, mediaId).catch(() => undefined);
          }
        }
      },
    );

    test(
      'S4-08 Negative sentiment crisis response in CN Community Q&A (知乎) and GLOBAL Community Discussion (Reddit) with retest verification',
      { tag: ['@tier4', '@F9', '@F11', '@F12', '@F13', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 's408');
        const tenant = await provisionIsolatedTenant({ prefix: 's408', initialPoints: 250 });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        // --- Part 1: CN Crisis (OBJECTION_FAQ + CN_COMMUNITY_QA -> publish 知乎 -> RETEST) ---
        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const cnRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'CN',
            prompts: [`${brand.name} 噪音大吗 售后口碑怎么样 ${tag} ${E2E_SENTINELS.NEGATIVE}`],
            engines: onlineCn.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 's408cnr'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, cnRun.id);
        const cnBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', cnRun.id);
        const cnCrisisBrief: GeoBriefDto =
          cnBriefs.find((b) => b.sourceType === 'SENTIMENT_RISK') ?? cnBriefs[0];
        expect(cnCrisisBrief).toBeTruthy();
        expect(cnCrisisBrief.sourceType).toBe('SENTIMENT_RISK');
        expect(cnCrisisBrief.priorityScore).toBeGreaterThanOrEqual(80);

        const cnSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's408cna'),
          body: {
            market: 'CN',
            briefId: cnCrisisBrief.id,
            recipe: 'OBJECTION_FAQ',
            targetFormat: 'CN_COMMUNITY_QA',
            targetPrompt: cnCrisisBrief.targetPrompt,
          },
        });
        expect(cnSse.status).toBe(200);
        const cnArticle = cnSse.complete!.article;
        expect(cnArticle.recipe).toBe('OBJECTION_FAQ');
        expect(cnArticle.targetFormat).toBe('CN_COMMUNITY_QA');

        const cnPub = unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${cnArticle.id}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://zhuanlan.zhihu.example/p/crisis-${tag}`,
              channel: '知乎',
            },
          }),
          'CN publish record',
        );
        const cnRetestRes = unwrapOk(
          await requestV2<{ run?: VisibilityRunDto; id?: string }>(
            `/publish-records/${cnPub.id}/retest`,
            {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's408cnret') },
              body: { engines: onlineCn.slice(0, 2).map((e) => e.key) },
            },
          ),
          'CN retest',
        );
        const cnRetestId = cnRetestRes.run?.id ?? cnRetestRes.id;
        expect(cnRetestId).toBeTruthy();
        await waitForVisibilityRunApi(tenant.session, brand.id, cnRetestId!);

        const cnPubAfter = await pollUntil(
          async () => {
            const list = unwrapOk(
              await requestV2<{ items?: GeoPublishRecordDto[] } | GeoPublishRecordDto[]>(
                `/articles/${cnArticle.id}/publish-records`,
                { token: tenant.session.accessToken },
              ),
              'GET CN publish records',
            );
            return extractItems(list).find((r) => r.id === cnPub.id) ?? null;
          },
          (r) => r !== null && r.afterMetrics !== null,
          { timeoutMs: 20_000, label: 'CN crisis retest afterMetrics' },
        );
        expect(cnPubAfter?.afterMetrics).not.toBeNull();

        // --- Part 2: GLOBAL Crisis (OBJECTION_FAQ + GLOBAL_COMMUNITY_DISCUSSION -> publish Reddit -> RETEST) ---
        const onlineGl = (await listMarketEnginesApi(tenant.session, brand.id, 'GLOBAL')).filter(
          (e) => e.available || e.status === 'online',
        );
        const glRun = await createVisibilityRunApi(
          tenant.session,
          brand.id,
          {
            market: 'GLOBAL',
            prompts: [
              `Is AstraVault noisy or unreliable in real home labs ${tag} ${E2E_SENTINELS.NEGATIVE}`,
            ],
            engines: onlineGl.slice(0, 2).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 's408glr'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, glRun.id);
        const glBriefs = await waitForAutoBriefsApi(tenant.session, brand.id, 'GLOBAL', glRun.id);
        const glCrisisBrief: GeoBriefDto =
          glBriefs.find((b) => b.sourceType === 'SENTIMENT_RISK') ?? glBriefs[0];
        expect(glCrisisBrief).toBeTruthy();
        expect(glCrisisBrief.sourceType).toBe('SENTIMENT_RISK');

        const glSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's408gla'),
          body: {
            market: 'GLOBAL',
            briefId: glCrisisBrief.id,
            recipe: 'OBJECTION_FAQ',
            targetFormat: 'GLOBAL_COMMUNITY_DISCUSSION',
            targetPrompt: glCrisisBrief.targetPrompt,
          },
        });
        expect(glSse.status).toBe(200);
        const glArticle = glSse.complete!.article;
        expect(glArticle.recipe).toBe('OBJECTION_FAQ');
        expect(glArticle.targetFormat).toBe('GLOBAL_COMMUNITY_DISCUSSION');
        expect((glArticle.contentMarkdown.match(/\b[A-Za-z]{4,}\b/g) ?? []).length).toBeGreaterThan(
          20,
        );

        const glPub = unwrapOk(
          await requestV2<GeoPublishRecordDto>(`/articles/${glArticle.id}/publish-records`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              publishedUrl: `https://reddit.example/r/homelab/comments/crisis_${tag}`,
              channel: 'Reddit',
            },
          }),
          'GLOBAL publish record',
        );
        const glRetestRes = unwrapOk(
          await requestV2<{ run?: VisibilityRunDto; id?: string }>(
            `/publish-records/${glPub.id}/retest`,
            {
              method: 'POST',
              token: tenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's408glret') },
              body: { engines: onlineGl.slice(0, 2).map((e) => e.key) },
            },
          ),
          'GLOBAL retest',
        );
        const glRetestId = glRetestRes.run?.id ?? glRetestRes.id;
        expect(glRetestId).toBeTruthy();
        await waitForVisibilityRunApi(tenant.session, brand.id, glRetestId!);

        const glPubAfter = await pollUntil(
          async () => {
            const list = unwrapOk(
              await requestV2<{ items?: GeoPublishRecordDto[] } | GeoPublishRecordDto[]>(
                `/articles/${glArticle.id}/publish-records`,
                { token: tenant.session.accessToken },
              ),
              'GET GLOBAL publish records',
            );
            return extractItems(list).find((r) => r.id === glPub.id) ?? null;
          },
          (r) => r !== null && r.afterMetrics !== null,
          { timeoutMs: 20_000, label: 'GLOBAL crisis retest afterMetrics' },
        );
        expect(glPubAfter?.afterMetrics).not.toBeNull();
      },
    );
  },
);
