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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import {
  httpRewriteBatchGateway,
  type RewriteBatchFormOptions,
  type RewriteBatchGateway,
} from '../../lib/rewrite-batches';
import type { RewriteDownloadFile } from '../../lib/rewrites';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_MAX_COUNT = 1;

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 14,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 13,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

type CreateDraft = {
  name: string;
  maxCount: number;
  sourceType: RewriteBatchSourceType;
  keyword: string;
  linksText: string;
  mediaCategoryId: string;
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

function buildInitialDraft(_options: RewriteBatchFormOptions | null): CreateDraft {
  return {
    name: '',
    maxCount: DEFAULT_BATCH_MAX_COUNT,
    sourceType: 'link_list',
    keyword: '',
    linksText: '',
    mediaCategoryId: '',
    templateId: '',
    categoryId: '',
    autoCategoryName: buildDefaultBatchCategoryName('批量爆文'),
    resultStatus: 'PENDING',
    brand: '',
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
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

function triggerBrowserDownload(file: RewriteDownloadFile): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([new Uint8Array(file.body)], { type: file.mime });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function RewriteBatchScreen({
  title,
  tabId,
  readOnly = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  storage,
  gateway: injectedGateway,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  readOnly?: boolean;
  pollIntervalMs?: number;
  storage?: SessionStorageLike;
  gateway?: RewriteBatchGateway;
  onDispatch?: (action: ShellAction) => void;
}) {
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

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerDetail, setDrawerDetail] = useState<RewriteBatchDetailResponse | null>(null);

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
    } catch {
      return null;
    }
  }, [gateway]);

  useEffect(() => {
    void loadList(query);
  }, [loadList, query]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const hasActiveBatch = useMemo(
    () =>
      items.some((b) => isActiveBatchStatus(b.status)) ||
      (drawerOpen && drawerDetail !== null && isActiveBatchStatus(drawerDetail.batch.status)),
    [drawerDetail, drawerOpen, items],
  );

  useEffect(() => {
    if (!hasActiveBatch || pollIntervalMs <= 0) return undefined;
    const timer = setInterval(() => {
      void loadList(query, true);
      if (drawerOpen && drawerDetail && isActiveBatchStatus(drawerDetail.batch.status)) {
        void gateway
          .detail(drawerDetail.batch.id)
          .then((detail) => setDrawerDetail(detail))
          .catch(() => undefined);
      }
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [drawerDetail, drawerOpen, gateway, hasActiveBatch, loadList, pollIntervalMs, query]);

  const navigateTo = useCallback(
    (href: string) => {
      if (!onDispatch) return;
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
    const opts = formOptions ?? (await loadOptions());
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

    if (!draft.name.trim()) {
      setModalError('请填写任务名称');
      return;
    }
    if (draft.name.trim().length > REWRITE_BATCH_NAME_MAX) {
      setModalError(`任务名称不超过 ${REWRITE_BATCH_NAME_MAX} 个字符`);
      return;
    }
    if (
      !Number.isInteger(draft.maxCount) ||
      draft.maxCount < REWRITE_BATCH_MAX_COUNT_MIN ||
      draft.maxCount > REWRITE_BATCH_MAX_COUNT_MAX
    ) {
      setModalError(
        `最大改写量须在 ${REWRITE_BATCH_MAX_COUNT_MIN}–${REWRITE_BATCH_MAX_COUNT_MAX} 篇之间`,
      );
      return;
    }

    if (draft.sourceType === 'remote') {
      if (!draft.keyword.trim()) {
        setModalError('关键词全网搜索模式下请填写流量关键词');
        return;
      }
      if (looksLikeUrlNotKeyword(draft.keyword)) {
        setModalError(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
        return;
      }
      if (!remoteSearchEnabled) {
        setModalError(
          '当前环境尚未启用联网关键词检索源，请切换至「粘贴链接清单」模式提交公开文章 URL',
        );
        return;
      }
    } else {
      if (draft.keyword.trim() && looksLikeUrlNotKeyword(draft.keyword)) {
        setModalError(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
        return;
      }
      const parsed = parseBatchLinkList(draft.linksText, REWRITE_BATCH_LINK_LIST_MAX);
      if (parsed.nonEmptyCount === 0) {
        setModalError('请至少粘贴 1 条公开文章链接（一行一条）');
        return;
      }
      if (parsed.invalidLines.length > 0) {
        const first = parsed.invalidLines[0]!;
        setModalError(`第 ${first.line} 行链接不合法：${first.reason}`);
        return;
      }
      if (parsed.candidates.length === 0) {
        const firstExcl = parsed.excludedLines[0];
        setModalError(
          firstExcl
            ? `全部候选链接均不可用于正文复刻（第 ${firstExcl.line} 行：${firstExcl.reason}）`
            : '没有可用的有效文章链接',
        );
        return;
      }
    }

    if (!draft.mediaCategoryId) {
      setModalError('请选择文章配图图库分类（图库无图时请先前往我的图库上传图片）');
      return;
    }
    if (!draft.templateId) {
      setModalError('请选择爆文改写指令');
      return;
    }

    const payload: RewriteBatchCreateInput = {
      name: draft.name.trim(),
      maxCount: draft.maxCount,
      sourceType: draft.sourceType,
      keyword: draft.keyword.trim(),
      linksText: draft.sourceType === 'link_list' ? draft.linksText : undefined,
      mediaCategoryId: draft.mediaCategoryId,
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
      await Promise.all([loadList({ ...query, page: 1 }), loadOptions()]);
      setDrawerDetail(created);
      setDrawerOpen(true);
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
      await loadList(query);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '批量删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (format: CrudExportFormat) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const file = await gateway.downloadTable(query, format);
      triggerBrowserDownload(file);
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
    Modal.confirm({
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
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          padding: '14px 18px',
          background: '#ffffff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
        }}
      >
        <div>
          <Space size={10} align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {title}
            </Typography.Title>
            <Tag color="blue">{unitPoints} 点数/篇 · 预冻按成功篇数结算</Tag>
            <Tag color="cyan">凑满最大改写量即停 · 差额自动退还</Tag>
          </Space>
          <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>
            默认支持粘贴最多 {REWRITE_BATCH_LINK_LIST_MAX}{' '}
            条公开文章链接批量抓取与结构重构；单链失败或超时自动跳过不扣点，所有插图仅取自商户自有图库。
          </div>
        </div>

        <Space wrap>
          <Button onClick={() => void handleExport('csv')} disabled={busy}>
            导出 CSV
          </Button>
          <Button onClick={() => void handleExport('xlsx')} disabled={busy}>
            导出 XLSX
          </Button>
          {!readOnly && (
            <Button type="primary" onClick={() => void openCreateModal()} disabled={busy}>
              新建批量复刻
            </Button>
          )}
        </Space>
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

      {/* Filter & Bulk Action Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '12px 16px',
          background: '#ffffff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
        }}
      >
        <Space wrap>
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

          <Button onClick={() => void loadList(query)} disabled={loading || busy}>
            刷新列表
          </Button>
        </Space>

        {!readOnly && selectedIds.length > 0 && (
          <Space>
            <Typography.Text type="secondary">已选 {selectedIds.length} 项</Typography.Text>
            <Button danger onClick={() => void handleBulkDelete()} disabled={busy}>
              批量删除
            </Button>
          </Space>
        )}
      </div>

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
          background: '#ffffff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: 12,
        }}
      >
        <Table<RewriteBatchItem>
          rowKey="id"
          loading={loading}
          dataSource={items}
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
              title: '任务名',
              dataIndex: 'name',
              key: 'name',
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div>
                  <div style={{ fontWeight: 600, color: '#1f1f1f' }}>{row.name}</div>
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                    归档分类：
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 'auto', fontSize: 12 }}
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
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div>
                  <Space size={6} wrap>
                    <Tag color={row.sourceType === 'link_list' ? 'geekblue' : 'purple'}>
                      {REWRITE_BATCH_SOURCE_LABELS[row.sourceType] ?? row.sourceType}
                    </Tag>
                    <span>{row.keyword || `链接清单（${row.candidateCount} 条候选）`}</span>
                  </Space>
                </div>
              ),
            },
            {
              title: '最大改写量',
              dataIndex: 'maxCount',
              key: 'maxCount',
              width: 110,
              render: (val: number) => <span>{val} 篇</span>,
            },
            {
              title: '当前数量',
              key: 'doneCount',
              width: 190,
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {row.doneCount} / {row.maxCount} 篇
                  </div>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
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
              width: 220,
              render: (_val: unknown, row: RewriteBatchItem) => (
                <div>
                  <Tag color={batchStatusTagColor(row.status)}>
                    {REWRITE_BATCH_STATUS_LABELS[row.status] ?? row.status}
                  </Tag>
                  {row.note && (
                    <div
                      style={{
                        fontSize: 12,
                        color: row.status === 'FAILED' ? '#cf1322' : '#666',
                        marginTop: 4,
                        lineHeight: 1.4,
                      }}
                    >
                      {row.note}
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: '查看任务',
              key: 'inspect',
              width: 120,
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
              width: 150,
              render: (val: string) => (
                <span style={{ fontSize: 13, color: '#595959' }}>{formatTime(val)}</span>
              ),
            },
            {
              title: '操作',
              key: 'actions',
              width: 180,
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
          onRestore={() => setModalState((prev) => (prev ? { ...prev, minimized: false } : null))}
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
                background: '#f0f5ff',
                border: '1px solid #adc6ff',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: '#1d39c4' }}>
                  计费标准：{unitPoints} 点数/篇 · 本次最多 {modalState.draft.maxCount} 篇 · 预冻结{' '}
                  {estimatedFreezePoints} 点数
                </div>
                <div style={{ fontSize: 12, color: '#595959', marginTop: 2 }}>
                  按成功生成篇数逐篇结算；单链失败、防爬拦截、超时无响应或凑满即停的剩余点数自动全额退回账户，不占用
                  AI 写作配额。
                </div>
              </div>
              <Tag color="blue" style={{ fontSize: 13, padding: '3px 10px' }}>
                预冻 {estimatedFreezePoints} 点
              </Tag>
            </div>

            {modalError && <Alert type="error" showIcon message={modalError} />}

            {/* Task Name & Max Count */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  任务名称 <span style={{ color: '#ff4d4f' }}>*</span>
                </div>
                <Input
                  aria-label="任务名称"
                  placeholder="例如：激光切割机行业技术干货批量复刻"
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
                  最大改写量（凑满即停） <span style={{ color: '#ff4d4f' }}>*</span>
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
                  setModalError(null);
                  setModalState((prev) =>
                    prev
                      ? {
                          ...prev,
                          draft: {
                            ...prev.draft,
                            sourceType: e.target.value as RewriteBatchSourceType,
                          },
                        }
                      : null,
                  );
                }}
              >
                <Radio.Button value="link_list">
                  粘贴公开文章链接清单（默认推荐，最多 {REWRITE_BATCH_LINK_LIST_MAX} 条）
                </Radio.Button>
                <Radio.Button value="remote">关键词全网搜索（检索适配器）</Radio.Button>
              </Radio.Group>
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
                      公开文章链接清单（一行一条） <span style={{ color: '#ff4d4f' }}>*</span>
                    </span>
                    {draftLinkAnalysis && (
                      <span style={{ fontSize: 12, color: '#595959' }}>
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
                  流量关键词 <span style={{ color: '#ff4d4f' }}>*</span>
                </div>
                <Input
                  aria-label="流量关键词"
                  placeholder="请输入行业或产品关键词（例如：光纤激光切割机选型），切勿填写网页链接"
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
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    文章配图（自有图库分类） <span style={{ color: '#ff4d4f' }}>*</span>
                  </span>
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => navigateTo('/material/gallery')}
                  >
                    管理图库
                  </Button>
                </div>
                <select
                  aria-label="文章配图图库分类"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.mediaCategoryId}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev
                        ? { ...prev, draft: { ...prev.draft, mediaCategoryId: e.target.value } }
                        : null,
                    )
                  }
                >
                  <option value="">不选择</option>
                  {(formOptions?.mediaCategories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}（{cat.assetCount} 张可用）
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                  按原文篇幅自动插图（&lt;600字 1 张 / 600字以上 2 张），严禁使用来源站原图。
                  {selectedMediaCat && selectedMediaCat.assetCount === 0 && (
                    <span style={{ color: '#cf1322', marginLeft: 4 }}>
                      当前图库分类暂无图片，请先上传图片！
                    </span>
                  )}
                </div>
              </div>

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
                    爆文改写指令（仅流量复刻类型） <span style={{ color: '#ff4d4f' }}>*</span>
                  </span>
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => navigateTo('/writing/prompts')}
                  >
                    管理指令
                  </Button>
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
                <div style={{ fontWeight: 500, marginBottom: 6 }}>归档文章分类</div>
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
                <div style={{ fontWeight: 500, marginBottom: 6 }}>品牌词融入（选填）</div>
                <Input
                  aria-label="品牌词融入"
                  placeholder="选填，自动替换第三方品牌提法"
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
                <div style={{ fontWeight: 500, marginBottom: 6 }}>复刻落库状态</div>
                <select
                  aria-label="复刻落库状态"
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
                  <option value="PENDING">
                    {REWRITE_RESULT_STATUS_LABELS.PENDING}（默认推荐）
                  </option>
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
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div>
                      <div style={{ fontWeight: 500 }}>{rec.sourceTitle || '待抓取标题'}</div>
                      <div
                        style={{
                          fontSize: 12,
                          color: '#8c8c8c',
                          wordBreak: 'break-all',
                          maxWidth: 260,
                        }}
                      >
                        {rec.url}
                      </div>
                    </div>
                  ),
                },
                {
                  title: '复刻新标题',
                  key: 'newTitle',
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div>
                      <div>{rec.newTitle || '—'}</div>
                      {rec.articleStatus && (
                        <Tag
                          color={articleStatusTagColor(rec.articleStatus)}
                          style={{ marginTop: 4 }}
                        >
                          {ARTICLE_STATUS_LABEL[rec.articleStatus]}
                        </Tag>
                      )}
                    </div>
                  ),
                },
                {
                  title: '5-gram 相似度',
                  key: 'similarity',
                  width: 120,
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
                  width: 190,
                  render: (_v: unknown, rec: RewriteRecordItem) => (
                    <div>
                      <Tag color={itemStatusTagColor(rec.status)}>
                        {ITEM_STATUS_LABELS[rec.status] ?? rec.status}
                      </Tag>
                      {rec.error && (
                        <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 3 }}>
                          {rec.error}
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: '操作',
                  key: 'go',
                  width: 90,
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
    </div>
  );
}
