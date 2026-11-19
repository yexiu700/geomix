import {
  isArticleStatus,
  type ArticleArchiveFormat,
  type ArticleManageQuery,
  type ArticleSortName,
  type ArticleStatusName,
  type CrudOrder,
} from '@geomix/shared';
import type { ArticleFormOptions } from '../../lib/articles';
import { formatShanghaiDateTime } from '../../lib/ux-foundation';

export const ARTICLES_ROUTE = '/writing/articles';

export const ARCHIVE_FORMAT_LABELS: Record<ArticleArchiveFormat, string> = {
  md: 'Markdown (.md)',
  html: 'HTML (.html)',
  docx: 'Word (.docx)',
};

export const SHORT_VIDEO_WORD_LIMIT = 1000;

export const RED_TYPOGRAPHY_TIP =
  '排版提示：抖音、小红书类文字建议控制在1000字之内，会自动清除展示排版；建议采用二级/三级小标题与短段落结构排版，请勿粘贴外部追踪脚本、诱导外链或联系方式水印，保存时系统将自动清洗不安全标签。';

export type FilterDraft = {
  categoryId: string;
  taskId: string;
  keyword: string;
  sendCount: string;
  videoCount: string;
  status: string;
  createdFrom: string;
  createdTo: string;
  sort: ArticleSortName;
  order: CrudOrder;
};

export type ArticleEditorDraft = {
  title: string;
  categoryId: string;
  mediaCategoryId: string;
  coverUrl: string | null;
  status: ArticleStatusName;
  contentHtml: string;
};

export type EditorModalState = {
  mode: 'create' | 'edit';
  articleId?: string;
  initial: ArticleEditorDraft;
  draft: ArticleEditorDraft;
  minimized: boolean;
  maximized: boolean;
  editorTab: 'visual' | 'preview' | 'source';
};

export const EMPTY_FILTER_DRAFT: FilterDraft = {
  categoryId: '',
  taskId: '',
  keyword: '',
  sendCount: '',
  videoCount: '',
  status: '',
  createdFrom: '',
  createdTo: '',
  sort: 'createdAt',
  order: 'desc',
};

/**
 * 「查询 → 跳转新 href」时的筛选交接：仅在本模块内持有私有 Map，
 * 组件通过 stash / take / clear 三个函数访问，take 为一次性消费。
 */
const pendingFilterHandoffs = new Map<string, FilterDraft>();

export function stashFilterHandoff(href: string, draft: FilterDraft): void {
  pendingFilterHandoffs.set(href, draft);
}

export function takeFilterHandoff(href: string): FilterDraft | null {
  const handoff = pendingFilterHandoffs.get(href) ?? null;
  if (handoff) pendingFilterHandoffs.delete(href);
  return handoff;
}

export function clearFilterHandoffs(): void {
  pendingFilterHandoffs.clear();
}

export function buildArticlesRouteHref(categoryId?: string, taskId?: string): string {
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', categoryId);
  if (taskId) params.set('taskId', taskId);
  const qs = params.toString();
  return qs ? `${ARTICLES_ROUTE}?${qs}` : ARTICLES_ROUTE;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

export function statusTagColor(status: ArticleStatusName): string {
  switch (status) {
    case 'NORMAL':
      return 'success';
    case 'PENDING':
      return 'gold';
    case 'DISABLED':
    default:
      return 'default';
  }
}

export function parseOptionalIntInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

export function buildDefaultCreateDraft(
  options: ArticleFormOptions | null,
  preferredCategoryId?: string,
): ArticleEditorDraft {
  const defaultCategory =
    (preferredCategoryId && options?.categories.find((c) => c.id === preferredCategoryId)?.id) ||
    '';

  return {
    title: '',
    categoryId: defaultCategory,
    mediaCategoryId: '',
    coverUrl: null,
    status: 'NORMAL',
    contentHtml: '<p></p>',
  };
}

/** URL 筛选 + 一次性交接 → 首屏筛选草稿。 */
export function buildInitialFilterDraft(
  urlFilter: { categoryId?: string; taskId?: string },
  handoff: FilterDraft | null,
): FilterDraft {
  return {
    ...EMPTY_FILTER_DRAFT,
    ...(handoff ?? {}),
    categoryId: urlFilter.categoryId ?? '',
    taskId: urlFilter.taskId ?? '',
  };
}

/** 将筛选草稿中除分页外的条件映射为列表查询字段（与原内联逻辑等价）。 */
export function filterDraftToQueryFields(
  draft: FilterDraft,
): Omit<ArticleManageQuery, 'page' | 'pageSize'> {
  return {
    categoryId: draft.categoryId || undefined,
    taskId: draft.taskId || undefined,
    keyword: draft.keyword.trim(),
    sendCount: parseOptionalIntInput(draft.sendCount),
    videoCount: parseOptionalIntInput(draft.videoCount),
    status: isArticleStatus(draft.status) ? draft.status : undefined,
    createdFrom: draft.createdFrom || undefined,
    createdTo: draft.createdTo || undefined,
    sort: draft.sort,
    order: draft.order,
  };
}

/** 校验数字类筛选项，返回首个错误提示；全部合法时返回 null。 */
export function validateFilterDraft(draft: FilterDraft): string | null {
  if (draft.sendCount.trim() && parseOptionalIntInput(draft.sendCount) === undefined) {
    return '发送次数筛选需填写非负整数';
  }
  if (draft.videoCount.trim() && parseOptionalIntInput(draft.videoCount) === undefined) {
    return '转视频次数筛选需填写非负整数';
  }
  return null;
}
