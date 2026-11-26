import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  API_ERROR,
  BILLING_ERROR,
  parseEnv,
  type DistributionPreflightResult,
  type GeoDistributionTaskDto,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { CrawlProbeService } from './crawl-probe.service';
import {
  DISTRIBUTION_ENQUEUER,
  type DistributionEnqueuer,
  type DistributionJobData,
} from './distribution.runner';
import {
  DistributionService,
  type GeoDistributionTaskWithRecordsDto,
  type PrShareLinkResultDto,
  type RevokePrShareResultDto,
  type UpdateRetestSchedulesResultDto,
} from './distribution.service';
import { RetestSchedulerService } from './retest-scheduler.service';
import { VariantGeneratorService, type GenerateVariantsResult } from './variant-generator.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type TenantRow = { id: string; name: string; isActive: boolean; expiresAt: Date };
type UserRow = {
  id: string;
  tenantId: string;
  username: string;
  nickname: string | null;
  role: string;
  status: string;
  passwordHash: string;
  lastLoginAt: Date | null;
};
type BrandRow = { id: string; tenantId: string; name: string; facts: Array<{ id: string }> };
type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale?: string;
  supportedLocales?: string[];
  localBrandName: string | null;
  aliases: string[];
};
type ArticleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  targetLocale?: string | null;
  title: string;
  contentMarkdown: string;
  geoScore: number | null;
  complianceFlags: unknown;
  brief: { matchedFactIds: string[] } | null;
};
type ConnectionRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  targetLocale?: string | null;
  status: string;
};
type TaskRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  connectionId: string | null;
  provider: string;
  mode: string;
  channelLabel: string;
  targetLocale?: string | null;
  targetUrlHint: string | null;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Record<string, unknown>;
  preflightJson: unknown;
  status: string;
  publishAsDraft: boolean;
  remotePostId: string | null;
  remoteAdminUrl: string | null;
  remotePublishedUrl: string | null;
  indexNowStatus: string | null;
  lastError: string | null;
  shareTokenHash: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type PublishRecordRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  distributionTaskId: string | null;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: unknown;
  afterMetrics: unknown;
  crawlStatus: string;
  crawlCheckedAt: Date | null;
  crawlReportJson: unknown;
  indexNowSubmitted: boolean;
  createdAt: Date;
  updatedAt: Date;
  retestSchedules: Array<{
    id: string;
    publishRecordId: string;
    milestoneDay: number;
    sampleCount: number;
    dueAt: Date;
    status: string;
    visibilityRunId: string | null;
    metricsSnapshotJson: unknown;
    skipReason: string | null;
    executedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

describe('DistributionController & DistributionService HTTP v2 (real ApiModule)', () => {
  const savedEnv = { ...process.env };
  let app: INestApplication;
  let baseUrl: string;
  let rateLimiter: FreeActionRateLimiter;
  let tokenA: string;
  let tokenB: string;
  let tokenExpired: string;

  const tenants = new Map<string, TenantRow>();
  const users = new Map<string, UserRow>();
  const brands = new Map<string, BrandRow>();
  const markets = new Map<string, BrandMarketRow>();
  const articles = new Map<string, ArticleRow>();
  const connections = new Map<string, ConnectionRow>();
  const tasks = new Map<string, TaskRow>();
  const publishRecords = new Map<string, PublishRecordRow>();

  let publishQuotaUsed = 0;
  let publishQuotaLimit = 10;
  let enqueuedJobs: DistributionJobData[] = [];
  let enqueueShouldFail = false;

  let generateVariantsSpy: MockInstance<VariantGeneratorService['generateVariants']>;
  let probeSpy: MockInstance<CrawlProbeService['probePublishRecord']>;
  let updateSchedulesSpy: MockInstance<RetestSchedulerService['updateSchedulesForPublishRecord']>;

  function seedState(): void {
    tenants.clear();
    users.clear();
    brands.clear();
    markets.clear();
    articles.clear();
    connections.clear();
    tasks.clear();
    publishRecords.clear();
    publishQuotaUsed = 0;
    publishQuotaLimit = 10;
    enqueuedJobs = [];
    enqueueShouldFail = false;
    rateLimiter?.reset();

    const future = new Date(Date.now() + 30 * 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const now = new Date();

    tenants.set('tenant_a', {
      id: 'tenant_a',
      name: 'Tenant A',
      isActive: true,
      expiresAt: future,
    });
    tenants.set('tenant_b', {
      id: 'tenant_b',
      name: 'Tenant B',
      isActive: true,
      expiresAt: future,
    });
    tenants.set('tenant_exp', {
      id: 'tenant_exp',
      name: 'Tenant Exp',
      isActive: true,
      expiresAt: past,
    });

    for (const [uid, tid] of [
      ['user_a', 'tenant_a'],
      ['user_b', 'tenant_b'],
      ['user_exp', 'tenant_exp'],
    ] as const) {
      users.set(uid, {
        id: uid,
        tenantId: tid,
        username: uid,
        nickname: uid,
        role: 'MERCHANT',
        status: 'ACTIVE',
        passwordHash: 'hashed_pw',
        lastLoginAt: null,
      });
    }

    brands.set('brand_a', {
      id: 'brand_a',
      tenantId: 'tenant_a',
      name: 'Acme',
      facts: [{ id: 'fact_1' }, { id: 'fact_2' }],
    });
    brands.set('brand_exp', {
      id: 'brand_exp',
      tenantId: 'tenant_exp',
      name: 'ExpBrand',
      facts: [{ id: 'fact_e1' }],
    });

    markets.set('bm_global', {
      id: 'bm_global',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      market: 'GLOBAL',
      localBrandName: 'Acme 品牌',
      aliases: ['Acme Global'],
    });
    markets.set('bm_exp', {
      id: 'bm_exp',
      tenantId: 'tenant_exp',
      brandId: 'brand_exp',
      market: 'GLOBAL',
      localBrandName: 'ExpBrand',
      aliases: [],
    });

    articles.set('art_clean', {
      id: 'art_clean',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      title: 'Acme 品牌 Portable Power Station Review 2026',
      contentMarkdown: 'Acme 品牌 delivers 1200Wh capacity with LiFePO4 cells.',
      geoScore: 88,
      complianceFlags: [],
      brief: { matchedFactIds: ['fact_1', 'fact_2'] },
    });
    articles.set('art_blocked', {
      id: 'art_blocked',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      title: 'Acme Review',
      contentMarkdown: 'Launch price is [TBD: launch price] with extra 中文正文泄露.',
      geoScore: 62,
      complianceFlags: [],
      brief: { matchedFactIds: ['fact_1'] },
    });
    articles.set('art_exp', {
      id: 'art_exp',
      tenantId: 'tenant_exp',
      brandId: 'brand_exp',
      brandMarketId: 'bm_exp',
      title: 'ExpBrand Guide',
      contentMarkdown: 'Clean content for expired tenant read-only check.',
      geoScore: 80,
      complianceFlags: [],
      brief: { matchedFactIds: ['fact_e1'] },
    });

    connections.set('conn_wp_ok', {
      id: 'conn_wp_ok',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      provider: 'WORDPRESS',
      displayName: 'Acme WP',
      siteBaseUrl: 'https://blog.acme.example',
      status: 'ACTIVE',
    });
    connections.set('conn_wp_disabled', {
      id: 'conn_wp_disabled',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      provider: 'WORDPRESS',
      displayName: 'Disabled WP',
      siteBaseUrl: 'https://old.acme.example',
      status: 'DISABLED',
    });
    connections.set('conn_wp_invalid', {
      id: 'conn_wp_invalid',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      provider: 'WORDPRESS',
      displayName: 'Invalid WP',
      siteBaseUrl: 'https://broken.acme.example',
      status: 'INVALID',
    });
    connections.set('conn_shopify', {
      id: 'conn_shopify',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      provider: 'SHOPIFY',
      displayName: 'Acme Shop',
      siteBaseUrl: 'https://shop.acme.example',
      status: 'ACTIVE',
    });

    tasks.set('task_wp_blocked', {
      id: 'task_wp_blocked',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      connectionId: 'conn_wp_ok',
      provider: 'WORDPRESS',
      mode: 'L1_API',
      channelLabel: 'Official Blog',
      targetUrlHint: null,
      variantTitle: 'Acme Review',
      variantSlug: 'acme-review',
      variantMetaDesc: 'Acme battery review with real test metrics.',
      variantMarkdown: 'Price is [TBD: price] right now.',
      variantHtml: '<p>Price is [TBD: price] right now.</p>',
      variantExtrasJson: { templateKey: 'OWNED_BLOG_SEO_GEO', _internalSecret: 'hidden' },
      preflightJson: null,
      status: 'READY_TO_PUBLISH',
      publishAsDraft: true,
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
    });

    tasks.set('task_wp_clean', {
      id: 'task_wp_clean',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      connectionId: 'conn_wp_ok',
      provider: 'WORDPRESS',
      mode: 'L1_API',
      channelLabel: 'Official Blog',
      targetUrlHint: null,
      variantTitle: 'Acme Power Station Review',
      variantSlug: 'acme-power-station-review',
      variantMetaDesc: 'Independent review of Acme Power Station with lab-verified numbers.',
      variantMarkdown: '# Acme Power Station\n\nLab-verified 1200Wh capacity.',
      variantHtml: '<h1>Acme Power Station</h1><p>Lab-verified 1200Wh capacity.</p>',
      variantExtrasJson: { templateKey: 'OWNED_BLOG_SEO_GEO', _batchKey: 'secret_internal' },
      preflightJson: { ok: true, blockers: [], warnings: [] },
      status: 'READY_TO_PUBLISH',
      publishAsDraft: false,
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
    });

    tasks.set('task_pr_1', {
      id: 'task_pr_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      connectionId: null,
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'Tech Review Media',
      targetUrlHint: null,
      variantTitle: 'Acme Media Briefing',
      variantSlug: null,
      variantMetaDesc: null,
      variantMarkdown: '# Media Brief\n\nVerified facts.',
      variantHtml: '<h1>Media Brief</h1><p>Verified facts.</p>',
      variantExtrasJson: { templateKey: 'PR_MEDIA_PACKET', _hidden: true },
      preflightJson: { ok: true, blockers: [], warnings: [] },
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
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
    });

    tasks.set('task_exp_1', {
      id: 'task_exp_1',
      tenantId: 'tenant_exp',
      brandId: 'brand_exp',
      brandMarketId: 'bm_exp',
      articleId: 'art_exp',
      connectionId: null,
      provider: 'PR_PACKET',
      mode: 'L3_PR_PACKET',
      channelLabel: 'PR',
      targetUrlHint: null,
      variantTitle: 'Exp PR',
      variantSlug: null,
      variantMetaDesc: null,
      variantMarkdown: '# Exp',
      variantHtml: '<h1>Exp</h1>',
      variantExtrasJson: { _internal: 1 },
      preflightJson: null,
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
      remotePostId: null,
      remoteAdminUrl: null,
      remotePublishedUrl: null,
      indexNowStatus: null,
      lastError: null,
      shareTokenHash: 'deadbeefhash',
      shareExpiresAt: future,
      shareRevokedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    publishRecords.set('pr_1', {
      id: 'pr_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      distributionTaskId: 'task_wp_clean',
      publishedUrl: 'https://blog.acme.example/acme-power-station-review',
      channel: 'Official Blog',
      publishedAt: now,
      baselineRunId: null,
      latestRetestRunId: null,
      beforeMetrics: null,
      afterMetrics: null,
      crawlStatus: 'PENDING',
      crawlCheckedAt: null,
      crawlReportJson: null,
      indexNowSubmitted: true,
      createdAt: now,
      updatedAt: now,
      retestSchedules: [
        {
          id: 'sched_30',
          publishRecordId: 'pr_1',
          milestoneDay: 30,
          sampleCount: 1,
          dueAt: future,
          status: 'PENDING',
          visibilityRunId: null,
          metricsSnapshotJson: null,
          skipReason: null,
          executedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'sched_7',
          publishRecordId: 'pr_1',
          milestoneDay: 7,
          sampleCount: 1,
          dueAt: future,
          status: 'PENDING',
          visibilityRunId: null,
          metricsSnapshotJson: null,
          skipReason: null,
          executedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  }

  function buildScopedClient() {
    const t = () => currentTenantId();

    const attachTaskRelations = (row: TaskRow) => ({
      ...row,
      article: articles.get(row.articleId) ?? null,
      brand: brands.get(row.brandId) ?? null,
      brandMarket: markets.get(row.brandMarketId) ?? null,
      connection: row.connectionId ? (connections.get(row.connectionId) ?? null) : null,
      publishRecords: [...publishRecords.values()]
        .filter((r) => r.tenantId === row.tenantId && r.distributionTaskId === row.id)
        .map((r) => ({
          ...r,
          retestSchedules: [...r.retestSchedules].sort((a, b) => a.milestoneDay - b.milestoneDay),
        })),
    });

    const client: Record<string, unknown> = {
      $disconnect: async () => undefined,
      auditLog: {
        findMany: async () => [],
        create: async () => ({ id: 'audit_1' }),
      },
      user: {
        findUnique: async (args: { where: { id?: string } }) => {
          const u = args.where.id ? users.get(args.where.id) : undefined;
          if (!u) return null;
          return { ...u, tenant: tenants.get(u.tenantId) };
        },
      },
      tenant: {
        findUnique: async (args: { where: { id: string } }) => tenants.get(args.where.id) ?? null,
      },
      geoArticle: {
        findFirst: async (args: { where: { id?: string } }) => {
          const tid = t();
          const a = args.where.id ? articles.get(args.where.id) : undefined;
          if (!a || a.tenantId !== tid) return null;
          return {
            ...a,
            brand: brands.get(a.brandId),
            brandMarket: markets.get(a.brandMarketId),
          };
        },
      },
      channelConnection: {
        findFirst: async (args: { where: { id?: string } }) => {
          const tid = t();
          const c = args.where.id ? connections.get(args.where.id) : undefined;
          if (!c || c.tenantId !== tid) return null;
          return { ...c };
        },
      },
      geoDistributionTask: {
        findFirst: async (args: { where: { id?: string } }) => {
          const tid = t();
          const row = args.where.id ? tasks.get(args.where.id) : undefined;
          if (!row || row.tenantId !== tid) return null;
          return attachTaskRelations(row);
        },
        findMany: async (args: { where: { articleId?: string } }) => {
          const tid = t();
          return [...tasks.values()]
            .filter(
              (row) =>
                row.tenantId === tid &&
                (!args.where.articleId || row.articleId === args.where.articleId),
            )
            .map(attachTaskRelations);
        },
        update: async (args: { where: { id: string }; data: Partial<TaskRow> }) => {
          const tid = t();
          const row = tasks.get(args.where.id);
          if (!row || row.tenantId !== tid) throw new Error('Not found');
          const next = { ...row, ...args.data, updatedAt: new Date() };
          tasks.set(row.id, next);
          return attachTaskRelations(next);
        },
        updateMany: async (args: {
          where: { id?: string; status?: string | { in: string[] } };
          data: Partial<TaskRow>;
        }) => {
          const tid = t();
          let count = 0;
          for (const row of tasks.values()) {
            if (row.tenantId !== tid) continue;
            if (args.where.id && row.id !== args.where.id) continue;
            if (typeof args.where.status === 'string' && row.status !== args.where.status) continue;
            if (
              args.where.status &&
              typeof args.where.status === 'object' &&
              'in' in args.where.status &&
              !args.where.status.in.includes(row.status)
            ) {
              continue;
            }
            Object.assign(row, args.data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      },
      $transaction: async <T>(fn: (tx: Record<string, unknown>) => Promise<T>) => {
        // Snapshot tasks for rollback simulation if quota fails
        const snapshot = new Map<string, TaskRow>();
        for (const [k, v] of tasks.entries()) {
          snapshot.set(k, { ...v, variantExtrasJson: { ...v.variantExtrasJson } });
        }
        try {
          return await fn(client);
        } catch (err) {
          tasks.clear();
          for (const [k, v] of snapshot.entries()) {
            tasks.set(k, v);
          }
          throw err;
        }
      },
    };
    return client;
  }

  beforeAll(async () => {
    process.env.PUBLIC_APP_URL = 'https://app.geomix.example/';
    const env = parseEnv(process.env);
    app = await createApiApp();

    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };
    const scopedClient = buildScopedClient();
    prismaSvc.base = scopedClient;
    prismaSvc.scoped = scopedClient;

    const quotaSvc = app.get(QuotaService);
    vi.spyOn(quotaSvc, 'consume').mockImplementation(async (_tid, key, amount) => {
      if (key === 'PUBLISH') {
        if (publishQuotaUsed + amount > publishQuotaLimit) {
          throw new ApiError(409, API_ERROR.QUOTA_EXCEEDED, '发布额度已用尽');
        }
        publishQuotaUsed += amount;
      }
      return {
        key,
        used: BigInt(publishQuotaUsed),
        limit: BigInt(publishQuotaLimit),
      };
    });

    const enqueuer = app.get<DistributionEnqueuer>(DISTRIBUTION_ENQUEUER);
    vi.spyOn(enqueuer, 'enqueueDistribution').mockImplementation(async (job) => {
      if (enqueueShouldFail) {
        throw new Error('Redis down');
      }
      enqueuedJobs.push(job);
    });

    const variantSvc = app.get(VariantGeneratorService);
    generateVariantsSpy = vi
      .spyOn(variantSvc, 'generateVariants')
      .mockImplementation(async (articleId): Promise<GenerateVariantsResult> => ({
        articleId,
        unitPrice: 2,
        totalChargedPoints: 2,
        refundedCount: 0,
        refundedPoints: 0,
        reservationId: 'res_1',
        billingMode: 'SHADOW',
        replayed: false,
        tasks: [],
        failures: [],
      }));

    const crawlSvc = app.get(CrawlProbeService);
    probeSpy = vi
      .spyOn(crawlSvc, 'probePublishRecord')
      .mockImplementation(async (publishRecordId): Promise<GeoPublishRecordDto> => ({
        id: publishRecordId,
        brandId: 'brand_a',
        brandMarketId: 'bm_global',
        articleId: 'art_clean',
        publishedUrl: 'https://blog.acme.example/acme-power-station-review',
        channel: 'Official Blog',
        publishedAt: new Date().toISOString(),
        baselineRunId: null,
        latestRetestRunId: null,
        beforeMetrics: null,
        afterMetrics: null,
        distributionTaskId: 'task_wp_clean',
        crawlStatus: 'OK',
        crawlCheckedAt: new Date().toISOString(),
        crawlReportJson: null,
        indexNowSubmitted: true,
        retestSchedules: [],
      }));

    const retestSvc = app.get(RetestSchedulerService);
    updateSchedulesSpy = vi
      .spyOn(retestSvc, 'updateSchedulesForPublishRecord')
      .mockImplementation(async (publishRecordId, input) => [
        {
          id: 'sched_1',
          publishRecordId,
          milestoneDay: 7,
          sampleCount: input.sampleCount ?? 1,
          dueAt: new Date().toISOString(),
          status: 'PENDING',
          visibilityRunId: null,
          metricsSnapshot: null,
          skipReason: null,
          executedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    rateLimiter = app.get(FreeActionRateLimiter);

    const fp = passwordFingerprint('hashed_pw');
    const nowSec = Math.floor(Date.now() / 1000);
    const mint = (sub: string, tid: string) =>
      signToken(
        {
          sub,
          tid,
          role: 'MERCHANT',
          typ: 'access',
          fp,
          lms: Date.now(),
          iat: nowSec,
          exp: nowSec + 3600,
        },
        env.JWT_ACCESS_SECRET,
      );

    tokenA = mint('user_a', 'tenant_a');
    tokenB = mint('user_b', 'tenant_b');
    tokenExpired = mint('user_exp', 'tenant_exp');
  });

  beforeEach(() => {
    seedState();
    generateVariantsSpy.mockClear();
    probeSpy.mockClear();
    updateSchedulesSpy.mockClear();
  });

  afterAll(async () => {
    rateLimiter?.reset();
    if (app) await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  async function req<T>(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as Envelope<T>;
    return { status: res.status, body: json };
  }

  it('boots ApiModule with DistributionService wired and runs preflight with blocker/warning/brand-name/guard checks', async () => {
    expect(app.get(DistributionService)).toBeInstanceOf(DistributionService);

    // Clean GLOBAL article with Chinese brand proper noun passes preflight
    const clean = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      {},
    );
    expect(clean.status).toBe(200);
    expect(clean.body.data.ok).toBe(true);
    expect(clean.body.data.blockers).toHaveLength(0);

    // Blocked article detects [TBD] + stray CJK leak + low geoScore warning
    const blocked = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_blocked/preflight',
      tokenA,
    );
    expect(blocked.status).toBe(200);
    expect(blocked.body.data.ok).toBe(false);
    const codes = blocked.body.data.blockers.map((b) => b.code);
    expect(codes).toContain('MISSING_FACT_SLOTS');
    expect(codes).toContain('GLOBAL_CJK_LEAK');

    // Cross-tenant returns 404, expired tenant write returns 403/40301, anonymous returns 401
    expect((await req('POST', '/api/v2/articles/art_clean/preflight', tokenB)).status).toBe(404);
    const exp = await req('POST', '/api/v2/articles/art_exp/preflight', tokenExpired);
    expect(exp.status).toBe(403);
    expect(exp.body.code).toBe(API_ERROR.TENANT_EXPIRED);
    expect((await req('POST', '/api/v2/articles/art_clean/preflight')).status).toBe(401);
  });

  it('lists article distributions read-only (even for expired tenant), sorts retestSchedules, and strips private keys', async () => {
    const res = await req<{ items: GeoDistributionTaskWithRecordsDto[] }>(
      'GET',
      '/api/v2/articles/art_clean/distributions',
      tokenA,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(3);
    const wpTask = res.body.data.items.find((t) => t.id === 'task_wp_clean');
    expect(wpTask).toBeDefined();
    expect(wpTask?.variantExtrasJson).not.toHaveProperty('_batchKey');
    expect(wpTask).not.toHaveProperty('shareTokenHash');
    expect(wpTask).not.toHaveProperty('tenantId');
    expect(wpTask?.publishRecords).toHaveLength(1);
    expect(wpTask?.publishRecords[0]?.retestSchedules?.map((s) => s.milestoneDay)).toEqual([7, 30]);

    // Expired tenant can still read GET /distributions
    const expRes = await req<{ items: GeoDistributionTaskWithRecordsDto[] }>(
      'GET',
      '/api/v2/articles/art_exp/distributions',
      tokenExpired,
    );
    expect(expRes.status).toBe(200);
    expect(expRes.body.data.items[0]?.shareLinkActive).toBe(true);
    expect(expRes.body.data.items[0]).not.toHaveProperty('shareTokenHash');

    // Cross-tenant 404
    expect((await req('GET', '/api/v2/articles/art_clean/distributions', tokenB)).status).toBe(404);
  });

  it('delegates variants generation with optional Idempotency-Key and validates bad header', async () => {
    const res = await req<GenerateVariantsResult>(
      'POST',
      '/api/v2/articles/art_clean/distributions/variants',
      tokenA,
      { targets: [{ provider: 'WORDPRESS', channelLabel: 'Official Blog' }] },
      { 'Idempotency-Key': 'idem_var_001' },
    );
    expect(res.status).toBe(200);
    expect(generateVariantsSpy).toHaveBeenCalledWith(
      'art_clean',
      expect.objectContaining({ targets: expect.any(Array) }),
      expect.objectContaining({ tenantId: 'tenant_a' }),
      { idempotencyKey: 'idem_var_001' },
    );

    const badHdr = await req(
      'POST',
      '/api/v2/articles/art_clean/distributions/variants',
      tokenA,
      { targets: [{ provider: 'WORDPRESS', channelLabel: 'Official Blog' }] },
      { 'Idempotency-Key': '   ' },
    );
    expect(badHdr.status).toBe(400);
  });

  it('updates task markdown/HTML + recomputes preflightJson, blocks PUBLISHING edits (409), and validates connectionId', async () => {
    const okPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_blocked',
      tokenA,
      { variantMarkdown: '# Fixed\n\nLaunch price is $599.' },
    );
    expect(okPatch.status).toBe(200);
    expect(okPatch.body.data.variantHtml).toContain('<h2>Fixed</h2>');
    expect(okPatch.body.data.variantHtml).toContain('<p>Launch price is $599.</p>');
    expect(okPatch.body.data.preflightJson?.ok).toBe(true);

    const sanitizedHtmlPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_blocked',
      tokenA,
      { variantHtml: '<script>alert(1)</script><p>Sanitized Body</p>' },
    );
    expect(sanitizedHtmlPatch.status).toBe(200);
    expect(sanitizedHtmlPatch.body.data.variantHtml).toContain('<p>Sanitized Body</p>');
    expect(sanitizedHtmlPatch.body.data.variantHtml).not.toContain('<script>');

    // Mismatched provider connection -> 400
    const badConn = await req('PATCH', '/api/v2/distributions/task_wp_blocked', tokenA, {
      connectionId: 'conn_shopify',
    });
    expect(badConn.status).toBe(400);

    // Disabled connection rebind -> 400
    const disabledConn = await req('PATCH', '/api/v2/distributions/task_wp_blocked', tokenA, {
      connectionId: 'conn_wp_disabled',
    });
    expect(disabledConn.status).toBe(400);

    // Tier 5 #4: Saving edits with unchanged DISABLED connectionId succeeds (publish still blocks)
    const prevConnId = tasks.get('task_wp_blocked')!.connectionId;
    tasks.get('task_wp_blocked')!.connectionId = 'conn_wp_disabled';
    const unchangedDisabledPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_blocked',
      tokenA,
      {
        variantTitle: 'Edited While Connection Paused',
        connectionId: 'conn_wp_disabled',
      },
    );
    expect(unchangedDisabledPatch.status).toBe(200);
    expect(unchangedDisabledPatch.body.data.variantTitle).toBe('Edited While Connection Paused');
    tasks.get('task_wp_blocked')!.connectionId = prevConnId;

    // INVALID connection -> 400 (consistent with publishTask)
    const invalidConn = await req('PATCH', '/api/v2/distributions/task_wp_blocked', tokenA, {
      connectionId: 'conn_wp_invalid',
    });
    expect(invalidConn.status).toBe(400);
    expect(invalidConn.body.code).toBe(API_ERROR.BAD_REQUEST);

    // PUBLISHING task -> 409
    tasks.get('task_wp_blocked')!.status = 'PUBLISHING';
    const publishingPatch = await req('PATCH', '/api/v2/distributions/task_wp_blocked', tokenA, {
      variantTitle: 'Nope',
    });
    expect(publishingPatch.status).toBe(409);
    expect(publishingPatch.body.code).toBe(BILLING_ERROR.CONFLICT);
  });

  it('enforces PUBLISHED/ARCHIVED terminal state guards and stamps shareRevokedAt on PR task archive', async () => {
    // 1. PUBLISHED task rejects status downgrade, content edit, and mixed archive+edit with 409
    const wpTask = tasks.get('task_wp_clean')!;
    wpTask.status = 'PUBLISHED';
    wpTask.remotePostId = 'wp_900';
    wpTask.remotePublishedUrl = 'https://blog.acme.example/acme-power-station-review';
    wpTask.publishedAt = new Date();

    const revertPublished = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      status: 'READY_TO_PUBLISH',
    });
    expect(revertPublished.status).toBe(409);
    expect(revertPublished.body.code).toBe(BILLING_ERROR.CONFLICT);

    const revertPublishedDraft = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      status: 'DRAFT_VARIANT',
    });
    expect(revertPublishedDraft.status).toBe(409);
    expect(revertPublishedDraft.body.code).toBe(BILLING_ERROR.CONFLICT);

    const editPublished = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      variantTitle: 'Tampered Title After Publish',
    });
    expect(editPublished.status).toBe(409);
    expect(editPublished.body.code).toBe(BILLING_ERROR.CONFLICT);

    const mixedArchivePublished = await req(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      { status: 'ARCHIVED', variantTitle: 'Tampered While Archiving' },
    );
    expect(mixedArchivePublished.status).toBe(409);
    expect(mixedArchivePublished.body.code).toBe(BILLING_ERROR.CONFLICT);

    const mixedArchiveConn = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      status: 'ARCHIVED',
      connectionId: 'conn_wp',
    });
    expect(mixedArchiveConn.status).toBe(409);
    expect(mixedArchiveConn.body.code).toBe(BILLING_ERROR.CONFLICT);

    // 2. Pure PUBLISHED -> ARCHIVED transition succeeds (200)
    const pureArchivePublished = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      { status: 'ARCHIVED' },
    );
    expect(pureArchivePublished.status).toBe(200);
    expect(pureArchivePublished.body.data.status).toBe('ARCHIVED');

    // 3. ARCHIVED task is immutable: rejects un-archiving and content edits with 409
    const reviveArchived = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      status: 'DRAFT_VARIANT',
    });
    expect(reviveArchived.status).toBe(409);
    expect(reviveArchived.body.code).toBe(BILLING_ERROR.CONFLICT);

    const editArchived = await req('PATCH', '/api/v2/distributions/task_wp_clean', tokenA, {
      variantTitle: 'Edit Archived',
    });
    expect(editArchived.status).toBe(409);
    expect(editArchived.body.code).toBe(BILLING_ERROR.CONFLICT);

    // 4. Archiving a PR task with an active share link permanently stamps shareRevokedAt
    const issued = await req<PrShareLinkResultDto>(
      'POST',
      '/api/v2/distributions/task_pr_1/pr-share',
      tokenA,
      { ttlDays: 7 },
    );
    expect(issued.status).toBe(200);
    expect(tasks.get('task_pr_1')?.shareTokenHash).toBeTruthy();
    expect(tasks.get('task_pr_1')?.shareRevokedAt).toBeNull();

    const archivePr = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_pr_1',
      tokenA,
      { status: 'ARCHIVED' },
    );
    expect(archivePr.status).toBe(200);
    expect(archivePr.body.data.status).toBe('ARCHIVED');
    expect(archivePr.body.data.shareLinkActive).toBe(false);
    expect(tasks.get('task_pr_1')?.shareRevokedAt).toBeInstanceOf(Date);

    // Attempting to un-archive PR task to revive dead share token is blocked with 409
    const revivePr = await req('PATCH', '/api/v2/distributions/task_pr_1', tokenA, {
      status: 'DRAFT_VARIANT',
    });
    expect(revivePr.status).toBe(409);
    expect(revivePr.body.code).toBe(BILLING_ERROR.CONFLICT);
  });

  it('enforces 422 structured preflight blockers on publish, supports ack override, Idempotency-Key replay/conflict, PUBLISH quota, and 503 enqueue rollback', async () => {
    // 1. Hard blocker -> HTTP 422 with structured data { ok: false, blockers, warnings, preflight }
    const blocked = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
      preflight: DistributionPreflightResult;
    }>('POST', '/api/v2/distributions/task_wp_blocked/publish', tokenA, {
      publishAsDraft: false,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe(API_ERROR.BAD_REQUEST);
    expect(blocked.body.data.ok).toBe(false);
    expect(blocked.body.data.blockers[0]?.code).toBe('MISSING_FACT_SLOTS');
    expect(blocked.body.data.preflight.ok).toBe(false);
    expect(publishQuotaUsed).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);

    // 2. Acknowledge override -> succeeds, consumes 1 PUBLISH quota, enqueues 1 job
    const overridden = await req<GeoDistributionTaskDto>(
      'POST',
      '/api/v2/distributions/task_wp_blocked/publish',
      tokenA,
      { publishAsDraft: false, acknowledgePreflightWarnings: true },
      { 'Idempotency-Key': 'pub_idem_1' },
    );
    expect(overridden.status).toBe(200);
    expect(overridden.body.data.status).toBe('PUBLISHING');
    expect(publishQuotaUsed).toBe(1);
    expect(enqueuedJobs).toEqual([{ tenantId: 'tenant_a', taskId: 'task_wp_blocked' }]);

    // 3. Same Idempotency-Key + same params -> idempotent replay (0 extra quota, 0 extra enqueue)
    const replay = await req<GeoDistributionTaskDto>(
      'POST',
      '/api/v2/distributions/task_wp_blocked/publish',
      tokenA,
      { publishAsDraft: false, acknowledgePreflightWarnings: true },
      { 'Idempotency-Key': 'pub_idem_1' },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe('PUBLISHING');
    expect(publishQuotaUsed).toBe(1);
    expect(enqueuedJobs).toHaveLength(1);

    // 4. Same Idempotency-Key + different params -> 409 CONFLICT
    const conflict = await req(
      'POST',
      '/api/v2/distributions/task_wp_blocked/publish',
      tokenA,
      { publishAsDraft: true, acknowledgePreflightWarnings: true },
      { 'Idempotency-Key': 'pub_idem_1' },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(BILLING_ERROR.CONFLICT);

    // 5. Quota exceeded -> 409 / 40901 and status rolled back
    publishQuotaUsed = publishQuotaLimit;
    const quotaFail = await req('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {});
    expect(quotaFail.status).toBe(409);
    expect(quotaFail.body.code).toBe(API_ERROR.QUOTA_EXCEEDED);
    expect(tasks.get('task_wp_clean')?.status).toBe('READY_TO_PUBLISH');

    // 6. Enqueue failure -> transitions to FAILED, clears idempotency key, returns 503
    publishQuotaUsed = 0;
    enqueueShouldFail = true;
    const enqFail = await req(
      'POST',
      '/api/v2/distributions/task_wp_clean/publish',
      tokenA,
      {},
      { 'Idempotency-Key': 'pub_idem_fail' },
    );
    expect(enqFail.status).toBe(503);
    expect(enqFail.body.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
    expect(tasks.get('task_wp_clean')?.status).toBe('FAILED');
    expect(tasks.get('task_wp_clean')?.variantExtrasJson).not.toHaveProperty(
      '_publishIdempotencyKey',
    );
  });

  it('issues SHA-256 hashed PR share link, never leaks hash in list, and revokes with non-null JSON', async () => {
    // Non-PR task rejected with 400
    expect(
      (await req('POST', '/api/v2/distributions/task_wp_clean/pr-share', tokenA, {})).status,
    ).toBe(400);

    const issued = await req<PrShareLinkResultDto>(
      'POST',
      '/api/v2/distributions/task_pr_1/pr-share',
      tokenA,
      { ttlDays: 14 },
    );
    expect(issued.status).toBe(200);
    expect(issued.body.data.taskId).toBe('task_pr_1');
    expect(issued.body.data.ttlDays).toBe(14);
    expect(issued.body.data.shareUrl).toBe(
      `https://app.geomix.example/share/pr/${issued.body.data.token}`,
    );

    const expectedHash = createHash('sha256').update(issued.body.data.token, 'utf8').digest('hex');
    expect(tasks.get('task_pr_1')?.shareTokenHash).toBe(expectedHash);
    expect(tasks.get('task_pr_1')?.shareRevokedAt).toBeNull();

    const listAfter = await req<{ items: GeoDistributionTaskWithRecordsDto[] }>(
      'GET',
      '/api/v2/articles/art_clean/distributions',
      tokenA,
    );
    const prItem = listAfter.body.data.items.find((t) => t.id === 'task_pr_1');
    expect(prItem?.shareLinkActive).toBe(true);
    expect(JSON.stringify(prItem)).not.toContain(expectedHash);
    expect(JSON.stringify(prItem)).not.toContain(issued.body.data.token);

    const revoked = await req<RevokePrShareResultDto>(
      'DELETE',
      '/api/v2/distributions/task_pr_1/pr-share',
      tokenA,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.taskId).toBe('task_pr_1');
    expect(revoked.body.data.revoked).toBe(true);
    expect(typeof revoked.body.data.revokedAt).toBe('string');
    expect(tasks.get('task_pr_1')?.shareRevokedAt).toBeInstanceOf(Date);
  });

  it('delegates crawl-probe and retest-schedules endpoints cleanly', async () => {
    const probe = await req<GeoPublishRecordDto>(
      'POST',
      '/api/v2/publish-records/pr_1/crawl-probe',
      tokenA,
    );
    expect(probe.status).toBe(200);
    expect(probe.body.data.crawlStatus).toBe('OK');
    expect(probeSpy).toHaveBeenCalledWith('pr_1', {
      tenantId: 'tenant_a',
      enforceRateLimit: true,
    });

    const sched = await req<UpdateRetestSchedulesResultDto>(
      'PATCH',
      '/api/v2/publish-records/pr_1/retest-schedules',
      tokenA,
      { sampleCount: 3, milestones: [7, 14] },
    );
    expect(sched.status).toBe(200);
    expect(sched.body.data.publishRecordId).toBe('pr_1');
    expect(sched.body.data.items[0]?.sampleCount).toBe(3);
    expect(updateSchedulesSpy).toHaveBeenCalledWith('pr_1', {
      sampleCount: 3,
      milestones: [7, 14],
    });
  });

  it('S-04: scans variantMetaDesc for compliance blockers, missing-fact slots, and GLOBAL CJK leaks on preflight, PATCH, and POST /publish', async () => {
    // 1. preflightArticle with prohibited term in variantMetaDesc
    const pfRes = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      {
        provider: 'WORDPRESS',
        variantSlug: 'acme-power-station',
        variantMetaDesc: 'Illegal gambling guide [TBD] 中文摘要',
      },
    );
    expect(pfRes.status).toBe(200);
    expect(pfRes.body.data.ok).toBe(false);
    const pfCodes = pfRes.body.data.blockers.map((b) => b.code);
    expect(pfCodes).toContain('MISSING_FACT_SLOTS');
    expect(pfCodes).toContain('GLOBAL_CJK_LEAK');
    expect(pfCodes).toContain('COMPLIANCE_BLOCKED');

    // 2. PATCH task_wp_clean with prohibited compliance term + placeholder in variantMetaDesc -> preflightJson records blockers
    const patchRes = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      {
        variantMetaDesc: 'Illegal gambling guide [TBD: price]',
      },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.preflightJson?.ok).toBe(false);
    expect(patchRes.body.data.preflightJson?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'COMPLIANCE_BLOCKED']),
    );

    // 3. POST /publish rejects with HTTP 422 including both COMPLIANCE_BLOCKED and MISSING_FACT_SLOTS
    const pubRes = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {
      publishAsDraft: false,
      connectionId: 'conn_wp_ok',
    });
    expect(pubRes.status).toBe(422);
    expect(pubRes.body.data.ok).toBe(false);
    expect(pubRes.body.data.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'COMPLIANCE_BLOCKED']),
    );
  });

  it('R2-S-02: blocks variantHtml-only placeholders, GLOBAL CJK leaks, entity-encoded placeholders, and prohibited compliance terms on PATCH and POST /publish with 422 and 0 enqueued jobs', async () => {
    const enqueuedBefore = enqueuedJobs.length;

    // 1. PATCH task_wp_clean with clean variantMarkdown left untouched, injecting blockers ONLY into variantHtml
    const patchRes = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      {
        variantHtml:
          '<p>Verified? &#91;TBD&#58; official price&#93; 【待补充：续航】 中文未翻译内容 在线赌博 博彩网站</p>',
      },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.preflightJson?.ok).toBe(false);
    expect(patchRes.body.data.preflightJson?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );

    // 2. POST /publish MUST reject with HTTP 422 and enqueue 0 distribution jobs
    const pubRes = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {
      publishAsDraft: false,
      connectionId: 'conn_wp_ok',
    });
    expect(pubRes.status).toBe(422);
    expect(pubRes.body.data.ok).toBe(false);
    expect(pubRes.body.data.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );
    expect(enqueuedJobs).toHaveLength(enqueuedBefore);
    expect(tasks.get('task_wp_clean')?.status).toBe('READY_TO_PUBLISH');
  });

  it('R3-S-01: blocks literal `<` technical copy and HTML5 uppercase/leading-zero/named entities in variantHtml on PATCH and POST /publish with 422 and 0 enqueued jobs', async () => {
    const enqueuedBefore = enqueuedJobs.length;

    // 1. Literal `< 100` followed by [TBD], GLOBAL CJK leak, and prohibited compliance term
    const ltPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      {
        variantHtml: '<p>Price < 100 [TBD: official price] 中文泄漏 在线赌博</p>',
      },
    );
    expect(ltPatch.status).toBe(200);
    expect(ltPatch.body.data.preflightJson?.ok).toBe(false);
    expect(ltPatch.body.data.preflightJson?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );

    const ltPub = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {
      publishAsDraft: false,
      connectionId: 'conn_wp_ok',
    });
    expect(ltPub.status).toBe(422);
    expect(ltPub.body.data.ok).toBe(false);
    expect(ltPub.body.data.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );
    expect(enqueuedJobs).toHaveLength(enqueuedBefore);
    expect(tasks.get('task_wp_clean')?.status).toBe('READY_TO_PUBLISH');

    // 2. HTML5 uppercase hex, leading-zero numeric entities, and &lsqb;/&rsqb; aliases
    const entityPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      {
        variantHtml:
          '<p>&#X5B;TBD: price&#X5D; &#x000005b;TBD&#x000005d; &lsqb;TBD&rsqb; &#X5728;&#X7EBF;&#X8D4C;&#X535A;</p>',
      },
    );
    expect(entityPatch.status).toBe(200);
    expect(entityPatch.body.data.preflightJson?.ok).toBe(false);
    expect(entityPatch.body.data.preflightJson?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );

    const entityPub = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {
      publishAsDraft: false,
      connectionId: 'conn_wp_ok',
    });
    expect(entityPub.status).toBe(422);
    expect(entityPub.body.data.ok).toBe(false);
    expect(entityPub.body.data.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );
    expect(enqueuedJobs).toHaveLength(enqueuedBefore);
    expect(tasks.get('task_wp_clean')?.status).toBe('READY_TO_PUBLISH');
  });

  it('W3-S-01: blocks semicolon-less HTML5 numeric entities in variantHtml on PATCH and POST /publish with 422 and 0 enqueued jobs', async () => {
    const enqueuedBefore = enqueuedJobs.length;

    const patchRes = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      {
        variantHtml: '<p>&#91TBD: official price&#93 &#22312&#32447&#36172&#21338</p>',
      },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.preflightJson?.ok).toBe(false);
    expect(patchRes.body.data.preflightJson?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );

    const pubRes = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_wp_clean/publish', tokenA, {
      publishAsDraft: false,
      connectionId: 'conn_wp_ok',
    });
    expect(pubRes.status).toBe(422);
    expect(pubRes.body.data.ok).toBe(false);
    expect(pubRes.body.data.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['MISSING_FACT_SLOTS', 'GLOBAL_CJK_LEAK', 'COMPLIANCE_BLOCKED']),
    );
    expect(enqueuedJobs).toHaveLength(enqueuedBefore);
    expect(tasks.get('task_wp_clean')?.status).toBe('READY_TO_PUBLISH');
  });

  it('Issue #363: exposes POST/GET /articles/:articleId/distributions/variant-jobs and enforces TenantActiveGuard on write', async () => {
    const variantSvc = app.get(VariantGeneratorService);
    const sampleJob = {
      id: 'gvj_http_1',
      articleId: 'art_clean',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      status: 'QUEUED' as const,
      total: 2,
      doneCount: 0,
      failCount: 0,
      unitPrice: 2,
      totalChargedPoints: 0,
      refundedCount: 0,
      refundedPoints: 0,
      reservationId: 'res_gvj_1',
      billingMode: 'SHADOW' as const,
      replayed: false,
      taskIds: [],
      failures: [],
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    };

    const createSpy = vi.spyOn(variantSvc, 'createVariantJob').mockResolvedValueOnce(sampleJob);
    const listSpy = vi
      .spyOn(variantSvc, 'listVariantJobs')
      .mockResolvedValueOnce({ items: [sampleJob] });
    const getSpy = vi.spyOn(variantSvc, 'getVariantJob').mockResolvedValueOnce({
      ...sampleJob,
      status: 'COMPLETED',
      doneCount: 2,
      totalChargedPoints: 4,
      taskIds: ['task_1', 'task_2'],
    });

    const postRes = await req<typeof sampleJob>(
      'POST',
      '/api/v2/articles/art_clean/distributions/variant-jobs',
      tokenA,
      {
        targets: [
          { provider: 'REDDIT_ASSIST', channelLabel: 'Reddit' },
          { provider: 'PR_PACKET', channelLabel: 'PR / KOL Media Kit' },
        ],
      },
      { 'Idempotency-Key': 'dist_var_http_test_1' },
    );
    expect(postRes.status).toBe(200);
    expect(postRes.body.code).toBe(0);
    expect(postRes.body.data.id).toBe('gvj_http_1');
    expect(postRes.body.data.status).toBe('QUEUED');
    expect(createSpy).toHaveBeenCalledWith(
      'art_clean',
      expect.objectContaining({ targets: expect.any(Array) }),
      expect.objectContaining({ tenantId: 'tenant_a' }),
      expect.objectContaining({ idempotencyKey: 'dist_var_http_test_1' }),
    );

    const listRes = await req<{ items: Array<typeof sampleJob> }>(
      'GET',
      '/api/v2/articles/art_clean/distributions/variant-jobs',
      tokenA,
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.items).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith('art_clean');

    const getRes = await req<typeof sampleJob>(
      'GET',
      '/api/v2/articles/art_clean/distributions/variant-jobs/gvj_http_1',
      tokenA,
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.status).toBe('COMPLETED');
    expect(getRes.body.data.doneCount).toBe(2);
    expect(getSpy).toHaveBeenCalledWith('art_clean', 'gvj_http_1');

    // Expired tenant blocked on POST with 403 / 40301
    const expRes = await req(
      'POST',
      '/api/v2/articles/art_exp/distributions/variant-jobs',
      tokenExpired,
      { targets: [{ provider: 'PR_PACKET', channelLabel: 'PR' }] },
    );
    expect(expRes.status).toBe(403);
    expect(expRes.body.code).toBe(40301);

    createSpy.mockRestore();
    listSpy.mockRestore();
    getSpy.mockRestore();
  });

  it('Issue #365: flags English exaggerated medical/financial claims as blockers and superlatives as warnings on GLOBAL preflight', async () => {
    const res = await req<{
      ok: boolean;
      blockers: Array<{
        code: string;
        details?: string[];
        matches?: Array<{ matchedText: string }>;
      }>;
      warnings: Array<{
        code: string;
        details?: string[];
        matches?: Array<{ matchedText: string }>;
      }>;
    }>('POST', '/api/v2/articles/art_clean/preflight', tokenA, {
      title: 'Acme Review',
      contentMarkdown: 'Guaranteed #1 cure-all miracle! 100% safe and risk-free for everyone.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.blockers.some((b) => b.code === 'COMPLIANCE_BLOCKED')).toBe(true);
    expect(res.body.data.warnings.some((w) => w.code === 'GLOBAL_CLAIM_WARNING')).toBe(true);
  });

  it('M3B (#370): runs locale-aware preflight, PATCH targetLocale + WeChat HTML re-render, and ja-JP vs Latin CJK publish gating', async () => {
    const bmGlobal = markets.get('bm_global')!;
    bmGlobal.locale = 'en-US';
    bmGlobal.supportedLocales = ['en-US', 'de-DE', 'ja-JP'];

    // 1. POST /articles/:id/preflight with targetLocale='ja-JP' -> Kanji+Kana passes with 0 false positives!
    const jaPreflightOk = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      {
        targetLocale: 'ja-JP',
        title: 'Acme ポータブル電源 2026年 検証レビュー',
        contentMarkdown:
          'Acme は 1200Wh の大容量と LiFePO4 バッテリーを備え、静音性と安全性を検証済みです。',
      },
    );
    expect(jaPreflightOk.status).toBe(200);
    expect(jaPreflightOk.body.data.ok).toBe(true);
    expect(jaPreflightOk.body.data.blockers).toEqual([]);

    // ja-JP with Simplified Chinese leak -> blocked with GLOBAL_CJK_LEAK
    const jaPreflightLeak = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      {
        targetLocale: 'ja-JP',
        title: 'Acme 评测结论',
        contentMarkdown: '这里混入了简体中文评测结论，请尽快修正。',
      },
    );
    expect(jaPreflightLeak.status).toBe(200);
    expect(jaPreflightLeak.body.data.ok).toBe(false);
    expect(jaPreflightLeak.body.data.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(true);

    // de-DE with German diacritics passes, with Chinese leak blocks; cross-market zh-CN override returns 400
    const dePreflightOk = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      {
        targetLocale: 'de-DE',
        title: 'Acme Übersicht für Stromspeicher',
        contentMarkdown: 'Geprüfte Kapazität von 1200Wh für zuverlässige Leistung.',
      },
    );
    expect(dePreflightOk.status).toBe(200);
    expect(dePreflightOk.body.data.ok).toBe(true);

    const crossMarketPreflight = await req('POST', '/api/v2/articles/art_clean/preflight', tokenA, {
      targetLocale: 'zh-CN',
    });
    expect(crossMarketPreflight.status).toBe(400);

    // 2. Seed ja-JP L1 task + de-DE leaked L1 task + WeChat task
    const now = new Date();
    tasks.set('task_ja_ok', {
      id: 'task_ja_ok',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      connectionId: 'conn_wp_ok',
      provider: 'WORDPRESS',
      mode: 'L1_API',
      channelLabel: 'WP JP',
      targetLocale: 'ja-JP',
      targetUrlHint: null,
      variantTitle: 'Acme ポータブル電源 実測レビュー',
      variantSlug: 'acme-power-station-jp',
      variantMetaDesc:
        'Acme ポータブル電源の検証済みスペック（1200Wh）と安全性・静音性を実測データに基づき分かりやすく解説します。',
      variantMarkdown: 'Acme は 1200Wh の大容量と LiFePO4 バッテリーを採用しています。',
      variantHtml: '<p>Acme は 1200Wh の大容量と LiFePO4 バッテリーを採用しています。</p>',
      variantExtrasJson: { templateKey: 'OWNED_BLOG_SEO_GEO', targetLocale: 'ja-JP' },
      preflightJson: { ok: true, blockers: [], warnings: [] },
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
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
    });

    tasks.set('task_de_leak', {
      id: 'task_de_leak',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_global',
      articleId: 'art_clean',
      connectionId: 'conn_wp_ok',
      provider: 'WORDPRESS',
      mode: 'L1_API',
      channelLabel: 'WP DE',
      targetLocale: 'de-DE',
      targetUrlHint: null,
      variantTitle: 'Acme Testbericht',
      variantSlug: 'acme-testbericht-de',
      variantMetaDesc: 'Geprüfte Kapazität 1200Wh.',
      variantMarkdown: 'Geprüfte Leistung 1200Wh. 这里混入了中文字符。',
      variantHtml: '<p>Geprüfte Leistung 1200Wh. 这里混入了中文字符。</p>',
      variantExtrasJson: { templateKey: 'OWNED_BLOG_SEO_GEO', targetLocale: 'de-DE' },
      preflightJson: null,
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
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
    });

    markets.set('bm_cn', {
      id: 'bm_cn',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      market: 'CN',
      locale: 'zh-CN',
      supportedLocales: ['zh-CN'],
      localBrandName: 'Acme 中文',
      aliases: [],
    });
    articles.set('art_cn', {
      id: 'art_cn',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      targetLocale: 'zh-CN',
      title: 'Acme 储能实测',
      contentMarkdown: '实测容量 1200Wh。',
      geoScore: 86,
      complianceFlags: [],
      brief: { matchedFactIds: ['fact_1'] },
    });
    tasks.set('task_wechat_edit', {
      id: 'task_wechat_edit',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'bm_cn',
      articleId: 'art_cn',
      connectionId: null,
      provider: 'WECHAT_OFFICIAL',
      mode: 'L1_API',
      channelLabel: '公众号草稿',
      targetLocale: 'zh-CN',
      targetUrlHint: null,
      variantTitle: 'Acme 户外电源实测',
      variantSlug: null,
      variantMetaDesc: '实测容量 1200Wh，安全耐用。',
      variantMarkdown: '## 初版\n\n实测容量 1200Wh。',
      variantHtml: '<p>初版</p>',
      variantExtrasJson: { templateKey: 'WECHAT_OFFICIAL_ARTICLE', targetLocale: 'zh-CN' },
      preflightJson: null,
      status: 'DRAFT_VARIANT',
      publishAsDraft: true,
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
    });

    // 3. POST /distributions/task_ja_ok/publish -> passes preflight & enters PUBLISHING (NOT 422!)
    const pubJa = await req<GeoDistributionTaskDto>(
      'POST',
      '/api/v2/distributions/task_ja_ok/publish',
      tokenA,
      { publishAsDraft: true },
    );
    expect(pubJa.status).toBe(200);
    expect(pubJa.body.data.status).toBe('PUBLISHING');
    expect(pubJa.body.data.targetLocale).toBe('ja-JP');

    // 4. POST /distributions/task_de_leak/publish -> blocked with HTTP 422 GLOBAL_CJK_LEAK
    const pubDeLeak = await req<{
      ok: boolean;
      blockers: Array<{ code: string }>;
    }>('POST', '/api/v2/distributions/task_de_leak/publish', tokenA, { publishAsDraft: true });
    expect(pubDeLeak.status).toBe(422);
    expect(pubDeLeak.body.data.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(true);

    // 5. PATCH /distributions/task_de_leak -> cleans German markdown & switches targetLocale -> passes preflight; invalid locale -> 400
    const badPatch = await req('PATCH', '/api/v2/distributions/task_de_leak', tokenA, {
      targetLocale: 'zh-CN',
    });
    expect(badPatch.status).toBe(400);

    const goodPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_de_leak',
      tokenA,
      {
        targetLocale: 'de-DE',
        variantMarkdown: 'Geprüfte Leistung 1200Wh mit stabiler LiFePO4-Technik.',
      },
    );
    expect(goodPatch.status).toBe(200);
    expect(goodPatch.body.data.targetLocale).toBe('de-DE');
    expect(goodPatch.body.data.preflightJson?.ok).toBe(true);

    // 6. PATCH WeChat markdown re-renders mobile inline-styled HTML and keeps publishAsDraft=true
    const wechatPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wechat_edit',
      tokenA,
      {
        variantMarkdown: '> **核心结论**：实测 1200Wh。\n\n## 参数明细\n\n安全耐用。',
        publishAsDraft: false,
      },
    );
    expect(wechatPatch.status).toBe(200);
    expect(wechatPatch.body.data.publishAsDraft).toBe(true);
    expect(wechatPatch.body.data.variantHtml).toContain('<section style=');
    expect(wechatPatch.body.data.variantHtml).toContain('<blockquote style=');
    expect(wechatPatch.body.data.variantHtml).toContain('<h2 style=');

    // 7. Iter 2 Fix 2: PATCH WeChat variantMetaDesc & variantTitle syncs variantExtrasJson.digest and clamps UTF-16 safely
    tasks.get('task_wechat_edit')!.variantExtrasJson = {
      templateKey: 'WECHAT_OFFICIAL_ARTICLE',
      targetLocale: 'zh-CN',
      digest: '旧版 AI 摘要',
    };
    const wechatDigestPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wechat_edit',
      tokenA,
      {
        variantMetaDesc: '人工修订后的微信摘要内容',
      },
    );
    expect(wechatDigestPatch.status).toBe(200);
    expect(wechatDigestPatch.body.data.variantMetaDesc).toBe('人工修订后的微信摘要内容');
    expect(wechatDigestPatch.body.data.variantExtrasJson.digest).toBe('人工修订后的微信摘要内容');

    // Surrogate-boundary title (>64 UTF-16 units) and digest (>120 UTF-16 units) clamp without lone surrogates
    const wechatClampPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wechat_edit',
      tokenA,
      {
        variantTitle: '测'.repeat(63) + '🔥',
        variantMetaDesc: '摘'.repeat(119) + '🔥',
      },
    );
    expect(wechatClampPatch.status).toBe(200);
    expect(wechatClampPatch.body.data.variantTitle.length).toBeLessThanOrEqual(64);
    expect(wechatClampPatch.body.data.variantTitle).toBe('测'.repeat(63));
    expect(wechatClampPatch.body.data.variantMetaDesc!.length).toBeLessThanOrEqual(120);
    expect(wechatClampPatch.body.data.variantMetaDesc).toBe('摘'.repeat(119));
    expect(wechatClampPatch.body.data.variantExtrasJson.digest).toBe('摘'.repeat(119));

    // Clearing variantMetaDesc to null removes stale variantExtrasJson.digest
    const wechatClearDigestPatch = await req<GeoDistributionTaskDto>(
      'PATCH',
      '/api/v2/distributions/task_wechat_edit',
      tokenA,
      {
        variantMetaDesc: null,
      },
    );
    expect(wechatClearDigestPatch.status).toBe(200);
    expect(wechatClearDigestPatch.body.data.variantMetaDesc).toBeNull();
    expect(wechatClearDigestPatch.body.data.variantExtrasJson.digest).toBeUndefined();
    expect('digest' in wechatClearDigestPatch.body.data.variantExtrasJson).toBe(false);

    // 8. Iter 2 Fix 7: supportedLocales: [] on GLOBAL (locale: 'en-US') rejects de-DE on preflight and PATCH while allowing en-US
    bmGlobal.supportedLocales = [];
    const emptySupportedRejectPreflight = await req(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      { targetLocale: 'de-DE' },
    );
    expect(emptySupportedRejectPreflight.status).toBe(400);

    const emptySupportedRejectPatch = await req(
      'PATCH',
      '/api/v2/distributions/task_wp_clean',
      tokenA,
      { targetLocale: 'de-DE' },
    );
    expect(emptySupportedRejectPatch.status).toBe(400);

    const emptySupportedAllowDefault = await req<DistributionPreflightResult>(
      'POST',
      '/api/v2/articles/art_clean/preflight',
      tokenA,
      { targetLocale: 'en-US' },
    );
    expect(emptySupportedAllowDefault.status).toBe(200);
  });
});
