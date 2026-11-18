// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  apiBase,
  clearSession,
  readAccessToken,
  readRefreshToken,
  saveSession,
  type SessionStorageLike,
} from './session';

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
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function makeJwt(claims: { iat?: number; exp?: number; sub?: string }): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
}

describe('session storage', () => {
  it('defaults the API base and round-trips tokens', () => {
    expect(apiBase()).toBe('http://localhost:3001/api/v1');
    const storage = memoryStorage();
    expect(readAccessToken(storage)).toBeNull();
    saveSession(storage, 'access', 'refresh');
    expect(readAccessToken(storage)).toBe('access');
    expect(readRefreshToken(storage)).toBe('refresh');
    clearSession(storage);
    expect(readAccessToken(storage)).toBeNull();
    expect(readRefreshToken(storage)).toBeNull();
  });

  it('restores session tokens across new browser tabs when sessionStorage starts empty (#194)', () => {
    saveSession(window.sessionStorage, 'at_tab1', 'rt_tab1');

    // Simulate opening a brand-new tab in the same browser context (fresh sessionStorage)
    window.sessionStorage.clear();
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();

    expect(readAccessToken(window.sessionStorage)).toBe('at_tab1');
    expect(readRefreshToken(window.sessionStorage)).toBe('rt_tab1');
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBe('at_tab1');

    clearSession(window.sessionStorage);
    expect(readAccessToken(window.sessionStorage)).toBeNull();
    expect(readRefreshToken(window.sessionStorage)).toBeNull();
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it('prefers the fresher JWT token from shared localStorage when sessionStorage holds an older token (#153)', () => {
    const staleAt = makeJwt({ sub: 'u1', iat: 1000, exp: 1900 });
    const staleRt = makeJwt({ sub: 'u1', iat: 1000, exp: 10000 });
    const freshAt = makeJwt({ sub: 'u1', iat: 2000, exp: 2900 });
    const freshRt = makeJwt({ sub: 'u1', iat: 2000, exp: 20000 });

    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, staleAt);
    window.sessionStorage.setItem(REFRESH_TOKEN_KEY, staleRt);
    window.localStorage.setItem(ACCESS_TOKEN_KEY, freshAt);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, freshRt);

    expect(readAccessToken(window.sessionStorage)).toBe(freshAt);
    expect(readRefreshToken(window.sessionStorage)).toBe(freshRt);
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBe(freshAt);
    expect(window.sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBe(freshRt);

    // When sessionStorage holds the newer token, keep it
    const newerAt = makeJwt({ sub: 'u1', iat: 3000, exp: 3900 });
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, newerAt);
    expect(readAccessToken(window.sessionStorage)).toBe(newerAt);
  });
});
