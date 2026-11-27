'use client';

import type {
  BrandFactRecord,
  GeoBriefRecord,
  GeoBriefUpdateInput,
  GeoOutlineHeading,
  GeoRecipe,
  GeoTargetFormat,
} from '@geomix/shared';
import {
  GEO_BRIEF_STATUS_LABELS,
  GEO_RECIPES,
  formatShanghaiDateTime,
  targetFormatsForMarket,
} from '@geomix/shared';
import { Alert, Button, Drawer, Input, Skeleton, Tag, Typography } from 'antd';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { truncateMiddle } from '../../lib/design-tokens';
import {
  BRAND_FACT_SLOT_SHORT,
  GEO_BRIEF_SOURCE_SHORT,
  GEO_MARKET_SHORT,
  GEO_RECIPE_SHORT,
  GEO_TARGET_FORMAT_SHORT,
} from '../../lib/short-labels';
import { isSafeHttpUrl } from '../../lib/visibility';
import { useUxFeedback } from '../crud/ux-feedback';
import { CostChip, StatusBadge, type StatusTone } from '../ui';

export type GeoBriefDrawerProps = {
  open: boolean;
  brief: GeoBriefRecord | null;
  brandFacts: readonly BrandFactRecord[];
  brandFactsLoading?: boolean;
  readOnly: boolean;
  onClose: () => void;
  onSave: (briefId: string, patch: GeoBriefUpdateInput) => Promise<GeoBriefRecord>;
  onDismiss: (brief: GeoBriefRecord) => Promise<void>;
  onWrite: (brief: GeoBriefRecord) => void;
};

type DraftOutlineRow = {
  heading: string;
  intent: string;
  fanOutRef: string;
};

const RECIPE_HINTS: Record<GeoRecipe, string> = {
  AUTHORITY_GUIDE: '首段直答 + 分人群决策表 + 核心指标拆解 + FAQ',
  COMPARISON_MATRIX: '核心参数横向对比表 + 客观优缺点 + 分场景推荐',
  OBJECTION_FAQ: '80–150 字独立可切片问答块 + 实测数据锚点澄清',
  CITATION_COUNTER: '对齐高引用页议题骨架 + 品牌事实卡补齐超越',
};

function cloneOutline(outline: readonly GeoOutlineHeading[]): DraftOutlineRow[] {
  if (outline.length === 0) {
    return [{ heading: '', intent: '', fanOutRef: '' }];
  }
  return outline.map((item) => ({
    heading: item.heading,
    intent: item.intent,
    fanOutRef: item.fanOutRef ?? '',
  }));
}

function normalizeDraftOutline(rows: readonly DraftOutlineRow[]): GeoOutlineHeading[] {
  return rows
    .map((row) => {
      const heading = row.heading.trim();
      const intent = row.intent.trim() || '结合品牌事实展开结构化说明';
      const fanOutRef = row.fanOutRef.trim();
      return {
        heading,
        intent,
        ...(fanOutRef ? { fanOutRef } : {}),
      };
    })
    .filter((row) => row.heading.length > 0);
}

function outlineSignature(outline: readonly GeoOutlineHeading[]): string {
  return JSON.stringify(
    outline.map((item) => ({
      heading: item.heading.trim(),
      intent: item.intent.trim(),
      fanOutRef: (item.fanOutRef ?? '').trim(),
    })),
  );
}

function priorityTone(score: number): StatusTone {
  if (score >= 90) return 'danger';
  if (score >= 80) return 'warning';
  if (score >= 70) return 'active';
  return 'neutral';
}

export function GeoBriefDrawer({
  open,
  brief,
  brandFacts,
  brandFactsLoading = false,
  readOnly,
  onClose,
  onSave,
  onDismiss,
  onWrite,
}: GeoBriefDrawerProps): JSX.Element {
  const feedback = useUxFeedback();
  const [draftTitle, setDraftTitle] = useState('');
  const [draftRecipe, setDraftRecipe] = useState<GeoRecipe>('AUTHORITY_GUIDE');
  const [draftTargetFormat, setDraftTargetFormat] = useState<GeoTargetFormat>('CN_DEEP_REVIEW');
  const [draftOutline, setDraftOutline] = useState<DraftOutlineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!brief) return;
    setDraftTitle(brief.suggestedTitle);
    setDraftRecipe(brief.recommendedRecipe);
    setDraftTargetFormat(brief.targetFormat);
    setDraftOutline(cloneOutline(brief.outlineH2));
    setSaveError(null);
  }, [brief?.id, brief?.updatedAt, brief]);

  const normalizedDraftOutline = useMemo(() => normalizeDraftOutline(draftOutline), [draftOutline]);

  const isDirty = useMemo(() => {
    if (!brief) return false;
    if (draftTitle.trim() !== brief.suggestedTitle.trim()) return true;
    if (draftRecipe !== brief.recommendedRecipe) return true;
    if (draftTargetFormat !== brief.targetFormat) return true;
    if (outlineSignature(normalizedDraftOutline) !== outlineSignature(brief.outlineH2)) {
      return true;
    }
    return false;
  }, [brief, draftRecipe, draftTargetFormat, draftTitle, normalizedDraftOutline]);

  const matchedFacts = useMemo(() => {
    if (!brief || brief.matchedFactIds.length === 0) return [];
    const byId = new Map<string, BrandFactRecord>();
    for (const fact of brandFacts) {
      byId.set(fact.id, fact);
    }
    const resolved: BrandFactRecord[] = [];
    for (const factId of brief.matchedFactIds) {
      const found = byId.get(factId);
      if (found) resolved.push(found);
    }
    return resolved;
  }, [brandFacts, brief]);

  const buildValidatedPatch = (): GeoBriefUpdateInput | null => {
    if (!brief) return null;
    const trimmedTitle = draftTitle.trim();
    if (!trimmedTitle) {
      setSaveError('请填写建议文章标题');
      return null;
    }
    if (normalizedDraftOutline.length === 0) {
      setSaveError('请至少保留 1 个非空的 H2 小节标题');
      return null;
    }

    const patch: GeoBriefUpdateInput = {};
    if (trimmedTitle !== brief.suggestedTitle.trim()) {
      patch.suggestedTitle = trimmedTitle;
    }
    if (draftRecipe !== brief.recommendedRecipe) {
      patch.recommendedRecipe = draftRecipe;
    }
    if (draftTargetFormat !== brief.targetFormat) {
      patch.targetFormat = draftTargetFormat;
    }
    if (outlineSignature(normalizedDraftOutline) !== outlineSignature(brief.outlineH2)) {
      patch.outlineH2 = normalizedDraftOutline;
    }
    return patch;
  };

  const handleSave = async (): Promise<GeoBriefRecord | null> => {
    if (!brief || readOnly || saving) return null;
    setSaveError(null);
    const patch = buildValidatedPatch();
    if (!patch) return null;
    if (Object.keys(patch).length === 0) return brief;

    setSaving(true);
    try {
      const updated = await onSave(brief.id, patch);
      setSaveError(null);
      return updated;
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim() ? err.message.trim() : '保存写作意见失败';
      setSaveError(msg);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleWriteClick = async () => {
    if (!brief || readOnly || saving || dismissing) return;
    if (isDirty) {
      const saved = await handleSave();
      if (!saved) return;
      onWrite(saved);
      return;
    }
    onWrite(brief);
  };

  const handleDismissClick = () => {
    if (!brief || readOnly || dismissing || brief.status === 'DISMISSED') return;
    feedback.confirm({
      title: '确认忽略这条写作建议？',
      content: '忽略后该意见将移出默认待处理列表，仍可通过状态筛选查看。',
      okText: '确认忽略',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDismissing(true);
        try {
          await onDismiss(brief);
        } finally {
          setDismissing(false);
        }
      },
    });
  };

  const updateOutlineRow = (idx: number, patch: Partial<DraftOutlineRow>) => {
    setDraftOutline((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const moveOutlineRow = (idx: number, delta: -1 | 1) => {
    setDraftOutline((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  const deleteOutlineRow = (idx: number) => {
    setDraftOutline((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
  };

  const addOutlineRow = () => {
    setDraftOutline((prev) => {
      if (prev.length >= 15) return prev;
      return [...prev, { heading: '', intent: '', fanOutRef: '' }];
    });
  };

  const marketFormats = brief ? targetFormatsForMarket(brief.market) : [];
  const citationUrlSafe = brief?.sourceCitationUrl ? isSafeHttpUrl(brief.sourceCitationUrl) : false;

  return (
    <Drawer
      open={open && Boolean(brief)}
      onClose={onClose}
      title={null}
      closable={false}
      footer={null}
      width={660}
      styles={{ body: { padding: 0 } }}
    >
      {brief ? (
        <div data-testid="geo-brief-drawer" className="gm-brief-drawer-shell">
          {/* Pinned Header inside geo-brief-drawer (exposes visible title text for accessibility & E2E) */}
          <div className="gm-brief-drawer-header">
            <div className="gm-brief-drawer-header-main">
              <div className="gm-brief-drawer-kicker">GEO 写作诊断意见</div>
              <Typography.Title level={5} className="gm-brief-drawer-headline">
                {draftTitle.trim() || brief.suggestedTitle}
              </Typography.Title>
            </div>
            <Button
              size="small"
              autoInsertSpace={false}
              aria-label="关闭写作意见抽屉"
              onClick={onClose}
              disabled={saving || dismissing}
            >
              关闭
            </Button>
          </div>

          {/* Scrollable 5 PRD §4.3 Sections */}
          <div className="gm-brief-drawer-scroll">
            {/* Section 1: 诊断归因与优先级 */}
            <section className="gm-brief-section" data-testid="brief-section-diagnosis">
              <div className="gm-brief-section-head">
                <span className="gm-brief-section-title">1. 诊断归因与优先级</span>
                <span className="gm-brief-section-time">
                  更新于 {formatShanghaiDateTime(brief.updatedAt || brief.createdAt)}
                </span>
              </div>

              <div className="gm-brief-badge-row">
                <StatusBadge
                  tone={priorityTone(brief.priorityScore)}
                  label={`优先级 ${brief.priorityScore}`}
                />
                <StatusBadge status={brief.status} label={GEO_BRIEF_STATUS_LABELS[brief.status]} />
                <Tag>{GEO_BRIEF_SOURCE_SHORT[brief.sourceType]}</Tag>
                <Tag>{GEO_MARKET_SHORT[brief.market]}</Tag>
              </div>

              <div className="gm-brief-prompt-box">
                <span className="gm-brief-meta-label">目标用户问题</span>
                <div className="gm-brief-prompt-text">{brief.targetPrompt}</div>
              </div>

              <p className="gm-brief-diagnosis-text">{brief.diagnosisSummary}</p>

              {brief.competitorFocus.length > 0 ? (
                <div className="gm-brief-chip-group">
                  <span className="gm-brief-meta-label">重点对照竞品：</span>
                  {brief.competitorFocus.map((comp) => (
                    <StatusBadge key={comp} tone="neutral" label={comp} />
                  ))}
                </div>
              ) : null}

              {brief.targetFanOuts.length > 0 ? (
                <div className="gm-brief-chip-group">
                  <span className="gm-brief-meta-label">目标搜索拆解词：</span>
                  {brief.targetFanOuts.map((term) => (
                    <Tag key={term}>{term}</Tag>
                  ))}
                </div>
              ) : null}

              {brief.sourceCitationUrl ? (
                <div className="gm-brief-cite-row">
                  <span className="gm-brief-meta-label">参考高引用页：</span>
                  {citationUrlSafe ? (
                    <a
                      href={brief.sourceCitationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gm-mono gm-vis-cite-link"
                    >
                      {truncateMiddle(brief.sourceCitationUrl, 64)}
                    </a>
                  ) : (
                    <span className="gm-mono gm-vis-cite-link-muted">
                      {truncateMiddle(brief.sourceCitationUrl, 64)}
                    </span>
                  )}
                </div>
              ) : null}
            </section>

            {/* Section 2: 文体配方、目标阵地与建议标题 */}
            <section className="gm-brief-section" data-testid="brief-section-recipe">
              <div className="gm-brief-section-head">
                <span className="gm-brief-section-title">2. 推荐 GEO 文体配方与标题</span>
              </div>

              <div className="gm-brief-recipe-grid" role="group" aria-label="GEO 文体配方">
                {GEO_RECIPES.map((recipe) => {
                  const active = draftRecipe === recipe;
                  return (
                    <button
                      key={recipe}
                      type="button"
                      data-testid={`brief-recipe-${recipe}`}
                      aria-pressed={active}
                      disabled={readOnly}
                      className={`gm-brief-recipe-card${active ? ' gm-brief-recipe-card-active' : ''}`}
                      onClick={() => setDraftRecipe(recipe)}
                    >
                      <span className="gm-brief-recipe-name">{GEO_RECIPE_SHORT[recipe]}</span>
                      <span className="gm-brief-recipe-hint">{RECIPE_HINTS[recipe]}</span>
                    </button>
                  );
                })}
              </div>

              <div className="gm-brief-format-row" role="group" aria-label="目标阵地形态">
                <span className="gm-brief-meta-label">目标阵地形态（随市场联动）</span>
                <div className="gm-brief-format-pills">
                  {marketFormats.map((fmt) => {
                    const active = draftTargetFormat === fmt;
                    return (
                      <button
                        key={fmt}
                        type="button"
                        data-testid={`brief-format-${fmt}`}
                        aria-pressed={active}
                        disabled={readOnly}
                        className={`gm-day-pill${active ? ' gm-day-pill-active' : ''}`}
                        onClick={() => setDraftTargetFormat(fmt)}
                      >
                        {GEO_TARGET_FORMAT_SHORT[fmt]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="gm-brief-field">
                <label htmlFor="brief-drawer-title-input" className="gm-brief-meta-label">
                  建议文章标题（可编辑）
                </label>
                <Input
                  id="brief-drawer-title-input"
                  data-testid="brief-drawer-title"
                  aria-label="建议文章标题"
                  maxLength={120}
                  value={draftTitle}
                  disabled={readOnly}
                  placeholder="输入建议文章标题"
                  onChange={(e) => setDraftTitle(e.target.value)}
                />
              </div>
            </section>

            {/* Section 3: H2 大纲规划 */}
            <section className="gm-brief-section" data-testid="brief-section-outline">
              <div className="gm-brief-section-head">
                <span className="gm-brief-section-title">
                  3. H2 大纲规划（{draftOutline.length} 节）
                </span>
                <Button
                  size="small"
                  disabled={readOnly || draftOutline.length >= 15}
                  onClick={addOutlineRow}
                >
                  添加小节
                </Button>
              </div>

              <div className="gm-brief-outline-list">
                {draftOutline.map((row, idx) => (
                  <div key={idx} className="gm-brief-outline-row">
                    <div className="gm-brief-outline-row-top">
                      <span className="gm-brief-outline-idx">H2 · {idx + 1}</span>
                      <Input
                        data-testid={`brief-outline-heading-${idx}`}
                        aria-label={`H2 小节 ${idx + 1} 标题`}
                        placeholder="输入 H2 小节标题"
                        maxLength={160}
                        value={row.heading}
                        disabled={readOnly}
                        onChange={(e) => updateOutlineRow(idx, { heading: e.target.value })}
                      />
                      <div className="gm-brief-outline-controls">
                        <Button
                          size="small"
                          autoInsertSpace={false}
                          disabled={readOnly || idx === 0}
                          onClick={() => moveOutlineRow(idx, -1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          autoInsertSpace={false}
                          disabled={readOnly || idx === draftOutline.length - 1}
                          onClick={() => moveOutlineRow(idx, 1)}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          danger
                          autoInsertSpace={false}
                          disabled={readOnly || draftOutline.length <= 1}
                          onClick={() => deleteOutlineRow(idx)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>

                    <div className="gm-brief-outline-row-sub">
                      <Input
                        size="small"
                        data-testid={`brief-outline-intent-${idx}`}
                        aria-label={`H2 小节 ${idx + 1} 写作要点`}
                        placeholder="该小节写作要点（选填）"
                        maxLength={300}
                        value={row.intent}
                        disabled={readOnly}
                        onChange={(e) => updateOutlineRow(idx, { intent: e.target.value })}
                      />
                      <Input
                        size="small"
                        data-testid={`brief-outline-fanout-${idx}`}
                        aria-label={`H2 小节 ${idx + 1} 关联拆解词`}
                        placeholder="关联拆解词（选填）"
                        maxLength={200}
                        value={row.fanOutRef}
                        disabled={readOnly}
                        onChange={(e) => updateOutlineRow(idx, { fanOutRef: e.target.value })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Section 4: 品牌事实卡匹配与缺失补强 */}
            <section className="gm-brief-section" data-testid="brief-section-facts">
              <div className="gm-brief-section-head">
                <span className="gm-brief-section-title">4. 品牌事实卡匹配与缺失补强</span>
              </div>

              {brandFactsLoading ? (
                <Skeleton active paragraph={{ rows: 2 }} title={false} />
              ) : matchedFacts.length > 0 ? (
                <div className="gm-brief-fact-list">
                  {matchedFacts.map((fact) => (
                    <div key={fact.id} className="gm-brief-fact-card">
                      <div className="gm-brief-fact-card-head">
                        <Tag>{BRAND_FACT_SLOT_SHORT[fact.slot]}</Tag>
                        <span className="gm-brief-fact-title">{fact.title}</span>
                      </div>
                      <div className="gm-brief-fact-excerpt">
                        {fact.content.slice(0, 120)}
                        {fact.content.length > 120 ? '…' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              ) : brief.matchedFactIds.length > 0 ? (
                <div className="gm-brief-fact-fallback">
                  已自动关联 {brief.matchedFactIds.length} 条品牌事实卡，写作时将自动注入正文。
                </div>
              ) : (
                <div className="gm-brief-fact-fallback">
                  暂未命中已有品牌事实卡，建议在「品牌资产」补充核心参数与案例以提升引用率。
                </div>
              )}

              {brief.missingFactHints.length > 0 ? (
                <div className="gm-brief-missing-box" data-testid="brief-missing-fact-hints">
                  <div className="gm-brief-missing-title">缺失事实补强建议（补充后可显著提分）</div>
                  <ul className="gm-brief-missing-list">
                    {brief.missingFactHints.map((hint, idx) => (
                      <li key={idx}>{hint}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            {/* Section 5: 建议发布渠道 */}
            <section className="gm-brief-section" data-testid="brief-section-channels">
              <div className="gm-brief-section-head">
                <span className="gm-brief-section-title">5. 建议发布渠道</span>
              </div>
              <div className="gm-brief-channel-list">
                {brief.recommendedChannels.map((item, idx) => (
                  <div key={`${item.channel}-${idx}`} className="gm-brief-channel-item">
                    <Tag>{item.channel}</Tag>
                    <span className="gm-brief-channel-reason">{item.reason}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Sticky Footer inside geo-brief-drawer */}
          <div className="gm-brief-drawer-footer">
            {saveError ? (
              <Alert type="error" showIcon message={saveError} className="gm-brief-drawer-error" />
            ) : null}
            <div className="gm-brief-drawer-footer-actions">
              <div>
                {!readOnly && brief.status !== 'DISMISSED' ? (
                  <Button
                    danger
                    size="small"
                    autoInsertSpace={false}
                    data-testid="brief-drawer-dismiss-btn"
                    loading={dismissing}
                    disabled={saving}
                    onClick={handleDismissClick}
                  >
                    忽略
                  </Button>
                ) : null}
              </div>

              <div className="gm-brief-drawer-footer-right">
                <Button
                  autoInsertSpace={false}
                  data-testid="brief-drawer-save-btn"
                  disabled={readOnly || !isDirty || dismissing}
                  loading={saving}
                  onClick={() => void handleSave()}
                >
                  保存
                </Button>
                <CostChip points={10} />
                <Button
                  type="primary"
                  data-testid="brief-drawer-write-btn"
                  disabled={readOnly || dismissing}
                  loading={saving}
                  onClick={() => void handleWriteClick()}
                >
                  去写作
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
