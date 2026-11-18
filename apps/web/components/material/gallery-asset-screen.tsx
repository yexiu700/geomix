/* eslint-disable @next/next/no-img-element */
'use client';

import { Alert, Button, Modal, Progress, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GALLERY_UPLOAD_MAX_FILES,
  GALLERY_UPLOAD_NOTICE,
  formatGalleryBytes,
  type CrudPageSize,
  type MediaAssetRecord,
  type MediaStorageSummary,
} from '@geomix/shared';
import { httpGalleryGateway, resolveMediaUrl, type GalleryGateway } from '../../lib/gallery';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import {
  formatShanghaiDateTime,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import {
  StorageQuotaBanner,
  resolveAssetDisplayName,
  useGalleryBatchUpload,
} from './use-gallery-batch-upload';

export type GalleryAssetScreenProps = {
  title: string;
  tabId: string;
  categoryId: string;
  active?: boolean;
  readOnly?: boolean;
  onDispatch: (action: ShellAction) => void;
  gateway?: GalleryGateway;
};

export function GalleryAssetScreen({
  title,
  tabId,
  categoryId,
  active = true,
  readOnly = false,
  onDispatch,
  gateway: injectedGateway,
}: GalleryAssetScreenProps) {
  const gateway = useMemo(
    () => injectedGateway ?? httpGalleryGateway(window.sessionStorage),
    [injectedGateway],
  );

  const [rows, setRows] = useState<MediaAssetRecord[]>([]);
  const [categoryName, setCategoryName] = useState<string>('');
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState({ page: 1, pageSize: 10 as CrudPageSize, q: '' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [storage, setStorage] = useState<MediaStorageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [uploadModal, setUploadModal] = useState({
    open: false,
    minimized: false,
    maximized: false,
  });
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const suppressSelfInvalidationRef = useRef(false);
  const notifyGalleryMutated = useCallback(() => {
    suppressSelfInvalidationRef.current = true;
    try {
      invalidateFreshness('gallery');
    } finally {
      suppressSelfInvalidationRef.current = false;
    }
  }, []);

  const { page, pageSize, q } = query;

  const load = useCallback(async () => {
    setLoading(true);
    setBannerError(null);
    try {
      const res = await gateway.listAssets({
        categoryId,
        page,
        pageSize,
        q: q.trim() || undefined,
      });
      setRows(res.items);
      setTotal(res.total);
      setStorage(res.storage);
      if (res.category?.name) setCategoryName(res.category.name);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : '加载图片列表失败');
    } finally {
      setLoading(false);
    }
  }, [categoryId, gateway, page, pageSize, q]);

  useEffect(() => {
    void load();
  }, [load]);

  useTabFreshness({
    active,
    domains: ['gallery'],
    onRefresh: () => {
      if (suppressSelfInvalidationRef.current) return;
      void load();
    },
  });

  const upload = useGalleryBatchUpload({
    categoryId,
    gateway,
    readOnly,
    onUploadSuccess: (res) => {
      setStorage(res.storage);
      setUploadWarnings(res.warnings.length > 0 ? res.warnings : []);
      notifyGalleryMutated();
      void load();
    },
  });

  const closeUploadModal = () => setUploadModal((prev) => ({ ...prev, open: false }));

  function openUploadModal() {
    upload.resetUpload();
    setUploadModal({ open: true, minimized: false, maximized: false });
  }

  async function confirmDeleteAssets() {
    if (!pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setDeleting(true);
    try {
      await gateway.deleteAssets(pendingDeleteIds);
      setSelectedIds((prev) => prev.filter((id) => !pendingDeleteIds.includes(id)));
      setPendingDeleteIds(null);
      notifyGalleryMutated();
      await load();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : '删除图片失败');
      setPendingDeleteIds(null);
    } finally {
      setDeleting(false);
    }
  }

  const resolvedTitle = categoryName ? `图片列表 · ${categoryName}` : title;
  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  const columns: CrudColumn<MediaAssetRecord>[] = [
    {
      key: 'seq',
      title: '序号',
      width: 72,
      render: (_row, index) => (page - 1) * pageSize + index + 1,
    },
    {
      key: 'categoryName',
      title: '素材分类',
      render: (row) => row.categoryName ?? (categoryName || '未归类'),
    },
    {
      key: 'asset',
      title: '素材',
      render: (row) => {
        const displayName = resolveAssetDisplayName(row);
        return (
          <Space size={10} align="center">
            <img
              src={resolveMediaUrl(row.thumbUrl)}
              alt={displayName}
              data-testid={`asset-thumb-${row.id}`}
              style={{
                width: 48,
                height: 48,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid var(--gm-line-1)',
              }}
            />
            <div>
              <div className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-1)' }}>
                {row.width} × {row.height} · {formatGalleryBytes(row.bytes)}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {displayName}
              </Typography.Text>
            </div>
          </Space>
        );
      },
    },
    {
      key: 'usedCount',
      title: '使用次数',
      width: 110,
      render: (row) => <Tag color={row.usedCount > 0 ? 'green' : 'default'}>{row.usedCount}</Tag>,
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 156,
      render: (row) => formatShanghaiDateTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 110,
      hideable: false,
      render: (row) => (
        <Button
          size="small"
          type="link"
          danger
          disabled={readOnly}
          onClick={() => setPendingDeleteIds([row.id])}
        >
          删除
        </Button>
      ),
    },
  ];

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
        {resolvedTitle}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        支持多选批量上传企业图片，自动压缩去隐私元数据并统计使用次数；已被引用的图片受保护禁止删除。
      </Typography.Paragraph>

      <StorageQuotaBanner storage={storage} />

      {bannerError ? (
        <Alert
          type="error"
          showIcon
          closable
          message={bannerError}
          onClose={() => setBannerError(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {uploadWarnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          closable
          message="图片清晰度提示（不影响使用）"
          description={uploadWarnings.join('；')}
          onClose={() => setUploadWarnings([])}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <CrudTable<MediaAssetRecord>
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        searchPlaceholder="搜索图片文件名"
        writeDisabled={readOnly}
        search={{ keyword: q, enabled: undefined, sort: 'createdAt', order: 'desc' }}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((prev) => ({ ...prev, page: 1, q: search.keyword ?? '' }));
        }}
        onRefresh={() => void load()}
        onCreate={readOnly ? undefined : openUploadModal}
        onDelete={readOnly ? undefined : () => setPendingDeleteIds(selectedIds)}
        onBack={() => onDispatch({ type: 'back', id: tabId })}
        onSelectionChange={setSelectedIds}
        onPageChange={(nextPage, nextPageSize) => {
          setSelectedIds([]);
          setQuery((prev) => ({ ...prev, page: nextPage, pageSize: nextPageSize }));
        }}
        onExport={async (format) => {
          try {
            const file = await gateway.downloadAssets(
              { categoryId, page: 1, pageSize: 100, q: q.trim() || undefined },
              format,
            );
            triggerBlobDownload(file);
          } catch (err: unknown) {
            setBannerError(err instanceof Error ? err.message : '导出失败');
          }
        }}
      />

      <CrudModal
        open={uploadModal.open}
        title="添加图片素材"
        minimized={uploadModal.minimized}
        maximized={uploadModal.maximized}
        confirmLoading={upload.uploading}
        showCancel={!upload.isUploadComplete}
        error={upload.modalFooterError}
        onMinimize={() => setUploadModal((prev) => ({ ...prev, minimized: true }))}
        onRestore={() => setUploadModal((prev) => ({ ...prev, minimized: false }))}
        onMaximize={() => setUploadModal((prev) => ({ ...prev, maximized: !prev.maximized }))}
        onClose={closeUploadModal}
        onReset={upload.resetUpload}
        ok={
          upload.isUploadComplete ? (
            <Button key="upload-done" type="primary" aria-label="完成" onClick={closeUploadModal}>
              完成
            </Button>
          ) : (
            <Button
              key="upload-submit"
              aria-label="确定"
              type="primary"
              loading={upload.uploading}
              disabled={readOnly}
              onClick={() => void upload.submitUpload()}
            >
              确定
            </Button>
          )
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Alert type="info" showIcon message={GALLERY_UPLOAD_NOTICE} />
          <Typography.Text strong>
            <span style={{ color: 'var(--gm-danger)' }}>* </span>图片文件
          </Typography.Text>

          <div {...upload.dropzoneProps}>
            <input ref={upload.fileInputRef} {...upload.fileInputProps} />
            <Typography.Text strong>
              {upload.dragActive ? '松开鼠标即可添加图片' : '拖拽图片到此处，或点击按钮选择文件'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              支持 JPG / PNG / WebP，单次最多 {GALLERY_UPLOAD_MAX_FILES} 张
            </Typography.Text>
            <Button
              size="small"
              disabled={upload.uploading || readOnly}
              onClick={upload.openFilePicker}
            >
              选择图片
            </Button>
          </div>

          {upload.pendingWidthWarnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="上传前清晰度提示（仅提示，不影响上传）"
              description={upload.pendingWidthWarnings.join('；')}
            />
          ) : null}

          {upload.pendingItems.length > 0 ? (
            <div>
              <Typography.Text strong>
                待上传文件（{upload.pendingItems.length} 张）：
              </Typography.Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {upload.pendingItems.map((item) => (
                  <li key={item.key}>
                    {item.file.name}（{formatGalleryBytes(item.file.size)}
                    {item.width && item.height ? ` · ${item.width}×${item.height}px` : ''}）
                    {item.widthWarning ? (
                      <Tag color="warning" style={{ marginLeft: 6 }}>
                        宽度小于 500px
                      </Tag>
                    ) : null}
                    <Button
                      size="small"
                      type="link"
                      danger
                      disabled={upload.uploading}
                      onClick={() => upload.removePendingItem(item.key)}
                    >
                      移除
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {upload.showProgress ? (
            <Progress percent={upload.uploadProgress} status={upload.progressStatus} size="small" />
          ) : null}

          {upload.uploadStatus === 'error' && upload.uploadError ? (
            <Alert
              type="error"
              showIcon
              message="图片上传失败"
              description={upload.uploadError}
              action={
                upload.pendingItems.length > 0 ? (
                  <Button
                    size="small"
                    type="primary"
                    disabled={readOnly || upload.uploading}
                    onClick={() => void upload.submitUpload()}
                  >
                    重新上传
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {upload.lastUploaded.length > 0 ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <Typography.Text strong>
                最近上传成功（{upload.lastUploaded.length} 张）：
              </Typography.Text>
              {upload.lastUploaded.map((item) => {
                const displayName = resolveAssetDisplayName(item.asset, item.originalName);
                return (
                  <div
                    key={item.asset.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: 6,
                      border: '1px solid var(--gm-line-1)',
                      borderRadius: 6,
                    }}
                  >
                    <img
                      src={resolveMediaUrl(item.asset.thumbUrl)}
                      alt={displayName}
                      style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }}
                    />
                    <div style={{ fontSize: 12 }}>
                      <div>{displayName}</div>
                      <Typography.Text type={item.warning ? 'warning' : 'success'}>
                        {item.warning ?? '已压缩入库'}
                      </Typography.Text>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </CrudModal>

      <Modal
        open={Boolean(pendingDeleteIds && pendingDeleteIds.length > 0)}
        title="确认删除图片素材"
        centered
        keyboard
        transitionName=""
        maskTransitionName=""
        confirmLoading={deleting}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDeleteAssets()}
        onCancel={() => setPendingDeleteIds(null)}
      >
        <p>
          确定删除已选择的 {pendingDeleteIds?.length ?? 0} 张图片吗？删除后将释放对应图片存储空间。
        </p>
      </Modal>
    </section>
  );
}
