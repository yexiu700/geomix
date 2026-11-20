import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINE_KEYS,
  isVisibilityEngine,
  type VisibilityEngineAvailabilityResponse,
  type VisibilityEngineHealthStatus,
  type VisibilityEngineKey,
} from '@geomix/shared';
import IORedis from 'ioredis';
import {
  createDnsResolver,
  requestOnce,
  type DnsResolver,
  type HttpTransport,
} from '../infra/guarded-request';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { createUndiciTransport } from '../infra/undici-transport';
import {
  DEFAULT_VISIBILITY_HEALTH_TIMEOUT_MS,
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  resolveVisibilityHealthRefreshMs,
  type VisibilityConfig,
} from './visibility.config';

export const VISIBILITY_ENGINE_HEALTH_DEPS = Symbol('VISIBILITY_ENGINE_HEALTH_DEPS');

const REDIS_KEY = 'geomix:visibility:engine-health:v1';
const LOCAL_CACHE_TTL_MS = 30_000;
const HEALTH_MAX_BYTES = 512 * 1024;
const PASSIVE_FAILURE_THRESHOLD = 2;

export type PersistedEngineHealth = {
  checkedAt: string | null;
  serviceReachable: boolean;
  /** Per-engine availability from the remote health endpoint (null = service-level only). */
  remoteEngines: Partial<Record<VisibilityEngineKey, boolean>> | null;
  /** Consecutive upstream/network failures recorded during real observation runs. */
  failureCounts: Partial<Record<VisibilityEngineKey, number>>;
  /** Engines tripped offline by runtime passive circuit breaker. */
  trippedOffline: Partial<Record<VisibilityEngineKey, number>>;
};

export type EngineHealthStore = {
  get(): Promise<PersistedEngineHealth | null>;
  set(state: PersistedEngineHealth, ttlMs: number): Promise<void>;
  close?(): Promise<void>;
};

export type VisibilityEngineHealthDeps = {
  resolver?: DnsResolver;
  transport?: HttpTransport;
  store?: EngineHealthStore;
  now?: () => number;
  env?: Record<string, string | undefined>;
};

export type ParsedRemoteHealth =
  | { kind: 'down' }
  | { kind: 'ok_all' }
  | { kind: 'engines'; availability: Partial<Record<VisibilityEngineKey, boolean>> };

function createEmptyState(): PersistedEngineHealth {
  return {
    checkedAt: null,
    serviceReachable: true,
    remoteEngines: null,
    failureCounts: {},
    trippedOffline: {},
  };
}

function createRedisHealthStore(redisUrl: string): EngineHealthStore {
  let client: IORedis | null = null;
  const ensure = (): IORedis => {
    if (!client) {
      client = new IORedis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: 3_000,
      });
      client.on('error', () => {
        // Silent fallback to in-memory cache when Redis is unavailable.
      });
    }
    return client;
  };

  return {
    async get() {
      try {
        const raw = await ensure().get(REDIS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedEngineHealth>;
        if (!parsed || typeof parsed !== 'object') return null;
        return {
          checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
          serviceReachable: parsed.serviceReachable !== false,
          remoteEngines:
            parsed.remoteEngines && typeof parsed.remoteEngines === 'object'
              ? parsed.remoteEngines
              : null,
          failureCounts:
            parsed.failureCounts && typeof parsed.failureCounts === 'object'
              ? parsed.failureCounts
              : {},
          trippedOffline:
            parsed.trippedOffline && typeof parsed.trippedOffline === 'object'
              ? parsed.trippedOffline
              : {},
        };
      } catch {
        return null;
      }
    },
    async set(state, ttlMs) {
      try {
        const px = Math.max(60_000, Math.round(ttlMs));
        await ensure().set(REDIS_KEY, JSON.stringify(state), 'PX', px);
      } catch {
        // Ignore Redis write errors; local memory cache still holds the latest state.
      }
    },
    async close() {
      if (!client) return;
      const current = client;
      client = null;
      try {
        await current.quit();
      } catch {
        current.disconnect();
      }
    },
  };
}

function lazyUndiciTransport(): HttpTransport {
  let cached: HttpTransport | undefined;
  return (req) => {
    if (!cached) {
      cached = createUndiciTransport();
    }
    return cached(req);
  };
}

@Injectable()
export class VisibilityEngineHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(VisibilityEngineHealthService.name);
  private readonly config: VisibilityConfig;
  private readonly resolver: DnsResolver;
  private readonly transport: HttpTransport;
  private readonly store: EngineHealthStore | null;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  private cachedState: PersistedEngineHealth | null = null;
  private cachedAtMs = 0;
  private inFlightRefresh: Promise<PersistedEngineHealth> | null = null;

  constructor(
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
    @Optional() @Inject(VISIBILITY_ENGINE_HEALTH_DEPS) deps?: VisibilityEngineHealthDeps,
  ) {
    this.env = deps?.env ?? process.env;
    this.config = config ?? readVisibilityConfig(this.env);
    this.resolver = deps?.resolver ?? createDnsResolver();
    this.transport = deps?.transport ?? lazyUndiciTransport();
    this.now = deps?.now ?? (() => Date.now());
    if (deps?.store) {
      this.store = deps.store;
    } else if (this.env.REDIS_URL && this.env.NODE_ENV !== 'test') {
      this.store = createRedisHealthStore(this.env.REDIS_URL);
    } else {
      this.store = null;
    }
  }

  static fromEnv(
    env: Record<string, string | undefined>,
    deps?: Omit<VisibilityEngineHealthDeps, 'env'>,
  ): VisibilityEngineHealthService {
    return new VisibilityEngineHealthService(readVisibilityConfig(env), { ...deps, env });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.store?.close) {
      await this.store.close();
    }
  }

  getRefreshIntervalMs(): number {
    return resolveVisibilityHealthRefreshMs(this.config);
  }

  async getAvailability(): Promise<VisibilityEngineAvailabilityResponse> {
    const refreshIntervalMs = this.getRefreshIntervalMs();

    if (this.config.collector === 'fake') {
      return this.buildResponse(createEmptyState(), refreshIntervalMs, () => true);
    }

    if (this.config.collector === 'llm_api') {
      const state = await this.loadState(false);
      const hasAnyLlm = hasConfiguredLlmProvider(this.env);
      return this.buildResponse(state, refreshIntervalMs, (key) => {
        if (!hasAnyLlm) return false;
        return !state.trippedOffline[key];
      });
    }

    // remote_scraper mode
    if (!this.config.remoteUrl) {
      return this.buildResponse(
        { ...createEmptyState(), serviceReachable: false },
        refreshIntervalMs,
        () => false,
      );
    }

    const state = await this.loadState(true);
    return this.buildResponse(state, refreshIntervalMs, (key) => {
      if (!state.serviceReachable) return false;
      if (state.trippedOffline[key]) return false;
      if (state.remoteEngines) {
        return state.remoteEngines[key] === true;
      }
      return true;
    });
  }

  async getUnavailableEngines(
    engines: readonly VisibilityEngineKey[],
  ): Promise<VisibilityEngineKey[]> {
    const availability = await this.getAvailability();
    const map = new Map(availability.engines.map((item) => [item.key, item.available]));
    return engines.filter((key) => map.get(key) === false);
  }

  async refreshHealth(): Promise<VisibilityEngineAvailabilityResponse> {
    if (this.config.collector !== 'remote_scraper' || !this.config.remoteUrl) {
      return this.getAvailability();
    }

    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.probeRemoteHealth().finally(() => {
        this.inFlightRefresh = null;
      });
    }
    await this.inFlightRefresh;
    return this.getAvailability();
  }

  async recordObservationSuccess(engine: string): Promise<void> {
    const key = engine.trim().toLowerCase();
    if (!isVisibilityEngine(key)) return;
    if (this.config.collector === 'fake') return;

    const current = (await this.readPersistedOrMemory()) ?? createEmptyState();
    const hadFailure =
      (current.failureCounts[key] ?? 0) > 0 || Boolean(current.trippedOffline[key]);
    const remoteMarkedOff = current.remoteEngines?.[key] === false;

    if (!hadFailure && current.serviceReachable && !remoteMarkedOff) {
      return;
    }

    const next: PersistedEngineHealth = {
      checkedAt: current.checkedAt ?? new Date(this.now()).toISOString(),
      serviceReachable: true,
      remoteEngines: current.remoteEngines ? { ...current.remoteEngines, [key]: true } : null,
      failureCounts: { ...current.failureCounts, [key]: 0 },
      trippedOffline: omitEngineKey(current.trippedOffline, key),
    };
    await this.saveState(next);
  }

  async recordObservationFailure(engine: string, error: unknown): Promise<void> {
    const key = engine.trim().toLowerCase();
    if (!isVisibilityEngine(key)) return;
    if (this.config.collector === 'fake') return;
    if (!isConnectivityFailure(error)) return;

    const current = (await this.readPersistedOrMemory()) ?? createEmptyState();
    const isExplicitlyUnsupported =
      error instanceof ProviderError && error.reason === 'engine_not_available';
    const nextCount = isExplicitlyUnsupported
      ? Math.max(PASSIVE_FAILURE_THRESHOLD, (current.failureCounts[key] ?? 0) + 1)
      : (current.failureCounts[key] ?? 0) + 1;
    const tripped =
      nextCount >= PASSIVE_FAILURE_THRESHOLD
        ? { ...current.trippedOffline, [key]: this.now() }
        : current.trippedOffline;

    const next: PersistedEngineHealth = {
      checkedAt: current.checkedAt ?? new Date(this.now()).toISOString(),
      serviceReachable: current.serviceReachable,
      remoteEngines: current.remoteEngines,
      failureCounts: { ...current.failureCounts, [key]: nextCount },
      trippedOffline: tripped,
    };

    if (nextCount === PASSIVE_FAILURE_THRESHOLD && !current.trippedOffline[key]) {
      this.logger.warn(
        isExplicitlyUnsupported
          ? `visibility engine "${key}" marked offline immediately (remote reported engine_not_available)`
          : `visibility engine "${key}" tripped offline after ${PASSIVE_FAILURE_THRESHOLD} consecutive upstream failures`,
      );
    }
    await this.saveState(next);
  }

  private async loadState(probeIfMissing: boolean): Promise<PersistedEngineHealth> {
    const nowMs = this.now();
    if (this.cachedState && nowMs - this.cachedAtMs < LOCAL_CACHE_TTL_MS) {
      return this.cachedState;
    }

    const stored = await this.readPersistedOrMemory();
    if (stored) {
      this.cachedState = stored;
      this.cachedAtMs = nowMs;
      return stored;
    }

    if (probeIfMissing && this.config.collector === 'remote_scraper' && this.config.remoteUrl) {
      if (!this.inFlightRefresh) {
        this.inFlightRefresh = this.probeRemoteHealth().finally(() => {
          this.inFlightRefresh = null;
        });
      }
      return this.inFlightRefresh;
    }

    return createEmptyState();
  }

  private async readPersistedOrMemory(): Promise<PersistedEngineHealth | null> {
    if (this.store) {
      const fromStore = await this.store.get();
      if (fromStore) return fromStore;
    }
    return this.cachedState;
  }

  private async saveState(state: PersistedEngineHealth): Promise<void> {
    this.cachedState = state;
    this.cachedAtMs = this.now();
    if (this.store) {
      const ttlMs = Math.max(this.getRefreshIntervalMs() * 3, 15 * 60_000);
      await this.store.set(state, ttlMs);
    }
  }

  private async probeRemoteHealth(): Promise<PersistedEngineHealth> {
    const nowMs = this.now();
    const checkedAt = new Date(nowMs).toISOString();
    const urls = resolveRemoteHealthUrls(this.config);
    const previous = await this.readPersistedOrMemory();

    if (urls.length === 0) {
      const downState: PersistedEngineHealth = {
        checkedAt,
        serviceReachable: false,
        remoteEngines: null,
        failureCounts: {},
        trippedOffline: {},
      };
      await this.saveState(downState);
      return downState;
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.config.remoteApiKey) {
      headers.authorization = `Bearer ${this.config.remoteApiKey}`;
    }
    const timeoutMs = Math.min(this.config.timeoutMs, DEFAULT_VISIBILITY_HEALTH_TIMEOUT_MS);

    let lastOutcome: ParsedRemoteHealth = { kind: 'down' };

    for (const url of urls) {
      try {
        const response = await requestOnce({
          url,
          method: 'GET',
          headers,
          timeoutMs,
          maxBytes: HEALTH_MAX_BYTES,
          resolver: this.resolver,
          transport: this.transport,
          allowlist: this.config.ssrfAllowlist,
        });

        if (response.status === 404 && urls.length > 1) {
          continue;
        }
        if (response.status >= 200 && response.status < 300) {
          let payload: unknown = null;
          const text = response.body.toString('utf8').trim();
          if (text.length > 0) {
            try {
              payload = JSON.parse(text) as unknown;
            } catch {
              payload = { status: 'ok' };
            }
          }
          lastOutcome = parseRemoteHealthPayload(payload);
          break;
        }
        lastOutcome = { kind: 'down' };
        break;
      } catch (error) {
        this.logger.warn(
          `remote visibility health probe failed (${url}): ${error instanceof Error ? error.message : 'unknown'}`,
        );
        lastOutcome = { kind: 'down' };
      }
    }

    let next: PersistedEngineHealth;
    if (lastOutcome.kind === 'down') {
      next = {
        checkedAt,
        serviceReachable: false,
        remoteEngines: null,
        failureCounts: {},
        trippedOffline: {},
      };
    } else if (lastOutcome.kind === 'engines') {
      // Remote endpoint returned explicit per-engine status; reset stale passive trips for engines reported online.
      const nextTripped: Partial<Record<VisibilityEngineKey, number>> = {};
      const nextCounts: Partial<Record<VisibilityEngineKey, number>> = {};
      for (const key of VISIBILITY_ENGINE_KEYS) {
        if (lastOutcome.availability[key] === true) {
          nextCounts[key] = 0;
        } else if (previous?.trippedOffline[key]) {
          nextTripped[key] = previous.trippedOffline[key];
        }
      }
      next = {
        checkedAt,
        serviceReachable: true,
        remoteEngines: lastOutcome.availability,
        failureCounts: nextCounts,
        trippedOffline: nextTripped,
      };
    } else {
      // Service-level ok without per-engine breakdown; keep recent passive trips within one refresh window.
      const refreshMs = this.getRefreshIntervalMs();
      const nextTripped: Partial<Record<VisibilityEngineKey, number>> = {};
      const nextCounts: Partial<Record<VisibilityEngineKey, number>> = {};
      for (const key of VISIBILITY_ENGINE_KEYS) {
        const trippedAt = previous?.trippedOffline[key];
        if (trippedAt && nowMs - trippedAt < refreshMs) {
          nextTripped[key] = trippedAt;
          nextCounts[key] = previous?.failureCounts[key] ?? PASSIVE_FAILURE_THRESHOLD;
        }
      }
      next = {
        checkedAt,
        serviceReachable: true,
        remoteEngines: null,
        failureCounts: nextCounts,
        trippedOffline: nextTripped,
      };
    }

    await this.saveState(next);
    return next;
  }

  private buildResponse(
    state: PersistedEngineHealth,
    refreshIntervalMs: number,
    isBaseAvailable: (key: VisibilityEngineKey) => boolean,
  ): VisibilityEngineAvailabilityResponse {
    const enabledOverride = this.config.enabledEngines ? new Set(this.config.enabledEngines) : null;
    const disabledOverride = this.config.disabledEngines
      ? new Set(this.config.disabledEngines)
      : null;

    return {
      collector: this.config.collector,
      checkedAt: state.checkedAt,
      refreshIntervalMs,
      engines: VISIBILITY_ENGINES.map((eng) => {
        let available = isBaseAvailable(eng.key);
        if (enabledOverride) {
          available = enabledOverride.has(eng.key);
        }
        if (disabledOverride?.has(eng.key)) {
          available = false;
        }
        const status: VisibilityEngineHealthStatus = available ? 'online' : 'offline';
        return {
          key: eng.key,
          label: eng.label,
          domestic: eng.domestic,
          available,
          status,
        };
      }),
    };
  }
}

export function resolveRemoteHealthUrls(config: VisibilityConfig): string[] {
  if (config.remoteHealthUrl) {
    return [config.remoteHealthUrl];
  }
  if (!config.remoteUrl) {
    return [];
  }
  try {
    const healthUrl = new URL('/health', config.remoteUrl).toString();
    const enginesUrl = new URL('/v1/engines', config.remoteUrl).toString();
    return healthUrl === enginesUrl ? [healthUrl] : [healthUrl, enginesUrl];
  } catch {
    return [];
  }
}

export function parseRemoteHealthPayload(payload: unknown): ParsedRemoteHealth {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'ok_all' };
  }
  const root = payload as Record<string, unknown>;
  const dataNode =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : null;

  if (isExplicitlyUnhealthy(root) || (dataNode && isExplicitlyUnhealthy(dataNode))) {
    return { kind: 'down' };
  }

  const candidateFields = [
    root.engines,
    root.availableEngines,
    root.supportedEngines,
    root.onlineEngines,
    root.providers,
    root.channels,
    dataNode?.engines,
    dataNode?.availableEngines,
    dataNode?.supportedEngines,
    dataNode?.onlineEngines,
    dataNode?.providers,
    dataNode?.channels,
  ];

  for (const field of candidateFields) {
    const parsed = parseEngineCollection(field);
    if (parsed) {
      return { kind: 'engines', availability: parsed };
    }
  }

  return { kind: 'ok_all' };
}

function isExplicitlyUnhealthy(obj: Record<string, unknown>): boolean {
  if (obj.ok === false || obj.healthy === false || obj.available === false) {
    return true;
  }
  const status = typeof obj.status === 'string' ? obj.status.trim().toLowerCase() : '';
  return (
    status === 'down' ||
    status === 'error' ||
    status === 'unhealthy' ||
    status === 'offline' ||
    status === 'fail' ||
    status === 'failed'
  );
}

function parseEngineCollection(raw: unknown): Partial<Record<VisibilityEngineKey, boolean>> | null {
  if (Array.isArray(raw)) {
    const result: Partial<Record<VisibilityEngineKey, boolean>> = {};
    let recognizedAny = false;
    for (const item of raw) {
      if (typeof item === 'string') {
        const key = item.trim().toLowerCase();
        if (isVisibilityEngine(key)) {
          result[key] = true;
          recognizedAny = true;
        }
        continue;
      }
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const rawKey = rec.key ?? rec.engine ?? rec.name ?? rec.id;
        if (typeof rawKey !== 'string') continue;
        const key = rawKey.trim().toLowerCase();
        if (!isVisibilityEngine(key)) continue;
        result[key] = interpretEngineValue(rec);
        recognizedAny = true;
      }
    }
    if (recognizedAny || raw.length === 0) {
      return result;
    }
    return null;
  }

  if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>);
    const result: Partial<Record<VisibilityEngineKey, boolean>> = {};
    let recognizedAny = false;
    for (const [rawKey, value] of entries) {
      const key = rawKey.trim().toLowerCase();
      if (!isVisibilityEngine(key)) continue;
      result[key] = interpretEngineValue(value);
      recognizedAny = true;
    }
    if (recognizedAny || entries.length === 0) {
      return result;
    }
  }

  return null;
}

function interpretEngineValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return (
      lower === 'ok' ||
      lower === 'online' ||
      lower === 'healthy' ||
      lower === 'up' ||
      lower === 'ready' ||
      lower === 'available' ||
      lower === 'enabled' ||
      lower === 'active'
    );
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.available === 'boolean') return rec.available;
    if (typeof rec.online === 'boolean') return rec.online;
    if (typeof rec.healthy === 'boolean') return rec.healthy;
    if (typeof rec.enabled === 'boolean') return rec.enabled;
    if (typeof rec.ok === 'boolean') return rec.ok;
    if (typeof rec.status === 'string') return interpretEngineValue(rec.status);
  }
  return false;
}

function isConnectivityFailure(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return (
    error.kind === PROVIDER_KIND.UPSTREAM ||
    error.kind === PROVIDER_KIND.TIMEOUT ||
    error.kind === PROVIDER_KIND.SSRF
  );
}

function omitEngineKey<T>(
  record: Partial<Record<VisibilityEngineKey, T>>,
  keyToRemove: VisibilityEngineKey,
): Partial<Record<VisibilityEngineKey, T>> {
  const next: Partial<Record<VisibilityEngineKey, T>> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== keyToRemove && isVisibilityEngine(key)) {
      next[key] = value;
    }
  }
  return next;
}

function hasConfiguredLlmProvider(env: Record<string, string | undefined>): boolean {
  if (env.DEEPSEEK_API_KEY?.trim() || env.TONGYI_API_KEY?.trim() || env.DOUBAO_API_KEY?.trim()) {
    return true;
  }
  const raw = env.LLM_PROVIDERS?.trim();
  if (!raw || raw === '{}') return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
  } catch {
    return false;
  }
}
