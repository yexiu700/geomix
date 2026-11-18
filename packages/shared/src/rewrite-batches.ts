import { z } from 'zod';
import { CRUD_PAGE_SIZES, type CrudPageSize } from './crud';
import {
  REWRITE_DEFAULT_UNIT_POINTS,
  REWRITE_ID_PATTERN,
  REWRITE_RESULT_STATUSES,
  canonicalizeRewriteUrl,
  computeRewriteUrlHash,
  type RewriteRecordItem,
  type RewriteResultStatusName,
} from './rewrites';
import { TASK_STATUSES, type TaskStatusName } from './writing-tasks';

export const REWRITE_BATCH_NAME_MAX = 60;
export const REWRITE_BATCH_MAX_COUNT_MIN = 1;
export const REWRITE_BATCH_MAX_COUNT_MAX = 50;
export const REWRITE_BATCH_LINK_LIST_MAX = 50;
export const REWRITE_BATCH_CANDIDATE_MULTIPLIER = 3;
export const REWRITE_BATCH_CONCURRENCY = 2;
export const REWRITE_BATCH_DEFAULT_UNIT_POINTS = REWRITE_DEFAULT_UNIT_POINTS;
export const REWRITE_BATCH_TIMEOUT_MS_DEFAULT = 300_000;
export const REWRITE_BATCH_ITEM_TIMEOUT_MS_DEFAULT = 45_000;

export const REWRITE_BATCH_URL_AS_KEYWORD_MSG =
  '检测到这是链接不是关键词，请切换为「粘贴链接清单」模式或输入纯文本搜索词';

export const REWRITE_BATCH_SOURCE_TYPES = ['link_list', 'remote'] as const;
export type RewriteBatchSourceType = (typeof REWRITE_BATCH_SOURCE_TYPES)[number];

export const REWRITE_BATCH_SOURCE_LABELS: Record<RewriteBatchSourceType, string> = {
  link_list: '粘贴链接清单',
  remote: '关键词全网搜索',
};

export const REWRITE_BATCH_STATUS_LABELS: Record<TaskStatusName, string> = {
  QUEUED: '排队中',
  RUNNING: '寻源复刻中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已终止',
};

const URL_IN_KEYWORD_RE =
  /^(?:https?:\/\/|ftp:\/\/|www\.)|(?:^|\s)(?:mp\.weixin\.qq\.com|zhuanlan\.zhihu\.com|zhihu\.com|baijiahao\.baidu\.com|sohu\.com|163\.com|csdn\.net|jianshu\.com)\/\S+/i;

const BARE_DOMAIN_WITH_PATH_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+$/i;

export function looksLikeUrlNotKeyword(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (URL_IN_KEYWORD_RE.test(trimmed)) return true;
  if (BARE_DOMAIN_WITH_PATH_RE.test(trimmed)) return true;
  return false;
}

export function isPrivateOrReservedHostLiteral(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::'
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
    if (parts.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
    if (a !== undefined && a >= 224) return true;
  }
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
      return true;
    }
  }
  return false;
}

const VIDEO_HOSTS = new Set([
  'v.qq.com',
  'www.bilibili.com',
  'bilibili.com',
  'b23.tv',
  'www.douyin.com',
  'douyin.com',
  'v.douyin.com',
  'www.ixigua.com',
  'ixigua.com',
  'www.kuaishou.com',
  'kuaishou.com',
  'v.youku.com',
  'www.iqiyi.com',
]);

const ECOMMERCE_HOSTS = new Set([
  'item.taobao.com',
  'world.taobao.com',
  'detail.tmall.com',
  'item.jd.com',
  'pro.m.jd.com',
  'mobile.yangkeduo.com',
  'yangkeduo.com',
]);

const LOGIN_PATH_RE =
  /(?:^|\/)(?:login|signin|sign-in|passport|oauth|sso|auth\/login|account\/login)(?:\/|$|\?)/i;

export function checkBatchCandidateExclusion(canonicalUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return '链接格式无效';
  }
  const host = parsed.hostname.toLowerCase();
  if (
    VIDEO_HOSTS.has(host) ||
    (host.endsWith('.bilibili.com') && parsed.pathname.startsWith('/video'))
  ) {
    return '视频页面不支持正文复刻';
  }
  if (ECOMMERCE_HOSTS.has(host)) {
    return '电商商品详情页不支持正文复刻';
  }
  if (LOGIN_PATH_RE.test(parsed.pathname)) {
    return '登录/鉴权页面不支持公开抓取';
  }
  return null;
}

export type ParsedBatchLinkCandidate = {
  line: number;
  url: string;
  urlHash: string;
};

export type BatchLinkLineIssue = {
  line: number;
  raw: string;
  reason: string;
};

export type ParsedBatchLinkList = {
  candidates: ParsedBatchLinkCandidate[];
  invalidLines: BatchLinkLineIssue[];
  excludedLines: BatchLinkLineIssue[];
  duplicateLines: number[];
  nonEmptyCount: number;
};

export function parseBatchLinkList(
  rawInput: string | readonly string[],
  maxLinks = REWRITE_BATCH_LINK_LIST_MAX,
): ParsedBatchLinkList {
  const lines =
    typeof rawInput === 'string'
      ? rawInput.split(/\r?\n/)
      : rawInput.flatMap((entry) => String(entry).split(/\r?\n/));

  const candidates: ParsedBatchLinkCandidate[] = [];
  const invalidLines: BatchLinkLineIssue[] = [];
  const excludedLines: BatchLinkLineIssue[] = [];
  const duplicateLines: number[] = [];
  const seenHashes = new Set<string>();
  let nonEmptyCount = 0;

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    nonEmptyCount += 1;
    const lineNo = index + 1;

    let canonical: string;
    try {
      canonical = canonicalizeRewriteUrl(trimmed);
    } catch (err) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed.slice(0, 120),
        reason: err instanceof Error ? err.message : '链接格式无效',
      });
      return;
    }

    let host = '';
    try {
      host = new URL(canonical).hostname;
    } catch {
      invalidLines.push({
        line: lineNo,
        raw: trimmed.slice(0, 120),
        reason: '链接域名无效',
      });
      return;
    }

    if (isPrivateOrReservedHostLiteral(host) || !host.includes('.')) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed.slice(0, 120),
        reason: '仅支持公网可访问域名链接，内网与本地地址已拦截',
      });
      return;
    }

    const exclusion = checkBatchCandidateExclusion(canonical);
    if (exclusion) {
      excludedLines.push({
        line: lineNo,
        raw: trimmed.slice(0, 120),
        reason: exclusion,
      });
      return;
    }

    const urlHash = computeRewriteUrlHash(canonical);
    if (seenHashes.has(urlHash)) {
      duplicateLines.push(lineNo);
      return;
    }
    if (candidates.length >= maxLinks) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed.slice(0, 120),
        reason: `单次链接清单最多支持 ${maxLinks} 条有效不重复链接`,
      });
      return;
    }

    seenHashes.add(urlHash);
    candidates.push({ line: lineNo, url: canonical, urlHash });
  });

  return {
    candidates,
    invalidLines,
    excludedLines,
    duplicateLines,
    nonEmptyCount,
  };
}

export function buildDefaultBatchCategoryName(batchName: string): string {
  const clean =
    batchName
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 32) || '批量爆文';
  if (clean.endsWith('（复刻）') || clean.endsWith('(复刻)')) {
    return clean;
  }
  return `${clean}（复刻）`;
}

export function resolveRewriteBatchTimeouts(env: Record<string, string | undefined>): {
  batchTimeoutMs: number;
  itemTimeoutMs: number;
} {
  const rawBatch = Number(env.REWRITE_BATCH_TIMEOUT_MS);
  const batchTimeoutMs =
    Number.isFinite(rawBatch) && rawBatch >= 500 && rawBatch <= 3_600_000
      ? Math.floor(rawBatch)
      : REWRITE_BATCH_TIMEOUT_MS_DEFAULT;

  const rawItem = Number(env.REWRITE_BATCH_ITEM_TIMEOUT_MS);
  const itemTimeoutMs =
    Number.isFinite(rawItem) && rawItem >= 200 && rawItem <= 300_000
      ? Math.floor(rawItem)
      : REWRITE_BATCH_ITEM_TIMEOUT_MS_DEFAULT;

  return { batchTimeoutMs, itemTimeoutMs };
}

export function batchRewriteImageCountForText(charCount: number): number {
  return charCount > 600 ? 2 : 1;
}

const optionalIdField = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return undefined;
    return val;
  })
  .refine((val) => val === undefined || REWRITE_ID_PATTERN.test(val), '编号格式不正确');

export const rewriteBatchCreateSchema = z
  .object({
    name: z
      .string({ required_error: '请填写任务名称' })
      .trim()
      .min(1, '请填写任务名称')
      .max(REWRITE_BATCH_NAME_MAX, `任务名称不超过 ${REWRITE_BATCH_NAME_MAX} 个字符`),
    maxCount: z
      .number({ required_error: '请填写最大改写量' })
      .int('最大改写量必须为整数')
      .min(REWRITE_BATCH_MAX_COUNT_MIN, `最大改写量至少 ${REWRITE_BATCH_MAX_COUNT_MIN} 篇`)
      .max(REWRITE_BATCH_MAX_COUNT_MAX, `最大改写量不超过 ${REWRITE_BATCH_MAX_COUNT_MAX} 篇`),
    sourceType: z.enum(REWRITE_BATCH_SOURCE_TYPES).default('link_list'),
    keyword: z.string().trim().max(120, '流量关键词不超过 120 个字符').optional().default(''),
    linkList: z.array(z.string()).max(200, '提交链接行数过多').optional().default([]),
    linksText: z.string().max(30_000, '链接清单内容过长').optional(),
    mediaCategoryId: optionalIdField.transform((val) => val ?? null),
    templateId: z
      .string({ required_error: '请选择爆文改写指令' })
      .trim()
      .regex(REWRITE_ID_PATTERN, '请选择有效的爆文改写指令'),
    categoryId: optionalIdField,
    brand: z.string().trim().max(40, '品牌名称不超过 40 个字符').optional(),
    resultStatus: z.enum(REWRITE_RESULT_STATUSES).default('PENDING'),
  })
  .superRefine((val, ctx) => {
    if (val.sourceType === 'remote') {
      if (!val.keyword.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keyword'],
          message: '关键词搜索模式下请填写流量关键词',
        });
        return;
      }
      if (looksLikeUrlNotKeyword(val.keyword)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keyword'],
          message: REWRITE_BATCH_URL_AS_KEYWORD_MSG,
        });
      }
      return;
    }

    // link_list mode
    if (val.keyword && looksLikeUrlNotKeyword(val.keyword)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyword'],
        message: REWRITE_BATCH_URL_AS_KEYWORD_MSG,
      });
    }

    const rawLines =
      val.linksText !== undefined && val.linksText.trim().length > 0 ? val.linksText : val.linkList;
    const parsed = parseBatchLinkList(rawLines, REWRITE_BATCH_LINK_LIST_MAX);

    if (parsed.nonEmptyCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkList'],
        message: '请至少粘贴 1 条公开文章链接（一行一条）',
      });
      return;
    }

    if (parsed.invalidLines.length > 0) {
      const first = parsed.invalidLines[0]!;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkList'],
        message: `第 ${first.line} 行链接不合法：${first.reason}`,
      });
      return;
    }

    if (parsed.candidates.length === 0) {
      const firstExcluded = parsed.excludedLines[0];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkList'],
        message: firstExcluded
          ? `全部候选链接均不可用于正文复刻（第 ${firstExcluded.line} 行：${firstExcluded.reason}）`
          : '没有可用的有效文章链接',
      });
    }
  });

export type RewriteBatchCreateInput = {
  name: string;
  maxCount: number;
  sourceType?: RewriteBatchSourceType;
  keyword?: string;
  linkList?: string[];
  linksText?: string;
  mediaCategoryId?: string | null;
  templateId: string;
  categoryId?: string | null;
  brand?: string;
  resultStatus?: RewriteResultStatusName;
};

export const rewriteBatchBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().trim().regex(REWRITE_ID_PATTERN, '任务编号不合法'))
    .min(1, '请至少选择一条批量复刻任务')
    .max(100, '单次最多操作 100 条任务'),
});

export type RewriteBatchBulkDeleteInput = z.infer<typeof rewriteBatchBulkDeleteSchema>;

export type RewriteBatchItem = {
  id: string;
  name: string;
  keyword: string;
  sourceType: RewriteBatchSourceType;
  maxCount: number;
  doneCount: number;
  candidateCount: number;
  failedOrSkippedCount: number;
  categoryId: string;
  categoryName: string | null;
  mediaCategoryId: string | null;
  mediaCategoryName: string | null;
  templateId: string;
  templateName: string | null;
  status: TaskStatusName;
  note: string | null;
  unitPoints: number;
  reservedPoints: number;
  settledPoints: number;
  releasedPoints: number;
  createdAt: string;
};

export type RewriteBatchDetailResponse = {
  batch: RewriteBatchItem;
  records: RewriteRecordItem[];
};

export type RewriteBatchListQuery = {
  page: number;
  pageSize: CrudPageSize;
  keyword?: string;
  status?: TaskStatusName;
  sourceType?: RewriteBatchSourceType;
};

export type RewriteBatchListResponse = {
  page: number;
  pageSize: number;
  total: number;
  unitPoints: number;
  remoteSearchEnabled: boolean;
  items: RewriteBatchItem[];
};

export function parseRewriteBatchListQuery(raw: Record<string, unknown>): RewriteBatchListQuery {
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

  const sourceType =
    typeof raw.sourceType === 'string' &&
    (REWRITE_BATCH_SOURCE_TYPES as readonly string[]).includes(raw.sourceType)
      ? (raw.sourceType as RewriteBatchSourceType)
      : undefined;

  return { page, pageSize, keyword, status, sourceType };
}

export function rewriteBatchExportTable(items: readonly RewriteBatchItem[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: [
      '任务名称',
      '寻源方式',
      '流量关键词',
      '最大改写量',
      '当前完成量',
      '状态',
      '预冻点数',
      '已结点数',
      '已退点数',
      '文章分类',
      '备注说明',
      '添加时间',
    ],
    rows: items.map((item) => [
      item.name,
      REWRITE_BATCH_SOURCE_LABELS[item.sourceType] ?? item.sourceType,
      item.keyword || '—',
      String(item.maxCount),
      String(item.doneCount),
      REWRITE_BATCH_STATUS_LABELS[item.status] ?? item.status,
      String(item.reservedPoints),
      String(item.settledPoints),
      String(item.releasedPoints),
      item.categoryName ?? '',
      item.note ?? '',
      item.createdAt,
    ]),
  };
}
