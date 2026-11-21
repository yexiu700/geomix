import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { apiV1Base, apiV2Base, mintSessionTokens, type MintedSession } from '../../support/helpers';
import { uniqueIdemKey } from './fixtures';

export { apiV1Base, apiV2Base, mintSessionTokens, type MintedSession };

// ---------- Public Wire Types (100% Opaque-Box, Zero Internal Imports) ----------

export type GeoMarket = 'CN' | 'GLOBAL';
export type BillingMode = 'SHADOW' | 'STRICT';
export type BrandFactSlot =
  'PRODUCT_SPECS' | 'DIFFERENTIATORS' | 'CREDENTIALS' | 'CASE_STUDIES' | 'EXTRA_DOC';
export type FactSourceType = 'MANUAL' | 'URL_EXTRACT' | 'DOC_UPLOAD' | 'STUDIO_FEEDBACK';
export type FactIndexStatus = 'NONE' | 'INDEXING' | 'READY' | 'FAILED';
export type BrandMediaOrigin = 'PRODUCT_UPLOAD' | 'AI_INLINE_GEN';
export type GeoRecipe =
  'AUTHORITY_GUIDE' | 'COMPARISON_MATRIX' | 'OBJECTION_FAQ' | 'CITATION_COUNTER';
export type GeoTargetFormat =
  'CN_DEEP_REVIEW' | 'CN_COMMUNITY_QA' | 'GLOBAL_AUTHORITY_GUIDE' | 'GLOBAL_COMMUNITY_DISCUSSION';
export type GeoBriefSource =
  'AUTO_GAP' | 'LOW_RANK' | 'SENTIMENT_RISK' | 'FANOUT_CLUSTER' | 'CITATION_COUNTER' | 'MANUAL';
export type GeoBriefStatus = 'OPEN' | 'WRITING' | 'DONE' | 'DISMISSED';
export type GeoArticleStatus = 'DRAFT' | 'READY' | 'PUBLISHED';
export type GeoRewriteAction = 'DE_AD' | 'TO_TABLE' | 'ADD_EVIDENCE' | 'CONCISE_ANSWER';
export type CitationSourceKind =
  'OWNED' | 'COMPETITOR' | 'SOCIAL' | 'AUTHORITY' | 'ECOMMERCE' | 'OTHER';
export type GeoScoreDimensionKey =
  'directAnswer' | 'structuredExtractable' | 'factDensity' | 'fanOutCoverage' | 'deAiCompliance';

export interface ApiEnvelope<T = unknown> {
  code: number;
  msg?: string;
  data: T;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: ApiEnvelope<T> | null;
  rawText: string;
}

export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  envelope: ApiEnvelope<T>;
  rawText: string;
}

export interface BinaryHttpResult {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

export interface TenantSession {
  tenantId: string;
  username: string;
  password: string;
  role: 'MERCHANT' | 'ADMIN';
  accessToken: string;
  refreshToken: string;
}

export interface IsolatedTenant {
  tenantId: string;
  username: string;
  password: string;
  session: MintedSession;
}

export interface WalletData {
  points: number;
  pointsReserved: number;
  available: number;
  money?: string;
  billingMode: BillingMode;
  billingModeSource?: 'tenant' | 'global';
  tenantBillingMode?: BillingMode | null;
}
export type WalletDto = WalletData;

export interface PointLogItemDto {
  id: string;
  title: string;
  delta: number;
  listPrice: number;
  phrase: string;
  pointsText: string;
  createdAt: string;
  status: string;
}

export interface PricingItemData {
  action: string;
  unitPoints: number;
  enabled: boolean;
  label?: string;
}
export type PricingItemDto = PricingItemData;

export interface BrandCompetitor {
  name: string;
  aliases?: string[];
  domains?: string[];
}
export type BrandCompetitorDto = {
  name: string;
  aliases: string[];
  domains: string[];
};

export interface BrandMarketData {
  id: string;
  brandId: string;
  market: GeoMarket;
  locale: string;
  region: string;
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: BrandCompetitorDto[];
  seedPrompts: string[];
  createdAt?: string;
  updatedAt?: string;
}
export type BrandMarketDto = BrandMarketData;

export interface BrandData {
  id: string;
  name: string;
  category: string;
  truthAgreementSignedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  markets: BrandMarketData[];
  factCount?: number;
  mediaCount?: number;
}
export type BrandDto = BrandData;

export interface BrandFactData {
  id: string;
  brandId: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  indexStatus: FactIndexStatus;
  createdAt?: string;
  updatedAt: string;
}
export type BrandFactDto = BrandFactData;

export interface BrandMediaData {
  id: string;
  brandId: string;
  origin: BrandMediaOrigin;
  title: string;
  objectKey?: string;
  thumbKey?: string | null;
  url: string;
  thumbUrl: string | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  aiPrompt: string | null;
  aiModel: string | null;
  usedCount: number;
  createdAt: string;
}
export type BrandMediaAssetDto = BrandMediaData;

export interface BrandMediaUploadResponse {
  items?: BrandMediaData[];
  item?: BrandMediaData;
  warnings?: string[];
  storage?: unknown;
}

export interface VisibilityEngineOption {
  key: string;
  label: string;
  name?: string;
  domestic?: boolean;
  available?: boolean;
  online?: boolean;
  enabled?: boolean;
  status?: string;
}
export type VisibilityEngineItemDto = VisibilityEngineOption;

export interface VisibilityCitationData {
  id?: string;
  url: string;
  domain?: string;
  title?: string | null;
  sourceKind: CitationSourceKind;
  position?: number;
}
export type VisibilityCitationDto = VisibilityCitationData;

export interface VisibilityObservationData {
  id: string;
  runId?: string;
  promptText: string;
  engine: string;
  status?: string;
  answerText: string | null;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: 'positive' | 'neutral' | 'negative' | 'mixed' | string | null;
  brandPassage?: string | null;
  competitorHits?: unknown;
  fanOutQueries: string[];
  citations: VisibilityCitationData[];
}
export type VisibilityObservationDto = VisibilityObservationData;

export interface VisibilityRunData {
  id: string;
  brandId?: string;
  brandMarketId?: string;
  market?: GeoMarket;
  engines?: string[];
  status: string;
  triggerType?: 'MANUAL' | 'RETEST';
  retestArticleId?: string | null;
  briefsGeneratedAt?: string | null;
  totalChecks?: number;
  completedChecks?: number;
  doneCount?: number;
  failCount?: number;
  successCount?: number;
  unitPrice?: number;
  observations?: VisibilityObservationData[];
}
export type VisibilityRunDto = VisibilityRunData;

export interface GeoOutlineHeading {
  heading: string;
  intent: string;
  fanOutRef?: string;
}
export type GeoOutlineHeadingDto = GeoOutlineHeading;

export interface GeoBriefData {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  sourceType: GeoBriefSource;
  sourceRunId: string | null;
  sourceObservationIds: string[];
  sourceCitationUrl: string | null;
  targetPrompt: string;
  priorityScore: number;
  diagnosisSummary: string;
  recommendedRecipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  suggestedTitle: string;
  outlineH2: GeoOutlineHeading[];
  targetFanOuts: string[];
  competitorFocus: string[];
  matchedFactIds: string[];
  missingFactHints: string[];
  recommendedChannels: Array<{ channel: string; reason: string }>;
  status: GeoBriefStatus;
  createdAt: string;
  updatedAt: string;
}
export type GeoBriefDto = GeoBriefData;

export interface GeoScoreDimensionDetail {
  key: GeoScoreDimensionKey;
  label: string;
  score: number;
  maxScore: number;
  passed: boolean;
  hints: string[];
}
export type GeoScoreDimensionDto = GeoScoreDimensionDetail;

export interface GeoScoreDetailDto {
  dimensions: Record<GeoScoreDimensionKey, GeoScoreDimensionDetail>;
  coveredFanOuts: string[];
  missingFanOuts: string[];
}

export interface GeoArticleData {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  briefId: string | null;
  batchJobId: string | null;
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  title: string;
  targetPrompt: string;
  outlineJson: GeoOutlineHeading[];
  contentMarkdown: string;
  contentHtml: string;
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
  geoScore: number;
  geoScoreDetail: GeoScoreDetailDto;
  tags: string[];
  status: GeoArticleStatus;
  complianceFlags: unknown;
  createdAt: string;
  updatedAt: string;
}
export type GeoArticleDto = GeoArticleData;

export interface GeoBatchJobData {
  id: string;
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  briefIds: string[];
  total: number;
  doneCount: number;
  failCount: number;
  unitPrice: number;
  reservationId: string | null;
  status: string;
  lastError: string | null;
}
export type GeoBatchJobDto = GeoBatchJobData;

export interface GeoEvaluationData {
  geoScore: number;
  geoScoreDetail: GeoScoreDetailDto;
  schemaJsonLd: Record<string, unknown>;
  llmsTxtSnippet: string | null;
  crawlerChecklist: Array<{ bot: string; purpose: string; recommended: boolean }>;
  recommendedChannels: Array<{ channel: string; reason: string }>;
}
export type GeoEvaluationDto = GeoEvaluationData;

export interface RetestMetricSnapshot {
  mentionRate: number;
  avgPosition: number | null;
  sentiment: string | null;
  citationHit: boolean;
}
export type RetestMetricsDto = RetestMetricSnapshot;

export interface GeoPublishRecordData {
  id: string;
  brandId: string;
  brandMarketId: string;
  articleId: string;
  publishedUrl: string;
  channel: string;
  publishedAt: string;
  baselineRunId: string | null;
  latestRetestRunId: string | null;
  beforeMetrics: RetestMetricSnapshot | null;
  afterMetrics: RetestMetricSnapshot | null;
}
export type GeoPublishRecordDto = GeoPublishRecordData;

export interface PromptPreferenceDto {
  customToneNote: string | null;
  customForbiddenWords: string[];
  recipeOverrides: Record<string, string> | null;
  updatedAt: string | null;
}

export interface ActionHomeData {
  brandId: string;
  brandMarketId: string;
  market: GeoMarket;
  health: {
    days: number;
    mentionRatePct: number;
    shareOfVoicePct: number;
    avgPosition: number | null;
    ownedCitationRatePct: number;
    completedChecks: number;
  };
  topBriefs: Array<{
    id: string;
    sourceType: string;
    priorityScore: number;
    diagnosisSummary: string;
    suggestedTitle: string;
    targetPrompt: string;
    recommendedRecipe: GeoRecipe;
    targetFormat: GeoTargetFormat;
    recommendedChannels: Array<{ channel: string; reason: string }>;
  }>;
  recentArticles: Array<{
    id: string;
    title: string;
    recipe: GeoRecipe;
    geoScore: number;
    status: GeoArticleStatus;
    updatedAt: string;
    publishRecord?: GeoPublishRecordData | null;
  }>;
}
export type ActionHomeDto = ActionHomeData;

export interface SseEvent {
  event: string;
  rawData: string;
  raw: string;
  data: unknown;
  receivedAtMs: number;
}

export interface SseStreamResult {
  status: number;
  headers: Record<string, string>;
  rawHeaders: Headers;
  events: SseEvent[];
  meta?: {
    reservationId: string;
    unitPrice: number;
    billingMode: BillingMode;
    market: GeoMarket;
    recipe: GeoRecipe;
    targetFormat: GeoTargetFormat;
    matchedFactIds: string[];
  };
  deltas: string[];
  complete?: {
    article: GeoArticleDto;
    geoScore: number;
    geoScoreDetail: GeoScoreDetailDto;
    schemaJsonLd: Record<string, unknown>;
    llmsTxtSnippet: string | null;
  };
  errorEvent?: { code: number; msg: string; refunded: boolean };
  firstDeltaMs: number | null;
  totalDurationMs: number;
  aborted: boolean;
  errorBody: ApiEnvelope<unknown> | null;
  rawText: string;
}

export interface ProvisionTenantOptions {
  tag: string;
  billingMode?: BillingMode | null;
  initialPoints?: number;
  expired?: boolean;
  expiresAt?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// ---------- Base URLs & Sessions ----------

export function getApiV1Base(): string {
  return apiV1Base();
}

export function getApiV2Base(): string {
  return apiV2Base();
}

export function getWebBase(): string {
  return (process.env.E2E_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

const DEFAULT_E2E_PASSWORD = 'GeoMix-E2E-Password-123!';

export function getAdminSession(): MintedSession {
  return mintSessionTokens('admin');
}

export function getDemoSession(): MintedSession {
  return mintSessionTokens('demo');
}

// ---------- Core HTTP Client ----------

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function buildUrl(base: 'v1' | 'v2', path: string): string {
  const root = base === 'v1' ? getApiV1Base() : getApiV2Base();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${root}${normalizedPath}`;
}

export async function apiRequest<T = unknown>(
  base: 'v1' | 'v2',
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: {
    token?: string | null;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  let payload: string | undefined;
  if (options.rawBody !== undefined) {
    payload = options.rawBody;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;

  try {
    const res = await fetch(buildUrl(base, path), {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    const rawText = await res.text();
    let body: ApiEnvelope<T> | null = null;
    try {
      body = rawText ? (JSON.parse(rawText) as ApiEnvelope<T>) : null;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      headers: headersToRecord(res.headers),
      body,
      rawText,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function apiRawFetch(
  base: 'v1' | 'v2',
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: {
    token?: string | null;
    body?: FormData | string | Uint8Array;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; buffer: Buffer }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const fetchBody =
    options.body instanceof Uint8Array ? new Blob([Uint8Array.from(options.body)]) : options.body;
  const res = await fetch(buildUrl(base, path), {
    method,
    headers,
    body: fetchBody,
    signal: options.signal,
  });
  const arrayBuf = await res.arrayBuffer();
  return {
    status: res.status,
    headers: headersToRecord(res.headers),
    buffer: Buffer.from(arrayBuf),
  };
}

async function requestEnvelope<T>(
  base: 'v1' | 'v2',
  path: string,
  opts: RequestOptions = {},
): Promise<HttpResult<T>> {
  const method =
    opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  let payload: string | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(buildUrl(base, path), {
    method,
    headers,
    body: payload,
  });
  const rawText = await res.text();
  let parsed: ApiEnvelope<T>;
  try {
    parsed = (
      rawText ? JSON.parse(rawText) : { code: res.ok ? 0 : res.status, data: null }
    ) as ApiEnvelope<T>;
  } catch {
    parsed = { code: res.ok ? 0 : res.status, msg: rawText.slice(0, 200), data: null as T };
  }
  return {
    status: res.status,
    headers: res.headers,
    envelope: parsed,
    rawText,
  };
}

export async function requestV1<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<HttpResult<T>> {
  return requestEnvelope<T>('v1', path, opts);
}

export async function requestV2<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<HttpResult<T>> {
  return requestEnvelope<T>('v2', path, opts);
}

export async function requestV2Binary(
  path: string,
  opts: RequestOptions = {},
): Promise<BinaryHttpResult> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  const res = await fetch(buildUrl('v2', path), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const arrayBuf = await res.arrayBuffer();
  return {
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(arrayBuf),
  };
}

export async function uploadV2Multipart<T = unknown>(
  path: string,
  opts: {
    token: string;
    fileField?: string;
    filename: string;
    contentType: string;
    buffer: Buffer;
    fields?: Record<string, string>;
  },
): Promise<HttpResult<T>> {
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(opts.buffer)], { type: opts.contentType });
  form.append(opts.fileField ?? 'file', blob, opts.filename);
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    form.append(k, v);
  }
  const res = await fetch(buildUrl('v2', path), {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}` },
    body: form,
  });
  const rawText = await res.text();
  let parsed: ApiEnvelope<T>;
  try {
    parsed = (
      rawText ? JSON.parse(rawText) : { code: res.ok ? 0 : res.status, data: null }
    ) as ApiEnvelope<T>;
  } catch {
    parsed = { code: res.ok ? 0 : res.status, msg: rawText.slice(0, 200), data: null as T };
  }
  return {
    status: res.status,
    headers: res.headers,
    envelope: parsed,
    rawText,
  };
}

export function unwrapOk<T>(res: HttpResult<T>, context = 'API request'): T {
  if (res.status < 200 || res.status >= 300 || res.envelope.code !== 0) {
    throw new Error(
      `${context} failed: HTTP ${res.status}, code=${String(res.envelope.code)}, msg=${res.envelope.msg ?? res.rawText.slice(0, 300)}`,
    );
  }
  return res.envelope.data;
}

/**
 * Streams an oversized multipart upload (e.g., 100MB + 4KB) using a reusable 64KB chunk
 * so Multer's 100MB limit triggers 413 cleanly without allocating a 101MB Buffer.
 */
export async function streamOversizedMultipartUpload(
  path: string,
  token: string,
  totalBytes: number,
  fieldName = 'file',
  filename = 'oversized.png',
  mime = 'image/png',
): Promise<{ status: number; rawText: string; body: ApiEnvelope<unknown> | null }> {
  const targetUrl = new URL(buildUrl('v2', path));
  const boundary = `----GeoMixV2Boundary${randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const contentLength = head.length + totalBytes + tail.length;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: {
      status: number;
      rawText: string;
      body: ApiEnvelope<unknown> | null;
    }) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(contentLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let body: ApiEnvelope<unknown> | null = null;
          try {
            body = rawText ? (JSON.parse(rawText) as ApiEnvelope<unknown>) : null;
          } catch {
            body = null;
          }
          finish({ status: res.statusCode ?? 0, rawText, body });
        });
      },
    );

    let writeStopped = false;
    req.on('error', (err: NodeJS.ErrnoException) => {
      writeStopped = true;
      // Server frequently resets socket right after sending 413 while body is still streaming
      if (
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.code === 'ERR_STREAM_DESTROYED'
      ) {
        setTimeout(() => {
          if (!settled) {
            finish({ status: 413, rawText: err.message, body: null });
          }
        }, 150);
        return;
      }
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.write(head);
    const chunkBuf = Buffer.alloc(64 * 1024, 0x41);
    let remaining = totalBytes;

    const pump = () => {
      while (remaining > 0 && !writeStopped && !settled) {
        const size = Math.min(remaining, chunkBuf.length);
        remaining -= size;
        const ok = req.write(size === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, size));
        if (!ok) {
          req.once('drain', pump);
          return;
        }
      }
      if (!writeStopped && !settled) {
        req.end(tail);
      }
    };

    pump();
  });
}

function unwrapUploadedMedia(
  raw: BrandMediaUploadResponse | BrandMediaData | null | undefined,
): BrandMediaData | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  if ('item' in raw && raw.item && typeof raw.item === 'object') {
    return raw.item;
  }
  if ('items' in raw && Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items[0];
  }
  return raw as BrandMediaData;
}

export async function uploadBrandMedia(
  token: string,
  brandId: string,
  file: { buffer: Buffer; filename: string; mime: string; title?: string },
): Promise<ApiResponse<BrandMediaData>> {
  const res = await uploadV2Multipart<BrandMediaUploadResponse | BrandMediaData>(
    `/brands/${brandId}/media`,
    {
      token,
      filename: file.filename,
      contentType: file.mime,
      buffer: file.buffer,
      fields: file.title ? { title: file.title } : undefined,
    },
  );
  const unwrapped = unwrapUploadedMedia(res.envelope?.data);
  const normalizedBody: ApiEnvelope<BrandMediaData> | null = res.envelope
    ? {
        ...res.envelope,
        data: (unwrapped ?? res.envelope.data) as BrandMediaData,
      }
    : null;
  return {
    status: res.status,
    headers: headersToRecord(res.headers),
    body: normalizedBody,
    rawText: res.rawText,
  };
}

export async function deleteBrandMedia(
  token: string,
  brandId: string,
  mediaId: string,
): Promise<ApiResponse<unknown>> {
  return apiRequest('v2', 'DELETE', `/brands/${brandId}/media/${mediaId}`, { token });
}

// ---------- Tenant Provisioning & Admin Helpers ----------

export async function provisionTenant(options: ProvisionTenantOptions): Promise<TenantSession> {
  const admin = getAdminSession();
  const clean =
    options.tag
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 12) || 't';
  const rnd = randomBytes(4).toString('hex');
  const username = `e2v2_${clean}_${rnd}`.slice(0, 32);
  const initialPoints = options.initialPoints ?? 500;
  const expiresAt =
    options.expiresAt ??
    (options.expired
      ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());

  const headers: Record<string, string> = {};
  if (initialPoints > 0) {
    headers['idempotency-key'] = `v2-ten-${clean}-${rnd}`;
  }

  const res = await apiRequest<{ tenant?: { id: string }; id?: string }>(
    'v1',
    'POST',
    '/admin/tenants',
    {
      token: admin.accessToken,
      headers,
      body: {
        name: `E2E ${options.tag}`,
        username,
        password: DEFAULT_E2E_PASSWORD,
        expiresAt,
        billingMode: options.billingMode ?? null,
        initialPoints,
      },
    },
  );

  if (res.status < 200 || res.status >= 300 || res.body?.code !== 0) {
    throw new Error(
      `provisionTenant(${username}) failed: HTTP ${res.status}, body=${res.rawText.slice(0, 300)}`,
    );
  }

  const minted = mintSessionTokens(username);
  return {
    tenantId: minted.tenantId,
    username: minted.username,
    password: DEFAULT_E2E_PASSWORD,
    role: minted.role,
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
  };
}

export async function provisionIsolatedTenant(
  opts: {
    billingMode?: BillingMode | null;
    initialPoints?: number;
    expiresAt?: string;
    expired?: boolean;
    prefix?: string;
  } = {},
): Promise<IsolatedTenant> {
  const tenant = await provisionTenant({
    tag: opts.prefix ?? 'iso',
    billingMode: opts.billingMode ?? null,
    initialPoints: opts.initialPoints ?? 500,
    expiresAt: opts.expiresAt,
    expired: opts.expired,
  });
  return {
    tenantId: tenant.tenantId,
    username: tenant.username,
    password: tenant.password,
    session: {
      username: tenant.username,
      tenantId: tenant.tenantId,
      role: tenant.role,
      accessToken: tenant.accessToken,
      refreshToken: tenant.refreshToken,
    },
  };
}

function resolveAccessToken(sessionOrToken: string | Pick<MintedSession, 'accessToken'>): string {
  return typeof sessionOrToken === 'string' ? sessionOrToken : sessionOrToken.accessToken;
}

export async function getWallet(token: string): Promise<ApiResponse<WalletData>> {
  return apiRequest<WalletData>('v1', 'GET', '/billing/wallet', { token });
}

export async function getTenantWallet(
  session: Pick<MintedSession, 'accessToken'>,
): Promise<WalletDto> {
  const res = await requestV1<WalletDto>('/billing/wallet', { token: session.accessToken });
  return unwrapOk(res, 'GET /api/v1/billing/wallet');
}

export async function getWalletPoints(
  sessionOrToken: string | Pick<MintedSession, 'accessToken'>,
): Promise<number> {
  const res = await requestV1<WalletDto>('/billing/wallet', {
    token: resolveAccessToken(sessionOrToken),
  });
  return unwrapOk(res, 'GET /api/v1/billing/wallet').points;
}

export async function getTenantPointLogs(
  session: Pick<MintedSession, 'accessToken'>,
  pageSize: 10 | 25 | 50 = 50,
): Promise<{ total: number; items: PointLogItemDto[] }> {
  const res = await requestV1<{ total: number; items: PointLogItemDto[] }>(
    `/me/points?page=1&pageSize=${pageSize}`,
    { token: session.accessToken },
  );
  return unwrapOk(res, 'GET /api/v1/me/points');
}

export async function getPointLogs(
  sessionOrToken: string | Pick<MintedSession, 'accessToken'>,
  pageSize: 10 | 25 | 50 = 50,
): Promise<{ total: number; items: PointLogItemDto[] }> {
  return getTenantPointLogs({ accessToken: resolveAccessToken(sessionOrToken) }, pageSize);
}

export async function getAdminTenant(tenantId: string): Promise<{
  id: string;
  name: string;
  isActive: boolean;
  expiresAt: string;
  points?: number;
  wallet?: { points: number; pointsReserved: number };
}> {
  const admin = getAdminSession();
  const res = await requestV1<{
    id: string;
    name: string;
    isActive: boolean;
    expiresAt: string;
    points?: number;
    wallet?: { points: number; pointsReserved: number };
  }>(`/admin/tenants/${tenantId}`, { token: admin.accessToken });
  return unwrapOk(res, `GET /api/v1/admin/tenants/${tenantId}`);
}

export async function setTenantBillingMode(
  tenantId: string,
  billingMode: BillingMode | null,
): Promise<ApiResponse<unknown>> {
  const admin = getAdminSession();
  return apiRequest('v1', 'POST', '/admin/billing/mode', {
    token: admin.accessToken,
    body: { tenantId, billingMode },
  });
}

export async function adminAdjustPoints(input: {
  tenantId: string;
  delta: number;
  idempotencyKey: string;
  remark?: string;
}): Promise<ApiResponse<unknown>> {
  const admin = getAdminSession();
  return apiRequest('v1', 'POST', '/admin/billing/adjust', {
    token: admin.accessToken,
    body: {
      tenantId: input.tenantId,
      delta: input.delta,
      idempotencyKey: input.idempotencyKey,
      remark: input.remark ?? 'e2e adjust',
    },
  });
}

export async function adjustTenantPoints(
  tenantId: string,
  delta: number,
  remark = 'e2e adjust',
): Promise<void> {
  const res = await adminAdjustPoints({
    tenantId,
    delta,
    idempotencyKey: uniqueIdemKey('v2adj'),
    remark,
  });
  if (res.status < 200 || res.status >= 300 || res.body?.code !== 0) {
    throw new Error(`adjustTenantPoints failed: HTTP ${res.status} ${res.rawText}`);
  }
}

export async function setTenantExpiry(
  tenantId: string,
  expiresAtIso: string,
  isActive?: boolean,
): Promise<void> {
  const admin = getAdminSession();
  const res = await requestV1(`/admin/tenants/${tenantId}`, {
    method: 'PATCH',
    token: admin.accessToken,
    body: {
      expiresAt: expiresAtIso,
      ...(isActive !== undefined ? { isActive } : {}),
    },
  });
  unwrapOk(res, `PATCH /api/v1/admin/tenants/${tenantId}`);
}

export async function getAdminPricing(): Promise<PricingItemDto[]> {
  const admin = getAdminSession();
  const res = await requestV1<{ items?: PricingItemDto[] } | PricingItemDto[]>('/admin/pricing', {
    token: admin.accessToken,
  });
  return extractItems(unwrapOk(res, 'GET /api/v1/admin/pricing'));
}

export async function updateAdminPricing(
  action: string,
  unitPoints: number,
  enabled = true,
): Promise<void> {
  const admin = getAdminSession();
  const res = await requestV1('/admin/pricing', {
    method: 'PATCH',
    token: admin.accessToken,
    body: { action, unitPoints, enabled },
  });
  unwrapOk(res, `PATCH /api/v1/admin/pricing (${action})`);
}

// ---------- SSE Stream Consumer ----------

function parseSseFrame(frame: string, receivedAtMs: number): SseEvent | null {
  const lines = frame.split(/\r?\n/);
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const rawData = dataLines.join('\n');
  let parsed: unknown = rawData;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    parsed = rawData;
  }
  return {
    event: eventName,
    rawData,
    raw: rawData,
    data: parsed,
    receivedAtMs,
  };
}

export async function consumeSsePost(
  path: string,
  opts: {
    token: string;
    body: Record<string, unknown>;
    idempotencyKey?: string;
    abortAfterEvents?: number;
    abortAfterEventType?: string;
    signal?: AbortSignal;
    onEvent?: (event: SseEvent) => void;
    timeoutMs?: number;
    assertSseHeaders?: boolean;
  },
): Promise<SseStreamResult> {
  const startedAt = Date.now();
  const internalController = new AbortController();
  const externalSignal = opts.signal;
  const onExternalAbort = () => internalController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      internalController.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => internalController.abort(), opts.timeoutMs)
      : undefined;

  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (opts.idempotencyKey) {
    headers['idempotency-key'] = opts.idempotencyKey;
  }

  const events: SseEvent[] = [];
  const deltas: string[] = [];
  let meta: SseStreamResult['meta'];
  let complete: SseStreamResult['complete'];
  let errorEvent: SseStreamResult['errorEvent'];
  let firstDeltaMs: number | null = null;
  let aborted = false;
  let rawText = '';

  try {
    const res = await fetch(buildUrl('v2', path), {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body),
      signal: internalController.signal,
    });
    const headerRecord = headersToRecord(res.headers);

    if (res.status !== 200) {
      rawText = await res.text();
      let errorBody: ApiEnvelope<unknown> | null = null;
      try {
        errorBody = rawText ? (JSON.parse(rawText) as ApiEnvelope<unknown>) : null;
      } catch {
        errorBody = null;
      }
      return {
        status: res.status,
        headers: headerRecord,
        rawHeaders: res.headers,
        events,
        deltas,
        firstDeltaMs,
        totalDurationMs: Date.now() - startedAt,
        aborted: false,
        errorBody,
        rawText,
      };
    }

    if (opts.assertSseHeaders !== false) {
      const ct = headerRecord['content-type'] ?? '';
      const cc = headerRecord['cache-control'] ?? '';
      const xab = headerRecord['x-accel-buffering'] ?? '';
      if (!ct.toLowerCase().includes('text/event-stream')) {
        throw new Error(`Expected text/event-stream content-type, got "${ct}"`);
      }
      if (!cc.toLowerCase().includes('no-cache')) {
        throw new Error(`Expected no-cache cache-control, got "${cc}"`);
      }
      if (xab.toLowerCase() !== 'no') {
        throw new Error(`Expected x-accel-buffering: no, got "${xab}"`);
      }
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processEvent = (evt: SseEvent) => {
      events.push(evt);
      if (evt.event === 'meta' && evt.data && typeof evt.data === 'object') {
        meta = evt.data as SseStreamResult['meta'];
      } else if (evt.event === 'delta' && evt.data && typeof evt.data === 'object') {
        const text = String((evt.data as { text?: unknown }).text ?? '');
        deltas.push(text);
        if (firstDeltaMs === null) {
          firstDeltaMs = evt.receivedAtMs - startedAt;
        }
      } else if (evt.event === 'complete' && evt.data && typeof evt.data === 'object') {
        complete = evt.data as SseStreamResult['complete'];
      } else if (evt.event === 'error' && evt.data && typeof evt.data === 'object') {
        errorEvent = evt.data as SseStreamResult['errorEvent'];
      }

      opts.onEvent?.(evt);

      if (
        (opts.abortAfterEvents !== undefined && events.length >= opts.abortAfterEvents) ||
        (opts.abortAfterEventType !== undefined && evt.event === opts.abortAfterEventType)
      ) {
        aborted = true;
        internalController.abort();
      }
    };

    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          rawText += chunk;
          buffer += chunk;
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const evt = parseSseFrame(part, Date.now());
            if (evt) {
              processEvent(evt);
              if (aborted) {
                break;
              }
            }
          }
          if (aborted) {
            break;
          }
        }
        if (!aborted && buffer.trim()) {
          const evt = parseSseFrame(buffer, Date.now());
          if (evt) {
            processEvent(evt);
          }
        }
      } catch (err) {
        if (
          internalController.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          aborted = true;
        } else {
          throw err;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }

    return {
      status: res.status,
      headers: headerRecord,
      rawHeaders: res.headers,
      events,
      meta,
      deltas,
      complete,
      errorEvent,
      firstDeltaMs,
      totalDurationMs: Date.now() - startedAt,
      aborted,
      errorBody: null,
      rawText,
    };
  } catch (err) {
    if (internalController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return {
        status: 200,
        headers: {},
        rawHeaders: new Headers(),
        events,
        meta,
        deltas,
        complete,
        errorEvent,
        firstDeltaMs,
        totalDurationMs: Date.now() - startedAt,
        aborted: true,
        errorBody: null,
        rawText,
      };
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function streamArticle(
  token: string,
  brandId: string,
  payload: Record<string, unknown>,
  options: {
    idempotencyKey?: string;
    signal?: AbortSignal;
    onEvent?: (event: SseEvent) => void;
    timeoutMs?: number;
    assertSseHeaders?: boolean;
  } = {},
): Promise<SseStreamResult> {
  return consumeSsePost(`/brands/${brandId}/articles/stream`, {
    token,
    body: payload,
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
    onEvent: options.onEvent,
    timeoutMs: options.timeoutMs,
    assertSseHeaders: options.assertSseHeaders ?? false,
  });
}

// ---------- Polling & List Utilities ----------

export function extractItems<T>(
  data: { items?: T[]; engines?: T[] } | T[] | null | undefined,
): T[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data.items)) {
    return data.items;
  }
  if (Array.isArray(data.engines)) {
    return data.engines;
  }
  return [];
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 400;
  const label = options.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      lastValue = value;
      if (predicate(value)) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `pollUntil(${label}) timed out after ${timeoutMs}ms. lastValue=${JSON.stringify(lastValue)?.slice(0, 400)} lastError=${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`,
  );
}

// ---------- Domain Conveniences (Both Wave B1 & Wave B2 Signatures) ----------

export async function createBrand(
  token: string,
  payload: Record<string, unknown>,
): Promise<ApiResponse<BrandData>> {
  return apiRequest<BrandData>('v2', 'POST', '/brands', { token, body: payload });
}

export async function listBrands(token: string): Promise<ApiResponse<{ items: BrandData[] }>> {
  return apiRequest<{ items: BrandData[] }>('v2', 'GET', '/brands', { token });
}

export async function getBrand(token: string, brandId: string): Promise<ApiResponse<BrandData>> {
  return apiRequest<BrandData>('v2', 'GET', `/brands/${brandId}`, { token });
}

export async function enableBrandMarket(
  token: string,
  brandId: string,
  market: GeoMarket | string,
  payload: Record<string, unknown> = {},
): Promise<ApiResponse<BrandData>> {
  return apiRequest<BrandData>('v2', 'POST', `/brands/${brandId}/markets/${market}`, {
    token,
    body: payload,
  });
}

export async function saveBrandFacts(
  token: string,
  brandId: string,
  payload: Record<string, unknown>,
): Promise<ApiResponse<{ items?: BrandFactData[] } | BrandFactData[]>> {
  return apiRequest<{ items?: BrandFactData[] } | BrandFactData[]>(
    'v2',
    'PUT',
    `/brands/${brandId}/facts`,
    { token, body: payload },
  );
}

export async function listBrandFacts(
  token: string,
  brandId: string,
): Promise<ApiResponse<{ items?: BrandFactData[] } | BrandFactData[]>> {
  return apiRequest<{ items?: BrandFactData[] } | BrandFactData[]>(
    'v2',
    'GET',
    `/brands/${brandId}/facts`,
    { token },
  );
}

export async function pollVisibilityRunDone(
  token: string,
  brandId: string,
  runId: string,
  timeoutMs = 30_000,
): Promise<VisibilityRunData> {
  return pollUntil(
    async () => {
      const res = await apiRequest<VisibilityRunData>(
        'v2',
        'GET',
        `/brands/${brandId}/visibility/runs/${runId}`,
        { token },
      );
      if (res.status < 200 || res.status >= 300 || !res.body?.data) {
        throw new Error(`GET visibility run failed: HTTP ${res.status} ${res.rawText}`);
      }
      return res.body.data;
    },
    (run) => ['COMPLETED', 'PARTIAL', 'FAILED'].includes(run.status),
    { timeoutMs, intervalMs: 400, label: `visibilityRun:${runId}` },
  );
}

export async function pollBatchJobDone(
  token: string,
  brandId: string,
  jobId: string,
  timeoutMs = 45_000,
): Promise<GeoBatchJobData> {
  return pollUntil(
    async () => {
      const res = await apiRequest<GeoBatchJobData>(
        'v2',
        'GET',
        `/brands/${brandId}/batch-jobs/${jobId}`,
        { token },
      );
      if (res.status < 200 || res.status >= 300 || !res.body?.data) {
        throw new Error(`GET batch job failed: HTTP ${res.status} ${res.rawText}`);
      }
      return res.body.data;
    },
    (job) => ['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status),
    { timeoutMs, intervalMs: 500, label: `batchJob:${jobId}` },
  );
}

// High-level `*Api` conveniences accepting `MintedSession` (Wave B2)

export async function createBrandApi(
  session: Pick<MintedSession, 'accessToken'>,
  payload: Record<string, unknown>,
): Promise<BrandDto> {
  const res = await requestV2<BrandDto>('/brands', {
    method: 'POST',
    token: session.accessToken,
    body: payload,
  });
  return unwrapOk(res, 'POST /api/v2/brands');
}

export async function enableBrandMarketApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
  payload: Record<string, unknown>,
): Promise<BrandDto> {
  const res = await requestV2<BrandDto>(`/brands/${brandId}/markets/${market}`, {
    method: 'POST',
    token: session.accessToken,
    body: payload,
  });
  return unwrapOk(res, `POST /api/v2/brands/${brandId}/markets/${market}`);
}

export async function upsertBrandFactsApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  facts: Array<Record<string, unknown>>,
  truthAgreed = true,
): Promise<BrandFactDto[]> {
  const res = await requestV2<{ items?: BrandFactDto[] } | BrandFactDto[]>(
    `/brands/${brandId}/facts`,
    {
      method: 'PUT',
      token: session.accessToken,
      body: { facts, truthAgreed },
    },
  );
  return extractItems(unwrapOk(res, `PUT /api/v2/brands/${brandId}/facts`));
}

export async function listBrandFactsApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
): Promise<BrandFactDto[]> {
  const res = await requestV2<{ items?: BrandFactDto[] } | BrandFactDto[]>(
    `/brands/${brandId}/facts`,
    { token: session.accessToken },
  );
  return extractItems(unwrapOk(res, `GET /api/v2/brands/${brandId}/facts`));
}

export async function uploadBrandPhotoApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  opts: { filename: string; title: string; buffer: Buffer; contentType?: string },
): Promise<BrandMediaAssetDto> {
  const res = await uploadV2Multipart<BrandMediaUploadResponse | BrandMediaAssetDto>(
    `/brands/${brandId}/media`,
    {
      token: session.accessToken,
      filename: opts.filename,
      contentType: opts.contentType ?? 'image/png',
      buffer: opts.buffer,
      fields: { title: opts.title },
    },
  );
  const raw = unwrapOk(res, `POST /api/v2/brands/${brandId}/media`);
  const asset = unwrapUploadedMedia(raw);
  if (!asset || !asset.id) {
    throw new Error(
      `POST /api/v2/brands/${brandId}/media returned unexpected media payload: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return asset;
}

export async function listBrandMediaApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
): Promise<BrandMediaAssetDto[]> {
  const res = await requestV2<{ items?: BrandMediaAssetDto[] } | BrandMediaAssetDto[]>(
    `/brands/${brandId}/media`,
    { token: session.accessToken },
  );
  return extractItems(unwrapOk(res, `GET /api/v2/brands/${brandId}/media`));
}

export async function deleteBrandMediaApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  mediaId: string,
): Promise<void> {
  const res = await requestV2(`/brands/${brandId}/media/${mediaId}`, {
    method: 'DELETE',
    token: session.accessToken,
  });
  unwrapOk(res, `DELETE /api/v2/brands/${brandId}/media/${mediaId}`);
}

export async function listMarketEnginesApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
): Promise<VisibilityEngineItemDto[]> {
  const res = await requestV2<
    | { items?: VisibilityEngineItemDto[]; engines?: VisibilityEngineItemDto[] }
    | VisibilityEngineItemDto[]
  >(`/brands/${brandId}/visibility/engines?market=${market}`, { token: session.accessToken });
  return extractItems(unwrapOk(res, `GET /api/v2/brands/${brandId}/visibility/engines`));
}

export async function createVisibilityRunApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<VisibilityRunDto> {
  const res = await requestV2<VisibilityRunDto>(`/brands/${brandId}/visibility/runs`, {
    method: 'POST',
    token: session.accessToken,
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
    body: payload,
  });
  return unwrapOk(res, `POST /api/v2/brands/${brandId}/visibility/runs`);
}

export async function waitForVisibilityRunApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  runId: string,
  timeoutMs = 30_000,
): Promise<VisibilityRunDto> {
  return pollVisibilityRunDone(session.accessToken, brandId, runId, timeoutMs);
}

export async function listBriefsApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
  status?: GeoBriefStatus,
): Promise<GeoBriefDto[]> {
  const qs = status ? `market=${market}&status=${status}` : `market=${market}`;
  const res = await requestV2<{ items?: GeoBriefDto[] } | GeoBriefDto[]>(
    `/brands/${brandId}/briefs?${qs}`,
    { token: session.accessToken },
  );
  return extractItems(unwrapOk(res, `GET /api/v2/brands/${brandId}/briefs`));
}

export async function waitForAutoBriefsApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  market: GeoMarket,
  runId: string,
  timeoutMs = 30_000,
): Promise<GeoBriefDto[]> {
  await pollUntil(
    async () => {
      const res = await requestV2<VisibilityRunDto>(`/brands/${brandId}/visibility/runs/${runId}`, {
        token: session.accessToken,
      });
      return unwrapOk(res, `GET visibility run ${runId}`);
    },
    (run) => Boolean(run.briefsGeneratedAt),
    { timeoutMs, intervalMs: 400, label: `autoBriefs:${runId}` },
  );
  return listBriefsApi(session, brandId, market);
}

export async function waitForBatchJobApi(
  session: Pick<MintedSession, 'accessToken'>,
  brandId: string,
  jobId: string,
  timeoutMs = 45_000,
): Promise<GeoBatchJobDto> {
  return pollBatchJobDone(session.accessToken, brandId, jobId, timeoutMs);
}
