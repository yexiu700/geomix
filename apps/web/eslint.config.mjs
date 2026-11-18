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
  {
    files: ['components/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Modal'][callee.property.name='confirm']",
          message:
            '请使用 useUxFeedback().confirm(...) 替代静态 Modal.confirm(...)，以继承暗黑主题 Token 与统一 Escape 关闭规范。',
        },
        {
          selector:
            "CallExpression[callee.object.name='URL'][callee.property.name='revokeObjectURL']",
          message:
            '请使用 lib/ux-foundation 中的 triggerBlobDownload(...) 统一触发下载与延迟释放，避免同步 revokeObjectURL 导致下载静默失败。',
        },
      ],
    },
  },
];

export default config;
