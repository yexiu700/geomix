import type {
  ChannelConnectionConfig,
  ChannelConnectionDto,
  ChannelConnectionStatus,
  ChannelConnectionTestResultDto,
  ChannelProvider,
  ChannelRemoteTargetDto,
  CrawlProbeReport,
  CrawlProbeStatus,
  CreateChannelConnectionInput,
  CreateDistributionVariantsInput,
  DistributionMode,
  DistributionPreflightItem,
  DistributionPreflightResult,
  DistributionSummaryDto,
  DistributionTaskStatus,
  DistributionTemplateKey,
  GeoDistributionTaskDto,
  GeoMarket,
  GeoPublishRecordDto,
  GeoRetestScheduleDto,
  L1ChannelProvider,
  PublicPrPacketDto,
  PublicPrPacketSubmitInput,
  PublicPrPacketSubmitResultDto,
  RetestSampleCount,
  RetestScheduleConfigInput,
  RetestScheduleStatus,
  TestChannelConnectionInput,
  UpdateChannelConnectionInput,
  UpdateDistributionTaskInput,
} from '@geomix/shared';
import { authorizedV2RawRequest, authorizedV2Request } from './api';
import { GatewayApiError, unwrapEnvelope } from './envelope';
import { apiV2Base, type SessionStorageLike } from './session';

export type {
  ChannelConnectionConfig,
  ChannelConnectionDto,
  ChannelConnectionStatus,
  ChannelConnectionTestResultDto,
  ChannelProvider,
  ChannelRemoteTargetDto,
  CrawlProbeReport,
  CrawlProbeStatus,
  CreateDistributionVariantsInput,
  DistributionMode,
  DistributionPreflightItem,
  DistributionPreflightResult,
  DistributionSummaryDto,
  DistributionTaskStatus,
  DistributionTemplateKey,
  GeoDistributionTaskDto,
  GeoMarket,
  GeoPublishRecordDto,
  GeoRetestScheduleDto,
  L1ChannelProvider,
  PublicPrPacketDto,
  PublicPrPacketSubmitInput,
  PublicPrPacketSubmitResultDto,
  RetestSampleCount,
  RetestScheduleConfigInput,
  RetestScheduleStatus,
  TestChannelConnectionInput,
  UpdateChannelConnectionInput,
  UpdateDistributionTaskInput,
};

export type DistributionClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type DistributionIdempotentClientOptions = DistributionClientOptions & {
  idempotencyKey?: string;
};

export type PublicPrPacketClientOptions = {
  signal?: AbortSignal;
  apiBaseUrl?: string;
};

export type CreateChannelConnectionRequest = Omit<
  CreateChannelConnectionInput,
  'configJson' | 'authType'
> & {
  configJson?: ChannelConnectionConfig;
  authType?: 'API_KEY' | 'OAUTH';
};

export type PublishDistributionTaskRequest = {
  publishAsDraft?: boolean;
  connectionId?: string;
  acknowledgePreflightWarnings?: boolean;
};

export type CreatePrShareLinkRequest = {
  ttlDays?: number;
};

export type RunArticlePreflightRequest = {
  title?: string;
  contentMarkdown?: string;
  provider?: ChannelProvider | null;
  variantSlug?: string | null;
  variantMetaDesc?: string | null;
};

export type ChannelConnectionListResponse = {
  items: ChannelConnectionDto[];
};

export type ChannelConnectionDeleteResponse = {
  deleted: number;
  id: string;
};

export type ArticleDistributionTaskItem = GeoDistributionTaskDto & {
  publishRecords: GeoPublishRecordDto[];
};

export type ArticleDistributionsResponse = {
  items: ArticleDistributionTaskItem[];
};

export type GenerateDistributionVariantsFailureItem = {
  index: number;
  provider: ChannelProvider;
  channelLabel: string;
  templateKey: DistributionTemplateKey;
  error: string;
};

export type GenerateDistributionVariantsResponse = {
  articleId: string;
  unitPrice: number;
  totalChargedPoints: number;
  refundedCount: number;
  refundedPoints: number;
  reservationId: string | null;
  billingMode: 'SHADOW' | 'STRICT' | 'FREE';
  replayed: boolean;
  tasks: GeoDistributionTaskDto[];
  failures: GenerateDistributionVariantsFailureItem[];
};

export type PrShareLinkResponse = {
  taskId: string;
  shareUrl: string;
  token: string;
  expiresAt: string;
  ttlDays: number;
};

export type PrShareLinkRevokeResponse = {
  taskId: string;
  revoked: true;
  revokedAt: string;
};

export type RetestSchedulesUpdateResponse = {
  publishRecordId: string;
  items: GeoRetestScheduleDto[];
};

export class PreflightBlockedError extends GatewayApiError {
  readonly preflight?: DistributionPreflightResult;
  readonly blockers: DistributionPreflightItem[];
  readonly warnings: DistributionPreflightItem[];

  constructor(
    code: number,
    message: string,
    payload?: {
      preflight?: DistributionPreflightResult;
      blockers?: DistributionPreflightItem[];
      warnings?: DistributionPreflightItem[];
    },
  ) {
    super(422, code, message);
    this.preflight = payload?.preflight;
    this.blockers = payload?.blockers ?? payload?.preflight?.blockers ?? [];
    this.warnings = payload?.warnings ?? payload?.preflight?.warnings ?? [];
  }
}

export function isPreflightBlockedError(err: unknown): err is PreflightBlockedError {
  return err instanceof PreflightBlockedError;
}

export function createDistributionIdempotencyKey(prefix: 'var' | 'pub' = 'var'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `dist_${prefix}_${rand}`;
}

function resolvePublicV2Base(override?: string): string {
  const raw = override?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return apiV2Base();
}

function asPreflightItems(raw: unknown): DistributionPreflightItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DistributionPreflightItem =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as { code?: unknown }).code === 'string' &&
      typeof (item as { message?: unknown }).message === 'string',
  );
}

function parsePreflightPayload(raw: unknown): {
  preflight?: DistributionPreflightResult;
  blockers: DistributionPreflightItem[];
  warnings: DistributionPreflightItem[];
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { blockers: [], warnings: [] };
  }
  const obj = raw as Record<string, unknown>;
  const nested =
    obj.preflight && typeof obj.preflight === 'object' && !Array.isArray(obj.preflight)
      ? (obj.preflight as Record<string, unknown>)
      : null;

  const blockers = asPreflightItems(obj.blockers ?? nested?.blockers);
  const warnings = asPreflightItems(obj.warnings ?? nested?.warnings);
  const preflight: DistributionPreflightResult | undefined = nested
    ? {
        ok: Boolean(nested.ok),
        blockers: asPreflightItems(nested.blockers),
        warnings: asPreflightItems(nested.warnings),
      }
    : blockers.length > 0 || warnings.length > 0 || typeof obj.ok === 'boolean'
      ? {
          ok: Boolean(obj.ok),
          blockers,
          warnings,
        }
      : undefined;

  return { preflight, blockers, warnings };
}

// ==================== A. 站点渠道连接（/brands/:brandId/connections） ====================

export async function listChannelConnections(
  brandId: string,
  market?: GeoMarket,
  options?: DistributionClientOptions,
): Promise<ChannelConnectionListResponse> {
  const params = new URLSearchParams();
  if (market) params.set('market', market);
  const query = params.toString();
  const path = `/brands/${encodeURIComponent(brandId)}/connections${query ? `?${query}` : ''}`;
  return authorizedV2Request<ChannelConnectionListResponse>(path, {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export async function createChannelConnection(
  brandId: string,
  input: CreateChannelConnectionRequest,
  options?: DistributionClientOptions,
): Promise<ChannelConnectionDto> {
  return authorizedV2Request<ChannelConnectionDto>(
    `/brands/${encodeURIComponent(brandId)}/connections`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function updateChannelConnection(
  brandId: string,
  connectionId: string,
  input: UpdateChannelConnectionInput,
  options?: DistributionClientOptions,
): Promise<ChannelConnectionDto> {
  return authorizedV2Request<ChannelConnectionDto>(
    `/brands/${encodeURIComponent(brandId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function deleteChannelConnection(
  brandId: string,
  connectionId: string,
  options?: DistributionClientOptions,
): Promise<ChannelConnectionDeleteResponse> {
  return authorizedV2Request<ChannelConnectionDeleteResponse>(
    `/brands/${encodeURIComponent(brandId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function testChannelConnection(
  brandId: string,
  connectionId: string,
  input?: TestChannelConnectionInput,
  options?: DistributionClientOptions,
): Promise<ChannelConnectionTestResultDto> {
  return authorizedV2Request<ChannelConnectionTestResultDto>(
    `/brands/${encodeURIComponent(brandId)}/connections/${encodeURIComponent(connectionId)}/test`,
    {
      method: 'POST',
      body: input ?? {},
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

// ==================== B. 发布前校验与分发任务编排 ====================

export async function runArticlePreflight(
  articleId: string,
  input?: RunArticlePreflightRequest,
  options?: DistributionClientOptions,
): Promise<DistributionPreflightResult> {
  return authorizedV2Request<DistributionPreflightResult>(
    `/articles/${encodeURIComponent(articleId)}/preflight`,
    {
      method: 'POST',
      body: input ?? {},
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function listArticleDistributions(
  articleId: string,
  options?: DistributionClientOptions,
): Promise<ArticleDistributionsResponse> {
  return authorizedV2Request<ArticleDistributionsResponse>(
    `/articles/${encodeURIComponent(articleId)}/distributions`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function generateDistributionVariants(
  articleId: string,
  input: CreateDistributionVariantsInput,
  options?: DistributionIdempotentClientOptions,
): Promise<GenerateDistributionVariantsResponse> {
  const idempotencyKey = options?.idempotencyKey ?? createDistributionIdempotencyKey('var');
  return authorizedV2Request<GenerateDistributionVariantsResponse>(
    `/articles/${encodeURIComponent(articleId)}/distributions/variants`,
    {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function updateDistributionTask(
  taskId: string,
  input: UpdateDistributionTaskInput,
  options?: DistributionClientOptions,
): Promise<GeoDistributionTaskDto> {
  return authorizedV2Request<GeoDistributionTaskDto>(
    `/distributions/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function publishDistributionTask(
  taskId: string,
  input?: PublishDistributionTaskRequest,
  options?: DistributionIdempotentClientOptions,
): Promise<GeoDistributionTaskDto> {
  const idempotencyKey = options?.idempotencyKey ?? createDistributionIdempotencyKey('pub');
  const response = await authorizedV2RawRequest(
    `/distributions/${encodeURIComponent(taskId)}/publish`,
    {
      method: 'POST',
      body: input ?? {},
      headers: { 'Idempotency-Key': idempotencyKey },
      storage: options?.storage,
      signal: options?.signal,
    },
  );

  if (response.status === 422) {
    const text = await response.text();
    let parsed: { code?: unknown; msg?: unknown; data?: unknown } | null = null;
    try {
      parsed = text
        ? (JSON.parse(text) as { code?: unknown; msg?: unknown; data?: unknown })
        : null;
    } catch {
      parsed = null;
    }
    const code = typeof parsed?.code === 'number' ? parsed.code : -1;
    const message = typeof parsed?.msg === 'string' && parsed.msg ? parsed.msg : '发布前校验未通过';
    const payload = parsePreflightPayload(parsed?.data);
    throw new PreflightBlockedError(code, message, payload);
  }

  return unwrapEnvelope<GeoDistributionTaskDto>(response);
}

export async function createPrShareLink(
  taskId: string,
  input?: CreatePrShareLinkRequest,
  options?: DistributionClientOptions,
): Promise<PrShareLinkResponse> {
  return authorizedV2Request<PrShareLinkResponse>(
    `/distributions/${encodeURIComponent(taskId)}/pr-share`,
    {
      method: 'POST',
      body: input ?? {},
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function revokePrShareLink(
  taskId: string,
  options?: DistributionClientOptions,
): Promise<PrShareLinkRevokeResponse> {
  return authorizedV2Request<PrShareLinkRevokeResponse>(
    `/distributions/${encodeURIComponent(taskId)}/pr-share`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

// ==================== C. 抓取探针与定时复测日程 ====================

export async function triggerCrawlProbe(
  publishRecordId: string,
  options?: DistributionClientOptions,
): Promise<GeoPublishRecordDto> {
  return authorizedV2Request<GeoPublishRecordDto>(
    `/publish-records/${encodeURIComponent(publishRecordId)}/crawl-probe`,
    {
      method: 'POST',
      body: {},
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function updateRetestSchedules(
  publishRecordId: string,
  input: RetestScheduleConfigInput,
  options?: DistributionClientOptions,
): Promise<RetestSchedulesUpdateResponse> {
  return authorizedV2Request<RetestSchedulesUpdateResponse>(
    `/publish-records/${encodeURIComponent(publishRecordId)}/retest-schedules`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

// ==================== D. 免登录外部 PR 协作包公开接口（绝不走 authorizedV2Request） ====================

export async function fetchPublicPrPacket(
  token: string,
  options?: PublicPrPacketClientOptions,
): Promise<PublicPrPacketDto> {
  const base = resolvePublicV2Base(options?.apiBaseUrl);
  const response = await fetch(`${base}/public/pr-packets/${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: options?.signal,
  });
  return unwrapEnvelope<PublicPrPacketDto>(response);
}

export async function submitPublicPrPacket(
  token: string,
  input: PublicPrPacketSubmitInput,
  options?: PublicPrPacketClientOptions,
): Promise<PublicPrPacketSubmitResultDto> {
  const base = resolvePublicV2Base(options?.apiBaseUrl);
  const response = await fetch(`${base}/public/pr-packets/${encodeURIComponent(token)}/submit`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    credentials: 'omit',
    cache: 'no-store',
    signal: options?.signal,
  });
  return unwrapEnvelope<PublicPrPacketSubmitResultDto>(response);
}
