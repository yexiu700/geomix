import { Inject, Injectable } from '@nestjs/common';
import type { L1ChannelProvider } from '@geomix/shared';
import { ShopifyConnector } from './shopify.connector';
import { ConnectorError, type CmsConnector } from './types';
import { WebflowConnector } from './webflow.connector';
import { WebhookConnector } from './webhook.connector';
import { WordPressConnector } from './wordpress.connector';

@Injectable()
export class CmsConnectorRegistry {
  private readonly connectors: ReadonlyMap<L1ChannelProvider, CmsConnector>;

  constructor(
    @Inject(ShopifyConnector) shopify: ShopifyConnector,
    @Inject(WordPressConnector) wordpress: WordPressConnector,
    @Inject(WebflowConnector) webflow: WebflowConnector,
    @Inject(WebhookConnector) webhook: WebhookConnector,
  ) {
    this.connectors = new Map<L1ChannelProvider, CmsConnector>([
      ['SHOPIFY', shopify],
      ['WORDPRESS', wordpress],
      ['WEBFLOW', webflow],
      ['WEBHOOK', webhook],
    ]);
  }

  get(provider: L1ChannelProvider): CmsConnector {
    const connector = this.connectors.get(provider);
    if (!connector) {
      throw new ConnectorError(provider, 'CONFIG_ERROR', `不支持的 L1 渠道连接器：${provider}`);
    }
    return connector;
  }
}

export { ShopifyConnector } from './shopify.connector';
export { WordPressConnector } from './wordpress.connector';
export {
  DEFAULT_WEBFLOW_API_BASE_URL,
  WEBFLOW_API_BASE_URL,
  WebflowConnector,
} from './webflow.connector';
export { signWebhookPayload, verifyWebhookSignature, WebhookConnector } from './webhook.connector';
export {
  appendInlineJsonLd,
  collectSecretCandidates,
  ConnectorError,
  joinBasePath,
  mapHttpStatusError,
  mapTransportError,
  parseJsonSafe,
  redactSecrets,
  slugifyAscii,
  trimTrailingSlashes,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorErrorCode,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';
