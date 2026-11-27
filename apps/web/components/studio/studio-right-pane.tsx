'use client';

import {
  GEO_SCORE_DIMENSION_KEYS,
  UX_GLOSSARY_TOOLTIPS,
  UX_TERMS,
  type BrandFactRecord,
  type GeoArticleRecord,
  type GeoMarket,
  type GeoScoreDetail,
} from '@geomix/shared';
import { Button, Progress, Tag, Tooltip } from 'antd';
import type { JSX, ReactNode } from 'react';
import { Explain, StatusBadge } from '../ui';

export type StudioRightPaneProps = {
  activeMarket: GeoMarket;
  article: GeoArticleRecord | null;
  streaming?: boolean;
  prewriteExpanded?: boolean;
  brandFacts: readonly BrandFactRecord[];
  matchedFactIds: readonly string[];
  missingSlotCount?: number;
  navigatingPublish?: boolean;
  onFocusMissingFacts?: () => void;
  onNavigatePublish?: () => void;
  readOnly: boolean;
  evaluatorSlot?: ReactNode;
};

function readScoreDetail(raw: Record<string, unknown> | undefined): GeoScoreDetail | null {
  if (!raw || typeof raw !== 'object' || !('dimensions' in raw)) return null;
  const dims = (raw as { dimensions?: unknown }).dimensions;
  if (!dims || typeof dims !== 'object') return null;
  return raw as unknown as GeoScoreDetail;
}

export function StudioRightPane({
  activeMarket,
  article,
  streaming = false,
  prewriteExpanded = false,
  brandFacts,
  matchedFactIds,
  missingSlotCount = 0,
  navigatingPublish = false,
  onFocusMissingFacts,
  onNavigatePublish,
  readOnly: _readOnly,
  evaluatorSlot,
}: StudioRightPaneProps): JSX.Element {
  const scoreDetail = article ? readScoreDetail(article.geoScoreDetail) : null;
  const factTitleMap = new Map(brandFacts.map((f) => [f.id, f.title]));
  const matchedFacts = matchedFactIds
    .map((id) => factTitleMap.get(id))
    .filter((title): title is string => Boolean(title));

  const scoreTone = article
    ? article.geoScore >= 85
      ? 'success'
      : article.geoScore >= 60
        ? 'warning'
        : 'danger'
    : 'neutral';

  return (
    <aside
      className="gm-studio-pane gm-studio-pane--right"
      aria-label="GEO 体检与合规面板"
      data-testid="studio-right-pane"
    >
      <div className="gm-studio-pane-head">
        <span className="gm-studio-pane-title">体检</span>
      </div>

      {/* Independent Scrollable Right Body */}
      <div className="gm-studio-right-scroll">
        <div className="gm-studio-right-section">
          {/* Card 1: GEO 0-100 Score Overview */}
          <div className="gm-studio-right-card">
            <span className="gm-studio-section-label">GEO 分</span>
            {article ? (
              <>
                <div className="gm-studio-score-hero">
                  <div>
                    <span className="gm-studio-score-num gm-num" data-testid="geo-score-value">
                      {article.geoScore}
                    </span>
                    <span className="gm-studio-score-denom">/ 100</span>
                  </div>
                  <StatusBadge tone={scoreTone}>
                    {article.geoScore >= 85 ? '就绪' : article.geoScore >= 60 ? '待优化' : '待补强'}
                  </StatusBadge>
                </div>
                {scoreDetail ? (
                  <div className="gm-studio-stack">
                    {GEO_SCORE_DIMENSION_KEYS.map((key) => {
                      const dim = scoreDetail.dimensions[key];
                      if (!dim) return null;
                      const pct =
                        dim.maxScore > 0 ? Math.round((dim.score / dim.maxScore) * 100) : 0;
                      const isFanOut = key === 'fanOutCoverage';
                      return (
                        <div key={key} className="gm-studio-dim-row">
                          <div className="gm-studio-dim-head">
                            {isFanOut ? (
                              <Tooltip title={UX_GLOSSARY_TOOLTIPS.fanOutCoverage}>
                                <span className="gm-studio-glossary-trigger">
                                  {UX_TERMS.fanOutCoverage}
                                </span>
                              </Tooltip>
                            ) : (
                              <span>{dim.label}</span>
                            )}
                            <span className="gm-num">
                              {dim.score} / {dim.maxScore}
                            </span>
                          </div>
                          <Progress
                            size="small"
                            percent={pct}
                            showInfo={false}
                            strokeColor={dim.passed ? 'var(--gm-success)' : 'var(--gm-warning)'}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="gm-studio-explain-row gm-studio-item-meta">
                <span>暂无体检</span>
                <Explain text="生成或选择成稿后实时展示 5 维 GEO 体检分。" />
              </div>
            )}
            {evaluatorSlot}
          </div>

          {/* Card 2: Dual-Track Compliance & Matched Facts */}
          <div className="gm-studio-right-card">
            <span className="gm-studio-section-label gm-studio-explain-row">
              <span>合规</span>
              <Explain
                text={
                  activeMarket === 'GLOBAL'
                    ? 'GLOBAL FTC 客观评测轨（保留 Best / Top / 100% 实测规格）'
                    : '中国广告法合规轨（自动拦截违禁行业并软化绝对化用语）'
                }
              />
            </span>
            <div className="gm-studio-flag-item" data-testid="studio-compliance-track">
              {activeMarket === 'GLOBAL' ? 'FTC 客观轨' : '广告法合规'}
            </div>

            {article ? (
              article.complianceFlags.length > 0 ? (
                <div className="gm-studio-stack">
                  {article.complianceFlags.map((flag, idx) => (
                    <div key={`${flag.code}-${flag.term}-${idx}`} className="gm-studio-flag-item">
                      <div>
                        <StatusBadge
                          tone={
                            flag.severity === 'blocked'
                              ? 'danger'
                              : flag.severity === 'replaced'
                                ? 'warning'
                                : 'active'
                          }
                        >
                          {flag.code}
                        </StatusBadge>
                      </div>
                      <div>{flag.message || flag.term}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gm-studio-text-success">合规通过</div>
              )
            ) : null}

            {matchedFacts.length > 0 ? (
              <div className="gm-studio-stack gm-studio-stack--sm">
                <span className="gm-studio-section-label">已用事实</span>
                <div className="gm-studio-chip-group">
                  {matchedFacts.map((title) => (
                    <Tag key={title} className="gm-studio-tag-reset">
                      {title}
                    </Tag>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Sticky Single-Primary-CTA Footer State Machine */}
      <div className="gm-studio-right-footer" data-testid="studio-right-footer">
        {article && !streaming && missingSlotCount > 0 ? (
          <>
            <Button
              type={prewriteExpanded ? 'default' : 'primary'}
              block
              data-testid="studio-batch-tbd-open-btn"
              onClick={() => onFocusMissingFacts?.()}
            >
              补齐事实
            </Button>
            <div className="gm-studio-footer-caption-row">
              <span className="gm-studio-explain-row">
                <span>待补 {missingSlotCount} 组</span>
                <Explain text="建议先补齐真实参数再发布" />
              </span>
              <button
                type="button"
                className="gm-studio-footer-fallback-link"
                data-testid="studio-go-publish-btn"
                disabled={navigatingPublish}
                onClick={() => onNavigatePublish?.()}
              >
                {navigatingPublish ? '保存中…' : '仍去发布'}
              </button>
            </div>
          </>
        ) : article && !streaming ? (
          <>
            <Button
              type={prewriteExpanded ? 'default' : 'primary'}
              block
              loading={navigatingPublish}
              data-testid="studio-go-publish-btn"
              onClick={() => onNavigatePublish?.()}
            >
              去发布
            </Button>
            <div className="gm-studio-footer-caption-row">
              <span className="gm-studio-explain-row">
                <span>{article.status === 'PUBLISHED' ? '已发布' : '可发布'}</span>
                <Explain
                  text={
                    article.status === 'PUBLISHED'
                      ? '该篇已发布，可前往发布中心查看抓取与复测'
                      : article.geoScore >= 85
                        ? '已通过引用就绪检查，可前往发布中心分发'
                        : '事实已补齐，可前往发布中心预览与分发'
                  }
                />
              </span>
            </div>
          </>
        ) : (
          <>
            <Button type="default" block disabled data-testid="studio-go-publish-btn">
              去发布
            </Button>
            <div className="gm-studio-footer-caption-row">
              <span className="gm-studio-explain-row">
                <span>{streaming ? '生成中' : '待成稿'}</span>
                <Explain
                  text={
                    streaming
                      ? '正在生成正文，完成后可前往发布中心'
                      : '生成或选择成稿后即可前往发布中心'
                  }
                />
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
