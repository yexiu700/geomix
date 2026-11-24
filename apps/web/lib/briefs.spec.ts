import { API_ERROR } from '@geomix/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import {
  createBriefFromCitationUrl,
  createBriefFromNearMiss,
  deriveObservationBriefSource,
  dismissBrief,
  fetchBriefs,
  generateBrief,
  getBrief,
  isCitationCounterFallbackError,
  updateBrief,
} from './briefs';
import { GatewayApiError } from './envelope';

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

  it('calls POST /brands/:id/briefs/from-citation-url and detects 422/42201 fallback errors', async () => {
    const controller = new AbortController();
    spy.mockResolvedValueOnce({ id: 'b_counter_1', sourceType: 'CITATION_COUNTER' });

    await createBriefFromCitationUrl(
      'brand/1',
      {
        market: 'CN',
        citationUrl: 'https://competitor.example.com/review',
        pastedTitle: '竞品参考评测',
        pastedContent: '这是一段超过二十个字的竞品高引用网页参考正文内容用于反制。',
      },
      { signal: controller.signal },
    );

    expect(spy).toHaveBeenCalledWith('/brands/brand%2F1/briefs/from-citation-url', {
      method: 'POST',
      body: {
        market: 'CN',
        citationUrl: 'https://competitor.example.com/review',
        pastedTitle: '竞品参考评测',
        pastedContent: '这是一段超过二十个字的竞品高引用网页参考正文内容用于反制。',
      },
      storage: undefined,
      signal: controller.signal,
    });

    expect(
      isCitationCounterFallbackError(
        new GatewayApiError(422, API_ERROR.UPSTREAM_UNAVAILABLE, '反爬拦截'),
      ),
    ).toBe(true);
    expect(isCitationCounterFallbackError(new GatewayApiError(422, 42299, '无法抓取'))).toBe(true);
    expect(
      isCitationCounterFallbackError(
        new GatewayApiError(400, API_ERROR.BAD_REQUEST, '链接格式错误'),
      ),
    ).toBe(false);
    expect(isCitationCounterFallbackError(new GatewayApiError(429, 42901, '限流'))).toBe(false);
    expect(isCitationCounterFallbackError(new Error('network'))).toBe(false);
  });

  it('calls POST /brands/:id/briefs/from-near-miss with Near-Miss boost payload and AbortSignal', async () => {
    const controller = new AbortController();
    spy.mockResolvedValueOnce({ id: 'b_nm_1', sourceType: 'NEAR_MISS_BOOST' });

    await createBriefFromNearMiss(
      'brand/1',
      {
        market: 'GLOBAL',
        tier: 'OPENED_NOT_CITED',
        targetPrompt: 'Best quiet 4-bay NAS 2026',
        sourceUrl: 'https://astravault.example.com/nas',
        sourceTitle: 'AstraVault Benchmark',
        observationIds: ['obs_1'],
      },
      { signal: controller.signal },
    );

    expect(spy).toHaveBeenCalledWith('/brands/brand%2F1/briefs/from-near-miss', {
      method: 'POST',
      body: {
        market: 'GLOBAL',
        tier: 'OPENED_NOT_CITED',
        targetPrompt: 'Best quiet 4-bay NAS 2026',
        sourceUrl: 'https://astravault.example.com/nas',
        sourceTitle: 'AstraVault Benchmark',
        observationIds: ['obs_1'],
      },
      storage: undefined,
      signal: controller.signal,
    });
  });
});
