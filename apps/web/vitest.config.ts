import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: 60000,
    maxWorkers: 1,
    include: ['lib/**/*.spec.ts', 'components/**/*.spec.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
