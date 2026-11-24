import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isL1ChannelProvider, type ChannelConnectionConfig, type GeoMarket } from '@geomix/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { runInTenant } from '../tenant/tenant-context';
import { ConnectionsService } from './connections.service';
import { CmsConnectorRegistry } from './connectors';
import {
  collectSecretCandidates,
  redactSecrets,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorSecrets,
} from './connectors/types';
import { IndexNowService } from './indexnow.service';

export const DISTRIBUTION_HANDLER = Symbol('DISTRIBUTION_HANDLER');
export const DISTRIBUTION_ENQUEUER = Symbol('DISTRIBUTION_ENQUEUER');

export type DistributionJobData = {
  tenantId: string;
  taskId: string;
};

export interface DistributionHandler {
  process(payload: DistributionJobData): Promise<void>;
}

export interface DistributionEnqueuer {
  enqueueDistribution(job: DistributionJobData): Promise<void>;
}

function asPlainObject(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyPlainObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return Object.keys(obj).length > 0 ? obj : null;
}

function stripInternalExtras(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * BullMQ `'distribution'` 队列消费者：
 * - 100% 在 `runInTenant(tenantId, ...)` 内使用 `prisma.scoped`，零 `prisma.base`
 * - 仅处理处于 `PUBLISHING` 状态的 L1 API 渠道任务
 * - 草稿模式：写入 `DRAFT_PUSHED`，不创建 GeoPublishRecord、不触发 IndexNow、不建复测日程
 * - 正式发布模式：可选非阻塞触发 IndexNow，并幂等创建 GeoPublishRecord（自动附带 T+7/14/30 复测日程）
 * - 任意异常均脱敏后落库 `FAILED`（绝不泄露凭据或签名密钥）
 */
@Injectable()
export class DistributionRunner implements DistributionHandler {
  private readonly logger = new Logger(DistributionRunner.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(CmsConnectorRegistry) private readonly connectors: CmsConnectorRegistry,
    @Inject(IndexNowService) private readonly indexNow: IndexNowService,
    @Inject(GeoDeliveryService) private readonly geoDelivery: GeoDeliveryService,
  ) {}

  async process(payload: DistributionJobData): Promise<void> {
    const { tenantId, taskId } = payload;
    await runInTenant(tenantId, async () => {
      const task = await this.prisma.scoped.geoDistributionTask.findFirst({
        where: { id: taskId },
        include: {
          article: {
            select: {
              id: true,
              title: true,
              targetPrompt: true,
              schemaJsonLd: true,
              llmsTxtSnippet: true,
              tags: true,
              status: true,
            },
          },
          brandMarket: {
            select: {
              id: true,
              market: true,
              locale: true,
              ownedDomains: true,
            },
          },
          connection: true,
        },
      });

      if (!task || task.status !== 'PUBLISHING') {
        return;
      }

      if (!isL1ChannelProvider(task.provider)) {
        await this.markFailed(task.id, '非 L1 API 渠道不支持自动推送');
        return;
      }

      if (
        !task.connection ||
        task.connection.status !== 'ACTIVE' ||
        task.connection.provider !== task.provider ||
        task.connection.brandId !== task.brandId ||
        task.connection.brandMarketId !== task.brandMarketId
      ) {
        await this.markFailed(task.id, '未绑定有效的站点渠道连接或连接当前不可用');
        return;
      }

      const connConfigForRedaction = asPlainObject(task.connection.configJson);
      let credentials: ConnectorSecrets | undefined;
      try {
        credentials = this.connections.decryptCredentials(task.connection);

        const connConfig = connConfigForRedaction as ChannelConnectionConfig;
        const connContext: ConnectorConnectionContext = {
          id: task.connection.id,
          provider: task.provider,
          displayName: task.connection.displayName,
          siteBaseUrl: task.connection.siteBaseUrl,
          configJson: connConfig,
          authType: task.connection.authType,
        };

        const rawExtras = asPlainObject(task.variantExtrasJson);
        const sanitizedExtras = stripInternalExtras(rawExtras);
        const schemaJsonLd =
          asNonEmptyPlainObject(rawExtras.schemaJsonLd) ??
          asNonEmptyPlainObject(task.article.schemaJsonLd);
        const llmsTxtSnippet =
          typeof rawExtras.llmsTxtSnippet === 'string' && rawExtras.llmsTxtSnippet.trim()
            ? rawExtras.llmsTxtSnippet
            : (task.article.llmsTxtSnippet ?? null);

        const publishPayload: ConnectorPublishPayload = {
          taskId: task.id,
          articleId: task.articleId,
          market: (task.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN') as GeoMarket,
          channelLabel: task.channelLabel,
          title: task.variantTitle,
          slug: task.variantSlug,
          metaDesc: task.variantMetaDesc,
          markdown: task.variantMarkdown,
          html: task.variantHtml,
          publishAsDraft: task.publishAsDraft,
          tags: Array.isArray(task.article.tags) ? task.article.tags : [],
          targetId: typeof rawExtras.targetId === 'string' ? rawExtras.targetId : null,
          schemaJsonLd,
          llmsTxtSnippet,
          extras: sanitizedExtras,
          deliveryId: `dist_${task.id}`,
        };

        const connector = this.connectors.get(task.provider);
        const result = await connector.publish(connContext, credentials, publishPayload);

        if (result.publishedAsDraft) {
          await this.prisma.scoped.geoDistributionTask.update({
            where: { id: task.id },
            data: {
              status: 'DRAFT_PUSHED',
              publishAsDraft: true,
              remotePostId: result.remotePostId,
              remoteAdminUrl: result.remoteAdminUrl ?? null,
              remotePublishedUrl: null,
              lastError: null,
            },
          });
          return;
        }

        const publishedAt = new Date();
        const remotePublishedUrl =
          typeof result.remotePublishedUrl === 'string' && result.remotePublishedUrl.trim()
            ? result.remotePublishedUrl.trim()
            : null;

        let indexNowSubmitted = false;
        let indexNowStatus = 'SKIPPED';

        if (remotePublishedUrl) {
          const indexNowKey =
            typeof connConfig.indexNowKey === 'string' ? connConfig.indexNowKey.trim() : '';
          const indexNowKeyLocation =
            typeof connConfig.indexNowKeyLocation === 'string'
              ? connConfig.indexNowKeyLocation.trim()
              : undefined;

          if (indexNowKey) {
            try {
              const indexNowRes = await this.indexNow.submit({
                urls: [remotePublishedUrl],
                indexNowKey,
                keyLocation: indexNowKeyLocation,
              });
              indexNowSubmitted = indexNowRes.submitted;
              indexNowStatus = indexNowRes.statusText;
            } catch {
              indexNowSubmitted = false;
              indexNowStatus = 'FAILED:ERROR';
            }
          }

          const existingRec = await this.prisma.scoped.geoPublishRecord.findFirst({
            where: {
              articleId: task.articleId,
              distributionTaskId: task.id,
              publishedUrl: remotePublishedUrl,
            },
          });

          if (!existingRec) {
            await this.geoDelivery.createPublishRecord(
              task.articleId,
              {
                publishedUrl: remotePublishedUrl,
                channel: task.channelLabel.trim() || task.provider,
                publishedAt: publishedAt.toISOString(),
                distributionTaskId: task.id,
                indexNowSubmitted,
                autoRetest: { enabled: true },
              },
              { tenantId, userId: 'system-distribution-runner' },
            );
          } else if (indexNowSubmitted && !existingRec.indexNowSubmitted) {
            await this.prisma.scoped.geoPublishRecord.update({
              where: { id: existingRec.id },
              data: { indexNowSubmitted: true },
            });
          }
        }

        await this.prisma.scoped.geoDistributionTask.update({
          where: { id: task.id },
          data: {
            status: 'PUBLISHED',
            publishAsDraft: false,
            remotePostId: result.remotePostId,
            remoteAdminUrl: result.remoteAdminUrl ?? null,
            remotePublishedUrl,
            indexNowStatus,
            publishedAt,
            lastError: null,
          },
        });
      } catch (error) {
        const rawMessage =
          error instanceof Error && error.message.trim()
            ? error.message
            : '渠道推送失败，请稍后重试';
        const safeMessage = this.sanitizeRunnerError(
          rawMessage,
          credentials,
          connConfigForRedaction,
        );
        await this.markFailed(task.id, safeMessage);
        this.logger.warn(`distribution failed task=${task.id}: ${safeMessage}`);
      }
    });
  }

  private sanitizeRunnerError(
    rawMessage: string,
    credentials?: ConnectorSecrets,
    connConfig?: Record<string, unknown>,
  ): string {
    const candidates =
      credentials || connConfig ? collectSecretCandidates(credentials ?? {}, connConfig) : [];
    const preRedacted = redactSecrets(rawMessage, candidates, 500);
    const sanitized = this.connections.sanitizeConnectionError(
      preRedacted,
      credentials,
      connConfig,
    );
    return redactSecrets(sanitized, candidates, 500) || '渠道连接异常';
  }

  private async markFailed(taskId: string, safeMessage: string): Promise<void> {
    await this.prisma.scoped.geoDistributionTask.updateMany({
      where: { id: taskId },
      data: {
        status: 'FAILED',
        lastError: safeMessage,
      },
    });
  }
}
