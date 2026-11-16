import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports GeoMix and the default shadow billing mode', () => {
    const health = new HealthService().getHealth({});
    expect(health).toEqual({
      code: 0,
      msg: 'ok',
      data: { service: 'api', name: 'GeoMix', billingMode: 'SHADOW' },
    });
  });
});
