import { isVisibilityCollectorKind, type VisibilityCollectorKind } from '@geomix/shared';

export const VISIBILITY_CONFIG = Symbol('VISIBILITY_CONFIG');

export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
export const VISIBILITY_REMOTE_MAX_BYTES = 2 * 1024 * 1024;

export type VisibilityConfig = {
  collector: VisibilityCollectorKind;
  remoteUrl: string | null;
  remoteApiKey: string | null;
  timeoutMs: number;
  featureEnabled: boolean;
  ssrfAllowlist?: string;
};

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
  const ssrfAllowlistRaw = (env.SSRF_ALLOWLIST ?? '').trim();
  const timeoutMs = parsePositiveTimeout(
    env.VISIBILITY_TIMEOUT_MS,
    DEFAULT_VISIBILITY_TIMEOUT_MS,
    'VISIBILITY_TIMEOUT_MS',
  );

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
