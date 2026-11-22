'use client';

import {
  API_ERROR,
  type GeoBriefFromCitationUrlInput,
  type GeoBriefGenerateInput,
  type GeoBriefListResponse,
  type GeoBriefRecord,
  type GeoBriefSource,
  type GeoBriefStatus,
  type GeoBriefUpdateInput,
  type GeoMarket,
  type VisibilityObservationRecord,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import { GatewayApiError } from './envelope';
import type { SessionStorageLike } from './session';

export type BriefClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type FetchBriefsParams = {
  status?: GeoBriefStatus;
  sourceType?: GeoBriefSource;
  sourceRunId?: string;
  includeDismissed?: boolean;
  page?: number;
  pageSize?: number;
};

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(key, String(value));
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
}

export async function fetchBriefs(
  brandId: string,
  market: GeoMarket,
  params?: FetchBriefsParams,
  options?: BriefClientOptions,
): Promise<GeoBriefListResponse> {
  const query = buildQuery({
    market,
    status: params?.status,
    sourceType: params?.sourceType,
    sourceRunId: params?.sourceRunId,
    includeDismissed: params?.includeDismissed,
    page: params?.page,
    pageSize: params?.pageSize,
  });
  return authorizedV2Request<GeoBriefListResponse>(
    `/brands/${encodeURIComponent(brandId)}/briefs${query}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function getBrief(
  briefId: string,
  options?: BriefClientOptions,
): Promise<GeoBriefRecord> {
  return authorizedV2Request<GeoBriefRecord>(`/briefs/${encodeURIComponent(briefId)}`, {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export async function generateBrief(
  brandId: string,
  input: GeoBriefGenerateInput,
  options?: BriefClientOptions,
): Promise<GeoBriefRecord> {
  return authorizedV2Request<GeoBriefRecord>(
    `/brands/${encodeURIComponent(brandId)}/briefs/generate`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function createBriefFromCitationUrl(
  brandId: string,
  input: GeoBriefFromCitationUrlInput,
  options?: BriefClientOptions,
): Promise<GeoBriefRecord> {
  return authorizedV2Request<GeoBriefRecord>(
    `/brands/${encodeURIComponent(brandId)}/briefs/from-citation-url`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function isCitationCounterFallbackError(err: unknown): boolean {
  return (
    err instanceof GatewayApiError &&
    (err.status === 422 || err.code === API_ERROR.UPSTREAM_UNAVAILABLE)
  );
}

export async function updateBrief(
  briefId: string,
  input: GeoBriefUpdateInput,
  options?: BriefClientOptions,
): Promise<GeoBriefRecord> {
  return authorizedV2Request<GeoBriefRecord>(`/briefs/${encodeURIComponent(briefId)}`, {
    method: 'PATCH',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export async function dismissBrief(
  briefId: string,
  options?: BriefClientOptions,
): Promise<GeoBriefRecord> {
  return updateBrief(briefId, { status: 'DISMISSED' }, options);
}

/**
 * 根据单条 AI 回答观测信号自动推断最贴切的写作意见来源类型。
 */
export function deriveObservationBriefSource(
  obs: Pick<VisibilityObservationRecord, 'brandMentioned' | 'brandSentiment' | 'brandPosition'>,
): GeoBriefSource {
  if (!obs.brandMentioned) {
    return 'AUTO_GAP';
  }
  if (obs.brandSentiment === 'negative' || obs.brandSentiment === 'mixed') {
    return 'SENTIMENT_RISK';
  }
  return 'LOW_RANK';
}
