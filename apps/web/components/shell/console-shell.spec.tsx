// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
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

vi.mock('../dashboard/dashboard-screen', () => ({
  DashboardScreen: ({ title }: { title: string }) => <h1>{title}</h1>,
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
    window.localStorage.clear();
    window.sessionStorage.clear();
    useShellStore.setState({ ...initialSnapshot(), hydrated: false });
    pushMock.mockReset();
    replaceMock.mockReset();
    loadAccountMock.mockReset();
    saveAccountUiPrefsMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
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
});
