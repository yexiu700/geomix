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
  createBrand: vi.fn(),
  enableBrandMarket: vi.fn(),
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
});
