export const ACCESS_TOKEN_KEY = 'geomix.accessToken';
export const REFRESH_TOKEN_KEY = 'geomix.refreshToken';

export type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE;
  if (!configured || configured.trim() === '') return 'http://localhost:3001/api/v1';
  return configured.trim().replace(/\/$/, '');
}

export function saveSession(
  storage: SessionStorageLike,
  accessToken: string,
  refreshToken: string,
): void {
  storage.setItem(ACCESS_TOKEN_KEY, accessToken);
  storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearSession(storage: SessionStorageLike): void {
  storage.removeItem(ACCESS_TOKEN_KEY);
  storage.removeItem(REFRESH_TOKEN_KEY);
}

export function readAccessToken(storage: SessionStorageLike): string | null {
  const value = storage.getItem(ACCESS_TOKEN_KEY);
  if (!value) return null;
  return value;
}

export function readRefreshToken(storage: SessionStorageLike): string | null {
  const value = storage.getItem(REFRESH_TOKEN_KEY);
  if (!value) return null;
  return value;
}
