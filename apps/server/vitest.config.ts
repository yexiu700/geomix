import { defineConfig } from 'vitest/config';

const isIntegrationRun =
  process.env.GEOMIX_DB_INTEGRATION === '1' || process.env.GEOMIX_REDIS_INTEGRATION === '1';

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: '100%',
    isolate: isIntegrationRun,
    testTimeout: 30000,
    include: ['src/**/*.spec.ts'],
  },
});
