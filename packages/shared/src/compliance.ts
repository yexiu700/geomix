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

const CN_SENSITIVE_TERM_SET = new Set<string>(CN_SENSITIVE_TERMS);
const CN_PROHIBITED_TERM_SET = new Set<string>(CN_PROHIBITED_INDUSTRY_TERMS);

/**
 * 在消费硬件/网络安全/存储科普评测场景中，部分安全风险词常出现在正当的「防御、隔离、识别、避坑」语境下。
 * 仅当文本中该词的**每一次**出现均位于明确防护/避坑上下文且不含违法教唆/交易/攻击信号时才免于硬拦截；
 * 只要任意一处落入无防护上下文或高危教唆语境，依然严格硬拦截。
 */
const CN_DEFENSE_CONTEXT_TERMS = new Set<string>(['勒索软件', '木马程序', '窃听', '偷拍']);
const CN_DEFENSE_POSITIVE_PATTERN =
  /(?:防|防护|防御|抵御|抵抗|防范|防止|预防|隔离|拦截|查杀|杀毒|安全|保护|快照|备份|容灾|恢复|还原|扫描|检测|识别|排查|清理|清除|反窃听|反偷拍|加密攻击|病毒|风险|威胁|漏洞|告警|不可变|WORM|抗勒索|防勒索)/i;
const CN_DEFENSE_MALICIOUS_PATTERN =
  /(?:制作|开发|编写|出售|售卖|购买|下载源码|源码|教程|植入|投放|传播|免杀|后门植入|攻击他人|入侵他人|勒索赎金|偷拍设备|窃听器|窃听设备|针孔摄像头购买)/;

const CN_HARDWARE_AVOIDANCE_TERMS = new Set<string>(['虚拟币']);
const CN_HARDWARE_POSITIVE_PATTERN =
  /(?:二手|矿盘|矿机|清零盘|翻新|避坑|鉴别|识别|检测|排查|通电时间|SMART|寿命|损耗|硬盘|存储|NAS|显卡|拆机|报废|防范|警示|科普|风险)/i;
const CN_HARDWARE_MALICIOUS_PATTERN =
  /(?:交易|交易所|炒作|投资|理财|收益|挖矿教程|买币|卖币|发币|空投|合约|杠杆|开户|入金|提现|高回报|暴富|推广|代投)/;

const GLOBAL_DEFENSE_CONTEXT_LABELS = new Set<string>(['ransomware', 'malware', 'spyware']);
const GLOBAL_DEFENSE_POSITIVE_PATTERN =
  /\b(?:anti-?|protect(?:ion|ing|s|ed)?|defen[ds]|defensive|prevent(?:ion|ing|s|ed)?|mitigat(?:e|ion|ing)|guard(?:ing|s)?|shield(?:ing|s)?|detect(?:ion|ing|s)?|scan(?:ning|ner|s)?|remov(?:e|al|ing)|clean(?:ing)?|recover(?:y|ing)?|backups?|snapshots?|immutable|worm|security|cybersecurity|safeguard|resilien(?:ce|t)|block(?:ing|s)?|quarantine|threats?|risks?|against)\b/i;
const GLOBAL_DEFENSE_MALICIOUS_PATTERN =
  /\b(?:buy|sell|create|build|write|deploy|spread|distribute|infect|launder|download\s+(?:free\s+)?(?:ransomware|malware|spyware)|exploit\s+kit|payload|how\s+to\s+hack)\b/i;

const CONTEXT_WINDOW_CHARS = 48;

function extractLocalContextWindow(input: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT_WINDOW_CHARS);
  const to = Math.min(input.length, end + CONTEXT_WINDOW_CHARS);
  const raw = input.slice(from, to);
  // Prefer the sentence/clause containing the match so neighboring unrelated sentences cannot spoof context
  const relStart = start - from;
  const relEnd = end - from;
  let clauseStart = 0;
  for (let i = relStart - 1; i >= 0; i -= 1) {
    const ch = raw[i];
    if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      clauseStart = i + 1;
      break;
    }
  }
  let clauseEnd = raw.length;
  for (let i = relEnd; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      clauseEnd = i;
      break;
    }
  }
  return raw.slice(clauseStart, clauseEnd);
}

function isSubstringOnlyInSafeContext(
  input: string,
  term: string,
  positivePattern: RegExp,
  maliciousPattern: RegExp,
): boolean {
  let foundAny = false;
  let pos = 0;
  while (pos < input.length) {
    const idx = input.indexOf(term, pos);
    if (idx === -1) break;
    foundAny = true;
    const windowText = extractLocalContextWindow(input, idx, idx + term.length);
    if (maliciousPattern.test(windowText) || !positivePattern.test(windowText)) {
      return false;
    }
    pos = idx + term.length;
  }
  return foundAny;
}

function isRegexOnlyInSafeContext(
  input: string,
  pattern: RegExp,
  positivePattern: RegExp,
  maliciousPattern: RegExp,
): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let foundAny = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    foundAny = true;
    const windowText = extractLocalContextWindow(input, match.index, match.index + match[0].length);
    if (maliciousPattern.test(windowText) || !positivePattern.test(windowText)) {
      return false;
    }
  }
  return foundAny;
}

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

export type ComplianceBlockMessageContext = 'generate' | 'rewrite' | 'input';

/**
 * 根据命中的规则词表标签构造可读、可操作的合规拦截提示。
 * 仅回传受控词表中的分类与命中标签（最多前 5 项），绝不回显用户隐私原文。
 */
export function formatComplianceBlockMessage(
  blockedTerms: readonly string[],
  options?: { market?: GeoMarket; context?: ComplianceBlockMessageContext },
): string {
  const uniqueTerms = Array.from(
    new Set(
      blockedTerms
        .map((term) => term.trim())
        .filter((term) => term.length > 0 && term !== 'invalid'),
    ),
  );
  const context = options?.context ?? 'input';
  const sensitiveTerms = uniqueTerms.filter(
    (term) => CN_SENSITIVE_TERM_SET.has(term) || GLOBAL_DEFENSE_CONTEXT_LABELS.has(term),
  );
  const industryTerms = uniqueTerms.filter(
    (term) => CN_PROHIBITED_TERM_SET.has(term) && !sensitiveTerms.includes(term),
  );
  const highRiskGlobalTerms = uniqueTerms.filter(
    (term) => !sensitiveTerms.includes(term) && !industryTerms.includes(term),
  );

  const detailParts: string[] = [];
  if (industryTerms.length > 0) {
    const shown = industryTerms.slice(0, 5).join('、');
    const suffix = industryTerms.length > 5 ? ` 等 ${industryTerms.length} 项` : '';
    detailParts.push(`禁做行业词：${shown}${suffix}`);
  }
  if (sensitiveTerms.length > 0) {
    const shown = sensitiveTerms.slice(0, 5).join('、');
    const suffix = sensitiveTerms.length > 5 ? ` 等 ${sensitiveTerms.length} 项` : '';
    detailParts.push(`高危敏感词：${shown}${suffix}`);
  }
  if (highRiskGlobalTerms.length > 0) {
    const shown = highRiskGlobalTerms.slice(0, 5).join('、');
    const suffix = highRiskGlobalTerms.length > 5 ? ` 等 ${highRiskGlobalTerms.length} 项` : '';
    detailParts.push(`高危违规词：${shown}${suffix}`);
  }

  const detailText = detailParts.length > 0 ? `（命中${detailParts.join('；')}）` : '';
  const hasDefenseAdjustable = uniqueTerms.some(
    (term) =>
      CN_DEFENSE_CONTEXT_TERMS.has(term) ||
      CN_HARDWARE_AVOIDANCE_TERMS.has(term) ||
      GLOBAL_DEFENSE_CONTEXT_LABELS.has(term),
  );
  const suggestion = hasDefenseAdjustable
    ? '建议改用「快照防勒索/安全隔离/识别二手翻新盘」等明确防护或避坑科普表述后重试'
    : '建议移除上述涉敏词或调整选题方向后重试';

  if (context === 'generate') {
    return `生成结果命中合规拦截规则${detailText}，已拦截并退还本次点数。${suggestion}`;
  }
  if (context === 'rewrite') {
    return `改写结果命中合规拦截规则${detailText}，已拦截。${suggestion}`;
  }
  return `包含禁做行业或敏感内容${detailText}。${suggestion}`;
}

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
    if (!input.includes(term)) continue;
    if (
      CN_HARDWARE_AVOIDANCE_TERMS.has(term) &&
      isSubstringOnlyInSafeContext(
        input,
        term,
        CN_HARDWARE_POSITIVE_PATTERN,
        CN_HARDWARE_MALICIOUS_PATTERN,
      )
    ) {
      continue;
    }
    pushBlocked(term, `命中禁做行业词「${term}」`);
  }
  for (const term of CN_SENSITIVE_TERMS) {
    if (!input.includes(term)) continue;
    if (
      CN_DEFENSE_CONTEXT_TERMS.has(term) &&
      isSubstringOnlyInSafeContext(
        input,
        term,
        CN_DEFENSE_POSITIVE_PATTERN,
        CN_DEFENSE_MALICIOUS_PATTERN,
      )
    ) {
      continue;
    }
    pushBlocked(term, `命中高危敏感词「${term}」`);
  }
  for (const rule of GLOBAL_PROHIBITED_PATTERNS) {
    if (!rule.pattern.test(input)) continue;
    if (
      GLOBAL_DEFENSE_CONTEXT_LABELS.has(rule.label) &&
      isRegexOnlyInSafeContext(
        input,
        rule.pattern,
        GLOBAL_DEFENSE_POSITIVE_PATTERN,
        GLOBAL_DEFENSE_MALICIOUS_PATTERN,
      )
    ) {
      continue;
    }
    pushBlocked(rule.label, `Matched prohibited high-risk term "${rule.label}"`);
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

/**
 * 扫描 CN 广告法极限词与绝对化用语（只读提示，不改写原文）。
 * 供发布前 Preflight 门禁输出 `CN_AD_LAW_WARNING` 软告警使用。
 */
export function scanCnAdLawWarnings(input: string): GeoComplianceFlag[] {
  if (typeof input !== 'string' || !input) return [];
  const flags: GeoComplianceFlag[] = [];
  const seenTerms = new Set<string>();

  for (const rule of CN_AD_LAW_REPLACEMENTS) {
    const globalFlags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`;
    const re = new RegExp(rule.pattern.source, globalFlags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const matched = m[0];
      if (seenTerms.has(matched)) continue;
      seenTerms.add(matched);
      flags.push({
        code: 'AD_LAW_SUPERLATIVE',
        market: 'CN',
        term: matched,
        replacement: rule.to,
        severity: 'warning',
        message: `检测到广告法极限词「${matched}」，建议替换为「${rule.to}」`,
      });
    }
  }

  for (const rule of CN_AD_LAW_FLAGS) {
    if (!rule.pattern.test(input) || seenTerms.has(rule.label)) continue;
    seenTerms.add(rule.label);
    flags.push({
      code: 'AD_LAW_FLAG',
      market: 'CN',
      term: rule.label,
      severity: 'warning',
      message: `包含需谨慎核验的绝对化用语「${rule.label}」`,
    });
  }

  return flags;
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
