import { describe, expect, it } from 'vitest';
import {
  CN_RECOMMENDED_CHANNELS,
  GEO_BRIEF_SOURCES,
  GEO_BRIEF_STATUSES,
  GLOBAL_RECOMMENDED_CHANNELS,
  canonicalizeRewriteUrl,
  compareGeoBriefPriority,
  computeChar5GramJaccard,
  computeGeoBriefPriorityScore,
  computeRewriteUrlHash,
  defaultRecipeForBriefSource,
  extractArticleFromHtml,
  geoBriefFromCitationUrlSchema,
  geoBriefGenerateSchema,
  geoBriefListQuerySchema,
  geoBriefUpdateSchema,
  isPrivateOrReservedHostLiteral,
  normalizePastedSource,
  recommendBriefTargetFormat,
  recommendChannelsForMarket,
} from './geo-briefs';

describe('geo-briefs v2 contracts and extracted HTML/SSRF utilities', () => {
  it('validates brief generation, citation counter, list query, and update schemas', () => {
    expect(GEO_BRIEF_SOURCES).toContain('AUTO_GAP');
    expect(GEO_BRIEF_STATUSES).toEqual(['OPEN', 'WRITING', 'DONE', 'DISMISSED']);

    expect(
      geoBriefGenerateSchema.safeParse({
        market: 'CN',
        sourceType: 'AUTO_GAP',
        customPrompt: '2026 四盘位家用 NAS 推荐',
      }).success,
    ).toBe(true);

    // market is optional for single-market brands while still rejecting invalid enums
    expect(
      geoBriefGenerateSchema.safeParse({
        sourceType: 'MANUAL',
        customPrompt: '2026 四盘位家用 NAS 推荐',
      }).success,
    ).toBe(true);
    expect(
      geoBriefGenerateSchema.safeParse({
        market: 'EU',
        sourceType: 'MANUAL',
        customPrompt: '2026 四盘位家用 NAS 推荐',
      }).success,
    ).toBe(false);

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
        competitorFocus: ['竞品A', '竞品B'],
      }).success,
    ).toBe(true);
    expect(geoBriefUpdateSchema.safeParse({}).success).toBe(false);

    const parsedQuery = geoBriefListQuerySchema.parse({
      market: 'GLOBAL',
      status: 'OPEN',
      includeDismissed: 'true',
      page: '2',
      pageSize: '25',
    });
    expect(parsedQuery).toEqual({
      market: 'GLOBAL',
      status: 'OPEN',
      includeDismissed: true,
      page: 2,
      pageSize: 25,
    });
    expect(geoBriefListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(geoBriefListQuerySchema.safeParse({ includeDismissed: 'maybe' }).success).toBe(false);
    expect(geoBriefListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(geoBriefListQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });

  it('computes PRD §4.3 priority tiers and compares briefs deterministically', () => {
    const p1Multi = computeGeoBriefPriorityScore({
      sourceType: 'AUTO_GAP',
      competitorEngineHits: 2,
      competitorCount: 2,
    });
    const p1Single = computeGeoBriefPriorityScore({
      sourceType: 'AUTO_GAP',
      competitorEngineHits: 1,
      competitorCount: 2,
    });
    const p1Blindspot = computeGeoBriefPriorityScore({
      sourceType: 'AUTO_GAP',
      competitorEngineHits: 0,
    });
    const p2Neg = computeGeoBriefPriorityScore({
      sourceType: 'SENTIMENT_RISK',
      negativeCount: 1,
    });
    const p2Mix = computeGeoBriefPriorityScore({
      sourceType: 'SENTIMENT_RISK',
      mixedCount: 2,
    });
    const p3LowRank = computeGeoBriefPriorityScore({
      sourceType: 'LOW_RANK',
      avgPosition: 4,
      competitorEngineHits: 2,
    });
    const p5Counter = computeGeoBriefPriorityScore({
      sourceType: 'CITATION_COUNTER',
      citationCount: 2,
      ownedCitationCount: 0,
      isCompetitorSource: true,
    });
    const p4FanOut = computeGeoBriefPriorityScore({
      sourceType: 'FANOUT_CLUSTER',
      fanOutCount: 4,
    });
    const manual = computeGeoBriefPriorityScore({ sourceType: 'MANUAL' });

    expect(p1Multi).toBeGreaterThanOrEqual(95);
    expect(p1Multi).toBeLessThanOrEqual(100);
    expect(p1Single).toBeGreaterThanOrEqual(90);
    expect(p1Single).toBeLessThanOrEqual(94);
    expect(p1Blindspot).toBe(90);

    expect(p2Neg).toBeGreaterThanOrEqual(85);
    expect(p2Neg).toBeLessThanOrEqual(89);
    expect(p2Mix).toBeGreaterThanOrEqual(80);
    expect(p2Mix).toBeLessThanOrEqual(84);

    expect(p3LowRank).toBeGreaterThanOrEqual(70);
    expect(p3LowRank).toBeLessThanOrEqual(79);

    expect(p5Counter).toBeGreaterThanOrEqual(60);
    expect(p5Counter).toBeLessThanOrEqual(75);

    expect(p4FanOut).toBeGreaterThanOrEqual(60);
    expect(p4FanOut).toBeLessThanOrEqual(69);

    expect(manual).toBe(55);
    expect(p1Multi).toBeGreaterThan(p1Single);
    expect(p1Single).toBeGreaterThan(p2Neg);
    expect(p2Neg).toBeGreaterThan(p2Mix);
    expect(p2Mix).toBeGreaterThan(p3LowRank);
    expect(p3LowRank).toBeGreaterThan(p4FanOut);

    const sorted = [
      {
        id: 'low',
        priorityScore: 75,
        sourceType: 'LOW_RANK' as const,
        createdAt: '2026-11-20T01:00:00Z',
      },
      {
        id: 'gap',
        priorityScore: 95,
        sourceType: 'AUTO_GAP' as const,
        createdAt: '2026-11-20T00:00:00Z',
      },
      {
        id: 'risk',
        priorityScore: 87,
        sourceType: 'SENTIMENT_RISK' as const,
        createdAt: '2026-11-20T02:00:00Z',
      },
    ].sort(compareGeoBriefPriority);
    expect(sorted.map((s) => s.id)).toEqual(['gap', 'risk', 'low']);
  });

  it('selects default recipes, market target formats, and strictly isolated CN vs GLOBAL channels', () => {
    expect(defaultRecipeForBriefSource('AUTO_GAP')).toBe('AUTHORITY_GUIDE');
    expect(defaultRecipeForBriefSource('SENTIMENT_RISK')).toBe('OBJECTION_FAQ');
    expect(defaultRecipeForBriefSource('LOW_RANK')).toBe('COMPARISON_MATRIX');
    expect(defaultRecipeForBriefSource('CITATION_COUNTER')).toBe('CITATION_COUNTER');
    expect(defaultRecipeForBriefSource('FANOUT_CLUSTER')).toBe('AUTHORITY_GUIDE');
    expect(defaultRecipeForBriefSource('MANUAL')).toBe('AUTHORITY_GUIDE');

    expect(recommendBriefTargetFormat('CN', 'AUTO_GAP')).toBe('CN_DEEP_REVIEW');
    expect(recommendBriefTargetFormat('CN', 'SENTIMENT_RISK')).toBe('CN_COMMUNITY_QA');
    expect(recommendBriefTargetFormat('GLOBAL', 'AUTO_GAP')).toBe('GLOBAL_AUTHORITY_GUIDE');
    expect(recommendBriefTargetFormat('GLOBAL', 'SENTIMENT_RISK')).toBe(
      'GLOBAL_COMMUNITY_DISCUSSION',
    );

    const cnForbiddenInGlobal = ['小红书', '什么值得买', '知乎', '字节头条', '微信公众号'];
    for (const sourceType of GEO_BRIEF_SOURCES) {
      const globalChannels = recommendChannelsForMarket('GLOBAL', {
        sourceType,
        citationsEmpty: true,
      });
      expect(globalChannels.length).toBeGreaterThanOrEqual(2);
      for (const ch of globalChannels) {
        expect(GLOBAL_RECOMMENDED_CHANNELS).toContain(ch.channel);
        for (const forbidden of cnForbiddenInGlobal) {
          expect(ch.channel).not.toContain(forbidden);
          expect(ch.reason).not.toContain(forbidden);
        }
      }

      const cnChannels = recommendChannelsForMarket('CN', { sourceType, citationsEmpty: true });
      expect(cnChannels.length).toBeGreaterThanOrEqual(2);
      for (const ch of cnChannels) {
        expect(CN_RECOMMENDED_CHANNELS).toContain(ch.channel);
      }
    }
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
