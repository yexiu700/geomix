// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_USER_KEY,
  parseGeoMarket,
  resolveActiveWorkspace,
  selectActiveBrand,
  selectActiveBrandMarket,
  useWorkspaceStore,
} from './workspace-store';

function makeBrand(id: string, name: string, markets: Array<'CN' | 'GLOBAL'>): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    name,
    category: '家用 NAS',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: markets.map((market) => ({
      id: `${id}-${market}`,
      brandId: id,
      market,
      locale: market === 'CN' ? 'zh-CN' : 'en-US',
      region: market === 'CN' ? 'CN' : 'US',
      localBrandName: market === 'CN' ? name : `${name} Global`,
      aliases: [],
      ownedDomains: [],
      competitors: [],
      seedPrompts: [],
      createdAt: now,
      updatedAt: now,
    })),
  };
}

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/home');
    useWorkspaceStore.getState().reset(window.localStorage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with brandsLoading=true to prevent cold-load empty-state flicker', () => {
    const state = useWorkspaceStore.getState();
    expect(state.brandsLoading).toBe(true);
    expect(state.brandsLoaded).toBe(false);
    expect(state.brands).toEqual([]);
    expect(state.activeBrandId).toBeNull();
    expect(state.activeMarket).toBe('CN');
  });

  it('parses markets case-insensitively and coerces single-market brands', () => {
    expect(parseGeoMarket('cn')).toBe('CN');
    expect(parseGeoMarket('GLOBAL')).toBe('GLOBAL');
    expect(parseGeoMarket('eu')).toBeNull();

    const cnOnly = makeBrand('b-cn', '绿联', ['CN']);
    const globalOnly = makeBrand('b-gl', 'UGREEN', ['GLOBAL']);
    const dual = makeBrand('b-dual', '双市场品牌', ['CN', 'GLOBAL']);

    expect(resolveActiveWorkspace([cnOnly], 'b-cn', 'GLOBAL')).toEqual({
      activeBrandId: 'b-cn',
      activeMarket: 'CN',
    });
    expect(resolveActiveWorkspace([globalOnly], 'b-gl', 'CN')).toEqual({
      activeBrandId: 'b-gl',
      activeMarket: 'GLOBAL',
    });
    expect(resolveActiveWorkspace([cnOnly, dual], 'b-dual', 'GLOBAL')).toEqual({
      activeBrandId: 'b-dual',
      activeMarket: 'GLOBAL',
    });
    expect(resolveActiveWorkspace([cnOnly], 'missing', 'CN')).toEqual({
      activeBrandId: 'b-cn',
      activeMarket: 'CN',
    });
  });

  it('hydrates with URL query priority over localStorage', () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        activeBrandId: 'brand-stored',
        activeMarket: 'CN',
        menuCollapsed: true,
      }),
    );

    useWorkspaceStore.getState().hydrate('?brandId=brand-url&market=GLOBAL', window.localStorage);
    const state = useWorkspaceStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.activeBrandId).toBe('brand-url');
    expect(state.activeMarket).toBe('GLOBAL');
    expect(state.menuCollapsed).toBe(true);
  });

  it('discards out-of-order stale loadBrands responses via loadSeq guard', async () => {
    const brandOld = makeBrand('b-old', '旧响应品牌', ['CN']);
    const brandNew = makeBrand('b-new', '新响应品牌', ['CN', 'GLOBAL']);

    let resolveFirst!: (value: { items: BrandRecord[] }) => void;
    let resolveSecond!: (value: { items: BrandRecord[] }) => void;

    const firstPromise = new Promise<{ items: BrandRecord[] }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<{ items: BrandRecord[] }>((resolve) => {
      resolveSecond = resolve;
    });

    const load1 = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () => firstPromise,
    });
    const load2 = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () => secondPromise,
    });

    resolveSecond({ items: [brandNew] });
    await load2;
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-new');

    resolveFirst({ items: [brandOld] });
    await load1;
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-new');
    expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-new']);
  });

  it('coerces URL ?market=GLOBAL back to CN for a CN-only brand and syncs URL/localStorage', async () => {
    const cnOnly = makeBrand('b-cn', '国内品牌', ['CN']);
    window.history.replaceState(null, '', '/home?brandId=b-cn&market=GLOBAL');
    useWorkspaceStore.getState().hydrate(window.location.search, window.localStorage);

    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: async () => ({ items: [cnOnly] }),
    });

    const state = useWorkspaceStore.getState();
    expect(state.activeBrandId).toBe('b-cn');
    expect(state.activeMarket).toBe('CN');
    expect(selectActiveBrand(state)?.id).toBe('b-cn');
    expect(selectActiveBrandMarket(state)?.market).toBe('CN');
    expect(window.location.search).toBe('?brandId=b-cn&market=CN');

    // Trying to switch to disabled GLOBAL is ignored
    useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage);
    expect(useWorkspaceStore.getState().activeMarket).toBe('CN');
  });

  it('activates newly created/updated brand via upsertBrand and switches markets cleanly', async () => {
    const cnOnly = makeBrand('b-1', '智造激光', ['CN']);
    useWorkspaceStore.getState().upsertBrand(cnOnly, {
      activate: true,
      persistStorage: window.localStorage,
    });
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-1');
    expect(useWorkspaceStore.getState().activeMarket).toBe('CN');

    const dual = makeBrand('b-1', '智造激光', ['CN', 'GLOBAL']);
    useWorkspaceStore.getState().upsertBrand(dual, {
      activate: true,
      market: 'GLOBAL',
      persistStorage: window.localStorage,
    });
    expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
    expect(window.location.search).toBe('?brandId=b-1&market=GLOBAL');

    const secondCnOnly = makeBrand('b-2', '仅国内品牌', ['CN']);
    useWorkspaceStore.getState().upsertBrand(secondCnOnly, {
      activate: false,
      persistStorage: window.localStorage,
    });
    // Switching to CN-only brand coerces GLOBAL -> CN
    useWorkspaceStore.getState().setActiveBrand('b-2', undefined, window.localStorage);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
    expect(useWorkspaceStore.getState().activeMarket).toBe('CN');
  });

  it('invalidates older in-flight loadBrands when upsertBrand commits first', async () => {
    const brandOld = makeBrand('b-old', '旧列表品牌', ['CN']);
    const brandNew = makeBrand('b-new', '刚创建品牌', ['CN', 'GLOBAL']);

    let resolveStale!: (value: { items: BrandRecord[] }) => void;
    const staleLoad = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    });

    useWorkspaceStore.getState().upsertBrand(brandNew, {
      activate: true,
      market: 'GLOBAL',
      persistStorage: window.localStorage,
    });

    resolveStale({ items: [brandOld] });
    await staleLoad;

    expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-new']);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-new');
    expect(useWorkspaceStore.getState().activeMarket).toBe('GLOBAL');
    expect(useWorkspaceStore.getState().brandsError).toBeNull();

    let rejectStale!: (reason: Error) => void;
    const failingStaleLoad = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () =>
        new Promise((_, reject) => {
          rejectStale = reject;
        }),
    });

    const brandUpdated = makeBrand('b-new', '刚更新品牌', ['CN', 'GLOBAL']);
    useWorkspaceStore.getState().upsertBrand(brandUpdated, {
      activate: true,
      persistStorage: window.localStorage,
    });

    rejectStale(new Error('stale network failure'));
    await failingStaleLoad;

    expect(useWorkspaceStore.getState().brands.map((b) => b.name)).toEqual(['刚更新品牌']);
    expect(useWorkspaceStore.getState().brandsError).toBeNull();
  });

  it('resets storage, legacy shell keys, and invalidates in-flight loads on reset()', async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '{"activeBrandId":"b-1"}');
    window.localStorage.setItem(WORKSPACE_USER_KEY, 'user-1');
    window.localStorage.setItem('geomix.shell.v2', '{}');

    let resolvePending!: (value: { items: BrandRecord[] }) => void;
    const pending = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    });

    useWorkspaceStore.getState().reset(window.localStorage);
    resolvePending({ items: [makeBrand('b-stale', '过期用户品牌', ['CN'])] });
    await pending;

    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(WORKSPACE_USER_KEY)).toBeNull();
    expect(window.localStorage.getItem('geomix.shell.v2')).toBeNull();
    expect(useWorkspaceStore.getState().brands).toEqual([]);
    expect(useWorkspaceStore.getState().brandsLoading).toBe(true);
  });

  it('removes brands via removeBrand, falls back to remaining brand or clears URL at 0 brands, and invalidates in-flight loads', async () => {
    const b1 = makeBrand('b-1', '品牌甲', ['CN', 'GLOBAL']);
    const b2 = makeBrand('b-2', '品牌乙', ['CN']);
    useWorkspaceStore
      .getState()
      .upsertBrand(b2, { activate: false, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, market: 'GLOBAL', persistStorage: window.localStorage });

    expect(window.location.search).toBe('?brandId=b-1&market=GLOBAL');

    let resolveStale!: (value: { items: BrandRecord[] }) => void;
    const staleLoad = useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    });

    useWorkspaceStore.getState().removeBrand('b-1', window.localStorage);
    expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-2']);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
    expect(useWorkspaceStore.getState().activeMarket).toBe('CN');
    expect(window.location.search).toBe('?brandId=b-2&market=CN');

    resolveStale({ items: [b1, b2] });
    await staleLoad;
    expect(useWorkspaceStore.getState().brands.map((b) => b.id)).toEqual(['b-2']);

    useWorkspaceStore.getState().removeBrand('b-2', window.localStorage);
    expect(useWorkspaceStore.getState().brands).toEqual([]);
    expect(useWorkspaceStore.getState().activeBrandId).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('marks brand truth agreement timestamp via markBrandTruthSigned without bumping contextEpoch', () => {
    const b1 = makeBrand('b-1', '品牌甲', ['CN']);
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, persistStorage: window.localStorage });
    const epochBefore = useWorkspaceStore.getState().contextEpoch;
    const signedAt = '2026-11-20T08:00:00.000Z';

    useWorkspaceStore.getState().markBrandTruthSigned('b-1', signedAt);
    expect(useWorkspaceStore.getState().contextEpoch).toBe(epochBefore);
    expect(useWorkspaceStore.getState().brands[0]?.truthAgreementSignedAt).toBe(signedAt);
  });

  it('preserves existing window.history.state when syncing workspace query params (W-05)', () => {
    const customState = { __NA: true, tree: ['home'] };
    window.history.replaceState(customState, '', '/studio');
    const b1 = makeBrand('b-state-1', '状态保留品牌', ['CN']);
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, market: 'CN', persistStorage: window.localStorage });

    expect(window.location.search).toBe('?brandId=b-state-1&market=CN');
    expect(window.history.state).toEqual(customState);
  });
});
