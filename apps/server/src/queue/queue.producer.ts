import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import {
  QUEUE_NAMES,
  isQueueName,
  readQueueConfig,
  type QueueConfig,
  type QueueName,
} from '@geomix/shared';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { FactIndexEnqueuer, FactIndexJobData } from '../brands/brand-fact-index.runner';
import type {
  DistributionEnqueuer,
  DistributionJobData,
} from '../distribution/distribution.runner';
import type { VariantJobData, VariantJobEnqueuer } from '../distribution/variant-job.runner';
import type { GeoBatchEnqueuer, GeoBatchJobData } from '../studio/geo-batch.runner';
import type {
  VisibilityCheckJobData,
  VisibilityRunEnqueuer,
} from '../visibility/visibility-run.runner';
import type { DriverJob, JobEnqueuer } from './job-enqueuer';

export type {
  DistributionJobData,
  FactIndexJobData,
  GeoBatchJobData,
  VariantJobData,
  VisibilityCheckJobData,
};

export const BOARD_PATH = '/api/v1/admin/queues/board';

type JobCounts = {
  name: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

/**
 * API 侧只负责入队。连接推迟到第一次使用，避免没装 Redis 时把登录和计费接口一起拖垮。
 */
@Injectable()
export class QueueProducer
  implements
    JobEnqueuer,
    VisibilityRunEnqueuer,
    FactIndexEnqueuer,
    GeoBatchEnqueuer,
    DistributionEnqueuer,
    VariantJobEnqueuer,
    OnModuleDestroy
{
  private connection: IORedis | undefined;
  private readonly queues = new Map<QueueName, Queue>();
  private board: ReturnType<ExpressAdapter['getRouter']> | undefined;
  private readonly config: QueueConfig;

  constructor() {
    this.config = readQueueConfig(process.env);
  }

  async connect(): Promise<void> {
    const connection = this.ensure();
    if (connection.status === 'wait') await connection.connect();
    const pong = await connection.ping();
    if (pong !== 'PONG') throw new Error('redis ping failed');
  }

  async enqueueDriver(job: DriverJob): Promise<void> {
    if (!isQueueName(job.queue)) return;
    await this.connect();
    const queue = await this.queue(job.queue);
    await queue.add(
      'drive',
      { tenantId: job.tenantId, runId: job.runId },
      {
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueVisibilityRun(data: VisibilityCheckJobData): Promise<void> {
    await this.connect();
    const queue = await this.queue('visibility-check');
    await queue.add(
      'visibility-check',
      { tenantId: data.tenantId, runId: data.runId },
      {
        jobId: `visibility-run-${data.runId}`,
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueFactIndex(data: FactIndexJobData): Promise<void> {
    await this.connect();
    const queue = await this.queue('fact-index');
    await queue.add(
      'fact-index',
      { tenantId: data.tenantId, brandId: data.brandId },
      {
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueGeoBatch(data: GeoBatchJobData): Promise<void> {
    await this.connect();
    const queue = await this.queue('geo-batch');
    await queue.add(
      'geo-batch',
      {
        tenantId: data.tenantId,
        jobId: data.jobId,
        ...(data.recipe ? { recipe: data.recipe } : {}),
        ...(data.targetFormat ? { targetFormat: data.targetFormat } : {}),
        ...(data.targetLocale ? { targetLocale: data.targetLocale } : {}),
      },
      {
        jobId: `geo-batch-${data.jobId}`,
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueDistribution(data: DistributionJobData): Promise<void> {
    await this.connect();
    const queue = await this.queue('distribution');
    await queue.add(
      'distribution',
      { tenantId: data.tenantId, taskId: data.taskId },
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueVariantJob(data: VariantJobData): Promise<void> {
    await this.connect();
    const queue = await this.queue('distribution');
    await queue.add(
      'variant-generate',
      { tenantId: data.tenantId, jobId: data.jobId },
      {
        jobId: `variant-job-${data.jobId}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 200 },
      },
    );
  }

  async counts(): Promise<JobCounts[]> {
    await this.connect();
    const rows: JobCounts[] = [];
    for (const name of QUEUE_NAMES) {
      const queue = await this.queue(name);
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      rows.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      });
    }
    return rows;
  }

  async boardRouter(): Promise<ReturnType<ExpressAdapter['getRouter']>> {
    if (this.board) return this.board;
    await this.connect();
    for (const name of QUEUE_NAMES) await this.queue(name);
    const adapter = new ExpressAdapter();
    adapter.setBasePath(BOARD_PATH);
    createBullBoard({
      queues: [...this.queues.values()].map((queue) => new BullMQAdapter(queue)),
      serverAdapter: adapter,
    });
    this.board = adapter.getRouter();
    return this.board;
  }

  open(name: QueueName): Promise<Queue> {
    return this.queue(name);
  }

  duplicate(): IORedis {
    return this.ensure().duplicate({ lazyConnect: false });
  }

  queueNames(): readonly QueueName[] {
    return QUEUE_NAMES;
  }

  prefix(): string {
    return this.config.prefix;
  }

  concurrency(name: QueueName): number {
    return this.config.concurrency[name];
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.board = undefined;
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
    if (this.connection) {
      await this.connection.quit();
      this.connection = undefined;
    }
  }

  private async queue(name: QueueName): Promise<Queue> {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const connection = this.ensure();
    const queue = new Queue(name, { connection, prefix: this.config.prefix });
    this.queues.set(name, queue);
    return queue;
  }

  private ensure(): IORedis {
    if (this.connection) return this.connection;
    this.connection = new IORedis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 5_000,
    });
    return this.connection;
  }
}
