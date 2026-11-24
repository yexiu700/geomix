import {
  isSafeDistributionHttpUrl,
  serializeJsonLdSafe,
  type ChannelConnectionConfig,
  type ChannelRemoteTargetDto,
  type GeoMarket,
  type L1ChannelProvider,
  type TestChannelConnectionInput,
} from '@geomix/shared';
import type { OutboundHttpClient } from '../../infra/outbound-http';
import { PROVIDER_KIND, ProviderError } from '../../infra/provider-error';
import { UrlPolicyError } from '../../infra/ssrf';

export type ConnectorConnectionContext = {
  id: string;
  provider: L1ChannelProvider;
  displayName: string;
  siteBaseUrl: string;
  configJson: ChannelConnectionConfig;
  authType?: string;
  targetLocale?: string | null;
  externalShopDomain?: string | null;
};

export type ConnectorSecrets = Record<string, string>;

export type ConnectorPublishPayload = {
  taskId: string;
  articleId: string;
  market: GeoMarket;
  channelLabel: string;
  title: string;
  slug?: string | null;
  metaDesc?: string | null;
  markdown: string;
  html: string;
  publishAsDraft: boolean;
  tags?: string[];
  targetId?: string | null;
  schemaJsonLd?: Record<string, unknown> | null;
  llmsTxtSnippet?: string | null;
  extras?: Record<string, unknown>;
  deliveryId?: string;
  canonicalUrl?: string | null;
  remotePostId?: string | null;
  targetLocale?: string | null;
};

export type ConnectorTestResult = {
  ok: true;
  message: string;
  targets: ChannelRemoteTargetDto[];
  discoveredConfig?: Partial<ChannelConnectionConfig>;
};

export type ConnectorPublishResult = {
  remotePostId: string;
  remoteAdminUrl?: string;
  remotePublishedUrl?: string;
  publishedAsDraft: boolean;
};

export interface CmsConnector {
  readonly provider: L1ChannelProvider;
  testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult>;
  listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]>;
  publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult>;
}

export type ConnectorErrorCode =
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'VALIDATION_ERROR'
  | 'SSRF_BLOCKED'
  | 'TIMEOUT'
  | 'CONFIG_ERROR';

export class ConnectorError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly provider: L1ChannelProvider,
    readonly code: ConnectorErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.retryable = code === 'RATE_LIMITED' || code === 'UPSTREAM_ERROR' || code === 'TIMEOUT';
  }
}

export function trimTrailingSlashes(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * 保留 baseUrl 的路径前缀（如 `/shopify`、`/wp`、`/webflow`）拼接下游接口路径与查询参数。
 */
export function joinBasePath(
  baseUrl: string,
  suffixPath: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(baseUrl.trim());
  const basePath = url.pathname.replace(/\/+$/, '');
  const normalizedSuffix = suffixPath.startsWith('/') ? suffixPath : `/${suffixPath}`;

  if (basePath.endsWith(normalizedSuffix)) {
    url.pathname = basePath || '/';
  } else {
    url.pathname = `${basePath}${normalizedSuffix}`;
  }

  url.hash = '';
  url.search = '';
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

const CONFIG_SECRET_KEY_PATTERN = /token|secret|password|key|auth/i;
const EXPLICIT_CONFIG_SECRET_KEYS = new Set(['indexNowKey', 'indexNowKeyLocation']);
const PERCENT_HEX_PATTERN = /%[0-9A-Fa-f]{2}/g;
const MAX_PERCENT_REGEX_LENGTH = 2048;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造线性时间、零回溯（ReDoS 安全）的百分号编码大小写不敏感匹配正则。
 */
function buildPercentInsensitiveRegex(encoded: string): RegExp | null {
  if (encoded.length > MAX_PERCENT_REGEX_LENGTH) {
    return null;
  }
  PERCENT_HEX_PATTERN.lastIndex = 0;
  if (!PERCENT_HEX_PATTERN.test(encoded)) {
    return null;
  }
  PERCENT_HEX_PATTERN.lastIndex = 0;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PERCENT_HEX_PATTERN.exec(encoded)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeRegExp(encoded.slice(lastIndex, match.index)));
    }
    const hex = match[0].slice(1);
    const hexPattern = hex
      .split('')
      .map((ch) => (/[A-Fa-f]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch))
      .join('');
    parts.push(`%${hexPattern}`);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < encoded.length) {
    parts.push(escapeRegExp(encoded.slice(lastIndex)));
  }
  return new RegExp(parts.join(''), 'g');
}

/**
 * 从渠道 configJson 中提取可能包含敏感信息的配置值（如 indexNowKey、indexNowKeyLocation 及敏感 extraHeaders）。
 */
export function extractConfigSecretValues(configJson?: Record<string, unknown> | null): string[] {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) {
    return [];
  }
  const values: string[] = [];
  for (const [key, value] of Object.entries(configJson)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (
        trimmed &&
        (EXPLICIT_CONFIG_SECRET_KEYS.has(key) || CONFIG_SECRET_KEY_PATTERN.test(key))
      ) {
        values.push(trimmed);
      }
    } else if (
      key === 'extraHeaders' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [hdrKey, hdrVal] of Object.entries(value as Record<string, unknown>)) {
        if (typeof hdrVal !== 'string') continue;
        const trimmed = hdrVal.trim();
        if (trimmed && CONFIG_SECRET_KEY_PATTERN.test(hdrKey)) {
          values.push(trimmed);
        }
      }
    }
  }
  return values;
}

/**
 * 收集凭据明文、敏感配置值及其常见变形（去首尾空白、折叠/去除空白、URL 编码、JSON 转义、WordPress Basic Auth Base64），
 * 按长度降序排列以确保完整凭据先被脱敏。
 */
export function collectSecretCandidates(
  secrets: ConnectorSecrets,
  configJson?: Record<string, unknown> | null,
): string[] {
  const set = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || candidate.length === 0) return;
    set.add(candidate);
  };

  const addWithWhitespaceVariants = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    add(rawValue);
    add(trimmed);
    const collapsed = trimmed.replace(/\s+/g, ' ');
    if (collapsed.length >= 4) {
      add(collapsed);
    }
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length >= 4) {
      add(compact);
    }
  };

  for (const [key, rawValue] of Object.entries(secrets)) {
    if (typeof rawValue !== 'string' || !rawValue) continue;
    // 避免把普通的非密钥短用户名直接当子串替换掉正常提示文本；但仍参与 Basic Auth 编码与长值保护
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    if (key.toLowerCase() !== 'username' || trimmed.length >= 8) {
      addWithWhitespaceVariants(rawValue);
    }
  }

  for (const configSecret of extractConfigSecretValues(configJson)) {
    addWithWhitespaceVariants(configSecret);
  }

  const username = secrets.username?.trim();
  const appPassword = (
    secrets.appPassword ??
    secrets.applicationPassword ??
    secrets.password
  )?.trim();
  if (username && appPassword) {
    add(Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64'));
    const compactPassword = appPassword.replace(/\s+/g, '');
    if (compactPassword !== appPassword) {
      add(Buffer.from(`${username}:${compactPassword}`, 'utf8').toString('base64'));
    }
  }

  const adminApiKey = secrets.adminApiKey?.trim();
  if (adminApiKey && adminApiKey.includes(':')) {
    const colonIdx = adminApiKey.indexOf(':');
    const hexSecret = adminApiKey.slice(colonIdx + 1).trim();
    if (hexSecret.length >= 8) {
      add(hexSecret);
    }
  }

  return [...set].sort((a, b) => b.length - a.length);
}

type PreparedRedactionMatcher = {
  longLiterals: string[];
  percentRegexes: RegExp[];
  shortRegexes: RegExp[];
};

function prepareRedactionMatcher(secretCandidates: readonly string[]): PreparedRedactionMatcher {
  const longLiteralSet = new Set<string>();
  const percentEncodedSet = new Set<string>();
  const shortSet = new Set<string>();

  const addEncodedForm = (encoded: string) => {
    if (encoded.length < 4) return;
    longLiteralSet.add(encoded);
    const lowerEncoded = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    if (lowerEncoded !== encoded) {
      longLiteralSet.add(lowerEncoded);
    }
    percentEncodedSet.add(encoded);
  };

  const addJsonEscapedForms = (value: string) => {
    if (value.length < 4) return;
    // 覆盖 PHP json_encode 默认将 `/` 转义为 `\/` 以及标准 JSON 转义（`\\`、`\"` 等）
    const slashEscaped = value.replace(/\//g, '\\/');
    if (slashEscaped !== value) {
      longLiteralSet.add(slashEscaped);
    }
    try {
      const jsonInner = JSON.stringify(value).slice(1, -1);
      if (jsonInner.length >= 4 && jsonInner !== value) {
        longLiteralSet.add(jsonInner);
      }
      const jsonSlashEscaped = jsonInner.replace(/\//g, '\\/');
      if (jsonSlashEscaped.length >= 4 && jsonSlashEscaped !== jsonInner) {
        longLiteralSet.add(jsonSlashEscaped);
      }
    } catch {
      // Ignore unserializable surrogate edge cases
    }
  };

  for (const rawCandidate of secretCandidates) {
    if (!rawCandidate) continue;
    if (rawCandidate.length < 4) {
      shortSet.add(rawCandidate);
      continue;
    }

    const baseForms = new Set<string>([rawCandidate]);
    const collapsed = rawCandidate
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (collapsed.length >= 4) {
      baseForms.add(collapsed);
    }

    for (const candidate of baseForms) {
      longLiteralSet.add(candidate);
      addJsonEscapedForms(candidate);

      try {
        const encoded = encodeURIComponent(candidate);
        addEncodedForm(encoded);
        if (encoded.includes('%20')) {
          addEncodedForm(encoded.replace(/%20/g, '+'));
        }
      } catch {
        // Ignore malformed surrogate pairs
      }

      try {
        const formUrlEncoded = new URLSearchParams([['v', candidate]]).toString().slice(2);
        if (formUrlEncoded.length >= 4) {
          addEncodedForm(formUrlEncoded);
        }
      } catch {
        // Ignore malformed surrogate pairs
      }
    }
  }

  const longLiterals = [...longLiteralSet].sort((a, b) => b.length - a.length);
  const percentRegexes: RegExp[] = [];
  for (const encoded of [...percentEncodedSet].sort((a, b) => b.length - a.length)) {
    const re = buildPercentInsensitiveRegex(encoded);
    if (re) {
      percentRegexes.push(re);
    }
  }

  const shortRegexes = [...shortSet]
    .sort((a, b) => b.length - a.length)
    .map(
      (candidate) =>
        new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(candidate)}(?![A-Za-z0-9_-])`, 'g'),
    );

  return { longLiterals, percentRegexes, shortRegexes };
}

function applySecretRedactionPass(input: string, matcher: PreparedRedactionMatcher): string {
  let text = input;

  for (const literal of matcher.longLiterals) {
    if (text.includes(literal)) {
      text = text.split(literal).join('[REDACTED]');
    }
  }

  for (const re of matcher.percentRegexes) {
    re.lastIndex = 0;
    text = text.replace(re, '[REDACTED]');
  }

  for (const boundaryRegex of matcher.shortRegexes) {
    boundaryRegex.lastIndex = 0;
    text = text.replace(boundaryRegex, '[REDACTED]');
  }

  text = text
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic|ghost|token)\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\b(bearer|basic|ghost|token)\s+(?:[A-Za-z0-9._~+/=-]|\\\/){8,}/gi, '$1 [REDACTED]')
    .replace(/(x-shopify-access-token\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/(api-key\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/(x-geomix-signature\s*[:=]\s*)sha256=[0-9a-fA-F]+/gi, '$1[REDACTED]')
    .replace(/([?&]access_token=)[^&\s"',;]+/gi, '$1[REDACTED]')
    .replace(
      /\b(shpat|shpca|shppa|shpss|whsec|wf|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{4,}\b/gi,
      '$1_[REDACTED]',
    )
    .replace(/\bsha256=[0-9a-fA-F]{32,}\b/gi, 'sha256=[REDACTED]')
    .replace(
      /("(?:access_?token|oauth_?access_?token|admin_?api_?key|api_?key|api_?token|app_?secret|app_?password|application_?password|signing_?secret|password|secret|token|authorization|index_?now_?key|key)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    );

  return text;
}

/**
 * 清除文本中可能出现的凭据明文、URL/表单编码变体、JSON 转义变体、认证头、签名值及常见令牌前缀，并裁剪控制字符与长度。
 * 在空白/控制字符归一化前后各执行一次脱敏，防止通过换行/制表符拆分带空格密钥在归一化后被重组为明文。
 */
export function redactSecrets(
  raw: string,
  secretCandidates: readonly string[],
  maxLen = 300,
): string {
  const matcher = prepareRedactionMatcher(secretCandidates);
  let text = applySecretRedactionPass(String(raw ?? ''), matcher);

  // 清除控制字符与多余空白后再次执行脱敏，彻底阻断空白折叠重组明文绕过
  text = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  text = applySecretRedactionPass(text, matcher);

  if (text.length > maxLen) {
    return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
  }
  return text;
}

export function parseJsonSafe<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractBriefValidationMessage(body: string): string {
  const parsed = parseJsonSafe<Record<string, unknown>>(body);
  if (parsed && typeof parsed === 'object') {
    for (const key of ['message', 'error', 'msg', 'detail']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === 'object' && 'message' in value) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === 'string' && nested.trim()) {
          return nested.trim();
        }
      }
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (first && typeof first === 'object' && 'message' in first) {
        const msg = (first as { message?: unknown }).message;
        if (typeof msg === 'string' && msg.trim()) return msg.trim();
      }
    }
  }
  return body.trim();
}

/**
 * 统一映射外部 CMS / Webhook 的 HTTP 非 2xx 响应，严禁在 401/403/5xx 中回显原始响应体。
 */
export function mapHttpStatusError(
  provider: L1ChannelProvider,
  status: number,
  body: string,
  secretCandidates: readonly string[],
): ConnectorError {
  if (status === 401) {
    return new ConnectorError(
      provider,
      'AUTH_FAILED',
      '认证失败（HTTP 401），请检查连接凭据',
      status,
    );
  }
  if (status === 403) {
    return new ConnectorError(
      provider,
      'FORBIDDEN',
      '权限不足（HTTP 403），请确认凭据具备发布权限',
      status,
    );
  }
  if (status === 404) {
    return new ConnectorError(
      provider,
      'NOT_FOUND',
      '目标接口或资源不存在（HTTP 404），请检查站点地址或目标配置',
      status,
    );
  }
  if (status === 429) {
    return new ConnectorError(
      provider,
      'RATE_LIMITED',
      '上游接口触发限流（HTTP 429），请稍后重试',
      status,
    );
  }
  if (status === 400 || status === 422) {
    const rawDetail = extractBriefValidationMessage(body);
    const safeDetail = redactSecrets(rawDetail, secretCandidates, 220);
    const message = safeDetail
      ? `上游接口参数校验失败（HTTP ${status}）：${safeDetail}`
      : `上游接口参数校验失败（HTTP ${status}）`;
    return new ConnectorError(provider, 'VALIDATION_ERROR', message, status);
  }
  if (status >= 500) {
    return new ConnectorError(
      provider,
      'UPSTREAM_ERROR',
      `上游站点服务异常（HTTP ${status}），请稍后重试`,
      status,
    );
  }
  return new ConnectorError(
    provider,
    'UPSTREAM_ERROR',
    `上游接口返回异常状态（HTTP ${status}）`,
    status,
  );
}

/**
 * 统一映射 OutboundHttpClient 抛出的网络/策略异常，不泄露凭据。
 */
export function mapTransportError(
  provider: L1ChannelProvider,
  error: unknown,
  secretCandidates: readonly string[],
): ConnectorError {
  if (error instanceof ConnectorError) {
    const safeMsg = redactSecrets(error.message, secretCandidates, 300);
    if (safeMsg === error.message) return error;
    return new ConnectorError(error.provider, error.code, safeMsg, error.httpStatus);
  }
  if (error instanceof UrlPolicyError) {
    return new ConnectorError(
      provider,
      'SSRF_BLOCKED',
      '目标地址不允许访问（已触发 SSRF 安全拦截）',
    );
  }
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case PROVIDER_KIND.SSRF:
        return new ConnectorError(
          provider,
          'SSRF_BLOCKED',
          '目标地址不允许访问（已触发 SSRF 安全拦截）',
        );
      case PROVIDER_KIND.TIMEOUT:
        return new ConnectorError(provider, 'TIMEOUT', '外部站点请求超时，请检查站点连通性');
      case PROVIDER_KIND.TOO_LARGE:
        return new ConnectorError(provider, 'UPSTREAM_ERROR', '外部站点响应体超过大小限制');
      case PROVIDER_KIND.CANCELLED:
        return new ConnectorError(provider, 'UPSTREAM_ERROR', '外部站点请求已取消');
      default:
        return new ConnectorError(
          provider,
          'UPSTREAM_ERROR',
          '无法连接到目标站点，请检查域名与网络状态',
        );
    }
  }
  return new ConnectorError(provider, 'UPSTREAM_ERROR', '无法连接到目标站点，请检查域名与网络状态');
}

/**
 * 将 JSON-LD 安全序列化后以内联 `<script type="application/ld+json">` 附加到 HTML 正文末尾；
 * WordPress 场景可启用 `wrapGutenberg` 包裹为 `<!-- wp:html --> ... <!-- /wp:html -->`。
 */
export function appendInlineJsonLd(
  html: string,
  schemaJsonLd: Record<string, unknown>,
  wrapGutenberg: boolean,
): string {
  const safeJson = serializeJsonLdSafe(schemaJsonLd);
  const scriptBlock = `<script type="application/ld+json">\n${safeJson}\n</script>`;
  const block = wrapGutenberg ? `<!-- wp:html -->\n${scriptBlock}\n<!-- /wp:html -->` : scriptBlock;
  const trimmedHtml = html.trimEnd();
  return trimmedHtml ? `${trimmedHtml}\n${block}` : block;
}

export function slugifyAscii(raw: string): string {
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'article';
}

/**
 * 校验上游返回或构造的发布链接是否符合公网安全策略（语法 + SSRF / DNS 校验）。
 * 校验失败时统一抛出 `ConnectorError(provider, 'SSRF_BLOCKED', ...)`，防止私网或元数据地址进入发布记录。
 */
export async function validatePublishedUrl(
  http: OutboundHttpClient,
  provider: L1ChannelProvider,
  candidate: string,
  message = '上游返回的发布链接未通过公网安全校验',
): Promise<string> {
  const trimmed = candidate.trim();
  if (!trimmed || !isSafeDistributionHttpUrl(trimmed)) {
    throw new ConnectorError(provider, 'SSRF_BLOCKED', message);
  }
  try {
    await http.assertAllowedUrl(trimmed);
  } catch {
    throw new ConnectorError(provider, 'SSRF_BLOCKED', message);
  }
  return trimmed;
}
