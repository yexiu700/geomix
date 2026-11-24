'use client';

import {
  POINTS_ESTIMATE_LIMITS,
  calculateMonthlyPointsEstimate,
  type MarketingLocale,
  type PointsEstimateResult,
  type PointsEstimateTier,
  type PointsEstimateUnitPoints,
  type PublicPricingPayload,
} from '@geomix/shared';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';

export interface PointsBudgetCalculatorProps {
  locale: MarketingLocale;
  unitPoints: PointsEstimateUnitPoints;
  demoTrial: PublicPricingPayload['demoTrial'];
}

export function buildCalculatorMonthlyGoalSummary(
  locale: MarketingLocale,
  normalized: PointsEstimateResult['normalizedInput'],
): string {
  const isZh = locale === 'zh-CN';
  const raw = isZh
    ? `月均 ${normalized.monthlyArticles} 篇母稿、${normalized.variantChannelsPerArticle} 渠道、${normalized.trackedPrompts} 问句×${normalized.monitoredEngines} 引擎（${normalized.samplesPerPrompt}次采样${normalized.enableAutoRetest ? '，含T+7/14/30复测' : ''}）`
    : `${normalized.monthlyArticles} articles/mo, ${normalized.variantChannelsPerArticle} channels, ${normalized.trackedPrompts} prompts x ${normalized.monitoredEngines} engines (${normalized.samplesPerPrompt}x${normalized.enableAutoRetest ? ', T+7/14/30' : ''})`;
  return raw.slice(0, 160);
}

export function buildCalculatorDemoHref(
  locale: MarketingLocale,
  result: PointsEstimateResult,
): string {
  const basePath = locale === 'zh-CN' ? '/zh/demo' : '/demo';
  const params = new URLSearchParams();
  params.set('estimatedPts', String(result.totalMonthlyPoints));
  params.set('monthlyGoal', buildCalculatorMonthlyGoalSummary(locale, result.normalizedInput));
  return `${basePath}?${params.toString()}`;
}

function getTierMeta(locale: MarketingLocale, tier: PointsEstimateTier) {
  const isZh = locale === 'zh-CN';
  if (tier === 'TRIAL') {
    return {
      label: isZh ? '试用 Demo' : 'Trial Demo',
      badgeClass: 'gm-mkt-badge gm-mkt-badge-cited',
      note: isZh
        ? '预算落在试用 Demo 覆盖范围内，建议先申请 1,000 点账号跑通全链路闭环。'
        : 'Fits comfortably within the Trial Demo allowance to validate the full workflow end-to-end.',
    };
  }
  if (tier === 'GROWTH') {
    return {
      label: isZh ? '增长品牌团队' : 'Growth Brand Team',
      badgeClass: 'gm-mkt-badge gm-mkt-badge-phosphor',
      note: isZh
        ? '适合持续月更与双市场定期监测的单品牌增长团队，可先试用后按需开通点数包。'
        : 'Ideal for active brand teams running monthly publishing and scheduled dual-market attribution.',
    };
  }
  return {
    label: isZh ? '企业与代理版' : 'Agency & Enterprise',
    badgeClass: 'gm-mkt-badge gm-mkt-badge-info',
    note: isZh
      ? '高频监测与多渠道矩阵体量，推荐定制多品牌配额、高并发监测与专属部署方案。'
      : 'High-volume monitoring and multi-channel output; recommended for multi-brand quotas and dedicated deployment.',
  };
}

export function PointsBudgetCalculator({
  locale,
  unitPoints,
  demoTrial,
}: PointsBudgetCalculatorProps) {
  const isZh = locale === 'zh-CN';
  const baseId = useId();

  const [monthlyArticles, setMonthlyArticles] = useState<number>(
    POINTS_ESTIMATE_LIMITS.monthlyArticles.default,
  );
  const [variantChannelsPerArticle, setVariantChannelsPerArticle] = useState<number>(
    POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.default,
  );
  const [trackedPrompts, setTrackedPrompts] = useState<number>(
    POINTS_ESTIMATE_LIMITS.trackedPrompts.default,
  );
  const [monitoredEngines, setMonitoredEngines] = useState<number>(
    POINTS_ESTIMATE_LIMITS.monitoredEngines.default,
  );
  const [samplesPerPrompt, setSamplesPerPrompt] = useState<1 | 3>(1);
  const [enableAutoRetest, setEnableAutoRetest] = useState<boolean>(true);

  const estimate = useMemo(
    () =>
      calculateMonthlyPointsEstimate({
        monthlyArticles,
        variantChannelsPerArticle,
        trackedPrompts,
        monitoredEngines,
        samplesPerPrompt,
        enableAutoRetest,
        unitPoints,
      }),
    [
      monthlyArticles,
      variantChannelsPerArticle,
      trackedPrompts,
      monitoredEngines,
      samplesPerPrompt,
      enableAutoRetest,
      unitPoints,
    ],
  );

  const tierMeta = getTierMeta(locale, estimate.recommendedTier);
  const demoHref = buildCalculatorDemoHref(locale, estimate);

  const articlesId = `${baseId}-articles`;
  const channelsId = `${baseId}-channels`;
  const promptsId = `${baseId}-prompts`;
  const enginesId = `${baseId}-engines`;
  const sample1Id = `${baseId}-sample-1`;
  const sample3Id = `${baseId}-sample-3`;
  const retestId = `${baseId}-retest`;

  const trialCoverageNote =
    estimate.totalMonthlyPoints <= demoTrial.points
      ? isZh
        ? `当前试用 Demo 额度（${demoTrial.points.toLocaleString('en-US')} 点 / ${demoTrial.validDays} 天）可覆盖超过 1 个月的估算用量。`
        : `Your ${demoTrial.points.toLocaleString('en-US')}-point / ${demoTrial.validDays}-day Trial Demo covers more than 1 full month at this pace.`
      : isZh
        ? `试用 Demo（${demoTrial.points.toLocaleString('en-US')} 点）足够完成首批核心问句诊断与试点文章验证，随后再按需扩展点数包。`
        : `Start with the ${demoTrial.points.toLocaleString('en-US')}-point Trial Demo to validate your first diagnostic batch, then scale with a custom points pack.`;

  return (
    <div className="gm-mkt-calc-shell" data-testid="points-budget-calculator">
      <div className="gm-mkt-calc-controls">
        <div className="gm-mkt-calc-field">
          <div className="gm-mkt-calc-field-head">
            <label htmlFor={articlesId} className="gm-mkt-label">
              {isZh ? '月度母稿写作篇数' : 'Master GEO Articles / Month'}
            </label>
            <span className="gm-mkt-badge gm-mkt-badge-phosphor gm-num">
              {estimate.normalizedInput.monthlyArticles} {isZh ? '篇' : 'articles'}
            </span>
          </div>
          <input
            id={articlesId}
            name="monthlyArticles"
            type="range"
            className="gm-mkt-calc-range"
            min={POINTS_ESTIMATE_LIMITS.monthlyArticles.min}
            max={POINTS_ESTIMATE_LIMITS.monthlyArticles.max}
            step={1}
            value={monthlyArticles}
            onChange={(e) => setMonthlyArticles(Number(e.target.value))}
          />
          <div className="gm-mkt-calc-range-scale gm-mono">
            <span>{POINTS_ESTIMATE_LIMITS.monthlyArticles.min}</span>
            <span>{POINTS_ESTIMATE_LIMITS.monthlyArticles.max}</span>
          </div>
        </div>

        <div className="gm-mkt-calc-field">
          <div className="gm-mkt-calc-field-head">
            <label htmlFor={channelsId} className="gm-mkt-label">
              {isZh ? '每篇派生渠道变体数' : 'Channel Variants per Article'}
            </label>
            <span className="gm-mkt-badge gm-mkt-badge-phosphor gm-num">
              {estimate.normalizedInput.variantChannelsPerArticle} {isZh ? '个渠道' : 'channels'}
            </span>
          </div>
          <input
            id={channelsId}
            name="variantChannelsPerArticle"
            type="range"
            className="gm-mkt-calc-range"
            min={POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.min}
            max={POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.max}
            step={1}
            value={variantChannelsPerArticle}
            onChange={(e) => setVariantChannelsPerArticle(Number(e.target.value))}
          />
          <div className="gm-mkt-calc-range-scale gm-mono">
            <span>{POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.min}</span>
            <span>{POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.max}</span>
          </div>
        </div>

        <div className="gm-mkt-calc-field">
          <div className="gm-mkt-calc-field-head">
            <label htmlFor={promptsId} className="gm-mkt-label">
              {isZh ? '核心监测问句数' : 'Tracked Core Prompts'}
            </label>
            <span className="gm-mkt-badge gm-mkt-badge-phosphor gm-num">
              {estimate.normalizedInput.trackedPrompts} {isZh ? '个问句' : 'prompts'}
            </span>
          </div>
          <input
            id={promptsId}
            name="trackedPrompts"
            type="range"
            className="gm-mkt-calc-range"
            min={POINTS_ESTIMATE_LIMITS.trackedPrompts.min}
            max={POINTS_ESTIMATE_LIMITS.trackedPrompts.max}
            step={1}
            value={trackedPrompts}
            onChange={(e) => setTrackedPrompts(Number(e.target.value))}
          />
          <div className="gm-mkt-calc-range-scale gm-mono">
            <span>{POINTS_ESTIMATE_LIMITS.trackedPrompts.min}</span>
            <span>{POINTS_ESTIMATE_LIMITS.trackedPrompts.max}</span>
          </div>
        </div>

        <div className="gm-mkt-calc-field">
          <div className="gm-mkt-calc-field-head">
            <label htmlFor={enginesId} className="gm-mkt-label">
              {isZh ? '监测 AI 引擎数量' : 'Monitored AI Engines'}
            </label>
            <span className="gm-mkt-badge gm-mkt-badge-phosphor gm-num">
              {estimate.normalizedInput.monitoredEngines} {isZh ? '个引擎' : 'engines'}
            </span>
          </div>
          <input
            id={enginesId}
            name="monitoredEngines"
            type="range"
            className="gm-mkt-calc-range"
            min={POINTS_ESTIMATE_LIMITS.monitoredEngines.min}
            max={POINTS_ESTIMATE_LIMITS.monitoredEngines.max}
            step={1}
            value={monitoredEngines}
            onChange={(e) => setMonitoredEngines(Number(e.target.value))}
          />
          <div className="gm-mkt-calc-range-scale gm-mono">
            <span>{POINTS_ESTIMATE_LIMITS.monitoredEngines.min}</span>
            <span>{POINTS_ESTIMATE_LIMITS.monitoredEngines.max}</span>
          </div>
        </div>

        <fieldset className="gm-mkt-calc-fieldset">
          <legend className="gm-mkt-label">{isZh ? '单问句采样次数' : 'Samples per Prompt'}</legend>
          <div className="gm-mkt-calc-radio-group">
            <label
              htmlFor={sample1Id}
              className={`gm-mkt-calc-radio-option${samplesPerPrompt === 1 ? ' is-selected' : ''}`}
            >
              <input
                id={sample1Id}
                type="radio"
                name={`${baseId}-samples`}
                value="1"
                checked={samplesPerPrompt === 1}
                onChange={() => setSamplesPerPrompt(1)}
              />
              <span>{isZh ? '1 次标准采样（1x）' : '1x Standard Sampling'}</span>
            </label>
            <label
              htmlFor={sample3Id}
              className={`gm-mkt-calc-radio-option${samplesPerPrompt === 3 ? ' is-selected' : ''}`}
            >
              <input
                id={sample3Id}
                type="radio"
                name={`${baseId}-samples`}
                value="3"
                checked={samplesPerPrompt === 3}
                onChange={() => setSamplesPerPrompt(3)}
              />
              <span>{isZh ? '3 次高置信采样（3x）' : '3x High-Confidence Sampling'}</span>
            </label>
          </div>
        </fieldset>

        <div className="gm-mkt-calc-toggle-row">
          <input
            id={retestId}
            name="enableAutoRetest"
            type="checkbox"
            checked={enableAutoRetest}
            onChange={(e) => setEnableAutoRetest(e.target.checked)}
          />
          <label htmlFor={retestId} className="gm-mkt-calc-toggle-label">
            <span className="gm-mkt-label">
              {isZh
                ? '开启 T+7 / T+14 / T+30 自动归因复测'
                : 'Enable T+7 / T+14 / T+30 Auto-Retest'}
            </span>
            <span className="gm-mkt-field-hint">
              {isZh
                ? '每篇已发布文章自动执行 3 轮跨引擎可见度复测，闭环验证引用提升。'
                : 'Runs 3 automated post-publish attribution checkpoints per published article across monitored engines.'}
            </span>
          </label>
        </div>
      </div>

      <div className="gm-mkt-calc-summary" aria-live="polite">
        <div className="gm-mkt-calc-summary-head">
          <span className="gm-mkt-eyebrow">
            {isZh ? '月度点数估算结果' : 'Estimated Monthly Points'}
          </span>
          <span className={tierMeta.badgeClass} data-testid="calculator-recommended-tier">
            {tierMeta.label}
          </span>
        </div>

        <div className="gm-mkt-calc-total">
          <span
            className="gm-mkt-calc-total-num gm-num"
            data-testid="calculator-total-points"
            data-total-points={estimate.totalMonthlyPoints}
            data-recommended-tier={estimate.recommendedTier}
          >
            {estimate.totalMonthlyPoints.toLocaleString('en-US')}
          </span>
          <span className="gm-mkt-calc-total-unit">{isZh ? '点 / 月' : 'pts / month'}</span>
        </div>

        <p className="gm-mkt-muted gm-mkt-calc-note">{tierMeta.note}</p>

        <dl className="gm-mkt-calc-breakdown">
          <div className="gm-mkt-calc-row">
            <dt>
              <span>{isZh ? 'GEO 母稿写作' : 'Master GEO Writing'}</span>
              <small className="gm-mono">
                {estimate.normalizedInput.monthlyArticles} × {estimate.unitPoints.geo_write}{' '}
                {isZh ? '点' : 'pts'}
              </small>
            </dt>
            <dd className="gm-num" data-testid="calculator-writing-points">
              {estimate.writingPoints.toLocaleString('en-US')} {isZh ? '点' : 'pts'}
            </dd>
          </div>

          <div className="gm-mkt-calc-row">
            <dt>
              <span>{isZh ? '渠道变体改写' : 'Channel Variants'}</span>
              <small className="gm-mono">
                {estimate.normalizedInput.monthlyArticles} ×{' '}
                {estimate.normalizedInput.variantChannelsPerArticle} ×{' '}
                {estimate.unitPoints.geo_variant} {isZh ? '点' : 'pts'}
              </small>
            </dt>
            <dd className="gm-num" data-testid="calculator-variant-points">
              {estimate.variantPoints.toLocaleString('en-US')} {isZh ? '点' : 'pts'}
            </dd>
          </div>

          <div className="gm-mkt-calc-row">
            <dt>
              <span>{isZh ? '基线可见度诊断' : 'Baseline Visibility Checks'}</span>
              <small className="gm-mono">
                {estimate.normalizedInput.trackedPrompts} ×{' '}
                {estimate.normalizedInput.monitoredEngines} ×{' '}
                {estimate.normalizedInput.samplesPerPrompt} × {estimate.unitPoints.visibility_check}{' '}
                {isZh ? '点' : 'pts'}
              </small>
            </dt>
            <dd className="gm-num" data-testid="calculator-baseline-points">
              {estimate.baselineVisibilityPoints.toLocaleString('en-US')} {isZh ? '点' : 'pts'}
            </dd>
          </div>

          <div className="gm-mkt-calc-row">
            <dt>
              <span>{isZh ? 'T+7/14/30 自动复测' : 'T+7/14/30 Auto-Retest'}</span>
              <small className="gm-mono">
                {estimate.normalizedInput.enableAutoRetest
                  ? `${estimate.normalizedInput.monthlyArticles} × 3 × ${estimate.normalizedInput.monitoredEngines} × ${estimate.normalizedInput.samplesPerPrompt} × ${estimate.unitPoints.visibility_check} ${isZh ? '点' : 'pts'}`
                  : isZh
                    ? '未开启'
                    : 'Disabled'}
              </small>
            </dt>
            <dd className="gm-num" data-testid="calculator-retest-points">
              {estimate.retestVisibilityPoints.toLocaleString('en-US')} {isZh ? '点' : 'pts'}
            </dd>
          </div>
        </dl>

        <p className="gm-mkt-calc-trial-callout">{trialCoverageNote}</p>

        <Link
          href={demoHref}
          className="gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-block"
          data-testid="calculator-demo-cta"
        >
          {isZh ? '带此估算申请 1,000 点 Demo 试用' : 'Request Demo with This Estimate'}
        </Link>
      </div>
    </div>
  );
}
