'use client';

import {
  ARTICLE_STATUS_LABEL,
  ITEM_STATUS_LABELS,
  REWRITE_BATCH_SOURCE_LABELS,
  REWRITE_BATCH_STATUS_LABELS,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteRecordItem,
} from '@geomix/shared';
import { Button, Descriptions, Drawer, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import { TableClampText } from '../crud/table-clamp-text';
import {
  BATCH_STYLES,
  articleStatusTagColor,
  batchStatusTagColor,
  formatTime,
  getBatchCategoryHref,
  isActiveBatchStatus,
  isControllableBatchStatus,
  itemStatusTagColor,
  type RewriteBatchControlAction,
} from './rewrite-batch-helpers';

export interface RewriteBatchDetailDrawerProps {
  open: boolean;
  loading: boolean;
  busy?: boolean;
  readOnly?: boolean;
  detail: RewriteBatchDetailResponse | null;
  onClose: () => void;
  onRefresh: (batchId: string) => void;
  onControl: (batch: RewriteBatchItem, action: RewriteBatchControlAction) => void;
  onNavigate: (href: string) => void;
}

export function RewriteBatchDetailDrawer({
  open,
  loading,
  busy = false,
  readOnly = false,
  detail,
  onClose,
  onRefresh,
  onControl,
  onNavigate,
}: RewriteBatchDetailDrawerProps) {
  const batchCategoryId = detail?.batch.categoryId ?? '';

  const columns = useMemo<ColumnsType<RewriteRecordItem>>(
    () => [
      {
        title: '#',
        key: 'idx',
        width: 36,
        render: (_v, _r, idx) => idx + 1,
      },
      {
        title: '候选源链接 / 原标题',
        key: 'source',
        width: 200,
        minWidth: 150,
        ellipsis: { showTitle: false },
        render: (_v, rec) => (
          <div style={{ display: 'grid', gap: 2, minWidth: 140, whiteSpace: 'normal' }}>
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
        width: 180,
        minWidth: 140,
        ellipsis: { showTitle: false },
        render: (_v, rec) => (
          <div style={{ display: 'grid', gap: 4, minWidth: 130, whiteSpace: 'normal' }}>
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
        width: 92,
        render: (_v, rec) => {
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
        width: 170,
        minWidth: 130,
        ellipsis: { showTitle: false },
        render: (_v, rec) => (
          <div style={{ display: 'grid', gap: 3, minWidth: 120, whiteSpace: 'normal' }}>
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
        width: 76,
        render: (_v, rec) =>
          rec.articleId ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => onNavigate(getBatchCategoryHref(rec.categoryId ?? batchCategoryId))}
            >
              查看文章
            </Button>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
    ],
    [batchCategoryId, onNavigate],
  );

  return (
    <Drawer
      open={open}
      width={940}
      title={detail ? `查看任务明细 · ${detail.batch.name}` : '查看批量爆文复刻明细'}
      onClose={onClose}
      extra={
        detail ? (
          <Space size={8} wrap>
            <Button size="small" onClick={() => onRefresh(detail.batch.id)} disabled={loading}>
              刷新进度
            </Button>
            <Button
              size="small"
              type="primary"
              ghost
              onClick={() => onNavigate(getBatchCategoryHref(detail.batch.categoryId))}
            >
              打开归档文章列表
            </Button>
            {!readOnly && isActiveBatchStatus(detail.batch.status) ? (
              <Button size="small" disabled={busy} onClick={() => onControl(detail.batch, 'pause')}>
                暂停
              </Button>
            ) : null}
            {!readOnly && detail.batch.status === 'PAUSED' ? (
              <Button
                size="small"
                type="primary"
                ghost
                disabled={busy}
                onClick={() => onControl(detail.batch, 'resume')}
              >
                继续
              </Button>
            ) : null}
            {!readOnly && isControllableBatchStatus(detail.batch.status) ? (
              <Button
                size="small"
                danger
                disabled={busy}
                onClick={() => onControl(detail.batch, 'cancel')}
              >
                终止
              </Button>
            ) : null}
          </Space>
        ) : null
      }
    >
      {detail && (
        <div style={BATCH_STYLES.screenStack}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="任务状态">
              <Tag color={batchStatusTagColor(detail.batch.status)}>
                {REWRITE_BATCH_STATUS_LABELS[detail.batch.status] ?? detail.batch.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="完成进度">
              <b>
                {detail.batch.doneCount} / {detail.batch.maxCount}
              </b>{' '}
              篇（候选 {detail.batch.candidateCount} 条）
            </Descriptions.Item>
            <Descriptions.Item label="寻源方式">
              {REWRITE_BATCH_SOURCE_LABELS[detail.batch.sourceType]}
              {detail.batch.keyword ? ` · ${detail.batch.keyword}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="点数对账">
              预冻 <b>{detail.batch.reservedPoints}</b> 点 · 已结{' '}
              <b>{detail.batch.settledPoints}</b> 点 · 已退 <b>{detail.batch.releasedPoints}</b> 点
            </Descriptions.Item>
            <Descriptions.Item label="配图图库 / 改写指令">
              {detail.batch.mediaCategoryName ?? '—'} /{' '}
              {detail.batch.templateName ?? detail.batch.templateId}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatTime(detail.batch.createdAt)}
            </Descriptions.Item>
            {detail.batch.brand && (
              <Descriptions.Item label="融入品牌词" span={2}>
                {detail.batch.brand}
              </Descriptions.Item>
            )}
            {detail.batch.note && (
              <Descriptions.Item label="结算与执行说明" span={2}>
                {detail.batch.note}
              </Descriptions.Item>
            )}
          </Descriptions>

          <Table<RewriteRecordItem>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={detail.records}
            scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            locale={{ emptyText: '暂无候选处理记录' }}
            columns={columns}
          />
        </div>
      )}
    </Drawer>
  );
}
