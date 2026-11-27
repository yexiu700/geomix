'use client';

import {
  CRAWL_PROBE_STATUS_LABELS,
  formatShanghaiDateTime,
  type CrawlProbeStatus,
  type DistributionCrawlAlertItem,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';
import { Explain, StatusBadge, type StatusTone } from '../ui';

export type HomeCrawlAlertBannerProps = {
  alerts: readonly DistributionCrawlAlertItem[];
  onOpenArticle: (articleId: string) => void;
};

function crawlAlertTone(status: CrawlProbeStatus): StatusTone {
  if (status === 'BLOCKED' || status === 'FAILED') return 'danger';
  if (status === 'WARNING') return 'warning';
  return 'neutral';
}

export function HomeCrawlAlertBanner({
  alerts,
  onOpenArticle,
}: HomeCrawlAlertBannerProps): JSX.Element | null {
  if (alerts.length === 0) return null;

  return (
    <div
      className="gm-home-p0-alert-bar"
      role="region"
      aria-label="抓取异常 P0 告警"
      data-testid="home-crawl-alerts"
    >
      <div className="gm-home-p0-alert-head">
        <span className="gm-home-p0-alert-title">
          抓取告警（<span className="gm-num">{alerts.length}</span>）
        </span>
        <Explain
          text="robots.txt 拦截、HTTP 异常、noindex 或结构化数据缺失将影响 AI 爬虫抓取"
          label="抓取告警说明"
        />
      </div>

      <div className="gm-home-p0-alert-list">
        {alerts.map((alert) => (
          <div
            key={alert.publishRecordId}
            className="gm-home-p0-alert-row"
            data-testid={`home-crawl-alert-${alert.publishRecordId}`}
          >
            <div className="gm-home-p0-alert-main">
              <StatusBadge
                tone={crawlAlertTone(alert.crawlStatus)}
                label={CRAWL_PROBE_STATUS_LABELS[alert.crawlStatus] ?? alert.crawlStatus}
              />
              <span className="gm-home-chip">{alert.channel}</span>
              <span
                className="gm-home-p0-alert-article gm-clamp-1"
                title={alert.articleTitle || alert.publishedUrl}
              >
                {alert.articleTitle || alert.publishedUrl}
              </span>
              {alert.issues.length > 0 ? (
                <span className="gm-home-p0-alert-issue" title={alert.issues.join('；')}>
                  {alert.issues.slice(0, 2).join('；')}
                </span>
              ) : null}
              {alert.crawlCheckedAt ? (
                <span className="gm-home-p0-alert-time gm-num">
                  体检于 {formatShanghaiDateTime(alert.crawlCheckedAt)}
                </span>
              ) : null}
            </div>

            {alert.articleId ? (
              <Button
                size="small"
                danger
                autoInsertSpace={false}
                className="gm-home-nowrap-btn"
                onClick={() => onOpenArticle(alert.articleId)}
              >
                立即排查
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
