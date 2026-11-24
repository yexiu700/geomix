import { z } from 'zod';
import {
  DEMO_TENANT_POINTS,
  DEMO_TENANT_VALID_DAYS,
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  isZeroAllowedPricingAction,
  type FreeRateLimitedAction,
  type PricingAction,
} from './catalog';

export const MARKETING_LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'TRIAL_PROVISIONED',
  'ARCHIVED',
] as const;
export type MarketingLeadStatus = (typeof MARKETING_LEAD_STATUSES)[number];

export const MARKETING_LEAD_STATUS_LABELS: Record<MarketingLeadStatus, string> = {
  NEW: '待跟进',
  CONTACTED: '已联系',
  TRIAL_PROVISIONED: '已开通试用',
  ARCHIVED: '已归档',
};

export const MARKETING_LEAD_MARKETS = ['GLOBAL', 'CN', 'BOTH'] as const;
export type MarketingLeadMarket = (typeof MARKETING_LEAD_MARKETS)[number];

export const MARKETING_LEAD_MARKET_LABELS: Record<
  MarketingLeadMarket,
  { readonly en: string; readonly zh: string }
> = {
  GLOBAL: { en: 'Global Markets', zh: '海外市场' },
  CN: { en: 'China Market', zh: '国内市场' },
  BOTH: { en: 'Global + China', zh: '海外 + 国内双市场' },
};

export const MARKETING_LOCALES = ['en', 'zh-CN'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

function hasSingleLineControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasMultilineControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function blankToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

const MAX_UNIT_POINTS = 1_000_000;
const STRICT_NON_NEGATIVE_INT_RE = /^\d+$/;

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function parseStrictIntQueryParam(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!STRICT_NON_NEGATIVE_INT_RE.test(trimmed)) return value;
    return Number(trimmed);
  }
  return value;
}

/**
 * Validates public-facing website URLs submitted through unauthenticated marketing forms.
 * Rejects non-HTTP(S) schemes, credentials, parser-differential authority/path backslashes,
 * port 0, localhost/internal hosts, single-label hosts, and IPv4/IPv6/decimal/hex IP literals.
 */
export function isSafeMarketingHttpUrl(raw: string): boolean {
  if (hasSingleLineControl(raw)) return false;
  const val = raw.trim();
  if (!val || val.length > 2048 || /\s/.test(val)) return false;
  if (!/^https?:\/\//i.test(val)) return false;

  const schemeEnd = val.indexOf('://');
  const afterScheme = val.slice(schemeEnd + 3);
  const queryOrHashIdx = afterScheme.search(/[?#]/);
  const authorityAndPath =
    queryOrHashIdx === -1 ? afterScheme : afterScheme.slice(0, queryOrHashIdx);
  if (authorityAndPath.includes('\\')) return false;

  const slashIdx = authorityAndPath.indexOf('/');
  const rawAuthority = slashIdx === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIdx);
  if (!rawAuthority || rawAuthority.includes('@')) return false;

  try {
    const parsed = new URL(val);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port === '0') return false;

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.includes(':') || hostname.includes('..')) return false;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === 'localhost.localdomain' ||
      hostname.endsWith('.localdomain') ||
      hostname === 'home.arpa' ||
      hostname.endsWith('.home.arpa') ||
      hostname === 'metadata.goog' ||
      hostname.endsWith('.metadata.goog') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return false;
    }

    const labels = hostname.split('.');
    if (labels.length < 2) return false;
    for (const label of labels) {
      if (!DNS_LABEL_RE.test(label)) return false;
    }

    const tld = labels[labels.length - 1];
    if (!tld || !DNS_TLD_RE.test(tld)) return false;

    return true;
  } catch {
    return false;
  }
}

export const createMarketingLeadSchema = z
  .object({
    locale: z.enum(MARKETING_LOCALES).default('en'),
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(80, 'Name must be 80 characters or fewer')
      .refine((value) => !hasSingleLineControl(value), 'Name contains invalid characters'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(160, 'Email must be 160 characters or fewer')
      .email('Please enter a valid work email'),
    companyBrand: z
      .string()
      .trim()
      .min(1, 'Company or brand name is required')
      .max(120, 'Company or brand name must be 120 characters or fewer')
      .refine(
        (value) => !hasSingleLineControl(value),
        'Company or brand name contains invalid characters',
      ),
    websiteUrl: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(500, 'Website URL must be 500 characters or fewer')
        .refine(isSafeMarketingHttpUrl, 'Please enter a valid public http(s) website URL')
        .optional(),
    ),
    targetMarket: z.enum(MARKETING_LEAD_MARKETS).default('GLOBAL'),
    monthlyGoal: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(160, 'Monthly goal must be 160 characters or fewer')
        .refine((value) => !hasSingleLineControl(value), 'Monthly goal contains invalid characters')
        .optional(),
    ),
    estimatedPts: z.preprocess(
      blankToUndefined,
      z.number().int().min(0).max(10_000_000).transform(normalizeZero).optional(),
    ),
    notes: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(2000, 'Notes must be 2000 characters or fewer')
        .refine((value) => !hasMultilineControl(value), 'Notes contain invalid characters')
        .optional(),
    ),
    sourcePage: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .max(120, 'Source page path is too long')
        .refine(
          (value) =>
            value.startsWith('/') &&
            !value.startsWith('//') &&
            !value.includes('\\') &&
            !/\s/.test(value) &&
            !hasSingleLineControl(value),
          'Invalid source page path',
        )
        .optional(),
    ),
    honeypot: z.string().max(500).optional(),
  })
  .strict();

export type CreateMarketingLeadInput = z.infer<typeof createMarketingLeadSchema>;
export type CreateMarketingLeadPayload = z.input<typeof createMarketingLeadSchema>;

export const updateMarketingLeadStatusSchema = z
  .object({
    status: z.enum(MARKETING_LEAD_STATUSES).optional(),
    adminNote: z
      .union([
        z
          .string()
          .trim()
          .max(2000, '备注最多 2000 字')
          .refine((value) => !hasMultilineControl(value), '备注含有无法显示的字符'),
        z.null(),
      ])
      .optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.adminNote !== undefined, {
    message: '请至少修改状态或备注',
  });

export type UpdateMarketingLeadStatusInput = z.infer<typeof updateMarketingLeadStatusSchema>;

export const listMarketingLeadsQuerySchema = z
  .object({
    page: z.preprocess(parseStrictIntQueryParam, z.number().int().min(1).max(1000).default(1)),
    pageSize: z.preprocess(parseStrictIntQueryParam, z.number().int().min(1).max(100).default(20)),
    status: z.preprocess(blankToUndefined, z.enum(MARKETING_LEAD_STATUSES).optional()),
    targetMarket: z.preprocess(blankToUndefined, z.enum(MARKETING_LEAD_MARKETS).optional()),
    keyword: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .min(1)
        .max(120)
        .refine((value) => !hasSingleLineControl(value), '关键词含有无法显示的字符')
        .optional(),
    ),
  })
  .strict();

export type ListMarketingLeadsQuery = z.infer<typeof listMarketingLeadsQuerySchema>;

export interface MarketingLeadDto {
  id: string;
  locale: string;
  name: string;
  email: string;
  companyBrand: string;
  websiteUrl: string | null;
  targetMarket: MarketingLeadMarket;
  monthlyGoal: string | null;
  estimatedPts: number | null;
  notes: string | null;
  sourcePage: string | null;
  status: MarketingLeadStatus;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPricingItem {
  action: PricingAction;
  unitPoints: number;
  label: string;
  labelEn: string;
  unitZh: string;
  unitEn: string;
  descriptionZh: string;
  descriptionEn: string;
}

export interface PublicFreeAction {
  action: FreeRateLimitedAction;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
}

export interface PublicPricingPayload {
  items: readonly PublicPricingItem[];
  freeActions: readonly PublicFreeAction[];
  demoTrial: {
    points: number;
    validDays: number;
  };
}

const PUBLIC_PRICING_ITEM_META: Record<
  PricingAction,
  Omit<PublicPricingItem, 'action' | 'unitPoints'>
> = {
  geo_write: {
    label: 'GEO 靶向写作',
    labelEn: 'GEO Targeted Writing',
    unitZh: '点/篇',
    unitEn: 'pts / article',
    descriptionZh:
      '基于真实品牌事实卡生成引用级长文，免费标配 GEO 0–100 体检、JSON-LD 与 llms.txt 导出',
    descriptionEn:
      'Citation-grade article grounded in verified brand facts, with bundled GEO 0–100 scoring, JSON-LD, and llms.txt export',
  },
  visibility_check: {
    label: 'AI 可见性监测',
    labelEn: 'AI Visibility Check',
    unitZh: '点/引擎/次',
    unitEn: 'pts / engine run',
    descriptionZh: '在目标 AI 引擎执行单次问答引用拓扑诊断（失败或超时自动退还点数）',
    descriptionEn:
      'Single prompt-by-engine citation and mention diagnosis across Global or China AI engines (auto-refunded on failure or timeout)',
  },
  inline_image_gen: {
    label: '行内 AI 配图',
    labelEn: 'Inline AI Image',
    unitZh: '点/张',
    unitEn: 'pts / image',
    descriptionZh: '在写作台按需生成文章配图并归档至品牌图库',
    descriptionEn:
      'On-demand editorial visual generated in the Studio editor and archived to the brand media library',
  },
  geo_variant: {
    label: '渠道变体改写',
    labelEn: 'Channel Variant Adaptation',
    unitZh: '点/渠道',
    unitEn: 'pts / channel',
    descriptionZh: '基于母稿与品牌事实卡按目标渠道派生适配变体（支持配置为 0 点限流使用）',
    descriptionEn:
      'Derive channel-ready adaptations from a master draft and brand fact card (supports optional 0-point rate-limited mode)',
  },
};

const PUBLIC_FREE_ACTION_META: Record<FreeRateLimitedAction, Omit<PublicFreeAction, 'action'>> = {
  geo_brief: {
    labelZh: 'GEO 选题简报',
    labelEn: 'GEO Topic Brief',
    descriptionZh: '结合 AI 引用缺口与竞品来源，自动生成靶向选题提纲与证据需求清单',
    descriptionEn:
      'Turn AI citation gaps and competitor sources into structured outlines with required proof points',
  },
  brand_fact_extract: {
    labelZh: '品牌事实卡提取',
    labelEn: 'Brand Fact Card Extraction',
    descriptionZh: '将品牌官网、参数表与产品文档整理为结构化核验事实卡，供写作精准引用',
    descriptionEn:
      'Normalize product docs, specs, and official pages into verified Brand Fact Cards for grounded drafting',
  },
  geo_evaluate: {
    labelZh: 'GEO 0–100 实时体检',
    labelEn: 'Real-Time GEO 0–100 Audit',
    descriptionZh: '实时评估事实密度、直答结构、表格规范与 Schema 完整度并给出可操作改进项',
    descriptionEn:
      'Score fact density, direct-answer structure, tables, and Schema completeness with actionable fixes',
  },
  rewrite_section: {
    labelZh: '局部分段重写',
    labelEn: 'Targeted Section Rewrite',
    descriptionZh: '针对单一段落、对比表或 FAQ 进行定向润色与事实校对，不重复消耗整篇点数',
    descriptionEn:
      'Refine individual paragraphs, comparison tables, or FAQs without paying for a full article draft',
  },
  distribution_preflight: {
    labelZh: '发布前合规门禁校验',
    labelEn: 'Pre-Publish Preflight Gate',
    descriptionZh: '自动拦截未填 [TBD] 占位符、无证据夸大措辞与跨市场语种泄漏风险',
    descriptionEn:
      'Block unresolved [TBD] placeholders, unsubstantiated superlatives, and cross-market language leaks before release',
  },
  crawl_probe: {
    labelZh: 'T+1 线上抓取与 Schema 体检',
    labelEn: 'T+1 Crawl & Schema Probe',
    descriptionZh: '发布后自动巡检线上 URL 状态码、Canonical、robots.txt 可抓取性与 JSON-LD 结构',
    descriptionEn:
      'Verify live HTTP status, canonical tags, robots.txt crawlability, and valid JSON-LD after publishing',
  },
  pr_packet_share: {
    labelZh: '免登录 PR/KOL 供稿单',
    labelEn: 'Login-Free PR / KOL Media Kit',
    descriptionZh: '生成 30 天有效只读外链供外部媒体与 KOL 直接查阅核验素材，无需共享后台账号',
    descriptionEn:
      'Generate 30-day read-only briefing links for external journalists and KOLs without sharing workspace logins',
  },
};

export const PUBLIC_PRICING_FALLBACK: PublicPricingPayload = {
  items: PRICING_DEFAULTS.map((entry) => ({
    action: entry.action,
    unitPoints: entry.unitPoints,
    ...PUBLIC_PRICING_ITEM_META[entry.action],
  })),
  freeActions: FREE_RATE_LIMITED_ACTIONS.map((action) => ({
    action,
    ...PUBLIC_FREE_ACTION_META[action],
  })),
  demoTrial: {
    points: DEMO_TENANT_POINTS,
    validDays: DEMO_TENANT_VALID_DAYS,
  },
};

export interface LivePricingItemInput {
  action: string;
  unitPoints: number;
  enabled?: boolean;
}

/**
 * Merges live enabled `PricingItem` records onto `PUBLIC_PRICING_FALLBACK`.
 * Unknown or retired actions are ignored and non-public fields are stripped.
 */
export function buildPublicPricingPayload(
  liveItems?: ReadonlyArray<LivePricingItemInput>,
): PublicPricingPayload {
  const overrides = new Map<string, number>();

  if (liveItems) {
    for (const row of liveItems) {
      if (row.enabled === false) continue;
      if (!Number.isSafeInteger(row.unitPoints) || row.unitPoints > MAX_UNIT_POINTS) continue;
      const normalized = normalizeZero(row.unitPoints);
      const isValid = isZeroAllowedPricingAction(row.action) ? normalized >= 0 : normalized > 0;
      if (!isValid) continue;
      overrides.set(row.action, normalized);
    }
  }

  return {
    items: PUBLIC_PRICING_FALLBACK.items.map((item) => {
      const override = overrides.get(item.action);
      return override === undefined ? { ...item } : { ...item, unitPoints: override };
    }),
    freeActions: PUBLIC_PRICING_FALLBACK.freeActions.map((entry) => ({ ...entry })),
    demoTrial: { ...PUBLIC_PRICING_FALLBACK.demoTrial },
  };
}

export const POINTS_ESTIMATE_LIMITS = {
  monthlyArticles: { min: 1, max: 50, default: 8 },
  variantChannelsPerArticle: { min: 0, max: 4, default: 2 },
  trackedPrompts: { min: 5, max: 100, default: 20 },
  monitoredEngines: { min: 1, max: 5, default: 4 },
  samplesPerPrompt: [1, 3] as const,
} as const;

export const POINTS_ESTIMATE_TIERS = ['TRIAL', 'GROWTH', 'ENTERPRISE'] as const;
export type PointsEstimateTier = (typeof POINTS_ESTIMATE_TIERS)[number];

export interface PointsEstimateUnitPoints {
  geo_write?: number;
  geo_variant?: number;
  visibility_check?: number;
}

export interface PointsEstimateInput {
  monthlyArticles?: number;
  variantChannelsPerArticle?: number;
  trackedPrompts?: number;
  monitoredEngines?: number;
  samplesPerPrompt?: 1 | 3;
  enableAutoRetest?: boolean;
  unitPoints?: PointsEstimateUnitPoints;
}

export interface PointsEstimateResult {
  normalizedInput: {
    monthlyArticles: number;
    variantChannelsPerArticle: number;
    trackedPrompts: number;
    monitoredEngines: number;
    samplesPerPrompt: 1 | 3;
    enableAutoRetest: boolean;
  };
  unitPoints: {
    geo_write: number;
    geo_variant: number;
    visibility_check: number;
  };
  writingPoints: number;
  variantPoints: number;
  baselineVisibilityPoints: number;
  retestVisibilityPoints: number;
  totalMonthlyPoints: number;
  recommendedTier: PointsEstimateTier;
}

function getDefaultUnitPoints(action: PricingAction): number {
  const entry = PRICING_DEFAULTS.find((item) => item.action === action);
  return entry ? entry.unitPoints : 0;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return normalizeZero(fallback);
  return normalizeZero(Math.min(max, Math.max(min, Math.round(value))));
}

function sanitizeUnitPoints(value: number | undefined, minValue: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return normalizeZero(fallback);
  const rounded = normalizeZero(Math.round(value));
  return rounded >= minValue && rounded <= MAX_UNIT_POINTS ? rounded : normalizeZero(fallback);
}

/**
 * Pure deterministic monthly points estimator used on `/pricing` and `/zh/pricing`.
 * Retest schedules run 3 attribution checkpoints per article (T+7, T+14, T+30).
 */
export function calculateMonthlyPointsEstimate(
  input: PointsEstimateInput = {},
): PointsEstimateResult {
  const safeInput: PointsEstimateInput = input ?? {};

  const monthlyArticles = clampInt(
    safeInput.monthlyArticles,
    POINTS_ESTIMATE_LIMITS.monthlyArticles.min,
    POINTS_ESTIMATE_LIMITS.monthlyArticles.max,
    POINTS_ESTIMATE_LIMITS.monthlyArticles.default,
  );
  const variantChannelsPerArticle = clampInt(
    safeInput.variantChannelsPerArticle,
    POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.min,
    POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.max,
    POINTS_ESTIMATE_LIMITS.variantChannelsPerArticle.default,
  );
  const trackedPrompts = clampInt(
    safeInput.trackedPrompts,
    POINTS_ESTIMATE_LIMITS.trackedPrompts.min,
    POINTS_ESTIMATE_LIMITS.trackedPrompts.max,
    POINTS_ESTIMATE_LIMITS.trackedPrompts.default,
  );
  const monitoredEngines = clampInt(
    safeInput.monitoredEngines,
    POINTS_ESTIMATE_LIMITS.monitoredEngines.min,
    POINTS_ESTIMATE_LIMITS.monitoredEngines.max,
    POINTS_ESTIMATE_LIMITS.monitoredEngines.default,
  );
  const samplesPerPrompt: 1 | 3 = safeInput.samplesPerPrompt === 3 ? 3 : 1;
  const enableAutoRetest =
    typeof safeInput.enableAutoRetest === 'boolean' ? safeInput.enableAutoRetest : true;

  const unitPoints = {
    geo_write: sanitizeUnitPoints(
      safeInput.unitPoints?.geo_write,
      1,
      getDefaultUnitPoints('geo_write'),
    ),
    geo_variant: sanitizeUnitPoints(
      safeInput.unitPoints?.geo_variant,
      0,
      getDefaultUnitPoints('geo_variant'),
    ),
    visibility_check: sanitizeUnitPoints(
      safeInput.unitPoints?.visibility_check,
      1,
      getDefaultUnitPoints('visibility_check'),
    ),
  };

  const writingPoints = normalizeZero(monthlyArticles * unitPoints.geo_write);
  const variantPoints = normalizeZero(
    monthlyArticles * variantChannelsPerArticle * unitPoints.geo_variant,
  );
  const baselineVisibilityPoints = normalizeZero(
    trackedPrompts * monitoredEngines * samplesPerPrompt * unitPoints.visibility_check,
  );
  const retestVisibilityPoints = enableAutoRetest
    ? normalizeZero(
        monthlyArticles * 3 * monitoredEngines * samplesPerPrompt * unitPoints.visibility_check,
      )
    : 0;
  const totalMonthlyPoints = normalizeZero(
    writingPoints + variantPoints + baselineVisibilityPoints + retestVisibilityPoints,
  );

  let recommendedTier: PointsEstimateTier;
  if (totalMonthlyPoints <= 1000) {
    recommendedTier = 'TRIAL';
  } else if (totalMonthlyPoints <= 10000) {
    recommendedTier = 'GROWTH';
  } else {
    recommendedTier = 'ENTERPRISE';
  }

  return {
    normalizedInput: {
      monthlyArticles,
      variantChannelsPerArticle,
      trackedPrompts,
      monitoredEngines,
      samplesPerPrompt,
      enableAutoRetest,
    },
    unitPoints,
    writingPoints,
    variantPoints,
    baselineVisibilityPoints,
    retestVisibilityPoints,
    totalMonthlyPoints,
    recommendedTier,
  };
}

export const MARKETING_GUIDE_SLUGS = [
  'geo-citation-vs-mention',
  'llms-txt-and-jsonld-playbook',
  'zero-ban-community-geo',
  't7-t14-t30-attribution',
] as const;
export type MarketingGuideSlug = (typeof MARKETING_GUIDE_SLUGS)[number];

export interface MarketingGuideCodeSnippet {
  readonly label: string;
  readonly language: string;
  readonly code: string;
}

export interface MarketingGuideSection {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
  readonly codeSnippet?: MarketingGuideCodeSnippet;
}

export interface MarketingGuideLocaleContent {
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly keyTakeaways: readonly string[];
  readonly sections: readonly MarketingGuideSection[];
}

export interface MarketingGuide {
  readonly slug: MarketingGuideSlug;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly readingMinutes: number;
  readonly en: MarketingGuideLocaleContent;
  readonly zh: MarketingGuideLocaleContent;
}

export const MARKETING_GUIDES: readonly MarketingGuide[] = [
  {
    slug: 'geo-citation-vs-mention',
    publishedAt: '2026-11-24',
    updatedAt: '2026-11-24',
    readingMinutes: 7,
    en: {
      title: 'From Brand Mention to Source Citation: Why GEO Replaces Guesswork',
      subtitle:
        'Measure owned-domain citations across Global and China AI engines instead of chasing vague brand recall.',
      description:
        'A practical engineering taxonomy distinguishing CITED, MENTIONED, COMPETITOR, and ABSENT outcomes across AI answer engines, and how Brand Fact Cards turn citation gaps into publishable briefs.',
      category: 'GEO Foundations',
      tags: ['Citation Taxonomy', 'Dual-Market AI', 'Brand Fact Cards'],
      keyTakeaways: [
        'Track CITED (clickable owned or third-party source link) separately from unlinked MENTIONED brand recall.',
        'Monitor Global engines (ChatGPT, Perplexity, Google AI Overviews, Gemini) and China engines (Doubao, DeepSeek, Kimi, Yuanbao, Qwen) with market-specific prompt sets.',
        'Ground every draft in verified Brand Fact Cards and enforce [TBD] placeholder gates so models cite concrete specifications instead of generic marketing claims.',
      ],
      sections: [
        {
          id: 'why-mentions-mislead',
          heading: '1. Why Raw Brand Mentions Mislead Growth Teams',
          paragraphs: [
            'When a buyer asks an AI assistant for a category comparison, a passing brand name without a linked source rarely moves pipeline. Worse, models frequently recycle outdated third-party reviews when an official product page lacks concise, verifiable facts.',
            'GeoMix classifies every prompt-by-engine observation into four unambiguous states so editorial teams know whether they own the narrative or rely on someone else’s domain.',
          ],
          bullets: [
            'CITED: Your brand is named and backed by an explicit citation link (owned domain or authoritative partner coverage).',
            'MENTIONED: Your brand appears in prose, but the answer links exclusively to third-party lists or omits links altogether.',
            'COMPETITOR: Rival brands capture both recommendation slots and citation links while your brand is omitted.',
            'ABSENT: Neither your brand nor direct alternatives are retrieved, signaling a missing entity or crawlability gap.',
          ],
        },
        {
          id: 'dual-market-engine-matrix',
          heading: '2. Owned-Domain Citation Share Across Global and China Engines',
          paragraphs: [
            'Answer engines do not retrieve from identical indexes. Global buyers predominantly query ChatGPT, Perplexity, Google AI Overviews, and Gemini, where structured docs, independent community discussions, and crisp comparison tables dominate citation share.',
            'In the China market, teams must independently track Doubao, DeepSeek, Kimi, Tencent Yuanbao, and Qwen using native Chinese buyer phrasing. Splitting a brand into separate GLOBAL and CN markets prevents language drift and exposes which domains actually earn clickable authority.',
          ],
          bullets: [
            'Global target matrix: ChatGPT, Perplexity, Google AI Overviews, Gemini.',
            'China target matrix: 豆包 (Doubao), DeepSeek, Kimi, 腾讯元宝 (Yuanbao), 通义千问 (Qwen).',
            'Track Owned Citation Share = (Observations citing your official domains) / (Total observations citing any source for your target prompts).',
          ],
        },
        {
          id: 'fact-card-grounding',
          heading: '3. Grounding Content in Verified Brand Fact Cards',
          paragraphs: [
            'AI retrieval pipelines favor pages that state unambiguous specifications, pricing mechanics, compatibility matrices, and deployment boundaries near the top of the document. For example, a fictional audio brand like NordicAudio earns citations when its specs explicitly list battery endurance, codec support, and latency figures rather than vague slogans.',
            'Store verified metrics inside Brand Fact Cards before drafting. Whenever a required figure is unavailable, insert an explicit [TBD] slot and block release at the preflight gate until a subject-matter owner supplies the real number.',
          ],
        },
        {
          id: 'citation-gaps-to-briefs',
          heading: '4. Turning Citation Gaps into Repeatable Monthly Workflows',
          paragraphs: [
            'Once baseline observations highlight high-intent prompts classified as COMPETITOR or MENTIONED, inspect the exact competitor URLs the engines trusted. Extract the structural elements those pages supply—such as benchmark tables, integration checklists, or FAQ blocks—and convert each gap into a targeted GEO Topic Brief.',
            'Pair each published article with scheduled visibility retests so every point spent on writing and monitoring ties back to measurable citation movement.',
          ],
        },
      ],
    },
    zh: {
      title: '从品牌提及到信源引用：GEO 的衡量基准',
      subtitle:
        '用可点击的自有域名引用率替代模糊的品牌曝光，建立海外与国内双市场 AI 可见度指标体系。',
      description:
        '系统拆解 AI 问答中的 CITED / MENTIONED / COMPETITOR / ABSENT 四态模型，说明如何基于核验品牌事实卡将引用缺口转化为可追踪的选题与长文交付。',
      category: 'GEO 方法论',
      tags: ['引用拓扑', '双市场引擎', '品牌事实卡'],
      keyTakeaways: [
        '将「带链接引用（CITED）」与「无链接提及（MENTIONED）」严格拆开统计，重点跟踪自有域名引用占比。',
        '海外市场与国内市场需按独立 Prompt 集分轨监测，覆盖 ChatGPT/Perplexity/Gemini 与豆包/DeepSeek/Kimi/元宝/通义千问。',
        '所有写作必须以品牌事实卡为底稿，缺失参数以 [TBD] 占位并在发布门禁拦截，杜绝模型幻觉编造参数。',
      ],
      sections: [
        {
          id: 'why-mentions-mislead',
          heading: '一、为什么只看「品牌提及」会误导增长判断',
          paragraphs: [
            '当潜在客户向 AI 助手询问品类选型建议时，段落里顺带提到品牌名但没有可点击的官方来源，几乎无法带来高质量询盘；更常见的是，模型直接引用了信息滞后的第三方测评页，导致核心规格或定位被误读。',
            'GeoMix 将每一次「问题 × 引擎」的问答观测拆解为四种清晰状态，帮助内容团队精准识别品牌到底是掌握了信源话语权，还是只充当了陪跑背景板。',
          ],
          bullets: [
            'CITED（已引用）：回答不仅推荐了品牌，还附带指向官方站点或权威合作页面的可点击信源链接。',
            'MENTIONED（仅提及）：回答正文出现品牌名称，但引用来源全部指向第三方聚合页或完全没有链接。',
            'COMPETITOR（竞品占领）：核心推荐位与引用链接全部被竞品页面占据，本品牌缺席。',
            'ABSENT（未召回）：问答未召回本品牌及直接竞品，通常意味着实体信息不足或页面存在抓取障碍。',
          ],
        },
        {
          id: 'dual-market-engine-matrix',
          heading: '二、海外与国内双市场引擎的自有引用占比',
          paragraphs: [
            '不同区域的 AI 检索索引结构差异显著。海外用户高频使用 ChatGPT、Perplexity、Google AI Overviews 与 Gemini，这些引擎高度偏好结构化文档、清晰的参数对比表与高可信社区讨论。',
            '国内市场则需要围绕豆包、DeepSeek、Kimi、腾讯元宝与通义千问建立独立的中文问法集合。在品牌管理中按 GLOBAL 与 CN 拆分子市场，既能避免中英文混写导致的语义稀释，也能清晰对比不同渠道的信源贡献。',
          ],
          bullets: [
            '海外监测矩阵：ChatGPT、Perplexity、Google AI Overviews、Gemini。',
            '国内监测矩阵：豆包、DeepSeek、Kimi、腾讯元宝、通义千问。',
            '核心北极星指标：自有域名引用率 = 引用官方域名的观测次数 ÷ 目标问题集下产生有效引用的总观测次数。',
          ],
        },
        {
          id: 'fact-card-grounding',
          heading: '三、用核验「品牌事实卡」消除空洞话术与幻觉',
          paragraphs: [
            'AI 检索模型更愿意引用开篇直答、参数明确、边界清晰的技术与选型内容。例如虚构声学品牌「北境声学」在发布产品对比时，明确给出续航时长、延迟数据、接口兼容性与质保范围，远比堆砌形容词更容易进入引用列表。',
            '在写作前先将官网参数与白皮书沉淀为结构化品牌事实卡；遇到尚未确认的指标时，统一使用 [TBD] 占位符，由发布前门禁强制拦截，确保上线内容每一条关键数据都可追溯。',
          ],
        },
        {
          id: 'citation-gaps-to-briefs',
          heading: '四、把引用缺口转化为可复制的月度内容闭环',
          paragraphs: [
            '完成首轮诊断后，优先筛选高商业意图但处于 COMPETITOR 或 MENTIONED 状态的提问，拆解排名前列的竞品引用页究竟提供了哪些结构化证据（如对比矩阵、部署清单、FAQ 解答），再一键生成靶向 GEO 选题简报。',
            '文章发布后衔接自动抓取体检与周期复测，让每一次写作和监测点数投入都能对应到可验证的引用率变化。',
          ],
        },
      ],
    },
  },
  {
    slug: 'llms-txt-and-jsonld-playbook',
    publishedAt: '2026-11-24',
    updatedAt: '2026-11-24',
    readingMinutes: 8,
    en: {
      title: 'Engineering AI Crawlability: robots.txt, JSON-LD, and llms.txt',
      subtitle:
        'Configure crawler access, safe structured data, and machine-readable indexes so answer engines parse your site accurately.',
      description:
        'Step-by-step technical specifications for robots.txt AI retrieval directives, safe JSON-LD embedding, /llms.txt authoring, and T+1 CrawlProbe validation.',
      category: 'Technical GEO',
      tags: ['robots.txt', 'JSON-LD', 'llms.txt'],
      keyTakeaways: [
        'Explicitly allow retrieval crawlers on public marketing and documentation routes while disallowing private workspace, login, and admin paths.',
        'Keep JSON-LD entities (Organization, SoftwareApplication, TechArticle, FAQPage) strictly aligned with visible page copy and escape `<` characters safely.',
        'Publish a concise, plain-text `/llms.txt` index summarizing product scope, pricing unit mechanics, and canonical guide URLs.',
      ],
      sections: [
        {
          id: 'robots-txt-policy',
          heading: '1. Designing a Clean robots.txt Policy for AI Retrieval Crawlers',
          paragraphs: [
            'Many engineering teams inadvertently block answer-engine search bots while trying to protect internal application routes. Separate public knowledge assets from authenticated application areas in `robots.txt` so crawlers such as GPTBot, OAI-SearchBot, PerplexityBot, and Googlebot can index public pages cleanly.',
            'Always pair allow rules with explicit disallow directives for `/api/`, `/admin/`, `/home`, `/login`, and token-based private share links.',
          ],
          codeSnippet: {
            label: 'robots.txt example',
            language: 'text',
            code: [
              'User-agent: GPTBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              'Disallow: /login',
              '',
              'User-agent: OAI-SearchBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              '',
              'User-agent: PerplexityBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              '',
              'Sitemap: https://example.com/sitemap.xml',
            ].join('\n'),
          },
        },
        {
          id: 'structured-jsonld-hygiene',
          heading: '2. Structured JSON-LD Matched Verbatim to Visible Copy',
          paragraphs: [
            'Search and AI answer systems validate structured data against rendered HTML. Never inject hidden FAQ questions or inflated claims into `application/ld+json` blocks that are not visibly rendered on the page.',
            'When serializing JSON-LD inside server-rendered HTML, always escape `<` as `\\u003c` to eliminate script-breakout vectors even when strings originate from trusted CMS fields.',
          ],
          codeSnippet: {
            label: 'TechArticle JSON-LD snippet',
            language: 'json',
            code: JSON.stringify(
              {
                '@context': 'https://schema.org',
                '@type': 'TechArticle',
                headline: 'Engineering AI Crawlability: robots.txt, JSON-LD, and llms.txt',
                url: 'https://example.com/guides/llms-txt-and-jsonld-playbook',
                datePublished: '2026-11-24',
                publisher: {
                  '@type': 'Organization',
                  name: 'NordicAudio',
                  url: 'https://example.com',
                },
              },
              null,
              2,
            ),
          },
        },
        {
          id: 'llms-txt-blueprint',
          heading: '3. Publishing a Machine-Readable /llms.txt Index',
          paragraphs: [
            'Serve `/llms.txt` as `text/plain; charset=utf-8` at the site root. Treat it as an authoritative executive map for LLM retrieval agents: one-line entity summary, core capabilities, supported markets, pricing transparency rules, and direct links to canonical guides and documentation.',
            'Keep the file scannable, free of marketing fluff, and synced with your live sitemap so agents discover updated URLs without traversing heavy client-side scripts.',
          ],
          codeSnippet: {
            label: '/llms.txt structure',
            language: 'markdown',
            code: [
              '# NordicAudio',
              '> Acoustic engineering docs and structured product specifications.',
              '',
              '## Core Pages',
              '- Overview: https://example.com/',
              '- Specifications & Pricing: https://example.com/pricing',
              '- Technical Guides: https://example.com/guides',
              '- Sitemap: https://example.com/sitemap.xml',
            ].join('\n'),
          },
        },
        {
          id: 'post-publish-crawl-probe',
          heading: '4. Automating T+1 Crawl Probes and IndexNow Signals',
          paragraphs: [
            'Publishing a page is only half the engineering loop. Run an automated T+1 CrawlProbe to verify HTTP 200 status, exact `<link rel="canonical">` resolution, `robots.txt` permission for your target URL, and syntactically valid JSON-LD.',
            'When publishing to owned CMS properties via L1 connectors such as Shopify or WordPress, emit IndexNow pings immediately after verification so downstream search indexes pick up fresh content faster.',
          ],
        },
      ],
    },
    zh: {
      title: 'AI 可抓取工程指南：robots.txt、JSON-LD 与 llms.txt',
      subtitle:
        '通过规范的爬虫策略、结构化 JSON-LD 与 /llms.txt 索引，让主流 AI 检索引擎准确解析品牌资产。',
      description:
        '详解面向 GPTBot、PerplexityBot 与搜索引擎的 robots.txt 写法、安全 JSON-LD 注入规范、/llms.txt 组织方式以及发布后 T+1 抓取巡检流程。',
      category: '技术 GEO',
      tags: ['robots.txt', 'JSON-LD', 'llms.txt'],
      keyTakeaways: [
        '在 robots.txt 中明确放行公开内容与指南页，同时严格屏蔽工作台、登录页、管理后台与私有外链路径。',
        'JSON-LD（Organization / SoftwareApplication / TechArticle / FAQPage）必须与页面可见文案逐字一致，并对 `<` 做转义防护。',
        '在站点根目录以 `text/plain; charset=utf-8` 提供 `/llms.txt`，用精炼结构汇总实体定义、能力边界与核心页面链接。',
      ],
      sections: [
        {
          id: 'robots-txt-policy',
          heading: '一、面向 AI 检索爬虫的 robots.txt 分层策略',
          paragraphs: [
            '不少团队为了保护内部控制台，容易把整站爬虫入口一刀切封禁，导致品牌官网和产品文档无法进入 AI 检索索引。更稳妥的做法是将公开品牌页与鉴权应用路由明确分层。',
            '对 GPTBot、OAI-SearchBot、PerplexityBot 与主流搜索引擎开放公开内容路径，同时统一禁止抓取 `/api/`、`/admin/`、`/login` 与带令牌的私有分享链接。',
          ],
          codeSnippet: {
            label: 'robots.txt 配置示例',
            language: 'text',
            code: [
              'User-agent: GPTBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              'Disallow: /login',
              '',
              'User-agent: OAI-SearchBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              '',
              'User-agent: PerplexityBot',
              'Allow: /',
              'Disallow: /api/',
              'Disallow: /admin/',
              '',
              'Sitemap: https://example.com/sitemap.xml',
            ].join('\n'),
          },
        },
        {
          id: 'structured-jsonld-hygiene',
          heading: '二、与页面文案严格一致的安全 JSON-LD',
          paragraphs: [
            '搜索引擎与 AI 检索系统会交叉校验结构化数据与渲染 HTML 的一致性。切勿在 `application/ld+json` 中写入页面上并未展示的隐藏问答或夸大描述。',
            '在服务端渲染输出 JSON-LD 脚本时，应将 `<` 统一转义为 `\\u003c`，彻底阻断脚本标签闭合注入风险。',
          ],
          codeSnippet: {
            label: 'TechArticle JSON-LD 示例',
            language: 'json',
            code: JSON.stringify(
              {
                '@context': 'https://schema.org',
                '@type': 'TechArticle',
                headline: 'AI 可抓取工程指南：robots.txt、JSON-LD 与 llms.txt',
                url: 'https://example.com/zh/guides/llms-txt-and-jsonld-playbook',
                datePublished: '2026-11-24',
                publisher: {
                  '@type': 'Organization',
                  name: '北境声学',
                  url: 'https://example.com',
                },
              },
              null,
              2,
            ),
          },
        },
        {
          id: 'llms-txt-blueprint',
          heading: '三、编写机器友好的根目录 /llms.txt 索引',
          paragraphs: [
            '在站点根目录提供 `Content-Type: text/plain; charset=utf-8` 的 `/llms.txt` 文件，作为 AI 检索代理的官方导航索引：用简明文本列出品牌定位、适用市场、核心页面、透明计费说明与权威指南链接。',
            '内容保持客观克制、避免堆砌空洞宣传语，并与 `sitemap.xml` 中的规范链接保持一致，降低代理抓取解析成本。',
          ],
          codeSnippet: {
            label: '/llms.txt 结构模板',
            language: 'markdown',
            code: [
              '# 北境声学',
              '> 面向专业音频场景的公开产品规格、技术文档与选型指南。',
              '',
              '## 核心入口',
              '- 品牌总览：https://example.com/zh',
              '- 规格与透明定价：https://example.com/zh/pricing',
              '- 技术方法论指南：https://example.com/zh/guides',
              '- 站点地图：https://example.com/sitemap.xml',
            ].join('\n'),
          },
        },
        {
          id: 'post-publish-crawl-probe',
          heading: '四、发布后 T+1 抓取体检与 IndexNow 主动通知',
          paragraphs: [
            '内容上线只是起点。通过 T+1 抓取体检自动核验线上页面是否返回 HTTP 200、Canonical 链接是否正确指向规范地址、`robots.txt` 是否放行以及 JSON-LD 是否可正常解析。',
            '通过 Shopify、WordPress 等 L1 官方连接器完成发布并核验通过后，配合 IndexNow 通知可进一步缩短搜索引擎与 AI 检索发现新页面的周期。',
          ],
        },
      ],
    },
  },
  {
    slug: 'zero-ban-community-geo',
    publishedAt: '2026-11-24',
    updatedAt: '2026-11-24',
    readingMinutes: 6,
    en: {
      title: 'Zero-Ban Community GEO: Reddit, Quora, and Login-Free PR Media Kits',
      subtitle:
        'Earn durable third-party citations through human-reviewed community workflows and transparent PR/KOL briefing links.',
      description:
        'Why automated astroturfing destroys brand trust in AI search, how preflight compliance gates prevent risky phrasing, and how teams coordinate external contributors safely.',
      category: 'Distribution & Compliance',
      tags: ['Preflight Gate', 'Community Playbook', 'PR Media Kit'],
      keyTakeaways: [
        'Never use automated bots or disguised burner accounts on community platforms—permanent domain bans wipe out long-term citation equity.',
        'Run every master draft and channel variant through automated preflight gates checking [TBD] slots, unverified hype claims, and cross-market language leaks.',
        'Use 30-day read-only PR Media Kits to brief external journalists, editors, and KOLs without sharing internal workspace credentials.',
      ],
      sections: [
        {
          id: 'compliance-boundary',
          heading: '1. Why Automated Astroturfing Destroys Citation Equity',
          paragraphs: [
            'AI answer engines heavily weight authentic community threads on Reddit, Quora, and vertical forums because human debates surface real trade-offs. Attempting to game those channels with headless browser scripts or undisclosed shill accounts routinely ends in moderator bans, domain blacklists, and negative threads that persist in AI answers for years.',
            'GeoMix draws a strict engineering boundary: owned CMS sites use official L1 APIs, while third-party communities use L3 human-in-the-loop checklists and channel-native copy packs.',
          ],
        },
        {
          id: 'preflight-gate-rules',
          heading: '2. Dual-Track Preflight Gating Before Any Release',
          paragraphs: [
            'Before exporting a variant for a community moderator, PR partner, or owned blog, pass it through automated preflight checks. Catching compliance mistakes locally prevents embarrassing retractions and wasted publishing cycles.',
          ],
          bullets: [
            'Unresolved [TBD] blockers: Hard-blocks export whenever placeholder tokens remain in specifications or pricing paragraphs.',
            'Unsubstantiated hype warnings: Flags absolute superlatives (“world’s best”, “100% guaranteed”) that lack an attached proof source.',
            'Cross-market language leak detection: Flags stray CJK characters inside Global English deliverables so international pages stay native.',
          ],
        },
        {
          id: 'channel-native-checklists',
          heading: '3. Channel-Native Checklists for Reddit, Quora, and CN Communities',
          paragraphs: [
            'Each community enforces distinct norms around self-disclosure, link placement, and formatting. Rather than copy-pasting a blog post verbatim, adapt the master draft into a concise, helpful response tailored to the thread’s technical question.',
          ],
          bullets: [
            'Lead with a neutral framework or side-by-side specification table before mentioning your own product.',
            'Disclose affiliation transparently when answering as a brand engineer or founder.',
            'Cite reproducible measurements, documentation links, or open benchmarks instead of promotional landing pages.',
          ],
        },
        {
          id: 'login-free-pr-kits',
          heading: '4. Coordinating External Editors with 30-Day Login-Free PR Media Kits',
          paragraphs: [
            'External PR agencies, trade journalists, and KOL partners rarely want another SaaS login—and security teams do not want external contractors inside an internal workspace. GeoMix generates a scoped, read-only PR Media Kit link valid for 30 days containing approved copy angles, verified brand facts, and media assets.',
            'Because the link is read-only and revocable, partner distribution scales cleanly while keeping tenant credentials and unpublished drafts isolated.',
          ],
        },
      ],
    },
    zh: {
      title: '零封号社区 GEO 与免登录 PR/KOL 协作实践',
      subtitle:
        '坚持人工合规审核与免登录供稿单协作，在不触碰平台红线的前提下积累高权重第三方信源。',
      description:
        '解析为何自动化水军刷帖会摧毁品牌长期 AI 信誉，以及如何通过发布前门禁校验、社区原生清单与 30 天只读 PR/KOL 供稿单安全放大分发声量。',
      category: '合规分发',
      tags: ['发布前门禁', '社区合规', 'PR 供稿单'],
      keyTakeaways: [
        '严禁对第三方社区使用自动化刷帖或隐藏身份控评脚本，域名一旦被社区拉黑，负面记录会长期留在 AI 回答中。',
        '所有渠道变体在导出前必须通过发布门禁，统一拦截 [TBD] 占位符、无依据夸大词与跨市场语种泄漏。',
        '使用 30 天有效免登录只读 PR/KOL 供稿单与外部编辑协作，既降低沟通摩擦又保障租户后台权限隔离。',
      ],
      sections: [
        {
          id: 'compliance-boundary',
          heading: '一、为什么自动化刷帖会反噬品牌 AI 引用资产',
          paragraphs: [
            '主流 AI 问答引擎高度看重 Reddit、Quora 及垂类专业社区中的真实讨论，因为用户实测与理性对比具有极高的信息熵。如果试图用自动化脚本批量发帖或伪装普通用户控评，不仅极易触发平台封号与域名拉黑，由此引发的负面吐槽还会被模型长期收录引用。',
            'GeoMix 在架构层明确划清合规边界：自有官网与 CMS 通过官方 L1 API 发布，第三方社区始终采用 L3 人工合规检查清单与原生改写素材包，绝不提供自动化水军发帖能力。',
          ],
        },
        {
          id: 'preflight-gate-rules',
          heading: '二、发布前双轨合规门禁：把风险挡在上线之前',
          paragraphs: [
            '无论是发往自有博客还是交付给社区运营与外部媒体，成稿导出前都会经过自动化的发布前门禁检测，将常见低级失误和合规隐患提前暴露并修复。',
          ],
          bullets: [
            '[TBD] 未填阻断：只要正文中仍残留未补齐的参数占位符，系统直接阻断交付，防止半成品流入线上。',
            '夸大与绝对化预警：自动标记缺少依据的极限宣传词与无来源结论，提醒作者替换为核验事实或可复现条件。',
            '跨市场语种泄漏检测：在海外英文交付稿中自动识别误混入的中文字符，避免影响专业度与检索匹配。',
          ],
        },
        {
          id: 'channel-native-checklists',
          heading: '三、Reddit、Quora 与国内专业社区的原生适配清单',
          paragraphs: [
            '每个社区对身份披露、外链放置与篇幅结构都有明确规范。直接把官网长文原文照搬到讨论区往往效果不佳，应基于母稿事实卡派生贴合语境的精简回答。',
          ],
          bullets: [
            '先给出中立的选型维度与客观参数对比表，再说明自身产品的适用场景与边界。',
            '以品牌工程师或产品负责人身份参与讨论时，坦诚标注所属身份，赢得版主与读者信任。',
            '优先附上技术文档、公开评测方法或可复现规格链接，减少纯营销落地页跳转。',
          ],
        },
        {
          id: 'login-free-pr-kits',
          heading: '四、用 30 天免登录 PR/KOL 供稿单高效联动外部媒体',
          paragraphs: [
            '外部 PR 顾问、行业编辑和 KOL 伙伴通常不愿为单次合作注册新系统，企业安全团队也希望避免把内部工作台账号直接外发。GeoMix 支持一键生成 30 天有效的只读供稿单链接，集中呈现核验后的核心卖点、品牌事实卡摘要与合规配图。',
            '供稿单默认只读且随时可管控失效，让外部合作方即开即用，同时确保内部草稿、历史账本与凭据零暴露。',
          ],
        },
      ],
    },
  },
  {
    slug: 't7-t14-t30-attribution',
    publishedAt: '2026-11-24',
    updatedAt: '2026-11-24',
    readingMinutes: 7,
    en: {
      title: 'Measuring Real GEO Impact with T+1 Crawl Probes & T+7/14/30 Retests',
      subtitle:
        'Connect every published article to crawl verification, stepped citation retests, and predictable points budgeting.',
      description:
        'How to separate technical indexing errors on Day 1 from AI retrieval stabilization at T+7, T+14, and T+30, while controlling LLM variance with 1-sample vs 3-sample runs.',
      category: 'Attribution & ROI',
      tags: ['T+1 CrawlProbe', 'T+7/14/30 Retests', 'Budget Control'],
      keyTakeaways: [
        'Run a free T+1 CrawlProbe first—never burn monitoring points on a page that returns HTTP 404, blocks crawlers, or ships broken JSON-LD.',
        'Evaluate citation lift across three checkpoints (T+7 initial discovery, T+14 retrieval stabilization, T+30 durable citation share).',
        'Use 1-sample retests for broad monthly tracking and 3-sample runs on flagship prompts where LLM response variance matters most.',
      ],
      sections: [
        {
          id: 't1-crawl-probe',
          heading: '1. Day-1 Sanity Check: T+1 CrawlProbe Before Waiting on AI Engines',
          paragraphs: [
            'When a newly published guide fails to appear in AI answers two weeks later, teams often blame copy quality when the real culprit was a misconfigured canonical tag, a staging `noindex` header, or malformed JSON-LD.',
            'GeoMix runs a rate-limited T+1 CrawlProbe at zero point cost to confirm HTTP 200 reachability, canonical alignment, robots accessibility, and parseable Schema markup right after release.',
          ],
        },
        {
          id: 'stepped-retest-windows',
          heading: '2. Why Attribution Requires T+7, T+14, and T+30 Checkpoints',
          paragraphs: [
            'AI search engines update live web retrieval layers and synthesis rankings at different cadences. A single snapshot 48 hours after publication produces noisy false negatives.',
          ],
          bullets: [
            'T+7 (Initial Indexing): Confirms whether fast-retrieval engines such as Perplexity and web-enabled ChatGPT pick up the new URL.',
            'T+14 (Retrieval Stabilization): Measures whether owned-domain citations hold steady once competing pages refresh.',
            'T+30 (Durable Citation Share): Separates transient novelty spikes from lasting authority gains that justify scaling a topic cluster.',
          ],
        },
        {
          id: 'variance-and-budgeting',
          heading: '3. Controlling Variance with 1-Sample vs 3-Sample Schedules',
          paragraphs: [
            'Because generative models are probabilistic, a borderline prompt may cite a page on two out of three runs. Use 1-sample mode to monitor broad long-tail prompt libraries economically at 2 points per engine run, and switch flagship commercial prompts to 3-sample mode to verify consistency.',
            'All retest schedules calculate exact point exposure upfront (`articles × 3 checkpoints × engines × samples × 2 pts`) and automatically refund failed or timed-out engine calls so budgets stay auditable.',
          ],
        },
        {
          id: 'closing-the-optimization-loop',
          heading: '4. Closing the Loop on Missed Prompts',
          paragraphs: [
            'If a URL passes T+1 CrawlProbe cleanly but remains MENTIONED or COMPETITOR at T+14, compare the winning competitor’s cited excerpt against your own page. Update missing specifications in your Brand Fact Card and use zero-point Targeted Section Rewrites to tighten the opening answer block or comparison table.',
            'Republish via your L1 connector and let the T+30 checkpoint verify whether the structural fix converted the prompt into an owned citation.',
          ],
        },
      ],
    },
    zh: {
      title: 'T+1 抓取体检与 T+7/14/30 归因复测方法论',
      subtitle:
        '打通发布验收、分阶段引用复测与透明点数预算，让每一篇 GEO 内容的效果都可归因、可复盘。',
      description:
        '详解如何先通过免费 T+1 抓取体检排除技术抓取故障，再依托 T+7、T+14、T+30 三次阶梯复测与 1/3 采样策略量化真实的 AI 引用率提升。',
      category: '归因复测',
      tags: ['T+1 抓取体检', 'T+7/14/30 复测', '预算可控'],
      keyTakeaways: [
        '先跑免费的 T+1 抓取体检，确保状态码、Canonical、robots 与 JSON-LD 无误，再把监测点数用在有效页面上。',
        '通过 T+7 首次召回、T+14 检索稳定与 T+30 持久引用三档窗口，避免因单次快照波动误判效果。',
        '日常长尾词集用单次采样控制预算，核心高价值商机词用 3 次采样平滑大模型回答随机性。',
      ],
      sections: [
        {
          id: 't1-crawl-probe',
          heading: '一、T+1 抓取体检：先排除技术障碍，再谈引用归因',
          paragraphs: [
            '很多团队在文章上线两周后发现 AI 未引用，第一反应是怀疑文案质量，结果排查才发现是页面误加了 `noindex`、Canonical 指错地址或 JSON-LD 语法报错。',
            'GeoMix 在发布后自动提供 0 点标配的 T+1 抓取体检，第一时间验证线上页面 HTTP 200 可达性、Canonical 规范链接、爬虫放行状态与结构化数据可解析性。',
          ],
        },
        {
          id: 'stepped-retest-windows',
          heading: '二、为什么必须设置 T+7 / T+14 / T+30 三档复测窗口',
          paragraphs: [
            '不同 AI 引擎的联网索引刷新节奏与召回重排周期存在时间差，仅在发布后 48 小时测一次极易产生假阴性结论。',
          ],
          bullets: [
            'T+7（首次收录验证）：验证 Perplexity、联网搜索版 ChatGPT 等快速检索链路是否已捕获新链接。',
            'T+14（召回稳定观测）：观察新页面在多轮问答和竞品同步更新后，自有域名引用是否能够站稳。',
            'T+30（长效资产复盘）：区分短期新鲜度波动与可持续的权威引用份额，为下月扩量选题提供依据。',
          ],
        },
        {
          id: 'variance-and-budgeting',
          heading: '三、用 1 次采样 vs 3 次采样平衡随机性与点数预算',
          paragraphs: [
            '大模型生成结果天然存在一定概率波动，处于临界位置的页面可能在 3 次提问中被引用 2 次。建议对大批量长尾词采用 1 次采样（按 2 点/引擎/次计费）保持低成本覆盖，对决定转化的旗舰核心词开启 3 次采样观察稳定度。',
            '自动复测计划在启动前即可精确测算点数消耗（月发文数 × 3 档节点 × 监测引擎数 × 采样次数 × 2 点），且引擎超时或失败自动退还点数，确保团队预算全程透明可审计。',
          ],
        },
        {
          id: 'closing-the-optimization-loop',
          heading: '四、将未达标问题回流到事实卡与局部重写闭环',
          paragraphs: [
            '若文章已通过 T+1 抓取体检，但在 T+14 仍停留在 MENTIONED 或 COMPETITOR 状态，可直接对照竞品被引用的原文片段，找出缺失的参数维度或对比表结构。',
            '补齐品牌事实卡后，利用 0 点标配的「局部分段重写」定向优化首段直答与参数表格，重新发布并交由 T+30 节点验证优化是否成功转化为自有域名引用。',
          ],
        },
      ],
    },
  },
];

export function getMarketingGuideBySlug(slug: string): MarketingGuide | null {
  return MARKETING_GUIDES.find((guide) => guide.slug === slug) ?? null;
}
