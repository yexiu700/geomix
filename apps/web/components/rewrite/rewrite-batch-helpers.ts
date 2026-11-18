import {
  CRUD_PAGE_SIZES,
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_MAX_COUNT_MAX,
  REWRITE_BATCH_MAX_COUNT_MIN,
  REWRITE_BATCH_NAME_MAX,
  REWRITE_BATCH_SOURCE_LABELS,
  REWRITE_BATCH_SOURCE_TYPES,
  REWRITE_BATCH_STATUS_LABELS,
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  REWRITE_DEFAULT_UNIT_POINTS,
  TASK_STATUSES,
  buildDefaultBatchCategoryName,
  looksLikeUrlNotKeyword,
  parseBatchLinkList,
  type ArticleStatusName,
  type ItemStatusName,
  type MediaCategoryRecord,
  type ParsedBatchLinkList,
  type RewriteBatchCreateInput,
  type RewriteBatchDetailResponse,
  type RewriteBatchItem,
  type RewriteBatchListQuery,
  type RewriteBatchListResponse,
  type RewriteBatchSourceType,
  type RewriteResultStatusName,
  type TaskStatusName,
} from '@geomix/shared';
import type { CSSProperties } from 'react';
import {
  httpRewriteBatchGateway,
  type RewriteBatchFormOptions,
  type RewriteBatchGateway,
} from '../../lib/rewrite-batches';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { UX_TERMS, formatShanghaiDateTime } from '../../lib/ux-foundation';

export const DEFAULT_BATCH_MAX_COUNT = 1;
export const NO_IMAGE_GALLERY_VALUE = '__NONE__';
export const PAGE_SIZE_OPTIONS = CRUD_PAGE_SIZES.map(String);
export const BATCH_CELL_ELLIPSIS = { showTitle: false } as const;

export const BATCH_STATUS_FILTER_OPTIONS = TASK_STATUSES.map((value) => ({
  value,
  label: REWRITE_BATCH_STATUS_LABELS[value] ?? value,
}));

export const BATCH_SOURCE_FILTER_OPTIONS = REWRITE_BATCH_SOURCE_TYPES.map((value) => ({
  value,
  label: REWRITE_BATCH_SOURCE_LABELS[value],
}));

export function parseStatusFilter(value: string): TaskStatusName | undefined {
  return (value || undefined) as TaskStatusName | undefined;
}

export function parseSourceFilter(value: string): RewriteBatchSourceType | undefined {
  return (value || undefined) as RewriteBatchSourceType | undefined;
}

export const BATCH_STYLES = {
  screenStack: { display: 'flex', flexDirection: 'column', gap: 16 },
  surfaceHeader: {
    padding: '14px 18px',
    background: 'var(--gm-bg-surface)',
    border: '1px solid var(--gm-line-1)',
    borderRadius: 8,
  },
  headerSubtitle: { marginTop: 4, fontSize: 13, color: 'var(--gm-fg-2)' },
  filterBar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    padding: '12px 16px',
    background: 'var(--gm-bg-surface)',
    border: '1px solid var(--gm-line-1)',
    borderRadius: 8,
  },
  tableCard: {
    background: 'var(--gm-bg-surface)',
    border: '1px solid var(--gm-line-1)',
    borderRadius: 8,
    padding: 12,
  },
  nameCell: { display: 'grid', gap: 2, minWidth: 165, whiteSpace: 'normal' },
  subtleMetaRow: {
    fontSize: 12,
    color: 'var(--gm-fg-3)',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  keywordCell: { display: 'grid', gap: 4, minWidth: 145, whiteSpace: 'normal' },
  statusCell: { display: 'grid', gap: 4, minWidth: 170, whiteSpace: 'normal' },
  doneSummary: { fontSize: 12, color: 'var(--gm-fg-3)' },
  createdAt: { fontSize: 13, color: 'var(--gm-fg-2)' },
  categoryLink: {
    padding: 0,
    height: 'auto',
    fontSize: 12,
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'inline-block',
  },
  compactTag: { margin: 0, whiteSpace: 'nowrap' },
  modalPricingBanner: {
    padding: '12px 14px',
    borderRadius: 8,
    background: 'var(--gm-bg-elevated)',
    border: '1px solid rgba(111,168,255,0.32)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  fieldLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  inlineNavLink: { padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' },
} satisfies Record<string, CSSProperties>;

export type RewriteBatchScreenProps = {
  title: string;
  tabId?: string;
  active?: boolean;
  readOnly?: boolean;
  pollIntervalMs?: number;
  storage?: SessionStorageLike;
  gateway?: RewriteBatchGateway;
  onDispatch?: (action: ShellAction) => void;
};

export type BatchListState = {
  items: RewriteBatchItem[];
  total: number;
  unitPoints: number;
  remoteSearchEnabled: boolean;
};

export type DrawerState = {
  open: boolean;
  loading: boolean;
  detail: RewriteBatchDetailResponse | null;
};

export type CreateSession = {
  id: number;
  initialOptions: RewriteBatchFormOptions | null;
};

export const INITIAL_BATCH_LIST_STATE: BatchListState = {
  items: [],
  total: 0,
  unitPoints: REWRITE_DEFAULT_UNIT_POINTS,
  remoteSearchEnabled: false,
};

export const INITIAL_DRAWER_STATE: DrawerState = {
  open: false,
  loading: false,
  detail: null,
};

export type CreateDraft = {
  name: string;
  maxCount: number;
  sourceType: RewriteBatchSourceType;
  keyword: string;
  linksText: string;
  mediaCategoryId: string;
  noImage: boolean;
  templateId: string;
  categoryId: string;
  autoCategoryName: string;
  resultStatus: RewriteResultStatusName;
  brand: string;
};

export type DraftLinkListPreview = ParsedBatchLinkList & {
  firstInvalidWarning: string | null;
};

export type ValidateCreateDraftContext = {
  remoteSearchEnabled: boolean;
  mediaCategories?: ReadonlyArray<Pick<MediaCategoryRecord, 'id' | 'assetCount'>>;
};

export type ValidateCreateDraftResult =
  | {
      ok: true;
      issues: [];
      errorMessage: null;
      payload: RewriteBatchCreateInput;
    }
  | {
      ok: false;
      issues: string[];
      errorMessage: string;
      payload: null;
    };

export type RewriteBatchControlAction = 'pause' | 'resume' | 'cancel';

export type BatchRowActionDescriptor =
  | {
      key: string;
      label: string;
      kind: 'control';
      action: RewriteBatchControlAction;
      danger?: boolean;
      primaryGhost?: boolean;
    }
  | {
      key: 'delete';
      label: string;
      kind: 'delete';
      danger: true;
      primaryGhost?: false;
    };

export function getBatchNoteStyle(status: TaskStatusName): CSSProperties {
  return {
    fontSize: 12,
    color: status === 'FAILED' ? 'var(--gm-danger)' : 'var(--gm-fg-2)',
    lineHeight: 1.4,
  };
}

export function getBatchCategoryHref(categoryId: string): string {
  return `/writing/articles?categoryId=${encodeURIComponent(categoryId)}`;
}

export function formatBatchKeywordSummary(
  row: Pick<RewriteBatchItem, 'keyword' | 'candidateCount'>,
): string {
  return row.keyword || `链接清单（${row.candidateCount} 条候选）`;
}

export function getBatchRowActions(status: TaskStatusName): BatchRowActionDescriptor[] {
  if (isActiveBatchStatus(status)) {
    return [
      { key: 'pause', label: '暂停', kind: 'control', action: 'pause' },
      { key: 'cancel', label: '终止退点', kind: 'control', action: 'cancel', danger: true },
    ];
  }
  if (status === 'PAUSED') {
    return [
      { key: 'resume', label: '继续', kind: 'control', action: 'resume', primaryGhost: true },
      { key: 'cancel', label: '终止退点', kind: 'control', action: 'cancel', danger: true },
    ];
  }
  if (isTerminalBatchStatus(status)) {
    return [{ key: 'delete', label: '删除', kind: 'delete', danger: true }];
  }
  return [];
}

export function toBatchListState(res: RewriteBatchListResponse): BatchListState {
  return {
    items: res.items,
    total: res.total,
    unitPoints: res.unitPoints || REWRITE_DEFAULT_UNIT_POINTS,
    remoteSearchEnabled: res.remoteSearchEnabled,
  };
}

export function mergeOptionsIntoListState(
  prev: BatchListState,
  opts: Pick<RewriteBatchFormOptions, 'unitPoints' | 'remoteSearchEnabled'>,
): BatchListState {
  return {
    ...prev,
    unitPoints: opts.unitPoints || prev.unitPoints,
    remoteSearchEnabled: opts.remoteSearchEnabled,
  };
}

export function shouldCloseDrawerOnDelete(
  drawer: DrawerState,
  deletedIds: readonly string[],
): boolean {
  return Boolean(drawer.detail && deletedIds.includes(drawer.detail.batch.id));
}

export function formatCreatedBatchFeedback(created: RewriteBatchDetailResponse): string {
  return `批量复刻任务「${created.batch.name}」已入队（预冻 ${created.batch.reservedPoints} 点数，按实际成功篇数结算并自动退差额）`;
}

export function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function deriveBatchPollingState(
  items: readonly RewriteBatchItem[],
  drawer: DrawerState,
  pollIntervalMs: number,
): {
  drawerBatchId: string | null;
  drawerBatchActive: boolean;
  hasActiveBatch: boolean;
  effectiveInterval: number;
} {
  const drawerBatchId = drawer.open && drawer.detail ? drawer.detail.batch.id : null;
  const drawerBatchActive =
    drawer.open && drawer.detail !== null && isActiveBatchStatus(drawer.detail.batch.status);
  const hasActiveBatch = items.some((b) => isActiveBatchStatus(b.status)) || drawerBatchActive;
  const effectiveInterval = computeEffectivePollInterval(pollIntervalMs, drawerBatchActive);
  return { drawerBatchId, drawerBatchActive, hasActiveBatch, effectiveInterval };
}

export function buildInitialDraft(
  options: Pick<RewriteBatchFormOptions, 'mediaCategories'> | null | undefined,
): CreateDraft {
  const hasUsableGallery = (options?.mediaCategories ?? []).some((c) => c.assetCount > 0);
  return {
    name: '',
    maxCount: DEFAULT_BATCH_MAX_COUNT,
    sourceType: 'link_list',
    keyword: '',
    linksText: '',
    mediaCategoryId: '',
    noImage: !hasUsableGallery,
    templateId: '',
    categoryId: '',
    autoCategoryName: buildDefaultBatchCategoryName('批量爆文'),
    resultStatus: 'PENDING',
    brand: '',
  };
}

export function applyDraftNameChange(draft: CreateDraft, name: string): CreateDraft {
  return {
    ...draft,
    name,
    autoCategoryName: buildDefaultBatchCategoryName(name),
  };
}

export function computeEstimatedFreezePoints(maxCount: number, unitPoints: number): number {
  const safeCount = Number.isFinite(maxCount) ? Math.max(1, Math.trunc(maxCount) || 1) : 1;
  const safeUnit = unitPoints > 0 ? unitPoints : REWRITE_DEFAULT_UNIT_POINTS;
  return safeCount * safeUnit;
}

export function isCreateDraftDirty(draft: CreateDraft, initial: CreateDraft): boolean {
  return (
    draft.name !== initial.name ||
    draft.maxCount !== initial.maxCount ||
    draft.sourceType !== initial.sourceType ||
    draft.keyword !== initial.keyword ||
    draft.linksText !== initial.linksText ||
    draft.mediaCategoryId !== initial.mediaCategoryId ||
    draft.noImage !== initial.noImage ||
    draft.templateId !== initial.templateId ||
    draft.categoryId !== initial.categoryId ||
    draft.autoCategoryName !== initial.autoCategoryName ||
    draft.resultStatus !== initial.resultStatus ||
    draft.brand !== initial.brand
  );
}

export function previewDraftLinkList(
  draft: Pick<CreateDraft, 'sourceType' | 'linksText'>,
  maxLinks = REWRITE_BATCH_LINK_LIST_MAX,
): DraftLinkListPreview | null {
  if (draft.sourceType !== 'link_list') return null;
  const parsed = parseBatchLinkList(draft.linksText, maxLinks);
  const firstInvalid = parsed.invalidLines[0];
  return {
    ...parsed,
    firstInvalidWarning: firstInvalid ? `第 ${firstInvalid.line} 行：${firstInvalid.reason}` : null,
  };
}

export function hasKeywordUrlWarning(keyword: string): boolean {
  return looksLikeUrlNotKeyword(keyword);
}

export function validateCreateDraft(
  draft: CreateDraft,
  context: ValidateCreateDraftContext,
): ValidateCreateDraftResult {
  const issues: string[] = [];

  if (!draft.name.trim()) {
    issues.push('请填写任务名称');
  } else if (draft.name.trim().length > REWRITE_BATCH_NAME_MAX) {
    issues.push(`任务名称不超过 ${REWRITE_BATCH_NAME_MAX} 个字符`);
  }

  if (
    !Number.isInteger(draft.maxCount) ||
    draft.maxCount < REWRITE_BATCH_MAX_COUNT_MIN ||
    draft.maxCount > REWRITE_BATCH_MAX_COUNT_MAX
  ) {
    issues.push(
      `最大改写量须在 ${REWRITE_BATCH_MAX_COUNT_MIN}–${REWRITE_BATCH_MAX_COUNT_MAX} 篇之间`,
    );
  }

  if (draft.sourceType === 'remote') {
    if (!draft.keyword.trim()) {
      issues.push('关键词全网搜索模式下请填写流量关键词');
    } else if (looksLikeUrlNotKeyword(draft.keyword)) {
      issues.push(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
    } else if (!context.remoteSearchEnabled) {
      issues.push(
        '当前环境未配置第三方搜索源，「关键词全网搜索」暂未开通，请切换至「粘贴公开文章链接清单」',
      );
    }
  } else {
    if (draft.keyword.trim() && looksLikeUrlNotKeyword(draft.keyword)) {
      issues.push(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
    }
    const parsed = parseBatchLinkList(draft.linksText, REWRITE_BATCH_LINK_LIST_MAX);
    if (parsed.nonEmptyCount === 0) {
      issues.push('请至少粘贴 1 条公开文章链接（一行一条）');
    } else if (parsed.invalidLines.length > 0) {
      const first = parsed.invalidLines[0]!;
      issues.push(`第 ${first.line} 行链接不合法：${first.reason}`);
    } else if (parsed.candidates.length === 0) {
      const firstExcl = parsed.excludedLines[0];
      issues.push(
        firstExcl
          ? `全部候选链接均不可用于正文复刻（第 ${firstExcl.line} 行：${firstExcl.reason}）`
          : '没有可用的有效文章链接',
      );
    }
  }

  const selectedMediaCat =
    (context.mediaCategories ?? []).find((cat) => cat.id === draft.mediaCategoryId) ?? null;

  if (!draft.noImage && !draft.mediaCategoryId) {
    issues.push(`请选择文章配图的${UX_TERMS.gallery}分类（或选择「不配图（0 张）」）`);
  } else if (!draft.noImage && selectedMediaCat && selectedMediaCat.assetCount === 0) {
    issues.push(`所选${UX_TERMS.gallery}分类暂无图片，请先上传图片或选择「不配图（0 张）」`);
  }

  if (!draft.templateId) {
    issues.push('请选择爆文改写指令');
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      errorMessage: issues.join('；'),
      payload: null,
    };
  }

  return {
    ok: true,
    issues: [],
    errorMessage: null,
    payload: {
      name: draft.name.trim(),
      maxCount: draft.maxCount,
      sourceType: draft.sourceType,
      keyword: draft.keyword.trim(),
      linksText: draft.sourceType === 'link_list' ? draft.linksText : undefined,
      mediaCategoryId: draft.noImage ? null : draft.mediaCategoryId || null,
      templateId: draft.templateId,
      categoryId: draft.categoryId || null,
      brand: draft.brand.trim() || undefined,
      resultStatus: draft.resultStatus,
    },
  };
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

export function batchStatusTagColor(status: TaskStatusName): string {
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
    case 'SUCCESS':
      return 'success';
    case 'RUNNING':
      return 'processing';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

export function articleStatusTagColor(status: ArticleStatusName): string {
  switch (status) {
    case 'NORMAL':
      return 'green';
    case 'PENDING':
      return 'gold';
    case 'DISABLED':
    default:
      return 'default';
  }
}

export function isActiveBatchStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isControllableBatchStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED';
}

export function isTerminalBatchStatus(status: TaskStatusName): boolean {
  return (
    status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED' || status === 'CANCELLED'
  );
}

export function resolveRewriteBatchGateway(
  injectedGateway?: RewriteBatchGateway,
  storage?: SessionStorageLike,
): RewriteBatchGateway {
  if (injectedGateway) return injectedGateway;
  const browserStorage: SessionStorageLike =
    storage ??
    (typeof window !== 'undefined'
      ? window.sessionStorage
      : {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        });
  return httpRewriteBatchGateway(browserStorage);
}

export function pruneTerminalSelection(
  selectedIds: readonly string[],
  items: readonly RewriteBatchItem[],
): string[] {
  return selectedIds.filter((id) =>
    items.some((item) => item.id === id && isTerminalBatchStatus(item.status)),
  );
}

export function shouldSyncOpenDrawer(
  currentBatch: RewriteBatchItem,
  items: readonly RewriteBatchItem[],
): RewriteBatchItem | null {
  const matched = items.find((item) => item.id === currentBatch.id);
  if (!matched) return null;
  if (
    matched.status !== currentBatch.status ||
    matched.doneCount !== currentBatch.doneCount ||
    matched.settledPoints !== currentBatch.settledPoints ||
    matched.releasedPoints !== currentBatch.releasedPoints ||
    isActiveBatchStatus(matched.status)
  ) {
    return matched;
  }
  return null;
}

export function computeEffectivePollInterval(
  pollIntervalMs: number,
  drawerBatchActive: boolean,
): number {
  if (pollIntervalMs <= 0) return 0;
  return drawerBatchActive ? Math.min(pollIntervalMs, 1_500) : pollIntervalMs;
}

export function normalizeBatchPageSize(nextSize: number): RewriteBatchListQuery['pageSize'] {
  return (
    CRUD_PAGE_SIZES.includes(nextSize as (typeof CRUD_PAGE_SIZES)[number]) ? nextSize : 25
  ) as RewriteBatchListQuery['pageSize'];
}

export async function executeBatchControl(
  gateway: Pick<RewriteBatchGateway, 'pause' | 'resume' | 'cancel'>,
  batch: Pick<RewriteBatchItem, 'id' | 'name'>,
  action: RewriteBatchControlAction,
): Promise<string> {
  if (action === 'pause') {
    await gateway.pause(batch.id);
    return `已暂停任务「${batch.name}」`;
  }
  if (action === 'resume') {
    await gateway.resume(batch.id);
    return `已继续执行任务「${batch.name}」`;
  }
  const updated = await gateway.cancel(batch.id);
  return `已终止任务「${batch.name}」，剩余预冻 ${updated.releasedPoints} 点数已释放回账户`;
}
