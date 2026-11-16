import { Module } from '@nestjs/common';
import { WorkerRuntimeService } from './worker/worker-runtime.service';

@Module({
  providers: [WorkerRuntimeService],
})
export class WorkerModule {}
