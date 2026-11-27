'use client';

import { SITE_NAME } from '@geomix/shared';
import { Button } from 'antd';
import type { JSX } from 'react';

export type PrShareErrorKind = 'not_found' | 'rate_limited' | 'generic' | null;

export type PrShareErrorCardProps = {
  loadError: PrShareErrorKind;
  onRetry: () => void;
};

/**
 * 免登录外协 PR 供稿单错误态卡片：独立拆分以保证每个 TSX 文件仅包含 1 个实心主按钮。
 */
export function PrShareErrorCard({ loadError, onRetry }: PrShareErrorCardProps): JSX.Element {
  return (
    <section className="gm-panel gm-pr-share-error" data-testid="pr-share-error-state">
      <div className="gm-pr-share-eyebrow">
        <span>{SITE_NAME}</span>
        <span>·</span>
        <span>PR / KOL Media Brief</span>
      </div>

      {loadError === 'not_found' ? (
        <>
          <h1 className="gm-pr-share-error-title">
            Collaboration Link Unavailable · 协作链接已失效
          </h1>
          <p className="gm-pr-share-error-copy">
            This collaboration link is invalid, expired, or has been revoked by the brand team.
            Please request a fresh share link from your contact.
          </p>
          <p className="gm-pr-share-error-copy-sub">
            该外部协作链接不存在、已过期或已被品牌方撤销。请联系品牌对接人重新生成分享链接。
          </p>
        </>
      ) : (
        <>
          <h1 className="gm-pr-share-error-title">
            {loadError === 'rate_limited'
              ? 'Too Many Requests · 访问过于频繁'
              : 'Unable to Load Media Brief · 暂时无法加载协作包'}
          </h1>
          <p className="gm-pr-share-error-copy">
            {loadError === 'rate_limited'
              ? 'We received too many requests in a short period. Please wait a moment and try reloading this media brief.'
              : 'We encountered a temporary issue while loading this brief. Please check your network connection and try again.'}
          </p>
          <p className="gm-pr-share-error-copy-sub">
            {loadError === 'rate_limited'
              ? '当前访问频率过高，请稍候片刻后点击下方按钮重新加载。'
              : '加载外部协作包时遇到临时网络异常，请稍后重试。'}
          </p>
          <Button
            type="primary"
            autoInsertSpace={false}
            onClick={onRetry}
            className="gm-pr-share-retry-btn"
          >
            重试
          </Button>
        </>
      )}
    </section>
  );
}
