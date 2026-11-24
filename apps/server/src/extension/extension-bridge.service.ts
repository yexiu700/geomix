import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  CHANNEL_PROVIDER_LABELS,
  EXTENSION_BRIDGE_VERSION,
  L2_EXTENSION_PROVIDERS,
  extensionConfirmPublishedSchema,
  isL2ExtensionProvider,
  type ChannelProvider,
  type DistributionTaskStatus,
  type ExtensionConfirmPublishedResultDto,
  type ExtensionMeBrandDto,
  type ExtensionMeDto,
  type ExtensionPendingTaskDto,
  type ExtensionPendingTaskMediaDto,
  type ExtensionPendingTasksResponseDto,
  type L2ExtensionProvider,
  type ParsedExtensionTasksQueryInput,
} from '@geomix/shared';
import { BrandMediaService } from '../brands/brand-media.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readExtensionSyncRateLimit,
} from '../common/free-action-rate-limiter';
import { parseBody } from '../common/parse-body';
import { OutboundHttpClient } from '../infra/outbound-http';
import { ProviderError } from '../infra/provider-error';
import { UrlPolicyError } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { parseEntityId } from '../studio/studio.controller';
import { runInTenant } from '../tenant/tenant-context';
import type { ExtensionRequestAuth } from './extension-auth.types';

const DEFAULT_PENDING_STATUSES: DistributionTaskStatus[] = [
  'DRAFT_VARIANT',
  'READY_TO_PUBLISH',
  'DRAFT_PUSHED',
];

const MAX_MEDIA_ASSETS_PER_BRAND = 10;

const DEFAULT_CN_L2_ANTI_BAN_CHECKLIST: Record<L2ExtensionProvider, readonly string[]> = {
  ZHIHU_EXT: [
    '通过 GeoMix Chrome 扩展仅同步至知乎草稿箱，由作者人工复核后手动点击发布，严禁绕过平台风控。',
    '如实披露与品牌的合作或实测样本来源，遵守知乎商业内容与好物推荐标注规范。',
    '全程采用客观对比与实测数据表述，禁用《广告法》极限词（最/第一/顶级/唯一）。',
    '同时列出产品局限与不适用人群，避免正文夹带站外导流硬广链接。',
  ],
  TOUTIAO_EXT: [
    '通过 GeoMix Chrome 扩展同步至头条号草稿箱，人工核对图文排版与配图后再手动发布。',
    '首段直出核心结论，保持移动端短段落清晰可读，不夸大标题党承诺。',
    '严格遵守《广告法》与头条号原创规范，禁用“第一/唯一/最/国家级”等绝对化用语。',
    '客观说明适用人群与使用边界，避免正文放置外部导流或返利跳转链接。',
  ],
  SMZDM_EXT: [
    '通过 GeoMix Chrome 扩展同步至什么值得买草稿箱，人工复核实测参数与配图后手动提交审核。',
    '突出量化参数对照、优缺点并列与适用人群边界，符合社区真实选购评测口径。',
    '如实说明样机或评测来源，严禁使用《广告法》极限词或绝对化疗效/收益承诺。',
    '正文不夹带违规导流或隐藏返利链接，确保可复核数据来源清晰。',
  ],
};

function extractAntiBanChecklist(
  variantExtrasJson: unknown,
  provider: L2ExtensionProvider,
): string[] {
  if (
    variantExtrasJson &&
    typeof variantExtrasJson === 'object' &&
    !Array.isArray(variantExtrasJson)
  ) {
    const raw = (variantExtrasJson as Record<string, unknown>).antiBanChecklist;
    if (Array.isArray(raw)) {
      const cleaned = raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (cleaned.length > 0) {
        return cleaned;
      }
    }
  }
  return [...DEFAULT_CN_L2_ANTI_BAN_CHECKLIST[provider]];
}

function mergeConfirmNoteIntoVariantExtras(
  existingExtras: unknown,
  note: string | undefined,
): Prisma.InputJsonValue | undefined {
  const trimmed = note?.trim();
  if (!trimmed) {
    return undefined;
  }
  const baseObj: Record<string, unknown> =
    existingExtras && typeof existingExtras === 'object' && !Array.isArray(existingExtras)
      ? { ...(existingExtras as Record<string, unknown>) }
      : {};
  baseObj.extensionConfirmNote = trimmed;
  return baseObj as Prisma.InputJsonValue;
}

const EMAIL_DISPLAY_RE = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/;
const CN_MOBILE_RE = /^(1[3-9]\d)\d{4}(\d{4})$/;

function maskPiiDisplay(value: string): string {
  const emailMatch = EMAIL_DISPLAY_RE.exec(value);
  if (emailMatch && emailMatch[1] && emailMatch[2]) {
    const localChars = Array.from(emailMatch[1]);
    const maskedLocal =
      localChars.length <= 2
        ? `${localChars[0]}***`
        : `${localChars.slice(0, 2).join('')}***${localChars[localChars.length - 1]}`;
    return `${maskedLocal}@${emailMatch[2]}`;
  }
  const mobileMatch = CN_MOBILE_RE.exec(value);
  if (mobileMatch) {
    return `${mobileMatch[1]}****${mobileMatch[2]}`;
  }
  return value;
}

export function formatMaskedUserDisplayName(
  nickname: string | null | undefined,
  username: string | null | undefined,
  tenantName: string | null | undefined,
): string {
  const cleanNickname = nickname?.trim();
  if (cleanNickname) {
    return maskPiiDisplay(cleanNickname);
  }
  const cleanUsername = username?.trim();
  if (cleanUsername) {
    const piiMasked = maskPiiDisplay(cleanUsername);
    if (piiMasked !== cleanUsername) {
      return piiMasked;
    }
    const chars = Array.from(cleanUsername);
    if (chars.length <= 2) {
      return `${chars[0]}***`;
    }
    if (chars.length <= 4) {
      return `${chars[0]}***${chars[chars.length - 1]}`;
    }
    return `${chars.slice(0, 2).join('')}***${chars[chars.length - 1]}`;
  }
  return tenantName?.trim() || 'GeoMix 用户';
}

/**
 * L2 Chrome 扩展薄桥接服务（100% `prisma.scoped`，全部显式包裹 `runInTenant(auth.tenantId, ...)`）：
 * - `getMe`: 返回租户 CN 品牌与当前配对令牌最小摘要（绝不泄露密钥/账本/计费信息）；
 * - `listTasks`: 仅返回当前租户 `mode = 'L2_EXTENSION'` 任务并附签名品牌素材链接；
 * - `confirmPublished`: 校验公网 SSRF 安全，幂等标记 `PUBLISHED` 并经 `GeoDeliveryService.createPublishRecord`
 *   创建唯一 `GeoPublishRecord`（`crawlStatus='PENDING'` 自动纳入 T+1 抓取探测）及 T+7/14/30 复测计划。
 */
@Injectable()
export class ExtensionBridgeService {
  private readonly rateLimiter: FreeActionRateLimiter;
  private readonly inFlightConfirms = new Map<string, Promise<void>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GeoDeliveryService) private readonly geoDelivery: GeoDeliveryService,
    @Inject(OutboundHttpClient) private readonly outboundHttp: OutboundHttpClient,
    @Optional() @Inject(BrandMediaService) private readonly brandMedia?: BrandMediaService,
    @Optional() @Inject(FreeActionRateLimiter) rateLimiter?: FreeActionRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new FreeActionRateLimiter();
  }

  async getMe(auth: ExtensionRequestAuth): Promise<ExtensionMeDto> {
    this.rateLimiter.assertAllowed('extension_sync', auth.tenantId, readExtensionSyncRateLimit());

    return runInTenant(auth.tenantId, async () => {
      const [user, cnMarkets] = await Promise.all([
        this.prisma.scoped.user.findFirst({
          where: { id: auth.userId, tenantId: auth.tenantId },
          select: {
            nickname: true,
            username: true,
          },
        }),
        this.prisma.scoped.brandMarket.findMany({
          where: {
            tenantId: auth.tenantId,
            market: 'CN',
          },
          include: {
            brand: {
              select: {
                id: true,
                name: true,
                category: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      ]);

      const userDisplayName = formatMaskedUserDisplayName(
        user?.nickname,
        user?.username,
        auth.tenantName,
      );

      const brands: ExtensionMeBrandDto[] = cnMarkets.map((row) => ({
        id: row.brand.id,
        name: row.brand.name,
        localBrandName: row.localBrandName,
        category: row.localCategory?.trim() || row.brand.category,
        market: 'CN',
      }));

      return {
        bridgeVersion: EXTENSION_BRIDGE_VERSION,
        userDisplayName,
        tokenLabel: auth.tokenLabel,
        tokenPrefix: auth.tokenPrefix,
        expiresAt: auth.expiresAt.toISOString(),
        brands,
      };
    });
  }

  async listTasks(
    query: ParsedExtensionTasksQueryInput,
    auth: ExtensionRequestAuth,
  ): Promise<ExtensionPendingTasksResponseDto> {
    this.rateLimiter.assertAllowed('extension_sync', auth.tenantId, readExtensionSyncRateLimit());

    const validatedBrandId =
      query.brandId !== undefined ? parseEntityId(query.brandId, '品牌编号') : undefined;

    return runInTenant(auth.tenantId, async () => {
      const tasks = await this.prisma.scoped.geoDistributionTask.findMany({
        where: {
          tenantId: auth.tenantId,
          mode: 'L2_EXTENSION',
          provider: query.provider ? query.provider : { in: [...L2_EXTENSION_PROVIDERS] },
          ...(validatedBrandId ? { brandId: validatedBrandId } : {}),
          status: query.status ? query.status : { in: DEFAULT_PENDING_STATUSES },
        },
        include: {
          brand: {
            select: {
              name: true,
            },
          },
          brandMarket: {
            select: {
              localBrandName: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
      });

      const distinctBrandIds = Array.from(new Set(tasks.map((task) => task.brandId)));
      const mediaByBrand = await this.loadSignedMediaByBrand(auth.tenantId, distinctBrandIds);

      const items: ExtensionPendingTaskDto[] = [];
      for (const task of tasks) {
        if (!isL2ExtensionProvider(task.provider)) {
          continue;
        }
        items.push({
          taskId: task.id,
          brandId: task.brandId,
          brandName: task.brandMarket?.localBrandName?.trim() || task.brand.name,
          articleId: task.articleId,
          provider: task.provider,
          channelLabel: task.channelLabel,
          status: task.status as DistributionTaskStatus,
          variantTitle: task.variantTitle,
          variantMarkdown: task.variantMarkdown,
          variantHtml: task.variantHtml,
          targetUrlHint: task.targetUrlHint,
          mediaAssets: mediaByBrand.get(task.brandId) ?? [],
          antiBanChecklist: extractAntiBanChecklist(task.variantExtrasJson, task.provider),
          remotePublishedUrl: task.remotePublishedUrl,
          updatedAt: task.updatedAt.toISOString(),
        });
      }

      return {
        bridgeVersion: EXTENSION_BRIDGE_VERSION,
        items,
      };
    });
  }

  async confirmPublished(
    taskId: string,
    rawBody: unknown,
    auth: ExtensionRequestAuth,
  ): Promise<ExtensionConfirmPublishedResultDto> {
    this.rateLimiter.assertAllowed('extension_sync', auth.tenantId, readExtensionSyncRateLimit());

    const input = parseBody(extensionConfirmPublishedSchema, rawBody);
    const publishedUrl = input.publishedUrl.trim();

    try {
      await this.outboundHttp.assertAllowedUrl(publishedUrl);
    } catch (error) {
      if (error instanceof UrlPolicyError || error instanceof ProviderError) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '回传的文章链接不允许访问（请提供可公开访问的 http:// 或 https:// 公网文章链接）',
        );
      }
      throw error;
    }

    return runInTenant(auth.tenantId, async () => {
      const initialTask = await this.findAndValidateL2Task(taskId, auth.tenantId);

      const lockKey = `${auth.tenantId}\0${initialTask.id}`;
      while (this.inFlightConfirms.has(lockKey)) {
        await this.inFlightConfirms.get(lockKey);
      }
      let releaseLock!: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      this.inFlightConfirms.set(lockKey, lockPromise);

      try {
        const task = await this.findAndValidateL2Task(initialTask.id, auth.tenantId);

        if (
          task.status === 'PUBLISHED' &&
          task.remotePublishedUrl &&
          task.remotePublishedUrl !== publishedUrl
        ) {
          throw new ApiError(
            409,
            BILLING_ERROR.CONFLICT,
            '该分发任务已绑定其他已发布链接，无法重复覆盖',
          );
        }

        const existing = await this.prisma.scoped.geoPublishRecord.findFirst({
          where: {
            tenantId: auth.tenantId,
            OR: [
              { distributionTaskId: task.id, publishedUrl },
              { articleId: task.articleId, publishedUrl },
            ],
          },
          select: {
            id: true,
            distributionTaskId: true,
            publishedUrl: true,
            publishedAt: true,
            retestSchedules: {
              select: { id: true },
            },
          },
        });

        if (existing) {
          if (existing.distributionTaskId !== null && existing.distributionTaskId !== task.id) {
            throw new ApiError(
              409,
              BILLING_ERROR.CONFLICT,
              '该发布链接已关联其他分发任务，无法重复绑定',
            );
          }

          if (existing.distributionTaskId === null) {
            const claimed = await this.prisma.scoped.geoPublishRecord.updateMany({
              where: {
                id: existing.id,
                tenantId: auth.tenantId,
                distributionTaskId: null,
              },
              data: {
                distributionTaskId: task.id,
              },
            });
            if (claimed.count === 0) {
              throw new ApiError(
                409,
                BILLING_ERROR.CONFLICT,
                '该发布链接已关联其他分发任务，无法重复绑定',
              );
            }
          }

          const mergedExtras = mergeConfirmNoteIntoVariantExtras(
            task.variantExtrasJson,
            input.note,
          );
          if (
            task.status !== 'PUBLISHED' ||
            task.remotePublishedUrl !== existing.publishedUrl ||
            mergedExtras !== undefined
          ) {
            await this.prisma.scoped.geoDistributionTask.update({
              where: {
                id: task.id,
                tenantId: auth.tenantId,
                status: { not: 'ARCHIVED' },
              },
              data: {
                status: 'PUBLISHED',
                remotePublishedUrl: existing.publishedUrl,
                publishedAt: existing.publishedAt,
                lastError: null,
                ...(mergedExtras !== undefined ? { variantExtrasJson: mergedExtras } : {}),
              },
            });
          }

          return {
            accepted: true,
            taskId: task.id,
            publishRecordId: existing.id,
            publishedUrl: existing.publishedUrl,
            status: 'PUBLISHED',
            alreadyRecorded: true,
            retestScheduledCount: existing.retestSchedules.length,
          };
        }

        const channel =
          task.channelLabel.trim() ||
          CHANNEL_PROVIDER_LABELS[task.provider as ChannelProvider] ||
          task.provider;

        const record = await this.geoDelivery.createPublishRecord(
          task.articleId,
          {
            publishedUrl,
            channel,
            distributionTaskId: task.id,
            autoRetest: { enabled: true },
          },
          { tenantId: auth.tenantId, userId: auth.userId },
        );

        const mergedExtras = mergeConfirmNoteIntoVariantExtras(task.variantExtrasJson, input.note);

        await this.prisma.scoped.geoDistributionTask.update({
          where: {
            id: task.id,
            tenantId: auth.tenantId,
            status: { not: 'ARCHIVED' },
          },
          data: {
            status: 'PUBLISHED',
            remotePublishedUrl: record.publishedUrl,
            publishedAt: new Date(record.publishedAt),
            lastError: null,
            ...(mergedExtras !== undefined ? { variantExtrasJson: mergedExtras } : {}),
          },
        });

        return {
          accepted: true,
          taskId: task.id,
          publishRecordId: record.id,
          publishedUrl: record.publishedUrl,
          status: 'PUBLISHED',
          alreadyRecorded: false,
          retestScheduledCount: record.retestSchedules?.length ?? 0,
        };
      } finally {
        if (this.inFlightConfirms.get(lockKey) === lockPromise) {
          this.inFlightConfirms.delete(lockKey);
        }
        releaseLock();
      }
    });
  }

  private async findAndValidateL2Task(taskId: string, tenantId: string) {
    const task = await this.prisma.scoped.geoDistributionTask.findFirst({
      where: {
        id: taskId,
        tenantId,
      },
      select: {
        id: true,
        articleId: true,
        provider: true,
        mode: true,
        channelLabel: true,
        status: true,
        remotePublishedUrl: true,
        variantExtrasJson: true,
      },
    });

    if (!task) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '分发任务不存在或无权访问');
    }

    if (task.mode !== 'L2_EXTENSION' || !isL2ExtensionProvider(task.provider)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅支持回传 L2 Chrome 扩展分发任务的发布链接');
    }

    if (task.status === 'ARCHIVED') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '已归档的分发任务无法确认发布');
    }

    return task;
  }

  private async loadSignedMediaByBrand(
    tenantId: string,
    brandIds: string[],
  ): Promise<Map<string, ExtensionPendingTaskMediaDto[]>> {
    const result = new Map<string, ExtensionPendingTaskMediaDto[]>();
    if (brandIds.length === 0) {
      return result;
    }

    const delegate = (
      this.prisma.scoped as unknown as {
        brandMediaAsset?: {
          findMany?: (args: {
            where: { tenantId: string; brandId: { in: string[] } };
            select: { id: true; brandId: true; title: true; url: true; mime: true };
            orderBy: Array<{ createdAt?: 'desc'; id?: 'desc' }>;
          }) => Promise<
            Array<{ id: string; brandId: string; title: string; url: string; mime: string | null }>
          >;
        };
      }
    ).brandMediaAsset;

    if (typeof delegate?.findMany !== 'function') {
      return result;
    }

    const rows = await delegate.findMany({
      where: {
        tenantId,
        brandId: { in: brandIds },
      },
      select: {
        id: true,
        brandId: true,
        title: true,
        url: true,
        mime: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const exp = this.brandMedia ? this.brandMedia.computeMediaExpiry() : 0;
    const tidParam = encodeURIComponent(tenantId);

    for (const row of rows) {
      const bucket = result.get(row.brandId) ?? [];
      if (bucket.length >= MAX_MEDIA_ASSETS_PER_BRAND) {
        continue;
      }
      let signedUrl = row.url;
      if (this.brandMedia && row.url.startsWith('/api/v2/brands/')) {
        const sep = row.url.includes('?') ? '&' : '?';
        const sig = this.brandMedia.signMediaVariant(tenantId, row.brandId, row.id, 'file', exp);
        signedUrl = `${row.url}${sep}tid=${tidParam}&exp=${exp}&sig=${sig}`;
      }
      bucket.push({
        id: row.id,
        title: row.title,
        url: signedUrl,
        mime: row.mime,
      });
      result.set(row.brandId, bucket);
    }

    return result;
  }
}
