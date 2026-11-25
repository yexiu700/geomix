import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/api-error';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VisibilityCollectorService } from './visibility-collector.service';
import type { VisibilityJudgeService } from './visibility-judge.service';
import {
  MAX_RETRIEVED_SOURCES_PER_OBSERVATION,
  normalizeRetrievedHttpUrl,
  parseRetrievedSourcesFromRawMeta,
  sanitizeObservationRawMeta,
} from './visibility-raw-meta';
import { VisibilityRunRunner } from './visibility-run.runner';

describe('VisibilityRunRunner billing settle rollback (B-01)', () => {
  it('rolls back persisted SUCCESS observation, citations, retrievedSources, rawMetaJson, and doneCount to FAILED when billing.settle throws', async () => {
    const state = {
      runStatus: 'RUNNING',
      doneCount: 0,
      failCount: 0,
      lastError: null as string | null,
      obsStatus: 'PENDING' as 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED',
      answerText: null as string | null,
      rawMetaJson: null as unknown,
      citationsCount: 0,
      retrievedSourcesCount: 0,
    };

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_1',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_cn',
          name: 'Test Run',
          triggerType: 'MANUAL',
          retestArticleId: null,
          status: state.runStatus,
          totalChecks: 1,
          doneCount: state.doneCount,
          failCount: state.failCount,
          unitPrice: 2,
          reservationId: 'res_closed_1',
        })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const d = args.data;
          if (typeof d.status === 'string') state.runStatus = d.status;
          if (d.doneCount && typeof d.doneCount === 'object') {
            const dc = d.doneCount as { increment?: number; decrement?: number };
            if (dc.increment) state.doneCount += dc.increment;
            if (dc.decrement) state.doneCount -= dc.decrement;
          }
          if (d.failCount && typeof d.failCount === 'object') {
            const fc = d.failCount as { increment?: number };
            if (fc.increment) state.failCount += fc.increment;
          }
          if (typeof d.lastError === 'string') state.lastError = d.lastError;
          return {};
        }),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') state.runStatus = args.data.status;
          return { count: 1 };
        }),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => (state.obsStatus === 'PENDING' ? [{ id: 'obs_1' }] : [])),
        findFirst: vi.fn(async (args: { where?: { status?: string } }) => {
          if (args.where?.status && args.where.status !== state.obsStatus) return null;
          return { id: 'obs_1', status: state.obsStatus };
        }),
        count: vi.fn(async () => (state.obsStatus === 'RUNNING' ? 1 : 0)),
        updateMany: vi.fn(
          async (args: {
            where?: { status?: string; checkedAt?: { lt?: Date } };
            data: Record<string, unknown>;
          }) => {
            if (args.where?.status && args.where.status !== state.obsStatus) {
              return { count: 0 };
            }
            if (args.where?.checkedAt?.lt) {
              return { count: 0 };
            }
            if (typeof args.data.status === 'string') {
              state.obsStatus = args.data.status as typeof state.obsStatus;
            }
            return { count: 1 };
          },
        ),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') {
            state.obsStatus = args.data.status as typeof state.obsStatus;
          }
          if ('answerText' in args.data) {
            state.answerText = (args.data.answerText as string | null) ?? null;
          }
          if ('rawMetaJson' in args.data) {
            state.rawMetaJson = args.data.rawMetaJson;
          }
          return {};
        }),
        groupBy: vi.fn(async () => [{ status: state.obsStatus, _count: { _all: 1 } }]),
      },
      visibilityCitation: {
        deleteMany: vi.fn(async () => {
          state.citationsCount = 0;
          return { count: 1 };
        }),
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          state.citationsCount = args.data.length;
          return { count: args.data.length };
        }),
      },
      visibilityRetrievedSource: {
        deleteMany: vi.fn(async () => {
          state.retrievedSourcesCount = 0;
          return { count: 1 };
        }),
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          state.retrievedSourcesCount = args.data.length;
          return { count: args.data.length };
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_1',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_cn',
            name: 'Test Run',
            triggerType: 'MANUAL',
            retestArticleId: null,
            status: state.runStatus,
            unitPrice: 2,
            reservationId: 'res_closed_1',
            brandMarket: {
              id: 'bm_cn',
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: '星辰存储',
              aliases: [],
              ownedDomains: ['star.example'],
              competitors: [],
            },
          })),
        },
        visibilityObservation: {
          findFirst: vi.fn(async () => ({
            id: 'obs_1',
            engine: 'doubao',
            promptText: '家用四盘位 NAS 推荐',
          })),
        },
        pointReservation: {
          findFirst: vi.fn(async () => ({ id: 'res_closed_1', status: 'CLOSED' })),
        },
      },
    } as unknown as PrismaService;

    const billing = {
      settle: vi.fn(async () => {
        throw new ApiError(400, 40001, '冻结单已结单');
      }),
      releaseUnit: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const collector = {
      collect: vi.fn(async () => ({
        collectorKind: 'fake',
        answerText: '星辰存储表现优秀',
        fanOutQueries: ['四盘位 NAS'],
        citations: [{ url: 'https://star.example/nas', title: '星辰', snippet: '实测' }],
        rawMeta: {
          provider: 'sonargate',
          latencyMs: 420,
          retrievedSources: [
            { url: 'https://star.example/nas', opened: true, rank: 1 },
            { url: 'https://star.example/spec-sheet', opened: true, rank: 2 },
          ],
          openedPages: ['https://star.example/spec-sheet'],
        },
      })),
    } as unknown as VisibilityCollectorService;

    const judge = {
      evaluate: vi.fn(async () => ({
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage: '星辰存储表现优秀',
        competitorHits: [],
        judgeModel: 'fake',
        tokensIn: 10,
        tokensOut: 10,
      })),
    } as unknown as VisibilityJudgeService;

    const runner = new VisibilityRunRunner(prisma, billing, collector, judge);
    await runner.process({ tenantId: 'tenant_a', runId: 'run_1' });

    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(state.obsStatus).toBe('FAILED');
    expect(state.answerText).toBeNull();
    expect(state.citationsCount).toBe(0);
    expect(state.retrievedSourcesCount).toBe(0);
    expect(state.rawMetaJson).toBe(Prisma.DbNull);
    expect(state.doneCount).toBe(0);
    expect(state.failCount).toBe(1);
    expect(state.runStatus).toBe('FAILED');
  });

  it('S-03: fires completeHooks on FAILED RETEST run (0 successes) so linked RUNNING GeoRetestSchedule transitions to FAILED', async () => {
    const state = {
      runStatus: 'RUNNING',
      doneCount: 0,
      failCount: 0,
      lastError: 'SonarGate upstream timeout',
      obsStatus: 'PENDING' as 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED',
    };

    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_retest_fail_1',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_cn',
          name: 'Scheduled Retest',
          triggerType: 'RETEST',
          retestArticleId: 'art_1',
          status: state.runStatus,
          totalChecks: 1,
          doneCount: state.doneCount,
          failCount: state.failCount,
          unitPrice: 2,
          reservationId: null,
          finishedAt: null,
          lastError: state.lastError,
        })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') state.runStatus = args.data.status;
          if (typeof args.data.lastError === 'string') state.lastError = args.data.lastError;
          if (args.data.failCount && typeof args.data.failCount === 'object') {
            const fc = args.data.failCount as { increment?: number };
            if (fc.increment) state.failCount += fc.increment;
          }
          return {};
        }),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') state.runStatus = args.data.status;
          return { count: 1 };
        }),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => (state.obsStatus === 'PENDING' ? [{ id: 'obs_1' }] : [])),
        findFirst: vi.fn(async (args: { where?: { status?: string } }) => {
          if (args.where?.status && args.where.status !== state.obsStatus) return null;
          return { id: 'obs_1', status: state.obsStatus };
        }),
        count: vi.fn(async (args?: { where?: { status?: string } }) =>
          args?.where?.status === state.obsStatus ? 1 : 0,
        ),
        updateMany: vi.fn(
          async (args: {
            where?: { status?: string; checkedAt?: { lt?: Date } };
            data: Record<string, unknown>;
          }) => {
            if (args.where?.status && args.where.status !== state.obsStatus) return { count: 0 };
            if (args.where?.checkedAt?.lt) return { count: 0 };
            if (typeof args.data.status === 'string') {
              state.obsStatus = args.data.status as typeof state.obsStatus;
            }
            return { count: 1 };
          },
        ),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') {
            state.obsStatus = args.data.status as typeof state.obsStatus;
          }
          return {};
        }),
        groupBy: vi.fn(async () => [{ status: state.obsStatus, _count: { _all: 1 } }]),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_retest_fail_1',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_cn',
            name: 'Scheduled Retest',
            triggerType: 'RETEST',
            retestArticleId: 'art_1',
            status: state.runStatus,
            unitPrice: 2,
            reservationId: null,
            brandMarket: {
              id: 'bm_cn',
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: '星辰存储',
              aliases: [],
              ownedDomains: ['star.example'],
              competitors: [],
            },
          })),
        },
        visibilityObservation: {
          findFirst: vi.fn(async () => ({
            id: 'obs_1',
            engine: 'doubao',
            promptText: '家用四盘位 NAS 推荐',
          })),
        },
        pointReservation: {
          findFirst: vi.fn(async () => null),
        },
      },
    } as unknown as PrismaService;

    const billing = {
      settle: vi.fn(async () => undefined),
      releaseUnit: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const collector = {
      collect: vi.fn(async () => {
        throw new Error('SonarGate upstream timeout');
      }),
    } as unknown as VisibilityCollectorService;

    const judge = {
      evaluate: vi.fn(),
    } as unknown as VisibilityJudgeService;

    const hookEvents: Array<Record<string, unknown>> = [];
    const runner = new VisibilityRunRunner(prisma, billing, collector, judge);
    runner.registerCompleteHook({
      name: 'recording-retest-hook',
      onVisibilityRunComplete(evt) {
        hookEvents.push(evt as unknown as Record<string, unknown>);
      },
    });

    await runner.process({ tenantId: 'tenant_a', runId: 'run_retest_fail_1' });

    expect(state.runStatus).toBe('FAILED');
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toEqual({
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      runId: 'run_retest_fail_1',
      triggerType: 'RETEST',
      retestArticleId: 'art_1',
      status: 'FAILED',
      successCount: 0,
    });
  });
});

describe('Visibility rawMeta sanitization & retrievedSources parsing (#368)', () => {
  it('strictly whitelists the 5 allowed rawMetaJson keys and drops secrets/invalid values', () => {
    expect(sanitizeObservationRawMeta(undefined)).toBeNull();
    expect(sanitizeObservationRawMeta(null)).toBeNull();
    expect(sanitizeObservationRawMeta('raw-string')).toBeNull();
    expect(sanitizeObservationRawMeta([1, 2, 3])).toBeNull();
    expect(sanitizeObservationRawMeta({ apiKey: 'secret', retrievedSources: [] })).toBeNull();

    expect(
      sanitizeObservationRawMeta({
        provider: '  sonargate\u0000-v2  ',
        aiOverviewTriggered: true,
        serverToolSearchCount: 3.9,
        serverToolFetchCount: 2,
        latencyMs: 842.6,
        apiKey: 'sk-secret',
        cookies: 'session=abc',
        retrievedSources: ['https://example.com'],
        openedPages: ['https://example.com'],
      }),
    ).toEqual({
      provider: 'sonargate-v2',
      aiOverviewTriggered: true,
      serverToolSearchCount: 3,
      serverToolFetchCount: 2,
      latencyMs: 843,
    });

    expect(
      sanitizeObservationRawMeta({
        provider: '   ',
        aiOverviewTriggered: 'yes',
        serverToolSearchCount: -1,
        serverToolFetchCount: Number.NaN,
        latencyMs: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it('merges retrievedSources and openedPages, deduplicates URLs, computes wasCited and sourceKind', () => {
    const parsed = parseRetrievedSourcesFromRawMeta(
      {
        retrievedSources: [
          {
            url: 'https://www.Star.Example/guides/nas/?utm_source=ai#top',
            title: '星辰 NAS 官方指南',
            snippet: '实测静音表现',
            opened: false,
            rank: 1,
          },
          {
            url: 'https://star.example/near-miss/specs',
            title: '星辰规格页',
            opened: false,
            rank: 2,
          },
          'https://zhuanlan.zhihu.com/p/123456',
          {
            url: 'https://comp.example/review',
            description: '竞品横评',
            wasOpened: true,
            position: 4,
          },
          { url: 'javascript:alert(1)' },
          { url: 'http://localhost:3000/internal' },
          null,
          42,
        ],
        openedPages: [
          'https://star.example/near-miss/specs?utm_medium=search',
          {
            url: 'https://36kr.com/p/opened-only',
            title: '36氪行业评测',
            snippet: '仅出现在 openedPages 的正文',
          },
        ],
      },
      {
        citations: [{ url: 'http://star.example/guides/nas' }],
        ownedDomains: ['star.example'],
        competitorDomains: ['comp.example'],
      },
    );

    expect(parsed).toHaveLength(5);

    const citedOwned = parsed.find((item) => item.url.includes('/guides/nas'));
    expect(citedOwned).toMatchObject({
      domain: 'star.example',
      sourceKind: 'OWNED',
      wasOpened: false,
      wasCited: true,
      rank: 1,
    });

    const upgradedOwned = parsed.find((item) => item.url.includes('/near-miss/specs'));
    expect(upgradedOwned).toMatchObject({
      domain: 'star.example',
      sourceKind: 'OWNED',
      wasOpened: true,
      wasCited: false,
      rank: 2,
    });

    const zhihuRow = parsed.find((item) => item.domain === 'zhuanlan.zhihu.com');
    expect(zhihuRow).toMatchObject({
      sourceKind: 'SOCIAL',
      wasOpened: false,
      wasCited: false,
      rank: 3,
    });

    const compRow = parsed.find((item) => item.domain === 'comp.example');
    expect(compRow).toMatchObject({
      sourceKind: 'COMPETITOR',
      snippet: '竞品横评',
      wasOpened: true,
      wasCited: false,
      rank: 4,
    });

    const openedOnly = parsed.find((item) => item.domain === '36kr.com');
    expect(openedOnly).toMatchObject({
      title: '36氪行业评测',
      snippet: '仅出现在 openedPages 的正文',
      wasOpened: true,
      wasCited: false,
      rank: null,
    });
  });

  it('rejects private/reserved/metadata IP literals, internal hostnames, and credentialed URLs in normalizeRetrievedHttpUrl', () => {
    const blockedVectors = [
      'http://127.0.0.1/secret',
      'http://127.0.0.1:8080/secret',
      'http://2130706433/secret',
      'http://10.0.0.1/internal',
      'http://172.16.0.1/internal',
      'http://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/admin',
      'http://100.64.0.1/cgnat',
      'http://[::1]/secret',
      'http://[::ffff:127.0.0.1]/secret',
      'http://localhost/admin',
      'http://foo.localhost/secret',
      'http://printer.local/admin',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://router.home.arpa/status',
      'https://user:pass@example.com/secret',
      'https://user@example.com/secret',
    ];

    for (const url of blockedVectors) {
      expect(normalizeRetrievedHttpUrl(url), `expected rejected: ${url}`).toBeNull();
    }

    const valid = normalizeRetrievedHttpUrl('https://www.Example.com/guide/?utm_source=ai#top');
    expect(valid).toEqual({
      url: 'https://www.example.com/guide/',
      domain: 'example.com',
      matchKey: 'example.com/guide',
    });

    const parsed = parseRetrievedSourcesFromRawMeta(
      {
        retrievedSources: [
          ...blockedVectors.map((url) => ({ url, opened: true })),
          { url: 'http://example.com/guide', opened: false },
        ],
        openedPages: ['https://example.com/guide'],
      },
      { citations: [], ownedDomains: ['example.com'], competitorDomains: [] },
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      url: 'https://example.com/guide',
      domain: 'example.com',
      wasOpened: true,
    });
  });

  it('caps retrievedSources strictly at 100 rows per observation while prioritizing opened rows on overflow', () => {
    const retrievedSources = Array.from({ length: 130 }, (_, idx) => ({
      url: `https://candidate-${idx + 1}.example.com/article`,
      title: `Candidate ${idx + 1}`,
      opened: false,
      rank: idx + 1,
    }));
    const openedPages = [
      'https://candidate-125.example.com/article',
      'https://opened-extra.example.com/deep-dive',
    ];

    const parsed = parseRetrievedSourcesFromRawMeta(
      { retrievedSources, openedPages },
      {
        citations: [],
        ownedDomains: ['opened-extra.example.com'],
        competitorDomains: [],
      },
    );

    expect(parsed).toHaveLength(MAX_RETRIEVED_SOURCES_PER_OBSERVATION);
    expect(
      parsed.some((r) => r.url === 'https://candidate-125.example.com/article' && r.wasOpened),
    ).toBe(true);
    expect(
      parsed.some(
        (r) =>
          r.url === 'https://opened-extra.example.com/deep-dive' &&
          r.wasOpened &&
          r.sourceKind === 'OWNED',
      ),
    ).toBe(true);
  });

  it('gracefully handles malformed rawMeta without throwing or failing observation save', async () => {
    let savedRawMeta: unknown = 'UNSET';
    let savedRetrieved: unknown[] = [];

    const obsState = { status: 'PENDING' as 'PENDING' | 'RUNNING' | 'SUCCESS' };
    const tx = {
      visibilityRun: {
        findFirst: vi.fn(async () => ({
          id: 'run_malformed',
          tenantId: 'tenant_a',
          brandId: 'brand_a',
          brandMarketId: 'bm_cn',
          name: 'Malformed Meta Run',
          triggerType: 'MANUAL',
          retestArticleId: null,
          status: 'RUNNING',
          totalChecks: 1,
          doneCount: obsState.status === 'SUCCESS' ? 1 : 0,
          failCount: 0,
          unitPrice: 2,
          reservationId: null,
          finishedAt: null,
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      visibilityObservation: {
        findMany: vi.fn(async () => (obsState.status === 'PENDING' ? [{ id: 'obs_m1' }] : [])),
        findFirst: vi.fn(async () => ({ id: 'obs_m1', status: obsState.status })),
        count: vi.fn(async () => (obsState.status === 'RUNNING' ? 1 : 0)),
        updateMany: vi.fn(
          async (args: {
            where?: { status?: string; checkedAt?: { lt?: Date } };
            data: Record<string, unknown>;
          }) => {
            if (args.where?.checkedAt?.lt) return { count: 0 };
            if (args.where?.status && args.where.status !== obsState.status) return { count: 0 };
            if (typeof args.data.status === 'string') {
              obsState.status = args.data.status as typeof obsState.status;
            }
            return { count: 1 };
          },
        ),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (typeof args.data.status === 'string') {
            obsState.status = args.data.status as typeof obsState.status;
          }
          savedRawMeta = args.data.rawMetaJson;
          return {};
        }),
        groupBy: vi.fn(async () => [{ status: obsState.status, _count: { _all: 1 } }]),
      },
      visibilityCitation: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      visibilityRetrievedSource: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          savedRetrieved = args.data;
          return { count: args.data.length };
        }),
      },
    };

    const prisma = {
      base: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        visibilityRun: {
          findFirst: vi.fn(async () => ({
            id: 'run_malformed',
            tenantId: 'tenant_a',
            brandId: 'brand_a',
            brandMarketId: 'bm_cn',
            name: 'Malformed Meta Run',
            triggerType: 'MANUAL',
            retestArticleId: null,
            status: 'RUNNING',
            unitPrice: 2,
            reservationId: null,
            brandMarket: {
              id: 'bm_cn',
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: '星辰存储',
              aliases: [],
              ownedDomains: ['star.example'],
              competitors: [],
            },
          })),
        },
        visibilityObservation: {
          findFirst: vi.fn(async () => ({
            id: 'obs_m1',
            engine: 'deepseek',
            promptText: '家用四盘位 NAS 推荐',
          })),
        },
        pointReservation: { findFirst: vi.fn(async () => null) },
      },
    } as unknown as PrismaService;

    const billing = {
      settle: vi.fn(async () => undefined),
      releaseUnit: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as BillingService;

    const collector = {
      collect: vi.fn(async () => ({
        collectorKind: 'remote_scraper',
        answerText: '星辰存储实测静音',
        fanOutQueries: [],
        citations: [],
        rawMeta: {
          retrievedSources: 'not-an-array',
          openedPages: { bad: true },
          latencyMs: 'not-a-number',
        } as unknown as Record<string, unknown>,
      })),
    } as unknown as VisibilityCollectorService;

    const judge = {
      evaluate: vi.fn(async () => ({
        brandMentioned: true,
        brandPosition: 1,
        brandSentiment: 'positive',
        brandPassage: '星辰存储实测静音',
        competitorHits: [],
        judgeModel: 'fake',
        tokensIn: 10,
        tokensOut: 10,
      })),
    } as unknown as VisibilityJudgeService;

    const runner = new VisibilityRunRunner(prisma, billing, collector, judge);
    await runner.process({ tenantId: 'tenant_a', runId: 'run_malformed' });

    expect(obsState.status).toBe('SUCCESS');
    expect(savedRawMeta).toBe(Prisma.DbNull);
    expect(savedRetrieved).toEqual([]);
    expect(tx.visibilityRetrievedSource.createMany).not.toHaveBeenCalled();
  });
});
