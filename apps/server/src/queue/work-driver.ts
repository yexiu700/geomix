import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ItemStatus, TaskStatus } from '@prisma/client';
import {
  API_ERROR,
  finishStatus,
  isQueueName,
  isTerminalRun,
  nextStatus,
  QUEUE_TENANT_LIMIT,
  readQueueConfig,
  runProgress,
  shouldReleaseUnit,
  type CreateRunBody,
  type QueueConfig,
  type QueueName,
  type RunStatus,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS, badRequest, notFound } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_ENQUEUER, type JobEnqueuer } from './job-enqueuer';
import { StepGate } from './step-gate';

export class RetryableStepError extends Error {
  constructor() {
    super('step_retry');
    this.name = 'RetryableStepError';
  }
}

type RunRow = {
  id: string;
  tenantId: string;
  queue: string;
  kind: string;
  refType: string;
  status: TaskStatus;
  taskName: string;
  totalUnits: number;
  unitAiWrite: number;
  unitKbAddon: number;
  withKnowledgeBase: boolean;
  quotaKey: string | null;
};

type UnitRow = {
  id: string;
  seq: number;
  steps: number;
  step: number;
  status: ItemStatus;
  attempts: number;
  failuresRemaining: number;
  outputReady: boolean;
  quotaApplied: boolean;
  settled: boolean;
  released: boolean;
  executionToken: string | null;
  error: string | null;
};

type ClaimRow = {
  id: string;
  seq: number;
  steps: number;
  step: number;
  failuresRemaining: number;
  attempts: number;
  outputReady: boolean;
  settled: boolean;
  released: boolean;
  executionToken: string | null;
};

export type RunView = {
  id: string;
  status: RunStatus;
  queue: string;
  kind: string;
  progress: number;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  taskName: string;
  unitPoints: number;
  knowledgeBase: boolean;
  units: Array<{
    seq: number;
    status: ItemStatus;
    step: number;
    steps: number;
    attempts: number;
    error: string | null;
  }>;
};

const SAFE_ERROR = new Set(['step_failed', 'step_retry', 'cancelled', 'quota']);
const OPEN_RUN = ['QUEUED', 'RUNNING', 'PAUSED'] as const;

/**
 * 驱动任务：每次只领当前租户并发额度内的一个单元。
 * 暂停不再领新单元；终止把还没产出的单元退回冻结。
 * 结算和配额都用单元编号做一次性标记，重复投递不会再扣一次。
 */
@Injectable()
export class WorkDriver {
  private readonly workerId = `w_${randomBytes(4).toString('hex')}`;
  private readonly config: QueueConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(JOB_ENQUEUER) private readonly jobs: JobEnqueuer,
    @Inject(StepGate) private readonly gate: StepGate,
  ) {
    this.config = readQueueConfig(process.env);
  }

  async create(tenantId: string, body: CreateRunBody): Promise<RunView> {
    const taskName = (body.name ?? '队列演练').trim() || '队列演练';
    const prices = await this.billing.listPrices();
    const geoWrite = prices.find((item) => item.action === 'geo_write');
    if (!geoWrite?.enabled) throw badRequest('GEO写作价格未启用');
    const unitAiWrite = geoWrite.unitPoints;
    const unitKbAddon = 0;
    const withKnowledgeBase = false;
    const amount = body.units.length * unitAiWrite;
    if (!Number.isSafeInteger(amount) || amount < 1) throw badRequest('点数不正确');
    await this.quota.assertAvailable(tenantId, 'AI_WRITE', body.units.length);
    const queue: QueueName = 'geo-batch';
    const run = await this.prisma.base.workRun.create({
      data: {
        tenantId,
        queue,
        kind: 'fake',
        refType: 'geo_batch',
        status: 'QUEUED',
        taskName,
        totalUnits: body.units.length,
        unitAiWrite,
        unitKbAddon,
        withKnowledgeBase,
        quotaKey: 'AI_WRITE',
        units: {
          create: body.units.map((unit, index) => ({
            tenantId,
            seq: index + 1,
            steps: unit.steps,
            failuresRemaining: unit.failuresRemaining ?? 0,
          })),
        },
      },
    });
    try {
      await this.billing.reserve({
        tenantId,
        refType: 'geo_batch',
        refId: run.id,
        amount,
      });
      await this.prisma.base.activeWork.create({
        data: {
          refType: 'geo_batch',
          refId: run.id,
          tenantId,
          runId: run.id,
          reason: 'queued',
          beatAt: new Date(),
        },
      });
      await this.jobs.enqueueDriver({ tenantId, runId: run.id, queue });
    } catch (error) {
      await this.rollbackCreate(tenantId, run.id);
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 50000, '队列暂不可用');
    }
    return this.view(tenantId, run.id);
  }

  async view(tenantId: string, runId: string): Promise<RunView> {
    const run = await this.loadRun(tenantId, runId);
    if (!run) throw notFound('不存在');
    const units = await this.unitsOf(tenantId, runId);
    return present(run, units);
  }

  async pause(tenantId: string, runId: string): Promise<RunView> {
    const run = await this.requireRun(tenantId, runId);
    if (!isTerminalRun(run.status)) {
      await this.prisma.base.workRun.updateMany({
        where: { id: run.id, tenantId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        data: { status: nextStatus(run.status, 'pause') },
      });
      await this.touchActive(tenantId, run.id, 'paused');
    }
    return this.view(tenantId, runId);
  }

  async resume(tenantId: string, runId: string): Promise<RunView> {
    const run = await this.requireRun(tenantId, runId);
    if (!isTerminalRun(run.status)) {
      await this.prisma.base.workRun.updateMany({
        where: { id: run.id, tenantId, status: { in: ['PAUSED', 'QUEUED'] } },
        data: { status: 'QUEUED' },
      });
      await this.touchActive(tenantId, run.id, 'queued');
      if (isQueueName(run.queue)) {
        await this.jobs.enqueueDriver({ tenantId, runId: run.id, queue: run.queue });
      }
    }
    return this.view(tenantId, runId);
  }

  async cancel(tenantId: string, runId: string): Promise<RunView> {
    const run = await this.requireRun(tenantId, runId);
    if (!isTerminalRun(run.status)) {
      await this.prisma.base.workRun.updateMany({
        where: { id: run.id, tenantId, status: { in: [...OPEN_RUN] } },
        data: { status: 'CANCELLED' },
      });
    }
    const fresh = await this.requireRun(tenantId, runId);
    if (fresh.status === 'CANCELLED') {
      await this.skipPending(fresh);
      await this.finalize(fresh, true);
    }
    return this.view(tenantId, runId);
  }

  async handle(input: { tenantId: string; runId: string }): Promise<void> {
    const run = await this.loadRun(input.tenantId, input.runId);
    if (!run || !isQueueName(run.queue)) return;
    if (run.status === 'CANCELLED') {
      await this.skipPending(run);
      await this.finalize(run, true);
      return;
    }
    if (isTerminalRun(run.status)) {
      await this.finalize(run, false);
      return;
    }
    if (run.status === 'PAUSED') return;
    const running = await this.markRunning(run);
    if (!running) return;
    for (;;) {
      const fresh = await this.loadRun(run.tenantId, run.id);
      if (!fresh) return;
      if (fresh.status === 'PAUSED') return;
      if (fresh.status === 'CANCELLED') {
        await this.skipPending(fresh);
        await this.finalize(fresh, true);
        return;
      }
      if (isTerminalRun(fresh.status)) return;
      const unit = await this.claim(fresh);
      if (!unit) {
        await this.finalize(fresh, false);
        return;
      }
      try {
        await this.execute(fresh, unit);
      } catch (error) {
        await this.clearToken(fresh.tenantId, unit.id, unit.executionToken);
        throw error;
      }
      await this.refreshCounts(fresh);
      await this.wake(fresh);
    }
  }

  /** 进程重启后，把租约过期或还停在队列里的运行重新投递。 */
  setStepHandler(handler: StepGate['handler'] | null): void {
    this.gate.handler = handler ?? (async () => undefined);
  }

  async recover(): Promise<number> {
    const now = new Date();
    const runs = await this.prisma.base.workRun.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { updatedAt: 'asc' },
      take: 50,
      select: { id: true, tenantId: true, queue: true },
    });
    const seen = new Set<string>();
    let queued = 0;
    for (const run of runs) {
      if (!isQueueName(run.queue) || seen.has(run.id)) continue;
      seen.add(run.id);
      await this.jobs.enqueueDriver({ tenantId: run.tenantId, runId: run.id, queue: run.queue });
      queued += 1;
    }
    const expired = await this.prisma.base.workUnit.findMany({
      where: {
        status: 'RUNNING',
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      take: 50,
      select: { runId: true, tenantId: true },
    });
    for (const unit of expired) {
      if (seen.has(unit.runId)) continue;
      const run = await this.prisma.base.workRun.findFirst({
        where: { id: unit.runId, tenantId: unit.tenantId },
        select: { id: true, tenantId: true, queue: true, status: true },
      });
      if (
        !run ||
        (run.status !== 'QUEUED' && run.status !== 'RUNNING') ||
        !isQueueName(run.queue)
      ) {
        continue;
      }
      seen.add(run.id);
      await this.jobs.enqueueDriver({ tenantId: run.tenantId, runId: run.id, queue: run.queue });
      queued += 1;
    }
    return queued;
  }

  private async execute(run: RunRow, unit: ClaimRow): Promise<void> {
    const token = unit.executionToken;
    if (!token) return;
    const timer = setInterval(() => {
      void this.touch(run, unit.id, token).catch(() => undefined);
    }, this.config.heartbeatMs);
    timer.unref();
    try {
      for (;;) {
        const current = await this.loadUnit(run.tenantId, unit.id);
        if (!current || current.executionToken !== token || current.status !== 'RUNNING') return;
        const parent = await this.loadRun(run.tenantId, run.id);
        if (!parent) return;
        if (parent.status === 'CANCELLED') {
          if (current.step >= current.steps || current.quotaApplied || current.settled) {
            await this.finishSuccess(parent, current);
          } else {
            await this.releaseOpen(parent, current, 'SKIPPED', 'cancelled');
          }
          return;
        }
        if (current.step >= current.steps) {
          await this.finishSuccess(parent, current);
          return;
        }
        if (current.failuresRemaining > 0) {
          const burned = await this.burnFailure(run.tenantId, current, token);
          if (burned) {
            if (current.attempts + 1 >= this.config.unitAttempts) {
              await this.releaseOpen(parent, current, 'FAILED', 'step_failed');
              return;
            }
            throw new RetryableStepError();
          }
        }
        const next = current.step + 1;
        await this.gate.handler({
          runId: run.id,
          unitId: current.id,
          tenantId: run.tenantId,
          step: next,
        });
        const afterGate = await this.loadRun(run.tenantId, run.id);
        const afterUnit = await this.loadUnit(run.tenantId, unit.id);
        if (!afterGate || !afterUnit || afterUnit.executionToken !== token) return;
        if (afterGate.status === 'CANCELLED') {
          await this.releaseOpen(afterGate, afterUnit, 'SKIPPED', 'cancelled');
          return;
        }
        const advanced = await this.prisma.base.workUnit.updateMany({
          where: {
            id: current.id,
            tenantId: run.tenantId,
            status: 'RUNNING',
            step: current.step,
            executionToken: token,
          },
          data: { step: next },
        });
        if (advanced.count !== 1) return;
      }
    } finally {
      clearInterval(timer);
    }
  }

  private async finishSuccess(run: RunRow, unit: UnitRow): Promise<void> {
    if (unit.settled) return;
    const latest = await this.loadUnit(run.tenantId, unit.id);
    if (!latest || latest.settled) return;
    if (run.quotaKey === 'AI_WRITE' && !latest.quotaApplied) {
      try {
        await this.applyQuota(run, latest);
      } catch (error) {
        if (error instanceof ApiError && error.code === API_ERROR.QUOTA_EXCEEDED) {
          await this.releaseOpen(run, latest, 'FAILED', 'quota');
          return;
        }
        throw error;
      }
    }
    const reservation = await this.reservationOf(run);
    await this.billing.settleGeoWriteUnit({
      tenantId: run.tenantId,
      reservationId: reservation.id,
      unitKey: unitKey(latest.id),
      subject: run.taskName,
      geoWritePoints: run.unitAiWrite,
    });
    await this.prisma.base.workUnit.updateMany({
      where: { id: latest.id, tenantId: run.tenantId, settled: false },
      data: {
        status: 'SUCCESS',
        settled: true,
        outputReady: true,
        finishedAt: new Date(),
        executionToken: null,
        leaseOwner: null,
        leaseUntil: null,
        error: null,
      },
    });
  }

  private async applyQuota(run: RunRow, unit: UnitRow): Promise<void> {
    await this.prisma.base.$transaction(async (tx) => {
      const updated = await tx.workUnit.updateMany({
        where: {
          id: unit.id,
          tenantId: run.tenantId,
          quotaApplied: false,
          settled: false,
        },
        data: { quotaApplied: true },
      });
      if (updated.count !== 1) return;
      await this.quota.consume(run.tenantId, 'AI_WRITE', 1, tx);
    }, TX_OPTIONS);
  }

  private async releaseOpen(
    run: RunRow,
    unit: UnitRow,
    status: 'FAILED' | 'SKIPPED',
    error: string,
  ): Promise<void> {
    if (!shouldReleaseUnit(unit) || unit.released) return;
    const current = await this.loadUnit(run.tenantId, unit.id);
    if (!current || current.settled || current.released || current.outputReady) return;
    const reservation = await this.reservationOf(run);
    if (reservation.status === 'OPEN') {
      await this.billing.releaseUnit({
        tenantId: run.tenantId,
        reservationId: reservation.id,
        unitKey: unitKey(current.id),
        amount: run.unitAiWrite,
        title: '退还未完成单元',
      });
    }
    await this.prisma.base.workUnit.updateMany({
      where: {
        id: current.id,
        tenantId: run.tenantId,
        settled: false,
        released: false,
        outputReady: false,
      },
      data: {
        status,
        released: true,
        error,
        finishedAt: new Date(),
        executionToken: null,
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }

  private async skipPending(run: RunRow): Promise<void> {
    const pending = await this.prisma.base.workUnit.findMany({
      where: { runId: run.id, tenantId: run.tenantId, status: 'PENDING' },
      orderBy: { seq: 'asc' },
    });
    for (const unit of pending) {
      await this.releaseOpen(run, unit, 'SKIPPED', 'cancelled');
    }
  }

  private async finalize(run: RunRow, cancelled: boolean): Promise<void> {
    const units = await this.unitsOf(run.tenantId, run.id);
    if (units.some((unit) => unit.status === 'PENDING' || unit.status === 'RUNNING')) return;
    for (const unit of units) {
      if (!unit.settled && !unit.released && shouldReleaseUnit(unit)) {
        const status = unit.status === 'FAILED' ? 'FAILED' : 'SKIPPED';
        await this.releaseOpen(run, unit, status, unit.error ?? 'cancelled');
      }
    }
    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: { tenantId: run.tenantId, refType: run.refType, refId: run.id },
    });
    if (reservation?.status === 'OPEN') {
      await this.billing.close({ tenantId: run.tenantId, reservationId: reservation.id });
    }
    await this.prisma.base.activeWork.deleteMany({
      where: { runId: run.id, tenantId: run.tenantId },
    });
    const fresh = await this.unitsOf(run.tenantId, run.id);
    const done = fresh.filter((unit) => unit.status === 'SUCCESS').length;
    const fail = fresh.filter((unit) => unit.status === 'FAILED').length;
    const skip = fresh.filter((unit) => unit.status === 'SKIPPED').length;
    const status = finishStatus({
      done,
      fail,
      skip,
      cancelled: cancelled || run.status === 'CANCELLED',
    });
    await this.prisma.base.workRun.updateMany({
      where: {
        id: run.id,
        tenantId: run.tenantId,
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED', 'CANCELLED'] },
      },
      data: {
        status,
        doneCount: done,
        failCount: fail,
        skipCount: skip,
        finishedAt: new Date(),
        lastError: fail > 0 ? 'step_failed' : null,
      },
    });
  }

  private async claim(run: RunRow): Promise<ClaimRow | null> {
    if (!isQueueName(run.queue)) return null;
    const limit = QUEUE_TENANT_LIMIT[run.queue];
    // JS Date is an absolute instant. Bind it as timestamptz. A bare timestamp
    // would be read back in the session time zone and a live lease would look expired.
    const now = new Date();
    const until = new Date(now.getTime() + this.config.leaseMs);
    const token = randomBytes(8).toString('hex');
    const lockKey = `${run.tenantId}:${run.queue}`;
    return this.prisma.base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      const own = await takeUnit(
        tx,
        `
          UPDATE "WorkUnit"
          SET "executionToken" = $1, "leaseOwner" = $2, "leaseUntil" = $3::timestamptz
          WHERE id = (
            SELECT id FROM "WorkUnit"
            WHERE "runId" = $4 AND "tenantId" = $5
              AND status = 'RUNNING'::"ItemStatus"
              AND "executionToken" IS NULL
              AND "leaseOwner" = $2
            ORDER BY seq
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING id, seq, steps, step, "failuresRemaining", attempts, "outputReady", settled, released, "executionToken"
        `,
        token,
        this.workerId,
        until,
        run.id,
        run.tenantId,
      );
      if (own) return own;
      const active = await tx.workUnit.count({
        where: {
          tenantId: run.tenantId,
          status: 'RUNNING',
          leaseUntil: { gt: now },
          run: { queue: run.queue },
        },
      });
      if (active >= limit) return null;
      const reclaimed = await takeUnit(
        tx,
        `
          UPDATE "WorkUnit"
          SET "executionToken" = $1, "leaseOwner" = $2, "leaseUntil" = $3::timestamptz
          WHERE id = (
            SELECT id FROM "WorkUnit"
            WHERE "runId" = $4 AND "tenantId" = $5
              AND status = 'RUNNING'::"ItemStatus"
              AND ("leaseUntil" IS NULL OR "leaseUntil" < $6::timestamptz)
            ORDER BY seq
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING id, seq, steps, step, "failuresRemaining", attempts, "outputReady", settled, released, "executionToken"
        `,
        token,
        this.workerId,
        until,
        run.id,
        run.tenantId,
        now,
      );
      if (reclaimed) return reclaimed;
      return takeUnit(
        tx,
        `
          UPDATE "WorkUnit"
          SET status = 'RUNNING'::"ItemStatus",
              "startedAt" = COALESCE("startedAt", $6::timestamptz),
              "executionToken" = $1,
              "leaseOwner" = $2,
              "leaseUntil" = $3::timestamptz
          WHERE id = (
            SELECT id FROM "WorkUnit"
            WHERE "runId" = $4 AND "tenantId" = $5
              AND status = 'PENDING'::"ItemStatus"
            ORDER BY seq
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING id, seq, steps, step, "failuresRemaining", attempts, "outputReady", settled, released, "executionToken"
        `,
        token,
        this.workerId,
        until,
        run.id,
        run.tenantId,
        now,
      );
    }, TX_OPTIONS);
  }

  private async burnFailure(tenantId: string, unit: UnitRow, token: string): Promise<boolean> {
    const updated = await this.prisma.base.workUnit.updateMany({
      where: {
        id: unit.id,
        tenantId,
        status: 'RUNNING',
        executionToken: token,
        step: unit.step,
        failuresRemaining: { gt: 0 },
      },
      data: {
        failuresRemaining: { decrement: 1 },
        attempts: { increment: 1 },
        error: 'step_retry',
      },
    });
    return updated.count === 1;
  }

  private async markRunning(run: RunRow): Promise<boolean> {
    await this.prisma.base.workRun.updateMany({
      where: { id: run.id, tenantId: run.tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'RUNNING' },
    });
    const fresh = await this.loadRun(run.tenantId, run.id);
    if (!fresh || fresh.status !== 'RUNNING') return false;
    await this.touchActive(run.tenantId, run.id, 'running');
    return true;
  }

  private async touch(run: RunRow, unitId: string, token: string): Promise<void> {
    const until = new Date(Date.now() + this.config.leaseMs);
    await this.prisma.base.workUnit.updateMany({
      where: { id: unitId, tenantId: run.tenantId, status: 'RUNNING', executionToken: token },
      data: { leaseUntil: until, leaseOwner: this.workerId },
    });
    await this.touchActive(run.tenantId, run.id, 'running');
  }

  private async touchActive(tenantId: string, runId: string, reason: string): Promise<void> {
    await this.prisma.base.activeWork.updateMany({
      where: { runId, tenantId },
      data: { reason, beatAt: new Date(), workerId: reason === 'running' ? this.workerId : null },
    });
  }

  private async wake(run: RunRow): Promise<void> {
    if (!isQueueName(run.queue)) return;
    const fresh = await this.loadRun(run.tenantId, run.id);
    if (!fresh || fresh.status === 'PAUSED' || isTerminalRun(fresh.status)) return;
    const pending = await this.prisma.base.workUnit.count({
      where: { runId: run.id, tenantId: run.tenantId, status: 'PENDING' },
    });
    if (pending < 1) return;
    await this.jobs.enqueueDriver({ tenantId: run.tenantId, runId: run.id, queue: run.queue });
  }

  private async refreshCounts(run: RunRow): Promise<void> {
    const units = await this.unitsOf(run.tenantId, run.id);
    await this.prisma.base.workRun.updateMany({
      where: { id: run.id, tenantId: run.tenantId },
      data: {
        doneCount: units.filter((unit) => unit.status === 'SUCCESS').length,
        failCount: units.filter((unit) => unit.status === 'FAILED').length,
        skipCount: units.filter((unit) => unit.status === 'SKIPPED').length,
      },
    });
  }

  private async clearToken(tenantId: string, unitId: string, token: string | null): Promise<void> {
    if (!token) return;
    await this.prisma.base.workUnit.updateMany({
      where: { id: unitId, tenantId, executionToken: token, status: 'RUNNING' },
      data: { executionToken: null },
    });
  }

  private async rollbackCreate(tenantId: string, runId: string): Promise<void> {
    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: { tenantId, refType: 'geo_batch', refId: runId },
    });
    if (reservation?.status === 'OPEN') {
      await this.billing.close({ tenantId, reservationId: reservation.id });
    }
    await this.prisma.base.workRun.deleteMany({ where: { id: runId, tenantId } });
  }

  private async reservationOf(run: RunRow): Promise<{ id: string; status: 'OPEN' | 'CLOSED' }> {
    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: { tenantId: run.tenantId, refType: run.refType, refId: run.id },
      select: { id: true, status: true },
    });
    if (!reservation) throw notFound('冻结单不存在');
    return reservation;
  }

  private async requireRun(tenantId: string, runId: string): Promise<RunRow> {
    const run = await this.loadRun(tenantId, runId);
    if (!run) throw notFound('不存在');
    return run;
  }

  private async loadRun(tenantId: string, runId: string): Promise<RunRow | null> {
    return this.prisma.base.workRun.findFirst({
      where: { id: runId, tenantId },
      select: {
        id: true,
        tenantId: true,
        queue: true,
        kind: true,
        refType: true,
        status: true,
        taskName: true,
        totalUnits: true,
        unitAiWrite: true,
        unitKbAddon: true,
        withKnowledgeBase: true,
        quotaKey: true,
      },
    });
  }

  private async loadUnit(tenantId: string, unitId: string): Promise<UnitRow | null> {
    return this.prisma.base.workUnit.findFirst({
      where: { id: unitId, tenantId },
      select: unitSelect,
    });
  }

  private async unitsOf(tenantId: string, runId: string): Promise<UnitRow[]> {
    return this.prisma.base.workUnit.findMany({
      where: { runId, tenantId },
      orderBy: { seq: 'asc' },
      select: unitSelect,
    });
  }
}

const unitSelect = {
  id: true,
  seq: true,
  steps: true,
  step: true,
  status: true,
  attempts: true,
  failuresRemaining: true,
  outputReady: true,
  quotaApplied: true,
  settled: true,
  released: true,
  executionToken: true,
  error: true,
} as const;

function present(run: RunRow, units: UnitRow[]): RunView {
  const done = units.filter((unit) => unit.status === 'SUCCESS').length;
  const failed = units.filter((unit) => unit.status === 'FAILED').length;
  const skipped = units.filter((unit) => unit.status === 'SKIPPED').length;
  const running = units.filter((unit) => unit.status === 'RUNNING').length;
  const active = units.find((unit) => unit.status === 'RUNNING');
  const progress = isTerminalRun(run.status)
    ? 100
    : runProgress({
        total: run.totalUnits,
        done,
        fail: failed,
        skip: skipped,
        active: active ? { step: active.step, steps: active.steps } : undefined,
      });
  return {
    id: run.id,
    status: run.status,
    queue: run.queue,
    kind: run.kind,
    progress,
    total: run.totalUnits,
    done,
    failed,
    skipped,
    running,
    taskName: run.taskName,
    unitPoints: run.unitAiWrite + run.unitKbAddon,
    knowledgeBase: run.withKnowledgeBase,
    units: units.map((unit) => ({
      seq: unit.seq,
      status: unit.status,
      step: unit.step,
      steps: unit.steps,
      attempts: unit.attempts,
      error: unit.error && SAFE_ERROR.has(unit.error) ? unit.error : null,
    })),
  };
}

function unitKey(unitId: string): string {
  return `ai_task_item:${unitId}`;
}

async function takeUnit(
  tx: { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> },
  sql: string,
  token: string,
  workerId: string,
  until: Date,
  runId: string,
  tenantId: string,
  extra?: Date,
): Promise<ClaimRow | null> {
  const values: unknown[] = [token, workerId, until, runId, tenantId];
  if (extra) values.push(extra);
  const rows = await tx.$queryRawUnsafe<ClaimRow[]>(sql, ...values);
  return rows[0] ?? null;
}
