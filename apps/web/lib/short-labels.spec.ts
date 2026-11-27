import {
  BRAND_FACT_SLOTS,
  GEO_BRIEF_SOURCES,
  GEO_MARKETS,
  GEO_RECIPES,
  GEO_REWRITE_ACTIONS,
  GEO_TARGET_FORMATS,
  NEAR_MISS_TIERS,
} from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { CONTROL_LABEL_MAX_CHARS, copyLength } from './copy-length';
import {
  BRAND_FACT_SLOT_SHORT,
  GEO_BRIEF_SOURCE_SHORT,
  GEO_MARKET_SHORT,
  GEO_RECIPE_SHORT,
  GEO_REWRITE_ACTION_SHORT,
  GEO_TARGET_FORMAT_SHORT,
  NEAR_MISS_TIER_SHORT,
  WORKSPACE_NAV_SHORT,
} from './short-labels';

describe('short-labels', () => {
  it('covers all enum keys exhaustively without missing entries', () => {
    expect(Object.keys(BRAND_FACT_SLOT_SHORT)).toEqual([...BRAND_FACT_SLOTS]);
    expect(Object.keys(GEO_RECIPE_SHORT)).toEqual([...GEO_RECIPES]);
    expect(Object.keys(GEO_TARGET_FORMAT_SHORT)).toEqual([...GEO_TARGET_FORMATS]);
    expect(Object.keys(GEO_REWRITE_ACTION_SHORT)).toEqual([...GEO_REWRITE_ACTIONS]);
    expect(Object.keys(GEO_BRIEF_SOURCE_SHORT)).toEqual([...GEO_BRIEF_SOURCES]);
    expect(Object.keys(NEAR_MISS_TIER_SHORT)).toEqual([...NEAR_MISS_TIERS]);
    expect(Object.keys(GEO_MARKET_SHORT)).toEqual([...GEO_MARKETS]);
    expect(Object.keys(WORKSPACE_NAV_SHORT)).toEqual([
      '/home',
      '/brands',
      '/visibility',
      '/studio',
      '/publish',
    ]);
  });

  it('keeps every short label within the 4-character control limit', () => {
    const maps = [
      BRAND_FACT_SLOT_SHORT,
      GEO_RECIPE_SHORT,
      GEO_TARGET_FORMAT_SHORT,
      GEO_REWRITE_ACTION_SHORT,
      GEO_BRIEF_SOURCE_SHORT,
      NEAR_MISS_TIER_SHORT,
      GEO_MARKET_SHORT,
      WORKSPACE_NAV_SHORT,
    ];

    for (const map of maps) {
      for (const [key, label] of Object.entries(map)) {
        const len = copyLength(label);
        expect(len, `${key} -> "${label}" (${len}) must be <= 4`).toBeLessThanOrEqual(
          CONTROL_LABEL_MAX_CHARS,
        );
        expect(len, `${key} -> "${label}" must be >= 2`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
