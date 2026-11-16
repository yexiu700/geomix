import { afterEach, describe, expect, it } from 'vitest';
import type { HttpTransport, TransportRequest } from './guarded-request';
import { requestOnce } from './guarded-request';
import { ProviderError } from './provider-error';
import {
  fetchBinary,
  fetchPublicPage,
  resetRobotsCache,
  robotsAllow,
  type FetchDeps,
} from './public-fetch';
import { pinLookup } from './undici-transport';
import type { ResolvedAddress } from './ssrf';

type Script = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

afterEach(() => {
  resetRobotsCache();
});

describe('public fetch SSRF', () => {
  it('blocks intranet, link-local, and IPv6 targets without calling the transport', async () => {
    const seen: string[] = [];
    const deps = mockDeps({}, (request) => {
      seen.push(request.url.toString());
    });
    for (const raw of [
      'http://10.1.2.3/secret',
      'http://192.168.1.8/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::2]/',
      'http://[::ffff:10.0.0.8]/',
      'http://2130706433/',
    ]) {
      await expect(fetchPublicPage(raw, deps)).rejects.toMatchObject({ kind: 'ssrf' });
    }
    expect(seen).toEqual([]);
  });

  it('blocks a public-looking name when any resolved address is private or IPv6 link-local', async () => {
    const seen: string[] = [];
    const deps = mockDeps(
      {
        'intranet.example': [{ address: '10.4.4.4', family: 4 }],
        'mixed.example': [
          { address: '192.0.2.10', family: 4 },
          { address: 'fe80::10', family: 6 },
        ],
        'mapped.example': [{ address: '::ffff:192.168.0.4', family: 6 }],
      },
      (request) => {
        seen.push(request.url.hostname);
      },
    );
    await expect(fetchPublicPage('https://intranet.example/a', deps)).rejects.toMatchObject({
      kind: 'ssrf',
      reason: 'ipv4_special',
    });
    await expect(fetchPublicPage('https://mixed.example/a', deps)).rejects.toMatchObject({
      kind: 'ssrf',
      reason: 'ipv6_special',
    });
    await expect(fetchPublicPage('https://mapped.example/a', deps)).rejects.toMatchObject({
      kind: 'ssrf',
      reason: 'embedded_ipv4_special',
    });
    expect(seen).toEqual([]);
  });

  it('blocks a redirect onto an intranet or IPv6 address and does not request the second hop', async () => {
    const seen: string[] = [];
    const deps = mockDeps(
      { 'public.example': [{ address: '192.0.2.10', family: 4 }] },
      (request) => {
        seen.push(request.url.toString());
      },
      {
        'https://public.example/robots.txt': { status: 404, body: '' },
        'https://public.example/start': {
          status: 302,
          headers: { location: 'http://10.9.9.9/hidden' },
        },
        'https://public.example/v6': {
          status: 302,
          headers: { location: 'http://[fe80::1]/hidden' },
        },
      },
    );
    await expect(fetchPublicPage('https://public.example/start', deps)).rejects.toMatchObject({
      kind: 'ssrf',
      reason: 'ipv4_special',
    });
    await expect(fetchPublicPage('https://public.example/v6', deps)).rejects.toMatchObject({
      kind: 'ssrf',
      reason: 'ipv6_special',
    });
    expect(seen.some((url) => url.includes('10.9.9.9') || url.includes('fe80'))).toBe(false);
  });

  it('rechecks each redirect and pins the resolved public address', async () => {
    const pinned: ResolvedAddress[][] = [];
    const deps = mockDeps(
      {
        'public.example': [{ address: '192.0.2.10', family: 4 }],
        'next.example': [{ address: '192.0.2.20', family: 4 }],
      },
      (request) => {
        pinned.push(request.pinned);
      },
      {
        'https://public.example/robots.txt': { status: 404 },
        'https://next.example/robots.txt': { status: 404 },
        'https://public.example/start': {
          status: 302,
          headers: { location: 'https://next.example/page' },
        },
        'https://next.example/page': {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<html>GeoMix 占位页面</html>',
        },
      },
    );
    const page = await fetchPublicPage('https://public.example/start', deps);
    expect(page.body).toContain('GeoMix');
    expect(page.url).toBe('https://next.example/page');
    expect(pinned.map((group) => group[0]?.address)).toEqual([
      '192.0.2.10',
      '192.0.2.10',
      '192.0.2.20',
      '192.0.2.20',
    ]);
  });

  it('stops after three redirects', async () => {
    const hops = ['/a', '/b', '/c', '/d'];
    const scripts: Record<string, Script> = {
      'https://public.example/robots.txt': { status: 404 },
    };
    hops.forEach((path, index) => {
      const next = hops[index + 1];
      scripts[`https://public.example${path}`] = next
        ? { status: 302, headers: { location: `https://public.example${next}` } }
        : { status: 302, headers: { location: 'https://public.example/e' } };
    });
    const deps = mockDeps(
      { 'public.example': [{ address: '192.0.2.10', family: 4 }] },
      () => undefined,
      scripts,
    );
    await expect(fetchPublicPage('https://public.example/a', deps)).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
  });

  it('rejects non-html, oversized, login-walled, and disallowed pages', async () => {
    const big = 'x'.repeat(2048);
    const deps = mockDeps(
      { 'public.example': [{ address: '192.0.2.10', family: 4 }] },
      () => undefined,
      {
        'https://public.example/robots.txt': {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'User-agent: *\nDisallow: /private\n',
        },
        'https://public.example/file': {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: 'nope',
        },
        'https://public.example/locked': { status: 401, body: '' },
        'https://public.example/wall': {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>请完成验证</html>',
        },
        'https://public.example/article': {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<html>${'内容'.repeat(800)}请登录后查看更多</html>`,
        },
        'https://public.example/private': {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>hidden</html>',
        },
      },
    );
    await expect(fetchPublicPage('https://public.example/file', deps)).rejects.toMatchObject({
      reason: 'content_type',
    });
    await expect(fetchPublicPage('https://public.example/locked', deps)).rejects.toMatchObject({
      kind: 'not_public',
    });
    await expect(fetchPublicPage('https://public.example/wall', deps)).rejects.toMatchObject({
      reason: 'login_wall',
    });
    const article = await fetchPublicPage('https://public.example/article', deps);
    expect(article.body).toContain('请登录后查看更多');
    await expect(fetchPublicPage('https://public.example/private', deps)).rejects.toMatchObject({
      reason: 'robots_disallow',
    });
    expect(big.length).toBeGreaterThan(1500);
  });

  it('does not send cookies and drops set-cookie', async () => {
    let cookie: string | undefined;
    const deps = mockDeps(
      { 'public.example': [{ address: '192.0.2.10', family: 4 }] },
      (request) => {
        cookie = request.headers.cookie ?? request.headers.Cookie;
      },
      {
        'https://public.example/robots.txt': { status: 404 },
        'https://public.example/page': {
          status: 200,
          headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret' },
          body: '<html>ok</html>',
        },
      },
    );
    await requestOnce({
      url: 'https://public.example/page',
      method: 'GET',
      headers: { cookie: 'session=secret', accept: 'text/html' },
      timeoutMs: 1000,
      maxBytes: 1024,
      resolver: deps.resolver,
      transport: deps.transport,
    }).then((response) => {
      expect(response.headers['set-cookie']).toBeUndefined();
    });
    expect(cookie).toBeUndefined();
  });

  it('does not download a binary that redirects to a private address', async () => {
    const seen: string[] = [];
    const deps = mockDeps(
      { 'cdn.example': [{ address: '192.0.2.30', family: 4 }] },
      (request) => seen.push(request.url.toString()),
      {
        'https://cdn.example/img': { status: 302, headers: { location: 'http://127.0.0.1/img' } },
      },
    );
    await expect(
      fetchBinary('https://cdn.example/img', {
        ...deps,
        allowTypes: ['image/png'],
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(seen).toEqual(['https://cdn.example/img']);
  });

  it('cancels before the transport runs', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    const deps = mockDeps(
      { 'public.example': [{ address: '192.0.2.10', family: 4 }] },
      (request) => {
        seen.push(request.url.toString());
      },
    );
    await expect(
      requestOnce({
        url: 'https://public.example/page',
        method: 'GET',
        timeoutMs: 1000,
        maxBytes: 100,
        signal: controller.signal,
        resolver: deps.resolver,
        transport: deps.transport,
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(seen).toEqual([]);
  });
});

describe('robots and lookup pin', () => {
  it('matches the longest robots rule', () => {
    const text = 'User-agent: GeoMixBot\nDisallow: /\nAllow: /open\n';
    expect(robotsAllow(text, '/open/item')).toBe(true);
    expect(robotsAllow(text, '/closed')).toBe(false);
    expect(robotsAllow('User-agent: *\nDisallow:\n', '/any')).toBe(true);
  });

  it('pins lookup to the validated address', () => {
    const one: unknown[] = [];
    pinLookup({ address: '192.0.2.10', family: 4 }, {}, (error, address, family) => {
      one.push(error, address, family);
    });
    expect(one).toEqual([null, '192.0.2.10', 4]);
    const all: unknown[] = [];
    pinLookup({ address: '2001:db8::10', family: 6 }, { all: true }, (error, address) => {
      all.push(error, address);
    });
    expect(all).toEqual([null, [{ address: '2001:db8::10', family: 6 }]]);
  });
});

function mockDeps(
  dns: Record<string, ResolvedAddress[]>,
  onRequest: (request: TransportRequest) => void,
  scripts: Record<string, Script> = {},
): FetchDeps {
  const transport: HttpTransport = async (request) => {
    onRequest(request);
    const script = scripts[request.url.toString()];
    if (!script) throw new Error(`unexpected ${request.url.toString()}`);
    return {
      status: script.status,
      headers: script.headers ?? {},
      body: Buffer.from(script.body ?? ''),
    };
  };
  return {
    resolver: {
      async resolve(hostname: string) {
        const found = dns[hostname];
        if (!found) throw new ProviderError('ssrf', '目标地址不允许访问', 'dns_empty');
        return found;
      },
    },
    transport,
    timeoutMs: 1000,
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
    robotsCacheMs: 60_000,
    now: () => 0,
  };
}
