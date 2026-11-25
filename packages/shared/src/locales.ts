import { z } from 'zod';

/**
 * GeoMix v2.2 轻量多语种目录、防误判语言泄漏检测与写作指令解析（Issue #367 / #370）：
 * - 零内部相对导入（DAG Layer 0 叶子模块）
 * - 支持 zh-CN 与 GLOBAL 6 语种（en-US / en-GB / de-DE / ja-JP / es-ES / fr-FR）
 * - ja-JP 双信号检测（简体中文独有字符 + 缺失假名比例异常），消除日语汉字误报
 */

export const LOCALE_SCRIPT_FAMILIES = ['CJK_ZH', 'LATIN', 'JAPANESE'] as const;
export type LocaleScriptFamily = (typeof LOCALE_SCRIPT_FAMILIES)[number];

export const SUPPORTED_LOCALE_CODES = [
  'zh-CN',
  'en-US',
  'en-GB',
  'de-DE',
  'ja-JP',
  'es-ES',
  'fr-FR',
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALE_CODES)[number];

export const CN_SUPPORTED_LOCALES = ['zh-CN'] as const;
export const GLOBAL_SUPPORTED_LOCALES = [
  'en-US',
  'en-GB',
  'de-DE',
  'ja-JP',
  'es-ES',
  'fr-FR',
] as const;

export type LocaleComplianceNoticeKey =
  | 'CN_AD_LAW'
  | 'GLOBAL_FTC'
  | 'GLOBAL_UK_ASA'
  | 'GLOBAL_EU_UWG'
  | 'GLOBAL_JP_KEIHYOHO'
  | 'GLOBAL_EU_ES'
  | 'GLOBAL_EU_FR';

export type LocaleMeta = {
  code: SupportedLocale;
  market: 'CN' | 'GLOBAL';
  scriptFamily: LocaleScriptFamily;
  nativeLabel: string;
  labelZh: string;
  htmlLang: string;
  complianceNoticeKey: LocaleComplianceNoticeKey;
};

export const SUPPORTED_LOCALES: Record<SupportedLocale, LocaleMeta> = {
  'zh-CN': {
    code: 'zh-CN',
    market: 'CN',
    scriptFamily: 'CJK_ZH',
    nativeLabel: '简体中文',
    labelZh: '简体中文',
    htmlLang: 'zh-CN',
    complianceNoticeKey: 'CN_AD_LAW',
  },
  'en-US': {
    code: 'en-US',
    market: 'GLOBAL',
    scriptFamily: 'LATIN',
    nativeLabel: 'English (US)',
    labelZh: '英语（美国）',
    htmlLang: 'en-US',
    complianceNoticeKey: 'GLOBAL_FTC',
  },
  'en-GB': {
    code: 'en-GB',
    market: 'GLOBAL',
    scriptFamily: 'LATIN',
    nativeLabel: 'English (UK)',
    labelZh: '英语（英国）',
    htmlLang: 'en-GB',
    complianceNoticeKey: 'GLOBAL_UK_ASA',
  },
  'de-DE': {
    code: 'de-DE',
    market: 'GLOBAL',
    scriptFamily: 'LATIN',
    nativeLabel: 'Deutsch',
    labelZh: '德语（德国）',
    htmlLang: 'de-DE',
    complianceNoticeKey: 'GLOBAL_EU_UWG',
  },
  'ja-JP': {
    code: 'ja-JP',
    market: 'GLOBAL',
    scriptFamily: 'JAPANESE',
    nativeLabel: '日本語',
    labelZh: '日语（日本）',
    htmlLang: 'ja-JP',
    complianceNoticeKey: 'GLOBAL_JP_KEIHYOHO',
  },
  'es-ES': {
    code: 'es-ES',
    market: 'GLOBAL',
    scriptFamily: 'LATIN',
    nativeLabel: 'Español',
    labelZh: '西班牙语（西班牙）',
    htmlLang: 'es-ES',
    complianceNoticeKey: 'GLOBAL_EU_ES',
  },
  'fr-FR': {
    code: 'fr-FR',
    market: 'GLOBAL',
    scriptFamily: 'LATIN',
    nativeLabel: 'Français',
    labelZh: '法语（法国）',
    htmlLang: 'fr-FR',
    complianceNoticeKey: 'GLOBAL_EU_FR',
  },
};

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALE_CODES);

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALE_CODES);

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALE_SET.has(value.trim());
}

export function supportedLocalesForMarket(market: 'CN' | 'GLOBAL'): readonly SupportedLocale[] {
  return market === 'CN' ? CN_SUPPORTED_LOCALES : GLOBAL_SUPPORTED_LOCALES;
}

export function resolveEffectiveLocale(
  targetLocale: string | null | undefined,
  market: 'CN' | 'GLOBAL' = 'GLOBAL',
): SupportedLocale {
  if (typeof targetLocale === 'string') {
    const trimmed = targetLocale.trim();
    if (SUPPORTED_LOCALE_SET.has(trimmed)) {
      return trimmed as SupportedLocale;
    }
    const lower = trimmed.toLowerCase();
    for (const code of SUPPORTED_LOCALE_CODES) {
      if (code.toLowerCase() === lower) {
        return code;
      }
    }
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('ja')) return 'ja-JP';
    if (lower.startsWith('de')) return 'de-DE';
    if (lower.startsWith('es')) return 'es-ES';
    if (lower.startsWith('fr')) return 'fr-FR';
    if (lower === 'en-gb') return 'en-GB';
    if (lower.startsWith('en')) return 'en-US';
  }
  return market === 'CN' ? 'zh-CN' : 'en-US';
}

export function getLocaleMeta(locale: SupportedLocale | string): LocaleMeta {
  const effective = resolveEffectiveLocale(locale, 'GLOBAL');
  return SUPPORTED_LOCALES[effective];
}

export type LocaleLeakageReason =
  'LATIN_CJK_LEAK' | 'JA_SIMPLIFIED_CHINESE_LEAK' | 'JA_MISSING_KANA';

export type LocaleLeakageResult = {
  leaked: boolean;
  targetLocale: SupportedLocale;
  scriptFamily: LocaleScriptFamily;
  reason: LocaleLeakageReason | null;
  samples: string[];
};

const LATIN_FORBIDDEN_CJK_OR_KANA_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]+/g;
const KANJI_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const KANJI_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const HIRAGANA_CHAR_RE = /[\u3040-\u309f]/g;
const KANA_CHAR_RE = /[\u3040-\u309f\u30a0-\u30ff]/g;

/**
 * 严格与 JIS X 0208（全部日语常用汉字、人名用汉字与 1/2 级汉字）100% 互不相交的大陆简体独有字符集：
 * 仅收录含大陆简化偏旁（讠/纟/钅/贝/车/门/马/页等）及高频大陆独有简化字，
 * 绝不含任何 JIS X 0208 汉字（如 法、与、来、没、参、数、准、国、机、体、学、会、点、当、写、双、只、叶、号、乱、争、云、党、理、合、网、价、据、无、从、听、儿、气、档、盖、范 等）。
 */
const SIMPLIFIED_CHINESE_EXCLUSIVE_CHAR_RE =
  /[说请评论语词设计证话认识试详该访询调读课谁谈译记许诉诊诚误诸诺谢谨谱订讨训议讯讲讽经结给统络级红约纯纳纸纹纷纺纽线练组绅细织终绍绑绒绕绘绝继综绿缓编缘缩缴针钉钙钝钞钟钠钢钥钦钧钩钮钱钳钻铁铃铅铆铜铝铭铲银铸铺链销锁锅锋错锦锡键锻镇镜镁贝贞负贡财责贤败账货质贩贪贫贬购贮贯贰贱贴贵贷贸费贺贼贾贿资赋赌赏赔赖赚赛赞赠赢车轧轨轩转轮软轰轻载较辅辆辈辉辑输辖门闪闭问闯闰闲间闷闸闹闻闽阀阁阅阐阔马驭驮驯驰驱驳驴驶驻驼驾骂骄骆骇验骏骑骗骚骤这们为时对还过进选测题买卖标优势实际发现应备电仅让种类产业关简复连图吗运适盘长见风专东两书习储频显处动变华协卫历压员响亿仪伟传伤伦伪养兽军农冻净办劳兰兴兑则刚创删剂剑剧劝胜开张弹归录达远违迟递逻页项顺领预额顾颜样权极构检欢汇汉济满热爱环码确离积稳节获营蓝补视规觉观队阶难飞鲜鸟齐齿龙]/;

const JA_MISSING_KANA_MIN_KANJI = 24;
const JA_MIN_KANA_RATIO = 0.02;
const JA_MIN_KATAKANA_ONLY_RATIO = 0.03;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAllowedTerms(text: string, allowedTerms: readonly string[]): string {
  const unique = [...new Set(allowedTerms.map((term) => term.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const term of unique) {
    out = out.replace(new RegExp(escapeRegExp(term), 'gi'), ' ');
  }
  return out;
}

/**
 * 面向多语种内容门禁的语言泄漏检测：
 * - zh-CN：直接放行；
 * - LATIN（en-US / en-GB / de-DE / es-ES / fr-FR）：拦截非品牌专有名词的 CJK 与日文假名；
 * - JAPANESE（ja-JP）：允许正常日语汉字 + 假名及短汉字标题，仅在出现大陆简体独有字或长段纯汉字零假名时告警。
 */
export function detectLocaleLeakage(
  text: string,
  targetLocale: SupportedLocale | string,
  allowedTerms: readonly string[] = [],
): LocaleLeakageResult {
  const meta = getLocaleMeta(targetLocale);
  const stripped = stripAllowedTerms(text ?? '', allowedTerms);

  if (meta.scriptFamily === 'CJK_ZH') {
    return {
      leaked: false,
      targetLocale: meta.code,
      scriptFamily: meta.scriptFamily,
      reason: null,
      samples: [],
    };
  }

  if (meta.scriptFamily === 'LATIN') {
    const matches = stripped.match(LATIN_FORBIDDEN_CJK_OR_KANA_RE);
    if (matches && matches.length > 0) {
      return {
        leaked: true,
        targetLocale: meta.code,
        scriptFamily: meta.scriptFamily,
        reason: 'LATIN_CJK_LEAK',
        samples: [...new Set(matches)].slice(0, 5),
      };
    }
    return {
      leaked: false,
      targetLocale: meta.code,
      scriptFamily: meta.scriptFamily,
      reason: null,
      samples: [],
    };
  }

  // JAPANESE (ja-JP) dual-signal detection
  const kanjiRuns = stripped.match(KANJI_RUN_RE) ?? [];
  const scLeakRuns = kanjiRuns.filter((run) => SIMPLIFIED_CHINESE_EXCLUSIVE_CHAR_RE.test(run));
  if (scLeakRuns.length > 0) {
    return {
      leaked: true,
      targetLocale: meta.code,
      scriptFamily: meta.scriptFamily,
      reason: 'JA_SIMPLIFIED_CHINESE_LEAK',
      samples: [...new Set(scLeakRuns)].slice(0, 5),
    };
  }

  const kanjiCount = (stripped.match(KANJI_CHAR_RE) ?? []).length;
  const hiraganaCount = (stripped.match(HIRAGANA_CHAR_RE) ?? []).length;
  const kanaCount = (stripped.match(KANA_CHAR_RE) ?? []).length;
  if (kanjiCount >= JA_MISSING_KANA_MIN_KANJI) {
    const kanaRatio = kanaCount / (kanjiCount + kanaCount);
    if (
      kanaCount === 0 ||
      (hiraganaCount === 0 && kanaRatio < JA_MIN_KATAKANA_ONLY_RATIO) ||
      kanaRatio < JA_MIN_KANA_RATIO
    ) {
      return {
        leaked: true,
        targetLocale: meta.code,
        scriptFamily: meta.scriptFamily,
        reason: 'JA_MISSING_KANA',
        samples: [...new Set(kanjiRuns)].slice(0, 5),
      };
    }
  }

  return {
    leaked: false,
    targetLocale: meta.code,
    scriptFamily: meta.scriptFamily,
    reason: null,
    samples: [],
  };
}

export type LocaleWritingDirective = {
  locale: SupportedLocale;
  nativeLabel: string;
  htmlLang: string;
  scriptFamily: LocaleScriptFamily;
  complianceNoticeKey: LocaleComplianceNoticeKey;
  writingLanguageInstruction: string;
  complianceInstruction: string;
  faqHeading: string;
  keyTakeawaysHeading: string;
  defaultSlugHint: string;
};

const LOCALE_WRITING_DIRECTIVES: Record<SupportedLocale, LocaleWritingDirective> = {
  'zh-CN': {
    locale: 'zh-CN',
    nativeLabel: '简体中文',
    htmlLang: 'zh-CN',
    scriptFamily: 'CJK_ZH',
    complianceNoticeKey: 'CN_AD_LAW',
    writingLanguageInstruction:
      '全程使用自然、客观、信息密度高的简体中文撰写，首段直答核心问题并提供可核验参数对比。',
    complianceInstruction:
      '严格遵守《中华人民共和国广告法》，禁用“第一/唯一/最/顶级/国家级”等绝对化极限词与无佐证疗效承诺。',
    faqHeading: '常见问题解答（FAQ）',
    keyTakeawaysHeading: '核心结论与已核验要点',
    defaultSlugHint: 'Use concise lowercase ASCII kebab-case slug (e.g., product-review-guide).',
  },
  'en-US': {
    locale: 'en-US',
    nativeLabel: 'English (US)',
    htmlLang: 'en-US',
    scriptFamily: 'LATIN',
    complianceNoticeKey: 'GLOBAL_FTC',
    writingLanguageInstruction:
      'Write 100% in natural American English (en-US). Never leave untranslated non-brand Chinese/CJK characters in titles, body, metadata, or checklists.',
    complianceInstruction:
      'Follow US FTC endorsement and substantiation standards: ground comparative claims in verifiable specs, disclose limitations honestly, and avoid unsubstantiated medical/financial guarantees.',
    faqHeading: 'Frequently Asked Questions (FAQ)',
    keyTakeawaysHeading: 'Key Verified Takeaways',
    defaultSlugHint: 'Use lowercase ASCII kebab-case English slug (<= 160 chars).',
  },
  'en-GB': {
    locale: 'en-GB',
    nativeLabel: 'English (UK)',
    htmlLang: 'en-GB',
    scriptFamily: 'LATIN',
    complianceNoticeKey: 'GLOBAL_UK_ASA',
    writingLanguageInstruction:
      'Write 100% in natural British English (en-GB spelling and phrasing such as optimise, colour, centre). Never leave untranslated non-brand CJK characters.',
    complianceInstruction:
      'Follow UK ASA / CAP Code standards: ensure comparative claims are objective, verifiable, and free of misleading superlatives or guaranteed outcome promises.',
    faqHeading: 'Frequently Asked Questions (FAQ)',
    keyTakeawaysHeading: 'Key Verified Takeaways',
    defaultSlugHint: 'Use lowercase ASCII kebab-case English slug (<= 160 chars).',
  },
  'de-DE': {
    locale: 'de-DE',
    nativeLabel: 'Deutsch',
    htmlLang: 'de-DE',
    scriptFamily: 'LATIN',
    complianceNoticeKey: 'GLOBAL_EU_UWG',
    writingLanguageInstruction:
      'Verfassen Sie den gesamten Inhalt zu 100 % in natürlichem, fachlich präzisem Deutsch (de-DE). Verwenden Sie keine unübersetzten CJK-Zeichen außerhalb offizieller Markennamen.',
    complianceInstruction:
      'Beachten Sie das deutsche UWG (Gesetz gegen den unlauteren Wettbewerb): Alle Vergleiche müssen sachlich, überprüfbar und frei von irreführenden Spitzenstellungsbehauptungen sein.',
    faqHeading: 'Häufig gestellte Fragen (FAQ)',
    keyTakeawaysHeading: 'Wichtigste geprüfte Erkenntnisse',
    defaultSlugHint:
      'Use lowercase ASCII kebab-case German slug (transliterate umlauts ae/oe/ue/ss).',
  },
  'ja-JP': {
    locale: 'ja-JP',
    nativeLabel: '日本語',
    htmlLang: 'ja-JP',
    scriptFamily: 'JAPANESE',
    complianceNoticeKey: 'GLOBAL_JP_KEIHYOHO',
    writingLanguageInstruction:
      '本文・見出し・要約はすべて自然な日本語（ja-JP、適切な漢字とひらがな・カタカナの併用）で執筆してください。中国語簡体字の混入を厳禁します。',
    complianceInstruction:
      '日本の景品表示法（優良誤認・有利誤認の禁止）を遵守し、検証済みの仕様・実測値のみに基づいて客観的な比較と注意点を記載してください。',
    faqHeading: 'よくある質問（FAQ）',
    keyTakeawaysHeading: '検証済みポイントまとめ',
    defaultSlugHint: 'Use lowercase ASCII romaji/English kebab-case slug (<= 160 chars).',
  },
  'es-ES': {
    locale: 'es-ES',
    nativeLabel: 'Español',
    htmlLang: 'es-ES',
    scriptFamily: 'LATIN',
    complianceNoticeKey: 'GLOBAL_EU_ES',
    writingLanguageInstruction:
      'Redacta el 100 % del contenido en español natural y preciso (es-ES). No dejes caracteres CJK sin traducir fuera de nombres comerciales propios.',
    complianceInstruction:
      'Cumple la normativa europea y española de competencia desleal y publicidad veraz: fundamenta cada comparativa en datos verificables y evita garantías infundadas.',
    faqHeading: 'Preguntas frecuentes (FAQ)',
    keyTakeawaysHeading: 'Conclusiones verificadas clave',
    defaultSlugHint: 'Use lowercase ASCII kebab-case Spanish slug without accents (<= 160 chars).',
  },
  'fr-FR': {
    locale: 'fr-FR',
    nativeLabel: 'Français',
    htmlLang: 'fr-FR',
    scriptFamily: 'LATIN',
    complianceNoticeKey: 'GLOBAL_EU_FR',
    writingLanguageInstruction:
      'Rédigez 100 % du contenu en français naturel et précis (fr-FR). Ne laissez aucun caractère CJK non traduit en dehors des noms de marque officiels.',
    complianceInstruction:
      'Respectez le Code de la consommation français et les règles européennes sur la publicité comparative : appuyez chaque affirmation sur des caractéristiques vérifiées et objectives.',
    faqHeading: 'Questions fréquentes (FAQ)',
    keyTakeawaysHeading: 'Points clés vérifiés',
    defaultSlugHint: 'Use lowercase ASCII kebab-case French slug without accents (<= 160 chars).',
  },
};

export function resolveLocaleWritingDirective(
  targetLocale: SupportedLocale | string,
): LocaleWritingDirective {
  const effective = resolveEffectiveLocale(targetLocale, 'GLOBAL');
  return LOCALE_WRITING_DIRECTIVES[effective];
}
