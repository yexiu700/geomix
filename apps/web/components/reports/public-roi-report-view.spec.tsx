// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUTH_ERROR, type PublicGeoRoiReportDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from '../../lib/envelope';
import * as reportsApi from '../../lib/reports';
import { PublicRoiReportView } from './public-roi-report-view';

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function makePublicReport(overrides?: Partial<PublicGeoRoiReportDto>): PublicGeoRoiReportDto {
  return {
    title: 'AstraVault October 2026 GEO ROI Report',
    brandName: 'AstraVault',
    category: 'Smart Home NAS',
    market: 'GLOBAL',
    locale: 'en-US',
    whiteLabelOrg: null,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-31T23:59:59.999Z',
    generatedAt: '2026-11-01T09:15:00.000Z',
    expiresAt: '2026-12-01T09:15:00.000Z',
    summary: {
      version: 1,
      overview: {
        totalObservations: 12400,
        mentionHits: 8680,
        mentionRate: 0.7,
        mentionWilson: {
          hits: 8680,
          trials: 12400,
          rate: 0.7,
          lower: 0.6919,
          upper: 0.708,
          halfWidth: 0.0081,
          z: 1.96,
          confidenceLevel: 'HIGH',
        },
        citationHits: 4960,
        citationRate: 0.4,
        ownedCitationHits: 3100,
        ownedCitationRate: 0.25,
        confidenceLevel: 'HIGH',
        did: {
          treatmentDelta: 0.28,
          controlDelta: 0.04,
          netLift: 0.24,
          direction: 'POSITIVE',
        },
      },
      byEngine: [
        {
          engine: 'chatgpt',
          observations: 6000,
          mentionRate: 0.75,
          citationRate: 0.45,
          ownedCitationRate: 0.3,
          avgPosition: 1.8,
          mentionWilson: {
            hits: 4500,
            trials: 6000,
            rate: 0.75,
            lower: 0.7389,
            upper: 0.7608,
            halfWidth: 0.011,
            z: 1.96,
            confidenceLevel: 'HIGH',
          },
        },
        {
          engine: 'doubao',
          observations: 3200,
          mentionRate: 0.65,
          citationRate: 0.35,
          ownedCitationRate: 0.2,
          avgPosition: 2.3,
          mentionWilson: {
            hits: 2080,
            trials: 3200,
            rate: 0.65,
            lower: 0.6333,
            upper: 0.6663,
            halfWidth: 0.0165,
            z: 1.96,
            confidenceLevel: 'HIGH',
          },
        },
        {
          engine: 'tongyi',
          observations: 3200,
          mentionRate: 0.656,
          citationRate: 0.36,
          ownedCitationRate: 0.21,
          avgPosition: 2.5,
          mentionWilson: {
            hits: 2100,
            trials: 3200,
            rate: 0.656,
            lower: 0.639,
            upper: 0.672,
            halfWidth: 0.0165,
            z: 1.96,
            confidenceLevel: 'HIGH',
          },
        },
      ],
      nearMiss: {
        totalOpportunities: 18,
        boostBriefsCreated: 9,
        convertedToCited: 5,
        tierCounts: {
          OPENED_NOT_CITED: 6,
          RETRIEVED_NOT_CITED: 5,
          CRAWLED_NOT_CITED: 4,
          MENTIONED_NOT_OWNED: 3,
        },
      },
      funnel: {
        publishedTotal: 14,
        l1Count: 9,
        l2Count: 3,
        l3Count: 2,
        crawlCheckedCount: 14,
        crawlOkCount: 13,
        crawlOkRate: 0.9286,
        indexNowAttemptedCount: 9,
        indexNowSuccessCount: 8,
        indexNowRate: 0.8889,
      },
      channelRanking: [
        {
          channel: 'Official Blog / Docs',
          mode: 'L1_API',
          publishedCount: 6,
          completedRetestCount: 6,
          citationHitCount: 4,
          citationHitRate: 0.6667,
          citationHitWilson: {
            hits: 4,
            trials: 6,
            rate: 0.6667,
            lower: 0.3,
            upper: 0.9032,
            halfWidth: 0.3016,
            z: 1.96,
            confidenceLevel: 'MEDIUM',
          },
          avgMentionRateDelta: 0.22,
        },
      ],
      milestoneTrend: [
        {
          milestoneDay: 7,
          trials: 12,
          hits: 8,
          mentionRate: 0.6667,
          wilson: {
            hits: 8,
            trials: 12,
            rate: 0.6667,
            lower: 0.3906,
            upper: 0.8619,
            halfWidth: 0.2356,
            z: 1.96,
            confidenceLevel: 'MEDIUM',
          },
          controlMentionRate: 0.4,
          did: {
            treatmentDelta: 0.2667,
            controlDelta: 0.05,
            netLift: 0.2167,
            direction: 'POSITIVE',
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('PublicRoiReportView (#372 standalone unauthenticated share page)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('renders strict pure EN report with ZERO Chinese/CJK characters anywhere in DOM, sets lang/title, and calls window.print()', async () => {
    const enReport = makePublicReport();
    vi.spyOn(reportsApi, 'fetchPublicRoiReport').mockResolvedValueOnce(enReport);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    render(<PublicRoiReportView token="tok_en_valid_123456" />);

    await screen.findByTestId('public-roi-header');

    const fullText = document.body.textContent ?? '';
    expect(fullText).not.toMatch(CJK_REGEX);
    expect(document.documentElement.lang).toBe('en-US');
    expect(document.title).toBe('AstraVault October 2026 GEO ROI Report - GeoMix');
    expect(document.title).not.toMatch(CJK_REGEX);

    // Verifies EN localization of CN engines & large numbers (no 1.2万) & non-whitelabel Powered by GeoMix
    expect(screen.getByTestId('public-roi-powered-by-badge').textContent).toContain(
      'Powered by GeoMix',
    );
    expect(screen.getByTestId('public-roi-period').textContent).toContain(
      '2026-10-01 ~ 2026-10-31',
    );
    expect(screen.getByTestId('public-roi-overview').textContent).toContain('12,400');
    expect(screen.getByTestId('public-roi-did-card').textContent).toContain('+24.0pp');
    expect(screen.getByTestId('public-roi-engines').textContent).toContain('Doubao');
    expect(screen.getByTestId('public-roi-engines').textContent).toContain('Qwen (Tongyi)');
    expect(screen.getByTestId('public-roi-near-miss').textContent).toContain(
      'Opened, Not Cited (Tier 1)',
    );
    expect(screen.getByTestId('public-roi-funnel').textContent).toContain('92.9%');
    expect(screen.getByTestId('public-roi-channels').textContent).toContain('Official Blog / Docs');
    expect(screen.getByTestId('public-roi-milestones').textContent).toContain('D+7');

    fireEvent.click(screen.getByTestId('public-roi-print-btn'));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('renders pure CN report when locale is zh-CN and displays low-sample hint when n < 5', async () => {
    const zhReport = makePublicReport({
      title: '星vault 2026年10月 GEO ROI 复盘报告',
      brandName: '星vault',
      category: '智能家用 NAS',
      market: 'CN',
      locale: 'zh-CN',
      summary: {
        ...makePublicReport().summary,
        overview: {
          ...makePublicReport().summary.overview,
          totalObservations: 4,
          mentionHits: 3,
          mentionRate: 0.75,
          mentionWilson: {
            hits: 3,
            trials: 4,
            rate: 0.75,
            lower: 0.3006,
            upper: 0.9544,
            halfWidth: 0.3269,
            z: 1.96,
            confidenceLevel: 'LOW',
          },
          confidenceLevel: 'LOW',
        },
      },
    });
    vi.spyOn(reportsApi, 'fetchPublicRoiReport').mockResolvedValueOnce(zhReport);

    render(<PublicRoiReportView token="tok_zh_valid_123456" />);

    await screen.findByTestId('public-roi-header');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.getByTestId('public-roi-powered-by-badge').textContent).toContain(
      '由 GeoMix 提供支持',
    );
    expect(screen.getByTestId('public-roi-print-btn').textContent).toContain('打印 / 保存 PDF');
    expect(screen.getByTestId('public-roi-engines').textContent).toContain('豆包');
    expect(screen.getByTestId('public-roi-near-miss').textContent).toContain(
      'AI 点开未引用（Tier 1）',
    );
    expect(screen.getByTestId('public-roi-low-sample-hint').textContent).toContain('3× 采样');
  });

  it('displays whiteLabelOrg in header/footer/title and omits Powered by GeoMix when whiteLabelOrg is set', async () => {
    const wlReport = makePublicReport({
      whiteLabelOrg: 'Northstar Digital Agency',
    });
    vi.spyOn(reportsApi, 'fetchPublicRoiReport').mockResolvedValueOnce(wlReport);

    render(<PublicRoiReportView token="tok_wl_valid_123456" />);

    await screen.findByTestId('public-roi-header');
    expect(screen.getByTestId('public-roi-whitelabel-badge').textContent).toBe(
      'Northstar Digital Agency',
    );
    expect(screen.queryByTestId('public-roi-powered-by-badge')).toBeNull();
    expect(screen.getByTestId('public-roi-footer').textContent).toContain(
      'Northstar Digital Agency',
    );
    expect(document.body.textContent ?? '').not.toContain('Powered by GeoMix');
    expect(document.body.textContent ?? '').not.toContain('GeoMix');
    expect(document.title).toBe(
      'AstraVault October 2026 GEO ROI Report - Northstar Digital Agency',
    );
  });

  it('renders clean friendly 404 and 429 states without leaking raw Chinese backend error messages', async () => {
    const fetchSpy = vi
      .spyOn(reportsApi, 'fetchPublicRoiReport')
      .mockRejectedValueOnce(
        new GatewayApiError(404, AUTH_ERROR.NOT_FOUND, '该报告分享链接不存在或已失效'),
      );

    const { rerender } = render(<PublicRoiReportView token="revoked_tok_123456" />);

    const errBox = await screen.findByTestId('public-roi-report-error');
    expect(errBox.textContent).toContain('Report Link Unavailable');
    expect(errBox.textContent).not.toContain('该报告分享链接不存在或已失效');
    expect(errBox.textContent ?? '').not.toMatch(CJK_REGEX);

    // 429 rate-limited state with working retry
    fetchSpy
      .mockRejectedValueOnce(
        new GatewayApiError(429, AUTH_ERROR.TOO_MANY_REQUESTS, '请求过于频繁，请稍后重试'),
      )
      .mockResolvedValueOnce(makePublicReport());

    rerender(<PublicRoiReportView token="rate_limited_tok_123456" />);
    const rateBox = await screen.findByTestId('public-roi-report-error');
    expect(rateBox.textContent).toContain('Too Many Requests');
    expect(rateBox.textContent ?? '').not.toMatch(CJK_REGEX);

    fireEvent.click(screen.getByTestId('public-roi-retry-btn'));
    await screen.findByTestId('public-roi-header');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('escapes XSS payloads strictly as text (zero injected script/img nodes)', async () => {
    const xssPayload = '<script>window.__xss=1</script><img src=x onerror=alert(1)>';
    const xssReport = makePublicReport({
      title: `ROI ${xssPayload}`,
      brandName: `Brand ${xssPayload}`,
      category: `Cat ${xssPayload}`,
      whiteLabelOrg: `Agency ${xssPayload}`,
      summary: {
        ...makePublicReport().summary,
        channelRanking: [
          {
            ...makePublicReport().summary.channelRanking[0]!,
            channel: `Channel ${xssPayload}`,
          },
        ],
      },
    });
    vi.spyOn(reportsApi, 'fetchPublicRoiReport').mockResolvedValueOnce(xssReport);

    const { container } = render(<PublicRoiReportView token="tok_xss_1234567890" />);
    await screen.findByTestId('public-roi-header');

    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByTestId('public-roi-title').textContent).toContain(xssPayload);
    expect(screen.getByTestId('public-roi-whitelabel-badge').textContent).toContain(xssPayload);
  });

  it('fetches public endpoint with credentials=omit and no Authorization header even when sessionStorage holds a token', async () => {
    window.sessionStorage.setItem('geomix.accessToken', 'secret_console_token_should_never_leak');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: makePublicReport() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(<PublicRoiReportView token="tok_unauth_123456" />);
    await screen.findByTestId('public-roi-header');

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('enforces dark-ink contrast on all descendants, light Tag/Pill surfaces, and table pagination in @media print', async () => {
    const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
    const printIdx = css.indexOf('@media print');
    expect(printIdx).toBeGreaterThan(-1);
    const printBlock = css.slice(printIdx);

    // 1. Dark ink (#0f172a !important) applied across all descendants including div
    expect(printBlock).toMatch(
      /\.gm-public-roi-report\s+\*[\s\S]*?\.gm-public-roi-report\s+div[\s\S]*?color:\s*#0f172a\s*!important;/,
    );

    // 2. Light print-safe surfaces on .ant-tag, .gm-pill, .ant-alert, and low-sample hint
    expect(printBlock).toMatch(
      /\.gm-public-roi-report\s+\.ant-tag,[\s\S]*?\.gm-public-roi-report\s+\.gm-pill,[\s\S]*?\.gm-public-roi-report\s+\.ant-alert,[\s\S]*?\[data-testid='public-roi-low-sample-hint'\]\s*\{[\s\S]*?background:\s*#f1f5f9\s*!important;[\s\S]*?border-color:\s*#cbd5e1\s*!important;[\s\S]*?color:\s*#0f172a\s*!important;/,
    );

    // 3. Multi-row table sections allow page breaks while thead repeats and tr/cards stay intact
    const sectionRuleMatch = printBlock.match(
      /\.gm-public-roi-report\s+\.gm-panel,\s*\.gm-public-roi-report\s+\.gm-roi-print-section,\s*\.gm-public-roi-report\s+\.gm-roi-print-card\s*\{[^}]*\}/,
    );
    expect(sectionRuleMatch).not.toBeNull();
    expect(sectionRuleMatch?.[0]).not.toContain('break-inside: avoid');
    expect(printBlock).toMatch(
      /\.gm-public-roi-report\s+\.gm-roi-print-table-section\s*\{[\s\S]*?break-inside:\s*auto;/,
    );
    expect(printBlock).toMatch(
      /\.gm-public-roi-report\s+thead\s*\{[\s\S]*?display:\s*table-header-group;/,
    );
    expect(printBlock).toMatch(/\.gm-public-roi-report\s+tr\s*\{[\s\S]*?break-inside:\s*avoid;/);

    // 4. Rendered DOM attaches table-section class (not print-keep) to all 3 table sections
    vi.spyOn(reportsApi, 'fetchPublicRoiReport').mockResolvedValueOnce(makePublicReport());
    render(<PublicRoiReportView token="tok_print_check_123456" />);
    await screen.findByTestId('public-roi-header');

    expect(screen.getByTestId('public-roi-header').className).toContain('gm-roi-print-keep');
    expect(screen.getByTestId('public-roi-overview').className).toContain('gm-roi-print-keep');
    for (const tableTestId of [
      'public-roi-engines',
      'public-roi-channels',
      'public-roi-milestones',
    ]) {
      const el = screen.getByTestId(tableTestId);
      expect(el.className).toContain('gm-roi-print-table-section');
      expect(el.className).not.toContain('gm-roi-print-keep');
    }
  });
});
