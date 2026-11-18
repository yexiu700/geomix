import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAccount, postJson, refreshAccessToken } from './api';
import { saveSession, type SessionStorageLike } from './session';

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

const account = {
  id: 'user-1',
  username: 'demo',
  nickname: '演示',
  role: 'MERCHANT',
  tenant: {
    id: 'tenant-1',
    name: '演示租户',
    expiresAt: '2027-11-12T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account session', () => {
  it('refreshes an expired access token once and then loads the account', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'old-access', 'old-refresh');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url).endsWith('/auth/refresh')) {
          const body = JSON.parse(String(init?.body)) as { refreshToken: string };
          expect(body.refreshToken).toBe('old-refresh');
          return jsonResponse({
            code: 0,
            msg: 'ok',
            data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
          });
        }
        const header = new Headers(init?.headers).get('authorization');
        if (header === 'Bearer old-access') {
          return jsonResponse({ code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录', data: null });
        }
        expect(header).toBe('Bearer new-access');
        return jsonResponse({ code: 0, msg: 'ok', data: account });
      }),
    );

    const result = await loadAccount(storage);
    expect(result).toEqual({ status: 'ok', account });
    expect(calls.map((url) => url.replace('http://localhost:3001/api/v1', ''))).toEqual([
      '/account',
      '/auth/refresh',
      '/account',
    ]);
  });

  it('treats a disabled tenant as unable to stay signed in', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'access', 'refresh');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: API_ERROR.TENANT_EXPIRED, msg: '账号已停用', data: null }),
      ),
    );
    await expect(loadAccount(storage)).resolves.toEqual({ status: 'disabled' });
  });

  it('reports offline when the API cannot be reached', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'access', 'refresh');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect');
      }),
    );
    await expect(loadAccount(storage)).resolves.toEqual({ status: 'offline' });
    await expect(refreshAccessToken(storage)).resolves.toBeNull();
  });

  it('forwards AbortSignal to fetch in postJson', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return jsonResponse({ code: 0, msg: 'ok', data: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await postJson<{ ok: boolean }>('/auth/captcha', {}, undefined, {
      signal: controller.signal,
    });
    expect(res).toEqual({ code: 0, msg: 'ok', data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
