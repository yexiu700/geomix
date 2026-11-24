import {
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  PUBLIC_PRICING_FALLBACK,
  isZeroAllowedPricingAction,
  type CreateMarketingLeadPayload,
  type FreeRateLimitedAction,
  type PointsEstimateUnitPoints,
  type PricingAction,
  type PublicFreeAction,
  type PublicPricingItem,
  type PublicPricingPayload,
} from '@geomix/shared';
import { GatewayApiError, unwrapEnvelope } from './envelope';
import { apiV2Base } from './session';

export const PUBLIC_PRICING_TIMEOUT_MS = 2_000;

const MAX_PUBLIC_UNIT_POINTS = 1_000_000;
const PRICING_ACTION_SET = new Set<string>(PRICING_DEFAULTS.map((item) => item.action));
const FREE_ACTION_SET = new Set<string>(FREE_RATE_LIMITED_ACTIONS);

export type MarketingLeadSubmitResult = {
  accepted: true;
  id?: string;
};

export class MarketingApiError extends GatewayApiError {
  constructor(
    status: number,
    code: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(status, code, message);
  }
}

export function isMarketingApiError(error: unknown): error is MarketingApiError {
  return error instanceof MarketingApiError;
}

export type FetchPublicPricingOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type SubmitMarketingLeadOptions = {
  apiBaseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clonePublicPricingPayload(payload: PublicPricingPayload): PublicPricingPayload {
  return {
    items: payload.items.map((item) => ({ ...item })),
    freeActions: payload.freeActions.map((entry) => ({ ...entry })),
    demoTrial: {
      points: payload.demoTrial.points,
      validDays: payload.demoTrial.validDays,
    },
  };
}

/**
 * Resolves the absolute server-side URL for `GET /api/v2/public/pricing`.
 * Returns `null` when unset, relative (e.g. `/api/v1`), non-HTTP(S), or malformed
 * so SSR and `next build` safely fall back to `PUBLIC_PRICING_FALLBACK` without network calls.
 */
export function resolveServerPublicPricingUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const candidates = [env.INTERNAL_API_BASE, env.NEXT_PUBLIC_API_V2_BASE, env.NEXT_PUBLIC_API_BASE];
  const rawCandidate = candidates.find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  if (!rawCandidate || hasControlChar(rawCandidate)) {
    return null;
  }

  const trimmed = rawCandidate.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }

  const cleanPath = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const base = `${parsed.origin}${cleanPath}`;

  let v2Base: string;
  if (/\/api\/v2$/i.test(base)) {
    v2Base = base.replace(/\/api\/v2$/i, '/api/v2');
  } else if (/\/api\/v1$/i.test(base)) {
    v2Base = base.replace(/\/api\/v1$/i, '/api/v2');
  } else if (/\/v2$/i.test(base)) {
    v2Base = base.replace(/\/v2$/i, '/v2');
  } else if (/\/v1$/i.test(base)) {
    v2Base = base.replace(/\/v1$/i, '/v2');
  } else if (/\/api$/i.test(base)) {
    v2Base = `${base.replace(/\/api$/i, '/api')}/v2`;
  } else {
    v2Base = `${base}/api/v2`;
  }

  return `${v2Base}/public/pricing`;
}

/**
 * Strictly validates and strips unexpected fields from a `GET /api/v2/public/pricing` payload.
 */
export function parsePublicPricingPayload(raw: unknown): PublicPricingPayload | null {
  if (!isPlainRecord(raw)) return null;
  if (!Array.isArray(raw.items) || raw.items.length !== PUBLIC_PRICING_FALLBACK.items.length) {
    return null;
  }
  if (
    !Array.isArray(raw.freeActions) ||
    raw.freeActions.length !== PUBLIC_PRICING_FALLBACK.freeActions.length
  ) {
    return null;
  }
  if (!isPlainRecord(raw.demoTrial)) {
    return null;
  }

  const seenActions = new Set<string>();
  const items: PublicPricingItem[] = [];
  for (const entry of raw.items) {
    if (!isPlainRecord(entry)) return null;
    const action = entry.action;
    if (typeof action !== 'string' || !PRICING_ACTION_SET.has(action) || seenActions.has(action)) {
      return null;
    }
    const unitPoints = entry.unitPoints;
    if (
      typeof unitPoints !== 'number' ||
      !Number.isSafeInteger(unitPoints) ||
      unitPoints > MAX_PUBLIC_UNIT_POINTS
    ) {
      return null;
    }
    const normalizedPoints = unitPoints === 0 ? 0 : unitPoints;
    const pointsValid = isZeroAllowedPricingAction(action)
      ? normalizedPoints >= 0
      : normalizedPoints > 0;
    if (!pointsValid) {
      return null;
    }

    if (
      !isNonEmptyString(entry.label) ||
      !isNonEmptyString(entry.labelEn) ||
      !isNonEmptyString(entry.unitZh) ||
      !isNonEmptyString(entry.unitEn) ||
      !isNonEmptyString(entry.descriptionZh) ||
      !isNonEmptyString(entry.descriptionEn)
    ) {
      return null;
    }

    seenActions.add(action);
    items.push({
      action: action as PricingAction,
      unitPoints: normalizedPoints,
      label: entry.label.trim(),
      labelEn: entry.labelEn.trim(),
      unitZh: entry.unitZh.trim(),
      unitEn: entry.unitEn.trim(),
      descriptionZh: entry.descriptionZh.trim(),
      descriptionEn: entry.descriptionEn.trim(),
    });
  }

  const seenFreeActions = new Set<string>();
  const freeActions: PublicFreeAction[] = [];
  for (const entry of raw.freeActions) {
    if (!isPlainRecord(entry)) return null;
    const action = entry.action;
    if (typeof action !== 'string' || !FREE_ACTION_SET.has(action) || seenFreeActions.has(action)) {
      return null;
    }
    if (
      !isNonEmptyString(entry.labelZh) ||
      !isNonEmptyString(entry.labelEn) ||
      !isNonEmptyString(entry.descriptionZh) ||
      !isNonEmptyString(entry.descriptionEn)
    ) {
      return null;
    }

    seenFreeActions.add(action);
    freeActions.push({
      action: action as FreeRateLimitedAction,
      labelZh: entry.labelZh.trim(),
      labelEn: entry.labelEn.trim(),
      descriptionZh: entry.descriptionZh.trim(),
      descriptionEn: entry.descriptionEn.trim(),
    });
  }

  const points = raw.demoTrial.points;
  const validDays = raw.demoTrial.validDays;
  if (
    typeof points !== 'number' ||
    !Number.isSafeInteger(points) ||
    points <= 0 ||
    typeof validDays !== 'number' ||
    !Number.isSafeInteger(validDays) ||
    validDays <= 0
  ) {
    return null;
  }

  return {
    items,
    freeActions,
    demoTrial: {
      points,
      validDays,
    },
  };
}

/**
 * Parses `Retry-After` HTTP header values (either integer delta seconds or HTTP-date).
 */
export function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  }

  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) {
    return undefined;
  }

  const deltaSeconds = Math.ceil((targetMs - Date.now()) / 1000);
  return Number.isSafeInteger(deltaSeconds) && deltaSeconds >= 1 ? deltaSeconds : undefined;
}

/**
 * Extracts calculator unit points from a public pricing payload, preserving `geo_variant: 0`.
 */
export function extractCalculatorUnitPoints(
  pricing: PublicPricingPayload,
): PointsEstimateUnitPoints {
  const byAction = new Map<PricingAction, number>();
  for (const item of pricing.items) {
    byAction.set(item.action, item.unitPoints);
  }
  return {
    geo_write: byAction.get('geo_write'),
    geo_variant: byAction.get('geo_variant'),
    visibility_check: byAction.get('visibility_check'),
  };
}

/**
 * SSR-safe loader for `GET /api/v2/public/pricing`.
 * Never throws; falls back to an immutable clone of `PUBLIC_PRICING_FALLBACK`.
 */
export async function fetchPublicPricing(
  options?: FetchPublicPricingOptions,
): Promise<PublicPricingPayload> {
  const url = resolveServerPublicPricingUrl(options?.env);
  if (!url) {
    return clonePublicPricingPayload(PUBLIC_PRICING_FALLBACK);
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const rawTimeout = options?.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 1
      ? Math.round(rawTimeout)
      : PUBLIC_PRICING_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    const unwrapped = await unwrapEnvelope<unknown>(response);
    const validated = parsePublicPricingPayload(unwrapped);
    return validated ?? clonePublicPricingPayload(PUBLIC_PRICING_FALLBACK);
  } catch {
    return clonePublicPricingPayload(PUBLIC_PRICING_FALLBACK);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submits a trial/demo lead to `POST /api/v2/public/leads`.
 */
export async function submitMarketingLead(
  payload: CreateMarketingLeadPayload,
  options?: SubmitMarketingLeadOptions,
): Promise<MarketingLeadSubmitResult> {
  const rawOverride = options?.apiBaseUrl?.trim();
  const base = rawOverride ? rawOverride.replace(/\/+$/, '') : apiV2Base();
  const fetchFn = options?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(`${base}/public/leads`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
  } catch {
    throw new MarketingApiError(0, -1, 'Unable to reach server. Please try again later.');
  }

  const retryAfterSeconds =
    response.status === 429
      ? parseRetryAfterSeconds(response.headers.get('retry-after'))
      : undefined;

  const data = await unwrapEnvelope<unknown>(response, {
    createError: (status, code, message) =>
      new MarketingApiError(status, code, message, retryAfterSeconds),
  });

  if (!isPlainRecord(data) || data.accepted !== true) {
    throw new MarketingApiError(
      response.status,
      -1,
      'Unexpected response from lead submission endpoint',
    );
  }

  if (data.id !== undefined) {
    if (typeof data.id !== 'string' || data.id.trim().length === 0) {
      throw new MarketingApiError(
        response.status,
        -1,
        'Unexpected response from lead submission endpoint',
      );
    }
    return { accepted: true, id: data.id };
  }

  return { accepted: true };
}
