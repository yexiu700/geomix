import { FlatCompat } from '@eslint/eslintrc';
import { createBaseConfig } from '@geomix/config/eslint';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  { ignores: ['next-env.d.ts'] },
  ...createBaseConfig(),
  ...compat.extends('next/core-web-vitals'),
];

export default config;
