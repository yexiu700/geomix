'use client';

import {
  CITATION_SOURCE_KINDS,
  CITATION_SOURCE_LABELS,
  CRUD_PAGE_SIZES,
  isCitationSourceKind,
  type CitationSourceKind,
  type CrudPageSize,
  type VisibilityCitationListResponse,
  type VisibilityCitationSummaryItem,
} from '@geomix/shared';
import { Button, Table, Tooltip } from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GM, truncateMiddle } from '../../lib/design-tokens';
import type { VisibilityGateway } from '../../lib/visibility';
import { SignalEmpty, SignalError, SignalSkeleton, SourceKindChip } from '../geo/primitives';
import {
  EMPTY_SOURCE_BREAKDOWN,
  buildOverviewRangeQuery,
  normalizePageSize,
  sumSourceBreakdown,
  type OverviewFilterState,
} from './visibility-overview-helpers';

const EMPTY_CITATIONS: VisibilityCitationListResponse = {
  page: 1,
  pageSize: 10,
  total: 0,
  totalCitations: 0,
  sourceBreakdown: EMPTY_SOURCE_BREAKDOWN,
  items: [],
};

export type OverviewCitationsState = ReturnType<typeof useOverviewCitations>;

/**
 * 引用溯源页签数据闭环：信源分类 / 分页 / 加载 / 错误 / 重试。
 *
 * - 页码与 `appliedFilter` 绑定：筛选对象变化后页码自动回到第 1 页（派生，不触发额外请求）。
 * - 竞态保护：每次请求在 effect 清理时作废，旧请求晚返回不会覆盖新结果。
 */
export function useOverviewCitations({
  client,
  appliedFilter,
  featureEnabled,
}: {
  client: VisibilityGateway;
  appliedFilter: OverviewFilterState;
  featureEnabled: boolean;
}) {
  const [sourceKindState, setSourceKindState] = useState<{
    filter: OverviewFilterState;
    kind: CitationSourceKind | 'ALL';
  }>({
    filter: appliedFilter,
    kind: 'ALL',
  });
  const [pageState, setPageState] = useState<{ filter: OverviewFilterState; page: number }>({
    filter: appliedFilter,
    page: 1,
  });
  const [pageSize, setPageSize] = useState<CrudPageSize>(10);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState<number>(0);
  const [data, setData] = useState<VisibilityCitationListResponse>(EMPTY_CITATIONS);

  const sourceKind = sourceKindState.filter === appliedFilter ? sourceKindState.kind : 'ALL';
  const page = pageState.filter === appliedFilter ? pageState.page : 1;

  const setPage = useCallback(
    (nextPage: number) => setPageState({ filter: appliedFilter, page: nextPage }),
    [appliedFilter],
  );

  const setSourceKind = useCallback(
    (kind: CitationSourceKind | 'ALL') => {
      setSourceKindState({ filter: appliedFilter, kind });
      setPage(1);
    },
    [appliedFilter, setPage],
  );

  const changePagination = useCallback(
    (nextPage: number, nextSize: number) => {
      const normalized = normalizePageSize(nextSize);
      setPage(normalized === pageSize ? nextPage : 1);
      setPageSize(normalized);
    },
    [pageSize, setPage],
  );

  const retry = useCallback(() => setRetryTick((t) => t + 1), []);

  useEffect(() => {
    if (!featureEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const kind = sourceKind !== 'ALL' && isCitationSourceKind(sourceKind) ? sourceKind : undefined;

    void client
      .listCitations({
        ...buildOverviewRangeQuery(appliedFilter),
        ...(kind ? { sourceKind: kind } : {}),
        page,
        pageSize,
      })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载引用溯源排行榜失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, client, featureEnabled, page, pageSize, retryTick, sourceKind]);

  const breakdown = data.sourceBreakdown ?? EMPTY_SOURCE_BREAKDOWN;
  const allCitationTotal = sumSourceBreakdown(breakdown);

  return {
    data,
    loading,
    error,
    sourceKind,
    page,
    pageSize,
    breakdown,
    allCitationTotal,
    tabCount: allCitationTotal,
    setSourceKind,
    changePagination,
    retry,
  };
}

function DomainCell({ domain }: { domain: string }) {
  if (domain.length <= 40) {
    return (
      <span className="gm-mono" style={{ color: GM.fg.f1 }}>
        {domain}
      </span>
    );
  }
  return (
    <Tooltip title={domain}>
      <span className="gm-mono" style={{ color: GM.fg.f1 }}>
        {truncateMiddle(domain, 40)}
      </span>
    </Tooltip>
  );
}

function TopUrlsCell({
  row,
  expanded,
  onToggle,
}: {
  row: VisibilityCitationSummaryItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (row.topUrls.length === 0) {
    return <span style={{ color: GM.fg.f3 }}>—</span>;
  }
  const visibleUrls = expanded ? row.topUrls : row.topUrls.slice(0, 2);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {visibleUrls.map((u) => (
        <div
          key={u.url}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
          }}
        >
          <span className="gm-num" style={{ color: GM.fg.f3 }}>
            {u.count} 次
          </span>
          {u.title ? <span style={{ color: GM.fg.f1, fontWeight: 500 }}>{u.title}</span> : null}
          <Tooltip title={u.url}>
            <a
              href={u.url}
              target="_blank"
              rel="noopener noreferrer"
              className="gm-mono"
              style={{ color: GM.status.info }}
            >
              {truncateMiddle(u.url, 56)}
            </a>
          </Tooltip>
        </div>
      ))}
      {row.topUrls.length > 2 ? (
        <div>
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onToggle}>
            {expanded ? '收起页面列表' : `展开全部 ${row.topUrls.length} 个被引用页面`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const NOWRAP_HEADER = () => ({ style: { whiteSpace: 'nowrap' as const } });

/** 引用溯源页签：信源分类胶囊 + 分页域名 / 落地页排行榜。 */
export function VisibilityOverviewCitationsPanel({
  citations,
}: {
  citations: OverviewCitationsState;
}) {
  const { data, loading, error, sourceKind, page, pageSize, breakdown, allCitationTotal } =
    citations;
  const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>({});

  const maxCitationCount = useMemo(
    () => data.items.reduce((acc, item) => Math.max(acc, item.citationCount), 0),
    [data.items],
  );

  return (
    <div style={{ minWidth: 0 }}>
      {/* Source Category Breakdown Pills */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <button
          type="button"
          className={
            sourceKind === 'ALL'
              ? 'gm-source-pill-btn gm-source-pill-btn-active'
              : 'gm-source-pill-btn'
          }
          aria-label="来源分类-全部"
          aria-pressed={sourceKind === 'ALL'}
          onClick={() => citations.setSourceKind('ALL')}
        >
          <span>全部信源</span>
          <span className="gm-num">（{allCitationTotal}）</span>
        </button>
        {CITATION_SOURCE_KINDS.map((kind) => {
          const count = breakdown[kind] ?? 0;
          const active = sourceKind === kind;
          return (
            <button
              key={kind}
              type="button"
              className={
                active ? 'gm-source-pill-btn gm-source-pill-btn-active' : 'gm-source-pill-btn'
              }
              aria-label={`来源分类-${CITATION_SOURCE_LABELS[kind]}`}
              aria-pressed={active}
              onClick={() => citations.setSourceKind(kind)}
            >
              <SourceKindChip kind={kind} />
              <span className="gm-num">（{count}）</span>
            </button>
          );
        })}
      </div>

      {/* Paginated Domain & URL Leaderboard */}
      {error ? (
        <SignalError message={error} onRetry={citations.retry} />
      ) : loading && data.items.length === 0 ? (
        <SignalSkeleton variant="row" rows={5} />
      ) : (
        <div className="gm-table-scroll">
          <Table<VisibilityCitationSummaryItem>
            rowKey="domain"
            size="middle"
            loading={loading}
            dataSource={data.items}
            scroll={{ x: 980 }}
            locale={{
              emptyText: (
                <SignalEmpty title="当前筛选条件下暂无 AI 引用信源记录，完成可见度监测后将自动汇总高权重引用域名与具体落地页" />
              ),
            }}
            pagination={{
              current: page,
              pageSize,
              total: data.total,
              showSizeChanger: true,
              showTotal: (count) => `共 ${count} 条`,
              pageSizeOptions: CRUD_PAGE_SIZES.map(String),
              onChange: citations.changePagination,
            }}
            columns={[
              {
                key: 'rank',
                title: '排名',
                width: 64,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (_val, _row, index) => (
                  <span className="gm-num" style={{ color: GM.fg.f3 }}>
                    #{(page - 1) * pageSize + index + 1}
                  </span>
                ),
              },
              {
                key: 'domain',
                dataIndex: 'domain',
                title: '引用域名',
                width: 220,
                onHeaderCell: NOWRAP_HEADER,
                render: (domain: string) => <DomainCell domain={domain} />,
              },
              {
                key: 'sourceKind',
                dataIndex: 'sourceKind',
                title: '信源分类',
                width: 120,
                onHeaderCell: NOWRAP_HEADER,
                render: (kind: CitationSourceKind) => <SourceKindChip kind={kind} />,
              },
              {
                key: 'citationCount',
                dataIndex: 'citationCount',
                title: '被引用次数',
                width: 120,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (count: number) => {
                  const pct =
                    maxCitationCount > 0 ? Math.round((count / maxCitationCount) * 100) : 0;
                  return (
                    <div
                      className="gm-count-bar-cell gm-num"
                      style={{ '--p': `${pct}%` } as CSSProperties}
                    >
                      {count} 次
                    </div>
                  );
                },
              },
              {
                key: 'questionCount',
                dataIndex: 'questionCount',
                title: '覆盖问题数',
                width: 110,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (count: number) => <span className="gm-num">{count} 题</span>,
              },
              {
                key: 'topUrls',
                title: '热门被引用页面（Top URLs）',
                width: 340,
                onHeaderCell: NOWRAP_HEADER,
                render: (_val, row) => {
                  const expanded = Boolean(expandedDomains[row.domain]);
                  return (
                    <TopUrlsCell
                      row={row}
                      expanded={expanded}
                      onToggle={() =>
                        setExpandedDomains((curr) => ({ ...curr, [row.domain]: !expanded }))
                      }
                    />
                  );
                },
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
