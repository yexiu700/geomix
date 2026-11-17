import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR, GALLERY_FILE_TOO_LARGE_MSG } from '@geomix/shared';
import { ApiError } from './api-error';

type ResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseLike>();
    const mapped = mapException(exception);
    if (mapped.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json({ code: mapped.code, msg: mapped.msg, data: null });
  }
}

function mapException(exception: unknown): {
  status: number;
  code: number;
  msg: string;
  retryAfterSeconds?: number;
} {
  if (exception instanceof ApiError) {
    return {
      status: exception.status,
      code: exception.code,
      msg: exception.message,
      retryAfterSeconds: exception.retryAfterSeconds,
    };
  }
  if (isNotFound(exception)) {
    return { status: 404, code: AUTH_ERROR.NOT_FOUND, msg: '不存在' };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const msg = httpMessage(exception);
    if (status === 413) {
      return {
        status,
        code: API_ERROR.BAD_REQUEST,
        msg: msg === 'File too large' ? GALLERY_FILE_TOO_LARGE_MSG : msg,
      };
    }
    if (status === 404) return { status, code: AUTH_ERROR.NOT_FOUND, msg };
    if (status === 401) return { status, code: AUTH_ERROR.UNAUTHORIZED, msg };
    if (status === 403) return { status, code: API_ERROR.TENANT_EXPIRED, msg };
    if (status >= 500) return { status, code: 50000, msg: '服务器错误' };
    return { status, code: API_ERROR.BAD_REQUEST, msg };
  }
  return { status: 500, code: 50000, msg: '服务器错误' };
}

function isNotFound(exception: unknown): boolean {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    'code' in exception &&
    (exception as { code?: unknown }).code === 'P2025'
  );
}

function httpMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('；');
  }
  return exception.message;
}
