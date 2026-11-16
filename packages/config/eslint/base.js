import tseslint from 'typescript-eslint';

/** Shared ESLint flat config for GeoMix packages. */
export function createBaseConfig() {
  return tseslint.config(
    {
      ignores: ['dist/**', '.next/**', 'coverage/**', 'node_modules/**'],
    },
    ...tseslint.configs.recommended,
    {
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
  );
}
