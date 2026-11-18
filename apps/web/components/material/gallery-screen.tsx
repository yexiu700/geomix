/* eslint-disable @next/next/no-img-element */
'use client';

import { Alert, Button, Input, Modal, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GALLERY_CATEGORY_EMPTY_MSG,
  mediaCategoryWriteSchema,
  type CrudPageSize,
  type MediaCategoryRecord,
  type MediaStorageSummary,
} from '@geomix/shared';
import { httpGalleryGateway, resolveMediaUrl, type GalleryGateway } from '../../lib/gallery';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import { formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import { StorageQuotaBanner } from './use-gallery-batch-upload';

type CategoryModalState = {
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  editingId: string | null;
  categoryName: string;
  modalError: string | null;
  submitting: boolean;
};

const INITIAL_CATEGORY_MODAL: CategoryModalState = {
  open: false,
  minimized: false,
  maximized: false,
  editingId: null,
  categoryName: '',
  modalError: null,
  submitting: false,
};

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
  const [modal, setModal] = useState<CategoryModalState>(INITIAL_CATEGORY_MODAL);
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

  useTabFreshness({
    active,
    domains: ['gallery'],
    onRefresh: () => {
      if (suppressSelfInvalidationRef.current) return;
      void load();
    },
  });

  function openCreate() {
    setModal({
      ...INITIAL_CATEGORY_MODAL,
      open: true,
    });
  }

  function openEdit(row: MediaCategoryRecord) {
    setModal({
      ...INITIAL_CATEGORY_MODAL,
      open: true,
      editingId: row.id,
      categoryName: row.name,
    });
  }

  function openAssetList(categoryId: string) {
    onDispatch({
      type: 'open',
      href: `/material/gallery/${encodeURIComponent(categoryId)}`,
      sourceId: tabId,
    });
  }

  async function submitCategory() {
    const parsed = mediaCategoryWriteSchema.safeParse({ name: modal.categoryName });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? GALLERY_CATEGORY_EMPTY_MSG;
      setModal((prev) => ({ ...prev, modalError: message }));
      return;
    }
    setModal((prev) => ({ ...prev, submitting: true, modalError: null }));
    try {
      if (modal.editingId) {
        await gateway.updateCategory(modal.editingId, parsed.data);
      } else {
        await gateway.createCategory(parsed.data);
      }
      setModal((prev) => ({ ...prev, open: false, submitting: false }));
      notifyGalleryMutated();
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存分类失败';
      setModal((prev) => ({ ...prev, submitting: false, modalError: message }));
    }
  }

  async function confirmDelete() {
    if (!pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setDeleting(true);
    try {
      await gateway.deleteCategories(pendingDeleteIds);
      setSelectedIds((prev) => prev.filter((id) => !pendingDeleteIds.includes(id)));
      setPendingDeleteIds(null);
      notifyGalleryMutated();
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
      hideable: false,
      render: (row) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openAssetList(row.id)}>
            图片列表
          </Button>
          <Button size="small" type="link" disabled={readOnly} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
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
        open={modal.open}
        title={modal.editingId ? '编辑素材分类' : '添加素材分类'}
        minimized={modal.minimized}
        maximized={modal.maximized}
        confirmLoading={modal.submitting}
        error={modal.modalError}
        onMinimize={() => setModal((prev) => ({ ...prev, minimized: true }))}
        onRestore={() => setModal((prev) => ({ ...prev, minimized: false }))}
        onMaximize={() => setModal((prev) => ({ ...prev, maximized: !prev.maximized }))}
        onClose={() => setModal((prev) => ({ ...prev, open: false, modalError: null }))}
        onReset={() => setModal((prev) => ({ ...prev, categoryName: '', modalError: null }))}
        ok={
          <Button
            aria-label="确定"
            type="primary"
            loading={modal.submitting}
            disabled={readOnly}
            onClick={() => void submitCategory()}
          >
            确定
          </Button>
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <label
            htmlFor="gallery-category-input"
            style={{ display: 'block', fontWeight: 600, marginBottom: 0 }}
          >
            <span style={{ color: 'var(--gm-danger)' }}>* </span>分类
          </label>
          <Input
            id="gallery-category-input"
            aria-label="分类"
            placeholder="请输入素材分类名称"
            value={modal.categoryName}
            maxLength={40}
            onChange={(e) => setModal((prev) => ({ ...prev, categoryName: e.target.value }))}
            onPressEnter={() => void submitCategory()}
          />
        </div>
      </CrudModal>

      <Modal
        open={Boolean(pendingDeleteIds && pendingDeleteIds.length > 0)}
        title="确认删除素材分类"
        centered
        keyboard
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

export { GalleryAssetScreen } from './gallery-asset-screen';
