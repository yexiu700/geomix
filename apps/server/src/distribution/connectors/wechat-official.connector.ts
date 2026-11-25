import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import IORedis from 'ioredis';
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
  redactSecrets,
  trimTrailingSlashes,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

export const WECHAT_API_BASE_URL_TOKEN = Symbol('WECHAT_API_BASE_URL');
export const WECHAT_TOKEN_CACHE = Symbol('WECHAT_TOKEN_CACHE');
export const DEFAULT_WECHAT_API_BASE_URL = 'https://api.weixin.qq.com';

const WECHAT_MAX_TITLE_LEN = 64;
const WECHAT_MAX_AUTHOR_LEN = 16;
const WECHAT_MAX_DIGEST_LEN = 120;
const WECHAT_MAX_CONTENT_CHARS = 20_000;
const WECHAT_MAX_CONTENT_BYTES = 1_000_000;
const WECHAT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const WECHAT_MAX_INLINE_IMAGES = 20;
const WECHAT_CDN_HOSTS = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn']);
const WECHAT_TOKEN_EXPIRED_CODES = new Set([40001, 42001]);

/**
 * 1×1 像素合法 PNG 最小占位封面（仅当未配置 defaultCoverMediaId 且正文无图片时用于草稿封面占位）。
 */
const MINIMAL_PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=',
  'base64',
);

export interface WeChatTokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, token: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  close?(): Promise<void>;
}

type MemoryTokenEntry = {
  token: string;
  expiresAt: number;
};

class DefaultWeChatTokenCache implements WeChatTokenCache {
  private readonly mem = new Map<string, MemoryTokenEntry>();
  private redis: IORedis | null = null;

  private getRedis(): IORedis | null {
    if (process.env.NODE_ENV === 'test') return null;
    const url = process.env.REDIS_URL?.trim();
    if (!url) return null;
    if (!this.redis) {
      const client = new IORedis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: 2_000,
      });
      client.on('error', () => {
        // 静默降级至进程内缓存
      });
      this.redis = client;
    }
    return this.redis;
  }

  async get(key: string): Promise<string | null> {
    const now = Date.now();
    const local = this.mem.get(key);
    if (local) {
      if (local.expiresAt > now) {
        return local.token;
      }
      this.mem.delete(key);
    }

    const client = this.getRedis();
    if (!client) return null;
    try {
      const val = await client.get(key);
      if (val) {
        this.mem.set(key, { token: val, expiresAt: now + 60_000 });
        return val;
      }
    } catch {
      // Redis 不可用时降级至内存缓存
    }
    return null;
  }

  async set(key: string, token: string, ttlMs: number): Promise<void> {
    const safeTtl = Math.max(1_000, Math.round(ttlMs));
    this.mem.set(key, { token, expiresAt: Date.now() + safeTtl });
    const client = this.getRedis();
    if (!client) return;
    try {
      await client.set(key, token, 'PX', safeTtl);
    } catch {
      // Redis 不可用时保留内存缓存
    }
  }

  async del(key: string): Promise<void> {
    this.mem.delete(key);
    const client = this.getRedis();
    if (!client) return;
    try {
      await client.del(key);
    } catch {
      // Ignore Redis delete failure
    }
  }

  async close(): Promise<void> {
    const client = this.redis;
    this.redis = null;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

type WeChatErrorPayload = {
  errcode?: number;
  errmsg?: string;
};

type WeChatStableTokenResponse = WeChatErrorPayload & {
  access_token?: string;
  expires_in?: number;
};

type WeChatDraftCountResponse = WeChatErrorPayload & {
  total_count?: number;
};

type WeChatUploadImgResponse = WeChatErrorPayload & {
  url?: string;
};

type WeChatAddMaterialResponse = WeChatErrorPayload & {
  media_id?: string;
  url?: string;
};

type WeChatDraftAddResponse = WeChatErrorPayload & {
  media_id?: string;
};

/**
 * 构造纯 `Buffer` 级别的 `multipart/form-data` 请求体，确保任意二进制图片字节（非 UTF-8 字节）零损坏透传。
 */
export function buildMultipartFormData(
  fieldName: string,
  filename: string,
  contentType: string,
  data: Buffer,
): { contentType: string; body: Buffer } {
  const boundary = `----GeoMixFormBoundary${randomBytes(12).toString('hex')}`;
  const safeField = fieldName.replace(/[\r\n"]/g, '');
  const safeFilename = filename.replace(/[\r\n"]/g, '');
  const safeContentType = contentType.replace(/[\r\n]/g, '') || 'application/octet-stream';

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${safeField}"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeContentType}\r\n\r\n`,
    'utf8',
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([preamble, data, closing]),
  };
}

/**
 * 统一映射微信公众号业务错误码（HTTP 200 下返回非零 `errcode`），对 `40164` 输出可操作的 IP 白名单引导。
 */
export function mapWeChatError(
  errcode: number,
  errmsg: string | undefined,
  secretCandidates: readonly string[],
): ConnectorError {
  const rawMsg = errmsg?.trim() ?? '';
  if (errcode === 40164) {
    const ipMatch = /invalid ip\s+([0-9a-fA-F.:]+)/i.exec(rawMsg);
    const ipHint = ipMatch?.[1] ? `（出口 IP：${ipMatch[1]}）` : '';
    return new ConnectorError(
      'WECHAT_OFFICIAL',
      'FORBIDDEN',
      `微信公众号接口返回 IP 白名单拦截（错误码 40164）${ipHint}：请将服务器出口 IP 加入微信公众平台「设置与开发 → 基本配置 → IP 白名单」后重试`,
      403,
    );
  }
  if (
    errcode === 40001 ||
    errcode === 40013 ||
    errcode === 40125 ||
    errcode === 41001 ||
    errcode === 42001
  ) {
    return new ConnectorError(
      'WECHAT_OFFICIAL',
      'AUTH_FAILED',
      `微信公众号认证失败（错误码 ${errcode}），请检查 AppID 与 AppSecret`,
      401,
    );
  }
  if (errcode === 48001 || errcode === 48004) {
    return new ConnectorError(
      'WECHAT_OFFICIAL',
      'FORBIDDEN',
      `微信公众号接口权限不足（错误码 ${errcode}），请确认账号已开通草稿箱与素材接口权限`,
      403,
    );
  }
  if (errcode === 45009 || errcode === 45011) {
    return new ConnectorError(
      'WECHAT_OFFICIAL',
      'RATE_LIMITED',
      `微信公众号接口触发频率或配额限制（错误码 ${errcode}），请稍后重试`,
      429,
    );
  }
  if (
    errcode === 40007 ||
    errcode === 40009 ||
    errcode === 45003 ||
    errcode === 45004 ||
    errcode === 45005 ||
    errcode === 45007
  ) {
    const safeDetail = redactSecrets(rawMsg, secretCandidates, 220);
    return new ConnectorError(
      'WECHAT_OFFICIAL',
      'VALIDATION_ERROR',
      safeDetail
        ? `微信公众号参数校验失败（错误码 ${errcode}）：${safeDetail}`
        : `微信公众号参数校验失败（错误码 ${errcode}）`,
      422,
    );
  }

  const safeDetail = redactSecrets(rawMsg, secretCandidates, 220);
  return new ConnectorError(
    'WECHAT_OFFICIAL',
    'UPSTREAM_ERROR',
    safeDetail
      ? `微信公众号接口异常（错误码 ${errcode}）：${safeDetail}`
      : `微信公众号接口异常（错误码 ${errcode}）`,
  );
}

function guessImageMeta(
  url: string,
  responseContentType?: string,
): { filename: string; contentType: string } {
  const ct = (responseContentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (ct === 'image/jpeg' || ct === 'image/jpg') {
    return { filename: 'image.jpg', contentType: 'image/jpeg' };
  }
  if (ct === 'image/gif') {
    return { filename: 'image.gif', contentType: 'image/gif' };
  }
  if (ct === 'image/webp') {
    return { filename: 'image.webp', contentType: 'image/webp' };
  }
  if (ct === 'image/png') {
    return { filename: 'image.png', contentType: 'image/png' };
  }
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) {
    return { filename: 'image.jpg', contentType: 'image/jpeg' };
  }
  if (lowerUrl.endsWith('.gif')) {
    return { filename: 'image.gif', contentType: 'image/gif' };
  }
  return { filename: 'image.png', contentType: 'image/png' };
}

function extractInlineImageUrls(html: string): string[] {
  const re = /<img\b[^>]*?(?<![-\w])src\s*=\s*(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)')/gi;
  const seen = new Set<string>();
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const url = (match[1] ?? match[2] ?? '').trim();
    if (!url || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (WECHAT_CDN_HOSTS.has(parsed.hostname.toLowerCase())) {
        continue;
      }
    } catch {
      continue;
    }
    seen.add(url);
    urls.push(url);
    if (urls.length >= WECHAT_MAX_INLINE_IMAGES) break;
  }
  return urls;
}

function rewriteInlineImageUrls(html: string, uploadedMap: ReadonlyMap<string, string>): string {
  if (uploadedMap.size === 0) return html;
  return html.replace(
    /(<img\b[^>]*?(?<![-\w])src\s*=\s*)(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)')/gi,
    (fullMatch, prefix: string, doubleQuoted?: string, singleQuoted?: string) => {
      const quote = doubleQuoted !== undefined ? '"' : "'";
      const rawUrl = doubleQuoted ?? singleQuoted ?? '';
      const replacement = uploadedMap.get(rawUrl.trim());
      if (!replacement) {
        return fullMatch;
      }
      return `${prefix}${quote}${replacement}${quote}`;
    },
  );
}

/**
 * 微信公众号官方 L1 连接器（严格仅写入草稿箱模式）：
 * - 仅调用 `stable_token`、`material/add_material`、`media/uploadimg`、`draft/add`（及测试连接可选 `draft/count`）
 * - 严禁调用任何自动发布或群发接口；`publish()` 始终返回 `publishedAsDraft: true` 且 `remotePublishedUrl: undefined`
 * - 所有外发请求与正文/封面图片下载均经 `OutboundHttpClient` 执行严格 SSRF 校验
 */
@Injectable()
export class WechatOfficialConnector implements CmsConnector, OnModuleDestroy {
  readonly provider = 'WECHAT_OFFICIAL' as const;
  private readonly tokenCache: WeChatTokenCache;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(WECHAT_API_BASE_URL_TOKEN) private readonly apiBaseOverride?: string,
    @Optional() @Inject(WECHAT_TOKEN_CACHE) tokenCacheOverride?: WeChatTokenCache,
  ) {
    this.tokenCache = tokenCacheOverride ?? new DefaultWeChatTokenCache();
  }

  async onModuleDestroy(): Promise<void> {
    await this.tokenCache.close?.();
  }

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const creds = this.resolveCredentials(secrets);
    const baseCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, baseCandidates);

    const apiBase = this.resolveApiBaseUrl(conn);
    const cacheKey = this.buildTokenCacheKey(conn.id, creds.appId, creds.appSecret, apiBase);

    let totalCount: number | undefined;
    await this.withFreshTokenRetry(
      cacheKey,
      creds,
      apiBase,
      baseCandidates,
      async (accessToken, secretCandidates) => {
        const countUrl = joinBasePath(apiBase, '/cgi-bin/draft/count', {
          access_token: accessToken,
        });
        let response;
        try {
          response = await this.http.request({
            url: countUrl,
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
        } catch (error) {
          throw mapTransportError(this.provider, error, secretCandidates);
        }

        // 部分极简 mock 仅实现 stable_token 与 draft/add，404 时平滑降级
        if (response.status === 404) {
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
        }
        const parsed = parseJsonSafe<WeChatDraftCountResponse>(response.body);
        if (parsed && typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
          throw mapWeChatError(parsed.errcode, parsed.errmsg, secretCandidates);
        }
        if (parsed && typeof parsed.total_count === 'number') {
          totalCount = parsed.total_count;
        }
      },
    );

    const target: ChannelRemoteTargetDto = {
      id: 'wechat_draft_box',
      name: `${conn.displayName}（草稿箱）`,
      meta: {
        draftOnly: true,
        ...(typeof totalCount === 'number' ? { draftCount: totalCount } : {}),
      },
    };

    return {
      ok: true,
      message: '微信公众号草稿箱连接正常（仅写入草稿箱，不会自动发布或群发）',
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
    const creds = this.resolveCredentials(secrets);
    const baseCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, baseCandidates);

    const validated = this.validateDraftFields(conn, payload);
    const apiBase = this.resolveApiBaseUrl(conn);
    const cacheKey = this.buildTokenCacheKey(conn.id, creds.appId, creds.appSecret, apiBase);

    const mediaId = await this.withFreshTokenRetry(
      cacheKey,
      creds,
      apiBase,
      baseCandidates,
      async (accessToken, secretCandidates) => {
        // 1. 正文外链图片转存并改写为微信 CDN URL（每张均走 SSRF 保护，按 <img src> 属性精确替换避免前缀冲突）
        const inlineUrls = extractInlineImageUrls(validated.content);
        const uploadedMap = new Map<string, string>();
        for (const imgUrl of inlineUrls) {
          const downloaded = await this.downloadImage(imgUrl, secretCandidates);
          const meta = guessImageMeta(imgUrl, downloaded.contentType);
          const uploadedUrl = await this.uploadInlineImage(
            apiBase,
            accessToken,
            downloaded.buffer,
            meta.filename,
            meta.contentType,
            secretCandidates,
          );
          uploadedMap.set(imgUrl, uploadedUrl);
        }
        const rewrittenHtml = rewriteInlineImageUrls(validated.content, uploadedMap);

        // 2. 封面素材 thumb_media_id（优先显式 media_id，其次下载上传封面/首图，最后使用最小 PNG 占位）
        const thumbMediaId = await this.resolveCoverMediaId(
          conn,
          payload,
          inlineUrls[0],
          apiBase,
          accessToken,
          secretCandidates,
        );

        // 3. 严格仅写入草稿箱：POST /cgi-bin/draft/add
        const article: Record<string, unknown> = {
          title: validated.title,
          author: validated.author,
          digest: validated.digest,
          content: rewrittenHtml,
          thumb_media_id: thumbMediaId,
          need_open_comment: conn.configJson.needOpenComment ? 1 : 0,
          only_fans_can_comment: 0,
          ...(validated.contentSourceUrl ? { content_source_url: validated.contentSourceUrl } : {}),
        };

        const draftUrl = joinBasePath(apiBase, '/cgi-bin/draft/add', {
          access_token: accessToken,
        });
        const draftRes = await this.requestWeChatJson<WeChatDraftAddResponse>(
          draftUrl,
          'POST',
          { 'Content-Type': 'application/json', Accept: 'application/json' },
          { body: JSON.stringify({ articles: [article] }) },
          secretCandidates,
        );

        const createdMediaId = draftRes?.media_id?.trim() ?? '';
        if (!createdMediaId) {
          throw new ConnectorError(
            this.provider,
            'UPSTREAM_ERROR',
            '微信公众号未返回草稿 media_id',
          );
        }
        return createdMediaId;
      },
    );

    return {
      remotePostId: mediaId,
      remoteAdminUrl: 'https://mp.weixin.qq.com/',
      remotePublishedUrl: undefined,
      publishedAsDraft: true,
    };
  }

  private resolveCredentials(secrets: ConnectorSecrets): { appId: string; appSecret: string } {
    const appId = secrets.appId?.trim() ?? '';
    const appSecret = secrets.appSecret?.trim() ?? '';
    if (!appId || !appSecret) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', '缺少微信公众号 AppID 或 AppSecret');
    }
    return { appId, appSecret };
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

  /**
   * 微信 API 基址解析优先级：
   * `conn.configJson.apiBaseUrl` → DI 覆盖 → `process.env.WECHAT_API_BASE_URL` → 测试/mock `siteBaseUrl` → `https://api.weixin.qq.com`
   */
  private resolveApiBaseUrl(conn: ConnectorConnectionContext): string {
    const configApiBase = (conn.configJson as Record<string, unknown>).apiBaseUrl;
    if (typeof configApiBase === 'string' && configApiBase.trim()) {
      return trimTrailingSlashes(configApiBase);
    }
    if (this.apiBaseOverride?.trim()) {
      return trimTrailingSlashes(this.apiBaseOverride);
    }
    const envBase = process.env.WECHAT_API_BASE_URL?.trim();
    if (envBase && /^https?:\/\//i.test(envBase)) {
      return trimTrailingSlashes(envBase);
    }
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const bareHost = host.replace(/^\[|\]$/g, '');
      if (
        host === 'api.weixin.qq.com' ||
        host.endsWith('.e2e.example') ||
        isIP(bareHost) !== 0 ||
        parsed.pathname.startsWith('/wechat')
      ) {
        return trimTrailingSlashes(conn.siteBaseUrl);
      }
    } catch {
      // Fallback to official WeChat API endpoint
    }
    return DEFAULT_WECHAT_API_BASE_URL;
  }

  private buildTokenCacheKey(
    connectionId: string,
    appId: string,
    appSecret: string,
    apiBase: string,
  ): string {
    const fingerprint = createHash('sha256')
      .update(`${appId}:${appSecret}:${apiBase}`)
      .digest('hex')
      .slice(0, 16);
    return `geomix:wechat:stable_token:v1:${connectionId}:${fingerprint}`;
  }

  private async getAccessToken(
    cacheKey: string,
    creds: { appId: string; appSecret: string },
    apiBase: string,
    secretCandidates: readonly string[],
    forceRefresh = false,
  ): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.tokenCache.get(cacheKey);
      if (cached) return cached;
    }

    const tokenUrl = joinBasePath(apiBase, '/cgi-bin/stable_token');
    const data = await this.requestWeChatJson<WeChatStableTokenResponse>(
      tokenUrl,
      'POST',
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      {
        body: JSON.stringify({
          grant_type: 'client_credential',
          appid: creds.appId,
          secret: creds.appSecret,
          force_refresh: forceRefresh,
        }),
      },
      secretCandidates,
    );

    const token = data?.access_token?.trim() ?? '';
    if (!token) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        '微信公众号 stable_token 响应缺少 access_token',
      );
    }

    const expiresInSec =
      typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 7200;
    const ttlMs = Math.max(60_000, (expiresInSec - 300) * 1000);
    await this.tokenCache.set(cacheKey, token, ttlMs);
    return token;
  }

  private async withFreshTokenRetry<T>(
    cacheKey: string,
    creds: { appId: string; appSecret: string },
    apiBase: string,
    baseCandidates: readonly string[],
    operation: (accessToken: string, secretCandidates: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const token = await this.getAccessToken(cacheKey, creds, apiBase, baseCandidates, false);
    const candidatesWithToken = [token, ...baseCandidates];
    try {
      return await operation(token, candidatesWithToken);
    } catch (error) {
      if (error instanceof ConnectorError && this.isExpiredTokenError(error)) {
        await this.tokenCache.del(cacheKey);
        const freshToken = await this.getAccessToken(
          cacheKey,
          creds,
          apiBase,
          baseCandidates,
          true,
        );
        return operation(freshToken, [freshToken, token, ...baseCandidates]);
      }
      throw error;
    }
  }

  private isExpiredTokenError(error: ConnectorError): boolean {
    if (error.code !== 'AUTH_FAILED') return false;
    for (const code of WECHAT_TOKEN_EXPIRED_CODES) {
      if (error.message.includes(String(code))) {
        return true;
      }
    }
    return false;
  }

  private validateDraftFields(
    conn: ConnectorConnectionContext,
    payload: ConnectorPublishPayload,
  ): {
    title: string;
    author: string;
    digest: string;
    content: string;
    contentSourceUrl?: string;
  } {
    const title = payload.title?.trim() ?? '';
    if (!title) {
      throw new ConnectorError(this.provider, 'VALIDATION_ERROR', '公众号草稿标题不能为空', 422);
    }
    if (title.length > WECHAT_MAX_TITLE_LEN) {
      throw new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        `公众号草稿标题不能超过 ${WECHAT_MAX_TITLE_LEN} 个字符（当前 ${title.length} 字符）`,
        422,
      );
    }

    const explicitAuthor =
      (typeof payload.extras?.author === 'string' ? payload.extras.author.trim() : '') ||
      conn.configJson.author?.trim() ||
      '';
    if (explicitAuthor && explicitAuthor.length > WECHAT_MAX_AUTHOR_LEN) {
      throw new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        `公众号草稿作者名不能超过 ${WECHAT_MAX_AUTHOR_LEN} 个字符（当前 ${explicitAuthor.length} 字符）`,
        422,
      );
    }
    const author = explicitAuthor || conn.displayName.trim().slice(0, WECHAT_MAX_AUTHOR_LEN);

    const explicitDigest =
      typeof payload.extras?.digest === 'string' ? payload.extras.digest.trim() : '';
    if (explicitDigest && explicitDigest.length > WECHAT_MAX_DIGEST_LEN) {
      throw new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        `公众号草稿摘要不能超过 ${WECHAT_MAX_DIGEST_LEN} 个字符（当前 ${explicitDigest.length} 字符）`,
        422,
      );
    }
    const digest =
      explicitDigest || (payload.metaDesc?.trim() ?? '').slice(0, WECHAT_MAX_DIGEST_LEN);

    const content = payload.html?.trim() || payload.markdown?.trim() || '';
    if (!content) {
      throw new ConnectorError(this.provider, 'VALIDATION_ERROR', '公众号草稿正文不能为空', 422);
    }
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (content.length > WECHAT_MAX_CONTENT_CHARS || contentBytes >= WECHAT_MAX_CONTENT_BYTES) {
      throw new ConnectorError(
        this.provider,
        'VALIDATION_ERROR',
        '公众号草稿正文超过微信接口长度上限（最多 20,000 字符且小于 1MB）',
        422,
      );
    }

    const canonicalCandidates = [
      payload.canonicalUrl,
      typeof payload.extras?.contentSourceUrl === 'string'
        ? payload.extras.contentSourceUrl
        : undefined,
      typeof payload.extras?.canonicalUrl === 'string' ? payload.extras.canonicalUrl : undefined,
    ];
    let contentSourceUrl: string | undefined;
    for (const candidate of canonicalCandidates) {
      if (typeof candidate === 'string' && isSafeDistributionHttpUrl(candidate.trim())) {
        contentSourceUrl = candidate.trim();
        break;
      }
    }

    return { title, author, digest, content, contentSourceUrl };
  }

  private async downloadImage(
    imgUrl: string,
    secretCandidates: readonly string[],
  ): Promise<{ buffer: Buffer; contentType?: string }> {
    let response;
    try {
      response = await this.http.request({
        url: imgUrl,
        method: 'GET',
        maxBytes: WECHAT_MAX_IMAGE_BYTES,
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300 || response.rawBody.length === 0) {
      throw new ConnectorError(
        this.provider,
        'UPSTREAM_ERROR',
        `无法下载公众号配图资源（HTTP ${response.status}）`,
        response.status,
      );
    }

    let contentType: string | undefined;
    for (const [key, val] of Object.entries(response.headers)) {
      if (key.toLowerCase() === 'content-type') {
        contentType = val;
        break;
      }
    }

    return { buffer: response.rawBody, contentType };
  }

  private async uploadInlineImage(
    apiBase: string,
    accessToken: string,
    imageBuffer: Buffer,
    filename: string,
    contentType: string,
    secretCandidates: readonly string[],
  ): Promise<string> {
    const form = buildMultipartFormData('media', filename, contentType, imageBuffer);
    const uploadUrl = joinBasePath(apiBase, '/cgi-bin/media/uploadimg', {
      access_token: accessToken,
    });
    const res = await this.requestWeChatJson<WeChatUploadImgResponse>(
      uploadUrl,
      'POST',
      { 'Content-Type': form.contentType, Accept: 'application/json' },
      { rawBody: form.body },
      secretCandidates,
    );
    const url = res?.url?.trim() ?? '';
    if (!url) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', '微信图文图片上传未返回可用 URL');
    }
    return url;
  }

  private async resolveCoverMediaId(
    conn: ConnectorConnectionContext,
    payload: ConnectorPublishPayload,
    firstInlineImgUrl: string | undefined,
    apiBase: string,
    accessToken: string,
    secretCandidates: readonly string[],
  ): Promise<string> {
    const explicitMediaId =
      (typeof payload.extras?.thumbMediaId === 'string'
        ? payload.extras.thumbMediaId.trim()
        : '') ||
      conn.configJson.defaultCoverMediaId?.trim() ||
      '';
    if (explicitMediaId) {
      return explicitMediaId;
    }

    const coverUrl =
      (typeof payload.extras?.coverImageUrl === 'string'
        ? payload.extras.coverImageUrl.trim()
        : '') || firstInlineImgUrl;

    let coverBuffer: Buffer = MINIMAL_PLACEHOLDER_PNG;
    let filename = 'cover.png';
    let contentType = 'image/png';

    if (coverUrl) {
      const downloaded = await this.downloadImage(coverUrl, secretCandidates);
      const meta = guessImageMeta(coverUrl, downloaded.contentType);
      coverBuffer = downloaded.buffer;
      filename = meta.filename;
      contentType = meta.contentType;
    }

    const form = buildMultipartFormData('media', filename, contentType, coverBuffer);
    const materialUrl = joinBasePath(apiBase, '/cgi-bin/material/add_material', {
      access_token: accessToken,
      type: 'image',
    });
    const res = await this.requestWeChatJson<WeChatAddMaterialResponse>(
      materialUrl,
      'POST',
      { 'Content-Type': form.contentType, Accept: 'application/json' },
      { rawBody: form.body },
      secretCandidates,
    );
    const mediaId = res?.media_id?.trim() ?? '';
    if (!mediaId) {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', '微信封面素材上传未返回 media_id');
    }
    return mediaId;
  }

  private async requestWeChatJson<T extends WeChatErrorPayload>(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    payload: { body?: string; rawBody?: Buffer },
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method,
        headers,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.rawBody !== undefined ? { rawBody: payload.rawBody } : {}),
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
        '微信公众号接口返回了无效 JSON 响应',
      );
    }

    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      throw mapWeChatError(parsed.errcode, parsed.errmsg, secretCandidates);
    }

    return parsed;
  }
}
