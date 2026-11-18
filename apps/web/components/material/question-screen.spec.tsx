// @vitest-environment jsdom

import type { QuestionBatchCreateInput, QuestionListQuery } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionGateway } from '../../lib/questions';
import type { ShellAction } from '../../lib/tab-stack';
import { QuestionScreen } from './question-screen';

afterEach(() => {
  cleanup();
});

function createGatewayMock(): QuestionGateway & {
  queries: QuestionListQuery[];
  batchPayloads: QuestionBatchCreateInput[];
  updated: Array<{ id: string; text: string }>;
  deletedIds: string[][];
} {
  const queries: QuestionListQuery[] = [];
  const batchPayloads: QuestionBatchCreateInput[] = [];
  const updated: Array<{ id: string; text: string }> = [];
  const deletedIds: string[][] = [];

  return {
    queries,
    batchPayloads,
    updated,
    deletedIds,
    async list(query) {
      queries.push(query);
      const all = [
        {
          id: 'q_1',
          keywordId: 'kw_1',
          keywordMain: '工业机器人',
          text: '工业机器人哪家服务好？',
          source: 'AI' as const,
          usedCount: 0,
          included: false,
          createdAt: '2026-11-17T03:00:00.000Z',
        },
        {
          id: 'q_2',
          keywordId: 'kw_2',
          keywordMain: '激光切割机',
          text: '光纤激光切割机报价指南',
          source: 'MANUAL' as const,
          usedCount: 1,
          included: false,
          createdAt: '2026-11-17T03:10:00.000Z',
        },
      ];
      const items = query.keywordId ? all.filter((q) => q.keywordId === query.keywordId) : all;
      return {
        items,
        total: items.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
    async listKeywords() {
      return [
        {
          id: 'kw_1',
          main: '工业机器人',
          brands: ['智造星'],
          optStatus: 'NONE',
          questionCount: 1,
          createdAt: '2026-11-17T03:00:00.000Z',
        },
        {
          id: 'kw_2',
          main: '激光切割机',
          brands: ['智造星'],
          optStatus: 'NONE',
          questionCount: 1,
          createdAt: '2026-11-17T03:05:00.000Z',
        },
      ];
    },
    async batchCreate(payload) {
      batchPayloads.push(payload);
      return {
        createdCount: 2,
        skippedCount: 1,
        items: [],
      };
    },
    async update(id, payload) {
      updated.push({ id, text: payload.text });
      return {
        id,
        keywordId: 'kw_2',
        keywordMain: '激光切割机',
        text: payload.text,
        source: 'MANUAL',
        usedCount: 1,
        included: false,
        createdAt: '2026-11-17T03:10:00.000Z',
      };
    },
    async bulkDelete(ids) {
      deletedIds.push(ids);
      return { affected: ids.length };
    },
    async download() {
      return { filename: 'questions.csv', mime: 'text/csv', body: new Uint8Array() };
    },
  };
}

function findBtnNow(pattern: string | RegExp): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll('button'));
  return (
    buttons.find((btn) => {
      const aria = btn.getAttribute('aria-label') ?? '';
      const compact = (btn.textContent ?? '').replace(/\s+/g, '');
      const raw = (btn.textContent ?? '').trim();
      if (typeof pattern === 'string') {
        const target = pattern.replace(/\s+/g, '');
        return aria === pattern || compact === target || raw.includes(pattern);
      }
      return pattern.test(raw) || pattern.test(compact) || pattern.test(aria);
    }) ?? null
  );
}

async function clickBtn(pattern: string | RegExp): Promise<void> {
  let found: HTMLButtonElement | null = null;
  await waitFor(() => {
    found = findBtnNow(pattern);
    expect(found).not.toBeNull();
  });
  fireEvent.click(found!);
}

describe('QuestionScreen', () => {
  it('auto-filters and preselects keywordId when opened with ?keywordId=, and dispatches back on 返回上一级', async () => {
    const gateway = createGatewayMock();
    const dispatched: ShellAction[] = [];
    render(
      <QuestionScreen
        title="写作标题 · 激光切割机"
        tabId="/material/questions?keywordId=kw_2"
        href="/material/questions?keywordId=kw_2"
        gateway={gateway}
        onDispatch={(action) => dispatched.push(action)}
      />,
    );

    await screen.findByText('光纤激光切割机报价指南');
    expect(gateway.queries[0]?.keywordId).toBe('kw_2');
    expect(screen.queryByText('工业机器人哪家服务好？')).toBeNull();

    // Open Add modal -> keywordId is already preselected to kw_2!
    await clickBtn('添加');
    fireEvent.change(screen.getByLabelText('拓展问题'), {
      target: { value: '厚板激光切割机参数\n厚板激光切割机参数\n深圳激光切割机厂家' },
    });
    await clickBtn('确定');
    await waitFor(() => expect(gateway.batchPayloads).toHaveLength(1));
    expect(gateway.batchPayloads[0]?.keywordId).toBe('kw_2');

    // Click 返回上一级
    await clickBtn('返回上一级');
    expect(dispatched).toContainEqual({
      type: 'back',
      id: '/material/questions?keywordId=kw_2',
    });
  });

  it('validates missing keyword selection on plain /material/questions, edits single question, and deletes with confirmation', async () => {
    const gateway = createGatewayMock();
    render(
      <QuestionScreen
        title="写作标题"
        tabId="/material/questions"
        href="/material/questions"
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人哪家服务好？');
    await clickBtn('添加');
    await clickBtn('确定');
    expect(await screen.findByText('请选择蒸馏主词')).toBeTruthy();
    await clickBtn('关闭');

    // Edit first row
    await clickBtn('编辑');
    fireEvent.change(screen.getByLabelText('问题内容'), {
      target: { value: '六轴工业机器人哪家售后服务靠谱？' },
    });
    await clickBtn('确定');
    await waitFor(() =>
      expect(gateway.updated).toContainEqual({
        id: 'q_1',
        text: '六轴工业机器人哪家售后服务靠谱？',
      }),
    );

    // Delete row
    const rowDeleteBtns = Array.from(document.querySelectorAll('td button')).filter((b) =>
      (b.textContent ?? '').replace(/\s+/g, '').includes('删除'),
    );
    fireEvent.click(rowDeleteBtns[0]!);
    await clickBtn('确认删除');
    await waitFor(() => expect(gateway.deletedIds).toContainEqual(['q_1']));
  });

  it('enforces create-first toolbar, link action buttons, required * markers, [取消, 重置, 确定] footer order, and ESC close (#141)', async () => {
    const gateway = createGatewayMock();
    render(
      <QuestionScreen
        title="写作标题"
        tabId="/material/questions"
        href="/material/questions"
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人哪家服务好？');

    // Toolbar order: 添加 before 刷新 before 删除
    const toolbarBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((b) => (b.textContent ?? '').replace(/\s+/g, ''));
    expect(toolbarBtns.slice(0, 3)).toEqual(['添加', '刷新', '删除']);

    // Action column buttons are uniform ant-btn-link ant-btn-sm
    const firstRowBtns = Array.from(
      document.querySelectorAll('tbody tr:first-child td:last-child button'),
    );
    expect(firstRowBtns.map((b) => (b.textContent ?? '').replace(/\s+/g, ''))).toEqual([
      '编辑',
      '删除',
    ]);
    for (const btn of firstRowBtns) {
      expect(btn.classList.contains('ant-btn-link')).toBe(true);
      expect(btn.classList.contains('ant-btn-sm')).toBe(true);
    }

    // Add modal: required *, [取消, 重置, 确定], reset clears validation error, ESC closes
    await clickBtn('添加');
    const addDialog = screen.getByRole('dialog', { name: '添加写作标题' });
    expect(addDialog.textContent).toContain('* 蒸馏主词');
    expect(addDialog.textContent).toContain('* 拓展问题');
    const addFooterBtns = Array.from(addDialog.querySelectorAll('.gm-crud-footer button')).map(
      (b) => (b.textContent ?? '').replace(/\s+/g, ''),
    );
    expect(addFooterBtns).toEqual(['取消', '重置', '确定']);

    await clickBtn('确定');
    expect(await screen.findByText('请选择蒸馏主词')).toBeTruthy();
    await clickBtn('重置');
    expect(screen.queryByText('请选择蒸馏主词')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '添加写作标题' })).toBeNull();
    });

    // Edit modal: required *, [取消, 重置, 确定], and ESC closes
    await clickBtn('编辑');
    const editDialog = screen.getByRole('dialog', { name: '编辑写作标题' });
    expect(editDialog.textContent).toContain('* 问题内容');
    const editFooterBtns = Array.from(editDialog.querySelectorAll('.gm-crud-footer button')).map(
      (b) => (b.textContent ?? '').replace(/\s+/g, ''),
    );
    expect(editFooterBtns).toEqual(['取消', '重置', '确定']);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑写作标题' })).toBeNull();
    });
  });

  it('refreshes keyword dropdown when returning to /material/questions tab (#215)', async () => {
    const gateway = createGatewayMock();
    let added = false;
    gateway.listKeywords = async () => [
      {
        id: 'kw_1',
        main: '工业机器人',
        brands: ['星图'],
        optStatus: 'NONE',
        questionCount: 2,
        createdAt: '2026-11-13T00:00:00.000Z',
        updatedAt: '2026-11-13T00:00:00.000Z',
      },
      ...(added
        ? [
            {
              id: 'kw_3',
              main: 'Anker氮化镓充电器',
              brands: ['Anker'],
              optStatus: 'NONE' as const,
              questionCount: 0,
              createdAt: '2026-11-18T00:00:00.000Z',
              updatedAt: '2026-11-18T00:00:00.000Z',
            },
          ]
        : []),
    ];

    const view = render(
      <QuestionScreen
        title="写作标题"
        tabId="/material/questions"
        href="/material/questions"
        active={true}
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await screen.findByText('工业机器人哪家服务好？');

    view.rerender(
      <QuestionScreen
        title="写作标题"
        tabId="/material/questions"
        href="/material/questions"
        active={false}
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );
    added = true;
    view.rerender(
      <QuestionScreen
        title="写作标题"
        tabId="/material/questions"
        href="/material/questions"
        active={true}
        gateway={gateway}
        onDispatch={vi.fn()}
      />,
    );

    await clickBtn('添加');
    const keywordSelect = screen.getByRole('combobox', { name: '蒸馏主词' });
    fireEvent.mouseDown(keywordSelect);
    await waitFor(() => {
      expect(screen.getByText('Anker氮化镓充电器')).toBeTruthy();
    });
  });
});
