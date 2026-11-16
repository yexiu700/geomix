import { Injectable } from '@nestjs/common';

export type StepContext = {
  runId: string;
  unitId: string;
  tenantId: string;
  step: number;
};

/**
 * 假任务的每一步都经过这里。生产环境直接放行。
 * 测试可以把它停住，用来验证暂停、取消和并发上限。
 */
@Injectable()
export class StepGate {
  handler: (context: StepContext) => Promise<void> = async () => undefined;
}
