'use client';

import { Menu, type MenuProps } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  allSubmenuKeys,
  buildMenu,
  menuSelection,
  type MenuBadge,
  type MenuItem,
} from '../../lib/routes';
import type { LayoutPrefs, ShellAction } from '../../lib/tab-stack';

const SUBMENU_POPUP_SELECTOR = '.ant-menu-submenu-popup';

export function SideMenu({
  activeHref,
  prefs,
  collapsed,
  aiImageEnabled = true,
  visibilityEnabled = true,
  onDispatch,
}: {
  activeHref: string;
  prefs: LayoutPrefs;
  collapsed?: boolean;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  onDispatch: (action: ShellAction) => void;
}) {
  const isCollapsed = collapsed ?? prefs.menuCollapsed;
  const menuItems = useMemo(
    () => buildMenu({ aiImageEnabled, visibilityEnabled }),
    [aiImageEnabled, visibilityEnabled],
  );
  const selection = menuSelection(activeHref);
  const routePathname = activeHref.split('?')[0] ?? activeHref;
  const [openKeys, setOpenKeys] = useState<string[]>(selection.parents);
  const rootRef = useRef<HTMLDivElement>(null);

  const dismissFloatingPopups = useCallback(() => {
    if (typeof document === 'undefined') return;
    const popups = document.querySelectorAll<HTMLElement>(SUBMENU_POPUP_SELECTOR);
    for (const popup of popups) {
      popup.classList.add('ant-menu-submenu-hidden');
      popup.style.display = 'none';
      popup.setAttribute('aria-hidden', 'true');
    }
    const root = rootRef.current;
    if (root) {
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement && root.contains(activeEl)) {
        activeEl.blur();
      }
      const openPopupSubmenus = root.querySelectorAll<HTMLElement>(
        '.ant-menu-vertical .ant-menu-submenu-open > .ant-menu-submenu-title',
      );
      for (const trigger of openPopupSubmenus) {
        trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      }
    }
  }, []);

  useEffect(() => {
    if (!prefs.multiLevel) return;
    if (prefs.submenusAlwaysVisible) {
      setOpenKeys(allSubmenuKeys(menuItems));
      return;
    }
    if (prefs.autoExpand) setOpenKeys(menuSelection(activeHref).parents);
  }, [activeHref, menuItems, prefs.autoExpand, prefs.multiLevel, prefs.submenusAlwaysVisible]);

  // Close any floating submenu popover on pathname/route change or collapse (#131)
  useEffect(() => {
    dismissFloatingPopups();
  }, [routePathname, activeHref, isCollapsed, dismissFloatingPopups]);

  // Dismiss any floating submenu popover on Escape or outside click (#131)
  useEffect(() => {
    if (isCollapsed || typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }
    const hasVisiblePopup = () => {
      const popups = document.querySelectorAll<HTMLElement>(SUBMENU_POPUP_SELECTOR);
      for (const popup of popups) {
        if (
          !popup.classList.contains('ant-menu-submenu-hidden') &&
          popup.style.display !== 'none'
        ) {
          return true;
        }
      }
      return false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!hasVisiblePopup()) return;
      dismissFloatingPopups();
    };

    const onOutsidePointerDown = (event: Event) => {
      if (!hasVisiblePopup()) return;
      const target = event.target;
      if (!(target instanceof Node)) {
        dismissFloatingPopups();
        return;
      }
      if (rootRef.current?.contains(target)) return;
      const targetEl = target instanceof Element ? target : target.parentElement;
      if (targetEl?.closest(SUBMENU_POPUP_SELECTOR)) return;
      dismissFloatingPopups();
    };

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onOutsidePointerDown);
    document.addEventListener('mousedown', onOutsidePointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onOutsidePointerDown);
      document.removeEventListener('mousedown', onOutsidePointerDown);
    };
  }, [isCollapsed, dismissFloatingPopups]);

  if (isCollapsed) return null;

  const handleContainerMouseLeave = (event: React.MouseEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node) {
      if (rootRef.current?.contains(next)) return;
      const nextEl = next instanceof Element ? next : next.parentElement;
      if (nextEl?.closest(SUBMENU_POPUP_SELECTOR)) return;
    }
    dismissFloatingPopups();
  };

  const makeMenuProps = (scopedItems: MenuItem[]) => {
    const scopedKeys = new Set(allSubmenuKeys(scopedItems));
    const scopedOpenKeys = openKeys.filter((key) => scopedKeys.has(key));
    return {
      mode: 'inline' as const,
      inlineCollapsed: false,
      theme: 'dark' as const,
      selectedKeys: [selection.selected],
      ...(prefs.multiLevel
        ? {
            openKeys: scopedOpenKeys,
            onOpenChange: (keys: string[]) => {
              if (prefs.submenusAlwaysVisible) return;
              setOpenKeys((prev) => {
                const preserved = prev.filter((key) => !scopedKeys.has(key));
                return [...preserved, ...keys];
              });
            },
          }
        : {}),
      onClick: ({ key }: { key: string }) => {
        if (key.startsWith('/')) {
          dismissFloatingPopups();
          onDispatch({ type: 'open', href: key });
        }
      },
    };
  };

  if (!prefs.multiLevel) {
    const flatItems = flatten(menuItems);
    return (
      <div ref={rootRef} data-testid="side-menu-root" onMouseLeave={handleContainerMouseLeave}>
        <Menu
          {...makeMenuProps(flatItems)}
          items={toAntdItems(flatItems)}
          style={{ borderInlineEnd: 0 }}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} data-testid="side-menu-root" onMouseLeave={handleContainerMouseLeave}>
      {menuItems.map((item) => {
        if (item.type === 'section') {
          return (
            <div key={item.key}>
              <div
                className="gm-menu-title"
                style={{
                  padding: '16px 16px 6px',
                  fontSize: 11,
                  lineHeight: '16px',
                  letterSpacing: '0.06em',
                  color: 'var(--gm-fg-3)',
                  fontWeight: 500,
                }}
              >
                {item.title}
              </div>
              <Menu
                {...makeMenuProps(item.children)}
                items={toAntdItems(item.children)}
                style={{ borderInlineEnd: 0 }}
              />
            </div>
          );
        }
        const key = item.type === 'link' ? item.href : item.key;
        return (
          <Menu
            key={key}
            {...makeMenuProps([item])}
            items={toAntdItems([item])}
            style={{ borderInlineEnd: 0 }}
          />
        );
      })}
    </div>
  );
}

function flatten(items: MenuItem[]): MenuItem[] {
  const result: MenuItem[] = [];
  const walk = (nodes: MenuItem[]) => {
    for (const node of nodes) {
      if (node.type === 'link' || node.type === 'soon') result.push(node);
      else walk(node.children);
    }
  };
  walk(items);
  return result;
}

function toAntdItems(items: MenuItem[]): MenuProps['items'] {
  return items.map((item) => {
    if (item.type === 'link') return { key: item.href, label: item.title };
    if (item.type === 'soon') return { key: item.key, label: item.title, disabled: true };
    if (item.type === 'submenu') {
      return {
        key: item.key,
        label: <MenuLabel title={item.title} badge={item.badge} />,
        children: toAntdItems(item.children),
      };
    }
    return { key: item.key, label: item.title, disabled: true };
  });
}

function MenuLabel({ title, badge }: { title: string; badge?: MenuBadge }) {
  return (
    <span className="gm-menu-label">
      <span>{title}</span>
      {badge === 'new' ? (
        <span
          className="gm-badge"
          style={{
            height: 16,
            padding: '0 5px',
            borderRadius: 4,
            background: 'var(--gm-phosphor-a16)',
            color: 'var(--gm-phosphor)',
            fontSize: 10,
            fontWeight: 600,
            marginLeft: 6,
            lineHeight: '16px',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          新上
        </span>
      ) : null}
    </span>
  );
}
