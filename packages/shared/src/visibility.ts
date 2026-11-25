// Portions adapted from elmohq/elmo (https://github.com/elmohq/elmo), Copyright (c) 2026 Blue Whale Software, LLC, MIT License.

import { z } from 'zod';
import { FAKE_MARK } from './adapters';
import { GEO_MARKETS, type GeoMarket } from './brands';
import { CRUD_PAGE_SIZES, type CrudPageSize } from './crud';
import { TASK_STATUSES, type ItemStatusName, type TaskStatusName } from './task-status';

export const VISIBILITY_ENGINES = [
  { key: 'deepseek', label: 'DeepSeek', domestic: true },
  { key: 'doubao', label: '豆包', domestic: true },
  { key: 'yuanbao', label: '腾讯元宝', domestic: true },
  { key: 'tongyi', label: '通义千问', domestic: true },
  { key: 'wenxin', label: '文心一言', domestic: true },
  { key: 'nami', label: '纳米', domestic: true },
  { key: 'kimi', label: 'Kimi', domestic: true },
  { key: 'zhipu', label: '智谱', domestic: true },
  { key: 'chatgpt', label: 'ChatGPT', domestic: false },
  { key: 'perplexity', label: 'Perplexity', domestic: false },
  { key: 'claude', label: 'Claude', domestic: false },
  { key: 'gemini', label: 'Gemini', domestic: false },
  { key: 'google_aio', label: 'Google AI Overviews', domestic: false },
] as const;

export type VisibilityEngineItem = (typeof VISIBILITY_ENGINES)[number];
export type VisibilityEngineKey = VisibilityEngineItem['key'];

export const VISIBILITY_ENGINE_KEYS = VISIBILITY_ENGINES.map((item) => item.key) as [
  VisibilityEngineKey,
  ...VisibilityEngineKey[],
];

export const DOMESTIC_VISIBILITY_ENGINE_KEYS = [
  'deepseek',
  'doubao',
  'yuanbao',
  'tongyi',
  'wenxin',
  'nami',
  'kimi',
  'zhipu',
] as const;
export type DomesticVisibilityEngineKey = (typeof DOMESTIC_VISIBILITY_ENGINE_KEYS)[number];

export const GLOBAL_VISIBILITY_ENGINE_KEYS = [
  'chatgpt',
  'perplexity',
  'claude',
  'gemini',
  'google_aio',
] as const;
export type GlobalVisibilityEngineKey = (typeof GLOBAL_VISIBILITY_ENGINE_KEYS)[number];

export function enginesForMarket(market: GeoMarket): readonly VisibilityEngineKey[] {
  return market === 'GLOBAL' ? GLOBAL_VISIBILITY_ENGINE_KEYS : DOMESTIC_VISIBILITY_ENGINE_KEYS;
}

export const VISIBILITY_ENGINES_BY_MARKET: Record<GeoMarket, readonly VisibilityEngineItem[]> = {
  CN: VISIBILITY_ENGINES.filter((item) => item.domestic),
  GLOBAL: VISIBILITY_ENGINES.filter((item) => !item.domestic),
};

export function enginesMetaForMarket(market: GeoMarket): readonly VisibilityEngineItem[] {
  return VISIBILITY_ENGINES_BY_MARKET[market];
}

export function isEngineAllowedForMarket(engine: VisibilityEngineKey, market: GeoMarket): boolean {
  return (enginesForMarket(market) as readonly string[]).includes(engine);
}

export function findDisallowedMarketEngines(
  engines: readonly VisibilityEngineKey[],
  market: GeoMarket,
): VisibilityEngineKey[] {
  return engines.filter((engine) => !isEngineAllowedForMarket(engine, market));
}

export const VISIBILITY_TRIGGER_TYPES = ['MANUAL', 'RETEST'] as const;
export type VisibilityTriggerType = (typeof VISIBILITY_TRIGGER_TYPES)[number];

export const VISIBILITY_ENGINE_LABELS: Record<VisibilityEngineKey, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  yuanbao: '腾讯元宝',
  tongyi: '通义千问',
  wenxin: '文心一言',
  nami: '纳米',
  kimi: 'Kimi',
  zhipu: '智谱',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  gemini: 'Gemini',
  google_aio: 'Google AI Overviews',
};

export const VISIBILITY_SENTIMENTS = ['positive', 'neutral', 'mixed', 'negative'] as const;
export type VisibilitySentiment = (typeof VISIBILITY_SENTIMENTS)[number];

export const VISIBILITY_SENTIMENT_LABELS: Record<VisibilitySentiment, string> = {
  positive: '正面',
  neutral: '中性',
  mixed: '褒贬参半',
  negative: '负面',
};

export const CITATION_SOURCE_KINDS = [
  'OWNED',
  'COMPETITOR',
  'SOCIAL',
  'AUTHORITY',
  'ECOMMERCE',
  'OTHER',
] as const;
export type CitationSourceKind = (typeof CITATION_SOURCE_KINDS)[number];

/**
 * 引用来源分类优先级：OWNED > COMPETITOR > ECOMMERCE > SOCIAL > AUTHORITY > OTHER。
 */
export const CITATION_SOURCE_PRIORITY: readonly CitationSourceKind[] = [
  'OWNED',
  'COMPETITOR',
  'ECOMMERCE',
  'SOCIAL',
  'AUTHORITY',
  'OTHER',
] as const;

export const CITATION_SOURCE_LABELS: Record<CitationSourceKind, string> = {
  OWNED: '自有阵地',
  COMPETITOR: '竞品官网',
  SOCIAL: '社媒社区',
  AUTHORITY: '权威信源',
  ECOMMERCE: '电商平台',
  OTHER: '其他来源',
};

export const VISIBILITY_COLLECTOR_KINDS = ['fake', 'llm_api', 'remote_scraper'] as const;
export type VisibilityCollectorKind = (typeof VISIBILITY_COLLECTOR_KINDS)[number];

export const VISIBILITY_DEFAULT_UNIT_POINTS = 2;
export const VISIBILITY_MAX_COMPETITORS = 10;
export const VISIBILITY_PROFILE_NAME_MAX = 80;
export const VISIBILITY_BRAND_NAME_MAX = 80;
export const VISIBILITY_RUN_NAME_MAX = 80;
export const VISIBILITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const SOCIAL_CITATION_DOMAINS = [
  // CN social & UGC
  'zhihu.com',
  'xiaohongshu.com',
  'xhslink.com',
  'weibo.com',
  'weibo.cn',
  'smzdm.com',
  'bilibili.com',
  'b23.tv',
  'douyin.com',
  'toutiao.com',
  'mp.weixin.qq.com',
  'tieba.baidu.com',
  'douban.com',
  'hupu.com',
  'v2ex.com',
  'juejin.cn',
  'csdn.net',
  'segmentfault.com',
  'oschina.net',
  'nga.cn',
  'ngabbs.com',
  'kuaishou.com',
  'jianshu.com',
  'cnblogs.com',
  // GLOBAL review & community
  'reddit.com',
  'quora.com',
  'trustpilot.com',
  'g2.com',
  'capterra.com',
  'producthunt.com',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  'medium.com',
  'substack.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'discord.com',
  'news.ycombinator.com',
  'stackoverflow.com',
  'dev.to',
] as const;

export const AUTHORITY_CITATION_DOMAINS = [
  // Encyclopedias, official media & standards
  'baike.baidu.com',
  'wikipedia.org',
  'wikidata.org',
  'xinhuanet.com',
  'news.cn',
  'people.com.cn',
  'cctv.com',
  'chinadaily.com.cn',
  'gmw.cn',
  'thepaper.cn',
  'caixin.com',
  '36kr.com',
  'huxiu.com',
  'tmtpost.com',
  'ifanr.com',
  'infoq.cn',
  'infoq.com',
  'github.com',
  'arxiv.org',
  'nature.com',
  'ieee.org',
  'iso.org',
  'w3.org',
  'mozilla.org',
  // CN tech/product review media
  'sspai.com',
  'ithome.com',
  'pconline.com.cn',
  'zol.com.cn',
  'chiphell.com',
  'mydrivers.com',
  'leiphone.com',
  'geekpark.net',
  'pingwest.com',
  'chongdiantou.com',
  'zealer.com',
  // GLOBAL editorial authority & review media
  'techradar.com',
  'wirecutter.com',
  'nytimes.com',
  'pcmag.com',
  'theverge.com',
  'rtings.com',
  'tomsguide.com',
  'tomshardware.com',
  'cnet.com',
  'forbes.com',
  'wired.com',
  'engadget.com',
  'arstechnica.com',
  'zdnet.com',
  'techcrunch.com',
  'anandtech.com',
  'notebookcheck.net',
  'consumerreports.org',
  'gartner.com',
  'forrester.com',
  'idc.com',
] as const;

export const ECOMMERCE_CITATION_DOMAINS = [
  // CN storefronts
  'jd.com',
  'tmall.com',
  'taobao.com',
  'pinduoduo.com',
  'yangkeduo.com',
  'suning.com',
  'vip.com',
  '1688.com',
  // GLOBAL storefronts
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amazon.co.jp',
  'amazon.ca',
  'amazon.fr',
  'ebay.com',
  'walmart.com',
  'bestbuy.com',
  'newegg.com',
  'target.com',
  'costco.com',
  'aliexpress.com',
] as const;

const ECOMMERCE_DOMAIN_SET = new Set<string>(ECOMMERCE_CITATION_DOMAINS);
const SOCIAL_DOMAIN_SET = new Set<string>(SOCIAL_CITATION_DOMAINS);
const AUTHORITY_DOMAIN_SET = new Set<string>(AUTHORITY_CITATION_DOMAINS);

export const AUTHORITY_CITATION_TLD_SUFFIXES = [
  '.gov.cn',
  '.edu.cn',
  '.ac.cn',
  '.org.cn',
  '.gov',
  '.edu',
  '.org',
  '.mil',
  '.int',
] as const;

const ENGINE_SET = new Set<string>(VISIBILITY_ENGINE_KEYS);
const SENTIMENT_SET = new Set<string>(VISIBILITY_SENTIMENTS);
const SOURCE_KIND_SET = new Set<string>(CITATION_SOURCE_KINDS);
const COLLECTOR_KIND_SET = new Set<string>(VISIBILITY_COLLECTOR_KINDS);

const NON_WEB_SCHEME = /^(?:javascript|mailto|tel|data|blob|file|about):/i;
const VALID_DOMAIN_LABEL =
  /^[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?$/u;
const IPV4_DOTTED = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ALNUM_WORD_CHAR = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Nd}]/u;
const ALNUM_WORD_CLASS = '[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Nd}]';

export function isVisibilityEngine(value: string): value is VisibilityEngineKey {
  return ENGINE_SET.has(value);
}

export function isVisibilitySentiment(value: string): value is VisibilitySentiment {
  return SENTIMENT_SET.has(value);
}

export function isCitationSourceKind(value: string): value is CitationSourceKind {
  return SOURCE_KIND_SET.has(value);
}

export function isVisibilityCollectorKind(value: string): value is VisibilityCollectorKind {
  return COLLECTOR_KIND_SET.has(value);
}

/**
 * 归一化 URL 或域名字符串为小写主域名/子域名（去掉协议、www.、端口、路径、锚点与末尾点）。
 * 输入不合法或非 Web 域名时返回空字符串，绝不抛异常。
 */
export function normalizeVisibilityDomain(urlOrDomain: string): string {
  if (typeof urlOrDomain !== 'string') return '';
  const trimmed = urlOrDomain.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return '';
  if (NON_WEB_SCHEME.test(trimmed)) return '';

  let host = '';
  const candidateUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidateUrl)) {
    try {
      const parsed = new URL(candidateUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      host = parsed.hostname;
    } catch {
      host = extractRawHost(trimmed);
    }
  } else {
    try {
      const parsed = new URL(`https://${trimmed}`);
      host = parsed.hostname;
    } catch {
      host = extractRawHost(trimmed);
    }
  }

  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');

  if (!cleaned || cleaned.includes(':')) return '';
  if (IPV4_DOTTED.test(cleaned)) return cleaned;

  const parts = cleaned.split('.');
  if (parts.length < 2) return '';
  const tld = parts[parts.length - 1] ?? '';
  if (tld.length < 2 || /^\d+$/.test(tld)) return '';
  if (!parts.every((part) => VALID_DOMAIN_LABEL.test(part))) return '';

  return cleaned;
}

function extractRawHost(raw: string): string {
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
  const authority = withoutScheme.split(/[/?#]/)[0] ?? '';
  const withoutUser = authority.includes('@') ? (authority.split('@').pop() ?? '') : authority;
  if (withoutUser.startsWith('[')) {
    const end = withoutUser.indexOf(']');
    return end >= 0 ? withoutUser.slice(1, end) : '';
  }
  return withoutUser.replace(/:\d+$/, '');
}

/**
 * 判断 domain 是否等于 candidate 或为其子域名（如 docs.geomix.cn 匹配 geomix.cn）。
 */
export function matchesDomain(domain: string, candidate: string): boolean {
  const d = normalizeVisibilityDomain(domain);
  const c = normalizeVisibilityDomain(candidate);
  if (!d || !c) return false;
  return d === c || d.endsWith(`.${c}`);
}

function matchesDomainSet(normalizedDomain: string, set: ReadonlySet<string>): boolean {
  if (set.has(normalizedDomain)) return true;
  let idx = normalizedDomain.indexOf('.');
  while (idx !== -1) {
    if (set.has(normalizedDomain.slice(idx + 1))) return true;
    idx = normalizedDomain.indexOf('.', idx + 1);
  }
  return false;
}

/**
 * 按 OWNED > COMPETITOR > ECOMMERCE > SOCIAL > AUTHORITY > OTHER 优先级对引用来源归类。
 */
export function classifyCitationSource(
  urlOrDomain: string,
  context: {
    ownedDomains?: readonly string[];
    competitorDomains?: readonly string[];
  } = {},
): CitationSourceKind {
  const domain = normalizeVisibilityDomain(urlOrDomain);
  if (!domain) return 'OTHER';

  for (const owned of context.ownedDomains ?? []) {
    if (matchesDomain(domain, owned)) return 'OWNED';
  }
  for (const comp of context.competitorDomains ?? []) {
    if (matchesDomain(domain, comp)) return 'COMPETITOR';
  }
  if (matchesDomainSet(domain, ECOMMERCE_DOMAIN_SET)) return 'ECOMMERCE';
  if (matchesDomainSet(domain, SOCIAL_DOMAIN_SET)) return 'SOCIAL';
  if (matchesDomainSet(domain, AUTHORITY_DOMAIN_SET)) return 'AUTHORITY';
  for (const suffix of AUTHORITY_CITATION_TLD_SUFFIXES) {
    if (domain.endsWith(suffix) && domain.length > suffix.length) return 'AUTHORITY';
  }
  return 'OTHER';
}

export type TrackedSubject = {
  name: string;
  aliases: readonly string[];
  domains: readonly string[];
};

export type VisibilityCompetitor = {
  name: string;
  aliases: string[];
  domains: string[];
};

export type CompetitorHit = {
  name: string;
  mentioned: boolean;
  position: number | null;
  sentiment: VisibilitySentiment | null;
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造支持中英混排的品牌词边界正则：
 * - 拉丁字母/数字词两端要求非拉丁字母数字边界（避免 "ace" 误伤 "place"）；
 * - 中文/日韩字符与拉丁词紧邻（如 "GeoMix是一款..."、"极米投影..."）正常命中。
 */
export function wholeWordPattern(term: string): RegExp {
  const collapsed = term.replace(/\s+/g, ' ').trim();
  if (!collapsed) return /(?!)/giu;

  const chars = [...collapsed];
  const firstChar = chars[0] ?? '';
  const lastChar = chars[chars.length - 1] ?? '';

  const body = collapsed
    .split(' ')
    .map((token) => escapeRegExp(token))
    .join('\\s+');

  const prefix = ALNUM_WORD_CHAR.test(firstChar) ? `(?<!${ALNUM_WORD_CLASS})` : '';
  const suffix = ALNUM_WORD_CHAR.test(lastChar) ? `(?!${ALNUM_WORD_CLASS})` : '';

  return new RegExp(`${prefix}${body}${suffix}`, 'giu');
}

function collectSubjectTerms(subject: TrackedSubject): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  };

  push(subject.name);
  for (const alias of subject.aliases) push(alias);
  for (const dom of subject.domains) {
    const normalized = normalizeVisibilityDomain(dom);
    if (normalized) push(normalized);
  }
  return result;
}

export type SubjectMentionOptions = {
  promptText?: string;
  excludeQuestionEchoIntro?: boolean;
};

const INTRO_GREETING_PREFIX =
  /^(?:好的|您好|你好|当然|没问题|明白|收到|这里|首先|Sure|Certainly|Of course|Hello|Hi)[，,：:\s]+/iu;

const DIRECT_RECOMMENDATION_PREFIX =
  /^(?:首选推荐|强烈推荐|优先推荐|最推荐|推荐选择|值得推荐|首先推荐|1[.、)）]|[-*•]\s+|top\s+pick|best\s+choice|we\s+recommend)/iu;

const EXPLICIT_CN_QUESTION_ECHO_PREFIX =
  /^(?:针对|关于|围绕|对于|就|结合|根据|按照|在回答|在解答)?\s*(?:您|你)(?:所|正在)?(?:询问|咨询|提问|提出|提到|提及|关注|想了解|关心|了解|问|搜索|检索)(?:的|到|关于)?/u;

const EXPLICIT_CN_QUESTION_SUFFIX =
  /^(?:针对|关于|围绕|对于|在回答|在解答|就)\s*.{1,120}?(?:这个问题|这一问题|该问题|的提问|的询问|的咨询|的问题|这个话题|该话题)$/u;

const QUOTED_CN_PROMPT_ECHO =
  /^(?:针对|关于|围绕|对于|在回答|在解答|在讨论|在评估|在分析|在对比|在了解|在选购|就)\s*[「『“"《][^」』”"》\r\n]{1,140}[」』”"》](?:\s*(?:这个问题|这一问题|该问题|这一需求|这类产品|这个方向|的话题|等方面|的提问|的询问|问题|时|而言|来说|来看|方面|上))?$/u;

const ENGLISH_QUESTION_ECHO =
  /^(?:Regarding|Concerning|About|Addressing|In response to|In answer to|With respect to|When it comes to|For)\s+(?:(?:your|the)\s+(?:question|query|prompt|request|inquiry)\b|["'“‘][^"'”’\r\n]{1,140}["'”’])|^(?:You(?:'re| are)?\s+asking\s+about|You\s+asked\s+about)\b/iu;

const PROMPT_FRAMING_PREPOSITION = /^(?:针对|关于|围绕|对于|就)\s*/u;

const ANAPHORIC_BRAND_CONTINUATION =
  /^(?:其|它|它们|该品牌|该产品|这款|这系列|本品牌|它家|它本身|它主要|it\b|its\b|they\b)/iu;

const COMPETITOR_LIST_LEAD_IN =
  /(?:几款|以下|市面|目前|热门|主流|常见|值得|高性价比|同类|替代).{0,16}(?:品牌|产品|方案|工具|选择|平台|厂商|推荐|清单|榜单|型号)|(?:以下|如下|为您)(?:整理|推荐|盘点|汇总|介绍|列举|对比)|主要包括|top\s+(?:brands|picks|options|choices|alternatives|tools)|here\s+are\s+(?:some\s+)?(?:top|popular|recommended)/iu;

const ATTRIBUTE_ONLY_LEAD_IN =
  /^(?:以下|主要|核心)?(?:优势|优点|特点|缺点|亮点|参数|规格|核心特性)/u;

const ATTRIBUTE_ONLY_LEAD_IN_ANYWHERE =
  /(?:主要|核心|以下)?(?:优势|优点|特点|缺点|亮点|参数|规格|核心特性|特性|性能表现|使用体验)(?:如下|包括|有|为)?|(?:main|key|core)\s+(?:pros|cons|features|advantages|highlights|specs|specifications|benefits)\b/iu;

const MULTI_OPTION_LIST_LEAD_IN =
  /(?:几款|多款|市面|目前|热门|主流|常见|值得|高性价比|同类|替代).{0,16}(?:品牌|产品|方案|工具|选择|平台|厂商|推荐|清单|榜单|型号)|(?:以下|如下|为您)(?:整理|推荐|盘点|汇总|列举|对比|是.{0,12}(?:品牌|产品|方案|推荐|榜单|选择|型号|工具))|推荐(?:如下|榜单|清单)|值得关注|热门选择|主流(?:品牌|方案|产品|选择)|(?:here\s+are|below\s+are|the\s+following)\s+(?:some\s+)?(?:the\s+)?(?:top|best|popular|recommended|leading|main|key)?\s*(?:picks|recommendations|options|brands|models|alternatives|choices|tools|solutions)|(?:top|best)\s+(?:picks|recommendations|options|brands|models|alternatives|choices|tools)|worth\s+considering|alternatives\s+to/iu;

const UNFRAMED_QUESTION_ECHO =
  /^(?:想了解|很多人问|很多用户|如果你在找|在选购|在对比|对比.{0,30}时|关于|针对)|^(?:if\s+you(?:'re|\s+are)|when\s+(?:choosing|comparing|evaluating|looking)|looking\s+for|wondering|comparing|for\s+those\s+looking)\b/iu;

const CN_NUMERAL_TO_RANK: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
  十五: 15,
  十六: 16,
  十七: 17,
  十八: 18,
  十九: 19,
  二十: 20,
};

export type StructuredListItemKind = 'ordered' | 'heading' | 'bullet';

export type StructuredListItem = {
  kind: StructuredListItemKind;
  blockId: number;
  explicitRank: number | null;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  headerText: string;
  headerStartOffset: number;
  headerEndOffset: number;
  bodyText: string;
};

// Bounded prefix patterns applied only to line.slice(0, 240) — strictly O(1) per line, O(N) total.
const HEADING_NUMBERED_LINE =
  /^[ \t]{0,4}(#{1,4})[ \t]+(?:\*\*|__)?(\d{1,2})(?:[.)](?:\*\*|__)?[ \t]+|[、）](?:\*\*|__)?[ \t]*)(.+)$/u;
const BOLD_NUMBERED_LINE =
  /^[ \t]{0,4}(?:\*\*|__)(\d{1,2})(?:[.)](?:\*\*|__)?[ \t]+|[、）](?:\*\*|__)?[ \t]*)(.+)$/u;
const PLAIN_NUMBERED_LINE = /^[ \t]{0,4}(\d{1,2})(?:[.)][ \t]+|[、）][ \t]*)(.+)$/u;
const PAREN_NUMBERED_LINE = /^[ \t]{0,4}[(（\[](\d{1,2})[)）\]][ \t]*(.+)$/u;
const CN_NUMERAL_LINE =
  /^[ \t]{0,4}(?:#{1,4}[ \t]+)?(?:\*\*|__)?([一二三四五六七八九十]{1,2})[、.．](?:\*\*|__)?[ \t]*(.+)$/u;
const ORDINAL_RANK_LINE =
  /^[ \t]{0,4}(?:#{1,4}[ \t]+)?(?:\*\*|__)?(?:第([1-9]\d?|[一二三四五六七八九十]{1,2})[位名款个]?|top[ \t]{0,2}([1-9]\d?)|#([1-9]\d?))(?:\*\*|__)?[：:.\-—][ \t]*(.+)$/iu;
const MARKDOWN_HEADING_LINE = /^[ \t]{0,4}(#{2,4})[ \t]+(.+)$/u;
const BULLET_LINE = /^[ \t]{0,4}[-*•▪▸][ \t]+(.+)$/u;

function parseRankToken(raw: string): number | null {
  const cn = CN_NUMERAL_TO_RANK[raw];
  if (typeof cn === 'number') return cn;
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1 && num <= 20) return num;
  return null;
}

function extractItemHeader(rest: string): string {
  const bounded = rest.slice(0, 160).replace(/^[ \t]*(?:\*\*|__|\*|`)+/, '');
  let depth = 0;
  let cutAt = Math.min(bounded.length, 120);

  for (let i = 0; i < cutAt; i += 1) {
    const ch = bounded[i] ?? '';
    if (ch === '(' || ch === '（' || ch === '[' || ch === '【') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === '）' || ch === ']' || ch === '】') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) {
      if (ch === '：' || ch === ':' || ch === '—' || ch === '–' || ch === '。') {
        cutAt = i;
        break;
      }
      if (ch === '-' && i > 0 && bounded[i - 1] === ' ' && bounded[i + 1] === ' ') {
        cutAt = i - 1;
        break;
      }
    }
  }

  return bounded
    .slice(0, cutAt)
    .replace(/\*\*|__/g, '')
    .replace(/^[ \t*`]+|[ \t*`]+$/g, '')
    .trim();
}

/**
 * 线性时间 $O(N)$ 解析回答中的有序列表 / Markdown 标题 / 项目符号推荐清单。
 * 小数如 "2.5G"、"14.5W" 不会误判为编号列表项。
 */
export function extractStructuredRecommendationItems(text: string): StructuredListItem[] {
  if (typeof text !== 'string' || !text.trim()) return [];

  type ParsedLineItem = {
    kind: StructuredListItemKind;
    headingLevel: number;
    explicitRank: number | null;
    startOffset: number;
    lineEndOffset: number;
    headerText: string;
    headerStartOffset: number;
    headerEndOffset: number;
  };

  type ActiveOrderedState = {
    blockId: number;
    headingLevel: number;
    lastExplicitRank: number | null;
    ordinal: number;
    lastItem: StructuredListItem;
    sawBreakingProse: boolean;
  };
  type ActiveHeadingState = {
    blockId: number;
    headingLevel: number;
    ordinal: number;
    lastItem: StructuredListItem;
  };
  type ActiveBulletState = {
    blockId: number;
    ordinal: number;
    lastItem: StructuredListItem;
    sawBreakingProse: boolean;
  };

  const items: StructuredListItem[] = [];
  let nextBlockId = 0;
  let activeOrdered: ActiveOrderedState | null = null;
  const headingBlocksByLevel = new Map<number, ActiveHeadingState>();
  let activeBullet: ActiveBulletState | null = null;
  let sawBlankLine = false;

  const closeItem = (item: StructuredListItem | null | undefined, endOffset: number) => {
    if (item && item.endOffset === text.length) {
      item.endOffset = endOffset;
      item.bodyText = text.slice(item.startOffset, item.endOffset).trim();
    }
  };

  const closeHeadingsAtOrDeeperThan = (minLevel: number, endOffset: number) => {
    for (const [level, state] of [...headingBlocksByLevel.entries()]) {
      if (level >= minLevel) {
        closeItem(state.lastItem, endOffset);
        headingBlocksByLevel.delete(level);
      }
    }
  };

  const parseLine = (line: string, lineStart: number): ParsedLineItem | null => {
    const sample = line.slice(0, 240);
    let match: RegExpMatchArray | null;

    if ((match = sample.match(HEADING_NUMBERED_LINE))) {
      const rank = parseRankToken(match[2] ?? '');
      const rest = match[3] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: (match[1] ?? '').length,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(BOLD_NUMBERED_LINE))) {
      const rank = parseRankToken(match[1] ?? '');
      const rest = match[2] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: 0,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(PLAIN_NUMBERED_LINE))) {
      const rank = parseRankToken(match[1] ?? '');
      const rest = match[2] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: 0,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(PAREN_NUMBERED_LINE))) {
      const rank = parseRankToken(match[1] ?? '');
      const rest = match[2] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: 0,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(CN_NUMERAL_LINE))) {
      const rank = parseRankToken(match[1] ?? '');
      const rest = match[2] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: 0,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(ORDINAL_RANK_LINE))) {
      const rawRank = match[1] ?? match[2] ?? match[3] ?? '';
      const rank = parseRankToken(rawRank);
      const rest = match[4] ?? '';
      if (rank !== null && rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'ordered',
          headingLevel: 0,
          explicitRank: rank,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(MARKDOWN_HEADING_LINE))) {
      const rest = match[2] ?? '';
      if (rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'heading',
          headingLevel: (match[1] ?? '').length,
          explicitRank: null,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    if ((match = sample.match(BULLET_LINE))) {
      const rest = match[1] ?? '';
      if (rest.trim()) {
        const restStart = lineStart + sample.length - rest.length;
        const headerText = extractItemHeader(rest);
        return {
          kind: 'bullet',
          headingLevel: 0,
          explicitRank: null,
          startOffset: lineStart,
          lineEndOffset: lineStart + line.length,
          headerText,
          headerStartOffset: restStart,
          headerEndOffset: Math.min(lineStart + line.length, restStart + headerText.length),
        };
      }
    }

    return null;
  };

  let pos = 0;
  const len = text.length;
  while (pos <= len) {
    const nlIdx = text.indexOf('\n', pos);
    const rawLineEnd = nlIdx === -1 ? len : nlIdx;
    const lineEnd = rawLineEnd > pos && text[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd;
    const line = text.slice(pos, lineEnd);
    const trimmed = line.trim();

    if (!trimmed) {
      sawBlankLine = true;
    } else {
      const parsed = parseLine(line, pos);
      if (parsed) {
        if (parsed.kind === 'ordered') {
          if (activeBullet) {
            closeItem(activeBullet.lastItem, parsed.startOffset);
            activeBullet = null;
          }
          if (parsed.headingLevel > 0) {
            closeHeadingsAtOrDeeperThan(parsed.headingLevel, parsed.startOffset);
          }

          let blockId: number;
          let ordinal: number;
          const canContinueOrdered =
            activeOrdered !== null &&
            activeOrdered.headingLevel === parsed.headingLevel &&
            !(
              parsed.explicitRank !== null &&
              activeOrdered.lastExplicitRank !== null &&
              parsed.explicitRank <= activeOrdered.lastExplicitRank
            ) &&
            (!activeOrdered.sawBreakingProse ||
              parsed.headingLevel > 0 ||
              (parsed.explicitRank !== null &&
                activeOrdered.lastExplicitRank !== null &&
                parsed.explicitRank > activeOrdered.lastExplicitRank &&
                parsed.explicitRank <= activeOrdered.lastExplicitRank + 3));

          if (activeOrdered) {
            closeItem(activeOrdered.lastItem, parsed.startOffset);
          }
          if (canContinueOrdered && activeOrdered) {
            blockId = activeOrdered.blockId;
            ordinal = activeOrdered.ordinal + 1;
          } else {
            blockId = nextBlockId;
            nextBlockId += 1;
            ordinal = 1;
          }

          const newItem: StructuredListItem = {
            kind: 'ordered',
            blockId,
            explicitRank: parsed.explicitRank,
            ordinal,
            startOffset: parsed.startOffset,
            endOffset: text.length,
            headerText: parsed.headerText,
            headerStartOffset: parsed.headerStartOffset,
            headerEndOffset: parsed.headerEndOffset,
            bodyText: '',
          };
          items.push(newItem);
          activeOrdered = {
            blockId,
            headingLevel: parsed.headingLevel,
            lastExplicitRank: parsed.explicitRank,
            ordinal,
            lastItem: newItem,
            sawBreakingProse: false,
          };
        } else if (parsed.kind === 'heading') {
          if (activeBullet) {
            closeItem(activeBullet.lastItem, parsed.startOffset);
            activeBullet = null;
          }
          if (
            activeOrdered &&
            (activeOrdered.headingLevel === 0 || parsed.headingLevel <= activeOrdered.headingLevel)
          ) {
            closeItem(activeOrdered.lastItem, parsed.startOffset);
            activeOrdered = null;
          }

          closeHeadingsAtOrDeeperThan(parsed.headingLevel + 1, parsed.startOffset);
          const existingSameLevel = headingBlocksByLevel.get(parsed.headingLevel) ?? null;
          let blockId: number;
          let ordinal: number;
          if (existingSameLevel) {
            closeItem(existingSameLevel.lastItem, parsed.startOffset);
            blockId = existingSameLevel.blockId;
            ordinal = existingSameLevel.ordinal + 1;
          } else {
            blockId = nextBlockId;
            nextBlockId += 1;
            ordinal = 1;
          }

          const newItem: StructuredListItem = {
            kind: 'heading',
            blockId,
            explicitRank: null,
            ordinal,
            startOffset: parsed.startOffset,
            endOffset: text.length,
            headerText: parsed.headerText,
            headerStartOffset: parsed.headerStartOffset,
            headerEndOffset: parsed.headerEndOffset,
            bodyText: '',
          };
          items.push(newItem);
          headingBlocksByLevel.set(parsed.headingLevel, {
            blockId,
            headingLevel: parsed.headingLevel,
            ordinal,
            lastItem: newItem,
          });
        } else {
          // Bullet item: keep enclosing heading / ordered blocks intact so sub-bullets
          // under ### headings or numbered items do not fragment the parent recommendation list.
          if (activeBullet) {
            closeItem(activeBullet.lastItem, parsed.startOffset);
          }
          let blockId: number;
          let ordinal: number;
          if (activeBullet && !activeBullet.sawBreakingProse) {
            blockId = activeBullet.blockId;
            ordinal = activeBullet.ordinal + 1;
          } else {
            blockId = nextBlockId;
            nextBlockId += 1;
            ordinal = 1;
          }

          const newItem: StructuredListItem = {
            kind: 'bullet',
            blockId,
            explicitRank: null,
            ordinal,
            startOffset: parsed.startOffset,
            endOffset: text.length,
            headerText: parsed.headerText,
            headerStartOffset: parsed.headerStartOffset,
            headerEndOffset: parsed.headerEndOffset,
            bodyText: '',
          };
          items.push(newItem);
          activeBullet = {
            blockId,
            ordinal,
            lastItem: newItem,
            sawBreakingProse: false,
          };
        }
        sawBlankLine = false;
      } else {
        // Unindented prose after a blank line closes the current bullet/plain-ordered item span.
        if (sawBlankLine) {
          if (activeBullet) {
            closeItem(activeBullet.lastItem, pos);
            activeBullet.sawBreakingProse = true;
          }
          if (activeOrdered && activeOrdered.headingLevel === 0) {
            closeItem(activeOrdered.lastItem, pos);
            activeOrdered.sawBreakingProse = true;
          }
        }
        sawBlankLine = false;
      }
    }

    if (nlIdx === -1) break;
    pos = nlIdx + 1;
  }

  for (const item of items) {
    if (!item.bodyText) {
      item.bodyText = text.slice(item.startOffset, item.endOffset).trim();
    }
  }

  return items;
}

const BRACKETED_METADATA_TAG = /\[[A-Z][A-Z0-9_-]{1,31}\]/g;

function stripBracketedMetadataTags(raw: string): string {
  return raw.replace(BRACKETED_METADATA_TAG, ' ');
}

function normalizeForEchoCompare(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』《》【】()（）[\].,!?，。！？：:；;、~`*_#-]/gu, '');
}

function sharesPromptEcho(clauseBody: string, promptText?: string): boolean {
  if (!promptText) return false;
  const normClause = normalizeForEchoCompare(clauseBody);
  const normPrompt = normalizeForEchoCompare(stripBracketedMetadataTags(promptText));
  if (normClause.length < 3 || normPrompt.length < 3) return false;
  if (normPrompt.includes(normClause) || normClause.includes(normPrompt)) {
    return true;
  }
  const clauseGrams = new Set<string>();
  for (let i = 0; i < normClause.length - 1; i += 1) {
    clauseGrams.add(normClause.slice(i, i + 2));
  }
  let shared = 0;
  for (let i = 0; i < normPrompt.length - 1; i += 1) {
    if (clauseGrams.has(normPrompt.slice(i, i + 2))) shared += 1;
  }
  const minLen = Math.min(normClause.length, normPrompt.length) - 1;
  return minLen > 0 && shared / minLen >= 0.5;
}

function scanOpeningClauseEnd(
  text: string,
  start: number,
): { clauseEnd: number; delimiter: string; afterDelimiter: number } | null {
  const limit = Math.min(text.length, start + 240);
  let quoteClose: string | null = null;
  let quoteOpenedAt = -1;

  for (let i = start; i < limit; i += 1) {
    const ch = text[i] ?? '';
    if (quoteClose) {
      if (ch === quoteClose || i - quoteOpenedAt > 140) {
        quoteClose = null;
      }
      continue;
    }

    if (ch === '「') {
      quoteClose = '」';
      quoteOpenedAt = i;
      continue;
    }
    if (ch === '『') {
      quoteClose = '』';
      quoteOpenedAt = i;
      continue;
    }
    if (ch === '“') {
      quoteClose = '”';
      quoteOpenedAt = i;
      continue;
    }
    if (ch === '《') {
      quoteClose = '》';
      quoteOpenedAt = i;
      continue;
    }
    if (ch === '"') {
      quoteClose = '"';
      quoteOpenedAt = i;
      continue;
    }

    if (/[，,：:；;。！？.!?\r\n]/u.test(ch)) {
      let after = i + 1;
      while (after < text.length && /[，,：:；;。！？.!?\s]/u.test(text[after] ?? '')) {
        after += 1;
      }
      return { clauseEnd: i, delimiter: ch, afterDelimiter: after };
    }
  }
  return null;
}

function findPrimaryPreListOffset(text: string): number {
  const items = extractStructuredRecommendationItems(text);
  if (items.length < 2) return 0;

  const blocks = new Map<number, StructuredListItem[]>();
  for (const item of items) {
    const arr = blocks.get(item.blockId);
    if (arr) arr.push(item);
    else blocks.set(item.blockId, [item]);
  }

  const kindWeight: Record<StructuredListItemKind, number> = {
    ordered: 3,
    heading: 2,
    bullet: 1,
  };

  let bestBlock: StructuredListItem[] | null = null;
  for (const block of blocks.values()) {
    if (block.length < 2) continue;
    const first = block[0];
    if (!first || first.startOffset <= 0 || first.startOffset > 360) continue;
    if (!bestBlock) {
      bestBlock = block;
      continue;
    }
    const prevFirst = bestBlock[0];
    if (!prevFirst) continue;
    const wNew = kindWeight[first.kind];
    const wOld = kindWeight[prevFirst.kind];
    if (wNew > wOld || (wNew === wOld && first.startOffset < prevFirst.startOffset)) {
      bestBlock = block;
    }
  }

  return bestBlock?.[0]?.startOffset ?? 0;
}

/**
 * 识别回答开头的“提问复述/导语”结束偏移量（返回 0 表示无此类导语）。
 * 用于排除诸如「针对您询问的 Anker 氮化镓充电器推荐，以下为您整理热门品牌：」或无前缀列表导语中的品牌词复述，
 * 避免正文仅推荐竞品时误判本品牌命中且顺位 #1。
 */
export function findQuestionEchoIntroEnd(text: string, promptText?: string): number {
  if (typeof text !== 'string' || !text.trim()) return 0;

  const leadingWs = text.match(/^\s*/)?.[0].length ?? 0;
  const candidateStarts = [leadingWs];
  const greetingMatch = text.slice(leadingWs, leadingWs + 80).match(INTRO_GREETING_PREFIX);
  if (greetingMatch?.[0]) {
    candidateStarts.push(leadingWs + greetingMatch[0].length);
  }

  for (const start of candidateStarts) {
    if (start >= text.length) continue;
    const scanned = scanOpeningClauseEnd(text, start);
    if (!scanned) continue;

    const clause = text.slice(start, scanned.clauseEnd).trim();
    if (!clause || clause.length > 200) continue;
    if (DIRECT_RECOMMENDATION_PREFIX.test(clause)) return 0;

    const nextRest = text.slice(scanned.afterDelimiter, scanned.afterDelimiter + 300);
    const nextSentence = nextRest.split(/[。！？.!?\r\n]/u, 1)[0]?.trim() ?? '';
    const isCommaDelimiter = scanned.delimiter === '，' || scanned.delimiter === ',';

    const isExplicitEcho =
      EXPLICIT_CN_QUESTION_ECHO_PREFIX.test(clause) ||
      EXPLICIT_CN_QUESTION_SUFFIX.test(clause) ||
      QUOTED_CN_PROMPT_ECHO.test(clause) ||
      ENGLISH_QUESTION_ECHO.test(clause);

    if (isExplicitEcho) {
      if (
        isCommaDelimiter &&
        ANAPHORIC_BRAND_CONTINUATION.test(nextSentence) &&
        !COMPETITOR_LIST_LEAD_IN.test(nextSentence)
      ) {
        return 0;
      }
      return scanned.afterDelimiter;
    }

    if (PROMPT_FRAMING_PREPOSITION.test(clause)) {
      const clauseBody = clause.replace(PROMPT_FRAMING_PREPOSITION, '').trim();
      if (
        sharesPromptEcho(clauseBody, promptText) &&
        COMPETITOR_LIST_LEAD_IN.test(nextSentence) &&
        !ATTRIBUTE_ONLY_LEAD_IN.test(nextSentence) &&
        !ANAPHORIC_BRAND_CONTINUATION.test(nextSentence)
      ) {
        return scanned.afterDelimiter;
      }
    }
  }

  // Fallback: unframed CN/EN multi-option list lead-in before an ordered/heading/bullet recommendation block.
  const listStartOffset = findPrimaryPreListOffset(text);
  if (listStartOffset > 0 && listStartOffset <= 360) {
    const preList = text.slice(0, listStartOffset).trim().slice(0, 360);
    if (!preList) return 0;

    const preListNoGreeting = preList.replace(INTRO_GREETING_PREFIX, '').trim();
    const preListWithoutColon = preListNoGreeting.replace(/[：:]\s*$/, '').trim();
    const finalClauseParts = preListWithoutColon
      .split(/[，,。！？.!?;；]/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const finalClause = finalClauseParts[finalClauseParts.length - 1] ?? preListWithoutColon;
    const finalClauseIsMultiOption =
      MULTI_OPTION_LIST_LEAD_IN.test(finalClause) || COMPETITOR_LIST_LEAD_IN.test(finalClause);

    // If the clause immediately introducing the list describes attributes/pros of the subject
    // itself (e.g. "其主要特点如下：" or "Its main pros are:"), never suppress the intro as an echo
    // even if an earlier descriptive clause contained "热门产品" or "best options".
    if (
      !finalClauseIsMultiOption &&
      (ATTRIBUTE_ONLY_LEAD_IN_ANYWHERE.test(finalClause) ||
        (finalClauseParts.length >= 2 && ANAPHORIC_BRAND_CONTINUATION.test(finalClause)))
    ) {
      return 0;
    }

    const isMultiOptionLeadIn =
      MULTI_OPTION_LIST_LEAD_IN.test(preList) || COMPETITOR_LIST_LEAD_IN.test(preList);

    if (DIRECT_RECOMMENDATION_PREFIX.test(preListNoGreeting) && !isMultiOptionLeadIn) {
      return 0;
    }
    if (ATTRIBUTE_ONLY_LEAD_IN_ANYWHERE.test(preList) && !isMultiOptionLeadIn) {
      return 0;
    }

    const firstClause = scanOpeningClauseEnd(preList, 0);
    if (firstClause && !isMultiOptionLeadIn) {
      const followUp = preList.slice(firstClause.afterDelimiter).trim();
      if (ANAPHORIC_BRAND_CONTINUATION.test(followUp)) {
        return 0;
      }
    }

    if (isMultiOptionLeadIn) {
      return listStartOffset;
    }

    const endsWithColon = /[：:]$/.test(preList);
    if (
      endsWithColon &&
      (sharesPromptEcho(preListNoGreeting, promptText) ||
        UNFRAMED_QUESTION_ECHO.test(preListNoGreeting))
    ) {
      return listStartOffset;
    }
  }

  return 0;
}

/**
 * 查找品牌/竞品在回答正文中的全部字符偏移（升序去重）。
 * 默认跳过开头“提问复述/导语”区域；若正文未直接出现词条但 citedUrls 命中其域名，返回 [text.length + citationIndex] 作为兜底位置。
 */
export function findSubjectMentionOffsets(
  text: string,
  subject: { name: string; aliases: readonly string[]; domains: readonly string[] },
  citedUrls?: readonly string[],
  options?: SubjectMentionOptions,
): number[] {
  const safeText = typeof text === 'string' ? text : '';
  const terms = collectSubjectTerms(subject);
  const offsetSet = new Set<number>();
  const introEnd =
    options?.excludeQuestionEchoIntro === false
      ? 0
      : findQuestionEchoIntroEnd(safeText, options?.promptText);

  if (safeText.length > 0) {
    for (const term of terms) {
      const pattern = wholeWordPattern(term);
      for (const match of safeText.matchAll(pattern)) {
        if (typeof match.index === 'number' && match.index >= introEnd) {
          offsetSet.add(match.index);
        }
      }
    }
  }

  if (offsetSet.size > 0) {
    return [...offsetSet].sort((a, b) => a - b);
  }

  if (citedUrls && citedUrls.length > 0 && subject.domains.length > 0) {
    for (let idx = 0; idx < citedUrls.length; idx += 1) {
      const url = citedUrls[idx] ?? '';
      if (subject.domains.some((dom) => matchesDomain(url, dom))) {
        return [safeText.length + idx];
      }
    }
  }

  return [];
}

/**
 * 提取包含实体提及的原文证据片段（按段落/句子切分并裁剪窗口）。
 */
export function extractEvidencePassages(
  text: string,
  subject: { name: string; aliases: readonly string[]; domains: readonly string[] },
  maxPassages = 3,
  options?: SubjectMentionOptions,
): string[] {
  if (!text || !text.trim() || maxPassages <= 0) return [];
  const offsets = findSubjectMentionOffsets(text, subject, undefined, options);
  if (offsets.length === 0) return [];

  const introEnd =
    options?.excludeQuestionEchoIntro === false
      ? 0
      : findQuestionEchoIntroEnd(text, options?.promptText);
  const segments = splitSentenceSpans(text);
  const passages: string[] = [];
  const seen = new Set<string>();

  for (const offset of offsets) {
    if (passages.length >= maxPassages) break;
    const hitIdx = segments.findIndex((seg) => offset >= seg.start && offset < seg.end);
    let rawSnippet = '';
    if (hitIdx >= 0) {
      const current = segments[hitIdx];
      if (current) {
        const trimOffset =
          introEnd > current.start && introEnd < current.end ? introEnd - current.start : 0;
        rawSnippet = current.text.slice(trimOffset).trim();
        if (rawSnippet.length < 24 && segments[hitIdx + 1]) {
          rawSnippet = `${rawSnippet} ${segments[hitIdx + 1]?.text.trim() ?? ''}`.trim();
        }
      }
    }
    if (!rawSnippet || rawSnippet.length > 240) {
      const winStart = Math.max(introEnd, offset - 60);
      const winEnd = Math.min(text.length, offset + 140);
      const prefix = winStart > introEnd ? '…' : '';
      const suffix = winEnd < text.length ? '…' : '';
      rawSnippet = `${prefix}${text.slice(winStart, winEnd).replace(/\s+/g, ' ').trim()}${suffix}`;
    } else {
      rawSnippet = rawSnippet.replace(/\s+/g, ' ').trim();
    }

    if (rawSnippet && !seen.has(rawSnippet)) {
      seen.add(rawSnippet);
      passages.push(rawSnippet);
    }
  }

  return passages;
}

function splitSentenceSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const boundary = /[^。！？.!?\r\n]+[。！？.!?]?/gu;
  for (const match of text.matchAll(boundary)) {
    const start = match.index ?? 0;
    const chunk = match[0];
    if (chunk.trim().length > 0) {
      spans.push({ start, end: start + chunk.length, text: chunk });
    }
  }
  return spans;
}

export type StructuredSubjectMatch = {
  subjectKey: string;
  structuredRank: number | null;
  matchedItemOffset: number | null;
  matchedItemPassage: string | null;
};

function subjectMatchesText(text: string, patterns: readonly RegExp[]): boolean {
  if (!text) return false;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * 在有序列表 / Markdown 标题 / 项目符号推荐清单中解析各追踪对象的结构化顺位。
 * 优先按条目头部（headerText）匹配，避免第 #1 条正文中顺带提及我方品牌时抢占顺位。
 */
export function resolveStructuredSubjectRanks(
  text: string,
  subjects: ReadonlyArray<{ key: string; subject: TrackedSubject }>,
  options?: SubjectMentionOptions,
): Map<string, StructuredSubjectMatch> {
  const result = new Map<string, StructuredSubjectMatch>();
  if (typeof text !== 'string' || !text.trim() || subjects.length === 0) return result;

  const introEnd =
    options?.excludeQuestionEchoIntro === false
      ? 0
      : findQuestionEchoIntroEnd(text, options?.promptText);
  const allItems = extractStructuredRecommendationItems(text).filter(
    (item) => item.startOffset >= introEnd,
  );
  if (allItems.length === 0) return result;

  const blocks = new Map<number, StructuredListItem[]>();
  for (const item of allItems) {
    const list = blocks.get(item.blockId);
    if (list) list.push(item);
    else blocks.set(item.blockId, [item]);
  }

  const compiledSubjects = subjects.map(({ key, subject }) => ({
    key,
    patterns: collectSubjectTerms(subject).map((term) => wholeWordPattern(term)),
  }));

  const kindPriority: Record<StructuredListItemKind, number> = {
    ordered: 3,
    heading: 2,
    bullet: 1,
  };

  let bestScore: {
    headerMatches: number;
    totalMatches: number;
    kindWeight: number;
    startOffset: number;
    matches: Map<string, StructuredSubjectMatch>;
  } | null = null;

  for (const blockItems of blocks.values()) {
    const first = blockItems[0];
    if (!first) continue;
    const isCandidate =
      blockItems.length >= 2 ||
      (first.kind === 'ordered' && first.explicitRank !== null && first.explicitRank >= 1);
    if (!isCandidate) continue;

    const blockMatches = new Map<string, StructuredSubjectMatch>();
    let headerMatches = 0;

    // Pass 1: headerText match (highest precision, immune to item #1 body cross-references)
    for (const subj of compiledSubjects) {
      for (const item of blockItems) {
        if (subjectMatchesText(item.headerText, subj.patterns)) {
          headerMatches += 1;
          blockMatches.set(subj.key, {
            subjectKey: subj.key,
            structuredRank: Math.max(1, item.explicitRank ?? item.ordinal),
            matchedItemOffset: item.startOffset,
            matchedItemPassage: item.bodyText.replace(/\s+/g, ' ').trim().slice(0, 240) || null,
          });
          break;
        }
      }
    }

    // Pass 2: bodyText fallback for subjects not matched in any item header
    for (const subj of compiledSubjects) {
      if (blockMatches.has(subj.key)) continue;
      for (const item of blockItems) {
        if (subjectMatchesText(item.bodyText, subj.patterns)) {
          blockMatches.set(subj.key, {
            subjectKey: subj.key,
            structuredRank: Math.max(1, item.explicitRank ?? item.ordinal),
            matchedItemOffset: item.startOffset,
            matchedItemPassage: item.bodyText.replace(/\s+/g, ' ').trim().slice(0, 240) || null,
          });
          break;
        }
      }
    }

    if (blockMatches.size === 0) continue;

    const candidate = {
      headerMatches,
      totalMatches: blockMatches.size,
      kindWeight: kindPriority[first.kind],
      startOffset: first.startOffset,
      matches: blockMatches,
    };

    if (
      !bestScore ||
      candidate.headerMatches > bestScore.headerMatches ||
      (candidate.headerMatches === bestScore.headerMatches &&
        candidate.totalMatches > bestScore.totalMatches) ||
      (candidate.headerMatches === bestScore.headerMatches &&
        candidate.totalMatches === bestScore.totalMatches &&
        candidate.kindWeight > bestScore.kindWeight) ||
      (candidate.headerMatches === bestScore.headerMatches &&
        candidate.totalMatches === bestScore.totalMatches &&
        candidate.kindWeight === bestScore.kindWeight &&
        candidate.startOffset < bestScore.startOffset)
    ) {
      bestScore = candidate;
    }
  }

  return bestScore ? bestScore.matches : result;
}

export type RankedSubjectInput = {
  name: string;
  mentioned: boolean;
  firstMention: number | null;
  structuredRank?: number | null;
};

export type RankedSubjectResult<T extends RankedSubjectInput = RankedSubjectInput> = T & {
  position: number | null;
};

function isValidStructuredRank(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

/**
 * 优先按有序列表/标题的结构化顺位（structuredRank），否则按首次提及偏移量赋予 1-based 推荐顺位（1, 2, 3...）。
 * 未命中的对象顺位固定为 null，返回数组保持输入顺序。
 */
export function rankTrackedSubjects<T extends RankedSubjectInput>(
  subjects: readonly T[],
): Array<RankedSubjectResult<T>> {
  const mentioned = subjects
    .map((subject, idx) => ({ subject, idx }))
    .filter((entry) => entry.subject.mentioned);

  const hasAnyStructuredRank = mentioned.some((entry) =>
    isValidStructuredRank(entry.subject.structuredRank),
  );

  const positionByIndex = new Map<number, number>();

  if (!hasAnyStructuredRank) {
    mentioned.sort((left, right) => {
      const leftOffset = left.subject.firstMention ?? Number.MAX_SAFE_INTEGER;
      const rightOffset = right.subject.firstMention ?? Number.MAX_SAFE_INTEGER;
      if (leftOffset !== rightOffset) return leftOffset - rightOffset;
      return left.idx - right.idx;
    });

    mentioned.forEach((entry, rankIdx) => {
      positionByIndex.set(entry.idx, rankIdx + 1);
    });
  } else {
    mentioned.sort((left, right) => {
      const leftHas = isValidStructuredRank(left.subject.structuredRank);
      const rightHas = isValidStructuredRank(right.subject.structuredRank);
      if (leftHas !== rightHas) return leftHas ? -1 : 1;
      if (leftHas && rightHas) {
        const lRank = Math.floor(left.subject.structuredRank as number);
        const rRank = Math.floor(right.subject.structuredRank as number);
        if (lRank !== rRank) return lRank - rRank;
      }
      const leftOffset = left.subject.firstMention ?? Number.MAX_SAFE_INTEGER;
      const rightOffset = right.subject.firstMention ?? Number.MAX_SAFE_INTEGER;
      if (leftOffset !== rightOffset) return leftOffset - rightOffset;
      return left.idx - right.idx;
    });

    let lastPos = 0;
    for (const entry of mentioned) {
      const rank = entry.subject.structuredRank;
      const pos = isValidStructuredRank(rank)
        ? Math.max(Math.floor(rank), lastPos + 1)
        : lastPos + 1;
      positionByIndex.set(entry.idx, pos);
      lastPos = pos;
    }
  }

  return subjects.map((subject, idx) => ({
    ...subject,
    position: subject.mentioned ? (positionByIndex.get(idx) ?? null) : null,
  }));
}

function roundOneDecimal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * 计算可见率百分比（0..100，保留 1 位小数；分母 <= 0 时返回 0）。
 */
export function computeVisibilityPct(mentionedCount: number, completedCount: number): number {
  if (!Number.isFinite(completedCount) || completedCount <= 0) return 0;
  if (!Number.isFinite(mentionedCount) || mentionedCount <= 0) return 0;
  const clamped = Math.min(mentionedCount, completedCount);
  return roundOneDecimal((clamped / completedCount) * 100);
}

export type ShareOfVoiceEntry = {
  name: string;
  isBrand: boolean;
  mentions: number;
  sharePct: number;
};

export type ShareOfVoiceSummary = {
  totalMentions: number;
  brandMentions: number;
  brandSharePct: number;
  entries: ShareOfVoiceEntry[];
};

/**
 * 计算声量占比（Share of Voice %）：本品牌提及次数 /（本品牌 + 全部竞品提及总次数）。
 * 分母为 0 时安全返回 brandSharePct: 0，entries 按提及次数降序排列。
 */
export function computeShareOfVoice(
  brand: { name: string; mentions: number },
  competitors: ReadonlyArray<{ name: string; mentions: number }>,
): ShareOfVoiceSummary {
  const brandMentions = Math.max(
    0,
    Number.isFinite(brand.mentions) ? Math.floor(brand.mentions) : 0,
  );
  const compRows = competitors.map((comp) => ({
    name: comp.name,
    isBrand: false,
    mentions: Math.max(0, Number.isFinite(comp.mentions) ? Math.floor(comp.mentions) : 0),
  }));

  const totalMentions = brandMentions + compRows.reduce((sum, item) => sum + item.mentions, 0);

  const rawEntries: ShareOfVoiceEntry[] = [
    {
      name: brand.name,
      isBrand: true,
      mentions: brandMentions,
      sharePct: totalMentions > 0 ? roundOneDecimal((brandMentions / totalMentions) * 100) : 0,
    },
    ...compRows.map((comp) => ({
      name: comp.name,
      isBrand: false,
      mentions: comp.mentions,
      sharePct: totalMentions > 0 ? roundOneDecimal((comp.mentions / totalMentions) * 100) : 0,
    })),
  ];

  rawEntries.sort((left, right) => {
    if (right.mentions !== left.mentions) return right.mentions - left.mentions;
    if (left.isBrand !== right.isBrand) return left.isBrand ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN');
  });

  return {
    totalMentions,
    brandMentions,
    brandSharePct: totalMentions > 0 ? roundOneDecimal((brandMentions / totalMentions) * 100) : 0,
    entries: rawEntries,
  };
}

/**
 * 计算命中时的平均推荐顺位（保留 1 位小数；无有效顺位时返回 null）。
 */
export function computeAvgPosition(
  positions: ReadonlyArray<number | null | undefined>,
): number | null {
  const valid = positions.filter(
    (pos): pos is number => typeof pos === 'number' && Number.isFinite(pos) && pos >= 1,
  );
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, pos) => acc + pos, 0);
  return roundOneDecimal(sum / valid.length);
}

export type SentimentSummary = {
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  total: number;
  positivePct: number;
  negativePct: number;
};

export function computeSentimentSummary(
  sentiments: ReadonlyArray<VisibilitySentiment | string | null | undefined>,
): SentimentSummary {
  let positive = 0;
  let neutral = 0;
  let mixed = 0;
  let negative = 0;

  for (const item of sentiments) {
    if (!item || typeof item !== 'string') continue;
    if (item === 'positive') positive += 1;
    else if (item === 'neutral') neutral += 1;
    else if (item === 'mixed') mixed += 1;
    else if (item === 'negative') negative += 1;
  }

  const total = positive + neutral + mixed + negative;
  return {
    positive,
    neutral,
    mixed,
    negative,
    total,
    positivePct: total > 0 ? roundOneDecimal((positive / total) * 100) : 0,
    negativePct: total > 0 ? roundOneDecimal((negative / total) * 100) : 0,
  };
}

const FANOUT_SPLIT_RE = /[;；\r\n]+/;
const FANOUT_CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const FANOUT_WHITESPACE_RE = /\s+/g;
// Anchored at ^ with bounded quantifiers, disjoint from decimal/negative prefixes like "2.5G", "14.5W", "-10℃":
const FANOUT_LEADING_MARKER_RE =
  /^(?:[-*·–—]{1,3}(?:\s+|$)|[•▪▸●○◆◇➤►]{1,3}\s*|\d{1,2}[.)](?:\s+|$)|\d{1,2}[、）]\s*|[(（\[]\d{1,2}[)）\]]\s*|[一二三四五六七八九十]{1,2}[、.．]\s*)/u;
const FANOUT_HAS_ALNUM_RE = /[\p{L}\p{N}]/u;

/**
 * 清洗 Query Fan-Out 搜索拆解词：按分号/换行拆行、压缩空白、剥离行首项目符号或序号、过滤纯标点/空串及与原问题（不区分大小写）相同的词，保序去重。
 */
export function normalizeFanOutQueries(queries: readonly string[], promptText = ''): string[] {
  const normalizedPrompt =
    typeof promptText === 'string'
      ? promptText
          .replace(FANOUT_CONTROL_RE, ' ')
          .replace(FANOUT_WHITESPACE_RE, ' ')
          .trim()
          .toLowerCase()
      : '';

  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const raw of queries) {
    if (typeof raw !== 'string') continue;
    // Split on \r\n BEFORE stripping control characters (\u0000-\u001f includes \r and \n).
    const segments = raw.split(FANOUT_SPLIT_RE);
    for (const seg of segments) {
      let token = seg.replace(FANOUT_CONTROL_RE, ' ').replace(FANOUT_WHITESPACE_RE, ' ').trim();
      for (let pass = 0; pass < 2 && token.length > 0; pass += 1) {
        const stripped = token.replace(FANOUT_LEADING_MARKER_RE, '').trim();
        if (stripped === token) break;
        token = stripped;
      }
      if (!token || !FANOUT_HAS_ALNUM_RE.test(token)) continue;
      const key = token.toLowerCase();
      if (normalizedPrompt && key === normalizedPrompt) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(token);
    }
  }

  return cleaned;
}

export type TopicRelevanceContext = {
  brandName?: string;
  brandAliases?: readonly string[];
  competitorNames?: readonly string[];
};

export type TopicRelevanceResult = {
  relevant: boolean;
  reason: string | null;
  matchedTokens: string[];
  expectedTokens: string[];
};

const CN_STOP_PHRASES = [
  '怎么样',
  '怎么看',
  '怎么选',
  '怎么做',
  '好不好',
  '好用吗',
  '值得买吗',
  '值得选吗',
  '为什么',
  '有什么',
  '排行榜',
  '多少钱',
  '哪家好',
  '哪款好',
  '哪个好',
  '服务商',
  '怎么',
  '如何',
  '什么',
  '哪家',
  '哪款',
  '哪个',
  '哪些',
  '哪里',
  '值得',
  '推荐',
  '对比',
  '评测',
  '测评',
  '横评',
  '实测',
  '排行',
  '榜单',
  '排名',
  '价格',
  '费用',
  '成本',
  '效果',
  '优势',
  '缺点',
  '适合',
  '可以',
  '是否',
  '能否',
  '还是',
  '或者',
  '以及',
  '问题',
  '方案',
  '品牌',
  '产品',
  '工具',
  '系统',
  '平台',
  '公司',
  '企业',
  '行业',
  '市场',
  '目前',
  '当前',
  '近期',
  '现在',
  '好的',
  '吗',
  '呢',
  '啊',
  '吧',
  '的',
  '了',
  '和',
  '与',
  '及',
  '在',
  '是',
  '有',
  '用',
  '给',
  '把',
  '被',
  '对',
  '为',
  '等',
  '中',
  '上',
  '下',
];

const EN_STOP_WORDS = new Set([
  'what',
  'which',
  'how',
  'why',
  'who',
  'where',
  'when',
  'best',
  'top',
  'good',
  'better',
  'vs',
  'versus',
  'compare',
  'comparison',
  'review',
  'reviews',
  'recommend',
  'recommendation',
  'recommendations',
  'for',
  'with',
  'and',
  'or',
  'the',
  'is',
  'are',
  'to',
  'in',
  'on',
  'of',
  'a',
  'an',
  'worth',
  'tips',
  'about',
]);

const GEO_PROMPT_SIGNALS =
  /(?:geo|seo|可见性|可见度|声量|引用|溯源|蒸馏|内容运营|内容矩阵|营销工具|大模型|ai搜索|生成式引擎|词库|审计|合规|复盘)/iu;

const OFF_TOPIC_GEO_BOILERPLATE_CUES = [
  '数据可审计性',
  '合规边界',
  '长期运维成本',
  '中文语义理解',
  '引用溯源归类',
  '团队协作闭环',
  '词库与周度复盘',
  '生成式引擎优化',
  '可见率、声量占比',
  '多引擎可见性诊断',
  '内容矩阵协同',
  '多维度看板',
  '行业基准对比',
  '基础词条管理',
  '标准化报表模板',
] as const;

const GENERIC_CJK_BIGRAMS = new Set([
  '控制',
  '管理',
  '分析',
  '处理',
  '优化',
  '提升',
  '支持',
  '使用',
  '体验',
  '服务',
  '表现',
  '配置',
  '能力',
  '模式',
  '结构',
  '效率',
  '质量',
  '标准',
  '流程',
  '策略',
  '技术',
  '数据',
  '内容',
  '系统',
  '平台',
  '方案',
  '品牌',
  '产品',
  '工具',
  '行业',
  '市场',
  '用户',
  '企业',
  '团队',
  '人员',
  '操作',
  '功能',
  '性能',
  '情况',
  '方面',
  '问题',
  '方法',
  '方式',
  '条件',
  '要求',
  '需求',
  '应用',
  '场景',
  '环境',
  '状态',
  '结果',
  '影响',
  '作用',
  '价值',
  '优势',
  '特点',
  '基础',
  '核心',
  '关键',
  '主要',
  '综合',
  '整体',
  '日常',
  '长期',
  '稳定',
  '安全',
  '可靠',
  '成熟',
  '专业',
  '高效',
  '便捷',
  '灵活',
]);

function stripQuotedPromptEchoes(text: string, promptText: string): string {
  const normPrompt = normalizeForEchoCompare(promptText);
  if (normPrompt.length < 4) return text;
  return text.replace(/[「『“"《]([^」』”"》\r\n]{2,160})[」』”"》]/gu, (full, inner: string) => {
    const normInner = normalizeForEchoCompare(inner);
    if (
      normInner.length >= 4 &&
      (normInner.includes(normPrompt) || normPrompt.includes(normInner))
    ) {
      return ' ';
    }
    return full;
  });
}

function extractPromptTopicTokens(
  promptText: string,
  context: TopicRelevanceContext = {},
): string[] {
  // Strip generic bracketed uppercase metadata/tag prefixes (e.g. [TAG_NAME], [V2-TEST])
  // so operational/tracking tags do not act as required answer topic keywords.
  let cleaned = stripBracketedMetadataTags(promptText);
  const excludeTerms = [
    context.brandName ?? '',
    ...(context.brandAliases ?? []),
    ...(context.competitorNames ?? []),
  ]
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const term of excludeTerms) {
    cleaned = cleaned.replace(wholeWordPattern(term), ' ');
  }

  // Strip year tokens like 2025年 / 2026
  cleaned = cleaned.replace(/\b20\d{2}年?\b/gu, ' ');

  const seen = new Set<string>();
  const tokens: string[] = [];
  const pushToken = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t || t.length < 2) return;
    if (EN_STOP_WORDS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    tokens.push(t);
  };

  for (const m of cleaned.matchAll(/[a-z0-9][a-z0-9._+-]{1,31}/giu)) {
    pushToken(m[0]);
  }

  // Split CJK runs and peel CN stop phrases
  let cjkSource = cleaned.replace(/[a-z0-9._+-]+/giu, ' ');
  for (const phrase of CN_STOP_PHRASES) {
    if (phrase.length >= 2) {
      cjkSource = cjkSource.split(phrase).join(' ');
    }
  }
  const singleCharStops = new Set(CN_STOP_PHRASES.filter((p) => p.length === 1));
  for (const run of cjkSource.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    let segment = run[0];
    while (segment.length > 2 && singleCharStops.has(segment[0] ?? '')) {
      segment = segment.slice(1);
    }
    while (segment.length > 2 && singleCharStops.has(segment[segment.length - 1] ?? '')) {
      segment = segment.slice(0, -1);
    }
    if (segment.length >= 2) {
      pushToken(segment);
    }
  }

  return tokens;
}

function doesTokenMatchBody(token: string, bodyText: string, bodyLower: string): boolean {
  if (/^[a-z0-9._+-]+$/i.test(token)) {
    if (wholeWordPattern(token).test(bodyText)) return true;
    return token.length >= 3 && bodyLower.includes(token);
  }
  if (bodyLower.includes(token)) return true;
  if (token.length === 3) {
    for (let i = 0; i <= token.length - 2; i += 1) {
      const gram = token.slice(i, i + 2);
      if (!GENERIC_CJK_BIGRAMS.has(gram) && bodyLower.includes(gram)) {
        return true;
      }
    }
    return false;
  }
  if (token.length >= 4) {
    for (let i = 0; i <= token.length - 3; i += 1) {
      const trigram = token.slice(i, i + 3);
      if (bodyLower.includes(trigram)) return true;
    }
    let matchedBigrams = 0;
    const seenGrams = new Set<string>();
    for (let i = 0; i <= token.length - 2; i += 1) {
      const gram = token.slice(i, i + 2);
      if (seenGrams.has(gram) || GENERIC_CJK_BIGRAMS.has(gram)) continue;
      seenGrams.add(gram);
      if (bodyLower.includes(gram)) {
        matchedBigrams += 1;
        if (matchedBigrams >= 2) return true;
      }
    }
  }
  return false;
}

/**
 * 校验 AI 回答正文与监测问题的主题相关性（#217 跑题护栏）。
 * - 剥离首句提问复述与原题引号引用，防止"复述原题 + 无关模板正文"绕过校验；
 * - 识别开发占位标记（【FAKE】）及非 GEO 问题的通用 GEO/运维模板话术；
 * - 对长篇实质正文（>=60 字）若完全未覆盖任何非品牌核心主题词则判定为可能跑题。
 */
export function assessAnswerTopicRelevance(
  promptText: string,
  answerText: string,
  context: TopicRelevanceContext = {},
): TopicRelevanceResult {
  const safePrompt = typeof promptText === 'string' ? promptText.trim() : '';
  const safeAnswer = typeof answerText === 'string' ? answerText.trim() : '';
  if (!safePrompt || !safeAnswer) {
    return { relevant: true, reason: null, matchedTokens: [], expectedTokens: [] };
  }

  if (safeAnswer.startsWith(FAKE_MARK)) {
    return {
      relevant: false,
      reason: '回答内容为开发占位输出，非真实主题回答',
      matchedTokens: [],
      expectedTokens: [],
    };
  }

  const introEnd = findQuestionEchoIntroEnd(safeAnswer, safePrompt);
  const bodyWithoutIntro = safeAnswer.slice(introEnd).trim();
  const bodyText = stripQuotedPromptEchoes(bodyWithoutIntro || safeAnswer, safePrompt).trim();
  const bodyLower = bodyText.toLowerCase();

  const expectedTokens = extractPromptTopicTokens(safePrompt, context);
  const matchedTokens = expectedTokens.filter((tok) =>
    doesTokenMatchBody(tok, bodyText, bodyLower),
  );

  const isGeoPrompt = GEO_PROMPT_SIGNALS.test(safePrompt);
  if (!isGeoPrompt) {
    const boilerplateHits = OFF_TOPIC_GEO_BOILERPLATE_CUES.filter((cue) => bodyText.includes(cue));
    if (boilerplateHits.length >= 2 && matchedTokens.length === 0) {
      return {
        relevant: false,
        reason: '回答正文疑似通用 GEO/运维模板话术，未围绕监测问题核心主题展开',
        matchedTokens,
        expectedTokens,
      };
    }
  }

  const compactBodyLen = bodyText.replace(/\s+/g, '').length;
  if (compactBodyLen >= 60 && expectedTokens.length >= 1 && matchedTokens.length === 0) {
    return {
      relevant: false,
      reason: '回答正文未覆盖监测问题核心主题词，可能存在跑题',
      matchedTokens,
      expectedTokens,
    };
  }

  return {
    relevant: true,
    reason: null,
    matchedTokens,
    expectedTokens,
  };
}

export type RawCitationForMetrics = {
  url: string;
  domain?: string | null;
  sourceKind?: string | null;
};

export type RawObservationForMetrics = {
  id?: string;
  status?: string;
  promptText?: string | null;
  answerText?: string | null;
  brandMentioned?: boolean | null;
  brandPosition?: number | null;
  brandSentiment?: string | null;
  topicRelevant?: boolean | null;
  competitorHits?: unknown;
  citations?: readonly RawCitationForMetrics[] | null;
};

export type ProfileForMetrics = {
  brandName: string;
  brandAliases?: readonly string[];
  ownedDomains?: readonly string[];
  competitors?: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    domains?: readonly string[];
  }>;
};

export type DomainMetricItem = {
  domain: string;
  sourceKind: CitationSourceKind;
  count: number;
  observationCount: number;
};

export type RecomputedRunMetrics = {
  completedChecks: number;
  mentionedChecks: number;
  visibilityPct: number;
  shareOfVoice: ShareOfVoiceSummary;
  avgPosition: number | null;
  sentimentSummary: SentimentSummary;
  totalCitations: number;
  ownedCitations: number;
  ownedCitationChecks: number;
  ownedCitationRatePct: number;
  ownedCitationCheckRatePct: number;
  topDomains: DomainMetricItem[];
};

function parseCompetitorHitsArray(raw: unknown): Array<{
  name: string;
  mentioned: boolean;
  position: number | null;
  sentiment: VisibilitySentiment | null;
}> | null {
  if (!Array.isArray(raw)) return null;
  const parsed: Array<{
    name: string;
    mentioned: boolean;
    position: number | null;
    sentiment: VisibilitySentiment | null;
  }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== 'string') continue;
    parsed.push({
      name: obj.name,
      mentioned: Boolean(obj.mentioned),
      position:
        typeof obj.position === 'number' && Number.isFinite(obj.position) && obj.position >= 1
          ? obj.position
          : null,
      sentiment:
        typeof obj.sentiment === 'string' && isVisibilitySentiment(obj.sentiment)
          ? obj.sentiment
          : null,
    });
  }
  return parsed;
}

/**
 * 纯函数审计重算：直接基于原始观测记录与引用明细幂等重算全部核心可见性指标。
 */
export function recomputeRunMetrics(
  observations: readonly RawObservationForMetrics[],
  profile: ProfileForMetrics,
): RecomputedRunMetrics {
  const completed = observations.filter(
    (obs) => obs.status === undefined || obs.status === 'SUCCESS',
  );
  const completedChecks = completed.length;

  const ownedDomains = profile.ownedDomains ?? [];
  const competitors = profile.competitors ?? [];
  const competitorDomains = competitors.flatMap((comp) => comp.domains ?? []);
  const competitorNames = competitors.map((comp) => comp.name);
  const competitorMentionCounts = new Map<string, number>();
  for (const comp of competitors) {
    competitorMentionCounts.set(comp.name, 0);
  }

  let mentionedChecks = 0;
  const positions: Array<number | null> = [];
  const sentiments: Array<string | null> = [];
  let totalCitations = 0;
  let ownedCitations = 0;
  let ownedCitationChecks = 0;

  const domainAgg = new Map<
    string,
    { sourceKind: CitationSourceKind; count: number; obsIndices: Set<number> }
  >();

  completed.forEach((obs, obsIdx) => {
    const citations = obs.citations ?? [];
    const citedUrls = citations.map((item) => item.url);
    const mentionOptions: SubjectMentionOptions | undefined = obs.promptText
      ? { promptText: obs.promptText }
      : undefined;

    const isOffTopic =
      obs.topicRelevant === false ||
      (Boolean(obs.promptText) &&
        Boolean(obs.answerText) &&
        !assessAnswerTopicRelevance(obs.promptText ?? '', obs.answerText ?? '', {
          brandName: profile.brandName,
          brandAliases: profile.brandAliases,
          competitorNames,
        }).relevant);

    let brandMentioned: boolean;
    let brandPosition: number | null = obs.brandPosition ?? null;

    if (isOffTopic) {
      brandMentioned = false;
      brandPosition = null;
    } else if (typeof obs.brandMentioned === 'boolean') {
      brandMentioned = obs.brandMentioned;
    } else {
      const brandSubject: TrackedSubject = {
        name: profile.brandName,
        aliases: profile.brandAliases ?? [],
        domains: ownedDomains,
      };
      const brandOffsets = findSubjectMentionOffsets(
        obs.answerText ?? '',
        brandSubject,
        citedUrls,
        mentionOptions,
      );
      brandMentioned = brandOffsets.length > 0;
      if (brandMentioned && brandPosition === null) {
        const structuredRanks = resolveStructuredSubjectRanks(
          obs.answerText ?? '',
          [
            { key: 'brand', subject: brandSubject },
            ...competitors.map((comp, idx) => ({
              key: `comp:${idx}`,
              subject: {
                name: comp.name,
                aliases: comp.aliases ?? [],
                domains: comp.domains ?? [],
              },
            })),
          ],
          mentionOptions,
        );
        const ranked = rankTrackedSubjects([
          {
            name: profile.brandName,
            mentioned: true,
            firstMention: brandOffsets[0] ?? null,
            structuredRank: structuredRanks.get('brand')?.structuredRank ?? null,
          },
          ...competitors.map((comp, idx) => {
            const compOffsets = findSubjectMentionOffsets(
              obs.answerText ?? '',
              {
                name: comp.name,
                aliases: comp.aliases ?? [],
                domains: comp.domains ?? [],
              },
              citedUrls,
              mentionOptions,
            );
            return {
              name: comp.name,
              mentioned: compOffsets.length > 0,
              firstMention: compOffsets[0] ?? null,
              structuredRank: structuredRanks.get(`comp:${idx}`)?.structuredRank ?? null,
            };
          }),
        ]);
        brandPosition = ranked[0]?.position ?? null;
      }
    }

    if (brandMentioned) {
      mentionedChecks += 1;
      positions.push(brandPosition);
      sentiments.push(obs.brandSentiment ?? null);
    }

    const storedHits = parseCompetitorHitsArray(obs.competitorHits);
    if (storedHits) {
      for (const hit of storedHits) {
        if (hit.mentioned && competitorMentionCounts.has(hit.name)) {
          competitorMentionCounts.set(hit.name, (competitorMentionCounts.get(hit.name) ?? 0) + 1);
        }
      }
    } else if (typeof obs.answerText === 'string' && obs.answerText.length > 0) {
      for (const comp of competitors) {
        const compOffsets = findSubjectMentionOffsets(
          obs.answerText,
          {
            name: comp.name,
            aliases: comp.aliases ?? [],
            domains: comp.domains ?? [],
          },
          citedUrls,
          mentionOptions,
        );
        if (compOffsets.length > 0) {
          competitorMentionCounts.set(comp.name, (competitorMentionCounts.get(comp.name) ?? 0) + 1);
        }
      }
    }

    let hasOwnedInObs = false;
    for (const cite of citations) {
      const domain = normalizeVisibilityDomain(cite.domain || cite.url);
      if (!domain) continue;
      const sourceKind = classifyCitationSource(cite.url || domain, {
        ownedDomains,
        competitorDomains,
      });
      totalCitations += 1;
      if (sourceKind === 'OWNED') {
        ownedCitations += 1;
        hasOwnedInObs = true;
      }

      const existing = domainAgg.get(domain);
      if (existing) {
        existing.count += 1;
        existing.obsIndices.add(obsIdx);
      } else {
        domainAgg.set(domain, {
          sourceKind,
          count: 1,
          obsIndices: new Set([obsIdx]),
        });
      }
    }
    if (hasOwnedInObs) ownedCitationChecks += 1;
  });

  const topDomains: DomainMetricItem[] = [...domainAgg.entries()]
    .map(([domain, meta]) => ({
      domain,
      sourceKind: meta.sourceKind,
      count: meta.count,
      observationCount: meta.obsIndices.size,
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.domain.localeCompare(right.domain);
    });

  return {
    completedChecks,
    mentionedChecks,
    visibilityPct: computeVisibilityPct(mentionedChecks, completedChecks),
    shareOfVoice: computeShareOfVoice(
      { name: profile.brandName, mentions: mentionedChecks },
      competitors.map((comp) => ({
        name: comp.name,
        mentions: competitorMentionCounts.get(comp.name) ?? 0,
      })),
    ),
    avgPosition: computeAvgPosition(positions),
    sentimentSummary: computeSentimentSummary(sentiments),
    totalCitations,
    ownedCitations,
    ownedCitationChecks,
    ownedCitationRatePct: computeVisibilityPct(ownedCitations, totalCitations),
    ownedCitationCheckRatePct: computeVisibilityPct(ownedCitationChecks, completedChecks),
    topDomains,
  };
}

export function quoteVisibilityRunPoints(
  totalChecks: number,
  unitPoints = VISIBILITY_DEFAULT_UNIT_POINTS,
): {
  totalChecks: number;
  unitPoints: number;
  totalPoints: number;
} {
  const safeChecks = Number.isInteger(totalChecks) && totalChecks > 0 ? totalChecks : 1;
  const safeUnit =
    Number.isInteger(unitPoints) && unitPoints > 0 ? unitPoints : VISIBILITY_DEFAULT_UNIT_POINTS;
  return {
    totalChecks: safeChecks,
    unitPoints: safeUnit,
    totalPoints: safeChecks * safeUnit,
  };
}

export function formatVisibilityRunSubmitLabel(totalChecks: number, unitPoints: number): string {
  const quote = quoteVisibilityRunPoints(totalChecks, unitPoints);
  return `开始监测（${quote.unitPoints}点数/次，共 ${quote.totalChecks} 次检查，预冻 ${quote.totalPoints} 点）`;
}

// ===================== Profile–Keyword Brand Isolation (#218, #213) =====================

export type VisibilityProfileKeywordTarget = {
  id?: string;
  name?: string;
  brandName: string;
  brandAliases?: readonly string[];
  ownedDomains?: readonly string[];
  competitors?: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    domains?: readonly string[];
  }>;
};

export type VisibilityKeywordCandidate = {
  id: string;
  main: string;
  brands: readonly string[];
};

const GENERIC_SUBDOMAIN_LABELS = new Set([
  'www',
  'docs',
  'doc',
  'blog',
  'help',
  'support',
  'm',
  'app',
  'api',
  'news',
  'shop',
  'store',
  'mall',
  'cn',
  'en',
  'us',
  'de',
  'uk',
  'jp',
  'global',
]);

const GENERIC_SECOND_LEVEL_DOMAINS = new Set([
  'com',
  'co',
  'net',
  'org',
  'gov',
  'edu',
  'ac',
  'example',
  'localhost',
]);

function collapseTrim(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function expandBrandPhraseVariants(raw: string): string[] {
  const cleaned = collapseTrim(raw);
  if (!cleaned) return [];

  const out: string[] = [cleaned];
  const outer = collapseTrim(cleaned.replace(/\s*[（(【\[][^）)】\]]+[）)】\]]\s*/gu, ' '));
  if ([...outer].length >= 2 && outer.toLowerCase() !== cleaned.toLowerCase()) {
    out.push(outer);
  }

  for (const match of cleaned.matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/gu)) {
    const inner = collapseTrim(match[1] ?? '');
    if ([...inner].length >= 2) {
      out.push(inner);
    }
  }

  const strippedLegal = collapseTrim(
    (outer || cleaned).replace(
      /(?:科技|信息|网络|电子|智能|数字|技术)?(?:股份)?(?:有限|有限责任)公司$/u,
      '',
    ),
  );
  if ([...strippedLegal].length >= 2) {
    out.push(strippedLegal);
  }

  return dedupeTrimmedStrings(out);
}

function extractDomainBrandStems(domains: readonly string[] | undefined): string[] {
  if (!domains || domains.length === 0) return [];
  const stems: string[] = [];
  for (const raw of domains) {
    const normalized = normalizeVisibilityDomain(raw);
    if (!normalized || IPV4_DOTTED.test(normalized)) continue;
    const labels = normalized.split('.').filter(Boolean);
    if (labels.length < 2) continue;
    labels.pop(); // drop TLD
    while (labels.length > 1 && GENERIC_SECOND_LEVEL_DOMAINS.has(labels[labels.length - 1] ?? '')) {
      labels.pop();
    }
    while (labels.length > 1 && GENERIC_SUBDOMAIN_LABELS.has(labels[0] ?? '')) {
      labels.shift();
    }
    const registrable = labels[labels.length - 1] ?? '';
    if (
      registrable.length >= 3 &&
      !/^\d+$/.test(registrable) &&
      !GENERIC_SECOND_LEVEL_DOMAINS.has(registrable) &&
      !GENERIC_SUBDOMAIN_LABELS.has(registrable)
    ) {
      stems.push(registrable);
    }
  }
  return dedupeTrimmedStrings(stems);
}

function isPureLatinBrandToken(term: string): boolean {
  return (
    term.length >= 2 &&
    !/\s/.test(term) &&
    /^[\p{Script=Latin}\p{Nd}_-]+$/u.test(term) &&
    /[A-Za-z]/.test(term)
  );
}

function extractProfileBrandTerms(profile: VisibilityProfileKeywordTarget): {
  coreTerms: string[];
  aliasTerms: string[];
} {
  const coreList: string[] = [
    ...expandBrandPhraseVariants(profile.brandName),
    ...extractDomainBrandStems(profile.ownedDomains),
  ];
  const aliasList: string[] = [];

  for (const rawAlias of profile.brandAliases ?? []) {
    for (const variant of expandBrandPhraseVariants(rawAlias)) {
      if (isPureLatinBrandToken(variant)) {
        coreList.push(variant);
      } else {
        aliasList.push(variant);
      }
    }
  }

  const coreTerms = dedupeTrimmedStrings(coreList);
  const coreSet = new Set(coreTerms.map((t) => t.toLowerCase()));
  const aliasTerms = dedupeTrimmedStrings(aliasList).filter((t) => !coreSet.has(t.toLowerCase()));
  return { coreTerms, aliasTerms };
}

function matchesCoreTerm(coreTerm: string, candidateText: string): boolean {
  const normCore = collapseTrim(coreTerm).toLowerCase();
  const normCandidate = collapseTrim(candidateText).toLowerCase();
  if (!normCore || !normCandidate) return false;
  if (normCore === normCandidate) return true;

  if ([...coreTerm].length >= 2 && wholeWordPattern(coreTerm).test(candidateText)) {
    return true;
  }

  if ([...candidateText].length >= 2 && wholeWordPattern(candidateText).test(coreTerm)) {
    if (isPureLatinBrandToken(candidateText)) {
      return candidateText.length >= 3;
    }
    return normCore.startsWith(normCandidate);
  }

  return false;
}

function matchesAliasTerm(aliasTerm: string, candidateText: string): boolean {
  const normAlias = collapseTrim(aliasTerm).toLowerCase();
  const normCandidate = collapseTrim(candidateText).toLowerCase();
  if (!normAlias || !normCandidate) return false;
  if (normAlias === normCandidate) return true;
  if ([...aliasTerm].length < 2) return false;

  if (ALNUM_WORD_CHAR.test(aliasTerm[0] ?? '')) {
    return normCandidate.startsWith(normAlias) && wholeWordPattern(aliasTerm).test(candidateText);
  }
  return normCandidate.startsWith(normAlias);
}

function matchesAnyCompetitor(
  candidateTexts: readonly string[],
  competitors: VisibilityProfileKeywordTarget['competitors'],
): boolean {
  if (!competitors || competitors.length === 0) return false;
  for (const comp of competitors) {
    const { coreTerms, aliasTerms } = extractProfileBrandTerms({
      brandName: comp.name,
      brandAliases: comp.aliases,
      ownedDomains: comp.domains,
    });
    for (const text of candidateTexts) {
      if (
        coreTerms.some((t) => matchesCoreTerm(t, text)) ||
        aliasTerms.some((t) => matchesAliasTerm(t, text))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 判断某条训练主词（Keyword）是否归属于指定品牌监测档案（VisibilityProfile）。
 * - 若主词已显式填写 `brands`（公司/品牌），严格按品牌词与档案主品牌/别名/自有域名词根匹配，绝不用 `main` 泛品类词跨牌误绑；
 * - 若主词未填写 `brands`，仅当 `main` 明确命中该档案品牌标识且未落入竞品或其他档案主品牌时才归属该档案。
 */
export function matchesVisibilityProfileKeyword(
  keyword: Pick<VisibilityKeywordCandidate, 'main' | 'brands'>,
  profile: VisibilityProfileKeywordTarget,
  allProfiles?: readonly VisibilityProfileKeywordTarget[],
): boolean {
  const { coreTerms, aliasTerms } = extractProfileBrandTerms(profile);
  if (coreTerms.length === 0 && aliasTerms.length === 0) return false;

  const kwBrands = dedupeTrimmedStrings(keyword.brands ?? []);
  if (kwBrands.length > 0) {
    const matchedCore = kwBrands.some((brand) =>
      coreTerms.some((core) => matchesCoreTerm(core, brand)),
    );
    const matchedAlias =
      !matchedCore &&
      kwBrands.some((brand) => aliasTerms.some((alias) => matchesAliasTerm(alias, brand)));

    if (!matchedCore && !matchedAlias) {
      return false;
    }

    if (!matchedCore) {
      if (matchesAnyCompetitor(kwBrands, profile.competitors)) {
        return false;
      }
      if (allProfiles && allProfiles.length > 1) {
        const claimedByOtherCore = allProfiles.some((other) => {
          if (other === profile || (profile.id && other.id === profile.id)) return false;
          const otherTerms = extractProfileBrandTerms(other).coreTerms;
          return kwBrands.some((brand) => otherTerms.some((core) => matchesCoreTerm(core, brand)));
        });
        if (claimedByOtherCore) return false;
      }
    }
    return true;
  }

  const kwMain = collapseTrim(keyword.main);
  if (!kwMain) return false;

  const mainMatchedCore = coreTerms.some((core) => matchesCoreTerm(core, kwMain));
  const mainMatchedAlias =
    !mainMatchedCore && aliasTerms.some((alias) => matchesAliasTerm(alias, kwMain));

  if (!mainMatchedCore && !mainMatchedAlias) {
    return false;
  }
  if (!mainMatchedCore && matchesAnyCompetitor([kwMain], profile.competitors)) {
    return false;
  }
  if (!mainMatchedCore && allProfiles && allProfiles.length > 1) {
    const claimedByOther = allProfiles.some((other) => {
      if (other === profile || (profile.id && other.id === profile.id)) return false;
      const otherExtracted = extractProfileBrandTerms(other);
      return (
        otherExtracted.coreTerms.some((core) => matchesCoreTerm(core, kwMain)) ||
        otherExtracted.aliasTerms.some((alias) => matchesAliasTerm(alias, kwMain))
      );
    });
    if (claimedByOther) return false;
  }

  return true;
}

/**
 * 过滤出归属于当前选中品牌档案的训练主词列表；未选中有效档案时返回空数组（禁止跨牌回退全租户主词）。
 */
export function filterKeywordsForVisibilityProfile<K extends VisibilityKeywordCandidate>(
  keywords: readonly K[],
  profile: VisibilityProfileKeywordTarget | null | undefined,
  allProfiles?: readonly VisibilityProfileKeywordTarget[],
): K[] {
  if (!profile) return [];
  return keywords.filter((kw) => matchesVisibilityProfileKeyword(kw, profile, allProfiles));
}

/**
 * 计算指定品牌档案下默认预填的关联训练主词 ID；若该档案无匹配主词则返回空串 `""`（不关联主词）。
 */
export function resolveDefaultKeywordIdForProfile(
  keywords: readonly VisibilityKeywordCandidate[],
  profile: VisibilityProfileKeywordTarget | null | undefined,
  allProfiles?: readonly VisibilityProfileKeywordTarget[],
): string {
  return filterKeywordsForVisibilityProfile(keywords, profile, allProfiles)[0]?.id ?? '';
}

export function hasMultipleDistinctProfileBrands(
  profiles: readonly Pick<VisibilityProfileKeywordTarget, 'brandName'>[],
): boolean {
  const brands = new Set<string>();
  for (const prof of profiles) {
    const normalized = collapseTrim(prof.brandName).toLowerCase();
    if (normalized) brands.add(normalized);
    if (brands.size > 1) return true;
  }
  return false;
}

/**
 * 解析 AI 数据看板「优化机会 & 搜索拆解词」的目标主词候选范围与默认选中值：
 * - 档案列表未加载完成时返回空列表与空默认值，防止异步竞态闪现他牌主词；
 * - 单档案视图严格隔离为该档案归属主词，无匹配时返回空列表与 `""`；
 * - 全部监测档案视图展示租户主词，多品牌租户默认置空 `""` 要求人工显式选择，单品牌租户自动预选首项。
 */
export function resolveScopedOverviewKeywords<K extends VisibilityKeywordCandidate>(input: {
  keywords: readonly K[];
  profiles: readonly VisibilityProfileKeywordTarget[];
  profilesLoaded: boolean;
  profileId?: string | null;
}): {
  scopedKeywords: K[];
  defaultKeywordId: string;
} {
  if (!input.profilesLoaded) {
    return { scopedKeywords: [], defaultKeywordId: '' };
  }

  const activeProfileId = input.profileId?.trim() ?? '';
  if (activeProfileId) {
    const targetProfile = input.profiles.find((p) => p.id === activeProfileId);
    const scopedKeywords = filterKeywordsForVisibilityProfile(
      input.keywords,
      targetProfile,
      input.profiles,
    );
    return {
      scopedKeywords,
      defaultKeywordId: scopedKeywords[0]?.id ?? '',
    };
  }

  const scopedKeywords = [...input.keywords];
  const defaultKeywordId = hasMultipleDistinctProfileBrands(input.profiles)
    ? ''
    : (scopedKeywords[0]?.id ?? '');
  return { scopedKeywords, defaultKeywordId };
}

// ===================== Zod Schemas & DTO Types =====================

function dedupeTrimmedStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

const domainListSchema = z
  .array(z.string().trim().min(1, '域名不能为空').max(255, '域名过长'))
  .max(20, '最多填写 20 个域名')
  .default([])
  .transform((items, ctx) => {
    const seen = new Set<string>();
    const out: string[] = [];
    items.forEach((raw, idx) => {
      const normalized = normalizeVisibilityDomain(raw);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [idx],
          message: `无效的域名格式：${raw}`,
        });
        return;
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    });
    return out;
  });

const aliasListSchema = z
  .array(z.string().trim().min(1, '别名不能为空').max(80, '别名最多 80 字'))
  .max(20, '最多填写 20 个别名')
  .default([])
  .transform((items) => dedupeTrimmedStrings(items));

export const visibilityCompetitorSchema = z.object({
  name: z
    .string({ required_error: '请填写竞品名称' })
    .trim()
    .min(1, '请填写竞品名称')
    .max(VISIBILITY_BRAND_NAME_MAX, `竞品名称不超过 ${VISIBILITY_BRAND_NAME_MAX} 字`),
  aliases: aliasListSchema,
  domains: domainListSchema,
});

export const visibilityProfileCreateSchema = z.object({
  name: z
    .string({ required_error: '请填写档案名称' })
    .trim()
    .min(1, '请填写档案名称')
    .max(VISIBILITY_PROFILE_NAME_MAX, `档案名称不超过 ${VISIBILITY_PROFILE_NAME_MAX} 字`),
  brandName: z
    .string({ required_error: '请填写主品牌名称' })
    .trim()
    .min(1, '请填写主品牌名称')
    .max(VISIBILITY_BRAND_NAME_MAX, `主品牌名称不超过 ${VISIBILITY_BRAND_NAME_MAX} 字`),
  brandAliases: aliasListSchema,
  ownedDomains: domainListSchema,
  competitors: z
    .array(visibilityCompetitorSchema)
    .max(VISIBILITY_MAX_COMPETITORS, `最多配置 ${VISIBILITY_MAX_COMPETITORS} 个竞品`)
    .default([]),
});

export const visibilityProfileUpdateSchema = visibilityProfileCreateSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, '至少提供一个待修改字段');

export const visibilityProfileCreateWithPrefillSchema = z
  .object({
    name: z
      .string({ required_error: '请填写档案名称' })
      .trim()
      .min(1, '请填写档案名称')
      .max(VISIBILITY_PROFILE_NAME_MAX, `档案名称不超过 ${VISIBILITY_PROFILE_NAME_MAX} 字`),
    brandName: z
      .string()
      .trim()
      .max(VISIBILITY_BRAND_NAME_MAX, `主品牌名称不超过 ${VISIBILITY_BRAND_NAME_MAX} 字`)
      .optional(),
    brandAliases: aliasListSchema,
    ownedDomains: domainListSchema,
    competitors: z
      .array(visibilityCompetitorSchema)
      .max(VISIBILITY_MAX_COMPETITORS, `最多配置 ${VISIBILITY_MAX_COMPETITORS} 个竞品`)
      .default([]),
    importFromKeywordId: z
      .string()
      .trim()
      .regex(VISIBILITY_ID_PATTERN, '训练主词编号不合法')
      .optional(),
    importFromKbId: z
      .string()
      .trim()
      .regex(VISIBILITY_ID_PATTERN, '企业知识库编号不合法')
      .optional(),
  })
  .refine(
    (val) =>
      (typeof val.brandName === 'string' && val.brandName.length > 0) ||
      Boolean(val.importFromKeywordId) ||
      Boolean(val.importFromKbId),
    {
      path: ['brandName'],
      message: '请填写主品牌名称，或选择要导入品牌词的关键词/知识库',
    },
  );

export type VisibilityProfileCreateInput = z.input<typeof visibilityProfileCreateSchema>;
export type VisibilityProfileCreateWithPrefillInput = z.input<
  typeof visibilityProfileCreateWithPrefillSchema
>;
export type VisibilityProfileUpdateInput = z.input<typeof visibilityProfileUpdateSchema>;

export type VisibilityProfileRecord = {
  id: string;
  name: string;
  brandName: string;
  brandAliases: string[];
  ownedDomains: string[];
  competitors: VisibilityCompetitor[];
  runCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type VisibilityPrefillSources = {
  keywords: Array<{
    id: string;
    main: string;
    brands: string[];
  }>;
  knowledgeBases: Array<{
    id: string;
    name: string;
    companyName: string | null;
    brandShort: string | null;
  }>;
};

export type VisibilityProfileListResponse = {
  items: VisibilityProfileRecord[];
  prefillSources?: VisibilityPrefillSources;
};

const optionalVisibilityIdSchema = z
  .union([z.string().trim(), z.null(), z.undefined()])
  .transform((val) => {
    if (!val || val.length === 0) return undefined;
    return val;
  })
  .refine((val) => val === undefined || VISIBILITY_ID_PATTERN.test(val), '编号格式不正确');

export const visibilityRunCreateSchema = z
  .object({
    profileId: z
      .string({ required_error: '请选择监测档案' })
      .trim()
      .regex(VISIBILITY_ID_PATTERN, '监测档案编号不合法'),
    keywordId: optionalVisibilityIdSchema,
    name: z
      .string()
      .trim()
      .min(1, '任务名称不能为空')
      .max(VISIBILITY_RUN_NAME_MAX, `任务名称不超过 ${VISIBILITY_RUN_NAME_MAX} 字`)
      .optional(),
    engines: z
      .array(z.enum(VISIBILITY_ENGINE_KEYS))
      .min(1, '请至少选择一个 AI 引擎')
      .max(VISIBILITY_ENGINE_KEYS.length)
      .transform((items) => [...new Set(items)]),
    questionIds: z
      .array(z.string().trim().regex(VISIBILITY_ID_PATTERN, '问题编号不合法'))
      .max(200, '单次最多选择 200 个问题')
      .default([])
      .transform((items) => [...new Set(items)]),
    customPrompts: z
      .array(z.string().trim().min(2, '自定义问题至少 2 个字').max(300, '自定义问题最多 300 字'))
      .max(100, '单次最多输入 100 个自定义问题')
      .default([])
      .transform((items) => dedupeTrimmedStrings(items)),
  })
  .refine(
    (data) => data.questionIds.length > 0 || data.customPrompts.length > 0,
    '请至少选择一个已有问题或填写一条自定义监测问题',
  );

export type VisibilityRunCreateInput = z.input<typeof visibilityRunCreateSchema>;

const optionalGeoMarketSchema = z
  .string()
  .trim()
  .optional()
  .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined))
  .refine(
    (val): val is GeoMarket | undefined =>
      val === undefined || (GEO_MARKETS as readonly string[]).includes(val),
    '目标市场参数仅支持 CN 或 GLOBAL',
  );

export const visibilityRunV2CreateSchema = z
  .object({
    market: z.enum(GEO_MARKETS).optional(),
    productLineId: optionalVisibilityIdSchema,
    name: z
      .string()
      .trim()
      .min(1, '任务名称不能为空')
      .max(VISIBILITY_RUN_NAME_MAX, `任务名称不超过 ${VISIBILITY_RUN_NAME_MAX} 字`)
      .optional(),
    engines: z
      .array(z.enum(VISIBILITY_ENGINE_KEYS))
      .min(1, '请至少选择一个 AI 引擎')
      .max(VISIBILITY_ENGINE_KEYS.length)
      .transform((items) => [...new Set(items)]),
    prompts: z
      .array(z.string().trim().min(2, '监测问题至少 2 个字').max(300, '监测问题最多 300 字'))
      .max(100, '单次最多输入 100 个监测问题')
      .transform((items) => dedupeTrimmedStrings(items))
      .optional(),
    triggerType: z.enum(VISIBILITY_TRIGGER_TYPES).default('MANUAL'),
    retestArticleId: optionalVisibilityIdSchema,
  })
  .superRefine((data, ctx) => {
    if (!data.productLineId && (!data.prompts || data.prompts.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompts'],
        message: '请至少填写一条监测问题',
      });
    }
    if (!data.market) return;
    const disallowed = findDisallowedMarketEngines(data.engines, data.market);
    if (disallowed.length > 0) {
      const labels = disallowed.map((key) => VISIBILITY_ENGINE_LABELS[key] ?? key).join('、');
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engines'],
        message: `所选 AI 引擎不属于当前市场（${data.market}）：${labels}`,
      });
    }
  });

export type VisibilityRunV2CreateInput = z.input<typeof visibilityRunV2CreateSchema>;
export type ParsedVisibilityRunV2CreateInput = z.output<typeof visibilityRunV2CreateSchema>;

export const visibilityRunBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().trim().regex(VISIBILITY_ID_PATTERN, '监测任务编号不合法'))
    .min(1, '请至少选择一条任务记录')
    .max(100, '单次最多删除 100 条记录'),
});

export type VisibilityCitationRecord = {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  sourceKind: CitationSourceKind;
  position: number;
  createdAt: string;
};

export type VisibilityObservationRecord = {
  id: string;
  runId: string;
  profileId: string;
  brandId?: string;
  brandMarketId?: string;
  market?: GeoMarket;
  questionId: string | null;
  promptText: string;
  engine: VisibilityEngineKey | string;
  status: ItemStatusName;
  collectorKind: VisibilityCollectorKind | string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: VisibilitySentiment | null;
  brandPassage: string | null;
  topicRelevant?: boolean;
  relevanceReason?: string | null;
  competitorHits: CompetitorHit[];
  fanOutQueries: string[];
  judgeModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  checkedAt: string | null;
  createdAt: string;
  citations: VisibilityCitationRecord[];
};

export type VisibilityRunRecord = {
  id: string;
  profileId: string;
  profileName: string;
  brandId?: string;
  brandMarketId?: string;
  productLineId?: string | null;
  market?: GeoMarket;
  brandName: string;
  keywordId: string | null;
  keywordMain: string | null;
  name: string;
  engines: VisibilityEngineKey[];
  prompts?: string[];
  questionIds: string[];
  triggerType?: VisibilityTriggerType;
  retestArticleId?: string | null;
  briefsGeneratedAt?: string | null;
  totalChecks: number;
  doneCount: number;
  failCount: number;
  skipCount?: number;
  unitPrice: number;
  frozenPoints?: number;
  settledPoints?: number;
  releasedPoints?: number;
  reservationId: string | null;
  status: TaskStatusName;
  lastError: string | null;
  visibilityPct?: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type VisibilityRunListResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: VisibilityRunRecord[];
};

export type VisibilityRunDetailRecord = VisibilityRunRecord & {
  metrics: RecomputedRunMetrics;
  observations: VisibilityObservationRecord[];
};

export type VisibilityRunListQuery = {
  page: number;
  pageSize: CrudPageSize;
  profileId?: string;
  status?: TaskStatusName;
  keyword?: string;
};

export function parseVisibilityRunListQuery(raw: Record<string, unknown>): VisibilityRunListQuery {
  const rawPage = Number(raw.page ?? 1);
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1;

  const rawPageSize = Number(raw.pageSize ?? 25);
  const pageSize: CrudPageSize = (CRUD_PAGE_SIZES as readonly number[]).includes(rawPageSize)
    ? (rawPageSize as CrudPageSize)
    : 25;

  const profileId =
    typeof raw.profileId === 'string' && VISIBILITY_ID_PATTERN.test(raw.profileId.trim())
      ? raw.profileId.trim()
      : undefined;

  const status =
    typeof raw.status === 'string' && (TASK_STATUSES as readonly string[]).includes(raw.status)
      ? (raw.status as TaskStatusName)
      : undefined;

  const keyword =
    typeof raw.keyword === 'string' && raw.keyword.trim().length > 0
      ? raw.keyword.trim().slice(0, 100)
      : undefined;

  return { page, pageSize, profileId, status, keyword };
}

const isoDateString = z
  .string()
  .trim()
  .refine((val) => !Number.isNaN(new Date(val).getTime()), '时间格式不正确');

export const visibilityOverviewQuerySchema = z.object({
  profileId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(14),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
});

export type VisibilityOverviewQuery = {
  profileId?: string;
  engine?: VisibilityEngineKey;
  days: number;
  from?: string;
  to?: string;
};

export function parseVisibilityOverviewQuery(
  raw: Record<string, unknown>,
): VisibilityOverviewQuery {
  const parsed = visibilityOverviewQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 14 };
  }
  return {
    profileId: parsed.data.profileId,
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    days: parsed.data.days,
    from: parsed.data.from,
    to: parsed.data.to,
  };
}

export type VisibilityTrendPoint = {
  date: string;
  engine: VisibilityEngineKey | 'all';
  completedChecks: number;
  mentionedChecks: number;
  visibilityPct: number;
  shareOfVoicePct?: number | null;
};

export type VisibilityEngineBreakdownItem = {
  engine: VisibilityEngineKey;
  completedChecks: number;
  mentionedChecks: number;
  visibilityPct: number;
  avgPosition: number | null;
};

export type VisibilityBrandShareOfVoiceGroup = {
  brandName: string;
  completedChecks: number;
  mentionedChecks: number;
  visibilityPct: number;
  shareOfVoice: ShareOfVoiceSummary;
};

export type VisibilityRankedCitationUrlItem = {
  url: string;
  domain: string;
  title: string | null;
  sourceKind: CitationSourceKind;
  citationCount: number;
  questionCount: number;
  engines: VisibilityEngineKey[];
};

export type VisibilityOverviewResponse = {
  profileId: string | null;
  brandId?: string | null;
  brandMarketId?: string | null;
  productLineId?: string | null;
  market?: GeoMarket | null;
  metrics: RecomputedRunMetrics;
  trend: VisibilityTrendPoint[];
  byEngine?: VisibilityEngineBreakdownItem[];
  brandGroups?: VisibilityBrandShareOfVoiceGroup[];
  sourceBreakdown?: VisibilityCitationSourceBreakdown;
  topCitations?: VisibilityCitationSummaryItem[];
  topUrls?: VisibilityRankedCitationUrlItem[];
  fanOutQueries?: VisibilityFanOutItem[];
  gaps?: VisibilityOpportunityGapItem[];
};

export const visibilityCitationQuerySchema = z.object({
  profileId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  sourceKind: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isCitationSourceKind(val), '来源分类参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .default(25)
    .transform((val): CrudPageSize =>
      (CRUD_PAGE_SIZES as readonly number[]).includes(val) ? (val as CrudPageSize) : 25,
    ),
});

export type VisibilityCitationQuery = {
  profileId?: string;
  engine?: VisibilityEngineKey;
  sourceKind?: CitationSourceKind;
  days: number;
  from?: string;
  to?: string;
  page: number;
  pageSize: CrudPageSize;
};

export function parseVisibilityCitationQuery(
  raw: Record<string, unknown>,
): VisibilityCitationQuery {
  const parsed = visibilityCitationQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 30, page: 1, pageSize: 25 };
  }
  return {
    profileId: parsed.data.profileId,
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    sourceKind: parsed.data.sourceKind as CitationSourceKind | undefined,
    days: parsed.data.days,
    ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
    ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  };
}

export type VisibilityCitationSummaryItem = {
  domain: string;
  sourceKind: CitationSourceKind;
  citationCount: number;
  questionCount: number;
  topUrls: Array<{ url: string; title: string | null; count: number }>;
};

export type VisibilityCitationSourceBreakdown = Record<CitationSourceKind, number>;

export type VisibilityCitationListResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalCitations?: number;
  sourceBreakdown?: VisibilityCitationSourceBreakdown;
  items: VisibilityCitationSummaryItem[];
};

export const visibilityOpportunitiesQuerySchema = z.object({
  profileId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type VisibilityOpportunitiesQuery = {
  profileId?: string;
  engine?: VisibilityEngineKey;
  days: number;
  from?: string;
  to?: string;
  limit: number;
};

export function parseVisibilityOpportunitiesQuery(
  raw: Record<string, unknown>,
): VisibilityOpportunitiesQuery {
  const parsed = visibilityOpportunitiesQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 30, limit: 50 };
  }
  return {
    profileId: parsed.data.profileId,
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    days: parsed.data.days,
    ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
    ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    limit: parsed.data.limit,
  };
}

export type VisibilityOpportunityGapItem = {
  promptText: string;
  questionId: string | null;
  competitors: string[];
  engines: VisibilityEngineKey[];
  observationCount: number;
  latestCheckedAt?: string | null;
};

export type VisibilityFanOutItem = {
  query: string;
  frequency: number;
  sourcePrompts: string[];
  engines: VisibilityEngineKey[];
  brandMentionedPct?: number;
};

export type VisibilityOpportunitiesResponse = {
  gaps: VisibilityOpportunityGapItem[];
  fanOutQueries: VisibilityFanOutItem[];
};

export const importQuestionsInputSchema = z.object({
  profileId: optionalVisibilityIdSchema,
  keywordId: z
    .string({ required_error: '请选择目标主关键词' })
    .trim()
    .regex(VISIBILITY_ID_PATTERN, '主关键词编号不合法'),
  titles: z
    .array(z.string().trim().min(2, '标题至少 2 个字').max(200, '标题最多 200 字'))
    .min(1, '请至少勾选一条待导入标题')
    .max(200, '单次最多导入 200 条标题')
    .transform((items) => dedupeTrimmedStrings(items)),
});

export type ImportQuestionsInput = z.input<typeof importQuestionsInputSchema>;

export type ImportQuestionsResult = {
  insertedCount: number;
  skippedCount: number;
  keywordId?: string;
};

export const VISIBILITY_ENGINE_HEALTH_STATUSES = ['online', 'offline'] as const;
export type VisibilityEngineHealthStatus = (typeof VISIBILITY_ENGINE_HEALTH_STATUSES)[number];

export type VisibilityEngineAvailabilityItem = {
  key: VisibilityEngineKey;
  label: string;
  domestic: boolean;
  market?: GeoMarket;
  available: boolean;
  status: VisibilityEngineHealthStatus;
  defaultChecked?: boolean;
  unavailableReason?: string | null;
};

export type VisibilityEngineAvailabilityResponse = {
  collector: VisibilityCollectorKind;
  market?: GeoMarket;
  checkedAt: string | null;
  refreshIntervalMs: number;
  engines: VisibilityEngineAvailabilityItem[];
};

export function formatVisibilityEngineDisplayLabel(label: string, available: boolean): string {
  return available ? label : `${label}（暂未上线）`;
}

export const visibilityV2EnginesQuerySchema = z.object({
  market: optionalGeoMarketSchema,
});
export type VisibilityV2EnginesQuery = z.output<typeof visibilityV2EnginesQuerySchema>;

export const visibilityV2OverviewQuerySchema = z.object({
  market: optionalGeoMarketSchema,
  productLineId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(14),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
});

export type VisibilityV2OverviewQuery = {
  market?: GeoMarket;
  productLineId?: string;
  engine?: VisibilityEngineKey;
  days: number;
  from?: string;
  to?: string;
};

export function parseVisibilityV2OverviewQuery(
  raw: Record<string, unknown>,
): VisibilityV2OverviewQuery {
  const parsed = visibilityV2OverviewQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 14 };
  }
  return {
    ...(parsed.data.market !== undefined ? { market: parsed.data.market } : {}),
    ...(parsed.data.productLineId !== undefined
      ? { productLineId: parsed.data.productLineId }
      : {}),
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    days: parsed.data.days,
    ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
    ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
  };
}

export const visibilityV2RunListQuerySchema = z.object({
  market: optionalGeoMarketSchema,
  productLineId: optionalVisibilityIdSchema,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .default(25)
    .transform((val): CrudPageSize =>
      (CRUD_PAGE_SIZES as readonly number[]).includes(val) ? (val as CrudPageSize) : 25,
    ),
  status: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine(
      (val): val is TaskStatusName | undefined =>
        val === undefined || (TASK_STATUSES as readonly string[]).includes(val),
      '任务状态参数不合法',
    ),
  keyword: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val.slice(0, 100) : undefined)),
});

export type VisibilityV2RunListQuery = {
  market?: GeoMarket;
  productLineId?: string;
  page: number;
  pageSize: CrudPageSize;
  status?: TaskStatusName;
  keyword?: string;
};

export function parseVisibilityV2RunListQuery(
  raw: Record<string, unknown>,
): VisibilityV2RunListQuery {
  const parsed = visibilityV2RunListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { page: 1, pageSize: 25 };
  }
  return {
    ...(parsed.data.market !== undefined ? { market: parsed.data.market } : {}),
    ...(parsed.data.productLineId !== undefined
      ? { productLineId: parsed.data.productLineId }
      : {}),
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.keyword !== undefined ? { keyword: parsed.data.keyword } : {}),
  };
}

export const visibilityV2CitationQuerySchema = z.object({
  market: optionalGeoMarketSchema,
  productLineId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  sourceKind: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isCitationSourceKind(val), '来源分类参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .default(25)
    .transform((val): CrudPageSize =>
      (CRUD_PAGE_SIZES as readonly number[]).includes(val) ? (val as CrudPageSize) : 25,
    ),
});

export type VisibilityV2CitationQuery = {
  market?: GeoMarket;
  productLineId?: string;
  engine?: VisibilityEngineKey;
  sourceKind?: CitationSourceKind;
  days: number;
  from?: string;
  to?: string;
  page: number;
  pageSize: CrudPageSize;
};

export function parseVisibilityV2CitationQuery(
  raw: Record<string, unknown>,
): VisibilityV2CitationQuery {
  const parsed = visibilityV2CitationQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 30, page: 1, pageSize: 25 };
  }
  return {
    ...(parsed.data.market !== undefined ? { market: parsed.data.market } : {}),
    ...(parsed.data.productLineId !== undefined
      ? { productLineId: parsed.data.productLineId }
      : {}),
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    sourceKind: parsed.data.sourceKind as CitationSourceKind | undefined,
    days: parsed.data.days,
    ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
    ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  };
}

export const visibilityV2OpportunitiesQuerySchema = z.object({
  market: optionalGeoMarketSchema,
  productLineId: optionalVisibilityIdSchema,
  engine: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .refine((val) => val === undefined || isVisibilityEngine(val), 'AI 引擎参数不合法'),
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type VisibilityV2OpportunitiesQuery = {
  market?: GeoMarket;
  productLineId?: string;
  engine?: VisibilityEngineKey;
  days: number;
  from?: string;
  to?: string;
  limit: number;
};

export function parseVisibilityV2OpportunitiesQuery(
  raw: Record<string, unknown>,
): VisibilityV2OpportunitiesQuery {
  const parsed = visibilityV2OpportunitiesQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { days: 30, limit: 50 };
  }
  return {
    ...(parsed.data.market !== undefined ? { market: parsed.data.market } : {}),
    ...(parsed.data.productLineId !== undefined
      ? { productLineId: parsed.data.productLineId }
      : {}),
    engine: parsed.data.engine as VisibilityEngineKey | undefined,
    days: parsed.data.days,
    ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
    ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    limit: parsed.data.limit,
  };
}
