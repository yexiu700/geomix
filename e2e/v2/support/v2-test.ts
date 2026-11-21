import { test as base, expect, type TestDetails } from '@playwright/test';

export const E2E_V2_SKIP_REASON = 'GeoMix 2.0 opaque-box suite requires E2E_V2=1';

export const E2E_V2_ENABLED: boolean = process.env.E2E_V2 === '1';

export function isE2eV2Enabled(): boolean {
  return process.env.E2E_V2 === '1';
}

/**
 * Extended Playwright test with automatic env-gate safety net.
 * Note: `{}` object destructuring is mandatory for Playwright fixture parsing.
 */
export const test = base.extend<{ _v2Gate: void }>({
  _v2Gate: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      testInfo.skip(!isE2eV2Enabled(), E2E_V2_SKIP_REASON);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Calls collection-time `test.skip` inside a spec's `test.describe` block
 * (defense-in-depth alongside `playwright.config.ts` `testIgnore`).
 */
export function gateV2Suite(): void {
  test.skip(!isE2eV2Enabled(), E2E_V2_SKIP_REASON);
}

/**
 * Registers a top-level GeoMix 2.0 suite with collection-time `test.skip`
 * evaluated PER SPEC FILE (avoids Node module-caching bug where top-level
 * `test.skip` inside a shared module only marks the first imported spec).
 *
 * All tags MUST begin with `@` (Playwright 1.65 enforces this at list time).
 */
export function v2Describe(title: string, details: TestDetails, callback: () => void): void {
  test.describe(title, details, () => {
    gateV2Suite();
    callback();
  });
}

/**
 * Shorthand suite wrapper taking a tag array directly.
 */
export function describeV2(title: string, tags: readonly string[], body: () => void): void {
  v2Describe(title, { tag: [...tags] }, body);
}

export { expect };
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  TestDetails,
  TestInfo,
} from '@playwright/test';
