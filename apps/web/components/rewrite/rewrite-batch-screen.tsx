'use client';

import {
  CRUD_EMPTY_TEXT,
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_SOURCE_LABELS,
  REWRITE_BATCH_STATUS_LABELS,
  type CrudExportFormat,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteBatchListQuery,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudToolbar } from '../crud/crud-toolbar';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import type { RewriteBatchFormOptions } from '../../lib/rewrite-batches';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { DEFAULT_TASK_POLL_INTERVAL_MS, useTaskPolling } from '../../lib/use-task-polling';
import { UX_TERMS, triggerBlobDownload } from '../../lib/ux-foundation';
import { RewriteBatchCreateModal } from './rewrite-batch-create-modal';
import { RewriteBatchDetailDrawer } from './rewrite-batch-detail-drawer';
import * as H from './rewrite-batch-helpers';

const S = H.BATCH_STYLES;

function BatchKeywordCell({ row }: { row: RewriteBatchItem }) {
  const srcColor = row.sourceType === 'link_list' ? 'geekblue' : 'purple';
  return (
    <div style={S.keywordCell}>
      <Space size={6} wrap>
        <Tag color={srcColor} style={S.compactTag}>
          {REWRITE_BATCH_SOURCE_LABELS[row.sourceType] ?? row.sourceType}
        </Tag>
        {row.brand && (
          <Tag color="cyan" style={S.compactTag}>
            品牌：{row.brand}
          </Tag>
        )}
      </Space>
      <TableClampText text={H.formatBatchKeywordSummary(row)} lines={2} tooltipThreshold={18} />
    </div>
  );
}

function BatchStatusCell({ row }: { row: RewriteBatchItem }) {
  return (
    <div style={S.statusCell}>
      <div>
        <Tag color={H.batchStatusTagColor(row.status)}>
          {REWRITE_BATCH_STATUS_LABELS[row.status] ?? row.status}
        </Tag>
      </div>
      {row.note && (
        <TableClampText
          text={row.note}
          lines={2}
          tooltipThreshold={26}
          style={H.getBatchNoteStyle(row.status)}
        />
      )}
    </div>
  );
}

export function RewriteBatchScreen({
  title,
  tabId,
  active = true,
  readOnly = false,
  pollIntervalMs = DEFAULT_TASK_POLL_INTERVAL_MS,
  storage,
  gateway: injectedGateway,
  onDispatch,
}: H.RewriteBatchScreenProps) {
  const gateway = useMemo(
    () => H.resolveRewriteBatchGateway(injectedGateway, storage),
    [injectedGateway, storage],
  );

  const [query, setQuery] = useState<RewriteBatchListQuery>({ page: 1, pageSize: 25 });
  const [keywordInput, setKeywordInput] = useState('');
  const [listData, setListData] = useState<H.BatchListState>(H.INITIAL_BATCH_LIST_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [formOptions, setFormOptions] = useState<RewriteBatchFormOptions | null>(null);
  const [createSession, setCreateSession] = useState<H.CreateSession | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [drawer, setDrawer] = useState<H.DrawerState>(H.INITIAL_DRAWER_STATE);

  const drawerRef = useRef<H.DrawerState>(drawer);
  drawerRef.current = drawer;
  const trackerRef = useRef<H.DrawerRequestTracker | null>(null);
  const tracker = (trackerRef.current ??= H.createDrawerRequestTracker());

  const applyDrawer = useCallback((next: H.DrawerState) => {
    drawerRef.current = next;
    setDrawer(next);
  }, []);

  const closeDrawer = useCallback(() => {
    tracker.close();
    applyDrawer(H.INITIAL_DRAWER_STATE);
  }, [applyDrawer, tracker]);

  const refreshDrawerSilently = useCallback(
    async (batchId: string) => {
      const reqSeq = tracker.seq;
      try {
        const detail = await tracker.fetchDetail(gateway, batchId);
        const prev = drawerRef.current;
        if (tracker.isCurrent(reqSeq) && prev.open && prev.detail?.batch.id === detail.batch.id) {
          applyDrawer({ ...prev, detail });
        }
      } catch {
        // 后台轮询或标签切回静默同步失败时不覆盖主列表错误提示
      }
    },
    [applyDrawer, gateway, tracker],
  );

  const loadList = useCallback(
    async (nextQuery: RewriteBatchListQuery, silent = false, syncDrawer = true) => {
      if (!silent) {
        setLoading(true);
        setErrorMsg(null);
      }
      try {
        const res = await gateway.list(nextQuery);
        setListData(H.toBatchListState(res));
        setSelectedIds((prev) => H.pruneTerminalSelection(prev, res.items));
        const cur = drawerRef.current;
        if (tracker.shouldAutoSync(cur, res.items, syncDrawer) && cur.detail) {
          await refreshDrawerSilently(cur.detail.batch.id);
        }
      } catch (err) {
        if (!silent) setErrorMsg(H.toErrorMessage(err, '加载批量爆文复刻列表失败'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [gateway, refreshDrawerSilently, tracker],
  );

  const loadOptions = useCallback(async () => {
    try {
      const opts = await gateway.loadFormOptions();
      setFormOptions(opts);
      setListData((prev) => H.mergeOptionsIntoListState(prev, opts));
      return opts;
    } catch (err) {
      setErrorMsg(H.toErrorMessage(err, '加载表单选项（文章分类/图库/指令）失败，请刷新重试'));
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
    onRefresh: (reason) => {
      void loadOptions();
      if (reason === 'activated') {
        const cur = drawerRef.current;
        const syncOpen = Boolean(cur.open && cur.detail);
        void loadList(query, true, !syncOpen);
        if (syncOpen && cur.detail) {
          void refreshDrawerSilently(cur.detail.batch.id);
        }
      }
    },
  });

  const { drawerBatchId, drawerBatchActive, hasActiveBatch, effectiveInterval } = useMemo(
    () => H.deriveBatchPollingState(listData.items, drawer, pollIntervalMs),
    [drawer, listData.items, pollIntervalMs],
  );

  useTaskPolling({
    enabled: hasActiveBatch,
    active,
    intervalMs: effectiveInterval,
    onPoll: async () => {
      const pollDrawer = Boolean(drawerBatchId && drawerBatchActive);
      await Promise.all([
        loadList(query, true, !pollDrawer),
        pollDrawer && drawerBatchId ? refreshDrawerSilently(drawerBatchId) : Promise.resolve(),
      ]);
    },
  });

  const navigateTo = useCallback(
    (href: string) => {
      if (!onDispatch) return;
      setCreateSession(null);
      closeDrawer();
      onDispatch({ type: 'open', href, sourceId: tabId });
    },
    [closeDrawer, onDispatch, tabId],
  );

  const openCreateModal = async () => {
    const opts = (await loadOptions()) ?? formOptions;
    setCreateSession((prev) => ({ id: (prev?.id ?? 0) + 1, initialOptions: opts }));
  };

  const openTaskDrawer = useCallback(
    async (batchId: string) => {
      const reqSeq = tracker.beginOpen(batchId);
      const prev = drawerRef.current.detail;
      applyDrawer({ open: true, loading: true, detail: prev?.batch.id === batchId ? prev : null });
      try {
        const detail = await tracker.fetchDetail(gateway, batchId);
        if (tracker.isCurrent(reqSeq)) applyDrawer({ open: true, loading: false, detail });
      } catch (err) {
        if (!tracker.isCurrent(reqSeq)) return;
        setErrorMsg(H.toErrorMessage(err, '加载任务明细失败'));
        applyDrawer({ ...drawerRef.current, loading: false });
      }
    },
    [applyDrawer, gateway, tracker],
  );

  const handleCreated = async (created: RewriteBatchDetailResponse) => {
    setCreateSession(null);
    setFeedbackMsg(H.formatCreatedBatchFeedback(created));
    invalidateFreshness('articles', 'categories', 'points');
    tracker.activate(created.batch.id);
    applyDrawer({ open: true, loading: false, detail: created });
    await Promise.all([
      loadList({ ...query, page: 1 }, false, false),
      loadOptions(),
      H.isActiveBatchStatus(created.batch.status)
        ? refreshDrawerSilently(created.batch.id)
        : Promise.resolve(),
    ]);
  };

  const runBusy = useCallback(async (fallbackError: string, task: () => Promise<void>) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await task();
    } catch (err) {
      setErrorMsg(H.toErrorMessage(err, fallbackError));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleControl = useCallback(
    (batch: RewriteBatchItem, action: H.RewriteBatchControlAction) =>
      runBusy('任务控制操作失败', async () => {
        setFeedbackMsg(await H.executeBatchControl(gateway, batch, action));
        tracker.invalidate(batch.id);
        const syncCur = drawerRef.current.open && drawerRef.current.detail?.batch.id === batch.id;
        await loadList(query, false, !syncCur);
        if (drawerRef.current.open && drawerRef.current.detail?.batch.id === batch.id) {
          await refreshDrawerSilently(batch.id);
        }
      }),
    [gateway, loadList, query, refreshDrawerSilently, runBusy, tracker],
  );

  const handleRowAction = useCallback(
    (row: RewriteBatchItem, act: H.BatchRowActionDescriptor) => {
      if (act.kind !== 'delete') {
        void handleControl(row, act.action);
        return;
      }
      void runBusy('删除任务失败', async () => {
        await gateway.deleteOne(row.id);
        setFeedbackMsg(`已删除任务「${row.name}」`);
        setSelectedIds((prev) => prev.filter((id) => id !== row.id));
        if (tracker.shouldCloseOnDelete(drawerRef.current, [row.id])) closeDrawer();
        tracker.invalidate(row.id);
        await loadList(query);
      });
    },
    [closeDrawer, gateway, handleControl, loadList, query, runBusy, tracker],
  );

  const handleBulkDelete = () =>
    selectedIds.length === 0
      ? Promise.resolve()
      : runBusy('批量删除失败', async () => {
          try {
            const res = await gateway.bulkDelete(selectedIds);
            setFeedbackMsg(`已批量删除 ${res.affected} 条已结束的批量复刻任务`);
            if (tracker.shouldCloseOnDelete(drawerRef.current, selectedIds)) closeDrawer();
            selectedIds.forEach((id) => tracker.invalidate(id));
            setSelectedIds([]);
            await loadList(query);
          } finally {
            setBulkDeleteConfirmOpen(false);
          }
        });

  const handleExport = (format: CrudExportFormat) =>
    runBusy('导出失败', async () => {
      const file = await gateway.downloadTable(query, format);
      triggerBlobDownload(file);
      setFeedbackMsg(`已导出 ${file.filename}`);
    });

  const updateFilter = (patch: Partial<RewriteBatchListQuery>) =>
    setQuery((prev) => ({ ...prev, page: 1, ...patch }));

  const columns = useMemo<ColumnsType<RewriteBatchItem>>(
    () => [
      {
        title: '序号',
        key: 'seq',
        width: 52,
        render: (_val, _row, idx) => (query.page - 1) * query.pageSize + idx + 1,
      },
      {
        title: '任务名',
        dataIndex: 'name',
        key: 'name',
        width: 170,
        minWidth: 145,
        ellipsis: H.BATCH_CELL_ELLIPSIS,
        render: (_val, row) => {
          const categoryLabel = row.categoryName || '查看分类文章';
          return (
            <div style={S.nameCell}>
              <TableClampText text={row.name} lines={2} strong tooltipThreshold={18} />
              <div style={S.subtleMetaRow}>
                <span style={{ flex: 'none' }}>归档分类：</span>
                <Button
                  type="link"
                  size="small"
                  title={categoryLabel}
                  style={S.categoryLink}
                  onClick={() => navigateTo(H.getBatchCategoryHref(row.categoryId))}
                >
                  {categoryLabel}
                </Button>
              </div>
            </div>
          );
        },
      },
      {
        title: '关键词',
        dataIndex: 'keyword',
        key: 'keyword',
        width: 150,
        minWidth: 130,
        ellipsis: H.BATCH_CELL_ELLIPSIS,
        render: (_val, row) => <BatchKeywordCell row={row} />,
      },
      {
        title: '最大改写量',
        dataIndex: 'maxCount',
        key: 'maxCount',
        width: 86,
        render: (val: number) => <span className="gm-num">{val} 篇</span>,
      },
      {
        title: '当前数量',
        key: 'doneCount',
        width: 150,
        render: (_val, row) => (
          <div>
            <div className="gm-num" style={{ fontWeight: 600 }}>
              {row.doneCount} / {row.maxCount} 篇
            </div>
            <div className="gm-num" style={S.doneSummary}>
              预冻 {row.reservedPoints} · 已结 {row.settledPoints} · 已退 {row.releasedPoints} 点
            </div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 165,
        minWidth: 140,
        ellipsis: H.BATCH_CELL_ELLIPSIS,
        render: (_val, row) => <BatchStatusCell row={row} />,
      },
      {
        title: '查看任务',
        key: 'inspect',
        width: 102,
        render: (_val, row) => (
          <Button size="small" onClick={() => void openTaskDrawer(row.id)}>
            查看任务 ({row.candidateCount || row.doneCount})
          </Button>
        ),
      },
      {
        title: '添加时间',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 120,
        render: (val: string) => (
          <span className="gm-num" style={S.createdAt}>
            {H.formatTime(val)}
          </span>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 122,
        render: (_val, row) =>
          readOnly ? (
            <Typography.Text type="secondary">只读</Typography.Text>
          ) : (
            <Space size={6} wrap>
              {H.getBatchRowActions(row.status).map((act) => (
                <Button
                  key={act.key}
                  size="small"
                  type={act.primaryGhost ? 'primary' : 'default'}
                  ghost={act.primaryGhost}
                  danger={act.danger}
                  disabled={busy}
                  onClick={() => handleRowAction(row, act)}
                >
                  {act.label}
                </Button>
              ))}
            </Space>
          ),
      },
    ],
    [busy, handleRowAction, navigateTo, openTaskDrawer, query.page, query.pageSize, readOnly],
  );

  const isTableEmpty = !loading && listData.total === 0 && listData.items.length === 0;
  const clearError = () => setErrorMsg(null);
  const clearFeedback = () => setFeedbackMsg(null);

  return (
    <div style={S.screenStack}>
      <div style={S.surfaceHeader}>
        <Space size={10} align="center" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Tag color="blue">{listData.unitPoints} 点数/篇 · 按实际成功篇数扣点</Tag>
          <Tag color="cyan">凑满最大改写量即停 · 差额自动退还</Tag>
        </Space>
        <div style={S.headerSubtitle}>
          默认支持粘贴最多 {REWRITE_BATCH_LINK_LIST_MAX}{' '}
          条公开文章链接批量抓取与结构重构；单链失败或超时自动跳过不扣点，所有插图仅取自
          {UX_TERMS.gallery}。
        </div>
      </div>

      {errorMsg && <Alert type="error" showIcon closable message={errorMsg} onClose={clearError} />}
      {feedbackMsg && (
        <Alert type="success" showIcon closable message={feedbackMsg} onClose={clearFeedback} />
      )}

      <div style={S.filterBar}>
        <Input.Search
          allowClear
          placeholder="搜索任务名称或流量关键词"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onSearch={(val) => updateFilter({ keyword: val.trim() || undefined })}
          style={{ width: 240 }}
        />
        <select
          aria-label="筛选任务状态"
          style={COMPACT_SELECT_STYLE}
          value={query.status ?? ''}
          onChange={(e) => updateFilter({ status: H.parseStatusFilter(e.target.value) })}
        >
          <option value="">全部任务状态</option>
          {H.BATCH_STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <select
          aria-label="筛选寻源方式"
          style={COMPACT_SELECT_STYLE}
          value={query.sourceType ?? ''}
          onChange={(e) => updateFilter({ sourceType: H.parseSourceFilter(e.target.value) })}
        >
          <option value="">全部寻源方式</option>
          {H.BATCH_SOURCE_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

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
        right={<ExportAction disabled={busy} empty={isTableEmpty} onExport={handleExport} />}
      />

      {createSession && (
        <RewriteBatchCreateModal
          key={createSession.id}
          open
          initialOptions={createSession.initialOptions}
          formOptions={formOptions}
          unitPoints={listData.unitPoints}
          remoteSearchEnabled={listData.remoteSearchEnabled}
          busy={busy}
          gateway={gateway}
          onClose={() => setCreateSession(null)}
          onCreated={handleCreated}
          onRefreshOptions={loadOptions}
          onNavigate={onDispatch ? navigateTo : undefined}
        />
      )}

      <div style={S.tableCard}>
        <Table<RewriteBatchItem>
          rowKey="id"
          loading={loading}
          dataSource={listData.items}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: CRUD_EMPTY_TEXT }}
          rowSelection={H.buildBatchRowSelection(readOnly, selectedIds, setSelectedIds)}
          pagination={H.buildBatchPagination(query, listData.total, setQuery)}
          columns={columns}
        />
      </div>

      {drawer.open ? (
        <RewriteBatchDetailDrawer
          open={drawer.open}
          loading={drawer.loading}
          busy={busy}
          readOnly={readOnly}
          detail={drawer.detail}
          onClose={closeDrawer}
          onRefresh={(batchId) => void openTaskDrawer(batchId)}
          onControl={(batch, action) => void handleControl(batch, action)}
          onNavigate={navigateTo}
        />
      ) : null}

      <Modal
        open={bulkDeleteConfirmOpen}
        title={`确认删除选中的 ${selectedIds.length} 条批量复刻任务？`}
        okText="确认删除"
        cancelText="取消"
        centered
        destroyOnHidden
        okButtonProps={{ danger: true, loading: busy }}
        onCancel={() => !busy && setBulkDeleteConfirmOpen(false)}
        onOk={() => void handleBulkDelete()}
      >
        <Typography.Text type="secondary">删除任务记录不会删除已生成的文章正文。</Typography.Text>
      </Modal>
    </div>
  );
}
