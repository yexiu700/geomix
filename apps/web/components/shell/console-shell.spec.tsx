// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedAccount, writeCachedAccount } from '../../lib/account-cache';
import type { AccountProfile } from '../../lib/api';
import { saveSession } from '../../lib/session';
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_USER_KEY,
  useWorkspaceStore,
} from '../../lib/workspace-store';
import { ConsoleShell } from './console-shell';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let mockPathname = '/home';
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

const loadAccountMock = vi.fn();
const logoutSessionMock = vi.fn();
const saveAccountUiPrefsMock = vi.fn();
const listBrandsMock = vi.fn();
const listBrandProductLinesMock = vi.fn();
const httpWalletMock = vi.fn();
const httpAnnouncementsMock = vi.fn();

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    loadAccount: (...args: unknown[]) => loadAccountMock(...args),
    logoutSession: (...args: unknown[]) => logoutSessionMock(...args),
    saveAccountUiPrefs: (...args: unknown[]) => saveAccountUiPrefsMock(...args),
  };
});

vi.mock('../../lib/brands', () => ({
  listBrands: (...args: unknown[]) => listBrandsMock(...args),
  listBrandProductLines: (...args: unknown[]) => listBrandProductLinesMock(...args),
  createBrand: vi.fn(),
  enableBrandMarket: vi.fn(),
  updateBrandMarket: vi.fn(),
  suggestBrandMarketConfig: vi.fn(),
  extractBrandFacts: vi.fn(),
  saveBrandFacts: vi.fn(),
}));

vi.mock('../../lib/account-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/account-client')>();
  return {
    ...actual,
    httpWallet: (...args: unknown[]) => httpWalletMock(...args),
    httpAnnouncements: (...args: unknown[]) => httpAnnouncementsMock(...args),
  };
});

const merchantAccount: AccountProfile = {
  id: 'u-merchant-1',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-1',
    name: '演示租户',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

const sampleBrand: BrandRecord = {
  id: 'b-1',
  name: '绿联',
  category: '家用 NAS',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  markets: [
    {
      id: 'm-1',
      brandId: 'b-1',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '绿联',
      aliases: [],
      ownedDomains: [],
      competitors: [],
      seedPrompts: [],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  mockPathname = '/home';
  mockSearchParams = new URLSearchParams();
  window.history.replaceState(null, '', '/home');
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearCachedAccount();
  useWorkspaceStore.getState().reset(window.localStorage);
  pushMock.mockReset();
  replaceMock.mockReset();
  loadAccountMock.mockReset();
  logoutSessionMock.mockReset().mockResolvedValue(undefined);
  saveAccountUiPrefsMock.mockReset().mockResolvedValue(true);
  listBrandsMock.mockReset().mockResolvedValue({ items: [sampleBrand] });
  listBrandProductLinesMock.mockReset().mockResolvedValue({ items: [] });
  httpWalletMock.mockReset().mockResolvedValue({
    points: 1000,
    pointsReserved: 0,
    available: 1000,
    money: '0.00',
    billingMode: 'SHADOW',
    billingModeSource: 'global',
    tenantBillingMode: null,
  });
  httpAnnouncementsMock.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  clearCachedAccount();
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

describe('ConsoleShell (GeoMix 2.0)', () => {
  it('renders {children}, hydrates brands & wallet, and syncs menu collapse prefs', async () => {
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    render(
      <ConsoleShell>
        <div data-testid="workspace-child">行动首页子内容</div>
      </ConsoleShell>,
    );

    expect(await screen.findByTestId('workspace-child')).toBeTruthy();
    await waitFor(() => {
      expect(listBrandsMock).toHaveBeenCalledTimes(1);
      expect(httpWalletMock).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('header-points-pill')).toBeTruthy();
    expect(document.title).toBe('行动首页 · GeoMix');

    fireEvent.click(screen.getByRole('button', { name: '收起菜单' }));
    expect(saveAccountUiPrefsMock).toHaveBeenCalledWith(window.sessionStorage, {
      menuCollapsed: true,
    });
  });

  it('renders immediately from warm account cache without boot flash (#203)', () => {
    saveSession(window.sessionStorage, 'at-warm', 'rt-warm');
    writeCachedAccount(window.sessionStorage, merchantAccount);
    loadAccountMock.mockReturnValue(new Promise(() => undefined));

    render(
      <ConsoleShell>
        <div>缓存直出内容</div>
      </ConsoleShell>,
    );

    expect(screen.queryByText('正在确认登录')).toBeNull();
    expect(screen.getByText('缓存直出内容')).toBeTruthy();
  });

  it('renders boot skeleton and header skeletons without fake 0 点 / 免费体验期 / ¥0.00 during cold load', async () => {
    let resolveAccount!: (value: { status: 'ok'; account: AccountProfile }) => void;
    let resolveBrands!: (value: { items: BrandRecord[] }) => void;
    let resolveWallet!: (value: {
      points: number;
      pointsReserved: number;
      available: number;
      money: string;
      billingMode: 'SHADOW' | 'STRICT';
      billingModeSource: 'global' | 'tenant';
      tenantBillingMode: 'SHADOW' | 'STRICT' | null;
    }) => void;

    loadAccountMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    listBrandsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBrands = resolve;
      }),
    );
    httpWalletMock.mockReturnValue(
      new Promise((resolve) => {
        resolveWallet = resolve;
      }),
    );

    render(
      <ConsoleShell>
        <div>首页正文</div>
      </ConsoleShell>,
    );

    const assertNoForbiddenFlicker = () => {
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/(?:^|[^\d])0\s*点/);
      expect(text).not.toContain('免费体验期');
      expect(text).not.toContain('¥0.00');
    };

    const bootSkeleton = screen.getByTestId('console-boot-skeleton');
    expect(bootSkeleton.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.ant-skeleton')).toBeTruthy();
    expect(screen.getByText('正在确认登录')).toBeTruthy();
    assertNoForbiddenFlicker();

    await act(async () => {
      resolveAccount({ status: 'ok', account: merchantAccount });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('console-boot-skeleton')).toBeNull();
    });
    expect(screen.getByTestId('global-brand-switcher-loading').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(screen.getByTestId('header-points-loading').getAttribute('aria-busy')).toBe('true');
    assertNoForbiddenFlicker();

    await act(async () => {
      resolveBrands({ items: [sampleBrand] });
      resolveWallet({
        points: 888,
        pointsReserved: 0,
        available: 888,
        money: '0.00',
        billingMode: 'SHADOW',
        billingModeSource: 'global',
        tenantBillingMode: null,
      });
    });

    const pointsPill = await screen.findByTestId('header-points-pill');
    expect(pointsPill.textContent).toContain('888');
  });

  it('resets stored workspace state when a different user signs in', async () => {
    window.localStorage.setItem(WORKSPACE_USER_KEY, 'u-previous');
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ activeBrandId: 'stale-brand', activeMarket: 'GLOBAL', menuCollapsed: true }),
    );
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    render(
      <ConsoleShell>
        <div>切换用户后正文</div>
      </ConsoleShell>,
    );

    await waitFor(() => {
      expect(window.localStorage.getItem(WORKSPACE_USER_KEY)).toBe(merchantAccount.id);
      expect(useWorkspaceStore.getState().activeBrandId).toBe('b-1');
    });
  });

  it('redirects unauthenticated requests to /login?next=%2Fhome and handles invalid paths with 回首页 -> /home', async () => {
    loadAccountMock.mockResolvedValue({ status: 'anonymous' });
    const { unmount } = render(
      <ConsoleShell>
        <div>protected</div>
      </ConsoleShell>,
    );
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fhome');
    });
    unmount();

    mockPathname = '/nonexistent-v1-path';
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });
    render(
      <ConsoleShell>
        <div>invalid</div>
      </ConsoleShell>,
    );
    expect(await screen.findByText('没有这个页面')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '回首页' }));
    expect(pushMock).toHaveBeenCalledWith('/home');
  });

  it('auto-collapses /studio into 72px rail without overwriting persisted menuCollapsed and restores /home expanded', async () => {
    mockPathname = '/studio';
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    const { rerender } = render(
      <ConsoleShell>
        <div>写作台内容</div>
      </ConsoleShell>,
    );

    expect(await screen.findByText('写作台内容')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));
    expect(document.querySelector('aside.gm-sider-rail')).toBeNull();
    expect(saveAccountUiPrefsMock).not.toHaveBeenCalled();

    mockPathname = '/home';
    rerender(
      <ConsoleShell>
        <div>行动首页内容</div>
      </ConsoleShell>,
    );

    expect(await screen.findByText('行动首页内容')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeNull();
    expect(useWorkspaceStore.getState().menuCollapsed).toBe(false);

    mockPathname = '/publish';
    rerender(
      <ConsoleShell>
        <div>发布中心内容</div>
      </ConsoleShell>,
    );
    expect(await screen.findByText('发布中心内容')).toBeTruthy();
    expect(document.querySelector('aside.gm-sider-rail')).toBeTruthy();
  });

  it('does not fetch product lines for a stale/foreign brandId before brandsLoaded reconciles to an owned brand', async () => {
    mockPathname = '/home';
    mockSearchParams = new URLSearchParams('brandId=nonexistent_brand_123&market=CN');
    window.history.replaceState(null, '', '/home?brandId=nonexistent_brand_123&market=CN');
    window.localStorage.setItem(WORKSPACE_USER_KEY, merchantAccount.id);
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        activeBrandId: 'nonexistent_brand_123',
        activeMarket: 'CN',
        menuCollapsed: false,
      }),
    );

    let resolveBrands!: (value: { items: BrandRecord[] }) => void;
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });
    listBrandsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBrands = resolve;
      }),
    );

    render(
      <ConsoleShell>
        <div>首页内容</div>
      </ConsoleShell>,
    );

    await waitFor(() => {
      expect(listBrandsMock).toHaveBeenCalledTimes(1);
    });
    expect(listBrandProductLinesMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveBrands({ items: [sampleBrand] });
    });

    await waitFor(() => {
      expect(listBrandProductLinesMock).toHaveBeenCalledTimes(1);
      expect(listBrandProductLinesMock).toHaveBeenCalledWith(
        'b-1',
        expect.objectContaining({ storage: window.sessionStorage }),
      );
    });
  });

  it('Tier 5 #8: preserves activeProductLineId on navigateWorkspace across business workspaces, omits it on /account, and syncs popstate back to unscoped URL', async () => {
    const now = '2026-11-25T10:00:00.000Z';
    mockPathname = '/home';
    mockSearchParams = new URLSearchParams('brandId=b-1&market=CN&productLineId=pl-1');
    window.history.replaceState(null, '', '/home?brandId=b-1&market=CN&productLineId=pl-1');
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });
    listBrandProductLinesMock.mockResolvedValue({
      items: [
        {
          id: 'pl-1',
          brandId: 'b-1',
          name: '家用 NAS',
          localNamesJson: {},
          category: '家用 NAS',
          localCategoriesJson: {},
          seedPromptsJson: {},
          competitorsJson: {},
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    render(
      <ConsoleShell>
        <div>首页内容</div>
      </ConsoleShell>,
    );

    await waitFor(() => {
      expect(useWorkspaceStore.getState().productLinesLoaded).toBe(true);
      expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-1');
    });

    // Click sidebar nav to /visibility -> pushes URL WITH productLineId=pl-1
    fireEvent.click(screen.getByText('可见度诊断'));
    expect(pushMock).toHaveBeenCalledWith('/visibility?brandId=b-1&market=CN&productLineId=pl-1');

    // Click account entry -> /account omits productLineId via QUERY_KEYS
    fireEvent.click(screen.getByTestId('sider-account-entry'));
    expect(pushMock).toHaveBeenLastCalledWith('/account');

    // Browser Back (popstate) to /home?brandId=b-1&market=CN (without productLineId) clears activeProductLineId
    window.history.replaceState(null, '', '/home?brandId=b-1&market=CN');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
  });
});
