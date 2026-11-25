// @vitest-environment jsdom
import { API_ERROR, AUTH_ERROR, type PublicGeoRoiReportDto } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { GatewayApiError } from './envelope';
import {
  buildDefaultRoiPeriod,
  createGeoRoiReport,
  createGeoRoiReportShare,
  exportGeoRoiReportHtml,
  fetchGeoRoiReport,
  fetchGeoRoiReports,
  fetchPublicRoiReport,
  formatUtcCalendarDate,
  formatUtcDateTime,
  printStandaloneReportHtml,
  resolveShareAbsoluteUrl,
  revokeGeoRoiReportShare,
} from './reports';

describe('lib/reports v2.2 ROI report client & helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('calls authenticated /api/v2 ROI report endpoints with encoded IDs, query params, and AbortSignal', async () => {
    const spy = vi.spyOn(api, 'authorizedV2Request').mockResolvedValue({} as never);
    const ctrl = new AbortController();

    await createGeoRoiReport(
      'brand/1',
      {
        market: 'GLOBAL',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        locale: 'en-US',
        whiteLabelOrg: 'Acme Agency',
        title: 'October GEO ROI',
      },
      { signal: ctrl.signal },
    );
    expect(spy).toHaveBeenLastCalledWith('/brands/brand%2F1/roi-reports', {
      method: 'POST',
      body: {
        market: 'GLOBAL',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        locale: 'en-US',
        whiteLabelOrg: 'Acme Agency',
        title: 'October GEO ROI',
      },
      storage: undefined,
      signal: ctrl.signal,
    });

    await fetchGeoRoiReports('brand/1', { market: 'CN', limit: 15 }, { signal: ctrl.signal });
    expect(spy).toHaveBeenLastCalledWith('/brands/brand%2F1/roi-reports?market=CN&limit=15', {
      method: 'GET',
      storage: undefined,
      signal: ctrl.signal,
    });

    await fetchGeoRoiReport('rep/42', { signal: ctrl.signal });
    expect(spy).toHaveBeenLastCalledWith('/roi-reports/rep%2F42', {
      method: 'GET',
      storage: undefined,
      signal: ctrl.signal,
    });

    await createGeoRoiReportShare('rep/42', { ttlDays: 30 }, { signal: ctrl.signal });
    expect(spy).toHaveBeenLastCalledWith('/roi-reports/rep%2F42/share', {
      method: 'POST',
      body: { ttlDays: 30 },
      storage: undefined,
      signal: ctrl.signal,
    });

    await createGeoRoiReportShare('rep_default');
    expect(spy).toHaveBeenLastCalledWith('/roi-reports/rep_default/share', {
      method: 'POST',
      body: {},
      storage: undefined,
      signal: undefined,
    });

    await revokeGeoRoiReportShare('rep/42', { signal: ctrl.signal });
    expect(spy).toHaveBeenLastCalledWith('/roi-reports/rep%2F42/share', {
      method: 'DELETE',
      storage: undefined,
      signal: ctrl.signal,
    });
  });

  it('exports standalone HTML via authorizedV2RawRequest with RFC 5987 filename parsing and error handling', async () => {
    const htmlBody = '<!DOCTYPE html><html lang="en"><body><h1>ROI Report</h1></body></html>';
    const rawSpy = vi.spyOn(api, 'authorizedV2RawRequest').mockResolvedValueOnce(
      new Response(htmlBody, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition':
            'attachment; filename="fallback.html"; filename*=UTF-8\'\'geo-roi-october-2026.html',
        },
      }),
    );

    const exported = await exportGeoRoiReportHtml('rep_123456');
    expect(rawSpy).toHaveBeenCalledWith('/roi-reports/rep_123456/export.html', {
      method: 'GET',
      storage: undefined,
      signal: undefined,
    });
    expect(exported.html).toBe(htmlBody);
    expect(exported.filename).toBe('geo-roi-october-2026.html');
    expect(exported.mime).toBe('text/html; charset=utf-8');
    expect(exported.blob).toBeInstanceOf(Blob);

    // JSON error envelope (e.g. 429 rate limit)
    rawSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: AUTH_ERROR.TOO_MANY_REQUESTS,
          msg: '导出过于频繁，请稍后重试',
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    await expect(exportGeoRoiReportHtml('rep_123456')).rejects.toMatchObject({
      status: 429,
      code: AUTH_ERROR.TOO_MANY_REQUESTS,
      message: '导出过于频繁，请稍后重试',
    });

    // Non-JSON error response falls back cleanly to GatewayApiError
    rawSpy.mockResolvedValueOnce(
      new Response('Bad Gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    await expect(exportGeoRoiReportHtml('rep_123456')).rejects.toMatchObject({
      status: 502,
      code: API_ERROR.BAD_REQUEST,
    });
  });

  it('fetches public ROI report unauthenticated with credentials=omit, cache=no-store, and zero Authorization header', async () => {
    const mockPublicDto = {
      title: 'October GEO ROI Report',
      brandName: 'AstraVault',
      category: 'NAS',
      market: 'GLOBAL',
      locale: 'en-US',
      whiteLabelOrg: null,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-10-31T23:59:59.999Z',
      generatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      summary: { version: 1 },
    } as unknown as PublicGeoRoiReportDto;

    const authSpy = vi.spyOn(api, 'authorizedV2Request');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: mockPublicDto }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ctrl = new AbortController();
    const res = await fetchPublicRoiReport('tok_abc/123', {
      apiBaseUrl: 'https://api.example.com/api/v2/',
      signal: ctrl.signal,
    });

    expect(res.title).toBe('October GEO ROI Report');
    expect(authSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/api/v2/public/roi-reports/tok_abc%2F123',
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      },
    );

    // 404 propagates GatewayApiError cleanly
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: AUTH_ERROR.NOT_FOUND, msg: '该报告分享链接不存在或已失效' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(
      fetchPublicRoiReport('expired_tok', { apiBaseUrl: 'https://api.example.com/api/v2' }),
    ).rejects.toBeInstanceOf(GatewayApiError);
  });

  it('formats UTC calendar dates and UTC timestamps without +08:00 day shift', () => {
    // 23:59:59.999Z would become 2026-11-01 in Asia/Shanghai; UTC formatter MUST keep 2026-10-31!
    expect(formatUtcCalendarDate('2026-10-31T23:59:59.999Z')).toBe('2026-10-31');
    expect(formatUtcCalendarDate('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    expect(formatUtcCalendarDate(null)).toBe('—');
    expect(formatUtcCalendarDate('not-a-date', '-')).toBe('-');

    expect(formatUtcDateTime('2026-11-01T08:05:00.000Z')).toBe('2026-11-01 08:05 UTC');
    expect(formatUtcDateTime(undefined, '-')).toBe('-');

    const period = buildDefaultRoiPeriod(new Date('2026-11-24T23:30:00.000Z'));
    expect(period).toEqual({
      periodStart: '2026-10-26',
      periodEnd: '2026-11-24',
    });
  });

  it('resolves share URL preferring browser origin + sharePath and prints via popup or hidden iframe fallback', () => {
    const resolved = resolveShareAbsoluteUrl({
      sharePath: '/share/report/tok_xyz',
      shareUrl: 'https://fallback.example.com/share/report/tok_xyz',
    });
    expect(resolved).toBe(`${window.location.origin}/share/report/tok_xyz`);

    const fallback = resolveShareAbsoluteUrl({
      sharePath: '',
      shareUrl: 'https://fallback.example.com/share/report/tok_xyz',
    });
    expect(fallback).toBe('https://fallback.example.com/share/report/tok_xyz');

    const protocolRelative = resolveShareAbsoluteUrl({
      sharePath: '//evil.example/x',
      shareUrl: 'https://fallback.example.com/share/report/tok_xyz',
    });
    expect(protocolRelative).toBe('https://fallback.example.com/share/report/tok_xyz');

    // Popup success path
    const mockPopup = {
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
      },
      focus: vi.fn(),
      print: vi.fn(),
      opener: window,
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValueOnce(mockPopup as unknown as Window);
    expect(printStandaloneReportHtml('<html><body>Hello</body></html>')).toBe(true);
    expect(mockPopup.document.write).toHaveBeenCalledWith('<html><body>Hello</body></html>');
    expect(mockPopup.print).toHaveBeenCalledTimes(1);
    expect(mockPopup.opener).toBeNull();

    // Popup blocked -> hidden iframe fallback (zero URL.revokeObjectURL)
    openSpy.mockReturnValueOnce(null);
    expect(printStandaloneReportHtml('<html><body>Iframe Print</body></html>')).toBe(true);
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('aria-hidden')).toBe('true');
    expect(iframe?.srcdoc).toBe('<html><body>Iframe Print</body></html>');
    iframe?.remove();
  });
});
