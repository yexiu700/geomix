import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from './envelope';

const { authorizedV2RequestMock, authorizedV2RawRequestMock } = vi.hoisted(() => ({
  authorizedV2RequestMock: vi.fn(),
  authorizedV2RawRequestMock: vi.fn(),
}));

vi.mock('./api', () => ({
  authorizedV2Request: authorizedV2RequestMock,
  authorizedV2RawRequest: authorizedV2RawRequestMock,
}));

import {
  PreflightBlockedError,
  createChannelConnection,
  createDistributionIdempotencyKey,
  createPrShareLink,
  deleteChannelConnection,
  fetchPublicPrPacket,
  generateDistributionVariants,
  isPreflightBlockedError,
  listArticleDistributions,
  listChannelConnections,
  publishDistributionTask,
  revokePrShareLink,
  runArticlePreflight,
  submitPublicPrPacket,
  testChannelConnection,
  triggerCrawlProbe,
  updateChannelConnection,
  updateDistributionTask,
  updateRetestSchedules,
} from './distribution';

describe('apps/web/lib/distribution API client', () => {
  beforeEach(() => {
    authorizedV2RequestMock.mockReset();
    authorizedV2RawRequestMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('encodes paths & query params for all 5 channel connection endpoints', async () => {
    authorizedV2RequestMock.mockResolvedValueOnce({ items: [] });
    await listChannelConnections('brand/1', 'GLOBAL');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/connections?market=GLOBAL',
      expect.objectContaining({ method: 'GET' }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ items: [] });
    await listChannelConnections('brand_1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand_1/connections',
      expect.objectContaining({ method: 'GET' }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ id: 'conn_1' });
    await createChannelConnection('brand/1', {
      market: 'GLOBAL',
      provider: 'WEBHOOK',
      displayName: 'Acme Webhook',
      siteBaseUrl: 'https://hooks.acme.example/publish',
      credentials: { signingSecret: 'whsec_123456' },
    });
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/connections',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ displayName: 'Acme Webhook' }),
      }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ id: 'conn_1' });
    await updateChannelConnection('brand/1', 'conn/9', { displayName: 'Renamed' });
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/connections/conn%2F9',
      expect.objectContaining({ method: 'PATCH', body: { displayName: 'Renamed' } }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ deleted: 1, id: 'conn/9' });
    await deleteChannelConnection('brand/1', 'conn/9');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/connections/conn%2F9',
      expect.objectContaining({ method: 'DELETE' }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ ok: true });
    await testChannelConnection('brand/1', 'conn/9');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/brands/brand%2F1/connections/conn%2F9/test',
      expect.objectContaining({ method: 'POST', body: {} }),
    );
  });

  it('calls preflight, distributions list, variants (with Idempotency-Key), task edit, PR share, crawl-probe & retest-schedules', async () => {
    authorizedV2RequestMock.mockResolvedValueOnce({ ok: true, blockers: [], warnings: [] });
    await runArticlePreflight('art/1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/articles/art%2F1/preflight',
      expect.objectContaining({ method: 'POST', body: {} }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ items: [] });
    await listArticleDistributions('art/1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/articles/art%2F1/distributions',
      expect.objectContaining({ method: 'GET' }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ tasks: [], failures: [] });
    await generateDistributionVariants(
      'art/1',
      { targets: [{ provider: 'WORDPRESS', channelLabel: 'Blog' }] },
      { idempotencyKey: 'idem_custom_1' },
    );
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/articles/art%2F1/distributions/variants',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem_custom_1' },
      }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ tasks: [], failures: [] });
    await generateDistributionVariants('art/1', {
      targets: [{ provider: 'PR_PACKET', channelLabel: 'PR' }],
    });
    const autoHeaders = authorizedV2RequestMock.mock.calls.at(-1)?.[1]?.headers as Record<
      string,
      string
    >;
    expect(autoHeaders['Idempotency-Key']).toMatch(/^dist_var_/);

    authorizedV2RequestMock.mockResolvedValueOnce({ id: 'task_1' });
    await updateDistributionTask('task/1', { variantTitle: 'Updated Title' });
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/distributions/task%2F1',
      expect.objectContaining({ method: 'PATCH', body: { variantTitle: 'Updated Title' } }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({
      taskId: 'task/1',
      shareUrl: 'https://app.example/share/pr/tok',
      token: 'tok',
      expiresAt: '2026-12-31T00:00:00.000Z',
      ttlDays: 30,
    });
    await createPrShareLink('task/1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/distributions/task%2F1/pr-share',
      expect.objectContaining({ method: 'POST', body: {} }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({
      taskId: 'task/1',
      revoked: true,
      revokedAt: '2026-11-23T00:00:00.000Z',
    });
    await revokePrShareLink('task/1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/distributions/task%2F1/pr-share',
      expect.objectContaining({ method: 'DELETE' }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ id: 'pr_1', crawlStatus: 'OK' });
    await triggerCrawlProbe('pr/1');
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/publish-records/pr%2F1/crawl-probe',
      expect.objectContaining({ method: 'POST', body: {} }),
    );

    authorizedV2RequestMock.mockResolvedValueOnce({ publishRecordId: 'pr/1', items: [] });
    await updateRetestSchedules('pr/1', { sampleCount: 3 });
    expect(authorizedV2RequestMock).toHaveBeenLastCalledWith(
      '/publish-records/pr%2F1/retest-schedules',
      expect.objectContaining({ method: 'PATCH', body: { sampleCount: 3 } }),
    );
  });

  it('publishes task via authorizedV2RawRequest, parses HTTP 422 into PreflightBlockedError with structured blockers/warnings, and unwraps 200', async () => {
    const blockedPayload = {
      ok: false,
      blockers: [
        {
          code: 'MISSING_FACT_SLOTS',
          severity: 'blocker',
          message: '存在未补填事实占位符',
          details: ['[TBD: price]'],
        },
      ],
      warnings: [{ code: 'LOW_GEO_SCORE', severity: 'warning', message: 'GEO 分偏低' }],
      preflight: {
        ok: false,
        blockers: [
          {
            code: 'MISSING_FACT_SLOTS',
            severity: 'blocker',
            message: '存在未补填事实占位符',
            details: ['[TBD: price]'],
          },
        ],
        warnings: [{ code: 'LOW_GEO_SCORE', severity: 'warning', message: 'GEO 分偏低' }],
      },
    };

    authorizedV2RawRequestMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 40001,
          msg: '发布前校验未通过：存在未补填事实占位符',
          data: blockedPayload,
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    let caught: unknown;
    try {
      await publishDistributionTask(
        'task/1',
        { publishAsDraft: false },
        { idempotencyKey: 'pub_1' },
      );
    } catch (err) {
      caught = err;
    }

    expect(authorizedV2RawRequestMock).toHaveBeenCalledWith(
      '/distributions/task%2F1/publish',
      expect.objectContaining({
        method: 'POST',
        body: { publishAsDraft: false },
        headers: { 'Idempotency-Key': 'pub_1' },
      }),
    );
    expect(isPreflightBlockedError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(PreflightBlockedError);
    expect(caught).toBeInstanceOf(GatewayApiError);
    if (isPreflightBlockedError(caught)) {
      expect(caught.status).toBe(422);
      expect(caught.code).toBe(40001);
      expect(caught.blockers).toHaveLength(1);
      expect(caught.blockers[0]?.code).toBe('MISSING_FACT_SLOTS');
      expect(caught.warnings).toHaveLength(1);
      expect(caught.preflight?.ok).toBe(false);
    }

    authorizedV2RawRequestMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 0, msg: 'ok', data: { id: 'task_1', status: 'PUBLISHING' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const published = await publishDistributionTask('task_1');
    expect(published.status).toBe('PUBLISHING');
    const pubHeaders = authorizedV2RawRequestMock.mock.calls.at(-1)?.[1]?.headers as Record<
      string,
      string
    >;
    expect(pubHeaders['Idempotency-Key']).toMatch(/^dist_pub_/);

    expect(createDistributionIdempotencyKey('var')).toMatch(/^dist_var_/);
    expect(createDistributionIdempotencyKey('pub')).toMatch(/^dist_pub_/);
  });

  it('fetches and submits public PR packets via direct fetch with credentials=omit, zero Authorization header, zero authorizedV2Request calls, and SSR safety', async () => {
    expect(typeof window).toBe('undefined');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            market: 'GLOBAL',
            locale: 'en-US',
            brandName: 'Acme',
            category: 'Hardware',
            channelLabel: 'Tech Review',
            suggestedTitle: 'Acme Review',
            targetPrompt: 'Best hardware',
            targetFanOuts: [],
            keyAngles: ['Specs'],
            verifiedFacts: [{ title: 'Battery', summary: '24h' }],
            draftMarkdown: '# Acme',
            draftHtml: '<h1>Acme</h1>',
            status: 'DRAFT_VARIANT',
            submittedUrl: null,
            expiresAt: '2026-12-31T00:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const packet = await fetchPublicPrPacket('tok/abc', {
      apiBaseUrl: 'https://api.geomix.example/api/v2/',
    });
    expect(packet.brandName).toBe('Acme');
    expect(authorizedV2RequestMock).not.toHaveBeenCalled();
    expect(authorizedV2RawRequestMock).not.toHaveBeenCalled();

    const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe('https://api.geomix.example/api/v2/public/pr-packets/tok%2Fabc');
    expect(getInit.method).toBe('GET');
    expect(getInit.credentials).toBe('omit');
    expect(getInit.cache).toBe('no-store');
    expect(getInit.headers).toEqual({ accept: 'application/json' });
    expect(JSON.stringify(getInit.headers).toLowerCase()).not.toContain('authorization');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            accepted: true,
            publishedUrl: 'https://media.example/acme-review',
            submittedAt: '2026-11-23T12:00:00.000Z',
            alreadyRecorded: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const receipt = await submitPublicPrPacket(
      'tok_123',
      { publishedUrl: 'https://media.example/acme-review' },
      { apiBaseUrl: 'https://api.geomix.example/api/v2' },
    );
    expect(receipt.accepted).toBe(true);
    expect(receipt.alreadyRecorded).toBe(false);
    expect(authorizedV2RequestMock).not.toHaveBeenCalled();
    expect(authorizedV2RawRequestMock).not.toHaveBeenCalled();

    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://api.geomix.example/api/v2/public/pr-packets/tok_123/submit');
    expect(postInit.method).toBe('POST');
    expect(postInit.credentials).toBe('omit');
    expect(postInit.cache).toBe('no-store');
    expect(JSON.stringify(postInit.headers).toLowerCase()).not.toContain('authorization');

    for (const [status, code, msg] of [
      [404, 40401, '该协作链接不存在或已失效'],
      [400, 40001, '提交的链接不允许访问'],
      [429, 42901, '操作过于频繁，请稍后再试'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ code, msg, data: null }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await expect(fetchPublicPrPacket('tok_bad')).rejects.toMatchObject({
        name: 'GatewayApiError',
        status,
        code,
        message: msg,
      });
    }

    fetchMock.mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(fetchPublicPrPacket('tok_502')).rejects.toMatchObject({
      name: 'GatewayApiError',
      status: 502,
      code: -1,
    });
  });
});
