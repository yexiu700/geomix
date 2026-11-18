'use client';

import type { VisibilityOverviewResponse } from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { formatPct } from '../../lib/design-tokens';
import { SignalEmpty, SignalError, SignalKpiCard, SignalSkeleton } from './primitives';

export type GeoSignalStripProps = {
  load: () => Promise<VisibilityOverviewResponse>;
  onOpenOverview: () => void;
  onOpenMonitors?: () => void;
};

export function GeoSignalStrip({
  load,
  onOpenOverview,
  onOpenMonitors,
}: GeoSignalStripProps): JSX.Element {
  const [data, setData] = useState<VisibilityOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await load();
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 可见度信号加载失败');
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const metrics = data?.metrics;

  return (
    <div data-testid="geo-signal-strip">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.06em',
            color: 'var(--gm-fg-3)',
          }}
        >
          AI 可见度信号 · 近 14 日
        </span>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={onOpenOverview}>
          进入 AI 数据看板 →
        </Button>
      </div>

      {loading ? (
        <div className="gm-signal-strip-grid" data-testid="geo-signal-strip-loading">
          {[0, 1, 2, 3].map((idx) => (
            <SignalSkeleton key={idx} variant="kpi" />
          ))}
        </div>
      ) : error ? (
        <div style={{ marginBottom: 16 }}>
          <SignalError message="AI 可见度信号加载失败" onRetry={() => void reload()} />
        </div>
      ) : !metrics || metrics.completedChecks === 0 ? (
        <div
          style={{
            marginBottom: 16,
            border: '1px solid var(--gm-line-1)',
            borderRadius: 'var(--gm-radius-md)',
            background: 'var(--gm-bg-surface)',
          }}
        >
          <SignalEmpty
            title="还没有 AI 可见度数据"
            description="创建品牌档案并发起一次监测，即可在这里看到你在各大 AI 引擎中的提及率"
            actionText="去发起诊断"
            onAction={onOpenMonitors}
          />
        </div>
      ) : (
        <div className="gm-signal-strip-grid">
          <SignalKpiCard
            testId="geo-signal-visibility"
            label="品牌提及率"
            value={formatPct(metrics.visibilityPct)}
            numerator={metrics.mentionedChecks}
            denominator={metrics.completedChecks}
            tone="cited"
            onClick={onOpenOverview}
          />
          <SignalKpiCard
            testId="geo-signal-sov"
            label="声量占比"
            value={formatPct(metrics.shareOfVoice.brandSharePct)}
            numerator={metrics.shareOfVoice.brandMentions}
            denominator={metrics.shareOfVoice.totalMentions}
            tone="cited"
            onClick={onOpenOverview}
          />
          <SignalKpiCard
            testId="geo-signal-position"
            label="平均推荐顺位"
            value={metrics.avgPosition === null ? '—' : `#${metrics.avgPosition.toFixed(1)}`}
            tone="info"
            caption="越靠前越好"
            onClick={onOpenOverview}
          />
          <SignalKpiCard
            testId="geo-signal-owned-citation"
            label="自有域名引用率"
            value={formatPct(metrics.ownedCitationRatePct)}
            numerator={metrics.ownedCitations}
            denominator={metrics.totalCitations}
            tone="cited"
            onClick={onOpenOverview}
          />
        </div>
      )}
    </div>
  );
}
