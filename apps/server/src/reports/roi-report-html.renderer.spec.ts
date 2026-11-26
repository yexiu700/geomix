import { describe, expect, it } from 'vitest';
import {
  computeDifferenceInDifferences,
  computeWilsonInterval,
  type GeoRoiReportSummaryDto,
} from '@geomix/shared';
import {
  RoiReportHtmlRenderer,
  escapeHtml,
  renderRoiReportHtml,
  type RoiReportHtmlRenderInput,
} from './roi-report-html.renderer';

function buildRichSummary(): GeoRoiReportSummaryDto {
  const did = computeDifferenceInDifferences({
    treatmentBaseline: 0.2,
    treatmentCurrent: 0.65,
    controlBaseline: 0.2,
    controlCurrent: 0.25,
  });

  return {
    version: 1,
    overview: {
      totalObservations: 40,
      mentionHits: 26,
      mentionRate: 0.65,
      mentionWilson: computeWilsonInterval(26, 40),
      citationHits: 18,
      citationRate: 0.45,
      ownedCitationHits: 12,
      ownedCitationRate: 0.3,
      confidenceLevel: computeWilsonInterval(26, 40).confidenceLevel,
      did,
    },
    byEngine: [
      {
        engine: 'chatgpt',
        observations: 20,
        mentionRate: 0.7,
        citationRate: 0.5,
        ownedCitationRate: 0.35,
        avgPosition: 1.4,
        mentionWilson: computeWilsonInterval(14, 20),
      },
      {
        engine: 'doubao',
        observations: 20,
        mentionRate: 0.6,
        citationRate: 0.4,
        ownedCitationRate: 0.25,
        avgPosition: 2.1,
        mentionWilson: computeWilsonInterval(12, 20),
      },
    ],
    nearMiss: {
      totalOpportunities: 11,
      boostBriefsCreated: 4,
      convertedToCited: 2,
      tierCounts: {
        OPENED_NOT_CITED: 3,
        RETRIEVED_NOT_CITED: 4,
        CRAWLED_NOT_CITED: 2,
        MENTIONED_NOT_OWNED: 2,
      },
    },
    funnel: {
      publishedTotal: 10,
      l1Count: 5,
      l2Count: 2,
      l3Count: 3,
      crawlCheckedCount: 8,
      crawlOkCount: 7,
      crawlOkRate: 0.875,
      indexNowAttemptedCount: 6,
      indexNowSuccessCount: 5,
      indexNowRate: 0.8333,
    },
    channelRanking: [
      {
        channel: 'Shopify Blog',
        provider: 'SHOPIFY',
        mode: 'L1_API',
        publishedCount: 5,
        completedRetestCount: 4,
        citationHitCount: 3,
        citationHitRate: 0.75,
        citationHitWilson: computeWilsonInterval(3, 4),
        avgMentionRateDelta: 0.25,
      },
      {
        channel: '微信公众号草稿箱',
        provider: 'WECHAT_OFFICIAL',
        mode: 'L1_API',
        publishedCount: 3,
        completedRetestCount: 2,
        citationHitCount: 1,
        citationHitRate: 0.5,
        citationHitWilson: computeWilsonInterval(1, 2),
        avgMentionRateDelta: 0.15,
      },
    ],
    milestoneTrend: [
      {
        milestoneDay: 0,
        trials: 10,
        hits: 2,
        mentionRate: 0.2,
        wilson: computeWilsonInterval(2, 10),
        controlMentionRate: 0.2,
        did: null,
      },
      {
        milestoneDay: 7,
        trials: 12,
        hits: 6,
        mentionRate: 0.5,
        wilson: computeWilsonInterval(6, 12),
        controlMentionRate: 0.22,
        did: computeDifferenceInDifferences({
          treatmentBaseline: 0.2,
          treatmentCurrent: 0.5,
          controlBaseline: 0.2,
          controlCurrent: 0.22,
        }),
      },
      {
        milestoneDay: 14,
        trials: 12,
        hits: 7,
        mentionRate: 0.5833,
        wilson: computeWilsonInterval(7, 12),
        controlMentionRate: 0.24,
        did: computeDifferenceInDifferences({
          treatmentBaseline: 0.2,
          treatmentCurrent: 0.5833,
          controlBaseline: 0.2,
          controlCurrent: 0.24,
        }),
      },
      {
        milestoneDay: 30,
        trials: 20,
        hits: 13,
        mentionRate: 0.65,
        wilson: computeWilsonInterval(13, 20),
        controlMentionRate: 0.25,
        did,
      },
    ],
    pointsRoi: {
      totalPointsSpent: 480,
      articlesPublished: 10,
      citationHitsGained: 4,
      pointsPerPublishedArticle: 48,
      pointsPerCitationHit: 120,
    },
  };
}

function makeInput(overrides: Partial<RoiReportHtmlRenderInput> = {}): RoiReportHtmlRenderInput {
  return {
    title: 'AstraVault Monthly GEO ROI Report',
    brandName: 'AstraVault',
    category: 'Home NAS Storage',
    market: 'GLOBAL',
    locale: 'en-US',
    whiteLabelOrg: null,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-31T23:59:59.999Z',
    generatedAt: '2026-11-01T08:30:00.000Z',
    summary: buildRichSummary(),
    includePointsRoi: true,
    ...overrides,
  };
}

describe('RoiReportHtmlRenderer (#369)', () => {
  it('renders self-contained offline HTML5 with inline SVG trend + funnel charts, @media print A4 CSS, and ZERO external URLs or scripts', () => {
    const renderer = new RoiReportHtmlRenderer();
    const html = renderer.render(makeInput());

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en-US">');

    // Inline SVG charts (both milestone trend and distribution funnel)
    const svgMatches = html.match(/<svg\b/g) ?? [];
    expect(svgMatches.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<polygon points='); // Wilson 95% CI band
    expect(html).toContain('<polyline points='); // Treatment & control lines
    expect(html).toContain('T+0');
    expect(html).toContain('T+7');
    expect(html).toContain('T+14');
    expect(html).toContain('T+30');

    // @media print + A4 pagination CSS
    expect(html).toContain('@page');
    expect(html).toContain('size: A4');
    expect(html).toContain('@media print');
    expect(html).toContain('break-inside: avoid');

    // ZERO external resources, CDNs, or scripts
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/fonts\.googleapis\.com/i);
    expect(html).not.toMatch(/cdn\./i);
  });

  it('escapes all XSS payloads across whiteLabelOrg, title, brandName, category, engine, and channel names', () => {
    expect(escapeHtml(`<script>alert("x")</script>'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;',
    );

    const summary = buildRichSummary();
    summary.byEngine[0]!.engine = `"><img src=x onerror=alert(1)>`;
    summary.channelRanking[0] = {
      ...summary.channelRanking[0]!,
      provider: null,
      channel: `' onmouseover='alert(2)<svg onload=alert(3)>`,
    };

    const html = renderRoiReportHtml(
      makeInput({
        title: `<script>alert('title')</script>`,
        whiteLabelOrg: `"><img src=x onerror=alert('org')>`,
        brandName: `Brand <script>alert('brand')</script>`,
        category: `Cat ' onclick='alert(4)`,
        summary,
      }),
    );

    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg onload=');
    expect(html).not.toMatch(/<[a-z][^>]*\son(?:error|mouseover|click|load)\s*=/i);

    expect(html).toContain('&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(&#39;org&#39;)&gt;');
    expect(html).toContain('&#39; onmouseover=&#39;alert(2)&lt;svg onload=alert(3)&gt;');
  });

  it('enforces pure EN output (zero CJK characters even with domestic engines/channels) and pure CN output', () => {
    const enHtml = renderRoiReportHtml(makeInput({ locale: 'en-US', market: 'GLOBAL' }));
    expect(enHtml).toContain('Doubao');
    expect(enHtml).toContain('WeChat Official Drafts');
    expect(enHtml).toContain('Opened, Not Cited (Tier 1)');
    expect(enHtml).not.toMatch(/[\u4E00-\u9FFF]/);

    const zhHtml = renderRoiReportHtml(
      makeInput({
        locale: 'zh-CN',
        market: 'CN',
        title: '星辰存储月度 GEO 复盘报告',
        brandName: '星辰存储',
        category: '家用 NAS 存储',
      }),
    );
    expect(zhHtml).toContain('<html lang="zh-CN">');
    expect(zhHtml).toContain('由 GeoMix 提供支持');
    expect(zhHtml).toContain('豆包');
    expect(zhHtml).toContain('AI 点开未引用（Tier 1）');
    expect(zhHtml).toContain('复测里程碑趋势');
    expect(zhHtml).not.toContain('Powered by GeoMix');
  });

  it('handles whiteLabelOrg branding toggle and pointsRoi inclusion/omission cleanly', () => {
    const whiteLabeled = renderRoiReportHtml(
      makeInput({ whiteLabelOrg: 'Apex Growth Partners', includePointsRoi: false }),
    );
    expect(whiteLabeled).toContain('Apex Growth Partners');
    expect(whiteLabeled).not.toContain('Powered by GeoMix');
    expect(whiteLabeled).not.toContain('Points Spend &amp; ROI Efficiency');

    const defaultBranded = renderRoiReportHtml(
      makeInput({ whiteLabelOrg: null, includePointsRoi: true }),
    );
    expect(defaultBranded).toContain('AstraVault · Powered by GeoMix');
    expect(defaultBranded).toContain('Points Spend &amp; ROI Efficiency');
    expect(defaultBranded).toContain('480 pts');
  });

  it('handles empty arrays, single milestone point, zero funnel, and NaN/Infinity values without producing NaN or Infinity in SVG/HTML', () => {
    const edgeSummary: GeoRoiReportSummaryDto = {
      version: 1,
      overview: {
        totalObservations: 0,
        mentionHits: 0,
        mentionRate: Number.NaN,
        mentionWilson: computeWilsonInterval(0, 0),
        citationHits: 0,
        citationRate: Number.POSITIVE_INFINITY,
        ownedCitationHits: 0,
        ownedCitationRate: 0,
        confidenceLevel: 'INSUFFICIENT',
        did: null,
      },
      byEngine: [],
      nearMiss: {
        totalOpportunities: 0,
        boostBriefsCreated: 0,
        convertedToCited: 0,
        tierCounts: {
          OPENED_NOT_CITED: 0,
          RETRIEVED_NOT_CITED: 0,
          CRAWLED_NOT_CITED: 0,
          MENTIONED_NOT_OWNED: 0,
        },
      },
      funnel: {
        publishedTotal: 0,
        l1Count: 0,
        l2Count: 0,
        l3Count: 0,
        crawlCheckedCount: 0,
        crawlOkCount: 0,
        crawlOkRate: null,
        indexNowAttemptedCount: 0,
        indexNowSuccessCount: 0,
        indexNowRate: null,
      },
      channelRanking: [],
      milestoneTrend: [],
    };

    const emptyHtml = renderRoiReportHtml(makeInput({ summary: edgeSummary }));
    expect(emptyHtml).not.toContain('NaN');
    expect(emptyHtml).not.toContain('Infinity');
    expect(emptyHtml).toContain('No completed retest milestone data');

    // Single milestone point with non-finite controlMentionRate
    edgeSummary.milestoneTrend = [
      {
        milestoneDay: 7,
        trials: 3,
        hits: 2,
        mentionRate: 0.6667,
        wilson: computeWilsonInterval(2, 3),
        controlMentionRate: Number.NaN,
        did: null,
      },
    ];
    const singlePointHtml = renderRoiReportHtml(makeInput({ summary: edgeSummary }));
    expect(singlePointHtml).not.toContain('NaN');
    expect(singlePointHtml).not.toContain('Infinity');
    expect(singlePointHtml).toContain('T+7');
  });

  it('renders DiD netLift beyond +-100pp (up to +-200pp), UTC period dates, zero-CJK EN manual channels, zh-CN provider labels, prototype-safe lookups, and zero L3 bar when l3=0 (#369 iter2)', () => {
    // Defect 6: +1.2 -> +120.0pp and -1.35 -> -135.0pp
    const posSummary = buildRichSummary();
    posSummary.overview.did = {
      treatmentDelta: 0.8,
      controlDelta: -0.4,
      netLift: 1.2,
      direction: 'POSITIVE',
    };
    const posHtml = renderRoiReportHtml(
      makeInput({
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-10-31T23:59:59.999Z',
        summary: posSummary,
      }),
    );
    expect(posHtml).toContain('+120.0pp');
    // Defect 8: UTC periodEnd 2026-10-31T23:59:59.999Z must display as 2026-10-31 (NOT 2026-11-01)
    expect(posHtml).toContain('2026-10-01 ~ 2026-10-31');

    const negSummary = buildRichSummary();
    negSummary.overview.did = {
      treatmentDelta: -0.75,
      controlDelta: 0.6,
      netLift: -1.35,
      direction: 'NEGATIVE',
    };
    const negHtml = renderRoiReportHtml(makeInput({ summary: negSummary }));
    expect(negHtml).toContain('-135.0pp');

    // Defect 7: EN with provider=null CN manual channels -> 0 CJK; zh-CN with SHOPIFY -> Shopify 博客
    const channelSummary = buildRichSummary();
    channelSummary.channelRanking = [
      {
        channel: '微信公众号草稿箱',
        provider: null,
        mode: 'L3_COMMUNITY_ASSIST',
        publishedCount: 2,
        completedRetestCount: 1,
        citationHitCount: 1,
        citationHitRate: 1,
        citationHitWilson: computeWilsonInterval(1, 1),
        avgMentionRateDelta: 0.1,
      },
      {
        channel: '知乎',
        provider: null,
        mode: 'L3_COMMUNITY_ASSIST',
        publishedCount: 1,
        completedRetestCount: 0,
        citationHitCount: 0,
        citationHitRate: null,
        citationHitWilson: null,
        avgMentionRateDelta: null,
      },
      {
        channel: '自定义中文外链',
        provider: null,
        mode: 'L3_COMMUNITY_ASSIST',
        publishedCount: 1,
        completedRetestCount: 0,
        citationHitCount: 0,
        citationHitRate: null,
        citationHitWilson: null,
        avgMentionRateDelta: null,
      },
      {
        channel: 'Shopify Blog',
        provider: 'SHOPIFY',
        mode: 'L1_API',
        publishedCount: 3,
        completedRetestCount: 2,
        citationHitCount: 1,
        citationHitRate: 0.5,
        citationHitWilson: computeWilsonInterval(1, 2),
        avgMentionRateDelta: 0.2,
      },
    ];

    const enManualHtml = renderRoiReportHtml(
      makeInput({ locale: 'en-US', market: 'GLOBAL', summary: channelSummary }),
    );
    expect(enManualHtml).toContain('WeChat Official Drafts');
    expect(enManualHtml).toContain('Zhihu');
    expect(enManualHtml).toContain('External Channel');
    expect(enManualHtml).not.toMatch(/[\u4E00-\u9FFF]/);

    const zhProviderHtml = renderRoiReportHtml(
      makeInput({
        locale: 'zh-CN',
        market: 'CN',
        title: '中文渠道报告',
        brandName: '星辰存储',
        category: '家用存储',
        summary: channelSummary,
      }),
    );
    expect(zhProviderHtml).toContain('Shopify 博客');

    // Defect 9a: Prototype keys ('constructor', 'toString', '__proto__') must NEVER leak [native code]
    const protoSummary = buildRichSummary();
    protoSummary.byEngine = [
      { ...protoSummary.byEngine[0]!, engine: 'constructor' },
      { ...protoSummary.byEngine[1]!, engine: 'toString' },
    ];
    protoSummary.overview.confidenceLevel = 'toString' as never;
    protoSummary.overview.did = {
      treatmentDelta: 0.1,
      controlDelta: 0,
      netLift: 0.1,
      direction: 'constructor' as never,
    };
    protoSummary.channelRanking = [
      {
        ...protoSummary.channelRanking[0]!,
        mode: '__proto__' as never,
      },
    ];
    const protoEnHtml = renderRoiReportHtml(makeInput({ summary: protoSummary }));
    const protoZhHtml = renderRoiReportHtml(
      makeInput({
        locale: 'zh-CN',
        market: 'CN',
        title: '原型键测试',
        brandName: '星辰',
        category: '测试',
        summary: protoSummary,
      }),
    );
    expect(protoEnHtml).not.toContain('[native code]');
    expect(protoEnHtml).not.toContain('function Object');
    expect(protoZhHtml).not.toContain('[native code]');
    expect(protoZhHtml).not.toContain('function Object');

    // Defect 9c: SVG funnel must NOT draw orange L3 bar when l3Count === 0 (even when publishedTotal > 0)
    const zeroTiersSummary = buildRichSummary();
    zeroTiersSummary.funnel = {
      publishedTotal: 5,
      l1Count: 0,
      l2Count: 0,
      l3Count: 0,
      crawlCheckedCount: 0,
      crawlOkCount: 0,
      crawlOkRate: null,
      indexNowAttemptedCount: 0,
      indexNowSuccessCount: 0,
      indexNowRate: null,
    };
    const zeroTiersHtml = renderRoiReportHtml(makeInput({ summary: zeroTiersSummary }));
    expect(zeroTiersHtml).not.toContain('fill="#d97706"');
  });

  it('guards channelRanking against Object.prototype keys paired with a valid provider in both en-US and zh-CN HTML exports (#369 iter3)', () => {
    const protoChannelSummary = buildRichSummary();
    protoChannelSummary.channelRanking = (
      ['constructor', 'toString', '__proto__', 'valueOf'] as const
    ).map((channel) => ({
      channel,
      provider: 'SHOPIFY' as const,
      mode: 'L1_API' as const,
      publishedCount: 1,
      completedRetestCount: 1,
      citationHitCount: 1,
      citationHitRate: 1,
      citationHitWilson: computeWilsonInterval(1, 1),
      avgMentionRateDelta: 0.1,
    }));

    const enHtml = renderRoiReportHtml(
      makeInput({ locale: 'en-US', market: 'GLOBAL', summary: protoChannelSummary }),
    );
    const zhHtml = renderRoiReportHtml(
      makeInput({
        locale: 'zh-CN',
        market: 'CN',
        title: '原型键渠道报告',
        brandName: '星辰存储',
        category: '家用存储',
        summary: protoChannelSummary,
      }),
    );

    for (const html of [enHtml, zhHtml]) {
      expect(html).not.toContain('[native code]');
      expect(html).not.toContain('[object Object]');
      expect(html).not.toContain('function Object');
      expect(html).not.toContain('function toString');
      expect(html).not.toContain('function valueOf');
    }

    expect(enHtml).toContain('<td><strong>constructor</strong></td>');
    expect(enHtml).toContain('<td><strong>toString</strong></td>');
    expect(enHtml).toContain('<td><strong>__proto__</strong></td>');
    expect(enHtml).toContain('<td><strong>valueOf</strong></td>');
    expect(enHtml).not.toMatch(/[\u4E00-\u9FFF]/);

    expect(zhHtml).toContain('<td><strong>Shopify 博客</strong></td>');
  });

  it('renders localized Chinese and English fallback labels for retired CN engines (wenxin/kimi/zhipu/nami) in historical reports (#411)', () => {
    const legacySummary = buildRichSummary();
    legacySummary.byEngine = [
      {
        engine: 'deepseek',
        observations: 10,
        mentionRate: 0.7,
        citationRate: 0.5,
        ownedCitationRate: 0.3,
        avgPosition: 1.5,
        mentionWilson: computeWilsonInterval(7, 10),
      },
      {
        engine: 'wenxin',
        observations: 8,
        mentionRate: 0.5,
        citationRate: 0.25,
        ownedCitationRate: 0.125,
        avgPosition: 2.2,
        mentionWilson: computeWilsonInterval(4, 8),
      },
      {
        engine: 'kimi',
        observations: 6,
        mentionRate: 0.5,
        citationRate: 0.33,
        ownedCitationRate: 0.16,
        avgPosition: 2.0,
        mentionWilson: computeWilsonInterval(3, 6),
      },
      {
        engine: 'zhipu',
        observations: 4,
        mentionRate: 0.25,
        citationRate: 0.25,
        ownedCitationRate: 0,
        avgPosition: 3.0,
        mentionWilson: computeWilsonInterval(1, 4),
      },
      {
        engine: 'nami',
        observations: 4,
        mentionRate: 0.25,
        citationRate: 0,
        ownedCitationRate: 0,
        avgPosition: 3.5,
        mentionWilson: computeWilsonInterval(1, 4),
      },
    ];

    const zhHtml = renderRoiReportHtml(
      makeInput({
        locale: 'zh-CN',
        market: 'CN',
        title: '历史引擎兼容报告',
        brandName: '星辰存储',
        category: '家用 NAS',
        summary: legacySummary,
      }),
    );
    expect(zhHtml).toContain('DeepSeek');
    expect(zhHtml).toContain('文心一言');
    expect(zhHtml).toContain('Kimi');
    expect(zhHtml).toContain('智谱');
    expect(zhHtml).toContain('纳米');

    const enHtml = renderRoiReportHtml(
      makeInput({
        locale: 'en-US',
        market: 'GLOBAL',
        summary: legacySummary,
      }),
    );
    expect(enHtml).toContain('ERNIE Bot');
    expect(enHtml).toContain('Zhipu GLM');
    expect(enHtml).toContain('Nami AI');
    expect(enHtml).not.toMatch(/[\u4E00-\u9FFF]/);
  });
});
