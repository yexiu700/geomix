import { expect, test, v2Describe } from './support/v2-test';
import {
  apiRequest,
  createBrand,
  extractItems,
  getWallet,
  pollUntil,
  pollVisibilityRunDone,
  provisionTenant,
  saveBrandFacts,
  type GeoBriefData,
  type VisibilityEngineOption,
  type VisibilityRunData,
} from './support/api-client';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFactsPayload,
  E2E_SENTINELS,
  uniqueIdemKey,
  uniqueTag,
} from './support/fixtures';
import {
  createAuthenticatedContext,
  openBriefDrawerAndEdit,
  waitForBriefDrawer,
} from './support/ui-actions';

// ============================================================================
// Spec 04 — M3 Diagnosis-to-Brief Engine & Drawer: F11 (6 T1 + 6 T2 = 12 tests)
// Progressive rule: ZERO calls to /articles*, /batch-jobs, /publish-records, /home.
// ============================================================================

async function getOnlineEngines(
  token: string,
  brandId: string,
  market: 'CN' | 'GLOBAL',
  count = 2,
): Promise<string[]> {
  const res = await apiRequest<{ items?: VisibilityEngineOption[] } | VisibilityEngineOption[]>(
    'v2',
    'GET',
    `/brands/${brandId}/visibility/engines?market=${market}`,
    { token },
  );
  const items = extractItems(res.body?.data);
  const online = items
    .filter((e) => e.available !== false && e.online !== false && e.status !== 'offline')
    .map((e) => e.key);
  return (online.length > 0 ? online : items.map((e) => e.key)).slice(0, count);
}

v2Describe(
  'F11: Diagnosis-to-Brief Engine & Content Brief Drawer',
  { tag: ['@F11', '@M3'] },
  () => {
    test(
      'T1-F11-01 Completed VisibilityRun auto-generates Top 1-5 prioritized GeoBrief cards at 0 extra points',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t1');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN', 2);

        const createRun = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f11t1_${tag}`) },
            body: {
              market: 'CN',
              prompts: [
                `四盘位NAS推荐 ${E2E_SENTINELS.GAP}`,
                `家用NAS噪音评测 ${E2E_SENTINELS.NEGATIVE}`,
                `NAS硬件对比 ${E2E_SENTINELS.LOW_RANK}`,
              ],
              engines,
            },
          },
        );
        expect([200, 201]).toContain(createRun.status);
        const runId = createRun.body!.data.id;
        await pollVisibilityRunDone(tenant.accessToken, brandId, runId);

        const ptsAfterRun = (await getWallet(tenant.accessToken)).body!.data.points;

        const runWithBriefs = await pollUntil(
          async () => {
            const r = await apiRequest<VisibilityRunData>(
              'v2',
              'GET',
              `/brands/${brandId}/visibility/runs/${runId}`,
              { token: tenant.accessToken },
            );
            return r.body!.data;
          },
          (r) => Boolean(r.briefsGeneratedAt),
          { timeoutMs: 30_000, intervalMs: 400, label: 'briefsGeneratedAt' },
        );
        expect(runWithBriefs.briefsGeneratedAt).toBeTruthy();

        const briefsRes = await apiRequest<{ items?: GeoBriefData[] } | GeoBriefData[]>(
          'v2',
          'GET',
          `/brands/${brandId}/briefs?market=CN&status=OPEN`,
          { token: tenant.accessToken },
        );
        expect(briefsRes.status).toBe(200);
        const briefs = extractItems(briefsRes.body?.data);
        expect(briefs.length).toBeGreaterThanOrEqual(1);
        expect(briefs.length).toBeLessThanOrEqual(5);

        for (let i = 1; i < briefs.length; i += 1) {
          expect(briefs[i - 1].priorityScore).toBeGreaterThanOrEqual(briefs[i].priorityScore);
        }

        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(ptsAfterRun);
      },
    );

    test(
      'T1-F11-02 On-demand POST /briefs/generate works across LOW_RANK and FANOUT_CLUSTER at 0 points',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t2');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN', 1);

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              prompts: [`NAS顺位测试 ${E2E_SENTINELS.LOW_RANK}`],
              engines,
            },
          },
        );
        const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
        const obsId = run.observations![0].id;
        const balanceBefore = (await getWallet(tenant.accessToken)).body!.data.points;

        const lowRankBrief = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'LOW_RANK',
              observationIds: [obsId],
            },
          },
        );
        expect([200, 201]).toContain(lowRankBrief.status);
        expect(lowRankBrief.body?.code).toBe(0);
        const b1 = lowRankBrief.body!.data;
        expect(b1.diagnosisSummary.length).toBeGreaterThan(5);
        expect([
          'AUTHORITY_GUIDE',
          'COMPARISON_MATRIX',
          'OBJECTION_FAQ',
          'CITATION_COUNTER',
        ]).toContain(b1.recommendedRecipe);
        expect(b1.suggestedTitle.length).toBeGreaterThan(2);
        expect(b1.outlineH2.length).toBeGreaterThanOrEqual(2);
        expect(b1.status).toBe('OPEN');

        const fanOutBrief = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'FANOUT_CLUSTER',
              fanOutQueries: ['安静家用NAS', '四盘位NAS功耗实测', '双2.5G网口NAS'],
              customPrompt: '安静低功耗四盘位家用NAS怎么选？',
            },
          },
        );
        expect([200, 201]).toContain(fanOutBrief.status);
        expect(fanOutBrief.body!.data.targetFanOuts.length).toBeGreaterThanOrEqual(2);
        expect(fanOutBrief.body!.data.recommendedChannels.length).toBeGreaterThanOrEqual(1);

        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(balanceBefore);
      },
    );

    test(
      'T1-F11-03 GLOBAL brief produces English title/outline, Chinese diagnosis, and GLOBAL channels',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const res = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'GLOBAL',
              sourceType: 'MANUAL',
              customPrompt: 'Best quiet 4-bay NAS for home media server 2026',
            },
          },
        );
        expect([200, 201]).toContain(res.status);
        const brief = res.body!.data;
        expect(brief.market).toBe('GLOBAL');
        expect(brief.suggestedTitle).toMatch(/[A-Za-z]{4,}/);
        expect(brief.outlineH2.length).toBeGreaterThanOrEqual(2);
        for (const h2 of brief.outlineH2) {
          expect(h2.heading).toMatch(/[A-Za-z]{3,}/);
        }
        expect(brief.diagnosisSummary).toMatch(/[\u4e00-\u9fa5]/);
        const channelText = brief.recommendedChannels.map((c) => c.channel).join(' ');
        expect(channelText).not.toContain('小红书');
        expect(channelText).not.toContain('什么值得买');
      },
    );

    test(
      'T1-F11-04 Clicking 提写作意见 opens GeoBriefDrawer with 5 sections and PATCH persists edits',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        await saveBrandFacts(
          tenant.accessToken,
          brandId,
          buildFourBrandFactsPayload(tag, { truthAgreed: true }),
        );

        const gen = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `家用四盘位静音NAS选购指南 ${tag}`,
            },
          },
        );
        expect([200, 201]).toContain(gen.status);
        const brief = gen.body!.data;

        const editedTitle = `编辑后标题-${tag}`;
        const patchRes = await apiRequest<GeoBriefData>('v2', 'PATCH', `/briefs/${brief.id}`, {
          token: tenant.accessToken,
          body: {
            suggestedTitle: editedTitle,
            recommendedRecipe: 'COMPARISON_MATRIX',
          },
        });
        expect(patchRes.status).toBe(200);
        expect(patchRes.body!.data.suggestedTitle).toBe(editedTitle);
        expect(patchRes.body!.data.recommendedRecipe).toBe('COMPARISON_MATRIX');

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          const openBtn = page.getByRole('button', { name: /查看详细意见|提写作意见/ }).first();
          await expect(openBtn).toBeVisible();
          await openBtn.click();
          await waitForBriefDrawer(page);
          const drawer = page
            .getByTestId('geo-brief-drawer')
            .or(page.locator('.ant-drawer-open'))
            .first();
          await expect(drawer).toContainText(editedTitle);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F11-05 Clicking 按此意见立即写作 in GeoBriefDrawer transitions directly to /studio?briefId=...',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const gen = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'MANUAL',
              customPrompt: `NAS写作跳转测试 ${tag}`,
            },
          },
        );
        const briefId = gen.body!.data.id;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await page
            .getByRole('button', { name: /查看详细意见|提写作意见/ })
            .first()
            .click();
          await openBriefDrawerAndEdit(page, { clickWrite: true });

          await expect(page).toHaveURL(new RegExp(`/studio`));
          const url = new URL(page.url());
          expect(url.searchParams.get('briefId')).toBe(briefId);
          expect(url.searchParams.get('brandId')).toBe(brandId);
          expect(url.searchParams.get('market')).toBe('CN');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F11-06 Dismissing a brief excludes it from ?status=OPEN queue',
      { tag: ['@tier1', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11t6');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const gen = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `待忽略意见 ${tag}` },
          },
        );
        const briefId = gen.body!.data.id;

        const patch = await apiRequest<GeoBriefData>('v2', 'PATCH', `/briefs/${briefId}`, {
          token: tenant.accessToken,
          body: { status: 'DISMISSED' },
        });
        expect(patch.status).toBe(200);
        expect(patch.body!.data.status).toBe('DISMISSED');

        const openList = extractItems(
          (
            await apiRequest<{ items?: GeoBriefData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/briefs?market=CN&status=OPEN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(openList.some((b) => b.id === briefId)).toBe(false);
      },
    );

    test(
      'T2-F11-01 D16 Graceful Degradation: on-demand brief with citations: [] produces complete GeoBrief',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN', 1);

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              prompts: [`无引用源降级测试 ${E2E_SENTINELS.NO_CITATIONS}`],
              engines,
            },
          },
        );
        const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
        const obs = run.observations![0];
        expect(obs.citations).toEqual([]);

        const briefRes = await apiRequest<GeoBriefData>(
          'v2',
          'POST',
          `/brands/${brandId}/briefs/generate`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              sourceType: 'AUTO_GAP',
              observationIds: [obs.id],
            },
          },
        );
        expect([200, 201]).toContain(briefRes.status);
        expect(briefRes.body?.code).toBe(0);
        const brief = briefRes.body!.data;
        expect(brief.diagnosisSummary.trim().length).toBeGreaterThan(5);
        expect(brief.outlineH2.length).toBeGreaterThanOrEqual(3);
        expect(brief.recommendedChannels.length).toBeGreaterThanOrEqual(1);
      },
    );

    test(
      'T2-F11-02 D16 Auto-Hook: VisibilityRun with 0 citations still sets briefsGeneratedAt and creates briefs',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN', 1);

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: {
              market: 'CN',
              prompts: [`无引用自动意见 ${E2E_SENTINELS.NO_CITATIONS} ${E2E_SENTINELS.GAP}`],
              engines,
            },
          },
        );
        const runId = runRes.body!.data.id;
        await pollVisibilityRunDone(tenant.accessToken, brandId, runId);

        const runWithBriefs = await pollUntil(
          async () => {
            const r = await apiRequest<VisibilityRunData>(
              'v2',
              'GET',
              `/brands/${brandId}/visibility/runs/${runId}`,
              { token: tenant.accessToken },
            );
            return r.body!.data;
          },
          (r) => Boolean(r.briefsGeneratedAt),
          { timeoutMs: 30_000, intervalMs: 400, label: 'D16 auto-briefs' },
        );
        expect(runWithBriefs.briefsGeneratedAt).toBeTruthy();

        const briefs = extractItems(
          (
            await apiRequest<{ items?: GeoBriefData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/briefs?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(briefs.some((b) => b.sourceRunId === runId)).toBe(true);
      },
    );

    test(
      'T2-F11-03 Auto-brief hook idempotency: completed run never creates duplicate brief batches',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b3');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const engines = await getOnlineEngines(tenant.accessToken, brandId, 'CN', 1);

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            body: { market: 'CN', prompts: [`幂等测试 ${E2E_SENTINELS.GAP}`], engines },
          },
        );
        const runId = runRes.body!.data.id;
        await pollVisibilityRunDone(tenant.accessToken, brandId, runId);

        const firstRun = await pollUntil(
          async () =>
            (
              await apiRequest<VisibilityRunData>(
                'v2',
                'GET',
                `/brands/${brandId}/visibility/runs/${runId}`,
                { token: tenant.accessToken },
              )
            ).body!.data,
          (r) => Boolean(r.briefsGeneratedAt),
          { timeoutMs: 30_000, intervalMs: 400 },
        );

        const list1 = extractItems(
          (
            await apiRequest<{ items?: GeoBriefData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/briefs?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        ).filter((b) => b.sourceRunId === runId);

        await new Promise((r) => setTimeout(r, 1500));

        const secondRun = (
          await apiRequest<VisibilityRunData>(
            'v2',
            'GET',
            `/brands/${brandId}/visibility/runs/${runId}`,
            { token: tenant.accessToken },
          )
        ).body!.data;
        const list2 = extractItems(
          (
            await apiRequest<{ items?: GeoBriefData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/briefs?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        ).filter((b) => b.sourceRunId === runId);

        expect(secondRun.briefsGeneratedAt).toBe(firstRun.briefsGeneratedAt);
        expect(list2.length).toBe(list1.length);
        expect(list2.length).toBeLessThanOrEqual(5);
      },
    );

    test(
      'T2-F11-04 Free-action rate-limiting enforced on POST /briefs/generate (429) at 0 points',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b4');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        let hit429 = false;
        for (let i = 0; i < 40; i += 1) {
          const res = await apiRequest('v2', 'POST', `/brands/${brandId}/briefs/generate`, {
            token: tenant.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: `限流测试问句 ${i}` },
          });
          if (res.status === 429) {
            hit429 = true;
            expect(res.body?.code).not.toBe(0);
            break;
          }
        }
        expect(hit429, 'Expected 429 rate-limit on free /briefs/generate burst').toBe(true);
        expect((await getWallet(tenant.accessToken)).body!.data.points).toBe(100);
      },
    );

    test(
      'T2-F11-05 Cross-tenant isolation on GeoBrief list, generate, and patch returns 404',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b5');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const briefA = (
          await apiRequest<GeoBriefData>('v2', 'POST', `/brands/${brandA}/briefs/generate`, {
            token: tenantA.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: '租户隔离测试' },
          })
        ).body!.data.id;

        const checks = await Promise.all([
          apiRequest('v2', 'GET', `/brands/${brandA}/briefs?market=CN`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'POST', `/brands/${brandA}/briefs/generate`, {
            token: tenantB.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: 'hijack' },
          }),
          apiRequest('v2', 'PATCH', `/briefs/${briefA}`, {
            token: tenantB.accessToken,
            body: { status: 'DISMISSED' },
          }),
        ]);
        for (const r of checks) {
          expect(r.status).toBe(404);
        }
      },
    );

    test(
      'T2-F11-06 Invalid sourceType, foreign observationIds, and invalid recommendedRecipe rejected',
      { tag: ['@tier2', '@F11', '@M3'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f11b6');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(`${tag}a`)))
          .body!.data.id;
        const brandB = (await createBrand(tenantB.accessToken, buildCnBrandPayload(`${tag}b`)))
          .body!.data.id;

        const badSource = await apiRequest('v2', 'POST', `/brands/${brandA}/briefs/generate`, {
          token: tenantA.accessToken,
          body: { market: 'CN', sourceType: 'INVALID_SOURCE', customPrompt: 'test' },
        });
        expect(badSource.status).toBe(400);

        const enginesB = await getOnlineEngines(tenantB.accessToken, brandB, 'CN', 1);
        const runB = await pollVisibilityRunDone(
          tenantB.accessToken,
          brandB,
          (
            await apiRequest<VisibilityRunData>('v2', 'POST', `/brands/${brandB}/visibility/runs`, {
              token: tenantB.accessToken,
              body: { market: 'CN', prompts: ['tenant B obs'], engines: enginesB },
            })
          ).body!.data.id,
        );
        const foreignObs = await apiRequest('v2', 'POST', `/brands/${brandA}/briefs/generate`, {
          token: tenantA.accessToken,
          body: {
            market: 'CN',
            sourceType: 'LOW_RANK',
            observationIds: [runB.observations![0].id],
          },
        });
        expect([400, 404]).toContain(foreignObs.status);

        const validBrief = (
          await apiRequest<GeoBriefData>('v2', 'POST', `/brands/${brandA}/briefs/generate`, {
            token: tenantA.accessToken,
            body: { market: 'CN', sourceType: 'MANUAL', customPrompt: 'recipe check' },
          })
        ).body!.data.id;
        const badRecipe = await apiRequest('v2', 'PATCH', `/briefs/${validBrief}`, {
          token: tenantA.accessToken,
          body: { recommendedRecipe: 'UNKNOWN_RECIPE' },
        });
        expect(badRecipe.status).toBe(400);
      },
    );
  },
);
