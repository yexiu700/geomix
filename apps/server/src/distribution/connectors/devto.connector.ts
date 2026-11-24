import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
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
  trimTrailingSlashes,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

export const DEVTO_API_BASE_URL = Symbol('DEVTO_API_BASE_URL');
export const DEFAULT_DEVTO_API_BASE_URL = 'https://dev.to';

type DevtoUserResponse = {
  id?: number | string;
  username?: string;
  name?: string;
  website_url?: string;
};

type DevtoArticleResponse = {
  id?: number | string;
  title?: string;
  slug?: string;
  path?: string;
  url?: string;
  published?: boolean;
};

/**
 * 规范化 Dev.to / Forem 标签：
 * - 去除变音符、转小写、仅保留 ASCII 字母与数字（Forem 拒绝空格/连字符/非 ASCII 字符）
 * - 单标签截断至 30 字符、去重保序、最多保留 `maxTags` 个（默认 4 个）
 */
export function normalizeDevtoTags(rawTags: readonly string[], maxTags = 4): string[] {
  const limit = Math.max(0, Math.floor(maxTags));
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of rawTags) {
    if (normalized.length >= limit) break;
    if (typeof raw !== 'string') continue;
    const cleaned = raw
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 30);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

@Injectable()
export class DevtoConnector implements CmsConnector {
  readonly provider = 'DEVTO' as const;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(DEVTO_API_BASE_URL) private readonly apiBaseOverride?: string,
  ) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const apiKey = this.resolveApiKey(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const apiBase = this.resolveApiBaseUrl(conn);
    const userUrl = joinBasePath(apiBase, '/api/users/me');
    const user = await this.requestJson<DevtoUserResponse>(
      userUrl,
      'GET',
      apiKey,
      undefined,
      secretCandidates,
    );

    const userId = user?.id !== undefined && user?.id !== null ? String(user.id).trim() : '';
    const username = user?.username?.trim() || '';
    if (!userId && !username) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Dev.to 用户信息响应格式异常');
    }

    const displayName = user.name?.trim() || username || 'Dev.to Account';
    const profileUrl =
      typeof user.website_url === 'string' && isSafeDistributionHttpUrl(user.website_url.trim())
        ? user.website_url.trim()
        : username
          ? `${DEFAULT_DEVTO_API_BASE_URL}/${encodeURIComponent(username)}`
          : undefined;

    const target: ChannelRemoteTargetDto = {
      id: userId || username,
      name: displayName,
      ...(username ? { handle: username } : {}),
      ...(profileUrl ? { url: profileUrl } : {}),
    };

    return {
      ok: true,
      message: `Dev.to 账号连接正常：${displayName}${username ? ` (@${username})` : ''}`,
      targets: [target],
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const res = await this.testConnection(conn, secrets, input);
    return res.targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const apiKey = this.resolveApiKey(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const apiBase = this.resolveApiBaseUrl(conn);
    const tags = normalizeDevtoTags([...(payload.tags ?? []), ...(conn.configJson.tags ?? [])], 4);
    const canonicalUrl = this.resolveCanonicalUrl(payload);
    const bodyMarkdown = payload.markdown?.trim() || payload.html;

    const articleBody: Record<string, unknown> = {
      title: payload.title,
      body_markdown: bodyMarkdown,
      published: !payload.publishAsDraft,
      ...(payload.metaDesc?.trim() ? { description: payload.metaDesc.trim().slice(0, 200) } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    };

    const existingRemoteId = payload.remotePostId?.trim() ?? '';
    const isNumericUpdate = /^\d+$/.test(existingRemoteId);
    const endpoint = isNumericUpdate
      ? joinBasePath(apiBase, `/api/articles/${encodeURIComponent(existingRemoteId)}`)
      : joinBasePath(apiBase, '/api/articles');
    const method = isNumericUpdate ? 'PUT' : 'POST';

    const created = await this.requestJson<DevtoArticleResponse>(
      endpoint,
      method,
      apiKey,
      { article: articleBody },
      secretCandidates,
    );

    if (created?.id === undefined || created?.id === null || String(created.id).trim() === '') {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Dev.to 未返回新文章 ID');
    }

    const remotePostId = String(created.id).trim();
    const publishedAsDraft =
      typeof created.published === 'boolean' ? !created.published : payload.publishAsDraft;

    const rawUrl = typeof created.url === 'string' ? created.url.trim() : '';
    const remoteAdminUrl =
      rawUrl && isSafeDistributionHttpUrl(rawUrl)
        ? `${trimTrailingSlashes(rawUrl)}/edit`
        : undefined;

    let remotePublishedUrl: string | undefined;
    if (!publishedAsDraft && rawUrl) {
      remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, rawUrl);
    }

    return {
      remotePostId,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private resolveApiKey(secrets: ConnectorSecrets): string {
    const key = secrets.apiKey?.trim() ?? '';
    if (!key) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', '缺少 Dev.to API Key');
    }
    return key;
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

  private resolveApiBaseUrl(conn: ConnectorConnectionContext): string {
    const configApiBase = (conn.configJson as Record<string, unknown>).apiBaseUrl;
    if (typeof configApiBase === 'string' && configApiBase.trim()) {
      return configApiBase.trim();
    }
    if (this.apiBaseOverride?.trim()) {
      return this.apiBaseOverride.trim();
    }
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const bareHost = host.replace(/^\[|\]$/g, '');
      if (host === 'dev.to' || host === 'www.dev.to') {
        return DEFAULT_DEVTO_API_BASE_URL;
      }
      if (
        host.endsWith('.e2e.example') ||
        isIP(bareHost) !== 0 ||
        parsed.pathname.startsWith('/devto')
      ) {
        return conn.siteBaseUrl.trim();
      }
    } catch {
      // Fallback to default official Forem API base
    }
    return DEFAULT_DEVTO_API_BASE_URL;
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
    apiKey: string,
    body: unknown,
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method,
        headers: {
          'api-key': apiKey,
          Accept: 'application/vnd.forem.api-v1+json',
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
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Dev.to 接口返回了无效 JSON 响应');
    }
    return parsed;
  }
}
