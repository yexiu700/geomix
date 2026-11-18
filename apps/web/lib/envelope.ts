import type { Envelope } from './api';

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type UnwrapEnvelopeOptions = {
  createError?: (status: number, code: number, message: string) => Error;
  requireData?: boolean;
};

export function defaultNonJsonErrorMessage(status: number): string {
  if (status === 413) {
    return '上传文件过大，超出服务器或网关限制';
  }
  if (status === 504) {
    return '服务响应超时，请稍后重试';
  }
  if (status === 502) {
    return '服务响应超时（HTTP 502），请稍后重试';
  }
  if (status >= 500) {
    return `服务暂时不可用（HTTP ${status}）`;
  }
  return '服务返回异常响应，请稍后重试';
}

export async function unwrapEnvelope<T>(
  response: Response,
  options?: UnwrapEnvelopeOptions,
): Promise<T> {
  const makeError =
    options?.createError ??
    ((status: number, code: number, message: string) => new GatewayApiError(status, code, message));
  const requireData = options?.requireData ?? true;

  const text = await response.text();
  if (!text) {
    throw makeError(response.status, -1, '服务响应为空');
  }

  let json: Envelope<T> | null = null;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    json = null;
  }

  if (!json || typeof json !== 'object') {
    throw makeError(response.status, -1, defaultNonJsonErrorMessage(response.status));
  }

  const missingData = requireData && (json.data === null || json.data === undefined);
  if (!response.ok || json.code !== 0 || missingData) {
    const code = typeof json.code === 'number' ? json.code : -1;
    const message = typeof json.msg === 'string' && json.msg ? json.msg : '操作失败';
    throw makeError(response.status, code, message);
  }

  return json.data;
}

export function createEnvelopeUnwrapper(
  ErrorClass: new (status: number, code: number, message: string) => Error = GatewayApiError,
  options?: { requireData?: boolean },
): <T>(response: Response) => Promise<T> {
  return <T>(response: Response) =>
    unwrapEnvelope<T>(response, {
      createError: (status, code, message) => new ErrorClass(status, code, message),
      requireData: options?.requireData,
    });
}

export function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1]?.trim() || fallback;
}
