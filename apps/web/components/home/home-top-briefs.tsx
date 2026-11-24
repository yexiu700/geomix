'use client';

import type { ActionHomeResponse } from '@geomix/shared';
import { Button, Tag } from 'antd';
import type { JSX } from 'react';
import { SignalEmpty, SignalPill, type SignalTone } from '../geo/primitives';

export type HomeTopBriefItem = ActionHomeResponse['topBriefs'][number];

export type HomeTopBriefsProps = {
  topBriefs: readonly HomeTopBriefItem[];
  loadingBriefId: string | null;
  readOnly: boolean;
  onOpenBriefDrawer: (briefId: string) => void;
  onWriteBrief: (briefId: string) => void;
  onViewAllBriefs: () => void;
  onStartMonitor: () => void;
};

function getSourceBadge(sourceType: string): { label: string; tone: SignalTone } {
  switch (sourceType) {
    case 'AUTO_GAP':
      return { label: '竞品霸榜缺口 · P1', tone: 'danger' };
    case 'SENTIMENT_RISK':
      return { label: '情感风险需辟谣 · P2', tone: 'warning' };
    case 'LOW_RANK':
      return { label: '顺位落后待提权 · P3', tone: 'info' };
    case 'FANOUT_CLUSTER':
      return { label: '高频拆解词缺口', tone: 'info' };
    case 'CITATION_COUNTER':
      return { label: '竞品高引用反制', tone: 'competitor' };
    case 'NEAR_MISS_BOOST':
      return { label: '差一步被引用补强', tone: 'warning' };
    default:
      return { label: '定向写作建议', tone: 'neutral' };
  }
}

export function HomeTopBriefs({
  topBriefs,
  loadingBriefId,
  readOnly,
  onOpenBriefDrawer,
  onWriteBrief,
  onViewAllBriefs,
  onStartMonitor,
}: HomeTopBriefsProps): JSX.Element {
  const capped = topBriefs.slice(0, 3);

  return (
    <section
      className="gm-panel gm-home-block"
      aria-label="今日 Top 3 优先写作建议"
      data-testid="home-top-briefs"
    >
      <div className="gm-home-block-head">
        <div className="gm-home-block-heading">
          <div className="gm-home-block-title-row">
            <h2 className="gm-home-block-title">今日 Top 3 优先写作建议</h2>
            <Tag color="cyan" style={{ margin: 0 }}>
              免费诊断
            </Tag>
          </div>
          <p className="gm-home-block-desc">
            基于当前品牌与市场最新观测结果，按高意图缺口、情感风险与顺位差距自动排序。
          </p>
        </div>

        <Button size="small" type="link" onClick={onViewAllBriefs}>
          查看全部意见
        </Button>
      </div>

      {capped.length === 0 ? (
        <SignalEmpty
          title="暂无待处理的优先写作建议"
          description="发起新一轮 AI 可见度监测后，系统会自动分析缺口与竞品差距并推送 Top 3 优先写作建议。"
          actionText={readOnly ? undefined : '发起新一轮监测'}
          onAction={readOnly ? undefined : onStartMonitor}
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
                    <SignalPill tone={badge.tone}>{badge.label}</SignalPill>
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
                        <Tag key={ch.channel} color="geekblue" style={{ margin: 0 }}>
                          {ch.channel}
                        </Tag>
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
                  <Button
                    size="small"
                    type="primary"
                    disabled={readOnly}
                    onClick={() => onWriteBrief(brief.id)}
                  >
                    一键去写（10 点）
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
