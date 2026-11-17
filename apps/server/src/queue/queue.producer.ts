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
import type { ImageJobEnqueuer } from '../image/image-job.runner';
import type { RewriteBatchEnqueuer } from '../rewrite/rewrite-batch.runner';
import type {
  VisibilityCheckJobData,
  VisibilityRunEnqueuer,
} from '../visibility/visibility-run.runner';
import type { AiTaskEnqueuer } from '../writing/ai-task.runner';
import type { DriverJob, JobEnqueuer } from './job-enqueuer';

export type { VisibilityCheckJobData };

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
    AiTaskEnqueuer,
    RewriteBatchEnqueuer,
    ImageJobEnqueuer,
    VisibilityRunEnqueuer,
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

  async enqueueKbIndex(job: { tenantId: string; kbId: string }): Promise<void> {
    await this.connect();
    const queue = await this.queue('kb-index');
    await queue.add(
      'kb-index',
      { tenantId: job.tenantId, kbId: job.kbId },
      {
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueAiTask(job: { tenantId: string; taskId: string }): Promise<void> {
    await this.connect();
    const queue = await this.queue('write-article');
    await queue.add(
      'ai-task',
      { tenantId: job.tenantId, taskId: job.taskId },
      {
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueRewriteBatch(job: { tenantId: string; batchId: string }): Promise<void> {
    await this.connect();
    const queue = await this.queue('rewrite-batch');
    await queue.add(
      'rewrite-batch',
      { tenantId: job.tenantId, batchId: job.batchId },
      {
        attempts: this.config.unitAttempts + 1,
        backoff: { type: 'exponential', delay: this.config.backoffMs },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueImageJob(job: { tenantId: string; jobId: string }): Promise<void> {
    await this.connect();
    const queue = await this.queue('image-gen');
    await queue.add(
      'image-gen',
      { tenantId: job.tenantId, jobId: job.jobId },
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
