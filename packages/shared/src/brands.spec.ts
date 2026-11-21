import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_RATIOS,
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  BRAND_FACT_FULL_INJECT_MAX,
  BRAND_FACT_SLOTS,
  BRAND_MAX_COMPETITORS,
  GEO_MARKETS,
  buildStorageSummary,
  checkImageWidthWarning,
  chunkKnowledgeText,
  classifyBrandCategorySegment,
  createBrandSchema,
  extractBrandFactsSchema,
  formatCompanyBrandLabel,
  formatGalleryBytes,
  generateBrandSeedPrompts,
  inlineAiImageGenSchema,
  isAiImageRatio,
  isPlaceholderImageModel,
  normalizeBrandDomain,
  requiresBrandFactVectorIndex,
  resolveAiImageRatioDimensions,
  sanitizeMediaOriginalName,
  updateBrandMarketSchema,
  updateBrandMediaSchema,
  updateBrandSchema,
  upsertBrandFactsSchema,
  validateClientUploadFile,
} from './brands';

describe('brands v2 contracts and extracted utilities', () => {
  it('validates createBrandSchema for single and dual markets and rejects duplicates, invalid domains, and >10 competitors', () => {
    expect(GEO_MARKETS).toEqual(['CN', 'GLOBAL']);
    expect(BRAND_FACT_CORE_SLOTS).toEqual([
      'PRODUCT_SPECS',
      'DIFFERENTIATORS',
      'CREDENTIALS',
      'CASE_STUDIES',
    ]);
    expect(BRAND_FACT_SLOTS).toEqual([
      'PRODUCT_SPECS',
      'DIFFERENTIATORS',
      'CREDENTIALS',
      'CASE_STUDIES',
      'EXTRA_DOC',
    ]);
    expect(BRAND_FACT_EXTRACT_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);

    const parsed = createBrandSchema.parse({
      name: '示例储能',
      category: '便携储能',
      aliases: ['示例电源', '示例电源'],
      ownedDomains: ['https://www.example.cn/products', 'example.cn'],
      markets: [
        {
          market: 'CN',
          localBrandName: '示例储能',
          ownedDomains: ['https://www.example.cn/products'],
          competitors: [{ name: '竞品甲', domains: ['https://www.rival.cn/path'] }],
        },
        'GLOBAL',
      ],
    });
    expect(parsed.markets).toHaveLength(2);
    expect(parsed.aliases).toEqual(['示例电源']);
    expect(parsed.ownedDomains).toEqual(['example.cn']);
    expect(parsed.markets[0]?.ownedDomains).toEqual(['example.cn']);
    expect(parsed.markets[0]?.competitors[0]?.domains).toEqual(['rival.cn']);

    expect(
      createBrandSchema.safeParse({
        name: '示例',
        category: '品类',
        markets: ['CN', 'CN'],
      }).success,
    ).toBe(false);

    // Rejects invalid domains in ownedDomains and competitors[].domains
    expect(
      createBrandSchema.safeParse({
        name: '示例',
        category: '品类',
        markets: ['CN'],
        ownedDomains: ['not-a-domain'],
      }).success,
    ).toBe(false);
    expect(
      createBrandSchema.safeParse({
        name: '示例',
        category: '品类',
        markets: ['CN'],
        competitors: [{ name: '竞品A', domains: ['javascript:alert(1)'] }],
      }).success,
    ).toBe(false);

    // Rejects > 10 competitors
    const tooManyCompetitors = Array.from({ length: BRAND_MAX_COMPETITORS + 1 }, (_, i) => ({
      name: `竞品${i + 1}`,
      domains: [],
    }));
    expect(
      createBrandSchema.safeParse({
        name: '示例',
        category: '品类',
        markets: ['CN'],
        competitors: tooManyCompetitors,
      }).success,
    ).toBe(false);
  });

  it('validates updateBrandSchema and partial updateBrandMarketSchema without wiping untouched arrays', () => {
    expect(updateBrandSchema.safeParse({}).success).toBe(false);
    expect(updateBrandSchema.safeParse({ name: '新品牌名' }).success).toBe(true);

    expect(updateBrandMarketSchema.safeParse({}).success).toBe(false);

    const partial = updateBrandMarketSchema.parse({ localBrandName: 'New Local Name' });
    expect(partial.localBrandName).toBe('New Local Name');
    expect(partial.aliases).toBeUndefined();
    expect(partial.ownedDomains).toBeUndefined();
    expect(partial.competitors).toBeUndefined();
    expect(partial.seedPrompts).toBeUndefined();

    const withCompetitors = updateBrandMarketSchema.parse({
      ownedDomains: ['https://WWW.Brand.io:8443/docs'],
      competitors: [{ name: 'Rival', domains: ['https://www.rival.io/'] }],
    });
    expect(withCompetitors.ownedDomains).toEqual(['brand.io']);
    expect(withCompetitors.competitors?.[0]?.domains).toEqual(['rival.io']);

    expect(
      updateBrandMarketSchema.safeParse({
        ownedDomains: ['localhost'],
      }).success,
    ).toBe(false);
  });

  it('validates facts upsert, extract, media update, and inline AI image gen schemas', () => {
    const parsedFacts = upsertBrandFactsSchema.parse({
      facts: [
        {
          slot: 'PRODUCT_SPECS',
          title: '硬件参数',
          content: '四盘位静音 NAS',
          sourceUrl: '',
        },
        {
          slot: 'DIFFERENTIATORS',
          content: '28dB 静音风道设计',
        },
      ],
      agreeTruthTerms: true,
    });
    expect(parsedFacts.agreeTruthTerms).toBe(true);
    expect(parsedFacts.facts[0]?.sourceUrl).toBeNull();
    expect(parsedFacts.facts[1]?.title).toBeUndefined();

    expect(
      extractBrandFactsSchema.safeParse({
        sourceType: 'URL_EXTRACT',
        url: 'https://example.com/specs',
      }).success,
    ).toBe(true);
    expect(
      extractBrandFactsSchema.safeParse({
        url: 'https://example.com/specs',
      }).success,
    ).toBe(true);
    expect(
      extractBrandFactsSchema.safeParse({
        text: '这是一段超过十个字的品牌核心产品规格与实测数据说明文档。',
      }).success,
    ).toBe(true);
    expect(extractBrandFactsSchema.safeParse({ sourceType: 'MANUAL' }).success).toBe(false);

    expect(updateBrandMediaSchema.safeParse({ title: 'DXP4800 前面板实拍图' }).success).toBe(true);
    expect(updateBrandMediaSchema.safeParse({ title: '   ' }).success).toBe(false);

    const img = inlineAiImageGenSchema.parse({ prompt: '极简桌面四盘位NAS产品实拍' });
    expect(img.ratio).toBe('16:9');
    expect(img.title).toBeUndefined();

    const imgWithAlias = inlineAiImageGenSchema.parse({
      prompt: '极简桌面四盘位NAS产品实拍',
      aspectRatio: '4:3',
      title: '   ',
      style: '',
    });
    expect(imgWithAlias.ratio).toBe('4:3');
    expect(imgWithAlias.title).toBeUndefined();
    expect(imgWithAlias.style).toBeUndefined();
  });

  it('normalizes domains with strict IPv4 octet check, chunks long facts, and formats company/brand labels', () => {
    expect(normalizeBrandDomain('https://WWW.Example.com:443/path?a=1')).toBe('example.com');
    expect(normalizeBrandDomain('//www.sub.example.cn/test#hash')).toBe('sub.example.cn');
    expect(normalizeBrandDomain('93.184.216.34')).toBe('93.184.216.34');
    expect(normalizeBrandDomain('999.999.999.999')).toBe('');
    expect(normalizeBrandDomain('256.0.0.1')).toBe('');
    expect(normalizeBrandDomain('javascript:alert(1)')).toBe('');
    expect(normalizeBrandDomain('ftp://example.com')).toBe('');
    expect(normalizeBrandDomain('ftp://example.com:99999/bad')).toBe('');
    expect(normalizeBrandDomain('ssh://example.com:99999')).toBe('');
    expect(normalizeBrandDomain('https://example.com:99999/path')).toBe('');
    expect(normalizeBrandDomain('example.com:99999/path')).toBe('');
    expect(normalizeBrandDomain('localhost')).toBe('');
    expect(normalizeBrandDomain('has space.com')).toBe('');

    expect(requiresBrandFactVectorIndex(BRAND_FACT_FULL_INJECT_MAX)).toBe(false);
    expect(requiresBrandFactVectorIndex(BRAND_FACT_FULL_INJECT_MAX + 1)).toBe(true);

    const longText = '这是一段用于测试切块的品牌核心技术参数说明。'.repeat(60);
    const chunks = chunkKnowledgeText(longText, 300, 50);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length > 0)).toBe(true);

    expect(formatCompanyBrandLabel('苏州示例科技有限公司', '示例科技')).toBe(
      '苏州示例科技有限公司（示例科技）',
    );
    expect(formatCompanyBrandLabel('示例科技（示例科技）', '示例科技')).toBe(
      '示例科技（示例科技）',
    );
  });

  it('generates category-aware CN/GLOBAL seedPrompts without B2B factory contamination for C-end categories (#313)', () => {
    const forbiddenCnB2b = /源头厂家|厂家|工厂|批发|代工|OEM|ODM|企业采购|中小团队采购|上门对接/;
    const forbiddenEnB2b =
      /factory|wholesale|\boem\b|\bodm\b|bulk supplier|enterprise procurement/i;

    for (const category of ['便携储能', '家用NAS', '智能相框', '咖啡机', '护肤品']) {
      expect(classifyBrandCategorySegment(category)).toBe('CONSUMER');

      const cnPrompts = generateBrandSeedPrompts({
        market: 'CN',
        brandName: '青松',
        category,
        competitors: [{ name: '极空间' }, { name: '群晖' }],
      });
      expect(cnPrompts.length).toBeGreaterThanOrEqual(5);
      expect(cnPrompts.every((p) => !forbiddenCnB2b.test(p))).toBe(true);
      expect(cnPrompts.some((p) => p.includes('极空间'))).toBe(true);

      const globalPrompts = generateBrandSeedPrompts({
        market: 'GLOBAL',
        brandName: 'PinePower',
        category,
        competitors: [{ name: 'Synology' }],
      });
      expect(globalPrompts.length).toBeGreaterThanOrEqual(5);
      expect(globalPrompts.every((p) => !forbiddenEnB2b.test(p))).toBe(true);
      expect(globalPrompts.every((p) => !/[\u4e00-\u9fff]/.test(p))).toBe(true);
      expect(globalPrompts.some((p) => p.includes('Synology'))).toBe(true);
    }

    expect(classifyBrandCategorySegment('企业软件 SaaS')).toBe('B2B_SAAS');
    expect(classifyBrandCategorySegment('工业数控机床')).toBe('B2B_INDUSTRIAL');

    const saasGlobal = generateBrandSeedPrompts({
      market: 'GLOBAL',
      brandName: 'AcmeCRM',
      category: 'Enterprise SaaS',
      competitors: [{ name: 'HubSpot' }],
    });
    expect(saasGlobal.some((p) => p.includes('HubSpot'))).toBe(true);

    const industrialCn = generateBrandSeedPrompts({
      market: 'CN',
      brandName: '智造激光',
      category: '工业激光切割设备',
      competitors: [{ name: '大族激光' }],
    });
    expect(industrialCn.some((p) => p.includes('大族激光'))).toBe(true);
  });

  it('validates media uploads, formats storage, and resolves AI image ratios', () => {
    expect(validateClientUploadFile({ name: 'a.png', size: 1024, type: 'image/png' })).toEqual({
      ok: true,
    });
    expect(validateClientUploadFile({ name: 'a.exe', size: 1024, type: 'application/x' }).ok).toBe(
      false,
    );
    expect(checkImageWidthWarning(320)).toContain('320px');
    expect(checkImageWidthWarning(800)).toBeUndefined();
    expect(formatGalleryBytes(1024n * 1024n)).toBe('1 MB');
    expect(buildStorageSummary(2048n, 1024n * 1024n).usedText).toBe('2 KB');
    expect(sanitizeMediaOriginalName('../path/to/photo.jpg')).toBe('photo.jpg');

    expect(AI_IMAGE_RATIOS).toContain('16:9');
    expect(isAiImageRatio('16:9')).toBe(true);
    expect(isAiImageRatio('99:1')).toBe(false);
    expect(resolveAiImageRatioDimensions('16:9')).toEqual({ width: 1280, height: 720 });
    expect(isPlaceholderImageModel('fake-image')).toBe(true);
    expect(isPlaceholderImageModel('dall-e-3')).toBe(false);
  });
});
