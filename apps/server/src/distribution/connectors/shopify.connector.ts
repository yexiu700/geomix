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
  redactSecrets,
  trimTrailingSlashes,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

const DEFAULT_SHOPIFY_API_VERSION = '2025-01';
const API_VERSION_PATTERN = /^(?:\d{4}-\d{2}|unstable)$/;

const LIST_BLOGS_QUERY = `query GeoMixListBlogs {
  shop {
    name
    primaryDomain {
      url
    }
  }
  blogs(first: 20) {
    nodes {
      id
      title
      handle
    }
  }
}`;

const ARTICLE_CREATE_MUTATION = `mutation GeoMixArticleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article {
      id
      handle
      title
      isPublished
      blog {
        id
        handle
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

type ShopifyGraphQlError = {
  message?: string;
  extensions?: { code?: string };
};

type ShopifyBlogNode = {
  id?: string;
  title?: string;
  handle?: string;
};

type ShopifyListBlogsResponse = {
  data?: {
    shop?: {
      name?: string;
      primaryDomain?: { url?: string | null } | null;
    } | null;
    blogs?: {
      nodes?: ShopifyBlogNode[];
      edges?: Array<{ node?: ShopifyBlogNode | null } | null>;
    } | null;
  };
  errors?: ShopifyGraphQlError[];
};

type ShopifyArticleCreateResponse = {
  data?: {
    articleCreate?: {
      article?: {
        id?: string;
        handle?: string;
        title?: string;
        isPublished?: boolean;
        onlineStoreUrl?: string | null;
        url?: string | null;
        blog?: { id?: string; handle?: string } | null;
      } | null;
      userErrors?: Array<{
        field?: string[] | string | null;
        message?: string;
        code?: string;
      }>;
    } | null;
  };
  errors?: ShopifyGraphQlError[];
};

@Injectable()
export class ShopifyConnector implements CmsConnector {
  readonly provider = 'SHOPIFY' as const;

  constructor(@Inject(OutboundHttpClient) private readonly http: OutboundHttpClient) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const { shopName, primaryDomainUrl, targets } = await this.fetchShopAndBlogs(conn, secrets);
    return {
      ok: true,
      message: shopName
        ? `Shopify 店铺「${shopName}」连接正常，发现 ${targets.length} 个博客目标`
        : `Shopify 连接正常，发现 ${targets.length} 个博客目标`,
      targets,
      discoveredConfig: primaryDomainUrl ? { primaryDomain: primaryDomainUrl } : undefined,
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const { targets } = await this.fetchShopAndBlogs(conn, secrets);
    return targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const secretCandidates = collectSecretCandidates(secrets);
    let blogId = payload.targetId?.trim() || conn.configJson.blogId?.trim() || '';
    let blogHandle = conn.configJson.blogHandle?.trim() || '';
    let primaryDomain = conn.configJson.primaryDomain?.trim() || '';

    if (!blogId) {
      const targets = await this.listTargets(conn, secrets);
      const first = targets[0];
      if (!first) {
        throw new ConnectorError(
          this.provider,
          'CONFIG_ERROR',
          '未找到可用的 Shopify 博客，请先在店铺中创建博客或指定 blogId',
        );
      }
      blogId = first.id;
      blogHandle = blogHandle || first.handle || '';
      if (!primaryDomain && typeof first.meta?.primaryDomainUrl === 'string') {
        primaryDomain = first.meta.primaryDomainUrl;
      }
    }

    let body = payload.html || payload.markdown;
    if (payload.schemaJsonLd && conn.configJson.inlineJsonLd !== false) {
      body = appendInlineJsonLd(body, payload.schemaJsonLd, false);
    }

    const rawConfigAuthor = conn.configJson.author;
    const authorName =
      typeof rawConfigAuthor === 'string' && rawConfigAuthor.trim()
        ? rawConfigAuthor.trim()
        : conn.displayName.trim() || 'Editorial Team';

    const articleInput: Record<string, unknown> = {
      blogId,
      title: payload.title,
      body,
      isPublished: !payload.publishAsDraft,
      author: { name: authorName },
    };
    if (payload.slug?.trim()) {
      articleInput.handle = payload.slug.trim();
    }
    if (payload.metaDesc?.trim()) {
      articleInput.summary = payload.metaDesc.trim();
    }
    if (payload.tags && payload.tags.length > 0) {
      articleInput.tags = payload.tags;
    }

    const parsed = await this.graphqlRequest<ShopifyArticleCreateResponse>(
      conn,
      secrets,
      secretCandidates,
      ARTICLE_CREATE_MUTATION,
      { article: articleInput },
    );

    const createResult = parsed.data?.articleCreate;
    const userErrors = createResult?.userErrors ?? [];
    if (userErrors.length > 0) {
      const joined = userErrors
        .map((err) => {
          const field = Array.isArray(err.field)
            ? err.field.join('.')
            : typeof err.field === 'string'
              ? err.field
              : '';
          const msg = err.message ?? err.code ?? '参数校验失败';
          return field ? `${field}: ${msg}` : msg;
        })
        .join('；');
      throw new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        `Shopify 文章创建失败：${redactSecrets(joined, secretCandidates, 220)}`,
      );
    }

    const article = createResult?.article;
    if (!article?.id) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'Shopify 未返回有效的文章编号，请检查店铺配置后重试',
      );
    }

    const publishedAsDraft =
      typeof article.isPublished === 'boolean' ? !article.isPublished : payload.publishAsDraft;

    const numericMatch = /Article\/(\d+)$/.exec(article.id);
    const remoteAdminUrl = numericMatch?.[1]
      ? joinBasePath(conn.siteBaseUrl, `/admin/articles/${numericMatch[1]}`)
      : undefined;

    let remotePublishedUrl: string | undefined;
    if (!publishedAsDraft) {
      const directUrl =
        (typeof article.onlineStoreUrl === 'string' && article.onlineStoreUrl.trim()) ||
        (typeof article.url === 'string' && article.url.trim()) ||
        '';
      if (directUrl) {
        remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, directUrl);
      } else {
        const resolvedBlogHandle = article.blog?.handle?.trim() || blogHandle || 'news';
        const resolvedArticleHandle = article.handle?.trim() || payload.slug?.trim() || '';
        const publicBase = primaryDomain || conn.siteBaseUrl;
        if (resolvedArticleHandle && publicBase) {
          if (!isSafeDistributionHttpUrl(publicBase)) {
            throw new ConnectorError(
              this.provider,
              'SSRF_BLOCKED',
              '上游返回的发布链接未通过公网安全校验',
            );
          }
          const candidate = joinBasePath(
            publicBase,
            `/blogs/${encodeURIComponent(resolvedBlogHandle)}/${encodeURIComponent(resolvedArticleHandle)}`,
          );
          remotePublishedUrl = await validatePublishedUrl(this.http, this.provider, candidate);
        }
      }
    }

    return {
      remotePostId: article.id,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft,
    };
  }

  private async fetchShopAndBlogs(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
  ): Promise<{
    shopName?: string;
    primaryDomainUrl?: string;
    targets: ChannelRemoteTargetDto[];
  }> {
    const secretCandidates = collectSecretCandidates(secrets);
    const parsed = await this.graphqlRequest<ShopifyListBlogsResponse>(
      conn,
      secrets,
      secretCandidates,
      LIST_BLOGS_QUERY,
    );

    const shopName = parsed.data?.shop?.name?.trim() || undefined;
    const rawPrimaryDomain = parsed.data?.shop?.primaryDomain?.url?.trim() || '';
    let primaryDomainUrl: string | undefined;
    if (rawPrimaryDomain && isSafeDistributionHttpUrl(rawPrimaryDomain)) {
      try {
        await this.http.assertAllowedUrl(rawPrimaryDomain);
        primaryDomainUrl = trimTrailingSlashes(rawPrimaryDomain);
      } catch {
        primaryDomainUrl = undefined;
      }
    }

    const rawBlogs = parsed.data?.blogs;
    const nodes: ShopifyBlogNode[] = [];
    if (Array.isArray(rawBlogs?.nodes)) {
      nodes.push(...rawBlogs.nodes);
    } else if (Array.isArray(rawBlogs?.edges)) {
      for (const edge of rawBlogs.edges) {
        if (edge?.node) nodes.push(edge.node);
      }
    }

    const targets: ChannelRemoteTargetDto[] = [];
    for (const node of nodes) {
      const id = node.id?.trim();
      const name = node.title?.trim();
      if (!id || !name) continue;
      const handle = node.handle?.trim() || undefined;
      const url =
        primaryDomainUrl && handle
          ? `${primaryDomainUrl}/blogs/${encodeURIComponent(handle)}`
          : undefined;
      targets.push({
        id,
        name,
        handle,
        url,
        meta: {
          ...(shopName ? { shopName } : {}),
          ...(primaryDomainUrl ? { primaryDomainUrl } : {}),
        },
      });
    }

    return { shopName, primaryDomainUrl, targets };
  }

  private resolveAccessToken(conn: ConnectorConnectionContext, secrets: ConnectorSecrets): string {
    const token =
      conn.authType === 'OAUTH'
        ? secrets.oauthAccessToken?.trim() || secrets.accessToken?.trim() || ''
        : secrets.accessToken?.trim() || '';
    if (!token) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '缺少 Shopify Admin API Access Token',
      );
    }
    return token;
  }

  private resolveGraphQlEndpoint(conn: ConnectorConnectionContext): string {
    const rawVersion = conn.configJson.apiVersion;
    const apiVersion =
      typeof rawVersion === 'string' && API_VERSION_PATTERN.test(rawVersion.trim())
        ? rawVersion.trim()
        : DEFAULT_SHOPIFY_API_VERSION;
    return joinBasePath(conn.siteBaseUrl, `/admin/api/${apiVersion}/graphql.json`);
  }

  private async graphqlRequest<T extends { errors?: ShopifyGraphQlError[] }>(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    secretCandidates: readonly string[],
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const token = this.resolveAccessToken(conn, secrets);
    const endpoint = this.resolveGraphQlEndpoint(conn);

    let response;
    try {
      response = await this.http.request({
        url: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<T>(response.body);
    if (!parsed || typeof parsed !== 'object') {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        'Shopify GraphQL 返回格式异常，无法解析响应',
        response.status,
      );
    }

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw this.mapGraphQlErrors(parsed.errors, secretCandidates);
    }

    return parsed;
  }

  private mapGraphQlErrors(
    errors: readonly ShopifyGraphQlError[],
    secretCandidates: readonly string[],
  ): ConnectorError {
    const codes = errors.map((err) => err.extensions?.code?.toUpperCase() ?? '').filter(Boolean);
    const joinedMessages = errors
      .map((err) => err.message?.trim() ?? '')
      .filter(Boolean)
      .join('；');

    if (codes.includes('THROTTLED') || /throttled/i.test(joinedMessages)) {
      return new ConnectorError(
        this.provider,
        'RATE_LIMITED',
        'Shopify GraphQL 接口触发限流，请稍后重试',
      );
    }
    if (codes.includes('UNAUTHORIZED') || /unauthorized|invalid api key/i.test(joinedMessages)) {
      return new ConnectorError(
        this.provider,
        'AUTH_FAILED',
        'Shopify 认证失败，请检查 Access Token 是否有效',
      );
    }
    if (codes.includes('ACCESS_DENIED') || /access denied|forbidden/i.test(joinedMessages)) {
      return new ConnectorError(
        this.provider,
        'FORBIDDEN',
        'Shopify 权限不足，请确认应用具备 read_content / write_content 权限',
      );
    }

    const safeDetail = redactSecrets(joinedMessages, secretCandidates, 220);
    return new ConnectorError(
      this.provider,
      'UPSTREAM_ERROR',
      safeDetail ? `Shopify GraphQL 执行失败：${safeDetail}` : 'Shopify GraphQL 执行失败',
    );
  }
}
