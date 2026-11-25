import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROI_REPORT_SHARE_TTL_DAYS,
  NEAR_MISS_TIERS,
  NEAR_MISS_TIER_EN_LABELS,
  NEAR_MISS_TIER_LABELS,
  createGeoRoiReportSchema,
  createGeoRoiReportShareSchema,
  createNearMissBoostBriefSchema,
  nearMissQuerySchema,
  roiReportDateInputSchema,
  sanitizeSummaryForPublicReport,
  type GeoRoiReportSummaryDto,
} from './roi-report';
import { computeDifferenceInDifferences, computeWilsonInterval } from './stats';

describe('roi-report.ts — Near-Miss tiers, ROI report schemas & public sanitization', () => {
  it('defines all 4 Near-Miss tiers with CN/EN labels and validates query & boost schemas', () => {
    expect(NEAR_MISS_TIERS).toEqual([
      'OPENED_NOT_CITED',
      'RETRIEVED_NOT_CITED',
      'CRAWLED_NOT_CITED',
      'MENTIONED_NOT_OWNED',
    ]);
    for (const tier of NEAR_MISS_TIERS) {
      expect(NEAR_MISS_TIER_LABELS[tier].length).toBeGreaterThan(3);
      expect(NEAR_MISS_TIER_EN_LABELS[tier].length).toBeGreaterThan(3);
    }

    expect(nearMissQuerySchema.parse({})).toEqual({ days: 30, limit: 50 });
    expect(
      nearMissQuerySchema.parse({
        market: 'GLOBAL',
        days: '14',
        tier: 'OPENED_NOT_CITED',
        sourceKind: 'OWNED',
        limit: '25',
      }),
    ).toEqual({
      market: 'GLOBAL',
      days: 14,
      tier: 'OPENED_NOT_CITED',
      sourceKind: 'OWNED',
      limit: 25,
    });
    expect(nearMissQuerySchema.safeParse({ days: '0' }).success).toBe(false);
    expect(nearMissQuerySchema.safeParse({ days: '91' }).success).toBe(false);

    expect(
      createNearMissBoostBriefSchema.safeParse({
        market: 'GLOBAL',
        tier: 'OPENED_NOT_CITED',
        targetPrompt: 'Best quiet 4-bay NAS 2026',
        sourceUrl: 'https://brand.example.com/nas-guide',
      }).success,
    ).toBe(true);
    expect(
      createNearMissBoostBriefSchema.safeParse({
        tier: 'OPENED_NOT_CITED',
        targetPrompt: 'Best quiet 4-bay NAS 2026',
        sourceUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
  });

  it('validates createGeoRoiReportSchema date order, whiteLabelOrg blank normalization, and share TTL', () => {
    const parsed = createGeoRoiReportSchema.parse({
      market: 'GLOBAL',
      title: 'October 2026 GEO Growth Review',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      locale: 'en-US',
      whiteLabelOrg: '  Acme Growth Agency  ',
    });
    expect(parsed.whiteLabelOrg).toBe('Acme Growth Agency');

    const blankWhiteLabel = createGeoRoiReportSchema.parse({
      periodStart: '2026-10-01T00:00:00Z',
      periodEnd: '2026-10-31T23:59:59Z',
      whiteLabelOrg: '   ',
    });
    expect(blankWhiteLabel.whiteLabelOrg).toBeNull();

    // Rejects inverted periodStart > periodEnd
    expect(
      createGeoRoiReportSchema.safeParse({
        periodStart: '2026-11-01',
        periodEnd: '2026-10-01',
      }).success,
    ).toBe(false);

    expect(createGeoRoiReportShareSchema.parse(undefined)).toEqual({
      ttlDays: DEFAULT_ROI_REPORT_SHARE_TTL_DAYS,
    });
    expect(createGeoRoiReportShareSchema.safeParse({ ttlDays: 91 }).success).toBe(false);
  });

  it('strips pointsRoi and internal fields when sanitizing summary for public white-label share', () => {
    const wilson = computeWilsonInterval(12, 20);
    const did = computeDifferenceInDifferences({
      treatmentBaseline: 0.25,
      treatmentCurrent: 0.6,
      controlBaseline: 0.25,
      controlCurrent: 0.3,
    });

    const summary: GeoRoiReportSummaryDto & { internalSecret?: string } = {
      version: 1,
      overview: {
        totalObservations: 20,
        mentionHits: 12,
        mentionRate: 0.6,
        mentionWilson: wilson,
        citationHits: 8,
        citationRate: 0.4,
        ownedCitationHits: 5,
        ownedCitationRate: 0.25,
        confidenceLevel: wilson.confidenceLevel,
        did,
      },
      byEngine: [
        {
          engine: 'perplexity',
          observations: 20,
          mentionRate: 0.6,
          citationRate: 0.4,
          ownedCitationRate: 0.25,
          avgPosition: 1.8,
          mentionWilson: wilson,
        },
      ],
      nearMiss: {
        totalOpportunities: 14,
        boostBriefsCreated: 3,
        convertedToCited: 2,
        tierCounts: {
          OPENED_NOT_CITED: 4,
          RETRIEVED_NOT_CITED: 5,
          CRAWLED_NOT_CITED: 2,
          MENTIONED_NOT_OWNED: 3,
        },
      },
      funnel: {
        publishedTotal: 10,
        l1Count: 6,
        l2Count: 2,
        l3Count: 2,
        crawlCheckedCount: 9,
        crawlOkCount: 8,
        crawlOkRate: 0.8889,
        indexNowAttemptedCount: 6,
        indexNowSuccessCount: 5,
        indexNowRate: 0.8333,
      },
      channelRanking: [
        {
          channel: 'Ghost Blog',
          provider: 'GHOST',
          mode: 'L1_API',
          publishedCount: 4,
          completedRetestCount: 3,
          citationHitCount: 2,
          citationHitRate: 0.6667,
          citationHitWilson: computeWilsonInterval(2, 3),
          avgMentionRateDelta: 0.25,
        },
      ],
      milestoneTrend: [
        {
          milestoneDay: 7,
          trials: 20,
          hits: 12,
          mentionRate: 0.6,
          wilson,
          controlMentionRate: 0.3,
          did,
        },
      ],
      pointsRoi: {
        totalPointsSpent: 120,
        articlesPublished: 10,
        citationHitsGained: 5,
        pointsPerPublishedArticle: 12,
        pointsPerCitationHit: 24,
      },
      internalSecret: 'should-not-leak',
    };

    const sanitized = sanitizeSummaryForPublicReport(summary);
    expect('pointsRoi' in sanitized).toBe(false);
    expect('internalSecret' in (sanitized as Record<string, unknown>)).toBe(false);
    expect(sanitized.overview.did?.netLift).toBe(0.3);
    expect(sanitized.channelRanking[0]?.provider).toBe('GHOST');
  });

  it('rejects impossible calendar dates on exact field paths while accepting valid leap days', () => {
    const invalidDates = [
      '2026-99-99',
      '2026-02-31',
      '2026-02-29',
      '2026-04-31',
      '2026-02-31T00:00:00Z',
    ];

    for (const badDate of invalidDates) {
      expect(roiReportDateInputSchema.safeParse(badDate).success, badDate).toBe(false);

      const badStart = createGeoRoiReportSchema.safeParse({
        periodStart: badDate,
        periodEnd: '2026-12-31',
      });
      expect(badStart.success, `periodStart=${badDate}`).toBe(false);
      if (!badStart.success) {
        expect(badStart.error.issues[0]?.path).toEqual(['periodStart']);
      }

      const badEnd = createGeoRoiReportSchema.safeParse({
        periodStart: '2026-01-01',
        periodEnd: badDate,
      });
      expect(badEnd.success, `periodEnd=${badDate}`).toBe(false);
      if (!badEnd.success) {
        expect(badEnd.error.issues[0]?.path).toEqual(['periodEnd']);
      }
    }

    // Valid leap days pass both standalone and full create schema
    expect(roiReportDateInputSchema.safeParse('2028-02-29').success).toBe(true);
    expect(roiReportDateInputSchema.safeParse('2028-02-29T12:00:00Z').success).toBe(true);
    expect(
      createGeoRoiReportSchema.safeParse({
        periodStart: '2028-02-29',
        periodEnd: '2028-02-29T12:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('deeply strips polluted unwhitelisted keys across all nested summary objects', () => {
    const pollutedWilson = {
      ...computeWilsonInterval(10, 20),
      tenantId: 'ten_wilson',
      secret: 'sec_wilson',
    };
    const pollutedDid = {
      ...computeDifferenceInDifferences({
        treatmentBaseline: 0.2,
        treatmentCurrent: 0.5,
        controlBaseline: 0.2,
        controlCurrent: 0.25,
      }),
      userId: 'usr_did',
      secret: 'sec_did',
    };
    const pollutedSummary = {
      version: 1 as const,
      overview: {
        totalObservations: 20,
        mentionHits: 10,
        mentionRate: 0.5,
        mentionWilson: pollutedWilson,
        citationHits: 5,
        citationRate: 0.25,
        ownedCitationHits: 3,
        ownedCitationRate: 0.15,
        confidenceLevel: 'MEDIUM' as const,
        did: pollutedDid,
        tenantId: 'ten_overview',
      },
      byEngine: [
        {
          engine: 'chatgpt',
          observations: 20,
          mentionRate: 0.5,
          citationRate: 0.25,
          ownedCitationRate: 0.15,
          avgPosition: 2,
          mentionWilson: pollutedWilson,
          secret: 'sec_engine',
        },
      ],
      nearMiss: {
        totalOpportunities: 1,
        boostBriefsCreated: 0,
        convertedToCited: 0,
        tierCounts: {
          OPENED_NOT_CITED: 1,
          RETRIEVED_NOT_CITED: 0,
          CRAWLED_NOT_CITED: 0,
          MENTIONED_NOT_OWNED: 0,
          extraTierLeak: 99,
        },
      },
      funnel: {
        publishedTotal: 1,
        l1Count: 1,
        l2Count: 0,
        l3Count: 0,
        crawlCheckedCount: 1,
        crawlOkCount: 1,
        crawlOkRate: 1,
        indexNowAttemptedCount: 1,
        indexNowSuccessCount: 1,
        indexNowRate: 1,
        tenantId: 'ten_funnel',
        walletBalance: 8888,
        secret: 'sec_funnel',
      },
      channelRanking: [
        {
          channel: 'Ghost',
          publishedCount: 1,
          completedRetestCount: 1,
          citationHitCount: 1,
          citationHitRate: 1,
          citationHitWilson: pollutedWilson,
          avgMentionRateDelta: 0.1,
          userId: 'usr_channel',
        },
      ],
      milestoneTrend: [
        {
          milestoneDay: 7,
          trials: 10,
          hits: 5,
          mentionRate: 0.5,
          wilson: pollutedWilson,
          did: pollutedDid,
          walletBalance: 7777,
        },
      ],
    } as unknown as GeoRoiReportSummaryDto;

    const sanitized = sanitizeSummaryForPublicReport(pollutedSummary);
    const serialized = JSON.stringify(sanitized);
    for (const forbidden of [
      'tenantId',
      'userId',
      'walletBalance',
      'secret',
      'ten_wilson',
      'sec_wilson',
      'usr_did',
      'ten_funnel',
      'sec_funnel',
      'extraTierLeak',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(sanitized.overview.mentionWilson).toEqual(computeWilsonInterval(10, 20));
    expect(sanitized.funnel.publishedTotal).toBe(1);
    expect(sanitized.milestoneTrend[0]?.did?.netLift).toBe(0.25);
  });
});
