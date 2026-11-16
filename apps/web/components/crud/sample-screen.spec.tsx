// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleGateway, SampleRecord } from '../../lib/samples';
import { SampleScreen } from './sample-screen';

afterEach(() => {
  cleanup();
});

function row(name: string): SampleRecord {
  return {
    id: 'c'.repeat(24),
    name,
    note: '备注',
    enabled: true,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T01:02:00.000Z',
  };
}

function gateway(partial: Partial<SampleGateway> = {}): SampleGateway {
  return {
    list: vi.fn(async () => ({ items: [row('示例甲')], total: 1, page: 1, pageSize: 10 })),
    create: vi.fn(async (input) => ({
      ...row(input.name),
      note: input.note,
      enabled: input.enabled,
    })),
    update: vi.fn(async (_id, input) => ({
      ...row(input.name),
      note: input.note,
      enabled: input.enabled,
    })),
    bulk: vi.fn(async () => ({ affected: 1 })),
    prices: vi.fn(async () => [
      { action: 'ai_write', unitPoints: 10, enabled: true, label: 'AI写作' },
    ]),
    download: vi.fn(async () => ({
      filename: 'geomix-samples.csv',
      mime: 'text/csv',
      body: new Uint8Array(),
    })),
    ...partial,
  };
}

describe('sample screen', () => {
  it('creates a row from the price button without charging', async () => {
    const client = gateway();
    render(<SampleScreen title="列表示例" gateway={client} />);
    expect(await screen.findByText('示例甲')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI写作（10点数/篇）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'AI写作（10点数/篇）' }).at(-1)!);
    expect((await screen.findAllByText('请填写名称')).length).toBeGreaterThan(0);
    expect(client.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), {
      target: { value: '新示例' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'AI写作（10点数/篇）' }).at(-1)!);
    expect(client.create).toHaveBeenCalledWith({ name: '新示例', note: '', enabled: true });
  }, 15_000);

  it('docks and expands the editor, and blocks writes when read only', async () => {
    const client = gateway({
      list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10 })),
    });
    const view = render(<SampleScreen title="列表示例" gateway={client} />);
    expect(await screen.findByText('没有找到匹配的记录')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '最小化' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '还原弹层' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化' }));
    expect(document.querySelector('.gm-crud-mask.max')).toBeTruthy();
    view.rerender(<SampleScreen title="列表示例" readOnly gateway={client} />);
    expect(screen.getByRole('button', { name: '添加' })).toHaveProperty('disabled', true);
  }, 15_000);

  it('shows the API error and deletes only the selected rows', async () => {
    const client = gateway({
      list: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const failing = render(<SampleScreen title="列表示例" gateway={client} />);
    expect(await screen.findByText('无法连接接口')).toBeTruthy();
    failing.unmount();

    const ready = gateway();
    render(<SampleScreen title="列表示例" gateway={ready} />);
    expect(await screen.findByText('示例甲')).toBeTruthy();
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    const box = boxes.item(0);
    if (!(box instanceof HTMLInputElement)) throw new Error('missing selection');
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(ready.bulk).toHaveBeenCalledWith('delete', ['c'.repeat(24)]);
  }, 15_000);
});
