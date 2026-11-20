import { describe, expect, it } from 'vitest';
import {
  QUEUE_NAMES,
  QUEUE_TENANT_LIMIT,
  createRunBodySchema,
  finishStatus,
  isTerminalRun,
  nextStatus,
  readQueueConfig,
  runProgress,
  shouldReleaseUnit,
} from './queue';

describe('queue rules', () => {
  it('keeps terminal statuses unchanged', () => {
    for (const status of ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminalRun(status)).toBe(true);
      expect(nextStatus(status, 'pause')).toBe(status);
      expect(nextStatus(status, 'resume')).toBe(status);
      expect(nextStatus(status, 'cancel')).toBe(status);
    }
    expect(nextStatus('RUNNING', 'pause')).toBe('PAUSED');
    expect(nextStatus('PAUSED', 'pause')).toBe('PAUSED');
    expect(nextStatus('PAUSED', 'resume')).toBe('QUEUED');
    expect(nextStatus('RUNNING', 'cancel')).toBe('CANCELLED');
  });

  it('classifies the finished run from unit counts', () => {
    expect(finishStatus({ done: 2, fail: 0, skip: 0, cancelled: false })).toBe('COMPLETED');
    expect(finishStatus({ done: 1, fail: 1, skip: 0, cancelled: false })).toBe('PARTIAL');
    expect(finishStatus({ done: 0, fail: 2, skip: 0, cancelled: false })).toBe('FAILED');
    expect(finishStatus({ done: 0, fail: 0, skip: 2, cancelled: true })).toBe('CANCELLED');
    expect(finishStatus({ done: 1, fail: 0, skip: 1, cancelled: true })).toBe('CANCELLED');
  });

  it('releases only units that have not settled and have no output', () => {
    expect(shouldReleaseUnit({ settled: false, outputReady: false })).toBe(true);
    expect(shouldReleaseUnit({ settled: true, outputReady: true })).toBe(false);
    expect(shouldReleaseUnit({ settled: false, outputReady: true })).toBe(false);
    expect(shouldReleaseUnit({ settled: true, outputReady: false })).toBe(false);
  });

  it('computes progress from finished units plus the active step', () => {
    expect(runProgress({ total: 4, done: 1, fail: 0, skip: 0 })).toBe(25);
    expect(
      runProgress({ total: 2, done: 0, fail: 0, skip: 0, active: { step: 1, steps: 2 } }),
    ).toBe(25);
    expect(runProgress({ total: 0, done: 0, fail: 0, skip: 0 })).toBe(0);
  });

  it('registers the 4 v2 queues and caps per-tenant concurrency', () => {
    expect(QUEUE_NAMES).toEqual(['fact-index', 'geo-batch', 'visibility-check', 'maintenance']);
    expect(QUEUE_TENANT_LIMIT['fact-index']).toBe(2);
    expect(QUEUE_TENANT_LIMIT['geo-batch']).toBe(2);
    expect(QUEUE_TENANT_LIMIT['visibility-check']).toBe(2);
    expect(QUEUE_TENANT_LIMIT.maintenance).toBe(1);
  });

  it('rejects extra fields and reads local defaults', () => {
    expect(createRunBodySchema.safeParse({ units: [{ steps: 2 }], extra: 1 }).success).toBe(false);
    expect(createRunBodySchema.safeParse({ units: [{ steps: 2 }] }).success).toBe(true);
    const config = readQueueConfig({});
    expect(config.prefix).toBe('geomix');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.unitAttempts).toBe(3);
    expect(config.concurrency['fact-index']).toBe(2);
    expect(config.concurrency['geo-batch']).toBe(2);
    expect(config.concurrency['visibility-check']).toBe(2);
    expect(readQueueConfig({ QUEUE_FACT_INDEX_CONCURRENCY: '4' }).concurrency['fact-index']).toBe(
      4,
    );
    expect(readQueueConfig({ QUEUE_GEO_BATCH_CONCURRENCY: '5' }).concurrency['geo-batch']).toBe(5);
    expect(
      readQueueConfig({ QUEUE_VISIBILITY_CONCURRENCY: '6' }).concurrency['visibility-check'],
    ).toBe(6);
    expect(config.concurrency.maintenance).toBe(1);
  });

  it('rejects a heartbeat ttl shorter than the beat interval', () => {
    expect(() =>
      readQueueConfig({ QUEUE_HEARTBEAT_MS: '5000', QUEUE_HEARTBEAT_TTL_MS: '1000' }),
    ).toThrow(/HEARTBEAT_TTL/);
  });
});
