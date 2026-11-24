import {
  classifyCitationSource,
  isPrivateOrReservedHostLiteral,
  normalizeVisibilityDomain,
  type CitationSourceKind,
} from '@geomix/shared';

export const MAX_RETRIEVED_SOURCES_PER_OBSERVATION = 100;
export const MAX_RAW_SOURCE_SCAN = 500;

export type ParsedRetrievedSource = {
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  sourceKind: CitationSourceKind;
  wasOpened: boolean;
  wasCited: boolean;
  rank: number | null;
};

export type NormalizedRetrievedUrl = {
  url: string;
  domain: string;
  matchKey: string;
};

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const DISALLOWED_URL_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'spm',
  'ref',
  'from',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanOptionalText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return null;
  return Math.trunc(raw);
}

function pickFirstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
  }
  return null;
}

/**
 * 严格白名单清洗观测原始元数据，仅保留 5 个安全诊断字段。
 * 非对象、空对象或无合法白名单字段时返回 null（调用方写入 Prisma.DbNull）。
 */
export function sanitizeObservationRawMeta(rawMeta: unknown): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(rawMeta)) return null;

    const out: Record<string, unknown> = {};

    if (typeof rawMeta.provider === 'string') {
      const provider = rawMeta.provider.replace(CONTROL_CHARS_RE, '').trim().slice(0, 64);
      if (provider) {
        out.provider = provider;
      }
    }

    if (typeof rawMeta.aiOverviewTriggered === 'boolean') {
      out.aiOverviewTriggered = rawMeta.aiOverviewTriggered;
    }

    if (
      typeof rawMeta.serverToolSearchCount === 'number' &&
      Number.isFinite(rawMeta.serverToolSearchCount) &&
      rawMeta.serverToolSearchCount >= 0
    ) {
      out.serverToolSearchCount = Math.min(100_000, Math.floor(rawMeta.serverToolSearchCount));
    }

    if (
      typeof rawMeta.serverToolFetchCount === 'number' &&
      Number.isFinite(rawMeta.serverToolFetchCount) &&
      rawMeta.serverToolFetchCount >= 0
    ) {
      out.serverToolFetchCount = Math.min(100_000, Math.floor(rawMeta.serverToolFetchCount));
    }

    if (
      typeof rawMeta.latencyMs === 'number' &&
      Number.isFinite(rawMeta.latencyMs) &&
      rawMeta.latencyMs >= 0
    ) {
      out.latencyMs = Math.min(3_600_000, Math.round(rawMeta.latencyMs));
    }

    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 校验并标准化上游召回/点开页面 URL，生成用于去重与 wasCited 精确比对的 matchKey。
 * 拒绝非 http(s)、含凭证/控制符/空白符、超长、私有/保留 IP、内网后缀或无合法域名的 URL；永不抛错。
 */
export function normalizeRetrievedHttpUrl(raw: unknown): NormalizedRetrievedUrl | null {
  try {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 2048 || DISALLOWED_URL_CHARS_RE.test(trimmed)) {
      return null;
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    const cleanHost = parsed.hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (
      !cleanHost ||
      cleanHost === 'localhost' ||
      cleanHost.endsWith('.localhost') ||
      cleanHost.endsWith('.local') ||
      cleanHost.endsWith('.internal') ||
      cleanHost.endsWith('.home.arpa') ||
      cleanHost.endsWith('.localdomain') ||
      isPrivateOrReservedHostLiteral(parsed.hostname)
    ) {
      return null;
    }

    const domain = normalizeVisibilityDomain(parsed.toString());
    if (!domain) return null;

    parsed.hash = '';

    const keysToDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();

    const url = parsed.toString().slice(0, 2048);

    const normalizedHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const isDefaultPort =
      !parsed.port ||
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443');
    const hostWithPort = isDefaultPort ? normalizedHost : `${normalizedHost}:${parsed.port}`;
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const searchStr = parsed.searchParams.toString();
    const search = searchStr ? `?${searchStr}` : '';

    return {
      url,
      domain,
      matchKey: `${hostWithPort}${pathname}${search}`,
    };
  } catch {
    return null;
  }
}

/**
 * 从上游收集结果 rawMeta 中防御性解析 retrievedSources[] 与 openedPages[]：
 * - 兼容字符串与对象元素，兼容 opened / wasOpened 字段
 * - 与 openedPages[] 执行并集合并（命中即升级 wasOpened = true，未出现则补录）
 * - 依据标准化 URL 与最终 citations 比对计算 wasCited
 * - 依据品牌自有域/竞品域分类 sourceKind
 * - 按标准化 URL 去重，并严格限制每条观测最多写入 100 条（超限时优先保留 wasOpened 行）
 */
export function parseRetrievedSourcesFromRawMeta(
  rawMeta: unknown,
  context: {
    citations: ReadonlyArray<{ url: string }>;
    ownedDomains: readonly string[];
    competitorDomains: readonly string[];
  },
): ParsedRetrievedSource[] {
  try {
    if (!isPlainRecord(rawMeta)) return [];

    const citedKeys = new Set<string>();
    for (const cite of context.citations) {
      const normalized = normalizeRetrievedHttpUrl(cite.url);
      if (normalized) {
        citedKeys.add(normalized.matchKey);
      }
    }

    const byKey = new Map<string, ParsedRetrievedSource & { _order: number }>();
    let order = 0;

    const upsert = (entry: {
      rawUrl: unknown;
      wasOpened: boolean;
      title: string | null;
      snippet: string | null;
      rank: number | null;
    }) => {
      const normalized = normalizeRetrievedHttpUrl(entry.rawUrl);
      if (!normalized) return;

      const existing = byKey.get(normalized.matchKey);
      if (existing) {
        if (!existing.url.startsWith('https://') && normalized.url.startsWith('https://')) {
          existing.url = normalized.url;
        }
        existing.wasOpened = existing.wasOpened || entry.wasOpened;
        if (!existing.title && entry.title) existing.title = entry.title;
        if (!existing.snippet && entry.snippet) existing.snippet = entry.snippet;
        if (entry.rank !== null && (existing.rank === null || entry.rank < existing.rank)) {
          existing.rank = entry.rank;
        }
        return;
      }

      const sourceKind = classifyCitationSource(normalized.url, {
        ownedDomains: context.ownedDomains,
        competitorDomains: context.competitorDomains,
      });

      byKey.set(normalized.matchKey, {
        url: normalized.url,
        domain: normalized.domain,
        title: entry.title,
        snippet: entry.snippet,
        sourceKind,
        wasOpened: entry.wasOpened,
        wasCited: citedKeys.has(normalized.matchKey),
        rank: entry.rank,
        _order: order++,
      });
    };

    // Pass 1: retrievedSources[]
    if (Array.isArray(rawMeta.retrievedSources)) {
      const limit = Math.min(rawMeta.retrievedSources.length, MAX_RAW_SOURCE_SCAN);
      for (let idx = 0; idx < limit; idx += 1) {
        const item: unknown = rawMeta.retrievedSources[idx];
        if (typeof item === 'string') {
          upsert({
            rawUrl: item,
            wasOpened: false,
            title: null,
            snippet: null,
            rank: idx + 1,
          });
          continue;
        }
        if (!isPlainRecord(item)) continue;

        const rawUrl = pickFirstString(item, ['url', 'link', 'href']);
        if (!rawUrl) continue;

        const wasOpened = item.opened === true || item.wasOpened === true;
        const title = cleanOptionalText(item.title, 300);
        const snippet = cleanOptionalText(
          pickFirstString(item, ['snippet', 'description', 'summary']),
          1000,
        );
        const rank = parsePositiveInt(item.rank) ?? parsePositiveInt(item.position) ?? idx + 1;

        upsert({
          rawUrl,
          wasOpened,
          title,
          snippet,
          rank,
        });
      }
    }

    // Pass 2: openedPages[] (union merge: upgrades existing or inserts opened-only URL)
    if (Array.isArray(rawMeta.openedPages)) {
      const limit = Math.min(rawMeta.openedPages.length, MAX_RAW_SOURCE_SCAN);
      for (let idx = 0; idx < limit; idx += 1) {
        const item: unknown = rawMeta.openedPages[idx];
        if (typeof item === 'string') {
          upsert({
            rawUrl: item,
            wasOpened: true,
            title: null,
            snippet: null,
            rank: null,
          });
          continue;
        }
        if (!isPlainRecord(item)) continue;

        const rawUrl = pickFirstString(item, ['url', 'link', 'href']);
        if (!rawUrl) continue;

        const title = cleanOptionalText(item.title, 300);
        const snippet = cleanOptionalText(
          pickFirstString(item, ['snippet', 'description', 'summary']),
          1000,
        );
        const rank = parsePositiveInt(item.rank) ?? parsePositiveInt(item.position);

        upsert({
          rawUrl,
          wasOpened: true,
          title,
          snippet,
          rank,
        });
      }
    }

    const entries = [...byKey.values()];
    if (entries.length <= MAX_RETRIEVED_SOURCES_PER_OBSERVATION) {
      return entries.map(({ _order: _, ...rest }) => rest);
    }

    // Prioritize high-value Near-Miss signals on overflow:
    // 0: opened & !cited, 1: opened & cited, 2: !opened & !cited, 3: !opened & cited
    entries.sort((a, b) => {
      const prioA = (a.wasOpened ? 0 : 2) + (a.wasCited ? 1 : 0);
      const prioB = (b.wasOpened ? 0 : 2) + (b.wasCited ? 1 : 0);
      if (prioA !== prioB) return prioA - prioB;
      return a._order - b._order;
    });

    return entries
      .slice(0, MAX_RETRIEVED_SOURCES_PER_OBSERVATION)
      .map(({ _order: _, ...rest }) => rest);
  } catch {
    return [];
  }
}
