/* eslint-disable @next/next/no-img-element */
'use client';

import {
  ARTICLE_EXPORT_FORMATS,
  ARTICLE_SOURCE_LABELS,
  ARTICLE_STATUSES,
  ARTICLE_STATUS_LABEL,
  ARTICLE_TITLE_MAX,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  countArticleWords,
  isArticleStatus,
  sanitizeRichArticleHtml,
  type ArticleArchiveFormat,
  type ArticleDetailRecord,
  type ArticleManageItem,
  type ArticleManageListResponse,
  type ArticleManageQuery,
  type ArticleSortName,
  type ArticleStatusName,
  type CrudOrder,
  type CrudPageSize,
  type MediaAssetRecord,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import type { CSSProperties, ChangeEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import {
  articleQueryFromHref,
  httpArticleManageGateway,
  type ArticleDownloadFile,
  type ArticleFormOptions,
  type ArticleManageGateway,
} from '../../lib/articles';
import { resolveMediaUrl } from '../../lib/gallery';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import {
  formatShanghaiDateTime,
  sanitizeEntityTitleSegment,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import {
  ArticleRichEditor,
  type ArticleRichEditorHandle,
  type RichEditorCommand,
} from './article-rich-editor';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 14,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

const ARCHIVE_FORMAT_LABELS: Record<ArticleArchiveFormat, string> = {
  md: 'Markdown (.md)',
  html: 'HTML (.html)',
  docx: 'Word (.docx)',
};

const SHORT_VIDEO_WORD_LIMIT = 1000;

const RED_TYPOGRAPHY_TIP =
  '排版提示：抖音、小红书类文字建议控制在1000字之内，会自动清除展示排版；建议采用二级/三级小标题与短段落结构排版，请勿粘贴外部追踪脚本、诱导外链或联系方式水印，保存时系统将自动清洗不安全标签。';

type FilterDraft = {
  categoryId: string;
  taskId: string;
  keyword: string;
  sendCount: string;
  videoCount: string;
  status: string;
  createdFrom: string;
  createdTo: string;
  sort: ArticleSortName;
  order: CrudOrder;
};

type ArticleEditorDraft = {
  title: string;
  categoryId: string;
  mediaCategoryId: string;
  coverUrl: string | null;
  status: ArticleStatusName;
  contentHtml: string;
};

type EditorModalState = {
  mode: 'create' | 'edit';
  articleId?: string;
  initial: ArticleEditorDraft;
  draft: ArticleEditorDraft;
  minimized: boolean;
  maximized: boolean;
  editorTab: 'visual' | 'preview' | 'source';
};

const pendingFilterHandoffs = new Map<string, FilterDraft>();

export function buildArticlesRouteHref(categoryId?: string, taskId?: string): string {
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', categoryId);
  if (taskId) params.set('taskId', taskId);
  const qs = params.toString();
  return qs ? `/writing/articles?${qs}` : '/writing/articles';
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

function statusTagColor(status: ArticleStatusName): string {
  switch (status) {
    case 'NORMAL':
      return 'success';
    case 'PENDING':
      return 'gold';
    case 'DISABLED':
    default:
      return 'default';
  }
}

function parseOptionalIntInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function buildDefaultCreateDraft(
  options: ArticleFormOptions | null,
  preferredCategoryId?: string,
): ArticleEditorDraft {
  const defaultCategory =
    (preferredCategoryId && options?.categories.find((c) => c.id === preferredCategoryId)?.id) ||
    '';

  return {
    title: '',
    categoryId: defaultCategory,
    mediaCategoryId: '',
    coverUrl: null,
    status: 'NORMAL',
    contentHtml: '<p></p>',
  };
}

export function ArticleManageScreen({
  title,
  tabId,
  href = '/writing/articles',
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
  const [initialHandoff] = useState<FilterDraft | null>(() => {
    const handoff = pendingFilterHandoffs.get(href) ?? null;
    if (handoff) pendingFilterHandoffs.delete(href);
    return handoff;
  });
  const prevHrefRef = useRef(href);

  const [query, setQuery] = useState<ArticleManageQuery>(() => ({
    page: 1,
    pageSize: 10,
    categoryId: initialUrlFilter.categoryId,
    taskId: initialUrlFilter.taskId,
    keyword: initialHandoff?.keyword.trim() ?? '',
    status:
      initialHandoff && isArticleStatus(initialHandoff.status) ? initialHandoff.status : undefined,
    sendCount: initialHandoff ? parseOptionalIntInput(initialHandoff.sendCount) : undefined,
    videoCount: initialHandoff ? parseOptionalIntInput(initialHandoff.videoCount) : undefined,
    createdFrom: initialHandoff?.createdFrom || undefined,
    createdTo: initialHandoff?.createdTo || undefined,
    sort: initialHandoff?.sort ?? 'createdAt',
    order: initialHandoff?.order ?? 'desc',
  }));

  const [filterDraft, setFilterDraft] = useState<FilterDraft>(() => ({
    categoryId: initialUrlFilter.categoryId ?? '',
    taskId: initialUrlFilter.taskId ?? '',
    keyword: initialHandoff?.keyword ?? '',
    sendCount: initialHandoff?.sendCount ?? '',
    videoCount: initialHandoff?.videoCount ?? '',
    status: initialHandoff?.status ?? '',
    createdFrom: initialHandoff?.createdFrom ?? '',
    createdTo: initialHandoff?.createdTo ?? '',
    sort: initialHandoff?.sort ?? 'createdAt',
    order: initialHandoff?.order ?? 'desc',
  }));

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

  const [banner, setBanner] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  // Modal editor state
  const [editor, setEditor] = useState<EditorModalState | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [galleryAssets, setGalleryAssets] = useState<MediaAssetRecord[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const richEditorRef = useRef<ArticleRichEditorHandle | null>(null);

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

  const loadAssetsForMediaCategory = useCallback(
    async (mediaCategoryId: string, autoPickCover: boolean) => {
      if (!mediaCategoryId) {
        setGalleryAssets([]);
        return;
      }
      setGalleryLoading(true);
      try {
        const assets = await client.listGalleryAssets(mediaCategoryId);
        setGalleryAssets(assets);
        if (autoPickCover && assets[0]) {
          setEditor((cur) =>
            cur
              ? {
                  ...cur,
                  draft: {
                    ...cur.draft,
                    coverUrl: assets[0]?.url ?? cur.draft.coverUrl,
                  },
                }
              : cur,
          );
        }
      } catch {
        setGalleryAssets([]);
      } finally {
        setGalleryLoading(false);
      }
    },
    [client],
  );

  const openCreateModal = async () => {
    if (readOnly) return;
    setFormError(null);
    setEditorLoading(true);
    try {
      const opts = (await refreshFormOptions()) ?? formOptions;
      const initial = buildDefaultCreateDraft(opts);
      setEditor({
        mode: 'create',
        initial,
        draft: initial,
        minimized: false,
        maximized: false,
        editorTab: 'visual',
      });
      if (initial.mediaCategoryId) {
        await loadAssetsForMediaCategory(initial.mediaCategoryId, !initial.coverUrl);
      } else {
        setGalleryAssets([]);
      }
    } finally {
      setEditorLoading(false);
    }
  };

  const openEditModal = useCallback(
    async (articleId: string) => {
      if (readOnly) return;
      setFormError(null);
      setEditorLoading(true);
      try {
        const [detail, opts] = await Promise.all([client.detail(articleId), refreshFormOptions()]);
        const resolvedOptions = opts ?? formOptions;
        const defaultMediaCatId = resolvedOptions?.mediaCategories[0]?.id ?? '';
        const initial: ArticleEditorDraft = {
          title: detail.title,
          categoryId: detail.categoryId ?? resolvedOptions?.categories[0]?.id ?? '',
          mediaCategoryId: defaultMediaCatId,
          coverUrl: detail.coverUrl,
          status: detail.status,
          contentHtml: detail.contentHtml || '<p></p>',
        };
        setEditor({
          mode: 'edit',
          articleId: detail.id,
          initial,
          draft: initial,
          minimized: false,
          maximized: false,
          editorTab: 'visual',
        });
        if (defaultMediaCatId) {
          await loadAssetsForMediaCategory(defaultMediaCatId, false);
        } else {
          setGalleryAssets([]);
        }
      } catch (err: unknown) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '读取文章详情失败',
        });
      } finally {
        setEditorLoading(false);
      }
    },
    [client, formOptions, loadAssetsForMediaCategory, readOnly, refreshFormOptions],
  );

  const applyFilters = () => {
    if (
      filterDraft.sendCount.trim() &&
      parseOptionalIntInput(filterDraft.sendCount) === undefined
    ) {
      setBanner({ type: 'warning', text: '发送次数筛选需填写非负整数' });
      return;
    }
    if (
      filterDraft.videoCount.trim() &&
      parseOptionalIntInput(filterDraft.videoCount) === undefined
    ) {
      setBanner({ type: 'warning', text: '转视频次数筛选需填写非负整数' });
      return;
    }
    const nextCategoryId = filterDraft.categoryId || undefined;
    const nextTaskId = filterDraft.taskId || undefined;
    if (nextCategoryId !== query.categoryId) {
      setCategorySummary(null);
    }
    const nextHref = buildArticlesRouteHref(nextCategoryId, nextTaskId);
    setSelectedIds([]);
    setQuery((prev) => ({
      ...prev,
      page: 1,
      categoryId: nextCategoryId,
      taskId: nextTaskId,
      keyword: filterDraft.keyword.trim(),
      sendCount: parseOptionalIntInput(filterDraft.sendCount),
      videoCount: parseOptionalIntInput(filterDraft.videoCount),
      status: isArticleStatus(filterDraft.status) ? filterDraft.status : undefined,
      createdFrom: filterDraft.createdFrom || undefined,
      createdTo: filterDraft.createdTo || undefined,
      sort: filterDraft.sort,
      order: filterDraft.order,
    }));
    if (onDispatch && nextHref !== href && tabId !== nextHref) {
      pendingFilterHandoffs.set(nextHref, {
        ...filterDraft,
        categoryId: nextCategoryId ?? '',
        taskId: nextTaskId ?? '',
      });
      onDispatch({ type: 'navigate', id: tabId, href: nextHref });
    }
  };

  const resetFilters = () => {
    pendingFilterHandoffs.clear();
    setSelectedIds([]);
    setCategorySummary(null);
    setFilterDraft({
      categoryId: '',
      taskId: '',
      keyword: '',
      sendCount: '',
      videoCount: '',
      status: '',
      createdFrom: '',
      createdTo: '',
      sort: 'createdAt',
      order: 'desc',
    });
    setQuery((prev) => ({
      ...prev,
      page: 1,
      categoryId: undefined,
      taskId: undefined,
      keyword: '',
      sendCount: undefined,
      videoCount: undefined,
      status: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      sort: 'createdAt',
      order: 'desc',
    }));
    if (href !== '/writing/articles' || tabId !== '/writing/articles') {
      onDispatch?.({ type: 'navigate', id: tabId, href: '/writing/articles' });
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

  const appendRichBlock = (snippet: string) => {
    setEditor((cur) => {
      if (!cur) return cur;
      const base = cur.draft.contentHtml === '<p></p>' ? '' : cur.draft.contentHtml;
      return {
        ...cur,
        draft: {
          ...cur.draft,
          contentHtml: `${base}${base ? '\n' : ''}${snippet}`,
        },
      };
    });
  };

  const applyEditorCommand = (cmd: RichEditorCommand, fallbackSnippet: string) => {
    if (editor?.editorTab === 'visual' && richEditorRef.current) {
      richEditorRef.current.applyFormat(cmd);
      return;
    }
    appendRichBlock(fallbackSnippet);
  };

  const handleCoverUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editor) return;
    if (!editor.draft.mediaCategoryId) {
      setFormError('请先选择画像封面所属的图库分组再上传');
      return;
    }
    setUploadingCover(true);
    setFormError(null);
    try {
      const asset = await client.uploadCoverAsset(editor.draft.mediaCategoryId, file);
      setGalleryAssets((prev) => [asset, ...prev]);
      setEditor((cur) => (cur ? { ...cur, draft: { ...cur.draft, coverUrl: asset.url } } : cur));
      void refreshFormOptions();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '上传封面图片失败');
    } finally {
      setUploadingCover(false);
    }
  };

  const handleSaveArticle = async () => {
    if (!editor) return;
    const trimmedTitle = editor.draft.title.trim();
    const wordCount = countArticleWords(editor.draft.contentHtml);
    const errors: string[] = [];
    if (!trimmedTitle) errors.push('请填写文章标题');
    if (!editor.draft.categoryId) errors.push('请选择归属分类');
    if (wordCount === 0) errors.push('请填写文章正文内容');
    if (errors.length > 0) {
      setFormError(errors.join('；'));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      if (editor.mode === 'create') {
        await client.create({
          title: trimmedTitle,
          categoryId: editor.draft.categoryId,
          mediaCategoryId: editor.draft.mediaCategoryId || null,
          coverUrl: editor.draft.coverUrl,
          status: editor.draft.status,
          contentHtml: editor.draft.contentHtml,
        });
        setBanner({
          type: 'success',
          text: `手动文章「${trimmedTitle}」已创建（状态：${ARTICLE_STATUS_LABEL[editor.draft.status]}）`,
        });
      } else if (editor.articleId) {
        await client.update(editor.articleId, {
          title: trimmedTitle,
          categoryId: editor.draft.categoryId,
          coverUrl: editor.draft.coverUrl,
          status: editor.draft.status,
          contentHtml: editor.draft.contentHtml,
        });
        setBanner({
          type: 'success',
          text: `文章「${trimmedTitle}」已保存更新`,
        });
      }
      setEditor(null);
      setReloadTick((n) => n + 1);
      invalidateFreshness('articles', 'categories');
      void refreshFormOptions();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '保存文章失败');
    } finally {
      setSubmitting(false);
    }
  };

  const [plainCopied, setPlainCopied] = useState(false);

  const editorWordCount = useMemo(
    () => (editor ? countArticleWords(editor.draft.contentHtml) : 0),
    [editor],
  );

  const sanitizedEditorContent = useMemo(
    () => (editor ? sanitizeRichArticleHtml(editor.draft.contentHtml) : null),
    [editor],
  );
  const sanitizedPreviewHtml = sanitizedEditorContent?.contentHtml ?? '';
  const editorPlainText = sanitizedEditorContent?.contentText ?? '';

  const handleCopyPlainText = async () => {
    const text = editorPlainText.trim();
    if (!text) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setPlainCopied(true);
      setTimeout(() => {
        setPlainCopied(false);
      }, 2_000);
    } catch {
      setFormError('当前浏览器环境不支持自动复制，请切换预览后手动复制');
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
      <div className="gm-crud-toolbar" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Button aria-label="刷新" onClick={() => setReloadTick((n) => n + 1)}>
            刷新
          </Button>
          <Button
            type="primary"
            aria-label="添加"
            disabled={readOnly}
            loading={editorLoading && !editor}
            onClick={() => void openCreateModal()}
          >
            添加
          </Button>
          <Button
            danger
            aria-label="删除"
            disabled={readOnly || selectedIds.length === 0}
            onClick={() => setDeleteTargetIds(selectedIds)}
          >
            删除
          </Button>
          <Button
            aria-label="批量设为正常"
            disabled={readOnly || selectedIds.length === 0}
            loading={bulkStatusLoading}
            onClick={() => void handleBulkSetNormal()}
          >
            批量设为正常
          </Button>
          <Button aria-label="返回上一级" onClick={() => onDispatch?.({ type: 'back', id: tabId })}>
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
        </Space>

        <Space wrap>
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
        </Space>
      </div>

      {/* 7 项筛选栏：分类、AI 任务、标题、发送次数、转视频次数、状态、创建时间 */}
      {filterOpen ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
            gap: 10,
            padding: 12,
            marginBottom: 12,
            borderRadius: 8,
            background: 'var(--gm-bg-surface)',
            border: '1px solid var(--gm-line-1)',
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>分类</div>
            <select
              aria-label="分类筛选"
              style={NATIVE_SELECT_STYLE}
              value={filterDraft.categoryId}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, categoryId: e.target.value }))}
            >
              <option value="">全部分类</option>
              {(formOptions?.categories ?? []).map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}（{cat.total}）
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>AI 任务</div>
            <select
              aria-label="AI 任务筛选"
              style={NATIVE_SELECT_STYLE}
              value={filterDraft.taskId}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, taskId: e.target.value }))}
            >
              <option value="">全部任务</option>
              {(formOptions?.tasks ?? []).map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>标题</div>
            <Input
              aria-label="标题筛选"
              placeholder="输入标题关键词"
              value={filterDraft.keyword}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, keyword: e.target.value }))}
              onPressEnter={applyFilters}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>发送次数</div>
            <Input
              aria-label="发送次数筛选"
              placeholder="例如 0"
              value={filterDraft.sendCount}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, sendCount: e.target.value }))}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>转视频次数</div>
            <Input
              aria-label="转视频次数筛选"
              placeholder="例如 0"
              value={filterDraft.videoCount}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, videoCount: e.target.value }))}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>状态</div>
            <select
              aria-label="状态筛选"
              style={NATIVE_SELECT_STYLE}
              value={filterDraft.status}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, status: e.target.value }))}
            >
              <option value="">全部状态</option>
              {ARTICLE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {ARTICLE_STATUS_LABEL[st]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
              创建开始日期
            </div>
            <Input
              type="date"
              aria-label="创建开始日期"
              value={filterDraft.createdFrom}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, createdFrom: e.target.value }))}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
              创建结束日期
            </div>
            <Input
              type="date"
              aria-label="创建结束日期"
              value={filterDraft.createdTo}
              onChange={(e) => setFilterDraft((cur) => ({ ...cur, createdTo: e.target.value }))}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Button type="primary" aria-label="查询" onClick={applyFilters}>
              查询
            </Button>
            <Button aria-label="重置筛选" onClick={resetFilters}>
              重置筛选
            </Button>
          </div>
        </div>
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
        columns={[
          {
            key: 'index',
            title: '序号',
            width: 68,
            render: (_, __, index) => (query.page - 1) * query.pageSize + index + 1,
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
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {ARTICLE_SOURCE_LABELS[row.source]}
                    </span>
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
                    void openEditModal(row.id);
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
                      void handleApproveOne(row.id);
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
                    setDeleteTargetIds([row.id]);
                  }}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {/* 手动添加 / 编辑文章弹窗 */}
      <CrudModal
        open={Boolean(editor)}
        title={editor?.mode === 'edit' ? '编辑文章' : '手动添加文章'}
        minimized={editor?.minimized ?? false}
        maximized={editor?.maximized ?? false}
        confirmLoading={submitting}
        error={formError}
        onMinimize={() => setEditor((cur) => (cur ? { ...cur, minimized: true } : cur))}
        onRestore={() => {
          setEditor((cur) => (cur ? { ...cur, minimized: false } : cur));
          void refreshFormOptions();
        }}
        onMaximize={() => setEditor((cur) => (cur ? { ...cur, maximized: !cur.maximized } : cur))}
        onClose={() => {
          if (!submitting) setEditor(null);
        }}
        onReset={() => {
          setFormError(null);
          setEditor((cur) => (cur ? { ...cur, draft: cur.initial } : cur));
        }}
        ok={
          <Space>
            {editor?.mode === 'edit' && editor.articleId && editor.draft.status !== 'NORMAL' ? (
              <Button
                aria-label="弹窗设为正常"
                disabled={submitting}
                onClick={() => {
                  if (editor.articleId) void handleApproveOne(editor.articleId);
                }}
              >
                设为正常
              </Button>
            ) : null}
            <Button
              type="primary"
              aria-label="保存文章"
              loading={submitting}
              onClick={() => void handleSaveArticle()}
            >
              保存文章
            </Button>
          </Space>
        }
      >
        {editor ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  <span style={{ color: 'var(--gm-danger)' }}>* </span>标题
                </div>
                <Input
                  aria-label="文章标题"
                  maxLength={ARTICLE_TITLE_MAX}
                  placeholder="请输入文章标题"
                  value={editor.draft.title}
                  onChange={(e) =>
                    setEditor((cur) =>
                      cur ? { ...cur, draft: { ...cur.draft, title: e.target.value } } : cur,
                    )
                  }
                />
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  <span style={{ color: 'var(--gm-danger)' }}>* </span>归属分类
                </div>
                <select
                  aria-label="归属分类"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.categoryId}
                  onChange={(e) =>
                    setEditor((cur) =>
                      cur ? { ...cur, draft: { ...cur.draft, categoryId: e.target.value } } : cur,
                    )
                  }
                >
                  <option value="">不选择</option>
                  {(formOptions?.categories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}（共 {cat.total} 篇 / 剩余 {cat.remaining} 篇）
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>画像封面（图库分组）</div>
                <select
                  aria-label="画像封面分组"
                  style={NATIVE_SELECT_STYLE}
                  value={editor.draft.mediaCategoryId}
                  onChange={(e) => {
                    const nextMediaCatId = e.target.value;
                    setEditor((cur) =>
                      cur
                        ? {
                            ...cur,
                            draft: { ...cur.draft, mediaCategoryId: nextMediaCatId },
                          }
                        : cur,
                    );
                    void loadAssetsForMediaCategory(nextMediaCatId, true);
                  }}
                >
                  <option value="">不选择</option>
                  {(formOptions?.mediaCategories ?? []).map((mc) => (
                    <option key={mc.id} value={mc.id}>
                      {mc.name}（{mc.assetCount} 张图片）
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>状态</div>
                <div
                  role="radiogroup"
                  aria-label="文章状态"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    minHeight: 32,
                    flexWrap: 'wrap',
                  }}
                >
                  {ARTICLE_STATUSES.map((st) => (
                    <label
                      key={st}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        margin: 0,
                        cursor: 'pointer',
                        fontSize: 14,
                      }}
                    >
                      <input
                        type="radio"
                        name="article-status"
                        value={st}
                        checked={editor.draft.status === st}
                        onChange={() =>
                          setEditor((cur) =>
                            cur
                              ? {
                                  ...cur,
                                  draft: { ...cur.draft, status: st },
                                }
                              : cur,
                          )
                        }
                      />
                      <span>{ARTICLE_STATUS_LABEL[st]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* 封面预览、图库候选带出、上传与移除 */}
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px dashed var(--gm-line-1)',
                background: 'var(--gm-bg-surface)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <Space size={8} wrap>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>当前封面：</span>
                  {editor.draft.coverUrl ? (
                    <>
                      <Tag color="green">已设置封面</Tag>
                      <img
                        src={resolveMediaUrl(editor.draft.coverUrl)}
                        alt="已选文章封面"
                        style={{
                          width: 48,
                          height: 34,
                          objectFit: 'cover',
                          borderRadius: 4,
                          border: '2px solid var(--gm-phosphor)',
                        }}
                      />
                      <span style={{ display: 'none' }}>{editor.draft.coverUrl}</span>
                    </>
                  ) : (
                    <Tag>未设置封面</Tag>
                  )}
                  {galleryLoading ? (
                    <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>加载图库图片中...</span>
                  ) : null}
                </Space>
                <Space size={8}>
                  <input
                    ref={coverFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="上传封面文件"
                    style={{ display: 'none' }}
                    onChange={(e) => void handleCoverUploadChange(e)}
                  />
                  <Button
                    size="small"
                    loading={uploadingCover}
                    disabled={!editor.draft.mediaCategoryId}
                    onClick={() => coverFileInputRef.current?.click()}
                  >
                    上传新封面
                  </Button>
                  {editor.draft.coverUrl ? (
                    <Button
                      size="small"
                      danger
                      aria-label="移除封面"
                      onClick={() =>
                        setEditor((cur) =>
                          cur ? { ...cur, draft: { ...cur.draft, coverUrl: null } } : cur,
                        )
                      }
                    >
                      移除封面
                    </Button>
                  ) : null}
                </Space>
              </div>

              {galleryAssets.length > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginTop: 8,
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>候选封面：</span>
                  {galleryAssets.slice(0, 8).map((asset, idx) => {
                    const active = editor.draft.coverUrl === asset.url;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        aria-label={`选择封面图 ${idx + 1}`}
                        onClick={() =>
                          setEditor((cur) =>
                            cur ? { ...cur, draft: { ...cur.draft, coverUrl: asset.url } } : cur,
                          )
                        }
                        style={{
                          padding: 0,
                          border: active
                            ? '2px solid var(--gm-phosphor)'
                            : '1px solid var(--gm-line-1)',
                          borderRadius: 4,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          background: 'var(--gm-bg-surface)',
                        }}
                      >
                        <img
                          src={resolveMediaUrl(asset.thumbUrl || asset.url)}
                          alt={`图库候选 ${idx + 1}`}
                          style={{ width: 48, height: 34, objectFit: 'cover', display: 'block' }}
                        />
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {/* 富文本编辑器（工具栏 + 红字排版提示 + 实时字数统计） */}
            <div>
              <div
                role="note"
                style={{
                  color: 'var(--gm-danger)',
                  background: 'rgba(240,96,93,0.08)',
                  border: '1px solid rgba(240,96,93,0.32)',
                  borderRadius: 6,
                  padding: '5px 10px',
                  fontSize: 12,
                  marginBottom: 6,
                }}
              >
                {RED_TYPOGRAPHY_TIP}
              </div>

              {editorWordCount > SHORT_VIDEO_WORD_LIMIT ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 6 }}
                  message={`当前正文字数已达 ${editorWordCount} 字，超过抖音、小红书建议的 ${SHORT_VIDEO_WORD_LIMIT} 字上限，建议精简篇幅或点击「复制纯文本」粘贴后按平台字数微调。`}
                />
              ) : null}

              <div
                style={{
                  border: '1px solid var(--gm-line-1)',
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 6,
                    padding: '6px 10px',
                    background: 'var(--gm-bg-elevated)',
                    borderBottom: '1px solid var(--gm-line-1)',
                  }}
                >
                  {editor.editorTab === 'preview' ? (
                    <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                      当前为只读排版预览（切换「可视化编辑」可继续修改）
                    </span>
                  ) : (
                    <Space size={4} wrap>
                      <Button
                        size="small"
                        onClick={() => applyEditorCommand('p', '<p>正文段落内容</p>')}
                      >
                        正文
                      </Button>
                      <Button
                        size="small"
                        onClick={() => applyEditorCommand('h2', '<h2>二级小标题</h2>')}
                      >
                        H2
                      </Button>
                      <Button
                        size="small"
                        onClick={() => applyEditorCommand('h3', '<h3>三级小标题</h3>')}
                      >
                        H3
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          applyEditorCommand('bold', '<p><strong>重点加粗内容</strong></p>')
                        }
                      >
                        加粗
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          applyEditorCommand('ul', '<ul><li>要点一</li><li>要点二</li></ul>')
                        }
                      >
                        列表
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          applyEditorCommand(
                            'blockquote',
                            '<blockquote>核心结论引用说明</blockquote>',
                          )
                        }
                      >
                        引用
                      </Button>
                    </Space>
                  )}

                  <Space size={8} wrap>
                    <Button
                      size="small"
                      type={editor.editorTab === 'visual' ? 'primary' : 'default'}
                      onClick={() =>
                        setEditor((cur) => (cur ? { ...cur, editorTab: 'visual' } : cur))
                      }
                    >
                      可视化编辑
                    </Button>
                    <Button
                      size="small"
                      type={editor.editorTab === 'preview' ? 'primary' : 'default'}
                      onClick={() =>
                        setEditor((cur) => (cur ? { ...cur, editorTab: 'preview' } : cur))
                      }
                    >
                      排版预览
                    </Button>
                    <Button
                      size="small"
                      type={editor.editorTab === 'source' ? 'primary' : 'default'}
                      onClick={() =>
                        setEditor((cur) => (cur ? { ...cur, editorTab: 'source' } : cur))
                      }
                    >
                      HTML 源码
                    </Button>
                    <Button
                      size="small"
                      aria-label="复制纯文本"
                      disabled={!editorPlainText.trim()}
                      onClick={() => void handleCopyPlainText()}
                    >
                      {plainCopied ? '已复制纯文本' : '复制纯文本'}
                    </Button>
                    <span
                      className="gm-num"
                      aria-label="字数统计"
                      style={{
                        fontSize: 12,
                        color:
                          editorWordCount > SHORT_VIDEO_WORD_LIMIT
                            ? 'var(--gm-danger)'
                            : 'var(--gm-fg-2)',
                        fontWeight: 500,
                      }}
                    >
                      字数统计：{editorWordCount} 字
                    </span>
                  </Space>
                </div>

                {editor.editorTab === 'visual' ? (
                  <ArticleRichEditor
                    ref={richEditorRef}
                    value={editor.draft.contentHtml}
                    onChange={(nextHtml) =>
                      setEditor((cur) =>
                        cur
                          ? {
                              ...cur,
                              draft: { ...cur.draft, contentHtml: nextHtml },
                            }
                          : cur,
                      )
                    }
                  />
                ) : editor.editorTab === 'source' ? (
                  <Input.TextArea
                    aria-label="HTML 源码内容"
                    rows={7}
                    style={{ border: 'none', borderRadius: 0 }}
                    placeholder="高级模式：可直接查看或编辑白名单 HTML 标签（如 <h2>、<p>、<strong>、<ul>）..."
                    value={editor.draft.contentHtml}
                    onChange={(e) =>
                      setEditor((cur) =>
                        cur
                          ? {
                              ...cur,
                              draft: { ...cur.draft, contentHtml: e.target.value },
                            }
                          : cur,
                      )
                    }
                  />
                ) : (
                  <div
                    aria-label="富文本预览区"
                    style={{
                      minHeight: 180,
                      maxHeight: 320,
                      overflowY: 'auto',
                      padding: 12,
                      background: 'var(--gm-bg-surface)',
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitizedPreviewHtml }}
                  />
                )}
              </div>
            </div>
          </div>
        ) : null}
      </CrudModal>

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
