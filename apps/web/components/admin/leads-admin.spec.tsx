// @vitest-environment jsdom

import type { MarketingLeadDto } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, type MarketingLeadListResult } from '../../lib/admin-client';
import { LeadsAdmin, type LeadsAdminClient } from './leads-admin';

const CUID_1 = 'cmwkm6lyw001g14g2qj5t1xxb';
const CUID_2 = 'cmwkm6lyw002h14g2qj5t2yyc';

const SAMPLE_LEADS: MarketingLeadDto[] = [
  {
    id: CUID_1,
    locale: 'en',
    name: 'Alice Chen',
    email: 'alice@nordicaudio.example',
    companyBrand: 'NordicAudio',
    websiteUrl: 'https://nordicaudio.example',
    targetMarket: 'GLOBAL',
    monthlyGoal: '12 GEO articles + ChatGPT visibility',
    estimatedPts: 640,
    notes: 'Interested in Shopify L1 publishing',
    sourcePage: '/pricing',
    status: 'NEW',
    adminNote: '初筛合格',
    createdAt: '2026-11-24T01:30:00.000Z',
    updatedAt: '2026-11-24T01:30:00.000Z',
  },
  {
    id: CUID_2,
    locale: 'zh-CN',
    name: '张伟',
    email: 'wei@huaxia.example',
    companyBrand: '华夏云声',
    websiteUrl: 'javascript:alert(1)',
    targetMarket: 'BOTH',
    monthlyGoal: '中英双市场月更 20 篇',
    estimatedPts: 1480,
    notes: null,
    sourcePage: '/zh/demo',
    status: 'CONTACTED',
    adminNote: null,
    createdAt: '2026-11-23T16:05:00.000Z',
    updatedAt: '2026-11-23T16:05:00.000Z',
  },
];

function createClient(overrides?: Partial<LeadsAdminClient>) {
  const listAdminLeads = vi.fn<LeadsAdminClient['listAdminLeads']>().mockResolvedValue({
    items: SAMPLE_LEADS,
    total: SAMPLE_LEADS.length,
    page: 1,
    pageSize: 20,
  } satisfies MarketingLeadListResult);
  const updateAdminLead = vi
    .fn<LeadsAdminClient['updateAdminLead']>()
    .mockImplementation(async (id, input) => {
      const base = SAMPLE_LEADS.find((item) => item.id === id) ?? SAMPLE_LEADS[0]!;
      return {
        ...base,
        status: input.status ?? base.status,
        adminNote: input.adminNote !== undefined ? input.adminNote : base.adminNote,
        updatedAt: '2026-11-24T03:00:00.000Z',
      };
    });

  return {
    listAdminLeads: overrides?.listAdminLeads ?? listAdminLeads,
    updateAdminLead: overrides?.updateAdminLead ?? updateAdminLead,
  };
}

async function selectAntdOption(combobox: HTMLElement, optionText: string) {
  fireEvent.mouseDown(combobox);
  await waitFor(() => {
    const dropdowns = Array.from(
      document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
    );
    expect(dropdowns.length).toBeGreaterThan(0);
  });
  const dropdowns = Array.from(
    document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
  );
  const activeDropdown = dropdowns[dropdowns.length - 1] as HTMLElement;
  fireEvent.click(within(activeDropdown).getByText(optionText));
}

describe('LeadsAdmin (/admin/leads console, #379)', () => {
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  });

  it('loads leads, formats Shanghai time, renders safe/unsafe URLs properly, links to /admin/tenants, and never leaks raw CUIDs', async () => {
    const client = createClient();
    const { container } = render(<LeadsAdmin client={client} />);

    await waitFor(() => {
      expect(screen.getByText('NordicAudio')).toBeTruthy();
    });

    expect(client.listAdminLeads).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(screen.getByText('Alice Chen')).toBeTruthy();
    expect(screen.getByText('alice@nordicaudio.example')).toBeTruthy();
    expect(screen.getByText('海外市场')).toBeTruthy();
    expect(screen.getByText('海外 + 国内双市场')).toBeTruthy();
    expect(screen.getAllByText('待跟进').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已联系').length).toBeGreaterThan(0);
    expect(screen.getByText('约 640 点/月')).toBeTruthy();
    expect(screen.getByText('2026-11-24 09:30')).toBeTruthy();
    expect(screen.getByText('2026-11-24 00:05')).toBeTruthy();
    expect(screen.getByText('共 2 条')).toBeTruthy();

    const safeLink = screen.getByRole('link', { name: 'https://nordicaudio.example' });
    expect(safeLink.getAttribute('href')).toBe('https://nordicaudio.example');
    expect(safeLink.getAttribute('target')).toBe('_blank');
    expect(safeLink.getAttribute('rel')).toBe('noopener noreferrer');

    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();

    const demoLink = screen.getByRole('link', { name: '前往租户管理开通 Demo' });
    expect(demoLink.getAttribute('href')).toBe('/admin/tenants');

    expect(container.textContent).not.toContain(CUID_1);
    expect(container.textContent).not.toContain(CUID_2);
    expect(container.querySelector(`[title="${CUID_1}"]`)).toBeNull();
    expect(container.querySelector(`[title="${CUID_2}"]`)).toBeNull();
  });

  it('filters by status, targetMarket, and keyword, supports reset, and distinguishes empty states', async () => {
    const listAdminLeads = vi.fn<LeadsAdminClient['listAdminLeads']>().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const client = createClient({ listAdminLeads });

    render(<LeadsAdmin client={client} />);

    await waitFor(() => {
      expect(screen.getByText('暂无试用线索')).toBeTruthy();
    });

    await selectAntdOption(screen.getByRole('combobox', { name: '状态筛选' }), '已联系');
    await waitFor(() => {
      expect(listAdminLeads).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        status: 'CONTACTED',
      });
    });

    expect(screen.getByText('没有匹配的试用线索')).toBeTruthy();

    await selectAntdOption(screen.getByRole('combobox', { name: '目标市场筛选' }), '海外市场');
    await waitFor(() => {
      expect(listAdminLeads).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        status: 'CONTACTED',
        targetMarket: 'GLOBAL',
      });
    });

    const searchInput = screen.getByRole('textbox', { name: '搜索线索' });
    fireEvent.change(searchInput, { target: { value: '  nordic  ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜 索' }));

    await waitFor(() => {
      expect(listAdminLeads).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        status: 'CONTACTED',
        targetMarket: 'GLOBAL',
        keyword: 'nordic',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    await waitFor(() => {
      expect(listAdminLeads).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
      });
    });
  });

  it('requests the next page when server-side pagination changes', async () => {
    const listAdminLeads = vi
      .fn<LeadsAdminClient['listAdminLeads']>()
      .mockImplementation(async (query) => ({
        items: SAMPLE_LEADS,
        total: 35,
        page: query?.page ?? 1,
        pageSize: query?.pageSize ?? 20,
      }));
    const client = createClient({ listAdminLeads });

    render(<LeadsAdmin client={client} />);

    await waitFor(() => {
      expect(screen.getByText('共 35 条')).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle('2'));

    await waitFor(() => {
      expect(listAdminLeads).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 });
    });
  });

  it('updates lead status inline and reloads the list', async () => {
    const client = createClient();
    render(<LeadsAdmin client={client} />);

    await waitFor(() => {
      expect(screen.getByText('NordicAudio')).toBeTruthy();
    });

    const statusSelect = screen.getByRole('combobox', { name: '变更状态 NordicAudio' });
    await selectAntdOption(statusSelect, '已开通试用');

    await waitFor(() => {
      expect(client.updateAdminLead).toHaveBeenCalledWith(CUID_1, {
        status: 'TRIAL_PROVISIONED',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('已将「NordicAudio」状态更新为已开通试用')).toBeTruthy();
    });
    expect(client.listAdminLeads).toHaveBeenCalledTimes(2);
  });

  it('edits status and adminNote in follow-up modal and submits null when adminNote is cleared', async () => {
    const client = createClient();
    render(<LeadsAdmin client={client} />);

    await waitFor(() => {
      expect(screen.getByText('NordicAudio')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '跟进备注 NordicAudio' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('跟进线索 · NordicAudio')).toBeTruthy();
    expect(within(dialog).getByText('Interested in Shopify L1 publishing')).toBeTruthy();
    expect(dialog.textContent).not.toContain(CUID_1);

    await selectAntdOption(within(dialog).getByRole('combobox', { name: '线索状态' }), '已联系');
    const noteBox = within(dialog).getByRole('textbox', { name: '管理员跟进备注' });
    fireEvent.change(noteBox, { target: { value: '已邮件确认 Demo 需求' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      expect(client.updateAdminLead).toHaveBeenCalledWith(CUID_1, {
        status: 'CONTACTED',
        adminNote: '已邮件确认 Demo 需求',
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Re-open and clear adminNote to whitespace -> must submit adminNote: null
    fireEvent.click(screen.getByRole('button', { name: '跟进备注 NordicAudio' }));
    const dialog2 = await screen.findByRole('dialog');
    const noteBox2 = within(dialog2).getByRole('textbox', { name: '管理员跟进备注' });
    fireEvent.change(noteBox2, { target: { value: '   ' } });
    fireEvent.click(within(dialog2).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      expect(client.updateAdminLead).toHaveBeenLastCalledWith(CUID_1, {
        status: 'NEW',
        adminNote: null,
      });
    });
  });

  it('renders error alert on initial load failure and keeps modal open with inline error on save failure', async () => {
    const failLoadClient = createClient({
      listAdminLeads: vi
        .fn<LeadsAdminClient['listAdminLeads']>()
        .mockRejectedValue(new AdminApiError(500, '加载线索失败')),
    });

    const { unmount } = render(<LeadsAdmin client={failLoadClient} />);
    await waitFor(() => {
      expect(screen.getByText('加载线索失败')).toBeTruthy();
    });
    unmount();

    const failSaveClient = createClient({
      updateAdminLead: vi
        .fn<LeadsAdminClient['updateAdminLead']>()
        .mockRejectedValue(new AdminApiError(500, '保存备注失败')),
    });

    render(<LeadsAdmin client={failSaveClient} />);
    await waitFor(() => {
      expect(screen.getByText('NordicAudio')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '跟进备注 NordicAudio' }));
    const dialog = await screen.findByRole('dialog');
    const noteBox = within(dialog).getByRole('textbox', { name: '管理员跟进备注' });
    fireEvent.change(noteBox, { target: { value: '保留未丢失的备注' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      expect(within(dialog).getByText('保存备注失败')).toBeTruthy();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((noteBox as HTMLTextAreaElement).value).toBe('保留未丢失的备注');
  });
});
