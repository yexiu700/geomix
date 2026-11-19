import {
  REWRITE_IMAGE_DEFAULT,
  REWRITE_MIN_SOURCE_CHARS,
  countSourceNonWhitespaceChars,
  type RewriteRecordItem,
  type RewriteResultStatusName,
  type RewriteSingleCreateInput,
  type RewriteSingleCreateResponse,
} from '@geomix/shared';
import type { RewriteFormOptions } from '../../lib/rewrites';
import { UX_TERMS } from '../../lib/ux-foundation';

/**
 * 与批量复刻语义完全一致的纯函数 / 常量直接复用 `rewrite-batch-helpers`，避免重复实现：
 * - `NO_IMAGE_GALLERY_VALUE`：「不配图（0 张）」下拉哨兵值
 * - `formatTime`：空值显示「—」，否则按上海时区格式化
 * - `itemStatusTagColor` / `articleStatusTagColor`：复刻条目 / 文章状态标签色
 */
export {
  NO_IMAGE_GALLERY_VALUE,
  articleStatusTagColor,
  formatTime,
  itemStatusTagColor,
} from './rewrite-batch-helpers';

/** 单篇复刻创建草稿（与批量复刻的 CreateDraft 字段不同，保持独立定义）。 */
export type CreateDraft = {
  pastedText: boolean;
  url: string;
  pastedTitle: string;
  pastedContent: string;
  mediaCategoryId: string;
  imageCount: number;
  templateId: string;
  categoryId: string;
  autoCategoryName: string;
  resultStatus: RewriteResultStatusName;
  brand: string;
};

export type ModalState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

/**
 * 构建单篇复刻初始草稿：seed 优先；无可用图库（assetCount > 0）时配图张数降级为 0。
 * 与批量复刻 `buildInitialDraft` 签名与字段不同，故保留独立实现。
 */
export function buildInitialDraft(
  options: RewriteFormOptions | null,
  seed?: Partial<CreateDraft>,
): CreateDraft {
  const hasUsableGallery = (options?.mediaCategories ?? []).some((c) => c.assetCount > 0);
  return {
    pastedText: seed?.pastedText ?? false,
    url: seed?.url ?? '',
    pastedTitle: seed?.pastedTitle ?? '',
    pastedContent: seed?.pastedContent ?? '',
    mediaCategoryId: seed?.mediaCategoryId ?? '',
    imageCount: seed?.imageCount ?? (hasUsableGallery ? REWRITE_IMAGE_DEFAULT : 0),
    templateId: seed?.templateId ?? '',
    categoryId: seed?.categoryId ?? '',
    autoCategoryName: seed?.autoCategoryName ?? '爆文复刻',
    resultStatus: seed?.resultStatus ?? 'PENDING',
    brand: seed?.brand ?? '',
  };
}

/** 提交前校验草稿，返回首个错误文案；通过时返回 null。 */
export function validateCreateDraft(d: CreateDraft): string | null {
  if (!d.pastedText) {
    if (!d.url.trim()) {
      return '请输入公开文章链接（http/https）';
    }
    if (!/^https?:\/\//i.test(d.url.trim())) {
      return '仅支持 http:// 或 https:// 开头的公开文章链接';
    }
  } else {
    const chars = countSourceNonWhitespaceChars(d.pastedContent);
    if (chars < REWRITE_MIN_SOURCE_CHARS) {
      return `粘贴原文有效正文不足 ${REWRITE_MIN_SOURCE_CHARS} 字（当前 ${chars} 字），请补充完整正文`;
    }
  }

  if (d.imageCount > 0 && !d.mediaCategoryId) {
    return `请选择文章配图的${UX_TERMS.gallery}分类`;
  }
  if (!d.templateId) {
    return '请选择爆文改写指令';
  }
  return null;
}

/** 草稿 → 单篇复刻提交载荷（去空白、0 图时清空图库、选定分类时清空自动分类名）。 */
export function toCreateSingleInput(d: CreateDraft): RewriteSingleCreateInput {
  return {
    pastedText: d.pastedText,
    url: d.url.trim(),
    pastedTitle: d.pastedTitle.trim(),
    pastedContent: d.pastedContent,
    mediaCategoryId: d.imageCount > 0 ? d.mediaCategoryId || null : null,
    imageCount: d.imageCount,
    templateId: d.templateId,
    categoryId: d.categoryId || null,
    autoCategoryName: d.categoryId ? '' : d.autoCategoryName.trim(),
    resultStatus: d.resultStatus,
    brand: d.brand.trim(),
  };
}

/** 是否为可做 24h 重复校验的 http(s) 链接。 */
export function isCheckableUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  return Boolean(trimmed) && /^https?:\/\//i.test(trimmed);
}

/** 复刻成功后的横幅提示（含高相似度黄牌与 24h 重复提醒）。 */
export function formatCreatedBanner(result: RewriteSingleCreateResponse): {
  type: 'success' | 'warning';
  text: string;
} {
  return {
    type: result.duplicateRecentWarning || result.record.highSimilarity ? 'warning' : 'success',
    text: [
      `复刻完成：《${result.record.newTitle ?? '未命名'}》已生成至分类「${result.record.categoryName ?? '默认分类'}」（消耗 ${result.settledPoints} 点数，不占用 AI 写作数量配额）。`,
      result.record.highSimilarity
        ? '注意：5-gram 片段相似度偏高，已标记黄牌提醒，建议在文章列表中人工审校后再发布。'
        : '',
      result.duplicateRecentWarning ?? '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** 按文章分类跳转文章列表的路由。 */
export function getArticlesHref(categoryId: string | null): string {
  return categoryId
    ? `/writing/articles?categoryId=${encodeURIComponent(categoryId)}`
    : '/writing/articles';
}

/** 失败行「粘贴原文重试」的草稿预填：沿用源链接/标题/图库/指令/分类，无图库时降级 0 图。 */
export function buildRetrySeed(row: RewriteRecordItem): Partial<CreateDraft> {
  return {
    pastedText: true,
    url: row.url.startsWith('paste://') ? '' : row.url,
    pastedTitle: row.sourceTitle ?? '',
    mediaCategoryId: row.mediaCategoryId ?? '',
    ...(row.mediaCategoryId ? {} : { imageCount: 0 }),
    templateId: row.templateId,
    categoryId: row.categoryId ?? '',
  };
}
