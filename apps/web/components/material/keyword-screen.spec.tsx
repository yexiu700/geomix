// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeywordGateway } from '../../lib/keywords';
import type { ShellAction } from '../../lib/tab-stack';
import { KeywordScreen } from './keyword-screen';

function createGatewayMock(): KeywordGateway & {
  createdPayloads: unknown[];
  distillCalls: number;
} {
  const createdPayloads: unknown[] = [];
  let distillCalls = 0;
  return {
    createdPayloads,
    get distillCalls() {
      return distillCalls;
    },
    async list() {
      return {
        items: [
          {
            id: 'kw_1',
            main: '工业机器人',
            brands: ['智造甲'],
            optStatus: 'NONE',
            questionCount: 6,
            createdAt: '2026-11-17T03:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      };
    },
    async one(id) {
      return {
        id,
        main: '工业机器人',
        brands: ['智造甲'],
        optStatus: 'NONE',
        questionCount: 1,
        createdAt: '2026-11-17T03:00:00.000Z',
        questions: [
          {
            id: 'q_1',
            text: '工业机器人哪家靠谱？',
            source: 'MANUAL',
            included: false,
            usedCount: 0,
            createdAt: '2026-11-17T03:00:00.000Z',
          },
        ],
      };
    },
    async create(payload) {
      createdPayloads.push(payload);
      return {
        keyword: {
          id: 'kw_2',
          main: payload.main,
          brands: ['智造乙'],
          optStatus: 'NONE',
          questionCount: 24,
          createdAt: '2026-11-17T03:10:00.000Z',
        },
        addedQuestions: 24,
        skippedDuplicates: 0,
      };
    },
    async update(_id, payload) {
      return {
        keyword: {
          id: 'kw_1',
          main: payload.main,
          brands: [],
          optStatus: 'NONE',
          questionCount: 2,
          createdAt: '2026-11-17T03:00:00.000Z',
        },
        addedQuestions: 1,
        removedQuestions: 0,
        skippedDuplicates: 0,
      };
    },
    async bulkDelete(ids) {
      return { affected: ids.length };
    },
    async distill() {
      distillCalls += 1;
      return {
        questions: [
          '激光切割机哪家服务靠谱？',
          '激光切割机一般多少钱？',
          '定制激光切割机需要注意什么？',
          '源头激光切割机厂家盘点',
          '企业采购激光切割机选型指南',
        ],
        charged: 10,
        shadow: true,
      };
    },
    async prices() {
      return [{ action: 'distill', unitPoints: 10, enabled: true, label: 'AI蒸馏' }];
    },
    async download() {
      return { filename: 'keywords.csv', mime: 'text/csv', body: new Uint8Array() };
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('KeywordScreen', () => {
  it('shows 请输入主训练词 on empty submit and drills down to /material/questions?keywordId=...', async () => {
    const gateway = createGatewayMock();
    const dispatched: ShellAction[] = [];
    render(
      <KeywordScreen
        title="关键词"
        tabId="/material/keywords"
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    await screen.findByText('工业机器人');
    fireEvent.click(screen.getByRole('button', { name: '查看写作标题' }));
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/material/questions?keywordId=kw_1',
      sourceId: '/material/keywords',
    });

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(await screen.findByText('请输入主训练词')).toBeTruthy();
  });

  it('previews 3×2×4 = 24 combos and reports invalid main line numbers', async () => {
    const gateway = createGatewayMock();
    render(
      <KeywordScreen
        title="关键词"
        tabId="/material/keywords"
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('主关键词'), { target: { value: '激光切割机' } });

    fireEvent.click(screen.getByRole('button', { name: '手动批量添加' }));
    fireEvent.change(screen.getByLabelText('组合前缀'), {
      target: { value: '深圳\n苏州\n定制' },
    });
    fireEvent.change(screen.getByLabelText('组合主词'), {
      target: { value: '激光切割机\n无关折弯设备' },
    });
    fireEvent.change(screen.getByLabelText('组合后缀'), {
      target: { value: '哪家好\n厂家\n报价\n推荐' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成组合预览' }));
    expect((await screen.findAllByText(/第 2 行主词必须包含主训练词/)).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('组合主词'), {
      target: { value: '激光切割机\n光纤激光切割机' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成组合预览' }));
    const addPreviewBtn = await screen.findByRole('button', {
      name: /添加到问题框（已选 24 条）/,
    });
    fireEvent.click(addPreviewBtn);

    const textarea = screen.getByLabelText('一行一个拓展问题') as HTMLTextAreaElement;
    expect(textarea.value.split('\n')).toHaveLength(24);
  });

  it('supports free expander word packs without calling AI distill', async () => {
    const gateway = createGatewayMock();
    render(
      <KeywordScreen
        title="关键词"
        tabId="/material/keywords"
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('主关键词'), { target: { value: '激光切割机' } });

    fireEvent.click(screen.getByRole('button', { name: '拓词工具' }));
    fireEvent.click(screen.getByRole('button', { name: '生成预览并回填当前表单' }));
    const expanderPreviewBtn = await screen.findByRole('button', {
      name: /添加到问题框/,
    });
    fireEvent.click(expanderPreviewBtn);
    expect(gateway.distillCalls).toBe(0);
    const textarea = screen.getByLabelText('一行一个拓展问题') as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);
  });

  it('requires fee confirmation before AI distill and previews candidates before saving', async () => {
    const gateway = createGatewayMock();
    render(
      <KeywordScreen
        title="关键词"
        tabId="/material/keywords"
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('主关键词'), { target: { value: '激光切割机' } });

    fireEvent.click(screen.getByRole('button', { name: 'AI蒸馏拓展（10点/次）' }));
    const confirmDistillBtn = await screen.findByRole('button', {
      name: /确认蒸馏（10点\/次）/,
    });
    expect(gateway.distillCalls).toBe(0);
    fireEvent.click(confirmDistillBtn);
    await waitFor(() => expect(gateway.distillCalls).toBe(1));

    const distillAddBtn = await screen.findByRole('button', {
      name: /添加到问题框（已选 5 条）/,
    });
    fireEvent.click(distillAddBtn);

    const textarea = screen.getByLabelText('一行一个拓展问题') as HTMLTextAreaElement;
    expect(textarea.value).toContain('激光切割机哪家服务靠谱？');

    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(gateway.createdPayloads).toHaveLength(1));
  });
});
