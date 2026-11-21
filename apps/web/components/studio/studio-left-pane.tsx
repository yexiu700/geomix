'use client';

import {
  GEO_ARTICLE_STATUSES,
  GEO_ARTICLE_STATUS_LABELS,
  GEO_BATCH_MAX,
  GEO_BATCH_MIN,
  GEO_BRIEF_SOURCE_LABELS,
  GEO_RECIPE_LABELS,
  GEO_WRITE_DEFAULT_UNIT_POINTS,
  TASK_STATUS_LABELS,
  formatShanghaiDateTime,
  sanitizeEntityTitleSegment,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefRecord,
} from '@geomix/shared';
import { Button, Checkbox, Input, Progress, Tag } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalPill, SignalSkeleton } from '../geo/primitives';

export type StudioLeftPaneProps = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  briefs: readonly GeoBriefRecord[];
  briefsLoading: boolean;
  activeBriefId: string | null;
  selectedBriefIds: readonly string[];
  onSelectedBriefIdsChange: (next: string[]) => void;
  onSelectBrief: (brief: GeoBriefRecord) => void;
  onStartFreeTopic: () => void;
  onLaunchBatch: () => void;
  batchSubmitting: boolean;
  batchJobs: readonly GeoBatchJobRecord[];
  highlightedBatchJobId: string | null;
  articles: readonly GeoArticleRecord[];
  articlesLoading: boolean;
  activeArticleId: string | null;
  articleStatusFilter: GeoArticleStatus | '';
  onArticleStatusFilterChange: (status: GeoArticleStatus | '') => void;
  articleTagFilter: string;
  onArticleTagFilterChange: (tag: string) => void;
  onSelectArticle: (article: GeoArticleRecord) => void;
  onDeleteArticle: (article: GeoArticleRecord) => Promise<void>;
  readOnly: boolean;
  counterEntrySlot?: ReactNode;
};

export function StudioLeftPane({
  collapsed,
  onToggleCollapse,
  briefs,
  briefsLoading,
  activeBriefId,
  selectedBriefIds,
  onSelectedBriefIdsChange,
  onSelectBrief,
  onStartFreeTopic,
  onLaunchBatch,
  batchSubmitting,
  batchJobs,
  highlightedBatchJobId,
  articles,
  articlesLoading,
  activeArticleId,
  articleStatusFilter,
  onArticleStatusFilterChange,
  articleTagFilter,
  onArticleTagFilterChange,
  onSelectArticle,
  onDeleteArticle,
  readOnly,
  counterEntrySlot,
}: StudioLeftPaneProps): JSX.Element {
  const feedback = useUxFeedback();
  const selectedSet = new Set(selectedBriefIds);
  const openBriefs = briefs.filter((b) => b.status === 'OPEN');

  const toggleBrief = (briefId: string) => {
    if (selectedSet.has(briefId)) {
      onSelectedBriefIdsChange(selectedBriefIds.filter((id) => id !== briefId));
      return;
    }
    if (selectedBriefIds.length >= GEO_BATCH_MAX) return;
    onSelectedBriefIdsChange([...selectedBriefIds, briefId]);
  };

  const handleSelectAllOpen = () => {
    onSelectedBriefIdsChange(openBriefs.slice(0, GEO_BATCH_MAX).map((b) => b.id));
  };

  const handleConfirmDelete = (article: GeoArticleRecord) => {
    if (readOnly) return;
    feedback.confirm({
      title: '确认删除这篇成稿？',
      content: `删除「${sanitizeEntityTitleSegment(article.title, '未命名文章')}」后不可恢复。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      onOk: () => onDeleteArticle(article),
    });
  };

  const visibleBatchJob =
    batchJobs.find((j) => j.id === highlightedBatchJobId) ??
    batchJobs.find((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ??
    null;

  const canBatch =
    !readOnly &&
    !batchSubmitting &&
    selectedBriefIds.length >= GEO_BATCH_MIN &&
    selectedBriefIds.length <= GEO_BATCH_MAX;

  if (collapsed) {
    return (
      <aside className="gm-studio-pane" aria-label="选题与待办队列">
        <div className="gm-studio-collapsed-rail">
          <Button
            size="small"
            type="text"
            aria-label="展开队列"
            aria-expanded={false}
            onClick={onToggleCollapse}
          >
            »
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="gm-studio-pane" aria-label="选题与待办队列" data-testid="studio-left-pane">
      <div className="gm-studio-pane-head">
        <span className="gm-studio-pane-title">选题与成稿队列</span>
        <Button size="small" type="text" aria-expanded={true} onClick={onToggleCollapse}>
          收起队列
        </Button>
      </div>

      <div className="gm-studio-pane-body">
        {/* Quick Entry Strip */}
        <div className="gm-studio-chip-group">
          <Button size="small" onClick={onStartFreeTopic} data-testid="studio-free-topic-btn">
            + 自由选题
          </Button>
          {counterEntrySlot}
        </div>

        {/* Active / Highlighted Batch Job Progress */}
        {visibleBatchJob ? (
          <div className="gm-studio-batch-card" data-testid="studio-batch-progress">
            <div className="gm-studio-section-label">
              <span>批量队列进度</span>
              <SignalPill
                tone={
                  visibleBatchJob.status === 'COMPLETED'
                    ? 'cited'
                    : visibleBatchJob.status === 'FAILED'
                      ? 'danger'
                      : visibleBatchJob.status === 'PARTIAL'
                        ? 'warning'
                        : 'info'
                }
              >
                {TASK_STATUS_LABELS[visibleBatchJob.status]}
              </SignalPill>
            </div>
            <Progress
              size="small"
              percent={
                visibleBatchJob.total > 0
                  ? Math.round(
                      ((visibleBatchJob.doneCount + visibleBatchJob.failCount) /
                        visibleBatchJob.total) *
                        100,
                    )
                  : 0
              }
              status={
                visibleBatchJob.status === 'FAILED'
                  ? 'exception'
                  : visibleBatchJob.status === 'COMPLETED'
                    ? 'success'
                    : 'active'
              }
            />
            <div className="gm-studio-item-meta">
              <span>
                已完成 {visibleBatchJob.doneCount} / {visibleBatchJob.total}
              </span>
              {visibleBatchJob.failCount > 0 ? (
                <span style={{ color: 'var(--gm-danger)' }}>
                  失败 {visibleBatchJob.failCount}（已退点）
                </span>
              ) : null}
              <span>{formatShanghaiDateTime(visibleBatchJob.createdAt)}</span>
            </div>
          </div>
        ) : null}

        {/* Section 1: Pending GeoBriefs (Checkboxes MUST be the first checkboxes in default DOM!) */}
        <div className="gm-studio-section-label">
          <span>待写意见卡 ({openBriefs.length})</span>
          {openBriefs.length > 0 && !readOnly ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <Button size="small" type="link" style={{ padding: 0 }} onClick={handleSelectAllOpen}>
                全选
              </Button>
              {selectedBriefIds.length > 0 ? (
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => onSelectedBriefIdsChange([])}
                >
                  清空
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {briefsLoading && openBriefs.length === 0 ? (
          <SignalSkeleton variant="row" rows={2} />
        ) : openBriefs.length > 0 ? (
          <div className="gm-studio-queue-list">
            {openBriefs.map((brief) => {
              const checked = selectedSet.has(brief.id);
              const isActive = activeBriefId === brief.id;
              const safeTitle = sanitizeEntityTitleSegment(
                brief.suggestedTitle || brief.targetPrompt,
                '待写写作意见',
              );
              return (
                <div
                  key={brief.id}
                  className={`gm-studio-queue-item${isActive ? ' gm-studio-queue-item-active' : ''}`}
                  data-testid={`studio-brief-item-${brief.id}`}
                >
                  <Checkbox
                    aria-label={`选择意见卡-${safeTitle}`}
                    checked={checked}
                    disabled={readOnly || (!checked && selectedBriefIds.length >= GEO_BATCH_MAX)}
                    onChange={() => toggleBrief(brief.id)}
                  />
                  <button
                    type="button"
                    className="gm-studio-queue-btn"
                    onClick={() => onSelectBrief(brief)}
                  >
                    <span className="gm-studio-item-title">{safeTitle}</span>
                    <span className="gm-studio-item-meta">
                      <span>P{brief.priorityScore}</span>
                      <span>{GEO_BRIEF_SOURCE_LABELS[brief.sourceType]}</span>
                    </span>
                  </button>
                </div>
              );
            })}

            <Button
              type="primary"
              size="small"
              block
              data-testid="studio-batch-btn"
              loading={batchSubmitting}
              disabled={!canBatch}
              onClick={onLaunchBatch}
            >
              批量生成（{selectedBriefIds.length} 篇 ·{' '}
              {selectedBriefIds.length * GEO_WRITE_DEFAULT_UNIT_POINTS} 点）
            </Button>
          </div>
        ) : (
          <div className="gm-studio-item-meta">暂无待写意见卡，可直接自由选题生成。</div>
        )}

        {/* Section 2: Historical GeoArticles (always visible, zero legacy columns!) */}
        <div className="gm-studio-section-label" style={{ marginTop: 4 }}>
          <span>历史成稿 ({articles.length})</span>
        </div>

        <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <select
            aria-label="按状态筛选历史成稿"
            className="gm-select"
            style={{ width: 96, minWidth: 0 }}
            value={articleStatusFilter}
            onChange={(e) => onArticleStatusFilterChange(e.target.value as GeoArticleStatus | '')}
          >
            <option value="">全部状态</option>
            {GEO_ARTICLE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {GEO_ARTICLE_STATUS_LABELS[st]}
              </option>
            ))}
          </select>
          <Input
            size="small"
            placeholder="按标签筛选"
            aria-label="按标签筛选历史成稿"
            value={articleTagFilter}
            onChange={(e) => onArticleTagFilterChange(e.target.value)}
            allowClear
          />
        </div>

        {articlesLoading && articles.length === 0 ? (
          <SignalSkeleton variant="row" rows={2} />
        ) : articles.length > 0 ? (
          <div className="gm-studio-queue-list" data-testid="studio-articles-list">
            {articles.map((article) => {
              const isActive = activeArticleId === article.id;
              const safeTitle = sanitizeEntityTitleSegment(article.title, '未命名文章');
              return (
                <div
                  key={article.id}
                  className={`gm-studio-article-item${isActive ? ' gm-studio-article-item-active' : ''}`}
                  data-testid={`studio-article-item-${article.id}`}
                >
                  <div className="gm-studio-article-row">
                    <button
                      type="button"
                      className="gm-studio-queue-btn"
                      onClick={() => onSelectArticle(article)}
                    >
                      <span className="gm-studio-item-title">{safeTitle}</span>
                    </button>
                    {!readOnly ? (
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label={`删除文章-${safeTitle}`}
                        onClick={() => handleConfirmDelete(article)}
                      >
                        删除
                      </Button>
                    ) : null}
                  </div>
                  <div className="gm-studio-item-meta">
                    <Tag style={{ margin: 0 }}>{GEO_ARTICLE_STATUS_LABELS[article.status]}</Tag>
                    <span>{GEO_RECIPE_LABELS[article.recipe]}</span>
                    {article.geoScore > 0 ? <span>GEO {article.geoScore}</span> : null}
                    <span>{formatShanghaiDateTime(article.updatedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <SignalEmpty
            title="暂无历史成稿"
            description="点击上方「立即生成」产出首篇高引用 GEO 成稿。"
          />
        )}
      </div>
    </aside>
  );
}
