import { z } from 'zod';

export const PROMPT_KINDS = ['ARTICLE', 'TITLE', 'REWRITE'] as const;
export type PromptKindName = (typeof PROMPT_KINDS)[number];

export const PROMPT_KIND_LABELS: Record<PromptKindName, string> = {
  ARTICLE: '文章创作',
  TITLE: '标题创作',
  REWRITE: '流量复刻',
};

export const PROMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PROMPT_NAME_MAX = 80 as const;
export const PROMPT_CONTENT_MAX = 8000 as const;

export type PromptPlaceholderMeta = {
  token: string;
  label: string;
  description: string;
};

/**
 * 写作指令支持的变量占位符快捷插入列表（F04a §5）。
 */
export const PROMPT_PLACEHOLDERS: readonly PromptPlaceholderMeta[] = [
  {
    token: '{训练词占位符}',
    label: '训练词占位符',
    description: '自动替换为当前主关键词',
  },
  {
    token: '{转化词占位符}',
    label: '转化词占位符',
    description: '自动替换为公司/品牌转化词',
  },
  {
    token: '{问题}',
    label: '问题',
    description: '自动替换为当前选中的用户咨询问题',
  },
  {
    token: '{标题}',
    label: '标题',
    description: '自动替换为当前文章标题或原标题',
  },
  {
    token: '{公司名称}',
    label: '公司名称',
    description: '自动替换为企业知识库中的公司名称',
  },
];

export const PROMPT_SYSTEM_READONLY_MSG = '系统默认指令为只读，请先克隆后再编辑';
export const PROMPT_MISSING_CONVERSION_WARN =
  '提示：当前文章创作指令未包含 {转化词占位符}，生成文章时可能无法自动带入品牌词（仍可保存）。';
export const PROMPT_TITLE_LOOKS_LIKE_BODY_WARN =
  '提示：标题创作指令只需输出单行标题（建议 15–35 字），请勿填入长篇正文写作要求，否则可能导致标题生成异常。';
export const PROMPT_REWRITE_BRAND_SWAP_WARN =
  '合规提醒：建议参考原文重新创作并自然融入品牌，避免直接把原文推荐结论中的他方品牌硬性替换成我方品牌。';
export const PROMPT_MANUAL_SLOT_WARN =
  '提示：指令包含【品牌N】手工槽位，不会进入「随机生成文章」候选池，仅支持克隆填写具体品牌或手动指定使用。';

const MANUAL_BRAND_SLOT_RE = /【品牌\d*】/;
const TITLE_BODY_HINT_RE =
  /(?:[3-9]\d{2}|[1-9]\d{3,})\s*字|小标题|分段落|每段|全文结构|三级标题|文末问答|FAQ/i;
const REWRITE_BRAND_SWAP_RE =
  /第一个品牌.{0,12}(?:换|改|替)|把原文.{0,16}品牌.{0,10}(?:换|改|替)|替换.{0,8}(?:推荐品牌|友商品牌|他方品牌)/;

/**
 * 检测模板内容是否包含【品牌1】/【品牌2】等手工槽位。
 * 命中时 randomPool 必须置为 false，不得进入「随机生成文章」洗牌池。
 */
export function hasManualBrandSlot(content: string): boolean {
  return MANUAL_BRAND_SLOT_RE.test(content);
}

/**
 * 根据模板内容计算是否允许进入随机池。
 */
export function computePromptRandomPool(content: string): boolean {
  return !hasManualBrandSlot(content);
}

/**
 * 生成前端与接口保存时的非阻断黄色提醒列表。
 */
export function analyzePromptWarnings(kind: PromptKindName, rawContent: string): string[] {
  const content = rawContent.trim();
  if (!content) return [];
  const warnings: string[] = [];

  if (kind === 'ARTICLE' && !content.includes('{转化词占位符}')) {
    warnings.push(PROMPT_MISSING_CONVERSION_WARN);
  }

  if (kind === 'TITLE' && (Array.from(content).length > 300 || TITLE_BODY_HINT_RE.test(content))) {
    warnings.push(PROMPT_TITLE_LOOKS_LIKE_BODY_WARN);
  }

  if (kind === 'REWRITE' && REWRITE_BRAND_SWAP_RE.test(content)) {
    warnings.push(PROMPT_REWRITE_BRAND_SWAP_WARN);
  }

  if (hasManualBrandSlot(content)) {
    warnings.push(PROMPT_MANUAL_SLOT_WARN);
  }

  return warnings;
}

/**
 * 在文本框光标区间插入占位符字符串并返回更新后的文本与新光标位置。
 */
export function insertPlaceholderAtCursor(
  current: string,
  token: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): { nextValue: string; nextCursor: number } {
  const start =
    typeof selectionStart === 'number' && selectionStart >= 0
      ? Math.min(selectionStart, current.length)
      : current.length;
  const end =
    typeof selectionEnd === 'number' && selectionEnd >= start
      ? Math.min(selectionEnd, current.length)
      : start;
  const nextValue = current.slice(0, start) + token + current.slice(end);
  return {
    nextValue,
    nextCursor: start + token.length,
  };
}

export type PromptTemplateRecord = {
  id: string;
  tenantId: string | null;
  isSystem: boolean;
  kind: PromptKindName;
  name: string;
  content: string;
  randomPool: boolean;
  hasManualSlot: boolean;
  sort: number;
  clonedFrom: string | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};

export type PromptListQuery = {
  page: number;
  pageSize: number;
  kind?: PromptKindName;
  q?: string;
};

export type PromptListResponse = {
  items: PromptTemplateRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type PromptOptionsResponse = {
  kind: PromptKindName;
  system: PromptTemplateRecord[];
  user: PromptTemplateRecord[];
};

export const promptWriteSchema = z.object({
  kind: z.enum(PROMPT_KINDS).default('ARTICLE'),
  name: z
    .string({ required_error: '请输入指令名称' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入指令名称')
    .refine((s) => Array.from(s).length <= PROMPT_NAME_MAX, `指令名称不超过 ${PROMPT_NAME_MAX} 字`),
  content: z
    .string({ required_error: '请输入指令内容' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入指令内容')
    .refine(
      (s) => Array.from(s).length <= PROMPT_CONTENT_MAX,
      `指令内容不超过 ${PROMPT_CONTENT_MAX} 字`,
    ),
});

export type PromptWriteInput = z.infer<typeof promptWriteSchema>;

export const promptCloneSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length === 0 || Array.from(s).length <= PROMPT_NAME_MAX, {
      message: `指令名称不超过 ${PROMPT_NAME_MAX} 字`,
    })
    .optional(),
});

export type PromptCloneInput = z.infer<typeof promptCloneSchema>;

export const promptBulkSchema = z.object({
  ids: z
    .array(z.string().regex(PROMPT_ID_PATTERN, '编号不合法'))
    .min(1, '请至少选择一条指令')
    .max(100),
});

export type PromptBulkInput = z.infer<typeof promptBulkSchema>;

export function isPromptKind(val: unknown): val is PromptKindName {
  return val === 'ARTICLE' || val === 'TITLE' || val === 'REWRITE';
}

export function parsePromptListQuery(
  raw: Record<string, string | string[] | undefined>,
): PromptListQuery {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const pageRaw = Number.parseInt(first(raw.page) ?? '1', 10);
  const sizeRaw = Number.parseInt(first(raw.pageSize) ?? '20', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.min(10_000, pageRaw)) : 1;
  const pageSize = Number.isFinite(sizeRaw) ? Math.max(1, Math.min(100, sizeRaw)) : 20;
  const q = first(raw.q)?.trim() || undefined;
  const kindRaw = first(raw.kind)?.trim();
  const kind = isPromptKind(kindRaw) ? kindRaw : undefined;
  return { page, pageSize, kind, q };
}

export function promptExportTable(rows: readonly PromptTemplateRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['指令名称', '创作类型', '创建时间'],
    rows: rows.map((row) => [
      row.name,
      PROMPT_KIND_LABELS[row.kind],
      row.createdAt.slice(0, 19).replace('T', ' '),
    ]),
  };
}
