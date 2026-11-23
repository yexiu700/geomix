import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AUTH_ERROR,
  CRAWL_PROBE_BOTS,
  type CrawlProbeBotResult,
  type CrawlProbeReport,
  type CrawlProbeStatus,
  type GeoPublishRecordDto,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { robotsAllow } from '../infra/public-fetch';
import type { SsrfAllowlist } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import { presentPublishRecord, type GeoPublishRecordRow } from '../studio/studio.mapper';
import { currentTenantId, runInTenant } from '../tenant/tenant-context';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_ROBOTS_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ROBOTS_MAX_BYTES = 512 * 1024;
const DEFAULT_SWEEP_BATCH_SIZE = 20;
const MAX_SWEEP_BATCH_SIZE = 100;
const DEFAULT_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const NOINDEX_RE = /\b(?:noindex|none)\b/i;
const META_ROBOTS_NAMES = new Set(['robots', 'googlebot', 'gptbot']);

export type CrawlProbeUrlOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  allowlistOverride?: SsrfAllowlist | string;
};

export type CrawlProbeUrlResult = {
  status: CrawlProbeStatus;
  report: CrawlProbeReport;
};

export type CrawlProbeSweepOptions = {
  now?: Date;
  batchSize?: number;
  minAgeMs?: number;
  allowlistOverride?: SsrfAllowlist | string;
};

export type CrawlProbeSweepReport = {
  scanned: number;
  probed: number;
  failed: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[0-9]+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readCrawlProbeRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = parsePositiveInt(env.CRAWL_PROBE_RATE_LIMIT_MAX, 30);
  const windowSeconds = parsePositiveInt(env.CRAWL_PROBE_RATE_LIMIT_WINDOW_SECONDS, 60);
  return { max, windowMs: windowSeconds * 1000 };
}

function sanitizeProbeError(error: unknown): { issue: string; errorMessage: string } {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case PROVIDER_KIND.SSRF:
        return {
          issue: '目标地址不允许访问（SSRF 安全策略拦截）',
          errorMessage: '目标地址不允许访问',
        };
      case PROVIDER_KIND.TIMEOUT:
        return { issue: '目标页面抓取超时', errorMessage: '外部服务超时' };
      case PROVIDER_KIND.TOO_LARGE:
        return { issue: '目标页面响应体超过大小限制', errorMessage: '响应超过大小限制' };
      case PROVIDER_KIND.CANCELLED:
        return { issue: '目标页面抓取请求已取消', errorMessage: '请求已取消' };
      case PROVIDER_KIND.UPSTREAM:
        return {
          issue: '目标站点暂时不可用或网络连接失败',
          errorMessage: '外部服务暂时不可用',
        };
      default:
        return { issue: '目标页面抓取失败', errorMessage: '目标页面抓取失败' };
    }
  }
  return { issue: '目标页面抓取失败', errorMessage: '目标页面抓取失败' };
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  targetName: string,
): string | undefined {
  const lower = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function parseHtmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrText)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = value;
  }
  return attrs;
}

function detectMetaNoindex(html: string, headers: Record<string, string>): boolean {
  const xRobotsTag = getHeaderCaseInsensitive(headers, 'x-robots-tag');
  if (xRobotsTag && NOINDEX_RE.test(xRobotsTag)) {
    return true;
  }

  const metaRe = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[1] ?? '');
    const name = attrs.name?.trim().toLowerCase();
    const content = attrs.content ?? '';
    if (name && META_ROBOTS_NAMES.has(name) && NOINDEX_RE.test(content)) {
      return true;
    }
  }
  return false;
}

function collectJsonLdTypes(node: unknown, out: string[], seen: Set<string>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdTypes(item, out, seen);
    }
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const rawType = obj['@type'];
  if (typeof rawType === 'string') {
    const trimmed = rawType.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  } else if (Array.isArray(rawType)) {
    for (const entry of rawType) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          out.push(trimmed);
        }
      }
    }
  }
  if (Array.isArray(obj['@graph'])) {
    collectJsonLdTypes(obj['@graph'], out, seen);
  }
}

function extractJsonLd(html: string): { types: string[]; parseErrors: string[] } {
  const types: string[] = [];
  const seen = new Set<string>();
  const parseErrors: string[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[1] ?? '');
    const mediaType = (attrs.type ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/ld+json') continue;

    const raw = (match[2] ?? '').trim();
    if (!raw) {
      parseErrors.push('JSON-LD 脚本块为空');
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      collectJsonLdTypes(parsed, types, seen);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid JSON';
      parseErrors.push(`JSON-LD 解析失败: ${reason}`);
    }
  }

  return { types, parseErrors };
}

function normalizeComparableUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    let port = parsed.port;
    if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) {
      port = '';
    }
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const hostPort = port ? `${hostname}:${port}` : hostname;
    return `${protocol}//${hostPort}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function extractCanonical(
  html: string,
  finalUrl: string,
  rawUrl: string,
): { canonicalUrl: string | null; canonicalMatches: boolean | null } {
  const linkRe = /<link\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[1] ?? '');
    const relTokens = (attrs.rel ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes('canonical')) continue;

    const href = (attrs.href ?? '').trim();
    if (!href) continue;

    try {
      const resolved = new URL(href, finalUrl).toString();
      const normCanonical = normalizeComparableUrl(resolved);
      const normFinal = normalizeComparableUrl(finalUrl);
      const normRaw = normalizeComparableUrl(rawUrl);
      const canonicalMatches = Boolean(
        normCanonical && (normCanonical === normFinal || normCanonical === normRaw),
      );
      return { canonicalUrl: resolved, canonicalMatches };
    } catch {
      return { canonicalUrl: href, canonicalMatches: false };
    }
  }

  return { canonicalUrl: null, canonicalMatches: null };
}

type ParsedRobotRule = { allow: boolean; path: string };
type ParsedRobotGroup = { agents: string[]; rules: ParsedRobotRule[] };

function parseRobotsForRuleLabel(body: string): ParsedRobotGroup[] {
  const groups: ParsedRobotGroup[] = [];
  let current: ParsedRobotGroup | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
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

function findMatchedRobotsRule(body: string, path: string, bot: string): string | undefined {
  const groups = parseRobotsForRuleLabel(body);
  const specific = groups.filter((group) =>
    group.agents.some((name) => name.toLowerCase() === bot.toLowerCase()),
  );
  const star = groups.filter((group) => group.agents.includes('*'));
  const chosen = specific.length > 0 ? specific : star;
  let match: ParsedRobotRule | null = null;
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
  if (!match) return undefined;
  return `${match.allow ? 'Allow' : 'Disallow'}: ${match.path}`;
}

/**
 * T+1 AI 爬虫可读性体检服务（Issue #352）：
 * - 100% 经由 OutboundHttpClient 发出只读请求（SSRF 硬防护，绝不调用 fetchPublicPage）
 * - 核验 HTTP 状态、robots.txt 五大爬虫矩阵、meta robots / X-Robots-Tag、实时 JSON-LD 与 canonical
 * - 仅在 runSweep 扫描待体检记录时使用 1 次 prisma.base.geoPublishRecord.findMany，其余全程 runInTenant + prisma.scoped
 */
@Injectable()
export class CrawlProbeService {
  private readonly logger = new Logger(CrawlProbeService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional()
    @Inject(FreeActionRateLimiter)
    private readonly rateLimiter?: FreeActionRateLimiter,
  ) {}

  async probeUrl(rawUrl: string, opts?: CrawlProbeUrlOptions): Promise<CrawlProbeUrlResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const maxBytes = opts?.maxBytes ?? DEFAULT_PROBE_MAX_BYTES;
    const trimmedUrl = rawUrl.trim();
    const checkedUrl = trimmedUrl || '(empty)';

    let pageRes: Awaited<ReturnType<OutboundHttpClient['request']>>;
    try {
      pageRes = await this.http.request({
        url: trimmedUrl,
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        timeoutMs,
        maxBytes,
        maxRedirects: 5,
        signal: opts?.signal,
        allowlistOverride: opts?.allowlistOverride,
      });
    } catch (error) {
      const { issue, errorMessage } = sanitizeProbeError(error);
      return {
        status: 'FAILED',
        report: {
          checkedUrl,
          httpStatus: null,
          robotsTxtFound: false,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          canonicalUrl: null,
          canonicalMatches: null,
          issues: [issue],
          errorMessage,
        },
      };
    }

    const finalUrl = pageRes.finalUrl || checkedUrl;

    if (pageRes.status === 401 || pageRes.status === 403) {
      return {
        status: 'BLOCKED',
        report: {
          checkedUrl,
          finalUrl,
          httpStatus: pageRes.status,
          robotsTxtFound: false,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          canonicalUrl: null,
          canonicalMatches: null,
          issues: [`页面返回 HTTP ${pageRes.status}，爬虫无法公开访问`],
        },
      };
    }

    if (pageRes.status < 200 || pageRes.status >= 300) {
      return {
        status: 'FAILED',
        report: {
          checkedUrl,
          finalUrl,
          httpStatus: pageRes.status,
          robotsTxtFound: false,
          robotsMatrix: [],
          metaNoindex: false,
          jsonLdTypes: [],
          jsonLdParseErrors: [],
          canonicalUrl: null,
          canonicalMatches: null,
          issues: [`页面返回异常状态码 HTTP ${pageRes.status}`],
        },
      };
    }

    const issues: string[] = [];
    const finalParsed = new URL(finalUrl);
    const targetPath = `${finalParsed.pathname}${finalParsed.search}`;
    const robotsUrl = new URL('/robots.txt', finalParsed.origin).toString();

    let robotsTxtFound = false;
    let robotsMatrix: CrawlProbeBotResult[] = CRAWL_PROBE_BOTS.map((bot) => ({
      bot,
      allowed: true,
    }));

    try {
      const robotsRes = await this.http.request({
        url: robotsUrl,
        method: 'GET',
        headers: { accept: 'text/plain,*/*;q=0.8' },
        timeoutMs: Math.min(timeoutMs, DEFAULT_ROBOTS_TIMEOUT_MS),
        maxBytes: DEFAULT_ROBOTS_MAX_BYTES,
        maxRedirects: 3,
        signal: opts?.signal,
        allowlistOverride: opts?.allowlistOverride,
      });

      if (robotsRes.status >= 200 && robotsRes.status < 300) {
        robotsTxtFound = true;
        robotsMatrix = CRAWL_PROBE_BOTS.map((bot) => {
          const allowed = robotsAllow(robotsRes.body, targetPath, bot);
          const matchedRule = findMatchedRobotsRule(robotsRes.body, targetPath, bot);
          return matchedRule ? { bot, allowed, matchedRule } : { bot, allowed };
        });
      } else if (robotsRes.status === 404 || robotsRes.status === 410) {
        robotsTxtFound = false;
      } else {
        robotsTxtFound = false;
        issues.push(`robots.txt 暂时无法读取（HTTP ${robotsRes.status}）`);
      }
    } catch {
      robotsTxtFound = false;
      issues.push('robots.txt 暂时无法读取，按默认允许继续体检');
    }

    const metaNoindex = detectMetaNoindex(pageRes.body, pageRes.headers);
    const { types: jsonLdTypes, parseErrors: jsonLdParseErrors } = extractJsonLd(pageRes.body);
    const { canonicalUrl, canonicalMatches } = extractCanonical(pageRes.body, finalUrl, checkedUrl);

    const blockedBots = robotsMatrix.filter((entry) => !entry.allowed).map((entry) => entry.bot);
    if (blockedBots.length > 0) {
      issues.push(`robots.txt 拦截了以下爬虫：${blockedBots.join(', ')}`);
    }
    if (metaNoindex) {
      issues.push('检测到 meta robots / X-Robots-Tag 包含 noindex，页面将被禁止收录');
    }
    if (jsonLdParseErrors.length > 0) {
      issues.push(`检测到 ${jsonLdParseErrors.length} 处 JSON-LD 语法错误`);
    }
    if (jsonLdTypes.length === 0) {
      issues.push('页面未检测到 JSON-LD 结构化数据（Schema）');
    }
    if (canonicalMatches === false) {
      issues.push('页面 canonical 链接与发布地址不一致');
    }

    let status: CrawlProbeStatus;
    if (metaNoindex || blockedBots.length > 0) {
      status = 'BLOCKED';
    } else if (
      jsonLdParseErrors.length > 0 ||
      jsonLdTypes.length === 0 ||
      canonicalMatches === false ||
      issues.length > 0
    ) {
      status = 'WARNING';
    } else {
      status = 'OK';
    }

    return {
      status,
      report: {
        checkedUrl,
        finalUrl,
        httpStatus: pageRes.status,
        robotsTxtFound,
        robotsMatrix,
        metaNoindex,
        jsonLdTypes,
        jsonLdParseErrors,
        canonicalUrl,
        canonicalMatches,
        issues,
      },
    };
  }

  async probePublishRecord(
    publishRecordId: string,
    opts?: {
      tenantId?: string;
      enforceRateLimit?: boolean;
      allowlistOverride?: SsrfAllowlist | string;
    },
  ): Promise<GeoPublishRecordDto> {
    if (opts?.enforceRateLimit !== false) {
      const tenantId = opts?.tenantId ?? currentTenantId();
      if (!tenantId || tenantId === 'system') {
        throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
      }
      this.rateLimiter?.assertAllowed('crawl_probe', tenantId, readCrawlProbeRateLimit());
    }

    const record = await this.prisma.scoped.geoPublishRecord.findFirst({
      where: { id: publishRecordId },
    });
    if (!record) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '发布记录不存在');
    }

    const { status, report } = await this.probeUrl(record.publishedUrl, {
      allowlistOverride: opts?.allowlistOverride,
    });

    const updated = await this.prisma.scoped.geoPublishRecord.update({
      where: { id: record.id },
      data: {
        crawlStatus: status,
        crawlCheckedAt: new Date(),
        crawlReportJson: report as unknown as Prisma.InputJsonValue,
      },
      include: {
        retestSchedules: {
          orderBy: { milestoneDay: 'asc' },
        },
      },
    });

    return presentPublishRecord(updated as unknown as GeoPublishRecordRow);
  }

  async runSweep(opts?: CrawlProbeSweepOptions): Promise<CrawlProbeSweepReport> {
    const now = opts?.now ?? new Date();
    const minAgeMs = opts?.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS;
    const batchSize = Math.min(
      MAX_SWEEP_BATCH_SIZE,
      Math.max(1, opts?.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE),
    );
    const cutoff = new Date(now.getTime() - minAgeMs);

    const rows = await this.prisma.base.geoPublishRecord.findMany({
      where: {
        crawlStatus: 'PENDING',
        publishedAt: { lte: cutoff },
      },
      select: {
        id: true,
        tenantId: true,
      },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });

    let probed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await runInTenant(row.tenantId, () =>
          this.probePublishRecord(row.id, {
            tenantId: row.tenantId,
            enforceRateLimit: false,
            allowlistOverride: opts?.allowlistOverride,
          }),
        );
        probed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `crawl-probe-sweep failed for record=${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      scanned: rows.length,
      probed,
      failed,
    };
  }
}
