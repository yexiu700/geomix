import { describe, expect, it } from 'vitest';
import {
  GEO_BRIEF_SOURCES,
  GEO_BRIEF_STATUSES,
  canonicalizeRewriteUrl,
  computeChar5GramJaccard,
  computeRewriteUrlHash,
  extractArticleFromHtml,
  geoBriefFromCitationUrlSchema,
  geoBriefGenerateSchema,
  geoBriefUpdateSchema,
  isPrivateOrReservedHostLiteral,
  normalizePastedSource,
} from './geo-briefs';

describe('geo-briefs v2 contracts and extracted HTML/SSRF utilities', () => {
  it('validates brief generation, citation counter, and update schemas', () => {
    expect(GEO_BRIEF_SOURCES).toContain('AUTO_GAP');
    expect(GEO_BRIEF_STATUSES).toEqual(['OPEN', 'WRITING', 'DONE', 'DISMISSED']);

    expect(
      geoBriefGenerateSchema.safeParse({
        market: 'CN',
        sourceType: 'AUTO_GAP',
        customPrompt: '2026 四盘位家用 NAS 推荐',
      }).success,
    ).toBe(true);

    expect(
      geoBriefFromCitationUrlSchema.safeParse({
        market: 'GLOBAL',
        citationUrl: 'https://example.com/nas-review',
      }).success,
    ).toBe(true);
    expect(geoBriefFromCitationUrlSchema.safeParse({ market: 'GLOBAL' }).success).toBe(false);

    expect(
      geoBriefUpdateSchema.safeParse({
        status: 'WRITING',
        suggestedTitle: '2026 家用四盘位 NAS 选购指南',
      }).success,
    ).toBe(true);
  });

  it('canonicalizes URLs, checks SSRF literals, extracts HTML articles, and computes 5-gram Jaccard', () => {
    const clean = canonicalizeRewriteUrl('https://Example.COM/p/1?b=2&utm_source=x&a=1#frag');
    expect(clean).toBe('https://example.com/p/1?a=1&b=2');
    expect(computeRewriteUrlHash(clean)).toHaveLength(64);

    expect(isPrivateOrReservedHostLiteral('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('localhost')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('[::ffff:7f00:1]')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('0:0:0:0:0:0:0:0')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('::0')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('fe80::1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('febf::1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('64:ff9b:1::1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('::ffff:0:10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostLiteral('example.com')).toBe(false);
    expect(isPrivateOrReservedHostLiteral('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateOrReservedHostLiteral('[2606:4700:4700::1111]')).toBe(false);
    expect(isPrivateOrReservedHostLiteral('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHostLiteral('[::ffff:0808:0808]')).toBe(false);

    const extracted = extractArticleFromHtml(
      '<html><head><title>测试评测 - 科技网</title></head><body><article><h1>测试评测</h1><p>这是一段关于四盘位家用私有云噪音、功耗和吞吐量的详细实测记录。</p><img src="x.jpg"/><script>evil()</script></article></body></html>',
      'https://example.com/review',
    );
    expect(extracted.site).toBe('generic');
    expect(extracted.title).toBe('测试评测');
    expect(extracted.contentText).toContain('四盘位家用私有云');
    expect(extracted.contentText).not.toContain('evil()');

    const pasted = normalizePastedSource({
      pastedTitle: '手工参考',
      pastedContent: '<p>正文第一段</p><p>正文第二段</p>',
    });
    expect(pasted.title).toBe('手工参考');
    expect(pasted.contentText).toContain('正文第一段');

    const same = computeChar5GramJaccard(
      '这是一段测试重复度的中文示例文本',
      '这是一段测试重复度的中文示例文本',
    );
    const diff = computeChar5GramJaccard(
      '这是一段测试重复度的中文示例文本',
      '完全不相关的另一段产品规格描述',
    );
    expect(same).toBe(1);
    expect(diff).toBeLessThan(0.2);
  });
});
