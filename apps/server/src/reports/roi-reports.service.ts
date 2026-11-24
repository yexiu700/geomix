import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  DEFAULT_ROI_REPORT_SHARE_TTL_DAYS,
  normalizeVisibilityDomain,
  resolveEffectiveLocale,
  type GeoMarket,
  type GeoRoiReportRecordDto,
  type GeoRoiReportShareResultDto,
  type ParsedCreateGeoRoiReportInput,
  type SupportedLocale,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readRoiReportExportRateLimit,
  readRoiReportShareRateLimit,
} from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildGeoRoiReportSummary,
  buildSafeRoiReportExportFilename,
  formatUtcDate,
  parseStoredSummaryJson,
  presentGeoRoiReport,
  resolvePublicAppUrl,
  type RoiReportBoostBriefInput,
  type RoiReportCompletedScheduleInput,
  type RoiReportObservationInput,
  type RoiReportPointLogInput,
  type RoiReportPublishRecordInput,
  type RoiReportRetrievedSourceInput,
} from './roi-report-aggregator';
import { RoiReportHtmlRenderer } from './roi-report-html.renderer';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const POINT_ROI_ACTIONS = [
  'geo_write',
  'visibility_check',
  'inline_image_gen',
  'geo_variant',
] as const;

export type RoiReportsAuthContext = {
  tenantId: string;
  userId?: string;
};

export type RoiReportShareCreatedDto = GeoRoiReportShareResultDto & {
  token: string;
};

export type RoiReportRevokeShareResultDto = {
  reportId: string;
  revoked: true;
  revokedAt: string;
};

export type RoiReportHtmlExportPayload = {
  buffer: Buffer;
  filename: string;
  contentDisposition: string;
};

function parsePeriodBoundary(raw: string, bound: 'start' | 'end'): Date {
  const trimmed = raw.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    return new Date(`${trimmed}${bound === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`);
  }
  return new Date(trimmed);
}

function buildDefaultReportTitle(
  brandName: string,
  periodStart: Date,
  periodEnd: Date,
  locale: SupportedLocale,
): string {
  const startYmd = formatUtcDate(periodStart);
  const endYmd = formatUtcDate(periodEnd);
  const raw =
    locale === 'zh-CN'
      ? `${brandName} GEO 增长复盘报告（${startYmd} ~ ${endYmd}）`
      : `${brandName} Monthly GEO ROI Report (${startYmd} - ${endYmd})`;
  return raw.slice(0, 120);
}

/**
 * 月度 GEO ROI 报告鉴权服务（Issue #369）：
 * - 100% 使用 prisma.scoped 实现严格租户隔离（ZERO prisma.base）
 * - 0 点数消耗，受 roi_report_export / roi_report_share 免费动作限流保护
 * - 创建时生成并持久化不可变 summaryJson 快照，后续查询/导出/分享只读不重算
 */
@Injectable()
export class RoiReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Inject(RoiReportHtmlRenderer) private readonly htmlRenderer: RoiReportHtmlRenderer,
    @Optional()
    @Inject(FreeActionRateLimiter)
    private readonly rateLimiter?: FreeActionRateLimiter,
  ) {}

  async createReport(
    brandId: string,
    input: ParsedCreateGeoRoiReportInput,
    auth: RoiReportsAuthContext,
    queryMarket?: GeoMarket,
  ): Promise<GeoRoiReportRecordDto> {
    this.rateLimiter?.assertAllowed(
      'roi_report_export',
      auth.tenantId,
      readRoiReportExportRateLimit(),
    );

    if (queryMarket && input.market && queryMarket !== input.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数与请求体中的市场配置不一致');
    }
    const effectiveMarket = input.market ?? queryMarket;
    const { brand, market } = await this.brands.resolveBrandMarket(brandId, effectiveMarket);

    const periodStart = parsePeriodBoundary(input.periodStart, 'start');
    const periodEnd = parsePeriodBoundary(input.periodEnd, 'end');
    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime()) ||
      periodStart.getTime() > periodEnd.getTime()
    ) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '开始时间不能晚于结束时间');
    }

    const marketCode: GeoMarket = market.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const locale = resolveEffectiveLocale(input.locale ?? market.locale, marketCode);
    const brandDisplayName = market.localBrandName?.trim() || brand.name;
    const title = input.title?.trim()
      ? input.title.trim().slice(0, 120)
      : buildDefaultReportTitle(brandDisplayName, periodStart, periodEnd, locale);
    const whiteLabelOrg = input.whiteLabelOrg ?? null;

    const scoped = this.prisma.scoped as unknown as Record<string, unknown>;
    const callOptionalFindMany = async <T>(
      delegateName: string,
      args: Record<string, unknown>,
    ): Promise<T[]> => {
      const delegate = scoped[delegateName] as
        { findMany?: (a: Record<string, unknown>) => Promise<T[]> } | undefined;
      if (typeof delegate?.findMany !== 'function') {
        return [];
      }
      return delegate.findMany(args);
    };

    const [
      brandMarkets,
      observations,
      uncitedRetrievedSources,
      nearMissBoostBriefs,
      periodPublishRecords,
      periodCompletedSchedules,
      pointLogs,
      brandRuns,
      brandArticles,
      brandBatchJobs,
      brandVariantJobs,
      brandDistTasks,
    ] = await Promise.all([
      callOptionalFindMany<{ ownedDomains: string[] }>('brandMarket', {
        where: { brandId: brand.id },
        select: { ownedDomains: true },
      }),
      callOptionalFindMany<RoiReportObservationInput>('visibilityObservation', {
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          status: 'SUCCESS',
          OR: [
            { checkedAt: { gte: periodStart, lte: periodEnd } },
            { checkedAt: null, createdAt: { gte: periodStart, lte: periodEnd } },
          ],
        },
        include: {
          citations: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              url: true,
              domain: true,
              sourceKind: true,
              position: true,
            },
          },
        },
        orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
      }),
      callOptionalFindMany<RoiReportRetrievedSourceInput>('visibilityRetrievedSource', {
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          wasCited: false,
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        select: {
          id: true,
          observationId: true,
          url: true,
          wasOpened: true,
          wasCited: true,
          observation: {
            select: {
              status: true,
            },
          },
        },
      }),
      callOptionalFindMany<RoiReportBoostBriefInput>('geoBrief', {
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          sourceType: 'NEAR_MISS_BOOST',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        select: {
          id: true,
          sourceCitationUrl: true,
          targetPrompt: true,
          createdAt: true,
          articles: {
            select: {
              id: true,
              publishRecords: {
                select: {
                  id: true,
                  publishedUrl: true,
                  afterMetrics: true,
                  retestSchedules: {
                    where: { status: 'COMPLETED' },
                    select: {
                      metricsSnapshotJson: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      callOptionalFindMany<RoiReportPublishRecordInput>('geoPublishRecord', {
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          publishedAt: { gte: periodStart, lte: periodEnd },
        },
        include: {
          distributionTask: {
            select: {
              id: true,
              provider: true,
              mode: true,
              indexNowStatus: true,
            },
          },
          retestSchedules: {
            where: { status: 'COMPLETED' },
            orderBy: [{ executedAt: 'desc' }, { milestoneDay: 'desc' }, { id: 'desc' }],
          },
        },
      }),
      callOptionalFindMany<RoiReportCompletedScheduleInput>('geoRetestSchedule', {
        where: {
          brandId: brand.id,
          brandMarketId: market.id,
          status: 'COMPLETED',
          OR: [
            { executedAt: { gte: periodStart, lte: periodEnd } },
            { executedAt: null, updatedAt: { gte: periodStart, lte: periodEnd } },
          ],
        },
        include: {
          publishRecord: {
            select: {
              id: true,
              channel: true,
              publishedUrl: true,
              crawlStatus: true,
              beforeMetrics: true,
              afterMetrics: true,
              distributionTask: {
                select: {
                  provider: true,
                  mode: true,
                },
              },
            },
          },
        },
      }),
      callOptionalFindMany<RoiReportPointLogInput>('pointLog', {
        where: {
          status: 'SETTLED',
          action: { in: [...POINT_ROI_ACTIONS] },
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        select: {
          action: true,
          unitKey: true,
          delta: true,
          listPrice: true,
          detail: true,
          reservationId: true,
        },
      }),
      callOptionalFindMany<{ id: string; reservationId: string | null }>('visibilityRun', {
        where: { brandId: brand.id, brandMarketId: market.id },
        select: { id: true, reservationId: true },
      }),
      callOptionalFindMany<{ id: string }>('geoArticle', {
        where: { brandId: brand.id, brandMarketId: market.id },
        select: { id: true },
      }),
      callOptionalFindMany<{ reservationId: string | null }>('geoBatchJob', {
        where: { brandId: brand.id, brandMarketId: market.id },
        select: { reservationId: true },
      }),
      callOptionalFindMany<{ reservationId: string | null }>('geoVariantJob', {
        where: { brandId: brand.id, brandMarketId: market.id },
        select: { reservationId: true },
      }),
      callOptionalFindMany<{ id: string }>('geoDistributionTask', {
        where: { brandId: brand.id, brandMarketId: market.id },
        select: { id: true },
      }),
    ]);

    const allBrandOwnedDomains: string[] = [];
    for (const bm of brandMarkets) {
      for (const domain of bm.ownedDomains ?? []) {
        const normalized = normalizeVisibilityDomain(domain);
        if (normalized) allBrandOwnedDomains.push(normalized);
      }
    }

    const reservationIds = new Set<string>();
    const runIds = new Set<string>();
    for (const run of brandRuns) {
      runIds.add(run.id);
      if (run.reservationId) reservationIds.add(run.reservationId);
    }
    for (const batch of brandBatchJobs) {
      if (batch.reservationId) reservationIds.add(batch.reservationId);
    }
    for (const vj of brandVariantJobs) {
      if (vj.reservationId) reservationIds.add(vj.reservationId);
    }

    const observationIds = new Set(observations.map((o) => o.id));
    const articleIds = new Set(brandArticles.map((a) => a.id));
    const taskIds = new Set(brandDistTasks.map((t) => t.id));

    const summary = buildGeoRoiReportSummary({
      brandMarket: {
        localBrandName: brandDisplayName,
        aliases: market.aliases ?? [],
        ownedDomains: market.ownedDomains ?? [],
        competitors: market.competitors,
      },
      allBrandOwnedDomains,
      observations,
      uncitedRetrievedSources,
      nearMissBoostBriefs,
      periodPublishRecords,
      periodCompletedSchedules,
      pointLogs,
      attributionScope: {
        brandId: brand.id,
        brandMarketId: market.id,
        reservationIds,
        runIds,
        observationIds,
        articleIds,
        taskIds,
      },
    });

    const created = await this.prisma.scoped.geoRoiReport.create({
      data: {
        tenantId: auth.tenantId,
        brandId: brand.id,
        brandMarketId: market.id,
        title,
        periodStart,
        periodEnd,
        locale,
        whiteLabelOrg,
        summaryJson: summary as unknown as Prisma.InputJsonValue,
        createdByUserId: auth.userId ?? null,
      },
    });

    return presentGeoRoiReport(created, marketCode);
  }

  async listReports(
    brandId: string,
    opts?: { market?: GeoMarket; limit?: number },
  ): Promise<{ items: GeoRoiReportRecordDto[] }> {
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));

    let where: Prisma.GeoRoiReportWhereInput;
    if (opts?.market) {
      const { brand, market } = await this.brands.resolveBrandMarket(brandId, opts.market);
      where = { brandId: brand.id, brandMarketId: market.id };
    } else {
      const brand = await this.brands.getById(brandId);
      where = { brandId: brand.id };
    }

    const rows = await this.prisma.scoped.geoRoiReport.findMany({
      where,
      include: {
        brandMarket: {
          select: {
            market: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return {
      items: rows.map((row) => presentGeoRoiReport(row)),
    };
  }

  async getReport(reportId: string): Promise<GeoRoiReportRecordDto> {
    const row = await this.prisma.scoped.geoRoiReport.findFirst({
      where: { id: reportId },
      include: {
        brandMarket: {
          select: {
            market: true,
          },
        },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'ROI 报告不存在或无权访问');
    }

    return presentGeoRoiReport(row);
  }

  async exportReportHtml(
    reportId: string,
    auth: RoiReportsAuthContext,
  ): Promise<RoiReportHtmlExportPayload> {
    this.rateLimiter?.assertAllowed(
      'roi_report_export',
      auth.tenantId,
      readRoiReportExportRateLimit(),
    );

    const row = await this.prisma.scoped.geoRoiReport.findFirst({
      where: { id: reportId },
      include: {
        brand: {
          select: {
            name: true,
            category: true,
          },
        },
        brandMarket: {
          select: {
            market: true,
            locale: true,
            localBrandName: true,
            localCategory: true,
          },
        },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'ROI 报告不存在或无权访问');
    }

    const market: GeoMarket = row.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
    const locale = resolveEffectiveLocale(row.locale || row.brandMarket.locale, market);
    const storedSummary = parseStoredSummaryJson(row.summaryJson);

    const html = this.htmlRenderer.render({
      title: row.title,
      brandName: row.brandMarket.localBrandName?.trim() || row.brand.name,
      category: row.brandMarket.localCategory?.trim() || row.brand.category,
      market,
      locale,
      whiteLabelOrg: row.whiteLabelOrg ?? null,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      generatedAt: row.createdAt,
      summary: storedSummary,
      includePointsRoi: true,
    });

    const { filename, contentDisposition } = buildSafeRoiReportExportFilename(row.title, row.id);
    return {
      buffer: Buffer.from(html, 'utf8'),
      filename,
      contentDisposition,
    };
  }

  async createShareLink(
    reportId: string,
    input: { ttlDays?: number },
    auth: RoiReportsAuthContext,
  ): Promise<RoiReportShareCreatedDto> {
    this.rateLimiter?.assertAllowed(
      'roi_report_share',
      auth.tenantId,
      readRoiReportShareRateLimit(),
    );

    const report = await this.prisma.scoped.geoRoiReport.findFirst({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'ROI 报告不存在或无权访问');
    }

    const ttlDays = input.ttlDays ?? DEFAULT_ROI_REPORT_SHARE_TTL_DAYS;
    const token = randomBytes(32).toString('base64url');
    const shareTokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const shareExpiresAt = new Date(Date.now() + ttlDays * 86_400_000);

    await this.prisma.scoped.geoRoiReport.update({
      where: { id: report.id },
      data: {
        shareTokenHash,
        shareExpiresAt,
        shareRevokedAt: null,
      },
    });

    const sharePath = `/share/report/${token}`;
    return {
      reportId: report.id,
      token,
      sharePath,
      shareUrl: `${resolvePublicAppUrl()}${sharePath}`,
      expiresAt: shareExpiresAt.toISOString(),
    };
  }

  async revokeShareLink(reportId: string): Promise<RoiReportRevokeShareResultDto> {
    const report = await this.prisma.scoped.geoRoiReport.findFirst({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'ROI 报告不存在或无权访问');
    }

    const now = new Date();
    await this.prisma.scoped.geoRoiReport.update({
      where: { id: report.id },
      data: {
        shareRevokedAt: now,
        shareTokenHash: null,
      },
    });

    return {
      reportId: report.id,
      revoked: true,
      revokedAt: now.toISOString(),
    };
  }
}
