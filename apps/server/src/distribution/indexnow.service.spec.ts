import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundHttpClient } from '../infra/outbound-http';
import { parseSsrfAllowlist } from '../infra/ssrf';
import { IndexNowService } from './indexnow.service';

type CapturedIndexNowRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
};

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('IndexNowService', () => {
  let mockServer: Server;
  let mockEndpoint = '';
  let positiveClient: OutboundHttpClient;
  let strictClient: OutboundHttpClient;
  let captured: CapturedIndexNowRequest[] = [];
  let pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  let mode: 'ok_200' | 'ok_202' | 'http_400' | 'http_429' | 'http_500' | 'slow_timeout' = 'ok_200';

  beforeAll(async () => {
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const rawBody = await readRawBody(req);
        captured.push({
          method: req.method ?? 'POST',
          url: req.url ?? '/',
          headers: req.headers,
          rawBody,
        });

        if (mode === 'slow_timeout') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            if (!res.writableEnded) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end('{"ok":true}');
            }
          }, 2_000);
          timer.unref?.();
          pendingTimers.add(timer);
          req.on('close', () => {
            clearTimeout(timer);
            pendingTimers.delete(timer);
          });
          return;
        }

        if (mode === 'ok_200') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mode === 'ok_202') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (mode === 'http_400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: `Bad key in body: ${rawBody}` }));
          return;
        }
        if (mode === 'http_429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('Too Many Requests');
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(`Server error echoing ${rawBody}`);
      })();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const { port } = mockServer.address() as AddressInfo;
    mockEndpoint = `http://127.0.0.1:${port}/indexnow`;
    const allowlist = parseSsrfAllowlist(`127.0.0.1:${port}`, { includeDefaults: false });
    positiveClient = new OutboundHttpClient({ defaultAllowlist: allowlist });
    strictClient = new OutboundHttpClient();
  });

  beforeEach(() => {
    captured = [];
    mode = 'ok_200';
  });

  afterAll(async () => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers = new Set();
    await closeHttpServer(mockServer);
  });

  it('submits valid URLs with exact IndexNow JSON payload on HTTP 200 and 202', async () => {
    const service = new IndexNowService(positiveClient, { endpointUrl: mockEndpoint });
    const key = 'indexnow_key_abcdef123456';

    const res200 = await service.submit({
      indexNowKey: key,
      keyLocation: `https://docs.brand.example/${key}.txt`,
      urls: [
        'https://docs.brand.example/guides/geo-v2',
        'https://docs.brand.example/guides/geo-v2', // duplicate
        'https://other.example/ignored', // cross-host ignored
        'javascript:alert(1)', // invalid scheme ignored
      ],
    });

    expect(res200).toEqual({
      submitted: true,
      status: 'SUBMITTED',
      reason: 'OK',
      statusText: 'SUBMITTED',
      httpStatus: 200,
      submittedUrls: ['https://docs.brand.example/guides/geo-v2'],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.accept).toBe('application/json');
    expect(JSON.parse(captured[0]?.rawBody ?? '{}')).toEqual({
      host: 'docs.brand.example',
      key,
      keyLocation: `https://docs.brand.example/${key}.txt`,
      urlList: ['https://docs.brand.example/guides/geo-v2'],
    });

    mode = 'ok_202';
    const res202 = await service.submit({
      indexNowKey: key,
      urls: ['https://docs.brand.example/guides/second'],
    });
    expect(res202.submitted).toBe(true);
    expect(res202.status).toBe('SUBMITTED');
    expect(res202.reason).toBe('OK');
    expect(res202.httpStatus).toBe(202);
  });

  it('skips with 0 HTTP calls when indexNowKey is missing or blank', async () => {
    const service = new IndexNowService(positiveClient, { endpointUrl: mockEndpoint });

    const res = await service.submit({
      indexNowKey: '   ',
      urls: ['https://docs.brand.example/guides/geo-v2'],
    });

    expect(res).toEqual({
      submitted: false,
      status: 'SKIPPED',
      reason: 'NO_KEY',
      statusText: 'SKIPPED',
      submittedUrls: [],
    });
    expect(captured).toHaveLength(0);
  });

  it('skips with 0 HTTP calls when URLs are empty or invalid', async () => {
    const service = new IndexNowService(positiveClient, { endpointUrl: mockEndpoint });

    const res = await service.submit({
      indexNowKey: 'indexnow_key_abcdef123456',
      urls: ['', 'not-a-url', 'ftp://docs.brand.example/file'],
    });

    expect(res).toEqual({
      submitted: false,
      status: 'SKIPPED',
      reason: 'NO_URLS',
      statusText: 'SKIPPED',
      submittedUrls: [],
    });
    expect(captured).toHaveLength(0);
  });

  it('degrades cleanly without throwing on HTTP 400, 429, 500 and never leaks indexNowKey', async () => {
    const service = new IndexNowService(positiveClient, { endpointUrl: mockEndpoint });
    const secretKey = 'indexnow_super_secret_key_9999';

    for (const [testMode, expectedHttp] of [
      ['http_400', 400],
      ['http_429', 429],
      ['http_500', 500],
    ] as const) {
      mode = testMode;
      const res = await service.submit({
        indexNowKey: secretKey,
        urls: ['https://docs.brand.example/guides/degrade'],
      });
      expect(res.submitted).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.reason).toBe('UPSTREAM_HTTP');
      expect(res.statusText).toBe(`FAILED:HTTP_${expectedHttp}`);
      expect(res.httpStatus).toBe(expectedHttp);
      expect(res.error ?? '').not.toContain(secretKey);
    }
  });

  it('degrades cleanly on real short timeout without throwing', async () => {
    const service = new IndexNowService(positiveClient, {
      endpointUrl: mockEndpoint,
      timeoutMs: 120,
    });
    mode = 'slow_timeout';

    const res = await service.submit({
      indexNowKey: 'indexnow_timeout_key_1234',
      urls: ['https://docs.brand.example/guides/slow'],
    });

    expect(res.submitted).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.reason).toBe('TIMEOUT');
    expect(res.statusText).toBe('FAILED:TIMEOUT');
  });

  it('degrades cleanly on SSRF-blocked endpoint without throwing', async () => {
    const service = new IndexNowService(strictClient, {
      endpointUrl: mockEndpoint,
    });

    const res = await service.submit({
      indexNowKey: 'indexnow_ssrf_key_1234',
      urls: ['https://docs.brand.example/guides/ssrf'],
    });

    expect(res.submitted).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.reason).toBe('SSRF');
    expect(res.statusText).toBe('FAILED:SSRF');
    expect(captured).toHaveLength(0);
  });

  it('redacts URL-encoded special-character indexNowKey from thrown transport errors', async () => {
    const specialKey = 'idx_key+1/2=3';
    const encodedKey = encodeURIComponent(specialKey);
    const throwingHttp = {
      request: async () => {
        throw new Error(`Upstream boom echoing raw=${specialKey} encoded=${encodedKey}`);
      },
    } as unknown as OutboundHttpClient;
    const service = new IndexNowService(throwingHttp, {
      endpointUrl: 'https://indexnow.example.com/indexnow',
    });

    const res = await service.submit({
      indexNowKey: specialKey,
      urls: ['https://docs.brand.example/guides/encoded-key'],
    });

    expect(res.submitted).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.reason).toBe('UPSTREAM_ERROR');
    expect(res.error).toContain('[REDACTED]');
    expect(res.error ?? '').not.toContain(specialKey);
    expect(res.error ?? '').not.toContain(encodedKey);
  });
});
