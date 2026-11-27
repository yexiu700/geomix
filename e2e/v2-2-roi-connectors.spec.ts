import { createHmac } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  apiV2Base,
  consumeSsePost,
  createBrandApi,
  createVisibilityRunApi,
  getTenantWallet,
  getWalletPoints,
  listBriefsApi,
  listMarketEnginesApi,
  pollUntil,
  provisionIsolatedTenant,
  requestV1,
  requestV2,
  requestV2Binary,
  setTenantBillingMode,
  setTenantExpiry,
  adjustTenantPoints,
  unwrapOk,
  upsertBrandFactsApi,
  waitForVisibilityRunApi,
  type GeoMarket,
  type MintedSession,
} from './v2/support/api-client';
import { assertNoConsoleOrPageErrors, assertNoHorizontalOverflow } from './v2/support/assertions';
import {
  buildCnBrandPayload,
  buildDualMarketBrandPayload,
  buildFourBrandFacts,
  uniqueIdemKey,
  uniqueTag,
} from './v2/support/fixtures';
import { attachErrorCollector, createAuthenticatedContext } from './v2/support/ui-actions';

// ── Constants & Opaque-Box Wire Types (Zero @geomix/shared Imports) ──────────

const V2_2_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1015, height: 909 },
] as const;

const WEB_BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const FIXTURE_BASE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || '3099'}`;
const SHOPIFY_OAUTH_CLIENT_SECRET =
  process.env.SHOPIFY_OAUTH_CLIENT_SECRET || 'e2e_shopify_client_secret';
const E2E_GHOST_ADMIN_API_KEY = 'e2e_ghost_key:0123456789abcdef0123456789abcdef';
const E2E_EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const SSRF_BLOCKED_URLS = [
  'http://127.0.0.1:3001/api/v1/health',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.1/internal',
  'https://ssrf-redirect.e2e.example/to-loopback',
] as const;

type NearMissTier =
  'OPENED_NOT_CITED' | 'RETRIEVED_NOT_CITED' | 'CRAWLED_NOT_CITED' | 'MENTIONED_NOT_OWNED';

type FixtureCaptureItem = {
  id: string;
  timestamp: string;
  kind: string;
  host: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: Record<string, unknown> | null;
};

type NearMissItemWire = {
  id: string;
  tier: NearMissTier;
  opportunityScore: number;
  url: string | null;
  domain: string | null;
  title: string | null;
  snippet: string | null;
  sourceKind: string;
  isOwned: boolean;
  engines: string[];
  prompts: string[];
  observationIds: string[];
  openedCount: number;
  retrievedCount: number;
  publishRecordId?: string | null;
  lastSeenAt: string;
};

type NearMissListWire = {
  brandId: string;
  market: GeoMarket;
  days: number;
  total: number;
  tierCounts: Record<NearMissTier, number>;
  hasRawRetrievalSignals: boolean;
  items: NearMissItemWire[];
};

type WilsonWire = {
  hits: number;
  trials: number;
  rate: number;
  lower: number;
  upper: number;
  halfWidth: number;
  z: number;
  confidenceLevel: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
};

type DidWire = {
  treatmentDelta: number;
  controlDelta: number;
  netLift: number;
  direction: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
};

type RetestScheduleWire = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: 1 | 3;
  includeControlPrompts?: boolean;
  dueAt: string;
  status: string;
  visibilityRunId: string | null;
  metricsSnapshot: {
    mentionRate: number;
    avgPosition: number | null;
    sentiment: string | null;
    citationHit: boolean;
    sampleCount?: number;
    hitCount?: number;
    wilson?: WilsonWire;
    confidenceLevel?: string;
  } | null;
  controlMetricsJson?: {
    controlPrompts: string[];
    baselineMentionRate: number | null;
    currentMentionRate: number;
    sampleCount: number;
    hitCount: number;
    wilson?: WilsonWire;
    did?: DidWire | null;
  } | null;
  skipReason: string | null;
  executedAt: string | null;
};

type PublishRecordWire = {
  id: string;
  publishedUrl: string;
  channel: string;
  crawlStatus?: string;
  indexNowSubmitted?: boolean;
  retestSchedules?: RetestScheduleWire[];
};

type RoiReportSummaryWire = {
  version: 1;
  overview: {
    totalObservations: number;
    mentionHits: number;
    mentionRate: number;
    mentionWilson: WilsonWire;
    citationHits: number;
    citationRate: number;
    ownedCitationHits: number;
    ownedCitationRate: number;
    confidenceLevel: string;
    did: DidWire | null;
  };
  byEngine: Array<{
    engine: string;
    observations: number;
    mentionRate: number;
    citationRate: number;
    ownedCitationRate: number;
    avgPosition: number | null;
    mentionWilson: WilsonWire;
  }>;
  nearMiss: {
    totalOpportunities: number;
    boostBriefsCreated: number;
    convertedToCited: number;
    tierCounts: Record<NearMissTier, number>;
  };
  funnel: {
    publishedTotal: number;
    l1Count: number;
    l2Count: number;
    l3Count: number;
    crawlCheckedCount: number;
    crawlOkCount: number;
    crawlOkRate: number | null;
    indexNowAttemptedCount: number;
    indexNowSuccessCount: number;
    indexNowRate: number | null;
  };
  channelRanking: Array<Record<string, unknown>>;
  milestoneTrend: Array<Record<string, unknown>>;
  pointsRoi?: Record<string, unknown>;
};

type RoiReportRecordWire = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  title: string;
  periodStart: string;
  periodEnd: string;
  locale: string;
  whiteLabelOrg: string | null;
  summary: RoiReportSummaryWire;
  shareActive: boolean;
  shareExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RoiReportShareWire = {
  reportId: string;
  sharePath: string;
  shareUrl: string;
  expiresAt: string;
};

type PublicRoiReportWire = {
  title: string;
  brandName: string;
  category: string;
  market: GeoMarket;
  locale: string;
  whiteLabelOrg: string | null;
  periodStart: string;
  periodEnd: string;
  summary: Omit<RoiReportSummaryWire, 'pointsRoi'>;
  generatedAt: string;
  expiresAt: string;
};

type ChannelConnectionWire = {
  id: string;
  brandId: string;
  market: GeoMarket;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialHint: string;
  status: string;
  authType: string;
  targetLocale?: string | null;
  externalShopDomain?: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
};

type ConnectionTestWire = {
  ok: boolean;
  status: string;
  message: string;
  testedAt: string;
  targets?: Array<{ id: string; name: string; handle?: string; url?: string }>;
};

type DistributionTaskWire = {
  id: string;
  brandId: string;
  articleId: string;
  connectionId: string | null;
  provider: string;
  mode: string;
  channelLabel: string;
  targetLocale?: string | null;
  status: string;
  publishAsDraft: boolean;
  remotePostId: string | null;
  remoteAdminUrl: string | null;
  remotePublishedUrl: string | null;
  indexNowStatus: string | null;
  lastError: string | null;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  publishRecords?: PublishRecordWire[];
};

type VariantJobWire = {
  id: string;
  articleId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  total: number;
  doneCount: number;
  failCount: number;
  taskIds: string[];
  failures: Array<{ index: number; provider: string; error: string }>;
  lastError: string | null;
};

type ExtensionTokenWire = {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

type CreateExtensionTokenWire = {
  token: ExtensionTokenWire;
  plainToken: string;
};

type ExtensionMeWire = {
  bridgeVersion: 'v1';
  userDisplayName: string;
  tokenLabel: string;
  tokenPrefix: string;
  expiresAt: string;
  brands: Array<{
    id: string;
    name: string;
    localBrandName: string;
    category: string;
    market: GeoMarket;
  }>;
};

type ExtensionPendingTaskWire = {
  taskId: string;
  brandId: string;
  brandName: string;
  articleId: string;
  provider: 'ZHIHU_EXT' | 'TOUTIAO_EXT' | 'SMZDM_EXT';
  channelLabel: string;
  status: string;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  targetUrlHint: string | null;
  mediaAssets: Array<{ id: string; title: string; url: string; mime?: string | null }>;
  antiBanChecklist: string[];
  remotePublishedUrl: string | null;
  updatedAt: string;
};

type ExtensionConfirmWire = {
  accepted: boolean;
  taskId: string;
  publishRecordId: string;
  publishedUrl: string;
  status: string;
  alreadyRecorded: boolean;
  retestScheduledCount: number;
};

// ── Shared E2E Helpers ───────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function isoTimestampHoursFromNow(hoursFromNow = 1): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

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

async function triggerMaintenance(kind: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${FIXTURE_BASE}/__e2e/maintenance/${encodeURIComponent(kind)}`, {
    method: 'POST',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Maintenance trigger '${kind}' failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function signShopifyOAuthQuery(params: Record<string, string>, secret: string): string {
  const entries = Object.entries(params)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function signShopifyWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function assertFourItemSidebar(page: Page): Promise<void> {
  const nav = page.locator('nav[aria-label="主导航"], [data-testid="side-menu-root"]').first();
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const menuItems = nav.getByRole('menuitem');
  await expect(menuItems).toHaveCount(5);
  const labels = (await menuItems.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  expect(labels).toEqual(['首页', '品牌', '诊断', '写作', '发布']);
  await expect(nav.locator('a[href*="/distribution"]')).toHaveCount(0);
}

async function assertLayoutErgonomics(
  page: Page,
  opts: { checkDrawer?: boolean } = {},
): Promise<void> {
  for (const vp of V2_2_VIEWPORTS) {
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
      expect(
        drawerOverflow,
        `.ant-drawer-open .ant-drawer-body must be present at ${vp.width}x${vp.height}`,
      ).not.toBeNull();
      expect(
        drawerOverflow!.scrollWidth,
        `.ant-drawer-open .ant-drawer-body horizontal overflow at ${vp.width}x${vp.height}`,
      ).toBeLessThanOrEqual(drawerOverflow!.clientWidth + 2);
    }

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
                  'main, .ant-layout-content, [data-testid="public-roi-report-page"], [data-testid="pr-share-page"]',
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
  await page.setViewportSize(V2_2_VIEWPORTS[0]);
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
): Promise<{ id: string; title: string; contentMarkdown: string; targetLocale?: string | null }> {
  const sse = await consumeSsePost(`/brands/${brandId}/articles/stream`, {
    token,
    idempotencyKey: uniqueIdemKey(idemPrefix),
    body,
    timeoutMs: 45_000,
  });
  const article = sse.complete?.article as
    | { id: string; title: string; contentMarkdown: string; targetLocale?: string | null }
    | undefined;
  expect(
    article?.id,
    `SSE article stream (${idemPrefix}) must return complete.article.id`,
  ).toBeTruthy();
  return article!;
}

async function createVariantTasksSync(
  token: string,
  articleId: string,
  targets: Array<Record<string, unknown>>,
  idemPrefix: string,
): Promise<DistributionTaskWire[]> {
  const res = await requestV2<{ tasks?: DistributionTaskWire[]; items?: DistributionTaskWire[] }>(
    `/articles/${articleId}/distributions/variants`,
    {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': uniqueIdemKey(idemPrefix) },
      body: { targets },
    },
  );
  const data = unwrapOk(res, `POST /articles/${articleId}/distributions/variants`);
  const list = Array.isArray(data.tasks) ? data.tasks : Array.isArray(data.items) ? data.items : [];
  expect(list.length, `Variant generation (${idemPrefix}) must create tasks`).toBe(targets.length);
  return list;
}

async function pollDistributionTaskDone(
  token: string,
  articleId: string,
  taskId: string,
  timeoutMs = 30_000,
): Promise<DistributionTaskWire> {
  return pollUntil(
    async () => {
      const res = await requestV2<{ items: DistributionTaskWire[] }>(
        `/articles/${articleId}/distributions`,
        { token },
      );
      const items = unwrapOk(res, `GET /articles/${articleId}/distributions`).items;
      const found = items.find((t) => t.id === taskId);
      if (!found) {
        throw new Error(`Distribution task ${taskId} disappeared`);
      }
      return found;
    },
    (task) => ['PUBLISHED', 'DRAFT_PUSHED', 'FAILED'].includes(task.status),
    { timeoutMs, intervalMs: 350, label: `distTask:${taskId}` },
  );
}

async function pollVariantJobDone(
  token: string,
  articleId: string,
  jobId: string,
  timeoutMs = 45_000,
): Promise<VariantJobWire> {
  return pollUntil(
    async () => {
      const res = await requestV2<VariantJobWire>(
        `/articles/${articleId}/distributions/variant-jobs/${jobId}`,
        { token },
      );
      return unwrapOk(res, `GET variant-job ${jobId}`);
    },
    (job) => ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(job.status),
    { timeoutMs, intervalMs: 350, label: `variantJob:${jobId}` },
  );
}

async function waitForDueRetestScheduleDone(
  token: string,
  articleId: string,
  publishRecordId: string,
  milestoneDay: number,
  expectedStatuses: string[],
  timeoutMs = 45_000,
): Promise<RetestScheduleWire> {
  return pollUntil(
    async () => {
      const res = await requestV2<{ items: PublishRecordWire[] }>(
        `/articles/${articleId}/publish-records`,
        { token },
      );
      const records = unwrapOk(res, `GET /articles/${articleId}/publish-records`).items;
      const rec = records.find((r) => r.id === publishRecordId);
      const sched = rec?.retestSchedules?.find((s) => s.milestoneDay === milestoneDay);
      if (!sched) {
        throw new Error(`Retest schedule T+${milestoneDay} not found on ${publishRecordId}`);
      }
      return sched;
    },
    (sched) => expectedStatuses.includes(sched.status),
    { timeoutMs, intervalMs: 400, label: `retestSchedule:${publishRecordId}:T${milestoneDay}` },
  );
}

function assertValidWilson(w: WilsonWire | undefined, label: string): void {
  expect(w, `${label} must include Wilson interval`).toBeTruthy();
  expect(w!.lower).toBeGreaterThanOrEqual(0);
  expect(w!.lower).toBeLessThanOrEqual(w!.rate + 0.0002);
  expect(w!.rate).toBeLessThanOrEqual(w!.upper + 0.0002);
  expect(w!.upper).toBeLessThanOrEqual(1);
  expect(w!.halfWidth).toBeGreaterThanOrEqual(0);
  expect(w!.halfWidth).toBeLessThanOrEqual(1);
  expect(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']).toContain(w!.confidenceLevel);
}

function assertNoMixedLanguageChrome(text: string, expectedLang: 'en' | 'zh'): void {
  if (expectedLang === 'en') {
    expect(
      /[\u4e00-\u9fff]/.test(text),
      `Pure EN public report page must not contain Chinese characters; found in: ${text.slice(0, 300)}`,
    ).toBe(false);
  } else {
    // Pure CN page must not leak standard English report chrome phrases
    for (const leakedEnPhrase of [
      'Monthly GEO ROI Report',
      'Mention Rate (Wilson 95% CI)',
      'Print / Save as PDF',
      'Difference-in-Differences',
      'Near-Miss Opportunities',
    ]) {
      expect(text, `Pure CN report must not leak English chrome '${leakedEnPhrase}'`).not.toContain(
        leakedEnPhrase,
      );
    }
    expect(/[\u4e00-\u9fff]/.test(text), 'Pure CN report must render Chinese copy').toBe(true);
  }
}

async function selectAntDropdownOption(
  page: Page,
  trigger: Locator,
  optionPattern: RegExp | string,
): Promise<void> {
  await trigger.click();
  const option = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option', {
      hasText: optionPattern,
    })
    .first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

async function readTextIncludingInputs(locator: Locator): Promise<string> {
  return locator.evaluate((root) => {
    const parts: string[] = [];
    if (root instanceof HTMLElement && root.innerText) {
      parts.push(root.innerText);
    } else if (root.textContent) {
      parts.push(root.textContent);
    }
    const fields = Array.from(
      root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    );
    for (const field of fields) {
      if (field.value) parts.push(field.value);
    }
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) parts.push(href);
      if (link.href) parts.push(link.href);
    }
    return parts.join('\n');
  });
}

// ============================================================================
// Tier 1 — Feature Coverage (Category-Partition)
// ============================================================================

test.describe('Tier 1 — GeoMix v2.2 Feature Coverage (Category-Partition)', () => {
  test('T1-01: Near-Miss 4-tier discovery API, 0-pt NEAR_MISS_BOOST brief & unchanged PRICING_DEFAULTS', async ({}, testInfo) => {
    test.setTimeout(120_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't101nm');
    const tenant = await provisionIsolatedTenant({
      prefix: 't101nm',
      billingMode: 'STRICT',
      initialPoints: 120,
    });
    const token = tenant.session.accessToken;

    // 1. Verify PRICING_DEFAULTS unchanged: exactly 4 billable actions, zero v2.2 pricing inflation
    const pricingRes = await requestV1<
      | { items?: Array<{ action: string; pricePoints?: number; points?: number }> }
      | Array<{ action: string }>
    >('/pricing', { token });
    const pricingData = unwrapOk(pricingRes, 'GET /api/v1/pricing');
    const pricingItems = Array.isArray(pricingData) ? pricingData : (pricingData.items ?? []);
    const actionKeys = pricingItems.map((p) => p.action).sort();
    expect(actionKeys).toEqual([
      'geo_variant',
      'geo_write',
      'inline_image_gen',
      'visibility_check',
    ]);

    // 2. Seed dual-market brand & run GLOBAL visibility check with fake collector
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 2);

    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [
          `Best quiet 4-bay private cloud NAS ${tag}`,
          `Compare ${brand.name} vs competitors for 4K editing studio [E2E_COMP_DOMAIN]`,
          `Quiet home server power consumption guide [E2E_GAP]`,
        ],
      },
      uniqueIdemKey('t101-run'),
    );
    const doneRun = await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);
    expect(['COMPLETED', 'PARTIAL']).toContain(doneRun.status);

    // 3. Query 4-tier Near-Miss API with full parameter matrix
    const nmRes = await requestV2<NearMissListWire>(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=30`,
      { token },
    );
    const nm = unwrapOk(nmRes, 'GET /visibility/near-miss');
    expect(nm.brandId).toBe(brand.id);
    expect(nm.market).toBe('GLOBAL');
    expect(nm.days).toBe(30);
    expect(typeof nm.hasRawRetrievalSignals).toBe('boolean');
    expect(nm.tierCounts).toEqual(
      expect.objectContaining({
        OPENED_NOT_CITED: expect.any(Number),
        RETRIEVED_NOT_CITED: expect.any(Number),
        CRAWLED_NOT_CITED: expect.any(Number),
        MENTIONED_NOT_OWNED: expect.any(Number),
      }),
    );
    expect(nm.total).toBeGreaterThan(0);
    expect(nm.items.length).toBeGreaterThan(0);

    // Verify sorted descending by opportunityScore
    for (let i = 1; i < nm.items.length; i += 1) {
      expect(nm.items[i - 1]!.opportunityScore).toBeGreaterThanOrEqual(
        nm.items[i]!.opportunityScore,
      );
    }

    // Filter by specific tier & sourceKind
    const sampleItem = nm.items[0]!;
    const filteredRes = await requestV2<NearMissListWire>(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=30&tier=${encodeURIComponent(sampleItem.tier)}&sourceKind=${encodeURIComponent(sampleItem.sourceKind)}`,
      { token },
    );
    const filtered = unwrapOk(filteredRes, 'GET /visibility/near-miss filtered');
    expect(filtered.items.length).toBeGreaterThan(0);
    for (const item of filtered.items) {
      expect(item.tier).toBe(sampleItem.tier);
      expect(item.sourceKind).toBe(sampleItem.sourceKind);
    }

    // 4. Create one-click NEAR_MISS_BOOST brief at strictly 0 points under STRICT billing
    const pointsBefore = await getWalletPoints(tenant.session);
    const boostRes = await requestV2<{
      id: string;
      sourceType: string;
      priorityScore: number;
      outlineH2: Array<{ heading?: string; intent?: string } | string>;
      diagnosisSummary: string;
      sourceCitationUrl?: string | null;
    }>(`/brands/${brand.id}/briefs/from-near-miss`, {
      method: 'POST',
      token,
      body: {
        market: 'GLOBAL',
        tier: sampleItem.tier,
        targetPrompt: sampleItem.prompts[0] || `Best quiet 4-bay private cloud NAS ${tag}`,
        sourceUrl: 'https://near-miss.e2e.example/articles/storage-overview',
        sourceTitle: 'Overview Notes on Storage Hardware',
        observationIds: sampleItem.observationIds.slice(0, 5),
      },
    });
    const boostBrief = unwrapOk(boostRes, 'POST /briefs/from-near-miss');
    expect(boostBrief.id).toBeTruthy();
    expect(boostBrief.sourceType).toBe('NEAR_MISS_BOOST');
    expect(boostBrief.priorityScore).toBeGreaterThanOrEqual(72);
    expect(boostBrief.priorityScore).toBeLessThanOrEqual(88);
    expect(Array.isArray(boostBrief.outlineH2) && boostBrief.outlineH2.length).toBeGreaterThan(0);
    expect(boostBrief.diagnosisSummary.length).toBeGreaterThan(5);

    const pointsAfter = await getWalletPoints(tenant.session);
    expect(pointsAfter, 'from-near-miss must cost 0 points even under STRICT billing').toBe(
      pointsBefore,
    );

    const briefs = await listBriefsApi(tenant.session, brand.id, 'GLOBAL');
    expect(briefs.some((b) => b.id === boostBrief.id)).toBe(true);
  });

  test('T1-02: Control prompts, Wilson 95% CI & DiD auto-retest + Monthly ROI Report lifecycle & public EN/CN share', async ({}, testInfo) => {
    test.setTimeout(150_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't102roi');
    const tenant = await provisionIsolatedTenant({
      prefix: 't102roi',
      billingMode: 'STRICT',
      initialPoints: 250,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // 1. Configure <=5 controlPrompts on GLOBAL market
    const controlPrompts = [
      `Best Thunderbolt 4 dock for studio monitors ${tag}`,
      `Quiet ergonomic mechanical keyboard for developers ${tag}`,
      `Color-calibrated 4K editing display comparison ${tag}`,
    ];
    const patchMarketRes = await requestV2<{
      id: string;
      markets: Array<{ market: GeoMarket; controlPrompts?: string[] }>;
    }>(`/brands/${brand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: { controlPrompts },
    });
    const patchedBrand = unwrapOk(patchMarketRes, 'PATCH brand market controlPrompts');
    const globalMarket = patchedBrand.markets.find((m) => m.market === 'GLOBAL');
    expect(globalMarket?.controlPrompts).toEqual(controlPrompts);

    // 2. Seed baseline visibility run covering treatment + control prompts
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 2);
    const treatmentPrompt = `Best quiet 4-bay private cloud NAS ${tag}`;
    const baselineRun = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [treatmentPrompt, controlPrompts[0]!, controlPrompts[1]!],
      },
      uniqueIdemKey('t102-base'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, baselineRun.id, 45_000);

    // 3. Stream article & register backdated publish record so T+7 schedule is immediately due
    const article = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: treatmentPrompt,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't102-art',
    );
    const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const pubRes = await requestV2<PublishRecordWire>(`/articles/${article.id}/publish-records`, {
      method: 'POST',
      token,
      body: {
        publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-did`,
        channel: 'Official Blog',
        publishedAt: tenDaysAgoIso,
        autoRetest: { enabled: false },
      },
    });
    const pubRecord = unwrapOk(pubRes, 'POST publish-record backdated');

    // Enable T+7 schedule with includeControlPrompts right before sweep (eliminates cron race)
    const schedPatchRes = await requestV2<{ publishRecordId: string; items: RetestScheduleWire[] }>(
      `/publish-records/${pubRecord.id}/retest-schedules`,
      {
        method: 'PATCH',
        token,
        body: { enabled: true, includeControlPrompts: true, sampleCount: 1, milestones: [7] },
      },
    );
    const patchedSchedules = unwrapOk(
      schedPatchRes,
      'PATCH retest-schedules includeControlPrompts',
    );
    const t7Before = patchedSchedules.items.find((s) => s.milestoneDay === 7);
    expect(t7Before?.includeControlPrompts).toBe(true);

    // Trigger due retest schedule sweep & wait for COMPLETED with Wilson CI + controlMetricsJson + DiD
    await triggerMaintenance('retest-schedule-sweep');
    const t7Done = await waitForDueRetestScheduleDone(
      token,
      article.id,
      pubRecord.id,
      7,
      ['COMPLETED'],
      60_000,
    );
    expect(t7Done.status).toBe('COMPLETED');
    expect(t7Done.includeControlPrompts).toBe(true);
    expect(t7Done.metricsSnapshot).toBeTruthy();
    assertValidWilson(t7Done.metricsSnapshot?.wilson, 'T+7 treatment metricsSnapshot');
    expect(t7Done.controlMetricsJson, 'DiD controlMetricsJson must be persisted').toBeTruthy();
    expect(t7Done.controlMetricsJson!.controlPrompts.length).toBeGreaterThan(0);
    expect(t7Done.controlMetricsJson!.controlPrompts.length).toBeLessThanOrEqual(2);
    assertValidWilson(t7Done.controlMetricsJson!.wilson, 'T+7 controlMetricsJson');
    expect(t7Done.controlMetricsJson!.did).toBeTruthy();
    expect(['POSITIVE', 'NEGATIVE', 'NEUTRAL']).toContain(
      t7Done.controlMetricsJson!.did!.direction,
    );

    // 4. Monthly ROI Report lifecycle (GLOBAL en-US + CN zh-CN)
    const periodStart = isoDateDaysAgo(30);
    const periodEnd = isoTimestampHoursFromNow(1);

    const createEnRes = await requestV2<RoiReportRecordWire>(`/brands/${brand.id}/roi-reports`, {
      method: 'POST',
      token,
      body: {
        market: 'GLOBAL',
        title: `Executive GEO ROI Report ${tag}`,
        periodStart,
        periodEnd,
        locale: 'en-US',
        whiteLabelOrg: 'Northstar Growth Partners',
      },
    });
    const enReport = unwrapOk(createEnRes, 'POST EN roi-report');
    expect(enReport.id).toBeTruthy();
    expect(enReport.locale).toBe('en-US');
    expect(enReport.whiteLabelOrg).toBe('Northstar Growth Partners');
    expect(enReport.summary.version).toBe(1);
    assertValidWilson(enReport.summary.overview.mentionWilson, 'ROI report overview mentionWilson');
    expect(JSON.stringify(enReport)).not.toContain('shareTokenHash');

    // List & Detail
    const listRes = await requestV2<{ items: RoiReportRecordWire[] }>(
      `/brands/${brand.id}/roi-reports?market=GLOBAL`,
      { token },
    );
    const listed = unwrapOk(listRes, 'GET roi-reports list').items;
    expect(listed.some((r) => r.id === enReport.id)).toBe(true);

    const detailRes = await requestV2<RoiReportRecordWire>(`/roi-reports/${enReport.id}`, {
      token,
    });
    expect(unwrapOk(detailRes, 'GET roi-report detail').id).toBe(enReport.id);

    // Export standalone HTML: text/html, inline <svg>, @media print, zero external CDN
    const htmlRes = await requestV2Binary(`/roi-reports/${enReport.id}/export.html`, { token });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type') || '').toContain('text/html');
    const htmlStr = htmlRes.bytes.toString('utf8');
    expect(htmlStr).toContain('<svg');
    expect(htmlStr).toContain('@media print');
    expect(htmlStr).toContain('Northstar Growth Partners');
    for (const forbiddenCdn of [
      'https://cdn.',
      'unpkg.com',
      'jsdelivr.net',
      'fonts.googleapis.com',
      'cdnjs.cloudflare.com',
    ]) {
      expect(htmlStr.toLowerCase()).not.toContain(forbiddenCdn);
    }

    // Issue public share link & fetch unauthenticated EN report
    const shareRes = await requestV2<RoiReportShareWire>(`/roi-reports/${enReport.id}/share`, {
      method: 'POST',
      token,
      body: { ttlDays: 30 },
    });
    const shareData = unwrapOk(shareRes, 'POST roi-report share');
    expect(shareData.sharePath).toMatch(/^\/share\/report\/[A-Za-z0-9_-]{20,}$/);
    const enToken = shareData.sharePath.split('/').pop()!;

    const pubEnRes = await requestV2<PublicRoiReportWire>(`/public/roi-reports/${enToken}`);
    const pubEn = unwrapOk(pubEnRes, 'GET public EN roi-report');
    expect(pubEn.locale).toBe('en-US');
    expect(pubEn.whiteLabelOrg).toBe('Northstar Growth Partners');
    expect(pubEn.brandName).toBeTruthy();
    assertValidWilson(pubEn.summary.overview.mentionWilson, 'Public EN report mentionWilson');

    // Create & share CN zh-CN ROI report too
    const createCnRes = await requestV2<RoiReportRecordWire>(`/brands/${brand.id}/roi-reports`, {
      method: 'POST',
      token,
      body: {
        market: 'CN',
        title: `月度 GEO ROI 复盘 ${tag}`,
        periodStart,
        periodEnd,
        locale: 'zh-CN',
      },
    });
    const cnReport = unwrapOk(createCnRes, 'POST CN roi-report');
    const cnShare = unwrapOk(
      await requestV2<RoiReportShareWire>(`/roi-reports/${cnReport.id}/share`, {
        method: 'POST',
        token,
        body: { ttlDays: 14 },
      }),
      'POST CN roi-report share',
    );
    const cnToken = cnShare.sharePath.split('/').pop()!;
    const pubCn = unwrapOk(
      await requestV2<PublicRoiReportWire>(`/public/roi-reports/${cnToken}`),
      'GET public CN roi-report',
    );
    expect(pubCn.locale).toBe('zh-CN');
    expect(pubCn.market).toBe('CN');

    // Revoke EN share -> immediate uniform 404
    const revokeRes = await requestV2<{ revoked: boolean }>(`/roi-reports/${enReport.id}/share`, {
      method: 'DELETE',
      token,
    });
    expect(unwrapOk(revokeRes, 'DELETE roi-report share').revoked).toBe(true);
    const afterRevoke = await requestV2(`/public/roi-reports/${enToken}`);
    expect(afterRevoke.status).toBe(404);
  });

  test('T1-03: 5 new L1 Connectors (Ghost, Dev.to, Hashnode, GitHub MDX, WeChat Official) + Shopify OAuth 2.0 & Custom Token', async ({}, testInfo) => {
    test.setTimeout(180_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't103l1');
    const tenant = await provisionIsolatedTenant({
      prefix: 't103l1',
      billingMode: 'STRICT',
      initialPoints: 300,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { ownedDomains: ['nordvault.e2e.example'] },
      }),
      'PATCH GLOBAL ownedDomains for L1 canonical URL test',
    );

    const globalArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Engineering benchmark of quiet 4-bay NAS ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't103-global-art',
    );
    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `四盘位静音家用私有云 NAS 深度实测 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't103-cn-art',
    );

    const secrets = {
      ghost: E2E_GHOST_ADMIN_API_KEY,
      devto: 'devto_e2e_secret_api_key_9911',
      hashnode: 'hn_e2e_pat_secret_8822',
      github: 'ghp_e2e_secret_token_7733',
      wechatSecret: 'wx_e2e_app_secret_6644',
      shopifyCustom: 'shpat_e2e_custom_token_5555',
    };

    const createAndTestConn = async (
      payload: Record<string, unknown>,
      rawSecret: string,
      label: string,
    ): Promise<ChannelConnectionWire> => {
      const createRes = await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: payload,
      });
      const conn = unwrapOk(createRes, `Create ${label} connection`);
      expect(conn.credentialHint).toContain('****');
      expect(JSON.stringify(conn)).not.toContain(rawSecret);

      const testRes = await requestV2<ConnectionTestWire>(
        `/brands/${brand.id}/connections/${conn.id}/test`,
        { method: 'POST', token, body: {} },
      );
      const testData = unwrapOk(testRes, `Test ${label} connection`);
      expect(testData.ok, `${label} test must succeed: ${testData.message}`).toBe(true);
      expect(testData.status).toBe('ACTIVE');
      return conn;
    };

    // 1. Create & test all 5 new L1 connectors + Shopify Custom Token fallback
    const ghostIndexNowKey = 'e2eghostindexnowkey123456';
    const ghostConn = await createAndTestConn(
      {
        market: 'GLOBAL',
        provider: 'GHOST',
        displayName: 'E2E Ghost Blog',
        siteBaseUrl: 'https://ghost.e2e.example',
        credentials: { adminApiKey: secrets.ghost },
        configJson: { inlineJsonLd: true, indexNowKey: ghostIndexNowKey, tags: ['GEO', 'NAS'] },
      },
      secrets.ghost,
      'GHOST',
    );

    const devtoConn = await createAndTestConn(
      {
        market: 'GLOBAL',
        provider: 'DEVTO',
        displayName: 'E2E Dev.to',
        siteBaseUrl: 'https://dev.to',
        credentials: { apiKey: secrets.devto },
        configJson: {
          tags: ['geo', 'storage', 'nas', 'selfhosted', 'extraignored'],
          primaryDomain: 'https://nordvault.e2e.example',
        },
      },
      secrets.devto,
      'DEVTO',
    );

    const hashnodeConn = await createAndTestConn(
      {
        market: 'GLOBAL',
        provider: 'HASHNODE',
        displayName: 'E2E Hashnode',
        siteBaseUrl: 'https://gql.hashnode.com',
        credentials: { apiToken: secrets.hashnode },
        configJson: {
          publicationId: 'hn_pub_1001',
          primaryDomain: 'https://nordvault.e2e.example',
        },
      },
      secrets.hashnode,
      'HASHNODE',
    );

    const githubConn = await createAndTestConn(
      {
        market: 'GLOBAL',
        provider: 'GITHUB_MDX',
        displayName: 'E2E GitHub Docs',
        siteBaseUrl: 'https://api.github.com',
        credentials: { token: secrets.github },
        configJson: {
          repoOwner: 'geomix-bot',
          repoName: 'docs',
          branch: 'main',
          contentDir: 'content/blog',
          fileExtension: 'mdx',
          publicUrlTemplate: 'https://crawl-ok.e2e.example/docs/{slug}',
        },
      },
      secrets.github,
      'GITHUB_MDX',
    );

    const wechatConn = await createAndTestConn(
      {
        market: 'CN',
        provider: 'WECHAT_OFFICIAL',
        displayName: 'E2E 公众号草稿箱',
        siteBaseUrl: 'https://wechat.e2e.example',
        credentials: { appId: `wx_e2e_${tag}`, appSecret: secrets.wechatSecret },
        configJson: {
          author: 'GeoMix 评测组',
          defaultPublishAsDraft: true,
          defaultCoverMediaId: 'wx_e2e_default_cover_media',
        },
      },
      secrets.wechatSecret,
      'WECHAT_OFFICIAL',
    );
    const preClearWechatCaptures = await fetchFixtureCaptures();
    expect(
      preClearWechatCaptures.some((c) => c.kind === 'wechat_token'),
      'WeChat Official testConnection must request /cgi-bin/stable_token',
    ).toBe(true);

    // Custom Token Shopify still works
    const shopifyCustomConn = await createAndTestConn(
      {
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'E2E Shopify Custom',
        siteBaseUrl: 'https://shopify.e2e.example',
        credentials: { accessToken: secrets.shopifyCustom },
      },
      secrets.shopifyCustom,
      'SHOPIFY_CUSTOM',
    );
    expect(shopifyCustomConn.authType).toBe('API_KEY');

    // 2. Shopify OAuth 2.0 happy path: start -> callback with valid HMAC -> OAUTH connection + webhook capture
    await clearFixtureCaptures();
    const shopDomain = `e2e-${tag
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12)}.myshopify.com`;
    const oauthStartRes = await requestV2<{ authorizeUrl: string; state: string }>(
      `/brands/${brand.id}/connections/shopify/oauth/start`,
      {
        method: 'POST',
        token,
        body: { shop: shopDomain, market: 'GLOBAL', displayName: 'E2E Shopify OAuth Store' },
      },
    );
    const oauthStart = unwrapOk(oauthStartRes, 'POST shopify oauth/start');
    expect(oauthStart.authorizeUrl).toContain(`https://${shopDomain}/admin/oauth/authorize`);
    expect(oauthStart.state).toBeTruthy();

    const cbParams: Record<string, string> = {
      code: 'e2e_valid_oauth_code',
      shop: shopDomain,
      state: oauthStart.state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const validHmac = signShopifyOAuthQuery(cbParams, SHOPIFY_OAUTH_CLIENT_SECRET);
    const cbQuery = new URLSearchParams({ ...cbParams, hmac: validHmac }).toString();
    const cbRes = await fetch(`${apiV2Base()}/integrations/shopify/callback?${cbQuery}`, {
      redirect: 'manual',
    });
    expect([200, 302]).toContain(cbRes.status);

    const connsAfterOAuth = unwrapOk(
      await requestV2<{ items: ChannelConnectionWire[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      ),
      'GET connections after Shopify OAuth',
    ).items;
    const oauthConn = connsAfterOAuth.find((c) => c.externalShopDomain === shopDomain);
    expect(oauthConn, 'Shopify OAuth connection must be persisted').toBeTruthy();
    expect(oauthConn!.authType).toBe('OAUTH');
    expect(oauthConn!.status).toBe('ACTIVE');

    const oauthCaptures = await fetchFixtureCaptures();
    expect(
      oauthCaptures.some((c) => c.kind === 'shopify_oauth_token' && c.host === shopDomain),
      'Shopify OAuth token exchange capture required',
    ).toBe(true);
    expect(
      oauthCaptures.some((c) => c.kind === 'shopify_webhook_register' && c.host === shopDomain),
      'Shopify app/uninstalled webhook registration capture required',
    ).toBe(true);

    // 3. Generate variants & publish across all 5 new L1 connectors
    await clearFixtureCaptures();
    const globalTasks = await createVariantTasksSync(
      token,
      globalArticle.id,
      [
        { provider: 'GHOST', connectionId: ghostConn.id, channelLabel: 'E2E Ghost Blog' },
        {
          provider: 'DEVTO',
          connectionId: devtoConn.id,
          channelLabel: 'E2E Dev.to',
          templateKey: 'DEVELOPER_TECH_POST',
          targetUrlHint: 'https://nordvault.e2e.example/guides/nas-benchmark',
        },
        {
          provider: 'HASHNODE',
          connectionId: hashnodeConn.id,
          channelLabel: 'E2E Hashnode',
          templateKey: 'DEVELOPER_TECH_POST',
          targetUrlHint: 'https://nordvault.e2e.example/guides/nas-benchmark',
        },
        {
          provider: 'GITHUB_MDX',
          connectionId: githubConn.id,
          channelLabel: 'E2E GitHub PR Draft',
          publishAsDraft: true,
        },
        {
          provider: 'GITHUB_MDX',
          connectionId: githubConn.id,
          channelLabel: 'E2E GitHub Live Commit',
          publishAsDraft: false,
        },
      ],
      't103-global-vars',
    );
    const [ghostTask, devtoTask, hashnodeTask, ghDraftTask, ghLiveTask] = globalTasks;

    const cnTasks = await createVariantTasksSync(
      token,
      cnArticle.id,
      [
        {
          provider: 'WECHAT_OFFICIAL',
          connectionId: wechatConn.id,
          channelLabel: 'E2E 公众号草稿箱',
          templateKey: 'WECHAT_OFFICIAL_ARTICLE',
          publishAsDraft: true,
        },
      ],
      't103-cn-vars',
    );
    const wechatTask = cnTasks[0]!;

    const publishAndPoll = async (
      artId: string,
      taskId: string,
      publishAsDraft: boolean,
      label: string,
    ): Promise<DistributionTaskWire> => {
      const res = await requestV2<DistributionTaskWire>(`/distributions/${taskId}/publish`, {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey(`pub-${label}`) },
        body: { publishAsDraft, acknowledgePreflightWarnings: true },
      });
      unwrapOk(res, `POST publish ${label}`);
      return pollDistributionTaskDone(token, artId, taskId, 35_000);
    };

    const doneGhost = await publishAndPoll(globalArticle.id, ghostTask!.id, false, 'ghost');
    expect(doneGhost.status).toBe('PUBLISHED');
    expect(doneGhost.remotePublishedUrl).toContain('https://ghost.e2e.example/');

    const doneDevto = await publishAndPoll(globalArticle.id, devtoTask!.id, false, 'devto');
    expect(doneDevto.status).toBe('PUBLISHED');
    expect(doneDevto.remotePublishedUrl).toContain('https://dev.to/');

    const doneHashnode = await publishAndPoll(
      globalArticle.id,
      hashnodeTask!.id,
      false,
      'hashnode',
    );
    expect(doneHashnode.status).toBe('PUBLISHED');
    expect(doneHashnode.remotePublishedUrl).toContain('https://hashnode.e2e.example/');

    const doneGhDraft = await publishAndPoll(globalArticle.id, ghDraftTask!.id, true, 'gh-draft');
    expect(doneGhDraft.status).toBe('DRAFT_PUSHED');
    expect(doneGhDraft.remoteAdminUrl).toContain('https://github.com/geomix-bot/docs/pull/');

    const doneGhLive = await publishAndPoll(globalArticle.id, ghLiveTask!.id, false, 'gh-live');
    expect(doneGhLive.status).toBe('PUBLISHED');
    expect(doneGhLive.remotePublishedUrl).toContain('https://crawl-ok.e2e.example/docs/');

    const doneWechat = await publishAndPoll(cnArticle.id, wechatTask.id, true, 'wechat');
    expect(doneWechat.status).toBe('DRAFT_PUSHED');
    expect(doneWechat.remotePostId).toContain('wx_draft_media_');

    // 4. Verify exact wire-level fixture captures across all 5 L1 connectors + IndexNow
    const captures = await fetchFixtureCaptures();

    const ghostCap = captures.find((c) => c.kind === 'ghost_post');
    expect(ghostCap, 'Ghost POST /ghost/api/admin/posts capture required').toBeTruthy();
    expect(ghostCap!.parsedBody?.jwtKid).toBe('e2e_ghost_key');
    expect(ghostCap!.parsedBody?.source).toBe('html');
    expect(String(ghostCap!.parsedBody?.codeinjection_head || '')).toContain('application/ld+json');
    expect(
      captures.some(
        (c) =>
          c.kind === 'indexnow' && JSON.stringify(c.parsedBody || {}).includes('ghost.e2e.example'),
      ),
      'Ghost live publish with indexNowKey must trigger IndexNow',
    ).toBe(true);

    const expectedOwnedHosts = new Set(['nordvault.e2e.example', 'ghost.e2e.example']);

    const devtoCap = captures.find((c) => c.kind === 'devto_article');
    expect(devtoCap, 'Dev.to POST /api/articles capture required').toBeTruthy();
    expect(devtoCap!.headers['api-key']).toBe(secrets.devto);
    const devtoArticleBody = (devtoCap!.parsedBody?.article || {}) as Record<string, unknown>;
    expect(Array.isArray(devtoArticleBody.tags), 'Dev.to article.tags must be an array').toBe(true);
    const devtoTags = devtoArticleBody.tags as unknown[];
    expect(devtoTags.length, 'Dev.to article.tags must be non-empty').toBeGreaterThan(0);
    expect(devtoTags.length, 'Dev.to article.tags must be capped at <= 4').toBeLessThanOrEqual(4);
    const devtoCanonical = String(devtoArticleBody.canonical_url || '');
    expect(devtoCanonical, 'Dev.to canonical_url must start with https://').toMatch(/^https:\/\//);
    expect(
      expectedOwnedHosts.has(new URL(devtoCanonical).hostname),
      `Dev.to canonical_url must target an owned host, got ${devtoCanonical}`,
    ).toBe(true);

    const hashnodeCap = captures.find((c) => c.kind === 'hashnode_publish_post');
    expect(hashnodeCap, 'Hashnode publishPost capture required').toBeTruthy();
    const hnInput = ((hashnodeCap!.parsedBody?.variables as Record<string, unknown> | undefined)
      ?.input || {}) as Record<string, unknown>;
    const hnCanonical = String(hnInput.originalArticleURL || '');
    expect(hnCanonical, 'Hashnode originalArticleURL must start with https://').toMatch(
      /^https:\/\//,
    );
    expect(
      expectedOwnedHosts.has(new URL(hnCanonical).hostname),
      `Hashnode originalArticleURL must target an owned host, got ${hnCanonical}`,
    ).toBe(true);

    const ghPutCaps = captures.filter((c) => c.kind === 'github_put_contents');
    expect(ghPutCaps.length).toBeGreaterThanOrEqual(2);
    expect(String(ghPutCaps[0]!.parsedBody?.decodedContent || '')).toContain('---');
    expect(captures.some((c) => c.kind === 'github_create_ref')).toBe(true);
    expect(captures.some((c) => c.kind === 'github_create_pr')).toBe(true);

    expect(captures.some((c) => c.kind === 'wechat_draft_add')).toBe(true);
    expect(
      captures.filter((c) => c.kind === 'wechat_forbidden_mass_send'),
      'RED LINE: WeChat mass-send / freepublish must have 0 calls',
    ).toEqual([]);
  });

  test('T1-04: Multi-locale writing (ja-JP) & async GeoVariantJob (DEVELOPER_TECH_POST + WECHAT_OFFICIAL_ARTICLE)', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 't104ml');
    const tenant = await provisionIsolatedTenant({
      prefix: 't104ml',
      billingMode: 'STRICT',
      initialPoints: 200,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // Configure supportedLocales on GLOBAL market
    const patchRes = await requestV2<{
      markets: Array<{ market: GeoMarket; supportedLocales?: string[] }>;
    }>(`/brands/${brand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: { supportedLocales: ['en-US', 'de-DE', 'ja-JP'] },
    });
    const updated = unwrapOk(patchRes, 'PATCH supportedLocales');
    const gm = updated.markets.find((m) => m.market === 'GLOBAL');
    expect(gm?.supportedLocales).toEqual(['en-US', 'de-DE', 'ja-JP']);

    // Stream a ja-JP article
    const jaArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetLocale: 'ja-JP',
        targetPrompt: `静音 4ベイ プライベートクラウド NAS の比較ガイド ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't104-ja-art',
    );
    expect(jaArticle.targetLocale).toBe('ja-JP');

    // Launch async GeoVariantJob for GLOBAL multi-locale + DEVELOPER_TECH_POST
    const jobRes = await requestV2<VariantJobWire>(
      `/articles/${jaArticle.id}/distributions/variant-jobs`,
      {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey('t104-varjob-ja') },
        body: {
          targets: [
            {
              provider: 'DEVTO',
              channelLabel: 'Dev.to JP Tech',
              targetLocale: 'ja-JP',
              templateKey: 'DEVELOPER_TECH_POST',
            },
            {
              provider: 'GHOST',
              channelLabel: 'Ghost DE Blog',
              targetLocale: 'de-DE',
            },
          ],
        },
      },
    );
    const createdJob = unwrapOk(jobRes, 'POST async variant-job GLOBAL');
    const doneJob = await pollVariantJobDone(token, jaArticle.id, createdJob.id, 45_000);
    expect(doneJob.status).toBe('COMPLETED');
    expect(doneJob.doneCount).toBe(2);
    expect(doneJob.failCount).toBe(0);
    expect(doneJob.taskIds.length).toBe(2);

    const distItems = unwrapOk(
      await requestV2<{ items: DistributionTaskWire[] }>(
        `/articles/${jaArticle.id}/distributions`,
        { token },
      ),
      'GET distributions after async variant job',
    ).items;
    const jaDevto = distItems.find((t) => t.provider === 'DEVTO');
    const deGhost = distItems.find((t) => t.provider === 'GHOST');
    expect(jaDevto?.targetLocale).toBe('ja-JP');
    expect(deGhost?.targetLocale).toBe('de-DE');

    // Also exercise WECHAT_OFFICIAL_ARTICLE template via async variant job on CN article
    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetLocale: 'zh-CN',
        targetPrompt: `家用静音私有云 NAS 选购避坑指南 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't104-cn-art',
    );
    const cnJob = unwrapOk(
      await requestV2<VariantJobWire>(`/articles/${cnArticle.id}/distributions/variant-jobs`, {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey('t104-varjob-cn') },
        body: {
          targets: [
            {
              provider: 'WECHAT_OFFICIAL',
              channelLabel: '公众号长文',
              targetLocale: 'zh-CN',
              templateKey: 'WECHAT_OFFICIAL_ARTICLE',
            },
          ],
        },
      }),
      'POST async variant-job CN WeChat',
    );
    const doneCnJob = await pollVariantJobDone(token, cnArticle.id, cnJob.id, 45_000);
    expect(doneCnJob.status).toBe('COMPLETED');
    expect(doneCnJob.doneCount).toBe(1);
  });

  test('T1-05: L2 Chrome Extension Bridge token CRUD, /me CORS, /tasks & /confirm-published', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 't105ext');
    const tenant = await provisionIsolatedTenant({
      prefix: 't105ext',
      billingMode: 'STRICT',
      initialPoints: 150,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `四盘位家用私有云 NAS 知乎深度评测 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't105-cn-art',
    );

    const [zhihuTask] = await createVariantTasksSync(
      token,
      cnArticle.id,
      [{ provider: 'ZHIHU_EXT', channelLabel: '知乎专栏（扩展）' }],
      't105-zhihu-var',
    );
    expect(zhihuTask!.mode).toBe('L2_EXTENSION');

    // 1. Issue gmext_ token (plaintext returned ONCE)
    const issueRes = await requestV2<CreateExtensionTokenWire>('/extension/tokens', {
      method: 'POST',
      token,
      body: { label: 'MacBook Chrome 扩展', ttlDays: 90 },
    });
    const issued = unwrapOk(issueRes, 'POST /extension/tokens');
    expect(issued.plainToken.startsWith('gmext_')).toBe(true);
    expect(issued.plainToken.length).toBeGreaterThanOrEqual(38);
    expect(issued.token.label).toBe('MacBook Chrome 扩展');
    expect(issued.token.tokenPrefix).toBeTruthy();

    // GET list MUST NEVER echo plainToken or tokenHash
    const listTokRes = await requestV2<{ items: ExtensionTokenWire[] }>('/extension/tokens', {
      token,
    });
    const listedTokens = unwrapOk(listTokRes, 'GET /extension/tokens').items;
    expect(listedTokens.some((t) => t.id === issued.token.id)).toBe(true);
    expect(JSON.stringify(listedTokens)).not.toContain(issued.plainToken);
    expect(JSON.stringify(listedTokens)).not.toContain('tokenHash');

    // 2. Call GET /api/v2/extension/me with Origin: chrome-extension://...
    const meRes = await requestV2<ExtensionMeWire>('/extension/me', {
      token: issued.plainToken,
      headers: { Origin: E2E_EXTENSION_ORIGIN },
    });
    expect(meRes.headers.get('access-control-allow-origin')).toBe(E2E_EXTENSION_ORIGIN);
    const me = unwrapOk(meRes, 'GET /extension/me');
    expect(me.bridgeVersion).toBe('v1');
    expect(me.tokenLabel).toBe('MacBook Chrome 扩展');
    expect(me.brands.some((b) => b.id === brand.id)).toBe(true);

    // 3. Call GET /api/v2/extension/tasks
    const tasksRes = await requestV2<{ bridgeVersion: 'v1'; items: ExtensionPendingTaskWire[] }>(
      `/extension/tasks?brandId=${brand.id}&provider=ZHIHU_EXT`,
      {
        token: issued.plainToken,
        headers: { Origin: E2E_EXTENSION_ORIGIN },
      },
    );
    const tasksData = unwrapOk(tasksRes, 'GET /extension/tasks');
    expect(tasksData.bridgeVersion).toBe('v1');
    const foundTask = tasksData.items.find((t) => t.taskId === zhihuTask!.id);
    expect(foundTask, 'Pending ZHIHU_EXT task must appear in /extension/tasks').toBeTruthy();
    expect(foundTask!.variantMarkdown.length).toBeGreaterThan(20);
    expect(Array.isArray(foundTask!.antiBanChecklist)).toBe(true);

    // 4. Confirm published -> creates GeoPublishRecord + T+7/14/30 schedules
    const publishedUrl = `https://crawl-ok.e2e.example/zhihu/${tag}`;
    const confirmRes = await requestV2<ExtensionConfirmWire>(
      `/extension/tasks/${zhihuTask!.id}/confirm-published`,
      {
        method: 'POST',
        token: issued.plainToken,
        headers: { Origin: E2E_EXTENSION_ORIGIN },
        body: { publishedUrl, note: '已手动发布至知乎专栏' },
      },
    );
    const confirmed = unwrapOk(confirmRes, 'POST /extension/tasks/:id/confirm-published');
    expect(confirmed.accepted).toBe(true);
    expect(confirmed.taskId).toBe(zhihuTask!.id);
    expect(confirmed.publishRecordId).toBeTruthy();
    expect(confirmed.publishedUrl).toBe(publishedUrl);
    expect(confirmed.status).toBe('PUBLISHED');
    expect(confirmed.alreadyRecorded).toBe(false);
    expect(confirmed.retestScheduledCount).toBeGreaterThanOrEqual(3);

    // Verify GeoPublishRecord + T+7/14/30 schedules via console API
    const pubRecs = unwrapOk(
      await requestV2<{ items: PublishRecordWire[] }>(`/articles/${cnArticle.id}/publish-records`, {
        token,
      }),
      'GET publish-records after extension confirm',
    ).items;
    const rec = pubRecs.find((r) => r.id === confirmed.publishRecordId);
    expect(rec, 'GeoPublishRecord must exist after extension confirm').toBeTruthy();
    const days = (rec!.retestSchedules || []).map((s) => s.milestoneDay).sort((a, b) => a - b);
    expect(days).toEqual(expect.arrayContaining([7, 14, 30]));

    // 5. Revoke token
    const delRes = await requestV2<{ revoked: boolean }>(`/extension/tokens/${issued.token.id}`, {
      method: 'DELETE',
      token,
    });
    expect(unwrapOk(delRes, 'DELETE /extension/tokens/:id').revoked).toBe(true);
  });
});

// ============================================================================
// Tier 2 — Boundary, Corner & Negative Security
// ============================================================================

test.describe('Tier 2 — GeoMix v2.2 Boundary, Corner & Negative Security', () => {
  test('T2-01: SSRF 400 rejection across from-near-miss, all 5 new L1 connectors & extension confirm-published', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 't201ssrf');
    const tenant = await provisionIsolatedTenant({
      prefix: 't201ssrf',
      billingMode: 'STRICT',
      initialPoints: 150,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // 1. Near-Miss auth/query/isolation guards (401, 400, 404) & SSRF on POST /briefs/from-near-miss
    const nmUnauth = await requestV2(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=30`,
    );
    expect(nmUnauth.status, 'Unauthenticated GET /visibility/near-miss must return 401').toBe(401);

    const nmBadDays = await requestV2(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=999`,
      { token },
    );
    expect(nmBadDays.status, 'Invalid days=999 on /visibility/near-miss must return 400').toBe(400);

    const nmBadTier = await requestV2(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&tier=INVALID_TIER`,
      { token },
    );
    expect(nmBadTier.status, 'Invalid tier on /visibility/near-miss must return 400').toBe(400);

    const otherTenant = await provisionIsolatedTenant({
      prefix: 't201other',
      billingMode: 'STRICT',
      initialPoints: 50,
    });
    const nmCrossTenant = await requestV2(
      `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=30`,
      { token: otherTenant.session.accessToken },
    );
    expect(nmCrossTenant.status, 'Cross-tenant GET /visibility/near-miss must return 404').toBe(
      404,
    );

    for (const ssrfUrl of SSRF_BLOCKED_URLS) {
      const res = await requestV2(`/brands/${brand.id}/briefs/from-near-miss`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          tier: 'OPENED_NOT_CITED',
          targetPrompt: `SSRF probe prompt ${tag}`,
          sourceUrl: ssrfUrl,
        },
      });
      expect(res.status, `from-near-miss must reject SSRF URL ${ssrfUrl} with 400`).toBe(400);
    }

    // 2. SSRF on all 5 new L1 connectors (private siteBaseUrl + private configJson.apiBaseUrl)
    const connectorCases: Array<{
      provider: string;
      market: GeoMarket;
      validSiteBaseUrl: string;
      credentials: Record<string, string>;
    }> = [
      {
        provider: 'GHOST',
        market: 'GLOBAL',
        validSiteBaseUrl: 'https://ghost.e2e.example',
        credentials: { adminApiKey: E2E_GHOST_ADMIN_API_KEY },
      },
      {
        provider: 'DEVTO',
        market: 'GLOBAL',
        validSiteBaseUrl: 'https://dev.to',
        credentials: { apiKey: 'devto_ssrf_probe_key' },
      },
      {
        provider: 'HASHNODE',
        market: 'GLOBAL',
        validSiteBaseUrl: 'https://gql.hashnode.com',
        credentials: { apiToken: 'hn_ssrf_probe_key' },
      },
      {
        provider: 'GITHUB_MDX',
        market: 'GLOBAL',
        validSiteBaseUrl: 'https://api.github.com',
        credentials: { token: 'ghp_ssrf_probe_key' },
      },
      {
        provider: 'WECHAT_OFFICIAL',
        market: 'CN',
        validSiteBaseUrl: 'https://wechat.e2e.example',
        credentials: { appId: 'wx_ssrf_probe', appSecret: 'wx_ssrf_secret' },
      },
    ];

    for (const c of connectorCases) {
      for (const badUrl of SSRF_BLOCKED_URLS.slice(0, 3)) {
        const res = await requestV2(`/brands/${brand.id}/connections`, {
          method: 'POST',
          token,
          body: {
            market: c.market,
            provider: c.provider,
            displayName: `SSRF ${c.provider}`,
            siteBaseUrl: badUrl,
            credentials: c.credentials,
          },
        });
        expect(
          res.status,
          `Connection ${c.provider} must reject private/loopback siteBaseUrl ${badUrl} with 400`,
        ).toBe(400);
      }

      const badApiBaseRes = await requestV2(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: c.market,
          provider: c.provider,
          displayName: `SSRF ApiBase ${c.provider}`,
          siteBaseUrl: c.validSiteBaseUrl,
          credentials: c.credentials,
          configJson: { apiBaseUrl: 'http://127.0.0.1:3001' },
        },
      });
      expect(
        badApiBaseRes.status,
        `Connection ${c.provider} must reject private configJson.apiBaseUrl with 400`,
      ).toBe(400);
    }

    // Redirect trap scoped strictly to self-hosted GHOST (where siteBaseUrl IS the Admin API host)
    const ghostRedirCreate = await requestV2<ChannelConnectionWire>(
      `/brands/${brand.id}/connections`,
      {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          provider: 'GHOST',
          displayName: 'SSRF Redirect GHOST',
          siteBaseUrl: 'https://ssrf-redirect.e2e.example/to-loopback',
          credentials: { adminApiKey: E2E_GHOST_ADMIN_API_KEY },
        },
      },
    );
    if (ghostRedirCreate.status === 200 && ghostRedirCreate.envelope.code === 0) {
      const connId = ghostRedirCreate.envelope.data.id;
      const testRes = await requestV2<ConnectionTestWire>(
        `/brands/${brand.id}/connections/${connId}/test`,
        { method: 'POST', token, body: {} },
      );
      if (testRes.status === 200 && testRes.envelope.code === 0) {
        expect(testRes.envelope.data.ok, 'GHOST test against ssrf-redirect must NOT succeed').toBe(
          false,
        );
      } else {
        expect([400, 422]).toContain(testRes.status);
      }
    } else {
      expect(ghostRedirCreate.status).toBe(400);
    }

    // Malformed Ghost adminApiKey format must be rejected with 400
    for (const badGhostKey of ['missingcolonsecret', 'id:not-valid-hex-xyz', 'id:abcd']) {
      const badGhostRes = await requestV2(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          provider: 'GHOST',
          displayName: 'Malformed Ghost Key',
          siteBaseUrl: 'https://ghost.e2e.example',
          credentials: { adminApiKey: badGhostKey },
        },
      });
      expect(
        badGhostRes.status,
        `GHOST must reject malformed adminApiKey '${badGhostKey}' with 400`,
      ).toBe(400);
    }

    // 3. SSRF on POST /api/v2/extension/tasks/:taskId/confirm-published
    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `扩展 SSRF 安全测试 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't201-cn-art',
    );
    const [extTask] = await createVariantTasksSync(
      token,
      cnArticle.id,
      [{ provider: 'ZHIHU_EXT', channelLabel: '知乎扩展' }],
      't201-ext-var',
    );
    const extTok = unwrapOk(
      await requestV2<CreateExtensionTokenWire>('/extension/tokens', {
        method: 'POST',
        token,
        body: { label: 'SSRF Guard Ext' },
      }),
      'Create ext token for SSRF test',
    ).plainToken;

    const directBlockedUrls = [
      ...SSRF_BLOCKED_URLS.slice(0, 3),
      'http://localhost:3001/',
      'file:///etc/passwd',
    ];
    for (const ssrfUrl of directBlockedUrls) {
      const res = await requestV2(`/extension/tasks/${extTask!.id}/confirm-published`, {
        method: 'POST',
        token: extTok,
        body: { publishedUrl: ssrfUrl },
      });
      expect(
        res.status,
        `extension confirm-published must reject direct SSRF URL ${ssrfUrl} with 400`,
      ).toBe(400);
    }

    // Redirect trap on confirm-published: either synchronous 400 OR crawl-probe BLOCKED/FAILED (never OK)
    const redirConfirmRes = await requestV2<ExtensionConfirmWire>(
      `/extension/tasks/${extTask!.id}/confirm-published`,
      {
        method: 'POST',
        token: extTok,
        body: { publishedUrl: 'https://ssrf-redirect.e2e.example/to-loopback' },
      },
    );
    if (redirConfirmRes.status === 200 && redirConfirmRes.envelope.code === 0) {
      const recId = redirConfirmRes.envelope.data.publishRecordId;
      expect(recId, 'confirm-published 200 must return publishRecordId').toBeTruthy();
      const probeRes = await requestV2<{ crawlStatus: string }>(
        `/publish-records/${recId}/crawl-probe`,
        { method: 'POST', token, body: {} },
      );
      if (probeRes.status === 200 && probeRes.envelope.code === 0) {
        expect(
          ['BLOCKED', 'FAILED'],
          `crawl-probe on ssrf-redirect must be BLOCKED or FAILED, got ${probeRes.envelope.data.crawlStatus}`,
        ).toContain(probeRes.envelope.data.crawlStatus);
      } else {
        expect([400, 422]).toContain(probeRes.status);
      }
    } else {
      expect(redirConfirmRes.status).toBe(400);
    }

    // 4. Expired tenant guard (403 / 40301) on POST /briefs/from-near-miss
    const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setTenantExpiry(tenant.tenantId, yesterdayIso);
    const expiredBoostRes = await requestV2(`/brands/${brand.id}/briefs/from-near-miss`, {
      method: 'POST',
      token,
      body: {
        market: 'GLOBAL',
        tier: 'OPENED_NOT_CITED',
        targetPrompt: `Expired tenant boost guard ${tag}`,
        sourceUrl: 'https://near-miss.e2e.example/articles/storage-overview',
      },
    });
    expect(expiredBoostRes.status, 'Expired tenant from-near-miss must return 403').toBe(403);
    expect(expiredBoostRes.envelope.code, 'Expired tenant error code must be 40301').toBe(40301);
  });

  test('T2-02: WeChat 40164 actionable IP whitelist hint & strict draft-only zero mass-send red line', async ({}, testInfo) => {
    test.setTimeout(120_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't202wx');
    const tenant = await provisionIsolatedTenant({
      prefix: 't202wx',
      billingMode: 'STRICT',
      initialPoints: 150,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // 1. Deterministic 40164 trigger via appId containing '40164'
    const wx40164Conn = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: 'CN',
          provider: 'WECHAT_OFFICIAL',
          displayName: 'WeChat 40164 Test',
          siteBaseUrl: 'https://wechat.e2e.example',
          credentials: { appId: 'wx_40164_e2e', appSecret: 'wx_secret_40164_test' },
        },
      }),
      'Create WeChat 40164 connection',
    );

    const test40164Res = await requestV2<ConnectionTestWire>(
      `/brands/${brand.id}/connections/${wx40164Conn.id}/test`,
      { method: 'POST', token, body: {} },
    );
    const test40164 = unwrapOk(test40164Res, 'Test WeChat 40164');
    expect(test40164.ok).toBe(false);
    expect(test40164.status).toBe('INVALID');
    expect(test40164.message).toMatch(/40164|白名单|IP/i);

    // 2. Valid WeChat connection requested with publishAsDraft: false MUST STILL draft-only & 0 mass-send calls!
    const wxValidConn = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: 'CN',
          provider: 'WECHAT_OFFICIAL',
          displayName: 'WeChat Draft Only Guard',
          siteBaseUrl: 'https://wechat.e2e.example',
          credentials: { appId: 'wx_valid_draft_only', appSecret: 'wx_valid_secret_9999' },
          configJson: { defaultCoverMediaId: 'wx_e2e_default_cover_media' },
        },
      }),
      'Create valid WeChat connection',
    );

    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `微信公众号仅推草稿箱安全红线测试 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't202-wx-art',
    );
    const [wxTask] = await createVariantTasksSync(
      token,
      cnArticle.id,
      [
        {
          provider: 'WECHAT_OFFICIAL',
          connectionId: wxValidConn.id,
          channelLabel: '公众号红线验证',
          templateKey: 'WECHAT_OFFICIAL_ARTICLE',
          publishAsDraft: false,
        },
      ],
      't202-wx-var',
    );

    await clearFixtureCaptures();
    unwrapOk(
      await requestV2(`/distributions/${wxTask!.id}/publish`, {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey('t202-wx-pub') },
        body: { publishAsDraft: false, acknowledgePreflightWarnings: true },
      }),
      'POST WeChat publish with publishAsDraft=false',
    );
    const doneTask = await pollDistributionTaskDone(token, cnArticle.id, wxTask!.id, 35_000);
    expect(
      doneTask.status,
      'WeChat Official must ALWAYS end in DRAFT_PUSHED, never mass-published',
    ).toBe('DRAFT_PUSHED');
    expect(doneTask.remotePostId).toContain('wx_draft_media_');

    const captures = await fetchFixtureCaptures();
    expect(captures.some((c) => c.kind === 'wechat_draft_add')).toBe(true);
    expect(
      captures.filter((c) => c.kind === 'wechat_forbidden_mass_send'),
      'Zero calls to /cgi-bin/freepublish/submit or /cgi-bin/message/mass/*',
    ).toEqual([]);
  });

  test('T2-03: Shopify OAuth negative security (non-myshopify, forged HMAC, state replay, forged webhook) & uninstall credential wipe', async ({}, testInfo) => {
    test.setTimeout(120_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't203shop');
    const tenant = await provisionIsolatedTenant({
      prefix: 't203shop',
      billingMode: 'STRICT',
      initialPoints: 100,
    });
    const token = tenant.session.accessToken;
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));

    // 1. Reject non-*.myshopify.com domains
    for (const badShop of [
      'evil.com',
      'myshopify.com',
      'evilmyshopify.com',
      'myshopify.com.evil.com',
      '127.0.0.1',
      'localhost',
    ]) {
      const res = await requestV2(`/brands/${brand.id}/connections/shopify/oauth/start`, {
        method: 'POST',
        token,
        body: { shop: badShop, market: 'GLOBAL' },
      });
      expect(res.status, `Shopify oauth/start must reject '${badShop}' with 400`).toBe(400);
    }

    // 2. Start legitimate OAuth flow
    const shopDomain = `sec-${tag
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12)}.myshopify.com`;
    const startData = unwrapOk(
      await requestV2<{ authorizeUrl: string; state: string }>(
        `/brands/${brand.id}/connections/shopify/oauth/start`,
        { method: 'POST', token, body: { shop: shopDomain, market: 'GLOBAL' } },
      ),
      'POST shopify oauth/start',
    );

    // 3. Reject forged HMAC callback
    const baseParams: Record<string, string> = {
      code: 'valid_code_123',
      shop: shopDomain,
      state: startData.state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const forgedQuery = new URLSearchParams({
      ...baseParams,
      hmac: '0'.repeat(64),
    }).toString();
    const forgedCb = await fetch(`${apiV2Base()}/integrations/shopify/callback?${forgedQuery}`, {
      redirect: 'manual',
    });
    expect([400, 401]).toContain(forgedCb.status);

    // 4. Complete valid callback once -> succeeds
    const validHmac = signShopifyOAuthQuery(baseParams, SHOPIFY_OAUTH_CLIENT_SECRET);
    const validQuery = new URLSearchParams({ ...baseParams, hmac: validHmac }).toString();
    const okCb = await fetch(`${apiV2Base()}/integrations/shopify/callback?${validQuery}`, {
      redirect: 'manual',
    });
    expect([200, 302]).toContain(okCb.status);

    // 5. Replaying same single-use state MUST be rejected
    const replayCb = await fetch(`${apiV2Base()}/integrations/shopify/callback?${validQuery}`, {
      redirect: 'manual',
    });
    expect([400, 401]).toContain(replayCb.status);

    // Confirm connection is ACTIVE
    const connsBefore = unwrapOk(
      await requestV2<{ items: ChannelConnectionWire[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      ),
      'GET connections before uninstall',
    ).items;
    const oauthConn = connsBefore.find((c) => c.externalShopDomain === shopDomain);
    expect(oauthConn?.status).toBe('ACTIVE');

    // 6. Reject forged X-Shopify-Hmac-Sha256 on app/uninstalled webhook
    const webhookBody = JSON.stringify({
      id: 999001,
      domain: shopDomain,
      myshopify_domain: shopDomain,
    });
    const badWebhookRes = await fetch(
      `${apiV2Base()}/integrations/shopify/webhooks/app-uninstalled`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': 'app/uninstalled',
          'x-shopify-shop-domain': shopDomain,
          'x-shopify-hmac-sha256': 'Zm9yZ2VkX2htYWNfc2lnbmF0dXJl',
        },
        body: webhookBody,
      },
    );
    expect([400, 401]).toContain(badWebhookRes.status);

    // 7. Valid raw-body HMAC disables connection & wipes credentials
    const validWebhookSig = signShopifyWebhook(webhookBody, SHOPIFY_OAUTH_CLIENT_SECRET);
    const okWebhookRes = await fetch(
      `${apiV2Base()}/integrations/shopify/webhooks/app-uninstalled`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': 'app/uninstalled',
          'x-shopify-shop-domain': shopDomain,
          'x-shopify-hmac-sha256': validWebhookSig,
        },
        body: webhookBody,
      },
    );
    expect(okWebhookRes.status).toBe(200);

    const connsAfter = unwrapOk(
      await requestV2<{ items: ChannelConnectionWire[] }>(
        `/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      ),
      'GET connections after uninstall',
    ).items;
    const disabledConn = connsAfter.find((c) => c.id === oauthConn!.id);
    expect(disabledConn?.status).toBe('DISABLED');

    // Subsequent test against wiped connection MUST fail cleanly (ok=false or 400)
    const testAfterWipe = await requestV2<ConnectionTestWire>(
      `/brands/${brand.id}/connections/${oauthConn!.id}/test`,
      { method: 'POST', token, body: {} },
    );
    if (testAfterWipe.status === 200 && testAfterWipe.envelope.code === 0) {
      expect(testAfterWipe.envelope.data.ok).toBe(false);
    } else {
      expect([400, 422]).toContain(testAfterWipe.status);
    }
  });

  test('T2-04: ROI Report HTML XSS escaping, zero CDN, uniform 404 & strict PublicGeoRoiReportDto sanitization', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 't204xss');
    const tenant = await provisionIsolatedTenant({
      prefix: 't204xss',
      billingMode: 'STRICT',
      initialPoints: 100,
    });
    const token = tenant.session.accessToken;
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));

    const xssPayload = '<script>alert(1)</script>" onclick="x';
    const report = unwrapOk(
      await requestV2<RoiReportRecordWire>(`/brands/${brand.id}/roi-reports`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          title: `XSS Audit <img src=x onerror=alert(2)> ${tag}`,
          periodStart: isoDateDaysAgo(30),
          periodEnd: isoTimestampHoursFromNow(1),
          locale: 'en-US',
          whiteLabelOrg: xssPayload,
        },
      }),
      'POST roi-report with XSS payload',
    );

    // 1. Export HTML must escape all raw script/event payloads & contain zero external CDN URLs
    const exportRes = await requestV2Binary(`/roi-reports/${report.id}/export.html`, { token });
    expect(exportRes.status).toBe(200);
    const html = exportRes.bytes.toString('utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).not.toContain('" onclick="x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html, 'Standalone HTML export must not reference external CDNs').not.toMatch(
      /https?:\/\/(?:cdn\.|unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|cdnjs\.cloudflare\.com)/i,
    );
    expect(
      html,
      'Standalone HTML export must not load external <script src> or <link href>',
    ).not.toMatch(/<(?:script[^>]+src|link[^>]+href)=["']https?:\/\//i);

    // 2. Public share DTO strict sanitization (NO tenantId, userId, shareTokenHash, pointsRoi, points, wallet, credentialsCiphertext)
    const share = unwrapOk(
      await requestV2<RoiReportShareWire>(`/roi-reports/${report.id}/share`, {
        method: 'POST',
        token,
        body: { ttlDays: 7 },
      }),
      'POST share for sanitization test',
    );
    const shareToken = share.sharePath.split('/').pop()!;
    const pubRes = await requestV2<PublicRoiReportWire>(`/public/roi-reports/${shareToken}`);
    expect(pubRes.status).toBe(200);
    const rawJson = pubRes.rawText;
    for (const forbidden of [
      tenant.tenantId,
      tenant.username,
      '"tenantId"',
      '"userId"',
      '"shareTokenHash"',
      '"pointsRoi"',
      '"points"',
      '"wallet"',
      '"credentialsCiphertext"',
    ]) {
      expect(rawJson, `PublicGeoRoiReportDto must never expose ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // 3. Unknown & revoked tokens return uniform 404
    const unknownRes = await requestV2('/public/roi-reports/nonexistent_roi_token_abcdef123456');
    expect(unknownRes.status).toBe(404);

    unwrapOk(
      await requestV2(`/roi-reports/${report.id}/share`, { method: 'DELETE', token }),
      'Revoke share',
    );
    const revokedRes = await requestV2(`/public/roi-reports/${shareToken}`);
    expect(revokedRes.status).toBe(404);
  });

  test('T2-05: Multi-locale leakage boundary (ja-JP 0 false positives vs de-DE/en-US GLOBAL_CJK_LEAK) & CN market locale isolation', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 't205loc');
    const tenant = await provisionIsolatedTenant({
      prefix: 't205loc',
      billingMode: 'STRICT',
      initialPoints: 200,
    });
    const token = tenant.session.accessToken;
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // 1. CN market MUST reject non-CN locale ja-JP
    const cnBadLocale = await requestV2(`/brands/${brand.id}/markets/CN`, {
      method: 'PATCH',
      token,
      body: { supportedLocales: ['zh-CN', 'ja-JP'] },
    });
    expect(cnBadLocale.status, 'CN market must reject ja-JP in supportedLocales').toBe(400);

    // Enable multi-locale on GLOBAL market before seeding locale-specific articles
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: { supportedLocales: ['en-US', 'de-DE', 'ja-JP'] },
      }),
      'PATCH GLOBAL supportedLocales for T2-05',
    );

    // 2. Seed a genuine ja-JP article and verify BOTH clean Japanese AND Simplified Chinese leak
    const jaArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetLocale: 'ja-JP',
        targetPrompt: `静音 4ベイ プライベートクラウド NAS の比較ガイド ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't205-ja-art',
    );
    expect(jaArticle.targetLocale).toBe('ja-JP');

    // 2a. Natural Japanese with Kanji + Hiragana + Katakana MUST pass preflight (0 false positives!)
    const jaCleanPreflight = unwrapOk(
      await requestV2<{
        ok: boolean;
        blockers: Array<{ code: string; message: string }>;
      }>(`/articles/${jaArticle.id}/preflight`, {
        method: 'POST',
        token,
        body: {
          targetLocale: 'ja-JP',
          title: '静音 4ベイ プライベートクラウド NAS の徹底比較ガイド',
          contentMarkdown:
            '## 結論と実測データ\n\n本機は1メートル地点で26dBAの静音設計と15Wの待機電力を実現しています。写真管理や動画編集のチーム共有に最適です。\n\n## よくある質問（FAQ）\n\n**Q: 初期設定は難しいですか？**\nA: 工具不要のドライブベイにより5分で完了します。',
          variantSlug: 'quiet-4-bay-nas-jp-guide',
          variantMetaDesc: '静音4ベイプライベートクラウドNASの実測レビューと導入ガイド。',
        },
      }),
      'Preflight ja-JP clean text',
    );
    expect(
      jaCleanPreflight.blockers.filter((b) => b.code === 'GLOBAL_CJK_LEAK'),
      'Normal Japanese Kanji+Kana must produce 0 GLOBAL_CJK_LEAK false positives',
    ).toEqual([]);
    expect(jaCleanPreflight.ok).toBe(true);

    // 2b. Simplified Chinese leaked into ja-JP MUST be blocked with GLOBAL_CJK_LEAK
    const jaScLeakPreflight = unwrapOk(
      await requestV2<{
        ok: boolean;
        blockers: Array<{ code: string; message: string }>;
      }>(`/articles/${jaArticle.id}/preflight`, {
        method: 'POST',
        token,
        body: {
          targetLocale: 'ja-JP',
          title: '静音 4ベイ プライベートクラウド NAS の徹底比較ガイド',
          contentMarkdown:
            '## 結論と実測データ\n\n本機は1メートル地点で26dBAの静音設計を実現しています。这里混入了一段未经翻译的简体中文评测说明，请确认优势与细节。',
          variantSlug: 'quiet-4-bay-nas-jp-leak',
          variantMetaDesc: '静音4ベイプライベートクラウドNASの実測レビューと導入ガイド。',
        },
      }),
      'Preflight ja-JP with Simplified Chinese leak',
    );
    expect(jaScLeakPreflight.ok).toBe(false);
    expect(
      jaScLeakPreflight.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK'),
      'Simplified Chinese leaked into ja-JP must trigger GLOBAL_CJK_LEAK',
    ).toBe(true);

    // 3. Seed matched Latin articles (de-DE and en-US) and verify CJK leakage is blocked
    const deArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetLocale: 'de-DE',
        targetPrompt: `Leises 4-Bay NAS Vergleich für Studios ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't205-de-art',
    );
    const deLeakPreflight = unwrapOk(
      await requestV2<{
        ok: boolean;
        blockers: Array<{ code: string; message: string }>;
      }>(`/articles/${deArticle.id}/preflight`, {
        method: 'POST',
        token,
        body: {
          targetLocale: 'de-DE',
          title: 'Leises 4-Bay NAS im Praxistest',
          contentMarkdown:
            '## Zusammenfassung\n\nDieses 4-Bay NAS arbeitet mit 26 dBA sehr leise. 这里混入了一段未翻译的中文评测说明。',
          variantSlug: 'leises-4-bay-nas-test',
          variantMetaDesc: 'Technischer Testbericht für leise 4-Bay NAS Systeme.',
        },
      }),
      'Preflight de-DE with Chinese leak',
    );
    expect(deLeakPreflight.ok).toBe(false);
    expect(deLeakPreflight.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(true);

    const enArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetLocale: 'en-US',
        targetPrompt: `Quiet 4-bay private cloud NAS ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't205-en-art',
    );
    const enLeakPreflight = unwrapOk(
      await requestV2<{
        ok: boolean;
        blockers: Array<{ code: string; message: string }>;
      }>(`/articles/${enArticle.id}/preflight`, {
        method: 'POST',
        token,
        body: {
          targetLocale: 'en-US',
          title: 'Quiet 4-Bay Private Cloud NAS Review',
          contentMarkdown:
            '## Benchmark Summary\n\nSustained acoustic noise measures 26 dBA at 1m. 请确认这里的中文文案已被替换。',
          variantSlug: 'quiet-4-bay-nas-review',
          variantMetaDesc: 'Verified lab measurements for quiet 4-bay private cloud NAS.',
        },
      }),
      'Preflight en-US with Chinese leak',
    );
    expect(enLeakPreflight.ok).toBe(false);
    expect(enLeakPreflight.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(true);
  });

  test('T2-06: Control prompts validation (>5 & seed overlap rejected) + STRICT 0-pt SKIPPED_INSUFFICIENT_POINTS (zero negative wallet)', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 't206ctrl');

    // Start with enough points to seed brand + article, then drain to 0 under STRICT before retest sweep
    const tenant = await provisionIsolatedTenant({
      prefix: 't206ctrl',
      billingMode: 'STRICT',
      initialPoints: 50,
    });
    const token = tenant.session.accessToken;
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const globalMarket = brand.markets.find((m) => m.market === 'GLOBAL');
    const existingSeed = globalMarket?.seedPrompts?.[0] || `Best NAS for studios ${tag}`;
    if (!globalMarket?.seedPrompts?.length) {
      unwrapOk(
        await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
          method: 'PATCH',
          token,
          body: { seedPrompts: [existingSeed] },
        }),
        'Seed seedPrompts',
      );
    }

    // 1. Reject > 5 controlPrompts
    const overLimitRes = await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: {
        controlPrompts: [
          'Control prompt 1',
          'Control prompt 2',
          'Control prompt 3',
          'Control prompt 4',
          'Control prompt 5',
          'Control prompt 6',
        ],
      },
    });
    expect(overLimitRes.status, '>5 controlPrompts must be rejected with 400').toBe(400);

    // 2. Reject overlap with seedPrompts
    const overlapRes = await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
      method: 'PATCH',
      token,
      body: {
        controlPrompts: [existingSeed, 'Unrelated benchmark query for audio interface'],
      },
    });
    expect(overlapRes.status, 'controlPrompts overlapping seedPrompts must return 400').toBe(400);

    // Save valid controlPrompts
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: {
          controlPrompts: [
            `Unrelated studio monitor stand review ${tag}`,
            `Unrelated mechanical switch comparison ${tag}`,
          ],
        },
      }),
      'Save valid controlPrompts',
    );

    // 3. Seed article + backdated due retest schedule with includeControlPrompts=true
    const article = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Low balance DiD skip test ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't206-art',
    );
    const pubRecord = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${article.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-lowbal`,
          channel: 'Official Blog',
          publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          autoRetest: { enabled: false },
        },
      }),
      'Create backdated publish record (autoRetest disabled until wallet drained)',
    );

    // Drain tenant wallet strictly to 0 points under STRICT mode BEFORE enabling schedule
    const currentPts = await getWalletPoints(tenant.session);
    if (currentPts > 0) {
      await adjustTenantPoints(tenant.tenantId, -currentPts, 'drain to 0 for T2-06 STRICT guard');
    }
    await setTenantBillingMode(tenant.tenantId, 'STRICT');
    expect(await getWalletPoints(tenant.session)).toBe(0);

    // Enable T+7 schedule with includeControlPrompts right before triggering sweep
    unwrapOk(
      await requestV2(`/publish-records/${pubRecord.id}/retest-schedules`, {
        method: 'PATCH',
        token,
        body: { enabled: true, includeControlPrompts: true, sampleCount: 1, milestones: [7] },
      }),
      'Enable includeControlPrompts after draining wallet',
    );

    // Trigger retest-schedule-sweep -> must transition cleanly to SKIPPED_INSUFFICIENT_POINTS & wallet >= 0
    await triggerMaintenance('retest-schedule-sweep');
    const skipped = await waitForDueRetestScheduleDone(
      token,
      article.id,
      pubRecord.id,
      7,
      ['SKIPPED_INSUFFICIENT_POINTS'],
      45_000,
    );
    expect(skipped.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
    expect(skipped.skipReason).toBeTruthy();

    const walletAfter = await getTenantWallet(tenant.session);
    expect(walletAfter.points, 'Wallet points must never go negative').toBeGreaterThanOrEqual(0);
    expect(walletAfter.available, 'Wallet available must never go negative').toBeGreaterThanOrEqual(
      0,
    );
  });

  test('T2-07: Extension gmext_ token revocation, cross-route privilege boundary, cross-tenant IDOR & idempotent confirm-published', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const tag = uniqueTag(testInfo, 't207extsec');

    const tenantA = await provisionIsolatedTenant({
      prefix: 't207a',
      billingMode: 'STRICT',
      initialPoints: 120,
    });
    const tenantB = await provisionIsolatedTenant({
      prefix: 't207b',
      billingMode: 'STRICT',
      initialPoints: 120,
    });

    const brandA = await createBrandApi(tenantA.session, buildCnBrandPayload(`${tag}a`));
    await upsertBrandFactsApi(tenantA.session, brandA.id, buildFourBrandFacts(brandA.name), true);
    const artA = await seedArticleViaSse(
      tenantA.session.accessToken,
      brandA.id,
      {
        market: 'CN',
        targetPrompt: `扩展权限边界隔离测试 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't207-arta',
    );
    const [taskA] = await createVariantTasksSync(
      tenantA.session.accessToken,
      artA.id,
      [{ provider: 'ZHIHU_EXT', channelLabel: '知乎隔离验证' }],
      't207-vara',
    );

    const tokenA = unwrapOk(
      await requestV2<CreateExtensionTokenWire>('/extension/tokens', {
        method: 'POST',
        token: tenantA.session.accessToken,
        body: { label: 'Tenant A Chrome' },
      }),
      'Create ext token A',
    );
    const tokenB = unwrapOk(
      await requestV2<CreateExtensionTokenWire>('/extension/tokens', {
        method: 'POST',
        token: tenantB.session.accessToken,
        body: { label: 'Tenant B Chrome' },
      }),
      'Create ext token B',
    );

    // 1. Valid gmext_ token MUST be rejected across ALL non-extension routes (least privilege)
    const crossRouteChecks = [
      await requestV2('/brands', { token: tokenA.plainToken }),
      await requestV1('/billing/wallet', { token: tokenA.plainToken }),
      await requestV1('/admin/tenants', { token: tokenA.plainToken }),
      await requestV2(`/brands/${brandA.id}/connections`, { token: tokenA.plainToken }),
      await requestV2('/extension/tokens', { token: tokenA.plainToken }),
    ];
    for (const res of crossRouteChecks) {
      expect([401, 403, 404]).toContain(res.status);
    }

    const deleteBrandRes = await requestV2(`/brands/${brandA.id}`, {
      method: 'DELETE',
      token: tokenA.plainToken,
    });
    expect([401, 403], 'gmext_ token must never be allowed to DELETE /api/v2/brands/:id').toContain(
      deleteBrandRes.status,
    );

    // Negative CORS check: untrusted Origin must not be echoed or wildcarded
    const evilOrigin = 'https://evil.example';
    const evilCorsRes = await requestV2('/extension/me', {
      token: tokenA.plainToken,
      headers: { Origin: evilOrigin },
    });
    const evilAcao = evilCorsRes.headers.get('access-control-allow-origin');
    expect(
      evilAcao,
      'Untrusted Origin https://evil.example must not be reflected in Access-Control-Allow-Origin',
    ).not.toBe(evilOrigin);
    expect(
      evilAcao,
      'Extension bridge must never emit wildcard Access-Control-Allow-Origin: *',
    ).not.toBe('*');

    // 2. Cross-tenant taskId on confirm-published MUST return 404
    const idorRes = await requestV2(`/extension/tasks/${taskA!.id}/confirm-published`, {
      method: 'POST',
      token: tokenB.plainToken,
      body: { publishedUrl: `https://crawl-ok.e2e.example/zhihu/${tag}-idor` },
    });
    expect(idorRes.status, 'Cross-tenant confirm-published must return 404').toBe(404);

    // 3. Duplicate confirm-published with same URL is strictly idempotent (no duplicate schedules)
    const pubUrl = `https://crawl-ok.e2e.example/zhihu/${tag}-idem`;
    const firstConfirm = unwrapOk(
      await requestV2<ExtensionConfirmWire>(`/extension/tasks/${taskA!.id}/confirm-published`, {
        method: 'POST',
        token: tokenA.plainToken,
        body: { publishedUrl: pubUrl },
      }),
      'First confirm-published',
    );
    expect(firstConfirm.alreadyRecorded).toBe(false);

    const secondConfirm = unwrapOk(
      await requestV2<ExtensionConfirmWire>(`/extension/tasks/${taskA!.id}/confirm-published`, {
        method: 'POST',
        token: tokenA.plainToken,
        body: { publishedUrl: pubUrl },
      }),
      'Second idempotent confirm-published',
    );
    expect(secondConfirm.alreadyRecorded).toBe(true);
    expect(secondConfirm.publishRecordId).toBe(firstConfirm.publishRecordId);

    const pubRecs = unwrapOk(
      await requestV2<{ items: PublishRecordWire[] }>(`/articles/${artA.id}/publish-records`, {
        token: tenantA.session.accessToken,
      }),
      'Verify no duplicate publish records',
    ).items;
    const matchingRecs = pubRecs.filter((r) => r.publishedUrl === pubUrl);
    expect(matchingRecs.length).toBe(1);
    expect((matchingRecs[0]!.retestSchedules || []).length).toBe(3);

    // 4. Revoked token MUST immediately return 401 on /extension/me
    unwrapOk(
      await requestV2(`/extension/tokens/${tokenA.token.id}`, {
        method: 'DELETE',
        token: tenantA.session.accessToken,
      }),
      'Revoke tokenA',
    );
    const revokedMe = await requestV2('/extension/me', { token: tokenA.plainToken });
    expect(revokedMe.status).toBe(401);
  });
});

// ============================================================================
// Tier 3 — Cross-Feature Pairwise Workflows
// ============================================================================

test.describe('Tier 3 — GeoMix v2.2 Cross-Feature Pairwise Workflows', () => {
  test('T3-01: Full Global Provable-ROI Loop (Visibility -> Near-Miss -> NEAR_MISS_BOOST -> ja-JP Studio -> Ghost/Dev.to L1 -> DiD Retest -> Monthly ROI Report)', async ({}, testInfo) => {
    test.setTimeout(180_000);
    await clearFixtureCaptures();

    const tag = uniqueTag(testInfo, 't301loop');
    const tenant = await provisionIsolatedTenant({
      prefix: 't301loop',
      billingMode: 'STRICT',
      initialPoints: 300,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // Configure multi-locale + controlPrompts
    const controlPrompts = [
      `Best 10GbE network switch for home lab ${tag}`,
      `Quiet UPS battery backup for workstation ${tag}`,
    ];
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: {
          supportedLocales: ['en-US', 'de-DE', 'ja-JP'],
          controlPrompts,
        },
      }),
      'Configure GLOBAL locales & controlPrompts',
    );

    // Step 1: Visibility baseline run
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 2);
    const treatmentPrompt = `Best quiet 4-bay private cloud NAS ${tag}`;
    const baseRun = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [treatmentPrompt, ...controlPrompts],
      },
      uniqueIdemKey('t301-base'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, baseRun.id, 45_000);

    // Step 2: Near-Miss -> NEAR_MISS_BOOST brief
    const nm = unwrapOk(
      await requestV2<NearMissListWire>(
        `/brands/${brand.id}/visibility/near-miss?market=GLOBAL&days=30`,
        { token },
      ),
      'GET Near-Miss for pairwise loop',
    );
    expect(nm.total).toBeGreaterThan(0);

    const boostBrief = unwrapOk(
      await requestV2<{ id: string; sourceType: string }>(
        `/brands/${brand.id}/briefs/from-near-miss`,
        {
          method: 'POST',
          token,
          body: {
            market: 'GLOBAL',
            tier: nm.items[0]!.tier,
            targetPrompt: treatmentPrompt,
            sourceUrl: 'https://near-miss.e2e.example/articles/nas-gap',
          },
        },
      ),
      'Create NEAR_MISS_BOOST brief',
    );
    expect(boostBrief.sourceType).toBe('NEAR_MISS_BOOST');

    // Step 3: Stream ja-JP article from the boost brief
    const jaArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        briefId: boostBrief.id,
        targetLocale: 'ja-JP',
        targetPrompt: treatmentPrompt,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't301-ja-art',
    );
    expect(jaArticle.targetLocale).toBe('ja-JP');

    // Step 4: Connect Ghost + Dev.to & publish via async GeoVariantJob + L1 publish
    const ghostConn = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          provider: 'GHOST',
          displayName: 'Loop Ghost JP',
          siteBaseUrl: 'https://ghost.e2e.example',
          targetLocale: 'ja-JP',
          credentials: { adminApiKey: E2E_GHOST_ADMIN_API_KEY },
          configJson: { inlineJsonLd: true },
        },
      }),
      'Create Ghost JP connection',
    );
    const devtoConn = unwrapOk(
      await requestV2<ChannelConnectionWire>(`/brands/${brand.id}/connections`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          provider: 'DEVTO',
          displayName: 'Loop Dev.to',
          siteBaseUrl: 'https://dev.to',
          credentials: { apiKey: 'devto_loop_key_4411' },
        },
      }),
      'Create Dev.to connection',
    );

    const varJob = unwrapOk(
      await requestV2<VariantJobWire>(`/articles/${jaArticle.id}/distributions/variant-jobs`, {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': uniqueIdemKey('t301-varjob') },
        body: {
          targets: [
            {
              provider: 'GHOST',
              connectionId: ghostConn.id,
              channelLabel: 'Loop Ghost JP',
              targetLocale: 'ja-JP',
            },
            {
              provider: 'DEVTO',
              connectionId: devtoConn.id,
              channelLabel: 'Loop Dev.to',
              targetLocale: 'ja-JP',
              templateKey: 'DEVELOPER_TECH_POST',
            },
          ],
        },
      }),
      'Create async variant job',
    );
    const doneVarJob = await pollVariantJobDone(token, jaArticle.id, varJob.id, 45_000);
    expect(doneVarJob.status).toBe('COMPLETED');

    for (const taskId of doneVarJob.taskIds) {
      unwrapOk(
        await requestV2(`/distributions/${taskId}/publish`, {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': uniqueIdemKey(`t301-pub-${taskId}`) },
          body: { publishAsDraft: false, acknowledgePreflightWarnings: true },
        }),
        `Publish task ${taskId}`,
      );
      const doneTask = await pollDistributionTaskDone(token, jaArticle.id, taskId, 35_000);
      expect(doneTask.status).toBe('PUBLISHED');
    }

    // Step 5: Backdated publish record with DiD retest sweep
    const didPub = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${jaArticle.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-loop`,
          channel: 'Ghost Blog',
          publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          autoRetest: { enabled: false },
        },
      }),
      'Create backdated publish record for DiD',
    );
    unwrapOk(
      await requestV2(`/publish-records/${didPub.id}/retest-schedules`, {
        method: 'PATCH',
        token,
        body: { enabled: true, includeControlPrompts: true, sampleCount: 1, milestones: [7] },
      }),
      'Enable DiD retest',
    );
    await triggerMaintenance('retest-schedule-sweep');
    const doneT7 = await waitForDueRetestScheduleDone(
      token,
      jaArticle.id,
      didPub.id,
      7,
      ['COMPLETED'],
      60_000,
    );
    expect(doneT7.controlMetricsJson?.did).toBeTruthy();

    // Step 6: Generate Monthly ROI Report & verify end-to-end aggregation
    const report = unwrapOk(
      await requestV2<RoiReportRecordWire>(`/brands/${brand.id}/roi-reports`, {
        method: 'POST',
        token,
        body: {
          market: 'GLOBAL',
          title: `Full Loop ROI Report ${tag}`,
          periodStart: isoDateDaysAgo(30),
          periodEnd: isoTimestampHoursFromNow(1),
          locale: 'en-US',
        },
      }),
      'Generate full-loop ROI report',
    );
    expect(report.summary.overview.totalObservations).toBeGreaterThan(0);
    assertValidWilson(report.summary.overview.mentionWilson, 'Full loop ROI mentionWilson');
    expect(report.summary.nearMiss.boostBriefsCreated).toBeGreaterThanOrEqual(1);
    expect(report.summary.funnel.publishedTotal).toBeGreaterThanOrEqual(3);
    expect(report.summary.funnel.l1Count).toBeGreaterThanOrEqual(2);
    expect(report.summary.milestoneTrend.length).toBeGreaterThanOrEqual(1);
  });

  test('T3-02: Full CN L2 Extension Closed Loop (ZHIHU_EXT -> Bridge confirm-published -> CrawlProbe & Retest -> /home?market=CN)', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 't302cnl2');
    const tenant = await provisionIsolatedTenant({
      prefix: 't302cnl2',
      billingMode: 'STRICT',
      initialPoints: 180,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildCnBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `静音四盘位家用私有云 NAS 知乎闭环验证 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't302-cn-art',
    );

    const [zhihuTask] = await createVariantTasksSync(
      token,
      cnArticle.id,
      [{ provider: 'ZHIHU_EXT', channelLabel: '知乎（扩展闭环）' }],
      't302-zhihu-var',
    );

    const extToken = unwrapOk(
      await requestV2<CreateExtensionTokenWire>('/extension/tokens', {
        method: 'POST',
        token,
        body: { label: 'CN Closed-Loop Chrome' },
      }),
      'Issue CN ext token',
    ).plainToken;

    // Extension pulls pending task
    const pending = unwrapOk(
      await requestV2<{ items: ExtensionPendingTaskWire[] }>(
        `/extension/tasks?brandId=${brand.id}&provider=ZHIHU_EXT`,
        { token: extToken, headers: { Origin: E2E_EXTENSION_ORIGIN } },
      ),
      'Extension GET /tasks',
    ).items;
    expect(pending.some((t) => t.taskId === zhihuTask!.id)).toBe(true);

    // Extension confirms published URL
    const zhihuUrl = `https://crawl-ok.e2e.example/zhihu/${tag}-post`;
    const confirmed = unwrapOk(
      await requestV2<ExtensionConfirmWire>(`/extension/tasks/${zhihuTask!.id}/confirm-published`, {
        method: 'POST',
        token: extToken,
        headers: { Origin: E2E_EXTENSION_ORIGIN },
        body: { publishedUrl: zhihuUrl },
      }),
      'Extension confirm-published',
    );
    expect(confirmed.publishRecordId).toBeTruthy();

    // Run T+1 crawl probe on the recorded URL
    const probeRes = await requestV2<{ crawlStatus: string }>(
      `/publish-records/${confirmed.publishRecordId}/crawl-probe`,
      { method: 'POST', token, body: {} },
    );
    expect(unwrapOk(probeRes, 'POST crawl-probe').crawlStatus).toBe('OK');

    // Verify reflected in GET /api/v2/brands/:brandId/home?market=CN
    const homeRes = await requestV2<{
      distributionSummary?: {
        upcomingRetests?: Array<{ publishRecordId: string }>;
        channelAttribution?: Array<{ channel: string; publishedCount: number }>;
      };
    }>(`/brands/${brand.id}/home?market=CN&days=30`, { token });
    const homeData = unwrapOk(homeRes, 'GET /home?market=CN');
    expect(homeData.distributionSummary).toBeTruthy();
    const hasUpcoming = (homeData.distributionSummary?.upcomingRetests || []).some(
      (u) => u.publishRecordId === confirmed.publishRecordId,
    );
    const hasAttr = (homeData.distributionSummary?.channelAttribution || []).some(
      (a) => a.publishedCount >= 1,
    );
    expect(hasUpcoming || hasAttr, '/home?market=CN must reflect L2 extension publish record').toBe(
      true,
    );
  });
});

// ============================================================================
// Tier 4 — Real-World End-to-End Browser Journeys & Ergonomics (1440x900 & 1015x909)
// ============================================================================

test.describe('Tier 4 — GeoMix v2.2 Real-World End-to-End User Journeys & Ergonomics', () => {
  test('T4-01: /visibility Near-Miss panel (Citations tab) -> filter & boost brief -> /studio opens NEAR_MISS_BOOST brief', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 't401vis');
    const tenant = await provisionIsolatedTenant({
      prefix: 't401vis',
      billingMode: 'STRICT',
      initialPoints: 150,
    });

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 2);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      {
        market: 'GLOBAL',
        engines,
        prompts: [
          `Best quiet 4-bay private cloud NAS ${tag}`,
          `Compare ${brand.name} studio storage [E2E_COMP_DOMAIN]`,
        ],
      },
      uniqueIdemKey('t401-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: V2_2_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const errorCollector = attachErrorCollector(page);

    try {
      await page.goto(`/visibility?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await assertFourItemSidebar(page);

      // Y28: Locate Near-Miss panel under Overview tab (collapsed by default) and expand it
      const nearMissHeading = page.getByText(/候补机会|差一步被引用|Near-Miss/i).first();
      await expect(nearMissHeading).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('near-miss-collapse-toggle').click();

      // Assert at least one Tier badge renders
      await expect(
        page
          .getByText(
            /Tier 1|Tier 2|Tier 3A|Tier 3B|点开未引|召回未引|可抓未引|可抓取未进引文|提及未引/,
          )
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      const boostBtn = page
        .getByRole('button', { name: /补强|一键生成补强意见卡|生成补强意见卡/ })
        .first();
      await expect(boostBtn).toBeVisible({ timeout: 15_000 });

      // Scope strictly to the Near-Miss panel (excluding top CitationTrace source pills)
      // Use page-rooted matchers inside .filter({ has }) and anchor on stable heading + filter control
      // (never on transient boostBtn, which unmounts during async filter reload or empty filtered state)
      const filterItemSelector =
        'button, [role="radio"], [role="tab"], .ant-segmented-item, .ant-radio-button-wrapper';
      const ownedItemMatcher = page.locator(filterItemSelector).filter({ hasText: /自有/ });
      const thirdPartyItemMatcher = page
        .locator(filterItemSelector)
        .filter({ hasText: /第三方|外部/ });

      const nearMissPanel = page
        .locator('[data-testid="visibility-near-miss-panel"], .gm-panel, .ant-card, section')
        .filter({ has: nearMissHeading })
        .filter({ has: ownedItemMatcher })
        .last();
      await expect(nearMissPanel).toBeVisible({ timeout: 15_000 });

      const sourceFilterGroup = nearMissPanel
        .locator('[role="group"], [role="radiogroup"], .ant-segmented-group, .ant-radio-group, div')
        .filter({ has: ownedItemMatcher })
        .filter({ has: thirdPartyItemMatcher })
        .last();
      const ownedFilter = sourceFilterGroup
        .locator(filterItemSelector)
        .filter({ hasText: /自有/ })
        .first();
      const thirdPartyFilter = sourceFilterGroup
        .locator(filterItemSelector)
        .filter({ hasText: /第三方|外部/ })
        .first();
      const allSourceFilter = sourceFilterGroup
        .locator(filterItemSelector)
        .filter({ hasText: /全部/ })
        .first();
      await expect(ownedFilter).toBeVisible({ timeout: 10_000 });
      await expect(thirdPartyFilter).toBeVisible({ timeout: 10_000 });
      await expect(allSourceFilter).toBeVisible({ timeout: 10_000 });

      await ownedFilter.click();
      await expect(nearMissPanel).toBeVisible();
      await thirdPartyFilter.click();
      await expect(nearMissPanel).toBeVisible();
      await allSourceFilter.click();
      await expect(boostBtn).toBeVisible({ timeout: 15_000 });

      // Verify ergonomics at 1440x900 & 1015x909
      await assertLayoutErgonomics(page);

      // Click one-click boost brief CTA -> verify navigation into /studio with briefId
      await boostBtn.click();

      await expect(page).toHaveURL(/\/studio\?.*briefId=/, { timeout: 25_000 });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await assertFourItemSidebar(page);
      await assertLayoutErgonomics(page);
      assertNoConsoleOrPageErrors(errorCollector);
    } finally {
      await context.close();
    }
  });

  test('T4-02: /home Wilson CI/DiD & ROI Report modal -> incognito /share/report/[token] pure EN & CN + white-label + revoke 404', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 't402home');
    const tenant = await provisionIsolatedTenant({
      prefix: 't402home',
      billingMode: 'STRICT',
      initialPoints: 250,
    });
    const token = tenant.session.accessToken;

    const dualPayload = buildDualMarketBrandPayload(tag);
    const dualMarkets = (dualPayload.markets as Array<Record<string, unknown>>).map((m) =>
      m.market === 'GLOBAL' ? { ...m, localCategory: 'Private Cloud NAS' } : m,
    );
    const brand = await createBrandApi(tenant.session, {
      ...dualPayload,
      markets: dualMarkets,
    });
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // Configure English control prompts & seed baseline + completed DiD retest on GLOBAL
    // so /home HomeDistributionSummary renders live Wilson 95% CI & DiD indicators (zero CN metadata)
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: {
          controlPrompts: [`Control NAS storage alpha ${tag}`, `Control NAS storage beta ${tag}`],
        },
      }),
      'Configure GLOBAL control prompts for T4-02',
    );
    const engines = await pickOnlineEngines(tenant.session, brand.id, 'GLOBAL', 2);
    const run = await createVisibilityRunApi(
      tenant.session,
      brand.id,
      { market: 'GLOBAL', engines, prompts: [`Best quiet 4-bay NAS ${tag}`] },
      uniqueIdemKey('t402-run'),
    );
    await waitForVisibilityRunApi(tenant.session, brand.id, run.id, 45_000);

    const enArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetPrompt: `Best quiet 4-bay NAS ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't402-en-art',
    );
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const enPub = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${enArticle.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-roi-home`,
          channel: 'Official Blog',
          publishedAt: tenDaysAgo,
          autoRetest: { enabled: false },
        },
      }),
      'Seed GLOBAL publish record for /home Wilson CI & DiD',
    );
    unwrapOk(
      await requestV2(`/publish-records/${enPub.id}/retest-schedules`, {
        method: 'PATCH',
        token,
        body: { enabled: true, milestones: [7], sampleCount: 1, includeControlPrompts: true },
      }),
      'Enable GLOBAL DiD retest schedule for T4-02',
    );
    await triggerMaintenance('retest-schedule-sweep');
    await waitForDueRetestScheduleDone(token, enArticle.id, enPub.id, 7, ['COMPLETED'], 45_000);

    // Pre-create a CN shared report too so we verify both EN & CN purity in incognito
    const cnReport = unwrapOk(
      await requestV2<RoiReportRecordWire>(`/brands/${brand.id}/roi-reports`, {
        method: 'POST',
        token,
        body: {
          market: 'CN',
          title: `青松存储月度 GEO ROI 报告 ${tag}`,
          periodStart: isoDateDaysAgo(30),
          periodEnd: isoTimestampHoursFromNow(1),
          locale: 'zh-CN',
        },
      }),
      'Seed CN ROI report',
    );
    const cnShare = unwrapOk(
      await requestV2<RoiReportShareWire>(`/roi-reports/${cnReport.id}/share`, {
        method: 'POST',
        token,
        body: { ttlDays: 30 },
      }),
      'Share CN ROI report',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: V2_2_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const errorCollector = attachErrorCollector(page);

    try {
      await page.goto(`/home?brandId=${brand.id}&market=GLOBAL`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('home-workspace')).toBeVisible({ timeout: 20_000 });
      await assertFourItemSidebar(page);

      // Verify Wilson 95% CI / DiD attribution summary text renders on /home before opening ROI modal
      await expect(page.getByText(/Wilson|置信|DiD|双重差分|样本较少|净增|±/i).first()).toBeVisible(
        { timeout: 15_000 },
      );
      await assertLayoutErgonomics(page);

      // Open Monthly GEO ROI Report modal from /home
      const openRoiBtn = page
        .getByRole('button', { name: /生成月度 GEO ROI 报告|月度.*ROI.*报告/ })
        .first();
      await expect(openRoiBtn).toBeVisible({ timeout: 15_000 });
      await openRoiBtn.click();

      const modal = page.locator('.ant-modal-content:visible').last();
      await expect(modal).toBeVisible({ timeout: 10_000 });

      // [AUDITOR VETO #1 FIX] Unconditionally locate and fill whiteLabelOrg input
      const whiteLabelInput = modal
        .getByLabel(/白标|机构|whiteLabel/i)
        .or(
          modal.locator(
            'input[placeholder*="白标"], input[placeholder*="机构"], input[id*="whiteLabel"], input[name*="whiteLabel"], input[data-testid*="white-label"], [data-testid*="white-label"] input',
          ),
        )
        .first();
      await expect(whiteLabelInput).toBeVisible({ timeout: 10_000 });
      await whiteLabelInput.fill('Apex GEO Advisory');

      // If the modal also exposes an editable report title input, fill an English title so
      // console-default Chinese title text cannot pollute the pure-EN public report check.
      // (Downstream zero-CJK & white-label assertions remain 100% unconditional.)
      const titleInput = modal
        .getByLabel(/报告标题|标题|title/i)
        .or(
          modal.locator(
            'input[placeholder*="标题"], input[id*="title"], input[name="title"], input[data-testid*="report-title"], [data-testid*="report-title"] input',
          ),
        )
        .first();
      if ((await titleInput.count()) > 0) {
        await expect(titleInput).toBeVisible({ timeout: 5_000 });
        await titleInput.fill(`Executive GEO ROI Report ${tag}`);
      }

      const genBtn = modal.getByRole('button', { name: /生成报告|生成月度|立即生成/ }).first();
      await expect(genBtn).toBeVisible({ timeout: 10_000 });
      await genBtn.click();

      // Wait for report to be created via API and unconditionally assert whiteLabelOrg persisted
      const reports = await pollUntil(
        async () =>
          unwrapOk(
            await requestV2<{ items: RoiReportRecordWire[] }>(
              `/brands/${brand.id}/roi-reports?market=GLOBAL`,
              { token },
            ),
            'Poll GLOBAL ROI reports',
          ).items,
        (items) => items.length > 0,
        { timeoutMs: 20_000, intervalMs: 400, label: 'GLOBAL ROI report created from modal' },
      );
      const enReport = reports[0]!;
      expect(enReport.whiteLabelOrg).toBe('Apex GEO Advisory');
      expect(
        /[\u4e00-\u9fff]/.test(enReport.title),
        `GLOBAL EN ROI report title must not contain Chinese: ${enReport.title}`,
      ).toBe(false);

      // Click share button inside modal (or issue share via modal button)
      const shareBtn = modal.getByRole('button', { name: /分享链接|生成分享|免登录分享/ }).first();
      await expect(shareBtn).toBeVisible({ timeout: 15_000 });
      await shareBtn.click();

      // Verify share link becomes active
      await pollUntil(
        async () =>
          unwrapOk(
            await requestV2<RoiReportRecordWire>(`/roi-reports/${enReport.id}`, { token }),
            'Poll EN report shareActive',
          ),
        (r) => r.shareActive === true,
        { timeoutMs: 15_000, intervalMs: 350, label: 'EN ROI report shareActive' },
      );

      // Capture exact EN share URL from modal text, <input>/<textarea> values, or <a href>
      const shareUrlRe = new RegExp(`^${escapeRegExp(WEB_BASE)}/share/report/[A-Za-z0-9_-]+$`);
      let capturedShareUrl = '';
      await expect
        .poll(
          async () => {
            const visibleModals = page.locator('.ant-modal-content:visible');
            if ((await visibleModals.count()) === 0) return '';
            const text = await readTextIncludingInputs(visibleModals.last());
            const abs = text.match(/https?:\/\/[^\s"'<>]+\/share\/report\/[A-Za-z0-9_-]+/);
            if (abs) {
              capturedShareUrl = abs[0];
              return abs[0];
            }
            const rel = text.match(/\/share\/report\/[A-Za-z0-9_-]+/);
            if (rel) {
              capturedShareUrl = `${WEB_BASE}${rel[0]}`;
              return capturedShareUrl;
            }
            return '';
          },
          { timeout: 15_000, message: 'Share URL must be displayed in ROI modal' },
        )
        .toMatch(shareUrlRe);
      const shareUrlMatch = capturedShareUrl;

      // Verify BOTH EN and CN public pages in a fresh unauthenticated incognito context
      const incognitoCtx = await browser.newContext({ viewport: V2_2_VIEWPORTS[0] });
      const incPage = await incognitoCtx.newPage();
      const incErrors = attachErrorCollector(incPage);
      const forbiddenApiHits: string[] = [];
      const authErrorHits: string[] = [];
      const serverErrorHits: string[] = [];

      incPage.on('request', (req) => {
        const u = req.url();
        if (
          /\/api\/v1\/(account|billing|announcements|auth\/refresh)/.test(u) ||
          /\/api\/v2\/brands/.test(u)
        ) {
          forbiddenApiHits.push(`${req.method()} ${u}`);
        }
      });
      incPage.on('response', (res) => {
        const st = res.status();
        if (st === 401 || st === 403) authErrorHits.push(`${st} ${res.url()}`);
        if (st >= 500) serverErrorHits.push(`${st} ${res.url()}`);
      });

      try {
        // 1. Pure EN public report
        await incPage.goto(shareUrlMatch, { waitUntil: 'domcontentloaded' });
        await expect(incPage.getByRole('button', { name: /Print|PDF/i }).first()).toBeVisible({
          timeout: 20_000,
        });
        expect(incPage.url()).toContain('/share/report/');
        expect(incPage.url()).not.toContain('/login');
        await expect(incPage.getByTestId('global-brand-switcher')).toHaveCount(0);

        const enBodyText = await incPage.locator('body').innerText();
        assertNoMixedLanguageChrome(enBodyText, 'en');
        expect(enBodyText).toContain('Apex GEO Advisory');
        expect(enBodyText).not.toContain(tenant.tenantId);
        expect(forbiddenApiHits).toEqual([]);
        expect(authErrorHits).toEqual([]);
        expect(serverErrorHits).toEqual([]);
        await assertLayoutErgonomics(incPage);

        // 2. Pure CN public report
        const cnPublicUrl = `${WEB_BASE}${cnShare.sharePath}`;
        await incPage.goto(cnPublicUrl, { waitUntil: 'domcontentloaded' });
        await expect(incPage.getByRole('button', { name: /打印|PDF/ }).first()).toBeVisible({
          timeout: 20_000,
        });
        const cnBodyText = await incPage.locator('body').innerText();
        assertNoMixedLanguageChrome(cnBodyText, 'zh');
        expect(cnBodyText).not.toContain(tenant.tenantId);
        await assertLayoutErgonomics(incPage);
        assertNoConsoleOrPageErrors(incErrors);

        // 3. Revoke EN share -> reload incognito -> friendly 404 (no /login redirect, no stack trace)
        unwrapOk(
          await requestV2(`/roi-reports/${enReport.id}/share`, { method: 'DELETE', token }),
          'Revoke EN share before incognito reload',
        );
        await incPage.goto(shareUrlMatch, { waitUntil: 'domcontentloaded' });
        await expect(
          incPage.getByText(/unavailable|expired|revoked|404|不可用|已失效|已撤销/i).first(),
        ).toBeVisible({ timeout: 15_000 });
        expect(incPage.url()).not.toContain('/login');
        const notFoundText = await incPage.locator('body').innerText();
        expect(notFoundText).not.toContain('Error:');
        expect(notFoundText).not.toContain('stack');
      } finally {
        await incognitoCtx.close();
      }

      assertNoConsoleOrPageErrors(errorCollector);
    } finally {
      await context.close();
    }
  });

  test('T4-03: /brands & /account upgrades (supportedLocales, controlPrompts, Ghost/WeChat/Shopify OAuth UI, gmext_ token one-time modal & revoke)', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(150_000);
    const tag = uniqueTag(testInfo, 't403br');
    const tenant = await provisionIsolatedTenant({
      prefix: 't403br',
      billingMode: 'STRICT',
      initialPoints: 150,
    });
    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: V2_2_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const errorCollector = attachErrorCollector(page);

    try {
      // 1. GLOBAL /brands: inspect multi-locale, controlPrompts, Ghost & Shopify OAuth/Custom dual-tab forms
      await page.goto(`/brands?brandId=${brand.id}&market=GLOBAL`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('brand-channel-connections')).toBeVisible({ timeout: 20_000 });
      await assertFourItemSidebar(page);

      // Multi-locale & Control prompts sections visible on GLOBAL market
      await expect(page.getByText(/启用多语种|多语种/).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/对照组基准问句|对照组/).first()).toBeVisible({
        timeout: 15_000,
      });

      // Inspect Ghost form & Shopify OAuth/Custom dual tabs inside connection modal
      await page.getByTestId('add-channel-connection-btn').click();
      const connModal = page.getByTestId('channel-connection-modal');
      await expect(connModal).toBeVisible();

      await selectAntDropdownOption(page, page.getByTestId('channel-provider-select'), /Ghost/i);
      await expect(connModal.getByText(/Admin API Key|API Key|id:hex/i).first()).toBeVisible();

      await selectAntDropdownOption(page, page.getByTestId('channel-provider-select'), /Shopify/i);
      await expect(connModal.getByText(/OAuth/i).first()).toBeVisible();
      await expect(connModal.getByText(/Custom.*Token|手动配置/i).first()).toBeVisible();

      await page
        .locator('.ant-modal-content:visible')
        .last()
        .getByRole('button', { name: '取消' })
        .click();
      await expect(connModal).toBeHidden();
      await assertLayoutErgonomics(page);

      // 2. CN /brands: inspect WeChat draft-only & IP whitelist notice + confirm Chrome Extension moved to /account (Y5)
      await page.goto(`/brands?brandId=${brand.id}&market=CN`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('brand-channel-connections')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('extension-pairing-panel')).toHaveCount(0);

      await page.getByTestId('add-channel-connection-btn').click();
      await expect(connModal).toBeVisible();
      await selectAntDropdownOption(
        page,
        page.getByTestId('channel-provider-select'),
        /公众号|微信公众号|草稿箱/,
      );
      await expect(
        connModal.getByText(/仅草稿|仅推送至公众号草稿箱|不自动群发/).first(),
      ).toBeVisible();
      await expect(connModal.getByText(/IP.*白名单|40164/).first()).toBeVisible();
      await page
        .locator('.ant-modal-content:visible')
        .last()
        .getByRole('button', { name: '取消' })
        .click();
      await expect(connModal).toBeHidden();

      // 3. Chrome Extension pairing panel on /account?tab=extension: create token -> plaintext gmext_ shown ONCE -> hidden after close -> revoke
      await page.goto(`/account?tab=extension&brandId=${brand.id}&market=CN`, {
        waitUntil: 'domcontentloaded',
      });
      await assertFourItemSidebar(page);
      const pairingPanel = page.getByTestId('extension-pairing-panel');
      await expect(pairingPanel).toBeVisible({ timeout: 15_000 });
      await expect(pairingPanel.getByText(/Chrome 扩展配对|扩展配对/).first()).toBeVisible({
        timeout: 15_000,
      });
      const labelInput = pairingPanel.getByLabel(/设备或浏览器名称|备注/).first();
      await expect(labelInput).toBeVisible({ timeout: 10_000 });
      await labelInput.fill('E2E Chrome Pairing Device');
      const createTokenBtn = pairingPanel
        .getByRole('button', { name: /生成扩展配对令牌|生成配对|创建配对/ })
        .first();
      await expect(createTokenBtn).toBeVisible({ timeout: 15_000 });
      await createTokenBtn.click();

      // Capture one-time plaintext gmext_ token from visible modal (text, <input>, <textarea>, <a href>)
      let capturedPlainToken = '';
      await expect
        .poll(
          async () => {
            const visibleModals = page.locator('.ant-modal-content:visible');
            if ((await visibleModals.count()) === 0) return '';
            const txt = await readTextIncludingInputs(visibleModals.last());
            const m = txt.match(/gmext_[A-Za-z0-9_-]{20,}/);
            if (m) {
              capturedPlainToken = m[0];
              return m[0];
            }
            return '';
          },
          {
            timeout: 15_000,
            message: 'One-time gmext_ plaintext token must be displayed once in modal',
          },
        )
        .toMatch(/^gmext_[A-Za-z0-9_-]{20,}$/);
      const plainToken = capturedPlainToken;

      // Close modal -> plaintext MUST NOT remain anywhere in DOM text or input/textarea values
      const closeModalTrigger = page
        .locator('.ant-modal-content:visible')
        .last()
        .getByRole('button', { name: /关闭|完成|我已复制|知道了|Close/i })
        .or(page.locator('.ant-modal-close:visible').last())
        .first();
      await expect(closeModalTrigger).toBeVisible({ timeout: 5_000 });
      await closeModalTrigger.click();
      await expect(page.locator('.ant-modal-content:visible')).toHaveCount(0, { timeout: 10_000 });
      expect(await readTextIncludingInputs(page.locator('body'))).not.toContain(plainToken);
      await assertLayoutErgonomics(page);

      // Verify pairing token row visible on /account & revoke cleanly
      await expect(page.getByText('E2E Chrome Pairing Device').first()).toBeVisible({
        timeout: 15_000,
      });

      const revokeBtn = page.getByRole('button', { name: /吊销|撤销/ }).first();
      await expect(revokeBtn).toBeVisible({ timeout: 10_000 });
      await revokeBtn.click();

      const confirmPop = page
        .locator('.ant-modal-confirm:visible, .ant-modal-content:visible')
        .last();
      await expect(confirmPop).toBeVisible({ timeout: 5_000 });
      await confirmPop
        .getByRole('button', { name: /确认|吊销|撤销|确定/ })
        .first()
        .click();
      await expect(confirmPop).toBeHidden({ timeout: 10_000 });

      // Verify token revoked via API
      await expect
        .poll(
          async () => {
            const res = await requestV2('/extension/me', { token: plainToken });
            return res.status;
          },
          { timeout: 15_000, message: 'Revoked extension token must return 401 on /extension/me' },
        )
        .toBe(401);

      await assertLayoutErgonomics(page);
      assertNoConsoleOrPageErrors(errorCollector);
    } finally {
      await context.close();
    }
  });

  test('T4-04: /studio upgrades (conditional targetLocale selector, Distribution Drawer L1 + CN L2 queue, Wilson CI & DiD toggle with live budget)', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const tag = uniqueTag(testInfo, 't404st');
    const tenant = await provisionIsolatedTenant({
      prefix: 't404st',
      billingMode: 'STRICT',
      initialPoints: 250,
    });
    const token = tenant.session.accessToken;

    const brand = await createBrandApi(tenant.session, buildDualMarketBrandPayload(tag));
    await upsertBrandFactsApi(tenant.session, brand.id, buildFourBrandFacts(brand.name), true);

    // Enable multi-locale (en-US, ja-JP) & 2 control prompts on GLOBAL market
    unwrapOk(
      await requestV2(`/brands/${brand.id}/markets/GLOBAL`, {
        method: 'PATCH',
        token,
        body: {
          supportedLocales: ['en-US', 'ja-JP'],
          controlPrompts: [`Control prompt alpha ${tag}`, `Control prompt beta ${tag}`],
        },
      }),
      'Enable multi-locale & control prompts',
    );

    const globalArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'GLOBAL',
        targetLocale: 'ja-JP',
        targetPrompt: `静音 4ベイ NAS 徹底レビュー ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      },
      't404-global-art',
    );
    const pubRecord = unwrapOk(
      await requestV2<PublishRecordWire>(`/articles/${globalArticle.id}/publish-records`, {
        method: 'POST',
        token,
        body: {
          publishedUrl: `https://crawl-ok.e2e.example/articles/${tag}-studio`,
          channel: 'Ghost Blog',
          autoRetest: { enabled: true, milestones: [7, 14, 30], sampleCount: 1 },
        },
      }),
      'Seed publish record for /studio timeline',
    );

    const cnArticle = await seedArticleViaSse(
      token,
      brand.id,
      {
        market: 'CN',
        targetPrompt: `四盘位家用私有云 NAS 知乎分发队列测试 ${tag}`,
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
      },
      't404-cn-art',
    );

    const { context, page } = await createAuthenticatedContext(browser, tenant.session, {
      viewport: V2_2_VIEWPORTS[0],
      preseedWorkspace: { activeBrandId: brand.id, activeMarket: 'GLOBAL' },
    });
    const errorCollector = attachErrorCollector(page);

    try {
      // 1. GLOBAL /studio: conditional targetLocale selector, Retest Timeline DiD toggle + live budget disclosure
      await page.goto(`/studio?brandId=${brand.id}&market=GLOBAL&articleId=${globalArticle.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('studio-workspace')).toBeVisible({ timeout: 20_000 });
      await assertFourItemSidebar(page);

      // Multi-locale selector visible because supportedLocales.length > 1
      await expect(page.getByText(/ja-JP|日本語|写作语种|目标语种/).first()).toBeVisible({
        timeout: 15_000,
      });

      // Verify /studio ergonomics at 1440x900 & 1015x909
      await assertLayoutErgonomics(page);

      // Navigate /studio -> /publish -> Retest timeline with DiD toggle + live budget recalculation
      await page.getByTestId('studio-go-publish-btn').click();
      await expect(page).toHaveURL(/\/publish/, { timeout: 15_000 });
      await expect(page.getByTestId('publish-workspace')).toBeVisible({ timeout: 20_000 });

      const timeline = page.getByTestId(`publish-retest-timeline-${pubRecord.id}`);
      await expect(timeline).toBeVisible({ timeout: 20_000 });
      await page.getByTestId(`publish-retest-advanced-toggle-${pubRecord.id}`).click();
      const budgetEl = page.getByTestId(`publish-retest-budget-${pubRecord.id}`);
      await expect(budgetEl).toBeVisible();
      const budgetBefore = await budgetEl.innerText();

      const didToggle = timeline
        .getByLabel(/对照组|DiD/i)
        .or(timeline.locator('input[type="checkbox"], [role="switch"]'))
        .first();
      await expect(didToggle).toBeVisible({ timeout: 15_000 });
      await didToggle.click();

      await expect
        .poll(async () => budgetEl.innerText(), {
          timeout: 15_000,
          message: 'Toggling includeControlPrompts must update live retest budget disclosure',
        })
        .not.toBe(budgetBefore);

      // Verify /publish Retest timeline ergonomics at 1440x900 & 1015x909
      await assertLayoutErgonomics(page);

      // Switch to inline Distribution tab on GLOBAL /publish & verify ergonomics
      await page.getByTestId('publish-tab-distribute').click();
      await expect(page.getByTestId('publish-distribution-workbench')).toBeVisible({
        timeout: 15_000,
      });
      await assertLayoutErgonomics(page);

      // 2. Switch to CN /publish & verify CN L2 Extension queue (ZHIHU_EXT) + async variant job progress
      await page.goto(
        `/publish?brandId=${brand.id}&market=CN&articleId=${cnArticle.id}&tab=distribute`,
        {
          waitUntil: 'domcontentloaded',
        },
      );
      const workbench = page.getByTestId('publish-distribution-workbench');
      await expect(workbench).toBeVisible({ timeout: 20_000 });

      // Select ZHIHU_EXT L2 target & generate variant via async GeoVariantJob
      const expandL2Btn = page.getByTestId('distribution-l2-expand-btn');
      if (await expandL2Btn.isVisible().catch(() => false)) {
        await expandL2Btn.click();
      }
      const zhihuTarget = page.getByTestId('distribution-target-ZHIHU_EXT');
      await expect(zhihuTarget).toBeVisible({ timeout: 15_000 });
      await zhihuTarget.click();
      await page.getByTestId('distribution-generate-variants-btn').click();

      const confirmModal = page.getByTestId('distribution-points-confirm-modal');
      await expect(confirmModal).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('distribution-points-confirm-submit-btn').click();
      await expect(confirmModal).toBeHidden({ timeout: 20_000 });

      await expect(page.getByTestId('distribution-variant-tabs')).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('distribution-variant-tabs').getByRole('tab', { name: /知乎/ }),
      ).toBeVisible({ timeout: 25_000 });

      await assertLayoutErgonomics(page);
      assertNoConsoleOrPageErrors(errorCollector);
    } finally {
      await context.close();
    }
  });
});
