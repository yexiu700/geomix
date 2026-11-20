import {
  isVisibilityCollectorKind,
  isVisibilityEngine,
  type VisibilityCollectorKind,
  type VisibilityEngineKey,
} from '@geomix/shared';

export const VISIBILITY_CONFIG = Symbol('VISIBILITY_CONFIG');

export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
export const DEFAULT_VISIBILITY_HEALTH_REFRESH_MS = 5 * 60_000;
export const DEFAULT_VISIBILITY_HEALTH_TIMEOUT_MS = 10_000;
export const VISIBILITY_REMOTE_MAX_BYTES = 2 * 1024 * 1024;

export type VisibilityConfig = {
  collector: VisibilityCollectorKind;
  remoteUrl: string | null;
  remoteApiKey: string | null;
  timeoutMs: number;
  featureEnabled: boolean;
  ssrfAllowlist?: string;
  remoteHealthUrl?: string;
  healthRefreshMs?: number;
  enabledEngines?: VisibilityEngineKey[];
  disabledEngines?: VisibilityEngineKey[];
};

export function resolveVisibilityHealthRefreshMs(config: VisibilityConfig): number {
  return config.healthRefreshMs ?? DEFAULT_VISIBILITY_HEALTH_REFRESH_MS;
}

export function readVisibilityConfig(
  env: Record<string, string | undefined> = process.env,
): VisibilityConfig {
  const rawCollector = (env.VISIBILITY_COLLECTOR ?? 'fake').trim() || 'fake';
  if (!isVisibilityCollectorKind(rawCollector)) {
    throw new Error(
      `Invalid VISIBILITY_COLLECTOR "${rawCollector}". Expected fake, llm_api, or remote_scraper.`,
    );
  }

  const remoteUrlRaw = (env.VISIBILITY_REMOTE_URL ?? '').trim();
  const remoteApiKeyRaw = (env.VISIBILITY_REMOTE_API_KEY ?? '').trim();
  const remoteHealthUrlRaw = (env.VISIBILITY_REMOTE_HEALTH_URL ?? '').trim();
  const ssrfAllowlistRaw = (env.SSRF_ALLOWLIST ?? '').trim();
  const timeoutMs = parsePositiveTimeout(
    env.VISIBILITY_TIMEOUT_MS,
    DEFAULT_VISIBILITY_TIMEOUT_MS,
    'VISIBILITY_TIMEOUT_MS',
  );
  const healthRefreshMs = parseOptionalDuration(
    env.VISIBILITY_HEALTH_REFRESH_MS,
    10_000,
    3_600_000,
    'VISIBILITY_HEALTH_REFRESH_MS',
  );
  const enabledEngines = parseOptionalEngineList(env.VISIBILITY_ENABLED_ENGINES);
  const disabledEngines = parseOptionalEngineList(env.VISIBILITY_DISABLED_ENGINES);

  const rawFeature = (env.FEATURE_VISIBILITY ?? 'true').trim().toLowerCase();
  if (rawFeature !== 'true' && rawFeature !== 'false') {
    throw new Error('FEATURE_VISIBILITY must be true or false');
  }

  return {
    collector: rawCollector,
    remoteUrl: remoteUrlRaw.length > 0 ? remoteUrlRaw : null,
    remoteApiKey: remoteApiKeyRaw.length > 0 ? remoteApiKeyRaw : null,
    timeoutMs,
    featureEnabled: rawFeature === 'true',
    ...(ssrfAllowlistRaw.length > 0 ? { ssrfAllowlist: ssrfAllowlistRaw } : {}),
    ...(remoteHealthUrlRaw.length > 0 ? { remoteHealthUrl: remoteHealthUrlRaw } : {}),
    ...(healthRefreshMs !== undefined ? { healthRefreshMs } : {}),
    ...(enabledEngines !== undefined ? { enabledEngines } : {}),
    ...(disabledEngines !== undefined ? { disabledEngines } : {}),
  };
}

function parsePositiveTimeout(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new Error(`${name} must be between 100 and 300000`);
  }
  return value;
}

function parseOptionalDuration(
  raw: string | undefined,
  min: number,
  max: number,
  name: string,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function parseOptionalEngineList(raw: string | undefined): VisibilityEngineKey[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const out: VisibilityEngineKey[] = [];
  const seen = new Set<VisibilityEngineKey>();
  for (const part of raw.split(',')) {
    const key = part.trim().toLowerCase();
    if (!key || !isVisibilityEngine(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
