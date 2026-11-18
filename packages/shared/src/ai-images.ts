import { z } from 'zod';
import { CRUD_PAGE_SIZES, type CrudPageSize } from './crud';
import { formatShanghaiDateTime } from './ux-foundation';
import { TASK_STATUSES, type TaskStatusName } from './writing-tasks';

export const AI_IMAGE_PROMPT_MIN = 5;
export const AI_IMAGE_PROMPT_MAX = 500;
export const AI_IMAGE_DEFAULT_UNIT_POINTS = 5;
export const AI_IMAGE_REF_MAX_BYTES = 10 * 1024 * 1024;

export const AI_IMAGE_RATIOS = [
  '21:9',
  '16:9',
  '4:3',
  '3:2',
  '1:1',
  '2:3',
  '3:4',
  '9:16',
  '9:21',
] as const;
export type AiImageRatio = (typeof AI_IMAGE_RATIOS)[number];

export const AI_IMAGE_DEFAULT_RATIO: AiImageRatio = '16:9';

export const AI_IMAGE_RATIO_LABELS: Record<AiImageRatio, string> = {
  '21:9': '21:9 超宽横幅',
  '16:9': '16:9 宽屏横图',
  '4:3': '4:3 标准横图',
  '3:2': '3:2 摄影横图',
  '1:1': '1:1 方形构图',
  '2:3': '2:3 摄影竖图',
  '3:4': '3:4 标准竖图',
  '9:16': '9:16 竖屏长图',
  '9:21': '9:21 超长竖图',
};

export const AI_IMAGE_STYLES = [
  '写实摄影',
  '产品静物',
  '商务科技',
  '生活场景',
  '扁平插画',
  '3D立体',
] as const;
export type AiImageStyle = (typeof AI_IMAGE_STYLES)[number];

export const AI_IMAGE_COUNTS = [1, 2, 4] as const;
export type AiImageCount = (typeof AI_IMAGE_COUNTS)[number];

export const AI_IMAGE_STATUS_LABELS: Record<TaskStatusName, string> = {
  QUEUED: '等待中',
  RUNNING: '处理中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

const AI_IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isAiImageRatio(value: string): value is AiImageRatio {
  return (AI_IMAGE_RATIOS as readonly string[]).includes(value);
}

export function resolveAiImageRatioDimensions(ratio: AiImageRatio): {
  width: number;
  height: number;
} {
  switch (ratio) {
    case '21:9':
      return { width: 1260, height: 540 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:2':
      return { width: 1080, height: 720 };
    case '1:1':
      return { width: 960, height: 960 };
    case '2:3':
      return { width: 720, height: 1080 };
    case '3:4':
      return { width: 768, height: 1024 };
    case '9:16':
      return { width: 720, height: 1280 };
    case '9:21':
      return { width: 600, height: 1400 };
  }
}

export function quoteAiImagePoints(
  count: number,
  unitPoints = AI_IMAGE_DEFAULT_UNIT_POINTS,
): {
  count: number;
  unitPoints: number;
  totalPoints: number;
} {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 1;
  const safeUnit =
    Number.isInteger(unitPoints) && unitPoints > 0 ? unitPoints : AI_IMAGE_DEFAULT_UNIT_POINTS;
  return {
    count: safeCount,
    unitPoints: safeUnit,
    totalPoints: safeCount * safeUnit,
  };
}

export function formatAiImageSubmitLabel(count: number, unitPoints: number): string {
  const quote = quoteAiImagePoints(count, unitPoints);
  return `生成图片（${quote.unitPoints}点数/张，合计预冻 ${quote.totalPoints} 点）`;
}

const optionalIdField = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return undefined;
    return val;
  })
  .refine((val) => val === undefined || AI_IMAGE_ID_PATTERN.test(val), '编号格式不正确');

export const aiImageCreateSchema = z.object({
  prompt: z
    .string({ required_error: '请填写画面提示词' })
    .trim()
    .min(AI_IMAGE_PROMPT_MIN, `提示词至少 ${AI_IMAGE_PROMPT_MIN} 个字`)
    .max(AI_IMAGE_PROMPT_MAX, `提示词不超过 ${AI_IMAGE_PROMPT_MAX} 个字`),
  ratio: z.enum(AI_IMAGE_RATIOS).default(AI_IMAGE_DEFAULT_RATIO),
  style: z
    .string()
    .trim()
    .max(32, '风格名称过长')
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  count: z
    .number()
    .int()
    .refine((n): n is AiImageCount => (AI_IMAGE_COUNTS as readonly number[]).includes(n), {
      message: '生成张数仅支持 1、2 或 4 张',
    })
    .default(1),
  refAssetId: optionalIdField,
  refImageBase64: z
    .string()
    .max(Math.ceil((AI_IMAGE_REF_MAX_BYTES * 4) / 3) + 256, '参考图片不能超过 10MB')
    .optional(),
  refImageFilename: z.string().trim().max(120).optional(),
  saveCategoryId: optionalIdField,
});

export type AiImageCreateInput = {
  prompt: string;
  ratio?: AiImageRatio;
  style?: string;
  count?: AiImageCount;
  refAssetId?: string | null;
  refImageBase64?: string;
  refImageFilename?: string;
  saveCategoryId?: string | null;
};

export const aiImageOptimizePromptSchema = z.object({
  prompt: z
    .string({ required_error: '请先输入基础画面描述' })
    .trim()
    .min(2, '请至少输入 2 个字的基础描述后再优化')
    .max(AI_IMAGE_PROMPT_MAX, `描述不超过 ${AI_IMAGE_PROMPT_MAX} 个字`),
  style: z.string().trim().max(32).optional(),
  keywordId: optionalIdField,
  kbId: optionalIdField,
});

export type AiImageOptimizePromptInput = {
  prompt: string;
  style?: string;
  keywordId?: string | null;
  kbId?: string | null;
};

export type AiImageOptimizePromptResponse = {
  optimizedPrompt: string;
};

export const aiImageSaveToGallerySchema = z.object({
  categoryId: z
    .string({ required_error: '请选择目标图库分组' })
    .trim()
    .regex(AI_IMAGE_ID_PATTERN, '请选择有效的图库分组'),
  assetIds: z
    .array(z.string().trim().regex(AI_IMAGE_ID_PATTERN, '图片素材编号不合法'))
    .min(1)
    .max(10)
    .optional(),
});

export type AiImageSaveToGalleryInput = z.infer<typeof aiImageSaveToGallerySchema>;

export const aiImageBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().trim().regex(AI_IMAGE_ID_PATTERN, '生图任务编号不合法'))
    .min(1, '请至少选择一条生图记录')
    .max(100, '单次最多删除 100 条记录'),
});

export type AiImageGeneratedAsset = {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  bytes: number;
  usedCount: number;
  createdAt: string;
};

export type AiImageJobItem = {
  id: string;
  orderNo: string;
  prompt: string;
  style: string | null;
  ratio: AiImageRatio;
  count: number;
  successCount: number;
  refAssetId: string | null;
  saveCategoryId: string | null;
  saveCategoryName: string | null;
  status: TaskStatusName;
  error: string | null;
  model: string | null;
  unitPoints: number;
  reservedPoints: number;
  settledPoints: number;
  releasedPoints: number;
  createdAt: string;
  assets: AiImageGeneratedAsset[];
};

export type AiImageJobListQuery = {
  page: number;
  pageSize: CrudPageSize;
  keyword?: string;
  status?: TaskStatusName;
};

export type AiImageJobListResponse = {
  page: number;
  pageSize: number;
  total: number;
  unitPoints: number;
  featureEnabled: boolean;
  items: AiImageJobItem[];
};

export function parseAiImageJobListQuery(raw: Record<string, unknown>): AiImageJobListQuery {
  const rawPage = Number(raw.page ?? 1);
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1;

  const rawPageSize = Number(raw.pageSize ?? 25);
  const pageSize: CrudPageSize = (CRUD_PAGE_SIZES as readonly number[]).includes(rawPageSize)
    ? (rawPageSize as CrudPageSize)
    : 25;

  const keyword =
    typeof raw.keyword === 'string' && raw.keyword.trim().length > 0
      ? raw.keyword.trim().slice(0, 100)
      : undefined;

  const status =
    typeof raw.status === 'string' && (TASK_STATUSES as readonly string[]).includes(raw.status)
      ? (raw.status as TaskStatusName)
      : undefined;

  return { page, pageSize, keyword, status };
}

export function aiImageExportTable(items: readonly AiImageJobItem[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: [
      '订单号',
      '提示词',
      '图片比例',
      '画面风格',
      '生成张数',
      '成功张数',
      '预冻点数',
      '实结点数',
      '已退点数',
      '状态',
      '归属图库分组',
      '备注',
      '创建时间',
    ],
    rows: items.map((item) => [
      item.orderNo,
      item.prompt,
      item.ratio,
      item.style ?? '默认风格',
      String(item.count),
      String(item.successCount),
      String(item.reservedPoints),
      String(item.settledPoints),
      String(item.releasedPoints),
      AI_IMAGE_STATUS_LABELS[item.status] ?? item.status,
      item.saveCategoryName ?? '未存入图库',
      item.error ?? '',
      formatShanghaiDateTime(item.createdAt, { seconds: true }),
    ]),
  };
}
