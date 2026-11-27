import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  consumeSsePost,
  createBrandApi,
  getTenantWallet,
  pollUntil,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
} from './v2/support/api-client';
import { assertNoConsoleOrPageErrors, assertNoHorizontalOverflow } from './v2/support/assertions';
import {
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  uniqueIdemKey,
  uniqueTag,
} from './v2/support/fixtures';
import { attachErrorCollector, createAuthenticatedContext } from './v2/support/ui-actions';

const V2_1_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1015, height: 909 },
] as const;

const WEB_BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const FIXTURE_BASE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || '3099'}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type FixtureCaptureItem = {
  id: string;
  timestamp: string;
  kind: 'shopify' | 'wordpress' | 'webflow' | 'webhook' | 'indexnow';
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: Record<string, unknown> | null;
};

type ChannelConnectionDto = {
  id: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialHint: string;
  status: string;
};

type PublishRecordSummary = {
  id: string;
  publishedUrl: string;
  channel: string;
  crawlStatus?: string;
  indexNowSubmitted?: boolean;
};

async function fetchFixtureCaptures(): Promise<FixtureCaptureItem[]> {
  const res = await fetch(`${FIXTURE_BASE}/__e2e/captures`);
  if (!res.ok) {
    throw new Error(`Failed to fetch E2E fixture captures (${res.status})`);
  }
  const json = (await res.json()) as { items?: FixtureCaptureItem[] };
  return Array.isArray(json.items) ? json.items : [];
}

async function clearFixtureCaptures(): Promise<void> {
  const res = await fetch(`${FIXTURE_BASE}/__e2e/captures`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear E2E fixture captures (${res.status})`);
  }
}

async function assertLayoutErgonomics(
  page: Page,
  opts: { checkDrawer?: boolean } = {},
): Promise<void> {
  for (const vp of V2_1_VIEWPORTS) {
    await page.setViewportSize(vp);
    await assertNoHorizontalOverflow(page, { viewports: [vp] });

    if (opts.checkDrawer) {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const body = document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-body');
              return body
                ? Math.round(body.getBoundingClientRect().right)
                : Number.POSITIVE_INFINITY;
            }),
          {
            timeout: 5_000,
            message: `Drawer did not finish sliding into viewport at ${vp.width}x${vp.height}`,
          },
        )
        .toBeLessThanOrEqual(vp.width + 2);

      const drawerOverflow = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-body');
        if (!body) return null;
        return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
      });
      if (drawerOverflow) {
        expect(
          drawerOverflow.scrollWidth,
          `.ant-drawer-open .ant-drawer-body horizontal overflow at ${vp.width}x${vp.height}`,
        ).toBeLessThanOrEqual(drawerOverflow.clientWidth + 2);
      }
    }

    // Guard against right-edge clipping on visible buttons inside main content (and open Drawer)
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ checkDrawer }) => {
              const clipped: string[] = [];
              const isElementVisible = (el: HTMLElement): boolean => {
                if (el.closest('.ant-drawer:not(.ant-drawer-open), [aria-hidden="true"]')) {
                  return false;
                }
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                let cur: HTMLElement | null = el;
                while (cur) {
                  const style = window.getComputedStyle(cur);
                  if (
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    Number.parseFloat(style.opacity || '1') === 0
                  ) {
                    return false;
                  }
                  cur = cur.parentElement;
                }
                return true;
              };

              const checkRoot = (
                root: ParentNode,
                limit: number,
                scopeLabel: string,
                skipOffscreenRight: boolean,
              ) => {
                const buttons = Array.from(root.querySelectorAll<HTMLElement>('button, .ant-btn'));
                for (const el of buttons) {
                  if (!isElementVisible(el)) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.right <= 0) continue;
                  if (skipOffscreenRight && rect.left >= window.innerWidth) continue;
                  if (rect.right > limit + 2) {
                    const label = (el.textContent || el.getAttribute('aria-label') || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .slice(0, 24);
                    clipped.push(
                      `${scopeLabel}:${el.tagName}(${label}): right=${Math.round(rect.right)} > ${Math.round(limit)}`,
                    );
                  }
                }
              };

              const mainContainer =
                document.querySelector<HTMLElement>(
                  'main, .ant-layout-content, [data-testid="pr-share-page"]',
                ) ?? document.body;
              checkRoot(mainContainer, window.innerWidth, 'main', true);

              if (checkDrawer) {
                const drawerBody = document.querySelector<HTMLElement>(
                  '.ant-drawer-open .ant-drawer-body',
                );
                if (drawerBody) {
                  const drawerRight = Math.min(
                    window.innerWidth,
                    drawerBody.getBoundingClientRect().right,
                  );
                  checkRoot(drawerBody, drawerRight, 'drawer', false);
                }
              }

              return clipped;
            },
            { checkDrawer: Boolean(opts.checkDrawer) },
          ),
        {
          timeout: 3_000,
          message: `Right-edge clipped visible buttons at ${vp.width}x${vp.height}`,
        },
      )
      .toEqual([]);

    // Guard against single-character vertical CJK wrapping on buttons, tabs & headings
    const verticalWrapOffenders = await page.evaluate(() => {
      const offenders: string[] = [];
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="tab"], h1, h2, h3, .ant-btn'),
      );
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = (el.textContent || '').replace(/\s+/g, '').trim();
        if (text.length < 3 || !/[\u4e00-\u9fff]/.test(text)) continue;
        const fontSize = Number.parseFloat(style.fontSize) || 14;
        if (rect.width < fontSize * 1.9 && rect.height > fontSize * 3.2) {
          offenders.push(
            `${el.tagName}:${text.slice(0, 12)}(${Math.round(rect.width)}x${Math.round(rect.height)})`,
          );
        }
      }
      return offenders;
    });
    expect(
      verticalWrapOffenders,
      `Single-char vertical CJK wrap at ${vp.width}x${vp.height}`,
    ).toEqual([]);
  }
  await page.setViewportSize(V2_1_VIEWPORTS[0]);
}

test.describe('GeoMix v2.1 — Global-First Distribution & Writing Closed Loop (T1-11, T2-13, Track B)', () => {
  test('Full v2.1 cross-page journey: /brands connections & SSRF -> /studio Drawer preflight/variants/publish -> incognito /share/pr/[token] -> Retest timeline & /home attribution', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 'distv21');
    const tenant = await provisionIsolatedTenant({
      prefix: 'distv21',
      billingMode: 'STRICT',
      initialPoints: 200,
    });
    const token = tenant.session.accessToken;

    // ── Step 1: Seed dual-market brand, facts & GLOBAL article with [TBD: launch price] ──
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const sse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
      token,
      idempotencyKey: uniqueIdemKey('dist-v21-art'),
      body: {
        market: 'GLOBAL',
        targetPrompt: 'Best quiet 4-bay private cloud NAS for creative studios',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      timeoutMs: 45_000,
    });
    const seededArticle = sse.complete?.article as
      { id: string; title: string; contentMarkdown: string } | undefined;
    expect(seededArticle?.id, 'Seeded GLOBAL article id must exist').toBeTruthy();
    const articleId = seededArticle!.id;

    // Inject deterministic [TBD: launch price] slot to exercise Preflight blocker -> editor recovery
    const patchedMd = `${seededArticle!.contentMarkdown}\n\n## Launch Pricing\nOfficial launch pricing starts at [TBD: launch price] for the 4-bay diskless edition.\n`;
    const patchArtRes = await requestV2(`/articles/${articleId}`, {
      method: 'PATCH',
      token,
      body: { contentMarkdown: patchedMd },
    });
    unwrapOk(patchArtRes, 'PATCH /api/v2/articles/:id');

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: V2_1_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const errorCollector = attachErrorCollector(page);

    try {
      // ── Step 2: /brands Channel Connections CRUD, Masking, Test & SSRF Rejection ──
      const webhookSecret = 'whsec_playwright_e2e_secret_987654';
      const wpAppPassword = 'wp_e2e_app_pass_123456';
      const indexNowKey = 'e2eplaywrightindexnowkey123456';

      await page.goto(`/brands?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      const connSection = page.getByTestId('brand-channel-connections');
      await expect(connSection).toBeVisible({ timeout: 20_000 });

      // 2a. Add Webhook connection
      await page.getByTestId('add-channel-connection-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeVisible();
      await page.getByTestId('channel-provider-select').click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option', {
          hasText: '通用签名 Webhook',
        })
        .click();
      await page.getByLabel('连接名称').fill('E2E Webhook');
      await page.getByLabel('站点地址').fill('https://webhook.e2e.example/webhook/publish');
      await page.getByLabel('Webhook 签名密钥').fill(webhookSecret);
      await page.getByLabel('IndexNow Key').fill(indexNowKey);
      await page.getByTestId('channel-connection-submit-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeHidden();

      // 2b. Add WordPress connection
      await page.getByTestId('add-channel-connection-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeVisible();
      await page.getByTestId('channel-provider-select').click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option', {
          hasText: 'WordPress 站点',
        })
        .click();
      await page.getByLabel('连接名称').fill('E2E WordPress');
      await page.getByLabel('站点地址').fill('https://wp.e2e.example');
      await page.getByLabel('WordPress 用户名').fill('editor');
      await page.getByLabel('WordPress Application Password').fill(wpAppPassword);
      await page.getByTestId('channel-connection-submit-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeHidden();

      // Fetch created connection IDs via API & assert zero plaintext secrets in DOM
      const connListRes = await requestV2<{ items: ChannelConnectionDto[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      );
      const connections = unwrapOk(connListRes, 'GET connections').items;
      const webhookConn = connections.find((c) => c.displayName === 'E2E Webhook');
      const wpConn = connections.find((c) => c.displayName === 'E2E WordPress');
      expect(webhookConn?.id).toBeTruthy();
      expect(wpConn?.id).toBeTruthy();

      const webhookCard = page.getByTestId(`channel-connection-card-${webhookConn!.id}`);
      const wpCard = page.getByTestId(`channel-connection-card-${wpConn!.id}`);
      await expect(webhookCard).toContainText('****');
      await expect(wpCard).toContainText('****');

      const brandsBodyText = await page.locator('body').innerText();
      expect(brandsBodyText).not.toContain(webhookSecret);
      expect(brandsBodyText).not.toContain(wpAppPassword);

      // Test both connections via UI buttons (verify transition from 尚未测试 -> tested & 已连接)
      await expect(webhookCard).toContainText('尚未测试');
      await page.getByTestId(`channel-connection-test-btn-${webhookConn!.id}`).click();
      await expect(webhookCard).not.toContainText('尚未测试', { timeout: 15_000 });
      await expect(webhookCard).toContainText('已连接');

      await expect(wpCard).toContainText('尚未测试');
      await page.getByTestId(`channel-connection-test-btn-${wpConn!.id}`).click();
      await expect(wpCard).not.toContainText('尚未测试', { timeout: 15_000 });
      await expect(wpCard).toContainText('已连接');

      // Assert 0 errors before intentional SSRF 400 negative test
      assertNoConsoleOrPageErrors(errorCollector);

      // 2c. SSRF Negative Check in /brands Modal (`http://127.0.0.1` rejected by server with HTTP 400!)
      await page.getByTestId('add-channel-connection-btn').click();
      await expect(page.getByTestId('channel-connection-modal')).toBeVisible();
      await page.getByTestId('channel-provider-select').click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option', {
          hasText: '通用签名 Webhook',
        })
        .click();
      await page.getByLabel('连接名称').fill('SSRF Loopback Test');
      await page.getByLabel('站点地址').fill('http://127.0.0.1/ssrf-blocked');
      await page.getByLabel('Webhook 签名密钥').fill('whsec_ssrf_probe_12345678');
      await page.getByTestId('channel-connection-submit-btn').click();
      await expect(
        page.getByTestId('channel-connection-modal').locator('.ant-alert-error'),
      ).toContainText('站点地址不允许访问');
      await page
        .locator('.ant-modal-content:visible .ant-modal-footer')
        .getByRole('button', { name: '取消' })
        .click();
      await expect(page.getByTestId('channel-connection-modal')).toBeHidden();
      // Chromium logs expected `Failed to load resource: ... status of 400` on intentional 400 SSRF test
      const unexpectedSsrfErrors = errorCollector.errors.filter(
        (e) => !e.includes('status of 400'),
      );
      expect(unexpectedSsrfErrors).toEqual([]);
      errorCollector.errors.length = 0;

      // Check /brands ergonomics at 1440×900 & 1015×909
      await assertLayoutErgonomics(page);

      // ── Step 3: /studio -> /publish Inline Distribution Workbench — Preflight Block -> Fix -> Variants + Confirm -> Context-Switch -> Live Publish ──
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('studio-go-publish-btn')).toBeEnabled({
        timeout: 20_000,
      });

      await page.getByTestId('studio-go-publish-btn').click();
      await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });
      await expect(page.getByTestId('publish-distribution-workbench')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('distribution-preflight-blockers')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('distribution-preflight-blockers')).toContainText(
        'launch price',
      );

      // Verify /publish inline Distribution ergonomics at BOTH 1440×900 and 1015×909
      await assertLayoutErgonomics(page);

      // Click "返回编辑器定位补填" -> navigates to /studio -> fill inline missing-fact pill!
      await page.getByTestId('distribution-back-to-editor-btn').click();
      await expect(page).toHaveURL(/\/studio/, { timeout: 15_000 });

      const missingPill = page.getByTestId('missing-fact-pill').first();
      await expect(missingPill).toBeVisible({ timeout: 10_000 });
      await missingPill.click();
      await page.locator('textarea[placeholder="输入真实实测数值或参数"]').fill('$599 MSRP');
      await page.getByRole('button', { name: '确认填入' }).click();
      await expect(page.getByTestId('missing-fact-pill')).toHaveCount(0, { timeout: 15_000 });

      // Navigate to /publish -> Preflight blockers gone!
      await page.getByTestId('studio-go-publish-btn').click();
      await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });
      await expect(page.getByTestId('publish-distribution-workbench')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('distribution-preflight-card')).toBeVisible();
      await expect(page.getByTestId('distribution-preflight-blockers')).toBeHidden({
        timeout: 15_000,
      });

      const walletBeforeGen = (await getTenantWallet(tenant.session)).points;

      // Select L1 Webhook + L3 PR Packet -> Generate Variants -> Points Confirm Modal
      await page.getByTestId(`distribution-target-l1:${webhookConn!.id}`).click();
      await page.getByTestId('distribution-target-PR_PACKET').click();
      await page.getByTestId('distribution-generate-variants-btn').click();

      const confirmModal = page.getByTestId('distribution-points-confirm-modal');
      await expect(confirmModal).toBeVisible();
      await expect(confirmModal).toContainText('2 × 2 = 4 点');

      await page.getByTestId('distribution-points-confirm-submit-btn').click();
      await expect(confirmModal).toBeHidden({ timeout: 25_000 });

      const variantTabs = page.getByTestId('distribution-variant-tabs');
      await expect(variantTabs).toBeVisible({ timeout: 25_000 });
      await expect(variantTabs.getByRole('tab', { name: /E2E Webhook/ })).toBeVisible({
        timeout: 25_000,
      });
      await expect(variantTabs.getByRole('tab', { name: /PR|媒体/ })).toBeVisible({
        timeout: 25_000,
      });

      await expect
        .poll(async () => (await getTenantWallet(tenant.session)).points, { timeout: 15_000 })
        .toBe(walletBeforeGen - 4);
      const walletAfterGen = (await getTenantWallet(tenant.session)).points;
      await expect(page.getByTestId('header-points-pill')).toContainText(`${walletAfterGen}`, {
        timeout: 15_000,
      });

      // Context-switch isolation on /publish clears stale articleId (#364)
      await page
        .getByTestId('global-market-switcher')
        .getByRole('button', { name: /国内/ })
        .click();
      await expect(page).toHaveURL(/market=CN/);
      // Issue #364: switching market clears stale articleId from URL
      expect(new URL(page.url()).searchParams.get('articleId')).toBeNull();

      // Return to GLOBAL article on /publish, reload browser (#364), and verify selection & variants remain ready
      await page.goto(
        `/publish?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}&tab=distribute`,
        {
          waitUntil: 'domcontentloaded',
        },
      );
      await expect(page.getByTestId('publish-distribution-workbench')).toBeVisible({
        timeout: 20_000,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('publish-distribution-workbench')).toBeVisible({
        timeout: 20_000,
      });
      expect(new URL(page.url()).searchParams.get('articleId')).toBe(articleId);
      await expect(page.getByTestId('distribution-variant-tabs')).toBeVisible({
        timeout: 15_000,
      });

      await clearFixtureCaptures();
      await page
        .getByTestId('distribution-variant-tabs')
        .getByRole('tab', { name: /E2E Webhook/ })
        .click();
      await page.getByTestId('distribution-publish-live-btn').click();

      // Poll UI cleanly (no waitForTimeout) until BullMQ 'distribution' finishes -> 已上线
      await expect(
        page.getByTestId('distribution-variant-tabs').getByRole('tab', { name: /E2E Webhook/ }),
      ).toContainText('已上线', { timeout: 30_000 });

      // Verify captured Webhook HMAC-SHA256 & IndexNow payloads from e2e-backend.cjs
      const captures = await pollUntil(
        fetchFixtureCaptures,
        (items) =>
          items.some((c) => c.kind === 'webhook') && items.some((c) => c.kind === 'indexnow'),
        { timeoutMs: 15_000, intervalMs: 300, label: 'webhook + indexnow captures' },
      );
      const whCapture = captures.find((c) => c.kind === 'webhook')!;
      const expectedSig = `sha256=${createHmac('sha256', webhookSecret).update(whCapture.rawBody).digest('hex')}`;
      expect(whCapture.headers['x-geomix-signature']).toBe(expectedSig);
      expect(whCapture.headers['x-geomix-delivery-id']).toBeTruthy();

      const indexNowCapture = captures.find((c) => c.kind === 'indexnow')!;
      expect(indexNowCapture.parsedBody?.key).toBe(indexNowKey);
      expect(JSON.stringify(indexNowCapture.parsedBody?.urlList)).toContain(
        'https://crawl-ok.e2e.example/articles/',
      );

      // ── Step 4: Issue 30-day PR Share Link & Open in Separate Incognito Context ──
      await page
        .getByTestId('distribution-variant-tabs')
        .getByRole('tab', { name: /PR|媒体/ })
        .click();
      await page.getByTestId('distribution-pr-share-btn').click();
      const shareUrlEl = page.getByTestId('distribution-pr-share-url');
      await expect(shareUrlEl).toBeVisible({ timeout: 15_000 });
      const shareUrl = (await shareUrlEl.innerText()).trim();
      expect(shareUrl).toMatch(new RegExp(`^${escapeRegExp(WEB_BASE)}/share/pr/[A-Za-z0-9_-]+$`));

      // Separate incognito context (ZERO tokens, ZERO cookies)
      const incognitoCtx = await browser.newContext({ viewport: V2_1_VIEWPORTS[0] });
      const incognitoPage = await incognitoCtx.newPage();
      const incognitoErrors = attachErrorCollector(incognitoPage);
      const forbiddenApiHits: string[] = [];
      const authStatusHits: string[] = [];
      const serverErrorHits: string[] = [];
      let publicPrJsonBody = '';

      incognitoPage.on('request', (req) => {
        const url = req.url();
        if (
          /\/api\/v1\/(account|billing|announcements|auth\/refresh)/.test(url) ||
          /\/api\/v2\/brands/.test(url)
        ) {
          forbiddenApiHits.push(`${req.method()} ${url}`);
        }
      });
      incognitoPage.on('response', async (res) => {
        const url = res.url();
        const st = res.status();
        if (st === 401 || st === 403) authStatusHits.push(`${st} ${url}`);
        if (st >= 500) serverErrorHits.push(`${st} ${url}`);
        if (url.includes('/api/v2/public/pr-packets/') && st === 200) {
          publicPrJsonBody = await res.text().catch(() => '');
        }
      });

      try {
        await incognitoPage.goto(shareUrl, { waitUntil: 'domcontentloaded' });
        await expect(incognitoPage.getByTestId('pr-share-page')).toBeVisible({
          timeout: 20_000,
        });
        await expect(incognitoPage.getByTestId('pr-share-fact-table')).toBeVisible();
        await expect(incognitoPage.getByTestId('pr-share-submit-form')).toBeVisible();

        // Assert EN (GLOBAL) copy, zero ConsoleShell chrome, no /login redirect, zero CJK in header (#366)
        await expect(incognitoPage.getByTestId('pr-share-page')).toContainText(
          'PR / KOL Collaboration Brief',
        );
        await expect(incognitoPage.getByTestId('pr-share-page')).toContainText(
          'Brand Overview & Verified Core Facts',
        );
        const incognitoHeaderText = await incognitoPage.locator('header').innerText();
        expect(incognitoHeaderText).toContain('PR / KOL Media Kit');
        expect(/[\u4E00-\u9FFF]/.test(incognitoHeaderText)).toBe(false);
        expect(incognitoPage.url()).toContain('/share/pr/');
        expect(incognitoPage.url()).not.toContain('/login');
        await expect
          .poll(() => incognitoPage.evaluate(() => document.documentElement.lang))
          .toBe('en');
        await expect(incognitoPage.getByTestId('global-brand-switcher')).toHaveCount(0);
        await expect(incognitoPage.getByTestId('header-points-pill')).toHaveCount(0);

        // Assert zero auth failures, zero 5xx, zero authenticated API hits, zero tenant PII
        expect(authStatusHits).toEqual([]);
        expect(serverErrorHits).toEqual([]);
        expect(forbiddenApiHits).toEqual([]);
        const incognitoDomText = await incognitoPage.locator('body').innerText();
        for (const privateField of [
          tenant.tenantId,
          tenant.username,
          'credentialsCiphertext',
          'shareTokenHash',
        ]) {
          expect(publicPrJsonBody).not.toContain(privateField);
          expect(incognitoDomText).not.toContain(privateField);
        }

        // Check incognito layout ergonomics at 1440×900 & 1015×909
        await assertLayoutErgonomics(incognitoPage);

        // Submit published URL via incognito PR page
        await incognitoPage
          .getByTestId('pr-share-url-input')
          .fill('https://crawl-ok.e2e.example/articles/pr-review-1');
        await incognitoPage
          .getByTestId('pr-share-note-input')
          .fill('Published live on Tech Review');
        await incognitoPage.getByTestId('pr-share-submit-btn').click();
        await expect(incognitoPage.getByTestId('pr-share-receipt')).toBeVisible({
          timeout: 15_000,
        });
        await expect(incognitoPage.getByTestId('pr-share-receipt')).toContainText(
          'Published URL Recorded',
        );

        assertNoConsoleOrPageErrors(incognitoErrors);

        // Verify nonexistent token renders friendly error state with zero /login redirect
        const invalidPage = await incognitoCtx.newPage();
        await invalidPage.goto(`${WEB_BASE}/share/pr/nonexistent_token_12345678`, {
          waitUntil: 'domcontentloaded',
        });
        await expect(invalidPage.getByTestId('pr-share-error-state')).toBeVisible({
          timeout: 15_000,
        });
        await expect(invalidPage.getByTestId('pr-share-error-state')).toContainText(
          'Collaboration Link Unavailable',
        );
        expect(invalidPage.url()).toContain('/share/pr/');
        expect(invalidPage.url()).not.toContain('/login');
        await invalidPage.close();
      } finally {
        await incognitoCtx.close();
      }

      // ── Step 4b (T2-13): CN (zh-CN) /share/pr/[token] Incognito Locale Verification ──
      const cnSse = await consumeSsePost(`/brands/${brand.id}/articles/stream`, {
        token,
        idempotencyKey: uniqueIdemKey('dist-v21-cn-art'),
        body: {
          market: 'CN',
          targetPrompt: '静音四盘位家用私有云 NAS 实测选购指南',
          recipe: 'AUTHORITY_GUIDE',
          targetFormat: 'CN_DEEP_REVIEW',
        },
        timeoutMs: 45_000,
      });
      const cnArticle = cnSse.complete?.article as { id: string } | undefined;
      expect(cnArticle?.id, 'Seeded CN article id must exist').toBeTruthy();

      const cnVarRes = await requestV2<{ tasks: Array<{ id: string }> }>(
        `/articles/${cnArticle!.id}/distributions/variants`,
        {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': uniqueIdemKey('dist-v21-cn-pr') },
          body: {
            targets: [
              {
                provider: 'PR_PACKET',
                channelLabel: '国内科技媒体协作包',
              },
            ],
          },
        },
      );
      const cnPrTaskId = unwrapOk(cnVarRes, 'POST CN PR_PACKET variant').tasks[0]?.id;
      expect(cnPrTaskId, 'CN PR_PACKET task id must exist').toBeTruthy();

      const cnShareRes = await requestV2<{ shareUrl: string; token: string }>(
        `/distributions/${cnPrTaskId}/pr-share`,
        {
          method: 'POST',
          token,
          body: { ttlDays: 30 },
        },
      );
      const cnShareUrl = unwrapOk(cnShareRes, 'POST CN pr-share').shareUrl;
      expect(cnShareUrl).toMatch(new RegExp(`^${escapeRegExp(WEB_BASE)}/share/pr/[A-Za-z0-9_-]+$`));

      const cnIncognitoCtx = await browser.newContext({ viewport: V2_1_VIEWPORTS[0] });
      const cnPage = await cnIncognitoCtx.newPage();
      const cnErrors = attachErrorCollector(cnPage);
      const cnForbiddenApiHits: string[] = [];
      const cnAuthStatusHits: string[] = [];
      const cnServerErrorHits: string[] = [];

      cnPage.on('request', (req) => {
        const url = req.url();
        if (
          /\/api\/v1\/(account|billing|announcements|auth\/refresh)/.test(url) ||
          /\/api\/v2\/brands/.test(url)
        ) {
          cnForbiddenApiHits.push(`${req.method()} ${url}`);
        }
      });
      cnPage.on('response', (res) => {
        const url = res.url();
        const st = res.status();
        if (st === 401 || st === 403) cnAuthStatusHits.push(`${st} ${url}`);
        if (st >= 500) cnServerErrorHits.push(`${st} ${url}`);
      });

      try {
        await cnPage.goto(cnShareUrl, { waitUntil: 'domcontentloaded' });
        await expect(cnPage.getByTestId('pr-share-page')).toBeVisible({ timeout: 20_000 });
        await expect(cnPage.getByTestId('pr-share-fact-table')).toBeVisible();
        await expect(cnPage.getByTestId('pr-share-submit-form')).toBeVisible();

        // Assert CN (zh-CN) UI copy, lang attribute, zero ConsoleShell chrome, no /login redirect
        await expect(cnPage.getByTestId('pr-share-page')).toContainText('PR / KOL 外部协作包');
        await expect(cnPage.getByTestId('pr-share-page')).toContainText(
          '品牌概览与已验证核心事实参数表',
        );
        await expect(cnPage.getByTestId('pr-share-page')).toContainText('国内市场（CN）');
        await expect.poll(() => cnPage.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
        expect(cnPage.url()).toContain('/share/pr/');
        expect(cnPage.url()).not.toContain('/login');
        await expect(cnPage.getByTestId('global-brand-switcher')).toHaveCount(0);
        await expect(cnPage.getByTestId('header-points-pill')).toHaveCount(0);

        expect(cnAuthStatusHits).toEqual([]);
        expect(cnServerErrorHits).toEqual([]);
        expect(cnForbiddenApiHits).toEqual([]);

        await assertLayoutErgonomics(cnPage);
        assertNoConsoleOrPageErrors(cnErrors);
      } finally {
        await cnIncognitoCtx.close();
      }

      // ── Step 5: /publish Retest Timeline, PRD D3 Budget Ceiling, Crawl Badges & /home Attribution (PRD D5) ──
      await page.goto(
        `/publish?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}&tab=tracking`,
        {
          waitUntil: 'domcontentloaded',
        },
      );
      await expect(page.getByTestId('studio-publish-retest')).toBeVisible({ timeout: 20_000 });

      // Verify PRD D3 form budget ceiling & auto-retest checkbox
      await expect(page.getByTestId('publish-auto-retest-checkbox')).toBeChecked();
      await expect(page.getByTestId('publish-form-budget-ceiling')).toContainText('预计预算上限');

      // Fetch synced GeoPublishRecords (should include both Webhook live publish & PR submit)
      const pubListRes = await requestV2<{ items: PublishRecordSummary[] }>(
        `/articles/${articleId}/publish-records`,
        { token },
      );
      const records = unwrapOk(pubListRes, 'GET article publish-records').items;
      expect(records.length).toBeGreaterThanOrEqual(2);
      const webhookRec = records.find((r) => r.indexNowSubmitted === true);
      expect(
        webhookRec,
        'Webhook live publish record with indexNowSubmitted=true must exist',
      ).toBeTruthy();
      expect(webhookRec!.indexNowSubmitted).toBe(true);

      // Trigger 0-pt manual CrawlProbe via UI -> assert badges (200, GPTBot, JSON-LD, IndexNow)
      const badges = page.getByTestId(`publish-crawl-badges-${webhookRec!.id}`);
      await expect(badges).toBeVisible();
      await page.getByTestId(`publish-crawl-recheck-btn-${webhookRec!.id}`).click();
      await expect(badges).toContainText('可抓取', { timeout: 15_000 });
      await expect(badges).toContainText('HTTP 200');
      await expect(badges).toContainText('GPTBot 允许');
      await expect(badges).toContainText('JSON-LD: Article');
      await expect(badges).toContainText('JSON-LD: FAQPage');
      await expect(badges).toContainText('IndexNow 已提交');

      // Verify T+0 -> T+7 -> T+14 -> T+30 timeline & PRD D3 per-record budget ceiling toggling 1 vs 3 samples
      const timeline = page.getByTestId(`publish-retest-timeline-${webhookRec!.id}`);
      await expect(timeline).toBeVisible();
      await expect(timeline).toContainText('T+0 基准');
      await expect(page.getByTestId(`publish-retest-node-${webhookRec!.id}-T7`)).toBeVisible();
      await expect(page.getByTestId(`publish-retest-node-${webhookRec!.id}-T14`)).toBeVisible();
      await expect(page.getByTestId(`publish-retest-node-${webhookRec!.id}-T30`)).toBeVisible();

      const budgetBox = page.getByTestId(`publish-retest-budget-${webhookRec!.id}`);
      await expect(budgetBox).toContainText('1 次采样');
      await page
        .getByTestId(`publish-retest-sample-toggle-${webhookRec!.id}`)
        .getByRole('button', { name: '3 次高置信' })
        .click();
      await expect(budgetBox).toContainText('3 次采样', { timeout: 15_000 });

      // Verify demoted instant retest button & 7–14 day gentle hint
      await expect(page.getByTestId('publish-retest-btn')).toBeVisible();
      await expect(page.getByTestId('studio-publish-retest')).toContainText(
        '新发内容通常需 7–14 天进入 AI 检索',
      );

      // Verify /studio Retest Timeline & Crawl Badges ergonomics at BOTH 1440×900 and 1015×909
      await assertLayoutErgonomics(page);

      // Register a GPTBot-blocked URL & probe it so /home displays a real Crawl Alert!
      const blockedPubRes = await requestV2<PublishRecordSummary>(
        `/articles/${articleId}/publish-records`,
        {
          method: 'POST',
          token,
          body: {
            publishedUrl: 'https://crawl-blocked.e2e.example/articles/blocked-1',
            channel: 'Blocked Media',
            autoRetest: { enabled: true },
          },
        },
      );
      const blockedRec = unwrapOk(blockedPubRes, 'POST blocked publish-record');
      const blockedProbeRes = await requestV2(`/publish-records/${blockedRec.id}/crawl-probe`, {
        method: 'POST',
        token,
      });
      unwrapOk(blockedProbeRes, 'POST crawl-probe on blocked URL');

      // Navigate to /home -> verify distributionSummary, crawlAlerts, upcomingRetests, channelAttribution (PRD D5, zero NaN)
      await page.goto(`/home?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      const homeSummary = page.getByTestId('home-distribution-summary');
      await expect(homeSummary).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('home-crawl-alerts')).toBeVisible();
      await expect(page.getByTestId(`home-crawl-alert-${blockedRec.id}`)).toContainText('抓取受阻');
      await expect(page.getByTestId('home-upcoming-retests')).toBeVisible();
      await expect(page.getByTestId('home-channel-attribution')).toBeVisible();
      expect(await homeSummary.innerText()).not.toContain('NaN');

      // Verify /home layout ergonomics at BOTH 1440×900 and 1015×909
      await assertLayoutErgonomics(page);

      assertNoConsoleOrPageErrors(errorCollector);
    } finally {
      await context.close();
    }
  });
});
