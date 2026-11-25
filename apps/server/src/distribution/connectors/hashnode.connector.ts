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
  mapHttpStatusError,
  mapTransportError,
  parseJsonSafe,
  redactSecrets,
  slugifyAscii,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

export const HASHNODE_API_BASE_URL = Symbol('HASHNODE_API_BASE_URL');
export const DEFAULT_HASHNODE_API_BASE_URL = 'https://gql.hashnode.com';

const ME_QUERY = `
query GeoMixHashnodeMe {
  me {
    id
    username
    name
    publications(first: 20) {
      edges {
        node {
          id
          title
          url
          domainInfo {
            hashnodeSubdomain
          }
        }
      }
    }
  }
}
`;

const CREATE_DRAFT_MUTATION = `
mutation GeoMixCreateDraft($input: CreateDraftInput!) {
  createDraft(input: $input) {
    draft {
      id
      slug
      title
      canonicalUrl
    }
  }
}
`;

const PUBLISH_POST_MUTATION = `
mutation GeoMixPublishPost($input: PublishPostInput!) {
  publishPost(input: $input) {
    post {
      id
      slug
      title
      url
      canonicalUrl
    }
  }
}
`;

type HashnodeGqlError = {
  message?: string;
  extensions?: {
    code?: string;
  };
};

type HashnodeGqlEnvelope<T> = {
  data?: T;
  errors?: HashnodeGqlError[];
};

type HashnodePublicationNode = {
  id?: string;
  title?: string;
  url?: string;
  domainInfo?: {
    hashnodeSubdomain?: string;
  };
};

type HashnodeMeData = {
  me?: {
    id?: string;
    username?: string;
    name?: string;
    publications?: {
      edges?: Array<{ node?: HashnodePublicationNode }>;
      nodes?: HashnodePublicationNode[];
    };
  } | null;
};

type HashnodeCreateDraftData = {
  createDraft?: {
    draft?: {
      id?: string;
      slug?: string;
      title?: string;
      canonicalUrl?: string | null;
    } | null;
  } | null;
};

type HashnodePublishPostData = {
  publishPost?: {
    post?: {
      id?: string;
      slug?: string;
      title?: string;
      url?: string;
      canonicalUrl?: string | null;
    } | null;
  } | null;
};

@Injectable()
export class HashnodeConnector implements CmsConnector {
  readonly provider = 'HASHNODE' as const;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(HASHNODE_API_BASE_URL) private readonly apiBaseOverride?: string,
  ) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const { meName, username, targets } = await this.fetchMeAndPublications(conn, secrets);
    const firstPubId = targets[0]?.id;
    return {
      ok: true,
      message: `Hashnode 连接正常：${meName}${username ? ` (@${username})` : ''}，发现 ${targets.length} 个 Publication`,
      targets,
      ...(firstPubId ? { discoveredConfig: { publicationId: firstPubId } } : {}),
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const { targets } = await this.fetchMeAndPublications(conn, secrets);
    return targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const apiToken = this.resolveApiToken(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    let publicationId = payload.targetId?.trim() || conn.configJson.publicationId?.trim() || '';
    if (!publicationId) {
      const targets = await this.listTargets(conn, secrets);
      publicationId = targets[0]?.id ?? '';
    }
    if (!publicationId) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '缺少 Hashnode Publication ID，请在连接配置中填写或先在 Hashnode 创建 Publication',
      );
    }

    const endpoint = this.resolveEndpointUrl(conn);
    const slug = payload.slug?.trim() || slugifyAscii(payload.title);
    const canonicalUrl = this.resolveCanonicalUrl(payload);
    const tags = this.buildTags(payload.tags, conn.configJson.tags);

    const input: Record<string, unknown> = {
      publicationId,
      title: payload.title,
      contentMarkdown: payload.markdown?.trim() || payload.html,
      ...(slug ? { slug } : {}),
      ...(payload.metaDesc?.trim() ? { subtitle: payload.metaDesc.trim().slice(0, 250) } : {}),
      ...(canonicalUrl ? { originalArticleURL: canonicalUrl } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(payload.metaDesc?.trim()
        ? {
            metaTags: {
              title: payload.title.slice(0, 160),
              description: payload.metaDesc.trim().slice(0, 320),
            },
          }
        : {}),
    };

    if (payload.publishAsDraft) {
      const data = await this.requestGraphql<HashnodeCreateDraftData>(
        endpoint,
        apiToken,
        CREATE_DRAFT_MUTATION,
        { input },
        secretCandidates,
      );
      const draft = data?.createDraft?.draft;
      const draftId = draft?.id?.trim() ?? '';
      if (!draftId) {
        throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Hashnode 未返回草稿 ID');
      }
      return {
        remotePostId: draftId,
        remoteAdminUrl: `https://hashnode.com/draft/${encodeURIComponent(draftId)}`,
        publishedAsDraft: true,
      };
    }

    const data = await this.requestGraphql<HashnodePublishPostData>(
      endpoint,
      apiToken,
      PUBLISH_POST_MUTATION,
      { input },
      secretCandidates,
    );
    const post = data?.publishPost?.post;
    const postId = post?.id?.trim() ?? '';
    if (!postId) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Hashnode 未返回发布文章 ID');
    }

    let remotePublishedUrl: string | undefined;
    if (typeof post?.url === 'string' && post.url.trim()) {
      remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, post.url);
    }

    return {
      remotePostId: postId,
      remotePublishedUrl,
      publishedAsDraft: false,
    };
  }

  private async fetchMeAndPublications(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
  ): Promise<{ meName: string; username: string; targets: ChannelRemoteTargetDto[] }> {
    const apiToken = this.resolveApiToken(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const endpoint = this.resolveEndpointUrl(conn);
    const data = await this.requestGraphql<HashnodeMeData>(
      endpoint,
      apiToken,
      ME_QUERY,
      {},
      secretCandidates,
    );
    const me = data?.me;
    if (!me || (!me.id && !me.username)) {
      throw new ConnectorError(
        this.provider,
        'AUTH_FAILED',
        'Hashnode 认证失败，请检查 Personal Access Token',
      );
    }

    const edgeNodes = Array.isArray(me.publications?.edges)
      ? me.publications.edges
          .map((e) => e?.node)
          .filter((n): n is HashnodePublicationNode => Boolean(n))
      : [];
    const directNodes = Array.isArray(me.publications?.nodes) ? me.publications.nodes : [];
    const nodes = edgeNodes.length > 0 ? edgeNodes : directNodes;

    const targets: ChannelRemoteTargetDto[] = [];
    for (const pub of nodes) {
      const id = pub.id?.trim();
      if (!id) continue;
      const title = pub.title?.trim() || pub.domainInfo?.hashnodeSubdomain?.trim() || id;
      const handle = pub.domainInfo?.hashnodeSubdomain?.trim();
      const safeUrl =
        typeof pub.url === 'string' && isSafeDistributionHttpUrl(pub.url.trim())
          ? pub.url.trim()
          : undefined;
      targets.push({
        id,
        name: title,
        ...(handle ? { handle } : {}),
        ...(safeUrl ? { url: safeUrl } : {}),
      });
    }

    return {
      meName: me.name?.trim() || me.username?.trim() || 'Hashnode Account',
      username: me.username?.trim() || '',
      targets,
    };
  }

  private resolveApiToken(secrets: ConnectorSecrets): string {
    const token = secrets.apiToken?.trim() ?? '';
    if (!token) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '缺少 Hashnode Personal Access Token',
      );
    }
    return token;
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

  private resolveEndpointUrl(conn: ConnectorConnectionContext): string {
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
      if (
        host === 'gql.hashnode.com' ||
        host.endsWith('.e2e.example') ||
        isIP(bareHost) !== 0 ||
        parsed.pathname.startsWith('/hashnode')
      ) {
        return conn.siteBaseUrl.trim();
      }
    } catch {
      // Fallback to official Hashnode GraphQL endpoint
    }
    return DEFAULT_HASHNODE_API_BASE_URL;
  }

  private buildTags(
    payloadTags?: readonly string[],
    configTags?: readonly string[],
  ): Array<{ slug: string; name: string }> {
    const seen = new Set<string>();
    const out: Array<{ slug: string; name: string }> = [];
    for (const source of [payloadTags ?? [], configTags ?? []]) {
      for (const raw of source) {
        if (out.length >= 5) break;
        const name = raw.trim().slice(0, 50);
        if (!name) continue;
        const slug = slugifyAscii(name);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        out.push({ slug, name });
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

  private async requestGraphql<T>(
    url: string,
    apiToken: string,
    query: string,
    variables: Record<string, unknown>,
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method: 'POST',
        headers: {
          Authorization: apiToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<HashnodeGqlEnvelope<T>>(response.body);
    if (!parsed || typeof parsed !== 'object') {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'Hashnode GraphQL 接口返回了无效 JSON 响应',
      );
    }

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw this.mapGraphqlError(parsed.errors[0]!, secretCandidates);
    }

    if (!parsed.data) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'Hashnode GraphQL 响应缺少 data');
    }

    return parsed.data;
  }

  private mapGraphqlError(
    error: HashnodeGqlError,
    secretCandidates: readonly string[],
  ): ConnectorError {
    const code = (error.extensions?.code ?? '').toUpperCase();
    const rawMessage = error.message?.trim() || 'Hashnode GraphQL 请求失败';
    const safeMsg = redactSecrets(rawMessage, secretCandidates, 220);

    if (code === 'UNAUTHENTICATED' || /unauthenticated|unauthorized/i.test(rawMessage)) {
      return new ConnectorError(
        this.provider,
        'AUTH_FAILED',
        'Hashnode 认证失败，请检查 Personal Access Token',
        401,
      );
    }
    if (code === 'FORBIDDEN' || /forbidden/i.test(rawMessage)) {
      return new ConnectorError(
        this.provider,
        'FORBIDDEN',
        'Hashnode 权限不足，请确认 Token 具备目标 Publication 发布权限',
        403,
      );
    }
    if (code === 'TOO_MANY_REQUESTS' || /rate limit|throttl/i.test(rawMessage)) {
      return new ConnectorError(
        this.provider,
        'RATE_LIMITED',
        'Hashnode 接口触发限流，请稍后重试',
        429,
      );
    }
    if (code === 'BAD_USER_INPUT') {
      return new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        `Hashnode 参数校验失败：${safeMsg}`,
        422,
      );
    }
    return new ConnectorError(this.provider, 'UPSTREAM_ERROR', `Hashnode 请求失败：${safeMsg}`);
  }
}
