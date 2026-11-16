import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readReconcileConfig } from '@geomix/shared';
import { Worker } from 'bullmq';
import { MaintenanceRunner } from './maintenance.runner';
import { QueueProducer } from './queue.producer';
import { RetryableStepError, WorkDriver } from './work-driver';
import { WorkerRuntimeService } from '../worker/worker-runtime.service';

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
          const data = readPayload(job.data);
          if (!data) return;
          await this.driver.handle(data);
        },
        {
          connection: this.producer.duplicate(),
          prefix: this.producer.prefix(),
          concurrency: this.producer.concurrency(name),
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
      },
    );
    this.workers.push(maintenance);
    await this.registerSchedules();
    this.started = true;
    this.runtime.markConnected();
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

function readKind(name: string, data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string') {
    return (data as { kind: string }).kind;
  }
  return name;
}
