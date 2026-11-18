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
});
