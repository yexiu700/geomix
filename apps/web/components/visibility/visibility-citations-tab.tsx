'use client';

import type {
  CitationSourceKind,
  VisibilityCitationListResponse,
  VisibilityFanOutItem,
  VisibilityObservationRecord,
  VisibilityOpportunitiesResponse,
  VisibilityRunRecord,
} from '@geomix/shared';
import { CITATION_SOURCE_KINDS, sanitizeEntityTitleSegment } from '@geomix/shared';
import { Button, Checkbox, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { JSX, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { formatPct, truncateMiddle } from '../../lib/design-tokens';
import { isSafeHttpUrl } from '../../lib/visibility';
import { CitationTrace } from '../geo/citation-trace';
import {
  EngineChipList,
  SignalError,
  SignalSkeleton,
  SourceKindChip,
  TruncText,
} from '../geo/primitives';
import { EmptyState, Explain, Section } from '../ui';

export type RankedCitationRow = {
  key: string;
  url: string;
  title: string | null;
  domain: string;
  sourceKind: CitationSourceKind;
  count: number;
  questionCount: number;
};

export type VisibilityCitationsTabProps = {
  citations: VisibilityCitationListResponse | null;
  citationsLoading: boolean;
  citationsError: string | null;
  sourceFilter?: CitationSourceKind;
  onSourceFilterChange: (kind: CitationSourceKind | undefined) => void;
  onRetryCitations: () => void;
  // Trace topology
  runs: readonly VisibilityRunRecord[];
  traceRunId: string | null;
  onTraceRunChange: (runId: string) => void;
  traceObservations: readonly VisibilityObservationRecord[];
  traceLoading: boolean;
  onInspectObservationInRunsTab: (observationId: string) => void;
  // Fan-Out leaderboard
  opportunities: VisibilityOpportunitiesResponse | null;
  opportunitiesLoading: boolean;
  opportunitiesError: string | null;
  onRetryOpportunities: () => void;
  selectedFanOuts: readonly string[];
  onSelectedFanOutsChange: (next: string[]) => void;
  /** Optional M3 slot for per-citation counter button (data-testid="citation-counter-btn"). */
  renderCitationAction?: (row: RankedCitationRow) => ReactNode;
  /** Optional M3 slot for multi-selected Fan-Out cluster button (data-testid="fanout-cluster-btn"). */
  renderFanOutBatchAction?: (selectedQueries: readonly string[]) => ReactNode;
};

export function VisibilityCitationsTab({
  citations,
  citationsLoading,
  citationsError,
  sourceFilter,
  onSourceFilterChange,
  onRetryCitations,
  runs,
  traceRunId,
  onTraceRunChange,
  traceObservations,
  traceLoading,
  onInspectObservationInRunsTab,
  opportunities,
  opportunitiesLoading,
  opportunitiesError,
  onRetryOpportunities,
  selectedFanOuts,
  onSelectedFanOutsChange,
  renderCitationAction,
  renderFanOutBatchAction,
}: VisibilityCitationsTabProps): JSX.Element {
  const [fanOutExpanded, setFanOutExpanded] = useState(false);
  const isFanOutOpen = fanOutExpanded || selectedFanOuts.length > 0;
  const breakdown = citations?.sourceBreakdown;
  const totalAllSources = useMemo(() => {
    if (!breakdown) return citations?.totalCitations ?? 0;
    return CITATION_SOURCE_KINDS.reduce((sum, k) => sum + (breakdown[k] ?? 0), 0);
  }, [breakdown, citations?.totalCitations]);

  const rankedUrlRows: RankedCitationRow[] = useMemo(() => {
    const rows: RankedCitationRow[] = [];
    for (const item of citations?.items ?? []) {
      if (item.topUrls.length > 0) {
        for (const u of item.topUrls) {
          rows.push({
            key: `${item.domain}::${u.url}`,
            url: u.url,
            title: u.title,
            domain: item.domain,
            sourceKind: item.sourceKind,
            count: u.count,
            questionCount: item.questionCount,
          });
        }
      } else {
        rows.push({
          key: `domain::${item.domain}`,
          url: `https://${item.domain}`,
          title: item.domain,
          domain: item.domain,
          sourceKind: item.sourceKind,
          count: item.citationCount,
          questionCount: item.questionCount,
        });
      }
    }
    return rows.sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
  }, [citations?.items]);

  const maxUrlCount = useMemo(
    () => rankedUrlRows.reduce((max, r) => Math.max(max, r.count), 1),
    [rankedUrlRows],
  );

  const fanOutItems = useMemo(() => {
    const seen = new Set<string>();
    const deduped: VisibilityFanOutItem[] = [];
    for (const item of opportunities?.fanOutQueries ?? []) {
      const key = item.query.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }, [opportunities?.fanOutQueries]);

  const urlColumns: ColumnsType<RankedCitationRow> = useMemo(
    () => [
      {
        title: '信源页面',
        key: 'url',
        ellipsis: true,
        render: (_v, row) => {
          const safe = isSafeHttpUrl(row.url);
          const displayUrl = truncateMiddle(row.url, 48);
          return (
            <div className="gm-vis-cite-cell">
              <div className="gm-clamp-1 gm-vis-cite-title">{row.title || row.domain}</div>
              {safe ? (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gm-mono gm-vis-cite-link"
                >
                  {displayUrl}
                </a>
              ) : (
                <span className="gm-mono gm-vis-cite-link-muted">{displayUrl}</span>
              )}
            </div>
          );
        },
      },
      {
        title: '类型',
        dataIndex: 'sourceKind',
        key: 'sourceKind',
        width: 112,
        render: (kind: CitationSourceKind) => <SourceKindChip kind={kind} />,
      },
      {
        title: '引用数',
        dataIndex: 'count',
        key: 'count',
        width: 100,
        render: (count: number) => (
          <div className="gm-count-bar-cell">
            <span className="gm-num">{count}</span>
            <div className="gm-vis-mini-bar">
              <div
                className="gm-vis-mini-bar-fill"
                style={{ width: `${Math.max(8, Math.round((count / maxUrlCount) * 100))}%` }}
              />
            </div>
          </div>
        ),
      },
      {
        title: '问题数',
        dataIndex: 'questionCount',
        key: 'questionCount',
        width: 96,
        render: (qCount: number) => <span className="gm-num">{qCount}</span>,
      },
      {
        title: '操作',
        key: 'actions',
        width: 192,
        render: (_v, row) => (
          <div className="gm-vis-cite-actions">
            {renderCitationAction && row.sourceKind !== 'OWNED' ? renderCitationAction(row) : null}
            {isSafeHttpUrl(row.url) ? (
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                className="gm-vis-ext-link"
              >
                打开原页
              </a>
            ) : (
              <span className="gm-vis-cite-link-muted">—</span>
            )}
          </div>
        ),
      },
    ],
    [maxUrlCount, renderCitationAction],
  );

  const toggleFanOut = useCallback(
    (query: string) => {
      if (selectedFanOuts.includes(query)) {
        onSelectedFanOutsChange(selectedFanOuts.filter((q) => q !== query));
      } else {
        onSelectedFanOutsChange([...selectedFanOuts, query]);
      }
    },
    [onSelectedFanOutsChange, selectedFanOuts],
  );

  const fanOutColumns: ColumnsType<VisibilityFanOutItem> = useMemo(
    () => [
      {
        title: '',
        key: 'select',
        width: 40,
        render: (_v, item) => (
          <Checkbox
            aria-label={`选择拆解词-${item.query}`}
            checked={selectedFanOuts.includes(item.query)}
            onChange={() => toggleFanOut(item.query)}
          />
        ),
      },
      {
        title: '拆解词',
        dataIndex: 'query',
        key: 'query',
        render: (query: string) => <TruncText text={query} lines={2} />,
      },
      {
        title: '频次',
        dataIndex: 'frequency',
        key: 'frequency',
        width: 60,
        render: (freq: number) => <span className="gm-num">{freq}</span>,
      },
      {
        title: '提及率',
        dataIndex: 'brandMentionedPct',
        key: 'brandMentionedPct',
        width: 112,
        render: (pct: number | undefined) => {
          const safePct = typeof pct === 'number' && Number.isFinite(pct) ? pct : 0;
          return (
            <div className="gm-vis-cov-cell">
              <span className="gm-num">{formatPct(safePct)}</span>
              <div className="gm-cov-mini-bar">
                <div
                  className="gm-vis-mini-bar-fill"
                  style={{ width: `${Math.max(0, Math.min(100, safePct))}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        title: '引擎',
        dataIndex: 'engines',
        key: 'engines',
        width: 126,
        render: (engines) => <EngineChipList engines={engines} max={2} />,
      },
      {
        title: '来源问题',
        dataIndex: 'sourcePrompts',
        key: 'sourcePrompts',
        width: 162,
        render: (prompts: string[]) => <TruncText text={prompts[0] ?? '—'} lines={1} />,
      },
    ],
    [selectedFanOuts, toggleFanOut],
  );

  return (
    <div className="gm-vis-tab-stack">
      {/* 1. Citation Source Kind Filter Pills + CitationTrace Topology */}
      <Section
        variant="card"
        title="信源拓扑"
        actions={
          <div className="gm-vis-fanout-bar">
            <Explain text="识别自有官网、竞品官网、电商平台、社媒社区与权威评测媒体分布。" />
            {runs.length > 1 ? (
              <select
                aria-label="选择用于拓扑展示的监测任务"
                className="gm-vis-native-select"
                value={traceRunId ?? ''}
                onChange={(e) => onTraceRunChange(e.target.value)}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {sanitizeEntityTitleSegment(r.name, '监测任务')}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        }
      >
        <div className="gm-vis-source-pills" role="group" aria-label="按信源类型筛选">
          <button
            type="button"
            className={`gm-source-pill-btn${!sourceFilter ? ' gm-source-pill-btn-active' : ''}`}
            onClick={() => onSourceFilterChange(undefined)}
          >
            <span>全部</span>
            <span className="gm-num">{totalAllSources}</span>
          </button>
          {CITATION_SOURCE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`citation-filter-${kind}`}
              className={`gm-source-pill-btn${
                sourceFilter === kind ? ' gm-source-pill-btn-active' : ''
              }`}
              onClick={() => onSourceFilterChange(sourceFilter === kind ? undefined : kind)}
            >
              <SourceKindChip kind={kind} />
              <span className="gm-num">{breakdown?.[kind] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="gm-vis-trace-box">
          <CitationTrace
            observations={[...traceObservations]}
            loading={traceLoading}
            onSelectObservation={onInspectObservationInRunsTab}
          />
        </div>
      </Section>

      {/* 2. Ranked High-Citation URLs Table */}
      <Section
        variant="card"
        title="高频页面"
        actions={
          <div className="gm-vis-fanout-bar">
            <Explain text="按被引用频次排序；修改品牌竞品域名后即时生效重分类。" />
            {sourceFilter ? (
              <Button size="small" onClick={() => onSourceFilterChange(undefined)}>
                清除筛选
              </Button>
            ) : null}
          </div>
        }
      >
        {citationsError ? (
          <SignalError message={citationsError} onRetry={onRetryCitations} />
        ) : citationsLoading && !citations ? (
          <SignalSkeleton variant="row" rows={5} />
        ) : rankedUrlRows.length === 0 ? (
          <EmptyState
            size="compact"
            title="暂无页面"
            description="当 AI 引擎返回可核验的参考链接时，将在此展示高频引用页面与阵地归类"
          />
        ) : (
          <div className="gm-vis-table-wrap">
            <Table<RankedCitationRow>
              rowKey="key"
              size="small"
              tableLayout="fixed"
              loading={citationsLoading}
              columns={urlColumns}
              dataSource={rankedUrlRows}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
            />
          </div>
        )}
      </Section>

      {/* 3. Deduplicated Query Fan-Out Leaderboard (Y32 collapsed by default) */}
      <Section
        variant="card"
        title="拆解词"
        actions={
          <div className="gm-vis-fanout-bar">
            {!isFanOutOpen ? (
              <span className="gm-num gm-vis-count-muted">{fanOutItems.length} 词</span>
            ) : null}
            {isFanOutOpen && selectedFanOuts.length > 0 ? (
              <>
                <span className="gm-vis-fanout-count">
                  已选 <strong className="gm-num">{selectedFanOuts.length}</strong> 词
                </span>
                {renderFanOutBatchAction ? renderFanOutBatchAction(selectedFanOuts) : null}
                <Button
                  size="small"
                  autoInsertSpace={false}
                  onClick={() => onSelectedFanOutsChange([])}
                >
                  清空
                </Button>
              </>
            ) : null}
            <Explain text="已按分号/换行自动拆行去重，可多选拆解词用于后续专题内容规划。" />
            <Button
              size="small"
              type="text"
              autoInsertSpace={false}
              data-testid="citations-fanout-toggle"
              aria-expanded={isFanOutOpen}
              onClick={() => setFanOutExpanded((v) => !v)}
            >
              {isFanOutOpen ? '收起' : '展开'}
            </Button>
          </div>
        }
      >
        {isFanOutOpen ? (
          opportunitiesError ? (
            <SignalError message={opportunitiesError} onRetry={onRetryOpportunities} />
          ) : opportunitiesLoading && !opportunities ? (
            <SignalSkeleton variant="row" rows={5} />
          ) : fanOutItems.length === 0 ? (
            <EmptyState
              size="compact"
              title="暂无拆解"
              description="完成支持联网搜索的监测任务后，这里将聚合展示 AI 搜索引擎拆解出的高频子词"
            />
          ) : (
            <div className="gm-vis-table-wrap">
              <Table<VisibilityFanOutItem>
                rowKey="query"
                size="small"
                tableLayout="fixed"
                loading={opportunitiesLoading}
                columns={fanOutColumns}
                dataSource={fanOutItems}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
              />
            </div>
          )
        ) : null}
      </Section>
    </div>
  );
}
