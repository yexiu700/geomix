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
  return configured.trim().replace(/\/+$/, '');
}

export function apiV2Base(): string {
  const configuredV2 = process.env.NEXT_PUBLIC_API_V2_BASE;
  if (configuredV2 && configuredV2.trim() !== '') {
    return configuredV2.trim().replace(/\/+$/, '');
  }
  const base = apiBase().replace(/\/+$/, '');
  if (/\/api\/v2$/i.test(base)) {
    return base;
  }
  if (/\/api\/v1$/i.test(base)) {
    return base.replace(/\/api\/v1$/i, '/api/v2');
  }
  if (/\/v1$/i.test(base)) {
    return base.replace(/\/v1$/i, '/v2');
  }
  if (/\/api$/i.test(base)) {
    return `${base}/v2`;
  }
  return `${base}/api/v2`;
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

export type JwtClaims = {
  exp?: number;
  iat?: number;
  lms?: number;
};

export function decodeJwtClaims(token: string | null | undefined): JwtClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    let jsonStr: string;
    if (typeof atob === 'function') {
      const binary = atob(padded);
      if (typeof TextDecoder === 'function') {
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        jsonStr = new TextDecoder().decode(bytes);
      } else {
        jsonStr = binary;
      }
    } else if (typeof Buffer !== 'undefined') {
      jsonStr = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const exp =
      typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : undefined;
    const iat =
      typeof parsed.iat === 'number' && Number.isFinite(parsed.iat) ? parsed.iat : undefined;
    const lms =
      typeof parsed.lms === 'number' && Number.isFinite(parsed.lms) ? parsed.lms : undefined;
    return { exp, iat, lms };
  } catch {
    return null;
  }
}

function tokenFreshnessScore(token: string): readonly [number, number, number] | null {
  const claims = decodeJwtClaims(token);
  if (!claims) return null;
  if (claims.iat === undefined && claims.exp === undefined && claims.lms === undefined) {
    return null;
  }
  return [claims.iat ?? -1, claims.exp ?? -1, claims.lms ?? -1];
}

function isMirrorTokenFresher(localToken: string, mirroredToken: string): boolean {
  const localScore = tokenFreshnessScore(localToken);
  const mirrorScore = tokenFreshnessScore(mirroredToken);
  if (!mirrorScore) return false;
  if (!localScore) return true;
  for (let i = 0; i < 3; i += 1) {
    if (mirrorScore[i]! > localScore[i]!) return true;
    if (mirrorScore[i]! < localScore[i]!) return false;
  }
  return false;
}

function readTokenPreferFresher(storage: SessionStorageLike, key: string): string | null {
  const value = storage.getItem(key);
  const mirror = sharedMirror(storage);
  const mirrored = mirror?.getItem(key) ?? null;
  if (value && mirrored && value !== mirrored && isMirrorTokenFresher(value, mirrored)) {
    storage.setItem(key, mirrored);
    return mirrored;
  }
  if (value) return value;
  if (!mirrored) return null;
  storage.setItem(key, mirrored);
  return mirrored;
}

export function readAccessToken(storage: SessionStorageLike): string | null {
  return readTokenPreferFresher(storage, ACCESS_TOKEN_KEY);
}

export function readRefreshToken(storage: SessionStorageLike): string | null {
  return readTokenPreferFresher(storage, REFRESH_TOKEN_KEY);
}
