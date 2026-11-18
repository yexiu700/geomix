import { FAKE_MARK } from './adapters';
import { SHADOW_TITLE_SUFFIX } from './billing';
import {
  formatShortDisplayId,
  isOpaqueEntityId,
  replaceUxJargon,
  sanitizeEntityTitleSegment,
} from './ux-foundation';

/**
 * 账本明细（#201）与 LLM 成本日报（#202）共享 UX 净化与格式化工具。
 * 复用 `ux-foundation.ts` 的 CUID 脱敏、UTC+8 时区与黑话替换能力。
 */

const REASONING_TAG_CLOSED_RE = /<(think|thinking|thought|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi;
const REASONING_TAG_OPEN_RE = /<(think|thinking|thought|reasoning)\b[^>]*>[\s\S]*$/gi;

const LEDGER_COT_LEAK_PATTERNS: readonly RegExp[] = [
  /<\/?(?:think|thinking|thought|reasoning)\b/i,
  /商业视觉配图提示词编辑/,
  /配图提示词编辑/,
  /JSON\s*生成器/,
  /用户的简短描述/,
  /用户需要把/,
  /扩写成配图提示词/,
  /扩写为一段/,
  /硬性约束/,
  /核心约束/,
  /字数控制/,
  /字数要求/,
  /80\s*[-~到至]\s*220/,
  /不输出引号/,
  /多余解释/,
  /真人正脸(?:肖像)?/,
  /公众人物/,
  /(?:任何)?品牌商标\s*Logo/i,
  /(?:不出现|不能出现|禁止|避免).*(?:品牌|Logo|真人|正脸|商标|文字海报)/i,
  /避免品牌名/,
  /思考过程/,
  /推理过程/,
  /内心独白/,
  /首先拆解/,
  /首先分析/,
  /下面开始构思/,
  /满足以下约束/,
  /遵守以下规则/,
  /检查是否符合/,
  /^(?:好的[，,]?|明白[，,]?|思考[:：]|分析[:：]|草稿[:：]|内部思考[:：]|以下(?:是|为)(?:您)?(?:优化|生成|扩写))/,
  /(?:品牌名|字数|约束|规则|要求|硬性)[？?]/,
  /\b(?:let me|i need to|the user wants|system prompt|hard constraint|thinking process|step\s*\d+:)\b/i,
];

const KNOWN_LEDGER_PREFIXES = [
  'AI生图',
  'AI写作',
  '知识库加价',
  '单篇复刻',
  '批量爆文复刻',
  'AI蒸馏拓展',
  'AI可见性监测',
] as const;

const INTERNAL_MODEL_TOKEN_RE = /^(?:fake(?:[-_].*)?|mock(?:[-_].*)?|deterministic[-_]fallback)$/i;

export function stripLedgerReasoningTags(raw: string): string {
  return raw
    .replace(REASONING_TAG_CLOSED_RE, ' ')
    .replace(REASONING_TAG_OPEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsLedgerReasoningLeak(text: string | null | undefined): boolean {
  const normalized = text?.trim() ?? '';
  if (!normalized) return false;
  if (normalized.includes(FAKE_MARK)) return true;
  return LEDGER_COT_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function splitLedgerPrefix(core: string): { prefix: string | null; subject: string } {
  for (const prefix of KNOWN_LEDGER_PREFIXES) {
    const marker = `${prefix}-`;
    if (core.startsWith(marker)) {
      return { prefix, subject: core.slice(marker.length).trim() };
    }
    if (core === prefix) {
      return { prefix, subject: '' };
    }
  }
  return { prefix: null, subject: core };
}

/**
 * 净化点数/余额流水项目标题：
 * - 剥离大模型 `<think>` 标签与 CoT 推理链文本；
 * - 保留规范业务前缀（如 `AI生图` / `AI写作`）与 `（免费期）` 尾缀；
 * - 替换研发黑话。
 */
export function sanitizeLedgerTitle(rawTitle: string | null | undefined): string {
  const raw = rawTitle?.trim() ?? '';
  if (!raw) return '系统记录';

  const hasShadowSuffix = raw.endsWith(SHADOW_TITLE_SUFFIX);
  const withoutShadow = hasShadowSuffix
    ? raw.slice(0, raw.length - SHADOW_TITLE_SUFFIX.length).trim()
    : raw;

  const { prefix, subject } = splitLedgerPrefix(withoutShadow);

  const strippedSubject = replaceUxJargon(stripLedgerReasoningTags(subject));
  const rawHadReasoning =
    containsLedgerReasoningLeak(subject) ||
    REASONING_TAG_CLOSED_RE.test(subject) ||
    REASONING_TAG_OPEN_RE.test(subject);

  let cleanCore: string;
  if (prefix) {
    if (!strippedSubject || rawHadReasoning || containsLedgerReasoningLeak(strippedSubject)) {
      cleanCore = prefix;
    } else {
      cleanCore = `${prefix}-${strippedSubject}`;
    }
  } else {
    const strippedCore = replaceUxJargon(stripLedgerReasoningTags(withoutShadow));
    if (
      !strippedCore ||
      containsLedgerReasoningLeak(withoutShadow) ||
      containsLedgerReasoningLeak(strippedCore)
    ) {
      cleanCore = '系统任务';
    } else {
      cleanCore = strippedCore;
    }
  }

  return hasShadowSuffix ? `${cleanCore}${SHADOW_TITLE_SUFFIX}` : cleanCore;
}

/**
 * 净化流水说明/备注：移除思维链标签与内部标记，替换研发黑话。
 */
export function sanitizeLedgerRemark(rawRemark: string | null | undefined): string {
  const raw = rawRemark?.trim() ?? '';
  if (!raw) return '';
  const stripped = replaceUxJargon(stripLedgerReasoningTags(raw)).replaceAll(FAKE_MARK, '').trim();
  if (!stripped || containsLedgerReasoningLeak(stripped)) {
    return '系统结算记录';
  }
  return stripped;
}

/**
 * 生成 AI 生图点数流水的安全标题，避免 CoT 提示词文本写入账本。
 */
export function buildImageLedgerTitle(rawPrompt: string | null | undefined): string {
  const raw = rawPrompt?.trim() ?? '';
  if (!raw) return 'AI生图';
  const stripped = stripLedgerReasoningTags(raw);
  if (!stripped || containsLedgerReasoningLeak(raw) || containsLedgerReasoningLeak(stripped)) {
    return 'AI生图';
  }
  const shortPrompt = stripped.slice(0, 24).trim();
  return shortPrompt ? `AI生图-${shortPrompt}` : 'AI生图';
}

/**
 * 净化 LLM 成本日报中的服务商展示名：对管理员屏蔽内部 `fake` / `mock` 桩标识。
 */
export function formatLlmProviderDisplayLabel(
  provider: string | null | undefined,
  fake = false,
): string {
  const trimmed = provider?.trim() ?? '';
  if (fake || !trimmed || INTERNAL_MODEL_TOKEN_RE.test(trimmed)) {
    return '内置模拟引擎';
  }
  return trimmed;
}

/**
 * 净化 LLM 成本日报中的模型展示名：隐藏 `fake` / `fake-quality` / `fake-cheap` / `deterministic-fallback`。
 */
export function formatLlmModelDisplayLabel(model: string | null | undefined, fake = false): string {
  const trimmed = model?.trim() ?? '';
  const lower = trimmed.toLowerCase();
  if (fake || !trimmed || INTERNAL_MODEL_TOKEN_RE.test(trimmed)) {
    if (lower.includes('quality')) return '内置高质量模拟';
    if (lower.includes('cheap')) return '内置轻量模拟';
    return '内置模拟模型';
  }
  return trimmed;
}

/**
 * 净化 LLM 成本日报中的租户展示名：禁止暴露原始 CUID/UUID，缺失名称时使用友好短编号兜底。
 */
export function formatLlmTenantDisplayName(
  tenantName: string | null | undefined,
  tenantId: string | null | undefined,
): string {
  const trimmedId = tenantId?.trim() ?? '';
  if (trimmedId === 'system' || !trimmedId) {
    return sanitizeEntityTitleSegment(tenantName, '系统任务');
  }
  const fallback = isOpaqueEntityId(trimmedId)
    ? formatShortDisplayId(trimmedId, '租户')
    : trimmedId;
  return sanitizeEntityTitleSegment(tenantName, fallback);
}

/**
 * 统一千分位整数格式化（用于调用次数、Token 计数与微元数值）。
 */
export function formatCountNumber(value: number | null | undefined): string {
  const safe = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  return safe.toLocaleString('en-US');
}

/**
 * 统一人民币元格式（带千分位与 `¥` 前缀，保留小数位）。
 */
export function formatYuanAmount(value: string | number | null | undefined): string {
  const raw = typeof value === 'number' ? value.toFixed(4) : (value?.trim() ?? '0.0000');
  if (!raw) return '¥0.0000';
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [wholePart = '0', fracPart] = body.split('.');
  const parsedWhole = Number(wholePart);
  const formattedWhole = Number.isFinite(parsedWhole)
    ? parsedWhole.toLocaleString('en-US')
    : wholePart;
  const suffix = fracPart !== undefined ? `.${fracPart}` : '';
  return `${negative ? '-' : ''}¥${formattedWhole}${suffix}`;
}
