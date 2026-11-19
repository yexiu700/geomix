'use client';

import {
  resolveScopedOverviewKeywords,
  type KeywordRecord,
  type VisibilityEngineKey,
  type VisibilityFanOutItem,
  type VisibilityOpportunitiesResponse,
  type VisibilityOpportunityGapItem,
  type VisibilityProfileRecord,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Space, Table, Tooltip, message } from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM, formatPct } from '../../lib/design-tokens';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import type { ShellAction } from '../../lib/tab-stack';
import type { VisibilityGateway } from '../../lib/visibility';
import { TableClampText } from '../crud/table-clamp-text';
import { EngineChipList, SignalEmpty, SignalPill } from '../geo/primitives';
import { buildOverviewRangeQuery, type OverviewFilterState } from './visibility-overview-helpers';

const EMPTY_OPPORTUNITIES: VisibilityOpportunitiesResponse = { gaps: [], fanOutQueries: [] };

type OpportunityFeedback = { type: 'success' | 'error'; text: string };

export type OverviewOpportunitiesState = ReturnType<typeof useOverviewOpportunities>;

/**
 * 优化机会页签数据闭环：竞品缺口 / 搜索拆解词、目标主词（按档案隔离，#213）、勾选与导入。
 *
 * - 机会列表请求在 effect 清理时作废，筛选快速切换时旧响应不会覆盖新结果。
 * - 切换档案时清空勾选与反馈，并重新选择该档案范围内的默认主词。
 */
export function useOverviewOpportunities({
  client,
  appliedFilter,
  featureEnabled,
  profiles,
  profilesLoaded,
  readOnly,
  onDispatch,
}: {
  client: VisibilityGateway;
  appliedFilter: OverviewFilterState;
  featureEnabled: boolean;
  profiles: VisibilityProfileRecord[];
  profilesLoaded: boolean;
  readOnly: boolean;
  onDispatch?: (action: ShellAction) => void;
}) {
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<VisibilityOpportunitiesResponse>(EMPTY_OPPORTUNITIES);
  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [keywordsLoaded, setKeywordsLoaded] = useState<boolean>(false);
  const [selectedKeywordId, setSelectedKeywordId] = useState<string>('');
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [importing, setImporting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<OpportunityFeedback | null>(null);

  const prevAppliedProfileIdRef = useRef<string>(appliedFilter.profileId);
  const initializedKeywordScopeRef = useRef<string | null>(null);

  // Load tenant keywords for target keyword selection
  useEffect(() => {
    if (!featureEnabled) return;
    let cancelled = false;
    void client
      .listKeywords()
      .then((list) => {
        if (cancelled) return;
        setKeywords(list);
        setKeywordsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setKeywordsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, featureEnabled]);

  // Isolate target keywords by the currently active monitoring profile (#213)
  const { scopedKeywords, defaultKeywordId } = useMemo(
    () =>
      resolveScopedOverviewKeywords({
        keywords,
        profiles,
        profilesLoaded,
        profileId: appliedFilter.profileId,
      }),
    [appliedFilter.profileId, keywords, profiles, profilesLoaded],
  );

  useEffect(() => {
    const profileChanged = prevAppliedProfileIdRef.current !== appliedFilter.profileId;
    if (profileChanged) {
      prevAppliedProfileIdRef.current = appliedFilter.profileId;
      initializedKeywordScopeRef.current = null;
      setSelectedTitles([]);
      setFeedback(null);
    }

    if (!profilesLoaded || !keywordsLoaded) {
      setSelectedKeywordId('');
      return;
    }

    const scopeKey = appliedFilter.profileId || '__all__';
    if (profileChanged || initializedKeywordScopeRef.current !== scopeKey) {
      initializedKeywordScopeRef.current = scopeKey;
      setSelectedKeywordId(defaultKeywordId);
      return;
    }

    setSelectedKeywordId((curr) =>
      curr && !scopedKeywords.some((kw) => kw.id === curr) ? defaultKeywordId : curr,
    );
  }, [appliedFilter.profileId, defaultKeywordId, keywordsLoaded, profilesLoaded, scopedKeywords]);

  // Load opportunities (competitor gaps + fan-out queries) when appliedFilter changes
  useEffect(() => {
    if (!featureEnabled || !client.listOpportunities) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    void client
      .listOpportunities({ ...buildOverviewRangeQuery(appliedFilter), limit: 50 })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setData(EMPTY_OPPORTUNITIES);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appliedFilter, client, featureEnabled]);

  /** 由父容器在页签回到前台时调用，刷新主词下拉（保留仍有效的已选主词）。 */
  const applyKeywordRefresh = useCallback((list: KeywordRecord[]) => {
    setKeywords(list);
    setSelectedKeywordId((curr) =>
      curr && list.some((k) => k.id === curr) ? curr : (list[0]?.id ?? ''),
    );
  }, []);

  const toggleTitle = useCallback((titleText: string, checked: boolean) => {
    setSelectedTitles((curr) => {
      if (checked) {
        return curr.includes(titleText) ? curr : [...curr, titleText];
      }
      return curr.filter((item) => item !== titleText);
    });
  }, []);

  const importSelected = useCallback(async () => {
    if (readOnly || !selectedKeywordId || selectedTitles.length === 0) return;
    if (!client.importOpportunityQuestions) return;
    setImporting(true);
    setFeedback(null);
    try {
      const result = await client.importOpportunityQuestions({
        keywordId: selectedKeywordId,
        titles: selectedTitles,
      });
      const feedbackText = `已导入「写作标题」：新增 ${result.insertedCount} 条，跳过重复 ${result.skippedCount} 条`;
      setFeedback({ type: 'success', text: feedbackText });
      void message.success(feedbackText);
      setSelectedTitles([]);
    } catch (err: unknown) {
      const errText = err instanceof Error ? err.message : '导入写作标题失败';
      setFeedback({ type: 'error', text: errText });
      void message.error(errText);
    } finally {
      setImporting(false);
    }
  }, [client, readOnly, selectedKeywordId, selectedTitles]);

  const goToWritingTasks = useCallback(() => {
    const targetHref = selectedKeywordId
      ? `/writing/tasks?keywordId=${encodeURIComponent(selectedKeywordId)}`
      : '/writing/tasks';
    onDispatch?.({ type: 'open', href: targetHref });
  }, [onDispatch, selectedKeywordId]);

  return {
    data,
    loading,
    keywords,
    scopedKeywords,
    selectedKeywordId,
    selectedTitles,
    importing,
    feedback,
    tabCount: data.gaps.length + data.fanOutQueries.length,
    setSelectedKeywordId,
    clearSelection: () => setSelectedTitles([]),
    clearFeedback: () => setFeedback(null),
    toggleTitle,
    importSelected,
    goToWritingTasks,
    applyKeywordRefresh,
  };
}

const NOWRAP_HEADER = () => ({ style: { whiteSpace: 'nowrap' as const } });

function CompetitorPills({ comps }: { comps: string[] }) {
  return (
    <Space size={[4, 4]} wrap>
      {comps.slice(0, 3).map((c) => (
        <SignalPill key={c} tone="competitor">
          {c}
        </SignalPill>
      ))}
      {comps.length > 3 ? (
        <Tooltip title={comps.slice(3).join('、')}>
          <span>
            <SignalPill tone="neutral">
              <span className="gm-num">+{comps.length - 3}</span>
            </SignalPill>
          </span>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function CoverageCell({ pct }: { pct?: number }) {
  if (typeof pct !== 'number') {
    return <span style={{ color: GM.fg.f3 }}>—</span>;
  }
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
      {formatPct(pct)}
      <span className="gm-cov-mini-bar" style={{ '--p': `${clamped}%` } as CSSProperties} />
    </span>
  );
}

/** 优化机会 & 搜索拆解词页签：目标主词 / 勾选导入操作栏 + 缺口问题表 + 拆解词表。 */
export function VisibilityOverviewOpportunitiesPanel({
  opportunities,
  profileId,
  profilesLoaded,
  readOnly,
}: {
  opportunities: OverviewOpportunitiesState;
  profileId: string;
  profilesLoaded: boolean;
  readOnly: boolean;
}) {
  const {
    data,
    loading,
    keywords,
    scopedKeywords,
    selectedKeywordId,
    selectedTitles,
    importing,
    feedback,
  } = opportunities;
  const targetKeywordSelectRef = useRef<HTMLSelectElement | null>(null);

  // Keep native <select> DOM value in sync across async keyword / profile loading
  useEffect(() => {
    const el = targetKeywordSelectRef.current;
    if (el && el.value !== selectedKeywordId) {
      el.value = selectedKeywordId;
    }
  }, [profilesLoaded, scopedKeywords, selectedKeywordId]);

  const renderSelectCell = (text: string, labelPrefix: string) => (
    <Checkbox
      aria-label={`${labelPrefix}-${text}`}
      checked={selectedTitles.includes(text)}
      disabled={readOnly}
      onChange={(e) => opportunities.toggleTitle(text, e.target.checked)}
    />
  );

  return (
    <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      {/* Feedback Banner */}
      {feedback ? (
        <Alert
          type={feedback.type}
          message={feedback.text}
          showIcon
          closable
          onClose={opportunities.clearFeedback}
        />
      ) : null}

      {/* Action Bar */}
      <div className="gm-filterbar" style={{ justifyContent: 'space-between', marginBottom: 0 }}>
        <Space wrap size={8}>
          <span style={{ fontSize: 13, color: GM.fg.f2 }}>目标主词：</span>
          <select
            ref={targetKeywordSelectRef}
            aria-label="目标主词"
            style={{
              ...COMPACT_SELECT_STYLE,
              minWidth: 180,
              maxWidth: 280,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            value={selectedKeywordId}
            disabled={!profilesLoaded || scopedKeywords.length === 0 || readOnly}
            onChange={(e) => opportunities.setSelectedKeywordId(e.target.value)}
          >
            {!profilesLoaded ? (
              <option value="">正在匹配档案主词…</option>
            ) : scopedKeywords.length === 0 ? (
              <option value="">
                {profileId && keywords.length > 0 ? '当前档案暂无关联主词' : '暂无可用主词'}
              </option>
            ) : (
              <>
                {!profileId || selectedKeywordId === '' ? (
                  <option value="">请选择目标主词</option>
                ) : null}
                {scopedKeywords.map((kw) => (
                  <option key={kw.id} value={kw.id}>
                    {kw.main}
                  </option>
                ))}
              </>
            )}
          </select>
          <SignalPill tone={selectedTitles.length > 0 ? 'info' : 'neutral'}>
            <span className="gm-num">已选 {selectedTitles.length} 条</span>
          </SignalPill>
          {selectedTitles.length > 0 ? (
            <Button size="small" onClick={opportunities.clearSelection} disabled={importing}>
              清空勾选
            </Button>
          ) : null}
        </Space>

        <Space wrap size={8}>
          <Button
            type="primary"
            loading={importing}
            disabled={readOnly || selectedTitles.length === 0 || !selectedKeywordId || importing}
            onClick={() => void opportunities.importSelected()}
          >
            一键加入写作标题
          </Button>
          <Button onClick={opportunities.goToWritingTasks}>去创建写作任务</Button>
        </Space>
      </div>

      {/* Section 1: Competitor Gaps */}
      <div style={{ minWidth: 0 }}>
        <div className="gm-panel-title" style={{ marginBottom: 8 }}>
          竞品命中但本品牌未提及（内容缺口问题）
        </div>
        <div className="gm-table-scroll">
          <Table<VisibilityOpportunityGapItem>
            rowKey="promptText"
            size="small"
            loading={loading}
            dataSource={data.gaps}
            pagination={false}
            scroll={{ x: 920 }}
            locale={{
              emptyText: <SignalEmpty title="当前筛选条件下暂无竞品命中但本品牌未提及的缺口问题" />,
            }}
            columns={[
              {
                key: 'select',
                title: '选择',
                width: 56,
                onHeaderCell: NOWRAP_HEADER,
                render: (_val, row) => renderSelectCell(row.promptText, '勾选缺口问题'),
              },
              {
                key: 'promptText',
                dataIndex: 'promptText',
                title: '缺口问题（Prompt）',
                width: 340,
                onHeaderCell: NOWRAP_HEADER,
                render: (text: string) => (
                  <TableClampText
                    text={text}
                    lines={2}
                    strong
                    maxWidth={320}
                    style={{ color: GM.fg.f1 }}
                  />
                ),
              },
              {
                key: 'competitors',
                dataIndex: 'competitors',
                title: '命中竞品',
                width: 220,
                onHeaderCell: NOWRAP_HEADER,
                render: (comps: string[]) => <CompetitorPills comps={comps} />,
              },
              {
                key: 'engines',
                dataIndex: 'engines',
                title: '出现引擎',
                width: 200,
                onHeaderCell: NOWRAP_HEADER,
                render: (engines: VisibilityEngineKey[]) => (
                  <EngineChipList engines={engines} max={3} />
                ),
              },
              {
                key: 'observationCount',
                dataIndex: 'observationCount',
                title: '出现次数',
                width: 96,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (count: number) => <span className="gm-num">{count} 次</span>,
              },
            ]}
          />
        </div>
      </div>

      {/* Section 2: Query Fan-Out */}
      <div style={{ minWidth: 0 }}>
        <div className="gm-panel-title" style={{ marginBottom: 8 }}>
          高频搜索拆解词（Query Fan-Out）
        </div>
        <div className="gm-table-scroll">
          <Table<VisibilityFanOutItem>
            rowKey="query"
            size="small"
            loading={loading}
            dataSource={data.fanOutQueries}
            pagination={false}
            scroll={{ x: 1040 }}
            locale={{
              emptyText: (
                <SignalEmpty title="当前筛选条件下暂无 AI 引擎搜索拆解词（Query Fan-Out）记录" />
              ),
            }}
            columns={[
              {
                key: 'select',
                title: '选择',
                width: 56,
                onHeaderCell: NOWRAP_HEADER,
                render: (_val, row) => renderSelectCell(row.query, '勾选拆解词'),
              },
              {
                key: 'query',
                dataIndex: 'query',
                title: '搜索拆解词（Fan-Out Query）',
                width: 240,
                onHeaderCell: NOWRAP_HEADER,
                render: (q: string) => (
                  <TableClampText
                    text={q}
                    lines={2}
                    strong
                    maxWidth={224}
                    style={{ color: GM.fg.f1 }}
                  />
                ),
              },
              {
                key: 'frequency',
                dataIndex: 'frequency',
                title: '出现频次',
                width: 96,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (freq: number) => (
                  <SignalPill tone="info">
                    <span className="gm-num">{freq} 次</span>
                  </SignalPill>
                ),
              },
              {
                key: 'brandMentionedPct',
                dataIndex: 'brandMentionedPct',
                title: '品牌覆盖率',
                width: 136,
                align: 'right',
                onHeaderCell: NOWRAP_HEADER,
                render: (pct?: number) => <CoverageCell pct={pct} />,
              },
              {
                key: 'engines',
                dataIndex: 'engines',
                title: '引擎',
                width: 180,
                onHeaderCell: NOWRAP_HEADER,
                render: (engines: VisibilityEngineKey[]) => (
                  <EngineChipList engines={engines} max={3} />
                ),
              },
              {
                key: 'sourcePrompts',
                dataIndex: 'sourcePrompts',
                title: '来源问题预览',
                width: 340,
                onHeaderCell: NOWRAP_HEADER,
                render: (prompts: string[]) =>
                  prompts.length > 0 ? (
                    <TableClampText
                      text={prompts.join('；')}
                      lines={2}
                      maxWidth={320}
                      style={{ color: GM.fg.f3, fontSize: 12 }}
                    />
                  ) : (
                    <span style={{ color: GM.fg.f3 }}>—</span>
                  ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
