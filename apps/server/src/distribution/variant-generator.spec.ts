import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  containsCjk,
  evaluateDistributionPreflight,
  type ChannelProvider,
  type DistributionTemplateKey,
  type GeoMarket,
} from '@geomix/shared';
import type { BillingService, ReservationView } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import { LlmService } from '../infra/llm';
import { ProviderError, PROVIDER_KIND } from '../infra/provider-error';
import type { PrismaService } from '../prisma/prisma.service';
import {
  VariantGeneratorService,
  presentDistributionTask,
  readGeoVariantFreeRateLimit,
  type GeoDistributionTaskRow,
} from './variant-generator.service';
import {
  VariantGlobalCjkLeakError,
  buildDeterministicFakeVariantDraft,
  buildVariantPromptMessages,
  finalizeRealLlmVariantDraft,
  normalizeVariantMetaDesc,
  normalizeVariantSlug,
  resolveVariantTemplateKey,
  sliceUtf16Safe,
  stripRedditPromotionalCtas,
  type DistributionVariantExtras,
  type VariantPromptContext,
} from './variant-templates';

function makePromptCtx(overrides: Partial<VariantPromptContext> = {}): VariantPromptContext {
  const market: GeoMarket = overrides.market ?? 'GLOBAL';
  const provider: ChannelProvider = overrides.provider ?? 'SHOPIFY';
  const templateKey: DistributionTemplateKey =
    overrides.templateKey ?? resolveVariantTemplateKey({ provider });

  return {
    market,
    locale: overrides.locale ?? (market === 'GLOBAL' ? 'en-US' : 'zh-CN'),
    brandName: overrides.brandName ?? (market === 'GLOBAL' ? '星云存储' : '星云存储'),
    localBrandName: overrides.localBrandName ?? (market === 'GLOBAL' ? 'NebulaNAS' : '星云存储'),
    brandAliases: overrides.brandAliases ?? (market === 'GLOBAL' ? ['Nebula'] : ['星云']),
    category: overrides.category ?? (market === 'GLOBAL' ? 'Home NAS' : '家用 NAS'),
    localCategory: overrides.localCategory ?? (market === 'GLOBAL' ? 'Home NAS' : '家用 NAS'),
    ownedDomains: overrides.ownedDomains ?? ['nebulanas.example.com'],
    competitors: overrides.competitors ?? ['Synology', 'QNAP'],
    articleTitle:
      overrides.articleTitle ??
      (market === 'GLOBAL'
        ? '2026 Best Quiet 4-Bay Home NAS Guide: NebulaNAS vs Synology'
        : '2026 家用静音四盘位 NAS 选购与实测参数对比指南'),
    targetPrompt:
      overrides.targetPrompt ??
      (market === 'GLOBAL'
        ? 'Best quiet 4-bay home NAS 2026'
        : '2026 静音省电的四盘位家用 NAS 推荐'),
    masterMarkdown:
      overrides.masterMarkdown ??
      (market === 'GLOBAL'
        ? [
            '## Direct Answer',
            '',
            'NebulaNAS N4 operates at 21 dB under load and draws 9W at idle, making it a strong quiet 4-bay home NAS choice compared with Synology.',
            '',
            '| Metric | NebulaNAS N4 | Synology Reference |',
            '| --- | --- | --- |',
            '| Load Noise | 21 dB | 25 dB |',
            '| Idle Power | 9 W | 13 W |',
          ].join('\n')
        : [
            '## 首段核心结论',
            '',
            '星云存储 N4 满载实测噪音 21dB，待机功耗 9W，适合客厅与卧室部署的四盘位家用 NAS。',
            '',
            '| 参数维度 | 星云存储 N4 | 竞品参考 |',
            '| --- | --- | --- |',
            '| 满载噪音 | 21 dB | 25 dB |',
            '| 待机功耗 | 9 W | 13 W |',
          ].join('\n')),
    articleSchemaJsonLd: overrides.articleSchemaJsonLd ?? null,
    articleLlmsTxtSnippet: overrides.articleLlmsTxtSnippet ?? null,
    facts: overrides.facts ?? [
      {
        id: 'fact_1',
        slot: 'PRODUCT_SPECS',
        title: market === 'GLOBAL' ? 'Acoustic & Power Benchmarks' : '噪音与功耗实测',
        content:
          market === 'GLOBAL'
            ? '21 dB load acoustic rating, 9W idle power consumption, dual 2.5GbE ports.'
            : '满载运行噪音 21dB，待机功耗 9W，配备双 2.5G 网口。',
      },
      {
        id: 'fact_2',
        slot: 'CREDENTIALS',
        title: market === 'GLOBAL' ? 'Lab Certification' : '实验室认证',
        content:
          market === 'GLOBAL'
            ? 'ISO 7779 acoustic chamber verified; 3-year hardware warranty.'
            : '通过 ISO 7779 静音暗室检测，提供 3 年整机质保。',
      },
    ],
    targetFanOuts: overrides.targetFanOuts ?? [
      market === 'GLOBAL' ? 'quiet 4-bay NAS noise level' : '家用四盘位NAS噪音实测',
      market === 'GLOBAL' ? 'home NAS idle power consumption' : '家用NAS待机功耗对比',
    ],
    competitorFocus: overrides.competitorFocus ?? ['Synology', 'QNAP'],
    citedExampleUrls: overrides.citedExampleUrls ?? [
      'https://www.reddit.com/r/HomeServer/comments/abc123/best_quiet_4bay_nas/',
    ],
    provider,
    templateKey,
    channelLabel: overrides.channelLabel ?? 'Shopify Blog',
    targetUrlHint: overrides.targetUrlHint ?? null,
    customToneNote: overrides.customToneNote ?? null,
    customForbiddenWords: overrides.customForbiddenWords ?? [],
  };
}

function makeHarness(options?: {
  market?: GeoMarket;
  article?: Record<string, unknown> | null;
  connections?: Record<string, Record<string, unknown>>;
  unitPrice?: number;
  shadow?: boolean;
  llm?: LlmService;
  rateLimiter?: FreeActionRateLimiter;
  settleErrorOnCall?: number;
}) {
  const market: GeoMarket = options?.market ?? 'GLOBAL';
  const storedTasks = new Map<string, GeoDistributionTaskRow>();
  let taskSeq = 0;

  const defaultArticle = {
    id: 'art_1',
    tenantId: 't_1',
    brandId: 'b_1',
    brandMarketId: 'bm_1',
    title:
      market === 'GLOBAL'
        ? '2026 Best Quiet 4-Bay Home NAS Guide: NebulaNAS vs Synology'
        : '2026 家用静音四盘位 NAS 选购与实测参数对比指南',
    targetPrompt:
      market === 'GLOBAL' ? 'Best quiet 4-bay home NAS 2026' : '2026 四盘位家用 NAS 推荐',
    contentMarkdown:
      market === 'GLOBAL'
        ? 'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.'
        : '星云存储 N4 满载实测噪音 21dB，待机功耗 9W，配备双 2.5G 网口。',
    schemaJsonLd: {},
    llmsTxtSnippet: null,
    geoScore: 86,
    brand: {
      id: 'b_1',
      name: '星云存储',
      category: market === 'GLOBAL' ? 'Home NAS' : '家用 NAS',
    },
    brandMarket: {
      id: 'bm_1',
      market,
      locale: market === 'GLOBAL' ? 'en-US' : 'zh-CN',
      localBrandName: market === 'GLOBAL' ? 'NebulaNAS' : '星云存储',
      localCategory: market === 'GLOBAL' ? 'Home NAS' : '家用 NAS',
      aliases: market === 'GLOBAL' ? ['Nebula'] : ['星云'],
      ownedDomains: ['nebulanas.example.com'],
      competitors: [{ name: 'Synology' }, { name: 'QNAP' }],
    },
    brief: {
      id: 'br_1',
      targetFanOuts:
        market === 'GLOBAL'
          ? ['quiet 4-bay NAS noise level', 'home NAS idle power']
          : ['家用NAS噪音', '待机功耗'],
      competitorFocus: ['Synology', 'QNAP'],
      matchedFactIds: ['fact_1'],
      recommendedChannels: [
        {
          channel: 'Reddit',
          reason: 'Cited 3 times',
          providerHint: 'REDDIT_ASSIST',
          priority: 'HIGH',
          citedExampleUrls: ['https://www.reddit.com/r/HomeServer/comments/abc123/nas_thread/'],
        },
        {
          channel: 'Quora',
          reason: 'Cited 1 time',
          providerHint: 'QUORA_ASSIST',
          priority: 'MEDIUM',
          citedExampleUrls: ['https://www.quora.com/What-is-the-quietest-4-bay-NAS'],
        },
      ],
    },
  };

  const articleRow = options?.article === undefined ? defaultArticle : options.article;
  const connectionsMap = options?.connections ?? {
    conn_shopify: {
      id: 'conn_shopify',
      brandId: 'b_1',
      brandMarketId: 'bm_1',
      provider: 'SHOPIFY',
      displayName: 'Nebula Shopify Blog',
      status: 'ACTIVE',
      configJson: { defaultPublishAsDraft: true },
    },
  };

  const prismaStub = {
    scoped: {
      geoArticle: {
        findFirst: vi.fn().mockResolvedValue(articleRow),
      },
      channelConnection: {
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          return connectionsMap[where.id] ?? null;
        }),
      },
      brandFact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'fact_1',
            slot: 'PRODUCT_SPECS',
            title: market === 'GLOBAL' ? 'Acoustic & Power' : '噪音与功耗',
            content:
              market === 'GLOBAL'
                ? '21 dB load noise, 9W idle power, dual 2.5GbE.'
                : '满载噪音 21dB，待机功耗 9W，双 2.5G 网口。',
          },
        ]),
      },
      promptPreference: {
        findFirst: vi.fn().mockResolvedValue({
          customToneNote: null,
          customForbiddenWords: [],
        }),
      },
      geoDistributionTask: {
        findMany: vi
          .fn()
          .mockImplementation(
            async ({ where }: { where: { articleId: string; id?: { in?: string[] } } }) => {
              const ids = where.id?.in ?? [];
              return [...storedTasks.values()].filter(
                (row) => row.articleId === where.articleId && ids.includes(row.id),
              );
            },
          ),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          taskSeq += 1;
          const now = new Date();
          const id = typeof data.id === 'string' ? data.id : `gdt_auto_${taskSeq}`;
          const row: GeoDistributionTaskRow = {
            id,
            tenantId: String(data.tenantId),
            brandId: String(data.brandId),
            brandMarketId: String(data.brandMarketId),
            articleId: String(data.articleId),
            connectionId: (data.connectionId as string | null) ?? null,
            provider: String(data.provider),
            mode: String(data.mode),
            channelLabel: String(data.channelLabel),
            targetUrlHint: (data.targetUrlHint as string | null) ?? null,
            variantTitle: String(data.variantTitle),
            variantSlug: (data.variantSlug as string | null) ?? null,
            variantMetaDesc: (data.variantMetaDesc as string | null) ?? null,
            variantMarkdown: String(data.variantMarkdown),
            variantHtml: String(data.variantHtml),
            variantExtrasJson:
              data.variantExtrasJson as GeoDistributionTaskRow['variantExtrasJson'],
            preflightJson: (data.preflightJson ?? null) as GeoDistributionTaskRow['preflightJson'],
            status: String(data.status ?? 'DRAFT_VARIANT'),
            publishAsDraft: Boolean(data.publishAsDraft ?? true),
            remotePostId: null,
            remoteAdminUrl: null,
            remotePublishedUrl: null,
            indexNowStatus: null,
            lastError: null,
            shareTokenHash: null,
            shareExpiresAt: null,
            shareRevokedAt: null,
            publishedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          storedTasks.set(row.id, row);
          return row;
        }),
        delete: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          const existing = storedTasks.get(where.id);
          storedTasks.delete(where.id);
          return existing;
        }),
      },
      geoVariantJob: (() => {
        const storedJobs = new Map<string, Record<string, unknown>>();
        let jobSeq = 0;
        const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(where)) {
            if (v === undefined) continue;
            if (k === 'status' && v && typeof v === 'object' && 'in' in v) {
              if (!(v as { in: string[] }).in.includes(String(row.status))) return false;
              continue;
            }
            if (row[k] !== v) return false;
          }
          return true;
        };
        return {
          _store: storedJobs,
          findFirst: vi
            .fn()
            .mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
              for (const row of storedJobs.values()) {
                if (matchWhere(row, where)) return { ...row };
              }
              return null;
            }),
          findMany: vi
            .fn()
            .mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
              return [...storedJobs.values()]
                .filter((row) => matchWhere(row, where))
                .map((r) => ({ ...r }));
            }),
          create: vi
            .fn()
            .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
              for (const existing of storedJobs.values()) {
                if (
                  data.idempotencyKey &&
                  existing.tenantId === data.tenantId &&
                  existing.articleId === data.articleId &&
                  existing.idempotencyKey === data.idempotencyKey
                ) {
                  throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
                }
              }
              jobSeq += 1;
              const now = new Date();
              const row: Record<string, unknown> = {
                id: typeof data.id === 'string' ? data.id : `gvj_${jobSeq}`,
                tenantId: data.tenantId,
                brandId: data.brandId,
                brandMarketId: data.brandMarketId,
                articleId: data.articleId,
                idempotencyKey: data.idempotencyKey ?? null,
                requestFingerprint: data.requestFingerprint ?? null,
                targetsJson: data.targetsJson,
                status: data.status ?? 'QUEUED',
                total: data.total ?? 0,
                doneCount: data.doneCount ?? 0,
                failCount: data.failCount ?? 0,
                unitPrice: data.unitPrice ?? 0,
                totalChargedPoints: data.totalChargedPoints ?? 0,
                refundedCount: data.refundedCount ?? 0,
                refundedPoints: data.refundedPoints ?? 0,
                reservationId: data.reservationId ?? null,
                billingMode: data.billingMode ?? 'SHADOW',
                taskIds: data.taskIds ?? [],
                failuresJson: data.failuresJson ?? [],
                lastError: data.lastError ?? null,
                finishedAt: data.finishedAt ?? null,
                createdAt: now,
                updatedAt: now,
              };
              storedJobs.set(String(row.id), row);
              return { ...row };
            }),
          update: vi
            .fn()
            .mockImplementation(
              async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const existing = storedJobs.get(where.id);
                if (!existing) throw new Error(`Job ${where.id} not found`);
                const next = { ...existing, ...data, updatedAt: new Date() };
                storedJobs.set(where.id, next);
                return { ...next };
              },
            ),
          updateMany: vi
            .fn()
            .mockImplementation(
              async ({
                where,
                data,
              }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
              }) => {
                let count = 0;
                for (const [id, row] of storedJobs.entries()) {
                  if (matchWhere(row, where)) {
                    storedJobs.set(id, { ...row, ...data, updatedAt: new Date() });
                    count += 1;
                  }
                }
                return { count };
              },
            ),
        };
      })(),
    },
  } as unknown as PrismaService;

  const reservationState: ReservationView = {
    id: 'res_gv_1',
    tenantId: 't_1',
    refType: 'geo_variant',
    refId: 'gv_test',
    shadow: options?.shadow ?? false,
    frozen: 0,
    settled: 0,
    released: 0,
    status: 'OPEN',
  };

  let settleCalls = 0;
  const billingStub = {
    unitPrice: vi.fn().mockResolvedValue(options?.unitPrice ?? 2),
    reserve: vi
      .fn()
      .mockImplementation(async ({ amount, refId }: { amount: number; refId: string }) => {
        reservationState.frozen = amount;
        reservationState.refId = refId;
        reservationState.settled = 0;
        reservationState.released = 0;
        reservationState.status = 'OPEN';
        return { ...reservationState };
      }),
    settle: vi.fn().mockImplementation(async ({ amount }: { amount: number }) => {
      settleCalls += 1;
      if (options?.settleErrorOnCall === settleCalls) {
        throw new Error('simulated_settle_failure');
      }
      reservationState.settled += amount;
      return { reservation: { ...reservationState }, lines: [], replayed: false };
    }),
    releaseUnit: vi.fn().mockImplementation(async ({ amount }: { amount: number }) => {
      reservationState.released += amount;
      return { reservation: { ...reservationState }, lines: [], replayed: false };
    }),
    close: vi.fn().mockImplementation(async () => {
      const pending = Math.max(
        0,
        reservationState.frozen - reservationState.settled - reservationState.released,
      );
      reservationState.released += pending;
      reservationState.status = 'CLOSED';
      return { reservation: { ...reservationState }, releasedNow: pending };
    }),
  } as unknown as BillingService;

  const llm = options?.llm ?? LlmService.fromEnv({ LLM_PROVIDERS: '{}' });
  const compliance = new ComplianceService();
  const rateLimiter = options?.rateLimiter ?? new FreeActionRateLimiter();
  const enqueuedVariantJobs: Array<{ tenantId: string; jobId: string }> = [];
  const variantEnqueuer = {
    enqueueVariantJob: vi.fn(async (data: { tenantId: string; jobId: string }) => {
      enqueuedVariantJobs.push(data);
    }),
  };

  const service = new VariantGeneratorService(
    prismaStub,
    billingStub,
    llm,
    compliance,
    rateLimiter,
    variantEnqueuer,
  );

  return {
    service,
    prismaStub,
    billingStub,
    llm,
    compliance,
    rateLimiter,
    storedTasks,
    reservationState,
    variantEnqueuer,
    enqueuedVariantJobs,
  };
}

describe('variant-templates & VariantGeneratorService (M3 / Issue #351)', () => {
  const originalBillingMode = process.env.BILLING_MODE;
  const originalFreeMax = process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX;
  const originalFreeWindow = process.env.GEO_VARIANT_FREE_RATE_LIMIT_WINDOW_SECONDS;

  afterEach(() => {
    if (originalBillingMode === undefined) delete process.env.BILLING_MODE;
    else process.env.BILLING_MODE = originalBillingMode;

    if (originalFreeMax === undefined) delete process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX;
    else process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX = originalFreeMax;

    if (originalFreeWindow === undefined)
      delete process.env.GEO_VARIANT_FREE_RATE_LIMIT_WINDOW_SECONDS;
    else process.env.GEO_VARIANT_FREE_RATE_LIMIT_WINDOW_SECONDS = originalFreeWindow;

    vi.restoreAllMocks();
  });

  it('builds grounded prompts and deterministic fake drafts for all 6 templates with strict market isolation', () => {
    const cases: Array<{
      provider: ChannelProvider;
      templateKey: DistributionTemplateKey;
      market: GeoMarket;
    }> = [
      { provider: 'SHOPIFY', templateKey: 'OWNED_BLOG_SEO_GEO', market: 'GLOBAL' },
      { provider: 'REDDIT_ASSIST', templateKey: 'REDDIT_DISCUSSION', market: 'GLOBAL' },
      { provider: 'QUORA_ASSIST', templateKey: 'QUORA_ANSWER', market: 'GLOBAL' },
      { provider: 'SOCIAL_THREAD_ASSIST', templateKey: 'SOCIAL_THREAD', market: 'GLOBAL' },
      { provider: 'PR_PACKET', templateKey: 'PR_MEDIA_PACKET', market: 'GLOBAL' },
      { provider: 'CN_COMMUNITY_ASSIST', templateKey: 'CN_COMMUNITY_QA', market: 'CN' },
    ];

    for (const tc of cases) {
      const ctx = makePromptCtx({
        market: tc.market,
        provider: tc.provider,
        templateKey: tc.templateKey,
        channelLabel: tc.provider,
      });

      const messages = buildVariantPromptMessages(ctx);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toContain('SINGLE SOURCE OF TRUTH');
      expect(messages[0]!.content).toContain('NEVER fabricate');
      expect(messages[1]!.content).toContain(ctx.articleTitle);

      const draft = buildDeterministicFakeVariantDraft(ctx);
      expect(draft.templateKey).toBe(tc.templateKey);
      expect(draft.variantExtrasJson.templateKey).toBe(tc.templateKey);
      expect(draft.variantHtml.length).toBeGreaterThan(20);

      if (tc.market === 'GLOBAL') {
        expect(containsCjk(draft.variantTitle)).toBe(false);
        expect(containsCjk(draft.variantMarkdown)).toBe(false);
        expect(containsCjk(draft.variantHtml)).toBe(false);
        const preflight = evaluateDistributionPreflight({
          market: 'GLOBAL',
          title: draft.variantTitle,
          contentMarkdown: draft.variantMarkdown,
          brandNames: ['NebulaNAS', '星云存储'],
          geoScore: 85,
          matchedFactCount: 2,
          provider: tc.provider,
          variantSlug: draft.variantSlug,
          variantMetaDesc: draft.variantMetaDesc,
        });
        expect(preflight.ok).toBe(true);
        expect(preflight.blockers).toEqual([]);
        expect(preflight.warnings).toEqual([]);
      }

      if (tc.templateKey === 'OWNED_BLOG_SEO_GEO') {
        expect(draft.variantSlug).toMatch(/^[a-z0-9-]+$/);
        expect(draft.variantSlug!.length).toBeLessThanOrEqual(160);
        expect(draft.variantMetaDesc).not.toBeNull();
        expect(draft.variantMetaDesc!.length).toBeGreaterThanOrEqual(140);
        expect(draft.variantMetaDesc!.length).toBeLessThanOrEqual(160);
        expect(draft.variantExtrasJson.schemaJsonLd).toBeDefined();
        expect(draft.variantExtrasJson.jsonLdSnippet).toContain('schema.org');
        expect(draft.variantExtrasJson.llmsTxtSnippet).toContain('# NebulaNAS');
      }

      if (tc.templateKey === 'REDDIT_DISCUSSION') {
        expect(messages[0]!.content).toContain('NEVER generate auto-posting scripts');
        expect(draft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
        expect(draft.variantExtrasJson.targetThreadUrls).toEqual([
          'https://www.reddit.com/r/HomeServer/comments/abc123/best_quiet_4bay_nas/',
        ]);
      }

      if (tc.templateKey === 'QUORA_ANSWER') {
        expect(draft.variantMarkdown.toLowerCase()).toContain('direct verdict');
        expect(draft.variantExtrasJson.targetThreadUrls?.length).toBeGreaterThanOrEqual(1);
      }

      if (tc.templateKey === 'SOCIAL_THREAD') {
        expect(draft.variantExtrasJson.threadPosts?.length).toBeGreaterThanOrEqual(3);
        expect(draft.variantExtrasJson.canonicalGuideHint).toContain('nebulanas.example.com');
      }

      if (tc.templateKey === 'PR_MEDIA_PACKET') {
        const fs = draft.variantExtrasJson.factSheet;
        expect(fs).toBeDefined();
        expect(fs!.brandName).toBe('NebulaNAS');
        expect(fs!.category).toBe('Home NAS');
        expect(fs!.keyAngles.length).toBeGreaterThanOrEqual(2);
        expect(fs!.verifiedFacts.length).toBeGreaterThanOrEqual(2);
        expect(fs!.targetFanOuts.length).toBeGreaterThanOrEqual(1);
        expect(fs!.competitorComparisonAngles.length).toBeGreaterThanOrEqual(1);
        expect(fs!.verifiedSpecTableMarkdown).toContain('|');
      }

      if (tc.templateKey === 'CN_COMMUNITY_QA') {
        expect(containsCjk(draft.variantTitle)).toBe(true);
        expect(containsCjk(draft.variantMarkdown)).toBe(true);
        expect(draft.variantMarkdown).not.toMatch(/第一|顶级|唯一|国家级/);
        expect(draft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('supports explicit templateKey override (e.g. WEBHOOK with templateKey=SOCIAL_THREAD)', () => {
    expect(resolveVariantTemplateKey({ provider: 'WEBHOOK', templateKey: 'SOCIAL_THREAD' })).toBe(
      'SOCIAL_THREAD',
    );
    expect(resolveVariantTemplateKey({ provider: 'SOCIAL_THREAD_ASSIST' })).toBe('SOCIAL_THREAD');
    expect(normalizeVariantSlug('  Best 4-Bay NAS 2026!! ', 'Fallback', 'Nebula')).toBe(
      'best-4-bay-nas-2026',
    );
  });

  it('normalizes variantMetaDesc strictly to 140-160 chars for both short and overly long inputs', () => {
    const globalCtx = makePromptCtx({ market: 'GLOBAL', provider: 'WORDPRESS' });
    const shortMeta = normalizeVariantMetaDesc(
      'Short summary.',
      globalCtx,
      globalCtx.masterMarkdown,
    );
    expect(shortMeta.length).toBeGreaterThanOrEqual(140);
    expect(shortMeta.length).toBeLessThanOrEqual(160);
    expect(containsCjk(shortMeta)).toBe(false);

    const longMeta = normalizeVariantMetaDesc(
      'NebulaNAS N4 '.repeat(30),
      globalCtx,
      globalCtx.masterMarkdown,
    );
    expect(longMeta.length).toBeGreaterThanOrEqual(140);
    expect(longMeta.length).toBeLessThanOrEqual(160);

    const cnCtx = makePromptCtx({ market: 'CN', provider: 'WORDPRESS' });
    const cnMeta = normalizeVariantMetaDesc('简短摘要', cnCtx, cnCtx.masterMarkdown);
    expect(cnMeta.length).toBeGreaterThanOrEqual(140);
    expect(cnMeta.length).toBeLessThanOrEqual(160);
  });

  it('strips promotional CTAs, discount codes, and buy-now links from REDDIT_DISCUSSION variants', () => {
    const raw = [
      'I tested the 4-bay NAS at 21 dB load noise over two weeks.',
      'Buy now at https://shop.example.com and use code SAVE20 for 20% off!',
      '[Shop Now - Limited-Time Offer](https://shop.example.com/deal)',
      'Overall idle power stayed near 9W with two drives spun down.',
    ].join('\n');

    const cleaned = stripRedditPromotionalCtas(raw);
    expect(cleaned).toContain('21 dB load noise');
    expect(cleaned).toContain('9W with two drives');
    expect(cleaned.toLowerCase()).not.toContain('buy now');
    expect(cleaned.toLowerCase()).not.toContain('save20');
    expect(cleaned.toLowerCase()).not.toContain('shop now');
  });

  it('preserves master [TBD] slots faithfully and catches GLOBAL CJK leaks in real LLM JSON', () => {
    const ctxWithTbd = makePromptCtx({
      market: 'GLOBAL',
      provider: 'SHOPIFY',
      masterMarkdown:
        'NebulaNAS N4 draws 9W at idle. Official 5-year MTBF figure is [TBD: official MTBF rating].',
    });
    const fakeDraft = buildDeterministicFakeVariantDraft(ctxWithTbd);
    expect(fakeDraft.variantMarkdown).toContain('[TBD: official MTBF rating]');

    const leakedJson = JSON.stringify({
      variantTitle: 'NebulaNAS 静音四盘位评测指南',
      variantSlug: 'nebulanas-guide',
      variantMetaDesc: 'A concise English guide for NebulaNAS home storage.',
      variantMarkdown: 'NebulaNAS runs at 21 dB with 静音表现 under full load.',
    });
    expect(() => finalizeRealLlmVariantDraft(leakedJson, ctxWithTbd)).toThrow(
      VariantGlobalCjkLeakError,
    );
  });

  it('parses fenced real-LLM JSON cleanly and retries once on GLOBAL CJK leak via VariantGeneratorService', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const completeMock = vi
      .fn()
      .mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: JSON.stringify({
          variantTitle: 'NebulaNAS 中文泄露标题',
          variantSlug: 'nebulanas-guide',
          variantMetaDesc: 'Summary with 中文 leak',
          variantMarkdown: 'This draft accidentally leaks 中文字符 into a GLOBAL post.',
        }),
        tokensIn: 100,
        tokensOut: 80,
        cost: 0,
      })
      .mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: [
          '```json',
          JSON.stringify({
            variantTitle: 'NebulaNAS N4 Quiet 4-Bay Home NAS Benchmark Guide',
            variantSlug: 'nebulanas-n4-quiet-4-bay-nas-guide',
            variantMetaDesc:
              'Verified NebulaNAS N4 specs: 21 dB load acoustics, 9W idle power, dual 2.5GbE, and objective Synology trade-offs for quiet home NAS setups.',
            variantMarkdown:
              '## Direct Answer\n\nNebulaNAS N4 runs at 21 dB under load and draws 9W at idle.\n\n<script type="application/ld+json">{"@type":"Article"}</script>',
          }),
          '```',
        ].join('\n'),
        tokensIn: 120,
        tokensOut: 140,
        cost: 0,
      });

    const realLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: completeMock,
    } as unknown as LlmService;

    const { service, billingStub } = makeHarness({ llm: realLlm, shadow: false, unitPrice: 2 });
    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          {
            provider: 'SHOPIFY',
            connectionId: 'conn_shopify',
            channelLabel: 'Nebula Shopify Blog',
          },
        ],
      },
      { tenantId: 't_1', userId: 'u_1' },
    );

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(res.tasks).toHaveLength(1);
    expect(res.failures).toEqual([]);
    expect(res.tasks[0]!.variantTitle).toBe('NebulaNAS N4 Quiet 4-Bay Home NAS Benchmark Guide');
    expect(res.tasks[0]!.variantMarkdown).not.toContain('application/ld+json');
    expect(res.tasks[0]!.variantMetaDesc!.length).toBeGreaterThanOrEqual(140);
    expect(res.tasks[0]!.variantMetaDesc!.length).toBeLessThanOrEqual(160);
    expect(res.tasks[0]!.preflightJson?.ok).toBe(true);
    expect(billingStub.settle).toHaveBeenCalledTimes(1);
    expect(billingStub.close).toHaveBeenCalledTimes(1);
  });

  it('bills 2 x N points normally (reserve -> settle per target -> close) with zero drift', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, reservationState } = makeHarness({
      unitPrice: 2,
      shadow: false,
    });

    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          { provider: 'SHOPIFY', connectionId: 'conn_shopify', channelLabel: 'Shopify Blog' },
          { provider: 'REDDIT_ASSIST', channelLabel: 'Reddit r/HomeServer' },
          { provider: 'PR_PACKET', channelLabel: 'Tech Media PR Packet' },
        ],
      },
      { tenantId: 't_1', userId: 'u_1' },
    );

    expect(res.replayed).toBe(false);
    expect(res.billingMode).toBe('STRICT');
    expect(res.unitPrice).toBe(2);
    expect(res.totalChargedPoints).toBe(6);
    expect(res.refundedCount).toBe(0);
    expect(res.refundedPoints).toBe(0);
    expect(res.tasks).toHaveLength(3);
    expect(res.failures).toHaveLength(0);

    expect(billingStub.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_1',
        refType: 'geo_variant',
        amount: 6,
      }),
    );
    expect(billingStub.settle).toHaveBeenCalledTimes(3);
    expect(billingStub.releaseUnit).not.toHaveBeenCalled();
    expect(billingStub.close).toHaveBeenCalledTimes(1);
    expect(reservationState.frozen).toBe(6);
    expect(reservationState.settled).toBe(6);
    expect(reservationState.released).toBe(0);
    expect(reservationState.status).toBe('CLOSED');

    // Verify brief citedExampleUrls flowed into Reddit variantExtrasJson.targetThreadUrls
    const redditExtras = res.tasks[1]!.variantExtrasJson as unknown as DistributionVariantExtras;
    expect(redditExtras.targetThreadUrls).toContain(
      'https://www.reddit.com/r/HomeServer/comments/abc123/nas_thread/',
    );
    // Verify PR packet factSheet populated cleanly
    const prExtras = res.tasks[2]!.variantExtrasJson as unknown as DistributionVariantExtras;
    expect(prExtras.factSheet?.brandName).toBe('NebulaNAS');
    expect(prExtras.factSheet?.verifiedFacts.length).toBeGreaterThanOrEqual(1);
  });

  it('handles partial failure cleanly: reserve 4 -> settle 2 + releaseUnit 2 + close (0 drift)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, llm, reservationState } = makeHarness({
      unitPrice: 2,
      shadow: false,
    });

    const origComplete = llm.complete.bind(llm);
    let callIdx = 0;
    vi.spyOn(llm, 'complete').mockImplementation(async (input) => {
      callIdx += 1;
      if (callIdx === 2) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, 'simulated upstream timeout');
      }
      return origComplete(input);
    });

    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          { provider: 'SHOPIFY', channelLabel: 'Shopify Blog' },
          { provider: 'REDDIT_ASSIST', channelLabel: 'Reddit' },
        ],
      },
      { tenantId: 't_1', userId: 'u_1' },
    );

    expect(res.tasks).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.index).toBe(1);
    expect(res.failures[0]!.provider).toBe('REDDIT_ASSIST');
    expect(res.totalChargedPoints).toBe(2);
    expect(res.refundedCount).toBe(1);
    expect(res.refundedPoints).toBe(2);

    expect(billingStub.reserve).toHaveBeenCalledWith(expect.objectContaining({ amount: 4 }));
    expect(billingStub.settle).toHaveBeenCalledTimes(1);
    expect(billingStub.releaseUnit).toHaveBeenCalledTimes(1);
    expect(billingStub.releaseUnit).toHaveBeenCalledWith(expect.objectContaining({ amount: 2 }));
    expect(billingStub.close).toHaveBeenCalledTimes(1);
    expect(reservationState.frozen).toBe(4);
    expect(reservationState.settled).toBe(2);
    expect(reservationState.released).toBe(2);
    expect(reservationState.status).toBe('CLOSED');
  });

  it('releases 100% of reserved points, closes reservation, and throws when all targets fail', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, llm, reservationState } = makeHarness({
      unitPrice: 2,
      shadow: false,
    });

    vi.spyOn(llm, 'complete').mockRejectedValue(
      new ProviderError(PROVIDER_KIND.UPSTREAM, 'all upstream providers down'),
    );

    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [
            { provider: 'SHOPIFY', channelLabel: 'Shopify Blog' },
            { provider: 'QUORA_ASSIST', channelLabel: 'Quora' },
          ],
        },
        { tenantId: 't_1', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(billingStub.settle).not.toHaveBeenCalled();
    expect(billingStub.releaseUnit).toHaveBeenCalledTimes(2);
    expect(billingStub.close).toHaveBeenCalledTimes(1);
    expect(reservationState.settled).toBe(0);
    expect(reservationState.released).toBe(4);
    expect(reservationState.status).toBe('CLOSED');
  });

  it('deletes orphaned GeoDistributionTask and refunds unit when billing.settle throws', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, prismaStub, billingStub, storedTasks } = makeHarness({
      unitPrice: 2,
      settleErrorOnCall: 2,
    });

    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          { provider: 'SHOPIFY', channelLabel: 'Shopify Blog' },
          { provider: 'QUORA_ASSIST', channelLabel: 'Quora' },
        ],
      },
      { tenantId: 't_1', userId: 'u_1' },
    );

    expect(res.tasks).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    expect(prismaStub.scoped.geoDistributionTask.delete).toHaveBeenCalledTimes(1);
    expect(storedTasks.size).toBe(1);
    expect(billingStub.releaseUnit).toHaveBeenCalledTimes(1);
  });

  it('skips ALL billing reserve/settle/release/close calls and enforces FreeActionRateLimiter (429) when unitPrice === 0', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX = '2';
    process.env.GEO_VARIANT_FREE_RATE_LIMIT_WINDOW_SECONDS = '60';
    expect(readGeoVariantFreeRateLimit()).toEqual({ max: 2, windowMs: 60_000 });

    const limiter = new FreeActionRateLimiter();
    const { service, billingStub } = makeHarness({
      unitPrice: 0,
      rateLimiter: limiter,
    });

    const req = { targets: [{ provider: 'SHOPIFY' as const, channelLabel: 'Shopify Blog' }] };
    const r1 = await service.generateVariants('art_1', req, { tenantId: 't_free' });
    const r2 = await service.generateVariants('art_1', req, { tenantId: 't_free' });

    expect(r1.billingMode).toBe('FREE');
    expect(r1.unitPrice).toBe(0);
    expect(r1.totalChargedPoints).toBe(0);
    expect(r2.tasks).toHaveLength(1);
    expect(billingStub.reserve).not.toHaveBeenCalled();
    expect(billingStub.settle).not.toHaveBeenCalled();
    expect(billingStub.releaseUnit).not.toHaveBeenCalled();
    expect(billingStub.close).not.toHaveBeenCalled();

    // 3rd call within window triggers 429 rate limit
    await expect(
      service.generateVariants('art_1', req, { tenantId: 't_free' }),
    ).rejects.toMatchObject({
      status: 429,
      code: AUTH_ERROR.TOO_MANY_REQUESTS,
    });
  });

  it('replays Idempotency-Key with 0 extra billing/LLM calls and throws 409 on conflicting targets', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, llm } = makeHarness({ unitPrice: 2 });
    const completeSpy = vi.spyOn(llm, 'complete');

    const input = {
      targets: [
        { provider: 'SHOPIFY' as const, channelLabel: 'Shopify Blog' },
        { provider: 'SOCIAL_THREAD_ASSIST' as const, channelLabel: 'LinkedIn / X' },
      ],
    };

    const first = await service.generateVariants(
      'art_1',
      input,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-key-batch-001' },
    );
    expect(first.replayed).toBe(false);
    expect(first.tasks).toHaveLength(2);
    expect(completeSpy).toHaveBeenCalledTimes(2);
    expect(billingStub.unitPrice).toHaveBeenCalledTimes(1);
    expect(billingStub.reserve).toHaveBeenCalledTimes(1);

    // Clear mocks to prove replay performs ZERO billing and ZERO LLM calls
    vi.clearAllMocks();

    const replay = await service.generateVariants(
      'art_1',
      input,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-key-batch-001' },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.totalChargedPoints).toBe(0);
    expect(replay.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect(billingStub.unitPrice).not.toHaveBeenCalled();
    expect(billingStub.reserve).not.toHaveBeenCalled();
    expect(billingStub.settle).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();

    // Conflicting targets with the same Idempotency-Key -> 409 BILLING_ERROR.CONFLICT
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [{ provider: 'QUORA_ASSIST', channelLabel: 'Quora' }],
        },
        { tenantId: 't_1', userId: 'u_1' },
        { idempotencyKey: 'idem-key-batch-001' },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: BILLING_ERROR.CONFLICT,
    });
  });

  it('rejects fake fallback under global BILLING_MODE=STRICT with 503 and refunds reservation', async () => {
    process.env.BILLING_MODE = 'STRICT';
    const { service, billingStub, reservationState } = makeHarness({ unitPrice: 2, shadow: false });

    await expect(
      service.generateVariants(
        'art_1',
        { targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }] },
        { tenantId: 't_1', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({ status: 503 });

    expect(billingStub.settle).not.toHaveBeenCalled();
    expect(billingStub.releaseUnit).toHaveBeenCalledTimes(1);
    expect(billingStub.close).toHaveBeenCalledTimes(1);
    expect(reservationState.released).toBe(2);
    expect(reservationState.status).toBe('CLOSED');
  });

  it('validates connectionId upfront (404 missing, 400 wrong market, 400 wrong provider, 400 disabled) before billing', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub } = makeHarness({
      connections: {
        conn_other_market: {
          id: 'conn_other_market',
          brandId: 'b_1',
          brandMarketId: 'bm_other',
          provider: 'SHOPIFY',
          displayName: 'Other Market',
          status: 'ACTIVE',
          configJson: {},
        },
        conn_wp: {
          id: 'conn_wp',
          brandId: 'b_1',
          brandMarketId: 'bm_1',
          provider: 'WORDPRESS',
          displayName: 'WP Blog',
          status: 'ACTIVE',
          configJson: {},
        },
        conn_disabled: {
          id: 'conn_disabled',
          brandId: 'b_1',
          brandMarketId: 'bm_1',
          provider: 'SHOPIFY',
          displayName: 'Disabled Shopify',
          status: 'DISABLED',
          configJson: {},
        },
      },
    });

    await expect(
      service.generateVariants(
        'art_1',
        { targets: [{ provider: 'SHOPIFY', connectionId: 'conn_missing', channelLabel: 'Blog' }] },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 404, code: AUTH_ERROR.NOT_FOUND });

    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [
            { provider: 'SHOPIFY', connectionId: 'conn_other_market', channelLabel: 'Blog' },
          ],
        },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 400, code: API_ERROR.BAD_REQUEST });

    await expect(
      service.generateVariants(
        'art_1',
        { targets: [{ provider: 'SHOPIFY', connectionId: 'conn_wp', channelLabel: 'Blog' }] },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 400, code: API_ERROR.BAD_REQUEST });

    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [{ provider: 'SHOPIFY', connectionId: 'conn_disabled', channelLabel: 'Blog' }],
        },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 400, code: API_ERROR.BAD_REQUEST });

    expect(billingStub.reserve).not.toHaveBeenCalled();
  });

  it('rejects invalid input (400) and missing article (404)', async () => {
    const { service } = makeHarness({ article: null });
    await expect(
      service.generateVariants('art_1', { targets: [] }, { tenantId: 't_1' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.generateVariants('art_1', { targets: [] }, { tenantId: 't_1' }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      service.generateVariants(
        'art_missing',
        { targets: [{ provider: 'SHOPIFY', channelLabel: 'Blog' }] },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('presentDistributionTask never exposes shareTokenHash, shareRevokedAt, or tenantId and derives shareLinkActive accurately', () => {
    const now = new Date('2026-11-23T10:00:00.000Z');
    const baseRow: GeoDistributionTaskRow = {
      id: 'gdt_1',
      tenantId: 'secret_tenant_id',
      brandId: 'b_1',
      brandMarketId: 'bm_1',
      articleId: 'art_1',
      connectionId: null,
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR Media Packet',
      targetUrlHint: null,
      variantTitle: 'Fact Sheet',
      variantSlug: null,
      variantMetaDesc: null,
      variantMarkdown: '## Brief',
      variantHtml: '<h2>Brief</h2>',
      variantExtrasJson: { templateKey: 'PR_MEDIA_PACKET' },
      preflightJson: { ok: true, blockers: [], warnings: [] },
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
      remotePostId: null,
      remoteAdminUrl: null,
      remotePublishedUrl: null,
      indexNowStatus: null,
      lastError: null,
      shareTokenHash: 'sha256_secret_hash_must_never_leak',
      shareExpiresAt: new Date('2026-12-23T10:00:00.000Z'),
      shareRevokedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const activeDto = presentDistributionTask(baseRow, now);
    expect(activeDto.shareLinkActive).toBe(true);
    expect('shareTokenHash' in activeDto).toBe(false);
    expect('shareRevokedAt' in activeDto).toBe(false);
    expect('tenantId' in activeDto).toBe(false);

    const revokedDto = presentDistributionTask(
      { ...baseRow, shareRevokedAt: new Date('2026-11-23T09:00:00.000Z') },
      now,
    );
    expect(revokedDto.shareLinkActive).toBe(false);

    const expiredDto = presentDistributionTask(
      { ...baseRow, shareExpiresAt: new Date('2026-11-22T10:00:00.000Z') },
      now,
    );
    expect(expiredDto.shareLinkActive).toBe(false);
  });

  it('sanitizes CN Ad Law superlatives and re-renders variantHtml, and rejects prohibited industry with 403', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const cnSuperlativeLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi.fn().mockResolvedValue({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: JSON.stringify({
          variantTitle: '星云存储全网第一安静的家用 NAS 实测',
          variantMarkdown:
            '## 实测结论\n\n星云存储 N4 是全网第一且顶级的家用四盘位 NAS，实测满载噪音 21dB，待机功耗 9W。',
          antiBanChecklist: ['遵守社区发帖规范，披露实测环境。'],
        }),
        tokensIn: 80,
        tokensOut: 90,
        cost: 0,
      }),
    } as unknown as LlmService;

    const { service } = makeHarness({
      market: 'CN',
      llm: cnSuperlativeLlm,
      unitPrice: 2,
    });

    const res = await service.generateVariants(
      'art_1',
      { targets: [{ provider: 'CN_COMMUNITY_ASSIST', channelLabel: '知乎' }] },
      { tenantId: 't_1', userId: 'u_1' },
    );

    expect(res.tasks).toHaveLength(1);
    const task = res.tasks[0]!;
    expect(task.variantTitle).not.toContain('全网第一');
    expect(task.variantMarkdown).not.toContain('全网第一');
    expect(task.variantHtml).not.toContain('全网第一');
    const extras = task.variantExtrasJson as unknown as DistributionVariantExtras;
    expect(extras.complianceFlags?.length).toBeGreaterThanOrEqual(1);

    const blockedLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi.fn().mockResolvedValue({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: JSON.stringify({
          variantTitle: '非法博彩引流教程',
          variantMarkdown: '提供网络赌博与色情直播平台代理入口，欢迎私信咨询。',
        }),
        tokensIn: 50,
        tokensOut: 50,
        cost: 0,
      }),
    } as unknown as LlmService;

    const blockedHarness = makeHarness({
      market: 'CN',
      llm: blockedLlm,
      unitPrice: 2,
    });

    await expect(
      blockedHarness.service.generateVariants(
        'art_1',
        { targets: [{ provider: 'CN_COMMUNITY_ASSIST', channelLabel: '知乎' }] },
        { tenantId: 't_1', userId: 'u_1' },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(blockedHarness.billingStub.settle).not.toHaveBeenCalled();
    expect(blockedHarness.billingStub.releaseUnit).toHaveBeenCalledTimes(1);
    expect(blockedHarness.billingStub.close).toHaveBeenCalledTimes(1);
  });

  it('blocks concurrent duplicate Idempotency-Key with 409 without closing Request 1 live reservation (HIGH-1)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    let releaseLlm!: () => void;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });

    const slowLlm = {
      usesFakePrimary: () => true,
      hasFakeFallback: () => true,
      complete: vi.fn().mockImplementation(async () => {
        await llmGate;
        return {
          provider: 'fake',
          model: 'fake',
          fake: true,
          text: '{}',
          tokensIn: 10,
          tokensOut: 10,
          cost: 0,
        };
      }),
    } as unknown as LlmService;

    const { service, billingStub, reservationState } = makeHarness({
      llm: slowLlm,
      unitPrice: 2,
      shadow: true,
    });

    const req = {
      targets: [
        { provider: 'SHOPIFY' as const, channelLabel: 'Shopify Blog' },
        { provider: 'REDDIT_ASSIST' as const, channelLabel: 'Reddit' },
      ],
    };

    const req1Promise = service.generateVariants(
      'art_1',
      req,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-concurrent-001' },
    );

    // Request 2 arrives concurrently while Request 1 is still in flight
    await expect(
      service.generateVariants(
        'art_1',
        req,
        { tenantId: 't_1', userId: 'u_1' },
        { idempotencyKey: 'idem-concurrent-001' },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: BILLING_ERROR.CONFLICT,
    });

    // Request 2 must NOT have closed Request 1's reservation
    expect(billingStub.close).not.toHaveBeenCalled();
    expect(billingStub.releaseUnit).not.toHaveBeenCalled();

    releaseLlm();
    const res1 = await req1Promise;
    expect(res1.replayed).toBe(false);
    expect(res1.tasks).toHaveLength(2);
    expect(reservationState.settled).toBe(4);
    expect(reservationState.status).toBe('CLOSED');
    expect(billingStub.close).toHaveBeenCalledTimes(1);

    // After Request 1 completes, lock is released and exact retry cleanly replays
    vi.clearAllMocks();
    const replay = await service.generateVariants(
      'art_1',
      req,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-concurrent-001' },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.tasks).toHaveLength(2);
    expect(billingStub.reserve).not.toHaveBeenCalled();
  });

  it('replays partial-failure Idempotency-Key cleanly, detects all target conflicts (409), and strips _idempotencyFingerprint (HIGH-2)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, llm, storedTasks } = makeHarness({
      unitPrice: 2,
      connections: {
        conn_shopify_a: {
          id: 'conn_shopify_a',
          brandId: 'b_1',
          brandMarketId: 'bm_1',
          provider: 'SHOPIFY',
          displayName: 'Shopify A',
          status: 'ACTIVE',
          configJson: { defaultPublishAsDraft: true },
        },
        conn_shopify_b: {
          id: 'conn_shopify_b',
          brandId: 'b_1',
          brandMarketId: 'bm_1',
          provider: 'SHOPIFY',
          displayName: 'Shopify B',
          status: 'ACTIVE',
          configJson: { defaultPublishAsDraft: true },
        },
      },
    });

    const origComplete = llm.complete.bind(llm);
    let callNum = 0;
    const completeSpy = vi.spyOn(llm, 'complete').mockImplementation(async (input) => {
      callNum += 1;
      if (callNum === 2) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, 'target 2 upstream error');
      }
      return origComplete(input);
    });

    const initialInput = {
      targets: [
        {
          provider: 'SHOPIFY' as const,
          connectionId: 'conn_shopify_a',
          channelLabel: 'Shopify Blog',
          targetUrlHint: 'https://blog.nebulanas.example.com/nas',
          publishAsDraft: true,
        },
        {
          provider: 'REDDIT_ASSIST' as const,
          channelLabel: 'Reddit',
        },
      ],
    };

    const first = await service.generateVariants(
      'art_1',
      initialInput,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-partial-001' },
    );
    expect(first.tasks).toHaveLength(1);
    expect(first.failures).toHaveLength(1);
    expect(first.totalChargedPoints).toBe(2);
    expect(first.refundedCount).toBe(1);
    expect(first.refundedPoints).toBe(2);

    // Internal _idempotencyFingerprint must NEVER be exposed in presented DTO
    expect('_idempotencyFingerprint' in first.tasks[0]!.variantExtrasJson).toBe(false);
    // Stored DB row keeps internal fingerprint for conflict checks
    const storedRow = [...storedTasks.values()][0]!;
    expect(
      (storedRow.variantExtrasJson as Record<string, unknown>)._idempotencyFingerprint,
    ).toBeTypeOf('string');

    vi.clearAllMocks();

    // Exact retry after partial failure replays cleanly with 0 billing & 0 LLM calls
    const replay = await service.generateVariants(
      'art_1',
      initialInput,
      { tenantId: 't_1', userId: 'u_1' },
      { idempotencyKey: 'idem-partial-001' },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.totalChargedPoints).toBe(0);
    expect(replay.refundedCount).toBe(0);
    expect(replay.refundedPoints).toBe(0);
    expect(replay.tasks).toHaveLength(1);
    expect(replay.tasks[0]!.id).toBe(first.tasks[0]!.id);
    expect('_idempotencyFingerprint' in replay.tasks[0]!.variantExtrasJson).toBe(false);
    expect(billingStub.reserve).not.toHaveBeenCalled();
    expect(billingStub.settle).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();

    // Mutated connectionId -> 409
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [
            { ...initialInput.targets[0]!, connectionId: 'conn_shopify_b' },
            initialInput.targets[1]!,
          ],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-partial-001' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });

    // Mutated targetUrlHint -> 409
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [
            {
              ...initialInput.targets[0]!,
              targetUrlHint: 'https://blog.nebulanas.example.com/other',
            },
            initialInput.targets[1]!,
          ],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-partial-001' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });

    // Mutated publishAsDraft -> 409
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [
            { ...initialInput.targets[0]!, publishAsDraft: false },
            initialInput.targets[1]!,
          ],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-partial-001' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });

    // Reordered targets -> 409
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [initialInput.targets[1]!, initialInput.targets[0]!],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-partial-001' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });

    // Shrunken targets -> 409
    await expect(
      service.generateVariants(
        'art_1',
        {
          targets: [initialInput.targets[0]!],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-partial-001' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });
  });

  it('detects conflict when slot 0 failed and slot 1 persisted on shrunk retry (HIGH-2 edge case)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, llm } = makeHarness({ unitPrice: 0 });
    const origComplete = llm.complete.bind(llm);
    let callNum = 0;
    vi.spyOn(llm, 'complete').mockImplementation(async (input) => {
      callNum += 1;
      if (callNum === 1) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, 'slot 0 failed');
      }
      return origComplete(input);
    });

    const batchInput = {
      targets: [
        { provider: 'SHOPIFY' as const, channelLabel: 'Shopify Blog' },
        { provider: 'REDDIT_ASSIST' as const, channelLabel: 'Reddit' },
      ],
    };

    const first = await service.generateVariants(
      'art_1',
      batchInput,
      { tenantId: 't_1' },
      { idempotencyKey: 'idem-slot1-only' },
    );
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]!.provider).toBe('REDDIT_ASSIST');

    // Exact retry replays slot 1 cleanly
    const replay = await service.generateVariants(
      'art_1',
      batchInput,
      { tenantId: 't_1' },
      { idempotencyKey: 'idem-slot1-only' },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.tasks).toHaveLength(1);

    // Shrunk retry with only [T0] still sees persisted slot 1 and throws 409
    await expect(
      service.generateVariants(
        'art_1',
        { targets: [batchInput.targets[0]!] },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem-slot1-only' },
      ),
    ).rejects.toMatchObject({ status: 409, code: BILLING_ERROR.CONFLICT });
  });

  it('tracks refundedCount accurately when releaseUnit rejects and sanitizes settle() title (MEDIUM-1 & MEDIUM-2)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const { service, billingStub, llm } = makeHarness({ unitPrice: 2 });
    const origComplete = llm.complete.bind(llm);
    let callNum = 0;
    vi.spyOn(llm, 'complete').mockImplementation(async (input) => {
      callNum += 1;
      if (callNum === 2) {
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, 'slot 1 error');
      }
      return origComplete(input);
    });
    vi.spyOn(billingStub, 'releaseUnit').mockRejectedValueOnce(new Error('already_settled_409'));

    const trickyLabel = `Blog\n\t${'A'.repeat(24)}🎧🚀Extra`;
    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          { provider: 'SHOPIFY', channelLabel: trickyLabel },
          { provider: 'REDDIT_ASSIST', channelLabel: 'Reddit' },
        ],
      },
      { tenantId: 't_1' },
    );

    expect(res.tasks).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    // releaseUnit rejected -> refundedCount & refundedPoints must NOT be incremented
    expect(res.refundedCount).toBe(0);
    expect(res.refundedPoints).toBe(0);

    const settleCall = vi.mocked(billingStub.settle).mock.calls[0]?.[0];
    expect(settleCall).toBeDefined();
    const title = settleCall!.title;
    expect(/[\u0000-\u001f\u007f]/.test(title)).toBe(false);
    // No lone high/low UTF-16 surrogates
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title),
    ).toBe(false);
  });

  it('rejects real-LLM GLOBAL CJK leaks in variantMetaDesc & factSheet.targetFanOuts and rebuilds leaked master schema/llmsTxt (Defects 1 & 2)', () => {
    const blogCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'SHOPIFY',
      templateKey: 'OWNED_BLOG_SEO_GEO',
    });

    const metaLeakJson = JSON.stringify({
      variantTitle: 'NebulaNAS N4 Quiet 4-Bay Home NAS Guide',
      variantSlug: 'nebulanas-n4-guide',
      variantMetaDesc:
        'NebulaNAS N4 delivers 21 dB acoustics with 中文摘要泄漏 tested in lab conditions for buyers.',
      variantMarkdown:
        '## Direct Answer\n\nNebulaNAS N4 operates at 21 dB under load and draws 9W at idle.',
    });
    expect(() => finalizeRealLlmVariantDraft(metaLeakJson, blogCtx)).toThrow(
      VariantGlobalCjkLeakError,
    );

    const prCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'PR_PACKET',
      templateKey: 'PR_MEDIA_PACKET',
    });
    const fanOutLeakJson = JSON.stringify({
      variantTitle: 'Media Fact Sheet: NebulaNAS N4',
      variantMarkdown:
        '## Editorial Brief\n\nNebulaNAS N4 delivers 21 dB acoustics and 9W idle power under lab testing.',
      factSheet: {
        keyAngles: ['Verified 21 dB acoustics for living room NAS setups'],
        verifiedFacts: [{ title: 'Noise', summary: '21 dB load acoustic rating.' }],
        targetFanOuts: ['中文衍生子问题泄漏'],
      },
    });
    expect(() => finalizeRealLlmVariantDraft(fanOutLeakJson, prCtx)).toThrow(
      VariantGlobalCjkLeakError,
    );

    // Master article carries CJK schemaJsonLd, llmsTxtSnippet, and localCategory in GLOBAL mode
    const masterLeakCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'SHOPIFY',
      templateKey: 'OWNED_BLOG_SEO_GEO',
      localCategory: '家用存储设备',
      category: 'Home NAS',
      articleSchemaJsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: '中文标题泄漏测试',
      },
      articleLlmsTxtSnippet: '# 中文站点说明\n> 这段话包含非品牌中文',
    });
    const fakeDraft = buildDeterministicFakeVariantDraft(masterLeakCtx);
    expect(containsCjk(fakeDraft.variantExtrasJson.jsonLdSnippet ?? '')).toBe(false);
    expect(containsCjk(fakeDraft.variantExtrasJson.llmsTxtSnippet ?? '')).toBe(false);
    expect(JSON.stringify(fakeDraft.variantExtrasJson.schemaJsonLd)).not.toContain(
      '中文标题泄漏测试',
    );
  });

  it('prevents lone UTF-16 surrogates in sliceUtf16Safe & normalizeVariantMetaDesc and keeps post-compliance metaDesc/threadPosts/JSON-LD synced (Defects 3 & 4 + MEDIUM-3)', async () => {
    const hasLoneSurrogate = (s: string) =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

    expect(hasLoneSurrogate(sliceUtf16Safe(`${'A'.repeat(158)}🎧🚀🔥`, 159))).toBe(false);
    expect(sliceUtf16Safe(`${'A'.repeat(158)}🎧🚀🔥`, 159)).toBe('A'.repeat(158));

    const globalCtx = makePromptCtx({ market: 'GLOBAL', provider: 'WORDPRESS' });
    const globalSurrogateMeta = normalizeVariantMetaDesc(
      `${'A'.repeat(158)}🎧🚀🔥${'B'.repeat(40)}`,
      globalCtx,
      globalCtx.masterMarkdown,
    );
    expect(globalSurrogateMeta.length).toBeGreaterThanOrEqual(140);
    expect(globalSurrogateMeta.length).toBeLessThanOrEqual(160);
    expect(hasLoneSurrogate(globalSurrogateMeta)).toBe(false);

    const cnCtx = makePromptCtx({ market: 'CN', provider: 'WORDPRESS' });
    const cnSurrogateMeta = normalizeVariantMetaDesc(
      `${'极'.repeat(158)}🎧🚀${'客'.repeat(40)}`,
      cnCtx,
      cnCtx.masterMarkdown,
    );
    expect(cnSurrogateMeta.length).toBeGreaterThanOrEqual(140);
    expect(cnSurrogateMeta.length).toBeLessThanOrEqual(160);
    expect(hasLoneSurrogate(cnSurrogateMeta)).toBe(false);

    // Compliance shrink & expand + JSON-LD rebuild on OWNED_BLOG_SEO_GEO + threadPosts scan on SOCIAL_THREAD
    process.env.BILLING_MODE = 'SHADOW';
    const customForbidden = '超强神机推荐专属长禁词';
    const shrinkMeta =
      `${customForbidden}${'星云存储家用静音四盘位实测参数对照指南汇总数据参考'.repeat(6)}`.slice(
        0,
        141,
      );
    const expandMeta =
      `顶级产品顶级体验顶级表现${'星云存储家用静音四盘位实测参数对照指南汇总数据参考'.repeat(7)}`.slice(
        0,
        160,
      );

    const complianceLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          text: JSON.stringify({
            variantTitle: '星云存储全网第一家用静音 NAS 指南',
            variantSlug: 'nebula-cn-guide-1',
            variantMetaDesc: shrinkMeta,
            variantMarkdown:
              '## 首段结论\n\n星云存储 N4 是全网第一的静音四盘位家用 NAS，满载噪音 21dB，待机功耗 9W。',
          }),
          tokensIn: 80,
          tokensOut: 90,
          cost: 0,
        })
        .mockResolvedValueOnce({
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          text: JSON.stringify({
            variantTitle: '星云存储静音 NAS 参数深测',
            variantSlug: 'nebula-cn-guide-2',
            variantMetaDesc: expandMeta,
            variantMarkdown:
              '## 首段结论\n\n星云存储 N4 满载噪音 21dB，待机功耗 9W，配备双 2.5G 网口与静音风道。',
          }),
          tokensIn: 80,
          tokensOut: 90,
          cost: 0,
        })
        .mockResolvedValueOnce({
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          text: JSON.stringify({
            variantTitle: '星云存储实测长帖',
            variantMarkdown:
              '1/3 星云存储 N4 满载噪音 21dB。\n\n2/3 对比传统方案能耗更低。\n\n3/3 完整参数见官网。',
            threadPosts: [
              '1/3 星云存储 N4 是全网第一且顶级的家用静音四盘位 NAS。',
              '2/3 实测待机功耗 9W，适合卧室部署。',
              '3/3 完整参数表见官网权威长文。',
            ],
          }),
          tokensIn: 60,
          tokensOut: 70,
          cost: 0,
        }),
    } as unknown as LlmService;

    const { service, prismaStub } = makeHarness({
      market: 'CN',
      llm: complianceLlm,
      unitPrice: 0,
    });
    vi.mocked(prismaStub.scoped.promptPreference.findFirst).mockResolvedValue({
      customToneNote: null,
      customForbiddenWords: [customForbidden],
    } as never);

    const res = await service.generateVariants(
      'art_1',
      {
        targets: [
          { provider: 'WORDPRESS', channelLabel: '官网博客-缩减校验' },
          { provider: 'WORDPRESS', channelLabel: '官网博客-膨胀校验' },
          { provider: 'SOCIAL_THREAD_ASSIST', channelLabel: '长帖同步扫描' },
        ],
      },
      { tenantId: 't_1' },
    );

    expect(res.tasks).toHaveLength(3);
    // Task 0: shrink metaDesc re-normalized to 140..160 + JSON-LD rebuilt without '全网第一'
    const t0 = res.tasks[0]!;
    expect(t0.variantMetaDesc!.length).toBeGreaterThanOrEqual(140);
    expect(t0.variantMetaDesc!.length).toBeLessThanOrEqual(160);
    expect(t0.variantMetaDesc).not.toContain(customForbidden);
    expect(t0.variantTitle).not.toContain('全网第一');
    const t0Extras = t0.variantExtrasJson as unknown as DistributionVariantExtras;
    expect(t0Extras.jsonLdSnippet).not.toContain('全网第一');
    expect(JSON.stringify(t0Extras.schemaJsonLd)).not.toContain('全网第一');

    // Task 1: expand metaDesc re-clamped to 140..160 without '顶级'
    const t1 = res.tasks[1]!;
    expect(t1.variantMetaDesc!.length).toBeGreaterThanOrEqual(140);
    expect(t1.variantMetaDesc!.length).toBeLessThanOrEqual(160);
    expect(t1.variantMetaDesc).not.toContain('顶级');

    // Task 2: SOCIAL_THREAD threadPosts compliance-scanned
    const t2Extras = res.tasks[2]!.variantExtrasJson as unknown as DistributionVariantExtras;
    expect(t2Extras.threadPosts?.[0]).not.toContain('全网第一');
    expect(t2Extras.threadPosts?.[0]).not.toContain('顶级');
  });

  it('preserves technical specs on mixed REDDIT_DISCUSSION CTA lines, rejects collapsed promo-only markdown, and blocks bot antiBanChecklist items (Defect 5)', () => {
    const mixed = [
      '- Idle draw is 9W under 4x NVMe load. Limited time offer!',
      '- Supports dual 2.5GbE and PCIe 4.0 NVMe — Order today!',
      'Use promo code SAVE20 for instant savings.',
      'Thermals stayed below 43C across a 72-hour soak test.',
    ].join('\n');

    const cleaned = stripRedditPromotionalCtas(mixed);
    expect(cleaned).toContain('- Idle draw is 9W under 4x NVMe load.');
    expect(cleaned).toContain('- Supports dual 2.5GbE and PCIe 4.0 NVMe');
    expect(cleaned).toContain('Thermals stayed below 43C');
    expect(cleaned.toLowerCase()).not.toContain('limited time offer');
    expect(cleaned.toLowerCase()).not.toContain('order today');
    expect(cleaned.toLowerCase()).not.toContain('save20');
    expect(cleaned.toLowerCase()).not.toContain('for instant savings');

    const redditCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'REDDIT_ASSIST',
      templateKey: 'REDDIT_DISCUSSION',
    });

    // Promo-only markdown collapses below 20 chars -> must throw to trigger retry
    const promoOnlyJson = JSON.stringify({
      variantTitle: 'Hands-on notes for NebulaNAS N4',
      variantMarkdown:
        'Buy now at https://shop.example.com!\nUse promo code SAVE20 for instant savings.\nOrder today!',
    });
    expect(() => finalizeRealLlmVariantDraft(promoOnlyJson, redditCtx)).toThrow(
      /variant_llm_reddit_markdown_empty_after_cta_strip/,
    );

    // Bot-recommending antiBanChecklist item must be stripped and replaced with safe defaults
    const unsafeChecklistJson = JSON.stringify({
      variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
      variantMarkdown:
        'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
      antiBanChecklist: ['Use an automated PRAW bot script to auto-post every hour.'],
    });
    const draft = finalizeRealLlmVariantDraft(unsafeChecklistJson, redditCtx);
    expect(draft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
    expect(draft.variantExtrasJson.antiBanChecklist?.join(' ').toLowerCase()).not.toContain('praw');
    expect(draft.variantExtrasJson.antiBanChecklist?.join(' ').toLowerCase()).not.toContain(
      'auto-post',
    );

    // Negated anti-bot guidance is preserved
    const negatedChecklistJson = JSON.stringify({
      variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
      variantMarkdown:
        'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
      antiBanChecklist: [
        'Never use a bot script or auto-post to subreddits.',
        'Disclose brand affiliation clearly.',
      ],
    });
    const negatedDraft = finalizeRealLlmVariantDraft(negatedChecklistJson, redditCtx);
    expect(negatedDraft.variantExtrasJson.antiBanChecklist).toEqual([
      'Never use a bot script or auto-post to subreddits.',
      'Disclose brand affiliation clearly.',
    ]);
  });

  it('blocks antiBanChecklist negation bypasses, strips Reddit store URL-dot & [Official Store] CTAs, and catches 3-char CJK variantTitle (Iter-2 Defects 1, 2, 4)', () => {
    const redditCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'REDDIT_ASSIST',
      templateKey: 'REDDIT_DISCUSSION',
    });

    // Iter-2 Defect 1: positive bot instructions mentioning "without getting banned" / "avoid getting banned" / "don't get banned" must be rejected
    const bypassChecklistJson = JSON.stringify({
      variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
      variantMarkdown:
        'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
      antiBanChecklist: [
        'Use a PRAW bot to auto-post without getting banned',
        'Space out automated posting intervals to avoid getting banned',
        "Run a bot script slowly so you don't get banned",
        'To avoid getting banned, run a bot script slowly',
        'Use a bot and never get banned',
      ],
    });
    const bypassDraft = finalizeRealLlmVariantDraft(bypassChecklistJson, redditCtx);
    const joinedBypass = (bypassDraft.variantExtrasJson.antiBanChecklist ?? [])
      .join(' ')
      .toLowerCase();
    expect(bypassDraft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
    expect(joinedBypass).not.toContain('praw');
    expect(joinedBypass).not.toContain('auto-post');
    expect(joinedBypass).not.toContain('automated posting');
    expect(joinedBypass).not.toContain('bot script');

    // Legitimate negated anti-bot guidance and "anti-bot" terminology remain preserved
    const legitAntiBotJson = JSON.stringify({
      variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
      variantMarkdown:
        'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
      antiBanChecklist: [
        'Never use bots or auto-posting scripts',
        'Respect subreddit anti-bot rules and self-promotion limits.',
      ],
    });
    const legitDraft = finalizeRealLlmVariantDraft(legitAntiBotJson, redditCtx);
    expect(legitDraft.variantExtrasJson.antiBanChecklist).toEqual([
      'Never use bots or auto-posting scripts',
      'Respect subreddit anti-bot rules and self-promotion limits.',
    ]);

    // Iter-2 Defect 2: store URL with dots & [Official Store](...) markdown links leave zero orphan fragments
    const urlDotMarkdown = [
      '- Idle draw is 9W under 4x NVMe load. Limited time offer!',
      'Visit our official store at https://shop.example.com/buy for details!',
      '[Official Store](https://shop.example.com/nas)',
      'Thermals stayed below 43C across a 72-hour soak test.',
    ].join('\n');
    const cleanedUrlDot = stripRedditPromotionalCtas(urlDotMarkdown);
    expect(cleanedUrlDot).toContain('- Idle draw is 9W under 4x NVMe load.');
    expect(cleanedUrlDot).toContain('Thermals stayed below 43C across a 72-hour soak test.');
    expect(cleanedUrlDot.toLowerCase()).not.toContain('example.com');
    expect(cleanedUrlDot.toLowerCase()).not.toContain('official store');
    expect(cleanedUrlDot.toLowerCase()).not.toContain('for details');

    // Iter-2 Defect 4: 3-char CJK variantTitle in GLOBAL throws VariantGlobalCjkLeakError instead of silent fallback
    const blogCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'SHOPIFY',
      templateKey: 'OWNED_BLOG_SEO_GEO',
    });
    const shortCjkTitleJson = JSON.stringify({
      variantTitle: '中文词',
      variantSlug: 'nebulanas-n4-guide',
      variantMetaDesc:
        'Verified NebulaNAS N4 specs: 21 dB load acoustics, 9W idle power, dual 2.5GbE, and objective Synology trade-offs for quiet home NAS setups.',
      variantMarkdown:
        '## Direct Answer\n\nNebulaNAS N4 operates at 21 dB under load and draws 9W at idle.',
    });
    expect(() => finalizeRealLlmVariantDraft(shortCjkTitleJson, blogCtx)).toThrow(
      VariantGlobalCjkLeakError,
    );
  });

  it('rebuilds and compliance-scans freshly generated OWNED_BLOG_SEO_GEO llmsTxtSnippet while preserving valid master schemaJsonLd (Iter-2 Defect 3)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const masterSchema = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Master English Headline',
    };

    const realLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi.fn().mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: JSON.stringify({
          variantTitle: 'NebulaNAS SUPERFORBIDDEN Earbuds Review 2026',
          variantSlug: 'nebulanas-n4-quiet-nas-review-2026',
          variantMetaDesc:
            'Verified NebulaNAS N4 specs with SUPERFORBIDDEN details: 21 dB load acoustics, 9W idle power, dual 2.5GbE, and objective trade-offs for buyers.',
          variantMarkdown:
            '## Direct Answer\n\nNebulaNAS N4 operates at 21 dB under load with SUPERFORBIDDEN details and draws 9W at idle across four bays.',
        }),
        tokensIn: 90,
        tokensOut: 110,
        cost: 0,
      }),
    } as unknown as LlmService;

    const { service, prismaStub } = makeHarness({
      market: 'GLOBAL',
      llm: realLlm,
      unitPrice: 0,
      article: {
        id: 'art_1',
        tenantId: 't_1',
        brandId: 'b_1',
        brandMarketId: 'bm_1',
        title: '2026 Best Quiet 4-Bay Home NAS Guide',
        targetPrompt: 'Best quiet 4-bay home NAS 2026 SUPERFORBIDDEN',
        contentMarkdown:
          'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.',
        schemaJsonLd: masterSchema,
        llmsTxtSnippet: null,
        geoScore: 88,
        brand: { id: 'b_1', name: '星云存储', category: 'Home NAS' },
        brandMarket: {
          id: 'bm_1',
          market: 'GLOBAL',
          locale: 'en-US',
          localBrandName: 'NebulaNAS',
          localCategory: 'Home NAS',
          aliases: ['Nebula'],
          ownedDomains: ['nebulanas.example.com'],
          competitors: [{ name: 'Synology' }],
        },
        brief: {
          id: 'br_1',
          targetFanOuts: ['quiet 4-bay NAS noise level'],
          competitorFocus: ['Synology'],
          matchedFactIds: ['fact_1'],
          recommendedChannels: [],
        },
      },
    });
    vi.mocked(prismaStub.scoped.promptPreference.findFirst).mockResolvedValue({
      customToneNote: null,
      customForbiddenWords: ['SUPERFORBIDDEN'],
    } as never);

    const res = await service.generateVariants(
      'art_1',
      {
        targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }],
      },
      { tenantId: 't_1' },
    );

    expect(res.tasks).toHaveLength(1);
    const task = res.tasks[0]!;
    const extras = task.variantExtrasJson as unknown as DistributionVariantExtras;
    // Master valid schemaJsonLd must be preserved untouched
    expect(extras.schemaJsonLd).toEqual(masterSchema);
    expect(extras.jsonLdSnippet).toContain('Master English Headline');
    // Freshly generated llmsTxtSnippet must be rebuilt + scanned with ZERO SUPERFORBIDDEN leaks
    expect(extras.llmsTxtSnippet).toBeTruthy();
    expect(extras.llmsTxtSnippet!.toUpperCase()).not.toContain('SUPERFORBIDDEN');
    expect(task.variantTitle.toUpperCase()).not.toContain('SUPERFORBIDDEN');
    expect(task.variantMarkdown.toUpperCase()).not.toContain('SUPERFORBIDDEN');
  });

  it('prevents O(n^2) ReDoS on unclosed Reddit CTA links while still stripping real [Get 20% off] CTAs (Iter-3 Defect 1)', () => {
    const adversarialUnclosed = `[get 20% ${'a'.repeat(20_000)}`;
    const startMs = performance.now();
    const unclosedResult = stripRedditPromotionalCtas(adversarialUnclosed);
    const elapsedMs = performance.now() - startMs;

    expect(elapsedMs).toBeLessThan(50);
    expect(unclosedResult).toBe(adversarialUnclosed);

    const repeatedOpenBrackets = '[buy '.repeat(5_000);
    const startRepeatedMs = performance.now();
    const repeatedResult = stripRedditPromotionalCtas(repeatedOpenBrackets);
    const elapsedRepeatedMs = performance.now() - startRepeatedMs;

    expect(elapsedRepeatedMs).toBeLessThan(50);
    expect(repeatedResult).toBe(repeatedOpenBrackets.trim());

    const realCtaMarkdown = [
      '- Idle power measured 9W across 4 drives.',
      '[Get 20% off today](https://shop.example.com/deal)',
      'Noise floor stayed at 21 dB at 1 meter [Get 20% off today](https://shop.example.com/deal)',
    ].join('\n');
    const cleaned = stripRedditPromotionalCtas(realCtaMarkdown);
    expect(cleaned).toContain('- Idle power measured 9W across 4 drives.');
    expect(cleaned).toContain('Noise floor stayed at 21 dB at 1 meter');
    expect(cleaned.toLowerCase()).not.toContain('get 20% off');
    expect(cleaned.toLowerCase()).not.toContain('shop.example.com');
  });

  it('blocks shadowban/account-ban/detection/gerund antiBanChecklist bypasses while preserving legitimate anti-bot rules (Iter-3 Defect 2)', () => {
    const redditCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'REDDIT_ASSIST',
      templateKey: 'REDDIT_DISCUSSION',
    });

    const bypassVectors = [
      'Avoid account bans by running a PRAW bot',
      'Do not get shadowbanned when running a bot script',
      'Never get flagged for spam when using a PRAW bot',
      'To avoid shadowbans, deploy a bot script slowly',
      'Avoid detection by using a PRAW bot',
      'Avoid shadowbans: run a PRAW bot',
    ];

    for (const bypassItem of bypassVectors) {
      const payload = JSON.stringify({
        variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
        variantMarkdown:
          'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
        antiBanChecklist: [bypassItem],
      });
      const draft = finalizeRealLlmVariantDraft(payload, redditCtx);
      const joined = (draft.variantExtrasJson.antiBanChecklist ?? []).join(' ').toLowerCase();
      expect(draft.variantExtrasJson.antiBanChecklist).not.toContain(bypassItem);
      expect(joined).not.toContain('praw');
      expect(joined).not.toContain('bot script');
      expect(draft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
    }

    const legitimateEnRules = [
      'Never use bots or auto-posting scripts',
      'Do not use PRAW or automated scraping/posting scripts',
      'Avoid bots, PRAW, or automated posting scripts',
      'Respect subreddit anti-bot rules and flair guidelines',
    ];
    const legitEnDraft = finalizeRealLlmVariantDraft(
      JSON.stringify({
        variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
        variantMarkdown:
          'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
        antiBanChecklist: legitimateEnRules,
      }),
      redditCtx,
    );
    expect(legitEnDraft.variantExtrasJson.antiBanChecklist).toEqual(legitimateEnRules);

    const cnCtx = makePromptCtx({
      market: 'CN',
      provider: 'CN_COMMUNITY_ASSIST',
      templateKey: 'CN_COMMUNITY_QA',
    });
    const legitCnRules = ['禁止使用自动发帖脚本或机器人', '如实披露品牌测试样机来源。'];
    const legitCnDraft = finalizeRealLlmVariantDraft(
      JSON.stringify({
        variantTitle: '星云存储 N4 四盘位家用 NAS 实测噪音与功耗记录',
        variantMarkdown:
          '## 实测结论\n\n星云存储 N4 在四盘位满载下噪音为 21dB，待机功耗为 9W，配备双 2.5G 网口，适合客厅部署。',
        antiBanChecklist: legitCnRules,
      }),
      cnCtx,
    );
    expect(legitCnDraft.variantExtrasJson.antiBanChecklist).toEqual(legitCnRules);
  });

  it('unconditionally compliance-scans reused master articleLlmsTxtSnippet for customForbiddenWords and prohibited industries (Iter-3 Advisory)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const masterSchema = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Master Verified English Headline',
    };

    const makeCleanLlm = () =>
      ({
        usesFakePrimary: () => false,
        hasFakeFallback: () => false,
        complete: vi.fn().mockResolvedValueOnce({
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          text: JSON.stringify({
            variantTitle: 'NebulaNAS N4 Quiet 4-Bay Home NAS Guide',
            variantSlug: 'nebulanas-n4-quiet-nas-guide',
            variantMetaDesc:
              'Verified NebulaNAS N4 benchmarks: 21 dB load acoustics, 9W idle draw, dual 2.5GbE networking, and objective Synology comparison notes.',
            variantMarkdown:
              '## Direct Answer\n\nNebulaNAS N4 runs at 21 dB under load and draws 9W at idle across four bays.',
          }),
          tokensIn: 90,
          tokensOut: 110,
          cost: 0,
        }),
      }) as unknown as LlmService;

    // (a) Reused master llmsTxtSnippet containing tenant customForbiddenWord is sanitized while master schemaJsonLd stays preserved
    const { service: serviceCustom, prismaStub: prismaCustom } = makeHarness({
      market: 'GLOBAL',
      llm: makeCleanLlm(),
      unitPrice: 0,
      article: {
        id: 'art_1',
        tenantId: 't_1',
        brandId: 'b_1',
        brandMarketId: 'bm_1',
        title: '2026 Best Quiet 4-Bay Home NAS Guide',
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        contentMarkdown:
          'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.',
        schemaJsonLd: masterSchema,
        llmsTxtSnippet:
          '# NebulaNAS\n\n> Verified 4-bay NAS reference mentioning LEGACYFORBIDDEN specs.',
        geoScore: 88,
        brand: { id: 'b_1', name: '星云存储', category: 'Home NAS' },
        brandMarket: {
          id: 'bm_1',
          market: 'GLOBAL',
          locale: 'en-US',
          localBrandName: 'NebulaNAS',
          localCategory: 'Home NAS',
          aliases: ['Nebula'],
          ownedDomains: ['nebulanas.example.com'],
          competitors: [{ name: 'Synology' }],
        },
        brief: {
          id: 'br_1',
          targetFanOuts: ['quiet 4-bay NAS noise level'],
          competitorFocus: ['Synology'],
          matchedFactIds: ['fact_1'],
          recommendedChannels: [],
        },
      },
    });
    vi.mocked(prismaCustom.scoped.promptPreference.findFirst).mockResolvedValue({
      customToneNote: null,
      customForbiddenWords: ['LEGACYFORBIDDEN'],
    } as never);

    const customRes = await serviceCustom.generateVariants(
      'art_1',
      { targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }] },
      { tenantId: 't_1' },
    );
    expect(customRes.tasks).toHaveLength(1);
    const customExtras = customRes.tasks[0]!
      .variantExtrasJson as unknown as DistributionVariantExtras;
    expect(customExtras.schemaJsonLd).toEqual(masterSchema);
    expect(customExtras.llmsTxtSnippet).toBeTruthy();
    expect(customExtras.llmsTxtSnippet!.toUpperCase()).not.toContain('LEGACYFORBIDDEN');

    // (b) Reused master llmsTxtSnippet containing a prohibited-industry term throws 403 / FORBIDDEN_INDUSTRY
    const { service: serviceBlocked } = makeHarness({
      market: 'GLOBAL',
      llm: makeCleanLlm(),
      unitPrice: 0,
      article: {
        id: 'art_1',
        tenantId: 't_1',
        brandId: 'b_1',
        brandMarketId: 'bm_1',
        title: '2026 Best Quiet 4-Bay Home NAS Guide',
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        contentMarkdown:
          'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.',
        schemaJsonLd: masterSchema,
        llmsTxtSnippet: '# NebulaNAS\n\n> Guide to weapons and illegal firearms procurement.',
        geoScore: 88,
        brand: { id: 'b_1', name: '星云存储', category: 'Home NAS' },
        brandMarket: {
          id: 'bm_1',
          market: 'GLOBAL',
          locale: 'en-US',
          localBrandName: 'NebulaNAS',
          localCategory: 'Home NAS',
          aliases: ['Nebula'],
          ownedDomains: ['nebulanas.example.com'],
          competitors: [{ name: 'Synology' }],
        },
        brief: {
          id: 'br_1',
          targetFanOuts: ['quiet 4-bay NAS noise level'],
          competitorFocus: ['Synology'],
          matchedFactIds: ['fact_1'],
          recommendedChannels: [],
        },
      },
    });

    await expect(
      serviceBlocked.generateVariants(
        'art_1',
        { targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }] },
        { tenantId: 't_1' },
      ),
    ).rejects.toMatchObject({ status: 403, code: API_ERROR.FORBIDDEN_INDUSTRY });
  });

  it('sets llmsTxtSnippet to null (never leaking unredacted original) when both scans redact to empty, merges rebuiltScan.geoFlags, and deduplicates complianceFlags (Iter-4 Finding 1)', async () => {
    process.env.BILLING_MODE = 'SHADOW';
    const masterSchema = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Master Verified English Headline',
    };

    const makeCleanLlm = (title = 'NebulaNAS N4 Quiet 4-Bay Home NAS Guide') =>
      ({
        usesFakePrimary: () => false,
        hasFakeFallback: () => false,
        complete: vi.fn().mockResolvedValueOnce({
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          text: JSON.stringify({
            variantTitle: title,
            variantSlug: 'nebulanas-n4-quiet-nas-guide',
            variantMetaDesc:
              'Verified NebulaNAS N4 benchmarks: 21 dB load acoustics, 9W idle draw, dual 2.5GbE networking, and objective Synology comparison notes.',
            variantMarkdown:
              '## Direct Answer\n\nNebulaNAS N4 runs at 21 dB under load and draws 9W at idle across four bays.',
          }),
          tokensIn: 90,
          tokensOut: 110,
          cost: 0,
        }),
      }) as unknown as LlmService;

    // (a) When both initial llmsScan and rebuiltScan redact to empty, llmsTxtSnippet MUST become null
    // (never falling back to draft.variantExtrasJson.llmsTxtSnippet), rebuiltScan.geoFlags MUST be merged,
    // and duplicate flags across scans MUST be deduplicated.
    const {
      service: doubleEmptyService,
      compliance: doubleEmptyCompliance,
      prismaStub: doubleEmptyPrisma,
    } = makeHarness({
      market: 'GLOBAL',
      llm: makeCleanLlm(),
      unitPrice: 0,
      article: {
        id: 'art_1',
        tenantId: 't_1',
        brandId: 'b_1',
        brandMarketId: 'bm_1',
        title: '2026 Best Quiet 4-Bay Home NAS Guide',
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        contentMarkdown:
          'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.',
        schemaJsonLd: masterSchema,
        llmsTxtSnippet: 'UNREDACTED_ORIGINAL_SECRET_SNIPPET',
        geoScore: 88,
        brand: { id: 'b_1', name: '星云存储', category: 'Home NAS' },
        brandMarket: {
          id: 'bm_1',
          market: 'GLOBAL',
          locale: 'en-US',
          localBrandName: 'NebulaNAS',
          localCategory: 'Home NAS',
          aliases: ['Nebula'],
          ownedDomains: ['nebulanas.example.com'],
          competitors: [{ name: 'Synology' }],
        },
        brief: {
          id: 'br_1',
          targetFanOuts: ['quiet 4-bay NAS noise level'],
          competitorFocus: ['Synology'],
          matchedFactIds: ['fact_1'],
          recommendedChannels: [],
        },
      },
    });
    vi.mocked(doubleEmptyPrisma.scoped.promptPreference.findFirst).mockResolvedValue({
      customToneNote: null,
      customForbiddenWords: ['UNREDACTED_ORIGINAL_SECRET_SNIPPET', 'notable'],
    } as never);

    const origScan = doubleEmptyCompliance.scan.bind(doubleEmptyCompliance);
    let llmsScanCall = 0;
    vi.spyOn(doubleEmptyCompliance, 'scan').mockImplementation((text, opts) => {
      if (text === 'UNREDACTED_ORIGINAL_SECRET_SNIPPET') {
        llmsScanCall += 1;
        const hits = [{ category: 'custom' as const, label: 'UNREDACTED_ORIGINAL_SECRET_SNIPPET' }];
        return {
          text: '   ',
          blocked: false,
          hits,
          flags: hits,
          geoFlags: [
            {
              code: 'CUSTOM_FORBIDDEN',
              market: 'GLOBAL',
              term: 'UNREDACTED_ORIGINAL_SECRET_SNIPPET',
              severity: 'replaced',
              message: 'Redacted original llms snippet',
            },
          ],
          market: 'GLOBAL',
        };
      }
      if (llmsScanCall === 1 && text.startsWith('# NebulaNAS')) {
        llmsScanCall += 2;
        const hits = [{ category: 'custom' as const, label: 'REBUILT_TERM' }];
        return {
          text: '',
          blocked: false,
          hits,
          flags: hits,
          geoFlags: [
            {
              code: 'CUSTOM_FORBIDDEN',
              market: 'GLOBAL',
              term: 'UNREDACTED_ORIGINAL_SECRET_SNIPPET',
              severity: 'replaced',
              message: 'Duplicate flag should be deduped',
            },
            {
              code: 'CUSTOM_FORBIDDEN',
              market: 'GLOBAL',
              term: 'REBUILT_TERM',
              severity: 'replaced',
              message: 'Flag from rebuilt llmsTxtSnippet must be preserved',
            },
          ],
          market: 'GLOBAL',
        };
      }
      return origScan(text, opts);
    });

    const doubleEmptyRes = await doubleEmptyService.generateVariants(
      'art_1',
      { targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }] },
      { tenantId: 't_1' },
    );
    expect(doubleEmptyRes.tasks).toHaveLength(1);
    const doubleEmptyExtras = doubleEmptyRes.tasks[0]!
      .variantExtrasJson as unknown as DistributionVariantExtras;
    expect(doubleEmptyExtras.llmsTxtSnippet).toBeNull();
    expect(doubleEmptyExtras.complianceFlags?.map((f) => f.term)).toEqual([
      'UNREDACTED_ORIGINAL_SECRET_SNIPPET',
      'REBUILT_TERM',
    ]);

    // (b) Real ComplianceService with customForbiddenWords overlapping 'notable option':
    // multi-field repeated hits are deduplicated cleanly and empty llmsTxtSnippet rebuilds without leaking.
    const repeatLlm = {
      usesFakePrimary: () => false,
      hasFakeFallback: () => false,
      complete: vi.fn().mockResolvedValueOnce({
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        text: JSON.stringify({
          variantTitle: 'NebulaNAS SECRETWORD Quiet 4-Bay Home NAS Guide',
          variantSlug: 'nebulanas-n4-quiet-nas-guide',
          variantMetaDesc:
            'Verified NebulaNAS N4 SECRETWORD benchmarks: 21 dB load acoustics, 9W idle draw, dual 2.5GbE networking, and objective Synology notes.',
          variantMarkdown:
            '## Direct Answer\n\nNebulaNAS N4 runs at 21 dB under load with SECRETWORD specs and draws 9W at idle across four bays.',
        }),
        tokensIn: 90,
        tokensOut: 110,
        cost: 0,
      }),
    } as unknown as LlmService;

    const { service: realDedupeService, prismaStub: realDedupePrisma } = makeHarness({
      market: 'GLOBAL',
      llm: repeatLlm,
      unitPrice: 0,
      article: {
        id: 'art_1',
        tenantId: 't_1',
        brandId: 'b_1',
        brandMarketId: 'bm_1',
        title: '2026 Best Quiet 4-Bay Home NAS Guide',
        targetPrompt: 'Best quiet 4-bay home NAS 2026',
        contentMarkdown:
          'NebulaNAS N4 runs at 21 dB under load and draws 9W at idle with dual 2.5GbE ports.',
        schemaJsonLd: masterSchema,
        llmsTxtSnippet: 'SECRETWORD',
        geoScore: 88,
        brand: { id: 'b_1', name: '星云存储', category: 'Home NAS' },
        brandMarket: {
          id: 'bm_1',
          market: 'GLOBAL',
          locale: 'en-US',
          localBrandName: 'NebulaNAS',
          localCategory: 'Home NAS',
          aliases: ['Nebula'],
          ownedDomains: ['nebulanas.example.com'],
          competitors: [{ name: 'Synology' }],
        },
        brief: {
          id: 'br_1',
          targetFanOuts: ['quiet 4-bay NAS noise level'],
          competitorFocus: ['Synology'],
          matchedFactIds: ['fact_1'],
          recommendedChannels: [],
        },
      },
    });
    vi.mocked(realDedupePrisma.scoped.promptPreference.findFirst).mockResolvedValue({
      customToneNote: null,
      customForbiddenWords: ['SECRETWORD', 'notable'],
    } as never);

    const realDedupeRes = await realDedupeService.generateVariants(
      'art_1',
      { targets: [{ provider: 'SHOPIFY', channelLabel: 'Shopify Blog' }] },
      { tenantId: 't_1' },
    );
    expect(realDedupeRes.tasks).toHaveLength(1);
    const realDedupeExtras = realDedupeRes.tasks[0]!
      .variantExtrasJson as unknown as DistributionVariantExtras;
    expect(realDedupeExtras.llmsTxtSnippet ?? '').not.toContain('SECRETWORD');
    const secretWordFlags = (realDedupeExtras.complianceFlags ?? []).filter(
      (f) => f.code === 'CUSTOM_FORBIDDEN' && f.term === 'SECRETWORD',
    );
    expect(secretWordFlags).toHaveLength(1);
  });

  it('fixes multi-delimiter segment check, gerund-after-comma, and CN risk-control bypasses in antiBanChecklist while preserving legitimate rules (Iter-4 Finding 2)', () => {
    const redditCtx = makePromptCtx({
      market: 'GLOBAL',
      provider: 'REDDIT_ASSIST',
      templateKey: 'REDDIT_DISCUSSION',
    });

    const rejectedEnItems = [
      'Avoid spam links, do not use clickbait, deploy a PRAW bot',
      'Avoid detection, try using a PRAW bot',
      'Avoid detection, consider running a bot script',
      'Avoid spam, consider running a bot script',
    ];
    for (const unsafeItem of rejectedEnItems) {
      const draft = finalizeRealLlmVariantDraft(
        JSON.stringify({
          variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
          variantMarkdown:
            'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
          antiBanChecklist: [unsafeItem],
        }),
        redditCtx,
      );
      const joined = (draft.variantExtrasJson.antiBanChecklist ?? []).join(' ').toLowerCase();
      expect(draft.variantExtrasJson.antiBanChecklist).not.toContain(unsafeItem);
      expect(joined).not.toContain('praw');
      expect(joined).not.toContain('bot script');
      expect(draft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);
    }

    const preservedEnItems = [
      'Avoid spam, write authentic replies, and never use PRAW',
      'Avoid using bots, PRAW, or automated posting scripts',
      'Avoid posting with bots',
      'Never use bots or auto-posting scripts',
      'Do not use PRAW or automated scraping/posting scripts',
    ];
    const preservedEnDraft = finalizeRealLlmVariantDraft(
      JSON.stringify({
        variantTitle: 'Hands-on notes comparing NebulaNAS vs Synology',
        variantMarkdown:
          'Tested NebulaNAS N4 at 21 dB load noise and 9W idle draw over two weeks with four drives.',
        antiBanChecklist: preservedEnItems,
      }),
      redditCtx,
    );
    expect(preservedEnDraft.variantExtrasJson.antiBanChecklist).toEqual(preservedEnItems);

    const cnCtx = makePromptCtx({
      market: 'CN',
      provider: 'CN_COMMUNITY_ASSIST',
      templateKey: 'CN_COMMUNITY_QA',
    });

    const rejectedCnDraft = finalizeRealLlmVariantDraft(
      JSON.stringify({
        variantTitle: '星云存储 N4 四盘位家用 NAS 实测噪音与功耗记录',
        variantMarkdown:
          '## 实测结论\n\n星云存储 N4 在四盘位满载下噪音为 21dB，待机功耗为 9W，配备双 2.5G 网口，适合客厅部署。',
        antiBanChecklist: ['避免被风控时使用自动发帖脚本'],
      }),
      cnCtx,
    );
    expect(rejectedCnDraft.variantExtrasJson.antiBanChecklist).not.toContain(
      '避免被风控时使用自动发帖脚本',
    );
    expect((rejectedCnDraft.variantExtrasJson.antiBanChecklist ?? []).join(' ')).not.toContain(
      '自动发帖脚本',
    );
    expect(rejectedCnDraft.variantExtrasJson.antiBanChecklist?.length).toBeGreaterThanOrEqual(3);

    const preservedCnItems = [
      '禁止在发帖时使用自动发帖脚本',
      '禁止使用自动发帖脚本或机器人',
      '如实披露品牌测试样机来源。',
    ];
    const preservedCnDraft = finalizeRealLlmVariantDraft(
      JSON.stringify({
        variantTitle: '星云存储 N4 四盘位家用 NAS 实测噪音与功耗记录',
        variantMarkdown:
          '## 实测结论\n\n星云存储 N4 在四盘位满载下噪音为 21dB，待机功耗为 9W，配备双 2.5G 网口，适合客厅部署。',
        antiBanChecklist: preservedCnItems,
      }),
      cnCtx,
    );
    expect(preservedCnDraft.variantExtrasJson.antiBanChecklist).toEqual(preservedCnItems);
  });

  describe('Async GeoVariantJob lifecycle & concurrency (#363)', () => {
    const savedConcurrency = process.env.GEO_VARIANT_CONCURRENCY;
    const savedTimeout = process.env.GEO_VARIANT_CHANNEL_TIMEOUT_MS;

    afterEach(() => {
      if (savedConcurrency === undefined) delete process.env.GEO_VARIANT_CONCURRENCY;
      else process.env.GEO_VARIANT_CONCURRENCY = savedConcurrency;
      if (savedTimeout === undefined) delete process.env.GEO_VARIANT_CHANNEL_TIMEOUT_MS;
      else process.env.GEO_VARIANT_CHANNEL_TIMEOUT_MS = savedTimeout;
    });

    it('creates a QUEUED async job immediately, replays in-progress job without 409/40902, and rejects different targets with 409', async () => {
      const { service, billingStub, enqueuedVariantJobs } = makeHarness({ unitPrice: 2 });
      const targets = [
        { provider: 'REDDIT_ASSIST' as const, channelLabel: 'Reddit' },
        { provider: 'QUORA_ASSIST' as const, channelLabel: 'Quora' },
        { provider: 'PR_PACKET' as const, channelLabel: 'PR / KOL Media Kit' },
      ];

      const created = await service.createVariantJob(
        'art_1',
        { targets },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem_async_1' },
      );

      expect(created.status).toBe('QUEUED');
      expect(created.total).toBe(3);
      expect(created.doneCount).toBe(0);
      expect(created.failCount).toBe(0);
      expect(created.replayed).toBe(false);
      expect(created.reservationId).toBe('res_gv_1');
      expect(billingStub.reserve).toHaveBeenCalledTimes(1);
      expect(billingStub.reserve).toHaveBeenCalledWith(expect.objectContaining({ amount: 6 }));
      expect(enqueuedVariantJobs).toEqual([{ tenantId: 't_1', jobId: created.id }]);

      // Immediate retry with same Idempotency-Key while job is QUEUED returns the in-progress job (NO 409!)
      const replayed = await service.createVariantJob(
        'art_1',
        { targets },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem_async_1' },
      );
      expect(replayed.id).toBe(created.id);
      expect(replayed.status).toBe('QUEUED');
      expect(replayed.replayed).toBe(true);
      expect(billingStub.reserve).toHaveBeenCalledTimes(1);
      expect(enqueuedVariantJobs).toHaveLength(1);

      // Reusing same Idempotency-Key with DIFFERENT targets still rejects with 409
      await expect(
        service.createVariantJob(
          'art_1',
          { targets: [{ provider: 'PR_PACKET', channelLabel: 'Different' }] },
          { tenantId: 't_1' },
          { idempotencyKey: 'idem_async_1' },
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('processes async job channels in parallel, updates progress & settles points, and exposes list/get', async () => {
      process.env.GEO_VARIANT_CONCURRENCY = '3';
      const { service, billingStub, storedTasks, reservationState } = makeHarness({ unitPrice: 2 });
      const targets = [
        {
          provider: 'SHOPIFY' as const,
          connectionId: 'conn_shopify',
          channelLabel: 'Shopify Blog',
        },
        { provider: 'REDDIT_ASSIST' as const, channelLabel: 'Reddit' },
        { provider: 'PR_PACKET' as const, channelLabel: 'PR / KOL Media Kit' },
      ];

      const created = await service.createVariantJob(
        'art_1',
        { targets },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem_async_parallel' },
      );

      await service.processVariantJob('t_1', created.id);

      const finalJob = await service.getVariantJob('art_1', created.id);
      expect(finalJob.status).toBe('COMPLETED');
      expect(finalJob.total).toBe(3);
      expect(finalJob.doneCount).toBe(3);
      expect(finalJob.failCount).toBe(0);
      expect(finalJob.totalChargedPoints).toBe(6);
      expect(finalJob.refundedPoints).toBe(0);
      expect(finalJob.taskIds).toHaveLength(3);
      expect(finalJob.finishedAt).toBeTruthy();
      expect(storedTasks.size).toBe(3);
      expect(reservationState.settled).toBe(6);
      expect(reservationState.released).toBe(0);
      expect(billingStub.close).toHaveBeenCalledTimes(1);

      const listed = await service.listVariantJobs('art_1');
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.id).toBe(created.id);
    });

    it('auto-refunds timed-out channel in async job while preserving succeeded channels (PARTIAL)', async () => {
      process.env.GEO_VARIANT_CONCURRENCY = '2';
      process.env.GEO_VARIANT_CHANNEL_TIMEOUT_MS = '1000';

      let callNum = 0;
      const slowLlm = {
        isLive: () => true,
        complete: vi
          .fn()
          .mockImplementation(async (_req: unknown, opts?: { signal?: AbortSignal }) => {
            callNum += 1;
            if (callNum === 2) {
              return new Promise((_resolve, reject) => {
                const onAbort = () => reject(new Error('aborted'));
                opts?.signal?.addEventListener('abort', onAbort, { once: true });
              });
            }
            return {
              text: JSON.stringify({
                variantTitle: 'NebulaNAS N4 Acoustic Bench Notes',
                variantMarkdown:
                  'NebulaNAS N4 measured 21 dB under load and 9W idle power with dual 2.5GbE.',
              }),
              provider: 'stub',
              model: 'stub-1',
              usage: { inputTokens: 100, outputTokens: 80 },
            };
          }),
      } as unknown as LlmService;

      const { service, reservationState } = makeHarness({ unitPrice: 3, llm: slowLlm });
      const created = await service.createVariantJob(
        'art_1',
        {
          targets: [
            { provider: 'REDDIT_ASSIST', channelLabel: 'Reddit' },
            { provider: 'QUORA_ASSIST', channelLabel: 'Quora' },
          ],
        },
        { tenantId: 't_1' },
        { idempotencyKey: 'idem_async_timeout' },
      );

      await service.processVariantJob('t_1', created.id);

      const finalJob = await service.getVariantJob('art_1', created.id);
      expect(finalJob.status).toBe('PARTIAL');
      expect(finalJob.doneCount).toBe(1);
      expect(finalJob.failCount).toBe(1);
      expect(finalJob.totalChargedPoints).toBe(3);
      expect(finalJob.refundedCount).toBe(1);
      expect(finalJob.refundedPoints).toBe(3);
      expect(finalJob.failures).toHaveLength(1);
      expect(finalJob.failures[0]?.error).toContain('超时');
      expect(reservationState.settled).toBe(3);
      expect(reservationState.released).toBe(3);
    });

    it('closes reservation and marks job FAILED with 503 if BullMQ enqueue fails', async () => {
      const { service, billingStub, variantEnqueuer, reservationState } = makeHarness({
        unitPrice: 2,
      });
      variantEnqueuer.enqueueVariantJob.mockRejectedValueOnce(new Error('Redis offline'));

      await expect(
        service.createVariantJob(
          'art_1',
          { targets: [{ provider: 'PR_PACKET', channelLabel: 'PR' }] },
          { tenantId: 't_1' },
          { idempotencyKey: 'idem_enqueue_fail' },
        ),
      ).rejects.toMatchObject({ status: 503 });

      expect(billingStub.close).toHaveBeenCalledTimes(1);
      expect(reservationState.released).toBe(2);
      const listed = await service.listVariantJobs('art_1');
      expect(listed.items[0]?.status).toBe('FAILED');
      expect(listed.items[0]?.refundedPoints).toBe(2);
    });
  });
});
