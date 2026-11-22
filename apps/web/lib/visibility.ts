import {
  enginesForMarket,
  type CitationSourceKind,
  type CrudPageSize,
  type GeoMarket,
  type TaskStatusName,
  type VisibilityCitationListResponse,
  type VisibilityEngineAvailabilityItem,
  type VisibilityEngineAvailabilityResponse,
  type VisibilityEngineKey,
  type VisibilityOpportunitiesResponse,
  type VisibilityOverviewResponse,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
  type VisibilityRunV2CreateInput,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import type { SessionStorageLike } from './session';

export type VisibilityClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type FetchVisibilityOverviewParams = {
  days?: number;
  engine?: VisibilityEngineKey;
  from?: string;
  to?: string;
};

export type FetchVisibilityRunsParams = {
  page?: number;
  pageSize?: CrudPageSize;
  status?: TaskStatusName;
  keyword?: string;
};

export type FetchVisibilityCitationsParams = {
  days?: number;
  sourceKind?: CitationSourceKind;
  engine?: VisibilityEngineKey;
  page?: number;
  pageSize?: CrudPageSize;
};

export type FetchVisibilityOpportunitiesParams = {
  days?: number;
  engine?: VisibilityEngineKey;
  limit?: number;
};

function buildBrandVisPath(brandId: string, suffix: string, query?: URLSearchParams): string {
  const base = `/brands/${encodeURIComponent(brandId)}/visibility${suffix}`;
  const qs = query?.toString() ?? '';
  return qs ? `${base}?${qs}` : base;
}

export function fetchVisibilityOverview(
  brandId: string,
  market: GeoMarket,
  daysOrParams?: number | FetchVisibilityOverviewParams,
  options?: VisibilityClientOptions,
): Promise<VisibilityOverviewResponse> {
  const params: FetchVisibilityOverviewParams =
    typeof daysOrParams === 'number' ? { days: daysOrParams } : (daysOrParams ?? {});
  const query = new URLSearchParams({ market });
  if (params.days !== undefined) query.set('days', String(params.days));
  if (params.engine) query.set('engine', params.engine);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);

  return authorizedV2Request<VisibilityOverviewResponse>(
    buildBrandVisPath(brandId, '/overview', query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchVisibilityEngines(
  brandId: string,
  market: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<VisibilityEngineAvailabilityResponse> {
  const query = new URLSearchParams({ market });
  return authorizedV2Request<VisibilityEngineAvailabilityResponse>(
    buildBrandVisPath(brandId, '/engines', query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchVisibilityRuns(
  brandId: string,
  market: GeoMarket,
  params?: FetchVisibilityRunsParams,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunListResponse> {
  const query = new URLSearchParams({ market });
  if (params?.page !== undefined) query.set('page', String(params.page));
  if (params?.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params?.status) query.set('status', params.status);
  if (params?.keyword?.trim()) query.set('keyword', params.keyword.trim());

  return authorizedV2Request<VisibilityRunListResponse>(
    buildBrandVisPath(brandId, '/runs', query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function createVisibilityRun(
  brandId: string,
  payload: VisibilityRunV2CreateInput,
  idempotencyKey: string,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunDetailRecord> {
  return authorizedV2Request<VisibilityRunDetailRecord>(buildBrandVisPath(brandId, '/runs'), {
    method: 'POST',
    body: payload,
    headers: { 'Idempotency-Key': idempotencyKey },
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function fetchVisibilityRunDetail(
  brandId: string,
  runId: string,
  market?: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunDetailRecord> {
  const query = market ? new URLSearchParams({ market }) : undefined;
  return authorizedV2Request<VisibilityRunDetailRecord>(
    buildBrandVisPath(brandId, `/runs/${encodeURIComponent(runId)}`, query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function pauseVisibilityRun(
  brandId: string,
  runId: string,
  market: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunDetailRecord> {
  const query = new URLSearchParams({ market });
  return authorizedV2Request<VisibilityRunDetailRecord>(
    buildBrandVisPath(brandId, `/runs/${encodeURIComponent(runId)}/pause`, query),
    {
      method: 'POST',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function resumeVisibilityRun(
  brandId: string,
  runId: string,
  market: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunDetailRecord> {
  const query = new URLSearchParams({ market });
  return authorizedV2Request<VisibilityRunDetailRecord>(
    buildBrandVisPath(brandId, `/runs/${encodeURIComponent(runId)}/resume`, query),
    {
      method: 'POST',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function cancelVisibilityRun(
  brandId: string,
  runId: string,
  market: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<VisibilityRunDetailRecord> {
  const query = new URLSearchParams({ market });
  return authorizedV2Request<VisibilityRunDetailRecord>(
    buildBrandVisPath(brandId, `/runs/${encodeURIComponent(runId)}/cancel`, query),
    {
      method: 'POST',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function deleteVisibilityRun(
  brandId: string,
  runId: string,
  market: GeoMarket,
  options?: VisibilityClientOptions,
): Promise<{ deleted: number }> {
  const query = new URLSearchParams({ market });
  return authorizedV2Request<{ deleted: number }>(
    buildBrandVisPath(brandId, `/runs/${encodeURIComponent(runId)}`, query),
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchVisibilityCitations(
  brandId: string,
  market: GeoMarket,
  params?: FetchVisibilityCitationsParams,
  options?: VisibilityClientOptions,
): Promise<VisibilityCitationListResponse> {
  const query = new URLSearchParams({ market });
  if (params?.days !== undefined) query.set('days', String(params.days));
  if (params?.sourceKind) query.set('sourceKind', params.sourceKind);
  if (params?.engine) query.set('engine', params.engine);
  if (params?.page !== undefined) query.set('page', String(params.page));
  if (params?.pageSize !== undefined) query.set('pageSize', String(params.pageSize));

  return authorizedV2Request<VisibilityCitationListResponse>(
    buildBrandVisPath(brandId, '/citations', query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchVisibilityOpportunities(
  brandId: string,
  market: GeoMarket,
  params?: FetchVisibilityOpportunitiesParams,
  options?: VisibilityClientOptions,
): Promise<VisibilityOpportunitiesResponse> {
  const query = new URLSearchParams({ market });
  if (params?.days !== undefined) query.set('days', String(params.days));
  if (params?.engine) query.set('engine', params.engine);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));

  return authorizedV2Request<VisibilityOpportunitiesResponse>(
    buildBrandVisPath(brandId, '/opportunities', query),
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function createVisibilityIdempotencyKey(): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;
  return `vrun_${Date.now()}_${randomPart}`;
}

export function parsePromptLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

export function filterEnginesForMarket(
  engines: readonly VisibilityEngineAvailabilityItem[],
  market: GeoMarket,
): VisibilityEngineAvailabilityItem[] {
  const allowedOrder = enginesForMarket(market);
  const byKey = new Map<string, VisibilityEngineAvailabilityItem>();
  for (const eng of engines) {
    byKey.set(eng.key, eng);
  }
  const filtered: VisibilityEngineAvailabilityItem[] = [];
  for (const key of allowedOrder) {
    const found = byKey.get(key);
    if (found) filtered.push(found);
  }
  return filtered;
}

export function isSafeHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
