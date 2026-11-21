import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  extractItems,
  getAdminSession,
  getAdminTenant,
  getTenantWallet,
  getWebBase,
  listMarketEnginesApi,
  provisionIsolatedTenant,
  requestV2,
  setTenantExpiry,
  unwrapOk,
  upsertBrandFactsApi,
  waitForAutoBriefsApi,
  waitForVisibilityRunApi,
  type GeoArticleDto,
} from './support/api-client';
import {
  assertNoColdLoadFlicker,
  assertNoConsoleOrPageErrors,
  assertZeroHorizontalOverflow,
  REQUIRED_VIEWPORTS,
} from './support/assertions';
import {
  buildCnBrandPayload,
  buildFourBrandFacts,
  E2E_SENTINELS,
  uniqueIdempotencyKey,
  uniqueTag,
} from './support/fixtures';
import {
  navigateWorkspace,
  openAccountWorkspace,
  openAuthenticatedPage,
  openVisibilityTab,
} from './support/ui-actions';
import { expect, test, v2Describe } from './support/v2-test';

v2Describe(
  'Tier 4 — Resilience (#321 Refund/Abort/Expiry) & Multi-Viewport Ergonomics/Admin Audit',
  {
    tag: ['@tier4', '@F2', '@F4', '@F5', '@F9', '@F12', '@F17', '@M5'],
  },
  () => {
    test(
      'S4-09 #321 zero-fake-fallback upstream refund + mid-stream SSE abort refund + retry + expired tenant 403/40301 verified via Admin API',
      { tag: ['@tier4', '@F2', '@F9', '@F12', '@M5'] },
      async ({}, testInfo) => {
        const tag = uniqueTag(testInfo, 's409');
        const tenant = await provisionIsolatedTenant({
          prefix: 's409',
          billingMode: 'STRICT',
          initialPoints: 50,
        });
        const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
        await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name));

        // 1. Upstream LLM failure -> SSE error event { refunded: true }, 0 fake articles saved, wallet remains 50
        const failSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's409fail'),
          assertSseHeaders: false,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 故障注入测试 ${E2E_SENTINELS.LLM_FAIL}`,
          },
        });
        if (failSse.status === 200) {
          expect(failSse.errorEvent, 'Expected SSE error event on upstream failure').toBeTruthy();
          expect(failSse.errorEvent?.refunded).toBe(true);
          expect(failSse.complete).toBeUndefined();
        } else {
          expect(failSse.status).toBeGreaterThanOrEqual(400);
        }

        const articlesAfterFail = extractItems(
          unwrapOk(
            await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
              `/brands/${brand.id}/articles?market=CN`,
              { token: tenant.session.accessToken },
            ),
            'GET articles after LLM_FAIL',
          ),
        );
        expect(
          articlesAfterFail,
          'Zero fake template articles may be persisted (#321)',
        ).toHaveLength(0);
        const walletAfterFail = await getTenantWallet(tenant.session);
        expect(walletAfterFail.points).toBe(50);
        expect(walletAfterFail.pointsReserved).toBe(0);

        // 2. Mid-stream SSE client abort -> server detects disconnect & atomically refunds (wallet stays 50, 0 corrupt articles)
        const abortSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's409abort'),
          abortAfterEventType: 'meta',
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 慢速流式中断测试 ${E2E_SENTINELS.SLOW_STREAM}`,
          },
        });
        expect(abortSse.aborted).toBe(true);
        await new Promise((r) => setTimeout(r, 1500));

        const articlesAfterAbort = extractItems(
          unwrapOk(
            await requestV2<{ items?: GeoArticleDto[] } | GeoArticleDto[]>(
              `/brands/${brand.id}/articles?market=CN`,
              { token: tenant.session.accessToken },
            ),
            'GET articles after mid-stream abort',
          ),
        );
        expect(articlesAfterAbort).toHaveLength(0);
        const walletAfterAbort = await getTenantWallet(tenant.session);
        expect(walletAfterAbort.points).toBe(50);
        expect(walletAfterAbort.pointsReserved).toBe(0);

        // 3. Clean retry succeeds -> 1 article persisted, wallet drops 50 -> 40
        const okSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's409ok'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 恢复后正常流式生成 ${tag}`,
          },
        });
        expect(okSse.status).toBe(200);
        expect(okSse.complete?.article.id).toBeTruthy();
        expect((await getTenantWallet(tenant.session)).points).toBe(40);

        // 4. Expire tenant -> TenantActiveGuard returns 403 / 40301 on write/billable endpoints;
        //    verify balance via Admin GET /api/v1/admin/tenants/:id (since /me/* & /billing/* are also blocked after expiry!)
        const onlineCn = (await listMarketEnginesApi(tenant.session, brand.id, 'CN')).filter(
          (e) => e.available || e.status === 'online',
        );
        const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        await setTenantExpiry(tenant.tenantId, yesterdayIso);

        const expiredVisRes = await requestV2(`/brands/${brand.id}/visibility/runs`, {
          method: 'POST',
          token: tenant.session.accessToken,
          headers: { 'idempotency-key': uniqueIdempotencyKey(testInfo, 's409expv') },
          body: {
            market: 'CN',
            prompts: ['过期租户监测阻断测试'],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
        });
        expect(expiredVisRes.status).toBe(403);
        expect(expiredVisRes.envelope.code).toBe(40301);

        const expiredSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's409expa'),
          assertSseHeaders: false,
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: '过期租户写作阻断测试',
          },
        });
        expect(expiredSse.status).toBe(403);
        expect(expiredSse.errorBody?.code).toBe(40301);

        const adminTenantView = await getAdminTenant(tenant.tenantId);
        const remainingPoints = adminTenantView.wallet?.points ?? adminTenantView.points;
        expect(remainingPoints, 'Expired tenant wallet balance must remain untouched at 40').toBe(
          40,
        );
      },
    );

    test(
      'S4-10 Multi-viewport 1440x900 & 1280x800 zero overflow, cold-load zero-flicker, exact 307 vs 404 legacy routes & Admin audit',
      { tag: ['@tier4', '@F2', '@F4', '@F5', '@F9', '@F12', '@F17', '@M5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 's410');
        const tenant = await provisionIsolatedTenant({ prefix: 's410', initialPoints: 180 });
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
            prompts: [`视口回归测试 ${tag} ${E2E_SENTINELS.GAP}`],
            engines: onlineCn.slice(0, 1).map((e) => e.key),
          },
          uniqueIdempotencyKey(testInfo, 's410run'),
        );
        await waitForVisibilityRunApi(tenant.session, brand.id, run.id);
        await waitForAutoBriefsApi(tenant.session, brand.id, 'CN', run.id);

        const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
          token: tenant.session.accessToken,
          idempotencyKey: uniqueIdempotencyKey(testInfo, 's410art'),
          body: {
            market: 'CN',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'CN_DEEP_REVIEW',
            targetPrompt: `${brand.name} 多视口排版验收文章`,
          },
        });
        expect(sse.status).toBe(200);

        // 1. Audit all 5 merchant workspaces (including all 3 Visibility tabs & Account tabs) at 1440x900 & 1280x800
        const { context, page, errors } = await openAuthenticatedPage(
          browser,
          tenant.session,
          `/home?brandId=${brand.id}&market=CN`,
        );
        try {
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);

          await navigateWorkspace(page, '品牌资产', /\/brands/);
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);

          await navigateWorkspace(page, '可见度诊断', /\/visibility/);
          await openVisibilityTab(page, 'overview');
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);
          await openVisibilityTab(page, 'runs');
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);
          await openVisibilityTab(page, 'citations');
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);

          await navigateWorkspace(page, 'GEO 写作台', /\/studio/);
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);

          await openAccountWorkspace(page);
          await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);
          for (const tabLabel of [/点数明细|点数/, /账号权益|权益/, /实名认证|认证/]) {
            const tab = page.getByRole('tab', { name: tabLabel }).first();
            if ((await tab.count()) > 0) {
              await tab.click();
              await assertZeroHorizontalOverflow(page, REQUIRED_VIEWPORTS);
            }
          }
          assertNoConsoleOrPageErrors(errors);
        } finally {
          await context.close();
        }

        // 2. Cold-load zero-flicker check (MutationObserver) on /home and /account
        await assertNoColdLoadFlicker(
          browser,
          tenant.session,
          `/home?brandId=${brand.id}&market=CN`,
          {
            holdMs: 900,
            expectedPointsText: /\d+/,
          },
        );
        await assertNoColdLoadFlicker(browser, tenant.session, '/account', {
          holdMs: 900,
          expectedPointsText: /\d+/,
        });

        // 3. Exact live 307 redirects vs 404 removed v1 routes (no-redirect fetch)
        const webBase = getWebBase();
        const expectedRedirects: ReadonlyArray<{ from: string; toPrefix: string }> = [
          { from: '/dashboard', toPrefix: '/home' },
          { from: '/visibility/overview', toPrefix: '/visibility' },
          { from: '/visibility/monitors', toPrefix: '/visibility' },
          { from: '/me/points', toPrefix: '/account' },
          { from: '/me/rights', toPrefix: '/account' },
          { from: '/me/verify', toPrefix: '/account' },
          { from: '/me/money', toPrefix: '/account' },
          { from: '/user/ai_task', toPrefix: '/studio' },
          { from: '/user/company_keyword', toPrefix: '/brands' },
        ];
        for (const item of expectedRedirects) {
          const res = await fetch(`${webBase}${item.from}`, { redirect: 'manual' });
          expect(res.status, `Expected 307 redirect for ${item.from}`).toBe(307);
          const location = res.headers.get('location') ?? '';
          expect(
            location,
            `Expected ${item.from} redirect location to target ${item.toPrefix}, got "${location}"`,
          ).toContain(item.toPrefix);
        }

        const expectedRemoved404 = ['/admin/templates', '/writing/tasks', '/material/keywords'];
        for (const removedPath of expectedRemoved404) {
          const res = await fetch(`${webBase}${removedPath}`, { redirect: 'manual' });
          expect(res.status, `Removed v1 route ${removedPath} must return 404`).toBe(404);
        }

        // 4. Admin audit: /admin/pricing (3 v2 actions, zero kb_addon/系统模板) + /admin/llm-costs + zero overflow
        const adminCtx = await openAuthenticatedPage(browser, getAdminSession(), '/admin/pricing');
        try {
          await expect(adminCtx.page.locator('body')).toContainText('GEO 靶向写作', {
            timeout: 15_000,
          });
          const pricingText = await adminCtx.page.locator('body').innerText();
          expect(pricingText).toContain('GEO 靶向写作');
          expect(pricingText).toContain('AI 可见性监测');
          expect(pricingText).toContain('行内 AI 配图');
          expect(pricingText).not.toContain('kb_addon');
          expect(pricingText).not.toContain('知识库加价');
          await expect(adminCtx.page.getByRole('link', { name: /系统模板/ })).toHaveCount(0);
          await assertZeroHorizontalOverflow(adminCtx.page, REQUIRED_VIEWPORTS);

          await adminCtx.page.goto('/admin/llm-costs', { waitUntil: 'domcontentloaded' });
          await expect(adminCtx.page.locator('body')).toContainText('总调用次数', {
            timeout: 15_000,
          });
          const costText = await adminCtx.page.locator('body').innerText();
          expect(costText).toContain('总调用次数');
          expect(costText).toContain('总 Token 消耗');
          await expect(
            adminCtx.page.getByRole('button', { name: /导出 CSV/ }).first(),
          ).toBeEnabled();
          await assertZeroHorizontalOverflow(adminCtx.page, REQUIRED_VIEWPORTS);
          assertNoConsoleOrPageErrors(adminCtx.errors);
        } finally {
          await adminCtx.context.close();
        }
      },
    );
  },
);
