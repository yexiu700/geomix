import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  CHANNEL_PROVIDERS,
  type ChannelProvider,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoBatchJobRecord,
  type GeoBriefChannelRecommendation,
  type GeoComplianceFlag,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoPublishRecordDto,
  type GeoRecipe,
  type GeoTargetFormat,
  type PromptPreferenceRecord,
  type RetestMetricSnapshot,
  type TaskStatusName,
} from '@geomix/shared';

export function deriveGeoArticleId(tenantId: string, idempotencyKey: string): string {
  const hash = createHash('sha256').update(`${tenantId}::article::${idempotencyKey}`).digest('hex');
  return `ga_${hash.slice(0, 24)}`;
}

export function deriveGeoBatchJobId(tenantId: string, idempotencyKey: string): string {
  const hash = createHash('sha256').update(`${tenantId}::batch::${idempotencyKey}`).digest('hex');
  return `gb_${hash.slice(0, 24)}`;
}

export function normalizeComplianceFlags(
  raw: Prisma.JsonValue | null | undefined,
): GeoComplianceFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoComplianceFlag[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const code = typeof obj.code === 'string' ? obj.code : 'AD_LAW_FLAG';
    const market: GeoMarket = obj.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const term = typeof obj.term === 'string' ? obj.term : '';
    const severity =
      obj.severity === 'blocked' ||
      obj.severity === 'replaced' ||
      obj.severity === 'warning' ||
      obj.severity === 'info'
        ? obj.severity
        : 'warning';
    const message = typeof obj.message === 'string' ? obj.message : '';
    out.push({
      code: code as GeoComplianceFlag['code'],
      market,
      term,
      ...(typeof obj.replacement === 'string' ? { replacement: obj.replacement } : {}),
      severity,
      message,
    });
  }
  return out;
}

export function normalizeOutlineJson(
  raw: Prisma.JsonValue | null | undefined,
): GeoOutlineHeading[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoOutlineHeading[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const heading = typeof obj.heading === 'string' ? obj.heading.trim() : '';
    if (!heading) continue;
    const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';
    const fanOutRef =
      typeof obj.fanOutRef === 'string' && obj.fanOutRef.trim() ? obj.fanOutRef.trim() : undefined;
    out.push({
      heading,
      intent,
      ...(fanOutRef ? { fanOutRef } : {}),
    });
  }
  return out;
}

export function normalizeJsonRecord(
  raw: Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function extractCompetitorNames(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

export type GeoArticleRowWithMarket = {
  id: string;
  brandId: string;
  brandMarketId: string;
  briefId: string | null;
  batchJobId: string | null;
  recipe: string;
  targetFormat: string;
  title: string;
  targetPrompt: string;
  outlineJson: Prisma.JsonValue;
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: Prisma.JsonValue;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: Prisma.JsonValue;
  tags: string[];
  status: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  complianceFlags: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

export function presentGeoArticle(
  row: GeoArticleRowWithMarket,
  fallbackMarket?: GeoMarket,
): GeoArticleRecord {
  const market: GeoMarket =
    row.brandMarket?.market === 'GLOBAL' || fallbackMarket === 'GLOBAL' ? 'GLOBAL' : 'CN';
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    briefId: row.briefId,
    batchJobId: row.batchJobId,
    recipe: row.recipe as GeoRecipe,
    targetFormat: row.targetFormat as GeoTargetFormat,
    title: row.title,
    targetPrompt: row.targetPrompt,
    outlineJson: normalizeOutlineJson(row.outlineJson),
    contentMarkdown: row.contentMarkdown,
    contentHtml: row.contentHtml,
    schemaJsonLd: normalizeJsonRecord(row.schemaJsonLd),
    llmsTxtSnippet: row.llmsTxtSnippet,
    geoScore: row.geoScore,
    geoScoreDetail: normalizeJsonRecord(row.geoScoreDetail),
    tags: [...row.tags],
    status: row.status as GeoArticleStatus,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    complianceFlags: normalizeComplianceFlags(row.complianceFlags),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type GeoBatchJobRowWithMarket = {
  id: string;
  brandId: string;
  brandMarketId: string;
  briefIds: string[];
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  brandMarket?: { market: string } | null;
};

export function presentGeoBatchJob(
  row: GeoBatchJobRowWithMarket,
  fallbackMarket?: GeoMarket,
): GeoBatchJobRecord {
  const market: GeoMarket =
    row.brandMarket?.market === 'GLOBAL' || fallbackMarket === 'GLOBAL' ? 'GLOBAL' : 'CN';
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    briefIds: [...row.briefIds],
    total: row.total,
    doneCount: row.doneCount,
    failCount: row.failCount,
    unitPrice: row.unitPrice,
    reservationId: row.reservationId,
    status: row.status as TaskStatusName,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export function presentPromptPreference(
  row: {
    customToneNote: string | null;
    customForbiddenWords: string[];
    recipeOverrides: Prisma.JsonValue | null;
    updatedAt: Date;
  } | null,
): PromptPreferenceRecord {
  if (!row) {
    return {
      customToneNote: null,
      customForbiddenWords: [],
      recipeOverrides: null,
      updatedAt: null,
    };
  }
  let overrides: Record<string, string> | null = null;
  if (
    row.recipeOverrides &&
    typeof row.recipeOverrides === 'object' &&
    !Array.isArray(row.recipeOverrides)
  ) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.recipeOverrides as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v;
    }
    overrides = Object.keys(clean).length > 0 ? clean : null;
  }
  return {
    customToneNote: row.customToneNote,
    customForbiddenWords: [...row.customForbiddenWords],
    recipeOverrides: overrides,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function normalizeRetestMetricSnapshot(
  raw: Prisma.JsonValue | null | undefined,
): RetestMetricSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const mentionRate =
    typeof obj.mentionRate === 'number' && Number.isFinite(obj.mentionRate)
      ? obj.mentionRate
      : null;
  if (mentionRate === null) return null;
  const avgPosition =
    typeof obj.avgPosition === 'number' && Number.isFinite(obj.avgPosition)
      ? obj.avgPosition
      : null;
  const sentiment =
    typeof obj.sentiment === 'string' && obj.sentiment.trim() ? obj.sentiment : null;
  const citationHit = Boolean(obj.citationHit);
  return {
    mentionRate,
    avgPosition,
    sentiment,
    citationHit,
  };
}

export type GeoPublishRecordRow = {
  id: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: Date;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: Prisma.JsonValue | null;
  afterMetrics: Prisma.JsonValue | null;
};

export function presentPublishRecord(row: GeoPublishRecordRow): GeoPublishRecordDto {
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    articleId: row.articleId,
    publishedUrl: row.publishedUrl,
    channel: row.channel,
    publishedAt: row.publishedAt.toISOString(),
    baselineRunId: row.baselineRunId,
    latestRetestRunId: row.latestRetestRunId,
    beforeMetrics: normalizeRetestMetricSnapshot(row.beforeMetrics),
    afterMetrics: normalizeRetestMetricSnapshot(row.afterMetrics),
  };
}

const CHANNEL_PROVIDER_SET = new Set<string>(CHANNEL_PROVIDERS);

export function normalizeRecommendedChannels(
  raw: Prisma.JsonValue | null | undefined,
): GeoBriefChannelRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoBriefChannelRecommendation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const channel = typeof obj.channel === 'string' ? obj.channel.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!channel) continue;

    const entry: GeoBriefChannelRecommendation = { channel, reason };
    if (typeof obj.providerHint === 'string' && CHANNEL_PROVIDER_SET.has(obj.providerHint)) {
      entry.providerHint = obj.providerHint as ChannelProvider;
    }
    if (obj.priority === 'HIGH' || obj.priority === 'MEDIUM') {
      entry.priority = obj.priority;
    }
    if (Array.isArray(obj.citedExampleUrls)) {
      const urls = obj.citedExampleUrls
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map((u) => u.trim())
        .slice(0, 3);
      if (urls.length > 0) {
        entry.citedExampleUrls = urls;
      }
    }
    out.push(entry);
  }
  return out;
}
