import { describe, expect, it } from 'vitest';
import {
  buildFallbackSeedPromptSuggestionResponse,
  mergeAiMarketSuggestions,
} from './brand-form-helpers';

describe('brand-form-helpers AI prefill merge & fallback (#405)', () => {
  it('appends and dedupes without overwriting user edits, enforces all field caps, and strips control prompts overlapping seeds', () => {
    const existingAliases = Array.from({ length: 19 }, (_, idx) => `SKU-${idx + 1}`);
    const existingCompetitors = Array.from({ length: 9 }, (_, idx) => ({
      name: `竞品${idx + 1}`,
      aliases: [],
      domains: [`comp${idx + 1}.example.com`],
    }));
    const existingSeeds = Array.from({ length: 49 }, (_, idx) => `已有监控问句 ${idx + 1}`);
    const existingControls = ['已有对照 1', '已有对照 2', '已有对照 3', '已有对照 4'];

    const merged = mergeAiMarketSuggestions({
      market: 'CN',
      current: {
        localBrandName: '青松存储',
        localCategory: '家用 NAS',
        aliases: existingAliases,
        competitors: existingCompetitors,
        seedPrompts: existingSeeds,
        controlPrompts: existingControls,
      },
      selection: {
        localBrandName: 'IgnoredOnCN',
        localCategory: 'IgnoredCategoryOnCN',
        aliases: ['sku-1', 'NEW-20', 'OVER-21'],
        competitors: [
          { name: '竞品1', aliases: [], domains: ['comp1.example.com'] },
          { name: '新竞品10', aliases: ['NewComp'], domains: ['https://www.newcomp.example.com/'] },
          { name: '超上限竞品11', aliases: [], domains: ['over.example.com'] },
        ],
        seedPrompts: ['已有监控问句 1', '新增监控问句 50', '超上限监控问句 51'],
        controlPrompts: [
          '新增监控问句 50', // overlaps newly appended seed -> must skip
          '已有监控问句 1', // overlaps existing seed -> must skip
          '新增对照 5',
          '超上限对照 6',
        ],
      },
    });

    // CN never overwrites localBrandName / localCategory
    expect(merged.localBrandName).toBe('青松存储');
    expect(merged.localCategory).toBe('家用 NAS');
    expect(merged.addedCounts.localBrandName).toBe(false);
    expect(merged.addedCounts.localCategory).toBe(false);

    // Aliases capped at 20
    expect(merged.aliases).toHaveLength(20);
    expect(merged.aliases[19]).toBe('NEW-20');
    expect(merged.addedCounts.aliases).toBe(1);
    expect(merged.truncatedCounts.aliases).toBe(1);

    // Competitors capped at 10 with normalized domain
    expect(merged.competitors).toHaveLength(10);
    expect(merged.competitors[9]).toEqual({
      name: '新竞品10',
      aliases: ['NewComp'],
      domains: ['newcomp.example.com'],
    });
    expect(merged.addedCounts.competitors).toBe(1);
    expect(merged.truncatedCounts.competitors).toBe(1);

    // Seed prompts capped at 50
    expect(merged.seedPrompts).toHaveLength(50);
    expect(merged.seedPrompts[49]).toBe('新增监控问句 50');
    expect(merged.addedCounts.seedPrompts).toBe(1);
    expect(merged.truncatedCounts.seedPrompts).toBe(1);

    // Control prompts capped at 5 & overlapping seeds skipped
    expect(merged.controlPrompts).toHaveLength(5);
    expect(merged.controlPrompts[4]).toBe('新增对照 5');
    expect(merged.addedCounts.controlPrompts).toBe(1);
    expect(merged.truncatedCounts.controlPrompts).toBe(1);
    expect(merged.skippedControlOverlaps).toBe(2);
  });

  it('updates GLOBAL localBrandName/localCategory when selected and builds static fallback seed prompts', () => {
    const merged = mergeAiMarketSuggestions({
      market: 'GLOBAL',
      current: {
        localBrandName: '青松存储',
        localCategory: '',
        aliases: [],
        competitors: [],
        seedPrompts: [],
        controlPrompts: [],
      },
      selection: {
        localBrandName: 'PineVault',
        localCategory: 'Home NAS',
        aliases: [],
        competitors: [],
        seedPrompts: [],
        controlPrompts: [],
      },
    });

    expect(merged.localBrandName).toBe('PineVault');
    expect(merged.localCategory).toBe('Home NAS');
    expect(merged.addedCounts.localBrandName).toBe(true);
    expect(merged.addedCounts.localCategory).toBe(true);

    const fallback = buildFallbackSeedPromptSuggestionResponse({
      market: 'GLOBAL',
      brandName: 'PineVault',
      category: '家用 NAS',
      localCategory: 'Home NAS',
      existingSeedPrompts: ['What is the best Home NAS to buy in 2026?'],
    });
    expect(fallback.fallbackUsed).toBe(true);
    expect(fallback.seedPrompts.length).toBeGreaterThanOrEqual(4);
    expect(
      fallback.seedPrompts.some(
        (item) => item.prompt === 'What is the best Home NAS to buy in 2026?',
      ),
    ).toBe(false);
  });
});
