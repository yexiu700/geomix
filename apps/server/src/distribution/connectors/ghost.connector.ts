import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
  serializeJsonLdSafe,
  type ChannelRemoteTargetDto,
  type TestChannelConnectionInput,
} from '@geomix/shared';
import { OutboundHttpClient } from '../../infra/outbound-http';
import {
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

const GHOST_ADMIN_KEY_RE = /^([^:\s]+):((?:[0-9a-fA-F]{2}){8,})$/;
const GHOST_JWT_TTL_SECONDS = 300;
const GHOST_ACCEPT_VERSION = 'v5.0';

type GhostSiteResponse = {
  site?: {
    title?: string;
    description?: string;
    url?: string;
    version?: string;
  };
};

type GhostTagsResponse = {
  tags?: Array<{
    id?: string;
    name?: string;
    slug?: string;
    url?: string;
  }>;
};

type GhostPostItem = {
  id?: string;
  uuid?: string;
  slug?: string;
  title?: string;
  status?: string;
  url?: string;
};

type GhostPostsResponse = {
  posts?: GhostPostItem[];
};

/**
 * 解析 Ghost Admin API Key（格式：`{id}:{even_length_hex_secret}`，十六进制长度至少 16 位且为偶数）。
 */
export function parseGhostAdminApiKey(rawKey: string): { id: string; secretHex: string } {
  const trimmed = rawKey.trim();
  const match = GHOST_ADMIN_KEY_RE.exec(trimmed);
  if (!match) {
    throw new ConnectorError(
      'GHOST',
      'CONFIG_ERROR',
      'Ghost Admin API Key 格式不正确（应为 id:even_hex_secret）',
    );
  }
  return { id: match[1]!, secretHex: match[2]! };
}

/**
 * 使用纯 Node `node:crypto` 生成 Ghost Admin API v5 要求的 5 分钟有效 HS256 JWT。
 * 注意：密钥必须按十六进制解码为原始字节（`Buffer.from(secretHex, 'hex')`），绝不可按 UTF-8 字符串签名。
 */
export function signGhostAdminJwt(adminApiKey: string, nowSec?: number): string {
  const { id, secretHex } = parseGhostAdminApiKey(adminApiKey);
  const iat =
    typeof nowSec === 'number' && Number.isFinite(nowSec)
      ? Math.floor(nowSec)
      : Math.floor(Date.now() / 1000);
  const exp = iat + GHOST_JWT_TTL_SECONDS;

  const headerB64 = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }),
    'utf8',
  ).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ iat, exp, aud: '/admin/' }), 'utf8').toString(
    'base64url',
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureB64 = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signatureB64}`;
}

@Injectable()
export class GhostConnector implements CmsConnector {
  readonly provider = 'GHOST' as const;

  constructor(@Inject(OutboundHttpClient) private readonly http: OutboundHttpClient) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const adminApiKey = this.resolveAdminApiKey(secrets);
    const { secretHex } = parseGhostAdminApiKey(adminApiKey);
    const jwt = signGhostAdminJwt(adminApiKey);
    const secretCandidates = this.buildSecretCandidates(secrets, conn, jwt, secretHex);

    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const siteUrl = joinBasePath(conn.siteBaseUrl, '/ghost/api/admin/site/');
    const siteData = await this.requestJson<GhostSiteResponse>(
      siteUrl,
      'GET',
      jwt,
      undefined,
      secretCandidates,
    );
    if (!siteData?.site || typeof siteData.site !== 'object') {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Ghost 站点信息响应格式异常');
    }

    let primaryDomain: string | undefined;
    if (typeof siteData.site.url === 'string' && isSafeDistributionHttpUrl(siteData.site.url)) {
      try {
        await this.http.assertAllowedUrl(siteData.site.url);
        primaryDomain = trimTrailingSlashes(siteData.site.url);
      } catch {
        // 忽略上游返回的非公网站点 URL，不落入 primaryDomain
      }
    }

    let targets: ChannelRemoteTargetDto[] = [];
    try {
      targets = await this.fetchTags(conn.siteBaseUrl, jwt, secretCandidates);
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        (error.code === 'AUTH_FAILED' ||
          error.code === 'FORBIDDEN' ||
          error.code === 'SSRF_BLOCKED' ||
          error.code === 'TIMEOUT')
      ) {
        throw error;
      }
    }

    const siteTitle = siteData.site.title?.trim() || conn.displayName;
    const versionSuffix = siteData.site.version?.trim()
      ? ` (v${siteData.site.version.trim()})`
      : '';
    return {
      ok: true,
      message: `Ghost 站点连接正常：${siteTitle}${versionSuffix}，发现 ${targets.length} 个标签`,
      targets,
      ...(primaryDomain ? { discoveredConfig: { primaryDomain } } : {}),
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const adminApiKey = this.resolveAdminApiKey(secrets);
    const { secretHex } = parseGhostAdminApiKey(adminApiKey);
    const jwt = signGhostAdminJwt(adminApiKey);
    const secretCandidates = this.buildSecretCandidates(secrets, conn, jwt, secretHex);

    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);
    return this.fetchTags(conn.siteBaseUrl, jwt, secretCandidates);
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const adminApiKey = this.resolveAdminApiKey(secrets);
    const { secretHex } = parseGhostAdminApiKey(adminApiKey);
    const jwt = signGhostAdminJwt(adminApiKey);
    const secretCandidates = this.buildSecretCandidates(secrets, conn, jwt, secretHex);

    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const slug = payload.slug?.trim() || slugifyAscii(payload.title);
    const htmlBody = payload.html?.trim() || payload.markdown;
    const mergedTags = this.mergeTags(payload.tags, conn.configJson.tags);
    const canonicalUrl = this.resolveCanonicalUrl(payload);

    const postBody: Record<string, unknown> = {
      title: payload.title,
      html: htmlBody,
      status: payload.publishAsDraft ? 'draft' : 'published',
      ...(slug ? { slug } : {}),
      ...(payload.metaDesc?.trim()
        ? {
            custom_excerpt: payload.metaDesc.trim().slice(0, 300),
            meta_description: payload.metaDesc.trim().slice(0, 500),
          }
        : {}),
      ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
      ...(mergedTags.length > 0 ? { tags: mergedTags.map((name) => ({ name })) } : {}),
    };

    if (payload.schemaJsonLd && conn.configJson.inlineJsonLd !== false) {
      const safeJsonLd = serializeJsonLdSafe(payload.schemaJsonLd);
      postBody.codeinjection_head = `<script type="application/ld+json">\n${safeJsonLd}\n</script>`;
    }

    const endpoint = joinBasePath(conn.siteBaseUrl, '/ghost/api/admin/posts/', { source: 'html' });
    const resData = await this.requestJson<GhostPostsResponse>(
      endpoint,
      'POST',
      jwt,
      { posts: [postBody] },
      secretCandidates,
    );

    const created = Array.isArray(resData?.posts) ? resData.posts[0] : undefined;
    const remotePostId = created?.id ? String(created.id).trim() : '';
    if (!remotePostId) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Ghost 未返回新文章 ID');
    }

    const publishedAsDraft =
      typeof created?.status === 'string'
        ? created.status.toLowerCase() !== 'published'
        : payload.publishAsDraft;

    const remoteAdminUrl = `${joinBasePath(conn.siteBaseUrl, '/ghost/')}#/editor/post/${encodeURIComponent(remotePostId)}`;

    let remotePublishedUrl: string | undefined;
    if (!publishedAsDraft) {
      const createdSlug = created?.slug?.trim() || slug;
      const baseDomain = conn.configJson.primaryDomain?.trim() || conn.siteBaseUrl;
      const fallbackUrl = joinBasePath(baseDomain, `/${encodeURIComponent(createdSlug)}/`);
      const candidateUrl =
        typeof created?.url === 'string' && created.url.trim() ? created.url.trim() : fallbackUrl;
      remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, candidateUrl);
    }

    return {
      remotePostId,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private resolveAdminApiKey(secrets: ConnectorSecrets): string {
    const key = secrets.adminApiKey?.trim() ?? '';
    if (!key) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', '缺少 Ghost Admin API Key');
    }
    return key;
  }

  private buildSecretCandidates(
    secrets: ConnectorSecrets,
    conn: ConnectorConnectionContext,
    jwt: string,
    secretHex: string,
  ): string[] {
    return [
      jwt,
      secretHex,
      ...collectSecretCandidates(secrets, conn.configJson as Record<string, unknown>),
    ];
  }

  private async assertSafeSiteBaseUrl(
    siteBaseUrl: string,
    secretCandidates: readonly string[],
  ): Promise<void> {
    try {
      await this.http.assertAllowedUrl(siteBaseUrl);
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }
  }

  private async fetchTags(
    siteBaseUrl: string,
    jwt: string,
    secretCandidates: readonly string[],
  ): Promise<ChannelRemoteTargetDto[]> {
    const url = joinBasePath(siteBaseUrl, '/ghost/api/admin/tags/', { limit: 100 });
    const data = await this.requestJson<GhostTagsResponse>(
      url,
      'GET',
      jwt,
      undefined,
      secretCandidates,
    );
    const rows = Array.isArray(data?.tags) ? data.tags : [];
    const targets: ChannelRemoteTargetDto[] = [];
    for (const tag of rows) {
      const id = tag.id?.trim();
      const name = tag.name?.trim();
      if (!id || !name) continue;
      targets.push({
        id,
        name,
        ...(tag.slug?.trim() ? { handle: tag.slug.trim() } : {}),
        ...(tag.url?.trim() && isSafeDistributionHttpUrl(tag.url) ? { url: tag.url.trim() } : {}),
      });
    }
    return targets;
  }

  private mergeTags(payloadTags?: readonly string[], configTags?: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const source of [payloadTags ?? [], configTags ?? []]) {
      for (const raw of source) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out;
  }

  private resolveCanonicalUrl(payload: ConnectorPublishPayload): string | undefined {
    const candidates = [
      payload.canonicalUrl,
      typeof payload.extras?.canonicalUrl === 'string' ? payload.extras.canonicalUrl : undefined,
      typeof payload.extras?.canonicalGuideHint === 'string'
        ? payload.extras.canonicalGuideHint
        : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isSafeDistributionHttpUrl(candidate.trim())) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async requestJson<T>(
    url: string,
    method: 'GET' | 'POST' | 'PUT',
    jwt: string,
    body: unknown,
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method,
        headers: {
          Authorization: `Ghost ${jwt}`,
          Accept: 'application/json',
          'Accept-Version': GHOST_ACCEPT_VERSION,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<T>(response.body);
    if (!parsed || typeof parsed !== 'object') {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Ghost 接口返回了无效 JSON 响应');
    }
    return parsed;
  }
}
