import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AUTH_ERROR, RATE_LIMIT_MESSAGE } from '@geomix/shared';
import { createApiApp } from '../common/create-api-app';
import { CaptchaService } from './captcha.service';
import { PrismaAuthStore } from './prisma-auth.store';

type Envelope = { code: number; msg: string; data: { captchaId?: string; image?: string } | null };

async function call(
  base: string,
  path: string,
  options?: { body?: unknown; forwardedFor?: string },
): Promise<Envelope & { status: number; retryAfter: string | null }> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['content-type'] = 'application/json';
  if (options?.forwardedFor) headers['x-forwarded-for'] = options.forwardedFor;
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json()) as Envelope;
  return { status: response.status, retryAfter: response.headers.get('retry-after'), ...payload };
}

describe('auth rate limits over http', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    vi.spyOn(app.get(PrismaAuthStore), 'findUserByUsername').mockResolvedValue(null);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 429 for password failures and captcha bursts without trusting forwarding headers', async () => {
    const captcha = app.get(CaptchaService);
    const username = 'rate-limit-user';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const created = await call(base, '/api/v1/auth/captcha');
      expect(created.status).toBe(200);
      const image = created.data?.image ?? '';
      const captchaId = created.data?.captchaId ?? '';
      const code = captcha.readCodeForTests(captchaId);
      expect(JSON.stringify(created).toLowerCase().includes(code.toLowerCase())).toBe(false);
      expect(image.includes('<text')).toBe(false);
      const login = await call(base, '/api/v1/auth/login', {
        body: { username, password: 'wrong-password', captchaId, captchaCode: code },
      });
      expect(login.status).toBe(400);
      expect(login.msg).toBe('用户名或密码错误');
      expect(login.msg.includes(username)).toBe(false);
    }

    const blockedCaptcha = await call(base, '/api/v1/auth/captcha');
    expect(blockedCaptcha.status).toBe(200);
    const blocked = await call(base, '/api/v1/auth/login', {
      body: {
        username: username.toUpperCase(),
        password: 'wrong-password',
        captchaId: blockedCaptcha.data?.captchaId,
        captchaCode: captcha.readCodeForTests(blockedCaptcha.data?.captchaId ?? ''),
      },
      forwardedFor: '198.51.100.20',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(blocked.msg).toBe(RATE_LIMIT_MESSAGE);
    expect(blocked.msg.includes(username)).toBe(false);
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);

    for (let extra = 0; extra < 4; extra += 1) {
      const more = await call(base, '/api/v1/auth/captcha');
      expect(more.status).toBe(200);
    }
    const limited = await call(base, '/api/v1/auth/captcha', { forwardedFor: '203.0.113.50' });
    expect(limited.status).toBe(429);
    expect(limited.code).toBe(AUTH_ERROR.TOO_MANY_REQUESTS);
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
  });
});
