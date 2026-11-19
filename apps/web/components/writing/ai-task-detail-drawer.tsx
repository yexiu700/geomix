'use client';

import {
  ITEM_STATUS_LABELS,
  TASK_STATUS_LABELS,
  UX_TERMS,
  type AiTaskDetailRecord,
  type AiTaskItemRecord,
  type AiTaskRecord,
  type ItemStatusName,
} from '@geomix/shared';
import { Alert, Button, Descriptions, Drawer, Modal, Space, Table, Tag, Typography } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TableClampText } from '../crud/table-clamp-text';
import type { AiTaskGateway } from '../../lib/ai-tasks';
import {
  isActiveTaskStatus,
  isControllableStatus,
  isUnauthorizedError,
  itemStatusTagColor,
  resolveTaskErrorMessage,
  statusTagColor,
} from './ai-task-helpers';

export type TaskBannerMessage = {
  type: 'success' | 'warning' | 'error';
  text: string;
};

export type UseAiTaskDetailDrawerOptions = {
  client: Pick<AiTaskGateway, 'detail' | 'pause' | 'resume' | 'cancel' | 'bulkDelete'>;
  onBanner: (banner: TaskBannerMessage) => void;
  onReloadList: () => void;
  onClearSelection: () => void;
  onUnauthorized: () => void;
};

export type AiTaskDetailDrawerController = {
  drawerOpen: boolean;
  detailLoading: boolean;
  activeDetail: AiTaskDetailRecord | null;
  hasActiveDetail: boolean;
  cancelTarget: AiTaskRecord | null;
  deleteIds: string[] | null;
  setCancelTarget: Dispatch<SetStateAction<AiTaskRecord | null>>;
  setDeleteIds: Dispatch<SetStateAction<string[] | null>>;
  openDetailDrawer: (taskId: string) => Promise<void>;
  closeDetailDrawer: () => void;
  pollActiveDetail: () => Promise<void>;
  handlePause: (row: AiTaskRecord) => Promise<void>;
  handleResume: (row: AiTaskRecord) => Promise<void>;
  handleCancelled: (updated: AiTaskDetailRecord) => void;
  handleDeleted: (deletedIds: string[], deletedCount: number) => void;
};

export function useAiTaskDetailDrawer({
  client,
  onBanner,
  onReloadList,
  onClearSelection,
  onUnauthorized,
}: UseAiTaskDetailDrawerOptions): AiTaskDetailDrawerController {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeDetail, setActiveDetail] = useState<AiTaskDetailRecord | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AiTaskRecord | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

  const callbacksRef = useRef({ onBanner, onReloadList, onClearSelection, onUnauthorized });
  callbacksRef.current = { onBanner, onReloadList, onClearSelection, onUnauthorized };

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const detailReqIdRef = useRef(0);

  const openDetailDrawer = useCallback(
    async (taskId: string) => {
      const reqId = ++detailReqIdRef.current;
      setDrawerOpen(true);
      setDetailLoading(true);
      try {
        const detail = await client.detail(taskId);
        if (!mountedRef.current || reqId !== detailReqIdRef.current) return;
        setActiveDetail(detail);
      } catch (err: unknown) {
        if (!mountedRef.current || reqId !== detailReqIdRef.current) return;
        if (isUnauthorizedError(err)) {
          callbacksRef.current.onUnauthorized();
        }
        callbacksRef.current.onBanner({
          type: 'error',
          text: resolveTaskErrorMessage(err, '读取任务详情失败'),
        });
        setDrawerOpen(false);
      } finally {
        if (mountedRef.current && reqId === detailReqIdRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [client],
  );

  const closeDetailDrawer = useCallback(() => {
    detailReqIdRef.current += 1;
    setDrawerOpen(false);
    setActiveDetail(null);
    setDetailLoading(false);
  }, []);

  const syncDetailIfMatch = useCallback((updated: AiTaskDetailRecord) => {
    setActiveDetail((curr) => (curr?.id === updated.id ? updated : curr));
  }, []);

  const pollActiveDetail = useCallback(async () => {
    if (!drawerOpen || !activeDetail || !isActiveTaskStatus(activeDetail.status)) {
      return;
    }
    const reqId = detailReqIdRef.current;
    const targetId = activeDetail.id;
    try {
      const fresh = await client.detail(targetId);
      if (!mountedRef.current || reqId !== detailReqIdRef.current) return;
      setActiveDetail((curr) => (curr?.id === targetId ? fresh : curr));
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        callbacksRef.current.onUnauthorized();
      }
    }
  }, [client, drawerOpen, activeDetail]);

  const handlePause = useCallback(
    async (row: AiTaskRecord) => {
      try {
        const updated = await client.pause(row.id);
        syncDetailIfMatch(updated);
        callbacksRef.current.onReloadList();
        callbacksRef.current.onBanner({ type: 'success', text: `已暂停任务「${row.name}」` });
      } catch (err: unknown) {
        callbacksRef.current.onBanner({
          type: 'error',
          text: resolveTaskErrorMessage(err, '暂停任务失败'),
        });
      }
    },
    [client, syncDetailIfMatch],
  );

  const handleResume = useCallback(
    async (row: AiTaskRecord) => {
      try {
        const updated = await client.resume(row.id);
        syncDetailIfMatch(updated);
        callbacksRef.current.onReloadList();
        callbacksRef.current.onBanner({
          type: 'success',
          text: `已恢复任务「${row.name}」继续写作`,
        });
      } catch (err: unknown) {
        callbacksRef.current.onBanner({
          type: 'error',
          text: resolveTaskErrorMessage(err, '恢复任务失败'),
        });
      }
    },
    [client, syncDetailIfMatch],
  );

  const handleCancelled = useCallback(
    (updated: AiTaskDetailRecord) => {
      syncDetailIfMatch(updated);
      setCancelTarget(null);
      callbacksRef.current.onReloadList();
      callbacksRef.current.onBanner({
        type: 'success',
        text: `已终止任务「${updated.name}」，剩余未执行篇数的预冻点数已退回`,
      });
    },
    [syncDetailIfMatch],
  );

  const handleDeleted = useCallback((deletedIds: string[], deletedCount: number) => {
    setActiveDetail((curr) => {
      if (curr && deletedIds.includes(curr.id)) {
        detailReqIdRef.current += 1;
        setDrawerOpen(false);
        setDetailLoading(false);
        return null;
      }
      return curr;
    });
    setDeleteIds(null);
    callbacksRef.current.onClearSelection();
    callbacksRef.current.onReloadList();
    callbacksRef.current.onBanner({
      type: 'success',
      text: `已删除 ${deletedCount} 条任务记录`,
    });
  }, []);

  const hasActiveDetail = Boolean(
    drawerOpen && activeDetail && isActiveTaskStatus(activeDetail.status),
  );

  return {
    drawerOpen,
    detailLoading,
    activeDetail,
    hasActiveDetail,
    cancelTarget,
    deleteIds,
    setCancelTarget,
    setDeleteIds,
    openDetailDrawer,
    closeDetailDrawer,
    pollActiveDetail,
    handlePause,
    handleResume,
    handleCancelled,
    handleDeleted,
  };
}

export type AiTaskActionButtonsProps = {
  task: AiTaskRecord;
  mode: 'table' | 'drawer';
  readOnly: boolean;
  onOpenArticles: (task: { id: string; categoryId: string; name: string }) => void;
  onPause: (task: AiTaskRecord) => void;
  onResume: (task: AiTaskRecord) => void;
  onRequestCancel: (task: AiTaskRecord) => void;
  onRequestDelete?: (task: AiTaskRecord) => void;
};

export function AiTaskActionButtons({
  task,
  mode,
  readOnly,
  onOpenArticles,
  onPause,
  onResume,
  onRequestCancel,
  onRequestDelete,
}: AiTaskActionButtonsProps) {
  if (mode === 'drawer') {
    return (
      <Space size={8}>
        <Button size="small" onClick={() => onOpenArticles(task)}>
          查看创作内容
        </Button>
        {isActiveTaskStatus(task.status) && !readOnly ? (
          <Button size="small" onClick={() => onPause(task)}>
            暂停
          </Button>
        ) : null}
        {task.status === 'PAUSED' && !readOnly ? (
          <Button size="small" type="primary" onClick={() => onResume(task)}>
            继续
          </Button>
        ) : null}
        {isControllableStatus(task.status) && !readOnly ? (
          <Button size="small" danger onClick={() => onRequestCancel(task)}>
            终止
          </Button>
        ) : null}
      </Space>
    );
  }

  return (
    <Space size={4} wrap>
      <Button
        type="link"
        size="small"
        aria-label={`查看创作内容-${task.name}`}
        onClick={() => onOpenArticles(task)}
      >
        查看创作内容
      </Button>
      {isActiveTaskStatus(task.status) && !readOnly ? (
        <Button
          type="link"
          size="small"
          aria-label={`暂停-${task.name}`}
          onClick={() => onPause(task)}
        >
          暂停
        </Button>
      ) : null}
      {task.status === 'PAUSED' && !readOnly ? (
        <Button
          type="link"
          size="small"
          aria-label={`继续-${task.name}`}
          onClick={() => onResume(task)}
        >
          继续
        </Button>
      ) : null}
      {isControllableStatus(task.status) && !readOnly ? (
        <Button
          type="link"
          size="small"
          danger
          aria-label={`终止-${task.name}`}
          onClick={() => onRequestCancel(task)}
        >
          终止
        </Button>
      ) : null}
      {!isControllableStatus(task.status) && !readOnly && onRequestDelete ? (
        <Button
          type="link"
          size="small"
          danger
          aria-label={`删除-${task.name}`}
          onClick={() => onRequestDelete(task)}
        >
          删除
        </Button>
      ) : null}
    </Space>
  );
}

export type AiTaskDetailDrawerProps = {
  open: boolean;
  loading: boolean;
  detail: AiTaskDetailRecord | null;
  readOnly: boolean;
  onClose: () => void;
  onOpenArticles: (task: { id: string; categoryId: string; name: string }) => void;
  onPause: (task: AiTaskRecord) => void;
  onResume: (task: AiTaskRecord) => void;
  onRequestCancel: (task: AiTaskRecord) => void;
};

export function AiTaskDetailDrawer({
  open,
  loading,
  detail,
  readOnly,
  onClose,
  onOpenArticles,
  onPause,
  onResume,
  onRequestCancel,
}: AiTaskDetailDrawerProps) {
  return (
    <Drawer
      open={open}
      width={860}
      title={detail ? `任务详情：${detail.name}` : '任务详情'}
      onClose={onClose}
      extra={
        detail ? (
          <AiTaskActionButtons
            task={detail}
            mode="drawer"
            readOnly={readOnly}
            onOpenArticles={onOpenArticles}
            onPause={onPause}
            onResume={onResume}
            onRequestCancel={onRequestCancel}
          />
        ) : null
      }
    >
      {detail ? (
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          {detail.lastError ? <Alert type="error" showIcon message={detail.lastError} /> : null}

          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="任务状态">
              <Tag color={statusTagColor(detail.status)}>{TASK_STATUS_LABELS[detail.status]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="创作进度">
              已完成 {detail.doneCount} / {detail.target} 篇（失败 {detail.failCount}，跳过{' '}
              {detail.skipCount}）
            </Descriptions.Item>
            <Descriptions.Item label="文章分类">{detail.categoryName}</Descriptions.Item>
            <Descriptions.Item label={UX_TERMS.mainKeyword}>{detail.keywordMain}</Descriptions.Item>
            <Descriptions.Item label="画像图库">
              {detail.mediaCategoryName
                ? `${detail.mediaCategoryName}（每篇 ${detail.imageCount} 张）`
                : `未使用（纯文，每篇 ${detail.imageCount} 张）`}
            </Descriptions.Item>
            <Descriptions.Item label="企业知识库">{detail.kbName ?? '未使用'}</Descriptions.Item>
            <Descriptions.Item label="内容创作指令">
              {detail.contentTplName ?? '随机生成文章'}
            </Descriptions.Item>
            <Descriptions.Item label="标题创作指令">
              {detail.titleTplName ?? '不重写标题'}
            </Descriptions.Item>
            <Descriptions.Item label="单价与预冻核算" span={2}>
              单价 {detail.unitPrice} 点/篇 ｜ 预冻 {detail.frozenPoints} 点 ｜ 已结算{' '}
              {detail.settledPoints} 点 ｜ 已退还 {detail.releasedPoints} 点
            </Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5} style={{ margin: 0 }}>
            单篇执行明细（共 {detail.items.length} 篇）
          </Typography.Title>
          <Table<AiTaskItemRecord>
            rowKey="id"
            size="small"
            loading={loading}
            pagination={{ pageSize: 10 }}
            dataSource={detail.items}
            columns={[
              { title: '篇序', dataIndex: 'seq', width: 64 },
              {
                title: '抽取问题 / 生成标题',
                key: 'title',
                render: (_, item) => (
                  <Space direction="vertical" size={0}>
                    <TableClampText
                      text={item.title ?? item.questionText ?? '待抽取'}
                      lines={2}
                      strong
                      tooltipThreshold={30}
                    />
                    {item.questionText && item.title && item.title !== item.questionText ? (
                      <TableClampText
                        text={`原问题：${item.questionText}`}
                        lines={1}
                        tooltipThreshold={30}
                        style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
                      />
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
                    <TableClampText
                      text={item.error}
                      lines={2}
                      maxWidth={220}
                      tooltipThreshold={20}
                      style={{ fontSize: 12, color: 'var(--gm-danger)' }}
                    />
                  ) : item.articleId ? (
                    <Button type="link" size="small" onClick={() => onOpenArticles(detail)}>
                      查看文章
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
  );
}

export type AiTaskConfirmModalsProps = {
  client: Pick<AiTaskGateway, 'cancel' | 'bulkDelete'>;
  cancelTarget: AiTaskRecord | null;
  deleteIds: string[] | null;
  onCloseCancel: () => void;
  onCancelled: (updated: AiTaskDetailRecord) => void;
  onCloseDelete: () => void;
  onDeleted: (deletedIds: string[], deletedCount: number) => void;
  onActionError: (message: string) => void;
};

export function AiTaskConfirmModals({
  client,
  cancelTarget,
  deleteIds,
  onCloseCancel,
  onCancelled,
  onCloseDelete,
  onDeleted,
  onActionError,
}: AiTaskConfirmModalsProps) {
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function runCancel() {
    if (!cancelTarget || cancelling) return;
    setCancelling(true);
    try {
      const updated = await client.cancel(cancelTarget.id);
      onCancelled(updated);
    } catch (err: unknown) {
      onActionError(resolveTaskErrorMessage(err, '终止任务失败'));
      onCloseCancel();
    } finally {
      setCancelling(false);
    }
  }

  async function runDelete() {
    if (!deleteIds || deleteIds.length === 0 || deleting) return;
    setDeleting(true);
    try {
      const res = await client.bulkDelete(deleteIds);
      onDeleted(deleteIds, res.deleted);
    } catch (err: unknown) {
      onActionError(resolveTaskErrorMessage(err, '删除任务失败'));
      onCloseDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Modal
        open={cancelTarget !== null}
        title="确认终止写作任务"
        centered
        transitionName=""
        maskTransitionName=""
        okText="确认终止并退还未用点数"
        cancelText="返回"
        okButtonProps={{ danger: true, loading: cancelling }}
        onCancel={() => {
          if (!cancelling) onCloseCancel();
        }}
        onOk={() => void runCancel()}
      >
        <p>
          确定终止任务「{cancelTarget?.name}
          」吗？尚未执行的子任务将标记为已跳过，剩余未使用的预冻点数将立即退回账户可用点数，已生成的文章仍会保留。
        </p>
      </Modal>

      <Modal
        open={deleteIds !== null}
        title="确认删除任务记录"
        centered
        transitionName=""
        maskTransitionName=""
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
        onCancel={() => {
          if (!deleting) onCloseDelete();
        }}
        onOk={() => void runDelete()}
      >
        <p>
          确定删除选中的 {deleteIds?.length ?? 0}{' '}
          条已完成/已终止任务记录吗？删除任务记录不会删除已生成的文章。
        </p>
      </Modal>
    </>
  );
}
