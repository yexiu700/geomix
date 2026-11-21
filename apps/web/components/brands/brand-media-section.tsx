/* eslint-disable @next/next/no-img-element */
'use client';

import {
  BRAND_MEDIA_UPLOAD_MAX_FILES,
  formatGalleryBytes,
  formatShanghaiDateTime,
  validateClientUploadFile,
  type BrandMediaAssetRecord,
  type BrandRecord,
  type MediaStorageSummary,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Tag } from 'antd';
import { useRef, useState, type DragEvent } from 'react';
import {
  deleteBrandMedia,
  resolveMediaUrl,
  updateBrandMediaAlt,
  uploadBrandMedia,
} from '../../lib/brands';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalPill, SignalSkeleton } from '../geo/primitives';
import { defaultAltFromFilename } from './brand-form-helpers';

export type BrandMediaSectionProps = {
  brand: BrandRecord;
  items: readonly BrandMediaAssetRecord[];
  storage: MediaStorageSummary | null;
  loading: boolean;
  error: string | null;
  readOnly: boolean;
  onRetry: () => void;
  onMediaChanged: (
    nextItems: BrandMediaAssetRecord[],
    nextStorage: MediaStorageSummary | null,
  ) => void;
};

export function BrandMediaSection({
  brand,
  items,
  storage,
  loading,
  error,
  readOnly,
  onRetry,
  onMediaChanged,
}: BrandMediaSectionProps) {
  const feedback = useUxFeedback();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingAlt, setSavingAlt] = useState(false);

  const [previewAsset, setPreviewAsset] = useState<BrandMediaAssetRecord | null>(null);

  const handleFilesSelected = async (rawFiles: FileList | File[] | null) => {
    if (!rawFiles || rawFiles.length === 0 || readOnly || uploading) return;
    setUploadNotice(null);

    const fileList = Array.from(rawFiles);
    if (fileList.length > BRAND_MEDIA_UPLOAD_MAX_FILES) {
      setUploadNotice(`单次最多上传 ${BRAND_MEDIA_UPLOAD_MAX_FILES} 张图片，已截断超出部分`);
    }
    const candidates = fileList.slice(0, BRAND_MEDIA_UPLOAD_MAX_FILES);

    const validFiles: File[] = [];
    const rejected: string[] = [];

    for (const file of candidates) {
      const checked = validateClientUploadFile({
        name: file.name,
        size: file.size,
        type: file.type,
      });
      if (!checked.ok) {
        rejected.push(`${file.name}（${checked.message}）`);
      } else {
        validFiles.push(file);
      }
    }

    if (rejected.length > 0) {
      setUploadNotice(`以下文件未通过校验：${rejected.join('；')}`);
    }
    if (validFiles.length === 0) return;

    setUploading(true);
    let currentItems = [...items];
    let currentStorage = storage;
    let uploadedCount = 0;

    try {
      for (const file of validFiles) {
        try {
          const res = await uploadBrandMedia(
            brand.id,
            { file, title: defaultAltFromFilename(file.name) },
            { storage: window.sessionStorage },
          );
          const added = res.items.length > 0 ? res.items : [res.item];
          currentItems = [...added, ...currentItems];
          currentStorage = res.storage ?? currentStorage;
          uploadedCount += added.length;
          onMediaChanged(currentItems, currentStorage);
          for (const warn of res.warnings ?? []) {
            feedback.notifyWarning(warn);
          }
        } catch (reason: unknown) {
          const msg = reason instanceof Error && reason.message ? reason.message : '上传失败';
          rejected.push(`${file.name}（${msg}）`);
        }
      }

      if (uploadedCount > 0) {
        feedback.notifySuccess(`已上传 ${uploadedCount} 张产品实拍图`);
      }
      if (rejected.length > 0) {
        setUploadNotice(`部分图片未上传成功：${rejected.join('；')}`);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (readOnly || uploading) return;
    void handleFilesSelected(event.dataTransfer.files);
  };

  const handleSaveAlt = async (asset: BrandMediaAssetRecord) => {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      feedback.notifyWarning('请填写图片说明');
      return;
    }
    setSavingAlt(true);
    try {
      const updated = await updateBrandMediaAlt(
        brand.id,
        asset.id,
        { title: trimmed },
        { storage: window.sessionStorage },
      );
      const nextItems = items.map((item) => (item.id === asset.id ? updated : item));
      onMediaChanged(nextItems, storage);
      setEditingId(null);
      feedback.notifySuccess('已更新图片说明');
    } catch (reason: unknown) {
      feedback.notifyError(
        reason instanceof Error && reason.message ? reason.message : '更新图片说明失败',
      );
    } finally {
      setSavingAlt(false);
    }
  };

  const handleDeleteAsset = (asset: BrandMediaAssetRecord) => {
    feedback.confirm({
      title: `确认删除图片「${asset.title}」？`,
      content: '删除后将同步释放存储空间，且无法恢复。',
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await deleteBrandMedia(brand.id, asset.id, {
            storage: window.sessionStorage,
          });
          const nextItems = items.filter((item) => item.id !== asset.id);
          onMediaChanged(nextItems, res.storage ?? storage);
          if (previewAsset?.id === asset.id) {
            setPreviewAsset(null);
          }
          feedback.notifySuccess('已删除产品图片');
        } catch (reason: unknown) {
          feedback.notifyError(
            reason instanceof Error && reason.message ? reason.message : '删除产品图片失败',
          );
        }
      },
    });
  };

  return (
    <section id="brand-section-media" className="gm-brand-section" aria-label="真实产品实拍图库">
      <div className="gm-brand-section-head">
        <div>
          <div className="gm-brand-section-title-row">
            <h2 className="gm-brand-section-title">3. 真实产品实拍图库</h2>
            <Tag>双市场共享（CN / GLOBAL）</Tag>
            {storage ? (
              <SignalPill tone="neutral">
                已用 {storage.usedText} / {storage.limitText}
              </SignalPill>
            ) : null}
          </div>
          <p className="gm-brand-section-desc">
            单层平铺管理真实产品实拍图与图片说明（Alt 文本），在 GEO
            写作台编辑器内可随时免费按需插入。
          </p>
        </div>
      </div>

      {/* Flat Drag-and-Drop Upload Zone */}
      <div
        data-testid="brand-media-dropzone"
        className={[
          'gm-brand-dropzone',
          dragOver ? 'is-dragover' : '',
          readOnly ? 'is-disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => {
          event.preventDefault();
          if (!readOnly && !uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-label="上传产品实拍图"
          disabled={readOnly || uploading}
          style={{ display: 'none' }}
          onChange={(event) => void handleFilesSelected(event.target.files)}
        />
        <div className="gm-brand-dropzone-copy">
          <strong>将真实产品实拍图拖到此处，或点击选择图片</strong>
          <span>
            支持 JPG / PNG / WebP，单张 ≤ 100MB，单次最多 {BRAND_MEDIA_UPLOAD_MAX_FILES}{' '}
            张；自动压缩去隐私信息并生成缩略图
          </span>
        </div>
        <Button
          type="primary"
          ghost
          disabled={readOnly}
          loading={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          选择图片上传
        </Button>
      </div>

      {uploadNotice ? (
        <Alert type="warning" showIcon message={uploadNotice} style={{ marginTop: 10 }} />
      ) : null}

      {/* Photo Grid */}
      <div style={{ marginTop: 14 }}>
        {loading ? (
          <div className="gm-brand-media-grid" aria-busy="true">
            <SignalSkeleton variant="block" height={200} />
            <SignalSkeleton variant="block" height={200} />
            <SignalSkeleton variant="block" height={200} />
          </div>
        ) : error ? (
          <SignalError message={error} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <SignalEmpty
            title="还没有产品实拍图"
            description="拖入真实产品实拍图并维护图片说明，在 GEO 写作台编辑器内按需免费插入。"
          />
        ) : (
          <div className="gm-brand-media-grid">
            {items.map((asset) => {
              const isEditing = editingId === asset.id;
              return (
                <div key={asset.id} className="gm-brand-media-card">
                  <button
                    type="button"
                    className="gm-brand-media-thumb-btn"
                    aria-label={`预览图片 ${asset.title}`}
                    onClick={() => setPreviewAsset(asset)}
                  >
                    <img
                      src={resolveMediaUrl(asset.thumbUrl || asset.url)}
                      alt={asset.title}
                      loading="lazy"
                      className="gm-brand-media-thumb"
                    />
                  </button>

                  <div className="gm-brand-media-body">
                    {isEditing ? (
                      <div className="gm-brand-media-alt-edit">
                        <Input
                          size="small"
                          aria-label="图片说明"
                          maxLength={120}
                          value={editingTitle}
                          disabled={savingAlt}
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onPressEnter={() => void handleSaveAlt(asset)}
                        />
                        <div className="gm-brand-media-alt-actions">
                          <Button
                            type="primary"
                            size="small"
                            autoInsertSpace={false}
                            loading={savingAlt}
                            onClick={() => void handleSaveAlt(asset)}
                          >
                            保存
                          </Button>
                          <Button
                            size="small"
                            autoInsertSpace={false}
                            disabled={savingAlt}
                            onClick={() => setEditingId(null)}
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="gm-brand-media-title-row">
                        <span className="gm-brand-media-title" title={asset.title}>
                          {asset.title}
                        </span>
                        <Button
                          type="link"
                          size="small"
                          disabled={readOnly}
                          onClick={() => {
                            setEditingId(asset.id);
                            setEditingTitle(asset.title);
                          }}
                        >
                          编辑说明
                        </Button>
                      </div>
                    )}

                    <div className="gm-brand-media-meta">
                      <span>
                        {formatGalleryBytes(asset.bytes)} · {asset.width}×{asset.height}
                      </span>
                      <Button
                        type="text"
                        size="small"
                        danger
                        autoInsertSpace={false}
                        disabled={readOnly}
                        onClick={() => handleDeleteAsset(asset)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Preview Modal */}
      <Modal
        open={previewAsset !== null}
        title={previewAsset?.title ?? '图片预览'}
        width={720}
        onCancel={() => setPreviewAsset(null)}
        footer={[
          <Button key="close" onClick={() => setPreviewAsset(null)}>
            关闭
          </Button>,
        ]}
      >
        {previewAsset ? (
          <div className="gm-brand-media-preview">
            <img
              src={resolveMediaUrl(previewAsset.url)}
              alt={previewAsset.title}
              className="gm-brand-media-preview-img"
            />
            <div className="gm-brand-media-preview-meta">
              <Tag>{previewAsset.origin === 'AI_INLINE_GEN' ? 'AI 配图' : '实拍上传'}</Tag>
              <span>
                尺寸：{previewAsset.width} × {previewAsset.height}
              </span>
              <span>大小：{formatGalleryBytes(previewAsset.bytes)}</span>
              <span>已引用 {previewAsset.usedCount} 次</span>
              <span>上传于 {formatShanghaiDateTime(previewAsset.createdAt)}</span>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
