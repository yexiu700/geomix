'use client';

import {
  visibleDashboardEntryCards,
  type DashboardEntryCardDef,
  type DashboardSummary,
  type DashboardTrendDay,
} from '@geomix/shared';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createEmptyDashboardSummary,
  httpDashboardGateway,
  type DashboardGateway,
} from '../../lib/dashboard';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';

const ENTRY_GROUP_ORDER: ReadonlyArray<DashboardEntryCardDef['group']> = [
  '素材源力',
  '文章写作',
  '流量复刻',
  'AI生图/视频',
  'AI数据与诊断',
  '二期规划',
];

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
  // Round top grid nicely to even step
  const yMax = Math.ceil(maxVal / 2) * 2;
  const ticks = [0, Math.round(yMax / 2), yMax];

  const colW = plotW / Math.max(1, days.length);
  const barW = 24;
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
              stroke="#edf0f5"
              strokeDasharray={tick === 0 ? undefined : '4 4'}
            />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#8c8c8c">
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
              x={wX}
              y={day.writingCount > 0 ? wY : padTop + plotH - 2}
              width={barW}
              height={day.writingCount > 0 ? wH : 2}
              rx={4}
              fill="#1677ff"
              opacity={day.writingCount > 0 ? 0.92 : 0.25}
            />
            {day.writingCount > 0 && (
              <text
                x={wX + barW / 2}
                y={wY - 5}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#0958d9"
              >
                {day.writingCount}
              </text>
            )}

            {/* Rewrite bar */}
            <rect
              x={rX}
              y={day.rewriteCount > 0 ? rY : padTop + plotH - 2}
              width={barW}
              height={day.rewriteCount > 0 ? rH : 2}
              rx={4}
              fill="#13c2c2"
              opacity={day.rewriteCount > 0 ? 0.92 : 0.25}
            />
            {day.rewriteCount > 0 && (
              <text
                x={rX + barW / 2}
                y={rY - 5}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#006d75"
              >
                {day.rewriteCount}
              </text>
            )}

            {/* X-axis date label */}
            <text
              x={cx}
              y={height - 12}
              textAnchor="middle"
              fontSize="12"
              fontWeight="500"
              fill="#434343"
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
          stroke="#722ed1"
          strokeWidth="2"
          strokeDasharray="5 3"
          points={linePoints}
          opacity="0.7"
        />
      )}
      {days.map((day, idx) => {
        const cx = padLeft + idx * colW + colW / 2;
        const cy = yAt(day.totalCount);
        return <circle key={`${day.date}-pt`} cx={cx} cy={cy} r={3.5} fill="#722ed1" />;
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
  autoRotateAnnouncements = true,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: DashboardGateway;
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

  const openRoute = (href: string) => {
    onDispatch?.({
      type: 'open',
      href,
      sourceId: tabId,
    });
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            padding: '10px 14px',
            borderRadius: 8,
            background: 'linear-gradient(90deg, #f0f5ff 0%, #f9fbff 100%)',
            border: '1px solid #d6e4ff',
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
            <Tag color="blue" style={{ margin: 0, flexShrink: 0 }}>
              平台播报
            </Tag>
            <span
              style={{
                fontSize: 13,
                color: '#1f2937',
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}
            >
              {activeAnnouncement.content}
            </span>
          </div>
          {announcements.length > 1 && (
            <Space size={6} style={{ flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: '#64748b' }}>
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
          gap: 14,
        }}
      >
        {/* Balance Card */}
        <div
          data-testid="dashboard-balance-card"
          style={{
            padding: '16px 18px',
            borderRadius: 10,
            border: '1px solid #e6eaf0',
            background: '#ffffff',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>账户余额</span>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => openRoute('/me/money')}
              >
                余额明细
              </Button>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>
              ¥{summary.balanceCard.balance}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                marginTop: 10,
                fontSize: 13,
                color: '#475569',
              }}
            >
              <span>
                本月消耗（{summary.monthKey}）：
                <strong style={{ color: '#0f172a' }}>¥{summary.balanceCard.monthConsumed}</strong>
              </span>
              <span>
                本月入账：
                <strong style={{ color: '#15803d' }}>¥{summary.balanceCard.monthRecharged}</strong>
              </span>
            </div>
          </div>
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              background: '#f8fafc',
              border: '1px solid #eef2f6',
              fontSize: 12,
              color: '#64748b',
            }}
          >
            充值提示：{summary.balanceCard.rechargeNotice}
          </div>
        </div>

        {/* Points Card */}
        <div
          data-testid="dashboard-points-card"
          style={{
            padding: '16px 18px',
            borderRadius: 10,
            border: '1px solid #d6e4ff',
            background: 'linear-gradient(180deg, #fbfdff 0%, #ffffff 100%)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
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
                <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>可用点数</span>
                <Tag color={summary.pointsCard.billingMode === 'SHADOW' ? 'cyan' : 'blue'}>
                  {summary.pointsCard.billingMode === 'SHADOW' ? '影子计费（免费期）' : '正式计费'}
                </Tag>
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
              <span style={{ fontSize: 28, fontWeight: 700, color: '#1d39c4', lineHeight: 1.2 }}>
                {summary.pointsCard.available} 点
              </span>
              <span style={{ fontSize: 12, color: '#64748b' }}>
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
                color: '#475569',
              }}
            >
              <span>
                本月消耗（{summary.monthKey}）：
                <strong style={{ color: '#0f172a' }}>
                  {summary.pointsCard.monthConsumedPoints} 点
                </strong>
                {summary.pointsCard.monthListPricePoints !==
                  summary.pointsCard.monthConsumedPoints && (
                  <span style={{ color: '#64748b', marginLeft: 4 }}>
                    （免费期原价核算 {summary.pointsCard.monthListPricePoints} 点）
                  </span>
                )}
              </span>
              <span>
                本月加点：
                <strong style={{ color: '#15803d' }}>
                  +{summary.pointsCard.monthRechargedPoints} 点
                </strong>
              </span>
            </div>
          </div>
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              background: '#f0f5ff',
              border: '1px solid #e0ecff',
              fontSize: 12,
              color: '#475569',
            }}
          >
            充值提示：{summary.pointsCard.rechargeNotice}
          </div>
        </div>
      </div>

      {/* 3. Strict 5-Day AI Creation Trend (Writing & Rewrite by Day) */}
      <div
        data-testid="dashboard-trend-card"
        style={{
          padding: '16px 18px',
          borderRadius: 10,
          border: '1px solid #e6eaf0',
          background: '#ffffff',
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
            <span style={{ fontSize: 15, fontWeight: 600, color: '#1f2937' }}>
              近 5 日 AI 创作趋势
            </span>
            <span style={{ fontSize: 12, color: '#64748b', marginLeft: 10 }}>
              按上海自然日统计 AI 写作与爆文复刻产出，与文章列表明细一致
            </span>
          </div>
          <Space size={14} wrap>
            <span style={{ fontSize: 12, color: '#475569' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: '#1677ff',
                  marginRight: 5,
                }}
              />
              AI 写作：{trendWritingTotal} 篇
            </span>
            <span style={{ fontSize: 12, color: '#475569' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: '#13c2c2',
                  marginRight: 5,
                }}
              />
              爆文复刻：{trendRewriteTotal} 篇
            </span>
            <Tag color="purple" style={{ margin: 0 }}>
              5 日合计 {trendGrandTotal} 篇
            </Tag>
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

        <TrendChartSvg days={summary.trend5d} />

        {/* 5-day per-day exact reconciliation strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            gap: 8,
            marginTop: 8,
          }}
        >
          {summary.trend5d.map((day) => (
            <div
              key={day.date}
              data-testid={`dashboard-trend-day-${day.date}`}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: '#f8fafc',
                border: '1px solid #eef2f6',
                fontSize: 12,
                textAlign: 'center',
              }}
            >
              <div style={{ fontWeight: 600, color: '#334155', marginBottom: 2 }}>{day.date}</div>
              <div style={{ color: '#64748b' }}>
                写作 <strong style={{ color: '#0958d9' }}>{day.writingCount}</strong> · 复刻{' '}
                <strong style={{ color: '#006d75' }}>{day.rewriteCount}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Feature Entry Cards (Phase-1 active + Phase-2 "即将上线") */}
      <div
        data-testid="dashboard-entry-cards"
        style={{
          padding: '16px 18px',
          borderRadius: 10,
          border: '1px solid #e6eaf0',
          background: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: '#1f2937' }}>功能入口</div>

        {groupedEntries.map(({ group, cards }) => (
          <div key={group}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#64748b',
                marginBottom: 8,
                letterSpacing: 0.3,
              }}
            >
              {group}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 10,
              }}
            >
              {cards.map((card) => {
                const statValue = card.statKey ? summary.stats[card.statKey] : null;
                if (card.comingSoon || !card.href) {
                  return (
                    <div
                      key={card.key}
                      data-testid={`dashboard-card-${card.key}`}
                      aria-disabled="true"
                      style={{
                        padding: '12px 14px',
                        borderRadius: 8,
                        border: '1px dashed #d9e2ef',
                        background: '#f8fafc',
                        opacity: 0.85,
                      }}
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
                        <span style={{ fontWeight: 600, fontSize: 14, color: '#64748b' }}>
                          {card.title}
                        </span>
                        <Tag style={{ margin: 0 }}>即将上线</Tag>
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
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
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      background: '#ffffff',
                      textAlign: 'left',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: 6,
                    }}
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
                        <span style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>
                          {card.title}
                        </span>
                        {card.badge === '新上' && (
                          <Tag color="green" style={{ margin: 0, fontSize: 11 }}>
                            新上
                          </Tag>
                        )}
                      </Space>
                      {statValue !== null && card.statUnit && (
                        <span style={{ fontSize: 12, color: '#1677ff', fontWeight: 500 }}>
                          {statValue} {card.statUnit}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
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
