'use client';

import {
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  type AiImageJobItem,
  type AiImageJobListQuery,
  type CrudExportFormat,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Dropdown, Space, Table, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudToolbar } from '../crud/crud-toolbar';
import { ExportAction } from '../crud/export-action';
import {
  httpAiImageGateway,
  type AiImageDownloadFile,
  type AiImageFormOptions,
  type AiImageGateway,
} from '../../lib/ai-images';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { DEFAULT_TASK_POLL_INTERVAL_MS, useTaskPolling } from '../../lib/use-task-polling';
import { triggerBlobDownload } from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { ALL_COLUMN_KEYS, isJobInProgress, type ColumnKey } from './ai-image-helpers';
import { AiImageDeleteModal, AiImageSearchBar, buildAiImageColumns } from './ai-image-list-parts';
import type { AiImagePreviewTarget } from './ai-image-preview-modal';
import type { AiImageSaveGalleryResult } from './ai-image-save-gallery-modal';

const AiImageCreateModal = dynamic(() =>
  import('./ai-image-create-modal').then((m) => m.AiImageCreateModal),
);
const AiImagePreviewModal = dynamic(() =>
  import('./ai-image-preview-modal').then((m) => m.AiImagePreviewModal),
);
const AiImageSaveGalleryModal = dynamic(() =>
  import('./ai-image-save-gallery-modal').then((m) => m.AiImageSaveGalleryModal),
);

function defaultDownloadHandler(file: AiImageDownloadFile): boolean {
  return triggerBlobDownload(file);
}

type SaveTarget = {
  job: AiImageJobItem;
  defaultCategoryId: string;
};

export function AiImageScreen({
  title,
  tabId,
  active = true,
  readOnly = false,
  featureEnabled = true,
  storage,
  gateway,
  pollIntervalMs = DEFAULT_TASK_POLL_INTERVAL_MS,
  onDownload = defaultDownloadHandler,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  active?: boolean;
  readOnly?: boolean;
  featureEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: AiImageGateway;
  pollIntervalMs?: number;
  onDownload?: (file: AiImageDownloadFile) => void | boolean;
  onDispatch?: (action: ShellAction) => void;
}) {
  const effectiveStorage = useMemo<SessionStorageLike>(() => {
    if (storage) return storage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => {
        mem.set(k, v);
      },
      removeItem: (k) => {
        mem.delete(k);
      },
    };
  }, [storage]);

  const api = useMemo(
    () => gateway ?? httpAiImageGateway(effectiveStorage),
    [gateway, effectiveStorage],
  );

  // 列表查询 / 列显隐 / 选中态
  const [query, setQuery] = useState<AiImageJobListQuery>({
    page: 1,
    pageSize: 25,
  });
  const [searchVisible, setSearchVisible] = useState(true);
  const [visibleCols, setVisibleCols] = useState<ColumnKey[]>(
    ALL_COLUMN_KEYS.map((item) => item.key),
  );
  const [list, setList] = useState<{ items: AiImageJobItem[]; total: number }>({
    items: [],
    total: 0,
  });
  const [unitPoints, setUnitPoints] = useState<number>(AI_IMAGE_DEFAULT_UNIT_POINTS);
  const [serverFeatureEnabled, setServerFeatureEnabled] = useState<boolean>(featureEnabled);
  const [providerReady, setProviderReady] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [bannerInfo, setBannerInfo] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [formOptions, setFormOptions] = useState<AiImageFormOptions | null>(null);

  // 各弹窗开关（弹窗内部状态由子组件自持）
  const [createOpen, setCreateOpen] = useState(false);
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  const [previewTarget, setPreviewTarget] = useState<AiImagePreviewTarget | null>(null);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);

  const { items, total } = list;
  const isFeatureActive = featureEnabled && serverFeatureEnabled;

  const loadList = useCallback(
    async (silent = false) => {
      if (!featureEnabled) return;
      if (!silent) setLoading(true);
      try {
        const res = await api.list(query);
        setList({ items: res.items, total: res.total });
        setUnitPoints(res.unitPoints);
        setServerFeatureEnabled(res.featureEnabled);
        setProviderReady(res.providerReady ?? true);
        if (!silent) setPageError(null);
      } catch (err) {
        if (!silent) {
          setPageError(err instanceof Error ? err.message : '加载生图任务列表失败');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, featureEnabled, query],
  );

  const ensureFormOptions = useCallback(async () => {
    try {
      const opts = await api.loadFormOptions();
      setFormOptions(opts);
      setUnitPoints(opts.unitPoints);
      return opts;
    } catch {
      return null;
    }
  }, [api]);

  useEffect(() => {
    void loadList(false);
  }, [loadList]);

  useTabFreshness({
    active,
    domains: ['gallery', 'keywords', 'knowledge', 'points'],
    onRefresh: () => {
      if (featureEnabled) {
        void ensureFormOptions();
      }
    },
  });

  const hasActiveJobs = useMemo(() => items.some(isJobInProgress), [items]);

  // 存在排队 / 生成中订单时静默轮询；后台标签页或 pollIntervalMs <= 0 时不轮询
  useTaskPolling({
    enabled: hasActiveJobs && isFeatureActive,
    active,
    intervalMs: pollIntervalMs,
    onPoll: () => loadList(true),
  });

  const openCreateModal = async () => {
    setCreateOpen(true);
    await ensureFormOptions();
  };

  const handleCreated = async (created: AiImageJobItem) => {
    setCreateOpen(false);
    setBannerInfo(
      `已提交生图订单 ${created.orderNo}（预冻结 ${created.reservedPoints} 点），系统正在后台生成图片。`,
    );
    invalidateFreshness('points');
    await loadList(false);
  };

  const openSaveGalleryModal = async (job: AiImageJobItem) => {
    setSaveTarget({ job, defaultCategoryId: job.saveCategoryId ?? '' });
    const opts = (await ensureFormOptions()) ?? formOptions;
    const initialCat = job.saveCategoryId || opts?.mediaCategories[0]?.id || '';
    setSaveTarget((prev) =>
      prev && prev.job === job ? { ...prev, defaultCategoryId: initialCat } : prev,
    );
  };

  const handleSavedToGallery = async ({
    savedCount,
    categoryName,
    wasSaved,
  }: AiImageSaveGalleryResult) => {
    setSaveTarget(null);
    setBannerInfo(
      `已将 ${savedCount} 张生成图片${wasSaved ? '更换至' : '存入'}图库分组「${categoryName}」，AI 写作可直接选用！`,
    );
    invalidateFreshness('gallery');
    await loadList(false);
  };

  const handleConfirmDelete = async (ids: string[]) => {
    try {
      if (ids.length === 1 && ids[0]) {
        await api.deleteOne(ids[0]);
      } else {
        await api.bulkDelete(ids);
      }
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      setDeleteTargetIds(null);
      await loadList(false);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '删除生图记录失败');
      setDeleteTargetIds(null);
    }
  };

  const handleExport = async (format: CrudExportFormat) => {
    setPageError(null);
    try {
      const file = await api.downloadTable(query, format);
      const ok = onDownload(file);
      if (ok === false) {
        throw new Error('当前浏览器不支持文件下载，请更换浏览器重试');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导出生图列表失败';
      setPageError(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  };

  const navigateTo = (href: string) => {
    onDispatch?.({
      type: 'open',
      href,
      sourceId: tabId,
    });
  };

  if (!isFeatureActive) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="AI 生图功能当前未启用"
          description="管理员已通过 FEATURE_AI_IMAGE 关闭生图模块。如需使用，请联系管理员开启功能开关。"
        />
      </section>
    );
  }

  const columns = buildAiImageColumns({
    visibleCols,
    page: query.page,
    pageSize: query.pageSize,
    readOnly,
    onPreview: (job, assetIndex) => setPreviewTarget({ job, assetIndex }),
    onSaveGallery: (job) => void openSaveGalleryModal(job),
    onDelete: (job) => setDeleteTargetIds([job.id]),
  });

  return (
    <section>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            支持 9 种商业构图比例与免费提示词扩写；按实际生成成功张数结算（当前标价 {unitPoints}{' '}
            点数/张），支持一键保存到企业画像图库供 AI 写作自动配图。
          </Typography.Text>
        </div>
        <Space>
          <Button size="small" onClick={() => navigateTo('/material/gallery')}>
            查看企业画像图库
          </Button>
        </Space>
      </div>

      {!providerReady && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="当前未配置真实 AI 生图服务，暂不可新建生图任务；已有历史记录仍可正常查看。"
        />
      )}

      {pageError && (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          closable
          onClose={() => setPageError(null)}
          message={pageError}
        />
      )}

      {bannerInfo && (
        <Alert
          style={{ marginBottom: 12 }}
          type="success"
          showIcon
          closable
          onClose={() => setBannerInfo(null)}
          message={bannerInfo}
        />
      )}

      <AiImageSearchBar
        visible={searchVisible}
        status={query.status}
        onSearch={(keyword) => setQuery((prev) => ({ ...prev, page: 1, keyword }))}
        onStatusChange={(status) => setQuery((prev) => ({ ...prev, page: 1, status }))}
        onClear={() => setQuery({ page: 1, pageSize: query.pageSize })}
      />

      {/* Toolbar */}
      <CrudToolbar
        createDisabled={readOnly || !providerReady}
        onCreate={() => void openCreateModal()}
        refreshLoading={loading}
        onRefresh={() => void loadList(false)}
        deleteLabel={selectedIds.length > 0 ? `删除（${selectedIds.length}）` : '删除'}
        deleteDisabled={readOnly || selectedIds.length === 0}
        onDelete={() => setDeleteTargetIds(selectedIds)}
        right={
          <>
            <Button
              aria-label="搜索"
              aria-expanded={searchVisible}
              onClick={() => setSearchVisible((v) => !v)}
            >
              搜索
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: ALL_COLUMN_KEYS.map((col) => ({
                  key: col.key,
                  label: (
                    <Checkbox
                      checked={visibleCols.includes(col.key)}
                      onChange={(e) => {
                        setVisibleCols((prev) =>
                          e.target.checked
                            ? [...prev, col.key]
                            : prev.length > 1
                              ? prev.filter((item) => item !== col.key)
                              : prev,
                        );
                      }}
                    >
                      {col.label}
                    </Checkbox>
                  ),
                })),
              }}
            >
              <Button aria-label="列">列</Button>
            </Dropdown>
            <ExportAction
              empty={!loading && total === 0 && items.length === 0}
              onExport={handleExport}
            />
          </>
        }
      />

      {/* Table */}
      <Table<AiImageJobItem>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: CRUD_EMPTY_TEXT }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(String)),
          getCheckboxProps: (record) => ({
            disabled: readOnly || isJobInProgress(record),
          }),
        }}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: CRUD_PAGE_SIZES.map(String),
          showTotal: (count) => `共 ${count} 条`,
          onChange: (nextPage, nextSize) => {
            const safeSize = (CRUD_PAGE_SIZES as readonly number[]).includes(nextSize)
              ? (nextSize as AiImageJobListQuery['pageSize'])
              : 25;
            setQuery((prev) => ({
              ...prev,
              page: nextPage,
              pageSize: safeSize,
            }));
          },
        }}
      />

      {/* Create AI Image Modal（按需挂载，关闭即重置草稿） */}
      {createOpen && (
        <AiImageCreateModal
          readOnly={readOnly}
          unitPoints={unitPoints}
          formOptions={formOptions}
          gateway={api}
          onRefreshOptions={() => void ensureFormOptions()}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {saveTarget ? (
        <AiImageSaveGalleryModal
          job={saveTarget.job}
          defaultCategoryId={saveTarget.defaultCategoryId}
          mediaCategories={formOptions?.mediaCategories ?? []}
          saveToGallery={(id, input) => api.saveToGallery(id, input)}
          onClose={() => setSaveTarget(null)}
          onSaved={handleSavedToGallery}
        />
      ) : null}

      {previewTarget ? (
        <AiImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      ) : null}

      <AiImageDeleteModal
        targetIds={deleteTargetIds}
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleteTargetIds(null)}
      />
    </section>
  );
}
