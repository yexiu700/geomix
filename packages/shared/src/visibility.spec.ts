// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { describe, expect, it } from 'vitest';
import { MODEL_INCLUSION_CARDS } from './account';
import {
  CITATION_SOURCE_KINDS,
  CITATION_SOURCE_PRIORITY,
  DOMESTIC_VISIBILITY_ENGINE_KEYS,
  GLOBAL_VISIBILITY_ENGINE_KEYS,
  VISIBILITY_COLLECTOR_KINDS,
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINES_BY_MARKET,
  VISIBILITY_SENTIMENTS,
  enginesForMarket,
  enginesMetaForMarket,
  findDisallowedMarketEngines,
  formatVisibilityEngineDisplayLabel,
  isEngineAllowedForMarket,
  assessAnswerTopicRelevance,
  classifyCitationSource,
  computeAvgPosition,
  computeSentimentSummary,
  computeShareOfVoice,
  computeVisibilityPct,
  extractEvidencePassages,
  extractStructuredRecommendationItems,
  filterKeywordsForVisibilityProfile,
  findQuestionEchoIntroEnd,
  findSubjectMentionOffsets,
  formatVisibilityRunSubmitLabel,
  hasMultipleDistinctProfileBrands,
  importQuestionsInputSchema,
  isCitationSourceKind,
  isVisibilityCollectorKind,
  isVisibilityEngine,
  isVisibilitySentiment,
  matchesDomain,
  matchesVisibilityProfileKeyword,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  parseVisibilityCitationQuery,
  parseVisibilityOpportunitiesQuery,
  parseVisibilityOverviewQuery,
  parseVisibilityRunListQuery,
  parseVisibilityV2CitationQuery,
  parseVisibilityV2OpportunitiesQuery,
  parseVisibilityV2OverviewQuery,
  parseVisibilityV2RunListQuery,
  quoteVisibilityRunPoints,
  rankTrackedSubjects,
  recomputeRunMetrics,
  resolveDefaultKeywordIdForProfile,
  resolveScopedOverviewKeywords,
  resolveStructuredSubjectRanks,
  visibilityProfileCreateSchema,
  visibilityProfileUpdateSchema,
  visibilityRunCreateSchema,
  visibilityRunV2CreateSchema,
  visibilityV2CitationQuerySchema,
  visibilityV2OpportunitiesQuerySchema,
  visibilityV2OverviewQuerySchema,
  visibilityV2RunListQuerySchema,
  wholeWordPattern,
} from './visibility';

describe('visibility engines and constants', () => {
  it('aligns the 4 active domestic engines with MODEL_INCLUSION_CARDS plus 5 global engines while keeping retired labels for history (#411)', () => {
    const activeDomestic = VISIBILITY_ENGINES_BY_MARKET.CN;
    const global = VISIBILITY_ENGINES.filter((item) => !item.domestic);

    expect(activeDomestic.map((item) => ({ key: item.key, label: item.label }))).toEqual(
      MODEL_INCLUSION_CARDS.map((item) => ({ key: item.key, label: item.label })),
    );
    expect(DOMESTIC_VISIBILITY_ENGINE_KEYS).toEqual(['deepseek', 'doubao', 'yuanbao', 'tongyi']);
    expect(DOMESTIC_VISIBILITY_ENGINE_KEYS).toHaveLength(4);
    expect(global.map((item) => item.key)).toEqual([
      'chatgpt',
      'perplexity',
      'claude',
      'gemini',
      'google_aio',
    ]);
    expect(isVisibilityEngine('deepseek')).toBe(true);
    expect(isVisibilityEngine('google_aio')).toBe(true);
    // Retired CN engines stay recognized by isVisibilityEngine for historical records
    expect(isVisibilityEngine('kimi')).toBe(true);
    expect(isVisibilityEngine('wenxin')).toBe(true);
    expect(isVisibilityEngine('zhipu')).toBe(true);
    expect(isVisibilityEngine('nami')).toBe(true);
    expect(isVisibilityEngine('unknown_engine')).toBe(false);
    expect(VISIBILITY_SENTIMENTS).toEqual(['positive', 'neutral', 'mixed', 'negative']);
    expect(CITATION_SOURCE_KINDS).toEqual([
      'OWNED',
      'COMPETITOR',
      'SOCIAL',
      'AUTHORITY',
      'ECOMMERCE',
      'OTHER',
    ]);
    expect(GLOBAL_VISIBILITY_ENGINE_KEYS).toEqual([
      'chatgpt',
      'perplexity',
      'claude',
      'gemini',
      'google_aio',
    ]);
    expect(enginesForMarket('CN')).toHaveLength(4);
    expect(enginesForMarket('GLOBAL')).toHaveLength(5);
    expect(isEngineAllowedForMarket('deepseek', 'CN')).toBe(true);
    expect(isEngineAllowedForMarket('kimi', 'CN')).toBe(false);
    expect(isEngineAllowedForMarket('wenxin', 'CN')).toBe(false);
    expect(isEngineAllowedForMarket('deepseek', 'GLOBAL')).toBe(false);
    expect(isEngineAllowedForMarket('perplexity', 'GLOBAL')).toBe(true);
    expect(isEngineAllowedForMarket('perplexity', 'CN')).toBe(false);
    expect(VISIBILITY_COLLECTOR_KINDS).toEqual(['fake', 'llm_api', 'remote_scraper']);
    expect(isVisibilitySentiment('positive')).toBe(true);
    expect(isVisibilitySentiment('neutral_bad')).toBe(false);
    expect(isCitationSourceKind('OWNED')).toBe(true);
    expect(isCitationSourceKind('ECOMMERCE')).toBe(true);
    expect(isCitationSourceKind('UNKNOWN')).toBe(false);
    expect(isVisibilityCollectorKind('fake')).toBe(true);
    expect(isVisibilityCollectorKind('invalid_driver')).toBe(false);
    expect(classifyCitationSource('https://item.jd.com/1001.html')).toBe('ECOMMERCE');
    expect(classifyCitationSource('https://www.amazon.com/dp/B001')).toBe('ECOMMERCE');
    expect(classifyCitationSource('https://m.weibo.cn/status/123')).toBe('SOCIAL');
    expect(classifyCitationSource('https://post.smzdm.com/p/123')).toBe('SOCIAL');
    // #345: cross-market union of ownedDomains classifies sibling market official subdomains as OWNED
    expect(
      classifyCitationSource('https://jp.examplebrand.com/products/x1', {
        ownedDomains: ['examplebrand.com.cn', 'examplebrand.com'],
      }),
    ).toBe('OWNED');
    expect(
      normalizeFanOutQueries(
        ['NAS 推荐; 家庭私有云对比；四盘位 NAS 静音\nNAS 推荐'],
        '家用 NAS 怎么选',
      ),
    ).toEqual(['NAS 推荐', '家庭私有云对比', '四盘位 NAS 静音']);
  });
});

describe('domain normalization and citation source classification', () => {
  it('normalizes URLs, strips www./ports/paths, and rejects malformed inputs safely', () => {
    expect(normalizeVisibilityDomain('https://WWW.ZhiHu.com:443/question/123?utm=1#ans')).toBe(
      'zhihu.com',
    );
    expect(normalizeVisibilityDomain('http://mp.weixin.qq.com/s/abc')).toBe('mp.weixin.qq.com');
    expect(normalizeVisibilityDomain('//Docs.GeoMix.CN./guide/start')).toBe('docs.geomix.cn');
    expect(normalizeVisibilityDomain('www.36kr.com:8080/p/999')).toBe('36kr.com');
    expect(normalizeVisibilityDomain('')).toBe('');
    expect(normalizeVisibilityDomain('   ')).toBe('');
    expect(normalizeVisibilityDomain('not a url with spaces')).toBe('');
    expect(normalizeVisibilityDomain('javascript:alert(1)')).toBe('');
    expect(normalizeVisibilityDomain('mailto:hello@geomix.cn')).toBe('');
    expect(normalizeVisibilityDomain('localhost')).toBe('');
  });

  it('matches exact and subdomain candidates without matching sibling prefixes', () => {
    expect(matchesDomain('geomix.cn', 'geomix.cn')).toBe(true);
    expect(matchesDomain('https://docs.geomix.cn/api', 'geomix.cn')).toBe(true);
    expect(matchesDomain('blog.sub.geomix.cn', 'https://www.geomix.cn')).toBe(true);
    expect(matchesDomain('mygeomix.cn', 'geomix.cn')).toBe(false);
    expect(matchesDomain('geomix.cn.evil.com', 'geomix.cn')).toBe(false);
    expect(matchesDomain('', 'geomix.cn')).toBe(false);
  });

  it('enforces OWNED > COMPETITOR > SOCIAL > AUTHORITY > OTHER precedence', () => {
    const context = {
      ownedDomains: ['geomix.cn', 'mybrand.org'],
      competitorDomains: ['rival.com', 'rival-open.org'],
    };

    expect(classifyCitationSource('https://help.geomix.cn/doc/1', context)).toBe('OWNED');
    // Owned .org beats AUTHORITY .org TLD
    expect(classifyCitationSource('https://www.mybrand.org/about', context)).toBe('OWNED');
    // Owned beats COMPETITOR if accidentally listed in both
    expect(
      classifyCitationSource('https://geomix.cn', {
        ownedDomains: ['geomix.cn'],
        competitorDomains: ['geomix.cn'],
      }),
    ).toBe('OWNED');
    // Competitor .org beats AUTHORITY .org TLD
    expect(classifyCitationSource('https://docs.rival-open.org/v1', context)).toBe('COMPETITOR');
    expect(classifyCitationSource('https://www.rival.com/pricing', context)).toBe('COMPETITOR');

    // Domestic & global social platforms
    expect(classifyCitationSource('https://zhuanlan.zhihu.com/p/123', context)).toBe('SOCIAL');
    expect(classifyCitationSource('https://www.xiaohongshu.com/explore/1', context)).toBe('SOCIAL');
    expect(classifyCitationSource('https://mp.weixin.qq.com/s/xyz', context)).toBe('SOCIAL');
    expect(classifyCitationSource('https://tieba.baidu.com/p/456', context)).toBe('SOCIAL');
    expect(classifyCitationSource('https://www.reddit.com/r/seo', context)).toBe('SOCIAL');
    expect(classifyCitationSource('https://youtu.be/dQw4w9WgXcQ', context)).toBe('SOCIAL');

    // Authority encyclopedias, gov/edu TLDs, tech media
    expect(classifyCitationSource('https://baike.baidu.com/item/GEO', context)).toBe('AUTHORITY');
    expect(classifyCitationSource('https://zh.wikipedia.org/wiki/AI', context)).toBe('AUTHORITY');
    expect(classifyCitationSource('https://www.miit.gov.cn/policy', context)).toBe('AUTHORITY');
    expect(classifyCitationSource('https://cs.tsinghua.edu.cn/lab', context)).toBe('AUTHORITY');
    expect(classifyCitationSource('https://36kr.com/p/1024', context)).toBe('AUTHORITY');
    expect(classifyCitationSource('https://github.com/elmohq/elmo', context)).toBe('AUTHORITY');

    // Uncategorized & malformed
    expect(classifyCitationSource('https://random-saas-directory.io/list', context)).toBe('OTHER');
    expect(classifyCitationSource('not a valid url', context)).toBe('OTHER');
  });
});

describe('CJK-aware mention matching, passages, and 1-based ranking', () => {
  it('avoids English inner-word false positives while matching CJK adjacency', () => {
    const acePattern = wholeWordPattern('ace');
    expect('This is a great place to surface ideas.'.match(acePattern)).toBeNull();
    expect('Ace Hardware and ACE tools lead the list.'.match(acePattern)).toHaveLength(2);
    expect('推荐试试Ace智能助手，非常好用。'.match(acePattern)).toHaveLength(1);

    const geoMixPattern = wholeWordPattern('GeoMix');
    expect('SuperGeoMixPro does not match'.match(geoMixPattern)).toBeNull();
    expect(
      'GeoMix是一款面向企业的GEO系统，使用GeoMix可提升可见性。'.match(geoMixPattern),
    ).toHaveLength(2);

    const cjkPattern = wholeWordPattern('极米');
    expect('家用投影仪推荐极米H6与极米RS10，画质清晰。'.match(cjkPattern)).toHaveLength(2);
  });

  it('finds text mention offsets and falls back to citation domain match when absent from text', () => {
    const subject = {
      name: 'GeoMix',
      aliases: ['吉奥米克斯'],
      domains: ['geomix.cn'],
    };

    const text = '目前市面上主流方案包括友商A，其次是GeoMix（又称吉奥米克斯），综合体验稳定。';
    const offsets = findSubjectMentionOffsets(text, subject);
    expect(offsets).toEqual([text.indexOf('GeoMix'), text.indexOf('吉奥米克斯')]);

    // Domain-only mention via citedUrls
    const noMentionText = '这款企业级智能内容运营工具在多个评测维度表现优异。';
    expect(findSubjectMentionOffsets(noMentionText, subject)).toEqual([]);
    expect(
      findSubjectMentionOffsets(noMentionText, subject, [
        'https://36kr.com/p/1',
        'https://docs.geomix.cn/whitepaper',
      ]),
    ).toEqual([noMentionText.length + 1]);
  });

  it('extracts concise, deduplicated evidence passages around brand mentions', () => {
    const text =
      '第一段介绍行业趋势，不涉及任何具体厂商。第二段重点对比：GeoMix在多模型可见性追踪与内容矩阵协同上表现突出，部署门槛低！第三段总结选购建议。';
    const passages = extractEvidencePassages(text, {
      name: 'GeoMix',
      aliases: [],
      domains: ['geomix.cn'],
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]).toContain('GeoMix在多模型可见性追踪');
    expect(passages[0]).not.toContain('第一段介绍行业趋势');
  });

  it('assigns 1-based positions sorted by firstMention and null when not mentioned', () => {
    const ranked = rankTrackedSubjects([
      { name: 'GeoMix', mentioned: true, firstMention: 42 },
      { name: '竞品甲', mentioned: true, firstMention: 8 },
      { name: '竞品乙', mentioned: false, firstMention: null },
      { name: '竞品丙', mentioned: true, firstMention: 95 },
    ]);

    expect(ranked).toEqual([
      { name: 'GeoMix', mentioned: true, firstMention: 42, position: 2 },
      { name: '竞品甲', mentioned: true, firstMention: 8, position: 1 },
      { name: '竞品乙', mentioned: false, firstMention: null, position: null },
      { name: '竞品丙', mentioned: true, firstMention: 95, position: 3 },
    ]);
  });

  it('ignores brand mentions that only appear in opening question-echo intros (#212)', () => {
    const brand = {
      name: 'Anker',
      aliases: ['安克', '安克创新'],
      domains: ['anker.com'],
    };
    const ugreen = { name: '绿联', aliases: ['UGREEN'], domains: ['ugreen.com'] };
    const baseus = { name: '倍思', aliases: ['Baseus'], domains: ['baseus.com'] };

    // Case 1: Intro echoes user question containing "Anker", body only recommends competitors
    const echoOnlyAnswer = [
      '针对您询问的 Anker 氮化镓充电器推荐，以下为您整理当前市面口碑较好的主流品牌：',
      '1. 绿联（UGREEN）：快充协议兼容性强，散热控制稳定。',
      '2. 倍思（Baseus）：体积小巧，多口输出功率分配合理。',
    ].join('\n');

    expect(
      findSubjectMentionOffsets(echoOnlyAnswer, brand, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }),
    ).toEqual([]);
    expect(
      extractEvidencePassages(echoOnlyAnswer, brand, 3, {
        promptText: 'Anker氮化镓充电器推荐',
      }),
    ).toEqual([]);
    expect(
      findSubjectMentionOffsets(echoOnlyAnswer, ugreen, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }).length,
    ).toBeGreaterThan(0);

    // Case 2: Quoted prompt echo framing clause with competitors in the second clause
    const quotedEchoAnswer = [
      '围绕「Anker氮化镓充电器推荐」，公开讨论度较高的工具主要包括 绿联 与 倍思：',
      '- 绿联 主打高性价比快充矩阵；',
      '- 倍思 侧重轻量便携设计。',
    ].join('\n');

    expect(
      findSubjectMentionOffsets(quotedEchoAnswer, brand, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }),
    ).toEqual([]);
    expect(
      findSubjectMentionOffsets(quotedEchoAnswer, ugreen, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }).length,
    ).toBeGreaterThan(0);

    // Case 3: Intro echoes question AND body genuinely recommends brand at #2
    const echoPlusBodyAnswer = [
      '针对您询问的 Anker 氮化镓充电器推荐，以下为您整理几款热门选择：',
      '1. 绿联（UGREEN）：性价比突出，多口兼容主流快充协议。',
      '2. Anker（安克）：氮化镓控温技术成熟，持续满载输出稳定，值得优先推荐。',
      '3. 倍思（Baseus）：外观便携，适合日常差旅使用。',
    ].join('\n');

    const brandOffsets = findSubjectMentionOffsets(echoPlusBodyAnswer, brand, undefined, {
      promptText: 'Anker氮化镓充电器推荐',
    });
    const ugreenOffsets = findSubjectMentionOffsets(echoPlusBodyAnswer, ugreen, undefined, {
      promptText: 'Anker氮化镓充电器推荐',
    });
    const baseusOffsets = findSubjectMentionOffsets(echoPlusBodyAnswer, baseus, undefined, {
      promptText: 'Anker氮化镓充电器推荐',
    });

    expect(brandOffsets).toEqual([
      echoPlusBodyAnswer.indexOf('2. Anker') + 3,
      echoPlusBodyAnswer.indexOf('安克'),
    ]);
    const ranked = rankTrackedSubjects([
      { name: 'Anker', mentioned: brandOffsets.length > 0, firstMention: brandOffsets[0] ?? null },
      { name: '绿联', mentioned: ugreenOffsets.length > 0, firstMention: ugreenOffsets[0] ?? null },
      { name: '倍思', mentioned: baseusOffsets.length > 0, firstMention: baseusOffsets[0] ?? null },
    ]);
    expect(ranked.map((item) => [item.name, item.position])).toEqual([
      ['Anker', 2],
      ['绿联', 1],
      ['倍思', 3],
    ]);

    const passages = extractEvidencePassages(echoPlusBodyAnswer, brand, 3, {
      promptText: 'Anker氮化镓充电器推荐',
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]).toContain('Anker（安克）：氮化镓控温技术成熟');
    expect(passages[0]).not.toContain('针对您询问的');

    // Case 4: Genuine direct recommendation in first sentence (no question echo) must still match at #1
    const directFirstSentence =
      '关于 Anker 氮化镓充电器，其采用自研控温芯片，散热与稳定性出色，值得优先推荐。';
    expect(
      findSubjectMentionOffsets(directFirstSentence, brand, undefined, {
        promptText: 'Anker氮化镓充电器怎么样',
      }),
    ).toEqual([directFirstSentence.indexOf('Anker')]);

    // Case 5: Greeting + question echo + unquoted prompt-overlap lead-in
    const greetingEcho =
      '好的，针对 Anker 氮化镓充电器推荐，以下为您整理几款热门品牌：\n1. 绿联...\n2. 倍思...';
    expect(
      findSubjectMentionOffsets(greetingEcho, brand, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }),
    ).toEqual([]);
    expect(
      findSubjectMentionOffsets(greetingEcho, ugreen, undefined, {
        promptText: 'Anker氮化镓充电器推荐',
      }).length,
    ).toBeGreaterThan(0);

    // Case 6: English question-echo intro
    const englishEcho =
      'Regarding your question about Anker GaN charger recommendations, top picks include:\n1. UGREEN: reliable.\n2. Baseus: compact.';
    expect(
      findSubjectMentionOffsets(englishEcho, brand, undefined, {
        promptText: 'Anker GaN charger recommendations',
      }),
    ).toEqual([]);
    expect(
      findSubjectMentionOffsets(englishEcho, ugreen, undefined, {
        promptText: 'Anker GaN charger recommendations',
      }).length,
    ).toBeGreaterThan(0);

    // Case 7: Anaphora continuation after "针对您询问的..." must NOT lose genuine evaluation
    const anaphoraEval =
      '针对您询问的 Anker 氮化镓充电器，其采用自研氮化镓芯片，散热与兼容性出色，非常值得入手。';
    expect(
      findSubjectMentionOffsets(anaphoraEval, brand, undefined, {
        promptText: 'Anker氮化镓充电器怎么样',
      }),
    ).toEqual([anaphoraEval.indexOf('Anker')]);

    // Case 8: Quoted-intro followed by body mention in the same sentence trims intro from passage
    const sameSentenceBody = '围绕「Anker氮化镓充电器推荐」，实测推荐 Anker Prime 与绿联 65W。';
    expect(
      extractEvidencePassages(sameSentenceBody, brand, 3, {
        promptText: 'Anker氮化镓充电器推荐',
      }),
    ).toEqual(['实测推荐 Anker Prime 与绿联 65W。']);
  });
});

describe('visibility metrics, fan-out normalization, and audit recomputation', () => {
  it('computes Visibility %, Share of Voice % (including 0/0), Avg Position, and Sentiment', () => {
    expect(computeVisibilityPct(0, 0)).toBe(0);
    expect(computeVisibilityPct(3, 4)).toBe(75);
    expect(computeVisibilityPct(1, 3)).toBe(33.3);

    const zeroSov = computeShareOfVoice({ name: 'GeoMix', mentions: 0 }, [
      { name: '竞品甲', mentions: 0 },
      { name: '竞品乙', mentions: 0 },
    ]);
    expect(zeroSov.totalMentions).toBe(0);
    expect(zeroSov.brandSharePct).toBe(0);
    expect(zeroSov.entries.every((e) => e.sharePct === 0)).toBe(true);

    const activeSov = computeShareOfVoice({ name: 'GeoMix', mentions: 3 }, [
      { name: '竞品甲', mentions: 5 },
      { name: '竞品乙', mentions: 2 },
    ]);
    expect(activeSov.totalMentions).toBe(10);
    expect(activeSov.brandSharePct).toBe(30);
    expect(activeSov.entries.map((e) => [e.name, e.mentions, e.sharePct])).toEqual([
      ['竞品甲', 5, 50],
      ['GeoMix', 3, 30],
      ['竞品乙', 2, 20],
    ]);

    expect(computeAvgPosition([])).toBeNull();
    expect(computeAvgPosition([null, undefined])).toBeNull();
    expect(computeAvgPosition([1, 2, null, 2])).toBe(1.7);

    expect(computeSentimentSummary(['positive', 'positive', 'neutral', 'negative', null])).toEqual({
      positive: 2,
      neutral: 1,
      mixed: 0,
      negative: 1,
      total: 4,
      positivePct: 50,
      negativePct: 25,
    });
  });

  it('normalizes fan-out queries by collapsing whitespace, stripping bullets/numbers, removing prompt duplicates, and deduping', () => {
    const normalized = normalizeFanOutQueries(
      [
        '  GEO优化工具哪家好  ',
        'geo优化工具哪家好',
        '2026 企业级   GEO 监测平台对比',
        '2026 企业级 geo 监测平台对比',
        '',
        '   ',
        'DeepSeek 品牌提及率提升方法',
      ],
      'GEO优化工具哪家好',
    );

    expect(normalized).toEqual(['2026 企业级 GEO 监测平台对比', 'DeepSeek 品牌提及率提升方法']);

    const bulleted = normalizeFanOutQueries(
      [
        'NAS 噪音实测; - NAS 噪音实测；• NAS 散热测试\n1. NAS 售后保修\r\n2、NAS 功耗对比\n- 家用 NAS 怎么选\n2.5G 网口 NAS',
        '* nas 噪音实测',
        '3) NAS 售后保修',
      ],
      '家用 NAS 怎么选',
    );
    expect(bulleted).toEqual([
      'NAS 噪音实测',
      'NAS 散热测试',
      'NAS 售后保修',
      'NAS 功耗对比',
      '2.5G 网口 NAS',
    ]);
  });

  it('recomputes run metrics deterministically from raw observations and citations', () => {
    const profile = {
      brandName: 'GeoMix',
      brandAliases: ['吉奥米克斯'],
      ownedDomains: ['geomix.cn'],
      competitors: [
        { name: '竞品甲', aliases: ['AlphaGEO'], domains: ['alphageo.com'] },
        { name: '竞品乙', aliases: [], domains: ['betageo.com'] },
      ],
    };

    const observations = [
      {
        status: 'SUCCESS',
        answerText: '首选推荐 GeoMix，其次也可以了解竞品甲。',
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        competitorHits: [
          { name: '竞品甲', mentioned: true, position: 2, sentiment: 'neutral' },
          { name: '竞品乙', mentioned: false, position: null, sentiment: null },
        ],
        citations: [
          { url: 'https://docs.geomix.cn/guide' },
          { url: 'https://zhuanlan.zhihu.com/p/100' },
        ],
      },
      {
        status: 'SUCCESS',
        answerText: '目前竞品甲和竞品乙在海外市场讨论较多。',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: null,
        competitorHits: [
          { name: '竞品甲', mentioned: true, position: 1, sentiment: 'positive' },
          { name: '竞品乙', mentioned: true, position: 2, sentiment: 'neutral' },
        ],
        citations: [
          { url: 'https://www.alphageo.com/blog' },
          { url: 'https://zhuanlan.zhihu.com/p/200' },
        ],
      },
      {
        status: 'SUCCESS',
        answerText: '在企业内容矩阵场景中，竞品甲起步较早，但吉奥米克斯性价比更高。',
        brandMentioned: true,
        brandPosition: 2,
        brandSentiment: 'mixed',
        competitorHits: [
          { name: '竞品甲', mentioned: true, position: 1, sentiment: 'positive' },
          { name: '竞品乙', mentioned: false, position: null, sentiment: null },
        ],
        citations: [{ url: 'https://www.geomix.cn/cases' }],
      },
      {
        status: 'FAILED',
        answerText: null,
        brandMentioned: false,
        citations: [],
      },
    ];

    const first = recomputeRunMetrics(observations, profile);
    const second = recomputeRunMetrics(observations, profile);
    expect(first).toEqual(second);

    expect(first.completedChecks).toBe(3);
    expect(first.mentionedChecks).toBe(2);
    expect(first.visibilityPct).toBe(66.7);
    expect(first.avgPosition).toBe(1.5);
    expect(first.sentimentSummary).toEqual({
      positive: 1,
      neutral: 0,
      mixed: 1,
      negative: 0,
      total: 2,
      positivePct: 50,
      negativePct: 0,
    });
    // Brand: 2, 竞品甲: 3, 竞品乙: 1 => total 6 => brand 33.3%
    expect(first.shareOfVoice.totalMentions).toBe(6);
    expect(first.shareOfVoice.brandSharePct).toBe(33.3);
    // Citations: 5 total (2 geomix.cn OWNED, 2 zhihu.com SOCIAL, 1 alphageo.com COMPETITOR) => 40%
    expect(first.totalCitations).toBe(5);
    expect(first.ownedCitations).toBe(2);
    expect(first.ownedCitationRatePct).toBe(40);
    expect(first.ownedCitationCheckRatePct).toBe(66.7);
    expect(first.topDomains).toEqual([
      { domain: 'zhuanlan.zhihu.com', sourceKind: 'SOCIAL', count: 2, observationCount: 2 },
      { domain: 'alphageo.com', sourceKind: 'COMPETITOR', count: 1, observationCount: 1 },
      { domain: 'docs.geomix.cn', sourceKind: 'OWNED', count: 1, observationCount: 1 },
      { domain: 'geomix.cn', sourceKind: 'OWNED', count: 1, observationCount: 1 },
    ]);

    // Fallback recomputation from raw answerText with question-echo intro (#212)
    const echoRecomputed = recomputeRunMetrics(
      [
        {
          status: 'SUCCESS',
          promptText: 'GeoMix对比评测',
          answerText: [
            '针对您询问的 GeoMix对比评测，以下为您整理当前主流方案：',
            '1. 竞品甲：传统行业案例积累丰富。',
            '2. 竞品乙：轻量化方案上手快。',
          ].join('\n'),
          citations: [],
        },
      ],
      profile,
    );
    expect(echoRecomputed.mentionedChecks).toBe(0);
    expect(echoRecomputed.avgPosition).toBeNull();
    expect(echoRecomputed.shareOfVoice.brandMentions).toBe(0);
    expect(echoRecomputed.shareOfVoice.entries.find((e) => e.name === '竞品甲')?.mentions).toBe(1);
    expect(echoRecomputed.shareOfVoice.entries.find((e) => e.name === '竞品乙')?.mentions).toBe(1);
  });
});

describe('visibility Zod schemas and query parsers', () => {
  it('validates profile creation, normalizes domains, and enforces max 10 competitors', () => {
    const parsed = visibilityProfileCreateSchema.parse({
      name: '  核心品牌监测  ',
      brandName: 'GeoMix',
      brandAliases: ['吉奥米克斯', 'geomix', '  吉奥米克斯  '],
      ownedDomains: ['https://www.GeoMix.cn/docs', 'geomix.cn'],
      competitors: [
        {
          name: '竞品甲',
          aliases: ['Alpha'],
          domains: ['https://www.alphageo.com/pricing'],
        },
      ],
    });

    expect(parsed).toEqual({
      name: '核心品牌监测',
      brandName: 'GeoMix',
      brandAliases: ['吉奥米克斯', 'geomix'],
      ownedDomains: ['geomix.cn'],
      competitors: [
        {
          name: '竞品甲',
          aliases: ['Alpha'],
          domains: ['alphageo.com'],
        },
      ],
    });

    const elevenCompetitors = Array.from({ length: 11 }, (_, idx) => ({
      name: `竞品${idx + 1}`,
      aliases: [],
      domains: [],
    }));
    expect(() =>
      visibilityProfileCreateSchema.parse({
        name: '超限测试',
        brandName: 'GeoMix',
        competitors: elevenCompetitors,
      }),
    ).toThrow(/10/);

    expect(() => visibilityProfileUpdateSchema.parse({})).toThrow();
  });

  it('validates run creation, import-questions input, quote helper, and query parsers', () => {
    const runInput = visibilityRunCreateSchema.parse({
      profileId: 'prof_123',
      engines: ['deepseek', 'doubao', 'deepseek'],
      questionIds: ['q_1', 'q_2', 'q_1'],
    });
    expect(runInput.engines).toEqual(['deepseek', 'doubao']);
    expect(runInput.questionIds).toEqual(['q_1', 'q_2']);

    expect(() =>
      visibilityRunCreateSchema.parse({
        profileId: 'prof_123',
        engines: ['deepseek'],
        questionIds: [],
        customPrompts: [],
      }),
    ).toThrow();

    const imported = importQuestionsInputSchema.parse({
      keywordId: 'kw_1',
      titles: ['  GEO工具对比  ', 'geo工具对比', '如何提升AI引擎推荐率'],
    });
    expect(imported.titles).toEqual(['GEO工具对比', '如何提升AI引擎推荐率']);

    expect(quoteVisibilityRunPoints(6, 2)).toEqual({
      totalChecks: 6,
      unitPoints: 2,
      totalPoints: 12,
    });
    expect(formatVisibilityRunSubmitLabel(6, 2)).toContain('预冻 12 点');

    expect(parseVisibilityRunListQuery({ page: '2', pageSize: '50', status: 'RUNNING' })).toEqual({
      page: 2,
      pageSize: 50,
      profileId: undefined,
      status: 'RUNNING',
      keyword: undefined,
    });
    expect(parseVisibilityOverviewQuery({ engine: 'deepseek', days: '7' })).toEqual({
      profileId: undefined,
      engine: 'deepseek',
      days: 7,
      from: undefined,
      to: undefined,
    });
    expect(parseVisibilityCitationQuery({ sourceKind: 'OWNED', page: '1' })).toEqual({
      profileId: undefined,
      engine: undefined,
      sourceKind: 'OWNED',
      days: 30,
      page: 1,
      pageSize: 25,
    });
    expect(parseVisibilityOpportunitiesQuery({ limit: '20' })).toEqual({
      profileId: undefined,
      engine: undefined,
      days: 30,
      limit: 20,
    });
  });
});

describe('profile-scoped keyword matching & isolation (#218, #213)', () => {
  const ankerProfile = {
    id: 'vprof_anker',
    name: '安克创新（Anker）全品类监测档案',
    brandName: '安克创新',
    brandAliases: ['Anker'],
    ownedDomains: ['anker.com'],
    competitors: [
      { name: '绿联 UGREEN', aliases: ['UGREEN'], domains: ['ugreen.com'] },
      { name: '倍思 Baseus', aliases: ['Baseus'], domains: ['baseus.com'] },
    ],
  };

  const arzopaProfile = {
    id: 'vprof_arzopa',
    name: 'ARZOPA便携显示器北美监测档案',
    brandName: 'ARZOPA',
    brandAliases: ['Arzopa Portable Monitor', '便携显示器'],
    ownedDomains: ['arzopa.com'],
    competitors: [
      { name: 'ASUS ZenScreen', aliases: ['华硕便携屏'], domains: ['asus.com'] },
      { name: 'Lenovo ThinkVision', aliases: ['联想便携显示器'], domains: ['lenovo.com'] },
    ],
  };

  const starviewProfile = {
    id: 'vprof_starview',
    name: '便携显示器核心监测档案',
    brandName: '星图显示',
    brandAliases: ['StarView', '星图触控便携屏'],
    ownedDomains: ['starview.cn', 'docs.starview.cn'],
    competitors: [{ name: '领航视界', aliases: ['NaviDisplay'], domains: ['navidisplay.cn'] }],
  };

  const allProfiles = [ankerProfile, arzopaProfile, starviewProfile];

  const keywords = [
    { id: 'kw_anker_1', main: 'Anker氮化镓充电器', brands: ['Anker'] },
    { id: 'kw_anker_2', main: '100W桌面快充充电站', brands: ['安克'] },
    { id: 'kw_anker_unbranded', main: 'Anker磁吸无线充电宝', brands: [] },
    { id: 'kw_arzopa_1', main: 'Switch外接便携屏', brands: ['ARZOPA'] },
    { id: 'kw_starview_1', main: '4K便携显示器', brands: ['星图显示', 'StarView'] },
    { id: 'kw_starview_suffix', main: '出差双屏扩展器', brands: ['星图便携显示器'] },
    { id: 'kw_competitor', main: '便携屏对比评测', brands: ['ASUS ZenScreen'] },
    { id: 'kw_unrelated_crm', main: '企业客户关系管理CRM', brands: ['CloudDesk'] },
  ];

  it('matches own-brand keywords (brandName, aliases, domain stems, CJK brand stem) and rejects other brands & competitors', () => {
    expect(matchesVisibilityProfileKeyword(keywords[0]!, ankerProfile, allProfiles)).toBe(true);
    expect(matchesVisibilityProfileKeyword(keywords[1]!, ankerProfile, allProfiles)).toBe(true);
    expect(matchesVisibilityProfileKeyword(keywords[2]!, ankerProfile, allProfiles)).toBe(true);

    // ARZOPA must NEVER match Anker, StarView, competitor ASUS, or unrelated CloudDesk — even with generic alias '便携显示器'
    expect(matchesVisibilityProfileKeyword(keywords[0]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[2]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[4]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[5]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[6]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[7]!, arzopaProfile, allProfiles)).toBe(false);
    expect(matchesVisibilityProfileKeyword(keywords[3]!, arzopaProfile, allProfiles)).toBe(true);

    expect(
      filterKeywordsForVisibilityProfile(keywords, ankerProfile, allProfiles).map((k) => k.id),
    ).toEqual(['kw_anker_1', 'kw_anker_2', 'kw_anker_unbranded']);
    expect(
      filterKeywordsForVisibilityProfile(keywords, arzopaProfile, allProfiles).map((k) => k.id),
    ).toEqual(['kw_arzopa_1']);
    expect(filterKeywordsForVisibilityProfile(keywords, null, allProfiles)).toEqual([]);
  });

  it('resolves default keyword ID safely and handles overview single-profile, unloaded, and multi-brand all-profiles modes', () => {
    const noArzopaKeywords = keywords.filter((k) => k.id !== 'kw_arzopa_1');

    expect(resolveDefaultKeywordIdForProfile(noArzopaKeywords, arzopaProfile, allProfiles)).toBe(
      '',
    );
    expect(resolveDefaultKeywordIdForProfile(noArzopaKeywords, ankerProfile, allProfiles)).toBe(
      'kw_anker_1',
    );
    expect(hasMultipleDistinctProfileBrands(allProfiles)).toBe(true);
    expect(hasMultipleDistinctProfileBrands([ankerProfile])).toBe(false);

    // Unloaded profiles -> never leak tenant keywords
    expect(
      resolveScopedOverviewKeywords({
        keywords: noArzopaKeywords,
        profiles: [],
        profilesLoaded: false,
        profileId: 'vprof_arzopa',
      }),
    ).toEqual({ scopedKeywords: [], defaultKeywordId: '' });

    // Selected profile with 0 matching keywords -> empty scopedKeywords & '' defaultKeywordId
    expect(
      resolveScopedOverviewKeywords({
        keywords: noArzopaKeywords,
        profiles: allProfiles,
        profilesLoaded: true,
        profileId: 'vprof_arzopa',
      }),
    ).toEqual({ scopedKeywords: [], defaultKeywordId: '' });

    // Multi-brand 全部监测档案 (profileId = '') -> all keywords available, defaultKeywordId = ''
    const allMode = resolveScopedOverviewKeywords({
      keywords: noArzopaKeywords,
      profiles: allProfiles,
      profilesLoaded: true,
      profileId: '',
    });
    expect(allMode.scopedKeywords).toHaveLength(noArzopaKeywords.length);
    expect(allMode.defaultKeywordId).toBe('');

    // Single-brand tenant 全部监测档案 -> auto-selects first keyword
    const singleBrandAllMode = resolveScopedOverviewKeywords({
      keywords: [keywords[0]!],
      profiles: [ankerProfile],
      profilesLoaded: true,
      profileId: '',
    });
    expect(singleBrandAllMode.defaultKeywordId).toBe('kw_anker_1');

    // importQuestionsInputSchema accepts optional profileId
    expect(
      importQuestionsInputSchema.parse({
        profileId: 'vprof_anker',
        keywordId: 'kw_anker_1',
        titles: ['Anker快充对比评测'],
      }),
    ).toEqual({
      profileId: 'vprof_anker',
      keywordId: 'kw_anker_1',
      titles: ['Anker快充对比评测'],
    });
  });
});

describe('topic relevance guardrail and off-topic metric downgrading (#217)', () => {
  it('flags off-topic GEO boilerplate even when prompt is echoed in quotes, and accepts genuine on-topic answers', () => {
    const prompt = 'Switch外接ARZOPA便携屏怎么样';
    const ctx = { brandName: 'ARZOPA', brandAliases: ['阿卓帕'] };

    const offTopicBoilerplate = [
      '在评估「Switch外接ARZOPA便携屏怎么样」时，核心应考察数据可审计性、合规边界与长期运维成本。',
      '目前 ARZOPA 在中文语义理解、引用溯源归类以及团队协作闭环上具备成熟实践，获得不少成长型与成熟型企业的青睐。',
      '落地过程中建议同步建立标准化的词库与周度复盘指标，持续跟踪收录与声量变化。',
    ].join('\n');

    const resOff = assessAnswerTopicRelevance(prompt, offTopicBoilerplate, ctx);
    expect(resOff.relevant).toBe(false);
    expect(resOff.reason).toBeTruthy();

    const onTopicAnswer =
      'Switch 外接 ARZOPA 便携屏体验不错，使用全功能 Type-C 一线直连即可输出 1080P 60Hz 画面，无需底座非常便携。';
    const resOn = assessAnswerTopicRelevance(prompt, onTopicAnswer, ctx);
    expect(resOn.relevant).toBe(true);
    expect(resOn.reason).toBeNull();

    // Genuine GEO prompt should NOT be flagged as off-topic GEO boilerplate
    const geoPrompt = '2026年企业级GEO内容优化系统哪家值得选？';
    const geoAnswer =
      '在评估 GEO 内容优化系统时，核心应考察数据可审计性、引用溯源归类以及长期运维成本，目前 GeoMix 具备成熟实践。';
    expect(assessAnswerTopicRelevance(geoPrompt, geoAnswer, { brandName: 'GeoMix' }).relevant).toBe(
      true,
    );

    // Fake placeholder marker is always flagged
    expect(assessAnswerTopicRelevance(prompt, '【FAKE】GeoMix 开发占位输出', ctx).relevant).toBe(
      false,
    );
  });

  it('downgrades off-topic observations in recomputeRunMetrics so they do not inflate visibilityPct or avgPosition', () => {
    const metrics = recomputeRunMetrics(
      [
        {
          status: 'SUCCESS',
          promptText: 'Switch外接ARZOPA便携屏怎么样',
          answerText:
            '在评估「Switch外接ARZOPA便携屏怎么样」时，核心应考察数据可审计性、合规边界与长期运维成本。目前 ARZOPA 在中文语义理解、引用溯源归类以及团队协作闭环上具备成熟实践。',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          competitorHits: [],
          citations: [],
        },
        {
          status: 'SUCCESS',
          promptText: '出差便携显示器哪个牌子色彩准？',
          answerText: '在 4K 便携显示器中，ARZOPA 出厂校色准确、机身轻薄，适合出差携带。',
          brandMentioned: true,
          brandPosition: 1,
          brandSentiment: 'positive',
          competitorHits: [],
          citations: [],
        },
      ],
      { brandName: 'ARZOPA' },
    );

    expect(metrics.completedChecks).toBe(2);
    expect(metrics.mentionedChecks).toBe(1);
    expect(metrics.visibilityPct).toBe(50);
    expect(metrics.avgPosition).toBe(1);
  });

  it('catches 1-token short prompts, old bucket 1/3 SaaS cues, and prevents generic CJK bigram false positives (#217)', () => {
    // 1. 1-token short prompt against long unrelated answer (>=60 chars after intro stripping)
    const shortPromptRes = assessAnswerTopicRelevance(
      'Anker充电器怎么样',
      '围绕「Anker充电器怎么样」，现代企业数字化建设需要统筹预算分配、审批流转与跨部门协同效率，并结合制度规范与季度复盘机制持续跟踪交付周期和业务落地成效。',
      { brandName: 'Anker' },
    );
    expect(shortPromptRes.relevant).toBe(false);
    expect(shortPromptRes.expectedTokens).toEqual(['充电器']);
    expect(shortPromptRes.matchedTokens).toEqual([]);

    // 2. Old bucket 1/3 SaaS boilerplate cues on non-GEO prompt
    const oldSaasRes = assessAnswerTopicRelevance(
      'Anker充电器怎么样',
      '针对该问题，Anker 提供多维度看板与行业基准对比能力，支持基础词条管理与标准化报表模板。',
      { brandName: 'Anker' },
    );
    expect(oldSaasRes.relevant).toBe(false);

    // 3. Generic CJK bigram (控制) in long token must not falsely match off-topic text (成本控制)
    const bigramFalseMatchRes = assessAnswerTopicRelevance(
      'Anker氮化镓充电器发热控制怎么样',
      '围绕「Anker氮化镓充电器发热控制怎么样」，企业采购应优先关注成本控制、供应商履约周期、发票合规归档与财务对账规范，并结合年度预算审批与内控审计流程持续提升跨部门协作效率。',
      { brandName: 'Anker' },
    );
    expect(bigramFalseMatchRes.relevant).toBe(false);
    expect(bigramFalseMatchRes.matchedTokens).toEqual([]);

    // 4. Genuine on-topic answer still passes via 3-char substring / specific topic coverage
    const onTopicRes = assessAnswerTopicRelevance(
      'Anker氮化镓充电器发热控制怎么样',
      'Anker 氮化镓充电器在满载 65W 输出时温控表现稳定，机身温升处于合理区间，日常差旅携带安全可靠。',
      { brandName: 'Anker' },
    );
    expect(onTopicRes.relevant).toBe(true);
  });
});

describe('M2-B v2 dual-market engine registry & schemas', () => {
  it('partitions engines strictly into CN (4 active, canonical tongyi) and GLOBAL (5) with display labels (#411)', () => {
    expect(VISIBILITY_ENGINES_BY_MARKET.CN).toHaveLength(4);
    expect(VISIBILITY_ENGINES_BY_MARKET.GLOBAL).toHaveLength(5);
    expect(enginesMetaForMarket('CN').map((e) => e.key)).toEqual([
      'deepseek',
      'doubao',
      'yuanbao',
      'tongyi',
    ]);
    expect(enginesMetaForMarket('CN').map((e) => e.key)).not.toContain('qwen');
    expect(enginesMetaForMarket('CN').map((e) => e.key)).not.toContain('kimi');
    expect(enginesMetaForMarket('CN').map((e) => e.key)).not.toContain('wenxin');
    expect(enginesMetaForMarket('GLOBAL').map((e) => e.key)).toEqual([
      'chatgpt',
      'perplexity',
      'claude',
      'gemini',
      'google_aio',
    ]);
    expect(findDisallowedMarketEngines(['deepseek', 'chatgpt'], 'CN')).toEqual(['chatgpt']);
    expect(findDisallowedMarketEngines(['deepseek', 'kimi', 'wenxin'], 'CN')).toEqual([
      'kimi',
      'wenxin',
    ]);
    expect(findDisallowedMarketEngines(['perplexity', 'doubao'], 'GLOBAL')).toEqual(['doubao']);
    expect(formatVisibilityEngineDisplayLabel('DeepSeek', true)).toBe('DeepSeek');
    expect(formatVisibilityEngineDisplayLabel('腾讯元宝', false)).toBe('腾讯元宝（暂未上线）');

    // Retired CN engines must be rejected when creating new runs
    const retiredRes = visibilityRunV2CreateSchema.safeParse({
      market: 'CN',
      engines: ['deepseek', 'kimi', 'wenxin'],
      prompts: ['家用 NAS 推荐'],
    });
    expect(retiredRes.success).toBe(false);
    if (!retiredRes.success) {
      expect(retiredRes.error.issues[0]?.message).toContain('已下线');
    }
  });

  it('validates visibilityRunV2CreateSchema with optional market and market-engine subset checks', () => {
    // Omitted market allowed (single-market / query param flow)
    const noMarket = visibilityRunV2CreateSchema.parse({
      engines: ['deepseek', 'doubao', 'deepseek'],
      prompts: ['家用 NAS 推荐', '家用 NAS 推荐'],
    });
    expect(noMarket.market).toBeUndefined();
    expect(noMarket.engines).toEqual(['deepseek', 'doubao']);
    expect(noMarket.prompts).toEqual(['家用 NAS 推荐']);
    expect(noMarket.triggerType).toBe('MANUAL');

    // Valid GLOBAL payload
    const globalParsed = visibilityRunV2CreateSchema.parse({
      market: 'GLOBAL',
      engines: ['chatgpt', 'perplexity'],
      prompts: ['Best quiet 4-bay NAS 2026'],
      triggerType: 'RETEST',
      retestArticleId: 'art_123',
    });
    expect(globalParsed.market).toBe('GLOBAL');
    expect(globalParsed.triggerType).toBe('RETEST');

    // Mismatched CN + GLOBAL engine rejected
    const badCn = visibilityRunV2CreateSchema.safeParse({
      market: 'CN',
      engines: ['deepseek', 'chatgpt'],
      prompts: ['家用 NAS 推荐'],
    });
    expect(badCn.success).toBe(false);

    // Mismatched GLOBAL + CN engine rejected
    const badGlobal = visibilityRunV2CreateSchema.safeParse({
      market: 'GLOBAL',
      engines: ['perplexity', 'doubao'],
      prompts: ['Best quiet home NAS'],
    });
    expect(badGlobal.success).toBe(false);
  });

  it('parses v2 overview, run list, citation, and opportunity query schemas safely', () => {
    expect(visibilityV2OverviewQuerySchema.safeParse({ market: 'cn', days: '7' }).success).toBe(
      true,
    );
    expect(visibilityV2OverviewQuerySchema.safeParse({ market: 'JP' }).success).toBe(false);
    expect(
      parseVisibilityV2OverviewQuery({ market: 'global', days: '30', engine: 'claude' }),
    ).toEqual({ market: 'GLOBAL', days: 30, engine: 'claude' });

    expect(
      visibilityV2RunListQuerySchema.safeParse({ market: 'CN', page: 2, pageSize: 50 }).success,
    ).toBe(true);
    expect(
      parseVisibilityV2RunListQuery({ market: 'CN', status: 'RUNNING', keyword: 'NAS' }),
    ).toEqual({ market: 'CN', page: 1, pageSize: 25, status: 'RUNNING', keyword: 'NAS' });

    expect(
      visibilityV2CitationQuerySchema.safeParse({
        market: 'GLOBAL',
        sourceKind: 'ECOMMERCE',
        days: 14,
      }).success,
    ).toBe(true);
    expect(
      parseVisibilityV2CitationQuery({ market: 'CN', sourceKind: 'COMPETITOR', page: 2 }),
    ).toEqual({
      market: 'CN',
      engine: undefined,
      sourceKind: 'COMPETITOR',
      days: 30,
      page: 2,
      pageSize: 25,
    });

    expect(
      visibilityV2OpportunitiesQuerySchema.safeParse({ market: 'GLOBAL', limit: 20 }).success,
    ).toBe(true);
    expect(parseVisibilityV2OpportunitiesQuery({ market: 'CN', limit: 15 })).toEqual({
      market: 'CN',
      engine: undefined,
      days: 30,
      limit: 15,
    });
  });
});

describe('F10 Fix 1 — normalizeFanOutQueries precision & ReDoS safety', () => {
  it('splits on semicolons and newlines, strips bullets/numbers without corrupting decimals, rejects punctuation-only tokens, and deduplicates case-insensitively', () => {
    expect(
      normalizeFanOutQueries(['安静NAS; 家用NAS功耗；安静NAS\n四盘位NAS'], '家用 NAS 推荐'),
    ).toEqual(['安静NAS', '家用NAS功耗', '四盘位NAS']);

    // Decimal & negative number safety
    expect(
      normalizeFanOutQueries([
        '2.5G 网口 NAS',
        '14.5W 满载功耗',
        '3.5mm 音频口',
        '-10℃ 低温电池',
        '一步到位 NAS',
      ]),
    ).toEqual(['2.5G 网口 NAS', '14.5W 满载功耗', '3.5mm 音频口', '-10℃ 低温电池', '一步到位 NAS']);

    // Leading markers & chained markers stripped cleanly
    expect(
      normalizeFanOutQueries([
        '- 静音NAS',
        '* 低功耗NAS',
        '• 四盘位推荐',
        '1. 家庭影音NAS',
        '2) 远程访问NAS',
        '3、双2.5G网口',
        '(4) 硬盘休眠',
        '（5）Docker支持',
        '[6] 照片备份',
        '一、性价比对比',
        '- 1. NAS 噪音实测',
      ]),
    ).toEqual([
      '静音NAS',
      '低功耗NAS',
      '四盘位推荐',
      '家庭影音NAS',
      '远程访问NAS',
      '双2.5G网口',
      '硬盘休眠',
      'Docker支持',
      '照片备份',
      '性价比对比',
      'NAS 噪音实测',
    ]);

    // Punctuation-only & empty tokens rejected
    expect(
      normalizeFanOutQueries(['', '   ', '---', '...', '•', '1.', '2)', '()', '？！', '；；']),
    ).toEqual([]);

    // Case-insensitive dedupe preserving first clean casing & optional promptText
    expect(normalizeFanOutQueries(['Home NAS', 'home nas', 'HOME NAS'])).toEqual(['Home NAS']);
  });

  it('completes 50KB adversarial inputs in linear time (<200ms)', () => {
    const start = performance.now();
    const res1 = normalizeFanOutQueries([';'.repeat(50_000)]);
    const res2 = normalizeFanOutQueries(['-'.repeat(50_000) + 'a']);
    const elapsed = performance.now() - start;
    expect(res1).toEqual([]);
    expect(res2).toHaveLength(1);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('F10 Fix 2 — structured list/heading rank judge, echo suppression & ReDoS safety', () => {
  const brand = { name: '绿联', aliases: ['UGREEN'], domains: ['ugreen.com'] };
  const comp1 = { name: '群晖', aliases: ['Synology'], domains: ['synology.com'] };
  const comp2 = { name: '极空间', aliases: ['ZSpace'], domains: ['zspace.cn'] };

  it('skips unframed CN & EN intro echoes on [E2E_ECHO_TRAP] and ranks brand at #3', () => {
    const cnTrap = [
      '想了解绿联家用 NAS 推荐，以下是 2026 年最值得关注的几款品牌：',
      '1. 群晖（Synology）：生态成熟，适合进阶用户。',
      '2. 极空间（ZSpace）：上手门槛低，家庭影音友好。',
      '3. 绿联（UGREEN）：硬件配置扎实，静音性价比高。',
    ].join('\n');

    expect(findQuestionEchoIntroEnd(cnTrap, '绿联家用NAS推荐')).toBeGreaterThan(0);
    const ranks = resolveStructuredSubjectRanks(
      cnTrap,
      [
        { key: 'brand', subject: brand },
        { key: 'c1', subject: comp1 },
        { key: 'c2', subject: comp2 },
      ],
      { promptText: '绿联家用NAS推荐' },
    );
    expect(ranks.get('c1')?.structuredRank).toBe(1);
    expect(ranks.get('c2')?.structuredRank).toBe(2);
    expect(ranks.get('brand')?.structuredRank).toBe(3);

    const enBrand = { name: 'AcmeCorp', aliases: [], domains: ['acmecorp.com'] };
    const enTrap = [
      'If you are comparing AcmeCorp home NAS options, here are the top recommendations:',
      '1. Synology: Mature DSM ecosystem for home labs.',
      '2. QNAP: Flexible PCIe expansion and multi-gig networking.',
      '3. AcmeCorp: Quiet 4-bay hardware with strong value.',
    ].join('\n');
    expect(findQuestionEchoIntroEnd(enTrap, 'AcmeCorp home NAS recommendations')).toBeGreaterThan(
      0,
    );
    const enOffsets = findSubjectMentionOffsets(enTrap, enBrand, undefined, {
      promptText: 'AcmeCorp home NAS recommendations',
    });
    expect(enOffsets).toEqual([enTrap.lastIndexOf('AcmeCorp')]);
  });

  it('returns brandMentioned: false on [E2E_ECHO_ONLY] CN & EN unframed intros', () => {
    const cnEchoOnly = [
      '想了解绿联 NAS，以下为您盘点主流品牌：',
      '1. 群晖：稳定可靠，企业与家用皆宜。',
      '2. 极空间：操作直观，适合家庭照片备份。',
    ].join('\n');
    expect(
      findSubjectMentionOffsets(cnEchoOnly, brand, undefined, { promptText: '绿联 NAS 怎么样' }),
    ).toEqual([]);

    const enBrand = { name: 'AcmeCorp', aliases: [], domains: ['acmecorp.com'] };
    const enEchoOnly = [
      'When comparing AcmeCorp home NAS, here are the top recommendations:',
      '1. Synology: Leading DSM software and long-term reliability.',
      '2. QNAP: Strong hardware specs and virtualization support.',
    ].join('\n');
    expect(
      findSubjectMentionOffsets(enEchoOnly, enBrand, undefined, {
        promptText: 'AcmeCorp home NAS review',
      }),
    ).toEqual([]);

    const metrics = recomputeRunMetrics(
      [
        {
          status: 'SUCCESS',
          promptText: 'AcmeCorp home NAS review',
          answerText: enEchoOnly,
          citations: [],
        },
      ],
      { brandName: 'AcmeCorp', ownedDomains: ['acmecorp.com'] },
    );
    expect(metrics.mentionedChecks).toBe(0);
    expect(metrics.avgPosition).toBeNull();
  });

  it('supports Markdown headings, Chinese numerals, bold numbers, and avoids matching decimals like 2.5G', () => {
    const headingAnswer = [
      '### 1. 群晖',
      '企业与家用生态成熟。',
      '### 2. 极空间',
      '操作简洁易用。',
      '### 3. 绿联',
      '双 2.5G 网口与静音风道设计。',
    ].join('\n');
    const hRanks = resolveStructuredSubjectRanks(headingAnswer, [
      { key: 'brand', subject: brand },
      { key: 'c1', subject: comp1 },
      { key: 'c2', subject: comp2 },
    ]);
    expect(hRanks.get('brand')?.structuredRank).toBe(3);

    const unnumberedHeadingAnswer = [
      '### 群晖',
      '企业与家用生态成熟。',
      '### 极空间',
      '操作简洁易用。',
      '### 绿联',
      '硬件参数亮眼。',
    ].join('\n');
    const uhRanks = resolveStructuredSubjectRanks(unnumberedHeadingAnswer, [
      { key: 'brand', subject: brand },
      { key: 'c1', subject: comp1 },
      { key: 'c2', subject: comp2 },
    ]);
    expect(uhRanks.get('brand')?.structuredRank).toBe(3);

    const cnNumeralAnswer = ['一、群晖：稳定', '二、极空间：易用', '三、绿联：静音'].join('\n');
    expect(
      resolveStructuredSubjectRanks(cnNumeralAnswer, [
        { key: 'brand', subject: brand },
        { key: 'c1', subject: comp1 },
        { key: 'c2', subject: comp2 },
      ]).get('brand')?.structuredRank,
    ).toBe(3);

    const boldNumberAnswer = ['**1. 群晖**：稳定', '**2. 极空间**：易用', '**3. 绿联**：静音'].join(
      '\n',
    );
    expect(
      resolveStructuredSubjectRanks(boldNumberAnswer, [
        { key: 'brand', subject: brand },
        { key: 'c1', subject: comp1 },
        { key: 'c2', subject: comp2 },
      ]).get('brand')?.structuredRank,
    ).toBe(3);

    // Decimals must never be extracted as numbered items
    const decimalItems = extractStructuredRecommendationItems(
      '2.5G 网口支持高速传输\n14.5W 满载功耗',
    );
    expect(decimalItems).toEqual([]);
  });

  it('preserves explicit slot #3 when competitors #1-#2 are unconfigured and lets header match beat item #1 body cross-reference', () => {
    const unconfiguredAnswer = [
      '1. Synology: Great ecosystem.',
      '2. QNAP: Strong hardware.',
      '3. 绿联：静音性价比高。',
    ].join('\n');
    const unconfRanks = resolveStructuredSubjectRanks(unconfiguredAnswer, [
      { key: 'brand', subject: brand },
    ]);
    const ranked = rankTrackedSubjects([
      {
        name: '绿联',
        mentioned: true,
        firstMention: unconfiguredAnswer.indexOf('绿联'),
        structuredRank: unconfRanks.get('brand')?.structuredRank ?? null,
      },
    ]);
    expect(ranked[0]?.position).toBe(3);

    // Cross-reference in item #1 body vs own header at item #3
    const crossRefAnswer = [
      '1. 群晖：软件生态比绿联更成熟。',
      '2. 极空间：新手友好。',
      '3. 绿联：硬件性价比与静音表现突出。',
    ].join('\n');
    const crRanks = resolveStructuredSubjectRanks(crossRefAnswer, [
      { key: 'brand', subject: brand },
      { key: 'c1', subject: comp1 },
      { key: 'c2', subject: comp2 },
    ]);
    expect(crRanks.get('c1')?.structuredRank).toBe(1);
    expect(crRanks.get('c2')?.structuredRank).toBe(2);
    expect(crRanks.get('brand')?.structuredRank).toBe(3);
  });

  it('preserves single-brand anaphoric pros list and whole-word boundary matching for Arc', () => {
    const anker = { name: 'Anker', aliases: ['安克'], domains: ['anker.com'] };
    const prosList = '关于 Anker 氮化镓充电器，其主要优势如下：\n1. 散热好\n2. 体积小';
    expect(
      findSubjectMentionOffsets(prosList, anker, undefined, { promptText: 'Anker充电器怎么样' }),
    ).toEqual([prosList.indexOf('Anker')]);

    const arcPattern = wholeWordPattern('Arc');
    expect('Great search architecture and research tools'.match(arcPattern)).toBeNull();
    expect('Arc and ARC plus Arc浏览器 are mentioned'.match(arcPattern)).toHaveLength(3);
  });

  it('keeps unnumbered and numbered Markdown headings intact across intervening sub-bullets (B3)', () => {
    const enHeadingBullets = [
      'Here are the top NAS picks:',
      '',
      '### Synology',
      '- Mature DSM ecosystem',
      '- Quiet cooling',
      '',
      '### QNAP',
      '- Fast 2.5GbE ports',
      '- Flexible expansion',
      '',
      '### UGREEN',
      '- Great hardware value',
      '- Modern mobile app',
    ].join('\n');

    const enBrand = { name: 'UGREEN', aliases: [], domains: ['ugreen.com'] };
    const enRanks = resolveStructuredSubjectRanks(
      enHeadingBullets,
      [{ key: 'brand', subject: enBrand }],
      { promptText: 'Best home NAS picks' },
    );
    expect(enRanks.get('brand')?.structuredRank).toBe(3);
    const enRanked = rankTrackedSubjects([
      {
        name: 'UGREEN',
        mentioned: true,
        firstMention: enHeadingBullets.indexOf('UGREEN'),
        structuredRank: enRanks.get('brand')?.structuredRank ?? null,
      },
    ]);
    expect(enRanked[0]?.position).toBe(3);

    const cnNumberedHeadingBullets = [
      '针对您询问的绿联NAS推荐，以下为热门品牌：',
      '',
      '### 1. 群晖',
      '- 生态成熟',
      '- 系统稳定',
      '',
      '### 2. 威联通',
      '- 硬件配置高',
      '',
      '### 3. 绿联',
      '- 静音体验好',
    ].join('\n');
    const cnRanks = resolveStructuredSubjectRanks(
      cnNumberedHeadingBullets,
      [
        { key: 'brand', subject: brand },
        { key: 'c1', subject: comp1 },
      ],
      { promptText: '绿联NAS推荐' },
    );
    expect(cnRanks.get('c1')?.structuredRank).toBe(1);
    expect(cnRanks.get('brand')?.structuredRank).toBe(3);
    const cnRanked = rankTrackedSubjects([
      {
        name: '绿联',
        mentioned: true,
        firstMention: cnNumberedHeadingBullets.lastIndexOf('绿联'),
        structuredRank: cnRanks.get('brand')?.structuredRank ?? null,
      },
      {
        name: '群晖',
        mentioned: true,
        firstMention: cnNumberedHeadingBullets.indexOf('群晖'),
        structuredRank: cnRanks.get('c1')?.structuredRank ?? null,
      },
    ]);
    expect(cnRanked[0]?.position).toBe(3);
    expect(cnRanked[1]?.position).toBe(1);
  });

  it('does not suppress single-brand pros/attributes lists whose intro contains 热门产品 or best options (B5)', () => {
    const cnPros =
      '绿联NAS作为一款热门产品，其主要特点如下：\n1. 静音表现出色。\n2. 功耗控制优秀。';
    expect(findQuestionEchoIntroEnd(cnPros, '绿联NAS特点')).toBe(0);
    expect(
      findSubjectMentionOffsets(cnPros, brand, undefined, { promptText: '绿联NAS特点' }),
    ).toEqual([0]);

    const enBrand = { name: 'UGREEN', aliases: [], domains: ['ugreen.com'] };
    const enPros =
      'UGREEN is one of the best options for home NAS. Its main pros are:\n1. Quiet operation.\n2. Low idle power.';
    expect(findQuestionEchoIntroEnd(enPros, 'UGREEN NAS pros')).toBe(0);
    expect(
      findSubjectMentionOffsets(enPros, enBrand, undefined, { promptText: 'UGREEN NAS pros' }),
    ).toEqual([0]);
  });

  it('strips generic bracketed metadata tags before extracting topic relevance tokens (B6)', () => {
    const cnAnswer = [
      '针对您询问的绿联推荐哪款好，以下为您整理热门品牌：',
      '1. 群晖：生态成熟，适合长期稳定运行。',
      '2. 极空间：新手易上手，影音管理方便。',
      '3. 绿联：静音散热表现突出，适合家庭使用，综合性价比高。',
    ].join('\n');
    const cnRel = assessAnswerTopicRelevance('[E2E_ECHO_TRAP] 绿联推荐哪款好', cnAnswer, {
      brandName: '绿联',
    });
    expect(cnRel.relevant).toBe(true);
    expect(cnRel.expectedTokens).toEqual([]);

    const enAnswer = [
      'Regarding Best UGREEN review, here are the top brands:',
      '1. Synology: Mature DSM ecosystem with reliable long-term software updates.',
      '2. QNAP: Flexible multi-gigabit networking and hardware expansion.',
      '3. UGREEN: Quiet hardware design with strong value for modern home users.',
    ].join('\n');
    const enRel = assessAnswerTopicRelevance('[E2E_ECHO_TRAP] Best UGREEN review', enAnswer, {
      brandName: 'UGREEN',
    });
    expect(enRel.relevant).toBe(true);
    expect(enRel.expectedTokens).toEqual([]);
  });

  it('handles 50KB adversarial list/heading/intro inputs in <200ms', () => {
    const start = performance.now();
    extractStructuredRecommendationItems('1.'.repeat(25_000));
    extractStructuredRecommendationItems('#'.repeat(50_000));
    findQuestionEchoIntroEnd('针对 '.repeat(15_000), '绿联 NAS 推荐');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

describe('F10 Fix 3 — expanded dual-market citation classifier & priority order', () => {
  it('enforces OWNED > COMPETITOR > ECOMMERCE > SOCIAL > AUTHORITY > OTHER and subdomain-safe matching', () => {
    expect(CITATION_SOURCE_PRIORITY).toEqual([
      'OWNED',
      'COMPETITOR',
      'ECOMMERCE',
      'SOCIAL',
      'AUTHORITY',
      'OTHER',
    ]);

    // Owned beats ECOMMERCE/SOCIAL/AUTHORITY
    expect(
      classifyCitationSource('https://shop.amazon.com/mybrand', { ownedDomains: ['amazon.com'] }),
    ).toBe('OWNED');
    expect(
      classifyCitationSource('https://docs.example.com/guide', { ownedDomains: ['example.com'] }),
    ).toBe('OWNED');
    expect(
      classifyCitationSource('https://notexample.com/guide', { ownedDomains: ['example.com'] }),
    ).toBe('OTHER');

    // Competitor beats ECOMMERCE/SOCIAL/AUTHORITY
    expect(
      classifyCitationSource('https://rival.jd.com/item', { competitorDomains: ['rival.jd.com'] }),
    ).toBe('COMPETITOR');

    // Spoofed suffix never matches ECOMMERCE
    expect(classifyCitationSource('https://jd.com.evil.com/phish')).toBe('OTHER');

    // CN social & UGC
    for (const url of [
      'https://m.weibo.cn/status/1',
      'https://weibo.com/u/1',
      'https://www.xiaohongshu.com/explore/1',
      'https://zhuanlan.zhihu.com/p/1',
      'https://www.bilibili.com/video/BV1',
      'https://post.smzdm.com/p/1',
      'https://www.douyin.com/note/1',
      'https://www.toutiao.com/article/1',
      'https://mp.weixin.qq.com/s/1',
      'https://tieba.baidu.com/p/1',
      'https://www.douban.com/note/1',
    ]) {
      expect(classifyCitationSource(url)).toBe('SOCIAL');
    }

    // CN & GLOBAL E-commerce
    for (const url of [
      'https://item.jd.com/1001.html',
      'https://detail.tmall.com/item.htm',
      'https://s.taobao.com/search',
      'https://mobile.pinduoduo.com/goods',
      'https://www.amazon.com/dp/B001',
      'https://www.amazon.co.uk/dp/B001',
      'https://www.ebay.com/itm/1',
      'https://www.walmart.com/ip/1',
      'https://www.bestbuy.com/site/1',
      'https://www.newegg.com/p/1',
    ]) {
      expect(classifyCitationSource(url)).toBe('ECOMMERCE');
    }

    // GLOBAL review & community -> SOCIAL
    for (const url of [
      'https://www.reddit.com/r/homelab',
      'https://www.quora.com/Best-NAS',
      'https://www.trustpilot.com/review/example.com',
      'https://www.g2.com/products/example/reviews',
      'https://www.capterra.com/p/123/example',
      'https://www.youtube.com/watch?v=123',
      'https://medium.com/@author/nas',
      'https://news.ycombinator.com/item?id=1',
    ]) {
      expect(classifyCitationSource(url)).toBe('SOCIAL');
    }

    // CN & GLOBAL authority/review media -> AUTHORITY
    for (const url of [
      'https://www.techradar.com/reviews/nas',
      'https://www.nytimes.com/wirecutter/reviews/nas',
      'https://www.wirecutter.com/reviews/nas',
      'https://www.pcmag.com/picks/best-nas',
      'https://www.theverge.com/2026/nas',
      'https://www.rtings.com/nas/reviews',
      'https://www.tomsguide.com/best-picks/nas',
      'https://www.tomshardware.com/reviews/nas',
      'https://www.cnet.com/tech/computing/nas',
      'https://www.forbes.com/sites/tech/nas',
      'https://36kr.com/p/123',
      'https://sspai.com/post/123',
      'https://www.ithome.com/0/123.htm',
      'https://diy.pconline.com.cn/123.html',
      'https://detail.zol.com.cn/123.html',
      'https://www.chiphell.com/thread-123.html',
    ]) {
      expect(classifyCitationSource(url)).toBe('AUTHORITY');
    }
  });
});
