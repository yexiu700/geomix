import { Inject, Injectable } from '@nestjs/common';
import type { L1ChannelProvider } from '@geomix/shared';
import { DevtoConnector } from './devto.connector';
import { GhostConnector } from './ghost.connector';
import { GithubMdxConnector } from './github-mdx.connector';
import { HashnodeConnector } from './hashnode.connector';
import { ShopifyConnector } from './shopify.connector';
import { ConnectorError, type CmsConnector } from './types';
import { WebflowConnector } from './webflow.connector';
import { WebhookConnector } from './webhook.connector';
import { WechatOfficialConnector } from './wechat-official.connector';
import { WordPressConnector } from './wordpress.connector';

@Injectable()
export class CmsConnectorRegistry {
  private readonly connectors: ReadonlyMap<L1ChannelProvider, CmsConnector>;

  constructor(
    @Inject(ShopifyConnector) shopify: ShopifyConnector,
    @Inject(WordPressConnector) wordpress: WordPressConnector,
    @Inject(WebflowConnector) webflow: WebflowConnector,
    @Inject(WebhookConnector) webhook: WebhookConnector,
    @Inject(GhostConnector) ghost: GhostConnector,
    @Inject(DevtoConnector) devto: DevtoConnector,
    @Inject(HashnodeConnector) hashnode: HashnodeConnector,
    @Inject(GithubMdxConnector) githubMdx: GithubMdxConnector,
    @Inject(WechatOfficialConnector) wechatOfficial: WechatOfficialConnector,
  ) {
    this.connectors = new Map<L1ChannelProvider, CmsConnector>([
      ['SHOPIFY', shopify],
      ['WORDPRESS', wordpress],
      ['WEBFLOW', webflow],
      ['WEBHOOK', webhook],
      ['GHOST', ghost],
      ['DEVTO', devto],
      ['HASHNODE', hashnode],
      ['GITHUB_MDX', githubMdx],
      ['WECHAT_OFFICIAL', wechatOfficial],
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
export { GhostConnector, parseGhostAdminApiKey, signGhostAdminJwt } from './ghost.connector';
export {
  DEFAULT_DEVTO_API_BASE_URL,
  DEVTO_API_BASE_URL,
  DevtoConnector,
  normalizeDevtoTags,
} from './devto.connector';
export {
  DEFAULT_HASHNODE_API_BASE_URL,
  HASHNODE_API_BASE_URL,
  HashnodeConnector,
} from './hashnode.connector';
export {
  buildGitHubMdxDocument,
  DEFAULT_GITHUB_API_BASE_URL,
  GITHUB_API_BASE_URL,
  GithubMdxConnector,
  normalizeGitHubContentDir,
  renderGitHubPublicUrl,
  resolveGitHubRepoCoords,
} from './github-mdx.connector';
export {
  buildMultipartFormData,
  DEFAULT_WECHAT_API_BASE_URL,
  mapWeChatError,
  WECHAT_API_BASE_URL_TOKEN,
  WECHAT_TOKEN_CACHE,
  WechatOfficialConnector,
  type WeChatTokenCache,
} from './wechat-official.connector';
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
