'use client';

import type { ActionHomeResponse } from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { EmptyState, Section, StatusBadge, type StatusTone } from '../ui';

export type HomeTopBriefItem = ActionHomeResponse['topBriefs'][number];

export type HomeTopBriefsProps = {
  topBriefs: readonly HomeTopBriefItem[];
  loadingBriefId: string | null;
  readOnly: boolean;
  onOpenBriefDrawer: (briefId: string) => void;
  onWriteBrief: (briefId: string) => void;
  onViewAllBriefs: () => void;
  onWriteArticle?: () => void;
  onStartMonitor?: () => void;
};

function getSourceBadge(sourceType: string): { label: string; tone: StatusTone } {
  switch (sourceType) {
    case 'AUTO_GAP':
      return { label: '竞品霸榜缺口 · P1', tone: 'danger' };
    case 'SENTIMENT_RISK':
      return { label: '情感风险需辟谣 · P2', tone: 'warning' };
    case 'LOW_RANK':
      return { label: '顺位落后待提权 · P3', tone: 'active' };
    case 'FANOUT_CLUSTER':
      return { label: '高频拆解词缺口', tone: 'active' };
    case 'CITATION_COUNTER':
      return { label: '竞品高引用反制', tone: 'warning' };
    case 'NEAR_MISS_BOOST':
      return { label: '差一步被引用补强', tone: 'warning' };
    default:
      return { label: '定向写作建议', tone: 'neutral' };
  }
}

function SparkleIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="gm-home-sparkle-icon"
    >
      <path
        d="M8 1.5L9.55 6.45L14.5 8L9.55 9.55L8 14.5L6.45 9.55L1.5 8L6.45 6.45L8 1.5Z"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HomeTopBriefs({
  topBriefs,
  loadingBriefId,
  readOnly,
  onOpenBriefDrawer,
  onWriteBrief,
  onViewAllBriefs,
  onWriteArticle,
  onStartMonitor,
}: HomeTopBriefsProps): JSX.Element {
  const capped = topBriefs.slice(0, 3);
  const handleEmptyAction = onWriteArticle ?? onStartMonitor;

  return (
    <Section
      variant="plain"
      aria-label="今日 Top 3 优先写作建议"
      data-testid="home-top-briefs"
      title={
        <span className="gm-home-section-title-inline">
          <span>今日 Top 3 优先写作建议</span>
          <StatusBadge tone="active" label="免费诊断" />
        </span>
      }
      description="基于当前品牌与市场最新观测结果，按高意图缺口、情感风险与顺位差距自动排序。"
      actions={
        <Button size="small" type="link" onClick={onViewAllBriefs}>
          查看全部意见
        </Button>
      }
    >
      {capped.length === 0 ? (
        <EmptyState
          size="compact"
          icon={<SparkleIcon />}
          title="暂无待处理的优先写作建议"
          description="完成新一轮监测后将自动生成高优写作建议；也可以直接进入写作台自由选题开写。"
          action={
            readOnly || !handleEmptyAction ? undefined : (
              <Button size="small" type="link" onClick={handleEmptyAction}>
                去写作台自由选题 →
              </Button>
            )
          }
        />
      ) : (
        <div className="gm-home-brief-grid">
          {capped.map((brief) => {
            const badge = getSourceBadge(brief.sourceType);
            const channels = brief.recommendedChannels.slice(0, 2);

            return (
              <article
                key={brief.id}
                className="gm-home-brief-card"
                data-testid={`home-brief-card-${brief.id}`}
              >
                <div className="gm-home-brief-top">
                  <div className="gm-home-brief-meta">
                    <StatusBadge tone={badge.tone} label={badge.label} />
                    <span className="gm-home-brief-priority gm-num">
                      优先级 {brief.priorityScore}
                    </span>
                  </div>

                  <h3 className="gm-home-brief-title gm-clamp-2" title={brief.suggestedTitle}>
                    {brief.suggestedTitle}
                  </h3>

                  <p className="gm-home-brief-summary gm-clamp-2" title={brief.diagnosisSummary}>
                    {brief.diagnosisSummary}
                  </p>

                  {channels.length > 0 ? (
                    <div className="gm-home-brief-channels">
                      {channels.map((ch) => (
                        <span key={ch.channel} className="gm-home-chip">
                          {ch.channel}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="gm-home-brief-actions">
                  <Button
                    size="small"
                    loading={loadingBriefId === brief.id}
                    disabled={Boolean(loadingBriefId) && loadingBriefId !== brief.id}
                    onClick={() => onOpenBriefDrawer(brief.id)}
                  >
                    查看详细意见
                  </Button>
                  <Button size="small" disabled={readOnly} onClick={() => onWriteBrief(brief.id)}>
                    一键去写（10 点）
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
