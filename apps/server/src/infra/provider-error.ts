import { API_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';

export const PROVIDER_KIND = {
  CONTRACT: 'contract',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  RATE_LIMIT: 'rate_limit',
  UPSTREAM: 'upstream',
  AUTH: 'auth',
  SSRF: 'ssrf',
  TOO_LARGE: 'too_large',
  NOT_PUBLIC: 'not_public',
  ROBOTS: 'robots',
  CONFLICT: 'conflict',
} as const;

export type ProviderKind = (typeof PROVIDER_KIND)[keyof typeof PROVIDER_KIND];

const RETRYABLE = new Set<ProviderKind>([
  PROVIDER_KIND.TIMEOUT,
  PROVIDER_KIND.RATE_LIMIT,
  PROVIDER_KIND.UPSTREAM,
]);

/**
 * 适配层错误。message 可以返回给调用方，不能包含密钥、内网地址或解析出来的私有 IP。
 * reason 只给日志和测试，用来区分拦截原因。
 */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: ProviderKind,
    message: string,
    readonly reason: string = kind,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}

export function providerToApi(error: ProviderError): ApiError {
  if (
    error.kind === PROVIDER_KIND.SSRF ||
    error.kind === PROVIDER_KIND.NOT_PUBLIC ||
    error.kind === PROVIDER_KIND.ROBOTS
  ) {
    return new ApiError(422, API_ERROR.UPSTREAM_UNAVAILABLE, '无法公开访问');
  }
  if (error.kind === PROVIDER_KIND.CONTRACT || error.kind === PROVIDER_KIND.CONFLICT) {
    return new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
  }
  if (error.kind === PROVIDER_KIND.TOO_LARGE) {
    return new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
  }
  if (error.kind === PROVIDER_KIND.CANCELLED) {
    return new ApiError(400, API_ERROR.BAD_REQUEST, '请求已取消');
  }
  return new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, '外部服务暂时不可用');
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
