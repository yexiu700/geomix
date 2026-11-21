import { createHash } from 'node:crypto';
import {
  CITATION_SOURCE_PRIORITY,
  VISIBILITY_MAX_COMPETITORS,
  assessAnswerTopicRelevance,
  classifyCitationSource,
  computeAvgPosition,
  computeSentimentSummary,
  computeVisibilityPct,
  isCitationSourceKind,
  isVisibilityEngine,
  isVisibilitySentiment,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  recomputeRunMetrics,
  toShanghaiDateKey,
  type CitationSourceKind,
  type CompetitorHit,
  type DomainMetricItem,
  type GeoMarket,
  type ItemStatusName,
  type ProfileForMetrics,
  type RawObservationForMetrics,
  type RecomputedRunMetrics,
  type ShareOfVoiceEntry,
  type TaskStatusName,
  type VisibilityBrandShareOfVoiceGroup,
  type VisibilityCitationRecord,
  type VisibilityCompetitor,
  type VisibilityEngineBreakdownItem,
  type VisibilityEngineKey,
  type VisibilityObservationRecord,
  type VisibilityRunRecord,
  type VisibilitySentiment,
  type VisibilityTrendPoint,
} from '@geomix/shared';

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function deriveVisibilityRunId(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}::visibility_run::${idempotencyKey}`)
    .digest('hex')
    .slice(0, 28);
  return `vrun_${digest}`;
}

export function dedupeStringsCaseInsensitive(
  items: readonly string[],
  excludeLower?: string,
): string[] {
  const seen = new Set<string>();
  if (excludeLower) seen.add(excludeLower.toLowerCase());
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function normalizeOwnedDomainsList(domains: readonly string[], limit = 20): string[] {
  return [...new Set(domains.map((dom) => normalizeVisibilityDomain(dom)).filter(Boolean))].slice(
    0,
    limit,
  );
}

export function normalizeCompetitorsList(
  raw: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    domains?: readonly string[];
  }>,
): VisibilityCompetitor[] {
  const seenNames = new Set<string>();
  const out: VisibilityCompetitor[] = [];
  for (const comp of raw) {
    if (out.length >= VISIBILITY_MAX_COMPETITORS) break;
    const name = comp.name.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const aliases = dedupeStringsCaseInsensitive(comp.aliases ?? [], name).slice(0, 20);
    const domains = normalizeOwnedDomainsList(comp.domains ?? [], 20);
    out.push({ name, aliases, domains });
  }
  return out;
}

export function parseProfileCompetitors(raw: unknown): VisibilityCompetitor[] {
  if (!Array.isArray(raw)) return [];
  const out: VisibilityCompetitor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const aliases = Array.isArray(rec.aliases)
      ? rec.aliases
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    const domains = Array.isArray(rec.domains)
      ? rec.domains
          .filter((d): d is string => typeof d === 'string')
          .map((d) => normalizeVisibilityDomain(d))
          .filter(Boolean)
      : [];
    out.push({ name, aliases, domains });
  }
  return out;
}

export function parseStoredCompetitorHits(raw: unknown): CompetitorHit[] {
  if (!Array.isArray(raw)) return [];
  const out: CompetitorHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string') continue;
    out.push({
      name: obj.name,
      mentioned: Boolean(obj.mentioned),
      position:
        typeof obj.position === 'number' && Number.isFinite(obj.position) && obj.position >= 1
          ? obj.position
          : null,
      sentiment:
        typeof obj.sentiment === 'string' && isVisibilitySentiment(obj.sentiment)
          ? obj.sentiment
          : null,
    });
  }
  return out;
}

export type ShanghaiTimeWindow = { keys: string[]; startUtc: Date; endUtc: Date };

export function shanghaiWindowFromQuery(input: {
  days: number;
  from?: string;
  to?: string;
  now?: Date;
}): ShanghaiTimeWindow {
  const now = input.now ?? new Date();
  if (input.from || input.to) {
    const endUtc = input.to ? new Date(input.to) : now;
    const startUtc = input.from
      ? new Date(input.from)
      : new Date(endUtc.getTime() - Math.max(1, input.days - 1) * DAY_MS);

    const keys: string[] = [];
    const safeStart = startUtc.getTime() <= endUtc.getTime() ? startUtc : endUtc;
    const safeEnd = startUtc.getTime() <= endUtc.getTime() ? endUtc : startUtc;
    const startShifted = new Date(safeStart.getTime() + SHANGHAI_OFFSET_MS);
    const endShifted = new Date(safeEnd.getTime() + SHANGHAI_OFFSET_MS);
    let cursorMs = Date.UTC(
      startShifted.getUTCFullYear(),
      startShifted.getUTCMonth(),
      startShifted.getUTCDate(),
    );
    const lastMs = Date.UTC(
      endShifted.getUTCFullYear(),
      endShifted.getUTCMonth(),
      endShifted.getUTCDate(),
    );
    while (cursorMs <= lastMs && keys.length < 366) {
      const d = new Date(cursorMs);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      keys.push(`${y}-${m}-${day}`);
      cursorMs += DAY_MS;
    }
    return { keys, startUtc: safeStart, endUtc: safeEnd };
  }

  const safeDays = Math.min(365, Math.max(1, Math.floor(input.days)));
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const todayMidnightShanghaiAsUtcMs =
    Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) -
    SHANGHAI_OFFSET_MS;

  const startUtcMs = todayMidnightShanghaiAsUtcMs - (safeDays - 1) * DAY_MS;
  const endUtcMs = todayMidnightShanghaiAsUtcMs + DAY_MS - 1;

  const keys: string[] = [];
  for (let i = 0; i < safeDays; i += 1) {
    keys.push(toShanghaiDateKey(new Date(startUtcMs + i * DAY_MS)));
  }

  return { keys, startUtc: new Date(startUtcMs), endUtc: new Date(endUtcMs) };
}

export type RelevanceBrandContext = {
  brandName: string;
  brandAliases?: readonly string[];
  competitorNames?: readonly string[];
};

export function evaluateObservationRelevance(
  obs: { status?: string; promptText?: string | null; answerText?: string | null },
  ctx: RelevanceBrandContext,
): { relevant: boolean; reason: string | null } {
  if (
    (obs.status !== undefined && obs.status !== 'SUCCESS') ||
    !obs.promptText ||
    !obs.answerText
  ) {
    return { relevant: true, reason: null };
  }
  const result = assessAnswerTopicRelevance(obs.promptText, obs.answerText, {
    brandName: ctx.brandName,
    brandAliases: ctx.brandAliases,
    competitorNames: ctx.competitorNames,
  });
  return { relevant: result.relevant, reason: result.reason };
}

export function isEffectiveBrandMention(
  obs: {
    status?: string;
    brandMentioned: boolean;
    promptText?: string | null;
    answerText?: string | null;
  },
  ctx: RelevanceBrandContext,
): boolean {
  if ((obs.status !== undefined && obs.status !== 'SUCCESS') || !obs.brandMentioned) {
    return false;
  }
  return evaluateObservationRelevance(obs, ctx).relevant;
}

export type ReservationPointsSnapshot = { frozen: number; settled: number; released: number };

export type RunRowForMapper = {
  id: string;
  brandId: string;
  brandMarketId: string;
  name: string;
  engines: string[];
  prompts: string[];
  triggerType?: 'MANUAL' | 'RETEST';
  retestArticleId?: string | null;
  briefsGeneratedAt?: Date | null;
  totalChecks: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: TaskStatusName;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  brandMarket: {
    id: string;
    market: 'CN' | 'GLOBAL';
    localBrandName: string;
    aliases: string[];
    competitors: unknown;
    brand: { name: string };
  };
  observations: ReadonlyArray<{
    status: string;
    brandMentioned: boolean;
    promptText: string | null;
    answerText: string | null;
  }>;
};

export function presentRunRecord(
  row: RunRowForMapper,
  reservation?: ReservationPointsSnapshot,
): VisibilityRunRecord {
  const competitorNames = parseProfileCompetitors(row.brandMarket.competitors).map((c) => c.name);
  const relevanceCtx: RelevanceBrandContext = {
    brandName: row.brandMarket.localBrandName,
    brandAliases: row.brandMarket.aliases ?? [],
    competitorNames,
  };
  const completedObs = row.observations.filter((obs) => obs.status === 'SUCCESS');
  const mentionedObs = completedObs.filter((obs) => isEffectiveBrandMention(obs, relevanceCtx));
  const skipCount = row.observations.filter((obs) => obs.status === 'SKIPPED').length;

  return {
    id: row.id,
    profileId: row.brandMarketId,
    profileName: `${row.brandMarket.brand.name} (${row.brandMarket.market})`,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market: row.brandMarket.market,
    brandName: row.brandMarket.localBrandName,
    keywordId: null,
    keywordMain: null,
    name: row.name,
    engines: row.engines.filter((e): e is VisibilityEngineKey => isVisibilityEngine(e)),
    prompts: row.prompts,
    questionIds: [],
    triggerType: row.triggerType,
    retestArticleId: row.retestArticleId ?? null,
    briefsGeneratedAt: row.briefsGeneratedAt ? row.briefsGeneratedAt.toISOString() : null,
    totalChecks: row.totalChecks,
    doneCount: row.doneCount,
    failCount: row.failCount,
    skipCount,
    unitPrice: row.unitPrice,
    frozenPoints: reservation?.frozen ?? row.totalChecks * row.unitPrice,
    settledPoints: reservation?.settled ?? 0,
    releasedPoints: reservation?.released ?? 0,
    reservationId: row.reservationId,
    status: row.status,
    lastError: row.lastError,
    visibilityPct: computeVisibilityPct(mentionedObs.length, completedObs.length),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export type CitationRowForMapper = {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  sourceKind: string;
  position: number;
  createdAt: Date;
};

export type ObservationRowForMapper = {
  id: string;
  runId: string;
  brandId: string;
  brandMarketId: string;
  promptText: string;
  engine: string;
  status: ItemStatusName;
  collectorKind: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  brandPassage: string | null;
  competitorHits: unknown;
  fanOutQueries: string[];
  judgeModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  checkedAt: Date | null;
  createdAt: Date;
  citations: readonly CitationRowForMapper[];
};

export type CitationClassificationContext = {
  ownedDomains?: readonly string[];
  competitorDomains?: readonly string[];
};

export function presentCitationRecord(
  cite: CitationRowForMapper,
  citationContext?: CitationClassificationContext,
): VisibilityCitationRecord {
  const sourceKind: CitationSourceKind = citationContext
    ? classifyCitationSource(cite.url || cite.domain, citationContext)
    : isCitationSourceKind(cite.sourceKind)
      ? cite.sourceKind
      : 'OTHER';

  return {
    id: cite.id,
    url: cite.url,
    domain: cite.domain,
    title: cite.title,
    snippet: cite.snippet,
    sourceKind,
    position: cite.position,
    createdAt: cite.createdAt.toISOString(),
  };
}

export function presentObservationRecord(
  obs: ObservationRowForMapper,
  ctx: RelevanceBrandContext,
  options?: {
    market?: GeoMarket;
    citationContext?: CitationClassificationContext;
  },
): VisibilityObservationRecord {
  const relevance = evaluateObservationRelevance(obs, ctx);
  const allowBrand = relevance.relevant;

  return {
    id: obs.id,
    runId: obs.runId,
    profileId: obs.brandMarketId,
    brandId: obs.brandId,
    brandMarketId: obs.brandMarketId,
    ...(options?.market ? { market: options.market } : {}),
    questionId: null,
    promptText: obs.promptText,
    engine: isVisibilityEngine(obs.engine) ? obs.engine : obs.engine,
    status: obs.status,
    collectorKind: obs.collectorKind,
    answerText: obs.answerText,
    brandMentioned: allowBrand ? obs.brandMentioned : false,
    brandPosition: allowBrand ? obs.brandPosition : null,
    brandSentiment:
      allowBrand && obs.brandSentiment && isVisibilitySentiment(obs.brandSentiment)
        ? obs.brandSentiment
        : null,
    brandPassage: allowBrand ? obs.brandPassage : null,
    topicRelevant: relevance.relevant,
    relevanceReason: relevance.reason,
    competitorHits: parseStoredCompetitorHits(obs.competitorHits),
    fanOutQueries: normalizeFanOutQueries(obs.fanOutQueries ?? [], obs.promptText),
    judgeModel: obs.judgeModel,
    tokensIn: obs.tokensIn,
    tokensOut: obs.tokensOut,
    error: obs.error,
    checkedAt: obs.checkedAt ? obs.checkedAt.toISOString() : null,
    createdAt: obs.createdAt.toISOString(),
    citations: obs.citations.map((cite) => presentCitationRecord(cite, options?.citationContext)),
  };
}

export type ProfileContext = {
  resolvedProfileId: string | null;
  profileForMetrics: ProfileForMetrics;
};

export type OverviewBrandEntry = {
  brandName: string;
  profileIds: string[];
  profileForMetrics: ProfileForMetrics;
};

export type OverviewProfileContext = {
  resolvedProfileId: string | null;
  profilesById: Map<string, ProfileForMetrics>;
  brandEntries: OverviewBrandEntry[];
  fallbackProfileForMetrics: ProfileForMetrics;
};

export type OverviewObservationRow = {
  id: string;
  brandMarketId: string;
  engine: string;
  status: string;
  promptText?: string | null;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  competitorHits: unknown;
  checkedAt: Date | null;
  createdAt: Date;
  citations: ReadonlyArray<{ url: string; domain: string; sourceKind: string }>;
};

export function toMetricObservation(obs: OverviewObservationRow): RawObservationForMetrics {
  return {
    id: obs.id,
    status: obs.status,
    promptText: obs.promptText,
    answerText: obs.answerText,
    brandMentioned: obs.brandMentioned,
    brandPosition: obs.brandPosition,
    brandSentiment: obs.brandSentiment,
    competitorHits: obs.competitorHits,
    citations: obs.citations.map(({ url, domain, sourceKind }) => ({ url, domain, sourceKind })),
  };
}

export function higherPrioritySourceKind(
  left: CitationSourceKind,
  right: CitationSourceKind,
): CitationSourceKind {
  const order: readonly CitationSourceKind[] = CITATION_SOURCE_PRIORITY;
  const leftIdx = order.indexOf(left);
  const rightIdx = order.indexOf(right);
  if (leftIdx < 0) return right;
  if (rightIdx < 0) return left;
  return leftIdx <= rightIdx ? left : right;
}

function roundOverviewPct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
}

function compareSovEntries(a: ShareOfVoiceEntry, b: ShareOfVoiceEntry): number {
  if (b.mentions !== a.mentions) return b.mentions - a.mentions;
  if (a.isBrand !== b.isBrand) return a.isBrand ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function computeOverviewMetricsAndGroups(
  observations: ReadonlyArray<OverviewObservationRow>,
  ctx: OverviewProfileContext,
): { metrics: RecomputedRunMetrics; brandGroups: VisibilityBrandShareOfVoiceGroup[] } {
  if (ctx.brandEntries.length === 0) {
    const metrics = recomputeRunMetrics(
      observations.map(toMetricObservation),
      ctx.fallbackProfileForMetrics,
    );
    return { metrics, brandGroups: [] };
  }

  if (ctx.brandEntries.length === 1) {
    const single = ctx.brandEntries[0]!;
    const metrics = recomputeRunMetrics(
      observations.map(toMetricObservation),
      single.profileForMetrics,
    );
    return {
      metrics,
      brandGroups: [
        {
          brandName: single.brandName,
          completedChecks: metrics.completedChecks,
          mentionedChecks: metrics.mentionedChecks,
          visibilityPct: metrics.visibilityPct,
          shareOfVoice: metrics.shareOfVoice,
        },
      ],
    };
  }

  const obsByProfileId = new Map<string, OverviewObservationRow[]>();
  const orphanObs: OverviewObservationRow[] = [];
  for (const obs of observations) {
    if (ctx.profilesById.has(obs.brandMarketId)) {
      const list = obsByProfileId.get(obs.brandMarketId);
      if (list) list.push(obs);
      else obsByProfileId.set(obs.brandMarketId, [obs]);
    } else {
      orphanObs.push(obs);
    }
  }

  const perProfileMetrics = new Map<string, RecomputedRunMetrics>();
  for (const [profId, profMetricsConfig] of ctx.profilesById.entries()) {
    const profObs = obsByProfileId.get(profId) ?? [];
    perProfileMetrics.set(
      profId,
      recomputeRunMetrics(profObs.map(toMetricObservation), profMetricsConfig),
    );
  }

  const brandGroups: VisibilityBrandShareOfVoiceGroup[] = ctx.brandEntries.map((entry) => {
    let completedChecks = 0;
    let mentionedChecks = 0;
    let brandMentions = 0;
    const compMentionsMap = new Map<string, number>();

    for (const comp of entry.profileForMetrics.competitors ?? []) {
      compMentionsMap.set(comp.name, 0);
    }

    for (const pid of entry.profileIds) {
      const pm = perProfileMetrics.get(pid);
      if (!pm) continue;
      completedChecks += pm.completedChecks;
      mentionedChecks += pm.mentionedChecks;
      brandMentions += pm.shareOfVoice.brandMentions;
      for (const item of pm.shareOfVoice.entries) {
        if (item.isBrand) continue;
        compMentionsMap.set(item.name, (compMentionsMap.get(item.name) ?? 0) + item.mentions);
      }
    }

    const compTotal = [...compMentionsMap.values()].reduce((acc, v) => acc + v, 0);
    const totalMentions = brandMentions + compTotal;

    const entries: ShareOfVoiceEntry[] = [
      {
        name: entry.brandName,
        isBrand: true,
        mentions: brandMentions,
        sharePct: roundOverviewPct(brandMentions, totalMentions),
      },
      ...[...compMentionsMap.entries()].map(([name, mentions]) => ({
        name,
        isBrand: false,
        mentions,
        sharePct: roundOverviewPct(mentions, totalMentions),
      })),
    ].sort(compareSovEntries);

    return {
      brandName: entry.brandName,
      completedChecks,
      mentionedChecks,
      visibilityPct: computeVisibilityPct(mentionedChecks, completedChecks),
      shareOfVoice: {
        totalMentions,
        brandMentions,
        brandSharePct: roundOverviewPct(brandMentions, totalMentions),
        entries,
      },
    };
  });

  brandGroups.sort(
    (a, b) =>
      b.shareOfVoice.brandMentions - a.shareOfVoice.brandMentions ||
      b.completedChecks - a.completedChecks ||
      a.brandName.localeCompare(b.brandName),
  );

  const allProfileMetricList = [...perProfileMetrics.values()];
  if (orphanObs.length > 0) {
    allProfileMetricList.push(
      recomputeRunMetrics(orphanObs.map(toMetricObservation), ctx.fallbackProfileForMetrics),
    );
  }

  let completedChecks = 0;
  let mentionedChecks = 0;
  let totalCitations = 0;
  let ownedCitations = 0;
  let ownedCitationChecks = 0;
  const domainAgg = new Map<string, DomainMetricItem>();

  for (const pm of allProfileMetricList) {
    completedChecks += pm.completedChecks;
    mentionedChecks += pm.mentionedChecks;
    totalCitations += pm.totalCitations;
    ownedCitations += pm.ownedCitations;
    ownedCitationChecks += pm.ownedCitationChecks;
    for (const dom of pm.topDomains) {
      const prev = domainAgg.get(dom.domain);
      if (prev) {
        prev.count += dom.count;
        prev.observationCount += dom.observationCount;
        prev.sourceKind = higherPrioritySourceKind(prev.sourceKind, dom.sourceKind);
      } else {
        domainAgg.set(dom.domain, { ...dom });
      }
    }
  }

  const topDomains = [...domainAgg.values()].sort(
    (left, right) => right.count - left.count || left.domain.localeCompare(right.domain),
  );

  const positions: Array<number | null> = [];
  const sentiments: Array<VisibilitySentiment | null> = [];
  for (const obs of observations) {
    const profCtx = ctx.profilesById.get(obs.brandMarketId) ?? ctx.fallbackProfileForMetrics;
    const relevant = isEffectiveBrandMention(obs, {
      brandName: profCtx.brandName,
      brandAliases: profCtx.brandAliases,
      competitorNames: (profCtx.competitors ?? []).map((c) => c.name),
    });
    if (!relevant) continue;
    positions.push(obs.brandPosition);
    sentiments.push(
      isVisibilitySentiment(obs.brandSentiment ?? '')
        ? (obs.brandSentiment as VisibilitySentiment)
        : null,
    );
  }

  const totalBrandMentions = brandGroups.reduce((acc, g) => acc + g.shareOfVoice.brandMentions, 0);
  const totalAllMentions = brandGroups.reduce((acc, g) => acc + g.shareOfVoice.totalMentions, 0);

  const mergedCompetitorMentions = new Map<string, number>();
  for (const group of brandGroups) {
    for (const item of group.shareOfVoice.entries) {
      if (item.isBrand) continue;
      mergedCompetitorMentions.set(
        item.name,
        (mergedCompetitorMentions.get(item.name) ?? 0) + item.mentions,
      );
    }
  }

  const combinedEntries: ShareOfVoiceEntry[] = [
    ...brandGroups.map((group) => ({
      name: group.brandName,
      isBrand: true,
      mentions: group.shareOfVoice.brandMentions,
      sharePct: roundOverviewPct(group.shareOfVoice.brandMentions, totalAllMentions),
    })),
    ...[...mergedCompetitorMentions.entries()].map(([name, mentions]) => ({
      name,
      isBrand: false,
      mentions,
      sharePct: roundOverviewPct(mentions, totalAllMentions),
    })),
  ].sort(compareSovEntries);

  return {
    metrics: {
      completedChecks,
      mentionedChecks,
      visibilityPct: computeVisibilityPct(mentionedChecks, completedChecks),
      shareOfVoice: {
        totalMentions: totalAllMentions,
        brandMentions: totalBrandMentions,
        brandSharePct: roundOverviewPct(totalBrandMentions, totalAllMentions),
        entries: combinedEntries,
      },
      avgPosition: computeAvgPosition(positions),
      sentimentSummary: computeSentimentSummary(sentiments),
      totalCitations,
      ownedCitations,
      ownedCitationChecks,
      ownedCitationRatePct: computeVisibilityPct(ownedCitations, totalCitations),
      ownedCitationCheckRatePct: computeVisibilityPct(ownedCitationChecks, completedChecks),
      topDomains,
    },
    brandGroups,
  };
}

export function buildDailyTrend(
  observations: ReadonlyArray<OverviewObservationRow>,
  dateKeys: readonly string[],
  ctx: OverviewProfileContext,
  selectedEngine?: VisibilityEngineKey,
): VisibilityTrendPoint[] {
  const allByDate = new Map<string, OverviewObservationRow[]>();
  const byEngineDate = new Map<string, Map<string, OverviewObservationRow[]>>();
  for (const key of dateKeys) allByDate.set(key, []);

  for (const obs of observations) {
    const dateKey = toShanghaiDateKey(obs.checkedAt ?? obs.createdAt);
    allByDate.get(dateKey)?.push(obs);

    if (isVisibilityEngine(obs.engine)) {
      let engMap = byEngineDate.get(obs.engine);
      if (!engMap) {
        engMap = new Map(dateKeys.map((k) => [k, []]));
        byEngineDate.set(obs.engine, engMap);
      }
      engMap.get(dateKey)?.push(obs);
    }
  }

  const toTrendPoint = (
    date: string,
    engine: VisibilityEngineKey | 'all',
    dayObs: readonly OverviewObservationRow[],
  ): VisibilityTrendPoint => {
    const completedChecks = dayObs.length;
    if (completedChecks === 0) {
      return {
        date,
        engine,
        completedChecks: 0,
        mentionedChecks: 0,
        visibilityPct: 0,
        shareOfVoicePct: null,
      };
    }

    const { metrics } = computeOverviewMetricsAndGroups(dayObs, ctx);
    return {
      date,
      engine,
      completedChecks,
      mentionedChecks: metrics.mentionedChecks,
      visibilityPct: metrics.visibilityPct,
      shareOfVoicePct: metrics.shareOfVoice.brandSharePct,
    };
  };

  if (selectedEngine) {
    const engMap = byEngineDate.get(selectedEngine);
    return dateKeys.map((date) => toTrendPoint(date, selectedEngine, engMap?.get(date) ?? []));
  }

  const points: VisibilityTrendPoint[] = [];
  for (const date of dateKeys) points.push(toTrendPoint(date, 'all', allByDate.get(date) ?? []));

  for (const [engineKey, engMap] of byEngineDate.entries()) {
    if (!isVisibilityEngine(engineKey)) continue;
    for (const date of dateKeys) {
      points.push(toTrendPoint(date, engineKey, engMap.get(date) ?? []));
    }
  }

  return points;
}

export function buildEngineBreakdown(
  observations: ReadonlyArray<OverviewObservationRow>,
  overviewCtx: OverviewProfileContext,
): VisibilityEngineBreakdownItem[] {
  const engineBucket = new Map<
    VisibilityEngineKey,
    { completed: number; mentioned: number; positions: Array<number | null> }
  >();
  for (const obs of observations) {
    if (!isVisibilityEngine(obs.engine)) continue;
    let cell = engineBucket.get(obs.engine);
    if (!cell) {
      cell = { completed: 0, mentioned: 0, positions: [] };
      engineBucket.set(obs.engine, cell);
    }
    cell.completed += 1;
    const profCtx =
      overviewCtx.profilesById.get(obs.brandMarketId) ?? overviewCtx.fallbackProfileForMetrics;
    const relevant = isEffectiveBrandMention(obs, {
      brandName: profCtx.brandName,
      brandAliases: profCtx.brandAliases,
      competitorNames: (profCtx.competitors ?? []).map((c) => c.name),
    });
    if (relevant) {
      cell.mentioned += 1;
      cell.positions.push(obs.brandPosition);
    }
  }
  return [...engineBucket.entries()]
    .map(([engine, cell]) => ({
      engine,
      completedChecks: cell.completed,
      mentionedChecks: cell.mentioned,
      visibilityPct: computeVisibilityPct(cell.mentioned, cell.completed),
      avgPosition: computeAvgPosition(cell.positions),
    }))
    .sort((a, b) => b.visibilityPct - a.visibilityPct || b.completedChecks - a.completedChecks);
}
