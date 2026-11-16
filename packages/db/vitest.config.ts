import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@geomix/shared/catalog': fileURLToPath(new URL('../shared/src/catalog.ts', import.meta.url)),
      '@geomix/shared/infra': fileURLToPath(new URL('../shared/src/infra.ts', import.meta.url)),
      '@geomix/prompts': fileURLToPath(new URL('../prompts/src/index.ts', import.meta.url)),
    },
  },
});
