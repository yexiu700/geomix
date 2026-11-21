import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  parseEnv,
  type VisibilityCitationListResponse,
  type VisibilityEngineAvailabilityResponse,
  type VisibilityOpportunitiesResponse,
  type VisibilityOverviewResponse,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { hasLiveActiveWork } from '../queue/active-work';
import { QueueProducer } from '../queue/queue.producer';
import { currentTenantId } from '../tenant/tenant-context';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityEngineHealthService } from './visibility-engine-health.service';
import {
  VisibilityRunRunner,
  type OnVisibilityRunCompleteHook,
  type VisibilityCheckJobData,
  type VisibilityRunCompleteEvent,
} from './visibility-run.runner';

type Envelope<T = unknown> = { code: number; msg: string; data: T };

type TenantRec = {
  id: string;
  name: string;
  expiresAt: Date;
  isActive: boolean;
  billingMode: 'SHADOW' | 'STRICT' | null;
  createdAt: Date;
};

type UserRec = {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: 'MERCHANT' | 'ADMIN';
  lastLoginAt: Date | null;
};

type WalletRec = {
  tenantId: string;
  points: number;
  pointsReserved: number;
  money: Prisma.Decimal;
  updatedAt: Date;
};

type QuotaRec = {
  id: string;
  tenantId: string;
  key: (typeof QUOTA_DEFAULTS)[number]['key'];
  used: bigint;
  limit: bigint;
};

type ReservationRec = {
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

type PointLogRec = {
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

type BrandRec = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BrandMarketRec = {
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
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type RunRec = {
  id: string;
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  name: string;
  engines: string[];
  prompts: string[];
  triggerType: 'MANUAL' | 'RETEST';
  retestArticleId: string | null;
  briefsGeneratedAt: Date | null;
  totalChecks: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

type ObservationRec = {
  id: string;
  tenantId: string;
  runId: string;
  brandId: string;
  brandMarketId: string;
  promptText: string;
  engine: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  collectorKind: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  brandPassage: string | null;
  competitorHits: Prisma.JsonValue | null;
  fanOutQueries: string[];
  judgeModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  checkedAt: Date | null;
  createdAt: Date;
};

type CitationRec = {
  id: string;
  tenantId: string;
  observationId: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  sourceKind: string;
  position: number;
  createdAt: Date;
};

class InMemoryVisibilityStore {
  private seq = 1;
  readonly tenants = new Map<string, TenantRec>();
  readonly users = new Map<string, UserRec>();
  readonly wallets = new Map<string, WalletRec>();
  readonly quotas: QuotaRec[] = [];
  readonly pricingItems = new Map<string, { action: string; unitPoints: number; enabled: boolean }>(
    PRICING_DEFAULTS.map((p) => [
      p.action,
      { action: p.action, unitPoints: p.unitPoints, enabled: true },
    ]),
  );
  readonly reservations = new Map<string, ReservationRec>();
  readonly pointLogs: PointLogRec[] = [];
  readonly auditLogs: Array<{
    id: string;
    tenantId: string | null;
    userId: string | null;
    action: string;
    payload: Prisma.JsonValue | null;
    createdAt: Date;
  }> = [];
  readonly brands = new Map<string, BrandRec>();
  readonly brandMarkets = new Map<string, BrandMarketRec>();
  readonly runs = new Map<string, RunRec>();
  readonly observations = new Map<string, ObservationRec>();
  readonly citations = new Map<string, CitationRec>();

  nextId(prefix: string): string {
    return `${prefix}_${String(this.seq++).padStart(4, '0')}`;
  }

  seedTenant(input: {
    tenantId: string;
    userId: string;
    username: string;
    points: number;
    billingMode: 'SHADOW' | 'STRICT' | null;
    expiresAt?: Date;
  }): string {
    const now = new Date();
    const passwordHash = `hash:${input.username}`;
    this.tenants.set(input.tenantId, {
      id: input.tenantId,
      name: `租户_${input.username}`,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
      isActive: true,
      billingMode: input.billingMode,
      createdAt: now,
    });
    this.users.set(input.userId, {
      id: input.userId,
      tenantId: input.tenantId,
      username: input.username,
      passwordHash,
      nickname: input.username,
      role: 'MERCHANT',
      lastLoginAt: now,
    });
    this.wallets.set(input.tenantId, {
      tenantId: input.tenantId,
      points: input.points,
      pointsReserved: 0,
      money: new Prisma.Decimal('100.00'),
      updatedAt: now,
    });
    for (const q of QUOTA_DEFAULTS) {
      this.quotas.push({
        id: this.nextId('qta'),
        tenantId: input.tenantId,
        key: q.key,
        used: 0n,
        limit: BigInt(q.limit),
      });
    }

    const secret = parseEnv(process.env).JWT_ACCESS_SECRET;
    const nowSec = Math.floor(Date.now() / 1000);
    return signToken(
      {
        sub: input.userId,
        tid: input.tenantId,
        role: 'MERCHANT',
        typ: 'access',
        fp: passwordFingerprint(passwordHash),
        lms: Date.now(),
        iat: nowSec,
        exp: nowSec + 3600,
      },
      secret,
    );
  }

  seedBrand(input: {
    tenantId: string;
    name: string;
    category?: string;
    markets: Array<{
      market: 'CN' | 'GLOBAL';
      locale?: string;
      region?: string;
      localBrandName?: string;
      aliases?: string[];
      ownedDomains?: string[];
      competitors?: Array<{ name: string; aliases?: string[]; domains?: string[] }>;
      seedPrompts?: string[];
    }>;
  }): { brand: BrandRec; markets: BrandMarketRec[] } {
    const now = new Date();
    const brandId = this.nextId('brand');
    const brand: BrandRec = {
      id: brandId,
      tenantId: input.tenantId,
      name: input.name,
      category: input.category ?? '硬件',
      truthAgreementSignedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.brands.set(brandId, brand);
    const createdMarkets: BrandMarketRec[] = input.markets.map((m) => {
      const bm: BrandMarketRec = {
        id: this.nextId('bm'),
        tenantId: input.tenantId,
        brandId,
        market: m.market,
        locale: m.locale ?? (m.market === 'GLOBAL' ? 'en-US' : 'zh-CN'),
        region: m.region ?? (m.market === 'GLOBAL' ? 'US' : 'CN'),
        localBrandName: m.localBrandName ?? input.name,
        aliases: m.aliases ?? [],
        ownedDomains: m.ownedDomains ?? [],
        competitors: (m.competitors ?? []).map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
          domains: c.domains ?? [],
        })),
        seedPrompts: m.seedPrompts ?? [],
        createdAt: now,
        updatedAt: now,
      };
      this.brandMarkets.set(bm.id, bm);
      return bm;
    });
    return { brand, markets: createdMarkets };
  }

  private uniqueError(): Error & { code: string } {
    const err = new Error('Unique constraint failed') as Error & { code: string };
    err.code = 'P2002';
    return err;
  }

  private matchDateFilter(
    val: Date | null,
    cond: { gte?: Date; lte?: Date; lt?: Date } | null | undefined,
  ): boolean {
    if (cond === null) return val === null;
    if (cond === undefined) return true;
    if (val === null) return false;
    const ms = val.getTime();
    if (cond.gte && ms < cond.gte.getTime()) return false;
    if (cond.lte && ms > cond.lte.getTime()) return false;
    if (cond.lt && ms >= cond.lt.getTime()) return false;
    return true;
  }

  private matchObs(obs: ObservationRec, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    if (typeof where.id === 'string' && obs.id !== where.id) return false;
    if (typeof where.tenantId === 'string' && obs.tenantId !== where.tenantId) return false;
    if (typeof where.runId === 'string' && obs.runId !== where.runId) return false;
    if (typeof where.brandId === 'string' && obs.brandId !== where.brandId) return false;
    if (typeof where.brandMarketId === 'string' && obs.brandMarketId !== where.brandMarketId) {
      return false;
    }
    if (typeof where.brandMentioned === 'boolean' && obs.brandMentioned !== where.brandMentioned) {
      return false;
    }
    if (typeof where.engine === 'string' && obs.engine !== where.engine) return false;
    if (where.engine && typeof where.engine === 'object') {
      const inList = (where.engine as { in?: string[] }).in;
      if (inList && !inList.includes(obs.engine)) return false;
    }
    if (typeof where.status === 'string' && obs.status !== where.status) return false;
    if (where.status && typeof where.status === 'object') {
      const inList = (where.status as { in?: string[] }).in;
      if (inList && !inList.includes(obs.status)) return false;
    }
    if ('checkedAt' in where) {
      if (
        !this.matchDateFilter(
          obs.checkedAt,
          where.checkedAt as { gte?: Date; lte?: Date; lt?: Date } | null,
        )
      ) {
        return false;
      }
    }
    if ('createdAt' in where) {
      if (
        !this.matchDateFilter(
          obs.createdAt,
          where.createdAt as { gte?: Date; lte?: Date; lt?: Date } | null,
        )
      ) {
        return false;
      }
    }
    if (Array.isArray(where.OR)) {
      const matchedAny = (where.OR as Array<Record<string, unknown>>).some((branch) =>
        this.matchObs(obs, branch),
      );
      if (!matchedAny) return false;
    }
    return true;
  }

  private matchRun(run: RunRec, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    if (typeof where.id === 'string' && run.id !== where.id) return false;
    if (where.id && typeof where.id === 'object') {
      const inIds = (where.id as { in?: string[] }).in;
      if (inIds && !inIds.includes(run.id)) return false;
    }
    if (typeof where.tenantId === 'string' && run.tenantId !== where.tenantId) return false;
    if (typeof where.brandId === 'string' && run.brandId !== where.brandId) return false;
    if (typeof where.brandMarketId === 'string' && run.brandMarketId !== where.brandMarketId) {
      return false;
    }
    if (typeof where.status === 'string' && run.status !== where.status) return false;
    if (where.status && typeof where.status === 'object') {
      const inStatuses = (where.status as { in?: string[] }).in;
      if (inStatuses && !inStatuses.includes(run.status)) return false;
    }
    return true;
  }

  private attachBrandMarket(bm: BrandMarketRec) {
    const brand = this.brands.get(bm.brandId) ?? { id: bm.brandId, name: '' };
    const runCount = [...this.runs.values()].filter((r) => r.brandMarketId === bm.id).length;
    return {
      ...bm,
      brand: { id: brand.id, name: brand.name },
      _count: { visibilityRuns: runCount },
    };
  }

  createClient(): Record<string, unknown> {
    const client: Record<string, unknown> = {
      $disconnect: async () => undefined,
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (sql.includes('FROM "Wallet"')) {
          const tenantId = String(values[0]);
          const w = this.wallets.get(tenantId);
          return w ? [{ points: w.points, pointsReserved: w.pointsReserved }] : [];
        }
        if (sql.includes('FROM "PointReservation"')) {
          const reservationId = String(values[0]);
          const tenantId = String(values[1]);
          const r = this.reservations.get(reservationId);
          return r && r.tenantId === tenantId ? [{ ...r }] : [];
        }
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (
          sql.includes('UPDATE "Wallet"') &&
          sql.includes('"pointsReserved" = "pointsReserved" +')
        ) {
          const amount = Number(values[0]);
          const updatedAt = values[1] as Date;
          const tenantId = String(values[2]);
          const minAvail = Number(values[3]);
          const w = this.wallets.get(tenantId);
          if (!w || w.points - w.pointsReserved < minAvail) return 0;
          w.pointsReserved += amount;
          w.updatedAt = updatedAt;
          return 1;
        }
        if (
          sql.includes('UPDATE "Wallet"') &&
          sql.includes('points = points -') &&
          sql.includes('"pointsReserved" = "pointsReserved" -')
        ) {
          const amount = Number(values[0]);
          const updatedAt = values[2] as Date;
          const tenantId = String(values[3]);
          const w = this.wallets.get(tenantId);
          if (!w || w.points < amount || w.pointsReserved < amount) return 0;
          w.points -= amount;
          w.pointsReserved -= amount;
          w.updatedAt = updatedAt;
          return 1;
        }
        if (
          sql.includes('UPDATE "Wallet"') &&
          !sql.includes('points = points -') &&
          sql.includes('"pointsReserved" = "pointsReserved" -')
        ) {
          const amount = Number(values[0]);
          const updatedAt = values[1] as Date;
          const tenantId = String(values[2]);
          const w = this.wallets.get(tenantId);
          if (!w || w.pointsReserved < amount) return 0;
          w.pointsReserved -= amount;
          w.updatedAt = updatedAt;
          return 1;
        }
        if (sql.includes('UPDATE "PointReservation"') && sql.includes('SET settled = settled +')) {
          const sum = Number(values[0]);
          const id = String(values[1]);
          const tenantId = String(values[2]);
          const r = this.reservations.get(id);
          if (
            !r ||
            r.tenantId !== tenantId ||
            r.status !== 'OPEN' ||
            r.settled + r.released + sum > r.frozen
          ) {
            return 0;
          }
          r.settled += sum;
          return 1;
        }
        if (
          sql.includes('UPDATE "PointReservation"') &&
          sql.includes('SET released = released +')
        ) {
          const amount = Number(values[0]);
          const id = String(values[1]);
          const tenantId = String(values[2]);
          const r = this.reservations.get(id);
          if (
            !r ||
            r.tenantId !== tenantId ||
            r.status !== 'OPEN' ||
            r.settled + r.released + amount > r.frozen
          ) {
            return 0;
          }
          r.released += amount;
          return 1;
        }
        return 0;
      },
      activeWork: {
        findUnique: async () => null,
      },
      tenant: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.tenants.get(where.id) ?? null,
      },
      user: {
        findUnique: async ({ where }: { where: { id?: string; username?: string } }) => {
          const u = where.id
            ? this.users.get(where.id)
            : [...this.users.values()].find((item) => item.username === where.username);
          if (!u) return null;
          const t = this.tenants.get(u.tenantId);
          return t ? { ...u, tenant: { ...t } } : null;
        },
      },
      wallet: {
        findUnique: async ({ where }: { where: { tenantId: string } }) =>
          this.wallets.get(where.tenantId) ?? null,
        findUniqueOrThrow: async ({ where }: { where: { tenantId: string } }) => {
          const w = this.wallets.get(where.tenantId);
          if (!w) throw new Error(`Wallet missing for ${where.tenantId}`);
          return w;
        },
      },
      quota: {
        findMany: async ({ where }: { where: { tenantId: string } }) =>
          this.quotas.filter((q) => q.tenantId === where.tenantId),
      },
      pricingItem: {
        findMany: async () => [...this.pricingItems.values()],
        findUnique: async ({ where }: { where: { action: string } }) =>
          this.pricingItems.get(where.action) ?? null,
      },
      pointReservation: {
        findUnique: async ({
          where,
        }: {
          where: { refType_refId?: { refType: string; refId: string }; id?: string };
        }) => {
          if (where.id) return this.reservations.get(where.id) ?? null;
          if (where.refType_refId) {
            return (
              [...this.reservations.values()].find(
                (r) =>
                  r.refType === where.refType_refId!.refType &&
                  r.refId === where.refType_refId!.refId,
              ) ?? null
            );
          }
          return null;
        },
        findFirst: async ({
          where,
        }: {
          where: { id?: string; tenantId?: string; refType?: string; refId?: string };
        }) =>
          [...this.reservations.values()].find(
            (r) =>
              (!where.id || r.id === where.id) &&
              (!where.tenantId || r.tenantId === where.tenantId) &&
              (!where.refType || r.refType === where.refType) &&
              (!where.refId || r.refId === where.refId),
          ) ?? null,
        findMany: async ({ where }: { where?: { tenantId?: string; id?: { in?: string[] } } }) =>
          [...this.reservations.values()].filter(
            (r) =>
              (!where?.tenantId || r.tenantId === where.tenantId) &&
              (!where?.id?.in || where.id.in.includes(r.id)),
          ),
        create: async ({
          data,
        }: {
          data: {
            tenantId: string;
            refType: string;
            refId: string;
            shadow: boolean;
            frozen: number;
          };
        }) => {
          const dup = [...this.reservations.values()].find(
            (r) => r.refType === data.refType && r.refId === data.refId,
          );
          if (dup) throw this.uniqueError();
          const created: ReservationRec = {
            id: this.nextId('resv'),
            tenantId: data.tenantId,
            refType: data.refType,
            refId: data.refId,
            shadow: data.shadow,
            frozen: data.frozen,
            settled: 0,
            released: 0,
            status: 'OPEN',
            createdAt: new Date(),
            closedAt: null,
          };
          this.reservations.set(created.id, created);
          return created;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; tenantId: string; status: 'OPEN' };
          data: { released?: { increment: number }; status?: 'CLOSED'; closedAt?: Date };
        }) => {
          const r = this.reservations.get(where.id);
          if (!r || r.tenantId !== where.tenantId || r.status !== where.status) {
            return { count: 0 };
          }
          if (data.released?.increment) r.released += data.released.increment;
          if (data.status) r.status = data.status;
          if (data.closedAt) r.closedAt = data.closedAt;
          return { count: 1 };
        },
      },
      pointLog: {
        count: async ({ where }: { where?: { tenantId?: string } }) =>
          this.pointLogs.filter((l) => !where?.tenantId || l.tenantId === where.tenantId).length,
        findUnique: async ({
          where,
        }: {
          where: { unitKey_action: { unitKey: string; action: string } };
        }) =>
          this.pointLogs.find(
            (l) =>
              l.unitKey === where.unitKey_action.unitKey &&
              l.action === where.unitKey_action.action,
          ) ?? null,
        findFirst: async ({ where }: { where: { unitKey?: string; status?: string } }) =>
          this.pointLogs.find(
            (l) =>
              (!where.unitKey || l.unitKey === where.unitKey) &&
              (!where.status || l.status === where.status),
          ) ?? null,
        findMany: async ({ where }: { where?: { tenantId?: string; unitKey?: string } }) =>
          this.pointLogs.filter(
            (l) =>
              (!where?.tenantId || l.tenantId === where.tenantId) &&
              (!where?.unitKey || l.unitKey === where.unitKey),
          ),
        create: async ({
          data,
        }: {
          data: Omit<PointLogRec, 'id' | 'createdAt' | 'detail'> & {
            detail?: Prisma.JsonValue | null;
          };
        }) => {
          const dup = this.pointLogs.find(
            (l) => l.unitKey === data.unitKey && l.action === data.action,
          );
          if (dup) throw this.uniqueError();
          const row: PointLogRec = {
            id: this.nextId('plog'),
            tenantId: data.tenantId,
            reservationId: data.reservationId ?? null,
            action: data.action,
            title: data.title,
            unitKey: data.unitKey,
            delta: data.delta,
            listPrice: data.listPrice,
            balanceAfter: data.balanceAfter ?? null,
            status: data.status,
            detail: data.detail ?? null,
            createdAt: new Date(),
          };
          this.pointLogs.push(row);
          return row;
        },
      },
      auditLog: {
        create: async ({
          data,
        }: {
          data: {
            tenantId?: string | null;
            userId?: string | null;
            action: string;
            payload?: Prisma.JsonValue;
          };
        }) => {
          const row = {
            id: this.nextId('aud'),
            tenantId: data.tenantId ?? null,
            userId: data.userId ?? null,
            action: data.action,
            payload: data.payload ?? null,
            createdAt: new Date(),
          };
          this.auditLogs.push(row);
          return row;
        },
        findMany: async ({ where }: { where?: { userId?: string; action?: string } }) =>
          this.auditLogs.filter(
            (a) =>
              (!where?.userId || a.userId === where.userId) &&
              (!where?.action || a.action === where.action),
          ),
      },
      brand: {
        count: async ({ where }: { where?: { tenantId?: string } }) =>
          [...this.brands.values()].filter((b) => !where?.tenantId || b.tenantId === where.tenantId)
            .length,
        findFirst: async ({
          where,
        }: {
          where: { id?: string; tenantId?: string; name?: string };
        }) => {
          const found = [...this.brands.values()].find(
            (b) =>
              (!where.id || b.id === where.id) &&
              (!where.tenantId || b.tenantId === where.tenantId) &&
              (!where.name || b.name === where.name),
          );
          if (!found) return null;
          const markets = [...this.brandMarkets.values()]
            .filter((m) => m.brandId === found.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return { ...found, markets };
        },
        create: async ({
          data,
        }: {
          data: {
            tenantId: string;
            name: string;
            category: string;
            markets: {
              create: Omit<
                BrandMarketRec,
                'id' | 'brandId' | 'createdAt' | 'updatedAt' | 'seedPrompts'
              >;
            };
          };
        }) => {
          const dup = [...this.brands.values()].find(
            (b) => b.tenantId === data.tenantId && b.name === data.name,
          );
          if (dup) throw this.uniqueError();
          const now = new Date();
          const brandId = this.nextId('brand');
          const brand: BrandRec = {
            id: brandId,
            tenantId: data.tenantId,
            name: data.name,
            category: data.category,
            truthAgreementSignedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          this.brands.set(brandId, brand);
          const m = data.markets.create;
          const bm: BrandMarketRec = {
            id: this.nextId('bm'),
            tenantId: m.tenantId,
            brandId,
            market: m.market,
            locale: m.locale,
            region: m.region,
            localBrandName: m.localBrandName,
            aliases: m.aliases ?? [],
            ownedDomains: m.ownedDomains ?? [],
            competitors: m.competitors ?? [],
            seedPrompts: [],
            createdAt: now,
            updatedAt: now,
          };
          this.brandMarkets.set(bm.id, bm);
          return { ...brand, markets: [bm] };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<BrandRec> }) => {
          const existing = this.brands.get(where.id);
          if (!existing) throw new Error('Brand missing');
          Object.assign(existing, data, { updatedAt: new Date() });
          return { ...existing };
        },
      },
      brandMarket: {
        findFirst: async ({ where }: { where: { id?: string; tenantId?: string } }) => {
          const found = [...this.brandMarkets.values()].find(
            (m) =>
              (!where.id || m.id === where.id) &&
              (!where.tenantId || m.tenantId === where.tenantId),
          );
          return found ? this.attachBrandMarket(found) : null;
        },
        findMany: async ({ where }: { where?: { tenantId?: string } }) =>
          [...this.brandMarkets.values()]
            .filter((m) => !where?.tenantId || m.tenantId === where.tenantId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((m) => this.attachBrandMarket(m)),
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<BrandMarketRec>;
        }) => {
          const existing = this.brandMarkets.get(where.id);
          if (!existing) throw new Error('BrandMarket missing');
          Object.assign(existing, data, { updatedAt: new Date() });
          return this.attachBrandMarket(existing);
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const existing = this.brandMarkets.get(where.id);
          this.brandMarkets.delete(where.id);
          return existing;
        },
      },
      geoBrief: {
        count: async () => 0,
      },
      geoArticle: {
        count: async () => 0,
      },
      brandMediaAsset: {
        aggregate: async () => ({ _sum: { bytes: 0 } }),
      },
      visibilityRun: {
        count: async ({ where }: { where?: Record<string, unknown> }) =>
          [...this.runs.values()].filter((r) => this.matchRun(r, where)).length,
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const found = [...this.runs.values()].find((r) => this.matchRun(r, where));
          if (!found) return null;
          const bm = this.brandMarkets.get(found.brandMarketId);
          const observations = [...this.observations.values()]
            .filter((o) => o.runId === found.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((o) => ({
              ...o,
              citations: [...this.citations.values()]
                .filter((c) => c.observationId === o.id)
                .sort((a, b) => a.position - b.position),
            }));
          return {
            ...found,
            brandMarket: bm
              ? this.attachBrandMarket(bm)
              : {
                  id: found.brandMarketId,
                  market: 'CN' as const,
                  localBrandName: '',
                  aliases: [],
                  ownedDomains: [],
                  competitors: [],
                  brand: { id: found.brandId, name: '' },
                },
            observations,
          };
        },
        findMany: async ({
          where,
          skip,
          take,
        }: {
          where?: Record<string, unknown>;
          skip?: number;
          take?: number;
        }) => {
          const matched = [...this.runs.values()]
            .filter((r) => this.matchRun(r, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const start = skip ?? 0;
          const sliced = take !== undefined ? matched.slice(start, start + take) : matched;
          return sliced.map((r) => {
            const bm = this.brandMarkets.get(r.brandMarketId);
            const observations = [...this.observations.values()].filter((o) => o.runId === r.id);
            return {
              ...r,
              brandMarket: bm
                ? this.attachBrandMarket(bm)
                : {
                    id: r.brandMarketId,
                    market: 'CN' as const,
                    localBrandName: '',
                    aliases: [],
                    ownedDomains: [],
                    competitors: [],
                    brand: { id: r.brandId, name: '' },
                  },
              observations,
            };
          });
        },
        create: async ({
          data,
        }: {
          data: Partial<RunRec> & {
            id: string;
            tenantId: string;
            brandId: string;
            brandMarketId: string;
            name: string;
            engines: string[];
            prompts: string[];
            totalChecks: number;
            unitPrice: number;
          };
        }) => {
          if (this.runs.has(data.id)) throw this.uniqueError();
          const now = new Date();
          const rec: RunRec = {
            id: data.id,
            tenantId: data.tenantId,
            brandId: data.brandId,
            brandMarketId: data.brandMarketId,
            name: data.name,
            engines: data.engines,
            prompts: data.prompts,
            triggerType: data.triggerType ?? 'MANUAL',
            retestArticleId: data.retestArticleId ?? null,
            briefsGeneratedAt: data.briefsGeneratedAt ?? null,
            totalChecks: data.totalChecks,
            doneCount: data.doneCount ?? 0,
            failCount: data.failCount ?? 0,
            unitPrice: data.unitPrice,
            reservationId: data.reservationId ?? null,
            status: data.status ?? 'QUEUED',
            lastError: data.lastError ?? null,
            createdAt: now,
            updatedAt: now,
            finishedAt: data.finishedAt ?? null,
          };
          this.runs.set(rec.id, rec);
          return { ...rec };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const r = this.runs.get(where.id);
          if (!r) throw new Error('Run missing');
          if (data.doneCount && typeof data.doneCount === 'object') {
            r.doneCount += (data.doneCount as { increment: number }).increment;
          } else if (typeof data.doneCount === 'number') {
            r.doneCount = data.doneCount;
          }
          if (data.failCount && typeof data.failCount === 'object') {
            r.failCount += (data.failCount as { increment: number }).increment;
          } else if (typeof data.failCount === 'number') {
            r.failCount = data.failCount;
          }
          if (typeof data.status === 'string') r.status = data.status as RunRec['status'];
          if ('lastError' in data) r.lastError = (data.lastError as string | null) ?? null;
          if ('finishedAt' in data) r.finishedAt = (data.finishedAt as Date | null) ?? null;
          r.updatedAt = new Date();
          return { ...r };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<RunRec>;
        }) => {
          let count = 0;
          for (const r of this.runs.values()) {
            if (this.matchRun(r, where)) {
              Object.assign(r, data, { updatedAt: new Date() });
              count += 1;
            }
          }
          return { count };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, r] of this.runs.entries()) {
            if (this.matchRun(r, where)) {
              this.runs.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      },
      visibilityObservation: {
        count: async ({ where }: { where?: Record<string, unknown> }) =>
          [...this.observations.values()].filter((o) => this.matchObs(o, where)).length,
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const found = [...this.observations.values()].find((o) => this.matchObs(o, where));
          return found ? { ...found } : null;
        },
        findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
          const list = [...this.observations.values()]
            .filter((o) => this.matchObs(o, where))
            .sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
            );
          const sliced = take !== undefined ? list.slice(0, take) : list;
          return sliced.map((o) => ({
            ...o,
            citations: [...this.citations.values()]
              .filter((c) => c.observationId === o.id)
              .sort((a, b) => a.position - b.position),
          }));
        },
        createMany: async ({
          data,
        }: {
          data: Array<{
            tenantId: string;
            runId: string;
            brandId: string;
            brandMarketId: string;
            promptText: string;
            engine: string;
            status: ObservationRec['status'];
            collectorKind: string;
          }>;
        }) => {
          for (const item of data) {
            const id = this.nextId('vobs');
            this.observations.set(id, {
              id,
              tenantId: item.tenantId,
              runId: item.runId,
              brandId: item.brandId,
              brandMarketId: item.brandMarketId,
              promptText: item.promptText,
              engine: item.engine,
              status: item.status,
              collectorKind: item.collectorKind,
              answerText: null,
              brandMentioned: false,
              brandPosition: null,
              brandSentiment: null,
              brandPassage: null,
              competitorHits: null,
              fanOutQueries: [],
              judgeModel: null,
              tokensIn: null,
              tokensOut: null,
              error: null,
              checkedAt: null,
              createdAt: new Date(),
            });
          }
          return { count: data.length };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<ObservationRec>;
        }) => {
          const obs = this.observations.get(where.id);
          if (!obs) throw new Error('Observation missing');
          Object.assign(obs, data);
          return { ...obs };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<ObservationRec>;
        }) => {
          let count = 0;
          for (const obs of this.observations.values()) {
            if (this.matchObs(obs, where)) {
              Object.assign(obs, data);
              count += 1;
            }
          }
          return { count };
        },
      },
      visibilityCitation: {
        findMany: async ({ where }: { where?: Record<string, unknown> }) => {
          const tenantId = where?.tenantId as string | undefined;
          const obsCond = where?.observation as Record<string, unknown> | undefined;
          const out: Array<CitationRec & { observation: ObservationRec }> = [];
          for (const cite of this.citations.values()) {
            if (tenantId && cite.tenantId !== tenantId) continue;
            const obs = this.observations.get(cite.observationId);
            if (!obs) continue;
            if (obsCond && !this.matchObs(obs, obsCond)) continue;
            out.push({ ...cite, observation: { ...obs } });
          }
          return out;
        },
        createMany: async ({ data }: { data: Array<Omit<CitationRec, 'id' | 'createdAt'>> }) => {
          for (const item of data) {
            const id = this.nextId('vcite');
            this.citations.set(id, { id, ...item, createdAt: new Date() });
          }
          return { count: data.length };
        },
        deleteMany: async ({ where }: { where: { observationId: string; tenantId: string } }) => {
          let count = 0;
          for (const [id, cite] of this.citations.entries()) {
            if (cite.observationId === where.observationId && cite.tenantId === where.tenantId) {
              this.citations.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      },
    };
    return client;
  }

  createScopedClient() {
    type Delegate = Record<string, (args?: Record<string, unknown>) => unknown>;
    const base = this.createClient() as Record<string, unknown>;
    const withTenant = (where?: Record<string, unknown>) => {
      const tid = currentTenantId();
      if (!tid || tid === 'system') return where ?? {};
      return { ...(where ?? {}), tenantId: tid };
    };
    const wrapDelegate = (name: string, methods: readonly string[]): Delegate => {
      const raw = base[name] as Delegate;
      const wrapped: Delegate = { ...raw };
      for (const method of methods) {
        const fn = raw[method];
        if (typeof fn === 'function') {
          wrapped[method] = (args?: Record<string, unknown>) =>
            fn({
              ...(args ?? {}),
              where: withTenant(args?.where as Record<string, unknown> | undefined),
            });
        }
      }
      return wrapped;
    };
    return {
      ...base,
      brand: wrapDelegate('brand', ['count', 'findFirst']),
      brandMarket: wrapDelegate('brandMarket', ['findFirst', 'findMany']),
      pointReservation: wrapDelegate('pointReservation', ['findFirst', 'findMany']),
      visibilityRun: wrapDelegate('visibilityRun', [
        'count',
        'findFirst',
        'findMany',
        'updateMany',
        'deleteMany',
      ]),
      visibilityObservation: wrapDelegate('visibilityObservation', [
        'count',
        'findFirst',
        'findMany',
        'updateMany',
      ]),
      visibilityCitation: wrapDelegate('visibilityCitation', ['findMany']),
    };
  }
}

async function httpJson<T = unknown>(
  base: string,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Envelope<T> & { status: number }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  if (opts?.token) headers.authorization = `Bearer ${opts.token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const payload = (await response.json()) as Envelope<T>;
  return { status: response.status, ...payload };
}

describe('visibility v2 HTTP, dual-market isolation, billing settlement, F10 precision & completion hooks (offline)', () => {
  let app: INestApplication;
  let base = '';
  let store: InMemoryVisibilityStore;
  let runner: VisibilityRunRunner;
  let billing: BillingService;
  let collector: VisibilityCollectorService;
  let engineHealth: VisibilityEngineHealthService;
  const enqueuedJobs: VisibilityCheckJobData[] = [];

  let tokenStrictA = '';
  let tokenShadowB = '';
  let tokenExpiredC = '';

  const tenantA = 'ten_strict_a';
  const tenantB = 'ten_shadow_b';
  const tenantC = 'ten_expired_c';

  let dualBrandAId = '';
  let singleGlobalBrandAId = '';
  let brandBId = '';
  let brandCId = '';
  let dualBrandAMarketCnId = '';

  beforeAll(async () => {
    store = new InMemoryVisibilityStore();
    const fakeBaseClient = store.createClient();
    const fakeScopedClient = store.createScopedClient();

    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as {
      base: unknown;
      scoped: unknown;
    };
    prismaSvc.base = fakeBaseClient;
    prismaSvc.scoped = fakeScopedClient;

    vi.spyOn(app.get(QueueProducer), 'enqueueVisibilityRun').mockImplementation(
      async (job: VisibilityCheckJobData) => {
        enqueuedJobs.push(job);
      },
    );

    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;

    runner = app.get(VisibilityRunRunner);
    billing = app.get(BillingService);
    collector = app.get(VisibilityCollectorService);
    engineHealth = app.get(VisibilityEngineHealthService);

    tokenStrictA = store.seedTenant({
      tenantId: tenantA,
      userId: 'usr_strict_a',
      username: 'merchant_strict_a',
      points: 100,
      billingMode: 'STRICT',
    });
    tokenShadowB = store.seedTenant({
      tenantId: tenantB,
      userId: 'usr_shadow_b',
      username: 'merchant_shadow_b',
      points: 500,
      billingMode: 'SHADOW',
    });
    tokenExpiredC = store.seedTenant({
      tenantId: tenantC,
      userId: 'usr_expired_c',
      username: 'merchant_expired_c',
      points: 200,
      billingMode: 'SHADOW',
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000),
    });

    const dualA = store.seedBrand({
      tenantId: tenantA,
      name: '极光NAS',
      category: '家用NAS',
      markets: [
        {
          market: 'CN',
          locale: 'zh-CN',
          region: 'CN',
          localBrandName: '极光NAS',
          aliases: ['JiguangNAS'],
          ownedDomains: ['jiguangnas.cn'],
          competitors: [
            { name: '群晖', aliases: ['Synology'], domains: ['synology.com'] },
            { name: '极空间', aliases: ['ZSpace'], domains: ['zspace.cn'] },
          ],
          seedPrompts: ['家用静音四盘位NAS推荐'],
        },
        {
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: 'AuroraNAS',
          aliases: ['Aurora NAS'],
          ownedDomains: ['auroranas.com'],
          competitors: [
            { name: 'Synology', domains: ['synology.com'] },
            { name: 'QNAP', domains: ['qnap.com'] },
          ],
          seedPrompts: ['Best quiet 4-bay NAS for home office'],
        },
      ],
    });
    dualBrandAId = dualA.brand.id;
    dualBrandAMarketCnId = dualA.markets[0]!.id;

    const singleGlobalA = store.seedBrand({
      tenantId: tenantA,
      name: 'SoloGlobal',
      category: 'SaaS',
      markets: [
        {
          market: 'GLOBAL',
          localBrandName: 'SoloGlobal',
          ownedDomains: ['sologlobal.io'],
          competitors: [{ name: 'RivalGlobal', domains: ['rivalglobal.io'] }],
        },
      ],
    });
    singleGlobalBrandAId = singleGlobalA.brand.id;

    const brandB = store.seedBrand({
      tenantId: tenantB,
      name: '云图智创',
      markets: [
        {
          market: 'CN',
          localBrandName: '云图智创',
          ownedDomains: ['yuntuzhichuang.cn'],
          competitors: [{ name: '云析智联', domains: ['yunxizhilian.example.com'] }],
        },
      ],
    });
    brandBId = brandB.brand.id;

    const brandC = store.seedBrand({
      tenantId: tenantC,
      name: '到期品牌',
      markets: [
        {
          market: 'CN',
          localBrandName: '到期品牌',
          ownedDomains: ['expiredbrand.cn'],
        },
      ],
    });
    brandCId = brandC.brand.id;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('removes legacy /api/v1/visibility/* routes (404) and enforces v2 market-scoped engine lists & brand resolution', async () => {
    for (const legacyPath of [
      '/api/v1/visibility/overview',
      '/api/v1/visibility/profiles',
      '/api/v1/visibility/runs',
    ]) {
      const res = await fetch(`${base}${legacyPath}`, {
        headers: { authorization: `Bearer ${tokenStrictA}` },
      });
      expect(res.status).toBe(404);
    }

    // CN = 8 engines (canonical tongyi), GLOBAL = 5 engines
    const cnEngines = await httpJson<VisibilityEngineAvailabilityResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market=CN`,
      { token: tokenStrictA },
    );
    expect(cnEngines.status).toBe(200);
    expect(cnEngines.data.market).toBe('CN');
    expect(cnEngines.data.engines).toHaveLength(8);
    expect(cnEngines.data.engines.map((e) => e.key)).toContain('tongyi');
    expect(cnEngines.data.engines.map((e) => e.key)).not.toContain('chatgpt');

    const globalEngines = await httpJson<VisibilityEngineAvailabilityResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market=GLOBAL`,
      { token: tokenStrictA },
    );
    expect(globalEngines.status).toBe(200);
    expect(globalEngines.data.market).toBe('GLOBAL');
    expect(globalEngines.data.engines).toHaveLength(5);
    expect(globalEngines.data.engines.map((e) => e.key)).toEqual([
      'chatgpt',
      'perplexity',
      'claude',
      'gemini',
      'google_aio',
    ]);

    // Dual-market brand omitting ?market -> 400
    const ambiguous = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines`,
      { token: tokenStrictA },
    );
    expect(ambiguous.status).toBe(400);

    // Single-market brand omitting ?market -> 200 (auto-resolves GLOBAL)
    const autoSingle = await httpJson<VisibilityEngineAvailabilityResponse>(
      base,
      'GET',
      `/api/v2/brands/${singleGlobalBrandAId}/visibility/engines`,
      { token: tokenStrictA },
    );
    expect(autoSingle.status).toBe(200);
    expect(autoSingle.data.market).toBe('GLOBAL');
    expect(autoSingle.data.engines).toHaveLength(5);

    // Unopened market -> 404; foreign brand -> 404; invalid market -> 400
    const unopened = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${singleGlobalBrandAId}/visibility/engines?market=CN`,
      { token: tokenStrictA },
    );
    expect(unopened.status).toBe(404);

    const foreign = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${brandBId}/visibility/engines?market=CN`,
      { token: tokenStrictA },
    );
    expect(foreign.status).toBe(404);

    const invalidMarket = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market=JP`,
      { token: tokenStrictA },
    );
    expect(invalidMarket.status).toBe(400);
  });

  it('validates CN/GLOBAL engine subsets, offline engines, idempotency, STRICT 402/40201 & 408 timeout atomic refund', async () => {
    // Mismatched engine-market pairs -> 400
    const badCnEngine = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_bad_cn_eng_01' },
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['chatgpt'] },
      },
    );
    expect(badCnEngine.status).toBe(400);

    const badGlobalEngine = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_bad_gl_eng_01' },
        body: { market: 'GLOBAL', prompts: ['Best home NAS'], engines: ['deepseek'] },
      },
    );
    expect(badGlobalEngine.status).toBe(400);

    // Nested Express qs query params must return 400 (never 500), while duplicate flat scalar params stay 200
    const nestedObjEngines = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market[a]=CN`,
      { token: tokenStrictA },
    );
    expect(nestedObjEngines.status).toBe(400);

    const nestedArrEngines = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market[0][0]=CN`,
      { token: tokenStrictA },
    );
    expect(nestedArrEngines.status).toBe(400);

    const nestedRunQuery = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs?market[a]=CN`,
      {
        token: tokenStrictA,
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    expect(nestedRunQuery.status).toBe(400);

    const dupFlatScalar = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/engines?market=CN&market=GLOBAL`,
      { token: tokenStrictA },
    );
    expect(dupFlatScalar.status).toBe(200);

    // Malformed / empty Idempotency-Key -> 400; empty prompts -> 400
    const malformedIdem = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'bad key!!' },
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    expect(malformedIdem.status).toBe(400);

    const emptyIdem = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': '' },
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    expect(emptyIdem.status).toBe(400);

    // Omitted Idempotency-Key -> proceeds to ownership (404), billing (402), and run creation (200)
    const omittedCrossTenant = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenShadowB,
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    expect(omittedCrossTenant.status).toBe(404);

    const emptyPrompts = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_empty_prompts_01' },
        body: { market: 'CN', prompts: [], engines: ['deepseek'] },
      },
    );
    expect(emptyPrompts.status).toBe(400);

    // Offline engine rejected with 400
    const offlineSpy = vi
      .spyOn(engineHealth, 'getUnavailableEngines')
      .mockResolvedValueOnce(['yuanbao']);
    const offlineRes = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_offline_eng_01' },
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek', 'yuanbao'] },
      },
    );
    offlineSpy.mockRestore();
    expect(offlineRes.status).toBe(400);
    expect(offlineRes.msg).toContain('暂未上线');

    // STRICT insufficient balance WITHOUT Idempotency-Key -> 402 / 40201 (tenantA starts with 100 pts; 60 * 2 = 120 pts)
    const tooManyPrompts = Array.from(
      { length: 60 },
      (_, i) => `家用静音四盘位NAS推荐问题${i + 1}`,
    );
    const insufficient = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        body: { market: 'CN', prompts: tooManyPrompts, engines: ['deepseek'] },
      },
    );
    expect(insufficient.status).toBe(402);
    expect(insufficient.code).toBe(API_ERROR.INSUFFICIENT_POINTS);

    // Create 2 prompts * 2 engines = 4 checks * 2 pts = 8 pts; simulate 408 timeout on 2nd check
    let collectCalls = 0;
    const origCollect = collector.collect.bind(collector);
    const collectSpy = vi.spyOn(collector, 'collect').mockImplementation(async (input) => {
      collectCalls += 1;
      if (collectCalls === 2) {
        throw new ProviderError(PROVIDER_KIND.TIMEOUT, '远端采集服务超时', 'timeout');
      }
      return origCollect(input);
    });

    const createPayload = {
      market: 'CN',
      name: 'CN首轮监测',
      prompts: ['[E2E_FANOUT_SEMI] 家用静音四盘位NAS推荐', '[E2E_COMP_DOMAIN] 家用NAS横评'],
      engines: ['deepseek', 'doubao'],
    };

    const created = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_strict_partial_01' },
        body: createPayload,
      },
    );
    expect(created.status).toBe(200);
    expect(created.data.totalChecks).toBe(4);
    expect(created.data.unitPrice).toBe(2);
    expect(created.data.frozenPoints).toBe(8);
    expect(created.data.prompts).toHaveLength(2);

    // Identical Idempotency-Key replay returns same run without double-charging
    const replayed = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_strict_partial_01' },
        body: createPayload,
      },
    );
    expect(replayed.status).toBe(200);
    expect(replayed.data.id).toBe(created.data.id);
    expect(store.wallets.get(tenantA)?.pointsReserved).toBe(8);

    // Conflicting Idempotency-Key payload -> 409 / 40902
    const conflict = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${dualBrandAId}/visibility/runs`,
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'vrun_strict_partial_01' },
        body: { ...createPayload, engines: ['deepseek'] },
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe(BILLING_ERROR.CONFLICT);

    // Register completion hooks: hook1 throws (isolated!), hook2 records event once-only
    const hookEvents: VisibilityRunCompleteEvent[] = [];
    const throwingHook: OnVisibilityRunCompleteHook = {
      name: 'test-throwing-hook',
      onVisibilityRunComplete() {
        throw new Error('simulated hook crash');
      },
    };
    const recordingHook: OnVisibilityRunCompleteHook = {
      name: 'test-recording-hook',
      onVisibilityRunComplete(evt) {
        hookEvents.push(evt);
      },
    };
    runner.registerCompleteHook(throwingHook);
    runner.registerCompleteHook(recordingHook);

    await runner.process({ tenantId: tenantA, runId: created.data.id });
    // Calling runner.process again must NOT double-fire hooks
    await runner.process({ tenantId: tenantA, runId: created.data.id });
    collectSpy.mockRestore();

    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toEqual({
      tenantId: tenantA,
      brandId: dualBrandAId,
      brandMarketId: dualBrandAMarketCnId,
      runId: created.data.id,
      triggerType: 'MANUAL',
      retestArticleId: null,
      status: 'PARTIAL',
      successCount: 3,
    });

    const detailAfter = await httpJson<VisibilityRunDetailRecord>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/runs/${created.data.id}`,
      { token: tokenStrictA },
    );
    expect(detailAfter.status).toBe(200);
    expect(detailAfter.data.status).toBe('PARTIAL');
    expect(detailAfter.data.doneCount).toBe(3);
    expect(detailAfter.data.failCount).toBe(1);
    expect(detailAfter.data.settledPoints).toBe(6);
    expect(detailAfter.data.releasedPoints).toBe(2);
    const walletA = await billing.wallet(tenantA);
    expect(walletA.points).toBe(94);
    expect(walletA.pointsReserved).toBe(0);

    const prismaSvc = app.get(PrismaService);
    expect(
      await hasLiveActiveWork(
        prismaSvc,
        { tenantId: tenantA, refType: 'visibility_run', refId: created.data.id },
        new Date(),
        60_000,
      ),
    ).toBe(false);

    // Verify F10 Fan-Out split + dedupe on GET /opportunities
    const opps = await httpJson<VisibilityOpportunitiesResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/opportunities?market=CN`,
      { token: tokenStrictA },
    );
    expect(opps.status).toBe(200);
    const fanOutLabels = opps.data.fanOutQueries.map((f) => f.query);
    expect(fanOutLabels).toContain('安静NAS');
    expect(fanOutLabels).toContain('家用NAS功耗');
    expect(fanOutLabels).toContain('四盘位NAS');
    expect(fanOutLabels.some((q) => q.includes(';') || q.includes('；'))).toBe(false);

    // Verify T3-21 dynamic citation reclassification on BrandMarket competitor domain edit
    const citesBefore = await httpJson<VisibilityCitationListResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/citations?market=CN`,
      { token: tokenStrictA },
    );
    expect(citesBefore.status).toBe(200);
    const publicItemBefore = citesBefore.data.items.find((i) => i.domain === 'public.e2e.example');
    expect(publicItemBefore?.sourceKind).toBe('OTHER');

    // Add public.e2e.example as competitor domain on live BrandMarket
    const cnMarketRow = store.brandMarkets.get(dualBrandAMarketCnId)!;
    cnMarketRow.competitors = [
      { name: '群晖', aliases: ['Synology'], domains: ['synology.com', 'public.e2e.example'] },
      { name: '极空间', aliases: ['ZSpace'], domains: ['zspace.cn'] },
    ];

    const citesAfter = await httpJson<VisibilityCitationListResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/citations?market=CN`,
      { token: tokenStrictA },
    );
    expect(citesAfter.status).toBe(200);
    const publicItemAfter = citesAfter.data.items.find((i) => i.domain === 'public.e2e.example');
    expect(publicItemAfter?.sourceKind).toBe('COMPETITOR');

    const runDetailReclassified = await httpJson<VisibilityRunDetailRecord>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/runs/${created.data.id}?market=CN`,
      { token: tokenStrictA },
    );
    const allRunCites = runDetailReclassified.data.observations.flatMap((o) => o.citations);
    expect(
      allRunCites.some((c) => c.domain === 'public.e2e.example' && c.sourceKind === 'COMPETITOR'),
    ).toBe(true);

    // Dual-market strict isolation: CN run MUST NOT leak into GLOBAL overview/runs/citations
    const globalOverview = await httpJson<VisibilityOverviewResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/overview?market=GLOBAL`,
      { token: tokenStrictA },
    );
    expect(globalOverview.status).toBe(200);
    expect(globalOverview.data.market).toBe('GLOBAL');
    expect(globalOverview.data.metrics.completedChecks).toBe(0);

    const globalRuns = await httpJson<VisibilityRunListResponse>(
      base,
      'GET',
      `/api/v2/brands/${dualBrandAId}/visibility/runs?market=GLOBAL`,
      { token: tokenStrictA },
    );
    expect(globalRuns.status).toBe(200);
    expect(globalRuns.data.total).toBe(0);
  });

  it('enforces expired-tenant read-only GET 200 vs write 403/40301, cross-tenant/brand 404, pause/resume/cancel/delete, and [E2E_NO_CITATIONS]', async () => {
    // Expired tenant C: GET endpoints succeed (200), write endpoints fail with 403 / 40301
    for (const readPath of [
      `/api/v2/brands/${brandCId}/visibility/engines?market=CN`,
      `/api/v2/brands/${brandCId}/visibility/overview?market=CN`,
      `/api/v2/brands/${brandCId}/visibility/runs?market=CN`,
      `/api/v2/brands/${brandCId}/visibility/citations?market=CN`,
      `/api/v2/brands/${brandCId}/visibility/opportunities?market=CN`,
    ]) {
      const readRes = await httpJson(base, 'GET', readPath, { token: tokenExpiredC });
      expect(readRes.status).toBe(200);
    }

    const expiredWrite = await httpJson(
      base,
      'POST',
      `/api/v2/brands/${brandCId}/visibility/runs`,
      {
        token: tokenExpiredC,
        headers: { 'Idempotency-Key': 'vrun_expired_write_01' },
        body: { market: 'CN', prompts: ['到期租户禁止写入'], engines: ['deepseek'] },
      },
    );
    expect(expiredWrite.status).toBe(403);
    expect(expiredWrite.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Shadow tenant B creates a run with [E2E_NO_CITATIONS], exercises pause/resume/cancel/delete
    const shadowRun = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs`,
      {
        token: tokenShadowB,
        headers: { 'Idempotency-Key': 'vrun_shadow_lifecycle_01' },
        body: {
          market: 'CN',
          prompts: ['[E2E_NO_CITATIONS] 企业知识库选型推荐'],
          engines: ['deepseek'],
        },
      },
    );
    expect(shadowRun.status).toBe(200);
    const runId = shadowRun.data.id;

    // Cross-tenant & cross-brand isolation -> 404
    const crossTenant = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}`,
      { token: tokenStrictA },
    );
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.code).toBe(AUTH_ERROR.NOT_FOUND);

    const crossBrand = await httpJson(
      base,
      'GET',
      `/api/v2/brands/${singleGlobalBrandAId}/visibility/runs/${runId}`,
      { token: tokenStrictA },
    );
    expect(crossBrand.status).toBe(404);

    // Active work check sees QUEUED visibility_run as live
    const prismaSvc = app.get(PrismaService);
    expect(
      await hasLiveActiveWork(
        prismaSvc,
        { tenantId: tenantB, refType: 'visibility_run', refId: runId },
        new Date(),
        60_000,
      ),
    ).toBe(true);

    // Pause -> Active delete rejected (400) -> Resume -> Process -> Delete succeeds
    const paused = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}/pause`,
      { token: tokenShadowB },
    );
    expect(paused.status).toBe(200);
    expect(paused.data.status).toBe('PAUSED');

    const activeDelete = await httpJson(
      base,
      'DELETE',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}`,
      { token: tokenShadowB },
    );
    expect(activeDelete.status).toBe(400);

    const resumed = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}/resume`,
      { token: tokenShadowB },
    );
    expect(resumed.status).toBe(200);
    expect(resumed.data.status).toBe('QUEUED');

    await runner.process({ tenantId: tenantB, runId });
    const doneShadow = await httpJson<VisibilityRunDetailRecord>(
      base,
      'GET',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}`,
      { token: tokenShadowB },
    );
    expect(doneShadow.status).toBe(200);
    expect(doneShadow.data.status).toBe('COMPLETED');
    expect(doneShadow.data.observations[0]?.citations).toEqual([]);

    const deleted = await httpJson<{ deleted: number }>(
      base,
      'DELETE',
      `/api/v2/brands/${brandBId}/visibility/runs/${runId}`,
      { token: tokenShadowB },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.data.deleted).toBe(1);

    // Cancel path does NOT fire completion hook
    const cancelHookEvents: VisibilityRunCompleteEvent[] = [];
    runner.registerCompleteHook({
      name: 'test-cancel-check',
      onVisibilityRunComplete(evt) {
        cancelHookEvents.push(evt);
      },
    });
    const toCancel = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs`,
      {
        token: tokenShadowB,
        headers: { 'Idempotency-Key': 'vrun_shadow_cancel_01' },
        body: { market: 'CN', prompts: ['待取消任务'], engines: ['deepseek'] },
      },
    );
    expect(toCancel.status).toBe(200);
    const cancelled = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs/${toCancel.data.id}/cancel`,
      { token: tokenShadowB },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('CANCELLED');
    expect(cancelHookEvents).toHaveLength(0);

    // Omitted Idempotency-Key succeeds with 200 and auto-generates a unique key per call
    const autoIdem1 = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs`,
      {
        token: tokenShadowB,
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    const autoIdem2 = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v2/brands/${brandBId}/visibility/runs`,
      {
        token: tokenShadowB,
        body: { market: 'CN', prompts: ['家用静音NAS推荐'], engines: ['deepseek'] },
      },
    );
    expect(autoIdem1.status).toBe(200);
    expect(autoIdem2.status).toBe(200);
    expect(autoIdem1.data.id).not.toBe(autoIdem2.data.id);
    await runner.process({ tenantId: tenantB, runId: autoIdem1.data.id });
    await runner.process({ tenantId: tenantB, runId: autoIdem2.data.id });
  });
});
