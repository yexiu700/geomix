import { lookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FETCH_USER_AGENT } from '@geomix/shared';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import {
  assertPublicUrl,
  classifyHostname,
  ipBlockReason,
  isHostAllowlisted,
  isIpAllowlisted,
  resolveSsrfAllowlist,
  UrlPolicyError,
  type ResolvedAddress,
  type SsrfAllowlist,
} from './ssrf';

export type DnsResolver = {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
};

export type TransportRequest = {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  pinned: ResolvedAddress[];
  signal: AbortSignal;
  maxBytes: number;
  timeoutMs?: number;
};

export type TransportResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

export type GuardedResponse = TransportResponse & {
  url: URL;
  pinned: ResolvedAddress[];
};

const HOP_HEADERS = new Set(['cookie', 'cookie2', 'proxy-authorization']);

export function createDnsResolver(): DnsResolver {
  const resolver = new Resolver();
  return {
    async resolve(hostname: string): Promise<ResolvedAddress[]> {
      const [v4, v6] = await Promise.all([
        resolver.resolve4(hostname).then(
          (rows) => rows,
          (error: unknown) => emptyOrThrow(error),
        ),
        resolver.resolve6(hostname).then(
          (rows) => rows,
          (error: unknown) => emptyOrThrow(error),
        ),
      ]);
      const addresses: ResolvedAddress[] = [
        ...v4.map((address) => ({ address, family: 4 as const })),
        ...v6.map((address) => ({ address, family: 6 as const })),
      ];
      if (addresses.length === 0) {
        const systemRows = await lookup(hostname, { all: true }).catch(() => []);
        for (const row of systemRows) {
          if (row.family === 4 || row.family === 6) {
            addresses.push({ address: row.address, family: row.family });
          }
        }
      }
      if (addresses.length === 0)
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'dns_empty');
      return addresses;
    },
  };
}

export async function requestOnce(input: {
  url: string | URL;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  resolver: DnsResolver;
  transport: HttpTransport;
  allowlist?: SsrfAllowlist | string;
}): Promise<GuardedResponse> {
  let url: URL;
  try {
    url = assertPublicUrl(input.url, { allowlist: input.allowlist });
  } catch (error) {
    if (error instanceof UrlPolicyError) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', error.reason);
    }
    throw error;
  }
  const pinned = await resolvePinned(url, input.resolver, { allowlist: input.allowlist });
  if (input.signal?.aborted) {
    throw isTimeoutReason(input.signal.reason)
      ? new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout')
      : new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
  }
  const headers = publicHeaders(input.headers);
  const signal = combineSignal(input.signal, input.timeoutMs);
  let response: TransportResponse;
  try {
    response = await input.transport({
      url,
      method: input.method,
      headers,
      body: input.body,
      pinned,
      signal,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    throw normalizeTransportError(error, signal, input.signal);
  }
  if (response.body.length > input.maxBytes) {
    throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '响应超过大小限制', 'body');
  }
  return {
    status: response.status,
    headers: dropSensitiveHeaders(response.headers),
    body: response.body,
    url,
    pinned,
  };
}

export async function resolvePinned(
  url: URL,
  resolver: DnsResolver,
  options?: { allowlist?: SsrfAllowlist | string },
): Promise<ResolvedAddress[]> {
  const allowlist = resolveSsrfAllowlist(options?.allowlist);
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostAllowlisted = isHostAllowlisted(url.hostname, effectivePort, allowlist);
  const classified = classifyHostname(url.hostname, { allowlisted: hostAllowlisted });
  if (classified.kind === 'blocked') {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', classified.reason);
  }
  const addresses =
    classified.kind === 'ip' ? [classified.address] : await resolver.resolve(url.hostname);
  if (addresses.length === 0) {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'dns_empty');
  }
  for (const address of addresses) {
    if (!isValidAddressRecord(address)) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'invalid_ip');
    }
    if (!hostAllowlisted && !isIpAllowlisted(address.address, effectivePort, allowlist)) {
      const reason = ipBlockReason(address.address);
      if (reason) throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', reason);
    }
  }
  return addresses;
}

function isValidAddressRecord(address: ResolvedAddress): boolean {
  return (address.family === 4 || address.family === 6) && isIP(address.address) === address.family;
}

function publicHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    next[key] = value;
  }
  next['user-agent'] = FETCH_USER_AGENT;
  if (!Object.keys(next).some((key) => key.toLowerCase() === 'accept')) {
    next.accept = 'text/html';
  }
  return next;
}

function dropSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'set-cookie') continue;
    next[key] = value;
  }
  return next;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function normalizeTransportError(
  error: unknown,
  signal: AbortSignal,
  userSignal: AbortSignal | undefined,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (userSignal?.aborted && !isTimeoutReason(userSignal.reason)) {
    return new ProviderError(PROVIDER_KIND.CANCELLED, '请求已取消', 'cancelled');
  }
  if (signal.aborted || isTimeoutReason(signal.reason) || isTimeoutReason(userSignal?.reason)) {
    return new ProviderError(PROVIDER_KIND.TIMEOUT, '外部服务超时', 'timeout');
  }
  return new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'transport');
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'TimeoutError'
  );
}

function emptyOrThrow(error: unknown): string[] {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EFORMERR') return [];
  throw new ProviderError(PROVIDER_KIND.UPSTREAM, '外部服务暂时不可用', 'dns');
}
