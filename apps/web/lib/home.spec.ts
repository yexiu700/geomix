import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchActionHome, formatRetestDeltaSummary } from './home';

const mockAuthorizedV2Request = vi.fn();

vi.mock('./api', () => ({
  authorizedV2Request: (...args: unknown[]) => mockAuthorizedV2Request(...args),
}));

describe('home client & retest delta formatter', () => {
  beforeEach(() => {
    mockAuthorizedV2Request.mockReset();
  });

  it('calls GET /brands/:brandId/home?market=... forwarding AbortSignal', async () => {
    const controller = new AbortController();
    mockAuthorizedV2Request.mockResolvedValueOnce({ brandId: 'brand_1', market: 'GLOBAL' });

    const res = await fetchActionHome('brand/1', 'GLOBAL', { signal: controller.signal });
    expect(res).toEqual({ brandId: 'brand_1', market: 'GLOBAL' });
    expect(mockAuthorizedV2Request).toHaveBeenCalledWith('/brands/brand%2F1/home?market=GLOBAL', {
      method: 'GET',
      storage: undefined,
      signal: controller.signal,
    });

    mockAuthorizedV2Request.mockResolvedValueOnce({ brandId: 'brand_1', market: 'GLOBAL' });
    await fetchActionHome('brand_1', 'GLOBAL', {
      productLineId: ' pl_1 ',
      days: 30,
      signal: controller.signal,
    });
    expect(mockAuthorizedV2Request).toHaveBeenLastCalledWith(
      '/brands/brand_1/home?market=GLOBAL&days=30&productLineId=pl_1',
      {
        method: 'GET',
        storage: undefined,
        signal: controller.signal,
      },
    );
  });

  it('formats Before -> After retest summaries accurately across transitions', () => {
    const improved = formatRetestDeltaSummary(
      { mentionRate: 0, avgPosition: null, sentiment: null, citationHit: false },
      { mentionRate: 100, avgPosition: 1, sentiment: 'positive', citationHit: true },
    );
    expect(improved.tone).toBe('cited');
    expect(improved.mentionLabel).toBe('0% → 100% (+100%)');
    expect(improved.positionLabel).toBe('未上榜 → #1');
    expect(improved.citationLabel).toBe('未引用 → 已进入引用');
    expect(improved.compactBadge).toContain('发布前 0% → 发布后 100%');
    expect(improved.compactBadge).toContain('已引用');

    const pending = formatRetestDeltaSummary(
      { mentionRate: 50, avgPosition: 3.5, sentiment: 'neutral', citationHit: false },
      null,
    );
    expect(pending.tone).toBe('neutral');
    expect(pending.compactBadge).toBe('发布前 50% · 待复测');

    const regressed = formatRetestDeltaSummary(
      { mentionRate: 80, avgPosition: 2, sentiment: 'positive', citationHit: true },
      { mentionRate: 40, avgPosition: 4, sentiment: 'neutral', citationHit: false },
    );
    expect(regressed.tone).toBe('warning');
    expect(regressed.mentionLabel).toBe('80% → 40% (-40%)');
  });
});
