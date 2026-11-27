/**
 * 控制台极简文案长度计算与判定规则（见 docs/极简交互规范.md）：
 * - 控件文案（标题、表头、按钮、Tab、筛选、标签）上限 4 字
 * - 内联说明文案上限 8 字，超过 8 字须收进 <Explain> (ⓘ)
 */
export const CONTROL_LABEL_MAX_CHARS = 4 as const;
export const EXPLAIN_INLINE_MAX_CHARS = 8 as const;

const ABBREVIATION_TOKEN_RE =
  /(?:JSON-LD|llms\.txt|Near-Miss|GLOBAL|Schema|robots\.txt|robots|XLSX|DOCX|HTML|JSON|ROI|GEO|URL|SKU|API|FAQ|DiD|SoV|TBD|CSV|PDF|SSE|KOL|HTTP|AI|PR|CN|MD|L1|L2|L3|T\+\d+)/gi;

const CJK_OR_FULLWIDTH_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;
const ASCII_LETTER_RE = /[A-Za-z]/;

/**
 * 按极简交互规范计算文案视觉字数：
 * - 每个汉字及全角符号计 1
 * - 常见缩写词与 T+N 计 1
 * - 其余连续英文字母每 2 个计 1（单个字母计 0.5）
 * - 数字、空格与半角符号计 0
 */
export function copyLength(input: string | null | undefined): number {
  if (!input) return 0;
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;

  let total = 0;
  const remainder = normalized.replace(ABBREVIATION_TOKEN_RE, () => {
    total += 1;
    return ' ';
  });

  for (const ch of remainder) {
    if (CJK_OR_FULLWIDTH_RE.test(ch)) {
      total += 1;
    } else if (ASCII_LETTER_RE.test(ch)) {
      total += 0.5;
    }
  }

  return Math.round(total * 2) / 2;
}

export function isControlLabelWithinLimit(
  input: string | null | undefined,
  maxChars: number = CONTROL_LABEL_MAX_CHARS,
): boolean {
  return copyLength(input) <= maxChars;
}

export function shouldCollapseToExplain(
  input: string | null | undefined,
  inlineMaxChars: number = EXPLAIN_INLINE_MAX_CHARS,
): boolean {
  return copyLength(input) > inlineMaxChars;
}
