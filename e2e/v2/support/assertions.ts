import { inflateRawSync } from 'node:zlib';
import { expect, type Browser, type Page } from '@playwright/test';
import { injectSessionBeforeLoad } from '../../support/helpers';
import type {
  GeoEvaluationData,
  GeoScoreDetailDto,
  GeoScoreDimensionKey,
  TenantSession,
} from './api-client';
import { computeCrc32 } from './fixtures';

export const VIEWPORT_DESKTOP = { width: 1440, height: 900 } as const;
export const VIEWPORT_COMPACT = { width: 1280, height: 800 } as const;
export const REQUIRED_VIEWPORTS = [VIEWPORT_DESKTOP, VIEWPORT_COMPACT] as const;

export interface ParsedDocxResult {
  entries: Map<string, Buffer>;
  contentTypesXml: string;
  documentXml: string;
}

// ---------- Pure-Node ZIP & OOXML .docx Verification ----------

/**
 * Pure-Node ZIP Central Directory parser supporting Stored (method 0) and
 * Deflated (method 8 via `node:zlib` `inflateRawSync`), with CRC-32 & size checks.
 */
export function parseZipEntries(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 22) {
    throw new Error(`Invalid ZIP: byte length ${bytes.length} < 22`);
  }
  if (bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(
      `Invalid ZIP: missing PK\\x03\\x04 local file header signature (got 0x${bytes.readUInt32LE(0).toString(16)})`,
    );
  }

  let eocdOffset = -1;
  const minPos = Math.max(0, bytes.length - 22 - 65535);
  for (let pos = bytes.length - 22; pos >= minPos; pos -= 1) {
    if (bytes.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = bytes.readUInt16LE(pos + 20);
      if (pos + 22 + commentLen === bytes.length) {
        eocdOffset = pos;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: End of Central Directory (EOCD) signature not found');
  }

  const diskNo = bytes.readUInt16LE(eocdOffset + 4);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const cdSize = bytes.readUInt32LE(eocdOffset + 12);
  const cdOffset = bytes.readUInt32LE(eocdOffset + 16);

  if (diskNo !== 0) {
    throw new Error(`Unsupported multi-disk ZIP (diskNo=${diskNo})`);
  }
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('Unsupported ZIP64 archive');
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error(
      `Corrupt ZIP: central directory [${cdOffset}, ${cdOffset + cdSize}] exceeds EOCD at ${eocdOffset}`,
    );
  }

  const entries = new Map<string, Buffer>();
  let ptr = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < entryCount; i += 1) {
    if (ptr + 46 > cdEnd) {
      throw new Error(`Corrupt ZIP: central directory truncated at entry ${i}`);
    }
    const sig = bytes.readUInt32LE(ptr);
    if (sig !== 0x02014b50) {
      throw new Error(
        `Corrupt ZIP: bad central directory signature 0x${sig.toString(16)} at entry ${i}`,
      );
    }

    const method = bytes.readUInt16LE(ptr + 10);
    const expectedCrc = bytes.readUInt32LE(ptr + 16);
    const compSize = bytes.readUInt32LE(ptr + 20);
    const uncompSize = bytes.readUInt32LE(ptr + 24);
    const nameLen = bytes.readUInt16LE(ptr + 28);
    const extraLen = bytes.readUInt16LE(ptr + 30);
    const commentLen = bytes.readUInt16LE(ptr + 32);
    const localOffset = bytes.readUInt32LE(ptr + 42);

    const name = bytes.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (localOffset + 30 > bytes.length) {
      throw new Error(`Corrupt ZIP: local header out of bounds for ${name}`);
    }
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP: bad local file header signature for ${name}`);
    }
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const localExtraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) {
      throw new Error(`Corrupt ZIP: compressed data out of bounds for ${name}`);
    }

    const rawSlice = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(rawSlice);
    } else if (method === 8) {
      content = inflateRawSync(rawSlice);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (content.length !== uncompSize) {
      throw new Error(
        `Corrupt ZIP: size mismatch for ${name} (expected ${uncompSize}, got ${content.length})`,
      );
    }
    const actualCrc = computeCrc32(content);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `Corrupt ZIP: CRC-32 mismatch for ${name} (expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`,
      );
    }

    entries.set(name, content);
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function unescapeBasicXml(xml: string): string {
  return xml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Validates OOXML `.docx` bytes contain valid ZIP structure, `[Content_Types].xml`,
 * `word/document.xml`, `<w:document`, `<w:body`, `<w:tbl>`, `<w:tr>`, `<w:tc>`,
 * and optional expected text fragments.
 */
export function assertValidDocxWithTable(
  bytes: Buffer,
  expectedTexts?: readonly string[],
): ParsedDocxResult {
  const entries = parseZipEntries(bytes);
  expect(entries.has('[Content_Types].xml'), '.docx missing [Content_Types].xml').toBe(true);
  expect(entries.has('word/document.xml'), '.docx missing word/document.xml').toBe(true);

  const contentTypesXml = entries.get('[Content_Types].xml')!.toString('utf8');
  const documentXml = entries.get('word/document.xml')!.toString('utf8');

  expect(contentTypesXml).toContain('wordprocessingml.document.main+xml');
  expect(documentXml).toMatch(/<w:document[\s>]/);
  expect(documentXml).toMatch(/<w:body[\s>]/);
  expect(documentXml).toMatch(/<w:tbl[\s>]/);
  expect(documentXml).toMatch(/<w:tr[\s>]/);
  expect(documentXml).toMatch(/<w:tc[\s>]/);

  if (expectedTexts && expectedTexts.length > 0) {
    const plainText = unescapeBasicXml(documentXml.replace(/<[^>]+>/g, ''));
    for (const needle of expectedTexts) {
      expect(
        plainText.includes(needle) || unescapeBasicXml(documentXml).includes(needle),
        `.docx word/document.xml did not contain expected text "${needle}"`,
      ).toBe(true);
    }
  }

  return { entries, contentTypesXml, documentXml };
}

// ---------- JSON-LD, llms.txt & GEO Score Assertions ----------

/**
 * Validates JSON-LD Schema:
 * - Accepts raw string (with optional `<script type="application/ld+json">` wrapper) or object
 * - Valid JSON with zero unescaped `</script`
 * - `@context` references `schema.org`
 * - `@type` or `@graph[].@type` satisfies expected/allowed types
 * - For `FAQPage`, validates non-empty `mainEntity` Q&A structure
 */
export function assertValidJsonLd(
  rawOrObject: unknown,
  expectedTypes?: readonly string[],
): Record<string, unknown> {
  let rawString: string;
  let parsed: unknown;

  if (typeof rawOrObject === 'string') {
    const trimmed = rawOrObject.trim();
    const scriptMatch = trimmed.match(
      /^<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>$/i,
    );
    rawString = scriptMatch ? scriptMatch[1].trim() : trimmed;
    expect(rawString.toLowerCase(), 'JSON-LD contains unescaped </script').not.toContain(
      '</script',
    );
    parsed = JSON.parse(rawString);
  } else {
    expect(rawOrObject, 'JSON-LD schema must be a non-null object').toBeTruthy();
    rawString = JSON.stringify(rawOrObject);
    expect(rawString.toLowerCase(), 'Serialized JSON-LD contains unescaped </script').not.toContain(
      '</script',
    );
    parsed = JSON.parse(rawString);
  }

  const nodes: Array<Record<string, unknown>> = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        nodes.push(item as Record<string, unknown>);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>;
    nodes.push(root);
    if (Array.isArray(root['@graph'])) {
      for (const item of root['@graph']) {
        if (item && typeof item === 'object') {
          nodes.push(item as Record<string, unknown>);
        }
      }
    }
  }

  expect(nodes.length, 'JSON-LD must contain at least one schema node').toBeGreaterThan(0);

  const hasSchemaOrgContext = nodes.some((node) => {
    const ctx = node['@context'];
    return typeof ctx === 'string' && ctx.includes('schema.org');
  });
  expect(hasSchemaOrgContext, 'JSON-LD @context must reference schema.org').toBe(true);

  const foundTypes = new Set<string>();
  for (const node of nodes) {
    const t = node['@type'];
    if (typeof t === 'string') {
      foundTypes.add(t);
    } else if (Array.isArray(t)) {
      for (const entry of t) {
        if (typeof entry === 'string') {
          foundTypes.add(entry);
        }
      }
    }
  }
  expect(foundTypes.size, 'JSON-LD must declare at least one @type').toBeGreaterThan(0);

  if (expectedTypes && expectedTypes.length > 0) {
    const matched = expectedTypes.filter((t) => foundTypes.has(t));
    expect(
      matched.length,
      `JSON-LD @type set [${[...foundTypes].join(', ')}] did not match expected [${expectedTypes.join(', ')}]`,
    ).toBeGreaterThan(0);
  }

  // Validate FAQPage structure if present
  const faqNode = nodes.find((n) => n['@type'] === 'FAQPage');
  if (faqNode && faqNode.mainEntity !== undefined) {
    expect(Array.isArray(faqNode.mainEntity), 'FAQPage.mainEntity must be an array').toBe(true);
    const entities = faqNode.mainEntity as Array<Record<string, unknown>>;
    if (entities.length > 0) {
      for (const q of entities) {
        expect(q['@type']).toBe('Question');
        const answer = q.acceptedAnswer as Record<string, unknown> | undefined;
        expect(answer?.['@type']).toBe('Answer');
        expect(typeof answer?.text === 'string' && answer.text.trim().length > 0).toBe(true);
      }
    }
  }

  return (Array.isArray(parsed) ? { '@graph': parsed } : parsed) as Record<string, unknown>;
}

export function assertValidLlmsTxt(
  snippet: string | null | undefined,
  expectedBrandOrDomain?: string,
): void {
  expect(typeof snippet, 'llms.txt snippet must be a string').toBe('string');
  const text = (snippet ?? '').trim();
  expect(text.length, 'llms.txt snippet must not be empty').toBeGreaterThan(10);
  expect(text, 'llms.txt must contain an H1 `# ` heading').toMatch(/^#\s+\S+/m);
  expect(text, 'llms.txt must contain at least one Markdown list link').toMatch(
    /-\s+\[[^\]]+\]\(https?:\/\/[^\s)]+\)/,
  );
  if (expectedBrandOrDomain) {
    expect(text.toLowerCase(), `llms.txt expected to mention "${expectedBrandOrDomain}"`).toContain(
      expectedBrandOrDomain.toLowerCase(),
    );
  }
}

export function assertLlmsTxt(
  text: string,
  expected: { brandName: string; domain?: string },
): void {
  assertValidLlmsTxt(text, expected.brandName);
  if (expected.domain) {
    expect(text.toLowerCase()).toContain(expected.domain.toLowerCase());
  }
}

const EXPECTED_DIMENSION_MAX: Record<GeoScoreDimensionKey, number> = {
  directAnswer: 20,
  structuredExtractable: 20,
  factDensity: 25,
  fanOutCoverage: 20,
  deAiCompliance: 15,
};

export function assertGeoScoreValid(
  score: number,
  detail: GeoScoreDetailDto,
  opts: { minScore?: number; maxScore?: number } = {},
): void {
  expect(Number.isFinite(score), `geoScore must be finite, got ${String(score)}`).toBe(true);
  expect(score).toBeGreaterThanOrEqual(opts.minScore ?? 0);
  expect(score).toBeLessThanOrEqual(opts.maxScore ?? 100);
  expect(detail && typeof detail === 'object', 'geoScoreDetail must be an object').toBe(true);
  expect(detail.dimensions && typeof detail.dimensions === 'object').toBe(true);

  const keys = Object.keys(EXPECTED_DIMENSION_MAX) as GeoScoreDimensionKey[];
  let sum = 0;
  for (const key of keys) {
    const dim = detail.dimensions[key];
    expect(dim, `Missing GEO score dimension "${key}"`).toBeTruthy();
    expect(dim.maxScore, `Dimension "${key}" maxScore mismatch`).toBe(EXPECTED_DIMENSION_MAX[key]);
    expect(dim.score).toBeGreaterThanOrEqual(0);
    expect(dim.score).toBeLessThanOrEqual(dim.maxScore);
    sum += dim.score;
  }

  expect(Math.abs(sum - score), `Dimension sum ${sum} != geoScore ${score}`).toBeLessThanOrEqual(1);
}

export function assertGeoScoreInvariants(evalData: GeoEvaluationData): void {
  assertGeoScoreValid(evalData.geoScore, evalData.geoScoreDetail);
}

// ---------- Viewport Overflow & Cold-Load Zero-Flicker ----------

export async function assertNoHorizontalOverflow(
  page: Page,
  options: {
    viewports?: ReadonlyArray<{ width: number; height: number }>;
    checkSelectorNotClipped?: string;
  } = {},
): Promise<void> {
  const viewports = options.viewports ?? REQUIRED_VIEWPORTS;
  const original = page.viewportSize();
  try {
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100);
      const metrics = await page.evaluate(
        ({ checkSel }) => {
          const docWidth = document.documentElement.scrollWidth;
          const innerWidth = window.innerWidth;
          const clipped: string[] = [];

          const selectors = [
            '.ant-table-wrapper button, .ant-table-wrapper a',
            ...(checkSel ? [checkSel] : []),
          ];
          for (const sel of selectors) {
            const els = Array.from(document.querySelectorAll(sel));
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && rect.right > innerWidth + 1) {
                clipped.push(
                  `${el.tagName}(${(el.textContent ?? '').trim().slice(0, 24)}): right=${Math.round(rect.right)} > ${innerWidth}`,
                );
              }
            }
          }
          return { docWidth, innerWidth, clipped };
        },
        { checkSel: options.checkSelectorNotClipped ?? null },
      );

      expect(
        metrics.docWidth,
        `Horizontal overflow at ${vp.width}x${vp.height}: scrollWidth=${metrics.docWidth} > innerWidth=${metrics.innerWidth}`,
      ).toBeLessThanOrEqual(metrics.innerWidth + 1);

      expect(
        metrics.clipped,
        `Clipped elements at ${vp.width}x${vp.height}: ${metrics.clipped.join('; ')}`,
      ).toEqual([]);
    }
  } finally {
    if (original) {
      await page.setViewportSize(original);
    }
  }
}

export async function assertZeroHorizontalOverflow(
  page: Page,
  viewports: ReadonlyArray<{ width: number; height: number }> = REQUIRED_VIEWPORTS,
): Promise<void> {
  await assertNoHorizontalOverflow(page, { viewports });
}

interface ColdLoadFlickerState {
  active: boolean;
  samplesCount: number;
  violations: Array<{ pattern: string; snippet: string; ts: number }>;
}

const COLD_LOAD_OBSERVER_INIT = () => {
  const state: ColdLoadFlickerState = {
    active: true,
    samplesCount: 0,
    violations: [],
  };
  (window as unknown as { __gmColdLoadFlicker?: ColdLoadFlickerState }).__gmColdLoadFlicker = state;

  const patterns: Array<{ label: string; regex: RegExp }> = [
    { label: '0 点', regex: /(?:^|[^\d])0\s*点/ },
    { label: '免费体验期', regex: /免费体验期/ },
    { label: '¥0.00', regex: /¥\s*0\.00/ },
  ];

  const scan = () => {
    if (!state.active || !document.body) {
      return;
    }
    const text = document.body.innerText || '';
    state.samplesCount += 1;
    for (const p of patterns) {
      const m = text.match(p.regex);
      if (m) {
        const idx = m.index ?? 0;
        const snippet = text.slice(Math.max(0, idx - 20), idx + 40).replace(/\s+/g, ' ');
        state.violations.push({ pattern: p.label, snippet, ts: Date.now() });
      }
    }
  };

  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  document.addEventListener('DOMContentLoaded', scan);
  const rafTick = () => {
    if (!state.active) {
      return;
    }
    scan();
    requestAnimationFrame(rafTick);
  };
  requestAnimationFrame(rafTick);
};

export async function assertNoColdLoadFlicker(
  browser: Browser,
  session: Pick<TenantSession, 'accessToken' | 'refreshToken'>,
  routePath: string,
  options?: {
    holdMs?: number;
    expectedPointsText?: string | RegExp;
    expectSkeleton?: boolean;
  },
): Promise<void>;
export async function assertNoColdLoadFlicker(
  page: Page,
  opts: {
    targetPath: string;
    routePatterns: ReadonlyArray<string | RegExp>;
    delayMs?: number;
    expectedAfterLoadText?: string | RegExp;
  },
): Promise<void>;
export async function assertNoColdLoadFlicker(
  browserOrPage: Browser | Page,
  secondArg:
    | Pick<TenantSession, 'accessToken' | 'refreshToken'>
    | {
        targetPath: string;
        routePatterns: ReadonlyArray<string | RegExp>;
        delayMs?: number;
        expectedAfterLoadText?: string | RegExp;
      },
  routePathArg?: string,
  optionsArg?: {
    holdMs?: number;
    expectedPointsText?: string | RegExp;
    expectSkeleton?: boolean;
  },
): Promise<void> {
  // Overload 2: existing Page + opts
  if ('goto' in browserOrPage && 'routePatterns' in secondArg) {
    const page = browserOrPage;
    const opts = secondArg;
    const holdMs = opts.delayMs ?? 900;

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    await page.addInitScript(COLD_LOAD_OBSERVER_INIT);
    const handler = async (route: { continue: () => Promise<void> }) => {
      await gate;
      await route.continue();
    };

    for (const pat of opts.routePatterns) {
      await page.route(pat, handler);
    }

    try {
      await page.goto(opts.targetPath, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.ant-skeleton, [aria-busy="true"]').first()).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(holdMs);

      const snapshot = await page.evaluate(() => {
        const s = (window as unknown as { __gmColdLoadFlicker?: ColdLoadFlickerState })
          .__gmColdLoadFlicker;
        if (s) {
          s.active = false;
        }
        return s ?? { active: false, samplesCount: 0, violations: [] };
      });

      expect(snapshot.samplesCount, 'Cold-load MutationObserver never sampled DOM').toBeGreaterThan(
        0,
      );
      expect(
        snapshot.violations,
        `Cold-load fake-value flicker detected: ${JSON.stringify(snapshot.violations)}`,
      ).toEqual([]);

      releaseGate();

      if (opts.expectedAfterLoadText) {
        await expect(page.locator('body')).toContainText(opts.expectedAfterLoadText, {
          timeout: 15_000,
        });
      }
    } finally {
      releaseGate();
      for (const pat of opts.routePatterns) {
        await page.unroute(pat, handler).catch(() => undefined);
      }
    }
    return;
  }

  // Overload 1: Browser + session + routePath + options
  const browser = browserOrPage as Browser;
  const session = secondArg as Pick<TenantSession, 'accessToken' | 'refreshToken'>;
  const routePath = routePathArg ?? '/home';
  const holdMs = optionsArg?.holdMs ?? 900;
  const expectSkeleton = optionsArg?.expectSkeleton ?? true;
  const expectedPointsText = optionsArg?.expectedPointsText ?? /[1-9]\d*/;

  const context = await browser.newContext({ viewport: VIEWPORT_DESKTOP });
  const page = await context.newPage();

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const patterns = [
    '**/api/v1/billing/wallet*',
    '**/api/v1/account*',
    '**/api/v1/me/rights*',
    '**/api/v2/brands*',
  ];

  try {
    await injectSessionBeforeLoad(page, session);
    await page.addInitScript(COLD_LOAD_OBSERVER_INIT);
    for (const pat of patterns) {
      await page.route(pat, async (route) => {
        await gate;
        await route.continue();
      });
    }

    await page.goto(routePath, { waitUntil: 'domcontentloaded' });
    if (expectSkeleton) {
      await expect(page.locator('.ant-skeleton, [aria-busy="true"]').first()).toBeVisible({
        timeout: 10_000,
      });
    }
    await page.waitForTimeout(holdMs);

    const snapshot = await page.evaluate(() => {
      const s = (window as unknown as { __gmColdLoadFlicker?: ColdLoadFlickerState })
        .__gmColdLoadFlicker;
      if (s) {
        s.active = false;
      }
      return s ?? { active: false, samplesCount: 0, violations: [] };
    });

    expect(snapshot.samplesCount, 'Cold-load MutationObserver never sampled DOM').toBeGreaterThan(
      0,
    );
    expect(
      snapshot.violations,
      `Cold-load flicker on ${routePath}: ${JSON.stringify(snapshot.violations)}`,
    ).toEqual([]);

    releaseGate();
    await expect(page.getByTestId('header-points-pill')).toContainText(expectedPointsText, {
      timeout: 15_000,
    });
  } finally {
    releaseGate();
    await context.close();
  }
}

export async function assertNoForbiddenLegacyText(
  page: Page,
  forbiddenTexts: readonly string[],
): Promise<void> {
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const found = forbiddenTexts.filter((item) => bodyText.includes(item));
  expect(found, `Forbidden legacy texts found in DOM: ${found.join(', ')}`).toEqual([]);
}

export function assertNoConsoleOrPageErrors(
  collector: { errors: string[] } | readonly string[],
): void {
  const list = 'errors' in collector ? collector.errors : collector;
  expect(list, `Unexpected console/page errors: ${list.join(' | ')}`).toEqual([]);
}
