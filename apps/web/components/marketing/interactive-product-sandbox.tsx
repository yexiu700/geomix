'use client';

import {
  evaluateDistributionPreflight,
  evaluateGeoArticle,
  scanDualTrackCompliance,
  type DistributionPreflightItem,
  type GeoComplianceFlag,
} from '@geomix/shared';
import { useId, useMemo, useRef, useState } from 'react';
import { GM } from '../../lib/design-tokens';
import type { MarketingLocale } from '../../lib/marketing-i18n';
import {
  ATTRIBUTION_SERIES,
  DIAGNOSIS_FIXTURES,
  DISTRIBUTION_CHANNELS,
  HERO_ENGINES,
  PREFLIGHT_CODE_LABELS,
  PREFLIGHT_SANDBOX_BASE,
  type DistributionChannelKey,
  type EngineMarketKey,
} from './marketing-home-data';

type SandboxTabKey = 'diagnosis' | 'preflight' | 'distribution';

const TAB_ORDER: readonly SandboxTabKey[] = ['diagnosis', 'preflight', 'distribution'];

export function HeroEngineStrip({ locale }: { locale: MarketingLocale }) {
  const isZh = locale === 'zh-CN';
  const [market, setMarket] = useState<EngineMarketKey>(isZh ? 'CN' : 'GLOBAL');
  const engines = HERO_ENGINES[market];

  return (
    <div className="gm-mkt-engine-strip" data-testid="hero-engine-strip">
      <div className="gm-mkt-engine-strip-head">
        <span className="gm-mkt-engine-strip-label">
          {isZh ? 'AI 引擎监测矩阵' : 'AI Engine Coverage'}
        </span>
        <div
          className="gm-mkt-market-tabs"
          role="group"
          aria-label={isZh ? '切换引擎市场' : 'Switch engine market'}
        >
          <button
            type="button"
            className={`gm-mkt-market-tab${market === 'GLOBAL' ? ' is-active' : ''}`}
            aria-pressed={market === 'GLOBAL'}
            onClick={() => setMarket('GLOBAL')}
          >
            GLOBAL
          </button>
          <button
            type="button"
            className={`gm-mkt-market-tab${market === 'CN' ? ' is-active' : ''}`}
            aria-pressed={market === 'CN'}
            onClick={() => setMarket('CN')}
          >
            CN
          </button>
        </div>
      </div>

      <ul className="gm-mkt-engine-chips" aria-label={isZh ? '覆盖引擎列表' : 'Covered AI engines'}>
        {engines.map((engine) => (
          <li key={engine.id} className="gm-mkt-engine-chip">
            <span className="gm-mkt-engine-dot" aria-hidden="true" />
            <span className="gm-mkt-engine-name">{engine.label}</span>
            <span className="gm-mkt-engine-detail">{engine.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderStatusLabel(
  status: 'CITED' | 'MENTIONED' | 'COMPETITOR' | 'ABSENT',
  isZh: boolean,
): string {
  if (!isZh) return status;
  switch (status) {
    case 'CITED':
      return '官方引用';
    case 'MENTIONED':
      return '仅被提及';
    case 'COMPETITOR':
      return '竞品占位';
    case 'ABSENT':
      return '品牌缺席';
  }
}

function statusBadgeClass(status: 'CITED' | 'MENTIONED' | 'COMPETITOR' | 'ABSENT'): string {
  switch (status) {
    case 'CITED':
      return 'gm-mkt-badge gm-mkt-badge-cited';
    case 'MENTIONED':
      return 'gm-mkt-badge gm-mkt-badge-mention';
    case 'COMPETITOR':
      return 'gm-mkt-badge gm-mkt-badge-competitor';
    case 'ABSENT':
      return 'gm-mkt-badge gm-mkt-badge-absent';
  }
}

function computeLargestRemainderPcts(values: readonly number[], total: number): number[] {
  if (total <= 0 || values.length === 0) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(0, v) / total) * 100);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = 100 - floors.reduce((sum, f) => sum + f, 0);
  const order = exact
    .map((e, idx) => ({ idx, frac: e - floors[idx]! }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    result[order[i]!.idx]! += 1;
    remainder -= 1;
  }
  return result;
}

function formatPreflightDetails(
  item: DistributionPreflightItem,
  isZh: boolean,
  complianceFlags: readonly GeoComplianceFlag[],
): string[] {
  if (item.code === 'COMPLIANCE_BLOCKED') {
    const formatted: string[] = [];
    const severeFlags = complianceFlags.filter(
      (flag) => flag.severity === 'blocked' || flag.code === 'PROHIBITED_INDUSTRY',
    );
    for (const flag of severeFlags) {
      formatted.push(
        isZh
          ? `${flag.term}：${flag.message}`
          : `Prohibited claim blocked: "${flag.term}" (${flag.code})`,
      );
    }
    if (item.matches && item.matches.length > 0) {
      for (const match of item.matches) {
        formatted.push(
          isZh
            ? `第 ${match.line} 行 · 「${match.matchedText}」(${match.category})`
            : `Line ${match.line} · "${match.matchedText}" (${match.category})`,
        );
      }
    }
    if (formatted.length > 0) {
      return formatted.slice(0, 6);
    }
    if (item.details && item.details.length > 0) {
      return item.details.slice(0, 4).map((raw) => {
        if (isZh) return raw;
        const colonIdx = raw.indexOf(':');
        const term = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : '';
        return term
          ? `Prohibited claim blocked: "${term}"`
          : 'Prohibited high-risk claim blocked by compliance gate';
      });
    }
    return [];
  }

  if (item.code === 'CN_AD_LAW_WARNING') {
    return (item.details ?? [])
      .slice(0, 6)
      .map((term) =>
        isZh ? `广告法极限词提示：「${term}」` : `CN superlative flagged: "${term}"`,
      );
  }

  if (item.matches && item.matches.length > 0) {
    return item.matches.map((match) =>
      isZh
        ? `第 ${match.line} 行 · 「${match.matchedText}」(${match.category})`
        : `Line ${match.line} · "${match.matchedText}" (${match.category})`,
    );
  }
  if (item.details && item.details.length > 0) {
    return item.details.slice(0, 4);
  }
  return [];
}

function AttributionSvgChart({ locale }: { locale: MarketingLocale }) {
  const isZh = locale === 'zh-CN';
  const points = ATTRIBUTION_SERIES[locale];
  const gradientId = useId();

  const width = 460;
  const height = 185;
  const padLeft = 38;
  const padRight = 22;
  const padTop = 18;
  const padBottom = 34;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const maxVal = 65;

  const coords = points.map((pt, idx) => {
    const x = padLeft + (innerW / Math.max(1, points.length - 1)) * idx;
    const yCited = padTop + innerH - (pt.citationRate / maxVal) * innerH;
    const yOwned = padTop + innerH - (pt.ownedShare / maxVal) * innerH;
    return { ...pt, x, yCited, yOwned };
  });

  // Stepped path for citation lift (T0 -> T+7 -> T+14 -> T+30)
  const citedLinePath = coords
    .map((pt, idx) => {
      const prev = idx > 0 ? coords[idx - 1] : undefined;
      if (!prev) return `M ${pt.x} ${pt.yCited}`;
      const midX = (prev.x + pt.x) / 2;
      return `L ${midX} ${prev.yCited} L ${midX} ${pt.yCited} L ${pt.x} ${pt.yCited}`;
    })
    .join(' ');

  const firstCoord = coords[0];
  const lastCoord = coords[coords.length - 1];
  const areaPath =
    firstCoord && lastCoord
      ? `${citedLinePath} L ${lastCoord.x} ${padTop + innerH} L ${firstCoord.x} ${padTop + innerH} Z`
      : '';

  const ownedLinePath = coords
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.yOwned}`)
    .join(' ');

  const yTicks = [0, 20, 40, 60];

  return (
    <div className="gm-mkt-chart-wrap">
      <div className="gm-mkt-chart-head">
        <span className="gm-mkt-chart-title">
          {isZh ? 'T0 → T+30 阶梯归因复测曲线' : 'T0 → T+30 Stepped Attribution Lift'}
        </span>
        <div className="gm-mkt-chart-legend">
          <span className="gm-mkt-legend-item">
            <span className="gm-mkt-legend-swatch gm-mkt-swatch-cited" aria-hidden="true" />
            {isZh ? '总引用率' : 'Citation Rate'}
          </span>
          <span className="gm-mkt-legend-item">
            <span className="gm-mkt-legend-swatch gm-mkt-swatch-owned" aria-hidden="true" />
            {isZh ? '自有域占比' : 'Owned Domain'}
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={
          isZh
            ? 'T0 至 T+30 AI 引用率从 18% 提升至 56%，自有域占比从 11% 提升至 48%'
            : 'AI citation rate rising from 18% at T0 to 56% at T+30, with owned-domain share rising from 11% to 48%'
        }
        className="gm-mkt-chart-svg"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GM.sig.cited} stopOpacity="0.24" />
            <stop offset="100%" stopColor={GM.sig.cited} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yTicks.map((tick) => {
          const y = padTop + innerH - (tick / maxVal) * innerH;
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke={GM.chart.grid}
                strokeDasharray="3 3"
              />
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                fill={GM.chart.axis}
                fontSize="12"
                className="gm-num"
              >
                {tick}%
              </text>
            </g>
          );
        })}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={citedLinePath} fill="none" stroke={GM.sig.cited} strokeWidth="2" />
        <path
          d={ownedLinePath}
          fill="none"
          stroke={GM.chart.c1}
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />

        {coords.map((pt, idx) => {
          const isPeak = idx === coords.length - 1;
          return (
            <g key={pt.day}>
              {isPeak ? (
                <circle
                  cx={pt.x}
                  cy={pt.yCited}
                  r="7"
                  fill="none"
                  stroke={GM.phosphor}
                  strokeWidth="1.4"
                />
              ) : null}
              <circle cx={pt.x} cy={pt.yCited} r="3.5" fill={GM.sig.cited} />
              <circle cx={pt.x} cy={pt.yOwned} r="2.5" fill={GM.chart.c1} />
              <text
                x={pt.x}
                y={pt.yCited - 9}
                textAnchor="middle"
                fill={isPeak ? GM.phosphor : GM.fg.f1}
                fontSize="12"
                fontWeight={isPeak ? '600' : '500'}
                className="gm-num"
              >
                {pt.citationRate}%
              </text>
              <text
                x={pt.x}
                y={height - 10}
                textAnchor="middle"
                fill={GM.chart.axis}
                fontSize="12"
                className="gm-num"
              >
                {pt.day}
              </text>
            </g>
          );
        })}
      </svg>

      <table className="gm-sr-only">
        <caption>
          {isZh ? 'T0 至 T+30 归因复测数据表' : 'T0 to T+30 attribution retest measurements'}
        </caption>
        <thead>
          <tr>
            <th>{isZh ? '复测节点' : 'Checkpoint'}</th>
            <th>{isZh ? 'AI 引用率' : 'Citation Rate'}</th>
            <th>{isZh ? '自有域占比' : 'Owned Domain Share'}</th>
            <th>{isZh ? '说明' : 'Milestone'}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((pt) => (
            <tr key={pt.day}>
              <td>{pt.day}</td>
              <td>{pt.citationRate}%</td>
              <td>{pt.ownedShare}%</td>
              <td>{pt.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InteractiveProductSandbox({ locale }: { locale: MarketingLocale }) {
  const isZh = locale === 'zh-CN';
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [activeTab, setActiveTab] = useState<SandboxTabKey>('diagnosis');
  const [diagnosisMarket, setDiagnosisMarket] = useState<EngineMarketKey>(isZh ? 'CN' : 'GLOBAL');
  const [preflightMarket, setPreflightMarket] = useState<EngineMarketKey>(isZh ? 'CN' : 'GLOBAL');

  // Tab 2 interactive defect toggles
  const [injectTbd, setInjectTbd] = useState(false);
  const [injectHypeClaim, setInjectHypeClaim] = useState(false);
  const [injectCjkLeak, setInjectCjkLeak] = useState(false);

  // Tab 3 channel preview switcher
  const [channelKey, setChannelKey] = useState<DistributionChannelKey>('L1_STOREFRONT');

  const tabs: Array<{ key: SandboxTabKey; num: string; label: string }> = isZh
    ? [
        { key: 'diagnosis', num: '01', label: '引用拓扑诊断' },
        { key: 'preflight', num: '02', label: '合规门禁与写作体检' },
        { key: 'distribution', num: '03', label: '多渠道分发与归因' },
      ]
    : [
        { key: 'diagnosis', num: '01', label: 'Citation Diagnosis' },
        { key: 'preflight', num: '02', label: 'Studio & Preflight Gate' },
        { key: 'distribution', num: '03', label: '1→N Distribution & Attribution' },
      ];

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_ORDER.length - 1;
    }

    if (nextIndex !== null) {
      const nextTab = TAB_ORDER[nextIndex];
      if (!nextTab) return;
      event.preventDefault();
      setActiveTab(nextTab);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  // Tab 1 data
  const diagnosis = DIAGNOSIS_FIXTURES[diagnosisMarket];
  const diagnosisTotal = Math.max(1, diagnosis.totalChecks);

  // Tab 2 real @geomix/shared computation
  const preflightState = useMemo(() => {
    const base = PREFLIGHT_SANDBOX_BASE[preflightMarket];
    let contentMarkdown = base.contentMarkdown;
    if (injectTbd) {
      contentMarkdown = contentMarkdown.replace(base.tbdTarget, base.tbdReplacement);
    }
    if (injectHypeClaim) {
      contentMarkdown += base.hypeAppend;
    }
    if (injectCjkLeak && preflightMarket === 'GLOBAL') {
      contentMarkdown += base.cjkLeakAppend;
    }

    const compliance = scanDualTrackCompliance(contentMarkdown, {
      market: base.market,
    });

    const evaluation = evaluateGeoArticle({
      market: base.market,
      localBrandName: base.localBrandName,
      title: base.title,
      targetPrompt: base.targetPrompt,
      contentMarkdown,
      targetFanOuts: [...base.targetFanOuts],
      matchedFactIds: [...base.matchedFactIds],
      brandFactTexts: [...base.brandFactTexts],
      complianceFlags: compliance.flags,
    });

    const preflight = evaluateDistributionPreflight({
      market: base.market,
      title: base.title,
      contentMarkdown,
      brandNames: [...base.brandNames],
      complianceFlags: compliance.flags,
      geoScore: evaluation.geoScore,
      matchedFactCount: base.matchedFactIds.length,
      provider: base.provider,
      variantSlug: base.variantSlug,
      variantMetaDesc: base.variantMetaDesc,
    });

    return {
      base,
      contentMarkdown,
      compliance,
      evaluation,
      preflight,
    };
  }, [preflightMarket, injectTbd, injectHypeClaim, injectCjkLeak]);

  const channels = DISTRIBUTION_CHANNELS[locale];
  const activeChannel = channels.find((item) => item.key === channelKey) ?? channels[0]!;

  const activeTabId = `${baseId}-tab-${activeTab}`;
  const activePanelId = `${baseId}-panel-${activeTab}`;

  const dimensionRows = [
    {
      key: 'directAnswer',
      label: isZh ? '首段直答' : 'Direct Answer',
      dim: preflightState.evaluation.geoScoreDetail.dimensions.directAnswer,
    },
    {
      key: 'structuredExtractable',
      label: isZh ? '结构化可抽取' : 'Structured Extractable',
      dim: preflightState.evaluation.geoScoreDetail.dimensions.structuredExtractable,
    },
    {
      key: 'factDensity',
      label: isZh ? '事实与量化密度' : 'Fact & Metric Density',
      dim: preflightState.evaluation.geoScoreDetail.dimensions.factDensity,
    },
    {
      key: 'fanOutCoverage',
      label: isZh ? '子问题覆盖' : 'Fan-Out Coverage',
      dim: preflightState.evaluation.geoScoreDetail.dimensions.fanOutCoverage,
    },
    {
      key: 'deAiCompliance',
      label: isZh ? '去套话与合规' : 'De-AI & Compliance',
      dim: preflightState.evaluation.geoScoreDetail.dimensions.deAiCompliance,
    },
  ];

  const codeLabels = PREFLIGHT_CODE_LABELS[locale];

  return (
    <div className="gm-mkt-sandbox" data-testid="interactive-product-sandbox">
      <div className="gm-mkt-sandbox-head">
        <div
          className="gm-mkt-tablist"
          role="tablist"
          aria-label={isZh ? 'GeoMix 核心工作流沙盒' : 'GeoMix Interactive Product Sandbox'}
        >
          {tabs.map((tab, index) => {
            const isSelected = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                id={`${baseId}-tab-${tab.key}`}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={isSelected ? `${baseId}-panel-${tab.key}` : undefined}
                tabIndex={isSelected ? 0 : -1}
                className="gm-mkt-tab"
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span className="gm-mkt-tab-num gm-num">{tab.num}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <span className="gm-mkt-sandbox-fixture-tag gm-mono">
          {isZh ? '虚构示例品牌：北境声学 / NordicAudio' : 'Fictional Fixture: NordicAudio'}
        </span>
      </div>

      <div
        id={activePanelId}
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="gm-mkt-tabpanel"
      >
        {activeTab === 'diagnosis' ? (
          <div className="gm-mkt-sb-stack" data-testid="sandbox-panel-diagnosis">
            <div className="gm-mkt-sb-toolbar">
              <div className="gm-mkt-sb-toolbar-meta">
                <span className="gm-mkt-sb-brand-name">{diagnosis.brandName}</span>
                <span className="gm-mono gm-mkt-muted">{diagnosis.ownedDomain}</span>
              </div>
              <div
                className="gm-mkt-market-tabs"
                role="group"
                aria-label={isZh ? '诊断视角切换' : 'Diagnosis market toggle'}
              >
                <button
                  type="button"
                  className={`gm-mkt-market-tab${diagnosisMarket === 'GLOBAL' ? ' is-active' : ''}`}
                  aria-pressed={diagnosisMarket === 'GLOBAL'}
                  onClick={() => setDiagnosisMarket('GLOBAL')}
                >
                  GLOBAL · NordicAudio
                </button>
                <button
                  type="button"
                  className={`gm-mkt-market-tab${diagnosisMarket === 'CN' ? ' is-active' : ''}`}
                  aria-pressed={diagnosisMarket === 'CN'}
                  onClick={() => setDiagnosisMarket('CN')}
                >
                  CN · 北境声学
                </button>
              </div>
            </div>

            {(() => {
              const kpiDefs = [
                {
                  key: 'CITED',
                  value: diagnosis.breakdown.CITED,
                  cls: 'gm-mkt-kpi-cited',
                  label: isZh ? '官方引用 (CITED)' : 'CITED',
                },
                {
                  key: 'MENTIONED',
                  value: diagnosis.breakdown.MENTIONED,
                  cls: 'gm-mkt-kpi-mention',
                  label: isZh ? '仅提及 (MENTIONED)' : 'MENTIONED',
                },
                {
                  key: 'COMPETITOR',
                  value: diagnosis.breakdown.COMPETITOR,
                  cls: 'gm-mkt-kpi-competitor',
                  label: isZh ? '竞品占位 (COMPETITOR)' : 'COMPETITOR',
                },
                {
                  key: 'ABSENT',
                  value: diagnosis.breakdown.ABSENT,
                  cls: 'gm-mkt-kpi-absent',
                  label: isZh ? '缺席 (ABSENT)' : 'ABSENT',
                },
              ] as const;
              const pcts = computeLargestRemainderPcts(
                kpiDefs.map((k) => k.value),
                diagnosisTotal,
              );
              return (
                <div className="gm-mkt-sb-kpi-row">
                  {kpiDefs.map((kpi, idx) => (
                    <div key={kpi.key} className={`gm-mkt-sb-kpi ${kpi.cls}`}>
                      <span className="gm-mkt-sb-kpi-label">{kpi.label}</span>
                      <div className="gm-mkt-sb-kpi-val-row">
                        <strong
                          className="gm-mkt-sb-kpi-val gm-num"
                          data-testid={`sandbox-kpi-pct-${kpi.key}`}
                        >
                          {pcts[idx]}%
                        </strong>
                        <span className="gm-mkt-sb-kpi-sub gm-num">
                          {kpi.value}/{diagnosis.totalChecks}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <div className="gm-mkt-sb-bars">
              <div className="gm-mkt-bar-header">
                <span>
                  {isZh ? '120 次多引擎采样四态分布' : 'Four-State Breakdown (120 Engine Probes)'}
                </span>
                <span className="gm-mono gm-num">
                  {isZh
                    ? `自有域引用占比 ${diagnosis.ownedCitationSharePct}%`
                    : `Owned-Domain Citation Share: ${diagnosis.ownedCitationSharePct}%`}
                </span>
              </div>
              <div className="gm-mkt-dist-bar" aria-hidden="true">
                <span
                  className="gm-mkt-dist-seg gm-mkt-seg-cited"
                  style={{ width: `${(diagnosis.breakdown.CITED / diagnosisTotal) * 100}%` }}
                />
                <span
                  className="gm-mkt-dist-seg gm-mkt-seg-mention"
                  style={{ width: `${(diagnosis.breakdown.MENTIONED / diagnosisTotal) * 100}%` }}
                />
                <span
                  className="gm-mkt-dist-seg gm-mkt-seg-competitor"
                  style={{ width: `${(diagnosis.breakdown.COMPETITOR / diagnosisTotal) * 100}%` }}
                />
                <span
                  className="gm-mkt-dist-seg gm-mkt-seg-absent"
                  style={{ width: `${(diagnosis.breakdown.ABSENT / diagnosisTotal) * 100}%` }}
                />
              </div>
              <div className="gm-mkt-owned-track" aria-hidden="true">
                <div
                  className="gm-mkt-owned-bar"
                  style={{ width: `${diagnosis.ownedCitationSharePct}%` }}
                />
              </div>
            </div>

            <div className="gm-mkt-prompt-list">
              {diagnosis.prompts.map((row) => (
                <div key={row.id} className="gm-mkt-prompt-row">
                  <div className="gm-mkt-prompt-main">
                    <span className="gm-mkt-prompt-engine gm-mono">{row.engine}</span>
                    <span className="gm-mkt-prompt-text">{row.prompt}</span>
                  </div>
                  <div className="gm-mkt-prompt-meta">
                    <span className={statusBadgeClass(row.status)}>
                      {renderStatusLabel(row.status, isZh)}
                    </span>
                    <span className="gm-mkt-prompt-domain gm-mono">{row.domain}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === 'preflight' ? (
          <div className="gm-mkt-sb-stack" data-testid="sandbox-panel-preflight">
            <div className="gm-mkt-sb-toolbar">
              <div className="gm-mkt-sb-toolbar-meta">
                <span className="gm-mkt-sb-brand-name">{preflightState.base.localBrandName}</span>
                <span className="gm-mono gm-mkt-muted">
                  {isZh
                    ? '实时运行 @geomix/shared 校验引擎'
                    : 'Live @geomix/shared Preflight Engine'}
                </span>
              </div>
              <div
                className="gm-mkt-market-tabs"
                role="group"
                aria-label={isZh ? '合规轨道切换' : 'Preflight market track toggle'}
              >
                <button
                  type="button"
                  className={`gm-mkt-market-tab${preflightMarket === 'GLOBAL' ? ' is-active' : ''}`}
                  aria-pressed={preflightMarket === 'GLOBAL'}
                  onClick={() => setPreflightMarket('GLOBAL')}
                >
                  GLOBAL · Shopify
                </button>
                <button
                  type="button"
                  className={`gm-mkt-market-tab${preflightMarket === 'CN' ? ' is-active' : ''}`}
                  aria-pressed={preflightMarket === 'CN'}
                  onClick={() => setPreflightMarket('CN')}
                >
                  CN · WordPress
                </button>
              </div>
            </div>

            <div className="gm-mkt-sb-grid-2">
              <div className="gm-mkt-sb-card">
                <div className="gm-mkt-sb-card-head">
                  <h3 className="gm-mkt-sb-card-title">
                    {isZh ? '点击注入 / 修复典型风险项' : 'Toggle Edge Cases to Test the Gate'}
                  </h3>
                  <span
                    className="gm-mono gm-mkt-muted"
                    data-testid="sandbox-preflight-track-badge"
                  >
                    {preflightMarket === 'GLOBAL'
                      ? isZh
                        ? 'EN · FTC / 海外轨'
                        : 'EN · FTC / Global'
                      : isZh
                        ? 'ZH · 广告法 / 双轨'
                        : 'ZH · CN Ad Law / Dual-Track'}
                  </span>
                </div>

                <div className="gm-mkt-toggle-grid">
                  <button
                    type="button"
                    className={`gm-mkt-toggle-chip${injectTbd ? ' is-active' : ''}`}
                    aria-pressed={injectTbd}
                    onClick={() => setInjectTbd((v) => !v)}
                    data-testid="sandbox-toggle-tbd"
                  >
                    <span className="gm-mkt-toggle-state">{injectTbd ? 'ON' : 'OFF'}</span>
                    <span className="gm-mkt-toggle-text">
                      <strong>
                        {preflightMarket === 'GLOBAL'
                          ? isZh
                            ? '注入 [TBD: runtime] 占位符'
                            : 'Inject [TBD: runtime] slot'
                          : isZh
                            ? '注入 [待补充：实验室续航]'
                            : 'Inject [待补充] fact slot'}
                      </strong>
                      <span>
                        {isZh
                          ? '触发 MISSING_FACT_SLOTS 硬拦截'
                          : 'Triggers MISSING_FACT_SLOTS blocker'}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`gm-mkt-toggle-chip${injectHypeClaim ? ' is-active' : ''}`}
                    aria-pressed={injectHypeClaim}
                    onClick={() => setInjectHypeClaim((v) => !v)}
                    data-testid="sandbox-toggle-hype"
                  >
                    <span className="gm-mkt-toggle-state">{injectHypeClaim ? 'ON' : 'OFF'}</span>
                    <span className="gm-mkt-toggle-text">
                      <strong>
                        {isZh
                          ? '注入夸大 / 违规绝对化宣称'
                          : 'Inject exaggerated / prohibited claim'}
                      </strong>
                      <span>
                        {preflightMarket === 'GLOBAL'
                          ? isZh
                            ? '同时触发 COMPLIANCE_BLOCKED + GLOBAL_CLAIM_WARNING'
                            : 'Triggers COMPLIANCE_BLOCKED + GLOBAL_CLAIM_WARNING'
                          : isZh
                            ? '同时触发 COMPLIANCE_BLOCKED + CN_AD_LAW_WARNING 并扣减合规分'
                            : 'Triggers COMPLIANCE_BLOCKED + CN_AD_LAW_WARNING & score penalty'}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`gm-mkt-toggle-chip${injectCjkLeak && preflightMarket === 'GLOBAL' ? ' is-active' : ''}`}
                    aria-pressed={preflightMarket === 'GLOBAL' ? injectCjkLeak : false}
                    disabled={preflightMarket === 'CN'}
                    onClick={() => setInjectCjkLeak((v) => !v)}
                    data-testid="sandbox-toggle-cjk"
                  >
                    <span className="gm-mkt-toggle-state">
                      {preflightMarket === 'CN' ? 'N/A' : injectCjkLeak ? 'ON' : 'OFF'}
                    </span>
                    <span className="gm-mkt-toggle-text">
                      <strong>{isZh ? '注入非品牌中文残留' : 'Inject CJK character leak'}</strong>
                      <span>
                        {preflightMarket === 'CN'
                          ? isZh
                            ? '仅海外轨生效（CN 轨原生支持中文）'
                            : 'GLOBAL track only (CN track allows CJK natively)'
                          : isZh
                            ? '触发 GLOBAL_CJK_LEAK 硬拦截'
                            : 'Triggers GLOBAL_CJK_LEAK hard blocker'}
                      </span>
                    </span>
                  </button>
                </div>

                <div className="gm-mkt-draft-box">
                  <div className="gm-mkt-draft-head">
                    <span className="gm-mono">{preflightState.base.variantSlug}</span>
                    <span className="gm-mono">{preflightState.base.provider}</span>
                  </div>
                  <pre className="gm-mkt-draft-preview" data-testid="sandbox-draft-preview">
                    {preflightState.contentMarkdown}
                  </pre>
                </div>
              </div>

              <div className="gm-mkt-sb-card">
                <div className="gm-mkt-gate-summary">
                  <div className="gm-mkt-score-block">
                    <span className="gm-mkt-score-label">
                      {isZh ? '实时 GEO 体检分' : 'Live GEO Audit Score'}
                    </span>
                    <div className="gm-mkt-score-value-row">
                      <strong className="gm-mkt-score-num gm-num" data-testid="sandbox-geo-score">
                        {preflightState.evaluation.geoScore}
                      </strong>
                      <span className="gm-mkt-score-max gm-num">/ 100</span>
                    </div>
                  </div>

                  <div className="gm-mkt-gate-status-wrap">
                    <span
                      className={`gm-mkt-gate-pill ${
                        preflightState.preflight.ok ? 'is-pass' : 'is-blocked'
                      }`}
                      data-testid="sandbox-gate-status"
                    >
                      {preflightState.preflight.ok
                        ? isZh
                          ? 'PASS · 允许发布'
                          : 'PASS · READY TO PUBLISH'
                        : isZh
                          ? 'BLOCKED · 门禁已拦截'
                          : 'BLOCKED · PUBLISH HALTED'}
                    </span>
                    <span className="gm-mkt-gate-counts gm-num">
                      {isZh
                        ? `硬拦截 ${preflightState.preflight.blockers.length} · 软提示 ${preflightState.preflight.warnings.length}`
                        : `${preflightState.preflight.blockers.length} blocker(s) · ${preflightState.preflight.warnings.length} warning(s)`}
                    </span>
                  </div>
                </div>

                <div className="gm-mkt-dim-list">
                  {dimensionRows.map((row) => (
                    <div key={row.key} className="gm-mkt-dim-row">
                      <div className="gm-mkt-dim-head">
                        <span>{row.label}</span>
                        <span className="gm-num gm-mono">
                          {row.dim.score}/{row.dim.maxScore}
                        </span>
                      </div>
                      <div className="gm-mkt-dim-track" aria-hidden="true">
                        <div
                          className="gm-mkt-dim-fill"
                          style={{ width: `${(row.dim.score / row.dim.maxScore) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="gm-mkt-findings" data-testid="sandbox-preflight-findings">
                  {preflightState.preflight.blockers.length === 0 &&
                  preflightState.preflight.warnings.length === 0 ? (
                    <div className="gm-mkt-finding gm-mkt-finding-pass">
                      <strong>
                        {isZh
                          ? '所有双轨门禁规则校验通过'
                          : 'All Dual-Track Preflight Checks Passed'}
                      </strong>
                      <p>
                        {isZh
                          ? '已关联 3 张品牌事实卡，无未补全占位符、无中英串码泄漏且符合目标市场合规规则。'
                          : '3 verified Brand Fact Cards linked, zero unresolved slots, zero CJK leakage, and compliant for direct L1 push.'}
                      </p>
                    </div>
                  ) : null}

                  {preflightState.preflight.blockers.map((item) => {
                    const meta = codeLabels[item.code];
                    const details = formatPreflightDetails(
                      item,
                      isZh,
                      preflightState.compliance.flags,
                    );
                    return (
                      <div
                        key={`blocker-${item.code}`}
                        className="gm-mkt-finding gm-mkt-finding-blocker"
                      >
                        <div className="gm-mkt-finding-head">
                          <span className="gm-mkt-badge gm-mkt-badge-danger">BLOCKER</span>
                          <span className="gm-mono gm-mkt-finding-code">{item.code}</span>
                        </div>
                        <strong>{meta.title}</strong>
                        <p>{meta.summary}</p>
                        {details.length > 0 ? (
                          <ul className="gm-mkt-finding-details gm-mono">
                            {details.map((detail, idx) => (
                              <li key={`${item.code}-${idx}-${detail}`}>{detail}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}

                  {preflightState.preflight.warnings.map((item) => {
                    const meta = codeLabels[item.code];
                    const details = formatPreflightDetails(
                      item,
                      isZh,
                      preflightState.compliance.flags,
                    );
                    return (
                      <div
                        key={`warning-${item.code}`}
                        className="gm-mkt-finding gm-mkt-finding-warning"
                      >
                        <div className="gm-mkt-finding-head">
                          <span className="gm-mkt-badge gm-mkt-badge-warning">WARNING</span>
                          <span className="gm-mono gm-mkt-finding-code">{item.code}</span>
                        </div>
                        <strong>{meta.title}</strong>
                        <p>{meta.summary}</p>
                        {details.length > 0 ? (
                          <ul className="gm-mkt-finding-details gm-mono">
                            {details.map((detail, idx) => (
                              <li key={`${item.code}-${idx}-${detail}`}>{detail}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'distribution' ? (
          <div className="gm-mkt-sb-stack" data-testid="sandbox-panel-distribution">
            <div
              className="gm-mkt-subtabs"
              role="group"
              aria-label={isZh ? '切换分发渠道预览' : 'Switch distribution channel preview'}
            >
              {channels.map((ch) => (
                <button
                  key={ch.key}
                  type="button"
                  className={`gm-mkt-subtab${channelKey === ch.key ? ' is-active' : ''}`}
                  aria-pressed={channelKey === ch.key}
                  onClick={() => setChannelKey(ch.key)}
                >
                  <span>{ch.label}</span>
                  <span className="gm-mkt-subtab-badge gm-mono">{ch.badge}</span>
                </button>
              ))}
            </div>

            <div className="gm-mkt-sb-grid-2">
              <div className="gm-mkt-sb-card">
                <div className="gm-mkt-sb-card-head">
                  <h3 className="gm-mkt-sb-card-title">{activeChannel.label}</h3>
                  <span className="gm-mkt-badge gm-mkt-badge-cited">{activeChannel.badge}</span>
                </div>
                <p className="gm-mkt-sb-copy">{activeChannel.summary}</p>

                <div className="gm-mkt-draft-box">
                  <div className="gm-mkt-draft-head">
                    <span className="gm-mono">{activeChannel.snippetLabel}</span>
                  </div>
                  <pre className="gm-mkt-code-pre">{activeChannel.snippet}</pre>
                </div>

                <ul className="gm-mkt-check-list">
                  {activeChannel.checklist.map((entry) => (
                    <li key={entry}>
                      <span className="gm-mkt-check-mark" aria-hidden="true">
                        ✓
                      </span>
                      <span>{entry}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="gm-mkt-sb-card">
                <div className="gm-mkt-sb-card-head">
                  <h3 className="gm-mkt-sb-card-title">
                    {isZh ? 'T+1 抓取体检 & T+7/14/30 归因复测' : 'T+1 CrawlProbe & Attribution'}
                  </h3>
                  <span className="gm-mkt-badge gm-mkt-badge-cited">0 PTS PROBE</span>
                </div>

                <div className="gm-mkt-probe-strip" data-testid="sandbox-crawl-probe">
                  {[
                    { label: 'HTTP 200', detail: isZh ? '页面可正常访问' : 'Live & Reachable' },
                    { label: 'robots.txt', detail: isZh ? '允许 AI 检索爬虫' : 'AI Bots Allowed' },
                    {
                      label: 'JSON-LD',
                      detail: isZh ? 'Article + FAQPage 有效' : 'Article + FAQPage Valid',
                    },
                  ].map((probe) => (
                    <div key={probe.label} className="gm-mkt-probe-chip">
                      <span className="gm-mkt-probe-status gm-mono">✓ {probe.label}</span>
                      <span className="gm-mkt-probe-detail">{probe.detail}</span>
                    </div>
                  ))}
                </div>

                <AttributionSvgChart locale={locale} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
