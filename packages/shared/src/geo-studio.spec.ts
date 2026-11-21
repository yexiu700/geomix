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

  it('renders GFM tables, code blocks, safe images/links, and neutralizes XSS payloads', () => {
    const md = [
      '## 对比表',
      '',
      '| 型号 | 功耗 | 噪音 |',
      '| --- | :---: | ---: |',
      '| **DXP4800** | `14W` | 18.5dB |',
      '| CompX | 28W | <img src=x onerror=alert(1)> |',
      '',
      '![产品图](https://cdn.example.com/nas.png) ![bad](javascript:alert(1)) ![bs](/\\evil.example/p.png)',
      '[官网](https://example.com) [xss](javascript:alert(2)) [data](data:text/html,hi) [bslink](/\\evil.example)',
      '',
      '```json',
      '{"x":"<script>alert(3)</script>"}',
      '```',
    ].join('\n');

    const html = markdownToSanitizedHtml(md);
    expect(html).toContain(
      '<table><thead><tr><th>型号</th><th>功耗</th><th>噪音</th></tr></thead>',
    );
    expect(html).toContain('<td><strong>DXP4800</strong></td>');
    expect(html).toContain('<td><code>14W</code></td>');
    expect(html).toContain('<img src="https://cdn.example.com/nas.png" alt="产品图"');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('bad)');

    const delHtml = markdownToSanitizedHtml(
      '![del](/api/v2/brands/b1/media/m1/file\u007ftest) [delLink](/api/\u007ftest)',
    );
    expect(delHtml).not.toContain('<img');
    expect(delHtml).not.toContain('<a ');
  });

  it('extracts and replaces missing-fact capsules and preserves GLOBAL markdown & images', async () => {
    const { extractMissingFactSlots, replaceMissingFactSlot } = await import('./geo-studio');
    const draft = '待机实测 [待补充：如待机功耗 W]，满载噪音 [待补充:如满载噪音 dB]。';
    const slots = extractMissingFactSlots(draft);
    expect(slots).toHaveLength(2);
    expect(slots[0]?.hint).toBe('如待机功耗 W');
    expect(slots[1]?.hint).toBe('如满载噪音 dB');

    const filled = replaceMissingFactSlot(draft, slots[0]!, '12.5W');
    expect(filled).toContain('待机实测 12.5W');
    expect(filled).toContain('[待补充:如满载噪音 dB]');

    const globalProcessed = postProcessArticleMarkdown(
      'Best 4-bay NAS with 100% aluminum chassis.\n\n![Photo](https://cdn.example.com/p.jpg)',
      { market: 'GLOBAL', brand: 'AstraVault', question: 'Best 4-bay NAS?' },
    );
    expect(globalProcessed.cleanedMarkdown).toContain('![Photo](https://cdn.example.com/p.jpg)');
    expect(globalProcessed.cleanedMarkdown).not.toContain('常见问题');
    expect(globalProcessed.cleanedMarkdown).toContain('Frequently Asked Questions (FAQ)');
  });
});
