import { authorizedV2RawRequest } from './api';
import { GatewayApiError, defaultNonJsonErrorMessage } from './envelope';
import type { SessionStorageLike } from './session';

export type SseFrame = {
  event: string;
  rawData: string;
  data: unknown;
};

export type StreamSsePostOptions = {
  body: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  storage?: SessionStorageLike;
  onEvent: (frame: SseFrame) => void;
};

export type StreamSsePostResult = {
  aborted: boolean;
  receivedEvents: number;
};

/**
 * 解析单帧 SSE 文本（支持注释行 `:`、多行 `data:` 与 JSON 自动解码）。
 */
export function parseSseFrame(rawFrame: string): SseFrame | null {
  const lines = rawFrame.split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('event:')) {
      const value = rawLine.slice(6).trim();
      if (value) event = value;
      continue;
    }
    if (rawLine.startsWith('data:')) {
      // Per WHATWG SSE spec, strip at most one leading space after "data:".
      dataLines.push(rawLine.startsWith('data: ') ? rawLine.slice(6) : rawLine.slice(5));
    }
  }

  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData) as unknown;
  } catch {
    data = rawData;
  }
  return { event, rawData, data };
}

function throwEnvelopeError(status: number, rawText: string): never {
  try {
    const parsed = JSON.parse(rawText) as { code?: unknown; msg?: unknown };
    if (parsed && typeof parsed === 'object') {
      const code = typeof parsed.code === 'number' ? parsed.code : -1;
      const msg =
        typeof parsed.msg === 'string' && parsed.msg.trim()
          ? parsed.msg.trim()
          : defaultNonJsonErrorMessage(status);
      throw new GatewayApiError(status, code, msg);
    }
  } catch (err) {
    if (err instanceof GatewayApiError) throw err;
  }
  throw new GatewayApiError(status, -1, defaultNonJsonErrorMessage(status));
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (
    err &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  ) {
    return true;
  }
  return false;
}

/**
 * 基于 `authorizedV2RawRequest` 的增量 UTF-8 POST SSE 流式消费器。
 * - 自动继承 JWT 续期与单次 401 重试
 * - 正确处理跨 chunk 的多字节中文 UTF-8 与拆分 `\r\n` 边界
 * - 非 SSE JSON 错误响应统一抛出 `GatewayApiError(status, code, msg)`
 * - 支持 `AbortController` 干净中断并释放 reader
 */
export async function streamSsePost(
  path: string,
  options: StreamSsePostOptions,
): Promise<StreamSsePostResult> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    ...options.headers,
  };

  let response: Response;
  try {
    response = await authorizedV2RawRequest(path, {
      method: 'POST',
      body: options.body,
      headers,
      signal: options.signal,
      storage: options.storage,
    });
  } catch (err) {
    if (isAbortError(err, options.signal)) {
      return { aborted: true, receivedEvents: 0 };
    }
    throw err;
  }

  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    throwEnvelopeError(response.status, rawText);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    const rawText = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(rawText) as { code?: unknown; msg?: unknown };
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.code === 'number' &&
        parsed.code !== 0
      ) {
        throw new GatewayApiError(
          response.status,
          parsed.code,
          typeof parsed.msg === 'string' && parsed.msg.trim() ? parsed.msg.trim() : '操作失败',
        );
      }
    } catch (err) {
      if (err instanceof GatewayApiError) throw err;
    }
    return { aborted: Boolean(options.signal?.aborted), receivedEvents: 0 };
  }

  if (!response.body) {
    return { aborted: Boolean(options.signal?.aborted), receivedEvents: 0 };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let trailingCr = false;
  let receivedEvents = 0;

  const dispatchAvailable = (flushAll: boolean) => {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseFrame(rawFrame);
      if (parsed) {
        receivedEvents += 1;
        options.onEvent(parsed);
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (flushAll && buffer.trim().length > 0) {
      const parsed = parseSseFrame(buffer);
      buffer = '';
      if (parsed) {
        receivedEvents += 1;
        options.onEvent(parsed);
      }
    }
  };

  const appendText = (chunkText: string) => {
    let combined = trailingCr ? `\r${chunkText}` : chunkText;
    trailingCr = false;
    if (combined.endsWith('\r')) {
      trailingCr = true;
      combined = combined.slice(0, -1);
    }
    buffer += combined.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  };

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (options.signal?.aborted) {
        return { aborted: true, receivedEvents };
      }
      const step = await reader.read();
      if (step.done) break;
      appendText(decoder.decode(step.value, { stream: true }));
      dispatchAvailable(false);
    }
    if (options.signal?.aborted) {
      return { aborted: true, receivedEvents };
    }
    const tail = decoder.decode();
    if (tail) appendText(tail);
    if (trailingCr) {
      buffer += '\n';
      trailingCr = false;
    }
    dispatchAvailable(true);
    return { aborted: Boolean(options.signal?.aborted), receivedEvents };
  } catch (err) {
    if (isAbortError(err, options.signal)) {
      return { aborted: true, receivedEvents };
    }
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
