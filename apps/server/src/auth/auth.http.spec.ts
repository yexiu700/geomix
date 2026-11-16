import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { CaptchaService } from './captcha.service';

type Envelope = { code: number; msg: string; data: unknown };

async function call(
  base: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown },
): Promise<Envelope & { status: number }> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['content-type'] = 'application/json';
  if (options?.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json()) as Envelope;
  return { status: response.status, ...payload };
}

describe('auth http without a database', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps health public and on the shadow billing default', async () => {
    const health = await call(base, 'GET', '/api/v1/health');
    expect(health.status).toBe(200);
    expect(health).toMatchObject({
      code: 0,
      data: { service: 'api', name: 'GeoMix', billingMode: 'SHADOW' },
    });
  });

  it('rejects anonymous and forged calls before touching an account', async () => {
    const missing = await call(base, 'GET', '/api/v1/account');
    expect(missing.status).toBe(401);
    expect(missing.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const forged = await call(base, 'GET', '/api/v1/account', { token: 'not-a-token' });
    expect(forged.status).toBe(401);
    expect(forged.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const write = await call(base, 'POST', '/api/v1/auth/password', {
      body: { currentPassword: 'initial-password', newPassword: 'another-password' },
    });
    expect(write.status).toBe(401);
  });

  it('returns a captcha image and a parameter error for an empty login', async () => {
    const captcha = await call(base, 'POST', '/api/v1/auth/captcha');
    expect(captcha.status).toBe(200);
    expect(captcha.code).toBe(0);
    const data = captcha.data as { captchaId: string; image: string };
    expect(data.captchaId.length).toBeGreaterThan(8);
    expect(data.image.startsWith('data:image/png;base64,')).toBe(true);
    const service = app.get(CaptchaService);
    const code = service.readCodeForTests(data.captchaId);
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    const body = JSON.stringify(captcha);
    expect(body.includes('<text')).toBe(false);
    expect(body.toLowerCase().includes(code.toLowerCase())).toBe(false);
    const png = Buffer.from(data.image.slice('data:image/png;base64,'.length), 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.includes(Buffer.from(code))).toBe(false);

    const accepted = await call(base, 'POST', '/api/v1/auth/login', {
      body: {
        username: 'nobody',
        password: 'not-the-password',
        captchaId: data.captchaId,
        captchaCode: code,
      },
    });
    expect(accepted.status).toBe(400);
    expect(accepted.msg).toBe('用户名或密码错误');

    const login = await call(base, 'POST', '/api/v1/auth/login', { body: {} });
    expect(login.status).toBe(400);
    expect(login.code).toBe(API_ERROR.BAD_REQUEST);
  });
});
