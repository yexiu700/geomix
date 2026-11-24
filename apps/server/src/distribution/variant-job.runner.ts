import { Inject, Injectable } from '@nestjs/common';
import {
  VARIANT_JOB_ENQUEUER,
  VARIANT_JOB_HANDLER,
  VariantGeneratorService,
  type VariantJobData,
  type VariantJobEnqueuer,
  type VariantJobHandler,
} from './variant-generator.service';

export { VARIANT_JOB_ENQUEUER, VARIANT_JOB_HANDLER };
export type { VariantJobData, VariantJobEnqueuer, VariantJobHandler };

/**
 * BullMQ `'distribution'` 队列 `'variant-generate'` 任务消费者（Issue #363）：
 * 委托 `VariantGeneratorService.processVariantJob`，全量在 `runInTenant` 内使用 `prisma.scoped`。
 */
@Injectable()
export class VariantJobRunner implements VariantJobHandler {
  constructor(
    @Inject(VariantGeneratorService)
    private readonly variantGenerator: VariantGeneratorService,
  ) {}

  async process(payload: VariantJobData): Promise<void> {
    await this.variantGenerator.processVariantJob(payload.tenantId, payload.jobId);
  }
}
