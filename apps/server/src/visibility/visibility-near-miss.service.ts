import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AUTH_ERROR,
  CITATION_SOURCE_PRIORITY,
  classifyCitationSource,
  normalizeVisibilityDomain,
  type CitationSourceKind,
  type NearMissItemDto,
  type NearMissListResponse,
  type NearMissTier,
  type ParsedNearMissQuery,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';
import {
  higherPrioritySourceKind,
  isEffectiveBrandMention,
  mergeProductLineBrandAliases,
  resolveEffectiveVisibilityCompetitors,
  shanghaiWindowFromQuery,
} from './visibility.mapper';

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'spm',
  'from',
  'ref',
]);

const TIER_BASE_SCORE: Record<NearMissTier, number> = {
  OPENED_NOT_CITED: 68,
  CRAWLED_NOT_CITED: 58,
  RETRIEVED_NOT_CITED: 52,
  MENTIONED_NOT_OWNED: 48,
};

const SOURCE_KIND_BOOST: Record<CitationSourceKind, number> = {
  OWNED: 15,
  COMPETITOR: 6,
  AUTHORITY: 4,
  SOCIAL: 2,
  ECOMMERCE: 2,
  OTHER: 0,
};

const MAX_PROMPTS_PER_ITEM = 10;
const MAX_OBSERVATION_IDS_PER_ITEM = 50;

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

function normalizePromptKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableNearMissId(tier: NearMissTier, dedupKey: string): string {
  const hash = createHash('sha256').update(`${tier}::${dedupKey}`).digest('hex').slice(0, 16);
  return `nm_${tier.toLowerCase()}_${hash}`;
}

const NON_CONTENT_PATH_PATTERNS: readonly RegExp[] = [
  /^\/dev\/api(?:\/|$)/i,
  /^\/oauth(?:2)?(?:\/|$)/i,
  /^\/(?:login|signin|sign-in|signup|sign-up|logout|register)(?:\/|$)/i,
  /^\/robots\.txt$/i,
  /^\/sitemap(?:[_-][^/]*)?\.xml$/i,
  /^\/\.well-known(?:\/|$)/i,
];

export function isNonContentNearMissUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return NON_CONTENT_PATH_PATTERNS.some((re) => re.test(pathname));
  } catch {
    return false;
  }
}

export function canonicalizeNearMissUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const isDefaultPort =
      !parsed.port ||
      (protocol === 'http:' && parsed.port === '80') ||
      (protocol === 'https:' && parsed.port === '443');
    const hostWithPort = isDefaultPort ? host : `${host}:${parsed.port}`;

    parsed.hash = '';
    const toDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();

    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const searchStr = parsed.searchParams.toString();
    const search = searchStr ? `?${searchStr}` : '';
    if (protocol === 'http:' || protocol === 'https:') {
      return `${hostWithPort}${pathname}${search}`;
    }
    return `${protocol}//${hostWithPort}${pathname}${search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function cleanDisplayNearMissUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const toDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function preferDisplayNearMissUrl(current: string, candidate: string): string {
  if (!current) return candidate;
  if (!candidate) return current;
  const currentIsHttps = current.toLowerCase().startsWith('https://');
  const candidateIsHttps = candidate.toLowerCase().startsWith('https://');
  if (!currentIsHttps && candidateIsHttps) {
    return candidate;
  }
  return current;
}

export type NearMissScoreInput = {
  tier: NearMissTier;
  sourceKind: CitationSourceKind;
  engineCount: number;
  openedCount?: number;
  retrievedCount?: number;
  completedRetestCount?: number;
  observationCount?: number;
  lastSeenAtMs: number;
  nowMs?: number;
};

export function computeNearMissOpportunityScore(input: NearMissScoreInput): number {
  const base = TIER_BASE_SCORE[input.tier];
  const sourceBoost = SOURCE_KIND_BOOST[input.sourceKind] ?? 0;
  const engineBoost = Math.min(8, Math.max(0, input.engineCount - 1) * 4);

  let repeatBoost = 0;
  switch (input.tier) {
    case 'OPENED_NOT_CITED': {
      const opened = Math.max(0, input.openedCount ?? 0);
      const retrieved = Math.max(opened, input.retrievedCount ?? opened);
      repeatBoost = Math.min(7, Math.max(0, opened - 1) * 3 + Math.min(2, retrieved - opened));
      break;
    }
    case 'RETRIEVED_NOT_CITED': {
      const retrieved = Math.max(0, input.retrievedCount ?? 0);
      repeatBoost = Math.min(7, Math.max(0, retrieved - 1) * 2);
      break;
    }
    case 'CRAWLED_NOT_CITED': {
      const retests = Math.max(0, input.completedRetestCount ?? 1);
      repeatBoost = Math.min(7, Math.max(0, retests - 1) * 3);
      break;
    }
    case 'MENTIONED_NOT_OWNED': {
      const obsCount = Math.max(0, input.observationCount ?? 1);
      repeatBoost = Math.min(7, Math.max(0, obsCount - 1) * 2);
      break;
    }
  }

  const nowMs = input.nowMs ?? Date.now();
  const ageDays = Math.max(0, (nowMs - input.lastSeenAtMs) / 86_400_000);
  const recencyBoost = ageDays <= 7 ? 5 : ageDays <= 14 ? 2 : 0;

  return Math.min(
    100,
    Math.max(1, Math.round(base + sourceBoost + engineBoost + repeatBoost + recencyBoost)),
  );
}

type ParsedRetestSnapshot = {
  mentionRate: number;
  citationHit: boolean;
};

function parseRetestSnapshot(raw: unknown): ParsedRetestSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.mentionRate === 'number' &&
    Number.isFinite(obj.mentionRate) &&
    typeof obj.citationHit === 'boolean'
  ) {
    return {
      mentionRate: obj.mentionRate,
      citationHit: obj.citationHit,
    };
  }
  return null;
}

function sourceKindPriorityRank(kind: CitationSourceKind): number {
  const idx = CITATION_SOURCE_PRIORITY.indexOf(kind);
  return idx >= 0 ? idx : CITATION_SOURCE_PRIORITY.length;
}

function appendPrompt(
  target: string[],
  seenLower: Set<string>,
  rawPrompt: string | null | undefined,
): void {
  if (!rawPrompt) return;
  const cleaned = rawPrompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  const key = cleaned.toLowerCase();
  if (seenLower.has(key) || target.length >= MAX_PROMPTS_PER_ITEM) return;
  seenLower.add(key);
  target.push(cleaned);
}

@Injectable()
export class VisibilityNearMissService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  private async resolveBrandOwnedDomains(
    brandId: string,
    currentDomains: readonly string[],
  ): Promise<string[]> {
    const findMany = this.prisma.scoped.brandMarket?.findMany;
    const raw =
      typeof findMany === 'function'
        ? [
            ...currentDomains,
            ...(
              await findMany({
                where: { brandId },
                select: { ownedDomains: true },
              })
            ).flatMap((m) => m.ownedDomains ?? []),
          ]
        : [...currentDomains];
    return Array.from(new Set(raw.map((dom) => normalizeVisibilityDomain(dom)).filter(Boolean)));
  }

  async listNearMiss(brandId: string, query: ParsedNearMissQuery): Promise<NearMissListResponse> {
    this.assertFeatureEnabled();
    requireTenant();

    const { brand, market } = await this.brands.resolveBrandMarket(brandId, query.market);
    const productLine =
      query.productLineId && typeof this.prisma.scoped.brandProductLine?.findFirst === 'function'
        ? await this.prisma.scoped.brandProductLine.findFirst({
            where: { id: query.productLineId, brandId: brand.id },
            select: { id: true, name: true, localNamesJson: true, competitorsJson: true },
          })
        : null;
    const ownedDomains = await this.resolveBrandOwnedDomains(brand.id, market.ownedDomains ?? []);
    const competitors = resolveEffectiveVisibilityCompetitors(
      market.competitors,
      productLine,
      market.market,
    );
    const brandAliases = mergeProductLineBrandAliases(
      market.aliases ?? [],
      productLine,
      market.market,
    );
    const competitorDomains = competitors.flatMap((c) => c.domains ?? []);
    const competitorNames = competitors.map((c) => c.name);
    const window = shanghaiWindowFromQuery({ days: query.days });
    const nowMs = Date.now();

    const retrievedDelegate = this.prisma.scoped.visibilityRetrievedSource;
    const publishDelegate = this.prisma.scoped.geoPublishRecord;

    const [rawSignalCount, uncitedRetrievedRows, publishRecords, mentionedObservations] =
      await Promise.all([
        typeof retrievedDelegate?.count === 'function'
          ? retrievedDelegate.count({
              where: {
                brandId: brand.id,
                brandMarketId: market.id,
                ...(query.productLineId
                  ? { observation: { run: { productLineId: query.productLineId } } }
                  : {}),
                createdAt: { gte: window.startUtc, lte: window.endUtc },
              },
            })
          : Promise.resolve(-1),
        typeof retrievedDelegate?.findMany === 'function'
          ? retrievedDelegate.findMany({
              where: {
                brandId: brand.id,
                brandMarketId: market.id,
                wasCited: false,
                ...(query.productLineId
                  ? { observation: { run: { productLineId: query.productLineId } } }
                  : {}),
                createdAt: { gte: window.startUtc, lte: window.endUtc },
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 2000,
              select: {
                id: true,
                observationId: true,
                engine: true,
                url: true,
                domain: true,
                title: true,
                snippet: true,
                sourceKind: true,
                wasOpened: true,
                wasCited: true,
                rank: true,
                createdAt: true,
                observation: {
                  select: {
                    id: true,
                    promptText: true,
                    engine: true,
                    status: true,
                    checkedAt: true,
                    createdAt: true,
                  },
                },
              },
            })
          : Promise.resolve([]),
        typeof publishDelegate?.findMany === 'function'
          ? publishDelegate.findMany({
              where: {
                brandId: brand.id,
                brandMarketId: market.id,
                crawlStatus: 'OK',
                ...(query.productLineId ? { article: { productLineId: query.productLineId } } : {}),
              },
              include: {
                article: {
                  select: {
                    id: true,
                    title: true,
                    targetPrompt: true,
                  },
                },
                retestSchedules: {
                  where: { status: 'COMPLETED' },
                  orderBy: [
                    { executedAt: { sort: 'desc', nulls: 'last' } },
                    { milestoneDay: 'desc' },
                    { dueAt: 'desc' },
                    { id: 'desc' },
                  ],
                },
              },
              orderBy: [{ updatedAt: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
              take: 500,
            })
          : Promise.resolve([]),
        this.prisma.scoped.visibilityObservation.findMany({
          where: {
            brandId: brand.id,
            brandMarketId: market.id,
            status: 'SUCCESS',
            brandMentioned: true,
            ...(query.productLineId ? { run: { productLineId: query.productLineId } } : {}),
            OR: [
              { checkedAt: { gte: window.startUtc, lte: window.endUtc } },
              { checkedAt: null, createdAt: { gte: window.startUtc, lte: window.endUtc } },
            ],
          },
          orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: 2000,
          select: {
            id: true,
            brandMarketId: true,
            promptText: true,
            answerText: true,
            engine: true,
            brandMentioned: true,
            brandPassage: true,
            checkedAt: true,
            createdAt: true,
            citations: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                url: true,
                domain: true,
                title: true,
                snippet: true,
                sourceKind: true,
                position: true,
              },
            },
          },
        }),
      ]);

    const hasRawRetrievalSignals =
      rawSignalCount >= 0 ? rawSignalCount > 0 : uncitedRetrievedRows.length > 0;

    // ===================== Tier 1 & Tier 2 (shared canonical-URL map) =====================
    type RetrievedBucket = {
      canonicalUrl: string;
      url: string;
      domain: string | null;
      title: string | null;
      snippet: string | null;
      titleFromOpened: boolean;
      snippetFromOpened: boolean;
      sourceKind: CitationSourceKind;
      engines: Set<string>;
      prompts: string[];
      promptKeys: Set<string>;
      observationIds: Set<string>;
      openedCount: number;
      retrievedCount: number;
      lastSeenAtMs: number;
    };

    const retrievedBuckets = new Map<string, RetrievedBucket>();

    for (const row of uncitedRetrievedRows) {
      if (row.wasCited) continue;
      if (row.observation && row.observation.status !== 'SUCCESS') continue;
      if (isNonContentNearMissUrl(row.url)) continue;

      const canonicalUrl = canonicalizeNearMissUrl(row.url);
      if (!canonicalUrl) continue;

      const domain = normalizeVisibilityDomain(row.domain || row.url) || null;
      const resolvedKind = classifyCitationSource(row.url || domain || '', {
        ownedDomains,
        competitorDomains,
      });
      const seenMs = (row.observation?.checkedAt ?? row.createdAt).getTime();
      const rowEngine = (row.engine || row.observation?.engine || '').trim();
      const rowTitle = row.title?.trim() || null;
      const rowSnippet = row.snippet?.trim() || null;

      const displayUrl = cleanDisplayNearMissUrl(row.url) || row.url;

      let bucket = retrievedBuckets.get(canonicalUrl);
      if (!bucket) {
        bucket = {
          canonicalUrl,
          url: displayUrl,
          domain,
          title: rowTitle,
          snippet: rowSnippet,
          titleFromOpened: Boolean(rowTitle && row.wasOpened),
          snippetFromOpened: Boolean(rowSnippet && row.wasOpened),
          sourceKind: resolvedKind,
          engines: new Set<string>(),
          prompts: [],
          promptKeys: new Set<string>(),
          observationIds: new Set<string>(),
          openedCount: 0,
          retrievedCount: 0,
          lastSeenAtMs: seenMs,
        };
        retrievedBuckets.set(canonicalUrl, bucket);
      } else {
        bucket.url = preferDisplayNearMissUrl(bucket.url, displayUrl);
        bucket.sourceKind = higherPrioritySourceKind(bucket.sourceKind, resolvedKind);
        if (!bucket.domain && domain) bucket.domain = domain;
        if (rowTitle && (!bucket.title || (row.wasOpened && !bucket.titleFromOpened))) {
          bucket.title = rowTitle;
          bucket.titleFromOpened = row.wasOpened;
        }
        if (rowSnippet && (!bucket.snippet || (row.wasOpened && !bucket.snippetFromOpened))) {
          bucket.snippet = rowSnippet;
          bucket.snippetFromOpened = row.wasOpened;
        }
        if (seenMs > bucket.lastSeenAtMs) {
          bucket.lastSeenAtMs = seenMs;
        }
      }

      bucket.retrievedCount += 1;
      if (row.wasOpened) {
        bucket.openedCount += 1;
      }
      if (rowEngine) {
        bucket.engines.add(rowEngine);
      }
      appendPrompt(bucket.prompts, bucket.promptKeys, row.observation?.promptText);
      if (row.observationId && bucket.observationIds.size < MAX_OBSERVATION_IDS_PER_ITEM) {
        bucket.observationIds.add(row.observationId);
      }
    }

    const tier12Items: NearMissItemDto[] = [];
    for (const bucket of retrievedBuckets.values()) {
      const tier: NearMissTier =
        bucket.openedCount > 0 ? 'OPENED_NOT_CITED' : 'RETRIEVED_NOT_CITED';
      const engines = [...bucket.engines].sort();
      const opportunityScore = computeNearMissOpportunityScore({
        tier,
        sourceKind: bucket.sourceKind,
        engineCount: engines.length,
        openedCount: bucket.openedCount,
        retrievedCount: bucket.retrievedCount,
        lastSeenAtMs: bucket.lastSeenAtMs,
        nowMs,
      });

      tier12Items.push({
        id: stableNearMissId(tier, bucket.canonicalUrl),
        tier,
        opportunityScore,
        url: bucket.url,
        domain: bucket.domain,
        title: bucket.title,
        snippet: bucket.snippet,
        sourceKind: bucket.sourceKind,
        isOwned: bucket.sourceKind === 'OWNED',
        engines,
        prompts: bucket.prompts,
        observationIds: [...bucket.observationIds],
        openedCount: bucket.openedCount,
        retrievedCount: bucket.retrievedCount,
        publishRecordId: null,
        lastSeenAt: new Date(bucket.lastSeenAtMs).toISOString(),
      });
    }

    // ===================== Tier 3A: CRAWLED_NOT_CITED =====================
    type Tier3ACandidate = {
      record: (typeof publishRecords)[number];
      completedRetestCount: number;
      lastSeenAtMs: number;
      runId: string | null;
    };

    const tier3ACandidates: Tier3ACandidate[] = [];
    const tier3ARunIds = new Set<string>();

    for (const record of publishRecords) {
      if (record.crawlStatus !== 'OK') continue;

      const completedSchedules = (record.retestSchedules ?? []).filter(
        (sched) => sched.status === 'COMPLETED',
      );
      if (completedSchedules.length === 0) continue;

      const afterMetricsSnapshot = parseRetestSnapshot(record.afterMetrics);
      if (afterMetricsSnapshot?.citationHit) continue;

      // Deterministic in-memory ordering avoids PostgreSQL `executedAt DESC NULLS FIRST` hazards
      const sortedSchedules = [...completedSchedules].sort((a, b) => {
        const aExec = a.executedAt instanceof Date ? a.executedAt.getTime() : null;
        const bExec = b.executedAt instanceof Date ? b.executedAt.getTime() : null;
        if (aExec !== null && bExec === null) return -1;
        if (aExec === null && bExec !== null) return 1;
        if (aExec !== null && bExec !== null && bExec !== aExec) return bExec - aExec;
        if (b.milestoneDay !== a.milestoneDay) return b.milestoneDay - a.milestoneDay;
        const aDue = a.dueAt instanceof Date ? a.dueAt.getTime() : 0;
        const bDue = b.dueAt instanceof Date ? b.dueAt.getTime() : 0;
        if (bDue !== aDue) return bDue - aDue;
        return b.id.localeCompare(a.id);
      });

      let anyScheduleCited = false;
      let latestSnapshot: ParsedRetestSnapshot | null = null;
      let latestSchedule: (typeof sortedSchedules)[number] | undefined;

      for (const sched of sortedSchedules) {
        const parsed = parseRetestSnapshot(sched.metricsSnapshotJson);
        if (!parsed) continue;
        if (parsed.citationHit) {
          anyScheduleCited = true;
          break;
        }
        if (!latestSnapshot) {
          latestSnapshot = parsed;
          latestSchedule = sched;
        }
      }

      if (anyScheduleCited) continue;

      if (!latestSnapshot && afterMetricsSnapshot) {
        latestSnapshot = afterMetricsSnapshot;
        latestSchedule = sortedSchedules[0];
      }

      if (!latestSnapshot || latestSnapshot.citationHit) continue;

      const lastSeenDate =
        latestSchedule?.executedAt ??
        record.crawlCheckedAt ??
        record.updatedAt ??
        record.publishedAt;
      const lastSeenAtMs = lastSeenDate.getTime();
      if (lastSeenAtMs < window.startUtc.getTime() || lastSeenAtMs > window.endUtc.getTime()) {
        continue;
      }

      const runId = latestSchedule?.visibilityRunId ?? record.latestRetestRunId ?? null;
      if (runId) tier3ARunIds.add(runId);

      tier3ACandidates.push({
        record,
        completedRetestCount: completedSchedules.length,
        lastSeenAtMs,
        runId,
      });
    }

    const runEnginesMap = new Map<string, string[]>();
    if (tier3ARunIds.size > 0 && typeof this.prisma.scoped.visibilityRun?.findMany === 'function') {
      const linkedRuns = await this.prisma.scoped.visibilityRun.findMany({
        where: { id: { in: [...tier3ARunIds] } },
        select: { id: true, engines: true },
      });
      for (const run of linkedRuns) {
        runEnginesMap.set(run.id, run.engines ?? []);
      }
    }

    type Tier3ABucket = {
      dedupKey: string;
      url: string;
      domain: string | null;
      title: string | null;
      snippet: string | null;
      sourceKind: CitationSourceKind;
      engines: Set<string>;
      prompts: string[];
      promptKeys: Set<string>;
      publishRecordId: string;
      completedRetestCount: number;
      lastSeenAtMs: number;
    };

    const tier3ABuckets = new Map<string, Tier3ABucket>();
    for (const candidate of tier3ACandidates) {
      const { record, completedRetestCount, lastSeenAtMs, runId } = candidate;
      const dedupKey = canonicalizeNearMissUrl(record.publishedUrl) || `publish:${record.id}`;
      const domain = normalizeVisibilityDomain(record.publishedUrl) || null;
      const resolvedKind = classifyCitationSource(record.publishedUrl, {
        ownedDomains,
        competitorDomains,
      });
      const snippet = `已发布至 ${record.channel}（T+1 抓取正常），已完成 ${completedRetestCount} 次复测暂未进入引文`;
      const linkedEngines = runId ? (runEnginesMap.get(runId) ?? []) : [];

      const displayUrl = cleanDisplayNearMissUrl(record.publishedUrl) || record.publishedUrl;

      let bucket = tier3ABuckets.get(dedupKey);
      if (!bucket) {
        bucket = {
          dedupKey,
          url: displayUrl,
          domain,
          title: record.article?.title?.trim() || null,
          snippet,
          sourceKind: resolvedKind,
          engines: new Set<string>(),
          prompts: [],
          promptKeys: new Set<string>(),
          publishRecordId: record.id,
          completedRetestCount,
          lastSeenAtMs,
        };
        tier3ABuckets.set(dedupKey, bucket);
      } else {
        bucket.url = preferDisplayNearMissUrl(bucket.url, displayUrl);
        bucket.sourceKind = higherPrioritySourceKind(bucket.sourceKind, resolvedKind);
        bucket.completedRetestCount = Math.max(bucket.completedRetestCount, completedRetestCount);
        if (lastSeenAtMs > bucket.lastSeenAtMs) {
          bucket.lastSeenAtMs = lastSeenAtMs;
          bucket.publishRecordId = record.id;
          bucket.snippet = snippet;
          if (record.article?.title?.trim()) {
            bucket.title = record.article.title.trim();
          }
        }
      }

      for (const eng of linkedEngines) {
        if (eng.trim()) bucket.engines.add(eng.trim());
      }
      appendPrompt(bucket.prompts, bucket.promptKeys, record.article?.targetPrompt);
    }

    const tier3AItems: NearMissItemDto[] = [];
    for (const bucket of tier3ABuckets.values()) {
      const engines = [...bucket.engines].sort();
      const opportunityScore = computeNearMissOpportunityScore({
        tier: 'CRAWLED_NOT_CITED',
        sourceKind: bucket.sourceKind,
        engineCount: engines.length,
        completedRetestCount: bucket.completedRetestCount,
        lastSeenAtMs: bucket.lastSeenAtMs,
        nowMs,
      });

      tier3AItems.push({
        id: stableNearMissId('CRAWLED_NOT_CITED', bucket.dedupKey),
        tier: 'CRAWLED_NOT_CITED',
        opportunityScore,
        url: bucket.url,
        domain: bucket.domain,
        title: bucket.title,
        snippet: bucket.snippet,
        sourceKind: bucket.sourceKind,
        isOwned: bucket.sourceKind === 'OWNED',
        engines,
        prompts: bucket.prompts,
        observationIds: [],
        openedCount: 0,
        retrievedCount: 0,
        publishRecordId: bucket.publishRecordId,
        lastSeenAt: new Date(bucket.lastSeenAtMs).toISOString(),
      });
    }

    // ===================== Tier 3B: MENTIONED_NOT_OWNED =====================
    type NonOwnedCiteAgg = {
      url: string;
      domain: string | null;
      title: string | null;
      snippet: string | null;
      sourceKind: CitationSourceKind;
      count: number;
      bestPosition: number;
    };

    type Tier3BBucket = {
      promptKey: string;
      promptText: string;
      ownedCitationCount: number;
      nonOwnedCitations: Map<string, NonOwnedCiteAgg>;
      engines: Set<string>;
      observationIds: Set<string>;
      latestPassage: string | null;
      lastSeenAtMs: number;
    };

    const tier3BBuckets = new Map<string, Tier3BBucket>();

    for (const obs of mentionedObservations) {
      const promptText = obs.promptText.replace(/\s+/g, ' ').trim();
      if (!promptText) continue;

      if (
        !isEffectiveBrandMention(obs, {
          brandName: market.localBrandName,
          brandAliases,
          competitorNames,
        })
      ) {
        continue;
      }

      const promptKey = normalizePromptKey(promptText);
      const seenMs = (obs.checkedAt ?? obs.createdAt).getTime();

      let bucket = tier3BBuckets.get(promptKey);
      if (!bucket) {
        bucket = {
          promptKey,
          promptText,
          ownedCitationCount: 0,
          nonOwnedCitations: new Map<string, NonOwnedCiteAgg>(),
          engines: new Set<string>(),
          observationIds: new Set<string>(),
          latestPassage: obs.brandPassage?.trim() || null,
          lastSeenAtMs: seenMs,
        };
        tier3BBuckets.set(promptKey, bucket);
      } else if (seenMs > bucket.lastSeenAtMs) {
        bucket.lastSeenAtMs = seenMs;
        if (obs.brandPassage?.trim()) {
          bucket.latestPassage = obs.brandPassage.trim();
        }
      }

      if (obs.engine?.trim()) bucket.engines.add(obs.engine.trim());
      if (obs.id && bucket.observationIds.size < MAX_OBSERVATION_IDS_PER_ITEM) {
        bucket.observationIds.add(obs.id);
      }

      for (const cite of obs.citations ?? []) {
        const resolvedKind = classifyCitationSource(cite.url || cite.domain, {
          ownedDomains,
          competitorDomains,
        });
        if (resolvedKind === 'OWNED') {
          bucket.ownedCitationCount += 1;
          continue;
        }
        const citeKey = canonicalizeNearMissUrl(cite.url) || cite.url;
        const domain = normalizeVisibilityDomain(cite.domain || cite.url) || null;
        const pos = typeof cite.position === 'number' && cite.position > 0 ? cite.position : 999;

        const citeDisplayUrl = cleanDisplayNearMissUrl(cite.url) || cite.url;
        const existing = bucket.nonOwnedCitations.get(citeKey);
        if (!existing) {
          bucket.nonOwnedCitations.set(citeKey, {
            url: citeDisplayUrl,
            domain,
            title: cite.title?.trim() || null,
            snippet: cite.snippet?.trim() || null,
            sourceKind: resolvedKind,
            count: 1,
            bestPosition: pos,
          });
        } else {
          existing.url = preferDisplayNearMissUrl(existing.url, citeDisplayUrl);
          existing.count += 1;
          existing.sourceKind = higherPrioritySourceKind(existing.sourceKind, resolvedKind);
          if (pos < existing.bestPosition) existing.bestPosition = pos;
          if (!existing.title && cite.title?.trim()) existing.title = cite.title.trim();
          if (!existing.snippet && cite.snippet?.trim()) existing.snippet = cite.snippet.trim();
        }
      }
    }

    const tier3BItems: NearMissItemDto[] = [];
    for (const bucket of tier3BBuckets.values()) {
      if (bucket.ownedCitationCount > 0 || bucket.nonOwnedCitations.size === 0) {
        continue;
      }

      const sortedCites = [...bucket.nonOwnedCitations.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const prioDiff =
          sourceKindPriorityRank(a.sourceKind) - sourceKindPriorityRank(b.sourceKind);
        if (prioDiff !== 0) return prioDiff;
        if (a.bestPosition !== b.bestPosition) return a.bestPosition - b.bestPosition;
        return a.url.localeCompare(b.url);
      });

      const topCite = sortedCites[0]!;
      const engines = [...bucket.engines].sort();
      const opportunityScore = computeNearMissOpportunityScore({
        tier: 'MENTIONED_NOT_OWNED',
        sourceKind: topCite.sourceKind,
        engineCount: engines.length,
        observationCount: bucket.observationIds.size,
        lastSeenAtMs: bucket.lastSeenAtMs,
        nowMs,
      });

      tier3BItems.push({
        id: stableNearMissId('MENTIONED_NOT_OWNED', bucket.promptKey),
        tier: 'MENTIONED_NOT_OWNED',
        opportunityScore,
        url: topCite.url,
        domain: topCite.domain,
        title: topCite.title ?? bucket.promptText,
        snippet: topCite.snippet ?? bucket.latestPassage ?? null,
        sourceKind: topCite.sourceKind,
        isOwned: false,
        engines,
        prompts: [bucket.promptText],
        observationIds: [...bucket.observationIds],
        openedCount: 0,
        retrievedCount: 0,
        publishRecordId: null,
        lastSeenAt: new Date(bucket.lastSeenAtMs).toISOString(),
      });
    }

    // ===================== Combine, Filter, Count, Sort & Slice =====================
    const allItems: NearMissItemDto[] = [...tier12Items, ...tier3AItems, ...tier3BItems];
    const afterSourceFilter = query.sourceKind
      ? allItems.filter((item) => item.sourceKind === query.sourceKind)
      : allItems;

    const tierCounts: Record<NearMissTier, number> = {
      OPENED_NOT_CITED: 0,
      RETRIEVED_NOT_CITED: 0,
      CRAWLED_NOT_CITED: 0,
      MENTIONED_NOT_OWNED: 0,
    };
    for (const item of afterSourceFilter) {
      tierCounts[item.tier] += 1;
    }

    const filtered = query.tier
      ? afterSourceFilter.filter((item) => item.tier === query.tier)
      : afterSourceFilter;

    filtered.sort((a, b) => {
      if (b.opportunityScore !== a.opportunityScore) {
        return b.opportunityScore - a.opportunityScore;
      }
      if (b.lastSeenAt !== a.lastSeenAt) {
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      }
      return a.id.localeCompare(b.id);
    });

    return {
      brandId: brand.id,
      market: market.market,
      days: query.days,
      total: filtered.length,
      tierCounts,
      hasRawRetrievalSignals,
      items: filtered.slice(0, query.limit),
    };
  }
}
