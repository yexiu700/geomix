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

const FIXTURE_BASE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || '3099'}`;

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
      const drawerOverflow = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>('.ant-drawer-body');
        if (!body) return null;
        return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
      });
      if (drawerOverflow) {
        expect(
          drawerOverflow.scrollWidth,
          `.ant-drawer-body horizontal overflow at ${vp.width}x${vp.height}`,
        ).toBeLessThanOrEqual(drawerOverflow.clientWidth + 2);
      }
    }

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

      // Test both connections via UI buttons
      await page.getByTestId(`channel-connection-test-btn-${webhookConn!.id}`).click();
      await expect(webhookCard).toContainText('已连接');
      await page.getByTestId(`channel-connection-test-btn-${wpConn!.id}`).click();
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
      await page.locator('.ant-modal-footer').getByRole('button', { name: '取消' }).click();
      await expect(page.getByTestId('channel-connection-modal')).toBeHidden();
      // Chromium logs expected `Failed to load resource: ... status of 400` on intentional 400 SSRF test
      const unexpectedSsrfErrors = errorCollector.errors.filter(
        (e) => !e.includes('status of 400'),
      );
      expect(unexpectedSsrfErrors).toEqual([]);
      errorCollector.errors.length = 0;

      // Check /brands ergonomics at 1440×900 & 1015×909
      await assertLayoutErgonomics(page);

      // ── Step 3: /studio Distribution Drawer — Preflight Block -> Fix -> Variants + Confirm -> Context-Switch -> Live Publish ──
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('studio-open-distribution-btn')).toBeEnabled({
        timeout: 20_000,
      });

      await page.getByTestId('studio-open-distribution-btn').click();
      await expect(page.getByTestId('studio-distribution-drawer')).toBeVisible();
      await expect(page.getByTestId('distribution-preflight-blockers')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('distribution-preflight-blockers')).toContainText(
        'launch price',
      );

      // Verify Drawer ergonomics at BOTH 1440×900 and 1015×909
      await assertLayoutErgonomics(page, { checkDrawer: true });

      // Click "返回编辑器定位补填" -> Drawer closes -> fill inline missing-fact pill!
      await page.getByTestId('distribution-back-to-editor-btn').click();
      await expect(page.getByTestId('studio-distribution-drawer')).toBeHidden();

      const missingPill = page.getByTestId('missing-fact-pill').first();
      if (await missingPill.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await missingPill.click();
        await page.locator('textarea[placeholder="输入真实实测数值或参数"]').fill('$599 MSRP');
        await page.getByRole('button', { name: '确认填入' }).click();
        await expect(page.getByTestId('missing-fact-pill')).toHaveCount(0, { timeout: 15_000 });
      } else {
        await page.getByText('编辑 Markdown').click();
        const editorArea = page.getByLabel('文章 Markdown 正文');
        const currentMd = await editorArea.inputValue();
        await editorArea.fill(currentMd.replace(/\[TBD:\s*launch price\]/gi, '$599 MSRP'));
        await page.getByTestId('studio-save-article-btn').click();
        await expect(page.getByTestId('studio-save-article-btn')).toBeDisabled({
          timeout: 15_000,
        });
      }

      // Re-open Drawer -> Preflight blockers gone!
      await page.getByTestId('studio-open-distribution-btn').click();
      await expect(page.getByTestId('studio-distribution-drawer')).toBeVisible();
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
      await expect(variantTabs.getByRole('tab', { name: /E2E Webhook/ })).toBeVisible();

      const walletAfterGen = (await getTenantWallet(tenant.session)).points;
      expect(walletAfterGen).toBe(walletBeforeGen - 4);
      await expect(page.getByTestId('header-points-pill')).toContainText(`${walletAfterGen}`);

      // Context-switch isolation while Drawer is open (dispatchEvent avoids .ant-drawer-mask interception)
      await page
        .getByTestId('global-market-switcher')
        .getByRole('button', { name: /国内/ })
        .dispatchEvent('click');
      await expect(page.getByTestId('studio-distribution-drawer')).toBeHidden({
        timeout: 10_000,
      });
      await expect(page).toHaveURL(/market=CN/);

      // Return to GLOBAL article & trigger L1 live publish on Webhook
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-open-distribution-btn')).toBeEnabled({
        timeout: 20_000,
      });
      await page.getByTestId('studio-open-distribution-btn').click();
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
      expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:3000\/share\/pr\/[A-Za-z0-9_-]+$/);

      // Close drawer on authenticated page before incognito check
      await page.getByRole('button', { name: '关闭分发工作台' }).click();
      await expect(page.getByTestId('studio-distribution-drawer')).toBeHidden();

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

        // Assert EN (GLOBAL) copy, zero ConsoleShell chrome, no /login redirect
        await expect(incognitoPage.getByTestId('pr-share-page')).toContainText(
          'PR / KOL Collaboration Brief',
        );
        await expect(incognitoPage.getByTestId('pr-share-page')).toContainText(
          'Brand Overview & Verified Core Facts',
        );
        expect(incognitoPage.url()).toContain('/share/pr/');
        expect(incognitoPage.url()).not.toContain('/login');
        expect(await incognitoPage.evaluate(() => document.documentElement.lang)).toBe('en');
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
        await invalidPage.goto('http://127.0.0.1:3000/share/pr/nonexistent_token_12345678', {
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

      // ── Step 5: /studio Retest Timeline, PRD D3 Budget Ceiling, Crawl Badges & /home Attribution (PRD D5) ──
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${articleId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-publish-retest')).toBeVisible({ timeout: 20_000 });

      // Verify PRD D3 form budget ceiling & auto-retest checkbox
      await expect(page.getByTestId('publish-auto-retest-checkbox')).toBeChecked();
      await expect(page.getByTestId('publish-form-budget-ceiling')).toContainText('预计预算上限');

      // Fetch synced GeoPublishRecords (should include both Webhook live publish & PR submit)
      const artDetailRes = await requestV2<{ publishRecords?: PublishRecordSummary[] }>(
        `/articles/${articleId}`,
        { token },
      );
      const records = unwrapOk(artDetailRes, 'GET article detail').publishRecords ?? [];
      expect(records.length).toBeGreaterThanOrEqual(2);
      const webhookRec = records.find((r) => r.indexNowSubmitted) ?? records[0]!;

      // Trigger 0-pt manual CrawlProbe via UI -> assert badges (200, GPTBot, JSON-LD, IndexNow)
      const badges = page.getByTestId(`publish-crawl-badges-${webhookRec.id}`);
      await expect(badges).toBeVisible();
      await page.getByTestId(`publish-crawl-recheck-btn-${webhookRec.id}`).click();
      await expect(badges).toContainText('可抓取', { timeout: 15_000 });
      await expect(badges).toContainText('HTTP 200');
      await expect(badges).toContainText('GPTBot 允许');
      await expect(badges).toContainText('JSON-LD: Article');
      await expect(badges).toContainText('JSON-LD: FAQPage');
      if (webhookRec.indexNowSubmitted) {
        await expect(badges).toContainText('IndexNow 已提交');
      }

      // Verify T+0 -> T+7 -> T+14 -> T+30 timeline & PRD D3 per-record budget ceiling toggling 1 vs 3 samples
      const timeline = page.getByTestId(`publish-retest-timeline-${webhookRec.id}`);
      await expect(timeline).toBeVisible();
      await expect(timeline).toContainText('T+0 基准');
      await expect(page.getByTestId(`publish-retest-node-${webhookRec.id}-T7`)).toBeVisible();
      await expect(page.getByTestId(`publish-retest-node-${webhookRec.id}-T14`)).toBeVisible();
      await expect(page.getByTestId(`publish-retest-node-${webhookRec.id}-T30`)).toBeVisible();

      const budgetBox = page.getByTestId(`publish-retest-budget-${webhookRec.id}`);
      await expect(budgetBox).toContainText('1 次采样');
      await page
        .getByTestId(`publish-retest-sample-toggle-${webhookRec.id}`)
        .getByRole('button', { name: '3 次高置信' })
        .click();
      await expect(budgetBox).toContainText('3 次采样', { timeout: 15_000 });

      // Verify demoted instant retest button & 7–14 day gentle hint
      await expect(page.getByTestId('publish-retest-btn')).toBeVisible();
      await expect(page.getByTestId('studio-publish-retest')).toContainText(
        '新发内容通常需 7–14 天进入 AI 检索',
      );

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
