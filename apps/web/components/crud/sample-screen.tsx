'use client';

import {
  API_ERROR,
  sampleInputSchema,
  type CrudListQuery,
  type CrudSort,
  type SampleInput,
} from '@geomix/shared';
import { Alert, Button, Input, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  SampleApiError,
  httpSampleGateway,
  type PriceItem,
  type SampleGateway,
  type SampleRecord,
} from '../../lib/samples';
import type { SessionStorageLike } from '../../lib/session';
import { CrudModal } from './crud-modal';
import { CrudTable } from './crud-table';
import { PriceButton } from './price-button';

const EMPTY: SampleInput = { name: '', note: '', enabled: true };

type Editor = {
  mode: 'create' | 'edit';
  id?: string;
  initial: SampleInput;
  draft: SampleInput;
  minimized: boolean;
  maximized: boolean;
};

export function SampleScreen({
  title,
  readOnly = false,
  gateway,
  storage,
}: {
  title: string;
  readOnly?: boolean;
  gateway?: SampleGateway;
  storage?: SessionStorageLike;
}) {
  const client = useMemo(
    () => gateway ?? httpSampleGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );
  const [query, setQuery] = useState<CrudListQuery>({
    page: 1,
    pageSize: 10,
    sort: 'createdAt',
    order: 'desc',
    keyword: '',
    enabled: undefined,
    export: undefined,
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [rows, setRows] = useState<SampleRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prices, setPrices] = useState<PriceItem[] | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
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

  useEffect(() => {
    let live = true;
    void client.prices().then(
      (items) => {
        if (!live) return;
        setPrices(items);
        setPriceError(null);
      },
      (reason: unknown) => {
        if (!live) return;
        setPriceError(messageOf(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const aiWriteReady = Boolean(prices?.some((item) => item.action === 'ai_write' && item.enabled));

  async function save(): Promise<void> {
    if (!editor || saving || writeLocked) return;
    setSubmitted(true);
    const parsed = sampleInputSchema.safeParse(editor.draft);
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

  async function runBulk(action: 'delete' | 'enable' | 'disable'): Promise<void> {
    if (writeLocked || selectedIds.length === 0) return;
    setError(null);
    try {
      await client.bulk(action, selectedIds);
      setSelectedIds([]);
      setConfirmDelete(false);
      setReloadKey((value) => value + 1);
    } catch (reason) {
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

  const nameError = submitted && !editor?.draft.name.trim() ? '请填写名称' : null;

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        这是通用列表的示例，只保存当前账号自己的记录。保存不扣点，也不调用外部接口。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {priceError ? (
        <Alert type="warning" showIcon message={priceError} style={{ marginBottom: 12 }} />
      ) : null}
      <div className="gm-price-strip" aria-label="价格表">
        {(prices ?? []).map((item) => (
          <PriceButton key={item.action} action={item.action} prices={prices} />
        ))}
      </div>
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
          enabled: query.enabled,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'updatedAt', label: '更新时间' },
          { value: 'name', label: '名称' },
        ]}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((current) => ({
            ...current,
            page: 1,
            keyword: search.keyword,
            enabled: search.enabled,
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
        onEnable={writeLocked ? undefined : () => void runBulk('enable')}
        onDisable={writeLocked ? undefined : () => void runBulk('disable')}
        columns={[
          {
            key: 'index',
            title: '序号',
            width: 72,
            render: (_row, index) => (query.page - 1) * query.pageSize + index + 1,
          },
          { key: 'name', title: '名称', hideable: false, render: (row) => row.name },
          { key: 'note', title: '备注', render: (row) => row.note || '—' },
          {
            key: 'enabled',
            title: '状态',
            render: (row) => (row.enabled ? '启用' : '停用'),
          },
          {
            key: 'updatedAt',
            title: '更新时间',
            render: (row) => row.updatedAt.replace('T', ' ').slice(0, 16),
          },
          {
            key: 'actions',
            title: '操作',
            hideable: false,
            render: (row) => (
              <button
                type="button"
                disabled={writeLocked}
                onClick={() => {
                  const initial = { name: row.name, note: row.note, enabled: row.enabled };
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
              </button>
            ),
          },
        ]}
      />
      <CrudModal
        open={editor !== null}
        title={editor?.mode === 'edit' ? '编辑记录' : '添加记录'}
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
          aiWriteReady ? (
            <PriceButton
              action="ai_write"
              prices={prices}
              loading={saving}
              disabled={writeLocked}
              onClick={() => void save()}
            />
          ) : (
            <Button
              aria-label="确定"
              type="primary"
              loading={saving}
              disabled={writeLocked}
              onClick={() => void save()}
            >
              确定
            </Button>
          )
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            名称
            <Input
              aria-label="名称"
              value={editor?.draft.name ?? ''}
              status={nameError ? 'error' : undefined}
              onChange={(event) =>
                setEditor((current) =>
                  current
                    ? { ...current, draft: { ...current.draft, name: event.target.value } }
                    : current,
                )
              }
              onPressEnter={() => void save()}
            />
          </label>
          {nameError ? <p className="gm-form-error">{nameError}</p> : null}
          <label>
            备注
            <Input.TextArea
              aria-label="备注"
              value={editor?.draft.note ?? ''}
              rows={3}
              onChange={(event) =>
                setEditor((current) =>
                  current
                    ? { ...current, draft: { ...current.draft, note: event.target.value } }
                    : current,
                )
              }
            />
          </label>
          <label>
            启用
            <Switch
              aria-label="启用"
              checked={editor?.draft.enabled ?? true}
              onChange={(checked) =>
                setEditor((current) =>
                  current ? { ...current, draft: { ...current.draft, enabled: checked } } : current,
                )
              }
            />
          </label>
          <p>按钮上的价格来自价格表。点击后只保存这条示例。</p>
        </form>
      </CrudModal>
      <CrudModal
        open={confirmDelete}
        title="删除所选记录"
        minimized={false}
        maximized={false}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => setConfirmDelete(false)}
        onReset={() => setConfirmDelete(false)}
        ok={
          <Button aria-label="确定" type="primary" danger onClick={() => void runBulk('delete')}>
            确定
          </Button>
        }
      >
        <p>将删除 {selectedIds.length} 条当前账号的记录。</p>
      </CrudModal>
    </section>
  );
}

function asSort(value: string): CrudSort {
  if (value === 'name' || value === 'updatedAt' || value === 'createdAt') return value;
  return 'createdAt';
}

function messageOf(reason: unknown): string {
  if (reason instanceof SampleApiError) return reason.message;
  return '无法连接接口';
}

function noteLock(reason: unknown, setLocked: (value: boolean) => void): void {
  if (reason instanceof SampleApiError && reason.code === API_ERROR.TENANT_EXPIRED) setLocked(true);
}
