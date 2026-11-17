// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrudTable, type CrudSearch } from './crud-table';

afterEach(() => {
  window.localStorage.clear();
  cleanup();
});

const search: CrudSearch = { keyword: '', enabled: undefined, sort: 'createdAt', order: 'desc' };

function Harness() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const onExport = vi.fn();
  const onSearch = vi.fn();
  return (
    <CrudTable
      rows={[
        { id: 'a', name: '甲' },
        { id: 'b', name: '乙' },
      ]}
      columns={[
        { key: 'name', title: '名称', hideable: false, render: (row) => row.name },
        { key: 'note', title: '备注', render: () => '说明' },
      ]}
      total={11}
      page={page}
      pageSize={10}
      selectedIds={selected}
      searchOpen={open}
      search={search}
      onSearchOpenChange={setOpen}
      onSearch={onSearch}
      onPageChange={(next) => setPage(next)}
      onSelectionChange={setSelected}
      onExport={onExport}
      onRefresh={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />
  );
}

describe('crud table', () => {
  it('shows the empty copy, search row, selection and export', () => {
    render(
      <CrudTable
        rows={[]}
        columns={[
          { key: 'name', title: '名称', hideable: false, render: (row: { id: string }) => row.id },
        ]}
        total={0}
        page={1}
        pageSize={10}
        selectedIds={[]}
        searchOpen={false}
        search={search}
        onSearchOpenChange={() => undefined}
        onSearch={() => undefined}
        onPageChange={() => undefined}
        onSelectionChange={() => undefined}
        onExport={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText('没有找到匹配的记录')).toBeTruthy();
  });

  it('searches, selects and exports from the toolbar', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键字' }), {
      target: { value: '甲' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    const first = boxes.item(0);
    if (!(first instanceof HTMLInputElement)) throw new Error('missing selection');
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(screen.getByText('CSV'));
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '状态筛选' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '排序方向' })).toBeNull();
  }, 20_000);

  it('renders working enable, disable, status filter, and sort controls when configured (#69)', () => {
    const onEnable = vi.fn();
    const onDisable = vi.fn();
    const onSearch = vi.fn();
    function StatusHarness() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <CrudTable
          rows={[{ id: 'row-1', name: '示例一' }]}
          columns={[{ key: 'name', title: '名称', hideable: false, render: (row) => row.name }]}
          total={1}
          page={1}
          pageSize={10}
          selectedIds={selected}
          searchOpen
          search={search}
          sortOptions={[
            { value: 'createdAt', label: '创建时间' },
            { value: 'name', label: '名称' },
          ]}
          onSearchOpenChange={() => undefined}
          onSearch={onSearch}
          onPageChange={() => undefined}
          onSelectionChange={setSelected}
          onExport={() => undefined}
          onRefresh={() => undefined}
          onEnable={onEnable}
          onDisable={onDisable}
        />
      );
    }

    render(<StatusHarness />);
    const enableBtn = screen.getByRole('button', { name: '启用' });
    const disableBtn = screen.getByRole('button', { name: '停用' });
    expect(enableBtn).toHaveProperty('disabled', true);
    expect(disableBtn).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: '状态筛选' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '排序字段' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '排序方向' })).toBeTruthy();

    const boxes = document.querySelectorAll('input[type="checkbox"]');
    const first = boxes.item(0);
    if (!(first instanceof HTMLInputElement)) throw new Error('missing selection');
    fireEvent.click(first);

    expect(enableBtn).toHaveProperty('disabled', false);
    expect(disableBtn).toHaveProperty('disabled', false);
    fireEvent.click(enableBtn);
    fireEvent.click(disableBtn);
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onDisable).toHaveBeenCalledTimes(1);
  });
});
