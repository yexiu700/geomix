import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  injectSessionBeforeLoad,
  openAccountFromSider,
  openWorkspaceNav,
  type MintedSession,
} from '../../support/helpers';
import type { GeoMarket, TenantSession } from './api-client';
import { VIEWPORT_DESKTOP } from './assertions';

export { injectSessionBeforeLoad, openAccountFromSider, openWorkspaceNav };

export type WorkspaceTitle = '行动首页' | '品牌资产' | '可见度诊断' | 'GEO 写作台' | '发布中心';

export function attachErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return { errors };
}

/**
 * Creates a fresh isolated BrowserContext (zero leaked storage), injects auth tokens
 * into both sessionStorage & localStorage, and opens a page at explicit viewport (default 1440x900).
 */
export async function createAuthenticatedContext(
  browser: Browser,
  session:
    | Pick<TenantSession, 'accessToken' | 'refreshToken'>
    | Pick<MintedSession, 'accessToken' | 'refreshToken'>,
  options: {
    viewport?: { width: number; height: number };
    preseedWorkspace?: { activeBrandId: string | null; activeMarket: GeoMarket };
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? VIEWPORT_DESKTOP,
  });
  const page = await context.newPage();
  await injectSessionBeforeLoad(page, session);
  await page.addInitScript(
    ({ accessToken, refreshToken, workspace }) => {
      window.localStorage.setItem('geomix.accessToken', accessToken);
      window.localStorage.setItem('geomix.refreshToken', refreshToken);
      if (workspace) {
        window.localStorage.setItem(
          'geomix.workspace.v2',
          JSON.stringify({
            activeBrandId: workspace.activeBrandId,
            activeMarket: workspace.activeMarket,
            menuCollapsed: false,
          }),
        );
      }
    },
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      workspace: options.preseedWorkspace ?? null,
    },
  );
  return { context, page };
}

export async function openAuthenticatedPage(
  browser: Browser,
  session: Pick<MintedSession, 'accessToken' | 'refreshToken'>,
  initialPath?: string,
  viewport: { width: number; height: number } = VIEWPORT_DESKTOP,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const { context, page } = await createAuthenticatedContext(browser, session, { viewport });
  const collector = attachErrorCollector(page);
  if (initialPath) {
    await page.goto(initialPath, { waitUntil: 'domcontentloaded' });
  }
  return { context, page, errors: collector.errors };
}

export async function navigateWorkspace(
  page: Page,
  title: WorkspaceTitle,
  expectedPath: RegExp,
): Promise<void> {
  await openWorkspaceNav(page, { itemTitle: title, expectedUrl: expectedPath });
}

export async function openAccountWorkspace(page: Page): Promise<void> {
  await openAccountFromSider(page);
}

export async function switchGlobalBrand(page: Page, brandName: string): Promise<void> {
  const switcher = page.getByTestId('global-brand-switcher');
  await expect(switcher).toBeVisible();
  await switcher.click();
  const option = page
    .locator('.ant-select-item-option, .ant-dropdown-menu-item, [role="option"], [role="menuitem"]')
    .filter({ hasText: brandName })
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(switcher).toContainText(brandName);
}

export async function selectGlobalBrand(page: Page, brandName: string): Promise<void> {
  await switchGlobalBrand(page, brandName);
}

export async function switchGlobalMarket(page: Page, market: GeoMarket): Promise<void> {
  const switcher = page.getByTestId('global-market-switcher');
  await expect(switcher).toBeVisible();
  const labelPattern = market === 'CN' ? /国内/ : /海外/;
  const btn = switcher
    .getByRole('button', { name: labelPattern })
    .or(switcher.getByText(labelPattern))
    .first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('market'), { timeout: 10_000 })
    .toBe(market);
}

export async function expectUrlContext(
  page: Page,
  expected: { brandId?: string; market?: GeoMarket; pathname?: string | RegExp },
): Promise<void> {
  await expect
    .poll(
      () => {
        const u = new URL(page.url());
        const pathOk =
          expected.pathname === undefined
            ? true
            : typeof expected.pathname === 'string'
              ? u.pathname === expected.pathname
              : expected.pathname.test(u.pathname);
        const brandOk =
          expected.brandId === undefined
            ? true
            : u.searchParams.get('brandId') === expected.brandId;
        const marketOk =
          expected.market === undefined ? true : u.searchParams.get('market') === expected.market;
        return pathOk && brandOk && marketOk;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/**
 * Tracks distinct workspace pathname transitions (ignoring query-only updates like
 * `?brandId=&market=`) for PRD §5 Quality Redline #4 (`navCount <= 3`).
 */
export function trackRouteNavigations(page: Page): {
  start: () => void;
  getTransitionCount: () => number;
  getVisitedPaths: () => string[];
  getCount: () => number;
  getHistory: () => string[];
  reset: () => void;
  detach: () => void;
} {
  let active = false;
  let lastPath = '';
  const history: string[] = [];

  const record = (rawUrl: string) => {
    if (!active) {
      return;
    }
    try {
      const pathname = new URL(rawUrl).pathname;
      if (pathname !== lastPath) {
        lastPath = pathname;
        history.push(pathname);
      }
    } catch {
      // Ignore non-HTTP internal URLs like about:blank
    }
  };

  const onFrameNavigated = (frame: { url: () => string }) => {
    if (frame === page.mainFrame()) {
      record(frame.url());
    }
  };

  page.on('framenavigated', onFrameNavigated);

  const start = () => {
    active = true;
    history.length = 0;
    try {
      lastPath = new URL(page.url()).pathname;
    } catch {
      lastPath = '';
    }
  };

  const reset = () => {
    history.length = 0;
    try {
      lastPath = new URL(page.url()).pathname;
    } catch {
      lastPath = '';
    }
  };

  const detach = () => {
    active = false;
    page.off('framenavigated', onFrameNavigated);
  };

  return {
    start,
    getTransitionCount: () => history.length,
    getVisitedPaths: () => [...history],
    getCount: () => history.length,
    getHistory: () => [...history],
    reset,
    detach,
  };
}

export function trackWorkspaceNavigations(page: Page): {
  getCount: () => number;
  getHistory: () => string[];
  detach: () => void;
} {
  const tracker = trackRouteNavigations(page);
  tracker.start();
  return {
    getCount: tracker.getCount,
    getHistory: tracker.getHistory,
    detach: tracker.detach,
  };
}

export async function openVisibilityTab(
  page: Page,
  tab: 'overview' | 'runs' | 'citations',
): Promise<void> {
  const testIdMap = {
    overview: 'visibility-tab-overview',
    runs: 'visibility-tab-runs',
    citations: 'visibility-tab-citations',
  } as const;
  const labelMap = {
    overview: /诊断总览/,
    runs: /监测任务/,
    citations: /信源阵地/,
  } as const;

  const target = page
    .getByTestId(testIdMap[tab])
    .or(page.getByRole('tab', { name: labelMap[tab] }))
    .first();
  await expect(target).toBeVisible();
  await target.click();
}

export async function waitForBriefDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('geo-brief-drawer').or(page.locator('.ant-drawer-open')).first();
  await expect(drawer).toBeVisible({ timeout: 15_000 });
}

export async function openBriefDrawerAndEdit(
  page: Page,
  opts: { newH2?: string; newTitle?: string; clickWrite?: boolean } = {},
): Promise<void> {
  await waitForBriefDrawer(page);
  const drawer = page.getByTestId('geo-brief-drawer').or(page.locator('.ant-drawer-open')).first();

  if (opts.newTitle) {
    const titleInput = drawer
      .getByTestId('brief-drawer-title')
      .or(drawer.locator('input').first())
      .first();
    await titleInput.fill(opts.newTitle);
  }

  if (opts.newH2) {
    const h2Inputs = drawer.locator(
      'input[placeholder*="H2"], input[placeholder*="小节"], input[data-testid*="outline"]',
    );
    await expect(h2Inputs.first()).toBeVisible();
    await h2Inputs.first().fill(opts.newH2);
  }

  if (opts.clickWrite) {
    const writeBtn = drawer
      .getByTestId('brief-drawer-write-btn')
      .or(drawer.getByRole('button', { name: /按此意见立即写作|确认并写作/ }))
      .first();
    await expect(writeBtn).toBeVisible();
    await writeBtn.click();
  }
}

export async function waitForStudioSseComplete(
  page: Page,
  timeoutMs = 30_000,
): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const scoreEl = page.getByTestId('geo-score-value');
  await expect(scoreEl).toBeVisible({ timeout: timeoutMs });
  await expect
    .poll(
      async () => {
        const text = (await scoreEl.innerText()).trim();
        const match = text.match(/\d+/);
        return match ? Number(match[0]) : 0;
      },
      { timeout: timeoutMs },
    )
    .toBeGreaterThan(0);
  return { durationMs: Date.now() - startedAt };
}
