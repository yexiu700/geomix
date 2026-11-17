import { describe, expect, it } from 'vitest';
import {
  COPY_TYPES,
  CREATIVE_DIRECTIONS,
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  DIRECTION_COMPLIANCE,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  QUOTA_MEASURE,
  STORAGE_QUOTA_BYTES,
  directionGuidance,
} from './catalog';

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe('phase-1 catalog', () => {
  it('keeps the seed price table', () => {
    expect(PRICING_DEFAULTS.map((item) => [item.action, item.unitPoints])).toEqual([
      ['distill', 10],
      ['ai_write', 10],
      ['kb_addon', 5],
      ['rewrite_single', 5],
      ['rewrite_batch', 5],
      ['image_gen', 5],
      ['visibility_check', 2],
    ]);
    expect(unique(PRICING_DEFAULTS.map((item) => item.action))).toBe(true);
  });

  it('keeps the six default quotas, including 100MiB of storage', () => {
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

  it('ships 29 original directions and 15 original copy types', () => {
    expect(CREATIVE_DIRECTIONS).toHaveLength(29);
    expect(COPY_TYPES).toHaveLength(15);
    expect(unique(CREATIVE_DIRECTIONS)).toBe(true);
    expect(unique(COPY_TYPES)).toBe(true);
    expect(CREATIVE_DIRECTIONS).toEqual(
      expect.arrayContaining(['夸张方式', '情感煽动', '热点宣传']),
    );
  });

  it('maps the three flagged directions onto compliant wording', () => {
    expect(directionGuidance('夸张方式')).toBe(DIRECTION_COMPLIANCE.夸张方式);
    expect(directionGuidance('情感煽动')).toBe('引发情感共鸣，不制造焦虑');
    expect(directionGuidance('热点宣传')).toBe('结合行业热点，不蹭敏感事件');
    expect(directionGuidance('产品说明')).toBe('产品说明');
  });

  it('seeds a one-year demo balance of 1000 points', () => {
    expect(DEMO_TENANT_POINTS).toBe(1000);
    expect(DEMO_TENANT_VALID_DAYS).toBe(365);
  });
});
