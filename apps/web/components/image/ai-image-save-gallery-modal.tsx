'use client';

import type { AiImageJobItem, MediaCategoryRecord } from '@geomix/shared';
import { Alert, Modal } from 'antd';
import { useEffect, useState } from 'react';
import type { AiImageGateway } from '../../lib/ai-images';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { isJobSavedToGallery } from './ai-image-helpers';

export type AiImageSaveGalleryResult = {
  savedCount: number;
  categoryName: string;
  /** 提交前订单是否已存入过图库（决定「存入」/「更换至」文案） */
  wasSaved: boolean;
};

export type AiImageSaveGalleryModalProps = {
  /** 目标订单；null 时弹窗关闭 */
  job: AiImageJobItem | null;
  /** 父容器在表单选项加载后给出的默认分组（订单已归属分组优先） */
  defaultCategoryId: string;
  mediaCategories: MediaCategoryRecord[];
  saveToGallery: AiImageGateway['saveToGallery'];
  onClose: () => void;
  onSaved: (result: AiImageSaveGalleryResult, job: AiImageJobItem) => Promise<void> | void;
};

/** 存入 / 更换企业画像图库分组弹窗：自持分组选择、保存中与错误态。 */
export function AiImageSaveGalleryModal({
  job,
  defaultCategoryId,
  mediaCategories,
  saveToGallery,
  onClose,
  onSaved,
}: AiImageSaveGalleryModalProps) {
  // 用户手动选择的分组；未选择时跟随父容器给出的默认分组（同一次渲染内生效，无额外 effect 延迟）
  const [pickedCategoryId, setPickedCategoryId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPickedCategoryId(null);
    setError(null);
  }, [job]);

  const categoryId = pickedCategoryId ?? defaultCategoryId;

  const wasSaved = job ? isJobSavedToGallery(job) : false;

  const handleConfirm = async () => {
    if (!job) return;
    if (!categoryId) {
      setError('请先选择目标企业画像图库分组');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await saveToGallery(job.id, { categoryId });
      await onSaved({ savedCount: res.savedCount, categoryName: res.categoryName, wasSaved }, job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '存入图库失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(job)}
      title={wasSaved ? '更换企业画像图库分组' : '存入企业画像图库'}
      keyboard
      transitionName=""
      maskTransitionName=""
      confirmLoading={saving}
      okText={wasSaved ? '确认更换' : '确认存入'}
      cancelText="取消"
      onCancel={() => {
        if (!saving) onClose();
      }}
      onOk={() => void handleConfirm()}
    >
      {job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Alert
            type="info"
            showIcon
            message={
              wasSaved
                ? `订单 ${job.orderNo} 当前已存入「${job.saveCategoryName ?? '企业画像图库'}」，确认后将迁移至新选择的图库分组（不重复占用存储空间配额）。`
                : `将订单 ${job.orderNo} 生成的 ${job.assets.length} 张图片归入所选图库分组（不重复占用存储空间配额）。`
            }
          />
          {error && <Alert type="error" showIcon message={error} />}
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>目标图库分组</div>
            <select
              aria-label="目标图库分组"
              style={NATIVE_SELECT_STYLE}
              value={categoryId}
              onChange={(e) => setPickedCategoryId(e.target.value)}
            >
              <option value="">请选择企业画像图库分组</option>
              {mediaCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}（现有 {cat.assetCount} 张）
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}
