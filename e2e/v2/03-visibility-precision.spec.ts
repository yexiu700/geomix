import { expect, test, v2Describe } from './support/v2-test';
import {
  apiRequest,
  createBrand,
  extractItems,
  getWallet,
  pollVisibilityRunDone,
  provisionTenant,
  type VisibilityEngineOption,
  type VisibilityRunData,
} from './support/api-client';
import {
  assertNoHorizontalOverflow,
  VIEWPORT_COMPACT,
  VIEWPORT_DESKTOP,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  CN_ENGINE_KEYS,
  E2E_SENTINELS,
  GLOBAL_ENGINE_KEYS,
  uniqueIdemKey,
  uniqueTag,
} from './support/fixtures';
import {
  createAuthenticatedContext,
  openVisibilityTab,
  switchGlobalMarket,
} from './support/ui-actions';

// ============================================================================
// Spec 03 — M2 Visibility Workspace & Precision Fixes: F9–F10 (10 T1 + 11 T2 = 21)
// Progressive rule: ZERO calls to /briefs, /articles, /batch-jobs,
// /publish-records, or /home.
// ============================================================================

async function fetchEngines(
  token: string,
  brandId: string,
  market: 'CN' | 'GLOBAL',
): Promise<VisibilityEngineOption[]> {
  const res = await apiRequest<
    | { items?: VisibilityEngineOption[]; engines?: VisibilityEngineOption[] }
    | VisibilityEngineOption[]
  >('v2', 'GET', `/brands/${brandId}/visibility/engines?market=${market}`, { token });
  expect(res.status).toBe(200);
  expect(res.body?.code).toBe(0);
  return extractItems(res.body?.data);
}

function pickOnlineEngines(engines: VisibilityEngineOption[], max = 2): string[] {
  const online = engines
    .filter((e) => e.available !== false && e.online !== false && e.status !== 'offline')
    .map((e) => e.key);
  return (online.length > 0 ? online : engines.map((e) => e.key)).slice(0, max);
}

v2Describe(
  'F9: Dual-Market Isolated Visibility Workspace (/visibility)',
  { tag: ['@F9', '@M2'] },
  () => {
    test(
      'T1-F09-01 /visibility renders 3 consolidated Tabs locked to active global brandId + market',
      { tag: ['@tier1', '@F9', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09t1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await expect(
            page
              .getByTestId('visibility-tab-overview')
              .or(page.getByRole('tab', { name: /诊断总览/ }))
              .first(),
          ).toBeVisible();
          await expect(
            page
              .getByTestId('visibility-tab-runs')
              .or(page.getByRole('tab', { name: /监测任务/ }))
              .first(),
          ).toBeVisible();
          await expect(
            page
              .getByTestId('visibility-tab-citations')
              .or(page.getByRole('tab', { name: /信源阵地/ }))
              .first(),
          ).toBeVisible();
          await expect(page.locator('body')).not.toContainText('全部监测档案');
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F09-02 Engine list strictly isolates CN (4 engines incl. tongyi) vs GLOBAL (5 engines)',
      { tag: ['@tier1', '@F9', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09t2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const cnEngines = await fetchEngines(tenant.accessToken, brandId, 'CN');
        const globalEngines = await fetchEngines(tenant.accessToken, brandId, 'GLOBAL');

        expect(cnEngines.map((e) => e.key).sort()).toEqual([...CN_ENGINE_KEYS].sort());
        expect(cnEngines.some((e) => e.key === 'tongyi')).toBe(true);
        expect(cnEngines.some((e) => e.key === 'qwen')).toBe(false);
        expect(globalEngines.map((e) => e.key).sort()).toEqual([...GLOBAL_ENGINE_KEYS].sort());

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await openVisibilityTab(page, 'runs');
          await expect(page.locator('body')).toContainText(/DeepSeek|豆包/);

          await switchGlobalMarket(page, 'GLOBAL');
          await openVisibilityTab(page, 'runs');
          await expect(page.locator('body')).toContainText(/ChatGPT|Perplexity/);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T1-F09-03 Create and complete CN VisibilityRun with exact visibility_check=2 billing',
      { tag: ['@tier1', '@F9', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09t3');
        const tenant = await provisionTenant({ tag, billingMode: 'STRICT', initialPoints: 100 });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const cnEngines = await fetchEngines(tenant.accessToken, brandId, 'CN');
        const selected = pickOnlineEngines(cnEngines, 2);

        const createRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f09t3_${tag}`) },
            body: {
              market: 'CN',
              prompts: ['2026 四盘位家用 NAS 推荐哪个品牌？'],
              engines: selected,
            },
          },
        );
        expect([200, 201]).toContain(createRes.status);
        expect(createRes.body?.code).toBe(0);

        const run = await pollVisibilityRunDone(
          tenant.accessToken,
          brandId,
          createRes.body!.data.id,
        );
        expect(['COMPLETED', 'PARTIAL']).toContain(run.status);
        expect((run.observations ?? []).length).toBeGreaterThanOrEqual(1);
        const obs = run.observations![0];
        expect(typeof obs.promptText).toBe('string');
        expect(typeof obs.engine).toBe('string');
        expect(typeof obs.brandMentioned).toBe('boolean');
        expect(Array.isArray(obs.fanOutQueries)).toBe(true);
        expect(Array.isArray(obs.citations)).toBe(true);

        const walletAfter = (await getWallet(tenant.accessToken)).body!.data;
        const expectedCost = selected.length * 2;
        expect(walletAfter.points).toBe(100 - expectedCost);
        expect(walletAfter.pointsReserved).toBe(0);
      },
    );

    test(
      'T1-F09-04 Overview API and UI strictly isolate CN runs from GLOBAL overview on dual-market brand',
      { tag: ['@tier1', '@F9', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09t4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;
        const cnEngines = pickOnlineEngines(
          await fetchEngines(tenant.accessToken, brandId, 'CN'),
          1,
        );

        const created = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f09t4_${tag}`) },
            body: { market: 'CN', prompts: ['四盘位NAS推荐'], engines: cnEngines },
          },
        );
        await pollVisibilityRunDone(tenant.accessToken, brandId, created.body!.data.id);

        const cnOverview = await apiRequest<Record<string, unknown>>(
          'v2',
          'GET',
          `/brands/${brandId}/visibility/overview?market=CN`,
          { token: tenant.accessToken },
        );
        const globalOverview = await apiRequest<Record<string, unknown>>(
          'v2',
          'GET',
          `/brands/${brandId}/visibility/overview?market=GLOBAL`,
          { token: tenant.accessToken },
        );
        expect(cnOverview.status).toBe(200);
        expect(globalOverview.status).toBe(200);

        const cnRuns = extractItems(
          (
            await apiRequest<{ items?: VisibilityRunData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/visibility/runs?market=CN`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        const globalRuns = extractItems(
          (
            await apiRequest<{ items?: VisibilityRunData[] }>(
              'v2',
              'GET',
              `/brands/${brandId}/visibility/runs?market=GLOBAL`,
              { token: tenant.accessToken },
            )
          ).body?.data,
        );
        expect(cnRuns.length).toBeGreaterThanOrEqual(1);
        expect(globalRuns).toHaveLength(0);
      },
    );

    test(
      'T1-F09-05 Tab 2 Answer Lens and Tab 3 Citation Topology render observations, citations, and Fan-Out leaderboard',
      { tag: ['@tier1', '@F9', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09t5');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const cnEngines = pickOnlineEngines(
          await fetchEngines(tenant.accessToken, brandId, 'CN'),
          1,
        );

        const runRes = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f09t5_${tag}`) },
            body: {
              market: 'CN',
              prompts: [
                `四盘位家用NAS对比 ${E2E_SENTINELS.COMP_DOMAIN} ${E2E_SENTINELS.FANOUT_SEMI}`,
              ],
              engines: cnEngines,
            },
          },
        );
        await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await openVisibilityTab(page, 'runs');
          await expect(page.locator('body')).toContainText(/四盘位家用NAS对比|COMPLETED|已完成/);

          await openVisibilityTab(page, 'citations');
          await expect(page.locator('body')).toContainText(/信源|引用|Fan-Out|拆解/);
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F09-01 Offline engines are transparently marked 暂未上线 and unchecked by default',
      { tag: ['@tier2', '@F9', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09b1');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;

        const engines = await fetchEngines(tenant.accessToken, brandId, 'CN');
        expect(engines).toHaveLength(4);
        const offline = engines.filter(
          (e) => e.available === false || e.online === false || e.status === 'offline',
        );
        expect(
          offline.length,
          'Expected at least one offline CN engine (暂未上线) in CN 4-engine catalog',
        ).toBeGreaterThan(0);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await openVisibilityTab(page, 'runs');
          await expect(page.locator('body')).toContainText('暂未上线');

          const targetOffline = offline[0];
          const labelPattern = (
            targetOffline.label ||
            targetOffline.name ||
            targetOffline.key
          ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const offlineOpt = page
            .getByTestId(`engine-option-${targetOffline.key}`)
            .or(page.getByRole('checkbox', { name: new RegExp(labelPattern, 'i') }))
            .first();
          await expect(offlineOpt).toBeVisible();

          const nestedCheckbox = offlineOpt
            .locator('input[type="checkbox"], [role="checkbox"]')
            .first();
          const control = (await nestedCheckbox.count()) > 0 ? nestedCheckbox : offlineOpt;
          const isNativeInput = await control.evaluate(
            (el) => el.tagName.toLowerCase() === 'input',
          );
          if (isNativeInput) {
            await expect(control).not.toBeChecked();
          } else {
            const ariaChecked = await control.getAttribute('aria-checked');
            const isDisabled = await control.evaluate(
              (el) =>
                el.hasAttribute('disabled') ||
                el.getAttribute('aria-disabled') === 'true' ||
                el.classList.contains('ant-checkbox-wrapper-disabled') ||
                el.classList.contains('ant-checkbox-disabled') ||
                Boolean(el.closest('.ant-checkbox-wrapper-disabled, [aria-disabled="true"]')),
            );
            expect(
              ariaChecked === 'false' || isDisabled,
              `Expected offline engine ${targetOffline.key} to be unchecked or disabled by default`,
            ).toBe(true);
            expect(ariaChecked).not.toBe('true');
          }
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F09-02 Mismatched market engines and ambiguous dual-market overview without ?market= return 400',
      { tag: ['@tier2', '@F9', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09b2');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
          .body!.data.id;

        const badCn = await apiRequest('v2', 'POST', `/brands/${brandId}/visibility/runs`, {
          token: tenant.accessToken,
          body: { market: 'CN', prompts: ['test'], engines: ['chatgpt'] },
        });
        expect(badCn.status).toBe(400);
        expect(badCn.body?.code).toBe(40001);

        const badGlobal = await apiRequest('v2', 'POST', `/brands/${brandId}/visibility/runs`, {
          token: tenant.accessToken,
          body: { market: 'GLOBAL', prompts: ['test'], engines: ['doubao'] },
        });
        expect(badGlobal.status).toBe(400);
        expect(badGlobal.body?.code).toBe(40001);

        const ambiguousOverview = await apiRequest(
          'v2',
          'GET',
          `/brands/${brandId}/visibility/overview`,
          { token: tenant.accessToken },
        );
        expect(ambiguousOverview.status).toBe(400);
        expect(ambiguousOverview.body?.code).toBe(40001);
      },
    );

    test(
      'T2-F09-03 Idempotency-Key replay avoids double charge and STRICT 1-pt tenant gets 402 / 40201',
      { tag: ['@tier2', '@F9', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09b3');
        const rich = await provisionTenant({
          tag: `${tag}r`,
          billingMode: 'STRICT',
          initialPoints: 100,
        });
        const brandRich = (await createBrand(rich.accessToken, buildCnBrandPayload(`${tag}r`)))
          .body!.data.id;
        const cnEngines = pickOnlineEngines(
          await fetchEngines(rich.accessToken, brandRich, 'CN'),
          1,
        );
        const idemKey = uniqueIdemKey(`f09b3_${tag}`);

        const r1 = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandRich}/visibility/runs`,
          {
            token: rich.accessToken,
            headers: { 'idempotency-key': idemKey },
            body: { market: 'CN', prompts: ['NAS 推荐'], engines: cnEngines },
          },
        );
        expect([200, 201]).toContain(r1.status);
        await pollVisibilityRunDone(rich.accessToken, brandRich, r1.body!.data.id);

        const r2 = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandRich}/visibility/runs`,
          {
            token: rich.accessToken,
            headers: { 'idempotency-key': idemKey },
            body: { market: 'CN', prompts: ['NAS 推荐'], engines: cnEngines },
          },
        );
        expect([200, 201, 409]).toContain(r2.status);
        if (r2.status < 300 && r2.body?.data?.id) {
          expect(r2.body.data.id).toBe(r1.body!.data.id);
        }
        expect((await getWallet(rich.accessToken)).body!.data.points).toBe(
          100 - cnEngines.length * 2,
        );

        const poor = await provisionTenant({
          tag: `${tag}p`,
          billingMode: 'STRICT',
          initialPoints: 1,
        });
        const brandPoor = (await createBrand(poor.accessToken, buildCnBrandPayload(`${tag}p`)))
          .body!.data.id;
        const lowRes = await apiRequest('v2', 'POST', `/brands/${brandPoor}/visibility/runs`, {
          token: poor.accessToken,
          body: { market: 'CN', prompts: ['NAS 推荐'], engines: cnEngines },
        });
        expect(lowRes.status).toBe(402);
        expect(lowRes.body?.code).toBe(40201);
      },
    );

    test(
      'T2-F09-04 #306 regression: /visibility runs table has zero overflow/clipping at 1440x900 and 1280x800',
      { tag: ['@tier2', '@F9', '@M2'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09b4');
        const tenant = await provisionTenant({ tag });
        const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const cnEngines = pickOnlineEngines(
          await fetchEngines(tenant.accessToken, brandId, 'CN'),
          1,
        );

        const created = await apiRequest<VisibilityRunData>(
          'v2',
          'POST',
          `/brands/${brandId}/visibility/runs`,
          {
            token: tenant.accessToken,
            headers: { 'idempotency-key': uniqueIdemKey(`f09b4_${tag}`) },
            body: {
              market: 'CN',
              prompts: ['2026 四盘位静音低功耗金属机身家用私有云 NAS 长标题压力测试问句'],
              engines: cnEngines,
            },
          },
        );
        await pollVisibilityRunDone(tenant.accessToken, brandId, created.body!.data.id);

        const { context, page } = await createAuthenticatedContext(browser, tenant);
        try {
          await page.goto(`/visibility?brandId=${brandId}&market=CN`, {
            waitUntil: 'domcontentloaded',
          });
          await openVisibilityTab(page, 'runs');
          await assertNoHorizontalOverflow(page, {
            viewports: [VIEWPORT_DESKTOP, VIEWPORT_COMPACT],
          });
        } finally {
          await context.close();
        }
      },
    );

    test(
      'T2-F09-05 Cross-tenant access to visibility overview, runs, and run detail returns 404',
      { tag: ['@tier2', '@F9', '@M2'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 'f09b5');
        const tenantA = await provisionTenant({ tag: `${tag}a` });
        const tenantB = await provisionTenant({ tag: `${tag}b` });
        const brandA = (await createBrand(tenantA.accessToken, buildCnBrandPayload(tag))).body!.data
          .id;
        const cnEngines = pickOnlineEngines(
          await fetchEngines(tenantA.accessToken, brandA, 'CN'),
          1,
        );

        const runA = (
          await apiRequest<VisibilityRunData>('v2', 'POST', `/brands/${brandA}/visibility/runs`, {
            token: tenantA.accessToken,
            body: { market: 'CN', prompts: ['NAS 对比'], engines: cnEngines },
          })
        ).body!.data.id;

        const checks = await Promise.all([
          apiRequest('v2', 'GET', `/brands/${brandA}/visibility/overview?market=CN`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'GET', `/brands/${brandA}/visibility/runs?market=CN`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'GET', `/brands/${brandA}/visibility/runs/${runA}`, {
            token: tenantB.accessToken,
          }),
          apiRequest('v2', 'POST', `/brands/${brandA}/visibility/runs`, {
            token: tenantB.accessToken,
            body: { market: 'CN', prompts: ['hijack'], engines: cnEngines },
          }),
        ]);
        for (const r of checks) {
          expect(r.status).toBe(404);
        }
      },
    );
  },
);

v2Describe('F10: Visibility Precision Fixes', { tag: ['@F10', '@M2'] }, () => {
  test(
    'T1-F10-01 Fan-Out sub-queries joined by ; / ； / newline split and deduplicate cleanly',
    { tag: ['@tier1', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10t1');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`安静家用NAS对比 ${E2E_SENTINELS.FANOUT_SEMI}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const obs = run.observations![0];
      expect(obs.fanOutQueries.length).toBeGreaterThanOrEqual(2);
      const uniqueLower = new Set(obs.fanOutQueries.map((q) => q.trim().toLowerCase()));
      expect(uniqueLower.size).toBe(obs.fanOutQueries.length);
      for (const q of obs.fanOutQueries) {
        expect(q).not.toMatch(/[;；\n\r]/);
        expect(q.trim()).toBe(q);
        expect(q.length).toBeGreaterThan(0);
      }
    },
  );

  test(
    'T1-F10-02 Rule-fallback rank judge skips CN intro prompt-echo and extracts ordered-list position #3',
    { tag: ['@tier1', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10t2');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`星曜智储${tag}和竞品NAS推荐排序 ${E2E_SENTINELS.ECHO_TRAP}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const obs = run.observations![0];
      expect(obs.brandMentioned).toBe(true);
      expect(obs.brandPosition).toBe(3);
    },
  );

  test(
    'T1-F10-03 Rule-fallback rank judge accurately extracts Chinese ordinal / Markdown heading list rank',
    { tag: ['@tier1', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10t3');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`四盘位NAS顺位评测 ${E2E_SENTINELS.LOW_RANK}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const obs = run.observations![0];
      expect(obs.brandMentioned).toBe(true);
      expect(obs.brandPosition).not.toBeNull();
      expect(obs.brandPosition!).toBeGreaterThanOrEqual(3);
    },
  );

  test(
    'T1-F10-04 Citation classifier dynamically maps ownedDomains to OWNED and competitors[].domains to COMPETITOR',
    { tag: ['@tier1', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10t4');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`NAS信源分类验证 ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const citations = run.observations!.flatMap((o) => o.citations);
      expect(citations.length).toBeGreaterThan(0);
      const compCitation = citations.find(
        (c) => c.url.includes('jikong.example') || c.url.includes('synology.example'),
      );
      expect(compCitation, 'Expected competitor domain citation').toBeTruthy();
      expect(compCitation!.sourceKind).toBe('COMPETITOR');
    },
  );

  test(
    'T1-F10-05 Citation classifier accurately maps CN social (weibo/smzdm/xiaohongshu) and ecommerce (jd.com)',
    { tag: ['@tier1', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10t5');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`社媒电商信源分类 ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const citations = run.observations!.flatMap((o) => o.citations);

      const social = citations.filter((c) =>
        /(weibo\.cn|weibo\.com|smzdm\.com|xiaohongshu\.com|zhihu\.com)/.test(c.url),
      );
      expect(social.length).toBeGreaterThan(0);
      for (const c of social) {
        expect(['SOCIAL', 'AUTHORITY']).toContain(c.sourceKind);
      }

      const ecom = citations.filter((c) => /(jd\.com|tmall\.com|amazon\.com)/.test(c.url));
      expect(
        ecom.length,
        'Expected ecommerce citation (e.g., item.jd.com) for [E2E_COMP_DOMAIN]',
      ).toBeGreaterThan(0);
      for (const c of ecom) {
        expect(c.sourceKind).toBe('ECOMMERCE');
      }
    },
  );

  test(
    'T2-F10-01 Fan-Out normalization strips empty tokens, consecutive delimiters, and whitespace',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b1');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`分隔符清洗 ${E2E_SENTINELS.FANOUT_SEMI}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const fanOuts = run.observations![0].fanOutQueries;
      expect(fanOuts.length).toBeGreaterThan(0);
      for (const item of fanOuts) {
        expect(item.trim().length).toBeGreaterThan(0);
        expect(item).toBe(item.trim());
        expect(item).not.toContain(';');
        expect(item).not.toContain('；');
      }
    },
  );

  test(
    'T2-F10-02 GLOBAL English Fan-Out deduplication is case-insensitive',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b2');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
        .body!.data.id;
      const globalEngines = pickOnlineEngines(
        await fetchEngines(tenant.accessToken, brandId, 'GLOBAL'),
        1,
      );

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'GLOBAL',
            prompts: [`Best 4-bay NAS 2026 ${E2E_SENTINELS.FANOUT_SEMI}`],
            engines: globalEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const fanOuts = run.observations![0].fanOutQueries;
      expect(fanOuts.length).toBeGreaterThanOrEqual(2);
      for (const f of fanOuts) {
        expect(f).not.toMatch(/[;；\n]/);
      }
      const lowerSet = new Set(fanOuts.map((f) => f.toLowerCase()));
      expect(lowerSet.size).toBe(fanOuts.length);
    },
  );

  test(
    'T2-F10-03 Intro prompt-echo ONLY marks brandMentioned=false and brandPosition=null',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b3');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildCnBrandPayload(tag))).body!.data
        .id;
      const cnEngines = pickOnlineEngines(await fetchEngines(tenant.accessToken, brandId, 'CN'), 1);

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`关于星曜智储${tag}的NAS推荐 ${E2E_SENTINELS.ECHO_ONLY}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const obs = run.observations![0];
      expect(obs.brandMentioned).toBe(false);
      expect(obs.brandPosition).toBeNull();
    },
  );

  test(
    'T2-F10-04 GLOBAL English intro prompt-echo is skipped and ordered-list rank extracted accurately',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b4');
      const tenant = await provisionTenant({ tag });
      const brandId = (await createBrand(tenant.accessToken, buildDualMarketBrandPayload(tag)))
        .body!.data.id;
      const globalEngines = pickOnlineEngines(
        await fetchEngines(tenant.accessToken, brandId, 'GLOBAL'),
        1,
      );

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brandId}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'GLOBAL',
            prompts: [`AstraVault vs EcoNAS ranking ${E2E_SENTINELS.ECHO_TRAP}`],
            engines: globalEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brandId, runRes.body!.data.id);
      const obs = run.observations![0];
      expect(obs.brandMentioned).toBe(true);
      expect(obs.brandPosition).toBeGreaterThanOrEqual(2);
    },
  );

  test(
    'T2-F10-05 Citation classification produces strictly valid CitationSourceKind values and respects priority',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b5');
      const tenant = await provisionTenant({ tag });
      const brand = (
        await createBrand(
          tenant.accessToken,
          buildCnBrandPayload(tag, {
            markets: [
              {
                market: 'CN',
                locale: 'zh-CN',
                region: 'CN',
                localBrandName: `星曜${tag}`,
                ownedDomains: ['smzdm.com'],
                competitors: [{ name: '极空', aliases: [], domains: ['jikong.example'] }],
              },
            ],
          }),
        )
      ).body!.data;
      const cnEngines = pickOnlineEngines(
        await fetchEngines(tenant.accessToken, brand.id, 'CN'),
        1,
      );

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brand.id}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'CN',
            prompts: [`优先级测试 ${E2E_SENTINELS.COMP_DOMAIN}`],
            engines: cnEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brand.id, runRes.body!.data.id);
      const validKinds = new Set([
        'OWNED',
        'COMPETITOR',
        'SOCIAL',
        'AUTHORITY',
        'ECOMMERCE',
        'OTHER',
      ]);
      const citations = run.observations!.flatMap((o) => o.citations);
      expect(
        citations.length,
        'Expected non-empty citations for [E2E_COMP_DOMAIN]',
      ).toBeGreaterThan(0);
      for (const c of citations) {
        expect(validKinds.has(c.sourceKind), `Invalid sourceKind ${c.sourceKind}`).toBe(true);
      }
      const smzdm = citations.filter((c) => c.url.includes('smzdm.com'));
      expect(
        smzdm.length,
        'Expected smzdm.com citation for OWNED > SOCIAL priority check',
      ).toBeGreaterThan(0);
      for (const c of smzdm) {
        expect(c.sourceKind).toBe('OWNED');
      }
    },
  );

  test(
    'T2-F10-06 Whole-word boundary protection prevents false substring match for short English brand Ace',
    { tag: ['@tier2', '@F10', '@M2'] },
    async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'f10b6');
      const tenant = await provisionTenant({ tag });
      const brand = (
        await createBrand(tenant.accessToken, {
          name: `AceBrand${tag}`,
          category: 'Hardware',
          markets: [
            {
              market: 'GLOBAL',
              locale: 'en-US',
              region: 'US',
              localBrandName: 'Ace',
              aliases: [],
              ownedDomains: [`ace-${tag}.example`],
              competitors: [{ name: 'EcoNAS', aliases: [], domains: ['econas.example'] }],
            },
          ],
        })
      ).body!.data;
      const globalEngines = pickOnlineEngines(
        await fetchEngines(tenant.accessToken, brand.id, 'GLOBAL'),
        1,
      );

      const runRes = await apiRequest<VisibilityRunData>(
        'v2',
        'POST',
        `/brands/${brand.id}/visibility/runs`,
        {
          token: tenant.accessToken,
          body: {
            market: 'GLOBAL',
            prompts: [`Best surface interface in first place ${E2E_SENTINELS.GAP}`],
            engines: globalEngines,
          },
        },
      );
      const run = await pollVisibilityRunDone(tenant.accessToken, brand.id, runRes.body!.data.id);
      expect(run.observations![0].brandMentioned).toBe(false);
    },
  );
});
