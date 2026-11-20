import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@geomix/db';
import { PRICING_DEFAULTS } from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import type { BillingOptions } from '../billing/billing.options';
import { QuotaService } from '../billing/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { hasLiveActiveWork } from './active-work';
import type { JobEnqueuer } from './job-enqueuer';
import { StepGate } from './step-gate';
import { WorkDriver } from './work-driver';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const adminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

const noopJobs: JobEnqueuer = { async enqueueDriver() {} };

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'queue lease clock against Postgres time zones',
  () => {
    const suffix = randomBytes(3).toString('hex');
    const created: string[] = [];

    afterAll(() => {
      for (const name of created) {
        adminSql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });

    it('keeps a heartbeating lease in Asia/Shanghai', async () => {
      await assertLeaseClock('Asia/Shanghai', `geomix_tz_sh_${suffix}`);
    }, 60_000);

    it('keeps a heartbeating lease in UTC', async () => {
      await assertLeaseClock('UTC', `geomix_tz_utc_${suffix}`);
    }, 60_000);

    async function assertLeaseClock(timeZone: string, dbName: string): Promise<void> {
      assertDbName(dbName);
      created.push(dbName);
      adminSql(adminUrl, `CREATE DATABASE "${dbName}"`);
      const isolatedUrl = databaseUrl(adminUrl, dbName);
      const setup = createPrismaClient(isolatedUrl);
      await setup.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
      await setup.$disconnect();
      const migrated = spawnSync('node', ['scripts/prisma-cli.mjs', 'migrate', 'deploy'], {
        cwd: dbPackageRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: isolatedUrl },
      });
      expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(0);
      adminSql(adminUrl, `ALTER DATABASE "${dbName}" SET timezone TO '${timeZone}'`);

      const previous = process.env.DATABASE_URL;
      const previousHeartbeat = process.env.QUEUE_HEARTBEAT_MS;
      const previousTtl = process.env.QUEUE_HEARTBEAT_TTL_MS;
      const previousLease = process.env.QUEUE_LEASE_MS;
      process.env.DATABASE_URL = isolatedUrl;
      process.env.QUEUE_HEARTBEAT_MS = '200';
      process.env.QUEUE_HEARTBEAT_TTL_MS = '5000';
      process.env.QUEUE_LEASE_MS = '30000';
      const prisma = new PrismaService();
      try {
        const zone = await prisma.base.$queryRaw<Array<{ tz: string }>>`
          SELECT current_setting('TIMEZONE') AS tz
        `;
        expect(zone[0]?.tz).toBe(timeZone);
        const columns = await prisma.base.$queryRaw<
          Array<{ table_name: string; column_name: string; data_type: string }>
        >`
          SELECT table_name, column_name, data_type
          FROM information_schema.columns
          WHERE (table_name = 'WorkUnit' AND column_name IN ('leaseUntil', 'startedAt', 'finishedAt'))
             OR (table_name = 'ActiveWork' AND column_name = 'beatAt')
          ORDER BY table_name, column_name
        `;
        expect(columns.map((column) => column.data_type)).toEqual([
          'timestamp with time zone',
          'timestamp with time zone',
          'timestamp with time zone',
          'timestamp with time zone',
        ]);

        for (const item of PRICING_DEFAULTS) {
          await prisma.base.pricingItem.upsert({
            where: { action: item.action },
            update: { unitPoints: item.unitPoints, enabled: true },
            create: { action: item.action, unitPoints: item.unitPoints, enabled: true },
          });
        }
        const options: BillingOptions = {
          globalMode: () => 'STRICT',
          orphanAfterMs: 2 * 60 * 60 * 1000,
          now: () => new Date(),
          hasActiveJob: (ref) => hasLiveActiveWork(prisma, ref, new Date(), 5_000),
        };
        const billing = new BillingService(prisma, options);
        const quota = new QuotaService(prisma);
        const holder = new WorkDriver(prisma, billing, quota, noopJobs, new StepGate());
        const other = new WorkDriver(prisma, billing, quota, noopJobs, new StepGate());

        const tenantId = `live_${timeZone.replace('/', '_').toLowerCase()}_${suffix}`;
        await makeTenant(prisma, tenantId, 80);
        let release: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => {
          holder.setStepHandler(async () => {
            resolve();
            await new Promise<void>((done) => {
              release = done;
            });
          });
        });
        const createdRun = await holder.create(tenantId, { units: [{ steps: 1 }] });
        const running = holder.handle({ tenantId, runId: createdRun.id });
        await entered;
        await new Promise((resolve) => setTimeout(resolve, 600));

        const clock = await prisma.base.$queryRaw<
          Array<{ expired: boolean | null; seconds_left: number }>
        >`
          SELECT ("leaseUntil" < now()) AS expired,
                 EXTRACT(EPOCH FROM ("leaseUntil" - now()))::float8 AS seconds_left
          FROM "WorkUnit"
          WHERE "runId" = ${createdRun.id} AND "tenantId" = ${tenantId}
        `;
        expect(clock[0]?.expired).toBe(false);
        expect(clock[0]?.seconds_left ?? 0).toBeGreaterThan(5);

        await prisma.base.pointReservation.updateMany({
          where: { tenantId, refId: createdRun.id },
          data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
        });
        const protectedReport = await billing.reconcileOrphans(new Date());
        expect(protectedReport.skippedActive).toBeGreaterThanOrEqual(1);
        const before = await prisma.base.workUnit.findFirstOrThrow({
          where: { runId: createdRun.id, tenantId },
        });
        await other.handle({ tenantId, runId: createdRun.id });
        const after = await prisma.base.workUnit.findFirstOrThrow({
          where: { runId: createdRun.id, tenantId },
        });
        expect(after.status).toBe('RUNNING');
        expect(after.settled).toBe(false);
        expect(after.executionToken).toBe(before.executionToken);
        expect(await usedWrites(prisma, tenantId)).toBe(0n);

        release?.();
        await running;
        const done = await holder.view(tenantId, createdRun.id);
        expect(done.status).toBe('COMPLETED');
        expect(await usedWrites(prisma, tenantId)).toBe(1n);
        await other.handle({ tenantId, runId: createdRun.id });
        expect(await usedWrites(prisma, tenantId)).toBe(1n);

        const crashedId = `dead_${timeZone.replace('/', '_').toLowerCase()}_${suffix}`;
        await makeTenant(prisma, crashedId, 40);
        const crashed = await other.create(crashedId, { units: [{ steps: 1 }] });
        await prisma.base.workUnit.updateMany({
          where: { runId: crashed.id, tenantId: crashedId },
          data: {
            status: 'RUNNING',
            step: 0,
            leaseOwner: 'crashed',
            leaseUntil: new Date(Date.now() - 60_000),
            executionToken: null,
            startedAt: new Date(Date.now() - 90_000),
          },
        });
        await other.handle({ tenantId: crashedId, runId: crashed.id });
        await other.handle({ tenantId: crashedId, runId: crashed.id });
        const recovered = await other.view(crashedId, crashed.id);
        expect(recovered.status).toBe('COMPLETED');
        expect(await usedWrites(prisma, crashedId)).toBe(1n);

        const staleId = `stale_${timeZone.replace('/', '_').toLowerCase()}_${suffix}`;
        await makeTenant(prisma, staleId, 30);
        const stale = await other.create(staleId, { units: [{ steps: 1 }] });
        await prisma.base.pointReservation.updateMany({
          where: { tenantId: staleId, refId: stale.id },
          data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
        });
        await prisma.base.activeWork.updateMany({
          where: { runId: stale.id, tenantId: staleId },
          data: { reason: 'running', beatAt: new Date(Date.now() - 10 * 60 * 1000) },
        });
        const released = await billing.reconcileOrphans(new Date());
        expect(released.closed).toBeGreaterThanOrEqual(1);
        const closed = await prisma.base.pointReservation.findFirstOrThrow({
          where: { tenantId: staleId, refId: stale.id },
        });
        expect(closed.status).toBe('CLOSED');
        const stillOpen = await prisma.base.pointReservation.findFirstOrThrow({
          where: { tenantId, refId: createdRun.id },
        });
        expect(stillOpen.status).toBe('CLOSED');
      } finally {
        await prisma.onModuleDestroy();
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
        restore('QUEUE_HEARTBEAT_MS', previousHeartbeat);
        restore('QUEUE_HEARTBEAT_TTL_MS', previousTtl);
        restore('QUEUE_LEASE_MS', previousLease);
      }
    }
  },
);

async function makeTenant(prisma: PrismaService, id: string, points: number): Promise<void> {
  await prisma.base.tenant.create({
    data: { id, name: id, billingMode: 'STRICT', expiresAt: new Date('2027-11-16T00:00:00.000Z') },
  });
  await prisma.base.wallet.create({
    data: { tenantId: id, points, pointsReserved: 0, money: 0 },
  });
  await prisma.base.quota.createMany({
    data: [
      { tenantId: id, key: 'MAIN_KEYWORD', limit: 100n, used: 0n },
      { tenantId: id, key: 'QUESTION', limit: 10_000n, used: 0n },
      { tenantId: id, key: 'AI_WRITE', limit: 10_000n, used: 0n },
      { tenantId: id, key: 'STORAGE_BYTES', limit: 104_857_600n, used: 0n },
      { tenantId: id, key: 'PUBLISH', limit: 10_000n, used: 0n },
      { tenantId: id, key: 'SOCIAL_AUTH', limit: 100n, used: 0n },
    ],
  });
}

async function usedWrites(prisma: PrismaService, tenantId: string): Promise<bigint> {
  const quota = await prisma.base.quota.findUniqueOrThrow({
    where: { tenantId_key: { tenantId, key: 'AI_WRITE' } },
  });
  return quota.used;
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function assertDbName(name: string): void {
  if (!/^geomix_tz_[a-z0-9_]+$/.test(name)) throw new Error('unsafe database name');
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  url.searchParams.set('connection_limit', '10');
  return url.toString();
}

function adminSql(base: string, sql: string): void {
  const url = new URL(base);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const result = spawnSync(
    'psql',
    [
      '-h',
      url.hostname,
      '-p',
      url.port || '5432',
      '-U',
      user,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'postgres admin command failed');
}
