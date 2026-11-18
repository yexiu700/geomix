// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPrefs } from '../../lib/tab-stack';
import { SideMenu } from './side-menu';

afterEach(() => {
  cleanup();
  document.querySelectorAll('.ant-menu-submenu-popup').forEach((el) => el.remove());
});

describe('SideMenu submenu popup lifecycle & openKeys isolation (#131)', () => {
  it('renders nothing when collapsed=true even if prefs.menuCollapsed is false (prevents mobile/collapsed popup at 0,0)', () => {
    render(
      <SideMenu
        activeHref="/material/keywords"
        collapsed={true}
        prefs={{ ...defaultPrefs(), menuCollapsed: false, submenusAlwaysVisible: true }}
        onDispatch={vi.fn()}
      />,
    );

    expect(document.querySelector('.ant-menu')).toBeNull();
    expect(document.querySelector('.ant-menu-submenu-popup')).toBeNull();
  });

  it('closes any open floating submenu popup on pathname change, Escape, outside click, and mouseleave outside safe zone', () => {
    const onDispatch = vi.fn();
    const { rerender } = render(
      <div>
        <div data-testid="outside-content">表格工具栏</div>
        <aside className="gm-sider">
          <SideMenu
            activeHref="/dashboard"
            collapsed={false}
            prefs={{ ...defaultPrefs(), autoExpand: false }}
            onDispatch={onDispatch}
          />
        </aside>
      </div>,
    );

    const mountFakePopup = () => {
      const popup = document.createElement('div');
      popup.className = 'ant-menu-submenu ant-menu-submenu-popup ant-menu-dark';
      popup.setAttribute('data-testid', 'stuck-submenu-popup');
      popup.innerHTML =
        '<ul class="ant-menu ant-menu-sub ant-menu-vertical"><li class="ant-menu-item">关键词</li></ul>';
      document.body.appendChild(popup);
      return popup;
    };

    const isPopupVisible = (popup: HTMLElement) =>
      popup.isConnected &&
      !popup.classList.contains('ant-menu-submenu-hidden') &&
      popup.style.display !== 'none';

    // 1. Pathname / activeHref change closes popup
    const popup1 = mountFakePopup();
    expect(isPopupVisible(popup1)).toBe(true);
    rerender(
      <div>
        <div data-testid="outside-content">表格工具栏</div>
        <aside className="gm-sider">
          <SideMenu
            activeHref="/material/keywords"
            collapsed={false}
            prefs={{ ...defaultPrefs(), autoExpand: false }}
            onDispatch={onDispatch}
          />
        </aside>
      </div>,
    );
    expect(isPopupVisible(popup1)).toBe(false);
    popup1.remove();

    // 2. Escape closes popup
    const popup2 = mountFakePopup();
    expect(isPopupVisible(popup2)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(isPopupVisible(popup2)).toBe(false);
    popup2.remove();

    // 3. Outside click closes popup
    const popup3 = mountFakePopup();
    expect(isPopupVisible(popup3)).toBe(true);
    fireEvent.pointerDown(screen.getByTestId('outside-content'));
    fireEvent.click(screen.getByTestId('outside-content'));
    expect(isPopupVisible(popup3)).toBe(false);
    popup3.remove();

    // 4. Mouseleave outside safe zone closes popup
    const popup4 = mountFakePopup();
    const menuWrap = document.querySelector('.gm-sider [data-testid="side-menu-root"]');
    expect(menuWrap).not.toBeNull();
    fireEvent.mouseLeave(menuWrap!, { relatedTarget: screen.getByTestId('outside-content') });
    expect(isPopupVisible(popup4)).toBe(false);
    popup4.remove();
  });

  it('keeps other section submenus open when toggling a submenu in another section', () => {
    render(
      <SideMenu
        activeHref="/material/keywords"
        collapsed={false}
        prefs={defaultPrefs()}
        onDispatch={vi.fn()}
      />,
    );

    expect(screen.getByText('关键词')).toBeTruthy();
    fireEvent.click(screen.getByText('个人中心'));
    expect(screen.getByText('点数明细')).toBeTruthy();
    // 素材源力 should remain expanded instead of being wiped by 个人中心's onOpenChange
    expect(screen.getByText('关键词')).toBeTruthy();
  });

  it('renders single-level visibility entries with no disabled placeholder menu items (#134)', () => {
    const onDispatch = vi.fn();
    render(
      <SideMenu
        activeHref="/dashboard"
        collapsed={false}
        prefs={defaultPrefs()}
        onDispatch={onDispatch}
      />,
    );

    expect(document.querySelectorAll('.ant-menu-item-disabled')).toHaveLength(0);
    expect(screen.getAllByRole('menuitem', { name: 'AI可见度诊断' })).toHaveLength(1);
    expect(screen.getAllByRole('menuitem', { name: 'AI数据看板' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '更多功能敬请期待' }));
    expect(screen.getByText('二期功能规划 · 敬请期待')).toBeTruthy();
  });
});
