import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readReconcileConfig } from '@geomix/shared';
import { Worker } from 'bullmq';
import { IMAGE_JOB_HANDLER, type ImageJobHandler } from '../image/image-job.runner';
import { KB_INDEX_HANDLER, type KbIndexHandler } from '../material/knowledge-index.runner';
import { REWRITE_BATCH_HANDLER, type RewriteBatchHandler } from '../rewrite/rewrite-batch.runner';
import {
  VISIBILITY_RUN_ENQUEUER,
  VISIBILITY_RUN_HANDLER,
  type VisibilityRunHandler,
} from '../visibility/visibility-run.runner';
import { AI_TASK_HANDLER, type AiTaskHandler } from '../writing/ai-task.runner';
import { MaintenanceRunner } from './maintenance.runner';
import { QueueProducer } from './queue.producer';
import { RetryableStepError, WorkDriver } from './work-driver';
import { WorkerRuntimeService } from '../worker/worker-runtime.service';

export { VISIBILITY_RUN_ENQUEUER, VISIBILITY_RUN_HANDLER };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Worker 进程消费 BullMQ。假任务不调用上游。
 * 关闭时等当前步骤写完再断开，避免把同一单元结算两次。
 */
@Injectable()
export class QueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueRuntime.name);
  private readonly workers: Worker[] = [];
  private started = false;

  constructor(
    @Inject(QueueProducer) private readonly producer: QueueProducer,
    @Inject(WorkDriver) private readonly driver: WorkDriver,
    @Inject(MaintenanceRunner) private readonly maintenance: MaintenanceRunner,
    @Inject(WorkerRuntimeService) private readonly runtime: WorkerRuntimeService,
    @Optional() @Inject(KB_INDEX_HANDLER) private readonly kbIndexer?: KbIndexHandler,
    @Optional() @Inject(AI_TASK_HANDLER) private readonly aiTaskRunner?: AiTaskHandler,
    @Optional()
    @Inject(REWRITE_BATCH_HANDLER)
    private readonly rewriteBatchRunner?: RewriteBatchHandler,
    @Optional()
    @Inject(IMAGE_JOB_HANDLER)
    private readonly imageJobRunner?: ImageJobHandler,
    @Optional()
    @Inject(VISIBILITY_RUN_HANDLER)
    private readonly visibilityRunner?: VisibilityRunHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.producer.connect();
    for (const name of this.producer.queueNames()) {
      if (name === 'maintenance') continue;
      const worker = new Worker(
        name,
        async (job) => {
          if (name === 'kb-index' && job.name === 'kb-index') {
            const kbData = readKbPayload(job.data);
            if (kbData && this.kbIndexer) {
              await this.kbIndexer.process(kbData);
            }
            return;
          }
          if (name === 'write-article' && job.name === 'ai-task') {
            const taskData = readAiTaskPayload(job.data);
            if (taskData && this.aiTaskRunner) {
              await this.aiTaskRunner.process(taskData);
            }
            return;
          }
          if (name === 'rewrite-batch' && job.name === 'rewrite-batch') {
            const batchData = readRewriteBatchPayload(job.data);
            if (batchData && this.rewriteBatchRunner) {
              await this.rewriteBatchRunner.process(batchData);
            }
            return;
          }
          if (name === 'image-gen' && job.name === 'image-gen') {
            const imgData = readImageJobPayload(job.data);
            if (imgData && this.imageJobRunner) {
              await this.imageJobRunner.process(imgData);
            }
            return;
          }
          if (name === 'visibility-check' && job.name === 'visibility-check') {
            const visData = readPayload(job.data);
            if (visData && this.visibilityRunner) {
              await this.visibilityRunner.process(visData);
            }
            return;
          }
          const data = readPayload(job.data);
          if (!data) return;
          await this.driver.handle(data);
        },
        {
          connection: this.producer.duplicate(),
          prefix: this.producer.prefix(),
          concurrency: this.producer.concurrency(name),
          lockDuration: 120_000,
        },
      );
      worker.on('failed', (job, error) => {
        if (error instanceof RetryableStepError) return;
        this.logger.warn(`job ${job?.id ?? 'unknown'} failed`);
      });
      this.workers.push(worker);
    }
    const maintenance = new Worker(
      'maintenance',
      async (job) => {
        const kind = readKind(job.name, job.data);
        await this.maintenance.run(kind);
      },
      {
        connection: this.producer.duplicate(),
        prefix: this.producer.prefix(),
        concurrency: 1,
        lockDuration: 120_000,
      },
    );
    this.workers.push(maintenance);
    await this.registerSchedules();
    this.started = true;
    this.runtime.markConnected();
    void this.maintenance.run('recover').catch((err: unknown) => {
      this.logger.warn(
        `initial recover sweep skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers.length = 0;
    this.started = false;
  }

  private async registerSchedules(): Promise<void> {
    const timing = readReconcileConfig(process.env);
    const recoverMs = Math.min(timing.intervalMs, readRecoverMs());
    const queue = await this.producer.open('maintenance');
    await queue.add(
      'reconcile',
      { kind: 'reconcile' },
      { repeat: { every: timing.intervalMs }, jobId: 'reconcile' },
    );
    await queue.add(
      'recover',
      { kind: 'recover' },
      { repeat: { every: recoverMs }, jobId: 'recover' },
    );
    await queue.add(
      'retention',
      { kind: 'retention' },
      { repeat: { pattern: '0 3 * * *' }, jobId: 'retention' },
    );
    await queue.add(
      'orphan-files',
      { kind: 'orphan-files' },
      { repeat: { pattern: '30 3 * * *' }, jobId: 'orphan-files' },
    );
  }
}

function readRecoverMs(): number {
  const raw = process.env.QUEUE_RECOVER_MS;
  if (!raw || !/^[0-9]+$/.test(raw)) return 60_000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 ? value : 60_000;
}

function readPayload(data: unknown): { tenantId: string; runId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const runId = (data as { runId?: unknown }).runId;
  if (typeof tenantId !== 'string' || typeof runId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(runId)) return null;
  if (tenantId === 'system' || runId === 'system') return null;
  return { tenantId, runId };
}

function readKbPayload(data: unknown): { tenantId: string; kbId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const kbId = (data as { kbId?: unknown }).kbId;
  if (typeof tenantId !== 'string' || typeof kbId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(kbId)) return null;
  if (tenantId === 'system' || kbId === 'system') return null;
  return { tenantId, kbId };
}

function readAiTaskPayload(data: unknown): { tenantId: string; taskId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const taskId = (data as { taskId?: unknown }).taskId;
  if (typeof tenantId !== 'string' || typeof taskId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(taskId)) return null;
  if (tenantId === 'system' || taskId === 'system') return null;
  return { tenantId, taskId };
}

function readRewriteBatchPayload(data: unknown): { tenantId: string; batchId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const batchId = (data as { batchId?: unknown }).batchId;
  if (typeof tenantId !== 'string' || typeof batchId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(batchId)) return null;
  if (tenantId === 'system' || batchId === 'system') return null;
  return { tenantId, batchId };
}

function readImageJobPayload(data: unknown): { tenantId: string; jobId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const jobId = (data as { jobId?: unknown }).jobId;
  if (typeof tenantId !== 'string' || typeof jobId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(jobId)) return null;
  if (tenantId === 'system' || jobId === 'system') return null;
  return { tenantId, jobId };
}

function readKind(name: string, data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string') {
    return (data as { kind: string }).kind;
  }
  return name;
}
