import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  DEFAULT_PR_SHARE_TTL_DAYS,
  evaluateDistributionPreflight,
  extractPlainTextFromHtml,
  isL1ChannelProvider,
  markdownToSanitizedHtml,
  parseEnv,
  sanitizeRichArticleHtml,
  type ChannelProvider,
  type CreateDistributionVariantsInput,
  type CreatePrShareLinkInput,
  type DistributionPreflightResult,
  type GeoComplianceFlag,
  type GeoDistributionTaskDto,
  type GeoMarket,
  type GeoPublishRecordDto,
  type GeoRetestScheduleDto,
  type GeoVariantJobDto,
  type PublishDistributionTaskInput,
  type RetestScheduleConfigInput,
  type UpdateDistributionTaskInput,
} from '@geomix/shared';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { presentPublishRecord } from '../studio/studio.mapper';
import { CrawlProbeService } from './crawl-probe.service';
import { DISTRIBUTION_ENQUEUER, type DistributionEnqueuer } from './distribution.runner';
import {
  RetestSchedulerService,
  type ParsedRetestBudgetEstimateQuery,
  type RetestBudgetEstimateDto,
} from './retest-scheduler.service';
import {
  VariantGeneratorService,
  presentDistributionTask,
  type GenerateVariantsResult,
} from './variant-generator.service';

const DEFAULT_DISTRIBUTION_PREFLIGHT_MAX = 60;

type QuotaTx = Parameters<QuotaService['consume']>[3];
const DEFAULT_DISTRIBUTION_PREFLIGHT_WINDOW_SECONDS = 60;
const DEFAULT_PR_PACKET_SHARE_MAX = 30;
const DEFAULT_PR_PACKET_SHARE_WINDOW_SECONDS = 60;

const PUBLISHABLE_STATUSES = [
  'DRAFT_VARIANT',
  'READY_TO_PUBLISH',
  'DRAFT_PUSHED',
  'FAILED',
] as const;

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

export type DistributionAuthContext = {
  tenantId: string;
  userId?: string;
};

export type ArticlePreflightOverrides = {
  title?: string;
  contentMarkdown?: string;
  provider?: ChannelProvider | null;
  variantSlug?: string | null;
  variantMetaDesc?: string | null;
};

export type GeoDistributionTaskWithRecordsDto = GeoDistributionTaskDto & {
  publishRecords: GeoPublishRecordDto[];
};

export type PrShareLinkResultDto = {
  taskId: string;
  shareUrl: string;
  token: string;
  expiresAt: string;
  ttlDays: number;
};

export type RevokePrShareResultDto = {
  taskId: string;
  revoked: true;
  revokedAt: string;
};

export type UpdateRetestSchedulesResultDto = {
  publishRecordId: string;
  items: GeoRetestScheduleDto[];
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readDistributionPreflightRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(
    env.DISTRIBUTION_PREFLIGHT_RATE_LIMIT_MAX,
    DEFAULT_DISTRIBUTION_PREFLIGHT_MAX,
  );
  const windowSeconds = readPositiveInt(
    env.DISTRIBUTION_PREFLIGHT_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_DISTRIBUTION_PREFLIGHT_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readPrPacketShareRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.PR_PACKET_SHARE_RATE_LIMIT_MAX, DEFAULT_PR_PACKET_SHARE_MAX);
  const windowSeconds = readPositiveInt(
    env.PR_PACKET_SHARE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_PR_PACKET_SHARE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

function asJsonRecord(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function normalizeComplianceFlags(raw: Prisma.JsonValue | null | undefined): GeoComplianceFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoComplianceFlag[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.code === 'string' &&
      typeof obj.term === 'string' &&
      (obj.severity === 'blocked' ||
        obj.severity === 'warning' ||
        obj.severity === 'replaced' ||
        obj.severity === 'info') &&
      (obj.market === 'CN' || obj.market === 'GLOBAL') &&
      typeof obj.message === 'string'
    ) {
      out.push({
        code: obj.code as GeoComplianceFlag['code'],
        term: obj.term,
        severity: obj.severity,
        market: obj.market,
        message: obj.message,
      });
    }
  }
  return out;
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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function resolvePublicAppUrl(): string {
  try {
    const env = parseEnv();
    if (env.PUBLIC_APP_URL) {
      return env.PUBLIC_APP_URL;
    }
    const fallback = env.WEB_ORIGIN.split(',')[0]?.trim() || 'http://localhost:3000';
    return fallback.replace(/\/+$/, '');
  } catch {
    const rawPublic = process.env.PUBLIC_APP_URL?.trim();
    if (rawPublic) return rawPublic.replace(/\/+$/, '');
    const rawWebOrigin = process.env.WEB_ORIGIN?.split(',')[0]?.trim();
    if (rawWebOrigin) return rawWebOrigin.replace(/\/+$/, '');
    return 'http://localhost:3000';
  }
}

function collectBrandNames(
  brandName: string,
  localBrandName: string | null | undefined,
  aliases: readonly string[] | null | undefined,
): string[] {
  const out = new Set<string>();
  if (brandName.trim()) out.add(brandName.trim());
  if (localBrandName?.trim()) out.add(localBrandName.trim());
  for (const alias of aliases ?? []) {
    if (alias.trim()) out.add(alias.trim());
  }
  return [...out];
}

function computePublishFingerprint(
  taskId: string,
  connectionId: string | null,
  publishAsDraft: boolean,
): string {
  return sha256Hex(JSON.stringify({ taskId, connectionId, publishAsDraft }));
}

/**
 * M5 分发编排服务：
 * - 100% 使用 `prisma.scoped`，零 `prisma.base`
 * - 覆盖文章发前校验、变体列表/生成/编辑、L1 推送入队（含 422 阻断与 PUBLISH 额度原子扣减）、
 *   PR 外部协作令牌签发/吊销、手工抓测触发与复测日程配置
 */
@Injectable()
export class DistributionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(VariantGeneratorService) private readonly variantGenerator: VariantGeneratorService,
    @Inject(CrawlProbeService) private readonly crawlProbe: CrawlProbeService,
    @Inject(RetestSchedulerService) private readonly retestScheduler: RetestSchedulerService,
    @Optional() @Inject(FreeActionRateLimiter) private readonly rateLimiter?: FreeActionRateLimiter,
    @Optional() @Inject(DISTRIBUTION_ENQUEUER) private readonly enqueuer?: DistributionEnqueuer,
  ) {}

  async preflightArticle(
    articleId: string,
    auth: DistributionAuthContext,
    overrides?: ArticlePreflightOverrides,
  ): Promise<DistributionPreflightResult> {
    this.rateLimiter?.assertAllowed(
      'distribution_preflight',
      auth.tenantId,
      readDistributionPreflightRateLimit(),
    );

    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      include: {
        brand: {
          select: {
            name: true,
            facts: { select: { id: true } },
          },
        },
        brandMarket: {
          select: {
            market: true,
            localBrandName: true,
            aliases: true,
          },
        },
        brief: {
          select: {
            matchedFactIds: true,
          },
        },
      },
    });

    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或无权访问');
    }

    const market: GeoMarket = article.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const title = overrides?.title !== undefined ? overrides.title : article.title;
    const contentMarkdown =
      overrides?.contentMarkdown !== undefined
        ? overrides.contentMarkdown
        : article.contentMarkdown;
    const hasContentOverride =
      overrides?.title !== undefined || overrides?.contentMarkdown !== undefined;

    const brandNames = collectBrandNames(
      article.brand.name,
      article.brandMarket.localBrandName,
      article.brandMarket.aliases,
    );
    const matchedFactCount =
      article.brief && article.brief.matchedFactIds.length > 0
        ? article.brief.matchedFactIds.length
        : article.brand.facts.length;

    const variantMetaDesc = overrides?.variantMetaDesc ?? null;
    const liveFlags = [
      ...this.compliance.scan(title, { market }).geoFlags,
      ...this.compliance.scan(contentMarkdown, { market }).geoFlags,
      ...(variantMetaDesc?.trim()
        ? this.compliance.scan(variantMetaDesc, { market }).geoFlags
        : []),
    ];
    const combinedFlags = dedupeComplianceFlags(
      hasContentOverride
        ? liveFlags
        : [...normalizeComplianceFlags(article.complianceFlags), ...liveFlags],
    );

    return evaluateDistributionPreflight({
      market,
      title,
      contentMarkdown,
      brandNames,
      complianceFlags: combinedFlags,
      geoScore: article.geoScore,
      matchedFactCount,
      provider: overrides?.provider ?? null,
      variantSlug: overrides?.variantSlug ?? null,
      variantMetaDesc: overrides?.variantMetaDesc ?? null,
    });
  }

  async listArticleDistributions(
    articleId: string,
  ): Promise<{ items: GeoDistributionTaskWithRecordsDto[] }> {
    const article = await this.prisma.scoped.geoArticle.findFirst({
      where: { id: articleId },
      select: { id: true },
    });
    if (!article) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '文章不存在或无权访问');
    }

    const tasks = await this.prisma.scoped.geoDistributionTask.findMany({
      where: { articleId },
      include: {
        publishRecords: {
          include: {
            retestSchedules: {
              orderBy: { milestoneDay: 'asc' },
            },
          },
          orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const items: GeoDistributionTaskWithRecordsDto[] = tasks.map((row) => ({
      ...presentDistributionTask(row),
      publishRecords: row.publishRecords.map((pr) => presentPublishRecord(pr)),
    }));

    return { items };
  }

  async generateVariants(
    articleId: string,
    input: CreateDistributionVariantsInput,
    auth: DistributionAuthContext,
    idempotencyKey?: string,
  ): Promise<GenerateVariantsResult> {
    return this.variantGenerator.generateVariants(articleId, input, auth, { idempotencyKey });
  }

  async createVariantJob(
    articleId: string,
    input: CreateDistributionVariantsInput,
    auth: DistributionAuthContext,
    idempotencyKey?: string,
  ): Promise<GeoVariantJobDto> {
    return this.variantGenerator.createVariantJob(articleId, input, auth, { idempotencyKey });
  }

  async listVariantJobs(articleId: string): Promise<{ items: GeoVariantJobDto[] }> {
    return this.variantGenerator.listVariantJobs(articleId);
  }

  async getVariantJob(articleId: string, jobId: string): Promise<GeoVariantJobDto> {
    return this.variantGenerator.getVariantJob(articleId, jobId);
  }

  async updateTask(
    taskId: string,
    input: UpdateDistributionTaskInput,
  ): Promise<GeoDistributionTaskDto> {
    const existing = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: { id: taskId },
      include: {
        article: {
          select: {
            geoScore: true,
            complianceFlags: true,
            brief: { select: { matchedFactIds: true } },
          },
        },
        brand: {
          select: {
            name: true,
            facts: { select: { id: true } },
          },
        },
        brandMarket: {
          select: {
            market: true,
            localBrandName: true,
            aliases: true,
          },
        },
      },
    });

    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }

    if (existing.status === 'PUBLISHING') {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '任务正在推送中，暂不支持修改');
    }
    if (existing.status === 'ARCHIVED') {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '已归档的分发任务不支持修改或重新激活');
    }
    if (existing.status === 'PUBLISHED') {
      const definedKeys = Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      const isPureArchive =
        input.status === 'ARCHIVED' && definedKeys.length === 1 && definedKeys[0] === 'status';
      if (!isPureArchive) {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '已正式发布的分发任务仅支持归档，不支持修改内容或回退状态',
        );
      }
    }

    if (input.connectionId !== undefined && input.connectionId !== null) {
      if (!isL1ChannelProvider(existing.provider)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅 L1 API 渠道任务可绑定站点连接');
      }
      const conn = await this.prisma.scoped.channelConnection.findFirst({
        where: { id: input.connectionId },
      });
      if (!conn) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道连接不存在或无权访问');
      }
      if (conn.brandId !== existing.brandId || conn.brandMarketId !== existing.brandMarketId) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接与当前文章的品牌市场不匹配');
      }
      if (conn.provider !== existing.provider) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接类型与分发任务渠道不一致');
      }
      if (conn.status !== 'ACTIVE') {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '该渠道连接当前不可用，请先在品牌管理中测试并启用连接',
        );
      }
    }

    const nextTitle = input.variantTitle !== undefined ? input.variantTitle : existing.variantTitle;
    const nextSlug = input.variantSlug !== undefined ? input.variantSlug : existing.variantSlug;
    const nextMetaDesc =
      input.variantMetaDesc !== undefined ? input.variantMetaDesc : existing.variantMetaDesc;
    const nextMarkdown =
      input.variantMarkdown !== undefined ? input.variantMarkdown : existing.variantMarkdown;

    let nextHtml: string | undefined;
    if (input.variantHtml !== undefined) {
      nextHtml = sanitizeRichArticleHtml(input.variantHtml).contentHtml;
    } else if (input.variantMarkdown !== undefined) {
      nextHtml = markdownToSanitizedHtml(input.variantMarkdown);
    }

    const market: GeoMarket = existing.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const brandNames = collectBrandNames(
      existing.brand.name,
      existing.brandMarket.localBrandName,
      existing.brandMarket.aliases,
    );
    const matchedFactCount =
      existing.article.brief && existing.article.brief.matchedFactIds.length > 0
        ? existing.article.brief.matchedFactIds.length
        : existing.brand.facts.length;

    const effectiveHtml = nextHtml !== undefined ? nextHtml : existing.variantHtml;
    const htmlPlainText = extractPlainTextFromHtml(effectiveHtml);

    const liveFlags = dedupeComplianceFlags([
      ...this.compliance.scan(nextTitle, { market }).geoFlags,
      ...this.compliance.scan(nextMarkdown, { market }).geoFlags,
      ...(nextMetaDesc?.trim() ? this.compliance.scan(nextMetaDesc, { market }).geoFlags : []),
      ...(htmlPlainText ? this.compliance.scan(htmlPlainText, { market }).geoFlags : []),
    ]);

    const preflight = evaluateDistributionPreflight({
      market,
      title: nextTitle,
      contentMarkdown: nextMarkdown,
      variantHtml: effectiveHtml,
      brandNames,
      complianceFlags: liveFlags,
      geoScore: existing.article.geoScore,
      matchedFactCount,
      provider: existing.provider as ChannelProvider,
      variantSlug: nextSlug,
      variantMetaDesc: nextMetaDesc,
    });

    const data: Prisma.GeoDistributionTaskUncheckedUpdateInput = {
      preflightJson: preflight as unknown as Prisma.InputJsonValue,
    };

    if (input.variantTitle !== undefined) data.variantTitle = input.variantTitle;
    if (input.variantSlug !== undefined) data.variantSlug = input.variantSlug;
    if (input.variantMetaDesc !== undefined) data.variantMetaDesc = input.variantMetaDesc;
    if (input.variantMarkdown !== undefined) data.variantMarkdown = input.variantMarkdown;
    if (nextHtml !== undefined) data.variantHtml = nextHtml;
    if (input.channelLabel !== undefined) data.channelLabel = input.channelLabel;
    if (input.targetUrlHint !== undefined) data.targetUrlHint = input.targetUrlHint;
    if (input.publishAsDraft !== undefined) data.publishAsDraft = input.publishAsDraft;
    if (input.connectionId !== undefined) data.connectionId = input.connectionId;
    if (input.status !== undefined) data.status = input.status;
    if (input.status === 'ARCHIVED' && existing.shareTokenHash && existing.shareRevokedAt == null) {
      data.shareRevokedAt = new Date();
    }

    const updated = await this.prisma.scoped.geoDistributionTask.update({
      where: { id: existing.id },
      data,
    });

    return presentDistributionTask(updated);
  }

  async publishTask(
    taskId: string,
    input: PublishDistributionTaskInput,
    auth: DistributionAuthContext,
    idempotencyKey?: string,
  ): Promise<GeoDistributionTaskDto> {
    const task = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: { id: taskId },
      include: {
        article: {
          select: {
            geoScore: true,
            complianceFlags: true,
            brief: { select: { matchedFactIds: true } },
          },
        },
        brand: {
          select: {
            name: true,
            facts: { select: { id: true } },
          },
        },
        brandMarket: {
          select: {
            market: true,
            localBrandName: true,
            aliases: true,
          },
        },
      },
    });

    if (!task) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }

    const effectivePublishAsDraft = input.publishAsDraft ?? task.publishAsDraft;
    const effectiveConnectionId =
      input.connectionId !== undefined ? input.connectionId : task.connectionId;

    const existingExtras = asJsonRecord(task.variantExtrasJson);
    const fingerprint = computePublishFingerprint(
      task.id,
      effectiveConnectionId ?? null,
      effectivePublishAsDraft,
    );

    // 1. 幂等重放检查优先于状态机检查
    if (idempotencyKey && existingExtras._publishIdempotencyKey === idempotencyKey) {
      if (
        typeof existingExtras._publishRequestFingerprint === 'string' &&
        existingExtras._publishRequestFingerprint !== fingerprint
      ) {
        throw new ApiError(
          409,
          BILLING_ERROR.CONFLICT,
          '相同 Idempotency-Key 不能用于不同的发布参数',
        );
      }
      return presentDistributionTask(task);
    }

    // 2. 渠道与状态校验
    if (!isL1ChannelProvider(task.provider)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅 L1 API 渠道支持一键自动推送');
    }

    if (task.status === 'PUBLISHING') {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '该分发任务正在推送中，请勿重复提交');
    }
    if (task.status === 'PUBLISHED') {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '该分发任务已正式发布');
    }
    if (task.status === 'ARCHIVED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '已归档的分发任务无法推送');
    }
    if (!(PUBLISHABLE_STATUSES as readonly string[]).includes(task.status)) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '当前分发任务状态不支持推送');
    }

    // 3. L1 渠道连接校验
    if (!effectiveConnectionId) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请先选择有效的 L1 站点渠道连接');
    }
    const conn = await this.prisma.scoped.channelConnection.findFirst({
      where: { id: effectiveConnectionId },
    });
    if (!conn) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道连接不存在或无权访问');
    }
    if (conn.brandId !== task.brandId || conn.brandMarketId !== task.brandMarketId) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接与当前任务所属品牌市场不匹配');
    }
    if (conn.provider !== task.provider) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接类型与当前任务渠道不匹配');
    }
    if (conn.status !== 'ACTIVE') {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '该渠道连接当前不可用，请先在品牌管理中测试并启用连接',
      );
    }

    // 4. 实时发布前硬校验（默认 422 阻断，附带结构化 blockers/warnings/preflight）
    const market: GeoMarket = task.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const brandNames = collectBrandNames(
      task.brand.name,
      task.brandMarket.localBrandName,
      task.brandMarket.aliases,
    );
    const matchedFactCount =
      task.article.brief && task.article.brief.matchedFactIds.length > 0
        ? task.article.brief.matchedFactIds.length
        : task.brand.facts.length;

    const htmlPlainText = extractPlainTextFromHtml(task.variantHtml);

    const liveFlags = dedupeComplianceFlags([
      ...this.compliance.scan(task.variantTitle, { market }).geoFlags,
      ...this.compliance.scan(task.variantMarkdown, { market }).geoFlags,
      ...(task.variantMetaDesc?.trim()
        ? this.compliance.scan(task.variantMetaDesc, { market }).geoFlags
        : []),
      ...(htmlPlainText ? this.compliance.scan(htmlPlainText, { market }).geoFlags : []),
    ]);

    const preflight = evaluateDistributionPreflight({
      market,
      title: task.variantTitle,
      contentMarkdown: task.variantMarkdown,
      variantHtml: task.variantHtml,
      brandNames,
      complianceFlags: liveFlags,
      geoScore: task.article.geoScore,
      matchedFactCount,
      provider: task.provider,
      variantSlug: task.variantSlug,
      variantMetaDesc: task.variantMetaDesc,
    });

    if (!preflight.ok && !input.acknowledgePreflightWarnings) {
      const summary = preflight.blockers.map((b) => b.message).join('；');
      throw new ApiError(422, API_ERROR.BAD_REQUEST, `发布前校验未通过：${summary}`, undefined, {
        ok: false,
        blockers: preflight.blockers,
        warnings: preflight.warnings,
        preflight,
      });
    }

    // 5. 原子状态推进 + PUBLISH 累计额度扣减（100% prisma.scoped.$transaction）
    const nextExtras: Record<string, unknown> = {
      ...existingExtras,
      ...(idempotencyKey
        ? {
            _publishIdempotencyKey: idempotencyKey,
            _publishRequestFingerprint: fingerprint,
          }
        : {}),
    };

    await this.prisma.scoped.$transaction(async (tx) => {
      const claimed = await tx.geoDistributionTask.updateMany({
        where: {
          id: task.id,
          status: { in: [...PUBLISHABLE_STATUSES] },
        },
        data: {
          status: 'PUBLISHING',
          connectionId: conn.id,
          publishAsDraft: effectivePublishAsDraft,
          preflightJson: preflight as unknown as Prisma.InputJsonValue,
          variantExtrasJson: nextExtras as unknown as Prisma.InputJsonValue,
          lastError: null,
        },
      });
      if (claimed.count !== 1) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '该分发任务已被并发提交，请刷新状态');
      }
      await this.quota.consume(auth.tenantId, 'PUBLISH', 1, tx as unknown as QuotaTx);
    }, TX_OPTIONS);

    // 6. 入队 BullMQ 'distribution' 队列；入队失败时回落状态为 FAILED 并清幂等键以便重试
    if (this.enqueuer) {
      try {
        await this.enqueuer.enqueueDistribution({
          tenantId: auth.tenantId,
          taskId: task.id,
        });
      } catch {
        const rollbackExtras: Record<string, unknown> = { ...nextExtras };
        delete rollbackExtras._publishIdempotencyKey;
        delete rollbackExtras._publishRequestFingerprint;
        await this.prisma.scoped.geoDistributionTask
          .updateMany({
            where: { id: task.id, status: 'PUBLISHING' },
            data: {
              status: 'FAILED',
              lastError: '分发任务入队失败，请稍后重试',
              variantExtrasJson: rollbackExtras as unknown as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
        throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, '分发队列暂时不可用，请稍后重试');
      }
    }

    const updated = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: { id: task.id },
    });
    if (!updated) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }
    return presentDistributionTask(updated);
  }

  async createPrShare(
    taskId: string,
    input: CreatePrShareLinkInput,
    auth: DistributionAuthContext,
  ): Promise<PrShareLinkResultDto> {
    this.rateLimiter?.assertAllowed('pr_packet_share', auth.tenantId, readPrPacketShareRateLimit());

    const task = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: { id: taskId },
    });
    if (!task) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }

    if (task.provider !== 'PR_PACKET' && task.mode !== 'L3_PR_PACKET') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅 PR/KOL 外部协作包支持生成免登录分享链接');
    }

    if (task.status === 'ARCHIVED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '已归档的分发任务无法生成外部协作链接');
    }

    const ttlDays = input.ttlDays ?? DEFAULT_PR_SHARE_TTL_DAYS;
    const token = randomBytes(32).toString('base64url');
    const shareTokenHash = sha256Hex(token);
    const shareExpiresAt = new Date(Date.now() + ttlDays * 86_400_000);

    await this.prisma.scoped.geoDistributionTask.update({
      where: { id: task.id },
      data: {
        shareTokenHash,
        shareExpiresAt,
        shareRevokedAt: null,
      },
    });

    const baseUrl = resolvePublicAppUrl();
    return {
      taskId: task.id,
      shareUrl: `${baseUrl}/share/pr/${token}`,
      token,
      expiresAt: shareExpiresAt.toISOString(),
      ttlDays,
    };
  }

  async revokePrShare(taskId: string): Promise<RevokePrShareResultDto> {
    const task = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }

    const now = new Date();
    await this.prisma.scoped.geoDistributionTask.update({
      where: { id: task.id },
      data: {
        shareRevokedAt: now,
      },
    });

    return {
      taskId: task.id,
      revoked: true,
      revokedAt: now.toISOString(),
    };
  }

  async triggerCrawlProbe(
    publishRecordId: string,
    auth: DistributionAuthContext,
  ): Promise<GeoPublishRecordDto> {
    return this.crawlProbe.probePublishRecord(publishRecordId, {
      tenantId: auth.tenantId,
      enforceRateLimit: true,
    });
  }

  async updateRetestSchedules(
    publishRecordId: string,
    input: RetestScheduleConfigInput,
  ): Promise<UpdateRetestSchedulesResultDto> {
    const items = await this.retestScheduler.updateSchedulesForPublishRecord(
      publishRecordId,
      input,
    );
    return {
      publishRecordId,
      items,
    };
  }

  async estimateRetestBudget(
    publishRecordId: string,
    auth: DistributionAuthContext,
    query?: ParsedRetestBudgetEstimateQuery,
  ): Promise<RetestBudgetEstimateDto> {
    return this.retestScheduler.estimateBudgetForPublishRecord(
      publishRecordId,
      auth.tenantId,
      query,
    );
  }
}
