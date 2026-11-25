'use client';

import {
  GEO_ARTICLE_STATUS_LABELS,
  GEO_RECIPE_LABELS,
  formatShanghaiDateTime,
  type ActionHomeResponse,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { formatRetestDeltaSummary } from '../../lib/home';
import { EmptyState, RowActions, Section, StatusBadge, type StatusTone } from '../ui';

export type HomeRecentArticleItem = ActionHomeResponse['recentArticles'][number];

export type HomeRecentArticlesProps = {
  recentArticles: readonly HomeRecentArticleItem[];
  retestingRecordId: string | null;
  pollingRecordIds: ReadonlySet<string>;
  readOnly: boolean;
  onOpenArticle: (articleId: string) => void;
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
  onTriggerRetest,
  onOpenStudio,
}: HomeRecentArticlesProps): JSX.Element {
  const capped = recentArticles.slice(0, 5);

  return (
    <Section
      variant="plain"
      aria-label="近期成稿与复测追踪"
      data-testid="home-recent-articles"
      title="近期成稿与复测追踪"
      description="展示最近 5 篇 GEO 成稿的引用就绪度评分、发布状态与 Before → After 复测变化。"
      actions={
        <Button size="small" type="link" onClick={onOpenStudio}>
          进入 GEO 写作台
        </Button>
      }
    >
      {capped.length === 0 ? (
        <EmptyState
          size="compact"
          title="尚未生成 GEO 成稿"
          description="从上方优先写作建议一键开写，或进入 GEO 写作台开启实时流式精写。"
          action={
            readOnly ? undefined : (
              <Button size="small" type="link" onClick={onOpenStudio}>
                去写作台自由选题 →
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
                      {GEO_RECIPE_LABELS[article.recipe] ?? article.recipe}
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
                          key: 'open',
                          label: '在写作台打开',
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
                          label: '去登记发布',
                          onClick: () => onOpenArticle(article.id),
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
