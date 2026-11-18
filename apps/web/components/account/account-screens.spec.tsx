// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerPage, MoneyItem, PointItem, RightsView } from '../../lib/account-client';
import { MoneyScreen } from './money-screen';
import { PointsScreen } from './points-screen';
import { RightsScreen } from './rights-screen';
import { VerifyScreen } from './verify-screen';

afterEach(() => {
  cleanup();
});

function pointPage(items: PointItem[]): LedgerPage<PointItem> {
  return { items, total: items.length, page: 1, pageSize: 10 };
}

function moneyPage(items: MoneyItem[]): LedgerPage<MoneyItem> {
  return { items, total: items.length, page: 1, pageSize: 10 };
}

describe('personal center screens', () => {
  it('shows +500 管理员充值 and can filter by project and delta', async () => {
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
      ]),
    );
    render(<PointsScreen title="点数明细" load={load} />);
    expect(await screen.findByText('+500 管理员充值')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '管理员充值', delta: 500, page: 1 }),
    );
  });

  it('renders money rows without a checkbox or sequence column', async () => {
    const load = vi.fn(async () =>
      moneyPage([
        {
          id: 'm1',
          title: '余额示例',
          amount: '12.50',
          remark: '说明示例',
          createdAt: '2026-11-16T02:00:00.000Z',
        },
      ]),
    );
    render(<MoneyScreen title="余额明细" load={load} />);
    expect(await screen.findByText('余额示例')).toBeTruthy();
    expect(screen.getByText('12.50')).toBeTruthy();
    expect(screen.getByText('说明示例')).toBeTruthy();
    for (const name of ['项目', '金额', '说明', '消耗时间']) {
      expect(screen.getByRole('columnheader', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('columnheader', { name: '序号' })).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('.ant-table-selection')).toBeNull();
  });

  it('shows quota ratios, storage used and limit, and eight model cards', async () => {
    const view: RightsView = {
      points: 1500,
      money: '0.00',
      billingMode: 'SHADOW',
      cards: [
        { key: 'MAIN_KEYWORD', label: '主关键词', text: '0 / 100', used: '0', limit: '100' },
        { key: 'QUESTION', label: '写作问题', text: '0 / 10000', used: '0', limit: '10000' },
        { key: 'INCLUDED', label: '已收录', text: '1', used: '1' },
        { key: 'AI_WRITE', label: 'AI写作数量', text: '0 / 10000', used: '0', limit: '10000' },
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
        { key: 'MONEY', label: '余额', text: '0.00' },
      ],
      models: [
        { key: 'deepseek', label: 'DeepSeek', count: 0 },
        { key: 'doubao', label: '豆包', count: 0 },
        { key: 'yuanbao', label: '腾讯元宝', count: 0 },
        { key: 'tongyi', label: '通义千问', count: 0 },
        { key: 'wenxin', label: '文心一言', count: 0 },
        { key: 'nami', label: '纳米', count: 0 },
        { key: 'kimi', label: 'Kimi', count: 0 },
        { key: 'zhipu', label: '智谱', count: 0 },
      ],
    };
    render(<RightsScreen title="账号权益" load={async () => view} />);
    expect(await screen.findByText('2 KB / 100 MB')).toBeTruthy();
    expect(screen.getByText('1500')).toBeTruthy();
    expect(screen.getAllByText('0')).toHaveLength(8);
    expect(screen.getByRole('article', { name: '主关键词' }).textContent).toContain('0 / 100');
    expect(document.querySelectorAll('.gm-right-card')).toHaveLength(18);
    expect(screen.queryByText(/额度来自配额表|模型收录计数留到后续模块/)).toBeNull();
  });

  it('refreshes /me/rights usage when returning to the keep-alive tab (#195)', async () => {
    const initial: RightsView = {
      points: 1000,
      money: '0.00',
      billingMode: 'SHADOW',
      cards: [
        { key: 'MAIN_KEYWORD', label: '主关键词', text: '2 / 100', used: '2', limit: '100' },
        { key: 'AI_WRITE', label: 'AI写作数量', text: '0 / 10000', used: '0', limit: '10000' },
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
        { key: 'MAIN_KEYWORD', label: '主关键词', text: '2 / 100', used: '2', limit: '100' },
        { key: 'AI_WRITE', label: 'AI写作数量', text: '1 / 10000', used: '1', limit: '10000' },
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

  it('submits the placeholder verification form and blocks writes when read only', async () => {
    const submit = vi.fn(async (input) => ({
      ...input,
      status: 'SUBMITTED',
      placeholder: true,
      updatedAt: '2026-11-16T00:00:00.000Z',
    }));
    const view = render(<VerifyScreen title="实名认证" load={async () => null} submit={submit} />);
    expect(await screen.findByText(/尚未开通核验/)).toBeTruthy();
    expect(screen.queryByText(/https?:\/\//)).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '主体名称' }), {
      target: { value: '示例主体' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '统一社会信用代码' }), {
      target: { value: '91310000abcd1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交资料' }));
    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        companyName: '示例主体',
        creditCode: '91310000ABCD1234',
        contact: '',
        phone: '',
      });
    });
    view.rerender(
      <VerifyScreen title="实名认证" readOnly load={async () => null} submit={submit} />,
    );
    expect(screen.getByRole('button', { name: '提交资料' })).toHaveProperty('disabled', true);
  });

  it('blocks empty verify submission with inline required validation and asterisks (#197)', async () => {
    const submit = vi.fn();
    render(<VerifyScreen title="实名认证" load={async () => null} submit={submit} />);
    await screen.findByText(/尚未开通核验/);

    expect(document.querySelectorAll('.ant-form-item-required')).toHaveLength(2);
    expect(
      screen.getByRole('textbox', { name: '主体名称' }).getAttribute('placeholder'),
    ).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: '统一社会信用代码' }).getAttribute('placeholder'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '提交资料' }));
    expect(await screen.findByText('请填写主体名称', {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('请填写统一社会信用代码', {}, { timeout: 5000 })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('.ant-form-item-has-error')).not.toBeNull();
  });

  it('validates amount format, resets filters, and exports money ledger', async () => {
    const load = vi.fn(async () => moneyPage([]));
    const exportFile = vi.fn(async () => ({
      filename: 'geomix-money.csv',
      mime: 'text/csv',
      body: new Uint8Array([1, 2]),
    }));
    render(<MoneyScreen title="余额明细" load={load} exportFile={exportFile} />);
    expect(await screen.findByText('没有找到匹配的记录')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '金额' }), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    expect(await screen.findByText('金额格式不正确')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.queryByText('金额格式不正确')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(exportFile).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), 'csv');
  });
});
