import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_ERROR,
  AUTH_ERROR,
  computeDifferenceInDifferences,
  computeWilsonInterval,
  geoRoiReportOverviewSchema,
  parseEnv,
} from '@geomix/shared';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import {
  buildGeoRoiReportSummary,
  buildSafeRoiReportExportFilename,
  formatUtcDate,
  normalizePercentToRate01,
} from './roi-report-aggregator';
import { RoiReportPublicService } from './roi-report-public.service';

type StoredReportRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  title: string;
  periodStart: Date;
  periodEnd: Date;
  locale: string;
  whiteLabelOrg: string | null;
  summaryJson: Prisma.JsonValue;
  shareTokenHash: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

describe('buildGeoRoiReportSummary pure aggregation (#369)', () => {
  it('normalizes 0..100 percentage rates deterministically and computes all 7 summary sections with SHADOW & STRICT point attribution', () => {
    expect(normalizePercentToRate01(66.7)).toBe(0.667);
    expect(normalizePercentToRate01(1)).toBe(0.01);
    expect(normalizePercentToRate01(0.5)).toBe(0.005);
    expect(normalizePercentToRate01(0)).toBe(0);
    expect(normalizePercentToRate01(100)).toBe(1);

    const summary = buildGeoRoiReportSummary({
      brandMarket: {
        localBrandName: 'AstraVault',
        aliases: ['AstraVault Pro'],
        ownedDomains: ['astravault.example'],
        competitors: [{ name: 'Synology', domains: ['synology.com'] }],
      },
      observations: [
        {
          id: 'obs_1',
          runId: 'run_1',
          engine: 'chatgpt',
          promptText: 'Best silent 4-bay NAS',
          status: 'SUCCESS',
          answerText: 'AstraVault is the quietest 4-bay NAS.',
          brandMentioned: true,
          brandPosition: 1,
          checkedAt: new Date('2026-10-10T10:00:00Z'),
          createdAt: new Date('2026-10-10T10:00:00Z'),
          citations: [
            {
              url: 'https://astravault.example/blog/silent-nas',
              domain: 'astravault.example',
              sourceKind: 'OWNED',
              position: 1,
            },
          ],
        },
        {
          id: 'obs_2',
          runId: 'run_1',
          engine: 'perplexity',
          promptText: 'Quiet NAS for home office',
          status: 'SUCCESS',
          answerText: 'AstraVault and Synology are both options.',
          brandMentioned: true,
          brandPosition: 2,
          checkedAt: new Date('2026-10-12T10:00:00Z'),
          createdAt: new Date('2026-10-12T10:00:00Z'),
          citations: [
            {
              url: 'https://synology.com/nas',
              domain: 'synology.com',
              sourceKind: 'COMPETITOR',
              position: 1,
            },
          ],
        },
        {
          id: 'obs_3',
          runId: 'run_1',
          engine: 'chatgpt',
          promptText: 'Best silent 4-bay NAS',
          status: 'SUCCESS',
          answerText: 'Synology DS423+ is popular.',
          brandMentioned: false,
          brandPosition: null,
          checkedAt: new Date('2026-10-15T10:00:00Z'),
          createdAt: new Date('2026-10-15T10:00:00Z'),
          citations: [],
        },
      ],
      uncitedRetrievedSources: [
        {
          id: 'rs_1',
          observationId: 'obs_2',
          url: 'https://astravault.example/guide?utm_source=ai',
          wasOpened: true,
          wasCited: false,
          observation: { status: 'SUCCESS' },
        },
        {
          id: 'rs_2',
          observationId: 'obs_2',
          url: 'https://astravault.example/specs',
          wasOpened: false,
          wasCited: false,
          observation: { status: 'SUCCESS' },
        },
      ],
      nearMissBoostBriefs: [
        {
          id: 'brief_boost_1',
          sourceCitationUrl: 'https://astravault.example/blog/silent-nas',
          targetPrompt: 'Best silent 4-bay NAS',
          createdAt: new Date('2026-10-05T00:00:00Z'),
          articles: [],
        },
        {
          id: 'brief_boost_2',
          sourceCitationUrl: 'https://astravault.example/unconverted',
          targetPrompt: 'Unconverted prompt',
          createdAt: new Date('2026-10-20T00:00:00Z'),
          articles: [],
        },
      ],
      periodPublishRecords: [
        {
          id: 'pub_l1',
          articleId: 'art_1',
          channel: 'Shopify Blog',
          publishedUrl: 'https://shop.astravault.example/blogs/news/silent-nas',
          publishedAt: new Date('2026-10-02T00:00:00Z'),
          crawlStatus: 'OK',
          crawlCheckedAt: new Date('2026-10-03T00:00:00Z'),
          indexNowSubmitted: true,
          beforeMetrics: {
            mentionRate: 20,
            avgPosition: 3,
            sentiment: 'neutral',
            citationHit: false,
          },
          afterMetrics: {
            mentionRate: 70,
            avgPosition: 1,
            sentiment: 'positive',
            citationHit: true,
          },
          distributionTask: {
            id: 'task_1',
            provider: 'SHOPIFY',
            mode: 'L1_API',
            indexNowStatus: 'SUBMITTED',
          },
          retestSchedules: [],
        },
        {
          id: 'pub_l2',
          articleId: 'art_2',
          channel: 'Zhihu',
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456',
          publishedAt: new Date('2026-10-03T00:00:00Z'),
          crawlStatus: 'OK',
          crawlCheckedAt: new Date('2026-10-04T00:00:00Z'),
          indexNowSubmitted: false,
          beforeMetrics: {
            mentionRate: 20,
            avgPosition: 4,
            sentiment: 'neutral',
            citationHit: false,
          },
          afterMetrics: null,
          distributionTask: {
            id: 'task_2',
            provider: 'ZHIHU_EXT',
            mode: 'L2_EXTENSION',
            indexNowStatus: 'FAILED',
          },
          retestSchedules: [],
        },
        {
          id: 'pub_l3',
          articleId: 'art_3',
          channel: 'Reddit',
          publishedUrl: 'https://reddit.com/r/homelab/comments/abc',
          publishedAt: new Date('2026-10-04T00:00:00Z'),
          crawlStatus: 'BLOCKED',
          crawlCheckedAt: new Date('2026-10-05T00:00:00Z'),
          indexNowSubmitted: false,
          beforeMetrics: null,
          afterMetrics: null,
          distributionTask: {
            id: 'task_3',
            provider: 'REDDIT',
            mode: 'L3_COMMUNITY_ASSIST',
            indexNowStatus: null,
          },
          retestSchedules: [],
        },
      ],
      periodCompletedSchedules: [
        {
          id: 'sched_t7_l1',
          publishRecordId: 'pub_l1',
          milestoneDay: 7,
          status: 'COMPLETED',
          executedAt: new Date('2026-10-09T00:00:00Z'),
          metricsSnapshotJson: {
            mentionRate: 70,
            avgPosition: 1,
            sentiment: 'positive',
            citationHit: true,
            sampleCount: 10,
            hitCount: 7,
            wilson: computeWilsonInterval(7, 10),
            confidenceLevel: 'MEDIUM',
          },
          controlMetricsJson: {
            controlPrompts: ['Control prompt 1'],
            baselineMentionRate: 20,
            currentMentionRate: 25,
            sampleCount: 4,
            hitCount: 1,
            wilson: computeWilsonInterval(1, 4),
            did: computeDifferenceInDifferences({
              treatmentBaseline: 0.2,
              treatmentCurrent: 0.7,
              controlBaseline: 0.2,
              controlCurrent: 0.25,
            }),
          },
          publishRecord: {
            id: 'pub_l1',
            channel: 'Shopify Blog',
            publishedUrl: 'https://shop.astravault.example/blogs/news/silent-nas',
            crawlStatus: 'OK',
            beforeMetrics: {
              mentionRate: 20,
              avgPosition: 3,
              sentiment: 'neutral',
              citationHit: false,
            },
            afterMetrics: {
              mentionRate: 70,
              avgPosition: 1,
              sentiment: 'positive',
              citationHit: true,
            },
            distributionTask: { provider: 'SHOPIFY', mode: 'L1_API' },
          },
        },
        {
          id: 'sched_t7_l2',
          publishRecordId: 'pub_l2',
          milestoneDay: 7,
          status: 'COMPLETED',
          executedAt: new Date('2026-10-10T00:00:00Z'),
          metricsSnapshotJson: {
            mentionRate: 50,
            avgPosition: 2,
            sentiment: 'neutral',
            citationHit: false,
            sampleCount: 2,
            hitCount: 1,
            wilson: computeWilsonInterval(1, 2),
            confidenceLevel: 'LOW',
          },
          controlMetricsJson: null,
          publishRecord: {
            id: 'pub_l2',
            channel: 'Zhihu',
            publishedUrl: 'https://zhuanlan.zhihu.com/p/123456',
            crawlStatus: 'OK',
            beforeMetrics: {
              mentionRate: 20,
              avgPosition: 4,
              sentiment: 'neutral',
              citationHit: false,
            },
            afterMetrics: null,
            distributionTask: { provider: 'ZHIHU_EXT', mode: 'L2_EXTENSION' },
          },
        },
      ],
      pointLogs: [
        { action: 'visibility_check', delta: -40, listPrice: 40, reservationId: 'res_bm1' },
        { action: 'geo_write', delta: 0, listPrice: 60, unitKey: 'geo_article:art_1' },
        {
          action: 'geo_write',
          delta: -999,
          listPrice: 999,
          detail: { brandId: 'brand_other', brandMarketId: 'bm_other' },
        },
      ],
      attributionScope: {
        brandId: 'brand_1',
        brandMarketId: 'bm_1',
        reservationIds: new Set(['res_bm1']),
        articleIds: new Set(['art_1', 'art_2', 'art_3']),
      },
    });

    expect(geoRoiReportOverviewSchema.safeParse(summary.overview).success).toBe(true);
    expect(summary.overview.totalObservations).toBe(3);
    expect(summary.overview.mentionHits).toBe(2);
    expect(summary.overview.citationHits).toBe(2);
    expect(summary.overview.ownedCitationHits).toBe(1);
    expect(summary.overview.did).toEqual({
      treatmentDelta: 0.5,
      controlDelta: 0.05,
      netLift: 0.45,
      direction: 'POSITIVE',
    });

    expect(summary.byEngine).toHaveLength(2);
    expect(summary.byEngine[0]?.engine).toBe('chatgpt');
    expect(summary.byEngine[0]?.observations).toBe(2);

    expect(summary.nearMiss).toEqual({
      totalOpportunities: 4,
      boostBriefsCreated: 2,
      convertedToCited: 1,
      tierCounts: {
        OPENED_NOT_CITED: 1,
        RETRIEVED_NOT_CITED: 1,
        CRAWLED_NOT_CITED: 1,
        MENTIONED_NOT_OWNED: 1,
      },
    });

    expect(summary.funnel).toEqual({
      publishedTotal: 3,
      l1Count: 1,
      l2Count: 1,
      l3Count: 1,
      crawlCheckedCount: 3,
      crawlOkCount: 2,
      crawlOkRate: 0.6667,
      indexNowAttemptedCount: 2,
      indexNowSuccessCount: 1,
      indexNowRate: 0.5,
    });

    expect(summary.channelRanking[0]).toMatchObject({
      channel: 'Shopify Blog',
      provider: 'SHOPIFY',
      mode: 'L1_API',
      publishedCount: 1,
      completedRetestCount: 1,
      citationHitCount: 1,
      citationHitRate: 1,
      citationHitWilson: computeWilsonInterval(1, 1),
      avgMentionRateDelta: 0.5,
    });

    expect(summary.milestoneTrend.map((m) => m.milestoneDay)).toEqual([0, 7]);
    expect(summary.milestoneTrend[1]?.controlMentionRate).toBe(0.25);
    expect(summary.milestoneTrend[1]?.did?.netLift).toBe(0.45);

    expect(summary.pointsRoi).toEqual({
      totalPointsSpent: 100,
      articlesPublished: 3,
      citationHitsGained: 1,
      pointsPerPublishedArticle: 33.33,
      pointsPerCitationHit: 100,
    });
  });

  it('keeps flat 1%->1% and small 0.5%->1.0% DiD / channel deltas deterministic without 100x inflation and excludes SKIPPED IndexNow statuses (#369 iter2)', () => {
    const flatSummary = buildGeoRoiReportSummary({
      brandMarket: {
        localBrandName: 'AstraVault',
        aliases: [],
        ownedDomains: ['astravault.example'],
        competitors: [],
      },
      observations: [],
      uncitedRetrievedSources: [],
      nearMissBoostBriefs: [],
      periodPublishRecords: [
        {
          id: 'pub_flat_1pct',
          articleId: 'art_flat',
          channel: 'Shopify Blog',
          publishedUrl: 'https://astravault.example/flat',
          publishedAt: new Date('2026-10-02T00:00:00Z'),
          crawlStatus: 'OK',
          crawlCheckedAt: new Date('2026-10-03T00:00:00Z'),
          indexNowSubmitted: false,
          beforeMetrics: {
            mentionRate: 1,
            avgPosition: 3,
            sentiment: 'neutral',
            citationHit: false,
          },
          afterMetrics: {
            mentionRate: 1,
            avgPosition: 3,
            sentiment: 'neutral',
            citationHit: false,
          },
          distributionTask: {
            id: 'task_flat',
            provider: 'SHOPIFY',
            mode: 'L1_API',
            indexNowStatus: 'SKIPPED',
          },
          retestSchedules: [],
        },
        {
          id: 'pub_skipped_reason',
          articleId: 'art_skip',
          channel: 'WordPress Site',
          publishedUrl: 'https://astravault.example/skip',
          publishedAt: new Date('2026-10-03T00:00:00Z'),
          crawlStatus: 'PENDING',
          crawlCheckedAt: null,
          indexNowSubmitted: false,
          beforeMetrics: null,
          afterMetrics: null,
          distributionTask: {
            id: 'task_skip',
            provider: 'WORDPRESS',
            mode: 'L1_API',
            indexNowStatus: ' skipped:no_indexnow_key ',
          },
          retestSchedules: [],
        },
      ],
      periodCompletedSchedules: [
        {
          id: 'sched_flat_t7',
          publishRecordId: 'pub_flat_1pct',
          milestoneDay: 7,
          status: 'COMPLETED',
          executedAt: new Date('2026-10-09T00:00:00Z'),
          metricsSnapshotJson: {
            mentionRate: 1,
            avgPosition: 3,
            sentiment: 'neutral',
            citationHit: false,
            sampleCount: 100,
            hitCount: 1,
            wilson: computeWilsonInterval(1, 100),
            confidenceLevel: 'HIGH',
          },
          controlMetricsJson: {
            controlPrompts: ['Control query 1'],
            baselineMentionRate: 1,
            currentMentionRate: 1,
            sampleCount: 100,
            hitCount: 1,
            wilson: computeWilsonInterval(1, 100),
            did: computeDifferenceInDifferences({
              treatmentBaseline: 0.01,
              treatmentCurrent: 0.01,
              controlBaseline: 0.01,
              controlCurrent: 0.01,
            }),
          },
          publishRecord: {
            id: 'pub_flat_1pct',
            channel: 'Shopify Blog',
            publishedUrl: 'https://astravault.example/flat',
            crawlStatus: 'OK',
            beforeMetrics: {
              mentionRate: 1,
              avgPosition: 3,
              sentiment: 'neutral',
              citationHit: false,
            },
            afterMetrics: {
              mentionRate: 1,
              avgPosition: 3,
              sentiment: 'neutral',
              citationHit: false,
            },
            distributionTask: { provider: 'SHOPIFY', mode: 'L1_API' },
          },
        },
      ],
      pointLogs: [],
    });

    // Defect 1: Flat 1% -> 1% must NEVER inflate to 100% or fabricate +0.99 POSITIVE DiD
    expect(flatSummary.milestoneTrend[0]?.milestoneDay).toBe(0);
    expect(flatSummary.milestoneTrend[0]?.mentionRate).toBe(0.01);
    expect(flatSummary.milestoneTrend[0]?.controlMentionRate).toBe(0.01);
    expect(flatSummary.milestoneTrend[1]?.milestoneDay).toBe(7);
    expect(flatSummary.milestoneTrend[1]?.mentionRate).toBe(0.01);
    expect(flatSummary.milestoneTrend[1]?.controlMentionRate).toBe(0.01);
    expect(flatSummary.overview.did).toEqual({
      treatmentDelta: 0,
      controlDelta: 0,
      netLift: 0,
      direction: 'NEUTRAL',
    });
    expect(flatSummary.milestoneTrend[1]?.did).toEqual({
      treatmentDelta: 0,
      controlDelta: 0,
      netLift: 0,
      direction: 'NEUTRAL',
    });
    expect(
      flatSummary.channelRanking.find((c) => c.channel === 'Shopify Blog')?.avgMentionRateDelta,
    ).toBe(0);

    // Defect 2: SKIPPED and SKIPPED:* must NOT count as IndexNow attempts -> indexNowRate === null
    expect(flatSummary.funnel.indexNowAttemptedCount).toBe(0);
    expect(flatSummary.funnel.indexNowSuccessCount).toBe(0);
    expect(flatSummary.funnel.indexNowRate).toBeNull();

    // Small-percentage 0.5% -> 1.0% treatment with flat 0.5% -> 0.5% control
    const smallSummary = buildGeoRoiReportSummary({
      brandMarket: {
        localBrandName: 'AstraVault',
        aliases: [],
        ownedDomains: ['astravault.example'],
        competitors: [],
      },
      observations: [],
      uncitedRetrievedSources: [],
      nearMissBoostBriefs: [],
      periodPublishRecords: [
        {
          id: 'pub_small',
          articleId: 'art_small',
          channel: 'Ghost Blog',
          publishedUrl: 'https://astravault.example/small',
          publishedAt: new Date('2026-10-02T00:00:00Z'),
          crawlStatus: 'OK',
          crawlCheckedAt: new Date('2026-10-03T00:00:00Z'),
          indexNowSubmitted: false,
          beforeMetrics: {
            mentionRate: 0.5,
            avgPosition: 4,
            sentiment: 'neutral',
            citationHit: false,
          },
          afterMetrics: {
            mentionRate: 1,
            avgPosition: 2,
            sentiment: 'positive',
            citationHit: true,
          },
          distributionTask: {
            id: 'task_small',
            provider: 'GHOST',
            mode: 'L1_API',
            indexNowStatus: 'SKIPPED',
          },
          retestSchedules: [],
        },
      ],
      periodCompletedSchedules: [
        {
          id: 'sched_small_t7',
          publishRecordId: 'pub_small',
          milestoneDay: 7,
          status: 'COMPLETED',
          executedAt: new Date('2026-10-09T00:00:00Z'),
          metricsSnapshotJson: {
            mentionRate: 1,
            avgPosition: 2,
            sentiment: 'positive',
            citationHit: true,
            sampleCount: 200,
            hitCount: 2,
            wilson: computeWilsonInterval(2, 200),
            confidenceLevel: 'HIGH',
          },
          controlMetricsJson: {
            controlPrompts: ['Control query 1'],
            baselineMentionRate: 0.5,
            currentMentionRate: 0.5,
            sampleCount: 200,
            hitCount: 1,
            wilson: computeWilsonInterval(1, 200),
          },
          publishRecord: {
            id: 'pub_small',
            channel: 'Ghost Blog',
            publishedUrl: 'https://astravault.example/small',
            crawlStatus: 'OK',
            beforeMetrics: {
              mentionRate: 0.5,
              avgPosition: 4,
              sentiment: 'neutral',
              citationHit: false,
            },
            afterMetrics: {
              mentionRate: 1,
              avgPosition: 2,
              sentiment: 'positive',
              citationHit: true,
            },
            distributionTask: { provider: 'GHOST', mode: 'L1_API' },
          },
        },
      ],
      pointLogs: [],
    });

    expect(smallSummary.milestoneTrend[0]?.mentionRate).toBe(0.005);
    expect(smallSummary.milestoneTrend[1]?.mentionRate).toBe(0.01);
    expect(smallSummary.overview.did).toEqual({
      treatmentDelta: 0.005,
      controlDelta: 0,
      netLift: 0.005,
      direction: 'POSITIVE',
    });
    expect(smallSummary.channelRanking[0]?.avgMentionRateDelta).toBe(0.005);
  });

  it("sanitizes export filenames per RFC 5987 (encodes !'()*, strips .. and DEL) and formats UTC calendar dates without off-by-one shift (#369 iter2)", () => {
    expect(formatUtcDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    expect(formatUtcDate('2026-10-31T23:59:59.999Z')).toBe('2026-10-31');

    const withParens = buildSafeRoiReportExportFilename(
      'AstraVault Monthly GEO ROI Report (2026-10-01 - 2026-10-31)',
      'rep_123456',
    );
    expect(withParens.contentDisposition).toContain("filename*=UTF-8''");
    const extValue = withParens.contentDisposition.split("filename*=UTF-8''")[1] ?? '';
    expect(extValue).not.toMatch(/[!'()*]/);
    expect(extValue).toContain('%282026-10-01-2026-10-31%29');

    const withQuotes = buildSafeRoiReportExportFilename("O'Reilly! Report (Q4) *test*", 'rep_abc');
    const quotesExt = withQuotes.contentDisposition.split("filename*=UTF-8''")[1] ?? '';
    expect(quotesExt).not.toMatch(/[!'()*]/);
    expect(quotesExt).toContain('%27');
    expect(quotesExt).toContain('%21');

    const traversal = buildSafeRoiReportExportFilename('../../etc/passwd', 'rep_trav01');
    expect(traversal.filename).toBe('etc-passwd.html');
    expect(traversal.filename).not.toContain('..');
    expect(traversal.contentDisposition).not.toContain('..');

    const dotsAndDel = buildSafeRoiReportExportFilename('..\u007f\u0000\r\n', 'rep_del999');
    expect(dotsAndDel.filename).toBe('geo-roi-report-del999.html');
    expect(dotsAndDel.filename).not.toContain('..');
    expect(dotsAndDel.filename).not.toContain('\u007f');
  });
});

describe('Monthly GEO ROI Report & Public Share HTTP lifecycle (#369)', () => {
  const originalEnv = { ...process.env };
  const reports = new Map<string, StoredReportRow>();
  let observationsData: Array<Record<string, unknown>> = [];
  let seq = 1;
  let app: INestApplication;
  let baseUrl: string;
  let publicService: RoiReportPublicService;
  let rateLimiter: FreeActionRateLimiter;
  let tokenA: string;
  let tokenB: string;
  let tokenExpired: string;

  const BRANDS: Record<
    string,
    {
      tenantId: string;
      brand: { id: string; name: string; category: string };
      market: {
        id: string;
        market: 'GLOBAL' | 'CN';
        locale: string;
        localBrandName: string;
        localCategory: string;
        aliases: string[];
        ownedDomains: string[];
        competitors: unknown[];
      };
    }
  > = {
    brand_a: {
      tenantId: 'tenant_a',
      brand: { id: 'brand_a', name: 'AstraVault', category: 'Home Storage' },
      market: {
        id: 'bm_a_global',
        market: 'GLOBAL',
        locale: 'en-US',
        localBrandName: 'AstraVault',
        localCategory: 'Home Storage',
        aliases: ['AstraVault Pro'],
        ownedDomains: ['astravault.example'],
        competitors: [],
      },
    },
  };

  beforeAll(async () => {
    const env = parseEnv(process.env);
    app = await createApiApp();

    const future = new Date(Date.now() + 30 * 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };

    const users: Record<string, unknown> = {
      user_a: {
        id: 'user_a',
        tenantId: 'tenant_a',
        username: 'user_a',
        nickname: 'User A',
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'hashed_pw_a',
        lastLoginAt: null,
        tenant: { id: 'tenant_a', name: 'Tenant A', isActive: true, expiresAt: future },
      },
      user_b: {
        id: 'user_b',
        tenantId: 'tenant_b',
        username: 'user_b',
        nickname: 'User B',
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'hashed_pw_b',
        lastLoginAt: null,
        tenant: { id: 'tenant_b', name: 'Tenant B', isActive: true, expiresAt: future },
      },
      user_expired: {
        id: 'user_expired',
        tenantId: 'tenant_a',
        username: 'user_expired',
        nickname: 'User Expired',
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'hashed_pw_exp',
        lastLoginAt: null,
        tenant: { id: 'tenant_a', name: 'Tenant A', isActive: true, expiresAt: past },
      },
    };

    const mockPrisma = {
      $disconnect: async () => undefined,
      auditLog: {
        findMany: async () => [],
        create: async () => ({ id: 'audit_1' }),
      },
      user: {
        findUnique: async (args: { where: { id?: string } }) =>
          (args.where.id ? users[args.where.id] : null) ?? null,
      },
      brandMarket: {
        findMany: vi.fn(async () => [{ ownedDomains: ['astravault.example'] }]),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => [...observationsData]),
      },
      visibilityRetrievedSource: {
        findMany: vi.fn(async () => []),
      },
      geoBrief: {
        findMany: vi.fn(async () => []),
      },
      geoPublishRecord: {
        findMany: vi.fn(async () => [
          {
            id: 'pub_1',
            articleId: 'art_1',
            channel: '微信公众号草稿箱',
            publishedUrl: 'https://astravault.example/post',
            publishedAt: new Date('2026-10-05T00:00:00Z'),
            crawlStatus: 'OK',
            crawlCheckedAt: new Date('2026-10-06T00:00:00Z'),
            indexNowSubmitted: true,
            beforeMetrics: {
              mentionRate: 20,
              avgPosition: 3,
              sentiment: 'neutral',
              citationHit: false,
            },
            afterMetrics: {
              mentionRate: 80,
              avgPosition: 1,
              sentiment: 'positive',
              citationHit: true,
            },
            distributionTask: {
              id: 'task_1',
              provider: 'WECHAT_OFFICIAL',
              mode: 'L1_API',
              indexNowStatus: 'OK',
            },
            retestSchedules: [],
          },
        ]),
      },
      geoRetestSchedule: {
        findMany: vi.fn(async () => []),
      },
      pointLog: {
        findMany: vi.fn(async () => [{ action: 'geo_write', delta: 0, listPrice: 50 }]),
      },
      visibilityRun: { findMany: vi.fn(async () => []) },
      geoArticle: { findMany: vi.fn(async () => [{ id: 'art_1' }]) },
      geoBatchJob: { findMany: vi.fn(async () => []) },
      geoVariantJob: { findMany: vi.fn(async () => []) },
      geoDistributionTask: { findMany: vi.fn(async () => [{ id: 'task_1' }]) },
      geoRoiReport: {
        findUnique: vi.fn(async (args: { where: { shareTokenHash: string } }) => {
          for (const row of reports.values()) {
            if (row.shareTokenHash && row.shareTokenHash === args.where.shareTokenHash) {
              return {
                id: row.id,
                tenantId: row.tenantId,
                shareExpiresAt: row.shareExpiresAt,
                shareRevokedAt: row.shareRevokedAt,
              };
            }
          }
          return null;
        }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const now = new Date(Date.now() + seq * 1000);
          const id = `roi_rep_${seq++}`;
          const row: StoredReportRow = {
            id,
            tenantId: String(args.data.tenantId),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            title: String(args.data.title),
            periodStart: args.data.periodStart as Date,
            periodEnd: args.data.periodEnd as Date,
            locale: String(args.data.locale),
            whiteLabelOrg: (args.data.whiteLabelOrg as string | null) ?? null,
            summaryJson: structuredClone(args.data.summaryJson) as Prisma.JsonValue,
            shareTokenHash: null,
            shareExpiresAt: null,
            shareRevokedAt: null,
            createdByUserId: (args.data.createdByUserId as string | null) ?? null,
            createdAt: now,
            updatedAt: now,
          };
          reports.set(id, row);
          return row;
        }),
        findMany: vi.fn(
          async (args: { where: { brandId?: string; brandMarketId?: string }; take?: number }) => {
            const tid = currentTenantId();
            const list = [...reports.values()]
              .filter(
                (r) =>
                  r.tenantId === tid &&
                  (!args.where.brandId || r.brandId === args.where.brandId) &&
                  (!args.where.brandMarketId || r.brandMarketId === args.where.brandMarketId),
              )
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .map((r) => ({
                ...r,
                brandMarket: BRANDS[r.brandId]?.market ?? { market: 'GLOBAL' },
              }));
            return args.take ? list.slice(0, args.take) : list;
          },
        ),
        findFirst: vi.fn(
          async (args: {
            where: {
              id?: string;
              shareTokenHash?: string;
              shareRevokedAt?: null;
              shareExpiresAt?: { gt: Date };
            };
          }) => {
            const tid = currentTenantId();
            const row = args.where.id ? reports.get(args.where.id) : undefined;
            if (!row || row.tenantId !== tid) return null;
            if (args.where.shareTokenHash && row.shareTokenHash !== args.where.shareTokenHash) {
              return null;
            }
            if (args.where.shareRevokedAt === null && row.shareRevokedAt !== null) {
              return null;
            }
            if (
              args.where.shareExpiresAt?.gt &&
              (!row.shareExpiresAt ||
                row.shareExpiresAt.getTime() <= args.where.shareExpiresAt.gt.getTime())
            ) {
              return null;
            }
            const b = BRANDS[row.brandId];
            return {
              ...row,
              brand: b?.brand ?? { name: 'AstraVault', category: 'Home Storage' },
              brandMarket: b?.market ?? {
                market: 'GLOBAL',
                locale: 'en-US',
                localBrandName: 'AstraVault',
                localCategory: 'Home Storage',
              },
            };
          },
        ),
        update: vi.fn(async (args: { where: { id: string }; data: Partial<StoredReportRow> }) => {
          const tid = currentTenantId();
          const row = reports.get(args.where.id);
          if (!row || row.tenantId !== tid) {
            throw new Error('Not found');
          }
          Object.assign(row, args.data, { updatedAt: new Date() });
          return row;
        }),
      },
    };

    prismaSvc.base = mockPrisma;
    prismaSvc.scoped = mockPrisma;

    const brandsSvc = app.get(BrandsService);
    vi.spyOn(brandsSvc, 'resolveBrandMarket').mockImplementation(async (brandId) => {
      const tid = currentTenantId();
      const entry = BRANDS[brandId];
      if (!entry || entry.tenantId !== tid) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
      }
      return {
        brand: entry.brand as never,
        market: entry.market as never,
      };
    });
    vi.spyOn(brandsSvc, 'getById').mockImplementation(async (brandId) => {
      const tid = currentTenantId();
      const entry = BRANDS[brandId];
      if (!entry || entry.tenantId !== tid) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
      }
      return entry.brand as never;
    });

    publicService = app.get(RoiReportPublicService);
    rateLimiter = app.get(FreeActionRateLimiter);

    const nowSec = Math.floor(Date.now() / 1000);
    tokenA = signToken(
      {
        sub: 'user_a',
        tid: 'tenant_a',
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hashed_pw_a'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );
    tokenB = signToken(
      {
        sub: 'user_b',
        tid: 'tenant_b',
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hashed_pw_b'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );
    tokenExpired = signToken(
      {
        sub: 'user_expired',
        tid: 'tenant_a',
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint('hashed_pw_exp'),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      env.JWT_ACCESS_SECRET,
    );

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    reports.clear();
    seq = 1;
    observationsData = [
      {
        id: 'obs_init_1',
        runId: 'run_1',
        engine: 'chatgpt',
        promptText: 'Best silent 4-bay NAS',
        status: 'SUCCESS',
        answerText: 'AstraVault is ideal.',
        brandMentioned: true,
        brandPosition: 1,
        checkedAt: new Date('2026-10-12T00:00:00Z'),
        createdAt: new Date('2026-10-12T00:00:00Z'),
        citations: [
          {
            id: 'c1',
            url: 'https://astravault.example/post',
            domain: 'astravault.example',
            sourceKind: 'OWNED',
            position: 1,
          },
        ],
      },
    ];
    process.env.PUBLIC_APP_URL = 'https://app.geomix.example';
    process.env.AUTH_TRUST_PROXY = 'false';
    delete process.env.ROI_REPORT_EXPORT_RATE_LIMIT_MAX;
    delete process.env.ROI_REPORT_SHARE_RATE_LIMIT_MAX;
    delete process.env.PUBLIC_ROI_REPORT_GET_RATE_LIMIT_MAX;
    rateLimiter.reset();
    publicService.resetRateLimits();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('runs complete lifecycle: immutable creation, list/detail, HTML export headers, share (32B SHA-256), unauthenticated public sanitized DTO, revoke -> 404, expired/unknown -> 404, tenant isolation & expired tenant 403/40301', async () => {
    // Expired tenant blocked on write with 403 / 40301
    const expiredRes = await fetch(`${baseUrl}/api/v2/brands/brand_a/roi-reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenExpired}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
    });
    expect(expiredRes.status).toBe(403);
    const expiredBody = (await expiredRes.json()) as { code: number };
    expect(expiredBody.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Cross-tenant brand returns 404
    const crossCreate = await fetch(`${baseUrl}/api/v2/brands/brand_a/roi-reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
    });
    expect(crossCreate.status).toBe(404);

    // Create report for tenant_a
    const createdRes = await fetch(`${baseUrl}/api/v2/brands/brand_a/roi-reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        whiteLabelOrg: 'Northstar GEO Agency',
        locale: 'en-US',
      }),
    });
    expect(createdRes.status).toBe(200);
    const createdBody = (await createdRes.json()) as {
      data: {
        id: string;
        periodStart: string;
        periodEnd: string;
        whiteLabelOrg: string | null;
        shareActive: boolean;
        summary: {
          overview: { totalObservations: number };
          pointsRoi: { totalPointsSpent: number };
        };
      };
    };

    const reportId = createdBody.data.id;
    expect(createdBody.data.periodStart).toBe('2026-10-01T00:00:00.000Z');
    expect(createdBody.data.periodEnd).toBe('2026-10-31T23:59:59.999Z');
    // Defect 8: default title must show UTC periodEnd 2026-10-31 (NOT UTC+8 2026-11-01)
    expect((createdBody.data as { title?: string }).title).toContain('2026-10-01 - 2026-10-31');
    expect((createdBody.data as { title?: string }).title).not.toContain('2026-11-01');
    expect(createdBody.data.whiteLabelOrg).toBe('Northstar GEO Agency');
    expect(createdBody.data.shareActive).toBe(false);
    expect(createdBody.data).not.toHaveProperty('shareTokenHash');
    expect(createdBody.data.summary.overview.totalObservations).toBe(1);
    expect(createdBody.data.summary.pointsRoi.totalPointsSpent).toBe(50);

    // Mutate underlying observations AFTER report creation to prove snapshot immutability!
    observationsData.push({
      id: 'obs_mutated_later',
      runId: 'run_2',
      engine: 'perplexity',
      promptText: 'New prompt',
      status: 'SUCCESS',
      answerText: 'New text',
      brandMentioned: false,
      brandPosition: null,
      checkedAt: new Date('2026-10-20T00:00:00Z'),
      createdAt: new Date('2026-10-20T00:00:00Z'),
      citations: [],
    });

    // Detail still reflects immutable snapshot (totalObservations === 1)
    const detailRes = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: { summary: { overview: { totalObservations: number } } };
    };
    expect(detailBody.data.summary.overview.totalObservations).toBe(1);
    expect(detailBody.data).not.toHaveProperty('shareTokenHash');

    // Cross-tenant detail returns 404
    const crossDetail = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(crossDetail.status).toBe(404);

    // List reports
    const listRes = await fetch(`${baseUrl}/api/v2/brands/brand_a/roi-reports`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]?.id).toBe(reportId);

    // HTML export requires auth (401 without Bearer)
    const unauthExport = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/export.html`);
    expect(unauthExport.status).toBe(401);

    // HTML export returns defense-in-depth headers and self-contained HTML
    const exportRes = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/export.html`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(exportRes.headers.get('content-disposition')).toContain('attachment;');
    expect(exportRes.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(exportRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(exportRes.headers.get('cache-control')).toBe('no-store');
    expect(exportRes.headers.get('referrer-policy')).toBe('no-referrer');
    const exportHtml = await exportRes.text();
    expect(exportHtml).toContain('Northstar GEO Agency');
    expect(exportHtml).toContain('2026-10-01 ~ 2026-10-31');
    expect(exportHtml).toContain('1/1 observations');
    expect(exportHtml).not.toMatch(/<script\b/i);

    // Issue share link (32-byte random base64url token, ONLY SHA-256 hash stored in DB)
    const shareRes = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(shareRes.status).toBe(200);
    const shareBody = (await shareRes.json()) as {
      data: { token: string; sharePath: string; shareUrl: string; expiresAt: string };
    };
    const token = shareBody.data.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(shareBody.data.sharePath).toBe(`/share/report/${token}`);
    expect(shareBody.data.shareUrl).toBe(`https://app.geomix.example/share/report/${token}`);

    const storedRow = reports.get(reportId)!;
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(storedRow.shareTokenHash).toBe(expectedHash);
    expect(storedRow.shareTokenHash).not.toBe(token);
    const ttlDiffDays = (storedRow.shareExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(ttlDiffDays).toBeGreaterThan(29.5);
    expect(ttlDiffDays).toBeLessThanOrEqual(30.1);

    // Unauthenticated public GET returns 200 with strict 11-key PublicGeoRoiReportDto
    const publicRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`);
    expect(publicRes.status).toBe(200);
    const publicBody = (await publicRes.json()) as {
      data: Record<string, unknown> & {
        summary: Record<string, unknown> & { channelRanking: Array<{ channel: string }> };
      };
    };
    expect(Object.keys(publicBody.data).sort()).toEqual([
      'brandName',
      'category',
      'expiresAt',
      'generatedAt',
      'locale',
      'market',
      'periodEnd',
      'periodStart',
      'summary',
      'title',
      'whiteLabelOrg',
    ]);
    expect(publicBody.data).not.toHaveProperty('tenantId');
    expect(publicBody.data).not.toHaveProperty('userId');
    expect(publicBody.data).not.toHaveProperty('shareTokenHash');
    expect(publicBody.data.summary).not.toHaveProperty('pointsRoi');
    expect(publicBody.data.summary.channelRanking[0]?.channel).toBe('WeChat Official Drafts');

    // Cross-tenant Bearer token visiting Tenant A's public link still succeeds via runInTenant
    const crossPublicRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(crossPublicRes.status).toBe(200);

    // Uniform 404 across malformed, unknown, expired, and revoked tokens
    const badFormatRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/short`);
    expect(badFormatRes.status).toBe(404);
    const badFormatBody = (await badFormatRes.json()) as { code: number; msg: string };

    const unknownRes = await fetch(
      `${baseUrl}/api/v2/public/roi-reports/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(unknownRes.status).toBe(404);
    const unknownBody = (await unknownRes.json()) as { code: number; msg: string };

    expect(badFormatBody.code).toBe(AUTH_ERROR.NOT_FOUND);
    expect(unknownBody.code).toBe(AUTH_ERROR.NOT_FOUND);
    expect(badFormatBody.msg).toBe(unknownBody.msg);

    // Expired token -> identical 404
    storedRow.shareExpiresAt = new Date(Date.now() - 10_000);
    const expiredTokenRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`);
    expect(expiredTokenRes.status).toBe(404);
    const expiredTokenBody = (await expiredTokenRes.json()) as { msg: string };
    expect(expiredTokenBody.msg).toBe(unknownBody.msg);

    // Restore expiry, revoke via DELETE /share -> immediately 404 + idempotent
    storedRow.shareExpiresAt = new Date(Date.now() + 86_400_000);
    const rev1 = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/share`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(rev1.status).toBe(200);
    const rev2 = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/share`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(rev2.status).toBe(200);

    const revokedRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`);
    expect(revokedRes.status).toBe(404);
    const revokedBody = (await revokedRes.json()) as { msg: string };
    expect(revokedBody.msg).toBe(unknownBody.msg);
  });

  it('enforces rate limits (429 + Retry-After) on roi_report_export, roi_report_share, and public_roi_report_get (ignoring spoofed X-Forwarded-For)', async () => {
    process.env.ROI_REPORT_EXPORT_RATE_LIMIT_MAX = '2';
    process.env.ROI_REPORT_SHARE_RATE_LIMIT_MAX = '1';
    process.env.PUBLIC_ROI_REPORT_GET_RATE_LIMIT_MAX = '2';
    rateLimiter.reset();
    publicService.resetRateLimits();

    // 1st export-bucket call: create report
    const createdRes = await fetch(`${baseUrl}/api/v2/brands/brand_a/roi-reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
    });
    expect(createdRes.status).toBe(200);
    const createdBody = (await createdRes.json()) as { data: { id: string } };
    const reportId = createdBody.data.id;

    // 2nd export-bucket call: export.html
    const exp1 = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/export.html`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(exp1.status).toBe(200);

    // 3rd export-bucket call -> 429 + Retry-After
    const expLimited = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/export.html`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(expLimited.status).toBe(429);
    const expLimitedBody = (await expLimited.json()) as { code: number };
    expect(expLimitedBody.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(expLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // 1st share call succeeds, 2nd -> 429
    const sharedRes = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttlDays: 7 }),
    });
    expect(sharedRes.status).toBe(200);
    const sharedBody = (await sharedRes.json()) as { data: { token: string } };
    const token = sharedBody.data.token;

    const shareLimited = await fetch(`${baseUrl}/api/v2/roi-reports/${reportId}/share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttlDays: 7 }),
    });
    expect(shareLimited.status).toBe(429);
    const shareLimitedBody = (await shareLimited.json()) as { code: number };
    expect(shareLimitedBody.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);

    // Public IP rate limit (max=2) — spoofing X-Forwarded-For does NOT bypass when AUTH_TRUST_PROXY=false
    const pub1 = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`, {
      headers: { 'X-Forwarded-For': '203.0.113.1' },
    });
    expect(pub1.status).toBe(200);
    const pub2 = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`, {
      headers: { 'X-Forwarded-For': '203.0.113.2' },
    });
    expect(pub2.status).toBe(200);
    const pubLimited = await fetch(`${baseUrl}/api/v2/public/roi-reports/${token}`, {
      headers: { 'X-Forwarded-For': '203.0.113.3' },
    });
    expect(pubLimited.status).toBe(429);
    const pubLimitedBody = (await pubLimited.json()) as { code: number };
    expect(pubLimitedBody.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(pubLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('localizes provider=null Chinese manual channels to zero-CJK EN and localizes known providers in zh-CN on public share DTO (#369 iter2)', async () => {
    const enToken = 'en_manual_channel_share_token_0000000000001';
    const zhToken = 'zh_provider_channel_share_token_00000000002';
    const now = new Date();
    const expires = new Date(now.getTime() + 86_400_000);

    reports.set('rep_en_manual', {
      id: 'rep_en_manual',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_global',
      title: 'EN Manual Channels Report',
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-31T23:59:59.999Z'),
      locale: 'en-US',
      whiteLabelOrg: null,
      summaryJson: {
        version: 1,
        overview: {
          totalObservations: 0,
          mentionHits: 0,
          mentionRate: 0,
          mentionWilson: computeWilsonInterval(0, 0),
          citationHits: 0,
          citationRate: 0,
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
          publishedTotal: 2,
          l1Count: 0,
          l2Count: 0,
          l3Count: 2,
          crawlCheckedCount: 0,
          crawlOkCount: 0,
          crawlOkRate: null,
          indexNowAttemptedCount: 0,
          indexNowSuccessCount: 0,
          indexNowRate: null,
        },
        channelRanking: [
          {
            channel: '微信公众号草稿箱',
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
            channel: '未登记中文渠道',
            provider: null,
            mode: 'L3_COMMUNITY_ASSIST',
            publishedCount: 1,
            completedRetestCount: 0,
            citationHitCount: 0,
            citationHitRate: null,
            citationHitWilson: null,
            avgMentionRateDelta: null,
          },
        ],
        milestoneTrend: [],
      } as unknown as Prisma.JsonValue,
      shareTokenHash: createHash('sha256').update(enToken, 'utf8').digest('hex'),
      shareExpiresAt: expires,
      shareRevokedAt: null,
      createdByUserId: 'user_a',
      createdAt: now,
      updatedAt: now,
    });

    reports.set('rep_zh_provider', {
      id: 'rep_zh_provider',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_global',
      title: '中文渠道本地化报告',
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-31T23:59:59.999Z'),
      locale: 'zh-CN',
      whiteLabelOrg: null,
      summaryJson: {
        version: 1,
        overview: {
          totalObservations: 0,
          mentionHits: 0,
          mentionRate: 0,
          mentionWilson: computeWilsonInterval(0, 0),
          citationHits: 0,
          citationRate: 0,
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
          publishedTotal: 1,
          l1Count: 1,
          l2Count: 0,
          l3Count: 0,
          crawlCheckedCount: 0,
          crawlOkCount: 0,
          crawlOkRate: null,
          indexNowAttemptedCount: 0,
          indexNowSuccessCount: 0,
          indexNowRate: null,
        },
        channelRanking: [
          {
            channel: 'Shopify Blog',
            provider: 'SHOPIFY',
            mode: 'L1_API',
            publishedCount: 1,
            completedRetestCount: 0,
            citationHitCount: 0,
            citationHitRate: null,
            citationHitWilson: null,
            avgMentionRateDelta: null,
          },
        ],
        milestoneTrend: [],
      } as unknown as Prisma.JsonValue,
      shareTokenHash: createHash('sha256').update(zhToken, 'utf8').digest('hex'),
      shareExpiresAt: expires,
      shareRevokedAt: null,
      createdByUserId: 'user_a',
      createdAt: now,
      updatedAt: now,
    });

    const enRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${enToken}`);
    expect(enRes.status).toBe(200);
    const enBody = (await enRes.json()) as {
      data: { summary: { channelRanking: Array<{ channel: string }> } };
    };
    expect(enBody.data.summary.channelRanking.map((c) => c.channel)).toEqual([
      'WeChat Official Drafts',
      'External Channel',
    ]);
    expect(JSON.stringify(enBody.data.summary.channelRanking)).not.toMatch(/[\u4E00-\u9FFF]/);

    const zhRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${zhToken}`);
    expect(zhRes.status).toBe(200);
    const zhBody = (await zhRes.json()) as {
      data: { summary: { channelRanking: Array<{ channel: string }> } };
    };
    expect(zhBody.data.summary.channelRanking[0]?.channel).toBe('Shopify 博客');
  });

  it('prevents Object.prototype channel keys with a valid provider from dropping/corrupting public share JSON or leaking native code in HTML export across en-US and zh-CN (#369 iter3)', async () => {
    const enToken = 'en_proto_channel_share_token_00000000000003';
    const zhToken = 'zh_proto_channel_share_token_00000000000004';
    const now = new Date();
    const expires = new Date(now.getTime() + 86_400_000);

    const buildProtoSummary = (): Prisma.JsonValue =>
      ({
        version: 1,
        overview: {
          totalObservations: 1,
          mentionHits: 1,
          mentionRate: 1,
          mentionWilson: computeWilsonInterval(1, 1),
          citationHits: 1,
          citationRate: 1,
          ownedCitationHits: 1,
          ownedCitationRate: 1,
          confidenceLevel: 'LOW',
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
          publishedTotal: 3,
          l1Count: 3,
          l2Count: 0,
          l3Count: 0,
          crawlCheckedCount: 3,
          crawlOkCount: 3,
          crawlOkRate: 1,
          indexNowAttemptedCount: 0,
          indexNowSuccessCount: 0,
          indexNowRate: null,
        },
        channelRanking: (['constructor', 'toString', '__proto__'] as const).map((channel) => ({
          channel,
          provider: 'SHOPIFY',
          mode: 'L1_API',
          publishedCount: 1,
          completedRetestCount: 1,
          citationHitCount: 1,
          citationHitRate: 1,
          citationHitWilson: computeWilsonInterval(1, 1),
          avgMentionRateDelta: 0,
        })),
        milestoneTrend: [],
      }) as unknown as Prisma.JsonValue;

    reports.set('rep_en_proto_ch', {
      id: 'rep_en_proto_ch',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_global',
      title: 'EN Prototype Channel Report',
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-31T23:59:59.999Z'),
      locale: 'en-US',
      whiteLabelOrg: null,
      summaryJson: buildProtoSummary(),
      shareTokenHash: createHash('sha256').update(enToken, 'utf8').digest('hex'),
      shareExpiresAt: expires,
      shareRevokedAt: null,
      createdByUserId: 'user_a',
      createdAt: now,
      updatedAt: now,
    });

    reports.set('rep_zh_proto_ch', {
      id: 'rep_zh_proto_ch',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_a_global',
      title: '中文原型键渠道报告',
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-31T23:59:59.999Z'),
      locale: 'zh-CN',
      whiteLabelOrg: null,
      summaryJson: buildProtoSummary(),
      shareTokenHash: createHash('sha256').update(zhToken, 'utf8').digest('hex'),
      shareExpiresAt: expires,
      shareRevokedAt: null,
      createdByUserId: 'user_a',
      createdAt: now,
      updatedAt: now,
    });

    const enPubRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${enToken}`);
    expect(enPubRes.status).toBe(200);
    const enPubBody = (await enPubRes.json()) as {
      data: { summary: { channelRanking: Array<{ channel: unknown; provider: string | null }> } };
    };
    expect(enPubBody.data.summary.channelRanking).toHaveLength(3);
    for (const item of enPubBody.data.summary.channelRanking) {
      expect(Object.hasOwn(item, 'channel')).toBe(true);
      expect(typeof item.channel).toBe('string');
      expect((item.channel as string).trim().length).toBeGreaterThan(0);
    }
    expect(enPubBody.data.summary.channelRanking.map((c) => c.channel)).toEqual([
      'constructor',
      'toString',
      '__proto__',
    ]);
    expect(JSON.stringify(enPubBody.data.summary.channelRanking)).not.toContain('[native code]');
    expect(JSON.stringify(enPubBody.data.summary.channelRanking)).not.toContain('[object Object]');

    const zhPubRes = await fetch(`${baseUrl}/api/v2/public/roi-reports/${zhToken}`);
    expect(zhPubRes.status).toBe(200);
    const zhPubBody = (await zhPubRes.json()) as {
      data: { summary: { channelRanking: Array<{ channel: unknown; provider: string | null }> } };
    };
    expect(zhPubBody.data.summary.channelRanking).toHaveLength(3);
    for (const item of zhPubBody.data.summary.channelRanking) {
      expect(Object.hasOwn(item, 'channel')).toBe(true);
      expect(typeof item.channel).toBe('string');
      expect((item.channel as string).trim().length).toBeGreaterThan(0);
      expect(item.channel).toBe('Shopify 博客');
    }

    const enExportRes = await fetch(`${baseUrl}/api/v2/roi-reports/rep_en_proto_ch/export.html`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(enExportRes.status).toBe(200);
    const enExportHtml = await enExportRes.text();
    expect(enExportHtml).not.toContain('[native code]');
    expect(enExportHtml).not.toContain('[object Object]');

    const zhExportRes = await fetch(`${baseUrl}/api/v2/roi-reports/rep_zh_proto_ch/export.html`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(zhExportRes.status).toBe(200);
    const zhExportHtml = await zhExportRes.text();
    expect(zhExportHtml).not.toContain('[native code]');
    expect(zhExportHtml).not.toContain('[object Object]');
    expect(zhExportHtml).toContain('Shopify 博客');
  });
});
