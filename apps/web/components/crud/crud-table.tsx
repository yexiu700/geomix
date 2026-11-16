'use client';

import {
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  type CrudOrder,
  type CrudPageSize,
} from '@geomix/shared';
import { Button, Checkbox, Dropdown, Input, Select, Space, Table } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';

export type CrudColumn<T> = {
  key: string;
  title: string;
  width?: number;
  hideable?: boolean;
  render: (row: T, index: number) => ReactNode;
};

export type CrudSearch = {
  keyword: string;
  enabled: boolean | undefined;
  sort: string;
  order: CrudOrder;
};

export function CrudTable<T extends { id: string }>({
  rows,
  columns,
  total,
  page,
  pageSize,
  loading = false,
  selectedIds,
  searchOpen,
  search,
  sortOptions,
  emptyText = CRUD_EMPTY_TEXT,
  writeDisabled = false,
  onSearchOpenChange,
  onSearch,
  onPageChange,
  onSelectionChange,
  onExport,
  onRefresh,
  onCreate,
  onDelete,
  onEnable,
  onDisable,
  onBack,
}: {
  rows: T[];
  columns: CrudColumn<T>[];
  total: number;
  page: number;
  pageSize: CrudPageSize;
  loading?: boolean;
  selectedIds: string[];
  searchOpen: boolean;
  search: CrudSearch;
  sortOptions?: { value: string; label: string }[];
  emptyText?: string;
  writeDisabled?: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onSearch: (search: CrudSearch) => void;
  onPageChange: (page: number, pageSize: CrudPageSize) => void;
  onSelectionChange: (ids: string[]) => void;
  onExport: (format: 'csv' | 'xlsx') => void;
  onRefresh: () => void;
  onCreate?: () => void;
  onDelete?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onBack?: () => void;
}) {
  const [compact, setCompact] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [draft, setDraft] = useState(search);
  const appliedKeyword = search.keyword;
  const appliedEnabled = search.enabled;
  const appliedSort = search.sort;
  const appliedOrder = search.order;
  useEffect(() => {
    setDraft({
      keyword: appliedKeyword,
      enabled: appliedEnabled,
      sort: appliedSort,
      order: appliedOrder,
    });
  }, [appliedKeyword, appliedEnabled, appliedSort, appliedOrder]);
  const selected = selectedIds.length > 0;
  const visible = columns.filter(
    (column) => column.hideable === false || !hidden.includes(column.key),
  );

  return (
    <div className="gm-crud">
      <div className="gm-crud-toolbar">
        <Space wrap>
          <Button aria-label="刷新" onClick={onRefresh}>
            刷新
          </Button>
          <Button
            aria-label="添加"
            type="primary"
            disabled={writeDisabled || !onCreate}
            onClick={onCreate}
          >
            添加
          </Button>
          <Button
            aria-label="删除"
            danger
            disabled={writeDisabled || !selected || !onDelete}
            onClick={onDelete}
          >
            删除
          </Button>
          <Button
            aria-label="启用"
            disabled={writeDisabled || !selected || !onEnable}
            onClick={onEnable}
          >
            启用
          </Button>
          <Button
            aria-label="停用"
            disabled={writeDisabled || !selected || !onDisable}
            onClick={onDisable}
          >
            停用
          </Button>
          {onBack ? (
            <Button aria-label="返回上一级" onClick={onBack}>
              返回上一级
            </Button>
          ) : null}
        </Space>
        <Space wrap>
          <Button aria-label="切换" onClick={() => setCompact((value) => !value)}>
            切换
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: columns
                .filter((column) => column.hideable !== false)
                .map((column) => ({
                  key: column.key,
                  label: (
                    <Checkbox
                      checked={!hidden.includes(column.key)}
                      onChange={(event) => {
                        setHidden((current) =>
                          event.target.checked
                            ? current.filter((key) => key !== column.key)
                            : [...current, column.key],
                        );
                      }}
                    >
                      {column.title}
                    </Checkbox>
                  ),
                })),
            }}
          >
            <Button aria-label="列">列</Button>
          </Dropdown>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'csv', label: 'CSV' },
                { key: 'xlsx', label: 'Excel' },
              ],
              onClick: ({ key }) => onExport(key === 'xlsx' ? 'xlsx' : 'csv'),
            }}
          >
            <Button aria-label="导出">导出</Button>
          </Dropdown>
          <Button aria-label="搜索" onClick={() => onSearchOpenChange(!searchOpen)}>
            搜索
          </Button>
        </Space>
      </div>
      {searchOpen ? (
        <div className="gm-crud-search">
          <Input
            aria-label="搜索关键字"
            value={draft.keyword}
            placeholder="名称或备注"
            onChange={(event) =>
              setDraft((current) => ({ ...current, keyword: event.target.value }))
            }
          />
          <Select
            aria-label="状态筛选"
            value={draft.enabled === undefined ? 'all' : draft.enabled ? 'on' : 'off'}
            style={{ width: 120 }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                enabled: value === 'on' ? true : value === 'off' ? false : undefined,
              }))
            }
          />
          {sortOptions ? (
            <Select
              aria-label="排序字段"
              value={draft.sort}
              style={{ width: 140 }}
              options={sortOptions}
              onChange={(value) => setDraft((current) => ({ ...current, sort: value }))}
            />
          ) : null}
          <Select
            aria-label="排序方向"
            value={draft.order}
            style={{ width: 100 }}
            options={[
              { value: 'desc', label: '降序' },
              { value: 'asc', label: '升序' },
            ]}
            onChange={(value) =>
              setDraft((current) => ({ ...current, order: value === 'asc' ? 'asc' : 'desc' }))
            }
          />
          <Button
            aria-label="查询"
            type="primary"
            onClick={() => onSearch({ ...draft, keyword: draft.keyword.trim() })}
          >
            查询
          </Button>
          <Button
            aria-label="清空"
            onClick={() => {
              const cleared = { ...search, keyword: '', enabled: undefined };
              setDraft(cleared);
              onSearch(cleared);
            }}
          >
            清空
          </Button>
        </div>
      ) : null}
      <Table<T>
        rowKey="id"
        size={compact ? 'small' : 'middle'}
        loading={loading}
        dataSource={rows}
        locale={{ emptyText }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: CRUD_PAGE_SIZES.map(String),
          onChange: (nextPage, nextSize) => {
            const size = normalizePageSize(nextSize);
            onPageChange(size === pageSize ? nextPage : 1, size);
          },
        }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => onSelectionChange(keys.map(String)),
        }}
        columns={visible.map((column) => ({
          key: column.key,
          dataIndex: column.key,
          title: column.title,
          width: column.width,
          render: (_value: unknown, row: T, index: number) => column.render(row, index),
        }))}
      />
    </div>
  );
}

function normalizePageSize(value: number): CrudPageSize {
  if (value === 25 || value === 50) return value;
  return 10;
}
