// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantRow } from '../../lib/admin-client';
import { TenantAdmin } from './tenant-admin';

afterEach(() => {
  cleanup();
});

function tenant(points: number): TenantRow {
  return {
    id: 'tenant-a',
    name: '商户甲',
    username: 'merchant',
    expiresAt: '2027-11-16T00:00:00.000Z',
    isActive: true,
    billingMode: null,
    resolvedBillingMode: 'SHADOW',
    points,
    pointsReserved: 0,
    money: '0.00',
  };
}

describe('tenant admin', () => {
  it('records an admin top-up of 500 through the existing adjust call', async () => {
    const rows = [tenant(1000)];
    const client = {
      listTenants: vi.fn(async () => rows),
      createTenant: vi.fn(),
      updateTenant: vi.fn(),
      updateQuotas: vi.fn(),
      adjust: vi.fn(async () => {
        rows[0] = tenant(1500);
        return { title: '管理员充值', delta: 500 };
      }),
      setMode: vi.fn(async () => ({ tenantId: 'tenant-a', billingMode: 'STRICT' })),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('商户甲')).toBeTruthy();
    expect(screen.getByText('1000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加点 商户甲' }));
    fireEvent.click(screen.getByRole('button', { name: '确认加点' }));
    expect(client.adjust).toHaveBeenCalledWith('tenant-a', 500);
    expect(await screen.findByText('+500 管理员充值')).toBeTruthy();
    expect(await screen.findByText('1500')).toBeTruthy();
  });

  it('switches billing mode without inventing a second ledger', async () => {
    const client = {
      listTenants: vi.fn(async () => [tenant(1000)]),
      createTenant: vi.fn(),
      updateTenant: vi.fn(),
      updateQuotas: vi.fn(),
      adjust: vi.fn(),
      setMode: vi.fn(async () => ({ tenantId: 'tenant-a', billingMode: 'STRICT' })),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('商户甲')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '计费模式 商户甲' }));
    fireEvent.click(await screen.findByText('STRICT'));
    expect(client.setMode).toHaveBeenCalledWith('tenant-a', 'STRICT');
  });

  it('edits tenant expiresAt and isActive, and updates non-keyword quota', async () => {
    const client = {
      listTenants: vi.fn(async () => [tenant(1000)]),
      getTenant: vi.fn(async () => ({
        ...tenant(1000),
        quotas: [
          { key: 'MAIN_KEYWORD', used: '0', limit: '100' },
          { key: 'QUESTION', used: '0', limit: '10000' },
        ],
      })),
      createTenant: vi.fn(),
      updateTenant: vi.fn(async () => tenant(1000)),
      updateQuotas: vi.fn(async () => tenant(1000)),
      adjust: vi.fn(),
      setMode: vi.fn(),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('商户甲')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '编辑 商户甲' }));
    fireEvent.change(screen.getByRole('textbox', { name: '租户有效期' }), {
      target: { value: '2028-01-01T00:00:00.000Z' },
    });
    fireEvent.click(screen.getByRole('switch', { name: '启用状态' }));
    fireEvent.click(screen.getByRole('button', { name: '保存租户' }));
    expect(client.updateTenant).toHaveBeenCalledWith('tenant-a', {
      name: '商户甲',
      expiresAt: '2028-01-01T00:00:00.000Z',
      isActive: false,
    });

    fireEvent.click(screen.getByRole('button', { name: '配额 商户甲' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '配额项' }));
    fireEvent.click(await screen.findByText('写作问题'));
    fireEvent.change(screen.getByRole('textbox', { name: '配额上限' }), {
      target: { value: '25000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
    expect(client.updateQuotas).toHaveBeenCalledWith('tenant-a', {
      items: [{ key: 'QUESTION', limit: '25000' }],
    });
  });
});
