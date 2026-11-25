import { describe, expect, it, vi } from 'vitest';
import type { BrandsService } from '../brands/brands.service';
import type { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { readVisibilityConfig } from './visibility.config';
import {
  VisibilityNearMissService,
  canonicalizeNearMissUrl,
  computeNearMissOpportunityScore,
} from './visibility-near-miss.service';

function buildService(overrides: {
  retrievedCount?: number;
  retrievedRows?: unknown[];
  publishRecords?: unknown[];
  observations?: unknown[];
  runs?: Array<{ id: string; engines: string[] }>;
  ownedDomains?: string[];
  competitors?: unknown[];
}) {
  const brands = {
    resolveBrandMarket: vi.fn(async () => ({
      brand: { id: 'brand_1', name: '星云存储', category: '家用NAS' },
      market: {
        id: 'bm_cn',
        brandId: 'brand_1',
        market: 'CN' as const,
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: '星云存储',
        aliases: ['星云NAS'],
        ownedDomains: overrides.ownedDomains ?? ['xingyun.example'],
        competitors: overrides.competitors ?? [
          { name: '竞品甲', aliases: [], domains: ['compa.example'] },
        ],
      },
    })),
  } as unknown as BrandsService;

  const prisma = {
    scoped: {
      brandMarket: {
        findMany: vi.fn(async () => [
          { ownedDomains: overrides.ownedDomains ?? ['xingyun.example'] },
        ]),
      },
      visibilityRetrievedSource: {
        count: vi.fn(async () => overrides.retrievedCount ?? overrides.retrievedRows?.length ?? 0),
        findMany: vi.fn(async () => overrides.retrievedRows ?? []),
      },
      geoPublishRecord: {
        findMany: vi.fn(async () => overrides.publishRecords ?? []),
      },
      visibilityRun: {
        findMany: vi.fn(async () => overrides.runs ?? []),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => overrides.observations ?? []),
      },
    },
  } as unknown as PrismaService;

  const service = new VisibilityNearMissService(
    prisma,
    brands,
    readVisibilityConfig({ VISIBILITY_FEATURE_ENABLED: 'true', VISIBILITY_COLLECTOR: 'fake' }),
  );

  return { service, prisma, brands };
}

describe('VisibilityNearMissService (#368)', () => {
  it('canonicalizes URLs consistently across scheme, default ports, www, trailing slash, hash, and tracking params', () => {
    expect(
      canonicalizeNearMissUrl('https://www.Example.com:443/Guide/?utm_source=ai&b=2&a=1#sec'),
    ).toBe('example.com/Guide?a=1&b=2');
    expect(canonicalizeNearMissUrl('http://example.com:80/Guide?a=1&b=2&fbclid=xyz')).toBe(
      'example.com/Guide?a=1&b=2',
    );
  });

  it('scores owned OPENED_NOT_CITED above non-owned OPENED_NOT_CITED and RETRIEVED_NOT_CITED', () => {
    const nowMs = Date.now();
    const ownedOpened = computeNearMissOpportunityScore({
      tier: 'OPENED_NOT_CITED',
      sourceKind: 'OWNED',
      engineCount: 1,
      openedCount: 1,
      retrievedCount: 1,
      lastSeenAtMs: nowMs,
      nowMs,
    });
    const thirdPartyOpened = computeNearMissOpportunityScore({
      tier: 'OPENED_NOT_CITED',
      sourceKind: 'AUTHORITY',
      engineCount: 1,
      openedCount: 1,
      retrievedCount: 1,
      lastSeenAtMs: nowMs,
      nowMs,
    });
    const ownedRetrieved = computeNearMissOpportunityScore({
      tier: 'RETRIEVED_NOT_CITED',
      sourceKind: 'OWNED',
      engineCount: 1,
      openedCount: 0,
      retrievedCount: 1,
      lastSeenAtMs: nowMs,
      nowMs,
    });

    expect(ownedOpened).toBeGreaterThan(thirdPartyOpened);
    expect(ownedOpened).toBeGreaterThan(ownedRetrieved);
    expect(ownedOpened).toBeLessThanOrEqual(100);
    expect(ownedOpened).toBeGreaterThanOrEqual(1);
  });

  it('aggregates all 4 tiers, promotes shared Tier 1/2 URLs without duplication, and sorts by opportunityScore', async () => {
    const now = new Date();
    const { service } = buildService({
      retrievedRows: [
        // Same owned URL opened once and retrieved once -> should promote to single OPENED_NOT_CITED
        {
          id: 'rs_1',
          observationId: 'obs_1',
          engine: 'deepseek',
          url: 'https://www.xingyun.example/guides/silent-nas/?utm_source=deepseek',
          domain: 'xingyun.example',
          title: '星云存储静音指南',
          snippet: '实测 21dB',
          sourceKind: 'OTHER',
          wasOpened: true,
          wasCited: false,
          rank: 2,
          createdAt: now,
          observation: {
            id: 'obs_1',
            promptText: '家用静音四盘位NAS推荐',
            engine: 'deepseek',
            status: 'SUCCESS',
            checkedAt: now,
            createdAt: now,
          },
        },
        {
          id: 'rs_2',
          observationId: 'obs_2',
          engine: 'doubao',
          url: 'https://xingyun.example/guides/silent-nas',
          domain: 'xingyun.example',
          title: null,
          snippet: null,
          sourceKind: 'OWNED',
          wasOpened: false,
          wasCited: false,
          rank: 4,
          createdAt: now,
          observation: {
            id: 'obs_2',
            promptText: '四盘位 NAS 噪音对比',
            engine: 'doubao',
            status: 'SUCCESS',
            checkedAt: now,
            createdAt: now,
          },
        },
        // Pure Tier 2 RETRIEVED_NOT_CITED (third-party)
        {
          id: 'rs_3',
          observationId: 'obs_1',
          engine: 'deepseek',
          url: 'https://36kr.com/p/nas-2026',
          domain: '36kr.com',
          title: '2026 家用 NAS 行业报告',
          snippet: '行业观察',
          sourceKind: 'AUTHORITY',
          wasOpened: false,
          wasCited: false,
          rank: 5,
          createdAt: now,
          observation: {
            id: 'obs_1',
            promptText: '家用静音四盘位NAS推荐',
            engine: 'deepseek',
            status: 'SUCCESS',
            checkedAt: now,
            createdAt: now,
          },
        },
        // Failed observation row should be ignored
        {
          id: 'rs_failed',
          observationId: 'obs_fail',
          engine: 'deepseek',
          url: 'https://xingyun.example/should-ignore',
          domain: 'xingyun.example',
          title: 'Ignore',
          snippet: null,
          sourceKind: 'OWNED',
          wasOpened: true,
          wasCited: false,
          rank: 1,
          createdAt: now,
          observation: {
            id: 'obs_fail',
            promptText: 'ignored',
            engine: 'deepseek',
            status: 'FAILED',
            checkedAt: now,
            createdAt: now,
          },
        },
      ],
      publishRecords: [
        // Valid Tier 3A via completed retestSchedule
        {
          id: 'pub_1',
          publishedUrl: 'https://xingyun.example/blog/retest-miss',
          channel: 'WORDPRESS',
          publishedAt: now,
          latestRetestRunId: 'run_retest_1',
          afterMetrics: null,
          crawlStatus: 'OK',
          crawlCheckedAt: now,
          updatedAt: now,
          article: {
            id: 'art_1',
            title: '星云存储功耗实测',
            targetPrompt: '家用 NAS 功耗对比',
          },
          retestSchedules: [
            {
              id: 'sched_1',
              status: 'COMPLETED',
              milestoneDay: 7,
              visibilityRunId: 'run_retest_1',
              metricsSnapshotJson: {
                mentionRate: 0.4,
                avgPosition: 2,
                sentiment: 'positive',
                citationHit: false,
              },
              executedAt: now,
            },
          ],
        },
        // Excluded: citationHit === true
        {
          id: 'pub_cited',
          publishedUrl: 'https://xingyun.example/blog/already-cited',
          channel: 'WORDPRESS',
          publishedAt: now,
          latestRetestRunId: null,
          afterMetrics: { mentionRate: 0.8, citationHit: true },
          crawlStatus: 'OK',
          crawlCheckedAt: now,
          updatedAt: now,
          article: { id: 'art_2', title: '已引用', targetPrompt: '已引用问题' },
          retestSchedules: [],
        },
        // Excluded: no completed retest snapshot at all
        {
          id: 'pub_no_retest',
          publishedUrl: 'https://xingyun.example/blog/no-retest',
          channel: 'WORDPRESS',
          publishedAt: now,
          latestRetestRunId: null,
          afterMetrics: null,
          crawlStatus: 'OK',
          crawlCheckedAt: now,
          updatedAt: now,
          article: { id: 'art_3', title: '未复测', targetPrompt: '未复测问题' },
          retestSchedules: [],
        },
      ],
      runs: [{ id: 'run_retest_1', engines: ['deepseek', 'doubao'] }],
      observations: [
        // Valid Tier 3B: brandMentioned=true, 0 OWNED citations, COMPETITOR + AUTHORITY citations -> picks COMPETITOR
        {
          id: 'obs_3b_1',
          brandMarketId: 'bm_cn',
          promptText: '家用四盘位 NAS 哪款最安静',
          answerText: '星云存储和竞品甲在家用四盘位 NAS 静音表现都不错。',
          engine: 'deepseek',
          brandMentioned: true,
          brandPassage: '星云存储实测表现优秀',
          checkedAt: now,
          createdAt: now,
          citations: [
            {
              id: 'c_1',
              url: 'https://36kr.com/p/nas-review',
              domain: '36kr.com',
              title: '36氪横评',
              snippet: '权威评测',
              sourceKind: 'AUTHORITY',
              position: 1,
            },
            {
              id: 'c_2',
              url: 'https://compa.example/nas-pro',
              domain: 'compa.example',
              title: '竞品甲旗舰页',
              snippet: '竞品规格',
              sourceKind: 'COMPETITOR',
              position: 2,
            },
          ],
        },
        // Excluded from Tier 3B: has an OWNED citation on the same prompt
        {
          id: 'obs_3b_owned',
          brandMarketId: 'bm_cn',
          promptText: '星云存储官方售后政策',
          answerText: '星云存储提供 3 年质保。',
          engine: 'deepseek',
          brandMentioned: true,
          brandPassage: '星云存储提供 3 年质保',
          checkedAt: now,
          createdAt: now,
          citations: [
            {
              id: 'c_own',
              url: 'https://xingyun.example/warranty',
              domain: 'xingyun.example',
              title: '官方质保',
              snippet: '3 年质保',
              sourceKind: 'OWNED',
              position: 1,
            },
            {
              id: 'c_ext',
              url: 'https://zhuanlan.zhihu.com/p/999',
              domain: 'zhuanlan.zhihu.com',
              title: '知乎讨论',
              snippet: null,
              sourceKind: 'SOCIAL',
              position: 2,
            },
          ],
        },
      ],
    });

    const result = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, limit: 50 }),
    );

    expect(result.hasRawRetrievalSignals).toBe(true);
    expect(result.total).toBe(4);
    expect(result.tierCounts).toEqual({
      OPENED_NOT_CITED: 1,
      RETRIEVED_NOT_CITED: 1,
      CRAWLED_NOT_CITED: 1,
      MENTIONED_NOT_OWNED: 1,
    });

    // Top item must be owned OPENED_NOT_CITED promoted from 2 rows
    const top = result.items[0]!;
    expect(top.tier).toBe('OPENED_NOT_CITED');
    expect(top.isOwned).toBe(true);
    expect(top.sourceKind).toBe('OWNED');
    expect(top.openedCount).toBe(1);
    expect(top.retrievedCount).toBe(2);
    expect(top.engines).toEqual(['deepseek', 'doubao']);
    expect(top.prompts).toHaveLength(2);
    expect(top.observationIds).toEqual(['obs_1', 'obs_2']);

    // Tier 3A carries publishRecordId and linked run engines
    const t3a = result.items.find((i) => i.tier === 'CRAWLED_NOT_CITED');
    expect(t3a).toBeDefined();
    expect(t3a?.publishRecordId).toBe('pub_1');
    expect(t3a?.engines).toEqual(['deepseek', 'doubao']);
    expect(t3a?.isOwned).toBe(true);

    // Tier 3B picks COMPETITOR over AUTHORITY
    const t3b = result.items.find((i) => i.tier === 'MENTIONED_NOT_OWNED');
    expect(t3b).toBeDefined();
    expect(t3b?.sourceKind).toBe('COMPETITOR');
    expect(t3b?.domain).toBe('compa.example');
    expect(t3b?.isOwned).toBe(false);

    // Filtering by tier preserves full tierCounts
    const tierFiltered = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, tier: 'RETRIEVED_NOT_CITED', limit: 50 }),
    );
    expect(tierFiltered.total).toBe(1);
    expect(tierFiltered.items).toHaveLength(1);
    expect(tierFiltered.items[0]?.tier).toBe('RETRIEVED_NOT_CITED');
    expect(tierFiltered.tierCounts).toEqual({
      OPENED_NOT_CITED: 1,
      RETRIEVED_NOT_CITED: 1,
      CRAWLED_NOT_CITED: 1,
      MENTIONED_NOT_OWNED: 1,
    });
  });

  it('works cleanly on Day-1 when VisibilityRetrievedSource has 0 rows (returns Tier 3A/3B with hasRawRetrievalSignals=false)', async () => {
    const now = new Date();
    const { service } = buildService({
      retrievedCount: 0,
      retrievedRows: [],
      publishRecords: [
        {
          id: 'pub_fallback',
          publishedUrl: 'https://xingyun.example/blog/day1',
          channel: 'WORDPRESS',
          publishedAt: now,
          latestRetestRunId: 'run_r1',
          afterMetrics: { mentionRate: 0.3, citationHit: false },
          crawlStatus: 'OK',
          crawlCheckedAt: now,
          updatedAt: now,
          article: { id: 'art_day1', title: 'Day1 文章', targetPrompt: '家用NAS推荐' },
          retestSchedules: [
            {
              id: 'sched_day1',
              status: 'COMPLETED',
              milestoneDay: 7,
              dueAt: now,
              visibilityRunId: 'run_r1',
              metricsSnapshotJson: { mentionRate: 0.3, citationHit: false },
              executedAt: now,
            },
          ],
        },
      ],
      observations: [
        {
          id: 'obs_day1',
          brandMarketId: 'bm_cn',
          promptText: '家用NAS推荐',
          answerText: '推荐星云存储作为家用NAS方案。',
          engine: 'perplexity',
          brandMentioned: true,
          brandPassage: '推荐星云存储',
          checkedAt: now,
          createdAt: now,
          citations: [
            {
              id: 'c_day1',
              url: 'https://www.techradar.com/best-nas',
              domain: 'techradar.com',
              title: 'Best NAS',
              snippet: 'Editorial review',
              sourceKind: 'AUTHORITY',
              position: 1,
            },
          ],
        },
      ],
    });

    const res = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, limit: 50 }),
    );
    expect(res.hasRawRetrievalSignals).toBe(false);
    expect(res.tierCounts.OPENED_NOT_CITED).toBe(0);
    expect(res.tierCounts.RETRIEVED_NOT_CITED).toBe(0);
    expect(res.tierCounts.CRAWLED_NOT_CITED).toBe(1);
    expect(res.tierCounts.MENTIONED_NOT_OWNED).toBe(1);
    expect(res.total).toBe(2);
  });

  it('returns empty 200 payload when no opportunities exist', async () => {
    const { service } = buildService({
      retrievedCount: 0,
      retrievedRows: [],
      publishRecords: [],
      observations: [],
    });

    const res = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, limit: 50 }),
    );
    expect(res).toEqual({
      brandId: 'brand_1',
      market: 'CN',
      days: 30,
      total: 0,
      tierCounts: {
        OPENED_NOT_CITED: 0,
        RETRIEVED_NOT_CITED: 0,
        CRAWLED_NOT_CITED: 0,
        MENTIONED_NOT_OWNED: 0,
      },
      hasRawRetrievalSignals: false,
      items: [],
    });
  });

  it('merges http:// and https:// observations of the same page into a single OPENED_NOT_CITED item preferring https://', async () => {
    const now = new Date();
    const { service } = buildService({
      retrievedRows: [
        {
          id: 'rs_http',
          observationId: 'obs_http',
          engine: 'deepseek',
          url: 'http://xingyun.example/guides/scheme-test',
          domain: 'xingyun.example',
          title: 'HTTP 标题',
          snippet: 'HTTP 摘要',
          sourceKind: 'OWNED',
          wasOpened: true,
          wasCited: false,
          rank: 1,
          createdAt: now,
          observation: {
            id: 'obs_http',
            promptText: '家用静音四盘位NAS推荐',
            engine: 'deepseek',
            status: 'SUCCESS',
            checkedAt: now,
            createdAt: now,
          },
        },
        {
          id: 'rs_https',
          observationId: 'obs_https',
          engine: 'doubao',
          url: 'https://xingyun.example/guides/scheme-test',
          domain: 'xingyun.example',
          title: 'HTTPS 标题',
          snippet: null,
          sourceKind: 'OWNED',
          wasOpened: false,
          wasCited: false,
          rank: 3,
          createdAt: now,
          observation: {
            id: 'obs_https',
            promptText: '四盘位NAS静音方案',
            engine: 'doubao',
            status: 'SUCCESS',
            checkedAt: now,
            createdAt: now,
          },
        },
      ],
    });

    const res = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, limit: 50 }),
    );
    expect(res.total).toBe(1);
    expect(res.tierCounts.OPENED_NOT_CITED).toBe(1);
    expect(res.tierCounts.RETRIEVED_NOT_CITED).toBe(0);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      tier: 'OPENED_NOT_CITED',
      url: 'https://xingyun.example/guides/scheme-test',
      openedCount: 1,
      retrievedCount: 2,
      engines: ['deepseek', 'doubao'],
    });
  });

  it('enforces CRAWLED_NOT_CITED exclusion on any citationHit=true schedule or afterMetrics, requires >=1 completed schedule, and prefers non-null executedAt', async () => {
    const now = new Date();
    const olderTs = new Date(now.getTime() - 3 * 86_400_000);
    const newerTs = new Date(now.getTime() - 1 * 86_400_000);

    const { service } = buildService({
      retrievedCount: 0,
      retrievedRows: [],
      runs: [
        { id: 'run_null_sched', engines: ['kimi'] },
        { id: 'run_ts_sched', engines: ['deepseek'] },
      ],
      publishRecords: [
        // 1. Multi-schedule: T+7 had citationHit=true, T+14 had citationHit=false -> MUST be excluded
        {
          id: 'pub_t7_cited',
          publishedUrl: 'https://xingyun.example/blog/t7-cited',
          channel: 'WORDPRESS',
          publishedAt: olderTs,
          latestRetestRunId: 'run_t14',
          afterMetrics: { mentionRate: 0.4, citationHit: false },
          crawlStatus: 'OK',
          crawlCheckedAt: olderTs,
          updatedAt: newerTs,
          article: { id: 'art_t7', title: 'T+7 已引用', targetPrompt: '测试问题 1' },
          retestSchedules: [
            {
              id: 'sched_t14',
              status: 'COMPLETED',
              milestoneDay: 14,
              dueAt: newerTs,
              visibilityRunId: 'run_t14',
              metricsSnapshotJson: { mentionRate: 0.4, citationHit: false },
              executedAt: newerTs,
            },
            {
              id: 'sched_t7',
              status: 'COMPLETED',
              milestoneDay: 7,
              dueAt: olderTs,
              visibilityRunId: 'run_t7',
              metricsSnapshotJson: { mentionRate: 0.9, citationHit: true },
              executedAt: olderTs,
            },
          ],
        },
        // 2. Schedule has citationHit=false, but record.afterMetrics.citationHit===true -> MUST be excluded
        {
          id: 'pub_after_cited',
          publishedUrl: 'https://xingyun.example/blog/after-cited',
          channel: 'WORDPRESS',
          publishedAt: olderTs,
          latestRetestRunId: 'run_manual',
          afterMetrics: { mentionRate: 0.8, citationHit: true },
          crawlStatus: 'OK',
          crawlCheckedAt: olderTs,
          updatedAt: newerTs,
          article: { id: 'art_after', title: '手动复测已引用', targetPrompt: '测试问题 2' },
          retestSchedules: [
            {
              id: 'sched_after_1',
              status: 'COMPLETED',
              milestoneDay: 7,
              dueAt: olderTs,
              visibilityRunId: 'run_sched_1',
              metricsSnapshotJson: { mentionRate: 0.3, citationHit: false },
              executedAt: olderTs,
            },
          ],
        },
        // 3. 0 completed schedules + afterMetrics.citationHit===false -> MUST be excluded
        {
          id: 'pub_zero_schedules',
          publishedUrl: 'https://xingyun.example/blog/zero-schedules',
          channel: 'WORDPRESS',
          publishedAt: olderTs,
          latestRetestRunId: 'run_orphan',
          afterMetrics: { mentionRate: 0.2, citationHit: false },
          crawlStatus: 'OK',
          crawlCheckedAt: olderTs,
          updatedAt: newerTs,
          article: { id: 'art_zero', title: '零完成复测', targetPrompt: '测试问题 3' },
          retestSchedules: [],
        },
        // 4. COMPLETED schedule with executedAt: null ordered ahead of timestamped schedule -> selects timestamped schedule
        {
          id: 'pub_null_exec_first',
          publishedUrl: 'https://xingyun.example/blog/null-exec',
          channel: 'WORDPRESS',
          publishedAt: olderTs,
          latestRetestRunId: 'run_ts_sched',
          afterMetrics: null,
          crawlStatus: 'OK',
          crawlCheckedAt: olderTs,
          updatedAt: olderTs,
          article: { id: 'art_null', title: '含空时间戳复测', targetPrompt: '测试问题 4' },
          retestSchedules: [
            {
              id: 'sched_null_exec',
              status: 'COMPLETED',
              milestoneDay: 14,
              dueAt: newerTs,
              visibilityRunId: 'run_null_sched',
              metricsSnapshotJson: { mentionRate: 0.2, citationHit: false },
              executedAt: null,
            },
            {
              id: 'sched_with_ts',
              status: 'COMPLETED',
              milestoneDay: 7,
              dueAt: olderTs,
              visibilityRunId: 'run_ts_sched',
              metricsSnapshotJson: { mentionRate: 0.35, citationHit: false },
              executedAt: newerTs,
            },
          ],
        },
      ],
    });

    const res = await runInTenant('t_a', () =>
      service.listNearMiss('brand_1', { days: 30, limit: 50 }),
    );
    expect(res.tierCounts.CRAWLED_NOT_CITED).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      tier: 'CRAWLED_NOT_CITED',
      publishRecordId: 'pub_null_exec_first',
      engines: ['deepseek'],
      lastSeenAt: newerTs.toISOString(),
    });
  });
});
