import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { HttpStreamTransport, HttpTransport } from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import type { ResolvedAddress } from './ssrf';

/**
 * 真实传输只连接调用方已经校验过的地址。lookup 忽略系统 DNS，避免检查和连接之间被改写到内网。
 */
export function createUndiciTransport(): HttpTransport {
  return async (request) => {
    const pinned = request.pinned[0];
    if (!pinned) throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'unpinned');
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 60_000);
    const agent = new Agent({
      connect: {
        timeout: Math.min(10_000, timeoutMs),
        servername: isIP(request.url.hostname.replace(/^\[|\]$/g, ''))
          ? undefined
          : request.url.hostname,
        lookup: (_hostname, options, callback) => pinLookup(pinned, options, callback),
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    try {
      const response = await undiciFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.rawBody ?? request.body,
        dispatcher: agent,
        signal: request.signal,
        redirect: 'manual',
      });
      const body = await readLimited(response.body, request.maxBytes);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        headers[key] = value;
      });
      return { status: response.status, headers, body };
    } finally {
      await agent.close();
    }
  };
}

/**
 * 流式传输版本：保持 SSRF IP 钉扎与 redirect: 'manual'，把响应 ReadableStream 与幂等 close() 交给调用方消费完后释放 Agent。
 */
export function createUndiciStreamTransport(): HttpStreamTransport {
  return async (request) => {
    const pinned = request.pinned[0];
    if (!pinned) throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'unpinned');
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 60_000);
    const headersTimeoutMs = Math.max(1_000, request.headersTimeoutMs ?? timeoutMs);
    const bodyTimeoutMs = Math.max(1_000, request.bodyTimeoutMs ?? timeoutMs);
    const agent = new Agent({
      connect: {
        timeout: Math.min(10_000, headersTimeoutMs),
        servername: isIP(request.url.hostname.replace(/^\[|\]$/g, ''))
          ? undefined
          : request.url.hostname,
        lookup: (_hostname, options, callback) => pinLookup(pinned, options, callback),
      },
      headersTimeout: headersTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
    });
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await agent.close().catch(() => undefined);
    };
    try {
      const response = await undiciFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.rawBody ?? request.body,
        dispatcher: agent,
        signal: request.signal,
        redirect: 'manual',
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        headers[key] = value;
      });
      return {
        status: response.status,
        headers,
        body: response.body,
        close: closeOnce,
      };
    } catch (error) {
      await closeOnce();
      throw error;
    }
  };
}

export function pinLookup(
  pinned: ResolvedAddress,
  options: { all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
): void {
  if (options.all) {
    callback(null, [{ address: pinned.address, family: pinned.family }]);
    return;
  }
  callback(null, pinned.address, pinned.family);
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = Buffer.from(step.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '响应超过大小限制', 'body');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
