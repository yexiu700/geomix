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
import {
  FACT_INDEX_ENQUEUER,
  FACT_INDEX_HANDLER,
  type FactIndexHandler,
} from '../brands/brand-fact-index.runner';
import {
  DISTRIBUTION_ENQUEUER,
  DISTRIBUTION_HANDLER,
  type DistributionHandler,
  type DistributionJobData,
} from '../distribution/distribution.runner';
import {
  GEO_BATCH_ENQUEUER,
  GEO_BATCH_HANDLER,
  type GeoBatchHandler,
  type GeoBatchJobData,
} from '../studio/geo-batch.runner';
import {
  readVisibilityConfig,
  resolveVisibilityHealthRefreshMs,
} from '../visibility/visibility.config';
import {
  VISIBILITY_RUN_ENQUEUER,
  VISIBILITY_RUN_HANDLER,
  type VisibilityRunHandler,
} from '../visibility/visibility-run.runner';
import { WorkerRuntimeService } from '../worker/worker-runtime.service';
import { MaintenanceRunner } from './maintenance.runner';
import { QueueProducer } from './queue.producer';
import { RetryableStepError, WorkDriver } from './work-driver';

export {
  DISTRIBUTION_ENQUEUER,
  DISTRIBUTION_HANDLER,
  FACT_INDEX_ENQUEUER,
  FACT_INDEX_HANDLER,
  GEO_BATCH_ENQUEUER,
  GEO_BATCH_HANDLER,
  VISIBILITY_RUN_ENQUEUER,
  VISIBILITY_RUN_HANDLER,
};

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
    @Optional()
    @Inject(VISIBILITY_RUN_HANDLER)
    private readonly visibilityRunner?: VisibilityRunHandler,
    @Optional()
    @Inject(FACT_INDEX_HANDLER)
    private readonly factIndexer?: FactIndexHandler,
    @Optional()
    @Inject(GEO_BATCH_HANDLER)
    private readonly geoBatchRunner?: GeoBatchHandler,
    @Optional()
    @Inject(DISTRIBUTION_HANDLER)
    private readonly distributionRunner?: DistributionHandler,
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
          if (name === 'visibility-check' && job.name === 'visibility-check') {
            const visData = readPayload(job.data);
            if (visData && this.visibilityRunner) {
              await this.visibilityRunner.process(visData);
            }
            return;
          }
          if (name === 'fact-index' && job.name === 'fact-index') {
            const factData = readFactIndexPayload(job.data);
            if (factData && this.factIndexer) {
              await this.factIndexer.process(factData);
            }
            return;
          }
          if (name === 'geo-batch' && job.name === 'geo-batch') {
            const batchData = readGeoBatchPayload(job.data);
            if (batchData && this.geoBatchRunner) {
              await this.geoBatchRunner.process(batchData);
            }
            return;
          }
          if (name === 'distribution' && job.name === 'distribution') {
            const distData = readDistributionPayload(job.data);
            if (distData && this.distributionRunner) {
              await this.distributionRunner.process(distData);
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
    void this.maintenance.run('visibility-engine-health').catch((err: unknown) => {
      this.logger.warn(
        `initial visibility engine health refresh skipped: ${err instanceof Error ? err.message : 'unknown'}`,
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
    const visibilityHealthMs = readVisibilityHealthRefreshMs();
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
      'visibility-engine-health',
      { kind: 'visibility-engine-health' },
      { repeat: { every: visibilityHealthMs }, jobId: 'visibility-engine-health' },
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
    await queue.add(
      'crawl-probe-sweep',
      { kind: 'crawl-probe-sweep' },
      { repeat: { pattern: '*/30 * * * *' }, jobId: 'crawl-probe-sweep' },
    );
    await queue.add(
      'retest-schedule-sweep',
      { kind: 'retest-schedule-sweep' },
      { repeat: { pattern: '*/15 * * * *' }, jobId: 'retest-schedule-sweep' },
    );
  }
}

function readVisibilityHealthRefreshMs(): number {
  try {
    return resolveVisibilityHealthRefreshMs(readVisibilityConfig(process.env));
  } catch {
    return 5 * 60_000;
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

function readFactIndexPayload(data: unknown): { tenantId: string; brandId: string } | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const brandId = (data as { brandId?: unknown }).brandId;
  if (typeof tenantId !== 'string' || typeof brandId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(brandId)) return null;
  if (tenantId === 'system' || brandId === 'system') return null;
  return { tenantId, brandId };
}

function readGeoBatchPayload(data: unknown): GeoBatchJobData | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as {
    tenantId?: unknown;
    jobId?: unknown;
    recipe?: unknown;
    targetFormat?: unknown;
  };
  if (typeof raw.tenantId !== 'string' || typeof raw.jobId !== 'string') return null;
  if (!ID.test(raw.tenantId) || !ID.test(raw.jobId)) return null;
  if (raw.tenantId === 'system' || raw.jobId === 'system') return null;
  return {
    tenantId: raw.tenantId,
    jobId: raw.jobId,
    ...(typeof raw.recipe === 'string' ? { recipe: raw.recipe as GeoBatchJobData['recipe'] } : {}),
    ...(typeof raw.targetFormat === 'string'
      ? { targetFormat: raw.targetFormat as GeoBatchJobData['targetFormat'] }
      : {}),
  };
}

function readDistributionPayload(data: unknown): DistributionJobData | null {
  if (!data || typeof data !== 'object') return null;
  const tenantId = (data as { tenantId?: unknown }).tenantId;
  const taskId = (data as { taskId?: unknown }).taskId;
  if (typeof tenantId !== 'string' || typeof taskId !== 'string') return null;
  if (!ID.test(tenantId) || !ID.test(taskId)) return null;
  if (tenantId === 'system' || taskId === 'system') return null;
  return { tenantId, taskId };
}

function readKind(name: string, data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string') {
    return (data as { kind: string }).kind;
  }
  return name;
}
