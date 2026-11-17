/**
 * 关键词手动批量组合纯函数与免费拓词词包（自写中性词汇）。
 * 前后端共用，不访问网络、不调用模型、不扣点。
 */

export const COMBO_MAX = 1000;
export const EMPTY_MAIN_KEYWORD_MSG = '请输入主训练词';

export type ComboBuildInput = {
  mainKeyword: string;
  prefixesText: string;
  mainsText: string;
  suffixesText: string;
  includeEmptyPrefix?: boolean;
  includeEmptySuffix?: boolean;
  maxItems?: number;
};

export type ComboBuildSuccess = {
  ok: true;
  items: string[];
  prefixCount: number;
  mainCount: number;
  suffixCount: number;
  rawCount: number;
  truncated: boolean;
};

export type ComboBuildFailure = {
  ok: false;
  error: string;
  invalidMainLines: number[];
};

export type ComboBuildResult = ComboBuildSuccess | ComboBuildFailure;

export type ExpanderWordPack = {
  key: 'region' | 'service' | 'question' | 'recommend';
  label: string;
  target: 'prefix' | 'suffix';
  words: readonly string[];
};

/** 自写中性拓词词包：地域、服务（前缀）；疑问、推荐（后缀）。 */
export const EXPANDER_WORD_PACKS: readonly ExpanderWordPack[] = [
  {
    key: 'region',
    label: '地域词（前缀）',
    target: 'prefix',
    words: ['华东地区', '华南地区', '北京', '上海', '深圳', '广州', '杭州', '苏州'],
  },
  {
    key: 'service',
    label: '服务词（前缀）',
    target: 'prefix',
    words: ['企业级', '定制化', '一站式', '高性价比', '本地上门', '专业源头'],
  },
  {
    key: 'question',
    label: '疑问词（后缀）',
    target: 'suffix',
    words: ['哪家好', '怎么选', '收费标准', '一般多少钱', '有哪些注意事项', '靠谱吗'],
  },
  {
    key: 'recommend',
    label: '推荐词（后缀）',
    target: 'suffix',
    words: ['厂家推荐', '服务商盘点', '口碑对比', '选型指南', '合作流程', '实用方案'],
  },
] as const;

function splitColumnOptions(raw: string, includeExplicitEmpty: boolean): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.trim() === '') {
    return [''];
  }
  const rawLines = normalized.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (includeExplicitEmpty && !seen.has('')) {
        seen.add('');
        result.push('');
      }
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  if (includeExplicitEmpty && !seen.has('')) {
    seen.add('');
    result.push('');
  }
  return result.length > 0 ? result : [''];
}

export function buildKeywordCombos(input: ComboBuildInput): ComboBuildResult {
  const mainKeyword = input.mainKeyword.trim();
  if (!mainKeyword) {
    return { ok: false, error: EMPTY_MAIN_KEYWORD_MSG, invalidMainLines: [] };
  }

  const mainsNormalized = input.mainsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawMainLines = mainsNormalized.split('\n');
  const invalidMainLines: number[] = [];
  const mainOptions: string[] = [];
  const mainSeen = new Set<string>();
  const needle = mainKeyword.toLowerCase();

  rawMainLines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    if (!trimmed.toLowerCase().includes(needle)) {
      invalidMainLines.push(idx + 1);
      return;
    }
    if (!mainSeen.has(trimmed)) {
      mainSeen.add(trimmed);
      mainOptions.push(trimmed);
    }
  });

  if (invalidMainLines.length > 0) {
    return {
      ok: false,
      error: `第 ${invalidMainLines.join('、')} 行主词必须包含主训练词「${mainKeyword}」`,
      invalidMainLines,
    };
  }

  if (mainOptions.length === 0) {
    return {
      ok: false,
      error: '主词栏至少填写一行包含主训练词的内容',
      invalidMainLines: [],
    };
  }

  const hasPrefixInput = input.prefixesText.trim() !== '' || Boolean(input.includeEmptyPrefix);
  const hasSuffixInput = input.suffixesText.trim() !== '' || Boolean(input.includeEmptySuffix);
  if (!hasPrefixInput && !hasSuffixInput) {
    return {
      ok: false,
      error: '前缀和后缀至少填写一栏',
      invalidMainLines: [],
    };
  }

  const prefixOptions = splitColumnOptions(input.prefixesText, Boolean(input.includeEmptyPrefix));
  const suffixOptions = splitColumnOptions(input.suffixesText, Boolean(input.includeEmptySuffix));

  const maxItems = input.maxItems ?? COMBO_MAX;
  const rawCount = prefixOptions.length * mainOptions.length * suffixOptions.length;
  const items: string[] = [];
  const seenCombo = new Set<string>();
  let truncated = false;

  outer: for (const prefix of prefixOptions) {
    for (const main of mainOptions) {
      for (const suffix of suffixOptions) {
        const text = `${prefix}${main}${suffix}`.trim();
        if (!text || seenCombo.has(text)) continue;
        if (items.length >= maxItems) {
          truncated = true;
          break outer;
        }
        seenCombo.add(text);
        items.push(text);
      }
    }
  }

  return {
    ok: true,
    items,
    prefixCount: prefixOptions.length,
    mainCount: mainOptions.length,
    suffixCount: suffixOptions.length,
    rawCount,
    truncated: truncated || rawCount > maxItems,
  };
}
