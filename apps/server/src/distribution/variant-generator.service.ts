import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  CHANNEL_PROVIDERS,
  DISTRIBUTION_MODES,
  DISTRIBUTION_TASK_STATUSES,
  DISTRIBUTION_TEMPLATE_KEYS,
  GEO_VARIANT_JOB_STATUSES,
  createDistributionVariantsSchema,
  defaultDistributionModeForProvider,
  defaultTemplateKeyForProvider,
  distributionPreflightResultSchema,
  distributionVariantTargetSchema,
  evaluateDistributionPreflight,
  finishStatus,
  isL1ChannelProvider,
  isSafeDistributionHttpUrl,
  isSupportedLocale,
  resolveEffectiveLocale,
  supportedLocalesForMarket,
  type BrandFactSlot,
  type ChannelProvider,
  type CreateDistributionVariantsInput,
  type DistributionMode,
  type DistributionPreflightResult,
  type DistributionTaskStatus,
  type DistributionTemplateKey,
  type DistributionVariantTargetInput,
  type GeoComplianceFlag,
  type GeoDistributionTaskDto,
  type GeoMarket,
  type GeoVariantJobDto,
  type GeoVariantJobFailureItem,
  type GeoVariantJobStatus,
  type SupportedLocale,
} from '@geomix/shared';
import { BillingService, type ReservationView } from '../billing/billing.service';
import { parseStoredChannels } from '../briefs/briefs.mapper';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import { LlmService, assertCompletionAllowed } from '../infra/llm';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import {
  VariantGlobalCjkLeakError,
  buildDeterministicFakeVariantDraft,
  buildOwnedBlogExtras,
  buildVariantPromptMessages,
  clampWechatTitle,
  finalizeRealLlmVariantDraft,
  getLocaleNeutralMetaPad,
  normalizeVariantMetaDesc,
  normalizeWechatDigest,
  renderVariantHtml,
  resolveVariantTemplateKey,
  sliceUtf16Safe,
  type DistributionVariantExtras,
  type GeneratedVariantDraft,
  type VariantBrandFactInput,
  type VariantPromptContext,
} from './variant-templates';

export const VARIANT_JOB_HANDLER = Symbol('VARIANT_JOB_HANDLER');
export const VARIANT_JOB_ENQUEUER = Symbol('VARIANT_JOB_ENQUEUER');

export type VariantJobData = {
  tenantId: string;
  jobId: string;
};

export interface VariantJobHandler {
  process(payload: VariantJobData): Promise<void>;
}

export interface VariantJobEnqueuer {
  enqueueVariantJob(job: VariantJobData): Promise<void>;
}

const DEFAULT_GEO_VARIANT_FREE_MAX = 20;
const DEFAULT_GEO_VARIANT_FREE_WINDOW_SECONDS = 60;
const DEFAULT_GEO_VARIANT_CONCURRENCY = 3;
const MAX_GEO_VARIANT_CONCURRENCY = 6;
const DEFAULT_GEO_VARIANT_CHANNEL_TIMEOUT_MS = 120_000;
const MAX_GEO_VARIANT_CHANNEL_TIMEOUT_MS = 300_000;
const MAX_TARGETS_PER_BATCH = 10;

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);
const DISTRIBUTION_MODE_SET = new Set<string>(DISTRIBUTION_MODES);
const DISTRIBUTION_TASK_STATUS_SET = new Set<string>(DISTRIBUTION_TASK_STATUSES);
const VARIANT_JOB_STATUS_SET = new Set<string>(GEO_VARIANT_JOB_STATUSES);
const CN_ONLY_PROVIDERS = new Set<ChannelProvider>([
  'WECHAT_OFFICIAL',
  'ZHIHU_EXT',
  'TOUTIAO_EXT',
  'SMZDM_EXT',
  'CN_COMMUNITY_ASSIST',
]);
const CN_ONLY_TEMPLATES = new Set<DistributionTemplateKey>([
  'WECHAT_OFFICIAL_ARTICLE',
  'CN_COMMUNITY_QA',
]);

type ValidatedConnectionRow = {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  configJson: Prisma.JsonValue;
  targetLocale?: string | null;
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readGeoVariantConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = readPositiveInt(env.GEO_VARIANT_CONCURRENCY, DEFAULT_GEO_VARIANT_CONCURRENCY);
  return Math.min(MAX_GEO_VARIANT_CONCURRENCY, Math.max(1, value));
}

export function readGeoVariantChannelTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = readPositiveInt(
    env.GEO_VARIANT_CHANNEL_TIMEOUT_MS,
    DEFAULT_GEO_VARIANT_CHANNEL_TIMEOUT_MS,
  );
  return Math.min(MAX_GEO_VARIANT_CHANNEL_TIMEOUT_MS, Math.max(1_000, value));
}

async function withChannelTimeout<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new ProviderError(
          PROVIDER_KIND.TIMEOUT,
          `单渠道变体生成超过 ${Math.round(timeoutMs / 1000)} 秒超时，已自动退还该渠道点数`,
          'variant_channel_timeout',
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      throw new ProviderError(
        PROVIDER_KIND.TIMEOUT,
        `单渠道变体生成超过 ${Math.round(timeoutMs / 1000)} 秒超时，已自动退还该渠道点数`,
        'variant_channel_timeout',
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await worker(items[idx]!, idx);
    }
  });
  await Promise.all(runners);
}

function dedupeComplianceFlags(flags: readonly GeoComplianceFlag[]): GeoComplianceFlag[] {
  const seen = new Set<string>();
  const out: GeoComplianceFlag[] = [];
  for (const flag of flags) {
    const key = `${flag.code}:${flag.market}:${flag.term}:${flag.severity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
  }
  return out;
}

export function readGeoVariantFreeRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.GEO_VARIANT_FREE_RATE_LIMIT_MAX, DEFAULT_GEO_VARIANT_FREE_MAX);
  const windowSeconds = readPositiveInt(
    env.GEO_VARIANT_FREE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_GEO_VARIANT_FREE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export type GeoVariantJobRow = {
  id: string;
  tenantId?: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  targetsJson: Prisma.JsonValue;
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  totalChargedPoints: number;
  refundedCount: number;
  refundedPoints: number;
  billingMode: string;
  reservationId: string | null;
  status: string;
  taskIds: string[];
  failuresJson: Prisma.JsonValue;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

function toVariantJobStatus(raw: string): GeoVariantJobStatus {
  return VARIANT_JOB_STATUS_SET.has(raw) ? (raw as GeoVariantJobStatus) : 'QUEUED';
}

function toBillingMode(raw: string): 'SHADOW' | 'STRICT' | 'FREE' {
  if (raw === 'STRICT' || raw === 'FREE') return raw;
  return 'SHADOW';
}

function parseStoredFailures(raw: Prisma.JsonValue | null | undefined): GeoVariantJobFailureItem[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoVariantJobFailureItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.index === 'number' &&
      typeof obj.provider === 'string' &&
      typeof obj.channelLabel === 'string' &&
      typeof obj.templateKey === 'string' &&
      typeof obj.error === 'string'
    ) {
      out.push({
        index: obj.index,
        provider: toChannelProvider(obj.provider),
        channelLabel: obj.channelLabel,
        templateKey: obj.templateKey as DistributionTemplateKey,
        error: obj.error,
      });
    }
  }
  return out;
}

function parseStoredTargets(
  raw: Prisma.JsonValue | null | undefined,
): DistributionVariantTargetInput[] {
  if (!Array.isArray(raw)) return [];
  const out: DistributionVariantTargetInput[] = [];
  for (const item of raw) {
    const parsed = distributionVariantTargetSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

export function presentVariantJob(row: GeoVariantJobRow, replayed = false): GeoVariantJobDto {
  return {
    id: row.id,
    articleId: row.articleId,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    status: toVariantJobStatus(row.status),
    total: row.total,
    doneCount: row.doneCount,
    failCount: row.failCount,
    unitPrice: row.unitPrice,
    totalChargedPoints: row.totalChargedPoints,
    refundedCount: row.refundedCount,
    refundedPoints: row.refundedPoints,
    reservationId: row.reservationId ?? null,
    billingMode: toBillingMode(row.billingMode),
    replayed,
    taskIds: Array.isArray(row.taskIds) ? [...row.taskIds] : [],
    failures: parseStoredFailures(row.failuresJson),
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export type GeoDistributionTaskRow = {
  id: string;
  tenantId?: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  connectionId: string | null;
  provider: string;
  mode: string;
  channelLabel: string;
  targetLocale?: string | null;
  targetUrlHint: string | null;
  variantTitle: string;
  variantSlug: string | null;
  variantMetaDesc: string | null;
  variantMarkdown: string;
  variantHtml: string;
  variantExtrasJson: Prisma.JsonValue;
  preflightJson: Prisma.JsonValue | null;
  status: string;
  publishAsDraft: boolean;
  remotePostId: string | null;
  remoteAdminUrl: string | null;
  remotePublishedUrl: string | null;
  indexNowStatus: string | null;
  lastError: string | null;
  shareTokenHash?: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt?: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VariantGeneratorAuthContext = {
  tenantId: string;
  userId?: string;
};

export type GenerateVariantsOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type GenerateVariantsFailureItem = {
  index: number;
  provider: ChannelProvider;
  channelLabel: string;
  templateKey: DistributionTemplateKey;
  error: string;
};

export type GenerateVariantsResult = {
  articleId: string;
  unitPrice: number;
  totalChargedPoints: number;
  refundedCount: number;
  refundedPoints: number;
  reservationId: string | null;
  billingMode: 'SHADOW' | 'STRICT' | 'FREE';
  replayed: boolean;
  tasks: GeoDistributionTaskDto[];
  failures: GenerateVariantsFailureItem[];
};

function toChannelProvider(raw: string): ChannelProvider {
  return CHANNEL_PROVIDER_SET.has(raw) ? (raw as ChannelProvider) : 'WEBHOOK';
}

function toDistributionMode(raw: string, provider: ChannelProvider): DistributionMode {
  return DISTRIBUTION_MODE_SET.has(raw)
    ? (raw as DistributionMode)
    : defaultDistributionModeForProvider(provider);
}

function toTaskStatus(raw: string): DistributionTaskStatus {
  return DISTRIBUTION_TASK_STATUS_SET.has(raw) ? (raw as DistributionTaskStatus) : 'DRAFT_VARIANT';
}

function toBrandFactSlot(raw: string): BrandFactSlot {
  switch (raw) {
    case 'PRODUCT_SPECS':
    case 'DIFFERENTIATORS':
    case 'CREDENTIALS':
    case 'CASE_STUDIES':
    case 'EXTRA_DOC':
      return raw;
    default:
      return 'EXTRA_DOC';
  }
}

function asJsonRecord(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function parsePreflightJson(
  raw: Prisma.JsonValue | null | undefined,
): DistributionPreflightResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = distributionPreflightResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function sanitizePresentedExtras(
  raw: Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  const rec = asJsonRecord(raw);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 将 GeoDistributionTask 数据库行安全映射为 GeoDistributionTaskDto。
 * 严格禁止泄露 shareTokenHash、shareRevokedAt、tenantId 与内部 _* 元数据键。
 */
export function presentDistributionTask(
  row: GeoDistributionTaskRow,
  now = new Date(),
): GeoDistributionTaskDto {
  const provider = toChannelProvider(row.provider);
  const shareLinkActive = Boolean(
    row.shareTokenHash &&
    !row.shareRevokedAt &&
    (!row.shareExpiresAt || row.shareExpiresAt.getTime() > now.getTime()),
  );

  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    articleId: row.articleId,
    connectionId: row.connectionId ?? null,
    provider,
    mode: toDistributionMode(row.mode, provider),
    channelLabel: row.channelLabel,
    targetLocale: isSupportedLocale(row.targetLocale)
      ? (row.targetLocale.trim() as SupportedLocale)
      : null,
    targetUrlHint: row.targetUrlHint ?? null,
    variantTitle: row.variantTitle,
    variantSlug: row.variantSlug ?? null,
    variantMetaDesc: row.variantMetaDesc ?? null,
    variantMarkdown: row.variantMarkdown,
    variantHtml: row.variantHtml,
    variantExtrasJson: sanitizePresentedExtras(row.variantExtrasJson),
    preflightJson: parsePreflightJson(row.preflightJson),
    status: toTaskStatus(row.status),
    publishAsDraft: row.publishAsDraft,
    remotePostId: row.remotePostId ?? null,
    remoteAdminUrl: row.remoteAdminUrl ?? null,
    remotePublishedUrl: row.remotePublishedUrl ?? null,
    indexNowStatus: row.indexNowStatus ?? null,
    lastError: row.lastError ?? null,
    shareLinkActive,
    shareExpiresAt: row.shareExpiresAt ? row.shareExpiresAt.toISOString() : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeVariantBatchFingerprint(
  targets: readonly DistributionVariantTargetInput[],
): string {
  const canonical = targets.map((t) => ({
    provider: t.provider,
    connectionId: t.connectionId ?? null,
    channelLabel: t.channelLabel,
    targetLocale: t.targetLocale ?? null,
    targetUrlHint: t.targetUrlHint ?? null,
    templateKey: resolveVariantTemplateKey(t),
    publishAsDraft: t.publishAsDraft ?? null,
  }));
  return sha256Hex(JSON.stringify(canonical));
}

function formatSettleTitle(channelLabel: string): string {
  const cleaned = channelLabel
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = sliceUtf16Safe(cleaned || '渠道', 30);
  return `渠道变体-${suffix}`;
}

function deriveBatchRefId(tenantId: string, articleId: string, idempotencyKey?: string): string {
  if (idempotencyKey) {
    return `gv_${sha256Hex(`${tenantId}::${articleId}::${idempotencyKey}`).slice(0, 24)}`;
  }
  return `gv_${randomBytes(12).toString('hex')}`;
}

function deriveDeterministicTaskId(
  tenantId: string,
  articleId: string,
  idempotencyKey: string,
  index: number,
): string {
  return `gdt_${sha256Hex(`${tenantId}::variant::${articleId}::${idempotencyKey}::${index}`).slice(0, 24)}`;
}

function parseCompetitorNames(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawName = (item as Record<string, unknown>).name;
    if (typeof rawName !== 'string') continue;
    const cleaned = rawName.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(cleaned);
    if (names.length >= 10) break;
  }
  return names;
}

function extractCitedUrlsForTarget(
  recommendedChannelsRaw: Prisma.JsonValue | null | undefined,
  target: DistributionVariantTargetInput,
): string[] {
  if (!recommendedChannelsRaw) return [];
  const channels = parseStoredChannels(recommendedChannelsRaw);
  const labelKey = target.channelLabel.trim().toLowerCase();
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const entry of channels) {
    const providerMatches = entry.providerHint === target.provider;
    const labelMatches =
      entry.channel.trim().toLowerCase() === labelKey ||
      labelKey.includes(entry.channel.trim().toLowerCase());
    if (!providerMatches && !labelMatches) continue;
    for (const url of entry.citedExampleUrls ?? []) {
      const cleaned = url.trim();
      if (!cleaned || !isSafeDistributionHttpUrl(cleaned) || seen.has(cleaned)) continue;
      seen.add(cleaned);
      matched.push(cleaned);
      if (matched.length >= 5) return matched;
    }
  }
  return matched;
}

function mapFatalError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ProviderError) {
    if (err.reason === 'fake_fallback_rejected') {
      return new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, err.message);
    }
    return new ApiError(
      502,
      API_ERROR.UPSTREAM_UNAVAILABLE,
      err.message || '渠道变体生成服务暂时不可用，请稍后重试',
    );
  }
  if (err instanceof VariantGlobalCjkLeakError) {
    return new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, err.message);
  }
  return new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, '渠道变体生成失败，请稍后重试');
}

function sanitizeFailureMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message.slice(0, 200);
  if (err instanceof ProviderError) {
    return (err.message || '上游模型调用失败').slice(0, 200);
  }
  if (err instanceof VariantGlobalCjkLeakError) {
    return err.message.slice(0, 200);
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 200);
  }
  return '渠道变体生成失败';
}

function readConnectionDefaultDraft(
  configJson: Prisma.JsonValue | null | undefined,
): boolean | undefined {
  const record = asJsonRecord(configJson);
  return typeof record.defaultPublishAsDraft === 'boolean'
    ? record.defaultPublishAsDraft
    : undefined;
}

const DISTRIBUTION_TEMPLATE_KEY_SET = new Set<string>(DISTRIBUTION_TEMPLATE_KEYS);

function readStoredTemplateKey(row: GeoDistributionTaskRow): DistributionTemplateKey {
  const extras = asJsonRecord(row.variantExtrasJson);
  const raw = extras.templateKey;
  if (typeof raw === 'string' && DISTRIBUTION_TEMPLATE_KEY_SET.has(raw)) {
    return raw as DistributionTemplateKey;
  }
  return defaultTemplateKeyForProvider(toChannelProvider(row.provider));
}

@Injectable()
export class VariantGeneratorService {
  private readonly logger = new Logger(VariantGeneratorService.name);
  private readonly inFlightBatches = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Optional()
    @Inject(FreeActionRateLimiter)
    private readonly rateLimiter?: FreeActionRateLimiter,
    @Optional()
    @Inject(VARIANT_JOB_ENQUEUER)
    private readonly enqueuer?: VariantJobEnqueuer,
  ) {}

  async generateVariants(
    articleId: string,
    rawInput: CreateDistributionVariantsInput | unknown,
    auth: VariantGeneratorAuthContext,
    options?: GenerateVariantsOptions,
  ): Promise<GenerateVariantsResult> {
    const parsedInput = createDistributionVariantsSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        parsedInput.error.issues[0]?.message ?? '渠道变体生成参数校验失败',
      );
    }

    const targets = parsedInput.data.targets;
    const normalizedIdempotencyKey = options?.idempotencyKey?.trim() || undefined;
    const inFlightKey = normalizedIdempotencyKey
      ? `${auth.tenantId}:${articleId}:${normalizedIdempotencyKey}`
      : null;

    if (inFlightKey) {
      if (this.inFlightBatches.has(inFlightKey)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同幂等键渠道变体正在生成中，请勿重复提交');
      }
      this.inFlightBatches.add(inFlightKey);
    }

    try {
      return await this.executeGenerateVariants(
        articleId,
        targets,
        auth,
        normalizedIdempotencyKey,
        options?.signal,
      );
    } finally {
      if (inFlightKey) {
        this.inFlightBatches.delete(inFlightKey);
      }
    }
  }

  private async executeGenerateVariants(
    articleId: string,
    targets: DistributionVariantTargetInput[],
    auth: VariantGeneratorAuthContext,
    normalizedIdempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<GenerateVariantsResult> {
    // 1. 加载母稿与上下文（全量使用 prisma.scoped，严禁 prisma.base）
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            category: true,
          },
        },
        brandMarket: {
          select: {
            id: true,
            market: true,
            locale: true,
            supportedLocales: true,
            localBrandName: true,
            localCategory: true,
            aliases: true,
            ownedDomains: true,
            competitors: true,
          },
        },
        brief: {
          select: {
            id: true,
            targetFanOuts: true,
            competitorFocus: true,
            matchedFactIds: true,
            recommendedChannels: true,
          },
        },
      },
    });

    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或无权访问');
    }

    // 2. 校验连接、语种市场隔离与品牌市场 supportedLocales，并自动匹配 ChannelConnection.targetLocale
    const { normalizedTargets, validatedConnections } = await this.validateAndNormalizeTargets(
      article,
      targets,
    );

    const requestFingerprint = normalizedIdempotencyKey
      ? computeVariantBatchFingerprint(normalizedTargets)
      : undefined;

    // 3. 幂等重放检测（必须在计费预扣与 LLM 调用之前执行！）
    if (normalizedIdempotencyKey) {
      const slotCount = Math.max(normalizedTargets.length, MAX_TARGETS_PER_BATCH);
      const candidateIds = Array.from({ length: slotCount }, (_, index) =>
        deriveDeterministicTaskId(auth.tenantId, article.id, normalizedIdempotencyKey, index),
      );
      const existingRows = await this.prisma.scoped.geoDistributionTask.findMany({
        where: {
          articleId: article.id,
          id: { in: candidateIds },
        },
      });

      if (existingRows.length > 0) {
        const byId = new Map<string, GeoDistributionTaskRow>(
          existingRows.map((row) => [row.id, row as GeoDistributionTaskRow]),
        );
        const slotIndexById = new Map<string, number>(candidateIds.map((id, idx) => [id, idx]));
        const orderedExisting: GeoDistributionTaskRow[] = [];
        for (const id of candidateIds) {
          const found = byId.get(id);
          if (found) orderedExisting.push(found);
        }

        const hasStoredFingerprints = orderedExisting.every((row) => {
          const extras = asJsonRecord(row.variantExtrasJson);
          return (
            typeof extras._idempotencyFingerprint === 'string' &&
            extras._idempotencyFingerprint.length > 0
          );
        });

        let isExactMatch = false;
        if (hasStoredFingerprints) {
          isExactMatch = orderedExisting.every((row) => {
            const extras = asJsonRecord(row.variantExtrasJson);
            if (extras._idempotencyFingerprint !== requestFingerprint) {
              return false;
            }
            const slotIdx = slotIndexById.get(row.id) ?? -1;
            if (slotIdx < 0 || slotIdx >= normalizedTargets.length) {
              return false;
            }
            const target = normalizedTargets[slotIdx]!;
            return (
              row.provider === target.provider &&
              row.channelLabel === target.channelLabel &&
              readStoredTemplateKey(row) === resolveVariantTemplateKey(target) &&
              (row.connectionId ?? null) === (target.connectionId ?? null) &&
              (row.targetUrlHint ?? null) === (target.targetUrlHint ?? null) &&
              (!row.targetLocale || row.targetLocale === (target.targetLocale ?? null))
            );
          });
        } else {
          isExactMatch =
            orderedExisting.length === normalizedTargets.length &&
            normalizedTargets.every((target, index) => {
              const existing = orderedExisting[index];
              if (!existing) return false;
              const expectedId = candidateIds[index];
              return (
                existing.id === expectedId &&
                existing.provider === target.provider &&
                existing.channelLabel === target.channelLabel &&
                readStoredTemplateKey(existing) === resolveVariantTemplateKey(target) &&
                (existing.connectionId ?? null) === (target.connectionId ?? null) &&
                (existing.targetUrlHint ?? null) === (target.targetUrlHint ?? null) &&
                (!existing.targetLocale || existing.targetLocale === (target.targetLocale ?? null))
              );
            });
        }

        if (!isExactMatch) {
          throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被用于不同的渠道变体生成请求');
        }

        return {
          articleId: article.id,
          unitPrice: 0,
          totalChargedPoints: 0,
          refundedCount: 0,
          refundedPoints: 0,
          reservationId: null,
          billingMode: 'FREE',
          replayed: true,
          tasks: orderedExisting.map((row) => presentDistributionTask(row)),
          failures: [],
        };
      }
    }

    // 4. 加载品牌事实卡与租户写作偏好
    const [factRows, promptPreference] = await Promise.all([
      this.prisma.scoped.brandFact.findMany({
        where: { brandId: article.brandId },
        select: { id: true, slot: true, title: true, content: true },
        orderBy: [{ slot: 'asc' }, { updatedAt: 'desc' }],
      }),
      this.prisma.scoped.promptPreference.findFirst({
        where: { tenantId: auth.tenantId },
        select: { customToneNote: true, customForbiddenWords: true },
      }),
    ]);

    const facts: VariantBrandFactInput[] = factRows
      .filter((row) => typeof row.content === 'string' && row.content.trim().length > 0)
      .map((row) => ({
        id: row.id,
        slot: toBrandFactSlot(row.slot),
        title: row.title,
        content: row.content,
      }));

    // 5. 计费预扣或 0 点限流分支
    const batchRefId = deriveBatchRefId(auth.tenantId, article.id, normalizedIdempotencyKey);
    const unitPrice = await this.billing.unitPrice('geo_variant');

    let reservation: ReservationView | null = null;
    let billingMode: 'SHADOW' | 'STRICT' | 'FREE';
    let reservationShadow: boolean;

    if (unitPrice === 0) {
      this.rateLimiter?.assertAllowed('geo_variant', auth.tenantId, readGeoVariantFreeRateLimit());
      billingMode = 'FREE';
      reservationShadow = true;
    } else {
      reservation = await this.billing.reserve({
        tenantId: auth.tenantId,
        refType: 'geo_variant',
        refId: batchRefId,
        amount: targets.length * unitPrice,
      });
      if (reservation.status === 'CLOSED') {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '当前渠道变体批次已结算关闭，请更换幂等键后重试',
        );
      }
      billingMode = reservation.shadow ? 'SHADOW' : 'STRICT';
      reservationShadow = reservation.shadow;
    }

    const market: GeoMarket = article.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const locale = article.brandMarket.locale || (market === 'GLOBAL' ? 'en-US' : 'zh-CN');
    const brandNames = [
      article.brand.name,
      article.brandMarket.localBrandName,
      ...(article.brandMarket.aliases ?? []),
    ].filter((name) => typeof name === 'string' && name.trim().length > 0);
    const marketCompetitors = parseCompetitorNames(article.brandMarket.competitors);
    const competitorFocus =
      article.brief?.competitorFocus && article.brief.competitorFocus.length > 0
        ? article.brief.competitorFocus
        : marketCompetitors;
    const targetFanOuts = article.brief?.targetFanOuts ?? [];
    const customForbiddenWords = promptPreference?.customForbiddenWords ?? [];
    const customToneNote = promptPreference?.customToneNote ?? null;
    const articleSchemaObj = asJsonRecord(article.schemaJsonLd);
    const matchedFactCount =
      article.brief?.matchedFactIds && article.brief.matchedFactIds.length > 0
        ? article.brief.matchedFactIds.length
        : facts.length;

    const batchOutcome = await this.executeTargetsBatch({
      tenantId: auth.tenantId,
      article,
      targets: normalizedTargets,
      validatedConnections,
      facts,
      customForbiddenWords,
      customToneNote,
      brandNames,
      market,
      locale,
      marketCompetitors,
      competitorFocus,
      targetFanOuts,
      articleSchemaObj,
      matchedFactCount,
      batchRefId,
      unitPrice,
      reservationId: reservation?.id ?? null,
      reservationShadow,
      normalizedIdempotencyKey,
      requestFingerprint,
      signal,
    });

    if (batchOutcome.tasks.length === 0 && batchOutcome.failures.length > 0) {
      throw (
        batchOutcome.firstFatalError ??
        new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, '渠道变体生成失败，请稍后重试')
      );
    }

    return {
      articleId: article.id,
      unitPrice,
      totalChargedPoints: batchOutcome.totalChargedPoints,
      refundedCount: batchOutcome.refundedCount,
      refundedPoints: batchOutcome.refundedPoints,
      reservationId: reservation?.id ?? null,
      billingMode,
      replayed: false,
      tasks: batchOutcome.tasks,
      failures: batchOutcome.failures,
    };
  }

  /**
   * 异步创建 1→N 渠道变体生成任务（Issue #363）：
   * - 立即校验母稿、连接、预扣点数并写入 GeoVariantJob（QUEUED），入队 BullMQ 后毫秒级返回，彻底消除 60s 网关 504；
   * - 同 Idempotency-Key + 同参数重试（即使仍在 QUEUED/RUNNING 中）直接返回现有任务（replayed: true），供前端接续轮询，不抛 409(40902)；
   * - 仅当同 Idempotency-Key 携带不同参数时返回 409 冲突保护。
   */
  async createVariantJob(
    articleId: string,
    rawInput: CreateDistributionVariantsInput | unknown,
    auth: VariantGeneratorAuthContext,
    options?: { idempotencyKey?: string },
  ): Promise<GeoVariantJobDto> {
    const parsedInput = createDistributionVariantsSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        parsedInput.error.issues[0]?.message ?? '渠道变体生成参数校验失败',
      );
    }

    const targets = parsedInput.data.targets;
    const normalizedIdempotencyKey = options?.idempotencyKey?.trim() || undefined;

    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      select: {
        id: true,
        brandId: true,
        brandMarketId: true,
        targetLocale: true,
        brandMarket: {
          select: {
            market: true,
            locale: true,
            supportedLocales: true,
          },
        },
      },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或无权访问');
    }

    const { normalizedTargets } = await this.validateAndNormalizeTargets(article, targets);
    const requestFingerprint = computeVariantBatchFingerprint(normalizedTargets);

    // 1. 幂等重放检测：同幂等键 + 同参数直接返回现有任务（含进行中 QUEUED/RUNNING），绝不报 409
    if (normalizedIdempotencyKey) {
      const existing = await this.prisma.scoped.geoVariantJob.findFirst({
        where: {
          articleId: article.id,
          idempotencyKey: normalizedIdempotencyKey,
        },
      });
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
          throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被用于不同的渠道变体生成请求');
        }
        return presentVariantJob(existing as GeoVariantJobRow, true);
      }
    }

    // 2. 计费预扣或 0 点限流
    const batchRefId = deriveBatchRefId(auth.tenantId, article.id, normalizedIdempotencyKey);
    const unitPrice = await this.billing.unitPrice('geo_variant');

    let reservation: ReservationView | null = null;
    let billingMode: 'SHADOW' | 'STRICT' | 'FREE';

    if (unitPrice === 0) {
      this.rateLimiter?.assertAllowed('geo_variant', auth.tenantId, readGeoVariantFreeRateLimit());
      billingMode = 'FREE';
    } else {
      reservation = await this.billing.reserve({
        tenantId: auth.tenantId,
        refType: 'geo_variant',
        refId: batchRefId,
        amount: normalizedTargets.length * unitPrice,
      });
      if (reservation.status === 'CLOSED') {
        if (normalizedIdempotencyKey) {
          const existing = await this.prisma.scoped.geoVariantJob.findFirst({
            where: {
              articleId: article.id,
              idempotencyKey: normalizedIdempotencyKey,
            },
          });
          if (existing) {
            if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
              throw new ApiError(
                409,
                BILLING_ERROR.CONFLICT,
                '幂等键已被用于不同的渠道变体生成请求',
              );
            }
            return presentVariantJob(existing as GeoVariantJobRow, true);
          }
        }
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '当前渠道变体批次已结算关闭，请更换幂等键后重试',
        );
      }
      billingMode = reservation.shadow ? 'SHADOW' : 'STRICT';
    }

    // 3. 持久化 GeoVariantJob（并发同幂等键触发 P2002 时回读已建任务无缝续接）
    let created: GeoVariantJobRow;
    try {
      created = (await this.prisma.scoped.geoVariantJob.create({
        data: {
          tenantId: auth.tenantId,
          brandId: article.brandId,
          brandMarketId: article.brandMarketId,
          articleId: article.id,
          idempotencyKey: normalizedIdempotencyKey ?? null,
          requestFingerprint,
          targetsJson: normalizedTargets as unknown as Prisma.InputJsonValue,
          total: normalizedTargets.length,
          doneCount: 0,
          failCount: 0,
          unitPrice,
          totalChargedPoints: 0,
          refundedCount: 0,
          refundedPoints: 0,
          billingMode,
          reservationId: reservation?.id ?? null,
          status: 'QUEUED',
          taskIds: [],
          failuresJson: [] as unknown as Prisma.InputJsonValue,
        },
      })) as GeoVariantJobRow;
    } catch (createErr) {
      if (normalizedIdempotencyKey && isUniqueConstraintError(createErr)) {
        const winner = await this.prisma.scoped.geoVariantJob.findFirst({
          where: {
            articleId: article.id,
            idempotencyKey: normalizedIdempotencyKey,
          },
        });
        if (winner) {
          if (winner.requestFingerprint && winner.requestFingerprint !== requestFingerprint) {
            throw new ApiError(409, BILLING_ERROR.CONFLICT, '幂等键已被用于不同的渠道变体生成请求');
          }
          return presentVariantJob(winner as GeoVariantJobRow, true);
        }
      }
      if (reservation) {
        await this.billing
          .close({ tenantId: auth.tenantId, reservationId: reservation.id })
          .catch(() => undefined);
      }
      throw createErr;
    }

    // 4. 入队 BullMQ 'distribution' 队列（无队列注入时异步降级进程内执行；入队失败原子退还冻结单）
    if (this.enqueuer) {
      try {
        await this.enqueuer.enqueueVariantJob({
          tenantId: auth.tenantId,
          jobId: created.id,
        });
      } catch {
        const refundedCount = reservation ? targets.length : 0;
        const refundedPoints = reservation ? targets.length * unitPrice : 0;
        await this.prisma.scoped.geoVariantJob
          .updateMany({
            where: { id: created.id, status: 'QUEUED' },
            data: {
              status: 'FAILED',
              failCount: targets.length,
              refundedCount,
              refundedPoints,
              lastError: '渠道变体生成队列暂时不可用，请稍后重试',
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        if (reservation) {
          await this.billing
            .close({ tenantId: auth.tenantId, reservationId: reservation.id })
            .catch(() => undefined);
        }
        throw new ApiError(
          503,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '渠道变体生成队列暂时不可用，请稍后重试',
        );
      }
    } else {
      setImmediate(() => {
        void this.processVariantJob(auth.tenantId, created.id).catch((err: unknown) => {
          this.logger.warn(
            `in-process variant job failed job=${created.id}: ${sanitizeFailureMessage(err)}`,
          );
        });
      });
    }

    return presentVariantJob(created, false);
  }

  async listVariantJobs(articleId: string): Promise<{ items: GeoVariantJobDto[] }> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      select: { id: true },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或无权访问');
    }

    const rows = await this.prisma.scoped.geoVariantJob.findMany({
      where: { articleId: article.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    return {
      items: rows.map((row) => presentVariantJob(row as GeoVariantJobRow, false)),
    };
  }

  async getVariantJob(articleId: string, jobId: string): Promise<GeoVariantJobDto> {
    const row = await this.prisma.scoped.geoVariantJob.findFirst({
      where: { id: jobId, articleId },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道变体生成任务不存在或无权访问');
    }
    return presentVariantJob(row as GeoVariantJobRow, false);
  }

  /**
   * Worker 侧消费 `'variant-generate'` 任务：
   * - 100% 在 `runInTenant(tenantId, ...)` 内使用 `prisma.scoped`，零 `prisma.base`；
   * - 原子认领 QUEUED -> RUNNING，并行生成多渠道变体并按单渠道超时与单渠道失败自动退点；
   * - 每完成/失败一个渠道即刷新数据库进度，供前端 useTaskPolling 实时展示与刷新恢复。
   */
  async processVariantJob(tenantId: string, jobId: string): Promise<void> {
    await runInTenant(tenantId, async () => {
      const claimed = await this.prisma.scoped.geoVariantJob.updateMany({
        where: { id: jobId, status: 'QUEUED' },
        data: { status: 'RUNNING' },
      });
      if (claimed.count !== 1) {
        return;
      }

      const job = (await this.prisma.scoped.geoVariantJob.findFirst({
        where: { id: jobId },
      })) as GeoVariantJobRow | null;
      if (!job) {
        return;
      }

      const targets = parseStoredTargets(job.targetsJson);
      const reservationId = job.reservationId ?? null;
      const reservationShadow = job.billingMode !== 'STRICT';
      const normalizedIdempotencyKey = job.idempotencyKey?.trim() || undefined;
      const batchRefId = deriveBatchRefId(
        tenantId,
        job.articleId,
        normalizedIdempotencyKey ?? job.id,
      );
      const requestFingerprint = job.requestFingerprint ?? computeVariantBatchFingerprint(targets);

      const finishFatal = async (reason: string) => {
        if (reservationId) {
          await this.billing.close({ tenantId, reservationId }).catch(() => undefined);
        }
        await this.prisma.scoped.geoVariantJob
          .updateMany({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              lastError: reason.slice(0, 200),
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
      };

      if (targets.length === 0) {
        await finishFatal('渠道变体目标列表为空，任务已终止');
        return;
      }

      const article = await this.prisma.scoped.geoArticle.findFirst({
        where: { id: job.articleId },
        include: {
          brand: {
            select: {
              id: true,
              name: true,
              category: true,
            },
          },
          brandMarket: {
            select: {
              id: true,
              market: true,
              locale: true,
              supportedLocales: true,
              localBrandName: true,
              localCategory: true,
              aliases: true,
              ownedDomains: true,
              competitors: true,
            },
          },
          brief: {
            select: {
              id: true,
              targetFanOuts: true,
              competitorFocus: true,
              matchedFactIds: true,
              recommendedChannels: true,
            },
          },
        },
      });

      if (!article) {
        await finishFatal('对应文章不存在或已被删除，已退还冻结点数');
        return;
      }

      let validatedConnections: Map<string, ValidatedConnectionRow>;
      try {
        validatedConnections = await this.validateTargetConnections(article, targets, {
          allowMissing: true,
        });
      } catch (err) {
        await finishFatal(sanitizeFailureMessage(err));
        return;
      }

      const [factRows, promptPreference] = await Promise.all([
        this.prisma.scoped.brandFact.findMany({
          where: { brandId: article.brandId },
          select: { id: true, slot: true, title: true, content: true },
          orderBy: [{ slot: 'asc' }, { updatedAt: 'desc' }],
        }),
        this.prisma.scoped.promptPreference.findFirst({
          where: { tenantId },
          select: { customToneNote: true, customForbiddenWords: true },
        }),
      ]);

      const facts: VariantBrandFactInput[] = factRows
        .filter((row) => typeof row.content === 'string' && row.content.trim().length > 0)
        .map((row) => ({
          id: row.id,
          slot: toBrandFactSlot(row.slot),
          title: row.title,
          content: row.content,
        }));

      const market: GeoMarket = article.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
      const locale = article.brandMarket.locale || (market === 'GLOBAL' ? 'en-US' : 'zh-CN');
      const brandNames = [
        article.brand.name,
        article.brandMarket.localBrandName,
        ...(article.brandMarket.aliases ?? []),
      ].filter((name) => typeof name === 'string' && name.trim().length > 0);
      const marketCompetitors = parseCompetitorNames(article.brandMarket.competitors);
      const competitorFocus =
        article.brief?.competitorFocus && article.brief.competitorFocus.length > 0
          ? article.brief.competitorFocus
          : marketCompetitors;
      const targetFanOuts = article.brief?.targetFanOuts ?? [];
      const customForbiddenWords = promptPreference?.customForbiddenWords ?? [];
      const customToneNote = promptPreference?.customToneNote ?? null;
      const articleSchemaObj = asJsonRecord(article.schemaJsonLd);
      const matchedFactCount =
        article.brief?.matchedFactIds && article.brief.matchedFactIds.length > 0
          ? article.brief.matchedFactIds.length
          : facts.length;

      let flushChain: Promise<void> = Promise.resolve();
      const flushProgress = (snapshot: {
        doneCount: number;
        failCount: number;
        totalChargedPoints: number;
        refundedCount: number;
        refundedPoints: number;
        taskIds: string[];
        failures: GenerateVariantsFailureItem[];
        lastError: string | null;
      }) => {
        flushChain = flushChain
          .then(async () => {
            await this.prisma.scoped.geoVariantJob.updateMany({
              where: { id: job.id },
              data: {
                doneCount: snapshot.doneCount,
                failCount: snapshot.failCount,
                totalChargedPoints: snapshot.totalChargedPoints,
                refundedCount: snapshot.refundedCount,
                refundedPoints: snapshot.refundedPoints,
                taskIds: snapshot.taskIds,
                failuresJson: snapshot.failures as unknown as Prisma.InputJsonValue,
                lastError: snapshot.lastError,
              },
            });
          })
          .catch(() => undefined);
      };

      const outcome = await this.executeTargetsBatch({
        tenantId,
        article,
        targets,
        validatedConnections,
        facts,
        customForbiddenWords,
        customToneNote,
        brandNames,
        market,
        locale,
        marketCompetitors,
        competitorFocus,
        targetFanOuts,
        articleSchemaObj,
        matchedFactCount,
        batchRefId,
        unitPrice: job.unitPrice,
        reservationId,
        reservationShadow,
        normalizedIdempotencyKey,
        requestFingerprint,
        onProgress: flushProgress,
      });

      await flushChain;

      const finalStatus = finishStatus({
        done: outcome.tasks.length,
        fail: outcome.failures.length,
        skip: 0,
        cancelled: false,
      });

      await this.prisma.scoped.geoVariantJob.updateMany({
        where: { id: job.id },
        data: {
          status: finalStatus,
          doneCount: outcome.tasks.length,
          failCount: outcome.failures.length,
          totalChargedPoints: outcome.totalChargedPoints,
          refundedCount: outcome.refundedCount,
          refundedPoints: outcome.refundedPoints,
          taskIds: outcome.tasks.map((t) => t.id),
          failuresJson: outcome.failures as unknown as Prisma.InputJsonValue,
          lastError: outcome.failures[0]?.error ?? null,
          finishedAt: new Date(),
        },
      });
    });
  }

  private async validateAndNormalizeTargets(
    article: {
      brandId: string;
      brandMarketId: string;
      targetLocale?: string | null;
      brandMarket?: {
        market?: string;
        locale?: string;
        supportedLocales?: string[] | null;
      } | null;
    },
    targets: readonly DistributionVariantTargetInput[],
  ): Promise<{
    normalizedTargets: DistributionVariantTargetInput[];
    validatedConnections: Map<string, ValidatedConnectionRow>;
  }> {
    const validatedConnections = await this.validateTargetConnections(article, targets);
    const market: GeoMarket = article.brandMarket?.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const marketAllowed = supportedLocalesForMarket(market);
    const marketAllowedSet = new Set<string>(marketAllowed);
    const brandMarketDefaultLocale = resolveEffectiveLocale(article.brandMarket?.locale, market);
    const configuredLocales: SupportedLocale[] = [];
    for (const loc of article.brandMarket?.supportedLocales ?? []) {
      if (isSupportedLocale(loc)) {
        const trimmed = loc.trim() as SupportedLocale;
        if (marketAllowedSet.has(trimmed) && !configuredLocales.includes(trimmed)) {
          configuredLocales.push(trimmed);
        }
      }
    }
    const effectiveSupportedLocales: SupportedLocale[] =
      configuredLocales.length > 0 ? configuredLocales : [brandMarketDefaultLocale];
    const effectiveSupportedSet = new Set<SupportedLocale>(effectiveSupportedLocales);
    const defaultFallbackLocale: SupportedLocale = effectiveSupportedSet.has(
      brandMarketDefaultLocale,
    )
      ? brandMarketDefaultLocale
      : (effectiveSupportedLocales[0] ?? brandMarketDefaultLocale);

    const articleLocale =
      isSupportedLocale(article.targetLocale) && marketAllowedSet.has(article.targetLocale.trim())
        ? (article.targetLocale.trim() as SupportedLocale)
        : null;

    const resolvedLocales: SupportedLocale[] = [];
    const providersNeedingAutoMatch = new Set<ChannelProvider>();

    for (const target of targets) {
      if (market === 'GLOBAL' && CN_ONLY_PROVIDERS.has(target.provider)) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `渠道 ${target.provider} 仅支持中国大陆（CN）市场`,
        );
      }

      const templateKey = resolveVariantTemplateKey(target);
      if (market === 'GLOBAL' && CN_ONLY_TEMPLATES.has(templateKey)) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `模板 ${templateKey} 仅支持中国大陆（CN）市场`,
        );
      }

      let explicitLocale: SupportedLocale | null = null;
      if (target.targetLocale !== undefined) {
        const trimmedRequested = target.targetLocale.trim();
        if (!isSupportedLocale(trimmedRequested)) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            `不支持的目标语种：${String(target.targetLocale)}`,
          );
        }
        const normalizedRequested = trimmedRequested as SupportedLocale;
        if (!marketAllowedSet.has(normalizedRequested)) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            `目标语种 ${normalizedRequested} 与当前市场（${market}）不匹配`,
          );
        }
        if (!effectiveSupportedSet.has(normalizedRequested)) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            `目标语种 ${normalizedRequested} 未在当前品牌市场支持的语种范围内`,
          );
        }
        explicitLocale = normalizedRequested;
      }

      const linkedConn = target.connectionId
        ? validatedConnections.get(target.connectionId)
        : undefined;
      const linkedConnLocale =
        isSupportedLocale(linkedConn?.targetLocale) &&
        marketAllowedSet.has(linkedConn.targetLocale.trim())
          ? (linkedConn.targetLocale.trim() as SupportedLocale)
          : null;

      if (
        explicitLocale === null &&
        linkedConnLocale &&
        !effectiveSupportedSet.has(linkedConnLocale)
      ) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          `所选渠道连接的目标语种 ${linkedConnLocale} 未在当前品牌市场支持的语种范围内`,
        );
      }

      const fallbackArticleLocale =
        articleLocale && effectiveSupportedSet.has(articleLocale) ? articleLocale : null;
      const effectiveLocale: SupportedLocale =
        explicitLocale ?? linkedConnLocale ?? fallbackArticleLocale ?? defaultFallbackLocale;

      resolvedLocales.push(effectiveLocale);
      if (!target.connectionId && isL1ChannelProvider(target.provider)) {
        providersNeedingAutoMatch.add(target.provider);
      }
    }

    const activeConnectionsByProvider = new Map<string, ValidatedConnectionRow[]>();
    if (
      providersNeedingAutoMatch.size > 0 &&
      typeof this.prisma.scoped.channelConnection?.findMany === 'function'
    ) {
      const candidates = await this.prisma.scoped.channelConnection.findMany({
        where: {
          brandId: article.brandId,
          brandMarketId: article.brandMarketId,
          provider: { in: [...providersNeedingAutoMatch] },
          status: 'ACTIVE',
        },
        select: {
          id: true,
          provider: true,
          displayName: true,
          status: true,
          configJson: true,
          targetLocale: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      });
      for (const conn of candidates) {
        const list = activeConnectionsByProvider.get(conn.provider) ?? [];
        list.push(conn);
        activeConnectionsByProvider.set(conn.provider, list);
      }
    }

    const normalizedTargets: DistributionVariantTargetInput[] = targets.map((target, index) => {
      const effectiveLocale = resolvedLocales[index]!;
      let resolvedConnectionId = target.connectionId;
      if (!resolvedConnectionId && isL1ChannelProvider(target.provider)) {
        const providerConns = activeConnectionsByProvider.get(target.provider) ?? [];
        const matchedConn = providerConns.find(
          (conn) => isSupportedLocale(conn.targetLocale) && conn.targetLocale === effectiveLocale,
        );
        if (matchedConn) {
          resolvedConnectionId = matchedConn.id;
          validatedConnections.set(matchedConn.id, matchedConn);
        }
      }
      return {
        ...target,
        ...(resolvedConnectionId ? { connectionId: resolvedConnectionId } : {}),
        targetLocale: effectiveLocale,
      };
    });

    return { normalizedTargets, validatedConnections };
  }

  private async validateTargetConnections(
    article: { brandId: string; brandMarketId: string },
    targets: readonly DistributionVariantTargetInput[],
    options?: { allowMissing?: boolean },
  ): Promise<Map<string, ValidatedConnectionRow>> {
    const validatedConnections = new Map<string, ValidatedConnectionRow>();
    for (const target of targets) {
      if (!target.connectionId) continue;
      if (validatedConnections.has(target.connectionId)) {
        const cached = validatedConnections.get(target.connectionId)!;
        if (cached.provider !== target.provider) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接类型与目标分发渠道不匹配');
        }
        continue;
      }
      const conn = await this.prisma.scoped.channelConnection.findFirst({
        where: { id: target.connectionId },
        select: {
          id: true,
          brandId: true,
          brandMarketId: true,
          provider: true,
          displayName: true,
          status: true,
          configJson: true,
          targetLocale: true,
        },
      });
      if (!conn) {
        if (options?.allowMissing) continue;
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '目标渠道连接不存在');
      }
      if (conn.brandId !== article.brandId || conn.brandMarketId !== article.brandMarketId) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接与当前文章所属品牌市场不匹配');
      }
      if (conn.provider !== target.provider) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接类型与目标分发渠道不匹配');
      }
      if (conn.status === 'DISABLED') {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '该渠道连接已停用，请先启用或更换连接');
      }
      validatedConnections.set(conn.id, conn);
    }
    return validatedConnections;
  }

  private async executeTargetsBatch(params: {
    tenantId: string;
    article: {
      id: string;
      brandId: string;
      brandMarketId: string;
      targetLocale?: string | null;
      title: string;
      targetPrompt: string;
      contentMarkdown: string;
      schemaJsonLd: Prisma.JsonValue;
      llmsTxtSnippet: string | null;
      geoScore: number;
      brand: { id: string; name: string; category: string };
      brandMarket: {
        id: string;
        market: string;
        locale: string;
        supportedLocales?: string[];
        localBrandName: string | null;
        localCategory: string | null;
        aliases: string[];
        ownedDomains: string[];
        competitors: Prisma.JsonValue;
      };
      brief: {
        id: string;
        targetFanOuts: string[];
        competitorFocus: string[];
        matchedFactIds: string[];
        recommendedChannels: Prisma.JsonValue;
      } | null;
    };
    targets: readonly DistributionVariantTargetInput[];
    validatedConnections: Map<string, ValidatedConnectionRow>;
    facts: VariantBrandFactInput[];
    customForbiddenWords: string[];
    customToneNote: string | null;
    brandNames: string[];
    market: GeoMarket;
    locale: string;
    marketCompetitors: string[];
    competitorFocus: string[];
    targetFanOuts: string[];
    articleSchemaObj: Record<string, unknown>;
    matchedFactCount: number;
    batchRefId: string;
    unitPrice: number;
    reservationId: string | null;
    reservationShadow: boolean;
    normalizedIdempotencyKey?: string;
    requestFingerprint?: string;
    signal?: AbortSignal;
    onProgress?: (snapshot: {
      doneCount: number;
      failCount: number;
      totalChargedPoints: number;
      refundedCount: number;
      refundedPoints: number;
      taskIds: string[];
      failures: GenerateVariantsFailureItem[];
      lastError: string | null;
    }) => void;
  }): Promise<{
    tasks: GeoDistributionTaskDto[];
    failures: GenerateVariantsFailureItem[];
    totalChargedPoints: number;
    refundedCount: number;
    refundedPoints: number;
    firstFatalError: ApiError | null;
  }> {
    const {
      tenantId,
      article,
      targets,
      validatedConnections,
      facts,
      customForbiddenWords,
      customToneNote,
      brandNames,
      market,
      locale,
      marketCompetitors,
      competitorFocus,
      targetFanOuts,
      articleSchemaObj,
      matchedFactCount,
      batchRefId,
      unitPrice,
      reservationId,
      reservationShadow,
      normalizedIdempotencyKey,
      requestFingerprint,
      signal,
      onProgress,
    } = params;

    const taskSlots: Array<GeoDistributionTaskDto | undefined> = Array.from(
      { length: targets.length },
      () => undefined,
    );
    const failureSlots: Array<GenerateVariantsFailureItem | undefined> = Array.from(
      { length: targets.length },
      () => undefined,
    );
    const fatalSlots: Array<ApiError | undefined> = Array.from(
      { length: targets.length },
      () => undefined,
    );
    let totalChargedPoints = 0;
    let refundedCount = 0;
    let refundedPoints = 0;

    const concurrency = readGeoVariantConcurrency();
    const channelTimeoutMs = readGeoVariantChannelTimeoutMs();

    const emitProgress = () => {
      if (!onProgress) return;
      const orderedTasks = taskSlots.filter((t): t is GeoDistributionTaskDto => Boolean(t));
      const orderedFailures = failureSlots.filter((f): f is GenerateVariantsFailureItem =>
        Boolean(f),
      );
      onProgress({
        doneCount: orderedTasks.length,
        failCount: orderedFailures.length,
        totalChargedPoints,
        refundedCount,
        refundedPoints,
        taskIds: orderedTasks.map((t) => t.id),
        failures: orderedFailures,
        lastError: orderedFailures[0]?.error ?? null,
      });
    };

    try {
      const marketAllowedSet = new Set<string>(supportedLocalesForMarket(market));
      await runWithConcurrency(targets, concurrency, async (target, i) => {
        const templateKey = resolveVariantTemplateKey(target);
        const unitKey = `geo_var:${batchRefId}:${i}`;
        const citedExampleUrls = extractCitedUrlsForTarget(
          article.brief?.recommendedChannels,
          target,
        );
        const linkedConn = target.connectionId
          ? validatedConnections.get(target.connectionId)
          : undefined;
        const explicitLocale =
          isSupportedLocale(target.targetLocale) && marketAllowedSet.has(target.targetLocale)
            ? target.targetLocale
            : null;
        const linkedConnLocale =
          isSupportedLocale(linkedConn?.targetLocale) &&
          marketAllowedSet.has(linkedConn.targetLocale)
            ? linkedConn.targetLocale
            : null;
        const articleLocale =
          isSupportedLocale(article.targetLocale) && marketAllowedSet.has(article.targetLocale)
            ? article.targetLocale
            : null;
        const effectiveTargetLocale: SupportedLocale =
          templateKey === 'WECHAT_OFFICIAL_ARTICLE' || templateKey === 'CN_COMMUNITY_QA'
            ? 'zh-CN'
            : (explicitLocale ??
              linkedConnLocale ??
              articleLocale ??
              resolveEffectiveLocale(locale, market));

        const promptCtx: VariantPromptContext = {
          market,
          locale: effectiveTargetLocale,
          targetLocale: effectiveTargetLocale,
          articleTargetLocale: article.targetLocale ?? article.brandMarket.locale,
          brandName: article.brand.name,
          localBrandName: article.brandMarket.localBrandName || article.brand.name,
          brandAliases: article.brandMarket.aliases ?? [],
          category: article.brand.category,
          localCategory: article.brandMarket.localCategory ?? null,
          ownedDomains: article.brandMarket.ownedDomains ?? [],
          competitors: marketCompetitors,
          articleTitle: article.title,
          targetPrompt: article.targetPrompt,
          masterMarkdown: article.contentMarkdown,
          articleSchemaJsonLd: Object.keys(articleSchemaObj).length > 0 ? articleSchemaObj : null,
          articleLlmsTxtSnippet: article.llmsTxtSnippet ?? null,
          facts,
          targetFanOuts,
          competitorFocus,
          citedExampleUrls,
          provider: target.provider,
          templateKey,
          channelLabel: target.channelLabel,
          targetUrlHint: target.targetUrlHint ?? null,
          customToneNote,
          customForbiddenWords,
        };

        try {
          const { draft, model, tokensIn, tokensOut } = await withChannelTimeout(
            channelTimeoutMs,
            signal,
            (channelSignal) =>
              this.generateSingleVariantDraft(
                tenantId,
                batchRefId,
                i,
                promptCtx,
                reservationShadow,
                channelSignal,
                channelTimeoutMs,
              ),
          );

          // 双轨合规扫描（禁做行业拦截；广告法/自定义禁用词清洗后重新渲染 HTML、同步摘要长度、线程文案与 JSON-LD）
          const titleScan = this.compliance.scan(draft.variantTitle, {
            market,
            customForbiddenWords,
          });
          const bodyScan = this.compliance.scan(draft.variantMarkdown, {
            market,
            customForbiddenWords,
          });
          const metaScan = draft.variantMetaDesc
            ? this.compliance.scan(draft.variantMetaDesc, {
                market,
                customForbiddenWords,
              })
            : null;

          if (titleScan.blocked || bodyScan.blocked || metaScan?.blocked) {
            throw new ApiError(
              403,
              API_ERROR.FORBIDDEN_INDUSTRY,
              '生成的渠道变体包含禁做行业或敏感内容',
            );
          }

          let sanitizedTitle = titleScan.text.trim() || draft.variantTitle;
          if (templateKey === 'WECHAT_OFFICIAL_ARTICLE') {
            sanitizedTitle = clampWechatTitle(sanitizedTitle, draft.variantTitle);
          }
          const sanitizedMarkdown = bodyScan.text.trim() || draft.variantMarkdown;
          let sanitizedMetaDesc = metaScan
            ? metaScan.text.trim() || draft.variantMetaDesc
            : draft.variantMetaDesc;
          const complianceFlags: GeoComplianceFlag[] = [
            ...titleScan.geoFlags,
            ...bodyScan.geoFlags,
            ...(metaScan?.geoFlags ?? []),
          ];

          // SOCIAL_THREAD: 逐条扫描 threadPosts，避免禁用词或广告法极限词残留在拆分帖中
          let sanitizedThreadPosts = draft.variantExtrasJson.threadPosts;
          if (
            templateKey === 'SOCIAL_THREAD' &&
            Array.isArray(sanitizedThreadPosts) &&
            sanitizedThreadPosts.length > 0
          ) {
            const nextPosts: string[] = [];
            for (const post of sanitizedThreadPosts) {
              const postScan = this.compliance.scan(post, {
                market,
                customForbiddenWords,
              });
              if (postScan.blocked) {
                throw new ApiError(
                  403,
                  API_ERROR.FORBIDDEN_INDUSTRY,
                  '生成的渠道变体包含禁做行业或敏感内容',
                );
              }
              nextPosts.push(postScan.text.trim() || post);
              complianceFlags.push(...postScan.geoFlags);
            }
            sanitizedThreadPosts = nextPosts;
          }

          // OWNED_BLOG_SEO_GEO & DEVELOPER_TECH_POST: 合规替换可能导致摘要长度漂移出 140..160 区间，需重新规整并二次扫描
          if (templateKey === 'OWNED_BLOG_SEO_GEO' || templateKey === 'DEVELOPER_TECH_POST') {
            const metaChanged = sanitizedMetaDesc !== draft.variantMetaDesc;
            const metaOutOfRange =
              !sanitizedMetaDesc ||
              sanitizedMetaDesc.length < 140 ||
              sanitizedMetaDesc.length > 160;
            if (metaChanged || metaOutOfRange) {
              let reNormalized = normalizeVariantMetaDesc(
                sanitizedMetaDesc,
                promptCtx,
                sanitizedMarkdown,
              );
              const reScan = this.compliance.scan(reNormalized, {
                market,
                customForbiddenWords,
              });
              if (reScan.blocked) {
                throw new ApiError(
                  403,
                  API_ERROR.FORBIDDEN_INDUSTRY,
                  '生成的渠道变体包含禁做行业或敏感内容',
                );
              }
              reNormalized = reScan.text.trim() || reNormalized;
              if (reNormalized.length < 140) {
                const neutralPad = getLocaleNeutralMetaPad(effectiveTargetLocale);
                while (reNormalized.length < 140) {
                  reNormalized = `${reNormalized}${neutralPad}`;
                }
              }
              if (reNormalized.length > 160) {
                reNormalized = sliceUtf16Safe(reNormalized, 160);
              }
              sanitizedMetaDesc = reNormalized;
            }
          } else if (templateKey === 'WECHAT_OFFICIAL_ARTICLE') {
            sanitizedMetaDesc = normalizeWechatDigest(
              sanitizedMetaDesc,
              promptCtx,
              sanitizedMarkdown,
            );
          }

          const sanitizedHtml = renderVariantHtml(sanitizedMarkdown, templateKey);

          // OWNED_BLOG_SEO_GEO & DEVELOPER_TECH_POST: 若标题或正文经合规清洗，按需重建未复用母稿的 JSON-LD / llmsTxtSnippet
          let finalSchemaJsonLd = draft.variantExtrasJson.schemaJsonLd;
          let finalJsonLdSnippet = draft.variantExtrasJson.jsonLdSnippet;
          let finalLlmsTxtSnippet = draft.variantExtrasJson.llmsTxtSnippet;
          if (templateKey === 'OWNED_BLOG_SEO_GEO' || templateKey === 'DEVELOPER_TECH_POST') {
            const titleOrBodyChanged =
              sanitizedTitle !== draft.variantTitle || sanitizedMarkdown !== draft.variantMarkdown;
            const needsSchemaRebuild = !draft.schemaReusedFromArticle;
            const needsLlmsRebuild = !draft.llmsReusedFromArticle;
            if (titleOrBodyChanged && (needsSchemaRebuild || needsLlmsRebuild)) {
              const rebuilt = buildOwnedBlogExtras(promptCtx, sanitizedTitle, sanitizedMarkdown, {
                forceRebuildSchema: needsSchemaRebuild,
                forceRebuildLlmsTxt: needsLlmsRebuild,
              });
              if (needsSchemaRebuild) {
                finalSchemaJsonLd = rebuilt.schemaJsonLd;
                finalJsonLdSnippet = rebuilt.jsonLdSnippet;
              }
              if (needsLlmsRebuild) {
                finalLlmsTxtSnippet = rebuilt.llmsTxtSnippet;
              }
            }
            if (typeof finalLlmsTxtSnippet === 'string' && finalLlmsTxtSnippet.length > 0) {
              const llmsScan = this.compliance.scan(finalLlmsTxtSnippet, {
                market,
                customForbiddenWords,
              });
              if (llmsScan.blocked) {
                throw new ApiError(
                  403,
                  API_ERROR.FORBIDDEN_INDUSTRY,
                  '生成的渠道变体包含禁做行业或敏感内容',
                );
              }
              complianceFlags.push(...llmsScan.geoFlags);
              const cleanedLlms = llmsScan.text.trim();
              if (cleanedLlms.length > 0) {
                finalLlmsTxtSnippet = cleanedLlms;
              } else {
                const rebuiltClean = buildOwnedBlogExtras(
                  promptCtx,
                  sanitizedTitle,
                  sanitizedMarkdown,
                  {
                    forceRebuildSchema: false,
                    forceRebuildLlmsTxt: true,
                  },
                );
                const rebuiltScan = this.compliance.scan(rebuiltClean.llmsTxtSnippet ?? '', {
                  market,
                  customForbiddenWords,
                });
                if (rebuiltScan.blocked) {
                  throw new ApiError(
                    403,
                    API_ERROR.FORBIDDEN_INDUSTRY,
                    '生成的渠道变体包含禁做行业或敏感内容',
                  );
                }
                complianceFlags.push(...rebuiltScan.geoFlags);
                finalLlmsTxtSnippet = rebuiltScan.text.trim() || null;
              }
            }
          }

          const dedupedComplianceFlags = dedupeComplianceFlags(complianceFlags);

          const variantExtras: DistributionVariantExtras = {
            ...draft.variantExtrasJson,
            ...(finalSchemaJsonLd !== undefined ? { schemaJsonLd: finalSchemaJsonLd } : {}),
            ...(finalJsonLdSnippet !== undefined ? { jsonLdSnippet: finalJsonLdSnippet } : {}),
            ...(finalLlmsTxtSnippet !== undefined ? { llmsTxtSnippet: finalLlmsTxtSnippet } : {}),
            ...(sanitizedThreadPosts !== undefined ? { threadPosts: sanitizedThreadPosts } : {}),
            ...(templateKey === 'WECHAT_OFFICIAL_ARTICLE' && sanitizedMetaDesc
              ? { digest: sanitizedMetaDesc }
              : {}),
            templateKey,
            targetLocale: effectiveTargetLocale,
            model,
            tokensIn,
            tokensOut,
            complianceFlags: dedupedComplianceFlags,
          };

          const storedExtras: Record<string, unknown> = {
            ...variantExtras,
            ...(requestFingerprint ? { _idempotencyFingerprint: requestFingerprint } : {}),
          };

          const preflight = evaluateDistributionPreflight({
            market,
            targetLocale: effectiveTargetLocale,
            title: sanitizedTitle,
            contentMarkdown: sanitizedMarkdown,
            variantHtml: sanitizedHtml,
            brandNames,
            complianceFlags: dedupedComplianceFlags,
            geoScore: article.geoScore,
            matchedFactCount,
            provider: target.provider,
            variantSlug: draft.variantSlug,
            variantMetaDesc: sanitizedMetaDesc,
          });

          const publishAsDraft =
            target.provider === 'WECHAT_OFFICIAL'
              ? true
              : (target.publishAsDraft ??
                readConnectionDefaultDraft(linkedConn?.configJson) ??
                true);
          const deterministicId = normalizedIdempotencyKey
            ? deriveDeterministicTaskId(tenantId, article.id, normalizedIdempotencyKey, i)
            : undefined;

          const createdRow = await this.prisma.scoped.geoDistributionTask.create({
            data: {
              ...(deterministicId ? { id: deterministicId } : {}),
              tenantId,
              brandId: article.brandId,
              brandMarketId: article.brandMarketId,
              articleId: article.id,
              connectionId: target.connectionId ?? null,
              provider: target.provider,
              mode: defaultDistributionModeForProvider(target.provider),
              channelLabel: target.channelLabel,
              targetLocale: effectiveTargetLocale,
              targetUrlHint: target.targetUrlHint ?? null,
              variantTitle: sanitizedTitle,
              variantSlug: draft.variantSlug,
              variantMetaDesc: sanitizedMetaDesc,
              variantMarkdown: sanitizedMarkdown,
              variantHtml: sanitizedHtml,
              variantExtrasJson: storedExtras as unknown as Prisma.InputJsonValue,
              preflightJson: preflight as unknown as Prisma.InputJsonValue,
              status: 'DRAFT_VARIANT',
              publishAsDraft,
            },
          });

          if (reservationId) {
            try {
              await this.billing.settle({
                tenantId,
                reservationId,
                unitKey,
                action: 'geo_variant',
                amount: unitPrice,
                title: formatSettleTitle(target.channelLabel),
                detail: {
                  articleId: article.id,
                  taskId: createdRow.id,
                  provider: target.provider,
                  templateKey,
                  targetLocale: effectiveTargetLocale,
                },
              });
              totalChargedPoints += unitPrice;
            } catch (settleErr) {
              await this.prisma.scoped.geoDistributionTask
                .delete({ where: { id: createdRow.id } })
                .catch(() => undefined);
              throw settleErr;
            }
          }

          taskSlots[i] = presentDistributionTask(createdRow as GeoDistributionTaskRow);
          emitProgress();
        } catch (targetErr) {
          fatalSlots[i] = mapFatalError(targetErr);
          failureSlots[i] = {
            index: i,
            provider: target.provider,
            channelLabel: target.channelLabel,
            templateKey,
            error: sanitizeFailureMessage(targetErr),
          };
          this.logger.warn(
            `variant generation failed article=${article.id} targetIndex=${i} provider=${target.provider}: ${sanitizeFailureMessage(targetErr)}`,
          );

          if (reservationId) {
            try {
              await this.billing.releaseUnit({
                tenantId,
                reservationId,
                unitKey,
                amount: unitPrice,
                title: '渠道变体生成失败退还',
              });
              refundedCount += 1;
              refundedPoints += unitPrice;
            } catch (releaseErr) {
              this.logger.warn(
                `variant releaseUnit failed article=${article.id} targetIndex=${i} unitKey=${unitKey}: ${sanitizeFailureMessage(releaseErr)}`,
              );
            }
          }
          emitProgress();
        }
      });
    } finally {
      if (reservationId) {
        await this.billing
          .close({
            tenantId,
            reservationId,
          })
          .catch(() => undefined);
      }
    }

    const tasks = taskSlots.filter((t): t is GeoDistributionTaskDto => Boolean(t));
    const failures = failureSlots.filter((f): f is GenerateVariantsFailureItem => Boolean(f));
    const firstFatalError = fatalSlots.find((e): e is ApiError => Boolean(e)) ?? null;

    return {
      tasks,
      failures,
      totalChargedPoints,
      refundedCount,
      refundedPoints,
      firstFatalError,
    };
  }

  private async generateSingleVariantDraft(
    tenantId: string,
    batchRefId: string,
    targetIndex: number,
    ctx: VariantPromptContext,
    reservationShadow: boolean,
    signal?: AbortSignal,
    channelTimeoutMs: number = DEFAULT_GEO_VARIANT_CHANNEL_TIMEOUT_MS,
  ): Promise<{
    draft: GeneratedVariantDraft;
    model: string;
    tokensIn: number;
    tokensOut: number;
  }> {
    let lastParseError: unknown = null;
    const deadlineAt = Date.now() + channelTimeoutMs;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const llmKey =
        attempt === 0 ? `gv:${batchRefId}:${targetIndex}` : `gv:${batchRefId}:${targetIndex}:r1`;
      const remainingTimeoutMs = Math.max(1_000, deadlineAt - Date.now());

      const completion = await this.llm.complete({
        tenantId,
        scene: 'geo_rewrite',
        messages: buildVariantPromptMessages(ctx, attempt > 0),
        idempotencyKey: llmKey,
        signal,
        timeoutMs: remainingTimeoutMs,
        temperature: 0.3,
        maxTokens: 3200,
        disableThinking: true,
      });

      assertCompletionAllowed({
        completion,
        llm: this.llm,
        scene: 'geo_rewrite',
        reservationShadow,
      });

      if (completion.fake) {
        return {
          draft: buildDeterministicFakeVariantDraft(ctx),
          model: completion.model,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
        };
      }

      try {
        const draft = finalizeRealLlmVariantDraft(completion.text, ctx);
        return {
          draft,
          model: completion.model,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
        };
      } catch (err) {
        lastParseError = err;
        // 格式异常或 GLOBAL 中文字符泄漏时自动纠正重试 1 次
        this.logger.warn(
          `variant draft attempt ${attempt + 1}/2 failed (${ctx.provider}/${ctx.templateKey}, locale=${ctx.targetLocale ?? ctx.market}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (lastParseError instanceof VariantGlobalCjkLeakError) {
      throw lastParseError;
    }
    throw new ApiError(
      502,
      API_ERROR.UPSTREAM_UNAVAILABLE,
      '大模型返回的渠道变体格式异常，未降级假模板，请稍后重试',
    );
  }
}
