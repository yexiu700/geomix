'use client';

import { Menu, type MenuProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  allSubmenuKeys,
  buildMenu,
  menuSelection,
  type MenuBadge,
  type MenuItem,
} from '../../lib/routes';
import type { LayoutPrefs, ShellAction } from '../../lib/tab-stack';

export function SideMenu({
  activeHref,
  prefs,
  aiImageEnabled = true,
  visibilityEnabled = true,
  onDispatch,
}: {
  activeHref: string;
  prefs: LayoutPrefs;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  onDispatch: (action: ShellAction) => void;
}) {
  const menuItems = useMemo(
    () => buildMenu({ aiImageEnabled, visibilityEnabled }),
    [aiImageEnabled, visibilityEnabled],
  );
  const selection = menuSelection(activeHref);
  const [openKeys, setOpenKeys] = useState<string[]>(selection.parents);

  useEffect(() => {
    if (!prefs.multiLevel) return;
    if (prefs.submenusAlwaysVisible) {
      setOpenKeys(allSubmenuKeys(menuItems));
      return;
    }
    if (prefs.autoExpand) setOpenKeys(menuSelection(activeHref).parents);
  }, [activeHref, menuItems, prefs.autoExpand, prefs.multiLevel, prefs.submenusAlwaysVisible]);

  if (prefs.menuCollapsed) return null;

  const menuProps = {
    mode: 'inline' as const,
    theme: 'dark' as const,
    selectedKeys: [selection.selected],
    ...(prefs.multiLevel
      ? {
          openKeys,
          onOpenChange: (keys: string[]) => {
            if (prefs.submenusAlwaysVisible) return;
            setOpenKeys(keys);
          },
        }
      : {}),
    onClick: ({ key }: { key: string }) => {
      if (key.startsWith('/')) onDispatch({ type: 'open', href: key });
    },
  };

  if (!prefs.multiLevel) {
    return (
      <Menu {...menuProps} items={toAntdItems(flatten(menuItems))} style={{ borderInlineEnd: 0 }} />
    );
  }

  return (
    <div>
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
                {...menuProps}
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
            {...menuProps}
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
