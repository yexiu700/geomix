import type { AccountProfile, AccountUiPrefs } from './api';
import { readAccessToken, type SessionStorageLike } from './session';

const ACCOUNT_CACHE_TTL_MS = 2 * 60_000;

type CachedAccountEntry = {
  token: string;
  account: AccountProfile;
  cachedAt: number;
};

let cachedEntry: CachedAccountEntry | null = null;

export function readCachedAccount(storage: SessionStorageLike): AccountProfile | null {
  try {
    const token = readAccessToken(storage);
    if (!token || !cachedEntry) return null;
    if (cachedEntry.token !== token) {
      cachedEntry = null;
      return null;
    }
    if (Date.now() - cachedEntry.cachedAt > ACCOUNT_CACHE_TTL_MS) {
      cachedEntry = null;
      return null;
    }
    return cachedEntry.account;
  } catch {
    return null;
  }
}

export function writeCachedAccount(storage: SessionStorageLike, account: AccountProfile): void {
  try {
    const token = readAccessToken(storage);
    if (!token) {
      cachedEntry = null;
      return;
    }
    cachedEntry = {
      token,
      account,
      cachedAt: Date.now(),
    };
  } catch {
    cachedEntry = null;
  }
}

export function patchCachedAccountUiPrefs(
  storage: SessionStorageLike,
  prefs: AccountUiPrefs,
): void {
  try {
    const token = readAccessToken(storage);
    if (!token || !cachedEntry || cachedEntry.token !== token) return;
    cachedEntry = {
      ...cachedEntry,
      account: {
        ...cachedEntry.account,
        uiPrefs: {
          ...(cachedEntry.account.uiPrefs ?? {}),
          ...prefs,
        },
      },
      cachedAt: Date.now(),
    };
  } catch {
    // ignore cache update errors
  }
}

export function clearCachedAccount(): void {
  cachedEntry = null;
}
