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

function sharedMirror(storage: SessionStorageLike): SessionStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    if (storage !== window.sessionStorage) return null;
    const local = window.localStorage;
    if (!local || local === storage) return null;
    return local;
  } catch {
    return null;
  }
}

export function saveSession(
  storage: SessionStorageLike,
  accessToken: string,
  refreshToken: string,
): void {
  storage.setItem(ACCESS_TOKEN_KEY, accessToken);
  storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  const mirror = sharedMirror(storage);
  if (mirror) {
    mirror.setItem(ACCESS_TOKEN_KEY, accessToken);
    mirror.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export function clearSession(storage: SessionStorageLike): void {
  storage.removeItem(ACCESS_TOKEN_KEY);
  storage.removeItem(REFRESH_TOKEN_KEY);
  const mirror = sharedMirror(storage);
  if (mirror) {
    mirror.removeItem(ACCESS_TOKEN_KEY);
    mirror.removeItem(REFRESH_TOKEN_KEY);
  }
}

export function syncSessionToSharedStorage(storage: SessionStorageLike): void {
  const mirror = sharedMirror(storage);
  if (!mirror) return;
  const accessToken = storage.getItem(ACCESS_TOKEN_KEY);
  const refreshToken = storage.getItem(REFRESH_TOKEN_KEY);
  if (accessToken && !mirror.getItem(ACCESS_TOKEN_KEY)) {
    mirror.setItem(ACCESS_TOKEN_KEY, accessToken);
  }
  if (refreshToken && !mirror.getItem(REFRESH_TOKEN_KEY)) {
    mirror.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export function readSharedRefreshToken(storage: SessionStorageLike): string | null {
  const mirror = sharedMirror(storage);
  if (!mirror) return null;
  const value = mirror.getItem(REFRESH_TOKEN_KEY);
  return value || null;
}

export function readAccessToken(storage: SessionStorageLike): string | null {
  const value = storage.getItem(ACCESS_TOKEN_KEY);
  if (value) return value;
  const mirror = sharedMirror(storage);
  const mirrored = mirror?.getItem(ACCESS_TOKEN_KEY);
  if (!mirrored) return null;
  storage.setItem(ACCESS_TOKEN_KEY, mirrored);
  return mirrored;
}

export function readRefreshToken(storage: SessionStorageLike): string | null {
  const value = storage.getItem(REFRESH_TOKEN_KEY);
  if (value) return value;
  const mirror = sharedMirror(storage);
  const mirrored = mirror?.getItem(REFRESH_TOKEN_KEY);
  if (!mirrored) return null;
  storage.setItem(REFRESH_TOKEN_KEY, mirrored);
  return mirrored;
}
