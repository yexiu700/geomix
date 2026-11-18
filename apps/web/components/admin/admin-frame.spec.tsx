// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    window.sessionStorage.clear();
    window.localStorage.clear();
    pushMock.mockReset();
    replaceMock.mockReset();
    loadAccountMock.mockReset();
    logoutSessionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
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
  });

  it('renders admin children and updates document title when an ADMIN session is valid', async () => {
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
  });
});
