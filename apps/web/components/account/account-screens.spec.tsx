// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerPage, PointItem, RightsView } from '../../lib/account-client';
import { AccountScreen, resolveAccountTab } from './account-screen';
import { PointsScreen } from './points-screen';
import { RightsScreen } from './rights-screen';

const replaceMock = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/account',
  useSearchParams: () => mockSearchParams,
}));

const listExtensionTokensMock = vi.fn();

vi.mock('../../lib/extension', () => ({
  listExtensionTokens: (...args: unknown[]) => listExtensionTokensMock(...args),
  createExtensionToken: vi.fn(),
  revokeExtensionToken: vi.fn(),
}));

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  replaceMock.mockReset();
  listExtensionTokensMock.mockReset();
  listExtensionTokensMock.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pointPage(items: PointItem[]): LedgerPage<PointItem> {
  return { items, total: items.length, page: 1, pageSize: 10 };
}

function summaryStub(overrides?: Partial<RightsView>): RightsView {
  return {
    points: 1500,
    pointsReserved: 100,
    available: 1400,
    billingMode: 'SHADOW',
    cards: [],
    models: [],
    ...overrides,
  };
}

function rightsViewStub(): RightsView {
  return {
    points: 1500,
    billingMode: 'SHADOW',
    cards: [
      { key: 'MAIN_KEYWORD', label: '品牌数量', text: '1 / 100', used: '1', limit: '100' },
      { key: 'QUESTION', label: '写作意见', text: '3 / 10000', used: '3', limit: '10000' },
      { key: 'INCLUDED', label: '已收录', text: '1', used: '1' },
      { key: 'AI_WRITE', label: 'GEO写作数量', text: '2 / 10000', used: '2', limit: '10000' },
      { key: 'PUBLISH', label: '文章发布', text: '0 / 10000', used: '0', limit: '10000' },
      { key: 'SOCIAL_AUTH', label: '自媒体授权', text: '0 / 100', used: '0', limit: '100' },
      { key: 'EXPIRES', label: '有效期', text: '2027-11-16' },
      {
        key: 'STORAGE_BYTES',
        label: '图片存储空间',
        text: '2 KB / 100 MB',
        used: '2048',
        limit: '104857600',
      },
      { key: 'POINTS', label: '点数', text: '1500' },
    ],
    models: [
      { key: 'deepseek', label: 'DeepSeek', count: 0 },
      { key: 'doubao', label: '豆包', count: 0 },
      { key: 'yuanbao', label: '腾讯元宝', count: 0 },
      { key: 'tongyi', label: '通义千问', count: 0 },
    ],
  };
}

describe('GeoMix /account 3-tab screens & cold-load zero-flicker (PR8 Y36-Y39)', () => {
  it('resolves tab keys safely and syncs ?tab= while preserving brandId and market (Y36)', async () => {
    expect(resolveAccountTab('points')).toBe('points');
    expect(resolveAccountTab('rights')).toBe('rights');
    expect(resolveAccountTab('extension')).toBe('extension');
    expect(resolveAccountTab('verify')).toBe('points');
    expect(resolveAccountTab('money')).toBe('points');
    expect(resolveAccountTab(null)).toBe('points');

    mockSearchParams = new URLSearchParams('brandId=b1&market=GLOBAL&tab=rights');
    render(
      <AccountScreen
        loadPoints={async () => pointPage([])}
        loadSummary={async () => summaryStub()}
        loadRights={async () => rightsViewStub()}
      />,
    );

    expect(screen.getByRole('tab', { name: '点数明细' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '账号权益' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '扩展配对' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '实名认证' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '余额明细' })).toBeNull();
    expect(screen.queryByText(/¥0\.00/)).toBeNull();

    // Initially opens rights tab from ?tab=rights
    expect(await screen.findByText('2 KB / 100 MB')).toBeTruthy();

    // Switch to extension tab -> preserves brandId & market
    fireEvent.click(screen.getByRole('tab', { name: '扩展配对' }));
    expect(replaceMock).toHaveBeenCalledWith('/account?brandId=b1&market=GLOBAL&tab=extension', {
      scroll: false,
    });
    expect(await screen.findByTestId('extension-pairing-panel')).toBeTruthy();
  });

  it('shows cold-load skeletons with zero 0 点 / 0 条 / 免费体验期 / STRICT caption flash while pending', () => {
    const pendingPoints = new Promise<LedgerPage<PointItem>>(() => undefined);
    const pendingSummary = new Promise<RightsView>(() => undefined);

    const { unmount: unmountPoints } = render(
      <PointsScreen
        title="点数明细"
        load={() => pendingPoints}
        loadSummary={() => pendingSummary}
      />,
    );

    expect(screen.getAllByTestId('points-kpi-skeleton')).toHaveLength(3);
    expect(screen.getByTestId('points-table-skeleton')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b0\s*点\b/);
    expect(document.body.textContent).not.toContain('0 条');
    expect(document.body.textContent).not.toContain('免费体验期');
    expect(document.body.textContent).not.toContain('按实际成功产出结算扣减可用点数');
    expect(document.body.textContent).not.toContain('¥0.00');
    unmountPoints();

    render(<RightsScreen title="账号权益" load={() => new Promise<RightsView>(() => undefined)} />);
    expect(screen.getByTestId('rights-loading')).toBeTruthy();
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  });

  it('shows points summary, auto-filters without query button, keeps CSV-only export, and avoids duplicate phrase concatenation (Y38/Y39)', async () => {
    const load = vi.fn(async () =>
      pointPage([
        {
          id: 'p1',
          title: '管理员充值',
          delta: 500,
          listPrice: 500,
          phrase: '+500 管理员充值',
          pointsText: '+500',
          createdAt: '2026-11-16T02:00:00.000Z',
          status: 'SETTLED',
        },
        {
          id: 'p2',
          title: 'GEO写作-便携屏选型实测（免费期）',
          delta: 0,
          listPrice: 10,
          phrase: '0 GEO写作-便携屏选型实测（免费期）',
          pointsText: '0（原价 10）',
          createdAt: '2026-11-16T03:30:00.000Z',
          status: 'SETTLED',
        },
      ]),
    );
    render(<PointsScreen title="点数明细" load={load} loadSummary={async () => summaryStub()} />);
    expect(await screen.findByText('管理员充值')).toBeTruthy();
    expect(screen.getByText('+500')).toBeTruthy();
    expect(screen.getByText('0（原价 10）')).toBeTruthy();
    expect(screen.getByText('1,400 点')).toBeTruthy();
    expect(screen.getByText('免费体验期')).toBeTruthy();
    expect(screen.getByText('2026-11-16 10:00:00')).toBeTruthy();

    expect(screen.queryByRole('button', { name: '查询' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 XLSX' })).toBeNull();
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeTruthy();

    expect(screen.queryByText('+500 管理员充值')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('.ant-table-selection')).toBeNull();

    const dataRows = document.querySelectorAll('tbody tr.ant-table-row');
    expect(dataRows).toHaveLength(2);
    expect(dataRows[0]?.getAttribute('aria-hidden')).toBeNull();

    expect(screen.getByRole('columnheader', { name: '序号' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '项目' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '点数' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '消耗时间' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
      target: { value: '管理员充值' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '点数变动' }), {
      target: { value: '500' },
    });
    await waitFor(() => {
      expect(load).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: '管理员充值', delta: 500, page: 1 }),
      );
    });
  });

  it('sanitizes CoT reasoning leakage, truncates long titles, and warns on empty points export (#201)', async () => {
    const warnSpy = vi
      .spyOn(message, 'warning')
      .mockImplementation(() => (() => undefined) as never);
    const longValidTitle = 'GEO写作-面向华东工业制造企业的激光切割机选型对比与维护指南长标题示例';
    const load = vi
      .fn<() => Promise<LedgerPage<PointItem>>>()
      .mockResolvedValueOnce(
        pointPage([
          {
            id: 'p-cot',
            title: 'AI生图-用户需要把简短描述扩写成配图提示词，80-220（免费期）',
            delta: 0,
            listPrice: 5,
            phrase: '0 AI生图-用户需要把简短描述扩写成配图提示词，80-220（免费期）',
            pointsText: '0（原价 5）',
            createdAt: '2026-11-16T04:00:00.000Z',
            status: 'SETTLED',
          },
          {
            id: 'p-long',
            title: longValidTitle,
            delta: -10,
            listPrice: 10,
            phrase: `-10 ${longValidTitle}`,
            pointsText: '-10',
            createdAt: '2026-11-16T05:00:00.000Z',
            status: 'SETTLED',
          },
        ]),
      )
      .mockResolvedValueOnce(pointPage([]));
    const exportFile = vi.fn();

    render(<PointsScreen title="点数明细" load={load} exportFile={exportFile} />);
    expect(await screen.findByText('AI生图（免费期）')).toBeTruthy();
    expect(screen.queryByText(/用户需要把简短描述扩写成配图提示词/)).toBeNull();
    expect(document.querySelector('.gm-clamp-1')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
      target: { value: '不存在' },
    });
    expect(await screen.findByText('没有找到匹配的记录')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByText('当前列表暂无可导出数据')).toBeTruthy();
    expect(warnSpy).toHaveBeenCalledWith('当前列表暂无可导出数据');
    expect(exportFile).not.toHaveBeenCalled();
  });

  it('shows 9 v2 quota/rights cards and omits duplicate 模型收录 block (Y37)', async () => {
    render(<RightsScreen title="账号权益" load={async () => rightsViewStub()} />);
    expect(await screen.findByText('2 KB / 100 MB')).toBeTruthy();
    expect(screen.getByText('1500')).toBeTruthy();
    expect(screen.getByRole('article', { name: '品牌数量' }).textContent).toContain('1 / 100');
    expect(screen.queryByRole('article', { name: '余额' })).toBeNull();
    expect(screen.queryByText('模型收录')).toBeNull();
    expect(document.querySelectorAll('.gm-right-card')).toHaveLength(9);
  });

  it('refreshes /me/rights usage when returning to the active tab (#195)', async () => {
    const initial: RightsView = {
      points: 1000,
      billingMode: 'SHADOW',
      cards: [
        { key: 'MAIN_KEYWORD', label: '品牌数量', text: '2 / 100', used: '2', limit: '100' },
        { key: 'AI_WRITE', label: 'GEO写作数量', text: '0 / 10000', used: '0', limit: '10000' },
        {
          key: 'STORAGE_BYTES',
          label: '图片存储空间',
          text: '0 MB / 100 MB',
          used: '0',
          limit: '104857600',
        },
      ],
      models: [],
    };
    const updated: RightsView = {
      ...initial,
      cards: [
        { key: 'MAIN_KEYWORD', label: '品牌数量', text: '2 / 100', used: '2', limit: '100' },
        { key: 'AI_WRITE', label: 'GEO写作数量', text: '1 / 10000', used: '1', limit: '10000' },
        {
          key: 'STORAGE_BYTES',
          label: '图片存储空间',
          text: '5 KB / 100 MB',
          used: '5120',
          limit: '104857600',
        },
      ],
    };
    const load = vi
      .fn<() => Promise<RightsView>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(updated);

    const view = render(<RightsScreen title="账号权益" active load={load} />);
    expect(await screen.findByText('0 / 10000')).toBeTruthy();
    expect(screen.getByText('0 MB / 100 MB')).toBeTruthy();

    view.rerender(<RightsScreen title="账号权益" active={false} load={load} />);
    view.rerender(<RightsScreen title="账号权益" active load={load} />);

    expect(await screen.findByText('1 / 10000')).toBeTruthy();
    expect(screen.getByText('5 KB / 100 MB')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('supports extension pairing tab via ?tab=extension preserving brandId/market and readOnly', async () => {
    expect(resolveAccountTab('extension')).toBe('extension');
    mockSearchParams = new URLSearchParams('brandId=b1&market=CN&tab=points');

    render(
      <AccountScreen
        readOnly={true}
        loadPoints={async () => pointPage([])}
        loadSummary={async () => summaryStub()}
        loadRights={async () => rightsViewStub()}
      />,
    );

    const extTab = screen.getByRole('tab', { name: '扩展配对' });
    expect(extTab).toBeTruthy();

    fireEvent.click(extTab);
    expect(replaceMock).toHaveBeenCalledWith('/account?brandId=b1&market=CN&tab=extension', {
      scroll: false,
    });
    expect(await screen.findByTestId('extension-pairing-panel')).toBeTruthy();
    expect((screen.getByTestId('extension-token-create-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
