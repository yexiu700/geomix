'use client';

import {
  UX_TERMS,
  dedupeRechargeNotice,
  replaceUxJargon,
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
  'AI生图/视频',
  'AI数据与诊断',
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
  autoRotateAnnouncements = true,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcementIdx, setAnnouncementIdx] = useState(0);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getSummary();
      setSummary(next);
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

  const announcements = summary.announcements;
  const safeAnnouncementIdx = announcements.length > 0 ? announcementIdx % announcements.length : 0;
  const activeAnnouncement = announcements[safeAnnouncementIdx];

  useEffect(() => {
    if (!autoRotateAnnouncements || announcements.length <= 1) return;
    const timer = setInterval(() => {
      setAnnouncementIdx((prev) => (prev + 1) % announcements.length);
    }, 6_000);
    return () => clearInterval(timer);
  }, [announcements.length, autoRotateAnnouncements]);

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

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 0. GEO Signal Strip */}
      {effectiveVisibility && (
        <GeoSignalStrip
          load={signalLoader}
          onOpenOverview={() => openRoute('/visibility/overview')}
          onOpenMonitors={() => openRoute('/visibility/monitors')}
        />
      )}

      {/* Header Row */}
      <div
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
            GeoMix 智能内容创作工作台 · 账户资产、近 5 日创作趋势与模块快捷入口
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

      {/* 1. Self-written Announcement Bar */}
      {activeAnnouncement && (
        <div
          data-testid="dashboard-announcement-bar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px 12px',
            minHeight: 36,
            padding: '6px 12px',
            borderRadius: 8,
            background: 'var(--gm-bg-surface)',
            border: '1px solid var(--gm-line-1)',
            fontSize: 12,
            color: 'var(--gm-fg-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              flex: '1 1 200px',
            }}
          >
            <SignalPill tone="info">平台播报</SignalPill>
            <span
              style={{
                fontSize: 12,
                color: 'var(--gm-fg-2)',
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}
            >
              {replaceUxJargon(activeAnnouncement.content)}
            </span>
          </div>
          {announcements.length > 1 && (
            <Space size={6} style={{ flexShrink: 0 }}>
              <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                {safeAnnouncementIdx + 1} / {announcements.length}
              </span>
              <Button
                size="small"
                aria-label="上一条播报"
                onClick={() =>
                  setAnnouncementIdx(
                    (prev) => (prev - 1 + announcements.length) % announcements.length,
                  )
                }
              >
                上一条
              </Button>
              <Button
                size="small"
                aria-label="下一条播报"
                onClick={() => setAnnouncementIdx((prev) => (prev + 1) % announcements.length)}
              >
                下一条
              </Button>
            </Space>
          )}
        </div>
      )}

      {/* 2. Balance Card & Points Card */}
      <div className="gm-dashboard-accounts">
        {/* Balance Card */}
        <div data-testid="dashboard-balance-card" className="gm-kpi gm-kpi-compact">
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                账户余额
              </span>
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
                fontSize: 28,
                fontWeight: 600,
                color: 'var(--gm-fg-1)',
                lineHeight: '34px',
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
                marginTop: 10,
                fontSize: 13,
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
              padding: '8px 10px',
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
                marginBottom: 8,
                gap: 8,
              }}
            >
              <Space size={8}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  可用点数
                </span>
                <SignalPill tone={summary.pointsCard.billingMode === 'SHADOW' ? 'warning' : 'info'}>
                  {summary.pointsCard.billingMode === 'SHADOW'
                    ? UX_TERMS.billingShadow
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
                  fontSize: 28,
                  fontWeight: 600,
                  color: 'var(--gm-fg-1)',
                  lineHeight: '34px',
                  letterSpacing: '-0.02em',
                }}
              >
                {renderCompactAmount(summary.pointsCard.available, '', ' 点')}
              </span>
              <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                账面 {summary.pointsCard.points} 点 · 冻结中 {summary.pointsCard.pointsReserved} 点
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                marginTop: 10,
                fontSize: 13,
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
              padding: '8px 10px',
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

      {/* 3. Strict 5-Day AI Creation Trend (Writing & Rewrite by Day) */}
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

      {/* 4. Feature Entry Cards (Phase-1 active + Phase-2 "即将上线") */}
      <div
        data-testid="dashboard-entry-cards"
        style={{
          padding: 16,
          borderRadius: 8,
          border: '1px solid var(--gm-line-1)',
          background: 'var(--gm-bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--gm-fg-1)' }}>功能入口</div>

        {groupedEntries.map(({ group, cards }, groupIdx) => (
          <div key={group}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--gm-fg-3)',
                margin: groupIdx === 0 ? '0 0 8px' : '16px 0 8px',
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
                          marginBottom: 4,
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
                        className="gm-clamp-2"
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
                      className="gm-clamp-2"
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
    </section>
  );
}
