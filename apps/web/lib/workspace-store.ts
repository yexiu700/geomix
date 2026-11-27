'use client';

import type {
  BrandListResponse,
  BrandMarketRecord,
  BrandProductLineDto,
  BrandProductLineListResponse,
  BrandRecord,
  GeoMarket,
} from '@geomix/shared';
import { create } from 'zustand';
import { listBrandProductLines, listBrands } from './brands';
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
  activeProductLineId: string | null;
  productLines: BrandProductLineDto[];
  productLinesBrandId: string | null;
  productLinesLoading: boolean;
  productLinesLoaded: boolean;
  productLinesError: string | null;
  productLinesLoadSeq: number;
  menuCollapsed: boolean;
  hydrated: boolean;
  loadSeq: number;
  contextEpoch: number;
};

type WorkspaceActions = {
  hydrate: (search?: string | URLSearchParams, persistStorage?: KeyValueStorage) => void;
  syncFromUrl: (
    search: string | URLSearchParams,
    persistStorage?: KeyValueStorage,
    options?: { clearMissingProductLine?: boolean },
  ) => void;
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
    options?: { preserveItemParams?: boolean },
  ) => void;
  setActiveMarket: (market: GeoMarket, persistStorage?: KeyValueStorage) => void;
  setActiveProductLine: (productLineId: string | null) => void;
  loadProductLines: (
    brandId: string,
    options?: {
      storage?: SessionStorageLike;
      signal?: AbortSignal;
      fetcher?: () => Promise<BrandProductLineListResponse>;
    },
  ) => Promise<void>;
  upsertProductLine: (line: BrandProductLineDto) => void;
  removeProductLine: (lineId: string) => void;
  upsertBrand: (
    brand: BrandRecord,
    options?: {
      activate?: boolean;
      market?: GeoMarket;
      persistStorage?: KeyValueStorage;
    },
  ) => void;
  removeBrand: (brandId: string, persistStorage?: KeyValueStorage) => void;
  markBrandTruthSigned: (brandId: string, signedAt: string) => void;
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

function normalizeProductLineId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortProductLines(items: readonly BrandProductLineDto[]): BrandProductLineDto[] {
  return [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const createdCmp = a.createdAt.localeCompare(b.createdAt);
    if (createdCmp !== 0) return createdCmp;
    return a.id.localeCompare(b.id);
  });
}

function resetProductLinesSlice(
  prevSeq: number,
  nextActiveProductLineId: string | null = null,
): Pick<
  WorkspaceState,
  | 'activeProductLineId'
  | 'productLines'
  | 'productLinesBrandId'
  | 'productLinesLoading'
  | 'productLinesLoaded'
  | 'productLinesError'
  | 'productLinesLoadSeq'
> {
  return {
    activeProductLineId: nextActiveProductLineId,
    productLines: [],
    productLinesBrandId: null,
    productLinesLoading: false,
    productLinesLoaded: false,
    productLinesError: null,
    productLinesLoadSeq: prevSeq + 1,
  };
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

const WORKSPACE_QUERY_PATHS = new Set(['/home', '/brands', '/visibility', '/studio', '/publish']);

export function syncProductLineQueryInUrl(
  productLineId: string | null,
  options?: { clearItemParams?: boolean },
): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (!WORKSPACE_QUERY_PATHS.has(pathname)) return;
  const params = new URLSearchParams(window.location.search);
  const normalized = normalizeProductLineId(productLineId);
  if (normalized) {
    params.set('productLineId', normalized);
  } else {
    params.delete('productLineId');
  }
  if (options?.clearItemParams) {
    if (pathname === '/studio') {
      params.delete('articleId');
      params.delete('briefId');
      params.delete('batchJobId');
    } else if (pathname === '/publish') {
      params.delete('articleId');
    }
  }
  const query = params.toString();
  const nextUrl = query ? `${pathname}?${query}` : pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(window.history.state, '', nextUrl);
  }
}

export function syncWorkspaceQueryInUrl(
  brandId: string | null,
  market: GeoMarket,
  options?: { clearItemParams?: boolean; productLineId?: string | null },
): void {
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
    params.delete('productLineId');
  }
  if (options && 'productLineId' in options) {
    const normalized = brandId ? normalizeProductLineId(options.productLineId) : null;
    if (normalized) {
      params.set('productLineId', normalized);
    } else {
      params.delete('productLineId');
    }
  }
  if (options?.clearItemParams) {
    if (pathname === '/studio') {
      params.delete('articleId');
      params.delete('briefId');
      params.delete('batchJobId');
    } else if (pathname === '/publish') {
      params.delete('articleId');
    }
  }
  const query = params.toString();
  const nextUrl = query ? `${pathname}?${query}` : pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(window.history.state, '', nextUrl);
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
    activeProductLineId: null,
    productLines: [],
    productLinesBrandId: null,
    productLinesLoading: false,
    productLinesLoaded: false,
    productLinesError: null,
    productLinesLoadSeq: 0,
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
    const urlProductLineId = normalizeProductLineId(params.get('productLineId'));
    const nextBrandId = urlBrandId ?? stored.activeBrandId;
    const nextMarket = urlMarket ?? stored.activeMarket ?? 'CN';
    set({
      activeBrandId: nextBrandId,
      activeMarket: nextMarket,
      activeProductLineId: urlProductLineId,
      menuCollapsed: stored.menuCollapsed,
      hydrated: true,
    });
  },

  syncFromUrl: (search, persistStorage, options) => {
    const params = parseSearchParams(search);
    const rawBrandId = params.get('brandId')?.trim() || null;
    const rawMarket = parseGeoMarket(params.get('market'));
    const hasProductLineParam = params.has('productLineId');
    const rawProductLineId = normalizeProductLineId(params.get('productLineId'));
    const clearMissingProductLine = Boolean(options?.clearMissingProductLine);
    if (!rawBrandId && !rawMarket && !hasProductLineParam && !clearMissingProductLine) return;

    const state = get();
    if (!state.brandsLoaded) {
      const nextBrandId = rawBrandId ?? state.activeBrandId;
      const brandChanged = nextBrandId !== state.activeBrandId;
      set({
        activeBrandId: nextBrandId,
        activeMarket: rawMarket ?? state.activeMarket,
        ...(brandChanged
          ? resetProductLinesSlice(state.productLinesLoadSeq, rawProductLineId)
          : hasProductLineParam
            ? { activeProductLineId: rawProductLineId }
            : clearMissingProductLine
              ? { activeProductLineId: null }
              : {}),
      });
      return;
    }

    const resolved = resolveActiveWorkspace(
      state.brands,
      rawBrandId ?? state.activeBrandId,
      rawMarket ?? state.activeMarket,
    );
    const brandChanged = resolved.activeBrandId !== state.activeBrandId;
    const marketChanged = resolved.activeMarket !== state.activeMarket;

    let nextProductLineId = state.activeProductLineId;
    if (brandChanged) {
      // Clear stale line unless the same URL explicitly passes a new productLineId for the new brand
      nextProductLineId = hasProductLineParam ? rawProductLineId : null;
    } else if (hasProductLineParam) {
      if (
        rawProductLineId !== null &&
        state.productLinesLoaded &&
        state.productLinesBrandId === resolved.activeBrandId &&
        !state.productLines.some((item) => item.id === rawProductLineId)
      ) {
        nextProductLineId = null;
      } else {
        nextProductLineId = rawProductLineId;
      }
    } else if (clearMissingProductLine) {
      nextProductLineId = null;
    }

    const lineChanged = nextProductLineId !== state.activeProductLineId;
    const changed = brandChanged || marketChanged;

    if (changed || lineChanged) {
      set({
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        ...(brandChanged
          ? resetProductLinesSlice(state.productLinesLoadSeq, nextProductLineId)
          : { activeProductLineId: nextProductLineId }),
        ...(changed ? { contextEpoch: state.contextEpoch + 1 } : {}),
      });
      if (changed) {
        writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
          activeBrandId: resolved.activeBrandId,
          activeMarket: resolved.activeMarket,
          menuCollapsed: state.menuCollapsed,
        });
      }
    }
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket, {
      ...(brandChanged || hasProductLineParam || clearMissingProductLine
        ? { productLineId: nextProductLineId }
        : {}),
    });
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
      const brandChanged = resolved.activeBrandId !== state.activeBrandId;
      const changed = brandChanged || resolved.activeMarket !== state.activeMarket;

      set({
        brands: response.items,
        brandsLoading: false,
        brandsLoaded: true,
        brandsError: null,
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        ...(brandChanged ? resetProductLinesSlice(state.productLinesLoadSeq) : {}),
        contextEpoch: changed ? state.contextEpoch + 1 : state.contextEpoch,
      });
      writeWorkspaceStorage(options?.persistStorage ?? defaultPersistStorage(), {
        activeBrandId: resolved.activeBrandId,
        activeMarket: resolved.activeMarket,
        menuCollapsed: get().menuCollapsed,
      });
      syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket, {
        ...(brandChanged ? { productLineId: null } : {}),
      });
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

  setActiveBrand: (brandId, preferredMarket, persistStorage, options) => {
    const state = get();
    if (state.brands.length === 0) return;
    const resolved = resolveActiveWorkspace(
      state.brands,
      brandId,
      preferredMarket ?? state.activeMarket,
    );
    const brandChanged = resolved.activeBrandId !== state.activeBrandId;
    const changed = brandChanged || resolved.activeMarket !== state.activeMarket;
    set({
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      ...(brandChanged ? resetProductLinesSlice(state.productLinesLoadSeq) : {}),
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket, {
      clearItemParams: changed && !options?.preserveItemParams,
      ...(brandChanged ? { productLineId: null } : {}),
    });
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
    syncWorkspaceQueryInUrl(state.activeBrandId, market, { clearItemParams: true });
  },

  setActiveProductLine: (productLineId) => {
    const state = get();
    let nextId = state.activeBrandId ? normalizeProductLineId(productLineId) : null;
    if (
      nextId !== null &&
      state.productLinesLoaded &&
      state.productLinesBrandId === state.activeBrandId &&
      !state.productLines.some((item) => item.id === nextId)
    ) {
      nextId = null;
    }
    const changed = state.activeProductLineId !== nextId;
    if (changed) {
      set({ activeProductLineId: nextId });
    }
    syncProductLineQueryInUrl(nextId, { clearItemParams: changed });
  },

  loadProductLines: async (brandId, options) => {
    const trimmedBrandId = brandId.trim();
    if (!trimmedBrandId || options?.signal?.aborted || get().activeBrandId !== trimmedBrandId) {
      return;
    }
    const seq = get().productLinesLoadSeq + 1;
    set({
      productLinesLoadSeq: seq,
      productLinesLoading: true,
      productLinesError: null,
    });
    try {
      const response = await (options?.fetcher
        ? options.fetcher()
        : listBrandProductLines(trimmedBrandId, {
            storage: options?.storage,
            signal: options?.signal,
          }));
      if (options?.signal?.aborted) {
        if (get().productLinesLoadSeq === seq) {
          set({ productLinesLoading: false });
        }
        return;
      }
      const latest = get();
      if (latest.productLinesLoadSeq !== seq || latest.activeBrandId !== trimmedBrandId) return;

      const sorted = sortProductLines(response.items ?? []);
      const currentLineId = latest.activeProductLineId;
      const hasValidActive =
        currentLineId !== null && sorted.some((item) => item.id === currentLineId);
      const nextActiveLineId = hasValidActive ? currentLineId : null;

      set({
        productLines: sorted,
        productLinesBrandId: trimmedBrandId,
        productLinesLoading: false,
        productLinesLoaded: true,
        productLinesError: null,
        activeProductLineId: nextActiveLineId,
      });
      if (currentLineId !== null && !hasValidActive) {
        syncProductLineQueryInUrl(null);
      }
    } catch (error: unknown) {
      if (options?.signal?.aborted) {
        if (get().productLinesLoadSeq === seq) {
          set({ productLinesLoading: false });
        }
        return;
      }
      const latest = get();
      if (latest.productLinesLoadSeq !== seq || latest.activeBrandId !== trimmedBrandId) return;
      const message =
        error instanceof Error && error.message ? error.message : '无法加载产品线列表';
      const hadFreshListForBrand =
        latest.productLinesLoaded && latest.productLinesBrandId === trimmedBrandId;
      const clearedUnverifiedActive = !hadFreshListForBrand && latest.activeProductLineId !== null;
      set({
        productLinesLoading: false,
        productLinesError: message,
        ...(hadFreshListForBrand
          ? {}
          : {
              productLines: [],
              productLinesLoaded: false,
              productLinesBrandId: null,
              activeProductLineId: null,
            }),
      });
      if (clearedUnverifiedActive) {
        syncProductLineQueryInUrl(null);
      }
    }
  },

  upsertProductLine: (line) => {
    const state = get();
    if (state.activeBrandId !== line.brandId) return;
    const base = state.productLinesBrandId === line.brandId ? state.productLines : [];
    const exists = base.some((item) => item.id === line.id);
    const next = sortProductLines(
      exists ? base.map((item) => (item.id === line.id ? line : item)) : [...base, line],
    );
    set({
      productLines: next,
      productLinesBrandId: line.brandId,
      productLinesLoaded: true,
      productLinesError: null,
    });
  },

  removeProductLine: (lineId) => {
    const state = get();
    const next = state.productLines.filter((item) => item.id !== lineId);
    const clearedActive = state.activeProductLineId === lineId;
    set({
      productLines: next,
      ...(clearedActive ? { activeProductLineId: null } : {}),
    });
    if (clearedActive) {
      syncProductLineQueryInUrl(null, { clearItemParams: true });
    }
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
    const brandChanged = resolved.activeBrandId !== state.activeBrandId;

    set({
      brands: nextBrands,
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      ...(brandChanged ? resetProductLinesSlice(state.productLinesLoadSeq) : {}),
      loadSeq: state.loadSeq + 1,
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(options?.persistStorage ?? defaultPersistStorage(), {
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket, {
      ...(brandChanged ? { productLineId: null } : {}),
    });
  },

  removeBrand: (brandId, persistStorage) => {
    const state = get();
    const nextBrands = state.brands.filter((item) => item.id !== brandId);
    const preferredBrandId = state.activeBrandId === brandId ? null : state.activeBrandId;
    const resolved = resolveActiveWorkspace(nextBrands, preferredBrandId, state.activeMarket);
    const brandChanged = resolved.activeBrandId !== state.activeBrandId;

    set({
      brands: nextBrands,
      brandsLoading: false,
      brandsLoaded: true,
      brandsError: null,
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      ...(brandChanged ? resetProductLinesSlice(state.productLinesLoadSeq) : {}),
      loadSeq: state.loadSeq + 1,
      contextEpoch: state.contextEpoch + 1,
    });
    writeWorkspaceStorage(persistStorage ?? defaultPersistStorage(), {
      activeBrandId: resolved.activeBrandId,
      activeMarket: resolved.activeMarket,
      menuCollapsed: state.menuCollapsed,
    });
    syncWorkspaceQueryInUrl(resolved.activeBrandId, resolved.activeMarket, {
      ...(brandChanged ? { productLineId: null } : {}),
    });
  },

  markBrandTruthSigned: (brandId, signedAt) => {
    const state = get();
    const nextBrands = state.brands.map((item) =>
      item.id === brandId ? { ...item, truthAgreementSignedAt: signedAt } : item,
    );
    set({ brands: nextBrands });
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
    const prev = get();
    set({
      ...initialWorkspaceState(),
      loadSeq: prev.loadSeq + 1,
      productLinesLoadSeq: prev.productLinesLoadSeq + 1,
    });
    syncProductLineQueryInUrl(null);
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

export function selectActiveProductLine(state: WorkspaceState): BrandProductLineDto | null {
  if (!state.activeProductLineId || state.productLinesBrandId !== state.activeBrandId) {
    return null;
  }
  return state.productLines.find((item) => item.id === state.activeProductLineId) ?? null;
}
