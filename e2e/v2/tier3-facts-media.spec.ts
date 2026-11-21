import {
  consumeSsePost,
  createBrandApi,
  deleteBrandMediaApi,
  getTenantWallet,
  listBrandFactsApi,
  listBrandMediaApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  uploadBrandPhotoApi,
  upsertBrandFactsApi,
  waitForBatchJobApi,
  type BrandMediaAssetDto,
  type GeoArticleDto,
  type GeoBatchJobDto,
  type GeoBriefDto,
  type GeoEvaluationDto,
  type PromptPreferenceDto,
} from './support/api-client';
import { assertGeoScoreValid, assertNoConsoleOrPageErrors } from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  buildLongExtraDocFact,
  buildTestPngBuffer,
  E2E_SENTINELS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import { openAuthenticatedPage } from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 3 — Facts, Media, Preferences & Long-Doc Retrieval',
  {
    tag: ['@tier3', '@F2', '@F5', '@F7', '@F8', '@F12', '@F13', '@F14', '@F15', '@F16', '@M4'],
  },
  () => {
    test(
      'T3-06 Chinese BrandFact cards auto-inject cross-lingually into native English GLOBAL draft',
      { tag: ['@tier3', '@F7', '@F12', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't306');
        const tenant = await provisionIsolatedTenant({ prefix: 't306', initialPoints: 100 });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        const globalMarket = brand.markets.find((m) => m.market === 'GLOBAL');
        expect(globalMarket).toBeTruthy();

        // Upsert strictly Chinese facts (zero manual English translation)
        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: '星曜核心硬件规格',
            content: '四盘位航空铝合金机身，48TB 最大容量，18.5dB 静音风道，双 2.5GbE 网口。',
            sourceType: 'MANUAL',
          },
          {
            slot: 'DIFFERENTIATORS',
            title: '差异化优势',
            content: '免工具快拆盘位，满载功耗仅 42W，支持 Docker 一键部署。',
            sourceType: 'MANUAL',
          },
        ]);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't306gl'),
          body: {
            market: 'GLOBAL',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt: 'Best 4-bay quiet NAS for home studio 2026',
          },
        });
        expect(sse.status).toBe(200);
        expect(sse.meta?.market).toBe('GLOBAL');
        expect(sse.meta?.matchedFactIds.length).toBeGreaterThan(0);

        const md = sse.complete?.article.contentMarkdown ?? sse.deltas.join('');
        const englishWords = md.match(/\b[A-Za-z]{4,}\b/g) ?? [];
        expect(englishWords.length, 'Expected native English body prose').toBeGreaterThan(25);
        expect(
          md.includes(globalMarket!.localBrandName) ||
            md.includes('AstraVault') ||
            md.includes('AV-4800'),
          'Expected GLOBAL brand name or alias preserved in English draft',
        ).toBe(true);
        expect(
          md.includes('48TB') || md.includes('18.5') || md.includes('2.5GbE') || md.includes('42W'),
          'Expected numeric anchors from Chinese BrandFact cards to transfer cross-lingually',
        ).toBe(true);
      },
    );

    test(
      'T3-07 Missing-fact [待补充：...] inline writeback persists BrandFact (STUDIO_FEEDBACK) and lifts GEO score',
      { tag: ['@tier3', '@F7', '@F14', '@F16', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't307');
        const tenant = await provisionIsolatedTenant({ prefix: 't307', initialPoints: 100 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        // Intentionally sparse single-line fact so missing-fact slot triggers
        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: '基础规格',
            content: '四盘位桌面级 NAS 存储设备。',
            sourceType: 'MANUAL',
          },
        ]);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't307sse'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 待机功耗与静音实测对比 ${E2E_SENTINELS.MISSING_FACT}`,
          },
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;
        expect(article.contentMarkdown).toContain('[待补充：');
        const baselineScore = article.geoScore;

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand.id}&market=CN&articleId=${article.id}`,
        );
        try {
          const pill = page.getByTestId('missing-fact-pill').first();
          await expect(pill).toBeVisible({ timeout: 15_000 });
          await pill.click();

          const backfillText = '待机功耗实测 11.2W，整机 3 年质保';
          const popoverOrModal = page
            .locator('.ant-popover:visible, .ant-modal-content:visible, [role="dialog"]:visible')
            .last();
          await expect(popoverOrModal).toBeVisible();
          await popoverOrModal.locator('input, textarea').first().fill(backfillText);

          const syncCheckbox = popoverOrModal.getByRole('checkbox', {
            name: /同步存入品牌事实卡/,
          });
          if ((await syncCheckbox.count()) > 0 && !(await syncCheckbox.isChecked())) {
            await syncCheckbox.check();
          }

          await popoverOrModal
            .getByRole('button', { name: /确认|填入|保存/ })
            .first()
            .click();

          await pollUntil(
            async () => {
              const updated = unwrapOk(
                await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
                  token: tenant.session.accessToken,
                }),
                'GET updated article after missing-fact backfill',
              );
              return updated;
            },
            (a) => a.contentMarkdown.includes('11.2W') && !a.contentMarkdown.includes('[待补充：'),
            { timeoutMs: 15_000, label: 'missing-fact backfill write' },
          );

          const facts = await listBrandFactsApi(tenant.session, brand.id);
          const matchingFact = facts.find(
            (f) => f.content.includes('11.2W') || f.sourceType === 'STUDIO_FEEDBACK',
          );
          expect(matchingFact, 'Backfilled fact must persist into BrandFact').toBeTruthy();

          const reEval = unwrapOk(
            await requestV2<GeoEvaluationDto>(`/articles/${article.id}/evaluate-geo`, {
              method: 'POST',
              token: tenant.session.accessToken,
            }),
            'POST evaluate-geo after backfill',
          );
          assertGeoScoreValid(reEval.geoScore, reEval.geoScoreDetail);
          expect(reEval.geoScore).toBeGreaterThan(baselineScore);
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T3-08 Shared product photo free insert increments usedCount with zero extra points',
      { tag: ['@tier3', '@F2', '@F8', '@F15', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't308');
        const tenant = await provisionIsolatedTenant({
          prefix: 't308',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
        const photoTitle = `AV-4800 前面板实拍 ${tag}`;
        let uploadedId: string | null = null;

        try {
          const uploaded = await uploadBrandPhotoApi(tenant.session, brand.id, {
            filename: `av4800-${tag}.png`,
            title: photoTitle,
            buffer: buildTestPngBuffer(96, 64),
          });
          uploadedId = uploaded.id;
          expect(uploaded.origin).toBe('PRODUCT_UPLOAD');
          expect(uploaded.usedCount).toBe(0);

          // Shared across CN and GLOBAL
          const mediaList = await listBrandMediaApi(tenant.session, brand.id);
          expect(mediaList.some((m) => m.id === uploaded.id)).toBe(true);

          // Stream 1 article: 100 -> 90 pts
          const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
            token: tenant.session.accessToken,
            idempotencyKey: uniqueIdempotencyKey(testInfo, 't308art'),
            body: {
              market: 'CN',
              recipe: 'AUTHORITY_GUIDE',
              targetFormat: 'CN_DEEP_REVIEW',
              targetPrompt: `${brand.name} 四盘位结构拆解与实测`,
            },
          });
          expect(sse.status).toBe(200);
          const article = sse.complete!.article;
          const walletAfterWrite = await getTenantWallet(tenant.session);
          expect(walletAfterWrite.points).toBe(90);

          const { context, page, errors } = await openAuthenticatedPage(
            browser,
            tenant.session,
            `/studio?brandId=${brand.id}&market=CN&articleId=${article.id}`,
          );
          try {
            const insertImgBtn = page
              .getByRole('button', { name: /插入图片|配图/ })
              .or(page.getByTestId('studio-insert-media-btn'))
              .first();
            await expect(insertImgBtn).toBeVisible();
            await insertImgBtn.click();

            const popover = page
              .getByTestId('studio-media-popover')
              .or(page.locator('.ant-popover:visible, .ant-modal-content:visible').last());
            await expect(popover).toBeVisible();
            await expect(popover).toContainText(photoTitle);

            const photoCard = popover
              .locator('[data-testid*="media-item"], .ant-card, button, li')
              .filter({ hasText: photoTitle })
              .first();
            await photoCard.click();

            const saveBtn = page.getByRole('button', { name: /保存/ }).first();
            if ((await saveBtn.count()) > 0 && (await saveBtn.isEnabled())) {
              await saveBtn.click();
            }

            const updatedArticle = await pollUntil(
              async () =>
                unwrapOk(
                  await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
                    token: tenant.session.accessToken,
                  }),
                  'GET article after image insert',
                ),
              (a) =>
                a.contentMarkdown.includes(uploaded.url) ||
                a.contentHtml.includes(uploaded.url) ||
                a.contentMarkdown.includes(photoTitle),
              { timeoutMs: 15_000, label: 'real product photo persisted in article' },
            );
            expect(
              updatedArticle.contentMarkdown.includes(photoTitle) ||
                updatedArticle.contentHtml.includes(photoTitle),
            ).toBe(true);

            const walletAfterInsert = await getTenantWallet(tenant.session);
            expect(walletAfterInsert.points).toBe(90);

            const mediaAfter = await listBrandMediaApi(tenant.session, brand.id);
            const refreshed = mediaAfter.find((m) => m.id === uploaded.id);
            expect(refreshed?.usedCount).toBeGreaterThanOrEqual(1);
            assertNoConsoleOrPageErrors(errors);
          } finally {
            await context.close();
          }
        } finally {
          if (uploadedId) {
            await deleteBrandMediaApi(tenant.session, brand.id, uploadedId).catch(() => undefined);
          }
        }
      },
    );

    test(
      'T3-09 Optional 5-pt AI_INLINE_GEN persistence, provider-fault atomic refund & 402 guard',
      { tag: ['@tier3', '@F2', '@F15', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't309');
        const richTenant = await provisionIsolatedTenant({
          prefix: 't309a',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const poorTenant = await provisionIsolatedTenant({
          prefix: 't309b',
          billingMode: 'STRICT',
          initialPoints: 3,
        });

        const richBrand = await createBrandApi(
          richTenant.session,
          buildCnBrandPayload(`${tag}rich`),
        );
        const poorBrand = await createBrandApi(
          poorTenant.session,
          buildCnBrandPayload(`${tag}poor`),
        );

        const createdMediaIds: string[] = [];
        try {
          // 1. Successful AI inline image: 100 -> 95 pts
          const genRes = await requestV2<BrandMediaAssetDto>(
            `/brands/${richBrand.id}/media/ai-gen`,
            {
              method: 'POST',
              token: richTenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't309ok') },
              body: {
                prompt: '极简现代工业设计风格四盘位铝合金 NAS 散热风道剖面示意图',
                title: `风道结构图 ${tag}`,
              },
            },
          );
          const asset = unwrapOk(genRes, 'POST /media/ai-gen');
          createdMediaIds.push(asset.id);
          expect(asset.origin).toBe('AI_INLINE_GEN');
          expect(asset.aiPrompt).toBeTruthy();

          const afterSuccess = await getTenantWallet(richTenant.session);
          expect(afterSuccess.points).toBe(95);

          // 2. Upstream image failure -> atomic 5-pt refund (balance remains 95)
          const failRes = await requestV2<BrandMediaAssetDto>(
            `/brands/${richBrand.id}/media/ai-gen`,
            {
              method: 'POST',
              token: richTenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't309fail') },
              body: {
                prompt: `模拟上游生图故障 ${E2E_SENTINELS.IMAGE_FAIL}`,
                title: `失败测试图 ${tag}`,
              },
            },
          );
          expect(failRes.status).toBeGreaterThanOrEqual(400);
          expect(failRes.envelope.code).not.toBe(0);

          const afterFail = await getTenantWallet(richTenant.session);
          expect(afterFail.points).toBe(95);

          // 3. Insufficient balance (3 pts < 5 pts) -> 402 / 40201 & zero asset persisted
          const poorRes = await requestV2<BrandMediaAssetDto>(
            `/brands/${poorBrand.id}/media/ai-gen`,
            {
              method: 'POST',
              token: poorTenant.session.accessToken,
              headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't309poor') },
              body: {
                prompt: 'NAS 硬件结构示意图',
                title: `余额不足图 ${tag}`,
              },
            },
          );
          expect(poorRes.status).toBe(402);
          expect(poorRes.envelope.code).toBe(40201);

          const poorMedia = await listBrandMediaApi(poorTenant.session, poorBrand.id);
          expect(poorMedia).toHaveLength(0);
        } finally {
          for (const mediaId of createdMediaIds) {
            await deleteBrandMediaApi(richTenant.session, richBrand.id, mediaId).catch(
              () => undefined,
            );
          }
        }
      },
    );

    test(
      'T3-19 Collapsed PromptPreference defaults & enforcement across SSE and 2-article batch',
      { tag: ['@tier3', '@F12', '@F14', '@M4'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 't319');
        const tenant = await provisionIsolatedTenant({ prefix: 't319', initialPoints: 200 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const forbiddenWords = ['神级方案', '颠覆行业'];
        const customToneNote = '严谨工程评测口吻，禁用夸张形容词';

        const savedPref = unwrapOk(
          await requestV2<PromptPreferenceDto>('/prompt-preferences', {
            method: 'PUT',
            token: tenant.session.accessToken,
            body: {
              customToneNote,
              customForbiddenWords: forbiddenWords,
            },
          }),
          'PUT /api/v2/prompt-preferences',
        );
        expect(savedPref.customToneNote).toBe(customToneNote);
        expect(savedPref.customForbiddenWords).toEqual(expect.arrayContaining(forbiddenWords));

        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand.id}&market=CN`,
        );
        try {
          const prefsPanel = page.getByTestId('studio-advanced-prefs');
          await expect(prefsPanel).toBeVisible();
          // Must be collapsed by default (tone note not initially visible)
          await expect(prefsPanel.getByText(customToneNote)).not.toBeVisible();
          await prefsPanel.click();
          await expect(page.locator('body')).toContainText(customToneNote);
          await expect(page.locator('body')).toContainText('神级方案');
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }

        // Verify SSE respects custom forbidden words
        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't319sse'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 四盘位 NAS 工程评测`,
          },
        });
        expect(sse.status).toBe(200);
        const sseMd = sse.complete!.article.contentMarkdown;
        for (const word of forbiddenWords) {
          expect(sseMd).not.toContain(word);
        }

        // Create 2 manual briefs & verify 2-article batch also respects custom forbidden words
        const b1 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} 静音实测专题 ${tag}-1`,
            },
          }),
          'create brief 1',
        );
        const b2 = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `${brand.name} RAID 性能评测专题 ${tag}-2`,
            },
          }),
          'create brief 2',
        );

        const job = unwrapOk(
          await requestV2<GeoBatchJobDto>(`/brands/${brand.id}/articles/batch`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 't319batch') },
            body: {
              market: 'CN',
              briefIds: [b1.id, b2.id],
            },
          }),
          'POST /articles/batch',
        );
        const doneJob = await waitForBatchJobApi(tenant.session, brand.id, job.id);
        expect(doneJob.doneCount).toBe(2);
        expect(doneJob.failCount).toBe(0);

        const articlesRes = unwrapOk(
          await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
            `/brands/${brand.id}/articles?market=CN`,
            { token: tenant.session.accessToken },
          ),
          'GET articles after batch',
        );
        const batchArticles = (
          Array.isArray(articlesRes) ? articlesRes : (articlesRes.items ?? [])
        ).filter((a) => a.batchJobId === job.id);
        expect(batchArticles).toHaveLength(2);
        for (const art of batchArticles) {
          for (const word of forbiddenWords) {
            expect(art.contentMarkdown).not.toContain(word);
          }
        }
      },
    );

    test(
      'T3-20 >6,000-char EXTRA_DOC async pgvector indexing transitions to READY and feeds Studio retrieval',
      { tag: ['@tier3', '@F7', '@F12', '@F16', '@M4'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 't320');
        const anchorToken = `MTBF-98400小时-${tag}`;
        const tenant = await provisionIsolatedTenant({ prefix: 't320', initialPoints: 100 });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        const startedAt = Date.now();
        const savedFacts = await upsertBrandFactsApi(tenant.session, brand.id, [
          ...buildFourBrandFacts(brand.name),
          buildLongExtraDocFact(anchorToken, 6600),
        ]);
        const saveDurationMs = Date.now() - startedAt;
        expect(
          saveDurationMs,
          'PUT /facts must return promptly without blocking on indexing',
        ).toBeLessThan(5000);

        const extraDoc = savedFacts.find((f) => f.slot === 'EXTRA_DOC');
        expect(extraDoc).toBeTruthy();

        const readyFact = await pollUntil(
          async () => {
            const facts = await listBrandFactsApi(tenant.session, brand.id);
            return facts.find((f) => f.slot === 'EXTRA_DOC') ?? null;
          },
          (f) => f !== null && f.indexStatus === 'READY',
          { timeoutMs: 30_000, intervalMs: 500, label: 'EXTRA_DOC pgvector READY' },
        );
        expect(readyFact?.indexStatus).toBe('READY');

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 't320sse'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} ${anchorToken} 长期连续读写可靠性测试报告`,
          },
        });
        expect(sse.status).toBe(200);
        expect(sse.meta?.matchedFactIds).toContain(readyFact!.id);
        expect(sse.complete?.geoScoreDetail.dimensions.factDensity.score).toBeGreaterThan(0);
      },
    );
  },
);
