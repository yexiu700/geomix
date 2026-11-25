// @vitest-environment jsdom
import type { GeoRoiReportRecordDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ModalFuncProps } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as reportsApi from '../../lib/reports';
import * as studioLib from '../../lib/studio';
import * as freshnessLib from '../../lib/tab-freshness';
import * as uxFoundation from '../../lib/ux-foundation';
import { HomeRoiReportModal } from './home-roi-report-modal';

const mockConfirm = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyWarning = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: mockConfirm,
    notifySuccess: mockNotifySuccess,
    notifyWarning: mockNotifyWarning,
    notifyError: mockNotifyError,
  }),
}));

function makeReport(overrides?: Partial<GeoRoiReportRecordDto>): GeoRoiReportRecordDto {
  return {
    id: 'rep_1',
    brandId: 'brand_1',
    brandMarketId: 'bm_global_1',
    market: 'GLOBAL',
    title: 'AstraVault October 2026 GEO ROI Report',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-31T23:59:59.999Z',
    locale: 'en-US',
    whiteLabelOrg: 'Acme Growth Agency',
    summary: {
      version: 1,
      overview: {
        totalObservations: 40,
        mentionHits: 28,
        mentionRate: 0.7,
        mentionWilson: {
          hits: 28,
          trials: 40,
          rate: 0.7,
          lower: 0.5457,
          upper: 0.8193,
          halfWidth: 0.1368,
          z: 1.96,
          confidenceLevel: 'HIGH',
        },
        citationHits: 16,
        citationRate: 0.4,
        ownedCitationHits: 10,
        ownedCitationRate: 0.25,
        confidenceLevel: 'HIGH',
        did: {
          treatmentDelta: 0.3,
          controlDelta: 0.05,
          netLift: 0.25,
          direction: 'POSITIVE',
        },
      },
      byEngine: [],
      nearMiss: {
        totalOpportunities: 12,
        boostBriefsCreated: 5,
        convertedToCited: 3,
        tierCounts: {
          OPENED_NOT_CITED: 4,
          RETRIEVED_NOT_CITED: 3,
          CRAWLED_NOT_CITED: 3,
          MENTIONED_NOT_OWNED: 2,
        },
      },
      funnel: {
        publishedTotal: 8,
        l1Count: 5,
        l2Count: 2,
        l3Count: 1,
        crawlCheckedCount: 8,
        crawlOkCount: 7,
        crawlOkRate: 0.875,
        indexNowAttemptedCount: 5,
        indexNowSuccessCount: 4,
        indexNowRate: 0.8,
      },
      channelRanking: [],
      milestoneTrend: [],
    },
    shareActive: false,
    shareExpiresAt: null,
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedAt: '2026-11-01T02:00:00.000Z',
    ...overrides,
  };
}

describe('HomeRoiReportModal (#372)', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyWarning.mockReset();
    mockNotifyError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads reports, displays UTC calendar dates without +8h shift, validates date range, and generates a report', async () => {
    const existing = makeReport();
    const created = makeReport({
      id: 'rep_2',
      title: 'Q4 Executive ROI',
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-11-24T23:59:59.999Z',
      whiteLabelOrg: 'Northstar Partners',
    });

    vi.spyOn(reportsApi, 'fetchGeoRoiReports').mockResolvedValueOnce({ items: [existing] });
    const createSpy = vi.spyOn(reportsApi, 'createGeoRoiReport').mockResolvedValueOnce(created);
    const invalidateSpy = vi.spyOn(freshnessLib, 'invalidateFreshness');

    render(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    const detail = await screen.findByTestId('roi-report-detail-card');
    // 2026-10-31T23:59:59.999Z MUST render as 2026-10-31, NOT 2026-11-01
    expect(detail.textContent).toContain('2026-10-01 至 2026-10-31');
    expect(detail.textContent).toContain('+25.0pp');
    // Never render literal "0 点"
    expect(document.body.textContent ?? '').not.toMatch(/(?:^|[^\d])0\s*点/);

    // Invalid date range shows inline error without hitting API
    fireEvent.change(screen.getByTestId('roi-report-period-start'), {
      target: { value: '2026-11-20' },
    });
    fireEvent.change(screen.getByTestId('roi-report-period-end'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.click(screen.getByTestId('roi-report-generate-btn'));
    expect(screen.getByTestId('roi-report-form-error').textContent).toContain(
      '开始日期不能晚于结束日期',
    );
    expect(createSpy).not.toHaveBeenCalled();

    // Valid generate submission
    fireEvent.change(screen.getByTestId('roi-report-period-start'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByTestId('roi-report-period-end'), {
      target: { value: '2026-11-24' },
    });
    fireEvent.change(screen.getByTestId('roi-report-locale'), {
      target: { value: 'en-US' },
    });
    fireEvent.change(screen.getByTestId('roi-report-whitelabel'), {
      target: { value: 'Northstar Partners' },
    });
    fireEvent.change(screen.getByTestId('roi-report-title'), {
      target: { value: 'Q4 Executive ROI' },
    });
    fireEvent.click(screen.getByTestId('roi-report-generate-btn'));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('brand_1', {
        market: 'GLOBAL',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-24',
        locale: 'en-US',
        whiteLabelOrg: 'Northstar Partners',
        title: 'Q4 Executive ROI',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith('roi-reports');
    expect(screen.getByTestId('roi-report-item-rep_2')).toBeTruthy();
    expect(mockNotifySuccess).toHaveBeenCalledWith('月度 GEO ROI 报告已生成');
  });

  it('downloads standalone HTML via triggerBlobDownload, prints PDF, creates/copies share link, and revokes via useUxFeedback().confirm', async () => {
    const existing = makeReport();
    vi.spyOn(reportsApi, 'fetchGeoRoiReports').mockResolvedValueOnce({ items: [existing] });

    const htmlPayload = '<!DOCTYPE html><html><body>ROI</body></html>';
    const exportSpy = vi.spyOn(reportsApi, 'exportGeoRoiReportHtml').mockResolvedValue({
      blob: new Blob([htmlPayload], { type: 'text/html; charset=utf-8' }),
      html: htmlPayload,
      filename: 'astravault-roi-2026-10.html',
      mime: 'text/html; charset=utf-8',
    });
    const downloadSpy = vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);
    const printSpy = vi.spyOn(reportsApi, 'printStandaloneReportHtml').mockReturnValue(true);
    const shareSpy = vi.spyOn(reportsApi, 'createGeoRoiReportShare').mockResolvedValue({
      reportId: 'rep_1',
      token: 'tok_live_share_999',
      sharePath: '/share/report/tok_live_share_999',
      shareUrl: 'https://app.geomix.example/share/report/tok_live_share_999',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const revokeSpy = vi.spyOn(reportsApi, 'revokeGeoRoiReportShare').mockResolvedValue({
      reportId: 'rep_1',
      revoked: true,
      revokedAt: '2026-11-24T12:00:00.000Z',
    });
    const copySpy = vi.spyOn(studioLib, 'copyTextToClipboard').mockResolvedValue(true);
    const invalidateSpy = vi.spyOn(freshnessLib, 'invalidateFreshness');

    render(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId('roi-report-detail-card');

    // 1. Download standalone HTML
    fireEvent.click(screen.getByTestId('roi-report-download-html-btn'));
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith('rep_1');
      expect(downloadSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'astravault-roi-2026-10.html',
          mime: 'text/html; charset=utf-8',
        }),
      );
    });

    // 2. Print / Save PDF
    fireEvent.click(screen.getByTestId('roi-report-print-pdf-btn'));
    await waitFor(() => {
      expect(printSpy).toHaveBeenCalledWith(htmlPayload);
    });

    // 3. Create & copy share link
    fireEvent.click(screen.getByTestId('roi-report-share-btn'));
    await waitFor(() => {
      expect(shareSpy).toHaveBeenCalledWith('rep_1', { ttlDays: 30 });
      expect(screen.getByTestId('roi-report-share-box')).toBeTruthy();
    });
    const expectedUrl = `${window.location.origin}/share/report/tok_live_share_999`;
    expect(screen.getByTestId('roi-report-share-url').textContent).toBe(expectedUrl);
    expect(copySpy).toHaveBeenCalledWith(expectedUrl);
    expect(invalidateSpy).toHaveBeenCalledWith('roi-reports');

    // Copy button copies again
    fireEvent.click(screen.getByTestId('roi-report-copy-share-btn'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(2);
    });

    // 4. Revoke gated by useUxFeedback().confirm(...)
    fireEvent.click(screen.getByTestId('roi-report-revoke-share-btn'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(revokeSpy).not.toHaveBeenCalled();

    const confirmArgs = mockConfirm.mock.calls[0]?.[0] as ModalFuncProps;
    await confirmArgs.onOk?.();

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith('rep_1');
      expect(screen.queryByTestId('roi-report-share-box')).toBeNull();
    });
    expect(invalidateSpy).toHaveBeenCalledWith('roi-reports');
  });

  it('gates write actions in readOnly mode while still allowing HTML download and PDF print', async () => {
    vi.spyOn(reportsApi, 'fetchGeoRoiReports').mockResolvedValueOnce({
      items: [makeReport({ shareActive: true, shareExpiresAt: '2026-12-01T00:00:00.000Z' })],
    });

    render(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="CN"
        readOnly
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId('roi-report-detail-card');
    expect((screen.getByTestId('roi-report-generate-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('roi-report-share-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('roi-report-revoke-share-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('roi-report-download-html-btn') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId('roi-report-print-pdf-btn') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByTestId('roi-report-share-active-notice')).toBeTruthy();
  });

  it('guards non-finite counters (NaN / Infinity) without ever rendering literal NaN or Infinity in modal DOM', async () => {
    const base = makeReport();
    const corrupted = makeReport({
      id: 'rep_nonfinite',
      title: 'Stress Report',
      summary: {
        ...base.summary,
        overview: {
          ...base.summary.overview,
          mentionRate: Number.NaN,
          mentionWilson: {
            ...base.summary.overview.mentionWilson,
            lower: Number.NaN,
            upper: Number.POSITIVE_INFINITY,
            trials: Number.NaN,
          },
          did: {
            treatmentDelta: Number.NaN,
            controlDelta: Number.NEGATIVE_INFINITY,
            netLift: Number.NaN,
            direction: 'NEUTRAL',
          },
        },
        nearMiss: {
          ...base.summary.nearMiss,
          convertedToCited: Number.NaN,
          totalOpportunities: Number.NEGATIVE_INFINITY,
          boostBriefsCreated: Number.POSITIVE_INFINITY,
        },
        funnel: {
          ...base.summary.funnel,
          publishedTotal: Number.NaN,
          crawlOkRate: Number.POSITIVE_INFINITY,
        },
      },
    });
    vi.spyOn(reportsApi, 'fetchGeoRoiReports').mockResolvedValueOnce({ items: [corrupted] });

    render(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="CN"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    const detail = await screen.findByTestId('roi-report-detail-card');
    const modalText = document.body.textContent ?? '';
    expect(modalText).not.toContain('NaN');
    expect(modalText).not.toContain('Infinity');
    expect(detail.textContent).toContain('n=—');
    expect(detail.textContent).toContain('— / —');
    expect(detail.textContent).toContain('已建补强卡 — 张');
    expect(detail.textContent).toContain('— 篇');
  });

  it('Tier 5 regression: clears cached plaintext share URL on modal close/reopen and resets in-flight generating lock on brandId/market switch', async () => {
    const baseRep = makeReport({ id: 'rep_secret_1', shareActive: false, shareExpiresAt: null });
    const sharedRep = makeReport({
      id: 'rep_secret_1',
      shareActive: true,
      shareExpiresAt: '2026-12-23T08:00:00.000Z',
    });

    const fetchSpy = vi
      .spyOn(reportsApi, 'fetchGeoRoiReports')
      .mockResolvedValueOnce({ items: [baseRep] })
      .mockResolvedValueOnce({ items: [sharedRep] })
      .mockResolvedValueOnce({ items: [] });

    vi.spyOn(reportsApi, 'createGeoRoiReportShare').mockResolvedValueOnce({
      reportId: 'rep_secret_1',
      token: 'tok_once_only_secret_999',
      sharePath: '/share/report/tok_once_only_secret_999',
      shareUrl: 'https://app.geomix.example/share/report/tok_once_only_secret_999',
      expiresAt: '2026-12-23T08:00:00.000Z',
    });
    vi.spyOn(studioLib, 'copyTextToClipboard').mockResolvedValue(true);

    let resolvePendingCreate!: (val: GeoRoiReportRecordDto) => void;
    vi.spyOn(reportsApi, 'createGeoRoiReport').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingCreate = resolve;
        }),
    );

    let resolvePendingExport!: (val: {
      filename: string;
      mime: string;
      html: string;
      blob: Blob;
    }) => void;
    vi.spyOn(reportsApi, 'exportGeoRoiReportHtml').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingExport = resolve;
        }),
    );
    const downloadSpy = vi.spyOn(uxFoundation, 'triggerBlobDownload').mockReturnValue(true);

    const { rerender } = render(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId('roi-report-detail-card');

    // (a) Generate one-time plaintext share link, then close and reopen on same brand/market
    fireEvent.click(screen.getByTestId('roi-report-share-btn'));
    expect(await screen.findByTestId('roi-report-share-url')).toBeTruthy();

    // Also start an in-flight HTML export before closing
    fireEvent.click(screen.getByTestId('roi-report-download-html-btn'));

    rerender(
      <HomeRoiReportModal
        open={false}
        brandId="brand_1"
        brandName="AstraVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    // Resolve stale export while modal is closed -> MUST NOT trigger download
    resolvePendingExport({
      filename: 'stale.html',
      mime: 'text/html; charset=utf-8',
      html: '<html>stale</html>',
      blob: new Blob(['<html>stale</html>']),
    });
    await Promise.resolve();
    expect(downloadSpy).not.toHaveBeenCalled();

    // Reopen on same brand/market -> plaintext URL MUST be cleared and active notice shown
    rerender(
      <HomeRoiReportModal
        open
        brandId="brand_1"
        brandName="AstraVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('roi-report-share-active-notice')).toBeTruthy();
    });
    expect(screen.queryByTestId('roi-report-share-box')).toBeNull();
    expect(screen.queryByTestId('roi-report-share-url')).toBeNull();

    // (b) Start createGeoRoiReport on brand_1, switch to brand_2 while pending -> button MUST NOT stay disabled
    fireEvent.click(screen.getByTestId('roi-report-generate-btn'));
    expect((screen.getByTestId('roi-report-generate-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <HomeRoiReportModal
        open
        brandId="brand_2"
        brandName="NordVault"
        market="GLOBAL"
        readOnly={false}
        onClose={vi.fn()}
      />,
    );

    // Resolve stale brand_1 create after switching to brand_2
    resolvePendingCreate(makeReport({ id: 'rep_stale_brand1' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect((screen.getByTestId('roi-report-generate-btn') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(screen.queryByTestId('roi-report-item-rep_stale_brand1')).toBeNull();
  });
});
