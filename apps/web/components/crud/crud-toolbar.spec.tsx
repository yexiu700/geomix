// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrudToolbar } from './crud-toolbar';

afterEach(() => {
  cleanup();
});

describe('CrudToolbar foundation (#260)', () => {
  it('renders [主创建] [刷新] [删除] [extraLeft] on the left and [right] on the right', () => {
    const onCreate = vi.fn();
    const onRefresh = vi.fn();
    const onDelete = vi.fn();

    render(
      <CrudToolbar
        createLabel="新建单篇复刻"
        refreshLabel="刷新"
        deleteLabel="删除"
        onCreate={onCreate}
        onRefresh={onRefresh}
        onDelete={onDelete}
        extraLeft={<button type="button">批量设为正常</button>}
        right={<button type="button">导出</button>}
      />,
    );

    const leftBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((btn) => (btn.textContent ?? '').replace(/\s+/g, ''));
    expect(leftBtns).toEqual(['新建单篇复刻', '刷新', '删除', '批量设为正常']);

    const rightBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:last-child button'),
    ).map((btn) => (btn.textContent ?? '').replace(/\s+/g, ''));
    expect(rightBtns).toEqual(['导出']);

    fireEvent.click(screen.getByRole('button', { name: '新建单篇复刻' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('omits create and delete buttons cleanly when showCreate/showDelete are false', () => {
    const onRefresh = vi.fn();

    render(<CrudToolbar showCreate={false} showDelete={false} onRefresh={onRefresh} />);

    const leftBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((btn) => (btn.textContent ?? '').replace(/\s+/g, ''));
    expect(leftBtns).toEqual(['刷新']);
  });
});
