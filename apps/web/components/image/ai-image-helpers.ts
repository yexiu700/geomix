import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_PROMPT_MAX,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_STYLES,
  safeMediaDisplayName,
  type AiImageCount,
  type AiImageCreateInput,
  type AiImageGeneratedAsset,
  type AiImageJobItem,
  type AiImageRatio,
  type MediaAssetRecord,
  type TaskStatusName,
} from '@geomix/shared';
import { resolveMediaUrl } from '../../lib/gallery';
import { formatShanghaiDateTime } from '../../lib/ux-foundation';

export type RefMode = 'none' | 'upload' | 'gallery';

export type CreateDraft = {
  prompt: string;
  ratio: AiImageRatio;
  style: string;
  count: AiImageCount;
  refMode: RefMode;
  refAssetId: string;
  refImageBase64: string;
  refImageFilename: string;
  saveCategoryId: string;
  optKeywordId: string;
  optKbId: string;
};

export type ColumnKey =
  | 'orderNo'
  | 'thumb'
  | 'prompt'
  | 'styleRatio'
  | 'count'
  | 'category'
  | 'status'
  | 'points'
  | 'createdAt'
  | 'actions';

export const ALL_COLUMN_KEYS: { key: ColumnKey; label: string }[] = [
  { key: 'orderNo', label: '订单编号' },
  { key: 'thumb', label: '缩略图' },
  { key: 'prompt', label: '提示词' },
  { key: 'styleRatio', label: '风格/比例' },
  { key: 'count', label: '张数' },
  { key: 'category', label: '归属分类' },
  { key: 'status', label: '状态' },
  { key: 'points', label: '消耗点数' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'actions', label: '操作' },
];

export const FILTER_STATUSES: TaskStatusName[] = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
];

export function buildInitialDraft(): CreateDraft {
  return {
    prompt: '',
    ratio: AI_IMAGE_DEFAULT_RATIO,
    style: AI_IMAGE_STYLES[0],
    count: 1,
    refMode: 'none',
    refAssetId: '',
    refImageBase64: '',
    refImageFilename: '',
    saveCategoryId: '',
    optKeywordId: '',
    optKbId: '',
  };
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

export function resolveGalleryAssetLabel(asset: MediaAssetRecord): string {
  const explicit = asset.displayName?.trim();
  if (explicit) return explicit;
  return safeMediaDisplayName({
    id: asset.id,
    origin: asset.origin,
    originalName: asset.originalName,
  });
}

/** 排队中 / 生成中的订单：禁止删除与勾选，并驱动列表轮询。 */
export function isJobInProgress(job: Pick<AiImageJobItem, 'status'>): boolean {
  return job.status === 'QUEUED' || job.status === 'RUNNING';
}

export function isJobSavedToGallery(job: AiImageJobItem): boolean {
  return Boolean(
    job.saveCategoryId ||
    job.saveCategoryName ||
    job.assets.some((asset) => Boolean(asset.categoryId || asset.categoryName)),
  );
}

export function statusTagColor(status: TaskStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'COMPLETED':
      return 'success';
    case 'PARTIAL':
      return 'warning';
    case 'FAILED':
      return 'error';
    case 'QUEUED':
      return 'blue';
    default:
      return 'default';
  }
}

export type CreateDraftValidation = {
  /** 参考图区域内联错误（null 表示参考图校验通过） */
  refError: string | null;
  /** 弹窗底部汇总错误（null 表示可提交） */
  modalError: string | null;
};

/** 创建草稿校验：参考图缺失优先，并与提示词长度错误合并为一条底部提示。 */
export function validateCreateDraft(draft: CreateDraft): CreateDraftValidation {
  const trimmedPrompt = draft.prompt.trim();
  const promptTooShort = trimmedPrompt.length < AI_IMAGE_PROMPT_MIN;
  const promptTooLong = trimmedPrompt.length > AI_IMAGE_PROMPT_MAX;

  if (draft.refMode === 'gallery' && !draft.refAssetId) {
    const refMsg = '请从图库中选择一张参考图片';
    if (promptTooShort) {
      return {
        refError: refMsg,
        modalError: `${refMsg}，且画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字`,
      };
    }
    if (promptTooLong) {
      return {
        refError: refMsg,
        modalError: `${refMsg}，且画面提示词不能超过 ${AI_IMAGE_PROMPT_MAX} 个字`,
      };
    }
    return { refError: refMsg, modalError: refMsg };
  }

  if (draft.refMode === 'upload' && !draft.refImageBase64) {
    const uploadMsg = '请选择需要上传的本地参考图片，或切换为「不使用参考图」';
    if (promptTooShort) {
      return {
        refError: uploadMsg,
        modalError: `画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字；${uploadMsg}`,
      };
    }
    if (promptTooLong) {
      return {
        refError: uploadMsg,
        modalError: `画面提示词不能超过 ${AI_IMAGE_PROMPT_MAX} 个字；${uploadMsg}`,
      };
    }
    return { refError: uploadMsg, modalError: uploadMsg };
  }

  if (promptTooShort) {
    return { refError: null, modalError: `画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字` };
  }
  if (promptTooLong) {
    return { refError: null, modalError: `画面提示词不能超过 ${AI_IMAGE_PROMPT_MAX} 个字` };
  }
  return { refError: null, modalError: null };
}

/** 按参考图模式裁剪无关字段，生成提交负载。 */
export function buildCreatePayload(draft: CreateDraft): AiImageCreateInput {
  return {
    prompt: draft.prompt.trim(),
    ratio: draft.ratio,
    style: draft.style || undefined,
    count: draft.count,
    refAssetId: draft.refMode === 'gallery' ? draft.refAssetId || undefined : undefined,
    refImageBase64: draft.refMode === 'upload' ? draft.refImageBase64 || undefined : undefined,
    refImageFilename: draft.refMode === 'upload' ? draft.refImageFilename || undefined : undefined,
    saveCategoryId: draft.saveCategoryId || undefined,
  };
}

export function triggerAssetDownload(
  asset: AiImageGeneratedAsset,
  orderNo: string,
  idx: number,
): void {
  if (typeof window === 'undefined') return;
  const href = resolveMediaUrl(asset.url);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${orderNo}-${idx + 1}.jpg`;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}
