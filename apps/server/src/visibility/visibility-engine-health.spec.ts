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

    // #337: configured boolean & plannedEngines array
    expect(
      parseRemoteHealthPayload({
        engines: [
          { key: 'deepseek', configured: true, status: 'ready' },
          { key: 'doubao', configured: false, status: 'ready' },
          { key: 'kimi', configured: true, status: 'offline' },
        ],
        plannedEngines: ['yuanbao', 'tongyi', 'wenxin'],
      }),
    ).toEqual({
      kind: 'engines',
      availability: {
        deepseek: true,
        doubao: false,
        kimi: false,
        yuanbao: false,
        tongyi: false,
        wenxin: false,
      },
    });
  });
});

describe('VisibilityEngineHealthService', () => {
  it('resolves health URLs with /v1/engines prioritized before /ready and /health (#337)', () => {
    const derived = readVisibilityConfig({
      VISIBILITY_COLLECTOR: 'remote_scraper',
      VISIBILITY_REMOTE_URL: 'http://sonargate:8080/v1/collect',
    });
    expect(resolveRemoteHealthUrls(derived)).toEqual([
      'http://sonargate:8080/v1/engines',
      'http://sonargate:8080/ready',
      'http://sonargate:8080/health',
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

  it('probes remote /v1/engines first and marks unlisted, planned, or unhealthy engines offline (#337)', async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (req) => {
      calls.push(req.url.toString());
      return makeJsonResponse(200, {
        status: 'ok',
        engines: [
          { key: 'deepseek', configured: true, status: 'ready' },
          { key: 'tongyi', configured: true, status: 'ready' },
          { key: 'kimi', configured: true, status: 'ready' },
          { key: 'doubao', configured: false, status: 'ready' },
        ],
        plannedEngines: ['yuanbao'],
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

    const res = await svc.getAvailability('CN');
    expect(calls).toEqual(['https://scraper.example.com/v1/engines']);
    expect(res.refreshIntervalMs).toBe(300_000);
    expect(res.checkedAt).toBeTruthy();
    expect(res.engines.find((e) => e.key === 'deepseek')).toMatchObject({
      available: true,
      defaultChecked: true,
      unavailableReason: null,
    });
    expect(res.engines.find((e) => e.key === 'tongyi')).toMatchObject({
      available: true,
      defaultChecked: true,
    });
    expect(res.engines.find((e) => e.key === 'kimi')).toBeUndefined();
    expect(res.engines.find((e) => e.key === 'doubao')).toMatchObject({
      available: false,
      defaultChecked: false,
      unavailableReason: '暂未上线',
    });
    expect(res.engines.find((e) => e.key === 'yuanbao')).toMatchObject({
      available: false,
      defaultChecked: false,
      unavailableReason: '暂未上线',
    });
    expect(store.value?.serviceReachable).toBe(true);
  });

  it('falls back to /ready and /health when /v1/engines returns 404 or 401 (#337)', async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (req) => {
      const urlStr = req.url.toString();
      calls.push(urlStr);
      if (urlStr.endsWith('/v1/engines')) {
        return makeJsonResponse(404, { error: 'not found' });
      }
      if (urlStr.endsWith('/ready')) {
        return makeJsonResponse(200, { status: 'ok' });
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
    // /ready returned service-level ok_all without engine list, so probe continues to /health
    expect(calls).toEqual([
      'https://scraper.example.com/v1/engines',
      'https://scraper.example.com/ready',
      'https://scraper.example.com/health',
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

  it('filters availability strictly by market (CN=4 active canonical tongyi, GLOBAL=5) with defaultChecked and 暂未上线 reason (#411)', async () => {
    const svc = VisibilityEngineHealthService.fromEnv({
      VISIBILITY_COLLECTOR: 'fake',
      VISIBILITY_DISABLED_ENGINES: 'yuanbao,kimi,claude',
    });

    const cn = await svc.getAvailability('CN');
    expect(cn.market).toBe('CN');
    expect(cn.engines).toHaveLength(4);
    expect(cn.engines.map((e) => e.key)).toEqual(['deepseek', 'doubao', 'yuanbao', 'tongyi']);
    expect(cn.engines.every((e) => e.domestic && e.market === 'CN')).toBe(true);
    expect(cn.engines.find((e) => e.key === 'deepseek')).toMatchObject({
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    });
    expect(cn.engines.find((e) => e.key === 'yuanbao')).toMatchObject({
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    });

    const global = await svc.getAvailability('GLOBAL');
    expect(global.market).toBe('GLOBAL');
    expect(global.engines).toHaveLength(5);
    expect(global.engines.map((e) => e.key)).toEqual([
      'chatgpt',
      'perplexity',
      'claude',
      'gemini',
      'google_aio',
    ]);
    expect(global.engines.every((e) => !e.domestic && e.market === 'GLOBAL')).toBe(true);
    expect(global.engines.find((e) => e.key === 'claude')).toMatchObject({
      available: false,
      status: 'offline',
      defaultChecked: false,
      unavailableReason: '暂未上线',
    });
    expect(global.engines.find((e) => e.key === 'chatgpt')).toMatchObject({
      available: true,
      status: 'online',
      defaultChecked: true,
      unavailableReason: null,
    });
  });
});
