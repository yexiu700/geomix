'use client';

import type {
  GeoBriefRecord,
  GeoBriefSource,
  GeoBriefStatus,
  VisibilityOpportunitiesResponse,
} from '@geomix/shared';
import {
  GEO_BRIEF_SOURCES,
  GEO_BRIEF_SOURCE_LABELS,
  GEO_BRIEF_STATUS_LABELS,
  GEO_RECIPE_LABELS,
  formatShanghaiDateTime,
} from '@geomix/shared';
import { Button, Checkbox } from 'antd';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { EmptyState, RowActions, StatusBadge, type StatusTone } from '../ui';

type VisibilityGapRow = VisibilityOpportunitiesResponse['gaps'][number];

export type BriefStatusFilterValue = GeoBriefStatus | 'ACTIVE';

export type BriefListPanelProps = {
  briefs: readonly GeoBriefRecord[];
  total: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  sourceFilter: GeoBriefSource | '';
  onSourceFilterChange: (next: GeoBriefSource | '') => void;
  statusFilter: BriefStatusFilterValue;
  onStatusFilterChange: (next: BriefStatusFilterValue) => void;
  selectedBriefIds: readonly string[];
  onSelectedBriefIdsChange: (next: string[]) => void;
  gaps: readonly VisibilityGapRow[];
  generatingGapPrompt: string | null;
  onGenerateFromGap: (gap: VisibilityGapRow) => void;
  readOnly: boolean;
  completedChecks: number;
  onOpenBrief: (brief: GeoBriefRecord) => void;
  onWriteBrief: (brief: GeoBriefRecord) => void;
  onDismissBrief: (brief: GeoBriefRecord) => Promise<void>;
  onBatchWrite: (briefIds: readonly string[]) => void;
  batchSubmitting?: boolean;
  onSwitchToRuns: () => void;
  onRefresh: () => void;
};

const MAX_BATCH_SELECT = 20;
const MIN_BATCH_SELECT = 2;

function priorityTone(score: number): StatusTone {
  if (score >= 90) return 'danger';
  if (score >= 80) return 'warning';
  if (score >= 70) return 'active';
  return 'neutral';
}

export function BriefListPanel({
  briefs,
  total,
  loading,
  error,
  onRetry,
  sourceFilter,
  onSourceFilterChange,
  statusFilter,
  onStatusFilterChange,
  selectedBriefIds,
  onSelectedBriefIdsChange,
  gaps,
  generatingGapPrompt,
  onGenerateFromGap,
  readOnly,
  completedChecks,
  onOpenBrief,
  onWriteBrief,
  onDismissBrief,
  onBatchWrite,
  batchSubmitting = false,
  onSwitchToRuns,
  onRefresh,
}: BriefListPanelProps): JSX.Element {
  const selectableBriefs = useMemo(() => briefs.filter((item) => item.status === 'OPEN'), [briefs]);

  const selectedSet = useMemo(() => new Set(selectedBriefIds), [selectedBriefIds]);

  const toggleSelect = (briefId: string) => {
    if (selectedSet.has(briefId)) {
      onSelectedBriefIdsChange(selectedBriefIds.filter((id) => id !== briefId));
      return;
    }
    if (selectedBriefIds.length >= MAX_BATCH_SELECT) return;
    onSelectedBriefIdsChange([...selectedBriefIds, briefId]);
  };

  const handleSelectAllVisible = () => {
    const ids = selectableBriefs.slice(0, MAX_BATCH_SELECT).map((b) => b.id);
    onSelectedBriefIdsChange(ids);
  };

  const canBatchWrite =
    !readOnly &&
    selectedBriefIds.length >= MIN_BATCH_SELECT &&
    selectedBriefIds.length <= MAX_BATCH_SELECT;

  return (
    <div className="gm-vis-briefs-panel" data-testid="brief-list-panel">
      {/* Toolbar: filters + batch action */}
      <div className="gm-vis-brief-toolbar">
        <div className="gm-vis-brief-filters">
          <select
            aria-label="按来源筛选写作建议"
            className="gm-select"
            value={sourceFilter}
            onChange={(e) => onSourceFilterChange(e.target.value as GeoBriefSource | '')}
          >
            <option value="">全部信号来源</option>
            {GEO_BRIEF_SOURCES.map((source) => (
              <option key={source} value={source}>
                {GEO_BRIEF_SOURCE_LABELS[source]}
              </option>
            ))}
          </select>

          <select
            aria-label="按状态筛选写作建议"
            className="gm-select"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value as BriefStatusFilterValue)}
          >
            <option value="OPEN">待处理</option>
            <option value="ACTIVE">全部有效（不含已忽略）</option>
            <option value="WRITING">写作中</option>
            <option value="DONE">已完成</option>
            <option value="DISMISSED">已忽略</option>
          </select>

          <Button size="small" onClick={onRefresh} disabled={loading}>
            刷新建议
          </Button>
          <span className="gm-vis-brief-count">共 {total} 条</span>
        </div>

        <div className="gm-vis-brief-batch-bar">
          {selectableBriefs.length > 0 && !readOnly ? (
            <>
              <Button size="small" onClick={handleSelectAllVisible}>
                全选待写（最多 {MAX_BATCH_SELECT}）
              </Button>
              {selectedBriefIds.length > 0 ? (
                <Button size="small" onClick={() => onSelectedBriefIdsChange([])}>
                  清空已选
                </Button>
              ) : null}
            </>
          ) : null}

          <Button
            size="small"
            data-testid="briefs-batch-btn"
            loading={batchSubmitting}
            disabled={!canBatchWrite || batchSubmitting}
            onClick={() => onBatchWrite(selectedBriefIds)}
          >
            批量写作（{selectedBriefIds.length} 篇
            {selectedBriefIds.length >= MIN_BATCH_SELECT
              ? ` · ${selectedBriefIds.length * 10} 点`
              : ''}
            ）
          </Button>
        </div>
      </div>

      {/* Main Content */}
      {loading && briefs.length === 0 ? (
        <SignalSkeleton variant="row" rows={3} />
      ) : error && briefs.length === 0 ? (
        <SignalError message={error} onRetry={onRetry} />
      ) : briefs.length > 0 ? (
        <div className="gm-vis-brief-list">
          {briefs.map((brief) => {
            const checked = selectedSet.has(brief.id);
            const selectable = brief.status === 'OPEN' && !readOnly;
            const priorityRank =
              brief.priorityScore >= 90
                ? '1'
                : brief.priorityScore >= 80
                  ? '2'
                  : brief.priorityScore >= 70
                    ? '3'
                    : '4';
            return (
              <div
                key={brief.id}
                data-testid={`brief-card-${brief.id}`}
                className={`gm-ui-row gm-vis-brief-card${checked ? ' gm-vis-brief-card-selected' : ''}`}
              >
                <div className="gm-vis-brief-check">
                  <Checkbox
                    aria-label={`选择写作建议-${brief.suggestedTitle}`}
                    checked={checked}
                    disabled={
                      !selectable || (!checked && selectedBriefIds.length >= MAX_BATCH_SELECT)
                    }
                    onChange={() => toggleSelect(brief.id)}
                  />
                </div>

                <div className="gm-vis-brief-main">
                  <div className="gm-vis-brief-head">
                    <StatusBadge
                      tone={priorityTone(brief.priorityScore)}
                      label={`P${priorityRank} · ${brief.priorityScore}`}
                    />
                    <StatusBadge
                      status={brief.status}
                      label={GEO_BRIEF_STATUS_LABELS[brief.status]}
                    />
                    <span className="gm-vis-context-chip">
                      {GEO_BRIEF_SOURCE_LABELS[brief.sourceType]}
                    </span>
                    <span className="gm-vis-context-chip gm-vis-context-chip--muted">
                      {GEO_RECIPE_LABELS[brief.recommendedRecipe]}
                    </span>
                    <span className="gm-vis-brief-time">
                      {formatShanghaiDateTime(brief.createdAt)}
                    </span>
                  </div>

                  <div className="gm-vis-brief-title">{brief.suggestedTitle}</div>
                  <div className="gm-vis-brief-summary">{brief.diagnosisSummary}</div>

                  {brief.recommendedChannels.length > 0 ? (
                    <div className="gm-vis-brief-meta">
                      <span className="gm-vis-brief-meta-label">建议投放：</span>
                      {brief.recommendedChannels.slice(0, 3).map((ch, idx) => (
                        <span
                          key={`${ch.channel}-${idx}`}
                          className="gm-vis-context-chip gm-vis-context-chip--muted"
                        >
                          {ch.channel}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="gm-vis-brief-actions">
                  <Button size="small" onClick={() => onOpenBrief(brief)}>
                    查看详细意见
                  </Button>
                  <RowActions
                    primary={{
                      key: 'write',
                      label: '一键去写（10 点）',
                      disabled: readOnly,
                      onClick: () => onWriteBrief(brief),
                    }}
                    secondary={
                      !readOnly && brief.status !== 'DISMISSED'
                        ? [
                            {
                              key: 'dismiss',
                              label: '忽略',
                              danger: true,
                              confirm: {
                                title: '确认忽略这条写作建议？',
                                content:
                                  '忽略后该意见将移出默认待处理列表，可随时切换状态筛选找回。',
                                okText: '确认忽略',
                                danger: true,
                              },
                              onClick: () => onDismissBrief(brief),
                            },
                          ]
                        : undefined
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : gaps.length > 0 && statusFilter === 'OPEN' && !sourceFilter ? (
        <div className="gm-vis-gap-list">
          {gaps.slice(0, 6).map((gap) => (
            <div key={gap.promptText} className="gm-vis-gap-row">
              <div className="gm-vis-gap-main">
                <div className="gm-vis-gap-prompt">{gap.promptText}</div>
                <div className="gm-vis-gap-meta">
                  <StatusBadge tone="danger" label="待生成意见" />
                  <span className="gm-vis-gap-sub">
                    未提及 {gap.observationCount} 次 · 竞品：
                    {gap.competitors.slice(0, 3).join(' / ') || '无'}
                  </span>
                </div>
              </div>
              <Button
                size="small"
                disabled={readOnly || generatingGapPrompt !== null}
                loading={generatingGapPrompt === gap.promptText}
                onClick={() => onGenerateFromGap(gap)}
              >
                提写作意见（0 点）
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          size="compact"
          title={
            completedChecks === 0 ? '完成首次监测后自动生成优先写作建议' : '当前筛选下暂无写作建议'
          }
          description={
            completedChecks === 0
              ? '发起新一轮监测后，系统会自动识别竞品霸榜缺口、负面风险与低顺位问题，免费输出 Top 优先写作意见。'
              : '可切换筛选条件，或在「监测任务与问答透视」「信源阵地与竞品洞察」中对任意观测点免费提取写作意见。'
          }
          action={
            completedChecks === 0 && !readOnly ? (
              <Button size="small" onClick={onSwitchToRuns}>
                立即发起监测
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
