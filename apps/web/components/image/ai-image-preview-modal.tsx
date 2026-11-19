'use client';

import type { AiImageJobItem } from '@geomix/shared';
import { Button, Modal, Space, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { resolveMediaUrl } from '../../lib/gallery';
import { triggerAssetDownload } from './ai-image-helpers';

export type AiImagePreviewTarget = {
  job: AiImageJobItem;
  assetIndex: number;
};

type PreviewImgStatus = 'loading' | 'loaded' | 'error';

export type AiImagePreviewModalProps = {
  /** 预览目标（订单 + 第几张）；null 时弹窗关闭 */
  target: AiImagePreviewTarget | null;
  onClose: () => void;
};

/** 大图预览弹窗：按资产切换重置加载态，内置 加载中 / 已加载 / 失败重试 状态机。 */
export function AiImagePreviewModal({ target, onClose }: AiImagePreviewModalProps) {
  const [imgStatus, setImgStatus] = useState<PreviewImgStatus>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const asset = target?.job.assets[target.assetIndex] ?? null;

  useEffect(() => {
    if (!target || !asset) return;
    setImgStatus('loading');
    const imgEl = imgRef.current;
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      setImgStatus('loaded');
    }
  }, [target, asset, retryKey]);

  return (
    <Modal
      open={Boolean(target && asset)}
      keyboard
      transitionName=""
      maskTransitionName=""
      title={
        target
          ? `图片预览 · ${target.job.orderNo}（第 ${target.assetIndex + 1}/${target.job.assets.length} 张）`
          : '图片预览'
      }
      footer={
        target && asset ? (
          <Space>
            <Button
              onClick={() => triggerAssetDownload(asset, target.job.orderNo, target.assetIndex)}
            >
              下载原图
            </Button>
            <Button type="primary" onClick={onClose}>
              关闭
            </Button>
          </Space>
        ) : null
      }
      width={760}
      onCancel={onClose}
    >
      {target && asset && (
        <div>
          <div
            style={{
              background: 'var(--gm-bg-base)',
              borderRadius: 8,
              padding: 12,
              minHeight: 280,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            {imgStatus === 'loading' && (
              <div
                data-testid="ai-image-preview-loading"
                className="gm-skeleton"
                style={{
                  width: '100%',
                  minHeight: 256,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  borderRadius: 6,
                  border: '1px solid var(--gm-line-1)',
                }}
              >
                <Spin size="large" />
                <span style={{ fontSize: 13, color: 'var(--gm-fg-2)' }}>正在加载原图…</span>
              </div>
            )}
            {imgStatus === 'error' && (
              <div
                data-testid="ai-image-preview-error"
                style={{
                  width: '100%',
                  minHeight: 256,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  color: 'var(--gm-fg-2)',
                }}
              >
                <span>原图加载失败，请检查网络或稍后重试</span>
                <Button
                  size="small"
                  onClick={() => {
                    setImgStatus('loading');
                    setRetryKey((k) => k + 1);
                  }}
                >
                  重新加载
                </Button>
              </div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              key={`${asset.id}-${retryKey}`}
              src={resolveMediaUrl(asset.url)}
              alt={target.job.orderNo}
              onLoad={() => setImgStatus('loaded')}
              onError={() => setImgStatus('error')}
              style={{
                maxWidth: '100%',
                maxHeight: 460,
                borderRadius: 4,
                display: imgStatus === 'loaded' ? 'block' : 'none',
              }}
            />
          </div>
          <div className="gm-num" style={{ marginTop: 10, fontSize: 13, color: 'var(--gm-fg-2)' }}>
            尺寸：{asset.width} × {asset.height}px · 大小：
            {Math.max(1, Math.round(asset.bytes / 1024))} KB · 文章引用次数：
            {asset.usedCount} 次
          </div>
        </div>
      )}
    </Modal>
  );
}
