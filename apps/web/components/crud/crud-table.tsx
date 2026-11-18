'use client';

import {
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  type CrudOrder,
  type CrudPageSize,
} from '@geomix/shared';
import { Button, Checkbox, Dropdown, Input, Select, Space, Table } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { ExportAction } from './export-action';

export type CrudColumn<T> = {
  key: string;
  title: string;
  width?: number;
  fixed?: 'left' | 'right';
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
  searchPlaceholder = '输入关键词搜索',
  sortOptions,
  statusFilter,
  emptyText = CRUD_EMPTY_TEXT,
  writeDisabled = false,
  toolbarOrder = 'default',
  storageKey,
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
  searchPlaceholder?: string;
  sortOptions?: { value: string; label: string }[];
  statusFilter?: boolean;
  emptyText?: string;
  writeDisabled?: boolean;
  toolbarOrder?: 'default' | 'create-first';
  storageKey?: string;
  onSearchOpenChange: (open: boolean) => void;
  onSearch: (search: CrudSearch) => void;
  onPageChange: (page: number, pageSize: CrudPageSize) => void;
  onSelectionChange: (ids: string[]) => void;
  onExport: (format: 'csv' | 'xlsx') => void | Promise<void>;
  onRefresh: () => void;
  onCreate?: () => void;
  onDelete?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onBack?: () => void;
}) {
  const resolvedKey =
    storageKey ??
    (typeof window !== 'undefined'
      ? `geomix.crud.table:${window.location.pathname}`
      : 'geomix.crud.table:default');

  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const raw = window.localStorage.getItem(resolvedKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { compact?: unknown };
      return parsed.compact === true;
    } catch {
      return false;
    }
  });
  const [hidden, setHidden] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(resolvedKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { hidden?: unknown };
      return Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((k): k is string => typeof k === 'string')
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(resolvedKey, JSON.stringify({ compact, hidden }));
    } catch {
      return;
    }
  }, [resolvedKey, compact, hidden]);

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
  const showStatusFilter = statusFilter ?? Boolean(onEnable || onDisable);
  const showSortControls = Boolean(sortOptions && sortOptions.length > 0);
  const visible = columns.filter(
    (column) => column.hideable === false || !hidden.includes(column.key),
  );

  const submitSearch = () => {
    onSearch({ ...draft, keyword: draft.keyword.trim() });
  };

  const refreshBtn = (
    <Button key="refresh" aria-label="刷新" onClick={onRefresh}>
      刷新
    </Button>
  );
  const createBtn = (
    <Button
      key="create"
      aria-label="添加"
      type="primary"
      disabled={writeDisabled || !onCreate}
      onClick={onCreate}
    >
      添加
    </Button>
  );

  return (
    <div className="gm-crud">
      <div className="gm-crud-toolbar">
        <Space wrap>
          {toolbarOrder === 'create-first' ? [createBtn, refreshBtn] : [refreshBtn, createBtn]}
          <Button
            aria-label="删除"
            danger
            disabled={writeDisabled || !selected || !onDelete}
            onClick={onDelete}
          >
            删除
          </Button>
          {onEnable ? (
            <Button aria-label="启用" disabled={writeDisabled || !selected} onClick={onEnable}>
              启用
            </Button>
          ) : null}
          {onDisable ? (
            <Button aria-label="停用" disabled={writeDisabled || !selected} onClick={onDisable}>
              停用
            </Button>
          ) : null}
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
          <ExportAction empty={!loading && total === 0 && rows.length === 0} onExport={onExport} />
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
            placeholder={searchPlaceholder}
            style={{ width: 240, maxWidth: '100%' }}
            onChange={(event) =>
              setDraft((current) => ({ ...current, keyword: event.target.value }))
            }
            onPressEnter={submitSearch}
          />
          {showStatusFilter ? (
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
          ) : null}
          {showSortControls && sortOptions ? (
            <>
              <Select
                aria-label="排序字段"
                value={draft.sort}
                style={{ width: 140 }}
                options={sortOptions}
                onChange={(value) => setDraft((current) => ({ ...current, sort: value }))}
              />
              <Select
                aria-label="排序方向"
                value={draft.order}
                style={{ width: 100 }}
                options={[
                  { value: 'desc', label: '降序' },
                  { value: 'asc', label: '升序' },
                ]}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    order: value === 'asc' ? 'asc' : 'desc',
                  }))
                }
              />
            </>
          ) : null}
          <Button aria-label="查询" type="primary" onClick={submitSearch}>
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
          showTotal: (count) => `共 ${count} 条`,
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
          fixed: column.fixed,
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
