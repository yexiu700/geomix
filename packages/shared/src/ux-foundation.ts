import type { TaskStatusName } from './writing-tasks';

/**
 * 公共 UX 底座常量与统一工具（跨模块共性规范单一事实源）
 * - 时间展示：统一使用 Asia/Shanghai（UTC+8，北京时间）格式化
 * - 主键脱敏：自动识别 CUID / UUID 等不透明主键，严禁暴露给终端用户标题或标签栏
 * - 术语与状态：沉淀核心产品标准术语、可见度诊断专属状态文案与研发黑话净化映射
 */

export const UX_TIMEZONE = 'Asia/Shanghai' as const;

const SHANGHAI_DATETIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: UX_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface FormatShanghaiDateTimeOptions {
  /** 是否保留秒（默认 false，输出 YYYY-MM-DD HH:mm） */
  seconds?: boolean;
  /** 空值或非法时间兜底文案（默认 '—'） */
  fallback?: string;
}

function parseValidDate(input: string | Date | number | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // 若已经是纯日期 YYYY-MM-DD，按东八区零点解析避免跨日偏移
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const parsed = new Date(`${trimmed}T00:00:00+08:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * 将任意时间输入统一格式化为北京时间（UTC+8）`YYYY-MM-DD HH:mm` 或 `YYYY-MM-DD HH:mm:ss`
 */
export function formatShanghaiDateTime(
  input: string | Date | number | null | undefined,
  options?: FormatShanghaiDateTimeOptions,
): string {
  const fallback = options?.fallback ?? '—';
  const date = parseValidDate(input);
  if (!date) return fallback;

  const parts = SHANGHAI_DATETIME_FORMATTER.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const y = map.year ?? '0000';
  const m = map.month ?? '01';
  const d = map.day ?? '01';
  const hh = map.hour === '24' ? '00' : (map.hour ?? '00');
  const mm = map.minute ?? '00';
  if (options?.seconds) {
    const ss = map.second ?? '00';
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 将任意时间输入统一格式化为北京时间（UTC+8）日期 `YYYY-MM-DD`
 */
export function formatShanghaiDate(
  input: string | Date | number | null | undefined,
  fallback = '—',
): string {
  const full = formatShanghaiDateTime(input, { fallback });
  return full === fallback ? fallback : full.slice(0, 10);
}

const CUID_LIKE_RE = /^c[a-z0-9]{20,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_OR_RANDOM_ID_RE = /^[a-z0-9]{22,}$/i;

/**
 * 判断字符串是否为数据库主键（CUID / CUID2 / UUID / ULID / 长随机串）。
 * 短语义标识（如 demo、kw_1、c1、vprof_1、pic_1）不会被误判为不透明主键。
 */
export function isOpaqueEntityId(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (UUID_RE.test(trimmed)) return true;
  if (CUID_LIKE_RE.test(trimmed)) return true;
  if (ULID_OR_RANDOM_ID_RE.test(trimmed) && /\d/.test(trimmed) && /[a-z]/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * 对用于页面标题、面包屑或标签栏的实体标识进行脱敏：
 * 若为 CUID / UUID 等不透明主键，则返回友好的业务兜底词。
 */
export function sanitizeEntityTitleSegment(
  rawValue: string | null | undefined,
  fallbackLabel: string,
): string {
  const trimmed = rawValue?.trim() ?? '';
  if (!trimmed || isOpaqueEntityId(trimmed)) {
    return fallbackLabel;
  }
  return trimmed;
}

/**
 * 检测文本中是否包含裸露的 CUID 主键片段
 */
export function containsRawCuid(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bc[a-z0-9]{20,}\b/i.test(text);
}

/**
 * 将数据库不透明主键格式化为友好的短编号（例如 `图片 #J67890` 或 `#J67890`），
 * 对人类可读短标识（如 `tenant-a`）原样保留。
 */
export function formatShortDisplayId(rawId: string | null | undefined, prefix = ''): string {
  const trimmed = rawId?.trim() ?? '';
  if (!trimmed) return prefix || '—';
  if (!isOpaqueEntityId(trimmed)) {
    return trimmed;
  }
  const shortCode = `#${trimmed.slice(-6).toUpperCase()}`;
  return prefix ? `${prefix} ${shortCode}` : shortCode;
}

/**
 * 核心产品标准术语表（跨页面统一命名）
 */
export const UX_TERMS = {
  gallery: '企业画像图库',
  galleryCategory: '图库分类',
  mainKeyword: '主关键词',
  articleCategoryName: '分类名称',
  billingShadow: '免费体验期',
  billingStrict: '正式计费',
  manualSlotBadge: '含对比品牌槽位·仅手动选用',
  systemManualSlotBadge: '含手工槽位·不入随机池',
  postGenerateArticleStatus: '生成后文章状态',
  viewSavedArticle: '查看文章',
  exportEmptyNotice: '当前列表暂无可导出数据',
} as const;

/**
 * AI 可见度诊断模块专属任务状态文案（避免误用 AI 写作模块的「创作中/创作完成」）
 */
export const VISIBILITY_TASK_STATUS_LABELS: Record<TaskStatusName, string> = {
  QUEUED: '排队中',
  RUNNING: '监测中',
  PAUSED: '已暂停',
  COMPLETED: '监测完成',
  PARTIAL: '部分完成',
  FAILED: '监测失败',
  CANCELLED: '已终止',
};

const INTERNAL_DEBUG_TOKEN_RE =
  /(?:^|[:/_\-\s])(?:fake|mock)(?:$|[:/_\-\sa-z0-9]*)|deterministic[-_](?:fallback|skip|domain|citation|judge|rule)/i;

/**
 * 判断采集器标识是否属于模拟/演示桩（fake / mock 等）
 */
export function isSimulatedCollectorKind(kind: string | null | undefined): boolean {
  const trimmed = kind?.trim() ?? '';
  if (!trimmed) return false;
  return INTERNAL_DEBUG_TOKEN_RE.test(trimmed);
}

/**
 * 净化采集器标识：将 fake/mock 显式标识为「模拟演示采集」，将真实采集通道映射为可读中文名称
 */
export function formatCollectorDisplayLabel(kind: string | null | undefined): string | null {
  const trimmed = kind?.trim() ?? '';
  if (!trimmed) return null;
  if (INTERNAL_DEBUG_TOKEN_RE.test(trimmed)) {
    return '模拟演示采集';
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'llm_api') {
    return '大模型直连采集';
  }
  if (lower === 'remote_scraper') {
    return '联网搜索采集';
  }
  if (lower === 'live' || lower === 'real') {
    return '实时引擎采集';
  }
  return trimmed;
}

/**
 * 净化判别模型标识：对商户隐藏 `deterministic-*` / `fake-*` / `mock-*` 等内部实现标记
 */
export function formatJudgeModelDisplayLabel(model: string | null | undefined): string | null {
  const trimmed = model?.trim() ?? '';
  if (!trimmed) return null;
  if (INTERNAL_DEBUG_TOKEN_RE.test(trimmed)) {
    return '规则语义判别';
  }
  return trimmed;
}

/**
 * 去除充值提示中的重复「联系客服」尾缀
 */
export function dedupeRechargeNotice(notice: string | null | undefined): string {
  const trimmed = notice?.trim() ?? '';
  if (!trimmed) return '如需充值请联系客服人工办理';
  return trimmed.replace(/（充值请联系客服）$/u, '').trim();
}

const UX_JARGON_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/影子计费（免费期）/g, UX_TERMS.billingShadow],
  [/免费影子计费期/g, UX_TERMS.billingShadow],
  [/影子计费期/g, `${UX_TERMS.billingShadow}`],
  [/影子计费/g, UX_TERMS.billingShadow],
  [/零拷贝转存/g, '一键转存'],
  [/零拷贝关联/g, '直接关联'],
  [/零拷贝/g, '免重复占空间'],
  [/整单预冻/g, '预冻'],
  [/已落库查看/g, UX_TERMS.viewSavedArticle],
  [/复刻落库状态/g, UX_TERMS.postGenerateArticleStatus],
];

/**
 * 将动态文案或历史种子文案中的研发黑话替换为面向用户的通俗产品表达
 */
export function replaceUxJargon(text: string): string {
  let out = text;
  for (const [pattern, replacement] of UX_JARGON_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
