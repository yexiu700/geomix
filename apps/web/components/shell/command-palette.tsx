'use client';

import { Modal } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountProfile } from '../../lib/api';
import { STATIC_ROUTES, isCommandPaletteRoute, matchRoute } from '../../lib/routes';
import type { ShellAction, ShellSnapshot } from '../../lib/tab-stack';

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  role: AccountProfile['role'];
  tabs: ShellSnapshot['tabs'];
  activeId: string;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  onDispatch: (action: ShellAction) => void;
  onOpenLayout: () => void;
  onToggleMenu: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
};

type CommandGroup = '页面' | '已打开标签' | '操作';

type CommandItem = {
  id: string;
  group: CommandGroup;
  title: string;
  href?: string;
  execute: () => void;
};

const GROUP_ORDER: readonly CommandGroup[] = ['页面', '已打开标签', '操作'];

export function CommandPalette({
  open,
  onClose,
  role,
  tabs,
  activeId: _activeId,
  aiImageEnabled = true,
  visibilityEnabled = true,
  onDispatch,
  onOpenLayout,
  onToggleMenu,
  onChangePassword,
  onLogout,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const allItems = useMemo<CommandItem[]>(() => {
    const seenIds = new Set<string>();
    const seenHrefs = new Set<string>();

    const pages: CommandItem[] = [];
    for (const [href, route] of Object.entries(STATIC_ROUTES)) {
      if (!isCommandPaletteRoute(href, role, { aiImageEnabled, visibilityEnabled })) continue;
      const canonicalHref = matchRoute(href)?.href ?? href;
      const id = `page:${canonicalHref}`;
      if (seenIds.has(id) || seenHrefs.has(canonicalHref)) continue;
      seenIds.add(id);
      seenHrefs.add(canonicalHref);
      pages.push({
        id,
        group: '页面',
        title: route.title,
        href: canonicalHref,
        execute: () => onDispatch({ type: 'open', href: canonicalHref }),
      });
    }

    const openTabs: CommandItem[] = [];
    for (const tab of tabs) {
      if (!isCommandPaletteRoute(tab.href, role, { aiImageEnabled, visibilityEnabled })) continue;
      const canonicalHref = matchRoute(tab.href)?.href ?? tab.href;
      const id = `tab:${tab.id}`;
      if (seenIds.has(id) || seenHrefs.has(canonicalHref)) continue;
      seenIds.add(id);
      seenHrefs.add(canonicalHref);
      openTabs.push({
        id,
        group: '已打开标签',
        title: tab.title,
        href: canonicalHref,
        execute: () => onDispatch({ type: 'activate', id: tab.id }),
      });
    }

    const rawActions: CommandItem[] = [
      {
        id: 'action:layout',
        group: '操作',
        title: '布局设置',
        execute: onOpenLayout,
      },
      {
        id: 'action:toggle-menu',
        group: '操作',
        title: '收起/展开菜单',
        execute: onToggleMenu,
      },
      {
        id: 'action:password',
        group: '操作',
        title: '修改密码',
        execute: onChangePassword,
      },
      {
        id: 'action:logout',
        group: '操作',
        title: '退出登录',
        execute: onLogout,
      },
    ];
    const actions = rawActions.filter((action) => {
      if (seenIds.has(action.id)) return false;
      seenIds.add(action.id);
      return true;
    });

    return [...pages, ...openTabs, ...actions];
  }, [
    aiImageEnabled,
    onChangePassword,
    onDispatch,
    onLogout,
    onOpenLayout,
    onToggleMenu,
    role,
    tabs,
    visibilityEnabled,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        (item.href ? item.href.toLowerCase().includes(needle) : false),
    );
  }, [allItems, query]);

  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, { item: CommandItem; flatIndex: number }[]>();
    for (const group of GROUP_ORDER) map.set(group, []);
    filtered.forEach((item, flatIndex) => {
      map.get(item.group)?.push({ item, flatIndex });
    });
    return GROUP_ORDER.map((group) => ({ group, entries: map.get(group) ?? [] })).filter(
      (section) => section.entries.length > 0,
    );
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const focusInput = () => inputRef.current?.focus();
    focusInput();
    const timer = window.setTimeout(focusInput, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    const node = itemRefs.current[activeIndex];
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, filtered.length, open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((prev) => (prev + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      const target = filtered[activeIndex];
      if (!target) return;
      target.execute();
      onClose();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      style={{ top: '15vh' }}
      styles={{
        body: { padding: 0 },
        content: {
          padding: 0,
          borderRadius: 12,
          background: 'var(--gm-bg-overlay)',
          boxShadow: 'var(--gm-shadow-pop)',
        },
      }}
    >
      <div onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          aria-label="搜索页面或操作"
          placeholder="搜索页面或操作…"
          onChange={(event) => setQuery(event.target.value)}
          style={{
            width: '100%',
            height: 48,
            padding: '0 16px',
            fontSize: 15,
            color: 'var(--gm-fg-1)',
            background: 'transparent',
            border: 0,
            borderBottom: '1px solid var(--gm-line-1)',
            borderRadius: 0,
            outline: 'none',
            boxShadow: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div
          role="listbox"
          aria-label="指令列表"
          style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: 'var(--gm-fg-3)',
                padding: '32px 0',
                textAlign: 'center',
              }}
            >
              {`没有匹配「${query}」的页面或操作`}
            </div>
          ) : (
            grouped.map((section) => (
              <div key={section.group}>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--gm-fg-3)',
                    padding: '8px 10px 4px',
                    fontWeight: 500,
                  }}
                >
                  {section.group}
                </div>
                {section.entries.map(({ item, flatIndex }) => {
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={item.id}
                      ref={(el) => {
                        itemRefs.current[flatIndex] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => {
                        if (activeIndex !== flatIndex) setActiveIndex(flatIndex);
                      }}
                      onClick={() => {
                        item.execute();
                        onClose();
                      }}
                      style={{
                        width: '100%',
                        height: 36,
                        padding: '0 10px',
                        border: 0,
                        borderRadius: 6,
                        fontSize: 13,
                        color: isActive ? 'var(--gm-fg-1)' : 'var(--gm-fg-2)',
                        background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                        boxShadow: isActive ? 'inset 2px 0 0 var(--gm-phosphor)' : 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span className="gm-clamp-1">{item.title}</span>
                      {item.href ? (
                        <span
                          className="gm-mono"
                          style={{ fontSize: 11, color: 'var(--gm-fg-4)', flexShrink: 0 }}
                        >
                          {item.href}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div
          style={{
            height: 32,
            borderTop: '1px solid var(--gm-line-1)',
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            fontSize: 11,
            color: 'var(--gm-fg-3)',
          }}
        >
          ↑↓ 选择 · Enter 打开 · Esc 关闭
        </div>
      </div>
    </Modal>
  );
}
