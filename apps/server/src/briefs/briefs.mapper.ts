import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  BRAND_FACT_CORE_SLOTS,
  CHANNEL_PROVIDERS,
  CN_RECOMMENDED_CHANNELS,
  ECOMMERCE_CITATION_DOMAINS,
  GEO_BRIEF_SOURCES,
  GEO_BRIEF_STATUSES,
  GEO_RECIPES,
  GEO_TARGET_FORMATS,
  NEAR_MISS_TIER_LABELS,
  containsCjk,
  defaultRecipeForBriefSource,
  defaultTargetFormatForMarket,
  geoOutlineHeadingSchema,
  isPrivateOrReservedHostLiteral,
  isSafeDistributionHttpUrl,
  matchesDomain,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  recommendBriefTargetFormat,
  recommendChannelsForMarket,
  targetFormatsForMarket,
  type BrandFactSlot,
  type ChannelProvider,
  type CitationSourceKind,
  type GeoBriefChannelRecommendation,
  type GeoBriefRecord,
  type GeoBriefSource,
  type GeoBriefStatus,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoTargetFormat,
  type NearMissTier,
} from '@geomix/shared';
import {
  NEAR_MISS_GAP_HINTS,
  NEAR_MISS_GAP_LABELS,
  type NearMissPageDiagnosis,
} from './near-miss-diagnosis';

const BRACKETED_METADATA_TAG = /\[[A-Z][A-Z0-9_-]{1,31}\]/g;

const CN_CHANNEL_FORBIDDEN_IN_GLOBAL = [
  '小红书',
  '什么值得买',
  '知乎',
  '字节头条',
  '抖音',
  '微信公众号',
  '微博',
  'b站',
  '官网',
] as const;

const CN_CHANNEL_ROMANIZED_FORBIDDEN_RE =
  /\b(?:zhihu|smzdm|xiaohongshu|bilibili|toutiao|douyin|wechat|weixin|weibo|baidu|36kr)\b/i;

export type GeoBriefRow = {
  id: string;
  brandId: string;
  brandMarketId: string;
  sourceType: string;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  targetPrompt: string;
  priorityScore: number;
  diagnosisSummary: string;
  recommendedRecipe: string;
  targetFormat: string;
  suggestedTitle: string;
  outlineH2: Prisma.JsonValue;
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: Prisma.JsonValue;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

export type ParsedCompetitorHit = {
  name: string;
  mentioned: boolean;
  position: number | null;
};

export type BriefSignalCitation = {
  url: string;
  domain: string;
  title: string | null;
  sourceKind: CitationSourceKind;
  position?: number;
};

export type BriefSignalObservation = {
  id: string;
  runId: string;
  promptText: string;
  engine: string;
  answerText: string | null;
  brandMentioned: boolean | null;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: Prisma.JsonValue;
  fanOutQueries: string[];
  citations: BriefSignalCitation[];
};

export type BriefMatchedFact = {
  factId: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
};

export type BriefSynthesisContext = {
  market: GeoMarket;
  brandName: string;
  localBrandName: string;
  category: string;
  sourceType: GeoBriefSource;
  priorityScore: number;
  targetPrompt: string;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  sourceCitationTitle?: string | null;
  sourceArticleHeadings?: readonly string[];
  sourceArticleExcerpt?: string | null;
  usedPastedFallback?: boolean;
  competitorFocus: string[];
  targetFanOuts: string[];
  observations: readonly BriefSignalObservation[];
  citations: readonly BriefSignalCitation[];
  ownedDomains?: readonly string[];
  matchedFacts: readonly BriefMatchedFact[];
  presentFactSlots: ReadonlySet<BrandFactSlot>;
  nearMiss?: {
    tier: NearMissTier;
    diagnosis?: NearMissPageDiagnosis;
  };
};

export type BriefDraft = {
  diagnosisSummary: string;
  recommendedRecipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  suggestedTitle: string;
  outlineH2: GeoOutlineHeading[];
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: GeoBriefChannelRecommendation[];
};

export function cleanPromptForDisplay(raw: string): string {
  return raw.replace(BRACKETED_METADATA_TAG, ' ').replace(/\s+/g, ' ').trim();
}

export function dedupeTrimmed(values: readonly string[], maxItems = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseObservationCompetitorHits(raw: Prisma.JsonValue): ParsedCompetitorHit[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedCompetitorHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const mentioned = rec.mentioned === true;
    const position =
      typeof rec.position === 'number' && Number.isFinite(rec.position) ? rec.position : null;
    out.push({ name, mentioned, position });
  }
  return out;
}

export function parseStoredOutlineH2(raw: Prisma.JsonValue): GeoOutlineHeading[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoOutlineHeading[] = [];
  for (const entry of raw) {
    const parsed = geoOutlineHeadingSchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);

const GLOBAL_EXCLUDED_CN_DOMAINS = [
  'zhihu.com',
  'smzdm.com',
  'xiaohongshu.com',
  'xhslink.com',
  'toutiao.com',
  'douyin.com',
  'mp.weixin.qq.com',
  'weixin.qq.com',
  'weibo.com',
  'weibo.cn',
  'bilibili.com',
  'b23.tv',
  'tieba.baidu.com',
  'baike.baidu.com',
  'baidu.com',
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
  '36kr.com',
  'huxiu.com',
  'tmtpost.com',
  'ifanr.com',
  'infoq.cn',
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
  '163.com',
  'qq.com',
  'sohu.com',
  'sina.com.cn',
  'jd.com',
  'tmall.com',
  'taobao.com',
  'pinduoduo.com',
  'yangkeduo.com',
  'suning.com',
  'vip.com',
  '1688.com',
  'xinhuanet.com',
  'caixin.com',
  'cctv.com',
] as const;

const CN_OTHER_UGC_DOMAINS = [
  'bilibili.com',
  'b23.tv',
  'weibo.com',
  'weibo.cn',
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
] as const;

const GLOBAL_SOCIAL_THREAD_DOMAINS = [
  'linkedin.com',
  'x.com',
  'twitter.com',
  'threads.net',
  'bsky.app',
] as const;

const GLOBAL_REVIEW_PLATFORM_DOMAINS = [
  'trustpilot.com',
  'g2.com',
  'capterra.com',
  'producthunt.com',
  'trustradius.com',
  'getapp.com',
] as const;

function isCnOnlyDomain(domain: string): boolean {
  if (domain.endsWith('.cn')) return true;
  return GLOBAL_EXCLUDED_CN_DOMAINS.some((cnDomain) => matchesDomain(domain, cnDomain));
}

function isEcommerceDomain(domain: string): boolean {
  return ECOMMERCE_CITATION_DOMAINS.some((ecDomain) => matchesDomain(domain, ecDomain));
}

const MAX_CITATION_HOST_LENGTH = 255;
const MAX_CITATION_URL_LENGTH = 2048;

function stripTrailingChar(value: string, ch: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ch) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function isOwnedDomain(domain: string, ownedDomains: readonly string[]): boolean {
  return ownedDomains.some((owned) => matchesDomain(domain, owned));
}

function safeNormalizeCitationDomain(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CITATION_URL_LENGTH) return '';
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return '';

  let candidateUrl: string;
  if (/^https?:/i.test(trimmed)) {
    candidateUrl = trimmed;
  } else if (trimmed.startsWith('//')) {
    candidateUrl = `https:${trimmed}`;
  } else {
    if (trimmed.includes('://')) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const colonIdx = trimmed.indexOf(':');
      const afterColon = trimmed.slice(colonIdx + 1);
      const portPart = afterColon.split(/[/?#\\]/)[0] ?? '';
      if (!/^\d+$/.test(portPart)) {
        return '';
      }
    }

    let delimIdx = trimmed.length;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === '/' || ch === '\\' || ch === '?' || ch === '#') {
        delimIdx = i;
        break;
      }
    }
    const authority = trimmed.slice(0, delimIdx);
    const rest = trimmed.slice(delimIdx);
    if (!authority.includes('@') && !authority.startsWith('[')) {
      const colonIdx = authority.indexOf(':');
      const hostPart = colonIdx >= 0 ? authority.slice(0, colonIdx) : authority;
      const portAndRest = (colonIdx >= 0 ? authority.slice(colonIdx) : '') + rest;
      const normalizedHost = stripTrailingChar(hostPart, '.');
      if (
        !normalizedHost ||
        normalizedHost.length > MAX_CITATION_HOST_LENGTH ||
        normalizedHost.startsWith('.') ||
        normalizedHost.includes('..')
      ) {
        return '';
      }
      candidateUrl = `https://${normalizedHost}${portAndRest}`;
    } else {
      candidateUrl = `https://${trimmed}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

  const hostname = parsed.hostname;
  if (!hostname || hostname.length > MAX_CITATION_HOST_LENGTH || hostname.startsWith('[')) {
    return '';
  }
  const strippedHost = stripTrailingChar(hostname, '.');
  if (
    !strippedHost ||
    strippedHost.length > MAX_CITATION_HOST_LENGTH ||
    strippedHost.startsWith('.') ||
    strippedHost.includes('..')
  ) {
    return '';
  }

  return normalizeVisibilityDomain(strippedHost);
}

function isSafePublicCitationHost(hostname: string): boolean {
  const trimmed = hostname.trim();
  if (!trimmed || trimmed.length > MAX_CITATION_HOST_LENGTH) return false;
  const unbracketed = trimmed.toLowerCase().replace(/^\[|\]$/g, '');
  const normalized = stripTrailingChar(unbracketed, '.');
  if (
    !normalized ||
    normalized.length > MAX_CITATION_HOST_LENGTH ||
    normalized.startsWith('.') ||
    normalized.includes('..')
  ) {
    return false;
  }
  if (isPrivateOrReservedHostLiteral(normalized)) return false;
  if (!normalized.includes('.')) return false;
  return true;
}

function isSafePublicCitationUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_CITATION_URL_LENGTH || trimmed.includes('\\')) {
    return false;
  }
  if (!isSafeDistributionHttpUrl(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return isSafePublicCitationHost(parsed.hostname);
  } catch {
    return false;
  }
}

function hasPrivateOrInternalUrlHost(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_CITATION_URL_LENGTH) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !isSafePublicCitationHost(parsed.hostname);
  } catch {
    return false;
  }
}

function canonicalizeCitationUrlKey(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_CITATION_URL_LENGTH) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const keepParams = new URLSearchParams();
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!/^utm_/i.test(k) && k.toLowerCase() !== 'fbclid' && k.toLowerCase() !== 'gclid') {
        keepParams.append(k, v);
      }
    }
    keepParams.sort();
    const qs = keepParams.toString();
    const hostname = stripTrailingChar(parsed.hostname.toLowerCase(), '.').replace(/^www\./, '');
    const pathname = stripTrailingChar(parsed.pathname, '/') || '/';
    return `${parsed.protocol}//${hostname}${pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function inferProviderHintForChannel(channel: string, market: GeoMarket): ChannelProvider {
  const lower = channel.trim().toLowerCase();
  if (lower.includes('reddit')) return 'REDDIT_ASSIST';
  if (lower.includes('quora')) return 'QUORA_ASSIST';
  if (
    lower.includes('linkedin') ||
    lower.includes('twitter') ||
    lower.includes('/ x') ||
    lower.includes('x /') ||
    lower.includes('social thread')
  ) {
    return 'SOCIAL_THREAD_ASSIST';
  }
  if (
    lower.includes('trustpilot') ||
    lower.includes('g2') ||
    lower.includes('review media') ||
    lower.includes('pr') ||
    lower.includes('kol') ||
    lower.includes('评测媒体') ||
    lower.includes('行业媒体')
  ) {
    return 'PR_PACKET';
  }
  if (
    lower.includes('blog') ||
    lower.includes('docs') ||
    lower.includes('官网') ||
    lower.includes('独立站')
  ) {
    return 'WORDPRESS';
  }
  if (
    lower.includes('知乎') ||
    lower.includes('什么值得买') ||
    lower.includes('小红书') ||
    lower.includes('字节头条') ||
    lower.includes('抖音') ||
    lower.includes('微信') ||
    lower.includes('中文社区')
  ) {
    return 'CN_COMMUNITY_ASSIST';
  }
  return market === 'GLOBAL' ? 'WORDPRESS' : 'CN_COMMUNITY_ASSIST';
}

type CitationChannelBucket = {
  channel: string;
  providerHint: ChannelProvider;
  kind: 'community' | 'social' | 'review' | 'media' | 'competitor';
  citationCount: number;
  bestPosition: number;
  containsSourceCitationUrl: boolean;
  domains: Set<string>;
  urlMap: Map<
    string,
    {
      url: string;
      count: number;
      bestPosition: number;
      isAuthority: number;
    }
  >;
};

function classifyCitationDomainToChannel(
  domain: string,
  sourceKind: CitationSourceKind,
  market: GeoMarket,
): { channel: string; providerHint: ChannelProvider; kind: CitationChannelBucket['kind'] } | null {
  if (market === 'GLOBAL') {
    if (isCnOnlyDomain(domain)) return null;
    if (matchesDomain(domain, 'reddit.com')) {
      return { channel: 'Reddit', providerHint: 'REDDIT_ASSIST', kind: 'community' };
    }
    if (matchesDomain(domain, 'quora.com')) {
      return { channel: 'Quora', providerHint: 'QUORA_ASSIST', kind: 'community' };
    }
    if (GLOBAL_SOCIAL_THREAD_DOMAINS.some((d) => matchesDomain(domain, d))) {
      return { channel: 'LinkedIn / X', providerHint: 'SOCIAL_THREAD_ASSIST', kind: 'social' };
    }
    if (GLOBAL_REVIEW_PLATFORM_DOMAINS.some((d) => matchesDomain(domain, d))) {
      return { channel: 'Trustpilot/G2', providerHint: 'PR_PACKET', kind: 'review' };
    }
    if (sourceKind === 'COMPETITOR') {
      return {
        channel: 'Independent Blog/Docs (llms.txt + JSON-LD)',
        providerHint: 'WORDPRESS',
        kind: 'competitor',
      };
    }
    return { channel: 'Independent Review Media', providerHint: 'PR_PACKET', kind: 'media' };
  }

  // CN market
  if (matchesDomain(domain, 'zhihu.com')) {
    return { channel: '知乎', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'smzdm.com')) {
    return { channel: '什么值得买', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'xiaohongshu.com') || matchesDomain(domain, 'xhslink.com')) {
    return { channel: '小红书', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'toutiao.com') || matchesDomain(domain, 'douyin.com')) {
    return { channel: '字节头条/抖音图文', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'mp.weixin.qq.com') || matchesDomain(domain, 'weixin.qq.com')) {
    return { channel: '微信公众号', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'reddit.com')) {
    return { channel: 'Reddit', providerHint: 'REDDIT_ASSIST', kind: 'community' };
  }
  if (matchesDomain(domain, 'quora.com')) {
    return { channel: 'Quora', providerHint: 'QUORA_ASSIST', kind: 'community' };
  }
  if (GLOBAL_SOCIAL_THREAD_DOMAINS.some((d) => matchesDomain(domain, d))) {
    return { channel: 'LinkedIn / X', providerHint: 'SOCIAL_THREAD_ASSIST', kind: 'social' };
  }
  if (CN_OTHER_UGC_DOMAINS.some((d) => matchesDomain(domain, d))) {
    return { channel: '中文社区问答', providerHint: 'CN_COMMUNITY_ASSIST', kind: 'community' };
  }
  if (sourceKind === 'COMPETITOR') {
    return { channel: '官网', providerHint: 'WORDPRESS', kind: 'competitor' };
  }
  return { channel: '第三方评测媒体', providerHint: 'PR_PACKET', kind: 'media' };
}

function buildEvidenceBackedChannelReason(
  bucket: CitationChannelBucket,
  market: GeoMarket,
): string {
  const domainsSample = [...bucket.domains].slice(0, 3).join(', ');
  const count = bucket.citationCount;
  if (market === 'GLOBAL') {
    if (bucket.kind === 'competitor') {
      return `AI engines cited competitor domains ${count} ${count === 1 ? 'time' : 'times'} (${domainsSample}) for this prompt; publish a structured, JSON-LD backed comparison guide on your owned blog/docs.`;
    }
    if (bucket.kind === 'media' || bucket.kind === 'review') {
      return `AI engines cited ${bucket.channel} ${count} ${count === 1 ? 'time' : 'times'} (${domainsSample}) for this prompt; share a verified PR/KOL fact packet to earn objective editorial coverage.`;
    }
    return `AI engines cited ${bucket.channel} ${count} ${count === 1 ? 'time' : 'times'} (${domainsSample}) for this prompt; prioritize compliant, non-promotional participation targeting these cited discussions.`;
  }

  if (bucket.kind === 'competitor') {
    return `该问句下 AI 引擎共引用 ${count} 次竞品官网内容（${domainsSample}），建议优先在自有官网发布带结构化参数表与 JSON-LD 的深度对照页进行反制。`;
  }
  if (bucket.kind === 'media') {
    return `该问句下 AI 引擎共引用 ${count} 次第三方评测媒体（${domainsSample}），建议输出标准媒体/KOL 事实协作包切入高权重评测信源。`;
  }
  return `该问句下 AI 引擎共引用 ${count} 次 ${bucket.channel} 相关讨论/内容（${domainsSample}），建议优先产出合规实测内容切入高引用信源。`;
}

function aggregateCitationDrivenChannels(
  ctx: BriefSynthesisContext,
): GeoBriefChannelRecommendation[] {
  const normalizedOwnedDomains = (ctx.ownedDomains ?? [])
    .map((d) => safeNormalizeCitationDomain(d))
    .filter((d): d is string => Boolean(d));
  const sourceCitationKey =
    ctx.sourceCitationUrl && isSafePublicCitationUrl(ctx.sourceCitationUrl)
      ? canonicalizeCitationUrlKey(ctx.sourceCitationUrl)
      : null;

  const buckets = new Map<string, CitationChannelBucket>();

  for (const cite of ctx.citations) {
    if (cite.sourceKind === 'OWNED' || cite.sourceKind === 'ECOMMERCE') {
      continue;
    }
    const rawUrl = cite.url.trim();
    if (rawUrl && /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) && !/^https?:/i.test(rawUrl)) {
      continue;
    }
    if (rawUrl && hasPrivateOrInternalUrlHost(rawUrl)) {
      continue;
    }
    const urlDomain = rawUrl ? safeNormalizeCitationDomain(rawUrl) : '';
    if (urlDomain) {
      if (
        !isSafePublicCitationHost(urlDomain) ||
        isEcommerceDomain(urlDomain) ||
        (ctx.market === 'GLOBAL' && isCnOnlyDomain(urlDomain)) ||
        isOwnedDomain(urlDomain, normalizedOwnedDomains)
      ) {
        continue;
      }
    }
    const domain = safeNormalizeCitationDomain(cite.domain) || urlDomain;
    if (!domain || !isSafePublicCitationHost(domain)) continue;
    if (isEcommerceDomain(domain)) {
      continue;
    }
    if (isOwnedDomain(domain, normalizedOwnedDomains)) {
      continue;
    }

    const mapped = classifyCitationDomainToChannel(domain, cite.sourceKind, ctx.market);
    if (!mapped) continue;

    const bucketKey = mapped.channel.toLowerCase();
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        channel: mapped.channel,
        providerHint: mapped.providerHint,
        kind: mapped.kind,
        citationCount: 0,
        bestPosition: Number.POSITIVE_INFINITY,
        containsSourceCitationUrl: false,
        domains: new Set<string>(),
        urlMap: new Map(),
      };
      buckets.set(bucketKey, bucket);
    }

    const pos =
      typeof cite.position === 'number' && Number.isFinite(cite.position) && cite.position > 0
        ? cite.position
        : 999;
    bucket.citationCount += 1;
    if (pos < bucket.bestPosition) {
      bucket.bestPosition = pos;
    }
    bucket.domains.add(domain);

    if (urlDomain && isSafePublicCitationUrl(rawUrl)) {
      const urlKey = canonicalizeCitationUrlKey(rawUrl);
      if (urlKey) {
        if (sourceCitationKey && urlKey === sourceCitationKey) {
          bucket.containsSourceCitationUrl = true;
        }
        const existingUrl = bucket.urlMap.get(urlKey);
        const isAuthority = cite.sourceKind === 'AUTHORITY' ? 1 : 0;
        if (existingUrl) {
          existingUrl.count += 1;
          if (pos < existingUrl.bestPosition) {
            existingUrl.bestPosition = pos;
          }
          if (isAuthority > existingUrl.isAuthority) {
            existingUrl.isAuthority = isAuthority;
          }
        } else {
          bucket.urlMap.set(urlKey, {
            url: rawUrl,
            count: 1,
            bestPosition: pos,
            isAuthority,
          });
        }
      }
    }
  }

  if (buckets.size === 0) {
    return [];
  }

  const rankedBuckets = [...buckets.values()].sort((a, b) => {
    const aHigh = a.citationCount >= 2 || a.containsSourceCitationUrl ? 1 : 0;
    const bHigh = b.citationCount >= 2 || b.containsSourceCitationUrl ? 1 : 0;
    return (
      b.citationCount - a.citationCount ||
      bHigh - aHigh ||
      a.bestPosition - b.bestPosition ||
      a.channel.localeCompare(b.channel)
    );
  });

  const result: GeoBriefChannelRecommendation[] = [];
  const seenChannels = new Set<string>();

  for (const bucket of rankedBuckets.slice(0, 3)) {
    const key = bucket.channel.toLowerCase();
    if (seenChannels.has(key)) continue;
    seenChannels.add(key);

    const priority: 'HIGH' | 'MEDIUM' =
      bucket.citationCount >= 2 || bucket.containsSourceCitationUrl ? 'HIGH' : 'MEDIUM';

    const topUrls = [...bucket.urlMap.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.bestPosition - b.bestPosition ||
          b.isAuthority - a.isAuthority ||
          a.url.localeCompare(b.url),
      )
      .slice(0, 3)
      .map((u) => u.url);

    result.push({
      channel: bucket.channel,
      reason: buildEvidenceBackedChannelReason(bucket, ctx.market).slice(0, 300),
      providerHint: bucket.providerHint,
      priority,
      ...(topUrls.length > 0 ? { citedExampleUrls: topUrls } : {}),
    });
  }

  // 补充自有站点锚点渠道（若尚未包含且总数 < 4），确保商家始终拥有 L1 自有阵地承接选项
  const ownedChannelName =
    ctx.market === 'GLOBAL' ? 'Independent Blog/Docs (llms.txt + JSON-LD)' : '官网';
  if (!seenChannels.has(ownedChannelName.toLowerCase()) && result.length < 4) {
    seenChannels.add(ownedChannelName.toLowerCase());
    result.push({
      channel: ownedChannelName,
      reason:
        ctx.market === 'GLOBAL'
          ? 'Publish a canonical structured guide with JSON-LD and llms.txt on your owned site to anchor brand truth for AI crawlers.'
          : '在自有官网同步发布含结构化参数表与 FAQ 的权威长文，沉淀长期可控的 AI 抓取主阵地。',
      providerHint: 'WORDPRESS',
      priority: 'MEDIUM',
    });
  }

  return result;
}

export function buildCitationDrivenRecommendedChannels(
  ctx: BriefSynthesisContext,
): GeoBriefChannelRecommendation[] {
  const citationBacked = aggregateCitationDrivenChannels(ctx);
  if (citationBacked.length > 0) {
    return citationBacked;
  }

  const citationCounts = summarizeCitationKinds(ctx.citations);
  const fallback = recommendChannelsForMarket(ctx.market, {
    sourceType: ctx.sourceType,
    socialCitations: citationCounts.SOCIAL,
    authorityCitations: citationCounts.AUTHORITY,
    competitorCitations: citationCounts.COMPETITOR,
    ecommerceCitations: citationCounts.ECOMMERCE,
    citationsEmpty: ctx.citations.length === 0,
  });

  const seen = new Set<string>();
  const enriched: GeoBriefChannelRecommendation[] = [];
  for (let idx = 0; idx < fallback.length; idx += 1) {
    const item = fallback[idx]!;
    const key = item.channel.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    enriched.push({
      channel: item.channel,
      reason: item.reason,
      providerHint: item.providerHint ?? inferProviderHintForChannel(item.channel, ctx.market),
      priority: item.priority ?? (idx === 0 ? 'HIGH' : 'MEDIUM'),
    });
  }
  return enriched;
}

export function parseStoredChannels(raw: Prisma.JsonValue): GeoBriefChannelRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoBriefChannelRecommendation[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const rawChannel = typeof rec.channel === 'string' ? rec.channel : '';
    const rawReason = typeof rec.reason === 'string' ? rec.reason : '';
    const channel = rawChannel.trim().slice(0, 80).trim();
    const reason = rawReason.trim().slice(0, 300).trim();
    if (!channel || !reason) continue;
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const item: GeoBriefChannelRecommendation = {
      channel,
      reason,
    };
    if (typeof rec.providerHint === 'string' && CHANNEL_PROVIDER_SET.has(rec.providerHint)) {
      item.providerHint = rec.providerHint as ChannelProvider;
    }
    if (rec.priority === 'HIGH' || rec.priority === 'MEDIUM') {
      item.priority = rec.priority;
    }
    if (Array.isArray(rec.citedExampleUrls)) {
      const urlSet = new Set<string>();
      const urls: string[] = [];
      for (const rawUrl of rec.citedExampleUrls) {
        if (typeof rawUrl !== 'string') continue;
        const cleaned = rawUrl.trim();
        if (!cleaned || !isSafePublicCitationUrl(cleaned)) continue;
        const urlKey = canonicalizeCitationUrlKey(cleaned);
        if (!urlKey || urlSet.has(urlKey)) continue;
        urlSet.add(urlKey);
        urls.push(cleaned);
        if (urls.length >= 3) break;
      }
      if (urls.length > 0) {
        item.citedExampleUrls = urls;
      }
    }
    out.push(item);
  }
  return out;
}

function toMarket(raw?: string | null): GeoMarket {
  return raw === 'GLOBAL' ? 'GLOBAL' : 'CN';
}

function toBriefSource(raw: string): GeoBriefSource {
  return (GEO_BRIEF_SOURCES as readonly string[]).includes(raw)
    ? (raw as GeoBriefSource)
    : 'MANUAL';
}

function toBriefStatus(raw: string): GeoBriefStatus {
  return (GEO_BRIEF_STATUSES as readonly string[]).includes(raw) ? (raw as GeoBriefStatus) : 'OPEN';
}

function toRecipe(raw: string): GeoRecipe {
  return (GEO_RECIPES as readonly string[]).includes(raw) ? (raw as GeoRecipe) : 'AUTHORITY_GUIDE';
}

function toTargetFormat(raw: string, market: GeoMarket): GeoTargetFormat {
  if (
    (GEO_TARGET_FORMATS as readonly string[]).includes(raw) &&
    targetFormatsForMarket(market).includes(raw as GeoTargetFormat)
  ) {
    return raw as GeoTargetFormat;
  }
  return defaultTargetFormatForMarket(market);
}

export function presentBrief(row: GeoBriefRow, fallbackMarket?: GeoMarket): GeoBriefRecord {
  const market = toMarket(row.brandMarket?.market ?? fallbackMarket ?? 'CN');
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    sourceType: toBriefSource(row.sourceType),
    sourceRunId: row.sourceRunId ?? null,
    sourceObservationIds: row.sourceObservationIds ?? [],
    sourceCitationUrl: row.sourceCitationUrl ?? null,
    targetPrompt: row.targetPrompt,
    priorityScore: row.priorityScore,
    diagnosisSummary: row.diagnosisSummary,
    recommendedRecipe: toRecipe(row.recommendedRecipe),
    targetFormat: toTargetFormat(row.targetFormat, market),
    suggestedTitle: row.suggestedTitle,
    outlineH2: parseStoredOutlineH2(row.outlineH2),
    targetFanOuts: row.targetFanOuts ?? [],
    competitorFocus: row.competitorFocus ?? [],
    matchedFactIds: row.matchedFactIds ?? [],
    missingFactHints: row.missingFactHints ?? [],
    recommendedChannels: parseStoredChannels(row.recommendedChannels),
    status: toBriefStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function summarizeCitationKinds(citations: readonly BriefSignalCitation[]) {
  const counts: Record<CitationSourceKind, number> = {
    OWNED: 0,
    COMPETITOR: 0,
    SOCIAL: 0,
    AUTHORITY: 0,
    ECOMMERCE: 0,
    OTHER: 0,
  };
  for (const cite of citations) {
    counts[cite.sourceKind] = (counts[cite.sourceKind] ?? 0) + 1;
  }
  return counts;
}

export function buildMissingFactHints(
  presentSlots: ReadonlySet<BrandFactSlot>,
  sourceType: GeoBriefSource,
  category: string,
  nearMissDiagnosis?: NearMissPageDiagnosis,
): string[] {
  const hints: string[] = [];

  if (sourceType === 'NEAR_MISS_BOOST' && nearMissDiagnosis) {
    for (const gap of nearMissDiagnosis.missingGaps) {
      hints.push(NEAR_MISS_GAP_HINTS[gap]);
    }
    if (
      nearMissDiagnosis.fetchStatus === 'FETCH_FALLBACK' &&
      nearMissDiagnosis.fetchFallbackReason
    ) {
      hints.push(
        `目标页抓取受限（${nearMissDiagnosis.fetchFallbackReason}），请人工核对首段与对比表结构后补齐`,
      );
    }
  }

  const slotHintMap: Record<BrandFactSlot, string> = {
    PRODUCT_SPECS: `建议补充「核心产品与参数」实测数值（如${category}关键性能指标、功耗/噪音/响应时延与版本规格），可显著提升 AI 引用率`,
    DIFFERENTIATORS: '建议补充「差异化卖点」与竞品的客观对比边界及适用人群，避免回答沦为泛泛描述',
    CREDENTIALS:
      '建议补充「权威资质与背书」（认证编号、专利、权威媒体评测或行业奖项），增强可信度锚点',
    CASE_STUDIES: '建议补充「真实客户案例」与可量化落地效果数据，支撑场景化推荐结论',
    EXTRA_DOC: '可按需补充白皮书或长文档资料用于深度问答',
  };

  for (const slot of BRAND_FACT_CORE_SLOTS) {
    if (!presentSlots.has(slot)) {
      hints.push(slotHintMap[slot]);
    }
  }

  if (sourceType === 'SENTIMENT_RISK') {
    hints.push('建议补充针对高频争议点的实测复核数据、固件/版本改进记录及售后保障条款');
  } else if (sourceType === 'LOW_RANK') {
    hints.push('建议补充与头部竞品同工况下的横向实测参数表（价格带、核心规格、长期成本）');
  } else if (sourceType === 'CITATION_COUNTER') {
    hints.push('建议补充超越目标高引用页的新增维度实测结论与最新 2026 版本信息');
  } else if (sourceType === 'NEAR_MISS_BOOST' && hints.length === 0) {
    hints.push('建议补充 2026 最新批次量化实测对比数据与结构化 FAQPage JSON-LD，促成 AI 最终引用');
  }

  if (hints.length === 0) {
    hints.push(`建议补充 2026 最新批次${category}第三方实测数据与对比样张，进一步拉开事实密度优势`);
  }

  return dedupeTrimmed(hints, sourceType === 'NEAR_MISS_BOOST' ? 6 : 3);
}

function buildChineseDiagnosisSummary(
  ctx: BriefSynthesisContext,
  citationCounts: Record<CitationSourceKind, number>,
): string {
  const displayPrompt =
    cleanPromptForDisplay(ctx.targetPrompt).slice(0, 72) ||
    `${ctx.localBrandName || ctx.brandName}${ctx.category}`;
  const engines = dedupeTrimmed(
    ctx.observations.map((o) => o.engine),
    5,
  );
  const engineLabel =
    engines.length > 0
      ? engines.join('、')
      : ctx.market === 'GLOBAL'
        ? '海外主流 AI 引擎'
        : '国内主流 AI 引擎';
  const compLabel =
    ctx.competitorFocus.length > 0 ? ctx.competitorFocus.slice(0, 3).join('、') : '头部竞品';
  const totalCitations = ctx.citations.length;
  const citationNote =
    totalCitations === 0
      ? '本次引擎未返回外部引用链接，已基于回答正文、竞品露出差距与品牌事实卡生成可执行写作方案。'
      : citationCounts.OWNED === 0
        ? `当前共监测到 ${totalCitations} 条引用且自有官网引用为 0，AI 主要采信竞品页与第三方评测/社区信源。`
        : `当前共监测到 ${totalCitations} 条引用（含自有阵地 ${citationCounts.OWNED} 条），需进一步提升高权重评测与问答覆盖。`;

  switch (ctx.sourceType) {
    case 'AUTO_GAP':
      return `在「${displayPrompt}」问题下，${engineLabel}未提及 ${ctx.localBrandName}，而 ${compLabel} 占据了主要推荐席位。${citationNote}`;
    case 'SENTIMENT_RISK':
      return `在「${displayPrompt}」问答中，${engineLabel}对 ${ctx.localBrandName} 出现负面或褒贬参半评价，需立即用可核验实测事实澄清痛点。${citationNote}`;
    case 'LOW_RANK': {
      const positions = ctx.observations
        .map((o) => o.brandPosition)
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
      const avgPos =
        positions.length > 0
          ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1)
          : '3+';
      return `在「${displayPrompt}」问题中，${ctx.localBrandName} 虽获提及但平均顺位仅排 #${avgPos}，落后于 ${compLabel} 的参数与场景背书。${citationNote}`;
    }
    case 'CITATION_COUNTER': {
      const citeHint = ctx.sourceCitationUrl
        ? `高引用来源（${safeHostFromUrl(ctx.sourceCitationUrl)}）`
        : '第三方高引用评测页';
      const sourceNote = ctx.usedPastedFallback ? '已基于粘贴参考正文' : '已解析目标页';
      const headingNote =
        ctx.sourceArticleHeadings && ctx.sourceArticleHeadings.length > 0
          ? `${sourceNote}提炼 ${ctx.sourceArticleHeadings.length} 个核心议题骨架，并匹配 ${ctx.matchedFacts.length} 项品牌真实事实卡用于超越式重写。`
          : ctx.matchedFacts.length > 0
            ? `${sourceNote}核心议题并匹配 ${ctx.matchedFacts.length} 项品牌事实卡用于结构化反制。`
            : '';
      return `${citeHint}在「${displayPrompt}」场景下被 AI 反复引用，我方自有阵地缺少可替代的结构化深度对照内容。${headingNote}${citationNote}`;
    }
    case 'FANOUT_CLUSTER': {
      const fanLabel = ctx.targetFanOuts.slice(0, 3).join('、') || displayPrompt;
      return `监测发现 AI 在回答时高频拆解「${fanLabel}」等长尾子词，当前缺少聚合覆盖这些细分意图的专题权威稿。${citationNote}`;
    }
    case 'NEAR_MISS_BOOST': {
      const tierLabel = ctx.nearMiss ? NEAR_MISS_TIER_LABELS[ctx.nearMiss.tier] : '差一步被引用';
      const targetHint = ctx.sourceCitationUrl
        ? `目标页面（${safeHostFromUrl(ctx.sourceCitationUrl)}）`
        : '候选相关内容';
      const diagnosis = ctx.nearMiss?.diagnosis;
      if (diagnosis?.fetched) {
        const factNote =
          diagnosis.totalFactCount > 0
            ? `品牌事实覆盖 ${diagnosis.coveredFactCount}/${diagnosis.totalFactCount} 项。`
            : '当前尚未配置品牌事实卡。';
        if (diagnosis.missingGaps.length > 0) {
          const gapLabels = diagnosis.missingGaps.map((g) => NEAR_MISS_GAP_LABELS[g]).join('、');
          return `在「${displayPrompt}」问题下触发「${tierLabel}」信号，已抓取 ${targetHint} 并检出 ${diagnosis.missingGaps.length} 项结构缺口：${gapLabels}。${factNote}${citationNote}`;
        }
        return `在「${displayPrompt}」问题下触发「${tierLabel}」信号，已抓取 ${targetHint} 且基础结构较完整，建议聚焦深化实测对比维度与品牌事实密度以促成 AI 最终引用。${factNote}${citationNote}`;
      }
      if (diagnosis?.fetchStatus === 'FETCH_FALLBACK') {
        return `在「${displayPrompt}」问题下触发「${tierLabel}」信号，${targetHint}受抓取限制或超时未能直连解析（${diagnosis.fetchFallbackReason ?? '远端暂不可达'}），已结合 Near-Miss 信号与品牌事实卡生成补强方案。${citationNote}`;
      }
      return `在「${displayPrompt}」问题下触发「${tierLabel}」信号，${engineLabel}已检索或提及相关线索但尚未稳定引用自有阵地，需围绕首段直答、量化对比表、FAQ/JSON-LD 与品牌事实密度完成临门一脚补强。${citationNote}`;
    }
    case 'MANUAL':
    default:
      return `围绕「${displayPrompt}」定向策划 ${ctx.localBrandName}（${ctx.category}）GEO 权威内容，强化首段直答与品牌事实密度。${citationNote}`;
  }
}

function safeHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 48);
  }
}

function extractEnglishTopic(ctx: BriefSynthesisContext): string {
  const cleaned = cleanPromptForDisplay(ctx.targetPrompt);
  const asciiMatches = cleaned.match(/[A-Za-z0-9][A-Za-z0-9\s\-+/.&]{3,}/g);
  if (asciiMatches && asciiMatches.length > 0) {
    const joined = asciiMatches.join(' ').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{4,}/.test(joined)) {
      return joined.slice(0, 64);
    }
  }
  const brandAscii = /[A-Za-z]{2,}/.test(ctx.localBrandName)
    ? ctx.localBrandName
    : /[A-Za-z]{2,}/.test(ctx.brandName)
      ? ctx.brandName
      : 'Brand';
  const catAscii = /[A-Za-z]{3,}/.test(ctx.category) ? ctx.category : 'Solutions';
  return `${brandAscii} ${catAscii}`.trim().slice(0, 64);
}

function stripEnglishTitleLeadingTokens(
  topic: string,
  options: { stripYear?: boolean; stripSuperlative?: boolean },
): string {
  let normalized = topic.trim();
  let prev: string;
  do {
    prev = normalized;
    if (options.stripYear) {
      normalized = normalized.replace(/^2026\b[\s:-]*/i, '').trim();
    }
    if (options.stripSuperlative) {
      normalized = normalized.replace(/^(?:best|top)\b[\s:-]*/i, '').trim();
    }
  } while (normalized !== prev);
  if (options.stripYear) {
    normalized = normalized.replace(/(?:\s+in)?\s+2026$/i, '').trim();
  }
  return normalized;
}

function buildEnglishTitle(ctx: BriefSynthesisContext, recipe: GeoRecipe): string {
  const topic = extractEnglishTopic(ctx);
  const brand = /[A-Za-z]{2,}/.test(ctx.localBrandName) ? ctx.localBrandName : ctx.brandName;
  const fallbackTopic = `${brand} ${/[A-Za-z]{3,}/.test(ctx.category) ? ctx.category : 'Solutions'}`;
  const topicNoYear = stripEnglishTitleLeadingTokens(topic, { stripYear: true }) || fallbackTopic;
  const topicNoYearOrSuperlative =
    stripEnglishTitleLeadingTokens(topic, { stripYear: true, stripSuperlative: true }) ||
    fallbackTopic;
  const comp = ctx.competitorFocus.find((c) => /[A-Za-z]{2,}/.test(c)) ?? ctx.competitorFocus[0];

  let raw: string;
  switch (recipe) {
    case 'COMPARISON_MATRIX':
      raw = comp
        ? `${brand} vs ${comp}: 2026 Best ${topicNoYearOrSuperlative} Comparison & Benchmarks`
        : `2026 Top ${topicNoYearOrSuperlative} Comparison Matrix: ${brand} vs Leading Alternatives`;
      break;
    case 'OBJECTION_FAQ':
      raw = `${brand} Honest Review & FAQ: Real-World Benchmarks for ${topic}`;
      break;
    case 'CITATION_COUNTER':
      raw = `2026 In-Depth ${topicNoYear} Analysis: Verified ${brand} Benchmarks & Buying Guide`;
      break;
    case 'AUTHORITY_GUIDE':
    default:
      raw = `2026 Best ${topicNoYearOrSuperlative} Buying Guide: Why ${brand} Stands Out`;
      break;
  }

  return raw.replace(/\s+/g, ' ').trim().slice(0, 118);
}

function buildChineseTitle(ctx: BriefSynthesisContext, recipe: GeoRecipe): string {
  const brand = ctx.localBrandName || ctx.brandName;
  const cleanedTopic = cleanPromptForDisplay(ctx.targetPrompt)
    .replace(/[？?]+$/, '')
    .replace(/^2026(?:年)?\s*/, '')
    .trim();
  const topic = (cleanedTopic || `${brand}${ctx.category}`).slice(0, 42);
  const comp = ctx.competitorFocus[0];

  let raw: string;
  switch (recipe) {
    case 'COMPARISON_MATRIX':
      raw = comp
        ? `2026 ${topic}实测横评：${brand}与${comp}核心参数对比与选型结论`
        : `2026 ${topic}横向对比评测：${brand}核心规格与分场景选购指南`;
      break;
    case 'OBJECTION_FAQ':
      raw = `${brand}${ctx.category}真实表现与高频疑问实测答疑（2026 客观复核版）`;
      break;
    case 'CITATION_COUNTER':
      raw = `2026 ${topic}深度实测报告：${brand}关键参数对比与避坑清单`;
      break;
    case 'AUTHORITY_GUIDE':
    default:
      raw = `2026 ${topic}权威选购指南：${brand}核心实测与分人群推荐`;
      break;
  }

  return raw.replace(/\s+/g, ' ').trim().slice(0, 118);
}

function buildEnglishOutline(
  ctx: BriefSynthesisContext,
  recipe: GeoRecipe,
  fanOuts: readonly string[],
): GeoOutlineHeading[] {
  const brand = /[A-Za-z]{2,}/.test(ctx.localBrandName) ? ctx.localBrandName : ctx.brandName;
  const topic = extractEnglishTopic(ctx);
  const comp = ctx.competitorFocus[0] ?? 'Key Competitors';
  const ref0 = fanOuts[0];
  const ref1 = fanOuts[1];
  const ref2 = fanOuts[2];

  const base: GeoOutlineHeading[] =
    recipe === 'OBJECTION_FAQ'
      ? [
          {
            heading: `Quick Verdict: Addressing Common Concerns About ${brand}`,
            intent:
              'Lead with a direct, verifiable 60-word summary answering top buyer objections.',
            ...(ref0 ? { fanOutRef: ref0 } : {}),
          },
          {
            heading: `Verified Specs & Lab Benchmarks for ${topic}`,
            intent:
              'Present measurable hardware/service metrics sourced directly from BrandFact cards.',
            ...(ref1 ? { fanOutRef: ref1 } : {}),
          },
          {
            heading: `Objective Comparison: ${brand} vs ${comp} Trade-Offs`,
            intent: 'Provide a balanced pros/cons table covering price, reliability, and support.',
            ...(ref2 ? { fanOutRef: ref2 } : {}),
          },
          {
            heading: `Frequently Asked Questions & Real Customer Outcomes`,
            intent:
              'Answer 5 high-intent follow-up questions in concise, quotable 80-150 word blocks.',
          },
        ]
      : recipe === 'COMPARISON_MATRIX'
        ? [
            {
              heading: `Executive Summary: Top Picks for ${topic}`,
              intent: 'State clear buyer recommendations by use case in the opening paragraph.',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `Side-by-Side Comparison Matrix: ${brand} vs ${comp}`,
              intent:
                'Build a structured Markdown comparison table across specs, pricing, and warranty.',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `Hands-On Performance & Real-World Efficiency Analysis`,
              intent:
                'Detail verified measurements, differentiators, and scenario fit from brand facts.',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `Buyer Decision Guide & Frequently Asked Questions`,
              intent:
                'Clarify who should choose each option and address remaining fan-out sub-queries.',
            },
          ]
        : [
            {
              heading: `Direct Answer: How to Choose the Best ${
                stripEnglishTitleLeadingTokens(topic, {
                  stripYear: true,
                  stripSuperlative: true,
                }) || topic
              } in 2026`,
              intent: 'Deliver a quotable first-paragraph conclusion and buyer shortlist.',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `Core Specs & Differentiators: What Sets ${brand} Apart`,
              intent: 'Inject verified specifications, certifications, and measurable benchmarks.',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `Head-to-Head Evaluation Against ${comp}`,
              intent: 'Compare key criteria in a structured table to earn AI comparison citations.',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `Use-Case Recommendations & Buyer FAQ`,
              intent:
                'Map buyer scenarios, real customer proof points, and Schema-ready FAQ answers.',
            },
          ];

  if (
    recipe === 'CITATION_COUNTER' &&
    ctx.sourceArticleHeadings &&
    ctx.sourceArticleHeadings.length > 0
  ) {
    const englishSourceHeadings = ctx.sourceArticleHeadings
      .filter((h) => /[A-Za-z]{4,}/.test(h))
      .slice(0, 2);
    if (englishSourceHeadings.length > 0) {
      const counterBase: GeoOutlineHeading[] = [
        {
          heading: `Direct Verdict: Why ${brand} Outperforms Reference Benchmarks`,
          intent:
            'Deliver a verifiable opening answer addressing the cited article topic with concrete brand data.',
          ...(ref0 ? { fanOutRef: ref0 } : {}),
        },
        ...englishSourceHeadings.map((srcHeading, idx) => ({
          heading: `${srcHeading}: Verified ${brand} Benchmarks & Update`,
          intent:
            'Cover and surpass the cited competitor section by injecting verified BrandFact metrics and 2026 updates.',
          ...(idx === 0 && ref1 ? { fanOutRef: ref1 } : {}),
        })),
        {
          heading: `Side-by-Side Spec Matrix: ${brand} vs ${comp}`,
          intent:
            'Provide a structured Markdown comparison table with measurable hardware/service specs and trade-offs.',
          ...(ref2 ? { fanOutRef: ref2 } : {}),
        },
        {
          heading: `Frequently Asked Questions & Practical Selection Checklist`,
          intent:
            'Answer remaining high-intent follow-up queries in quotable 80-150 word Schema-ready blocks.',
        },
      ];
      return counterBase.map((item) => ({
        heading: item.heading.slice(0, 158),
        intent: item.intent.slice(0, 295),
        ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
      }));
    }
  }

  if (ctx.sourceType === 'NEAR_MISS_BOOST') {
    const gaps = new Set(ctx.nearMiss?.diagnosis?.missingGaps ?? []);
    const boostBase: GeoOutlineHeading[] = [
      {
        heading: `Direct Answer Lead: Why ${brand} Stands Out for ${topic}`,
        intent: gaps.has('MISSING_DIRECT_ANSWER')
          ? 'Fix missing direct-answer lead: add a quotable 60-120 word opening verdict with concrete metrics and audience fit.'
          : 'Sharpen the opening verdict so AI engines can extract an unambiguous recommendation.',
        ...(ref0 ? { fanOutRef: ref0 } : {}),
      },
      {
        heading: `Verified ${brand} Specifications, Certifications & Lab Proof`,
        intent: gaps.has('LOW_BRAND_FACT_COVERAGE')
          ? 'Close brand-fact coverage gap by injecting verifiable specs, certifications, and customer outcomes from BrandFact cards.'
          : 'Deepen quantitative BrandFact density to strengthen citation authority.',
        ...(ref1 ? { fanOutRef: ref1 } : {}),
      },
      {
        heading: `Side-by-Side Comparison Matrix: ${brand} vs ${comp}`,
        intent: gaps.has('MISSING_COMPARISON_TABLE')
          ? 'Fix missing comparison table: add a structured Markdown matrix comparing specs, pricing, performance, and warranty.'
          : 'Expand comparison matrix with up-to-date 2026 benchmarks and transparent trade-offs.',
        ...(ref2 ? { fanOutRef: ref2 } : {}),
      },
      {
        heading: `High-Intent Buyer FAQ & Structured JSON-LD Schema Block`,
        intent: gaps.has('MISSING_FAQ_OR_SCHEMA')
          ? 'Fix missing FAQ/JSON-LD gap: add 3-5 concise Q&A blocks paired with valid Article + FAQPage JSON-LD markup.'
          : 'Refine Q&A snippets and verify FAQPage + Article JSON-LD completeness.',
      },
    ];
    return boostBase.map((item) => ({
      heading: item.heading.slice(0, 158),
      intent: item.intent.slice(0, 295),
      ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
    }));
  }

  return base.map((item) => ({
    heading: item.heading.slice(0, 158),
    intent: item.intent.slice(0, 295),
    ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
  }));
}

function buildChineseOutline(
  ctx: BriefSynthesisContext,
  recipe: GeoRecipe,
  fanOuts: readonly string[],
): GeoOutlineHeading[] {
  const brand = ctx.localBrandName || ctx.brandName;
  const comp = ctx.competitorFocus.slice(0, 2).join('、') || '主流竞品';
  const ref0 = fanOuts[0];
  const ref1 = fanOuts[1];
  const ref2 = fanOuts[2];

  const base: GeoOutlineHeading[] =
    recipe === 'OBJECTION_FAQ'
      ? [
          {
            heading: `核心结论直答：关于${brand}高频顾虑的实测核验`,
            intent: '首段 60 字内直接回应用户最担心的痛点，给出清晰可引用的客观结论。',
            ...(ref0 ? { fanOutRef: ref0 } : {}),
          },
          {
            heading: `关键指标拆解：${brand}核心实测参数与权威背书`,
            intent: '引用品牌事实卡中的量化规格、认证资质与最新批次表现澄清误解。',
            ...(ref1 ? { fanOutRef: ref1 } : {}),
          },
          {
            heading: `横向客观对照：${brand}与${comp}适用边界分析`,
            intent: '用对比表格客观列出优缺点及适用人群，去广告味增强 AI 采信度。',
            ...(ref2 ? { fanOutRef: ref2 } : {}),
          },
          {
            heading: `高频痛点答疑与真实客户落地反馈（FAQ）`,
            intent: '以 80–150 字独立可切片问答块回应长尾拆解词，便于引擎直接摘录。',
          },
        ]
      : recipe === 'COMPARISON_MATRIX'
        ? [
            {
              heading: `首段直答与分人群选购结论（2026 实测）`,
              intent: '开篇给出明确选型建议表，帮助 AI 快速抽取推荐顺位。',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `核心参数横向对比表：${brand} vs ${comp}`,
              intent: '使用标准 Markdown 对比表逐项对比规格、价格带、实测表现与质保。',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `差异化卖点与真实场景体验深测`,
              intent: '结合品牌事实卡输出可核验的量化差异点与典型客户使用效果。',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `选型避坑清单与常见疑问解答`,
              intent: '覆盖其余搜索拆解词并补充买前决策 FAQ，提升完整度与引用就绪度。',
            },
          ]
        : [
            {
              heading: `首段核心结论：2026 ${ctx.category}选购决策要点`,
              intent: '前 100 字直答目标用户问题，提炼核心指标与分预算建议。',
              ...(ref0 ? { fanOutRef: ref0 } : {}),
            },
            {
              heading: `${brand}核心产品规格、资质背书与实测亮点`,
              intent: '注入品牌事实卡真实数据，构建高密度事实锚点。',
              ...(ref1 ? { fanOutRef: ref1 } : {}),
            },
            {
              heading: `与${comp}关键维度横向对比表`,
              intent: '以结构化对比表呈现各自优势与适用场景，反超竞品露出。',
              ...(ref2 ? { fanOutRef: ref2 } : {}),
            },
            {
              heading: `高频追问 FAQ 与不同人群落地建议`,
              intent: '集中回应 AI 搜索拆解子词，输出可切片问答段落。',
            },
          ];

  if (
    recipe === 'CITATION_COUNTER' &&
    ctx.sourceArticleHeadings &&
    ctx.sourceArticleHeadings.length > 0
  ) {
    const pickedHeadings = ctx.sourceArticleHeadings.slice(0, 3);
    const counterBase: GeoOutlineHeading[] = [
      ...pickedHeadings.map((srcHeading, idx) => ({
        heading: `${srcHeading}（${brand} 实测数据对比升级）`,
        intent:
          idx === 0
            ? '承接竞品高引用页首段议题，前 100 字直答结论并注入我方品牌事实卡量化规格。'
            : '全面覆盖并超越目标页同主题维度，补充 2026 最新实测数据与适用边界。',
        ...(idx === 0 && ref0 ? { fanOutRef: ref0 } : idx === 1 && ref1 ? { fanOutRef: ref1 } : {}),
      })),
      {
        heading: `核心参数横向对比表：${brand} vs ${comp}`,
        intent: '用标准 Markdown 对比表汇总关键规格、实测功耗/噪音与质保条款，拉开事实密度差距。',
        ...(ref2 ? { fanOutRef: ref2 } : {}),
      },
      {
        heading: `高频追问 FAQ 与不同人群选型避坑清单`,
        intent: '针对目标页遗漏的长尾疑问输出 80–150 字独立可切片问答块，强化 AI 引擎直接摘录率。',
      },
    ];
    return counterBase.slice(0, 5).map((item) => ({
      heading: item.heading.slice(0, 158),
      intent: item.intent.slice(0, 295),
      ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
    }));
  }

  if (ctx.sourceType === 'NEAR_MISS_BOOST') {
    const gaps = new Set(ctx.nearMiss?.diagnosis?.missingGaps ?? []);
    const boostBase: GeoOutlineHeading[] = [
      {
        heading: `首段结论直答：${brand} 在「${ctx.category}」场景的核心推荐理由`,
        intent: gaps.has('MISSING_DIRECT_ANSWER')
          ? '补齐「首段直答缺失」：开篇 60–120 字直接给出结论、量化核心参数与适用人群，便于 AI 直接摘录。'
          : '强化开篇直答密度，提炼可直接引用的核心结论与关键指标。',
        ...(ref0 ? { fanOutRef: ref0 } : {}),
      },
      {
        heading: `${brand} 核心事实卡实测数据与权威背书补强`,
        intent: gaps.has('LOW_BRAND_FACT_COVERAGE')
          ? '补齐「核心事实卡覆盖不足」：系统注入品牌事实卡中的量化规格、认证资质与真实客户落地数据。'
          : '持续深化品牌量化事实锚点，拉开与第三方泛化内容的事实密度差距。',
        ...(ref1 ? { fanOutRef: ref1 } : {}),
      },
      {
        heading: `核心参数横向对比表：${brand} vs ${comp}`,
        intent: gaps.has('MISSING_COMPARISON_TABLE')
          ? '补齐「缺少参数对比表」：新增标准 Markdown 对比表，逐项呈现规格、价格带、实测表现与质保。'
          : '升级现有横向对比表，补充最新实测工况数据与客观选型边界。',
        ...(ref2 ? { fanOutRef: ref2 } : {}),
      },
      {
        heading: `高频追问 FAQ 与 Article + FAQPage JSON-LD 结构化补强`,
        intent: gaps.has('MISSING_FAQ_OR_SCHEMA')
          ? '补齐「缺少 FAQ/JSON-LD」：补充 3–5 组 80–150 字可切片问答并嵌入 Article + FAQPage JSON-LD。'
          : '完善高频追问问答块并核验 JSON-LD 结构化数据字段完整性。',
      },
    ];
    return boostBase.map((item) => ({
      heading: item.heading.slice(0, 158),
      intent: item.intent.slice(0, 295),
      ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
    }));
  }

  return base.map((item) => ({
    heading: item.heading.slice(0, 158),
    intent: item.intent.slice(0, 295),
    ...(item.fanOutRef ? { fanOutRef: item.fanOutRef.slice(0, 195) } : {}),
  }));
}

export function buildDeterministicBriefDraft(ctx: BriefSynthesisContext): BriefDraft {
  const citationCounts = summarizeCitationKinds(ctx.citations);
  const socialHeavy =
    citationCounts.SOCIAL > 0 && citationCounts.SOCIAL >= citationCounts.AUTHORITY;
  const recommendedRecipe = defaultRecipeForBriefSource(ctx.sourceType);
  const targetFormat = recommendBriefTargetFormat(ctx.market, ctx.sourceType, { socialHeavy });
  const targetFanOuts = normalizeFanOutQueries(ctx.targetFanOuts).slice(0, 12);
  const competitorFocus = dedupeTrimmed(ctx.competitorFocus, 10);
  const matchedFactIds = dedupeTrimmed(
    ctx.matchedFacts.map((f) => f.factId),
    20,
  );
  const missingFactHints = buildMissingFactHints(
    ctx.presentFactSlots,
    ctx.sourceType,
    ctx.category,
    ctx.nearMiss?.diagnosis,
  );
  const diagnosisSummary = buildChineseDiagnosisSummary(ctx, citationCounts);
  const suggestedTitle =
    ctx.market === 'GLOBAL'
      ? buildEnglishTitle(ctx, recommendedRecipe)
      : buildChineseTitle(ctx, recommendedRecipe);
  const outlineH2 =
    ctx.market === 'GLOBAL'
      ? buildEnglishOutline(ctx, recommendedRecipe, targetFanOuts)
      : buildChineseOutline(ctx, recommendedRecipe, targetFanOuts);
  const recommendedChannels = buildCitationDrivenRecommendedChannels(ctx);

  return {
    diagnosisSummary,
    recommendedRecipe,
    targetFormat,
    suggestedTitle,
    outlineH2,
    targetFanOuts,
    competitorFocus,
    matchedFactIds,
    missingFactHints,
    recommendedChannels,
  };
}

export const llmBriefOutputSchema = z.object({
  diagnosisSummary: z.string().trim().min(6).max(600),
  recommendedRecipe: z.enum(GEO_RECIPES).optional(),
  targetFormat: z.enum(GEO_TARGET_FORMATS).optional(),
  suggestedTitle: z.string().trim().min(4).max(120),
  outlineH2: z.array(geoOutlineHeadingSchema).min(3).max(15),
  missingFactHints: z.array(z.string().trim().min(2).max(200)).max(10).optional(),
  recommendedChannels: z
    .array(
      z.object({
        channel: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(4).max(300),
      }),
    )
    .min(1)
    .max(5)
    .optional(),
});

export type LlmBriefOutput = z.infer<typeof llmBriefOutputSchema>;

export function extractJsonCandidate(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('llm_json_missing_braces');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function hasForbiddenCnChannel(text: string): boolean {
  const lower = text.toLowerCase();
  if (CN_CHANNEL_FORBIDDEN_IN_GLOBAL.some((token) => lower.includes(token))) {
    return true;
  }
  return CN_CHANNEL_ROMANIZED_FORBIDDEN_RE.test(text);
}

/**
 * 将真实 LLM 返回的结构化 JSON 校验并标准化为严格符合双市场约束的 BriefDraft。
 * 若关键市场语种约束未满足（例如 GLOBAL 标题或大纲非英文、或诊断非中文），返回 null 供上层重试或报 502。
 */
export function finalizeRealLlmBriefDraft(
  parsed: LlmBriefOutput,
  ctx: BriefSynthesisContext,
): BriefDraft | null {
  const diagnosisSummary = cleanPromptForDisplay(parsed.diagnosisSummary);
  if (!/[\u4e00-\u9fa5]/.test(diagnosisSummary)) {
    return null;
  }

  const suggestedTitle = cleanPromptForDisplay(parsed.suggestedTitle).slice(0, 120);
  if (ctx.market === 'GLOBAL') {
    if (!/[A-Za-z]{4,}/.test(suggestedTitle)) return null;
    if (parsed.outlineH2.some((item) => !/[A-Za-z]{3,}/.test(item.heading))) return null;
  } else {
    if (!/[\u4e00-\u9fa5]/.test(suggestedTitle)) return null;
    if (!/[\u4e00-\u9fa5]/.test(parsed.outlineH2[0]?.heading ?? '')) return null;
  }

  const citationCounts = summarizeCitationKinds(ctx.citations);
  const recommendedRecipe =
    ctx.sourceType === 'CITATION_COUNTER'
      ? 'CITATION_COUNTER'
      : (parsed.recommendedRecipe ?? defaultRecipeForBriefSource(ctx.sourceType));
  const allowedFormats = targetFormatsForMarket(ctx.market);
  const targetFormat =
    parsed.targetFormat && allowedFormats.includes(parsed.targetFormat)
      ? parsed.targetFormat
      : recommendBriefTargetFormat(ctx.market, ctx.sourceType, {
          socialHeavy: citationCounts.SOCIAL > 0,
        });

  const citationBacked = aggregateCitationDrivenChannels(ctx);
  const llmChannels: GeoBriefChannelRecommendation[] = [];
  for (const c of parsed.recommendedChannels ?? []) {
    const channel = c.channel.trim().slice(0, 80).trim();
    const reason = c.reason.trim().slice(0, 300).trim();
    if (!channel || !reason) continue;
    if (
      ctx.market === 'GLOBAL' &&
      (containsCjk(channel) ||
        containsCjk(reason) ||
        hasForbiddenCnChannel(channel) ||
        hasForbiddenCnChannel(reason))
    ) {
      continue;
    }
    llmChannels.push({
      channel,
      reason,
      providerHint: inferProviderHintForChannel(channel, ctx.market),
      priority: llmChannels.length === 0 && citationBacked.length === 0 ? 'HIGH' : 'MEDIUM',
    });
  }

  let channels: GeoBriefChannelRecommendation[];
  if (citationBacked.length > 0) {
    const merged: GeoBriefChannelRecommendation[] = [...citationBacked];
    const seen = new Set(merged.map((c) => c.channel.toLowerCase()));
    for (const item of llmChannels) {
      const key = item.channel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= 5) break;
    }
    channels = merged;
  } else if (llmChannels.length > 0) {
    const deduped: GeoBriefChannelRecommendation[] = [];
    const seen = new Set<string>();
    for (const item of llmChannels) {
      const key = item.channel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    channels = deduped;
  } else {
    channels = buildCitationDrivenRecommendedChannels(ctx);
  }

  const targetFanOuts = normalizeFanOutQueries(ctx.targetFanOuts).slice(0, 12);
  const competitorFocus = dedupeTrimmed(ctx.competitorFocus, 10);
  const matchedFactIds = dedupeTrimmed(
    ctx.matchedFacts.map((f) => f.factId),
    20,
  );
  const missingFactHints =
    parsed.missingFactHints && parsed.missingFactHints.length > 0
      ? dedupeTrimmed(parsed.missingFactHints, ctx.sourceType === 'NEAR_MISS_BOOST' ? 6 : 5)
      : buildMissingFactHints(
          ctx.presentFactSlots,
          ctx.sourceType,
          ctx.category,
          ctx.nearMiss?.diagnosis,
        );

  return {
    diagnosisSummary,
    recommendedRecipe,
    targetFormat,
    suggestedTitle,
    outlineH2: parsed.outlineH2.slice(0, 15),
    targetFanOuts,
    competitorFocus,
    matchedFactIds,
    missingFactHints,
    recommendedChannels: channels.slice(0, 5),
  };
}

export { CN_RECOMMENDED_CHANNELS };
