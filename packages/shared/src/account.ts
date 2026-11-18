import { z } from 'zod';
import { QUOTA_DEFAULTS, type PricingAction, type QuotaKeyName } from './catalog';

export { QUOTA_DEFAULTS };
import {
  CRUD_EXPORT_LIMIT,
  CRUD_PAGE_SIZES,
  type CrudExportFormat,
  type CrudPageSize,
} from './crud';

/**
 * 个人中心和管理员后台（issue #9）的展示规则。
 * 文案是 GeoMix 自写的。模型卡只用公开模型名，计数留在后续收录模块，这里固定为 0。
 * 点数短语与 #4 的明细对齐：管理员充值的 delta 是实际加减，影子账的 delta 为 0。
 */

export const ACCOUNT_QUERY_KEYS = [
  'page',
  'pageSize',
  'sort',
  'order',
  'filter',
  'export',
] as const;

export const POINT_LEDGER_COLUMNS = ['项目', '点数', '消耗时间'] as const;
export const MONEY_LEDGER_COLUMNS = ['项目', '金额', '说明', '消耗时间'] as const;

/** 余额明细明确不要的列。页面和导出都不输出它们。 */
export const MONEY_LEDGER_EXCLUDED_COLUMNS = ['序号', '复选框'] as const;

export const POINT_SORTS = ['createdAt', 'delta', 'title'] as const;
export const MONEY_SORTS = ['createdAt', 'amount', 'title'] as const;

export const ADMIN_ROUTES = {
  tenants: '/admin/tenants',
  pricing: '/admin/pricing',
  announcements: '/admin/announcements',
  templates: '/admin/templates',
} as const;

export const MODEL_INCLUSION_CARDS = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'doubao', label: '豆包' },
  { key: 'yuanbao', label: '腾讯元宝' },
  { key: 'tongyi', label: '通义千问' },
  { key: 'wenxin', label: '文心一言' },
  { key: 'nami', label: '纳米' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'zhipu', label: '智谱' },
] as const;

export type ModelInclusionKey = (typeof MODEL_INCLUSION_CARDS)[number]['key'];

export const QUOTA_KEY_NAMES = QUOTA_DEFAULTS.map((item) => item.key) as [
  QuotaKeyName,
  ...QuotaKeyName[],
];

const QUOTA_KEY_SET = new Set<string>(QUOTA_KEY_NAMES);

export class AccountQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountQueryError';
  }
}

export type PointListQuery = {
  page: number;
  pageSize: CrudPageSize;
  sort: (typeof POINT_SORTS)[number];
  order: 'asc' | 'desc';
  title: string;
  delta: number | undefined;
  from: string | undefined;
  to: string | undefined;
  export: CrudExportFormat | undefined;
};

export type MoneyListQuery = {
  page: number;
  pageSize: CrudPageSize;
  sort: (typeof MONEY_SORTS)[number];
  order: 'asc' | 'desc';
  title: string;
  amount: string | undefined;
  from: string | undefined;
  to: string | undefined;
  export: CrudExportFormat | undefined;
};

export type RightsQuota = {
  key: QuotaKeyName;
  used: bigint;
  limit: bigint;
};

export type RightsCard = {
  key: string;
  label: string;
  text: string;
  used?: string;
  limit?: string;
};

export type RightsInput = {
  quotas: readonly RightsQuota[];
  included: number;
  expiresOn: string;
  points: number;
  money: string;
};

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,160}$/;
const CREDIT_CODE = /^[0-9A-Z]{8,32}$/;
const MONEY_AMOUNT = /^-?\d{1,10}(\.\d{1,2})?$/;

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function formatPointDelta(delta: number): string {
  if (!Number.isSafeInteger(delta)) throw new AccountQueryError('点数变动不正确');
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

/** 明细对照文案。管理员加 500 点时是「+500 管理员充值」。 */
export function pointLedgerPhrase(delta: number, title: string): string {
  const name = title.trim();
  if (!name || hasControl(name)) throw new AccountQueryError('项目不正确');
  return `${formatPointDelta(delta)} ${name}`;
}

/** 点数列。影子账 delta 为 0 时带上原价，方便和冻结单对账。 */
export function formatPointsCell(delta: number, listPrice: number): string {
  if (!Number.isSafeInteger(listPrice) || listPrice < 0) throw new AccountQueryError('原价不正确');
  if (delta !== 0) return formatPointDelta(delta);
  if (listPrice > 0) return `0（原价 ${listPrice}）`;
  return '0';
}

export function formatBytes(value: bigint | number): string {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n) throw new AccountQueryError('容量不正确');
  const mb = 1024n * 1024n;
  const kb = 1024n;
  if (n % mb === 0n) return `${n / mb} MB`;
  if (n > mb) {
    const tenths = (n * 10n) / mb;
    return `${tenths / 10n}.${tenths % 10n} MB`;
  }
  if (n % kb === 0n && n >= kb) return `${n / kb} KB`;
  if (n > kb) {
    const tenths = (n * 10n) / kb;
    return `${tenths / 10n}.${tenths % 10n} KB`;
  }
  return `${n} B`;
}

export function formatMoney(value: string): string {
  const trimmed = value.trim();
  if (!MONEY_AMOUNT.test(trimmed)) throw new AccountQueryError('金额不正确');
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = digits.split('.');
  return `${negative ? '-' : ''}${whole}.${(frac + '00').slice(0, 2)}`;
}

export function formatLedgerTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new AccountQueryError('时间不正确');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = read('hour') === '24' ? '00' : read('hour');
  return `${read('year')}-${read('month')}-${read('day')} ${hour}:${read('minute')}:${read('second')}`;
}

export function formatAdminDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return formatLedgerTime(iso);
}

/**
 * 权益页的 10 张卡。
 * 配额项直接读 Quota 表。已收录不是配额行，按写作标题里 included 的条数展示。
 * 图片空间同时写出已用量和上限。
 */
export function buildRightsCards(input: RightsInput): RightsCard[] {
  if (!Number.isSafeInteger(input.included) || input.included < 0) {
    throw new AccountQueryError('已收录不正确');
  }
  if (!Number.isSafeInteger(input.points) || input.points < 0) {
    throw new AccountQueryError('点数不正确');
  }
  const quotas = new Map(input.quotas.map((row) => [row.key, row]));
  const ratio = (key: QuotaKeyName, label: string): RightsCard => {
    const row = quotas.get(key);
    if (!row) return { key, label, text: '未配置' };
    const used = row.used.toString();
    const limit = row.limit.toString();
    return { key, label, text: `${used} / ${limit}`, used, limit };
  };
  const storageRow = quotas.get('STORAGE_BYTES');
  const storage: RightsCard = storageRow
    ? {
        key: 'STORAGE_BYTES',
        label: '图片存储空间',
        text: `${formatBytes(storageRow.used)} / ${formatBytes(storageRow.limit)}`,
        used: storageRow.used.toString(),
        limit: storageRow.limit.toString(),
      }
    : { key: 'STORAGE_BYTES', label: '图片存储空间', text: '未配置' };
  return [
    ratio('MAIN_KEYWORD', '主关键词'),
    ratio('QUESTION', '写作问题'),
    {
      key: 'INCLUDED',
      label: '已收录',
      text: String(input.included),
      used: String(input.included),
    },
    ratio('AI_WRITE', 'AI写作数量'),
    ratio('PUBLISH', '文章发布'),
    ratio('SOCIAL_AUTH', '自媒体授权'),
    { key: 'EXPIRES', label: '有效期', text: input.expiresOn },
    storage,
    { key: 'POINTS', label: '点数', text: String(input.points) },
    { key: 'MONEY', label: '余额', text: formatMoney(input.money) },
  ];
}

export function emptyModelInclusions(): Array<{
  key: ModelInclusionKey;
  label: string;
  count: number;
}> {
  return MODEL_INCLUSION_CARDS.map((item) => ({ key: item.key, label: item.label, count: 0 }));
}

export function isQuotaKeyName(value: string): value is QuotaKeyName {
  return QUOTA_KEY_SET.has(value);
}

export function parsePointListQuery(input: Record<string, unknown>): PointListQuery {
  assertQueryKeys(input);
  const filter = readFilter(input.filter, 'point');
  return {
    page: readPage(input.page),
    pageSize: readPageSize(input.pageSize),
    sort: readChoice(input.sort, POINT_SORTS, 'createdAt'),
    order: readChoice(input.order, ['asc', 'desc'] as const, 'desc'),
    title: filter.title,
    delta: filter.delta,
    from: filter.from,
    to: filter.to,
    export: readExport(input.export),
  };
}

export function parseMoneyListQuery(input: Record<string, unknown>): MoneyListQuery {
  assertQueryKeys(input);
  const filter = readFilter(input.filter, 'money');
  return {
    page: readPage(input.page),
    pageSize: readPageSize(input.pageSize),
    sort: readChoice(input.sort, MONEY_SORTS, 'createdAt'),
    order: readChoice(input.order, ['asc', 'desc'] as const, 'desc'),
    title: filter.title,
    amount: filter.amount,
    from: filter.from,
    to: filter.to,
    export: readExport(input.export),
  };
}

export function pointListQueryString(query: PointListQuery): string {
  return listQueryString(query, {
    title: query.title,
    delta: query.delta,
    from: query.from,
    to: query.to,
  });
}

export function moneyListQueryString(query: MoneyListQuery): string {
  return listQueryString(query, {
    title: query.title,
    amount: query.amount,
    from: query.from,
    to: query.to,
  });
}

export function readIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value) || value.startsWith('close:')) {
    throw new AccountQueryError('幂等键不正确');
  }
  return value;
}

const nameField = z
  .string()
  .trim()
  .min(1, '请填写名称')
  .max(40, '名称最多 40 字')
  .refine((value) => !hasControl(value), '名称含有无法显示的字符');

export const createTenantSchema = z
  .object({
    name: nameField,
    username: z.string().trim().regex(USERNAME, '用户名不正确'),
    password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
    expiresAt: z.string().datetime({ offset: true, message: '有效期不正确' }),
    billingMode: z.enum(['SHADOW', 'STRICT']).nullable().optional(),
    initialPoints: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();

export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z
  .object({
    name: nameField.optional(),
    isActive: z.boolean().optional(),
    expiresAt: z.string().datetime({ offset: true, message: '有效期不正确' }).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '没有要修改的内容' });

export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export const quotaUpdateSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            key: z.enum(QUOTA_KEY_NAMES),
            limit: z.string().regex(/^[0-9]{1,15}$/, '配额上限不正确'),
          })
          .strict(),
      )
      .min(1, '请填写配额')
      .max(QUOTA_KEY_NAMES.length, '配额项过多'),
  })
  .strict();

export type QuotaUpdateInput = z.infer<typeof quotaUpdateSchema>;

export const pricingUpdateSchema = z
  .object({
    action: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,40}$/, '价格项不正确'),
    unitPoints: z.number().int().positive().max(1_000_000),
    enabled: z.boolean(),
  })
  .strict();

export type PricingUpdateInput = z.infer<typeof pricingUpdateSchema>;

export type PricingActionMeta = {
  action: PricingAction | string;
  label: string;
  unit: string;
  unitSuffix: string;
  description: string;
};

export const PRICING_ACTION_META: Record<PricingAction, PricingActionMeta> = {
  ai_write: {
    action: 'ai_write',
    label: 'AI 文章写作',
    unit: '点/篇',
    unitSuffix: '篇',
    description: '基于主词、写作问题与模板生成单篇 GeoMix 合规文章',
  },
  kb_addon: {
    action: 'kb_addon',
    label: '知识库增强附加费',
    unit: '点/篇',
    unitSuffix: '篇',
    description: 'AI 写作开启企业知识库检索增强时的单篇附加扣点',
  },
  distill: {
    action: 'distill',
    label: 'AI 蒸馏拓展',
    unit: '点/次',
    unitSuffix: '次',
    description: '围绕训练主词批量蒸馏拓展长尾写作问题（按次计费）',
  },
  rewrite_single: {
    action: 'rewrite_single',
    label: '单篇流量复刻',
    unit: '点/篇',
    unitSuffix: '篇',
    description: '单篇文章参考改写与品牌自然融入创作',
  },
  rewrite_batch: {
    action: 'rewrite_batch',
    label: '批量流量复刻',
    unit: '点/篇',
    unitSuffix: '篇',
    description: '批量链接列表改写任务（按成功生成篇数计费）',
  },
  image_gen: {
    action: 'image_gen',
    label: 'AI 生图',
    unit: '点/张',
    unitSuffix: '张',
    description: 'AI 配图生成并存入企业图库（按生成张数计费）',
  },
  visibility_check: {
    action: 'visibility_check',
    label: 'AI 可见性监测',
    unit: '点/次',
    unitSuffix: '次',
    description: '在目标 AI 引擎中执行单次问答品牌可见性监测',
  },
};

export function getPricingActionMeta(action: string): PricingActionMeta {
  if (Object.prototype.hasOwnProperty.call(PRICING_ACTION_META, action)) {
    return PRICING_ACTION_META[action as PricingAction];
  }
  return {
    action,
    label: action,
    unit: '点/次',
    unitSuffix: '次',
    description: '计费项目配置',
  };
}

export const pricingBatchUpdateSchema = z
  .object({
    items: z
      .array(pricingUpdateSchema)
      .min(1, '请至少修改一条价格配置')
      .max(50, '单次最多保存 50 条价格配置'),
  })
  .strict()
  .refine((value) => new Set(value.items.map((item) => item.action)).size === value.items.length, {
    message: '存在重复的价格项目',
  });

export type PricingBatchUpdateInput = z.infer<typeof pricingBatchUpdateSchema>;

export const announcementSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, '请填写公告')
      .max(200, '公告最多 200 字')
      .refine((value) => !hasControl(value), '公告含有无法显示的字符'),
    enabled: z.boolean().optional().default(true),
    sort: z.number().int().min(0).max(9999).optional().default(0),
  })
  .strict();

export type AnnouncementInput = z.infer<typeof announcementSchema>;

export const templateWriteSchema = z
  .object({
    kind: z.enum(['ARTICLE', 'TITLE', 'REWRITE']),
    name: nameField,
    content: z
      .string()
      .trim()
      .min(1, '请填写模板正文')
      .max(8000, '模板最多 8000 字')
      .refine((value) => !hasControl(value), '模板含有无法显示的字符'),
    randomPool: z.boolean(),
    sort: z.number().int().min(0).max(9999),
  })
  .strict();

export type TemplateWriteInput = z.infer<typeof templateWriteSchema>;

export const verificationSchema = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(2, '请填写主体名称')
      .max(80, '主体名称过长')
      .refine((value) => !hasControl(value), '主体名称含有无法显示的字符'),
    creditCode: z.string().trim().regex(CREDIT_CODE, '统一社会信用代码格式不正确'),
    contact: z
      .string()
      .trim()
      .max(40, '联系人过长')
      .refine((value) => !hasControl(value), '联系人含有无法显示的字符')
      .optional()
      .default(''),
    phone: z
      .string()
      .trim()
      .max(20, '电话过长')
      .refine((value) => value === '' || /^[0-9+\- ]{6,20}$/.test(value), '电话不正确')
      .optional()
      .default(''),
  })
  .strict();

export type VerificationInput = z.infer<typeof verificationSchema>;

export { CRUD_EXPORT_LIMIT };

function listQueryString(
  query: { page: number; pageSize: number; sort: string; order: string; export?: CrudExportFormat },
  filter: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', query.sort);
  params.set('order', query.order);
  const body: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === '') continue;
    body[key] = value;
  }
  if (Object.keys(body).length > 0) params.set('filter', JSON.stringify(body));
  if (query.export) params.set('export', query.export);
  return params.toString();
}

function assertQueryKeys(input: Record<string, unknown>): void {
  const allowed = new Set<string>(ACCOUNT_QUERY_KEYS);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AccountQueryError('查询参数不正确');
  }
}

function readFilter(
  value: unknown,
  kind: 'point' | 'money',
): {
  title: string;
  delta?: number;
  amount?: string;
  from?: string;
  to?: string;
} {
  if (value === undefined || value === '') return { title: '' };
  const raw = one(value);
  if (raw === undefined) throw new AccountQueryError('筛选不正确');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AccountQueryError('筛选不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AccountQueryError('筛选不正确');
  }
  const record = parsed as Record<string, unknown>;
  const allowed =
    kind === 'point'
      ? ['title', 'keyword', 'delta', 'from', 'to']
      : ['title', 'keyword', 'amount', 'from', 'to'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new AccountQueryError('筛选不正确');
  }
  const title = readTitle(record.title, record.keyword);
  const from = readInstant(record.from, '开始时间不正确');
  const to = readInstant(record.to, '结束时间不正确');
  if (from && to && from > to) throw new AccountQueryError('时间范围不正确');
  if (kind === 'point') {
    return { title, delta: readDelta(record.delta), from, to };
  }
  return { title, amount: readAmount(record.amount), from, to };
}

function readTitle(title: unknown, keyword: unknown): string {
  const primary = readPlain(title, '项目名称不正确');
  const alias = readPlain(keyword, '项目名称不正确');
  if (primary && alias && primary !== alias) throw new AccountQueryError('项目名称不正确');
  return primary || alias;
}

function readPlain(value: unknown, message: string): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > 80 || hasControl(value)) {
    throw new AccountQueryError(message);
  }
  return value.trim();
}

function readDelta(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AccountQueryError('点数变动不正确');
  }
  return value;
}

function readAmount(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !MONEY_AMOUNT.test(value)) {
    throw new AccountQueryError('金额不正确');
  }
  return formatMoney(value);
}

function readInstant(value: unknown, message: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new AccountQueryError(message);
  }
  return new Date(value).toISOString();
}

function readPage(value: unknown): number {
  const raw = one(value);
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new AccountQueryError('分页不正确');
  return Number(raw);
}

function readPageSize(value: unknown): CrudPageSize {
  const raw = one(value);
  if (raw === undefined || raw === '') return 10;
  const found = CRUD_PAGE_SIZES.find((size) => String(size) === raw);
  if (!found) throw new AccountQueryError('分页不正确');
  return found;
}

function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  const raw = one(value);
  if (raw === undefined || raw === '') return fallback;
  const found = choices.find((choice) => choice === raw);
  if (!found) throw new AccountQueryError('排序不正确');
  return found;
}

function readExport(value: unknown): CrudExportFormat | undefined {
  const raw = one(value);
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'csv' || raw === 'xlsx') return raw;
  throw new AccountQueryError('导出格式不正确');
}

function one(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}
