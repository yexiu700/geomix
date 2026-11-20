'use client';

import { AI_IMAGE_STATUS_LABELS, type AiImageJobItem, type TaskStatusName } from '@geomix/shared';
import { Button, Input, Modal, Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { TableClampText } from '../crud/table-clamp-text';
import { resolveMediaUrl } from '../../lib/gallery';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import {
  FILTER_STATUSES,
  formatTime,
  isJobInProgress,
  isJobSavedToGallery,
  isPlaceholderJob,
  statusTagColor,
  triggerAssetDownload,
  type ColumnKey,
} from './ai-image-helpers';

export type BuildAiImageColumnsOptions = {
  visibleCols: ColumnKey[];
  page: number;
  pageSize: number;
  readOnly: boolean;
  onPreview: (job: AiImageJobItem, assetIndex: number) => void;
  onSaveGallery: (job: AiImageJobItem) => void;
  onDelete: (job: AiImageJobItem) => void;
};

/** 生图订单列表列定义（序号列常驻，其余按列显隐配置输出）。 */
export function buildAiImageColumns({
  visibleCols,
  page,
  pageSize,
  readOnly,
  onPreview,
  onSaveGallery,
  onDelete,
}: BuildAiImageColumnsOptions): ColumnsType<AiImageJobItem> {
  const all: Record<ColumnKey, ColumnsType<AiImageJobItem>[number]> = {
    orderNo: {
      title: '订单编号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      width: 114,
      render: (val: string) => (
        <Typography.Text
          code
          className="gm-num"
          style={{ fontSize: 11, wordBreak: 'break-all', whiteSpace: 'normal' }}
        >
          {val}
        </Typography.Text>
      ),
    },
    thumb: {
      title: '缩略图',
      key: 'thumb',
      width: 68,
      render: (_: unknown, row: AiImageJobItem) => {
        if (row.assets.length === 0) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {isJobInProgress(row) ? `生成中（0/${row.count}）…` : '无生成结果'}
            </Typography.Text>
          );
        }
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {row.assets.map((asset, index) => (
              <button
                key={asset.id}
                type="button"
                aria-label={`预览图片 ${row.orderNo}-${index + 1}`}
                onClick={() => onPreview(row, index)}
                style={{
                  padding: 0,
                  border: '1px solid var(--gm-line-1)',
                  borderRadius: 6,
                  overflow: 'hidden',
                  width: 40,
                  height: 40,
                  cursor: 'pointer',
                  background: 'var(--gm-bg-elevated)',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resolveMediaUrl(asset.thumbUrl)}
                  alt={`${row.orderNo}-${index + 1}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </button>
            ))}
          </div>
        );
      },
    },
    prompt: {
      title: '提示词',
      key: 'prompt',
      width: 170,
      render: (_: unknown, row: AiImageJobItem) => (
        <div style={{ maxWidth: 170 }}>
          <TableClampText text={row.prompt} lines={3} maxWidth={170} />
          {row.error ? (
            <div
              style={{
                color: 'var(--gm-danger)',
                fontSize: 12,
                marginTop: 2,
                wordBreak: 'break-word',
              }}
            >
              {row.error}
            </div>
          ) : null}
        </div>
      ),
    },
    styleRatio: {
      title: '风格/比例',
      key: 'styleRatio',
      width: 88,
      render: (_: unknown, row: AiImageJobItem) => (
        <Space size={4} wrap>
          <Tag>{row.style ?? '默认风格'}</Tag>
          <Tag color="geekblue">{row.ratio}</Tag>
        </Space>
      ),
    },
    count: {
      title: '张数',
      key: 'count',
      width: 58,
      render: (_: unknown, row: AiImageJobItem) => (
        <Tag color="cyan">
          {row.successCount}/{row.count} 张
        </Tag>
      ),
    },
    category: {
      title: '归属分类',
      key: 'category',
      width: 80,
      render: (_: unknown, row: AiImageJobItem) =>
        row.saveCategoryName ? (
          <span style={{ fontSize: 12, color: 'var(--gm-sig-cited)' }}>{row.saveCategoryName}</span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>未存入图库</span>
        ),
    },
    status: {
      title: '状态',
      key: 'status',
      width: 72,
      render: (_: unknown, row: AiImageJobItem) =>
        isPlaceholderJob(row) ? (
          <Tag color="warning">演示占位图</Tag>
        ) : (
          <Tag color={statusTagColor(row.status)}>
            {AI_IMAGE_STATUS_LABELS[row.status] ?? row.status}
          </Tag>
        ),
    },
    points: {
      title: '消耗点数',
      key: 'points',
      width: 96,
      render: (_: unknown, row: AiImageJobItem) => (
        <div className="gm-num" style={{ fontSize: 12, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
            {isJobInProgress(row)
              ? `预冻 ${row.reservedPoints} 点`
              : `实结 ${row.settledPoints} 点`}
          </div>
          <div style={{ color: 'var(--gm-fg-3)' }}>
            标价 {row.unitPoints} 点/张
            {row.releasedPoints > 0 ? ` · 已退 ${row.releasedPoints} 点` : ''}
          </div>
        </div>
      ),
    },
    createdAt: {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 90,
      render: (val: string) => (
        <span
          className="gm-num"
          style={{ fontSize: 12, color: 'var(--gm-fg-2)', whiteSpace: 'normal' }}
        >
          {formatTime(val)}
        </span>
      ),
    },
    actions: {
      title: '操作',
      key: 'actions',
      width: 126,
      render: (_: unknown, row: AiImageJobItem) => {
        const hasAssets = row.assets.length > 0;
        const placeholder = isPlaceholderJob(row);
        const savedToGallery = isJobSavedToGallery(row);
        return (
          <Space size={2} wrap>
            <Button
              size="small"
              type="link"
              style={{ padding: '0 4px' }}
              disabled={!hasAssets || placeholder}
              title={placeholder ? '演示占位图不可下载为商业原图' : undefined}
              onClick={() => {
                row.assets.forEach((asset, idx) => triggerAssetDownload(asset, row.orderNo, idx));
              }}
            >
              下载
            </Button>
            <Button
              size="small"
              type="link"
              disabled={readOnly || !hasAssets || placeholder}
              data-saved={savedToGallery ? 'true' : 'false'}
              title={
                placeholder
                  ? '演示占位图不可存入企业图库'
                  : savedToGallery
                    ? row.saveCategoryName
                      ? `已存入「${row.saveCategoryName}」，点击可更换图库分组`
                      : '已存入图库，点击可更换图库分组'
                    : '存入企业画像图库'
              }
              style={{
                padding: '0 4px',
                ...(!placeholder && savedToGallery
                  ? { color: 'var(--gm-sig-cited)', fontWeight: 500 }
                  : undefined),
              }}
              onClick={() => onSaveGallery(row)}
            >
              {savedToGallery ? '已存入（更换）' : '存入图库'}
            </Button>
            <Button
              size="small"
              type="link"
              danger
              style={{ padding: '0 4px' }}
              disabled={readOnly || isJobInProgress(row)}
              onClick={() => onDelete(row)}
            >
              删除
            </Button>
          </Space>
        );
      },
    },
  };

  return [
    {
      title: '序号',
      key: 'seq',
      width: 42,
      render: (_: unknown, __: AiImageJobItem, idx: number) => (page - 1) * pageSize + idx + 1,
    },
    // 按 visibleCols 过滤但保持固定列序
    ...(Object.keys(all) as ColumnKey[])
      .filter((key) => visibleCols.includes(key))
      .map((key) => all[key]),
  ];
}

export type AiImageSearchBarProps = {
  visible: boolean;
  status: TaskStatusName | undefined;
  onSearch: (keyword: string | undefined) => void;
  onStatusChange: (status: TaskStatusName | undefined) => void;
  onClear: () => void;
};

/** 搜索栏：自持输入框草稿；收起时保持挂载以保留已输入内容。 */
export function AiImageSearchBar({
  visible,
  status,
  onSearch,
  onStatusChange,
  onClear,
}: AiImageSearchBarProps) {
  const [searchInput, setSearchInput] = useState('');
  if (!visible) return null;
  const submit = () => onSearch(searchInput.trim() || undefined);
  return (
    <div
      style={{
        background: 'var(--gm-bg-surface)',
        border: '1px solid var(--gm-line-1)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
      }}
    >
      <Input
        aria-label="搜索提示词或订单编号"
        placeholder="搜索提示词或订单编号"
        style={{ width: 240 }}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        onPressEnter={submit}
      />
      <select
        aria-label="状态筛选"
        style={COMPACT_SELECT_STYLE}
        value={status ?? ''}
        onChange={(e) => {
          const val = e.target.value as TaskStatusName | '';
          onStatusChange(val ? val : undefined);
        }}
      >
        <option value="">全部状态</option>
        {FILTER_STATUSES.map((st) => (
          <option key={st} value={st}>
            {AI_IMAGE_STATUS_LABELS[st]}
          </option>
        ))}
      </select>
      <Button aria-label="查询" type="primary" onClick={submit}>
        查询
      </Button>
      <Button
        aria-label="清空"
        onClick={() => {
          setSearchInput('');
          onClear();
        }}
      >
        清空
      </Button>
    </div>
  );
}

export type AiImageDeleteModalProps = {
  /** 待删除订单 ID；null 时弹窗关闭 */
  targetIds: string[] | null;
  onConfirm: (ids: string[]) => Promise<void>;
  onClose: () => void;
};

/** 删除确认弹窗：自持删除中状态，删除中禁止取消。 */
export function AiImageDeleteModal({ targetIds, onConfirm, onClose }: AiImageDeleteModalProps) {
  const [deleting, setDeleting] = useState(false);

  const handleOk = async () => {
    if (!targetIds || targetIds.length === 0) return;
    setDeleting(true);
    try {
      await onConfirm(targetIds);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={Boolean(targetIds)}
      title="确认删除生图记录"
      keyboard
      transitionName=""
      maskTransitionName=""
      confirmLoading={deleting}
      okButtonProps={{ danger: true }}
      okText="确认删除"
      cancelText="取消"
      onCancel={() => {
        if (!deleting) onClose();
      }}
      onOk={() => void handleOk()}
    >
      <p style={{ margin: 0 }}>
        确定删除选中的 {targetIds?.length ?? 0}{' '}
        条生图记录吗？已存入企业画像图库的图片将保留在图库中不受影响，未存入图库的图片将同步释放存储空间。
      </p>
    </Modal>
  );
}
