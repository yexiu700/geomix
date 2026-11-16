import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, hashPassword } from '@geomix/db';
import { API_ERROR, AUTH_ERROR, PRICING_DEFAULTS } from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { PrismaService } from '../prisma/prisma.service';
import { CaptchaService } from '../auth/captcha.service';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const adminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

type Envelope<T> = {
  status: number;
  code: number;
  msg: string;
  data: T;
  contentType: string;
  raw: Buffer;
};

describe('sample routes without a database', () => {
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

  it('rejects an anonymous list before querying', async () => {
    const missing = await call(base, 'GET', '/api/v1/workbench/samples');
    expect(missing.status).toBe(401);
    expect(missing.code).toBe(AUTH_ERROR.UNAUTHORIZED);
    const write = await call(base, 'POST', '/api/v1/workbench/samples', {
      body: { name: '甲' },
    });
    expect(write.status).toBe(401);
    expect(write.code).toBe(AUTH_ERROR.UNAUTHORIZED);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'sample crud against isolated Postgres',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `geomix_crud_${suffix}`;
    let previousDatabaseUrl: string | undefined;
    let app: INestApplication | undefined;
    let base = '';
    let prisma: PrismaService | undefined;

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
      process.env.DATABASE_URL = isolatedUrl;
      app = await createApiApp();
      await app.listen(0);
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const database = app.get(PrismaService);
      prisma = database;
      for (const item of PRICING_DEFAULTS) {
        await database.base.pricingItem.create({
          data: { action: item.action, unitPoints: item.unitPoints, enabled: true },
        });
      }
    }, 120_000);

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.onModuleDestroy();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      adminSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }, 60_000);

    it('keeps writes inside the tenant and does not charge or read chunks', async () => {
      const future = new Date('2027-11-16T00:00:00.000Z');
      const past = new Date('2020-01-01T00:00:00.000Z');
      const tenantA = `crud_a_${suffix}`;
      const tenantB = `crud_b_${suffix}`;
      const tenantExpired = `crud_e_${suffix}`;
      const password = 'sample-pass-1';
      const hash = hashPassword(password);
      await prisma?.base.tenant.createMany({
        data: [
          { id: tenantA, name: '示例甲', expiresAt: future },
          { id: tenantB, name: '示例乙', expiresAt: future },
          { id: tenantExpired, name: '示例到期', expiresAt: past },
        ],
      });
      await prisma?.base.wallet.createMany({
        data: [tenantA, tenantB, tenantExpired].map((tenantId) => ({
          tenantId,
          points: 1000,
          pointsReserved: 0,
        })),
      });
      await prisma?.base.user.createMany({
        data: [
          { id: `user_${tenantA}`, tenantId: tenantA, username: `a_${suffix}`, passwordHash: hash },
          { id: `user_${tenantB}`, tenantId: tenantB, username: `b_${suffix}`, passwordHash: hash },
          {
            id: `user_${tenantExpired}`,
            tenantId: tenantExpired,
            username: `e_${suffix}`,
            passwordHash: hash,
          },
        ],
      });

      const captcha = app?.get(CaptchaService);
      if (!captcha || !prisma) throw new Error('app was not started');
      const tokenA = await login(captcha, base, `a_${suffix}`, password);
      const tokenB = await login(captcha, base, `b_${suffix}`, password);
      const tokenExpired = await login(captcha, base, `e_${suffix}`, password);

      const health = await call(base, 'GET', '/api/v1/health');
      expect(health.data).toMatchObject({ billingMode: 'SHADOW' });
      const prices = await call<{
        items: Array<{ action: string; unitPoints: number; label: string }>;
      }>(base, 'GET', '/api/v1/pricing', { token: tokenA });
      expect(prices.status).toBe(200);
      expect(prices.data.items.find((item) => item.action === 'ai_write')).toMatchObject({
        unitPoints: 10,
        label: 'AI写作',
      });

      const rejected = await call(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenA,
        body: { name: '甲', tenantId: tenantB },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.code).toBe(API_ERROR.BAD_REQUEST);

      const created = await call<{ id: string; name: string }>(
        base,
        'POST',
        '/api/v1/workbench/samples',
        {
          token: tokenA,
          body: { name: '示例甲', note: '说明', enabled: true },
        },
      );
      expect(created.status).toBe(200);
      expect(created.data.name).toBe('示例甲');
      const duplicate = await call(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenA,
        body: { name: '示例甲' },
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.msg).toBe('名称已存在');
      const own = await call<{ name: string }>(
        base,
        'GET',
        `/api/v1/workbench/samples/${created.data.id}`,
        {
          token: tokenA,
        },
      );
      expect(own.status).toBe(200);
      expect(own.data.name).toBe('示例甲');
      const sameName = await call<{ id: string }>(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenB,
        body: { name: '示例甲', note: '乙的记录' },
      });
      expect(sameName.status).toBe(200);

      const hidden = await call(base, 'GET', `/api/v1/workbench/samples/${created.data.id}`, {
        token: tokenB,
      });
      expect(hidden.status).toBe(404);
      expect(hidden.code).toBe(AUTH_ERROR.NOT_FOUND);
      const listed = await call<{ items: Array<{ id: string }>; total: number }>(
        base,
        'GET',
        '/api/v1/workbench/samples?page=1&pageSize=10',
        { token: tokenB },
      );
      expect(listed.data.total).toBe(1);
      expect(listed.data.items.map((item) => item.id)).not.toContain(created.data.id);

      const badPage = await call(base, 'GET', '/api/v1/workbench/samples?pageSize=20', {
        token: tokenA,
      });
      expect(badPage.status).toBe(400);
      expect(badPage.msg).toBe('分页不正确');
      const badFilter = await call(
        base,
        'GET',
        `/api/v1/workbench/samples?filter=${encodeURIComponent(JSON.stringify({ tenantId: tenantB }))}`,
        { token: tokenA },
      );
      expect(badFilter.status).toBe(400);
      expect(badFilter.msg).toBe('筛选不正确');

      const updated = await call<{ note: string }>(
        base,
        'PATCH',
        `/api/v1/workbench/samples/${created.data.id}`,
        { token: tokenA, body: { name: '示例甲', note: '已改', enabled: false } },
      );
      expect(updated.status).toBe(200);
      expect(updated.data.note).toBe('已改');
      const crossed = await call(base, 'PATCH', `/api/v1/workbench/samples/${created.data.id}`, {
        token: tokenB,
        body: { name: '被改', note: '', enabled: true },
      });
      expect(crossed.status).toBe(404);
      expect(
        (await prisma.base.crudSample.findUniqueOrThrow({ where: { id: created.data.id } })).name,
      ).toBe('示例甲');

      const mixed = await call(base, 'POST', '/api/v1/workbench/samples/bulk', {
        token: tokenA,
        body: { action: 'delete', ids: [created.data.id, sameName.data.id] },
      });
      expect(mixed.status).toBe(404);
      expect(await prisma.base.crudSample.count({ where: { tenantId: tenantA } })).toBe(1);
      expect(await prisma.base.crudSample.count({ where: { tenantId: tenantB } })).toBe(1);

      const enabled = await call<{ affected: number }>(
        base,
        'POST',
        '/api/v1/workbench/samples/bulk',
        {
          token: tokenA,
          body: { action: 'enable', ids: [created.data.id] },
        },
      );
      expect(enabled.data.affected).toBe(1);

      const expiredRead = await call<{ total: number }>(base, 'GET', '/api/v1/workbench/samples', {
        token: tokenExpired,
      });
      expect(expiredRead.status).toBe(200);
      expect(expiredRead.data.total).toBe(0);
      const expiredWrite = await call(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenExpired,
        body: { name: '不能写' },
      });
      expect(expiredWrite.status).toBe(403);
      expect(expiredWrite.code).toBe(API_ERROR.TENANT_EXPIRED);

      const exported = await call(base, 'GET', '/api/v1/workbench/samples?export=csv', {
        token: tokenA,
      });
      expect(exported.status).toBe(200);
      expect(exported.contentType).toContain('text/csv');
      expect(exported.raw.toString('utf8')).toContain('示例甲');
      expect(exported.raw.toString('utf8')).not.toContain('乙的记录');

      for (const tenantId of [tenantA, tenantB, tenantExpired]) {
        const wallet = await prisma.base.wallet.findUniqueOrThrow({ where: { tenantId } });
        expect(wallet.points).toBe(1000);
        expect(wallet.pointsReserved).toBe(0);
      }
      expect(await prisma.base.pointLog.count()).toBe(0);
      expect(await prisma.base.knowledgeChunk.count()).toBe(0);
    });

    it('matches percent, underscore and backslash as literal text inside the tenant', async () => {
      const captcha = app?.get(CaptchaService);
      if (!captcha || !prisma) throw new Error('app was not started');
      const future = new Date('2027-11-16T00:00:00.000Z');
      const tenantA = `lit_a_${suffix}`;
      const tenantB = `lit_b_${suffix}`;
      const password = 'sample-pass-1';
      const hash = hashPassword(password);
      await prisma.base.tenant.createMany({
        data: [
          { id: tenantA, name: '字面甲', expiresAt: future },
          { id: tenantB, name: '字面乙', expiresAt: future },
        ],
      });
      await prisma.base.user.createMany({
        data: [
          {
            id: `user_${tenantA}`,
            tenantId: tenantA,
            username: `la_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantB}`,
            tenantId: tenantB,
            username: `lb_${suffix}`,
            passwordHash: hash,
          },
        ],
      });
      const tokenA = await login(captcha, base, `la_${suffix}`, password);
      const tokenB = await login(captcha, base, `lb_${suffix}`, password);
      const ownRows = [
        { name: '100%', note: '' },
        { name: '甲十', note: '' },
        { name: '十一', note: '' },
        { name: '%十', note: '' },
        { name: 'foo_bar', note: '' },
        { name: 'fooXbar', note: '' },
        { name: 'a\\b', note: '' },
        { name: '50%_off', note: '' },
        { name: '中文甲', note: 'english' },
        { name: 'Alpha', note: '' },
        { name: '填充一', note: '' },
        { name: '填充二', note: '' },
        { name: '填充三', note: '' },
        { name: '下划备注', note: '_' },
        { name: '斜杠备注', note: '\\' },
      ];
      for (const row of ownRows) {
        const created = await call(base, 'POST', '/api/v1/workbench/samples', {
          token: tokenA,
          body: { name: row.name, note: row.note, enabled: true },
        });
        expect(created.status, created.msg).toBe(200);
      }
      const other = await call<{ id: string }>(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenB,
        body: { name: '100%', note: '乙百分', enabled: true },
      });
      expect(other.status).toBe(200);
      const otherBar = await call(base, 'POST', '/api/v1/workbench/samples', {
        token: tokenB,
        body: { name: 'foo_bar', note: '', enabled: true },
      });
      expect(otherBar.status).toBe(200);

      expect(await names(base, tokenA, '%')).toEqual(['%十', '100%', '50%_off'].sort());
      expect(await names(base, tokenA, '%十')).toEqual(['%十']);
      expect(await names(base, tokenA, '甲十')).toEqual(['甲十']);
      expect(await names(base, tokenA, '_')).toEqual(['50%_off', 'foo_bar', '下划备注']);
      expect(await names(base, tokenA, 'foo_bar')).toEqual(['foo_bar']);
      expect(await names(base, tokenA, '\\')).toEqual(['a\\b', '斜杠备注']);
      expect(await names(base, tokenA, '50%_')).toEqual(['50%_off']);
      expect(await names(base, tokenA, '中文')).toEqual(['中文甲']);
      expect(await names(base, tokenA, 'english')).toEqual(['中文甲']);
      expect(await names(base, tokenA, 'alpha')).toEqual(['Alpha']);
      expect(await names(base, tokenB, '%')).toEqual(['100%']);
      expect(await names(base, tokenB, 'foo_bar')).toEqual(['foo_bar']);
      const leaked = await call<{ items: Array<{ id: string }> }>(
        base,
        'GET',
        `/api/v1/workbench/samples?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ keyword: '%' }))}`,
        { token: tokenA },
      );
      expect(leaked.data.items.map((item) => item.id)).not.toContain(other.data.id);
    });
  },
);

async function names(base: string, token: string, keyword: string): Promise<string[]> {
  const result = await call<{ items: Array<{ name: string }>; total: number }>(
    base,
    'GET',
    `/api/v1/workbench/samples?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ keyword }))}`,
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
  const raw = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType === '') {
    const payload = JSON.parse(raw.toString('utf8')) as Omit<
      Envelope<T>,
      'status' | 'contentType' | 'raw'
    >;
    return { status: response.status, contentType, raw, ...payload };
  }
  return {
    status: response.status,
    code: 0,
    msg: '',
    data: undefined as T,
    contentType,
    raw,
  };
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
  if (!/^geomix_crud_[a-z0-9]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
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
