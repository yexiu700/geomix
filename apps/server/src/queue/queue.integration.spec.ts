import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, hashPassword } from '@geomix/db';
import { PRICING_DEFAULTS, QUEUE_NAMES, evaluateLedger, type BillingMode } from '@geomix/shared';
import { QueueEvents } from 'bullmq';
import { createApiApp } from '../common/create-api-app';
import { WorkerModule } from '../worker.module';
import { PrismaService } from '../prisma/prisma.service';
import { CaptchaService } from '../auth/captcha.service';
import { BillingService } from '../billing/billing.service';
import { MaintenanceRunner } from './maintenance.runner';
import { QueueProducer } from './queue.producer';
import { QueueRuntime } from './queue.runtime';
import { StepGate } from './step-gate';
import { RetryableStepError, WorkDriver } from './work-driver';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const adminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

describe.skipIf(
  process.env.GEOMIX_DB_INTEGRATION !== '1' || process.env.GEOMIX_REDIS_INTEGRATION !== '1',
)('queue against isolated Postgres and local Redis', () => {
  const suffix = randomBytes(4).toString('hex');
  const dbName = `geomix_queue_${suffix}`;
  const prefix = `geomix:q:${suffix}`;
  let isolatedUrl = '';
  let previous: Record<string, string | undefined> = {};
  let servicePrisma!: PrismaService;
  let app: INestApplication | undefined;
  let workerApp: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let baseUrl = '';
  let captcha: CaptchaService | undefined;
  let apiDriver!: WorkDriver;
  let workerDriver!: WorkDriver;
  let billing!: BillingService;
  let producer!: QueueProducer;
  let runtime!: QueueRuntime;
  let gate!: StepGate;
  let maintenance!: MaintenanceRunner;
  const password = 'queue-pass-1';
  const hold = {
    enabled: false,
    entered: [] as Array<{ runId: string; step: number }>,
    release: [] as Array<() => void>,
  };

  beforeAll(async () => {
    assertDbName(dbName);
    adminSql(adminUrl, `CREATE DATABASE "${dbName}"`);
    isolatedUrl = databaseUrl(adminUrl, dbName);
    const setup = createPrismaClient(isolatedUrl);
    await setup.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await setup.$disconnect();
    const migrated = spawnSync('node', ['scripts/prisma-cli.mjs', 'migrate', 'deploy'], {
      cwd: dbPackageRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: isolatedUrl },
    });
    expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(0);

    previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      BILLING_MODE: process.env.BILLING_MODE,
      QUEUE_PREFIX: process.env.QUEUE_PREFIX,
      QUEUE_BACKOFF_MS: process.env.QUEUE_BACKOFF_MS,
      QUEUE_HEARTBEAT_MS: process.env.QUEUE_HEARTBEAT_MS,
      QUEUE_HEARTBEAT_TTL_MS: process.env.QUEUE_HEARTBEAT_TTL_MS,
      QUEUE_LEASE_MS: process.env.QUEUE_LEASE_MS,
      QUEUE_RECOVER_MS: process.env.QUEUE_RECOVER_MS,
      LLM_PROVIDERS: process.env.LLM_PROVIDERS,
    };
    process.env.DATABASE_URL = isolatedUrl;
    process.env.BILLING_MODE = 'SHADOW';
    process.env.QUEUE_PREFIX = prefix;
    process.env.QUEUE_BACKOFF_MS = '20';
    process.env.QUEUE_HEARTBEAT_MS = '200';
    process.env.QUEUE_HEARTBEAT_TTL_MS = '5000';
    process.env.QUEUE_LEASE_MS = '30000';
    process.env.QUEUE_RECOVER_MS = '600000';
    process.env.LLM_PROVIDERS = '{}';

    servicePrisma = new PrismaService();
    for (const item of PRICING_DEFAULTS) {
      await servicePrisma.base.pricingItem.create({
        data: { action: item.action, unitPoints: item.unitPoints, enabled: true },
      });
    }

    app = await createApiApp();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    captcha = app.get(CaptchaService);
    apiDriver = app.get(WorkDriver);
    billing = app.get(BillingService);
    producer = app.get(QueueProducer);

    workerApp = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    workerApp.enableShutdownHooks();
    workerDriver = workerApp.get(WorkDriver);
    runtime = workerApp.get(QueueRuntime);
    gate = workerApp.get(StepGate);
    maintenance = workerApp.get(MaintenanceRunner);
    gate.handler = async (context) => {
      hold.entered.push({ runId: context.runId, step: context.step });
      if (!hold.enabled) return;
      await new Promise<void>((resolve) => hold.release.push(resolve));
    };
    await runtime.stop();
  }, 120_000);

  afterAll(async () => {
    releaseHold();
    if (runtime) await runtime.stop().catch(() => undefined);
    if (workerApp) await workerApp.close();
    if (app) await app.close();
    if (servicePrisma) await servicePrisma.onModuleDestroy();
    restoreEnv(previous);
    await wipeRedis(prefix);
    adminSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }, 60_000);

  it('charges a successful unit once when the same driver runs twice', async () => {
    const tenantId = await makeTenant(`strict_${suffix}`, 200, 'STRICT');
    const created = await apiDriver.create(tenantId, { units: [{ steps: 2 }] });
    await Promise.all([
      apiDriver.handle({ tenantId, runId: created.id }),
      apiDriver.handle({ tenantId, runId: created.id }),
    ]);
    const view = await apiDriver.view(tenantId, created.id);
    expect(view.status).toBe('COMPLETED');
    expect(view.progress).toBe(100);
    expect(view.done).toBe(1);
    expect(view.units[0]?.attempts).toBe(0);
    await apiDriver.handle({ tenantId, runId: created.id });
    await expectCharge(tenantId, 200, 10, 1);
  }, 30_000);

  it('keeps shadow wallets unchanged and still counts the writing quota once', async () => {
    const tenantId = await makeTenant(`shadow_${suffix}`, 80, 'SHADOW');
    const created = await apiDriver.create(tenantId, {
      name: '影子演练',
      knowledgeBase: true,
      units: [{ steps: 1 }],
    });
    await apiDriver.handle({ tenantId, runId: created.id });
    const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId } });
    expect(wallet.points).toBe(80);
    expect(wallet.pointsReserved).toBe(0);
    const logs = await servicePrisma.base.pointLog.findMany({
      where: { tenantId, status: 'SETTLED' },
      orderBy: { action: 'asc' },
    });
    expect(logs.map((log) => [log.action, log.delta, log.listPrice])).toEqual([
      ['ai_write', 0, 10],
      ['kb_addon', 0, 5],
    ]);
    expect(logs.every((log) => log.title.endsWith('（免费期）'))).toBe(true);
    await expectQuota(tenantId, 1);
    const snapshot = await billing.ledgerSnapshot(tenantId, 80);
    expect(evaluateLedger(snapshot).ok).toBe(true);
  }, 30_000);

  it('releases a failed unit and does not consume quota', async () => {
    const tenantId = await makeTenant(`fail_${suffix}`, 50, 'STRICT');
    const created = await apiDriver.create(tenantId, {
      units: [{ steps: 2, failuresRemaining: 5 }],
    });
    await driveUntilSettled(apiDriver, tenantId, created.id);
    const view = await apiDriver.view(tenantId, created.id);
    expect(view.status).toBe('FAILED');
    expect(view.failed).toBe(1);
    expect(view.units[0]?.error).toBe('step_failed');
    expect(view.units[0]?.step).toBe(0);
    await expectCharge(tenantId, 50, 0, 0);
    const released = await servicePrisma.base.pointLog.findMany({
      where: { tenantId, status: 'RELEASED' },
    });
    expect(released.reduce((sum, log) => sum + log.listPrice, 0)).toBe(10);
  }, 30_000);

  it('settles the successful unit and releases the failed one', async () => {
    const tenantId = await makeTenant(`partial_${suffix}`, 40, 'STRICT');
    const created = await apiDriver.create(tenantId, {
      units: [{ steps: 1 }, { steps: 1, failuresRemaining: 5 }],
    });
    await driveUntilSettled(apiDriver, tenantId, created.id);
    const view = await apiDriver.view(tenantId, created.id);
    expect(view.status).toBe('PARTIAL');
    expect(view.done).toBe(1);
    expect(view.failed).toBe(1);
    await expectCharge(tenantId, 40, 10, 1);
    const reservation = await servicePrisma.base.pointReservation.findFirstOrThrow({
      where: { tenantId, refId: created.id },
    });
    expect(reservation.status).toBe('CLOSED');
    expect(reservation.settled).toBe(10);
    expect(reservation.released).toBe(10);
  }, 30_000);

  it('does not run later steps after cancel and releases the freeze', async () => {
    const tenantId = await makeTenant(`cancel_${suffix}`, 30, 'STRICT');
    const created = await apiDriver.create(tenantId, { units: [{ steps: 3 }, { steps: 2 }] });
    let steps = 0;
    let releaseStep: (() => void) | undefined;
    const stopAt = new Promise<void>((resolve) => {
      apiDriver.setStepHandler(async (context) => {
        steps += 1;
        if (context.step === 1) {
          resolve();
          await new Promise<void>((holdOn) => {
            releaseStep = holdOn;
          });
        }
      });
    });
    const running = apiDriver.handle({ tenantId, runId: created.id });
    await stopAt;
    await apiDriver.cancel(tenantId, created.id);
    releaseStep?.();
    await running;
    apiDriver.setStepHandler(null);
    const view = await apiDriver.view(tenantId, created.id);
    expect(view.status).toBe('CANCELLED');
    expect(steps).toBe(1);
    expect(view.done).toBe(0);
    expect(view.skipped).toBe(2);
    await expectCharge(tenantId, 30, 0, 0);
    const again = await apiDriver.cancel(tenantId, created.id);
    expect(again.status).toBe('CANCELLED');
    await expectCharge(tenantId, 30, 0, 0);
  }, 30_000);

  it('pauses before the next unit and resumes the rest', async () => {
    const tenantId = await makeTenant(`pause_${suffix}`, 60, 'STRICT');
    const created = await apiDriver.create(tenantId, {
      units: [{ steps: 1 }, { steps: 1 }, { steps: 1 }],
    });
    let release: (() => void) | undefined;
    let seen = 0;
    apiDriver.setStepHandler(async () => {
      seen += 1;
      if (seen === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const running = apiDriver.handle({ tenantId, runId: created.id });
    await waitFor(async () => seen >= 1);
    const paused = await apiDriver.pause(tenantId, created.id);
    expect(paused.status).toBe('PAUSED');
    release?.();
    await running;
    const mid = await apiDriver.view(tenantId, created.id);
    expect(mid.status).toBe('PAUSED');
    expect(mid.done).toBe(1);
    expect(mid.units.filter((unit) => unit.status === 'PENDING')).toHaveLength(2);
    const resumed = await apiDriver.resume(tenantId, created.id);
    expect(resumed.status).toBe('QUEUED');
    await apiDriver.handle({ tenantId, runId: created.id });
    const done = await apiDriver.view(tenantId, created.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.done).toBe(3);
    await expectCharge(tenantId, 60, 30, 3);
    const repeat = await apiDriver.pause(tenantId, created.id);
    expect(repeat.status).toBe('COMPLETED');
    await expectCharge(tenantId, 60, 30, 3);
    apiDriver.setStepHandler(null);
  }, 30_000);

  it('resumes an expired lease without charging twice', async () => {
    const tenantId = await makeTenant(`lease_${suffix}`, 40, 'STRICT');
    const created = await apiDriver.create(tenantId, { units: [{ steps: 2 }] });
    await servicePrisma.base.workUnit.updateMany({
      where: { runId: created.id, tenantId },
      data: {
        status: 'RUNNING',
        step: 1,
        leaseOwner: 'gone',
        leaseUntil: new Date(Date.now() - 60_000),
        executionToken: null,
        startedAt: new Date(),
      },
    });
    const recovered = await apiDriver.recover();
    expect(recovered).toBeGreaterThan(0);
    await apiDriver.handle({ tenantId, runId: created.id });
    const view = await apiDriver.view(tenantId, created.id);
    expect(view.status).toBe('COMPLETED');
    expect(view.units[0]?.step).toBe(2);
    await expectCharge(tenantId, 40, 10, 1);
  }, 30_000);

  it('keeps a heartbeating run and releases a stale one during reconciliation', async () => {
    const liveId = await makeTenant(`live_${suffix}`, 50, 'STRICT');
    const staleId = await makeTenant(`stale_${suffix}`, 50, 'STRICT');
    const live = await apiDriver.create(liveId, { units: [{ steps: 1 }] });
    const stale = await apiDriver.create(staleId, { units: [{ steps: 1 }, { steps: 1 }] });
    await servicePrisma.base.pointReservation.updateMany({
      where: { refId: { in: [live.id, stale.id] } },
      data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    await servicePrisma.base.activeWork.updateMany({
      where: { runId: live.id },
      data: { reason: 'running', beatAt: new Date(), workerId: 'live' },
    });
    const protectedReport = await billing.reconcileOrphans(new Date());
    expect(protectedReport.skippedActive).toBeGreaterThanOrEqual(1);
    const liveHold = await servicePrisma.base.pointReservation.findFirstOrThrow({
      where: { tenantId: liveId, refId: live.id },
    });
    expect(liveHold.status).toBe('OPEN');

    await apiDriver.pause(staleId, stale.id);
    const pausedReport = await billing.reconcileOrphans(new Date());
    expect(pausedReport.closed).toBe(0);
    await servicePrisma.base.activeWork.updateMany({
      where: { runId: stale.id },
      data: { reason: 'running', beatAt: new Date(Date.now() - 10 * 60 * 1000), workerId: 'stale' },
    });
    const released = await billing.reconcileOrphans(new Date());
    expect(released.closed).toBeGreaterThanOrEqual(1);
    const staleHold = await servicePrisma.base.pointReservation.findFirstOrThrow({
      where: { tenantId: staleId, refId: stale.id },
    });
    expect(staleHold.status).toBe('CLOSED');
    expect(staleHold.released).toBe(20);
    const staleWallet = await servicePrisma.base.wallet.findUniqueOrThrow({
      where: { tenantId: staleId },
    });
    expect(staleWallet.points).toBe(50);
    expect(staleWallet.pointsReserved).toBe(0);
    const second = await billing.reconcileOrphans(new Date());
    expect(second.closed).toBe(0);
    await apiDriver.cancel(liveId, live.id);
    await apiDriver.cancel(staleId, stale.id);
  }, 30_000);

  it('hides other tenants and serves pause, retry, and shutdown through Redis', async () => {
    if (!captcha) throw new Error('api was not started');
    const ownerId = await makeTenant(`owner_${suffix}`, 100, 'STRICT');
    const otherId = await makeTenant(`other_${suffix}`, 100, 'STRICT');
    const adminId = await makeTenant(`admin_${suffix}`, 10, 'SHADOW');
    const hash = hashPassword(password);
    await servicePrisma.base.user.createMany({
      data: [
        {
          id: `user_${ownerId}`,
          tenantId: ownerId,
          username: `owner_${suffix}`,
          passwordHash: hash,
          role: 'MERCHANT',
        },
        {
          id: `user_${otherId}`,
          tenantId: otherId,
          username: `other_${suffix}`,
          passwordHash: hash,
          role: 'MERCHANT',
        },
        {
          id: `user_${adminId}`,
          tenantId: adminId,
          username: `admin_${suffix}`,
          passwordHash: hash,
          role: 'ADMIN',
        },
      ],
    });
    const owner = await login(captcha, baseUrl, `owner_${suffix}`, password);
    const other = await login(captcha, baseUrl, `other_${suffix}`, password);
    const admin = await login(captcha, baseUrl, `admin_${suffix}`, password);

    await drain(producer);
    hold.enabled = true;
    hold.entered = [];
    await runtime.start();

    const created = await call<{ id: string; status: string }>(
      baseUrl,
      'POST',
      '/api/v1/queue/runs',
      {
        token: owner.accessToken,
        body: { units: [{ steps: 3 }, { steps: 1 }, { steps: 1 }, { steps: 1 }] },
      },
    );
    expect(created.status).toBe(200);
    const runId = created.data.id;
    await waitFor(async () => hold.entered.some((entry) => entry.runId === runId));
    const runningNow = await servicePrisma.base.workUnit.count({
      where: { runId, tenantId: ownerId, status: 'RUNNING' },
    });
    expect(runningNow).toBeLessThanOrEqual(2);
    expect(runningNow).toBeGreaterThan(0);

    const hidden = await call(baseUrl, 'GET', `/api/v1/queue/runs/${runId}`, {
      token: other.accessToken,
    });
    expect(hidden.status).toBe(404);
    await workerDriver.handle({ tenantId: otherId, runId });
    const stillOwner = await servicePrisma.base.workRun.findFirstOrThrow({
      where: { id: runId, tenantId: ownerId },
    });
    expect(stillOwner.tenantId).toBe(ownerId);

    const progress = await call<{ progress: number; status: string; units: unknown[] }>(
      baseUrl,
      'GET',
      `/api/v1/queue/runs/${runId}`,
      { token: owner.accessToken },
    );
    expect(progress.status).toBe(200);
    expect(JSON.stringify(progress.data)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(progress.data).toLowerCase()).not.toContain('chunk');

    const boardDenied = await call(baseUrl, 'GET', '/api/v1/admin/queues/board', {
      token: owner.accessToken,
    });
    expect(boardDenied.status).toBe(404);
    const summaryDenied = await call(baseUrl, 'GET', '/api/v1/admin/queues', {
      token: other.accessToken,
    });
    expect(summaryDenied.status).toBe(404);
    const summary = await call<{ upstream: string; queues: Array<{ name: string }> }>(
      baseUrl,
      'GET',
      '/api/v1/admin/queues',
      { token: admin.accessToken },
    );
    expect(summary.status).toBe(200);
    expect(summary.data.upstream).toBe('disabled');
    expect(summary.data.queues.map((queue) => queue.name).sort()).toEqual([...QUEUE_NAMES].sort());
    const board = await fetch(`${baseUrl}/api/v1/admin/queues/board`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(board.status).toBe(200);

    const paused = await call<{ status: string }>(
      baseUrl,
      'POST',
      `/api/v1/queue/runs/${runId}/pause`,
      { token: owner.accessToken },
    );
    expect(paused.data.status).toBe('PAUSED');
    releaseHold();
    await waitFor(async () => {
      const view = await apiDriver.view(ownerId, runId);
      return view.running === 0;
    });
    const mid = await apiDriver.view(ownerId, runId);
    expect(mid.done).toBeGreaterThan(0);
    expect(mid.done).toBeLessThan(4);
    const resumed = await call<{ status: string }>(
      baseUrl,
      'POST',
      `/api/v1/queue/runs/${runId}/resume`,
      { token: owner.accessToken },
    );
    expect(resumed.status).toBe(200);
    await waitFor(async () => (await apiDriver.view(ownerId, runId)).status === 'COMPLETED');
    await expectCharge(ownerId, 100, 40, 4);
    const otherWallet = await servicePrisma.base.wallet.findUniqueOrThrow({
      where: { tenantId: otherId },
    });
    expect(otherWallet.points).toBe(100);
    expect(otherWallet.pointsReserved).toBe(0);

    const retryRun = await call<{ id: string }>(baseUrl, 'POST', '/api/v1/queue/runs', {
      token: owner.accessToken,
      body: { units: [{ steps: 1, failuresRemaining: 1 }] },
    });
    await waitFor(
      async () => (await apiDriver.view(ownerId, retryRun.data.id)).status === 'COMPLETED',
    );
    const retried = await apiDriver.view(ownerId, retryRun.data.id);
    expect(retried.units[0]?.attempts).toBeGreaterThanOrEqual(1);
    await expectCharge(ownerId, 100, 50, 5);

    expect(await maintenance.run('retention')).toBe('retention-skipped');
    expect(await maintenance.run('orphan-files')).toBe('orphan-files-skipped');
    const maintenanceQueue = await producer.open('maintenance');
    const events = new QueueEvents('maintenance', {
      connection: producer.duplicate(),
      prefix,
    });
    const job = await maintenanceQueue.add('reconcile', { kind: 'reconcile' });
    await job.waitUntilFinished(events, 10_000);
    await events.close();

    hold.enabled = true;
    const slow = await call<{ id: string }>(baseUrl, 'POST', '/api/v1/queue/runs', {
      token: owner.accessToken,
      body: { units: [{ steps: 1 }] },
    });
    await waitFor(async () => hold.entered.some((entry) => entry.runId === slow.data.id));
    const stopping = runtime.stop();
    releaseHold();
    await stopping;
    await waitFor(async () => (await apiDriver.view(ownerId, slow.data.id)).status === 'COMPLETED');
    await expectCharge(ownerId, 100, 60, 6);
    const finalSnapshot = await billing.ledgerSnapshot(ownerId, 100);
    expect(evaluateLedger(finalSnapshot).ok).toBe(true);
  }, 60_000);

  async function makeTenant(id: string, points: number, mode: BillingMode): Promise<string> {
    await servicePrisma.base.tenant.create({
      data: { id, name: id, billingMode: mode, expiresAt: new Date('2027-11-16T00:00:00.000Z') },
    });
    await servicePrisma.base.wallet.create({
      data: { tenantId: id, points, pointsReserved: 0, money: 0 },
    });
    await servicePrisma.base.quota.createMany({
      data: [
        { tenantId: id, key: 'MAIN_KEYWORD', limit: 100n, used: 0n },
        { tenantId: id, key: 'QUESTION', limit: 10_000n, used: 0n },
        { tenantId: id, key: 'AI_WRITE', limit: 10_000n, used: 0n },
        { tenantId: id, key: 'STORAGE_BYTES', limit: 104_857_600n, used: 0n },
        { tenantId: id, key: 'PUBLISH', limit: 10_000n, used: 0n },
        { tenantId: id, key: 'SOCIAL_AUTH', limit: 100n, used: 0n },
      ],
    });
    return id;
  }

  async function expectCharge(
    tenantId: string,
    opening: number,
    settled: number,
    quotaUsed: number,
  ): Promise<void> {
    const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId } });
    expect(wallet.points).toBe(opening - settled);
    expect(wallet.pointsReserved).toBe(0);
    const logs = await servicePrisma.base.pointLog.findMany({
      where: { tenantId, action: 'ai_write', status: 'SETTLED' },
    });
    expect(logs).toHaveLength(quotaUsed);
    expect(logs.reduce((sum, log) => sum + log.listPrice, 0)).toBe(settled);
    await expectQuota(tenantId, quotaUsed);
    const snapshot = await billing.ledgerSnapshot(tenantId, opening);
    expect(evaluateLedger(snapshot).ok).toBe(true);
    expect(await billing.auditTenant(tenantId)).toEqual([]);
  }

  async function expectQuota(tenantId: string, used: number): Promise<void> {
    const quota = await servicePrisma.base.quota.findUniqueOrThrow({
      where: { tenantId_key: { tenantId, key: 'AI_WRITE' } },
    });
    expect(quota.used).toBe(BigInt(used));
  }

  function releaseHold(): void {
    hold.enabled = false;
    const pending = hold.release.splice(0);
    for (const resolve of pending) resolve();
  }
});

async function driveUntilSettled(
  driver: WorkDriver,
  tenantId: string,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await driver.handle({ tenantId, runId });
      return;
    } catch (error) {
      if (!(error instanceof RetryableStepError)) throw error;
    }
  }
  throw new Error('retries exhausted');
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 10_000) throw new Error('timed out waiting for the queue');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function drain(producer: QueueProducer): Promise<void> {
  for (const name of QUEUE_NAMES) {
    const queue = await producer.open(name);
    await queue.obliterate({ force: true });
  }
}

async function wipeRedis(prefix: string): Promise<void> {
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertDbName(name: string): void {
  if (!/^geomix_queue_[a-f0-9]+$/.test(name)) throw new Error('unsafe database name');
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  url.searchParams.set('connection_limit', '20');
  return url.toString();
}

function adminSql(base: string, sql: string): void {
  const url = new URL(base);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = url.hostname;
  const port = url.port || '5432';
  const result = spawnSync(
    'psql',
    ['-h', host, '-p', port, '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'postgres admin command failed');
  }
}

type Envelope<T> = { status: number; code: number; msg: string; data: T };

async function call<T>(
  base: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown },
): Promise<Envelope<T>> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['content-type'] = 'application/json';
  if (options?.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!text.startsWith('{')) {
    return { status: response.status, code: 0, msg: text.slice(0, 120), data: undefined as T };
  }
  const payload = JSON.parse(text) as Omit<Envelope<T>, 'status'>;
  return { status: response.status, ...payload };
}

async function login(
  captcha: CaptchaService,
  base: string,
  username: string,
  password: string,
): Promise<{ accessToken: string }> {
  const created = captcha.create();
  const response = await call<{ accessToken: string }>(base, 'POST', '/api/v1/auth/login', {
    body: {
      username,
      password,
      captchaId: created.captchaId,
      captchaCode: captcha.readCodeForTests(created.captchaId),
    },
  });
  expect(response.status).toBe(200);
  return response.data;
}
