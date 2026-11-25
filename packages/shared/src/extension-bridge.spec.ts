import { describe, expect, it } from 'vitest';
import {
  EXTENSION_BRIDGE_VERSION,
  EXTENSION_DEFAULT_SCOPES,
  EXTENSION_DEFAULT_TTL_DAYS,
  EXTENSION_MAX_TTL_DAYS,
  EXTENSION_TASK_FILTER_STATUSES,
  EXTENSION_TOKEN_PREFIX,
  createExtensionTokenSchema,
  extensionConfirmPublishedSchema,
  extensionTasksQuerySchema,
} from './extension-bridge';

describe('extension-bridge.ts — Chrome Extension L2 Bridge v1 contracts', () => {
  it('exposes stable bridge constants and validates token creation schema', () => {
    expect(EXTENSION_BRIDGE_VERSION).toBe('v1');
    expect(EXTENSION_TOKEN_PREFIX).toBe('gmext_');
    expect(EXTENSION_DEFAULT_TTL_DAYS).toBe(90);
    expect(EXTENSION_MAX_TTL_DAYS).toBe(365);
    expect(EXTENSION_DEFAULT_SCOPES).toEqual(['extension:distribution']);
    expect(EXTENSION_TASK_FILTER_STATUSES).toEqual([
      'DRAFT_VARIANT',
      'READY_TO_PUBLISH',
      'DRAFT_PUSHED',
      'PUBLISHED',
    ]);

    const parsed = createExtensionTokenSchema.parse({ label: '  Chrome Office Mac  ' });
    expect(parsed).toEqual({ label: 'Chrome Office Mac', ttlDays: 90 });

    expect(createExtensionTokenSchema.safeParse({ label: '   ' }).success).toBe(false);
    expect(createExtensionTokenSchema.safeParse({ label: 'ok', ttlDays: 0 }).success).toBe(false);
    expect(createExtensionTokenSchema.safeParse({ label: 'ok', ttlDays: 400 }).success).toBe(false);
  });

  it('validates extensionTasksQuerySchema for L2 providers and limit bounds', () => {
    expect(extensionTasksQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      extensionTasksQuerySchema.parse({
        brandId: 'brand_123',
        provider: 'ZHIHU_EXT',
        status: 'READY_TO_PUBLISH',
        limit: '15',
      }),
    ).toEqual({
      brandId: 'brand_123',
      provider: 'ZHIHU_EXT',
      status: 'READY_TO_PUBLISH',
      limit: 15,
    });
    // Non-L2 providers must be rejected
    expect(extensionTasksQuerySchema.safeParse({ provider: 'SHOPIFY' }).success).toBe(false);
    expect(extensionTasksQuerySchema.safeParse({ limit: '100' }).success).toBe(false);
  });

  it('validates extensionConfirmPublishedSchema and rejects unsafe or blank URLs', () => {
    expect(
      extensionConfirmPublishedSchema.parse({
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        note: 'Manual publish confirmed',
      }),
    ).toEqual({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      note: 'Manual publish confirmed',
    });

    for (const badUrl of [
      '',
      '   ',
      'javascript:alert(1)',
      'ftp://zhuanlan.zhihu.com/p/1',
      'https://user:pass@zhuanlan.zhihu.com/p/1',
      'chrome-extension://abcdef/popup.html',
    ]) {
      expect(extensionConfirmPublishedSchema.safeParse({ publishedUrl: badUrl }).success).toBe(
        false,
      );
    }
  });
});
