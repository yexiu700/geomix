/* eslint-disable @next/next/no-img-element */
'use client';

import {
  ARTICLE_SOURCE_LABELS,
  ARTICLE_STATUS_LABEL,
  type ArticleManageItem,
} from '@geomix/shared';
import { Button, Space, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { TableClampText } from '../crud/table-clamp-text';
import { resolveMediaUrl } from '../../lib/gallery';
import { formatTime, statusTagColor } from './article-manage-helpers';

export type ArticleTableColumnOptions = {
  page: number;
  pageSize: number;
  readOnly: boolean;
  onEdit: (articleId: string) => void;
  onApprove: (articleId: string) => void;
  onDelete: (articleId: string) => void;
};

/** 文章列表 7 列（含序号与操作列）；双击行进入编辑由容器的 `onRow` 负责。 */
export function buildArticleTableColumns({
  page,
  pageSize,
  readOnly,
  onEdit,
  onApprove,
  onDelete,
}: ArticleTableColumnOptions): ColumnsType<ArticleManageItem> {
  return [
    {
      key: 'index',
      title: '序号',
      width: 68,
      render: (_, __, index) => (page - 1) * pageSize + index + 1,
    },
    {
      key: 'categoryName',
      title: '分类名',
      width: 140,
      render: (_, row) => (
        <TableClampText
          text={row.categoryName ?? '未分类'}
          lines={1}
          maxWidth={128}
          tooltipThreshold={12}
        />
      ),
    },
    {
      key: 'title',
      title: '标题',
      width: 300,
      render: (_, row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {row.coverUrl ? (
            <img
              src={resolveMediaUrl(row.coverUrl)}
              alt="文章封面"
              style={{
                width: 36,
                height: 36,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid var(--gm-line-1)',
                flexShrink: 0,
              }}
            />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <TableClampText
              text={row.title}
              lines={2}
              tooltipThreshold={28}
              style={{ fontWeight: 500 }}
            />
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--gm-fg-3)',
              }}
            >
              <span style={{ whiteSpace: 'nowrap' }}>{ARTICLE_SOURCE_LABELS[row.source]}</span>
              <span>·</span>
              <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                {row.wordCount} 字
              </span>
              {row.aiTaskName ? (
                <>
                  <span>·</span>
                  <TableClampText
                    text={`任务：${row.aiTaskName}`}
                    lines={1}
                    maxWidth={180}
                    tooltipThreshold={16}
                    style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
                  />
                </>
              ) : null}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'sendCount',
      title: '发送次数',
      width: 95,
      render: (_, row) => (
        <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
          {row.sendCount}
        </span>
      ),
    },
    {
      key: 'videoCount',
      title: '转视频次数',
      width: 105,
      render: (_, row) => (
        <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
          {row.videoCount}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 100,
      render: (_, row) => (
        <Tag color={statusTagColor(row.status)} title="双击打开编辑">
          {ARTICLE_STATUS_LABEL[row.status]}
        </Tag>
      ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 156,
      render: (_, row) => (
        <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
          {formatTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 210,
      render: (_, row) => (
        <Space size={4} wrap>
          <Button
            type="link"
            size="small"
            disabled={readOnly}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(row.id);
            }}
          >
            编辑
          </Button>
          {row.status !== 'NORMAL' ? (
            <Button
              type="link"
              size="small"
              disabled={readOnly}
              onClick={(e) => {
                e.stopPropagation();
                onApprove(row.id);
              }}
            >
              设为正常
            </Button>
          ) : null}
          <Button
            type="link"
            size="small"
            danger
            disabled={readOnly}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(row.id);
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];
}
