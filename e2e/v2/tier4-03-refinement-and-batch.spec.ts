import {
  consumeSsePost,
  createBrandApi,
  extractItems,
  getTenantWallet,
  listBrandFactsApi,
  listBriefsApi,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
  waitForBatchJobApi,
  type GeoArticleDto,
  type GeoBatchJobDto,
  type GeoBriefDto,
  type GeoEvaluationDto,
} from './support/api-client';
import {
  assertGeoScoreValid,
  assertNoConsoleOrPageErrors,
  assertValidJsonLd,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildFourBrandFacts,
  E2E_SENTINELS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import { openAuthenticatedPage } from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 4 — Studio Refinement Score Lift & 2–20 Lightweight Batch',
  {
    tag: ['@tier4', '@F2', '@F7', '@F11', '@F12', '@F14', '@F16', '@M5'],
  },
  () => {
    test(
      'S4-05 Missing-fact backfill + Fan-Out supplement + inline DE_AD rewrite lift GEO score with 0 extra points',
      { tag: ['@tier4', '@F2', '@F7', '@F14', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 's405');
        const tenant = await provisionIsolatedTenant({
          prefix: 's405',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

        // Sparse single fact so initial draft triggers missing-fact capsule and lower fact density
        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: '基础规格',
            content: `${brand.name} 四盘位家用 NAS 存储。`,
            sourceType: 'MANUAL',
          },
        ]);

        const fanOutTerms = ['待机功耗实测', '四盘位静音噪声', 'Docker影音转码'];
        const brief = unwrapOk(
          await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
            method: 'POST',
            token: tenant.session.accessToken,
            body: {
              market: 'CN',
              sourceType: 'FANOUT_CLUSTER',
              fanOutQueries: fanOutTerms,
              customPrompt: `${brand.name} 家用静音 NAS 深度实测 ${E2E_SENTINELS.MISSING_FACT}`,
            },
          }),
          'create FANOUT_CLUSTER brief',
        );

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's405sse'),
          body: {
            market: 'CN',
            briefId: brief.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brief.targetPrompt} ${E2E_SENTINELS.MISSING_FACT}`,
          },
        });
        expect(sse.status).toBe(200);
        const article = sse.complete!.article;
        expect(article.contentMarkdown).toContain('[待补充：');

        const walletAfterWrite = await getTenantWallet(tenant.session);
        expect(walletAfterWrite.points).toBe(90);

        const baseEval = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${article.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          'baseline evaluate-geo',
        );
        assertGeoScoreValid(baseEval.geoScore, baseEval.geoScoreDetail);

        // 1. Backfill missing fact & write back to BrandFact (STUDIO_FEEDBACK)
        const backfilledFactValue = '实测待机功耗 11.2W、满载 42W、1 米静音 18.5dB，提供 3 年质保';
        await upsertBrandFactsApi(tenant.session, brand.id, [
          {
            slot: 'PRODUCT_SPECS',
            title: '基础规格与补填实测',
            content: `${brand.name} 四盘位家用 NAS：${backfilledFactValue}，双 2.5GbE 网口，96TB 扩展。`,
            sourceType: 'STUDIO_FEEDBACK',
          },
        ]);

        // 2. Inline rewrite DE_AD (0 pts)
        const rewriteRes = unwrapOk(
          await requestV2<{ rewrittenText?: string; text?: string }>(
            `/articles/${article.id}/rewrite-section`,
            {
              method: 'POST',
              token: tenant.session.accessToken,
              body: {
                action: 'DE_AD',
                selectedText: article.contentMarkdown.slice(0, 220),
              },
            },
          ),
          'POST /rewrite-section DE_AD',
        );
        const rewrittenSnippet = (rewriteRes.rewrittenText ?? rewriteRes.text ?? '').trim();
        expect(rewrittenSnippet.length).toBeGreaterThan(10);

        // 3. Apply backfill + Fan-Out supplement + rewritten intro to article Markdown
        const cleanedMd = article.contentMarkdown.replace(
          /\[待补充：[^\]]*\]/g,
          backfilledFactValue,
        );
        const missingFanOuts =
          baseEval.geoScoreDetail.missingFanOuts.length > 0
            ? baseEval.geoScoreDetail.missingFanOuts
            : fanOutTerms;
        const fanOutSupplement = missingFanOuts
          .map(
            (term) =>
              `\n\n## ${term}实测分析\n围绕「${term}」，${brand.name} 在 24℃ 实验室测得 ${backfilledFactValue}，并支持 4K 硬件转码与双 2.5GbE 聚合读写 540MB/s。`,
          )
          .join('');
        const upgradedMd = `${rewrittenSnippet}\n\n${cleanedMd}${fanOutSupplement}`;

        unwrapOk(
          await requestV2<GeoArticleDto>(`/articles/${article.id}`, {
            method: 'PATCH',
            token: tenant.session.accessToken,
            body: { contentMarkdown: upgradedMd },
          }),
          'PATCH upgraded article',
        );

        const afterEval = unwrapOk(
          await requestV2<GeoEvaluationDto>(`/articles/${article.id}/evaluate-geo`, {
            method: 'POST',
            token: tenant.session.accessToken,
          }),
          're-evaluate after refinement',
        );
        assertGeoScoreValid(afterEval.geoScore, afterEval.geoScoreDetail);
        expect(afterEval.geoScore).toBeGreaterThan(baseEval.geoScore);
        expect(afterEval.geoScoreDetail.coveredFanOuts.length).toBeGreaterThanOrEqual(
          baseEval.geoScoreDetail.coveredFanOuts.length,
        );

        const factsAfter = await listBrandFactsApi(tenant.session, brand.id);
        expect(
          factsAfter.some((f) => f.sourceType === 'STUDIO_FEEDBACK' && f.content.includes('11.2W')),
        ).toBe(true);

        // Zero extra points deducted for backfill, rewrite, and re-evaluation
        const walletAfterRefinement = await getTenantWallet(tenant.session);
        expect(walletAfterRefinement.points).toBe(90);
      },
    );

    test(
      'S4-06 Lightweight 2–20 gap batch queue: rejects <2 and >20, settles 3/3 (30 pts), zero legacy columns',
      { tag: ['@tier4', '@F2', '@F11', '@F14', '@F16', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's406');
        const tenant = await provisionIsolatedTenant({
          prefix: 's406',
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        const briefs: GeoBriefDto[] = [];
        for (let i = 1; i <= 3; i += 1) {
          briefs.push(
            unwrapOk(
              await requestV2<GeoBriefDto>(`/brands/${brand.id}/briefs/generate`, {
                method: 'POST',
                token: tenant.session.accessToken,
                body: {
                  market: 'CN',
                  sourceType: 'MANUAL',
                  customPrompt: `${brand.name} 缺口批量攻坚专题 ${i} ${tag}`,
                },
              }),
              `create brief ${i}`,
            ),
          );
        }

        // Reject < 2 briefs (400)
        const tooFewRes = await requestV2(`/brands/${brand.id}/articles/batch`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's406few') },
          body: { market: 'CN', briefIds: [briefs[0].id] },
        });
        expect(tooFewRes.status).toBe(400);

        // Reject > 20 briefs (400)
        const tooManyIds = Array.from({ length: 21 }, (_, idx) => `fake-brief-${idx}`);
        const tooManyRes = await requestV2(`/brands/${brand.id}/articles/batch`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's406many') },
          body: { market: 'CN', briefIds: tooManyIds },
        });
        expect(tooManyRes.status).toBe(400);

        // Launch valid 3-brief batch job
        const job = unwrapOk(
          await requestV2<GeoBatchJobDto>(`/brands/${brand.id}/articles/batch`, {
            method: 'POST',
            token: tenant.session.accessToken,
            headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's406ok') },
            body: { market: 'CN', briefIds: briefs.map((b) => b.id) },
          }),
          'POST /articles/batch (3 briefs)',
        );
        const done = await waitForBatchJobApi(tenant.session, brand.id, job.id);
        expect(done.status).toBe('COMPLETED');
        expect(done.total).toBe(3);
        expect(done.doneCount).toBe(3);
        expect(done.failCount).toBe(0);

        const articlesRes = unwrapOk(
          await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
            `/brands/${brand.id}/articles?market=CN`,
            { token: tenant.session.accessToken },
          ),
          'GET articles after batch',
        );
        const batchArticles = extractItems(articlesRes).filter((a) => a.batchJobId === job.id);
        expect(batchArticles).toHaveLength(3);
        for (const art of batchArticles) {
          expect(art.geoScore).toBeGreaterThan(0);
          assertValidJsonLd(art.schemaJsonLd, ['Article']);
        }

        const briefsAfter = await listBriefsApi(tenant.session, brand.id, 'CN');
        for (const b of briefs) {
          expect(briefsAfter.find((x) => x.id === b.id)?.status).toBe('DONE');
        }

        // Exact 30-pt settlement: 100 -> 70
        const wallet = await getTenantWallet(tenant.session);
        expect(wallet.points).toBe(70);

        // Verify /studio history displays batch articles with ZERO legacy 发送次数 / 转视频次数 columns
        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/studio?brandId=${brand.id}&market=CN`,
        );
        try {
          await expect(page.locator('body')).toContainText(batchArticles[0].title, {
            timeout: 15_000,
          });
          const studioText = await page.locator('body').innerText();
          expect(studioText).not.toContain('发送次数');
          expect(studioText).not.toContain('转视频次数');
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }
      },
    );
  },
);
