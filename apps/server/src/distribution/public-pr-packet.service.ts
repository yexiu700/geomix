import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  isSafeHttpPublishedUrl,
  localizePublicChannelLabel,
  publicPrPacketSubmitSchema,
  resolveEffectiveCategory,
  type ChannelProvider,
  type DistributionTaskStatus,
  type GeoMarket,
  type PublicPrPacketDto,
  type PublicPrPacketSubmitResultDto,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { parseBody } from '../common/parse-body';
import { OutboundHttpClient } from '../infra/outbound-http';
import { ProviderError } from '../infra/provider-error';
import { UrlPolicyError } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { runInTenant } from '../tenant/tenant-context';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const UNIFORM_NOT_FOUND_MESSAGE = '该协作链接不存在或已失效';
const DEFAULT_PUBLIC_GET_MAX = 30;
const DEFAULT_PUBLIC_SUBMIT_MAX = 10;
const DEFAULT_PUBLIC_WINDOW_SECONDS = 60;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPublicPrPacketGetRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.PUBLIC_PR_PACKET_GET_RATE_LIMIT_MAX, DEFAULT_PUBLIC_GET_MAX);
  const windowSeconds = readPositiveInt(
    env.PUBLIC_PR_PACKET_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_PUBLIC_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readPublicPrPacketSubmitRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(
    env.PUBLIC_PR_PACKET_SUBMIT_RATE_LIMIT_MAX,
    DEFAULT_PUBLIC_SUBMIT_MAX,
  );
  const windowSeconds = readPositiveInt(
    env.PUBLIC_PR_PACKET_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_PUBLIC_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

type LocatedPublicTask = {
  id: string;
  tenantId: string;
  shareTokenHash: string;
  shareExpiresAt: Date;
};

type ExtractedFactSheet = {
  brandName?: string;
  category?: string;
  targetPrompt?: string;
  targetFanOuts: string[];
  keyAngles: string[];
  verifiedFacts: Array<{ title: string; summary: string }>;
};

function asPlainObject(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function toCleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function extractFactSheet(
  rawExtras: Prisma.JsonValue | null | undefined,
): ExtractedFactSheet | null {
  const extras = asPlainObject(rawExtras);
  const fsRaw = extras.factSheet;
  if (!fsRaw || typeof fsRaw !== 'object' || Array.isArray(fsRaw)) {
    return null;
  }
  const fs = fsRaw as Record<string, unknown>;
  const verifiedFacts: Array<{ title: string; summary: string }> = [];
  if (Array.isArray(fs.verifiedFacts)) {
    for (const item of fs.verifiedFacts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      if (title || summary) {
        verifiedFacts.push({ title: title || 'Fact', summary });
      }
    }
  }

  return {
    brandName:
      typeof fs.brandName === 'string' && fs.brandName.trim() ? fs.brandName.trim() : undefined,
    category:
      typeof fs.category === 'string' && fs.category.trim() ? fs.category.trim() : undefined,
    targetPrompt:
      typeof fs.targetPrompt === 'string' && fs.targetPrompt.trim()
        ? fs.targetPrompt.trim()
        : undefined,
    targetFanOuts: toCleanStringArray(fs.targetFanOuts),
    keyAngles: toCleanStringArray(fs.keyAngles),
    verifiedFacts,
  };
}

function extractFallbackAngles(
  outlineH2: Prisma.JsonValue | null | undefined,
  draftMarkdown: string,
): string[] {
  const fromOutline = toCleanStringArray(outlineH2);
  if (fromOutline.length > 0) {
    return fromOutline.slice(0, 8);
  }
  const headings: string[] = [];
  for (const line of draftMarkdown.split(/\r?\n/)) {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line.trim());
    if (match?.[1]) {
      headings.push(match[1].trim());
    }
    if (headings.length >= 8) break;
  }
  return headings;
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * 免登录外部 PR / KOL 协作包公开服务：
 * - 按客户端 IP 在查库前强制限流（GET 30/min，POST /submit 10/min）
 * - 唯一一处 `prisma.base` 访问封装在 `findActiveTaskByToken` 中，仅按 SHA-256 令牌哈希定位任务
 * - 定位后立刻通过 `runInTenant(located.tenantId, ...)` 切入租户作用域，全量使用 `prisma.scoped`
 * - 不存在 / 已过期 / 已吊销 / 已归档 / 格式非法均返回统一 404，避免令牌枚举 oracle
 * - GET 严格白名单构造 15 字段 `PublicPrPacketDto`，绝不泄露任何租户隐私字段
 * - POST /submit 经由 `OutboundHttpClient.assertAllowedUrl` 执行 SSRF 校验并幂等建 `GeoPublishRecord` + T+7/14/30 日程
 */
@Injectable()
export class PublicPrPacketService {
  private readonly rateLimiter: FreeActionRateLimiter;
  private readonly inFlightSubmits = new Map<string, Promise<void>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboundHttpClient) private readonly outboundHttp: OutboundHttpClient,
    @Inject(GeoDeliveryService) private readonly geoDelivery: GeoDeliveryService,
    @Optional() @Inject(FreeActionRateLimiter) rateLimiter?: FreeActionRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new FreeActionRateLimiter();
  }

  resetRateLimits(): void {
    this.rateLimiter.reset();
  }

  async getPacket(rawToken: string, clientIp: string): Promise<PublicPrPacketDto> {
    this.rateLimiter.assertAllowed(
      'public_pr_packet_get',
      clientIp || 'unknown',
      readPublicPrPacketGetRateLimit(),
    );

    const located = await this.findActiveTaskByToken(rawToken);

    return runInTenant(located.tenantId, async () => {
      const task = await this.prisma.scoped.geoDistributionTask.findFirst({
        where: this.activeTokenWhere(located),
        include: {
          brand: {
            select: {
              name: true,
              category: true,
              facts: {
                select: { title: true, content: true, productLineId: true },
                orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
              },
            },
          },
          brandMarket: {
            select: {
              market: true,
              locale: true,
              localBrandName: true,
              localCategory: true,
            },
          },
          article: {
            select: {
              targetPrompt: true,
              productLineId: true,
              productLine: {
                select: {
                  category: true,
                  localCategoriesJson: true,
                },
              },
              brief: {
                select: {
                  targetFanOuts: true,
                  outlineH2: true,
                },
              },
            },
          },
          publishRecords: {
            select: { publishedUrl: true },
            orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
            take: 1,
          },
        },
      });

      if (!task) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
      }

      const factSheet = extractFactSheet(task.variantExtrasJson);
      const market: GeoMarket = task.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
      const brandName = factSheet?.brandName || task.brandMarket.localBrandName || task.brand.name;
      const articleProductLine =
        (
          task.article as {
            productLine?: { category?: string | null; localCategoriesJson?: unknown } | null;
          }
        ).productLine ?? null;
      const articleProductLineId =
        (task.article as { productLineId?: string | null }).productLineId ?? null;
      const effectiveCategory = resolveEffectiveCategory(
        task.brand,
        { market, localCategory: task.brandMarket.localCategory },
        articleProductLine,
      );
      const category = articleProductLine
        ? effectiveCategory
        : factSheet?.category || effectiveCategory;
      const targetPrompt = factSheet?.targetPrompt || task.article.targetPrompt;
      const targetFanOuts =
        factSheet && factSheet.targetFanOuts.length > 0
          ? factSheet.targetFanOuts
          : (task.article.brief?.targetFanOuts ?? []);
      const keyAngles =
        factSheet && factSheet.keyAngles.length > 0
          ? factSheet.keyAngles
          : extractFallbackAngles(task.article.brief?.outlineH2, task.variantMarkdown);
      const scopedBrandFacts = articleProductLineId
        ? task.brand.facts
            .filter(
              (fact) =>
                (fact as { productLineId?: string | null }).productLineId == null ||
                (fact as { productLineId?: string | null }).productLineId === articleProductLineId,
            )
            .sort((a, b) => {
              const aScope =
                (a as { productLineId?: string | null }).productLineId === articleProductLineId
                  ? 0
                  : 1;
              const bScope =
                (b as { productLineId?: string | null }).productLineId === articleProductLineId
                  ? 0
                  : 1;
              return aScope - bScope;
            })
        : task.brand.facts;
      const verifiedFacts =
        factSheet && factSheet.verifiedFacts.length > 0
          ? factSheet.verifiedFacts
          : scopedBrandFacts.slice(0, 12).map((fact) => ({
              title: fact.title,
              summary: fact.content.trim().slice(0, 300),
            }));
      const submittedUrl = task.remotePublishedUrl ?? task.publishRecords[0]?.publishedUrl ?? null;

      // 严格 15 键白名单字面量，禁止展开任何数据库行或内部元数据
      const packet: PublicPrPacketDto = {
        market,
        locale: task.brandMarket.locale,
        brandName,
        category,
        channelLabel: localizePublicChannelLabel(
          task.channelLabel,
          market,
          (task.provider as ChannelProvider | undefined) ?? 'PR_PACKET',
        ),
        suggestedTitle: task.variantTitle,
        targetPrompt,
        targetFanOuts,
        keyAngles,
        verifiedFacts,
        draftMarkdown: task.variantMarkdown,
        draftHtml: task.variantHtml,
        status: task.status as DistributionTaskStatus,
        submittedUrl,
        expiresAt: located.shareExpiresAt.toISOString(),
      };
      return packet;
    });
  }

  async submitPublishedUrl(
    rawToken: string,
    rawBody: unknown,
    clientIp: string,
  ): Promise<PublicPrPacketSubmitResultDto> {
    this.rateLimiter.assertAllowed(
      'public_pr_packet_submit',
      clientIp || 'unknown',
      readPublicPrPacketSubmitRateLimit(),
    );

    // 先校验令牌再解析 body 与 SSRF，防止通过 400 vs 404 枚举有效令牌
    const located = await this.findActiveTaskByToken(rawToken);
    const input = parseBody(publicPrPacketSubmitSchema, rawBody);
    const publishedUrl = input.publishedUrl.trim();

    if (!isSafeHttpPublishedUrl(publishedUrl)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '提交的链接不允许访问（请提供可公开访问的 http:// 或 https:// 网页地址）',
      );
    }

    try {
      await this.outboundHttp.assertAllowedUrl(publishedUrl);
    } catch (error) {
      if (error instanceof UrlPolicyError || error instanceof ProviderError) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '提交的链接不允许访问（请提供可公开访问的 http:// 或 https:// 网页地址）',
        );
      }
      throw error;
    }

    return runInTenant(located.tenantId, async () => {
      const task = await this.prisma.scoped.geoDistributionTask.findFirst({
        where: this.activeTokenWhere(located),
        select: {
          id: true,
          articleId: true,
          channelLabel: true,
          status: true,
          remotePublishedUrl: true,
        },
      });

      if (!task) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
      }

      const lockKey = `${located.tenantId}\0${task.articleId}\0${publishedUrl}`;
      while (this.inFlightSubmits.has(lockKey)) {
        await this.inFlightSubmits.get(lockKey);
      }
      let releaseLock!: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      this.inFlightSubmits.set(lockKey, lockPromise);

      try {
        // 临界区内重新校验令牌活跃状态（未吊销、未轮换、未过期、未归档），消除 assertAllowedUrl / 排队期间的 TOCTOU 竞态
        const latestTask = await this.prisma.scoped.geoDistributionTask.findFirst({
          where: this.activeTokenWhere(located),
          select: {
            id: true,
            articleId: true,
            channelLabel: true,
            status: true,
            remotePublishedUrl: true,
          },
        });

        if (!latestTask || latestTask.status === 'ARCHIVED') {
          throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
        }

        const existing = await this.prisma.scoped.geoPublishRecord.findFirst({
          where: {
            articleId: latestTask.articleId,
            publishedUrl,
          },
        });

        if (existing) {
          if (latestTask.status !== 'PUBLISHED' || !latestTask.remotePublishedUrl) {
            const updated = await this.prisma.scoped.geoDistributionTask.updateMany({
              where: this.activeTokenWhere(located),
              data: {
                status: 'PUBLISHED',
                remotePublishedUrl: existing.publishedUrl,
                publishedAt: existing.publishedAt,
                lastError: null,
              },
            });
            if (updated.count === 0) {
              throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
            }
          }
          return {
            accepted: true,
            publishedUrl: existing.publishedUrl,
            submittedAt: existing.publishedAt.toISOString(),
            alreadyRecorded: true,
          };
        }

        const record = await this.geoDelivery.createPublishRecord(
          latestTask.articleId,
          {
            publishedUrl,
            channel: latestTask.channelLabel.trim() || 'Tech Review Media',
            distributionTaskId: latestTask.id,
            autoRetest: { enabled: true },
          },
          { tenantId: located.tenantId, userId: 'public-pr-submit' },
        );

        const updated = await this.prisma.scoped.geoDistributionTask.updateMany({
          where: this.activeTokenWhere(located),
          data: {
            status: 'PUBLISHED',
            remotePublishedUrl: record.publishedUrl,
            publishedAt: new Date(record.publishedAt),
            lastError: null,
          },
        });
        if (updated.count === 0) {
          await this.prisma.scoped.geoPublishRecord
            .deleteMany({ where: { id: record.id } })
            .catch(() => undefined);
          throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
        }

        return {
          accepted: true,
          publishedUrl: record.publishedUrl,
          submittedAt: record.publishedAt,
          alreadyRecorded: false,
        };
      } finally {
        if (this.inFlightSubmits.get(lockKey) === lockPromise) {
          this.inFlightSubmits.delete(lockKey);
        }
        releaseLock();
      }
    });
  }

  private async findActiveTaskByToken(rawToken: string): Promise<LocatedPublicTask> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!TOKEN_PATTERN.test(token)) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
    }

    const shareTokenHash = sha256Hex(token);
    const located = await this.prisma.base.geoDistributionTask.findUnique({
      where: { shareTokenHash },
      select: {
        id: true,
        tenantId: true,
        status: true,
        shareExpiresAt: true,
        shareRevokedAt: true,
      },
    });

    if (
      !located ||
      located.status === 'ARCHIVED' ||
      located.shareRevokedAt !== null ||
      !located.shareExpiresAt ||
      located.shareExpiresAt.getTime() <= Date.now()
    ) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
    }

    return {
      id: located.id,
      tenantId: located.tenantId,
      shareTokenHash,
      shareExpiresAt: located.shareExpiresAt,
    };
  }

  private activeTokenWhere(
    located: LocatedPublicTask,
    now = new Date(),
  ): Prisma.GeoDistributionTaskWhereInput {
    return {
      id: located.id,
      shareTokenHash: located.shareTokenHash,
      status: { not: 'ARCHIVED' },
      shareRevokedAt: null,
      shareExpiresAt: { gt: now },
    };
  }
}
