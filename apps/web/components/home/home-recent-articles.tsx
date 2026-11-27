'use client';

import {
  GEO_ARTICLE_STATUS_LABELS,
  formatShanghaiDateTime,
  type ActionHomeResponse,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { formatRetestDeltaSummary } from '../../lib/home';
import { GEO_RECIPE_SHORT } from '../../lib/short-labels';
import { EmptyState, RowActions, Section, StatusBadge, type StatusTone } from '../ui';

export type HomeRecentArticleItem = ActionHomeResponse['recentArticles'][number];

export type HomeRecentArticlesProps = {
  recentArticles: readonly HomeRecentArticleItem[];
  retestingRecordId: string | null;
  pollingRecordIds: ReadonlySet<string>;
  readOnly: boolean;
  onOpenArticle: (articleId: string) => void;
  onPublishArticle?: (articleId: string, tab?: 'distribute' | 'tracking') => void;
  onTriggerRetest: (record: GeoPublishRecordDto) => void;
  onOpenStudio: () => void;
};

function mapDeltaTone(tone: 'cited' | 'info' | 'warning' | 'danger' | 'neutral'): StatusTone {
  if (tone === 'cited') return 'success';
  if (tone === 'info') return 'active';
  if (tone === 'warning') return 'warning';
  if (tone === 'danger') return 'danger';
  return 'neutral';
}

function getScoreTierClass(score: number): string {
  if (score >= 85) return 'gm-home-score--high';
  if (score >= 60) return 'gm-home-score--mid';
  return 'gm-home-score--low';
}

export function HomeRecentArticles({
  recentArticles,
  retestingRecordId,
  pollingRecordIds,
  readOnly,
  onOpenArticle,
  onPublishArticle,
  onTriggerRetest,
  onOpenStudio,
}: HomeRecentArticlesProps): JSX.Element {
  const capped = recentArticles.slice(0, 5);

  return (
    <Section
      variant="plain"
      aria-label="近期成稿"
      data-testid="home-recent-articles"
      title="近期成稿"
      description="展示最近 5 篇 GEO 成稿的引用就绪度评分、发布状态与复测变化。"
      actions={
        <Button size="small" type="link" autoInsertSpace={false} onClick={onOpenStudio}>
          去写作
        </Button>
      }
    >
      {capped.length === 0 ? (
        <EmptyState
          size="compact"
          title="暂无成稿"
          description="可从建议开写"
          action={
            readOnly ? undefined : (
              <Button size="small" type="link" autoInsertSpace={false} onClick={onOpenStudio}>
                去写作
              </Button>
            )
          }
        />
      ) : (
        <div className="gm-home-article-list">
          {capped.map((article) => {
            const pub = article.publishRecord ?? null;
            const isPolling = Boolean(pub && pollingRecordIds.has(pub.id));
            const isSubmitting = Boolean(pub && retestingRecordId === pub.id);
            const delta = pub
              ? formatRetestDeltaSummary(pub.beforeMetrics, pub.afterMetrics)
              : null;
            const needsRetest = Boolean(pub && !pub.afterMetrics);

            return (
              <div
                key={article.id}
                className={`gm-ui-row gm-home-article-row${needsRetest ? ' gm-home-article-row--actionable' : ''}`}
                data-testid={`home-article-row-${article.id}`}
              >
                <div className="gm-home-article-main">
                  <button
                    type="button"
                    className="gm-home-article-title-btn"
                    onClick={() => onOpenArticle(article.id)}
                    title={article.title}
                  >
                    {article.title}
                  </button>
                  <div className="gm-home-article-sub">
                    <span className="gm-home-article-recipe">
                      {GEO_RECIPE_SHORT[article.recipe] ?? article.recipe}
                    </span>
                    <span className="gm-home-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className={`gm-num gm-home-score ${getScoreTierClass(article.geoScore)}`}>
                      GEO {article.geoScore}
                    </span>
                    <span className="gm-home-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="gm-home-article-time">
                      更新于 {formatShanghaiDateTime(article.updatedAt)}
                    </span>
                  </div>
                </div>

                <div className="gm-home-article-meta-actions">
                  <StatusBadge
                    status={article.status}
                    label={GEO_ARTICLE_STATUS_LABELS[article.status] ?? article.status}
                  />

                  {pub ? (
                    isPolling ? (
                      <StatusBadge tone="active" label="复测进行中…" />
                    ) : delta ? (
                      <span data-testid={`home-retest-badge-${article.id}`}>
                        <StatusBadge tone={mapDeltaTone(delta.tone)} label={delta.compactBadge} />
                      </span>
                    ) : null
                  ) : null}

                  {pub ? (
                    <RowActions
                      primary={{
                        key: 'retest',
                        label: isSubmitting || isPolling ? '复测中…' : '发起复测',
                        testId: `home-article-retest-btn-${article.id}`,
                        loading: isSubmitting || isPolling,
                        disabled: readOnly || Boolean(retestingRecordId),
                        onClick: () => onTriggerRetest(pub),
                      }}
                      menuItems={[
                        {
                          key: 'publish',
                          label: '发布追踪',
                          onClick: () =>
                            onPublishArticle
                              ? onPublishArticle(article.id, 'tracking')
                              : onOpenArticle(article.id),
                        },
                        {
                          key: 'open',
                          label: '去编辑',
                          onClick: () => onOpenArticle(article.id),
                        },
                      ]}
                    />
                  ) : (
                    <RowActions
                      secondary={[
                        {
                          key: 'edit',
                          label: '继续编辑',
                          onClick: () => onOpenArticle(article.id),
                        },
                      ]}
                      menuItems={[
                        {
                          key: 'publish',
                          label: '去发布',
                          onClick: () =>
                            onPublishArticle
                              ? onPublishArticle(article.id, 'distribute')
                              : onOpenArticle(article.id),
                        },
                      ]}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
