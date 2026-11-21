import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from './envelope';
import { parseSseFrame, streamSsePost, type SseFrame } from './sse';

vi.mock('./api', () => ({
  authorizedV2RawRequest: vi.fn(),
}));

import { authorizedV2RawRequest } from './api';

const mockRawRequest = vi.mocked(authorizedV2RawRequest);

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('SSE POST streaming client (sse.ts)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses single and multi-line SSE frames and ignores comment lines', () => {
    expect(parseSseFrame(': keep-alive\n\n')).toBeNull();
    expect(parseSseFrame('event: delta\ndata: {"text":"你好"}')).toEqual({
      event: 'delta',
      rawData: '{"text":"你好"}',
      data: { text: '你好' },
    });
    expect(parseSseFrame('data: line1\ndata: line2')).toEqual({
      event: 'message',
      rawData: 'line1\nline2',
      data: 'line1\nline2',
    });
  });

  it('handles multi-byte Chinese UTF-8 and CRLF boundaries split across chunks', async () => {
    const encoder = new TextEncoder();
    const full =
      ': ping\r\n\r\n' +
      'event: meta\r\ndata: {"unitPrice":10}\r\n\r\n' +
      'event: delta\r\ndata: {"text":"星辰存储实测静音"}\r\n\r\n' +
      'event: complete\r\ndata: {"geoScore":92}\r\n\r\n';
    const bytes = encoder.encode(full);
    // Deliberately split mid-UTF8 and mid-CRLF every 7 bytes
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      chunks.push(bytes.subarray(i, i + 7));
    }

    mockRawRequest.mockResolvedValueOnce(
      new Response(streamFromChunks(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );

    const events: SseFrame[] = [];
    const result = await streamSsePost('/brands/b1/articles/stream', {
      body: { market: 'CN' },
      idempotencyKey: 'idem-sse-0001',
      onEvent: (f) => events.push(f),
    });

    expect(mockRawRequest).toHaveBeenCalledWith(
      '/brands/b1/articles/stream',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'Idempotency-Key': 'idem-sse-0001',
        }),
      }),
    );
    expect(result).toEqual({ aborted: false, receivedEvents: 3 });
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'complete']);
    expect(events[1]?.data).toEqual({ text: '星辰存储实测静音' });
  });

  it('throws GatewayApiError on non-2xx JSON envelopes and non-JSON errors', async () => {
    mockRawRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 40201, msg: '可用点数不足', data: null }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      streamSsePost('/brands/b1/articles/stream', { body: {}, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 402, code: 40201, message: '可用点数不足' });

    mockRawRequest.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(
      streamSsePost('/brands/b1/articles/stream', { body: {}, onEvent: () => undefined }),
    ).rejects.toBeInstanceOf(GatewayApiError);
  });

  it('handles AbortController abort cleanly without throwing', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('event: meta\ndata: {"unitPrice":10}\n\n'));
      },
    });
    mockRawRequest.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const events: SseFrame[] = [];
    const result = await streamSsePost('/brands/b1/articles/stream', {
      body: {},
      signal: controller.signal,
      onEvent: (f) => {
        events.push(f);
        if (f.event === 'meta') controller.abort();
      },
    });

    expect(result.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('meta');
  });

  it('does not dispatch truncated partial SSE frames after AbortController.abort()', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            'event: meta\ndata: {"unitPrice":10}\n\nevent: delta\ndata: {"text":"partial_unterminated',
          ),
        );
        // Leave stream open so reader.read() awaits next chunk until abort cancels it
      },
    });
    mockRawRequest.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const events: SseFrame[] = [];
    const promise = streamSsePost('/brands/b1/articles/stream', {
      body: {},
      signal: controller.signal,
      onEvent: (f) => {
        events.push(f);
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await promise;

    expect(result).toEqual({ aborted: true, receivedEvents: 1 });
    expect(events.map((e) => e.event)).toEqual(['meta']);
  });

  it('returns cleanly on HTTP 200 application/json code=0 without throwing ReadableStream lock error', async () => {
    mockRawRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );

    const events: SseFrame[] = [];
    const result = await streamSsePost('/brands/b1/articles/stream', {
      body: {},
      onEvent: (f) => events.push(f),
    });

    expect(result).toEqual({ aborted: false, receivedEvents: 0 });
    expect(events).toEqual([]);
  });

  it('stops dispatching subsequent frames in the same chunk after AbortController.abort() (W-06)', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const combinedChunk = encoder.encode(
      'event: meta\ndata: {"unitPrice":10}\n\nevent: complete\ndata: {"geoScore":95}\n\n',
    );
    mockRawRequest.mockResolvedValueOnce(
      new Response(streamFromChunks([combinedChunk]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const events: SseFrame[] = [];
    const result = await streamSsePost('/brands/b1/articles/stream', {
      body: {},
      signal: controller.signal,
      onEvent: (f) => {
        events.push(f);
        if (f.event === 'meta') controller.abort();
      },
    });

    expect(result).toEqual({ aborted: true, receivedEvents: 1 });
    expect(events.map((e) => e.event)).toEqual(['meta']);
  });
});
