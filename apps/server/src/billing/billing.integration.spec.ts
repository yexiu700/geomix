import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, hashPassword } from '@geomix/db';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  evaluateLedger,
  PRICING_DEFAULTS,
  type BillingMode,
} from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { PrismaService } from '../prisma/prisma.service';
import { CaptchaService } from '../auth/captcha.service';
import { ApiError } from '../common/api-error';
import type { BillingOptions } from './billing.options';
import { BillingService } from './billing.service';
import { QuotaService } from './quota.service';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const adminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'billing against isolated Postgres',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `geomix_bill_${suffix}`;
    let isolatedUrl = '';
    let previousDatabaseUrl: string | undefined;
    let previousBillingMode: string | undefined;
    let servicePrisma!: PrismaService;
    let billing!: BillingService;
    let quota!: QuotaService;
    let app: INestApplication | undefined;
    let baseUrl = '';
    let captcha: CaptchaService | undefined;
    let globalMode: BillingMode = 'SHADOW';
    const activeJobs = new Set<string>();
    const password = 'billing-pass-1';

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

      previousDatabaseUrl = process.env.DATABASE_URL;
      previousBillingMode = process.env.BILLING_MODE;
      process.env.DATABASE_URL = isolatedUrl;
      process.env.BILLING_MODE = 'SHADOW';

      servicePrisma = new PrismaService();
      const options: BillingOptions = {
        globalMode: () => globalMode,
        orphanAfterMs: 2 * 60 * 60 * 1000,
        now: () => new Date(),
        hasActiveJob: (ref) => activeJobs.has(ref.refId),
      };
      billing = new BillingService(servicePrisma, options);
      quota = new QuotaService(servicePrisma);
      for (const item of PRICING_DEFAULTS) {
        await servicePrisma.base.pricingItem.create({
          data: { action: item.action, unitPoints: item.unitPoints, enabled: true },
        });
      }

      const extension = await servicePrisma.base.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
      expect(extension.map((row) => row.extname)).toEqual(['vector']);
      const constraints = await servicePrisma.base.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('chk_wallet_nonneg', 'chk_quota_nonneg', 'chk_resv')
      ORDER BY conname
    `;
      expect(constraints.map((row) => row.conname)).toEqual([
        'chk_quota_nonneg',
        'chk_resv',
        'chk_wallet_nonneg',
      ]);

      app = await createApiApp();
      await app.listen(0);
      const address = app.getHttpServer().address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      captcha = app.get(CaptchaService);
    }, 120_000);

    afterAll(async () => {
      if (app) await app.close();
      if (servicePrisma) await servicePrisma.onModuleDestroy();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousBillingMode === undefined) delete process.env.BILLING_MODE;
      else process.env.BILLING_MODE = previousBillingMode;
      adminSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }, 60_000);

    async function makeTenant(
      id: string,
      points: number,
      mode: BillingMode | null = 'STRICT',
    ): Promise<void> {
      await servicePrisma.base.tenant.create({
        data: { id, name: id, billingMode: mode, expiresAt: new Date('2027-11-16T00:00:00.000Z') },
      });
      await servicePrisma.base.wallet.create({
        data: { tenantId: id, points, pointsReserved: 0, money: 0 },
      });
    }

    async function expectLedger(tenantId: string, openingPoints: number): Promise<void> {
      const snapshot = await billing.ledgerSnapshot(tenantId, openingPoints);
      expect(evaluateLedger(snapshot)).toEqual({ ok: true, issues: [] });
      expect(await billing.auditTenant(tenantId)).toEqual([]);
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId } });
      expect(wallet.points).toBeGreaterThanOrEqual(wallet.pointsReserved);
      expect(wallet.pointsReserved).toBeGreaterThanOrEqual(0);
    }

    function codeOf(error: unknown): number | undefined {
      return error instanceof ApiError ? error.code : undefined;
    }

    it('does not use the shared demo wallet', async () => {
      expect(
        await servicePrisma.base.tenant.findUnique({ where: { id: 'seed_tenant_demo' } }),
      ).toBeNull();
    });

    it('rejects a negative wallet at the database check', async () => {
      const id = `chk_${suffix}`;
      await makeTenant(id, 5, 'STRICT');
      await expect(
        servicePrisma.base.$executeRaw`UPDATE "Wallet" SET points = -1 WHERE "tenantId" = ${id}`,
      ).rejects.toThrow(/chk_wallet_nonneg/);
      expect(
        (await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } })).points,
      ).toBe(5);
    });

    it('inherits SHADOW from the global mode and keeps an already open hold on that mode', async () => {
      const id = `mode_${suffix}`;
      await makeTenant(id, 100, null);
      globalMode = 'SHADOW';
      const shadowHold = await billing.reserve({
        tenantId: id,
        refType: 'distill',
        refId: `distill_shadow_${suffix}`,
        amount: 10,
      });
      expect(shadowHold.shadow).toBe(true);
      let wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(100);
      expect(wallet.pointsReserved).toBe(0);

      globalMode = 'STRICT';
      const settled = await billing.settle({
        tenantId: id,
        reservationId: shadowHold.id,
        unitKey: `distill_shadow_${suffix}`,
        action: 'distill',
        amount: 10,
        title: 'AI蒸馏拓展-甲',
      });
      expect(settled.replayed).toBe(false);
      expect(settled.lines[0]?.delta).toBe(0);
      expect(settled.lines[0]?.listPrice).toBe(10);
      expect(settled.lines[0]?.title.endsWith('（免费期）')).toBe(true);
      wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(100);

      const strictHold = await billing.reserve({
        tenantId: id,
        refType: 'distill',
        refId: `distill_strict_${suffix}`,
        amount: 10,
      });
      expect(strictHold.shadow).toBe(false);
      await billing.setBillingMode({
        actorUserId: `admin_${suffix}`,
        actorRole: 'ADMIN',
        tenantId: id,
        billingMode: 'SHADOW',
      });
      const stillStrict = await billing.settle({
        tenantId: id,
        reservationId: strictHold.id,
        unitKey: `distill_strict_${suffix}`,
        action: 'distill',
        amount: 10,
        title: 'AI蒸馏拓展-乙',
      });
      expect(stillStrict.lines[0]?.delta).toBe(-10);
      expect(stillStrict.lines[0]?.title.endsWith('（免费期）')).toBe(false);
      wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(90);
      expect(wallet.pointsReserved).toBe(0);
      await expectLedger(id, 100);
      globalMode = 'SHADOW';
    });

    it('stops 60 concurrent reserves at the available balance', async () => {
      const id = `race_${suffix}`;
      const other = `race_b_${suffix}`;
      await makeTenant(id, 50, 'STRICT');
      await makeTenant(other, 20, 'STRICT');
      const attempts = Array.from({ length: 60 }, (_, index) =>
        billing.reserve({
          tenantId: id,
          refType: 'image_job',
          refId: `img_${suffix}_${index}`,
          amount: 1,
        }),
      );
      attempts.push(
        ...Array.from({ length: 20 }, (_, index) =>
          billing.reserve({
            tenantId: other,
            refType: 'image_job',
            refId: `imgb_${suffix}_${index}`,
            amount: 1,
          }),
        ),
      );
      const results = await Promise.allSettled(attempts);
      const denied = results.filter(
        (result) =>
          result.status === 'rejected' && codeOf(result.reason) === API_ERROR.INSUFFICIENT_POINTS,
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(70);
      expect(denied).toHaveLength(10);
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(50);
      expect(wallet.pointsReserved).toBe(50);
      expect(wallet.points - wallet.pointsReserved).toBe(0);
      const otherWallet = await servicePrisma.base.wallet.findUniqueOrThrow({
        where: { tenantId: other },
      });
      expect(otherWallet.points).toBe(20);
      expect(otherWallet.pointsReserved).toBe(20);
      expect(await servicePrisma.base.pointReservation.count({ where: { tenantId: id } })).toBe(50);
      await expectLedger(id, 50);
      await expectLedger(other, 20);
    }, 60_000);

    it('charges one unit once when the same key is replayed ten times, including in parallel', async () => {
      const id = `replay_${suffix}`;
      await makeTenant(id, 40, 'STRICT');
      const hold = await billing.reserve({
        tenantId: id,
        refType: 'rewrite_single',
        refId: `rewrite_${suffix}`,
        amount: 10,
      });
      const again = await billing.reserve({
        tenantId: id,
        refType: 'rewrite_single',
        refId: `rewrite_${suffix}`,
        amount: 10,
      });
      expect(again.id).toBe(hold.id);
      await expect(
        billing.reserve({
          tenantId: id,
          refType: 'rewrite_single',
          refId: `rewrite_${suffix}`,
          amount: 5,
        }),
      ).rejects.toMatchObject({ code: BILLING_ERROR.CONFLICT });

      const request = {
        tenantId: id,
        reservationId: hold.id,
        unitKey: `rewrite_unit_${suffix}`,
        action: 'rewrite_single' as const,
        amount: 5,
        title: '单篇复刻',
      };
      const first = await billing.settle(request);
      expect(first.replayed).toBe(false);
      for (let index = 0; index < 9; index += 1) {
        const replay = await billing.settle(request);
        expect(replay.replayed).toBe(true);
        expect(replay.lines[0]?.id).toBe(first.lines[0]?.id);
      }
      const parallel = await Promise.all(
        Array.from({ length: 10 }, () =>
          billing.settle({ ...request, unitKey: `rewrite_parallel_${suffix}` }),
        ),
      );
      expect(parallel.filter((result) => !result.replayed)).toHaveLength(1);
      expect(new Set(parallel.map((result) => result.lines[0]?.id)).size).toBe(1);
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(30);
      expect(wallet.pointsReserved).toBe(0);
      const closed = await billing.close({ tenantId: id, reservationId: hold.id });
      expect(closed.releasedNow).toBe(0);
      expect(closed.reservation.status).toBe('CLOSED');
      await expectLedger(id, 40);
    }, 60_000);

    it('splits a knowledge-base article into two lines whose prices sum to 15', async () => {
      const id = `kb_${suffix}`;
      await makeTenant(id, 200, 'STRICT');
      const quote = await billing.quoteAiWrite({
        count: 5,
        withKnowledgeBase: true,
        taskName: '春季说明',
      });
      expect(quote.unitTotal).toBe(15);
      expect(quote.total).toBe(75);
      expect(quote.lines.map((line) => [line.action, line.listPrice])).toEqual([
        ['ai_write', 10],
        ['kb_addon', 5],
      ]);
      const hold = await billing.reserve({
        tenantId: id,
        refType: 'ai_task',
        refId: `task_${suffix}`,
        amount: quote.total,
      });
      expect(hold.frozen).toBe(75);
      const settled = await billing.settleAiWriteUnit({
        tenantId: id,
        reservationId: hold.id,
        unitKey: `ai_task_item_${suffix}_1`,
        taskName: '春季说明',
        aiWritePoints: 10,
        kbAddonPoints: 5,
        withKnowledgeBase: true,
      });
      expect(settled.lines.map((line) => [line.action, line.listPrice, line.delta]).sort()).toEqual(
        [
          ['ai_write', 10, -10],
          ['kb_addon', 5, -5],
        ],
      );
      expect(settled.lines.reduce((sum, line) => sum + line.listPrice, 0)).toBe(15);
      const detail = settled.lines[0]?.detail as { unitTotal?: number };
      expect(detail.unitTotal).toBe(15);

      await servicePrisma.base.pricingItem.update({
        where: { action: 'ai_write' },
        data: { unitPoints: 99 },
      });
      const snapshotted = await billing.settleAiWriteUnit({
        tenantId: id,
        reservationId: hold.id,
        unitKey: `ai_task_item_${suffix}_2`,
        taskName: '春季说明',
        aiWritePoints: 10,
        kbAddonPoints: 5,
        withKnowledgeBase: true,
      });
      expect(snapshotted.lines.reduce((sum, line) => sum + line.listPrice, 0)).toBe(15);
      await servicePrisma.base.pricingItem.update({
        where: { action: 'ai_write' },
        data: { unitPoints: 10 },
      });

      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(170);
      expect(wallet.pointsReserved).toBe(45);
      const closed = await billing.close({ tenantId: id, reservationId: hold.id });
      expect(closed.releasedNow).toBe(45);
      const after = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(after.points).toBe(170);
      expect(after.pointsReserved).toBe(0);
      await expectLedger(id, 200);
    });

    it('records five shadow articles at list price 75 and does not deduct', async () => {
      const id = `shadow5_${suffix}`;
      await makeTenant(id, 1000, 'SHADOW');
      const hold = await billing.reserve({
        tenantId: id,
        refType: 'ai_task',
        refId: `task_shadow_${suffix}`,
        amount: 75,
      });
      expect(hold.shadow).toBe(true);
      for (let index = 0; index < 5; index += 1) {
        const settled = await billing.settleAiWriteUnit({
          tenantId: id,
          reservationId: hold.id,
          unitKey: `shadow_item_${suffix}_${index}`,
          taskName: '影子批次',
          aiWritePoints: 10,
          kbAddonPoints: 5,
          withKnowledgeBase: true,
        });
        expect(settled.lines.every((line) => line.delta === 0)).toBe(true);
        expect(settled.lines.every((line) => line.title.endsWith('（免费期）'))).toBe(true);
      }
      const logs = await servicePrisma.base.pointLog.findMany({ where: { tenantId: id } });
      expect(logs.reduce((sum, log) => sum + log.listPrice, 0)).toBe(75);
      expect(logs.every((log) => log.delta === 0)).toBe(true);
      const closed = await billing.close({ tenantId: id, reservationId: hold.id });
      expect(closed.releasedNow).toBe(0);
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(1000);
      expect(wallet.pointsReserved).toBe(0);
      await expectLedger(id, 1000);
    });

    it('releases a batch that produced nothing and a failed unit', async () => {
      const id = `refund_${suffix}`;
      await makeTenant(id, 80, 'STRICT');
      const batch = await billing.reserve({
        tenantId: id,
        refType: 'rewrite_batch',
        refId: `batch_${suffix}`,
        amount: 25,
      });
      const closed = await billing.close({ tenantId: id, reservationId: batch.id });
      expect(closed.releasedNow).toBe(25);
      expect(closed.reservation.status).toBe('CLOSED');
      const again = await billing.close({ tenantId: id, reservationId: batch.id });
      expect(again.releasedNow).toBe(0);
      const refund = await servicePrisma.base.pointLog.findFirstOrThrow({
        where: { tenantId: id, action: 'refund' },
      });
      expect(refund.delta).toBe(0);
      expect(refund.listPrice).toBe(25);
      expect(refund.status).toBe('RELEASED');

      const single = await billing.reserveSync({
        tenantId: id,
        refType: 'distill',
        unitKey: `distill_fail_${suffix}`,
        amount: 10,
      });
      const released = await billing.releaseUnit({
        tenantId: id,
        reservationId: single.id,
        unitKey: `distill_fail_${suffix}`,
        amount: 10,
        title: '退还预扣',
      });
      expect(released.lines[0]?.delta).toBe(0);
      expect(released.lines[0]?.listPrice).toBe(10);
      const replayed = await Promise.all(
        Array.from({ length: 10 }, () =>
          billing.releaseUnit({
            tenantId: id,
            reservationId: single.id,
            unitKey: `distill_fail_${suffix}`,
            amount: 10,
          }),
        ),
      );
      expect(
        replayed.every(
          (result) => result.replayed || result.lines[0]?.id === released.lines[0]?.id,
        ),
      ).toBe(true);
      await billing.close({ tenantId: id, reservationId: single.id });
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(80);
      expect(wallet.pointsReserved).toBe(0);
      await expectLedger(id, 80);
    }, 60_000);

    it('hides another tenant reservation and does not move their wallet', async () => {
      const owner = `own_${suffix}`;
      const stranger = `str_${suffix}`;
      await makeTenant(owner, 30, 'STRICT');
      await makeTenant(stranger, 30, 'STRICT');
      const hold = await billing.reserve({
        tenantId: owner,
        refType: 'distill',
        refId: `own_distill_${suffix}`,
        amount: 10,
      });
      await expect(
        billing.settle({
          tenantId: stranger,
          reservationId: hold.id,
          unitKey: `stolen_${suffix}_unit`,
          action: 'distill',
          amount: 10,
          title: 'AI蒸馏拓展',
        }),
      ).rejects.toMatchObject({ code: AUTH_ERROR.NOT_FOUND });
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({
        where: { tenantId: owner },
      });
      expect(wallet.points).toBe(30);
      expect(wallet.pointsReserved).toBe(10);
      const strangerWallet = await servicePrisma.base.wallet.findUniqueOrThrow({
        where: { tenantId: stranger },
      });
      expect(strangerWallet.points).toBe(30);
      expect(strangerWallet.pointsReserved).toBe(0);
      await expectLedger(owner, 30);
      await expectLedger(stranger, 30);
    });

    it('releases an orphan hold and leaves an active or fresh hold alone', async () => {
      const id = `orphan_${suffix}`;
      await makeTenant(id, 40, 'STRICT');
      const orphan = await billing.reserve({
        tenantId: id,
        refType: 'ai_task',
        refId: `old_${suffix}`,
        amount: 15,
      });
      const active = await billing.reserve({
        tenantId: id,
        refType: 'ai_task',
        refId: `live_${suffix}`,
        amount: 15,
      });
      const fresh = await billing.reserve({
        tenantId: id,
        refType: 'ai_task',
        refId: `new_${suffix}`,
        amount: 10,
      });
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await servicePrisma.base.pointReservation.updateMany({
        where: { id: { in: [orphan.id, active.id] }, tenantId: id },
        data: { createdAt: old },
      });
      activeJobs.add(`live_${suffix}`);
      const report = await billing.reconcileOrphans(new Date());
      activeJobs.delete(`live_${suffix}`);
      expect(report.closed).toBeGreaterThanOrEqual(1);
      expect(report.failed).toBe(0);
      const orphanRow = await servicePrisma.base.pointReservation.findUniqueOrThrow({
        where: { id: orphan.id },
      });
      const activeRow = await servicePrisma.base.pointReservation.findUniqueOrThrow({
        where: { id: active.id },
      });
      const freshRow = await servicePrisma.base.pointReservation.findUniqueOrThrow({
        where: { id: fresh.id },
      });
      expect(orphanRow.status).toBe('CLOSED');
      expect(orphanRow.released).toBe(15);
      expect(activeRow.status).toBe('OPEN');
      expect(freshRow.status).toBe('OPEN');
      const wallet = await servicePrisma.base.wallet.findUniqueOrThrow({ where: { tenantId: id } });
      expect(wallet.points).toBe(40);
      expect(wallet.pointsReserved).toBe(25);
      await expectLedger(id, 40);
    });

    it('keeps stock quotas inside the limit and refuses cumulative or unconfirmed release', async () => {
      const id = `quota_${suffix}`;
      await makeTenant(id, 0, 'STRICT');
      await servicePrisma.base.quota.createMany({
        data: [
          { tenantId: id, key: 'MAIN_KEYWORD', limit: 2n, used: 0n },
          { tenantId: id, key: 'QUESTION', limit: 3n, used: 0n },
          { tenantId: id, key: 'AI_WRITE', limit: 10n, used: 0n },
          { tenantId: id, key: 'STORAGE_BYTES', limit: 100n, used: 0n },
          { tenantId: id, key: 'PUBLISH', limit: 10n, used: 4n },
          { tenantId: id, key: 'SOCIAL_AUTH', limit: 10n, used: 1n },
        ],
      });
      const keywordAttempts = await Promise.allSettled(
        Array.from({ length: 5 }, () => quota.consume(id, 'MAIN_KEYWORD', 1)),
      );
      expect(keywordAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      expect(
        keywordAttempts.filter(
          (result) =>
            result.status === 'rejected' && codeOf(result.reason) === API_ERROR.QUOTA_EXCEEDED,
        ),
      ).toHaveLength(3);
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'MAIN_KEYWORD' } },
          })
        ).used,
      ).toBe(2n);

      await servicePrisma.base.$transaction(async (tx) => {
        await quota.consume(id, 'QUESTION', 1, tx);
        await tx.question.create({
          data: {
            tenantId: id,
            keywordId: await keywordFor(id),
            text: `问题${suffix}`,
          },
        });
      });
      await expect(
        servicePrisma.base.$transaction(async (tx) => {
          await quota.consume(id, 'QUESTION', 1, tx);
          await tx.question.create({
            data: {
              tenantId: id,
              keywordId: await keywordFor(id),
              text: `问题${suffix}`,
            },
          });
        }),
      ).rejects.toThrow();
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'QUESTION' } },
          })
        ).used,
      ).toBe(1n);
      await quota.release(id, 'QUESTION', 1);
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'QUESTION' } },
          })
        ).used,
      ).toBe(0n);

      await quota.consume(id, 'AI_WRITE', 1);
      await quota.applyArticleEvent(id, 'AI_TASK', 'create');
      await quota.applyArticleEvent(id, 'REWRITE_SINGLE', 'create');
      await quota.applyArticleEvent(id, 'REWRITE_BATCH', 'create');
      await quota.applyArticleEvent(id, 'MANUAL', 'create');
      await quota.applyArticleEvent(id, 'MANUAL', 'status_change');
      await quota.applyArticleEvent(id, 'AI_TASK', 'status_change');
      await quota.applyArticleEvent(id, 'AI_TASK', 'delete');
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'AI_WRITE' } },
          })
        ).used,
      ).toBe(2n);
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'PUBLISH' } },
          })
        ).used,
      ).toBe(4n);
      await expect(quota.release(id, 'AI_WRITE', 1)).rejects.toMatchObject({
        code: API_ERROR.BAD_REQUEST,
      });
      await expect(quota.release(id, 'PUBLISH', 1)).rejects.toMatchObject({
        code: API_ERROR.BAD_REQUEST,
      });
      await expect(quota.release(id, 'SOCIAL_AUTH', 1)).rejects.toMatchObject({
        code: API_ERROR.BAD_REQUEST,
      });
      await quota.consume(id, 'STORAGE_BYTES', 40);
      await quota.release(id, 'STORAGE_BYTES', 15);
      expect(
        (
          await servicePrisma.base.quota.findUniqueOrThrow({
            where: { tenantId_key: { tenantId: id, key: 'STORAGE_BYTES' } },
          })
        ).used,
      ).toBe(25n);
    }, 60_000);

    async function keywordFor(tenantId: string): Promise<string> {
      const existing = await servicePrisma.base.keyword.findFirst({ where: { tenantId } });
      if (existing) return existing.id;
      const created = await servicePrisma.base.keyword.create({
        data: { tenantId, main: `主词${suffix}` },
      });
      return created.id;
    }

    it('serves tenant-scoped reads and admin adjustments over HTTP', async () => {
      if (!app || !captcha) throw new Error('api was not started');
      const merchantId = `http_m_${suffix}`;
      const otherId = `http_o_${suffix}`;
      const adminTenant = `http_admin_${suffix}`;
      const expiredId = `http_exp_${suffix}`;
      const hash = hashPassword(password);
      await makeTenant(merchantId, 100, null);
      await makeTenant(otherId, 80, 'STRICT');
      await makeTenant(adminTenant, 0, null);
      await servicePrisma.base.tenant.create({
        data: {
          id: expiredId,
          name: expiredId,
          billingMode: null,
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      });
      await servicePrisma.base.wallet.create({
        data: { tenantId: expiredId, points: 7, pointsReserved: 0, money: 0 },
      });
      await servicePrisma.base.user.createMany({
        data: [
          {
            id: `user_${merchantId}`,
            tenantId: merchantId,
            username: `m_${suffix}`,
            passwordHash: hash,
            role: 'MERCHANT',
          },
          {
            id: `user_${otherId}`,
            tenantId: otherId,
            username: `o_${suffix}`,
            passwordHash: hash,
            role: 'MERCHANT',
          },
          {
            id: `user_${adminTenant}`,
            tenantId: adminTenant,
            username: `admin_${suffix}`,
            passwordHash: hash,
            role: 'ADMIN',
          },
          {
            id: `user_${expiredId}`,
            tenantId: expiredId,
            username: `exp_${suffix}`,
            passwordHash: hash,
            role: 'MERCHANT',
          },
        ],
      });
      await billing.reserve({
        tenantId: otherId,
        refType: 'distill',
        refId: `other_distill_${suffix}`,
        amount: 10,
      });
      await billing.settle({
        tenantId: otherId,
        reservationId: (
          await servicePrisma.base.pointReservation.findFirstOrThrow({
            where: { tenantId: otherId },
          })
        ).id,
        unitKey: `other_unit_${suffix}_key`,
        action: 'distill',
        amount: 10,
        title: '其他租户蒸馏',
      });

      const merchant = await login(captcha, baseUrl, `m_${suffix}`, password);
      const other = await login(captcha, baseUrl, `o_${suffix}`, password);
      const admin = await login(captcha, baseUrl, `admin_${suffix}`, password);
      const expired = await login(captcha, baseUrl, `exp_${suffix}`, password);

      const quote = await call<{
        total: number;
        lines: Array<{ action: string; listPrice: number }>;
      }>(baseUrl, 'GET', '/api/v1/billing/quote?count=1&knowledgeBase=1&taskName=春季说明', {
        token: merchant.accessToken,
      });
      expect(quote.status).toBe(200);
      expect(quote.data.total).toBe(15);
      expect(quote.data.lines.map((line) => line.listPrice)).toEqual([10, 5]);
      const five = await call<{ total: number }>(
        baseUrl,
        'GET',
        '/api/v1/billing/quote?count=5&knowledgeBase=true',
        { token: merchant.accessToken },
      );
      expect(five.data.total).toBe(75);

      process.env.BILLING_MODE = 'STRICT';
      const inherited = await call<{
        billingMode: string;
        billingModeSource: string;
        points: number;
      }>(baseUrl, 'GET', `/api/v1/billing/wallet?tenantId=${otherId}`, {
        token: merchant.accessToken,
      });
      expect(inherited.status).toBe(200);
      expect(inherited.data.billingMode).toBe('STRICT');
      expect(inherited.data.billingModeSource).toBe('global');
      expect(inherited.data.points).toBe(100);
      process.env.BILLING_MODE = 'SHADOW';

      const ledger = await call<{ items: Array<{ unitKey: string }> }>(
        baseUrl,
        'GET',
        '/api/v1/billing/ledger',
        { token: merchant.accessToken },
      );
      expect(ledger.data.items.some((item) => item.unitKey.includes('other_unit'))).toBe(false);
      const otherLedger = await call<{ items: Array<{ unitKey: string }> }>(
        baseUrl,
        'GET',
        '/api/v1/billing/ledger',
        { token: other.accessToken },
      );
      expect(
        otherLedger.data.items.some((item) => item.unitKey === `other_unit_${suffix}_key`),
      ).toBe(true);

      const hidden = await call(baseUrl, 'POST', '/api/v1/admin/billing/adjust', {
        token: merchant.accessToken,
        body: { tenantId: otherId, delta: 500, idempotencyKey: `merchant_${suffix}_adjust` },
      });
      expect(hidden.status).toBe(404);
      expect(hidden.code).toBe(AUTH_ERROR.NOT_FOUND);

      const adjust = await call<{ delta: number; title: string; balanceAfter: number | null }>(
        baseUrl,
        'POST',
        '/api/v1/admin/billing/adjust',
        {
          token: admin.accessToken,
          body: {
            tenantId: merchantId,
            delta: 500,
            idempotencyKey: `admin_${suffix}_adjust`,
            remark: '开通补点',
          },
        },
      );
      expect(adjust.status).toBe(200);
      expect(adjust.data.delta).toBe(500);
      expect(adjust.data.title).toBe('管理员充值');
      expect(adjust.data.balanceAfter).toBe(600);
      const replay = await Promise.all(
        Array.from({ length: 10 }, () =>
          call<{ balanceAfter: number | null }>(baseUrl, 'POST', '/api/v1/admin/billing/adjust', {
            token: admin.accessToken,
            body: {
              tenantId: merchantId,
              delta: 500,
              idempotencyKey: `admin_${suffix}_adjust`,
            },
          }),
        ),
      );
      expect(
        replay.every((result) => result.status === 200 && result.data.balanceAfter === 600),
      ).toBe(true);
      const topped = await servicePrisma.base.wallet.findUniqueOrThrow({
        where: { tenantId: merchantId },
      });
      expect(topped.points).toBe(600);

      const mode = await call<{ billingMode: string | null }>(
        baseUrl,
        'POST',
        '/api/v1/admin/billing/mode',
        {
          token: admin.accessToken,
          body: { tenantId: merchantId, billingMode: 'STRICT' },
        },
      );
      expect(mode.status).toBe(200);
      expect(mode.data.billingMode).toBe('STRICT');
      const cleared = await call<{ billingMode: string | null }>(
        baseUrl,
        'POST',
        '/api/v1/admin/billing/mode',
        { token: admin.accessToken, body: { tenantId: merchantId, billingMode: null } },
      );
      expect(cleared.data.billingMode).toBeNull();

      const expiredRead = await call<{ points: number }>(baseUrl, 'GET', '/api/v1/billing/wallet', {
        token: expired.accessToken,
      });
      expect(expiredRead.status).toBe(200);
      expect(expiredRead.data.points).toBe(7);
      const expiredWrite = await call(baseUrl, 'POST', '/api/v1/admin/billing/adjust', {
        token: expired.accessToken,
        body: { tenantId: merchantId, delta: 1, idempotencyKey: `expired_${suffix}_adjust` },
      });
      expect(expiredWrite.status).toBe(403);
      expect(expiredWrite.code).toBe(API_ERROR.TENANT_EXPIRED);
      await expectLedger(merchantId, 100);
    }, 60_000);
  },
);

function assertDbName(name: string): void {
  if (!/^geomix_bill_[a-f0-9]+$/.test(name)) throw new Error('unsafe database name');
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  url.searchParams.set('connection_limit', '30');
  return url.toString();
}

function adminSql(base: string, sql: string): void {
  const url = new URL(base);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = url.hostname;
  const port = url.port || '5432';
  const env = { ...process.env, PGPASSWORD: password };
  const psql = spawnSync(
    'psql',
    ['-h', host, '-p', port, '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env, encoding: 'utf8' },
  );
  if (psql.status === 0) return;
  const docker = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${password}`,
      'geomix-postgres',
      'psql',
      '-U',
      user,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (docker.status === 0) return;
  throw new Error(
    `postgres admin command failed\npsql: ${psql.stderr || psql.stdout}\ndocker: ${docker.stderr || docker.stdout}`,
  );
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
  const payload = (await response.json()) as Omit<Envelope<T>, 'status'>;
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
