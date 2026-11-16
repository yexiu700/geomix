import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import {
  apiBase,
  clearSession,
  readAccessToken,
  readRefreshToken,
  saveSession,
  type SessionStorageLike,
} from './session';

export type Envelope<T> = { code: number; msg: string; data: T };

export type AccountProfile = {
  id: string;
  username: string;
  nickname: string | null;
  role: string;
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
): Promise<Envelope<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return readEnvelope<T>(response);
}

export async function getJson<T>(path: string, token: string): Promise<Envelope<T>> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return readEnvelope<T>(response);
}

export async function refreshAccessToken(storage: SessionStorageLike): Promise<string | null> {
  const refreshToken = readRefreshToken(storage);
  if (!refreshToken) return null;
  try {
    const result = await postJson<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      refreshToken,
    });
    if (result.code !== 0 || !result.data?.accessToken || !result.data.refreshToken) return null;
    saveSession(storage, result.data.accessToken, result.data.refreshToken);
    return result.data.accessToken;
  } catch {
    return null;
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
    if (result.code === 0 && result.data?.tenant) return { status: 'ok', account: result.data };
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
