import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  assertNoForbiddenLeadDtoKeys,
  assertRouteSeoAndJsonLd,
  clickHeaderLocaleSwitcher,
  clickPricingHandoffCta,
  expectedCanonicalUrl,
  extractHeadSeo,
  extractHtmlSeoFromMarkup,
  EXPECTED_FREE_ACTION_KEYS,
  EXPECTED_PRICING_DEFAULTS,
  fillAndSubmitDemoForm,
  getHeaderAuthCta,
  getMarketingOrigin,
  getMarketingWebBase,
  LEAD_STATUS_LABELS,
  MARKETING_GUIDE_CATALOG,
  MARKETING_VIEWPORTS,
  normalizeSeoUrl,
  parseRobotsTxt,
  parseSitemapXml,
  PRIVATE_ROBOTS_DISALLOW_PATHS,
  PRIVATE_SITEMAP_FORBIDDEN_PATHS,
  PROTECTED_CONSOLE_ROUTES,
  PUBLIC_ROUTE_MATRIX,
  queryAdminLeadsApi,
  readCalculatorTotalPoints,
  searchAdminLeadsInUi,
  setCalculatorAutoRetest,
  setCalculatorNumericInput,
  setCalculatorSamples,
  updateAdminLeadStatusAndNoteInUi,
  type MarketingLeadDto,
  type PublicPricingPayload,
} from './support/marketing-helpers';
import {
  getAdminSession,
  getDemoSession,
  requestV1,
  requestV2,
  unwrapOk,
} from './v2/support/api-client';
import {
  assertNoConsoleOrPageErrors,
  assertNoHorizontalOverflow,
  assertValidJsonLd,
  assertValidLlmsTxt,
} from './v2/support/assertions';
import { uniqueTag } from './v2/support/fixtures';
import { attachErrorCollector, createAuthenticatedContext } from './v2/support/ui-actions';

const FORBIDDEN_FIAT_PRICE_RE = /[$¥￥€£]|(?:USD|CNY|RMB)\s*\d|\d+\s*元\s*\/\s*[月年]/i;

const MAJOR_CRAWLER_AGENTS = [
  '*',
  'gptbot',
  'oai-searchbot',
  'perplexitybot',
  'claudebot',
  'googlebot',
] as const;

function extractGeoScoreFromText(text: string): number | null {
  const slashRe = /(?<![\d.]|[-\u2212]\s*)(\d{1,3})(?!\d|\.\d)\s*\/\s*100(?!\d|\.\d)/g;
  let slashMatch: RegExpExecArray | null = slashRe.exec(text);
  while (slashMatch) {
    const val = Number.parseInt(slashMatch[1], 10);
    if (val >= 0 && val <= 100) {
      return val;
    }
    slashMatch = slashRe.exec(text);
  }

  const stripped = text.replace(/\(?\s*0\s*[–—-]\s*100\s*\)?/g, ' ');
  const labeledRe =
    /(?:GEO\s*Score|GEO\s*评分|Score|评分|得分)[^0-9-\u2212]{0,28}(?<![\d.]|[-\u2212]\s*)(\d{1,3})(?!\d|\.\d)/gi;
  let labeledMatch: RegExpExecArray | null = labeledRe.exec(stripped);
  while (labeledMatch) {
    const val = Number.parseInt(labeledMatch[1], 10);
    if (val >= 0 && val <= 100) {
      return val;
    }
    labeledMatch = labeledRe.exec(stripped);
  }
  return null;
}

async function clickFirstVisible(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      await locator.first().click();
      return true;
    }
  }
  return false;
}

async function locateSandboxTablist(page: Page, path: string): Promise<Locator> {
  const byCitationLabel = page
    .locator('[role="tablist"]')
    .filter({ has: page.getByRole('tab', { name: /Citation|Diagnosis|引用|诊断/i }) })
    .first();

  let matchedIndex = -1;
  await expect
    .poll(
      async () => {
        if ((await byCitationLabel.count()) > 0 && (await byCitationLabel.isVisible())) {
          matchedIndex = -2;
          return true;
        }
        const allTablists = page.locator('[role="tablist"]');
        const total = await allTablists.count();
        for (let i = 0; i < total; i += 1) {
          const candidate = allTablists.nth(i);
          if ((await candidate.isVisible()) && (await candidate.getByRole('tab').count()) === 3) {
            matchedIndex = i;
            return true;
          }
        }
        return false;
      },
      { timeout: 10_000, message: `${path}: 3-tab sandbox tablist must be visible` },
    )
    .toBe(true);

  if (matchedIndex === -2) {
    return byCitationLabel;
  }
  return page.locator('[role="tablist"]').nth(matchedIndex);
}

async function getActiveTabpanel(page: Page, activeTab: Locator): Promise<Locator> {
  const controlsId = (await activeTab.getAttribute('aria-controls'))?.trim();
  if (controlsId) {
    const escapedId = controlsId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const controlled = page.locator(`[id="${escapedId}"]`).first();
    if ((await controlled.count()) > 0) {
      return controlled;
    }
  }
  return page.locator('[role="tabpanel"]:visible').first();
}

async function verifyHeroEngineStripToggle(page: Page, path: '/' | '/zh'): Promise<void> {
  // Find the closest-sibling (GLOBAL, CN) engine-strip toggle pair strictly OUTSIDE [role="tabpanel"]
  const candidateControls = page.locator(
    'main button, main label:has(input[type="radio"]), main [role="radio"], main [role="tab"]',
  );
  const controlCount = await candidateControls.count();

  const globalCandidates: number[] = [];
  const cnCandidates: number[] = [];

  for (let i = 0; i < controlCount; i += 1) {
    const ctrl = candidateControls.nth(i);
    const info = await ctrl.evaluate((el) => {
      if (el.closest('[role="tabpanel"]')) {
        return null;
      }
      const tablist = el.closest('[role="tablist"]');
      if (tablist && tablist.querySelectorAll('[role="tab"]').length >= 3) {
        return null;
      }
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        return null;
      }
      return (el.textContent ?? '').trim();
    });
    if (!info || /\+|both|双市场/i.test(info)) {
      continue;
    }
    if (/\bGLOBAL\b|Global|海外/i.test(info)) {
      globalCandidates.push(i);
    }
    if (/\bCN\b|China|国内|中国/i.test(info)) {
      cnCandidates.push(i);
    }
  }

  let bestPair: { globalIdx: number; cnIdx: number; distance: number } | null = null;
  for (const gIdx of globalCandidates) {
    const gHandle = await candidateControls.nth(gIdx).elementHandle();
    if (!gHandle) {
      continue;
    }
    for (const cIdx of cnCandidates) {
      if (gIdx === cIdx) {
        continue;
      }
      const cHandle = await candidateControls.nth(cIdx).elementHandle();
      if (!cHandle) {
        continue;
      }
      const distance = await page.evaluate(
        ([gEl, cEl]) => {
          let steps = 0;
          let node: HTMLElement | null = gEl.parentElement;
          while (node && node.tagName.toLowerCase() !== 'main') {
            steps += 1;
            if (node.contains(cEl)) {
              return steps;
            }
            node = node.parentElement;
          }
          return 999;
        },
        [gHandle, cHandle] as const,
      );
      if (distance < 999 && (!bestPair || distance < bestPair.distance)) {
        bestPair = { globalIdx: gIdx, cnIdx: cIdx, distance };
      }
    }
  }

  expect(
    bestPair,
    `${path}: Hero GLOBAL/CN engine strip toggle pair outside tabpanel must be visible`,
  ).not.toBeNull();

  const heroGlobalToggle = candidateControls.nth(bestPair!.globalIdx);
  const heroCnToggle = candidateControls.nth(bestPair!.cnIdx);

  const readStripState = async (
    targetToggle: Locator,
  ): Promise<{ activeAttr: string | null; stripText: string }> => {
    const toggleHandle = await targetToggle.elementHandle();
    const otherHandle = await (
      targetToggle === heroGlobalToggle ? heroCnToggle : heroGlobalToggle
    ).elementHandle();
    expect(toggleHandle).not.toBeNull();
    expect(otherHandle).not.toBeNull();
    return page.evaluate(
      ([el, sibling]) => {
        const radioInput =
          el instanceof HTMLInputElement && el.type === 'radio'
            ? el
            : el.querySelector<HTMLInputElement>('input[type="radio"]');
        const activeAttr =
          el.getAttribute('aria-pressed') ??
          el.getAttribute('aria-selected') ??
          el.getAttribute('aria-checked') ??
          (radioInput ? String(radioInput.checked) : null);

        // Walk up from common ancestor of GLOBAL + CN toggles (strictly below <main>)
        // until we reach the engine strip wrapper displaying engine names
        let node: HTMLElement | null = el.parentElement;
        while (node && !node.contains(sibling)) {
          node = node.parentElement;
        }
        let stripContainer: HTMLElement | null = node;
        for (let depth = 0; depth < 3 && stripContainer; depth += 1) {
          const text = (stripContainer.textContent ?? '').trim();
          if (/ChatGPT|Perplexity|Gemini|DeepSeek|豆包|Kimi|元宝|通义/i.test(text)) {
            break;
          }
          const parent: HTMLElement | null = stripContainer.parentElement;
          if (!parent || parent.tagName.toLowerCase() === 'main') {
            break;
          }
          stripContainer = parent;
        }
        return {
          activeAttr,
          stripText: (stripContainer?.textContent ?? '').trim(),
        };
      },
      [toggleHandle!, otherHandle!] as const,
    );
  };

  await heroGlobalToggle.click();
  await expect
    .poll(async () => (await readStripState(heroGlobalToggle)).stripText, { timeout: 5_000 })
    .toMatch(/ChatGPT/i);
  const globalState = await readStripState(heroGlobalToggle);
  expect(globalState.stripText).toMatch(/Perplexity/i);
  expect(globalState.stripText).toMatch(/Gemini|Google/i);
  if (globalState.activeAttr !== null) {
    expect(globalState.activeAttr).toBe('true');
  }

  await heroCnToggle.click();
  await expect
    .poll(async () => (await readStripState(heroCnToggle)).stripText, { timeout: 5_000 })
    .toMatch(/DeepSeek|豆包|Kimi|元宝|通义/i);
  const cnState = await readStripState(heroCnToggle);
  const globalAfterCnState = await readStripState(heroGlobalToggle);
  const stateChanged =
    cnState.stripText !== globalState.stripText ||
    (cnState.activeAttr === 'true' && globalAfterCnState.activeAttr === 'false');
  expect(
    stateChanged,
    `${path}: Clicking CN hero engine toggle must update engine strip state or text`,
  ).toBe(true);
  if (cnState.activeAttr !== null) {
    expect(cnState.activeAttr).toBe('true');
  }
}

async function assertHiddenHoneypotPresent(page: Page, path: string): Promise<void> {
  const honeypot = page.locator('main form input[name="honeypot"]').first();
  await expect(honeypot, `${path}: demo form must include input[name="honeypot"]`).toHaveCount(1);

  const hiddenState = await honeypot.evaluate((el) => {
    const input = el as HTMLInputElement;
    const style = window.getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const ariaHidden =
      input.getAttribute('aria-hidden') === 'true' ||
      Boolean(input.closest('[aria-hidden="true"]'));
    const tabIndex = input.tabIndex;
    const isVisuallyHidden =
      input.type === 'hidden' ||
      input.hidden ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      rect.width <= 1 ||
      rect.height <= 1 ||
      rect.right <= 0 ||
      rect.bottom <= 0;
    return { isVisuallyHidden, ariaHidden, tabIndex };
  });

  expect(
    hiddenState.isVisuallyHidden || (hiddenState.ariaHidden && hiddenState.tabIndex < 0),
    `${path}: honeypot input must be hidden from sighted users (${JSON.stringify(hiddenState)})`,
  ).toBe(true);
}

function extractFaqQuestionNames(jsonLdRawScripts: string[]): string[] {
  const questions: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    const typeVal = record['@type'];
    const isFaqPage =
      typeVal === 'FAQPage' || (Array.isArray(typeVal) && typeVal.includes('FAQPage'));
    if (isFaqPage && Array.isArray(record.mainEntity)) {
      for (const item of record.mainEntity) {
        if (item && typeof item === 'object') {
          const name = (item as Record<string, unknown>).name;
          if (typeof name === 'string' && name.trim().length > 0) {
            questions.push(name.trim());
          }
        }
      }
    }
    if (Array.isArray(record['@graph'])) {
      visit(record['@graph']);
    }
  };

  for (const raw of jsonLdRawScripts) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // Validated separately by assertRouteSeoAndJsonLd
    }
  }
  return questions;
}

async function verifySandboxForLocale(page: Page, path: '/' | '/zh'): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${path} should return 200`).toBe(200);

  const tablist = await locateSandboxTablist(page, path);
  const tabs = tablist.getByRole('tab');
  await expect(tabs, `${path}: sandbox must expose 3 ARIA tabs`).toHaveCount(3);

  // Tab 1 — Citation Diagnosis: toggle GLOBAL vs CN and confirm visible state + citation share update
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  const tab1Panel = await getActiveTabpanel(page, tabs.nth(0));
  await expect(tab1Panel, `${path}: Tab 1 active tabpanel must be visible`).toBeVisible();

  const globalToggle = tab1Panel
    .getByRole('button', { name: /\bGLOBAL\b|海外/i })
    .or(tab1Panel.getByRole('radio', { name: /\bGLOBAL\b|海外/i }))
    .first();
  const cnToggle = tab1Panel
    .getByRole('button', { name: /\bCN\b|国内/i })
    .or(tab1Panel.getByRole('radio', { name: /\bCN\b|国内/i }))
    .first();

  await expect(globalToggle, `${path}: Tab 1 GLOBAL toggle must be visible`).toBeVisible();
  await expect(cnToggle, `${path}: Tab 1 CN toggle must be visible`).toBeVisible();

  await globalToggle.click();
  const globalPanelText = ((await tab1Panel.textContent()) ?? '').trim();
  expect(globalPanelText, `${path}: Tab 1 GLOBAL should display citation status taxonomy`).toMatch(
    /CITED|MENTIONED|COMPETITOR|ABSENT|已引用|提及|竞品|未出现/i,
  );
  expect(globalPanelText, `${path}: Tab 1 GLOBAL should display percentage metric`).toMatch(/\d+%/);

  await cnToggle.click();
  await expect
    .poll(async () => ((await tab1Panel.textContent()) ?? '').trim(), { timeout: 5_000 })
    .not.toBe(globalPanelText);
  const cnPanelText = ((await tab1Panel.textContent()) ?? '').trim();
  expect(cnPanelText, `${path}: Tab 1 CN should display citation status taxonomy`).toMatch(
    /CITED|MENTIONED|COMPETITOR|ABSENT|已引用|提及|竞品|未出现/i,
  );
  expect(cnPanelText, `${path}: Tab 1 CN should display percentage metric`).toMatch(/\d+%/);

  // Tab 2 — Studio & Preflight Gate: toggle interactive controls and assert blockers/warnings & 0–100 GEO score change
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  const tab2Panel = await getActiveTabpanel(page, tabs.nth(1));
  await expect(tab2Panel, `${path}: Tab 2 active tabpanel must be visible`).toBeVisible();

  const initialTab2Text = ((await tab2Panel.innerText()) ?? '').trim();
  const initialScore = extractGeoScoreFromText(initialTab2Text);
  expect(
    initialScore,
    `${path}: Tab 2 must render a visible 0–100 GEO score (panel text: ${initialTab2Text.slice(0, 160)})`,
  ).not.toBeNull();

  const preflightControls = tab2Panel.locator(
    'button:not([role="tab"]):not([disabled]), input[type="checkbox"]:not([disabled]), [role="switch"]:not([aria-disabled="true"])',
  );
  const controlCount = await preflightControls.count();
  expect(
    controlCount,
    `${path}: Tab 2 must expose interactive preflight toggles ([TBD] / hype / CJK leak)`,
  ).toBeGreaterThan(0);

  let scoreChanged = false;
  let toggledControlIndex = -1;
  let updatedScore: number | null = null;
  let updatedTab2Text = initialTab2Text;

  for (let i = 0; i < Math.min(controlCount, 6); i += 1) {
    const ctrl = preflightControls.nth(i);
    if (!(await ctrl.isVisible()) || !(await ctrl.isEnabled())) {
      continue;
    }
    await ctrl.click();
    updatedTab2Text = ((await tab2Panel.innerText()) ?? '').trim();
    updatedScore = extractGeoScoreFromText(updatedTab2Text);
    if (updatedScore !== null && updatedScore !== initialScore) {
      scoreChanged = true;
      toggledControlIndex = i;
      break;
    }
  }

  expect(
    scoreChanged,
    `${path}: Toggling Tab 2 preflight controls must numerically change the 0–100 GEO score (initial=${String(initialScore)}, after=${String(updatedScore)})`,
  ).toBe(true);
  expect(updatedTab2Text).not.toBe(initialTab2Text);
  expect(updatedTab2Text, `${path}: Tab 2 should reflect preflight gate status/findings`).toMatch(
    /block|warn|pass|ready|TBD|CJK|hype|门禁|阻断|警告|通过|违规|泄漏/i,
  );

  // Toggle back to confirm reversible live evaluation restores exact initial score
  if (toggledControlIndex >= 0) {
    await preflightControls.nth(toggledControlIndex).click();
    await expect
      .poll(async () => extractGeoScoreFromText(((await tab2Panel.innerText()) ?? '').trim()), {
        timeout: 5_000,
      })
      .toBe(initialScore);
  }

  // Tab 3 — 1→N Distribution & Attribution: switch channels + verify T+1 CrawlProbe & SVG T+7/14/30 chart
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  const tab3Panel = await getActiveTabpanel(page, tabs.nth(2));
  await expect(tab3Panel, `${path}: Tab 3 active tabpanel must be visible`).toBeVisible();

  const clickedL1 = await clickFirstVisible([
    tab3Panel.getByRole('button', { name: /Shopify|WordPress|L1/i }),
    tab3Panel.getByRole('radio', { name: /Shopify|WordPress|L1/i }),
    tab3Panel.getByRole('tab', { name: /Shopify|WordPress|L1/i }),
  ]);
  expect(clickedL1, `${path}: Tab 3 Shopify/WordPress L1 channel control must exist`).toBe(true);
  const l1Text = ((await tab3Panel.textContent()) ?? '').trim();
  expect(l1Text).toMatch(/Shopify|WordPress|JSON-LD|IndexNow/i);

  const clickedReddit = await clickFirstVisible([
    tab3Panel.getByRole('button', { name: /Reddit|社区/i }),
    tab3Panel.getByRole('radio', { name: /Reddit|社区/i }),
    tab3Panel.getByRole('tab', { name: /Reddit|社区/i }),
  ]);
  expect(clickedReddit, `${path}: Tab 3 Reddit checklist control must exist`).toBe(true);
  const redditText = ((await tab3Panel.textContent()) ?? '').trim();
  expect(redditText).toMatch(/Reddit/i);
  expect(redditText).not.toBe(l1Text);

  const clickedPr = await clickFirstVisible([
    tab3Panel.getByRole('button', { name: /PR|KOL|媒体|供稿/i }),
    tab3Panel.getByRole('radio', { name: /PR|KOL|媒体|供稿/i }),
    tab3Panel.getByRole('tab', { name: /PR|KOL|媒体|供稿/i }),
  ]);
  expect(clickedPr, `${path}: Tab 3 PR/KOL kit control must exist`).toBe(true);
  const prText = ((await tab3Panel.textContent()) ?? '').trim();
  expect(prText).toMatch(/PR|KOL|media|供稿/i);
  expect(prText).not.toBe(redditText);

  // Verify T+1 CrawlProbe & hand-written <svg> T+7/T+14/T+30 attribution chart across Tab 3 views
  const combinedTab3Text = `${l1Text}\n${redditText}\n${prText}`;
  expect(combinedTab3Text).toMatch(/T\+1/i);
  expect(combinedTab3Text).toMatch(/T\+7/i);
  expect(combinedTab3Text).toMatch(/T\+14/i);
  expect(combinedTab3Text).toMatch(/T\+30/i);

  const svgs = tab3Panel.locator('svg');
  const svgCount = await svgs.count();
  expect(svgCount, `${path}: Tab 3 must render an inline <svg> attribution chart`).toBeGreaterThan(
    0,
  );

  let foundChartSvg = false;
  for (let i = 0; i < svgCount; i += 1) {
    const box = await svgs.nth(i).boundingBox();
    if (box && box.width >= 100 && box.height >= 40) {
      foundChartSvg = true;
      break;
    }
  }
  expect(
    foundChartSvg,
    `${path}: Tab 3 must display a rendered non-icon <svg> attribution chart`,
  ).toBe(true);
}

// ============================================================================
// TIER 1 — Feature Coverage
// ============================================================================

test.describe(
  'Marketing Site — Tier 1: Feature Coverage',
  { tag: ['@marketing', '@tier1'] },
  () => {
    test('T1.1 Anonymous root / renders EN brand homepage with interactive sections while console routes redirect to /login', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
        expect(res?.status()).toBe(200);
        expect(new URL(page.url()).pathname).toBe('/');

        // Core semantic landmarks & hero value prop
        await expect(page.locator('header').first()).toBeVisible();
        await expect(page.locator('main').first()).toBeVisible();
        await expect(page.locator('footer').first()).toBeVisible();

        // Anonymous header auth CTA -> Sign In (/login)
        const anonAuthCta = getHeaderAuthCta(page);
        await expect(anonAuthCta, 'Anonymous EN header auth CTA must be visible').toBeVisible();
        await expect(anonAuthCta).toContainText(/Sign In/i);
        await expect(anonAuthCta).toHaveAttribute('href', '/login');

        const h1 = page.locator('h1').first();
        await expect(h1).toBeVisible();
        await expect(h1).toContainText(/Source AI Cites|AI Cites/i);

        // Hero CTA to /demo
        await expect(page.locator('main a[href^="/demo"]').first()).toBeVisible();

        // Dual-Market GLOBAL / CN engine strip toggle (strictly outside sandbox tabpanel)
        await verifyHeroEngineStripToggle(page, '/');

        // #workflow 4-step section
        const workflowSection = page.locator('#workflow');
        await expect(workflowSection).toBeVisible();

        // Connector ecosystem & explicit v2.2 roadmap boundary
        const bodyText = ((await page.locator('main').textContent()) ?? '').trim();
        expect(bodyText).toMatch(/Shopify/i);
        expect(bodyText).toMatch(/WordPress/i);
        expect(bodyText).toMatch(/v2\.2/i);

        // 4 security commitments
        expect(bodyText).toMatch(/AES-256-GCM/i);
        expect(bodyText).toMatch(/SSRF/i);
        expect(bodyText).toMatch(/tenant|PostgreSQL|ledger|isolation/i);
        expect(bodyText).toMatch(/zero.*astroturf|no.*bot|community|auto.*post/i);

        // FAQ accordion expand/collapse interaction (scoped to visible question from FAQPage JSON-LD)
        const headSeo = await extractHeadSeo(page);
        const faqQuestions = extractFaqQuestionNames(headSeo.jsonLdRawScripts);
        expect(
          faqQuestions.length,
          '/: FAQPage JSON-LD must expose at least one Question',
        ).toBeGreaterThan(0);

        let matchedAccordionButton: Locator | null = null;
        let matchedDetailsEl: Locator | null = null;
        for (const q of faqQuestions) {
          const btnCandidate = page
            .locator('main button[aria-expanded]')
            .filter({ hasText: q })
            .first();
          if ((await btnCandidate.count()) > 0 && (await btnCandidate.isVisible())) {
            matchedAccordionButton = btnCandidate;
            break;
          }
          const detailsCandidate = page.locator('main details').filter({ hasText: q }).first();
          if ((await detailsCandidate.count()) > 0 && (await detailsCandidate.isVisible())) {
            matchedDetailsEl = detailsCandidate;
            break;
          }
        }

        if (matchedAccordionButton) {
          const beforeExpanded = await matchedAccordionButton.getAttribute('aria-expanded');
          expect(beforeExpanded === 'true' || beforeExpanded === 'false').toBe(true);
          const expectedAfterFirst = beforeExpanded === 'true' ? 'false' : 'true';
          await matchedAccordionButton.click();
          await expect(matchedAccordionButton).toHaveAttribute('aria-expanded', expectedAfterFirst);
          await matchedAccordionButton.click();
          await expect(matchedAccordionButton).toHaveAttribute('aria-expanded', beforeExpanded!);
        } else {
          expect(
            matchedDetailsEl,
            `Expected visible FAQ accordion (button[aria-expanded] or <details>) matching FAQPage JSON-LD question "${faqQuestions[0]}"`,
          ).not.toBeNull();
          const summary = matchedDetailsEl!.locator('summary').first();
          const wasOpen = await matchedDetailsEl!.evaluate((el) => (el as HTMLDetailsElement).open);
          await summary.click();
          await expect
            .poll(async () => matchedDetailsEl!.evaluate((el) => (el as HTMLDetailsElement).open))
            .toBe(!wasOpen);
          await summary.click();
          await expect
            .poll(async () => matchedDetailsEl!.evaluate((el) => (el as HTMLDetailsElement).open))
            .toBe(wasOpen);
        }

        // All 5 protected console workspaces must still redirect anonymous visitors to /login
        for (const route of PROTECTED_CONSOLE_ROUTES) {
          await page.goto(route, { waitUntil: 'domcontentloaded' });
          await expect(
            page,
            `Anonymous navigation to protected workspace ${route} must redirect to /login`,
          ).toHaveURL(/\/login(?:\?|$)/, { timeout: 15_000 });
        }

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T1.2 All 16 public SSR routes return 200 with canonical, reciprocal hreflang, locale markers, and required JSON-LD', async ({
      browser,
    }) => {
      const origin = getMarketingOrigin();
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        expect(PUBLIC_ROUTE_MATRIX).toHaveLength(16);

        for (const spec of PUBLIC_ROUTE_MATRIX) {
          const res = await page.goto(spec.path, { waitUntil: 'domcontentloaded' });
          expect(res?.status(), `GET ${spec.path} must return HTTP 200`).toBe(200);
          await assertRouteSeoAndJsonLd(page, spec, origin);

          if (spec.path === '/guides' || spec.path === '/zh/guides') {
            const mainText = ((await page.locator('main').textContent()) ?? '').trim();
            for (const guide of MARKETING_GUIDE_CATALOG) {
              const expectedTitle = spec.locale === 'zh-CN' ? guide.zhTitle : guide.enTitle;
              expect(mainText, `${spec.path} must list guide "${guide.slug}"`).toContain(
                expectedTitle,
              );
              const expectedHref =
                spec.locale === 'zh-CN' ? `/zh/guides/${guide.slug}` : `/guides/${guide.slug}`;
              await expect(
                page.locator(`main a[href="${expectedHref}"]`).first(),
                `${spec.path} must link to ${expectedHref}`,
              ).toBeVisible();
            }
          }

          if (spec.requiredJsonLdTypes.includes('TechArticle')) {
            const articleBodyLen = await page.evaluate(
              () => (document.querySelector('main')?.innerText ?? '').trim().length,
            );
            expect(
              articleBodyLen,
              `${spec.path}: guide detail page must render substantial article body`,
            ).toBeGreaterThan(300);
          }

          if (
            spec.path === '/' ||
            spec.path === '/zh' ||
            spec.path === '/pricing' ||
            spec.path === '/zh/pricing'
          ) {
            const routeSeo = await extractHeadSeo(page);
            for (const rawJsonLd of routeSeo.jsonLdRawScripts) {
              expect(
                rawJsonLd,
                `${spec.path}: JSON-LD must not contain fiat priceCurrency or fiat price tokens`,
              ).not.toMatch(/"priceCurrency"|"price"\s*:|\b(?:USD|CNY|RMB|EUR|GBP)\b/i);
              expect(
                rawJsonLd,
                `${spec.path}: JSON-LD must not contain forbidden fiat price patterns`,
              ).not.toMatch(FORBIDDEN_FIAT_PRICE_RE);
            }
          }
        }

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T1.3 Self-GEO crawler infrastructure (/robots.txt, /sitemap.xml, /llms.txt) satisfies crawler & AI indexing contract', async () => {
      const webBase = getMarketingWebBase();
      const origin = getMarketingOrigin();

      // 1. /robots.txt (RFC-9309 per-User-agent section validation)
      const robotsRes = await fetch(`${webBase}/robots.txt`);
      expect(robotsRes.status).toBe(200);
      expect(robotsRes.headers.get('content-type') ?? '').toMatch(/text\/plain/i);
      const robotsText = await robotsRes.text();
      const robots = parseRobotsTxt(robotsText);

      const wildcardGroup = robots.groups['*'];
      expect(
        wildcardGroup,
        `robots.txt must declare a User-agent: * section:\n${robotsText}`,
      ).toBeTruthy();
      expect(
        wildcardGroup.allows.includes('/'),
        `robots.txt User-agent: * must Allow: /:\n${robotsText}`,
      ).toBe(true);
      expect(
        wildcardGroup.disallows.includes('/'),
        `robots.txt User-agent: * must NOT Disallow: /:\n${robotsText}`,
      ).toBe(false);

      const assertGroupDisallowsPrivatePaths = (agentName: string, disallows: string[]) => {
        for (const privatePath of PRIVATE_ROBOTS_DISALLOW_PATHS) {
          const clean = privatePath.replace(/\/$/, '');
          const matched = disallows.some(
            (rule) => rule === privatePath || rule === clean || rule === `${clean}/`,
          );
          expect(
            matched,
            `robots.txt User-agent "${agentName}" must disallow "${privatePath}" (found disallows: ${disallows.join(', ')})`,
          ).toBe(true);
        }
      };

      assertGroupDisallowsPrivatePaths('*', wildcardGroup.disallows);

      for (const agent of MAJOR_CRAWLER_AGENTS) {
        const group = robots.groups[agent];
        if (!group) {
          continue;
        }
        expect(
          group.disallows.includes('/'),
          `robots.txt must NOT block crawler "${agent}" with Disallow: /`,
        ).toBe(false);
        if (agent !== '*') {
          // Per RFC 9309, an explicit crawler group overrides '*' and does not inherit its disallows
          assertGroupDisallowsPrivatePaths(agent, group.disallows);
        }
      }

      const expectedSitemapUrl = `${origin}/sitemap.xml`;
      expect(
        robots.sitemaps.some((url) => url === expectedSitemapUrl),
        `robots.txt must declare Sitemap: ${expectedSitemapUrl} (found: ${robots.sitemaps.join(', ')})`,
      ).toBe(true);

      // 2. /sitemap.xml
      const sitemapRes = await fetch(`${webBase}/sitemap.xml`);
      expect(sitemapRes.status).toBe(200);
      const sitemapXml = await sitemapRes.text();
      expect(sitemapXml).toContain('<urlset');
      const sitemap = parseSitemapXml(sitemapXml);

      const sitemapEntriesByUrl = new Map(
        sitemap.entries.map((entry) => [normalizeSeoUrl(entry.loc), entry]),
      );
      for (const route of PUBLIC_ROUTE_MATRIX) {
        const expectedUrl = normalizeSeoUrl(expectedCanonicalUrl(origin, route.path));
        const entry = sitemapEntriesByUrl.get(expectedUrl);
        expect(entry, `sitemap.xml must include <url> entry for ${expectedUrl}`).toBeTruthy();
        expect(
          entry!.hreflangs,
          `sitemap.xml <url> for ${expectedUrl} must declare hreflang="en"`,
        ).toContain('en');
        expect(
          entry!.hreflangs,
          `sitemap.xml <url> for ${expectedUrl} must declare hreflang="zh-CN"`,
        ).toContain('zh-CN');
        expect(
          entry!.hreflangs,
          `sitemap.xml <url> for ${expectedUrl} must declare hreflang="x-default"`,
        ).toContain('x-default');
      }

      expect(sitemap.entries.length).toBeGreaterThanOrEqual(PUBLIC_ROUTE_MATRIX.length);

      for (const forbidden of PRIVATE_SITEMAP_FORBIDDEN_PATHS) {
        const leaked = sitemap.locs.filter((loc) => {
          const pathname = new URL(loc).pathname;
          const cleanForbidden = forbidden.replace(/\/$/, '');
          return pathname === cleanForbidden || pathname.startsWith(`${cleanForbidden}/`);
        });
        expect(
          leaked,
          `sitemap.xml must exclude private path "${forbidden}" (found: ${leaked.join(', ')})`,
        ).toEqual([]);
      }

      // 3. /llms.txt
      const llmsRes = await fetch(`${webBase}/llms.txt`);
      expect(llmsRes.status).toBe(200);
      const llmsContentType = llmsRes.headers.get('content-type') ?? '';
      expect(llmsContentType).toMatch(/text\/plain/i);
      expect(llmsContentType).toMatch(/charset=utf-8/i);
      const llmsBody = await llmsRes.text();

      assertValidLlmsTxt(llmsBody, 'GeoMix');
      expect(llmsBody).toMatch(/ChatGPT/i);
      expect(llmsBody).toMatch(/Perplexity/i);
      expect(llmsBody).toMatch(/DeepSeek|豆包|Doubao/i);
      expect(llmsBody).toMatch(/1,000|1000/);

      for (const guide of MARKETING_GUIDE_CATALOG) {
        expect(llmsBody, `/llms.txt must reference guide slug "${guide.slug}"`).toContain(
          guide.slug,
        );
      }
    });

    test('T1.4 Homepage 3-tab InteractiveProductSandbox works end-to-end in EN (/) and ZH (/zh)', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        await verifySandboxForLocale(page, '/');
        await verifySandboxForLocale(page, '/zh');
        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T1.5 /pricing & /zh/pricing transparent pricing API, 3 plan cards, 7 free actions, and PointsBudgetCalculator live math', async ({
      browser,
    }) => {
      // Direct API contract verification for GET /api/v2/public/pricing
      const apiRes = await requestV2<PublicPricingPayload>('/public/pricing', { method: 'GET' });
      expect(apiRes.status).toBe(200);
      expect(apiRes.envelope.code).toBe(0);
      expect((apiRes.envelope.msg ?? '').length).toBeGreaterThan(0);

      const payload = unwrapOk(apiRes, 'GET /api/v2/public/pricing');
      expect(payload.items).toHaveLength(4);
      for (const [action, expectedUnitPoints] of Object.entries(EXPECTED_PRICING_DEFAULTS)) {
        const found = payload.items.find((item) => item.action === action);
        expect(found, `Pricing API missing action "${action}"`).toBeTruthy();
        expect(found?.unitPoints, `Pricing API mismatch for "${action}"`).toBe(expectedUnitPoints);
      }

      const freeActionKeys = payload.freeActions.map((item) => item.action);
      expect(freeActionKeys).toHaveLength(EXPECTED_FREE_ACTION_KEYS.length);
      for (const key of EXPECTED_FREE_ACTION_KEYS) {
        expect(freeActionKeys, `Pricing API missing free action "${key}"`).toContain(key);
      }

      expect(payload.demoTrial).toEqual({ points: 1000, validDays: 365 });

      // Security check: zero tenant, wallet, billingMode, or LLM provider/cost leakage
      const rawJsonLower = apiRes.rawText.toLowerCase();
      for (const forbidden of [
        'seed_tenant_demo',
        'seed_tenant_platform',
        'tenantid',
        'tenantname',
        'billingmode',
        'wallet',
        'costusd',
        'apikey',
      ]) {
        expect(
          rawJsonLower,
          `GET /api/v2/public/pricing must never leak "${forbidden}"`,
        ).not.toContain(forbidden);
      }

      // UI checks on /pricing (EN) and /zh/pricing (ZH)
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        // EN /pricing
        const enRes = await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
        expect(enRes?.status()).toBe(200);

        const enMainText = ((await page.locator('main').innerText()) ?? '').trim();
        expect(enMainText, '/pricing must contain zero hardcoded fiat prices').not.toMatch(
          FORBIDDEN_FIAT_PRICE_RE,
        );
        expect(enMainText).toMatch(/1,000|1000/);
        expect(enMainText).toMatch(/365/);
        expect(enMainText).toMatch(/Demo|Trial/i);
        expect(enMainText).toMatch(/Growth/i);
        expect(enMainText).toMatch(/Enterprise|Agency/i);

        // Transparent paid action labels & unit point values (10 / 2 / 5 / 2 pts)
        for (const paidActionEn of [
          /GEO\s+Targeted\s+Writing|Targeted\s+Writing/i,
          /AI\s+Visibility\s+Check|Visibility\s+Check/i,
          /Inline\s+AI\s+Image|AI\s+Image/i,
          /Channel\s+Variant/i,
        ]) {
          expect(enMainText, `/pricing must list paid action matching ${paidActionEn}`).toMatch(
            paidActionEn,
          );
        }
        expect(enMainText).toMatch(/(?<![\d,.])10\s*(?:pts|points)\b/i);
        expect(enMainText).toMatch(/(?<![\d,.])5\s*(?:pts|points)\b/i);
        expect(enMainText).toMatch(/(?<![\d,.])2\s*(?:pts|points)\b/i);

        for (const freeLabel of [
          /Topic Brief|Brief/i,
          /Fact Card|Brand Fact/i,
          /0[–-]100|GEO.*Audit|Evaluate/i,
          /Section Rewrite|Rewrite/i,
          /Preflight/i,
          /Crawl/i,
          /PR\s*\/?\s*KOL|Media Kit/i,
        ]) {
          expect(enMainText, `/pricing should list free action matching ${freeLabel}`).toMatch(
            freeLabel,
          );
        }

        // PointsBudgetCalculator live arithmetic
        expect(await readCalculatorTotalPoints(page)).toBe(464);

        await setCalculatorAutoRetest(page, false);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(272);

        await setCalculatorAutoRetest(page, true);
        await setCalculatorSamples(page, 3);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(1168);

        // Minimum boundary extremes: (1, 0, 5, 1, 1x, autoRetest=false) = 20
        await setCalculatorNumericInput(page, 'articles', 1);
        await setCalculatorNumericInput(page, 'channels', 0);
        await setCalculatorNumericInput(page, 'prompts', 5);
        await setCalculatorNumericInput(page, 'engines', 1);
        await setCalculatorSamples(page, 1);
        await setCalculatorAutoRetest(page, false);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(20);

        // Maximum boundary extremes: (50, 4, 100, 5, 3x, autoRetest=true) = 8400
        await setCalculatorNumericInput(page, 'articles', 50);
        await setCalculatorNumericInput(page, 'channels', 4);
        await setCalculatorNumericInput(page, 'prompts', 100);
        await setCalculatorNumericInput(page, 'engines', 5);
        await setCalculatorSamples(page, 3);
        await setCalculatorAutoRetest(page, true);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(8400);

        // ZH /zh/pricing
        const zhRes = await page.goto('/zh/pricing', { waitUntil: 'domcontentloaded' });
        expect(zhRes?.status()).toBe(200);
        const zhMainText = ((await page.locator('main').innerText()) ?? '').trim();
        expect(zhMainText, '/zh/pricing must contain zero hardcoded fiat prices').not.toMatch(
          FORBIDDEN_FIAT_PRICE_RE,
        );
        expect(zhMainText).toMatch(/1,000|1000/);
        expect(zhMainText).toMatch(/365/);
        // 3 plan cards in ZH
        expect(zhMainText).toMatch(/试用|Demo/i);
        expect(zhMainText).toMatch(/成长|增长|Growth/i);
        expect(zhMainText).toMatch(/企业|代理商|Enterprise/i);
        // 4 paid actions & unit points in ZH
        for (const paidActionZh of [
          /GEO\s*(?:靶向|定向)写作|(?:靶向|定向)写作/,
          /AI\s*可见(?:性|度)(?:监测|检测)|可见(?:性|度)(?:监测|检测)/,
          /行内.*配图|正文.*配图|AI\s*配图/,
          /渠道变体|改写变体/,
        ]) {
          expect(zhMainText, `/zh/pricing must list paid action matching ${paidActionZh}`).toMatch(
            paidActionZh,
          );
        }
        expect(zhMainText).toMatch(/(?<![\d,.])10\s*(?:点|pts)/i);
        expect(zhMainText).toMatch(/(?<![\d,.])5\s*(?:点|pts)/i);
        expect(zhMainText).toMatch(/(?<![\d,.])2\s*(?:点|pts)/i);

        for (const freeLabelZh of [
          /选题简报/,
          /事实卡/,
          /0[–-]100|实时体检/,
          /分段重写/,
          /门禁/,
          /抓取/,
          /供稿单|PR\/KOL/,
        ]) {
          expect(zhMainText, `/zh/pricing should list free action matching ${freeLabelZh}`).toMatch(
            freeLabelZh,
          );
        }

        // Verify ZH calculator initializes to 464 and updates live on toggle
        expect(await readCalculatorTotalPoints(page)).toBe(464);
        await setCalculatorAutoRetest(page, false);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(272);

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T1.6 /demo and /zh/demo submit valid leads via UI and display confirmation state', async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);
      const tagEn = uniqueTag(testInfo, 'demoen');
      const tagZh = uniqueTag(testInfo, 'demozh');

      try {
        // EN /demo submission
        const enRes = await page.goto('/demo', { waitUntil: 'domcontentloaded' });
        expect(enRes?.status()).toBe(200);
        await assertHiddenHoneypotPresent(page, '/demo');

        const enSubmit = await fillAndSubmitDemoForm(page, {
          name: `Alex ${tagEn}`,
          email: `${tagEn}@e2e.example`,
          companyBrand: `NordicAudio ${tagEn}`,
          websiteUrl: 'https://nordicaudio.example/products',
          targetMarket: 'GLOBAL',
          monthlyGoal: '8 articles / 20 tracked prompts',
          notes: 'Evaluating Global GEO visibility diagnosis and Shopify L1 publishing.',
        });

        expect(enSubmit.status).toBe(200);
        expect(enSubmit.envelope.code).toBe(0);
        expect(enSubmit.envelope.data?.accepted).toBe(true);
        expect(typeof enSubmit.envelope.data?.id).toBe('string');
        expect((enSubmit.envelope.data?.id ?? '').length).toBeGreaterThan(0);
        await expect(page.getByTestId('demo-submit-success')).toBeVisible();

        // ZH /zh/demo submission
        const zhRes = await page.goto('/zh/demo', { waitUntil: 'domcontentloaded' });
        expect(zhRes?.status()).toBe(200);
        await assertHiddenHoneypotPresent(page, '/zh/demo');

        const zhSubmit = await fillAndSubmitDemoForm(page, {
          name: `林测 ${tagZh}`,
          email: `${tagZh}@e2e.example`,
          companyBrand: `北境声学 ${tagZh}`,
          websiteUrl: 'https://beijingaudio.example',
          targetMarket: 'BOTH',
          monthlyGoal: '每月 12 篇双语内容与 40 个核心问句监测',
          notes: '申请 1,000 点试用，评估海外与国内双市场引用监测闭环。',
        });

        expect(zhSubmit.status).toBe(200);
        expect(zhSubmit.envelope.code).toBe(0);
        expect(zhSubmit.envelope.data?.accepted).toBe(true);
        expect(typeof zhSubmit.envelope.data?.id).toBe('string');
        expect((zhSubmit.envelope.data?.id ?? '').length).toBeGreaterThan(0);
        await expect(page.getByTestId('demo-submit-success')).toBeVisible();

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });
  },
);

// ============================================================================
// TIER 2 — Boundary, Validation & Security Corner Cases
// ============================================================================

test.describe(
  'Marketing Site — Tier 2: Boundary, Validation & Security',
  { tag: ['@marketing', '@tier2'] },
  () => {
    test('T2.1 Unknown and wrong-case guide slugs return HTTP 404 without unhandled pageerror', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      try {
        for (const badPath of [
          '/guides/non-existent-slug',
          '/zh/guides/non-existent-slug',
          '/guides/GEO-CITATION-VS-MENTION',
        ]) {
          const res = await page.goto(badPath, { waitUntil: 'domcontentloaded' });
          expect(res?.status(), `GET ${badPath} must return HTTP 404`).toBe(404);
        }
        expect(
          pageErrors,
          `Unexpected pageerrors on 404 guide routes: ${pageErrors.join(' | ')}`,
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test('T2.2 Honeypot silent drop returns HTTP 200 accepted with zero DB persistence', async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'honeypot');
      const trapEmail = `${tag}@e2e.example`;

      const res = await requestV2<{ accepted: boolean; id?: string }>('/public/leads', {
        method: 'POST',
        body: {
          locale: 'en',
          name: `Bot ${tag}`,
          email: trapEmail,
          companyBrand: `TrapBrand ${tag}`,
          websiteUrl: 'https://trap.example',
          targetMarket: 'GLOBAL',
          honeypot: 'bot-trap-value',
        },
      });

      expect(res.status).toBe(200);
      expect(res.envelope.code).toBe(0);
      expect(res.envelope.data.accepted).toBe(true);
      expect(res.envelope.data.id ?? undefined).toBeUndefined();

      const admin = getAdminSession();
      const list = await queryAdminLeadsApi(admin.accessToken, { keyword: trapEmail });
      expect(list.items, 'Honeypot lead must NOT be persisted in DB').toHaveLength(0);
      expect(list.total).toBe(0);
    });

    test('T2.4 Admin leads RBAC isolation (401 anon, 404 merchant), PATCH validation, and zero IP/hash DTO leakage', async ({}, testInfo) => {
      // Unauthenticated -> 401 / 40101
      const anonGet = await requestV1('/admin/leads', { method: 'GET' });
      expect(anonGet.status).toBe(401);
      expect(anonGet.envelope.code).toBe(40101);

      const anonPatch = await requestV1('/admin/leads/nonexistent', {
        method: 'PATCH',
        body: { status: 'CONTACTED' },
      });
      expect(anonPatch.status).toBe(401);
      expect(anonPatch.envelope.code).toBe(40101);

      // Authenticated non-admin MERCHANT -> 404 / 40401 (never 403)
      const demo = getDemoSession();
      const merchantGet = await requestV1('/admin/leads', {
        method: 'GET',
        token: demo.accessToken,
      });
      expect(merchantGet.status).toBe(404);
      expect(merchantGet.envelope.code).toBe(40401);

      const merchantPatch = await requestV1('/admin/leads/nonexistent', {
        method: 'PATCH',
        token: demo.accessToken,
        body: { status: 'CONTACTED' },
      });
      expect(merchantPatch.status).toBe(404);
      expect(merchantPatch.envelope.code).toBe(40401);

      // Admin PATCH validation & missing ID checks
      const admin = getAdminSession();
      const emptyPatch = await requestV1('/admin/leads/nonexistent', {
        method: 'PATCH',
        token: admin.accessToken,
        body: {},
      });
      expect(emptyPatch.status).toBe(400);
      expect(emptyPatch.envelope.code).toBe(40001);

      const badStatusPatch = await requestV1('/admin/leads/nonexistent', {
        method: 'PATCH',
        token: admin.accessToken,
        body: { status: 'INVALID_STATUS' },
      });
      expect(badStatusPatch.status).toBe(400);
      expect(badStatusPatch.envelope.code).toBe(40001);

      const missingIdPatch = await requestV1('/admin/leads/nonexistent-lead-id-404', {
        method: 'PATCH',
        token: admin.accessToken,
        body: { status: 'CONTACTED' },
      });
      expect(missingIdPatch.status).toBe(404);
      expect(missingIdPatch.envelope.code).toBe(40401);

      // Admin GET & PATCH DTO privacy: self-seed 1 lead if DB has none so T2.4 passes standalone
      let list = await queryAdminLeadsApi(admin.accessToken, { pageSize: 20 });
      if (list.items.length === 0) {
        const tag = uniqueTag(testInfo, 'rbacdto');
        const seedEmail = `${tag}@e2e.example`;
        const seedRes = await requestV2<{ accepted: boolean; id?: string }>('/public/leads', {
          method: 'POST',
          body: {
            locale: 'en',
            name: `RBAC Seed ${tag}`,
            email: seedEmail,
            companyBrand: `RbacSeedBrand ${tag}`,
            targetMarket: 'GLOBAL',
          },
        });
        expect(seedRes.status, 'Self-seeding lead for standalone T2.4 must return 200').toBe(200);
        expect(seedRes.envelope.code).toBe(0);
        expect(seedRes.envelope.data.accepted).toBe(true);
        list = await queryAdminLeadsApi(admin.accessToken, { keyword: seedEmail });
      }

      expect(
        list.items.length,
        'Expected at least one lead to verify Admin DTO privacy',
      ).toBeGreaterThan(0);
      for (const item of list.items) {
        assertNoForbiddenLeadDtoKeys(item, 'GET /api/v1/admin/leads item');
      }

      // Also verify PATCH /api/v1/admin/leads/:id response DTO never leaks IP or hash fields
      const targetLead = list.items[0];
      const patchRes = await requestV1<Record<string, unknown>>(`/admin/leads/${targetLead.id}`, {
        method: 'PATCH',
        token: admin.accessToken,
        body: { adminNote: targetLead.adminNote ?? 'e2e-dto-privacy-check' },
      });
      expect(patchRes.status).toBe(200);
      expect(patchRes.envelope.code).toBe(0);
      const patchedDto = unwrapOk(patchRes, `PATCH /admin/leads/${targetLead.id}`);
      assertNoForbiddenLeadDtoKeys(patchedDto, 'PATCH /api/v1/admin/leads/:id');
    });

    test('T2.5 Tampered /demo and /zh/demo query parameters resist XSS execution and NaN injection', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        const tamperedUrls = [
          '/demo?estimatedPts=NaN&monthlyGoal=%3Cscript%3Ewindow.__geomixXss%3D1%3C%2Fscript%3E&targetMarket=INVALID',
          '/zh/demo?estimatedPts=-999&monthlyGoal=%3Cimg%20src%3Dx%20onerror%3Dwindow.__geomixXss%3D1%3E',
        ];

        for (const url of tamperedUrls) {
          const res = await page.goto(url, { waitUntil: 'load' });
          expect(res?.status(), `GET ${url} must still render HTTP 200`).toBe(200);

          // Wait for interactive hydration of the demo form before inspecting DOM & values
          const nameField = page
            .locator(
              'main form input[name="name"], main form input:not([name="honeypot"]):not([type="hidden"])',
            )
            .first();
          await expect(nameField).toBeVisible();
          await expect(nameField).toBeEditable();

          const xssMarker = await page.evaluate(
            () => (window as unknown as { __geomixXss?: unknown }).__geomixXss,
          );
          expect(xssMarker, `XSS payload executed on ${url}`).toBeUndefined();

          const domAudit = await page.evaluate(() => {
            const inputs = Array.from(
              document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                'main form input, main form textarea, main form select',
              ),
            );
            const checkedRadios = Array.from(
              document.querySelectorAll<HTMLInputElement>('main form input[type="radio"]:checked'),
            ).map((el) => el.value);
            const injectedImgCount = document.querySelectorAll('main img[src="x"]').length;
            const unexpectedScripts = Array.from(document.querySelectorAll('main script')).filter(
              (script) =>
                (script.getAttribute('type') ?? '').toLowerCase() !== 'application/ld+json',
            ).length;

            return {
              values: inputs.map((el) => el.value),
              checkedRadios,
              injectedImgCount,
              unexpectedScripts,
              mainText: (document.querySelector('main')?.innerText ?? '').trim(),
            };
          });

          expect(
            domAudit.injectedImgCount,
            `Injected <img src="x"> must not appear in DOM on ${url}`,
          ).toBe(0);
          expect(
            domAudit.unexpectedScripts,
            `Unexpected <script> tag must not appear inside <main> on ${url}`,
          ).toBe(0);

          for (const val of domAudit.values) {
            expect(val, `Form value on ${url} must not contain NaN`).not.toContain('NaN');
            expect(val, `Form value on ${url} must not contain -999`).not.toContain('-999');
            expect(
              val.trim().toUpperCase(),
              `Form value on ${url} must not accept INVALID targetMarket`,
            ).not.toBe('INVALID');
          }
          for (const radioVal of domAudit.checkedRadios) {
            expect(radioVal.trim().toUpperCase()).not.toBe('INVALID');
          }
          expect(
            domAudit.mainText.includes('NaN'),
            `Page text on ${url} must not contain NaN anywhere`,
          ).toBe(false);
          expect(
            domAudit.mainText.includes('-999'),
            `Page text on ${url} must not render negative -999 estimate`,
          ).toBe(false);
        }

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T2.6 Responsive layout & runtime hygiene across desktop (1440x900) and mobile (390x844)', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      const routesToCheck = [
        '/',
        '/zh',
        '/pricing',
        '/zh/pricing',
        '/guides',
        '/guides/geo-citation-vs-mention',
        '/demo',
        '/zh/demo',
      ];

      try {
        for (const route of routesToCheck) {
          const res = await page.goto(route, { waitUntil: 'domcontentloaded' });
          expect(res?.status(), `GET ${route} must return 200`).toBe(200);
          await assertNoHorizontalOverflow(page, {
            viewports: [MARKETING_VIEWPORTS.desktop, MARKETING_VIEWPORTS.mobile],
          });
        }
        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });
  },
);

// ============================================================================
// TIER 3 — Cross-Feature Combinations
// ============================================================================

test.describe(
  'Marketing Site — Tier 3: Cross-Feature Combinations',
  { tag: ['@marketing', '@tier3'] },
  () => {
    test('T3.1 Bilingual EN | 中文 header switcher preserves exact subpath bidirectionally and updates canonical', async ({
      browser,
    }) => {
      const origin = getMarketingOrigin();
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      const pairs: ReadonlyArray<{ en: string; zh: string }> = [
        { en: '/', zh: '/zh' },
        { en: '/pricing', zh: '/zh/pricing' },
        { en: '/guides', zh: '/zh/guides' },
        {
          en: '/guides/llms-txt-and-jsonld-playbook',
          zh: '/zh/guides/llms-txt-and-jsonld-playbook',
        },
        { en: '/demo', zh: '/zh/demo' },
      ];

      try {
        for (const pair of pairs) {
          // EN -> ZH
          await page.goto(pair.en, { waitUntil: 'domcontentloaded' });
          expect(new URL(page.url()).pathname).toBe(pair.en);

          await clickHeaderLocaleSwitcher(page, 'zh-CN');
          await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(pair.zh);

          const expectedZhCanonical = normalizeSeoUrl(expectedCanonicalUrl(origin, pair.zh));
          await expect
            .poll(
              async () => {
                const seo = await extractHeadSeo(page);
                return seo.canonical ? normalizeSeoUrl(seo.canonical) : null;
              },
              { timeout: 10_000 },
            )
            .toBe(expectedZhCanonical);
          await expect
            .poll(async () => (await extractHeadSeo(page)).hasZhLangScope, { timeout: 10_000 })
            .toBe(true);

          // ZH -> EN
          await clickHeaderLocaleSwitcher(page, 'en');
          await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(pair.en);

          const expectedEnCanonical = normalizeSeoUrl(expectedCanonicalUrl(origin, pair.en));
          await expect
            .poll(
              async () => {
                const seo = await extractHeadSeo(page);
                return seo.canonical ? normalizeSeoUrl(seo.canonical) : null;
              },
              { timeout: 10_000 },
            )
            .toBe(expectedEnCanonical);
          await expect
            .poll(async () => (await extractHeadSeo(page)).htmlLang.toLowerCase(), {
              timeout: 10_000,
            })
            .toMatch(/^en(?:-|$)/);
        }

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T3.2 Auth-aware header updates CTA without forced redirect from / or /zh while /login still redirects to /home', async ({
      browser,
    }) => {
      // Part 1: Verify anonymous header CTA in both EN (Sign In -> /login) and ZH (登录 -> /login)
      const anonContext = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const anonPage = await anonContext.newPage();
      const anonCollector = attachErrorCollector(anonPage);

      try {
        const anonEnRes = await anonPage.goto('/', { waitUntil: 'domcontentloaded' });
        expect(anonEnRes?.status()).toBe(200);
        const anonEnCta = getHeaderAuthCta(anonPage);
        await expect(anonEnCta).toBeVisible();
        await expect(anonEnCta).toContainText(/Sign In/i);
        await expect(anonEnCta).toHaveAttribute('href', '/login');

        const anonZhRes = await anonPage.goto('/zh', { waitUntil: 'domcontentloaded' });
        expect(anonZhRes?.status()).toBe(200);
        const anonZhCta = getHeaderAuthCta(anonPage);
        await expect(anonZhCta).toBeVisible();
        await expect(anonZhCta).toContainText(/登录/);
        await expect(anonZhCta).toHaveAttribute('href', '/login');

        assertNoConsoleOrPageErrors(anonCollector);
      } finally {
        await anonContext.close();
      }

      // Part 2: Authenticated user stays on / and /zh with Enter Console / 进入控制台 CTA -> /home
      const demo = getDemoSession();
      const { context, page } = await createAuthenticatedContext(browser, demo, {
        viewport: MARKETING_VIEWPORTS.desktop,
      });
      const collector = attachErrorCollector(page);

      try {
        // Logged-in visit to /: wait for auth-aware CTA hydration FIRST, then verify no forced redirect
        const rootRes = await page.goto('/', { waitUntil: 'domcontentloaded' });
        expect(rootRes?.status()).toBe(200);

        const enAuthCta = getHeaderAuthCta(page);
        await expect(enAuthCta).toBeVisible();
        await expect(enAuthCta).toContainText(/Enter Console/i, { timeout: 10_000 });
        expect(new URL(page.url()).pathname).toBe('/');
        const enHref = await enAuthCta.getAttribute('href');
        if (enHref !== null) {
          expect(enHref).toBe('/home');
        }

        await enAuthCta.click();
        await expect(page).toHaveURL(/\/home(?:\?|$)/, { timeout: 15_000 });

        // Logged-in visit to /zh: wait for auth-aware CTA hydration FIRST, then verify no redirect & click to /home
        const zhRes = await page.goto('/zh', { waitUntil: 'domcontentloaded' });
        expect(zhRes?.status()).toBe(200);

        const zhAuthCta = getHeaderAuthCta(page);
        await expect(zhAuthCta).toBeVisible();
        await expect(zhAuthCta).toContainText(/进入控制台/, { timeout: 10_000 });
        expect(new URL(page.url()).pathname).toBe('/zh');
        const zhHref = await zhAuthCta.getAttribute('href');
        if (zhHref !== null) {
          expect(zhHref).toBe('/home');
        }

        await zhAuthCta.click();
        await expect(page).toHaveURL(/\/home(?:\?|$)/, { timeout: 15_000 });

        // Logged-in visit to /login still auto-redirects to /home
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/home(?:\?|$)/, { timeout: 15_000 });

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T3.3 /pricing calculator handoff prefills /demo (EN & ZH) and persists estimatedPts to DB', async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);
      const tag = uniqueTag(testInfo, 'handoff');
      const leadEmail = `${tag}@e2e.example`;

      try {
        // EN /pricing -> 3 samples (1168 pts) -> /demo -> submit -> verify persisted estimatedPts === 1168
        await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
        expect(await readCalculatorTotalPoints(page)).toBe(464);

        await setCalculatorSamples(page, 3);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(1168);

        await clickPricingHandoffCta(page, 'en');
        await expect(page).toHaveURL(/\/demo(?:\?|$)/, { timeout: 10_000 });

        const demoUrl = new URL(page.url());
        const demoBodyText = ((await page.locator('main').textContent()) ?? '').trim();
        expect(
          demoUrl.search.includes('1168') || demoBodyText.replace(/,/g, '').includes('1168'),
          `/demo should carry calculator estimate 1168 (url=${page.url()})`,
        ).toBe(true);

        const submitResult = await fillAndSubmitDemoForm(page, {
          name: `Handoff ${tag}`,
          email: leadEmail,
          companyBrand: `CalcBrand ${tag}`,
          websiteUrl: 'https://calcbrand.example',
          targetMarket: 'GLOBAL',
        });

        expect(submitResult.status).toBe(200);
        expect(submitResult.envelope.code).toBe(0);
        await expect(page.getByTestId('demo-submit-success')).toBeVisible();

        const admin = getAdminSession();
        const leads = await queryAdminLeadsApi(admin.accessToken, { keyword: leadEmail });
        const persisted = leads.items.find((item) => item.email === leadEmail);
        expect(persisted, `Expected lead ${leadEmail} in admin leads API`).toBeTruthy();
        expect(persisted?.estimatedPts).toBe(1168);

        // ZH /zh/pricing -> 3 samples (1168 pts) -> /zh/demo stays in ZH locale with estimate carried
        await page.goto('/zh/pricing', { waitUntil: 'domcontentloaded' });
        await setCalculatorSamples(page, 3);
        await expect.poll(() => readCalculatorTotalPoints(page), { timeout: 5_000 }).toBe(1168);

        await clickPricingHandoffCta(page, 'zh-CN');
        await expect(page).toHaveURL(/\/zh\/demo(?:\?|$)/, { timeout: 10_000 });

        const zhDemoUrl = new URL(page.url());
        const zhDemoText = ((await page.locator('main').textContent()) ?? '').trim();
        expect(
          zhDemoUrl.search.includes('1168') || zhDemoText.replace(/,/g, '').includes('1168'),
          `/zh/demo should carry calculator estimate 1168 (url=${page.url()})`,
        ).toBe(true);

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T3.4 Legacy /dashboard route still 307-redirects to /home', async () => {
      const webBase = getMarketingWebBase();
      const res = await fetch(`${webBase}/dashboard`, { redirect: 'manual' });
      expect(res.status).toBe(307);
      const location = res.headers.get('location') ?? '';
      expect(location).toMatch(/(?:^|\/)\bhome\b(?:[?#]|$)/);
    });
  },
);

// ============================================================================
// TIER 4 — Real-World End-to-End Application Scenarios
// ============================================================================

test.describe(
  'Marketing Site — Tier 4: Real-World End-to-End Scenarios',
  { tag: ['@marketing', '@tier4'] },
  () => {
    test('T4.1 Full Global English buyer journey -> Admin lead triage & provisioning handoff', async ({
      browser,
    }, testInfo) => {
      const tag = uniqueTag(testInfo, 'e2eglobal');
      const buyerEmail = `${tag}@e2e.example`;
      const buyerBrand = `NorthPeak ${tag}`;
      const adminNoteText = `Provisioned 1000pt demo tenant for ${tag}`;

      // Part 1: Anonymous Global buyer journey
      const buyerContext = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const buyerPage = await buyerContext.newPage();
      const buyerErrors = attachErrorCollector(buyerPage);

      try {
        await buyerPage.goto('/', { waitUntil: 'domcontentloaded' });
        expect(new URL(buyerPage.url()).pathname).toBe('/');

        // Explore 3-tab sandbox
        const sandboxTablist = await locateSandboxTablist(buyerPage, '/');
        const tabs = sandboxTablist.getByRole('tab');
        await expect(tabs).toHaveCount(3);
        await tabs.nth(1).click();
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
        await tabs.nth(2).click();
        await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');

        // Navigate via header to /pricing
        const pricingNavLink = buyerPage
          .locator('header a[href="/pricing"]')
          .or(buyerPage.locator('header').getByRole('link', { name: /Pricing/i }))
          .first();
        await expect(pricingNavLink).toBeVisible();
        await pricingNavLink.click();
        await expect(buyerPage).toHaveURL(/\/pricing(?:[?#]|$)/);

        // Configure calculator: toggle auto-retest OFF -> 272 pts
        expect(await readCalculatorTotalPoints(buyerPage)).toBe(464);
        await setCalculatorAutoRetest(buyerPage, false);
        await expect.poll(() => readCalculatorTotalPoints(buyerPage), { timeout: 5_000 }).toBe(272);

        // Handoff to /demo & submit lead
        await clickPricingHandoffCta(buyerPage, 'en');
        await expect(buyerPage).toHaveURL(/\/demo(?:\?|$)/);

        const submission = await fillAndSubmitDemoForm(buyerPage, {
          name: `Jordan ${tag}`,
          email: buyerEmail,
          companyBrand: buyerBrand,
          websiteUrl: 'https://northpeak.example/docs',
          targetMarket: 'GLOBAL',
          notes: 'Looking to establish Global citation baselines across ChatGPT & Perplexity.',
        });

        expect(submission.status).toBe(200);
        expect(submission.envelope.code).toBe(0);
        await expect(buyerPage.getByTestId('demo-submit-success')).toBeVisible();

        assertNoConsoleOrPageErrors(buyerErrors);
      } finally {
        await buyerContext.close();
      }

      // Part 2: Admin triage on /admin/leads -> status updates -> reload persistence -> /admin/tenants handoff
      const admin = getAdminSession();
      const { context: adminContext, page: adminPage } = await createAuthenticatedContext(
        browser,
        admin,
        { viewport: MARKETING_VIEWPORTS.desktop },
      );
      const adminErrors = attachErrorCollector(adminPage);

      try {
        await adminPage.goto('/admin/leads', { waitUntil: 'domcontentloaded' });

        // Admin nav contains 试用线索
        const adminNav = adminPage.locator('nav[aria-label="管理菜单"]');
        await expect(adminNav).toBeVisible();
        const leadsNavLink = adminNav.getByRole('link', { name: /试用线索/ });
        await expect(leadsNavLink).toBeVisible();

        // Search & confirm NEW lead with carried estimatedPts === 272
        const leadRow = await searchAdminLeadsInUi(adminPage, buyerEmail);
        await expect(leadRow).toContainText(buyerBrand);
        await expect(leadRow).toContainText(new RegExp(`${LEAD_STATUS_LABELS.NEW}|NEW`));
        await expect(leadRow).toContainText(/272/);

        // Transition NEW -> CONTACTED and confirm visible UI state before next transition
        await updateAdminLeadStatusAndNoteInUi(adminPage, leadRow, {
          status: 'CONTACTED',
        });
        const contactedRow = await searchAdminLeadsInUi(adminPage, buyerEmail);
        await expect(
          contactedRow,
          'Row must visibly display 已联系 (CONTACTED) before transitioning to TRIAL_PROVISIONED',
        ).toContainText(new RegExp(`${LEAD_STATUS_LABELS.CONTACTED}|CONTACTED`));

        // Transition CONTACTED -> TRIAL_PROVISIONED + save adminNote
        await updateAdminLeadStatusAndNoteInUi(adminPage, contactedRow, {
          status: 'TRIAL_PROVISIONED',
          adminNote: adminNoteText,
        });

        // Reload /admin/leads and verify persistence in UI
        await adminPage.reload({ waitUntil: 'domcontentloaded' });
        const reloadedRow = await searchAdminLeadsInUi(adminPage, buyerEmail);
        await expect(reloadedRow).toContainText(
          new RegExp(`${LEAD_STATUS_LABELS.TRIAL_PROVISIONED}|TRIAL_PROVISIONED`),
        );

        // Cross-check via Admin API
        const apiLeads = await queryAdminLeadsApi(admin.accessToken, { keyword: buyerEmail });
        const persisted: MarketingLeadDto | undefined = apiLeads.items.find(
          (item) => item.email === buyerEmail,
        );
        expect(persisted, `Lead ${buyerEmail} must exist in GET /api/v1/admin/leads`).toBeTruthy();
        expect(persisted?.status).toBe('TRIAL_PROVISIONED');
        expect(persisted?.adminNote).toBe(adminNoteText);
        expect(persisted?.estimatedPts).toBe(272);
        expect(persisted?.locale).toBe('en');
        expect(persisted?.targetMarket).toBe('GLOBAL');

        // In-page quick navigation link to /admin/tenants inside <main> works (no sidebar fallback)
        const tenantsQuickLink = adminPage.locator('main a[href^="/admin/tenants"]').first();
        await expect(
          tenantsQuickLink,
          '/admin/leads must expose an in-page quick link to /admin/tenants',
        ).toBeVisible();
        await tenantsQuickLink.click();
        await expect(adminPage).toHaveURL(/\/admin\/tenants(?:\?|$)/, { timeout: 15_000 });

        assertNoConsoleOrPageErrors(adminErrors);
      } finally {
        await adminContext.close();
      }
    });

    test('T4.2 Full Chinese brand buyer journey (/zh -> /zh/guides -> guide detail -> /zh/demo) and Admin verification', async ({
      browser,
    }, testInfo) => {
      const tag = uniqueTag(testInfo, 'e2ezh');
      const zhEmail = `${tag}@e2e.example`;
      const zhBrand = `星澜声学 ${tag}`;
      const zhNotes = `希望在豆包与 DeepSeek 提升信源引用占比 (${tag})`;

      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        // 1. Land on /zh and toggle hero engine strip to CN
        const zhRes = await page.goto('/zh', { waitUntil: 'domcontentloaded' });
        expect(zhRes?.status()).toBe(200);
        await verifyHeroEngineStripToggle(page, '/zh');

        // 2. Navigate to /zh/guides -> open llms-txt-and-jsonld-playbook
        const guidesNav = page
          .locator('header a[href="/zh/guides"]')
          .or(page.locator('header').getByRole('link', { name: /指南|Guides/i }))
          .first();
        await expect(guidesNav).toBeVisible();
        await guidesNav.click();
        await expect(page).toHaveURL(/\/zh\/guides(?:[?#]|$)/);

        const guideLink = page
          .locator('main a[href="/zh/guides/llms-txt-and-jsonld-playbook"]')
          .first();
        await expect(guideLink).toBeVisible();
        await guideLink.click();
        await expect(page).toHaveURL(/\/zh\/guides\/llms-txt-and-jsonld-playbook(?:[?#]|$)/);
        await expect(page.locator('h1').first()).toContainText(
          'AI 可抓取工程指南：robots.txt、JSON-LD 与 llms.txt',
        );

        // 3. Navigate to /zh/demo and submit Chinese lead
        const demoCta = page.locator('header a[href="/zh/demo"], main a[href^="/zh/demo"]').first();
        await expect(demoCta).toBeVisible();
        await demoCta.click();
        await expect(page).toHaveURL(/\/zh\/demo(?:[?#]|$)/);

        const submission = await fillAndSubmitDemoForm(page, {
          name: `陈明 ${tag}`,
          email: zhEmail,
          companyBrand: zhBrand,
          websiteUrl: 'https://xinglan.example',
          targetMarket: 'CN',
          monthlyGoal: '每月 10 篇技术专栏与 30 问句复测',
          notes: zhNotes,
        });

        expect(submission.status).toBe(200);
        expect(submission.envelope.code).toBe(0);
        await expect(page.getByTestId('demo-submit-success')).toBeVisible();

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }

      // Verify persisted Chinese lead in Admin UI & Admin API
      const admin = getAdminSession();
      const { context: adminContext, page: adminPage } = await createAuthenticatedContext(
        browser,
        admin,
        { viewport: MARKETING_VIEWPORTS.desktop },
      );
      const adminErrors = attachErrorCollector(adminPage);

      try {
        await adminPage.goto('/admin/leads', { waitUntil: 'domcontentloaded' });
        const zhRow = await searchAdminLeadsInUi(adminPage, zhEmail);
        await expect(zhRow).toContainText(zhBrand);

        const apiLeads = await queryAdminLeadsApi(admin.accessToken, { keyword: zhEmail });
        const persisted = apiLeads.items.find((item) => item.email === zhEmail);
        expect(persisted, `Chinese lead ${zhEmail} must be persisted`).toBeTruthy();
        expect(persisted?.locale).toBe('zh-CN');
        expect(persisted?.targetMarket).toBe('CN');
        expect(persisted?.companyBrand).toBe(zhBrand);
        expect(persisted?.notes).toBe(zhNotes);

        assertNoConsoleOrPageErrors(adminErrors);
      } finally {
        await adminContext.close();
      }
    });

    test('T4.3 Search & AI crawler full audit journey (/robots.txt -> /sitemap.xml -> /llms.txt -> crawl every <loc>)', async () => {
      const webBase = getMarketingWebBase();
      const origin = getMarketingOrigin();

      // 1. Fetch /robots.txt & parse Sitemap URL
      const robotsRes = await fetch(`${webBase}/robots.txt`);
      expect(robotsRes.status).toBe(200);
      const robots = parseRobotsTxt(await robotsRes.text());
      expect(robots.sitemaps.length).toBeGreaterThan(0);

      const sitemapUrl = robots.sitemaps[0];
      expect(sitemapUrl).toBe(`${origin}/sitemap.xml`);

      // 2. Fetch sitemap XML (resolve host to local webBase if PUBLIC_APP_URL differs in custom setups)
      const sitemapFetchUrl = `${webBase}${new URL(sitemapUrl).pathname}`;
      const sitemapRes = await fetch(sitemapFetchUrl);
      expect(sitemapRes.status).toBe(200);
      const sitemap = parseSitemapXml(await sitemapRes.text());
      expect(sitemap.locs.length).toBeGreaterThanOrEqual(16);

      const hasEnLocs = sitemap.locs.some((loc) => !new URL(loc).pathname.startsWith('/zh'));
      const hasZhLocs = sitemap.locs.some((loc) => new URL(loc).pathname.startsWith('/zh'));
      expect(hasEnLocs && hasZhLocs, 'sitemap.xml must cover both EN and ZH routes').toBe(true);

      // 3. Fetch /llms.txt
      const llmsRes = await fetch(`${webBase}/llms.txt`);
      expect(llmsRes.status).toBe(200);
      expect(llmsRes.headers.get('content-type') ?? '').toMatch(/text\/plain.*charset=utf-8/i);
      assertValidLlmsTxt(await llmsRes.text(), 'GeoMix');

      // 4. Crawl EVERY <loc> URL from sitemap.xml
      const crawled = new Set<string>();
      for (const loc of sitemap.locs) {
        const normalizedLoc = normalizeSeoUrl(loc);
        if (crawled.has(normalizedLoc)) {
          continue;
        }
        crawled.add(normalizedLoc);

        const locUrl = new URL(normalizedLoc);
        const fetchTarget = `${webBase}${locUrl.pathname}${locUrl.search}`;

        const pageRes = await fetch(fetchTarget);
        expect(pageRes.status, `Crawler GET ${normalizedLoc} must return HTTP 200`).toBe(200);
        const html = await pageRes.text();
        const seo = extractHtmlSeoFromMarkup(html);

        expect(
          seo.canonical,
          `Crawler ${normalizedLoc}: missing <link rel="canonical">`,
        ).toBeTruthy();
        expect(
          normalizeSeoUrl(seo.canonical!),
          `Crawler ${normalizedLoc}: canonical must self-reference`,
        ).toBe(normalizedLoc);
        expect(seo.alternates.en, `Crawler ${normalizedLoc}: missing hreflang="en"`).toBeTruthy();
        expect(
          seo.alternates['zh-CN'],
          `Crawler ${normalizedLoc}: missing hreflang="zh-CN"`,
        ).toBeTruthy();
        expect(
          seo.alternates['x-default'],
          `Crawler ${normalizedLoc}: missing hreflang="x-default"`,
        ).toBeTruthy();
        expect(
          normalizeSeoUrl(seo.alternates['x-default']!),
          `Crawler ${normalizedLoc}: hreflang="x-default" must equal hreflang="en"`,
        ).toBe(normalizeSeoUrl(seo.alternates.en!));
        expect(
          seo.jsonLdRawScripts.length,
          `Crawler ${normalizedLoc}: must include at least one JSON-LD script`,
        ).toBeGreaterThan(0);

        for (const rawJsonLd of seo.jsonLdRawScripts) {
          assertValidJsonLd(rawJsonLd);
        }
      }

      expect(crawled.size).toBeGreaterThanOrEqual(16);
    });
  },
);

// ============================================================================
// TIER 5 — White-Box Adversarial Hardening (Exhaustive Sandbox, Mobile Drawer
// & Heavy Guide Overflow, /admin/leads Production Ops Flows)
// ============================================================================

test.describe(
  'Marketing Site — Tier 5: White-Box Adversarial Hardening',
  { tag: ['@marketing', '@tier5'] },
  () => {
    test('T5.1 Exhaustive Tab 2 Preflight Gate across all 3 toggles, GLOBAL <-> CN track switching, exact score/finding deltas, and valid aria-controls', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
        expect(res?.status()).toBe(200);

        const assertNoDanglingAriaControls = async (label: string) => {
          const dangling = await page.evaluate(() => {
            const bad: string[] = [];
            for (const el of Array.from(document.querySelectorAll('[aria-controls]'))) {
              const targetId = el.getAttribute('aria-controls');
              if (!targetId || !document.getElementById(targetId)) {
                bad.push(`${el.tagName}#${el.id || '(no-id)'} -> ${String(targetId)}`);
              }
            }
            return bad;
          });
          expect(
            dangling,
            `${label}: every [aria-controls] must point to a mounted DOM ID`,
          ).toEqual([]);
        };

        await assertNoDanglingAriaControls('initial Tab 1');

        const tablist = await locateSandboxTablist(page, '/');
        const tabs = tablist.getByRole('tab');
        await expect(tabs).toHaveCount(3);
        await tabs.nth(1).click();
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
        await assertNoDanglingAriaControls('after switching to Tab 2');

        const scoreEl = page.getByTestId('sandbox-geo-score');
        const gateEl = page.getByTestId('sandbox-gate-status');
        const findingsEl = page.getByTestId('sandbox-preflight-findings');
        const tbdBtn = page.getByTestId('sandbox-toggle-tbd');
        const hypeBtn = page.getByTestId('sandbox-toggle-hype');
        const cjkBtn = page.getByTestId('sandbox-toggle-cjk');

        // Clean GLOBAL baseline: 100 / PASS
        await expect(scoreEl).toHaveText('100');
        await expect(gateEl).toContainText('PASS');

        // Toggle 1: [TBD: runtime] -> 93 / BLOCKED / MISSING_FACT_SLOTS
        await tbdBtn.click();
        await expect(scoreEl).toHaveText('93');
        await expect(gateEl).toContainText('BLOCKED');
        await expect(findingsEl).toContainText('MISSING_FACT_SLOTS');
        await expect(findingsEl).toContainText('[TBD: runtime]');

        // Toggle 2: Exaggerated/prohibited claim -> 89 / COMPLIANCE_BLOCKED + GLOBAL_CLAIM_WARNING, zero CJK leak
        await hypeBtn.click();
        await expect(scoreEl).toHaveText('89');
        await expect(findingsEl).toContainText('COMPLIANCE_BLOCKED');
        await expect(findingsEl).toContainText('GLOBAL_CLAIM_WARNING');
        const enFindingsText = (await findingsEl.textContent()) ?? '';
        expect(enFindingsText, 'EN preflight findings must not leak CJK text').not.toMatch(
          /[\u4e00-\u9fff]/,
        );

        // Toggle 3: CJK leak on GLOBAL -> GLOBAL_CJK_LEAK
        await cjkBtn.click();
        await expect(findingsEl).toContainText('GLOBAL_CJK_LEAK');

        // Switch to CN · WordPress -> cjk toggle disabled, GLOBAL_CJK_LEAK disappears, TBD & COMPLIANCE remain
        await page.getByRole('button', { name: 'CN · WordPress' }).click();
        await expect(cjkBtn).toBeDisabled();
        await expect(findingsEl).not.toContainText('GLOBAL_CJK_LEAK');
        await expect(findingsEl).toContainText('MISSING_FACT_SLOTS');
        await expect(findingsEl).toContainText('COMPLIANCE_BLOCKED');

        // Toggle TBD and hype OFF -> exact restoration to 100 / PASS
        await tbdBtn.click();
        await hypeBtn.click();
        await expect(scoreEl).toHaveText('100');
        await expect(gateEl).toContainText('PASS');

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T5.2 Mobile (390x844) drawer a11y + Escape close + heavy code-block guide overflow + EN->ZH locale switch', async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.mobile });
      const page = await context.newPage();
      const collector = attachErrorCollector(page);

      try {
        const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
        expect(res?.status()).toBe(200);
        await assertNoHorizontalOverflow(page, { viewports: [MARKETING_VIEWPORTS.mobile] });

        // Desktop nav hidden; mobile toggle visible with aria-expanded="false" and no dangling aria-controls
        await expect(page.locator('header nav.gm-mkt-nav')).toBeHidden();
        const menuBtn = page.locator('header button[aria-expanded]').first();
        await expect(menuBtn).toBeVisible();
        await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
        expect(await menuBtn.getAttribute('aria-controls')).toBeNull();
        await expect(page.locator('#gm-mkt-mobile-drawer')).toHaveCount(0);

        // Open mobile drawer -> aria-expanded="true", valid aria-controls, visible links, zero overflow
        await menuBtn.click();
        await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
        await expect(menuBtn).toHaveAttribute('aria-controls', 'gm-mkt-mobile-drawer');
        const drawer = page.locator('#gm-mkt-mobile-drawer[role="dialog"]');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('link', { name: /Pricing/i })).toBeVisible();
        await expect(drawer.getByRole('link', { name: /Guides/i })).toBeVisible();
        await expect(drawer.getByRole('link', { name: /Sign In|Enter Console/i })).toBeVisible();
        await expect(drawer.getByRole('link', { name: /Request Demo/i })).toBeVisible();
        await assertNoHorizontalOverflow(page, { viewports: [MARKETING_VIEWPORTS.mobile] });

        // Escape closes drawer and clears aria-controls
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
        expect(await menuBtn.getAttribute('aria-controls')).toBeNull();

        // Heavy code-block guide (/guides/llms-txt-and-jsonld-playbook) has zero mobile overflow
        const guideRes = await page.goto('/guides/llms-txt-and-jsonld-playbook', {
          waitUntil: 'domcontentloaded',
        });
        expect(guideRes?.status()).toBe(200);
        await expect(page.locator('main pre').first()).toBeVisible();
        await assertNoHorizontalOverflow(page, { viewports: [MARKETING_VIEWPORTS.mobile] });

        // Switch EN -> ZH via header switcher and verify /zh/guides/llms-txt-and-jsonld-playbook zero overflow
        await clickHeaderLocaleSwitcher(page, 'zh-CN');
        await expect(page).toHaveURL(/\/zh\/guides\/llms-txt-and-jsonld-playbook(?:[?#]|$)/);
        await expect(page.locator('main pre').first()).toBeVisible();
        await assertNoHorizontalOverflow(page, { viewports: [MARKETING_VIEWPORTS.mobile] });

        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });

    test('T5.3 /admin/leads production ops flows: desktop overflow, status+market filters & reset, inline status select, note clear-to-null, and modal lead switching', async ({
      browser,
    }, testInfo) => {
      const tag = uniqueTag(testInfo, 't5ops');
      const emailGlobal = `${tag}-global@e2e.example`;
      const emailCn = `${tag}-cn@e2e.example`;
      const brandGlobal = `T5Global ${tag}`;
      const brandCn = `T5China ${tag}`;

      // Seed 2 distinct leads (GLOBAL & CN) via public v2 API
      const seedGlobal = await requestV2<{ accepted?: boolean; id?: string }>('/public/leads', {
        method: 'POST',
        body: {
          locale: 'en',
          name: `Ops Global ${tag}`,
          email: emailGlobal,
          companyBrand: brandGlobal,
          websiteUrl: 'https://t5global.example',
          targetMarket: 'GLOBAL',
          notes: 'Global ops test lead',
        },
      });
      expect(seedGlobal.status).toBe(200);

      const seedCn = await requestV2<{ accepted?: boolean; id?: string }>('/public/leads', {
        method: 'POST',
        body: {
          locale: 'zh-CN',
          name: `Ops CN ${tag}`,
          email: emailCn,
          companyBrand: brandCn,
          websiteUrl: 'https://t5cn.example',
          targetMarket: 'CN',
          notes: 'CN ops test lead',
        },
      });
      expect(seedCn.status).toBe(200);

      const admin = getAdminSession();
      const { context, page } = await createAuthenticatedContext(browser, admin, {
        viewport: MARKETING_VIEWPORTS.desktop,
      });
      const collector = attachErrorCollector(page);
      const consoleWarnings: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'warning') {
          consoleWarnings.push(msg.text());
        }
      });

      const selectAntdFilter = async (comboboxAriaLabel: string, optionText: string) => {
        const combobox = page.getByRole('combobox', { name: comboboxAriaLabel });
        const selectBox = combobox.locator(
          'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
        );
        await selectBox.click();
        const dropdown = page
          .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
          .last();
        await expect(dropdown).toBeVisible();
        await dropdown
          .locator('.ant-select-item-option')
          .filter({ hasText: optionText })
          .first()
          .click();
      };

      try {
        await page.goto('/admin/leads', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('main')).toBeVisible();
        await assertNoHorizontalOverflow(page);

        // Search by shared tag so both seeded leads appear
        const searchInput = page.getByRole('textbox', { name: '搜索线索' });
        await searchInput.fill(tag);
        await page.getByRole('button', { name: /搜\s*索/ }).click();
        await expect(page.locator('tbody tr').filter({ hasText: brandGlobal })).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.locator('tbody tr').filter({ hasText: brandCn })).toBeVisible({
          timeout: 15_000,
        });

        // Apply status=NEW (待跟进) + targetMarket=CN (国内市场) filters
        await selectAntdFilter('状态筛选', '待跟进');
        await selectAntdFilter('目标市场筛选', '国内市场');
        await expect(page.locator('tbody tr').filter({ hasText: brandCn })).toBeVisible({
          timeout: 10_000,
        });
        await expect(page.locator('tbody tr').filter({ hasText: brandGlobal })).toHaveCount(0);

        // Click reset (重置筛选) and re-scope by tag
        await page.getByRole('button', { name: '重置筛选' }).click();
        await expect(searchInput).toHaveValue('');
        await searchInput.fill(tag);
        await page.getByRole('button', { name: /搜\s*索/ }).click();
        const globalRow = page.locator('tbody tr').filter({ hasText: brandGlobal }).first();
        const cnRow = page.locator('tbody tr').filter({ hasText: brandCn }).first();
        await expect(globalRow).toBeVisible({ timeout: 15_000 });
        await expect(cnRow).toBeVisible({ timeout: 15_000 });

        // Inline row status <Select>: NEW -> CONTACTED persists
        const inlineCombobox = globalRow.getByRole('combobox', {
          name: `变更状态 ${brandGlobal}`,
        });
        const inlineSelectBox = inlineCombobox.locator(
          'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
        );
        const [inlinePatch] = await Promise.all([
          page.waitForResponse(
            (res) =>
              res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
            { timeout: 15_000 },
          ),
          (async () => {
            await inlineSelectBox.click();
            const dropdown = page
              .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
              .last();
            await expect(dropdown).toBeVisible();
            await dropdown
              .locator('.ant-select-item-option')
              .filter({ hasText: '已联系' })
              .first()
              .click();
          })(),
        ]);
        expect(inlinePatch.status()).toBe(200);
        await expect(globalRow).toContainText('已联系');

        const afterInline = await queryAdminLeadsApi(admin.accessToken, { keyword: emailGlobal });
        expect(afterInline.items.find((item) => item.email === emailGlobal)?.status).toBe(
          'CONTACTED',
        );

        // Set adminNote on Global lead via modal, then reopen and clear to whitespace -> adminNote === null
        await globalRow.getByRole('button', { name: `跟进备注 ${brandGlobal}` }).click();
        const modal1 = page.getByRole('dialog').last();
        await expect(modal1).toBeVisible();
        const note1 = modal1.getByRole('textbox', { name: '管理员跟进备注' });
        await note1.fill(`Initial note ${tag}`);
        const [setNotePatch] = await Promise.all([
          page.waitForResponse(
            (res) =>
              res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
            { timeout: 15_000 },
          ),
          modal1.getByRole('button', { name: /保\s*存/ }).click(),
        ]);
        expect(setNotePatch.status()).toBe(200);
        await expect(modal1).toBeHidden({ timeout: 10_000 });

        await globalRow.getByRole('button', { name: `跟进备注 ${brandGlobal}` }).click();
        const modal2 = page.getByRole('dialog').last();
        await expect(modal2).toBeVisible();
        const note2 = modal2.getByRole('textbox', { name: '管理员跟进备注' });
        await expect(note2).toHaveValue(`Initial note ${tag}`);
        await note2.fill('   ');
        const [clearNotePatch] = await Promise.all([
          page.waitForResponse(
            (res) =>
              res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
            { timeout: 15_000 },
          ),
          modal2.getByRole('button', { name: /保\s*存/ }).click(),
        ]);
        expect(clearNotePatch.status()).toBe(200);
        await expect(modal2).toBeHidden({ timeout: 10_000 });

        const afterClear = await queryAdminLeadsApi(admin.accessToken, { keyword: emailGlobal });
        expect(afterClear.items.find((item) => item.email === emailGlobal)?.adminNote).toBeNull();

        // Modal lead switching: save note on CN lead -> reopen CN lead & edit -> Cancel -> open Global lead (CONTACTED, null note)
        await cnRow.getByRole('button', { name: `跟进备注 ${brandCn}` }).click();
        const cnSaveModal = page.getByRole('dialog').last();
        await expect(cnSaveModal).toBeVisible();
        await cnSaveModal.getByRole('textbox', { name: '管理员跟进备注' }).fill(`CN note ${tag}`);
        const [cnPatch] = await Promise.all([
          page.waitForResponse(
            (res) =>
              res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
            { timeout: 15_000 },
          ),
          cnSaveModal.getByRole('button', { name: /保\s*存/ }).click(),
        ]);
        expect(cnPatch.status()).toBe(200);
        await expect(cnSaveModal).toBeHidden({ timeout: 10_000 });

        // Open CN modal, type unsaved text, Cancel
        await cnRow.getByRole('button', { name: `跟进备注 ${brandCn}` }).click();
        const cnCancelModal = page.getByRole('dialog').last();
        await expect(cnCancelModal).toBeVisible();
        const cnCancelNote = cnCancelModal.getByRole('textbox', { name: '管理员跟进备注' });
        await expect(cnCancelNote).toHaveValue(`CN note ${tag}`);
        await cnCancelNote.fill('Unsaved stale draft');
        await cnCancelModal.getByRole('button', { name: /取\s*消/ }).click();
        await expect(cnCancelModal).toBeHidden({ timeout: 10_000 });

        // Open Global modal -> must show clean CONTACTED status and empty note (no stale draft!)
        await globalRow.getByRole('button', { name: `跟进备注 ${brandGlobal}` }).click();
        const globalCleanModal = page.getByRole('dialog').last();
        await expect(globalCleanModal).toBeVisible();
        await expect(globalCleanModal.getByRole('textbox', { name: '管理员跟进备注' })).toHaveValue(
          '',
        );
        await expect(globalCleanModal).toContainText('已联系');
        await globalCleanModal.getByRole('button', { name: /取\s*消/ }).click();
        await expect(globalCleanModal).toBeHidden({ timeout: 10_000 });

        const formWarnings = consoleWarnings.filter((text) =>
          /useForm|not connected|Warning:/i.test(text),
        );
        expect(formWarnings, 'Admin leads modal switching must emit zero form warnings').toEqual(
          [],
        );
        assertNoConsoleOrPageErrors(collector);
      } finally {
        await context.close();
      }
    });
  },
);

// ============================================================================
// TIER 2 (FINAL SERIAL BLOCK) — Validation Burst & Rate Limiting
// MUST stay LAST in file (after Tier 4) so the shared 127.0.0.1 IP rate-limit
// bucket never poisons legitimate lead-submission tests in Tiers 1–4!
// ============================================================================

test.describe.serial(
  'Marketing Site — Tier 2 (Final): Validation Burst & Rate Limiting',
  { tag: ['@marketing', '@tier2'] },
  () => {
    test('T2.3 Strict validation, SSRF websiteUrl rejection, and server-field smuggling return HTTP 400 (code 40001)', async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'invalid');
      const makeBaseValid = (idx: number) => ({
        locale: 'en',
        name: `Validator ${tag} ${idx}`,
        email: `${tag}-${idx}@e2e.example`,
        companyBrand: `ValidBrand ${tag} ${idx}`,
        targetMarket: 'GLOBAL',
      });

      const invalidCases: Array<{ label: string; body: Record<string, unknown> }> = [
        {
          label: 'missing required fields',
          body: { locale: 'en' },
        },
        {
          label: 'invalid email',
          body: { ...makeBaseValid(1), email: 'not-an-email' },
        },
        {
          label: 'javascript: websiteUrl XSS payload',
          body: { ...makeBaseValid(2), websiteUrl: 'javascript:alert(1)' },
        },
        {
          label: 'loopback IPv4 SSRF websiteUrl',
          body: { ...makeBaseValid(3), websiteUrl: 'http://127.0.0.1/secret' },
        },
        {
          label: 'cloud metadata SSRF websiteUrl',
          body: { ...makeBaseValid(4), websiteUrl: 'http://169.254.169.254/latest/meta-data/' },
        },
        {
          label: 'localhost SSRF websiteUrl',
          body: { ...makeBaseValid(5), websiteUrl: 'http://localhost:3000/admin' },
        },
        {
          label: 'protocol-relative open-redirect sourcePage',
          body: { ...makeBaseValid(6), sourcePage: '//evil.example/phish' },
        },
        {
          label: 'smuggled server-owned fields',
          body: {
            ...makeBaseValid(7),
            status: 'TRIAL_PROVISIONED',
            adminNote: 'hack',
            sourceIpHash: 'fake',
            tenantId: 'seed_tenant_demo',
          },
        },
      ];

      for (const testCase of invalidCases) {
        const res = await requestV2('/public/leads', {
          method: 'POST',
          body: testCase.body,
        });
        expect(res.status, `[${testCase.label}] expected HTTP 400`).toBe(400);
        expect(res.envelope.code, `[${testCase.label}] expected code 40001`).toBe(40001);
        expect(
          typeof res.envelope.msg === 'string' && res.envelope.msg.trim().length > 0,
          `[${testCase.label}] expected non-empty msg`,
        ).toBe(true);
      }
    });

    test('T2.7 Bursting POST /api/v2/public/leads with a dedicated throwaway email triggers HTTP 429 (code 42901)', async ({}, testInfo) => {
      const tag = uniqueTag(testInfo, 'ratelimit');
      const throwawayEmail = `ratelimit-${tag}@e2e.example`;

      let successCount = 0;
      let rateLimited: {
        status: number;
        headers: Headers;
        envelope: { code: number; msg?: string };
      } | null = null;

      for (let attempt = 1; attempt <= 25; attempt += 1) {
        const res = await requestV2<{ accepted?: boolean; id?: string }>('/public/leads', {
          method: 'POST',
          body: {
            locale: 'en',
            name: `Burst User ${attempt}`,
            email: throwawayEmail,
            companyBrand: `BurstBrand ${tag}`,
            targetMarket: 'GLOBAL',
          },
        });

        if (res.status === 429) {
          rateLimited = res;
          break;
        }

        expect(
          res.status,
          `Attempt ${attempt} before rate limit should succeed with HTTP 200`,
        ).toBe(200);
        expect(res.envelope.code).toBe(0);
        expect(res.envelope.data?.accepted).toBe(true);
        successCount += 1;
      }

      expect(
        successCount,
        'At least 1 valid request must succeed before 429 triggers (proving fresh per-email limiting rather than pre-poisoned IP starvation)',
      ).toBeGreaterThanOrEqual(1);
      expect(
        rateLimited,
        `Expected POST /api/v2/public/leads to enforce HTTP 429 within 25 attempts for ${throwawayEmail}`,
      ).not.toBeNull();
      expect(rateLimited!.status).toBe(429);
      expect(rateLimited!.envelope.code).toBe(42901);
      expect(
        typeof rateLimited!.envelope.msg === 'string' &&
          rateLimited!.envelope.msg.trim().length > 0,
        'HTTP 429 response must include a non-empty msg',
      ).toBe(true);

      const retryAfter = rateLimited!.headers.get('retry-after');
      expect(retryAfter, '429 response must include Retry-After header').not.toBeNull();
      expect(retryAfter!.trim(), 'Retry-After header must be a positive integer').toMatch(/^\d+$/);
      expect(Number(retryAfter!.trim()), 'Retry-After must be > 0').toBeGreaterThan(0);
    });

    test(
      'T5.4 Live browser cross-origin 429 + Retry-After UI flow on /demo preserves user inputs',
      { tag: ['@tier5'] },
      async ({ browser }, testInfo) => {
        const tag = uniqueTag(testInfo, 'ui429');
        const throwawayEmail = `ui429-${tag}@e2e.example`;

        // Exhaust the per-email limit (3 valid requests) via server API
        for (let i = 1; i <= 3; i += 1) {
          const seedRes = await requestV2<{ accepted?: boolean; id?: string }>('/public/leads', {
            method: 'POST',
            body: {
              locale: 'en',
              name: `Prefill ${i}`,
              email: throwawayEmail,
              companyBrand: `PrefillCo ${tag}`,
              targetMarket: 'GLOBAL',
            },
          });
          expect(seedRes.status, `Seed request ${i}/3 should succeed`).toBe(200);
        }

        const context = await browser.newContext({ viewport: MARKETING_VIEWPORTS.desktop });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        try {
          const res = await page.goto('/demo', { waitUntil: 'domcontentloaded' });
          expect(res?.status()).toBe(200);

          const enteredName = `Casey ${tag}`;
          const enteredBrand = `RateLimitBrand ${tag}`;
          const enteredNotes = `Preserve these notes across HTTP 429 (${tag})`;

          await page.getByLabel(/Your Name/i).fill(enteredName);
          await page.getByLabel(/Work Email/i).fill(throwawayEmail);
          await page.getByLabel(/Company or Brand Name/i).fill(enteredBrand);
          await page.getByLabel(/Additional Notes/i).fill(enteredNotes);

          const submitBtn = page.locator('main form button[type="submit"]').first();
          const [leadResponse] = await Promise.all([
            page.waitForResponse(
              (r) => r.request().method() === 'POST' && r.url().includes('/api/v2/public/leads'),
              { timeout: 15_000 },
            ),
            submitBtn.click(),
          ]);

          expect(leadResponse.status()).toBe(429);
          const retryAfter = await leadResponse.headerValue('retry-after');
          expect(retryAfter).toMatch(/^\d+$/);
          expect(Number(retryAfter)).toBeGreaterThan(0);

          const errorBanner = page.getByTestId('demo-submit-error');
          await expect(errorBanner).toBeVisible();
          await expect(errorBanner).toContainText(/\d+\s*seconds/i);
          await expect(page.getByTestId('demo-submit-success')).toHaveCount(0);

          // All user-entered form inputs must remain intact
          await expect(page.getByLabel(/Your Name/i)).toHaveValue(enteredName);
          await expect(page.getByLabel(/Work Email/i)).toHaveValue(throwawayEmail);
          await expect(page.getByLabel(/Company or Brand Name/i)).toHaveValue(enteredBrand);
          await expect(page.getByLabel(/Additional Notes/i)).toHaveValue(enteredNotes);

          expect(pageErrors, 'No uncaught page errors expected during 429 UI flow').toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  },
);
