import { PUBLIC_PRICING_FALLBACK, type PublicPricingPayload } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MarketingApiError,
  extractCalculatorUnitPoints,
  fetchPublicPricing,
  isMarketingApiError,
  parsePublicPricingPayload,
  parseRetryAfterSeconds,
  resolveServerPublicPricingUrl,
  submitMarketingLead,
} from './marketing-api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function buildLivePricingPayload(
  overrides?: Partial<Record<string, number>>,
): PublicPricingPayload {
  return {
    items: PUBLIC_PRICING_FALLBACK.items.map((item) => ({
      ...item,
      unitPoints: overrides?.[item.action] ?? item.unitPoints,
    })),
    freeActions: PUBLIC_PRICING_FALLBACK.freeActions.map((entry) => ({ ...entry })),
    demoTrial: { ...PUBLIC_PRICING_FALLBACK.demoTrial },
  };
}

describe('resolveServerPublicPricingUrl', () => {
  it('prioritizes INTERNAL_API_BASE over NEXT_PUBLIC_API_V2_BASE and NEXT_PUBLIC_API_BASE', () => {
    expect(
      resolveServerPublicPricingUrl({
        INTERNAL_API_BASE: 'http://api:3001/api/v1',
        NEXT_PUBLIC_API_V2_BASE: 'https://v2.example.com/api/v2',
        NEXT_PUBLIC_API_BASE: 'https://v1.example.com/api/v1',
      }),
    ).toBe('http://api:3001/api/v2/public/pricing');

    expect(
      resolveServerPublicPricingUrl({
        NEXT_PUBLIC_API_V2_BASE: 'https://v2.example.com/api/v2/',
        NEXT_PUBLIC_API_BASE: 'https://v1.example.com/api/v1',
      }),
    ).toBe('https://v2.example.com/api/v2/public/pricing');
  });

  it('normalizes /api/v1, /v1, /api, /api/v2, mixed case, slashes, and bare origins', () => {
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/api/v1' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/api/v1///' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/v1' })).toBe(
      'http://api:3001/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/api' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/api/v2/' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001/API/V2///' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'http://api:3001' })).toBe(
      'http://api:3001/api/v2/public/pricing',
    );
    expect(
      resolveServerPublicPricingUrl({ NEXT_PUBLIC_API_BASE: 'https://api.geomix.example/' }),
    ).toBe('https://api.geomix.example/api/v2/public/pricing');
  });

  it('returns null for unset, relative, protocol-relative, non-http, credentialed, or control-char values', () => {
    expect(resolveServerPublicPricingUrl({})).toBeNull();
    expect(resolveServerPublicPricingUrl({ INTERNAL_API_BASE: '   ' })).toBeNull();
    expect(resolveServerPublicPricingUrl({ NEXT_PUBLIC_API_BASE: '/api/v1' })).toBeNull();
    expect(resolveServerPublicPricingUrl({ NEXT_PUBLIC_API_BASE: '//api.example.com' })).toBeNull();
    expect(
      resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'ftp://api.example.com' }),
    ).toBeNull();
    expect(
      resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'https://user:pass@api.example.com' }),
    ).toBeNull();
    expect(
      resolveServerPublicPricingUrl({ INTERNAL_API_BASE: 'https://api.example.com\r\n/api/v1' }),
    ).toBeNull();
  });
});

describe('parsePublicPricingPayload & extractCalculatorUnitPoints', () => {
  it('accepts valid payload including geo_variant=0 and strips unexpected extra fields', () => {
    const live = buildLivePricingPayload({ geo_write: 12, geo_variant: 0 });
    const withExtras = {
      ...live,
      internalCostUsd: 0.004,
      items: live.items.map((item) => ({ ...item, secretMargin: 99 })),
      freeActions: live.freeActions.map((entry) => ({ ...entry, hiddenFlag: true })),
      demoTrial: { ...live.demoTrial, adminOnly: 'secret' },
    };

    const parsed = parsePublicPricingPayload(withExtras);
    expect(parsed).not.toBeNull();
    expect(parsed?.items.find((i) => i.action === 'geo_write')?.unitPoints).toBe(12);
    expect(parsed?.items.find((i) => i.action === 'geo_variant')?.unitPoints).toBe(0);
    expect('internalCostUsd' in (parsed as unknown as Record<string, unknown>)).toBe(false);
    expect('secretMargin' in (parsed!.items[0] as unknown as Record<string, unknown>)).toBe(false);
    expect('adminOnly' in (parsed!.demoTrial as unknown as Record<string, unknown>)).toBe(false);

    expect(extractCalculatorUnitPoints(parsed!)).toEqual({
      geo_write: 12,
      geo_variant: 0,
      visibility_check: 2,
    });
  });

  it('rejects malformed payloads (missing freeActions, duplicate action, invalid unitPoints, invalid demoTrial)', () => {
    const valid = buildLivePricingPayload();

    expect(parsePublicPricingPayload(null)).toBeNull();
    expect(parsePublicPricingPayload([])).toBeNull();
    expect(parsePublicPricingPayload({ ...valid, freeActions: [] })).toBeNull();

    const duplicateItems = {
      ...valid,
      items: [valid.items[0]!, valid.items[0]!, valid.items[2]!, valid.items[3]!],
    };
    expect(parsePublicPricingPayload(duplicateItems)).toBeNull();

    const zeroGeoWrite = buildLivePricingPayload({ geo_write: 0 });
    expect(parsePublicPricingPayload(zeroGeoWrite)).toBeNull();

    const negativeVariant = buildLivePricingPayload({ geo_variant: -1 });
    expect(parsePublicPricingPayload(negativeVariant)).toBeNull();

    const badTrial = { ...valid, demoTrial: { points: 0, validDays: 365 } };
    expect(parsePublicPricingPayload(badTrial)).toBeNull();

    const emptyLabel = {
      ...valid,
      items: valid.items.map((item, idx) => (idx === 0 ? { ...item, labelEn: '   ' } : item)),
    };
    expect(parsePublicPricingPayload(emptyLabel)).toBeNull();
  });
});

describe('fetchPublicPricing', () => {
  it('returns defensive fallback clone immediately without calling fetch when env is unset or relative', async () => {
    const fetchMock = vi.fn();

    const fromUnset = await fetchPublicPricing({ env: {}, fetchImpl: fetchMock });
    const fromRelative = await fetchPublicPricing({
      env: { NEXT_PUBLIC_API_BASE: '/api/v1' },
      fetchImpl: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fromUnset).toEqual(PUBLIC_PRICING_FALLBACK);
    expect(fromRelative).toEqual(PUBLIC_PRICING_FALLBACK);

    // Mutating returned object does not mutate PUBLIC_PRICING_FALLBACK
    (fromUnset.items[0] as { unitPoints: number }).unitPoints = 999;
    fromUnset.demoTrial.points = 1;
    expect(PUBLIC_PRICING_FALLBACK.items[0]?.unitPoints).toBe(10);
    expect(PUBLIC_PRICING_FALLBACK.demoTrial.points).toBe(1000);
  });

  it('fetches live pricing with credentials omit, cache no-store, and returns validated overrides', async () => {
    const live = buildLivePricingPayload({ geo_variant: 0, visibility_check: 3 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: live }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await fetchPublicPricing({
      env: { INTERNAL_API_BASE: 'http://api:3001/api/v1' },
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api:3001/api/v2/public/pricing');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(result.items.find((i) => i.action === 'geo_variant')?.unitPoints).toBe(0);
    expect(result.items.find((i) => i.action === 'visibility_check')?.unitPoints).toBe(3);
  });

  it('falls back cleanly without throwing on HTTP 500/502 HTML, malformed JSON, error envelope, network error, or timeout', async () => {
    const html502 = vi
      .fn()
      .mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(
      await fetchPublicPricing({
        env: { INTERNAL_API_BASE: 'http://api:3001' },
        fetchImpl: html502,
      }),
    ).toEqual(PUBLIC_PRICING_FALLBACK);

    const badEnvelope = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 50000, msg: 'db down', data: null }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(
      await fetchPublicPricing({
        env: { INTERNAL_API_BASE: 'http://api:3001' },
        fetchImpl: badEnvelope,
      }),
    ).toEqual(PUBLIC_PRICING_FALLBACK);

    const networkErr = vi.fn().mockRejectedValue(new TypeError('ECONNREFUSED'));
    expect(
      await fetchPublicPricing({
        env: { INTERNAL_API_BASE: 'http://api:3001' },
        fetchImpl: networkErr,
      }),
    ).toEqual(PUBLIC_PRICING_FALLBACK);

    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const timedOut = await fetchPublicPricing({
      env: { INTERNAL_API_BASE: 'http://api:3001' },
      timeoutMs: 20,
      fetchImpl: hangingFetch,
    });
    expect(timedOut).toEqual(PUBLIC_PRICING_FALLBACK);
  });
});

describe('parseRetryAfterSeconds & submitMarketingLead', () => {
  it('parses integer seconds and future HTTP-date headers, rejecting invalid/zero/past values', () => {
    expect(parseRetryAfterSeconds('45')).toBe(45);
    expect(parseRetryAfterSeconds(' 120 ')).toBe(120);
    expect(parseRetryAfterSeconds('0')).toBeUndefined();
    expect(parseRetryAfterSeconds('-5')).toBeUndefined();
    expect(parseRetryAfterSeconds('not-a-date')).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
    expect(parseRetryAfterSeconds('Tue, 24 Nov 2026 12:01:30 GMT')).toBe(90);
    expect(parseRetryAfterSeconds('Tue, 24 Nov 2026 11:59:00 GMT')).toBeUndefined();
  });

  it('submits lead with credentials omit & cache no-store and handles normal and honeypot 200 responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, msg: 'ok', data: { accepted: true, id: 'lead_1' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, msg: 'ok', data: { accepted: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const payload = {
      locale: 'en' as const,
      name: 'Alex Chen',
      email: 'alex@nordicaudio.example',
      companyBrand: 'NordicAudio',
      targetMarket: 'BOTH' as const,
      estimatedPts: 464,
      sourcePage: '/demo',
    };

    const res1 = await submitMarketingLead(payload, {
      apiBaseUrl: 'https://api.geomix.example/api/v2/',
      fetchImpl: fetchMock,
    });
    expect(res1).toEqual({ accepted: true, id: 'lead_1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.geomix.example/api/v2/public/leads');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(String(init.body))).toEqual(payload);

    const res2 = await submitMarketingLead(
      { ...payload, honeypot: 'bot-trap' },
      { apiBaseUrl: 'https://api.geomix.example/api/v2', fetchImpl: fetchMock },
    );
    expect(res2).toEqual({ accepted: true });
    expect('id' in res2).toBe(false);
  });

  it('maps 400 validation errors, 429 rate limits (with/without Retry-After), 502 HTML, network failures, and unexpected 200 shapes to MarketingApiError', async () => {
    const basePayload = {
      locale: 'en' as const,
      name: 'Alex',
      email: 'alex@nordicaudio.example',
      companyBrand: 'NordicAudio',
    };

    // 400 validation error
    const err400 = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 40001, msg: 'Invalid website URL', data: null }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(err400)).toBe(true);
    expect((err400 as MarketingApiError).status).toBe(400);
    expect((err400 as MarketingApiError).code).toBe(40001);
    expect((err400 as MarketingApiError).message).toBe('Invalid website URL');
    expect((err400 as MarketingApiError).retryAfterSeconds).toBeUndefined();

    // 429 with Retry-After header
    const err429WithHeader = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 42901, msg: '尝试过于频繁，请稍后再试', data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '45' },
        }),
      ),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(err429WithHeader)).toBe(true);
    expect((err429WithHeader as MarketingApiError).status).toBe(429);
    expect((err429WithHeader as MarketingApiError).code).toBe(42901);
    expect((err429WithHeader as MarketingApiError).retryAfterSeconds).toBe(45);

    // 429 without Retry-After header (CORS hidden)
    const err429NoHeader = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 42901, msg: '尝试过于频繁，请稍后再试', data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(err429NoHeader)).toBe(true);
    expect((err429NoHeader as MarketingApiError).status).toBe(429);
    expect((err429NoHeader as MarketingApiError).retryAfterSeconds).toBeUndefined();

    // Network failure
    const errNetwork = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(errNetwork)).toBe(true);
    expect((errNetwork as MarketingApiError).status).toBe(0);
    expect((errNetwork as MarketingApiError).code).toBe(-1);

    // 502 HTML response
    const err502 = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(err502)).toBe(true);
    expect((err502 as MarketingApiError).status).toBe(502);
    expect((err502 as MarketingApiError).code).toBe(-1);

    // Unexpected 200 body
    const errUnexpected = await submitMarketingLead(basePayload, {
      apiBaseUrl: 'http://localhost:3001/api/v2',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: 'ok', data: { accepted: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    }).catch((err: unknown) => err);
    expect(isMarketingApiError(errUnexpected)).toBe(true);
    expect((errUnexpected as MarketingApiError).status).toBe(200);
    expect((errUnexpected as MarketingApiError).code).toBe(-1);
  });
});
