import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  apiV1Base,
  apiV2Base,
  assertZeroHorizontalOverflow,
  injectSessionBeforeLoad,
  mintSessionTokens,
  openAccountFromSider,
  openWorkspaceNav,
  saveGeoMixScreenshot,
  type MintedSession,
} from './support/helpers';

type BrandListEnvelope = {
  code: number;
  data?: { items: Array<{ id: string; name: string }> };
};

type BrandEnvelope = {
  code: number;
  data?: { id: string; name: string; markets: Array<{ market: string }> };
};

async function resolveZeroBrandSession(
  request: APIRequestContext,
  suffix: string,
): Promise<MintedSession> {
  const demoTokens = mintSessionTokens('demo');
  const existing = await request.get(`${apiV2Base()}/brands`, {
    headers: { authorization: `Bearer ${demoTokens.accessToken}` },
  });
  if (existing.ok()) {
    const payload = (await existing.json()) as BrandListEnvelope;
    if (payload.code === 0 && (payload.data?.items.length ?? 0) === 0) {
      return demoTokens;
    }
  }

  const adminTokens = mintSessionTokens('admin');
  const username = `e2e_m1_${suffix}`.toLowerCase();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const created = await request.post(`${apiV1Base()}/admin/tenants`, {
    headers: {
      authorization: `Bearer ${adminTokens.accessToken}`,
      'idempotency-key': `e2e-m1-${suffix}`,
    },
    data: {
      name: `E2E 零品牌租户 ${suffix}`,
      username,
      password: 'GeoMix-E2E-Password-123!',
      expiresAt,
      billingMode: null,
      initialPoints: 1000,
    },
  });
  expect(created.ok(), `provision clean tenant failed: ${created.status()}`).toBeTruthy();
  return mintSessionTokens(username);
}

test('GeoMix 2.0 M1 baseline: 0-brand onboarding, Brand + CN/GLOBAL switcher sync, /account & cold-load zero-flicker', async ({
  browser,
  page,
  request,
}) => {
  const suffix = `${Date.now().toString(36).slice(-6)}`;
  const brandName = `智造激光${suffix}`;

  // Step 1: Anonymous redirect guard & login page
  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto('/home');
  await expect(anonymousPage).toHaveURL(/\/login\?next=%2Fhome/);
  await expect(anonymousPage.getByText('GeoMix 登录')).toBeVisible();
  await expect(anonymousPage.getByRole('button', { name: '点击图片更换验证码' })).toBeVisible();
  await expect(anonymousPage.locator('.gm-login-captcha-img')).toBeVisible();
  await expect(anonymousPage.getByRole('button', { name: '换一张' })).toBeVisible();
  await saveGeoMixScreenshot(anonymousPage, '01-login.png');
  await anonymousContext.close();

  // Step 2: Resolve clean 0-brand merchant session
  const activeTokens = await resolveZeroBrandSession(request, suffix);

  // Step 3: Authenticated login -> /home 0-brand onboarding state
  await injectSessionBeforeLoad(page, activeTokens);
  await page.goto('/login');
  await expect(page).toHaveURL(/\/home(?:[?#]|$)/);
  await expect(page.locator('aside.ant-layout-sider')).toContainText('GeoMix');
  await expect(page.locator('.gm-tabs')).toHaveCount(0);
  await expect(page.locator('.gm-mode')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '60 秒创建首个品牌' }).first()).toBeVisible();
  await assertZeroHorizontalOverflow(page);
  await saveGeoMixScreenshot(page, '02-home-onboarding.png');

  // Step 4: Create first brand (CN) via 60s quick-create modal
  await page.getByRole('button', { name: '60 秒创建首个品牌' }).first().click();
  const createDialog = page.getByRole('dialog', { name: '60 秒创建品牌' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('品牌名称').fill(brandName);
  await createDialog.getByLabel('所属品类').fill('工业激光设备');
  await createDialog.getByLabel('官网域名').fill('zhizao-laser.example.com');

  const createResponsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/v2/brands') && res.request().method() === 'POST',
  );
  await createDialog.getByRole('button', { name: '创建并进入工作区' }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(200);
  const createJson = (await createResponse.json()) as BrandEnvelope;
  expect(createJson.code).toBe(0);
  const createdBrandId = createJson.data?.id ?? '';
  expect(createdBrandId).not.toBe('');

  await createDialog.getByRole('button', { name: '跳过，直接进入' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.getByTestId('global-brand-switcher')).toContainText(brandName);
  await expect(page.getByTestId('global-market-switcher')).toContainText('国内');
  await expect(page.getByTestId('enable-other-market-btn')).toBeVisible();

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get('brandId')}:${url.searchParams.get('market')}`;
    })
    .toBe(`${createdBrandId}:CN`);
  await saveGeoMixScreenshot(page, '03-brand-created-cn.png');

  // Step 5: Enable GLOBAL market via + 开启另一市场
  await page.getByTestId('enable-other-market-btn').click();
  const enableDialog = page.getByRole('dialog', { name: /开启海外|开启海外市场/ });
  await expect(enableDialog).toBeVisible();
  await enableDialog.getByLabel('当地品牌名称').fill(`Zhizao Laser ${suffix}`);

  const enableResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/v2/brands/${createdBrandId}/markets/GLOBAL`) &&
      res.request().method() === 'POST',
  );
  await enableDialog.getByRole('button', { name: /^(?:开启|确认开启)$/ }).click();
  const enableResponse = await enableResponsePromise;
  expect(enableResponse.status()).toBe(200);
  const enableJson = (await enableResponse.json()) as BrandEnvelope;
  expect(enableJson.code).toBe(0);

  await expect(enableDialog).toBeHidden();
  await expect(page.getByTestId('enable-other-market-btn')).toHaveCount(0);
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get('brandId')}:${url.searchParams.get('market')}`;
    })
    .toBe(`${createdBrandId}:GLOBAL`);

  // Step 6: CN <-> GLOBAL synchronization across workspaces + reload persistence
  const navTargets: Array<{
    title: '品牌' | '诊断' | '写作' | '发布' | '首页';
    path: string;
  }> = [
    { title: '品牌', path: '/brands' },
    { title: '诊断', path: '/visibility' },
    { title: '写作', path: '/studio' },
    { title: '发布', path: '/publish' },
    { title: '首页', path: '/home' },
  ];
  for (const target of navTargets) {
    await openWorkspaceNav(page, {
      itemTitle: target.title,
      expectedUrl: new RegExp(`${target.path}(?:[?#]|$)`),
    });
    const currentUrl = new URL(page.url());
    expect(currentUrl.pathname).toBe(target.path);
    expect(currentUrl.searchParams.get('brandId')).toBe(createdBrandId);
    expect(currentUrl.searchParams.get('market')).toBe('GLOBAL');
    await assertZeroHorizontalOverflow(page);
  }

  await page.getByTestId('global-market-switcher').getByRole('button', { name: /国内/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('market')).toBe('CN');

  await page.reload();
  await expect(page.getByTestId('global-brand-switcher')).toContainText(brandName);
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.searchParams.get('brandId')}:${url.searchParams.get('market')}`;
    })
    .toBe(`${createdBrandId}:CN`);
  await saveGeoMixScreenshot(page, '04-dual-market-switcher.png');

  // Step 7: /account via sider-account-entry & controlled throttled cold-load zero-flicker check
  await openAccountFromSider(page);
  await page.getByRole('tab', { name: '账号权益' }).click();
  await expect(page.locator('.gm-right-card[aria-label="品牌数量"]')).toContainText('1 / 100');
  await expect(page.locator('.gm-right-card[aria-label="点数"]')).toContainText('1000');
  await saveGeoMixScreenshot(page, '05-account-rights.png');

  const coldContext = await browser.newContext();
  const coldPage = await coldContext.newPage();
  await injectSessionBeforeLoad(coldPage, activeTokens);

  let releasePending!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });

  await coldPage.route('**/api/v1/billing/wallet*', async (route) => {
    await gate;
    await route.continue();
  });
  await coldPage.route('**/api/v1/me/rights*', async (route) => {
    await gate;
    await route.continue();
  });

  await coldPage.goto('/account');
  await expect(coldPage.locator('.ant-skeleton, [aria-busy="true"]').first()).toBeVisible();
  const pendingText = await coldPage.evaluate(() => document.body.innerText);
  expect(pendingText).not.toMatch(/\b0\s*点\b/);
  expect(pendingText).not.toContain('免费体验期');
  expect(pendingText).not.toContain('¥0.00');

  releasePending();
  await expect(coldPage.getByTestId('header-points-pill')).toContainText('1000');
  await expect(coldPage.locator('body')).not.toContainText('¥0.00');
  await assertZeroHorizontalOverflow(coldPage);
  await coldContext.close();
});
