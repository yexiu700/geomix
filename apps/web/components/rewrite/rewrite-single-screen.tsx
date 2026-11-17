'use client';

import {
  ARTICLE_STATUS_LABEL,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  ITEM_STATUS_LABELS,
  REWRITE_DEFAULT_UNIT_POINTS,
  REWRITE_IMAGE_DEFAULT,
  REWRITE_IMAGE_MAX,
  REWRITE_IMAGE_MIN,
  REWRITE_MIN_SOURCE_CHARS,
  REWRITE_RESULT_STATUS_LABELS,
  buildDefaultRewriteCategoryName,
  countSourceNonWhitespaceChars,
  type ArticleStatusName,
  type CrudExportFormat,
  type ItemStatusName,
  type RewriteRecordItem,
  type RewriteRecordListQuery,
  type RewriteResultStatusName,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Slider, Space, Switch, Table, Tag, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import {
  httpRewriteSingleGateway,
  type RewriteDownloadFile,
  type RewriteFormOptions,
  type RewriteSingleGateway,
} from '../../lib/rewrites';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 14,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 13,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

type CreateDraft = {
  pastedText: boolean;
  url: string;
  pastedTitle: string;
  pastedContent: string;
  mediaCategoryId: string;
  imageCount: number;
  templateId: string;
  categoryId: string;
  autoCategoryName: string;
  resultStatus: RewriteResultStatusName;
  brand: string;
};

type ModalState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

function buildInitialDraft(
  _options: RewriteFormOptions | null,
  seed?: Partial<CreateDraft>,
): CreateDraft {
  return {
    pastedText: seed?.pastedText ?? false,
    url: seed?.url ?? '',
    pastedTitle: seed?.pastedTitle ?? '',
    pastedContent: seed?.pastedContent ?? '',
    mediaCategoryId: seed?.mediaCategoryId ?? '',
    imageCount: seed?.imageCount ?? REWRITE_IMAGE_DEFAULT,
    templateId: seed?.templateId ?? '',
    categoryId: seed?.categoryId ?? '',
    autoCategoryName: seed?.autoCategoryName ?? buildDefaultRewriteCategoryName(),
    resultStatus: seed?.resultStatus ?? 'PENDING',
    brand: seed?.brand ?? '',
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

function itemStatusTagColor(status: ItemStatusName): string {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'RUNNING':
      return 'processing';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

function articleStatusTagColor(status: ArticleStatusName): string {
  switch (status) {
    case 'NORMAL':
      return 'green';
    case 'PENDING':
      return 'gold';
    case 'DISABLED':
    default:
      return 'default';
  }
}

function triggerBrowserDownload(file: RewriteDownloadFile): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([new Uint8Array(file.body)], { type: file.mime });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function RewriteSingleScreen({
  title,
  tabId,
  readOnly = false,
  storage,
  gateway: injectedGateway,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  readOnly?: boolean;
  storage?: SessionStorageLike;
  gateway?: RewriteSingleGateway;
  onDispatch?: (action: ShellAction) => void;
}) {
  const gateway = useMemo(() => {
    if (injectedGateway) return injectedGateway;
    const browserStorage: SessionStorageLike =
      storage ??
      (typeof window !== 'undefined'
        ? window.sessionStorage
        : {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
          });
    return httpRewriteSingleGateway(browserStorage);
  }, [injectedGateway, storage]);

  const [query, setQuery] = useState<RewriteRecordListQuery>({
    page: 1,
    pageSize: 20,
  });
  const [keywordInput, setKeywordInput] = useState('');
  const [items, setItems] = useState<RewriteRecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unitPoints, setUnitPoints] = useState<number>(REWRITE_DEFAULT_UNIT_POINTS);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [formOptions, setFormOptions] = useState<RewriteFormOptions | null>(null);
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [urlWarning, setUrlWarning] = useState<string | null>(null);

  const loadList = useCallback(
    async (nextQuery: RewriteRecordListQuery) => {
      setLoading(true);
      try {
        const res = await gateway.list(nextQuery);
        setItems(res.items);
        setTotal(res.total);
        setUnitPoints(res.unitPoints);
      } catch (err) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '加载复刻记录失败',
        });
      } finally {
        setLoading(false);
      }
    },
    [gateway],
  );

  const loadOptions = useCallback(async () => {
    try {
      const opts = await gateway.loadFormOptions();
      setFormOptions(opts);
      if (opts.unitPoints > 0) {
        setUnitPoints(opts.unitPoints);
      }
      return opts;
    } catch {
      return null;
    }
  }, [gateway]);

  useEffect(() => {
    void loadList(query);
  }, [loadList, query]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  // Poll every 5s if any single record is RUNNING/PENDING
  useEffect(() => {
    const hasActive = items.some((r) => r.status === 'RUNNING' || r.status === 'PENDING');
    if (!hasActive) return undefined;
    const timer = setInterval(() => {
      void loadList(query);
    }, 5_000);
    return () => clearInterval(timer);
  }, [items, loadList, query]);

  const openCreateModal = useCallback(
    async (seed?: Partial<CreateDraft>) => {
      const opts = formOptions ?? (await loadOptions());
      const initial = buildInitialDraft(opts, seed);
      setModalError(null);
      setUrlWarning(null);
      setModalState({
        initial,
        draft: initial,
        minimized: false,
        maximized: false,
      });
    },
    [formOptions, loadOptions],
  );

  const handleCheckUrlOnBlur = useCallback(
    async (rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
        setUrlWarning(null);
        return;
      }
      try {
        const res = await gateway.checkUrl(trimmed);
        setUrlWarning(res.duplicateRecent ? res.warning : null);
      } catch {
        setUrlWarning(null);
      }
    },
    [gateway],
  );

  const updateDraft = useCallback((patch: Partial<CreateDraft>) => {
    setModalState((prev) => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : null));
  }, []);

  const handleSubmitRewrite = useCallback(async () => {
    if (!modalState) return;
    const d = modalState.draft;
    setModalError(null);

    if (!d.pastedText) {
      if (!d.url.trim()) {
        setModalError('请输入公开文章链接（http/https）');
        return;
      }
      if (!/^https?:\/\//i.test(d.url.trim())) {
        setModalError('仅支持 http:// 或 https:// 开头的公开文章链接');
        return;
      }
    } else {
      const chars = countSourceNonWhitespaceChars(d.pastedContent);
      if (chars < REWRITE_MIN_SOURCE_CHARS) {
        setModalError(
          `粘贴原文有效正文不足 ${REWRITE_MIN_SOURCE_CHARS} 字（当前 ${chars} 字），请补充完整正文`,
        );
        return;
      }
    }

    if (!d.mediaCategoryId) {
      setModalError('请选择文章配图的企业图库分类');
      return;
    }
    if (!d.templateId) {
      setModalError('请选择爆文改写指令');
      return;
    }

    setSubmitting(true);
    try {
      const result = await gateway.createSingle({
        pastedText: d.pastedText,
        url: d.url.trim(),
        pastedTitle: d.pastedTitle.trim(),
        pastedContent: d.pastedContent,
        mediaCategoryId: d.mediaCategoryId,
        imageCount: d.imageCount,
        templateId: d.templateId,
        categoryId: d.categoryId || null,
        autoCategoryName: d.categoryId ? '' : d.autoCategoryName.trim(),
        resultStatus: d.resultStatus,
        brand: d.brand.trim(),
      });

      setModalState(null);
      setBanner({
        type: result.duplicateRecentWarning || result.record.highSimilarity ? 'warning' : 'success',
        text: [
          `复刻完成：《${result.record.newTitle ?? '未命名'}》已生成至分类「${result.record.categoryName ?? '默认分类'}」（消耗 ${result.settledPoints} 点数，不占用 AI 写作数量配额）。`,
          result.record.highSimilarity
            ? '注意：5-gram 片段相似度偏高，已标记黄牌提醒，建议在文章列表中人工审校后再发布。'
            : '',
          result.duplicateRecentWarning ?? '',
        ]
          .filter(Boolean)
          .join(' '),
      });

      await Promise.all([loadList({ ...query, page: 1 }), loadOptions()]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '复刻失败，请稍后重试';
      setModalError(msg);
      // Reload list in background because failed attempt may also be recorded with 0 charge
      void loadList(query);
    } finally {
      setSubmitting(false);
    }
  }, [gateway, loadList, loadOptions, modalState, query]);

  const handleBulkStatus = useCallback(
    async (status: 'NORMAL' | 'DISABLED') => {
      if (selectedIds.length === 0) return;
      try {
        const res = await gateway.bulkStatus({ ids: selectedIds, status });
        setBanner({
          type: 'success',
          text: `已将 ${res.affected} 篇关联文章状态设为「${ARTICLE_STATUS_LABEL[status]}」`,
        });
        setSelectedIds([]);
        await loadList(query);
      } catch (err) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '批量更新状态失败',
        });
      }
    },
    [gateway, loadList, query, selectedIds],
  );

  const handleDeleteIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      Modal.confirm({
        title: `确认删除选中的 ${ids.length} 条复刻记录？`,
        content: '删除复刻记录不会删除已落库的文章正文。',
        okText: '确认删除',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            const res = await gateway.bulkDelete(ids);
            setBanner({ type: 'success', text: `已删除 ${res.affected} 条复刻记录` });
            setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
            await loadList(query);
          } catch (err) {
            setBanner({
              type: 'error',
              text: err instanceof Error ? err.message : '删除失败',
            });
          }
        },
      });
    },
    [gateway, loadList, query],
  );

  const handleExport = useCallback(
    async (format: CrudExportFormat) => {
      try {
        const file = await gateway.downloadTable(query, format);
        triggerBrowserDownload(file);
      } catch (err) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '导出失败',
        });
      }
    },
    [gateway, query],
  );

  const openArticlesForCategory = useCallback(
    (categoryId: string | null) => {
      if (!onDispatch) return;
      const href = categoryId
        ? `/writing/articles?categoryId=${encodeURIComponent(categoryId)}`
        : '/writing/articles';
      onDispatch({
        type: 'open',
        href,
        sourceId: tabId,
      });
    },
    [onDispatch, tabId],
  );

  const pastedCharCount = useMemo(
    () => (modalState ? countSourceNonWhitespaceChars(modalState.draft.pastedContent) : 0),
    [modalState],
  );

  const mediaCategoriesWithImages = useMemo(
    () => (formOptions?.mediaCategories ?? []).filter((c) => c.assetCount > 0),
    [formOptions],
  );

  return (
    <section aria-label={title}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            提取公开长文核心事实并重组原创结构，自动剥离原图与外链水印，仅混排企业自有图库配图（
            {unitPoints} 点数/篇，失败自动退点，不计 AI 写作数量）。
          </Typography.Text>
        </div>

        <Space wrap>
          <Button onClick={() => void loadList(query)} loading={loading}>
            刷新
          </Button>
          {!readOnly ? (
            <>
              <Button
                type="primary"
                aria-label="新建单篇复刻"
                onClick={() => void openCreateModal()}
              >
                新建单篇复刻
              </Button>
              <Button
                disabled={selectedIds.length === 0}
                onClick={() => void handleBulkStatus('NORMAL')}
              >
                设为正常
              </Button>
              <Button
                disabled={selectedIds.length === 0}
                onClick={() => void handleBulkStatus('DISABLED')}
              >
                设为停用
              </Button>
              <Button
                danger
                disabled={selectedIds.length === 0}
                onClick={() => handleDeleteIds(selectedIds)}
              >
                删除
              </Button>
            </>
          ) : null}
          <Button onClick={() => void handleExport('csv')}>导出 CSV</Button>
          <Button onClick={() => void handleExport('xlsx')}>导出 XLSX</Button>
        </Space>
      </div>

      {banner ? (
        <Alert
          style={{ marginBottom: 12 }}
          type={banner.type}
          showIcon
          closable
          onClose={() => setBanner(null)}
          message={banner.text}
        />
      ) : null}

      {/* Filter Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          marginBottom: 12,
          padding: '10px 12px',
          background: '#fafafa',
          borderRadius: 8,
          border: '1px solid #f0f0f0',
        }}
      >
        <Input
          aria-label="搜索复刻记录"
          placeholder="搜索源链接 / 源标题 / 复刻新标题"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onPressEnter={() =>
            setQuery((prev) => ({ ...prev, page: 1, keyword: keywordInput.trim() || undefined }))
          }
          style={{ width: 240 }}
          allowClear
        />

        <select
          aria-label="按文章分类筛选"
          style={COMPACT_SELECT_STYLE}
          value={query.categoryId ?? ''}
          onChange={(e) =>
            setQuery((prev) => ({
              ...prev,
              page: 1,
              categoryId: e.target.value || undefined,
            }))
          }
        >
          <option value="">全部文章分类</option>
          {(formOptions?.categories ?? []).map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>

        <select
          aria-label="按复刻状态筛选"
          style={COMPACT_SELECT_STYLE}
          value={query.status ?? ''}
          onChange={(e) =>
            setQuery((prev) => ({
              ...prev,
              page: 1,
              status: (e.target.value as ItemStatusName) || undefined,
            }))
          }
        >
          <option value="">全部复刻状态</option>
          <option value="SUCCESS">已完成</option>
          <option value="FAILED">失败（已退点）</option>
          <option value="RUNNING">执行中</option>
        </select>

        <select
          aria-label="按文章状态筛选"
          style={COMPACT_SELECT_STYLE}
          value={query.articleStatus ?? ''}
          onChange={(e) =>
            setQuery((prev) => ({
              ...prev,
              page: 1,
              articleStatus: (e.target.value as ArticleStatusName) || undefined,
            }))
          }
        >
          <option value="">全部文章状态</option>
          <option value="PENDING">待审核</option>
          <option value="NORMAL">正常</option>
          <option value="DISABLED">已停用</option>
        </select>

        <Button
          type="primary"
          ghost
          onClick={() =>
            setQuery((prev) => ({ ...prev, page: 1, keyword: keywordInput.trim() || undefined }))
          }
        >
          查询
        </Button>
        <Button
          onClick={() => {
            setKeywordInput('');
            setQuery({ page: 1, pageSize: query.pageSize });
          }}
        >
          重置筛选
        </Button>
      </div>

      <Table<RewriteRecordItem>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={items}
        locale={{ emptyText: CRUD_EMPTY_TEXT }}
        rowSelection={
          readOnly
            ? undefined
            : {
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys.map(String)),
              }
        }
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: CRUD_PAGE_SIZES.map(String),
          showTotal: (t) => `共 ${t} 条记录`,
          onChange: (nextPage, nextSize) =>
            setQuery((prev) => ({ ...prev, page: nextPage, pageSize: nextSize })),
        }}
        columns={[
          {
            title: '文章分类',
            dataIndex: 'categoryName',
            width: 170,
            render: (_val: unknown, row) =>
              row.categoryName ? (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  onClick={() => openArticlesForCategory(row.categoryId)}
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
            width: 260,
            render: (_val: unknown, row) => (
              <div style={{ display: 'grid', gap: 2 }}>
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
                      style={{ maxWidth: 175, fontSize: 12 }}
                    >
                      {row.url}
                    </Typography.Link>
                  )}
                </div>
                {row.sourceTitle ? (
                  <Typography.Text
                    type="secondary"
                    ellipsis={{ tooltip: row.sourceTitle }}
                    style={{ fontSize: 12, maxWidth: 240 }}
                  >
                    源标题：{row.sourceTitle}
                  </Typography.Text>
                ) : null}
              </div>
            ),
          },
          {
            title: '复刻新标题',
            dataIndex: 'newTitle',
            render: (_val: unknown, row) => (
              <div style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Typography.Text strong={Boolean(row.newTitle)}>
                    {row.newTitle || '—'}
                  </Typography.Text>
                  {row.highSimilarity ? (
                    <Tag color="warning" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                      重合度偏高{' '}
                      {row.similarity !== null ? `${(row.similarity * 100).toFixed(0)}%` : ''}
                    </Tag>
                  ) : null}
                </div>
                {row.error ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    原因：{row.error}
                  </Typography.Text>
                ) : null}
              </div>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 175,
            render: (_val: unknown, row) => (
              <Space size={4} wrap>
                <Tag
                  color={itemStatusTagColor(row.status)}
                  style={{ margin: 0, whiteSpace: 'nowrap' }}
                >
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
            width: 155,
            render: (_val: unknown, row) => formatTime(row.rewrittenAt ?? row.createdAt),
          },
          {
            title: '操作',
            key: 'actions',
            width: 185,
            render: (_val: unknown, row) => (
              <Space size={8} wrap>
                {row.articleId ? (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0 }}
                    onClick={() => openArticlesForCategory(row.categoryId)}
                  >
                    查看文章
                  </Button>
                ) : null}
                {!readOnly && row.status === 'FAILED' ? (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0 }}
                    onClick={() =>
                      void openCreateModal({
                        pastedText: true,
                        url: row.url.startsWith('paste://') ? '' : row.url,
                        pastedTitle: row.sourceTitle ?? '',
                        mediaCategoryId: row.mediaCategoryId,
                        templateId: row.templateId,
                        categoryId: row.categoryId ?? '',
                      })
                    }
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
                    onClick={() => handleDeleteIds([row.id])}
                  >
                    删除
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      {/* Create Single Rewrite Modal */}
      <CrudModal
        open={Boolean(modalState)}
        title="单篇爆文复刻"
        minimized={modalState?.minimized ?? false}
        maximized={modalState?.maximized ?? false}
        confirmLoading={submitting}
        error={modalError}
        onMinimize={() => setModalState((prev) => (prev ? { ...prev, minimized: true } : null))}
        onRestore={() => setModalState((prev) => (prev ? { ...prev, minimized: false } : null))}
        onMaximize={() =>
          setModalState((prev) => (prev ? { ...prev, maximized: !prev.maximized } : null))
        }
        onClose={() => {
          if (!submitting) setModalState(null);
        }}
        onReset={() => setModalState((prev) => (prev ? { ...prev, draft: prev.initial } : null))}
        ok={
          <Button
            type="primary"
            loading={submitting}
            disabled={mediaCategoriesWithImages.length === 0}
            aria-label={`复刻文章（${unitPoints}点数/篇）`}
            onClick={() => void handleSubmitRewrite()}
          >
            {`复刻文章（${unitPoints}点数/篇）`}
          </Button>
        }
      >
        {modalState ? (
          <div style={{ display: 'grid', gap: 14 }}>
            {/* Source URL vs Pasted Text Switch */}
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  {modalState.draft.pastedText ? '粘贴源文内容（兜底模式） *' : '公开文章链接 *'}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    粘贴原文（源站反爬时开启）
                  </Typography.Text>
                  <Switch
                    size="small"
                    aria-label="粘贴原文开关"
                    checked={modalState.draft.pastedText}
                    onChange={(checked) => {
                      setModalError(null);
                      updateDraft({ pastedText: checked });
                    }}
                  />
                </span>
              </div>

              {!modalState.draft.pastedText ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <Input
                    aria-label="文章链接"
                    placeholder="请输入微信公众号、知乎专栏或公开资讯文章链接（https://...）"
                    value={modalState.draft.url}
                    onChange={(e) => updateDraft({ url: e.target.value })}
                    onBlur={(e) => void handleCheckUrlOnBlur(e.target.value)}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    仅支持公开可访问的网页长文（有效正文不少于 {REWRITE_MIN_SOURCE_CHARS}{' '}
                    字）；内网/私有地址自动拦截。
                  </Typography.Text>
                  {urlWarning ? <Alert type="warning" showIcon message={urlWarning} /> : null}
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Input
                      aria-label="粘贴源文标题"
                      placeholder="源文章标题（选填，留空自动提取首行）"
                      value={modalState.draft.pastedTitle}
                      onChange={(e) => updateDraft({ pastedTitle: e.target.value })}
                    />
                    <Input
                      aria-label="参考源链接"
                      placeholder="参考源链接 https://...（选填，便于溯源查重）"
                      value={modalState.draft.url}
                      onChange={(e) => updateDraft({ url: e.target.value })}
                    />
                  </div>
                  <Input.TextArea
                    aria-label="粘贴原文正文"
                    rows={5}
                    placeholder={`请粘贴需要参考重写的完整源文正文（至少 ${REWRITE_MIN_SOURCE_CHARS} 字，系统将自动剥离残留标签与外链配图）`}
                    value={modalState.draft.pastedContent}
                    onChange={(e) => updateDraft({ pastedContent: e.target.value })}
                  />
                  <Typography.Text
                    type={pastedCharCount >= REWRITE_MIN_SOURCE_CHARS ? 'secondary' : 'danger'}
                    style={{ fontSize: 12 }}
                  >
                    当前有效字数：{pastedCharCount} 字（最低要求 {REWRITE_MIN_SOURCE_CHARS} 字，超过
                    8000 字自动截断保留核心前段）
                  </Typography.Text>
                </div>
              )}

              {modalError && !modalState.draft.pastedText ? (
                <div style={{ marginTop: 6 }}>
                  <Button
                    size="small"
                    type="dashed"
                    onClick={() => {
                      setModalError(null);
                      updateDraft({ pastedText: true });
                    }}
                  >
                    切换为「粘贴原文」手工补充正文
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Gallery Category + 1..3 Image Slider */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>文章配图（企业图库） *</div>
                {mediaCategoriesWithImages.length > 0 ? (
                  <select
                    aria-label="文章配图图库"
                    style={NATIVE_SELECT_STYLE}
                    value={modalState.draft.mediaCategoryId}
                    onChange={(e) => updateDraft({ mediaCategoryId: e.target.value })}
                  >
                    <option value="">不选择</option>
                    {mediaCategoriesWithImages.map((mc) => (
                      <option key={mc.id} value={mc.id}>
                        {mc.name}（{mc.assetCount} 张可用）
                      </option>
                    ))}
                  </select>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message={
                      <span>
                        当前暂无含图片的企业图库分类。
                        {onDispatch ? (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => {
                              setModalState(null);
                              onDispatch({
                                type: 'open',
                                href: '/material/gallery',
                                sourceId: tabId,
                              });
                            }}
                          >
                            前往上传配图
                          </Button>
                        ) : null}
                      </span>
                    }
                  />
                )}
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontWeight: 500,
                    marginBottom: 4,
                  }}
                >
                  <span>正文中混排配图张数</span>
                  <Typography.Text strong>{modalState.draft.imageCount} 张</Typography.Text>
                </div>
                <Slider
                  min={REWRITE_IMAGE_MIN}
                  max={REWRITE_IMAGE_MAX}
                  step={1}
                  marks={{ 1: '1张', 2: '2张', 3: '3张' }}
                  value={modalState.draft.imageCount}
                  onChange={(val) => updateDraft({ imageCount: val })}
                />
              </div>
            </div>

            {/* Prompt Template (REWRITE only) + Optional Brand */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  爆文改写指令（仅流量复刻类型） *
                </div>
                <select
                  aria-label="爆文改写指令"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.templateId}
                  onChange={(e) => updateDraft({ templateId: e.target.value })}
                >
                  <option value="">不选择</option>
                  {(formOptions?.rewriteTemplates ?? []).map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.isSystem ? `[系统] ${tpl.name}` : tpl.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>自然融入品牌词（选填）</div>
                <Input
                  aria-label="融入品牌词"
                  placeholder="选填：重组时自然提及，不替换原文推荐品牌"
                  maxLength={40}
                  value={modalState.draft.brand}
                  onChange={(e) => updateDraft({ brand: e.target.value })}
                />
              </div>
            </div>

            {/* Category Selection / Editable Timestamped Auto Category + Result Status */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>归属文章分类</div>
                <select
                  aria-label="归属文章分类"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.categoryId}
                  onChange={(e) => updateDraft({ categoryId: e.target.value })}
                >
                  <option value="">自动新建带时间戳分类（可改名）</option>
                  {(formOptions?.categories ?? []).map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
                {!modalState.draft.categoryId ? (
                  <div style={{ marginTop: 6 }}>
                    <Input
                      aria-label="新建分类名称"
                      placeholder="自动新建的分类名称（可自由修改）"
                      maxLength={40}
                      value={modalState.draft.autoCategoryName}
                      onChange={(e) => updateDraft({ autoCategoryName: e.target.value })}
                    />
                  </div>
                ) : null}
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>产出结果状态</div>
                <div
                  role="radiogroup"
                  aria-label="产出结果状态"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    minHeight: 32,
                    flexWrap: 'wrap',
                  }}
                >
                  {(['PENDING', 'NORMAL'] as const).map((statusKey) => (
                    <label
                      key={statusKey}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: 'pointer',
                        fontWeight: 400,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <input
                        type="radio"
                        name="rewriteResultStatus"
                        value={statusKey}
                        checked={modalState.draft.resultStatus === statusKey}
                        onChange={() => updateDraft({ resultStatus: statusKey })}
                      />
                      <span>{REWRITE_RESULT_STATUS_LABELS[statusKey]}</span>
                    </label>
                  ))}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  建议默认设为「待审核」，确认标题与措辞后再批量设为「正常」。
                </Typography.Text>
              </div>
            </div>

            <Alert
              type="info"
              showIcon
              message="合规与扣点保障：系统自动剥离源文全部原图、二维码与导流信息，参考事实重新组织结构；抓取拦截或源文不足 200 字将全额退回冻结点数，且复刻文章不占用「AI写作数量」配额。"
            />
          </div>
        ) : null}
      </CrudModal>
    </section>
  );
}
