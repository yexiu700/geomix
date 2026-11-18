'use client';

import {
  API_ERROR,
  QUESTION_EMPTY_KEYWORD_MSG,
  QUESTION_EMPTY_LINES_MSG,
  QUESTION_SOURCE_LABELS,
  QUESTION_TEXT_MAX,
  type KeywordRecord,
  type QuestionListQuery,
  type QuestionRecord,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable } from '../crud/crud-table';
import { QuestionApiError, httpQuestionGateway, type QuestionGateway } from '../../lib/questions';
import type { ShellAction } from '../../lib/tab-stack';
import {
  formatShanghaiDate,
  formatShanghaiDateTime,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';

type BatchDraft = {
  keywordId: string;
  questionsText: string;
};

type EditDraft = {
  id: string;
  keywordMain: string;
  text: string;
};

function readInitialKeywordId(href?: string): string | undefined {
  if (!href) return undefined;
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return undefined;
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const val = params.get('keywordId')?.trim();
  return val ? val : undefined;
}

export function QuestionScreen({
  title,
  tabId,
  href,
  active = true,
  readOnly = false,
  gateway,
  onDispatch,
}: {
  title: string;
  tabId: string;
  href?: string;
  active?: boolean;
  readOnly?: boolean;
  gateway?: QuestionGateway;
  onDispatch?: (action: ShellAction) => void;
}) {
  const client = useMemo(
    () =>
      gateway ??
      httpQuestionGateway(
        typeof window === 'undefined'
          ? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
          : window.sessionStorage,
      ),
    [gateway],
  );

  const initialKeywordId = useMemo(() => readInitialKeywordId(href), [href]);

  const [query, setQuery] = useState<QuestionListQuery>(() => ({
    page: 1,
    pageSize: 10,
    keyword: '',
    keywordId: initialKeywordId,
    sort: 'createdAt',
    order: 'desc',
  }));
  const [rows, setRows] = useState<QuestionRecord[]>([]);
  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  const [addEditor, setAddEditor] = useState<{
    initial: BatchDraft;
    draft: BatchDraft;
    minimized: boolean;
    maximized: boolean;
  } | null>(null);
  const [editEditor, setEditEditor] = useState<{
    initial: EditDraft;
    draft: EditDraft;
    minimized: boolean;
    maximized: boolean;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);

  const writeLocked = readOnly || locked;

  // Sync keywordId filter when tab href changes via drill-down
  useEffect(() => {
    setQuery((curr) =>
      curr.keywordId === initialKeywordId
        ? curr
        : {
            ...curr,
            page: 1,
            keywordId: initialKeywordId,
          },
    );
  }, [initialKeywordId]);

  const loadKeywords = useCallback(async () => {
    try {
      const items = await client.listKeywords();
      setKeywords(items);
    } catch {
      // keep existing keyword options if transient error occurs
    }
  }, [client]);

  useEffect(() => {
    void loadKeywords();
  }, [loadKeywords, reloadKey]);

  useTabFreshness({
    active,
    domains: ['keywords', 'questions'],
    onRefresh: () => {
      void loadKeywords();
      setReloadKey((v) => v + 1);
    },
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .list(query)
      .then((data) => {
        if (!active) return;
        setRows(data.items);
        setTotal(data.total);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(messageOf(reason));
        noteLock(reason, setLocked);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, query, reloadKey]);

  function openAddModal(): void {
    const preselected = query.keywordId ?? initialKeywordId ?? '';
    const initial: BatchDraft = {
      keywordId: preselected,
      questionsText: '',
    };
    setFormError(null);
    setAddEditor({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
    void loadKeywords();
  }

  async function submitBatchAdd(): Promise<void> {
    if (!addEditor || writeLocked) return;
    setFormError(null);
    const kwId = addEditor.draft.keywordId.trim();
    if (!kwId) {
      setFormError(QUESTION_EMPTY_KEYWORD_MSG);
      return;
    }
    if (!addEditor.draft.questionsText.trim()) {
      setFormError(QUESTION_EMPTY_LINES_MSG);
      return;
    }
    setSaving(true);
    try {
      const res = await client.batchCreate({
        keywordId: kwId,
        questionsText: addEditor.draft.questionsText,
      });
      setAddEditor(null);
      setNotice(
        `成功添加 ${res.createdCount} 条写作标题${
          res.skippedCount > 0 ? `（自动跳过重复 ${res.skippedCount} 条）` : ''
        }`,
      );
      setReloadKey((v) => v + 1);
      invalidateFreshness('questions', 'keywords');
    } catch (reason) {
      setFormError(messageOf(reason));
      noteLock(reason, setLocked);
    } finally {
      setSaving(false);
    }
  }

  async function submitSingleEdit(): Promise<void> {
    if (!editEditor || writeLocked) return;
    setFormError(null);
    const trimmed = editEditor.draft.text.trim();
    if (!trimmed) {
      setFormError('请输入问题内容');
      return;
    }
    if (trimmed.length > QUESTION_TEXT_MAX) {
      setFormError(`单条问题不超过 ${QUESTION_TEXT_MAX} 个字符`);
      return;
    }
    setSaving(true);
    try {
      await client.update(editEditor.draft.id, { text: trimmed });
      setEditEditor(null);
      setNotice('已保存问题修改');
      setReloadKey((v) => v + 1);
      invalidateFreshness('questions', 'keywords');
    } catch (reason) {
      setFormError(messageOf(reason));
      noteLock(reason, setLocked);
    } finally {
      setSaving(false);
    }
  }

  async function executeDelete(ids: string[]): Promise<void> {
    if (writeLocked || ids.length === 0) return;
    setError(null);
    try {
      const res = await client.bulkDelete(ids);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      setConfirmDeleteIds(null);
      setNotice(`已删除 ${res.affected} 条写作标题，并同步释放写作问题配额`);
      setReloadKey((v) => v + 1);
      invalidateFreshness('questions', 'keywords');
    } catch (reason) {
      setConfirmDeleteIds(null);
      setError(messageOf(reason));
      noteLock(reason, setLocked);
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

  const keywordOptions = useMemo(
    () => keywords.map((k) => ({ value: k.id, label: k.main })),
    [keywords],
  );

  const resolvedTitle = useMemo(() => {
    const activeKwId = query.keywordId ?? initialKeywordId;
    if (!activeKwId) return title;
    const matched = keywords.find((k) => k.id === activeKwId)?.main ?? rows[0]?.keywordMain;
    return matched ? `写作标题 · ${matched}` : title;
  }, [initialKeywordId, keywords, query.keywordId, rows, title]);

  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {resolvedTitle}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        管理各蒸馏主词下的拓展咨询问题，支持按主词与收录状态筛选、多行批量去重添加、单条编辑及删除回退配额。
      </Typography.Paragraph>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert
          type="success"
          showIcon
          closable
          message={notice}
          onClose={() => setNotice(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Space style={{ marginBottom: 12 }} wrap>
        <span>蒸馏主词：</span>
        <Select<string>
          aria-label="主词筛选"
          value={query.keywordId ?? 'ALL'}
          style={{ width: 180 }}
          options={[{ value: 'ALL', label: '全部主词' }, ...keywordOptions]}
          onChange={(val) => {
            setSelectedIds([]);
            const nextKeywordId = val === 'ALL' ? undefined : val;
            setQuery((curr) => ({
              ...curr,
              page: 1,
              keywordId: nextKeywordId,
            }));
            if (!nextKeywordId && href && href.includes('?')) {
              onDispatch?.({ type: 'navigate', id: tabId, href: '/material/questions' });
            }
          }}
        />
        <span>收录状态：</span>
        <Select<'ALL' | 'false' | 'true'>
          aria-label="收录状态筛选"
          value={
            query.included === undefined ? 'ALL' : (String(query.included) as 'false' | 'true')
          }
          style={{ width: 130 }}
          options={[
            { value: 'ALL', label: '全部状态' },
            { value: 'false', label: '未收录' },
            { value: 'true', label: '已收录' },
          ]}
          onChange={(val) => {
            setSelectedIds([]);
            setQuery((curr) => ({
              ...curr,
              page: 1,
              included: val === 'ALL' ? undefined : val === 'true',
            }));
          }}
        />
        <div
          data-testid="question-date-range"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'nowrap',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span>创建日期：</span>
          <Input
            type="date"
            aria-label="开始日期"
            style={{ width: 138 }}
            value={query.createdAtFrom ? formatShanghaiDate(query.createdAtFrom, '') : ''}
            onChange={(e) => {
              const val = e.target.value;
              setQuery((curr) => ({
                ...curr,
                page: 1,
                createdAtFrom: val ? `${val}T00:00:00+08:00` : undefined,
              }));
            }}
          />
          <span>至</span>
          <Input
            type="date"
            aria-label="结束日期"
            style={{ width: 138 }}
            value={query.createdAtTo ? formatShanghaiDate(query.createdAtTo, '') : ''}
            onChange={(e) => {
              const val = e.target.value;
              setQuery((curr) => ({
                ...curr,
                page: 1,
                createdAtTo: val ? `${val}T23:59:59.999+08:00` : undefined,
              }));
            }}
          />
        </div>
      </Space>

      <CrudTable
        rows={rows}
        total={total}
        page={query.page}
        pageSize={query.pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        searchPlaceholder="搜索写作标题或主关键词"
        writeDisabled={writeLocked}
        toolbarOrder="create-first"
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'usedCount', label: '使用次数' },
          { value: 'text', label: '问题内容' },
        ]}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((curr) => ({
            ...curr,
            page: 1,
            keyword: search.keyword,
            sort: search.sort === 'usedCount' || search.sort === 'text' ? search.sort : 'createdAt',
            order: search.order,
          }));
        }}
        onPageChange={(page, pageSize) => {
          setSelectedIds([]);
          setQuery((curr) => ({ ...curr, page, pageSize }));
        }}
        onSelectionChange={setSelectedIds}
        onExport={download}
        onRefresh={() => setReloadKey((v) => v + 1)}
        onCreate={writeLocked ? undefined : openAddModal}
        onDelete={writeLocked ? undefined : () => setConfirmDeleteIds(selectedIds)}
        onBack={() => onDispatch?.({ type: 'back', id: tabId })}
        columns={[
          {
            key: 'seq',
            title: '序号',
            width: 72,
            render: (_row, index) => (query.page - 1) * query.pageSize + index + 1,
          },
          {
            key: 'keywordMain',
            title: '主词',
            hideable: false,
            render: (row) => <strong>{row.keywordMain}</strong>,
          },
          {
            key: 'text',
            title: '问题',
            hideable: false,
            render: (row) => (
              <Space size={6} wrap>
                <span>{row.text}</span>
                {row.source !== 'MANUAL' ? (
                  <Tag bordered={false}>{QUESTION_SOURCE_LABELS[row.source]}</Tag>
                ) : null}
              </Space>
            ),
          },
          {
            key: 'included',
            title: '收录状态',
            width: 110,
            render: (row) => (
              <Tag color={row.included ? 'success' : 'default'}>
                {row.included ? '已收录' : '未收录'}
              </Tag>
            ),
          },
          {
            key: 'createdAt',
            title: '创建时间',
            width: 168,
            render: (row) => formatShanghaiDateTime(row.createdAt),
          },
          {
            key: 'actions',
            title: '操作',
            hideable: false,
            width: 150,
            render: (row) => (
              <Space size={4}>
                <Button
                  size="small"
                  type="link"
                  disabled={writeLocked}
                  onClick={() => {
                    const initial: EditDraft = {
                      id: row.id,
                      keywordMain: row.keywordMain,
                      text: row.text,
                    };
                    setFormError(null);
                    setEditEditor({
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
                  size="small"
                  type="link"
                  danger
                  disabled={writeLocked}
                  onClick={() => setConfirmDeleteIds([row.id])}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {/* 批量添加弹层 */}
      <CrudModal
        open={addEditor !== null}
        title="添加写作标题"
        minimized={addEditor?.minimized ?? false}
        maximized={addEditor?.maximized ?? false}
        confirmLoading={saving}
        onMinimize={() => setAddEditor((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => {
          setAddEditor((curr) => (curr ? { ...curr, minimized: false } : curr));
          void loadKeywords();
        }}
        onMaximize={() =>
          setAddEditor((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          setAddEditor(null);
          setFormError(null);
        }}
        onReset={() => {
          setFormError(null);
          setAddEditor((curr) => (curr ? { ...curr, draft: curr.initial } : curr));
        }}
        ok={
          <Button
            type="primary"
            aria-label="确定"
            loading={saving}
            disabled={writeLocked}
            onClick={() => void submitBatchAdd()}
          >
            确定
          </Button>
        }
      >
        {addEditor ? (
          <Space direction="vertical" style={{ width: '100%' }} size={14}>
            {formError ? <Alert type="error" showIcon message={formError} /> : null}
            <div>
              <label
                htmlFor="gm-qst-keyword"
                style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}
              >
                <span style={{ color: 'var(--gm-danger)' }}>* </span>蒸馏主词
              </label>
              <Select<string>
                id="gm-qst-keyword"
                aria-label="蒸馏主词"
                placeholder="请选择蒸馏主词"
                style={{ width: '100%' }}
                value={addEditor.draft.keywordId || undefined}
                options={keywordOptions}
                onChange={(value) =>
                  setAddEditor((curr) =>
                    curr ? { ...curr, draft: { ...curr.draft, keywordId: value } } : curr,
                  )
                }
              />
            </div>

            <div>
              <label
                htmlFor="gm-qst-lines"
                style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}
              >
                <span style={{ color: 'var(--gm-danger)' }}>* </span>拓展问题
              </label>
              <Input.TextArea
                id="gm-qst-lines"
                aria-label="拓展问题"
                rows={8}
                placeholder="请输入问题,一行一个问题"
                value={addEditor.draft.questionsText}
                onChange={(e) =>
                  setAddEditor((curr) =>
                    curr
                      ? { ...curr, draft: { ...curr.draft, questionsText: e.target.value } }
                      : curr,
                  )
                }
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                同一主词下重复问题将自动跳过，仅新增有效问题占用写作问题配额；默认收录状态为「未收录」。
              </Typography.Text>
            </div>
          </Space>
        ) : null}
      </CrudModal>

      {/* 单条编辑弹层 */}
      <CrudModal
        open={editEditor !== null}
        title="编辑写作标题"
        minimized={editEditor?.minimized ?? false}
        maximized={editEditor?.maximized ?? false}
        confirmLoading={saving}
        onMinimize={() => setEditEditor((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => setEditEditor((curr) => (curr ? { ...curr, minimized: false } : curr))}
        onMaximize={() =>
          setEditEditor((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          setEditEditor(null);
          setFormError(null);
        }}
        onReset={() => {
          setFormError(null);
          setEditEditor((curr) => (curr ? { ...curr, draft: curr.initial } : curr));
        }}
        ok={
          <Button
            type="primary"
            aria-label="确定"
            loading={saving}
            disabled={writeLocked}
            onClick={() => void submitSingleEdit()}
          >
            确定
          </Button>
        }
      >
        {editEditor ? (
          <Space direction="vertical" style={{ width: '100%' }} size={14}>
            {formError ? <Alert type="error" showIcon message={formError} /> : null}
            <div>
              <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>所属主词</span>
              <Input value={editEditor.draft.keywordMain} disabled />
            </div>
            <div>
              <label
                htmlFor="gm-qst-edit-text"
                style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}
              >
                <span style={{ color: 'var(--gm-danger)' }}>* </span>问题内容
              </label>
              <Input
                id="gm-qst-edit-text"
                aria-label="问题内容"
                maxLength={QUESTION_TEXT_MAX}
                value={editEditor.draft.text}
                onChange={(e) =>
                  setEditEditor((curr) =>
                    curr ? { ...curr, draft: { ...curr.draft, text: e.target.value } } : curr,
                  )
                }
              />
            </div>
          </Space>
        ) : null}
      </CrudModal>

      {/* 删除确认弹层 */}
      <Modal
        open={confirmDeleteIds !== null}
        title="确认删除写作标题"
        centered
        keyboard
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
        onOk={() => void executeDelete(confirmDeleteIds ?? [])}
        onCancel={() => setConfirmDeleteIds(null)}
      >
        <p>将删除所选 {confirmDeleteIds?.length ?? 0} 条写作标题，并同步回退写作问题配额。</p>
      </Modal>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof QuestionApiError) return reason.message;
  return '无法连接接口';
}

function noteLock(reason: unknown, setLocked: (value: boolean) => void): void {
  if (reason instanceof QuestionApiError && reason.code === API_ERROR.TENANT_EXPIRED) {
    setLocked(true);
  }
}
