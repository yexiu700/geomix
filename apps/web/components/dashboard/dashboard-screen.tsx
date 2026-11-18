'use client';

import {
  UX_TERMS,
  dedupeRechargeNotice,
  visibleDashboardEntryCards,
  type DashboardEntryCardDef,
  type DashboardSummary,
  type DashboardTrendDay,
  type VisibilityOverviewResponse,
} from '@geomix/shared';
import { Alert, Button, Space, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createEmptyDashboardSummary,
  httpDashboardGateway,
  type DashboardGateway,
} from '../../lib/dashboard';
import { formatCompact, GM } from '../../lib/design-tokens';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { httpVisibilityGateway } from '../../lib/visibility';
import { GeoSignalStrip } from '../geo/geo-signal-strip';
import { SignalPill, SignalSkeleton } from '../geo/primitives';

const ENTRY_GROUP_ORDER: ReadonlyArray<DashboardEntryCardDef['group']> = [
  '素材源力',
  '文章写作',
  '流量复刻',
  'AI数据与诊断',
  'AI生图/视频',
  '二期规划',
];

function renderCompactAmount(raw: string | number, prefix = '', suffix = '') {
  const str = String(raw);
  const integerDigits = str.replace(/\..*$/, '').replace(/[^0-9]/g, '').length;
  const num = Number(raw);
  const full = `${prefix}${str}${suffix}`;
  if (integerDigits > 9 && Number.isFinite(num)) {
    return (
      <Tooltip title={full}>
        <span>
          {prefix}
          {formatCompact(num)}
          {suffix}
        </span>
      </Tooltip>
    );
  }
  return full;
}

function TrendChartSvg({ days }: { days: DashboardTrendDay[] }) {
  const width = 760;
  const height = 220;
  const padLeft = 44;
  const padRight = 24;
  const padTop = 28;
  const padBottom = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max(
    4,
    ...days.map((d) => Math.max(d.writingCount, d.rewriteCount, d.totalCount)),
  );
  const yMax = Math.ceil(maxVal / 2) * 2;
  const ticks = [0, Math.round(yMax / 2), yMax];

  const colW = plotW / Math.max(1, days.length);
  const barW = 12;
  const barGap = 8;

  const yAt = (val: number) => padTop + plotH - (val / yMax) * plotH;

  const linePoints = days
    .map((d, idx) => {
      const cx = padLeft + idx * colW + colW / 2;
      const cy = yAt(d.totalCount);
      return `${cx},${cy}`;
    })
    .join(' ');

  return (
    <svg
      data-testid="dashboard-trend-svg"
      role="img"
      aria-label="近 5 日 AI 创作趋势图"
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', maxHeight: 235, display: 'block' }}
    >
      {/* Horizontal gridlines & Y ticks */}
      {ticks.map((tick) => {
        const y = yAt(tick);
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke={GM.chart.grid}
              strokeWidth={1}
              strokeDasharray={tick === 0 ? undefined : '4 4'}
            />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill={GM.chart.axis}>
              {tick}
            </text>
          </g>
        );
      })}

      {/* Grouped bars per day (Writing + Rewrite) */}
      {days.map((day, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const wX = cx - barW - barGap / 2;
        const rX = cx + barGap / 2;
        const wY = yAt(day.writingCount);
        const wH = Math.max(2, padTop + plotH - wY);
        const rY = yAt(day.rewriteCount);
        const rH = Math.max(2, padTop + plotH - rY);

        return (
          <g key={day.date}>
            {/* AI Writing bar */}
            <rect
              className={day.writingCount > 0 ? 'gm-trend-bar' : undefined}
              x={wX}
              y={day.writingCount > 0 ? wY : padTop + plotH - 2}
              width={barW}
              height={day.writingCount > 0 ? wH : 2}
              rx={2}
              fill={GM.chart.c1}
              opacity={day.writingCount > 0 ? undefined : 0.25}
            />
            {day.writingCount > 0 && (
              <text
                x={wX + barW / 2}
                y={wY - 5}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill={GM.chart.c1}
              >
                {day.writingCount}
              </text>
            )}

            {/* Rewrite bar */}
            <rect
              className={day.rewriteCount > 0 ? 'gm-trend-bar' : undefined}
              x={rX}
              y={day.rewriteCount > 0 ? rY : padTop + plotH - 2}
              width={barW}
              height={day.rewriteCount > 0 ? rH : 2}
              rx={2}
              fill={GM.chart.c2}
              opacity={day.rewriteCount > 0 ? undefined : 0.25}
            />
            {day.rewriteCount > 0 && (
              <text
                x={rX + barW / 2}
                y={rY - 5}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill={GM.chart.c2}
              >
                {day.rewriteCount}
              </text>
            )}

            {/* X-axis date label */}
            <text
              x={cx}
              y={height - 12}
              textAnchor="middle"
              fontSize="11"
              fontWeight="500"
              fill={GM.chart.axis}
            >
              {day.label}
            </text>
          </g>
        );
      })}

      {/* Total creation polyline */}
      {days.length > 1 && (
        <polyline
          fill="none"
          stroke={GM.fg.f2}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          points={linePoints}
        />
      )}
      {days.map((day, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const cy = yAt(day.totalCount);
        return (
          <circle
            key={`${day.date}-pt`}
            cx={cx}
            cy={cy}
            r={3}
            fill={GM.bg.surface}
            stroke={GM.fg.f2}
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
}

export function DashboardScreen({
  title,
  tabId,
  aiImageEnabled = true,
  visibilityEnabled = true,
  storage,
  gateway,
  loadVisibilityOverview,
  autoRotateAnnouncements: _autoRotateAnnouncements,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: DashboardGateway;
  loadVisibilityOverview?: () => Promise<VisibilityOverviewResponse>;
  autoRotateAnnouncements?: boolean;
  onDispatch?: (action: ShellAction) => void;
}) {
  const effectiveStorage = useMemo<SessionStorageLike>(() => {
    if (storage) return storage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => {
        mem.set(k, v);
      },
      removeItem: (k) => {
        mem.delete(k);
      },
    };
  }, [storage]);

  const api = useMemo(
    () => gateway ?? httpDashboardGateway(effectiveStorage),
    [gateway, effectiveStorage],
  );

  const defaultSignalLoad = useCallback(
    () => httpVisibilityGateway(effectiveStorage).getOverview({ days: 14 }),
    [effectiveStorage],
  );
  const signalLoader = loadVisibilityOverview ?? defaultSignalLoad;

  const [summary, setSummary] = useState<DashboardSummary>(() =>
    createEmptyDashboardSummary(aiImageEnabled, new Date(), visibilityEnabled),
  );
  const [hasLoadedSummary, setHasLoadedSummary] = useState(false);
  const [visibilityChecks, setVisibilityChecks] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trackedSignalLoader = useCallback(async () => {
    try {
      const next = await signalLoader();
      setVisibilityChecks(next.metrics.completedChecks);
      return next;
    } catch (err) {
      setVisibilityChecks(0);
      throw err;
    }
  }, [signalLoader]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getSummary();
      setSummary(next);
      setHasLoadedSummary(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载首页数据失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const effectiveAiImage = aiImageEnabled && summary.features.aiImage;
  const effectiveVisibility = visibilityEnabled && summary.features.visibility !== false;
  const entryCards = useMemo(
    () =>
      visibleDashboardEntryCards({
        aiImageEnabled: effectiveAiImage,
        visibilityEnabled: effectiveVisibility,
      }),
    [effectiveAiImage, effectiveVisibility],
  );

  const groupedEntries = useMemo(() => {
    return ENTRY_GROUP_ORDER.map((group) => ({
      group,
      cards: entryCards.filter((card) => card.group === group),
    })).filter((section) => section.cards.length > 0);
  }, [entryCards]);

  const trendWritingTotal = useMemo(
    () => summary.trend5d.reduce((acc, d) => acc + d.writingCount, 0),
    [summary.trend5d],
  );
  const trendRewriteTotal = useMemo(
    () => summary.trend5d.reduce((acc, d) => acc + d.rewriteCount, 0),
    [summary.trend5d],
  );
  const trendGrandTotal = trendWritingTotal + trendRewriteTotal;

  const hasStatsHistory =
    summary.stats.keywords > 0 ||
    summary.stats.questions > 0 ||
    summary.stats.mediaAssets > 0 ||
    summary.stats.knowledgeBases > 0 ||
    summary.stats.prompts > 0 ||
    summary.stats.articleCategories > 0 ||
    summary.stats.aiTasks > 0 ||
    summary.stats.articles > 0 ||
    summary.stats.rewriteSingle > 0 ||
    summary.stats.rewriteBatches > 0 ||
    summary.stats.aiImages > 0;
  const hasHistoricalData = hasStatsHistory || trendGrandTotal > 0 || (visibilityChecks ?? 0) > 0;

  const showZeroPointsGuide = hasLoadedSummary && summary.pointsCard.available <= 0;

  const openRoute = useCallback(
    (href: string) => {
      onDispatch?.({
        type: 'open',
        href,
        sourceId: tabId,
      });
    },
    [onDispatch, tabId],
  );

  const zeroPointsSection = showZeroPointsGuide ? (
    <div data-testid="dashboard-zero-points-guide" className="gm-dashboard-zero-points">
      <div style={{ minWidth: 0, flex: '1 1 360px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SignalPill tone="warning">可用点数为 0</SignalPill>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            在线购点暂未开放 · 下一步建议
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 4, lineHeight: '18px' }}>
          {summary.pointsCard.billingMode === 'SHADOW'
            ? '如需补充可用点数请联系平台管理员为您加点；当前处于免费体验期（暂不扣点），您也可先查看报告、整理关键词与知识库。'
            : '按次计费任务需补充点数后发起，请联系平台管理员为您加点；当前可先免费查看数据报告、整理关键词与查看已有文章。'}
        </div>
      </div>
      <Space size={8} wrap>
        {effectiveVisibility && (
          <Button type="primary" size="small" onClick={() => openRoute('/visibility/overview')}>
            查看 AI 数据看板
          </Button>
        )}
        {effectiveVisibility && summary.pointsCard.billingMode === 'SHADOW' && (
          <Button size="small" onClick={() => openRoute('/visibility/monitors')}>
            去 AI 可见度诊断
          </Button>
        )}
        <Button size="small" onClick={() => openRoute('/me/rights')}>
          查看账号权益
        </Button>
        <Button size="small" onClick={() => openRoute('/material/keywords')}>
          管理关键词与知识库
        </Button>
      </Space>
    </div>
  ) : null;

  const onboardingSection = !hasHistoricalData ? (
    <div data-testid="dashboard-onboarding-guide" className="gm-dashboard-onboarding">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            新手业务主路径 · 3 步开启品牌创作与诊断
          </span>
          <span style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginLeft: 10 }}>
            按顺序完成首次配置，即可快速产出品牌文章并监测 AI 搜索露出
          </span>
        </div>
      </div>
      <div className="gm-dashboard-onboarding-grid">
        <div className="gm-dashboard-onboarding-step">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            第 1 步 · 录入品牌关键词与知识库
          </div>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', lineHeight: '18px' }}>
            先添加品牌主词并录入企业与产品资料，让 AI 生成内容紧扣真实业务。
          </div>
          <Space size={8} wrap style={{ marginTop: 4 }}>
            <Button type="primary" size="small" onClick={() => openRoute('/material/keywords')}>
              添加关键词
            </Button>
            <Button size="small" onClick={() => openRoute('/material/knowledge')}>
              完善知识库
            </Button>
          </Space>
        </div>
        <div className="gm-dashboard-onboarding-step">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            第 2 步 · 生成写作标题与品牌配图
          </div>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', lineHeight: '18px' }}>
            整理客户常见问题作为写作标题，并准备企业实景图或生成品牌配图。
          </div>
          <Space size={8} wrap style={{ marginTop: 4 }}>
            <Button type="primary" size="small" onClick={() => openRoute('/material/questions')}>
              生成写作标题
            </Button>
            {effectiveAiImage && (
              <Button size="small" onClick={() => openRoute('/image')}>
                AI 生图配图
              </Button>
            )}
          </Space>
        </div>
        <div className="gm-dashboard-onboarding-step">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            第 3 步 · 发起 AI 批量写作与诊断
          </div>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', lineHeight: '18px' }}>
            一键批量生成合规品牌文章，并发起主流 AI 引擎的品牌可见度诊断。
          </div>
          <Space size={8} wrap style={{ marginTop: 4 }}>
            <Button type="primary" size="small" onClick={() => openRoute('/writing/tasks')}>
              发起 AI 写作
            </Button>
            {effectiveVisibility && (
              <Button size="small" onClick={() => openRoute('/visibility/monitors')}>
                发起可见度诊断
              </Button>
            )}
          </Space>
        </div>
      </div>
    </div>
  ) : null;

  const signalSection = effectiveVisibility ? (
    <GeoSignalStrip
      load={trackedSignalLoader}
      compactEmpty
      onOpenOverview={() => openRoute('/visibility/overview')}
      onOpenMonitors={() => openRoute('/visibility/monitors')}
    />
  ) : null;

  const accountsSection = (
    <div className="gm-dashboard-accounts">
      {/* Balance Card */}
      <div data-testid="dashboard-balance-card" className="gm-kpi gm-kpi-compact">
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>账户余额</span>
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => openRoute('/me/money')}
            >
              余额明细
            </Button>
          </div>
          <div
            className="gm-num"
            style={{
              fontSize: 26,
              fontWeight: 600,
              color: 'var(--gm-fg-1)',
              lineHeight: '32px',
              letterSpacing: '-0.02em',
            }}
          >
            {renderCompactAmount(summary.balanceCard.balance, '¥')}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              marginTop: 6,
              fontSize: 12,
              color: 'var(--gm-fg-2)',
            }}
          >
            <span>
              本月消耗（<span className="gm-num">{summary.monthKey}</span>）：
              <strong className="gm-num" style={{ color: 'var(--gm-fg-1)' }}>
                ¥{summary.balanceCard.monthConsumed}
              </strong>
            </span>
            <span>
              本月入账：
              <strong className="gm-num" style={{ color: 'var(--gm-sig-cited)' }}>
                ¥{summary.balanceCard.monthRecharged}
              </strong>
            </span>
          </div>
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--gm-bg-elevated)',
            border: '1px solid var(--gm-line-1)',
            fontSize: 12,
            color: 'var(--gm-fg-3)',
          }}
        >
          充值提示：{dedupeRechargeNotice(summary.balanceCard.rechargeNotice)}
        </div>
      </div>

      {/* Points Card */}
      <div data-testid="dashboard-points-card" className="gm-kpi gm-kpi-compact">
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
              gap: 8,
            }}
          >
            <Space size={8}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                可用点数
              </span>
              <SignalPill tone={summary.pointsCard.billingMode === 'SHADOW' ? 'warning' : 'info'}>
                {summary.pointsCard.billingMode === 'SHADOW'
                  ? `${UX_TERMS.billingShadow}（暂不扣点）`
                  : UX_TERMS.billingStrict}
              </SignalPill>
            </Space>
            <Space size={10}>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => openRoute('/me/points')}
              >
                点数明细
              </Button>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => openRoute('/me/rights')}
              >
                账号权益
              </Button>
            </Space>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span
              className="gm-num"
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: 'var(--gm-fg-1)',
                lineHeight: '32px',
                letterSpacing: '-0.02em',
              }}
            >
              {renderCompactAmount(summary.pointsCard.available, '', ' 点')}
            </span>
            {summary.pointsCard.pointsReserved > 0 ? (
              <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                总计 {summary.pointsCard.points} 点 · 任务占用中 {summary.pointsCard.pointsReserved}{' '}
                点
              </span>
            ) : summary.pointsCard.points !== summary.pointsCard.available ? (
              <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                总计 {summary.pointsCard.points} 点
              </span>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              marginTop: 6,
              fontSize: 12,
              color: 'var(--gm-fg-2)',
            }}
          >
            <span>
              本月消耗（<span className="gm-num">{summary.monthKey}</span>）：
              <strong className="gm-num" style={{ color: 'var(--gm-fg-1)' }}>
                {summary.pointsCard.monthConsumedPoints} 点
              </strong>
              {summary.pointsCard.monthListPricePoints !==
                summary.pointsCard.monthConsumedPoints && (
                <span className="gm-num" style={{ color: 'var(--gm-fg-3)', marginLeft: 4 }}>
                  （免费期原价核算 {summary.pointsCard.monthListPricePoints} 点）
                </span>
              )}
            </span>
            <span>
              本月加点：
              <strong className="gm-num" style={{ color: 'var(--gm-sig-cited)' }}>
                +{summary.pointsCard.monthRechargedPoints} 点
              </strong>
            </span>
          </div>
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--gm-bg-elevated)',
            border: '1px solid var(--gm-line-1)',
            fontSize: 12,
            color: 'var(--gm-fg-3)',
          }}
        >
          充值提示：{dedupeRechargeNotice(summary.pointsCard.rechargeNotice)}
        </div>
      </div>
    </div>
  );

  const entryCardsSection = (
    <div
      data-testid="dashboard-entry-cards"
      style={{
        padding: '12px 14px',
        borderRadius: 8,
        border: '1px solid var(--gm-line-1)',
        background: 'var(--gm-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--gm-fg-1)' }}>功能入口</span>
        <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
          点击任意模块卡片直达对应工作区
        </span>
      </div>

      <div className="gm-dashboard-entry-groups">
        {groupedEntries.map(({ group, cards }) => (
          <div key={group}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--gm-fg-3)',
                marginBottom: 6,
                letterSpacing: '0.06em',
              }}
            >
              {group}
            </div>
            <div className="gm-dashboard-entry-grid">
              {cards.map((card) => {
                const statValue = card.statKey ? summary.stats[card.statKey] : null;
                if (card.comingSoon || !card.href) {
                  return (
                    <div
                      key={card.key}
                      data-testid={`dashboard-card-${card.key}`}
                      aria-disabled="true"
                      className="gm-dashboard-entry-card-soon"
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: 'var(--gm-fg-2)',
                          }}
                        >
                          {card.title}
                        </span>
                        <SignalPill tone="neutral">即将上线</SignalPill>
                      </div>
                      <div
                        className="gm-clamp-1"
                        style={{ fontSize: 12, color: 'var(--gm-fg-3)', lineHeight: '18px' }}
                      >
                        {card.desc}
                      </div>
                    </div>
                  );
                }

                const targetHref = card.href;
                return (
                  <button
                    key={card.key}
                    type="button"
                    data-testid={`dashboard-card-${card.key}`}
                    onClick={() => openRoute(targetHref)}
                    className="gm-dashboard-entry-card"
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        gap: 6,
                      }}
                    >
                      <Space size={6}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: 'var(--gm-fg-1)',
                          }}
                        >
                          {card.title}
                        </span>
                        {card.badge === '新上' && (
                          <span
                            style={{
                              height: 16,
                              padding: '0 5px',
                              borderRadius: 4,
                              background: 'var(--gm-phosphor-a16)',
                              color: 'var(--gm-phosphor)',
                              fontSize: 10,
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                            }}
                          >
                            新上
                          </span>
                        )}
                      </Space>
                      {statValue !== null && card.statUnit && (
                        <span
                          className="gm-num"
                          style={{ fontSize: 12, color: 'var(--gm-info)', fontWeight: 500 }}
                        >
                          {statValue} {card.statUnit}
                        </span>
                      )}
                    </div>
                    <div
                      className="gm-clamp-1"
                      style={{ fontSize: 12, color: 'var(--gm-fg-3)', lineHeight: '18px' }}
                    >
                      {card.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const trendSection = (
    <div
      data-testid="dashboard-trend-card"
      style={{
        padding: 16,
        borderRadius: 8,
        border: '1px solid var(--gm-line-1)',
        background: 'var(--gm-bg-surface)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
            近 5 日 AI 创作趋势
          </span>
          <span style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginLeft: 10 }}>
            按北京时间（UTC+8）自然日统计 AI 写作与爆文复刻产出，与文章列表明细一致
          </span>
        </div>
        <Space size={14} wrap>
          <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: 'var(--gm-chart-1)',
                marginRight: 5,
              }}
            />
            AI 写作：{trendWritingTotal} 篇
          </span>
          <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: 'var(--gm-chart-2)',
                marginRight: 5,
              }}
            />
            爆文复刻：{trendRewriteTotal} 篇
          </span>
          <SignalPill tone="neutral">
            <span className="gm-num">5 日合计 {trendGrandTotal} 篇</span>
          </SignalPill>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => openRoute('/writing/articles')}
          >
            查看文章明细
          </Button>
        </Space>
      </div>

      {loading ? (
        <SignalSkeleton variant="block" height={220} />
      ) : (
        <TrendChartSvg days={summary.trend5d} />
      )}

      {/* 5-day per-day exact reconciliation strip */}
      <div className="gm-dashboard-trend-reconcile">
        {summary.trend5d.map((day) => (
          <div
            key={day.date}
            data-testid={`dashboard-trend-day-${day.date}`}
            style={{
              padding: 8,
              borderRadius: 6,
              background: 'var(--gm-bg-elevated)',
              border: '1px solid var(--gm-line-1)',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            <div
              className="gm-num"
              style={{ fontWeight: 600, color: 'var(--gm-fg-1)', marginBottom: 2 }}
            >
              {day.date}
            </div>
            <div style={{ color: 'var(--gm-fg-3)' }}>
              写作{' '}
              <strong className="gm-num" style={{ color: 'var(--gm-chart-1)' }}>
                {day.writingCount}
              </strong>{' '}
              · 复刻{' '}
              <strong className="gm-num" style={{ color: 'var(--gm-chart-2)' }}>
                {day.rewriteCount}
              </strong>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <section
      className="gm-dashboard-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {/* 1. Primary Page Header (always at top of first screen, #135) */}
      <div
        data-testid="dashboard-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            GeoMix 智能内容工作台 · 品牌素材管理、AI 创作与可见度诊断
          </Typography.Text>
        </div>
        <Button
          aria-label="刷新首页"
          size="small"
          loading={loading}
          onClick={() => void loadSummary()}
        >
          刷新数据
        </Button>
      </div>

      {error && (
        <Alert type="error" showIcon closable onClose={() => setError(null)} message={error} />
      )}

      {/* 2. Zero-points next-step guidance when points = 0 and online recharge is disabled (#219) */}
      {zeroPointsSection}

      {!hasHistoricalData ? (
        <>
          {/* Empty / New account flow: 3-step beginner guidance + module quick entries first, then accounts/signals/trend */}
          {onboardingSection}
          {entryCardsSection}
          {accountsSection}
          {signalSection}
          {trendSection}
        </>
      ) : (
        <>
          {/* Historical-data account flow: visibility signals + balance/points + quick entries above the fold, then 5-day trend */}
          {signalSection}
          {accountsSection}
          {entryCardsSection}
          {trendSection}
        </>
      )}
    </section>
  );
}
