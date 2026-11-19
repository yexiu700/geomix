'use client';

import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  UX_TERMS,
  isTaskStatus,
  type AiTaskDetailRecord,
  type AiTaskListQuery,
  type AiTaskRecord,
} from '@geomix/shared';
import { Alert, Button, Space, Tag, Tooltip, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import { TableClampText } from '../crud/table-clamp-text';
import { httpAiTaskGateway, type AiTaskGateway } from '../../lib/ai-tasks';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import type { SessionStorageLike } from '../../lib/session';
import { invalidateFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import { DEFAULT_TASK_POLL_INTERVAL_MS, useTaskPolling } from '../../lib/use-task-polling';
import { triggerBlobDownload, useSyncTabTitle } from '../../lib/ux-foundation';
import { AiTaskCreateModal, useAiTaskCreateModal } from './ai-task-create-modal';
import {
  AiTaskActionButtons,
  AiTaskConfirmModals,
  AiTaskDetailDrawer,
  useAiTaskDetailDrawer,
  type TaskBannerMessage,
} from './ai-task-detail-drawer';
import {
  AI_TASK_SORT_OPTIONS,
  INITIAL_AI_TASK_QUERY,
  buildCreatedArticlesHref,
  formatFailSkipSummary,
  formatTaskTime,
  isActiveTaskStatus,
  isUnauthorizedError,
  readInitialKeywordId,
  resolveAiTaskScreenTitle,
  resolveTaskErrorMessage,
  statusTagColor,
  useDocumentVisible,
} from './ai-task-helpers';

const NOWRAP_STYLE: CSSProperties = { whiteSpace: 'nowrap' };
const SUB_NOWRAP_STYLE: CSSProperties = { fontSize: 12, whiteSpace: 'nowrap' };
const KB_TAG_STYLE: CSSProperties = {
  maxWidth: 132,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

export function AiTaskScreen({
  title,
  tabId,
  href,
  active = true,
  readOnly = false,
  pollIntervalMs = DEFAULT_TASK_POLL_INTERVAL_MS,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  href?: string;
  active?: boolean;
  readOnly?: boolean;
  pollIntervalMs?: number;
  gateway?: AiTaskGateway;
  storage?: SessionStorageLike;
  onDispatch?: (action: ShellAction) => void;
}) {
  const initialKeywordId = useMemo(() => readInitialKeywordId(href), [href]);
  const prefilledHrefRef = useRef<string | null>(null);
  const client = useMemo(
    () => gateway ?? httpAiTaskGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );

  const [query, setQuery] = useState<AiTaskListQuery>(INITIAL_AI_TASK_QUERY);
  const [rows, setRows] = useState<AiTaskRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [authExpired, setAuthExpired] = useState(false);
  const [banner, setBanner] = useState<TaskBannerMessage | null>(null);
  const pageVisible = useDocumentVisible();

  const createModal = useAiTaskCreateModal({
    client,
    active,
    initialKeywordId,
    onLoadError: (text) => setBanner({ type: 'error', text }),
  });

  const detailDrawer = useAiTaskDetailDrawer({
    client,
    onBanner: setBanner,
    onReloadList: () => setReloadTick((n) => n + 1),
    onClearSelection: () => setSelectedIds([]),
    onUnauthorized: () => setAuthExpired(true),
  });

  const resolvedTitle = useMemo(
    () => resolveAiTaskScreenTitle(title, initialKeywordId, createModal.formOptions),
    [createModal.formOptions, initialKeywordId, title],
  );
  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  const { openCreateModal } = createModal;
  useEffect(() => {
    if (!initialKeywordId || readOnly || !href || prefilledHrefRef.current === href) return;
    prefilledHrefRef.current = href;
    void openCreateModal(initialKeywordId);
  }, [initialKeywordId, readOnly, href, openCreateModal]);

  const loadList = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await client.list(query);
        setAuthExpired(false);
        setRows(res.items);
        setTotal(res.total);
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) setAuthExpired(true);
        if (!silent) {
          setBanner({ type: 'error', text: resolveTaskErrorMessage(err, '读取写作任务列表失败') });
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

  const prevActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active) {
      setAuthExpired(false);
      void loadList(true);
    }
  }, [active, loadList]);

  const hasActiveTasks = useMemo(
    () => rows.some((r) => isActiveTaskStatus(r.status)) || detailDrawer.hasActiveDetail,
    [rows, detailDrawer.hasActiveDetail],
  );

  useTaskPolling({
    enabled: hasActiveTasks && !authExpired,
    active: active && pageVisible,
    intervalMs: pollIntervalMs,
    onPoll: async () => {
      await Promise.all([loadList(true), detailDrawer.pollActiveDetail()]);
    },
  });

  const handleCreated = useCallback((created: AiTaskDetailRecord) => {
    setReloadTick((n) => n + 1);
    invalidateFreshness('categories', 'tasks', 'articles', 'points');
    setBanner({
      type: 'success',
      text: `写作任务「${created.name}」已进入队列（预冻 ${created.frozenPoints} 点数，共 ${created.target} 篇）`,
    });
  }, []);

  const {
    closeDetailDrawer,
    openDetailDrawer,
    handlePause,
    handleResume,
    setCancelTarget,
    setDeleteIds,
  } = detailDrawer;

  const openCreatedArticles = useCallback(
    (row: { id: string; categoryId: string; name: string }) => {
      closeDetailDrawer();
      onDispatch?.({ type: 'open', href: buildCreatedArticlesHref(row), sourceId: tabId });
    },
    [closeDetailDrawer, onDispatch, tabId],
  );

  const handleExport = useCallback(
    async (format: 'csv' | 'xlsx') => {
      try {
        const file = await client.download(query, format);
        triggerBlobDownload(file);
      } catch (err: unknown) {
        setBanner({ type: 'error', text: resolveTaskErrorMessage(err, '导出失败') });
      }
    },
    [client, query],
  );

  const columns = useMemo<CrudColumn<AiTaskRecord>[]>(
    () => [
      {
        key: 'name',
        title: '任务名',
        width: 200,
        hideable: false,
        render: (row) => (
          <div style={{ minWidth: 160 }}>
            <TableClampText text={row.name} lines={2} strong maxWidth={190} tooltipThreshold={18} />
            <TableClampText
              text={`分类：${row.categoryName}`}
              lines={1}
              maxWidth={190}
              tooltipThreshold={18}
              style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
            />
          </div>
        ),
      },
      {
        key: 'keywordMain',
        title: UX_TERMS.mainKeyword,
        width: 120,
        render: (row) => <Tag color="geekblue">{row.keywordMain}</Tag>,
      },
      {
        key: 'target',
        title: '创作上限',
        width: 88,
        render: (row) => (
          <span className="gm-num" style={NOWRAP_STYLE}>
            {row.target} 篇
          </span>
        ),
      },
      {
        key: 'doneCount',
        title: '已创作',
        width: 104,
        render: (row) => {
          const summary = formatFailSkipSummary(row.failCount, row.skipCount);
          return (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>
                <span className="gm-num" style={NOWRAP_STYLE}>
                  {row.doneCount} / {row.target}
                </span>
              </Typography.Text>
              {summary ? (
                <Typography.Text type="secondary" style={SUB_NOWRAP_STYLE}>
                  {summary}
                </Typography.Text>
              ) : null}
            </Space>
          );
        },
      },
      {
        key: 'kbName',
        title: '知识库',
        width: 148,
        render: (row) =>
          row.kbName ? (
            <Tooltip title={row.kbName.length > 10 ? row.kbName : undefined}>
              <Tag color="purple" style={KB_TAG_STYLE}>
                {row.kbName}
              </Tag>
            </Tooltip>
          ) : (
            <Typography.Text type="secondary">未使用</Typography.Text>
          ),
      },
      {
        key: 'detail',
        title: '详情',
        width: 88,
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
        width: 160,
        render: (row) =>
          row.lastError ? (
            <TableClampText
              text={row.lastError}
              lines={2}
              maxWidth={150}
              tooltipThreshold={16}
              style={{ fontSize: 12, color: 'var(--gm-danger)' }}
            />
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
      {
        key: 'status',
        title: '状态',
        width: 96,
        render: (row) => (
          <Tag color={statusTagColor(row.status)}>{TASK_STATUS_LABELS[row.status]}</Tag>
        ),
      },
      {
        key: 'lastWrittenAt',
        title: '最新写作',
        width: 156,
        render: (row) => (
          <span className="gm-num" style={NOWRAP_STYLE}>
            {formatTaskTime(row.lastWrittenAt)}
          </span>
        ),
      },
      {
        key: 'createdAt',
        title: '创建时间',
        width: 156,
        render: (row) => (
          <span className="gm-num" style={NOWRAP_STYLE}>
            {formatTaskTime(row.createdAt)}
          </span>
        ),
      },
      {
        key: 'actions',
        title: '操作',
        width: 170,
        hideable: false,
        render: (row) => (
          <AiTaskActionButtons
            task={row}
            mode="table"
            readOnly={readOnly}
            onOpenArticles={openCreatedArticles}
            onPause={(target) => void handlePause(target)}
            onResume={(target) => void handleResume(target)}
            onRequestCancel={setCancelTarget}
            onRequestDelete={(target) => setDeleteIds([target.id])}
          />
        ),
      },
    ],
    [
      handlePause,
      handleResume,
      openCreatedArticles,
      openDetailDrawer,
      readOnly,
      setCancelTarget,
      setDeleteIds,
    ],
  );

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {resolvedTitle}
      </Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="AI 写作任务按提交预冻点数、按完成篇数逐篇结算运行：基础写作 10 点/篇，勾选企业知识库附加 +5 点/篇（共 15 点/篇）；列表每 5 秒自动刷新进度，单篇失败或中途终止未用点数自动退回。生成的文章默认保留 30 天，请及时导出保存。"
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
        {createModal.optionsLoading ? (
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
        searchPlaceholder={`搜索任务名称或${UX_TERMS.mainKeyword}`}
        writeDisabled={readOnly}
        emptyText={`暂无 AI 写作任务，点击「添加」配置${UX_TERMS.mainKeyword}与素材即可批量创作`}
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={AI_TASK_SORT_OPTIONS}
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
        onExport={handleExport}
        onRefresh={() => setReloadTick((n) => n + 1)}
        onCreate={readOnly ? undefined : () => void openCreateModal()}
        onDelete={readOnly ? undefined : () => setDeleteIds(selectedIds)}
        columns={columns}
      />

      <AiTaskCreateModal
        editor={createModal.editor}
        formOptions={createModal.formOptions}
        readOnly={readOnly}
        tabId={tabId}
        onEditorChange={createModal.setEditor}
        onRefreshOptions={createModal.refreshFormOptions}
        onSubmitCreate={(payload) => client.create(payload)}
        onCreated={handleCreated}
        onDispatch={onDispatch}
      />

      <AiTaskDetailDrawer
        open={detailDrawer.drawerOpen}
        loading={detailDrawer.detailLoading}
        detail={detailDrawer.activeDetail}
        readOnly={readOnly}
        onClose={closeDetailDrawer}
        onOpenArticles={openCreatedArticles}
        onPause={(row) => void handlePause(row)}
        onResume={(row) => void handleResume(row)}
        onRequestCancel={setCancelTarget}
      />

      <AiTaskConfirmModals
        client={client}
        cancelTarget={detailDrawer.cancelTarget}
        deleteIds={detailDrawer.deleteIds}
        onCloseCancel={() => setCancelTarget(null)}
        onCancelled={detailDrawer.handleCancelled}
        onCloseDelete={() => setDeleteIds(null)}
        onDeleted={detailDrawer.handleDeleted}
        onActionError={(text) => setBanner({ type: 'error', text })}
      />
    </section>
  );
}
