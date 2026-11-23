import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BillingRuleError,
  evaluateLedger,
  isChargeAction,
  isPositivePoints,
  isReservationRefType,
  isValidUnitPoints,
  ledgerTitle,
  PRICING_DEFAULTS,
  quoteGeoWrite,
  resolveTenantBillingMode,
  type BillingMode,
  type ChargeAction,
  type GeoWriteQuote,
  type LedgerSnapshot,
  type ReservationRefType,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import type { BillingOptions } from './billing.options';
import { BILLING_OPTIONS } from './billing.options';
import {
  TX_OPTIONS,
  assertActorId,
  assertRefId,
  assertUnitKey,
  badRequest,
  conflict,
  insufficient,
  isUniqueViolation,
  lockReservation,
  lockWallet,
  notFound,
  remainder,
  type BillingTx,
  type LockedReservation,
} from './billing.sql';

type ChargeLine = {
  action: ChargeAction;
  listPrice: number;
  title: string;
  detail?: Prisma.InputJsonValue;
};

type StoredLog = {
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

export type ReservationView = {
  id: string;
  tenantId: string;
  refType: string;
  refId: string;
  shadow: boolean;
  frozen: number;
  settled: number;
  released: number;
  status: 'OPEN' | 'CLOSED';
};

export type LedgerLineView = {
  id: string;
  action: string;
  reason: string;
  title: string;
  unitKey: string;
  delta: number;
  listPrice: number;
  balanceAfter: number | null;
  status: StoredLog['status'];
  detail: Prisma.JsonValue | null;
  createdAt: string;
};

export type SettleResult = {
  reservation: ReservationView;
  lines: LedgerLineView[];
  replayed: boolean;
};

export type ReconcileReport = {
  scanned: number;
  closed: number;
  releasedPoints: number;
  skippedActive: number;
  skippedUnknown: number;
  failed: number;
  ledgerIssues: Array<{ tenantId: string; issues: string[] }>;
};

/**
 * 账本服务。api 和 worker 共用。
 * 同一租户的预扣、结算、释放都先锁 Wallet 行，再用条件更新，避免并发超扣。
 * 原始 SQL 都带 tenantId。商户接口只传入登录租户，不能从查询参数指定别人。
 * 冻结单上的 shadow 在预扣时写死，之后改租户模式也不追溯。
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_OPTIONS) private readonly options: BillingOptions,
  ) {}

  async quoteGeoWrite(input: { count: number; taskName?: string }): Promise<GeoWriteQuote> {
    const geoWritePoints = await this.unitPrice('geo_write');
    try {
      return quoteGeoWrite({
        count: input.count,
        geoWritePoints,
        subject: input.taskName,
      });
    } catch (error) {
      if (error instanceof BillingRuleError) throw badRequest('报价参数不正确');
      throw error;
    }
  }

  async listPrices(): Promise<
    Array<{ action: string; unitPoints: number; enabled: boolean; label: string }>
  > {
    const rows = await this.prisma.base.pricingItem.findMany({ orderBy: { action: 'asc' } });
    const existingActions = new Set(rows.map((row) => row.action));
    const missingDefaults = PRICING_DEFAULTS.filter((item) => !existingActions.has(item.action));
    if (
      missingDefaults.length > 0 &&
      typeof this.prisma.base.pricingItem.createMany === 'function'
    ) {
      await this.prisma.base.pricingItem
        .createMany({
          data: missingDefaults.map((item) => ({
            action: item.action,
            unitPoints: item.unitPoints,
            enabled: true,
          })),
          skipDuplicates: true,
        })
        .catch(() => undefined);
    }
    const merged = [
      ...rows.map((row) => ({
        action: row.action,
        unitPoints: row.unitPoints,
        enabled: row.enabled,
        label: PRICING_DEFAULTS.find((item) => item.action === row.action)?.label ?? row.action,
      })),
      ...missingDefaults.map((item) => ({
        action: item.action,
        unitPoints: item.unitPoints,
        enabled: true,
        label: item.label,
      })),
    ];
    return merged.sort((a, b) => a.action.localeCompare(b.action));
  }

  async unitPrice(action: ChargeAction): Promise<number> {
    if (!isChargeAction(action)) throw badRequest('计费动作不正确');
    const def = PRICING_DEFAULTS.find((item) => item.action === action);
    const label = def?.label ?? action;
    const row = await this.prisma.base.pricingItem.findUnique({ where: { action } });
    if (row) {
      if (!row.enabled) throw badRequest(`${label}价格未启用`);
      if (!isValidUnitPoints(action, row.unitPoints)) throw badRequest(`${label}单价配置不正确`);
      return row.unitPoints;
    }
    if (def && isValidUnitPoints(action, def.unitPoints)) {
      return def.unitPoints;
    }
    throw badRequest(`${label}价格未配置`);
  }

  async wallet(tenantId: string): Promise<{
    points: number;
    pointsReserved: number;
    available: number;
    money: string;
    billingMode: BillingMode;
    billingModeSource: 'tenant' | 'global';
    tenantBillingMode: BillingMode | null;
  }> {
    const tenant = await this.prisma.base.tenant.findUnique({
      where: { id: tenantId },
      select: { billingMode: true },
    });
    if (!tenant) throw notFound('账号不存在');
    const wallet = await this.prisma.base.wallet.findUnique({ where: { tenantId } });
    if (!wallet) throw notFound('钱包不存在');
    const resolved = resolveTenantBillingMode(tenant.billingMode, this.options.globalMode());
    return {
      points: wallet.points,
      pointsReserved: wallet.pointsReserved,
      available: wallet.points - wallet.pointsReserved,
      money: wallet.money.toString(),
      billingMode: resolved.mode,
      billingModeSource: resolved.source,
      tenantBillingMode: tenant.billingMode,
    };
  }

  async ledger(
    tenantId: string,
    page: number,
    pageSize: number,
  ): Promise<{ page: number; pageSize: number; total: number; items: LedgerLineView[] }> {
    const where = { tenantId };
    const [total, rows] = await Promise.all([
      this.prisma.base.pointLog.count({ where }),
      this.prisma.base.pointLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows.map(presentLog) };
  }

  async reserve(input: {
    tenantId: string;
    refType: ReservationRefType;
    refId: string;
    amount: number;
  }): Promise<ReservationView> {
    if (!isReservationRefType(input.refType)) throw badRequest('冻结类型不正确');
    const refId = assertRefId(input.refId);
    const amount = this.amount(input.amount);
    const request = { ...input, refId, amount };
    try {
      return await this.transaction((tx) => this.reserveIn(tx, request));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.replayReserve(request);
    }
  }

  /** 同步动作（蒸馏、单篇复刻）只有一个结算单元。refId 就是幂等键。 */
  async reserveSync(input: {
    tenantId: string;
    refType: ReservationRefType;
    unitKey: string;
    amount: number;
  }): Promise<ReservationView> {
    return this.reserve({
      tenantId: input.tenantId,
      refType: input.refType,
      refId: input.unitKey,
      amount: input.amount,
    });
  }

  async settle(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    action: ChargeAction;
    amount: number;
    title: string;
    detail?: Prisma.InputJsonValue;
  }): Promise<SettleResult> {
    return this.settleLines({
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      unitKey: input.unitKey,
      lines: [
        {
          action: input.action,
          listPrice: input.amount,
          title: input.title,
          detail: input.detail,
        },
      ],
    });
  }

  /**
   * 一个结算单元的多条账在同一个事务里写完。
   * 写作任务引用知识库时，正文价和知识库加价各一条，listPrice 相加等于这一篇的单价。
   */
  async settleLines(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    lines: ChargeLine[];
  }): Promise<SettleResult> {
    const unitKey = assertUnitKey(input.unitKey);
    const lines = this.normalizeLines(input.lines);
    const request = {
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      unitKey,
      lines,
    };
    try {
      return await this.transaction((tx) => this.settleIn(tx, request));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.replaySettle(request);
    }
  }

  async settleGeoWriteUnit(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    subject: string;
    geoWritePoints: number;
  }): Promise<SettleResult> {
    let quote: GeoWriteQuote;
    try {
      quote = quoteGeoWrite({
        count: 1,
        geoWritePoints: input.geoWritePoints,
        subject: input.subject,
      });
    } catch (error) {
      if (error instanceof BillingRuleError) throw badRequest('结算单价不正确');
      throw error;
    }
    return this.settleLines({
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      unitKey: input.unitKey,
      lines: quote.lines.map((line) => ({
        action: line.action,
        listPrice: line.listPrice,
        title: line.title,
        detail: {
          unitPrice: quote.unitPrice,
          part: line.action,
        },
      })),
    });
  }

  async releaseUnit(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    amount: number;
    title?: string;
  }): Promise<SettleResult> {
    const unitKey = assertUnitKey(input.unitKey);
    const amount = this.amount(input.amount);
    const request = { ...input, unitKey, amount, title: input.title ?? '退还预扣' };
    try {
      return await this.transaction((tx) => this.releaseIn(tx, request));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.replayRelease(request);
    }
  }

  async close(input: {
    tenantId: string;
    reservationId: string;
  }): Promise<{ reservation: ReservationView; releasedNow: number }> {
    try {
      return await this.transaction((tx) => this.closeIn(tx, input.tenantId, input.reservationId));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.readReservation(input.tenantId, input.reservationId);
      if (existing?.status === 'CLOSED') return { reservation: existing, releasedNow: 0 };
      throw error;
    }
  }

  async adminAdjust(input: {
    actorUserId: string;
    actorRole: 'ADMIN' | 'MERCHANT';
    tenantId: string;
    delta: number;
    idempotencyKey: string;
    remark?: string;
  }): Promise<LedgerLineView> {
    if (input.actorRole !== 'ADMIN') throw notFound();
    const actorUserId = assertActorId(input.actorUserId);
    const idempotencyKey = assertUnitKey(input.idempotencyKey);
    if (
      !Number.isSafeInteger(input.delta) ||
      input.delta === 0 ||
      Math.abs(input.delta) > 1_000_000_000
    ) {
      throw badRequest('调整点数不正确');
    }
    const remark = (input.remark ?? '')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 200);
    const request = { ...input, actorUserId, idempotencyKey, remark };
    try {
      return await this.transaction((tx) => this.adjustIn(tx, request));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findOwnLog(input.tenantId, idempotencyKey, 'admin_topup');
      if (!existing || existing.delta !== input.delta) throw conflict('幂等记录与本次请求不一致');
      return presentLog(existing);
    }
  }

  async setBillingMode(input: {
    actorUserId: string;
    actorRole: 'ADMIN' | 'MERCHANT';
    tenantId: string;
    billingMode: BillingMode | null;
  }): Promise<{ tenantId: string; billingMode: BillingMode | null }> {
    if (input.actorRole !== 'ADMIN') throw notFound();
    const actorUserId = assertActorId(input.actorUserId);
    const tenant = await this.prisma.base.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true, billingMode: true },
    });
    if (!tenant) throw notFound('账号不存在');
    if (tenant.billingMode === input.billingMode) {
      return { tenantId: tenant.id, billingMode: tenant.billingMode };
    }
    await this.prisma.base.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { billingMode: input.billingMode },
      });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: actorUserId,
          action: 'billing_mode_change',
          payload: { from: tenant.billingMode, to: input.billingMode },
        },
      });
    });
    return { tenantId: tenant.id, billingMode: input.billingMode };
  }

  /**
   * 超过 orphanAfterMs 仍是 OPEN、且没有活跃任务的冻结单，按已结算部分结单，其余释放。
   * 这覆盖 worker 被杀掉、队列里已经没有任务的情况。
   */
  async reconcileOrphans(now = this.options.now()): Promise<ReconcileReport> {
    const cutoff = new Date(now.getTime() - this.options.orphanAfterMs);
    const open = await this.prisma.base.pointReservation.findMany({
      where: { status: 'OPEN', createdAt: { lt: cutoff } },
      select: {
        id: true,
        tenantId: true,
        refType: true,
        refId: true,
        frozen: true,
        settled: true,
        released: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const report: ReconcileReport = {
      scanned: open.length,
      closed: 0,
      releasedPoints: 0,
      skippedActive: 0,
      skippedUnknown: 0,
      failed: 0,
      ledgerIssues: [],
    };
    for (const row of open) {
      let active = false;
      try {
        active = this.options.hasActiveJob
          ? await this.options.hasActiveJob({
              tenantId: row.tenantId,
              refType: row.refType,
              refId: row.refId,
            })
          : false;
      } catch (error) {
        report.skippedUnknown += 1;
        this.logger.warn(
          `skip reconcile ${row.id}: ${error instanceof Error ? error.message : 'probe failed'}`,
        );
        continue;
      }
      if (active) {
        report.skippedActive += 1;
        continue;
      }
      try {
        const closed = await this.close({ tenantId: row.tenantId, reservationId: row.id });
        report.closed += 1;
        report.releasedPoints += closed.releasedNow;
      } catch (error) {
        report.failed += 1;
        this.logger.warn(
          `close ${row.id} failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    const wallets = await this.prisma.base.wallet.findMany({ select: { tenantId: true } });
    for (const wallet of wallets) {
      const issues = await this.auditTenant(wallet.tenantId);
      if (issues.length > 0) report.ledgerIssues.push({ tenantId: wallet.tenantId, issues });
    }
    if (report.ledgerIssues.length > 0) {
      this.logger.warn(`ledger drift on ${report.ledgerIssues.length} tenant(s)`);
    }
    return report;
  }

  async auditTenant(tenantId: string): Promise<string[]> {
    const wallet = await this.prisma.base.wallet.findUnique({ where: { tenantId } });
    if (!wallet) return ['missing-wallet'];
    const reservations = await this.prisma.base.pointReservation.findMany({ where: { tenantId } });
    const logs = await this.prisma.base.pointLog.findMany({ where: { tenantId } });
    const issues: string[] = [];
    const openHold = reservations
      .filter((reservation) => reservation.status === 'OPEN' && !reservation.shadow)
      .reduce(
        (sum, reservation) =>
          sum + (reservation.frozen - reservation.settled - reservation.released),
        0,
      );
    if (wallet.pointsReserved !== openHold) issues.push('reserved-drift');
    if (wallet.points < 0 || wallet.pointsReserved < 0 || wallet.points < wallet.pointsReserved) {
      issues.push('negative-wallet');
    }
    const shadowById = new Map(
      reservations.map((reservation) => [reservation.id, reservation.shadow]),
    );
    for (const reservation of reservations) {
      if (
        reservation.settled < 0 ||
        reservation.released < 0 ||
        reservation.settled + reservation.released > reservation.frozen
      ) {
        issues.push('reservation-bounds');
      }
      const owned = logs.filter((log) => log.reservationId === reservation.id);
      const settled = owned
        .filter((log) => log.status === 'SETTLED')
        .reduce((sum, log) => sum + log.listPrice, 0);
      const released = owned
        .filter((log) => log.status === 'RELEASED')
        .reduce((sum, log) => sum + log.listPrice, 0);
      if (settled !== reservation.settled) issues.push('reservation-log-settled');
      if (released !== reservation.released) issues.push('reservation-log-released');
    }
    for (const log of logs) {
      const shadow = log.reservationId ? shadowById.get(log.reservationId) === true : false;
      if (shadow && log.delta !== 0) issues.push('shadow-delta');
      if (log.status === 'RELEASED' && log.delta !== 0) issues.push('release-delta');
      if (
        log.status === 'SETTLED' &&
        !shadow &&
        log.action !== 'admin_topup' &&
        log.delta !== -log.listPrice
      ) {
        issues.push('strict-delta');
      }
    }
    return [...new Set(issues)];
  }

  async ledgerSnapshot(tenantId: string, openingPoints: number): Promise<LedgerSnapshot> {
    const wallet = await this.prisma.base.wallet.findUniqueOrThrow({ where: { tenantId } });
    const reservations = await this.prisma.base.pointReservation.findMany({ where: { tenantId } });
    const logs = await this.prisma.base.pointLog.findMany({ where: { tenantId } });
    const shadowById = new Map(
      reservations.map((reservation) => [reservation.id, reservation.shadow]),
    );
    return {
      openingPoints,
      points: wallet.points,
      pointsReserved: wallet.pointsReserved,
      reservations: reservations.map((reservation) => ({
        id: reservation.id,
        shadow: reservation.shadow,
        status: reservation.status,
        frozen: reservation.frozen,
        settled: reservation.settled,
        released: reservation.released,
      })),
      entries: logs.map((log) => ({
        reservationId: log.reservationId,
        action: log.action,
        delta: log.delta,
        listPrice: log.listPrice,
        status: log.status,
        shadow: log.reservationId ? shadowById.get(log.reservationId) === true : false,
      })),
    };
  }

  assertSnapshot(snapshot: LedgerSnapshot): void {
    const verdict = evaluateLedger(snapshot);
    if (!verdict.ok) {
      throw new Error(`ledger invariant failed: ${verdict.issues.join(',')}`);
    }
  }

  private async reserveIn(
    tx: BillingTx,
    input: { tenantId: string; refType: ReservationRefType; refId: string; amount: number },
  ): Promise<ReservationView> {
    const wallet = await lockWallet(tx, input.tenantId);
    const existing = await tx.pointReservation.findUnique({
      where: { refType_refId: { refType: input.refType, refId: input.refId } },
    });
    if (existing) return this.sameReserve(existing, input);
    const tenant = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: { billingMode: true },
    });
    if (!tenant) throw notFound('账号不存在');
    const resolved = resolveTenantBillingMode(tenant.billingMode, this.options.globalMode());
    if (!resolved.shadow) {
      const available = wallet.points - wallet.pointsReserved;
      if (available < input.amount) throw insufficient(input.amount, available);
      const updated = await tx.$executeRaw`
        UPDATE "Wallet"
        SET "pointsReserved" = "pointsReserved" + ${input.amount},
            "updatedAt" = ${this.options.now()}
        WHERE "tenantId" = ${input.tenantId}
          AND points - "pointsReserved" >= ${input.amount}
      `;
      if (updated !== 1) throw insufficient(input.amount, available);
    }
    const created = await tx.pointReservation.create({
      data: {
        tenantId: input.tenantId,
        refType: input.refType,
        refId: input.refId,
        shadow: resolved.shadow,
        frozen: input.amount,
      },
    });
    return presentReservation(created);
  }

  private async replayReserve(input: {
    tenantId: string;
    refType: string;
    refId: string;
    amount: number;
  }): Promise<ReservationView> {
    const existing = await this.prisma.base.pointReservation.findUnique({
      where: { refType_refId: { refType: input.refType, refId: input.refId } },
    });
    if (!existing) throw conflict('预扣冲突');
    return this.sameReserve(existing, input);
  }

  private sameReserve(
    existing: {
      id: string;
      tenantId: string;
      refType: string;
      refId: string;
      shadow: boolean;
      frozen: number;
      settled: number;
      released: number;
      status: 'OPEN' | 'CLOSED';
    },
    input: { tenantId: string; refType: string; refId: string; amount: number },
  ): ReservationView {
    if (
      existing.tenantId !== input.tenantId ||
      existing.refType !== input.refType ||
      existing.refId !== input.refId ||
      existing.frozen !== input.amount
    ) {
      throw conflict('预扣已存在，且与本次请求不一致');
    }
    return presentReservation(existing);
  }

  private async settleIn(
    tx: BillingTx,
    input: { tenantId: string; reservationId: string; unitKey: string; lines: ChargeLine[] },
  ): Promise<SettleResult> {
    await lockWallet(tx, input.tenantId);
    const reservation = await lockReservation(tx, input.tenantId, input.reservationId);
    if (!reservation) throw notFound('冻结单不存在');
    const existing = await this.logsForUnit(tx, input.unitKey);
    const matched = this.matchCharge(existing, reservation, input);
    if (matched) {
      return {
        reservation: presentReservation(reservation),
        lines: matched.map(presentLog),
        replayed: true,
      };
    }
    if (reservation.status !== 'OPEN') throw badRequest('冻结单已结单');
    if (existing.some((log) => log.status === 'RELEASED')) throw conflict('该单元已经退还');
    const sum = input.lines.reduce((total, line) => total + line.listPrice, 0);
    if (sum > remainder(reservation)) throw badRequest('结算金额超过剩余冻结');
    const balanceAfter = await this.applySettleWallet(tx, reservation, sum);
    const moved = await tx.$executeRaw`
      UPDATE "PointReservation"
      SET settled = settled + ${sum}
      WHERE id = ${reservation.id}
        AND "tenantId" = ${input.tenantId}
        AND status = 'OPEN'::"ReservationStatus"
        AND settled + released + ${sum} <= frozen
    `;
    if (moved !== 1) throw conflict('结算金额超过剩余冻结');
    const created: StoredLog[] = [];
    for (const line of input.lines) {
      const row = await tx.pointLog.create({
        data: {
          tenantId: input.tenantId,
          reservationId: reservation.id,
          action: line.action,
          title: ledgerTitle(line.title, reservation.shadow),
          unitKey: input.unitKey,
          delta: reservation.shadow ? 0 : -line.listPrice,
          listPrice: line.listPrice,
          detail: line.detail,
          balanceAfter,
          status: 'SETTLED',
        },
      });
      created.push(row);
    }
    const fresh = await lockReservation(tx, input.tenantId, reservation.id);
    if (!fresh) throw notFound('冻结单不存在');
    return {
      reservation: presentReservation(fresh),
      lines: created.map(presentLog),
      replayed: false,
    };
  }

  private async replaySettle(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    lines: ChargeLine[];
  }): Promise<SettleResult> {
    const reservation = await this.readReservation(input.tenantId, input.reservationId);
    if (!reservation) throw notFound('冻结单不存在');
    const existing = await this.prisma.base.pointLog.findMany({
      where: { unitKey: input.unitKey },
    });
    const matched = this.matchCharge(existing, reservation, input);
    if (!matched) throw conflict('幂等记录与本次请求不一致');
    return { reservation, lines: matched.map(presentLog), replayed: true };
  }

  private matchCharge(
    existing: StoredLog[],
    reservation: ReservationView | LockedReservation,
    input: { tenantId: string; lines: ChargeLine[]; unitKey: string },
  ): StoredLog[] | null {
    if (existing.length === 0) return null;
    const wanted = new Map(input.lines.map((line) => [line.action, line]));
    if (existing.length !== wanted.size) throw conflict('幂等记录与本次请求不一致');
    const matched: StoredLog[] = [];
    for (const log of existing) {
      const line = wanted.get(log.action as ChargeAction);
      if (!line) throw conflict('幂等记录与本次请求不一致');
      const expectedDelta = reservation.shadow ? 0 : -line.listPrice;
      if (
        log.tenantId !== input.tenantId ||
        log.reservationId !== reservation.id ||
        log.unitKey !== input.unitKey ||
        log.listPrice !== line.listPrice ||
        log.delta !== expectedDelta ||
        log.status !== 'SETTLED'
      ) {
        throw conflict('幂等记录与本次请求不一致');
      }
      matched.push(log);
    }
    return matched;
  }

  private async releaseIn(
    tx: BillingTx,
    input: {
      tenantId: string;
      reservationId: string;
      unitKey: string;
      amount: number;
      title: string;
    },
  ): Promise<SettleResult> {
    await lockWallet(tx, input.tenantId);
    const reservation = await lockReservation(tx, input.tenantId, input.reservationId);
    if (!reservation) throw notFound('冻结单不存在');
    const existing = await tx.pointLog.findUnique({
      where: { unitKey_action: { unitKey: input.unitKey, action: 'refund' } },
    });
    if (existing) {
      this.sameRelease(existing, reservation, input);
      return {
        reservation: presentReservation(reservation),
        lines: [presentLog(existing)],
        replayed: true,
      };
    }
    const charged = await tx.pointLog.findFirst({
      where: { unitKey: input.unitKey, status: 'SETTLED' },
    });
    if (charged) throw conflict('该单元已经结算，不能再退还');
    if (reservation.status !== 'OPEN') throw badRequest('冻结单已结单');
    if (input.amount > remainder(reservation)) throw badRequest('退还金额超过剩余冻结');
    const balanceAfter = await this.applyReleaseWallet(tx, reservation, input.amount);
    const moved = await tx.$executeRaw`
      UPDATE "PointReservation"
      SET released = released + ${input.amount}
      WHERE id = ${reservation.id}
        AND "tenantId" = ${input.tenantId}
        AND status = 'OPEN'::"ReservationStatus"
        AND settled + released + ${input.amount} <= frozen
    `;
    if (moved !== 1) throw conflict('退还金额超过剩余冻结');
    const row = await tx.pointLog.create({
      data: {
        tenantId: input.tenantId,
        reservationId: reservation.id,
        action: 'refund',
        title: ledgerTitle(input.title, reservation.shadow),
        unitKey: input.unitKey,
        delta: 0,
        listPrice: input.amount,
        balanceAfter,
        status: 'RELEASED',
        detail: { released: input.amount },
      },
    });
    const fresh = await lockReservation(tx, input.tenantId, reservation.id);
    if (!fresh) throw notFound('冻结单不存在');
    return { reservation: presentReservation(fresh), lines: [presentLog(row)], replayed: false };
  }

  private async replayRelease(input: {
    tenantId: string;
    reservationId: string;
    unitKey: string;
    amount: number;
  }): Promise<SettleResult> {
    const reservation = await this.readReservation(input.tenantId, input.reservationId);
    if (!reservation) throw notFound('冻结单不存在');
    const existing = await this.prisma.base.pointLog.findUnique({
      where: { unitKey_action: { unitKey: input.unitKey, action: 'refund' } },
    });
    if (!existing) throw conflict('退还冲突');
    this.sameRelease(existing, reservation, input);
    return { reservation, lines: [presentLog(existing)], replayed: true };
  }

  private sameRelease(
    existing: StoredLog,
    reservation: ReservationView | LockedReservation,
    input: { tenantId: string; amount: number; unitKey: string },
  ): void {
    if (
      existing.tenantId !== input.tenantId ||
      existing.reservationId !== reservation.id ||
      existing.unitKey !== input.unitKey ||
      existing.listPrice !== input.amount ||
      existing.delta !== 0 ||
      existing.status !== 'RELEASED'
    ) {
      throw conflict('幂等记录与本次请求不一致');
    }
  }

  private async closeIn(
    tx: BillingTx,
    tenantId: string,
    reservationId: string,
  ): Promise<{ reservation: ReservationView; releasedNow: number }> {
    await lockWallet(tx, tenantId);
    const reservation = await lockReservation(tx, tenantId, reservationId);
    if (!reservation) throw notFound('冻结单不存在');
    if (reservation.status === 'CLOSED') {
      return { reservation: presentReservation(reservation), releasedNow: 0 };
    }
    const pending = remainder(reservation);
    const now = this.options.now();
    if (pending > 0) {
      const balanceAfter = await this.applyReleaseWallet(tx, reservation, pending);
      let sourceLabel = '';
      if (reservation.refType === 'geo_batch') {
        const batch = await tx.geoBatchJob.findFirst({
          where: { id: reservation.refId, tenantId },
          select: { id: true },
        });
        sourceLabel = batch
          ? `批量GEO写作(${batch.id.slice(-8)})`
          : `批量GEO写作(${reservation.refId.slice(-8)})`;
      } else if (reservation.refType === 'geo_article') {
        const article = await tx.geoArticle.findFirst({
          where: { id: reservation.refId, tenantId },
          select: { title: true },
        });
        sourceLabel = article?.title
          ? `GEO写作-${article.title.slice(0, 18)}`
          : `GEO写作(${reservation.refId.slice(-8)})`;
      } else if (reservation.refType === 'inline_image_gen') {
        sourceLabel = `行内AI配图(${reservation.refId.slice(-8)})`;
      } else if (reservation.refType === 'geo_variant') {
        sourceLabel = `渠道变体改写(${reservation.refId.slice(-8)})`;
      } else if (reservation.refType === 'visibility_run') {
        const run = await tx.visibilityRun.findFirst({
          where: { id: reservation.refId, tenantId },
          select: { name: true },
        });
        sourceLabel = run?.name
          ? `可见度监测-${run.name}`
          : `可见度监测(${reservation.refId.slice(-8)})`;
      } else {
        const freezeLog = await tx.pointLog.findFirst({
          where: { tenantId, reservationId: reservation.id, status: 'RESERVED' },
          orderBy: { createdAt: 'asc' },
          select: { title: true },
        });
        sourceLabel =
          (freezeLog?.title ?? '').replace(/^\[免费体验\]\s*/, '').trim() ||
          `${reservation.refType}(${reservation.refId.slice(-8)})`;
      }
      const baseTitle = sourceLabel ? `释放未完成预扣：${sourceLabel}` : '释放未完成预扣';
      await tx.pointLog.create({
        data: {
          tenantId,
          reservationId: reservation.id,
          action: 'refund',
          title: ledgerTitle(baseTitle, reservation.shadow),
          unitKey: `close:${reservation.id}`,
          delta: 0,
          listPrice: pending,
          balanceAfter,
          status: 'RELEASED',
          detail: {
            released: pending,
            reason: 'close',
            refType: reservation.refType,
            refId: reservation.refId,
            sourceLabel,
          },
        },
      });
    }
    const closed = await tx.pointReservation.updateMany({
      where: { id: reservation.id, tenantId, status: 'OPEN' },
      data: {
        released: { increment: pending },
        status: 'CLOSED',
        closedAt: now,
      },
    });
    if (closed.count !== 1) throw conflict('冻结单已结单');
    const fresh = await lockReservation(tx, tenantId, reservation.id);
    if (!fresh) throw notFound('冻结单不存在');
    return { reservation: presentReservation(fresh), releasedNow: pending };
  }

  private async adjustIn(
    tx: BillingTx,
    input: {
      actorUserId: string;
      tenantId: string;
      delta: number;
      idempotencyKey: string;
      remark: string;
    },
  ): Promise<LedgerLineView> {
    const wallet = await lockWallet(tx, input.tenantId);
    const existing = await tx.pointLog.findUnique({
      where: { unitKey_action: { unitKey: input.idempotencyKey, action: 'admin_topup' } },
    });
    if (existing) {
      if (existing.tenantId !== input.tenantId || existing.delta !== input.delta) {
        throw conflict('幂等记录与本次请求不一致');
      }
      return presentLog(existing);
    }
    const next = wallet.points + input.delta;
    if (next > 1_000_000_000) throw badRequest('调整后点数超出上限');
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET points = points + ${input.delta},
          "updatedAt" = ${this.options.now()}
      WHERE "tenantId" = ${input.tenantId}
        AND points + ${input.delta} >= "pointsReserved"
        AND points + ${input.delta} >= 0
        AND points + ${input.delta} <= ${1_000_000_000}
    `;
    if (updated !== 1) throw badRequest('扣点后不能低于已冻结点数');
    const title = input.delta > 0 ? '管理员充值' : '管理员扣点';
    const row = await tx.pointLog.create({
      data: {
        tenantId: input.tenantId,
        action: 'admin_topup',
        title,
        unitKey: input.idempotencyKey,
        delta: input.delta,
        listPrice: Math.abs(input.delta),
        balanceAfter: next,
        status: 'SETTLED',
        detail: input.remark.length > 0 ? { remark: input.remark } : undefined,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.actorUserId,
        action: 'admin_topup',
        payload: { delta: input.delta, idempotencyKey: input.idempotencyKey, balanceAfter: next },
      },
    });
    return presentLog(row);
  }

  private async applySettleWallet(
    tx: BillingTx,
    reservation: LockedReservation,
    amount: number,
  ): Promise<number> {
    if (reservation.shadow) {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { tenantId: reservation.tenantId },
      });
      return wallet.points;
    }
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET points = points - ${amount},
          "pointsReserved" = "pointsReserved" - ${amount},
          "updatedAt" = ${this.options.now()}
      WHERE "tenantId" = ${reservation.tenantId}
        AND points >= ${amount}
        AND "pointsReserved" >= ${amount}
    `;
    if (updated !== 1) throw new ApiError(500, 50000, '账本结算失败');
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { tenantId: reservation.tenantId } });
    return wallet.points;
  }

  private async applyReleaseWallet(
    tx: BillingTx,
    reservation: LockedReservation,
    amount: number,
  ): Promise<number> {
    if (reservation.shadow) {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { tenantId: reservation.tenantId },
      });
      return wallet.points;
    }
    const updated = await tx.$executeRaw`
      UPDATE "Wallet"
      SET "pointsReserved" = "pointsReserved" - ${amount},
          "updatedAt" = ${this.options.now()}
      WHERE "tenantId" = ${reservation.tenantId}
        AND "pointsReserved" >= ${amount}
    `;
    if (updated !== 1) throw new ApiError(500, 50000, '账本释放失败');
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { tenantId: reservation.tenantId } });
    return wallet.points;
  }

  private async logsForUnit(tx: BillingTx, unitKey: string): Promise<StoredLog[]> {
    return tx.pointLog.findMany({ where: { unitKey } });
  }

  private async findOwnLog(
    tenantId: string,
    unitKey: string,
    action: string,
  ): Promise<StoredLog | null> {
    const row = await this.prisma.base.pointLog.findUnique({
      where: { unitKey_action: { unitKey, action } },
    });
    if (!row) return null;
    if (row.tenantId !== tenantId) throw conflict('幂等记录与本次请求不一致');
    return row;
  }

  private async readReservation(
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationView | null> {
    const row = await this.prisma.base.pointReservation.findFirst({
      where: { id: reservationId, tenantId },
    });
    return row ? presentReservation(row) : null;
  }

  private normalizeLines(lines: ChargeLine[]): ChargeLine[] {
    if (lines.length < 1 || lines.length > 4) throw badRequest('结算明细不正确');
    const seen = new Set<string>();
    let sum = 0;
    const normalized: ChargeLine[] = [];
    for (const line of lines) {
      if (!isChargeAction(line.action)) throw badRequest('结算项目不正确');
      if (!isPositivePoints(line.listPrice)) throw badRequest('结算金额不正确');
      if (seen.has(line.action)) throw badRequest('结算项目重复');
      seen.add(line.action);
      const title = line.title.replace(/[\u0000-\u001f]/g, '').trim();
      if (title.length < 1 || title.length > 80) throw badRequest('结算标题不正确');
      sum += line.listPrice;
      normalized.push({ ...line, title });
    }
    if (!isPositivePoints(sum)) throw badRequest('结算金额不正确');
    return normalized;
  }

  private amount(value: number): number {
    if (!isPositivePoints(value)) throw badRequest('点数不正确');
    return value;
  }

  private transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T> {
    return this.prisma.base.$transaction(fn, TX_OPTIONS);
  }
}

function presentReservation(row: {
  id: string;
  tenantId: string;
  refType: string;
  refId: string;
  shadow: boolean;
  frozen: number;
  settled: number;
  released: number;
  status: 'OPEN' | 'CLOSED';
}): ReservationView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    refType: row.refType,
    refId: row.refId,
    shadow: row.shadow,
    frozen: row.frozen,
    settled: row.settled,
    released: row.released,
    status: row.status,
  };
}

function presentLog(row: {
  id: string;
  action: string;
  title: string;
  unitKey: string;
  delta: number;
  listPrice: number;
  balanceAfter: number | null;
  status: StoredLog['status'];
  detail?: Prisma.JsonValue | null;
  createdAt?: Date;
}): LedgerLineView {
  return {
    id: row.id,
    action: row.action,
    reason: row.action,
    title: row.title,
    unitKey: row.unitKey,
    delta: row.delta,
    listPrice: row.listPrice,
    balanceAfter: row.balanceAfter,
    status: row.status,
    detail: row.detail ?? null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : new Date(0).toISOString(),
  };
}
