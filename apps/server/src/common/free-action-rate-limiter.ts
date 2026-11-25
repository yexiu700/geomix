import { Inject, Injectable, Optional } from '@nestjs/common';
import { AUTH_ERROR, RATE_LIMIT_MESSAGE } from '@geomix/shared';
import { ApiError } from './api-error';

export const FREE_ACTION_RATE_LIMITER_OPTIONS = Symbol('FREE_ACTION_RATE_LIMITER_OPTIONS');

export type FreeActionRateDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type FreeActionRateLimit = {
  max: number;
  windowMs: number;
};

export type FreeActionRateLimiterOptions = {
  now?: () => number;
  maxKeys?: number;
};

const DEFAULT_FACT_EXTRACT_MAX = 10;
const DEFAULT_FACT_EXTRACT_WINDOW_SECONDS = 60;
const DEFAULT_BRIEF_GENERATE_MAX = 20;
const DEFAULT_BRIEF_GENERATE_WINDOW_SECONDS = 60;
const DEFAULT_REWRITE_SECTION_MAX = 20;
const DEFAULT_REWRITE_SECTION_WINDOW_SECONDS = 60;
const DEFAULT_GEO_EVALUATE_MAX = 60;
const DEFAULT_GEO_EVALUATE_WINDOW_SECONDS = 60;
const DEFAULT_NEAR_MISS_BOOST_MAX = 20;
const DEFAULT_NEAR_MISS_BOOST_WINDOW_SECONDS = 60;
const DEFAULT_ROI_REPORT_EXPORT_MAX = 20;
const DEFAULT_ROI_REPORT_EXPORT_WINDOW_SECONDS = 60;
const DEFAULT_ROI_REPORT_SHARE_MAX = 30;
const DEFAULT_ROI_REPORT_SHARE_WINDOW_SECONDS = 60;
const DEFAULT_EXTENSION_TOKEN_ISSUE_MAX = 10;
const DEFAULT_EXTENSION_TOKEN_ISSUE_WINDOW_SECONDS = 60;
const DEFAULT_EXTENSION_SYNC_MAX = 60;
const DEFAULT_EXTENSION_SYNC_WINDOW_SECONDS = 60;
const DEFAULT_MARKET_AI_SUGGEST_MAX = 15;
const DEFAULT_MARKET_AI_SUGGEST_WINDOW_SECONDS = 60;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readFactExtractRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.FACT_EXTRACT_RATE_LIMIT_MAX, DEFAULT_FACT_EXTRACT_MAX);
  const windowSeconds = readPositiveInt(
    env.FACT_EXTRACT_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_FACT_EXTRACT_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readBriefGenerateRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.BRIEF_GENERATE_RATE_LIMIT_MAX, DEFAULT_BRIEF_GENERATE_MAX);
  const windowSeconds = readPositiveInt(
    env.BRIEF_GENERATE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_BRIEF_GENERATE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readRewriteSectionRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.REWRITE_SECTION_RATE_LIMIT_MAX, DEFAULT_REWRITE_SECTION_MAX);
  const windowSeconds = readPositiveInt(
    env.REWRITE_SECTION_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_REWRITE_SECTION_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readGeoEvaluateRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.GEO_EVALUATE_RATE_LIMIT_MAX, DEFAULT_GEO_EVALUATE_MAX);
  const windowSeconds = readPositiveInt(
    env.GEO_EVALUATE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_GEO_EVALUATE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readNearMissBoostRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.NEAR_MISS_BOOST_RATE_LIMIT_MAX, DEFAULT_NEAR_MISS_BOOST_MAX);
  const windowSeconds = readPositiveInt(
    env.NEAR_MISS_BOOST_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_NEAR_MISS_BOOST_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readRoiReportExportRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.ROI_REPORT_EXPORT_RATE_LIMIT_MAX, DEFAULT_ROI_REPORT_EXPORT_MAX);
  const windowSeconds = readPositiveInt(
    env.ROI_REPORT_EXPORT_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_ROI_REPORT_EXPORT_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readRoiReportShareRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.ROI_REPORT_SHARE_RATE_LIMIT_MAX, DEFAULT_ROI_REPORT_SHARE_MAX);
  const windowSeconds = readPositiveInt(
    env.ROI_REPORT_SHARE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_ROI_REPORT_SHARE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readExtensionTokenIssueRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(
    env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX,
    DEFAULT_EXTENSION_TOKEN_ISSUE_MAX,
  );
  const windowSeconds = readPositiveInt(
    env.EXTENSION_TOKEN_ISSUE_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_EXTENSION_TOKEN_ISSUE_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readExtensionSyncRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.EXTENSION_SYNC_RATE_LIMIT_MAX, DEFAULT_EXTENSION_SYNC_MAX);
  const windowSeconds = readPositiveInt(
    env.EXTENSION_SYNC_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_EXTENSION_SYNC_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readMarketAiSuggestRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.MARKET_AI_SUGGEST_RATE_LIMIT_MAX, DEFAULT_MARKET_AI_SUGGEST_MAX);
  const windowSeconds = readPositiveInt(
    env.MARKET_AI_SUGGEST_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_MARKET_AI_SUGGEST_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

/**
 * 免费 AI 能力（品牌事实提炼、写作意见生成、局部改写、GEO 体检等）按租户防刷滑动窗口限流器。
 */
@Injectable()
export class FreeActionRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(
    @Optional()
    @Inject(FREE_ACTION_RATE_LIMITER_OPTIONS)
    options?: FreeActionRateLimiterOptions,
  ) {
    const resolved = options ?? {};
    this.now = resolved.now ?? Date.now;
    this.maxKeys = resolved.maxKeys ?? 10_000;
  }

  consume(
    action: string,
    tenantId: string,
    limit: FreeActionRateLimit = readFactExtractRateLimit(),
  ): FreeActionRateDecision {
    const safeMax = Math.max(1, Math.floor(limit.max));
    const safeWindowMs = Math.max(1_000, Math.floor(limit.windowMs));
    const key = `${action.trim().toLowerCase()}\n${tenantId.trim()}`;
    const stamps = this.prune(key, safeWindowMs);
    if (stamps.length >= safeMax) {
      return {
        allowed: false,
        retryAfterSeconds: computeRetryAfter(stamps, safeWindowMs, this.now()),
      };
    }
    stamps.push(this.now());
    this.store(key, stamps);
    return { allowed: true };
  }

  assertAllowed(
    action: string,
    tenantId: string,
    limit: FreeActionRateLimit = readFactExtractRateLimit(),
  ): void {
    const decision = this.consume(action, tenantId, limit);
    if (!decision.allowed) {
      throw new ApiError(
        429,
        AUTH_ERROR.TOO_MANY_REQUESTS,
        RATE_LIMIT_MESSAGE,
        decision.retryAfterSeconds,
      );
    }
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  private prune(key: string, windowMs: number): number[] {
    const now = this.now();
    const stamps = (this.buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length === 0) {
      this.buckets.delete(key);
    } else {
      this.buckets.set(key, stamps);
    }
    return stamps;
  }

  private store(key: string, stamps: number[]): void {
    this.buckets.delete(key);
    this.buckets.set(key, stamps);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

function computeRetryAfter(stamps: number[], windowMs: number, now: number): number {
  const oldest = stamps[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}
