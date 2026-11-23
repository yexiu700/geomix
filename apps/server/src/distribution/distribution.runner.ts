import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isL1ChannelProvider, type ChannelConnectionConfig, type GeoMarket } from '@geomix/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GeoDeliveryService } from '../studio/geo-delivery.service';
import { runInTenant } from '../tenant/tenant-context';
import { ConnectionsService } from './connections.service';
import { CmsConnectorRegistry } from './connectors';
import type {
  ConnectorConnectionContext,
  ConnectorPublishPayload,
  ConnectorSecrets,
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

const CONFIG_SECRET_KEY_PATTERN = /token|secret|password|key|auth/i;
const EXPLICIT_CONFIG_SECRET_KEYS = new Set(['indexNowKey', 'indexNowKeyLocation']);
const PERCENT_HEX_PATTERN = /%[0-9A-Fa-f]{2}/g;

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPercentInsensitiveRegex(encoded: string): RegExp | null {
  PERCENT_HEX_PATTERN.lastIndex = 0;
  if (!PERCENT_HEX_PATTERN.test(encoded)) {
    return null;
  }
  PERCENT_HEX_PATTERN.lastIndex = 0;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PERCENT_HEX_PATTERN.exec(encoded)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeRegExpLiteral(encoded.slice(lastIndex, match.index)));
    }
    const hex = match[0].slice(1);
    const hexPattern = hex
      .split('')
      .map((ch) => (/[A-Fa-f]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch))
      .join('');
    parts.push(`%${hexPattern}`);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < encoded.length) {
    parts.push(escapeRegExpLiteral(encoded.slice(lastIndex)));
  }
  return new RegExp(parts.join(''), 'g');
}

function collectRunnerRedactionInputs(
  credentials?: ConnectorSecrets,
  connConfig?: Record<string, unknown>,
): { redactInputs: Record<string, string>; secretValues: string[] } {
  const redactInputs: Record<string, string> = {};
  const rawSecrets = new Set<string>();

  const addSecretValue = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length < 4) return;
    rawSecrets.add(trimmed);
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length >= 4 && compact !== trimmed) {
      rawSecrets.add(compact);
    }
  };

  if (credentials) {
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      redactInputs[key] = value;
      if (key.toLowerCase() !== 'username' || trimmed.length >= 8) {
        addSecretValue(trimmed);
      }
    }

    const username = credentials.username?.trim();
    const appPassword = (
      credentials.appPassword ??
      credentials.applicationPassword ??
      credentials.password
    )?.trim();
    if (username && appPassword) {
      addSecretValue(Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64'));
      const compactPassword = appPassword.replace(/\s+/g, '');
      if (compactPassword !== appPassword) {
        addSecretValue(Buffer.from(`${username}:${compactPassword}`, 'utf8').toString('base64'));
      }
    }
  }

  if (connConfig) {
    for (const [key, value] of Object.entries(connConfig)) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (EXPLICIT_CONFIG_SECRET_KEYS.has(key) || CONFIG_SECRET_KEY_PATTERN.test(key)) {
          redactInputs[`cfg_${key}`] = trimmed;
          addSecretValue(trimmed);
        }
      } else if (
        key === 'extraHeaders' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        for (const [hdrKey, hdrVal] of Object.entries(value as Record<string, unknown>)) {
          if (typeof hdrVal !== 'string') continue;
          const trimmed = hdrVal.trim();
          if (!trimmed) continue;
          if (CONFIG_SECRET_KEY_PATTERN.test(hdrKey)) {
            redactInputs[`cfg_hdr_${hdrKey}`] = trimmed;
            addSecretValue(trimmed);
          }
        }
      }
    }
  }

  const secretValues = [...rawSecrets].sort((a, b) => b.length - a.length);
  return { redactInputs, secretValues };
}

function redactEncodedSecretVariants(input: string, secretValues: readonly string[]): string {
  let text = input;
  const applyEncoded = (encoded: string) => {
    if (encoded.length < 4) return;
    const lowerEncoded = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    text = text.split(encoded).join('[REDACTED]');
    if (lowerEncoded !== encoded) {
      text = text.split(lowerEncoded).join('[REDACTED]');
    }
    const mixedEncodedRe = buildPercentInsensitiveRegex(encoded);
    if (mixedEncodedRe) {
      text = text.replace(mixedEncodedRe, '[REDACTED]');
    }
  };

  for (const trimmed of secretValues) {
    if (trimmed.length < 4) continue;
    text = text.split(trimmed).join('[REDACTED]');

    let encoded: string;
    try {
      encoded = encodeURIComponent(trimmed);
    } catch {
      continue;
    }

    applyEncoded(encoded);

    if (encoded.includes('%20')) {
      applyEncoded(encoded.replace(/%20/g, '+'));
    }

    try {
      const formUrlEncoded = new URLSearchParams([['v', trimmed]]).toString().slice(2);
      if (formUrlEncoded !== encoded) {
        applyEncoded(formUrlEncoded);
      }
    } catch {
      // Ignore malformed surrogate pairs
    }
  }
  return text;
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
    const { redactInputs, secretValues } = collectRunnerRedactionInputs(credentials, connConfig);
    const hasInputs = Object.keys(redactInputs).length > 0;
    const preRedacted = redactEncodedSecretVariants(rawMessage, secretValues);
    const sanitized = this.connections.sanitizeConnectionError(
      preRedacted,
      hasInputs ? redactInputs : undefined,
    );
    return redactEncodedSecretVariants(sanitized, secretValues);
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
