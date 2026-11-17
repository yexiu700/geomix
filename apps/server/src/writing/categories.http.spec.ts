import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, hashPassword } from '@geomix/db';
import { API_ERROR, AUTH_ERROR, articleCountsAsRemaining } from '@geomix/shared';
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

type CategoryRow = {
  id: string;
  name: string;
  total: number;
  remaining: number;
  createdAt: string;
};

type ArticleRow = {
  id: string;
  title: string;
  status: string;
  sendCount: number;
  countsAsRemaining: boolean;
};

describe('article category routes without a database', () => {
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
    const missing = await call(base, 'GET', '/api/v1/writing/categories');
    expect(missing.status).toBe(401);
    expect(missing.code).toBe(AUTH_ERROR.UNAUTHORIZED);
    const write = await call(base, 'POST', '/api/v1/writing/categories', {
      body: { name: '甲' },
    });
    expect(write.status).toBe(401);
    expect(write.code).toBe(AUTH_ERROR.UNAUTHORIZED);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'article categories against isolated Postgres',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `geomix_wcat_${suffix}`;
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
      prisma = app.get(PrismaService);
    }, 120_000);

    afterAll(async () => {
      if (app) await app.close();
      if (prisma) await prisma.onModuleDestroy();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      adminSql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }, 60_000);

    it('keeps category writes inside the tenant and blocks expired accounts', async () => {
      const future = new Date('2027-11-16T00:00:00.000Z');
      const past = new Date('2020-01-01T00:00:00.000Z');
      const tenantA = `cat_a_${suffix}`;
      const tenantB = `cat_b_${suffix}`;
      const tenantExpired = `cat_e_${suffix}`;
      const password = 'category-pass-1';
      const hash = hashPassword(password);
      const database = needPrisma(prisma);
      await database.base.tenant.createMany({
        data: [
          { id: tenantA, name: '分类甲', expiresAt: future },
          { id: tenantB, name: '分类乙', expiresAt: future },
          { id: tenantExpired, name: '分类到期', expiresAt: past },
        ],
      });
      await database.base.wallet.createMany({
        data: [tenantA, tenantB, tenantExpired].map((tenantId) => ({
          tenantId,
          points: 1000,
          pointsReserved: 0,
        })),
      });
      await database.base.user.createMany({
        data: [
          {
            id: `user_${tenantA}`,
            tenantId: tenantA,
            username: `ca_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantB}`,
            tenantId: tenantB,
            username: `cb_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantExpired}`,
            tenantId: tenantExpired,
            username: `ce_${suffix}`,
            passwordHash: hash,
          },
        ],
      });
      const captcha = app?.get(CaptchaService);
      if (!captcha) throw new Error('app was not started');
      const tokenA = await login(captcha, base, `ca_${suffix}`, password);
      const tokenB = await login(captcha, base, `cb_${suffix}`, password);
      const tokenExpired = await login(captcha, base, `ce_${suffix}`, password);

      const rejected = await call(base, 'POST', '/api/v1/writing/categories', {
        token: tokenA,
        body: { name: '甲', tenantId: tenantB },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.code).toBe(API_ERROR.BAD_REQUEST);

      const created = await call<CategoryRow>(base, 'POST', '/api/v1/writing/categories', {
        token: tokenA,
        body: { name: '  测试分类  ' },
      });
      expect(created.status, created.msg).toBe(200);
      expect(created.data.name).toBe('测试分类');
      expect(created.data.total).toBe(0);
      expect(created.data.remaining).toBe(0);

      const duplicate = await call(base, 'POST', '/api/v1/writing/categories', {
        token: tokenA,
        body: { name: '测试分类' },
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.msg).toBe('文章分类已存在');

      const sameName = await call<CategoryRow>(base, 'POST', '/api/v1/writing/categories', {
        token: tokenB,
        body: { name: '测试分类' },
      });
      expect(sameName.status).toBe(200);
      const hidden = await call(base, 'GET', `/api/v1/writing/categories/${created.data.id}`, {
        token: tokenB,
      });
      expect(hidden.status).toBe(404);
      expect(hidden.code).toBe(AUTH_ERROR.NOT_FOUND);

      const renamed = await call<CategoryRow>(
        base,
        'PATCH',
        `/api/v1/writing/categories/${created.data.id}`,
        { token: tokenA, body: { name: '已改分类' } },
      );
      expect(renamed.status).toBe(200);
      expect(renamed.data.name).toBe('已改分类');
      const crossed = await call(base, 'PATCH', `/api/v1/writing/categories/${created.data.id}`, {
        token: tokenB,
        body: { name: '被改' },
      });
      expect(crossed.status).toBe(404);
      expect(
        (await database.base.articleCategory.findUniqueOrThrow({ where: { id: created.data.id } }))
          .name,
      ).toBe('已改分类');

      const listed = await call<{ items: CategoryRow[]; total: number }>(
        base,
        'GET',
        '/api/v1/writing/categories?page=1&pageSize=10',
        { token: tokenB },
      );
      expect(listed.data.total).toBe(1);
      expect(listed.data.items.map((item) => item.id)).not.toContain(created.data.id);

      const badPage = await call(base, 'GET', '/api/v1/writing/categories?pageSize=20', {
        token: tokenA,
      });
      expect(badPage.status).toBe(400);
      expect(badPage.msg).toBe('分页不正确');
      const badFilter = await call(
        base,
        'GET',
        `/api/v1/writing/categories?filter=${encodeURIComponent(JSON.stringify({ tenantId: tenantB }))}`,
        { token: tokenA },
      );
      expect(badFilter.status).toBe(400);
      expect(badFilter.msg).toBe('筛选不正确');

      const expiredRead = await call<{ total: number }>(base, 'GET', '/api/v1/writing/categories', {
        token: tokenExpired,
      });
      expect(expiredRead.status).toBe(200);
      expect(expiredRead.data.total).toBe(0);
      const expiredWrite = await call(base, 'POST', '/api/v1/writing/categories', {
        token: tokenExpired,
        body: { name: '不能写' },
      });
      expect(expiredWrite.status).toBe(403);
      expect(expiredWrite.code).toBe(API_ERROR.TENANT_EXPIRED);
      const expiredPatch = await call(
        base,
        'PATCH',
        `/api/v1/writing/categories/${created.data.id}`,
        { token: tokenExpired, body: { name: '不能改' } },
      );
      expect(expiredPatch.status).toBe(403);

      const exported = await call(base, 'GET', '/api/v1/writing/categories?export=csv', {
        token: tokenA,
      });
      expect(exported.status).toBe(200);
      expect(exported.contentType).toContain('text/csv');
      expect(exported.raw.toString('utf8')).toContain('已改分类');
      expect(exported.raw.toString('utf8')).not.toContain('测试分类');

      const removed = await call<{ affected: number }>(
        base,
        'POST',
        '/api/v1/writing/categories/bulk',
        { token: tokenA, body: { action: 'delete', ids: [created.data.id] } },
      );
      expect(removed.status).toBe(200);
      expect(removed.data.affected).toBe(1);
      const gone = await call(base, 'GET', `/api/v1/writing/categories/${created.data.id}`, {
        token: tokenA,
      });
      expect(gone.status).toBe(404);
      const mixed = await call(base, 'POST', '/api/v1/writing/categories/bulk', {
        token: tokenA,
        body: { action: 'delete', ids: [sameName.data.id] },
      });
      expect(mixed.status).toBe(404);
      expect(await database.base.articleCategory.count({ where: { id: sameName.data.id } })).toBe(
        1,
      );

      for (const tenantId of [tenantA, tenantB, tenantExpired]) {
        const wallet = await database.base.wallet.findUniqueOrThrow({ where: { tenantId } });
        expect(wallet.points).toBe(1000);
        expect(wallet.pointsReserved).toBe(0);
      }
      expect(await database.base.pointLog.count()).toBe(0);
    });

    it('recomputes remaining from normal unsent articles when status or send count changes', async () => {
      const future = new Date('2027-11-16T00:00:00.000Z');
      const tenantA = `agg_a_${suffix}`;
      const tenantB = `agg_b_${suffix}`;
      const password = 'category-pass-1';
      const hash = hashPassword(password);
      const database = needPrisma(prisma);
      await database.base.tenant.createMany({
        data: [
          { id: tenantA, name: '统计甲', expiresAt: future },
          { id: tenantB, name: '统计乙', expiresAt: future },
        ],
      });
      await database.base.user.createMany({
        data: [
          {
            id: `user_${tenantA}`,
            tenantId: tenantA,
            username: `aa_${suffix}`,
            passwordHash: hash,
          },
          {
            id: `user_${tenantB}`,
            tenantId: tenantB,
            username: `ab_${suffix}`,
            passwordHash: hash,
          },
        ],
      });
      const captcha = app?.get(CaptchaService);
      if (!captcha) throw new Error('app was not started');
      const tokenA = await login(captcha, base, `aa_${suffix}`, password);
      const tokenB = await login(captcha, base, `ab_${suffix}`, password);

      const primary = await call<CategoryRow>(base, 'POST', '/api/v1/writing/categories', {
        token: tokenA,
        body: { name: '统计甲' },
      });
      const empty = await call<CategoryRow>(base, 'POST', '/api/v1/writing/categories', {
        token: tokenA,
        body: { name: '统计乙' },
      });
      expect(primary.status).toBe(200);
      expect(empty.status).toBe(200);

      const manual = await insertArticle(database, {
        tenantId: tenantA,
        categoryId: primary.data.id,
        title: '手动正常',
        status: 'NORMAL',
        sendCount: 0,
        source: 'MANUAL',
      });
      await insertArticle(database, {
        tenantId: tenantA,
        categoryId: primary.data.id,
        title: '已发送',
        status: 'NORMAL',
        sendCount: 3,
      });
      const pending = await insertArticle(database, {
        tenantId: tenantA,
        categoryId: primary.data.id,
        title: '待审核稿',
        status: 'PENDING',
        sendCount: 0,
      });
      await insertArticle(database, {
        tenantId: tenantA,
        categoryId: primary.data.id,
        title: '已停用',
        status: 'DISABLED',
        sendCount: 0,
      });
      const generated = await insertArticle(database, {
        tenantId: tenantA,
        categoryId: primary.data.id,
        title: '任务正常',
        status: 'NORMAL',
        sendCount: 0,
        source: 'AI_TASK',
      });
      await insertArticle(database, {
        tenantId: tenantA,
        categoryId: empty.data.id,
        title: '另一分类',
        status: 'NORMAL',
        sendCount: 0,
      });
      const foreign = await insertArticle(database, {
        tenantId: tenantB,
        categoryId: primary.data.id,
        title: '乙的文章',
        status: 'NORMAL',
        sendCount: 0,
      });

      const first = await categoryByName(base, tokenA, '统计甲');
      expect(first).toMatchObject({ total: 5, remaining: 2 });
      expect(await categoryByName(base, tokenA, '统计乙')).toMatchObject({
        total: 1,
        remaining: 1,
      });
      const ordered = await call<{ items: CategoryRow[] }>(
        base,
        'GET',
        '/api/v1/writing/categories?sort=remaining&order=desc&pageSize=10',
        { token: tokenA },
      );
      expect(ordered.data.items.map((item) => item.name)).toEqual(['统计甲', '统计乙']);
      expect(articleCountsAsRemaining('NORMAL', 0)).toBe(true);

      await database.base.article.update({
        where: { id: pending.id },
        data: { status: 'NORMAL' },
      });
      expect(await categoryByName(base, tokenA, '统计甲')).toMatchObject({
        total: 5,
        remaining: 3,
      });

      await database.base.article.update({
        where: { id: manual.id },
        data: { sendCount: 1 },
      });
      expect(await categoryByName(base, tokenA, '统计甲')).toMatchObject({
        total: 5,
        remaining: 2,
      });

      await database.base.article.delete({ where: { id: generated.id } });
      expect(await categoryByName(base, tokenA, '统计甲')).toMatchObject({
        total: 4,
        remaining: 1,
      });

      const articles = await call<{
        category: CategoryRow;
        items: ArticleRow[];
        total: number;
      }>(base, 'GET', `/api/v1/writing/articles?categoryId=${primary.data.id}&taskId=ignored`, {
        token: tokenA,
      });
      expect(articles.status).toBe(200);
      expect(articles.data.category).toMatchObject({ name: '统计甲', total: 4, remaining: 1 });
      expect(articles.data.total).toBe(4);
      expect(articles.data.items.map((item) => item.title).sort()).toEqual(
        ['手动正常', '已发送', '待审核稿', '已停用'].sort(),
      );
      expect(articles.data.items.map((item) => item.title)).not.toContain('乙的文章');
      expect(articles.data.items.map((item) => item.title)).not.toContain('另一分类');
      const stillRemaining = articles.data.items.find((item) => item.title === '待审核稿');
      expect(stillRemaining).toMatchObject({
        status: 'NORMAL',
        sendCount: 0,
        countsAsRemaining: true,
      });
      const sent = articles.data.items.find((item) => item.title === '手动正常');
      expect(sent).toMatchObject({ sendCount: 1, countsAsRemaining: false });

      const hiddenArticles = await call(
        base,
        'GET',
        `/api/v1/writing/articles?categoryId=${primary.data.id}`,
        { token: tokenB },
      );
      expect(hiddenArticles.status).toBe(404);
      expect(hiddenArticles.raw.toString('utf8')).not.toContain('手动正常');

      const keyword = await database.base.keyword.create({
        data: { tenantId: tenantA, main: `主词${suffix}` },
      });
      const media = await database.base.mediaCategory.create({
        data: { tenantId: tenantA, name: `图库${suffix}` },
      });
      await database.base.aiTask.create({
        data: {
          tenantId: tenantA,
          name: '占用分类',
          categoryId: empty.data.id,
          keywordId: keyword.id,
          mediaCategoryId: media.id,
          target: 1,
          unitPrice: 10,
          seed: 1,
        },
      });
      const blocked = await call(base, 'POST', '/api/v1/writing/categories/bulk', {
        token: tokenA,
        body: { action: 'delete', ids: [empty.data.id] },
      });
      expect(blocked.status).toBe(400);
      expect(blocked.msg).toBe('该分类正在被写作任务或复刻任务使用，不能删除');
      expect(await database.base.articleCategory.count({ where: { id: empty.data.id } })).toBe(1);

      const deleted = await call(base, 'POST', '/api/v1/writing/categories/bulk', {
        token: tokenA,
        body: { action: 'delete', ids: [primary.data.id] },
      });
      expect(deleted.status).toBe(200);
      const orphan = await database.base.article.findUniqueOrThrow({ where: { id: manual.id } });
      expect(orphan.categoryId).toBeNull();
      const foreignRow = await database.base.article.findUniqueOrThrow({
        where: { id: foreign.id },
      });
      expect(foreignRow.categoryId).toBeNull();
      expect(await database.base.pointLog.count()).toBe(0);
    });

    it('matches percent, underscore and backslash as literal category names', async () => {
      const future = new Date('2027-11-16T00:00:00.000Z');
      const tenantA = `lit_a_${suffix}`;
      const tenantB = `lit_b_${suffix}`;
      const password = 'category-pass-1';
      const hash = hashPassword(password);
      const database = needPrisma(prisma);
      await database.base.tenant.createMany({
        data: [
          { id: tenantA, name: '字面甲', expiresAt: future },
          { id: tenantB, name: '字面乙', expiresAt: future },
        ],
      });
      await database.base.user.createMany({
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
      const captcha = app?.get(CaptchaService);
      if (!captcha) throw new Error('app was not started');
      const tokenA = await login(captcha, base, `la_${suffix}`, password);
      const tokenB = await login(captcha, base, `lb_${suffix}`, password);
      for (const name of [
        '100%',
        '%十',
        '甲十',
        'foo_bar',
        'fooXbar',
        'a\\b',
        '50%_off',
        'Alpha',
      ]) {
        const created = await call(base, 'POST', '/api/v1/writing/categories', {
          token: tokenA,
          body: { name },
        });
        expect(created.status, created.msg).toBe(200);
      }
      const other = await call<CategoryRow>(base, 'POST', '/api/v1/writing/categories', {
        token: tokenB,
        body: { name: '100%' },
      });
      expect(other.status).toBe(200);

      expect(await names(base, tokenA, '%')).toEqual(['%十', '100%', '50%_off'].sort());
      expect(await names(base, tokenA, '%十')).toEqual(['%十']);
      expect(await names(base, tokenA, '_')).toEqual(['50%_off', 'foo_bar']);
      expect(await names(base, tokenA, 'foo_bar')).toEqual(['foo_bar']);
      expect(await names(base, tokenA, '\\')).toEqual(['a\\b']);
      expect(await names(base, tokenA, '50%_')).toEqual(['50%_off']);
      expect(await names(base, tokenA, 'alpha')).toEqual(['Alpha']);
      expect(await names(base, tokenB, '%')).toEqual(['100%']);
      const leaked = await call<{ items: CategoryRow[] }>(
        base,
        'GET',
        `/api/v1/writing/categories?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ keyword: '%' }))}`,
        { token: tokenA },
      );
      expect(leaked.data.items.map((item) => item.id)).not.toContain(other.data.id);
    });
  },
);

function needPrisma(prisma: PrismaService | undefined): PrismaService {
  if (!prisma) throw new Error('database was not started');
  return prisma;
}

async function categoryByName(base: string, token: string, name: string): Promise<CategoryRow> {
  const result = await call<{ items: CategoryRow[] }>(
    base,
    'GET',
    `/api/v1/writing/categories?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ keyword: name }))}`,
    { token },
  );
  expect(result.status, result.msg).toBe(200);
  const row = result.data.items.find((item) => item.name === name);
  if (!row) throw new Error(`missing category ${name}`);
  return row;
}

async function names(base: string, token: string, keyword: string): Promise<string[]> {
  const result = await call<{ items: CategoryRow[]; total: number }>(
    base,
    'GET',
    `/api/v1/writing/categories?pageSize=50&filter=${encodeURIComponent(JSON.stringify({ keyword }))}`,
    { token },
  );
  expect(result.status, result.msg).toBe(200);
  expect(result.data.total).toBe(result.data.items.length);
  return result.data.items.map((item) => item.name).sort();
}

async function insertArticle(
  prisma: PrismaService,
  input: {
    tenantId: string;
    categoryId: string;
    title: string;
    status: 'PENDING' | 'NORMAL' | 'DISABLED';
    sendCount: number;
    source?: 'MANUAL' | 'AI_TASK';
  },
) {
  return prisma.base.article.create({
    data: {
      tenantId: input.tenantId,
      categoryId: input.categoryId,
      title: input.title,
      contentHtml: '<p>fixture</p>',
      contentText: 'fixture',
      status: input.status,
      source: input.source ?? 'MANUAL',
      sendCount: input.sendCount,
    },
  });
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
  expect(response.status, response.msg).toBe(200);
  return response.data.accessToken;
}

function assertDbName(name: string): void {
  if (!/^geomix_wcat_[a-z0-9]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
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
