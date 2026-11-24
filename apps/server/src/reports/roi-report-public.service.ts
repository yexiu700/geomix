import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AUTH_ERROR,
  resolveEffectiveLocale,
  sanitizeSummaryForPublicReport,
  type GeoMarket,
  type PublicGeoRoiReportDto,
  type SupportedLocale,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import { localizeRoiReportChannelLabel, parseStoredSummaryJson } from './roi-report-aggregator';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const UNIFORM_NOT_FOUND_MESSAGE = '该报告分享链接不存在或已失效';
const DEFAULT_PUBLIC_GET_MAX = 30;
const DEFAULT_PUBLIC_WINDOW_SECONDS = 60;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPublicRoiReportGetRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.PUBLIC_ROI_REPORT_GET_RATE_LIMIT_MAX, DEFAULT_PUBLIC_GET_MAX);
  const windowSeconds = readPositiveInt(
    env.PUBLIC_ROI_REPORT_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_PUBLIC_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

/**
 * 月度 GEO ROI 报告无登录白标只读分享服务（Issue #369 / PRD §2 D5）：
 * - 先执行按客户端 IP 限流（防暴力遍历，且无 Redis 依赖）
 * - 仅使用 1 次 prisma.base.geoRoiReport.findUnique({ where: { shareTokenHash } }) 定位租户，
 *   随即进入 runInTenant(located.tenantId) 并通过 prisma.scoped 二次校验读取
 * - 对未知/格式错误/已撤销/已过期 token 均返回完全一致的 404（零存在性侧信道）
 * - 严格通过 sanitizeSummaryForPublicReport() 脱敏，绝不泄露 tenantId / userId / pointsRoi / shareTokenHash
 */
@Injectable()
export class RoiReportPublicService {
  private readonly rateLimiter: FreeActionRateLimiter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(FreeActionRateLimiter)
    rateLimiter?: FreeActionRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new FreeActionRateLimiter();
  }

  resetRateLimits(): void {
    this.rateLimiter.reset();
  }

  async getPublicReport(rawToken: string, clientIp: string): Promise<PublicGeoRoiReportDto> {
    this.rateLimiter.assertAllowed(
      'public_roi_report_get',
      clientIp || 'unknown',
      readPublicRoiReportGetRateLimit(),
    );

    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!TOKEN_PATTERN.test(token)) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
    }

    const shareTokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

    const located = await this.prisma.base.geoRoiReport.findUnique({
      where: { shareTokenHash },
      select: {
        id: true,
        tenantId: true,
        shareExpiresAt: true,
        shareRevokedAt: true,
      },
    });

    if (
      !located ||
      located.shareRevokedAt !== null ||
      !located.shareExpiresAt ||
      located.shareExpiresAt.getTime() <= Date.now()
    ) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
    }

    return runInTenant(located.tenantId, async () => {
      const now = new Date();
      const report = await this.prisma.scoped.geoRoiReport.findFirst({
        where: {
          id: located.id,
          shareTokenHash,
          shareRevokedAt: null,
          shareExpiresAt: { gt: now },
        },
        select: {
          title: true,
          periodStart: true,
          periodEnd: true,
          locale: true,
          whiteLabelOrg: true,
          summaryJson: true,
          shareExpiresAt: true,
          createdAt: true,
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

      if (!report || !report.shareExpiresAt) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, UNIFORM_NOT_FOUND_MESSAGE);
      }

      const market: GeoMarket = report.brandMarket.market === 'GLOBAL' ? 'GLOBAL' : 'CN';
      const locale: SupportedLocale = resolveEffectiveLocale(
        report.locale || report.brandMarket.locale,
        market,
      );
      const brandName = report.brandMarket.localBrandName?.trim() || report.brand.name;
      const category = report.brandMarket.localCategory?.trim() || report.brand.category;

      const rawSummary = parseStoredSummaryJson(report.summaryJson);
      const sanitizedSummary = sanitizeSummaryForPublicReport(rawSummary);
      sanitizedSummary.channelRanking = sanitizedSummary.channelRanking.map((item) => ({
        ...item,
        channel: localizeRoiReportChannelLabel(item.channel, item.provider, locale),
      }));

      const dto: PublicGeoRoiReportDto = {
        title: report.title,
        brandName,
        category,
        market,
        locale,
        whiteLabelOrg: report.whiteLabelOrg ?? null,
        periodStart: report.periodStart.toISOString(),
        periodEnd: report.periodEnd.toISOString(),
        summary: sanitizedSummary,
        generatedAt: report.createdAt.toISOString(),
        expiresAt: report.shareExpiresAt.toISOString(),
      };
      return dto;
    });
  }
}
