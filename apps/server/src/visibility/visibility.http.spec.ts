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
  type ImportQuestionsResult,
  type VisibilityCitationListResponse,
  type VisibilityOpportunitiesResponse,
  type VisibilityOverviewResponse,
  type VisibilityProfileListResponse,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
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

type KeywordRec = {
  id: string;
  tenantId: string;
  main: string;
  brands: string[];
  optStatus: 'NONE' | 'OPTIMIZING' | 'INCLUDED';
  createdAt: Date;
};

type QuestionRec = {
  id: string;
  tenantId: string;
  keywordId: string;
  text: string;
  source: 'MANUAL' | 'DISTILL' | 'COMBO' | 'AI';
  usedCount: number;
  lastUsedAt: Date | null;
  included: boolean;
  createdAt: Date;
};

type KbRec = {
  id: string;
  tenantId: string;
  name: string;
  companyName: string | null;
  brandShort: string | null;
  createdAt: Date;
};

type ProfileRec = {
  id: string;
  tenantId: string;
  name: string;
  brandName: string;
  brandAliases: string[];
  ownedDomains: string[];
  competitors: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

type RunRec = {
  id: string;
  tenantId: string;
  profileId: string;
  keywordId: string | null;
  name: string;
  engines: string[];
  questionIds: string[];
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
  profileId: string;
  questionId: string | null;
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
  readonly keywords = new Map<string, KeywordRec>();
  readonly questions = new Map<string, QuestionRec>();
  readonly knowledgeBases = new Map<string, KbRec>();
  readonly profiles = new Map<string, ProfileRec>();
  readonly runs = new Map<string, RunRec>();
  readonly observations = new Map<string, ObservationRec>();
  readonly citations = new Map<string, CitationRec>();

  nextId(prefix: string): string {
    const id = `${prefix}_${this.seq}`;
    this.seq += 1;
    return id;
  }

  seedTenant(input: {
    tenantId: string;
    userId: string;
    username: string;
    points: number;
    billingMode: 'SHADOW' | 'STRICT' | null;
    expiresAt?: Date;
    isActive?: boolean;
  }): string {
    const now = new Date();
    const passwordHash = 'scrypt$16384$8$1$testsalt$testhash';
    this.tenants.set(input.tenantId, {
      id: input.tenantId,
      name: `租户-${input.tenantId}`,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + 30 * 86_400_000),
      isActive: input.isActive ?? true,
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
    if (typeof where.profileId === 'string' && obs.profileId !== where.profileId) return false;
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
    if (where.questionId !== undefined) {
      if (where.questionId === null && obs.questionId !== null) return false;
      if (typeof where.questionId === 'string' && obs.questionId !== where.questionId) return false;
      if (typeof where.questionId === 'object' && where.questionId !== null) {
        const notVal = (where.questionId as { not?: unknown }).not;
        if (notVal === null && obs.questionId === null) return false;
      }
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
    if (typeof where.profileId === 'string' && run.profileId !== where.profileId) return false;
    if (typeof where.status === 'string' && run.status !== where.status) return false;
    if (where.status && typeof where.status === 'object') {
      const inStatuses = (where.status as { in?: string[] }).in;
      if (inStatuses && !inStatuses.includes(run.status)) return false;
    }
    if (Array.isArray(where.OR)) {
      const prof = this.profiles.get(run.profileId);
      const kw = run.keywordId ? this.keywords.get(run.keywordId) : undefined;
      const matched = (where.OR as Array<Record<string, unknown>>).some((branch) => {
        if (branch.name && typeof branch.name === 'object') {
          const needle = String(
            (branch.name as { contains?: string }).contains ?? '',
          ).toLowerCase();
          return run.name.toLowerCase().includes(needle);
        }
        if (branch.profile && typeof branch.profile === 'object') {
          const pCond = branch.profile as Record<string, { contains?: string }>;
          if (pCond.name?.contains) {
            return (prof?.name ?? '').toLowerCase().includes(pCond.name.contains.toLowerCase());
          }
          if (pCond.brandName?.contains) {
            return (prof?.brandName ?? '')
              .toLowerCase()
              .includes(pCond.brandName.contains.toLowerCase());
          }
        }
        if (branch.keyword && typeof branch.keyword === 'object') {
          const kCond = branch.keyword as { main?: { contains?: string } };
          if (kCond.main?.contains) {
            return (kw?.main ?? '').toLowerCase().includes(kCond.main.contains.toLowerCase());
          }
        }
        return false;
      });
      if (!matched) return false;
    }
    return true;
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
        if (sql.includes('FROM "Quota"')) {
          const tenantId = String(values[0]);
          const key = String(values[1]);
          const q = this.quotas.find((row) => row.tenantId === tenantId && row.key === key);
          return q ? [{ used: q.used, limit: q.limit }] : [];
        }
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (sql.includes('UPDATE "Quota"') && sql.includes('SET used = used +')) {
          const delta = BigInt(values[0] as number | bigint);
          const tenantId = String(values[1]);
          const key = String(values[2]);
          const deltaCheck = BigInt(values[3] as number | bigint);
          const q = this.quotas.find((row) => row.tenantId === tenantId && row.key === key);
          if (!q || q.used + deltaCheck > q.limit) return 0;
          q.used += delta;
          return 1;
        }
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
          const found = where.id
            ? (this.users.get(where.id) ?? null)
            : ([...this.users.values()].find((u) => u.username === where.username) ?? null);
          if (!found) return null;
          const tenant = this.tenants.get(found.tenantId);
          return tenant ? { ...found, tenant } : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<UserRec> }) => {
          const u = this.users.get(where.id);
          if (!u) throw new Error('User not found');
          Object.assign(u, data);
          return u;
        },
      },
      wallet: {
        findUnique: async ({ where }: { where: { tenantId: string } }) =>
          this.wallets.get(where.tenantId) ?? null,
        findUniqueOrThrow: async ({ where }: { where: { tenantId: string } }) => {
          const w = this.wallets.get(where.tenantId);
          if (!w) throw new Error('Wallet missing');
          return w;
        },
        findMany: async () => [...this.wallets.values()],
      },
      quota: {
        findMany: async ({ where }: { where?: { tenantId?: string } }) =>
          this.quotas.filter((q) => !where?.tenantId || q.tenantId === where.tenantId),
        findUnique: async ({
          where,
        }: {
          where: { tenantId_key: { tenantId: string; key: string } };
        }) =>
          this.quotas.find(
            (q) => q.tenantId === where.tenantId_key.tenantId && q.key === where.tenantId_key.key,
          ) ?? null,
      },
      pricingItem: {
        findUnique: async ({ where }: { where: { action: string } }) =>
          this.pricingItems.get(where.action) ?? null,
        findMany: async () => [...this.pricingItems.values()],
      },
      pointReservation: {
        findUnique: async ({
          where,
        }: {
          where: { id?: string; refType_refId?: { refType: string; refId: string } };
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
        findFirst: async ({ where }: { where: Partial<ReservationRec> }) =>
          [...this.reservations.values()].find(
            (r) =>
              (!where.id || r.id === where.id) &&
              (!where.tenantId || r.tenantId === where.tenantId) &&
              (!where.refType || r.refType === where.refType) &&
              (!where.refId || r.refId === where.refId),
          ) ?? null,
        findMany: async ({
          where,
        }: {
          where?: {
            tenantId?: string;
            id?: { in?: string[] };
            status?: string;
            createdAt?: { lt?: Date };
          };
        }) =>
          [...this.reservations.values()].filter(
            (r) =>
              (!where?.tenantId || r.tenantId === where.tenantId) &&
              (!where?.id?.in || where.id.in.includes(r.id)) &&
              (!where?.status || r.status === where.status) &&
              (!where?.createdAt?.lt || r.createdAt.getTime() < where.createdAt.lt.getTime()),
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
        findMany: async ({
          where,
          skip,
          take,
        }: {
          where?: { tenantId?: string; unitKey?: string };
          skip?: number;
          take?: number;
        }) => {
          const list = this.pointLogs
            .filter(
              (l) =>
                (!where?.tenantId || l.tenantId === where.tenantId) &&
                (!where?.unitKey || l.unitKey === where.unitKey),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const start = skip ?? 0;
          return take !== undefined ? list.slice(start, start + take) : list.slice(start);
        },
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
      keyword: {
        findFirst: async ({ where }: { where: { id?: string; tenantId?: string } }) => {
          const kw = where.id ? this.keywords.get(where.id) : undefined;
          if (!kw || (where.tenantId && kw.tenantId !== where.tenantId)) return null;
          return { ...kw };
        },
        findMany: async ({ where }: { where?: { tenantId?: string } }) =>
          [...this.keywords.values()].filter(
            (k) => !where?.tenantId || k.tenantId === where.tenantId,
          ),
        update: async ({ where, data }: { where: { id: string }; data: Partial<KeywordRec> }) => {
          const kw = this.keywords.get(where.id);
          if (!kw) throw new Error('Keyword missing');
          Object.assign(kw, data);
          return { ...kw };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; tenantId: string };
          data: Partial<KeywordRec>;
        }) => {
          const kw = this.keywords.get(where.id);
          if (!kw || kw.tenantId !== where.tenantId) return { count: 0 };
          Object.assign(kw, data);
          return { count: 1 };
        },
      },
      question: {
        count: async ({
          where,
        }: {
          where: { tenantId?: string; keywordId?: string; included?: boolean };
        }) =>
          [...this.questions.values()].filter(
            (q) =>
              (!where.tenantId || q.tenantId === where.tenantId) &&
              (!where.keywordId || q.keywordId === where.keywordId) &&
              (where.included === undefined || q.included === where.included),
          ).length,
        findFirst: async ({ where }: { where: { id: string; tenantId?: string } }) => {
          const q = this.questions.get(where.id);
          if (!q || (where.tenantId && q.tenantId !== where.tenantId)) return null;
          return { ...q };
        },
        findMany: async ({
          where,
        }: {
          where: { tenantId?: string; keywordId?: string; id?: { in?: string[] } };
        }) =>
          [...this.questions.values()].filter(
            (q) =>
              (!where.tenantId || q.tenantId === where.tenantId) &&
              (!where.keywordId || q.keywordId === where.keywordId) &&
              (!where.id?.in || where.id.in.includes(q.id)),
          ),
        update: async ({ where, data }: { where: { id: string }; data: Partial<QuestionRec> }) => {
          const q = this.questions.get(where.id);
          if (!q) throw new Error('Question missing');
          Object.assign(q, data);
          return { ...q };
        },
        create: async ({
          data,
        }: {
          data: {
            tenantId: string;
            keywordId: string;
            text: string;
            source: QuestionRec['source'];
            included: boolean;
          };
        }) => {
          const row: QuestionRec = {
            id: this.nextId('q'),
            tenantId: data.tenantId,
            keywordId: data.keywordId,
            text: data.text,
            source: data.source,
            usedCount: 0,
            lastUsedAt: null,
            included: data.included,
            createdAt: new Date(),
          };
          this.questions.set(row.id, row);
          return { ...row };
        },
      },
      knowledgeBase: {
        findFirst: async ({ where }: { where: { id: string; tenantId?: string } }) => {
          const kb = this.knowledgeBases.get(where.id);
          if (!kb || (where.tenantId && kb.tenantId !== where.tenantId)) return null;
          return { ...kb };
        },
        findMany: async ({ where }: { where?: { tenantId?: string } }) =>
          [...this.knowledgeBases.values()].filter(
            (kb) => !where?.tenantId || kb.tenantId === where.tenantId,
          ),
      },
      visibilityProfile: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string | { not?: string }; tenantId?: string; name?: string };
        }) => {
          const found = [...this.profiles.values()].find((p) => {
            if (where.tenantId && p.tenantId !== where.tenantId) return false;
            if (where.name && p.name !== where.name) return false;
            if (typeof where.id === 'string' && p.id !== where.id) return false;
            if (where.id && typeof where.id === 'object' && where.id.not && p.id === where.id.not) {
              return false;
            }
            return true;
          });
          if (!found) return null;
          const runCount = [...this.runs.values()].filter((r) => r.profileId === found.id).length;
          return { ...found, _count: { runs: runCount } };
        },
        findMany: async ({ where }: { where?: { tenantId?: string } }) =>
          [...this.profiles.values()]
            .filter((p) => !where?.tenantId || p.tenantId === where.tenantId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((p) => ({
              ...p,
              _count: {
                runs: [...this.runs.values()].filter((r) => r.profileId === p.id).length,
              },
            })),
        create: async ({ data }: { data: Omit<ProfileRec, 'id' | 'createdAt' | 'updatedAt'> }) => {
          const dup = [...this.profiles.values()].find(
            (p) => p.tenantId === data.tenantId && p.name === data.name,
          );
          if (dup) throw this.uniqueError();
          const now = new Date();
          const rec: ProfileRec = {
            id: this.nextId('vprof'),
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          this.profiles.set(rec.id, rec);
          return { ...rec };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<ProfileRec> }) => {
          const existing = this.profiles.get(where.id);
          if (!existing) throw new Error('Profile missing');
          Object.assign(existing, data, { updatedAt: new Date() });
          return { ...existing };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const existing = this.profiles.get(where.id);
          this.profiles.delete(where.id);
          return existing;
        },
      },
      visibilityRun: {
        count: async ({ where }: { where?: Record<string, unknown> }) =>
          [...this.runs.values()].filter((r) => this.matchRun(r, where)).length,
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const found = [...this.runs.values()].find((r) => this.matchRun(r, where));
          if (!found) return null;
          const profile = this.profiles.get(found.profileId);
          const keyword = found.keywordId ? (this.keywords.get(found.keywordId) ?? null) : null;
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
            profile: profile ?? { id: found.profileId, name: '', brandName: '' },
            keyword: keyword ? { id: keyword.id, main: keyword.main } : null,
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
            const profile = this.profiles.get(r.profileId);
            const keyword = r.keywordId ? (this.keywords.get(r.keywordId) ?? null) : null;
            const observations = [...this.observations.values()].filter((o) => o.runId === r.id);
            return {
              ...r,
              profile: profile
                ? { id: profile.id, name: profile.name, brandName: profile.brandName }
                : { id: r.profileId, name: '', brandName: '' },
              keyword: keyword ? { id: keyword.id, main: keyword.main } : null,
              observations,
            };
          });
        },
        create: async ({
          data,
        }: {
          data: Omit<RunRec, 'createdAt' | 'updatedAt' | 'lastError' | 'finishedAt'> & {
            lastError?: string | null;
            finishedAt?: Date | null;
          };
        }) => {
          if (this.runs.has(data.id)) throw this.uniqueError();
          const now = new Date();
          const rec: RunRec = {
            ...data,
            lastError: data.lastError ?? null,
            finishedAt: data.finishedAt ?? null,
            createdAt: now,
            updatedAt: now,
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
              for (const [obsId, obs] of this.observations.entries()) {
                if (obs.runId === id) {
                  this.observations.delete(obsId);
                  for (const [citeId, cite] of this.citations.entries()) {
                    if (cite.observationId === obsId) this.citations.delete(citeId);
                  }
                }
              }
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
            profileId: string;
            questionId: string | null;
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
              profileId: item.profileId,
              questionId: item.questionId,
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
            this.citations.set(id, {
              id,
              ...item,
              createdAt: new Date(),
            });
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

describe('visibility HTTP, billing settlement, writeback & analytics pipeline (offline)', () => {
  let app: INestApplication;
  let base = '';
  let store: InMemoryVisibilityStore;
  let runner: VisibilityRunRunner;
  let billing: BillingService;
  let collector: VisibilityCollectorService;
  let enqueuedJobs: VisibilityCheckJobData[] = [];

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

  it('supports profile CRUD with Keyword & KnowledgeBase prefill, domain normalization, and duplicate/compliance checks', async () => {
    const kwId = 'kw_prefill_1';
    store.keywords.set(kwId, {
      id: kwId,
      tenantId: tenantA,
      main: '企业GEO智能优化',
      brands: ['GeoMix智混', '吉奥米克斯'],
      optStatus: 'NONE',
      createdAt: new Date(),
    });
    const kbId = 'kb_prefill_1';
    store.knowledgeBases.set(kbId, {
      id: kbId,
      tenantId: tenantA,
      name: '企业核心知识库',
      companyName: '上海吉奥米克斯科技有限公司',
      brandShort: 'GeoMix',
      createdAt: new Date(),
    });

    const initialList = await httpJson<VisibilityProfileListResponse>(
      base,
      'GET',
      '/api/v1/visibility/profiles',
      { token: tokenStrictA },
    );
    expect(initialList.status).toBe(200);
    expect(initialList.data.items).toHaveLength(0);
    expect(initialList.data.prefillSources?.keywords).toHaveLength(1);
    expect(initialList.data.prefillSources?.knowledgeBases).toHaveLength(1);

    // Create profile importing from Keyword + KnowledgeBase without manually typing brandName
    const created = await httpJson<VisibilityProfileRecord>(
      base,
      'POST',
      '/api/v1/visibility/profiles',
      {
        token: tokenStrictA,
        body: {
          name: '  主力产品监测档案  ',
          importFromKeywordId: kwId,
          importFromKbId: kbId,
          ownedDomains: ['https://www.GeoMix.example.com/docs', 'geomix.example.com'],
          competitors: [
            {
              name: '云析智联',
              aliases: ['YunXi'],
              domains: ['https://www.yunxizhilian.example.com/pricing'],
            },
          ],
        },
      },
    );
    expect(created.status).toBe(200);
    expect(created.code).toBe(0);
    expect(created.data.name).toBe('主力产品监测档案');
    expect(created.data.brandName).toBe('GeoMix智混');
    expect(created.data.brandAliases).toEqual([
      '吉奥米克斯',
      'GeoMix',
      '上海吉奥米克斯科技有限公司',
    ]);
    expect(created.data.ownedDomains).toEqual(['geomix.example.com']);
    expect(created.data.competitors).toEqual([
      {
        name: '云析智联',
        aliases: ['YunXi'],
        domains: ['yunxizhilian.example.com'],
      },
    ]);

    // Duplicate (tenantId, name) returns 409
    const duplicate = await httpJson(base, 'POST', '/api/v1/visibility/profiles', {
      token: tokenStrictA,
      body: {
        name: '主力产品监测档案',
        brandName: 'GeoMix智混',
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.code).toBe(BILLING_ERROR.CONFLICT);

    // Compliance blocks forbidden terms
    const blocked = await httpJson(base, 'POST', '/api/v1/visibility/profiles', {
      token: tokenStrictA,
      body: {
        name: '违规博彩档案',
        brandName: '测试品牌',
      },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.code).toBe(API_ERROR.FORBIDDEN_INDUSTRY);

    // Patch & Delete temporary profile
    const temp = await httpJson<VisibilityProfileRecord>(
      base,
      'POST',
      '/api/v1/visibility/profiles',
      {
        token: tokenStrictA,
        body: { name: '临时档案', brandName: 'TempBrand' },
      },
    );
    expect(temp.status).toBe(200);

    const patched = await httpJson<VisibilityProfileRecord>(
      base,
      'PATCH',
      `/api/v1/visibility/profiles/${temp.data.id}`,
      {
        token: tokenStrictA,
        body: { brandAliases: ['TB'] },
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.data.brandAliases).toEqual(['TB']);

    const deleted = await httpJson<{ deleted: number }>(
      base,
      'DELETE',
      `/api/v1/visibility/profiles/${temp.data.id}`,
      { token: tokenStrictA },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.data.deleted).toBe(1);
  });

  it('reserves 12 points (3 questions × 2 engines @ 2 pts), settles 10 pts & releases 2 pts on 1 failure -> PARTIAL with zero ledger drift', async () => {
    enqueuedJobs = [];
    const profilesRes = await httpJson<VisibilityProfileListResponse>(
      base,
      'GET',
      '/api/v1/visibility/profiles',
      { token: tokenStrictA },
    );
    const profileId = profilesRes.data.items[0]!.id;

    const kwId = 'kw_strict_1';
    store.keywords.set(kwId, {
      id: kwId,
      tenantId: tenantA,
      main: 'AI品牌可见度监测',
      brands: ['GeoMix智混'],
      optStatus: 'NONE',
      createdAt: new Date(),
    });
    const qIds = ['q_s1', 'q_s2', 'q_s3'];
    qIds.forEach((id, idx) => {
      store.questions.set(id, {
        id,
        tenantId: tenantA,
        keywordId: kwId,
        text: `企业如何评估AI搜索可见度方案第${idx + 1}问？`,
        source: 'MANUAL',
        usedCount: 0,
        lastUsedAt: null,
        included: false,
        createdAt: new Date(),
      });
    });

    // Missing Idempotency-Key -> 400
    const missingIdem = await httpJson(base, 'POST', '/api/v1/visibility/runs', {
      token: tokenStrictA,
      body: {
        profileId,
        keywordId: kwId,
        engines: ['deepseek', 'doubao'],
        questionIds: qIds,
      },
    });
    expect(missingIdem.status).toBe(400);
    expect(missingIdem.code).toBe(API_ERROR.BAD_REQUEST);

    // Create 3 × 2 = 6 checks @ 2 pts = 12 pts reserved
    const created = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'idem-strict-partial-001' },
        body: {
          profileId,
          keywordId: kwId,
          name: '严格计费6次测试',
          engines: ['deepseek', 'doubao'],
          questionIds: qIds,
        },
      },
    );
    expect(created.status).toBe(200);
    expect(created.data.totalChecks).toBe(6);
    expect(created.data.unitPrice).toBe(2);
    expect(created.data.frozenPoints).toBe(12);
    expect(created.data.status).toBe('QUEUED');
    expect(created.data.observations).toHaveLength(6);
    expect(enqueuedJobs).toHaveLength(1);

    // Wallet has 12 points reserved immediately
    const walletAfterReserve = store.wallets.get(tenantA)!;
    expect(walletAfterReserve.points).toBe(100);
    expect(walletAfterReserve.pointsReserved).toBe(12);

    // Idempotent replay with same Idempotency-Key does NOT double-charge or double-enqueue
    const replayed = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'idem-strict-partial-001' },
        body: {
          profileId,
          keywordId: kwId,
          name: '严格计费6次测试',
          engines: ['deepseek', 'doubao'],
          questionIds: qIds,
        },
      },
    );
    expect(replayed.status).toBe(200);
    expect(replayed.data.id).toBe(created.data.id);
    expect(store.wallets.get(tenantA)!.pointsReserved).toBe(12);
    expect(enqueuedJobs).toHaveLength(1);

    // Replay with same key but different engines -> 409 CONFLICT
    const conflictReplay = await httpJson(base, 'POST', '/api/v1/visibility/runs', {
      token: tokenStrictA,
      headers: { 'Idempotency-Key': 'idem-strict-partial-001' },
      body: {
        profileId,
        keywordId: kwId,
        engines: ['deepseek'],
        questionIds: qIds,
      },
    });
    expect(conflictReplay.status).toBe(409);

    // Orphan hold guard keeps QUEUED visibility_run alive
    const prismaSvc = app.get(PrismaService);
    const activeWhileQueued = await hasLiveActiveWork(
      prismaSvc,
      { tenantId: tenantA, refType: 'visibility_run', refId: created.data.id },
      new Date(Date.now() + 4 * 3600 * 1000),
      30 * 60_000,
    );
    expect(activeWhileQueued).toBe(true);

    // Simulate 1 collector failure on the 3rd call, other 5 succeed
    const realCollect = collector.collect.bind(collector);
    let callIdx = 0;
    const spy = vi.spyOn(collector, 'collect').mockImplementation(async (input) => {
      callIdx += 1;
      if (callIdx === 3) {
        throw new Error('模拟上游引擎响应超时');
      }
      return realCollect(input);
    });

    await runner.process({ tenantId: tenantA, runId: created.data.id });
    spy.mockRestore();

    const detail = await httpJson<VisibilityRunDetailRecord>(
      base,
      'GET',
      `/api/v1/visibility/runs/${created.data.id}`,
      { token: tokenStrictA },
    );
    expect(detail.status).toBe(200);
    expect(detail.data.status).toBe('PARTIAL');
    expect(detail.data.doneCount).toBe(5);
    expect(detail.data.failCount).toBe(1);
    expect(detail.data.frozenPoints).toBe(12);
    expect(detail.data.settledPoints).toBe(10);
    expect(detail.data.releasedPoints).toBe(2);

    // Wallet final state: 100 - 10 = 90 points, 0 reserved
    const walletAfterRun = store.wallets.get(tenantA)!;
    expect(walletAfterRun.points).toBe(90);
    expect(walletAfterRun.pointsReserved).toBe(0);

    // Reservation CLOSED and real BillingService audit invariants hold 100%
    const resv = store.reservations.get(detail.data.reservationId!)!;
    expect(resv.status).toBe('CLOSED');
    expect(resv.frozen).toBe(12);
    expect(resv.settled).toBe(10);
    expect(resv.released).toBe(2);

    const driftIssues = await billing.auditTenant(tenantA);
    expect(driftIssues).toEqual([]);
    const snapshot = await billing.ledgerSnapshot(tenantA, 100);
    billing.assertSnapshot(snapshot);
  });

  it('supports SHADOW mode (wallet balance unchanged, delta=0, listPrice=2 with 免费期), writes back Question.included & Keyword.optStatus, and deduplicates /me/rights model cards', async () => {
    const profRes = await httpJson<VisibilityProfileRecord>(
      base,
      'POST',
      '/api/v1/visibility/profiles',
      {
        token: tokenShadowB,
        body: {
          name: '影子计费与收录回写档案',
          brandName: '星图智造',
          brandAliases: ['StarMap'],
          ownedDomains: ['starmap.example.com'],
          competitors: [
            {
              name: '领航数科',
              aliases: [],
              domains: ['linghang.example.com'],
            },
          ],
        },
      },
    );
    expect(profRes.status).toBe(200);
    const profileId = profRes.data.id;

    const kwHitId = 'kw_shadow_hit';
    store.keywords.set(kwHitId, {
      id: kwHitId,
      tenantId: tenantB,
      main: '星图智造选型指南',
      brands: ['星图智造'],
      optStatus: 'NONE',
      createdAt: new Date(),
    });
    const q1 = 'q_sh_1';
    const q2 = 'q_sh_2';
    const q3 = 'q_sh_3';
    [
      { id: q1, text: '星图智造在工业质检场景有哪些优势？' },
      { id: q2, text: '中小企业部署星图智造系统成本如何？' },
      { id: q3, text: '传统人工质检与自动化视觉方案对比？' },
    ].forEach((row) => {
      store.questions.set(row.id, {
        id: row.id,
        tenantId: tenantB,
        keywordId: kwHitId,
        text: row.text,
        source: 'DISTILL',
        usedCount: 0,
        lastUsedAt: null,
        included: false,
        createdAt: new Date(),
      });
    });

    // Deterministic collector mock for exact hit verification:
    // - q1 hits on BOTH deepseek & doubao
    // - q2 hits ONLY on deepseek (misses on doubao)
    // - q3 misses on BOTH deepseek & doubao (competitor only)
    const collectSpy = vi.spyOn(collector, 'collect').mockImplementation(async (input) => {
      const hitQ1 = input.promptText.includes('工业质检');
      const hitQ2Deepseek =
        input.promptText.includes('部署星图智造') && input.engine === 'deepseek';
      if (hitQ1 || hitQ2Deepseek) {
        return {
          collectorKind: 'fake',
          answerText: `1. 星图智造：系统稳定可靠、性价比突出，值得优先推荐。2. 领航数科：可作为备选参考。`,
          citations: [
            {
              url: 'https://docs.starmap.example.com/guide',
              title: '星图智造产品白皮书',
              snippet: '核心架构说明',
              position: 1,
            },
            {
              url: 'https://zhuanlan.zhihu.com/p/998877',
              title: '工业视觉选型测评',
              snippet: '行业对比',
              position: 2,
            },
          ],
          fanOutQueries: [input.promptText, '星图智造 价格与口碑', '工业视觉质检排名'],
        };
      }
      return {
        collectorKind: 'fake',
        answerText: `目前讨论较多的是领航数科，适合传统报表场景。`,
        citations: [
          {
            url: 'https://www.linghang.example.com/report',
            title: '领航数科案例',
            snippet: '行业案例',
            position: 1,
          },
          {
            url: 'https://36kr.com/p/112233',
            title: '2026行业报告',
            snippet: '权威分析',
            position: 2,
          },
        ],
        fanOutQueries: ['工业质检软件对比'],
      };
    });

    // Run #1: 3 questions × 2 engines = 6 checks in SHADOW mode
    const run1 = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenShadowB,
        headers: { 'Idempotency-Key': 'idem-shadow-run-001' },
        body: {
          profileId,
          keywordId: kwHitId,
          name: '影子监测首轮',
          engines: ['deepseek', 'doubao'],
          questionIds: [q1, q2, q3],
        },
      },
    );
    expect(run1.status).toBe(200);
    await runner.process({ tenantId: tenantB, runId: run1.data.id });

    // Verify SHADOW wallet & PointLog
    const shadowWallet = store.wallets.get(tenantB)!;
    expect(shadowWallet.points).toBe(500);
    expect(shadowWallet.pointsReserved).toBe(0);

    const shadowLogs = store.pointLogs.filter((l) => l.tenantId === tenantB);
    expect(shadowLogs).toHaveLength(6);
    for (const log of shadowLogs) {
      expect(log.action).toBe('visibility_check');
      expect(log.status).toBe('SETTLED');
      expect(log.delta).toBe(0);
      expect(log.listPrice).toBe(2);
      expect(log.title).toBe('AI可见性监测-影子监测首轮（免费期）');
    }
    expect(await billing.auditTenant(tenantB)).toEqual([]);

    // Verify writeback to Question.included & Keyword.optStatus
    expect(store.questions.get(q1)!.included).toBe(true);
    expect(store.questions.get(q2)!.included).toBe(true);
    expect(store.questions.get(q3)!.included).toBe(false);
    expect(store.keywords.get(kwHitId)!.optStatus).toBe('INCLUDED');

    // Verify /api/v1/me/rights INCLUDED card & 8 model cards
    const rights1 = await httpJson<{
      cards: Array<{ key: string; used?: string; text: string }>;
      models: Array<{ key: string; label: string; count: number }>;
    }>(base, 'GET', '/api/v1/me/rights', { token: tokenShadowB });
    expect(rights1.status).toBe(200);
    const includedCard1 = rights1.data.cards.find((c) => c.key === 'INCLUDED');
    expect(includedCard1?.text).toBe('2');
    const modelMap1 = new Map(rights1.data.models.map((m) => [m.key, m.count]));
    expect(modelMap1.get('deepseek')).toBe(2); // q1 + q2
    expect(modelMap1.get('doubao')).toBe(1); // q1
    expect(modelMap1.get('yuanbao')).toBe(0);
    expect(modelMap1.get('kimi')).toBe(0);

    // Run #2: re-run the exact same questions [q1, q2] on deepseek & doubao -> must NOT inflate deduplicated model counts!
    const run2 = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenShadowB,
        headers: { 'Idempotency-Key': 'idem-shadow-run-002' },
        body: {
          profileId,
          keywordId: kwHitId,
          name: '影子监测次轮复测',
          engines: ['deepseek', 'doubao'],
          questionIds: [q1, q2],
        },
      },
    );
    expect(run2.status).toBe(200);
    await runner.process({ tenantId: tenantB, runId: run2.data.id });

    const rights2 = await httpJson<{
      cards: Array<{ key: string; used?: string; text: string }>;
      models: Array<{ key: string; label: string; count: number }>;
    }>(base, 'GET', '/api/v1/me/rights', { token: tokenShadowB });
    const modelMap2 = new Map(rights2.data.models.map((m) => [m.key, m.count]));
    expect(modelMap2.get('deepseek')).toBe(2);
    expect(modelMap2.get('doubao')).toBe(1);

    // Run #3: keyword whose tested questions ALL miss -> Keyword.optStatus transitions NONE -> OPTIMIZING
    const kwMissId = 'kw_shadow_miss';
    store.keywords.set(kwMissId, {
      id: kwMissId,
      tenantId: tenantB,
      main: '未命中待优化主词',
      brands: ['星图智造'],
      optStatus: 'NONE',
      createdAt: new Date(),
    });
    const qMiss = 'q_sh_miss_1';
    store.questions.set(qMiss, {
      id: qMiss,
      tenantId: tenantB,
      keywordId: kwMissId,
      text: '通用行业无品牌提及测试问题？',
      source: 'MANUAL',
      usedCount: 0,
      lastUsedAt: null,
      included: false,
      createdAt: new Date(),
    });

    const run3 = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenShadowB,
        headers: { 'Idempotency-Key': 'idem-shadow-run-003' },
        body: {
          profileId,
          keywordId: kwMissId,
          name: '零命中回写测试',
          engines: ['deepseek'],
          questionIds: [qMiss],
        },
      },
    );
    expect(run3.status).toBe(200);
    await runner.process({ tenantId: tenantB, runId: run3.data.id });
    expect(store.questions.get(qMiss)!.included).toBe(false);
    expect(store.keywords.get(kwMissId)!.optStatus).toBe('OPTIMIZING');

    collectSpy.mockRestore();

    // Verify /api/v1/visibility/overview aggregation on Tenant B
    // Total completed observations for Tenant B across Run 1 (6) + Run 2 (4) + Run 3 (1) = 11 checks:
    // Brand mentioned: Run 1 (3: q1×2 + q2×1) + Run 2 (3: q1×2 + q2×1) + Run 3 (0) = 6 checks -> 54.5%
    // Competitor '领航数科' mentioned in all 11 checks -> SoV: 6 / (6 + 11) = 35.3%
    const overview = await httpJson<VisibilityOverviewResponse>(
      base,
      'GET',
      `/api/v1/visibility/overview?profileId=${profileId}&days=7`,
      { token: tokenShadowB },
    );
    expect(overview.status).toBe(200);
    expect(overview.data.profileId).toBe(profileId);
    expect(overview.data.metrics.completedChecks).toBe(11);
    expect(overview.data.metrics.mentionedChecks).toBe(6);
    expect(overview.data.metrics.visibilityPct).toBe(54.5);
    expect(overview.data.metrics.shareOfVoice.brandSharePct).toBe(35.3);
    expect(overview.data.metrics.avgPosition).toBe(1);
    expect(overview.data.metrics.sentimentSummary.positive).toBe(6);
    expect(overview.data.trend.filter((pt) => pt.engine === 'all')).toHaveLength(7);
    expect(
      overview.data.trend.some((pt) => pt.engine === 'deepseek' && pt.completedChecks > 0),
    ).toBe(true);

    // Verify /api/v1/visibility/citations leaderboard & sourceKind filtering
    const allCitations = await httpJson<VisibilityCitationListResponse>(
      base,
      'GET',
      `/api/v1/visibility/citations?profileId=${profileId}&days=30`,
      { token: tokenShadowB },
    );
    expect(allCitations.status).toBe(200);
    expect(allCitations.data.sourceBreakdown).toEqual({
      OWNED: 6,
      COMPETITOR: 5,
      AUTHORITY: 5,
      SOCIAL: 6,
      OTHER: 0,
    });

    const ownedOnly = await httpJson<VisibilityCitationListResponse>(
      base,
      'GET',
      `/api/v1/visibility/citations?profileId=${profileId}&sourceKind=OWNED`,
      { token: tokenShadowB },
    );
    expect(ownedOnly.status).toBe(200);
    expect(ownedOnly.data.total).toBe(1);
    expect(ownedOnly.data.items[0]).toMatchObject({
      domain: 'docs.starmap.example.com',
      sourceKind: 'OWNED',
      citationCount: 6,
      questionCount: 2, // q1 + q2 deduplicated across Run 1 & Run 2!
    });
  });

  it('supports pause, resume, cancel releasing remaining frozen points, cross-tenant 404 isolation, and expired-tenant 40301 guard', async () => {
    const profA = (
      await httpJson<VisibilityProfileListResponse>(base, 'GET', '/api/v1/visibility/profiles', {
        token: tokenStrictA,
      })
    ).data.items[0]!;
    const profB = (
      await httpJson<VisibilityProfileListResponse>(base, 'GET', '/api/v1/visibility/profiles', {
        token: tokenShadowB,
      })
    ).data.items[0]!;

    // Cross-tenant isolation: Tenant A accessing Tenant B's profile, overview, citations, or runs -> 404
    const crossGetProfile = await httpJson(base, 'GET', `/api/v1/visibility/profiles/${profB.id}`, {
      token: tokenStrictA,
    });
    expect(crossGetProfile.status).toBe(404);
    expect(crossGetProfile.code).toBe(AUTH_ERROR.NOT_FOUND);

    const crossOverview = await httpJson(
      base,
      'GET',
      `/api/v1/visibility/overview?profileId=${profB.id}`,
      { token: tokenStrictA },
    );
    expect(crossOverview.status).toBe(404);

    const crossCitations = await httpJson(
      base,
      'GET',
      `/api/v1/visibility/citations?profileId=${profB.id}`,
      { token: tokenStrictA },
    );
    expect(crossCitations.status).toBe(404);

    const bRuns = await httpJson<VisibilityRunListResponse>(
      base,
      'GET',
      '/api/v1/visibility/runs',
      { token: tokenShadowB },
    );
    const bRunId = bRuns.data.items[0]!.id;

    const crossRunDetail = await httpJson(base, 'GET', `/api/v1/visibility/runs/${bRunId}`, {
      token: tokenStrictA,
    });
    expect(crossRunDetail.status).toBe(404);

    // Pause -> worker skips -> Resume -> Cancel releases frozen points in STRICT mode
    const openingPoints = store.wallets.get(tenantA)!.points; // 90
    const created = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      '/api/v1/visibility/runs',
      {
        token: tokenStrictA,
        headers: { 'Idempotency-Key': 'idem-pause-cancel-001' },
        body: {
          profileId: profA.id,
          name: '暂停与取消退点测试',
          engines: ['deepseek', 'doubao'],
          customPrompts: [
            '自定义监测问题一：GEO工具怎么选？',
            '自定义监测问题二：企业如何提升AI推荐率？',
          ],
        },
      },
    );
    expect(created.status).toBe(200);
    expect(created.data.frozenPoints).toBe(8); // 2 prompts × 2 engines × 2 pts
    expect(store.wallets.get(tenantA)!.pointsReserved).toBe(8);

    const paused = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v1/visibility/runs/${created.data.id}/pause`,
      { token: tokenStrictA },
    );
    expect(paused.status).toBe(200);
    expect(paused.data.status).toBe('PAUSED');

    // Worker stops immediately when PAUSED without consuming checks or closing reservation
    await runner.process({ tenantId: tenantA, runId: created.data.id });
    expect(store.wallets.get(tenantA)!.pointsReserved).toBe(8);

    // Resume transitions PAUSED -> QUEUED
    const resumed = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v1/visibility/runs/${created.data.id}/resume`,
      { token: tokenStrictA },
    );
    expect(resumed.status).toBe(200);
    expect(resumed.data.status).toBe('QUEUED');

    // Cancel transitions -> CANCELLED, marks pending observations SKIPPED, and releases all 8 frozen points!
    const cancelled = await httpJson<VisibilityRunDetailRecord>(
      base,
      'POST',
      `/api/v1/visibility/runs/${created.data.id}/cancel`,
      { token: tokenStrictA },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('CANCELLED');
    expect(cancelled.data.releasedPoints).toBe(8);
    expect(store.wallets.get(tenantA)!.points).toBe(openingPoints);
    expect(store.wallets.get(tenantA)!.pointsReserved).toBe(0);
    expect(await billing.auditTenant(tenantA)).toEqual([]);

    // Expired Tenant C: GET endpoints return 200, POST endpoints return 403 (40301)
    const expiredOverview = await httpJson<VisibilityOverviewResponse>(
      base,
      'GET',
      '/api/v1/visibility/overview',
      { token: tokenExpiredC },
    );
    expect(expiredOverview.status).toBe(200);

    const expiredProfilesGet = await httpJson<VisibilityProfileListResponse>(
      base,
      'GET',
      '/api/v1/visibility/profiles',
      { token: tokenExpiredC },
    );
    expect(expiredProfilesGet.status).toBe(200);

    const expiredCreateProfile = await httpJson(base, 'POST', '/api/v1/visibility/profiles', {
      token: tokenExpiredC,
      body: { name: '到期租户不可写', brandName: 'ExpiredBrand' },
    });
    expect(expiredCreateProfile.status).toBe(403);
    expect(expiredCreateProfile.code).toBe(API_ERROR.TENANT_EXPIRED);

    const expiredCreateRun = await httpJson(base, 'POST', '/api/v1/visibility/runs', {
      token: tokenExpiredC,
      headers: { 'Idempotency-Key': 'idem-expired-001' },
      body: {
        profileId: 'prof_any',
        engines: ['deepseek'],
        customPrompts: ['到期租户测试问题'],
      },
    });
    expect(expiredCreateRun.status).toBe(403);
    expect(expiredCreateRun.code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('aggregates competitor gaps & query fan-out opportunities, imports AI questions with deduplication & QUESTION quota guard', async () => {
    const keywordId = store.nextId('kw');
    store.keywords.set(keywordId, {
      id: keywordId,
      tenantId: tenantA,
      main: 'AI可见性监测工具',
      brands: ['GeoMix'],
      optStatus: 'INCLUDED',
      createdAt: new Date(),
    });

    const otherTenantKwId = store.nextId('kw');
    store.keywords.set(otherTenantKwId, {
      id: otherTenantKwId,
      tenantId: tenantB,
      main: '竞品租户主词',
      brands: ['OtherBrand'],
      optStatus: 'NONE',
      createdAt: new Date(),
    });

    const profileId = store.nextId('vprof');
    const now = new Date();
    store.profiles.set(profileId, {
      id: profileId,
      tenantId: tenantA,
      name: '机会闭环测试档案',
      brandName: 'GeoMix',
      brandAliases: [],
      ownedDomains: ['geomix.cn'],
      competitors: [
        { name: '竞品Alpha', aliases: [], domains: ['alpha.cn'] },
        { name: '竞品Beta', aliases: [], domains: ['beta.cn'] },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const runId = store.nextId('vrun');
    store.runs.set(runId, {
      id: runId,
      tenantId: tenantA,
      profileId,
      keywordId,
      name: '机会测试任务',
      engines: ['deepseek', 'doubao'],
      questionIds: [],
      totalChecks: 3,
      doneCount: 3,
      failCount: 0,
      unitPrice: 2,
      reservationId: null,
      status: 'COMPLETED',
      lastError: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
    });

    const obs1Id = store.nextId('vobs');
    store.observations.set(obs1Id, {
      id: obs1Id,
      tenantId: tenantA,
      runId,
      profileId,
      questionId: null,
      promptText: '企业级 GEO 品牌监测平台哪家好？',
      engine: 'deepseek',
      status: 'SUCCESS',
      collectorKind: 'fake',
      answerText: '推荐竞品Alpha 与竞品Beta。',
      brandMentioned: false,
      brandPosition: null,
      brandSentiment: null,
      brandPassage: null,
      competitorHits: [
        { name: '竞品Alpha', mentioned: true, position: 1, sentiment: 'positive' },
        { name: '竞品Beta', mentioned: true, position: 2, sentiment: 'neutral' },
      ],
      fanOutQueries: ['GEO 品牌监测平台评测', 'AI 引用溯源工具对比', '大模型可见率怎么提升'],
      judgeModel: 'fake-judge',
      tokensIn: 100,
      tokensOut: 200,
      error: null,
      checkedAt: now,
      createdAt: now,
    });

    const obs2Id = store.nextId('vobs');
    store.observations.set(obs2Id, {
      id: obs2Id,
      tenantId: tenantA,
      runId,
      profileId,
      questionId: null,
      promptText: '国内大模型引用排名怎么看？',
      engine: 'doubao',
      status: 'SUCCESS',
      collectorKind: 'fake',
      answerText: 'GeoMix 表现不错。',
      brandMentioned: true,
      brandPosition: 1,
      brandSentiment: 'positive',
      brandPassage: 'GeoMix 表现不错',
      competitorHits: [{ name: '竞品Alpha', mentioned: false, position: null, sentiment: null }],
      fanOutQueries: ['GEO 品牌监测平台评测'],
      judgeModel: 'fake-judge',
      tokensIn: 100,
      tokensOut: 200,
      error: null,
      checkedAt: now,
      createdAt: now,
    });

    // 1. GET /api/v1/visibility/opportunities
    const oppRes = await httpJson<VisibilityOpportunitiesResponse>(
      base,
      'GET',
      `/api/v1/visibility/opportunities?profileId=${profileId}`,
      { token: tokenStrictA },
    );
    expect(oppRes.status).toBe(200);
    expect(oppRes.data.gaps).toHaveLength(1);
    expect(oppRes.data.gaps[0]).toMatchObject({
      promptText: '企业级 GEO 品牌监测平台哪家好？',
      competitors: ['竞品Alpha', '竞品Beta'],
      engines: ['deepseek'],
      observationCount: 1,
    });
    expect(oppRes.data.fanOutQueries).toHaveLength(3);
    expect(oppRes.data.fanOutQueries[0]).toMatchObject({
      query: 'GEO 品牌监测平台评测',
      frequency: 2,
      brandMentionedPct: 50,
    });

    // 2. Import 3 fanOutQueries -> creates 3 Question rows with source='AI' and increments QUESTION quota by 3
    const quotaBefore = store.quotas.find((q) => q.tenantId === tenantA && q.key === 'QUESTION')!;
    const usedBefore = quotaBefore.used;

    const importRes = await httpJson<ImportQuestionsResult>(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenStrictA,
        body: {
          keywordId,
          titles: oppRes.data.fanOutQueries.map((f) => f.query),
        },
      },
    );
    expect(importRes.status).toBe(200);
    expect(importRes.data).toMatchObject({
      insertedCount: 3,
      skippedCount: 0,
      keywordId,
    });
    expect(quotaBefore.used).toBe(usedBefore + 3n);

    const createdQuestions = [...store.questions.values()].filter(
      (q) => q.tenantId === tenantA && q.keywordId === keywordId,
    );
    expect(createdQuestions).toHaveLength(3);
    expect(createdQuestions.every((q) => q.source === 'AI' && q.included === false)).toBe(true);

    // 3. Re-importing with duplicates skips existing titles and returns accurate skippedCount
    const dupRes = await httpJson<ImportQuestionsResult>(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenStrictA,
        body: {
          keywordId,
          titles: ['GEO 品牌监测平台评测', '企业级 GEO 品牌监测平台哪家好？'],
        },
      },
    );
    expect(dupRes.status).toBe(200);
    expect(dupRes.data).toMatchObject({
      insertedCount: 1,
      skippedCount: 1,
    });
    expect(quotaBefore.used).toBe(usedBefore + 4n);

    // 4. Exceeding QUESTION quota returns 409 (QUOTA_EXCEEDED) with 0 partial writes
    const prevLimit = quotaBefore.limit;
    quotaBefore.limit = quotaBefore.used + 1n; // only 1 slot left
    const countBeforeQuotaErr = store.questions.size;
    const quotaErrRes = await httpJson(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenStrictA,
        body: {
          keywordId,
          titles: ['配额超限测试问题A', '配额超限测试问题B'],
        },
      },
    );
    expect(quotaErrRes.status).toBe(409);
    expect(quotaErrRes.code).toBe(API_ERROR.QUOTA_EXCEEDED);
    expect(store.questions.size).toBe(countBeforeQuotaErr);
    quotaBefore.limit = prevLimit;

    // 5. Cross-tenant keywordId returns 404
    const crossTenantRes = await httpJson(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenStrictA,
        body: {
          keywordId: otherTenantKwId,
          titles: ['跨租户写入测试'],
        },
      },
    );
    expect(crossTenantRes.status).toBe(404);
    expect(crossTenantRes.code).toBe(AUTH_ERROR.NOT_FOUND);

    // 6. Expired tenant returns 403 (40301)
    const expiredImportRes = await httpJson(
      base,
      'POST',
      '/api/v1/visibility/opportunities/import-questions',
      {
        token: tokenExpiredC,
        body: {
          keywordId,
          titles: ['到期租户导入测试'],
        },
      },
    );
    expect(expiredImportRes.status).toBe(403);
    expect(expiredImportRes.code).toBe(API_ERROR.TENANT_EXPIRED);
  });
});
