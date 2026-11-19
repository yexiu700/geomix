'use client';

import {
  ARTICLE_EXPORT_FORMATS,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  type ArticleArchiveFormat,
  type ArticleDetailRecord,
  type ArticleManageItem,
  type ArticleManageListResponse,
  type ArticleManageQuery,
  type CrudPageSize,
} from '@geomix/shared';
import { Alert, Button, Modal, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudToolbar } from '../crud/crud-toolbar';
import { ExportAction } from '../crud/export-action';
import {
  articleQueryFromHref,
  httpArticleManageGateway,
  type ArticleDownloadFile,
  type ArticleFormOptions,
  type ArticleManageGateway,
} from '../../lib/articles';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import type { SessionStorageLike } from '../../lib/session';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import {
  sanitizeEntityTitleSegment,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import { useArticleEditorController } from './article-editor-controller';
import { ArticleEditorModal } from './article-editor-modal';
import { ArticleFilterPanel } from './article-filter-panel';
import {
  ARCHIVE_FORMAT_LABELS,
  ARTICLES_ROUTE,
  EMPTY_FILTER_DRAFT,
  buildArticlesRouteHref,
  buildInitialFilterDraft,
  clearFilterHandoffs,
  filterDraftToQueryFields,
  stashFilterHandoff,
  takeFilterHandoff,
  validateFilterDraft,
  type FilterDraft,
} from './article-manage-helpers';
import { buildArticleTableColumns } from './article-table-columns';

// 保持原导入路径可用：写作任务等页面经此生成文章列表跳转链接。
export { buildArticlesRouteHref } from './article-manage-helpers';

type BannerState = {
  type: 'success' | 'warning' | 'error';
  text: string;
};

export function ArticleManageScreen({
  title,
  tabId,
  href = ARTICLES_ROUTE,
  active = true,
  readOnly = false,
  gateway,
  storage,
  onDownload,
  onDispatch,
}: {
  title: string;
  tabId: string;
  href?: string;
  active?: boolean;
  readOnly?: boolean;
  gateway?: ArticleManageGateway;
  storage?: SessionStorageLike;
  onDownload?: (file: ArticleDownloadFile) => void;
  onDispatch?: (action: ShellAction) => void;
}) {
  const client = useMemo(
    () => gateway ?? httpArticleManageGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );

  const initialUrlFilter = useMemo(() => articleQueryFromHref(href), [href]);
  // 跳转交接仅在首次挂载时一次性消费，避免多实例 / 多标签页复用同一份筛选。
  const [initialFilterDraft] = useState<FilterDraft>(() =>
    buildInitialFilterDraft(initialUrlFilter, takeFilterHandoff(href)),
  );
  const prevHrefRef = useRef(href);

  const [query, setQuery] = useState<ArticleManageQuery>(() => ({
    page: 1,
    pageSize: 10,
    ...filterDraftToQueryFields(initialFilterDraft),
  }));

  const [filterDraft, setFilterDraft] = useState<FilterDraft>(initialFilterDraft);

  const [filterOpen, setFilterOpen] = useState(true);
  const [rows, setRows] = useState<ArticleManageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [categorySummary, setCategorySummary] =
    useState<ArticleManageListResponse['categorySummary']>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reloadTick, setReloadTick] = useState(0);

  const [formOptions, setFormOptions] = useState<ArticleFormOptions | null>(null);
  const [archiveFormat, setArchiveFormat] = useState<ArticleArchiveFormat>('md');
  const [exportingZip, setExportingZip] = useState(false);

  useEffect(() => {
    if (prevHrefRef.current === href) return;
    prevHrefRef.current = href;
    const next = articleQueryFromHref(href);
    setCategorySummary(null);
    setQuery((prev) => ({
      ...prev,
      page: 1,
      categoryId: next.categoryId,
      taskId: next.taskId,
    }));
    setFilterDraft((prev) => ({
      ...prev,
      categoryId: next.categoryId ?? '',
      taskId: next.taskId ?? '',
    }));
  }, [href]);

  const resolvedTitle = useMemo(() => {
    const baseTitle = title.split('·')[0]?.trim() || '文章列表';
    if (!query.categoryId && !query.taskId) {
      return baseTitle;
    }
    const parts: string[] = [baseTitle];
    if (query.categoryId) {
      const matchedSummary =
        categorySummary && categorySummary.id === query.categoryId
          ? categorySummary.name
          : undefined;
      const catName =
        matchedSummary ||
        formOptions?.categories.find((c) => c.id === query.categoryId)?.name ||
        sanitizeEntityTitleSegment(query.categoryId, '按分类筛选');
      parts.push(catName);
    }
    if (query.taskId) {
      const taskName =
        formOptions?.tasks.find((t) => t.id === query.taskId)?.name ||
        sanitizeEntityTitleSegment(query.taskId, '按任务筛选');
      parts.push(taskName);
    }
    return parts.join(' · ');
  }, [categorySummary, formOptions, query.categoryId, query.taskId, title]);
  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  const [banner, setBanner] = useState<BannerState | null>(null);

  // Delete confirmation modal
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkStatusLoading, setBulkStatusLoading] = useState(false);

  const saveDownload = useCallback(
    (file: ArticleDownloadFile) => {
      if (onDownload) {
        onDownload(file);
      } else {
        triggerBlobDownload(file);
      }
    },
    [onDownload],
  );

  const refreshFormOptions = useCallback(async (): Promise<ArticleFormOptions | null> => {
    try {
      const opts = await client.loadFormOptions();
      setFormOptions(opts);
      return opts;
    } catch {
      return null;
    }
  }, [client]);

  useEffect(() => {
    void refreshFormOptions();
  }, [refreshFormOptions]);

  useTabFreshness({
    active,
    domains: ['categories', 'gallery', 'tasks', 'articles'],
    onRefresh: (reason) => {
      void refreshFormOptions();
      if (reason === 'invalidated') {
        setReloadTick((n) => n + 1);
      }
    },
  });

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.list(query);
      setRows(res.items);
      setTotal(res.total);
      setCategorySummary(res.categorySummary);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '读取文章列表失败',
      });
    } finally {
      setLoading(false);
    }
  }, [client, query]);

  useEffect(() => {
    void loadList();
  }, [loadList, reloadTick]);

  const handleEditorLoadError = useCallback((text: string) => {
    setBanner({ type: 'error', text });
  }, []);

  const editorController = useArticleEditorController({
    client,
    readOnly,
    formOptions,
    refreshFormOptions,
    onLoadError: handleEditorLoadError,
  });
  const { editor, setEditor, editorLoading, openCreateModal, openEditModal } = editorController;

  const applyFilters = () => {
    const invalid = validateFilterDraft(filterDraft);
    if (invalid) {
      setBanner({ type: 'warning', text: invalid });
      return;
    }
    const nextFields = filterDraftToQueryFields(filterDraft);
    const nextCategoryId = nextFields.categoryId;
    const nextTaskId = nextFields.taskId;
    if (nextCategoryId !== query.categoryId) {
      setCategorySummary(null);
    }
    const nextHref = buildArticlesRouteHref(nextCategoryId, nextTaskId);
    setSelectedIds([]);
    setQuery((prev) => ({ ...prev, page: 1, ...nextFields }));
    if (onDispatch && nextHref !== href && tabId !== nextHref) {
      stashFilterHandoff(nextHref, {
        ...filterDraft,
        categoryId: nextCategoryId ?? '',
        taskId: nextTaskId ?? '',
      });
      onDispatch({ type: 'navigate', id: tabId, href: nextHref });
    }
  };

  const resetFilters = () => {
    clearFilterHandoffs();
    setSelectedIds([]);
    setCategorySummary(null);
    setFilterDraft(EMPTY_FILTER_DRAFT);
    setQuery((prev) => ({
      ...prev,
      page: 1,
      ...filterDraftToQueryFields(EMPTY_FILTER_DRAFT),
    }));
    if (href !== ARTICLES_ROUTE || tabId !== ARTICLES_ROUTE) {
      onDispatch?.({ type: 'navigate', id: tabId, href: ARTICLES_ROUTE });
    }
  };

  const handleBulkSetNormal = async () => {
    if (readOnly || selectedIds.length === 0) return;
    setBulkStatusLoading(true);
    try {
      const res = await client.bulkStatus({ ids: selectedIds, status: 'NORMAL' });
      setBanner({
        type: 'success',
        text: `已将 ${res.updated} 篇文章设为「正常」，分类剩余可用量已同步更新`,
      });
      setSelectedIds([]);
      setReloadTick((n) => n + 1);
      void refreshFormOptions();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '批量设为正常失败',
      });
    } finally {
      setBulkStatusLoading(false);
    }
  };

  const handleApproveOne = async (articleId: string) => {
    if (readOnly) return;
    try {
      const updated: ArticleDetailRecord = await client.approve(articleId);
      setBanner({
        type: 'success',
        text: `文章「${updated.title}」已设为「正常」`,
      });
      if (editor && editor.articleId === articleId) {
        setEditor((cur) => (cur ? { ...cur, draft: { ...cur.draft, status: 'NORMAL' } } : cur));
      }
      setReloadTick((n) => n + 1);
      void refreshFormOptions();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '设为正常失败',
      });
    }
  };

  const handleArticleSaved = (_article: ArticleDetailRecord, notice: string) => {
    setBanner({ type: 'success', text: notice });
    setReloadTick((n) => n + 1);
    invalidateFreshness('articles', 'categories');
    void refreshFormOptions();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTargetIds || deleteTargetIds.length === 0) return;
    setDeleting(true);
    try {
      const res = await client.bulkDelete(deleteTargetIds);
      setBanner({ type: 'success', text: `已删除 ${res.deleted} 篇文章` });
      setSelectedIds((prev) => prev.filter((id) => !deleteTargetIds.includes(id)));
      setDeleteTargetIds(null);
      setReloadTick((n) => n + 1);
      invalidateFreshness('articles', 'categories');
      void refreshFormOptions();
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '删除文章失败',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleExportZip = async (format: ArticleArchiveFormat) => {
    if (!loading && total === 0 && rows.length === 0 && selectedIds.length === 0) {
      setBanner({ type: 'warning', text: '当前列表暂无可导出数据' });
      return;
    }
    setExportingZip(true);
    try {
      const file = await client.exportZip({
        format,
        ids: selectedIds.length > 0 ? selectedIds : undefined,
        categoryId: selectedIds.length === 0 ? (query.categoryId ?? null) : null,
        taskId: selectedIds.length === 0 ? (query.taskId ?? null) : null,
        status: selectedIds.length === 0 ? query.status : undefined,
        keyword: selectedIds.length === 0 && query.keyword ? query.keyword : undefined,
      });
      saveDownload(file);
      setBanner({
        type: 'success',
        text: `已导出 ${ARCHIVE_FORMAT_LABELS[format]} 压缩包：${file.filename}`,
      });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '导出压缩包失败',
      });
    } finally {
      setExportingZip(false);
    }
  };

  const handleExportTable = async (format: 'csv' | 'xlsx') => {
    try {
      const file = await client.downloadTable(query, format);
      saveDownload(file);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '导出列表失败',
      });
    }
  };

  return (
    <section aria-label={title}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <Space align="center" wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {resolvedTitle}
          </Typography.Title>
          {categorySummary ? (
            <Tag color="blue" style={{ fontSize: 13, padding: '2px 10px' }}>
              当前分类：{categorySummary.name} · 总文章 {categorySummary.total} 篇 · 剩余可用{' '}
              {categorySummary.remaining} 篇
            </Tag>
          ) : null}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提示：双击任意行（含状态单元格）将打开编辑弹窗，不会隐式筛选列表
        </Typography.Text>
      </div>

      {banner ? (
        <Alert
          type={banner.type}
          message={banner.text}
          showIcon
          closable
          onClose={() => setBanner(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {/* 工具栏 */}
      <CrudToolbar
        style={{ marginBottom: 12 }}
        createDisabled={readOnly}
        createLoading={editorLoading && !editor}
        onCreate={() => void openCreateModal()}
        onRefresh={() => setReloadTick((n) => n + 1)}
        deleteDisabled={readOnly || selectedIds.length === 0}
        onDelete={() => setDeleteTargetIds(selectedIds)}
        extraLeft={
          <>
            <Button
              aria-label="批量设为正常"
              disabled={readOnly || selectedIds.length === 0}
              loading={bulkStatusLoading}
              onClick={() => void handleBulkSetNormal()}
            >
              批量设为正常
            </Button>
            <Button
              aria-label="返回上一级"
              onClick={() => onDispatch?.({ type: 'back', id: tabId })}
            >
              返回上一级
            </Button>
            <Button
              aria-label="文章分类"
              onClick={() =>
                onDispatch?.({
                  type: 'open',
                  href: '/writing/categories',
                  sourceId: tabId,
                })
              }
            >
              文章分类
            </Button>
          </>
        }
        right={
          <>
            <select
              aria-label="压缩包格式"
              style={COMPACT_SELECT_STYLE}
              value={archiveFormat}
              onChange={(e) => setArchiveFormat(e.target.value as ArticleArchiveFormat)}
            >
              {ARTICLE_EXPORT_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {ARCHIVE_FORMAT_LABELS[fmt]}
                </option>
              ))}
            </select>
            <Button
              aria-label="打包导出"
              loading={exportingZip}
              onClick={() => void handleExportZip(archiveFormat)}
            >
              打包导出 (.zip)
            </Button>
            <ExportAction
              label="导出表格"
              ariaLabel="导出表格"
              empty={!loading && total === 0 && rows.length === 0}
              options={[
                { key: 'csv', label: 'CSV 列表' },
                { key: 'xlsx', label: 'Excel 列表' },
              ]}
              onExport={handleExportTable}
            />
            <Button
              aria-label={filterOpen ? '收起筛选' : '展开筛选'}
              onClick={() => setFilterOpen((v) => !v)}
            >
              {filterOpen ? '收起筛选' : '展开筛选'}
            </Button>
          </>
        }
      />

      {/* 7 项筛选栏：分类、AI 任务、标题、发送次数、转视频次数、状态、创建时间 */}
      {filterOpen ? (
        <ArticleFilterPanel
          filterDraft={filterDraft}
          setFilterDraft={setFilterDraft}
          formOptions={formOptions}
          onApply={applyFilters}
          onReset={resetFilters}
        />
      ) : null}

      {/* 列表表格：双击任意单元格（含状态列）统一进入编辑表单，绝不做隐式筛选 */}
      <Table<ArticleManageItem>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: CRUD_EMPTY_TEXT }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(String)),
        }}
        onRow={(record) => ({
          onDoubleClick: () => {
            if (!readOnly) void openEditModal(record.id);
          },
          style: { cursor: readOnly ? 'default' : 'pointer' },
        })}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: CRUD_PAGE_SIZES.map(String),
          showTotal: (count) => `共 ${count} 篇`,
          onChange: (nextPage, nextSize) => {
            const validSize = (CRUD_PAGE_SIZES as readonly number[]).includes(nextSize)
              ? (nextSize as CrudPageSize)
              : query.pageSize;
            setQuery((prev) => ({
              ...prev,
              page: nextPage,
              pageSize: validSize,
            }));
          },
        }}
        columns={buildArticleTableColumns({
          page: query.page,
          pageSize: query.pageSize,
          readOnly,
          onEdit: (id) => void openEditModal(id),
          onApprove: (id) => void handleApproveOne(id),
          onDelete: (id) => setDeleteTargetIds([id]),
        })}
      />

      {/* 手动添加 / 编辑文章弹窗 */}
      <ArticleEditorModal
        controller={editorController}
        client={client}
        formOptions={formOptions}
        refreshFormOptions={refreshFormOptions}
        onApprove={(id) => void handleApproveOne(id)}
        onSaved={handleArticleSaved}
      />

      {/* 删除确认弹窗 */}
      <Modal
        open={Boolean(deleteTargetIds)}
        title="确认删除文章"
        centered
        transitionName=""
        maskTransitionName=""
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
        onCancel={() => {
          if (!deleting) setDeleteTargetIds(null);
        }}
        onOk={() => void handleConfirmDelete()}
      >
        <p>
          确定要删除选中的 {deleteTargetIds?.length ?? 0}{' '}
          篇文章吗？删除后分类文章数与剩余可用量将实时重算。
        </p>
      </Modal>
    </section>
  );
}
