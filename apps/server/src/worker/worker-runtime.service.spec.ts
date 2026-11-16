import { describe, expect, it } from 'vitest';
import { WorkerRuntimeService } from './worker-runtime.service';

describe('WorkerRuntimeService', () => {
  it('stays in standby until a queue connection is marked', () => {
    const runtime = new WorkerRuntimeService();
    expect(runtime.status({})).toEqual({
      service: 'worker',
      name: 'GeoMix',
      billingMode: 'SHADOW',
      queue: 'standby',
      upstream: 'disabled',
    });
    expect(runtime.status({ BILLING_MODE: 'STRICT' }).billingMode).toBe('STRICT');
    runtime.markConnected();
    expect(runtime.status({}).queue).toBe('bullmq');
    expect(runtime.status({}).upstream).toBe('disabled');
  });
});
