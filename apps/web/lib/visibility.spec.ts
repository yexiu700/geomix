import { describe, expect, it } from 'vitest';
import {
  buildVisibilityCitationQueryString,
  buildVisibilityOverviewQueryString,
  buildVisibilityRunQueryString,
  createVisibilityIdempotencyKey,
} from './visibility';

describe('visibility gateway helpers', () => {
  it('generates valid idempotency keys accepted by backend header validation', () => {
    const key1 = createVisibilityIdempotencyKey('vrun');
    const key2 = createVisibilityIdempotencyKey('vrun');
    expect(key1).toMatch(/^[A-Za-z0-9:_-]{8,160}$/);
    expect(key2).toMatch(/^[A-Za-z0-9:_-]{8,160}$/);
    expect(key1).not.toBe(key2);
  });

  it('builds canonical query strings for runs, overview, and citations', () => {
    expect(
      buildVisibilityRunQueryString({
        page: 2,
        pageSize: 25,
        profileId: 'vprof_01',
        status: 'RUNNING',
        keyword: '便携显示器',
      }),
    ).toBe(
      `page=2&pageSize=25&profileId=vprof_01&status=RUNNING&keyword=${encodeURIComponent('便携显示器')}`,
    );

    expect(
      buildVisibilityOverviewQueryString({
        profileId: 'vprof_01',
        engine: 'deepseek',
        days: 14,
      }),
    ).toBe('days=14&profileId=vprof_01&engine=deepseek');

    expect(
      buildVisibilityCitationQueryString({
        profileId: 'vprof_01',
        sourceKind: 'OWNED',
        days: 30,
        page: 1,
        pageSize: 10,
      }),
    ).toBe('days=30&page=1&pageSize=10&profileId=vprof_01&sourceKind=OWNED');
  });
});
