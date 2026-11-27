// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './command-palette';

const sampleBrands: BrandRecord[] = [
  {
    id: 'b-1',
    name: '绿联',
    category: '家用 NAS',
    truthAgreementSignedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    markets: [
      {
        id: 'm-1',
        brandId: 'b-1',
        market: 'CN',
        locale: 'zh-CN',
        region: 'CN',
        localBrandName: '绿联',
        aliases: [],
        ownedDomains: ['ugreen.com'],
        competitors: [],
        seedPrompts: [],
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  },
];

afterEach(() => {
  cleanup();
});

describe('CommandPalette (GeoMix 2.0)', () => {
  it('lists the 5 workspaces, brands/markets, and actions without legacy tabs or layout panel', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const onOpenEnableMarket = vi.fn();

    render(
      <CommandPalette
        open={true}
        onClose={onClose}
        role="MERCHANT"
        brands={sampleBrands}
        activeBrandId="b-1"
        activeMarket="CN"
        onNavigate={onNavigate}
        onSelectBrand={vi.fn()}
        onSelectMarket={vi.fn()}
        onOpenCreateBrand={vi.fn()}
        onOpenEnableMarket={onOpenEnableMarket}
        onToggleMenu={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: '搜索页面或操作' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '指令列表' })).toBeTruthy();
    expect(screen.queryByText('已打开标签')).toBeNull();
    expect(screen.queryByText('布局设置')).toBeNull();
    expect(screen.queryByText('/dashboard')).toBeNull();
    expect(screen.queryByText('/me/money')).toBeNull();

    expect(screen.getByRole('option', { name: /首页.*\/home/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /品牌.*\/brands/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /诊断.*\/visibility/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /写作.*\/studio/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /发布.*\/publish/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /账户.*\/account/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: /\+ 开启海外/ }));
    expect(onOpenEnableMarket).toHaveBeenCalledWith('GLOBAL');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports filtering, ArrowDown/ArrowUp cyclic navigation, Enter, IME composing guard, and Escape', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(
      <CommandPalette
        open={true}
        onClose={onClose}
        role="ADMIN"
        brands={sampleBrands}
        activeBrandId="b-1"
        activeMarket="CN"
        onNavigate={onNavigate}
        onToggleMenu={vi.fn()}
        onChangePassword={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    const input = screen.getByRole('textbox', { name: '搜索页面或操作' });
    fireEvent.change(input, { target: { value: '/studio' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('/studio');
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
