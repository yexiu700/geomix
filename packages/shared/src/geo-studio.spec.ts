import { describe, expect, it } from 'vitest';
import {
  GEO_RECIPES,
  GEO_TARGET_FORMATS,
  cleanTitleText,
  defaultTargetFormatForMarket,
  geoArticleStreamSchema,
  geoBatchCreateSchema,
  geoRewriteSectionSchema,
  markdownToSanitizedHtml,
  postProcessArticleMarkdown,
  promptPreferenceSchema,
  stripHtmlToText,
  targetFormatsForMarket,
} from './geo-studio';

describe('geo-studio v2 contracts and extracted markdown helpers', () => {
  it('maps market target formats and validates stream/batch/rewrite/preference schemas', () => {
    expect(GEO_RECIPES).toEqual([
      'AUTHORITY_GUIDE',
      'COMPARISON_MATRIX',
      'OBJECTION_FAQ',
      'CITATION_COUNTER',
    ]);
    expect(GEO_TARGET_FORMATS).toHaveLength(4);
    expect(targetFormatsForMarket('CN')).toEqual(['CN_DEEP_REVIEW', 'CN_COMMUNITY_QA']);
    expect(targetFormatsForMarket('GLOBAL')).toEqual([
      'GLOBAL_AUTHORITY_GUIDE',
      'GLOBAL_COMMUNITY_DISCUSSION',
    ]);
    expect(defaultTargetFormatForMarket('CN')).toBe('CN_DEEP_REVIEW');
    expect(defaultTargetFormatForMarket('GLOBAL')).toBe('GLOBAL_AUTHORITY_GUIDE');

    expect(
      geoArticleStreamSchema.safeParse({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '四盘位家用 NAS 怎么选',
      }).success,
    ).toBe(true);
    expect(
      geoArticleStreamSchema.safeParse({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetPrompt: '四盘位家用 NAS 怎么选',
      }).success,
    ).toBe(false);
    expect(
      geoArticleStreamSchema.safeParse({
        market: 'GLOBAL',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_COMMUNITY_QA',
        targetPrompt: 'Best 4-bay home NAS 2026',
      }).success,
    ).toBe(false);

    expect(geoBatchCreateSchema.safeParse({ market: 'CN', briefIds: ['b1'] }).success).toBe(false);
    expect(geoBatchCreateSchema.safeParse({ market: 'CN', briefIds: ['b1', 'b1'] }).success).toBe(
      false,
    );
    expect(
      geoBatchCreateSchema.safeParse({
        market: 'CN',
        briefIds: ['b1', 'b2'],
        targetFormat: 'GLOBAL_COMMUNITY_DISCUSSION',
      }).success,
    ).toBe(false);
    expect(
      geoBatchCreateSchema.safeParse({
        market: 'CN',
        briefIds: ['b1', 'b2'],
        targetFormat: 'CN_DEEP_REVIEW',
      }).success,
    ).toBe(true);

    expect(
      geoRewriteSectionSchema.safeParse({
        selectedText: '产品表现不错。',
        action: 'DE_AD',
      }).success,
    ).toBe(true);

    expect(
      promptPreferenceSchema.safeParse({
        customToneNote: '客观技术评测风格',
        customForbiddenWords: ['全网最低'],
      }).success,
    ).toBe(true);
  });

  it('cleans titles, converts markdown to sanitized HTML, and post-processes articles', () => {
    expect(cleanTitleText('# 《2026 四盘位家用 NAS 实测选购指南》', '家用 NAS 怎么选')).toBe(
      '2026 四盘位家用 NAS 实测选购指南',
    );

    const html = markdownToSanitizedHtml('## 核心参数\n\n- 噪音 **24 dB**\n- <script>x</script>');
    expect(html).toContain('<h2>核心参数</h2>');
    expect(html).toContain('<strong>24 dB</strong>');
    expect(html).not.toContain('<script>');
    expect(stripHtmlToText(html)).toContain('核心参数');

    const processed = postProcessArticleMarkdown(
      '好的，以下为您整理：\n# 重复标题\n正文内容包含联系 13800138000 和 https://evil.example',
      { question: '静音表现如何？', brand: '示例品牌' },
    );
    expect(processed.cleanedMarkdown).not.toContain('13800138000');
    expect(processed.cleanedMarkdown).not.toContain('https://evil.example');
    expect(processed.cleanedMarkdown).toContain('## 常见问题（FAQ）');
    expect(processed.charCount).toBeGreaterThan(10);
  });
});
