import { describe, expect, it } from 'vitest';
import { WorkerRuntimeService } from './worker-runtime.service';

describe('WorkerRuntimeService', () => {
  it('stays in standby and does not pretend a queue is connected', () => {
    const runtime = new WorkerRuntimeService();
    expect(runtime.status({})).toEqual({
      service: 'worker',
      name: 'GeoMix',
      billingMode: 'SHADOW',
      queue: 'standby',
    });
    expect(runtime.status({ BILLING_MODE: 'STRICT' }).billingMode).toBe('STRICT');
  });

  it('starts and stops the heartbeat that keeps the process alive', () => {
    const runtime = new WorkerRuntimeService();
    runtime.onModuleInit();
    runtime.onModuleDestroy();
  });
});
