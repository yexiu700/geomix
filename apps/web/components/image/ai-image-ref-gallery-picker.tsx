'use client';

import type { MediaAssetRecord, MediaCategoryRecord } from '@geomix/shared';
import { Alert, Button, Spin, Tag } from 'antd';
import { resolveMediaUrl } from '../../lib/gallery';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import { resolveGalleryAssetLabel } from './ai-image-helpers';

export type AiImageRefGalleryPickerProps = {
  /** 当前分类筛选（空串为全部分类） */
  categoryId: string;
  mediaCategories: MediaCategoryRecord[];
  /** 已按分类过滤后的可选图片 */
  assets: MediaAssetRecord[];
  selectedId: string;
  selectedAsset: MediaAssetRecord | null;
  loading: boolean;
  loadError: string | null;
  validationError: string | null;
  onCategoryChange: (categoryId: string) => void;
  /** 选中图片；传空串表示取消选中 */
  onSelect: (assetId: string) => void;
};

/** 「从图库选择」参考图卡片选择器：纯展示，分类懒加载与草稿更新由创建弹窗负责。 */
export function AiImageRefGalleryPicker({
  categoryId,
  mediaCategories,
  assets,
  selectedId,
  selectedAsset,
  loading,
  loadError,
  validationError,
  onCategoryChange,
  onSelect,
}: AiImageRefGalleryPickerProps) {
  return (
    <div
      data-testid="ai-image-ref-gallery-picker"
      style={{
        marginTop: 8,
        padding: 10,
        borderRadius: 8,
        border: validationError ? '1px solid var(--gm-danger)' : '1px solid var(--gm-line-1)',
        background: 'var(--gm-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <select
          aria-label="按图库分类筛选"
          style={{ ...COMPACT_SELECT_STYLE, minWidth: 180 }}
          value={categoryId}
          onChange={(e) => onCategoryChange(e.target.value)}
        >
          <option value="">全部分类</option>
          {mediaCategories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}（{cat.assetCount} 张）
            </option>
          ))}
        </select>

        {selectedAsset ? (
          <div
            data-testid="ai-image-ref-gallery-selected"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: 'var(--gm-fg-1)',
            }}
          >
            <Tag color="green" style={{ margin: 0 }}>
              已选：{resolveGalleryAssetLabel(selectedAsset)}（{selectedAsset.width}×
              {selectedAsset.height}）
            </Tag>
            <Button size="small" type="link" onClick={() => onSelect('')}>
              取消选中
            </Button>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
            点击下方图片卡片选择一张参考图
          </span>
        )}
      </div>

      {validationError && (
        <Alert
          type="error"
          showIcon
          data-testid="ai-image-ref-gallery-error"
          message={validationError}
        />
      )}

      {loadError && <Alert type="warning" showIcon message={loadError} />}

      {loading ? (
        <div
          style={{
            padding: '24px 0',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
            color: 'var(--gm-fg-2)',
            fontSize: 13,
          }}
        >
          <Spin size="small" />
          <span>正在加载图库图片…</span>
        </div>
      ) : assets.length === 0 ? (
        <div
          data-testid="ai-image-ref-gallery-empty"
          style={{
            padding: '18px 12px',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--gm-fg-3)',
          }}
        >
          当前分类下暂无可选图库图片，请切换其他分类或使用「上传参考图片」
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="选择图库参考图"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(126px, 1fr))',
            gap: 8,
            maxHeight: 248,
            overflowY: 'auto',
            paddingRight: 2,
          }}
        >
          {assets.map((asset) => {
            const isSelected = selectedId === asset.id;
            const label = resolveGalleryAssetLabel(asset);
            return (
              <button
                key={asset.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`${label}${asset.categoryName ? `（${asset.categoryName}）` : ''} ${asset.width}×${asset.height}`}
                onClick={() => onSelect(asset.id)}
                style={{
                  position: 'relative',
                  padding: 6,
                  borderRadius: 6,
                  border: isSelected
                    ? '2px solid var(--gm-phosphor)'
                    : '1px solid var(--gm-line-2)',
                  background: isSelected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-elevated)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: 74,
                    borderRadius: 4,
                    overflow: 'hidden',
                    background: 'var(--gm-bg-base)',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resolveMediaUrl(asset.thumbUrl || asset.url)}
                    alt={label}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                  {isSelected && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        background: 'var(--gm-phosphor)',
                        color: '#0b0e12',
                      }}
                    >
                      已选
                    </span>
                  )}
                </div>
                <div
                  title={label}
                  style={{
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 500,
                    color: 'var(--gm-fg-1)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {label}
                </div>
                <div
                  className="gm-num"
                  style={{
                    fontSize: 11,
                    color: 'var(--gm-fg-3)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {asset.categoryName ? `${asset.categoryName} · ` : ''}
                  {asset.width}×{asset.height}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
