import { z } from 'zod';
import { GEO_MARKETS, containsCjk, type GeoMarket } from './brands';
import type { GeoComplianceFlag } from './compliance';
import { extractMissingFactSlots } from './geo-studio';

/**
 * GeoMix v2.1 全球多渠道分发、L1 站点连接、发布前硬校验（Preflight）、
 * 外部 PR/KOL 协同包、T+1 爬虫体检与 T+7/14/30 定时复测契约（Issue #349）。
 */

export const CHANNEL_PROVIDERS = [
  'SHOPIFY',
  'WORDPRESS',
  'WEBFLOW',
  'WEBHOOK',
  'REDDIT_ASSIST',
  'QUORA_ASSIST',
  'SOCIAL_THREAD_ASSIST',
  'PR_PACKET',
  'CN_COMMUNITY_ASSIST',
] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export const L1_CHANNEL_PROVIDERS = ['SHOPIFY', 'WORDPRESS', 'WEBFLOW', 'WEBHOOK'] as const;
export type L1ChannelProvider = (typeof L1_CHANNEL_PROVIDERS)[number];

const L1_PROVIDER_SET = new Set<string>(L1_CHANNEL_PROVIDERS);

export function isL1ChannelProvider(value: string): value is L1ChannelProvider {
  return L1_PROVIDER_SET.has(value);
}

export const CHANNEL_CONNECTION_STATUSES = ['ACTIVE', 'INVALID', 'DISABLED'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

export const DISTRIBUTION_MODES = ['L1_API', 'L3_COMMUNITY_ASSIST', 'L3_PR_PACKET'] as const;
export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];

export function defaultDistributionModeForProvider(provider: ChannelProvider): DistributionMode {
  if (isL1ChannelProvider(provider)) return 'L1_API';
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
      return 'OWNED_BLOG_SEO_GEO';
    case 'REDDIT_ASSIST':
      return 'REDDIT_DISCUSSION';
    case 'QUORA_ASSIST':
      return 'QUORA_ANSWER';
    case 'SOCIAL_THREAD_ASSIST':
      return 'SOCIAL_THREAD';
    case 'PR_PACKET':
      return 'PR_MEDIA_PACKET';
    case 'CN_COMMUNITY_ASSIST':
      return 'CN_COMMUNITY_QA';
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
  REDDIT_ASSIST: 'Reddit 社区讨论',
  QUORA_ASSIST: 'Quora 专业问答',
  SOCIAL_THREAD_ASSIST: '社媒长帖（X / LinkedIn）',
  PR_PACKET: 'PR / KOL 外部媒体协作包',
  CN_COMMUNITY_ASSIST: '中文社区问答 / 评测',
};

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
    cancelMilestoneDays: z.array(z.number().int().min(1).max(365)).max(6).optional(),
  })
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.milestones !== undefined ||
      value.sampleCount !== undefined ||
      value.cancelMilestoneDays !== undefined,
    { message: '至少修改一项复测计划配置' },
  );

export type RetestScheduleConfigInput = z.infer<typeof retestScheduleConfigSchema>;

/** 11. 发布前硬校验（Preflight）结果 */
export const PREFLIGHT_ITEM_CODES = [
  'MISSING_FACT_SLOTS',
  'GLOBAL_CJK_LEAK',
  'COMPLIANCE_BLOCKED',
  'LOW_GEO_SCORE',
  'MISSING_FACT_CARDS',
  'MISSING_META_DESCRIPTION',
  'MISSING_SLUG',
] as const;
export type PreflightItemCode = (typeof PREFLIGHT_ITEM_CODES)[number];

export const distributionPreflightItemSchema = z.object({
  code: z.enum(PREFLIGHT_ITEM_CODES),
  severity: z.enum(['blocker', 'warning']),
  message: z.string().min(1),
  details: z.array(z.string()).optional(),
});

export type DistributionPreflightItem = z.infer<typeof distributionPreflightItemSchema>;

export const distributionPreflightResultSchema = z.object({
  ok: z.boolean(),
  blockers: z.array(distributionPreflightItemSchema),
  warnings: z.array(distributionPreflightItemSchema),
});

export type DistributionPreflightResult = z.infer<typeof distributionPreflightResultSchema>;

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
};

export type GeoRetestScheduleDto = {
  id: string;
  publishRecordId: string;
  milestoneDay: number;
  sampleCount: RetestSampleCount;
  dueAt: string;
  status: RetestScheduleStatus;
  visibilityRunId: string | null;
  metricsSnapshot: GeoRetestMetricsSnapshot | null;
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

export type EvaluateDistributionPreflightInput = {
  market: GeoMarket;
  title: string;
  contentMarkdown: string;
  brandNames?: readonly string[];
  complianceFlags?: readonly GeoComplianceFlag[];
  geoScore?: number | null;
  matchedFactCount?: number | null;
  provider?: ChannelProvider | null;
  variantSlug?: string | null;
  variantMetaDesc?: string | null;
};

const CJK_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBrandProperNouns(text: string, brandNames: readonly string[]): string {
  const cjkNames = [
    ...new Set(
      brandNames.map((name) => name.trim()).filter((name) => name.length > 0 && containsCjk(name)),
    ),
  ].sort((a, b) => b.length - a.length);

  let stripped = text;
  for (const name of cjkNames) {
    stripped = stripped.replace(new RegExp(escapeRegExp(name), 'gi'), ' ');
  }
  return stripped;
}

/**
 * 发布前硬校验（Preflight）纯函数：
 * - 硬拦截（blockers）：
 *   1. 未补全事实胶囊（[待补充：…] / [TBD: …] / [To be verified: …]）
 *   2. GLOBAL 市场正文中混入非品牌专有名词的中文字符
 *   3. 严重合规拦截项（severity === 'blocked' 或 code === 'PROHIBITED_INDUSTRY'）
 * - 软告警（warnings）：
 *   1. GEO 体检得分 < 70
 *   2. 未关联任何品牌事实卡（matchedFactCount <= 0）
 *   3. L1 自有站点渠道缺少 metaDescription 或 slug
 */
export function evaluateDistributionPreflight(
  input: EvaluateDistributionPreflightInput,
): DistributionPreflightResult {
  const blockers: DistributionPreflightItem[] = [];
  const warnings: DistributionPreflightItem[] = [];

  const combinedText = [
    input.title ?? '',
    input.variantMetaDesc ?? '',
    input.contentMarkdown ?? '',
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

  // 2. Hard Blocker: Non-brand CJK leakage in GLOBAL market
  if (input.market === 'GLOBAL') {
    const stripped = stripBrandProperNouns(combinedText, input.brandNames ?? []);
    if (containsCjk(stripped)) {
      const samples = [...new Set(stripped.match(CJK_RUN_RE) ?? [])].slice(0, 5);
      blockers.push({
        code: 'GLOBAL_CJK_LEAK',
        severity: 'blocker',
        message: '海外（GLOBAL）稿件中检测到非品牌专有名词的中文字符，请翻译清理后再发布',
        details: samples,
      });
    }
  }

  // 3. Hard Blocker: Severe compliance flags
  const severeCompliance = (input.complianceFlags ?? []).filter(
    (flag) => flag.severity === 'blocked' || flag.code === 'PROHIBITED_INDUSTRY',
  );
  if (severeCompliance.length > 0) {
    blockers.push({
      code: 'COMPLIANCE_BLOCKED',
      severity: 'blocker',
      message: `存在 ${severeCompliance.length} 项高危合规拦截词，必须移除后方可发布`,
      details: severeCompliance.slice(0, 10).map((flag) => `${flag.term}: ${flag.message}`),
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
    if (!input.variantSlug?.trim()) {
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
