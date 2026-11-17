import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { HttpTransport } from './guarded-request';
import { ProviderError, PROVIDER_KIND } from './provider-error';
import type { ResolvedAddress } from './ssrf';

/**
 * 真实传输只连接调用方已经校验过的地址。lookup 忽略系统 DNS，避免检查和连接之间被改写到内网。
 */
export function createUndiciTransport(): HttpTransport {
  return async (request) => {
    const pinned = request.pinned[0];
    if (!pinned) throw new ProviderError(PROVIDER_KIND.SSRF, '目标地址不允许访问', 'unpinned');
    const agent = new Agent({
      connect: {
        timeout: 10_000,
        servername: isIP(request.url.hostname.replace(/^\[|\]$/g, ''))
          ? undefined
          : request.url.hostname,
        lookup: (_hostname, options, callback) => pinLookup(pinned, options, callback),
      },
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });
    try {
      const response = await undiciFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
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
