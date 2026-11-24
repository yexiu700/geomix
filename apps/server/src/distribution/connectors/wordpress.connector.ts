import { Inject, Injectable } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
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
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

type WordPressUserResponse = {
  id?: number | string;
  name?: string;
  slug?: string;
};

type WordPressCategoryItem = {
  id?: number | string;
  name?: string;
  slug?: string;
  link?: string;
  count?: number;
};

type WordPressPostResponse = {
  id?: number | string;
  status?: string;
  link?: string;
};

@Injectable()
export class WordPressConnector implements CmsConnector {
  readonly provider = 'WORDPRESS' as const;

  constructor(@Inject(OutboundHttpClient) private readonly http: OutboundHttpClient) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const { authHeader, secretCandidates } = this.buildAuth(secrets, conn.configJson);
    const endpoint = joinBasePath(conn.siteBaseUrl, '/wp-json/wp/v2/users/me');

    let response;
    try {
      response = await this.http.request({
        url: endpoint,
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const user = parseJsonSafe<WordPressUserResponse>(response.body);
    if (!user || typeof user !== 'object' || (!user.id && !user.name && !user.slug)) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'WordPress REST API 返回格式异常，请确认站点已启用 WP REST API v2',
        response.status,
      );
    }

    let targets: ChannelRemoteTargetDto[] = [];
    try {
      targets = await this.listTargets(conn, secrets);
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
      // 分类接口被受限或禁用时平滑降级为空列表
      targets = [];
    }

    const userLabel = user.name?.trim() || user.slug?.trim() || String(user.id ?? '');
    return {
      ok: true,
      message: userLabel
        ? `WordPress 账号「${userLabel}」认证通过，发现 ${targets.length} 个文章分类`
        : `WordPress 认证通过，发现 ${targets.length} 个文章分类`,
      targets,
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const { authHeader, secretCandidates } = this.buildAuth(secrets, conn.configJson);
    const endpoint = joinBasePath(conn.siteBaseUrl, '/wp-json/wp/v2/categories', {
      per_page: 100,
    });

    let response;
    try {
      response = await this.http.request({
        url: endpoint,
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const categories = parseJsonSafe<WordPressCategoryItem[]>(response.body);
    if (!Array.isArray(categories)) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'WordPress 分类列表返回格式异常',
        response.status,
      );
    }

    const targets: ChannelRemoteTargetDto[] = [];
    for (const item of categories) {
      if (item.id === undefined || !item.name?.trim()) continue;
      targets.push({
        id: String(item.id),
        name: item.name.trim(),
        handle: item.slug?.trim() || undefined,
        url:
          typeof item.link === 'string' && isSafeDistributionHttpUrl(item.link)
            ? item.link.trim()
            : undefined,
        meta: typeof item.count === 'number' ? { count: item.count } : undefined,
      });
    }
    return targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const { authHeader, secretCandidates } = this.buildAuth(secrets, conn.configJson);
    const endpoint = joinBasePath(conn.siteBaseUrl, '/wp-json/wp/v2/posts');

    const baseContent = payload.html || payload.markdown;
    const content =
      payload.schemaJsonLd && conn.configJson.inlineJsonLd !== false
        ? appendInlineJsonLd(baseContent, payload.schemaJsonLd, true)
        : baseContent;

    const categoryIds = this.resolveCategoryIds(conn, payload);

    const requestBody: Record<string, unknown> = {
      title: payload.title,
      content,
      status: payload.publishAsDraft ? 'draft' : 'publish',
    };
    if (payload.slug?.trim()) {
      requestBody.slug = payload.slug.trim();
    }
    if (payload.metaDesc?.trim()) {
      requestBody.excerpt = payload.metaDesc.trim();
    }
    if (categoryIds.length > 0) {
      requestBody.categories = categoryIds;
    }

    let response;
    try {
      response = await this.http.request({
        url: endpoint,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const post = parseJsonSafe<WordPressPostResponse>(response.body);
    if (!post || post.id === undefined || post.id === null) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'WordPress 未返回有效的文章编号',
        response.status,
      );
    }

    const remotePostId = String(post.id);
    const remoteAdminUrl = joinBasePath(conn.siteBaseUrl, '/wp-admin/post.php', {
      post: remotePostId,
      action: 'edit',
    });
    const publishedAsDraft =
      typeof post.status === 'string' && post.status.trim()
        ? post.status.trim().toLowerCase() !== 'publish'
        : payload.publishAsDraft;

    let remotePublishedUrl: string | undefined;
    if (!publishedAsDraft) {
      const directLink = typeof post.link === 'string' ? post.link.trim() : '';
      if (directLink) {
        remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, directLink);
      }
    }

    return {
      remotePostId,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private resolveCategoryIds(
    conn: ConnectorConnectionContext,
    payload: ConnectorPublishPayload,
  ): number[] {
    const configured = (conn.configJson.categoryIds ?? []).filter(
      (id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0,
    );
    if (configured.length > 0) return configured;

    const targetRaw = payload.targetId?.trim();
    if (targetRaw && /^\d+$/.test(targetRaw)) {
      const parsed = Number(targetRaw);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return [parsed];
      }
    }
    return [];
  }

  private buildAuth(
    secrets: ConnectorSecrets,
    configJson?: ConnectorConnectionContext['configJson'],
  ): {
    authHeader: string;
    secretCandidates: string[];
  } {
    const username = secrets.username?.trim() ?? '';
    const appPassword = (secrets.appPassword ?? secrets.applicationPassword ?? '').trim();
    if (!username || !appPassword) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '缺少 WordPress 用户名或 Application Password',
      );
    }
    const basicToken = Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64');
    const compactPassword = appPassword.replace(/\s+/g, '');
    const candidates = new Set<string>([
      basicToken,
      appPassword,
      ...(compactPassword ? [compactPassword] : []),
      ...collectSecretCandidates(secrets, configJson as Record<string, unknown> | undefined),
    ]);
    return {
      authHeader: `Basic ${basicToken}`,
      secretCandidates: [...candidates].sort((a, b) => b.length - a.length),
    };
  }
}
