import { z } from 'zod';
import { FAKE_MARK } from './adapters';
import { directionGuidance } from './catalog';
import {
  CRUD_ORDERS,
  CRUD_PAGE_SIZES,
  CrudQueryError,
  type CrudExportFormat,
  type CrudOrder,
  type CrudPageSize,
} from './crud';

export const AI_TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const AI_TASK_NAME_MAX = 60;
export const AI_TASK_TARGET_MIN = 1;
export const AI_TASK_TARGET_MAX = 100;
export const AI_TASK_IMAGE_MIN = 0;
export const AI_TASK_IMAGE_MAX = 5;
export const AI_TASK_MIN_CHARS_DEFAULT = 500;
export const AI_TASK_TITLE_MIN = 15;
export const AI_TASK_TITLE_MAX = 35;
export const AI_TASK_MAX_CONSECUTIVE_FAILS = 3;
export const AI_TASK_TENANT_CONCURRENCY = 2;
export const AI_TASK_AUTO_CATEGORY = 'AUTO';

export const TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatusName = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatusName, string> = {
  QUEUED: '排队中',
  RUNNING: '创作中',
  PAUSED: '已暂停',
  COMPLETED: '创作完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已终止',
};

export const ITEM_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'] as const;
export type ItemStatusName = (typeof ITEM_STATUSES)[number];

export const ITEM_STATUS_LABELS: Record<ItemStatusName, string> = {
  PENDING: '待执行',
  RUNNING: '生成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  SKIPPED: '已跳过',
};

export const AI_TASK_RESULT_STATUSES = ['PENDING', 'NORMAL'] as const;
export type AiTaskResultStatus = (typeof AI_TASK_RESULT_STATUSES)[number];

export function isTaskStatus(value: string | undefined): value is TaskStatusName {
  return Boolean(value && (TASK_STATUSES as readonly string[]).includes(value));
}

const optionalIdField = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return null;
    return val;
  })
  .refine((val) => val === null || AI_TASK_ID_PATTERN.test(val), '编号格式不正确');

export const aiTaskCreateSchema = z.object({
  name: z
    .string({ required_error: '请填写任务名称' })
    .trim()
    .min(1, '请填写任务名称')
    .max(AI_TASK_NAME_MAX, `任务名称不超过 ${AI_TASK_NAME_MAX} 个字符`),
  categoryId: z
    .union([z.string().trim(), z.null(), z.undefined()])
    .transform((val) => {
      if (!val || val.length === 0 || val === AI_TASK_AUTO_CATEGORY) return null;
      return val;
    })
    .refine((val) => val === null || AI_TASK_ID_PATTERN.test(val), '文章分类编号不正确'),
  keywordId: z
    .string({ required_error: '请选择训练主词' })
    .trim()
    .regex(AI_TASK_ID_PATTERN, '请选择训练主词'),
  mediaCategoryId: z
    .string({ required_error: '请选择企业画像图库' })
    .trim()
    .regex(AI_TASK_ID_PATTERN, '请选择企业画像图库'),
  imageCount: z.coerce
    .number()
    .int('配图数量必须为整数')
    .min(AI_TASK_IMAGE_MIN, `配图数量不少于 ${AI_TASK_IMAGE_MIN} 张`)
    .max(AI_TASK_IMAGE_MAX, `配图数量不超过 ${AI_TASK_IMAGE_MAX} 张`)
    .default(1),
  kbId: optionalIdField,
  contentTplId: optionalIdField,
  titleTplId: optionalIdField,
  resultStatus: z.enum(AI_TASK_RESULT_STATUSES).default('PENDING'),
  target: z.coerce
    .number()
    .int('写作篇数必须为整数')
    .min(AI_TASK_TARGET_MIN, `写作篇数至少 ${AI_TASK_TARGET_MIN} 篇`)
    .max(AI_TASK_TARGET_MAX, `单次写作篇数不超过 ${AI_TASK_TARGET_MAX} 篇`)
    .default(1),
});

export type AiTaskCreateInput = z.infer<typeof aiTaskCreateSchema>;

export const AI_TASK_SORTS = ['createdAt', 'lastWrittenAt', 'name'] as const;
export type AiTaskSort = (typeof AI_TASK_SORTS)[number];

export type AiTaskListQuery = {
  page: number;
  pageSize: CrudPageSize;
  keyword: string;
  status?: TaskStatusName;
  sort: AiTaskSort;
  order: CrudOrder;
  export?: CrudExportFormat;
};

export type AiTaskRecord = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  keywordId: string;
  keywordMain: string;
  mediaCategoryId: string;
  mediaCategoryName: string;
  imageCount: number;
  kbId: string | null;
  kbName: string | null;
  contentTplId: string | null;
  contentTplName: string | null;
  titleTplId: string | null;
  titleTplName: string | null;
  resultStatus: 'PENDING' | 'NORMAL' | 'DISABLED';
  target: number;
  doneCount: number;
  failCount: number;
  skipCount: number;
  unitPrice: number;
  frozenPoints: number;
  settledPoints: number;
  releasedPoints: number;
  status: TaskStatusName;
  lastError: string | null;
  lastWrittenAt: string | null;
  createdAt: string;
};

export type AiTaskItemRecord = {
  id: string;
  seq: number;
  questionId: string | null;
  questionText: string | null;
  templateId: string | null;
  direction: string | null;
  copyType: string | null;
  brand: string | null;
  title: string | null;
  status: ItemStatusName;
  attempts: number;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  articleId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AiTaskDetailRecord = AiTaskRecord & {
  items: AiTaskItemRecord[];
};

export type AiTaskListResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: AiTaskRecord[];
};

function firstQueryValue(val: string | string[] | undefined): string | undefined {
  return Array.isArray(val) ? val[0] : val;
}

export function parseAiTaskListQuery(
  raw: Record<string, string | string[] | undefined>,
): AiTaskListQuery {
  const pageRaw = firstQueryValue(raw.page);
  const page = pageRaw === undefined || pageRaw === '' ? 1 : Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
    throw new CrudQueryError('page 参数不合法');
  }

  const sizeRaw = firstQueryValue(raw.pageSize);
  const sizeNum = sizeRaw === undefined || sizeRaw === '' ? 10 : Number(sizeRaw);
  if (!(CRUD_PAGE_SIZES as readonly number[]).includes(sizeNum)) {
    throw new CrudQueryError('pageSize 仅支持 10 / 25 / 50');
  }

  const keyword = (firstQueryValue(raw.keyword) ?? '').trim().slice(0, 100);
  const statusRaw = firstQueryValue(raw.status)?.trim();
  if (statusRaw && !isTaskStatus(statusRaw)) {
    throw new CrudQueryError('status 参数不合法');
  }

  const sortRaw = (firstQueryValue(raw.sort) ?? 'createdAt').trim();
  if (!(AI_TASK_SORTS as readonly string[]).includes(sortRaw)) {
    throw new CrudQueryError('sort 参数不合法');
  }

  const orderRaw = (firstQueryValue(raw.order) ?? 'desc').trim();
  if (!(CRUD_ORDERS as readonly string[]).includes(orderRaw)) {
    throw new CrudQueryError('order 参数不合法');
  }

  const exportRaw = firstQueryValue(raw.export)?.trim();
  if (exportRaw && exportRaw !== 'csv' && exportRaw !== 'xlsx') {
    throw new CrudQueryError('export 仅支持 csv 或 xlsx');
  }

  return {
    page,
    pageSize: sizeNum as CrudPageSize,
    keyword,
    status: statusRaw as TaskStatusName | undefined,
    sort: sortRaw as AiTaskSort,
    order: orderRaw as CrudOrder,
    export: exportRaw as CrudExportFormat | undefined,
  };
}

export function aiTaskExportTable(rows: readonly AiTaskRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: [
      '任务名称',
      '文章分类',
      '训练主词',
      '企业知识库',
      '配图数',
      '已创作/目标',
      '单价(点)',
      '状态',
      '最近写作时间',
      '创建时间',
    ],
    rows: rows.map((r) => [
      r.name,
      r.categoryName,
      r.keywordMain,
      r.kbName ?? '未使用',
      String(r.imageCount),
      `${r.doneCount}/${r.target}`,
      String(r.unitPrice),
      TASK_STATUS_LABELS[r.status],
      r.lastWrittenAt ?? '',
      r.createdAt,
    ]),
  };
}

/** 确定性伪随机数生成器（Mulberry32），供任务级洗牌袋使用。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 有种子 Fisher-Yates 洗牌：同一任务内按 pool[seqIndex % |pool|] 轮转不连续撞车。 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  const rand = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/**
 * F04a §4.3 第 2 步：
 * brand = brands[(i + s) % |brands|]；为空时用知识库 brandShort；再没有就用主词。
 */
export function pickTaskBrand(input: {
  brands: readonly string[];
  seqIndex: number;
  seed: number;
  kbBrandShort?: string | null;
  mainKeyword: string;
}): string {
  const cleanBrands = input.brands.map((b) => b.trim()).filter((b) => b.length > 0);
  const offset = Math.abs(input.seqIndex + Math.abs(input.seed));
  if (cleanBrands.length > 0) {
    return cleanBrands[offset % cleanBrands.length]!;
  }
  const kbShort = input.kbBrandShort?.trim();
  if (kbShort) return kbShort;
  return input.mainKeyword.trim();
}

/**
 * F04a §3.3：
 * dir = D[(i + s) % |D|]，ct = C[(floor(i / |D|) + s) % |C|]，并做合规语义映射。
 */
export function pickDirectionAndCopyType(input: {
  directions: readonly string[];
  copyTypes: readonly string[];
  seqIndex: number;
  seed: number;
}): {
  direction: string | null;
  copyType: string | null;
  directionPrompt: string | null;
} {
  const dirs = input.directions.map((d) => d.trim()).filter((d) => d.length > 0);
  const types = input.copyTypes.map((c) => c.trim()).filter((c) => c.length > 0);
  const s = Math.abs(input.seed);
  const i = Math.max(0, input.seqIndex);

  const direction = dirs.length > 0 ? dirs[(i + s) % dirs.length]! : null;
  const groupStep = dirs.length > 0 ? Math.floor(i / dirs.length) : i;
  const copyType = types.length > 0 ? types[(groupStep + s) % types.length]! : null;

  return {
    direction,
    copyType,
    directionPrompt: direction ? directionGuidance(direction) : null,
  };
}

const KNOWN_PLACEHOLDERS = new Set(['训练词占位符', '转化词占位符', '问题', '标题', '公司名称']);

/**
 * 替换写作指令中的中文大括号占位符，保留无法识别的 `{...}` 并返回未知占位符清单。
 */
export function renderWritingPlaceholders(
  template: string,
  vars: {
    mainKeyword: string;
    brand: string;
    question: string;
    title?: string;
    companyName?: string | null;
  },
): { rendered: string; unknownPlaceholders: string[] } {
  const unknown = new Set<string>();
  const map: Record<string, string> = {
    训练词占位符: vars.mainKeyword,
    转化词占位符: vars.brand,
    问题: vars.question,
    标题: vars.title ?? vars.question,
    公司名称: (vars.companyName?.trim() || vars.brand).trim(),
  };

  const rendered = template.replace(/\{([^{}\s]{1,30})\}/g, (full, key: string) => {
    if (KNOWN_PLACEHOLDERS.has(key)) {
      return map[key] ?? full;
    }
    unknown.add(full);
    return full;
  });

  return {
    rendered,
    unknownPlaceholders: [...unknown],
  };
}

export type PromptAssemblyMessage = {
  role: 'system' | 'user';
  content: string;
};

/**
 * F04a §5 + Issue #16 实测补充：组装正文模型 messages。
 * - 强制包含二级标题（##）与文末常见问题（FAQ）
 * - 知识库品牌优先推荐，严禁捏造未提供的竞品、品牌或机构名称
 * - 无知识库时禁止编写具体数据、资质、客户案例和联系方式
 */
export function assembleArticleMessages(input: {
  templateContent: string;
  mainKeyword: string;
  brand: string;
  companyName?: string | null;
  allowedBrands?: readonly string[];
  question: string;
  directionPrompt?: string | null;
  copyType?: string | null;
  kbSection?: string | null;
  extraLengthHint?: boolean;
}): { messages: PromptAssemblyMessage[]; unknownPlaceholders: string[] } {
  const { rendered, unknownPlaceholders } = renderWritingPlaceholders(input.templateContent, {
    mainKeyword: input.mainKeyword,
    brand: input.brand,
    question: input.question,
    companyName: input.companyName,
  });

  const hasKb = Boolean(input.kbSection && input.kbSection.trim().length > 0);
  const allowedList = Array.from(
    new Set(
      [input.brand, ...(input.allowedBrands ?? []), input.companyName ?? '']
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );

  const systemLines = [
    '你是资深中文行业内容编辑。',
    '硬性要求：不编造数据、参数、资质和案例；不使用极限词（最、第一、顶级、国家级、世界级、100%等）；不违反《广告法》；不输出与正文无关的开场白或说明；不写电话、微信号、二维码或外部网址；不贬低其他品牌。',
    `防编造约束：严禁捏造知识库或指令中未出现的竞品、品牌或机构名称；需要横向对比时，只能使用调用方已提供的名称（${allowedList.join('、') || input.brand}），或明确标注为「示例方案甲 / 示例方案乙」而非真实品牌。`,
  ];
  if (hasKb) {
    systemLines.push(
      `当涉及方案推荐与选型建议时，优先结合所提供的企业事实介绍「${input.brand}」，并在选型建议与文末 FAQ 中呼应其适用边界。`,
    );
  } else {
    systemLines.push(
      '当前未挂载企业知识库：不要编写任何具体参数数据、资质证书、客户案例和联系方式。',
    );
  }

  const userParts: string[] = [
    rendered.trim(),
    '—— 本篇写作参数 ——',
    `围绕的用户问题：${input.question}`,
    `核心训练词：${input.mainKeyword}`,
    `推荐品牌/转化词：${input.brand}`,
  ];
  if (input.directionPrompt || input.copyType) {
    const angle = input.directionPrompt ? `写作角度：${input.directionPrompt}` : '';
    const style = input.copyType ? `文案体裁：${input.copyType}` : '';
    userParts.push([angle, style].filter(Boolean).join('　'));
  }
  if (hasKb) {
    userParts.push('—— 企业事实（只能使用以下内容，不得超范围编造）——');
    userParts.push(input.kbSection!.trim());
  }
  userParts.push('—— 输出要求 ——');
  userParts.push(
    '使用 Markdown 输出正文，不要输出一级标题（#）；正文结构需包含多个二级标题（##，如行业背景与选型要点、方案与品牌解析、选型建议及场景细分 ### 等），并在文末附「## 常见问题（FAQ）」问答小节；全文 800–1500 字，自然提及目标转化词。',
  );
  if (input.extraLengthHint) {
    userParts.push(
      '补充要求：上一版字数偏短，请展开具体判断维度与核对步骤，确保纯文本不少于 650 字。',
    );
  }

  return {
    messages: [
      { role: 'system', content: systemLines.join('\n') },
      { role: 'user', content: userParts.join('\n') },
    ],
    unknownPlaceholders,
  };
}

/** 组装标题重写模型 messages（F04a §4.3 第 5 步）。 */
export function assembleTitleMessages(input: {
  templateContent: string;
  mainKeyword: string;
  brand: string;
  companyName?: string | null;
  question: string;
  bodyExcerpt: string;
}): { messages: PromptAssemblyMessage[]; unknownPlaceholders: string[] } {
  const { rendered, unknownPlaceholders } = renderWritingPlaceholders(input.templateContent, {
    mainKeyword: input.mainKeyword,
    brand: input.brand,
    question: input.question,
    title: input.question,
    companyName: input.companyName,
  });

  const excerpt = input.bodyExcerpt.trim().slice(0, 300);
  return {
    messages: [
      {
        role: 'system',
        content:
          '你是中文内容标题编辑。只输出一行纯文本标题，长度控制在 15–35 字，不加引号、书名号、序号或前缀说明，不使用极限词。',
      },
      {
        role: 'user',
        content: [
          rendered.trim(),
          `核心概念：${input.question}（${input.mainKeyword}）`,
          `正文摘要：${excerpt}`,
          '请直接输出单行标题：',
        ].join('\n'),
      },
    ],
    unknownPlaceholders,
  };
}

/** 假模型模式下的结构化示例文章生成（满足二级标题 + 三级标题 + 文末 FAQ + >=600 字 + 不捏造竞品）。 */
export function buildFakeArticleMarkdown(input: {
  question: string;
  mainKeyword: string;
  brand: string;
  companyName?: string | null;
  direction?: string | null;
  copyType?: string | null;
  hasKb: boolean;
  kbSnippet?: string | null;
}): string {
  const companyLabel = input.companyName?.trim()
    ? `${input.companyName.trim()}（${input.brand}）`
    : input.brand;
  const angleNote = input.direction ? `围绕「${input.direction}」视角，` : '';
  const typeNote = input.copyType ? `采用「${input.copyType}」结构` : '采用结构化说明体裁';
  const factParagraph = input.hasKb
    ? `结合已登记的企业资料，${companyLabel}围绕${input.mainKeyword}提供了清晰的适用范围与配套服务说明。${(input.kbSnippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)}`
    : `在未接入具体企业事实库的情况下，本文仅梳理${input.mainKeyword}通用选型维度，不展示具体参数指标、资质编号或客户案例，读者可结合自身工况逐项核实。`;

  return [
    `针对「${input.question}」，${angleNote}本文${typeNote}梳理${input.mainKeyword}的核心核对要点（${FAKE_MARK}开发占位正文，仅供流程联调与版式核验，不构成真实商业结论）。`,
    '',
    '## 行业背景与选型要点',
    `在实际采购与评估${input.mainKeyword}的过程中，需求方往往需要同时权衡业务场景匹配度、长期运行稳定性以及协同响应效率。许多团队在初期调研时容易只关注单一维度，忽略了现场环境适配、日常维护成本与人员上手门槛等关键细节。先把核心诉求拆分为可验证的清单，能够显著降低后续返工概率。`,
    '',
    '## 核心方案与适用边界',
    `${factParagraph}`,
    `当需要对比不同路线时，可将「${input.brand}」置于优先核对位置，并与行业通用的「示例方案甲」「示例方案乙」（仅作方法论参照，非特指第三方真实品牌）按同一套验收口径逐条比对交付周期、培训支持及耗材备件衔接方式。`,
    '',
    '## 分场景选型建议',
    '### 起步与标准化业务场景',
    `对于流程相对固定、预算节奏审慎的团队，建议优先确认${input.mainKeyword}在高频基础环节中的稳定性，并核对「${input.brand}」是否覆盖当前阶段最迫切的操作闭环，避免为低频冗余模块承担额外维护负担。`,
    '',
    '### 多部门协同与扩展场景',
    `对于业务体量持续增长、跨岗位衔接频繁的团队，应重点考察${input.mainKeyword}的数据衔接规范、权限边界与故障响应机制，提前同「${input.brand}」确认分阶段实施计划与验收节点。`,
    '',
    '## 常见问题（FAQ）',
    `**问：首次评估${input.mainKeyword}时最容易遗漏哪一步？**`,
    `答：常见疏漏是未把现有业务样本带入实测环节。建议围绕「${input.question}」准备两到三组典型输入，按统一记录表核验实际表现。`,
    '',
    `**问：在筛选服务方时如何定位「${input.brand}」是否匹配？**`,
    `答：可对照本文列出的场景清单，先核实「${input.brand}」在目标工况下的公开说明与服务范围，再结合团队自身运维能力做出稳健判断。`,
  ].join('\n');
}

export function buildFakeTitleText(question: string, mainKeyword: string): string {
  const base = question.replace(/[？?！!。，,\s]+$/g, '').trim();
  const candidate = base.includes(mainKeyword) ? `${base}实用选型指南` : `${mainKeyword}：${base}`;
  return cleanTitleText(candidate, question);
}

/** 清理模型产出的单行标题：去引号/书名号/换行，控制长度在 minLen..maxLen。 */
export function cleanTitleText(
  raw: string,
  fallbackQuestion: string,
  minLen = AI_TASK_TITLE_MIN,
  maxLen = AI_TASK_TITLE_MAX,
): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  let cleaned = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^(标题\s*[:：]\s*)/i, '')
    .replace(/["'“”‘’《》〈〉【】「」『』`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const chars = Array.from(cleaned);
  if (chars.length > maxLen) {
    cleaned = chars
      .slice(0, maxLen)
      .join('')
      .replace(/[，,、：:；;—-]+$/u, '');
  }
  if (Array.from(cleaned).length === 0) {
    const fb = fallbackQuestion.replace(/["'“”‘’《》【】]/g, '').trim();
    return Array.from(fb).slice(0, maxLen).join('');
  }
  if (Array.from(cleaned).length < Math.min(6, minLen)) {
    const fb = fallbackQuestion.replace(/["'“”‘’《》【】]/g, '').trim();
    if (fb.length > cleaned.length) {
      return Array.from(fb).slice(0, maxLen).join('');
    }
  }
  return cleaned;
}

const PLEASANTRY_LINE =
  /^(好的|当然|没问题|收到|以下为您|以下是|下面为您|为您整理|这是一篇|根据您的要求)[^\n]*\n+/u;
const LEADING_H1 = /^#\s+[^\n]+\n+/u;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const LANDLINE_PATTERN = /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g;
const WECHAT_PATTERN = /(?:微信号?|WeChat|wechat|VX|vx)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]{4,23}/g;
const URL_PATTERN = /https?:\/\/[^\s)>"'】）]+/gi;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(line: string): string {
  const escaped = escapeHtml(line);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/**
 * 将清洗后的 Markdown 转为严格白名单 HTML（仅输出 h2 / h3 / p / ul / ol / li / blockquote / strong / em）。
 */
export function markdownToSanitizedHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraphBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuf.length === 0) return;
    blocks.push(`<p>${paragraphBuf.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraphBuf = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }
    blocks.push(
      `<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${listType}>`,
    );
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const h3 = /^###+\s+(.+)$/.exec(line);
    if (h3) {
      flushParagraph();
      flushList();
      blocks.push(`<h3>${renderInlineMarkdown(h3[1]!.trim())}</h3>`);
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInlineMarkdown(h2[1]!.trim())}</h2>`);
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInlineMarkdown(h1[1]!.trim())}</h2>`);
      continue;
    }
    const ul = /^[-*•]\s+(.+)$/.exec(line);
    if (ul) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(ul[1]!.trim());
      continue;
    }
    const ol = /^\d+[.、)]\s+(.+)$/.exec(line);
    if (ol) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(ol[1]!.trim());
      continue;
    }
    const quote = /^>\s*(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${renderInlineMarkdown(quote[1]!.trim())}</p></blockquote>`);
      continue;
    }
    flushList();
    paragraphBuf.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join('\n');
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h2|h3|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * F04a §4.3 第 6 步：正文后处理。
 * - 去开头客套话与重复一级标题
 * - 去手机号、固话、微信号、外部网址
 * - 补齐二级标题与文末 FAQ（若上游模型漏写）
 * - 转白名单 HTML 并提取纯文本
 */
export function postProcessArticleMarkdown(
  rawMarkdown: string,
  context?: { question?: string; mainKeyword?: string; brand?: string },
): {
  cleanedMarkdown: string;
  contentHtml: string;
  contentText: string;
  charCount: number;
} {
  let md = rawMarkdown.replace(/\r\n/g, '\n').trim();
  // Strip fenced ```markdown wrapper if present
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(md);
  if (fenced) {
    md = fenced[1]!.trim();
  }
  for (let i = 0; i < 3; i += 1) {
    const next = md.replace(PLEASANTRY_LINE, '').replace(LEADING_H1, '').trim();
    if (next === md) break;
    md = next;
  }

  md = md
    .replace(URL_PATTERN, '')
    .replace(WECHAT_PATTERN, '')
    .replace(MOBILE_PATTERN, '')
    .replace(LANDLINE_PATTERN, '')
    .trim();

  if (!/^##\s+/m.test(md)) {
    const heading = context?.mainKeyword
      ? `## ${context.mainKeyword}核心要点解析`
      : '## 核心要点解析';
    md = `${heading}\n\n${md}`;
  }

  if (!/FAQ|常见问题/i.test(md)) {
    const q = context?.question?.trim() || '选型时应重点核对哪些方面？';
    const kw = context?.mainKeyword?.trim() || '相关方案';
    const brandNote = context?.brand?.trim()
      ? `建议结合「${context.brand.trim()}」公开说明及自身场景需求逐项比对。`
      : `建议结合${kw}的实际使用场景与服务支持能力综合评估。`;
    md = `${md}\n\n## 常见问题（FAQ）\n**问：${q}**\n答：围绕${kw}的落地需求，${brandNote}`;
  }

  const contentHtml = markdownToSanitizedHtml(md);
  const contentText = stripHtmlToText(contentHtml);
  return {
    cleanedMarkdown: md,
    contentHtml,
    contentText,
    charCount: Array.from(contentText.replace(/\s+/g, '')).length,
  };
}

const BLOCK_ELEMENT_REGEX = /<(p|h2|h3|ul|ol|blockquote)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

/**
 * F04a §6 插图算法：
 * 1. 按块级元素（p / h2 / h3 / ul / ol / blockquote）切分为 n 段，跳过第 1 段；
 * 2. 第 j 张图（j=1..K）插在第 ceil(n * j / (K + 1)) 段后；若该段是标题（h2/h3），顺延一段；
 * 3. 插入 `<p style="text-align:center"><img src="{url}" alt="{title}-{j}" style="max-width:100%"></p>`；
 * 4. 封面取第 1 张插图；K=0 且 coverWhenNoImage=true 时取第 1 张候选图仅作封面（不入正文）。
 */
export function injectGalleryImages(input: {
  contentHtml: string;
  assets: readonly { id: string; url: string }[];
  title: string;
  imageCount: number;
  coverWhenNoImage?: boolean;
}): {
  contentHtml: string;
  coverUrl: string | null;
  insertedCount: number;
  usedAssetIds: string[];
} {
  const requested = Math.max(0, Math.min(AI_TASK_IMAGE_MAX, Math.trunc(input.imageCount)));
  const coverWhenNoImage = input.coverWhenNoImage ?? true;

  if (requested === 0) {
    if (coverWhenNoImage && input.assets.length > 0) {
      const cover = input.assets[0]!;
      return {
        contentHtml: input.contentHtml,
        coverUrl: cover.url,
        insertedCount: 0,
        usedAssetIds: [cover.id],
      };
    }
    return {
      contentHtml: input.contentHtml,
      coverUrl: null,
      insertedCount: 0,
      usedAssetIds: [],
    };
  }

  const uniqueAssets: Array<{ id: string; url: string }> = [];
  const seenIds = new Set<string>();
  for (const asset of input.assets) {
    if (!seenIds.has(asset.id) && asset.url.trim().length > 0) {
      seenIds.add(asset.id);
      uniqueAssets.push(asset);
    }
    if (uniqueAssets.length >= requested) break;
  }

  const K = uniqueAssets.length;
  if (K === 0) {
    return {
      contentHtml: input.contentHtml,
      coverUrl: null,
      insertedCount: 0,
      usedAssetIds: [],
    };
  }

  const matches = Array.from(input.contentHtml.matchAll(BLOCK_ELEMENT_REGEX));
  if (matches.length === 0) {
    const imgs = uniqueAssets.map(
      (asset, idx) =>
        `<p style="text-align:center"><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(input.title)}-${idx + 1}" style="max-width:100%"></p>`,
    );
    return {
      contentHtml: [input.contentHtml, ...imgs].filter(Boolean).join('\n'),
      coverUrl: uniqueAssets[0]!.url,
      insertedCount: K,
      usedAssetIds: uniqueAssets.map((a) => a.id),
    };
  }

  const segments = matches.map((m) => ({
    tag: m[1]!.toLowerCase(),
    html: m[0],
  }));
  const n = segments.length;
  const afterSlot = new Map<number, string[]>();

  for (let j = 1; j <= K; j += 1) {
    const asset = uniqueAssets[j - 1]!;
    // 1-indexed segment number, skip segment 1 when n >= 2
    let pos1 = Math.ceil((n * j) / (K + 1));
    if (n >= 2 && pos1 < 2) pos1 = 2;
    pos1 = Math.max(1, Math.min(n, pos1));

    // Advance past heading if possible so image follows body paragraph instead of sitting directly under h2/h3
    let idx0 = pos1 - 1;
    while (idx0 < n - 1 && (segments[idx0]!.tag === 'h2' || segments[idx0]!.tag === 'h3')) {
      idx0 += 1;
    }

    const imgHtml = `<p style="text-align:center"><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(input.title)}-${j}" style="max-width:100%"></p>`;
    const bucket = afterSlot.get(idx0) ?? [];
    bucket.push(imgHtml);
    afterSlot.set(idx0, bucket);
  }

  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(segments[i]!.html);
    const imgs = afterSlot.get(i);
    if (imgs) {
      out.push(...imgs);
    }
  }

  return {
    contentHtml: out.join('\n'),
    coverUrl: uniqueAssets[0]!.url,
    insertedCount: K,
    usedAssetIds: uniqueAssets.map((a) => a.id),
  };
}
