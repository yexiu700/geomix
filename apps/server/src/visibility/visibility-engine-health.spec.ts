import { describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../infra/guarded-request';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import {
  VisibilityEngineHealthService,
  parseRemoteHealthPayload,
  resolveRemoteHealthUrls,
  type EngineHealthStore,
  type PersistedEngineHealth,
} from './visibility-engine-health.service';
import { readVisibilityConfig } from './visibility.config';

function makeJsonResponse(status: number, body: unknown): Awaited<ReturnType<HttpTransport>> {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

const publicResolver = {
  resolve: async () => [{ address: '93.184.216.34', family: 4 as const }],
};

function makeMemoryStore(): EngineHealthStore & { value: PersistedEngineHealth | null } {
  const box = {
    value: null as PersistedEngineHealth | null,
    async get() {
      return box.value;
    },
    async set(state: PersistedEngineHealth) {
      box.value = state;
    },
  };
  return box;
}

describe('parseRemoteHealthPayload', () => {
  it('supports engine string array, object array, map, and service-level status', () => {
    expect(parseRemoteHealthPayload({ status: 'ok', engines: ['deepseek', 'kimi'] })).toEqual({
      kind: 'engines',
      availability: { deepseek: true, kimi: true },
    });

    expect(
      parseRemoteHealthPayload({
        engines: [
          { key: 'deepseek', available: true },
          { engine: 'doubao', status: 'offline' },
          { name: 'yuanbao', healthy: true },
        ],
      }),
    ).toEqual({
      kind: 'engines',
      availability: { deepseek: true, doubao: false, yuanbao: true },
    });

    expect(
      parseRemoteHealthPayload({
        providers: {
          deepseek: true,
          doubao: false,
          tongyi: { status: 'healthy' },
          wenxin: { available: false },
        },
      }),
    ).toEqual({
      kind: 'engines',
      availability: { deepseek: true, doubao: false, tongyi: true, wenxin: false },
    });

    expect(parseRemoteHealthPayload({ status: 'ok' })).toEqual({ kind: 'ok_all' });
    expect(parseRemoteHealthPayload({ status: 'unhealthy' })).toEqual({ kind: 'down' });
    expect(parseRemoteHealthPayload({ ok: false })).toEqual({ kind: 'down' });
  });
});

describe('VisibilityEngineHealthService', () => {
  it('resolves health URLs from explicit override or VISIBILITY_REMOTE_URL', () => {
    const derived = readVisibilityConfig({
      VISIBILITY_COLLECTOR: 'remote_scraper',
      VISIBILITY_REMOTE_URL: 'http://sonargate:8080/v1/collect',
    });
    expect(resolveRemoteHealthUrls(derived)).toEqual([
      'http://sonargate:8080/health',
      'http://sonargate:8080/v1/engines',
    ]);

    const explicit = readVisibilityConfig({
      VISIBILITY_COLLECTOR: 'remote_scraper',
      VISIBILITY_REMOTE_URL: 'http://sonargate:8080/v1/collect',
      VISIBILITY_REMOTE_HEALTH_URL: 'http://sonargate:8080/custom-health',
    });
    expect(resolveRemoteHealthUrls(explicit)).toEqual(['http://sonargate:8080/custom-health']);
  });

  it('defaults all engines online in fake mode and honors manual overrides', async () => {
    const svc = VisibilityEngineHealthService.fromEnv({
      VISIBILITY_COLLECTOR: 'fake',
      VISIBILITY_DISABLED_ENGINES: 'doubao,yuanbao',
    });

    const res = await svc.getAvailability();
    expect(res.collector).toBe('fake');
    expect(res.engines.find((e) => e.key === 'deepseek')?.available).toBe(true);
    expect(res.engines.find((e) => e.key === 'doubao')?.available).toBe(false);
    expect(res.engines.find((e) => e.key === 'yuanbao')?.status).toBe('offline');
    expect(await svc.getUnavailableEngines(['deepseek', 'doubao'])).toEqual(['doubao']);
  });

  it('probes remote /health and marks unlisted or unhealthy engines offline', async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (req) => {
      calls.push(req.url.toString());
      return makeJsonResponse(200, {
        status: 'ok',
        engines: { deepseek: true, kimi: true, doubao: false },
      });
    };

    const store = makeMemoryStore();
    const svc = VisibilityEngineHealthService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
        VISIBILITY_HEALTH_REFRESH_MS: '300000',
      },
      { resolver: publicResolver, transport, store },
    );

    const res = await svc.getAvailability();
    expect(calls).toEqual(['https://scraper.example.com/health']);
    expect(res.refreshIntervalMs).toBe(300_000);
    expect(res.checkedAt).toBeTruthy();
    expect(res.engines.find((e) => e.key === 'deepseek')?.available).toBe(true);
    expect(res.engines.find((e) => e.key === 'kimi')?.available).toBe(true);
    expect(res.engines.find((e) => e.key === 'doubao')?.available).toBe(false);
    expect(res.engines.find((e) => e.key === 'chatgpt')?.available).toBe(false);
    expect(store.value?.serviceReachable).toBe(true);
  });

  it('falls back to /v1/engines when /health returns 404', async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (req) => {
      const urlStr = req.url.toString();
      calls.push(urlStr);
      if (urlStr.endsWith('/health')) {
        return makeJsonResponse(404, { error: 'not found' });
      }
      return makeJsonResponse(200, { engines: ['deepseek', 'tongyi'] });
    };

    const svc = VisibilityEngineHealthService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      { resolver: publicResolver, transport },
    );

    const res = await svc.refreshHealth();
    expect(calls).toEqual([
      'https://scraper.example.com/health',
      'https://scraper.example.com/v1/engines',
    ]);
    expect(res.engines.filter((e) => e.available).map((e) => e.key)).toEqual([
      'deepseek',
      'tongyi',
    ]);
  });

  it('marks all engines offline when remote health endpoint is unreachable or 5xx', async () => {
    const transport: HttpTransport = vi.fn(async () => makeJsonResponse(503, { status: 'down' }));
    const svc = VisibilityEngineHealthService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      { resolver: publicResolver, transport },
    );

    const res = await svc.refreshHealth();
    expect(res.engines.every((e) => !e.available && e.status === 'offline')).toBe(true);
  });

  it('trips an engine offline after 2 consecutive upstream failures and restores on success', async () => {
    let nowMs = 1_700_000_000_000;
    const transport: HttpTransport = async () => makeJsonResponse(200, { status: 'ok' });
    const store = makeMemoryStore();
    const svc = VisibilityEngineHealthService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      { resolver: publicResolver, transport, store, now: () => nowMs },
    );

    await svc.refreshHealth();
    expect(await svc.getUnavailableEngines(['doubao'])).toEqual([]);

    const upstreamErr = new ProviderError(
      PROVIDER_KIND.UPSTREAM,
      '该引擎采集通道暂未上线或维护中',
      'upstream_5xx',
    );
    await svc.recordObservationFailure('doubao', upstreamErr);
    expect(await svc.getUnavailableEngines(['doubao'])).toEqual([]);

    nowMs += 1_000;
    await svc.recordObservationFailure('doubao', upstreamErr);
    expect(await svc.getUnavailableEngines(['doubao'])).toEqual(['doubao']);

    nowMs += 1_000;
    await svc.recordObservationSuccess('doubao');
    expect(await svc.getUnavailableEngines(['doubao'])).toEqual([]);
  });

  it('marks an engine offline immediately on a single engine_not_available failure (#324)', async () => {
    const transport: HttpTransport = async () => makeJsonResponse(200, { status: 'ok' });
    const svc = VisibilityEngineHealthService.fromEnv(
      {
        VISIBILITY_COLLECTOR: 'remote_scraper',
        VISIBILITY_REMOTE_URL: 'https://scraper.example.com/v1/collect',
      },
      { resolver: publicResolver, transport },
    );

    await svc.refreshHealth();
    expect(await svc.getUnavailableEngines(['yuanbao'])).toEqual([]);

    await svc.recordObservationFailure(
      'yuanbao',
      new ProviderError(
        PROVIDER_KIND.UPSTREAM,
        '该引擎采集通道暂未上线或维护中',
        'engine_not_available',
      ),
    );
    expect(await svc.getUnavailableEngines(['yuanbao'])).toEqual(['yuanbao']);
  });
});
