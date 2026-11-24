import { z } from 'zod';
import { GEO_MARKETS, containsCjk, type GeoMarket } from './brands';
import type { GeoComplianceFlag } from './compliance';
import { extractMissingFactSlots } from './geo-studio';
import {
  SUPPORTED_LOCALE_CODES,
  detectLocaleLeakage,
  resolveEffectiveLocale,
  type SupportedLocale,
} from './locales';
import type { ConfidenceLevel, DifferenceInDifferencesResult, WilsonInterval } from './stats';

/**
 * GeoMix v2.1 / v2.2 全球多渠道分发、L1 站点连接、L2 Chrome 扩展桥接、发布前硬校验（Preflight）、
 * 外部 PR/KOL 协同包、T+1 爬虫体检与 T+7/14/30 定时复测契约（Issue #349 / #367）。
 */

export const CHANNEL_PROVIDERS = [
  'SHOPIFY',
  'WORDPRESS',
  'WEBFLOW',
  'WEBHOOK',
  'GHOST',
  'DEVTO',
  'HASHNODE',
  'GITHUB_MDX',
  'WECHAT_OFFICIAL',
  'ZHIHU_EXT',
  'TOUTIAO_EXT',
  'SMZDM_EXT',
  'REDDIT_ASSIST',
  'QUORA_ASSIST',
  'SOCIAL_THREAD_ASSIST',
  'PR_PACKET',
  'CN_COMMUNITY_ASSIST',
] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export const L1_CHANNEL_PROVIDERS = [
  'SHOPIFY',
  'WORDPRESS',
  'WEBFLOW',
  'WEBHOOK',
  'GHOST',
  'DEVTO',
  'HASHNODE',
  'GITHUB_MDX',
  'WECHAT_OFFICIAL',
] as const;
export type L1ChannelProvider = (typeof L1_CHANNEL_PROVIDERS)[number];

const L1_PROVIDER_SET = new Set<string>(L1_CHANNEL_PROVIDERS);

export function isL1ChannelProvider(value: string): value is L1ChannelProvider {
  return L1_PROVIDER_SET.has(value);
}

export const L2_EXTENSION_PROVIDERS = ['ZHIHU_EXT', 'TOUTIAO_EXT', 'SMZDM_EXT'] as const;
export type L2ExtensionProvider = (typeof L2_EXTENSION_PROVIDERS)[number];

const L2_EXTENSION_PROVIDER_SET = new Set<string>(L2_EXTENSION_PROVIDERS);

export function isL2ExtensionProvider(value: string): value is L2ExtensionProvider {
  return L2_EXTENSION_PROVIDER_SET.has(value);
}

export const CHANNEL_CONNECTION_STATUSES = ['ACTIVE', 'INVALID', 'DISABLED'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

export const DISTRIBUTION_MODES = [
  'L1_API',
  'L2_EXTENSION',
  'L3_COMMUNITY_ASSIST',
  'L3_PR_PACKET',
] as const;
export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];

export function defaultDistributionModeForProvider(provider: ChannelProvider): DistributionMode {
  if (isL1ChannelProvider(provider)) return 'L1_API';
  if (isL2ExtensionProvider(provider)) return 'L2_EXTENSION';
  if (provider === 'PR_PACKET') return 'L3_PR_PACKET';
  return 'L3_COMMUNITY_ASSIST';
}

export const DISTRIBUTION_TASK_STATUSES = [
  'DRAFT_VARIANT',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'DRAFT_PUSHED',
  'PUBLISHED',
  'FAILED',
  'ARCHIVED',
] as const;
export type DistributionTaskStatus = (typeof DISTRIBUTION_TASK_STATUSES)[number];

export const CRAWL_PROBE_STATUSES = ['PENDING', 'OK', 'WARNING', 'BLOCKED', 'FAILED'] as const;
export type CrawlProbeStatus = (typeof CRAWL_PROBE_STATUSES)[number];

export const RETEST_SCHEDULE_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'SKIPPED_INSUFFICIENT_POINTS',
  'SKIPPED_NO_ENGINE',
  'FAILED',
  'CANCELLED',
] as const;
export type RetestScheduleStatus = (typeof RETEST_SCHEDULE_STATUSES)[number];

export const DISTRIBUTION_TEMPLATE_KEYS = [
  'OWNED_BLOG_SEO_GEO',
  'DEVELOPER_TECH_POST',
  'WECHAT_OFFICIAL_ARTICLE',
  'REDDIT_DISCUSSION',
  'QUORA_ANSWER',
  'SOCIAL_THREAD',
  'PR_MEDIA_PACKET',
  'CN_COMMUNITY_QA',
] as const;
export type DistributionTemplateKey = (typeof DISTRIBUTION_TEMPLATE_KEYS)[number];

export function defaultTemplateKeyForProvider(provider: ChannelProvider): DistributionTemplateKey {
  switch (provider) {
    case 'SHOPIFY':
    case 'WORDPRESS':
    case 'WEBFLOW':
    case 'WEBHOOK':
    case 'GHOST':
      return 'OWNED_BLOG_SEO_GEO';
    case 'DEVTO':
    case 'HASHNODE':
    case 'GITHUB_MDX':
      return 'DEVELOPER_TECH_POST';
    case 'WECHAT_OFFICIAL':
      return 'WECHAT_OFFICIAL_ARTICLE';
    case 'ZHIHU_EXT':
    case 'TOUTIAO_EXT':
    case 'SMZDM_EXT':
    case 'CN_COMMUNITY_ASSIST':
      return 'CN_COMMUNITY_QA';
    case 'REDDIT_ASSIST':
      return 'REDDIT_DISCUSSION';
    case 'QUORA_ASSIST':
      return 'QUORA_ANSWER';
    case 'SOCIAL_THREAD_ASSIST':
      return 'SOCIAL_THREAD';
    case 'PR_PACKET':
      return 'PR_MEDIA_PACKET';
  }
}

export const DEFAULT_RETEST_MILESTONE_DAYS = [7, 14, 30] as const;
export const RETEST_SAMPLE_COUNTS = [1, 3] as const;
export type RetestSampleCount = (typeof RETEST_SAMPLE_COUNTS)[number];

export const CRAWL_PROBE_BOTS = [
  '*',
  'GPTBot',
  'OAI-SearchBot',
  'PerplexityBot',
  'Googlebot',
] as const;
export type CrawlProbeBot = (typeof CRAWL_PROBE_BOTS)[number];

export const DEFAULT_PR_SHARE_TTL_DAYS = 30 as const;

export const CHANNEL_PROVIDER_LABELS: Record<ChannelProvider, string> = {
  SHOPIFY: 'Shopify 博客',
  WORDPRESS: 'WordPress 站点',
  WEBFLOW: 'Webflow CMS',
  WEBHOOK: '通用签名 Webhook',
  GHOST: 'Ghost 博客',
  DEVTO: 'Dev.to 技术社区',
  HASHNODE: 'Hashnode 博客',
  GITHUB_MDX: 'GitHub MDX 仓库',
  WECHAT_OFFICIAL: '微信公众号草稿箱',
  ZHIHU_EXT: '知乎（Chrome 扩展）',
  TOUTIAO_EXT: '今日头条（Chrome 扩展）',
  SMZDM_EXT: '什么值得买（Chrome 扩展）',
  REDDIT_ASSIST: 'Reddit 社区讨论',
  QUORA_ASSIST: 'Quora 专业问答',
  SOCIAL_THREAD_ASSIST: '社媒长帖（X / LinkedIn）',
  PR_PACKET: 'PR / KOL 外部媒体协作包',
  CN_COMMUNITY_ASSIST: '中文社区问答 / 评测',
};

export const CHANNEL_PROVIDER_EN_LABELS: Record<ChannelProvider, string> = {
  SHOPIFY: 'Shopify Blog',
  WORDPRESS: 'WordPress Site',
  WEBFLOW: 'Webflow CMS',
  WEBHOOK: 'Signed Webhook',
  GHOST: 'Ghost Blog',
  DEVTO: 'Dev.to Community',
  HASHNODE: 'Hashnode Blog',
  GITHUB_MDX: 'GitHub MDX Repo',
  WECHAT_OFFICIAL: 'WeChat Official Drafts',
  ZHIHU_EXT: 'Zhihu (Chrome Extension)',
  TOUTIAO_EXT: 'Toutiao (Chrome Extension)',
  SMZDM_EXT: 'SMZDM (Chrome Extension)',
  REDDIT_ASSIST: 'Reddit Discussion',
  QUORA_ASSIST: 'Quora Q&A',
  SOCIAL_THREAD_ASSIST: 'Social Thread (X / LinkedIn)',
  PR_PACKET: 'PR / KOL Media Kit',
  CN_COMMUNITY_ASSIST: 'CN Community Q&A',
};

const ZH_TO_EN_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CHANNEL_PROVIDERS.map((provider) => [
    CHANNEL_PROVIDER_LABELS[provider],
    CHANNEL_PROVIDER_EN_LABELS[provider],
  ]),
);

const EN_TO_ZH_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CHANNEL_PROVIDERS.map((provider) => [
    CHANNEL_PROVIDER_EN_LABELS[provider].toLowerCase(),
    CHANNEL_PROVIDER_LABELS[provider],
  ]),
);

/**
 * 将面向外部的渠道标签按市场语言规整：
 * - GLOBAL 市场：将默认中文标签或含中文字符的内部默认标签映射为英文，避免海外公开页语言混杂；
 * - CN 市场：将默认英文标签映射为中文，自定义标签保持原样。
 */
export function localizePublicChannelLabel(
  channelLabel: string | null | undefined,
  market: GeoMarket,
  provider: ChannelProvider = 'PR_PACKET',
): string {
  const trimmed = typeof channelLabel === 'string' ? channelLabel.trim() : '';
  if (market === 'GLOBAL') {
    if (!trimmed) return CHANNEL_PROVIDER_EN_LABELS[provider];
    const mapped = ZH_TO_EN_CHANNEL_LABELS[trimmed];
    if (mapped) return mapped;
    if (containsCjk(trimmed)) return CHANNEL_PROVIDER_EN_LABELS[provider];
    return trimmed;
  }
  if (!trimmed) return CHANNEL_PROVIDER_LABELS[provider];
  const mappedCn = EN_TO_ZH_CHANNEL_LABELS[trimmed.toLowerCase()];
  if (mappedCn) return mappedCn;
  return trimmed;
}

export const DISTRIBUTION_TASK_STATUS_LABELS: Record<DistributionTaskStatus, string> = {
  DRAFT_VARIANT: '变体草稿',
  READY_TO_PUBLISH: '待发布',
  PUBLISHING: '推送中',
  DRAFT_PUSHED: '已推草稿',
  PUBLISHED: '已上线',
  FAILED: '推送失败',
  ARCHIVED: '已归档',
};

export const CRAWL_PROBE_STATUS_LABELS: Record<CrawlProbeStatus, string> = {
  PENDING: '待体检',
  OK: '可抓取',
  WARNING: '存在告警',
  BLOCKED: '抓取受阻',
  FAILED: '体检失败',
};

export const RETEST_SCHEDULE_STATUS_LABELS: Record<RetestScheduleStatus, string> = {
  PENDING: '待复测',
  RUNNING: '复测中',
  COMPLETED: '已完成',
  SKIPPED_INSUFFICIENT_POINTS: '点数不足已跳过',
  SKIPPED_NO_ENGINE: '无可用引擎已跳过',
  FAILED: '复测失败',
  CANCELLED: '已取消',
};

export function isSafeDistributionHttpUrl(raw: string): boolean {
  const val = raw.trim();
  if (!val || val.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(val)) return false;
  try {
    const parsed = new URL(val);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

// ==================== Zod Schemas (11 个核心校验契约) ====================

const webflowFieldMapSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    slug: z.string().trim().min(1).max(80).optional(),
    bodyHtml: z.string().trim().min(1).max(80).optional(),
    metaDesc: z.string().trim().min(1).max(80).optional(),
    jsonLd: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const channelConnectionConfigSchema = z
  .object({
    blogId: z.string().trim().min(1).max(200).optional(),
    blogHandle: z.string().trim().min(1).max(120).optional(),
    categoryIds: z.array(z.number().int().positive()).max(20).optional(),
    siteId: z.string().trim().min(1).max(200).optional(),
    collectionId: z.string().trim().min(1).max(200).optional(),
    fieldMap: webflowFieldMapSchema.optional(),
    publicationId: z.string().trim().min(1).max(200).optional(),
    repoOwner: z.string().trim().min(1).max(120).optional(),
    repoName: z.string().trim().min(1).max(120).optional(),
    branch: z.string().trim().min(1).max(120).optional(),
    contentDir: z.string().trim().min(1).max(240).optional(),
    fileExtension: z.enum(['mdx', 'md']).optional(),
    publicUrlTemplate: z.string().trim().min(1).max(512).optional(),
    author: z.string().trim().min(1).max(80).optional(),
    defaultCoverMediaId: z.string().trim().min(1).max(200).optional(),
    needOpenComment: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    defaultPublishAsDraft: z.boolean().optional(),
    inlineJsonLd: z.boolean().optional(),
    indexNowKey: z.string().trim().min(8).max(128).optional(),
    primaryDomain: z.string().trim().min(1).max(255).optional(),
    extraHeaders: z.record(z.string().trim().min(1).max(64), z.string().max(512)).optional(),
  })
  .passthrough();

export type ChannelConnectionConfig = z.infer<typeof channelConnectionConfigSchema>;

/** 1. 创建 L1 站点渠道连接 */
export const createChannelConnectionSchema = z
  .object({
    market: z.enum(GEO_MARKETS),
    provider: z.enum(L1_CHANNEL_PROVIDERS),
    displayName: z.string().trim().min(1, '请填写连接名称').max(80, '连接名称最多 80 个字符'),
    siteBaseUrl: z
      .string()
      .trim()
      .min(1, '请填写站点地址')
      .max(2048, '站点地址不能超过 2048 个字符')
      .refine(isSafeDistributionHttpUrl, '请输入有效的 http:// 或 https:// 站点地址'),
    credentials: z.record(
      z.string().min(1).max(64),
      z.string().trim().min(1, '凭据字段不能为空').max(4096),
    ),
    configJson: channelConnectionConfigSchema.optional().default({}),
    authType: z.enum(['API_KEY', 'OAUTH']).optional().default('API_KEY'),
    targetLocale: z.enum(SUPPORTED_LOCALE_CODES).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const creds = value.credentials;
    const requireField = (field: string, message: string) => {
      if (!creds[field] || creds[field].trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['credentials', field],
          message,
        });
      }
    };

    switch (value.provider) {
      case 'SHOPIFY':
        requireField('accessToken', '请填写 Shopify Admin API Access Token');
        break;
      case 'WORDPRESS':
        requireField('username', '请填写 WordPress 用户名');
        requireField('appPassword', '请填写 WordPress Application Password');
        break;
      case 'WEBFLOW':
        requireField('apiToken', '请填写 Webflow API Token');
        break;
      case 'WEBHOOK': {
        const secret = creds.signingSecret?.trim() ?? '';
        if (secret.length < 8) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['credentials', 'signingSecret'],
            message: 'Webhook 签名密钥长度至少为 8 位',
          });
        }
        break;
      }
      case 'GHOST': {
        const key = creds.adminApiKey?.trim() ?? '';
        if (!/^[^:\s]+:(?:[0-9a-fA-F]{2}){8,}$/.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['credentials', 'adminApiKey'],
            message: '请填写有效的 Ghost Admin API Key（格式为 id:hex_secret）',
          });
        }
        break;
      }
      case 'DEVTO':
        requireField('apiKey', '请填写 Dev.to API Key');
        break;
      case 'HASHNODE':
        requireField('apiToken', '请填写 Hashnode Personal Access Token');
        break;
      case 'GITHUB_MDX':
        requireField('token', '请填写 GitHub Personal Access Token');
        break;
      case 'WECHAT_OFFICIAL':
        requireField('appId', '请填写微信公众号 AppID');
        requireField('appSecret', '请填写微信公众号 AppSecret');
        break;
    }
  });

export type CreateChannelConnectionInput = z.infer<typeof createChannelConnectionSchema>;

/** 2. 更新 L1 站点渠道连接（空凭据或省略 credentials 时保留原密文） */
export const updateChannelConnectionSchema = z
  .object({
    displayName: z.string().trim().min(1, '请填写连接名称').max(80).optional(),
    siteBaseUrl: z
      .string()
      .trim()
      .min(1, '请填写站点地址')
      .max(2048)
      .refine(isSafeDistributionHttpUrl, '请输入有效的 http:// 或 https:// 站点地址')
      .optional(),
    credentials: z.record(z.string().min(1).max(64), z.string().max(4096)).optional(),
    configJson: channelConnectionConfigSchema.optional(),
    status: z.enum(CHANNEL_CONNECTION_STATUSES).optional(),
    targetLocale: z.enum(SUPPORTED_LOCALE_CODES).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一项连接配置',
  });

export type UpdateChannelConnectionInput = z.infer<typeof updateChannelConnectionSchema>;

/** 3. 连通性测试参数 */
export const testChannelConnectionSchema = z
  .object({
    siteId: z.string().trim().min(1).max(200).optional(),
    collectionId: z.string().trim().min(1).max(200).optional(),
  })
  .optional()
  .default({});

export type TestChannelConnectionInput = z.infer<typeof testChannelConnectionSchema>;

/** 4. 1→N 渠道变体批量生成请求 */
export const distributionVariantTargetSchema = z.object({
  provider: z.enum(CHANNEL_PROVIDERS),
  connectionId: z.string().trim().min(1).max(64).optional(),
  channelLabel: z.string().trim().min(1, '请填写渠道名称').max(80),
  targetLocale: z.enum(SUPPORTED_LOCALE_CODES).optional(),
  targetUrlHint: z
    .string()
    .trim()
    .max(2048)
    .refine(isSafeDistributionHttpUrl, '目标链接必须为有效的 http:// 或 https:// 地址')
    .optional(),
  templateKey: z.enum(DISTRIBUTION_TEMPLATE_KEYS).optional(),
  publishAsDraft: z.boolean().optional(),
});

export type DistributionVariantTargetInput = z.infer<typeof distributionVariantTargetSchema>;

export const createDistributionVariantsSchema = z.object({
  targets: z
    .array(distributionVariantTargetSchema)
    .min(1, '请至少选择 1 个目标渠道')
    .max(10, '单次最多同时生成 10 个渠道变体'),
});

export type CreateDistributionVariantsInput = z.infer<typeof createDistributionVariantsSchema>;

/** 5. 编辑单个分发变体任务 */
export const updateDistributionTaskSchema = z
  .object({
    variantTitle: z.string().trim().min(1, '标题不能为空').max(200).optional(),
    variantSlug: z
      .string()
      .trim()
      .max(160)
      .regex(/^[a-z0-9-]*$/i, 'Slug 仅支持字母、数字与连字符')
      .nullable()
      .optional(),
    variantMetaDesc: z.string().trim().max(320).nullable().optional(),
    variantMarkdown: z.string().max(100_000).optional(),
    variantHtml: z.string().max(150_000).optional(),
    channelLabel: z.string().trim().min(1).max(80).optional(),
    targetLocale: z.enum(SUPPORTED_LOCALE_CODES).nullable().optional(),
    targetUrlHint: z
      .string()
      .trim()
      .max(2048)
      .refine(isSafeDistributionHttpUrl, '目标链接必须为有效的 http:// 或 https:// 地址')
      .nullable()
      .optional(),
    publishAsDraft: z.boolean().optional(),
    connectionId: z.string().trim().min(1).max(64).nullable().optional(),
    status: z.enum(['DRAFT_VARIANT', 'READY_TO_PUBLISH', 'ARCHIVED']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一项分发任务字段',
  });

export type UpdateDistributionTaskInput = z.infer<typeof updateDistributionTaskSchema>;

/** 6. 触发 L1 API 推送（草稿 / 正式发布） */
export const publishDistributionTaskSchema = z
  .object({
    publishAsDraft: z.boolean().optional(),
    connectionId: z.string().trim().min(1).max(64).optional(),
    acknowledgePreflightWarnings: z.boolean().optional().default(false),
  })
  .optional()
  .default({});

export type PublishDistributionTaskInput = z.infer<typeof publishDistributionTaskSchema>;

/** 7. 生成外部 PR/KOL 只读分享链接 */
export const createPrShareLinkSchema = z
  .object({
    ttlDays: z.number().int().min(1).max(90).optional().default(DEFAULT_PR_SHARE_TTL_DAYS),
  })
  .optional()
  .default({});

export type CreatePrShareLinkInput = z.infer<typeof createPrShareLinkSchema>;

/** 8. 外部 PR/KOL 回传已上线链接 */
export const publicPrPacketSubmitSchema = z.object({
  publishedUrl: z
    .string()
    .trim()
    .min(1, '请输入已上线文章链接')
    .max(2048, '链接长度不能超过 2048 个字符')
    .refine(isSafeDistributionHttpUrl, '请输入有效的 http:// 或 https:// 公开网页链接'),
  note: z.string().trim().max(300).optional(),
});

export type PublicPrPacketSubmitInput = z.infer<typeof publicPrPacketSubmitSchema>;

/** 9. T+1 AI 爬虫可读性体检报告 */
export const crawlProbeBotResultSchema = z.object({
  bot: z.enum(CRAWL_PROBE_BOTS),
  allowed: z.boolean(),
  matchedRule: z.string().optional(),
});

export type CrawlProbeBotResult = z.infer<typeof crawlProbeBotResultSchema>;

export const crawlProbeReportSchema = z.object({
  checkedUrl: z.string().min(1),
  finalUrl: z.string().optional(),
  httpStatus: z.number().int().min(0).max(599).nullable(),
  robotsTxtFound: z.boolean(),
  robotsMatrix: z.array(crawlProbeBotResultSchema),
  metaNoindex: z.boolean(),
  jsonLdTypes: z.array(z.string()),
  jsonLdParseErrors: z.array(z.string()),
  canonicalUrl: z.string().nullable().optional(),
  canonicalMatches: z.boolean().nullable().optional(),
  issues: z.array(z.string()),
  errorMessage: z.string().optional(),
});

export type CrawlProbeReport = z.infer<typeof crawlProbeReportSchema>;

/** 10. 定时复测计划配置（T+7/14/30，单次 1 或 3 采样） */
export const retestScheduleConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    milestones: z
      .array(z.number().int().min(1).max(365))
      .min(1, '请至少配置 1 个复测节点')
      .max(6, '最多配置 6 个复测节点')
      .transform((days) => [...new Set(days)].sort((a, b) => a - b))
      .optional(),
    sampleCount: z.union([z.literal(1), z.literal(3)]).optional(),
    includeControlPrompts: z.boolean().optional(),
    cancelMilestoneDays: z.array(z.number().int().min(1).max(365)).max(6).optional(),
  })
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.milestones !== undefined ||
      value.sampleCount !== undefined ||
      value.includeControlPrompts !== undefined ||
      value.cancelMilestoneDays !== undefined,
    { message: '至少修改一项复测计划配置' },
  );

export type RetestScheduleConfigInput = z.infer<typeof retestScheduleConfigSchema>;

/** 11. 发布前硬校验（Preflight）结果 */
export const PREFLIGHT_ITEM_CODES = [
  'MISSING_FACT_SLOTS',
  'GLOBAL_CJK_LEAK',
  'COMPLIANCE_BLOCKED',
  'GLOBAL_CLAIM_WARNING',
  'LOW_GEO_SCORE',
  'MISSING_FACT_CARDS',
  'MISSING_META_DESCRIPTION',
  'MISSING_SLUG',
] as const;
export type PreflightItemCode = (typeof PREFLIGHT_ITEM_CODES)[number];

export const GLOBAL_PREFLIGHT_CLAIM_CATEGORIES = ['medical', 'financial', 'superlative'] as const;
export type GlobalPreflightClaimCategory = (typeof GLOBAL_PREFLIGHT_CLAIM_CATEGORIES)[number];

export const distributionPreflightMatchSchema = z.object({
  term: z.string().min(1),
  matchedText: z.string().min(1),
  category: z.enum(GLOBAL_PREFLIGHT_CLAIM_CATEGORIES),
  line: z.number().int().min(1),
  excerpt: z.string().min(1),
});
export type DistributionPreflightMatch = z.infer<typeof distributionPreflightMatchSchema>;

export const distributionPreflightItemSchema = z.object({
  code: z.enum(PREFLIGHT_ITEM_CODES),
  severity: z.enum(['blocker', 'warning']),
  message: z.string().min(1),
  details: z.array(z.string()).optional(),
  matches: z.array(distributionPreflightMatchSchema).optional(),
});

export type DistributionPreflightItem = z.infer<typeof distributionPreflightItemSchema>;

export const distributionPreflightResultSchema = z.object({
  ok: z.boolean(),
  blockers: z.array(distributionPreflightItemSchema),
  warnings: z.array(distributionPreflightItemSchema),
});

export type DistributionPreflightResult = z.infer<typeof distributionPreflightResultSchema>;

export const GEO_VARIANT_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type GeoVariantJobStatus = (typeof GEO_VARIANT_JOB_STATUSES)[number];

export type GeoVariantJobFailureItem = {
  index: number;
  provider: ChannelProvider;
  channelLabel: string;
  templateKey: DistributionTemplateKey;
  error: string;
};

export type GeoVariantJobDto = {
  id: string;
  articleId: string;
  brandId: string;
  brandMarketId: string;
  status: GeoVariantJobStatus;
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  totalChargedPoints: number;
  refundedCount: number;
  refundedPoints: number;
  reservationId: string | null;
  billingMode: 'SHADOW' | 'STRICT' | 'FREE';
  replayed: boolean;
  taskIds: string[];
  failures: GeoVariantJobFailureItem[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

// ==================== 安全 DTO 定义（零明文凭据 / 零内部 tokenHash） ====================

export type ChannelConnectionDto = {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  provider: ChannelProvider;
  displayName: string;
  siteBaseUrl: string;
  credentialHint: string;
  configJson: Record<string, unknown>;
  status: ChannelConnectionStatus;
  authType: string;
  targetLocale?: SupportedLocale | null;
  externalShopDomain?: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelRemoteTargetDto = {
  id: string;
  name: string;
  handle?: string;
  url?: string;
  meta?: Record<string, unknown>;
};

export type ChannelConnectionTestResultDto = {
  ok: boolean;
  status: ChannelConnectionStatus;
  message: string;
  testedAt: string;
  targets?: ChannelRemoteTargetDto[];
};

export type GeoDistributionTaskDto = {
  id: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  connectionId: string | null;
  provider: ChannelProvider;
  mode: DistributionMode;
  channelLabel: string;
  targetLocale?: SupportedLocale | null;
  targetUrlHint: string | null;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Record<string, unknown>;
  preflightJson: DistributionPreflightResult | null;
  status: DistributionTaskStatus;
  publishAsDraft: boolean;
  remotePostId: string | null;
  remoteAdminUrl: string | null;
  remotePublishedUrl: string | null;
  indexNowStatus: string | null;
  lastError: string | null;
  shareLinkActive: boolean;
  shareExpiresAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeoRetestMetricsSnapshot = {
  mentionRate: number;
  avgPosition: number | null;
  sentiment: string | null;
  citationHit: boolean;
  sampleCount?: number;
  hitCount?: number;
  wilson?: WilsonInterval;
  confidenceLevel?: ConfidenceLevel;
};

export type GeoRetestControlMetricsSnapshot = {
  controlPrompts: string[];
  baselineMentionRate: number | null;
  currentMentionRate: number;
  sampleCount: number;
  hitCount: number;
  wilson?: WilsonInterval;
  did?: DifferenceInDifferencesResult | null;
};

export type GeoRetestScheduleDto = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: RetestSampleCount;
  includeControlPrompts?: boolean;
  dueAt: string;
  status: RetestScheduleStatus;
  visibilityRunId: string | null;
  metricsSnapshot: GeoRetestMetricsSnapshot | null;
  controlMetricsJson?: GeoRetestControlMetricsSnapshot | null;
  skipReason: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DistributionCrawlAlertItem = {
  publishRecordId: string;
  articleId: string;
  articleTitle: string;
  channel: string;
  publishedUrl: string;
  crawlStatus: CrawlProbeStatus;
  crawlCheckedAt: string | null;
  issues: string[];
};

export type DistributionUpcomingRetestItem = {
  scheduleId: string;
  publishRecordId: string;
  articleId: string;
  articleTitle: string;
  channel: string;
  milestoneDay: number;
  sampleCount: RetestSampleCount;
  dueAt: string;
  status: RetestScheduleStatus;
  skipReason: string | null;
};

export type DistributionChannelAttributionItem = {
  channel: string;
  publishedCount: number;
  crawlOkCount: number;
  completedRetestCount: number;
  citationHitCount: number;
  citationHitRate: number | null;
  citationHitWilson?: WilsonInterval | null;
  avgMentionRateDelta: number | null;
  avgPosition: number | null;
  avgPositionDelta: number | null;
  positiveSentimentRate: number | null;
  sentimentSummary: string | null;
};

export type DistributionSummaryDto = {
  crawlAlerts: DistributionCrawlAlertItem[];
  upcomingRetests: DistributionUpcomingRetestItem[];
  channelAttribution: DistributionChannelAttributionItem[];
};

export type PublicPrPacketDto = {
  market: GeoMarket;
  locale: string;
  brandName: string;
  category: string;
  channelLabel: string;
  suggestedTitle: string;
  targetPrompt: string;
  targetFanOuts: string[];
  keyAngles: string[];
  verifiedFacts: Array<{ title: string; summary: string }>;
  draftMarkdown: string;
  draftHtml: string;
  status: DistributionTaskStatus;
  submittedUrl: string | null;
  expiresAt: string;
};

export type PublicPrPacketSubmitResultDto = {
  accepted: boolean;
  publishedUrl: string;
  submittedAt: string;
  alreadyRecorded: boolean;
};

// ==================== 发布前硬校验纯函数（evaluateDistributionPreflight） ====================

export type GlobalPreflightClaimRule = {
  id: string;
  label: string;
  category: GlobalPreflightClaimCategory;
  severity: 'blocker' | 'warning';
  pattern: RegExp;
};

export type EvaluateDistributionPreflightInput = {
  market: GeoMarket;
  targetLocale?: SupportedLocale | string | null;
  title: string;
  contentMarkdown: string;
  variantHtml?: string | null;
  brandNames?: readonly string[];
  complianceFlags?: readonly GeoComplianceFlag[];
  geoScore?: number | null;
  matchedFactCount?: number | null;
  provider?: ChannelProvider | null;
  variantSlug?: string | null;
  variantMetaDesc?: string | null;
  globalClaimRules?: readonly GlobalPreflightClaimRule[];
};

const HTML_ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([a-zA-Z]{2,12});)/g;

const HTML_BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'hr',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'dd',
  'dt',
  'dl',
  'figure',
  'figcaption',
]);

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  colon: ':',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiTagNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45;
}

function stripHtmlTagsLinear(html: string): string {
  const out: string[] = [];
  const len = html.length;
  let i = 0;
  let cachedGt = -1;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) {
      out.push(html.slice(i, lt));
    }
    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) {
        break;
      }
      i = endComment + 3;
      continue;
    }
    if (cachedGt <= lt) {
      cachedGt = html.indexOf('>', lt + 1);
    }
    if (cachedGt === -1) {
      out.push(html.slice(lt));
      break;
    }

    // HTML5 §13.2.5.6 (Tag open state), aligned with sanitizeRichArticleHtml's replaceHtmlTagsLinear:
    // `<` only opens a tag when immediately followed by an ASCII letter (or `/` + ASCII letter),
    // with an ASCII tag name terminated by `>`, `/`, or whitespace.
    let p = lt + 1;
    if (p < cachedGt && html.charCodeAt(p) === 47) {
      p += 1;
    }
    if (p >= cachedGt || !isAsciiLetter(html.charCodeAt(p))) {
      out.push('<');
      i = lt + 1;
      continue;
    }

    const nameStart = p;
    p += 1;
    while (p < cachedGt && isAsciiTagNameChar(html.charCodeAt(p))) {
      p += 1;
    }

    const validBoundary = p === cachedGt || html.charCodeAt(p) === 47 || html.charCodeAt(p) <= 32;
    if (!validBoundary) {
      out.push('<');
      i = lt + 1;
      continue;
    }

    const tagName = html.slice(nameStart, p).toLowerCase();
    if (HTML_BLOCK_TAGS.has(tagName)) {
      out.push('\n');
    }
    i = cachedGt + 1;
  }
  return out.join('');
}

function decodeNumericCodePoint(code: number, match: string): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
    return match;
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    return '\uFFFD';
  }
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    HTML_ENTITY_RE,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex) {
        const trimmed = hex.replace(/^0+/, '') || '0';
        if (trimmed.length <= 6) {
          return decodeNumericCodePoint(Number.parseInt(trimmed, 16), match);
        }
        return match;
      }
      if (dec) {
        const trimmed = dec.replace(/^0+/, '') || '0';
        if (trimmed.length <= 7) {
          return decodeNumericCodePoint(Number.parseInt(trimmed, 10), match);
        }
        return match;
      }
      if (named) {
        const key = named.toLowerCase();
        if (Object.hasOwn(NAMED_HTML_ENTITIES, key)) {
          const mapped = NAMED_HTML_ENTITIES[key];
          if (mapped !== undefined) {
            return mapped;
          }
        }
      }
      return match;
    },
  );
}

/**
 * 将富文本 HTML 提取为纯文本，用于发前硬校验（未补全事实槽位、GLOBAL 中文泄漏、合规违禁词扫描）。
 * - 线性 O(N) 单遍扫描（零正则回溯风险）：块级标签转换行，内联标签无缝剥离（防止通过 `<span>` 拆字绕过扫描）
 * - 单遍解码标准命名与数字 HTML 实体（防止 `&#91;TBD&#93;` 等实体编码绕过）
 */
export function extractPlainTextFromHtml(html: string | null | undefined): string {
  if (!html || !html.trim()) return '';
  const strippedTags = stripHtmlTagsLinear(html);
  const decoded = decodeHtmlEntities(strippedTags);
  return decoded
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const GLOBAL_CLAIM_CATEGORY_LABELS: Record<GlobalPreflightClaimCategory, string> = {
  medical: '医疗/夸大疗效',
  financial: '金融/保本收益',
  superlative: '绝对化/最佳宣称',
};

const STRUCTURAL_HASH_ONE_PREFIX_RE =
  /\b(?:issue|step|item|part|option|tip|figure|table|method|test|case|rule|point|note|row|line|section|chapter|question|example|sample|tier|phase|stage|batch|slot|post|thread|comment|pr|pull\s+request|ticket|bug|task|article|chapter|model|unit|version|slot)\s*$/i;

/**
 * GLOBAL 市场发布前门禁违禁/高风险夸大宣称默认词典（可通过 input.globalClaimRules 覆盖/扩展）：
 * - blocker（硬阻断）：医疗夸大疗效（cure-all / miracle / guaranteed to cure / 100% safe / zero side effects）、
 *   金融保本承诺（guaranteed profit/return / risk-free return / get rich quick）
 * - warning（软警告）：无佐证绝对化/最佳宣称（guaranteed / risk-free / #1 / number-one / clinically proven 等）
 */
export const GLOBAL_PREFLIGHT_CLAIM_RULES: readonly GlobalPreflightClaimRule[] = [
  // Medical / health deceptive hard blockers
  {
    id: 'medical-cure-all',
    label: 'cure-all',
    category: 'medical',
    severity: 'blocker',
    pattern: /\bcure(?:[\s-]+all|all)\b/gi,
  },
  {
    id: 'medical-miracle-cure',
    label: 'miracle cure',
    category: 'medical',
    severity: 'blocker',
    pattern: /\bmiracle[\s-]+(?:cure|pill|drug|remedy|formula|treatment|solution)\b/gi,
  },
  {
    id: 'medical-miracle',
    label: 'miracle',
    category: 'medical',
    severity: 'blocker',
    pattern: /\bmiracle\b/gi,
  },
  {
    id: 'medical-guaranteed-cure',
    label: 'guaranteed to cure',
    category: 'medical',
    severity: 'blocker',
    pattern: /\bguaranteed\s+to\s+(?:cure|heal|treat|prevent|eliminate)\b/gi,
  },
  {
    id: 'medical-cures-disease',
    label: 'cures disease',
    category: 'medical',
    severity: 'blocker',
    pattern: /\bcures?\s+(?:cancer|diabetes|alzheimer'?s|arthritis|depression|diseases?)\b/gi,
  },
  {
    id: 'medical-100-safe',
    label: '100% safe / effective',
    category: 'medical',
    severity: 'blocker',
    pattern:
      /\b100(?:\s*%|[\s-]+percent)\s*(?:safe|effective|guaranteed|risk[\s-]+free|cure|natural\s+cure)\b/gi,
  },
  {
    id: 'medical-zero-side-effects',
    label: 'zero side effects',
    category: 'medical',
    severity: 'blocker',
    pattern: /\b(?:zero|no)\s+side[\s-]+effects?\b/gi,
  },
  // Financial deceptive hard blockers
  {
    id: 'financial-guaranteed-return',
    label: 'guaranteed return / profit',
    category: 'financial',
    severity: 'blocker',
    pattern:
      /\bguaranteed\s+(?:\d+(?:\.\d+)?%\s+)?(?:profits?|returns?|income|roi|wealth|earnings?|payouts?)\b/gi,
  },
  {
    id: 'financial-risk-free-return',
    label: 'risk-free return / investment',
    category: 'financial',
    severity: 'blocker',
    pattern:
      /\b(?:risk|zero)[\s-]+(?:free|risk)\s+(?:guaranteed\s+)?(?:returns?|profits?|investments?|income|gains?)\b/gi,
  },
  {
    id: 'financial-get-rich-quick',
    label: 'get-rich-quick',
    category: 'financial',
    severity: 'blocker',
    pattern: /\bget[\s-]+rich[\s-]+quick\b/gi,
  },
  // Superlative / unsubstantiated absolute claim warnings
  {
    id: 'superlative-risk-free',
    label: 'risk-free',
    category: 'superlative',
    severity: 'warning',
    pattern: /\brisk[\s-]+free\b/gi,
  },
  {
    id: 'superlative-guaranteed',
    label: 'guaranteed',
    category: 'superlative',
    severity: 'warning',
    pattern: /\bguaranteed\b/gi,
  },
  {
    id: 'superlative-hash-one',
    label: '#1',
    category: 'superlative',
    severity: 'warning',
    pattern: /#\s*1(?![\d.])|\b(?:number[\s-]+one|no\.\s*1)\b/gi,
  },
  {
    id: 'superlative-unsubstantiated-proven',
    label: 'clinically / scientifically proven',
    category: 'superlative',
    severity: 'warning',
    pattern: /\b(?:clinically|scientifically)\s+proven\b/gi,
  },
];

type GlobalClaimScanHit = {
  rule: GlobalPreflightClaimRule;
  match: DistributionPreflightMatch;
  sectionLabel: string;
};

function buildClaimExcerpt(lineText: string, start: number, end: number): string {
  const maxLen = 72;
  const trimmed = lineText.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const half = Math.floor((maxLen - (end - start)) / 2);
  const sliceStart = Math.max(0, start - Math.max(12, half));
  const sliceEnd = Math.min(lineText.length, Math.max(end + 12, sliceStart + maxLen));
  const prefix = sliceStart > 0 ? '…' : '';
  const suffix = sliceEnd < lineText.length ? '…' : '';
  return `${prefix}${lineText.slice(sliceStart, sliceEnd).trim()}${suffix}`;
}

function scanSectionForGlobalClaims(
  text: string,
  sectionLabel: string,
  rules: readonly GlobalPreflightClaimRule[],
): GlobalClaimScanHit[] {
  if (!text.trim()) return [];
  const hits: GlobalClaimScanHit[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const lineText = lines[lineIdx] ?? '';
    if (!lineText.trim()) continue;

    const candidates: Array<{
      rule: GlobalPreflightClaimRule;
      start: number;
      end: number;
      matchedText: string;
    }> = [];

    for (const rule of rules) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const matchedText = m[0];
        const start = m.index;
        const end = start + matchedText.length;

        // Avoid false positives on structural enumerations like "Step #1", "Item #1", "Issue #1", "Figure #1"
        if (matchedText.startsWith('#')) {
          const before = lineText.slice(Math.max(0, start - 32), start);
          if (STRUCTURAL_HASH_ONE_PREFIX_RE.test(before)) {
            continue;
          }
          // Require non-word boundary before '#' (avoid matching inside URLs/anchors like foo#1)
          if (start > 0 && /[\w/]/.test(lineText[start - 1]!)) {
            continue;
          }
        }

        candidates.push({ rule, start, end, matchedText });
      }
    }

    if (candidates.length === 0) continue;

    // Prefer blocker over warning, then longer span over shorter span, then earlier index
    candidates.sort((a, b) => {
      const sevDiff =
        (a.rule.severity === 'blocker' ? 0 : 1) - (b.rule.severity === 'blocker' ? 0 : 1);
      if (sevDiff !== 0) return sevDiff;
      const lenDiff = b.end - b.start - (a.end - a.start);
      if (lenDiff !== 0) return lenDiff;
      return a.start - b.start;
    });

    const acceptedSpans: Array<{ start: number; end: number }> = [];
    for (const cand of candidates) {
      const overlaps = acceptedSpans.some((span) => cand.start < span.end && cand.end > span.start);
      if (overlaps) continue;
      acceptedSpans.push({ start: cand.start, end: cand.end });
      hits.push({
        rule: cand.rule,
        sectionLabel,
        match: {
          term: cand.matchedText,
          matchedText: cand.matchedText,
          category: cand.rule.category,
          line: lineIdx + 1,
          excerpt: buildClaimExcerpt(lineText, cand.start, cand.end),
        },
      });
    }
  }

  return hits;
}

function formatClaimDetail(hit: GlobalClaimScanHit): string {
  const catLabel = GLOBAL_CLAIM_CATEGORY_LABELS[hit.rule.category];
  const loc =
    hit.sectionLabel === '正文'
      ? `第 ${hit.match.line} 行`
      : `${hit.sectionLabel}第 ${hit.match.line} 行`;
  return `[${catLabel}] "${hit.match.matchedText}"（${loc}：${hit.match.excerpt}）`;
}

/**
 * 发布前硬校验（Preflight）纯函数：
 * - 硬拦截（blockers）：
 *   1. 未补全事实胶囊（[待补充：…] / [TBD: …] / [To be verified: …]）
 *   2. GLOBAL 市场正文中混入非品牌专有名词的中文字符
 *   3. 严重合规拦截项（severity === 'blocked' / code === 'PROHIBITED_INDUSTRY' 及 GLOBAL 医疗/金融夸大硬阻断词）
 * - 软告警（warnings）：
 *   1. GLOBAL 绝对化/无佐证最佳宣称（guaranteed / risk-free / #1 等）
 *   2. GEO 体检得分 < 70
 *   3. 未关联任何品牌事实卡（matchedFactCount <= 0）
 *   4. L1 自有站点渠道缺少 metaDescription 或 slug
 */
export function evaluateDistributionPreflight(
  input: EvaluateDistributionPreflightInput,
): DistributionPreflightResult {
  const blockers: DistributionPreflightItem[] = [];
  const warnings: DistributionPreflightItem[] = [];

  const variantHtmlText = extractPlainTextFromHtml(input.variantHtml);
  const combinedText = [
    input.title ?? '',
    input.variantMetaDesc ?? '',
    input.contentMarkdown ?? '',
    ...(variantHtmlText ? [variantHtmlText] : []),
  ].join('\n');

  // 1. Hard Blocker: Missing fact placeholder slots
  const missingSlots = extractMissingFactSlots(combinedText);
  if (missingSlots.length > 0) {
    blockers.push({
      code: 'MISSING_FACT_SLOTS',
      severity: 'blocker',
      message: `检测到 ${missingSlots.length} 处未补全的待补充事实占位符，请核验并替换后再发布`,
      details: missingSlots.slice(0, 10).map((slot) => slot.raw),
    });
  }

  // 2. Hard Blocker: Locale-aware CJK/script leakage check (supports ja-JP without false positives)
  const effectiveLocale = resolveEffectiveLocale(input.targetLocale, input.market);
  if (input.market === 'GLOBAL' || effectiveLocale !== 'zh-CN') {
    const leakage = detectLocaleLeakage(combinedText, effectiveLocale, input.brandNames ?? []);
    if (leakage.leaked) {
      blockers.push({
        code: 'GLOBAL_CJK_LEAK',
        severity: 'blocker',
        message:
          effectiveLocale === 'ja-JP'
            ? '日语（ja-JP）稿件中检测到疑似简体中文字符或缺失假名特征，请核验修正后再发布'
            : '海外（GLOBAL）稿件中检测到非品牌专有名词的中文字符，请翻译清理后再发布',
        details: leakage.samples,
      });
    }
  }

  // 3. Hard Blocker + Warning: Severe compliance flags & GLOBAL exaggerated/deceptive claims
  const severeCompliance = (input.complianceFlags ?? []).filter(
    (flag) => flag.severity === 'blocked' || flag.code === 'PROHIBITED_INDUSTRY',
  );

  const globalBlockerHits: GlobalClaimScanHit[] = [];
  const globalWarningHits: GlobalClaimScanHit[] = [];
  if (input.market === 'GLOBAL') {
    const rules = input.globalClaimRules ?? GLOBAL_PREFLIGHT_CLAIM_RULES;
    const primaryHits = [
      ...scanSectionForGlobalClaims(input.title ?? '', '标题', rules),
      ...scanSectionForGlobalClaims(input.variantMetaDesc ?? '', '摘要', rules),
      ...scanSectionForGlobalClaims(input.contentMarkdown ?? '', '正文', rules),
    ];
    const seenPrimaryKeys = new Set(
      primaryHits.map((h) => `${h.rule.id}:${h.match.matchedText.toLowerCase()}`),
    );
    const htmlOnlyHits = variantHtmlText
      ? scanSectionForGlobalClaims(variantHtmlText, 'HTML 正文', rules).filter(
          (h) => !seenPrimaryKeys.has(`${h.rule.id}:${h.match.matchedText.toLowerCase()}`),
        )
      : [];

    for (const hit of [...primaryHits, ...htmlOnlyHits]) {
      if (hit.rule.severity === 'blocker') {
        globalBlockerHits.push(hit);
      } else {
        globalWarningHits.push(hit);
      }
    }
  }

  const totalComplianceBlockers = severeCompliance.length + globalBlockerHits.length;
  if (totalComplianceBlockers > 0) {
    const details = [
      ...severeCompliance.map((flag) => `${flag.term}: ${flag.message}`),
      ...globalBlockerHits.map(formatClaimDetail),
    ].slice(0, 10);
    const matches =
      globalBlockerHits.length > 0
        ? globalBlockerHits.slice(0, 10).map((hit) => hit.match)
        : undefined;
    blockers.push({
      code: 'COMPLIANCE_BLOCKED',
      severity: 'blocker',
      message: `存在 ${totalComplianceBlockers} 项高危合规拦截词，必须移除后方可发布`,
      details,
      ...(matches ? { matches } : {}),
    });
  }

  if (globalWarningHits.length > 0) {
    warnings.push({
      code: 'GLOBAL_CLAIM_WARNING',
      severity: 'warning',
      message: `检测到 ${globalWarningHits.length} 处海外夸大或绝对化宣称，建议补充权威依据或改为客观表述`,
      details: globalWarningHits.slice(0, 10).map(formatClaimDetail),
      matches: globalWarningHits.slice(0, 10).map((hit) => hit.match),
    });
  }

  // 4. Soft Warning: Low GEO score
  if (
    typeof input.geoScore === 'number' &&
    Number.isFinite(input.geoScore) &&
    input.geoScore < 70
  ) {
    warnings.push({
      code: 'LOW_GEO_SCORE',
      severity: 'warning',
      message: `当前 GEO 体检得分偏低（${Math.round(input.geoScore)} 分，建议达到 70 分以上再分发）`,
    });
  }

  // 5. Soft Warning: Missing matched brand fact cards
  if (typeof input.matchedFactCount === 'number' && input.matchedFactCount <= 0) {
    warnings.push({
      code: 'MISSING_FACT_CARDS',
      severity: 'warning',
      message: '当前稿件未关联品牌事实卡，建议先补充官方参数或案例事实以提升 AI 引用可信度',
    });
  }

  // 6. Soft Warnings: Owned-site (L1) metadata completeness
  if (input.provider && isL1ChannelProvider(input.provider)) {
    if (!input.variantMetaDesc?.trim()) {
      warnings.push({
        code: 'MISSING_META_DESCRIPTION',
        severity: 'warning',
        message: '自有站点分发缺少摘要描述（Meta Description），可能影响搜索引擎与 AI 摘要展示',
      });
    }
    if (input.provider !== 'WECHAT_OFFICIAL' && !input.variantSlug?.trim()) {
      warnings.push({
        code: 'MISSING_SLUG',
        severity: 'warning',
        message: '自有站点分发缺少语义化 URL Slug，建议补充英文短链标识',
      });
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
  };
}
