'use client';

import {
  API_ERROR,
  articleCategoryInputSchema,
  type ArticleCategoryInput,
  type CategoryListQuery,
  type CategorySort,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { CategoryApiError, httpCategoryGateway, type CategoryGateway } from '../../lib/categories';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable } from '../crud/crud-table';
import { TableClampText } from '../crud/table-clamp-text';

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
  active = true,
  readOnly = false,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  active?: boolean;
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
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  useTabFreshness({
    active,
    domains: ['tasks', 'articles', 'categories'],
    onRefresh: () => {
      setReloadKey((value) => value + 1);
    },
  });

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
      invalidateFreshness('categories');
    } catch (reason) {
      setFormError(messageOf(reason));
      noteLock(reason, setLocked);
    } finally {
      setSaving(false);
    }
  }

  async function removePending(): Promise<void> {
    if (writeLocked || deleting || !pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setError(null);
    setDeleting(true);
    try {
      await client.remove(pendingDeleteIds);
      setSelectedIds((prev) => prev.filter((id) => !pendingDeleteIds.includes(id)));
      setPendingDeleteIds(null);
      setReloadKey((value) => value + 1);
      invalidateFreshness('categories');
    } catch (reason) {
      setPendingDeleteIds(null);
      setError(messageOf(reason));
      noteLock(reason, setLocked);
    } finally {
      setDeleting(false);
    }
  }

  async function download(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      const file = await client.download(query, format);
      triggerBlobDownload({ body: file.body, filename: file.filename, mime: file.mime });
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
        分类只属于当前账号。文章数量和文章剩余量按文章实时统计，剩余量是状态为正常且未发布的文章数。
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
        searchPlaceholder="搜索分类名称"
        writeDisabled={writeLocked}
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'name', label: '分类名称' },
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
        onExport={download}
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
        onDelete={writeLocked ? undefined : () => setPendingDeleteIds(selectedIds)}
        columns={[
          {
            key: 'seq',
            title: '序号',
            width: 68,
            hideable: false,
            render: (_row, index) => (query.page - 1) * query.pageSize + index + 1,
          },
          {
            key: 'name',
            title: '分类名称',
            hideable: false,
            render: (row) => <TableClampText text={row.name} lines={2} tooltipThreshold={24} />,
          },
          {
            key: 'total',
            title: '文章数量',
            width: 110,
            render: (row) => (
              <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                {row.total}
              </span>
            ),
          },
          {
            key: 'remaining',
            title: '文章剩余量',
            width: 120,
            render: (row) => (
              <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                {row.remaining}
              </span>
            ),
          },
          {
            key: 'articles',
            title: '查看文章',
            width: 120,
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
            width: 156,
            render: (row) => (
              <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                {formatShanghaiDateTime(row.createdAt)}
              </span>
            ),
          },
          {
            key: 'actions',
            title: '操作',
            width: 140,
            hideable: false,
            render: (row) => (
              <Space size={4}>
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
                <Button
                  type="link"
                  danger
                  aria-label={`删除 ${row.name}`}
                  disabled={writeLocked}
                  onClick={() => setPendingDeleteIds([row.id])}
                >
                  删除
                </Button>
              </Space>
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
            <span style={{ color: 'var(--gm-danger)' }}>* </span>文章分类
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
        </form>
      </CrudModal>
      <Modal
        open={Boolean(pendingDeleteIds && pendingDeleteIds.length > 0)}
        title="删除所选分类"
        centered
        transitionName=""
        maskTransitionName=""
        confirmLoading={deleting}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void removePending()}
        onCancel={() => setPendingDeleteIds(null)}
      >
        <p>
          将删除 {pendingDeleteIds?.length ?? 0} 个当前账号的文章分类。分类下的文章会变为未分类。
        </p>
      </Modal>
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
