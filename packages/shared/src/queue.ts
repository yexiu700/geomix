import { z } from 'zod';

/**
 * 队列框架常量（issue #6）。
 * 假任务只在本系统内流转，不调用上游模型，也不携带原文或切片。
 * 计费仍走已有的冻结单；这里只约定队列名、并发和状态怎么变。
 */

export const QUEUE_NAMES = [
  'fact-index',
  'geo-batch',
  'visibility-check',
  'distribution',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const QUEUE_SET = new Set<string>(QUEUE_NAMES);

export function isQueueName(value: string): value is QueueName {
  return QUEUE_SET.has(value);
}

/** 每租户并发上限。没单列租户上限的队列，用全局并发封顶。 */
export const QUEUE_TENANT_LIMIT: Record<QueueName, number> = {
  'fact-index': 2,
  'geo-batch': 2,
  'visibility-check': 2,
  distribution: 2,
  maintenance: 1,
};

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const TERMINAL = new Set<RunStatus>(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** 终态再暂停、继续、终止都保持原状。进行中的任务才能暂停。 */
export function nextStatus(current: RunStatus, action: 'pause' | 'resume' | 'cancel'): RunStatus {
  if (isTerminalRun(current)) return current;
  if (action === 'pause') return 'PAUSED';
  if (action === 'resume') {
    if (current === 'PAUSED' || current === 'QUEUED') return 'QUEUED';
    return current;
  }
  return 'CANCELLED';
}

export function finishStatus(input: {
  done: number;
  fail: number;
  skip: number;
  cancelled: boolean;
}): 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' {
  if (input.cancelled) return 'CANCELLED';
  if (input.done > 0 && input.fail === 0 && input.skip === 0) return 'COMPLETED';
  if (input.done > 0) return 'PARTIAL';
  if (input.skip > 0 && input.fail === 0) return 'CANCELLED';
  return 'FAILED';
}

/** 没产出、也还没结算的单元才能退冻结。已结算的单元不能再退。 */
export function shouldReleaseUnit(unit: { settled: boolean; outputReady: boolean }): boolean {
  return !unit.settled && !unit.outputReady;
}

export function runProgress(input: {
  total: number;
  done: number;
  fail: number;
  skip: number;
  active?: { step: number; steps: number };
}): number {
  if (input.total <= 0) return 0;
  const finished = input.done + input.fail + input.skip;
  const partial =
    input.active && input.active.steps > 0
      ? Math.min(input.active.step, input.active.steps) / input.active.steps
      : 0;
  const raw = Math.floor(((finished + partial) / input.total) * 100);
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

export const createRunBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    knowledgeBase: z.boolean().optional(),
    units: z
      .array(
        z
          .object({
            steps: z.number().int().min(1).max(8),
            failuresRemaining: z.number().int().min(0).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type CreateRunBody = z.infer<typeof createRunBodySchema>;

export type QueueConfig = {
  redisUrl: string;
  prefix: string;
  heartbeatMs: number;
  heartbeatTtlMs: number;
  leaseMs: number;
  unitAttempts: number;
  backoffMs: number;
  recoverMs: number;
  concurrency: Record<QueueName, number>;
};

function integerEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function readQueueConfig(
  env: Record<string, string | undefined> = process.env,
): QueueConfig {
  const heartbeatMs = integerEnv(
    env.QUEUE_HEARTBEAT_MS,
    15_000,
    'QUEUE_HEARTBEAT_MS',
    200,
    120_000,
  );
  const heartbeatTtlMs = integerEnv(
    env.QUEUE_HEARTBEAT_TTL_MS,
    120_000,
    'QUEUE_HEARTBEAT_TTL_MS',
    1_000,
    3_600_000,
  );
  if (heartbeatTtlMs < heartbeatMs) {
    throw new Error('QUEUE_HEARTBEAT_TTL_MS must be at least QUEUE_HEARTBEAT_MS');
  }
  const prefix = (env.QUEUE_PREFIX ?? 'geomix').trim() || 'geomix';
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(prefix)) {
    throw new Error('QUEUE_PREFIX contains unsupported characters');
  }
  return {
    redisUrl: env.REDIS_URL?.trim() || 'redis://localhost:6379',
    prefix,
    heartbeatMs,
    heartbeatTtlMs,
    leaseMs: integerEnv(env.QUEUE_LEASE_MS, 120_000, 'QUEUE_LEASE_MS', 1_000, 3_600_000),
    unitAttempts: integerEnv(env.QUEUE_UNIT_ATTEMPTS, 3, 'QUEUE_UNIT_ATTEMPTS', 1, 8),
    backoffMs: integerEnv(env.QUEUE_BACKOFF_MS, 1_000, 'QUEUE_BACKOFF_MS', 0, 60_000),
    recoverMs: integerEnv(env.QUEUE_RECOVER_MS, 60_000, 'QUEUE_RECOVER_MS', 1_000, 3_600_000),
    concurrency: {
      'fact-index': integerEnv(
        env.QUEUE_FACT_INDEX_CONCURRENCY ?? env.QUEUE_KB_CONCURRENCY,
        2,
        'QUEUE_FACT_INDEX_CONCURRENCY',
        1,
        32,
      ),
      'geo-batch': integerEnv(
        env.QUEUE_GEO_BATCH_CONCURRENCY ?? env.QUEUE_WRITE_CONCURRENCY,
        2,
        'QUEUE_GEO_BATCH_CONCURRENCY',
        1,
        32,
      ),
      'visibility-check': integerEnv(
        env.QUEUE_VISIBILITY_CONCURRENCY,
        2,
        'QUEUE_VISIBILITY_CONCURRENCY',
        1,
        32,
      ),
      distribution: integerEnv(
        env.QUEUE_DISTRIBUTION_CONCURRENCY,
        2,
        'QUEUE_DISTRIBUTION_CONCURRENCY',
        1,
        32,
      ),
      maintenance: 1,
    },
  };
}
