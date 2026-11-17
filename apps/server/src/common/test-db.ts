import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, hashPassword } from '@geomix/db';
import { PRICING_DEFAULTS, QUOTA_DEFAULTS, type BillingMode } from '@geomix/shared';
import { CaptchaService } from '../auth/captcha.service';
import { PrismaService } from '../prisma/prisma.service';
import { createApiApp } from './create-api-app';

const serverRoot = process.cwd();
const dbPackageRoot = resolve(serverRoot, '../../packages/db');
const defaultAdminUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@127.0.0.1:5432/geomix?schema=public';

export type HttpEnvelope<T> = {
  status: number;
  code: number;
  msg: string;
  data: T;
  contentType: string;
  raw: Buffer;
};

export type IsolatedTestContext = {
  suffix: string;
  dbName: string;
  databaseUrl: string;
  app: INestApplication;
  base: string;
  prisma: PrismaService;
  createTenantUser: (opts?: {
    prefix?: string;
    points?: number;
    billingMode?: BillingMode | null;
    expired?: boolean;
    role?: 'MERCHANT' | 'ADMIN';
  }) => Promise<{ tenantId: string; userId: string; username: string; token: string }>;
  close: () => Promise<void>;
};

export async function createIsolatedTestContext(
  tag: string,
  customizeApp?: (builderEnv: () => Promise<INestApplication>) => Promise<INestApplication>,
): Promise<IsolatedTestContext> {
  const cleanTag =
    tag
      .replace(/[^a-z0-9_]/gi, '')
      .toLowerCase()
      .slice(0, 12) || 'spec';
  const suffix = randomBytes(4).toString('hex');
  const dbName = `geomix_${cleanTag}_${suffix}`;
  adminSql(defaultAdminUrl, `CREATE DATABASE "${dbName}"`);
  const isolatedUrl = replaceDbName(defaultAdminUrl, dbName);

  const setup = createPrismaClient(isolatedUrl);
  await setup.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await setup.$disconnect();

  const migrated = spawnSync('node', ['scripts/prisma-cli.mjs', 'migrate', 'deploy'], {
    cwd: dbPackageRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: isolatedUrl },
  });
  if (migrated.status !== 0) {
    throw new Error(`migrate deploy failed:\n${migrated.stdout}\n${migrated.stderr}`);
  }

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = isolatedUrl;

  const app = customizeApp ? await customizeApp(() => createApiApp()) : await createApiApp();
  await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const prisma = app.get(PrismaService);

  for (const item of PRICING_DEFAULTS) {
    await prisma.base.pricingItem.upsert({
      where: { action: item.action },
      update: { unitPoints: item.unitPoints, enabled: true },
      create: { action: item.action, unitPoints: item.unitPoints, enabled: true },
    });
  }

  let seq = 0;
  async function createTenantUser(opts?: {
    prefix?: string;
    points?: number;
    billingMode?: BillingMode | null;
    expired?: boolean;
    role?: 'MERCHANT' | 'ADMIN';
  }) {
    seq += 1;
    const prefix = opts?.prefix ?? `t${seq}`;
    const tenantId = `${prefix}_${suffix}_${seq}`;
    const userId = `u_${tenantId}`;
    const username = `${prefix}_${suffix}_${seq}`;
    const password = 'test-pass-123';
    const expiresAt = opts?.expired
      ? new Date('2020-01-01T00:00:00.000Z')
      : new Date('2028-01-01T00:00:00.000Z');

    await prisma.base.tenant.create({
      data: {
        id: tenantId,
        name: `租户-${prefix}`,
        expiresAt,
        billingMode: opts?.billingMode ?? null,
      },
    });
    await prisma.base.wallet.create({
      data: {
        tenantId,
        points: opts?.points ?? 1000,
        pointsReserved: 0,
      },
    });
    await prisma.base.quota.createMany({
      data: QUOTA_DEFAULTS.map((q) => ({
        tenantId,
        key: q.key,
        limit: q.limit,
        used: 0n,
      })),
    });
    await prisma.base.user.create({
      data: {
        id: userId,
        tenantId,
        username,
        passwordHash: hashPassword(password),
        role: opts?.role ?? 'MERCHANT',
      },
    });

    const captcha = app.get(CaptchaService);
    const created = captcha.create();
    const res = await httpCall<{ accessToken: string }>(base, 'POST', '/api/v1/auth/login', {
      body: {
        username,
        password,
        captchaId: created.captchaId,
        captchaCode: captcha.readCodeForTests(created.captchaId),
      },
    });
    if (res.status !== 200) {
      throw new Error(`test login failed (${res.status}): ${res.msg}`);
    }
    return { tenantId, userId, username, token: res.data.accessToken };
  }

  async function close(): Promise<void> {
    await app.close();
    await prisma.onModuleDestroy();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    adminSql(defaultAdminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }

  return { suffix, dbName, databaseUrl: isolatedUrl, app, base, prisma, createTenantUser, close };
}

export async function httpCall<T = unknown>(
  base: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<HttpEnvelope<T>> {
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  if (
    options?.body !== undefined &&
    !Buffer.isBuffer(options.body) &&
    !(options.body instanceof FormData)
  ) {
    headers['content-type'] = 'application/json';
  }
  if (options?.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body:
      options?.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? new Uint8Array(options.body)
          : options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType === '') {
    const payload = JSON.parse(raw.toString('utf8')) as {
      code: number;
      msg: string;
      data: T;
    };
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

function replaceDbName(base: string, name: string): string {
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
  throw new Error(`postgres admin command failed: ${psql.stderr || psql.stdout}`);
}
