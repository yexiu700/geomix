import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
  type ChannelRemoteTargetDto,
  type TestChannelConnectionInput,
} from '@geomix/shared';
import { OutboundHttpClient } from '../../infra/outbound-http';
import {
  collectSecretCandidates,
  ConnectorError,
  mapHttpStatusError,
  mapTransportError,
  parseJsonSafe,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

const FORBIDDEN_EXTRA_HEADERS = new Set([
  'host',
  'user-agent',
  'content-length',
  'content-type',
  'accept',
  'x-geomix-signature',
  'x-geomix-delivery-id',
  'x-geomix-event',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'transfer-encoding',
  'connection',
]);

const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function signWebhookPayload(rawBody: string, signingSecret: string): string {
  const digest = createHmac('sha256', signingSecret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  rawBody: string,
  signingSecret: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader || !signingSecret) return false;
  const expected = signWebhookPayload(rawBody, signingSecret);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader.trim(), 'utf8');
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, receivedBuf);
}

type WebhookPublishResponse = {
  id?: string | number;
  postId?: string | number;
  remotePostId?: string | number;
  adminUrl?: string;
  publishedUrl?: string;
  url?: string;
  publishedAsDraft?: boolean;
  isDraft?: boolean;
};

@Injectable()
export class WebhookConnector implements CmsConnector {
  readonly provider = 'WEBHOOK' as const;

  constructor(@Inject(OutboundHttpClient) private readonly http: OutboundHttpClient) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const signingSecret = this.resolveSigningSecret(secrets);
    const secretCandidates = collectSecretCandidates(secrets);
    const deliveryId = randomUUID();
    const event = 'geomix.connection.test';
    const rawBody = JSON.stringify({
      event,
      deliveryId,
      timestamp: new Date().toISOString(),
      connectionId: conn.id,
      displayName: conn.displayName,
    });

    const response = await this.sendSignedPost(
      conn,
      rawBody,
      signingSecret,
      deliveryId,
      event,
      secretCandidates,
    );

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    return {
      ok: true,
      message: 'Webhook 连通性测试通过',
      targets: await this.listTargets(conn, secrets),
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    _secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    return [
      {
        id: 'webhook',
        name: conn.displayName,
        url: conn.siteBaseUrl,
      },
    ];
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const signingSecret = this.resolveSigningSecret(secrets);
    const secretCandidates = collectSecretCandidates(secrets);
    const deliveryId = payload.deliveryId?.trim() || randomUUID();
    const event = 'geomix.article.publish';
    const rawBody = JSON.stringify({
      event,
      deliveryId,
      timestamp: new Date().toISOString(),
      publishAsDraft: payload.publishAsDraft,
      article: {
        id: payload.articleId,
        taskId: payload.taskId,
        market: payload.market,
        channelLabel: payload.channelLabel,
        title: payload.title,
        slug: payload.slug ?? null,
        metaDescription: payload.metaDesc ?? null,
        markdown: payload.markdown,
        html: payload.html,
        tags: payload.tags ?? [],
        extras: payload.extras ?? {},
      },
      schemaJsonLd: payload.schemaJsonLd ?? null,
      llmsTxtSnippet: payload.llmsTxtSnippet ?? null,
    });

    const response = await this.sendSignedPost(
      conn,
      rawBody,
      signingSecret,
      deliveryId,
      event,
      secretCandidates,
    );

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const data = parseJsonSafe<WebhookPublishResponse>(response.body);
    const rawPostId = data?.id ?? data?.postId ?? data?.remotePostId;
    const remotePostId =
      rawPostId !== undefined && rawPostId !== null && String(rawPostId).trim()
        ? String(rawPostId).trim()
        : deliveryId;

    const remoteAdminUrl =
      typeof data?.adminUrl === 'string' && isSafeDistributionHttpUrl(data.adminUrl)
        ? data.adminUrl.trim()
        : undefined;

    const rawPublishedUrl =
      typeof data?.publishedUrl === 'string' && data.publishedUrl.trim()
        ? data.publishedUrl.trim()
        : typeof data?.url === 'string' && data.url.trim()
          ? data.url.trim()
          : undefined;

    const publishedAsDraft =
      typeof data?.publishedAsDraft === 'boolean'
        ? data.publishedAsDraft
        : typeof data?.isDraft === 'boolean'
          ? data.isDraft
          : payload.publishAsDraft;

    let remotePublishedUrl: string | undefined;
    if (rawPublishedUrl) {
      const validated = await validatePublishedUrl(
        this.http,
        this.provider,
        rawPublishedUrl,
        'Webhook 返回的发布链接未通过公网安全校验',
      );
      if (!publishedAsDraft) {
        remotePublishedUrl = validated;
      }
    }

    return {
      remotePostId,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private resolveSigningSecret(secrets: ConnectorSecrets): string {
    const signingSecret = secrets.signingSecret?.trim() ?? '';
    if (signingSecret.length < 8) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', 'Webhook 签名密钥长度至少为 8 位');
    }
    return signingSecret;
  }

  private sanitizeExtraHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    if (!extraHeaders || typeof extraHeaders !== 'object') return {};
    const safe: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(extraHeaders)) {
      const key = rawKey.trim();
      if (!key || !VALID_HEADER_NAME.test(key)) continue;
      if (FORBIDDEN_EXTRA_HEADERS.has(key.toLowerCase())) continue;
      if (typeof rawValue !== 'string' || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(rawValue)) {
        continue;
      }
      safe[key] = rawValue.trim();
    }
    return safe;
  }

  private async sendSignedPost(
    conn: ConnectorConnectionContext,
    rawBody: string,
    signingSecret: string,
    deliveryId: string,
    event: string,
    secretCandidates: readonly string[],
  ) {
    const signature = signWebhookPayload(rawBody, signingSecret);
    const extra = this.sanitizeExtraHeaders(conn.configJson.extraHeaders);

    try {
      return await this.http.request({
        url: conn.siteBaseUrl,
        method: 'POST',
        headers: {
          ...extra,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          'X-GeoMix-Signature': signature,
          'X-GeoMix-Delivery-Id': deliveryId,
          'X-GeoMix-Event': event,
        },
        body: rawBody,
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }
  }
}
