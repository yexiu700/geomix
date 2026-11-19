'use client';

import { ARTICLE_STATUS_LABEL, ITEM_STATUS_LABELS, type RewriteRecordItem } from '@geomix/shared';
import { Button, Space, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { TableClampText } from '../crud/table-clamp-text';
import { articleStatusTagColor, formatTime, itemStatusTagColor } from './rewrite-single-helpers';

export type RewriteSingleColumnsContext = {
  page: number;
  pageSize: number;
  readOnly: boolean;
  /** 跳转文章列表（按文章分类筛选，null 时打开全部文章） */
  onOpenArticles: (categoryId: string | null) => void;
  /** 失败行「粘贴原文重试」 */
  onRetryWithPaste: (row: RewriteRecordItem) => void;
  /** 单行删除 */
  onDelete: (id: string) => void;
};

/** 单篇复刻记录表格列定义（表头 / 文案与原内联实现保持一致）。 */
export function buildRewriteSingleColumns({
  page,
  pageSize,
  readOnly,
  onOpenArticles,
  onRetryWithPaste,
  onDelete,
}: RewriteSingleColumnsContext): TableColumnsType<RewriteRecordItem> {
  return [
    {
      title: '序号',
      key: 'seq',
      width: 60,
      render: (_val: unknown, _row: RewriteRecordItem, idx: number) =>
        (page - 1) * pageSize + idx + 1,
    },
    {
      title: '文章分类',
      dataIndex: 'categoryName',
      width: 145,
      ellipsis: { showTitle: false },
      render: (_val: unknown, row) =>
        row.categoryName ? (
          <Button
            type="link"
            size="small"
            title={row.categoryName}
            style={{
              padding: 0,
              maxWidth: 125,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}
            onClick={() => onOpenArticles(row.categoryId)}
          >
            {row.categoryName}
          </Button>
        ) : (
          <Typography.Text type="secondary">未归类</Typography.Text>
        ),
    },
    {
      title: '源链接 / 来源',
      dataIndex: 'url',
      width: 215,
      minWidth: 190,
      ellipsis: { showTitle: false },
      render: (_val: unknown, row) => (
        <div style={{ display: 'grid', gap: 2, minWidth: 175, whiteSpace: 'normal' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Tag
              color={row.pastedText ? 'purple' : 'geekblue'}
              style={{ margin: 0, whiteSpace: 'nowrap' }}
            >
              {row.pastedText ? '粘贴原文' : '链接抓取'}
            </Tag>
            {row.url.startsWith('paste://') ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                手工粘贴正文
              </Typography.Text>
            ) : (
              <Typography.Link
                href={row.url}
                target="_blank"
                rel="noreferrer"
                ellipsis
                style={{ maxWidth: 130, fontSize: 12 }}
              >
                {row.url}
              </Typography.Link>
            )}
          </div>
          {row.sourceTitle ? (
            <TableClampText
              text={`源标题：${row.sourceTitle}`}
              lines={1}
              tooltipThreshold={20}
              style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}
            />
          ) : null}
        </div>
      ),
    },
    {
      title: '复刻新标题',
      dataIndex: 'newTitle',
      minWidth: 240,
      width: 260,
      ellipsis: { showTitle: false },
      render: (_val: unknown, row) => (
        <div style={{ display: 'grid', gap: 4, minWidth: 220, whiteSpace: 'normal' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <TableClampText text={row.newTitle} lines={2} strong tooltipThreshold={20} />
            {row.highSimilarity ? (
              <Tag color="warning" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                重合度偏高 {row.similarity !== null ? `${(row.similarity * 100).toFixed(0)}%` : ''}
              </Tag>
            ) : null}
          </div>
          {row.error ? (
            <TableClampText
              text={`原因：${row.error}`}
              lines={2}
              tooltipThreshold={32}
              style={{ fontSize: 12, color: 'var(--gm-danger)' }}
            />
          ) : null}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 145,
      render: (_val: unknown, row) => (
        <Space size={4} wrap>
          <Tag color={itemStatusTagColor(row.status)} style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {ITEM_STATUS_LABELS[row.status] ?? row.status}
          </Tag>
          {row.articleStatus ? (
            <Tag
              color={articleStatusTagColor(row.articleStatus)}
              style={{ margin: 0, whiteSpace: 'nowrap' }}
            >
              文章·{ARTICLE_STATUS_LABEL[row.articleStatus]}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: '改写时间',
      dataIndex: 'rewrittenAt',
      width: 135,
      render: (_val: unknown, row) => formatTime(row.rewrittenAt ?? row.createdAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 145,
      fixed: 'right',
      render: (_val: unknown, row) => (
        <Space size={8} wrap>
          {row.articleId ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => onOpenArticles(row.categoryId)}
            >
              查看文章
            </Button>
          ) : null}
          {!readOnly && row.status === 'FAILED' ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => onRetryWithPaste(row)}
            >
              粘贴原文重试
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              type="link"
              size="small"
              danger
              style={{ padding: 0 }}
              onClick={() => onDelete(row.id)}
            >
              删除
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];
}
