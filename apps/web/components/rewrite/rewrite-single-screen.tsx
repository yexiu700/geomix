'use client';

import {
  ARTICLE_STATUS_LABEL,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  REWRITE_DEFAULT_UNIT_POINTS,
  type ArticleStatusName,
  type CrudExportFormat,
  type ItemStatusName,
  type RewriteRecordItem,
  type RewriteRecordListQuery,
  type RewriteSingleCreateResponse,
} from '@geomix/shared';
import { Alert, Button, Input, Table, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudToolbar } from '../crud/crud-toolbar';
import { ExportAction } from '../crud/export-action';
import { useUxFeedback } from '../crud/ux-feedback';
import {
  httpRewriteSingleGateway,
  type RewriteFormOptions,
  type RewriteSingleGateway,
} from '../../lib/rewrites';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { UX_TERMS, triggerBlobDownload } from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useTaskPolling } from '../../lib/use-task-polling';
import { buildRewriteSingleColumns } from './rewrite-single-columns';

const RewriteSingleCreateModal = dynamic(() =>
  import('./rewrite-single-create-modal').then((m) => m.RewriteSingleCreateModal),
);
import {
  buildInitialDraft,
  buildRetrySeed,
  formatCreatedBanner,
  getArticlesHref,
  type CreateDraft,
} from './rewrite-single-helpers';

type CreateSession = { id: number; initial: CreateDraft };

export function RewriteSingleScreen({
  title,
  tabId,
  active = true,
  readOnly = false,
  storage,
  gateway: injectedGateway,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  active?: boolean;
  readOnly?: boolean;
  storage?: SessionStorageLike;
  gateway?: RewriteSingleGateway;
  onDispatch?: (action: ShellAction) => void;
}) {
  const feedback = useUxFeedback();
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
  const [createSession, setCreateSession] = useState<CreateSession | null>(null);

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
    } catch (err) {
      setBanner({
        type: 'warning',
        text:
          err instanceof Error
            ? err.message
            : '加载表单选项（文章分类/图库/指令）失败，请点击刷新重试',
      });
      return null;
    }
  }, [gateway]);

  useEffect(() => {
    void loadList(query);
  }, [loadList, query]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useTabFreshness({
    active,
    domains: ['categories', 'gallery', 'prompts', 'points'],
    onRefresh: () => {
      void loadOptions();
    },
  });

  // 存在 RUNNING/PENDING 记录时每 5s 轮询；后台标签页暂停，上一轮未返回时跳过重叠周期
  useTaskPolling({
    enabled: items.some((r) => r.status === 'RUNNING' || r.status === 'PENDING'),
    active,
    onPoll: () => loadList(query),
  });

  const openCreateModal = useCallback(
    async (seed?: Partial<CreateDraft>) => {
      const opts = (await loadOptions()) ?? formOptions;
      const initial = buildInitialDraft(opts, seed);
      setCreateSession((prev) => ({ id: (prev?.id ?? 0) + 1, initial }));
    },
    [formOptions, loadOptions],
  );

  const handleCreated = useCallback(
    async (result: RewriteSingleCreateResponse) => {
      setCreateSession(null);
      setBanner(formatCreatedBanner(result));
      invalidateFreshness('articles', 'categories', 'points');
      await Promise.all([loadList({ ...query, page: 1 }), loadOptions()]);
    },
    [loadList, loadOptions, query],
  );

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
      feedback.confirm({
        title: `确认删除选中的 ${ids.length} 条复刻记录？`,
        content: '删除复刻记录不会删除已生成的文章正文。',
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
    [feedback, gateway, loadList, query],
  );

  const handleExport = useCallback(
    async (format: CrudExportFormat) => {
      try {
        const file = await gateway.downloadTable(query, format);
        triggerBlobDownload(file);
      } catch (err) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '导出失败',
        });
      }
    },
    [gateway, query],
  );

  const navigateTo = useCallback(
    (href: string) => {
      if (!onDispatch) return;
      setCreateSession(null);
      onDispatch({
        type: 'open',
        href,
        sourceId: tabId,
      });
    },
    [onDispatch, tabId],
  );

  const openArticlesForCategory = useCallback(
    (categoryId: string | null) => {
      navigateTo(getArticlesHref(categoryId));
    },
    [navigateTo],
  );

  return (
    <section aria-label={title}>
      <div style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          提取公开长文核心事实并重组原创结构，自动剥离原图与外链水印，仅混排{UX_TERMS.gallery}
          配图（
          {unitPoints} 点数/篇，失败自动退点，不计 AI 写作数量）。
        </Typography.Text>
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
          background: 'var(--gm-bg-surface)',
          borderRadius: 8,
          border: '1px solid var(--gm-line-1)',
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

      <CrudToolbar
        showCreate={!readOnly}
        createLabel="新建单篇复刻"
        onCreate={() => void openCreateModal()}
        refreshLoading={loading}
        onRefresh={() => {
          void loadList(query);
          void loadOptions();
        }}
        showDelete={!readOnly}
        deleteDisabled={selectedIds.length === 0}
        onDelete={() => handleDeleteIds(selectedIds)}
        extraLeft={
          !readOnly ? (
            <>
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
            </>
          ) : null
        }
        right={
          <ExportAction
            empty={!loading && total === 0 && items.length === 0}
            onExport={handleExport}
          />
        }
      />

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
        scroll={{ x: 1100 }}
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
        columns={buildRewriteSingleColumns({
          page: query.page,
          pageSize: query.pageSize,
          readOnly,
          onOpenArticles: openArticlesForCategory,
          onRetryWithPaste: (row) => void openCreateModal(buildRetrySeed(row)),
          onDelete: (id) => handleDeleteIds([id]),
        })}
      />

      {/* Create Single Rewrite Modal */}
      {createSession ? (
        <RewriteSingleCreateModal
          key={createSession.id}
          open
          initial={createSession.initial}
          formOptions={formOptions}
          unitPoints={unitPoints}
          gateway={gateway}
          onClose={() => setCreateSession(null)}
          onCreated={handleCreated}
          onFailed={() => void loadList(query)}
          onRefreshOptions={loadOptions}
          onNavigate={onDispatch ? navigateTo : undefined}
        />
      ) : null}
    </section>
  );
}
