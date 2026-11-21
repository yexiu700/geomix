import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import {
  deriveObservationBriefSource,
  dismissBrief,
  fetchBriefs,
  generateBrief,
  getBrief,
  updateBrief,
} from './briefs';

describe('apps/web/lib/briefs v2 client', () => {
  const spy = vi.spyOn(api, 'authorizedV2Request');

  beforeEach(() => {
    spy.mockReset();
  });

  it('calls exact /api/v2 endpoints with encoded IDs, query params, and AbortSignal', async () => {
    const controller = new AbortController();
    spy.mockResolvedValueOnce({ items: [], total: 0 });

    await fetchBriefs(
      'brand/1',
      'GLOBAL',
      { status: 'OPEN', sourceType: 'AUTO_GAP', includeDismissed: false, page: 2, pageSize: 20 },
      { signal: controller.signal },
    );

    expect(spy).toHaveBeenCalledWith(
      '/brands/brand%2F1/briefs?market=GLOBAL&status=OPEN&sourceType=AUTO_GAP&includeDismissed=false&page=2&pageSize=20',
      { method: 'GET', storage: undefined, signal: controller.signal },
    );

    spy.mockResolvedValueOnce({ id: 'b1' });
    await getBrief('brief/1', { signal: controller.signal });
    expect(spy).toHaveBeenCalledWith('/briefs/brief%2F1', {
      method: 'GET',
      storage: undefined,
      signal: controller.signal,
    });

    spy.mockResolvedValueOnce({ id: 'b2' });
    await generateBrief(
      'brand_1',
      { market: 'CN', sourceType: 'FANOUT_CLUSTER', fanOutQueries: ['安静NAS'] },
      { signal: controller.signal },
    );
    expect(spy).toHaveBeenCalledWith('/brands/brand_1/briefs/generate', {
      method: 'POST',
      body: { market: 'CN', sourceType: 'FANOUT_CLUSTER', fanOutQueries: ['安静NAS'] },
      storage: undefined,
      signal: controller.signal,
    });

    spy.mockResolvedValueOnce({ id: 'b2', suggestedTitle: '新标题' });
    await updateBrief('brief_2', { suggestedTitle: '新标题' }, { signal: controller.signal });
    expect(spy).toHaveBeenCalledWith('/briefs/brief_2', {
      method: 'PATCH',
      body: { suggestedTitle: '新标题' },
      storage: undefined,
      signal: controller.signal,
    });

    spy.mockResolvedValueOnce({ id: 'b2', status: 'DISMISSED' });
    await dismissBrief('brief_2', { signal: controller.signal });
    expect(spy).toHaveBeenCalledWith('/briefs/brief_2', {
      method: 'PATCH',
      body: { status: 'DISMISSED' },
      storage: undefined,
      signal: controller.signal,
    });
  });

  it('derives the right GeoBriefSource from observation mention/sentiment/rank', () => {
    expect(
      deriveObservationBriefSource({
        brandMentioned: false,
        brandSentiment: null,
        brandPosition: null,
      }),
    ).toBe('AUTO_GAP');
    expect(
      deriveObservationBriefSource({
        brandMentioned: true,
        brandSentiment: 'negative',
        brandPosition: 2,
      }),
    ).toBe('SENTIMENT_RISK');
    expect(
      deriveObservationBriefSource({
        brandMentioned: true,
        brandSentiment: 'mixed',
        brandPosition: 1,
      }),
    ).toBe('SENTIMENT_RISK');
    expect(
      deriveObservationBriefSource({
        brandMentioned: true,
        brandSentiment: 'neutral',
        brandPosition: 4,
      }),
    ).toBe('LOW_RANK');
  });
});
