'use client';

import {
  GEO_ARTICLE_STATUS_LABELS,
  formatShanghaiDateTime,
  sanitizeEntityTitleSegment,
  type GeoArticlePublishFilter,
  type GeoArticleRecord,
} from '@geomix/shared';
import { Button, Input } from 'antd';
import type { JSX } from 'react';
import { SignalEmpty, SignalSkeleton } from '../geo/primitives';
import { StatusBadge } from '../ui';

export type PublishArticleQueueProps = {
  collapsed: boolean;
  hideCollapseToggle?: boolean;
  onToggleCollapse: () => void;
  articles: readonly GeoArticleRecord[];
  articlesLoading: boolean;
  activeArticleId: string | null;
  publishFilter: GeoArticlePublishFilter;
  onPublishFilterChange: (next: GeoArticlePublishFilter) => void;
  keyword: string;
  onKeywordChange: (next: string) => void;
  crawlAlertCount: number;
  onSelectArticle: (article: GeoArticleRecord) => void;
  onNavigateStudio: () => void;
};

const FILTER_OPTIONS: readonly { value: GeoArticlePublishFilter; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'UNPUBLISHED', label: '待发布' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'CRAWL_ALERT', label: '抓取异常' },
];

export function PublishArticleQueue({
  collapsed,
  hideCollapseToggle = false,
  onToggleCollapse,
  articles,
  articlesLoading,
  activeArticleId,
  publishFilter,
  onPublishFilterChange,
  keyword,
  onKeywordChange,
  crawlAlertCount,
  onSelectArticle,
  onNavigateStudio,
}: PublishArticleQueueProps): JSX.Element {
  if (collapsed) {
    return (
      <aside className="gm-studio-pane gm-publish-pane--left" aria-label="成稿发布队列">
        <div className="gm-studio-collapsed-rail">
          <Button
            size="small"
            type="text"
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2.5 3.5H13.5M2.5 8H9.5M2.5 12.5H13.5M11 6L13.5 8L11 10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            aria-label="展开成稿队列"
            title="展开成稿队列"
            aria-expanded={false}
            onClick={onToggleCollapse}
          />
        </div>
      </aside>
    );
  }

  const hasActiveFilters = publishFilter !== 'ALL' || keyword.trim() !== '';

  return (
    <aside
      className="gm-studio-pane gm-publish-pane--left"
      aria-label="成稿发布队列"
      data-testid="publish-left-pane"
    >
      <div className="gm-studio-pane-head">
        <span className="gm-studio-pane-title">成稿发布队列 ({articles.length})</span>
        {!hideCollapseToggle ? (
          <Button size="small" type="text" aria-expanded={true} onClick={onToggleCollapse}>
            收起队列
          </Button>
        ) : null}
      </div>

      <div className="gm-studio-pane-body">
        <div
          className="gm-publish-filter-bar"
          role="tablist"
          aria-label="发布状态筛选"
          data-testid="publish-queue-filters"
        >
          {FILTER_OPTIONS.map((opt) => {
            const active = publishFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`publish-filter-${opt.value}`}
                className={`gm-publish-filter-pill${active ? ' gm-publish-filter-pill--active' : ''}`}
                onClick={() => onPublishFilterChange(opt.value)}
              >
                <span>{opt.label}</span>
                {opt.value === 'CRAWL_ALERT' && crawlAlertCount > 0 ? (
                  <span
                    className="gm-publish-filter-count gm-num"
                    data-testid="publish-filter-crawl-count"
                  >
                    {crawlAlertCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <Input
          size="small"
          allowClear
          placeholder="搜索文章标题或目标问句"
          aria-label="搜索成稿"
          data-testid="publish-queue-search"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
        />

        {articlesLoading && articles.length === 0 ? (
          <SignalSkeleton variant="row" rows={4} />
        ) : articles.length > 0 ? (
          <div className="gm-studio-queue-list" data-testid="publish-articles-list">
            {articles.map((article) => {
              const isActive = activeArticleId === article.id;
              const safeTitle = sanitizeEntityTitleSegment(article.title, '未命名文章');
              const pubCount = article.publishRecordCount ?? 0;
              return (
                <button
                  key={article.id}
                  type="button"
                  data-testid={`publish-article-item-${article.id}`}
                  aria-current={isActive ? 'true' : undefined}
                  className={`gm-publish-article-card${isActive ? ' gm-publish-article-card--active' : ''}`}
                  onClick={() => onSelectArticle(article)}
                >
                  <span className="gm-publish-article-card-title gm-clamp-2">{safeTitle}</span>
                  <div className="gm-publish-article-card-meta">
                    <StatusBadge
                      status={article.status}
                      label={GEO_ARTICLE_STATUS_LABELS[article.status] ?? article.status}
                    />
                    <span className="gm-num gm-publish-article-score">GEO {article.geoScore}</span>
                    {pubCount > 0 ? (
                      <span className="gm-num gm-publish-article-pubcount">已发 {pubCount}</span>
                    ) : null}
                    {article.hasCrawlAlert ? <StatusBadge tone="danger" label="抓取异常" /> : null}
                  </div>
                  <span className="gm-publish-article-card-time">
                    更新于 {formatShanghaiDateTime(article.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : hasActiveFilters ? (
          <SignalEmpty
            title="没有符合筛选条件的成稿"
            description="可切换筛选标签或清空搜索关键词后重试。"
            actionText="重置筛选"
            onAction={() => {
              onPublishFilterChange('ALL');
              onKeywordChange('');
            }}
          />
        ) : (
          <SignalEmpty
            title="当前市场暂无可发布成稿"
            description="先在 GEO 写作台完成选题生成与体检，再来到发布中心多渠道推送。"
            actionText="前往 GEO 写作台"
            onAction={onNavigateStudio}
          />
        )}
      </div>
    </aside>
  );
}
