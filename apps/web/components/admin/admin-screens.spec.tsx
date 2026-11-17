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
});
