'use client';

import {
  AI_IMAGE_COUNTS,
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_PROMPT_MAX,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_RATIOS,
  AI_IMAGE_RATIO_LABELS,
  AI_IMAGE_REF_MAX_BYTES,
  AI_IMAGE_STYLES,
  formatAiImageSubmitLabel,
  quoteAiImagePoints,
  type AiImageJobItem,
  type MediaAssetRecord,
} from '@geomix/shared';
import { Alert, Button, Input, Tag } from 'antd';
import type { CSSProperties } from 'react';
import { useRef, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import type { AiImageFormOptions, AiImageGateway } from '../../lib/ai-images';
import { COMPACT_SELECT_STYLE, NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { AiImageRefGalleryPicker } from './ai-image-ref-gallery-picker';
import {
  buildCreatePayload,
  buildInitialDraft,
  readFileAsDataUrl,
  validateCreateDraft,
  type CreateDraft,
} from './ai-image-helpers';

type ModalState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

const REF_MODE_OPTIONS = [
  { value: 'none', label: '不使用参考图' },
  { value: 'upload', label: '上传参考图片' },
  { value: 'gallery', label: '从图库选择' },
] as const;

const REQUIRED_MARK = <span style={{ color: 'var(--gm-danger)' }}>*</span>;

/** 比例 / 张数 / 参考图模式三组单选按钮的统一选中态样式。 */
function choiceStyle(selected: boolean, extra: CSSProperties): CSSProperties {
  return {
    borderRadius: 6,
    border: selected ? '1px solid var(--gm-phosphor-a40)' : '1px solid var(--gm-line-2)',
    background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-elevated)',
    color: selected ? 'var(--gm-fg-1)' : 'var(--gm-fg-2)',
    fontWeight: selected ? 600 : 400,
    fontSize: 13,
    cursor: 'pointer',
    ...extra,
  };
}

export type AiImageCreateModalProps = {
  readOnly: boolean;
  unitPoints: number;
  formOptions: AiImageFormOptions | null;
  gateway: Pick<AiImageGateway, 'create' | 'optimizePrompt' | 'listGalleryAssets'>;
  /** 从最小化恢复时刷新表单选项（图库 / 主词 / 知识库） */
  onRefreshOptions: () => void;
  onClose: () => void;
  onCreated: (job: AiImageJobItem) => Promise<void> | void;
};

/**
 * 添加 AI 生图任务弹窗：自持草稿、参考图三模式（不使用 / 上传 / 图库懒加载）、
 * 免费提示词优化与提交校验；父容器按需挂载，卸载即重置。
 */
export function AiImageCreateModal({
  readOnly,
  unitPoints,
  formOptions,
  gateway,
  onRefreshOptions,
  onClose,
  onCreated,
}: AiImageCreateModalProps) {
  const [modalState, setModalState] = useState<ModalState>(() => {
    const initial = buildInitialDraft();
    return { initial, draft: initial, minimized: false, maximized: false };
  });
  const [modalError, setModalError] = useState<string | null>(null);
  const [refValidationError, setRefValidationError] = useState<string | null>(null);
  const [refGalleryCategoryId, setRefGalleryCategoryId] = useState<string>('');
  const [refGalleryAssets, setRefGalleryAssets] = useState<MediaAssetRecord[] | null>(null);
  const [refGalleryLoading, setRefGalleryLoading] = useState(false);
  const [refGalleryLoadError, setRefGalleryLoadError] = useState<string | null>(null);
  const refGalleryRequestSeq = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  const { draft } = modalState;

  const updateDraft = (patch: Partial<CreateDraft>) =>
    setModalState((prev) => ({ ...prev, draft: { ...prev.draft, ...patch } }));

  const handleRefCategoryChange = async (nextCategoryId: string) => {
    setRefGalleryCategoryId(nextCategoryId);
    setRefGalleryLoadError(null);
    if (!gateway.listGalleryAssets) {
      return;
    }
    const seq = ++refGalleryRequestSeq.current;
    setRefGalleryLoading(true);
    try {
      const assets = await gateway.listGalleryAssets(nextCategoryId || undefined);
      if (refGalleryRequestSeq.current === seq) {
        setRefGalleryAssets(assets);
      }
    } catch (err) {
      if (refGalleryRequestSeq.current === seq) {
        setRefGalleryLoadError(err instanceof Error ? err.message : '加载图库图片失败');
      }
    } finally {
      if (refGalleryRequestSeq.current === seq) {
        setRefGalleryLoading(false);
      }
    }
  };

  const handleOptimizePrompt = async () => {
    const basePrompt = draft.prompt.trim();
    if (basePrompt.length < 2) {
      setModalError('请至少输入 2 个字的基础画面描述后再点击 AI 优化提示词');
      return;
    }
    setModalError(null);
    setOptimizing(true);
    try {
      const res = await gateway.optimizePrompt({
        prompt: basePrompt,
        style: draft.style || undefined,
        keywordId: draft.optKeywordId || undefined,
        kbId: draft.optKbId || undefined,
      });
      updateDraft({ prompt: res.optimizedPrompt });
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '提示词优化失败');
    } finally {
      setOptimizing(false);
    }
  };

  const handleUploadRefFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > AI_IMAGE_REF_MAX_BYTES) {
      setModalError('参考图片大小不能超过 10MB');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setModalError(null);
      updateDraft({
        refMode: 'upload',
        refImageBase64: dataUrl,
        refImageFilename: file.name,
        refAssetId: '',
      });
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '读取参考图片失败');
    }
  };

  const handleSubmitCreate = async () => {
    const validation = validateCreateDraft(draft);
    setRefValidationError(validation.refError);
    if (validation.modalError) {
      setModalError(validation.modalError);
      return;
    }

    setModalError(null);
    setSubmitting(true);
    try {
      const created = await gateway.create(buildCreatePayload(draft));
      await onCreated(created);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '提交生图任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const draftQuote = quoteAiImagePoints(draft.count, unitPoints);
  const submitButtonLabel = formatAiImageSubmitLabel(draft.count, unitPoints);

  const allGalleryAssets = refGalleryAssets ?? formOptions?.galleryAssets ?? [];
  const filteredGalleryAssets = refGalleryCategoryId
    ? allGalleryAssets.filter((asset) => asset.categoryId === refGalleryCategoryId)
    : allGalleryAssets;
  const selectedRefAsset = draft.refAssetId
    ? ([...(refGalleryAssets ?? []), ...(formOptions?.galleryAssets ?? [])].find(
        (asset) => asset.id === draft.refAssetId,
      ) ?? null)
    : null;

  return (
    <CrudModal
      open
      title="添加 AI 生图任务"
      minimized={modalState.minimized}
      maximized={modalState.maximized}
      confirmLoading={submitting}
      error={modalError}
      ok={
        <Button
          type="primary"
          loading={submitting}
          disabled={readOnly}
          onClick={() => void handleSubmitCreate()}
        >
          {submitButtonLabel}
        </Button>
      }
      onClose={() => {
        setRefValidationError(null);
        onClose();
      }}
      onReset={() => {
        setModalError(null);
        setRefValidationError(null);
        setRefGalleryCategoryId('');
        setModalState((prev) => ({ ...prev, draft: prev.initial }));
      }}
      onMinimize={() => setModalState((prev) => ({ ...prev, minimized: true }))}
      onRestore={() => {
        setModalState((prev) => ({ ...prev, minimized: false }));
        onRefreshOptions();
      }}
      onMaximize={() => setModalState((prev) => ({ ...prev, maximized: !prev.maximized }))}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Upfront Price & Billing Transparency Banner */}
        <div
          data-testid="ai-image-price-banner"
          style={{
            padding: '12px 14px',
            borderRadius: 8,
            background: 'var(--gm-bg-elevated)',
            border: '1px solid rgba(111,168,255,0.32)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <div className="gm-num" style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
              预计消耗说明：单价 {draftQuote.unitPoints} 点数/张 × 生成 {draftQuote.count} 张 ＝
              合计预冻结 {draftQuote.totalPoints} 点数
            </div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 2 }}>
              提交后先按标价冻结对应点数，按实际生成成功张数结算；生成失败或存储空间不足时自动退还点数（免费体验期仅记录点数明细，不扣减可用点数）。
            </div>
          </div>
          <Tag color="blue" style={{ fontSize: 13, padding: '3px 10px' }}>
            预冻 {draftQuote.totalPoints} 点
          </Tag>
        </div>

        {/* 1. Prompt + Free AI Optimize */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            <span style={{ fontWeight: 500 }}>
              画面提示词（{AI_IMAGE_PROMPT_MIN}–{AI_IMAGE_PROMPT_MAX} 字） {REQUIRED_MARK}
            </span>
            <Button size="small" loading={optimizing} onClick={() => void handleOptimizePrompt()}>
              AI 优化提示词（免费）
            </Button>
          </div>
          <Input.TextArea
            aria-label="画面提示词"
            rows={4}
            maxLength={AI_IMAGE_PROMPT_MAX}
            showCount
            placeholder="请描述期望生成的商业配图主体、场景光线与质感，例如：简约现代办公桌面摆放极简笔记本电脑与产品实物陈列，柔和自然窗光，清晰质感构图"
            value={draft.prompt}
            onChange={(e) => updateDraft({ prompt: e.target.value })}
          />

          {/* Optional Keyword / KB context for Free Prompt Optimization */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
            <select
              aria-label="扩写关联训练主词"
              style={COMPACT_SELECT_STYLE}
              value={draft.optKeywordId}
              onChange={(e) => updateDraft({ optKeywordId: e.target.value })}
            >
              <option value="">扩写辅助：不带入训练主词（可选）</option>
              {(formOptions?.keywords ?? []).map((kw) => (
                <option key={kw.id} value={kw.id}>
                  主词：{kw.main}
                </option>
              ))}
            </select>
            <select
              aria-label="扩写关联知识库"
              style={COMPACT_SELECT_STYLE}
              value={draft.optKbId}
              onChange={(e) => updateDraft({ optKbId: e.target.value })}
            >
              <option value="">扩写辅助：不带入知识库产品服务（可选）</option>
              {(formOptions?.knowledgeBases ?? []).map((kb) => (
                <option key={kb.id} value={kb.id}>
                  知识库：{kb.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 2. Aspect Ratio (9 options, default 16:9) */}
        <div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            图片比例（默认 {AI_IMAGE_DEFAULT_RATIO}） {REQUIRED_MARK}
          </div>
          <div
            role="radiogroup"
            aria-label="图片比例"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 8,
            }}
          >
            {AI_IMAGE_RATIOS.map((ratio) => {
              const selected = draft.ratio === ratio;
              return (
                <button
                  key={ratio}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => updateDraft({ ratio })}
                  style={choiceStyle(selected, { padding: '8px 10px', textAlign: 'left' })}
                >
                  {AI_IMAGE_RATIO_LABELS[ratio]}
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Style & Count */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(180px, 1fr) auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>画面风格</div>
            <select
              aria-label="画面风格"
              style={NATIVE_SELECT_STYLE}
              value={draft.style}
              onChange={(e) => updateDraft({ style: e.target.value })}
            >
              {AI_IMAGE_STYLES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>生成张数</div>
            <div
              role="radiogroup"
              aria-label="生成张数"
              style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}
            >
              {AI_IMAGE_COUNTS.map((cnt) => {
                const selected = draft.count === cnt;
                return (
                  <button
                    key={cnt}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => updateDraft({ count: cnt })}
                    style={choiceStyle(selected, {
                      height: 32,
                      padding: '0 12px',
                      whiteSpace: 'nowrap',
                    })}
                  >
                    {cnt} 张（{cnt * unitPoints} 点）
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 4. Reference Image (Upload or Pick from Gallery) */}
        <div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>参考图片（可选）</div>
          <div
            role="radiogroup"
            aria-label="参考图片模式"
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            {REF_MODE_OPTIONS.map((opt) => {
              const selected = draft.refMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setRefValidationError(null);
                    setModalError(null);
                    updateDraft({ refMode: opt.value });
                  }}
                  style={choiceStyle(selected, { height: 32, padding: '0 14px' })}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {draft.refMode === 'upload' && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                borderRadius: 6,
                border: '1px dashed var(--gm-line-1)',
                background: 'var(--gm-bg-surface)',
              }}
            >
              <input
                aria-label="上传参考图片文件"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  setRefValidationError(null);
                  void handleUploadRefFile(e.target.files?.[0]);
                }}
              />
              <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
                支持 JPG / PNG / WebP，单张不超过 10MB
                {draft.refImageFilename ? ` · 已选择：${draft.refImageFilename}` : ''}
              </div>
              {refValidationError && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginTop: 8 }}
                  message={refValidationError}
                />
              )}
            </div>
          )}

          {draft.refMode === 'gallery' && (
            <AiImageRefGalleryPicker
              categoryId={refGalleryCategoryId}
              mediaCategories={formOptions?.mediaCategories ?? []}
              assets={filteredGalleryAssets}
              selectedId={draft.refAssetId}
              selectedAsset={selectedRefAsset}
              loading={refGalleryLoading}
              loadError={refGalleryLoadError}
              validationError={refValidationError}
              onCategoryChange={(id) => void handleRefCategoryChange(id)}
              onSelect={(assetId) => {
                if (assetId) {
                  setRefValidationError(null);
                  setModalError(null);
                }
                updateDraft({ refAssetId: assetId });
              }}
            />
          )}
        </div>

        {/* 5. Save directly to Gallery Category (Optional, default none) */}
        <div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            保存到企业画像图库（可选，默认不保存）
          </div>
          <select
            aria-label="保存到企业画像图库"
            style={NATIVE_SELECT_STYLE}
            value={draft.saveCategoryId}
            onChange={(e) => updateDraft({ saveCategoryId: e.target.value })}
          >
            <option value="">暂不保存（生成后可在列表随时点「存入图库」）</option>
            {(formOptions?.mediaCategories ?? []).map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}（现有 {cat.assetCount} 张）
              </option>
            ))}
          </select>
        </div>
      </div>
    </CrudModal>
  );
}
