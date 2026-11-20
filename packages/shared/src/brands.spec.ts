import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_RATIOS,
  BRAND_FACT_FULL_INJECT_MAX,
  BRAND_FACT_SLOTS,
  GEO_MARKETS,
  buildStorageSummary,
  checkImageWidthWarning,
  chunkKnowledgeText,
  createBrandSchema,
  extractBrandFactsSchema,
  formatCompanyBrandLabel,
  formatGalleryBytes,
  inlineAiImageGenSchema,
  isAiImageRatio,
  isPlaceholderImageModel,
  normalizeBrandDomain,
  requiresBrandFactVectorIndex,
  resolveAiImageRatioDimensions,
  sanitizeMediaOriginalName,
  upsertBrandFactsSchema,
  validateClientUploadFile,
} from './brands';

describe('brands v2 contracts and extracted utilities', () => {
  it('validates createBrandSchema for single and dual markets and rejects duplicates', () => {
    expect(GEO_MARKETS).toEqual(['CN', 'GLOBAL']);
    expect(BRAND_FACT_SLOTS).toEqual([
      'PRODUCT_SPECS',
      'DIFFERENTIATORS',
      'CREDENTIALS',
      'CASE_STUDIES',
      'EXTRA_DOC',
    ]);

    const parsed = createBrandSchema.parse({
      name: '示例储能',
      category: '便携储能',
      markets: [
        {
          market: 'CN',
          localBrandName: '示例储能',
          ownedDomains: ['https://www.example.cn/products'],
          competitors: [{ name: '竞品甲', domains: ['https://www.rival.cn'] }],
        },
        'GLOBAL',
      ],
    });
    expect(parsed.markets).toHaveLength(2);
    expect(parsed.markets[0]?.competitors[0]?.domains).toEqual(['rival.cn']);

    expect(
      createBrandSchema.safeParse({
        name: '示例',
        category: '品类',
        markets: ['CN', 'CN'],
      }).success,
    ).toBe(false);
  });

  it('validates facts upsert, extract, and inline AI image gen schemas', () => {
    expect(
      upsertBrandFactsSchema.safeParse({
        facts: [{ slot: 'PRODUCT_SPECS', title: '硬件参数', content: '四盘位静音 NAS' }],
        truthAgreed: true,
      }).success,
    ).toBe(true);

    expect(
      extractBrandFactsSchema.safeParse({
        sourceType: 'URL_EXTRACT',
        url: 'https://example.com/specs',
      }).success,
    ).toBe(true);
    expect(extractBrandFactsSchema.safeParse({ sourceType: 'MANUAL' }).success).toBe(false);

    const img = inlineAiImageGenSchema.parse({ prompt: '极简桌面四盘位NAS产品实拍' });
    expect(img.ratio).toBe('16:9');
  });

  it('normalizes domains, chunks long facts, and formats company/brand labels', () => {
    expect(normalizeBrandDomain('https://WWW.Example.com:443/path?a=1')).toBe('example.com');
    expect(normalizeBrandDomain('javascript:alert(1)')).toBe('');
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
