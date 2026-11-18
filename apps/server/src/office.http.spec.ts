import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { QuotaKey } from '@prisma/client';
import { createPrismaClient, hashPassword } from '@geomix/db';
import { API_ERROR, AUTH_ERROR, QUOTA_DEFAULTS } from '@geomix/shared';
import { createApiApp } from './common/create-api-app';
import { PrismaService } from './prisma/prisma.service';
import { CaptchaService } from './auth/captcha.service';
import { BillingService } from './billing/billing.service';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const adminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

type Envelope<T> = {
  status: number;
  code: number;
  msg: string;
  data: T;
};

describe('account routes without a database', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects anonymous account and admin calls', async () => {
    const points = await call(base, 'GET', '/api/v1/me/points');
    expect(points.status).toBe(401);
    expect(points.code).toBe(AUTH_ERROR.UNAUTHORIZED);
    const tenants = await call(base, 'GET', '/api/v1/admin/tenants');
    expect(tenants.status).toBe(401);
    const adjust = await call(base, 'POST', '/api/v1/admin/billing/adjust', {
      body: { tenantId: 'x', delta: 500, idempotencyKey: 'anonymous1' },
    });
    expect(adjust.status).toBe(401);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'account center and admin office',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `geomix_acct_${suffix}`;
    let previousDatabaseUrl: string | undefined;
    let previousBillingMode: string | undefined;
    let app: INestApplication | undefined;
    let base = '';
    let prisma: PrismaService | undefined;
    const future = new Date('2027-11-16T00:00:00.000Z');
    const past = new Date('2020-01-01T00:00:00.000Z');
    const tenantA = `acct_a_${suffix}`;
    const tenantB = `acct_b_${suffix}`;
    const tenantAdmin = `acct_admin_${suffix}`;
    const tenantExpired = `acct_e_${suffix}`;
    const password = 'account-pass-1';

    beforeAll(async () => {
      assertDbName(dbName);
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

      previousDatabaseUrl = process.env.DATABASE_URL;
      previousBillingMode = process.env.BILLING_MODE;
      process.env.DATABASE_URL = isolatedUrl;
      process.env.BILLING_MODE = 'SHADOW';
      app = await createApiApp();
      await app.listen(0);
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const database = app.get(PrismaService);
      prisma = database;
      const hash = hashPassword(password);
      await database.base.tenant.createMany({
        data: [
          { id: tenantAdmin, name: '平台', expiresAt: future },
          { id: tenantA, name: '商户甲', expiresAt: future },
          { id: tenantB, name: '商户乙', expiresAt: future },
          { id: tenantExpired, name: '到期商户', expiresAt: past },
        ],
      });
      await database.base.wallet.createMany({
        data: [
          { tenantId: tenantA, points: 1000, pointsReserved: 0 },
          { tenantId: tenantB, points: 1000, pointsReserved: 0 },
          { tenantId: tenantExpired, points: 1000, pointsReserved: 0 },
          { tenantId: tenantAdmin, points: 0, pointsReserved: 0 },
        ],
      });
      await database.base.quota.createMany({
        data: [tenantA, tenantB, tenantExpired, tenantAdmin].flatMap((tenantId) =>
          QUOTA_DEFAULTS.map((item) => ({
            tenantId,
            key: item.key as QuotaKey,
            limit: BigInt(item.limit),
            used: 0n,
          })),
        ),
      });
      await database.base.user.createMany({
        data: [
          {
            id: `user_${tenantAdmin}`,
            tenantId: tenantAdmin,
            username: `admin_${suffix}`,
            passwordHash: hash,
            role: 'ADMIN',
          },
          {
            id: `user_${tenantA}`,
            tenantId: tenantA,
            username: `merchant_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantB}`,
            tenantId: tenantB,
            username: `other_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantExpired}`,
            tenantId: tenantExpired,
            username: `expired_${suffix}`,
            passwordHash: hash,
          },
        ],
      });
      await database.base.pricingItem.createMany({
        data: [
          { action: 'distill', unitPoints: 10, enabled: true },
          { action: 'ai_write', unitPoints: 10, enabled: true },
        ],
      });
      await database.base.quota.update({
        where: { tenantId_key: { tenantId: tenantA, key: 'STORAGE_BYTES' } },
        data: { used: 2048n },
      });
      const keyword = await database.base.keyword.create({
        data: { tenantId: tenantA, main: '示例主词', brands: [] },
      });
      await database.base.question.create({
        data: { tenantId: tenantA, keywordId: keyword.id, text: '已收录的问题', included: true },
      });
      await database.base.moneyLog.create({
        data: {
          tenantId: tenantA,
          title: '余额示例',
          amount: '12.50',
          remark: '说明示例',
        },
      });
      await database.base.pointLog.create({
        data: {
          tenantId: tenantB,
          action: 'admin_topup',
          title: '其他租户充值',
          unitKey: `other${suffix}key`,
          delta: 7,
          listPrice: 7,
          status: 'SETTLED',
        },
      });
    }, 120_000);

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.onModuleDestroy();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousBillingMode === undefined) delete process.env.BILLING_MODE;
      else process.env.BILLING_MODE = previousBillingMode;
      adminSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }, 60_000);

    it('shows +500 管理员充值, updates rights, and keeps a frozen shadow task', async () => {
      const started = app;
      const database = prisma;
      if (!started || !database) throw new Error('app was not started');
      const captcha = started.get(CaptchaService);
      const billing = started.get(BillingService);
      const adminToken = await login(captcha, base, `admin_${suffix}`, password);
      const merchantToken = await login(captcha, base, `merchant_${suffix}`, password);

      const hidden = await call(base, 'POST', '/api/v1/admin/billing/adjust', {
        token: merchantToken,
        body: { tenantId: tenantA, delta: 500, idempotencyKey: `deny${suffix}adj` },
      });
      expect(hidden.status).toBe(404);
      expect(hidden.code).toBe(AUTH_ERROR.NOT_FOUND);

      const adjusted = await call<{ title: string; delta: number }>(
        base,
        'POST',
        '/api/v1/admin/billing/adjust',
        {
          token: adminToken,
          body: {
            tenantId: tenantA,
            delta: 500,
            idempotencyKey: `plus${suffix}500`,
            remark: '验收加点',
          },
        },
      );
      expect(adjusted.status).toBe(200);
      expect(adjusted.data).toMatchObject({ title: '管理员充值', delta: 500 });

      const ledger = await call<{ items: Array<{ title: string; delta: number; phrase: string }> }>(
        base,
        'GET',
        `/api/v1/me/points?filter=${encodeURIComponent(
          JSON.stringify({ title: '管理员充值', delta: 500 }),
        )}`,
        { token: merchantToken },
      );
      expect(ledger.status).toBe(200);
      expect(ledger.data.items).toEqual([
        expect.objectContaining({
          title: '管理员充值',
          delta: 500,
          phrase: '+500 管理员充值',
        }),
      ]);
      const allPoints = await call<{ items: Array<{ title: string; phrase: string }> }>(
        base,
        'GET',
        '/api/v1/me/points',
        { token: merchantToken },
      );
      expect(allPoints.data.items.some((item) => item.phrase === '+500 管理员充值')).toBe(true);
      expect(allPoints.data.items.some((item) => item.title === '其他租户充值')).toBe(false);

      const rights = await call<{
        points: number;
        cards: Array<{ key: string; label: string; text: string }>;
        models: Array<{ count: number }>;
      }>(base, 'GET', '/api/v1/me/rights', { token: merchantToken });
      expect(rights.status).toBe(200);
      expect(rights.data.points).toBe(1500);
      expect(rights.data.cards).toHaveLength(10);
      expect(rights.data.cards.find((card) => card.key === 'POINTS')?.text).toBe('1500');
      expect(rights.data.cards.find((card) => card.key === 'INCLUDED')?.text).toBe('1');
      expect(rights.data.cards.find((card) => card.key === 'MAIN_KEYWORD')?.text).toBe('0 / 100');
      const storage = rights.data.cards.find((card) => card.key === 'STORAGE_BYTES')?.text ?? '';
      expect(storage).toContain('2 KB');
      expect(storage).toContain('100 MB');
      expect(rights.data.models).toHaveLength(8);
      expect(rights.data.models.every((item) => item.count === 0)).toBe(true);

      const held = await billing.reserve({
        tenantId: tenantA,
        refType: 'distill',
        refId: `distill_${suffix}`,
        amount: 10,
      });
      expect(held.shadow).toBe(true);

      const mode = await call(base, 'POST', '/api/v1/admin/billing/mode', {
        token: adminToken,
        body: { tenantId: tenantA, billingMode: 'STRICT' },
      });
      expect(mode.status).toBe(200);
      const modeAudit = await database.base.auditLog.findFirst({
        where: { tenantId: tenantA, action: 'billing_mode_change' },
      });
      expect(modeAudit?.payload).toMatchObject({ from: null, to: 'STRICT' });

      const settled = await billing.settle({
        tenantId: tenantA,
        reservationId: held.id,
        unitKey: `distillu${suffix}`,
        action: 'distill',
        amount: 10,
        title: 'AI蒸馏拓展-示例',
      });
      expect(settled.lines[0]).toMatchObject({ delta: 0, listPrice: 10 });
      expect(settled.lines[0]?.title.endsWith('（免费期）')).toBe(true);
      expect((await billing.wallet(tenantA)).points).toBe(1500);

      const strictHold = await billing.reserve({
        tenantId: tenantA,
        refType: 'rewrite_single',
        refId: `rewrite_${suffix}`,
        amount: 10,
      });
      expect(strictHold.shadow).toBe(false);
      await billing.settle({
        tenantId: tenantA,
        reservationId: strictHold.id,
        unitKey: `rewriteu${suffix}`,
        action: 'rewrite_single',
        amount: 10,
        title: '全网爆文复刻',
      });
      expect((await billing.wallet(tenantA)).points).toBe(1490);

      const topupAudit = await database.base.auditLog.findFirst({
        where: { tenantId: tenantA, action: 'admin_topup' },
      });
      expect(topupAudit?.payload).toMatchObject({ delta: 500 });
    });

    it('lists money without a sequence field and blocks non-admins', async () => {
      const started = app;
      if (!started) throw new Error('app was not started');
      const captcha = started.get(CaptchaService);
      const merchantToken = await login(captcha, base, `merchant_${suffix}`, password);
      const adminToken = await login(captcha, base, `admin_${suffix}`, password);
      const money = await call<{ items: Array<Record<string, unknown>> }>(
        base,
        'GET',
        '/api/v1/me/money',
        { token: merchantToken },
      );
      expect(money.status).toBe(200);
      expect(money.data.items[0]).toMatchObject({
        title: '余额示例',
        amount: '12.50',
        remark: '说明示例',
      });
      expect(money.data.items[0]).not.toHaveProperty('index');
      expect(money.data.items[0]).not.toHaveProperty('seq');
      const denied = await call(base, 'POST', '/api/v1/admin/tenants', {
        token: merchantToken,
        body: {
          name: '不该创建',
          username: `nope${suffix}`,
          password: 'account-pass-1',
          expiresAt: future.toISOString(),
        },
      });
      expect(denied.status).toBe(404);

      const created = await call<{ id: string; points: number; username: string }>(
        base,
        'POST',
        '/api/v1/admin/tenants',
        {
          token: adminToken,
          headers: { 'idempotency-key': `open${suffix}01` },
          body: {
            name: '新商户',
            username: `new_${suffix}`,
            password: 'account-pass-1',
            expiresAt: future.toISOString(),
            billingMode: 'SHADOW',
            initialPoints: 0,
          },
        },
      );
      expect(created.status).toBe(200);
      expect(created.data.username).toBe(`new_${suffix}`);
      const replay = await call<{ id: string }>(base, 'POST', '/api/v1/admin/tenants', {
        token: adminToken,
        headers: { 'idempotency-key': `open${suffix}01` },
        body: {
          name: '新商户',
          username: `new_${suffix}`,
          password: 'account-pass-1',
          expiresAt: future.toISOString(),
        },
      });
      expect(replay.status).toBe(200);
      expect(replay.data.id).toBe(created.data.id);

      const renamed = await call<{ name: string }>(
        base,
        'PATCH',
        `/api/v1/admin/tenants/${created.data.id}`,
        { token: adminToken, body: { name: '新商户已改' } },
      );
      expect(renamed.data.name).toBe('新商户已改');
      const missing = await call(base, 'GET', '/api/v1/admin/tenants/missing_tenant', {
        token: adminToken,
      });
      expect(missing.status).toBe(404);
    });

    it('updates quotas, prices, announcements and system templates', async () => {
      const started = app;
      const database = prisma;
      if (!started || !database) throw new Error('app was not started');
      const captcha = started.get(CaptchaService);
      const adminToken = await login(captcha, base, `admin_${suffix}`, password);
      const merchantToken = await login(captcha, base, `merchant_${suffix}`, password);
      const quotas = await call(base, 'PUT', `/api/v1/admin/tenants/${tenantA}/quotas`, {
        token: adminToken,
        body: { items: [{ key: 'MAIN_KEYWORD', limit: '120' }] },
      });
      expect(quotas.status).toBe(200);
      const rights = await call<{ cards: Array<{ key: string; text: string }> }>(
        base,
        'GET',
        '/api/v1/me/rights',
        { token: merchantToken },
      );
      expect(rights.data.cards.find((card) => card.key === 'MAIN_KEYWORD')?.text).toBe('0 / 120');
      const priced = await call<{ items: Array<{ action: string; unitPoints: number }> }>(
        base,
        'PATCH',
        '/api/v1/admin/pricing',
        {
          token: adminToken,
          body: { action: 'ai_write', unitPoints: 12, enabled: true },
        },
      );
      expect(priced.status).toBe(200);
      expect(priced.data.items.find((item) => item.action === 'ai_write')?.unitPoints).toBe(12);

      const batchPriced = await call<{
        items: Array<{ action: string; unitPoints: number; enabled: boolean; label: string }>;
      }>(base, 'PUT', '/api/v1/admin/pricing', {
        token: adminToken,
        body: {
          items: [
            { action: 'ai_write', unitPoints: 10, enabled: true },
            { action: 'kb_addon', unitPoints: 6, enabled: true },
          ],
        },
      });
      expect(batchPriced.status).toBe(200);
      expect(batchPriced.data.items.find((item) => item.action === 'kb_addon')?.unitPoints).toBe(6);

      const announcement = await call<{
        id: string;
        operatorName: string | null;
        createdAt: string | null;
      }>(base, 'POST', '/api/v1/admin/announcements', {
        token: adminToken,
        body: { content: 'GeoMix 维护公告', enabled: true, sort: 1 },
      });
      expect(announcement.status).toBe(200);
      expect(announcement.data.operatorName).toBe(`admin_${suffix}`);
      expect(announcement.data.createdAt).toBeTruthy();

      const editedAnnouncement = await call<{ id: string; content: string }>(
        base,
        'PATCH',
        `/api/v1/admin/announcements/${announcement.data.id}`,
        {
          token: adminToken,
          body: { content: 'GeoMix 维护公告（已更新）', enabled: true, sort: 1 },
        },
      );
      expect(editedAnnouncement.status).toBe(200);
      expect(editedAnnouncement.data.content).toBe('GeoMix 维护公告（已更新）');

      const feed = await call<{ items: Array<{ content: string }> }>(
        base,
        'GET',
        '/api/v1/announcements',
        { token: merchantToken },
      );
      expect(feed.data.items.some((item) => item.content === 'GeoMix 维护公告（已更新）')).toBe(
        true,
      );

      const merchantDeleteAnnouncement = await call(
        base,
        'DELETE',
        `/api/v1/admin/announcements/${announcement.data.id}`,
        { token: merchantToken },
      );
      expect(merchantDeleteAnnouncement.status).toBe(404);

      const deletedAnnouncement = await call<{ deleted: boolean; id: string }>(
        base,
        'DELETE',
        `/api/v1/admin/announcements/${announcement.data.id}`,
        { token: adminToken },
      );
      expect(deletedAnnouncement.status).toBe(200);
      expect(deletedAnnouncement.data).toEqual({
        deleted: true,
        id: announcement.data.id,
      });

      const template = await call<{ id: string; name: string }>(
        base,
        'POST',
        '/api/v1/admin/templates',
        {
          token: adminToken,
          body: {
            kind: 'ARTICLE',
            name: '系统·占位说明',
            content: '用自己的事实写一段说明，不要编造数据。',
            randomPool: true,
            sort: 9,
          },
        },
      );
      expect(template.status).toBe(200);
      const edited = await call<{ name: string }>(
        base,
        'PATCH',
        `/api/v1/admin/templates/${template.data.id}`,
        {
          token: adminToken,
          body: {
            kind: 'ARTICLE',
            name: '系统·占位说明改',
            content: '仍然使用 GeoMix 自写说明。',
            randomPool: false,
            sort: 9,
          },
        },
      );
      expect(edited.data.name).toBe('系统·占位说明改');
      const merchantTemplate = await call(
        base,
        'PATCH',
        `/api/v1/admin/templates/${template.data.id}`,
        {
          token: merchantToken,
          body: {
            kind: 'ARTICLE',
            name: '不该改',
            content: '不该改',
            randomPool: true,
            sort: 1,
          },
        },
      );
      expect(merchantTemplate.status).toBe(404);
      const audits = await database.base.auditLog.count({
        where: {
          action: { in: ['quota_update', 'pricing_update', 'announcement_save', 'template_save'] },
        },
      });
      expect(audits).toBeGreaterThanOrEqual(4);
    });

    it('searches tenant names as literals for percent, underscore, and backslash', async () => {
      const started = app;
      const database = prisma;
      if (!started || !database) throw new Error('app was not started');
      await database.base.tenant.createMany({
        data: [
          { id: `acct_pct_${suffix}`, name: '平台100%', expiresAt: future },
          { id: `acct_bar_${suffix}`, name: '商户乙foo_bar', expiresAt: future },
          { id: `acct_slash_${suffix}`, name: '路径a\\b', expiresAt: future },
        ],
      });
      const captcha = started.get(CaptchaService);
      const adminToken = await login(captcha, base, `admin_${suffix}`, password);
      const all = await tenantNames(base, adminToken, '');
      expect(all.length).toBeGreaterThan(3);
      expect(all).toEqual(
        expect.arrayContaining(['商户甲', '平台100%', '商户乙foo_bar', '路径a\\b']),
      );

      const percent = await tenantNames(base, adminToken, '%');
      expect(percent).toEqual(['平台100%']);
      const underscore = await tenantNames(base, adminToken, '_');
      expect(underscore).toEqual(['商户乙foo_bar']);
      const slash = await tenantNames(base, adminToken, '\\');
      expect(slash).toEqual(['路径a\\b']);
    });

    it('keeps verification as a placeholder and blocks expired writes', async () => {
      const started = app;
      if (!started) throw new Error('app was not started');
      const captcha = started.get(CaptchaService);
      const merchantToken = await login(captcha, base, `merchant_${suffix}`, password);
      const expiredToken = await login(captcha, base, `expired_${suffix}`, password);
      const saved = await call<{ status: string; placeholder: boolean }>(
        base,
        'POST',
        '/api/v1/me/verification',
        {
          token: merchantToken,
          body: {
            companyName: '示例主体',
            creditCode: '91310000ABCD1234',
            contact: '林可',
            phone: '13800000000',
          },
        },
      );
      expect(saved.status).toBe(200);
      expect(saved.data).toMatchObject({ status: 'SUBMITTED', placeholder: true });
      const read = await call<{ status: string }>(base, 'GET', '/api/v1/me/verification', {
        token: merchantToken,
      });
      expect(read.data.status).toBe('SUBMITTED');
      const expiredRead = await call(base, 'GET', '/api/v1/me/rights', { token: expiredToken });
      expect(expiredRead.status).toBe(200);
      expect(expiredRead.code).toBe(0);
      const expiredWrite = await call(base, 'POST', '/api/v1/me/verification', {
        token: expiredToken,
        body: {
          companyName: '到期主体',
          creditCode: '91310000ABCD9999',
        },
      });
      expect(expiredWrite.status).toBe(403);
      expect(expiredWrite.code).toBe(API_ERROR.TENANT_EXPIRED);
    });
  },
);

async function tenantNames(base: string, token: string, keyword: string): Promise<string[]> {
  const query = new URLSearchParams({ pageSize: '50' });
  if (keyword) query.set('keyword', keyword);
  const result = await call<{ items: Array<{ name: string }>; total: number }>(
    base,
    'GET',
    `/api/v1/admin/tenants?${query.toString()}`,
    { token },
  );
  expect(result.status, result.msg).toBe(200);
  expect(result.data.total).toBe(result.data.items.length);
  return result.data.items.map((item) => item.name).sort();
}

async function call<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Envelope<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json()) as Omit<Envelope<T>, 'status'>;
  return { status: response.status, ...payload };
}

async function login(
  captcha: CaptchaService,
  base: string,
  username: string,
  password: string,
): Promise<string> {
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
  return response.data.accessToken;
}

function assertDbName(name: string): void {
  if (!/^geomix_acct_[a-z0-9]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
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
