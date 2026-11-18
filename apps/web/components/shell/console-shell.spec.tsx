// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedAccount, writeCachedAccount } from '../../lib/account-cache';
import { httpAnnouncements } from '../../lib/account-client';
import type { AccountProfile } from '../../lib/api';
import { saveSession } from '../../lib/session';
import { useShellStore } from '../../lib/shell-store';
import { initialSnapshot } from '../../lib/tab-stack';
import { ConsoleShell } from './console-shell';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let mockPathname = '/dashboard';
const routerMock = { push: pushMock, replace: replaceMock };
const searchParamsMock = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => mockPathname,
  useSearchParams: () => searchParamsMock,
}));

const loadAccountMock = vi.fn();
const saveAccountUiPrefsMock = vi.fn();

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    loadAccount: (...args: unknown[]) => loadAccountMock(...args),
    saveAccountUiPrefs: (...args: unknown[]) => saveAccountUiPrefsMock(...args),
  };
});

vi.mock('../../lib/account-client', () => ({
  httpAnnouncements: vi.fn().mockResolvedValue([]),
}));

vi.mock('./module-screen', () => ({
  ModuleScreen: ({ tab }: { tab: { title: string } }) => <h1>{tab.title}</h1>,
}));

const merchantAccount: AccountProfile = {
  id: 'u-merchant',
  username: 'demo',
  nickname: '演示商户',
  role: 'MERCHANT',
  uiPrefs: {
    multiTab: false,
    menuCollapsed: true,
  },
  tenant: {
    id: 't-merchant',
    name: '演示租户',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

describe('ConsoleShell uiPrefs sync and sample route hiding (#66)', () => {
  beforeEach(() => {
    mockPathname = '/dashboard';
    window.history.replaceState(null, '', '/dashboard');
    clearCachedAccount();
    window.localStorage.clear();
    window.sessionStorage.clear();
    useShellStore.setState({ ...initialSnapshot(), hydrated: false });
    pushMock.mockReset();
    replaceMock.mockReset();
    loadAccountMock.mockReset();
    saveAccountUiPrefsMock.mockReset().mockResolvedValue(true);
    vi.mocked(httpAnnouncements).mockClear();
  });

  afterEach(() => {
    clearCachedAccount();
    cleanup();
  });

  it('restores uiPrefs from backend on fresh browser login and persists updates via saveAccountUiPrefs', async () => {
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    render(<ConsoleShell />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '展开菜单' })).toBeTruthy();
    });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('列表示例')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));

    await waitFor(() => {
      expect(saveAccountUiPrefsMock).toHaveBeenCalledWith(
        window.sessionStorage,
        expect.objectContaining({
          multiTab: false,
          menuCollapsed: false,
        }),
      );
    });
  });

  it('blocks direct /workbench/samples access for ordinary merchant accounts', async () => {
    mockPathname = '/workbench/samples';
    loadAccountMock.mockResolvedValue({
      status: 'ok',
      account: { ...merchantAccount, uiPrefs: null },
    });

    render(<ConsoleShell />);

    await waitFor(() => {
      expect(screen.getByText('没有这个页面')).toBeTruthy();
    });
  });

  it('resets stale stored tabs to only 首页 when logging in as a different user (#132)', async () => {
    window.localStorage.setItem('geomix.shell.user', 'other-user');
    window.localStorage.setItem(
      'geomix.shell.v2',
      JSON.stringify({
        tabs: [
          { href: '/dashboard' },
          { href: '/material/keywords' },
          { href: '/material/questions' },
        ],
        activeId: '/dashboard',
        prefs: { multiTab: true, menuCollapsed: false },
      }),
    );
    loadAccountMock.mockResolvedValue({
      status: 'ok',
      account: { ...merchantAccount, uiPrefs: null },
    });

    render(<ConsoleShell />);

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(1);
    });
    expect(screen.getAllByRole('tab')[0]?.textContent).toBe('首页');
    expect(window.localStorage.getItem('geomix.shell.user')).toBe(merchantAccount.id);
  });

  it('re-applies active tab document.title when Next.js pathname commits after tab dispatch (#195)', async () => {
    mockPathname = '/dashboard';
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    const rendered = render(<ConsoleShell />);

    await waitFor(() => {
      expect(document.title).toBe('首页 · GeoMix');
    });

    // Simulate clicking sidebar item -> dispatches open(/me/rights), then router.push commits /me/rights
    useShellStore.getState().dispatch({ type: 'open', href: '/me/rights' });
    await waitFor(() => {
      expect(document.title).toBe('账号权益 · GeoMix');
    });

    // Simulate Next.js App Router resetting <title> to root metadata when pathname updates
    document.title = 'GeoMix';
    mockPathname = '/me/rights';
    rendered.rerender(<ConsoleShell />);

    await waitFor(() => {
      expect(document.title).toBe('账号权益 · GeoMix');
    });
  });

  it('toggles sidebar rapidly without re-fetching announcements or losing state (#133)', async () => {
    loadAccountMock.mockResolvedValue({
      status: 'ok',
      account: {
        ...merchantAccount,
        uiPrefs: { multiTab: true, menuCollapsed: false },
      },
    });

    render(<ConsoleShell />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '收起菜单' })).toBeTruthy();
    });
    expect(vi.mocked(httpAnnouncements)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '收起菜单' }));
    expect(screen.getByRole('button', { name: '展开菜单' })).toBeTruthy();
    expect(useShellStore.getState().prefs.menuCollapsed).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));
    expect(screen.getByRole('button', { name: '收起菜单' })).toBeTruthy();
    expect(useShellStore.getState().prefs.menuCollapsed).toBe(false);
    expect(vi.mocked(httpAnnouncements)).toHaveBeenCalledTimes(1);
  });

  it('synchronizes browser URL immediately across tab/menu switches and popstate (#203)', async () => {
    mockPathname = '/material/gallery/pic_1';
    window.history.replaceState(null, '', '/material/gallery/pic_1');
    loadAccountMock.mockResolvedValue({
      status: 'ok',
      account: {
        ...merchantAccount,
        uiPrefs: {
          multiTab: true,
          menuCollapsed: false,
          submenusAlwaysVisible: true,
          autoExpand: true,
          multiLevel: true,
        },
      },
    });

    render(<ConsoleShell />);

    await waitFor(() => {
      expect(document.title).toBe('企业画像图库 · pic_1 · GeoMix');
    });

    // Open 企业知识库, then switch back to gallery detail, then click 企业知识库 again (existing tab!)
    fireEvent.click(screen.getByRole('menuitem', { name: '企业知识库' }));
    expect(window.location.pathname).toBe('/material/knowledge');
    expect(document.title).toBe('企业知识库 · GeoMix');

    fireEvent.click(screen.getByRole('tab', { name: '企业画像图库 · pic_1' }));
    expect(window.location.pathname).toBe('/material/gallery/pic_1');

    fireEvent.click(screen.getByRole('menuitem', { name: '企业知识库' }));
    expect(window.location.pathname).toBe('/material/knowledge');
    expect(document.title).toBe('企业知识库 · GeoMix');

    // Also verify /me/money -> /me/verify and /rewrite/single <-> /rewrite/batch
    fireEvent.click(screen.getByRole('menuitem', { name: '余额明细' }));
    expect(window.location.pathname).toBe('/me/money');
    fireEvent.click(screen.getByRole('menuitem', { name: '实名认证' }));
    expect(window.location.pathname).toBe('/me/verify');
    expect(document.title).toBe('实名认证 · GeoMix');

    fireEvent.click(screen.getByRole('menuitem', { name: '全网爆文复刻' }));
    expect(window.location.pathname).toBe('/rewrite/single');
    fireEvent.click(screen.getByRole('menuitem', { name: '批量爆文复刻' }));
    expect(window.location.pathname).toBe('/rewrite/batch');

    // Browser popstate back to /me/verify restores active tab and title
    window.history.replaceState(null, '', '/me/verify');
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() => {
      expect(useShellStore.getState().activeId).toBe('/me/verify');
      expect(document.title).toBe('实名认证 · GeoMix');
    });
  });

  it('renders console immediately without 正在确认登录 boot flash when account cache is warm (#203)', async () => {
    saveSession(window.sessionStorage, 'tok-warm', 'ref-warm');
    writeCachedAccount(window.sessionStorage, {
      ...merchantAccount,
      role: 'ADMIN',
      uiPrefs: { multiTab: true, menuCollapsed: false },
    });
    // Keep loadAccount unresolved to prove initial render doesn't block on network
    loadAccountMock.mockReturnValue(new Promise(() => undefined));

    render(<ConsoleShell />);

    expect(screen.queryByText('正在确认登录')).toBeNull();
    expect(screen.getByRole('heading', { name: '首页' })).toBeTruthy();
    expect(document.title).toBe('首页 · GeoMix');
  });
});
