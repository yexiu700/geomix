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
  createDistributionVariantsSchema,
  defaultDistributionModeForProvider,
  defaultTemplateKeyForProvider,
  distributionPreflightResultSchema,
  evaluateDistributionPreflight,
  isSafeDistributionHttpUrl,
  markdownToSanitizedHtml,
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
import { ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  VariantGlobalCjkLeakError,
  buildDeterministicFakeVariantDraft,
  buildOwnedBlogExtras,
  buildVariantPromptMessages,
  finalizeRealLlmVariantDraft,
  normalizeVariantMetaDesc,
  resolveVariantTemplateKey,
  sliceUtf16Safe,
  type DistributionVariantExtras,
  type GeneratedVariantDraft,
  type VariantBrandFactInput,
  type VariantPromptContext,
} from './variant-templates';

const DEFAULT_GEO_VARIANT_FREE_MAX = 20;
const DEFAULT_GEO_VARIANT_FREE_WINDOW_SECONDS = 60;
const MAX_TARGETS_PER_BATCH = 10;

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);
const DISTRIBUTION_MODE_SET = new Set<string>(DISTRIBUTION_MODES);
const DISTRIBUTION_TASK_STATUS_SET = new Set<string>(DISTRIBUTION_TASK_STATUSES);

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function readStoredTemplateKey(row: GeoDistributionTaskRow): DistributionTemplateKey {
  const extras = asJsonRecord(row.variantExtrasJson);
  const raw = extras.templateKey;
  if (
    raw === 'OWNED_BLOG_SEO_GEO' ||
    raw === 'REDDIT_DISCUSSION' ||
    raw === 'QUORA_ANSWER' ||
    raw === 'SOCIAL_THREAD' ||
    raw === 'PR_MEDIA_PACKET' ||
    raw === 'CN_COMMUNITY_QA'
  ) {
    return raw;
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

    // 2. 校验所有指定 connectionId 的存在性、品牌市场归属、provider 一致性与启用状态
    const validatedConnections = new Map<
      string,
      {
        id: string;
        provider: string;
        displayName: string;
        status: string;
        configJson: Prisma.JsonValue;
      }
    >();
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
        },
      });
      if (!conn) {
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

    const requestFingerprint = normalizedIdempotencyKey
      ? computeVariantBatchFingerprint(targets)
      : undefined;

    // 3. 幂等重放检测（必须在计费预扣与 LLM 调用之前执行！）
    if (normalizedIdempotencyKey) {
      const slotCount = Math.max(targets.length, MAX_TARGETS_PER_BATCH);
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
            if (slotIdx < 0 || slotIdx >= targets.length) {
              return false;
            }
            const target = targets[slotIdx]!;
            return (
              row.provider === target.provider &&
              row.channelLabel === target.channelLabel &&
              readStoredTemplateKey(row) === resolveVariantTemplateKey(target) &&
              (row.connectionId ?? null) === (target.connectionId ?? null) &&
              (row.targetUrlHint ?? null) === (target.targetUrlHint ?? null)
            );
          });
        } else {
          isExactMatch =
            orderedExisting.length === targets.length &&
            targets.every((target, index) => {
              const existing = orderedExisting[index];
              if (!existing) return false;
              const expectedId = candidateIds[index];
              return (
                existing.id === expectedId &&
                existing.provider === target.provider &&
                existing.channelLabel === target.channelLabel &&
                readStoredTemplateKey(existing) === resolveVariantTemplateKey(target) &&
                (existing.connectionId ?? null) === (target.connectionId ?? null) &&
                (existing.targetUrlHint ?? null) === (target.targetUrlHint ?? null)
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

    const tasks: GeoDistributionTaskDto[] = [];
    const failures: GenerateVariantsFailureItem[] = [];
    let totalChargedPoints = 0;
    let refundedCount = 0;
    let refundedPoints = 0;
    let firstFatalError: ApiError | null = null;

    try {
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i]!;
        const templateKey = resolveVariantTemplateKey(target);
        const unitKey = `geo_var:${batchRefId}:${i}`;
        const citedExampleUrls = extractCitedUrlsForTarget(
          article.brief?.recommendedChannels,
          target,
        );

        const promptCtx: VariantPromptContext = {
          market,
          locale,
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
          const { draft, model, tokensIn, tokensOut } = await this.generateSingleVariantDraft(
            auth.tenantId,
            batchRefId,
            i,
            promptCtx,
            reservationShadow,
            signal,
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

          const sanitizedTitle = titleScan.text.trim() || draft.variantTitle;
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

          // OWNED_BLOG_SEO_GEO: 合规替换可能导致摘要长度漂移出 140..160 区间，需重新规整并二次扫描
          if (templateKey === 'OWNED_BLOG_SEO_GEO') {
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
                const neutralPad =
                  market === 'GLOBAL'
                    ? ' Objective reference metrics and spec summary.'
                    : ' 客观参考数据与规格对照说明。';
                while (reNormalized.length < 140) {
                  reNormalized = `${reNormalized}${neutralPad}`;
                }
              }
              if (reNormalized.length > 160) {
                reNormalized = sliceUtf16Safe(reNormalized, 160);
              }
              sanitizedMetaDesc = reNormalized;
            }
          }

          const sanitizedHtml = markdownToSanitizedHtml(sanitizedMarkdown);

          // OWNED_BLOG_SEO_GEO: 若标题或正文经合规清洗，按需重建未复用母稿的 JSON-LD / llmsTxtSnippet，并对最终 llmsTxtSnippet（含母稿复用）无条件做合规扫描
          let finalSchemaJsonLd = draft.variantExtrasJson.schemaJsonLd;
          let finalJsonLdSnippet = draft.variantExtrasJson.jsonLdSnippet;
          let finalLlmsTxtSnippet = draft.variantExtrasJson.llmsTxtSnippet;
          if (templateKey === 'OWNED_BLOG_SEO_GEO') {
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
            templateKey,
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
            title: sanitizedTitle,
            contentMarkdown: sanitizedMarkdown,
            brandNames,
            complianceFlags: dedupedComplianceFlags,
            geoScore: article.geoScore,
            matchedFactCount,
            provider: target.provider,
            variantSlug: draft.variantSlug,
            variantMetaDesc: sanitizedMetaDesc,
          });

          const linkedConn = target.connectionId
            ? validatedConnections.get(target.connectionId)
            : undefined;
          const publishAsDraft =
            target.publishAsDraft ?? readConnectionDefaultDraft(linkedConn?.configJson) ?? true;
          const deterministicId = normalizedIdempotencyKey
            ? deriveDeterministicTaskId(auth.tenantId, article.id, normalizedIdempotencyKey, i)
            : undefined;

          const createdRow = await this.prisma.scoped.geoDistributionTask.create({
            data: {
              ...(deterministicId ? { id: deterministicId } : {}),
              tenantId: auth.tenantId,
              brandId: article.brandId,
              brandMarketId: article.brandMarketId,
              articleId: article.id,
              connectionId: target.connectionId ?? null,
              provider: target.provider,
              mode: defaultDistributionModeForProvider(target.provider),
              channelLabel: target.channelLabel,
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

          if (reservation) {
            try {
              await this.billing.settle({
                tenantId: auth.tenantId,
                reservationId: reservation.id,
                unitKey,
                action: 'geo_variant',
                amount: unitPrice,
                title: formatSettleTitle(target.channelLabel),
                detail: {
                  articleId: article.id,
                  taskId: createdRow.id,
                  provider: target.provider,
                  templateKey,
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

          tasks.push(presentDistributionTask(createdRow as GeoDistributionTaskRow));
        } catch (targetErr) {
          const fatal = mapFatalError(targetErr);
          if (!firstFatalError) {
            firstFatalError = fatal;
          }
          failures.push({
            index: i,
            provider: target.provider,
            channelLabel: target.channelLabel,
            templateKey,
            error: sanitizeFailureMessage(targetErr),
          });
          this.logger.warn(
            `variant generation failed article=${article.id} targetIndex=${i} provider=${target.provider}: ${sanitizeFailureMessage(targetErr)}`,
          );

          if (reservation) {
            try {
              await this.billing.releaseUnit({
                tenantId: auth.tenantId,
                reservationId: reservation.id,
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
        }
      }
    } finally {
      if (reservation) {
        await this.billing
          .close({
            tenantId: auth.tenantId,
            reservationId: reservation.id,
          })
          .catch(() => undefined);
      }
    }

    if (tasks.length === 0 && failures.length > 0) {
      throw (
        firstFatalError ??
        new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, '渠道变体生成失败，请稍后重试')
      );
    }

    return {
      articleId: article.id,
      unitPrice,
      totalChargedPoints,
      refundedCount,
      refundedPoints,
      reservationId: reservation?.id ?? null,
      billingMode,
      replayed: false,
      tasks,
      failures,
    };
  }

  private async generateSingleVariantDraft(
    tenantId: string,
    batchRefId: string,
    targetIndex: number,
    ctx: VariantPromptContext,
    reservationShadow: boolean,
    signal?: AbortSignal,
  ): Promise<{
    draft: GeneratedVariantDraft;
    model: string;
    tokensIn: number;
    tokensOut: number;
  }> {
    let lastParseError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const llmKey =
        attempt === 0 ? `gv:${batchRefId}:${targetIndex}` : `gv:${batchRefId}:${targetIndex}:r1`;

      const completion = await this.llm.complete({
        tenantId,
        scene: 'geo_rewrite',
        messages: buildVariantPromptMessages(ctx, attempt > 0),
        idempotencyKey: llmKey,
        signal,
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
