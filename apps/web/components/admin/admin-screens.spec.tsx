// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantRow } from '../../lib/admin-client';
import { TenantAdmin } from './tenant-admin';

afterEach(() => {
  cleanup();
});

function tenant(points: number, overrides: Partial<TenantRow> = {}): TenantRow {
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
    ...overrides,
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
    await waitFor(() => {
      expect(client.adjust).toHaveBeenCalledWith('tenant-a', 500);
    });
    expect(await screen.findByText('+500 管理员充值')).toBeTruthy();
    expect(await screen.findByText('1500')).toBeTruthy();
  });

  it('switches billing mode without inventing a second ledger and uses business-friendly labels (#200)', async () => {
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

    // No raw SHADOW / 继承（SHADOW） or 字节 jargon
    expect(screen.getByText('跟随系统默认（免费体验期）')).toBeTruthy();
    expect(screen.queryByText(/SHADOW/)).toBeNull();
    expect(screen.queryByText(/图片存储空间\(字节\)/)).toBeNull();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '计费模式 商户甲' }));
    fireEvent.click(await screen.findByText('正式计费'));
    expect(client.setMode).toHaveBeenCalledWith('tenant-a', 'STRICT');
  });

  it('edits tenant expiresAt via date picker and updates quotas across all 6 items (#200)', async () => {
    const client = {
      listTenants: vi.fn(async () => [tenant(1000)]),
      getTenant: vi.fn(async () => ({
        ...tenant(1000),
        quotas: [
          { key: 'MAIN_KEYWORD', used: '3', limit: '100' },
          { key: 'QUESTION', used: '12', limit: '10000' },
          { key: 'AI_WRITE', used: '5', limit: '10000' },
          { key: 'STORAGE_BYTES', used: '2048', limit: '104857600' },
          { key: 'PUBLISH', used: '1', limit: '10000' },
          { key: 'SOCIAL_AUTH', used: '0', limit: '100' },
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
    const editDialog = await screen.findByRole('dialog', { name: '编辑租户' });
    const editDateInput = within(editDialog).getByLabelText('租户有效期') as HTMLInputElement;
    expect(editDateInput.type).toBe('date');
    expect(editDateInput.value).toBe('2027-11-16');

    fireEvent.change(editDateInput, { target: { value: '2028-01-01' } });
    fireEvent.click(within(editDialog).getByRole('switch', { name: '启用状态' }));
    fireEvent.click(within(editDialog).getByRole('button', { name: '保存租户' }));
    await waitFor(() => {
      expect(client.updateTenant).toHaveBeenCalledWith('tenant-a', {
        name: '商户甲',
        expiresAt: new Date('2028-01-01T23:59:59+08:00').toISOString(),
        isActive: false,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '配额 商户甲' }));
    const quotaDialog = await screen.findByRole('dialog', { name: '配额上限 · 商户甲' });
    expect(await within(quotaDialog).findByText(/当前已用：2 KB/)).toBeTruthy();
    expect(within(quotaDialog).getByText(/当前已用：12 个/)).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('主关键词 上限')).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('写作问题 上限')).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('AI写作数量 上限')).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('图片存储空间 上限')).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('文章发布 上限')).toBeTruthy();
    expect(within(quotaDialog).getByLabelText('自媒体授权 上限')).toBeTruthy();

    // Prevent setting limit lower than current used
    fireEvent.change(within(quotaDialog).getByLabelText('写作问题 上限'), {
      target: { value: '5' },
    });
    fireEvent.click(within(quotaDialog).getByRole('button', { name: '保存配额' }));
    expect(await within(quotaDialog).findByText(/写作问题上限不能低于当前已用量/)).toBeTruthy();
    expect(client.updateQuotas).not.toHaveBeenCalled();

    fireEvent.change(within(quotaDialog).getByLabelText('写作问题 上限'), {
      target: { value: '25000' },
    });
    fireEvent.click(within(quotaDialog).getByRole('button', { name: '保存配额' }));
    await waitFor(() => {
      expect(client.updateQuotas).toHaveBeenCalledWith('tenant-a', {
        items: [{ key: 'QUESTION', limit: '25000' }],
      });
    });
  });

  it('creates a new tenant with 1000 default initial points and validates required fields (#197, #200)', async () => {
    const client = {
      listTenants: vi.fn(async () => [tenant(1000)]),
      createTenant: vi.fn(async () => tenant(1000)),
      updateTenant: vi.fn(),
      updateQuotas: vi.fn(),
      adjust: vi.fn(),
      setMode: vi.fn(),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('商户甲')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /开\s*户/ }));
    const dialog = await screen.findByRole('dialog', { name: '开户' });

    // Date picker instead of raw ISO string
    const expiresInput = within(dialog).getByLabelText('有效期') as HTMLInputElement;
    expect(expiresInput.type).toBe('date');
    expect(expiresInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Required validation blocks empty submit
    expect(dialog.querySelectorAll('.ant-form-item-required').length).toBeGreaterThanOrEqual(4);
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));
    expect(await within(dialog).findByText('请填写租户名称', {}, { timeout: 5000 })).toBeTruthy();
    expect(await within(dialog).findByText('请填写登录用户名', {}, { timeout: 5000 })).toBeTruthy();
    expect(await within(dialog).findByText('请输入初始密码', {}, { timeout: 5000 })).toBeTruthy();
    expect(client.createTenant).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: '租户名称' }), {
      target: { value: '商户乙' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '登录用户名' }), {
      target: { value: 'merchant_b' },
    });
    fireEvent.change(within(dialog).getByLabelText('初始密码'), {
      target: { value: 'Passw0rd123' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(client.createTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '商户乙',
          username: 'merchant_b',
          initialPoints: 1000,
        }),
      );
    });
  });

  it('filters tenants by name/username, status, and billing mode, and shows 共 X 条 pagination (#200)', async () => {
    const rows: TenantRow[] = [
      tenant(1000, {
        id: 't1',
        name: '星辰科技',
        username: 'star_tech',
        isActive: true,
        billingMode: null,
        resolvedBillingMode: 'SHADOW',
      }),
      tenant(2000, {
        id: 't2',
        name: '蓝海传媒',
        username: 'ocean_media',
        isActive: false,
        billingMode: 'STRICT',
        resolvedBillingMode: 'STRICT',
      }),
    ];
    const client = {
      listTenants: vi.fn(async () => rows),
      createTenant: vi.fn(),
      updateTenant: vi.fn(),
      updateQuotas: vi.fn(),
      adjust: vi.fn(),
      setMode: vi.fn(),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('星辰科技')).toBeTruthy();
    expect(screen.getByText('蓝海传媒')).toBeTruthy();
    expect(screen.getByText('共 2 条')).toBeTruthy();

    // Search by username
    fireEvent.change(screen.getByRole('textbox', { name: '搜索租户' }), {
      target: { value: 'ocean' },
    });
    expect(screen.queryByText('星辰科技')).toBeNull();
    expect(screen.getByText('蓝海传媒')).toBeTruthy();
    expect(screen.getByText('共 1 条')).toBeTruthy();

    // Reset filters
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(screen.getByText('星辰科技')).toBeTruthy();

    // Filter by status = 正常
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '状态筛选' }));
    fireEvent.click(
      within(
        document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!,
      ).getByText('正常'),
    );
    expect(screen.getByText('星辰科技')).toBeTruthy();
    expect(screen.queryByText('蓝海传媒')).toBeNull();

    // Reset and filter by billing mode = 正式计费
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '计费模式筛选' }));
    const dropdown = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(
      (el) => !el.classList.contains('ant-select-dropdown-hidden'),
    ) as HTMLElement;
    fireEvent.click(within(dropdown).getByText('正式计费'));
    expect(screen.queryByText('星辰科技')).toBeNull();
    expect(screen.getByText('蓝海传媒')).toBeTruthy();
  });

  it('supports Escape close and 取消 across tenant admin modals (#198)', async () => {
    const client = {
      listTenants: vi.fn(async () => [tenant(1000)]),
      createTenant: vi.fn(),
      updateTenant: vi.fn(),
      updateQuotas: vi.fn(),
      adjust: vi.fn(),
      setMode: vi.fn(),
    };
    render(<TenantAdmin client={client} />);
    expect(await screen.findByText('商户甲')).toBeTruthy();

    // 开户: Escape closes
    fireEvent.click(screen.getByRole('button', { name: /开\s*户/ }));
    expect(await screen.findByRole('dialog', { name: '开户' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '开户' })).toBeNull();

    // 编辑租户: no dead minimize/maximize, 取消 closes
    fireEvent.click(screen.getByRole('button', { name: '编辑 商户甲' }));
    const editDlg = await screen.findByRole('dialog', { name: '编辑租户' });
    expect(within(editDlg).queryByRole('button', { name: '最小化' })).toBeNull();
    fireEvent.click(within(editDlg).getByRole('button', { name: /取\s*消/ }));
    expect(screen.queryByRole('dialog', { name: '编辑租户' })).toBeNull();

    // 加点: Escape closes
    fireEvent.click(screen.getByRole('button', { name: '加点 商户甲' }));
    expect(await screen.findByRole('dialog', { name: '加点' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '加点' })).toBeNull();

    // 配额: 取消 closes
    fireEvent.click(screen.getByRole('button', { name: '配额 商户甲' }));
    const quotaDlg = await screen.findByRole('dialog', { name: '配额上限 · 商户甲' });
    fireEvent.click(within(quotaDlg).getByRole('button', { name: /取\s*消/ }));
    expect(screen.queryByRole('dialog', { name: '配额上限 · 商户甲' })).toBeNull();
  });
});
