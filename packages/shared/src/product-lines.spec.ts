import { describe, expect, it } from 'vitest';
import {
  BRAND_MAX_PRODUCT_LINES,
  PRODUCT_LINE_MAX_SEED_PROMPTS,
  createProductLineSchema,
  readProductLineMarketCompetitors,
  readProductLineMarketSeedPrompts,
  resolveEffectiveCategory,
  resolveProductLineLocalName,
  updateProductLineSchema,
} from './product-lines';

describe('product-lines schemas & constants', () => {
  it('exposes BRAND_MAX_PRODUCT_LINES = 20 and validates create payload with defaults', () => {
    expect(BRAND_MAX_PRODUCT_LINES).toBe(20);
    expect(PRODUCT_LINE_MAX_SEED_PROMPTS).toBe(50);

    const parsed = createProductLineSchema.parse({
      name: '  星曜储能系列  ',
      category: '  便携储能电源  ',
      localNamesJson: { CN: '星曜储能', GLOBAL: 'HeliosPower' },
      localCategoriesJson: { CN: '', GLOBAL: 'Portable Power Station' },
      seedPromptsJson: {
        GLOBAL: ['Best portable power station', 'best portable power station', 'Camp battery'],
      },
      competitorsJson: {
        GLOBAL: [{ name: 'Jackery', domains: ['https://Jackery.example/path'] }],
      },
    });

    expect(parsed.name).toBe('星曜储能系列');
    expect(parsed.category).toBe('便携储能电源');
    expect(parsed.localNamesJson).toEqual({ CN: '星曜储能', GLOBAL: 'HeliosPower' });
    expect(parsed.localCategoriesJson).toEqual({ GLOBAL: 'Portable Power Station' });
    expect(parsed.seedPromptsJson).toEqual({
      GLOBAL: ['Best portable power station', 'Camp battery'],
    });
    expect(parsed.competitorsJson).toEqual({
      GLOBAL: [{ name: 'Jackery', aliases: [], domains: ['jackery.example'] }],
    });
    expect(parsed.sortOrder).toBe(0);
  });

  it('rejects empty PATCH {} and undefined-only objects, and accepts partial updates without injecting defaults', () => {
    const empty = updateProductLineSchema.safeParse({});
    expect(empty.success).toBe(false);

    const undefinedOnly = updateProductLineSchema.safeParse({ name: undefined });
    expect(undefinedOnly.success).toBe(false);

    const valid = updateProductLineSchema.parse({
      localCategoriesJson: { GLOBAL: 'Home NAS' },
    });
    expect(valid).toEqual({
      localCategoriesJson: { GLOBAL: 'Home NAS' },
    });
    expect('sortOrder' in valid).toBe(false);
  });

  it('rejects unknown market keys in local maps', () => {
    const res = createProductLineSchema.safeParse({
      name: 'Line A',
      category: 'Cat A',
      localCategoriesJson: { JP: 'Invalid' },
    });
    expect(res.success).toBe(false);
  });
});

describe('resolveEffectiveCategory', () => {
  const brand = { category: '智能硬件' };
  const globalMarket = { market: 'GLOBAL' as const, localCategory: 'Smart Hardware' };
  const cnMarket = { market: 'CN' as const, localCategory: '消费电子' };

  it('prefers productLine.localCategoriesJson.GLOBAL over brand/market category', () => {
    const lineA = {
      category: '便携储能电源',
      localCategoriesJson: { GLOBAL: 'Portable Power Station', CN: '户外储能电源' },
    };
    const lineB = {
      category: '家庭 NAS',
      localCategoriesJson: { GLOBAL: 'Home NAS', CN: '家庭私有云 NAS' },
    };

    expect(resolveEffectiveCategory(brand, globalMarket, lineA)).toBe('Portable Power Station');
    expect(resolveEffectiveCategory(brand, globalMarket, lineB)).toBe('Home NAS');
    expect(resolveEffectiveCategory(brand, cnMarket, lineA)).toBe('户外储能电源');
    expect(resolveEffectiveCategory(brand, cnMarket, lineB)).toBe('家庭私有云 NAS');
  });

  it('uses non-CJK productLine.category on GLOBAL when localCategoriesJson.GLOBAL is omitted', () => {
    const line = { category: 'Home NAS', localCategoriesJson: {} };
    expect(resolveEffectiveCategory(brand, globalMarket, line)).toBe('Home NAS');
  });

  it('never leaks CJK on GLOBAL when productLine only defines Chinese category', () => {
    const mappedLine = { category: '便携储能电源', localCategoriesJson: {} };
    const resolvedMapped = resolveEffectiveCategory(brand, globalMarket, mappedLine);
    expect(/[\u4e00-\u9fff]/.test(resolvedMapped)).toBe(false);
    expect(resolvedMapped.length).toBeGreaterThan(0);

    const unmappedLine = { category: '自定义小众品类', localCategoriesJson: {} };
    const resolvedUnmapped = resolveEffectiveCategory(brand, globalMarket, unmappedLine);
    expect(resolvedUnmapped).toBe('Smart Hardware');
    expect(/[\u4e00-\u9fff]/.test(resolvedUnmapped)).toBe(false);

    const allChinese = resolveEffectiveCategory(
      { category: '自定义小众品牌品类' },
      { market: 'GLOBAL', localCategory: '中文当地品类' },
      unmappedLine,
    );
    expect(/[\u4e00-\u9fff]/.test(allChinese)).toBe(false);
    expect(allChinese).toBe('product');
  });

  it('preserves legacy fallback when productLine is null or undefined', () => {
    expect(resolveEffectiveCategory(brand, globalMarket, null)).toBe('Smart Hardware');
    expect(resolveEffectiveCategory(brand, globalMarket, undefined)).toBe('Smart Hardware');
    expect(resolveEffectiveCategory(brand, cnMarket, null)).toBe('消费电子');
    expect(resolveEffectiveCategory(brand, { market: 'CN', localCategory: null }, null)).toBe(
      '智能硬件',
    );
  });
});

describe('product-line JSON readers', () => {
  it('reads localized names, seed prompts, and competitors safely', () => {
    expect(
      resolveProductLineLocalName(
        { name: '星曜储能', localNamesJson: { GLOBAL: 'HeliosPower' } },
        'GLOBAL',
      ),
    ).toBe('HeliosPower');
    expect(resolveProductLineLocalName({ name: '星曜储能', localNamesJson: {} }, 'GLOBAL')).toBe(
      null,
    );
    expect(
      resolveProductLineLocalName(
        { name: '家用NAS线', localNamesJson: { GLOBAL: '中文海外名' } },
        'GLOBAL',
      ),
    ).toBe(null);
    expect(
      resolveProductLineLocalName(
        { name: 'NovaNAS', localNamesJson: { GLOBAL: '中文海外名' } },
        'GLOBAL',
      ),
    ).toBe('NovaNAS');
    expect(resolveProductLineLocalName({ name: '星曜储能', localNamesJson: {} }, 'CN')).toBe(
      '星曜储能',
    );

    expect(
      readProductLineMarketSeedPrompts(
        { GLOBAL: ['Query 1', 'query 1', '  ', 'Query 2'] },
        'GLOBAL',
      ),
    ).toEqual(['Query 1', 'Query 2']);
    expect(readProductLineMarketSeedPrompts(null, 'CN')).toEqual([]);

    expect(
      readProductLineMarketCompetitors(
        { GLOBAL: [{ name: 'EcoFlow', domains: ['ecoflow.com'] }, { invalid: true }] },
        'GLOBAL',
      ),
    ).toEqual([{ name: 'EcoFlow', aliases: [], domains: ['ecoflow.com'] }]);
  });
});
