#!/usr/bin/env node
/**
 * On-demand multi-viewport visual baseline screenshot capture for Sonar Ink 2.0 (#390).
 *
 * Captures full-page PNGs across 3 viewports (1440x900, 1280x800, 390x844) and
 * 4 core workspaces (/home, /brands, /visibility, /studio) into test-results/ only.
 * Hard-refuses writing inside docs/ to preserve CI / AGENTS.md image-free docs redline.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const ALLOWED_PAGES = new Set(['home', 'brands', 'visibility', 'studio', 'account', 'login']);
const PAGE_READY_SELECTORS = {
  home: '[data-testid="home-workspace"], [data-testid="home-onboarding"]',
  brands:
    '#brand-section-identity, .gm-brands-page .gm-ui-page-header, .gm-brands-page .gm-ui-empty',
  visibility: '[data-testid="visibility-workspace"], .gm-vis-page .gm-ui-empty',
  studio: '[data-testid="studio-workspace"], .gm-studio-page--empty',
  account: '.gm-account-shell',
  login: '.gm-login-card',
};
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXTERNAL_FONT_CDN_RE = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;

function printUsage() {
  console.log(`Usage: node scripts/capture-sonar-ink-screenshots.mjs [options]

Options:
  --out-dir <path>         Output directory (default: test-results/visual-baseline; docs/ is forbidden)
  --base-url <url>         Existing Web app base URL (if omitted, auto-boots/reuses local :3000 & :3001)
  --api-base <url>         API v1 base URL (default: http://localhost:3001/api/v1)
  --pages <csv>            Comma-separated pages (default: home,brands,visibility,studio)
  --viewports <csv>        Comma-separated WxH viewports (default: 1440x900,1280x800,390x844)
  --user <username>        Username for e2e/support/mint-e2e-session.cjs (default: demo)
  --access-token <jwt>     Optional Bearer access token override
  --refresh-token <jwt>    Optional refresh token override
  -h, --help               Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    outDir: 'test-results/visual-baseline',
    baseUrl: null,
    apiBase: 'http://localhost:3001/api/v1',
    pages: 'home,brands,visibility,studio',
    viewports: '1440x900,1280x800,390x844',
    user: 'demo',
    accessToken: null,
    refreshToken: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      return opts;
    }
    const next = argv[i + 1];
    switch (arg) {
      case '--out-dir':
        if (!next || next.startsWith('-')) throw new Error('--out-dir requires a value');
        opts.outDir = next;
        i += 1;
        break;
      case '--base-url':
        if (!next || next.startsWith('-')) throw new Error('--base-url requires a value');
        opts.baseUrl = next.replace(/\/$/, '');
        i += 1;
        break;
      case '--api-base':
        if (!next || next.startsWith('-')) throw new Error('--api-base requires a value');
        opts.apiBase = next.replace(/\/$/, '');
        i += 1;
        break;
      case '--pages':
        if (!next || next.startsWith('-')) throw new Error('--pages requires a value');
        opts.pages = next;
        i += 1;
        break;
      case '--viewports':
        if (!next || next.startsWith('-')) throw new Error('--viewports requires a value');
        opts.viewports = next;
        i += 1;
        break;
      case '--user':
        if (!next || next.startsWith('-')) throw new Error('--user requires a value');
        opts.user = next;
        i += 1;
        break;
      case '--access-token':
        if (!next || next.startsWith('-')) throw new Error('--access-token requires a value');
        opts.accessToken = next;
        i += 1;
        break;
      case '--refresh-token':
        if (!next || next.startsWith('-')) throw new Error('--refresh-token requires a value');
        opts.refreshToken = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function isInsideDir(baseDir, candidateDir) {
  const rel = path.relative(baseDir, candidateDir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveCanonicalPath(targetPath, maxDepth = 40) {
  if (maxDepth <= 0) {
    throw new Error(`Too many levels of symbolic links while resolving ${targetPath}`);
  }
  const pendingSegments = [];
  let current = path.resolve(targetPath);

  while (true) {
    if (existsSync(current)) {
      const realAncestor = realpathSync(current);
      return pendingSegments.length > 0
        ? path.join(realAncestor, ...pendingSegments)
        : realAncestor;
    }
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      const linkTarget = readlinkSync(current);
      const resolvedLink = path.resolve(path.dirname(current), linkTarget);
      const nextTarget =
        pendingSegments.length > 0 ? path.join(resolvedLink, ...pendingSegments) : resolvedLink;
      return resolveCanonicalPath(nextTarget, maxDepth - 1);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(targetPath);
    }
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
}

function assertSafeOutDir(outDirArg) {
  const resolvedOutDir = path.resolve(REPO_ROOT, outDirArg);
  const docsDir = path.resolve(REPO_ROOT, 'docs');
  const canonicalOutDir = resolveCanonicalPath(resolvedOutDir);
  const canonicalDocsDir = existsSync(docsDir) ? realpathSync(docsDir) : docsDir;
  if (isInsideDir(docsDir, resolvedOutDir) || isInsideDir(canonicalDocsDir, canonicalOutDir)) {
    throw new Error(
      `Refusing to write screenshots inside docs/ (${canonicalOutDir}). Use test-results/ instead.`,
    );
  }
  return resolvedOutDir;
}

function parsePages(csv) {
  const pages = csv
    .split(',')
    .map((p) => p.trim().replace(/^\//, ''))
    .filter(Boolean);
  if (pages.length === 0) {
    throw new Error('At least one page must be specified via --pages');
  }
  for (const page of pages) {
    if (!ALLOWED_PAGES.has(page)) {
      throw new Error(
        `Invalid page "${page}". Allowed pages: ${Array.from(ALLOWED_PAGES).join(', ')}`,
      );
    }
  }
  return pages;
}

function parseViewports(csv) {
  const items = csv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error('At least one viewport must be specified via --viewports');
  }
  return items.map((raw) => {
    const match = /^(\d+)x(\d+)$/i.exec(raw);
    if (!match) {
      throw new Error(`Invalid viewport "${raw}". Expected <width>x<height>, e.g. 1440x900`);
    }
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (width < 320 || height < 320) {
      throw new Error(`Viewport "${raw}" is too small (minimum 320x320)`);
    }
    return { width, height, label: `${width}x${height}` };
  });
}

async function isUrlHealthy(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function attachCappedOutput(child, maxBytes = 8192) {
  let tail = '';
  const append = (chunk) => {
    tail += chunk.toString('utf8');
    if (tail.length > maxBytes) {
      tail = tail.slice(tail.length - maxBytes);
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => tail.trim();
}

async function waitForHealthy(url, timeoutMs, child, name, getLogs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      const logTail = getLogs?.();
      throw new Error(
        `${name} exited prematurely with code ${child.exitCode}${logTail ? `\n--- ${name} output tail ---\n${logTail}` : ''}`,
      );
    }
    if (await isUrlHealthy(url, 2000)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const logTail = getLogs?.();
  throw new Error(
    `Timed out waiting for ${name} at ${url} after ${timeoutMs}ms${logTail ? `\n--- ${name} output tail ---\n${logTail}` : ''}`,
  );
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already-exited child
      }
      resolve();
    }, 3000);

    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(forceTimer);
      resolve();
    }
  });
}

function buildSharedEnv(baseUrl, apiBase) {
  const apiUrl = new URL(apiBase);
  const webUrl = new URL(baseUrl);
  const apiPort = apiUrl.port || (apiUrl.protocol === 'https:' ? '443' : '80');
  const webPort = webUrl.port || (webUrl.protocol === 'https:' ? '443' : '80');
  const visibilityCollector = process.env.VISIBILITY_COLLECTOR || 'fake';
  const defaultVisibilityDisabledEngines =
    visibilityCollector.trim().toLowerCase() === 'fake'
      ? 'yuanbao,tongyi,wenxin,nami,kimi,zhipu'
      : undefined;

  return {
    ...process.env,
    API_PORT: process.env.API_PORT || apiPort,
    WEB_PORT: process.env.WEB_PORT || webPort,
    WEB_ORIGIN: `${baseUrl},http://localhost:${webPort},http://127.0.0.1:${webPort}`,
    NEXT_PUBLIC_API_BASE: apiBase,
    DATABASE_URL:
      process.env.DATABASE_URL || 'postgresql://geomix:geomix@127.0.0.1:5432/geomix?schema=public',
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'change-me-access',
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change-me-refresh',
    BILLING_MODE: process.env.BILLING_MODE || 'SHADOW',
    LLM_PROVIDERS: process.env.LLM_PROVIDERS || '{}',
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || 'fake',
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER || 'fake',
    VISIBILITY_COLLECTOR: visibilityCollector,
    ...(process.env.VISIBILITY_DISABLED_ENGINES !== undefined
      ? { VISIBILITY_DISABLED_ENGINES: process.env.VISIBILITY_DISABLED_ENGINES }
      : defaultVisibilityDisabledEngines !== undefined
        ? { VISIBILITY_DISABLED_ENGINES: defaultVisibilityDisabledEngines }
        : {}),
    STORAGE_DRIVER: process.env.STORAGE_DRIVER || 'memory',
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || 'link_list',
    FEATURE_AI_IMAGE: process.env.FEATURE_AI_IMAGE || 'true',
    FEATURE_VISIBILITY: process.env.FEATURE_VISIBILITY || 'true',
    CREDENTIAL_ENCRYPTION_KEY:
      process.env.CREDENTIAL_ENCRYPTION_KEY ||
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || baseUrl,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

function mintSessionTokens(username, env) {
  const scriptPath = path.join(REPO_ROOT, 'e2e/support/mint-e2e-session.cjs');
  if (!existsSync(scriptPath)) {
    throw new Error(`Missing session helper: ${scriptPath}`);
  }
  const stdout = execFileSync(process.execPath, [scriptPath, username], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const parsed = JSON.parse(stdout);
  if (!parsed.accessToken || !parsed.refreshToken) {
    throw new Error('mint-e2e-session.cjs did not return accessToken and refreshToken');
  }
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
}

async function discoverBrandContext(apiBase, accessToken) {
  const apiV2Base = apiBase.replace(/\/v1\/?$/, '/v2');
  try {
    const res = await fetch(`${apiV2Base}/brands`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { activeBrandId: null, activeMarket: 'CN' };
    }
    const payload = await res.json();
    const items = Array.isArray(payload?.data?.items)
      ? payload.data.items
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    if (items.length === 0) {
      console.warn(
        '[screenshots] Warning: user has 0 brands; capturing onboarding/empty workspace views.',
      );
      return { activeBrandId: null, activeMarket: 'CN' };
    }
    const first = items[0];
    const markets = Array.isArray(first.markets) ? first.markets : [];
    const hasCn = markets.some((m) => m?.market === 'CN');
    const activeMarket = hasCn ? 'CN' : markets[0]?.market || 'CN';
    return { activeBrandId: first.id ?? null, activeMarket };
  } catch (err) {
    console.warn(`[screenshots] Brand discovery skipped: ${err?.message ?? err}`);
    return { activeBrandId: null, activeMarket: 'CN' };
  }
}

function validatePngFile(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length <= 1024) {
    throw new Error(`PNG file too small (${buf.length} bytes): ${filePath}`);
  }
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`Invalid PNG magic bytes: ${filePath}`);
  }
  const pngWidth = buf.readUInt32BE(16);
  const pngHeight = buf.readUInt32BE(20);
  if (pngWidth <= 0 || pngHeight <= 0) {
    throw new Error(`Invalid PNG IHDR dimensions (${pngWidth}x${pngHeight}): ${filePath}`);
  }
  return { bytes: buf.length, pngWidth, pngHeight };
}

function resolveChromiumLaunchOptions() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const executablePath =
    explicit ||
    (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  return executablePath
    ? {
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      }
    : {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };
}

async function waitForLoadingIndicatorsToClear(page, pageKey, timeoutMs = 15_000) {
  const selectors = [
    `[data-testid="${pageKey}-loading"]`,
    '[aria-busy="true"]',
    '.ant-spin-spinning',
  ];
  if (pageKey === 'account') {
    selectors.push('[data-testid="points-kpi-skeleton"]', '[data-testid="points-table-skeleton"]');
  }
  const combinedSelector = selectors.join(', ');
  await page.waitForFunction(
    (selector) => {
      const nodes = document.querySelectorAll(selector);
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const isVisible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0;
        if (isVisible) {
          return false;
        }
      }
      return true;
    },
    combinedSelector,
    { timeout: timeoutMs },
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }

  // Hard safety guard BEFORE creating any directory or spawning servers.
  const outDir = assertSafeOutDir(opts.outDir);
  const pages = parsePages(opts.pages);
  const viewports = parseViewports(opts.viewports);

  const autoBoot = !opts.baseUrl;
  const baseUrl = opts.baseUrl || 'http://localhost:3000';
  const apiBase = opts.apiBase;
  const sharedEnv = buildSharedEnv(baseUrl, apiBase);

  const spawnedChildren = [];
  let browser = null;
  let cleaningUp = false;

  const cleanupAll = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore browser close error during teardown
      }
      browser = null;
    }
    for (const child of spawnedChildren.splice(0).reverse()) {
      await terminateChild(child);
    }
  };

  const handleSignal = (sig) => {
    void cleanupAll().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    if (autoBoot) {
      const apiHealthy = await isUrlHealthy(`${apiBase}/health`);
      if (!apiHealthy) {
        const serverDist = path.join(REPO_ROOT, 'apps/server/dist/common/create-api-app.js');
        if (!existsSync(serverDist)) {
          throw new Error(`Missing built API bundle (${serverDist}). Run "pnpm build" first.`);
        }
        const apiChild = spawn(process.execPath, ['./e2e/support/e2e-backend.cjs'], {
          cwd: REPO_ROOT,
          env: sharedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const getApiLogs = attachCappedOutput(apiChild);
        spawnedChildren.push(apiChild);
        await waitForHealthy(`${apiBase}/health`, 60_000, apiChild, 'e2e-backend', getApiLogs);
      }

      const webHealthy = await isUrlHealthy(`${baseUrl}/login`);
      if (!webHealthy) {
        const nextBuildId = path.join(REPO_ROOT, 'apps/web/.next/BUILD_ID');
        if (!existsSync(nextBuildId)) {
          throw new Error(`Missing built Web app (${nextBuildId}). Run "pnpm build" first.`);
        }
        const webUrl = new URL(baseUrl);
        const webPort = webUrl.port || '3000';
        const nextBin = path.join(REPO_ROOT, 'apps/web/node_modules/next/dist/bin/next');
        const webChild = spawn(
          process.execPath,
          [nextBin, 'start', 'apps/web', '--port', webPort],
          {
            cwd: REPO_ROOT,
            env: sharedEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const getWebLogs = attachCappedOutput(webChild);
        spawnedChildren.push(webChild);
        await waitForHealthy(`${baseUrl}/login`, 60_000, webChild, 'next-start', getWebLogs);
      }
    }

    const tokens = opts.accessToken
      ? { accessToken: opts.accessToken, refreshToken: opts.refreshToken || opts.accessToken }
      : mintSessionTokens(opts.user, sharedEnv);

    const { activeBrandId, activeMarket } = await discoverBrandContext(apiBase, tokens.accessToken);
    const brandQuery = activeBrandId
      ? `?brandId=${encodeURIComponent(activeBrandId)}&market=${encodeURIComponent(activeMarket)}`
      : '';

    mkdirSync(outDir, { recursive: true });
    browser = await chromium.launch(resolveChromiumLaunchOptions());

    const screenshots = [];
    const fontRequestsMap = new Map();
    const externalFontRequests = [];
    let totalBytes = 0;

    const attachFontResponseListener = (targetPage) => {
      targetPage.on('response', (response) => {
        const url = response.url();
        if (/\/fonts\/[^/?#]+\.woff2(?:$|\?)/i.test(url)) {
          const status = response.status();
          const prev = fontRequestsMap.get(url);
          fontRequestsMap.set(url, {
            url,
            status: prev && prev.status === 200 && status === 304 ? 200 : status,
            contentType: response.headers()['content-type'] || prev?.contentType || '',
            hits: (prev?.hits ?? 0) + 1,
          });
        }
        if (EXTERNAL_FONT_CDN_RE.test(url)) {
          externalFontRequests.push({ url, status: response.status() });
        }
      });
    };

    const needsAuthContext = pages.some((p) => p !== 'login');

    for (const vp of viewports) {
      let authContext = null;
      let authPage = null;

      try {
        if (needsAuthContext) {
          authContext = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 1,
          });

          await authContext.addInitScript(
            ({ accessToken, refreshToken, brandId, market }) => {
              window.sessionStorage.setItem('geomix.accessToken', accessToken);
              window.sessionStorage.setItem('geomix.refreshToken', refreshToken);
              window.localStorage.setItem('geomix.accessToken', accessToken);
              window.localStorage.setItem('geomix.refreshToken', refreshToken);
              if (brandId) {
                window.localStorage.setItem(
                  'geomix.workspace.v2',
                  JSON.stringify({
                    activeBrandId: brandId,
                    activeMarket: market,
                    menuCollapsed: false,
                  }),
                );
              }
            },
            {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              brandId: activeBrandId,
              market: activeMarket,
            },
          );

          authPage = await authContext.newPage();
          attachFontResponseListener(authPage);
        }

        for (const pageKey of pages) {
          const isUnauthLogin = pageKey === 'login';
          let isolatedContext = null;
          let targetPage = authPage;
          let listenersAttached = false;

          const consoleErrors = [];
          const pageErrors = [];
          const onConsole = (msg) => {
            if (msg.type() === 'error') {
              consoleErrors.push(msg.text());
            }
          };
          const onPageError = (err) => {
            pageErrors.push(String(err));
          };

          const route = `/${pageKey}${isUnauthLogin ? '' : brandQuery}`;
          const targetUrl = `${baseUrl}${route}`;

          try {
            if (isUnauthLogin) {
              isolatedContext = await browser.newContext({
                viewport: { width: vp.width, height: vp.height },
                deviceScaleFactor: 1,
              });
              targetPage = await isolatedContext.newPage();
              attachFontResponseListener(targetPage);
            }

            targetPage.on('console', onConsole);
            targetPage.on('pageerror', onPageError);
            listenersAttached = true;

            const response = await targetPage.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000,
            });
            if (!response || response.status() >= 400) {
              throw new Error(
                `Failed to load ${targetUrl}: HTTP ${response ? response.status() : 'no response'}`,
              );
            }

            const readySelector = PAGE_READY_SELECTORS[pageKey];
            try {
              await targetPage.locator(readySelector).first().waitFor({
                state: 'visible',
                timeout: 20_000,
              });
            } catch (err) {
              const currentUrl = targetPage.url();
              const currentPathname = new URL(currentUrl).pathname;
              if (!isUnauthLogin && currentPathname.startsWith('/login')) {
                throw new Error(
                  `Expected authenticated /${pageKey} capture to stay authenticated, but redirected to ${currentUrl}`,
                );
              }
              throw new Error(
                `Timed out waiting for hydrated ready selector (${readySelector}) on /${pageKey} (url=${currentUrl}): ${err?.message ?? err}`,
              );
            }

            // Best-effort network idle & font readiness settle.
            await targetPage.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
            await targetPage.evaluate(async () => {
              if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
              }
            });

            // Explicitly wait for all workspace/skeleton/spinner loading indicators to clear.
            await waitForLoadingIndicatorsToClear(targetPage, pageKey, 15_000);

            // Reset scroll and wait 2 animation frames so layout and fonts paint cleanly.
            await targetPage.evaluate(async () => {
              window.scrollTo(0, 0);
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
            });

            const finalUrl = targetPage.url();
            const finalPathname = new URL(finalUrl).pathname;
            if (isUnauthLogin) {
              if (!finalPathname.startsWith('/login')) {
                throw new Error(
                  `Expected unauthenticated /login capture to stay on /login, but redirected to ${finalUrl}`,
                );
              }
            } else if (finalPathname.startsWith('/login')) {
              throw new Error(
                `Expected authenticated /${pageKey} capture to stay authenticated, but redirected to ${finalUrl}`,
              );
            }

            const metrics = await targetPage.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              innerWidth: window.innerWidth,
              scrollHeight: document.documentElement.scrollHeight,
            }));

            const fileName = `${pageKey}-${vp.label}.png`;
            const filePath = path.join(outDir, fileName);
            await targetPage.screenshot({ path: filePath, fullPage: true });
            const pngMeta = validatePngFile(filePath);
            totalBytes += pngMeta.bytes;

            screenshots.push({
              page: pageKey,
              route,
              finalUrl,
              viewport: { width: vp.width, height: vp.height },
              file: fileName,
              bytes: pngMeta.bytes,
              pngWidth: pngMeta.pngWidth,
              pngHeight: pngMeta.pngHeight,
              scrollWidth: metrics.scrollWidth,
              innerWidth: metrics.innerWidth,
              hasHorizontalOverflow: metrics.scrollWidth > metrics.innerWidth,
              consoleErrors,
              pageErrors,
            });
          } finally {
            if (listenersAttached && targetPage) {
              targetPage.off('console', onConsole);
              targetPage.off('pageerror', onPageError);
            }
            if (isolatedContext) {
              try {
                await isolatedContext.close();
              } catch {
                /* ignore */
              }
            }
          }
        }
      } finally {
        if (authContext) {
          try {
            await authContext.close();
          } catch {
            /* ignore */
          }
        }
      }
    }

    const fontRequests = Array.from(fontRequestsMap.values());
    const failedFonts = fontRequests.filter((f) => f.status !== 200 && f.status !== 304);
    if (externalFontRequests.length > 0) {
      throw new Error(
        `Detected external font CDN requests: ${externalFontRequests.map((f) => f.url).join(', ')}`,
      );
    }
    if (failedFonts.length > 0) {
      throw new Error(
        `Self-hosted font requests failed: ${failedFonts.map((f) => `${f.url} (${f.status})`).join(', ')}`,
      );
    }

    const manifest = {
      capturedAt: new Date().toISOString(),
      baseUrl,
      apiBase,
      user: opts.user,
      activeBrandId,
      activeMarket,
      count: screenshots.length,
      totalBytes,
      fontRequests,
      externalFontRequests,
      screenshots,
    };

    const manifestPath = path.join(outDir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(
      `Captured ${screenshots.length} screenshots (${totalBytes} bytes) -> ${path.relative(REPO_ROOT, outDir)}`,
    );
    for (const item of screenshots) {
      const overflowTag = item.hasHorizontalOverflow
        ? `OVERFLOW(${item.scrollWidth}>${item.innerWidth})`
        : 'ok';
      console.log(
        `  - ${item.file}: ${item.pngWidth}x${item.pngHeight} (${item.bytes} B) [${overflowTag}]`,
      );
    }
    console.log(
      `Fonts loaded: ${fontRequests.map((f) => `${path.basename(f.url)} (${f.status})`).join(', ') || 'none'} | external CDN: ${externalFontRequests.length}`,
    );
  } finally {
    await cleanupAll();
  }
}

main().catch((err) => {
  console.error(`[capture-sonar-ink-screenshots] ${err?.message ?? err}`);
  process.exit(1);
});
