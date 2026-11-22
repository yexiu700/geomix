import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { unwrapEnvelope } from './envelope';
import {
  apiBase,
  apiV2Base,
  clearSession,
  decodeJwtClaims,
  readAccessToken,
  readRefreshToken,
  readSharedRefreshToken,
  saveSession,
  syncSessionToSharedStorage,
  type SessionStorageLike,
} from './session';

const ACCESS_REFRESH_LEEWAY_MS = 60_000;
let refreshInFlight: Promise<string | null> | null = null;

function unauthorizedSyntheticResponse(): Response {
  return new Response(
    JSON.stringify({ code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录', data: null }),
    {
      status: 401,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function getTokenExpiryMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  if (!claims || claims.exp === undefined) return null;
  return claims.exp * 1000;
}

export type Envelope<T> = { code: number; msg: string; data: T };

export type AccountUiPrefs = {
  multiTab?: boolean;
  menuCollapsed?: boolean;
  submenusAlwaysVisible?: boolean;
  autoExpand?: boolean;
  multiLevel?: boolean;
};

export type AccountProfile = {
  id: string;
  username: string;
  nickname: string | null;
  role: string;
  uiPrefs?: AccountUiPrefs | null;
  features?: {
    aiImage?: boolean;
    visibility?: boolean;
  };
  tenant: {
    id: string;
    name: string;
    expiresAt: string;
    isActive: boolean;
    readOnly: boolean;
  };
};

export type AccountLoad =
  | { status: 'ok'; account: AccountProfile }
  | { status: 'anonymous' }
  | { status: 'disabled' }
  | { status: 'offline' };

export async function postJson<T>(
  path: string,
  body: unknown,
  token?: string,
  options?: { signal?: AbortSignal },
): Promise<Envelope<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  return readEnvelope<T>(response);
}

async function authorizedFetch(
  baseUrl: string,
  storage: SessionStorageLike,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  options?: { signal?: AbortSignal },
): Promise<Response> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const send = (token: string) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(extraHeaders ?? {}),
    };
    if (body !== undefined && !isFormData) {
      headers['content-type'] = 'application/json';
    }
    return fetch(`${baseUrl}${normalizedPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
      signal: options?.signal,
    });
  };
  let token = readAccessToken(storage);
  if (!token) {
    const hasRefresh = Boolean(readRefreshToken(storage) || readSharedRefreshToken(storage));
    if (hasRefresh) {
      token = await refreshAccessToken(storage);
    }
    if (!token) {
      return unauthorizedSyntheticResponse();
    }
  } else {
    const expMs = getTokenExpiryMs(token);
    const nowMs = Date.now();
    if (expMs !== null && expMs - nowMs < ACCESS_REFRESH_LEEWAY_MS) {
      const refreshed = await refreshAccessToken(storage);
      if (refreshed) {
        token = refreshed;
      } else if (expMs <= nowMs) {
        return unauthorizedSyntheticResponse();
      }
    }
  }
  const response = await send(token);
  if (response.status !== 401) return response;
  const latestToken = readAccessToken(storage);
  const nextToken =
    latestToken && latestToken !== token ? latestToken : await refreshAccessToken(storage);
  if (!nextToken) return response;
  return send(nextToken);
}

export async function authorizedRequest(
  storage: SessionStorageLike,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return authorizedFetch(apiBase(), storage, method, path, body, extraHeaders);
}

export type AuthorizedV2RequestInit = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  storage?: SessionStorageLike;
  requireData?: boolean;
};

export async function authorizedV2RawRequest(
  path: string,
  init: AuthorizedV2RequestInit = {},
): Promise<Response> {
  const storage =
    init.storage ?? (typeof window !== 'undefined' ? window.sessionStorage : undefined);
  if (!storage) {
    return unauthorizedSyntheticResponse();
  }
  return authorizedFetch(
    apiV2Base(),
    storage,
    (init.method ?? 'GET').toUpperCase(),
    path,
    init.body,
    init.headers,
    { signal: init.signal },
  );
}

export async function authorizedV2Request<T>(
  path: string,
  init: AuthorizedV2RequestInit = {},
): Promise<T> {
  const response = await authorizedV2RawRequest(path, init);
  return unwrapEnvelope<T>(response, { requireData: init.requireData });
}

export async function getJson<T>(path: string, token: string): Promise<Envelope<T>> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return readEnvelope<T>(response);
}

export async function refreshAccessToken(storage: SessionStorageLike): Promise<string | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const refreshToken = readRefreshToken(storage);
    const sharedRefreshToken = readSharedRefreshToken(storage);
    const candidates =
      refreshToken && sharedRefreshToken && sharedRefreshToken !== refreshToken
        ? [refreshToken, sharedRefreshToken]
        : refreshToken
          ? [refreshToken]
          : sharedRefreshToken
            ? [sharedRefreshToken]
            : [];
    for (const candidate of candidates) {
      try {
        const result = await postJson<{ accessToken: string; refreshToken: string }>(
          '/auth/refresh',
          { refreshToken: candidate },
        );
        if (result.code === 0 && result.data?.accessToken && result.data.refreshToken) {
          saveSession(storage, result.data.accessToken, result.data.refreshToken);
          return result.data.accessToken;
        }
      } catch {
        // Continue so sharedRefreshToken can still be attempted if primary fails
      }
    }
    return null;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function loadAccount(storage: SessionStorageLike): Promise<AccountLoad> {
  const token = readAccessToken(storage);
  if (!token) return { status: 'anonymous' };
  try {
    let result = await getJson<AccountProfile>('/account', token);
    if (result.code === AUTH_ERROR.UNAUTHORIZED) {
      const refreshed = await refreshAccessToken(storage);
      if (!refreshed) return { status: 'anonymous' };
      result = await getJson<AccountProfile>('/account', refreshed);
    }
    if (result.code === 0 && result.data?.tenant) {
      syncSessionToSharedStorage(storage);
      return { status: 'ok', account: result.data };
    }
    if (result.code === API_ERROR.TENANT_EXPIRED) return { status: 'disabled' };
    if (result.code === AUTH_ERROR.UNAUTHORIZED) return { status: 'anonymous' };
    return { status: 'anonymous' };
  } catch {
    return { status: 'offline' };
  }
}

export async function changePassword(
  storage: SessionStorageLike,
  input: { currentPassword: string; newPassword: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = readAccessToken(storage);
  if (!token) return { ok: false, message: '登录已失效' };
  try {
    const result = await postJson<{ accessToken: string; refreshToken: string }>(
      '/auth/password',
      input,
      token,
    );
    if (result.code !== 0 || !result.data?.accessToken || !result.data.refreshToken) {
      return { ok: false, message: result.msg || '修改失败' };
    }
    saveSession(storage, result.data.accessToken, result.data.refreshToken);
    return { ok: true };
  } catch {
    return { ok: false, message: '无法连接接口' };
  }
}

export async function saveAccountUiPrefs(
  storage: SessionStorageLike,
  prefs: AccountUiPrefs,
): Promise<boolean> {
  try {
    const response = await authorizedRequest(storage, 'PATCH', '/account/ui-prefs', prefs);
    if (!response.ok) return false;
    const envelope = await readEnvelope<{ uiPrefs: AccountUiPrefs }>(response);
    return envelope.code === 0;
  } catch {
    return false;
  }
}

export async function logoutSession(storage: SessionStorageLike): Promise<void> {
  const refreshToken = readRefreshToken(storage);
  if (refreshToken) {
    await postJson('/auth/logout', { refreshToken }).catch(() => undefined);
  }
  clearSession(storage);
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text();
  if (!text) throw new Error('empty response');
  return JSON.parse(text) as Envelope<T>;
}
