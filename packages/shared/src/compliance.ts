import type { GeoMarket } from './brands';

/**
 * GeoMix 2.0 双轨合规引擎（Issue #331, F13, D14）。
 * - CN 轨：执行中国广告法（禁做行业硬拦截 + 极限词替换/标记）
 * - GLOBAL 轨：执行 FTC 客观评测规范（仅拦截违法高危词，绝不替换或拦截 Best / Top / #1 / 100% 实测规格）
 * - 双轨均支持租户级 customForbiddenWords 替换与结构化 GeoComplianceFlag[] 输出。
 */

export type GeoComplianceFlagCode =
  'PROHIBITED_INDUSTRY' | 'AD_LAW_SUPERLATIVE' | 'AD_LAW_FLAG' | 'CUSTOM_FORBIDDEN' | 'FTC_NOTICE';

export type GeoComplianceFlag = {
  code: GeoComplianceFlagCode;
  market: GeoMarket;
  term: string;
  replacement?: string;
  severity: 'blocked' | 'replaced' | 'warning' | 'info';
  message: string;
};

export type DualTrackComplianceOptions = {
  market?: GeoMarket;
  customForbiddenWords?: readonly string[];
};

export type DualTrackComplianceReport = {
  market: GeoMarket;
  blocked: boolean;
  text: string;
  blockedTerms: string[];
  flags: GeoComplianceFlag[];
};

export class ProhibitedContentError extends Error {
  readonly blockedTerms: string[];
  readonly report: DualTrackComplianceReport;

  constructor(report: DualTrackComplianceReport, message = '包含禁做行业或违法高危内容') {
    super(message);
    this.name = 'ProhibitedContentError';
    this.blockedTerms = report.blockedTerms;
    this.report = report;
  }
}

export const CN_PROHIBITED_INDUSTRY_TERMS = [
  '赌博',
  '博彩',
  '六合彩',
  '私彩',
  '非法赌博',
  '洗钱',
  '色情',
  '淫秽',
  '卖淫',
  '毒品',
  '冰毒',
  '大麻',
  '枪支',
  '弹药',
  '炸药',
  '传销',
  '假币',
  '假证',
  '代开发票',
  '迷药',
  '民营医院',
  '男科',
  '妇科',
  '不孕不育',
  '整形医美',
  '包治百病',
  '祖传秘方',
  '网贷',
  '高利贷',
  '校园贷',
  '现金贷',
  '套路贷',
  '网贷催收',
  '非法催收',
  '虚拟币',
  '炒币',
  '外汇配资',
  '场外配资',
  '非法集资',
  '电子烟',
  '烟草代购',
] as const;

export const CN_SENSITIVE_TERMS = ['窃听', '偷拍', '勒索软件', '木马程序'] as const;

export const GLOBAL_PROHIBITED_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:illegal\s+)?firearms?\b/i, label: 'firearms' },
  { pattern: /\billegal\s+weapons?\b/i, label: 'illegal weapons' },
  { pattern: /\bweapons?\b/i, label: 'weapons' },
  { pattern: /\bexplosives?\b/i, label: 'explosives' },
  { pattern: /\bammunition\b/i, label: 'ammunition' },
  { pattern: /\bcocaine\b/i, label: 'cocaine' },
  { pattern: /\bheroin\b/i, label: 'heroin' },
  { pattern: /\bmethamphetamine\b/i, label: 'methamphetamine' },
  { pattern: /\bfentanyl\b/i, label: 'fentanyl' },
  { pattern: /\billegal\s+drugs?\b/i, label: 'illegal drugs' },
  { pattern: /\bnarcotics?\b/i, label: 'narcotics' },
  { pattern: /\bonline\s+fraud\b/i, label: 'online fraud' },
  { pattern: /\bfraud\s+guide\b/i, label: 'fraud guide' },
  { pattern: /\bwire\s+fraud\b/i, label: 'wire fraud' },
  { pattern: /\bcredit\s+card\s+fraud\b/i, label: 'credit card fraud' },
  { pattern: /\bmoney\s+laundering\b/i, label: 'money laundering' },
  { pattern: /\bcounterfeit\s+(?:money|currency)\b/i, label: 'counterfeit currency' },
  { pattern: /\bransomware\b/i, label: 'ransomware' },
  { pattern: /\bmalware\b/i, label: 'malware' },
  { pattern: /\bspyware\b/i, label: 'spyware' },
  { pattern: /\bchild\s+pornography\b/i, label: 'child pornography' },
  { pattern: /\bcsam\b/i, label: 'csam' },
  { pattern: /\bhuman\s+trafficking\b/i, label: 'human trafficking' },
  { pattern: /\billegal\s+gambling\b/i, label: 'illegal gambling' },
];

type AdLawReplacementRule = {
  pattern: RegExp;
  to: string;
  label: string;
};

const CN_AD_LAW_REPLACEMENTS: ReadonlyArray<AdLawReplacementRule> = [
  { pattern: /100\s*%|百分之百/g, to: '较高比例', label: '100%' },
  { pattern: /国家级/g, to: '行业内', label: '国家级' },
  { pattern: /世界级/g, to: '较高水平', label: '世界级' },
  { pattern: /独一无二|史无前例|首屈一指|绝无仅有/g, to: '有特点', label: '独一无二' },
  { pattern: /唯一选择/g, to: '优选方案', label: '唯一选择' },
  { pattern: /最好|最强|最佳|最低价|最高级|最先进|最优|最顶级/g, to: '较好', label: '最' },
  { pattern: /顶级|顶配|极品/g, to: '高水平', label: '顶级' },
  { pattern: /极致/g, to: '细致', label: '极致' },
  {
    pattern: /全网第一|行业第一|销量第一|排名第一|第一品牌|第一名/g,
    to: '较为靠前',
    label: '第一',
  },
];

const CN_AD_LAW_FLAGS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /绝对/, label: '绝对' },
  { pattern: /永久/, label: '永久' },
];

const GLOBAL_FTC_NOTICE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bmiracle\s+cure\b/i, label: 'miracle cure' },
  { pattern: /\bguaranteed\s+to\s+cure\b/i, label: 'guaranteed to cure' },
  { pattern: /\bcures?\s+cancer\b/i, label: 'cures cancer' },
  { pattern: /\bguaranteed\s+1000%\s+profit\b/i, label: 'guaranteed profit' },
  { pattern: /\brisk-free\s+guaranteed\s+return\b/i, label: 'risk-free guaranteed return' },
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiOnly(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/**
 * 双轨合规扫描纯函数：
 * - `CN`：严格执行中国广告法（禁做行业拦截 + 极限词替换 + 绝对/永久标记）
 * - `GLOBAL`：执行 FTC 客观评测规范（保留 Best / Top / #1 / 100% 实测规格；拦截违法高危词）
 * - 双轨均执行租户自定义禁词替换（`customForbiddenWords`）。
 */
export function scanDualTrackCompliance(
  input: string,
  options?: DualTrackComplianceOptions,
): DualTrackComplianceReport {
  const market: GeoMarket = options?.market === 'GLOBAL' ? 'GLOBAL' : 'CN';

  if (typeof input !== 'string') {
    return {
      market,
      blocked: true,
      text: '',
      blockedTerms: ['invalid'],
      flags: [
        {
          code: 'PROHIBITED_INDUSTRY',
          market,
          term: 'invalid',
          severity: 'blocked',
          message: '内容格式异常，已拦截',
        },
      ],
    };
  }

  const blockedTerms: string[] = [];
  const blockedSet = new Set<string>();
  const flags: GeoComplianceFlag[] = [];

  const pushBlocked = (term: string, message: string) => {
    if (blockedSet.has(term)) return;
    blockedSet.add(term);
    blockedTerms.push(term);
    flags.push({
      code: 'PROHIBITED_INDUSTRY',
      market,
      term,
      severity: 'blocked',
      message,
    });
  };

  for (const term of CN_PROHIBITED_INDUSTRY_TERMS) {
    if (input.includes(term)) {
      pushBlocked(term, `命中禁做行业词「${term}」`);
    }
  }
  for (const term of CN_SENSITIVE_TERMS) {
    if (input.includes(term)) {
      pushBlocked(term, `命中高危敏感词「${term}」`);
    }
  }
  for (const rule of GLOBAL_PROHIBITED_PATTERNS) {
    if (rule.pattern.test(input)) {
      pushBlocked(rule.label, `Matched prohibited high-risk term "${rule.label}"`);
    }
  }

  if (blockedTerms.length > 0) {
    return {
      market,
      blocked: true,
      text: '',
      blockedTerms,
      flags,
    };
  }

  let text = input;

  if (market === 'CN') {
    for (const rule of CN_AD_LAW_REPLACEMENTS) {
      let hitCount = 0;
      text = text.replace(rule.pattern, () => {
        hitCount += 1;
        return rule.to;
      });
      if (hitCount > 0) {
        flags.push({
          code: 'AD_LAW_SUPERLATIVE',
          market,
          term: rule.label,
          replacement: rule.to,
          severity: 'replaced',
          message: `已按中国广告法将「${rule.label}」替换为「${rule.to}」`,
        });
      }
    }
    for (const rule of CN_AD_LAW_FLAGS) {
      if (rule.pattern.test(text)) {
        flags.push({
          code: 'AD_LAW_FLAG',
          market,
          term: rule.label,
          severity: 'warning',
          message: `包含需谨慎核验的绝对化用语「${rule.label}」`,
        });
      }
    }
  } else {
    // GLOBAL track: FTC objectivity — NEVER alter/block Best, Top, #1, or factual 100% specs.
    for (const rule of GLOBAL_FTC_NOTICE_PATTERNS) {
      if (rule.pattern.test(text)) {
        flags.push({
          code: 'FTC_NOTICE',
          market,
          term: rule.label,
          severity: 'info',
          message: `FTC objectivity notice: verify substantiation for "${rule.label}"`,
        });
      }
    }
  }

  const normalizedCustom = Array.from(
    new Set((options?.customForbiddenWords ?? []).map((w) => w.trim()).filter((w) => w.length > 0)),
  );
  // Sort longest first to avoid partial overlap replacements
  normalizedCustom.sort((a, b) => b.length - a.length);

  for (const word of normalizedCustom) {
    const escaped = escapeRegExp(word);
    const pattern = new RegExp(escaped, isAsciiOnly(word) ? 'gi' : 'g');
    let hitCount = 0;
    const candidateReplacement = market === 'GLOBAL' ? 'notable option' : '主流方案';
    const safeReplacement = normalizedCustom.some((w) =>
      candidateReplacement.toLowerCase().includes(w.toLowerCase()),
    )
      ? ''
      : candidateReplacement;

    text = text.replace(pattern, () => {
      hitCount += 1;
      return safeReplacement;
    });
    if (hitCount > 0) {
      flags.push({
        code: 'CUSTOM_FORBIDDEN',
        market,
        term: word,
        replacement: safeReplacement,
        severity: 'replaced',
        message: `已替换租户自定义禁词「${word}」`,
      });
    }
  }

  return {
    market,
    blocked: false,
    text,
    blockedTerms: [],
    flags,
  };
}

export function assertNoProhibitedContent(
  input: string,
  options?: DualTrackComplianceOptions,
): DualTrackComplianceReport {
  const report = scanDualTrackCompliance(input, options);
  if (report.blocked) {
    throw new ProhibitedContentError(report);
  }
  return report;
}

/**
 * 跨行内标签片段合规替换：按原始字符偏移将命中的 CN 极限词或租户自定义禁词精准回写到对应文本节点，
 * 避免 `全网<b>第一</b>` / `国<em>家</em>级` 类行内标签拆分绕过合规替换。
 */
export function replaceComplianceInTextSegments(
  segments: readonly string[],
  options?: DualTrackComplianceOptions,
): { segments: string[]; flags: GeoComplianceFlag[] } {
  const market: GeoMarket = options?.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
  const current = [...segments];
  const flags: GeoComplianceFlag[] = [];

  if (current.length === 0) {
    return { segments: current, flags };
  }

  const applyRuleAcrossSegments = (pattern: RegExp, replacement: string): number => {
    const segStarts: number[] = [];
    const segEnds: number[] = [];
    let offset = 0;
    for (const seg of current) {
      segStarts.push(offset);
      offset += seg.length;
      segEnds.push(offset);
    }
    const joined = current.join('');
    if (!joined) return 0;

    const globalFlags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, globalFlags);
    const matches: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (matches.length === 0) return 0;

    for (let idx = matches.length - 1; idx >= 0; idx -= 1) {
      const { start, end } = matches[idx]!;
      let placedReplacement = false;
      for (let s = 0; s < current.length; s += 1) {
        const sStart = segStarts[s]!;
        const sEnd = segEnds[s]!;
        if (sEnd <= start) continue;
        if (sStart >= end) break;
        const localStart = Math.max(start, sStart) - sStart;
        const localEnd = Math.min(end, sEnd) - sStart;
        const segText = current[s]!;
        const insert = placedReplacement ? '' : replacement;
        current[s] = segText.slice(0, localStart) + insert + segText.slice(localEnd);
        placedReplacement = true;
      }
    }

    return matches.length;
  };

  if (market === 'CN') {
    for (const rule of CN_AD_LAW_REPLACEMENTS) {
      const hits = applyRuleAcrossSegments(rule.pattern, rule.to);
      if (hits > 0) {
        flags.push({
          code: 'AD_LAW_SUPERLATIVE',
          market,
          term: rule.label,
          replacement: rule.to,
          severity: 'replaced',
          message: `已按中国广告法将「${rule.label}」替换为「${rule.to}」`,
        });
      }
    }
    const afterCn = current.join('');
    for (const rule of CN_AD_LAW_FLAGS) {
      if (rule.pattern.test(afterCn)) {
        flags.push({
          code: 'AD_LAW_FLAG',
          market,
          term: rule.label,
          severity: 'warning',
          message: `包含需谨慎核验的绝对化用语「${rule.label}」`,
        });
      }
    }
  } else {
    const joinedGlobal = current.join('');
    for (const rule of GLOBAL_FTC_NOTICE_PATTERNS) {
      if (rule.pattern.test(joinedGlobal)) {
        flags.push({
          code: 'FTC_NOTICE',
          market,
          term: rule.label,
          severity: 'info',
          message: `FTC objectivity notice: verify substantiation for "${rule.label}"`,
        });
      }
    }
  }

  const normalizedCustom = Array.from(
    new Set((options?.customForbiddenWords ?? []).map((w) => w.trim()).filter((w) => w.length > 0)),
  );
  normalizedCustom.sort((a, b) => b.length - a.length);

  for (const word of normalizedCustom) {
    const escaped = escapeRegExp(word);
    const pattern = new RegExp(escaped, isAsciiOnly(word) ? 'gi' : 'g');
    const candidateReplacement = market === 'GLOBAL' ? 'notable option' : '主流方案';
    const safeReplacement = normalizedCustom.some((w) =>
      candidateReplacement.toLowerCase().includes(w.toLowerCase()),
    )
      ? ''
      : candidateReplacement;

    const hits = applyRuleAcrossSegments(pattern, safeReplacement);
    if (hits > 0) {
      flags.push({
        code: 'CUSTOM_FORBIDDEN',
        market,
        term: word,
        replacement: safeReplacement,
        severity: 'replaced',
        message: `已替换租户自定义禁词「${word}」`,
      });
    }
  }

  return { segments: current, flags };
}
