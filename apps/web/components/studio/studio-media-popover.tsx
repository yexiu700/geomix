/* eslint-disable @next/next/no-img-element */
'use client';

import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  AI_IMAGE_PROMPT_MAX,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_RATIOS,
  AI_IMAGE_RATIO_LABELS,
  AI_IMAGE_STYLES,
  sanitizeEntityTitleSegment,
  type AiImageRatio,
  type BrandMediaAssetRecord,
  type GeoMarket,
} from '@geomix/shared';
import { Alert, Button, Input, Popover, Tabs } from 'antd';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { generateBrandAiImage, resolveMediaUrl } from '../../lib/brands';
import { GatewayApiError } from '../../lib/envelope';
import { createStudioIdempotencyKey } from '../../lib/studio';
import { SignalSkeleton } from '../geo/primitives';

export type StudioMediaPopoverProps = {
  brandId: string;
  market: GeoMarket;
  hasArticle: boolean;
  mediaItems: readonly BrandMediaAssetRecord[];
  mediaLoading: boolean;
  readOnly: boolean;
  streaming: boolean;
  onRefreshMedia: () => Promise<void>;
  onInsertMedia: (asset: BrandMediaAssetRecord) => Promise<void>;
  onAiImageGenerated: (asset: BrandMediaAssetRecord) => Promise<void>;
  onAiImageError?: () => void;
};

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export function StudioMediaPopover({
  brandId,
  market,
  hasArticle,
  mediaItems,
  mediaLoading,
  readOnly,
  streaming,
  onRefreshMedia,
  onInsertMedia,
  onAiImageGenerated,
  onAiImageError,
}: StudioMediaPopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'library' | 'ai-gen'>('library');
  const [insertingId, setInsertingId] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [ratio, setRatio] = useState<AiImageRatio>(AI_IMAGE_DEFAULT_RATIO);
  const [style, setStyle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const aiCtrlRef = useRef<AbortController | null>(null);
  const insertingRef = useRef(false);
  const generatingRef = useRef(false);
  const insertSeqRef = useRef(0);

  useEffect(() => {
    aiCtrlRef.current?.abort();
    aiCtrlRef.current = null;
    insertSeqRef.current += 1;
    insertingRef.current = false;
    generatingRef.current = false;
    setOpen(false);
    setAiError(null);
    setGenerating(false);
    setInsertingId(null);
  }, [brandId, market]);

  useEffect(() => {
    if (!hasArticle) {
      aiCtrlRef.current?.abort();
      aiCtrlRef.current = null;
      insertSeqRef.current += 1;
      insertingRef.current = false;
      generatingRef.current = false;
      setOpen(false);
      setGenerating(false);
      setInsertingId(null);
    }
  }, [hasArticle]);

  useEffect(() => {
    if (streaming) {
      setOpen(false);
    }
  }, [streaming]);

  useEffect(
    () => () => {
      aiCtrlRef.current?.abort();
      aiCtrlRef.current = null;
      insertSeqRef.current += 1;
      insertingRef.current = false;
      generatingRef.current = false;
    },
    [],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && (readOnly || streaming || !hasArticle)) return;
    setOpen(nextOpen);
    if (nextOpen) {
      setAiError(null);
      if (mediaItems.length === 0 && !mediaLoading) {
        void onRefreshMedia();
      }
    }
  };

  const handleSelectPhoto = async (asset: BrandMediaAssetRecord) => {
    if (readOnly || !hasArticle || insertingRef.current || generatingRef.current) return;
    insertingRef.current = true;
    const seq = ++insertSeqRef.current;
    setInsertingId(asset.id);
    try {
      await onInsertMedia(asset);
      if (insertSeqRef.current === seq) {
        setOpen(false);
      }
    } catch {
      // Parent already shows feedback toast; keep popover open for retry
    } finally {
      if (insertSeqRef.current === seq) {
        insertingRef.current = false;
        setInsertingId(null);
      }
    }
  };

  const handleGenerateAiImage = async () => {
    const cleanPrompt = prompt.trim();
    if (
      readOnly ||
      !hasArticle ||
      generatingRef.current ||
      insertingRef.current ||
      cleanPrompt.length < AI_IMAGE_PROMPT_MIN
    ) {
      return;
    }

    generatingRef.current = true;
    aiCtrlRef.current?.abort();
    const ctrl = new AbortController();
    aiCtrlRef.current = ctrl;

    setGenerating(true);
    setAiError(null);

    try {
      const idemKey = createStudioIdempotencyKey('img');
      const asset = await generateBrandAiImage(
        brandId,
        {
          prompt: cleanPrompt,
          ratio,
          ...(style ? { style } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
        },
        idemKey,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      await onAiImageGenerated(asset);
      if (ctrl.signal.aborted) return;
      setPrompt('');
      setTitle('');
      setAiError(null);
      setOpen(false);
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err)) return;
      const msg =
        err instanceof GatewayApiError && err.message
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : 'AI 配图生成失败，已自动退还本次点数';
      setAiError(msg);
      onAiImageError?.();
    } finally {
      if (aiCtrlRef.current === ctrl) {
        aiCtrlRef.current = null;
        generatingRef.current = false;
      }
      if (!ctrl.signal.aborted) {
        setGenerating(false);
      }
    }
  };

  const popoverContent = open ? (
    <div className="gm-studio-media-popover" data-testid="studio-media-popover">
      <Tabs
        size="small"
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key as 'library' | 'ai-gen');
          setAiError(null);
        }}
        items={[
          {
            key: 'library',
            label: '从品牌实拍图插入（免费）',
            children: (
              <div className="gm-studio-stack gm-studio-stack--md">
                <div className="gm-studio-media-head">
                  <span>双市场共享 · 点击即插入正文（0 点）</span>
                  <Button
                    size="small"
                    type="link"
                    className="gm-studio-link-compact"
                    loading={mediaLoading}
                    onClick={() => void onRefreshMedia()}
                  >
                    刷新
                  </Button>
                </div>
                {mediaLoading && mediaItems.length === 0 ? (
                  <SignalSkeleton variant="row" rows={2} />
                ) : mediaItems.length === 0 ? (
                  <div className="gm-studio-media-empty">
                    暂无品牌图片，可在「品牌资产」上传产品实拍图，或切至右侧 AI 生成配图。
                  </div>
                ) : (
                  <div className="gm-studio-media-grid">
                    {mediaItems.map((asset) => {
                      const displayTitle = sanitizeEntityTitleSegment(asset.title, '产品图片');
                      const thumbSrc = resolveMediaUrl(asset.thumbUrl || asset.url);
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          className="gm-studio-media-item"
                          data-testid={`studio-media-item-${asset.id}`}
                          disabled={readOnly || Boolean(insertingId)}
                          onClick={() => void handleSelectPhoto(asset)}
                        >
                          <img
                            src={thumbSrc}
                            alt={displayTitle}
                            loading="lazy"
                            className="gm-studio-media-thumb"
                          />
                          <span className="gm-studio-media-item-title" title={displayTitle}>
                            {displayTitle}
                          </span>
                          <span className="gm-studio-media-item-meta">
                            {asset.origin === 'AI_INLINE_GEN' ? 'AI 配图' : '实拍'} · 已用{' '}
                            {asset.usedCount} 次
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'ai-gen',
            label: `AI 一键生成配图（${AI_IMAGE_DEFAULT_UNIT_POINTS} 点/张）`,
            children: (
              <div className="gm-studio-media-ai-form">
                <div className="gm-studio-text-muted">
                  按需可选 · {AI_IMAGE_DEFAULT_UNIT_POINTS} 点/张，生成失败自动全额退点
                </div>
                {aiError ? (
                  <Alert
                    type="error"
                    showIcon
                    message={aiError}
                    data-testid="studio-ai-image-error"
                  />
                ) : null}
                <Input.TextArea
                  rows={3}
                  maxLength={AI_IMAGE_PROMPT_MAX}
                  aria-label="AI 配图提示词"
                  data-testid="studio-ai-image-prompt"
                  placeholder={`描述需要生成的配图场景、产品细节或原理示意图（至少 ${AI_IMAGE_PROMPT_MIN} 字）`}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={readOnly || generating}
                />
                <Input
                  size="small"
                  maxLength={120}
                  aria-label="AI 配图说明"
                  data-testid="studio-ai-image-title"
                  placeholder="图片说明 / Alt 文本（选填）"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={readOnly || generating}
                />
                <div className="gm-studio-media-ai-row">
                  <select
                    className="gm-select"
                    aria-label="配图比例"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value as AiImageRatio)}
                    disabled={readOnly || generating}
                  >
                    {AI_IMAGE_RATIOS.map((r) => (
                      <option key={r} value={r}>
                        {AI_IMAGE_RATIO_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <select
                    className="gm-select"
                    aria-label="配图风格"
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    disabled={readOnly || generating}
                  >
                    <option value="">默认风格</option>
                    {AI_IMAGE_STYLES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="primary"
                  block
                  loading={generating}
                  disabled={readOnly || generating || prompt.trim().length < AI_IMAGE_PROMPT_MIN}
                  data-testid="studio-ai-image-gen-btn"
                  onClick={() => void handleGenerateAiImage()}
                >
                  AI 生成并插入（{AI_IMAGE_DEFAULT_UNIT_POINTS} 点）
                </Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  ) : (
    <span />
  );

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={handleOpenChange}
      destroyOnHidden
      content={popoverContent}
    >
      <Button
        size="small"
        data-testid="studio-insert-media-btn"
        disabled={readOnly || streaming || !hasArticle}
      >
        插入图片
      </Button>
    </Popover>
  );
}
