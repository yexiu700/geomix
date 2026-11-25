'use client';

import {
  API_ERROR,
  type CreateGeoRoiReportInput,
  type CreateGeoRoiReportShareInput,
  type GeoMarket,
  type GeoRoiReportRecordDto,
  type GeoRoiReportShareResultDto,
  type PublicGeoRoiReportDto,
} from '@geomix/shared';
import { authorizedV2RawRequest, authorizedV2Request } from './api';
import { GatewayApiError, unwrapEnvelope } from './envelope';
import { apiV2Base, type SessionStorageLike } from './session';
import { parseExportFilename } from './studio';

export type ReportsClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type FetchGeoRoiReportsParams = {
  market?: GeoMarket;
  limit?: number;
};

export type GeoRoiReportListResponse = {
  items: GeoRoiReportRecordDto[];
};

export type GeoRoiReportShareCreatedDto = GeoRoiReportShareResultDto & {
  token: string;
};

export type GeoRoiReportRevokeShareResultDto = {
  reportId: string;
  revoked: true;
  revokedAt: string;
};

export type ExportedRoiReportHtml = {
  blob: Blob;
  html: string;
  filename: string;
  mime: string;
};

export function createGeoRoiReport(
  brandId: string,
  input: CreateGeoRoiReportInput,
  options?: ReportsClientOptions,
): Promise<GeoRoiReportRecordDto> {
  return authorizedV2Request<GeoRoiReportRecordDto>(
    `/brands/${encodeURIComponent(brandId)}/roi-reports`,
    {
      method: 'POST',
      body: input,
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function fetchGeoRoiReports(
  brandId: string,
  params?: FetchGeoRoiReportsParams,
  options?: ReportsClientOptions,
): Promise<GeoRoiReportListResponse> {
  const query = new URLSearchParams();
  if (params?.market) query.set('market', params.market);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  const path = `/brands/${encodeURIComponent(brandId)}/roi-reports${qs ? `?${qs}` : ''}`;

  return authorizedV2Request<GeoRoiReportListResponse>(path, {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function fetchGeoRoiReport(
  reportId: string,
  options?: ReportsClientOptions,
): Promise<GeoRoiReportRecordDto> {
  return authorizedV2Request<GeoRoiReportRecordDto>(
    `/roi-reports/${encodeURIComponent(reportId)}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export async function exportGeoRoiReportHtml(
  reportId: string,
  options?: ReportsClientOptions,
): Promise<ExportedRoiReportHtml> {
  const response = await authorizedV2RawRequest(
    `/roi-reports/${encodeURIComponent(reportId)}/export.html`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      await unwrapEnvelope(response);
    }
    throw new GatewayApiError(response.status, API_ERROR.BAD_REQUEST, '导出 ROI 报告失败');
  }

  const html = await response.text();
  const mime = response.headers.get('content-type') || 'text/html; charset=utf-8';
  const blob = new Blob([html], { type: mime });
  const fallbackSuffix = reportId.slice(-6) || 'export';
  const filename = parseExportFilename(
    response.headers.get('content-disposition'),
    `geo-roi-report-${fallbackSuffix}.html`,
  );
  return { blob, html, filename, mime };
}

export function createGeoRoiReportShare(
  reportId: string,
  input?: CreateGeoRoiReportShareInput,
  options?: ReportsClientOptions,
): Promise<GeoRoiReportShareCreatedDto> {
  return authorizedV2Request<GeoRoiReportShareCreatedDto>(
    `/roi-reports/${encodeURIComponent(reportId)}/share`,
    {
      method: 'POST',
      body: input ?? {},
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export function revokeGeoRoiReportShare(
  reportId: string,
  options?: ReportsClientOptions,
): Promise<GeoRoiReportRevokeShareResultDto> {
  return authorizedV2Request<GeoRoiReportRevokeShareResultDto>(
    `/roi-reports/${encodeURIComponent(reportId)}/share`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

/**
 * Unauthenticated public share fetch — NEVER reads console sessionStorage or sends Authorization headers.
 */
export async function fetchPublicRoiReport(
  token: string,
  options?: { signal?: AbortSignal; apiBaseUrl?: string },
): Promise<PublicGeoRoiReportDto> {
  const base = (options?.apiBaseUrl?.trim() || apiV2Base()).replace(/\/+$/, '');
  const response = await fetch(`${base}/public/roi-reports/${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: options?.signal,
  });
  return unwrapEnvelope<PublicGeoRoiReportDto>(response);
}

/**
 * Pure UTC calendar date formatter (YYYY-MM-DD).
 * Avoids +08:00 next-day shift on UTC end-of-day timestamps like YYYY-MM-DDT23:59:59.999Z.
 */
export function formatUtcCalendarDate(
  input: string | Date | number | null | undefined,
  fallback = '—',
): string {
  if (input === null || input === undefined || input === '') return fallback;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return fallback;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Pure UTC date-time formatter (YYYY-MM-DD HH:mm UTC) for English public reports (zero CJK).
 */
export function formatUtcDateTime(
  input: string | Date | number | null | undefined,
  fallback = '—',
): string {
  if (input === null || input === undefined || input === '') return fallback;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return fallback;
  const calendar = formatUtcCalendarDate(date, fallback);
  if (calendar === fallback) return fallback;
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${calendar} ${hours}:${minutes} UTC`;
}

/**
 * Build default 30-day UTC reporting window [today - 29d, today].
 */
export function buildDefaultRoiPeriod(referenceDate: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const endUtc = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    ),
  );
  const startUtc = new Date(endUtc.getTime() - 29 * 24 * 60 * 60 * 1000);
  return {
    periodStart: formatUtcCalendarDate(startUtc),
    periodEnd: formatUtcCalendarDate(endUtc),
  };
}

/**
 * Prefer current browser origin + sharePath when available so local dev / dynamic ports resolve cleanly.
 */
export function resolveShareAbsoluteUrl(
  share: Pick<GeoRoiReportShareResultDto, 'sharePath' | 'shareUrl'>,
): string {
  if (
    typeof window !== 'undefined' &&
    window.location?.origin &&
    share.sharePath &&
    share.sharePath.startsWith('/') &&
    !share.sharePath.startsWith('//')
  ) {
    return `${window.location.origin}${share.sharePath}`;
  }
  return share.shareUrl;
}

/**
 * Print standalone self-contained ROI HTML report without creating Blob URLs (zero URL.revokeObjectURL).
 */
export function printStandaloneReportHtml(html: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  try {
    const popup = window.open('', '_blank');
    if (popup && popup.document) {
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      try {
        popup.opener = null;
      } catch {
        // Ignore read-only opener in restricted environments
      }
      popup.focus();
      popup.print();
      return true;
    }
  } catch {
    // Fall through to hidden iframe printing when pop-up is blocked
  }

  try {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';

    const cleanup = () => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    };

    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        if (win) {
          win.addEventListener?.('afterprint', cleanup, { once: true });
          win.focus();
          win.print();
        }
      } finally {
        window.setTimeout(cleanup, 3000);
      }
    };

    iframe.srcdoc = html;
    document.body.appendChild(iframe);
    return true;
  } catch {
    return false;
  }
}
