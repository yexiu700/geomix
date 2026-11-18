import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    pool: 'threads',
    maxWorkers: '100%',
    testTimeout: 30000,
    include: ['lib/**/*.spec.{ts,tsx}', 'components/**/*.spec.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    deps: {
      optimizer: {
        web: {
          enabled: true,
          include: ['antd'],
        },
      },
    },
  },
});
