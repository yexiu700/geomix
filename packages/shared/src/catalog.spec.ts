import { describe, expect, it } from 'vitest';
import {
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  QUOTA_MEASURE,
  STORAGE_QUOTA_BYTES,
} from './catalog';

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe('GeoMix 2.0 catalog', () => {
  it('keeps strictly the 3 v2 paid pricing defaults (zero legacy kb_addon/distill actions)', () => {
    expect(PRICING_DEFAULTS.map((item) => [item.action, item.unitPoints])).toEqual([
      ['geo_write', 10],
      ['visibility_check', 2],
      ['inline_image_gen', 5],
    ]);
    expect(unique(PRICING_DEFAULTS.map((item) => item.action))).toBe(true);
    expect(FREE_RATE_LIMITED_ACTIONS).toEqual([
      'geo_brief',
      'brand_fact_extract',
      'geo_evaluate',
      'rewrite_section',
    ]);
  });

  it('keeps the six default quotas aligned with QuotaKey, including 100MiB of storage', () => {
    expect(QUOTA_DEFAULTS.map((item) => [item.key, item.limit])).toEqual([
      ['MAIN_KEYWORD', 100],
      ['QUESTION', 10_000],
      ['AI_WRITE', 10_000],
      ['STORAGE_BYTES', STORAGE_QUOTA_BYTES],
      ['PUBLISH', 10_000],
      ['SOCIAL_AUTH', 100],
    ]);
    expect(STORAGE_QUOTA_BYTES).toBe(104_857_600);
    expect(QUOTA_MEASURE).toEqual({
      MAIN_KEYWORD: 'stock',
      QUESTION: 'stock',
      STORAGE_BYTES: 'stock',
      AI_WRITE: 'cumulative',
    });
  });

  it('seeds a one-year demo balance of 1000 points', () => {
    expect(DEMO_TENANT_POINTS).toBe(1000);
    expect(DEMO_TENANT_VALID_DAYS).toBe(365);
  });
});
