'use client';

import {
  AI_TASK_TARGET_MAX,
  AI_TASK_TARGET_MIN,
  PRICING_DEFAULTS,
  UX_TERMS,
  formatAiTaskFreezeSummary,
  formatAiTaskSubmitLabel,
  type AiTaskCreateInput,
  type AiTaskListQuery,
  type AiTaskResultStatus,
  type ItemStatusName,
  type KnowledgeBaseRecord,
  type PromptTemplateRecord,
  type TaskStatusName,
} from '@geomix/shared';
import { useEffect, useState } from 'react';
import { AiTaskApiError, type AiTaskFormOptions } from '../../lib/ai-tasks';
import { formatShanghaiDateTime } from '../../lib/ux-foundation';

export const INITIAL_AI_TASK_QUERY: AiTaskListQuery = {
  page: 1,
  pageSize: 10,
  keyword: '',
  status: undefined,
  sort: 'createdAt',
  order: 'desc',
};

export const AI_TASK_SORT_OPTIONS = [
  { value: 'createdAt', label: '创建时间' },
  { value: 'lastWrittenAt', label: '最新写作' },
  { value: 'name', label: '任务名称' },
];

export type CreateDraft = {
  name: string;
  categoryId: string;
  keywordId: string;
  mediaCategoryId: string;
  imageCount: number;
  kbId: string;
  contentTplId: string;
  titleTplId: string;
  resultStatus: AiTaskResultStatus;
  target: number;
};

export type CreateEditorState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

export type AiTaskComputedQuote = {
  basePoints: number;
  kbAddonPoints: number;
  unitPrice: number;
  totalFrozen: number;
  text: string;
  freezeText: string;
  submitLabel: string;
};

export const GALLERY_REQUIRED_ERRORS = [
  '请选择画像图库',
  '所选画像图库暂无图片，请先上传图片或将文章配图调为 0 张',
] as const;

export function isGalleryRequiredError(error: string | null): boolean {
  return error !== null && (GALLERY_REQUIRED_ERRORS as readonly string[]).includes(error);
}

export function readInitialKeywordId(href?: string): string | undefined {
  if (!href) return undefined;
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return undefined;
  const rawQuery = href.slice(qIndex + 1).split('#')[0] ?? '';
  const params = new URLSearchParams(rawQuery);
  const val = params.get('keywordId')?.trim();
  return val || undefined;
}

export function resolveAiTaskScreenTitle(
  title: string,
  initialKeywordId: string | undefined,
  options: AiTaskFormOptions | null,
): string {
  if (!initialKeywordId) return title;
  const matched = options?.keywords.find((kw) => kw.id === initialKeywordId)?.main;
  return matched ? `AI写作任务 · ${matched}` : title;
}

export function buildCreatedArticlesHref(task: { id: string; categoryId: string }): string {
  return `/writing/articles?categoryId=${encodeURIComponent(task.categoryId)}&taskId=${encodeURIComponent(task.id)}`;
}

export function defaultCreateDraft(
  options: AiTaskFormOptions | null,
  preferredKeywordId?: string,
): CreateDraft {
  const matchedKw =
    preferredKeywordId && options?.keywords.some((kw) => kw.id === preferredKeywordId)
      ? preferredKeywordId
      : '';
  return {
    name: '',
    categoryId: '',
    keywordId: matchedKw,
    mediaCategoryId: '',
    imageCount: 1,
    kbId: '',
    contentTplId: '',
    titleTplId: '',
    resultStatus: 'PENDING',
    target: 1,
  };
}

export function resolveBaseAiWritePoints(options: AiTaskFormOptions | null): number {
  const found = options?.prices.find((p) => p.action === 'ai_write');
  if (found && found.enabled) return found.unitPoints;
  return PRICING_DEFAULTS.find((p) => p.action === 'ai_write')?.unitPoints ?? 10;
}

export function resolveKbAddonPoints(options: AiTaskFormOptions | null): number {
  const found = options?.prices.find((p) => p.action === 'kb_addon');
  if (found && found.enabled) return found.unitPoints;
  return PRICING_DEFAULTS.find((p) => p.action === 'kb_addon')?.unitPoints ?? 5;
}

export function computeAiTaskQuote(
  draft: Pick<CreateDraft, 'target' | 'kbId'> | null | undefined,
  options: AiTaskFormOptions | null,
): AiTaskComputedQuote {
  const basePoints = resolveBaseAiWritePoints(options);
  const kbAddonPoints = resolveKbAddonPoints(options);
  const summary = formatAiTaskFreezeSummary({
    target: draft?.target ?? 10,
    basePoints,
    kbAddonPoints,
    withKnowledgeBase: Boolean(draft?.kbId),
  });
  return {
    basePoints,
    kbAddonPoints,
    unitPrice: summary.unitPrice,
    totalFrozen: summary.totalFrozen,
    text: summary.text,
    freezeText: summary.text,
    submitLabel: formatAiTaskSubmitLabel(summary.unitPrice),
  };
}

export const buildAiTaskQuote = computeAiTaskQuote;

export function filterUsableSystemArticlePrompts(
  options: AiTaskFormOptions | null,
): PromptTemplateRecord[] {
  if (!options) return [];
  return options.articlePrompts.system.filter((tpl) => !tpl.hasManualSlot);
}

export function findSelectedArticleTemplate(
  options: AiTaskFormOptions | null,
  contentTplId: string,
): PromptTemplateRecord | null {
  if (!options || !contentTplId) return null;
  return (
    options.articlePrompts.user.find((tpl) => tpl.id === contentTplId) ??
    options.articlePrompts.system.find((tpl) => tpl.id === contentTplId) ??
    null
  );
}

export function findSelectedKnowledgeBase(
  options: AiTaskFormOptions | null,
  kbId: string,
): KnowledgeBaseRecord | null {
  if (!options || !kbId) return null;
  return options.knowledgeBases.find((kb) => kb.id === kbId) ?? null;
}

export function isManualSlotTemplateBlocked(
  options: AiTaskFormOptions | null,
  contentTplId: string,
): boolean {
  return Boolean(findSelectedArticleTemplate(options, contentTplId)?.hasManualSlot);
}

export function validateCreateDraft(
  draft: CreateDraft,
  options: AiTaskFormOptions | null,
): string[] {
  const trimmedName = draft.name.trim();
  const errors: string[] = [];
  if (!trimmedName) {
    errors.push('请填写任务名称');
  }
  if (!draft.keywordId) {
    errors.push(`请选择${UX_TERMS.mainKeyword}`);
  } else {
    const pickedKw = options?.keywords.find((k) => k.id === draft.keywordId);
    if (pickedKw && pickedKw.questionCount < 1) {
      errors.push(`所选${UX_TERMS.mainKeyword}下暂无写作问题，请先前往「写作标题」添加问题`);
    }
  }
  if (draft.imageCount > 0) {
    if (!draft.mediaCategoryId) {
      errors.push('请选择画像图库');
    } else {
      const pickedGal = options?.mediaCategories.find((g) => g.id === draft.mediaCategoryId);
      if (pickedGal && pickedGal.assetCount < 1) {
        errors.push('所选画像图库暂无图片，请先上传图片或将文章配图调为 0 张');
      }
    }
  }
  const selectedKb = findSelectedKnowledgeBase(options, draft.kbId);
  if (selectedKb && selectedKb.indexStatus === 'INDEXING') {
    errors.push('所选企业知识库正在建立智能检索，请变为「可用」后再提交任务');
  }
  if (isManualSlotTemplateBlocked(options, draft.contentTplId)) {
    errors.push(
      '所选内容创作指令仍含【品牌1】等手工槽位，请先前往「写作指令」填写具体对比品牌后再选用',
    );
  }
  if (
    !Number.isInteger(draft.target) ||
    draft.target < AI_TASK_TARGET_MIN ||
    draft.target > AI_TASK_TARGET_MAX
  ) {
    errors.push(`AI 创作数量需在 ${AI_TASK_TARGET_MIN}–${AI_TASK_TARGET_MAX} 篇之间`);
  }
  return errors;
}

export function buildAiTaskCreatePayload(draft: CreateDraft): AiTaskCreateInput {
  return {
    name: draft.name.trim(),
    categoryId: draft.categoryId || null,
    keywordId: draft.keywordId,
    mediaCategoryId: draft.imageCount === 0 ? null : draft.mediaCategoryId || null,
    imageCount: draft.imageCount,
    kbId: draft.kbId || null,
    contentTplId: draft.contentTplId || null,
    titleTplId: draft.titleTplId || null,
    resultStatus: draft.resultStatus,
    target: draft.target,
  };
}

export function formatTaskTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

export function formatFailSkipSummary(failCount: number, skipCount: number): string | null {
  const parts: string[] = [];
  if (failCount > 0) parts.push(`失败 ${failCount}`);
  if (skipCount > 0) parts.push(`跳过 ${skipCount}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function statusTagColor(status: TaskStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'COMPLETED':
      return 'success';
    case 'PAUSED':
      return 'warning';
    case 'PARTIAL':
      return 'gold';
    case 'FAILED':
      return 'error';
    case 'CANCELLED':
      return 'default';
    case 'QUEUED':
    default:
      return 'blue';
  }
}

export function itemStatusTagColor(status: ItemStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

export function isActiveTaskStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isControllableStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED';
}

export function isTerminalTaskStatus(status: TaskStatusName): boolean {
  return !isControllableStatus(status);
}

export function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof AiTaskApiError) {
    return err.status === 401;
  }
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status?: unknown }).status === 401;
  }
  return false;
}

export function resolveTaskErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useDocumentVisible(): boolean {
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const handleVisibilityChange = () => {
      setPageVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return pageVisible;
}
