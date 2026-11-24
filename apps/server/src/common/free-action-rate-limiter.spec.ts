import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AUTH_ERROR } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import {
  FREE_ACTION_RATE_LIMITER_OPTIONS,
  FreeActionRateLimiter,
  readExtensionSyncRateLimit,
  readExtensionTokenIssueRateLimit,
  readFactExtractRateLimit,
  readNearMissBoostRateLimit,
  readRoiReportExportRateLimit,
  readRoiReportShareRateLimit,
} from './free-action-rate-limiter';

@Module({
  providers: [FreeActionRateLimiter],
})
class DefaultRateLimiterTestModule {}

describe('FreeActionRateLimiter', () => {
  it('enforces sliding window per tenant and action independently and recovers after window expiry', () => {
    let nowMs = 1_000_000;
    const limiter = new FreeActionRateLimiter({ now: () => nowMs });
    const limit = { max: 2, windowMs: 10_000 };

    expect(limiter.consume('brand_fact_extract', 't1', limit)).toEqual({ allowed: true });
    nowMs += 2_000;
    expect(limiter.consume('brand_fact_extract', 't1', limit)).toEqual({ allowed: true });

    const blocked = limiter.consume('brand_fact_extract', 't1', limit);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(8);
    }

    // Different tenant or different action is not affected
    expect(limiter.consume('brand_fact_extract', 't2', limit)).toEqual({ allowed: true });
    expect(limiter.consume('geo_brief', 't1', limit)).toEqual({ allowed: true });

    // assertAllowed throws 429 / 42901 with retryAfterSeconds
    expect(() => limiter.assertAllowed('brand_fact_extract', 't1', limit)).toThrowError();
    try {
      limiter.assertAllowed('brand_fact_extract', 't1', limit);
    } catch (err) {
      expect(err).toMatchObject({
        status: 429,
        code: AUTH_ERROR.TOO_MANY_REQUESTS,
        retryAfterSeconds: 8,
      });
    }

    // Advances past oldest stamp window
    nowMs += 8_001;
    expect(limiter.consume('brand_fact_extract', 't1', limit)).toEqual({ allowed: true });
  });

  it('reads env overrides safely with sane defaults', () => {
    expect(readFactExtractRateLimit({})).toEqual({ max: 10, windowMs: 60_000 });
    expect(
      readFactExtractRateLimit({
        FACT_EXTRACT_RATE_LIMIT_MAX: '5',
        FACT_EXTRACT_RATE_LIMIT_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ max: 5, windowMs: 30_000 });
    expect(
      readFactExtractRateLimit({
        FACT_EXTRACT_RATE_LIMIT_MAX: '0',
        FACT_EXTRACT_RATE_LIMIT_WINDOW_SECONDS: 'abc',
      }),
    ).toEqual({ max: 10, windowMs: 60_000 });

    // v2.2 rate limit readers: defaults, positive overrides, and invalid fallbacks
    expect(readNearMissBoostRateLimit({})).toEqual({ max: 20, windowMs: 60_000 });
    expect(readRoiReportExportRateLimit({})).toEqual({ max: 20, windowMs: 60_000 });
    expect(readRoiReportShareRateLimit({})).toEqual({ max: 30, windowMs: 60_000 });
    expect(readExtensionTokenIssueRateLimit({})).toEqual({ max: 10, windowMs: 60_000 });
    expect(readExtensionSyncRateLimit({})).toEqual({ max: 60, windowMs: 60_000 });

    expect(
      readNearMissBoostRateLimit({
        NEAR_MISS_BOOST_RATE_LIMIT_MAX: '8',
        NEAR_MISS_BOOST_RATE_LIMIT_WINDOW_SECONDS: '45',
      }),
    ).toEqual({ max: 8, windowMs: 45_000 });
    expect(
      readRoiReportExportRateLimit({
        ROI_REPORT_EXPORT_RATE_LIMIT_MAX: '6',
        ROI_REPORT_EXPORT_RATE_LIMIT_WINDOW_SECONDS: '120',
      }),
    ).toEqual({ max: 6, windowMs: 120_000 });
    expect(
      readRoiReportShareRateLimit({
        ROI_REPORT_SHARE_RATE_LIMIT_MAX: '12',
        ROI_REPORT_SHARE_RATE_LIMIT_WINDOW_SECONDS: '90',
      }),
    ).toEqual({ max: 12, windowMs: 90_000 });
    expect(
      readExtensionTokenIssueRateLimit({
        EXTENSION_TOKEN_ISSUE_RATE_LIMIT_MAX: '3',
        EXTENSION_TOKEN_ISSUE_RATE_LIMIT_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ max: 3, windowMs: 30_000 });
    expect(
      readExtensionSyncRateLimit({
        EXTENSION_SYNC_RATE_LIMIT_MAX: '120',
        EXTENSION_SYNC_RATE_LIMIT_WINDOW_SECONDS: '15',
      }),
    ).toEqual({ max: 120, windowMs: 15_000 });

    expect(
      readExtensionSyncRateLimit({
        EXTENSION_SYNC_RATE_LIMIT_MAX: '-5',
        EXTENSION_SYNC_RATE_LIMIT_WINDOW_SECONDS: '',
      }),
    ).toEqual({ max: 60, windowMs: 60_000 });

    const limiter = new FreeActionRateLimiter({ now: () => 2_000_000 });
    limiter.assertAllowed('near_miss_boost', 'tenant_a', { max: 1, windowMs: 60_000 });
    expect(() =>
      limiter.assertAllowed('near_miss_boost', 'tenant_a', { max: 1, windowMs: 60_000 }),
    ).toThrowError();
    // Separate v2.2 action bucket stays unaffected
    expect(() =>
      limiter.assertAllowed('extension_sync', 'tenant_a', { max: 1, windowMs: 60_000 }),
    ).not.toThrow();
  });

  it('resolves cleanly via NestJS DI with optional options token', async () => {
    const defaultApp = await NestFactory.createApplicationContext(DefaultRateLimiterTestModule, {
      logger: false,
    });
    const defaultLimiter = defaultApp.get(FreeActionRateLimiter);
    expect(defaultLimiter.consume('geo_brief', 'tenant_di', { max: 1, windowMs: 5_000 })).toEqual({
      allowed: true,
    });
    await defaultApp.close();

    let clock = 500_000;

    @Module({
      providers: [
        { provide: FREE_ACTION_RATE_LIMITER_OPTIONS, useValue: { now: () => clock } },
        FreeActionRateLimiter,
      ],
    })
    class CustomRateLimiterTestModule {}

    const customApp = await NestFactory.createApplicationContext(CustomRateLimiterTestModule, {
      logger: false,
    });
    const customLimiter = customApp.get(FreeActionRateLimiter);
    expect(customLimiter.consume('geo_brief', 'tenant_di', { max: 1, windowMs: 5_000 })).toEqual({
      allowed: true,
    });
    clock += 1_000;
    expect(customLimiter.consume('geo_brief', 'tenant_di', { max: 1, windowMs: 5_000 })).toEqual({
      allowed: false,
      retryAfterSeconds: 4,
    });
    await customApp.close();
  });
});
