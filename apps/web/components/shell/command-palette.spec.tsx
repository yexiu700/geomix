// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from '../../lib/api';
import { initialSnapshot, reduceShell } from '../../lib/tab-stack';
import { CommandPalette } from './command-palette';
import { ShellFrame } from './shell-frame';

const merchantAccount: AccountProfile = {
  id: 'u-1',
  username: 'demo',
  nickname: '演示',
  role: 'MERCHANT',
  tenant: {
    id: 't-1',
    name: '演示租户',
    expiresAt: '2027-11-12T00:00:00.000Z',
    isActive: true,
    readOnly: false,
  },
};

afterEach(() => {
  cleanup();
});

function setupPalette(overrides?: Partial<React.ComponentProps<typeof CommandPalette>>) {
  const onClose = vi.fn();
  const onDispatch = vi.fn();
  const onOpenLayout = vi.fn();
  const onToggleMenu = vi.fn();
  const onChangePassword = vi.fn();
  const onLogout = vi.fn();
  const snap = reduceShell(initialSnapshot(), { type: 'open', href: '/material/keywords' });

  const utils = render(
    <CommandPalette
      open
      onClose={onClose}
      role="MERCHANT"
      tabs={snap.tabs}
      activeId={snap.activeId}
      onDispatch={onDispatch}
      onOpenLayout={onOpenLayout}
      onToggleMenu={onToggleMenu}
      onChangePassword={onChangePassword}
      onLogout={onLogout}
      {...overrides}
    />,
  );

  return {
    ...utils,
    onClose,
    onDispatch,
    onOpenLayout,
    onToggleMenu,
    onChangePassword,
    onLogout,
  };
}

describe('CommandPalette', () => {
  it('filters routes by query and dispatches open on Enter', () => {
    const { onDispatch, onClose } = setupPalette();
    const input = screen.getByRole('textbox', { name: '搜索页面或操作' });

    fireEvent.change(input, { target: { value: '看板' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('AI数据看板');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDispatch).toHaveBeenCalledWith({ type: 'open', href: '/visibility/overview' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never exposes /workbench/samples in command palette for MERCHANT or ADMIN (#134)', () => {
    setupPalette({ role: 'MERCHANT' });
    expect(screen.queryByText('/workbench/samples')).toBeNull();
    expect(screen.queryByText('列表示例')).toBeNull();
    cleanup();

    setupPalette({ role: 'ADMIN' });
    expect(screen.queryByText('/workbench/samples')).toBeNull();
    expect(screen.queryByText('列表示例')).toBeNull();
  });

  it('wraps keyboard selection cyclically with ArrowUp and ArrowDown and closes on Escape', () => {
    const { onClose } = setupPalette();
    const input = screen.getByRole('textbox', { name: '搜索页面或操作' });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(2);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[options.length - 1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no command matches query', () => {
    setupPalette();
    const input = screen.getByRole('textbox', { name: '搜索页面或操作' });
    fireEvent.change(input, { target: { value: '不存在的页面xyz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('没有匹配「不存在的页面xyz」的页面或操作')).toBeTruthy();
  });

  it('updates active item on mouse move and executes open-tab and action items', () => {
    const { onOpenLayout, onClose } = setupPalette();
    const options = screen.getAllByRole('option');
    const layoutOption = options.find((el) => el.textContent?.includes('布局设置'));
    if (!layoutOption) throw new Error('missing 布局设置 option');

    fireEvent.mouseMove(layoutOption);
    expect(layoutOption.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(layoutOption);
    expect(onOpenLayout).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deduplicates 首页 /dashboard and static routes while keeping parameterized open tabs (#261)', () => {
    const initial = initialSnapshot();
    const { unmount } = setupPalette({
      tabs: initial.tabs,
      activeId: initial.activeId,
    });

    const initialOptions = screen.getAllByRole('option');
    const dashboardMatches = initialOptions.filter((el) => el.textContent?.includes('/dashboard'));
    expect(dashboardMatches).toHaveLength(1);
    expect(initialOptions[0]?.textContent).toContain('首页');
    expect(initialOptions[0]?.textContent).toContain('/dashboard');
    expect(screen.queryByText('已打开标签')).toBeNull();
    unmount();

    let withSubTab = reduceShell(initialSnapshot(), { type: 'open', href: '/material/keywords' });
    withSubTab = reduceShell(withSubTab, { type: 'open', href: '/material/gallery/cat-ikea' });
    withSubTab = reduceShell(withSubTab, {
      type: 'retitle',
      id: '/material/gallery/cat-ikea',
      title: '企业画像图库 · 家居场景实拍',
    });

    const { onDispatch, onClose } = setupPalette({
      tabs: [
        ...withSubTab.tabs,
        {
          id: '/workbench/samples',
          href: '/workbench/samples',
          title: '列表示例',
          pinned: false,
        },
      ],
      activeId: '/material/gallery/cat-ikea',
    });

    const allOptions = screen.getAllByRole('option');
    expect(allOptions.filter((el) => el.textContent?.includes('/dashboard'))).toHaveLength(1);
    expect(allOptions.filter((el) => el.textContent?.includes('/material/keywords'))).toHaveLength(
      1,
    );
    expect(screen.queryByText('/workbench/samples')).toBeNull();

    const subTabOptions = allOptions.filter((el) =>
      el.textContent?.includes('/material/gallery/cat-ikea'),
    );
    expect(subTabOptions).toHaveLength(1);
    expect(subTabOptions[0]?.textContent).toContain('企业画像图库 · 家居场景实拍');
    expect(screen.getByText('已打开标签')).toBeTruthy();

    fireEvent.click(subTabOptions[0]!);
    expect(onDispatch).toHaveBeenCalledWith({
      type: 'activate',
      id: '/material/gallery/cat-ikea',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens on Ctrl+K in ShellFrame and ignores IME composing Ctrl+K', async () => {
    render(
      <ShellFrame
        account={merchantAccount}
        state={initialSnapshot()}
        onDispatch={() => undefined}
        onLogout={() => undefined}
        onChangePassword={async () => null}
      />,
    );

    expect(screen.queryByRole('textbox', { name: '搜索页面或操作' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('textbox', { name: '搜索页面或操作' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, isComposing: false });
    expect(await screen.findByRole('textbox', { name: '搜索页面或操作' })).toBeTruthy();
  });
});
