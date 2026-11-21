import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  parseEnv,
  type GeoArticleListResponse,
  type GeoArticleRecord,
  type GeoBatchJobRecord,
  type GeoRewriteSectionResponse,
  type PromptPreferenceRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BillingService, type ReservationView } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';
import { BrandFactIndexRunner } from '../brands/brand-fact-index.runner';
import { ApiError } from '../common/api-error';
import { createApiApp } from '../common/create-api-app';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntime } from '../queue/queue.runtime';
import { currentTenantId } from '../tenant/tenant-context';
import { WorkerModule } from '../worker.module';
import { GEO_BATCH_ENQUEUER, GeoBatchRunner, type GeoBatchJobData } from './geo-batch.runner';
import { StudioGenerationService } from './studio-generation.service';
import { StudioService } from './studio.service';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

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
  competitors: unknown;
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type BrandRow = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  truthAgreementIp: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BriefRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  status: string;
  targetPrompt: string;
  suggestedTitle: string;
  recommendedRecipe: string;
  targetFormat: string;
  outlineH2: unknown;
  targetFanOuts: string[];
  matchedFactIds: string[];
  sourceCitationUrl: string | null;
};

type ArticleRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  briefId: string | null;
  batchJobId: string | null;
  recipe: string;
  targetFormat: string;
  title: string;
  targetPrompt: string;
  outlineJson: unknown;
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: unknown;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: unknown;
  tags: string[];
  status: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  complianceFlags: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type BatchRow = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  briefIds: string[];
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

type PrefRow = {
  tenantId: string;
  customToneNote: string | null;
  customForbiddenWords: string[];
  recipeOverrides: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function parseSseFrames(raw: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join('\n');
    try {
      frames.push({ event, data: JSON.parse(rawData) });
    } catch {
      frames.push({ event, data: rawData });
    }
  }
  return frames;
}

describe('Studio HTTP v2 endpoints, SSE streaming, billing refund & WorkerModule DI boot', () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokenTenantA: string;
  let tokenTenantB: string;
  let tokenExpired: string;
  let rateLimiter: FreeActionRateLimiter;

  const wallets = new Map<string, { points: number; reserved: number; strict: boolean }>();
  const reservations = new Map<string, ReservationView>();
  const enqueuedBatches: GeoBatchJobData[] = [];
  const prefUpdateCalls: Array<Record<string, unknown>> = [];

  const tenants = new Map<
    string,
    {
      id: string;
      name: string;
      expiresAt: Date;
      isActive: boolean;
      billingMode: 'SHADOW' | 'STRICT' | null;
    }
  >();
  const users = new Map<
    string,
    {
      id: string;
      tenantId: string;
      username: string;
      passwordHash: string;
      role: 'MERCHANT' | 'ADMIN';
    }
  >();
  const brands = new Map<string, BrandRow>();
  const markets = new Map<string, BrandMarketRow>();
  const facts = new Map<
    string,
    { id: string; tenantId: string; brandId: string; slot: string; title: string; content: string }
  >();
  const briefs = new Map<string, BriefRow>();
  const articles = new Map<string, ArticleRow>();
  const batches = new Map<string, BatchRow>();
  const prefs = new Map<string, PrefRow>();
  const mediaUsedCounts = new Map<string, number>();

  function tenantIdOrThrow(): string {
    const tid = currentTenantId();
    if (!tid) throw new Error('missing tenant context');
    return tid;
  }

  function buildScoped() {
    const filterTenant = <T extends { tenantId: string }>(values: Iterable<T>) => {
      const tid = tenantIdOrThrow();
      return [...values].filter((v) => v.tenantId === tid);
    };

    const brandDelegate = {
      findFirst: async (args: { where: { id?: string } }) => {
        const b = filterTenant(brands.values()).find(
          (r) => !args.where.id || r.id === args.where.id,
        );
        if (!b) return null;
        return {
          ...b,
          markets: [...markets.values()].filter(
            (m) => m.brandId === b.id && m.tenantId === b.tenantId,
          ),
        };
      },
      findMany: async () =>
        filterTenant(brands.values()).map((b) => ({
          ...b,
          markets: [...markets.values()].filter((m) => m.brandId === b.id),
        })),
    };

    const geoBriefDelegate = {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        filterTenant(briefs.values()).find(
          (b) =>
            (!args.where.id || b.id === args.where.id) &&
            (!args.where.brandId || b.brandId === args.where.brandId) &&
            (!args.where.brandMarketId || b.brandMarketId === args.where.brandMarketId),
        ) ?? null,
      findMany: async (args: {
        where: { id?: { in: string[] }; brandId?: string; brandMarketId?: string };
      }) =>
        filterTenant(briefs.values()).filter(
          (b) =>
            (!args.where.id?.in || args.where.id.in.includes(b.id)) &&
            (!args.where.brandId || b.brandId === args.where.brandId) &&
            (!args.where.brandMarketId || b.brandMarketId === args.where.brandMarketId),
        ),
      updateMany: async (args: {
        where: { id?: string | { in: string[] }; status?: string };
        data: { status?: string };
      }) => {
        let count = 0;
        for (const b of filterTenant(briefs.values())) {
          const idMatch =
            !args.where.id ||
            (typeof args.where.id === 'string'
              ? b.id === args.where.id
              : args.where.id.in.includes(b.id));
          const statusMatch = !args.where.status || b.status === args.where.status;
          if (idMatch && statusMatch) {
            if (args.data.status) b.status = args.data.status;
            count += 1;
          }
        }
        return { count };
      },
    };

    const geoArticleDelegate = {
      findFirst: async (args: { where: { id?: string } }) => {
        const row = filterTenant(articles.values()).find(
          (a) => !args.where.id || a.id === args.where.id,
        );
        if (!row) return null;
        return {
          ...row,
          brand: brands.get(row.brandId),
          brandMarket: markets.get(row.brandMarketId),
          brief: row.briefId ? (briefs.get(row.briefId) ?? null) : null,
        };
      },
      findMany: async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
        const rows = filterTenant(articles.values())
          .filter((a) => {
            if (args.where.brandId && a.brandId !== args.where.brandId) return false;
            if (args.where.brandMarketId && a.brandMarketId !== args.where.brandMarketId)
              return false;
            if (args.where.status && a.status !== args.where.status) return false;
            const tagsFilter = args.where.tags as { has?: string } | undefined;
            if (tagsFilter?.has && !a.tags.includes(tagsFilter.has)) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 50));
      },
      count: async (args: { where: Record<string, unknown> }) =>
        filterTenant(articles.values()).filter((a) => {
          if (args.where.brandId && a.brandId !== args.where.brandId) return false;
          if (args.where.brandMarketId && a.brandMarketId !== args.where.brandMarketId)
            return false;
          if (args.where.status && a.status !== args.where.status) return false;
          return true;
        }).length,
      create: async (args: { data: Record<string, unknown> }) => {
        const tid = tenantIdOrThrow();
        const now = new Date();
        const row: ArticleRow = {
          id: String(args.data.id ?? `art_${articles.size + 1}`),
          tenantId: tid,
          brandId: String(args.data.brandId),
          brandMarketId: String(args.data.brandMarketId),
          briefId: (args.data.briefId as string | null) ?? null,
          batchJobId: (args.data.batchJobId as string | null) ?? null,
          recipe: String(args.data.recipe),
          targetFormat: String(args.data.targetFormat),
          title: String(args.data.title),
          targetPrompt: String(args.data.targetPrompt),
          outlineJson: args.data.outlineJson ?? [],
          contentMarkdown: String(args.data.contentMarkdown),
          contentHtml: String(args.data.contentHtml),
          schemaJsonLd: args.data.schemaJsonLd ?? {},
          llmsTxtSnippet: (args.data.llmsTxtSnippet as string | null) ?? null,
          geoScore: Number(args.data.geoScore ?? 0),
          geoScoreDetail: args.data.geoScoreDetail ?? {},
          tags: (args.data.tags as string[]) ?? [],
          status: String(args.data.status ?? 'DRAFT'),
          model: (args.data.model as string | null) ?? null,
          tokensIn: (args.data.tokensIn as number | null) ?? null,
          tokensOut: (args.data.tokensOut as number | null) ?? null,
          complianceFlags: args.data.complianceFlags ?? [],
          createdAt: now,
          updatedAt: now,
        };
        articles.set(row.id, row);
        return { ...row, brandMarket: markets.get(row.brandMarketId) };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = filterTenant(articles.values()).find((a) => a.id === args.where.id);
        if (!existing) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(existing, args.data, { updatedAt: new Date() });
        return { ...existing, brandMarket: markets.get(existing.brandMarketId) };
      },
      delete: async (args: { where: { id: string } }) => {
        const existing = filterTenant(articles.values()).find((a) => a.id === args.where.id);
        if (!existing) throw Object.assign(new Error('not found'), { code: 'P2025' });
        articles.delete(existing.id);
        return existing;
      },
      deleteMany: async (args: { where: { id?: string } }) => {
        let count = 0;
        for (const a of filterTenant(articles.values())) {
          if (!args.where.id || a.id === args.where.id) {
            articles.delete(a.id);
            count += 1;
          }
        }
        return { count };
      },
    };

    const geoBatchJobDelegate = {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const row = filterTenant(batches.values()).find(
          (j) =>
            (!args.where.id || j.id === args.where.id) &&
            (!args.where.brandId || j.brandId === args.where.brandId) &&
            (!args.where.reservationId || j.reservationId === args.where.reservationId),
        );
        return row ? { ...row, brandMarket: markets.get(row.brandMarketId) } : null;
      },
      findMany: async (args: { where: { brandId?: string; brandMarketId?: string } }) =>
        filterTenant(batches.values()).filter(
          (j) =>
            (!args.where.brandId || j.brandId === args.where.brandId) &&
            (!args.where.brandMarketId || j.brandMarketId === args.where.brandMarketId),
        ),
      count: async (args: { where: { brandId?: string; brandMarketId?: string } }) =>
        filterTenant(batches.values()).filter(
          (j) =>
            (!args.where.brandId || j.brandId === args.where.brandId) &&
            (!args.where.brandMarketId || j.brandMarketId === args.where.brandMarketId),
        ).length,
      deleteMany: async (args: { where: { id?: string } }) => {
        let count = 0;
        for (const j of filterTenant(batches.values())) {
          if (!args.where.id || j.id === args.where.id) {
            batches.delete(j.id);
            count += 1;
          }
        }
        return { count };
      },
    };

    const promptPreferenceDelegate = {
      findFirst: async () => prefs.get(tenantIdOrThrow()) ?? null,
      create: async (args: { data: Partial<PrefRow> }) => {
        const tid = tenantIdOrThrow();
        const now = new Date();
        const normalizedOverrides =
          args.data.recipeOverrides === Prisma.DbNull ? null : (args.data.recipeOverrides ?? null);
        const row: PrefRow = {
          tenantId: tid,
          customToneNote: args.data.customToneNote ?? null,
          customForbiddenWords: args.data.customForbiddenWords ?? [],
          recipeOverrides: normalizedOverrides,
          createdAt: now,
          updatedAt: now,
        };
        prefs.set(tid, row);
        return row;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        const tid = tenantIdOrThrow();
        const existing = prefs.get(tid)!;
        prefUpdateCalls.push({ ...args.data });
        const patch: Partial<PrefRow> = { ...args.data } as Partial<PrefRow>;
        if (args.data.recipeOverrides === Prisma.DbNull) {
          patch.recipeOverrides = null;
        }
        Object.assign(existing, patch, { updatedAt: new Date() });
        return existing;
      },
    };

    return {
      brand: brandDelegate,
      brandFact: {
        findMany: async (args: { where: { brandId?: string } }) =>
          filterTenant(facts.values()).filter(
            (f) => !args.where.brandId || f.brandId === args.where.brandId,
          ),
      },
      brandMediaAsset: {
        updateMany: async (args: { where: { id?: { in: string[] } } }) => {
          let count = 0;
          for (const id of args.where.id?.in ?? []) {
            mediaUsedCounts.set(id, (mediaUsedCounts.get(id) ?? 0) + 1);
            count += 1;
          }
          return { count };
        },
      },
      pointReservation: {
        findFirst: async (args: { where: { refType?: string; refId?: string } }) =>
          [...reservations.values()].find(
            (r) =>
              r.tenantId === tenantIdOrThrow() &&
              (!args.where.refType || r.refType === args.where.refType) &&
              (!args.where.refId || r.refId === args.where.refId),
          ) ?? null,
      },
      geoBrief: geoBriefDelegate,
      geoArticle: geoArticleDelegate,
      geoBatchJob: geoBatchJobDelegate,
      promptPreference: promptPreferenceDelegate,
    };
  }

  const fakePrisma = {
    scoped: new Proxy(
      {},
      {
        get: (_target, prop: string) => (buildScoped() as Record<string, unknown>)[prop],
      },
    ),
    base: {
      tenant: {
        findUnique: async (args: { where: { id: string } }) => tenants.get(args.where.id) ?? null,
      },
      user: {
        findUnique: async (args: { where: { id?: string; username?: string } }) => {
          const user = [...users.values()].find(
            (u) =>
              (args.where.id && u.id === args.where.id) ||
              (args.where.username && u.username === args.where.username),
          );
          if (!user) return null;
          return { ...user, tenant: tenants.get(user.tenantId)! };
        },
      },
      auditLog: {
        create: async () => ({ id: 'audit_1' }),
        findMany: async () => [],
      },
      brandFact: {
        findMany: async (args: { where: { tenantId: string; brandId: string } }) =>
          [...facts.values()]
            .filter((f) => f.tenantId === args.where.tenantId && f.brandId === args.where.brandId)
            .map((f) => ({ ...f, indexStatus: 'NONE', updatedAt: new Date() })),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          geoBatchJob: {
            create: async (args: { data: Record<string, unknown> }) => {
              const now = new Date();
              const row: BatchRow = {
                id: String(args.data.id),
                tenantId: String(args.data.tenantId),
                brandId: String(args.data.brandId),
                brandMarketId: String(args.data.brandMarketId),
                briefIds: (args.data.briefIds as string[]) ?? [],
                total: Number(args.data.total ?? 0),
                doneCount: 0,
                failCount: 0,
                unitPrice: Number(args.data.unitPrice ?? 10),
                reservationId: (args.data.reservationId as string | null) ?? null,
                status: 'QUEUED',
                lastError: null,
                createdAt: now,
                updatedAt: now,
                finishedAt: null,
              };
              batches.set(row.id, row);
              return row;
            },
          },
          geoBrief: {
            updateMany: async (args: {
              where: { tenantId: string; id: { in: string[] }; status: string };
              data: { status: string };
            }) => {
              let count = 0;
              for (const id of args.where.id.in) {
                const b = briefs.get(id);
                if (b && b.tenantId === args.where.tenantId && b.status === args.where.status) {
                  b.status = args.data.status;
                  count += 1;
                }
              }
              return { count };
            },
          },
        }),
      $disconnect: async () => undefined,
    },
    $connect: async () => undefined,
    $disconnect: async () => undefined,
  };

  const fakeBilling = {
    unitPrice: vi.fn(async () => 10),
    reserve: vi.fn(
      async (input: { tenantId: string; refType: string; refId: string; amount: number }) => {
        const key = `${input.refType}::${input.refId}`;
        const existing = reservations.get(key);
        if (existing) return existing;
        const w = wallets.get(input.tenantId) ?? { points: 100, reserved: 0, strict: true };
        if (w.strict && w.points - w.reserved < input.amount) {
          throw new ApiError(402, API_ERROR.INSUFFICIENT_POINTS, '可用点数不足');
        }
        if (w.strict) w.reserved += input.amount;
        const res: ReservationView = {
          id: `res_${reservations.size + 1}`,
          tenantId: input.tenantId,
          refType: input.refType,
          refId: input.refId,
          shadow: !w.strict,
          frozen: input.amount,
          settled: 0,
          released: 0,
          status: 'OPEN',
        };
        reservations.set(key, res);
        return res;
      },
    ),
    settleGeoWriteUnit: vi.fn(
      async (input: { tenantId: string; reservationId: string; geoWritePoints: number }) => {
        const res = [...reservations.values()].find((r) => r.id === input.reservationId);
        if (!res || res.status === 'CLOSED') throw new Error('closed');
        res.settled += input.geoWritePoints;
        const w = wallets.get(input.tenantId);
        if (w && !res.shadow) {
          w.reserved = Math.max(0, w.reserved - input.geoWritePoints);
          w.points -= input.geoWritePoints;
        }
      },
    ),
    releaseUnit: vi.fn(
      async (input: { tenantId: string; reservationId: string; amount: number }) => {
        const res = [...reservations.values()].find((r) => r.id === input.reservationId);
        if (!res || res.status === 'CLOSED') return;
        const remaining = Math.max(0, res.frozen - res.settled - res.released);
        const releaseNow = Math.min(remaining, input.amount);
        res.released += releaseNow;
        const w = wallets.get(input.tenantId);
        if (w && !res.shadow) {
          w.reserved = Math.max(0, w.reserved - releaseNow);
        }
      },
    ),
    close: vi.fn(async (input: { tenantId: string; reservationId: string }) => {
      const res = [...reservations.values()].find((r) => r.id === input.reservationId);
      if (!res || res.status === 'CLOSED') return;
      const remaining = Math.max(0, res.frozen - res.settled - res.released);
      res.released += remaining;
      res.status = 'CLOSED';
      const w = wallets.get(input.tenantId);
      if (w && !res.shadow) {
        w.reserved = Math.max(0, w.reserved - remaining);
      }
    }),
  };

  beforeAll(async () => {
    process.env.LLM_PROVIDERS = '{}';
    process.env.BILLING_MODE = 'SHADOW';
    const env = parseEnv(process.env);
    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as {
      base: unknown;
      scoped: unknown;
    };
    prismaSvc.base = fakePrisma.base;
    prismaSvc.scoped = fakePrisma.scoped;

    const billingSvc = app.get(BillingService);
    vi.spyOn(billingSvc, 'unitPrice').mockImplementation(fakeBilling.unitPrice);
    vi.spyOn(billingSvc, 'reserve').mockImplementation(fakeBilling.reserve);
    vi.spyOn(billingSvc, 'settleGeoWriteUnit').mockImplementation(
      fakeBilling.settleGeoWriteUnit as unknown as BillingService['settleGeoWriteUnit'],
    );
    vi.spyOn(billingSvc, 'releaseUnit').mockImplementation(
      fakeBilling.releaseUnit as unknown as BillingService['releaseUnit'],
    );
    vi.spyOn(billingSvc, 'close').mockImplementation(
      fakeBilling.close as unknown as BillingService['close'],
    );

    const quotaSvc = app.get(QuotaService);
    vi.spyOn(quotaSvc, 'applyArticleEvent').mockResolvedValue(undefined);

    const batchEnqueuer = app.get<{ enqueueGeoBatch(job: GeoBatchJobData): Promise<void> }>(
      GEO_BATCH_ENQUEUER,
    );
    vi.spyOn(batchEnqueuer, 'enqueueGeoBatch').mockImplementation(async (job) => {
      enqueuedBatches.push(job);
    });

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/api/v2`;
    rateLimiter = app.get(FreeActionRateLimiter);

    const pwd = 'hashed-password';
    const fp = passwordFingerprint(pwd);
    tenants.set('tenant_a', {
      id: 'tenant_a',
      name: 'Tenant A',
      expiresAt: new Date(Date.now() + 86_400_000),
      isActive: true,
      billingMode: 'STRICT',
    });
    tenants.set('tenant_b', {
      id: 'tenant_b',
      name: 'Tenant B',
      expiresAt: new Date(Date.now() + 86_400_000),
      isActive: true,
      billingMode: 'STRICT',
    });
    tenants.set('tenant_expired', {
      id: 'tenant_expired',
      name: 'Expired Tenant',
      expiresAt: new Date(Date.now() - 86_400_000),
      isActive: true,
      billingMode: 'STRICT',
    });
    users.set('user_a', {
      id: 'user_a',
      tenantId: 'tenant_a',
      username: 'user_a',
      passwordHash: pwd,
      role: 'MERCHANT',
    });
    users.set('user_b', {
      id: 'user_b',
      tenantId: 'tenant_b',
      username: 'user_b',
      passwordHash: pwd,
      role: 'MERCHANT',
    });
    users.set('user_expired', {
      id: 'user_expired',
      tenantId: 'tenant_expired',
      username: 'user_expired',
      passwordHash: pwd,
      role: 'MERCHANT',
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const mintAccess = (sub: string, tid: string) =>
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

    tokenTenantA = mintAccess('user_a', 'tenant_a');
    tokenTenantB = mintAccess('user_b', 'tenant_b');
    tokenExpired = mintAccess('user_expired', 'tenant_expired');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    wallets.clear();
    reservations.clear();
    enqueuedBatches.length = 0;
    brands.clear();
    markets.clear();
    facts.clear();
    briefs.clear();
    articles.clear();
    batches.clear();
    prefs.clear();
    mediaUsedCounts.clear();
    rateLimiter.reset();

    wallets.set('tenant_a', { points: 100, reserved: 0, strict: true });
    wallets.set('tenant_b', { points: 100, reserved: 0, strict: true });
    wallets.set('tenant_expired', { points: 100, reserved: 0, strict: true });

    const now = new Date();
    brands.set('brand_a', {
      id: 'brand_a',
      tenantId: 'tenant_a',
      name: '星辰存储',
      category: '家用 NAS',
      truthAgreementSignedAt: now,
      truthAgreementIp: '127.0.0.1',
      createdAt: now,
      updatedAt: now,
    });
    markets.set('mkt_a_cn', {
      id: 'mkt_a_cn',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '星辰存储',
      aliases: ['DXP4800'],
      ownedDomains: ['star.example.com'],
      competitors: [{ name: '竞品甲', aliases: [], domains: ['comp.example.com'] }],
      seedPrompts: ['家用 NAS 怎么选'],
      createdAt: now,
      updatedAt: now,
    });
    markets.set('mkt_a_global', {
      id: 'mkt_a_global',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      market: 'GLOBAL',
      locale: 'en-US',
      region: 'US',
      localBrandName: 'AstraVault',
      aliases: ['DXP4800'],
      ownedDomains: ['astravault.example.com'],
      competitors: [{ name: 'Synology', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['Best 4-bay NAS 2026'],
      createdAt: now,
      updatedAt: now,
    });
    facts.set('fact_1', {
      id: 'fact_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      slot: 'PRODUCT_SPECS',
      title: '核心硬件参数',
      content:
        'Intel N100 处理器，满载噪音 18.5dB，待机功耗 14W，双 2.5GbE，支持 96TB，通过 ISO9001 认证。',
    });
    briefs.set('brief_1', {
      id: 'brief_1',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'mkt_a_cn',
      status: 'OPEN',
      targetPrompt: '四盘位静音家用 NAS 推荐',
      suggestedTitle: '2026 四盘位静音家用 NAS 选购指南',
      recommendedRecipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      outlineH2: [{ heading: '核心静音参数实测', intent: '展示数据' }],
      targetFanOuts: ['18.5dB', '2.5GbE'],
      matchedFactIds: ['fact_1'],
      sourceCitationUrl: null,
    });
    briefs.set('brief_2', {
      id: 'brief_2',
      tenantId: 'tenant_a',
      brandId: 'brand_a',
      brandMarketId: 'mkt_a_cn',
      status: 'OPEN',
      targetPrompt: '家用 NAS 功耗对比评测',
      suggestedTitle: '家用 NAS 待机功耗实测对比',
      recommendedRecipe: 'COMPARISON_MATRIX',
      targetFormat: 'CN_DEEP_REVIEW',
      outlineH2: [],
      targetFanOuts: ['14W'],
      matchedFactIds: ['fact_1'],
      sourceCitationUrl: null,
    });
    brands.set('brand_exp', {
      id: 'brand_exp',
      tenantId: 'tenant_expired',
      name: '过期品牌',
      category: 'NAS',
      truthAgreementSignedAt: now,
      truthAgreementIp: null,
      createdAt: now,
      updatedAt: now,
    });
    markets.set('mkt_exp_cn', {
      id: 'mkt_exp_cn',
      tenantId: 'tenant_expired',
      brandId: 'brand_exp',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '过期品牌',
      aliases: [],
      ownedDomains: [],
      competitors: [],
      seedPrompts: [],
      createdAt: now,
      updatedAt: now,
    });
  });

  it('streams SSE meta -> delta+ -> complete with proper headers, settles 10 pts, and supports idempotent replay', async () => {
    const res = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-stream-cn-0001',
      },
      body: JSON.stringify({
        market: 'CN',
        briefId: 'brief_1',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '四盘位静音家用 NAS 推荐',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const raw = await res.text();
    const frames = parseSseFrames(raw);
    expect(frames[0]?.event).toBe('meta');
    const deltas = frames.filter((f) => f.event === 'delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const completeFrame = frames.find((f) => f.event === 'complete');
    expect(completeFrame).toBeDefined();

    const completeData = completeFrame!.data as {
      article: GeoArticleRecord;
      geoScore: number;
    };
    expect(Array.isArray(completeData.article.complianceFlags)).toBe(true);
    expect(completeData.geoScore).toBeGreaterThanOrEqual(85);
    expect(completeData.article.contentHtml).toContain('<table>');
    expect(briefs.get('brief_1')?.status).toBe('DONE');
    expect(wallets.get('tenant_a')?.points).toBe(90);
    expect(wallets.get('tenant_a')?.reserved).toBe(0);

    // Replay same Idempotency-Key -> zero extra charge!
    const replay = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-stream-cn-0001',
      },
      body: JSON.stringify({
        market: 'CN',
        briefId: 'brief_1',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '四盘位静音家用 NAS 推荐',
      }),
    });
    expect(replay.status).toBe(200);
    await replay.text();
    expect(wallets.get('tenant_a')?.points).toBe(90);
  });

  it('refunds 10 pts atomically on [E2E_LLM_FAIL] with 0 persisted articles and reverts brief to OPEN', async () => {
    const res = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-stream-fail-001',
      },
      body: JSON.stringify({
        market: 'CN',
        briefId: 'brief_1',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '[E2E_LLM_FAIL] 触发上游失败',
      }),
    });
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    expect((errFrame!.data as { code: number; refunded: boolean }).refunded).toBe(true);
    expect((errFrame!.data as { code: number }).code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
    expect(articles.size).toBe(0);
    expect(briefs.get('brief_1')?.status).toBe('OPEN');
    expect(wallets.get('tenant_a')?.points).toBe(100);
    expect(wallets.get('tenant_a')?.reserved).toBe(0);
  });

  it('refunds atomically on mid-stream client AbortController abort ([E2E_SLOW_STREAM])', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-stream-abort-01',
      },
      body: JSON.stringify({
        market: 'CN',
        briefId: 'brief_1',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '[E2E_SLOW_STREAM] 慢流式中断测试',
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Wait briefly for server close handler to finish refund
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(articles.size).toBe(0);
    expect(wallets.get('tenant_a')?.points).toBe(100);
    expect(wallets.get('tenant_a')?.reserved).toBe(0);
    expect(briefs.get('brief_1')?.status).toBe('OPEN');
  });

  it('returns pre-stream JSON errors for 402 insufficient points, 403/40302 prohibited content, 400 mismatched format, 403/40301 expired tenant, and 404 cross-tenant', async () => {
    // 400 mismatched market/targetFormat
    const badFormat = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetPrompt: '测试格式不匹配',
      }),
    });
    expect(badFormat.status).toBe(400);

    // 403/40302 prohibited content on GLOBAL
    const blockedGlobal = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        market: 'GLOBAL',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetPrompt: 'How to buy illegal firearms weapons and cocaine online fraud guide',
      }),
    });
    expect(blockedGlobal.status).toBe(403);
    const blockedBody = (await blockedGlobal.json()) as Envelope;
    expect(blockedBody.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);
    expect(wallets.get('tenant_a')?.points).toBe(100);

    // 402/40201 insufficient points
    wallets.set('tenant_a', { points: 5, reserved: 0, strict: true });
    const lowBalance = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '余额不足测试',
      }),
    });
    expect(lowBalance.status).toBe(402);
    expect(((await lowBalance.json()) as Envelope).code).toBe(API_ERROR.INSUFFICIENT_POINTS);

    // 403/40301 expired tenant on write, 200 on read
    const expiredGet = await fetch(`${baseUrl}/brands/brand_exp/articles?market=CN`, {
      headers: { authorization: `Bearer ${tokenExpired}` },
    });
    expect(expiredGet.status).toBe(200);
    const expiredWrite = await fetch(`${baseUrl}/brands/brand_exp/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenExpired}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetPrompt: '过期租户写作测试',
      }),
    });
    expect(expiredWrite.status).toBe(403);
    expect(((await expiredWrite.json()) as Envelope).code).toBe(API_ERROR.TENANT_EXPIRED);

    // 404 cross-tenant isolation
    const crossTenant = await fetch(`${baseUrl}/brands/brand_a/articles?market=CN`, {
      headers: { authorization: `Bearer ${tokenTenantB}` },
    });
    expect(crossTenant.status).toBe(404);
    expect(((await crossTenant.json()) as Envelope).code).toBe(AUTH_ERROR.NOT_FOUND);

    // 400 nested/array qs rejection
    const nestedQs = await fetch(`${baseUrl}/brands/brand_a/articles?market[]=CN`, {
      headers: { authorization: `Bearer ${tokenTenantA}` },
    });
    expect(nestedQs.status).toBe(400);
  });

  it('supports article CRUD, PATCH with usedMediaIds, inline rewrite (0 pts + 429 rate limit), 2-20 batch validation, and prompt preferences', async () => {
    // 1. Prompt preferences GET/PUT
    const pref0 = (await (
      await fetch(`${baseUrl}/prompt-preferences`, {
        headers: { authorization: `Bearer ${tokenTenantA}` },
      })
    ).json()) as Envelope<PromptPreferenceRecord>;
    expect(pref0.data.customForbiddenWords).toEqual([]);

    const prefPut = (await (
      await fetch(`${baseUrl}/prompt-preferences`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${tokenTenantA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customToneNote: '保持客观技术评测口吻',
          customForbiddenWords: ['天花板', '吊打'],
        }),
      })
    ).json()) as Envelope<PromptPreferenceRecord>;
    expect(prefPut.data.customToneNote).toBe('保持客观技术评测口吻');
    expect(prefPut.data.customForbiddenWords).toEqual(['天花板', '吊打']);

    // 2. Create GLOBAL article via SSE
    const streamRes = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-global-crud-01',
      },
      body: JSON.stringify({
        market: 'GLOBAL',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'GLOBAL_AUTHORITY_GUIDE',
        targetPrompt: 'Best 4-bay NAS 2026',
      }),
    });
    const frames = parseSseFrames(await streamRes.text());
    const complete = frames.find((f) => f.event === 'complete')!.data as {
      article: GeoArticleRecord;
    };
    const articleId = complete.article.id;

    // 3. List isolated by market (GLOBAL has 1, CN has 0)
    const globalList = (await (
      await fetch(`${baseUrl}/brands/brand_a/articles?market=GLOBAL`, {
        headers: { authorization: `Bearer ${tokenTenantA}` },
      })
    ).json()) as Envelope<GeoArticleListResponse>;
    expect(globalList.data.total).toBe(1);

    const cnList = (await (
      await fetch(`${baseUrl}/brands/brand_a/articles?market=CN`, {
        headers: { authorization: `Bearer ${tokenTenantA}` },
      })
    ).json()) as Envelope<GeoArticleListResponse>;
    expect(cnList.data.total).toBe(0);

    // 4. PATCH article (status, tags, usedMediaIds)
    const patchRes = (await (
      await fetch(`${baseUrl}/articles/${articleId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${tokenTenantA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'READY',
          tags: ['NAS', '2026'],
          usedMediaIds: ['media_1'],
        }),
      })
    ).json()) as Envelope<GeoArticleRecord>;
    expect(patchRes.code).toBe(0);
    expect(patchRes.data.status).toBe('READY');
    expect(patchRes.data.tags).toEqual(['NAS', '2026']);
    expect(mediaUsedCounts.get('media_1')).toBe(1);

    // 5. Inline rewrite (0 pts, TO_TABLE produces GFM table, burst triggers 429)
    const pointsBeforeRewrite = wallets.get('tenant_a')!.points;
    const rwRes = await fetch(`${baseUrl}/articles/${articleId}/rewrite-section`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        selectedText: 'AstraVault runs at 18.5dB and draws 14W idle.',
        action: 'TO_TABLE',
      }),
    });
    expect(rwRes.status).toBe(200);
    const rwBody = (await rwRes.json()) as Envelope<GeoRewriteSectionResponse>;
    expect(rwBody.data.rewrittenText).toMatch(/\|[^\n]+\|/);
    expect(wallets.get('tenant_a')!.points).toBe(pointsBeforeRewrite);

    // Burst past default 20/60s limit -> 429
    let hit429 = false;
    for (let i = 0; i < 25; i += 1) {
      const burst = await fetch(`${baseUrl}/articles/${articleId}/rewrite-section`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenTenantA}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          selectedText: `Paragraph ${i}`,
          action: 'CONCISE_ANSWER',
        }),
      });
      if (burst.status === 429) {
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);

    // 6. Batch validation (<2 -> 400) & valid 2-brief batch creation (reserves 20 pts, enqueues job)
    const batchTooSmall = await fetch(`${baseUrl}/brands/brand_a/articles/batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ market: 'CN', briefIds: ['brief_1'] }),
    });
    expect(batchTooSmall.status).toBe(400);

    const batchRes = await fetch(`${baseUrl}/brands/brand_a/articles/batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-batch-cn-0001',
      },
      body: JSON.stringify({ market: 'CN', briefIds: ['brief_1', 'brief_2'] }),
    });
    expect(batchRes.status).toBe(200);
    const batchBody = (await batchRes.json()) as Envelope<GeoBatchJobRecord>;
    expect(batchBody.data.total).toBe(2);
    expect(batchBody.data.unitPrice).toBe(10);
    expect(enqueuedBatches).toHaveLength(1);
    expect(wallets.get('tenant_a')?.reserved).toBe(20);

    // 7. DELETE article
    const delRes = (await (
      await fetch(`${baseUrl}/articles/${articleId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenTenantA}` },
      })
    ).json()) as Envelope<{ deleted: boolean; id: string }>;
    expect(delRes.data).toEqual({ deleted: true, id: articleId });
  });

  it('boots WorkerModule DI graph cleanly and resolves GeoBatchRunner and StudioGenerationService', async () => {
    const startSpy = vi.spyOn(QueueRuntime.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(QueueRuntime.prototype, 'stop').mockResolvedValue(undefined);
    const destroySpy = vi
      .spyOn(PrismaService.prototype, 'onModuleDestroy')
      .mockResolvedValue(undefined);
    const workerApp = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      expect(workerApp.get(GeoBatchRunner)).toBeInstanceOf(GeoBatchRunner);
      expect(workerApp.get(StudioGenerationService)).toBeInstanceOf(StudioGenerationService);
      expect(workerApp.get(BrandFactIndexRunner)).toBeInstanceOf(BrandFactIndexRunner);
      expect(app.get(StudioService)).toBeInstanceOf(StudioService);
    } finally {
      await workerApp.close();
      startSpy.mockRestore();
      stopSpy.mockRestore();
      destroySpy.mockRestore();
    }
  });

  it('uses Prisma.DbNull when clearing recipeOverrides, blocks concurrent in-flight duplicate streams, validates targetFormat & STRICT replay billingMode, and rejects CLOSED batch reservations', async () => {
    // 1. PromptPreference clearing recipeOverrides passes Prisma.DbNull (Prisma 5 Json? contract)
    prefUpdateCalls.length = 0;
    await fetch(`${baseUrl}/prompt-preferences`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        customToneNote: '初始口吻',
        recipeOverrides: { AUTHORITY_GUIDE: '多给参数' },
      }),
    });
    const clearPrefRes = await fetch(`${baseUrl}/prompt-preferences`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        recipeOverrides: null,
      }),
    });
    expect(clearPrefRes.status).toBe(200);
    expect(prefUpdateCalls.at(-1)?.recipeOverrides).toBe(Prisma.DbNull);
    const clearPrefBody = (await clearPrefRes.json()) as Envelope<PromptPreferenceRecord>;
    expect(clearPrefBody.data.recipeOverrides).toBeNull();

    // 2. Concurrent duplicate Idempotency-Key during in-flight [E2E_SLOW_STREAM] returns 409/40902
    const slowKey = 'idem-concurrent-slow-01';
    const slowBody = JSON.stringify({
      market: 'CN',
      recipe: 'AUTHORITY_GUIDE',
      targetFormat: 'CN_DEEP_REVIEW',
      targetPrompt: '[E2E_SLOW_STREAM] 并发幂等锁验证',
    });
    const req1Promise = fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': slowKey,
      },
      body: slowBody,
    });
    await new Promise((r) => setTimeout(r, 80));
    const req2Res = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': slowKey,
      },
      body: slowBody,
    });
    expect(req2Res.status).toBe(409);
    const req2Body = (await req2Res.json()) as Envelope;
    expect(req2Body.code).toBe(40902);

    const req1Res = await req1Promise;
    expect(req1Res.status).toBe(200);
    const req1Frames = parseSseFrames(await req1Res.text());
    expect(req1Frames.some((f) => f.event === 'complete')).toBe(true);

    // 3. Replay with mismatched targetFormat returns 409/40902; exact replay emits STRICT billingMode
    const mismatchRes = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': slowKey,
      },
      body: JSON.stringify({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_COMMUNITY_QA',
        targetPrompt: '[E2E_SLOW_STREAM] 并发幂等锁验证',
      }),
    });
    expect(mismatchRes.status).toBe(409);
    expect(((await mismatchRes.json()) as Envelope).code).toBe(40902);

    const replayRes = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': slowKey,
      },
      body: slowBody,
    });
    expect(replayRes.status).toBe(200);
    const replayFrames = parseSseFrames(await replayRes.text());
    const replayMeta = replayFrames.find((f) => f.event === 'meta')?.data as {
      billingMode: string;
    };
    expect(replayMeta.billingMode).toBe('STRICT');

    // 4. Batch Idempotency-Key attached to a CLOSED reservation (e.g. prior enqueue failure) returns 409/40902
    const batchEnqueuer = app.get<{ enqueueGeoBatch(job: GeoBatchJobData): Promise<void> }>(
      GEO_BATCH_ENQUEUER,
    );
    const failOnceSpy = vi
      .spyOn(batchEnqueuer, 'enqueueGeoBatch')
      .mockRejectedValueOnce(new Error('redis down'));
    const failedBatchRes = await fetch(`${baseUrl}/brands/brand_a/articles/batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-batch-closed-0001',
      },
      body: JSON.stringify({ market: 'CN', briefIds: ['brief_1', 'brief_2'] }),
    });
    expect(failedBatchRes.status).toBe(500);
    failOnceSpy.mockRestore();

    const retryClosedBatchRes = await fetch(`${baseUrl}/brands/brand_a/articles/batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-batch-closed-0001',
      },
      body: JSON.stringify({ market: 'CN', briefIds: ['brief_1', 'brief_2'] }),
    });
    expect(retryClosedBatchRes.status).toBe(409);
    expect(((await retryClosedBatchRes.json()) as Envelope).code).toBe(40902);
  });

  it('tracks BrandMediaAsset.usedCount cleanly across explicit usedMediaIds, newly embedded markdown URLs, deduplication, and repeated saves', async () => {
    const streamRes = await fetch(`${baseUrl}/brands/brand_a/articles/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-media-used-count-01',
      },
      body: JSON.stringify({
        market: 'CN',
        recipe: 'AUTHORITY_GUIDE',
        targetFormat: 'CN_DEEP_REVIEW',
        targetPrompt: '测试图片引用计数逻辑',
      }),
    });
    expect(streamRes.status).toBe(200);
    const frames = parseSseFrames(await streamRes.text());
    const completeData = frames.find((f) => f.event === 'complete')?.data as {
      article: GeoArticleRecord;
    };
    const article = completeData.article;
    mediaUsedCounts.clear();

    // 1. Insert media_1 via both usedMediaIds AND markdown URL, plus media_2 via markdown URL only,
    //    plus a foreign-brand URL that must be ignored.
    const md1 = `${article.contentMarkdown}\n\n![实拍1](/api/v2/brands/brand_a/media/media_1/file?tid=tenant_a&exp=999&sig=abc)\n\n![实拍2](/api/v2/brands/brand_a/media/media_2/thumb?tid=tenant_a&exp=999&sig=def)\n\n![越权](/api/v2/brands/brand_other/media/media_foreign/file?tid=tenant_b)`;
    const patch1 = await fetch(`${baseUrl}/articles/${article.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contentMarkdown: md1,
        usedMediaIds: ['media_1'],
      }),
    });
    expect(patch1.status).toBe(200);
    expect(mediaUsedCounts.get('media_1')).toBe(1);
    expect(mediaUsedCounts.get('media_2')).toBe(1);
    expect(mediaUsedCounts.get('media_foreign')).toBeUndefined();

    // 2. Subsequent unrelated text edit keeps existing image URLs -> zero double-counting!
    const patch2 = await fetch(`${baseUrl}/articles/${article.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenTenantA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contentMarkdown: `${md1}\n\n补充一段客观说明文字。`,
      }),
    });
    expect(patch2.status).toBe(200);
    expect(mediaUsedCounts.get('media_1')).toBe(1);
    expect(mediaUsedCounts.get('media_2')).toBe(1);
  });
});
