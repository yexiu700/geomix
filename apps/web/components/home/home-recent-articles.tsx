'use client';

import {
  GEO_ARTICLE_STATUS_LABELS,
  GEO_RECIPE_LABELS,
  formatShanghaiDateTime,
  type ActionHomeResponse,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import { Button, Tag } from 'antd';
import type { JSX } from 'react';
import { formatRetestDeltaSummary } from '../../lib/home';
import { SignalEmpty, SignalPill } from '../geo/primitives';

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
    <section
      className="gm-panel gm-home-block"
      aria-label="近期成稿与复测追踪"
      data-testid="home-recent-articles"
    >
      <div className="gm-home-block-head">
        <div className="gm-home-block-heading">
          <h2 className="gm-home-block-title">近期成稿与复测追踪</h2>
          <p className="gm-home-block-desc">
            展示最近 5 篇 GEO 成稿的引用就绪度评分、发布状态与 Before → After 复测变化。
          </p>
        </div>

        <Button size="small" type="link" onClick={onOpenStudio}>
          进入 GEO 写作台
        </Button>
      </div>

      {capped.length === 0 ? (
        <SignalEmpty
          title="尚未生成 GEO 成稿"
          description="从上方优先写作建议一键开写，或进入 GEO 写作台开启实时流式精写。"
          actionText={readOnly ? undefined : '直接写 GEO 文章'}
          onAction={readOnly ? undefined : onOpenStudio}
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

            return (
              <div
                key={article.id}
                className="gm-home-article-row"
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
                    <Tag color="geekblue" style={{ margin: 0 }}>
                      {GEO_RECIPE_LABELS[article.recipe] ?? article.recipe}
                    </Tag>
                    <span className="gm-home-article-time">
                      更新于 {formatShanghaiDateTime(article.updatedAt)}
                    </span>
                  </div>
                </div>

                <div className="gm-home-article-meta-actions">
                  <Tag
                    color={
                      article.geoScore >= 85 ? 'green' : article.geoScore >= 60 ? 'gold' : 'red'
                    }
                    style={{ margin: 0 }}
                  >
                    GEO {article.geoScore}
                  </Tag>

                  <Tag
                    color={
                      article.status === 'PUBLISHED'
                        ? 'green'
                        : article.status === 'READY'
                          ? 'blue'
                          : 'default'
                    }
                    style={{ margin: 0 }}
                  >
                    {GEO_ARTICLE_STATUS_LABELS[article.status] ?? article.status}
                  </Tag>

                  {pub ? (
                    isPolling ? (
                      <SignalPill tone="info">复测进行中…</SignalPill>
                    ) : delta ? (
                      <span data-testid={`home-retest-badge-${article.id}`}>
                        <SignalPill tone={delta.tone}>{delta.compactBadge}</SignalPill>
                      </span>
                    ) : null
                  ) : null}

                  {pub ? (
                    <Button
                      size="small"
                      type="primary"
                      data-testid={`home-article-retest-btn-${article.id}`}
                      loading={isSubmitting || isPolling}
                      disabled={readOnly || Boolean(retestingRecordId)}
                      onClick={() => onTriggerRetest(pub)}
                    >
                      一键复测
                    </Button>
                  ) : (
                    <Button size="small" onClick={() => onOpenArticle(article.id)}>
                      去登记发布
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
