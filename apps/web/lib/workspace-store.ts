'use client';

import type { BrandListResponse, BrandMarketRecord, BrandRecord, GeoMarket } from '@geomix/shared';
import { create } from 'zustand';
import { listBrands } from './brands';
import type { SessionStorageLike } from './session';

export const WORKSPACE_STORAGE_KEY = 'geomix.workspace.v2';
export const WORKSPACE_USER_KEY = 'geomix.workspace.user';

const LEGACY_SHELL_KEYS = ['geomix.shell.v2', 'geomix.shell.v1', 'geomix.shell.user'] as const;

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type PersistedWorkspaceSnapshot = {
  activeBrandId: string | null;
  activeMarket: GeoMarket | null;
  menuCollapsed: boolean;
};

export type WorkspaceState = {
  brands: BrandRecord[];
  brandsLoading: boolean;
  brandsLoaded: boolean;
  brandsError: string | null;
  activeBrandId: string | null;
  activeMarket: GeoMarket;
  menuCollapsed: boolean;
  hydrated: boolean;
  loadSeq: number;
  contextEpoch: number;
};

type WorkspaceActions = {
  hydrate: (search?: string | URLSearchParams, persistStorage?: KeyValueStorage) => void;
  syncFromUrl: (search: string | URLSearchParams, persistStorage?: KeyValueStorage) => void;
  loadBrands: (options?: {
    storage?: SessionStorageLike;
    persistStorage?: KeyValueStorage;
    preferredBrandId?: string | null;
    preferredMarket?: GeoMarket | null;
    fetcher?: () => Promise<BrandListResponse>;
  }) => Promise<void>;
  setActiveBrand: (
    brandId: string,
    preferredMarket?: GeoMarket,
    persistStorage?: KeyValueStorage,
  ) => void;
  setActiveMarket: (market: GeoMarket, persistStorage?: KeyValueStorage) => void;
  upsertBrand: (
    brand: BrandRecord,
    options?: {
      activate?: boolean;
      market?: GeoMarket;
      persistStorage?: KeyValueStorage;
    },
  ) => void;
  setMenuCollapsed: (collapsed: boolean, persistStorage?: KeyValueStorage) => void;
  reset: (persistStorage?: KeyValueStorage) => void;
};

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export function parseGeoMarket(raw: string | null | undefined): GeoMarket | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'CN' || upper === 'GLOBAL') return upper;
  return null;
}

export function resolveActiveWorkspace(
  brands: readonly BrandRecord[],
  preferredBrandId: string | null,
  preferredMarket: GeoMarket | null,
): { activeBrandId: string | null; activeMarket: GeoMarket } {
  if (brands.length === 0) {
    return { activeBrandId: null, activeMarket: preferredMarket ?? 'CN' };
  }
  const brand =
    (preferredBrandId ? brands.find((item) => item.id === preferredBrandId) : undefined) ??
    brands[0]!;
  const enabled = brand.markets.map((item) => item.market);
  let activeMarket: GeoMarket = 'CN';
  if (preferredMarket && enabled.includes(preferredMarket)) {
    activeMarket = preferredMarket;
  } else if (enabled.includes('CN')) {
    activeMarket = 'CN';
  } else if (enabled.length > 0) {
    activeMarket = enabled[0]!;
  }
  return { activeBrandId: brand.id, activeMarket };
}

export function readWorkspaceStorage(storage?: KeyValueStorage | null): PersistedWorkspaceSnapshot {
  if (!storage) {
    return { activeBrandId: null, activeMarket: null, menuCollapsed: false };
  }
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return { activeBrandId: null, activeMarket: null, menuCollapsed: false };
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceSnapshot> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { activeBrandId: null, activeMarket: null, menuCollapsed: false };
    }
    const activeBrandId =
      typeof parsed.activeBrandId === 'string' && parsed.activeBrandId.trim() !== ''
        ? parsed.activeBrandId.trim()
        : null;
    const activeMarket = parseGeoMarket(
      typeof parsed.activeMarket === 'string' ? parsed.activeMarket : null,
    );
    const menuCollapsed = Boolean(parsed.menuCollapsed);
    return { activeBrandId, activeMarket, menuCollapsed };
  } catch {
    return { activeBrandId: null, activeMarket: null, menuCollapsed: false };
  }
}

export function writeWorkspaceStorage(
  storage: KeyValueStorage | null | undefined,
  snapshot: { activeBrandId: string | null; activeMarket: GeoMarket; menuCollapsed: boolean },
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore quota/private-mode storage errors
  }
}

const WORKSPACE_QUERY_PATHS = new Set(['/home', '/brands', '/visibility', '/studio']);

export function syncWorkspaceQueryInUrl(brandId: string | null, market: GeoMarket): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (!WORKSPACE_QUERY_PATHS.has(pathname)) return;
  const params = new URLSearchParams(window.location.search);
  if (brandId) {
    params.set('brandId', brandId);
    params.set('market', market);
  } else {
    params.delete('brandId');
    params.delete('market');
  }
  const query = params.toString();
  const nextUrl = query ? `${pathname}?${query}` : pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function defaultPersistStorage(): KeyValueStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseSearchParams(search?: string | URLSearchParams): URLSearchParams {
  if (search instanceof URLSearchParams) return search;
  if (typeof search === 'string') return new URLSearchParams(search);
  if (typeof window !== 'undefined') return new URLSearchParams(window.location.search);
  return new URLSearchParams();
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    brands: [],
    brandsLoading: true,
    brandsLoaded: false,
    brandsError: null,
    activeBrandId: null,
    activeMarket: 'CN',
    menuCollapsed: false,
    hydrated: false,
    loadSeq: 0,
    contextEpoch: 0,
  };
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  ...initialWorkspaceState(),

  hydrate: (search, persistStorage) => {
    const storage = persistStorage ?? defaultPersistStorage();
    const stored = readWorkspaceStorage(storage);
    const params = parseSearchParams(search);
    const urlBrandId = params.get('brandId')?.trim() || null;
    const urlMarket = parseGeoMarket(params.get('market'));
    const nextBrandId = urlBrandId ?? stored.activeBrandId;
    const nextMarket = urlMarket ?? stored.activeMarket ?? 'CN';
    set({
      activeBrandId: nextBrandId,
      activeMarket: nextMarket,
      menuCollapsed: stored.menuCollapsed,
      hydrated: true,
    });
  },

  syncFromUrl: (search, persistStorage) => {
    const params = parseSearchParams(search);
    const rawBrandId = params.get('brandId')?.trim() || null;
    const rawMarket = parseGeoMarket(params.get('market'));
    if (!rawBrandId && !rawMarket) return;

    const state = get();
    if (!state.brandsLoaded) {
      set({
        activeBrandId: rawBrandId ?? state.activeBrandId,
        activeMarket: rawMarket ?? state.activeMarket,
      });
      return;
    }

    const resolved = resolveActiveWorkspace(
      state.brands,
      rawBrandId ?? state.activeBrandId,
      rawMarket ?? state.activeMarket,
    );
    const changed =
      resolved.activeBrandId !== state.activeBrandId ||
      resolved.activeMarket !== state.activeMarket;

    if (changed) {
      set({
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        contextEpoch: state.contextEpoch + 1,
      });
      writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        menuCollapsed: state.menuCollapsed,
      });
    }
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket);
  },

  loadBrands: async (options) => {
    const seq = get().loadSeq + 1;
    set({ loadSeq: seq, brandsLoading: true, brandsError: null });
    try {
      const response = await (options?.fetcher
        ? options.fetcher()
        : listBrands({ storage: options?.storage }));
      if (get().loadSeq !== seq) return;
      const state = get();
      const preferredBrandId =
        options?.preferredBrandId !== undefined ? options.preferredBrandId : state.activeBrandId;
      const preferredMarket =
        options?.preferredMarket !== undefined ? options.preferredMarket : state.activeMarket;
      const resolved = resolveActiveWorkspace(response.items, preferredBrandId, preferredMarket);
      const changed =
        resolved.activeBrandId !== state.activeBrandId ||
        resolved.activeMarket !== state.activeMarket;

      set({
        brands: response.items,
        brandsLoading: false,
        brandsLoaded: true,
        brandsError: null,
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        contextEpoch: changed ? state.contextEpoch + 1 : state.contextEpoch,
      });
      writeWorkspaceStorage(options?.persistStorage ?? defaultPersistStorage(), {
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        menuCollapsed: get().menuCollapsed,
      });
      syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket);
    } catch (error: unknown) {
      if (get().loadSeq !== seq) return;
      const message = error instanceof Error && error.message ? error.message : '无法加载品牌列表';
      set({
        brandsLoading: false,
        brandsLoaded: true,
        brandsError: message,
      });
    }
  },

  setActiveBrand: (brandId, preferredMarket, persistStorage) => {
    const state = get();
    if (state.brands.length === 0) return;
    const resolved = resolveActiveWorkspace(
      state.brands,
      brandId,
      preferredMarket ?? state.activeMarket,
    );
    set({
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket);
  },

  setActiveMarket: (market, persistStorage) => {
    const state = get();
    const activeBrand = state.brands.find((item) => item.id === state.activeBrandId);
    if (!activeBrand) return;
    const enabled = activeBrand.markets.some((item) => item.market === market);
    if (!enabled) return;
    if (state.activeMarket === market) {
      syncWorkspaceQueryInUrl(state.activeBrandId, market);
      return;
    }
    set({
      activeMarket: market,
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
      activeBrandId: state.activeBrandId,
      activeMarket: market,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(state.activeBrandId, market);
  },

  upsertBrand: (brand, options) => {
    const state = get();
    const exists = state.brands.some((item) => item.id === brand.id);
    const nextBrands = exists
      ? state.brands.map((item) => (item.id === brand.id ? brand : item))
      : [brand, ...state.brands];

    const shouldActivate = options?.activate !== false;
    const preferredBrandId = shouldActivate ? brand.id : state.activeBrandId;
    const preferredMarket = options?.market ?? state.activeMarket;
    const resolved = resolveActiveWorkspace(nextBrands, preferredBrandId, preferredMarket);

    set({
      brands: nextBrands,
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      loadSeq: state.loadSeq + 1,
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(options?.persistStorage ?? defaultPersistStorage(), {
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket);
  },

  setMenuCollapsed: (collapsed, persistStorage) => {
    const state = get();
    set({ menuCollapsed: collapsed });
    writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
      activeBrandId: state.activeBrandId,
      activeMarket: state.activeMarket,
      menuCollapsed: collapsed,
    });
  },

  reset: (persistStorage) => {
    const storage = persistStorage ?? defaultPersistStorage();
    if (storage) {
      try {
        storage.removeItem(WORKSPACE_STORAGE_KEY);
        storage.removeItem(WORKSPACE_USER_KEY);
        for (const legacyKey of LEGACY_SHELL_KEYS) {
          storage.removeItem(legacyKey);
        }
      } catch {
        // Ignore storage errors
      }
    }
    const nextSeq = get().loadSeq + 1;
    set({
      ...initialWorkspaceState(),
      loadSeq: nextSeq,
    });
  },
}));

export function selectActiveBrand(state: WorkspaceState): BrandRecord | null {
  if (!state.activeBrandId) return null;
  return state.brands.find((item) => item.id === state.activeBrandId) ?? null;
}

export function selectActiveBrandMarket(state: WorkspaceState): BrandMarketRecord | null {
  const brand = selectActiveBrand(state);
  if (!brand) return null;
  return brand.markets.find((item) => item.market === state.activeMarket) ?? null;
}
