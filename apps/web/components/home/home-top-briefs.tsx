'use client';

import type { ActionHomeResponse } from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { CostChip, EmptyState, Section, StatusBadge, type StatusTone } from '../ui';

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
      return { label: '竞品缺口', tone: 'danger' };
    case 'SENTIMENT_RISK':
      return { label: '情感风险', tone: 'warning' };
    case 'LOW_RANK':
      return { label: '顺位落后', tone: 'active' };
    case 'FANOUT_CLUSTER':
      return { label: '拆解缺口', tone: 'active' };
    case 'CITATION_COUNTER':
      return { label: '引用反制', tone: 'warning' };
    case 'NEAR_MISS_BOOST':
      return { label: '补强机会', tone: 'warning' };
    default:
      return { label: '写作建议', tone: 'neutral' };
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
      aria-label="今日建议"
      data-testid="home-top-briefs"
      title="今日建议"
      description="基于当前品牌与市场最新观测结果，按高意图缺口、情感风险与顺位差距自动排序。"
      actions={
        <Button size="small" type="link" autoInsertSpace={false} onClick={onViewAllBriefs}>
          全部意见
        </Button>
      }
    >
      {capped.length === 0 ? (
        <EmptyState
          size="compact"
          icon={<SparkleIcon />}
          title="暂无建议"
          description="监测后自动生成"
          action={
            readOnly || !handleEmptyAction ? undefined : (
              <Button size="small" type="link" autoInsertSpace={false} onClick={handleEmptyAction}>
                去写作
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
                    autoInsertSpace={false}
                    loading={loadingBriefId === brief.id}
                    disabled={Boolean(loadingBriefId) && loadingBriefId !== brief.id}
                    onClick={() => onOpenBriefDrawer(brief.id)}
                  >
                    查看意见
                  </Button>
                  <Button
                    size="small"
                    autoInsertSpace={false}
                    disabled={readOnly}
                    onClick={() => onWriteBrief(brief.id)}
                  >
                    去写
                  </Button>
                  <CostChip points={10} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
