// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, type AnnouncementRow, type PriceRow } from '../../lib/admin-client';
import { AnnouncementAdmin, PricingAdmin } from './catalog-admin';

afterEach(() => {
  cleanup();
});

function samplePrices(): PriceRow[] {
  return [
    { action: 'ai_write', unitPoints: 10, enabled: true, updatedAt: '2026-11-18T00:00:00.000Z' },
    { action: 'distill', unitPoints: 10, enabled: true, updatedAt: '2026-11-18T00:00:00.000Z' },
    { action: 'image_gen', unitPoints: 5, enabled: true, updatedAt: '2026-11-18T00:00:00.000Z' },
    { action: 'kb_addon', unitPoints: 5, enabled: true, updatedAt: '2026-11-18T00:00:00.000Z' },
    {
      action: 'rewrite_batch',
      unitPoints: 5,
      enabled: true,
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      action: 'rewrite_single',
      unitPoints: 5,
      enabled: true,
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      action: 'visibility_check',
      unitPoints: 2,
      enabled: true,
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  ];
}

function sampleAnnouncements(): AnnouncementRow[] {
  return [
    {
      id: 'ann-1',
      content: 'GeoMix 平台日常维护通知',
      enabled: true,
      sort: 0,
      operatorId: 'user-admin',
      operatorName: '管理员 (admin)',
      createdAt: '2026-11-18T00:05:09.000Z',
      updatedAt: '2026-11-18T00:05:09.000Z',
    },
    {
      id: 'ann-2',
      content: '旧版停用公告',
      enabled: false,
      sort: 1,
      operatorId: null,
      operatorName: null,
      createdAt: '2026-11-17T16:30:00.000Z',
      updatedAt: '2026-11-17T16:30:00.000Z',
    },
  ];
}

describe('PricingAdmin (#196)', () => {
  it('displays Chinese business names, billing units, and descriptions instead of raw snake_case keys', async () => {
    const client = {
      listPrices: vi.fn(async () => samplePrices()),
      updatePrice: vi.fn(),
      updatePrices: vi.fn(),
    };

    render(<PricingAdmin client={client} />);

    expect(await screen.findByText(/AI 文章写作/)).toBeTruthy();
    expect(screen.getByText(/知识库增强附加费/)).toBeTruthy();
    expect(screen.getByText(/AI 蒸馏拓展/)).toBeTruthy();
    expect(screen.getByText(/单篇流量复刻/)).toBeTruthy();
    expect(screen.getByText(/批量流量复刻/)).toBeTruthy();
    expect(screen.getByText(/AI 生图/)).toBeTruthy();
    expect(screen.getByText(/AI 可见性监测/)).toBeTruthy();

    expect(screen.getAllByText(/点\/篇/).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText(/点\/次/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/点\/张/).length).toBeGreaterThanOrEqual(1);

    for (const rawKey of [
      'ai_write',
      'distill',
      'image_gen',
      'kb_addon',
      'rewrite_batch',
      'rewrite_single',
      'visibility_check',
    ]) {
      expect(screen.queryByText(rawKey)).toBeNull();
    }
  });

  it('supports editing multiple rows and saving them together in a single batch call', async () => {
    const rows = samplePrices();
    const updatePrices = vi.fn(async ({ items }) => {
      const next = rows.map((row) => {
        const patch = items.find((item: { action: string }) => item.action === row.action);
        return patch ? { ...row, unitPoints: patch.unitPoints, enabled: patch.enabled } : row;
      });
      return { items: next };
    });
    const client = {
      listPrices: vi.fn(async () => rows),
      updatePrice: vi.fn(),
      updatePrices,
    };

    render(<PricingAdmin client={client} />);
    expect(await screen.findByText(/AI 文章写作/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('AI 文章写作 点数'), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('知识库增强附加费 点数'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByLabelText('AI 生图 启用'));

    const batchSaveBtn = screen.getByRole('button', { name: /批量保存/ });
    expect((batchSaveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(batchSaveBtn);

    await waitFor(() => {
      expect(updatePrices).toHaveBeenCalledTimes(1);
    });
    expect(updatePrices).toHaveBeenCalledWith({
      items: expect.arrayContaining([
        { action: 'ai_write', unitPoints: 12, enabled: true },
        { action: 'kb_addon', unitPoints: 8, enabled: true },
        { action: 'image_gen', unitPoints: 5, enabled: false },
      ]),
    });
    expect(client.updatePrice).not.toHaveBeenCalled();
    expect(await screen.findByText(/已批量保存/)).toBeTruthy();
  });

  it('shows validation error and avoids batch save when any modified price is invalid', async () => {
    const client = {
      listPrices: vi.fn(async () => samplePrices()),
      updatePrice: vi.fn(),
      updatePrices: vi.fn(),
    };

    render(<PricingAdmin client={client} />);
    expect(await screen.findByText(/AI 文章写作/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('AI 文章写作 点数'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: /批量保存/ }));

    expect(await screen.findByText(/价格不正确/)).toBeTruthy();
    expect(client.updatePrices).not.toHaveBeenCalled();
  });
});

describe('AnnouncementAdmin (#199)', () => {
  it('renders createdAt in UTC+8 and operator columns', async () => {
    const client = {
      listAnnouncements: vi.fn(async () => sampleAnnouncements()),
      createAnnouncement: vi.fn(),
      updateAnnouncement: vi.fn(),
      deleteAnnouncement: vi.fn(),
    };

    render(<AnnouncementAdmin client={client} />);

    expect(await screen.findByText('GeoMix 平台日常维护通知')).toBeTruthy();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('操作人')).toBeTruthy();
    expect(screen.getByText('2026-11-18 08:05:09')).toBeTruthy();
    expect(screen.getByText('2026-11-18 00:30:00')).toBeTruthy();
    expect(screen.getByText('管理员 (admin)')).toBeTruthy();
  });

  it('edits an announcement via declarative modal and updates the row', async () => {
    const initial = sampleAnnouncements();
    const updateAnnouncement = vi.fn(async (id, input) => ({
      ...initial[0],
      id,
      content: input.content,
      enabled: input.enabled,
      sort: input.sort,
      operatorName: '运营管理员 (ops)',
    }));
    const client = {
      listAnnouncements: vi.fn(async () => initial),
      createAnnouncement: vi.fn(),
      updateAnnouncement,
      deleteAnnouncement: vi.fn(),
    };

    render(<AnnouncementAdmin client={client} />);
    expect(await screen.findByText('GeoMix 平台日常维护通知')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('编辑 GeoMix 平台日常维护通知'));
    const dialog = await screen.findByRole('dialog', { name: '编辑公告' });
    fireEvent.change(within(dialog).getByLabelText('编辑公告内容'), {
      target: { value: 'GeoMix 平台升级完成通知' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => {
      expect(updateAnnouncement).toHaveBeenCalledWith('ann-1', {
        content: 'GeoMix 平台升级完成通知',
        enabled: true,
        sort: 0,
      });
    });
    const table = screen.getByRole('table');
    expect(await within(table).findByText('GeoMix 平台升级完成通知')).toBeTruthy();
    expect(within(table).getByText('运营管理员 (ops)')).toBeTruthy();
  });

  it('requires confirmation before deleting an announcement and removes it on confirm', async () => {
    const initial = sampleAnnouncements();
    const deleteAnnouncement = vi.fn(async (id: string) => ({ deleted: true, id }));
    const client = {
      listAnnouncements: vi.fn(async () => initial),
      createAnnouncement: vi.fn(),
      updateAnnouncement: vi.fn(),
      deleteAnnouncement,
    };

    render(<AnnouncementAdmin client={client} />);
    expect(await screen.findByText('GeoMix 平台日常维护通知')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('删除 GeoMix 平台日常维护通知'));
    const confirmDialog = await screen.findByRole('dialog', { name: '确认删除公告' });
    expect(within(confirmDialog).getByText(/GeoMix 平台日常维护通知/)).toBeTruthy();

    // Cancel first — must not delete
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /取\s*消/ }));
    expect(deleteAnnouncement).not.toHaveBeenCalled();

    // Re-open and confirm delete
    fireEvent.click(screen.getByLabelText('删除 GeoMix 平台日常维护通知'));
    const confirmDialog2 = await screen.findByRole('dialog', { name: '确认删除公告' });
    fireEvent.click(within(confirmDialog2).getByRole('button', { name: /确认删除/ }));

    await waitFor(() => {
      expect(deleteAnnouncement).toHaveBeenCalledWith('ann-1');
    });
    const table = screen.getByRole('table');
    await waitFor(() => {
      expect(within(table).queryByText('GeoMix 平台日常维护通知')).toBeNull();
    });
    expect(within(table).getByText('旧版停用公告')).toBeTruthy();
  });

  it('surfaces API error instead of silently swallowing delete failures', async () => {
    const initial = sampleAnnouncements();
    const client = {
      listAnnouncements: vi.fn(async () => initial),
      createAnnouncement: vi.fn(),
      updateAnnouncement: vi.fn(),
      deleteAnnouncement: vi.fn().mockRejectedValue(new AdminApiError(500, '删除公告失败')),
    };

    render(<AnnouncementAdmin client={client} />);
    expect(await screen.findByText('GeoMix 平台日常维护通知')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('删除 GeoMix 平台日常维护通知'));
    const confirmDialog = await screen.findByRole('dialog', { name: '确认删除公告' });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /确认删除/ }));

    expect(await screen.findByText('删除公告失败')).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('GeoMix 平台日常维护通知')).toBeTruthy();
  });
});
