import { z } from 'zod';
import { CRUD_ORDERS, CRUD_PAGE_SIZES, type CrudOrder, type CrudPageSize } from './crud';

export const KEYWORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const KEYWORD_MAIN_MIN = 3;
export const KEYWORD_MAIN_MAX = 40;
export const KEYWORD_BRAND_MAX = 40;
export const KEYWORD_BRANDS_LIMIT = 20;
export const DISTILL_MIN_VALID_DEFAULT = 5;
export const DISTILL_MAX_KEEP = 50;
export const KEYWORD_EMPTY_MAIN_MSG = '请输入主关键词';

export const KEYWORD_OPT_STATUSES = ['NONE', 'OPTIMIZING', 'INCLUDED'] as const;
export type KeywordOptStatusName = (typeof KEYWORD_OPT_STATUSES)[number];

export const QUESTION_SOURCES = ['AI', 'MANUAL', 'COMBO'] as const;
export type QuestionSourceName = (typeof QUESTION_SOURCES)[number];

export const KEYWORD_OPT_LABELS: Record<KeywordOptStatusName, string> = {
  NONE: '未优化',
  OPTIMIZING: '优化中',
  INCLUDED: '已收录',
};

export type KeywordQuestionInputItem = {
  text: string;
  source?: QuestionSourceName;
};

export type KeywordRecord = {
  id: string;
  main: string;
  brands: string[];
  optStatus: KeywordOptStatusName;
  questionCount: number;
  createdAt: string;
};

export type KeywordDetailRecord = KeywordRecord & {
  questions: Array<{
    id: string;
    text: string;
    source: QuestionSourceName;
    included: boolean;
    usedCount: number;
    createdAt: string;
  }>;
};

export function validateMainKeyword(
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') {
    return { ok: false, message: KEYWORD_EMPTY_MAIN_MSG };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: KEYWORD_EMPTY_MAIN_MSG };
  }
  if (/[,，\r\n]/.test(trimmed)) {
    return { ok: false, message: '主关键词只能填一个，不能包含逗号或换行' };
  }
  if ([...trimmed].length < KEYWORD_MAIN_MIN) {
    return { ok: false, message: `主关键词不少于 ${KEYWORD_MAIN_MIN} 个字` };
  }
  if ([...trimmed].length > KEYWORD_MAIN_MAX) {
    return { ok: false, message: `主关键词不超过 ${KEYWORD_MAIN_MAX} 个字` };
  }
  return { ok: true, value: trimmed };
}

export function parseBrandsInput(raw: string | readonly string[] | undefined): string[] {
  const parts =
    typeof raw === 'string'
      ? raw.split(/[,，\r\n]+/)
      : Array.isArray(raw)
        ? raw.flatMap((item) => (typeof item === 'string' ? item.split(/[,，\r\n]+/) : []))
        : [];
  const seen = new Set<string>();
  const brands: string[] = [];
  for (const part of parts) {
    const clean = part.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    brands.push(clean.slice(0, KEYWORD_BRAND_MAX));
    if (brands.length >= KEYWORD_BRANDS_LIMIT) break;
  }
  return brands;
}

/** 全角 ASCII 转半角、去空白、去掉末尾问号后用于去重比较。 */
export function normalizeQuestionKey(raw: string): string {
  let out = '';
  for (const ch of raw.trim()) {
    const code = ch.charCodeAt(0);
    if (code === 0x3000) {
      continue;
    }
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out
    .replace(/\s+/g, '')
    .replace(/[?？。！!；;，,]+$/g, '')
    .toLowerCase();
}

export function cleanQuestionDisplay(raw: string): string {
  let out = '';
  for (const ch of raw.trim()) {
    const code = ch.charCodeAt(0);
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e && ch !== '？' && ch !== '，') {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function parseQuestionsLines(
  questionsText: string,
  sourceMap?: ReadonlyMap<string, QuestionSourceName>,
): { unique: Array<{ text: string; source: QuestionSourceName }>; skippedDuplicates: number } {
  const lines = questionsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const seen = new Set<string>();
  const unique: Array<{ text: string; source: QuestionSourceName }> = [];
  let skippedDuplicates = 0;

  for (const line of lines) {
    const display = cleanQuestionDisplay(line);
    if (!display) continue;
    const key = normalizeQuestionKey(display);
    if (!key) continue;
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(key);
    const source = sourceMap?.get(key) ?? sourceMap?.get(display) ?? 'MANUAL';
    unique.push({ text: display, source });
  }
  return { unique, skippedDuplicates };
}

export function extractJsonStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    candidates.push(trimmed.slice(bracketStart, bracketEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'questions' in parsed &&
        Array.isArray((parsed as { questions: unknown }).questions)
      ) {
        return (parsed as { questions: unknown[] }).questions.filter(
          (item): item is string => typeof item === 'string',
        );
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

export function cleanDistilledQuestions(input: {
  rawCandidates: readonly string[];
  main: string;
  brands: readonly string[];
  existingQuestions?: readonly string[];
  isBlockedOrExtreme?: (text: string) => boolean;
  maxKeep?: number;
}): string[] {
  const mainNeedle = normalizeQuestionKey(input.main);
  if (!mainNeedle) return [];
  const brandNeedles = input.brands
    .map((brand) => normalizeQuestionKey(brand))
    .filter((brand) => brand.length > 0 && !mainNeedle.includes(brand));
  const seen = new Set<string>(
    (input.existingQuestions ?? []).map((item) => normalizeQuestionKey(item)).filter(Boolean),
  );
  const maxKeep = input.maxKeep ?? DISTILL_MAX_KEEP;
  const maxChars = Math.max(30, [...input.main.trim()].length + 16);
  const minChars = Math.min(8, [...input.main.trim()].length + 2);
  const valid: string[] = [];

  for (const raw of input.rawCandidates) {
    const display = cleanQuestionDisplay(raw);
    if (!display) continue;
    const charLen = [...display].length;
    if (charLen < minChars || charLen > maxChars) continue;
    const key = normalizeQuestionKey(display);
    if (!key || seen.has(key)) continue;
    if (!key.includes(mainNeedle)) continue;
    if (brandNeedles.some((brand) => key.includes(brand))) continue;
    if (input.isBlockedOrExtreme?.(display)) continue;
    seen.add(key);
    valid.push(display);
    if (valid.length >= maxKeep) break;
  }

  return valid;
}

/** 假模型开发态下围绕主词生成合规咨询问题候选，供蒸馏后处理验证。 */
export function buildFakeDistillCandidates(main: string): string[] {
  const m = main.trim();
  return [
    `${m}哪家服务比较靠谱？`,
    `如何选择适合企业的${m}方案？`,
    `${m}一般收费标准是多少？`,
    `国内做${m}的源头厂家有哪些特点？`,
    `中小团队采购${m}需要注意哪些细节？`,
    `定制化${m}与通用方案有什么区别？`,
    `本地${m}上门对接流程是怎样的？`,
    `评估${m}口碑时主要看哪几个指标？`,
    `性价比高的${m}应该怎么挑选？`,
    `初次合作${m}项目周期通常要多久？`,
    `不同规格的${m}应用场景有哪些差异？`,
    `${m}后期维护与售后支持包含什么内容？`,
  ];
}

export const keywordDistillSchema = z.object({
  main: z.string(),
  brands: z.union([z.string(), z.array(z.string())]).optional(),
  region: z.string().max(40).optional(),
});

export const keywordQuestionSourceItemSchema = z.object({
  text: z.string().min(1).max(120),
  source: z.enum(QUESTION_SOURCES).optional(),
});

export const keywordSaveSchema = z.object({
  main: z.string(),
  brands: z.union([z.string(), z.array(z.string())]).optional(),
  questionsText: z.string().max(100_000).optional().default(''),
  questionItems: z.array(keywordQuestionSourceItemSchema).max(2000).optional(),
});

export const keywordBulkSchema = z.object({
  action: z.literal('delete'),
  ids: z.array(z.string().regex(KEYWORD_ID_PATTERN)).min(1).max(100),
});

export type KeywordListQuery = {
  page: number;
  pageSize: CrudPageSize;
  keyword: string;
  optStatus?: KeywordOptStatusName;
  sort: 'createdAt' | 'main';
  order: CrudOrder;
  export?: 'csv' | 'xlsx';
};

export function parseKeywordListQuery(raw: Record<string, unknown>): KeywordListQuery {
  const page = Number(raw.page ?? 1);
  const pageSize = Number(raw.pageSize ?? 10);
  const safePage = Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  const safePageSize = (CRUD_PAGE_SIZES as readonly number[]).includes(pageSize)
    ? (pageSize as CrudPageSize)
    : 10;
  const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim().slice(0, 80) : '';
  const optStatus =
    typeof raw.optStatus === 'string' &&
    (KEYWORD_OPT_STATUSES as readonly string[]).includes(raw.optStatus)
      ? (raw.optStatus as KeywordOptStatusName)
      : undefined;
  const sort = raw.sort === 'main' ? 'main' : 'createdAt';
  const order =
    typeof raw.order === 'string' && (CRUD_ORDERS as readonly string[]).includes(raw.order)
      ? (raw.order as CrudOrder)
      : 'desc';
  const exp = raw.export === 'csv' || raw.export === 'xlsx' ? raw.export : undefined;
  return { page: safePage, pageSize: safePageSize, keyword, optStatus, sort, order, export: exp };
}

export function keywordExportTable(rows: readonly KeywordRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['主词', '公司/品牌', '问题数量', '优化状态', '创建时间'],
    rows: rows.map((row) => [
      row.main,
      row.brands.join('，'),
      String(row.questionCount),
      KEYWORD_OPT_LABELS[row.optStatus],
      row.createdAt.replace('T', ' ').slice(0, 19),
    ]),
  };
}
