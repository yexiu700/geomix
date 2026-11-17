'use client';

import {
  AI_TASK_IMAGE_MAX,
  AI_TASK_IMAGE_MIN,
  AI_TASK_NAME_MAX,
  AI_TASK_TARGET_MAX,
  AI_TASK_TARGET_MIN,
  ITEM_STATUS_LABELS,
  PRICING_DEFAULTS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  formatAiTaskFreezeSummary,
  formatAiTaskSubmitLabel,
  isTaskStatus,
  type AiTaskDetailRecord,
  type AiTaskItemRecord,
  type AiTaskListQuery,
  type AiTaskRecord,
  type AiTaskResultStatus,
  type ItemStatusName,
  type PromptTemplateRecord,
  type TaskStatusName,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Radio,
  Slider,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import { httpAiTaskGateway, type AiTaskFormOptions, type AiTaskGateway } from '../../lib/ai-tasks';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 11px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 14,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

type CreateDraft = {
  name: string;
  categoryId: string;
  keywordId: string;
  mediaCategoryId: string;
  imageCount: number;
  kbId: string;
  contentTplId: string;
  titleTplId: string;
  resultStatus: AiTaskResultStatus;
  target: number;
};

type EditorState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

function readInitialKeywordId(href?: string): string | undefined {
  if (!href) return undefined;
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return undefined;
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const val = params.get('keywordId')?.trim();
  return val || undefined;
}

function defaultCreateDraft(
  options: AiTaskFormOptions | null,
  preferredKeywordId?: string,
): CreateDraft {
  const matchedKw =
    preferredKeywordId && options?.keywords.some((kw) => kw.id === preferredKeywordId)
      ? preferredKeywordId
      : (options?.keywords[0]?.id ?? '');
  return {
    name: '',
    categoryId: '',
    keywordId: matchedKw,
    mediaCategoryId: options?.mediaCategories[0]?.id ?? '',
    imageCount: 1,
    kbId: '',
    contentTplId: '',
    titleTplId: '',
    resultStatus: 'PENDING',
    target: 1,
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

function statusTagColor(status: TaskStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'COMPLETED':
      return 'success';
    case 'PAUSED':
      return 'warning';
    case 'PARTIAL':
      return 'gold';
    case 'FAILED':
      return 'error';
    case 'CANCELLED':
      return 'default';
    case 'QUEUED':
    default:
      return 'blue';
  }
}

function itemStatusTagColor(status: ItemStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

function isActiveTaskStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

function isControllableStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED';
}

function triggerDownload(file: { filename: string; mime: string; body: Uint8Array }) {
  if (typeof URL.createObjectURL !== 'function') return;
  const copy = new Uint8Array(file.body.byteLength);
  copy.set(file.body);
  const blob = new Blob([copy], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AiTaskScreen({
  title,
  tabId,
  href,
  readOnly = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  href?: string;
  readOnly?: boolean;
  pollIntervalMs?: number;
  gateway?: AiTaskGateway;
  storage?: SessionStorageLike;
  onDispatch?: (action: ShellAction) => void;
}) {
  const initialKeywordId = useMemo(() => readInitialKeywordId(href), [href]);
  const [prefilledHref, setPrefilledHref] = useState<string | null>(null);
  const client = useMemo(
    () => gateway ?? httpAiTaskGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );

  const [query, setQuery] = useState<AiTaskListQuery>({
    page: 1,
    pageSize: 10,
    keyword: '',
    status: undefined,
    sort: 'createdAt',
    order: 'desc',
  });
  const [rows, setRows] = useState<AiTaskRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const [banner, setBanner] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  // Create modal state
  const [formOptions, setFormOptions] = useState<AiTaskFormOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Detail drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeDetail, setActiveDetail] = useState<AiTaskDetailRecord | null>(null);

  // Confirmations
  const [cancelTarget, setCancelTarget] = useState<AiTaskRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadList = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await client.list(query);
        setRows(res.items);
        setTotal(res.total);
      } catch (err: unknown) {
        if (!silent) {
          setBanner({
            type: 'error',
            text: err instanceof Error ? err.message : '读取写作任务列表失败',
          });
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [client, query],
  );

  useEffect(() => {
    void loadList(false);
  }, [loadList, reloadTick]);

  // 5-second automatic progress polling for task list and open detail drawer
  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void loadList(true);
      if (drawerOpen && activeDetail && isActiveTaskStatus(activeDetail.status)) {
        void client
          .detail(activeDetail.id)
          .then((fresh) => setActiveDetail(fresh))
          .catch(() => undefined);
      }
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [pollIntervalMs, loadList, drawerOpen, activeDetail, client]);

  const baseAiWritePoints = useMemo(() => {
    const found = formOptions?.prices.find((p) => p.action === 'ai_write');
    if (found && found.enabled) return found.unitPoints;
    return PRICING_DEFAULTS.find((p) => p.action === 'ai_write')?.unitPoints ?? 10;
  }, [formOptions]);

  const kbAddonPoints = useMemo(() => {
    const found = formOptions?.prices.find((p) => p.action === 'kb_addon');
    if (found && found.enabled) return found.unitPoints;
    return PRICING_DEFAULTS.find((p) => p.action === 'kb_addon')?.unitPoints ?? 5;
  }, [formOptions]);

  const allArticleTemplates = useMemo<PromptTemplateRecord[]>(() => {
    if (!formOptions) return [];
    return [...formOptions.articlePrompts.user, ...formOptions.articlePrompts.system];
  }, [formOptions]);

  const selectedArticleTemplate = useMemo(() => {
    if (!editor?.draft.contentTplId) return null;
    return allArticleTemplates.find((tpl) => tpl.id === editor.draft.contentTplId) ?? null;
  }, [allArticleTemplates, editor?.draft.contentTplId]);

  const manualSlotBlocked = Boolean(
    selectedArticleTemplate &&
    selectedArticleTemplate.isSystem &&
    selectedArticleTemplate.hasManualSlot,
  );

  const selectedKb = useMemo(() => {
    if (!editor?.draft.kbId || !formOptions) return null;
    return formOptions.knowledgeBases.find((kb) => kb.id === editor.draft.kbId) ?? null;
  }, [editor?.draft.kbId, formOptions]);

  const freezeQuote = useMemo(() => {
    return formatAiTaskFreezeSummary({
      target: editor?.draft.target ?? 10,
      basePoints: baseAiWritePoints,
      kbAddonPoints,
      withKnowledgeBase: Boolean(editor?.draft.kbId),
    });
  }, [editor?.draft.target, editor?.draft.kbId, baseAiWritePoints, kbAddonPoints]);

  const openCreateModal = useCallback(
    async (preferredKeywordId?: string) => {
      setFormError(null);
      setOptionsLoading(true);
      try {
        const opts = await client.loadFormOptions();
        setFormOptions(opts);
        const init = defaultCreateDraft(opts, preferredKeywordId ?? initialKeywordId);
        setEditor({
          initial: init,
          draft: init,
          minimized: false,
          maximized: false,
        });
      } catch (err: unknown) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '加载表单选项失败',
        });
      } finally {
        setOptionsLoading(false);
      }
    },
    [client, initialKeywordId],
  );

  useEffect(() => {
    if (!initialKeywordId || readOnly || !href || prefilledHref === href) return;
    setPrefilledHref(href);
    void openCreateModal(initialKeywordId);
  }, [initialKeywordId, readOnly, href, prefilledHref, openCreateModal]);

  async function handleSubmitCreate() {
    if (!editor) return;
    const d = editor.draft;
    const trimmedName = d.name.trim();
    if (!trimmedName) {
      setFormError('请填写任务名称');
      return;
    }
    if (!d.keywordId) {
      setFormError('请选择蒸馏训练词');
      return;
    }
    const pickedKw = formOptions?.keywords.find((k) => k.id === d.keywordId);
    if (pickedKw && pickedKw.questionCount < 1) {
      setFormError('所选训练主词下暂无写作问题，请先前往「写作标题」添加问题');
      return;
    }
    if (!d.mediaCategoryId) {
      setFormError('请选择画像图库');
      return;
    }
    const pickedGal = formOptions?.mediaCategories.find((g) => g.id === d.mediaCategoryId);
    if (d.imageCount > 0 && pickedGal && pickedGal.assetCount < 1) {
      setFormError('所选画像图库暂无图片，请先上传图片或将文章配图调为 0 张');
      return;
    }
    if (selectedKb && selectedKb.indexStatus === 'INDEXING') {
      setFormError('所选企业知识库正在建立向量索引，请变为「可用」后再提交任务');
      return;
    }
    if (manualSlotBlocked) {
      setFormError('该系统模板含【品牌N】手工槽位，请先前往「写作指令」克隆并填写对标品牌后再选用');
      return;
    }
    if (
      !Number.isInteger(d.target) ||
      d.target < AI_TASK_TARGET_MIN ||
      d.target > AI_TASK_TARGET_MAX
    ) {
      setFormError(`AI 创作数量需在 ${AI_TASK_TARGET_MIN}–${AI_TASK_TARGET_MAX} 篇之间`);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await client.create({
        name: trimmedName,
        categoryId: d.categoryId || null,
        keywordId: d.keywordId,
        mediaCategoryId: d.mediaCategoryId,
        imageCount: d.imageCount,
        kbId: d.kbId || null,
        contentTplId: d.contentTplId || null,
        titleTplId: d.titleTplId || null,
        resultStatus: d.resultStatus,
        target: d.target,
      });
      setEditor(null);
      setReloadTick((n) => n + 1);
      setBanner({
        type: 'success',
        text: `写作任务「${created.name}」已进入队列（预冻 ${created.frozenPoints} 点数，共 ${created.target} 篇）`,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '创建写作任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function openDetailDrawer(taskId: string) {
    setDrawerOpen(true);
    setDetailLoading(true);
    try {
      const detail = await client.detail(taskId);
      setActiveDetail(detail);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '读取任务详情失败',
      });
      setDrawerOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handlePause(row: AiTaskRecord) {
    try {
      const updated = await client.pause(row.id);
      if (activeDetail?.id === row.id) setActiveDetail(updated);
      setReloadTick((n) => n + 1);
      setBanner({ type: 'success', text: `已暂停任务「${row.name}」` });
    } catch (err: unknown) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '暂停任务失败' });
    }
  }

  async function handleResume(row: AiTaskRecord) {
    try {
      const updated = await client.resume(row.id);
      if (activeDetail?.id === row.id) setActiveDetail(updated);
      setReloadTick((n) => n + 1);
      setBanner({ type: 'success', text: `已恢复任务「${row.name}」继续写作` });
    } catch (err: unknown) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '恢复任务失败' });
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const updated = await client.cancel(cancelTarget.id);
      if (activeDetail?.id === cancelTarget.id) setActiveDetail(updated);
      setCancelTarget(null);
      setReloadTick((n) => n + 1);
      setBanner({
        type: 'success',
        text: `已终止任务「${updated.name}」，剩余未执行篇数的预冻点数已退回`,
      });
    } catch (err: unknown) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '终止任务失败' });
      setCancelTarget(null);
    } finally {
      setCancelling(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteIds || deleteIds.length === 0) return;
    setDeleting(true);
    try {
      const res = await client.bulkDelete(deleteIds);
      if (activeDetail && deleteIds.includes(activeDetail.id)) {
        setDrawerOpen(false);
        setActiveDetail(null);
      }
      setDeleteIds(null);
      setSelectedIds([]);
      setReloadTick((n) => n + 1);
      setBanner({ type: 'success', text: `已删除 ${res.deleted} 条任务记录` });
    } catch (err: unknown) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '删除任务失败' });
      setDeleteIds(null);
    } finally {
      setDeleting(false);
    }
  }

  function openCreatedArticles(row: { id: string; categoryId: string; name: string }) {
    onDispatch?.({
      type: 'open',
      href: `/writing/articles?categoryId=${encodeURIComponent(row.categoryId)}&taskId=${encodeURIComponent(row.id)}`,
      sourceId: tabId,
    });
  }

  async function handleExport(format: 'csv' | 'xlsx') {
    try {
      const file = await client.download(query, format);
      triggerDownload(file);
    } catch (err: unknown) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '导出失败' });
    }
  }

  // Strictly aligned with Issue #17 11 columns:
  // 任务名、蒸馏词、创作上限、已创作、知识库、详情、错误消息、状态、最新写作、创建时间、操作
  const columns: CrudColumn<AiTaskRecord>[] = [
    {
      key: 'name',
      title: '任务名',
      width: 190,
      hideable: false,
      render: (row) => (
        <div style={{ minWidth: 156 }}>
          <Typography.Text strong style={{ display: 'block' }}>
            {row.name}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            分类：{row.categoryName}
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'keywordMain',
      title: '蒸馏词',
      width: 110,
      render: (row) => <Tag color="geekblue">{row.keywordMain}</Tag>,
    },
    {
      key: 'target',
      title: '创作上限',
      width: 78,
      render: (row) => `${row.target} 篇`,
    },
    {
      key: 'doneCount',
      title: '已创作',
      width: 86,
      render: (row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>
            {row.doneCount} / {row.target}
          </Typography.Text>
          {row.failCount > 0 || row.skipCount > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.failCount > 0 ? `失败 ${row.failCount}` : ''}
              {row.failCount > 0 && row.skipCount > 0 ? ' · ' : ''}
              {row.skipCount > 0 ? `跳过 ${row.skipCount}` : ''}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      key: 'kbName',
      title: '知识库',
      width: 140,
      render: (row) =>
        row.kbName ? (
          <Tag color="purple">{row.kbName}</Tag>
        ) : (
          <Typography.Text type="secondary">未使用</Typography.Text>
        ),
    },
    {
      key: 'detail',
      title: '详情',
      width: 80,
      render: (row) => (
        <Button
          type="link"
          size="small"
          aria-label={`查看详情-${row.name}`}
          onClick={() => void openDetailDrawer(row.id)}
        >
          查看详情
        </Button>
      ),
    },
    {
      key: 'lastError',
      title: '错误消息',
      width: 110,
      render: (row) =>
        row.lastError ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {row.lastError}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      key: 'status',
      title: '状态',
      width: 88,
      render: (row) => (
        <Tag color={statusTagColor(row.status)}>{TASK_STATUS_LABELS[row.status]}</Tag>
      ),
    },
    {
      key: 'lastWrittenAt',
      title: '最新写作',
      width: 132,
      render: (row) => formatTime(row.lastWrittenAt),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 132,
      render: (row) => formatTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 170,
      hideable: false,
      render: (row) => (
        <Space size={4} wrap>
          <Button
            type="link"
            size="small"
            aria-label={`查看创作内容-${row.name}`}
            onClick={() => openCreatedArticles(row)}
          >
            查看创作内容
          </Button>
          {(row.status === 'QUEUED' || row.status === 'RUNNING') && !readOnly ? (
            <Button
              type="link"
              size="small"
              aria-label={`暂停-${row.name}`}
              onClick={() => void handlePause(row)}
            >
              暂停
            </Button>
          ) : null}
          {row.status === 'PAUSED' && !readOnly ? (
            <Button
              type="link"
              size="small"
              aria-label={`继续-${row.name}`}
              onClick={() => void handleResume(row)}
            >
              继续
            </Button>
          ) : null}
          {isControllableStatus(row.status) && !readOnly ? (
            <Button
              type="link"
              size="small"
              danger
              aria-label={`终止-${row.name}`}
              onClick={() => setCancelTarget(row)}
            >
              终止
            </Button>
          ) : null}
          {!isControllableStatus(row.status) && !readOnly ? (
            <Button
              type="link"
              size="small"
              danger
              aria-label={`删除-${row.name}`}
              onClick={() => setDeleteIds([row.id])}
            >
              删除
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const submitButtonLabel = formatAiTaskSubmitLabel(freezeQuote.unitPrice);

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="AI 写作任务按整单预冻点数、逐篇落库结算运行：基础写作 10 点/篇，勾选企业知识库附加 +5 点/篇（共 15 点/篇）；列表每 5 秒自动刷新进度，单篇失败或中途终止未用点数自动退回。生成的文章保留 30 天，到期后系统自动删除清理，请及时发布或导出保存。"
      />

      {banner ? (
        <Alert
          type={banner.type}
          showIcon
          closable
          onClose={() => setBanner(null)}
          message={banner.text}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Space wrap style={{ marginBottom: 12 }}>
        <span>任务状态：</span>
        <select
          aria-label="筛选任务状态"
          style={{ ...NATIVE_SELECT_STYLE, width: 160 }}
          value={query.status ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            setSelectedIds([]);
            setQuery((curr) => ({
              ...curr,
              page: 1,
              status: isTaskStatus(val) ? val : undefined,
            }));
          }}
        >
          <option value="">全部状态</option>
          {TASK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {TASK_STATUS_LABELS[st]}
            </option>
          ))}
        </select>
        {optionsLoading ? (
          <Typography.Text type="secondary">正在读取表单选项…</Typography.Text>
        ) : null}
      </Space>

      <CrudTable
        rows={rows}
        total={total}
        page={query.page}
        pageSize={query.pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        writeDisabled={readOnly}
        emptyText="暂无 AI 写作任务，点击「添加」配置训练词与素材即可批量创作"
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'lastWrittenAt', label: '最新写作' },
          { value: 'name', label: '任务名称' },
        ]}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((curr) => ({
            ...curr,
            page: 1,
            keyword: search.keyword,
            sort:
              search.sort === 'lastWrittenAt' || search.sort === 'name' ? search.sort : 'createdAt',
            order: search.order,
          }));
        }}
        onPageChange={(page, pageSize) => {
          setSelectedIds([]);
          setQuery((curr) => ({ ...curr, page, pageSize }));
        }}
        onSelectionChange={setSelectedIds}
        onExport={(format) => void handleExport(format)}
        onRefresh={() => setReloadTick((n) => n + 1)}
        onCreate={readOnly ? undefined : () => void openCreateModal()}
        onDelete={readOnly ? undefined : () => setDeleteIds(selectedIds)}
        columns={columns}
      />

      {/* 10 字段创建任务弹层 */}
      <CrudModal
        open={editor !== null}
        title="新建 AI 写作任务"
        minimized={editor?.minimized ?? false}
        maximized={editor?.maximized ?? false}
        confirmLoading={submitting}
        onMinimize={() => setEditor((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => setEditor((curr) => (curr ? { ...curr, minimized: false } : curr))}
        onMaximize={() =>
          setEditor((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => setEditor(null)}
        onReset={() => setEditor((curr) => (curr ? { ...curr, draft: curr.initial } : curr))}
        ok={
          <Button
            type="primary"
            aria-label={submitButtonLabel}
            loading={submitting}
            disabled={readOnly || manualSlotBlocked}
            onClick={() => void handleSubmitCreate()}
          >
            {submitButtonLabel}
          </Button>
        }
      >
        {editor ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {formError ? <Alert type="error" showIcon message={formError} /> : null}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '10px 16px',
                alignItems: 'start',
              }}
            >
              {/* 1. 任务名称 */}
              <div>
                <label htmlFor="gm-aitask-name" style={{ display: 'block', marginBottom: 4 }}>
                  <span style={{ color: '#ff4d4f' }}>*</span> 任务名称
                </label>
                <Input
                  id="gm-aitask-name"
                  aria-label="任务名称"
                  maxLength={AI_TASK_NAME_MAX}
                  placeholder="请输入任务名称，例如：春季激光选型科普计划"
                  value={editor.draft.name}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr ? { ...curr, draft: { ...curr.draft, name: e.target.value } } : curr,
                    )
                  }
                />
              </div>

              {/* 2. 文章分类 */}
              <div>
                <label htmlFor="gm-aitask-category" style={{ display: 'block', marginBottom: 4 }}>
                  文章分类
                </label>
                <select
                  id="gm-aitask-category"
                  aria-label="文章分类"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.categoryId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? { ...curr, draft: { ...curr.draft, categoryId: e.target.value } }
                        : curr,
                    )
                  }
                >
                  <option value="">不选择（按任务名称自动创建同名分类）</option>
                  {(formOptions?.categories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}（现有 {cat.total} 篇）
                    </option>
                  ))}
                </select>
              </div>

              {/* 3. 蒸馏训练词 */}
              <div>
                <label htmlFor="gm-aitask-keyword" style={{ display: 'block', marginBottom: 4 }}>
                  <span style={{ color: '#ff4d4f' }}>*</span> 蒸馏训练词
                </label>
                <select
                  id="gm-aitask-keyword"
                  aria-label="蒸馏训练词"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.keywordId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? { ...curr, draft: { ...curr.draft, keywordId: e.target.value } }
                        : curr,
                    )
                  }
                >
                  <option value="">请选择蒸馏训练词</option>
                  {(formOptions?.keywords ?? []).map((kw) => (
                    <option key={kw.id} value={kw.id}>
                      {kw.main}（{kw.questionCount} 条问题）
                    </option>
                  ))}
                </select>
              </div>

              {/* 4. 画像图库 */}
              <div>
                <label htmlFor="gm-aitask-gallery" style={{ display: 'block', marginBottom: 4 }}>
                  <span style={{ color: '#ff4d4f' }}>*</span> 画像图库
                </label>
                <select
                  id="gm-aitask-gallery"
                  aria-label="画像图库"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.mediaCategoryId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? { ...curr, draft: { ...curr.draft, mediaCategoryId: e.target.value } }
                        : curr,
                    )
                  }
                >
                  <option value="">请选择画像图库分类</option>
                  {(formOptions?.mediaCategories ?? []).map((gal) => (
                    <option key={gal.id} value={gal.id}>
                      {gal.name}（{gal.assetCount} 张图片）
                    </option>
                  ))}
                </select>
              </div>

              {/* 5. 文章配图 */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>文章配图（每篇插图数）</span>
                  <Typography.Text strong>{editor.draft.imageCount} 张/篇</Typography.Text>
                </div>
                <Slider
                  min={AI_TASK_IMAGE_MIN}
                  max={AI_TASK_IMAGE_MAX}
                  step={1}
                  marks={{ 0: '0张', 1: '1张', 2: '2张', 3: '3张', 4: '4张', 5: '5张' }}
                  value={editor.draft.imageCount}
                  onChange={(val) =>
                    setEditor((curr) =>
                      curr ? { ...curr, draft: { ...curr.draft, imageCount: val } } : curr,
                    )
                  }
                />
              </div>

              {/* 6. 企业知识库（勾选时实时联动单价 +5 点/篇） */}
              <div>
                <label htmlFor="gm-aitask-kb" style={{ display: 'block', marginBottom: 4 }}>
                  企业知识库（选用附加 +{kbAddonPoints} 点/篇）
                </label>
                <select
                  id="gm-aitask-kb"
                  aria-label="企业知识库"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.kbId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr ? { ...curr, draft: { ...curr.draft, kbId: e.target.value } } : curr,
                    )
                  }
                >
                  <option value="">不使用知识库（基础 {baseAiWritePoints} 点/篇）</option>
                  {(formOptions?.knowledgeBases ?? []).map((kb) => {
                    const indexing = kb.indexStatus === 'INDEXING';
                    const failed = kb.indexStatus === 'FAILED';
                    const statusSuffix = indexing
                      ? ' - 索引中暂不可用'
                      : failed
                        ? ' - 索引异常'
                        : '';
                    return (
                      <option key={kb.id} value={kb.id} disabled={indexing || failed}>
                        {kb.name}（+{kbAddonPoints} 点/篇{statusSuffix}）
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* 7. 内容创作指令（严格仅 ARTICLE） */}
              <div>
                <label
                  htmlFor="gm-aitask-content-tpl"
                  style={{ display: 'block', marginBottom: 4 }}
                >
                  内容创作指令
                </label>
                <select
                  id="gm-aitask-content-tpl"
                  aria-label="内容创作指令"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.contentTplId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? { ...curr, draft: { ...curr.draft, contentTplId: e.target.value } }
                        : curr,
                    )
                  }
                >
                  <option value="">随机生成文章（按随机池均衡轮转）</option>
                  {(formOptions?.articlePrompts.user.length ?? 0) > 0 ? (
                    <optgroup label="我的文章指令">
                      {formOptions!.articlePrompts.user.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {(formOptions?.articlePrompts.system.length ?? 0) > 0 ? (
                    <optgroup label="系统默认文章指令">
                      {formOptions!.articlePrompts.system.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                          {tpl.hasManualSlot ? '（含【品牌N】槽位，需先克隆）' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>

              {/* 8. 标题创作指令（严格仅 TITLE） */}
              <div>
                <label htmlFor="gm-aitask-title-tpl" style={{ display: 'block', marginBottom: 4 }}>
                  标题创作指令
                </label>
                <select
                  id="gm-aitask-title-tpl"
                  aria-label="标题创作指令"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.titleTplId}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? { ...curr, draft: { ...curr.draft, titleTplId: e.target.value } }
                        : curr,
                    )
                  }
                >
                  <option value="">不重写标题（直接使用所抽取的问题作为标题）</option>
                  {(formOptions?.titlePrompts.user.length ?? 0) > 0 ? (
                    <optgroup label="我的标题指令">
                      {formOptions!.titlePrompts.user.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {(formOptions?.titlePrompts.system.length ?? 0) > 0 ? (
                    <optgroup label="系统默认标题指令">
                      {formOptions!.titlePrompts.system.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>

              {/* 9. 文章结果状态 */}
              <div>
                <span style={{ display: 'block', marginBottom: 6 }}>文章结果状态</span>
                <Radio.Group
                  value={editor.draft.resultStatus}
                  onChange={(e) =>
                    setEditor((curr) =>
                      curr
                        ? {
                            ...curr,
                            draft: {
                              ...curr.draft,
                              resultStatus: e.target.value as AiTaskResultStatus,
                            },
                          }
                        : curr,
                    )
                  }
                >
                  <Radio value="PENDING">待人工审核</Radio>
                  <Radio value="NORMAL">正常（计入剩余量）</Radio>
                </Radio.Group>
              </div>

              {/* 10. AI 创作数量 */}
              <div>
                <label htmlFor="gm-aitask-target" style={{ display: 'block', marginBottom: 4 }}>
                  <span style={{ color: '#ff4d4f' }}>*</span> AI 创作数量（1–100 篇）
                </label>
                <InputNumber
                  id="gm-aitask-target"
                  aria-label="AI 创作数量"
                  min={AI_TASK_TARGET_MIN}
                  max={AI_TASK_TARGET_MAX}
                  precision={0}
                  style={{ width: '100%' }}
                  value={editor.draft.target}
                  onChange={(val) =>
                    setEditor((curr) =>
                      curr
                        ? {
                            ...curr,
                            draft: {
                              ...curr.draft,
                              target: typeof val === 'number' ? val : 1,
                            },
                          }
                        : curr,
                    )
                  }
                />
              </div>
            </div>

            {manualSlotBlocked ? (
              <Alert
                type="warning"
                showIcon
                message="该系统模板含【品牌1】等手工槽位，请先前往「写作指令」克隆并填写具体对标品牌后再选用。"
              />
            ) : null}

            {/* 实时计费与预冻提示 */}
            <Alert
              type={editor.draft.kbId ? 'warning' : 'info'}
              showIcon
              data-testid="ai-task-freeze-banner"
              message={freezeQuote.text}
            />
          </Space>
        ) : null}
      </CrudModal>

      {/* 任务详情抽屉（AiTaskItem 执行明细 + 控制按钮） */}
      <Drawer
        open={drawerOpen}
        width={860}
        title={activeDetail ? `任务详情：${activeDetail.name}` : '任务详情'}
        onClose={() => {
          setDrawerOpen(false);
          setActiveDetail(null);
        }}
        extra={
          activeDetail ? (
            <Space size={8}>
              <Button size="small" onClick={() => openCreatedArticles(activeDetail)}>
                查看创作内容
              </Button>
              {(activeDetail.status === 'QUEUED' || activeDetail.status === 'RUNNING') &&
              !readOnly ? (
                <Button size="small" onClick={() => void handlePause(activeDetail)}>
                  暂停
                </Button>
              ) : null}
              {activeDetail.status === 'PAUSED' && !readOnly ? (
                <Button size="small" type="primary" onClick={() => void handleResume(activeDetail)}>
                  继续
                </Button>
              ) : null}
              {isControllableStatus(activeDetail.status) && !readOnly ? (
                <Button size="small" danger onClick={() => setCancelTarget(activeDetail)}>
                  终止
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {activeDetail ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            {activeDetail.lastError ? (
              <Alert type="error" showIcon message={activeDetail.lastError} />
            ) : null}

            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务状态">
                <Tag color={statusTagColor(activeDetail.status)}>
                  {TASK_STATUS_LABELS[activeDetail.status]}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="创作进度">
                已完成 {activeDetail.doneCount} / {activeDetail.target} 篇（失败{' '}
                {activeDetail.failCount}，跳过 {activeDetail.skipCount}）
              </Descriptions.Item>
              <Descriptions.Item label="文章分类">{activeDetail.categoryName}</Descriptions.Item>
              <Descriptions.Item label="蒸馏训练词">{activeDetail.keywordMain}</Descriptions.Item>
              <Descriptions.Item label="画像图库">
                {activeDetail.mediaCategoryName}（每篇 {activeDetail.imageCount} 张）
              </Descriptions.Item>
              <Descriptions.Item label="企业知识库">
                {activeDetail.kbName ?? '未使用'}
              </Descriptions.Item>
              <Descriptions.Item label="内容创作指令">
                {activeDetail.contentTplName ?? '随机生成文章'}
              </Descriptions.Item>
              <Descriptions.Item label="标题创作指令">
                {activeDetail.titleTplName ?? '不重写标题'}
              </Descriptions.Item>
              <Descriptions.Item label="单价与预冻核算" span={2}>
                单价 {activeDetail.unitPrice} 点/篇 ｜ 预冻 {activeDetail.frozenPoints} 点 ｜ 已结算{' '}
                {activeDetail.settledPoints} 点 ｜ 已退还 {activeDetail.releasedPoints} 点
              </Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5} style={{ margin: 0 }}>
              单篇执行明细（共 {activeDetail.items.length} 篇）
            </Typography.Title>
            <Table<AiTaskItemRecord>
              rowKey="id"
              size="small"
              loading={detailLoading}
              pagination={{ pageSize: 10 }}
              dataSource={activeDetail.items}
              columns={[
                { title: '篇序', dataIndex: 'seq', width: 64 },
                {
                  title: '抽取问题 / 生成标题',
                  key: 'title',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>
                        {item.title ?? item.questionText ?? '待抽取'}
                      </Typography.Text>
                      {item.questionText && item.title && item.title !== item.questionText ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          原问题：{item.questionText}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: '品牌 / 角度',
                  key: 'brand',
                  width: 160,
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{item.brand ?? '—'}</Typography.Text>
                      {item.direction ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {item.direction}
                          {item.copyType ? ` · ${item.copyType}` : ''}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 96,
                  render: (st: ItemStatusName) => (
                    <Tag color={itemStatusTagColor(st)}>{ITEM_STATUS_LABELS[st]}</Tag>
                  ),
                },
                {
                  title: '重试',
                  dataIndex: 'attempts',
                  width: 64,
                },
                {
                  title: '说明 / 异常',
                  key: 'error',
                  render: (_, item) =>
                    item.error ? (
                      <Typography.Text type="danger" style={{ fontSize: 12 }}>
                        {item.error}
                      </Typography.Text>
                    ) : item.articleId ? (
                      <Button
                        type="link"
                        size="small"
                        onClick={() => openCreatedArticles(activeDetail)}
                      >
                        已落库查看
                      </Button>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
              ]}
            />
          </Space>
        ) : null}
      </Drawer>

      {/* 终止任务确认弹层 */}
      <Modal
        open={cancelTarget !== null}
        title="确认终止写作任务"
        okText="确认终止并退还未用点数"
        cancelText="返回"
        okButtonProps={{ danger: true, loading: cancelling }}
        onCancel={() => setCancelTarget(null)}
        onOk={() => void handleConfirmCancel()}
      >
        <p>
          确定终止任务「{cancelTarget?.name}
          」吗？尚未执行的子任务将标记为已跳过，剩余未使用的预冻点数将立即退回账户可用点数，已生成的文章仍会保留。
        </p>
      </Modal>

      {/* 删除任务确认弹层 */}
      <Modal
        open={deleteIds !== null}
        title="确认删除任务记录"
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
        onCancel={() => setDeleteIds(null)}
        onOk={() => void handleConfirmDelete()}
      >
        <p>
          确定删除选中的 {deleteIds?.length ?? 0}{' '}
          条已完成/已终止任务记录吗？删除任务记录不会删除已生成的文章。
        </p>
      </Modal>
    </section>
  );
}
