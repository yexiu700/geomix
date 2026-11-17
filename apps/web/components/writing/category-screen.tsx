'use client';

import {
  API_ERROR,
  articleCategoryInputSchema,
  type ArticleCategoryInput,
  type CategoryListQuery,
  type CategorySort,
} from '@geomix/shared';
import { Alert, Button, Input, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { CategoryApiError, httpCategoryGateway, type CategoryGateway } from '../../lib/categories';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable } from '../crud/crud-table';

const EMPTY: ArticleCategoryInput = { name: '' };

type Editor = {
  mode: 'create' | 'edit';
  id?: string;
  initial: ArticleCategoryInput;
  draft: ArticleCategoryInput;
  minimized: boolean;
  maximized: boolean;
};

export function CategoryScreen({
  title,
  tabId,
  readOnly = false,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  readOnly?: boolean;
  gateway?: CategoryGateway;
  storage?: SessionStorageLike;
  onDispatch: (action: ShellAction) => void;
}) {
  const client = useMemo(
    () => gateway ?? httpCategoryGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );
  const [query, setQuery] = useState<CategoryListQuery>({
    page: 1,
    pageSize: 10,
    sort: 'createdAt',
    order: 'desc',
    keyword: '',
    export: undefined,
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [rows, setRows] = useState<Awaited<ReturnType<CategoryGateway['list']>>['items']>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [locked, setLocked] = useState(false);
  const writeLocked = readOnly || locked;

  useEffect(() => {
    let live = true;
    setLoading(true);
    void client.list(query).then(
      (page) => {
        if (!live) return;
        setRows(page.items);
        setTotal(page.total);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(messageOf(reason));
        noteLock(reason, setLocked);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, query, reloadKey]);

  async function save(): Promise<void> {
    if (!editor || saving || writeLocked) return;
    setSubmitted(true);
    const parsed = articleCategoryInputSchema.safeParse(editor.draft);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? '参数错误');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editor.mode === 'create') await client.create(parsed.data);
      else if (editor.id) await client.update(editor.id, parsed.data);
      setEditor(null);
      setSubmitted(false);
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setFormError(messageOf(reason));
      noteLock(reason, setLocked);
    } finally {
      setSaving(false);
    }
  }

  async function removeSelected(): Promise<void> {
    if (writeLocked || selectedIds.length === 0) return;
    setError(null);
    try {
      await client.remove(selectedIds);
      setSelectedIds([]);
      setConfirmDelete(false);
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setConfirmDelete(false);
      setError(messageOf(reason));
      noteLock(reason, setLocked);
    }
  }

  async function download(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      const file = await client.download(query, format);
      const bytes = file.body.buffer.slice(
        file.body.byteOffset,
        file.body.byteOffset + file.body.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([bytes], { type: file.mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  const nameError = submitted ? fieldError(editor?.draft.name ?? '') : null;

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        分类只属于当前账号。文章数量和文章剩余量按文章实时统计，剩余量是状态为正常且发送次数为 0
        的文章数。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <CrudTable
        rows={rows}
        total={total}
        page={query.page}
        pageSize={query.pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        writeDisabled={writeLocked}
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'name', label: '分组名' },
          { value: 'total', label: '文章数量' },
          { value: 'remaining', label: '文章剩余量' },
        ]}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((current) => ({
            ...current,
            page: 1,
            keyword: search.keyword,
            sort: asSort(search.sort),
            order: search.order,
          }));
        }}
        onPageChange={(page, pageSize) => {
          setSelectedIds([]);
          setQuery((current) => ({ ...current, page, pageSize }));
        }}
        onSelectionChange={setSelectedIds}
        onExport={(format) => void download(format)}
        onRefresh={() => setReloadKey((value) => value + 1)}
        onCreate={
          writeLocked
            ? undefined
            : () => {
                setFormError(null);
                setSubmitted(false);
                setEditor({
                  mode: 'create',
                  initial: EMPTY,
                  draft: EMPTY,
                  minimized: false,
                  maximized: false,
                });
              }
        }
        onDelete={writeLocked ? undefined : () => setConfirmDelete(true)}
        columns={[
          {
            key: 'name',
            title: '分组名',
            hideable: false,
            render: (row) => row.name,
          },
          { key: 'total', title: '文章数量', render: (row) => row.total },
          { key: 'remaining', title: '文章剩余量', render: (row) => row.remaining },
          {
            key: 'articles',
            title: '查看文章',
            hideable: false,
            render: (row) => (
              <Button
                type="link"
                aria-label={`查看文章 ${row.name}`}
                onClick={() =>
                  onDispatch({
                    type: 'open',
                    href: `/writing/articles?categoryId=${encodeURIComponent(row.id)}`,
                    sourceId: tabId,
                  })
                }
              >
                查看文章
              </Button>
            ),
          },
          {
            key: 'createdAt',
            title: '创建时间',
            render: (row) => row.createdAt.replace('T', ' ').slice(0, 16),
          },
          {
            key: 'actions',
            title: '操作',
            hideable: false,
            render: (row) => (
              <Button
                type="link"
                aria-label={`编辑 ${row.name}`}
                disabled={writeLocked}
                onClick={() => {
                  const initial = { name: row.name };
                  setFormError(null);
                  setSubmitted(false);
                  setEditor({
                    mode: 'edit',
                    id: row.id,
                    initial,
                    draft: initial,
                    minimized: false,
                    maximized: false,
                  });
                }}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />
      <CrudModal
        open={editor !== null}
        title={editor?.mode === 'edit' ? '编辑分类' : '添加分类'}
        minimized={editor?.minimized ?? false}
        maximized={editor?.maximized ?? false}
        confirmLoading={saving}
        error={formError}
        onMinimize={() =>
          setEditor((current) => (current ? { ...current, minimized: true } : current))
        }
        onRestore={() =>
          setEditor((current) => (current ? { ...current, minimized: false } : current))
        }
        onMaximize={() =>
          setEditor((current) =>
            current ? { ...current, maximized: !current.maximized } : current,
          )
        }
        onClose={() => setEditor(null)}
        onReset={() => {
          setSubmitted(false);
          setFormError(null);
          setEditor((current) => (current ? { ...current, draft: current.initial } : current));
        }}
        ok={
          <Button
            aria-label="确定"
            type="primary"
            loading={saving}
            disabled={writeLocked}
            onClick={() => void save()}
          >
            确定
          </Button>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            文章分类
            <Input
              aria-label="文章分类"
              value={editor?.draft.name ?? ''}
              status={nameError ? 'error' : undefined}
              onChange={(event) =>
                setEditor((current) =>
                  current ? { ...current, draft: { name: event.target.value } } : current,
                )
              }
              onPressEnter={() => void save()}
            />
          </label>
          {nameError ? <p className="gm-form-error">{nameError}</p> : null}
        </form>
      </CrudModal>
      <CrudModal
        open={confirmDelete}
        title="删除所选分类"
        minimized={false}
        maximized={false}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => setConfirmDelete(false)}
        onReset={() => setConfirmDelete(false)}
        ok={
          <Button aria-label="确定" type="primary" danger onClick={() => void removeSelected()}>
            确定
          </Button>
        }
      >
        <p>将删除 {selectedIds.length} 个当前账号的文章分类。分类下的文章会变为未分类。</p>
      </CrudModal>
    </section>
  );
}

function asSort(value: string): CategorySort {
  if (value === 'name' || value === 'total' || value === 'remaining' || value === 'createdAt') {
    return value;
  }
  return 'createdAt';
}

function fieldError(name: string): string | null {
  const parsed = articleCategoryInputSchema.safeParse({ name });
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? '请填写文章分类';
}

function messageOf(reason: unknown): string {
  if (reason instanceof CategoryApiError) return reason.message;
  return '无法连接接口';
}

function noteLock(reason: unknown, setLocked: (value: boolean) => void): void {
  if (reason instanceof CategoryApiError && reason.code === API_ERROR.TENANT_EXPIRED) {
    setLocked(true);
  }
}
