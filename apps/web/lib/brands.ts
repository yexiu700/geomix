import {
  requiresBrandFactVectorIndex,
  type BrandDeleteResponse,
  type BrandFactsResponse,
  type BrandListResponse,
  type BrandMediaAssetRecord,
  type BrandMediaDeleteResponse,
  type BrandMediaListResponse,
  type BrandMediaUploadResponse,
  type BrandProductLineDeleteResponse,
  type BrandProductLineDto,
  type BrandProductLineListResponse,
  type BrandRecord,
  type CreateBrandInput,
  type CreateProductLineInput,
  type ExtractBrandFactsInput,
  type ExtractBrandFactsResponse,
  type GeoMarket,
  type InlineAiImageGenInput,
  type UpdateBrandInput,
  type UpdateBrandMarketInput,
  type UpdateBrandMediaInput,
  type UpdateProductLineInput,
  type UpsertBrandFactsInput,
  type UpsertBrandMarketInput,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import { apiBase, type SessionStorageLike } from './session';

export type {
  BrandDeleteResponse,
  BrandFactsResponse,
  BrandMediaDeleteResponse,
  BrandMediaListResponse,
  BrandMediaUploadResponse,
  BrandProductLineDeleteResponse,
  BrandProductLineDto,
  BrandProductLineListResponse,
  ExtractBrandFactsResponse,
};

export type BrandClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type ExtractBrandFactsRequest =
  ExtractBrandFactsInput | { file: File; sourceType?: 'DOC_UPLOAD' };

function normalizeFactsResponse(brandId: string, raw: BrandFactsResponse): BrandFactsResponse {
  const items = Array.isArray(raw.items) ? raw.items : [];
  const totalChars =
    typeof raw.totalChars === 'number'
      ? raw.totalChars
      : items.reduce((sum, item) => sum + item.content.length, 0);
  const maxSingle = items.reduce((max, item) => Math.max(max, item.content.length), 0);
  const vectorIndexRequired =
    typeof raw.vectorIndexRequired === 'boolean'
      ? raw.vectorIndexRequired
      : requiresBrandFactVectorIndex(totalChars) || requiresBrandFactVectorIndex(maxSingle);
  const vectorIndexed =
    typeof raw.vectorIndexed === 'boolean'
      ? raw.vectorIndexed
      : items.some((item) => item.indexStatus === 'READY');

  return {
    brandId: raw.brandId || brandId,
    truthAgreementSignedAt: raw.truthAgreementSignedAt ?? null,
    totalChars,
    vectorIndexRequired,
    vectorIndexed,
    items,
  };
}

export function listBrands(options?: BrandClientOptions): Promise<BrandListResponse> {
  return authorizedV2Request<BrandListResponse>('/brands', {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function getBrand(brandId: string, options?: BrandClientOptions): Promise<BrandRecord> {
  return authorizedV2Request<BrandRecord>(`/brands/${encodeURIComponent(brandId)}`, {
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

export function updateBrand(
  brandId: string,
  input: UpdateBrandInput,
  options?: BrandClientOptions,
): Promise<BrandRecord> {
  return authorizedV2Request<BrandRecord>(`/brands/${encodeURIComponent(brandId)}`, {
    method: 'PATCH',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function deleteBrand(
  brandId: string,
  options?: BrandClientOptions,
): Promise<BrandDeleteResponse> {
  return authorizedV2Request<BrandDeleteResponse>(`/brands/${encodeURIComponent(brandId)}`, {
    method: 'DELETE',
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

export function updateBrandMarket(
  brandId: string,
  market: GeoMarket,
  input: UpdateBrandMarketInput,
  options?: BrandClientOptions,
): Promise<BrandRecord> {
  return authorizedV2Request<BrandRecord>(
    `/brands/${encodeURIComponent(brandId)}/markets/${encodeURIComponent(market)}`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function listBrandProductLines(
  brandId: string,
  options?: BrandClientOptions,
): Promise<BrandProductLineListResponse> {
  return authorizedV2Request<BrandProductLineListResponse>(
    `/brands/${encodeURIComponent(brandId)}/product-lines`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function createBrandProductLine(
  brandId: string,
  input: CreateProductLineInput,
  options?: BrandClientOptions,
): Promise<BrandProductLineDto> {
  return authorizedV2Request<BrandProductLineDto>(
    `/brands/${encodeURIComponent(brandId)}/product-lines`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function updateBrandProductLine(
  brandId: string,
  lineId: string,
  input: UpdateProductLineInput,
  options?: BrandClientOptions,
): Promise<BrandProductLineDto> {
  return authorizedV2Request<BrandProductLineDto>(
    `/brands/${encodeURIComponent(brandId)}/product-lines/${encodeURIComponent(lineId)}`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function deleteBrandProductLine(
  brandId: string,
  lineId: string,
  options?: BrandClientOptions,
): Promise<BrandProductLineDeleteResponse> {
  return authorizedV2Request<BrandProductLineDeleteResponse>(
    `/brands/${encodeURIComponent(brandId)}/product-lines/${encodeURIComponent(lineId)}`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function getBrandFacts(
  brandId: string,
  options?: BrandClientOptions & { productLineId?: string | null },
): Promise<BrandFactsResponse> {
  const qs = new URLSearchParams();
  const trimmedLineId = options?.productLineId?.trim();
  if (trimmedLineId) {
    qs.set('productLineId', trimmedLineId);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await authorizedV2Request<BrandFactsResponse>(
    `/brands/${encodeURIComponent(brandId)}/facts${suffix}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
  return normalizeFactsResponse(brandId, res);
}

export async function saveBrandFacts(
  brandId: string,
  input: UpsertBrandFactsInput,
  options?: BrandClientOptions,
): Promise<BrandFactsResponse> {
  const res = await authorizedV2Request<BrandFactsResponse>(
    `/brands/${encodeURIComponent(brandId)}/facts`,
    {
      method: 'PUT',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
  return normalizeFactsResponse(brandId, res);
}

export function extractBrandFacts(
  brandId: string,
  input: ExtractBrandFactsRequest,
  options?: BrandClientOptions,
): Promise<ExtractBrandFactsResponse> {
  const path = `/brands/${encodeURIComponent(brandId)}/facts/extract`;
  if ('file' in input) {
    const formData = new FormData();
    formData.append('file', input.file);
    formData.append('sourceType', input.sourceType ?? 'DOC_UPLOAD');
    return authorizedV2Request<ExtractBrandFactsResponse>(path, {
      method: 'POST',
      body: formData,
      storage: options?.storage,
      signal: options?.signal,
    });
  }
  return authorizedV2Request<ExtractBrandFactsResponse>(path, {
    method: 'POST',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function listBrandMedia(
  brandId: string,
  options?: BrandClientOptions,
): Promise<BrandMediaListResponse> {
  return authorizedV2Request<BrandMediaListResponse>(
    `/brands/${encodeURIComponent(brandId)}/media`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function uploadBrandMedia(
  brandId: string,
  input: { file: File; title?: string },
  options?: BrandClientOptions,
): Promise<BrandMediaUploadResponse> {
  const formData = new FormData();
  formData.append('file', input.file);
  if (input.title && input.title.trim()) {
    formData.append('title', input.title.trim());
  }
  return authorizedV2Request<BrandMediaUploadResponse>(
    `/brands/${encodeURIComponent(brandId)}/media`,
    {
      method: 'POST',
      body: formData,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function updateBrandMediaAlt(
  brandId: string,
  mediaId: string,
  input: UpdateBrandMediaInput,
  options?: BrandClientOptions,
): Promise<BrandMediaAssetRecord> {
  return authorizedV2Request<BrandMediaAssetRecord>(
    `/brands/${encodeURIComponent(brandId)}/media/${encodeURIComponent(mediaId)}`,
    {
      method: 'PATCH',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function deleteBrandMedia(
  brandId: string,
  mediaId: string,
  options?: BrandClientOptions,
): Promise<BrandMediaDeleteResponse> {
  return authorizedV2Request<BrandMediaDeleteResponse>(
    `/brands/${encodeURIComponent(brandId)}/media/${encodeURIComponent(mediaId)}`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function generateBrandAiImage(
  brandId: string,
  input: InlineAiImageGenInput,
  idempotencyKey: string,
  options?: BrandClientOptions,
): Promise<BrandMediaAssetRecord> {
  return authorizedV2Request<BrandMediaAssetRecord>(
    `/brands/${encodeURIComponent(brandId)}/media/ai-gen`,
    {
      method: 'POST',
      body: input,
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function resolveMediaUrl(pathOrUrl: string | null | undefined): string {
  const raw = (pathOrUrl ?? '').trim();
  if (!raw) return '';
  if (/^(?:https?:\/\/|data:|blob:)/i.test(raw)) {
    return raw;
  }
  const origin = apiBase().replace(/\/api(?:\/v\d+)?\/?$/i, '');
  if (!origin) return raw;
  return raw.startsWith('/') ? `${origin}${raw}` : `${origin}/${raw}`;
}
