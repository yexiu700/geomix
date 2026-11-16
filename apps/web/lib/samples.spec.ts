import { AUTH_ERROR } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveSession, type SessionStorageLike } from './session';
import { httpSampleGateway, SampleApiError } from './samples';

function memoryStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sample gateway', () => {
  it('refreshes once and never sends a tenant id', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'old-access', 'old-refresh');
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/auth/refresh')) {
          return Response.json({
            code: 0,
            msg: 'ok',
            data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
          });
        }
        const header = new Headers(init?.headers).get('authorization');
        if (header === 'Bearer old-access') {
          return Response.json(
            { code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录', data: null },
            { status: 401 },
          );
        }
        bodies.push(String(init?.body ?? ''));
        return Response.json({
          code: 0,
          msg: 'ok',
          data: {
            id: 'c'.repeat(24),
            name: '示例甲',
            note: '',
            enabled: true,
            createdAt: '2026-11-16T00:00:00.000Z',
            updatedAt: '2026-11-16T00:00:00.000Z',
          },
        });
      }),
    );

    const created = await httpSampleGateway(storage).create({
      name: '示例甲',
      note: '',
      enabled: true,
    });
    expect(created.name).toBe('示例甲');
    expect(bodies[0]).not.toContain('tenantId');
  });

  it('surfaces the API message for a read-only account', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'access', 'refresh');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 40301, msg: '账号已到期，当前为只读', data: null }, { status: 403 }),
      ),
    );
    await expect(
      httpSampleGateway(storage).create({ name: '甲', note: '', enabled: true }),
    ).rejects.toEqual(expect.any(SampleApiError));
  });
});
