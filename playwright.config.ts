import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const baseURL = (process.env.E2E_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiBase = (process.env.E2E_API_BASE?.trim() || 'http://127.0.0.1:3001/api/v1').replace(
  /\/$/,
  '',
);
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1';

const explicitChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const systemChromium =
  explicitChromium ||
  (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const visibilityCollector = process.env.VISIBILITY_COLLECTOR || 'fake';
const defaultVisibilityDisabledEngines =
  visibilityCollector.trim().toLowerCase() === 'fake'
    ? 'yuanbao,tongyi,wenxin,nami,kimi,zhipu'
    : undefined;

const sharedEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  API_PORT: process.env.API_PORT || '3001',
  WEB_PORT: process.env.WEB_PORT || '3000',
  WEB_ORIGIN: `${baseURL},http://localhost:3000,http://127.0.0.1:3000`,
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
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || baseURL,
  E2E_PUBLIC_FIXTURE_HOST: process.env.E2E_PUBLIC_FIXTURE_HOST || 'public.e2e.example',
  E2E_FIXTURE_PORT: process.env.E2E_FIXTURE_PORT || '3099',
  E2E_MEMORY_MAX_OBJECTS: process.env.E2E_MEMORY_MAX_OBJECTS || '2000',
};

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.E2E_V2 === '1' ? [] : ['**/v2/**'],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: systemChromium
      ? {
          executablePath: systemChromium,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
      : {
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: skipWebServer
    ? undefined
    : [
        {
          command: 'node ./e2e/support/e2e-backend.cjs',
          url: `${apiBase}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 90_000,
          env: sharedEnv,
        },
        {
          command: `node ./apps/web/node_modules/next/dist/bin/next start apps/web --port ${sharedEnv.WEB_PORT}`,
          url: `${baseURL}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 90_000,
          env: {
            ...sharedEnv,
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      ],
});
