// @vitest-environment jsdom

import type { BrandProductLineDto, BrandRecord } from '@geomix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_USER_KEY,
  parseGeoMarket,
  resolveActiveWorkspace,
  selectActiveBrand,
  selectActiveBrandMarket,
  selectActiveProductLine,
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

  it('loads, sorts, selects, upserts, and removes product lines while syncing ?productLineId= without touching localStorage', async () => {
    const makeLine = (
      id: string,
      brandId: string,
      name: string,
      sortOrder: number,
      createdAt = '2026-11-20T00:00:00.000Z',
    ): BrandProductLineDto => ({
      id,
      brandId,
      name,
      localNamesJson: {},
      category: 'Hardware',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder,
      createdAt,
      updatedAt: createdAt,
    });

    const b1 = makeBrand('b-1', '品牌甲', ['CN', 'GLOBAL']);
    const customState = { __NA: true, key: 'pl-state' };
    window.history.replaceState(customState, '', '/home?brandId=b-1&market=GLOBAL');
    useWorkspaceStore
      .getState()
      .upsertBrand(b1, { activate: true, market: 'GLOBAL', persistStorage: window.localStorage });

    const lineB = makeLine('pl-b', 'b-1', 'Home NAS', 2);
    const lineA = makeLine('pl-a', 'b-1', 'Power Station', 1);

    // Out-of-order response guard
    let resolveOld!: (value: { items: BrandProductLineDto[] }) => void;
    const oldLoad = useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    });
    const newLoad = useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: async () => ({ items: [lineB, lineA] }),
    });
    await newLoad;
    resolveOld({ items: [makeLine('pl-stale', 'b-1', 'Stale', 0)] });
    await oldLoad;

    const afterLoad = useWorkspaceStore.getState();
    expect(afterLoad.productLines.map((l) => l.id)).toEqual(['pl-a', 'pl-b']);
    expect(afterLoad.productLinesBrandId).toBe('b-1');
    expect(afterLoad.productLinesLoaded).toBe(true);
    expect(selectActiveProductLine(afterLoad)).toBeNull();

    // Selecting valid line updates state & URL (preserving history.state), never localStorage
    useWorkspaceStore.getState().setActiveProductLine(' pl-a ');
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-a');
    expect(selectActiveProductLine(useWorkspaceStore.getState())?.name).toBe('Power Station');
    expect(window.location.search).toContain('productLineId=pl-a');
    expect(window.history.state).toEqual(customState);
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('pl-a');

    // Selecting unknown line when loaded coerces to null and strips URL param
    useWorkspaceStore.getState().setActiveProductLine('pl-unknown');
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();

    // Upsert preserves canonical order & ignores foreign brand
    useWorkspaceStore.getState().upsertProductLine(makeLine('pl-c', 'b-1', 'Audio', 0));
    useWorkspaceStore.getState().upsertProductLine(makeLine('pl-foreign', 'b-other', 'Other', 0));
    expect(useWorkspaceStore.getState().productLines.map((l) => l.id)).toEqual([
      'pl-c',
      'pl-a',
      'pl-b',
    ]);

    // Deleting active line resets activeProductLineId synchronously and strips URL
    useWorkspaceStore.getState().setActiveProductLine('pl-c');
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBe('pl-c');
    useWorkspaceStore.getState().removeProductLine('pl-c');
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();
  });

  it('synchronously resets activeProductLineId and strips ?productLineId= on brand switches, removal, loadBrands, syncFromUrl, and reset', async () => {
    const line1: BrandProductLineDto = {
      id: 'pl-1',
      brandId: 'b-1',
      name: 'Power Station',
      localNamesJson: {},
      category: 'Power',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const b1 = makeBrand('b-1', '品牌甲', ['CN', 'GLOBAL']);
    const b2 = makeBrand('b-2', '品牌乙', ['CN', 'GLOBAL']);
    const b3 = makeBrand('b-3', '品牌丙', ['CN']);

    window.history.replaceState(null, '', '/home?brandId=b-1&market=GLOBAL');
    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      preferredBrandId: 'b-1',
      preferredMarket: 'GLOBAL',
      fetcher: async () => ({ items: [b1, b2] }),
    });
    await useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: async () => ({ items: [line1] }),
    });
    useWorkspaceStore.getState().setActiveProductLine('pl-1');
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-1');
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBe('pl-1');

    // 1. setActiveBrand to different brand synchronously clears line & strips URL
    useWorkspaceStore.getState().setActiveBrand('b-2', 'GLOBAL', window.localStorage);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(useWorkspaceStore.getState().productLines).toEqual([]);
    expect(useWorkspaceStore.getState().productLinesLoaded).toBe(false);
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();

    // 2. syncFromUrl to different brand clears stale line unless explicitly passed
    useWorkspaceStore.getState().setActiveBrand('b-1', 'GLOBAL', window.localStorage);
    await useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: async () => ({ items: [line1] }),
    });
    useWorkspaceStore.getState().setActiveProductLine('pl-1');
    useWorkspaceStore.getState().syncFromUrl('?brandId=b-2&market=GLOBAL', window.localStorage);
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-2');
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();

    // 3. upsertBrand activating a new brand clears activeProductLineId
    useWorkspaceStore.getState().setActiveBrand('b-1', 'GLOBAL', window.localStorage);
    await useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: async () => ({ items: [line1] }),
    });
    useWorkspaceStore.getState().setActiveProductLine('pl-1');
    useWorkspaceStore
      .getState()
      .upsertBrand(b3, { activate: true, persistStorage: window.localStorage });
    expect(useWorkspaceStore.getState().activeBrandId).toBe('b-3');
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();

    // 4. removeBrand of active brand clears activeProductLineId
    useWorkspaceStore.getState().setActiveBrand('b-1', 'GLOBAL', window.localStorage);
    await useWorkspaceStore.getState().loadProductLines('b-1', {
      fetcher: async () => ({ items: [line1] }),
    });
    useWorkspaceStore.getState().setActiveProductLine('pl-1');
    useWorkspaceStore.getState().removeBrand('b-1', window.localStorage);
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();

    // 5. loadProductLines resets stale URL ?productLineId= that doesn't exist in loaded brand
    window.history.replaceState(null, '', '/home?brandId=b-2&market=GLOBAL&productLineId=stale-id');
    useWorkspaceStore.getState().hydrate(window.location.search, window.localStorage);
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('stale-id');
    await useWorkspaceStore.getState().loadProductLines('b-2', {
      fetcher: async () => ({ items: [] }),
    });
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();
  });

  it('ignores stale cross-brand loadProductLines calls without aborting active brand load or wedging productLinesLoading (C1-01)', async () => {
    const b1 = makeBrand('brand-1', '品牌甲', ['CN', 'GLOBAL']);
    const b2 = makeBrand('brand-2', '品牌乙', ['CN', 'GLOBAL']);
    const lineB2: BrandProductLineDto = {
      id: 'pl-b2',
      brandId: 'brand-2',
      name: 'Home NAS',
      localNamesJson: {},
      category: 'NAS',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };

    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      preferredBrandId: 'brand-2',
      preferredMarket: 'GLOBAL',
      fetcher: async () => ({ items: [b1, b2] }),
    });
    expect(useWorkspaceStore.getState().activeBrandId).toBe('brand-2');

    let resolveB2!: (value: { items: BrandProductLineDto[] }) => void;
    const b2Load = useWorkspaceStore.getState().loadProductLines('brand-2', {
      fetcher: () =>
        new Promise((resolve) => {
          resolveB2 = resolve;
        }),
    });
    expect(useWorkspaceStore.getState().productLinesLoading).toBe(true);
    const seqAfterB2Start = useWorkspaceStore.getState().productLinesLoadSeq;

    // Stale caller invokes loadProductLines('brand-1') while activeBrandId === 'brand-2'
    const staleFetcher = vi.fn(async () => ({ items: [] }));
    await useWorkspaceStore.getState().loadProductLines('brand-1', {
      fetcher: staleFetcher,
    });
    expect(staleFetcher).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().productLinesLoadSeq).toBe(seqAfterB2Start);

    // Active brand-2 load still commits cleanly and resets loading to false
    resolveB2({ items: [lineB2] });
    await b2Load;
    const state = useWorkspaceStore.getState();
    expect(state.productLinesLoading).toBe(false);
    expect(state.productLinesLoaded).toBe(true);
    expect(state.productLinesBrandId).toBe('brand-2');
    expect(state.productLines.map((item) => item.id)).toEqual(['pl-b2']);
  });

  it('resets productLinesLoading to false when loadProductLines is aborted via AbortController without switching brands (C1-02)', async () => {
    const b1 = makeBrand('brand-1', '品牌甲', ['CN', 'GLOBAL']);
    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      preferredBrandId: 'brand-1',
      preferredMarket: 'GLOBAL',
      fetcher: async () => ({ items: [b1] }),
    });

    // Case A: fetcher rejects after signal abort
    const ctrlReject = new AbortController();
    const loadReject = useWorkspaceStore.getState().loadProductLines('brand-1', {
      signal: ctrlReject.signal,
      fetcher: () =>
        new Promise((_, reject) => {
          ctrlReject.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    });
    expect(useWorkspaceStore.getState().productLinesLoading).toBe(true);
    ctrlReject.abort();
    await loadReject;
    expect(useWorkspaceStore.getState().productLinesLoading).toBe(false);

    // Case B: fetcher resolves after signal abort
    const ctrlResolve = new AbortController();
    let resolveAborted!: (value: { items: BrandProductLineDto[] }) => void;
    const loadResolve = useWorkspaceStore.getState().loadProductLines('brand-1', {
      signal: ctrlResolve.signal,
      fetcher: () =>
        new Promise((resolve) => {
          resolveAborted = resolve;
        }),
    });
    expect(useWorkspaceStore.getState().productLinesLoading).toBe(true);
    ctrlResolve.abort();
    resolveAborted({ items: [] });
    await loadResolve;
    expect(useWorkspaceStore.getState().productLinesLoading).toBe(false);
  });

  it('coerces setActiveProductLine to null and leaves URL clean when activeBrandId is null (C1-03)', () => {
    window.history.replaceState(null, '', '/home');
    expect(useWorkspaceStore.getState().activeBrandId).toBeNull();

    useWorkspaceStore.getState().setActiveProductLine('poison-line');

    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('clears /studio item query params on setActiveProductLine switch while preserving brandId, market, productLineId, and history.state (R2-01)', async () => {
    const b1 = makeBrand('b1', '品牌甲', ['CN', 'GLOBAL']);
    const lineA: BrandProductLineDto = {
      id: 'pl-a',
      brandId: 'b1',
      name: 'Power Station',
      localNamesJson: {},
      category: 'Power',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const lineB: BrandProductLineDto = {
      ...lineA,
      id: 'pl-b',
      name: 'Home NAS',
      sortOrder: 1,
    };

    const customState = { __NA: true, studioKey: 'keep-me' };
    window.history.replaceState(
      customState,
      '',
      '/studio?brandId=b1&market=GLOBAL&articleId=artA&briefId=brA&batchJobId=bjA',
    );
    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      preferredBrandId: 'b1',
      preferredMarket: 'GLOBAL',
      fetcher: async () => ({ items: [b1] }),
    });
    await useWorkspaceStore.getState().loadProductLines('b1', {
      fetcher: async () => ({ items: [lineA, lineB] }),
    });

    // Switch from All -> pl-a clears studio item params and preserves history.state
    useWorkspaceStore.getState().setActiveProductLine('pl-a');
    let params = new URLSearchParams(window.location.search);
    expect(params.get('brandId')).toBe('b1');
    expect(params.get('market')).toBe('GLOBAL');
    expect(params.get('productLineId')).toBe('pl-a');
    expect(params.get('articleId')).toBeNull();
    expect(params.get('briefId')).toBeNull();
    expect(params.get('batchJobId')).toBeNull();
    expect(window.history.state).toEqual(customState);

    // Same-line re-selection does NOT wipe current articleId
    window.history.replaceState(
      customState,
      '',
      '/studio?brandId=b1&market=GLOBAL&productLineId=pl-a&articleId=artA&briefId=brA&batchJobId=bjA',
    );
    useWorkspaceStore.getState().setActiveProductLine('pl-a');
    params = new URLSearchParams(window.location.search);
    expect(params.get('articleId')).toBe('artA');

    // Switch pl-a -> pl-b clears studio item params and preserves brandId, market, productLineId, history.state
    useWorkspaceStore.getState().setActiveProductLine('pl-b');
    params = new URLSearchParams(window.location.search);
    expect(params.get('brandId')).toBe('b1');
    expect(params.get('market')).toBe('GLOBAL');
    expect(params.get('productLineId')).toBe('pl-b');
    expect(params.get('articleId')).toBeNull();
    expect(params.get('briefId')).toBeNull();
    expect(params.get('batchJobId')).toBeNull();
    expect(window.history.state).toEqual(customState);
  });

  it('Tier 5 #11: does not mark productLinesLoaded=true or retain unverified stale URL productLineId on loadProductLines 5xx failure', async () => {
    const b1 = makeBrand('brand-err-1', '测试品牌', ['CN']);
    window.history.replaceState(
      null,
      '',
      '/home?brandId=brand-err-1&market=CN&productLineId=deleted_line_xyz',
    );
    useWorkspaceStore
      .getState()
      .hydrate(
        '?brandId=brand-err-1&market=CN&productLineId=deleted_line_xyz',
        window.localStorage,
      );
    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: async () => ({ items: [b1] }),
    });
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('deleted_line_xyz');

    await useWorkspaceStore.getState().loadProductLines('brand-err-1', {
      fetcher: async () => {
        throw new Error('500 Internal Server Error');
      },
    });

    const state = useWorkspaceStore.getState();
    expect(state.productLinesLoading).toBe(false);
    expect(state.productLinesLoaded).toBe(false);
    expect(state.productLinesBrandId).toBeNull();
    expect(state.productLines).toEqual([]);
    expect(state.productLinesError).toBe('500 Internal Server Error');
    expect(state.activeProductLineId).toBeNull();
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();
  });

  it('Tier 5 #8: syncFromUrl with clearMissingProductLine resets activeProductLineId when navigating back to an unscoped business URL', async () => {
    const now = '2026-11-25T10:00:00.000Z';
    const b1 = makeBrand('brand-pop-1', '测试品牌', ['CN']);
    const lineA = {
      id: 'pl-pop-a',
      brandId: 'brand-pop-1',
      name: 'Line A',
      localNamesJson: {},
      category: '家用 NAS',
      localCategoriesJson: {},
      seedPromptsJson: {},
      competitorsJson: {},
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    await useWorkspaceStore.getState().loadBrands({
      persistStorage: window.localStorage,
      fetcher: async () => ({ items: [b1] }),
    });
    await useWorkspaceStore.getState().loadProductLines('brand-pop-1', {
      fetcher: async () => ({ items: [lineA] }),
    });
    useWorkspaceStore.getState().setActiveProductLine('pl-pop-a');
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-pop-a');

    // Without clearMissingProductLine (e.g. /account), activeProductLineId stays in memory
    useWorkspaceStore.getState().syncFromUrl('?brandId=brand-pop-1&market=CN', window.localStorage);
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-pop-a');

    // With clearMissingProductLine (popstate on business workspace without productLineId), clears cleanly
    useWorkspaceStore
      .getState()
      .syncFromUrl('?brandId=brand-pop-1&market=CN', window.localStorage, {
        clearMissingProductLine: true,
      });
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
  });
});
