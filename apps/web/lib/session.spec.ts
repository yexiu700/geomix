import { describe, expect, it } from 'vitest';
import {
  apiBase,
  clearSession,
  readAccessToken,
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

describe('session storage', () => {
  it('defaults the API base and round-trips tokens', () => {
    expect(apiBase()).toBe('http://localhost:3001/api/v1');
    const storage = memoryStorage();
    expect(readAccessToken(storage)).toBeNull();
    saveSession(storage, 'access', 'refresh');
    expect(readAccessToken(storage)).toBe('access');
    clearSession(storage);
    expect(readAccessToken(storage)).toBeNull();
  });
});
