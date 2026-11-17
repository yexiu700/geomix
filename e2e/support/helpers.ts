import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';

export type MintedSession = {
  username: string;
  tenantId: string;
  role: 'MERCHANT' | 'ADMIN';
  accessToken: string;
  refreshToken: string;
};

const repoRoot = resolve(__dirname, '../..');
const screenshotDir = resolve(repoRoot, 'test-results/e2e-screenshots');

export function mintSessionTokens(username = 'demo'): MintedSession {
  const raw = execFileSync(
    'pnpm',
    ['--filter', '@geomix/db', 'exec', 'node', '../../e2e/support/mint-e2e-session.cjs', username],
    {
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
    },
  );
  return JSON.parse(raw) as MintedSession;
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

export function activePane(page: Page): Locator {
  return page.locator('.gm-page:not([hidden])');
}

export async function openMenuLink(
  page: Page,
  options: {
    submenu?: string;
    itemTitle: string;
    expectedUrl: RegExp | string;
  },
): Promise<void> {
  const sider = page.locator('aside.ant-layout-sider');
  const menuItem = sider.getByRole('menuitem', { name: options.itemTitle, exact: true });
  if (options.submenu) {
    const submenuRoot = sider
      .locator('.ant-menu-submenu')
      .filter({ has: page.locator('.ant-menu-submenu-title', { hasText: options.submenu }) })
      .first();
    const isOpen = await submenuRoot
      .evaluate((el) => el.classList.contains('ant-menu-submenu-open'))
      .catch(() => false);
    if (!isOpen || !(await menuItem.isVisible().catch(() => false))) {
      await submenuRoot.locator('.ant-menu-submenu-title').first().click();
    }
    await expect(
      submenuRoot
        .locator('.ant-menu-sub:not(.ant-menu-hidden)')
        .getByRole('menuitem', { name: options.itemTitle, exact: true }),
    ).toBeVisible();
  }
  await menuItem.click();
  await expect(page).toHaveURL(options.expectedUrl);
}

export async function saveGeoMixScreenshot(page: Page, filename: string): Promise<string> {
  mkdirSync(screenshotDir, { recursive: true });
  const target = resolve(screenshotDir, filename);
  await page.screenshot({ path: target, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  return target;
}

export async function selectOptionByText(
  selectLocator: Locator,
  matcher: RegExp | string,
): Promise<string> {
  await expect(selectLocator).toBeVisible();
  let matchedValue: string | null = null;
  await expect
    .poll(
      async () => {
        matchedValue = await selectLocator.evaluate(
          (el, raw) => {
            const select = el as HTMLSelectElement;
            const hit = Array.from(select.options).find((opt) =>
              raw.isRegex
                ? new RegExp(raw.source, raw.flags).test(opt.text)
                : opt.text.includes(raw.text),
            );
            return hit ? hit.value : null;
          },
          typeof matcher === 'string'
            ? { isRegex: false, text: matcher, source: '', flags: '' }
            : { isRegex: true, text: '', source: matcher.source, flags: matcher.flags },
        );
        return matchedValue;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  await selectLocator.selectOption(matchedValue!);
  return matchedValue!;
}

export async function selectAntdMultipleOption(
  page: Page,
  container: Locator,
  ariaLabel: string,
  optionTitle: string,
): Promise<void> {
  const selectorBox = container
    .locator(
      `.ant-select[aria-label="${ariaLabel}"] .ant-select-selector, .ant-select:has([aria-label="${ariaLabel}"]) .ant-select-selector`,
    )
    .first();
  await expect(selectorBox).toBeVisible();
  await selectorBox.click();
  const option = page.locator(
    `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${optionTitle}"]`,
  );
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.press('Escape');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function buildTestPngBuffer(
  width = 600,
  height = 400,
  rgb: readonly [number, number, number] = [22, 119, 255],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  const singleRow = Buffer.alloc(rowBytes);
  singleRow[0] = 0;
  for (let x = 0; x < width; x += 1) {
    const offset = 1 + x * 3;
    singleRow[offset] = rgb[0];
    singleRow[offset + 1] = rgb[1];
    singleRow[offset + 2] = rgb[2];
  }
  for (let y = 0; y < height; y += 1) {
    singleRow.copy(raw, y * rowBytes);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
