import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['lib/**/*.spec.ts', 'components/**/*.spec.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
