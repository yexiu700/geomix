'use client';

import {
  ARTICLE_STATUS_LABEL,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  ITEM_STATUS_LABELS,
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_MAX_COUNT_MAX,
  REWRITE_BATCH_MAX_COUNT_MIN,
  REWRITE_BATCH_NAME_MAX,
  REWRITE_BATCH_SOURCE_LABELS,
  REWRITE_BATCH_SOURCE_TYPES,
  REWRITE_BATCH_STATUS_LABELS,
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  REWRITE_DEFAULT_UNIT_POINTS,
  REWRITE_RESULT_STATUS_LABELS,
  TASK_STATUSES,
  buildDefaultBatchCategoryName,
  looksLikeUrlNotKeyword,
  parseBatchLinkList,
  type ArticleStatusName,
  type CrudExportFormat,
  type ItemStatusName,
  type RewriteBatchCreateInput,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteBatchListQuery,
  type RewriteBatchSourceType,
  type RewriteRecordItem,
  type RewriteResultStatusName,
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
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { CrudToolbar } from '../crud/crud-toolbar';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import { useUxFeedback } from '../crud/ux-feedback';
import {
  httpRewriteBatchGateway,
  type RewriteBatchFormOptions,
  type RewriteBatchGateway,
} from '../../lib/rewrite-batches';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { UX_TERMS, formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_MAX_COUNT = 1;
const NO_IMAGE_GALLERY_VALUE = '__NONE__';

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 14,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

type CreateDraft = {
  name: string;
  maxCount: number;
  sourceType: RewriteBatchSourceType;
  keyword: string;
  linksText: string;
  mediaCategoryId: string;
  noImage: boolean;
  templateId: string;
  categoryId: string;
  autoCategoryName: string;
  resultStatus: RewriteResultStatusName;
  brand: string;
};

type ModalState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

function buildInitialDraft(options: RewriteBatchFormOptions | null): CreateDraft {
  const hasUsableGallery = (options?.mediaCategories ?? []).some((c) => c.assetCount > 0);
  return {
    name: '',
    maxCount: DEFAULT_BATCH_MAX_COUNT,
    sourceType: 'link_list',
    keyword: '',
    linksText: '',
    mediaCategoryId: '',
    noImage: !hasUsableGallery,
    templateId: '',
    categoryId: '',
    autoCategoryName: buildDefaultBatchCategoryName('批量爆文'),
    resultStatus: 'PENDING',
    brand: '',
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

function batchStatusTagColor(status: TaskStatusName): string {
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
    case 'SUCCESS':
      return 'success';
    case 'RUNNING':
      return 'processing';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

function articleStatusTagColor(status: ArticleStatusName): string {
  switch (status) {
    case 'NORMAL':
      return 'green';
    case 'PENDING':
      return 'gold';
    case 'DISABLED':
    default:
      return 'default';
  }
}

function isActiveBatchStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

function isTerminalBatchStatus(status: TaskStatusName): boolean {
  return (
    status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED' || status === 'CANCELLED'
  );
}

export function RewriteBatchScreen({
  title,
  tabId,
  active = true,
  readOnly = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  storage,
  gateway: injectedGateway,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  active?: boolean;
  readOnly?: boolean;
  pollIntervalMs?: number;
  storage?: SessionStorageLike;
  gateway?: RewriteBatchGateway;
  onDispatch?: (action: ShellAction) => void;
}) {
  const feedback = useUxFeedback();
  const gateway = useMemo(() => {
    if (injectedGateway) return injectedGateway;
    const browserStorage: SessionStorageLike =
      storage ??
      (typeof window !== 'undefined'
        ? window.sessionStorage
        : {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
          });
    return httpRewriteBatchGateway(browserStorage);
  }, [injectedGateway, storage]);

  const [query, setQuery] = useState<RewriteBatchListQuery>({
    page: 1,
    pageSize: 25,
  });
  const [keywordInput, setKeywordInput] = useState('');
  const [items, setItems] = useState<RewriteBatchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unitPoints, setUnitPoints] = useState(REWRITE_DEFAULT_UNIT_POINTS);
  const [remoteSearchEnabled, setRemoteSearchEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [formOptions, setFormOptions] = useState<RewriteBatchFormOptions | null>(null);

  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerDetail, setDrawerDetail] = useState<RewriteBatchDetailResponse | null>(null);
  const drawerStateRef = useRef<{ open: boolean; detail: RewriteBatchDetailResponse | null }>({
    open: false,
    detail: null,
  });
  drawerStateRef.current = { open: drawerOpen, detail: drawerDetail };

  const loadList = useCallback(
    async (nextQuery: RewriteBatchListQuery, silent = false) => {
      if (!silent) {
        setLoading(true);
        setErrorMsg(null);
      }
      try {
        const res = await gateway.list(nextQuery);
        setItems(res.items);
        setTotal(res.total);
        setUnitPoints(res.unitPoints || REWRITE_DEFAULT_UNIT_POINTS);
        setRemoteSearchEnabled(res.remoteSearchEnabled);
        setSelectedIds((prev) =>
          prev.filter((id) =>
            res.items.some((item) => item.id === id && isTerminalBatchStatus(item.status)),
          ),
        );
        const curDrawer = drawerStateRef.current;
        if (curDrawer.open && curDrawer.detail) {
          const matched = res.items.find((item) => item.id === curDrawer.detail!.batch.id);
          if (
            matched &&
            (matched.status !== curDrawer.detail.batch.status ||
              matched.doneCount !== curDrawer.detail.batch.doneCount ||
              matched.settledPoints !== curDrawer.detail.batch.settledPoints ||
              matched.releasedPoints !== curDrawer.detail.batch.releasedPoints ||
              isActiveBatchStatus(matched.status))
          ) {
            void gateway
              .detail(matched.id)
              .then((detail) => {
                if (
                  drawerStateRef.current.open &&
                  drawerStateRef.current.detail?.batch.id === detail.batch.id
                ) {
                  setDrawerDetail(detail);
                }
              })
              .catch(() => undefined);
          }
        }
      } catch (err) {
        if (!silent) {
          setErrorMsg(err instanceof Error ? err.message : '加载批量爆文复刻列表失败');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [gateway],
  );

  const loadOptions = useCallback(async () => {
    try {
      const opts = await gateway.loadFormOptions();
      setFormOptions(opts);
      if (opts.unitPoints) setUnitPoints(opts.unitPoints);
      setRemoteSearchEnabled(opts.remoteSearchEnabled);
      return opts;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : '加载表单选项（文章分类/图库/指令）失败，请刷新重试',
      );
      return null;
    }
  }, [gateway]);

  useEffect(() => {
    void loadList(query);
  }, [loadList, query]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useTabFreshness({
    active,
    domains: ['categories', 'gallery', 'prompts', 'points'],
    onRefresh: () => {
      void loadOptions();
    },
  });

  const drawerBatchId = drawerOpen && drawerDetail ? drawerDetail.batch.id : null;
  const drawerBatchActive =
    drawerOpen && drawerDetail !== null && isActiveBatchStatus(drawerDetail.batch.status);
  const hasActiveBatch = useMemo(
    () => items.some((b) => isActiveBatchStatus(b.status)) || drawerBatchActive,
    [drawerBatchActive, items],
  );

  useEffect(() => {
    if (!hasActiveBatch || pollIntervalMs <= 0) return undefined;
    const effectiveInterval = drawerBatchActive ? Math.min(pollIntervalMs, 1_500) : pollIntervalMs;
    const timer = setInterval(() => {
      void loadList(query, true);
      if (drawerBatchId && drawerBatchActive) {
        void gateway
          .detail(drawerBatchId)
          .then((detail) => {
            setDrawerDetail((prev) => (prev && prev.batch.id === detail.batch.id ? detail : prev));
          })
          .catch(() => undefined);
      }
    }, effectiveInterval);
    return () => clearInterval(timer);
  }, [drawerBatchActive, drawerBatchId, gateway, hasActiveBatch, loadList, pollIntervalMs, query]);

  const navigateTo = useCallback(
    (href: string) => {
      if (!onDispatch) return;
      setModalState(null);
      setModalError(null);
      setDrawerOpen(false);
      setDrawerDetail(null);
      onDispatch({
        type: 'open',
        href,
        sourceId: tabId,
      });
    },
    [onDispatch, tabId],
  );

  const openCreateModal = async () => {
    setModalError(null);
    const opts = (await loadOptions()) ?? formOptions;
    const initial = buildInitialDraft(opts);
    setModalState({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
  };

  const openTaskDrawer = async (batchId: string) => {
    setDrawerOpen(true);
    setDrawerLoading(true);
    try {
      const detail = await gateway.detail(batchId);
      setDrawerDetail(detail);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载任务明细失败');
    } finally {
      setDrawerLoading(false);
    }
  };

  const draftLinkAnalysis = useMemo(() => {
    if (!modalState || modalState.draft.sourceType !== 'link_list') return null;
    return parseBatchLinkList(modalState.draft.linksText, REWRITE_BATCH_LINK_LIST_MAX);
  }, [modalState]);

  const keywordIsUrlWarning = useMemo(() => {
    if (!modalState) return false;
    return looksLikeUrlNotKeyword(modalState.draft.keyword);
  }, [modalState]);

  const handleSubmitCreate = async () => {
    if (!modalState) return;
    const { draft } = modalState;
    setModalError(null);

    const issues: string[] = [];

    if (!draft.name.trim()) {
      issues.push('请填写任务名称');
    } else if (draft.name.trim().length > REWRITE_BATCH_NAME_MAX) {
      issues.push(`任务名称不超过 ${REWRITE_BATCH_NAME_MAX} 个字符`);
    }

    if (
      !Number.isInteger(draft.maxCount) ||
      draft.maxCount < REWRITE_BATCH_MAX_COUNT_MIN ||
      draft.maxCount > REWRITE_BATCH_MAX_COUNT_MAX
    ) {
      issues.push(
        `最大改写量须在 ${REWRITE_BATCH_MAX_COUNT_MIN}–${REWRITE_BATCH_MAX_COUNT_MAX} 篇之间`,
      );
    }

    if (draft.sourceType === 'remote') {
      if (!draft.keyword.trim()) {
        issues.push('关键词全网搜索模式下请填写流量关键词');
      } else if (looksLikeUrlNotKeyword(draft.keyword)) {
        issues.push(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
      } else if (!remoteSearchEnabled) {
        issues.push(
          '当前环境未配置第三方搜索源，「关键词全网搜索」暂未开通，请切换至「粘贴公开文章链接清单」',
        );
      }
    } else {
      if (draft.keyword.trim() && looksLikeUrlNotKeyword(draft.keyword)) {
        issues.push(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
      }
      const parsed = parseBatchLinkList(draft.linksText, REWRITE_BATCH_LINK_LIST_MAX);
      if (parsed.nonEmptyCount === 0) {
        issues.push('请至少粘贴 1 条公开文章链接（一行一条）');
      } else if (parsed.invalidLines.length > 0) {
        const first = parsed.invalidLines[0]!;
        issues.push(`第 ${first.line} 行链接不合法：${first.reason}`);
      } else if (parsed.candidates.length === 0) {
        const firstExcl = parsed.excludedLines[0];
        issues.push(
          firstExcl
            ? `全部候选链接均不可用于正文复刻（第 ${firstExcl.line} 行：${firstExcl.reason}）`
            : '没有可用的有效文章链接',
        );
      }
    }

    if (!draft.noImage && !draft.mediaCategoryId) {
      issues.push(`请选择文章配图的${UX_TERMS.gallery}分类（或选择「不配图（0 张）」）`);
    } else if (!draft.noImage && selectedMediaCat && selectedMediaCat.assetCount === 0) {
      issues.push(`所选${UX_TERMS.gallery}分类暂无图片，请先上传图片或选择「不配图（0 张）」`);
    }

    if (!draft.templateId) {
      issues.push('请选择爆文改写指令');
    }

    if (issues.length > 0) {
      setModalError(issues.join('；'));
      return;
    }

    const payload: RewriteBatchCreateInput = {
      name: draft.name.trim(),
      maxCount: draft.maxCount,
      sourceType: draft.sourceType,
      keyword: draft.keyword.trim(),
      linksText: draft.sourceType === 'link_list' ? draft.linksText : undefined,
      mediaCategoryId: draft.noImage ? null : draft.mediaCategoryId || null,
      templateId: draft.templateId,
      categoryId: draft.categoryId || null,
      brand: draft.brand.trim() || undefined,
      resultStatus: draft.resultStatus,
    };

    setBusy(true);
    try {
      const created = await gateway.create(payload);
      setModalState(null);
      setFeedbackMsg(
        `批量复刻任务「${created.batch.name}」已入队（预冻 ${created.batch.reservedPoints} 点数，按实际成功篇数结算并自动退差额）`,
      );
      invalidateFreshness('articles', 'categories', 'points');
      setDrawerDetail(created);
      setDrawerOpen(true);
      await Promise.all([
        loadList({ ...query, page: 1 }),
        loadOptions(),
        isActiveBatchStatus(created.batch.status)
          ? gateway
              .detail(created.batch.id)
              .then((latest) => {
                setDrawerDetail((prev) =>
                  prev && prev.batch.id === latest.batch.id ? latest : prev,
                );
              })
              .catch(() => undefined)
          : Promise.resolve(),
      ]);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '创建批量复刻任务失败');
    } finally {
      setBusy(false);
    }
  };

  const handleControl = async (batch: RewriteBatchItem, action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    setErrorMsg(null);
    try {
      if (action === 'pause') {
        await gateway.pause(batch.id);
        setFeedbackMsg(`已暂停任务「${batch.name}」`);
      } else if (action === 'resume') {
        await gateway.resume(batch.id);
        setFeedbackMsg(`已继续执行任务「${batch.name}」`);
      } else {
        const updated = await gateway.cancel(batch.id);
        setFeedbackMsg(
          `已终止任务「${batch.name}」，剩余预冻 ${updated.releasedPoints} 点数已释放回账户`,
        );
      }
      await loadList(query);
      if (drawerOpen && drawerDetail?.batch.id === batch.id) {
        const refreshed = await gateway.detail(batch.id);
        setDrawerDetail(refreshed);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '任务控制操作失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteOne = async (batch: RewriteBatchItem) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await gateway.deleteOne(batch.id);
      setFeedbackMsg(`已删除任务「${batch.name}」`);
      setSelectedIds((prev) => prev.filter((id) => id !== batch.id));
      if (drawerDetail?.batch.id === batch.id) {
        setDrawerOpen(false);
        setDrawerDetail(null);
      }
      await loadList(query);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '删除任务失败');
    } finally {
      setBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await gateway.bulkDelete(selectedIds);
      setFeedbackMsg(`已批量删除 ${res.affected} 条已结束的批量复刻任务`);
      setSelectedIds([]);
      setBulkDeleteConfirmOpen(false);
      await loadList(query);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '批量删除失败');
      setBulkDeleteConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (format: CrudExportFormat) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const file = await gateway.downloadTable(query, format);
      triggerBlobDownload(file);
      setFeedbackMsg(`已导出 ${file.filename}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const isDirty = useMemo(() => {
    if (!modalState) return false;
    return JSON.stringify(modalState.draft) !== JSON.stringify(modalState.initial);
  }, [modalState]);

  const requestCloseModal = () => {
    if (!modalState) return;
    if (!isDirty) {
      setModalState(null);
      setModalError(null);
      return;
    }
    feedback.confirm({
      title: '放弃未提交的批量复刻草稿？',
      content: '已填写的任务配置与链接清单尚未提交，确定关闭吗？',
      okText: '放弃并关闭',
      cancelText: '继续编辑',
      onOk: () => {
        setModalState(null);
        setModalError(null);
      },
    });
  };

  const mediaCategoriesWithImages = useMemo(
    () => (formOptions?.mediaCategories ?? []).filter((cat) => cat.assetCount > 0),
    [formOptions],
  );

  const selectedMediaCat = useMemo(() => {
    if (!modalState || !formOptions) return null;
    return (
      formOptions.mediaCategories.find((cat) => cat.id === modalState.draft.mediaCategoryId) ?? null
    );
  }, [formOptions, modalState]);

  const estimatedFreezePoints = modalState
    ? Math.max(1, modalState.draft.maxCount || 1) * unitPoints
    : unitPoints * DEFAULT_BATCH_MAX_COUNT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header Banner */}
      <div
        style={{
          padding: '14px 18px',
          background: 'var(--gm-bg-surface)',
          border: '1px solid var(--gm-line-1)',
          borderRadius: 8,
        }}
      >
        <Space size={10} align="center" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Tag color="blue">{unitPoints} 点数/篇 · 按实际成功篇数扣点</Tag>
          <Tag color="cyan">凑满最大改写量即停 · 差额自动退还</Tag>
        </Space>
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--gm-fg-2)' }}>
          默认支持粘贴最多 {REWRITE_BATCH_LINK_LIST_MAX}{' '}
          条公开文章链接批量抓取与结构重构；单链失败或超时自动跳过不扣点，所有插图仅取自
          {UX_TERMS.gallery}。
        </div>
      </div>

      {errorMsg && (
        <Alert
          type="error"
          showIcon
          closable
          message={errorMsg}
          onClose={() => setErrorMsg(null)}
        />
      )}

      {feedbackMsg && (
        <Alert
          type="success"
          showIcon
          closable
          message={feedbackMsg}
          onClose={() => setFeedbackMsg(null)}
        />
      )}

      {/* Filter Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '12px 16px',
          background: 'var(--gm-bg-surface)',
          border: '1px solid var(--gm-line-1)',
          borderRadius: 8,
        }}
      >
        <Input.Search
          allowClear
          placeholder="搜索任务名称或流量关键词"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onSearch={(val) =>
            setQuery((prev) => ({ ...prev, page: 1, keyword: val.trim() || undefined }))
          }
          style={{ width: 240 }}
        />
        <select
          aria-label="筛选任务状态"
          style={COMPACT_SELECT_STYLE}
          value={query.status ?? ''}
          onChange={(e) =>
            setQuery((prev) => ({
              ...prev,
              page: 1,
              status: (e.target.value || undefined) as TaskStatusName | undefined,
            }))
          }
        >
          <option value="">全部任务状态</option>
          {TASK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {REWRITE_BATCH_STATUS_LABELS[st] ?? st}
            </option>
          ))}
        </select>

        <select
          aria-label="筛选寻源方式"
          style={COMPACT_SELECT_STYLE}
          value={query.sourceType ?? ''}
          onChange={(e) =>
            setQuery((prev) => ({
              ...prev,
              page: 1,
              sourceType: (e.target.value || undefined) as RewriteBatchSourceType | undefined,
            }))
          }
        >
          <option value="">全部寻源方式</option>
          {REWRITE_BATCH_SOURCE_TYPES.map((st) => (
            <option key={st} value={st}>
              {REWRITE_BATCH_SOURCE_LABELS[st]}
            </option>
          ))}
        </select>
      </div>

      {/* Unified Toolbar */}
      <CrudToolbar
        style={{ marginBottom: 0 }}
        showCreate={!readOnly}
        createLabel="新建批量复刻"
        createDisabled={busy}
        onCreate={() => void openCreateModal()}
        refreshLabel="刷新列表"
        refreshDisabled={loading || busy}
        onRefresh={() => void loadList(query)}
        showDelete={!readOnly}
        deleteLabel="批量删除"
        deleteDisabled={busy || selectedIds.length === 0}
        onDelete={() => setBulkDeleteConfirmOpen(true)}
        extraLeft={
          !readOnly && selectedIds.length > 0 ? (
            <Typography.Text type="secondary">已选 {selectedIds.length} 项</Typography.Text>
          ) : null
        }
        right={
          <ExportAction
            disabled={busy}
            empty={!loading && total === 0 && items.length === 0}
            onExport={handleExport}
          />
        }
      />

      {/* Minimized Draft Bar */}
      {modalState?.minimized && (
        <Alert
          type="info"
          showIcon
          message={`已最小化草稿：${modalState.draft.name || '未命名批量复刻任务'}（预冻 ${estimatedFreezePoints} 点数）`}
          action={
            <Space>
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  setModalState((prev) => (prev ? { ...prev, minimized: false } : null))
                }
              >
                恢复窗口
              </Button>
              <Button size="small" onClick={requestCloseModal}>
                关闭草稿
              </Button>
            </Space>
          }
        />
      )}

      {/* Main Batch Table */}
      <div
        style={{
          background: 'var(--gm-bg-surface)',
          border: '1px solid var(--gm-line-1)',
          borderRadius: 8,
          padding: 12,
        }}
      >
        <Table<RewriteBatchItem>
          rowKey="id"
          loading={loading}
          dataSource={items}
          scroll={{ x: 1240 }}
          locale={{ emptyText: CRUD_EMPTY_TEXT }}
          rowSelection={
            readOnly
              ? undefined
              : {
                  selectedRowKeys: selectedIds,
                  onChange: (keys) => setSelectedIds(keys.map(String)),
                  getCheckboxProps: (record) => ({
                    disabled: !isTerminalBatchStatus(record.status),
                  }),
                }
          }
          pagination={{
            current: query.page,
            pageSize: query.pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: CRUD_PAGE_SIZES.map(String),
            showTotal: (count) => `共 ${count} 个批量复刻任务`,
            onChange: (nextPage, nextSize) =>
              setQuery((prev) => ({
                ...prev,
                page: nextPage,
                pageSize: (CRUD_PAGE_SIZES.includes(nextSize as (typeof CRUD_PAGE_SIZES)[number])
                  ? nextSize
                  : 25) as RewriteBatchListQuery['pageSize'],
              })),
          }}
          columns={[
            {
              title: '序号',
              key: 'seq',
              width: 60,
              render: (_val: unknown, _row: RewriteBatchItem, idx: number) =>
                (query.page - 1) * query.pageSize + idx + 1,
            },
            {
              title: '任务名',
              dataIndex: 'name',
              key: 'name',
              width: 200,
              minWidth: 180,
              ellipsis: { showTitle: false },
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div style={{ display: 'grid', gap: 2, minWidth: 165, whiteSpace: 'normal' }}>
                  <TableClampText
                    text={row.name}
                    lines={2}
                    strong
                    tooltipThreshold={18}
                    style={{ color: 'var(--gm-fg-1)' }}
                  />
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--gm-fg-3)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span style={{ flex: 'none' }}>归档分类：</span>
                    <Button
                      type="link"
                      size="small"
                      title={row.categoryName || '查看分类文章'}
                      style={{
                        padding: 0,
                        height: 'auto',
                        fontSize: 12,
                        maxWidth: 120,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'inline-block',
                      }}
                      onClick={() =>
                        navigateTo(
                          `/writing/articles?categoryId=${encodeURIComponent(row.categoryId)}`,
                        )
                      }
                    >
                      {row.categoryName || '查看分类文章'}
                    </Button>
                  </div>
                </div>
              ),
            },
            {
              title: '关键词',
              dataIndex: 'keyword',
              key: 'keyword',
              width: 190,
              minWidth: 160,
              ellipsis: { showTitle: false },
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div style={{ display: 'grid', gap: 4, minWidth: 145, whiteSpace: 'normal' }}>
                  <Space size={6} wrap>
                    <Tag
                      color={row.sourceType === 'link_list' ? 'geekblue' : 'purple'}
                      style={{ margin: 0, whiteSpace: 'nowrap' }}
                    >
                      {REWRITE_BATCH_SOURCE_LABELS[row.sourceType] ?? row.sourceType}
                    </Tag>
                    {row.brand ? (
                      <Tag color="cyan" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                        品牌：{row.brand}
                      </Tag>
                    ) : null}
                  </Space>
                  <TableClampText
                    text={row.keyword || `链接清单（${row.candidateCount} 条候选）`}
                    lines={2}
                    tooltipThreshold={18}
                    style={{ fontSize: 13 }}
                  />
                </div>
              ),
            },
            {
              title: '最大改写量',
              dataIndex: 'maxCount',
              key: 'maxCount',
              width: 105,
              render: (val: number) => <span className="gm-num">{val} 篇</span>,
            },
            {
              title: '当前数量',
              key: 'doneCount',
              width: 175,
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div>
                  <div className="gm-num" style={{ fontWeight: 600 }}>
                    {row.doneCount} / {row.maxCount} 篇
                  </div>
                  <div className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                    预冻 {row.reservedPoints} · 已结 {row.settledPoints} · 已退 {row.releasedPoints}{' '}
                    点
                  </div>
                </div>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              width: 215,
              minWidth: 185,
              ellipsis: { showTitle: false },
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div style={{ display: 'grid', gap: 4, minWidth: 170, whiteSpace: 'normal' }}>
                  <div>
                    <Tag color={batchStatusTagColor(row.status)}>
                      {REWRITE_BATCH_STATUS_LABELS[row.status] ?? row.status}
                    </Tag>
                  </div>
                  {row.note && (
                    <TableClampText
                      text={row.note}
                      lines={2}
                      tooltipThreshold={26}
                      style={{
                        fontSize: 12,
                        color: row.status === 'FAILED' ? 'var(--gm-danger)' : 'var(--gm-fg-2)',
                        lineHeight: 1.4,
                      }}
                    />
                  )}
                </div>
              ),
            },
            {
              title: '查看任务',
              key: 'inspect',
              width: 115,
              render: (_val: unknown, row: RewriteBatchItem) => (
                <Button size="small" onClick={() => void openTaskDrawer(row.id)}>
                  查看任务 ({row.candidateCount || row.doneCount})
                </Button>
              ),
            },
            {
              title: '添加时间',
              dataIndex: 'createdAt',
              key: 'createdAt',
              width: 140,
              render: (val: string) => (
                <span className="gm-num" style={{ fontSize: 13, color: 'var(--gm-fg-2)' }}>
                  {formatTime(val)}
                </span>
              ),
            },
            {
              title: '操作',
              key: 'actions',
              width: 155,
              fixed: 'right',
              render: (_val: unknown, row: RewriteBatchItem) => {
                if (readOnly) return <Typography.Text type="secondary">只读</Typography.Text>;
                return (
                  <Space size={6} wrap>
                    {(row.status === 'QUEUED' || row.status === 'RUNNING') && (
                      <Button
                        size="small"
                        onClick={() => void handleControl(row, 'pause')}
                        disabled={busy}
                      >
                        暂停
                      </Button>
                    )}
                    {row.status === 'PAUSED' && (
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        onClick={() => void handleControl(row, 'resume')}
                        disabled={busy}
                      >
                        继续
                      </Button>
                    )}
                    {(row.status === 'QUEUED' ||
                      row.status === 'RUNNING' ||
                      row.status === 'PAUSED') && (
                      <Button
                        size="small"
                        danger
                        onClick={() => void handleControl(row, 'cancel')}
                        disabled={busy}
                      >
                        终止退点
                      </Button>
                    )}
                    {isTerminalBatchStatus(row.status) && (
                      <Button
                        size="small"
                        danger
                        onClick={() => void handleDeleteOne(row)}
                        disabled={busy}
                      >
                        删除
                      </Button>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </div>

      {/* Create Batch Rewrite Modal */}
      {modalState && (
        <CrudModal
          open
          title="新建批量爆文复刻任务"
          minimized={modalState.minimized}
          maximized={modalState.maximized}
          confirmLoading={busy}
          error={modalError}
          ok={
            <Button type="primary" loading={busy} onClick={() => void handleSubmitCreate()}>
              {`开始批量复刻（${unitPoints}点数/篇，预冻 ${estimatedFreezePoints} 点）`}
            </Button>
          }
          onClose={requestCloseModal}
          onReset={() => {
            setModalError(null);
            setModalState((prev) => (prev ? { ...prev, draft: prev.initial } : null));
          }}
          onMinimize={() => setModalState((prev) => (prev ? { ...prev, minimized: true } : null))}
          onRestore={() => {
            setModalState((prev) => (prev ? { ...prev, minimized: false } : null));
            void loadOptions();
          }}
          onMaximize={() =>
            setModalState((prev) => (prev ? { ...prev, maximized: !prev.maximized } : null))
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Upfront Pricing & Refund Guarantee Banner */}
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--gm-bg-elevated)',
                border: '1px solid rgba(111,168,255,0.32)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div>
                <div className="gm-num" style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
                  计费标准：{unitPoints} 点数/篇 · 本次上限 {modalState.draft.maxCount} 篇
                </div>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 2 }}>
                  按成功生成篇数逐篇结算；单链失败、防爬拦截、超时无响应或凑满即停时，剩余点数自动全额退回账户，不占用
                  AI 写作配额。
                </div>
              </div>
            </div>

            {/* Task Name & Max Count */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  任务名称 <span style={{ color: 'var(--gm-danger)' }}>*</span>
                </div>
                <Input
                  aria-label="任务名称"
                  placeholder="例如：行业技术干货批量复刻"
                  maxLength={REWRITE_BATCH_NAME_MAX}
                  value={modalState.draft.name}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev ? { ...prev, draft: { ...prev.draft, name: e.target.value } } : null,
                    )
                  }
                />
              </div>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  最大改写量（凑满即停） <span style={{ color: 'var(--gm-danger)' }}>*</span>
                </div>
                <InputNumber
                  aria-label="最大改写量"
                  min={REWRITE_BATCH_MAX_COUNT_MIN}
                  max={REWRITE_BATCH_MAX_COUNT_MAX}
                  precision={0}
                  style={{ width: '100%' }}
                  value={modalState.draft.maxCount}
                  onChange={(val) =>
                    setModalState((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: {
                              ...prev.draft,
                              maxCount: typeof val === 'number' ? val : 1,
                            },
                          }
                        : null,
                    )
                  }
                />
              </div>
            </div>

            {/* Source Type Selector */}
            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>候选寻源方式</div>
              <Radio.Group
                value={modalState.draft.sourceType}
                onChange={(e) => {
                  const nextType = e.target.value as RewriteBatchSourceType;
                  if (nextType === 'remote' && !remoteSearchEnabled) {
                    return;
                  }
                  setModalError(null);
                  setModalState((prev) =>
                    prev
                      ? {
                          ...prev,
                          draft: {
                            ...prev.draft,
                            sourceType: nextType,
                          },
                        }
                      : null,
                  );
                }}
              >
                <Radio.Button value="link_list">
                  粘贴公开文章链接清单（默认推荐，最多 {REWRITE_BATCH_LINK_LIST_MAX} 条）
                </Radio.Button>
                <Radio.Button value="remote" disabled={!remoteSearchEnabled}>
                  {remoteSearchEnabled ? '关键词全网搜索' : '关键词全网搜索（暂未开通）'}
                </Radio.Button>
              </Radio.Group>
              {!remoteSearchEnabled && (
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, marginTop: 6 }}
                >
                  当前环境未配置第三方搜索源，「关键词全网搜索」暂未开通，请使用「粘贴公开文章链接清单」。
                </Typography.Text>
              )}
            </div>

            {modalState.draft.sourceType === 'link_list' ? (
              <>
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>
                      公开文章链接清单（一行一条）{' '}
                      <span style={{ color: 'var(--gm-danger)' }}>*</span>
                    </span>
                    {draftLinkAnalysis && (
                      <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                        有效候选 <b>{draftLinkAnalysis.candidates.length}</b> 条
                        {draftLinkAnalysis.duplicateLines.length > 0
                          ? ` · 去重 ${draftLinkAnalysis.duplicateLines.length} 条`
                          : ''}
                        {draftLinkAnalysis.excludedLines.length > 0
                          ? ` · 自动排除视频/商品页 ${draftLinkAnalysis.excludedLines.length} 条`
                          : ''}
                        {draftLinkAnalysis.invalidLines.length > 0
                          ? ` · 异常链接 ${draftLinkAnalysis.invalidLines.length} 条`
                          : ''}
                      </span>
                    )}
                  </div>
                  <Input.TextArea
                    aria-label="公开文章链接清单"
                    rows={5}
                    placeholder={
                      'https://mp.weixin.qq.com/s/example-article-1\nhttps://zhuanlan.zhihu.com/p/12345678\n（一行一条公开技术/行业文章链接，单次最多 50 条；若候选多于最大改写量，成功凑满后立即停止）'
                    }
                    value={modalState.draft.linksText}
                    onChange={(e) =>
                      setModalState((prev) =>
                        prev
                          ? { ...prev, draft: { ...prev.draft, linksText: e.target.value } }
                          : null,
                      )
                    }
                  />
                  {draftLinkAnalysis && draftLinkAnalysis.invalidLines.length > 0 && (
                    <Alert
                      style={{ marginTop: 8 }}
                      type="warning"
                      showIcon
                      message={`第 ${draftLinkAnalysis.invalidLines[0]!.line} 行：${draftLinkAnalysis.invalidLines[0]!.reason}`}
                    />
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 500, marginBottom: 6 }}>主题标签 / 备注词（选填）</div>
                  <Input
                    aria-label="主题标签"
                    placeholder="选填，便于在列表中按关键词检索归类（切勿在此填入 URL）"
                    value={modalState.draft.keyword}
                    onChange={(e) =>
                      setModalState((prev) =>
                        prev
                          ? { ...prev, draft: { ...prev.draft, keyword: e.target.value } }
                          : null,
                      )
                    }
                  />
                  {keywordIsUrlWarning && (
                    <Alert
                      style={{ marginTop: 8 }}
                      type="error"
                      showIcon
                      message={REWRITE_BATCH_URL_AS_KEYWORD_MSG}
                    />
                  )}
                </div>
              </>
            ) : (
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  流量关键词 <span style={{ color: 'var(--gm-danger)' }}>*</span>
                </div>
                <Input
                  aria-label="流量关键词"
                  placeholder="请输入行业或产品关键词（例如：企业数字化转型方案），切勿填写网页链接"
                  value={modalState.draft.keyword}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev ? { ...prev, draft: { ...prev.draft, keyword: e.target.value } } : null,
                    )
                  }
                />
                {keywordIsUrlWarning && (
                  <Alert
                    style={{ marginTop: 8 }}
                    type="error"
                    showIcon
                    message={REWRITE_BATCH_URL_AS_KEYWORD_MSG}
                  />
                )}
                {!remoteSearchEnabled && !keywordIsUrlWarning && (
                  <Alert
                    style={{ marginTop: 8 }}
                    type="info"
                    showIcon
                    message="当前工作区默认使用「粘贴公开文章链接清单」寻源（未配置第三方全网搜索密钥），建议切换回链接清单模式直接粘贴目标文章 URL。"
                  />
                )}
              </div>
            )}

            {/* Gallery & Rewrite Prompt */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    文章配图（{UX_TERMS.gallery}）
                    {!modalState.draft.noImage ? (
                      <>
                        {' '}
                        <span style={{ color: 'var(--gm-danger)' }}>*</span>
                      </>
                    ) : null}
                  </span>
                  {onDispatch ? (
                    <Button
                      type="link"
                      size="small"
                      htmlType="button"
                      style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateTo('/material/gallery');
                      }}
                    >
                      管理图库
                    </Button>
                  ) : null}
                </div>
                <select
                  aria-label="文章配图图库分类"
                  style={NATIVE_SELECT_STYLE}
                  value={
                    modalState.draft.noImage
                      ? NO_IMAGE_GALLERY_VALUE
                      : modalState.draft.mediaCategoryId
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === NO_IMAGE_GALLERY_VALUE) {
                      setModalState((prev) =>
                        prev
                          ? {
                              ...prev,
                              draft: { ...prev.draft, mediaCategoryId: '', noImage: true },
                            }
                          : null,
                      );
                      return;
                    }
                    setModalState((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: { ...prev.draft, mediaCategoryId: val, noImage: false },
                          }
                        : null,
                    );
                  }}
                >
                  <option value="">不选择</option>
                  <option value={NO_IMAGE_GALLERY_VALUE}>不配图（0 张，不使用来源站原图）</option>
                  {(formOptions?.mediaCategories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}（{cat.assetCount} 张可用）
                    </option>
                  ))}
                </select>
                {mediaCategoriesWithImages.length === 0 ? (
                  <Alert
                    style={{ marginTop: 6 }}
                    type="warning"
                    showIcon
                    message={
                      <span>
                        当前暂无含图片的{UX_TERMS.gallery}
                        分类，已默认设为「不配图（0 张）」可直接提交，或
                        {onDispatch ? (
                          <Button
                            type="link"
                            size="small"
                            htmlType="button"
                            style={{ padding: '0 4px', height: 'auto' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateTo('/material/gallery');
                            }}
                          >
                            前往上传配图
                          </Button>
                        ) : null}
                      </span>
                    }
                  />
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
                    {modalState.draft.noImage
                      ? '已选择不配图（0 张）：正文不插入图片且严禁使用来源站原图。'
                      : '按原文篇幅自动插图（<600字 1 张 / 600字以上 2 张），严禁使用来源站原图。'}
                    {!modalState.draft.noImage &&
                      selectedMediaCat &&
                      selectedMediaCat.assetCount === 0 && (
                        <span style={{ color: 'var(--gm-danger)', marginLeft: 4 }}>
                          当前{UX_TERMS.gallery}分类暂无图片，请先上传图片或选择「不配图（0 张）」！
                        </span>
                      )}
                  </div>
                )}
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    爆文改写指令（仅流量复刻类型）{' '}
                    <span style={{ color: 'var(--gm-danger)' }}>*</span>
                  </span>
                  {onDispatch ? (
                    <Button
                      type="link"
                      size="small"
                      htmlType="button"
                      style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateTo('/writing/prompts');
                      }}
                    >
                      管理指令
                    </Button>
                  ) : null}
                </div>
                <select
                  aria-label="爆文改写指令"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.templateId}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev
                        ? { ...prev, draft: { ...prev.draft, templateId: e.target.value } }
                        : null,
                    )
                  }
                >
                  <option value="">不选择</option>
                  {(formOptions?.rewriteTemplates ?? []).map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.isSystem ? `[系统] ${tpl.name}` : tpl.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category, Brand & Result Status */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>归档文章分类</span>
                  {onDispatch ? (
                    <Button
                      type="link"
                      size="small"
                      htmlType="button"
                      style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateTo('/writing/categories');
                      }}
                    >
                      管理分类
                    </Button>
                  ) : null}
                </div>
                <select
                  aria-label="归档文章分类"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.categoryId}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev
                        ? { ...prev, draft: { ...prev.draft, categoryId: e.target.value } }
                        : null,
                    )
                  }
                >
                  <option value="">自动新建（{modalState.draft.autoCategoryName}）</option>
                  {(formOptions?.categories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>自然融入品牌词（选填）</div>
                <Input
                  aria-label="品牌词融入"
                  placeholder="选填：重组时自然提及，不替换原文推荐品牌"
                  maxLength={40}
                  value={modalState.draft.brand}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev ? { ...prev, draft: { ...prev.draft, brand: e.target.value } } : null,
                    )
                  }
                />
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  {UX_TERMS.postGenerateArticleStatus}
                </div>
                <select
                  aria-label={UX_TERMS.postGenerateArticleStatus}
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.resultStatus}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: {
                              ...prev.draft,
                              resultStatus: e.target.value as RewriteResultStatusName,
                            },
                          }
                        : null,
                    )
                  }
                >
                  <option value="PENDING">{REWRITE_RESULT_STATUS_LABELS.PENDING}</option>
                  <option value="NORMAL">{REWRITE_RESULT_STATUS_LABELS.NORMAL}</option>
                </select>
              </div>
            </div>
          </div>
        </CrudModal>
      )}

      {/* Task Detail Drawer ("查看任务") */}
      <Drawer
        open={drawerOpen}
        width={880}
        title={drawerDetail ? `查看任务明细 · ${drawerDetail.batch.name}` : '查看批量爆文复刻明细'}
        onClose={() => setDrawerOpen(false)}
        extra={
          drawerDetail && (
            <Space>
              <Button
                size="small"
                onClick={() => void openTaskDrawer(drawerDetail.batch.id)}
                disabled={drawerLoading}
              >
                刷新进度
              </Button>
              <Button
                size="small"
                type="primary"
                ghost
                onClick={() =>
                  navigateTo(
                    `/writing/articles?categoryId=${encodeURIComponent(drawerDetail.batch.categoryId)}`,
                  )
                }
              >
                打开归档文章列表
              </Button>
            </Space>
          )
        }
      >
        {drawerDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务状态">
                <Tag color={batchStatusTagColor(drawerDetail.batch.status)}>
                  {REWRITE_BATCH_STATUS_LABELS[drawerDetail.batch.status] ??
                    drawerDetail.batch.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="完成进度">
                <b>
                  {drawerDetail.batch.doneCount} / {drawerDetail.batch.maxCount}
                </b>{' '}
                篇（候选 {drawerDetail.batch.candidateCount} 条）
              </Descriptions.Item>
              <Descriptions.Item label="寻源方式">
                {REWRITE_BATCH_SOURCE_LABELS[drawerDetail.batch.sourceType]}
                {drawerDetail.batch.keyword ? ` · ${drawerDetail.batch.keyword}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="点数对账">
                预冻 <b>{drawerDetail.batch.reservedPoints}</b> 点 · 已结{' '}
                <b>{drawerDetail.batch.settledPoints}</b> 点 · 已退{' '}
                <b>{drawerDetail.batch.releasedPoints}</b> 点
              </Descriptions.Item>
              <Descriptions.Item label="配图图库 / 改写指令">
                {drawerDetail.batch.mediaCategoryName ?? '—'} /{' '}
                {drawerDetail.batch.templateName ?? drawerDetail.batch.templateId}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {formatTime(drawerDetail.batch.createdAt)}
              </Descriptions.Item>
              {drawerDetail.batch.brand && (
                <Descriptions.Item label="融入品牌词" span={2}>
                  {drawerDetail.batch.brand}
                </Descriptions.Item>
              )}
              {drawerDetail.batch.note && (
                <Descriptions.Item label="结算与执行说明" span={2}>
                  {drawerDetail.batch.note}
                </Descriptions.Item>
              )}
            </Descriptions>

            <Table<RewriteRecordItem>
              rowKey="id"
              size="small"
              loading={drawerLoading}
              dataSource={drawerDetail.records}
              scroll={{ x: 830 }}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              locale={{ emptyText: '暂无候选处理记录' }}
              columns={[
                {
                  title: '#',
                  key: 'idx',
                  width: 48,
                  render: (_v: unknown, _r: RewriteRecordItem, idx: number) => idx + 1,
                },
                {
                  title: '候选源链接 / 原标题',
                  key: 'source',
                  width: 235,
                  minWidth: 200,
                  ellipsis: { showTitle: false },
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div style={{ display: 'grid', gap: 2, minWidth: 185, whiteSpace: 'normal' }}>
                      <TableClampText
                        text={rec.sourceTitle || '待抓取标题'}
                        lines={2}
                        strong
                        tooltipThreshold={22}
                      />
                      <TableClampText
                        text={rec.url}
                        lines={1}
                        tooltipThreshold={28}
                        style={{ fontSize: 12, color: 'var(--gm-fg-3)', wordBreak: 'break-all' }}
                      />
                    </div>
                  ),
                },
                {
                  title: '复刻新标题',
                  key: 'newTitle',
                  width: 215,
                  minWidth: 185,
                  ellipsis: { showTitle: false },
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div style={{ display: 'grid', gap: 4, minWidth: 170, whiteSpace: 'normal' }}>
                      <TableClampText text={rec.newTitle} lines={2} tooltipThreshold={20} />
                      {rec.articleStatus && (
                        <div>
                          <Tag color={articleStatusTagColor(rec.articleStatus)}>
                            {ARTICLE_STATUS_LABEL[rec.articleStatus]}
                          </Tag>
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: '5-gram 相似度',
                  key: 'similarity',
                  width: 115,
                  render: (_v: unknown, rec: RewriteRecordItem) => {
                    if (rec.similarity === null || rec.similarity === undefined) return '—';
                    const pct = `${(rec.similarity * 100).toFixed(1)}%`;
                    return (
                      <Tag color={rec.highSimilarity ? 'warning' : 'green'}>
                        {pct}
                        {rec.highSimilarity ? ' 偏高' : ''}
                      </Tag>
                    );
                  },
                },
                {
                  title: '状态 / 说明',
                  key: 'status',
                  width: 205,
                  minWidth: 175,
                  ellipsis: { showTitle: false },
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div style={{ display: 'grid', gap: 3, minWidth: 160, whiteSpace: 'normal' }}>
                      <div>
                        <Tag color={itemStatusTagColor(rec.status)}>
                          {ITEM_STATUS_LABELS[rec.status] ?? rec.status}
                        </Tag>
                      </div>
                      {rec.error && (
                        <TableClampText
                          text={rec.error}
                          lines={2}
                          tooltipThreshold={26}
                          style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
                        />
                      )}
                    </div>
                  ),
                },
                {
                  title: '操作',
                  key: 'go',
                  width: 90,
                  fixed: 'right',
                  render: (_v: unknown, rec: RewriteRecordItem) =>
                    rec.articleId ? (
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0 }}
                        onClick={() =>
                          navigateTo(
                            `/writing/articles?categoryId=${encodeURIComponent(
                              rec.categoryId ?? drawerDetail.batch.categoryId,
                            )}`,
                          )
                        }
                      >
                        查看文章
                      </Button>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal
        open={bulkDeleteConfirmOpen}
        title={`确认删除选中的 ${selectedIds.length} 条批量复刻任务？`}
        okText="确认删除"
        cancelText="取消"
        centered
        destroyOnHidden
        okButtonProps={{ danger: true, loading: busy }}
        onCancel={() => {
          if (!busy) setBulkDeleteConfirmOpen(false);
        }}
        onOk={() => void handleBulkDelete()}
      >
        <Typography.Text type="secondary">删除任务记录不会删除已生成的文章正文。</Typography.Text>
      </Modal>
    </div>
  );
}
