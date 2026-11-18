/* eslint-disable @next/next/no-img-element */
'use client';

import { Alert, Button, Input, Modal, Progress, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GALLERY_CATEGORY_EMPTY_MSG,
  GALLERY_UPLOAD_MAX_FILES,
  GALLERY_UPLOAD_NOTICE,
  checkImageWidthWarning,
  formatGalleryBytes,
  mediaCategoryWriteSchema,
  safeMediaDisplayName,
  sanitizeMediaOriginalName,
  validateClientUploadFile,
  type CrudPageSize,
  type MediaAssetRecord,
  type MediaCategoryRecord,
  type MediaStorageSummary,
  type MediaUploadResultItem,
} from '@geomix/shared';
import {
  httpGalleryGateway,
  readImageDimensions,
  resolveMediaUrl,
  type GalleryGateway,
} from '../../lib/gallery';
import type { ShellAction } from '../../lib/tab-stack';
import {
  formatShanghaiDateTime,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

type PendingUploadItem = {
  key: string;
  file: File;
  width?: number;
  height?: number;
  widthWarning?: string;
};

function resolveAssetDisplayName(
  asset: Pick<MediaAssetRecord, 'id' | 'origin' | 'displayName' | 'originalName'>,
  fallbackOriginalName?: string | null,
): string {
  const explicit = asset.displayName?.trim();
  if (explicit) return explicit;
  const original = sanitizeMediaOriginalName(asset.originalName ?? fallbackOriginalName);
  if (original) return original;
  return safeMediaDisplayName({
    id: asset.id,
    origin: asset.origin,
    originalName: asset.originalName ?? fallbackOriginalName,
  });
}

function StorageQuotaBanner({ storage }: { storage: MediaStorageSummary | null }) {
  if (!storage) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
        padding: '8px 12px',
        background: 'var(--gm-bg-elevated)',
        borderRadius: 6,
        border: '1px solid var(--gm-line-1)',
      }}
    >
      <Typography.Text strong>图片存储空间：</Typography.Text>
      <Tag color="blue" style={{ margin: 0 }}>
        已用 {storage.usedText} / 上限 {storage.limitText}
      </Tag>
    </div>
  );
}

const GALLERY_MUTATED_EVENT = 'geomix:gallery-mutated';

export function GalleryCategoryScreen({
  title,
  tabId,
  active = true,
  readOnly = false,
  onDispatch,
  gateway: injectedGateway,
}: {
  title: string;
  tabId: string;
  active?: boolean;
  readOnly?: boolean;
  onDispatch: (action: ShellAction) => void;
  gateway?: GalleryGateway;
}) {
  const gateway = useMemo(
    () => injectedGateway ?? httpGalleryGateway(window.sessionStorage),
    [injectedGateway],
  );

  const [rows, setRows] = useState<MediaCategoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<CrudPageSize>(10);
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [storage, setStorage] = useState<MediaStorageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const wasActiveRef = useRef(active);

  const load = useCallback(async () => {
    setLoading(true);
    setBannerError(null);
    try {
      const res = await gateway.listCategories({
        page,
        pageSize,
        q: q.trim() || undefined,
      });
      setRows(res.items);
      setTotal(res.total);
      setStorage(res.storage);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : '加载素材分类失败');
    } finally {
      setLoading(false);
    }
  }, [gateway, page, pageSize, q]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const becameActive = !wasActiveRef.current && active;
    wasActiveRef.current = active;
    if (becameActive) {
      void load();
    }
  }, [active, load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMutated = () => {
      void load();
    };
    window.addEventListener(GALLERY_MUTATED_EVENT, onMutated);
    return () => window.removeEventListener(GALLERY_MUTATED_EVENT, onMutated);
  }, [load]);

  function openCreate() {
    setEditingId(null);
    setCategoryName('');
    setModalError(null);
    setMinimized(false);
    setMaximized(false);
    setModalOpen(true);
  }

  function openEdit(row: MediaCategoryRecord) {
    setEditingId(row.id);
    setCategoryName(row.name);
    setModalError(null);
    setMinimized(false);
    setMaximized(false);
    setModalOpen(true);
  }

  function openAssetList(categoryId: string) {
    onDispatch({
      type: 'open',
      href: `/material/gallery/${encodeURIComponent(categoryId)}`,
      sourceId: tabId,
    });
  }

  async function submitCategory() {
    const parsed = mediaCategoryWriteSchema.safeParse({ name: categoryName });
    if (!parsed.success) {
      setModalError(parsed.error.issues[0]?.message ?? GALLERY_CATEGORY_EMPTY_MSG);
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      if (editingId) {
        await gateway.updateCategory(editingId, parsed.data);
      } else {
        await gateway.createCategory(parsed.data);
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '保存分类失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setDeleting(true);
    try {
      await gateway.deleteCategories(pendingDeleteIds);
      setSelectedIds((prev) => prev.filter((id) => !pendingDeleteIds.includes(id)));
      setPendingDeleteIds(null);
      await load();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : '删除分类失败');
      setPendingDeleteIds(null);
    } finally {
      setDeleting(false);
    }
  }

  const columns: CrudColumn<MediaCategoryRecord>[] = [
    {
      key: 'seq',
      title: '序号',
      render: (_row, index) => (page - 1) * pageSize + index + 1,
    },
    {
      key: 'name',
      title: '素材分类',
      render: (row) => <Typography.Text strong>{row.name}</Typography.Text>,
    },
    {
      key: 'assetCount',
      title: '素材数量',
      render: (row) => <Tag color={row.assetCount > 0 ? 'blue' : 'default'}>{row.assetCount}</Tag>,
    },
    {
      key: 'preview',
      title: '素材',
      render: (row) =>
        row.previewAssets.length === 0 ? (
          <Typography.Text type="secondary">暂无图片</Typography.Text>
        ) : (
          <Space size={8} wrap align="center">
            {row.previewAssets.slice(0, 3).map((asset) => (
              <img
                key={asset.id}
                src={resolveMediaUrl(asset.thumbUrl)}
                alt={`${row.name}缩略图`}
                data-testid={`cat-thumb-${asset.id}`}
                style={{
                  width: 44,
                  height: 44,
                  objectFit: 'cover',
                  borderRadius: 4,
                  border: '1px solid var(--gm-line-1)',
                  cursor: 'pointer',
                }}
                onClick={() => openAssetList(row.id)}
              />
            ))}
          </Space>
        ),
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
      width: 210,
      render: (row) => (
        <Space size={6}>
          <Button size="small" onClick={() => openAssetList(row.id)}>
            图片列表
          </Button>
          <Button size="small" disabled={readOnly} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            size="small"
            danger
            disabled={readOnly}
            onClick={() => setPendingDeleteIds([row.id])}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        按分类管理企业实拍与产品素材图片，「素材」列展示前 3
        张缩略图，点击操作列「图片列表」进入分类图片管理与多图上传。
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

      <CrudTable<MediaCategoryRecord>
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        searchPlaceholder="搜索素材分类名称"
        writeDisabled={readOnly}
        search={{
          keyword: q,
          enabled: undefined,
          sort: 'createdAt',
          order: 'desc',
        }}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setPage(1);
          setQ(search.keyword ?? '');
        }}
        onRefresh={() => void load()}
        onCreate={readOnly ? undefined : openCreate}
        onDelete={readOnly ? undefined : () => setPendingDeleteIds(selectedIds)}
        onSelectionChange={setSelectedIds}
        onPageChange={(nextPage, nextPageSize) => {
          setSelectedIds([]);
          setPage(nextPage);
          setPageSize(nextPageSize);
        }}
        onExport={async (format) => {
          try {
            const file = await gateway.downloadCategories(
              { page: 1, pageSize: 100, q: q.trim() || undefined },
              format,
            );
            triggerBlobDownload(file);
          } catch (err: unknown) {
            setBannerError(err instanceof Error ? err.message : '导出失败');
          }
        }}
      />

      <CrudModal
        open={modalOpen}
        title={editingId ? '编辑素材分类' : '添加素材分类'}
        minimized={minimized}
        maximized={maximized}
        confirmLoading={submitting}
        error={modalError}
        onMinimize={() => setMinimized(true)}
        onRestore={() => setMinimized(false)}
        onMaximize={() => setMaximized((v) => !v)}
        onClose={() => setModalOpen(false)}
        onReset={() => {
          setCategoryName('');
          setModalError(null);
        }}
        ok={
          <Button
            type="primary"
            loading={submitting}
            disabled={readOnly}
            onClick={() => void submitCategory()}
          >
            确定
          </Button>
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="gallery-category-input" style={{ fontWeight: 500 }}>
            分类
          </label>
          <Input
            id="gallery-category-input"
            aria-label="分类"
            placeholder="请输入素材分类名称"
            value={categoryName}
            maxLength={40}
            onChange={(e) => setCategoryName(e.target.value)}
            onPressEnter={() => void submitCategory()}
          />
        </div>
      </CrudModal>

      <Modal
        open={Boolean(pendingDeleteIds && pendingDeleteIds.length > 0)}
        title="确认删除素材分类"
        transitionName=""
        maskTransitionName=""
        confirmLoading={deleting}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        onCancel={() => setPendingDeleteIds(null)}
      >
        <p>
          确定删除已选择的 {pendingDeleteIds?.length ?? 0}{' '}
          个素材分类吗？分类下有图片或已被任务引用时不可删除。
        </p>
      </Modal>
    </section>
  );
}

export function GalleryAssetScreen({
  title,
  tabId,
  categoryId,
  readOnly = false,
  onDispatch,
  gateway: injectedGateway,
}: {
  title: string;
  tabId: string;
  categoryId: string;
  readOnly?: boolean;
  onDispatch: (action: ShellAction) => void;
  gateway?: GalleryGateway;
}) {
  const gateway = useMemo(
    () => injectedGateway ?? httpGalleryGateway(window.sessionStorage),
    [injectedGateway],
  );

  const [rows, setRows] = useState<MediaAssetRecord[]>([]);
  const [categoryName, setCategoryName] = useState<string>('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<CrudPageSize>(10);
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [storage, setStorage] = useState<MediaStorageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pendingItems, setPendingItems] = useState<PendingUploadItem[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [lastUploaded, setLastUploaded] = useState<MediaUploadResultItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSeqRef = useRef(0);
  const uploadSessionRef = useRef(0);

  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  function openUploadModal() {
    uploadSessionRef.current += 1;
    setPendingItems([]);
    setUploadError(null);
    setUploadStatus('idle');
    setUploadProgress(0);
    setDragActive(false);
    setLastUploaded([]);
    setMinimized(false);
    setMaximized(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploadModalOpen(true);
  }

  function handleSelectFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (uploading || readOnly) return;
    setUploadError(null);
    if (uploadStatus === 'error' || uploadStatus === 'success') {
      setUploadStatus('idle');
      setUploadProgress(0);
    }
    const chosen = Array.from(fileList);
    if (pendingItems.length + chosen.length > GALLERY_UPLOAD_MAX_FILES) {
      setUploadError(`单次最多选择 ${GALLERY_UPLOAD_MAX_FILES} 张图片`);
      return;
    }
    const valid: PendingUploadItem[] = [];
    for (const file of chosen) {
      const check = validateClientUploadFile({
        name: file.name,
        size: file.size,
        type: file.type,
      });
      if (!check.ok) {
        setUploadError(`${file.name}：${check.message}`);
        return;
      }
      pendingSeqRef.current += 1;
      valid.push({ key: `pending_${pendingSeqRef.current}`, file });
    }
    setPendingItems((prev) => [...prev, ...valid]);
    const session = uploadSessionRef.current;
    for (const entry of valid) {
      void readImageDimensions(entry.file).then((dims) => {
        if (!dims || uploadSessionRef.current !== session) return;
        const widthWarning = checkImageWidthWarning(dims.width);
        setPendingItems((prev) =>
          prev.map((item) =>
            item.key === entry.key
              ? { ...item, width: dims.width, height: dims.height, widthWarning }
              : item,
          ),
        );
      });
    }
  }

  async function submitUpload() {
    if (pendingItems.length === 0) {
      setUploadError('请至少选择一张图片');
      return;
    }
    setUploading(true);
    setUploadStatus('uploading');
    setUploadError(null);
    setUploadProgress(10);
    try {
      const res = await gateway.uploadAssets(
        categoryId,
        pendingItems.map((item) => item.file),
        setUploadProgress,
      );
      setUploadProgress(100);
      setUploadStatus('success');
      setUploading(false);
      setLastUploaded(res.items);
      setStorage(res.storage);
      if (res.warnings.length > 0) {
        setUploadWarnings(res.warnings);
      } else {
        setUploadWarnings([]);
      }
      setPendingItems([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(GALLERY_MUTATED_EVENT, { detail: { categoryId } }));
      }
      void load();
    } catch (err) {
      setUploadStatus('error');
      setUploadError(err instanceof Error ? err.message : '上传图片失败');
      setUploading(false);
    }
  }

  async function confirmDeleteAssets() {
    if (!pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setDeleting(true);
    try {
      await gateway.deleteAssets(pendingDeleteIds);
      setSelectedIds((prev) => prev.filter((id) => !pendingDeleteIds.includes(id)));
      setPendingDeleteIds(null);
      await load();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(GALLERY_MUTATED_EVENT, { detail: { categoryId } }));
      }
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
      render: (row) => (
        <Button
          size="small"
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
        search={{
          keyword: q,
          enabled: undefined,
          sort: 'createdAt',
          order: 'desc',
        }}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setPage(1);
          setQ(search.keyword ?? '');
        }}
        onRefresh={() => void load()}
        onCreate={readOnly ? undefined : openUploadModal}
        onDelete={readOnly ? undefined : () => setPendingDeleteIds(selectedIds)}
        onBack={() => onDispatch({ type: 'back', id: tabId })}
        onSelectionChange={setSelectedIds}
        onPageChange={(nextPage, nextPageSize) => {
          setSelectedIds([]);
          setPage(nextPage);
          setPageSize(nextPageSize);
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
        open={uploadModalOpen}
        title="添加图片素材"
        minimized={minimized}
        maximized={maximized}
        confirmLoading={uploading}
        showCancel={!(uploadStatus === 'success' && pendingItems.length === 0)}
        error={uploadStatus === 'error' ? null : uploadError}
        onMinimize={() => setMinimized(true)}
        onRestore={() => setMinimized(false)}
        onMaximize={() => setMaximized((v) => !v)}
        onClose={() => setUploadModalOpen(false)}
        onReset={() => {
          uploadSessionRef.current += 1;
          setPendingItems([]);
          setUploadError(null);
          setUploadStatus('idle');
          setUploadProgress(0);
          setDragActive(false);
          setLastUploaded([]);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }}
        ok={
          uploadStatus === 'success' && pendingItems.length === 0 ? (
            <Button
              key="upload-done"
              type="primary"
              loading={false}
              aria-label="完成"
              onClick={() => setUploadModalOpen(false)}
            >
              完成
            </Button>
          ) : (
            <Button
              key="upload-submit"
              type="primary"
              loading={uploading}
              disabled={readOnly}
              onClick={() => void submitUpload()}
            >
              确定
            </Button>
          )
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Alert type="info" showIcon message={GALLERY_UPLOAD_NOTICE} />

          <div
            data-testid="gallery-upload-dropzone"
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!uploading && !readOnly) setDragActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!uploading && !readOnly) setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragActive(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              if (!uploading && !readOnly) {
                handleSelectFiles(e.dataTransfer?.files ?? null);
              }
            }}
            style={{
              border: `1px dashed ${dragActive ? 'var(--gm-phosphor)' : 'var(--gm-line-2)'}`,
              borderRadius: 8,
              padding: 16,
              textAlign: 'center',
              background: dragActive ? 'var(--gm-phosphor-a08)' : 'var(--gm-bg-surface)',
              transition: 'border-color 120ms ease, background-color 120ms ease',
              display: 'grid',
              gap: 8,
              justifyItems: 'center',
            }}
          >
            <input
              ref={fileInputRef}
              aria-label="选择图片文件"
              type="file"
              multiple
              disabled={uploading || readOnly}
              accept="image/jpeg,image/png,image/webp"
              className="gm-sr-only"
              onChange={(e) => handleSelectFiles(e.target.files)}
            />
            <Typography.Text strong>
              {dragActive ? '松开鼠标即可添加图片' : '拖拽图片到此处，或点击按钮选择文件'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              支持 JPG / PNG / WebP，单次最多 {GALLERY_UPLOAD_MAX_FILES} 张
            </Typography.Text>
            <Button
              size="small"
              disabled={uploading || readOnly}
              onClick={() => fileInputRef.current?.click()}
            >
              选择图片
            </Button>
          </div>

          {pendingItems.some((item) => Boolean(item.widthWarning)) ? (
            <Alert
              type="warning"
              showIcon
              message="上传前清晰度提示（仅提示，不影响上传）"
              description={pendingItems
                .filter((item) => Boolean(item.widthWarning))
                .map((item) => `${item.file.name}：${item.widthWarning}`)
                .join('；')}
            />
          ) : null}

          {pendingItems.length > 0 ? (
            <div>
              <Typography.Text strong>待上传文件（{pendingItems.length} 张）：</Typography.Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {pendingItems.map((item) => (
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
                      disabled={uploading}
                      onClick={() =>
                        setPendingItems((prev) => prev.filter((entry) => entry.key !== item.key))
                      }
                    >
                      移除
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {uploading || uploadProgress > 0 || uploadStatus === 'error' ? (
            <Progress
              percent={uploadProgress}
              status={
                uploadStatus === 'error'
                  ? 'exception'
                  : uploadStatus === 'success'
                    ? 'success'
                    : 'active'
              }
              size="small"
            />
          ) : null}

          {uploadStatus === 'error' && uploadError ? (
            <Alert
              type="error"
              showIcon
              message="图片上传失败"
              description={uploadError}
              action={
                pendingItems.length > 0 ? (
                  <Button
                    size="small"
                    type="primary"
                    disabled={readOnly || uploading}
                    onClick={() => void submitUpload()}
                  >
                    重新上传
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {lastUploaded.length > 0 ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <Typography.Text strong>最近上传成功（{lastUploaded.length} 张）：</Typography.Text>
              {lastUploaded.map((item) => {
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
                      {item.warning ? (
                        <Typography.Text type="warning">{item.warning}</Typography.Text>
                      ) : (
                        <Typography.Text type="success">已压缩入库</Typography.Text>
                      )}
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
