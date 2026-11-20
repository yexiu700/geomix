import type {
  BrandListResponse,
  BrandRecord,
  CreateBrandInput,
  GeoMarket,
  UpsertBrandMarketInput,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import type { SessionStorageLike } from './session';

export type BrandClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export function listBrands(options?: BrandClientOptions): Promise<BrandListResponse> {
  return authorizedV2Request<BrandListResponse>('/brands', {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function createBrand(
  input: CreateBrandInput,
  options?: BrandClientOptions,
): Promise<BrandRecord> {
  return authorizedV2Request<BrandRecord>('/brands', {
    method: 'POST',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function enableBrandMarket(
  brandId: string,
  market: GeoMarket,
  input: UpsertBrandMarketInput = {},
  options?: BrandClientOptions,
): Promise<BrandRecord> {
  return authorizedV2Request<BrandRecord>(
    `/brands/${encodeURIComponent(brandId)}/markets/${encodeURIComponent(market)}`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}
