import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
  serializeJsonLdSafe,
  type ChannelRemoteTargetDto,
  type TestChannelConnectionInput,
} from '@geomix/shared';
import { OutboundHttpClient } from '../../infra/outbound-http';
import {
  appendInlineJsonLd,
  collectSecretCandidates,
  ConnectorError,
  joinBasePath,
  mapHttpStatusError,
  mapTransportError,
  parseJsonSafe,
  slugifyAscii,
  trimTrailingSlashes,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

export const WEBFLOW_API_BASE_URL = Symbol('WEBFLOW_API_BASE_URL');
export const DEFAULT_WEBFLOW_API_BASE_URL = 'https://api.webflow.com';

type WebflowSite = {
  id?: string;
  displayName?: string;
  shortName?: string;
  customDomains?: Array<{ url?: string }>;
};

type WebflowCollection = {
  id?: string;
  displayName?: string;
  singularName?: string;
  slug?: string;
  fields?: WebflowField[];
};

type WebflowField = {
  id?: string;
  slug?: string;
  displayName?: string;
  type?: string;
  isRequired?: boolean;
};

type WebflowItemResponse = {
  id?: string;
  isDraft?: boolean;
  url?: string;
  publishedUrl?: string;
  fieldData?: Record<string, unknown>;
  items?: Array<{
    id?: string;
    isDraft?: boolean;
    url?: string;
    publishedUrl?: string;
    fieldData?: Record<string, unknown>;
  }>;
};

@Injectable()
export class WebflowConnector implements CmsConnector {
  readonly provider = 'WEBFLOW' as const;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(WEBFLOW_API_BASE_URL) private readonly apiBaseOverride?: string,
  ) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const { targets, sitesCount, collectionsCount } = await this.discoverTargets(
      conn,
      secrets,
      input,
    );
    return {
      ok: true,
      message: `Webflow 连接正常，发现 ${sitesCount} 个站点、${collectionsCount} 个内容集合`,
      targets,
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const { targets } = await this.discoverTargets(conn, secrets, input);
    return targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const apiToken = this.resolveApiToken(secrets);
    const secretCandidates = collectSecretCandidates(secrets);
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);
    const collectionId = payload.targetId?.trim() || conn.configJson.collectionId?.trim() || '';
    if (!collectionId) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '未配置 Webflow 目标集合（collectionId）',
      );
    }

    const fieldMap = conn.configJson.fieldMap;
    const titleField = fieldMap?.title?.trim() || 'name';
    const slugField = fieldMap?.slug?.trim() || 'slug';
    const bodyField = fieldMap?.bodyHtml?.trim() || 'post-body';
    const metaDescField = fieldMap?.metaDesc?.trim();
    const jsonLdField = fieldMap?.jsonLd?.trim();

    const finalSlug = payload.slug?.trim() || slugifyAscii(payload.title);
    let bodyHtml = payload.html || payload.markdown;

    const fieldData: Record<string, unknown> = {
      [titleField]: payload.title,
      [slugField]: finalSlug,
    };

    if (metaDescField && payload.metaDesc?.trim()) {
      fieldData[metaDescField] = payload.metaDesc.trim();
    }

    if (jsonLdField && payload.schemaJsonLd) {
      fieldData[jsonLdField] = serializeJsonLdSafe(payload.schemaJsonLd);
    } else if (payload.schemaJsonLd && conn.configJson.inlineJsonLd !== false) {
      bodyHtml = appendInlineJsonLd(bodyHtml, payload.schemaJsonLd, false);
    }

    fieldData[bodyField] = bodyHtml;

    const apiBase = this.resolveApiBaseUrl(conn);
    const suffixPath = payload.publishAsDraft
      ? `/v2/collections/${encodeURIComponent(collectionId)}/items`
      : `/v2/collections/${encodeURIComponent(collectionId)}/items/live`;
    const endpoint = joinBasePath(apiBase, suffixPath);

    let response;
    try {
      response = await this.http.request({
        url: endpoint,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isArchived: false,
          isDraft: payload.publishAsDraft,
          fieldData,
        }),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<WebflowItemResponse>(response.body);
    const item = Array.isArray(parsed?.items) ? parsed.items[0] : parsed;
    if (!item?.id) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'Webflow 未返回有效的内容条目编号',
        response.status,
      );
    }

    const publishedAsDraft =
      typeof item.isDraft === 'boolean' ? item.isDraft : payload.publishAsDraft;

    let remotePublishedUrl: string | undefined;
    if (!publishedAsDraft) {
      const directUrl =
        (typeof item.publishedUrl === 'string' && item.publishedUrl.trim()) ||
        (typeof item.url === 'string' && item.url.trim()) ||
        '';
      if (directUrl) {
        remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, directUrl);
      } else {
        const publicBase = this.resolvePublicBaseUrl(conn);
        const itemSlug =
          typeof item.fieldData?.[slugField] === 'string' && item.fieldData[slugField].trim()
            ? item.fieldData[slugField].trim()
            : finalSlug;
        const collectionSlug =
          typeof conn.configJson.collectionSlug === 'string' &&
          conn.configJson.collectionSlug.trim()
            ? conn.configJson.collectionSlug.trim()
            : 'posts';
        if (publicBase && itemSlug) {
          const candidate = `${trimTrailingSlashes(publicBase)}/${encodeURIComponent(collectionSlug)}/${encodeURIComponent(itemSlug)}`;
          remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, candidate);
        }
      }
    }

    return {
      remotePostId: String(item.id),
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private async discoverTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<{
    targets: ChannelRemoteTargetDto[];
    sitesCount: number;
    collectionsCount: number;
  }> {
    const apiToken = this.resolveApiToken(secrets);
    const secretCandidates = collectSecretCandidates(secrets);
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);
    const apiBase = this.resolveApiBaseUrl(conn);

    // 1. 拉取站点列表
    const sitesRaw = await this.apiGet<{ sites?: WebflowSite[] } | WebflowSite[]>(
      joinBasePath(apiBase, '/v2/sites'),
      apiToken,
      secretCandidates,
    );
    const sites = Array.isArray(sitesRaw)
      ? sitesRaw
      : Array.isArray(sitesRaw?.sites)
        ? sitesRaw.sites
        : [];

    const resolvedSiteId =
      input?.siteId?.trim() || conn.configJson.siteId?.trim() || sites[0]?.id?.trim() || '';

    // 2. 拉取站点下的集合列表（兼容 /v2/sites/:siteId/collections 与 /v2/collections?siteId=...）
    let collections: WebflowCollection[] = [];
    if (resolvedSiteId) {
      collections = await this.fetchCollections(
        apiBase,
        resolvedSiteId,
        apiToken,
        secretCandidates,
      );
    }

    // 3. 拉取指定集合的字段定义
    const resolvedCollectionId =
      input?.collectionId?.trim() ||
      conn.configJson.collectionId?.trim() ||
      collections[0]?.id?.trim() ||
      '';
    let fieldsByCollectionId: Map<string, WebflowField[]> | undefined;
    if (resolvedCollectionId) {
      const detail = await this.fetchCollectionDetailSafe(
        apiBase,
        resolvedCollectionId,
        apiToken,
        secretCandidates,
      );
      if (detail?.fields && Array.isArray(detail.fields)) {
        fieldsByCollectionId = new Map([[resolvedCollectionId, detail.fields]]);
      }
    }

    if (collections.length > 0) {
      const targets: ChannelRemoteTargetDto[] = [];
      for (const col of collections) {
        const id = col.id?.trim();
        const name = col.displayName?.trim() || col.singularName?.trim() || col.slug?.trim();
        if (!id || !name) continue;
        const fields = fieldsByCollectionId?.get(id) ?? col.fields;
        targets.push({
          id,
          name,
          handle: col.slug?.trim() || undefined,
          meta: {
            ...(resolvedSiteId ? { siteId: resolvedSiteId } : {}),
            ...(col.slug?.trim() ? { collectionSlug: col.slug.trim() } : {}),
            ...(Array.isArray(fields)
              ? {
                  fields: fields.map((f) => ({
                    id: f.id,
                    slug: f.slug,
                    displayName: f.displayName,
                    type: f.type,
                    isRequired: f.isRequired ?? false,
                  })),
                }
              : {}),
          },
        });
      }
      return {
        targets,
        sitesCount: sites.length,
        collectionsCount: targets.length,
      };
    }

    const siteTargets: ChannelRemoteTargetDto[] = [];
    for (const site of sites) {
      const id = site.id?.trim();
      const name = site.displayName?.trim() || site.shortName?.trim();
      if (!id || !name) continue;
      siteTargets.push({
        id,
        name,
        handle: site.shortName?.trim() || undefined,
        meta: { kind: 'site' },
      });
    }

    return {
      targets: siteTargets,
      sitesCount: sites.length,
      collectionsCount: 0,
    };
  }

  private async fetchCollections(
    apiBase: string,
    siteId: string,
    apiToken: string,
    secretCandidates: readonly string[],
  ): Promise<WebflowCollection[]> {
    const primaryUrl = joinBasePath(apiBase, `/v2/sites/${encodeURIComponent(siteId)}/collections`);
    let response;
    try {
      response = await this.http.request({
        url: primaryUrl,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status === 404) {
      // 兼容简化路由 /v2/collections?siteId=...
      const fallbackRaw = await this.apiGet<
        { collections?: WebflowCollection[] } | WebflowCollection[]
      >(joinBasePath(apiBase, '/v2/collections', { siteId }), apiToken, secretCandidates);
      return Array.isArray(fallbackRaw)
        ? fallbackRaw
        : Array.isArray(fallbackRaw?.collections)
          ? fallbackRaw.collections
          : [];
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<{ collections?: WebflowCollection[] } | WebflowCollection[]>(
      response.body,
    );
    if (!parsed) return [];
    return Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.collections)
        ? parsed.collections
        : [];
  }

  private async fetchCollectionDetailSafe(
    apiBase: string,
    collectionId: string,
    apiToken: string,
    secretCandidates: readonly string[],
  ): Promise<WebflowCollection | null> {
    const url = joinBasePath(apiBase, `/v2/collections/${encodeURIComponent(collectionId)}`);
    let response;
    try {
      response = await this.http.request({
        url,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }
    return parseJsonSafe<WebflowCollection>(response.body);
  }

  private async apiGet<T>(
    url: string,
    apiToken: string,
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<T>(response.body);
    if (!parsed) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'Webflow API 返回格式异常，无法解析 JSON',
        response.status,
      );
    }
    return parsed;
  }

  private resolveApiToken(secrets: ConnectorSecrets): string {
    const token = secrets.apiToken?.trim() ?? '';
    if (!token) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', '缺少 Webflow API Token');
    }
    return token;
  }

  private resolveApiBaseUrl(conn: ConnectorConnectionContext): string {
    const configured = conn.configJson.apiBaseUrl;
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim();
    }
    if (this.apiBaseOverride?.trim()) {
      return this.apiBaseOverride.trim();
    }
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const bareHost = host.replace(/^\[|\]$/g, '');
      if (
        host === 'api.webflow.com' ||
        parsed.pathname.startsWith('/webflow') ||
        host.endsWith('.e2e.example') ||
        isIP(bareHost) !== 0
      ) {
        return conn.siteBaseUrl.trim();
      }
    } catch {
      // Fall back to official Webflow Data API endpoint
    }
    return DEFAULT_WEBFLOW_API_BASE_URL;
  }

  private async assertSafeSiteBaseUrl(
    siteBaseUrl: string,
    secretCandidates: readonly string[],
  ): Promise<void> {
    if (!isSafeDistributionHttpUrl(siteBaseUrl)) {
      throw new ConnectorError(
        this.provider,
        'SSRF_BLOCKED',
        '目标地址不允许访问（已触发 SSRF 安全拦截）',
      );
    }
    try {
      await this.http.assertAllowedUrl(siteBaseUrl);
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }
  }

  private resolvePublicBaseUrl(conn: ConnectorConnectionContext): string | undefined {
    const primary = conn.configJson.primaryDomain?.trim();
    if (primary) {
      return primary;
    }
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      if (host !== 'api.webflow.com' && !parsed.pathname.startsWith('/webflow')) {
        return conn.siteBaseUrl.trim();
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
