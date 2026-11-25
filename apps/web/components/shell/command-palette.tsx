'use client';

import type { BrandRecord, GeoMarket } from '@geomix/shared';
import { Modal } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountProfile } from '../../lib/api';
import { STATIC_ROUTES, isCommandPaletteRoute, matchRoute } from '../../lib/routes';

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  role: AccountProfile['role'];
  readOnly?: boolean;
  visibilityEnabled?: boolean;
  brands?: readonly BrandRecord[];
  activeBrandId?: string | null;
  activeMarket?: GeoMarket;
  onNavigate: (href: string) => void;
  onSelectBrand?: (brandId: string) => void;
  onSelectMarket?: (market: GeoMarket) => void;
  onOpenCreateBrand?: () => void;
  onOpenEnableMarket?: (market: GeoMarket) => void;
  onToggleMenu: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
};

type CommandGroup = '工作区' | '品牌与市场' | '操作';

type CommandItem = {
  id: string;
  group: CommandGroup;
  title: string;
  href?: string;
  execute: () => void;
};

const GROUP_ORDER: readonly CommandGroup[] = ['工作区', '品牌与市场', '操作'];

export function CommandPalette({
  open,
  onClose,
  role,
  readOnly = false,
  visibilityEnabled = true,
  brands = [],
  activeBrandId = null,
  activeMarket = 'CN',
  onNavigate,
  onSelectBrand,
  onSelectMarket,
  onOpenCreateBrand,
  onOpenEnableMarket,
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

    const workspaces: CommandItem[] = [];
    for (const [href, route] of Object.entries(STATIC_ROUTES)) {
      if (!isCommandPaletteRoute(href, role, { visibilityEnabled })) continue;
      const canonicalHref = matchRoute(href)?.href ?? href;
      const id = `workspace:${canonicalHref}`;
      if (seenIds.has(id) || seenHrefs.has(canonicalHref)) continue;
      seenIds.add(id);
      seenHrefs.add(canonicalHref);
      workspaces.push({
        id,
        group: '工作区',
        title: route.title,
        href: canonicalHref,
        execute: () => onNavigate(canonicalHref),
      });
    }

    if (role === 'ADMIN') {
      workspaces.push({
        id: 'workspace:/admin/tenants',
        group: '工作区',
        title: '运营后台',
        href: '/admin/tenants',
        execute: () => onNavigate('/admin/tenants'),
      });
    }

    const brandItems: CommandItem[] = [];
    const activeBrand = brands.find((item) => item.id === activeBrandId) ?? null;

    if (onSelectBrand) {
      for (const brand of brands) {
        brandItems.push({
          id: `brand:${brand.id}`,
          group: '品牌与市场',
          title:
            brand.id === activeBrandId ? `当前品牌 · ${brand.name}` : `切换品牌 · ${brand.name}`,
          execute: () => onSelectBrand(brand.id),
        });
      }
    }

    if (activeBrand && onSelectMarket) {
      const enabledMarkets = new Set(activeBrand.markets.map((item) => item.market));
      if (enabledMarkets.has('CN')) {
        brandItems.push({
          id: 'market:CN',
          group: '品牌与市场',
          title: activeMarket === 'CN' ? '当前市场 · 🇨🇳 国内 (CN)' : '切换市场 · 🇨🇳 国内 (CN)',
          execute: () => onSelectMarket('CN'),
        });
      }
      if (enabledMarkets.has('GLOBAL')) {
        brandItems.push({
          id: 'market:GLOBAL',
          group: '品牌与市场',
          title:
            activeMarket === 'GLOBAL'
              ? '当前市场 · 🌐 海外 (GLOBAL)'
              : '切换市场 · 🌐 海外 (GLOBAL)',
          execute: () => onSelectMarket('GLOBAL'),
        });
      }
      if (!readOnly && onOpenEnableMarket && enabledMarkets.size === 1) {
        const missingMarket: GeoMarket = enabledMarkets.has('CN') ? 'GLOBAL' : 'CN';
        brandItems.push({
          id: `market:enable:${missingMarket}`,
          group: '品牌与市场',
          title:
            missingMarket === 'GLOBAL'
              ? '+ 开启另一市场 · 🌐 海外 (GLOBAL)'
              : '+ 开启另一市场 · 🇨🇳 国内 (CN)',
          execute: () => onOpenEnableMarket(missingMarket),
        });
      }
    }

    if (!readOnly && onOpenCreateBrand) {
      brandItems.push({
        id: 'brand:create',
        group: '品牌与市场',
        title: '+ 60 秒新建品牌',
        execute: onOpenCreateBrand,
      });
    }

    const actions: CommandItem[] = [
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

    return [...workspaces, ...brandItems, ...actions];
  }, [
    activeBrandId,
    activeMarket,
    brands,
    onChangePassword,
    onLogout,
    onNavigate,
    onOpenCreateBrand,
    onOpenEnableMarket,
    onSelectBrand,
    onSelectMarket,
    onToggleMenu,
    readOnly,
    role,
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
      className="gm-cmd-modal"
    >
      <div onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          aria-label="搜索页面或操作"
          placeholder="搜索工作区、品牌或操作…"
          onChange={(event) => setQuery(event.target.value)}
          className="gm-cmd-input"
        />
        <div role="listbox" aria-label="指令列表" className="gm-cmd-list">
          {filtered.length === 0 ? (
            <div className="gm-cmd-empty">{`没有匹配「${query}」的页面或操作`}</div>
          ) : (
            grouped.map((section) => (
              <div key={section.group}>
                <div className="gm-cmd-group">{section.group}</div>
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
                      className={isActive ? 'gm-cmd-option is-active' : 'gm-cmd-option'}
                      onMouseMove={() => {
                        if (activeIndex !== flatIndex) setActiveIndex(flatIndex);
                      }}
                      onClick={() => {
                        item.execute();
                        onClose();
                      }}
                    >
                      <span className="gm-clamp-1">{item.title}</span>
                      {item.href ? <span className="gm-mono gm-cmd-href">{item.href}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="gm-cmd-footer">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </Modal>
  );
}
