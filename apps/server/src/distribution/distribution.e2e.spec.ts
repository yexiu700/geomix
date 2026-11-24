import 'reflect-metadata';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  CHANNEL_PROVIDERS,
  CRAWL_PROBE_STATUSES,
  DISTRIBUTION_MODES,
  DISTRIBUTION_TASK_STATUSES,
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  QUEUE_NAMES,
  QUOTA_DEFAULTS,
  QUOTA_MEASURE,
  RETEST_SCHEDULE_STATUSES,
  ZERO_ALLOWED_PRICING_ACTIONS,
  evaluateLedger,
  parseEnv,
  type ActionHomeResponse,
  type ChannelConnectionDto,
  type ChannelConnectionTestResultDto,
  type DistributionPreflightResult,
  type GeoDistributionTaskDto,
  type GeoPublishRecordDto,
  type PublicPrPacketDto,
  type PublicPrPacketSubmitResultDto,
} from '@geomix/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BillingService } from '../billing/billing.service';
import { BriefsAutoGeneratorService } from '../briefs/briefs-auto-generator.service';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { SecretBox, maskSecret } from '../common/secret-box';
import { createIsolatedTestContext } from '../common/test-db';
import { LlmService } from '../infra/llm';
import { OutboundHttpClient, PUBLIC_ONLY_ALLOWLIST } from '../infra/outbound-http';
import { resetRobotsCache } from '../infra/public-fetch';
import { parseSsrfAllowlist, type SsrfAllowlist } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceRunner } from '../queue/maintenance.runner';
import { QueueProducer } from '../queue/queue.producer';
import { QueueRuntime } from '../queue/queue.runtime';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { RetestMetricsHookService } from '../studio/retest-metrics-hook.service';
import { currentTenantId, runInTenant } from '../tenant/tenant-context';
import { VisibilityEngineHealthService } from '../visibility/visibility-engine-health.service';
import { VisibilityRunLifecycleService } from '../visibility/visibility-run-lifecycle.service';
import type { VisibilityCheckJobData } from '../visibility/visibility-run.runner';
import { WorkDriver } from '../queue/work-driver';
import { WorkerModule } from '../worker.module';
import { verifyWebhookSignature } from './connectors/webhook.connector';
import { CrawlProbeService } from './crawl-probe.service';
import {
  DISTRIBUTION_HANDLER,
  DistributionRunner,
  type DistributionJobData,
} from './distribution.runner';
import type {
  GeoDistributionTaskWithRecordsDto,
  PrShareLinkResultDto,
  UpdateRetestSchedulesResultDto,
} from './distribution.service';
import { DEFAULT_INDEXNOW_ENDPOINT, IndexNowService } from './indexnow.service';
import { PublicPrPacketService } from './public-pr-packet.service';
import { RetestSchedulerService } from './retest-scheduler.service';
import type { GenerateVariantsResult } from './variant-generator.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ──────────────────────────────────────────────────────────────────────────────
// In-Memory Prisma + Raw SQL Store (supports real BillingService & QuotaService)
// ──────────────────────────────────────────────────────────────────────────────

type TenantRow = {
  id: string;
  name: string;
  isActive: boolean;
  expiresAt: Date;
  billingMode: 'SHADOW' | 'STRICT' | null;
  createdAt: Date;
};

type UserRow = {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: 'MERCHANT' | 'ADMIN';
  status: string;
  lastLoginAt: Date | null;
};

type WalletRow = {
  tenantId: string;
  points: number;
  pointsReserved: number;
  money: Prisma.Decimal;
  updatedAt: Date;
};

type QuotaRow = {
  id: string;
  tenantId: string;
  key: string;
  used: bigint;
  limit: bigint;
};

type PricingRow = {
  action: string;
  unitPoints: number;
  enabled: boolean;
  label: string;
  updatedAt: Date;
};

type ReservationRow = {
  id: string;
  tenantId: string;
  refType: string;
  refId: string;
  shadow: boolean;
  frozen: number;
  settled: number;
  released: number;
  status: 'OPEN' | 'CLOSED';
  createdAt: Date;
  closedAt: Date | null;
};

type PointLogRow = {
  id: string;
  tenantId: string;
  reservationId: string | null;
  action: string;
  title: string;
  unitKey: string;
  delta: number;
  listPrice: number;
  balanceAfter: number | null;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED';
  detail: Prisma.JsonValue | null;
  createdAt: Date;
};

type AuditLogRow = {
  id: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  resource: string | null;
  detail: Prisma.JsonValue | null;
  createdAt: Date;
};

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BrandMarketRow = {
  id: string;
  tenantId: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: Prisma.JsonValue;
  seedPrompts: Prisma.JsonValue;
  defaultEngines: string[];
  createdAt: Date;
  updatedAt: Date;
};

type BrandFactRow = {
  id: string;
  tenantId: string;
  brandId: string;
  slot: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

type GeoBriefRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  sourceType: string;
  priorityScore: number;
  status: string;
  diagnosisSummary: string;
  suggestedTitle: string;
  targetPrompt: string;
  targetFanOuts: Prisma.JsonValue;
  competitorFocus: Prisma.JsonValue;
  recommendedRecipe: string;
  targetFormat: string;
  recommendedChannels: Prisma.JsonValue;
  matchedFactIds: string[];
  missingFactHints: Prisma.JsonValue;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  sourceCitationTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type GeoArticleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  briefId: string | null;
  title: string;
  targetPrompt: string;
  recipe: string;
  targetFormat: string;
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: Prisma.JsonValue;
  llmsTxtSnippet: string;
  geoScore: number;
  geoScoreDetail: Prisma.JsonValue;
  complianceFlags: Prisma.JsonValue;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type ConnectionRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialsCiphertext: string;
  credentialsIv: string;
  credentialsTag: string;
  keyVersion: number;
  credentialHint: string;
  configJson: Prisma.JsonValue;
  status: string;
  lastTestedAt: Date | null;
  lastError: string | null;
  authType: string;
  oauthAccessTokenCiphertext: string | null;
  oauthExpiresAt: Date | null;
  targetLocale?: string | null;
  externalShopDomain?: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  targetUrlHint: string | null;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Prisma.JsonValue;
  preflightJson: Prisma.JsonValue | null;
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
  beforeMetrics: Prisma.JsonValue | null;
  afterMetrics: Prisma.JsonValue | null;
  latestRetestRunId: string | null;
  crawlStatus: string;
  crawlCheckedAt: Date | null;
  crawlReportJson: Prisma.JsonValue | null;
  indexNowSubmitted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type RetestScheduleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: number;
  dueAt: Date;
  status: string;
  visibilityRunId: string | null;
  metricsSnapshotJson: Prisma.JsonValue | null;
  skipReason: string | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type VisibilityRunRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  name: string;
  triggerType: string;
  retestArticleId: string | null;
  status: string;
  engines: string[];
  prompts: Prisma.JsonValue;
  totalChecks: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  completedChecks: number;
  failedChecks: number;
  metricsSummary: Prisma.JsonValue | null;
  reservationId: string | null;
  idempotencyKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  briefsGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type VisibilityObservationRow = {
  id: string;
  tenantId: string;
  runId: string;
  brandId: string;
  brandMarketId: string;
  promptText: string;
  engine: string;
  sampleIndex: number;
  status: string;
  collectorKind: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: Prisma.JsonValue;
  fanOutQueries: Prisma.JsonValue;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
};

type VisibilityCitationRow = {
  id: string;
  tenantId: string;
  observationId: string;
  brandId: string;
  brandMarketId: string;
  url: string;
  domain: string;
  title: string | null;
  sourceKind: string;
  position: number;
  createdAt: Date;
};

function makeP2002(target: string): Error {
  const err = new Error(`Unique constraint failed on ${target}`) as Error & {
    code: string;
    meta: { target: string[] };
  };
  err.code = 'P2002';
  err.meta = { target: [target] };
  return err;
}

function normalizeNullValue<T>(v: T): T {
  if (v === (Prisma.DbNull as unknown) || v === (Prisma.JsonNull as unknown)) {
    return null as unknown as T;
  }
  return v;
}

function matchesCondition(actual: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual === null || actual === undefined;
  if (typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const obj = cond as Record<string, unknown>;
    if ('in' in obj && Array.isArray(obj.in)) {
      if (!obj.in.includes(actual)) return false;
    }
    if ('notIn' in obj && Array.isArray(obj.notIn)) {
      if (obj.notIn.includes(actual)) return false;
    }
    if ('not' in obj) {
      if (actual === obj.not) return false;
    }
    if ('lte' in obj) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual);
      const b = obj.lte instanceof Date ? obj.lte.getTime() : Number(obj.lte);
      if (!(a <= b)) return false;
    }
    if ('lt' in obj) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual);
      const b = obj.lt instanceof Date ? obj.lt.getTime() : Number(obj.lt);
      if (!(a < b)) return false;
    }
    if ('gte' in obj) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual);
      const b = obj.gte instanceof Date ? obj.gte.getTime() : Number(obj.gte);
      if (!(a >= b)) return false;
    }
    if ('gt' in obj) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual);
      const b = obj.gt instanceof Date ? obj.gt.getTime() : Number(obj.gt);
      if (!(a > b)) return false;
    }
    return true;
  }
  if (actual instanceof Date && cond instanceof Date) {
    return actual.getTime() === cond.getTime();
  }
  return actual === cond;
}

function matchesWhere(row: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR' && Array.isArray(cond)) {
      if (!cond.some((sub) => matchesWhere(row, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === 'AND' && Array.isArray(cond)) {
      if (!cond.every((sub) => matchesWhere(row, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (!matchesCondition(row[key], cond)) return false;
  }
  return true;
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>,
): T[] {
  if (!orderBy) return [...rows];
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return dir === 'asc' ? 1 : -1;
        if (bv === null || bv === undefined) return dir === 'asc' ? -1 : 1;
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if (an < bn) return dir === 'asc' ? -1 : 1;
        if (an > bn) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  });
}

class InMemoryDistributionStore {
  private seq = 0;
  readonly tenants = new Map<string, TenantRow>();
  readonly users = new Map<string, UserRow>();
  readonly wallets = new Map<string, WalletRow>();
  readonly quotas = new Map<string, QuotaRow>();
  readonly pricing = new Map<string, PricingRow>();
  readonly reservations = new Map<string, ReservationRow>();
  readonly pointLogs: PointLogRow[] = [];
  readonly auditLogs: AuditLogRow[] = [];
  readonly brands = new Map<string, BrandRow>();
  readonly brandMarkets = new Map<string, BrandMarketRow>();
  readonly brandFacts = new Map<string, BrandFactRow>();
  readonly geoBriefs = new Map<string, GeoBriefRow>();
  readonly geoArticles = new Map<string, GeoArticleRow>();
  readonly connections = new Map<string, ConnectionRow>();
  readonly tasks = new Map<string, TaskRow>();
  readonly publishRecords = new Map<string, PublishRecordRow>();
  readonly retestSchedules = new Map<string, RetestScheduleRow>();
  readonly visibilityRuns = new Map<string, VisibilityRunRow>();
  readonly visibilityObservations = new Map<string, VisibilityObservationRow>();
  readonly visibilityCitations = new Map<string, VisibilityCitationRow>();

  constructor() {
    this.seedDefaultPricing();
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, '0')}`;
  }

  seedDefaultPricing(): void {
    this.pricing.clear();
    for (const item of PRICING_DEFAULTS) {
      this.pricing.set(item.action, {
        action: item.action,
        unitPoints: item.unitPoints,
        enabled: true,
        label: item.label,
        updatedAt: new Date(),
      });
    }
  }

  seedTenant(opts: {
    id: string;
    username: string;
    role?: 'MERCHANT' | 'ADMIN';
    points?: number;
    billingMode?: 'SHADOW' | 'STRICT' | null;
    isActive?: boolean;
    expiresAt?: Date;
    socialAuthLimit?: bigint;
    publishLimit?: bigint;
  }): { tenant: TenantRow; user: UserRow } {
    const now = new Date();
    const tenant: TenantRow = {
      id: opts.id,
      name: `Tenant ${opts.id}`,
      isActive: opts.isActive ?? true,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      billingMode: opts.billingMode === undefined ? 'STRICT' : opts.billingMode,
      createdAt: now,
    };
    this.tenants.set(tenant.id, tenant);

    const user: UserRow = {
      id: `user_${opts.id}_${opts.username}`,
      tenantId: tenant.id,
      username: opts.username,
      passwordHash: `hash_${opts.username}`,
      nickname: opts.username,
      role: opts.role ?? 'MERCHANT',
      status: 'ACTIVE',
      lastLoginAt: now,
    };
    this.users.set(user.id, user);

    this.wallets.set(tenant.id, {
      tenantId: tenant.id,
      points: opts.points ?? 100,
      pointsReserved: 0,
      money: new Prisma.Decimal(0),
      updatedAt: now,
    });

    for (const q of QUOTA_DEFAULTS) {
      const limit =
        q.key === 'SOCIAL_AUTH' && opts.socialAuthLimit !== undefined
          ? opts.socialAuthLimit
          : q.key === 'PUBLISH' && opts.publishLimit !== undefined
            ? opts.publishLimit
            : BigInt(q.limit);
      this.quotas.set(`${tenant.id}:${q.key}`, {
        id: this.nextId('quota'),
        tenantId: tenant.id,
        key: q.key,
        used: 0n,
        limit,
      });
    }

    return { tenant, user };
  }

  seedBrandWithMarkets(opts: {
    tenantId: string;
    name: string;
    category?: string;
    globalBrandName?: string;
    cnBrandName?: string;
    ownedDomains?: string[];
  }): {
    brand: BrandRow;
    globalMarket: BrandMarketRow;
    cnMarket: BrandMarketRow;
    facts: BrandFactRow[];
  } {
    const now = new Date();
    const brandId = this.nextId('brand');
    const brand: BrandRow = {
      id: brandId,
      tenantId: opts.tenantId,
      name: opts.name,
      category: opts.category ?? 'Enterprise Storage',
      truthAgreementSignedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.brands.set(brandId, brand);

    const globalMarket: BrandMarketRow = {
      id: this.nextId('mkt'),
      tenantId: opts.tenantId,
      brandId,
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: opts.globalBrandName ?? opts.name,
      aliases: [opts.name, 'NordVault X400'],
      ownedDomains: opts.ownedDomains ?? ['127.0.0.1', 'nordvault.example'],
      competitors: [{ name: 'Synology' }, { name: 'QNAP' }],
      seedPrompts: [
        { text: 'Best 4-bay private cloud NAS for studios?', intent: 'comparison' },
        { text: 'Quiet 10GbE NAS with local AI photo indexing', intent: 'informational' },
      ],
      defaultEngines: ['chatgpt', 'perplexity'],
      createdAt: now,
      updatedAt: now,
    };
    this.brandMarkets.set(globalMarket.id, globalMarket);

    const cnMarket: BrandMarketRow = {
      id: this.nextId('mkt'),
      tenantId: opts.tenantId,
      brandId,
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: opts.cnBrandName ?? '青松存储',
      aliases: ['青松存储', 'DXP4800'],
      ownedDomains: ['qingsong.example'],
      competitors: [{ name: '群晖' }, { name: '威联通' }],
      seedPrompts: [{ text: '2026 四盘位静音私有云 NAS 推荐', intent: 'comparison' }],
      defaultEngines: ['deepseek', 'doubao'],
      createdAt: now,
      updatedAt: now,
    };
    this.brandMarkets.set(cnMarket.id, cnMarket);

    const factDefs = [
      {
        slot: 'PRODUCT_SPECS',
        title: 'Acoustic & Hardware Specs',
        content: '26 dBA at 1m, 16GB ECC DDR5, dual 10GbE SFP+, 15W standby.',
      },
      {
        slot: 'DIFFERENTIATORS',
        title: 'Zero-Subscription Local AI',
        content: 'On-device AI indexing runs 100% locally with zero recurring cloud fee.',
      },
      {
        slot: 'CREDENTIALS',
        title: 'Certifications',
        content: 'UL, CE, FCC Class B certified, SOC 2 Type II audited firmware.',
      },
    ];
    const facts: BrandFactRow[] = factDefs.map((def) => {
      const row: BrandFactRow = {
        id: this.nextId('fact'),
        tenantId: opts.tenantId,
        brandId,
        slot: def.slot,
        title: def.title,
        content: def.content,
        createdAt: now,
        updatedAt: now,
      };
      this.brandFacts.set(row.id, row);
      return row;
    });

    return { brand, globalMarket, cnMarket, facts };
  }

  seedArticle(opts: {
    tenantId: string;
    brandId: string;
    brandMarketId: string;
    title: string;
    targetPrompt?: string;
    contentMarkdown: string;
    geoScore?: number;
    complianceFlags?: unknown[];
    briefId?: string | null;
    schemaJsonLd?: Record<string, unknown>;
  }): GeoArticleRow {
    const now = new Date();
    const id = this.nextId('art');
    const row: GeoArticleRow = {
      id,
      tenantId: opts.tenantId,
      brandId: opts.brandId,
      brandMarketId: opts.brandMarketId,
      briefId: opts.briefId ?? null,
      title: opts.title,
      targetPrompt: opts.targetPrompt ?? opts.title,
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
      contentMarkdown: opts.contentMarkdown,
      contentHtml: `<article><h1>${opts.title}</h1><p>${opts.contentMarkdown}</p></article>`,
      schemaJsonLd: (opts.schemaJsonLd ?? {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: opts.title,
      }) as Prisma.JsonValue,
      llmsTxtSnippet: `# ${opts.title}\nVerified facts summary.`,
      geoScore: opts.geoScore ?? 86,
      geoScoreDetail: { total: opts.geoScore ?? 86 },
      complianceFlags: (opts.complianceFlags ?? []) as Prisma.JsonValue,
      status: 'READY',
      createdAt: now,
      updatedAt: now,
    };
    this.geoArticles.set(id, row);
    return row;
  }

  ledgerSnapshot(tenantId: string, openingPoints: number) {
    const wallet = this.wallets.get(tenantId);
    if (!wallet) throw new Error(`Missing wallet for ${tenantId}`);
    const reservations = [...this.reservations.values()]
      .filter((r) => r.tenantId === tenantId)
      .map((r) => ({
        id: r.id,
        frozen: r.frozen,
        settled: r.settled,
        released: r.released,
        status: r.status,
        shadow: r.shadow,
      }));
    const entries = this.pointLogs
      .filter((l) => l.tenantId === tenantId)
      .map((l) => {
        const res = l.reservationId ? this.reservations.get(l.reservationId) : undefined;
        return {
          reservationId: l.reservationId,
          action: l.action,
          delta: l.delta,
          listPrice: l.listPrice,
          status: l.status,
          shadow: res?.shadow ?? false,
        };
      });
    return evaluateLedger({
      openingPoints,
      points: wallet.points,
      pointsReserved: wallet.pointsReserved,
      reservations,
      entries,
    });
  }

  private queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ? ');
    if (sql.includes('FROM "Wallet"')) {
      const tenantId = String(values[0]);
      const w = this.wallets.get(tenantId);
      return w ? [{ points: w.points, pointsReserved: w.pointsReserved }] : [];
    }
    if (sql.includes('FROM "PointReservation"')) {
      const id = String(values[0]);
      const tenantId = String(values[1]);
      const r = this.reservations.get(id);
      return r && r.tenantId === tenantId ? [{ ...r }] : [];
    }
    if (sql.includes('FROM "Quota"')) {
      const tenantId = String(values[0]);
      const key = String(values[1]);
      const q = this.quotas.get(`${tenantId}:${key}`);
      return q ? [{ used: q.used, limit: q.limit }] : [];
    }
    throw new Error(`Unhandled $queryRaw in test store: ${sql}`);
  };

  private executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ? ');
    if (sql.includes('UPDATE "Wallet"') && sql.includes('"pointsReserved" = "pointsReserved" +')) {
      const amount = Number(values[0]);
      const now = values[1] as Date;
      const tenantId = String(values[2]);
      const w = this.wallets.get(tenantId);
      if (!w || w.points - w.pointsReserved < amount) return 0;
      w.pointsReserved += amount;
      w.updatedAt = now;
      return 1;
    }
    if (
      sql.includes('UPDATE "Wallet"') &&
      sql.includes('points = points -') &&
      sql.includes('"pointsReserved" = "pointsReserved" -')
    ) {
      const amount = Number(values[0]);
      const now = values[2] as Date;
      const tenantId = String(values[3]);
      const w = this.wallets.get(tenantId);
      if (!w || w.points < amount || w.pointsReserved < amount) return 0;
      w.points -= amount;
      w.pointsReserved -= amount;
      w.updatedAt = now;
      return 1;
    }
    if (sql.includes('UPDATE "Wallet"') && sql.includes('"pointsReserved" = "pointsReserved" -')) {
      const amount = Number(values[0]);
      const now = values[1] as Date;
      const tenantId = String(values[2]);
      const w = this.wallets.get(tenantId);
      if (!w || w.pointsReserved < amount) return 0;
      w.pointsReserved -= amount;
      w.updatedAt = now;
      return 1;
    }
    if (sql.includes('UPDATE "Wallet"') && sql.includes('points = points +')) {
      const delta = Number(values[0]);
      const now = values[1] as Date;
      const tenantId = String(values[2]);
      const maxPoints = Number(values[6] ?? 1_000_000_000);
      const w = this.wallets.get(tenantId);
      if (!w) return 0;
      const next = w.points + delta;
      if (next < w.pointsReserved || next < 0 || next > maxPoints) return 0;
      w.points = next;
      w.updatedAt = now;
      return 1;
    }
    if (sql.includes('UPDATE "PointReservation"') && sql.includes('SET settled = settled +')) {
      const sum = Number(values[0]);
      const id = String(values[1]);
      const tenantId = String(values[2]);
      const r = this.reservations.get(id);
      if (!r || r.tenantId !== tenantId || r.status !== 'OPEN') return 0;
      if (r.settled + r.released + sum > r.frozen) return 0;
      r.settled += sum;
      return 1;
    }
    if (sql.includes('UPDATE "PointReservation"') && sql.includes('SET released = released +')) {
      const amount = Number(values[0]);
      const id = String(values[1]);
      const tenantId = String(values[2]);
      const r = this.reservations.get(id);
      if (!r || r.tenantId !== tenantId || r.status !== 'OPEN') return 0;
      if (r.settled + r.released + amount > r.frozen) return 0;
      r.released += amount;
      return 1;
    }
    if (sql.includes('UPDATE "Quota"') && sql.includes('SET used = used +')) {
      const delta = BigInt(values[0] as number | bigint);
      const tenantId = String(values[1]);
      const key = String(values[2]);
      const q = this.quotas.get(`${tenantId}:${key}`);
      if (!q || q.used + delta > q.limit) return 0;
      q.used += delta;
      return 1;
    }
    if (sql.includes('UPDATE "Quota"') && sql.includes('SET used = used -')) {
      const delta = BigInt(values[0] as number | bigint);
      const tenantId = String(values[1]);
      const key = String(values[2]);
      const q = this.quotas.get(`${tenantId}:${key}`);
      if (!q || q.used < delta) return 0;
      q.used -= delta;
      return 1;
    }
    throw new Error(`Unhandled $executeRaw in test store: ${sql}`);
  };

  private buildClient(scoped: boolean) {
    const scopeWhere = (where?: Record<string, unknown>): Record<string, unknown> => {
      if (!scoped) return { ...(where ?? {}) };
      const tid = currentTenantId();
      if (!tid) throw new Error('Scoped Prisma query outside tenant context');
      return { ...(where ?? {}), tenantId: tid };
    };

    const resolveTenantForCreate = (data: Record<string, unknown>): string => {
      if (typeof data.tenantId === 'string' && data.tenantId) return data.tenantId;
      if (scoped) {
        const tid = currentTenantId();
        if (tid) return tid;
      }
      throw new Error('Missing tenantId in create');
    };

    const attachBrand = (b: BrandRow, include?: Record<string, unknown>) => {
      if (!include) return { ...b };
      const out: Record<string, unknown> = { ...b };
      if (include.markets) {
        out.markets = [...this.brandMarkets.values()].filter((m) => m.brandId === b.id);
      }
      if (include.facts) {
        out.facts = [...this.brandFacts.values()].filter((f) => f.brandId === b.id);
      }
      if (include._count) {
        out._count = {
          facts: [...this.brandFacts.values()].filter((f) => f.brandId === b.id).length,
        };
      }
      return out;
    };

    const attachPublishRecord = (rec: PublishRecordRow, include?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...rec };
      if (!include) return out;
      if (include.article) {
        out.article = this.geoArticles.get(rec.articleId) ?? null;
      }
      if (include.brandMarket) {
        out.brandMarket = this.brandMarkets.get(rec.brandMarketId) ?? null;
      }
      if (include.retestSchedules) {
        const cfg =
          typeof include.retestSchedules === 'object'
            ? (include.retestSchedules as {
                where?: Record<string, unknown>;
                orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
              })
            : {};
        let rows = [...this.retestSchedules.values()].filter((s) => s.publishRecordId === rec.id);
        if (cfg.where) {
          rows = rows.filter((s) =>
            matchesWhere(s as unknown as Record<string, unknown>, cfg.where),
          );
        }
        rows = sortRows(
          rows as unknown as Array<Record<string, unknown>>,
          cfg.orderBy ?? { milestoneDay: 'asc' },
        ) as unknown as RetestScheduleRow[];
        out.retestSchedules = rows.map((s) => ({ ...s }));
      }
      return out;
    };

    const attachArticle = (a: GeoArticleRow, include?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...a };
      if (!include) return out;
      if (include.brand) {
        const b = this.brands.get(a.brandId);
        out.brand = b
          ? {
              ...b,
              facts: [...this.brandFacts.values()].filter((f) => f.brandId === b.id),
            }
          : null;
      }
      if (include.brandMarket) {
        out.brandMarket = this.brandMarkets.get(a.brandMarketId) ?? null;
      }
      if (include.brief) {
        out.brief = a.briefId ? (this.geoBriefs.get(a.briefId) ?? null) : null;
      }
      if (include.publishRecords) {
        const cfg =
          typeof include.publishRecords === 'object'
            ? (include.publishRecords as {
                include?: Record<string, unknown>;
                orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
                take?: number;
              })
            : {};
        let recs = [...this.publishRecords.values()].filter((r) => r.articleId === a.id);
        recs = sortRows(
          recs as unknown as Array<Record<string, unknown>>,
          cfg.orderBy ?? { createdAt: 'desc' },
        ) as unknown as PublishRecordRow[];
        if (typeof cfg.take === 'number') recs = recs.slice(0, cfg.take);
        out.publishRecords = recs.map((r) => attachPublishRecord(r, cfg.include));
      }
      return out;
    };

    const attachTask = (t: TaskRow, include?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...t };
      if (!include) return out;
      if (include.article) {
        const art = this.geoArticles.get(t.articleId);
        const artInc =
          typeof include.article === 'object'
            ? ((include.article as { include?: Record<string, unknown> }).include ?? {
                brief: true,
              })
            : { brief: true };
        out.article = art ? attachArticle(art, artInc) : null;
      }
      if (include.brand) {
        const b = this.brands.get(t.brandId);
        out.brand = b ? attachBrand(b, { facts: true }) : null;
      }
      if (include.brandMarket) {
        out.brandMarket = this.brandMarkets.get(t.brandMarketId) ?? null;
      }
      if (include.connection) {
        out.connection = t.connectionId ? (this.connections.get(t.connectionId) ?? null) : null;
      }
      if (include.publishRecords) {
        const cfg =
          typeof include.publishRecords === 'object'
            ? (include.publishRecords as {
                include?: Record<string, unknown>;
                orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
              })
            : {};
        let recs = [...this.publishRecords.values()].filter((r) => r.distributionTaskId === t.id);
        recs = sortRows(
          recs as unknown as Array<Record<string, unknown>>,
          cfg.orderBy ?? { createdAt: 'desc' },
        ) as unknown as PublishRecordRow[];
        out.publishRecords = recs.map((r) => attachPublishRecord(r, cfg.include));
      }
      return out;
    };

    const client: Record<string, unknown> = {
      $disconnect: async () => undefined,
      $queryRaw: this.queryRaw,
      $executeRaw: this.executeRaw,
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),

      tenant: {
        findUnique: async (args: { where: { id: string } }) => {
          const t = this.tenants.get(args.where.id);
          return t ? { ...t } : null;
        },
        update: async (args: { where: { id: string }; data: Partial<TenantRow> }) => {
          const t = this.tenants.get(args.where.id);
          if (!t) throw new Error('Tenant not found');
          Object.assign(t, args.data);
          return { ...t };
        },
      },

      user: {
        findUnique: async (args: {
          where: { id?: string; username?: string };
          include?: { tenant?: boolean };
        }) => {
          let found: UserRow | undefined;
          if (args.where.id) found = this.users.get(args.where.id);
          else if (args.where.username) {
            found = [...this.users.values()].find((u) => u.username === args.where.username);
          }
          if (!found) return null;
          return args.include?.tenant
            ? { ...found, tenant: this.tenants.get(found.tenantId) ?? null }
            : { ...found };
        },
        update: async (args: { where: { id: string }; data: Partial<UserRow> }) => {
          const u = this.users.get(args.where.id);
          if (!u) throw new Error('User not found');
          Object.assign(u, args.data);
          return { ...u };
        },
      },

      wallet: {
        findUnique: async (args: { where: { tenantId: string } }) => {
          const w = this.wallets.get(args.where.tenantId);
          return w ? { ...w } : null;
        },
        findUniqueOrThrow: async (args: { where: { tenantId: string } }) => {
          const w = this.wallets.get(args.where.tenantId);
          if (!w) throw new Error(`Wallet not found: ${args.where.tenantId}`);
          return { ...w };
        },
        findMany: async () => [...this.wallets.values()].map((w) => ({ ...w })),
      },

      quota: {
        findUnique: async (args: {
          where: { tenantId_key: { tenantId: string; key: string } };
        }) => {
          const { tenantId, key } = args.where.tenantId_key;
          const q = this.quotas.get(`${tenantId}:${key}`);
          return q ? { ...q } : null;
        },
        findMany: async (args?: { where?: { tenantId?: string } }) => {
          const rows = [...this.quotas.values()].filter((q) =>
            args?.where?.tenantId ? q.tenantId === args.where.tenantId : true,
          );
          return rows.map((q) => ({ ...q }));
        },
      },

      pricingItem: {
        findMany: async () =>
          [...this.pricing.values()]
            .sort((a, b) => a.action.localeCompare(b.action))
            .map((p) => ({ ...p })),
        findUnique: async (args: { where: { action: string } }) => {
          const p = this.pricing.get(args.where.action);
          return p ? { ...p } : null;
        },
        createMany: async (args: {
          data: Array<{ action: string; unitPoints: number; enabled?: boolean; label?: string }>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const item of args.data) {
            if (this.pricing.has(item.action)) {
              if (args.skipDuplicates) continue;
              throw makeP2002('action');
            }
            this.pricing.set(item.action, {
              action: item.action,
              unitPoints: item.unitPoints,
              enabled: item.enabled ?? true,
              label: item.label ?? item.action,
              updatedAt: new Date(),
            });
            count += 1;
          }
          return { count };
        },
        update: async (args: { where: { action: string }; data: Partial<PricingRow> }) => {
          const p = this.pricing.get(args.where.action);
          if (!p) throw new Error(`Pricing not found: ${args.where.action}`);
          Object.assign(p, args.data, { updatedAt: new Date() });
          return { ...p };
        },
        upsert: async (args: {
          where: { action: string };
          update: Partial<PricingRow>;
          create: { action: string; unitPoints: number; enabled?: boolean; label?: string };
        }) => {
          const existing = this.pricing.get(args.where.action);
          if (existing) {
            Object.assign(existing, args.update, { updatedAt: new Date() });
            return { ...existing };
          }
          const created: PricingRow = {
            action: args.create.action,
            unitPoints: args.create.unitPoints,
            enabled: args.create.enabled ?? true,
            label: args.create.label ?? args.create.action,
            updatedAt: new Date(),
          };
          this.pricing.set(created.action, created);
          return { ...created };
        },
      },

      pointReservation: {
        findUnique: async (args: {
          where: { id?: string; refType_refId?: { refType: string; refId: string } };
        }) => {
          if (args.where.id) {
            const r = this.reservations.get(args.where.id);
            return r ? { ...r } : null;
          }
          if (args.where.refType_refId) {
            const { refType, refId } = args.where.refType_refId;
            const r = [...this.reservations.values()].find(
              (x) => x.refType === refType && x.refId === refId,
            );
            return r ? { ...r } : null;
          }
          return null;
        },
        findFirst: async (args?: { where?: Record<string, unknown> }) => {
          const found = [...this.reservations.values()].find((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, args?.where),
          );
          return found ? { ...found } : null;
        },
        findMany: async (args?: { where?: Record<string, unknown> }) =>
          [...this.reservations.values()]
            .filter((r) => matchesWhere(r as unknown as Record<string, unknown>, args?.where))
            .map((r) => ({ ...r })),
        create: async (args: { data: Partial<ReservationRow> }) => {
          const dup = [...this.reservations.values()].find(
            (r) => r.refType === args.data.refType && r.refId === args.data.refId,
          );
          if (dup) throw makeP2002('refType_refId');
          const row: ReservationRow = {
            id: args.data.id ?? this.nextId('res'),
            tenantId: String(args.data.tenantId),
            refType: String(args.data.refType),
            refId: String(args.data.refId),
            shadow: Boolean(args.data.shadow),
            frozen: Number(args.data.frozen ?? 0),
            settled: Number(args.data.settled ?? 0),
            released: Number(args.data.released ?? 0),
            status: (args.data.status as 'OPEN' | 'CLOSED') ?? 'OPEN',
            createdAt: args.data.createdAt ?? new Date(),
            closedAt: args.data.closedAt ?? null,
          };
          this.reservations.set(row.id, row);
          return { ...row };
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const r of this.reservations.values()) {
            if (matchesWhere(r as unknown as Record<string, unknown>, args.where)) {
              for (const [k, v] of Object.entries(args.data)) {
                if (
                  v &&
                  typeof v === 'object' &&
                  'increment' in v &&
                  typeof (v as { increment: unknown }).increment === 'number'
                ) {
                  const rec = r as unknown as Record<string, number>;
                  rec[k] = Number(rec[k] ?? 0) + (v as { increment: number }).increment;
                } else {
                  (r as unknown as Record<string, unknown>)[k] = v;
                }
              }
              count += 1;
            }
          }
          return { count };
        },
      },

      pointLog: {
        count: async (args?: { where?: Record<string, unknown> }) =>
          this.pointLogs.filter((l) =>
            matchesWhere(l as unknown as Record<string, unknown>, args?.where),
          ).length,
        findUnique: async (args: {
          where: { unitKey_action: { unitKey: string; action: string } };
        }) => {
          const { unitKey, action } = args.where.unitKey_action;
          const found = this.pointLogs.find((l) => l.unitKey === unitKey && l.action === action);
          return found ? { ...found } : null;
        },
        findFirst: async (args?: { where?: Record<string, unknown> }) => {
          const found = this.pointLogs.find((l) =>
            matchesWhere(l as unknown as Record<string, unknown>, args?.where),
          );
          return found ? { ...found } : null;
        },
        findMany: async (args?: { where?: Record<string, unknown> }) =>
          this.pointLogs
            .filter((l) => matchesWhere(l as unknown as Record<string, unknown>, args?.where))
            .map((l) => ({ ...l })),
        create: async (args: { data: Partial<PointLogRow> }) => {
          const dup = this.pointLogs.find(
            (l) => l.unitKey === args.data.unitKey && l.action === args.data.action,
          );
          if (dup) throw makeP2002('unitKey_action');
          const row: PointLogRow = {
            id: args.data.id ?? this.nextId('plog'),
            tenantId: String(args.data.tenantId),
            reservationId: args.data.reservationId ?? null,
            action: String(args.data.action),
            title: String(args.data.title ?? ''),
            unitKey: String(args.data.unitKey),
            delta: Number(args.data.delta ?? 0),
            listPrice: Number(args.data.listPrice ?? 0),
            balanceAfter:
              args.data.balanceAfter === undefined ? null : Number(args.data.balanceAfter),
            status: (args.data.status as PointLogRow['status']) ?? 'SETTLED',
            detail: (args.data.detail ?? null) as Prisma.JsonValue | null,
            createdAt: args.data.createdAt ?? new Date(),
          };
          this.pointLogs.push(row);
          return { ...row };
        },
      },

      auditLog: {
        create: async (args: { data: Partial<AuditLogRow> }) => {
          const row: AuditLogRow = {
            id: this.nextId('audit'),
            tenantId: args.data.tenantId ?? null,
            userId: args.data.userId ?? null,
            action: String(args.data.action ?? ''),
            resource: args.data.resource ?? null,
            detail: (args.data.detail ?? null) as Prisma.JsonValue | null,
            createdAt: new Date(),
          };
          this.auditLogs.push(row);
          return { ...row };
        },
        findMany: async (args?: { where?: Record<string, unknown>; take?: number }) => {
          let rows = this.auditLogs.filter((a) =>
            matchesWhere(a as unknown as Record<string, unknown>, args?.where),
          );
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((a) => ({ ...a }));
        },
        findFirst: async (args?: { where?: Record<string, unknown> }) => {
          const found = this.auditLogs.find((a) =>
            matchesWhere(a as unknown as Record<string, unknown>, args?.where),
          );
          return found ? { ...found } : null;
        },
      },

      promptPreference: {
        findFirst: async () => null,
      },

      brand: {
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
        }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.brands.values()].find((b) =>
            matchesWhere(b as unknown as Record<string, unknown>, w),
          );
          return found ? attachBrand(found, args?.include) : null;
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
        }) => {
          const w = scopeWhere(args?.where);
          return [...this.brands.values()]
            .filter((b) => matchesWhere(b as unknown as Record<string, unknown>, w))
            .map((b) => attachBrand(b, args?.include));
        },
      },

      brandMarket: {
        findFirst: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.brandMarkets.values()].find((m) =>
            matchesWhere(m as unknown as Record<string, unknown>, w),
          );
          return found ? { ...found } : null;
        },
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.brandMarkets.values()]
            .filter((m) => matchesWhere(m as unknown as Record<string, unknown>, w))
            .map((m) => ({ ...m }));
        },
      },

      brandFact: {
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.brandFacts.values()]
            .filter((f) => matchesWhere(f as unknown as Record<string, unknown>, w))
            .map((f) => ({ ...f }));
        },
      },

      geoBrief: {
        findMany: async (args?: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.geoBriefs.values()].filter((b) =>
            matchesWhere(b as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as GeoBriefRow[];
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((b) => ({ ...b }));
        },
        count: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.geoBriefs.values()].filter((b) =>
            matchesWhere(b as unknown as Record<string, unknown>, w),
          ).length;
        },
        create: async (args: { data: Partial<GeoBriefRow> }) => {
          const now = new Date();
          const row: GeoBriefRow = {
            id: args.data.id ?? this.nextId('brief'),
            tenantId: resolveTenantForCreate(args.data as Record<string, unknown>),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            sourceType: String(args.data.sourceType ?? 'AUTO_GAP'),
            priorityScore: Number(args.data.priorityScore ?? 70),
            status: String(args.data.status ?? 'OPEN'),
            diagnosisSummary: String(args.data.diagnosisSummary ?? ''),
            suggestedTitle: String(args.data.suggestedTitle ?? ''),
            targetPrompt: String(args.data.targetPrompt ?? ''),
            targetFanOuts: (args.data.targetFanOuts ?? []) as Prisma.JsonValue,
            competitorFocus: (args.data.competitorFocus ?? []) as Prisma.JsonValue,
            recommendedRecipe: String(args.data.recommendedRecipe ?? 'BUYING_GUIDE'),
            targetFormat: String(args.data.targetFormat ?? 'LONG_GUIDE'),
            recommendedChannels: (args.data.recommendedChannels ?? []) as Prisma.JsonValue,
            matchedFactIds: args.data.matchedFactIds ?? [],
            missingFactHints: (args.data.missingFactHints ?? []) as Prisma.JsonValue,
            sourceRunId: args.data.sourceRunId ?? null,
            sourceObservationIds: args.data.sourceObservationIds ?? [],
            sourceCitationUrl: args.data.sourceCitationUrl ?? null,
            sourceCitationTitle: args.data.sourceCitationTitle ?? null,
            createdAt: now,
            updatedAt: now,
          };
          this.geoBriefs.set(row.id, row);
          return { ...row };
        },
      },

      geoArticle: {
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
        }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.geoArticles.values()].find((a) =>
            matchesWhere(a as unknown as Record<string, unknown>, w),
          );
          return found ? attachArticle(found, args?.include) : null;
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.geoArticles.values()].filter((a) =>
            matchesWhere(a as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as GeoArticleRow[];
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((a) => attachArticle(a, args?.include));
        },
        update: async (args: {
          where: { id: string };
          data: Partial<GeoArticleRow>;
          include?: Record<string, unknown>;
        }) => {
          const row = this.geoArticles.get(args.where.id);
          if (!row) throw new Error('Article not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          Object.assign(row, args.data, { updatedAt: new Date() });
          return attachArticle(row, args.include);
        },
      },

      channelConnection: {
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: { brandMarket?: boolean };
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.connections.values()].filter((c) =>
            matchesWhere(c as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as ConnectionRow[];
          return rows.map((c) =>
            args?.include?.brandMarket
              ? { ...c, brandMarket: this.brandMarkets.get(c.brandMarketId) ?? null }
              : { ...c },
          );
        },
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: { brandMarket?: boolean };
        }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.connections.values()].find((c) =>
            matchesWhere(c as unknown as Record<string, unknown>, w),
          );
          if (!found) return null;
          return args?.include?.brandMarket
            ? { ...found, brandMarket: this.brandMarkets.get(found.brandMarketId) ?? null }
            : { ...found };
        },
        create: async (args: {
          data: Partial<ConnectionRow>;
          include?: { brandMarket?: boolean };
        }) => {
          const now = new Date();
          const row: ConnectionRow = {
            id: args.data.id ?? this.nextId('conn'),
            tenantId: resolveTenantForCreate(args.data as Record<string, unknown>),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            provider: String(args.data.provider),
            displayName: String(args.data.displayName),
            siteBaseUrl: String(args.data.siteBaseUrl),
            credentialsCiphertext: String(args.data.credentialsCiphertext),
            credentialsIv: String(args.data.credentialsIv),
            credentialsTag: String(args.data.credentialsTag),
            keyVersion: Number(args.data.keyVersion ?? 1),
            credentialHint: String(args.data.credentialHint ?? '****'),
            configJson: (args.data.configJson ?? {}) as Prisma.JsonValue,
            status: String(args.data.status ?? 'ACTIVE'),
            lastTestedAt: args.data.lastTestedAt ?? null,
            lastError: args.data.lastError ?? null,
            authType: String(args.data.authType ?? 'API_KEY'),
            oauthAccessTokenCiphertext: args.data.oauthAccessTokenCiphertext ?? null,
            oauthExpiresAt: args.data.oauthExpiresAt ?? null,
            targetLocale: args.data.targetLocale ?? null,
            externalShopDomain: args.data.externalShopDomain ?? null,
            createdAt: now,
            updatedAt: now,
          };
          this.connections.set(row.id, row);
          return args.include?.brandMarket
            ? { ...row, brandMarket: this.brandMarkets.get(row.brandMarketId) ?? null }
            : { ...row };
        },
        update: async (args: {
          where: { id: string };
          data: Partial<ConnectionRow>;
          include?: { brandMarket?: boolean };
        }) => {
          const row = this.connections.get(args.where.id);
          if (!row) throw new Error('Connection not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          Object.assign(row, args.data, { updatedAt: new Date() });
          return args.include?.brandMarket
            ? { ...row, brandMarket: this.brandMarkets.get(row.brandMarketId) ?? null }
            : { ...row };
        },
        deleteMany: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          let count = 0;
          for (const [id, c] of [...this.connections.entries()]) {
            if (matchesWhere(c as unknown as Record<string, unknown>, w)) {
              this.connections.delete(id);
              // Emulate Prisma onDelete: SetNull on GeoDistributionTask.connectionId
              for (const task of this.tasks.values()) {
                if (task.connectionId === id) {
                  task.connectionId = null;
                }
              }
              count += 1;
            }
          }
          return { count };
        },
      },

      geoDistributionTask: {
        findUnique: async (args: {
          where: { id?: string; shareTokenHash?: string };
          include?: Record<string, unknown>;
        }) => {
          let found: TaskRow | undefined;
          if (args.where.id) found = this.tasks.get(args.where.id);
          else if (args.where.shareTokenHash) {
            found = [...this.tasks.values()].find(
              (t) => t.shareTokenHash === args.where.shareTokenHash,
            );
          }
          if (!found) return null;
          if (scoped && found.tenantId !== currentTenantId()) return null;
          return attachTask(found, args.include);
        },
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
        }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.tasks.values()].find((t) =>
            matchesWhere(t as unknown as Record<string, unknown>, w),
          );
          return found ? attachTask(found, args?.include) : null;
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.tasks.values()].filter((t) =>
            matchesWhere(t as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as TaskRow[];
          return rows.map((t) => attachTask(t, args?.include));
        },
        create: async (args: { data: Partial<TaskRow>; include?: Record<string, unknown> }) => {
          const id = args.data.id ?? this.nextId('dist');
          if (this.tasks.has(id)) throw makeP2002('id');
          if (args.data.shareTokenHash) {
            const dupHash = [...this.tasks.values()].find(
              (t) => t.shareTokenHash === args.data.shareTokenHash,
            );
            if (dupHash) throw makeP2002('shareTokenHash');
          }
          const now = new Date();
          const row: TaskRow = {
            id,
            tenantId: resolveTenantForCreate(args.data as Record<string, unknown>),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            articleId: String(args.data.articleId),
            connectionId: args.data.connectionId ?? null,
            provider: String(args.data.provider),
            mode: String(args.data.mode),
            channelLabel: String(args.data.channelLabel ?? ''),
            targetUrlHint: args.data.targetUrlHint ?? null,
            variantTitle: String(args.data.variantTitle ?? ''),
            variantSlug: args.data.variantSlug ?? null,
            variantMetaDesc: args.data.variantMetaDesc ?? null,
            variantMarkdown: String(args.data.variantMarkdown ?? ''),
            variantHtml: String(args.data.variantHtml ?? ''),
            variantExtrasJson: (args.data.variantExtrasJson ?? {}) as Prisma.JsonValue,
            preflightJson: normalizeNullValue(
              args.data.preflightJson ?? null,
            ) as Prisma.JsonValue | null,
            status: String(args.data.status ?? 'DRAFT_VARIANT'),
            publishAsDraft: args.data.publishAsDraft ?? true,
            remotePostId: args.data.remotePostId ?? null,
            remoteAdminUrl: args.data.remoteAdminUrl ?? null,
            remotePublishedUrl: args.data.remotePublishedUrl ?? null,
            indexNowStatus: args.data.indexNowStatus ?? null,
            lastError: args.data.lastError ?? null,
            shareTokenHash: args.data.shareTokenHash ?? null,
            shareExpiresAt: args.data.shareExpiresAt ?? null,
            shareRevokedAt: args.data.shareRevokedAt ?? null,
            publishedAt: args.data.publishedAt ?? null,
            createdAt: now,
            updatedAt: now,
          };
          this.tasks.set(id, row);
          return attachTask(row, args.include);
        },
        update: async (args: {
          where: { id: string };
          data: Partial<TaskRow>;
          include?: Record<string, unknown>;
        }) => {
          const row = this.tasks.get(args.where.id);
          if (!row) throw new Error('Task not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args.data)) {
            clean[k] = normalizeNullValue(v);
          }
          Object.assign(row, clean, { updatedAt: new Date() });
          return attachTask(row, args.include);
        },
        updateMany: async (args: { where: Record<string, unknown>; data: Partial<TaskRow> }) => {
          const w = scopeWhere(args.where);
          let count = 0;
          for (const row of this.tasks.values()) {
            if (matchesWhere(row as unknown as Record<string, unknown>, w)) {
              const clean: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(args.data)) {
                clean[k] = normalizeNullValue(v);
              }
              Object.assign(row, clean, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        },
        delete: async (args: { where: { id: string } }) => {
          const row = this.tasks.get(args.where.id);
          if (!row) throw new Error('Task not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          this.tasks.delete(args.where.id);
          return { ...row };
        },
      },

      geoPublishRecord: {
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
        }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.publishRecords.values()].find((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, w),
          );
          return found ? attachPublishRecord(found, args?.include) : null;
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.publishRecords.values()].filter((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as PublishRecordRow[];
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((r) => attachPublishRecord(r, args?.include));
        },
        create: async (args: {
          data: Partial<PublishRecordRow>;
          include?: Record<string, unknown>;
        }) => {
          const now = new Date();
          const row: PublishRecordRow = {
            id: args.data.id ?? this.nextId('pub'),
            tenantId: resolveTenantForCreate(args.data as Record<string, unknown>),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            articleId: String(args.data.articleId),
            distributionTaskId: args.data.distributionTaskId ?? null,
            publishedUrl: String(args.data.publishedUrl),
            channel: String(args.data.channel),
            publishedAt: args.data.publishedAt ?? now,
            beforeMetrics: normalizeNullValue(
              args.data.beforeMetrics ?? null,
            ) as Prisma.JsonValue | null,
            afterMetrics: normalizeNullValue(
              args.data.afterMetrics ?? null,
            ) as Prisma.JsonValue | null,
            latestRetestRunId: args.data.latestRetestRunId ?? null,
            crawlStatus: String(args.data.crawlStatus ?? 'PENDING'),
            crawlCheckedAt: args.data.crawlCheckedAt ?? null,
            crawlReportJson: normalizeNullValue(
              args.data.crawlReportJson ?? null,
            ) as Prisma.JsonValue | null,
            indexNowSubmitted: Boolean(args.data.indexNowSubmitted),
            createdAt: now,
            updatedAt: now,
          };
          this.publishRecords.set(row.id, row);
          return attachPublishRecord(row, args.include);
        },
        update: async (args: {
          where: { id: string };
          data: Partial<PublishRecordRow>;
          include?: Record<string, unknown>;
        }) => {
          const row = this.publishRecords.get(args.where.id);
          if (!row) throw new Error('PublishRecord not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args.data)) {
            clean[k] = normalizeNullValue(v);
          }
          Object.assign(row, clean, { updatedAt: new Date() });
          return attachPublishRecord(row, args.include);
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Partial<PublishRecordRow>;
        }) => {
          const w = scopeWhere(args.where);
          let count = 0;
          for (const row of this.publishRecords.values()) {
            if (matchesWhere(row as unknown as Record<string, unknown>, w)) {
              const clean: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(args.data)) {
                clean[k] = normalizeNullValue(v);
              }
              Object.assign(row, clean, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        },
      },

      geoRetestSchedule: {
        createMany: async (args: {
          data: Array<Partial<RetestScheduleRow>>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          const now = new Date();
          for (const item of args.data) {
            const dup = [...this.retestSchedules.values()].find(
              (s) =>
                s.publishRecordId === item.publishRecordId && s.milestoneDay === item.milestoneDay,
            );
            if (dup) {
              if (args.skipDuplicates) continue;
              throw makeP2002('publishRecordId_milestoneDay');
            }
            const row: RetestScheduleRow = {
              id: item.id ?? this.nextId('sched'),
              tenantId: resolveTenantForCreate(item as Record<string, unknown>),
              brandId: String(item.brandId),
              brandMarketId: String(item.brandMarketId),
              publishRecordId: String(item.publishRecordId),
              milestoneDay: Number(item.milestoneDay),
              sampleCount: Number(item.sampleCount ?? 1),
              dueAt: item.dueAt ?? now,
              status: String(item.status ?? 'PENDING'),
              visibilityRunId: item.visibilityRunId ?? null,
              metricsSnapshotJson: normalizeNullValue(
                item.metricsSnapshotJson ?? null,
              ) as Prisma.JsonValue | null,
              skipReason: item.skipReason ?? null,
              executedAt: item.executedAt ?? null,
              createdAt: now,
              updatedAt: now,
            };
            this.retestSchedules.set(row.id, row);
            count += 1;
          }
          return { count };
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.retestSchedules.values()].filter((s) =>
            matchesWhere(s as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as RetestScheduleRow[];
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((s) => {
            const out: Record<string, unknown> = { ...s };
            if (args?.include?.tenant) {
              out.tenant = this.tenants.get(s.tenantId) ?? null;
            }
            if (args?.include?.publishRecord) {
              const rec = this.publishRecords.get(s.publishRecordId);
              out.publishRecord = rec
                ? {
                    ...rec,
                    article: this.geoArticles.get(rec.articleId) ?? null,
                  }
                : null;
            }
            return out;
          });
        },
        update: async (args: { where: { id: string }; data: Partial<RetestScheduleRow> }) => {
          const row = this.retestSchedules.get(args.where.id);
          if (!row) throw new Error('Schedule not found');
          if (scoped && row.tenantId !== currentTenantId()) throw new Error('Forbidden');
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args.data)) {
            clean[k] = normalizeNullValue(v);
          }
          Object.assign(row, clean, { updatedAt: new Date() });
          return { ...row };
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Partial<RetestScheduleRow>;
        }) => {
          const w = scopeWhere(args.where);
          let count = 0;
          for (const row of this.retestSchedules.values()) {
            if (matchesWhere(row as unknown as Record<string, unknown>, w)) {
              const clean: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(args.data)) {
                clean[k] = normalizeNullValue(v);
              }
              Object.assign(row, clean, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        },
      },

      visibilityRun: {
        findFirst: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.visibilityRuns.values()].filter((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as VisibilityRunRow[];
          const found = rows[0];
          if (!found) return null;
          return this.attachVisibilityRun(found, args?.include);
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
          take?: number;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.visibilityRuns.values()].filter((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as VisibilityRunRow[];
          if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((r) => this.attachVisibilityRun(r, args?.include));
        },
        count: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.visibilityRuns.values()].filter((r) =>
            matchesWhere(r as unknown as Record<string, unknown>, w),
          ).length;
        },
        create: async (args: {
          data: Partial<VisibilityRunRow>;
          include?: Record<string, unknown>;
        }) => {
          const id = args.data.id ?? this.nextId('vrun');
          if (this.visibilityRuns.has(id)) throw makeP2002('id');
          const now = new Date();
          const row: VisibilityRunRow = {
            id,
            tenantId: resolveTenantForCreate(args.data as Record<string, unknown>),
            brandId: String(args.data.brandId),
            brandMarketId: String(args.data.brandMarketId),
            name: String(args.data.name ?? 'E2E Visibility Run'),
            triggerType: String(args.data.triggerType ?? 'MANUAL'),
            retestArticleId: args.data.retestArticleId ?? null,
            status: String(args.data.status ?? 'PENDING'),
            engines: Array.isArray(args.data.engines) ? [...args.data.engines] : [],
            prompts: (args.data.prompts ?? []) as Prisma.JsonValue,
            totalChecks: Number(args.data.totalChecks ?? 0),
            doneCount: Number(args.data.doneCount ?? 0),
            failCount: Number(args.data.failCount ?? 0),
            unitPrice: Number(args.data.unitPrice ?? 2),
            completedChecks: Number(args.data.completedChecks ?? 0),
            failedChecks: Number(args.data.failedChecks ?? 0),
            metricsSummary: normalizeNullValue(
              args.data.metricsSummary ?? null,
            ) as Prisma.JsonValue | null,
            reservationId: args.data.reservationId ?? null,
            idempotencyKey: args.data.idempotencyKey ?? null,
            startedAt: args.data.startedAt ?? null,
            finishedAt: args.data.finishedAt ?? null,
            briefsGeneratedAt: args.data.briefsGeneratedAt ?? null,
            createdAt: now,
            updatedAt: now,
          };
          this.visibilityRuns.set(id, row);
          return this.attachVisibilityRun(row, args.include);
        },
        update: async (args: {
          where: { id: string };
          data: Partial<VisibilityRunRow>;
          include?: Record<string, unknown>;
        }) => {
          const row = this.visibilityRuns.get(args.where.id);
          if (!row) throw new Error('VisibilityRun not found');
          Object.assign(row, args.data, { updatedAt: new Date() });
          return this.attachVisibilityRun(row, args.include);
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Partial<VisibilityRunRow>;
        }) => {
          const w = scopeWhere(args.where);
          let count = 0;
          for (const row of this.visibilityRuns.values()) {
            if (matchesWhere(row as unknown as Record<string, unknown>, w)) {
              Object.assign(row, args.data, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        },
      },

      visibilityObservation: {
        createMany: async (args: { data: Array<Partial<VisibilityObservationRow>> }) => {
          const now = new Date();
          for (const item of args.data) {
            const row: VisibilityObservationRow = {
              id: item.id ?? this.nextId('obs'),
              tenantId: resolveTenantForCreate(item as Record<string, unknown>),
              runId: String(item.runId),
              brandId: String(item.brandId),
              brandMarketId: String(item.brandMarketId),
              promptText: String(item.promptText),
              engine: String(item.engine),
              sampleIndex: Number(item.sampleIndex ?? 1),
              status: String(item.status ?? 'PENDING'),
              collectorKind: String(item.collectorKind ?? 'fake'),
              answerText: item.answerText ?? null,
              brandMentioned: Boolean(item.brandMentioned),
              brandPosition: item.brandPosition ?? null,
              brandSentiment: item.brandSentiment ?? null,
              competitorHits: (item.competitorHits ?? []) as Prisma.JsonValue,
              fanOutQueries: (item.fanOutQueries ?? []) as Prisma.JsonValue,
              latencyMs: item.latencyMs ?? null,
              errorCode: item.errorCode ?? null,
              errorMessage: item.errorMessage ?? null,
              createdAt: now,
            };
            this.visibilityObservations.set(row.id, row);
          }
          return { count: args.data.length };
        },
        findMany: async (args?: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        }) => {
          const w = scopeWhere(args?.where);
          let rows = [...this.visibilityObservations.values()].filter((o) =>
            matchesWhere(o as unknown as Record<string, unknown>, w),
          );
          rows = sortRows(
            rows as unknown as Array<Record<string, unknown>>,
            args?.orderBy,
          ) as unknown as VisibilityObservationRow[];
          return rows.map((o) => ({
            ...o,
            citations: [...this.visibilityCitations.values()]
              .filter((c) => c.observationId === o.id)
              .sort((a, b) => a.position - b.position),
          }));
        },
        count: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.visibilityObservations.values()].filter((o) =>
            matchesWhere(o as unknown as Record<string, unknown>, w),
          ).length;
        },
        findFirst: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          const found = [...this.visibilityObservations.values()].find((o) =>
            matchesWhere(o as unknown as Record<string, unknown>, w),
          );
          return found ? { ...found } : null;
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Partial<VisibilityObservationRow>;
        }) => {
          const w = scopeWhere(args.where);
          let count = 0;
          for (const row of this.visibilityObservations.values()) {
            if (matchesWhere(row as unknown as Record<string, unknown>, w)) {
              Object.assign(row, args.data);
              count += 1;
            }
          }
          return { count };
        },
      },

      visibilityCitation: {
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          const w = scopeWhere(args?.where);
          return [...this.visibilityCitations.values()]
            .filter((c) => matchesWhere(c as unknown as Record<string, unknown>, w))
            .map((c) => ({ ...c }));
        },
        createMany: async (args: { data: Array<Partial<VisibilityCitationRow>> }) => {
          const now = new Date();
          for (const item of args.data) {
            const row: VisibilityCitationRow = {
              id: item.id ?? this.nextId('cit'),
              tenantId: resolveTenantForCreate(item as Record<string, unknown>),
              observationId: String(item.observationId),
              brandId: String(item.brandId),
              brandMarketId: String(item.brandMarketId),
              url: String(item.url),
              domain: String(item.domain),
              title: item.title ?? null,
              sourceKind: String(item.sourceKind ?? 'OTHER'),
              position: Number(item.position ?? 1),
              createdAt: now,
            };
            this.visibilityCitations.set(row.id, row);
          }
          return { count: args.data.length };
        },
      },

      brandFactChunk: {
        findMany: async () => [],
      },
    };

    return client;
  }

  private attachVisibilityRun(run: VisibilityRunRow, include?: Record<string, unknown>) {
    const out: Record<string, unknown> = { ...run };
    if (!include) return out;
    if (include.brand) {
      const b = this.brands.get(run.brandId);
      out.brand = b
        ? {
            ...b,
            facts: [...this.brandFacts.values()].filter((f) => f.brandId === b.id),
            markets: [...this.brandMarkets.values()].filter((m) => m.brandId === b.id),
          }
        : null;
    }
    if (include.brandMarket) {
      const m = this.brandMarkets.get(run.brandMarketId);
      out.brandMarket = m
        ? {
            ...m,
            brand: {
              ...this.brands.get(m.brandId),
              markets: [...this.brandMarkets.values()].filter((x) => x.brandId === m.brandId),
            },
          }
        : null;
    }
    if (include.observations) {
      const cfg =
        typeof include.observations === 'object'
          ? (include.observations as { where?: Record<string, unknown> })
          : {};
      let obs = [...this.visibilityObservations.values()].filter((o) => o.runId === run.id);
      if (cfg.where) {
        obs = obs.filter((o) => matchesWhere(o as unknown as Record<string, unknown>, cfg.where));
      }
      out.observations = obs.map((o) => ({
        ...o,
        citations: [...this.visibilityCitations.values()]
          .filter((c) => c.observationId === o.id)
          .sort((a, b) => a.position - b.position),
      }));
    }
    if (include._count) {
      out._count = {
        geoBriefs: [...this.geoBriefs.values()].filter((b) => b.sourceRunId === run.id).length,
      };
    }
    return out;
  }

  createBaseClient() {
    return this.buildClient(false);
  }

  createScopedClient() {
    return this.buildClient(true);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Local Mock HTTP Server (Shopify, WP, Webflow, Webhook, IndexNow, Crawl, SSRF)
// ──────────────────────────────────────────────────────────────────────────────

type CapturedMockRequest = {
  kind: 'shopify' | 'wordpress' | 'webflow' | 'webhook' | 'indexnow';
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  json: unknown;
};

async function startDistributionMockServer() {
  const captures: CapturedMockRequest[] = [];
  let seq = 0;
  let mockBase = '';

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const normHeaders = (raw: http.IncomingHttpHeaders): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
      else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    }
    return out;
  };

  const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const rawBody = await readBody(req);
    const headers = normHeaders(req.headers);
    let json: unknown = null;
    if (rawBody) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = null;
      }
    }

    // SSRF 302 redirect traps (hop 2 points to private/metadata IP)
    if (pathname === '/redirect-to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (pathname === '/redirect-to-private') {
      res.writeHead(302, { location: 'http://10.0.0.1/secret' });
      res.end();
      return;
    }

    // robots.txt for CrawlProbe
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: GPTBot\nDisallow: /crawl/blocked-gptbot/\n\nUser-agent: *\nAllow: /\n');
      return;
    }

    // CrawlProbe 5 diagnostic targets
    if (pathname === '/crawl/ok/post') {
      const canonical = `${mockBase}/crawl/ok/post`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${canonical}" />
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: 'NordVault X400 Pro Verified Guide',
        })}</script>
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [],
        })}</script>
      </head><body><h1>OK Post</h1></body></html>`);
      return;
    }
    if (pathname === '/crawl/blocked-gptbot/post') {
      const canonical = `${mockBase}/crawl/blocked-gptbot/post`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${canonical}" />
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
      </head><body><h1>Blocked for GPTBot</h1></body></html>`);
      return;
    }
    if (pathname === '/crawl/noindex/post') {
      const canonical = `${mockBase}/crawl/noindex/post`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="canonical" href="${canonical}" />
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
      </head><body><h1>Noindex Post</h1></body></html>`);
      return;
    }
    if (pathname === '/crawl/bad-jsonld/post') {
      const canonical = `${mockBase}/crawl/bad-jsonld/post`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${canonical}" />
        <script type="application/ld+json">{broken-json</script>
      </head><body><h1>Malformed JSON-LD</h1></body></html>`);
      return;
    }
    if (pathname === '/crawl/not-found') {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }

    // Shopify Admin GraphQL
    if (method === 'POST' && /^\/shopify\/admin\/api\/[^/]+\/graphql\.json$/i.test(pathname)) {
      if (!headers['x-shopify-access-token']) {
        sendJson(res, 401, { errors: 'Invalid token' });
        return;
      }
      seq += 1;
      captures.push({ kind: 'shopify', method, path: pathname, headers, rawBody, json });
      const body = (json ?? {}) as {
        query?: string;
        variables?: { article?: Record<string, unknown> };
      };
      if (body.query?.includes('articleCreate')) {
        const art = body.variables?.article ?? {};
        const isPublished = Boolean(art.isPublished);
        const handle = String(art.handle || `shopify-art-${seq}`);
        sendJson(res, 200, {
          data: {
            articleCreate: {
              article: {
                id: `gid://shopify/Article/900${seq}`,
                handle,
                title: String(art.title || 'Shopify Post'),
                isPublished,
                onlineStoreUrl: isPublished ? `${mockBase}/crawl/ok/post` : null,
                blog: { id: String(art.blogId || 'gid://shopify/Blog/101'), handle: 'news' },
              },
              userErrors: [],
            },
          },
        });
        return;
      }
      sendJson(res, 200, {
        data: {
          shop: { name: 'Mock Shopify Store', primaryDomain: { url: mockBase } },
          blogs: { nodes: [{ id: 'gid://shopify/Blog/101', title: 'News', handle: 'news' }] },
        },
      });
      return;
    }

    // WordPress REST API v2
    if (pathname.startsWith('/wp/wp-json/wp/v2/')) {
      if (!headers.authorization?.startsWith('Basic ')) {
        sendJson(res, 401, { code: 'rest_unauthorized', message: 'Unauthorized' });
        return;
      }
      seq += 1;
      captures.push({ kind: 'wordpress', method, path: pathname, headers, rawBody, json });
      if (pathname === '/wp/wp-json/wp/v2/users/me' && method === 'GET') {
        sendJson(res, 200, { id: 1, name: 'GeoMix Editor', slug: 'editor' });
        return;
      }
      if (pathname === '/wp/wp-json/wp/v2/categories' && method === 'GET') {
        sendJson(res, 200, [{ id: 7, name: 'Guides', slug: 'guides', count: 3 }]);
        return;
      }
      if (pathname === '/wp/wp-json/wp/v2/posts' && method === 'POST') {
        const body = (json ?? {}) as { status?: string };
        sendJson(res, 201, {
          id: 400 + seq,
          status: body.status || 'draft',
          link: `${mockBase}/crawl/ok/post`,
        });
        return;
      }
      sendJson(res, 404, { code: 'rest_no_route' });
      return;
    }

    // Webflow Data API v2
    if (pathname.startsWith('/webflow/v2/')) {
      if (!headers.authorization?.startsWith('Bearer ')) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      seq += 1;
      captures.push({ kind: 'webflow', method, path: pathname, headers, rawBody, json });
      if (pathname === '/webflow/v2/sites' && method === 'GET') {
        sendJson(res, 200, {
          sites: [{ id: 'site_1', displayName: 'Acme Docs', shortName: 'acme' }],
        });
        return;
      }
      if (pathname === '/webflow/v2/sites/site_1/collections' && method === 'GET') {
        sendJson(res, 200, {
          collections: [{ id: 'col_1', displayName: 'Blog Posts', slug: 'posts' }],
        });
        return;
      }
      if (pathname === '/webflow/v2/collections/col_1' && method === 'GET') {
        sendJson(res, 200, {
          id: 'col_1',
          displayName: 'Blog Posts',
          slug: 'posts',
          fields: [
            { id: 'f1', slug: 'name', displayName: 'Name', type: 'PlainText', isRequired: true },
            { id: 'f2', slug: 'slug', displayName: 'Slug', type: 'PlainText', isRequired: true },
            {
              id: 'f3',
              slug: 'post-body',
              displayName: 'Post Body',
              type: 'RichText',
              isRequired: false,
            },
          ],
        });
        return;
      }
      if (
        (pathname === '/webflow/v2/collections/col_1/items' ||
          pathname === '/webflow/v2/collections/col_1/items/live') &&
        method === 'POST'
      ) {
        const isLive = pathname.endsWith('/items/live');
        const body = (json ?? {}) as { isDraft?: boolean; fieldData?: Record<string, unknown> };
        sendJson(res, 201, {
          id: `wf_item_${seq}`,
          isDraft: isLive ? false : Boolean(body.isDraft ?? true),
          ...(isLive ? { publishedUrl: `${mockBase}/crawl/ok/post` } : {}),
          fieldData: body.fieldData ?? {},
        });
        return;
      }
      sendJson(res, 404, { message: 'Not found' });
      return;
    }

    // Generic Signed Webhook (+ secret-echoing error endpoints for leak verification)
    if (pathname === '/webhook/publish' && method === 'POST') {
      seq += 1;
      captures.push({ kind: 'webhook', method, path: pathname, headers, rawBody, json });
      const event = headers['x-geomix-event'] || '';
      if (event === 'geomix.connection.test') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const body = (json ?? {}) as { publishAsDraft?: boolean };
      sendJson(res, 200, {
        id: `wh_post_${seq}`,
        publishedAsDraft: Boolean(body.publishAsDraft),
        ...(body.publishAsDraft ? {} : { publishedUrl: `${mockBase}/crawl/ok/post` }),
      });
      return;
    }
    if (pathname === '/webhook/fail-401' && method === 'POST') {
      // Deliberately echo secret token in upstream error to prove Connector/Runner redaction!
      sendJson(res, 401, {
        error: 'Rejected secret whsec_leak_probe_99887766 in upstream auth',
      });
      return;
    }
    if (pathname === '/webhook/fail-500' && method === 'POST') {
      sendJson(res, 500, {
        error: 'Internal failure with whsec_leak_probe_99887766 exposed',
      });
      return;
    }

    // IndexNow
    if (pathname === '/indexnow' && method === 'POST') {
      seq += 1;
      captures.push({ kind: 'indexnow', method, path: pathname, headers, rawBody, json });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/indexnow-fail' && method === 'POST') {
      seq += 1;
      captures.push({ kind: 'indexnow', method, path: pathname, headers, rawBody, json });
      sendJson(res, 500, { error: 'Upstream IndexNow error' });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  mockBase = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl: mockBase,
    captures,
    clearCaptures: () => {
      captures.length = 0;
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer A: Offline Server E2E Suite (Tiers 1–4 & 5 Mandatory Closed Loops)
// ──────────────────────────────────────────────────────────────────────────────

describe('GeoMix v2.1 Distribution E2E Suite (Offline Real NestJS + Mock HTTP Server)', () => {
  const savedEnv: Record<string, string | undefined> = { ...process.env };
  let app: INestApplication;
  let baseUrl = '';
  let store: InMemoryDistributionStore;
  let mock: Awaited<ReturnType<typeof startDistributionMockServer>>;
  let enqueuedDistributions: DistributionJobData[] = [];
  let enqueuedVisibilityRuns: VisibilityCheckJobData[] = [];
  let queueDistSpy: { mockRestore: () => void };
  let queueVisSpy: { mockRestore: () => void };

  let outboundHttp: { defaultAllowlist: SsrfAllowlist };
  let indexNowSvc: { defaultEndpointUrl: string };
  let distributionRunner: DistributionRunner;
  let maintenanceRunner: MaintenanceRunner;
  let retestMetricsHook: RetestMetricsHookService;
  let briefsAutoGenerator: BriefsAutoGeneratorService;
  let freeLimiter: FreeActionRateLimiter;
  let publicPrSvc: PublicPrPacketService;

  const allowLocalMock = () => {
    outboundHttp.defaultAllowlist = parseSsrfAllowlist(`127.0.0.1:${mock.port}`, {
      includeDefaults: false,
    });
  };
  const enforcePublicOnly = () => {
    outboundHttp.defaultAllowlist = PUBLIC_ONLY_ALLOWLIST;
  };

  function mintJwt(user: UserRow): string {
    const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
    const nowSec = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: user.id,
        tid: user.tenantId,
        role: user.role,
        typ: 'access',
        fp: passwordFingerprint(user.passwordHash),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      secret,
    );
  }

  async function apiCall<T = unknown>(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Envelope<T>; rawText: string }> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(opts?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts?.headers ?? {}),
    };
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const rawText = await res.text();
    let parsed: Envelope<T>;
    try {
      parsed = JSON.parse(rawText) as Envelope<T>;
    } catch {
      parsed = { code: -1, msg: rawText, data: null as unknown as T };
    }
    return { status: res.status, body: parsed, rawText };
  }

  beforeAll(async () => {
    // Keep global BILLING_MODE='SHADOW' so deterministic fake LLM remains allowed even for STRICT tenants!
    process.env.BILLING_MODE = 'SHADOW';
    process.env.LLM_PROVIDERS = '{}';
    process.env.VISIBILITY_COLLECTOR = 'fake';
    process.env.EMBEDDING_PROVIDER = 'fake';
    process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.PUBLIC_APP_URL = 'http://127.0.0.1:3000';
    process.env.JWT_ACCESS_SECRET = 'dist-e2e-access-secret';
    process.env.JWT_REFRESH_SECRET = 'dist-e2e-refresh-secret';
    delete process.env.DATABASE_URL;

    mock = await startDistributionMockServer();
    store = new InMemoryDistributionStore();

    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as { base: unknown; scoped: unknown };
    prismaSvc.base = store.createBaseClient();
    prismaSvc.scoped = store.createScopedClient();

    const queueProducer = app.get(QueueProducer);
    queueDistSpy = vi
      .spyOn(queueProducer, 'enqueueDistribution')
      .mockImplementation(async (job: DistributionJobData) => {
        enqueuedDistributions.push(job);
      });
    queueVisSpy = vi
      .spyOn(queueProducer, 'enqueueVisibilityRun')
      .mockImplementation(async (job: VisibilityCheckJobData) => {
        enqueuedVisibilityRuns.push(job);
      });

    outboundHttp = app.get(OutboundHttpClient) as unknown as { defaultAllowlist: SsrfAllowlist };
    indexNowSvc = app.get(IndexNowService) as unknown as { defaultEndpointUrl: string };
    distributionRunner = app.get(DistributionRunner);
    retestMetricsHook = app.get(RetestMetricsHookService);
    briefsAutoGenerator = app.get(BriefsAutoGeneratorService);
    freeLimiter = app.get(FreeActionRateLimiter);
    publicPrSvc = app.get(PublicPrPacketService);

    const workerRetestScheduler = new RetestSchedulerService(
      app.get(PrismaService),
      app.get(BillingService),
      app.get(VisibilityEngineHealthService),
      app.get(VisibilityRunLifecycleService),
    );
    maintenanceRunner = new MaintenanceRunner(
      app.get(BillingService),
      app.get(WorkDriver),
      app.get(VisibilityEngineHealthService),
      app.get(CrawlProbeService),
      workerRetestScheduler,
    );

    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    allowLocalMock();
    indexNowSvc.defaultEndpointUrl = `${mock.baseUrl}/indexnow`;
    enqueuedDistributions = [];
    enqueuedVisibilityRuns = [];
    mock.clearCaptures();
    freeLimiter.reset();
    publicPrSvc.resetRateLimits();
    resetRobotsCache();
    store.seedDefaultPricing();
  });

  afterEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    allowLocalMock();
    indexNowSvc.defaultEndpointUrl = `${mock.baseUrl}/indexnow`;
    // Restore any per-test spies while preserving suite-level queue spies
    vi.restoreAllMocks();
    const queueProducer = app.get(QueueProducer);
    queueDistSpy = vi
      .spyOn(queueProducer, 'enqueueDistribution')
      .mockImplementation(async (job: DistributionJobData) => {
        enqueuedDistributions.push(job);
      });
    queueVisSpy = vi
      .spyOn(queueProducer, 'enqueueVisibilityRun')
      .mockImplementation(async (job: VisibilityCheckJobData) => {
        enqueuedVisibilityRuns.push(job);
      });
  });

  afterAll(async () => {
    try {
      freeLimiter?.reset();
      publicPrSvc?.resetRateLimits();
      resetRobotsCache();
      if (outboundHttp) outboundHttp.defaultAllowlist = PUBLIC_ONLY_ALLOWLIST;
      if (indexNowSvc) indexNowSvc.defaultEndpointUrl = DEFAULT_INDEXNOW_ENDPOINT;
      queueDistSpy?.mockRestore();
      queueVisSpy?.mockRestore();
      vi.restoreAllMocks();
      if (app) await app.close();
      if (mock) await mock.close();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });

  // ── T1-01, T1-02, T2-01 & WorkerModule DI Wiring ──────────────────────────
  describe('Foundation Contracts, SecretBox Boundaries & WorkerModule DI (T1-01, T1-02, T2-01)', () => {
    it('T1-01 & T1-02: enums, queue names, pricing defaults, free actions, quotas & WorkerModule DI wiring', async () => {
      expect(CHANNEL_PROVIDERS).toHaveLength(17);
      expect(CHANNEL_PROVIDERS).toContain('SOCIAL_THREAD_ASSIST');
      expect(CHANNEL_PROVIDERS).toContain('GHOST');
      expect(CHANNEL_PROVIDERS).toContain('WECHAT_OFFICIAL');
      expect(CHANNEL_PROVIDERS).toContain('ZHIHU_EXT');
      expect(DISTRIBUTION_MODES).toEqual([
        'L1_API',
        'L2_EXTENSION',
        'L3_COMMUNITY_ASSIST',
        'L3_PR_PACKET',
      ]);
      expect(DISTRIBUTION_TASK_STATUSES).toContain('DRAFT_PUSHED');
      expect(CRAWL_PROBE_STATUSES).toContain('BLOCKED');
      expect(RETEST_SCHEDULE_STATUSES).toContain('SKIPPED_INSUFFICIENT_POINTS');
      expect(QUEUE_NAMES).toContain('distribution');
      expect(PRICING_DEFAULTS.find((p) => p.action === 'geo_variant')?.unitPoints).toBe(2);
      expect(ZERO_ALLOWED_PRICING_ACTIONS).toContain('geo_variant');
      expect(FREE_RATE_LIMITED_ACTIONS).toEqual(
        expect.arrayContaining([
          'distribution_preflight',
          'crawl_probe',
          'pr_packet_share',
          'near_miss_boost',
          'roi_report_export',
          'roi_report_share',
          'extension_token_issue',
          'extension_sync',
        ]),
      );
      expect(QUOTA_MEASURE.SOCIAL_AUTH).toBe('stock');
      expect(QUOTA_MEASURE.PUBLISH).toBe('cumulative');

      // Offline WorkerModule DI & QueueRuntime.dispatchJob('distribution') verification
      const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
      const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
      const workerCtx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
      try {
        const runner = workerCtx.get(DistributionRunner);
        expect(runner).toBeInstanceOf(DistributionRunner);
        expect(workerCtx.get(DISTRIBUTION_HANDLER)).toBe(runner);
        expect(workerCtx.get(MaintenanceRunner)).toBeInstanceOf(MaintenanceRunner);
        expect(workerCtx.get(CrawlProbeService)).toBeInstanceOf(CrawlProbeService);
        const workerRetest = workerCtx.get(RetestSchedulerService) as unknown as {
          engineHealth?: unknown;
          runLifecycle?: unknown;
        };
        expect(workerRetest).toBeInstanceOf(RetestSchedulerService);
        expect(workerRetest.engineHealth).toBeInstanceOf(VisibilityEngineHealthService);
        expect(workerRetest.runLifecycle).toBeInstanceOf(VisibilityRunLifecycleService);
        expect(workerCtx.get(RetestMetricsHookService)).toBeInstanceOf(RetestMetricsHookService);
        expect(workerCtx.get(BriefsAutoGeneratorService)).toBeInstanceOf(
          BriefsAutoGeneratorService,
        );

        const runtime = workerCtx.get(QueueRuntime);
        const procSpy = vi.spyOn(runner, 'process').mockResolvedValue(undefined);
        await runtime.dispatchJob('distribution', {
          name: 'distribution',
          data: { tenantId: 't_di', taskId: 'task_di' },
        });
        expect(procSpy).toHaveBeenCalledWith({ tenantId: 't_di', taskId: 'task_di' });
      } finally {
        await workerCtx.close();
        startSpy.mockRestore();
        stopSpy.mockRestore();
      }
    });

    it('T2-01: SecretBox AES-256-GCM round-trip, tamper/wrong-key/missing-key failures & maskSecret', () => {
      const box = app.get(SecretBox);
      const env = box.encryptJson({ accessToken: 'shpat_123456789a2f', nested: 'ok' });
      expect(box.decryptJson<{ accessToken: string }>(env).accessToken).toBe('shpat_123456789a2f');

      // Tampered ciphertext & tampered authTag must throw
      const badCipher = {
        ...env,
        ciphertext: Buffer.from('tampered-ciphertext-bytes').toString('base64'),
      };
      expect(() => box.decryptJson(badCipher)).toThrow();
      const badTag = {
        ...env,
        tag: Buffer.alloc(16, 0xff).toString('base64'),
      };
      expect(() => box.decryptJson(badTag)).toThrow();

      // Wrong key must fail authentication
      const otherBox = new SecretBox({
        key: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      });
      expect(() => otherBox.decryptJson(env)).toThrow();

      // Missing env key: lazy check fails only at encrypt/decrypt time, not boot
      const prev = process.env.CREDENTIAL_ENCRYPTION_KEY;
      try {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
        const lazyBox = new SecretBox();
        expect(() => lazyBox.encryptJson({ token: 'abc' })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
      } finally {
        process.env.CREDENTIAL_ENCRYPTION_KEY = prev;
      }

      // maskSecret boundaries (never leaks raw short secret)
      expect(maskSecret('')).toBe('');
      expect(maskSecret('abc')).toBe('****');
      expect(maskSecret('12345678')).toBe('****78');
      expect(maskSecret('shpat_123456789a2f')).toBe('shpat_****9a2f');
      expect(maskSecret('abcdef1234567890')).toBe('abcd****7890');
    });
  });

  // ── Loop 1: Preflight Gate, 1→N 6-Template Variants, Billing & Briefs Citation Recs ──
  describe('Loop 1 — Preflight Gate, 1→N Variant Billing, Partial Refund, 0-pt Mode & Citation Recs (T1-03, T1-05, T1-06, T2-02, T2-03, T2-07, T2-08, T3-02)', () => {
    it('executes full Loop 1: preflight block (422) -> fix -> 6 templates & billing -> partial LLM failure refund -> 0-pt admin mode -> Idempotency replay', async () => {
      const { tenant, user } = store.seedTenant({
        id: 't_loop1',
        username: 'merchant_l1',
        points: 10,
        billingMode: 'STRICT',
      });
      const { user: adminUser } = store.seedTenant({
        id: 't_admin_l1',
        username: 'admin_l1',
        role: 'ADMIN',
        points: 100,
        billingMode: 'STRICT',
      });
      const token = mintJwt(user);
      const adminToken = mintJwt(adminUser);

      const { brand, globalMarket, cnMarket } = store.seedBrandWithMarkets({
        tenantId: tenant.id,
        name: 'NordVault',
        globalBrandName: 'NordVault 青松',
        cnBrandName: '青松存储',
      });

      // Create webhook connection so we can test L1 publish 422 gate
      const connRes = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'Loop1 Webhook',
            siteBaseUrl: `${mock.baseUrl}/webhook/publish`,
            credentials: { signingSecret: 'whsec_loop1_secret_123456' },
          },
        },
      );
      expect(connRes.status).toBe(200);
      const connId = connRes.body.data.id;

      // 1. GLOBAL article with unresolved [TBD: price] + stray CJK leak (T2-02, T3-02)
      const blockedArticle = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        title: 'NordVault X400 Pro Buying Guide',
        contentMarkdown:
          '# NordVault X400 Pro\nPrice starts at [TBD: price] with 26 dBA acoustics. 这是一段泄露的中文测试正文。',
        geoScore: 68,
      });

      const pf1 = await apiCall<DistributionPreflightResult>(
        'POST',
        `/api/v2/articles/${blockedArticle.id}/preflight`,
        { token, body: {} },
      );
      expect(pf1.status).toBe(200);
      expect(pf1.body.data.ok).toBe(false);
      expect(pf1.body.data.blockers.some((b) => b.code === 'MISSING_FACT_SLOTS')).toBe(true);
      expect(pf1.body.data.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(true);
      expect(pf1.body.data.warnings.some((w) => w.code === 'LOW_GEO_SCORE')).toBe(true);

      // Brand proper noun CJK ('青松') in GLOBAL article must NOT trigger false-positive CJK leak (T2-02)
      const brandProperNounPf = await apiCall<DistributionPreflightResult>(
        'POST',
        `/api/v2/articles/${blockedArticle.id}/preflight`,
        {
          token,
          body: {
            title: 'NordVault 青松 X400 Pro Review',
            contentMarkdown:
              'NordVault 青松 delivers 26 dBA acoustic performance and $599 MSRP with zero cloud fees.',
            variantSlug: 'nordvault-x400-review',
            variantMetaDesc: 'Verified specs for NordVault X400 Pro private cloud NAS.',
          },
        },
      );
      expect(brandProperNounPf.status).toBe(200);
      expect(brandProperNounPf.body.data.blockers.some((b) => b.code === 'GLOBAL_CJK_LEAK')).toBe(
        false,
      );

      // CN article with [待补充：价格] blocked vs clean Chinese prose allowed (T3-02)
      const cnArticle = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: cnMarket.id,
        title: '青松存储 DXP4800 选购指南',
        contentMarkdown: '# 青松存储 DXP4800\n参考售价：[待补充：价格]，满载噪音 28dB。',
        geoScore: 84,
      });
      const cnBlockedPf = await apiCall<DistributionPreflightResult>(
        'POST',
        `/api/v2/articles/${cnArticle.id}/preflight`,
        { token, body: {} },
      );
      expect(cnBlockedPf.body.data.ok).toBe(false);
      expect(cnBlockedPf.body.data.blockers.some((b) => b.code === 'MISSING_FACT_SLOTS')).toBe(
        true,
      );

      const cnCleanPf = await apiCall<DistributionPreflightResult>(
        'POST',
        `/api/v2/articles/${cnArticle.id}/preflight`,
        {
          token,
          body: {
            contentMarkdown:
              '# 青松存储 DXP4800\n官方售价 2,499 元，满载噪音 28dB，双 2.5GbE 网口。',
          },
        },
      );
      expect(cnCleanPf.body.data.ok).toBe(true);
      expect(cnCleanPf.body.data.blockers).toHaveLength(0);

      // Generate a task on the blocked article (create task first, then verify publish returns 422!)
      const blockedVar = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${blockedArticle.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop1-blocked-var' },
          body: {
            targets: [
              {
                provider: 'WEBHOOK',
                connectionId: connId,
                channelLabel: 'Webhook Blocked Test',
                publishAsDraft: true,
              },
            ],
          },
        },
      );
      expect(blockedVar.status).toBe(200);
      const blockedTaskId = blockedVar.body.data.tasks[0]!.id;
      // Inject [TBD: price] directly into task variantMarkdown so publish gate catches it
      await apiCall('PATCH', `/api/v2/distributions/${blockedTaskId}`, {
        token,
        body: {
          variantMarkdown: 'Draft body still missing [TBD: price] and [To be verified: warranty].',
        },
      });
      const pub422 = await apiCall<{ ok: boolean; blockers: unknown[] }>(
        'POST',
        `/api/v2/distributions/${blockedTaskId}/publish`,
        { token, body: { publishAsDraft: true } },
      );
      expect(pub422.status).toBe(422);
      expect(pub422.body.code).toBe(40001);
      expect(pub422.body.data.ok).toBe(false);
      expect(pub422.body.data.blockers.length).toBeGreaterThan(0);

      // acknowledgePreflightWarnings: true overrides 422 (T2-02, T3-02)
      const pubAck = await apiCall<GeoDistributionTaskDto>(
        'POST',
        `/api/v2/distributions/${blockedTaskId}/publish`,
        { token, body: { publishAsDraft: true, acknowledgePreflightWarnings: true } },
      );
      expect(pubAck.status).toBe(200);
      expect(pubAck.body.data.status).toBe('PUBLISHING');

      // Reset tenant wallet cleanly to 10 pts for exact Loop 1 billing assertions
      const wallet = store.wallets.get(tenant.id)!;
      wallet.points = 10;
      wallet.pointsReserved = 0;
      store.reservations.clear();
      store.pointLogs.length = 0;

      // 2. Resolve [TBD: price] & clean CJK -> generate 2 variants -> deduct 4 pts (10 -> 6)
      const cleanArticle = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        title: 'NordVault X400 Pro 4-Bay Private Cloud NAS Guide',
        contentMarkdown:
          '# NordVault X400 Pro\nRetails at $599 MSRP with 26 dBA acoustics, 16GB ECC DDR5, and dual 10GbE SFP+.',
        geoScore: 88,
      });

      const pfClean = await apiCall<DistributionPreflightResult>(
        'POST',
        `/api/v2/articles/${cleanArticle.id}/preflight`,
        {
          token,
          body: {
            variantSlug: 'nordvault-x400-pro-guide',
            variantMetaDesc: 'Verified hardware benchmarks for NordVault X400 Pro NAS.',
          },
        },
      );
      expect(pfClean.status).toBe(200);
      expect(pfClean.body.data.ok).toBe(true);
      expect(pfClean.body.data.blockers).toHaveLength(0);

      const var2Res = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop1-two-variants' },
          body: {
            targets: [
              {
                provider: 'REDDIT_ASSIST',
                channelLabel: 'Reddit r/homelab',
                templateKey: 'REDDIT_DISCUSSION',
              },
              {
                provider: 'PR_PACKET',
                channelLabel: 'Tech Media PR Packet',
                templateKey: 'PR_MEDIA_PACKET',
              },
            ],
          },
        },
      );
      expect(var2Res.status).toBe(200);
      expect(var2Res.body.data.totalChargedPoints).toBe(4);
      expect(var2Res.body.data.tasks).toHaveLength(2);
      expect(wallet.points).toBe(6);
      expect(wallet.pointsReserved).toBe(0);
      expect(store.ledgerSnapshot(tenant.id, 10)).toEqual({ ok: true, issues: [] });

      // Verify template invariants (T2-07): Reddit anti-ban checklist, PR Fact Sheet, zero CJK in GLOBAL
      const redditTask = var2Res.body.data.tasks.find((t) => t.provider === 'REDDIT_ASSIST')!;
      const prTask = var2Res.body.data.tasks.find((t) => t.provider === 'PR_PACKET')!;
      expect(JSON.stringify(redditTask.variantExtrasJson)).toMatch(/antiBan|checklist|subreddit/i);
      expect(JSON.stringify(prTask.variantExtrasJson)).toMatch(
        /factSheet|headline|keyFacts|facts/i,
      );
      expect(/[\u4e00-\u9fff]/.test(redditTask.variantMarkdown.replace(/青松/g, ''))).toBe(false);

      // Idempotency-Key replay must NOT double-charge (T2-07)
      const replayRes = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop1-two-variants' },
          body: {
            targets: [
              {
                provider: 'REDDIT_ASSIST',
                channelLabel: 'Reddit r/homelab',
                templateKey: 'REDDIT_DISCUSSION',
              },
              {
                provider: 'PR_PACKET',
                channelLabel: 'Tech Media PR Packet',
                templateKey: 'PR_MEDIA_PACKET',
              },
            ],
          },
        },
      );
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.data.replayed).toBe(true);
      expect(wallet.points).toBe(6);
      expect(store.ledgerSnapshot(tenant.id, 10)).toEqual({ ok: true, issues: [] });

      // 3. Partial LLM failure (2 requested -> 1 succeeds, 1 fails): reserves 4, settles 2, refunds 2 (6 -> 4)
      const llm = app.get(LlmService);
      const origComplete = llm.complete.bind(llm);
      let llmCalls = 0;
      const llmSpy = vi.spyOn(llm, 'complete').mockImplementation(async (req) => {
        llmCalls += 1;
        if (llmCalls === 2) {
          throw new Error('Simulated upstream LLM failure on channel #2');
        }
        return origComplete(req);
      });

      const partialRes = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop1-partial-fail' },
          body: {
            targets: [
              {
                provider: 'QUORA_ASSIST',
                channelLabel: 'Quora NAS Answer',
                templateKey: 'QUORA_ANSWER',
              },
              {
                provider: 'SOCIAL_THREAD_ASSIST',
                channelLabel: 'X Thread',
                templateKey: 'SOCIAL_THREAD',
              },
            ],
          },
        },
      );
      llmSpy.mockRestore();

      expect(partialRes.status).toBe(200);
      expect(partialRes.body.data.tasks).toHaveLength(1);
      expect(partialRes.body.data.failures).toHaveLength(1);
      expect(partialRes.body.data.totalChargedPoints).toBe(2);
      expect(partialRes.body.data.refundedPoints).toBe(2);
      expect(wallet.points).toBe(4);
      expect(wallet.pointsReserved).toBe(0);
      expect(store.ledgerSnapshot(tenant.id, 10)).toEqual({ ok: true, issues: [] });

      // Insufficient balance in STRICT mode returns 402 (wallet=4, requesting 3 channels = 6 pts)
      const insufficientRes = await apiCall(
        'POST',
        `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop1-insufficient-402' },
          body: {
            targets: [
              { provider: 'REDDIT_ASSIST', channelLabel: 'R1' },
              { provider: 'QUORA_ASSIST', channelLabel: 'Q1' },
              { provider: 'SOCIAL_THREAD_ASSIST', channelLabel: 'S1' },
            ],
          },
        },
      );
      expect(insufficientRes.status).toBe(402);
      expect(insufficientRes.body.code).toBe(40201);
      expect(wallet.points).toBe(4);
      expect(wallet.pointsReserved).toBe(0);

      // 4. Admin pricing boundary: geo_write=0 rejected (400/40001), geo_variant=0 allowed (T2-03)
      const badZero = await apiCall('PATCH', '/api/v1/admin/pricing', {
        token: adminToken,
        body: { action: 'geo_write', unitPoints: 0, enabled: true },
      });
      expect(badZero.status).toBe(400);
      expect(badZero.body.code).toBe(40001);

      const goodZero = await apiCall('PATCH', '/api/v1/admin/pricing', {
        token: adminToken,
        body: { action: 'geo_variant', unitPoints: 0, enabled: true },
      });
      expect(goodZero.status).toBe(200);

      // Generate remaining templates (OWNED_BLOG_SEO_GEO + SOCIAL_THREAD + CN_COMMUNITY_QA) at 0 pts + verify 429 free-action rate limit!
      const prevFreeMax = process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX;
      process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX = '2';
      try {
        const zeroVarRes = await apiCall<GenerateVariantsResult>(
          'POST',
          `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
          {
            token,
            headers: { 'idempotency-key': 'loop1-zero-pt-global' },
            body: {
              targets: [
                {
                  provider: 'WEBHOOK',
                  connectionId: connId,
                  channelLabel: 'Owned Blog SEO GEO',
                  templateKey: 'OWNED_BLOG_SEO_GEO',
                },
                {
                  provider: 'SOCIAL_THREAD_ASSIST',
                  channelLabel: 'LinkedIn Thread',
                  templateKey: 'SOCIAL_THREAD',
                },
              ],
            },
          },
        );
        expect(zeroVarRes.status).toBe(200);
        expect(zeroVarRes.body.data.unitPrice).toBe(0);
        expect(zeroVarRes.body.data.totalChargedPoints).toBe(0);
        expect(wallet.points).toBe(4);

        const cnCleanArticle = store.seedArticle({
          tenantId: tenant.id,
          brandId: brand.id,
          brandMarketId: cnMarket.id,
          title: '青松存储 DXP4800 实测',
          contentMarkdown: '# 青松存储 DXP4800\n满载噪音 28dB，双 2.5GbE，官方售价 2,499 元。',
        });
        const cnVarRes = await apiCall<GenerateVariantsResult>(
          'POST',
          `/api/v2/articles/${cnCleanArticle.id}/distributions/variants`,
          {
            token,
            headers: { 'idempotency-key': 'loop1-cn-community' },
            body: {
              targets: [
                {
                  provider: 'CN_COMMUNITY_ASSIST',
                  channelLabel: '知乎评测回答',
                  templateKey: 'CN_COMMUNITY_QA',
                },
              ],
            },
          },
        );
        expect(cnVarRes.status).toBe(200);
        expect(cnVarRes.body.data.tasks[0]!.variantMarkdown).toMatch(/[\u4e00-\u9fff]/);

        // 3rd call under 0-pt mode hits free-action rate limit -> 429!
        const rateLimitedRes = await apiCall(
          'POST',
          `/api/v2/articles/${cleanArticle.id}/distributions/variants`,
          {
            token,
            headers: { 'idempotency-key': 'loop1-zero-pt-rate-limit-3rd' },
            body: {
              targets: [{ provider: 'REDDIT_ASSIST', channelLabel: 'Reddit Rate Limit Check' }],
            },
          },
        );
        expect(rateLimitedRes.status).toBe(429);
      } finally {
        if (prevFreeMax === undefined) delete process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX;
        else process.env.GEO_VARIANT_FREE_RATE_LIMIT_MAX = prevFreeMax;
      }
      expect(store.ledgerSnapshot(tenant.id, 10)).toEqual({ ok: true, issues: [] });
    });

    it('T1-06 & T2-08: BriefsAutoGeneratorService citation-driven recommendedChannels with 3-URL cap & empty-citation fallback', async () => {
      const { tenant } = store.seedTenant({ id: 't_briefs', username: 'merchant_briefs' });
      const { brand, globalMarket } = store.seedBrandWithMarkets({
        tenantId: tenant.id,
        name: 'NordVault',
      });

      // Run 1: Rich third-party Reddit citations (>3 URLs to verify max-3 cap)
      const runWithCitesId = store.nextId('vrun');
      store.visibilityRuns.set(runWithCitesId, {
        id: runWithCitesId,
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        name: 'Citation Recs Run',
        triggerType: 'MANUAL',
        retestArticleId: null,
        status: 'COMPLETED',
        engines: ['chatgpt', 'perplexity'],
        prompts: ['Best quiet 4-bay NAS for 4K editing?'],
        totalChecks: 2,
        doneCount: 2,
        failCount: 0,
        unitPrice: 2,
        completedChecks: 2,
        failedChecks: 0,
        metricsSummary: null,
        reservationId: null,
        idempotencyKey: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        briefsGeneratedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const obsId = store.nextId('obs');
      store.visibilityObservations.set(obsId, {
        id: obsId,
        tenantId: tenant.id,
        runId: runWithCitesId,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        promptText: 'Best quiet 4-bay NAS for 4K editing?',
        engine: 'perplexity',
        sampleIndex: 1,
        status: 'SUCCESS',
        collectorKind: 'fake',
        answerText: 'Synology DS923+ and QNAP TS-464 are frequently recommended on Reddit.',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: 'neutral',
        competitorHits: [{ name: 'Synology', mentioned: true }],
        fanOutQueries: ['quiet 4-bay nas 4k editing'],
        latencyMs: 500,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
      });
      for (let i = 1; i <= 5; i += 1) {
        const cid = store.nextId('cit');
        store.visibilityCitations.set(cid, {
          id: cid,
          tenantId: tenant.id,
          observationId: obsId,
          brandId: brand.id,
          brandMarketId: globalMarket.id,
          url: `https://www.reddit.com/r/homelab/comments/post${i}/best_nas/`,
          domain: 'reddit.com',
          title: `Reddit NAS Thread ${i}`,
          sourceKind: 'SOCIAL',
          position: i,
          createdAt: new Date(),
        });
      }

      await briefsAutoGenerator.onVisibilityRunComplete({
        tenantId: tenant.id,
        runId: runWithCitesId,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        triggerType: 'MANUAL',
        retestArticleId: null,
        status: 'COMPLETED',
        successCount: 1,
      });

      const createdBriefs = [...store.geoBriefs.values()].filter(
        (b) => b.sourceRunId === runWithCitesId,
      );
      expect(createdBriefs.length).toBeGreaterThan(0);
      const recs = createdBriefs[0]!.recommendedChannels as Array<{
        channel: string;
        providerHint?: string;
        priority?: string;
        reason?: string;
        citedExampleUrls?: string[];
      }>;
      const redditRec = recs.find((r) => r.providerHint === 'REDDIT_ASSIST');
      expect(redditRec).toBeDefined();
      expect(redditRec?.citedExampleUrls?.length).toBeLessThanOrEqual(3);
      expect(redditRec?.citedExampleUrls?.length).toBeGreaterThan(0);

      // Run 2: 0 citations -> graceful market-default fallback (T2-08)
      const runNoCitesId = store.nextId('vrun');
      store.visibilityRuns.set(runNoCitesId, {
        id: runNoCitesId,
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        name: 'Fallback Run',
        triggerType: 'MANUAL',
        retestArticleId: null,
        status: 'COMPLETED',
        engines: ['chatgpt'],
        prompts: ['Private cloud NAS with local AI photo search'],
        totalChecks: 1,
        doneCount: 1,
        failCount: 0,
        unitPrice: 2,
        completedChecks: 1,
        failedChecks: 0,
        metricsSummary: null,
        reservationId: null,
        idempotencyKey: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        briefsGeneratedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const obs2 = store.nextId('obs');
      store.visibilityObservations.set(obs2, {
        id: obs2,
        tenantId: tenant.id,
        runId: runNoCitesId,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        promptText: 'Private cloud NAS with local AI photo search',
        engine: 'chatgpt',
        sampleIndex: 1,
        status: 'SUCCESS',
        collectorKind: 'fake',
        answerText: 'Synology Photos is widely used.',
        brandMentioned: false,
        brandPosition: null,
        brandSentiment: 'neutral',
        competitorHits: [{ name: 'Synology', mentioned: true }],
        fanOutQueries: [],
        latencyMs: 300,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
      });
      await briefsAutoGenerator.onVisibilityRunComplete({
        tenantId: tenant.id,
        runId: runNoCitesId,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        triggerType: 'MANUAL',
        retestArticleId: null,
        status: 'COMPLETED',
        successCount: 1,
      });
      const fallbackBriefs = [...store.geoBriefs.values()].filter(
        (b) => b.sourceRunId === runNoCitesId,
      );
      expect(fallbackBriefs.length).toBeGreaterThan(0);
      expect(Array.isArray(fallbackBriefs[0]!.recommendedChannels)).toBe(true);
      expect((fallbackBriefs[0]!.recommendedChannels as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ── Loop 2: 4 L1 Connections CRUD + Draft vs Live Publish + IndexNow + Schedules ──
  describe('Loop 2 — 4 L1 Connections CRUD, Quotas & Draft vs Live Publish (T1-04, T1-09, T2-04, T2-06, T3-01)', () => {
    it('executes full Loop 2 across Shopify, WordPress, Webflow & Webhook with Draft/Live, HMAC, Gutenberg JSON-LD, IndexNow & quota/SetNull lifecycle', async () => {
      const { tenant, user } = store.seedTenant({
        id: 't_loop2',
        username: 'merchant_l2',
        points: 100,
        billingMode: 'STRICT',
        socialAuthLimit: 4n,
      });
      const token = mintJwt(user);
      const { brand, globalMarket } = store.seedBrandWithMarkets({
        tenantId: tenant.id,
        name: 'NordVault',
        ownedDomains: ['127.0.0.1'],
      });
      const article = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        title: 'NordVault X400 Pro 10GbE Benchmark',
        contentMarkdown:
          '# NordVault X400 Pro\nSustained 10GbE transfer at 26 dBA with 16GB ECC DDR5 and $599 MSRP.',
      });

      const rawSecrets = {
        shopify: 'shpat_live_9876543210abcd',
        wpPass: 'wp_app_secret_abcd1234',
        webflow: 'wf_token_live_1234567890',
        webhook: 'whsec_loop2_signing_secret_999',
      };

      // 1. Create all 4 L1 connections (consuming SOCIAL_AUTH stock quota 0 -> 4)
      const shopifyConn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'SHOPIFY',
            displayName: 'Shopify Store',
            siteBaseUrl: `${mock.baseUrl}/shopify`,
            credentials: { accessToken: rawSecrets.shopify },
            configJson: { blogId: 'gid://shopify/Blog/101' },
          },
        },
      );
      const wpConn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'WORDPRESS',
            displayName: 'WordPress Blog',
            siteBaseUrl: `${mock.baseUrl}/wp`,
            credentials: { username: 'editor', appPassword: rawSecrets.wpPass },
            configJson: {
              categoryIds: [7],
              injectJsonLd: true,
              indexNowKey: 'e2eindexnowkey1234567890',
            },
          },
        },
      );
      const wfConn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'WEBFLOW',
            displayName: 'Webflow CMS',
            siteBaseUrl: `${mock.baseUrl}/webflow`,
            credentials: { apiToken: rawSecrets.webflow },
            configJson: {
              siteId: 'site_1',
              collectionId: 'col_1',
              primaryDomain: mock.baseUrl,
              fieldMap: {
                title: 'name',
                slug: 'slug',
                bodyHtml: 'post-body',
              },
            },
          },
        },
      );
      const whConn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'Signed Webhook',
            siteBaseUrl: `${mock.baseUrl}/webhook/publish`,
            credentials: { signingSecret: rawSecrets.webhook },
          },
        },
      );

      for (const r of [shopifyConn, wpConn, wfConn, whConn]) {
        expect(r.status).toBe(200);
        expect(r.body.data.credentialHint).toContain('****');
      }

      // 5th connection exceeds SOCIAL_AUTH stock quota (limit 4) -> 409/40901 (T2-04)
      const quotaExceeded = await apiCall('POST', `/api/v2/brands/${brand.id}/connections`, {
        token,
        body: {
          market: 'GLOBAL',
          provider: 'WEBHOOK',
          displayName: 'Overflow Webhook',
          siteBaseUrl: `${mock.baseUrl}/webhook/publish`,
          credentials: { signingSecret: 'whsec_overflow_12345678' },
        },
      });
      expect(quotaExceeded.status).toBe(409);
      expect(quotaExceeded.body.code).toBe(40901);

      // Test all 4 connections via POST .../test (T1-04)
      for (const conn of [shopifyConn, wpConn, wfConn, whConn]) {
        const testRes = await apiCall<ChannelConnectionTestResultDto>(
          'POST',
          `/api/v2/brands/${brand.id}/connections/${conn.body.data.id}/test`,
          { token, body: {} },
        );
        expect(testRes.status).toBe(200);
        expect(testRes.body.data.ok).toBe(true);
      }

      // PATCH omitting/blanking credentials preserves existing ciphertext (T2-04)
      const beforeCipher = store.connections.get(wpConn.body.data.id)!.credentialsCiphertext;
      const patchRes = await apiCall<ChannelConnectionDto>(
        'PATCH',
        `/api/v2/brands/${brand.id}/connections/${wpConn.body.data.id}`,
        {
          token,
          body: { displayName: 'WordPress Blog Renamed', credentials: {} },
        },
      );
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.displayName).toBe('WordPress Blog Renamed');
      expect(store.connections.get(wpConn.body.data.id)!.credentialsCiphertext).toBe(beforeCipher);

      // Zero plaintext credential leak across GET list response
      const listRes = await apiCall<{ items: ChannelConnectionDto[] }>(
        'GET',
        `/api/v2/brands/${brand.id}/connections?market=GLOBAL`,
        { token },
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.items).toHaveLength(4);
      for (const secret of Object.values(rawSecrets)) {
        expect(listRes.rawText).not.toContain(secret);
      }

      // 2. Generate 4 L1 variants (Shopify, WP, Webflow, Webhook)
      const genRes = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${article.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop2-4-l1' },
          body: {
            targets: [
              {
                provider: 'SHOPIFY',
                connectionId: shopifyConn.body.data.id,
                channelLabel: 'Shopify Store',
              },
              {
                provider: 'WORDPRESS',
                connectionId: wpConn.body.data.id,
                channelLabel: 'WordPress Blog',
              },
              {
                provider: 'WEBFLOW',
                connectionId: wfConn.body.data.id,
                channelLabel: 'Webflow CMS',
              },
              {
                provider: 'WEBHOOK',
                connectionId: whConn.body.data.id,
                channelLabel: 'Signed Webhook',
              },
            ],
          },
        },
      );
      expect(genRes.status).toBe(200);
      expect(genRes.body.data.tasks).toHaveLength(4);
      const taskByProvider = new Map(genRes.body.data.tasks.map((t) => [t.provider, t]));

      // 3. Draft Push on Shopify -> DRAFT_PUSHED, 0 GeoPublishRecord, 0 IndexNow (T3-01)
      mock.clearCaptures();
      const shopifyDraftPub = await apiCall<GeoDistributionTaskDto>(
        'POST',
        `/api/v2/distributions/${taskByProvider.get('SHOPIFY')!.id}/publish`,
        { token, body: { publishAsDraft: true } },
      );
      expect(shopifyDraftPub.status).toBe(200);
      expect(enqueuedDistributions).toHaveLength(1);
      await distributionRunner.process(enqueuedDistributions.pop()!);

      const shopifyAfterDraft = store.tasks.get(taskByProvider.get('SHOPIFY')!.id)!;
      expect(shopifyAfterDraft.status).toBe('DRAFT_PUSHED');
      expect(
        [...store.publishRecords.values()].filter((r) => r.articleId === article.id),
      ).toHaveLength(0);
      expect(mock.captures.filter((c) => c.kind === 'indexnow')).toHaveLength(0);

      // 4. Live Publish on WordPress (Gutenberg <!-- wp:html --> + JSON-LD + IndexNow + PublishRecord + 3 Schedules)
      mock.clearCaptures();
      const wpLivePub = await apiCall<GeoDistributionTaskDto>(
        'POST',
        `/api/v2/distributions/${taskByProvider.get('WORDPRESS')!.id}/publish`,
        { token, body: { publishAsDraft: false } },
      );
      expect(wpLivePub.status).toBe(200);
      await distributionRunner.process(enqueuedDistributions.pop()!);

      const wpPostCap = mock.captures.find(
        (c) => c.kind === 'wordpress' && c.path === '/wp/wp-json/wp/v2/posts',
      );
      expect(wpPostCap).toBeDefined();
      const wpPayload = wpPostCap!.json as { status: string; content: string };
      expect(wpPayload.status).toBe('publish');
      expect(wpPayload.content).toContain('<!-- wp:html -->');
      expect(wpPayload.content).toContain('<script type="application/ld+json">');

      const indexNowCaps = mock.captures.filter((c) => c.kind === 'indexnow');
      expect(indexNowCaps).toHaveLength(1);

      const wpTaskAfter = store.tasks.get(taskByProvider.get('WORDPRESS')!.id)!;
      expect(wpTaskAfter.status).toBe('PUBLISHED');
      const wpPubRec = [...store.publishRecords.values()].find(
        (r) => r.distributionTaskId === wpTaskAfter.id,
      )!;
      expect(wpPubRec).toBeDefined();
      expect(wpPubRec.indexNowSubmitted).toBe(true);
      const wpSchedules = [...store.retestSchedules.values()].filter(
        (s) => s.publishRecordId === wpPubRec.id,
      );
      expect(wpSchedules.map((s) => s.milestoneDay).sort((a, b) => a - b)).toEqual([7, 14, 30]);

      // 5. Live Publish on Webhook (HMAC-SHA256 verified, no indexNowKey -> IndexNow skipped)
      mock.clearCaptures();
      const whLivePub = await apiCall<GeoDistributionTaskDto>(
        'POST',
        `/api/v2/distributions/${taskByProvider.get('WEBHOOK')!.id}/publish`,
        { token, body: { publishAsDraft: false } },
      );
      expect(whLivePub.status).toBe(200);
      await distributionRunner.process(enqueuedDistributions.pop()!);

      const whCap = mock.captures.find((c) => c.kind === 'webhook');
      expect(whCap).toBeDefined();
      expect(whCap!.headers['x-geomix-delivery-id']).toBeTruthy();
      expect(
        verifyWebhookSignature(
          whCap!.rawBody,
          rawSecrets.webhook,
          whCap!.headers['x-geomix-signature'] ?? '',
        ),
      ).toBe(true);
      expect(mock.captures.filter((c) => c.kind === 'indexnow')).toHaveLength(0);
      expect(store.tasks.get(taskByProvider.get('WEBHOOK')!.id)!.status).toBe('PUBLISHED');

      // 6. Live Publish on Webflow (/items/live with fieldMap) + IndexNow 500 non-blocking degrade (T2-06, T3-01)
      store.connections.get(wfConn.body.data.id)!.configJson = {
        siteId: 'site_1',
        collectionId: 'col_1',
        primaryDomain: mock.baseUrl,
        fieldMap: { title: 'name', slug: 'slug', bodyHtml: 'post-body' },
        indexNowKey: 'wfindexnowkey123456789',
      };
      indexNowSvc.defaultEndpointUrl = `${mock.baseUrl}/indexnow-fail`;
      mock.clearCaptures();

      const wfLivePub = await apiCall<GeoDistributionTaskDto>(
        'POST',
        `/api/v2/distributions/${taskByProvider.get('WEBFLOW')!.id}/publish`,
        { token, body: { publishAsDraft: false } },
      );
      expect(wfLivePub.status).toBe(200);
      await distributionRunner.process(enqueuedDistributions.pop()!);

      const wfCap = mock.captures.find(
        (c) => c.kind === 'webflow' && c.path === '/webflow/v2/collections/col_1/items/live',
      );
      expect(wfCap).toBeDefined();
      const wfBody = wfCap!.json as { fieldData: Record<string, unknown> };
      expect(wfBody.fieldData.name).toBeTruthy();
      expect(wfBody.fieldData['post-body']).toBeTruthy();
      // Even though IndexNow returned 500, Webflow publish MUST still be PUBLISHED!
      const wfTaskAfter = store.tasks.get(taskByProvider.get('WEBFLOW')!.id)!;
      expect(wfTaskAfter.status).toBe('PUBLISHED');
      expect(wfTaskAfter.indexNowStatus).toMatch(/FAILED/i);

      // 7. DELETE connection sets task.connectionId = null (preserves history) & releases SOCIAL_AUTH quota (T2-04)
      const delRes = await apiCall<{ deleted: number }>(
        'DELETE',
        `/api/v2/brands/${brand.id}/connections/${whConn.body.data.id}`,
        { token },
      );
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.deleted).toBe(1);
      expect(store.tasks.get(taskByProvider.get('WEBHOOK')!.id)!.connectionId).toBeNull();
      expect(store.tasks.get(taskByProvider.get('WEBHOOK')!.id)!.status).toBe('PUBLISHED');

      // Re-creating a connection now succeeds because stock quota dropped 4 -> 3!
      const recreateRes = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brand.id}/connections`,
        {
          token,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'Re-created Webhook',
            siteBaseUrl: `${mock.baseUrl}/webhook/publish`,
            credentials: { signingSecret: 'whsec_recreated_secret_123' },
          },
        },
      );
      expect(recreateRes.status).toBe(200);
    });
  });

  // ── Loop 3: Strict Zero-Allowlist SSRF Negative Suite, Zero Leak & Tenant Isolation ──
  describe('Loop 3 — SSRF Negative Suite, Secret Redaction & Tenant Isolation (T2-05, T2-06, T2-12)', () => {
    it('blocks all private/loopback/metadata/internal/decimal/IPv6-mapped URLs & 302 redirects, redacts secrets on error, and enforces tenant isolation', async () => {
      const { tenant: tenantA, user: userA } = store.seedTenant({
        id: 't_sec_a',
        username: 'sec_a',
        points: 50,
        billingMode: 'STRICT',
      });
      const { user: userB } = store.seedTenant({
        id: 't_sec_b',
        username: 'sec_b',
        points: 50,
        billingMode: 'STRICT',
      });
      const { tenant: expiredTenant, user: expiredUser } = store.seedTenant({
        id: 't_sec_exp',
        username: 'sec_exp',
        points: 50,
        expiresAt: new Date(Date.now() - 86_400_000),
      });
      const tokenA = mintJwt(userA);
      const tokenB = mintJwt(userB);
      const expiredToken = mintJwt(expiredUser);

      const { brand: brandA, globalMarket: mktA } = store.seedBrandWithMarkets({
        tenantId: tenantA.id,
        name: 'SecBrandA',
      });
      const { brand: brandExp } = store.seedBrandWithMarkets({
        tenantId: expiredTenant.id,
        name: 'SecBrandExp',
      });
      const artA = store.seedArticle({
        tenantId: tenantA.id,
        brandId: brandA.id,
        brandMarketId: mktA.id,
        title: 'Security Verification Guide',
        contentMarkdown: '# Security Guide\nVerified SSRF and credential protection.',
      });

      // 1. STRICT ZERO-ALLOWLIST SSRF NEGATIVE SUITE (T2-05)
      enforcePublicOnly();
      const ssrfUrls = [
        'http://127.0.0.1/webhook',
        'http://10.0.0.1/webhook',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/webhook',
        'http://sonargate:8080/webhook',
        'http://[::127.0.0.1]/webhook',
        'http://2130706433/webhook',
      ];
      for (const badUrl of ssrfUrls) {
        const res = await apiCall('POST', `/api/v2/brands/${brandA.id}/connections`, {
          token: tokenA,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'SSRF Probe',
            siteBaseUrl: badUrl,
            credentials: { signingSecret: 'whsec_ssrf_probe_123456' },
          },
        });
        expect(res.status, `Expected 400 SSRF block for ${badUrl}`).toBe(400);
      }

      // 302 redirect trap: hop 1 hits port-pinned local mock, hop 2 redirects to 169.254.169.254 / 10.0.0.1 -> BLOCKED!
      allowLocalMock();
      const outbound = app.get(OutboundHttpClient);
      await expect(
        outbound.request({ url: `${mock.baseUrl}/redirect-to-metadata`, method: 'GET' }),
      ).rejects.toThrow();
      await expect(
        outbound.request({ url: `${mock.baseUrl}/redirect-to-private`, method: 'GET' }),
      ).rejects.toThrow();

      // 2. Zero plaintext credential leak even when upstream echoes secret in 401/500 error body (T2-06)
      const leakSecret = 'whsec_leak_probe_99887766';
      const failConn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brandA.id}/connections`,
        {
          token: tokenA,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'Fail Echo Webhook',
            siteBaseUrl: `${mock.baseUrl}/webhook/fail-401`,
            credentials: { signingSecret: leakSecret },
          },
        },
      );
      expect(failConn.status).toBe(200);
      expect(failConn.rawText).not.toContain(leakSecret);

      const failTest = await apiCall<ChannelConnectionTestResultDto>(
        'POST',
        `/api/v2/brands/${brandA.id}/connections/${failConn.body.data.id}/test`,
        { token: tokenA, body: {} },
      );
      expect(failTest.status).toBe(200);
      expect(failTest.body.data.ok).toBe(false);
      expect(failTest.rawText).not.toContain(leakSecret);
      expect(store.connections.get(failConn.body.data.id)!.lastError ?? '').not.toContain(
        leakSecret,
      );

      // Runner upstream failure also sanitizes lastError (create ACTIVE connection to /webhook/fail-500)
      const fail500Conn = await apiCall<ChannelConnectionDto>(
        'POST',
        `/api/v2/brands/${brandA.id}/connections`,
        {
          token: tokenA,
          body: {
            market: 'GLOBAL',
            provider: 'WEBHOOK',
            displayName: 'Fail 500 Echo Webhook',
            siteBaseUrl: `${mock.baseUrl}/webhook/fail-500`,
            credentials: { signingSecret: leakSecret },
          },
        },
      );
      expect(fail500Conn.status).toBe(200);
      const genFailVar = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${artA.id}/distributions/variants`,
        {
          token: tokenA,
          headers: { 'idempotency-key': 'loop3-fail-runner' },
          body: {
            targets: [
              {
                provider: 'WEBHOOK',
                connectionId: fail500Conn.body.data.id,
                channelLabel: 'Fail Webhook',
              },
            ],
          },
        },
      );
      expect(genFailVar.status).toBe(200);
      const failTaskId = genFailVar.body.data.tasks[0]!.id;
      const failPubRes = await apiCall('POST', `/api/v2/distributions/${failTaskId}/publish`, {
        token: tokenA,
        body: { publishAsDraft: false },
      });
      expect(failPubRes.status).toBe(200);
      expect(enqueuedDistributions).toHaveLength(1);
      await distributionRunner.process(enqueuedDistributions.pop()!);
      const failedTask = store.tasks.get(failTaskId)!;
      expect(failedTask.status).toBe('FAILED');
      expect(failedTask.lastError ?? '').not.toContain(leakSecret);

      // 3. Cross-tenant isolation (404) & Expired tenant write guard (403/40301) (T2-12)
      const crossConn = await apiCall('GET', `/api/v2/brands/${brandA.id}/connections`, {
        token: tokenB,
      });
      expect(crossConn.status).toBe(404);

      const crossDist = await apiCall('GET', `/api/v2/articles/${artA.id}/distributions`, {
        token: tokenB,
      });
      expect(crossDist.status).toBe(404);

      const crossPatch = await apiCall('PATCH', `/api/v2/distributions/${failTaskId}`, {
        token: tokenB,
        body: { variantTitle: 'Hijacked' },
      });
      expect(crossPatch.status).toBe(404);

      const pubRecA = await apiCall<GeoPublishRecordDto>(
        'POST',
        `/api/v2/articles/${artA.id}/publish-records`,
        {
          token: tokenA,
          body: {
            publishedUrl: `${mock.baseUrl}/crawl/ok/post`,
            channel: 'Official Blog',
          },
        },
      );
      expect(pubRecA.status).toBe(200);

      const crossProbe = await apiCall(
        'POST',
        `/api/v2/publish-records/${pubRecA.body.data.id}/crawl-probe`,
        { token: tokenB },
      );
      expect(crossProbe.status).toBe(404);

      const crossSched = await apiCall(
        'PATCH',
        `/api/v2/publish-records/${pubRecA.body.data.id}/retest-schedules`,
        { token: tokenB, body: { sampleCount: 3 } },
      );
      expect(crossSched.status).toBe(404);

      const expiredWrite = await apiCall('POST', `/api/v2/brands/${brandExp.id}/connections`, {
        token: expiredToken,
        body: {
          market: 'GLOBAL',
          provider: 'WEBHOOK',
          displayName: 'Expired',
          siteBaseUrl: `${mock.baseUrl}/webhook/publish`,
          credentials: { signingSecret: 'whsec_expired_123456' },
        },
      });
      expect(expiredWrite.status).toBe(403);
      expect(expiredWrite.body.code).toBe(40301);
    });
  });

  // ── Loop 4: T+1 Crawl & Schema Probe (All 5 Diagnostic Cases + Maintenance Sweep) ──
  describe('Loop 4 — T+1 Crawl & Schema Probe Across 5 Diagnostic Targets (T1-07, T2-09)', () => {
    it('classifies ok, blocked-gptbot, noindex, bad-jsonld, and 404 via manual 0-pt endpoint & MaintenanceRunner sweep', async () => {
      const { tenant, user } = store.seedTenant({
        id: 't_loop4',
        username: 'merchant_l4',
        points: 20,
        billingMode: 'STRICT',
      });
      const token = mintJwt(user);
      const { brand, globalMarket } = store.seedBrandWithMarkets({
        tenantId: tenant.id,
        name: 'CrawlBrand',
      });
      const article = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        title: 'Crawl Probe Diagnostic Article',
        contentMarkdown: '# Crawl Probe\nDiagnostics verification.',
      });

      const createRec = async (path: string, channel: string) => {
        const res = await apiCall<GeoPublishRecordDto>(
          'POST',
          `/api/v2/articles/${article.id}/publish-records`,
          {
            token,
            body: {
              publishedUrl: `${mock.baseUrl}${path}`,
              channel,
              autoRetest: { enabled: false },
            },
          },
        );
        expect(res.status).toBe(200);
        return res.body.data.id;
      };

      const idOk = await createRec('/crawl/ok/post', 'Official Blog');
      const idBlocked = await createRec('/crawl/blocked-gptbot/post', 'Blocked Blog');
      const idNoindex = await createRec('/crawl/noindex/post', 'Noindex Blog');
      const idBadJsonLd = await createRec('/crawl/bad-jsonld/post', 'BadJsonLd Blog');
      const idNotFound = await createRec('/crawl/not-found', 'Missing Page');

      // Manual 0-pt probes for 4 cases
      const probeOk = await apiCall<GeoPublishRecordDto>(
        'POST',
        `/api/v2/publish-records/${idOk}/crawl-probe`,
        { token },
      );
      expect(probeOk.status).toBe(200);
      expect(probeOk.body.data.crawlStatus).toBe('OK');
      expect(probeOk.body.data.crawlReportJson?.httpStatus).toBe(200);
      expect(probeOk.body.data.crawlReportJson?.jsonLdTypes).toEqual(
        expect.arrayContaining(['Article', 'FAQPage']),
      );
      expect(
        probeOk.body.data.crawlReportJson?.robotsMatrix.find((r) => r.bot === 'GPTBot')?.allowed,
      ).toBe(true);
      expect(store.wallets.get(tenant.id)!.points).toBe(20); // 0 pts!

      const probeBlocked = await apiCall<GeoPublishRecordDto>(
        'POST',
        `/api/v2/publish-records/${idBlocked}/crawl-probe`,
        { token },
      );
      expect(probeBlocked.body.data.crawlStatus).toBe('BLOCKED');
      expect(
        probeBlocked.body.data.crawlReportJson?.robotsMatrix.find((r) => r.bot === 'GPTBot')
          ?.allowed,
      ).toBe(false);
      expect(
        probeBlocked.body.data.crawlReportJson?.robotsMatrix.find((r) => r.bot === 'PerplexityBot')
          ?.allowed,
      ).toBe(true);

      const probeNoindex = await apiCall<GeoPublishRecordDto>(
        'POST',
        `/api/v2/publish-records/${idNoindex}/crawl-probe`,
        { token },
      );
      expect(probeNoindex.body.data.crawlStatus).toBe('BLOCKED');
      expect(probeNoindex.body.data.crawlReportJson?.metaNoindex).toBe(true);

      const probeBadJson = await apiCall<GeoPublishRecordDto>(
        'POST',
        `/api/v2/publish-records/${idBadJsonLd}/crawl-probe`,
        { token },
      );
      expect(probeBadJson.body.data.crawlStatus).toBe('WARNING');
      expect(probeBadJson.body.data.crawlReportJson?.jsonLdParseErrors.length).toBeGreaterThan(0);

      // 5th target (404) swept automatically via MaintenanceRunner.run('crawl-probe-sweep')!
      store.publishRecords.get(idNotFound)!.publishedAt = new Date(
        Date.now() - 25 * 60 * 60 * 1000,
      );
      const sweepResult = await maintenanceRunner.run('crawl-probe-sweep');
      expect(sweepResult).toMatch(/^crawl-probe-sweep:\d+\/\d+$/);
      const swept404 = store.publishRecords.get(idNotFound)!;
      expect(swept404.crawlStatus).toBe('FAILED');
      expect((swept404.crawlReportJson as { httpStatus?: number } | null)?.httpStatus).toBe(404);
    });
  });

  // ── Loop 5: Anonymous PR Share + Scheduled Retest Sweep + /home Attribution (PRD D5) ──
  describe('Loop 5 — Anonymous PR Share, Scheduled Retest Sweep & /home Attribution (T1-08, T1-10, T2-10, T2-11, T3-03, T3-04)', () => {
    it('executes full Loop 5: PR share security, T+7/14/30 sweep idempotency, 3-sample writeback, insufficient/no-engine/SHADOW/CANCELLED, and PRD D5 attribution', async () => {
      const { tenant, user } = store.seedTenant({
        id: 't_loop5',
        username: 'merchant_l5',
        points: 100,
        billingMode: 'STRICT',
      });
      const token = mintJwt(user);
      const { brand, globalMarket } = store.seedBrandWithMarkets({
        tenantId: tenant.id,
        name: 'NordVault',
      });
      const article = store.seedArticle({
        tenantId: tenant.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        title: 'NordVault X400 Pro PR Media Kit',
        contentMarkdown:
          '# NordVault X400 Pro\n26 dBA silent 4-bay NAS with 16GB ECC DDR5 and $599 MSRP.',
      });

      // 1. Generate PR_PACKET variant & issue 30-day share link
      const prGen = await apiCall<GenerateVariantsResult>(
        'POST',
        `/api/v2/articles/${article.id}/distributions/variants`,
        {
          token,
          headers: { 'idempotency-key': 'loop5-pr-gen' },
          body: {
            targets: [
              {
                provider: 'PR_PACKET',
                channelLabel: 'PR Tech Media',
                templateKey: 'PR_MEDIA_PACKET',
              },
            ],
          },
        },
      );
      expect(prGen.status).toBe(200);
      const prTaskId = prGen.body.data.tasks[0]!.id;

      const shareRes = await apiCall<PrShareLinkResultDto>(
        'POST',
        `/api/v2/distributions/${prTaskId}/pr-share`,
        { token, body: { ttlDays: 30 } },
      );
      expect(shareRes.status).toBe(200);
      const rawToken = shareRes.body.data.token;
      expect(shareRes.body.data.shareUrl).toBe(`http://127.0.0.1:3000/share/pr/${rawToken}`);

      // DB stores ONLY SHA-256 hash, never plaintext token
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(store.tasks.get(prTaskId)!.shareTokenHash).toBe(expectedHash);

      // 2. Unauthenticated GET /api/v2/public/pr-packets/:token -> strict allowlist DTO
      const pubGet = await apiCall<PublicPrPacketDto>(
        'GET',
        `/api/v2/public/pr-packets/${rawToken}`,
      );
      expect(pubGet.status).toBe(200);
      expect(pubGet.body.data.market).toBe('GLOBAL');
      expect(pubGet.body.data.brandName).toBe('NordVault');
      expect(pubGet.rawText).not.toContain(tenant.id);
      expect(pubGet.rawText).not.toContain(user.username);
      expect(pubGet.rawText).not.toContain(expectedHash);

      // Private IP submit rejected with 400 (T2-11, T3-04)
      enforcePublicOnly();
      const badIpSubmit = await apiCall('POST', `/api/v2/public/pr-packets/${rawToken}/submit`, {
        body: { publishedUrl: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(badIpSubmit.status).toBe(400);
      allowLocalMock();

      // Valid submit creates GeoPublishRecord + T+7/14/30 schedules + marks task PUBLISHED
      const submittedUrl = `${mock.baseUrl}/crawl/ok/post`;
      const submit1 = await apiCall<PublicPrPacketSubmitResultDto>(
        'POST',
        `/api/v2/public/pr-packets/${rawToken}/submit`,
        { body: { publishedUrl: submittedUrl, note: 'Published on TechRadar' } },
      );
      expect(submit1.status).toBe(200);
      expect(submit1.body.data.accepted).toBe(true);
      expect(submit1.body.data.alreadyRecorded).toBe(false);
      expect(store.tasks.get(prTaskId)!.status).toBe('PUBLISHED');

      // Duplicate submit is idempotent (T2-11, T3-04)
      const submit2 = await apiCall<PublicPrPacketSubmitResultDto>(
        'POST',
        `/api/v2/public/pr-packets/${rawToken}/submit`,
        { body: { publishedUrl: submittedUrl } },
      );
      expect(submit2.status).toBe(200);
      expect(submit2.body.data.alreadyRecorded).toBe(true);

      const prPubRec = [...store.publishRecords.values()].find(
        (r) => r.distributionTaskId === prTaskId,
      )!;
      expect(prPubRec).toBeDefined();
      // Attach baseline beforeMetrics so mentionDelta computes cleanly
      prPubRec.beforeMetrics = {
        mentionRate: 20,
        avgPosition: 4.0,
        sentiment: 'neutral',
        citationHit: false,
      };

      // Update schedule to sampleCount: 3 via PATCH /api/v2/publish-records/:id/retest-schedules (T1-09)
      const patchSched = await apiCall<UpdateRetestSchedulesResultDto>(
        'PATCH',
        `/api/v2/publish-records/${prPubRec.id}/retest-schedules`,
        { token, body: { sampleCount: 3 } },
      );
      expect(patchSched.status).toBe(200);
      expect(patchSched.body.data.items).toHaveLength(3);
      expect(patchSched.body.data.items.every((s) => s.sampleCount === 3)).toBe(true);

      // 3. Advance T+7 dueAt -> run retest-schedule-sweep (onlineEngines × 3 samples × 2 pts)
      const healthSvc = app.get(VisibilityEngineHealthService);
      const globalAvail = await healthSvc.getAvailability('GLOBAL');
      const onlineCount = globalAvail.engines.filter((e) => e.available).length;
      expect(onlineCount).toBeGreaterThan(0);

      const schedules = [...store.retestSchedules.values()]
        .filter((s) => s.publishRecordId === prPubRec.id)
        .sort((a, b) => a.milestoneDay - b.milestoneDay);
      const sched7 = schedules[0]!;
      const sched14 = schedules[1]!;
      const sched30 = schedules[2]!;
      sched7.dueAt = new Date(Date.now() - 60_000);

      const pointsBeforeSweep = store.wallets.get(tenant.id)!.points;
      const sweep1 = await maintenanceRunner.run('retest-schedule-sweep');
      expect(sched7.skipReason).toBeNull();
      expect(sweep1).toContain('retest-schedule-sweep:1/1');
      expect(sched7.status).toBe('RUNNING');
      expect(sched7.visibilityRunId).toBeTruthy();
      expect(enqueuedVisibilityRuns).toHaveLength(1);

      const run7Id = sched7.visibilityRunId!;
      const run7Obs = [...store.visibilityObservations.values()].filter((o) => o.runId === run7Id);
      // onlineCount engines × 3 samples
      expect(run7Obs).toHaveLength(onlineCount * 3);
      expect(new Set(run7Obs.map((o) => o.sampleIndex))).toEqual(new Set([1, 2, 3]));
      // Wallet reserved exact onlineCount × 3 × 2 pts
      expect(store.wallets.get(tenant.id)!.pointsReserved).toBe(onlineCount * 3 * 2);

      // Re-running sweep immediately is 100% idempotent (no duplicate run or charge!) (T2-10)
      const sweepDup = await maintenanceRunner.run('retest-schedule-sweep');
      expect(sweepDup).toContain('retest-schedule-sweep:0/0');
      expect(enqueuedVisibilityRuns).toHaveLength(1);
      expect(store.wallets.get(tenant.id)!.points).toBe(pointsBeforeSweep);

      // Simulate 3-sample completion WITHOUT upstream citations (2/3 hits per engine = 66.7%) for PRD D5!
      const run7Row = store.visibilityRuns.get(run7Id)!;
      run7Row.status = 'COMPLETED';
      run7Row.completedChecks = run7Obs.length;
      for (const obs of run7Obs) {
        obs.status = 'SUCCESS';
        obs.brandMentioned = obs.sampleIndex !== 3; // 2/3 = 66.7%
        obs.brandPosition = obs.brandMentioned ? 2 : null;
        obs.brandSentiment = obs.brandMentioned ? 'positive' : 'neutral';
        obs.answerText = obs.brandMentioned ? 'NordVault X400 Pro ranks #2.' : 'Other NAS options.';
      }

      await retestMetricsHook.onVisibilityRunComplete({
        tenantId: tenant.id,
        runId: run7Id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        triggerType: 'RETEST',
        retestArticleId: article.id,
        status: 'COMPLETED',
        successCount: run7Obs.length,
      });

      expect(sched7.status).toBe('COMPLETED');
      const snap7 = sched7.metricsSnapshotJson as {
        mentionRate: number;
        sampleCount: number;
        hitCount: number;
        citationHit: boolean;
      };
      expect(snap7.sampleCount).toBe(onlineCount * 3);
      expect(snap7.hitCount).toBe(onlineCount * 2);
      expect(snap7.mentionRate).toBeCloseTo(66.7, 0);
      expect(snap7.citationHit).toBe(false);

      // 4. Zero balance in STRICT mode -> T+14 marked SKIPPED_INSUFFICIENT_POINTS, wallet stays strictly 0 (T2-10, T3-03)
      const wallet = store.wallets.get(tenant.id)!;
      wallet.points = 0;
      wallet.pointsReserved = 0;
      sched14.dueAt = new Date(Date.now() - 60_000);
      await maintenanceRunner.run('retest-schedule-sweep');
      expect(sched14.status).toBe('SKIPPED_INSUFFICIENT_POINTS');
      expect(sched14.skipReason).toBeTruthy();
      expect(wallet.points).toBe(0);

      // 5. CANCELLED schedule is skipped; 0 online engines -> SKIPPED_NO_ENGINE; SHADOW zero-balance passes (T2-10, T3-03)
      sched30.status = 'CANCELLED';
      sched30.dueAt = new Date(Date.now() - 60_000);
      await maintenanceRunner.run('retest-schedule-sweep');
      expect(sched30.status).toBe('CANCELLED');

      // Re-enable T+30 with 0 online engines -> SKIPPED_NO_ENGINE
      sched30.status = 'PENDING';
      wallet.points = 100;
      const noEngineSpy = vi.spyOn(healthSvc, 'getAvailability').mockResolvedValue({
        market: 'GLOBAL',
        engines: [],
        onlineEngines: [],
        defaultEngines: [],
        checkedAt: new Date().toISOString(),
      } as unknown as Awaited<ReturnType<VisibilityEngineHealthService['getAvailability']>>);
      await maintenanceRunner.run('retest-schedule-sweep');
      noEngineSpy.mockRestore();
      expect(sched30.status).toBe('SKIPPED_NO_ENGINE');

      // SHADOW zero-balance passes without blocking (T3-03)
      const { tenant: shadowTenant } = store.seedTenant({
        id: 't_shadow_retest',
        username: 'shadow_u',
        points: 0,
        billingMode: 'SHADOW',
      });
      const { brand: sBrand, globalMarket: sMkt } = store.seedBrandWithMarkets({
        tenantId: shadowTenant.id,
        name: 'ShadowBrand',
      });
      const sArt = store.seedArticle({
        tenantId: shadowTenant.id,
        brandId: sBrand.id,
        brandMarketId: sMkt.id,
        title: 'Shadow Guide',
        contentMarkdown: '# Shadow',
      });
      const sPub = await runInTenant(shadowTenant.id, () =>
        app
          .get(GeoDeliveryService)
          .createPublishRecord(
            sArt.id,
            { publishedUrl: `${mock.baseUrl}/crawl/ok/post`, channel: 'Shadow Blog' },
            { tenantId: shadowTenant.id, userId: 'u_shadow' },
          ),
      );
      const sSched7 = [...store.retestSchedules.values()].find(
        (s) => s.publishRecordId === sPub.id && s.milestoneDay === 7,
      )!;
      sSched7.dueAt = new Date(Date.now() - 60_000);
      await maintenanceRunner.run('retest-schedule-sweep');
      expect(sSched7.status).toBe('RUNNING');
      expect(store.wallets.get(shadowTenant.id)!.points).toBe(0);

      // 6. GET /api/v2/brands/:id/home?market=GLOBAL — PRD D5 zero-citation graceful degradation -> lights up when citation arrives!
      const homeBeforeCite = await apiCall<ActionHomeResponse>(
        'GET',
        `/api/v2/brands/${brand.id}/home?market=GLOBAL&days=14`,
        { token },
      );
      expect(homeBeforeCite.status).toBe(200);
      const summary1 = homeBeforeCite.body.data.distributionSummary!;
      expect(summary1).toBeDefined();
      expect(summary1.upcomingRetests.some((r) => r.status === 'SKIPPED_INSUFFICIENT_POINTS')).toBe(
        true,
      );
      const attr1 = summary1.channelAttribution.find((c) => c.channel === 'PR Tech Media')!;
      expect(attr1).toBeDefined();
      expect(attr1.completedRetestCount).toBe(1);
      expect(attr1.citationHitRate).toBeNull(); // PRD D5: graceful degradation (NOT NaN, NOT misleading 0%)
      expect(attr1.avgMentionRateDelta).toBeCloseTo(46.7, 0);
      expect(attr1.avgPosition).toBe(2);
      expect(JSON.stringify(summary1)).not.toContain('NaN');

      // Now run T+30 with a real citation matching publishedUrl -> citationHitRate lights up from null to 1!
      sched30.status = 'PENDING';
      sched30.dueAt = new Date(Date.now() - 60_000);
      await maintenanceRunner.run('retest-schedule-sweep');
      expect(sched30.status).toBe('RUNNING');
      const run30Id = sched30.visibilityRunId!;
      const run30Obs = [...store.visibilityObservations.values()].filter(
        (o) => o.runId === run30Id,
      );
      store.visibilityRuns.get(run30Id)!.status = 'COMPLETED';
      for (const obs of run30Obs) {
        obs.status = 'SUCCESS';
        obs.brandMentioned = true;
        obs.brandPosition = 1;
        obs.brandSentiment = 'positive';
        obs.answerText = 'NordVault X400 Pro is cited directly.';
      }
      const citeId = store.nextId('cit');
      store.visibilityCitations.set(citeId, {
        id: citeId,
        tenantId: tenant.id,
        observationId: run30Obs[0]!.id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        url: submittedUrl,
        domain: '127.0.0.1',
        title: 'NordVault Coverage',
        sourceKind: 'AUTHORITY',
        position: 1,
        createdAt: new Date(),
      });
      await retestMetricsHook.onVisibilityRunComplete({
        tenantId: tenant.id,
        runId: run30Id,
        brandId: brand.id,
        brandMarketId: globalMarket.id,
        triggerType: 'RETEST',
        retestArticleId: article.id,
        status: 'COMPLETED',
        successCount: run30Obs.length,
      });
      expect(sched30.status).toBe('COMPLETED');

      const homeAfterCite = await apiCall<ActionHomeResponse>(
        'GET',
        `/api/v2/brands/${brand.id}/home?market=GLOBAL&days=14`,
        { token },
      );
      const attr2 = homeAfterCite.body.data.distributionSummary!.channelAttribution.find(
        (c) => c.channel === 'PR Tech Media',
      )!;
      expect(attr2.citationHitCount).toBe(1);
      expect(attr2.citationHitRate).toBe(1);

      // 7. Public PR Packet uniform 404 (unknown, expired, revoked) & 429 IP brute force (T2-11, T3-04)
      const unknownGet = await apiCall(
        'GET',
        '/api/v2/public/pr-packets/nonexistent_token_12345678',
      );
      expect(unknownGet.status).toBe(404);
      const unknownPost = await apiCall(
        'POST',
        '/api/v2/public/pr-packets/nonexistent_token_12345678/submit',
        { body: { publishedUrl: 'http://127.0.0.1/ssrf' } },
      );
      expect(unknownPost.status).toBe(404); // Uniform 404 BEFORE SSRF/body check!

      // Expired token -> uniform 404
      store.tasks.get(prTaskId)!.shareExpiresAt = new Date(Date.now() - 60_000);
      const expiredGet = await apiCall('GET', `/api/v2/public/pr-packets/${rawToken}`);
      expect(expiredGet.status).toBe(404);
      expect(expiredGet.body.msg).toBe(unknownGet.body.msg);

      // Restore expiry & revoke via DELETE .../pr-share -> uniform 404
      store.tasks.get(prTaskId)!.shareExpiresAt = new Date(Date.now() + 86_400_000);
      const revokeRes = await apiCall('DELETE', `/api/v2/distributions/${prTaskId}/pr-share`, {
        token,
      });
      expect(revokeRes.status).toBe(200);
      const revokedGet = await apiCall('GET', `/api/v2/public/pr-packets/${rawToken}`);
      expect(revokedGet.status).toBe(404);
      expect(revokedGet.body.msg).toBe(unknownGet.body.msg);

      // Verify GET /api/v2/articles/:id/distributions returns tasks with nested publishRecords (T1-09)
      const distList = await apiCall<{ items: GeoDistributionTaskWithRecordsDto[] }>(
        'GET',
        `/api/v2/articles/${article.id}/distributions`,
        { token },
      );
      expect(distList.status).toBe(200);
      expect(distList.body.data.items.length).toBeGreaterThan(0);

      // High-frequency brute force -> 429 (T2-11); reset limiter immediately after!
      let hit429 = false;
      for (let i = 0; i < 35; i += 1) {
        const res = await apiCall('GET', `/api/v2/public/pr-packets/brute_probe_${i}_abcdefgh`);
        if (res.status === 429) {
          hit429 = true;
          break;
        }
      }
      expect(hit429).toBe(true);
      publicPrSvc.resetRateLimits();
      freeLimiter.reset();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Optional Real-Postgres Supplement (GEOMIX_DB_INTEGRATION=1)
// ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'GeoMix v2.1 Distribution Real-Postgres DDL & Isolation Supplement',
  () => {
    it('enforces real Postgres unique constraints, onDelete: SetNull, chk_wallet_nonneg & prisma.scoped isolation', async () => {
      const ctx = await createIsolatedTestContext('dist_e2e');
      try {
        const tenantA = await ctx.createTenantUser({
          prefix: 'dist_pg_a',
          points: 20,
          billingMode: 'STRICT',
        });
        const tenantB = await ctx.createTenantUser({
          prefix: 'dist_pg_b',
          points: 20,
          billingMode: 'STRICT',
        });

        const brandA = await ctx.prisma.base.brand.create({
          data: {
            tenantId: tenantA.tenantId,
            name: 'PgBrandA',
            category: 'Storage',
          },
        });
        const marketA = await ctx.prisma.base.brandMarket.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            market: 'GLOBAL',
            locale: 'en-US',
            region: 'US',
            localBrandName: 'PgBrandA',
          },
        });
        const articleA = await ctx.prisma.base.geoArticle.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            title: 'PG Constraint Article',
            targetPrompt: 'pg prompt',
            recipe: 'AUTHORITY_GUIDE',
            targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
            contentMarkdown: '# PG Article',
            contentHtml: '<h1>PG Article</h1>',
          },
        });
        const connA = await ctx.prisma.base.channelConnection.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            provider: 'WEBHOOK',
            displayName: 'PG Webhook',
            siteBaseUrl: 'https://hooks.example.com/pg',
            credentialsCiphertext: 'cipher',
            credentialsIv: 'iv',
            credentialsTag: 'tag',
            credentialHint: '****1234',
          },
        });
        const taskA = await ctx.prisma.base.geoDistributionTask.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            articleId: articleA.id,
            connectionId: connA.id,
            provider: 'WEBHOOK',
            mode: 'L1_API',
            channelLabel: 'PG Webhook',
            variantTitle: 'PG Variant',
            variantMarkdown: '# PG Variant',
            variantHtml: '<h1>PG Variant</h1>',
          },
        });

        // 1. ChannelConnection delete -> onDelete: SetNull preserves GeoDistributionTask
        await ctx.prisma.base.channelConnection.delete({ where: { id: connA.id } });
        const taskAfterDelete = await ctx.prisma.base.geoDistributionTask.findUnique({
          where: { id: taskA.id },
        });
        expect(taskAfterDelete?.connectionId).toBeNull();

        // 2. GeoRetestSchedule @@unique([publishRecordId, milestoneDay])
        const pubA = await ctx.prisma.base.geoPublishRecord.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            articleId: articleA.id,
            distributionTaskId: taskA.id,
            publishedUrl: 'https://example.com/pg-post',
            channel: 'Official Blog',
          },
        });
        await ctx.prisma.base.geoRetestSchedule.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            publishRecordId: pubA.id,
            milestoneDay: 7,
            dueAt: new Date(Date.now() + 7 * 86_400_000),
          },
        });
        await expect(
          ctx.prisma.base.geoRetestSchedule.create({
            data: {
              tenantId: tenantA.tenantId,
              brandId: brandA.id,
              brandMarketId: marketA.id,
              publishRecordId: pubA.id,
              milestoneDay: 7,
              dueAt: new Date(Date.now() + 7 * 86_400_000),
            },
          }),
        ).rejects.toThrow();

        // 3. VisibilityObservation @@unique([runId, promptText, engine, sampleIndex])
        const runA = await ctx.prisma.base.visibilityRun.create({
          data: {
            tenantId: tenantA.tenantId,
            brandId: brandA.id,
            brandMarketId: marketA.id,
            name: 'PG Constraint Run',
            engines: ['chatgpt'],
            prompts: ['pg prompt'],
            totalChecks: 3,
            unitPrice: 2,
          },
        });
        for (const sampleIndex of [1, 2, 3]) {
          await ctx.prisma.base.visibilityObservation.create({
            data: {
              tenantId: tenantA.tenantId,
              runId: runA.id,
              brandId: brandA.id,
              brandMarketId: marketA.id,
              promptText: 'pg prompt',
              engine: 'chatgpt',
              sampleIndex,
            },
          });
        }
        await expect(
          ctx.prisma.base.visibilityObservation.create({
            data: {
              tenantId: tenantA.tenantId,
              runId: runA.id,
              brandId: brandA.id,
              brandMarketId: marketA.id,
              promptText: 'pg prompt',
              engine: 'chatgpt',
              sampleIndex: 1,
            },
          }),
        ).rejects.toThrow();

        // 4. chk_wallet_nonneg constraint
        await expect(
          ctx.prisma.base
            .$executeRaw`UPDATE "Wallet" SET points = -1 WHERE "tenantId" = ${tenantA.tenantId}`,
        ).rejects.toThrow();

        // 5. Real prisma.scoped cross-tenant isolation
        const tenantBTasks = await runInTenant(tenantB.tenantId, () =>
          ctx.prisma.scoped.geoDistributionTask.findMany(),
        );
        const tenantBSchedules = await runInTenant(tenantB.tenantId, () =>
          ctx.prisma.scoped.geoRetestSchedule.findMany(),
        );
        expect(tenantBTasks).toHaveLength(0);
        expect(tenantBSchedules).toHaveLength(0);
      } finally {
        await ctx.close();
      }
    }, 60_000);
  },
);
