import { expect, test, v2Describe } from './support/v2-test';
import {
  apiRawFetch,
  apiRequest,
  createBrand,
  extractItems,
  getWallet,
  pollUntil,
  pollVisibilityRunDone,
  provisionTenant,
  saveBrandFacts,
  streamArticle,
  type ActionHomeData,
  type GeoArticleData,
  type GeoBriefData,
  type GeoEvaluationData,
  type GeoPublishRecordData,
  type VisibilityEngineOption,
  type VisibilityRunData,
} from './support/api-client';
import {
  assertGeoScoreInvariants,
  assertNoHorizontalOverflow,
  assertValidDocxWithTable,
  assertValidJsonLd,
  assertValidLlmsTxt,
  VIEWPORT_COMPACT,
  VIEWPORT_DESKTOP,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFactsPayload,
  E2E_SENTINELS,
  uniqueIdemKey,
  uniqueTag,
} from './support/fixtures';
import { createAuthenticatedContext, waitForBriefDrawer } from './support/ui-actions';

// ============================================================================
// Spec 06 — M5 Delivery Pack, Retest Loop & Action Home: F16–F17
// (10 Tier 1 + 10 Tier 2 = 20 tests)
// ============================================================================

async function getOnlineEngines(
  token: string,
  brandId: string,
  market: 'CN' | 'GLOBAL',
): Promise<string[]> {
  const res = await apiRequest<{ items?: VisibilityEngineOption[] }>(
    'v2',
    'GET',
    `/brands/${brandId}/visibility/engines?market=${market}`,
    { token },
  );
  const items = extractItems(res.body?.data);
  const online = items
    .filter((e) => e.available !== false && e.status !== 'offline')
    .map((e) => e.key);
  return (online.length > 0 ? online : items.map((e) => e.key)).slice(0, 1);
}

v2Describe(
  'F16: Dual-Track GEO 0-100 Evaluator & Ready-to-Publish Export Pack',
  { tag: ['@F16', '@M5'] },
  () => {
    test(
      'T1-F16-01 Real-time GEO 0-100 Evaluator computes all 5 weighted dimensions accurately at 0 points',
      { tag: ['@tier1', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16t1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '2026 四盘位家用静音 NAS 选购评测',
          })
        ).complete!.article.id;
        const ptsAfterStream = (await getWallet(tenant.accessToken)).body!.data.points;
        expect(ptsAfterStream).toBe(90);

        const evalRes = await apiRequest<GeoEvaluationData>(
          'v2',
          'POST',
          `/articles/${articleId}/evaluate-geo`,
          { token: tenant.accessToken },
        );
        expect(evalRes.status).toBe(200);
        expect(evalRes.body?.code).toBe(0);
        assertGeoScoreInvariants(evalRes.body!.data);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(90);
      },
    );

    test(
      'T1-F16-02 Export Pack downloads valid Markdown, HTML with <table>, and OOXML .docx with <w:tbl>',
      { tag: ['@tier1', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const article = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'COMPARISON_MATRIX',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '2026 四盘位 NAS 参数横向对照表',
          })
        ).complete!.article;

        const md = await apiRawFetch('v2', 'GET', `/articles/${article.id}/export?format=md`, {
          token: tenant.accessToken,
        });
        expect(md.status).toBe(200);
        expect(md.headers['content-type'] ?? '').toContain('text/markdown');
        expect(md.buffer.toString('utf8')).toMatch(/\|[^\n]+\|/);

        const html = await apiRawFetch('v2', 'GET', `/articles/${article.id}/export?format=html`, {
          token: tenant.accessToken,
        });
        expect(html.status).toBe(200);
        expect(html.headers['content-type'] ?? '').toContain('text/html');
        expect(html.buffer.toString('utf8')).toContain('<table');

        const docx = await apiRawFetch('v2', 'GET', `/articles/${article.id}/export?format=docx`, {
          token: tenant.accessToken,
        });
        expect(docx.status).toBe(200);
        expect(docx.headers['content-type'] ?? '').toContain(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        assertValidDocxWithTable(docx.buffer);
      },
    );

    test(
      'T1-F16-03 GLOBAL delivery pack generates valid JSON-LD, llms.txt snippet, and GPTBot/PerplexityBot checklist',
      { tag: ['@tier1', '@F16', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16t3');
        const tenant = await provisionTenant({ tag });
        const brand = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data;
        await saveBrandFacts(
          tenant.accessToken,
          brand.id,
          buildFourBrandFactsPayload(tag, { truthAgreed: true, includeGlobalSpecs: true }),
        );

        const articleId = (
          await streamArticle(tenant.accessToken, brand.id, {
            market: 'GLOBAL',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            targetPrompt: 'Best quiet 4-bay NAS with dual 2.5GbE for home lab 2026',
          })
        ).complete!.article.id;

        const evalRes = await apiRequest<GeoEvaluationData>(
          'v2',
          'POST',
          `/articles/${articleId}/evaluate-geo`,
          { token: tenant.accessToken },
        );
        expect(evalRes.status).toBe(200);
        const data = evalRes.body!.data;
        assertValidJsonLd(data.schemaJsonLd, ['Article', 'FAQPage', 'Product']);
        assertValidLlmsTxt(data.llmsTxtSnippet, 'AstraVault');
        const bots = data.crawlerChecklist.map((c) => c.bot);
        expect(bots).toContain('GPTBot');
        expect(bots).toContain('PerplexityBot');

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(
            `/publish?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}&tab=delivery`,
            {
              waitUntil: 'domcontentloaded',
            },
          );
          await expect(
            page
              .getByTestId('delivery-copy-jsonld')
              .or(page.getByText(/JSON-LD/))
              .first(),
          ).toBeVisible();
          await expect(
            page
              .getByTestId('delivery-copy-llmstxt')
              .or(page.getByText(/llms\.txt/))
              .first(),
          ).toBeVisible();
          await expect(page.locator('body')).toContainText('GPTBot');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F16-04 CN delivery pack emphasizes domestic channels and folds JSON-LD optionally',
      { tag: ['@tier1', '@F16', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16t4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '国内渠道投放建议展示测试',
          })
        ).complete!.article.id;

        const evalRes = await apiRequest<GeoEvaluationData>(
          'v2',
          'POST',
          `/articles/${articleId}/evaluate-geo`,
          { token: tenant.accessToken },
        );
        expect(evalRes.status).toBe(200);
        const channelsText = evalRes.body!.data.recommendedChannels.map((c) => c.channel).join(' ');
        expect(channelsText).toMatch(/知乎|头条|值得买|公众号|小红书/);
        assertValidJsonLd(evalRes.body!.data.schemaJsonLd, ['Article', 'FAQPage']);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(
            `/publish?brandId=${brandId}&market=CN&articleId=${articleId}&tab=delivery`,
            {
              waitUntil: 'domcontentloaded',
            },
          );
          await expect(page.locator('body')).toContainText(/知乎|头条|什么值得买|公众号|小红书/);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F16-05 Uncovered Fan-Out term in Evaluator shows 一键补写小节 and improves fanOutCoverage score',
      { tag: ['@tier1', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const brief = (
          await apiRequest<GeoBriefData>('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'FANOUT_CLUSTER',
              fanOutQueries: ['待机功耗实测', '双2.5G链路聚合', '独有暗室声学测绘Z99'],
              customPrompt: '四盘位 NAS 覆盖率提升验证',
            },
          })
        ).body!.data;

        const article = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            briefId: brief.id,
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: brief.targetPrompt,
          })
        ).complete!.article;

        // Ensure the unique Fan-Out token is initially missing
        const strippedMd = article.contentMarkdown.replace(/独有暗室声学测绘Z99/g, '');
        await apiRequest('v2', 'PATCH', `/articles/${article.id}`, {
          token: tenant.accessToken,
          body: { contentMarkdown: strippedMd },
        });
        const beforeEval = (
          await apiRequest<GeoEvaluationData>(
            'v2',
            'POST',
            `/articles/${article.id}/evaluate-geo`,
            {
              token: tenant.accessToken,
            },
          )
        ).body!.data;
        expect(beforeEval.geoScoreDetail.missingFanOuts).toContain('独有暗室声学测绘Z99');

        const appendedMd = `${strippedMd}\n\n## 独有暗室声学测绘Z99 实测说明\n在 1 米半消声暗室条件下完成独有暗室声学测绘Z99，四盘位满载噪声 18.5dB，待机功耗实测 11.2W，支持双2.5G链路聚合 540MB/s。\n`;
        await apiRequest('v2', 'PATCH', `/articles/${article.id}`, {
          token: tenant.accessToken,
          body: { contentMarkdown: appendedMd },
        });

        const afterEval = (
          await apiRequest<GeoEvaluationData>(
            'v2',
            'POST',
            `/articles/${article.id}/evaluate-geo`,
            {
              token: tenant.accessToken,
            },
          )
        ).body!.data;
        assertGeoScoreInvariants(afterEval);
        expect(afterEval.geoScoreDetail.dimensions.fanOutCoverage.score).toBeGreaterThan(
          beforeEval.geoScoreDetail.dimensions.fanOutCoverage.score,
        );
        expect(afterEval.geoScoreDetail.coveredFanOuts).toContain('独有暗室声学测绘Z99');
      },
    );

    test(
      'T2-F16-01 Bare cliché filler draft with [待补充：功耗] scores < 50 with low structure & deAiCompliance',
      { tag: ['@tier2', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '低分区分度验证',
          })
        ).complete!.article.id;

        await apiRequest('v2', 'PATCH', `/articles/${articleId}`, {
          token: tenant.accessToken,
          body: {
            contentMarkdown:
              '在数字化浪潮下，随着科技的飞速发展，越来越多的家庭开始关注网络存储产品。总之，选对产品非常重要，具体参数见[待补充：功耗]。',
          },
        });

        const evalRes = await apiRequest<GeoEvaluationData>(
          'v2',
          'POST',
          `/articles/${articleId}/evaluate-geo`,
          { token: tenant.accessToken },
        );
        expect(evalRes.status).toBe(200);
        const data = evalRes.body!.data;
        assertGeoScoreInvariants(data);
        expect(data.geoScore).toBeLessThan(50);
        expect(data.geoScoreDetail.dimensions.structuredExtractable.score).toBeLessThanOrEqual(5);
        expect(data.geoScoreDetail.dimensions.deAiCompliance.score).toBeLessThan(15);
      },
    );

    test(
      'T2-F16-02 Exporting unsupported formats (?format=pdf and ?format=exe) rejected with 400 / 40001',
      { tag: ['@tier2', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '非法导出格式测试',
          })
        ).complete!.article.id;

        for (const fmt of ['pdf', 'exe']) {
          const res = await apiRequest('v2', 'GET', `/articles/${articleId}/export?format=${fmt}`, {
            token: tenant.accessToken,
          });
          expect(res.status, `Expected 400 for format=${fmt}`).toBe(400);
          expect(res.body?.code).toBe(40001);
        }
      },
    );

    test(
      'T2-F16-03 Article title with quotes and </script> produces safely escaped valid JSON-LD',
      { tag: ['@tier2', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: 'JSON-LD 特殊字符转义测试',
          })
        ).complete!.article.id;

        await apiRequest('v2', 'PATCH', `/articles/${articleId}`, {
          token: tenant.accessToken,
          body: { title: 'NAS "Pro" & </script><img src=x onerror=alert(1)>' },
        });

        const evalRes = await apiRequest<GeoEvaluationData>(
          'v2',
          'POST',
          `/articles/${articleId}/evaluate-geo`,
          { token: tenant.accessToken },
        );
        expect(evalRes.status).toBe(200);
        assertValidJsonLd(evalRes.body!.data.schemaJsonLd, ['Article', 'FAQPage']);
      },
    );

    test(
      'T2-F16-04 Legacy columns (发送次数/转视频次数) and 小红书 1000字上限 warning are absent from /studio',
      { tag: ['@tier2', '@F16', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16b4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '2500字长文无旧版限制警告测试',
          })
        ).complete!.article.id;

        await apiRequest('v2', 'PATCH', `/articles/${articleId}`, {
          token: tenant.accessToken,
          body: {
            contentMarkdown: `# 四盘位 NAS 深度实测\n\n${'实测数据说明与硬件架构评测。'.repeat(200)}`,
          },
        });

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/studio?brandId=${brandId}&market=CN&articleId=${articleId}`, {
            waitUntil: 'domcontentloaded',
          });
          const text = await page.evaluate(() => document.body.innerText);
          expect(text).not.toContain('发送次数');
          expect(text).not.toContain('转视频次数');
          expect(text).not.toContain('1000字上限');
          expect(text).not.toContain('超过抖音/小红书');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F16-05 Cross-tenant evaluate-geo and export requests return 404',
      { tag: ['@tier2', '@F16', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f16b5');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleA = (
          await streamArticle(tenantA.accessToken, brandA, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '跨租户导出与体检隔离',
          })
        ).complete!.article.id;

        const [evalB, exportB] = await Promise.all([
          apiRequest('v2', 'POST', `/articles/${articleA}/evaluate-geo`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'GET', `/articles/${articleA}/export?format=md`, {
            token: tenantB.accessToken,
          }),
        ]);
        expect(evalB.status).toBe(404);
        expect(exportB.status).toBe(404);
      },
    );
  },
);

v2Describe(
  'F17: Publish URL Registration, One-Click Retest (Before/After) & Action Home',
  { tag: ['@F17', '@M5'] },
  () => {
    test(
      'T1-F17-01 Registering published URL creates GeoPublishRecord, sets PUBLISHED, and snapshots beforeMetrics',
      { tag: ['@tier1', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17t1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN');

        const baselineRun = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', prompts: [`发布基线测试 ${E2E_SENTINELS.GAP}`], engines },
          },
        );
        await pollVisibilityRunDone(tenant.accessToken, brandId, baselineRun.body!.data.id);

        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `发布基线测试 ${E2E_SENTINELS.GAP}`,
          })
        ).complete!.article.id;

        const pubRes = await apiRequest<GeoPublishRecordData>(
          'v2',
          'POST',
          `/articles/${articleId}/publish-records`,
          {
            token: tenant.accessToken,
            body: {
              publishedUrl: `https://xingyaonas-${tag}.example/blog/nas-2026`,
              channel: '官网博客',
            },
          },
        );
        expect([200, 201]).toContain(pubRes.status);
        expect(pubRes.body?.code).toBe(0);
        expect(pubRes.body!.data.publishedUrl).toContain('nas-2026');
        expect(pubRes.body!.data.channel).toBe('官网博客');

        const articleAfter = await apiRequest<GeoArticleData>(
          'v2',
          'GET',
          `/articles/${articleId}`,
          {
            token: tenant.accessToken,
          },
        );
        expect(articleAfter.body!.data.status).toBe('PUBLISHED');
      },
    );

    test(
      'T1-F17-02 One-click Retest launches RETEST VisibilityRun and automatically writes back afterMetrics',
      { tag: ['@tier1', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '2026 四盘位家用 NAS 复测闭环',
          })
        ).complete!.article.id;

        const rec = (
          await apiRequest<GeoPublishRecordData>(
            'v2',
            'POST',
            `/articles/${articleId}/publish-records`,
            {
              token: tenant.accessToken,
              body: {
                publishedUrl: `https://xingyaonas-${tag}.example/blog/retest`,
                channel: '官网博客',
              },
            },
          )
        ).body!.data;

        const retestRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/publish-records/${rec.id}/retest`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f17t2_${tag}`) },
          },
        );
        expect([200, 201]).toContain(retestRes.status);
        const run = retestRes.body!.data;
        expect(run.triggerType).toBe('RETEST');
        expect(run.retestArticleId).toBe(articleId);

        await pollVisibilityRunDone(tenant.accessToken, brandId, run.id);

        const updatedRecord = await pollUntil(
          async () => {
            const list = extractItems(
              (
                await apiRequest<{ items?: GeoPublishRecordData[] }>(
                  'v2',
                  'GET',
                  `/articles/${articleId}/publish-records`,
                  { token: tenant.accessToken },
                )
              ).body?.data,
            );
            return list.find((item) => item.id === rec.id);
          },
          (item) => Boolean(item?.afterMetrics && item.latestRetestRunId === run.id),
          { timeoutMs: 25_000, intervalMs: 400, label: 'afterMetrics writeback' },
        );
        expect(updatedRecord?.afterMetrics).toBeTruthy();
        expect(typeof updatedRecord!.afterMetrics!.mentionRate).toBe('number');
      },
    );

    test(
      'T1-F17-03 /studio right pane renders Before -> After comparison badge after Retest completes',
      { tag: ['@tier1', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17t3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '复测徽章展示验证',
          })
        ).complete!.article.id;

        const rec = (
          await apiRequest<GeoPublishRecordData>(
            'v2',
            'POST',
            `/articles/${articleId}/publish-records`,
            {
              token: tenant.accessToken,
              body: {
                publishedUrl: `https://xingyaonas-${tag}.example/blog/badge`,
                channel: '知乎',
              },
            },
          )
        ).body!.data;

        const retest = (
          await apiRequest<VisibilityRunData>('v2', 'POST', `/publish-records/${rec.id}/retest`, {
            token: tenant.accessToken,
          })
        ).body!.data;
        await pollVisibilityRunDone(tenant.accessToken, brandId, retest.id);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(
            `/publish?brandId=${brandId}&market=CN&articleId=${articleId}&tab=tracking`,
            {
              waitUntil: 'domcontentloaded',
            },
          );
          await expect(page.locator('body')).toContainText(/发布前|发布后|复测|Before|After/);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F17-04 Action Home API and /home UI render exact 3-block focused layout',
      { tag: ['@tier1', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17t4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await apiRequest('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
          token: tenant.accessToken,
          body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `首页行动卡测试 ${tag}` },
        });
        await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: `首页近期成稿测试 ${tag}`,
        });

        const homeApi = await apiRequest<ActionHomeData>(
          'v2',
          'GET',
          `/brands/${brandId}/home?market=CN`,
          { token: tenant.accessToken },
        );
        expect(homeApi.status).toBe(200);
        expect(homeApi.body!.data.health.days).toBe(14);
        expect(homeApi.body!.data.topBriefs.length).toBeLessThanOrEqual(3);
        expect(homeApi.body!.data.recentArticles.length).toBeLessThanOrEqual(5);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/home?brandId=${brandId}&market=CN`, { waitUntil: 'domcontentloaded' });
          await expect(
            page
              .getByTestId('home-health-strip')
              .or(page.getByText(/提及率|声量占比/))
              .first(),
          ).toBeVisible();
          await expect(
            page
              .getByTestId('home-top-briefs')
              .or(page.getByText(/优先写作建议|写作建议/))
              .first(),
          ).toBeVisible();
          await expect(
            page
              .getByTestId('home-recent-articles')
              .or(page.getByText(/近期成稿/))
              .first(),
          ).toBeVisible();
          await expect(page.getByRole('button', { name: /发起监测|发起新一轮监测/ })).toBeVisible();
          await page.getByTestId('home-more-menu').click();
          await expect(page.getByTestId('home-cta-write')).toBeVisible();
          await page.keyboard.press('Escape');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F17-05 Action Home Top 3 Brief card 查看详细意见 opens Drawer and 一键去写 routes to /studio?briefId=...',
      { tag: ['@tier1', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const brief = (
          await apiRequest<GeoBriefData>('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
            token: tenant.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `首页一键去写 ${tag}` },
          })
        ).body!.data;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/home?brandId=${brandId}&market=CN`, { waitUntil: 'domcontentloaded' });
          await page
            .getByRole('button', { name: /查看意见|查看详细意见/ })
            .first()
            .click();
          await waitForBriefDrawer(page);
          await page.keyboard.press('Escape');

          await page
            .getByRole('button', { name: /去写|一键去写/ })
            .first()
            .click();
          await expect(page).toHaveURL(/\/studio/);
          const u = new URL(page.url());
          expect(u.searchParams.get('briefId')).toBe(brief.id);
          expect(u.searchParams.get('brandId')).toBe(brandId);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F17-01 Invalid or non-HTTP publishedUrl rejected with 400 / 40001 and article status unchanged',
      { tag: ['@tier2', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const articleId = (
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '非法发布URL校验',
          })
        ).complete!.article.id;

        for (const badUrl of ['not-a-url', 'javascript:alert(1)', '']) {
          const res = await apiRequest('v2', 'POST', `/articles/${articleId}/publish-records`, {
            token: tenant.accessToken,
            body: { publishedUrl: badUrl, channel: '官网博客' },
          });
          expect(res.status, `Expected 400 for publishedUrl="${badUrl}"`).toBe(400);
          expect(res.body?.code).toBe(40001);
        }

        const after = await apiRequest<GeoArticleData>('v2', 'GET', `/articles/${articleId}`, {
          token: tenant.accessToken,
        });
        expect(after.body!.data.status).not.toBe('PUBLISHED');
      },
    );

    test(
      'T2-F17-02 Retest Idempotency-Key replay avoids double charge and STRICT 0 pts gets 402 / 40201',
      { tag: ['@tier2', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17b2');
        const rich = await provisionTenant({
          tag: `${tag}r`,
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brandRich = (await createBrand(rich.accessToken, buildCnBrandPayload(`${tag}r`)))
          .body!.data.id;
        const artRich = (
          await streamArticle(rich.accessToken, brandRich, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '复测幂等验证',
          })
        ).complete!.article.id;
        const recRich = (
          await apiRequest<GeoPublishRecordData>(
            'v2',
            'POST',
            `/articles/${artRich}/publish-records`,
            {
              token: rich.accessToken,
              body: { publishedUrl: `https://xingyaonas-${tag}.example/idem`, channel: '官网博客' },
            },
          )
        ).body!.data;

        const ptsBefore = (await getWallet(rich.accessToken)).body!.data.points;
        const idemKey = uniqueIdemKey(`f17b2_${tag}`);
        const r1 = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/publish-records/${recRich.id}/retest`,
          { token: rich.accessToken, headers: { 'idempotency-key': idemKey } },
        );
        expect([200, 201]).toContain(r1.status);
        await pollVisibilityRunDone(rich.accessToken, brandRich, r1.body!.data.id);
        const ptsAfterFirst = (await getWallet(rich.accessToken)).body!.data.points;

        const r2 = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/publish-records/${recRich.id}/retest`,
          { token: rich.accessToken, headers: { 'idempotency-key': idemKey } },
        );
        expect([200, 201, 409]).toContain(r2.status);
        expect((await getWallet(rich.accessToken)).body!.data.points).toBe(ptsAfterFirst);
        expect(ptsAfterFirst).toBeLessThan(ptsBefore);

        // 0-point STRICT tenant cannot retest
        const poor = await provisionTenant({
          tag: `${tag}p`,
          billingMode: 'STRICT',
          initialPoints: 10,
        });
        const brandPoor = (await createBrand(poor.accessToken, buildCnBrandPayload(`${tag}p`)))
          .body!.data.id;
        const artPoor = (
          await streamArticle(poor.accessToken, brandPoor, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '零余额复测拒绝',
          })
        ).complete!.article.id;
        expect((await getWallet(poor.accessToken)).body!.data.points).toBe(0);
        const recPoor = (
          await apiRequest<GeoPublishRecordData>(
            'v2',
            'POST',
            `/articles/${artPoor}/publish-records`,
            {
              token: poor.accessToken,
              body: { publishedUrl: `https://xingyaonas-${tag}.example/poor`, channel: '官网博客' },
            },
          )
        ).body!.data;
        const blocked = await apiRequest('v2', 'POST', `/publish-records/${recPoor.id}/retest`, {
          token: poor.accessToken,
        });
        expect(blocked.status).toBe(402);
        expect(blocked.body?.code).toBe(40201);
      },
    );

    test(
      'T2-F17-03 Action Home caps CN at <=3 briefs and <=5 articles, isolates GLOBAL (0/0), and rejects omitted ?market=',
      { tag: ['@tier2', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        for (let i = 0; i < 6; i += 1) {
          await apiRequest('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
            token: tenant.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `上限测试意见 ${i} ${tag}` },
          });
        }
        for (let i = 0; i < 6; i += 1) {
          await streamArticle(tenant.accessToken, brandId, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `上限测试成稿 ${i} ${tag}`,
          });
        }

        const cnHome = await apiRequest<ActionHomeData>(
          'v2',
          'GET',
          `/brands/${brandId}/home?market=CN`,
          { token: tenant.accessToken },
        );
        expect(cnHome.status).toBe(200);
        expect(cnHome.body!.data.topBriefs).toHaveLength(3);
        expect(cnHome.body!.data.recentArticles).toHaveLength(5);
        for (let i = 1; i < cnHome.body!.data.topBriefs.length; i += 1) {
          expect(cnHome.body!.data.topBriefs[i - 1].priorityScore).toBeGreaterThanOrEqual(
            cnHome.body!.data.topBriefs[i].priorityScore,
          );
        }

        const globalHome = await apiRequest<ActionHomeData>(
          'v2',
          'GET',
          `/brands/${brandId}/home?market=GLOBAL`,
          { token: tenant.accessToken },
        );
        expect(globalHome.status).toBe(200);
        expect(globalHome.body!.data.topBriefs).toHaveLength(0);
        expect(globalHome.body!.data.recentArticles).toHaveLength(0);

        const ambiguous = await apiRequest('v2', 'GET', `/brands/${brandId}/home`, {
          token: tenant.accessToken,
        });
        expect(ambiguous.status).toBe(400);
        expect(ambiguous.body?.code).toBe(40001);
      },
    );

    test(
      'T2-F17-04 Cross-tenant access to publish-records, retest, and home returns 404',
      { tag: ['@tier2', '@F17', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17b4');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const artA = (
          await streamArticle(tenantA.accessToken, brandA, {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '跨租户复测与首页隔离',
          })
        ).complete!.article.id;
        const recA = (
          await apiRequest<GeoPublishRecordData>(
            'v2',
            'POST',
            `/articles/${artA}/publish-records`,
            {
              token: tenantA.accessToken,
              body: { publishedUrl: `https://xingyaonas-${tag}.example/a`, channel: '官网博客' },
            },
          )
        ).body!.data.id;

        const checks = await Promise.all([
          apiRequest('v2', 'GET', `/articles/${artA}/publish-records`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'POST', `/articles/${artA}/publish-records`, {
            token: tenantB.accessToken,
            body: { publishedUrl: 'https://evil.example/a', channel: '知乎' },
          }),
          apiRequest('v2', 'POST', `/publish-records/${recA}/retest`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'GET', `/brands/${brandA}/home?market=CN`, {
            token: tenantB.accessToken,
          }),
        ]);
        for (const r of checks) {
          expect(r.status).toBe(404);
        }
      },
    );

    test(
      'T2-F17-05 /home has zero horizontal overflow at 1440x900 and 1280x800 with long CN/EN titles',
      { tag: ['@tier2', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f17b5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        for (let i = 0; i < 3; i += 1) {
          await apiRequest('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `2026 超长中英文混合标题压力测试 UltraQuiet-4Bay-Enterprise-NAS-Benchmark-Edition-${i}-${tag}`,
            },
          });
        }
        await streamArticle(tenant.accessToken, brandId, {
          market: 'CN',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
          targetPrompt: `超长标题成稿布局测试 LongTitleOverflowCheck_${tag}`,
        });

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/home?brandId=${brandId}&market=CN`, { waitUntil: 'domcontentloaded' });
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
