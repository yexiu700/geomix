import {
  extractMissingFactSlots,
  replaceMissingFactSlot,
  type GeoArticleListResponse,
  type GeoArticleRecord,
  type GeoArticleStatus,
  type GeoArticleStreamInput,
  type GeoArticleUpdateInput,
  type GeoBatchCreateInput,
  type GeoBatchJobListResponse,
  type GeoBatchJobRecord,
  type GeoMarket,
  type GeoRewriteSectionInput,
  type GeoRewriteSectionResponse,
  type GeoStreamCompleteEvent,
  type GeoStreamDeltaEvent,
  type GeoStreamErrorEvent,
  type GeoStreamMetaEvent,
  type MissingFactSlot,
  type PromptPreferenceInput,
  type PromptPreferenceRecord,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import type { SessionStorageLike } from './session';
import { streamSsePost, type StreamSsePostResult } from './sse';

export { extractMissingFactSlots, replaceMissingFactSlot };
export type { MissingFactSlot };

export type StudioClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export function createStudioIdempotencyKey(prefix: 'art' | 'batch' | 'img' = 'art'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `geo_${prefix}_${rand}`;
}

export function fetchArticles(
  brandId: string,
  market: GeoMarket,
  params?: {
    status?: GeoArticleStatus;
    tag?: string;
    briefId?: string;
    batchJobId?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  },
  options?: StudioClientOptions,
): Promise<GeoArticleListResponse> {
  const qs = new URLSearchParams();
  qs.set('market', market);
  if (params?.status) qs.set('status', params.status);
  if (params?.tag?.trim()) qs.set('tag', params.tag.trim());
  if (params?.briefId) qs.set('briefId', params.briefId);
  if (params?.batchJobId) qs.set('batchJobId', params.batchJobId);
  if (params?.keyword?.trim()) qs.set('keyword', params.keyword.trim());
  if (params?.page) qs.set('page', String(params.page));
  if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
  return authorizedV2Request<GeoArticleListResponse>(
    `/brands/${encodeURIComponent(brandId)}/articles?${qs.toString()}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function getArticle(
  articleId: string,
  options?: StudioClientOptions,
): Promise<GeoArticleRecord> {
  return authorizedV2Request<GeoArticleRecord>(`/articles/${encodeURIComponent(articleId)}`, {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function updateArticle(
  articleId: string,
  input: GeoArticleUpdateInput,
  options?: StudioClientOptions,
): Promise<GeoArticleRecord> {
  return authorizedV2Request<GeoArticleRecord>(`/articles/${encodeURIComponent(articleId)}`, {
    method: 'PATCH',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function deleteArticle(
  articleId: string,
  options?: StudioClientOptions,
): Promise<{ deleted: boolean; id: string }> {
  return authorizedV2Request<{ deleted: boolean; id: string }>(
    `/articles/${encodeURIComponent(articleId)}`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export type StreamArticleHandlers = {
  onMeta?: (event: GeoStreamMetaEvent) => void;
  onDelta?: (event: GeoStreamDeltaEvent) => void;
  onComplete?: (event: GeoStreamCompleteEvent) => void;
  onErrorEvent?: (event: GeoStreamErrorEvent) => void;
};

export function streamGenerateArticle(
  brandId: string,
  input: GeoArticleStreamInput,
  handlers: StreamArticleHandlers,
  options?: StudioClientOptions & { idempotencyKey?: string },
): Promise<StreamSsePostResult> {
  const idempotencyKey = options?.idempotencyKey ?? createStudioIdempotencyKey('art');
  return streamSsePost(`/brands/${encodeURIComponent(brandId)}/articles/stream`, {
    body: input,
    idempotencyKey,
    signal: options?.signal,
    storage: options?.storage,
    onEvent: (frame) => {
      if (!frame.data || typeof frame.data !== 'object') return;
      if (frame.event === 'meta') {
        handlers.onMeta?.(frame.data as GeoStreamMetaEvent);
      } else if (frame.event === 'delta') {
        handlers.onDelta?.(frame.data as GeoStreamDeltaEvent);
      } else if (frame.event === 'complete') {
        handlers.onComplete?.(frame.data as GeoStreamCompleteEvent);
      } else if (frame.event === 'error') {
        handlers.onErrorEvent?.(frame.data as GeoStreamErrorEvent);
      }
    },
  });
}

export function rewriteArticleSection(
  articleId: string,
  input: GeoRewriteSectionInput,
  options?: StudioClientOptions,
): Promise<GeoRewriteSectionResponse> {
  return authorizedV2Request<GeoRewriteSectionResponse>(
    `/articles/${encodeURIComponent(articleId)}/rewrite-section`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function createBatchJob(
  brandId: string,
  input: GeoBatchCreateInput,
  idempotencyKey: string,
  options?: StudioClientOptions,
): Promise<GeoBatchJobRecord> {
  return authorizedV2Request<GeoBatchJobRecord>(
    `/brands/${encodeURIComponent(brandId)}/articles/batch`,
    {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchBatchJobs(
  brandId: string,
  market: GeoMarket,
  options?: StudioClientOptions,
): Promise<GeoBatchJobListResponse> {
  const qs = new URLSearchParams({ market });
  return authorizedV2Request<GeoBatchJobListResponse>(
    `/brands/${encodeURIComponent(brandId)}/batch-jobs?${qs.toString()}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function getBatchJob(
  brandId: string,
  jobId: string,
  options?: StudioClientOptions,
): Promise<GeoBatchJobRecord> {
  return authorizedV2Request<GeoBatchJobRecord>(
    `/brands/${encodeURIComponent(brandId)}/batch-jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function getPromptPreferences(
  options?: StudioClientOptions,
): Promise<PromptPreferenceRecord> {
  return authorizedV2Request<PromptPreferenceRecord>('/prompt-preferences', {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function savePromptPreferences(
  input: PromptPreferenceInput,
  options?: StudioClientOptions,
): Promise<PromptPreferenceRecord> {
  return authorizedV2Request<PromptPreferenceRecord>('/prompt-preferences', {
    method: 'PUT',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

/**
 * 安全合并写作台回填事实到既有 BrandFact 内容中（不覆盖原内容，避免重复追加）。
 */
export function mergeFactFeedbackContent(
  existingContent: string | undefined,
  hint: string,
  value: string,
): string {
  const cleanValue = value.trim();
  const cleanHint = hint.trim().replace(/^如\s*/, '');
  const entry = cleanHint ? `- ${cleanHint}：${cleanValue}` : `- ${cleanValue}`;
  const base = (existingContent ?? '').trim();
  if (!base) return entry;
  if (base.includes(cleanValue)) return base;
  return `${base}\n${entry}`;
}

export function buildMarkdownImageToken(alt: string, url: string): string {
  const safeAlt =
    alt
      .replace(/[\r\n[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || '产品配图';
  return `![${safeAlt}](${url.trim()})`;
}

export function insertMarkdownAtCursor(
  markdown: string,
  snippet: string,
  cursorOffset?: number | null,
): string {
  const cleanSnippet = snippet.trim();
  if (!cleanSnippet) return markdown;
  if (
    typeof cursorOffset === 'number' &&
    Number.isInteger(cursorOffset) &&
    cursorOffset >= 0 &&
    cursorOffset <= markdown.length
  ) {
    const before = markdown.slice(0, cursorOffset).replace(/\n+$/, '');
    const after = markdown.slice(cursorOffset).replace(/^\n+/, '');
    return [before, cleanSnippet, after].filter((part) => part.length > 0).join('\n\n');
  }
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n\n${cleanSnippet}` : cleanSnippet;
}

/**
 * 仅用于客户端实时预览：将相对签名图片路径 /api/... 重写为完整 API 源地址，
 * 避免 Next.js :3000 预览发出 404 请求，同时保持保存至后端的 Markdown 路径可移植。
 */
function escapeHtmlAttrUrl(raw: string): string {
  return raw.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function rewritePreviewRelativeMediaUrls(
  html: string,
  resolveUrl: (raw: string) => string,
): string {
  return html.replace(
    /(<img\b[^>]*\bsrc=")(\/api\/[^"]+)(")/gi,
    (_match, prefix: string, relPath: string, suffix: string) =>
      `${prefix}${escapeHtmlAttrUrl(resolveUrl(relPath))}${suffix}`,
  );
}
