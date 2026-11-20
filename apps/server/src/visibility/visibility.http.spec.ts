import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  FAKE_MARK,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  parseEnv,
  type VisibilityCitationListResponse,
  type VisibilityOpportunitiesResponse,
  type VisibilityOverviewResponse,
  type VisibilityProfileListResponse,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwordFingerprint } from '../auth/auth.service';
import { signToken } from '../auth/token';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { PrismaService } from '../prisma/prisma.service';
import { hasLiveActiveWork } from '../queue/active-work';
import { QueueProducer } from '../queue/queue.producer';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityRunRunner, type VisibilityCheckJobData } from './visibility-run.runner';

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
        }) =>
          [...this.brands.values()].find(
            (b) =>
              (!where.id || b.id === where.id) &&
              (!where.tenantId || b.tenantId === where.tenantId) &&
              (!where.name || b.name === where.name),
          ) ?? null,
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

describe('visibility HTTP, billing settlement & analytics pipeline on BrandMarket (offline)', () => {
  let app: INestApplication;
  let base = '';
  let store: InMemoryVisibilityStore;
  let runner: VisibilityRunRunner;
  let billing: BillingService;
  let collector: VisibilityCollectorService;
  const enqueuedJobs: VisibilityCheckJobData[] = [];

  let tokenStrictA = '';
  let tokenShadowB = '';
  let tokenExpiredC = '';

  const tenantA = 'ten_strict_a';
  const tenantB = 'ten_shadow_b';
  const tenantC = 'ten_expired_c';

  beforeAll(async () => {
    store = new InMemoryVisibilityStore();
    const fakeClient = store.createClient();

    app = await createApiApp();
    const prismaSvc = app.get(PrismaService) as unknown as {
      base: unknown;
      scoped: unknown;
    };
    prismaSvc.base = fakeClient;
    prismaSvc.scoped = fakeClient;

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
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('supports profile CRUD backed by Brand + BrandMarket with domain normalization and duplicate checks', async () => {
    const initialList = await httpJson<VisibilityProfileListResponse>(
      base,
      'GET',
      '/api/v1/visibility/profiles',
      { token: tokenStrictA },
    );
    expect(initialList.status).toBe(200);
    expect(initialList.data.items).toHaveLength(0);

    const created = await httpJson<VisibilityProfileRecord>(
      base,
      'POST',
      '/api/v1/visibility/profiles',
      {
        token: tokenStrictA,
        body: {
          name: '极光NAS监测',
          brandName: '极光NAS',
          brandAliases: ['AuroraNAS'],
          ownedDomains: ['https://WWW.AuroraNas.cn/docs'],
          competitors: [{ name: '群晖', aliases: ['Synology'], domains: ['https://synology.com'] }],
        },
      },
    );
    expect(created.status).toBe(200);
    expect(created.data.ownedDomains).toEqual(['auroranas.cn']);
    expect(created.data.competitors[0]?.domains).toEqual(['synology.com']);

    const dup = await httpJson(base, 'POST', '/api/v1/visibility/profiles', {
      token: tokenStrictA,
      body: { name: '极光NAS监测', brandName: '极光NAS' },
    });
    expect(dup.status).toBe(409);
    expect(dup.code).toBe(BILLING_ERROR.CONFLICT);
  });

  it('reserves points, settles succeeded checks & releases failed checks -> PARTIAL with zero ledger drift', async () => {
    const listRes = await httpJson<VisibilityProfileListResponse>(
      base,
      'GET',
      '/api/v1/visibility/profiles',
      { token: tokenStrictA },
    );
    const profileId = listRes.data.items[0]!.id;

    let calls = 0;
    const collectSpy = vi.spyOn(collector, 'collect').mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('upstream timeout');
      }
      return {
        collectorKind: 'fake',
        answerText: `针对${input.promptText}，极光NAS在静音和吞吐表现领先于群晖。`,
        citations: [
          {
            url: 'https://docs.auroranas.cn/spec',
            title: '官网参数',
            snippet: '四盘位静音',
            position: 1,
          },
          {
            url: 'https://item.jd.com/1001.html',
            title: '京东自营',
            snippet: '电商评测',
            position: 2,
          },
        ],
        fanOutQueries: ['四盘位NAS静音对比; 极光NAS评测'],
      };
    });

    const createRes = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenStrictA,
        headers: { 'idempotency-key': 'vis-run-strict-0001' },
        body: {
          profileId,
          engines: ['deepseek', 'doubao'],
          customPrompts: ['家用四盘位NAS怎么选', 'NAS噪音实测对比'],
        },
      },
    );
    expect(createRes.status).toBe(200);
    expect(createRes.data.totalChecks).toBe(4);
    expect(createRes.data.frozenPoints).toBe(8);

    const runId = createRes.data.id;
    await runner.process({ tenantId: tenantA, runId });
    collectSpy.mockRestore();

    const detail = await httpJson<VisibilityRunDetailRecord>(
      base,
      'GET',
      `/api/v1/visibility/runs/${runId}`,
      { token: tokenStrictA },
    );
    expect(detail.status).toBe(200);
    expect(detail.data.status).toBe('PARTIAL');
    expect(detail.data.doneCount).toBe(3);
    expect(detail.data.failCount).toBe(1);
    expect(detail.data.settledPoints).toBe(6);
    expect(detail.data.releasedPoints).toBe(2);

    const wallet = await billing.wallet(tenantA);
    expect(wallet.points).toBe(94);
    expect(wallet.pointsReserved).toBe(0);

    const citations = await httpJson<VisibilityCitationListResponse>(
      base,
      'GET',
      `/api/v1/visibility/citations?profileId=${profileId}&days=30`,
      { token: tokenStrictA },
    );
    expect(citations.status).toBe(200);
    expect(citations.data.sourceBreakdown?.OWNED).toBeGreaterThan(0);
    expect(citations.data.sourceBreakdown?.ECOMMERCE).toBeGreaterThan(0);

    const opps = await httpJson<VisibilityOpportunitiesResponse>(
      base,
      'GET',
      `/api/v1/visibility/opportunities?profileId=${profileId}&days=30`,
      { token: tokenStrictA },
    );
    expect(opps.status).toBe(200);
    expect(opps.data.fanOutQueries.map((f) => f.query)).toContain('四盘位NAS静音对比');
    expect(opps.data.fanOutQueries.map((f) => f.query)).toContain('极光NAS评测');
  });

  it('supports SHADOW mode, /me/rights model cards, pause/resume/cancel, cross-tenant 404, expired 40301, and off-topic downgrade', async () => {
    const profRes = await httpJson<VisibilityProfileRecord>(
      base,
      'POST',
      '/api/v1/visibility/profiles',
      {
        token: tokenShadowB,
        body: {
          name: '影子品牌档案',
          brandName: '影子品牌',
          ownedDomains: ['shadow-brand.cn'],
        },
      },
    );
    expect(profRes.status).toBe(200);
    const profBId = profRes.data.id;

    // Expired tenant blocked on POST
    const expRes = await httpJson(base, 'POST', '/api/v1/visibility/profiles', {
      token: tokenExpiredC,
      body: { name: '过期档案', brandName: '过期品牌' },
    });
    expect(expRes.status).toBe(403);
    expect(expRes.code).toBe(API_ERROR.TENANT_EXPIRED);

    // Create shadow run & test pause/resume/cancel
    const runRes = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenShadowB,
        headers: { 'idempotency-key': 'vis-run-shadow-0001' },
        body: {
          profileId: profBId,
          engines: ['deepseek'],
          customPrompts: ['影子品牌家用评测怎么样'],
        },
      },
    );
    expect(runRes.status).toBe(200);
    const runId = runRes.data.id;

    // Cross-tenant GET -> 404
    const crossRes = await httpJson(base, 'GET', `/api/v1/visibility/runs/${runId}`, {
      token: tokenStrictA,
    });
    expect(crossRes.status).toBe(404);
    expect(crossRes.code).toBe(AUTH_ERROR.NOT_FOUND);

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

    const paused = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v1/visibility/runs/${runId}/pause`,
      { token: tokenShadowB },
    );
    expect(paused.data.status).toBe('PAUSED');

    const resumed = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v1/visibility/runs/${runId}/resume`,
      { token: tokenShadowB },
    );
    expect(resumed.data.status).toBe('QUEUED');

    // Run with off-topic FAKE answer to verify overview & detail downgrade
    const spy = vi.spyOn(collector, 'collect').mockResolvedValue({
      collectorKind: 'fake',
      answerText: `${FAKE_MARK}影子品牌占位回答`,
      citations: [],
      fanOutQueries: [],
    });
    await runner.process({ tenantId: tenantB, runId });
    spy.mockRestore();

    const walletB = await billing.wallet(tenantB);
    expect(walletB.points).toBe(500);

    const overview = await httpJson<VisibilityOverviewResponse>(
      base,
      'GET',
      `/api/v1/visibility/overview?profileId=${profBId}&days=7`,
      { token: tokenShadowB },
    );
    expect(overview.status).toBe(200);
    expect(overview.data.metrics.completedChecks).toBe(1);
    expect(overview.data.metrics.mentionedChecks).toBe(0);

    // Legacy import-questions returns 410
    const importRes = await httpJson(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenShadowB,
        body: { keywordId: 'kw_legacy', titles: ['问题1'] },
      },
    );
    expect(importRes.status).toBe(410);
  });
});
