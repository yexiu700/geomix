import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  BRAND_ID_PATTERN,
  BRAND_MEDIA_FILE_TOO_LARGE_MSG,
  GEO_MARKETS,
  IMAGE_MAX_INPUT_BYTES,
  type GeoMarket,
} from '@geomix/shared';
import { asHttpRequest } from '../auth/http-request';
import { ApiError } from '../common/api-error';

export const GALLERY_MAX_INPUT_BYTES_TOKEN = Symbol('GALLERY_MAX_INPUT_BYTES_TOKEN');

export function readGalleryMaxInputBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GALLERY_MAX_INPUT_BYTES?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return IMAGE_MAX_INPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return IMAGE_MAX_INPUT_BYTES;
  return Math.min(parsed, IMAGE_MAX_INPUT_BYTES);
}

export function requireAuth(request: unknown): { tenantId: string; userId: string } {
  const http = asHttpRequest(request);
  if (!http.auth) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return { tenantId: http.auth.tenantId, userId: http.auth.userId };
}

export function parseBrandId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '品牌编号不正确');
  }
  const trimmed = raw.trim();
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '品牌编号不正确');
  }
  return trimmed;
}

export function parseMediaId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '图片编号不正确');
  }
  const trimmed = raw.trim();
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '图片编号不正确');
  }
  return trimmed;
}

export function parseProductLineId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
  }
  const trimmed = raw.trim();
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
  }
  return trimmed;
}

export function parseOptionalProductLineId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
  }
  return trimmed;
}

export function parseMarket(raw: unknown): GeoMarket {
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '市场参数仅支持 CN 或 GLOBAL');
  }
  const upper = raw.trim().toUpperCase();
  if ((GEO_MARKETS as readonly string[]).includes(upper)) {
    return upper as GeoMarket;
  }
  throw new ApiError(400, API_ERROR.BAD_REQUEST, '市场参数仅支持 CN 或 GLOBAL');
}

export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return null;
  return cleaned.slice(0, 64);
}

/**
 * 从 StorageService 的完整对象键 `tenants/<tenantId>/<name>` 中安全提取相对对象名。
 */
export function objectNameFromKey(tenantId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  const prefix = `tenants/${tenantId}/`;
  if (key.startsWith(prefix)) {
    const rest = key.slice(prefix.length).trim();
    return rest || null;
  }
  if (!key.includes('/')) {
    return key.trim() || null;
  }
  return null;
}

/**
 * 修正 multer 在 multipart/form-data 下以 latin1 解码 UTF-8 文件名导致的中文乱码。
 */
export function decodeUploadFilename(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const decoded = Buffer.from(trimmed, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD') && /[^\x00-\x7f]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // Fall back to raw filename
  }
  return trimmed;
}

export type UploadedFileLike = {
  fieldname?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
};

type ResponseLike = {
  status(code: number): { json(body: unknown): void };
  setHeader(name: string, value: string): void;
};

/**
 * 统一将 multer / PayloadTooLarge 上传异常映射为 GeoMix 标准错误信封。
 */
@Catch()
export class BrandUploadExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseLike>();

    if (exception instanceof ApiError) {
      if (exception.retryAfterSeconds !== undefined) {
        response.setHeader('Retry-After', String(exception.retryAfterSeconds));
      }
      response
        .status(exception.status)
        .json({ code: exception.code, msg: exception.message, data: null });
      return;
    }

    if (isMulterError(exception)) {
      if (exception.code === 'LIMIT_FILE_SIZE') {
        const req = host.switchToHttp().getRequest<{ url?: string }>();
        const isFactExtract = typeof req?.url === 'string' && req.url.includes('/facts/extract');
        const msg = isFactExtract
          ? `产品资料文件不能超过 ${Math.round(BRAND_FACT_EXTRACT_MAX_FILE_BYTES / (1024 * 1024))}MB`
          : BRAND_MEDIA_FILE_TOO_LARGE_MSG;
        response.status(413).json({ code: API_ERROR.BAD_REQUEST, msg, data: null });
        return;
      }
      if (exception.code === 'LIMIT_FILE_COUNT' || exception.code === 'LIMIT_UNEXPECTED_FILE') {
        response
          .status(400)
          .json({ code: API_ERROR.BAD_REQUEST, msg: '上传文件数量超出限制', data: null });
        return;
      }
      response
        .status(400)
        .json({ code: API_ERROR.BAD_REQUEST, msg: '上传表单格式不正确', data: null });
      return;
    }

    if (exception instanceof PayloadTooLargeException) {
      response
        .status(413)
        .json({ code: API_ERROR.BAD_REQUEST, msg: BRAND_MEDIA_FILE_TOO_LARGE_MSG, data: null });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const msg =
        typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object' && 'message' in raw
            ? Array.isArray((raw as { message?: unknown }).message)
              ? (raw as { message: unknown[] }).message.map(String).join('；') || exception.message
              : String((raw as { message?: unknown }).message ?? exception.message)
            : exception.message;
      const code =
        status === 401
          ? AUTH_ERROR.UNAUTHORIZED
          : status === 403
            ? API_ERROR.TENANT_EXPIRED
            : status === 404
              ? AUTH_ERROR.NOT_FOUND
              : status >= 500
                ? 50000
                : API_ERROR.BAD_REQUEST;
      response.status(status).json({ code, msg, data: null });
      return;
    }

    response.status(500).json({ code: 50000, msg: '服务器错误', data: null });
  }
}

function isMulterError(error: unknown): error is Error & { name: 'MulterError'; code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'MulterError' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
