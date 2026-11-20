import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

export type MintedSession = {
  username: string;
  tenantId: string;
  role: 'MERCHANT' | 'ADMIN';
  accessToken: string;
  refreshToken: string;
};

export type WorkspaceNavItem = '行动首页' | '品牌资产' | '可见度诊断' | 'GEO 写作台';

export const REQUIRED_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const;

const repoRoot = resolve(__dirname, '../..');
const screenshotDir = resolve(repoRoot, 'test-results/e2e-screenshots');
const mintScriptPath = resolve(__dirname, 'mint-e2e-session.cjs');
const sessionCache = new Map<string, MintedSession>();

export function apiV1Base(): string {
  return (process.env.E2E_API_BASE?.trim() || 'http://127.0.0.1:3001/api/v1').replace(/\/$/, '');
}

export function apiV2Base(): string {
  const v1 = apiV1Base();
  return v1.endsWith('/api/v1') ? `${v1.slice(0, -'/api/v1'.length)}/api/v2` : `${v1}/v2`;
}

export function mintSessionTokens(username = 'demo'): MintedSession {
  const cached = sessionCache.get(username);
  if (cached) {
    return cached;
  }

  const raw = execFileSync(process.execPath, [mintScriptPath, username], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgresql://geomix:geomix@127.0.0.1:5432/geomix?schema=public',
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'change-me-access',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change-me-refresh',
    },
  });
  const minted = JSON.parse(raw) as MintedSession;
  sessionCache.set(username, minted);
  return minted;
}

export async function injectSessionBeforeLoad(
  page: Page,
  tokens: Pick<MintedSession, 'accessToken' | 'refreshToken'>,
): Promise<void> {
  await page.addInitScript(
    ({ accessToken, refreshToken }) => {
      window.sessionStorage.setItem('geomix.accessToken', accessToken);
      window.sessionStorage.setItem('geomix.refreshToken', refreshToken);
    },
    { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
  );
}

/**
 * Clicks one of the flat 4-item left sidebar workspace links (no nested submenus).
 */
export async function openWorkspaceNav(
  page: Page,
  options: {
    itemTitle: WorkspaceNavItem | string;
    expectedUrl: RegExp | string;
  },
): Promise<void> {
  const sider = page.locator('aside.ant-layout-sider');
  const menuItem = sider
    .getByRole('menuitem', { name: options.itemTitle, exact: true })
    .or(sider.getByRole('link', { name: options.itemTitle, exact: true }))
    .first();
  await expect(menuItem).toBeVisible();
  await menuItem.click();
  await expect(page).toHaveURL(options.expectedUrl);
}

/**
 * Navigates to `/account` via the bottom-left avatar entry (`data-testid="sider-account-entry"`).
 */
export async function openAccountFromSider(page: Page): Promise<void> {
  const entry = page.getByTestId('sider-account-entry');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/account(?:[?#]|$)/);
}

/**
 * Verifies zero horizontal overflow at both 1440x900 and 1280x800 (PRD §5 Redline #3).
 * Restores the previous viewport afterwards.
 */
export async function assertZeroHorizontalOverflow(
  page: Page,
  viewports: ReadonlyArray<{ width: number; height: number }> = REQUIRED_VIEWPORTS,
): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(80);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(
        metrics.scrollWidth,
        `Horizontal overflow at ${viewport.width}x${viewport.height}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth} (body=${metrics.bodyScrollWidth})`,
      ).toBeLessThanOrEqual(metrics.innerWidth);
    }
  } finally {
    if (original) {
      await page.setViewportSize(original);
    }
  }
}

export async function saveGeoMixScreenshot(page: Page, filename: string): Promise<string> {
  mkdirSync(screenshotDir, { recursive: true });
  const target = resolve(screenshotDir, filename);
  await page.screenshot({ path: target, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  return target;
}
