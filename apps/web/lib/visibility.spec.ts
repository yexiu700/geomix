import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import {
  cancelVisibilityRun,
  createVisibilityIdempotencyKey,
  createVisibilityRun,
  deleteVisibilityRun,
  fetchVisibilityCitations,
  fetchVisibilityEngines,
  fetchVisibilityNearMiss,
  fetchVisibilityOpportunities,
  fetchVisibilityOverview,
  fetchVisibilityRunDetail,
  fetchVisibilityRuns,
  filterEnginesForMarket,
  isSafeHttpUrl,
  parsePromptLines,
  pauseVisibilityRun,
  resumeVisibilityRun,
} from './visibility';

describe('lib/visibility v2 API client and helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls exact /api/v2/brands/:brandId/visibility/* endpoints with market query, AbortSignal & Idempotency-Key', async () => {
    const spy = vi.spyOn(api, 'authorizedV2Request').mockResolvedValue({} as never);
    const ctrl = new AbortController();

    await fetchVisibilityOverview(
      'brand/1',
      'CN',
      { days: 14, engine: 'deepseek' },
      { signal: ctrl.signal },
    );
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/visibility/overview?market=CN&days=14&engine=deepseek',
      { method: 'GET', storage: undefined, signal: ctrl.signal },
    );

    await fetchVisibilityEngines('brand_1', 'GLOBAL', { signal: ctrl.signal });
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/engines?market=GLOBAL', {
      method: 'GET',
      storage: undefined,
      signal: ctrl.signal,
    });

    await fetchVisibilityRuns('brand_1', 'CN', {
      page: 2,
      pageSize: 25,
      status: 'COMPLETED',
      keyword: 'NAS',
    });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/brand_1/visibility/runs?market=CN&page=2&pageSize=25&status=COMPLETED&keyword=NAS',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await createVisibilityRun(
      'brand_1',
      { market: 'CN', prompts: ['静音NAS推荐'], engines: ['deepseek'] },
      'vrun_idem_123456',
      { signal: ctrl.signal },
    );
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs', {
      method: 'POST',
      body: { market: 'CN', prompts: ['静音NAS推荐'], engines: ['deepseek'] },
      headers: { 'Idempotency-Key': 'vrun_idem_123456' },
      storage: undefined,
      signal: ctrl.signal,
    });

    await fetchVisibilityRunDetail('brand_1', 'run_1', 'CN');
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs/run_1?market=CN', {
      method: 'GET',
      storage: undefined,
      signal: undefined,
    });

    await fetchVisibilityCitations('brand_1', 'CN', {
      days: 30,
      sourceKind: 'COMPETITOR',
      page: 1,
    });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/brand_1/visibility/citations?market=CN&days=30&sourceKind=COMPETITOR&page=1',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityOpportunities('brand_1', 'GLOBAL', { days: 14, limit: 20 });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/brand_1/visibility/opportunities?market=GLOBAL&days=14&limit=20',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityNearMiss(
      'brand/1',
      'CN',
      { days: 30, tier: 'OPENED_NOT_CITED', sourceKind: 'OWNED', limit: 50 },
      { signal: ctrl.signal },
    );
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/visibility/near-miss?market=CN&days=30&tier=OPENED_NOT_CITED&sourceKind=OWNED&limit=50',
      { method: 'GET', storage: undefined, signal: ctrl.signal },
    );

    await pauseVisibilityRun('brand_1', 'run_1', 'CN');
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs/run_1/pause?market=CN', {
      method: 'POST',
      storage: undefined,
      signal: undefined,
    });

    await resumeVisibilityRun('brand_1', 'run_1', 'CN');
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs/run_1/resume?market=CN', {
      method: 'POST',
      storage: undefined,
      signal: undefined,
    });

    await cancelVisibilityRun('brand_1', 'run_1', 'CN');
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs/run_1/cancel?market=CN', {
      method: 'POST',
      storage: undefined,
      signal: undefined,
    });

    await deleteVisibilityRun('brand_1', 'run_1', 'CN');
    expect(spy).toHaveBeenLastCalledWith('/brands/brand_1/visibility/runs/run_1?market=CN', {
      method: 'DELETE',
      storage: undefined,
      signal: undefined,
    });
  });

  it('filters engines strictly to CN (8, canonical tongyi) or GLOBAL (5) in canonical order', () => {
    const mixed = [
      {
        key: 'chatgpt' as const,
        label: 'ChatGPT',
        domestic: false,
        available: true,
        status: 'online' as const,
      },
      {
        key: 'tongyi' as const,
        label: '通义千问',
        domestic: true,
        available: false,
        status: 'offline' as const,
      },
      {
        key: 'deepseek' as const,
        label: 'DeepSeek',
        domestic: true,
        available: true,
        status: 'online' as const,
      },
      {
        key: 'perplexity' as const,
        label: 'Perplexity',
        domestic: false,
        available: true,
        status: 'online' as const,
      },
    ];
    expect(filterEnginesForMarket(mixed, 'CN').map((e) => e.key)).toEqual(['deepseek', 'tongyi']);
    expect(filterEnginesForMarket(mixed, 'GLOBAL').map((e) => e.key)).toEqual([
      'chatgpt',
      'perplexity',
    ]);
  });

  it('parses prompt lines, generates valid idempotency keys, and validates safe http/https URLs', () => {
    expect(parsePromptLines('  家用NAS推荐 \nA\n\n家用nas推荐\r\n  静音  四盘位 NAS  ')).toEqual([
      '家用NAS推荐',
      '静音 四盘位 NAS',
    ]);

    const key = createVisibilityIdempotencyKey();
    expect(/^[A-Za-z0-9:_-]{8,160}$/.test(key)).toBe(true);

    expect(isSafeHttpUrl('https://example.com/path')).toBe(true);
    expect(isSafeHttpUrl('http://public.e2e.example/competitor/nas-review')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpUrl('not-a-url')).toBe(false);
  });

  it('forwards optional productLineId query parameter across all visibility read endpoints', async () => {
    const spy = vi.spyOn(api, 'authorizedV2Request').mockResolvedValue({} as never);

    await fetchVisibilityOverview('b1', 'GLOBAL', { days: 14, productLineId: ' pl_1 ' });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/b1/visibility/overview?market=GLOBAL&days=14&productLineId=pl_1',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityRuns('b1', 'GLOBAL', { page: 1, productLineId: 'pl_1' });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/b1/visibility/runs?market=GLOBAL&page=1&productLineId=pl_1',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityCitations('b1', 'GLOBAL', { days: 14, productLineId: 'pl_1' });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/b1/visibility/citations?market=GLOBAL&days=14&productLineId=pl_1',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityOpportunities('b1', 'GLOBAL', { days: 14, productLineId: 'pl_1' });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/b1/visibility/opportunities?market=GLOBAL&days=14&productLineId=pl_1',
      { method: 'GET', storage: undefined, signal: undefined },
    );

    await fetchVisibilityNearMiss('b1', 'GLOBAL', { days: 14, productLineId: 'pl_1' });
    expect(spy).toHaveBeenLastCalledWith(
      '/brands/b1/visibility/near-miss?market=GLOBAL&days=14&productLineId=pl_1',
      { method: 'GET', storage: undefined, signal: undefined },
    );
  });
});
