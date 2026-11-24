import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { FactIndexHandler } from '../brands/brand-fact-index.runner';
import type { GeoBatchHandler } from '../studio/geo-batch.runner';
import type { VisibilityRunHandler } from '../visibility/visibility-run.runner';
import type { WorkerRuntimeService } from '../worker/worker-runtime.service';
import type { MaintenanceRunner } from './maintenance.runner';
import type { QueueProducer } from './queue.producer';
import { QueueRuntime } from './queue.runtime';
import type { WorkDriver } from './work-driver';

describe('QueueRuntime distribution queue isolation', () => {
  function makeRuntime(opts?: { omitDistributionHandler?: boolean }) {
    const producer = {} as QueueProducer;
    const driver = {
      handle: vi.fn(async () => undefined),
    } as unknown as WorkDriver;
    const maintenance = {
      run: vi.fn(async () => undefined),
    } as unknown as MaintenanceRunner;
    const runtimeState = {
      markConnected: vi.fn(),
    } as unknown as WorkerRuntimeService;
    const visibilityRunner = {
      process: vi.fn(async () => undefined),
    } as unknown as VisibilityRunHandler;
    const factIndexer = {
      process: vi.fn(async () => undefined),
    } as unknown as FactIndexHandler;
    const geoBatchRunner = {
      process: vi.fn(async () => undefined),
    } as unknown as GeoBatchHandler;
    const distributionHandler = {
      process: vi.fn(async () => undefined),
    };

    const runtime = new QueueRuntime(
      producer,
      driver,
      maintenance,
      runtimeState,
      visibilityRunner,
      factIndexer,
      geoBatchRunner,
      opts?.omitDistributionHandler ? undefined : distributionHandler,
    );

    return {
      runtime,
      driver,
      visibilityRunner,
      factIndexer,
      geoBatchRunner,
      distributionHandler,
    };
  }

  it('never falls through to WorkDriver.handle() or other runners on wrong job.name for distribution queue', async () => {
    const { runtime, driver, visibilityRunner, factIndexer, geoBatchRunner, distributionHandler } =
      makeRuntime();

    const wrongJobs: Array<{ name: string; data: unknown }> = [
      { name: 'wrong-name', data: { tenantId: 'tenant_a', runId: 'run_1' } },
      { name: 'visibility-check', data: { tenantId: 'tenant_a', runId: 'run_1' } },
      { name: 'fact-index', data: { tenantId: 'tenant_a', brandId: 'brand_1' } },
      { name: 'geo-batch', data: { tenantId: 'tenant_a', jobId: 'job_1' } },
      { name: '', data: { tenantId: 'tenant_a', runId: 'run_1', taskId: 'task_1' } },
    ];

    for (const job of wrongJobs) {
      await runtime.dispatchJob('distribution', job);
    }

    expect(driver.handle).not.toHaveBeenCalled();
    expect(visibilityRunner.process).not.toHaveBeenCalled();
    expect(factIndexer.process).not.toHaveBeenCalled();
    expect(geoBatchRunner.process).not.toHaveBeenCalled();
    expect(distributionHandler.process).not.toHaveBeenCalled();
  });

  it('drops malformed or reserved distribution payloads and dispatches only valid jobs to DISTRIBUTION_HANDLER', async () => {
    const { runtime, driver, distributionHandler } = makeRuntime();

    const invalidPayloads: unknown[] = [
      null,
      undefined,
      'raw-string',
      ['tenant_a', 'task_1'],
      {},
      { tenantId: 'tenant_a', runId: 'run_1' },
      { tenantId: 'system', taskId: 'task_1' },
      { tenantId: 'tenant_a', taskId: 'system' },
      { tenantId: '', taskId: 'task_1' },
      { tenantId: 'tenant_a', taskId: 'a'.repeat(65) },
      { tenantId: 'tenant a', taskId: 'task_1' },
    ];

    for (const payload of invalidPayloads) {
      await runtime.dispatchJob('distribution', {
        name: 'distribution',
        data: payload,
      });
    }

    expect(driver.handle).not.toHaveBeenCalled();
    expect(distributionHandler.process).not.toHaveBeenCalled();

    await runtime.dispatchJob('distribution', {
      name: 'distribution',
      data: { tenantId: 'tenant_a', taskId: 'task_42' },
    });

    expect(distributionHandler.process).toHaveBeenCalledTimes(1);
    expect(distributionHandler.process).toHaveBeenCalledWith({
      tenantId: 'tenant_a',
      taskId: 'task_42',
    });
    expect(driver.handle).not.toHaveBeenCalled();
  });

  it('does not fall through to WorkDriver.handle() when DISTRIBUTION_HANDLER is not injected', async () => {
    const { runtime, driver } = makeRuntime({ omitDistributionHandler: true });

    await runtime.dispatchJob('distribution', {
      name: 'distribution',
      data: { tenantId: 'tenant_a', taskId: 'task_1', runId: 'run_1' },
    });
    await runtime.dispatchJob('distribution', {
      name: 'legacy-step',
      data: { tenantId: 'tenant_a', runId: 'run_1' },
    });

    expect(driver.handle).not.toHaveBeenCalled();
  });
});
