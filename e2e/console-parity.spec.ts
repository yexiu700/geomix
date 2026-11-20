import { expect, test } from '@playwright/test';
import {
  assertZeroHorizontalOverflow,
  injectSessionBeforeLoad,
  mintSessionTokens,
  openAccountFromSider,
  openWorkspaceNav,
} from './support/helpers';

test.describe('GeoMix 2.0 Minimalist Shell Parity & Admin Baseline', () => {
  test('legacy v1 console & /user/* routes 307 redirect to the 5 v2 workspaces', async ({
    request,
  }) => {
    const cases: Array<[string, string]> = [
      ['/dashboard', '/home'],
      ['/visibility/overview', '/visibility'],
      ['/visibility/monitors', '/visibility'],
      ['/me/points', '/account'],
      ['/me/rights', '/account'],
      ['/me/verify', '/account'],
      ['/me/money', '/account'],
      ['/user/dashboard', '/home'],
      ['/user/company_keyword', '/brands'],
      ['/user/images_type/index/type/1', '/brands'],
      ['/user/zhiling', '/studio'],
      ['/user/ai_task', '/studio'],
      ['/user/weixin_baowen', '/studio'],
      ['/user/piliang_baowen', '/studio'],
      ['/user/user_score_log', '/account'],
      ['/user/quanyi', '/account'],
    ];

    for (const [legacy, expectedPath] of cases) {
      const response = await request.get(legacy, { maxRedirects: 0 });
      expect(response.status(), `status for ${legacy}`).toBe(307);
      const location = response.headers().location ?? '';
      const resolved = new URL(location, 'http://127.0.0.1:3000');
      expect(resolved.pathname, `redirect target for ${legacy}`).toBe(expectedPath);
    }
  });

  test('flat 4+1 sidebar navigation, zero legacy shell chrome, ⌘K palette, and zero overflow', async ({
    page,
  }) => {
    const demoTokens = mintSessionTokens('demo');
    await injectSessionBeforeLoad(page, demoTokens);
    await page.goto('/home');
    await expect(page).toHaveURL(/\/home(?:[?#]|$)/);

    const sider = page.locator('aside.ant-layout-sider');
    await expect(sider).toBeVisible();
    await expect(sider.locator('.ant-menu-submenu')).toHaveCount(0);
    await expect(page.locator('.gm-tabs')).toHaveCount(0);
    await expect(page.locator('.gm-draft-note')).toHaveCount(0);
    await expect(page.locator('.gm-mode')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '布局', exact: true })).toHaveCount(0);
    await expect(page.getByText('余额明细')).toHaveCount(0);

    await openWorkspaceNav(page, {
      itemTitle: '品牌资产',
      expectedUrl: /\/brands(?:[?#]|$)/,
    });
    await openWorkspaceNav(page, {
      itemTitle: '可见度诊断',
      expectedUrl: /\/visibility(?:[?#]|$)/,
    });
    await openWorkspaceNav(page, {
      itemTitle: 'GEO 写作台',
      expectedUrl: /\/studio(?:[?#]|$)/,
    });
    await openWorkspaceNav(page, {
      itemTitle: '行动首页',
      expectedUrl: /\/home(?:[?#]|$)/,
    });

    await assertZeroHorizontalOverflow(page);

    await page.getByRole('button', { name: '打开指令面板' }).click();
    await expect(page.getByRole('textbox', { name: '搜索页面或操作' })).toBeVisible();
    const listbox = page.getByRole('listbox', { name: '指令列表' });
    await expect(listbox).toBeVisible();

    for (const routePath of ['/home', '/brands', '/visibility', '/studio', '/account']) {
      await expect(listbox.getByRole('option', { name: new RegExp(routePath) })).toHaveCount(1);
    }
    for (const removedPath of [
      '/dashboard',
      '/image',
      '/me/money',
      '/material/keywords',
      '/rewrite/single',
    ]) {
      await expect(listbox.getByRole('option', { name: new RegExp(removedPath) })).toHaveCount(0);
    }

    await page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
  });

  test('bottom-left sider-account-entry opens 3-tab /account without ¥0.00 and submits verification', async ({
    page,
  }) => {
    const demoTokens = mintSessionTokens('demo');
    await injectSessionBeforeLoad(page, demoTokens);
    await page.goto('/home');
    await openAccountFromSider(page);

    await expect(page.getByRole('tab', { name: '点数明细' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '账号权益' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '实名认证' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '余额明细' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('¥0.00');

    await page.getByRole('tab', { name: '账号权益' }).click();
    await expect(page.locator('.gm-right-card[aria-label="品牌数量"]')).toBeVisible();
    await expect(page.locator('.gm-right-card[aria-label="点数"]')).toContainText('1000');
    await expect(page.locator('.gm-right-card[aria-label="DeepSeek"]')).toBeVisible();
    await expect(page.locator('.gm-right-card[aria-label="豆包"]')).toBeVisible();

    await page.getByRole('tab', { name: '实名认证' }).click();
    await expect(page.getByRole('textbox', { name: '主体名称' })).toBeVisible();
    await page.getByRole('textbox', { name: '主体名称' }).fill('苏州智造激光装备有限公司');
    await page.getByRole('textbox', { name: '统一社会信用代码' }).fill('91320500MA1234567X');
    await page.getByRole('textbox', { name: '联系人' }).fill('张工');
    await page.getByRole('textbox', { name: '电话' }).fill('13800138000');
    await page.getByRole('button', { name: '提交资料' }).click();
    await expect(page.getByText('当前状态：已提交')).toBeVisible();

    await assertZeroHorizontalOverflow(page);
  });

  test('admin /admin/pricing exposes 3 v2 actions without /admin/templates or kb_addon and /admin/llm-costs works', async ({
    page,
  }) => {
    const adminTokens = mintSessionTokens('admin');
    await injectSessionBeforeLoad(page, adminTokens);
    await page.goto('/admin/pricing');

    await expect(page.getByText('GeoMix 管理')).toBeVisible();
    const nav = page.getByRole('navigation', { name: '管理菜单' });
    await expect(nav.getByRole('link', { name: '系统模板' })).toHaveCount(0);

    await expect(page.getByText('GEO 靶向写作')).toBeVisible();
    await expect(page.getByText('AI 可见性监测')).toBeVisible();
    await expect(page.getByText('行内 AI 配图')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('kb_addon');
    await expect(page.locator('body')).not.toContainText('知识库加价');
    await expect(page.locator('body')).not.toContainText('AI蒸馏拓展');

    await nav.getByRole('link', { name: 'LLM成本日报' }).click();
    await expect(page).toHaveURL(/\/admin\/llm-costs$/);
    const section = page.getByRole('region', { name: 'LLM成本日报' });
    await expect(section).toBeVisible();
    await expect(section.getByText('总调用次数')).toBeVisible();
    await expect(section.getByText('总 Token 消耗')).toBeVisible();
    await expect(section.getByRole('button', { name: '导出 CSV' })).toBeEnabled();

    await assertZeroHorizontalOverflow(page);
  });
});
