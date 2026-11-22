'use client';

import {
  formatShanghaiDateTime,
  isSafeHttpPublishedUrl,
  type GeoArticleRecord,
  type GeoMarket,
  type GeoPublishRecordDto,
  type PublishRecordCreateInput,
} from '@geomix/shared';
import { Button, Input, Spin, Tag } from 'antd';
import type { FormEvent, JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { truncateMiddle } from '../../lib/design-tokens';
import { formatRetestDeltaSummary } from '../../lib/home';

export type StudioPublishRetestProps = {
  activeMarket: GeoMarket;
  article: GeoArticleRecord | null;
  publishRecords: readonly GeoPublishRecordDto[];
  recordsLoading: boolean;
  retestingRecordId: string | null;
  pollingRetestRecordId: string | null;
  readOnly: boolean;
  onCreatePublishRecord: (input: PublishRecordCreateInput) => Promise<boolean | void>;
  onTriggerRetest: (record: GeoPublishRecordDto) => Promise<void>;
};

const CN_CHANNELS = [
  '官网博客',
  '知乎',
  '什么值得买',
  '今日头条',
  '微信公众号',
  '小红书',
  '媒体评测',
  '其他',
] as const;

const GLOBAL_CHANNELS = [
  'Official Blog / Docs',
  'Reddit',
  'Quora',
  'Tech Review Media',
  'YouTube',
  'Other',
] as const;

export function StudioPublishRetest({
  activeMarket,
  article,
  publishRecords,
  recordsLoading,
  retestingRecordId,
  pollingRetestRecordId,
  readOnly,
  onCreatePublishRecord,
  onTriggerRetest,
}: StudioPublishRetestProps): JSX.Element {
  const channelOptions = activeMarket === 'GLOBAL' ? GLOBAL_CHANNELS : CN_CHANNELS;
  const [urlInput, setUrlInput] = useState('');
  const [channel, setChannel] = useState<string>(channelOptions[0]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const contextKeyRef = useRef(0);

  useEffect(() => {
    contextKeyRef.current += 1;
    submittingRef.current = false;
    setSubmitting(false);
    setChannel(activeMarket === 'GLOBAL' ? GLOBAL_CHANNELS[0] : CN_CHANNELS[0]);
    setUrlError(null);
    return () => {
      submittingRef.current = false;
    };
  }, [activeMarket, article?.id]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!article || readOnly || submittingRef.current) return;
    const trimmedUrl = urlInput.trim();
    if (!isSafeHttpPublishedUrl(trimmedUrl)) {
      setUrlError('请输入有效的 http:// 或 https:// 已发布文章链接');
      return;
    }
    submittingRef.current = true;
    const seq = contextKeyRef.current;
    setUrlError(null);
    setSubmitting(true);
    try {
      const result = await onCreatePublishRecord({
        publishedUrl: trimmedUrl,
        channel: channel || channelOptions[0],
      });
      if (seq === contextKeyRef.current && result !== false) {
        setUrlInput('');
      }
    } catch {
      // Preserve urlInput on rejection and swallow unhandled rejection cleanly
    } finally {
      if (seq === contextKeyRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="gm-studio-publish-box" data-testid="studio-publish-retest">
      <div className="gm-studio-delivery-subhead">
        <span className="gm-studio-section-label">发布登记与一键复测</span>
        {publishRecords.length > 0 ? (
          <Tag color="green" style={{ margin: 0 }}>
            已登记 {publishRecords.length} 条
          </Tag>
        ) : null}
      </div>

      {!article ? (
        <div className="gm-studio-item-meta">生成或选择成稿后可登记发布链接并发起排名复测。</div>
      ) : (
        <>
          <form
            className="gm-studio-publish-form"
            data-testid="publish-record-form"
            onSubmit={(e) => void handleSubmit(e)}
          >
            <Input
              size="small"
              aria-label="已发布文章 URL"
              placeholder="https://example.com/guides/geo-article"
              value={urlInput}
              disabled={readOnly || submitting}
              status={urlError ? 'error' : undefined}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (urlError) setUrlError(null);
              }}
            />
            {urlError ? (
              <div className="gm-studio-inline-error" role="alert">
                {urlError}
              </div>
            ) : null}

            <div className="gm-studio-publish-row">
              <select
                aria-label="发布渠道"
                className="gm-select"
                style={{ flex: 1, minWidth: 0 }}
                value={channel}
                disabled={readOnly || submitting}
                onChange={(e) => setChannel(e.target.value)}
              >
                {channelOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <Button
                size="small"
                type="primary"
                htmlType="submit"
                loading={submitting}
                disabled={readOnly || !urlInput.trim()}
              >
                登记发布
              </Button>
            </div>
          </form>

          {recordsLoading && publishRecords.length === 0 ? (
            <div className="gm-studio-item-meta">
              <Spin size="small" /> 正在加载发布记录…
            </div>
          ) : null}

          {publishRecords.length > 0 ? (
            <div className="gm-studio-publish-list">
              {publishRecords.map((rec, idx) => {
                const isPollingThis = pollingRetestRecordId === rec.id;
                const isSubmittingThis = retestingRecordId === rec.id;
                const delta = formatRetestDeltaSummary(rec.beforeMetrics, rec.afterMetrics);
                const safeHref = isSafeHttpPublishedUrl(rec.publishedUrl)
                  ? rec.publishedUrl
                  : undefined;

                return (
                  <div
                    key={rec.id}
                    className="gm-studio-publish-item"
                    data-testid={`publish-record-item-${rec.id}`}
                  >
                    <div className="gm-studio-delivery-subhead">
                      <Tag color="blue" style={{ margin: 0 }}>
                        {rec.channel}
                      </Tag>
                      <span className="gm-studio-item-meta">
                        {formatShanghaiDateTime(rec.publishedAt)}
                      </span>
                    </div>

                    {safeHref ? (
                      <a
                        className="gm-studio-publish-link"
                        href={safeHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={rec.publishedUrl}
                      >
                        {truncateMiddle(rec.publishedUrl, 34)}
                      </a>
                    ) : (
                      <span className="gm-studio-item-meta">
                        {truncateMiddle(rec.publishedUrl, 34)}
                      </span>
                    )}

                    <Button
                      size="small"
                      type="primary"
                      block
                      data-testid={
                        idx === 0 ? 'publish-retest-btn' : `publish-retest-btn-${rec.id}`
                      }
                      loading={isSubmittingThis || isPollingThis}
                      disabled={
                        readOnly || Boolean(retestingRecordId) || Boolean(pollingRetestRecordId)
                      }
                      onClick={() => void onTriggerRetest(rec)}
                    >
                      {isPollingThis ? '复测进行中…' : '一键复测排名变化'}
                    </Button>

                    {isPollingThis ? (
                      <div className="gm-studio-item-meta">
                        等待复测结果返回并回写 Before → After 对比…
                      </div>
                    ) : null}

                    {rec.beforeMetrics || rec.afterMetrics ? (
                      <div className="gm-studio-retest-panel" data-testid="publish-before-after">
                        <div className="gm-studio-retest-title">
                          <span>发布前 / 发布后对比</span>
                          <span className="gm-studio-retest-badge">Before → After</span>
                        </div>
                        <div className="gm-studio-retest-grid">
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">AI 提及率</span>
                            <span className="gm-studio-retest-val gm-num">
                              {delta.mentionLabel}
                            </span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">平均顺位</span>
                            <span className="gm-studio-retest-val gm-num">
                              {delta.positionLabel}
                            </span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">信源引用</span>
                            <span className="gm-studio-retest-val">{delta.citationLabel}</span>
                          </div>
                          <div className="gm-studio-retest-cell">
                            <span className="gm-studio-retest-label">情感倾向</span>
                            <span className="gm-studio-retest-val">{delta.sentimentLabel}</span>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
