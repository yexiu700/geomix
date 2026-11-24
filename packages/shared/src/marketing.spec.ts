import { describe, expect, it } from 'vitest';
import {
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
} from './catalog';
import * as rootBarrel from './index';
import {
  MARKETING_GUIDES,
  MARKETING_GUIDE_SLUGS,
  MARKETING_LEAD_MARKETS,
  MARKETING_LEAD_MARKET_LABELS,
  MARKETING_LEAD_STATUSES,
  MARKETING_LEAD_STATUS_LABELS,
  MARKETING_LOCALES,
  POINTS_ESTIMATE_LIMITS,
  POINTS_ESTIMATE_TIERS,
  PUBLIC_PRICING_FALLBACK,
  buildPublicPricingPayload,
  calculateMonthlyPointsEstimate,
  createMarketingLeadSchema,
  getMarketingGuideBySlug,
  isSafeMarketingHttpUrl,
  listMarketingLeadsQuerySchema,
  updateMarketingLeadStatusSchema,
} from './marketing';

const BANNED_JARGON_TERMS = [
  '影子计费',
  '零拷贝',
  '检索适配器',
  '复刻落库状态',
  '已落库查看',
  '切分向量索引',
  '整段注入',
  '切片向量化',
  '含手工槽位·不入随机池',
  '模型收录计数留到后续模块',
] as const;

describe('marketing enums and label maps', () => {
  it('defines lead statuses, markets, and locales aligned with Prisma schema', () => {
    expect(MARKETING_LEAD_STATUSES).toEqual(['NEW', 'CONTACTED', 'TRIAL_PROVISIONED', 'ARCHIVED']);
    for (const status of MARKETING_LEAD_STATUSES) {
      expect(MARKETING_LEAD_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }

    expect(MARKETING_LEAD_MARKETS).toEqual(['GLOBAL', 'CN', 'BOTH']);
    for (const market of MARKETING_LEAD_MARKETS) {
      expect(MARKETING_LEAD_MARKET_LABELS[market].en.length).toBeGreaterThan(0);
      expect(MARKETING_LEAD_MARKET_LABELS[market].zh.length).toBeGreaterThan(0);
    }

    expect(MARKETING_LOCALES).toEqual(['en', 'zh-CN']);
    expect(POINTS_ESTIMATE_TIERS).toEqual(['TRIAL', 'GROWTH', 'ENTERPRISE']);
  });
});

describe('isSafeMarketingHttpUrl', () => {
  it('accepts valid public http(s) URLs including punycode IDNs and path/query @ signs', () => {
    expect(isSafeMarketingHttpUrl('https://example.com')).toBe(true);
    expect(isSafeMarketingHttpUrl('http://blog.example.co.uk/geo?ref=1#top')).toBe(true);
    expect(isSafeMarketingHttpUrl('https://xn--bcher-kva.example/docs')).toBe(true);
    expect(isSafeMarketingHttpUrl('  https://nordicaudio.example/  ')).toBe(true);
    expect(isSafeMarketingHttpUrl('https://medium.com/@nordicaudio')).toBe(true);
    expect(isSafeMarketingHttpUrl('https://example.com/contact?email=team@example.com')).toBe(true);
  });

  it('rejects dangerous schemes, credentials, authority differentials, port 0, whitespace, control chars, and overlong URLs', () => {
    const invalidUrls = [
      '',
      '   ',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
      'mailto:a@example.com',
      'https://user:pass@example.com',
      'https://user@example.com',
      'https://@example.com',
      'https://:@example.com',
      'https://example.com\\@evil.com',
      'https://example.com/a\\b',
      'http://example.com:0/',
      'https:example.com',
      'https://example.com/with space',
      'https://example.com/\nheader',
      'https://example.com\r\n',
      `https://example.com/${'a'.repeat(2050)}`,
    ];

    for (const url of invalidUrls) {
      expect(isSafeMarketingHttpUrl(url)).toBe(false);
    }
  });

  it('rejects localhost, internal suffixes, single-label hosts, and IP literals', () => {
    const ssrfTargets = [
      'http://localhost',
      'http://localhost:3000',
      'http://sub.localhost',
      'http://printer.local',
      'http://svc.internal',
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.1',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0',
      'http://[::1]',
      'http://[fe80::1]',
      'http://[fc00::1]',
      'http://[::ffff:127.0.0.1]',
      'http://2130706433',
      'http://0x7f000001',
      'http://0177.0.0.1',
      'http://intranet',
      'http://metadata',
    ];

    for (const url of ssrfTargets) {
      expect(isSafeMarketingHttpUrl(url)).toBe(false);
    }
  });
});

describe('createMarketingLeadSchema', () => {
  it('applies defaults, trims fields, and lowercases email on minimal valid payload', () => {
    const parsed = createMarketingLeadSchema.parse({
      name: '  Alex Rivera  ',
      email: '  Alex@Example.COM ',
      companyBrand: '  NordicAudio  ',
    });

    expect(parsed).toEqual({
      locale: 'en',
      name: 'Alex Rivera',
      email: 'alex@example.com',
      companyBrand: 'NordicAudio',
      websiteUrl: undefined,
      targetMarket: 'GLOBAL',
      monthlyGoal: undefined,
      estimatedPts: undefined,
      notes: undefined,
      sourcePage: undefined,
      honeypot: undefined,
    });
  });

  it('parses full payload including multiline notes and normalizes blank optional values', () => {
    const full = createMarketingLeadSchema.parse({
      locale: 'zh-CN',
      name: '林思远',
      email: 'lin@example.com',
      companyBrand: '北境声学',
      websiteUrl: 'https://example.com/zh',
      targetMarket: 'BOTH',
      monthlyGoal: '每月 12 篇引用级长文 + 双市场追踪',
      estimatedPts: 1480,
      notes: '希望安排本周演示\n重点看 Shopify 与复测流程',
      sourcePage: '/zh/demo',
    });

    expect(full.locale).toBe('zh-CN');
    expect(full.targetMarket).toBe('BOTH');
    expect(full.websiteUrl).toBe('https://example.com/zh');
    expect(full.estimatedPts).toBe(1480);
    expect(full.notes).toContain('\n');

    const blanks = createMarketingLeadSchema.parse({
      name: 'Sam',
      email: 'sam@example.com',
      companyBrand: 'NordicAudio',
      websiteUrl: '   ',
      monthlyGoal: '',
      estimatedPts: null,
      notes: '   ',
      sourcePage: '',
    });

    expect(blanks.websiteUrl).toBeUndefined();
    expect(blanks.monthlyGoal).toBeUndefined();
    expect(blanks.estimatedPts).toBeUndefined();
    expect(blanks.notes).toBeUndefined();
    expect(blanks.sourcePage).toBeUndefined();
  });

  it('accepts non-empty honeypot so server can silently drop bot submissions without 400', () => {
    const parsed = createMarketingLeadSchema.parse({
      name: 'Bot User',
      email: 'bot@example.com',
      companyBrand: 'BotCo',
      honeypot: 'bot-filled-value',
    });

    expect(parsed.honeypot).toBe('bot-filled-value');
  });

  it('rejects invalid inputs, unsafe URLs, bad sourcePage, non-int estimatedPts, and smuggled keys', () => {
    const base = {
      name: 'Alex',
      email: 'alex@example.com',
      companyBrand: 'NordicAudio',
    };

    expect(createMarketingLeadSchema.safeParse({ ...base, email: 'not-an-email' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createMarketingLeadSchema.safeParse({ ...base, companyBrand: '' }).success).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, websiteUrl: 'http://127.0.0.1/admin' })
        .success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, websiteUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, websiteUrl: 'https://@example.com' }).success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, websiteUrl: 'https://:@example.com' }).success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({
        ...base,
        websiteUrl: 'https://example.com\\@evil.com',
      }).success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, websiteUrl: 'http://example.com:0/' }).success,
    ).toBe(false);
    expect(
      createMarketingLeadSchema.safeParse({ ...base, sourcePage: '//evil.example' }).success,
    ).toBe(false);
    expect(createMarketingLeadSchema.safeParse({ ...base, sourcePage: '/demo\\x' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, sourcePage: '/demo foo' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, sourcePage: '/demo\tfoo' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, estimatedPts: -1 }).success).toBe(false);
    expect(createMarketingLeadSchema.safeParse({ ...base, estimatedPts: 12.5 }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, estimatedPts: true }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, name: 'Alex\u0000' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, notes: 'Bad\u0007bell' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, notes: 'a'.repeat(2001) }).success).toBe(
      false,
    );

    // Normalize -0 estimatedPts to +0
    const zeroPts = createMarketingLeadSchema.parse({ ...base, estimatedPts: -0 });
    expect(Object.is(zeroPts.estimatedPts, 0)).toBe(true);
    expect(Object.is(zeroPts.estimatedPts, -0)).toBe(false);

    // Reject smuggled server-owned fields via .strict()
    expect(createMarketingLeadSchema.safeParse({ ...base, status: 'CONTACTED' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, adminNote: 'hack' }).success).toBe(false);
    expect(createMarketingLeadSchema.safeParse({ ...base, sourceIpHash: 'abc123' }).success).toBe(
      false,
    );
    expect(createMarketingLeadSchema.safeParse({ ...base, tenantId: 't_1' }).success).toBe(false);
  });
});

describe('updateMarketingLeadStatusSchema', () => {
  it('accepts status-only, note-only, null-clear note, and combined updates', () => {
    expect(updateMarketingLeadStatusSchema.parse({ status: 'CONTACTED' })).toEqual({
      status: 'CONTACTED',
    });
    expect(updateMarketingLeadStatusSchema.parse({ adminNote: '  已邮件跟进  ' })).toEqual({
      adminNote: '已邮件跟进',
    });
    expect(updateMarketingLeadStatusSchema.parse({ adminNote: null })).toEqual({
      adminNote: null,
    });
    expect(
      updateMarketingLeadStatusSchema.parse({
        status: 'TRIAL_PROVISIONED',
        adminNote: '已开通 1000 点演示账号',
      }),
    ).toEqual({
      status: 'TRIAL_PROVISIONED',
      adminNote: '已开通 1000 点演示账号',
    });
  });

  it('rejects empty body, invalid status, control characters, overlong notes, and extra keys', () => {
    expect(updateMarketingLeadStatusSchema.safeParse({}).success).toBe(false);
    expect(updateMarketingLeadStatusSchema.safeParse({ status: 'CLOSED' }).success).toBe(false);
    expect(updateMarketingLeadStatusSchema.safeParse({ adminNote: 'bad\u0000char' }).success).toBe(
      false,
    );
    expect(updateMarketingLeadStatusSchema.safeParse({ adminNote: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      updateMarketingLeadStatusSchema.safeParse({ status: 'NEW', tenantId: 't_1' }).success,
    ).toBe(false);
  });
});

describe('listMarketingLeadsQuerySchema', () => {
  it('applies pagination defaults and parses stringified query params cleanly', () => {
    expect(listMarketingLeadsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      status: undefined,
      targetMarket: undefined,
      keyword: undefined,
    });

    expect(
      listMarketingLeadsQuerySchema.parse({
        page: '3',
        pageSize: '50',
        status: 'NEW',
        targetMarket: 'GLOBAL',
        keyword: '  Nordic  ',
      }),
    ).toEqual({
      page: 3,
      pageSize: 50,
      status: 'NEW',
      targetMarket: 'GLOBAL',
      keyword: 'Nordic',
    });

    expect(
      listMarketingLeadsQuerySchema.parse({
        page: '',
        pageSize: '   ',
        status: '',
        targetMarket: '',
        keyword: '   ',
      }),
    ).toEqual({
      page: 1,
      pageSize: 20,
      status: undefined,
      targetMarket: undefined,
      keyword: undefined,
    });
  });

  it('rejects out-of-range pagination, loose type coercions, unknown filters, control chars, and extra keys', () => {
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '-1' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: 'NaN' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: true }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: false }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ pageSize: true }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: [2] }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '0x10' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '1e2' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '0o10' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ page: '0b10' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ pageSize: '0x10' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ status: 'INVALID' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ targetMarket: 'EU' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ keyword: 'test\nline' }).success).toBe(false);
    expect(listMarketingLeadsQuerySchema.safeParse({ tenantId: 't_1' }).success).toBe(false);
  });
});

describe('PUBLIC_PRICING_FALLBACK and buildPublicPricingPayload', () => {
  it('stays 1:1 aligned with catalog PRICING_DEFAULTS, 7 FREE_RATE_LIMITED_ACTIONS, and Demo quota', () => {
    expect(PUBLIC_PRICING_FALLBACK.items.map((item) => item.action)).toEqual(
      PRICING_DEFAULTS.map((item) => item.action),
    );
    expect(PUBLIC_PRICING_FALLBACK.items.map((item) => item.unitPoints)).toEqual(
      PRICING_DEFAULTS.map((item) => item.unitPoints),
    );
    expect(PUBLIC_PRICING_FALLBACK.freeActions.map((item) => item.action)).toEqual([
      ...FREE_RATE_LIMITED_ACTIONS,
    ]);
    expect(PUBLIC_PRICING_FALLBACK.freeActions).toHaveLength(7);
    expect(PUBLIC_PRICING_FALLBACK.demoTrial).toEqual({
      points: DEMO_TENANT_POINTS,
      validDays: DEMO_TENANT_VALID_DAYS,
    });
  });

  it('merges valid live overrides, allows geo_variant=0, ignores retired/disabled/invalid rows', () => {
    const merged = buildPublicPricingPayload([
      { action: 'geo_write', unitPoints: 12, enabled: true },
      { action: 'geo_variant', unitPoints: 0, enabled: true },
      { action: 'visibility_check', unitPoints: 0, enabled: true }, // invalid: must be > 0
      { action: 'inline_image_gen', unitPoints: 9, enabled: false }, // disabled
      { action: 'kb_addon', unitPoints: 3, enabled: true }, // retired action ignored
    ]);

    const byAction = Object.fromEntries(merged.items.map((item) => [item.action, item.unitPoints]));
    expect(byAction).toEqual({
      geo_write: 12,
      visibility_check: 2,
      inline_image_gen: 5,
      geo_variant: 0,
    });
    expect(merged.items).toHaveLength(4);
    expect(merged.freeActions).toHaveLength(7);
    expect(merged.demoTrial).toEqual({ points: 1000, validDays: 365 });

    const normalized = buildPublicPricingPayload([
      { action: 'geo_variant', unitPoints: -0, enabled: true },
      { action: 'geo_write', unitPoints: 1_000_001, enabled: true }, // exceeds cap -> fallback 10
    ]);
    const variantItem = normalized.items.find((item) => item.action === 'geo_variant');
    const writeItem = normalized.items.find((item) => item.action === 'geo_write');
    expect(Object.is(variantItem?.unitPoints, 0)).toBe(true);
    expect(Object.is(variantItem?.unitPoints, -0)).toBe(false);
    expect(writeItem?.unitPoints).toBe(10);
  });
});

describe('calculateMonthlyPointsEstimate', () => {
  it('computes exact default breakdown and TRIAL tier', () => {
    const result = calculateMonthlyPointsEstimate();
    expect(result.normalizedInput).toEqual({
      monthlyArticles: POINTS_ESTIMATE_LIMITS.monthlyArticles.default,
      variantChannelsPerArticle: POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.default,
      trackedPrompts: POINTS_ESTIMATE_LIMITS.trackedPrompts.default,
      monitoredEngines: POINTS_ESTIMATE_LIMITS.monitoredEngines.default,
      samplesPerPrompt: 1,
      enableAutoRetest: true,
    });
    expect(result.writingPoints).toBe(80);
    expect(result.variantPoints).toBe(32);
    expect(result.baselineVisibilityPoints).toBe(160);
    expect(result.retestVisibilityPoints).toBe(192);
    expect(result.totalMonthlyPoints).toBe(464);
    expect(result.recommendedTier).toBe('TRIAL');
  });

  it('handles auto-retest toggle, 3-sample mode, and geo_variant=0 override', () => {
    const noRetest = calculateMonthlyPointsEstimate({ enableAutoRetest: false });
    expect(noRetest.retestVisibilityPoints).toBe(0);
    expect(noRetest.totalMonthlyPoints).toBe(272);

    const threeSamples = calculateMonthlyPointsEstimate({ samplesPerPrompt: 3 });
    expect(threeSamples.baselineVisibilityPoints).toBe(480);
    expect(threeSamples.retestVisibilityPoints).toBe(576);
    expect(threeSamples.totalMonthlyPoints).toBe(1168);
    expect(threeSamples.recommendedTier).toBe('GROWTH');

    const freeVariants = calculateMonthlyPointsEstimate({
      unitPoints: { geo_variant: 0 },
    });
    expect(freeVariants.variantPoints).toBe(0);
    expect(freeVariants.totalMonthlyPoints).toBe(432);
  });

  it('clamps below-min, above-max, float, NaN, and Infinity inputs deterministically', () => {
    const minClamped = calculateMonthlyPointsEstimate({
      monthlyArticles: -5,
      variantChannelsPerArticle: -2,
      trackedPrompts: 0,
      monitoredEngines: 0,
      samplesPerPrompt: 1,
      enableAutoRetest: false,
    });
    expect(minClamped.normalizedInput).toEqual({
      monthlyArticles: 1,
      variantChannelsPerArticle: 0,
      trackedPrompts: 5,
      monitoredEngines: 1,
      samplesPerPrompt: 1,
      enableAutoRetest: false,
    });
    expect(minClamped.totalMonthlyPoints).toBe(20);
    expect(minClamped.recommendedTier).toBe('TRIAL');

    const maxClamped = calculateMonthlyPointsEstimate({
      monthlyArticles: 999,
      variantChannelsPerArticle: 20,
      trackedPrompts: 500,
      monitoredEngines: 12,
      samplesPerPrompt: 3,
      enableAutoRetest: true,
    });
    expect(maxClamped.normalizedInput).toEqual({
      monthlyArticles: 50,
      variantChannelsPerArticle: 4,
      trackedPrompts: 100,
      monitoredEngines: 5,
      samplesPerPrompt: 3,
      enableAutoRetest: true,
    });
    // 50*10 + 50*4*2 + 100*5*3*2 + 50*3*5*3*2 = 500 + 400 + 3000 + 4500 = 8400
    expect(maxClamped.totalMonthlyPoints).toBe(8400);
    expect(maxClamped.recommendedTier).toBe('GROWTH');

    const nanHandled = calculateMonthlyPointsEstimate({
      monthlyArticles: Number.NaN,
      variantChannelsPerArticle: Number.POSITIVE_INFINITY,
      trackedPrompts: 19.6,
      monitoredEngines: 3.4,
    });
    expect(nanHandled.normalizedInput).toEqual({
      monthlyArticles: 8,
      variantChannelsPerArticle: 2,
      trackedPrompts: 20,
      monitoredEngines: 3,
      samplesPerPrompt: 1,
      enableAutoRetest: true,
    });
  });

  it('enforces exact tier boundaries (<=1000 TRIAL, <=10000 GROWTH, >10000 ENTERPRISE)', () => {
    // 10*10 + 0 + 90*5*1*2 + 0 = 100 + 900 = 1000 -> TRIAL
    const atTrialCeiling = calculateMonthlyPointsEstimate({
      monthlyArticles: 10,
      variantChannelsPerArticle: 0,
      trackedPrompts: 90,
      monitoredEngines: 5,
      samplesPerPrompt: 1,
      enableAutoRetest: false,
    });
    expect(atTrialCeiling.totalMonthlyPoints).toBe(1000);
    expect(atTrialCeiling.recommendedTier).toBe('TRIAL');

    // 11*10 + 0 + 90*5*1*2 + 0 = 110 + 900 = 1010 -> GROWTH
    const aboveTrialCeiling = calculateMonthlyPointsEstimate({
      monthlyArticles: 11,
      variantChannelsPerArticle: 0,
      trackedPrompts: 90,
      monitoredEngines: 5,
      samplesPerPrompt: 1,
      enableAutoRetest: false,
    });
    expect(aboveTrialCeiling.totalMonthlyPoints).toBe(1010);
    expect(aboveTrialCeiling.recommendedTier).toBe('GROWTH');

    // 50*20 + 0 + 100*5*3*2 + 50*3*5*3*2 = 1000 + 3000 + 4500 = 8500 -> adjust to exact 10000
    // 50*20 + 50*4*5 + 100*5*3*2 + 50*3*5*3*2 -> 1000 + 1000 + 3000 + 4500 = 9500
    // 50*30 + 50*4*5 + 100*5*3*2 + 50*3*5*3*2 = 1500 + 1000 + 3000 + 4500 = 10000 -> GROWTH
    const atGrowthCeiling = calculateMonthlyPointsEstimate({
      monthlyArticles: 50,
      variantChannelsPerArticle: 4,
      trackedPrompts: 100,
      monitoredEngines: 5,
      samplesPerPrompt: 3,
      enableAutoRetest: true,
      unitPoints: { geo_write: 30, geo_variant: 5, visibility_check: 2 },
    });
    expect(atGrowthCeiling.totalMonthlyPoints).toBe(10000);
    expect(atGrowthCeiling.recommendedTier).toBe('GROWTH');

    // Max inputs with visibility_check=3 -> 500 + 400 + 4500 + 6750 = 12150 -> ENTERPRISE
    const enterprise = calculateMonthlyPointsEstimate({
      monthlyArticles: 50,
      variantChannelsPerArticle: 4,
      trackedPrompts: 100,
      monitoredEngines: 5,
      samplesPerPrompt: 3,
      enableAutoRetest: true,
      unitPoints: { visibility_check: 3 },
    });
    expect(enterprise.totalMonthlyPoints).toBe(12150);
    expect(enterprise.recommendedTier).toBe('ENTERPRISE');
  });

  it('prevents -0 leakage, Infinity overflow on huge unitPoints, and null input crashes', () => {
    const negPointOne = calculateMonthlyPointsEstimate({
      unitPoints: { geo_variant: -0.1 },
    });
    expect(Object.is(negPointOne.unitPoints.geo_variant, 0)).toBe(true);
    expect(Object.is(negPointOne.unitPoints.geo_variant, -0)).toBe(false);
    expect(Object.is(negPointOne.variantPoints, 0)).toBe(true);
    expect(Object.is(negPointOne.variantPoints, -0)).toBe(false);
    expect(new Intl.NumberFormat('en-US').format(negPointOne.variantPoints)).toBe('0');

    const negZero = calculateMonthlyPointsEstimate({
      variantChannelsPerArticle: -0,
      unitPoints: { geo_variant: -0 },
    });
    expect(Object.is(negZero.normalizedInput.variantChannelsPerArticle, 0)).toBe(true);
    expect(Object.is(negZero.unitPoints.geo_variant, 0)).toBe(true);
    expect(Object.is(negZero.variantPoints, 0)).toBe(true);

    const overflowGuarded = calculateMonthlyPointsEstimate({
      unitPoints: { geo_write: 1e308 },
    });
    expect(overflowGuarded.unitPoints.geo_write).toBe(10);
    expect(Number.isFinite(overflowGuarded.writingPoints)).toBe(true);
    expect(Number.isFinite(overflowGuarded.totalMonthlyPoints)).toBe(true);
    expect(overflowGuarded.totalMonthlyPoints).toBe(464);

    const fromNull = calculateMonthlyPointsEstimate(
      null as unknown as Parameters<typeof calculateMonthlyPointsEstimate>[0],
    );
    expect(fromNull.totalMonthlyPoints).toBe(464);
    expect(fromNull.recommendedTier).toBe('TRIAL');
  });
});

describe('MARKETING_GUIDES, lookup, and copy guardrails', () => {
  it('provides exactly 4 complete bilingual guides with strict slug lookup', () => {
    expect(MARKETING_GUIDES.map((guide) => guide.slug)).toEqual([...MARKETING_GUIDE_SLUGS]);
    expect(MARKETING_GUIDES).toHaveLength(4);
    expect(new Set(MARKETING_GUIDES.map((guide) => guide.slug)).size).toBe(4);

    for (const guide of MARKETING_GUIDES) {
      expect(guide.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(guide.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(guide.readingMinutes).toBeGreaterThan(0);

      for (const content of [guide.en, guide.zh]) {
        expect(content.title.trim().length).toBeGreaterThan(0);
        expect(content.subtitle.trim().length).toBeGreaterThan(0);
        expect(content.description.trim().length).toBeGreaterThan(0);
        expect(content.category.trim().length).toBeGreaterThan(0);
        expect(content.tags.length).toBeGreaterThanOrEqual(2);
        expect(content.keyTakeaways.length).toBeGreaterThanOrEqual(3);
        expect(content.sections.length).toBeGreaterThanOrEqual(3);

        const sectionIds = content.sections.map((section) => section.id);
        expect(new Set(sectionIds).size).toBe(sectionIds.length);
        for (const section of content.sections) {
          expect(section.heading.trim().length).toBeGreaterThan(0);
          expect(section.paragraphs.length).toBeGreaterThanOrEqual(1);
        }
      }

      expect(getMarketingGuideBySlug(guide.slug)).toBe(guide);
    }

    expect(getMarketingGuideBySlug('unknown-guide')).toBeNull();
    expect(getMarketingGuideBySlug('')).toBeNull();
    expect(getMarketingGuideBySlug('GEO-CITATION-VS-MENTION')).toBeNull();
  });

  it('contains zero banned internal jargon, zero fiat price symbols, and matches root barrel exports', () => {
    const serialized = JSON.stringify({
      pricing: PUBLIC_PRICING_FALLBACK,
      guides: MARKETING_GUIDES,
      statusLabels: MARKETING_LEAD_STATUS_LABELS,
      marketLabels: MARKETING_LEAD_MARKET_LABELS,
    });

    for (const term of BANNED_JARGON_TERMS) {
      expect(serialized).not.toContain(term);
    }
    expect(serialized).not.toMatch(/[$¥]/);

    expect(rootBarrel.PUBLIC_PRICING_FALLBACK).toBe(PUBLIC_PRICING_FALLBACK);
    expect(rootBarrel.MARKETING_GUIDES).toBe(MARKETING_GUIDES);
    expect(rootBarrel.calculateMonthlyPointsEstimate).toBe(calculateMonthlyPointsEstimate);
    expect(rootBarrel.createMarketingLeadSchema).toBe(createMarketingLeadSchema);
    expect(rootBarrel.getMarketingGuideBySlug).toBe(getMarketingGuideBySlug);
  });
});
