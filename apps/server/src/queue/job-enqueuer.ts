import type { QueueName } from '@geomix/shared';

export const JOB_ENQUEUER = Symbol('JOB_ENQUEUER');

export type DriverJob = {
  tenantId: string;
  runId: string;
  queue: QueueName;
};

/** 入队只带租户和运行编号，不带正文、原文或切片。 */
export interface JobEnqueuer {
  enqueueDriver(job: DriverJob): Promise<void>;
}
