import { describe, expect, it } from 'vitest';
import { hashPassword } from '@geomix/db';
import { ApiError } from '../common/api-error';
import type { AuthStore, AuthUser } from './auth.types';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { AuthRateLimiter } from './rate-limiter';

class MemoryStore implements AuthStore {
  readonly users: AuthUser[] = [];
  readonly logins: string[] = [];
  private readonly revokes: { userId: string; at: number }[] = [];

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    return this.users.find((user) => user.username === username) ?? null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async touchLogin(id: string): Promise<void> {
    this.logins.push(id);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new Error('missing user');
    user.passwordHash = passwordHash;
  }

  async revoke(userId: string, _tenantId: string, atMs: number): Promise<void> {
    this.revokes.push({ userId, at: atMs });
  }

  async latestRevokeAt(userId: string): Promise<number | null> {
    const rows = this.revokes.filter((row) => row.userId === userId);
    if (rows.length === 0) return null;
    return Math.max(...rows.map((row) => row.at));
  }
}

function user(
  partial: Partial<AuthUser> & Pick<AuthUser, 'id' | 'username' | 'passwordHash'>,
): AuthUser {
  return {
    tenantId: 'tenant_a',
    nickname: '甲',
    role: 'MERCHANT',
    tenantName: '租户甲',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    isActive: true,
    ...partial,
  };
}

describe('AuthService', () => {
  const now = Date.parse('2026-11-16T00:00:00.000Z');
  const store = new MemoryStore();
  const captcha = new CaptchaService(() => now);
  const auth = new AuthService(
    store,
    captcha,
    {
      accessSecret: 'access-secret',
      refreshSecret: 'refresh-secret',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
    },
    () => now,
  );

  const active = user({
    id: 'user_a',
    username: 'alpha',
    passwordHash: hashPassword('initial-password'),
  });
  const expired = user({
    id: 'user_expired',
    username: 'expired',
    tenantId: 'tenant_expired',
    passwordHash: hashPassword('initial-password'),
    expiresAt: new Date(now - 60_000),
  });
  const disabled = user({
    id: 'user_disabled',
    username: 'disabled',
    tenantId: 'tenant_disabled',
    passwordHash: hashPassword('initial-password'),
    isActive: false,
  });
  store.users.push(active, expired, disabled);

  function captchaBody(username: string, password: string) {
    const created = captcha.create();
    return {
      username,
      password,
      captchaId: created.captchaId,
      captchaCode: captcha.readCodeForTests(created.captchaId),
    };
  }

  it('rejects a bad captcha before checking the password', async () => {
    await expect(
      auth.login({
        username: 'alpha',
        password: 'wrong',
        captchaId: 'missing-id',
        captchaCode: 'ABCD',
      }),
    ).rejects.toMatchObject({ status: 400, message: '验证码错误或已过期' });
    expect(store.logins).toEqual([]);
  });

  it('rejects unknown users and wrong passwords without logging them in', async () => {
    await expect(auth.login(captchaBody('nobody', 'initial-password'))).rejects.toMatchObject({
      status: 400,
      message: '用户名或密码错误',
    });
    await expect(auth.login(captchaBody('alpha', 'wrong-password'))).rejects.toMatchObject({
      status: 400,
      message: '用户名或密码错误',
    });
    expect(store.logins).toEqual([]);
  });

  it('rejects a disabled tenant and still logs an expired tenant in as read-only', async () => {
    await expect(auth.login(captchaBody('disabled', 'initial-password'))).rejects.toMatchObject({
      status: 403,
      message: '账号已停用',
    });
    const session = await auth.login(captchaBody('expired', 'initial-password'));
    expect(session.user.readOnly).toBe(true);
    expect(session.user.tenantId).toBe('tenant_expired');
  });

  it('refreshes, then logout and password change invalidate older tokens', async () => {
    const session = await auth.login(captchaBody('alpha', 'initial-password'));
    const refreshed = await auth.refresh(session.refreshToken);
    expect((await auth.authenticateAccess(refreshed.accessToken)).ok).toBe(true);
    await expect(auth.refresh(session.accessToken)).rejects.toBeInstanceOf(ApiError);
    expect((await auth.authenticateAccess(session.refreshToken)).ok).toBe(false);

    await auth.logout(session.refreshToken);
    expect((await auth.authenticateAccess(refreshed.accessToken)).ok).toBe(false);
    await expect(auth.refresh(refreshed.refreshToken)).rejects.toMatchObject({ status: 401 });

    const next = await auth.login(captchaBody('alpha', 'initial-password'));
    const changed = await auth.changePassword(
      {
        userId: active.id,
        tenantId: active.tenantId,
        username: active.username,
        nickname: active.nickname,
        role: active.role,
        tenantName: active.tenantName,
        expiresAt: active.expiresAt,
        isActive: true,
      },
      { currentPassword: 'initial-password', newPassword: 'next-password-1' },
    );
    expect((await auth.authenticateAccess(next.accessToken)).ok).toBe(false);
    expect((await auth.authenticateAccess(changed.accessToken)).ok).toBe(true);
    await expect(auth.login(captchaBody('alpha', 'initial-password'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      auth.changePassword(
        {
          userId: active.id,
          tenantId: active.tenantId,
          username: active.username,
          nickname: active.nickname,
          role: active.role,
          tenantName: active.tenantName,
          expiresAt: active.expiresAt,
          isActive: true,
        },
        { currentPassword: 'next-password-1', newPassword: 'next-password-1' },
      ),
    ).rejects.toMatchObject({ status: 400, message: '新密码需要和当前密码不同' });
  });
});

describe('login throttling', () => {
  it('locks a normalized username, ignores captcha typos, and allows the password after expiry', async () => {
    let now = 5_000_000;
    const store = new MemoryStore();
    store.users.push(
      user({ id: 'user_rate', username: 'alpha', passwordHash: hashPassword('initial-password') }),
    );
    const captcha = new CaptchaService(() => now);
    const rates = new AuthRateLimiter({
      now: () => now,
      captchaMax: 20,
      captchaWindowMs: 60_000,
      loginFailMax: 2,
      loginFailWindowMs: 60_000,
    });
    const auth = new AuthService(
      store,
      captcha,
      {
        accessSecret: 'access-secret',
        refreshSecret: 'refresh-secret',
        accessTtlSeconds: 900,
        refreshTtlSeconds: 3600,
      },
      () => now,
      rates,
    );
    const ip = '203.0.113.10';

    function body(username: string, password: string, captchaCode = '') {
      const created = captcha.create();
      return {
        username,
        password,
        captchaId: created.captchaId,
        captchaCode: captchaCode || captcha.readCodeForTests(created.captchaId),
      };
    }

    await expect(auth.login(body('Alpha', 'nope', 'ZZZZ'), ip)).rejects.toMatchObject({
      status: 400,
      message: '验证码错误或已过期',
    });
    await expect(auth.login(body('alpha', 'wrong-password'), ip)).rejects.toMatchObject({
      status: 400,
      message: '用户名或密码错误',
    });
    await expect(auth.login(body('ALPHA', 'wrong-password'), ip)).rejects.toMatchObject({
      status: 400,
      message: '用户名或密码错误',
    });
    await expect(auth.login(body('alpha', 'initial-password'), ip)).rejects.toMatchObject({
      status: 429,
      message: '尝试过于频繁，请稍后再试',
    });
    await expect(
      auth.login(body('alpha', 'initial-password'), '203.0.113.11'),
    ).resolves.toMatchObject({
      user: { username: 'alpha' },
    });

    now += 60_001;
    const session = await auth.login(body('alpha', 'initial-password'), ip);
    expect(session.user.username).toBe('alpha');
    rates.reset();
    expect(rates.loginStatus(ip, 'alpha').allowed).toBe(true);
  });
});
