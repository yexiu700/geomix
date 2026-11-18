import { z } from 'zod';
import { IMAGE_MAX_INPUT_BYTES, IMAGE_WARN_WIDTH } from './adapters';
import { formatShanghaiDateTime } from './ux-foundation';

export const GALLERY_CATEGORY_TYPE_IMAGE = 1 as const;
export const GALLERY_PREVIEW_LIMIT = 3 as const;
export const GALLERY_THUMB_MAX_EDGE = 240 as const;
export const GALLERY_UPLOAD_MAX_FILES = 20 as const;
export const GALLERY_CATEGORY_NAME_MAX = 40 as const;
export const GALLERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const GALLERY_CATEGORY_EMPTY_MSG = '分类名称不能为空';
export const GALLERY_FILE_TOO_LARGE_MSG = '单张图片不能超过 100MB';
export const GALLERY_FILE_FORMAT_MSG = '仅支持 JPG、PNG、WebP 格式图片';
export const GALLERY_UPLOAD_NOTICE =
  '支持多选上传 JPG / PNG / WebP 图片（单次最多 20 张）；单张原始文件不超过 100 MB，上传后自动压缩至长边 ≤ 1600 px、体积 ≤ 1 MB 并去除元数据；宽度小于 500 px 仅作清晰度提示，不会阻断上传。';

export const GALLERY_ORIGINS = ['UPLOAD', 'AI_IMAGE'] as const;
export type MediaOriginName = (typeof GALLERY_ORIGINS)[number];

export type MediaStorageSummary = {
  used: string;
  limit: string;
  usedText: string;
  limitText: string;
};

export type MediaAssetPreview = {
  id: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
};

export type MediaCategoryRecord = {
  id: string;
  name: string;
  type: number;
  assetCount: number;
  previewAssets: MediaAssetPreview[];
  createdAt: string;
};

export type MediaCategoryListResponse = {
  items: MediaCategoryRecord[];
  total: number;
  page: number;
  pageSize: number;
  storage: MediaStorageSummary;
};

export type MediaAssetRecord = {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  origin: MediaOriginName;
  objectKey: string;
  originalName?: string | null;
  displayName?: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  usedCount: number;
  createdAt: string;
};

export type MediaAssetListResponse = {
  category: { id: string; name: string } | null;
  items: MediaAssetRecord[];
  total: number;
  page: number;
  pageSize: number;
  storage: MediaStorageSummary;
};

export type MediaUploadResultItem = {
  asset: MediaAssetRecord;
  originalName?: string | null;
  warning?: string;
};

export type MediaUploadResponse = {
  items: MediaUploadResultItem[];
  warnings: string[];
  storage: MediaStorageSummary;
};

export type MediaCategoryListQuery = {
  page: number;
  pageSize: number;
  q?: string;
};

export type MediaAssetListQuery = {
  page: number;
  pageSize: number;
  categoryId?: string;
  q?: string;
};

export function normalizeCategoryName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export const mediaCategoryWriteSchema = z.object({
  name: z
    .string({ required_error: GALLERY_CATEGORY_EMPTY_MSG })
    .transform((val) => normalizeCategoryName(val))
    .refine((val) => val.length > 0, GALLERY_CATEGORY_EMPTY_MSG)
    .refine(
      (val) => Array.from(val).length <= GALLERY_CATEGORY_NAME_MAX,
      `分类名称不能超过 ${GALLERY_CATEGORY_NAME_MAX} 个字符`,
    ),
});

export type MediaCategoryWriteInput = z.infer<typeof mediaCategoryWriteSchema>;

export const mediaBulkSchema = z.object({
  ids: z
    .array(z.string().regex(GALLERY_ID_PATTERN, '编号不正确'))
    .min(1, '请至少选择一条记录')
    .max(100),
});

export type MediaBulkInput = z.infer<typeof mediaBulkSchema>;

export const mediaUploadJsonFileSchema = z.object({
  filename: z.string().max(160).optional(),
  contentBase64: z.string().min(1, '图片内容不能为空'),
});

export const mediaUploadJsonSchema = z.object({
  categoryId: z.string().regex(GALLERY_ID_PATTERN, '素材分类不正确'),
  files: z
    .array(mediaUploadJsonFileSchema)
    .min(1, '请至少选择一张图片')
    .max(GALLERY_UPLOAD_MAX_FILES, `单次最多上传 ${GALLERY_UPLOAD_MAX_FILES} 张图片`),
});

export type MediaUploadJsonInput = z.infer<typeof mediaUploadJsonSchema>;

const ALLOWED_MIME_SET = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const ALLOWED_EXT_RE = /\.(jpe?g|png|webp)$/i;

export function validateClientUploadFile(input: {
  name: string;
  size: number;
  type?: string;
}): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, message: '图片文件为空' };
  }
  if (input.size > IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, message: GALLERY_FILE_TOO_LARGE_MSG };
  }
  const mime = (input.type ?? '').trim().toLowerCase();
  const hasAllowedMime = mime.length > 0 && ALLOWED_MIME_SET.has(mime);
  const hasAllowedExt = ALLOWED_EXT_RE.test(input.name.trim());
  if (!hasAllowedMime && !hasAllowedExt) {
    return { ok: false, message: GALLERY_FILE_FORMAT_MSG };
  }
  return { ok: true };
}

export function checkImageWidthWarning(width: number): string | undefined {
  if (Number.isFinite(width) && width > 0 && width < IMAGE_WARN_WIDTH) {
    return `图片宽度 ${width}px 小于建议值 ${IMAGE_WARN_WIDTH}px，仅提示不影响上传`;
  }
  return undefined;
}

export function formatGalleryBytes(value: bigint | number | string): string {
  let bytes: bigint;
  try {
    bytes = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return '0 B';
  }
  if (bytes <= 0n) return '0 B';
  const kb = 1024n;
  const mb = 1024n * 1024n;
  if (bytes >= mb) {
    const whole = bytes / mb;
    const rem = ((bytes % mb) * 10n) / mb;
    return rem === 0n ? `${whole} MB` : `${whole}.${rem} MB`;
  }
  if (bytes >= kb) {
    const whole = bytes / kb;
    const rem = ((bytes % kb) * 10n) / kb;
    return rem === 0n ? `${whole} KB` : `${whole}.${rem} KB`;
  }
  return `${bytes} B`;
}

export function buildStorageSummary(used: bigint, limit: bigint): MediaStorageSummary {
  return {
    used: used.toString(),
    limit: limit.toString(),
    usedText: formatGalleryBytes(used),
    limitText: formatGalleryBytes(limit),
  };
}

export function parseMediaCategoryListQuery(
  raw: Record<string, string | string[] | undefined>,
): MediaCategoryListQuery {
  const page = clampInt(firstStr(raw.page), 1, 10_000, 1);
  const pageSize = clampInt(firstStr(raw.pageSize), 1, 100, 20);
  const q = firstStr(raw.q)?.trim() || undefined;
  return { page, pageSize, q };
}

export function parseMediaAssetListQuery(
  raw: Record<string, string | string[] | undefined>,
): MediaAssetListQuery {
  const page = clampInt(firstStr(raw.page), 1, 10_000, 1);
  const pageSize = clampInt(firstStr(raw.pageSize), 1, 100, 20);
  const categoryIdRaw = firstStr(raw.categoryId)?.trim();
  const categoryId =
    categoryIdRaw && GALLERY_ID_PATTERN.test(categoryIdRaw) ? categoryIdRaw : undefined;
  const q = firstStr(raw.q)?.trim() || undefined;
  return { page, pageSize, categoryId, q };
}

export function mediaCategoryExportTable(rows: readonly MediaCategoryRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['序号', '素材分类', '素材数量', '创建时间'],
    rows: rows.map((row, idx) => [
      String(idx + 1),
      row.name,
      String(row.assetCount),
      formatShanghaiDateTime(row.createdAt, { seconds: true }),
    ]),
  };
}

function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export function sanitizeMediaOriginalName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripControlChars(raw).split(/[/\\]/).pop()?.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return Array.from(cleaned).slice(0, 160).join('');
}

export function safeMediaDisplayName(input: {
  id: string;
  origin: MediaOriginName;
  originalName?: string | null;
}): string {
  const clean = sanitizeMediaOriginalName(input.originalName);
  if (clean) return clean;
  const shortId = input.id.slice(-6) || 'image';
  return input.origin === 'AI_IMAGE' ? `AI生成图片-${shortId}.jpg` : `上传图片-${shortId}.jpg`;
}

export function mediaAssetExportTable(rows: readonly MediaAssetRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['序号', '素材分类', '素材名称', '尺寸', '大小', '使用次数', '创建时间'],
    rows: rows.map((row, idx) => [
      String(idx + 1),
      row.categoryName ?? '未归类',
      safeMediaDisplayName({
        id: row.id,
        origin: row.origin,
        originalName: row.originalName,
      }),
      `${row.width}×${row.height}`,
      formatGalleryBytes(row.bytes),
      String(row.usedCount),
      formatShanghaiDateTime(row.createdAt, { seconds: true }),
    ]),
  };
}

function firstStr(val: string | string[] | undefined): string | undefined {
  if (Array.isArray(val)) return val[0];
  return val;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
