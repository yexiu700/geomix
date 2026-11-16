import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { hashPassword } from '@geomix/db';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { PrismaService } from '../prisma/prisma.service';
import { CaptchaService } from './captcha.service';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';

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

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')('auth against Postgres', () => {
  let app: INestApplication;
  let base = '';
  let captcha: CaptchaService;
  const suffix = randomBytes(4).toString('hex');
  const password = 'initial-password';
  const tenantA = `auth_a_${suffix}`;
  const tenantB = `auth_b_${suffix}`;
  const tenantExpired = `auth_e_${suffix}`;
  const tenantDisabled = `auth_d_${suffix}`;
  const userA = `auth_user_a_${suffix}`;
  const userA2 = `auth_user_a2_${suffix}`;
  const userB = `auth_user_b_${suffix}`;
  const userExpired = `auth_user_e_${suffix}`;
  const userDisabled = `auth_user_d_${suffix}`;
  const userPassword = `auth_user_p_${suffix}`;
  const tenantPassword = `auth_p_${suffix}`;
  const ids = [tenantA, tenantB, tenantExpired, tenantDisabled, tenantPassword];
  const userIds = [userA, userA2, userB, userExpired, userDisabled, userPassword];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    app = await createApiApp();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    captcha = app.get(CaptchaService);
    const prisma = app.get(PrismaService).base;
    const hash = hashPassword(password);
    const future = new Date('2027-11-16T00:00:00.000Z');
    const past = new Date('2020-01-01T00:00:00.000Z');
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, name: '租户甲', expiresAt: future },
        { id: tenantB, name: '租户乙', expiresAt: future },
        { id: tenantExpired, name: '已到期', expiresAt: past },
        { id: tenantDisabled, name: '已停用', expiresAt: future, isActive: false },
        { id: tenantPassword, name: '改密', expiresAt: future },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: userA,
          tenantId: tenantA,
          username: `a_${suffix}`,
          passwordHash: hash,
          nickname: '甲',
        },
        {
          id: userA2,
          tenantId: tenantA,
          username: `a2_${suffix}`,
          passwordHash: hash,
          nickname: '甲二',
        },
        {
          id: userB,
          tenantId: tenantB,
          username: `b_${suffix}`,
          passwordHash: hash,
          nickname: '乙',
        },
        {
          id: userExpired,
          tenantId: tenantExpired,
          username: `e_${suffix}`,
          passwordHash: hash,
          nickname: '到期',
        },
        {
          id: userDisabled,
          tenantId: tenantDisabled,
          username: `d_${suffix}`,
          passwordHash: hash,
          nickname: '停用',
        },
        {
          id: userPassword,
          tenantId: tenantPassword,
          username: `p_${suffix}`,
          passwordHash: hash,
          nickname: '改密',
        },
      ],
    });
  });

  afterAll(async () => {
    const prisma = app.get(PrismaService).base;
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  async function login(username: string, secret = password) {
    const created = captcha.create();
    const response = await call<{
      accessToken: string;
      refreshToken: string;
      user: { readOnly: boolean; tenantId: string };
    }>(base, 'POST', '/api/v1/auth/login', {
      body: {
        username,
        password: secret,
        captchaId: created.captchaId,
        captchaCode: captcha.readCodeForTests(created.captchaId),
      },
    });
    return response;
  }

  it('logs in, refreshes, logs out, and rejects the spent session', async () => {
    const created = captcha.create();
    const code = captcha.readCodeForTests(created.captchaId);
    const replay = await call(base, 'POST', '/api/v1/auth/login', {
      body: {
        username: `a_${suffix}`,
        password: 'wrong-password',
        captchaId: created.captchaId,
        captchaCode: code,
      },
    });
    expect(replay.status).toBe(400);
    expect(replay.code).toBe(API_ERROR.BAD_REQUEST);
    const again = await call(base, 'POST', '/api/v1/auth/login', {
      body: { username: `a_${suffix}`, password, captchaId: created.captchaId, captchaCode: code },
    });
    expect(again.status).toBe(400);
    expect(again.msg).toContain('验证码');

    const session = await login(`a_${suffix}`);
    expect(session.status).toBe(200);
    expect(session.data.user.readOnly).toBe(false);
    const refreshed = await call<{ accessToken: string; refreshToken: string }>(
      base,
      'POST',
      '/api/v1/auth/refresh',
      { body: { refreshToken: session.data.refreshToken } },
    );
    expect(refreshed.status).toBe(200);
    const profile = await call<{ tenant: { id: string } }>(base, 'GET', '/api/v1/account', {
      token: refreshed.data.accessToken,
    });
    expect(profile.status).toBe(200);
    expect(profile.data.tenant.id).toBe(tenantA);

    const loggedOut = await call(base, 'POST', '/api/v1/auth/logout', {
      body: { refreshToken: session.data.refreshToken },
    });
    expect(loggedOut.status).toBe(200);
    const stale = await call(base, 'GET', '/api/v1/account', { token: refreshed.data.accessToken });
    expect(stale.status).toBe(401);
    const staleRefresh = await call(base, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: refreshed.data.refreshToken },
    });
    expect(staleRefresh.status).toBe(401);
  });

  it('returns 404 for another tenant and 200 for a user in the same tenant', async () => {
    const session = await login(`a_${suffix}`);
    const own = await call<{ id: string }>(base, 'GET', `/api/v1/account/users/${userA2}`, {
      token: session.data.accessToken,
    });
    expect(own.status).toBe(200);
    expect(own.data.id).toBe(userA2);
    const other = await call(base, 'GET', `/api/v1/account/users/${userB}`, {
      token: session.data.accessToken,
    });
    expect(other.status).toBe(404);
    expect(other.code).toBe(AUTH_ERROR.NOT_FOUND);
    const missing = await call(base, 'GET', '/api/v1/account/users/does-not-exist', {
      token: session.data.accessToken,
    });
    expect(missing.status).toBe(404);
  });

  it('lets an expired tenant read and rejects writes', async () => {
    const session = await login(`e_${suffix}`);
    expect(session.status).toBe(200);
    expect(session.data.user.readOnly).toBe(true);
    const profile = await call<{ tenant: { readOnly: boolean } }>(base, 'GET', '/api/v1/account', {
      token: session.data.accessToken,
    });
    expect(profile.status).toBe(200);
    expect(profile.data.tenant.readOnly).toBe(true);
    const write = await call(base, 'POST', '/api/v1/auth/password', {
      token: session.data.accessToken,
      body: { currentPassword: password, newPassword: 'replacement-password' },
    });
    expect(write.status).toBe(403);
    expect(write.code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('rejects a disabled tenant at login', async () => {
    const session = await login(`d_${suffix}`);
    expect(session.status).toBe(403);
    expect(session.code).toBe(API_ERROR.TENANT_EXPIRED);
  });

  it('changes the password and refuses the previous password and token', async () => {
    const session = await login(`p_${suffix}`);
    const changed = await call<{ accessToken: string }>(base, 'POST', '/api/v1/auth/password', {
      token: session.data.accessToken,
      body: { currentPassword: password, newPassword: 'replacement-password' },
    });
    expect(changed.status).toBe(200);
    const oldToken = await call(base, 'GET', '/api/v1/account', {
      token: session.data.accessToken,
    });
    expect(oldToken.status).toBe(401);
    const oldPassword = await login(`p_${suffix}`, password);
    expect(oldPassword.status).toBe(400);
    const next = await login(`p_${suffix}`, 'replacement-password');
    expect(next.status).toBe(200);
    const wrongCurrent = await call(base, 'POST', '/api/v1/auth/password', {
      token: next.data.accessToken,
      body: { currentPassword: password, newPassword: 'yet-another-password' },
    });
    expect(wrongCurrent.status).toBe(400);
    expect(wrongCurrent.code).toBe(API_ERROR.BAD_REQUEST);
  });
});
