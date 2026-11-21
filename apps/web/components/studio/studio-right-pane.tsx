'use client';

import {
  GEO_ARTICLE_STATUSES,
  GEO_ARTICLE_STATUS_LABELS,
  GEO_SCORE_DIMENSION_KEYS,
  countArticleWords,
  formatShanghaiDateTime,
  type BrandFactRecord,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoMarket,
  type GeoScoreDetail,
} from '@geomix/shared';
import { Button, Input, Progress, Tag } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

export type StudioRightPaneProps = {
  activeMarket: GeoMarket;
  article: GeoArticleRecord | null;
  brandFacts: readonly BrandFactRecord[];
  matchedFactIds: readonly string[];
  onChangeStatus: (status: GeoArticleStatus) => Promise<void>;
  onChangeTags: (tags: string[]) => Promise<void>;
  readOnly: boolean;
  evaluatorSlot?: ReactNode;
  deliveryPackSlot?: ReactNode;
  publishRetestSlot?: ReactNode;
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
  brandFacts,
  matchedFactIds,
  onChangeStatus,
  onChangeTags,
  readOnly,
  evaluatorSlot,
  deliveryPackSlot,
  publishRetestSlot,
}: StudioRightPaneProps): JSX.Element {
  const [newTag, setNewTag] = useState('');

  const scoreDetail = article ? readScoreDetail(article.geoScoreDetail) : null;
  const factTitleMap = new Map(brandFacts.map((f) => [f.id, f.title]));
  const matchedFacts = matchedFactIds
    .map((id) => factTitleMap.get(id))
    .filter((title): title is string => Boolean(title));
  const wordCount = article ? countArticleWords(article.contentHtml || article.contentMarkdown) : 0;

  const handleAddTag = async () => {
    if (!article || readOnly) return;
    const trimmed = newTag.trim();
    if (!trimmed) return;
    if (!article.tags.includes(trimmed)) {
      await onChangeTags([...article.tags, trimmed]);
    }
    setNewTag('');
  };

  const handleRemoveTag = async (tag: string) => {
    if (!article || readOnly) return;
    await onChangeTags(article.tags.filter((t) => t !== tag));
  };

  return (
    <aside
      className="gm-studio-pane"
      aria-label="GEO 体检与合规面板"
      data-testid="studio-right-pane"
    >
      <div className="gm-studio-pane-head">
        <span className="gm-studio-pane-title">GEO 体检与双轨合规</span>
      </div>

      {/* Card 1: GEO 0-100 Score Overview */}
      <div className="gm-studio-right-card">
        <span className="gm-studio-section-label">GEO 引用就绪度评分</span>
        {article ? (
          <>
            <div className="gm-studio-score-hero">
              <div>
                <span className="gm-studio-score-num gm-num" data-testid="geo-score-value">
                  {article.geoScore}
                </span>
                <span style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginLeft: 4 }}>/ 100</span>
              </div>
              <Tag
                color={article.geoScore >= 85 ? 'green' : article.geoScore >= 60 ? 'gold' : 'red'}
              >
                {article.geoScore >= 85
                  ? '高引用就绪'
                  : article.geoScore >= 60
                    ? '建议优化'
                    : '待补强'}
              </Tag>
            </div>
            {scoreDetail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {GEO_SCORE_DIMENSION_KEYS.map((key) => {
                  const dim = scoreDetail.dimensions[key];
                  if (!dim) return null;
                  const pct = dim.maxScore > 0 ? Math.round((dim.score / dim.maxScore) * 100) : 0;
                  return (
                    <div key={key} className="gm-studio-dim-row">
                      <div className="gm-studio-dim-head">
                        <span>{dim.label}</span>
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
          <div className="gm-studio-item-meta">生成或选择成稿后实时展示 5 维 GEO 体检分。</div>
        )}
        {evaluatorSlot}
      </div>

      {/* Card 2: Dual-Track Compliance & Matched Facts */}
      <div className="gm-studio-right-card">
        <span className="gm-studio-section-label">双轨合规状态</span>
        <div className="gm-studio-flag-item" data-testid="studio-compliance-track">
          {activeMarket === 'GLOBAL'
            ? '🌐 GLOBAL FTC 客观评测轨（保留 Best / Top / 100% 实测规格）'
            : '🇨🇳 中国广告法合规轨（自动拦截违禁行业并软化绝对化用语）'}
        </div>

        {article ? (
          article.complianceFlags.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {article.complianceFlags.map((flag, idx) => (
                <div key={`${flag.code}-${flag.term}-${idx}`} className="gm-studio-flag-item">
                  <Tag
                    color={
                      flag.severity === 'blocked'
                        ? 'red'
                        : flag.severity === 'replaced'
                          ? 'gold'
                          : 'blue'
                    }
                    style={{ marginBottom: 4 }}
                  >
                    {flag.code}
                  </Tag>
                  <div>{flag.message || flag.term}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--gm-success)' }}>
              合规检查通过，无风险词残留
            </div>
          )
        ) : null}

        {matchedFacts.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            <span className="gm-studio-section-label">已注入品牌事实卡</span>
            <div className="gm-studio-chip-group">
              {matchedFacts.map((title) => (
                <Tag key={title} color="cyan" style={{ margin: 0 }}>
                  {title}
                </Tag>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Card 3: Article Status, Tags & Metadata */}
      {article ? (
        <div className="gm-studio-right-card">
          <span className="gm-studio-section-label">成稿状态与标签</span>
          <select
            aria-label="成稿状态"
            className="gm-select"
            value={article.status}
            disabled={readOnly}
            onChange={(e) => void onChangeStatus(e.target.value as GeoArticleStatus)}
          >
            {GEO_ARTICLE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {GEO_ARTICLE_STATUS_LABELS[st]}
              </option>
            ))}
          </select>

          <div className="gm-studio-chip-group">
            {article.tags.map((tag) => (
              <Tag key={tag} closable={!readOnly} onClose={() => void handleRemoveTag(tag)}>
                {tag}
              </Tag>
            ))}
          </div>
          {!readOnly ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                size="small"
                placeholder="新增标签"
                aria-label="新增文章标签"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onPressEnter={() => void handleAddTag()}
              />
              <Button size="small" onClick={() => void handleAddTag()}>
                添加
              </Button>
            </div>
          ) : null}

          <div className="gm-studio-item-meta">
            <span>正文约 {wordCount} 字</span>
            <span>更新于 {formatShanghaiDateTime(article.updatedAt)}</span>
          </div>
        </div>
      ) : null}

      {/* Extension Slots for M5 Delivery Pack & Publish/Retest */}
      {deliveryPackSlot ? <div className="gm-studio-right-card">{deliveryPackSlot}</div> : null}
      {publishRetestSlot ? <div className="gm-studio-right-card">{publishRetestSlot}</div> : null}
    </aside>
  );
}
