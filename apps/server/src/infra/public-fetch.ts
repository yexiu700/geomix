import { FETCH_MAX_REDIRECTS } from '@geomix/shared';
import {
  requestOnce,
  type DnsResolver,
  type GuardedResponse,
  type HttpTransport,
} from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import { assertPublicUrl, parseSsrfAllowlist, UrlPolicyError } from './ssrf';

const PUBLIC_ONLY_ALLOWLIST = parseSsrfAllowlist('', { includeDefaults: false });
const LOGIN_MARKERS = ['请完成验证', '请登录后', '登录后查看', '访问验证'];

export type PublicPage = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
};

export type FetchDeps = {
  resolver: DnsResolver;
  transport: HttpTransport;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  robotsCacheMs: number;
  now?: () => number;
  signal?: AbortSignal;
};

type RobotRule = { allow: boolean; path: string };
type RobotGroup = { agents: string[]; rules: RobotRule[] };
type RobotCacheEntry = { expires: number; rules: RobotGroup[] | 'allow' | 'deny' };

const robotsCache = new Map<string, RobotCacheEntry>();

export function resetRobotsCache(): void {
  robotsCache.clear();
}

export async function fetchPublicPage(rawUrl: string, deps: FetchDeps): Promise<PublicPage> {
  const maxRedirects = deps.maxRedirects ?? FETCH_MAX_REDIRECTS;
  let current = openUrl(rawUrl);
  const seen = new Set<string>();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const key = current.toString();
    if (seen.has(key))
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_loop');
    seen.add(key);
    await assertRobots(current, deps);
    const response = await requestOnce({
      url: current,
      method: 'GET',
      headers: { accept: 'text/html' },
      timeoutMs: deps.timeoutMs,
      maxBytes: deps.maxBytes,
      signal: deps.signal,
      resolver: deps.resolver,
      transport: deps.transport,
      allowlist: PUBLIC_ONLY_ALLOWLIST,
    });
    if (isRedirect(response.status)) {
      if (hop === maxRedirects) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
      }
      current = nextUrl(current, header(response, 'location'));
      continue;
    }
    return readDocument(response);
  }
  throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
}

export async function fetchBinary(
  rawUrl: string,
  deps: FetchDeps & { allowTypes: string[]; maxBytes: number },
): Promise<{ url: string; contentType: string; body: Buffer }> {
  const maxRedirects = deps.maxRedirects ?? FETCH_MAX_REDIRECTS;
  let current = openUrl(rawUrl);
  const seen = new Set<string>();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const key = current.toString();
    if (seen.has(key))
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_loop');
    seen.add(key);
    const response = await requestOnce({
      url: current,
      method: 'GET',
      headers: { accept: deps.allowTypes.join(',') },
      timeoutMs: deps.timeoutMs,
      maxBytes: deps.maxBytes,
      signal: deps.signal,
      resolver: deps.resolver,
      transport: deps.transport,
      allowlist: PUBLIC_ONLY_ALLOWLIST,
    });
    if (isRedirect(response.status)) {
      if (hop === maxRedirects) {
        throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
      }
      current = nextUrl(current, header(response, 'location'));
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(
        PROVIDER_KIND.UPSTREAM,
        '外部服务暂时不可用',
        `status_${response.status}`,
      );
    }
    const contentType = mediaType(header(response, 'content-type'));
    if (!deps.allowTypes.includes(contentType)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '响应类型不受支持', 'content_type');
    }
    return { url: current.toString(), contentType, body: response.body };
  }
  throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
}

export function robotsAllow(body: string, path: string, agent = 'GeoMixBot'): boolean {
  const groups = parseRobots(body);
  const specific = groups.filter((group) =>
    group.agents.some((name) => name.toLowerCase() === agent.toLowerCase()),
  );
  const star = groups.filter((group) => group.agents.includes('*'));
  const chosen = specific.length > 0 ? specific : star;
  let match: RobotRule | null = null;
  for (const rule of chosen.flatMap((group) => group.rules)) {
    if (!rule.path) continue;
    if (!path.startsWith(rule.path)) continue;
    if (
      !match ||
      rule.path.length > match.path.length ||
      (rule.path.length === match.path.length && rule.allow)
    ) {
      match = rule;
    }
  }
  return match ? match.allow : true;
}

function openUrl(raw: string): URL {
  try {
    return assertPublicUrl(raw, { allowlist: PUBLIC_ONLY_ALLOWLIST });
  } catch (error) {
    if (error instanceof UrlPolicyError) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', error.reason);
    }
    throw error;
  }
}

function nextUrl(current: URL, location: string | undefined): URL {
  if (!location || location.length > 2048 || /[\u0000-\u001f\s]/.test(location)) {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_location');
  }
  let resolved: URL;
  try {
    resolved = new URL(location, current);
  } catch {
    throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'redirect_location');
  }
  return openUrl(resolved.toString());
}

function readDocument(response: GuardedResponse): PublicPage {
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(PROVIDER_KIND.NOT_PUBLIC, '无法公开访问', `status_${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProviderError(
      PROVIDER_KIND.UPSTREAM,
      '外部服务暂时不可用',
      `status_${response.status}`,
    );
  }
  const contentTypeHeader = header(response, 'content-type');
  const contentType = mediaType(contentTypeHeader);
  if (contentType !== 'text/html') {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '只接受公开 HTML 页面', 'content_type');
  }
  const body = decodeHtmlBuffer(response.body, contentTypeHeader);
  const sample = body.slice(0, 2048);
  if (response.body.length < 1500 && LOGIN_MARKERS.some((marker) => sample.includes(marker))) {
    throw new ProviderError(PROVIDER_KIND.NOT_PUBLIC, '无法公开访问', 'login_wall');
  }
  return {
    url: response.url.toString(),
    status: response.status,
    contentType,
    body,
    bytes: response.body.length,
  };
}

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  'x-gbk': 'gb18030',
  cp936: 'gb18030',
  ms936: 'gb18030',
  gb_2312: 'gb18030',
  'gb_2312-80': 'gb18030',
  csgb2312: 'gb18030',
  'iso-ir-58': 'gb18030',
  chinese: 'gb18030',
};

function normalizeCharsetLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  if (!cleaned) return null;
  return CHARSET_ALIASES[cleaned] ?? cleaned;
}

function extractHeaderCharset(contentTypeHeader: string | undefined): string | null {
  if (!contentTypeHeader) return null;
  const match = /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(contentTypeHeader);
  return normalizeCharsetLabel(match?.[1]);
}

function extractMetaCharset(body: Buffer): string | null {
  const head = body.subarray(0, 4096).toString('latin1');
  const directMatch = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(head);
  if (directMatch?.[1]) {
    return normalizeCharsetLabel(directMatch[1]);
  }
  const httpEquivFirst =
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9._-]+)/i.exec(
      head,
    );
  if (httpEquivFirst?.[1]) {
    return normalizeCharsetLabel(httpEquivFirst[1]);
  }
  const contentFirst =
    /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9._-]+)[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?/i.exec(
      head,
    );
  return normalizeCharsetLabel(contentFirst?.[1]);
}

function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

export function decodeHtmlBuffer(body: Buffer, contentTypeHeader?: string): string {
  if (body.length === 0) return '';

  const declaredCharset = extractHeaderCharset(contentTypeHeader) ?? extractMetaCharset(body);
  if (declaredCharset) {
    try {
      return new TextDecoder(declaredCharset, { fatal: false }).decode(body);
    } catch {
      // Unknown or unsupported charset label: fall through to UTF-8 / GB18030 detection.
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    try {
      const gbText = new TextDecoder('gb18030', { fatal: false }).decode(body);
      if (countReplacementChars(gbText) < countReplacementChars(utf8Text)) {
        return gbText;
      }
    } catch {
      // Ignore if gb18030 decoder is unavailable in runtime ICU.
    }
    return utf8Text;
  }
}

async function assertRobots(target: URL, deps: FetchDeps): Promise<void> {
  const rules = await loadRobots(target, deps);
  if (rules === 'deny')
    throw new ProviderError(PROVIDER_KIND.ROBOTS, '无法公开访问', 'robots_unavailable');
  if (rules === 'allow') return;
  if (!robotsAllow(serializeRobots(rules), `${target.pathname}${target.search}`)) {
    throw new ProviderError(PROVIDER_KIND.ROBOTS, '无法公开访问', 'robots_disallow');
  }
}

async function loadRobots(target: URL, deps: FetchDeps): Promise<RobotCacheEntry['rules']> {
  const now = deps.now ?? Date.now;
  const cached = robotsCache.get(target.origin);
  if (cached && cached.expires > now()) return cached.rules;
  const response = await fetchRobots(target, deps);
  let rules: RobotCacheEntry['rules'];
  if (response.status === 404) rules = 'allow';
  else if (response.status >= 200 && response.status < 300)
    rules = parseRobots(response.body.toString('utf8'));
  else rules = 'deny';
  robotsCache.set(target.origin, { expires: now() + deps.robotsCacheMs, rules });
  return rules;
}

async function fetchRobots(target: URL, deps: FetchDeps): Promise<GuardedResponse> {
  let current = openUrl(new URL('/robots.txt', target.origin).toString());
  const maxRedirects = deps.maxRedirects ?? FETCH_MAX_REDIRECTS;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await requestOnce({
      url: current,
      method: 'GET',
      headers: { accept: 'text/plain' },
      timeoutMs: deps.timeoutMs,
      maxBytes: Math.min(deps.maxBytes, 512 * 1024),
      signal: deps.signal,
      resolver: deps.resolver,
      transport: deps.transport,
      allowlist: PUBLIC_ONLY_ALLOWLIST,
    });
    if (!isRedirect(response.status)) return response;
    if (hop === maxRedirects) {
      throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
    }
    current = nextUrl(current, header(response, 'location'));
  }
  throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'too_many_redirects');
}

function parseRobots(text: string): RobotGroup[] {
  const groups: RobotGroup[] = [];
  let current: RobotGroup | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const field = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) {
      current = { agents: ['*'], rules: [] };
      groups.push(current);
    }
    current.rules.push({ allow: field === 'allow', path: value });
  }
  return groups;
}

function serializeRobots(groups: RobotGroup[]): string {
  return groups
    .map((group) =>
      [
        ...group.agents.map((agent) => `User-agent: ${agent}`),
        ...group.rules.map((rule) => `${rule.allow ? 'Allow' : 'Disallow'}: ${rule.path}`),
      ].join('\n'),
    )
    .join('\n');
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function header(response: GuardedResponse, name: string): string | undefined {
  const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function mediaType(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
