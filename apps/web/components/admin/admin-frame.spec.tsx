// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedAccount, writeCachedAccount } from '../../lib/account-cache';
import type { AccountProfile } from '../../lib/api';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, saveSession } from '../../lib/session';
import { AdminGate } from './admin-frame';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let mockPathname = '/admin/tenants';
const routerMock = { push: pushMock, replace: replaceMock };

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => mockPathname,
}));

const loadAccountMock = vi.fn();
const logoutSessionMock = vi.fn();

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    loadAccount: (...args: unknown[]) => loadAccountMock(...args),
    logoutSession: (...args: unknown[]) => logoutSessionMock(...args),
  };
});

const adminAccount: AccountProfile = {
  id: 'u-admin',
  username: 'admin',
  nickname: '管理员',
  role: 'ADMIN',
  tenant: {
    id: 't-platform',
    name: 'GeoMix 平台',
    expiresAt: '2099-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

const merchantAccount: AccountProfile = {
  id: 'u-merchant',
  username: 'demo',
  nickname: '演示用户',
  role: 'MERCHANT',
  tenant: {
    id: 't-demo',
    name: 'GeoMix 演示',
    expiresAt: '2027-12-31T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

describe('AdminGate auth guard and cross-tab session (#194)', () => {
  beforeEach(() => {
    mockPathname = '/admin/tenants';
    document.title = 'GeoMix';
    clearCachedAccount();
    window.sessionStorage.clear();
    window.localStorage.clear();
    pushMock.mockReset();
    replaceMock.mockReset();
    loadAccountMock.mockReset();
    logoutSessionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    clearCachedAccount();
    cleanup();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  });

  it('redirects unauthenticated /admin/tenants visits to /login?next=%2Fadmin%2Ftenants instead of rendering 404', async () => {
    loadAccountMock.mockResolvedValue({ status: 'anonymous' });

    render(
      <AdminGate>
        <div>租户管理正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fadmin%2Ftenants');
    });
    expect(screen.queryByText('没有这个页面')).toBeNull();
    expect(screen.queryByRole('button', { name: '回首页' })).toBeNull();
  });

  it('clears stale session and redirects to /login with notice=session or notice=disabled when session is invalid', async () => {
    mockPathname = '/admin/pricing';
    saveSession(window.sessionStorage, 'stale-at', 'stale-rt');
    loadAccountMock.mockResolvedValue({ status: 'disabled' });

    render(
      <AdminGate>
        <div>价格管理正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fadmin%2Fpricing&notice=disabled');
    });
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(screen.queryByText('没有这个页面')).toBeNull();
  });

  it('still hides admin routes with 404 when an authenticated non-admin merchant accesses /admin/tenants', async () => {
    loadAccountMock.mockResolvedValue({ status: 'ok', account: merchantAccount });

    render(
      <AdminGate>
        <div>租户管理正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(screen.getByText('没有这个页面')).toBeTruthy();
    });
    expect(replaceMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '回首页' }));
    expect(pushMock).toHaveBeenCalledWith('/home');
  });

  it('renders admin children without /admin/templates and links back to /home when an ADMIN session is valid', async () => {
    loadAccountMock.mockResolvedValue({ status: 'ok', account: adminAccount });

    render(
      <AdminGate>
        <div>租户管理正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(screen.getByText('租户管理正文')).toBeTruthy();
    });
    expect(document.title).toContain('GeoMix 管理');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '系统模板' })).toBeNull();
    expect(screen.getByRole('link', { name: '试用线索' }).getAttribute('href')).toBe(
      '/admin/leads',
    );
    expect(screen.getByRole('link', { name: '返回后台' }).getAttribute('href')).toBe('/home');
  });

  it('sets document.title and active link state for /admin/leads when an ADMIN session is valid', async () => {
    mockPathname = '/admin/leads';
    loadAccountMock.mockResolvedValue({ status: 'ok', account: adminAccount });

    render(
      <AdminGate>
        <div>试用线索正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(screen.getByText('试用线索正文')).toBeTruthy();
    });
    expect(document.title).toBe('试用线索 · GeoMix 管理');
    expect(screen.getByRole('link', { name: '试用线索' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('redirects unauthenticated /admin/leads visits to /login?next=%2Fadmin%2Fleads', async () => {
    mockPathname = '/admin/leads';
    loadAccountMock.mockResolvedValue({ status: 'anonymous' });

    render(
      <AdminGate>
        <div>试用线索正文</div>
      </AdminGate>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fadmin%2Fleads');
    });
    expect(screen.queryByText('没有这个页面')).toBeNull();
  });

  it('renders immediately from warm account cache without boot flash (#203)', () => {
    saveSession(window.sessionStorage, 'tok-admin', 'ref-admin');
    writeCachedAccount(window.sessionStorage, adminAccount);
    loadAccountMock.mockReturnValue(new Promise(() => undefined));

    render(
      <AdminGate>
        <div>租户管理正文</div>
      </AdminGate>,
    );

    expect(screen.queryByText('正在确认登录')).toBeNull();
    expect(screen.getByText('租户管理正文')).toBeTruthy();
    expect(document.title).toBe('租户 · GeoMix 管理');
  });
});
