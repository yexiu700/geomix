import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts', 'components/**/*.spec.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
