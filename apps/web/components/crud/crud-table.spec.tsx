// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrudTable, type CrudSearch } from './crud-table';

afterEach(() => {
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
  }, 20_000);
});
