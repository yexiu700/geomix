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

  it('parses markdown links/images in linear O(N) time without ReDoS on incomplete links or pathological brackets', () => {
    const baseUrl = 'https://example.com/guides/nas-2026-review/';
    for (const len of [25, 100, 10_000]) {
      const longUrl =
        len <= baseUrl.length
          ? baseUrl.slice(0, len)
          : `${baseUrl}${'a'.repeat(len - baseUrl.length)}`;
      const incomplete = `[Read Guide](${longUrl}`;
      const t0 = performance.now();
      const html = markdownToSanitizedHtml(incomplete);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(100);
      expect(html).toContain('[Read Guide](');
      expect(html).not.toContain('<a ');
    }

    const pathological = '[[a]](('.repeat(15_000);
    const t1 = performance.now();
    const out = markdownToSanitizedHtml(pathological);
    const elapsedPathological = performance.now() - t1;
    expect(elapsedPathological).toBeLessThan(200);
    expect(out).not.toContain('<a ');

    const legit = markdownToSanitizedHtml(
      [
        '[wiki](https://en.wikipedia.org/wiki/NAS_(storage))',
        '[good](https://example.com/ok "Guide")',
        '[![CI](https://img.shields.io/badge.svg)](https://github.com/org/repo)',
        '[Best [2026] Guide](/guides/nas-2026)',
        '`[inline](javascript:alert(1))` **bold** *italic*',
        '[evil](javascript:alert("hi there")) ![bad](vbscript:msgbox(1))',
      ].join('\n'),
    );
    expect(legit).toContain('href="https://en.wikipedia.org/wiki/NAS_(storage)"');
    expect(legit).toContain('href="https://example.com/ok"');
    expect(legit).toContain('src="https://img.shields.io/badge.svg"');
    expect(legit).toContain('href="https://github.com/org/repo"');
    expect(legit).toContain('href="/guides/nas-2026"');
    expect(legit).toContain('<code>[inline](javascript:alert(1))</code>');
    expect(legit).toContain('<strong>bold</strong>');
    expect(legit).toContain('<em>italic</em>');
    expect(legit).not.toContain('href="javascript:');
    expect(legit).not.toContain('vbscript:');
  });

  it('normalizes bare CR line endings (CommonMark §2.2) and strips HTML tags in linear O(N) time', async () => {
    const { stripHtmlTagsLinear } = await import('./geo-studio');

    // Bare \r line endings in markdownToSanitizedHtml
    const crHtml = markdownToSanitizedHtml('```\na\n```\r<script>alert(1)</script>\n```');
    expect(crHtml).toContain('<pre><code>a</code></pre>');
    expect(crHtml).not.toContain('<script>');
    expect(crHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    const crHeading = markdownToSanitizedHtml('## Specs\r- Noise 18.5dB');
    expect(crHeading).toContain('<h2>Specs</h2>');
    expect(crHeading).toContain('<li>Noise 18.5dB</li>');

    // stripHtmlTagsLinear semantic parity & O(N) performance on 50k '<'
    expect(stripHtmlTagsLinear('a <> <b > c')).toBe('a <>  c');
    expect(stripHtmlTagsLinear('a <> <b > c', '', true)).toBe('a   c');
    expect(stripHtmlTagsLinear('a <b>c</b> d', ' ')).toBe('a  c  d');

    const lt50k = '<'.repeat(50_000);
    const t0 = performance.now();
    const text = stripHtmlToText(lt50k);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(text).toBe(lt50k);
  });

  it('strips inline JSON-LD script/fenced blocks and link-wrapped [待补充：...](#faq) suffixes (#339)', async () => {
    const {
      extractMissingFactSlots,
      replaceMissingFactSlot,
      stripInlineJsonLdBlocks,
      postProcessArticleMarkdown,
    } = await import('./geo-studio');

    // 1) Raw, HTML-escaped, fenced, and truncated JSON-LD blocks are stripped cleanly
    const rawMd = [
      '## Key Findings',
      '',
      'AstraVault delivers 14W idle power and 18.5dB acoustic noise.',
      '',
      '<script type="application/ld+json">',
      '{"@context":"https://schema.org","@type":"Article","headline":"Test"}',
      '</script>',
      '',
      '&lt;script type="application/ld+json"&gt;{"@context":"https://schema.org"}&lt;/script&gt;',
      '',
      '```json',
      '{"normalCodeExample": true}',
      '```',
      '',
      '## Structured Data (JSON-LD)',
      '',
      '```json-ld',
      '{"@context":"https://schema.org","@type":"FAQPage"}',
      '```',
      '',
      '```json',
      '{"@context":"https://schema.org","@type":"Product","name":"AstraVault"}',
      '```',
      '',
      '<script type="application/ld+json">{"@context":"https://schema.org","truncated":',
    ].join('\n');

    const stripped = stripInlineJsonLdBlocks(rawMd);
    expect(stripped).not.toContain('application/ld+json');
    expect(stripped).not.toContain('schema.org');
    expect(stripped).not.toContain('Structured Data (JSON-LD)');
    expect(stripped).toContain('{"normalCodeExample": true}');
    expect(stripped).toContain('AstraVault delivers 14W idle power');

    const processed = postProcessArticleMarkdown(rawMd, {
      market: 'GLOBAL',
      brand: 'AstraVault',
      question: 'Best 4-bay NAS?',
    });
    expect(processed.cleanedMarkdown).not.toContain('application/ld+json');
    expect(processed.cleanedMarkdown).not.toContain('schema.org');

    // 2) Link-wrapped [待补充：...](#faq) and [待补充:...](https://...) leave zero trailing URL suffix
    const linkedDraft =
      '详情见 [待补充：待机功耗数值](#faq) 以及 [待补充:满载噪音分贝](https://example.com/specs)。';
    const slots = extractMissingFactSlots(linkedDraft);
    expect(slots).toHaveLength(2);
    expect(slots[0]?.hint).toBe('待机功耗数值');
    expect(slots[0]?.raw).toBe('[待补充：待机功耗数值](#faq)');
    expect(slots[1]?.hint).toBe('满载噪音分贝');
    expect(slots[1]?.raw).toBe('[待补充:满载噪音分贝](https://example.com/specs)');

    const afterFirst = replaceMissingFactSlot(linkedDraft, slots[0]!, '14W');
    expect(afterFirst).not.toContain('(#faq)');
    expect(afterFirst).toContain('详情见 14W 以及');
    const slots2 = extractMissingFactSlots(afterFirst);
    const afterSecond = replaceMissingFactSlot(afterFirst, slots2[0]!, '18.5dB');
    expect(afterSecond).toBe('详情见 14W 以及 18.5dB。');
  });

  it('extracts both CN [待补充：...] and GLOBAL [TBD: ...] / [To be verified: ...] capsules and normalizes GLOBAL drafts (#343)', async () => {
    const {
      extractMissingFactSlots,
      normalizeMissingFactPlaceholdersForMarket,
      replaceMissingFactSlot,
    } = await import('./geo-studio');
    const enDraft =
      'Standby power is [TBD: Standby Power Draw W] and acoustic floor is [To be verified: Idle Noise dB].';
    const slots = extractMissingFactSlots(enDraft);
    expect(slots).toHaveLength(2);
    expect(slots[0]?.hint).toBe('Standby Power Draw W');
    expect(slots[1]?.hint).toBe('Idle Noise dB');
    expect(replaceMissingFactSlot(enDraft, slots[0]!, '12.5W')).toContain('Standby power is 12.5W');

    const leakedGlobal = '| Standby Power | [待补充：如待机功耗 W] | [待补充: Weight kg] |';
    const normalized = normalizeMissingFactPlaceholdersForMarket(leakedGlobal, 'GLOBAL');
    expect(normalized).not.toMatch(/[\u4e00-\u9fff]/);
    expect(normalized).toContain('[TBD: verify specification]');
    expect(normalized).toContain('[TBD: Weight kg]');
    expect(extractMissingFactSlots(normalized)).toHaveLength(2);
  });
});
