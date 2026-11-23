import { describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDERS,
  CRAWL_PROBE_BOTS,
  CRAWL_PROBE_STATUSES,
  DEFAULT_PR_SHARE_TTL_DAYS,
  DEFAULT_RETEST_MILESTONE_DAYS,
  DISTRIBUTION_MODES,
  DISTRIBUTION_TASK_STATUSES,
  DISTRIBUTION_TEMPLATE_KEYS,
  L1_CHANNEL_PROVIDERS,
  RETEST_SAMPLE_COUNTS,
  RETEST_SCHEDULE_STATUSES,
  createChannelConnectionSchema,
  createDistributionVariantsSchema,
  createPrShareLinkSchema,
  crawlProbeReportSchema,
  defaultDistributionModeForProvider,
  defaultTemplateKeyForProvider,
  distributionPreflightResultSchema,
  evaluateDistributionPreflight,
  isL1ChannelProvider,
  isSafeDistributionHttpUrl,
  publicPrPacketSubmitSchema,
  publishDistributionTaskSchema,
  retestScheduleConfigSchema,
  testChannelConnectionSchema,
  updateChannelConnectionSchema,
  updateDistributionTaskSchema,
  type ChannelConnectionDto,
  type DistributionChannelAttributionItem,
} from './distribution';

describe('distribution constants & mapping helpers', () => {
  it('registers all 9 channel providers, 4 L1 providers, and 6 template keys', () => {
    expect(CHANNEL_PROVIDERS).toEqual([
      'SHOPIFY',
      'WORDPRESS',
      'WEBFLOW',
      'WEBHOOK',
      'REDDIT_ASSIST',
      'QUORA_ASSIST',
      'SOCIAL_THREAD_ASSIST',
      'PR_PACKET',
      'CN_COMMUNITY_ASSIST',
    ]);
    expect(L1_CHANNEL_PROVIDERS).toEqual(['SHOPIFY', 'WORDPRESS', 'WEBFLOW', 'WEBHOOK']);
    expect(DISTRIBUTION_TEMPLATE_KEYS).toEqual([
      'OWNED_BLOG_SEO_GEO',
      'REDDIT_DISCUSSION',
      'QUORA_ANSWER',
      'SOCIAL_THREAD',
      'PR_MEDIA_PACKET',
      'CN_COMMUNITY_QA',
    ]);
    expect(DISTRIBUTION_MODES).toEqual(['L1_API', 'L3_COMMUNITY_ASSIST', 'L3_PR_PACKET']);
    expect(DISTRIBUTION_TASK_STATUSES).toHaveLength(7);
    expect(CRAWL_PROBE_STATUSES).toEqual(['PENDING', 'OK', 'WARNING', 'BLOCKED', 'FAILED']);
    expect(RETEST_SCHEDULE_STATUSES).toHaveLength(7);
    expect(DEFAULT_RETEST_MILESTONE_DAYS).toEqual([7, 14, 30]);
    expect(RETEST_SAMPLE_COUNTS).toEqual([1, 3]);
    expect(CRAWL_PROBE_BOTS).toEqual([
      '*',
      'GPTBot',
      'OAI-SearchBot',
      'PerplexityBot',
      'Googlebot',
    ]);
    expect(DEFAULT_PR_SHARE_TTL_DAYS).toBe(30);
  });

  it('maps providers to L1 checks, distribution modes, and template keys', () => {
    expect(isL1ChannelProvider('SHOPIFY')).toBe(true);
    expect(isL1ChannelProvider('WEBHOOK')).toBe(true);
    expect(isL1ChannelProvider('REDDIT_ASSIST')).toBe(false);
    expect(isL1ChannelProvider('PR_PACKET')).toBe(false);

    expect(defaultDistributionModeForProvider('WORDPRESS')).toBe('L1_API');
    expect(defaultDistributionModeForProvider('PR_PACKET')).toBe('L3_PR_PACKET');
    expect(defaultDistributionModeForProvider('SOCIAL_THREAD_ASSIST')).toBe('L3_COMMUNITY_ASSIST');

    expect(defaultTemplateKeyForProvider('SHOPIFY')).toBe('OWNED_BLOG_SEO_GEO');
    expect(defaultTemplateKeyForProvider('REDDIT_ASSIST')).toBe('REDDIT_DISCUSSION');
    expect(defaultTemplateKeyForProvider('QUORA_ASSIST')).toBe('QUORA_ANSWER');
    expect(defaultTemplateKeyForProvider('SOCIAL_THREAD_ASSIST')).toBe('SOCIAL_THREAD');
    expect(defaultTemplateKeyForProvider('PR_PACKET')).toBe('PR_MEDIA_PACKET');
    expect(defaultTemplateKeyForProvider('CN_COMMUNITY_ASSIST')).toBe('CN_COMMUNITY_QA');
  });

  it('validates safe HTTP(S) URLs strictly', () => {
    expect(isSafeDistributionHttpUrl('https://blog.example.com/posts/geo-guide')).toBe(true);
    expect(isSafeDistributionHttpUrl('http://example.com')).toBe(true);
    expect(isSafeDistributionHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeDistributionHttpUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeDistributionHttpUrl('https://example.com/a b')).toBe(false);
    expect(isSafeDistributionHttpUrl('')).toBe(false);
  });
});

describe('distribution Zod schemas (11 contracts)', () => {
  it('1. createChannelConnectionSchema validates provider-specific credentials and displayName', () => {
    expect(
      createChannelConnectionSchema.parse({
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'US Store Blog',
        siteBaseUrl: 'https://store.myshopify.com',
        credentials: { accessToken: 'shpat_1234567890abcdef' },
        configJson: { blogId: 'gid://shopify/Blog/1', defaultPublishAsDraft: true },
      }),
    ).toMatchObject({ provider: 'SHOPIFY', displayName: 'US Store Blog', authType: 'API_KEY' });

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'GLOBAL',
        provider: 'SHOPIFY',
        displayName: 'Missing Token',
        siteBaseUrl: 'https://store.myshopify.com',
        credentials: { wrongKey: 'abc' },
      }).success,
    ).toBe(false);

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'GLOBAL',
        provider: 'WORDPRESS',
        displayName: 'WP Missing AppPassword',
        siteBaseUrl: 'https://blog.example.com',
        credentials: { username: 'editor' },
      }).success,
    ).toBe(false);

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'GLOBAL',
        provider: 'WORDPRESS',
        displayName: 'WP Valid',
        siteBaseUrl: 'https://blog.example.com',
        credentials: { username: 'editor', appPassword: 'abcd efgh ijkl' },
      }).success,
    ).toBe(true);

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'GLOBAL',
        provider: 'WEBFLOW',
        displayName: 'WF Valid',
        siteBaseUrl: 'https://api.webflow.com',
        credentials: { apiToken: 'wf_token_123456' },
      }).success,
    ).toBe(true);

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'CN',
        provider: 'WEBHOOK',
        displayName: 'Short Secret',
        siteBaseUrl: 'https://hook.example.com/ingest',
        credentials: { signingSecret: 'short' },
      }).success,
    ).toBe(false);

    expect(
      createChannelConnectionSchema.safeParse({
        market: 'CN',
        provider: 'WEBHOOK',
        displayName: 'Valid Webhook',
        siteBaseUrl: 'https://hook.example.com/ingest',
        credentials: { signingSecret: 'whsec_12345678' },
      }).success,
    ).toBe(true);

    // L3 provider is rejected for ChannelConnection
    expect(
      createChannelConnectionSchema.safeParse({
        market: 'GLOBAL',
        provider: 'REDDIT_ASSIST',
        displayName: 'Not L1',
        siteBaseUrl: 'https://reddit.com',
        credentials: { token: '123' },
      }).success,
    ).toBe(false);
  });

  it('2 & 3. updateChannelConnectionSchema, testChannelConnectionSchema & DTO contracts (H1/H2)', () => {
    expect(updateChannelConnectionSchema.safeParse({}).success).toBe(false);
    expect(
      updateChannelConnectionSchema.parse({
        displayName: 'Renamed Blog',
        credentials: { accessToken: '' },
        status: 'DISABLED',
      }),
    ).toMatchObject({ displayName: 'Renamed Blog', status: 'DISABLED' });

    const dto: ChannelConnectionDto = {
      id: 'conn_1',
      brandId: 'brand_1',
      brandMarketId: 'bm_1',
      market: 'GLOBAL',
      provider: 'SHOPIFY',
      displayName: 'US Store Blog',
      siteBaseUrl: 'https://store.myshopify.com',
      credentialHint: 'shpat_****9a2f',
      configJson: {},
      status: 'ACTIVE',
      authType: 'API_KEY',
      lastTestedAt: null,
      lastError: null,
      createdAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };
    expect(dto.displayName).toBe('US Store Blog');

    const attribution: DistributionChannelAttributionItem = {
      channel: 'Shopify 博客',
      publishedCount: 4,
      crawlOkCount: 3,
      completedRetestCount: 2,
      citationHitCount: 1,
      citationHitRate: 0.5,
      avgMentionRateDelta: 12.5,
      avgPosition: 2.5,
      avgPositionDelta: -1.0,
      positiveSentimentRate: 0.85,
      sentimentSummary: 'positive',
    };
    expect(attribution.completedRetestCount).toBe(2);
    expect(attribution.citationHitRate).toBe(0.5);
    expect(attribution.avgPositionDelta).toBe(-1.0);
    expect(attribution.sentimentSummary).toBe('positive');

    expect(testChannelConnectionSchema.parse(undefined)).toEqual({});
    expect(testChannelConnectionSchema.parse({ siteId: 'site-1', collectionId: 'col-1' })).toEqual({
      siteId: 'site-1',
      collectionId: 'col-1',
    });
  });

  it('4, 5, 6. variant generation, task edit, and publish schemas', () => {
    expect(createDistributionVariantsSchema.safeParse({ targets: [] }).success).toBe(false);
    const created = createDistributionVariantsSchema.parse({
      targets: [
        {
          provider: 'SHOPIFY',
          connectionId: 'conn_1',
          channelLabel: 'Shopify Official Blog',
          publishAsDraft: true,
        },
        {
          provider: 'SOCIAL_THREAD_ASSIST',
          channelLabel: 'X / LinkedIn Thread',
          templateKey: 'SOCIAL_THREAD',
        },
      ],
    });
    expect(created.targets).toHaveLength(2);

    expect(updateDistributionTaskSchema.safeParse({}).success).toBe(false);
    expect(updateDistributionTaskSchema.safeParse({ variantSlug: 'invalid slug!' }).success).toBe(
      false,
    );
    expect(
      updateDistributionTaskSchema.parse({
        variantTitle: 'Updated Title',
        variantSlug: 'valid-slug-2026',
        status: 'READY_TO_PUBLISH',
      }),
    ).toMatchObject({ variantSlug: 'valid-slug-2026', status: 'READY_TO_PUBLISH' });

    expect(publishDistributionTaskSchema.parse(undefined)).toEqual({
      acknowledgePreflightWarnings: false,
    });
    expect(
      publishDistributionTaskSchema.parse({
        publishAsDraft: false,
        acknowledgePreflightWarnings: true,
      }),
    ).toEqual({ publishAsDraft: false, acknowledgePreflightWarnings: true });
  });

  it('7, 8, 9, 10, 11. PR share, PR submit, crawl probe, retest config, and preflight schemas', () => {
    expect(createPrShareLinkSchema.parse(undefined)).toEqual({ ttlDays: 30 });
    expect(createPrShareLinkSchema.safeParse({ ttlDays: 91 }).success).toBe(false);

    expect(
      publicPrPacketSubmitSchema.parse({
        publishedUrl: 'https://techmedia.example.com/reviews/astravault',
        note: 'Published on homepage',
      }),
    ).toEqual({
      publishedUrl: 'https://techmedia.example.com/reviews/astravault',
      note: 'Published on homepage',
    });
    expect(
      publicPrPacketSubmitSchema.safeParse({ publishedUrl: 'ftp://bad.example.com' }).success,
    ).toBe(false);

    const probe = crawlProbeReportSchema.parse({
      checkedUrl: 'https://blog.example.com/post-1',
      finalUrl: 'https://blog.example.com/post-1',
      httpStatus: 200,
      robotsTxtFound: true,
      robotsMatrix: [
        { bot: '*', allowed: true },
        { bot: 'GPTBot', allowed: false, matchedRule: 'Disallow: /' },
      ],
      metaNoindex: false,
      jsonLdTypes: ['Article', 'FAQPage'],
      jsonLdParseErrors: [],
      canonicalUrl: 'https://blog.example.com/post-1',
      canonicalMatches: true,
      issues: ['robots.txt 拦截 GPTBot'],
    });
    expect(probe.jsonLdTypes).toEqual(['Article', 'FAQPage']);

    expect(retestScheduleConfigSchema.safeParse({}).success).toBe(false);
    expect(
      retestScheduleConfigSchema.parse({
        enabled: true,
        milestones: [30, 7, 14, 7],
        sampleCount: 3,
      }),
    ).toEqual({
      enabled: true,
      milestones: [7, 14, 30],
      sampleCount: 3,
    });
    expect(retestScheduleConfigSchema.safeParse({ sampleCount: 2 }).success).toBe(false);

    const preflight = distributionPreflightResultSchema.parse({
      ok: false,
      blockers: [
        {
          code: 'MISSING_FACT_SLOTS',
          severity: 'blocker',
          message: '存在未补全事实占位符',
          details: ['[待补充：续航数据]'],
        },
      ],
      warnings: [],
    });
    expect(preflight.ok).toBe(false);
  });
});

describe('evaluateDistributionPreflight()', () => {
  it('passes cleanly for a complete CN article with score >= 70 and matched facts', () => {
    const result = evaluateDistributionPreflight({
      market: 'CN',
      title: '2026 家用四盘位 NAS 实测横评',
      contentMarkdown: '星辰存储 DXP4800 满载噪音 28 dBA，实测功耗 18W。',
      geoScore: 86,
      matchedFactCount: 3,
      provider: 'WORDPRESS',
      variantSlug: 'dxp4800-nas-review-2026',
      variantMetaDesc: '2026 年四盘位静音 NAS 满载噪音与功耗实测对比。',
    });
    expect(result).toEqual({ ok: true, blockers: [], warnings: [] });
  });

  it('blocks missing fact placeholders in both CN and GLOBAL markets', () => {
    const cn = evaluateDistributionPreflight({
      market: 'CN',
      title: '产品实测报告',
      contentMarkdown: '电池容量：[待补充：官方电池容量]，噪音实测 28dB。',
      geoScore: 80,
      matchedFactCount: 2,
    });
    expect(cn.ok).toBe(false);
    expect(cn.blockers.map((b) => b.code)).toContain('MISSING_FACT_SLOTS');
    expect(cn.blockers[0]?.details).toContain('[待补充：官方电池容量]');

    const global = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'AstraVault NAS Benchmark [TBD: Firmware Version]',
      contentMarkdown: 'Measured wattage: [To be verified: lab idle power].',
      geoScore: 82,
      matchedFactCount: 2,
    });
    expect(global.ok).toBe(false);
    const missingBlocker = global.blockers.find((b) => b.code === 'MISSING_FACT_SLOTS');
    expect(missingBlocker?.details).toEqual([
      '[TBD: Firmware Version]',
      '[To be verified: lab idle power]',
    ]);
  });

  it('blocks non-brand CJK leakage in GLOBAL market while excluding CJK brand proper nouns', () => {
    const allowedBrandOnly = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'AstraVault (星辰存储) 4-Bay NAS Benchmark',
      contentMarkdown:
        'AstraVault — also known as 星辰存储 in APAC — delivers 28 dBA acoustic noise.',
      brandNames: ['AstraVault', '星辰存储'],
      geoScore: 85,
      matchedFactCount: 2,
    });
    expect(allowedBrandOnly.ok).toBe(true);
    expect(allowedBrandOnly.blockers).toEqual([]);

    const leaked = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'AstraVault (星辰存储) NAS Review',
      contentMarkdown: 'AstraVault (星辰存储) 是一款静音性能出色的产品 with 28 dBA noise.',
      brandNames: ['AstraVault', '星辰存储'],
      geoScore: 85,
      matchedFactCount: 2,
    });
    expect(leaked.ok).toBe(false);
    const cjkBlocker = leaked.blockers.find((b) => b.code === 'GLOBAL_CJK_LEAK');
    expect(cjkBlocker).toBeDefined();
    expect(cjkBlocker?.details).toContain('是一款静音性能出色的产品');

    // Boundary CJK codepoints (\u3400, \u4e00, \uf900) are caught
    for (const char of ['\u3400', '\u4e00', '\uf900']) {
      const boundary = evaluateDistributionPreflight({
        market: 'GLOBAL',
        title: 'Boundary Check',
        contentMarkdown: `Test text ${char} leaked`,
      });
      expect(boundary.ok).toBe(false);
      expect(boundary.blockers.map((b) => b.code)).toContain('GLOBAL_CJK_LEAK');
    }
  });

  it('blocks severe compliance flags but allows non-blocking replaced/warning flags', () => {
    const nonBlocking = evaluateDistributionPreflight({
      market: 'CN',
      title: '实测对比',
      contentMarkdown: '性能表现优异。',
      complianceFlags: [
        {
          code: 'AD_LAW_SUPERLATIVE',
          market: 'CN',
          term: '第一',
          replacement: '领先',
          severity: 'replaced',
          message: '已自动替换极限词',
        },
        {
          code: 'FTC_NOTICE',
          market: 'CN',
          term: '评测',
          severity: 'warning',
          message: '建议补充评测口径',
        },
      ],
      geoScore: 80,
      matchedFactCount: 1,
    });
    expect(nonBlocking.ok).toBe(true);

    const blocked = evaluateDistributionPreflight({
      market: 'CN',
      title: '高危合规测试',
      contentMarkdown: '正文内容',
      complianceFlags: [
        {
          code: 'PROHIBITED_INDUSTRY',
          market: 'CN',
          term: '博彩',
          severity: 'blocked',
          message: '命中禁做行业红线',
        },
      ],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.map((b) => b.code)).toContain('COMPLIANCE_BLOCKED');
  });

  it('produces soft warnings for low GEO score, missing fact cards, and missing L1 metadata (not L3)', () => {
    const l1 = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'Clean Global Draft',
      contentMarkdown: 'Objective specs without placeholders.',
      geoScore: 69,
      matchedFactCount: 0,
      provider: 'SHOPIFY',
      variantSlug: '',
      variantMetaDesc: '   ',
    });
    expect(l1.ok).toBe(true);
    expect(l1.blockers).toEqual([]);
    expect(l1.warnings.map((w) => w.code)).toEqual([
      'LOW_GEO_SCORE',
      'MISSING_FACT_CARDS',
      'MISSING_META_DESCRIPTION',
      'MISSING_SLUG',
    ]);

    const l3 = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'Clean Reddit Discussion',
      contentMarkdown: 'Objective community benchmark.',
      geoScore: 70,
      matchedFactCount: 1,
      provider: 'REDDIT_ASSIST',
      variantSlug: null,
      variantMetaDesc: null,
    });
    expect(l3.ok).toBe(true);
    expect(l3.warnings).toEqual([]);
  });

  it('S-04: scans variantMetaDesc for missing-fact slots and GLOBAL CJK leaks, catches fullwidth/bare placeholders, and ignores case differences in CJK brand names', () => {
    // 1. variantMetaDesc carrying both a missing-fact slot and non-brand CJK on GLOBAL
    const metaDescBlocked = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'Clean English Title',
      contentMarkdown: 'Verified 1200Wh portable power station review.',
      variantMetaDesc: 'Best power station [TBD: price] 中文摘要',
      geoScore: 85,
      matchedFactCount: 2,
      provider: 'SHOPIFY',
      variantSlug: 'clean-english-title',
    });
    expect(metaDescBlocked.ok).toBe(false);
    expect(metaDescBlocked.blockers.map((b) => b.code)).toContain('MISSING_FACT_SLOTS');
    expect(metaDescBlocked.blockers.map((b) => b.code)).toContain('GLOBAL_CJK_LEAK');

    // 2. Fullwidth Chinese/square brackets & bare placeholders
    const fullwidthAndBare = evaluateDistributionPreflight({
      market: 'CN',
      title: '测试标题',
      contentMarkdown:
        '价格为 【待补充：官方指导价】，规格为 ［TBD: spec］，其他待确认项：[TBD]、[待补充]、[To be verified]、【待补充】、【TBD】。',
      geoScore: 80,
      matchedFactCount: 1,
    });
    expect(fullwidthAndBare.ok).toBe(false);
    const slotBlocker = fullwidthAndBare.blockers.find((b) => b.code === 'MISSING_FACT_SLOTS');
    expect(slotBlocker).toBeDefined();
    expect(slotBlocker?.details).toEqual(
      expect.arrayContaining([
        '【待补充：官方指导价】',
        '［TBD: spec］',
        '[TBD]',
        '[待补充]',
        '[To be verified]',
        '【待补充】',
        '【TBD】',
      ]),
    );

    // 3. Mixed-case CJK brand proper noun (极米Pro vs 极米pro) must NOT false-positive GLOBAL_CJK_LEAK
    const mixedCaseBrand = evaluateDistributionPreflight({
      market: 'GLOBAL',
      title: 'XGIMI Projector Benchmark',
      contentMarkdown: 'Also sold in China under the 极米pro flagship name.',
      variantMetaDesc: 'Independent 极米PRO comparison.',
      brandNames: ['极米Pro', 'XGIMI'],
      geoScore: 88,
      matchedFactCount: 2,
    });
    expect(mixedCaseBrand.ok).toBe(true);
    expect(mixedCaseBrand.blockers).toEqual([]);
  });
});
