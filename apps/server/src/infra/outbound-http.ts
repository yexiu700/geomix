import { Inject, Injectable, Optional } from '@nestjs/common';
import { resolveFetchSettings } from '@geomix/shared';
import {
  requestOnce,
  resolvePinned,
  type DnsResolver,
  type HttpTransport,
} from './guarded-request';
import { PROVIDER_KIND, ProviderError } from './provider-error';
import {
  assertPublicUrl,
  isHostAllowlisted,
  parseSsrfAllowlist,
  UrlPolicyError,
  type SsrfAllowlist,
} from './ssrf';

/**
 * 仅允许公网地址的空 SSRF 白名单（不包含默认 `sonargate`，也不继承 `process.env.SSRF_ALLOWLIST`）。
 * 所有面向商户站点的外发请求（L1 CMS 连接器、IndexNow、T+1 爬虫体检、PR 回传 URL 校验）默认使用此策略。
 */
export const PUBLIC_ONLY_ALLOWLIST: SsrfAllowlist = parseSsrfAllowlist('', {
  includeDefaults: false,
});

export const OUTBOUND_HTTP_DEPS = Symbol('OUTBOUND_HTTP_DEPS');

export type OutboundHttpMethod = 'GET' | 'POST' | 'PUT';

export type OutboundHttpRequest = {
  url: string | URL;
  method: OutboundHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  rawBody?: Buffer | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  allowlistOverride?: SsrfAllowlist | string;
};

export type OutboundHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
  finalUrl: string;
};

export type OutboundHttpDeps = {
  resolver?: DnsResolver;
  transport?: HttpTransport;
  defaultTimeoutMs?: number;
  defaultMaxBytes?: number;
  defaultMaxRedirects?: number;
  defaultAllowlist?: SsrfAllowlist | string;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  'authorization',
  'x-shopify-access-token',
  'x-geomix-signature',
  'x-api-key',
  'api-key',
]);

/**
 * 规范化外发白名单：字符串输入始终以 `includeDefaults: false` 解析，绝不隐式继承 `sonargate` 或环境变量。
 */
export function normalizeOutboundAllowlist(allowlist?: SsrfAllowlist | string): SsrfAllowlist {
  if (!allowlist) return PUBLIC_ONLY_ALLOWLIST;
  if (typeof allowlist === 'string') {
    return parseSsrfAllowlist(allowlist, { includeDefaults: false });
  }
  return allowlist;
}

/**
 * 同步 URL 合法性与公网策略校验（将 UrlPolicyError 统一映射为 ProviderError(SSRF)）。
 */
export function assertSafeOutboundUrl(
  raw: string | URL,
  allowlist: SsrfAllowlist | string = PUBLIC_ONLY_ALLOWLIST,
): URL {
  const parsedAllowlist = normalizeOutboundAllowlist(allowlist);
  let parsed: URL;
  try {
    parsed = assertPublicUrl(raw, { allowlist: parsedAllowlist });
  } catch (error) {
    if (error instanceof UrlPolicyError) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', error.reason);
    }
    throw error;
  }

  const effectivePort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const host = parsed.hostname.replace(/\.+$/, '');
  if (
    !host.includes('.') &&
    !host.includes(':') &&
    !isHostAllowlisted(parsed.hostname, effectivePort, parsedAllowlist)
  ) {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'internal_hostname');
  }

  return parsed;
}

function createLazyDnsResolver(): DnsResolver {
  return {
    async resolve(hostname: string) {
      const { createDnsResolver } = await import('./guarded-request');
      return createDnsResolver().resolve(hostname);
    },
  };
}

function createLazyUndiciTransport(): HttpTransport {
  return async (request) => {
    const { createUndiciTransport } = await import('./undici-transport');
    return createUndiciTransport()(request);
  };
}

function readLocationHeader(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'location') return value;
  }
  return undefined;
}

function stripHeaders(
  headers: Record<string, string>,
  namesLower: ReadonlySet<string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (namesLower.has(key.toLowerCase())) continue;
    next[key] = value;
  }
  return next;
}

/**
 * 统一 SSRF 硬化外发 HTTP 客户端：
 * - 默认使用 `PUBLIC_ONLY_ALLOWLIST`（`includeDefaults: false`），屏蔽内网 IP、元数据地址及 `sonargate`
 * - 逐跳校验重定向目标（在检查 `maxRedirects` 之前先验 SSRF），跨源重定向自动剥离认证凭据头
 * - 4xx / 5xx 返回实际状态码与响应体，不抛异常，供 CMS 连接器与爬虫体检显式处理
 * - 支持通过 `OUTBOUND_HTTP_DEPS` 或构造参数注入自定义 resolver / transport / allowlist 以便单测与 E2E
 */
@Injectable()
export class OutboundHttpClient {
  private readonly resolver: DnsResolver;
  private readonly transport: HttpTransport;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxBytes: number;
  private readonly defaultMaxRedirects: number;
  private readonly defaultAllowlist: SsrfAllowlist;

  constructor(@Optional() @Inject(OUTBOUND_HTTP_DEPS) deps?: OutboundHttpDeps) {
    const settings = resolveFetchSettings(process.env);
    this.resolver = deps?.resolver ?? createLazyDnsResolver();
    this.transport = deps?.transport ?? createLazyUndiciTransport();
    this.defaultTimeoutMs = deps?.defaultTimeoutMs ?? settings.timeoutMs;
    this.defaultMaxBytes = deps?.defaultMaxBytes ?? settings.maxBytes;
    this.defaultMaxRedirects = deps?.defaultMaxRedirects ?? settings.maxRedirects;
    this.defaultAllowlist = normalizeOutboundAllowlist(deps?.defaultAllowlist);
  }

  /**
   * 校验目标 URL 是否符合 SSRF 公网白名单策略，并对域名执行 DNS 解析校验，
   * 拦截私网 IP、回环地址、保留主机名以及解析到内网 IP 的域名。
   */
  async assertAllowedUrl(
    url: string | URL,
    opts?: { allowlistOverride?: SsrfAllowlist | string },
  ): Promise<URL> {
    const allowlist =
      opts?.allowlistOverride !== undefined
        ? normalizeOutboundAllowlist(opts.allowlistOverride)
        : this.defaultAllowlist;
    const parsed = assertSafeOutboundUrl(url, allowlist);
    await resolvePinned(parsed, this.resolver, { allowlist });
    return parsed;
  }

  async request(opts: OutboundHttpRequest): Promise<OutboundHttpResponse> {
    const allowlist =
      opts.allowlistOverride !== undefined
        ? normalizeOutboundAllowlist(opts.allowlistOverride)
        : this.defaultAllowlist;
    let current = assertSafeOutboundUrl(opts.url, allowlist);
    let currentMethod: OutboundHttpMethod = opts.method;
    let currentHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
    let currentBody = opts.body;
    let currentRawBody = opts.rawBody;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = opts.maxBytes ?? this.defaultMaxBytes;
    const maxRedirects = opts.maxRedirects ?? this.defaultMaxRedirects;
    const seen = new Set<string>();

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const currentHref = current.toString();
      if (seen.has(currentHref)) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_loop');
      }
      seen.add(currentHref);

      const response = await requestOnce({
        url: current,
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        rawBody: currentRawBody,
        timeoutMs,
        maxBytes,
        signal: opts.signal,
        resolver: this.resolver,
        transport: this.transport,
        allowlist,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = readLocationHeader(response.headers)?.trim();
        if (!location || location.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(location)) {
          throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_location');
        }
        let resolved: URL;
        try {
          resolved = new URL(location, current);
        } catch {
          throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_location');
        }

        // 先做 SSRF 校验再判断是否超过最大重定向次数，避免 maxRedirects=0 掩盖私网重定向拦截
        const next = assertSafeOutboundUrl(resolved, allowlist);
        if (hop === maxRedirects) {
          throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
        }

        if (next.origin !== current.origin) {
          if (currentMethod === 'PUT' && (response.status === 307 || response.status === 308)) {
            throw new ProviderError(
              PROVIDER_KIND.SSRF,
              '目标地址不允许访问',
              'cross_origin_put_redirect',
            );
          }
          currentHeaders = stripHeaders(currentHeaders, CROSS_ORIGIN_STRIPPED_HEADERS);
        }

        if (
          (response.status === 301 || response.status === 302 || response.status === 303) &&
          (currentMethod === 'POST' || currentMethod === 'PUT')
        ) {
          currentMethod = 'GET';
          currentBody = undefined;
          currentRawBody = undefined;
          currentHeaders = stripHeaders(
            currentHeaders,
            new Set(['content-type', 'content-length']),
          );
        }

        current = next;
        continue;
      }

      return {
        status: response.status,
        headers: response.headers,
        body: response.body.toString('utf8'),
        rawBody: response.body,
        finalUrl: currentHref,
      };
    }

    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
  }
}
