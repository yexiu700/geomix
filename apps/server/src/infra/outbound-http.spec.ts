import { describe, expect, it, vi } from 'vitest';
import type {
  DnsResolver,
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from './guarded-request';
import { OutboundHttpClient, PUBLIC_ONLY_ALLOWLIST, assertSafeOutboundUrl } from './outbound-http';
import { PROVIDER_KIND, ProviderError } from './provider-error';
import { parseSsrfAllowlist } from './ssrf';

const PUBLIC_IP = { address: '93.184.216.34', family: 4 as const };

function makeResolver(map: Record<string, Array<{ address: string; family: 4 | 6 }>>): DnsResolver {
  return {
    async resolve(hostname: string) {
      return map[hostname] ?? [PUBLIC_IP];
    },
  };
}

describe('OutboundHttpClient', () => {
  it('executes public GET and POST requests, forwards auth headers, and returns 4xx/5xx without throwing', async () => {
    const seenRequests: TransportRequest[] = [];
    const transport: HttpTransport = async (req): Promise<TransportResponse> => {
      seenRequests.push(req);
      if (req.url.pathname === '/ok') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'sid=hidden' },
          body: Buffer.from(JSON.stringify({ ok: true })),
        };
      }
      return {
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('not found'),
      };
    };

    const client = new OutboundHttpClient({
      resolver: makeResolver({ 'store.example.com': [PUBLIC_IP] }),
      transport,
    });

    const res = await client.request({
      url: 'https://store.example.com/ok',
      method: 'POST',
      headers: {
        Authorization: 'Bearer live-token',
        'X-Shopify-Access-Token': 'shpat_abc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.finalUrl).toBe('https://store.example.com/ok');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(seenRequests[0]?.headers.Authorization).toBe('Bearer live-token');
    expect(seenRequests[0]?.headers['X-Shopify-Access-Token']).toBe('shpat_abc');

    const notFound = await client.request({
      url: 'https://store.example.com/missing',
      method: 'GET',
    });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toBe('not found');
  });

  it('blocks private IPs, metadata endpoints, localhost, sonargate, and DNS-to-private-IP in both request and assertAllowedUrl', async () => {
    const transport = vi.fn<HttpTransport>();
    const client = new OutboundHttpClient({
      resolver: makeResolver({
        'public.example.com': [PUBLIC_IP],
        sonargate: [{ address: '172.18.0.5', family: 4 }],
        'rebind.example.com': [{ address: '10.0.0.12', family: 4 }],
        'loopback.example.com': [{ address: '127.0.0.1', family: 4 }],
      }),
      transport,
    });

    // Public URL passes assertAllowedUrl
    const allowed = await client.assertAllowedUrl('https://public.example.com/blog');
    expect(allowed.toString()).toBe('https://public.example.com/blog');

    // Verify PUBLIC_ONLY_ALLOWLIST does NOT inherit sonargate
    expect(() => assertSafeOutboundUrl('http://sonargate/health', PUBLIC_ONLY_ALLOWLIST)).toThrow(
      ProviderError,
    );

    const blockedUrls = [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/internal',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/secret',
      'http://sonargate/api',
      'https://rebind.example.com/payload',
      'https://loopback.example.com/payload',
    ];

    for (const url of blockedUrls) {
      await expect(client.assertAllowedUrl(url)).rejects.toMatchObject({
        kind: PROVIDER_KIND.SSRF,
      });
      await expect(client.request({ url, method: 'GET' })).rejects.toMatchObject({
        kind: PROVIDER_KIND.SSRF,
      });
    }

    expect(transport).not.toHaveBeenCalled();
  });

  it('validates every redirect hop against SSRF even when maxRedirects=0, strips cross-origin credentials, and downgrades POST on 302', async () => {
    const seen: TransportRequest[] = [];
    const transport: HttpTransport = async (req): Promise<TransportResponse> => {
      seen.push(req);
      if (req.url.href === 'https://a.example.com/to-private') {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: Buffer.alloc(0),
        };
      }
      if (req.url.href === 'https://a.example.com/to-loopback') {
        return {
          status: 301,
          headers: { location: 'http://127.0.0.1/secret' },
          body: Buffer.alloc(0),
        };
      }
      if (req.url.href === 'https://a.example.com/cross-origin') {
        return {
          status: 302,
          headers: { location: 'https://b.example.com/final' },
          body: Buffer.alloc(0),
        };
      }
      if (req.url.href === 'https://b.example.com/final') {
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('arrived'),
        };
      }
      if (req.url.href === 'https://a.example.com/loop-1') {
        return { status: 302, headers: { location: '/loop-2' }, body: Buffer.alloc(0) };
      }
      if (req.url.href === 'https://a.example.com/loop-2') {
        return { status: 302, headers: { location: '/loop-1' }, body: Buffer.alloc(0) };
      }
      if (req.url.href === 'https://a.example.com/hop-1') {
        return { status: 302, headers: { location: '/hop-2' }, body: Buffer.alloc(0) };
      }
      if (req.url.href === 'https://a.example.com/hop-2') {
        return { status: 302, headers: { location: '/hop-3' }, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    };

    const client = new OutboundHttpClient({
      resolver: makeResolver({
        'a.example.com': [PUBLIC_IP],
        'b.example.com': [PUBLIC_IP],
      }),
      transport,
      defaultMaxRedirects: 3,
    });

    // Redirect to cloud metadata blocked with SSRF even with maxRedirects: 0
    await expect(
      client.request({
        url: 'https://a.example.com/to-private',
        method: 'GET',
        maxRedirects: 0,
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    // Redirect to loopback blocked with SSRF
    await expect(
      client.request({
        url: 'https://a.example.com/to-loopback',
        method: 'GET',
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    // Cross-origin 302 redirect strips sensitive headers and downgrades POST -> GET
    seen.length = 0;
    const redirected = await client.request({
      url: 'https://a.example.com/cross-origin',
      method: 'POST',
      headers: {
        Authorization: 'Bearer top-secret',
        'X-Shopify-Access-Token': 'shpat_secret',
        'X-GeoMix-Signature': 'sha256=abc',
        'X-Api-Key': 'key-1',
        'Content-Type': 'application/json',
        'X-Custom-Trace': 'trace-1',
      },
      body: '{"a":1}',
    });
    expect(redirected.status).toBe(200);
    expect(redirected.body).toBe('arrived');
    expect(redirected.finalUrl).toBe('https://b.example.com/final');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.method).toBe('GET');
    expect(seen[1]?.body).toBeUndefined();
    expect(seen[1]?.headers.Authorization).toBeUndefined();
    expect(seen[1]?.headers['X-Shopify-Access-Token']).toBeUndefined();
    expect(seen[1]?.headers['X-GeoMix-Signature']).toBeUndefined();
    expect(seen[1]?.headers['X-Api-Key']).toBeUndefined();
    expect(seen[1]?.headers['Content-Type']).toBeUndefined();
    expect(seen[1]?.headers['X-Custom-Trace']).toBe('trace-1');

    // Redirect loop detection
    await expect(
      client.request({ url: 'https://a.example.com/loop-1', method: 'GET' }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF, reason: 'redirect_loop' });

    // Too many redirects
    await expect(
      client.request({ url: 'https://a.example.com/hop-1', method: 'GET', maxRedirects: 1 }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF, reason: 'too_many_redirects' });
  });

  it('honors defaultAllowlist and allowlistOverride for controlled local mock servers in tests', async () => {
    const localAllowlist = parseSsrfAllowlist('127.0.0.1:4100', { includeDefaults: false });
    const transport: HttpTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"mock":true}'),
    });

    const client = new OutboundHttpClient({
      resolver: makeResolver({}),
      transport,
    });

    // Blocked by default
    await expect(client.assertAllowedUrl('http://127.0.0.1:4100/webhook')).rejects.toMatchObject({
      kind: PROVIDER_KIND.SSRF,
    });

    // Permitted with allowlistOverride
    const url = await client.assertAllowedUrl('http://127.0.0.1:4100/webhook', {
      allowlistOverride: localAllowlist,
    });
    expect(url.toString()).toBe('http://127.0.0.1:4100/webhook');

    const res = await client.request({
      url: 'http://127.0.0.1:4100/webhook',
      method: 'POST',
      body: '{}',
      allowlistOverride: localAllowlist,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"mock":true}');

    // Permitted when configured via defaultAllowlist (e.g. NestJS test override)
    const testClient = new OutboundHttpClient({
      resolver: makeResolver({}),
      transport,
      defaultAllowlist: localAllowlist,
    });
    expect((await testClient.assertAllowedUrl('http://127.0.0.1:4100/wp-json')).port).toBe('4100');
  });

  it('never re-enables internal sonargate when string allowlists are provided and respects empty string override', async () => {
    const transport = vi.fn<HttpTransport>(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('ok'),
    }));

    const resolver = makeResolver({
      sonargate: [{ address: '172.18.0.5', family: 4 }],
    });

    const client = new OutboundHttpClient({ resolver, transport });

    expect(() => assertSafeOutboundUrl('http://sonargate/api', '')).toThrow(ProviderError);
    try {
      assertSafeOutboundUrl('http://sonargate/api', '');
    } catch (err) {
      expect(err).toMatchObject({ kind: PROVIDER_KIND.SSRF });
    }

    await expect(
      client.request({ url: 'http://sonargate/api', method: 'GET', allowlistOverride: '' }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    await expect(
      client.request({
        url: 'http://sonargate/api',
        method: 'GET',
        allowlistOverride: '127.0.0.1:4100',
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    await expect(
      client.assertAllowedUrl('http://sonargate/api', { allowlistOverride: '127.0.0.1:4100' }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    const stringDefaultClient = new OutboundHttpClient({
      resolver,
      transport,
      defaultAllowlist: '127.0.0.1:4100',
    });

    await expect(
      stringDefaultClient.request({ url: 'http://sonargate/api', method: 'GET' }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    // Empty allowlistOverride resets a non-empty defaultAllowlist back to PUBLIC_ONLY_ALLOWLIST
    await expect(
      stringDefaultClient.request({
        url: 'http://127.0.0.1:4100/webhook',
        method: 'GET',
        allowlistOverride: '',
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    await expect(
      stringDefaultClient.assertAllowedUrl('http://127.0.0.1:4100/webhook', {
        allowlistOverride: '',
      }),
    ).rejects.toMatchObject({ kind: PROVIDER_KIND.SSRF });

    expect(transport).not.toHaveBeenCalled();

    // Explicit string defaultAllowlist still allows the specifically listed host:port
    const allowedRes = await stringDefaultClient.request({
      url: 'http://127.0.0.1:4100/webhook',
      method: 'GET',
    });
    expect(allowedRes.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
