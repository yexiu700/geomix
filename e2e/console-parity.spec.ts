import { expect, test } from '@playwright/test';
import {
  activePane,
  injectSessionBeforeLoad,
  mintSessionTokens,
  openMenuLink,
} from './support/helpers';

test.describe('GeoMix 壳层、旧入口跳转与管理后台专项核验 (#23)', () => {
  test('历史 /user/* 入口均 307 重定向至语义化新路由 (#72)', async ({ request }) => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/user/dashboard', '/dashboard'],
      ['/user/company_keyword', '/material/keywords'],
      ['/user/images_type/index/type/1', '/material/gallery'],
      ['/user/zhiling', '/writing/prompts'],
      ['/user/ai_task', '/writing/tasks'],
      ['/user/weixin_baowen', '/rewrite/single'],
      ['/user/piliang_baowen', '/rewrite/batch'],
      ['/user/user_score_log', '/me/points'],
      ['/user/quanyi', '/me/rights'],
    ];

    for (const [legacyPath, expectedTarget] of cases) {
      const response = await request.get(legacyPath, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      const location = response.headers()['location'] ?? '';
      expect(new URL(location, 'http://127.0.0.1:3000').pathname).toBe(expectedTarget);
    }
  });

  test('布局设置抽屉支持多标签与单页模式切换，实名认证占位页可提交回显', async ({ page }) => {
    const demoTokens = mintSessionTokens('demo');
    await injectSessionBeforeLoad(page, demoTokens);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);

    const modeBadge = page.locator('header.gm-header .gm-mode');
    await expect(modeBadge).toHaveText('多标签');

    await page.getByRole('button', { name: '布局' }).click();
    const layoutDrawer = page.getByRole('dialog', { name: '布局设置' });
    await expect(layoutDrawer).toBeVisible();
    await layoutDrawer.getByRole('switch', { name: '多标签' }).click();
    await expect(modeBadge).toHaveText('单页');
    await layoutDrawer.getByRole('switch', { name: '多标签' }).click();
    await expect(modeBadge).toHaveText('多标签');
    await layoutDrawer.locator('.ant-drawer-close').click();

    await openMenuLink(page, {
      submenu: '个人中心',
      itemTitle: '实名认证',
      expectedUrl: /\/me\/verify$/,
    });
    const pane = activePane(page);
    await pane.getByLabel('主体名称').fill('苏州智造激光装备有限公司');
    await pane.getByLabel('统一社会信用代码').fill('91320500MA1234567X');
    await pane.getByLabel('联系人').fill('张工');
    await pane.getByLabel('电话').fill('13800138000');
    await pane.getByRole('button', { name: '提交资料' }).click();
    await expect(pane.getByText('当前状态：已提交')).toBeVisible();
  });

  test('管理后台 /admin/llm-costs 正常展示 LLM 成本日报与导出入口 (#24)', async ({ page }) => {
    const adminTokens = mintSessionTokens('admin');
    await injectSessionBeforeLoad(page, adminTokens);
    await page.goto('/admin/llm-costs');
    await expect(page).toHaveURL(/\/admin\/llm-costs$/);

    await expect(page.getByText('GeoMix 管理')).toBeVisible();
    const costSection = page.getByRole('region', { name: 'LLM成本日报' });
    await expect(costSection).toBeVisible();
    await expect(costSection.getByText('总调用次数')).toBeVisible();
    await expect(costSection.getByText('总 Token 消耗')).toBeVisible();
    await expect(costSection.getByRole('button', { name: '导出 CSV' })).toBeEnabled();
  });

  test('AI生图页与 AI 数据看板正常挂载并展示新上菜单角标 (#21/#59/#96)', async ({ page }) => {
    const demoTokens = mintSessionTokens('demo');
    await injectSessionBeforeLoad(page, demoTokens);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);

    await expect(page.locator('aside.ant-layout-sider .gm-badge')).toContainText('新上');

    await openMenuLink(page, {
      submenu: 'AI生图/视频',
      itemTitle: 'AI生图',
      expectedUrl: /\/image$/,
    });
    const pane = activePane(page);
    await expect(pane.getByRole('button', { name: '查看企业画像图库' })).toBeVisible();
    await expect(pane.getByText(/点数\/张/)).toBeVisible();

    await openMenuLink(page, {
      itemTitle: 'AI数据看板',
      expectedUrl: /\/visibility\/overview$/,
    });
    await expect(pane.getByText('AI数据看板').first()).toBeVisible();
  });
});
