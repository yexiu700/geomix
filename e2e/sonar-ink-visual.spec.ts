import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNav } from './support/helpers';
import {
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  getAdminSession,
  getWebBase,
  listMarketEnginesApi,
  provisionIsolatedTenant,
  requestV2,
  unwrapOk,
  upsertBrandFactsApi,
  waitForVisibilityRunApi,
  type BrandDto,
  type GeoMarket,
  type MintedSession,
} from './v2/support/api-client';
import { assertNoConsoleOrPageErrors } from './v2/support/assertions';
import {
  E2E_SENTINELS,
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  uniqueIdemKey,
  uniqueTag,
} from './v2/support/fixtures';
import {
  attachErrorCollector,
  createAuthenticatedContext,
  openVisibilityTab,
  switchGlobalMarket,
} from './v2/support/ui-actions';

// ============================================================================
// Run r2 — Sonar Ink 2.0 Visual & Layout E2E Suite (Epic #395: #390-#394)
// Opaque-box DOM, CSS, computed-style, typography, layout & network contracts.
// ============================================================================

const WEB_BASE = getWebBase();
const WEB_ORIGIN = new URL(WEB_BASE).origin;

const VP_DESKTOP = { width: 1440, height: 900 } as const;
const VP_LAPTOP = { width: 1280, height: 800 } as const;
const VP_MOBILE = { width: 390, height: 844 } as const;
const VP_ULTRAWIDE = { width: 1920, height: 1080 } as const;
const CORE_VIEWPORTS = [VP_DESKTOP, VP_LAPTOP, VP_MOBILE] as const;

const FORBIDDEN_EXTERNAL_FONT_CDN_RE =
  /(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)/i;

function attachFontLeakCollector(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (FORBIDDEN_EXTERNAL_FONT_CDN_RE.test(url)) {
      hits.push(`cdn:${url}`);
      return;
    }
    if (req.resourceType() === 'font') {
      try {
        const parsed = new URL(url);
        if (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin !== WEB_ORIGIN
        ) {
          hits.push(`third-party-font:${url}`);
        }
      } catch {
        // Ignore unparseable non-HTTP(S) font URIs
      }
    }
  });
  return hits;
}

const ANTD_PRESET_TAG_SELECTOR = [
  '.ant-tag-geekblue',
  '.ant-tag-gold',
  '.ant-tag-volcano',
  '.ant-tag-orange',
  '.ant-tag-cyan',
  '.ant-tag-purple',
  '.ant-tag-magenta',
  '.ant-tag-lime',
  '.ant-tag-blue',
  '.ant-tag-green',
  '.ant-tag-red',
].join(', ');

type RgbColor = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): RgbColor | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0]! + hex[0]!, 16),
        g: Number.parseInt(hex[1]! + hex[1]!, 16),
        b: Number.parseInt(hex[2]! + hex[2]!, 16),
        a: 1,
      };
    }
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgbMatch = s.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/,
  );
  if (!rgbMatch) {
    return null;
  }
  return {
    r: Math.round(Number.parseFloat(rgbMatch[1]!)),
    g: Math.round(Number.parseFloat(rgbMatch[2]!)),
    b: Math.round(Number.parseFloat(rgbMatch[3]!)),
    a: rgbMatch[4] === undefined ? 1 : Number.parseFloat(rgbMatch[4]!),
  };
}

function toNormalizedHex(raw: string): string {
  const c = parseColor(raw);
  if (!c) {
    return raw.trim().toLowerCase();
  }
  const hex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function relativeLuminance(c: RgbColor): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function extractRotationDegrees(transform: string): number {
  const trimmed = transform.trim();
  if (!trimmed || trimmed === 'none') {
    return 0;
  }
  const m2d = trimmed.match(/^matrix\(([^)]+)\)$/);
  if (m2d) {
    const parts = m2d[1]!.split(',').map((v) => Number.parseFloat(v.trim()));
    if (parts.length < 4 || Number.isNaN(parts[0]!) || Number.isNaN(parts[1]!)) {
      return 0;
    }
    return Math.round(Math.abs(Math.atan2(parts[1]!, parts[0]!) * (180 / Math.PI)));
  }
  const m3d = trimmed.match(/^matrix3d\(([^)]+)\)$/);
  if (m3d) {
    const parts = m3d[1]!.split(',').map((v) => Number.parseFloat(v.trim()));
    if (parts.length < 16 || Number.isNaN(parts[0]!) || Number.isNaN(parts[1]!)) {
      return 0;
    }
    return Math.round(Math.abs(Math.atan2(parts[1]!, parts[0]!) * (180 / Math.PI)));
  }
  return 0;
}

function buildCleanDualMarketBrandPayload(tag: string): Record<string, unknown> {
  const base = buildDualMarketBrandPayload(tag);
  const markets = (base.markets as Array<Record<string, unknown>>) || [];
  return {
    ...base,
    markets: markets.map((m) =>
      m.market === 'GLOBAL' ? { ...m, localCategory: 'Private Cloud NAS' } : m,
    ),
  };
}

async function pickOnlineEngines(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
  maxCount = 2,
): Promise<string[]> {
  const engines = await listMarketEnginesApi(session, brandId, market);
  const available = engines.filter((e) => e.available !== false).map((e) => e.key);
  expect(available.length, `At least 1 ${market} visibility engine must be online`).toBeGreaterThan(
    0,
  );
  return available.slice(0, maxCount);
}

async function seedArticleViaSse(
  token: string,
  brandId: string,
  body: Record<string, unknown>,
  idemPrefix: string,
): Promise<{ id: string; title: string; contentMarkdown: string }> {
  const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
    token,
    idempotencyKey: uniqueIdemKey(idemPrefix),
    body,
    timeoutMs: 45_000,
  });
  const article = sse.complete?.article as
    { id: string; title: string; contentMarkdown: string } | undefined;
  expect(article?.id, `SSE stream (${idemPrefix}) must produce article.id`).toBeTruthy();
  return article!;
}

async function assertOverflowAcrossViewports(
  page: Page,
  viewports: ReadonlyArray<{ width: number; height: number }> = CORE_VIEWPORTS,
  routeLabel = 'page',
): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(120);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        metrics.scrollWidth,
        `Horizontal overflow on ${routeLabel} at ${vp.width}x${vp.height}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
      ).toBeLessThanOrEqual(metrics.innerWidth + 1);
    }
  } finally {
    if (original) {
      await page.setViewportSize(original);
      await page.waitForTimeout(80);
    }
  }
}

async function waitForSettledContent(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout });
}

async function assertZeroTinyCjk(page: Page, scopeSelector = 'body'): Promise<void> {
  const result = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) {
      return { rootFound: false, scannedCjkCount: 0, offenders: [] as string[] };
    }
    const isEffectivelyVisible = (startEl: HTMLElement): boolean => {
      let cur: HTMLElement | null = startEl;
      while (cur && cur !== document.documentElement) {
        const s = window.getComputedStyle(cur);
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          Number.parseFloat(s.opacity || '1') <= 0
        ) {
          return false;
        }
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
      return true;
    };
    let scannedCjkCount = 0;
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = (node.textContent ?? '').trim();
      if (text && /[\u4e00-\u9fff]/.test(text)) {
        const el = node.parentElement;
        if (el) {
          const tag = el.tagName.toLowerCase();
          if (tag !== 'script' && tag !== 'style' && tag !== 'noscript') {
            const hiddenOverlay = el.closest(
              '.ant-drawer:not(.ant-drawer-open), .ant-tooltip-hidden, .ant-select-dropdown-hidden, .ant-dropdown-hidden, .ant-popover-hidden, .ant-collapse-content-hidden, .sr-only, .gm-sr-only, [aria-hidden="true"]',
            );
            if (!hiddenOverlay) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 1 && rect.height > 1 && isEffectivelyVisible(el)) {
                scannedCjkCount += 1;
                const fs = Number.parseFloat(window.getComputedStyle(el).fontSize);
                if (Number.isFinite(fs) && fs < 11.95) {
                  found.push(`${tag}(${fs.toFixed(1)}px): "${text.slice(0, 18)}"`);
                }
              }
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return { rootFound: true, scannedCjkCount, offenders: found.slice(0, 10) };
  }, scopeSelector);

  expect(result.rootFound, `assertZeroTinyCjk scope '${scopeSelector}' must exist in DOM`).toBe(
    true,
  );
  expect(
    result.scannedCjkCount,
    `assertZeroTinyCjk scanned 0 visible CJK nodes inside '${scopeSelector}'`,
  ).toBeGreaterThan(0);
  expect(
    result.offenders,
    `Found visible CJK text smaller than 12px inside '${scopeSelector}': ${result.offenders.join('; ')}`,
  ).toEqual([]);
}

async function assertZeroDesktopVerticalCjkWrap(page: Page, routeLabel: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const found: string[] = [];
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="tab"], h1, h2, h3, .ant-btn'),
    );
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (el.textContent ?? '').replace(/\s+/g, '').trim();
      if (text.length < 3 || !/[\u4e00-\u9fff]/.test(text)) continue;
      const fs = Number.parseFloat(style.fontSize) || 13;
      if (rect.width < fs * 1.9 && rect.height > fs * 3.2) {
        found.push(
          `${el.tagName}("${text.slice(0, 12)}"): ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
      }
    }
    return found.slice(0, 10);
  });
  expect(
    offenders,
    `Vertical single-char CJK wrap on ${routeLabel}: ${offenders.join('; ')}`,
  ).toEqual([]);
}

async function assertZeroPresetAntdTags(page: Page, scopeSelector = 'body'): Promise<void> {
  const result = await page.evaluate(
    ({ scope, selector }) => {
      const root = document.querySelector(scope);
      if (!root) return { rootFound: false, offenders: [] as string[] };
      const isEffectivelyVisible = (startEl: HTMLElement): boolean => {
        let cur: HTMLElement | null = startEl;
        while (cur && cur !== document.documentElement) {
          const s = window.getComputedStyle(cur);
          if (
            s.display === 'none' ||
            s.visibility === 'hidden' ||
            Number.parseFloat(s.opacity || '1') <= 0
          ) {
            return false;
          }
          if (cur === document.body) break;
          cur = cur.parentElement;
        }
        return true;
      };
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector));
      const visible: string[] = [];
      for (const el of nodes) {
        if (
          el.closest(
            '.ant-drawer:not(.ant-drawer-open), .ant-tooltip-hidden, .ant-popover-hidden, .ant-collapse-content-hidden',
          )
        ) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && isEffectivelyVisible(el)) {
          visible.push(`${el.className}: "${(el.textContent ?? '').trim().slice(0, 20)}"`);
        }
      }
      return { rootFound: true, offenders: visible.slice(0, 10) };
    },
    { scope: scopeSelector, selector: ANTD_PRESET_TAG_SELECTOR },
  );
  expect(
    result.rootFound,
    `assertZeroPresetAntdTags scope '${scopeSelector}' must exist in DOM`,
  ).toBe(true);
  expect(
    result.offenders,
    `AntD preset colored <Tag> classes found in '${scopeSelector}': ${result.offenders.join('; ')}`,
  ).toEqual([]);
}

async function assertDarkSurfaceBackground(page: Page, routeLabel: string): Promise<void> {
  const effectiveBg = await page.evaluate(() => {
    const candidates: Array<Element | null> = [
      document.querySelector('.ant-layout'),
      document.body,
      document.documentElement,
    ];
    for (const el of candidates) {
      if (!el) continue;
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        return bg;
      }
    }
    return window.getComputedStyle(document.body).backgroundColor;
  });

  const parsed = parseColor(effectiveBg);
  expect(parsed, `Could not parse backgroundColor '${effectiveBg}' on ${routeLabel}`).toBeTruthy();
  expect(
    relativeLuminance(parsed!),
    `Expected dark Sonar Ink surface on ${routeLabel}, got ${effectiveBg} (${toNormalizedHex(effectiveBg)})`,
  ).toBeLessThan(0.05);
}

async function getVisiblePrimaryButtons(
  page: Page,
  scopeSelector: string,
): Promise<Array<{ text: string; bg: string; color: string }>> {
  const result = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) {
      return {
        rootFound: false,
        visible: [] as Array<{ text: string; bg: string; color: string }>,
      };
    }
    const isEffectivelyVisible = (startEl: HTMLElement): boolean => {
      let cur: HTMLElement | null = startEl;
      while (cur && cur !== document.documentElement) {
        const s = window.getComputedStyle(cur);
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          Number.parseFloat(s.opacity || '1') <= 0
        ) {
          return false;
        }
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
      return true;
    };
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('.ant-btn-primary'));
    const visible: Array<{ text: string; bg: string; color: string }> = [];
    for (const btn of buttons) {
      if (
        btn.closest(
          '.ant-modal-root, .ant-drawer, .ant-popover, .ant-dropdown, .ant-popover-hidden, .ant-collapse-content-hidden',
        )
      ) {
        continue;
      }
      const style = window.getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && isEffectivelyVisible(btn)) {
        visible.push({
          text: (btn.textContent ?? '').replace(/\s+/g, ' ').trim(),
          bg: style.backgroundColor,
          color: style.color,
        });
      }
    }
    return { rootFound: true, visible };
  }, scopeSelector);

  expect(
    result.rootFound,
    `getVisiblePrimaryButtons scope '${scopeSelector}' must exist in DOM`,
  ).toBe(true);
  return result.visible;
}

async function assertAllWorkspaceChildrenWithin(
  page: Page,
  maxWidth: number,
  label: string,
  checkCentered = false,
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.gm-workspace-main');
    if (!main) return null;
    const content =
      document.querySelector<HTMLElement>('.gm-content') ??
      document.querySelector<HTMLElement>('main') ??
      document.body;
    const cr = content.getBoundingClientRect();
    const children = Array.from(main.children).filter((el): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });
    const boxes = children.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        width: r.width,
        leftGap: r.left - cr.left,
        rightGap: cr.right - r.right,
      };
    });
    const widest = boxes.reduce(
      (best, cur) => (!best || cur.width > best.width ? cur : best),
      null as (typeof boxes)[number] | null,
    );
    return { visibleChildCount: boxes.length, widest };
  });

  expect(metrics, `.gm-workspace-main missing on ${label}`).toBeTruthy();
  expect(
    metrics!.visibleChildCount,
    `${label} must render at least 1 visible child inside .gm-workspace-main`,
  ).toBeGreaterThan(0);
  expect(
    metrics!.widest!.width,
    `${label} max visible child width (${Math.round(metrics!.widest!.width)}px) must be <= ${maxWidth}px`,
  ).toBeLessThanOrEqual(maxWidth);
  if (checkCentered) {
    expect(
      Math.abs(metrics!.widest!.leftGap - metrics!.widest!.rightGap),
      `${label} widest container must be horizontally centered (leftGap=${Math.round(metrics!.widest!.leftGap)}, rightGap=${Math.round(metrics!.widest!.rightGap)})`,
    ).toBeLessThanOrEqual(28);
  }
}

async function assertProseMeasureAndTypography(
  page: Page,
  containerSelector: string,
  label: string,
): Promise<void> {
  const prose = await page.evaluate((selector) => {
    const container = document.querySelector<HTMLElement>(selector);
    if (!container) return null;
    const paragraphs = Array.from(container.querySelectorAll<HTMLElement>('p')).filter((p) => {
      const r = p.getBoundingClientRect();
      return r.width > 40 && r.height > 10 && (p.textContent ?? '').trim().length >= 16;
    });
    const target = paragraphs[0] ?? container;
    const rect = target.getBoundingClientRect();
    const style = window.getComputedStyle(target);
    const fontSize = Number.parseFloat(style.fontSize);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      width: rect.width,
      fontSize,
      lineHeightRatio: fontSize > 0 ? lineHeight / fontSize : 0,
    };
  }, containerSelector);

  expect(prose, `Prose element not found for ${label} (${containerSelector})`).toBeTruthy();
  expect(
    prose!.width,
    `${label} prose width (${Math.round(prose!.width)}px) must be <= 724px`,
  ).toBeLessThanOrEqual(724);
  expect(prose!.fontSize, `${label} prose fontSize must be ~15px`).toBeGreaterThanOrEqual(14.5);
  expect(prose!.fontSize, `${label} prose fontSize must be ~15px`).toBeLessThanOrEqual(16);
  expect(
    prose!.lineHeightRatio,
    `${label} prose line-height ratio (${prose!.lineHeightRatio.toFixed(2)}) must be ~1.75`,
  ).toBeGreaterThanOrEqual(1.65);
  expect(
    prose!.lineHeightRatio,
    `${label} prose line-height ratio (${prose!.lineHeightRatio.toFixed(2)}) must be ~1.75`,
  ).toBeLessThanOrEqual(1.85);
}

// ============================================================================
// Tier 1 — Tokens, Self-Hosted Fonts, Shell & Studio 72px Rail
// ============================================================================

test.describe('Tier 1 — Sonar Ink 2.0 Tokens, Fonts, Shell & Studio Rail', () => {
  test('SI-T1-01: Tokens 2.0 (--gm-*), fresh-context /fonts/*.woff2 HTTP 200, @font-face & document.fonts.ready, zero external CDN & dark body #090b0a', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);
    const tag = uniqueTag(testInfo, 'sit101');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit101', initialPoints: 100 });
    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_DESKTOP,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);
    const externalCdnHits = attachFontLeakCollector(page);
    const localWoff2Ok: string[] = [];

    page.on('response', (res) => {
      if (/\/fonts\/[^?#]+\.woff2(?:[?#]|$)/i.test(res.url()) && res.status() === 200) {
        localWoff2Ok.push(res.url());
      }
    });

    try {
      await page.goto(`/home?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);

      expect(
        externalCdnHits,
        'Zero external font CDN or third-party font requests allowed',
      ).toEqual([]);
      expect(
        localWoff2Ok.length,
        'Fresh context must fetch self-hosted /fonts/*.woff2 with HTTP 200',
      ).toBeGreaterThanOrEqual(1);

      // Verify CSS @font-face rules & document.fonts loaded faces
      const fontAudit = await page.evaluate(() => {
        const fontFaceRules: Array<{ family: string; src: string; display: string }> = [];
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSFontFaceRule) {
              fontFaceRules.push({
                family: rule.style.getPropertyValue('font-family'),
                src: rule.style.getPropertyValue('src'),
                display: rule.style.getPropertyValue('font-display'),
              });
            }
          }
        }
        const loadedFamilies: string[] = [];
        document.fonts.forEach((f) => {
          if (f.status === 'loaded') {
            loadedFamilies.push(f.family);
          }
        });

        const bodyFont = window.getComputedStyle(document.body).fontFamily;
        const monoEl = document.querySelector('.gm-num, kbd, code');
        const monoFont = monoEl ? window.getComputedStyle(monoEl).fontFamily : '';
        return { fontFaceRules, loadedFamilies, bodyFont, monoFont };
      });

      const hasInterFace = fontAudit.fontFaceRules.some(
        (r) =>
          /inter/i.test(r.family) &&
          /\/fonts\/.*\.woff2/i.test(r.src) &&
          /swap|optional|fallback/i.test(r.display),
      );
      const hasMonoFace = fontAudit.fontFaceRules.some(
        (r) =>
          /jetbrains\s*mono/i.test(r.family) &&
          /\/fonts\/.*\.woff2/i.test(r.src) &&
          /swap|optional|fallback/i.test(r.display),
      );
      expect(hasInterFace, 'Expected @font-face rule for self-hosted Inter WOFF2').toBe(true);
      expect(hasMonoFace, 'Expected @font-face rule for self-hosted JetBrains Mono WOFF2').toBe(
        true,
      );
      expect(
        fontAudit.loadedFamilies.some((f) => /inter/i.test(f)),
        `Inter FontFace must be loaded (loaded: ${fontAudit.loadedFamilies.join(', ')})`,
      ).toBe(true);
      expect(
        fontAudit.loadedFamilies.some((f) => /jetbrains\s*mono/i.test(f)),
        `JetBrains Mono FontFace must be loaded (loaded: ${fontAudit.loadedFamilies.join(', ')})`,
      ).toBe(true);
      expect(fontAudit.bodyFont.toLowerCase()).toContain('inter');
      expect(fontAudit.monoFont.toLowerCase()).toContain('jetbrains mono');

      // Verify :root Tokens 2.0
      const tokens = await page.evaluate(() => {
        const s = window.getComputedStyle(document.documentElement);
        const read = (name: string) => s.getPropertyValue(name).trim();
        return {
          surface0: read('--gm-surface-0'),
          surface1: read('--gm-surface-1'),
          surface2: read('--gm-surface-2'),
          surface3: read('--gm-surface-3'),
          fg1: read('--gm-fg-1'),
          fg2: read('--gm-fg-2'),
          fg3: read('--gm-fg-3'),
          containerWide: read('--gm-container-wide'),
          containerForm: read('--gm-container-form'),
          measureProse: read('--gm-measure-prose'),
          fsXs: read('--gm-fs-xs'),
          fsSm: read('--gm-fs-sm'),
          fsMd: read('--gm-fs-md'),
          fsLg: read('--gm-fs-lg'),
          fsXl: read('--gm-fs-xl'),
          fs2xl: read('--gm-fs-2xl'),
          fsProse: read('--gm-fs-prose'),
          bodyBg: window.getComputedStyle(document.body).backgroundColor,
        };
      });

      expect(toNormalizedHex(tokens.surface0)).toBe('#090b0a');
      expect(toNormalizedHex(tokens.surface1)).toBe('#111513');
      expect(toNormalizedHex(tokens.surface2)).toBe('#181d1b');
      expect(toNormalizedHex(tokens.surface3)).toBe('#202623');
      expect(toNormalizedHex(tokens.fg1)).toBe('#eef2f0');
      expect(toNormalizedHex(tokens.fg2)).toBe('#adb6b2');
      expect(toNormalizedHex(tokens.fg3)).toBe('#838d89');
      expect(tokens.containerWide).toBe('1360px');
      expect(tokens.containerForm).toBe('1040px');
      expect(tokens.measureProse).toBe('720px');
      expect(tokens.fsXs).toBe('12px');
      expect(tokens.fsSm).toBe('13px');
      expect(tokens.fsMd).toBe('14px');
      expect(tokens.fsLg).toBe('16px');
      expect(tokens.fsXl).toBe('20px');
      expect(tokens.fs2xl).toBe('28px');
      expect(tokens.fsProse).toBe('15px');
      expect(toNormalizedHex(tokens.bodyBg)).toBe('#090b0a');

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });

  test('SI-T1-02: Borderless topbar (<= 5 children), zero breadcrumb, single bottom-left account entry, 4 .ant-menu-item for Merchant & Admin & quiet ADMIN link outside .ant-menu', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 'sit102');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit102', initialPoints: 100 });
    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));

    // 1. Merchant Context
    const { context: merchantCtx, page: merchantPage } = await createAuthenticatedContext(
      browser,
      tenant.session,
      {
        viewport: VP_DESKTOP,
        preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
      },
    );
    const merchantCollector = attachErrorCollector(merchantPage);

    try {
      await merchantPage.goto(`/home?brandId=${brand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(merchantPage.getByTestId('home-workspace')).toBeVisible({ timeout: 20_000 });

      // Wait for all preserved topbar E2E controls to mount BEFORE auditing header geometry & borderless pill
      await expect(merchantPage.getByTestId('global-brand-switcher')).toBeVisible({
        timeout: 15_000,
      });
      await expect(merchantPage.getByTestId('global-market-switcher')).toBeVisible({
        timeout: 15_000,
      });
      await expect(merchantPage.locator('[aria-label="切换目标市场"]').first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(merchantPage.locator('button[aria-label="打开指令面板"]')).toBeVisible({
        timeout: 15_000,
      });
      await expect(merchantPage.getByTestId('header-points-pill')).toBeVisible({
        timeout: 15_000,
      });

      // Topbar visible direct children across .gm-header-left > * and .gm-header-right > * (with fallback) must be 3..5
      const headerAudit = await merchantPage.evaluate(() => {
        const header = document.querySelector<HTMLElement>('header.gm-header');
        if (!header) return null;
        const leftChildren = Array.from(
          header.querySelectorAll<HTMLElement>('.gm-header-left > *'),
        );
        const rightChildren = Array.from(
          header.querySelectorAll<HTMLElement>('.gm-header-right > *'),
        );
        let candidates = [...leftChildren, ...rightChildren];
        if (candidates.length === 0) {
          // Resilient fallback if header flex wrapper class names are refactored
          const direct = Array.from(header.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement,
          );
          candidates =
            direct.length <= 2
              ? direct.flatMap((group) =>
                  Array.from(group.children).filter(
                    (el): el is HTMLElement => el instanceof HTMLElement,
                  ),
                )
              : direct;
        }
        const all = candidates.filter((el) => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        });
        const pointsPill = header.querySelector<HTMLElement>('[data-testid="header-points-pill"]');
        const pillStyle = pointsPill ? window.getComputedStyle(pointsPill) : null;
        return {
          visibleChildCount: all.length,
          pointsPillFound: Boolean(pointsPill),
          pointsBorderWidth: pillStyle?.borderTopWidth ?? '',
          pointsBorderColor: pillStyle?.borderTopColor ?? '',
        };
      });

      expect(headerAudit, 'header.gm-header must be present').toBeTruthy();
      expect(
        headerAudit!.pointsPillFound,
        'header-points-pill must be mounted inside header.gm-header before auditing',
      ).toBe(true);
      expect(
        headerAudit!.visibleChildCount,
        `Topbar visible direct child controls (${headerAudit!.visibleChildCount}) must be >= 3`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        headerAudit!.visibleChildCount,
        `Topbar visible direct child controls (${headerAudit!.visibleChildCount}) must be <= 5`,
      ).toBeLessThanOrEqual(5);

      const pillBorderParsed = parseColor(headerAudit!.pointsBorderColor);
      const isBorderlessPill =
        headerAudit!.pointsBorderWidth === '0px' || (pillBorderParsed?.a ?? 1) === 0;
      expect(
        isBorderlessPill,
        `header-points-pill must be borderless at rest (width=${headerAudit!.pointsBorderWidth}, color=${headerAudit!.pointsBorderColor})`,
      ).toBe(true);

      // Zero breadcrumb, header avatar, header admin link, header collapse button
      await expect(merchantPage.locator('nav[aria-label="面包屑"], .gm-breadcrumb')).toHaveCount(0);
      await expect(merchantPage.locator('header.gm-header .gm-avatar')).toHaveCount(0);
      await expect(
        merchantPage.locator('header.gm-header').getByRole('link', { name: '运营后台' }),
      ).toHaveCount(0);
      await expect(
        merchantPage.locator('header.gm-header').getByRole('button', { name: /收起菜单|展开菜单/ }),
      ).toHaveCount(0);

      // Sidebar: strictly 5 .ant-menu-item, bottom-left sider-account-entry, 0 admin links for MERCHANT
      const sider = merchantPage.locator('aside.ant-layout-sider');
      await expect(sider.locator('.ant-menu-item')).toHaveCount(5);
      await expect(sider.getByTestId('sider-account-entry')).toBeVisible();
      await expect(sider.getByRole('link', { name: '运营后台' })).toHaveCount(0);

      const siderGeometry = await merchantPage.evaluate(() => {
        const nav = document.querySelector('aside.ant-layout-sider .ant-menu');
        const account = document.querySelector('[data-testid="sider-account-entry"]');
        const selectedItem = document.querySelector(
          'aside.ant-layout-sider .ant-menu-item-selected',
        );
        const marketActive = document.querySelector(
          '[data-testid="global-market-switcher"] [aria-pressed="true"], [data-testid="global-market-switcher"] [aria-checked="true"], [data-testid="global-market-switcher"] .ant-segmented-item-selected, [data-testid="global-market-switcher"] .active',
        );
        return {
          navBottom: nav?.getBoundingClientRect().bottom ?? 0,
          accountTop: account?.getBoundingClientRect().top ?? 0,
          selectedFound: Boolean(selectedItem),
          marketActiveFound: Boolean(marketActive),
          selectedBg: selectedItem ? window.getComputedStyle(selectedItem).backgroundColor : '',
          marketActiveBg: marketActive ? window.getComputedStyle(marketActive).backgroundColor : '',
        };
      });
      expect(siderGeometry.accountTop).toBeGreaterThan(siderGeometry.navBottom - 10);
      expect(siderGeometry.selectedFound, 'Selected sidebar menu item must exist').toBe(true);
      expect(siderGeometry.marketActiveFound, 'Active market toggle item must exist').toBe(true);

      // Neutral selection background (never bright solid Phosphor #c5f04a or translucent Phosphor wash)
      const isPhosphorFillOrWash = (rgb: RgbColor | null): boolean =>
        Boolean(rgb && rgb.r > 150 && rgb.g > 200 && rgb.b < 110 && rgb.a >= 0.06);

      const selectedBgRgb = parseColor(siderGeometry.selectedBg);
      expect(
        isPhosphorFillOrWash(selectedBgRgb),
        `Selected menu item must use neutral bg, not Phosphor wash (${siderGeometry.selectedBg})`,
      ).toBe(false);

      const marketBgRgb = parseColor(siderGeometry.marketActiveBg);
      expect(
        isPhosphorFillOrWash(marketBgRgb),
        `Active market toggle must use neutral selection bg, not solid or translucent Phosphor (${siderGeometry.marketActiveBg})`,
      ).toBe(false);

      assertNoConsoleOrPageErrors(merchantCollector);
    } finally {
      await merchantCtx.close();
    }

    // 2. Admin Context: still strictly 5 .ant-menu-item + quiet 运营后台 link outside .ant-menu above account
    const adminSession = getAdminSession();
    const { context: adminCtx, page: adminPage } = await createAuthenticatedContext(
      browser,
      adminSession,
      { viewport: VP_DESKTOP },
    );
    const adminCollector = attachErrorCollector(adminPage);

    try {
      await adminPage.goto('/home', { waitUntil: 'domcontentloaded' });
      const adminSider = adminPage.locator('aside.ant-layout-sider');
      await expect(adminSider).toBeVisible({ timeout: 20_000 });
      await expect(adminSider.locator('.ant-menu-item')).toHaveCount(5);

      const adminLink = adminSider.getByRole('link', { name: '运营后台' }).first();
      await expect(adminLink).toBeVisible({ timeout: 10_000 });

      const adminLinkAudit = await adminPage.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('aside.ant-layout-sider a'),
        );
        const target = links.find((a) => (a.textContent ?? '').includes('运营后台'));
        const account = document.querySelector<HTMLElement>('[data-testid="sider-account-entry"]');
        if (!target || !account) return null;
        return {
          insideMenu: target.closest('.ant-menu') !== null,
          adminBottom: target.getBoundingClientRect().bottom,
          accountTop: account.getBoundingClientRect().top,
        };
      });
      expect(adminLinkAudit, 'Admin link and account entry must exist in sider').toBeTruthy();
      expect(adminLinkAudit!.insideMenu, 'Admin 运营后台 link must be OUTSIDE .ant-menu').toBe(
        false,
      );
      expect(
        adminLinkAudit!.adminBottom,
        'Admin 运营后台 link must sit above sider-account-entry',
      ).toBeLessThanOrEqual(adminLinkAudit!.accountTop + 12);

      await adminLink.click();
      await expect(adminPage).toHaveURL(/\/admin\/tenants/, { timeout: 15_000 });
      assertNoConsoleOrPageErrors(adminCollector);
    } finally {
      await adminCtx.close();
    }
  });

  test('SI-T1-03: /studio auto-collapsed 72px expandable icon rail (12px short labels, full accessible names, 180-deg arrow & openWorkspaceNav)', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 'sit103');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit103', initialPoints: 100 });
    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_DESKTOP,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    try {
      await page.goto(`/studio?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });

      const sider = page.locator('aside.ant-layout-sider');
      await expect(sider).toBeVisible();

      // 1. Auto-collapsed 72px rail (64..84px)
      const collapsedBox = await sider.boundingBox();
      expect(collapsedBox, 'Sider bounding box must exist on /studio').toBeTruthy();
      expect(collapsedBox!.width).toBeGreaterThanOrEqual(64);
      expect(collapsedBox!.width).toBeLessThanOrEqual(84);

      // 2. Visible 2-char short labels >= 12px (首页 / 品牌 / 诊断 / 写作 / 发布)
      for (const shortLabel of ['首页', '品牌', '诊断', '写作', '发布']) {
        const labelEl = sider.getByText(shortLabel, { exact: true }).first();
        await expect(
          labelEl,
          `Short label '${shortLabel}' must be visible on 72px rail`,
        ).toBeVisible();
        const fs = await labelEl.evaluate((el) =>
          Number.parseFloat(window.getComputedStyle(el).fontSize),
        );
        expect(
          fs,
          `Short label '${shortLabel}' fontSize (${fs}px) must be >= 12px`,
        ).toBeGreaterThanOrEqual(12);
      }

      // 3. Full accessible names preserved while collapsed at 72px (unified 2-char nav labels)
      for (const fullName of ['首页', '品牌', '诊断', '写作', '发布']) {
        const item = sider
          .getByRole('menuitem', { name: fullName, exact: true })
          .or(sider.getByRole('link', { name: fullName, exact: true }))
          .first();
        await expect(
          item,
          `Accessible item '${fullName}' must stay visible on collapsed 72px rail`,
        ).toBeVisible();
      }

      // 4. Bottom 180-deg rotating expand/collapse toggle
      const toggleBtn = sider
        .locator('button[aria-controls="gm-sider-nav"]')
        .or(sider.getByRole('button', { name: /展开|收起/ }))
        .last();
      await expect(toggleBtn).toBeVisible({ timeout: 10_000 });

      const readToggleState = async () =>
        toggleBtn.evaluate((btn) => {
          const transforms = [
            btn,
            ...Array.from(btn.querySelectorAll<HTMLElement | SVGElement>('*')),
          ]
            .map((el) => window.getComputedStyle(el).transform)
            .filter((t) => Boolean(t) && t !== 'none');
          return {
            expanded: btn.getAttribute('aria-expanded'),
            transforms,
          };
        });
      const maxRotationDeg = (transforms: string[]) =>
        transforms.reduce((best, t) => Math.max(best, extractRotationDegrees(t)), 0);

      const collapsedState = await readToggleState();
      const collapsedDeg = maxRotationDeg(collapsedState.transforms);

      await toggleBtn.click();
      await page.waitForTimeout(320);

      const expandedBox = await sider.boundingBox();
      expect(expandedBox!.width, 'Expanded rail width must be ~220px').toBeGreaterThanOrEqual(180);
      expect(expandedBox!.width, 'Expanded rail width must be ~220px').toBeLessThanOrEqual(260);

      const expandedState = await readToggleState();
      const expandedDeg = maxRotationDeg(expandedState.transforms);
      expect(expandedState.expanded).toBe('true');
      expect(
        Math.abs(expandedDeg - collapsedDeg),
        `Toggle arrow must rotate 180° (collapsed=${collapsedDeg}°, expanded=${expandedDeg}°, transforms=${JSON.stringify(expandedState.transforms)})`,
      ).toBeGreaterThanOrEqual(170);

      // Collapse back to 72px
      await toggleBtn.click();
      await page.waitForTimeout(320);

      const recollapsedBox = await sider.boundingBox();
      expect(recollapsedBox!.width).toBeGreaterThanOrEqual(64);
      expect(recollapsedBox!.width).toBeLessThanOrEqual(84);
      expect((await readToggleState()).expanded).toBe('false');

      // 5. openWorkspaceNav works directly from collapsed 72px rail
      await openWorkspaceNav(page, { itemTitle: '首页', expectedUrl: /\/home/ });
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 15_000 });
      const homeSiderBox = await sider.boundingBox();
      expect(homeSiderBox!.width).toBeGreaterThanOrEqual(180);

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// Tier 2 — Multi-Viewport Overflow, Typography, Container Bounds & P2
// ============================================================================

test.describe('Tier 2 — Multi-Viewport Overflow, Typography, Bounds & P2', () => {
  test('SI-T2-01: Multi-viewport (1440x900, 1280x800, 390x844) zero horizontal overflow, zero < 12px CJK, zero desktop vertical wrap & zero errors across all 6 core routes', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const tag = uniqueTag(testInfo, 'sit201');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit201', initialPoints: 250 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const engines = await pickOnlineEngines(tenant.session, brand.id, 'CN', 1);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'CN',
        engines,
        prompts: [`静音四盘位家用私有云 NAS 推荐 ${tag}`],
      },
      uniqueIdemKey('sit201-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const article = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `静音四盘位家用私有云 NAS 实测指南 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'sit201-art',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_DESKTOP,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    const auditRoute = async (label: string) => {
      await waitForSettledContent(page);
      await page.setViewportSize(VP_DESKTOP);
      await page.waitForTimeout(100);
      await assertZeroTinyCjk(page);
      await assertZeroDesktopVerticalCjkWrap(page, `${label} @1440x900`);
      await page.setViewportSize(VP_LAPTOP);
      await page.waitForTimeout(100);
      await assertZeroDesktopVerticalCjkWrap(page, `${label} @1280x800`);
      await assertOverflowAcrossViewports(page, CORE_VIEWPORTS, label);
    };

    try {
      // 1. /home
      await page.goto(`/home?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 20_000 });
      await auditRoute('/home');

      // 2. /brands
      await page.goto(`/brands?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#brand-section-identity')).toBeVisible({ timeout: 20_000 });
      await auditRoute('/brands');

      // 3. /visibility (all 3 tabs: overview, runs, citations)
      await page.goto(`/visibility?brandId=${brand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.gm-workspace-main')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      for (const tab of ['overview', 'runs', 'citations'] as const) {
        await openVisibilityTab(page, tab);
        await page.waitForTimeout(150);
        await auditRoute(`/visibility[${tab}]`);
      }

      // 4. /studio
      await page.goto(`/studio?brandId=${brand.id}&market=CN&articleId=${article.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await auditRoute('/studio');

      // 4b. /publish
      await page.goto(`/publish?brandId=${brand.id}&market=CN&articleId=${article.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('publish-workspace')).toBeVisible({ timeout: 20_000 });
      await auditRoute('/publish');

      // 5. /account (all 3 tabs: 点数明细, 账号权益, 扩展配对)
      await page.goto('/account', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.gm-workspace-main')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      for (const tabName of ['点数明细', '账号权益', '扩展配对']) {
        const tabBtn = page.getByRole('tab', { name: tabName }).first();
        await expect(tabBtn).toBeVisible({ timeout: 10_000 });
        await tabBtn.click();
        await page.waitForTimeout(150);
        await auditRoute(`/account[${tabName}]`);
      }

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }

    // 6. Unauthenticated /login in fresh incognito context
    const loginCtx = await browser.newContext({ viewport: VP_DESKTOP });
    const loginPage = await loginCtx.newPage();
    const loginCollector = attachErrorCollector(loginPage);
    const loginCdnHits = attachFontLeakCollector(loginPage);

    try {
      await loginPage.goto(`${WEB_BASE}/login`, { waitUntil: 'domcontentloaded' });
      await expect(loginPage.getByRole('button', { name: /登录/ }).first()).toBeVisible({
        timeout: 15_000,
      });
      await assertDarkSurfaceBackground(loginPage, '/login');
      await assertZeroTinyCjk(loginPage);
      await assertZeroDesktopVerticalCjkWrap(loginPage, '/login @1440x900');
      await assertOverflowAcrossViewports(loginPage, CORE_VIEWPORTS, '/login');
      expect(loginCdnHits, 'Zero external font CDN or third-party font requests on /login').toEqual(
        [],
      );
      const loginPrimaries = await getVisiblePrimaryButtons(loginPage, 'body');
      expect(loginPrimaries.length, '/login must have exactly 1 primary CTA').toBe(1);
      assertNoConsoleOrPageErrors(loginCollector);
    } finally {
      await loginCtx.close();
    }
  });

  test('SI-T2-02: Route-typed max-width containers at 1920x1080 & 1440x900 (1360/1040/720px prose 15px/1.75) & scoped single Phosphor primary CTA (P2)', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'sit202');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit202', initialPoints: 250 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const engines = await pickOnlineEngines(tenant.session, brand.id, 'CN', 1);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'CN',
        engines,
        prompts: [`静音四盘位家用私有云 NAS 深度实测 ${tag}`],
      },
      uniqueIdemKey('sit202-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const article = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `静音四盘位家用私有云 NAS 散热与噪声评测 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'sit202-art',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_ULTRAWIDE,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    const assertCenteredCappedContainer = async (
      containerSelector: string,
      maxWidth: number,
      label: string,
    ) => {
      const metrics = await page.evaluate((sel) => {
        const el = document.querySelector<HTMLElement>(sel);
        const content =
          document.querySelector<HTMLElement>('.gm-content') ??
          document.querySelector<HTMLElement>('main') ??
          document.body;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cr = content.getBoundingClientRect();
        return {
          width: r.width,
          leftGap: r.left - cr.left,
          rightGap: cr.right - r.right,
        };
      }, containerSelector);
      expect(metrics, `Container ${containerSelector} missing on ${label}`).toBeTruthy();
      expect(
        metrics!.width,
        `${label} width (${Math.round(metrics!.width)}px) must be <= ${maxWidth}px`,
      ).toBeLessThanOrEqual(maxWidth);
      expect(
        Math.abs(metrics!.leftGap - metrics!.rightGap),
        `${label} must be horizontally centered at 1920x1080 (leftGap=${Math.round(metrics!.leftGap)}, rightGap=${Math.round(metrics!.rightGap)})`,
      ).toBeLessThanOrEqual(28);
    };

    try {
      // 1. /home at 1920x1080: <= 1368px centered + strictly 1 Phosphor primary CTA (P2) + 0 in header
      await page.setViewportSize(VP_ULTRAWIDE);
      await page.goto(`/home?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 20_000 });
      await assertCenteredCappedContainer(
        '[data-testid="home-workspace"]',
        1368,
        '/home @1920x1080',
      );

      const headerPrimaries = await getVisiblePrimaryButtons(page, 'header.gm-header');
      expect(
        headerPrimaries,
        'Header must contain 0 primary CTA buttons when brand exists',
      ).toEqual([]);

      const homePrimaries = await getVisiblePrimaryButtons(page, '[data-testid="home-workspace"]');
      expect(
        homePrimaries.length,
        `/home must have strictly 1 visible primary CTA (reconciling monitor vs ROI CTA); got: ${homePrimaries.map((b) => b.text).join(', ')}`,
      ).toBe(1);
      expect(toNormalizedHex(homePrimaries[0]!.bg)).toBe('#c5f04a');
      const primaryFg = parseColor(homePrimaries[0]!.color);
      expect(primaryFg && relativeLuminance(primaryFg)).toBeLessThan(0.08);

      // 2. /visibility at 1920x1080: ALL visible children <= 1368px centered + <= 1 primary CTA (P2)
      await page.goto(`/visibility?brandId=${brand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.gm-workspace-main > *').first()).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      await assertAllWorkspaceChildrenWithin(page, 1368, '/visibility @1920x1080', true);
      const visPrimaries = await getVisiblePrimaryButtons(page, '.gm-workspace-main');
      expect(
        visPrimaries.length,
        `/visibility must keep <= 1 visible primary CTA (P2); got: ${visPrimaries.map((b) => b.text).join(', ')}`,
      ).toBeLessThanOrEqual(1);

      // 3. /brands right settings content column <= 1048px at 1920x1080 & 1440x900 + <= 1 primary CTA (P2)
      await page.goto(`/brands?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#brand-section-identity')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      for (const vp of [VP_ULTRAWIDE, VP_DESKTOP]) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(100);
        const identityBox = await page.locator('#brand-section-identity').boundingBox();
        expect(identityBox).toBeTruthy();
        expect(
          identityBox!.width,
          `/brands right content column width at ${vp.width}x${vp.height} must be <= 1048px`,
        ).toBeLessThanOrEqual(1048);
      }
      const brandPrimaries = await getVisiblePrimaryButtons(page, '.gm-workspace-main');
      expect(
        brandPrimaries.length,
        `/brands must keep <= 1 visible primary CTA at rest (P2); got: ${brandPrimaries.map((b) => b.text).join(', ')}`,
      ).toBeLessThanOrEqual(1);

      // 4. /account ALL visible children <= 1048px at 1920x1080 & 1440x900
      await page.goto('/account', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.gm-workspace-main > *').first()).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      for (const vp of [VP_ULTRAWIDE, VP_DESKTOP]) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(100);
        await assertAllWorkspaceChildrenWithin(
          page,
          1048,
          `/account @${vp.width}x${vp.height}`,
          false,
        );
      }

      // 5. /studio at 1920x1080 AND 1440x900: prose <= 724px (genuinely enforces max-width: 720px) + strictly 1 Phosphor primary CTA
      await page.setViewportSize(VP_ULTRAWIDE);
      await page.goto(`/studio?brandId=${brand.id}&market=CN&articleId=${article.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('studio-preview-body')).toBeVisible({ timeout: 15_000 });
      await assertProseMeasureAndTypography(
        page,
        '[data-testid="studio-preview-body"]',
        '/studio preview @1920x1080',
      );

      await page.setViewportSize(VP_DESKTOP);
      await page.waitForTimeout(100);
      await assertProseMeasureAndTypography(
        page,
        '[data-testid="studio-preview-body"]',
        '/studio preview @1440x900',
      );

      const studioPrimaries = await getVisiblePrimaryButtons(
        page,
        '[data-testid="studio-workspace"]',
      );
      expect(
        studioPrimaries.length,
        `/studio must have strictly 1 visible primary CTA (footer state machine); got: ${studioPrimaries.map((b) => b.text).join(', ')}`,
      ).toBe(1);

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await page.setViewportSize(VP_DESKTOP);
      await context.close();
    }
  });
});

// ============================================================================
// Tier 3 — Core Workspaces Visual Contracts (/home, /visibility, /brands)
// ============================================================================

test.describe('Tier 3 — Core Workspaces Visual Contracts', () => {
  test('SI-T3-01: /home honest KpiStrip (0% empty track, — avgPosition, 0 sparklines) & above-the-fold P0 crawl alert banner + graded recent articles', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'sit301');

    // ── Case A: Zero-Run Brand (Honest Empty KPIs & Compact Briefs EmptyState) ──
    const tenantEmpty = await provisionIsolatedTenant({ prefix: 'sit301a', initialPoints: 100 });
    const emptyBrand = await createBrandApi(tenantEmpty.session, buildCnBrandPayload(`${tag}a`));
    const { context: emptyCtx, page: emptyPage } = await createAuthenticatedContext(
      browser,
      tenantEmpty.session,
      {
        viewport: VP_DESKTOP,
        preseedWorkspace: { activeBrandId: emptyBrand.id, activeMarket: 'CN' },
      },
    );
    const emptyCollector = attachErrorCollector(emptyPage);

    try {
      await emptyPage.goto(`/home?brandId=${emptyBrand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      const healthStrip = emptyPage.getByTestId('home-health-strip');
      await expect(healthStrip).toBeVisible({ timeout: 20_000 });
      await expect(emptyPage.getByTestId('home-kpi-mention')).toBeVisible();
      await expect(emptyPage.getByTestId('home-kpi-sov')).toBeVisible();
      await expect(emptyPage.getByTestId('home-kpi-position')).toBeVisible();
      await expect(emptyPage.getByTestId('home-kpi-owned')).toBeVisible();

      // Zero fabricated sparkline SVGs
      const sparklineCount = await healthStrip.evaluate((root) => {
        const svgs = Array.from(root.querySelectorAll('svg'));
        return svgs.filter((svg) => {
          const r = svg.getBoundingClientRect();
          return r.width > 40 && svg.querySelector('polyline, path') !== null;
        }).length;
      });
      expect(sparklineCount, 'Zero fabricated sparkline SVGs allowed in home-health-strip').toBe(0);

      // 0% mention progress track must exist and EVERY fill element MUST have width === 0 (no fake 2% stub)
      await expect(emptyPage.getByTestId('home-kpi-mention')).toContainText(/0(?:\.0)?%/);
      const mentionTrackAudit = await emptyPage.getByTestId('home-kpi-mention').evaluate((el) => {
        const getClassStr = (node: Element): string => node.getAttribute('class') ?? '';

        const tracks = Array.from(
          el.querySelectorAll<HTMLElement>(
            '[role="progressbar"], [class*="track"], [class*="meter"], [class*="progress"], [class*="bar"]',
          ),
        ).filter((node) => {
          const s = window.getComputedStyle(node);
          const r = node.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        });

        const fillWidths: number[] = [];
        const seenFillNodes = new Set<Element>();
        const recordFillNode = (node: Element) => {
          if (seenFillNodes.has(node)) return;
          seenFillNodes.add(node);
          fillWidths.push(Math.round(node.getBoundingClientRect().width));
        };

        // (a) Explicit fill elements (excluding track wrapper SVGs)
        for (const node of Array.from(
          el.querySelectorAll('[class*="fill"], [data-testid*="progress-fill"], .ant-progress-bg'),
        )) {
          if (node.matches('[class*="track-svg"]')) continue;
          recordFillNode(node);
        }

        // (b) SVG shape primitives inside progressbar
        for (const shape of Array.from(
          el.querySelectorAll(
            '[role="progressbar"] svg rect, [role="progressbar"] svg path, [role="progressbar"] svg line, [role="progressbar"] svg polygon',
          ),
        )) {
          recordFillNode(shape);
        }

        // (c) Direct leaf non-wrapper HTML children of [role="progressbar"]
        // (d) Direct thin [role="progressbar"] fill bars + non-zero aria-valuenow
        const nonZeroAriaValues: number[] = [];
        const progressBars = Array.from(el.querySelectorAll<HTMLElement>('[role="progressbar"]'));
        for (const pb of progressBars) {
          for (const child of Array.from(pb.children)) {
            const tag = child.tagName.toLowerCase();
            const cls = getClassStr(child);
            if (tag !== 'svg' && child.children.length === 0 && !/track|outer|inner/i.test(cls)) {
              recordFillNode(child);
            }
          }

          const ariaNow = pb.getAttribute('aria-valuenow');
          const parsedAria = ariaNow !== null ? Number.parseFloat(ariaNow) : Number.NaN;
          if (Number.isFinite(parsedAria) && parsedAria !== 0) {
            nonZeroAriaValues.push(parsedAria);
          }

          const pbRect = pb.getBoundingClientRect();
          const parentRect = pb.parentElement?.getBoundingClientRect();
          const bg = window.getComputedStyle(pb).backgroundColor;
          const hasOpaqueBg = Boolean(
            bg &&
            bg !== 'transparent' &&
            !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/i.test(bg),
          );
          const isDirectThinFill =
            pb.children.length === 0 &&
            parentRect !== undefined &&
            pbRect.width < parentRect.width - 2 &&
            pbRect.height <= 12 &&
            (hasOpaqueBg || (Number.isFinite(parsedAria) && parsedAria > 0));
          if (isDirectThinFill) {
            recordFillNode(pb);
          }
        }

        return { trackCount: tracks.length, nonZeroAriaValues, fillWidths };
      });
      expect(
        mentionTrackAudit.trackCount,
        '0% home-kpi-mention must render at least 1 visible progress track element',
      ).toBeGreaterThanOrEqual(1);
      expect(
        mentionTrackAudit.nonZeroAriaValues,
        '0% home-kpi-mention progressbar aria-valuenow must be 0',
      ).toEqual([]);
      for (const w of mentionTrackAudit.fillWidths) {
        expect(w, '0% KPI progress fill must have width === 0 (no fake 2% stub)').toBe(0);
      }

      // avgPosition shows '—' (no NaN or #0.0)
      const posText = await emptyPage.getByTestId('home-kpi-position').innerText();
      expect(posText).toContain('—');
      expect(posText).not.toContain('NaN');
      expect(posText).not.toContain('#0');

      // Compact empty briefs CTA navigates to /studio
      const studioEmptyCta = emptyPage
        .getByTestId('home-top-briefs')
        .getByRole('button', { name: /去写作|去写作台/ })
        .or(emptyPage.getByTestId('home-top-briefs').getByRole('link', { name: /去写作|去写作台/ }))
        .first();
      await expect(studioEmptyCta).toBeVisible({ timeout: 10_000 });
      const emptyCtaHref = await studioEmptyCta.getAttribute('href');
      if (emptyCtaHref) {
        expect(emptyCtaHref, 'Empty briefs CTA href must point to /studio').toContain('/studio');
      } else {
        await studioEmptyCta.click();
        await expect(emptyPage).toHaveURL(/\/studio/, { timeout: 15_000 });
        await emptyPage.goBack({ waitUntil: 'domcontentloaded' });
        await expect(emptyPage.getByTestId('home-health-strip')).toBeVisible({ timeout: 15_000 });
      }

      assertNoConsoleOrPageErrors(emptyCollector);
    } finally {
      await emptyCtx.close();
    }

    // ── Case B: Seeded Run + Blocked Crawl Alert Above Fold + Reverse-Chronological Articles ──
    const tenantLive = await provisionIsolatedTenant({ prefix: 'sit301b', initialPoints: 250 });
    const liveToken = tenantLive.session.accessToken;
    const liveBrand = await createBrandApi(tenantLive.session, buildCnBrandPayload(`${tag}b`));
    await upsertBrandFactsApi(
      tenantLive.session,
      liveBrand.id,
      buildFourBrandFacts(liveBrand.name),
      true,
    );

    const engines = await pickOnlineEngines(tenantLive.session, liveBrand.id, 'CN', 1);
    const run = await createVisibilityRunApi(
      tenantLive.session,
      liveBrand.id,
      {
        market: 'CN',
        engines,
        prompts: [`静音四盘位家用私有云 NAS 推荐 ${liveBrand.name} ${tag}`],
      },
      uniqueIdemKey('sit301-run'),
    );
    await waitForVisibilityRunApi(tenantLive.session, liveBrand.id, run.id, 45_000);

    const olderArticle = await seedArticleViaSse(
      liveToken,
      liveBrand.id,
      {
        market: 'CN',
        targetPrompt: `早期草稿文章 静音 NAS 对比 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'sit301-art1',
    );
    const newerArticle = await seedArticleViaSse(
      liveToken,
      liveBrand.id,
      {
        market: 'CN',
        targetPrompt: `最新上线文章 4K 影音私有云评测 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'sit301-art2',
    );

    const blockedRec = unwrapOk(
      await requestV2<{ id: string }>(`/articles/${newerArticle.id}/publish-records`, {
        method: 'POST',
        token: liveToken,
        body: {
          publishedUrl: `https://crawl-blocked.e2e.example/articles/${tag}-blocked`,
          channel: '品牌官网博客',
          autoRetest: { enabled: false },
        },
      }),
      'Create blocked publish record',
    );
    unwrapOk(
      await requestV2(`/publish-records/${blockedRec.id}/crawl-probe`, {
        method: 'POST',
        token: liveToken,
        body: {},
      }),
      'Trigger crawl probe on blocked URL',
    );

    const { context: liveCtx, page: livePage } = await createAuthenticatedContext(
      browser,
      tenantLive.session,
      {
        viewport: VP_DESKTOP,
        preseedWorkspace: { activeBrandId: liveBrand.id, activeMarket: 'CN' },
      },
    );
    const liveCollector = attachErrorCollector(livePage);

    try {
      await livePage.goto(`/home?brandId=${liveBrand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(livePage.getByTestId('home-health-strip')).toBeVisible({ timeout: 20_000 });
      const alertBanner = livePage.getByTestId('home-crawl-alerts');
      await expect(alertBanner).toBeVisible({ timeout: 15_000 });
      await expect(livePage.getByTestId(`home-crawl-alert-${blockedRec.id}`)).toBeVisible();
      await expect(
        alertBanner
          .getByRole('button', { name: /立即排查/ })
          .or(alertBanner.getByRole('link', { name: /立即排查/ }))
          .first(),
      ).toBeVisible();

      // Geometry: directly below home-health-strip, above fold (<= 900), above briefs/recent articles
      const geom = await livePage.evaluate(() => {
        const kpi = document.querySelector('[data-testid="home-health-strip"]');
        const alerts = document.querySelector('[data-testid="home-crawl-alerts"]');
        const briefs = document.querySelector('[data-testid="home-top-briefs"]');
        const articles = document.querySelector('[data-testid="home-recent-articles"]');
        if (!kpi || !alerts) return null;
        const nextBlock = briefs ?? articles;
        return {
          kpiBottom: kpi.getBoundingClientRect().bottom,
          alertTop: alerts.getBoundingClientRect().top,
          alertBottom: alerts.getBoundingClientRect().bottom,
          nextTop: nextBlock ? nextBlock.getBoundingClientRect().top : 9999,
        };
      });
      expect(geom).toBeTruthy();
      expect(geom!.alertTop).toBeGreaterThan(0);
      expect(
        geom!.alertBottom,
        'P0 crawl alert banner must appear above the 900px fold',
      ).toBeLessThanOrEqual(900);
      expect(
        geom!.alertTop,
        'P0 crawl alert must appear below home-health-strip',
      ).toBeGreaterThanOrEqual(geom!.kpiBottom - 8);
      expect(
        geom!.alertBottom,
        'P0 crawl alert must be hoisted above briefs/recent articles',
      ).toBeLessThanOrEqual(geom!.nextTop + 16);

      // Plain-language avgPosition caption: non-empty, zero NaN, and whenever numeric MUST include plain-language rank copy
      const livePosText = (await livePage.getByTestId('home-kpi-position').innerText()).trim();
      expect(livePosText.length, 'home-kpi-position must render non-empty copy').toBeGreaterThan(0);
      expect(livePosText).not.toContain('NaN');
      const livePosBody = livePosText.replace(/平均顺位/g, '').trim();
      if (/\d/.test(livePosBody)) {
        expect(
          livePosBody,
          `Numeric avgPosition must render plain-language rank caption (got '${livePosText}')`,
        ).toMatch(/第\s*\d+(?:\.\d+)?\s*[位名]|排在第|多数回答|前\s*\d+\s*位|首位|前列|排名第/);
      }

      // Recent articles reverse-chronological order (newer before older) & no primary button inside list
      const recentSection = livePage.getByTestId('home-recent-articles');
      await expect(recentSection).toBeVisible({ timeout: 10_000 });
      const recentText = await recentSection.innerText();
      const idxNew = recentText.indexOf(newerArticle.title);
      const idxOld = recentText.indexOf(olderArticle.title);
      expect(idxNew, 'Newer article must appear in recent articles').toBeGreaterThanOrEqual(0);
      expect(idxOld, 'Older article must appear in recent articles').toBeGreaterThanOrEqual(0);
      expect(idxNew, 'Recent articles must be reverse-chronological').toBeLessThan(idxOld);

      const recentPrimaries = await getVisiblePrimaryButtons(
        livePage,
        '[data-testid="home-recent-articles"]',
      );
      expect(
        recentPrimaries,
        'Recent articles list must not render bright primary buttons',
      ).toEqual([]);

      assertNoConsoleOrPageErrors(liveCollector);
    } finally {
      await liveCtx.close();
    }
  });

  test('SI-T3-02: /visibility KpiStrip (no colored top borders), 12-col chart layout, monochrome competitor SoV bars & Near-Miss cleanliness', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 'sit302');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit302', initialPoints: 200 });

    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const engines = await pickOnlineEngines(tenant.session, brand.id, 'CN', 2);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'CN',
        engines,
        prompts: [
          `静音四盘位家用私有云 NAS 对比 ${brand.name} ${tag}`,
          `${E2E_SENTINELS.LOW_RANK} 四盘位家庭影音 NAS 推荐哪家 ${tag}`,
        ],
      },
      uniqueIdemKey('sit302-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 60_000);

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_DESKTOP,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    try {
      await page.goto(`/visibility?brandId=${brand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.gm-workspace-main')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(page);
      await expect(page.locator('.gm-sov-row, [data-testid*="sov-bar"]').first()).toBeVisible({
        timeout: 20_000,
      });

      // 1. No bright colored top-border accent stripes on KPI strip items (>= 4 KPI cells verified)
      const forbiddenTopBorderHexes = new Set([
        '#3de0c8',
        '#c5f04a',
        '#ff7a59',
        '#f2b84b',
        '#6fa8ff',
      ]);
      const kpiTopBorders = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[class*="kpi-strip"] > *, [class*="kpi-item"], [class*="kpi-cell"], .gm-overview-kpi-grid > *, [data-testid*="kpi"]',
          ),
        );
        const seen = new Set<HTMLElement>();
        const visible = candidates.filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 40 && r.height > 24;
        });
        const leafKpiItems = visible.filter(
          (el) => !visible.some((other) => other !== el && el.contains(other)),
        );
        return leafKpiItems.map((el) => {
          const s = window.getComputedStyle(el);
          return { width: s.borderTopWidth, color: s.borderTopColor };
        });
      });
      expect(
        kpiTopBorders.length,
        'Expected at least 4 visible KPI cells on /visibility overview',
      ).toBeGreaterThanOrEqual(4);
      for (const b of kpiTopBorders) {
        const hex = toNormalizedHex(b.color);
        if (Number.parseFloat(b.width) >= 2) {
          expect(
            forbiddenTopBorderHexes.has(hex),
            `KPI item must not have colored top accent stripe (${b.width} ${hex})`,
          ).toBe(false);
        }
      }

      // 2. Desktop 1440x900 12-col multi-panel chart layout within <= 1368px container (side-by-side, non-overlapping)
      const chartGridAudit = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('.gm-workspace-main');
        if (!main) return null;
        const mainRect = main.getBoundingClientRect();
        const titleNeedles = ['声呐盘', '提及趋势', '竞品声量', '情感分布'];
        const panelSelector =
          '.ant-card, section, .gm-panel, [class*="chart-panel"], [class*="vis-panel"], .ant-col > div, [class*="grid"] > div';
        const panels: Array<{
          title: string;
          left: number;
          right: number;
          top: number;
          width: number;
        }> = [];
        for (const needle of titleNeedles) {
          const heading: HTMLElement | undefined = Array.from(
            main.querySelectorAll<HTMLElement>(
              'h2, h3, h4, .ant-card-head-title, .gm-section-title, [class*="panel-title"], [class*="section-title"], [class*="chart-title"]',
            ),
          ).find((el) => (el.textContent ?? '').includes(needle));
          if (!heading) continue;

          let matchedPanel: HTMLElement | null = null;
          let fallbackPanel: HTMLElement | null = null;
          let cur: HTMLElement | null = heading.parentElement;
          while (cur && cur !== main && main.contains(cur)) {
            const cls = cur.getAttribute('class') ?? '';
            if (!/head|header|title/i.test(cls)) {
              const cr = cur.getBoundingClientRect();
              if (cr.width > 120 && cr.height > 80) {
                if (cur.matches(panelSelector)) {
                  matchedPanel = cur;
                  break;
                }
                if (!fallbackPanel && cr.width < mainRect.width * 0.98) {
                  fallbackPanel = cur;
                }
              }
            }
            cur = cur.parentElement;
          }

          const panel = matchedPanel ?? fallbackPanel;
          if (!panel) continue;
          const r = panel.getBoundingClientRect();
          panels.push({
            title: needle,
            left: Math.round(r.left),
            right: Math.round(r.right),
            top: Math.round(r.top),
            width: Math.round(r.width),
          });
        }
        const uniquePanels = panels.filter(
          (p, idx, arr) =>
            arr.findIndex(
              (o) =>
                Math.abs(o.left - p.left) <= 4 &&
                Math.abs(o.top - p.top) <= 4 &&
                Math.abs(o.width - p.width) <= 4,
            ) === idx,
        );
        let hasSideBySidePair = false;
        for (let i = 0; i < uniquePanels.length; i += 1) {
          for (let j = i + 1; j < uniquePanels.length; j += 1) {
            const a = uniquePanels[i]!;
            const b = uniquePanels[j]!;
            const alignedTop = Math.abs(a.top - b.top) <= 48;
            const nonOverlappingX = a.right <= b.left + 4 || b.right <= a.left + 4;
            if (alignedTop && nonOverlappingX) {
              hasSideBySidePair = true;
            }
          }
        }
        const totalSpan =
          uniquePanels.length > 0
            ? Math.max(...uniquePanels.map((p) => p.right)) -
              Math.min(...uniquePanels.map((p) => p.left))
            : 0;
        return {
          panelCount: uniquePanels.length,
          hasSideBySidePair,
          totalSpan,
          panels: uniquePanels,
        };
      });
      expect(chartGridAudit, '/visibility chart grid requires .gm-workspace-main').toBeTruthy();
      expect(
        chartGridAudit!.panelCount,
        'Expected at least 2 visible chart panels on /visibility overview',
      ).toBeGreaterThanOrEqual(2);
      expect(
        chartGridAudit!.hasSideBySidePair,
        `Desktop 12-col chart layout at 1440x900 must align at least 2 chart panels side-by-side without horizontal overlap (got: ${JSON.stringify(chartGridAudit!.panels)})`,
      ).toBe(true);
      expect(
        chartGridAudit!.totalSpan,
        `Desktop 12-col chart grid span (${chartGridAudit!.totalSpan}px) must stay within <= 1368px container`,
      ).toBeLessThanOrEqual(1368);

      // 3. Own-brand SoV bar colored vs ALL competitor SoV bars opaque neutral monochrome gray (no gradient/transparent/#ff7a59)
      const sovBars = await page.evaluate((brandName) => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('.gm-sov-row, [data-testid*="sov-row"]'),
        );
        return rows
          .map((row) => {
            const fill = row.querySelector<HTMLElement>(
              '.gm-sov-fill, [data-testid*="sov-bar"], [role="progressbar"] > *',
            );
            if (!fill) return null;
            const text = (row.textContent ?? '').trim();
            const style = window.getComputedStyle(fill);
            const isOwn = text.includes('本品牌') || text.includes(brandName);
            return {
              text: text.slice(0, 30),
              bg: style.backgroundColor,
              bgImage: style.backgroundImage,
              isOwn,
            };
          })
          .filter(
            (item): item is { text: string; bg: string; bgImage: string; isOwn: boolean } =>
              item !== null,
          );
      }, brand.name);

      expect(
        sovBars.length,
        'At least 2 SoV rows (own + competitor) must render',
      ).toBeGreaterThanOrEqual(2);
      const ownBar = sovBars.find((b) => b.isOwn);
      const compBars = sovBars.filter((b) => !b.isOwn);
      expect(ownBar, 'Own-brand SoV row must be present').toBeTruthy();
      expect(
        compBars.length,
        'At least 1 competitor SoV row must be present',
      ).toBeGreaterThanOrEqual(1);

      const ownRgb = parseColor(ownBar!.bg);
      expect(ownRgb).toBeTruthy();
      expect(
        ownRgb!.a,
        `Own-brand SoV bar must have visible non-transparent fill (got ${ownBar!.bg})`,
      ).toBeGreaterThan(0);
      expect(
        Math.max(ownRgb!.r, ownRgb!.g, ownRgb!.b) - Math.min(ownRgb!.r, ownRgb!.g, ownRgb!.b),
        `Own-brand SoV bar must use colored accent/cited fill (got ${ownBar!.bg})`,
      ).toBeGreaterThan(30);

      for (const comp of compBars) {
        const rgb = parseColor(comp.bg);
        expect(rgb, `Unparseable competitor SoV fill: ${comp.bg}`).toBeTruthy();
        expect(
          rgb!.a,
          `Competitor SoV bar '${comp.text}' must have non-transparent fill (got ${comp.bg})`,
        ).toBeGreaterThan(0);
        expect(
          comp.bgImage,
          `Competitor SoV bar '${comp.text}' must not use gradient/image background (got ${comp.bgImage})`,
        ).toBe('none');
        const chroma = Math.max(rgb!.r, rgb!.g, rgb!.b) - Math.min(rgb!.r, rgb!.g, rgb!.b);
        expect(
          toNormalizedHex(comp.bg),
          `Competitor SoV bar '${comp.text}' must not use legacy orange-red #ff7a59`,
        ).not.toBe('#ff7a59');
        expect(
          chroma,
          `Competitor SoV bar '${comp.text}' must be neutral monochrome gray (got ${comp.bg}, chroma=${chroma})`,
        ).toBeLessThanOrEqual(25);
      }

      // 4. Near-Miss panel & /visibility zero < 12px CJK & zero AntD preset <Tag>
      const nearMissPanel = page.getByTestId('visibility-near-miss-panel');
      await expect(nearMissPanel).toBeVisible({ timeout: 15_000 });
      await assertZeroTinyCjk(page, '[data-testid="visibility-near-miss-panel"]');
      await assertZeroPresetAntdTags(page, '[data-testid="visibility-near-miss-panel"]');
      await assertZeroPresetAntdTags(page, '.gm-workspace-main');
      await assertOverflowAcrossViewports(page, [VP_DESKTOP, VP_LAPTOP], '/visibility');

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });

  test('SI-T3-03: /brands settings layout — left sticky anchors (5 CN / 4 GLOBAL), < 1024px sticky top bar, no 1./2./3./4. prefixes, hover delete, sticky dirty bar & ⋯ 删除品牌 confirm', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 'sit303');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit303', initialPoints: 150 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);
    // Ensure CN market has 2 competitors + seed prompts for hover-delete verification
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/CN`, {
        method: 'PATCH',
        token,
        body: {
          competitors: [
            { name: '极空存储', aliases: ['极空Z4'], domains: ['jikong.example'] },
            { name: '群晖', aliases: ['Synology'], domains: ['synology.example'] },
          ],
          seedPrompts: ['静音四盘位家用私有云 NAS 哪家好？', '家庭 4K 影音存储 NAS 推荐'],
        },
      }),
      'Seed CN competitors and seedPrompts',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: VP_DESKTOP,
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'CN' },
    });
    const collector = attachErrorCollector(page);

    try {
      await page.goto(`/brands?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#brand-section-identity')).toBeVisible({ timeout: 20_000 });

      // 1. Desktop (1440x900) left sticky anchors: 5 core sections on CN (extension moved to /account via Y5), right col <= 1048px
      const anchorNav = page
        .locator('nav[aria-label="页面区块跳转"], nav:has(a[href="#brand-section-identity"])')
        .first();
      await expect(anchorNav).toBeVisible({ timeout: 10_000 });

      const coreSectionIds = [
        'brand-section-identity',
        'brand-section-product-lines',
        'brand-section-facts',
        'brand-section-media',
        'brand-section-connections',
      ];
      for (const id of coreSectionIds) {
        await expect(page.locator(`#${id}`), `Section #${id} must exist on CN`).toBeAttached();
        await expect(
          anchorNav.locator(`a[href="#${id}"]`),
          `Anchor link #${id} must be visible on CN`,
        ).toBeVisible();
      }
      await expect(anchorNav.locator('a[href="#brand-section-extension"]')).toHaveCount(0);
      await expect(page.locator('#brand-section-extension')).toHaveCount(0);

      const desktopAnchorGeom = await page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>(
          'nav[aria-label="页面区块跳转"], nav:has(a[href="#brand-section-identity"])',
        );
        const identity = document.querySelector<HTMLElement>('#brand-section-identity');
        if (!nav || !identity) return null;
        const navPos = window.getComputedStyle(nav).position;
        const parentPos = nav.parentElement
          ? window.getComputedStyle(nav.parentElement).position
          : '';
        return {
          navRight: nav.getBoundingClientRect().right,
          identityLeft: identity.getBoundingClientRect().left,
          identityWidth: identity.getBoundingClientRect().width,
          isSticky: navPos === 'sticky' || parentPos === 'sticky',
        };
      });
      expect(desktopAnchorGeom).toBeTruthy();
      expect(desktopAnchorGeom!.isSticky, 'Desktop section anchor nav must be sticky').toBe(true);
      expect(desktopAnchorGeom!.navRight).toBeLessThanOrEqual(desktopAnchorGeom!.identityLeft + 32);
      expect(desktopAnchorGeom!.identityWidth).toBeLessThanOrEqual(1048);

      // 2. Zero 1./2./3./4./5. numbered section prefixes across all 5 CN sections (including h4 headings)
      for (const id of coreSectionIds) {
        const headingText = await page
          .locator(`#${id} h2, #${id} h3, #${id} h4`)
          .first()
          .innerText();
        expect(
          headingText.trim(),
          `Section #${id} heading must not carry numbered prefix (got '${headingText.trim()}')`,
        ).not.toMatch(/^\s*[1-5][.、\s]/);
      }

      // 3. Switch to GLOBAL -> core anchors stay visible (#brand-section-extension absent on both), then switch back to CN
      await switchGlobalMarket(page, 'GLOBAL');
      await expect(anchorNav.locator('a[href="#brand-section-extension"]')).toHaveCount(0);
      await expect(anchorNav.locator('a[href="#brand-section-identity"]')).toBeVisible();
      await expect(anchorNav.locator('a[href="#brand-section-connections"]')).toBeVisible();
      await switchGlobalMarket(page, 'CN');

      // 4. Responsive < 1024px (900x800 & 390x844) sticky top horizontal bar fallback + zero overflow
      for (const narrowVp of [{ width: 900, height: 800 }, VP_MOBILE]) {
        await page.setViewportSize(narrowVp);
        await page.waitForTimeout(150);
        const narrowGeom = await page.evaluate(() => {
          const nav = document.querySelector<HTMLElement>(
            'nav[aria-label="页面区块跳转"], nav:has(a[href="#brand-section-identity"])',
          );
          const identity = document.querySelector<HTMLElement>('#brand-section-identity');
          if (!nav || !identity) return null;
          const links = Array.from(nav.querySelectorAll<HTMLElement>('a'));
          const navPos = window.getComputedStyle(nav).position;
          const parentPos = nav.parentElement
            ? window.getComputedStyle(nav.parentElement).position
            : '';
          return {
            navBottom: nav.getBoundingClientRect().bottom,
            identityTop: identity.getBoundingClientRect().top,
            link0Top: links[0]?.getBoundingClientRect().top ?? 0,
            link1Top: links[1]?.getBoundingClientRect().top ?? 0,
            isSticky: navPos === 'sticky' || parentPos === 'sticky',
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          };
        });
        expect(narrowGeom).toBeTruthy();
        expect(narrowGeom!.isSticky, `Anchor nav must stay sticky at ${narrowVp.width}px`).toBe(
          true,
        );
        expect(narrowGeom!.navBottom).toBeLessThanOrEqual(narrowGeom!.identityTop + 32);
        expect(Math.abs(narrowGeom!.link0Top - narrowGeom!.link1Top)).toBeLessThanOrEqual(12);
        expect(narrowGeom!.scrollWidth).toBeLessThanOrEqual(narrowGeom!.innerWidth + 1);
      }
      await page.setViewportSize(VP_DESKTOP);
      await page.waitForTimeout(120);

      // 5. Zero permanent red-bordered 移除 wall at rest + hover-reveal delete icon
      const identitySec = page.locator('#brand-section-identity');
      await expect(
        identitySec.locator('button.ant-btn-dangerous').filter({ hasText: /^移除$/ }),
      ).toHaveCount(0);

      const deleteBtnSelector =
        'button[aria-label*="移除"], button[aria-label*="删除"], button:has(svg)';
      const competitorRow = identitySec
        .locator('div, li, tr')
        .filter({ has: page.locator('input[value="群晖"]') })
        .filter({ has: page.locator(deleteBtnSelector) })
        .last();
      await expect(competitorRow).toBeVisible({ timeout: 10_000 });
      const labeledDeleteBtn = competitorRow.locator(
        'button[aria-label*="移除"], button[aria-label*="删除"]',
      );
      const rowDeleteBtn =
        (await labeledDeleteBtn.count()) > 0
          ? labeledDeleteBtn.first()
          : competitorRow.locator('button:has(svg)').last();
      await expect(rowDeleteBtn).toBeAttached();

      // Move pointer away to read rest-state effective opacity across button & action wrapper
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      const readEffectiveOpacity = () =>
        rowDeleteBtn.evaluate((btn) => {
          let opacity = 1;
          let cur: HTMLElement | null = btn as HTMLElement;
          for (let depth = 0; depth < 4 && cur && cur !== document.body; depth += 1) {
            const s = window.getComputedStyle(cur);
            if (s.display === 'none' || s.visibility === 'hidden') {
              return 0;
            }
            const val = Number.parseFloat(s.opacity || '1');
            if (Number.isFinite(val)) opacity *= val;
            cur = cur.parentElement;
          }
          return opacity;
        });
      const restOpacity = await readEffectiveOpacity();

      await competitorRow.hover();
      await page.waitForTimeout(180);
      await expect(rowDeleteBtn).toBeVisible({ timeout: 5_000 });
      const hoverOpacity = await readEffectiveOpacity();
      expect(
        restOpacity < 0.5 || hoverOpacity - restOpacity >= 0.35,
        `Competitor row delete icon must stay quiet/hidden at rest and reveal on hover (rest=${restOpacity.toFixed(2)}, hover=${hoverOpacity.toFixed(2)})`,
      ).toBe(true);
      expect(hoverOpacity).toBeGreaterThanOrEqual(0.8);
      await rowDeleteBtn.click();
      await expect(identitySec.locator('input[value="群晖"]')).toHaveCount(0);

      // Discard the competitor deletion via scoped sticky dirty bar to test clean state -> edit -> 放弃 -> edit -> 保存修改
      const dirtyBar = page.getByTestId('brand-dirty-save-bar');
      const dirtyBarText = dirtyBar.getByText(/未保存|有未保存更改/).first();
      await expect(dirtyBar).toBeVisible({ timeout: 10_000 });
      await expect(dirtyBarText).toBeVisible({ timeout: 10_000 });
      await dirtyBar.getByRole('button', { name: '放弃', exact: true }).click();
      await expect(dirtyBar).toBeHidden({ timeout: 10_000 });

      // 6. Sticky dirty-state bar: edit -> 放弃 reverts; edit -> 保存修改 persists
      const brandNameInput = page.locator('input[aria-label="编辑品牌名称"]').first();
      await expect(brandNameInput).toBeVisible({ timeout: 10_000 });
      const originalName = await brandNameInput.inputValue();

      await brandNameInput.fill(`${originalName}-临时改动`);
      await expect(dirtyBarText).toBeVisible({ timeout: 10_000 });
      const barPosition = await dirtyBarText.evaluate((el) => {
        let cur: HTMLElement | null = el as HTMLElement;
        while (cur && cur !== document.body) {
          const pos = window.getComputedStyle(cur).position;
          if (pos === 'sticky' || pos === 'fixed') return pos;
          cur = cur.parentElement;
        }
        return 'static';
      });
      expect(['sticky', 'fixed']).toContain(barPosition);

      await dirtyBar.getByRole('button', { name: '放弃', exact: true }).click();
      await expect(dirtyBarText).toBeHidden({ timeout: 10_000 });
      await expect(brandNameInput).toHaveValue(originalName);

      const renamedBrand = `${originalName}-精修`;
      await brandNameInput.fill(renamedBrand);
      await expect(dirtyBarText).toBeVisible({ timeout: 10_000 });
      await dirtyBar.getByRole('button', { name: '保存修改', exact: true }).click();
      await expect(dirtyBarText).toBeHidden({ timeout: 15_000 });

      const persistedBrand = unwrapOk(
        await requestV2<BrandDto>(`/brands/${brand.id}`, { token }),
        'GET brand after sticky bar save',
      );
      expect(persistedBrand.name).toBe(renamedBrand);

      // 7. 删除品牌 lives inside ⋯ overflow menu scoped to brand header / #brand-section-identity -> opens confirm modal (确认删除)
      await expect(
        page
          .locator('#brand-section-identity')
          .getByRole('button', { name: '删除品牌', exact: true }),
      ).toHaveCount(0);

      const brandActionsScope = page.locator(
        '.gm-workspace-main header, .gm-workspace-main .gm-page-header, .gm-workspace-main .gm-brand-context-bar, #brand-section-identity',
      );
      const moreTrigger = brandActionsScope
        .locator(
          '[data-testid="brand-actions-trigger"], button[aria-label*="更多"], button[aria-label*="操作"]',
        )
        .or(brandActionsScope.getByRole('button', { name: /⋯|\.\.\.|更多/ }))
        .first();
      await expect(moreTrigger).toBeVisible({ timeout: 10_000 });
      await moreTrigger.click();

      const deleteMenuItem = page
        .locator('.ant-dropdown:visible, [role="menu"]:visible')
        .getByText('删除品牌', { exact: true })
        .first();
      await expect(deleteMenuItem).toBeVisible({ timeout: 10_000 });
      await deleteMenuItem.click();

      const confirmDialog = page.locator('.ant-modal-confirm:visible').first();
      await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
      await expect(confirmDialog.getByRole('button', { name: '确认删除' })).toBeVisible();
      await confirmDialog.getByRole('button', { name: '取消' }).click();
      await expect(confirmDialog).toBeHidden({ timeout: 10_000 });

      assertNoConsoleOrPageErrors(collector);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// Tier 4 — Secondary & Public Pages Visual Closure
// ============================================================================

test.describe('Tier 4 — Secondary & Public Pages Visual Closure', () => {
  test('SI-T4-01: /account preserved .gm-right-card (<= 1048px), hydrated /admin management surfaces + dark tokens, incognito /share/pr/[token] (720px 15px/1.75) & /share/report/[token] visual closure', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const tag = uniqueTag(testInfo, 'sit401');
    const tenant = await provisionIsolatedTenant({ prefix: 'sit401', initialPoints: 250 });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCleanDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const engines = await pickOnlineEngines(tenant.session, brand.id, 'CN', 1);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'CN',
        engines,
        prompts: [`静音四盘位家用私有云 NAS 实测推荐 ${tag}`],
      },
      uniqueIdemKey('sit401-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const article = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `静音四盘位家用私有云 NAS 选型与对比指南 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      'sit401-art',
    );

    // Seed PR share link
    const prTaskId = unwrapOk(
      await requestV2<{ tasks: Array<{ id: string }> }>(
        `/articles/${article.id}/distributions/variants`,
        {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': uniqueIdemKey('sit401-pr') },
          body: { targets: [{ provider: 'PR_PACKET', channelLabel: '科技媒体协作包' }] },
        },
      ),
      'POST PR_PACKET variant',
    ).tasks[0]?.id;
    expect(prTaskId).toBeTruthy();

    const prShareUrl = unwrapOk(
      await requestV2<{ shareUrl: string }>(`/distributions/${prTaskId}/pr-share`, {
        method: 'POST',
        token,
        body: { ttlDays: 30 },
      }),
      'POST pr-share',
    ).shareUrl;

    // Seed ROI report share link
    const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const roiReport = unwrapOk(
      await requestV2<{ id: string }>(`/brands/${brand.id}/roi-reports`, {
        method: 'POST',
        token,
        body: {
          market: 'CN',
          title: `月度 GEO ROI 可视化报告 ${tag}`,
          periodStart,
          periodEnd,
          locale: 'zh-CN',
        },
      }),
      'POST roi-reports',
    );
    const roiShare = unwrapOk(
      await requestV2<{ sharePath?: string; shareUrl?: string; token?: string }>(
        `/roi-reports/${roiReport.id}/share`,
        {
          method: 'POST',
          token,
          body: { ttlDays: 14 },
        },
      ),
      'POST roi-reports/:id/share',
    );
    const roiShareUrl =
      roiShare.shareUrl || `${WEB_BASE}${roiShare.sharePath || `/share/report/${roiShare.token}`}`;

    // ── Part 1: /account preserved .gm-right-card[aria-label=*] & <= 1048px ──
    const { context: acctCtx, page: acctPage } = await createAuthenticatedContext(
      browser,
      tenant.session,
      { viewport: VP_ULTRAWIDE },
    );
    const acctCollector = attachErrorCollector(acctPage);
    try {
      await acctPage.goto('/account', { waitUntil: 'domcontentloaded' });
      await expect(acctPage.locator('.gm-workspace-main')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(acctPage);
      await assertDarkSurfaceBackground(acctPage, '/account');
      await assertAllWorkspaceChildrenWithin(acctPage, 1048, '/account @1920x1080', false);

      await acctPage.setViewportSize(VP_DESKTOP);
      await acctPage.getByRole('tab', { name: '账号权益' }).first().click();
      await waitForSettledContent(acctPage);
      for (const cardLabel of ['点数', '品牌数量', 'GEO写作数量', '文章发布']) {
        await expect(
          acctPage.locator(`.gm-right-card[aria-label="${cardLabel}"]`),
          `Preserved .gm-right-card[aria-label="${cardLabel}"] must remain visible`,
        ).toBeVisible({ timeout: 10_000 });
      }
      await expect(acctPage.locator('.gm-right-card[aria-label="DeepSeek"]')).toHaveCount(0);
      await assertZeroTinyCjk(acctPage);
      await assertZeroPresetAntdTags(acctPage, '.gm-workspace-main');
      await assertOverflowAcrossViewports(acctPage, CORE_VIEWPORTS, '/account');
      assertNoConsoleOrPageErrors(acctCollector);
    } finally {
      await acctCtx.close();
    }

    // ── Part 2: /admin/{tenants,pricing,leads,llm-costs} hydrated AdminFrame + real /admin/tenants contract ──
    const adminSession = getAdminSession();
    const { context: adminCtx, page: adminPage } = await createAuthenticatedContext(
      browser,
      adminSession,
      { viewport: VP_DESKTOP },
    );
    const adminCollector = attachErrorCollector(adminPage);
    try {
      for (const adminRoute of [
        '/admin/tenants',
        '/admin/pricing',
        '/admin/leads',
        '/admin/llm-costs',
      ]) {
        await adminPage.goto(adminRoute, { waitUntil: 'domcontentloaded' });
        // Wait for hydrated AdminFrame (never audit the <main class="gm-boot"> auth spinner!)
        await expect(adminPage.getByRole('navigation', { name: '管理菜单' })).toBeVisible({
          timeout: 20_000,
        });
        await expect(adminPage.locator('main.gm-admin-main')).toBeVisible({
          timeout: 20_000,
        });
        await waitForSettledContent(adminPage);

        await assertDarkSurfaceBackground(adminPage, adminRoute);
        await assertZeroTinyCjk(adminPage);
        await assertZeroPresetAntdTags(adminPage, 'main.gm-admin-main');
        await assertOverflowAcrossViewports(adminPage, [VP_DESKTOP, VP_LAPTOP], adminRoute);

        if (adminRoute === '/admin/tenants') {
          const adminMain = adminPage.locator('main.gm-admin-main');
          await expect(
            adminMain.getByRole('button', { name: /开户|新建|新增|创建/ }).first(),
            '/admin/tenants must render primary 开户/create action button',
          ).toBeVisible({ timeout: 10_000 });
          await expect(
            adminMain.locator('input, .ant-select').first(),
            '/admin/tenants must render search/filter controls',
          ).toBeVisible({ timeout: 10_000 });
          await expect(
            adminMain.locator('table, .ant-table').first(),
            '/admin/tenants must render tenant management table',
          ).toBeVisible({ timeout: 10_000 });
          const tenantPrimaries = await getVisiblePrimaryButtons(adminPage, 'main.gm-admin-main');
          expect(
            tenantPrimaries.length,
            `/admin/tenants must keep <= 1 primary CTA (got: ${tenantPrimaries.map((b) => b.text).join(', ')})`,
          ).toBeLessThanOrEqual(1);
        }

        // Whenever an admin route mounts <CrudToolbar> (.gm-crud-toolbar), assert create-first button order
        if ((await adminPage.locator('.gm-crud-toolbar').count()) > 0) {
          const toolbar = adminPage.locator('.gm-crud-toolbar').first();
          const createBtn = toolbar.getByRole('button', { name: /开户|新建|新增|创建/ }).first();
          const refreshBtn = toolbar.getByRole('button', { name: /刷新/ }).first();
          if ((await createBtn.count()) > 0 && (await refreshBtn.count()) > 0) {
            const cBox = await createBtn.boundingBox();
            const rBox = await refreshBtn.boundingBox();
            expect(
              cBox && rBox && cBox.x < rBox.x,
              'CrudToolbar must keep create-first order',
            ).toBe(true);
          }
        }
      }
      assertNoConsoleOrPageErrors(adminCollector);
    } finally {
      await adminCtx.close();
    }

    // ── Part 3: Unauthenticated Incognito /share/pr/[token] ──
    const prCtx = await browser.newContext({ viewport: VP_DESKTOP });
    const prPage = await prCtx.newPage();
    const prCollector = attachErrorCollector(prPage);
    const prCdnHits = attachFontLeakCollector(prPage);
    try {
      await prPage.goto(prShareUrl, { waitUntil: 'domcontentloaded' });
      await expect(prPage.getByTestId('pr-share-page')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(prPage);
      expect(prPage.url()).not.toContain('/login');
      await expect(prPage.getByTestId('pr-share-fact-table')).toBeVisible();
      await expect(prPage.getByTestId('pr-share-draft-preview')).toBeVisible();
      await expect(prPage.getByTestId('pr-share-submit-form')).toBeVisible();

      await assertProseMeasureAndTypography(
        prPage,
        '[data-testid="pr-share-draft-preview"]',
        '/share/pr/[token]',
      );
      await assertDarkSurfaceBackground(prPage, '/share/pr/[token]');
      await assertZeroTinyCjk(prPage);
      await assertZeroPresetAntdTags(prPage);
      await assertOverflowAcrossViewports(prPage, CORE_VIEWPORTS, '/share/pr/[token]');
      expect(
        prCdnHits,
        'Zero external font CDN or third-party font requests on /share/pr/[token]',
      ).toEqual([]);
      assertNoConsoleOrPageErrors(prCollector);
    } finally {
      await prCtx.close();
    }

    // ── Part 4: Unauthenticated Incognito /share/report/[token] ──
    const roiCtx = await browser.newContext({ viewport: VP_DESKTOP });
    const roiPage = await roiCtx.newPage();
    const roiCollector = attachErrorCollector(roiPage);
    const roiCdnHits = attachFontLeakCollector(roiPage);
    try {
      await roiPage.goto(roiShareUrl, { waitUntil: 'domcontentloaded' });
      await expect(roiPage.getByTestId('public-roi-report-page')).toBeVisible({ timeout: 20_000 });
      await waitForSettledContent(roiPage);
      expect(roiPage.url()).not.toContain('/login');
      await expect(roiPage.getByRole('button', { name: /打印|PDF|导出/i }).first()).toBeVisible({
        timeout: 10_000,
      });

      await assertDarkSurfaceBackground(roiPage, '/share/report/[token]');
      await assertZeroTinyCjk(roiPage);
      await assertZeroPresetAntdTags(roiPage);
      await assertOverflowAcrossViewports(roiPage, CORE_VIEWPORTS, '/share/report/[token]');
      expect(
        roiCdnHits,
        'Zero external font CDN or third-party font requests on /share/report/[token]',
      ).toEqual([]);
      assertNoConsoleOrPageErrors(roiCollector);
    } finally {
      await roiCtx.close();
    }
  });
});
