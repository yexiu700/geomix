import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizedRequest,
  authorizedV2Request,
  loadAccount,
  postJson,
  refreshAccessToken,
} from './api';
import { GatewayApiError } from './envelope';
import { REFRESH_TOKEN_KEY, saveSession, type SessionStorageLike } from './session';

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

function makeJwt(claims: { exp?: number; iat?: number; sub?: string }): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

  it('deduplicates concurrent refreshAccessToken calls via single-flight mutex (#153)', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'expired-at', 'rt-1');
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/auth/refresh')) {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return jsonResponse({
            code: 0,
            msg: 'ok',
            data: { accessToken: 'fresh-at', refreshToken: 'fresh-rt' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const [first, second, third] = await Promise.all([
      refreshAccessToken(storage),
      refreshAccessToken(storage),
      refreshAccessToken(storage),
    ]);
    expect(refreshCalls).toBe(1);
    expect(first).toBe('fresh-at');
    expect(second).toBe('fresh-at');
    expect(third).toBe('fresh-at');
  });

  it('continues to sharedRefreshToken when primary refresh candidate throws a network error (#153)', async () => {
    const sessionStore = memoryStorage();
    const localStore = memoryStorage();
    sessionStore.setItem(REFRESH_TOKEN_KEY, 'rt-primary');
    localStore.setItem(REFRESH_TOKEN_KEY, 'rt-shared');
    vi.stubGlobal('window', {
      sessionStorage: sessionStore,
      localStorage: localStore,
    });

    const attemptedTokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { refreshToken: string };
        attemptedTokens.push(body.refreshToken);
        if (body.refreshToken === 'rt-primary') {
          throw new Error('transient network error');
        }
        return jsonResponse({
          code: 0,
          msg: 'ok',
          data: { accessToken: 'recovered-at', refreshToken: 'recovered-rt' },
        });
      }),
    );

    const refreshed = await refreshAccessToken(sessionStore);
    expect(refreshed).toBe('recovered-at');
    expect(attemptedTokens).toEqual(['rt-primary', 'rt-shared']);
  });

  it('proactively refreshes expiring JWT before calling API in authorizedRequest so no 401 is emitted (#153)', async () => {
    const storage = memoryStorage();
    const nowSec = Math.floor(Date.now() / 1000);
    const expiringAccess = makeJwt({ sub: 'u1', iat: nowSec - 900, exp: nowSec - 10 });
    const freshAccess = makeJwt({ sub: 'u1', iat: nowSec, exp: nowSec + 900 });
    saveSession(storage, expiringAccess, 'rt-valid');

    const calls: Array<{ path: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace('http://localhost:3001/api/v1', '');
        const auth = new Headers(init?.headers).get('authorization');
        calls.push({ path, auth });
        if (path === '/auth/refresh') {
          return jsonResponse({
            code: 0,
            msg: 'ok',
            data: { accessToken: freshAccess, refreshToken: 'rt-next' },
          });
        }
        expect(auth).toBe(`Bearer ${freshAccess}`);
        return jsonResponse({ code: 0, msg: 'ok', data: { items: [], total: 0 } });
      }),
    );

    const res = await authorizedRequest(storage, 'GET', '/ai-tasks?page=1');
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { path: '/auth/refresh', auth: null },
      { path: '/ai-tasks?page=1', auth: `Bearer ${freshAccess}` },
    ]);
  });

  it('refreshes via refreshToken when accessToken is missing before calling API in authorizedRequest (#153)', async () => {
    const storage = memoryStorage();
    const nowSec = Math.floor(Date.now() / 1000);
    const freshAccess = makeJwt({ sub: 'u1', iat: nowSec, exp: nowSec + 900 });
    storage.setItem(REFRESH_TOKEN_KEY, 'rt-only');

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = String(url).replace('http://localhost:3001/api/v1', '');
        calls.push(path);
        if (path === '/auth/refresh') {
          return jsonResponse({
            code: 0,
            msg: 'ok',
            data: { accessToken: freshAccess, refreshToken: 'rt-next' },
          });
        }
        return jsonResponse({ code: 0, msg: 'ok', data: { ok: true } });
      }),
    );

    const res = await authorizedRequest(storage, 'GET', '/ai-tasks?page=1');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['/auth/refresh', '/ai-tasks?page=1']);
  });

  it('calls /api/v2, retries once on 401 refresh, forwards AbortSignal, and unwraps envelopes in authorizedV2Request', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'stale-v2-at', 'rt-v2');
    const controller = new AbortController();
    const urls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(String(url));
        if (String(url).endsWith('/api/v1/auth/refresh')) {
          return jsonResponse({
            code: 0,
            msg: 'ok',
            data: { accessToken: 'fresh-v2-at', refreshToken: 'rt-v2-next' },
          });
        }
        expect(init?.signal).toBe(controller.signal);
        const auth = new Headers(init?.headers).get('authorization');
        if (auth === 'Bearer stale-v2-at') {
          return jsonResponse({ code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录', data: null }, 401);
        }
        expect(auth).toBe('Bearer fresh-v2-at');
        return jsonResponse({ code: 0, msg: 'ok', data: { items: [{ id: 'brand-1' }] } });
      }),
    );

    const data = await authorizedV2Request<{ items: Array<{ id: string }> }>('/brands', {
      storage,
      signal: controller.signal,
    });
    expect(data).toEqual({ items: [{ id: 'brand-1' }] });
    expect(urls).toEqual([
      'http://localhost:3001/api/v2/brands',
      'http://localhost:3001/api/v1/auth/refresh',
      'http://localhost:3001/api/v2/brands',
    ]);
  });

  it('throws GatewayApiError on non-zero envelope or HTTP error in authorizedV2Request', async () => {
    const storage = memoryStorage();
    saveSession(storage, 'valid-at', 'valid-rt');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: API_ERROR.TENANT_EXPIRED, msg: '账号已到期', data: null }, 403),
      ),
    );

    await expect(
      authorizedV2Request('/brands', {
        method: 'POST',
        body: { name: 'Demo', category: 'NAS', markets: ['CN'] },
        storage,
      }),
    ).rejects.toMatchObject({
      name: GatewayApiError.name,
      status: 403,
      code: API_ERROR.TENANT_EXPIRED,
      message: '账号已到期',
    });
  });
});
