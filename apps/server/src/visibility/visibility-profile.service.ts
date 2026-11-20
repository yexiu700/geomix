import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  type ProfileForMetrics,
  type VisibilityCompetitor,
  type VisibilityProfileCreateWithPrefillInput,
  type VisibilityProfileListResponse,
  type VisibilityProfileRecord,
  type VisibilityProfileUpdateInput,
} from '@geomix/shared';
import { isUniqueViolation } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';
import {
  dedupeStringsCaseInsensitive,
  normalizeCompetitorsList,
  normalizeOwnedDomainsList,
  parseProfileCompetitors,
  presentProfile,
  type OverviewBrandEntry,
  type OverviewProfileContext,
  type ProfileContext,
} from './visibility.mapper';

export type { OverviewBrandEntry, OverviewProfileContext, ProfileContext };

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId || tenantId === 'system') {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return tenantId;
}

type BrandMarketWithBrand = {
  id: string;
  brandId: string;
  market: 'CN' | 'GLOBAL';
  localBrandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: unknown;
  createdAt: Date;
  updatedAt: Date;
  brand: { id: string; name: string };
};

function toProfileRecord(row: BrandMarketWithBrand, runCount: number): VisibilityProfileRecord {
  return presentProfile(
    {
      id: row.id,
      name: `${row.brand.name} (${row.market})`,
      brandName: row.localBrandName,
      brandAliases: row.aliases,
      ownedDomains: row.ownedDomains,
      competitors: row.competitors,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    runCount,
  );
}

@Injectable()
export class VisibilityProfileService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  async listProfiles(): Promise<VisibilityProfileListResponse> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const markets = await this.prisma.base.brandMarket.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        brand: { select: { id: true, name: true } },
        _count: { select: { visibilityRuns: true } },
      },
    });

    return {
      items: markets.map((row) => toProfileRecord(row, row._count.visibilityRuns)),
      prefillSources: {
        keywords: [],
        knowledgeBases: [],
      },
    };
  }

  async getProfile(id: string): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const row = await this.prisma.base.brandMarket.findFirst({
      where: { id, tenantId },
      include: {
        brand: { select: { id: true, name: true } },
        _count: { select: { visibilityRuns: true } },
      },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }
    return toProfileRecord(row, row._count.visibilityRuns);
  }

  async createProfile(
    input: VisibilityProfileCreateWithPrefillInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const resolvedBrandName = (input.brandName ?? '').trim();
    if (!resolvedBrandName) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选来源暂无可用品牌词，请直接填写主品牌名称',
      );
    }

    const name = input.name.trim();
    const brandAliases = dedupeStringsCaseInsensitive(
      input.brandAliases ?? [],
      resolvedBrandName,
    ).slice(0, 20);
    const ownedDomains = normalizeOwnedDomainsList(input.ownedDomains ?? [], 20);
    const competitors = normalizeCompetitorsList(input.competitors ?? []);

    await this.compliance.assertAllowed({
      text: [
        name,
        resolvedBrandName,
        ...brandAliases,
        ...competitors.flatMap((comp) => [comp.name, ...comp.aliases]),
      ].join('\n'),
      action: 'visibility_profile_create',
      tenantId,
      userId,
    });

    const duplicate = await this.prisma.base.brand.findFirst({
      where: { tenantId, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
    }

    try {
      const brand = await this.prisma.base.brand.create({
        data: {
          tenantId,
          name,
          category: '通用品牌',
          markets: {
            create: {
              tenantId,
              market: 'CN',
              locale: 'zh-CN',
              region: 'CN',
              localBrandName: resolvedBrandName,
              aliases: brandAliases,
              ownedDomains,
              competitors: competitors as unknown as Prisma.InputJsonValue,
            },
          },
        },
        include: {
          markets: true,
        },
      });
      const bm = brand.markets[0]!;
      return toProfileRecord({ ...bm, brand: { id: brand.id, name: brand.name } }, 0);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
      throw error;
    }
  }

  async updateProfile(
    id: string,
    input: VisibilityProfileUpdateInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const existing = await this.prisma.base.brandMarket.findFirst({
      where: { id, tenantId },
      include: {
        brand: { select: { id: true, name: true } },
        _count: { select: { visibilityRuns: true } },
      },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.brand.name;
    const nextBrandName =
      input.brandName !== undefined ? input.brandName.trim() : existing.localBrandName;
    const nextAliases =
      input.brandAliases !== undefined
        ? dedupeStringsCaseInsensitive(input.brandAliases, nextBrandName).slice(0, 20)
        : dedupeStringsCaseInsensitive(existing.aliases, nextBrandName).slice(0, 20);
    const nextOwnedDomains =
      input.ownedDomains !== undefined
        ? normalizeOwnedDomainsList(input.ownedDomains, 20)
        : existing.ownedDomains;
    const nextCompetitors =
      input.competitors !== undefined
        ? normalizeCompetitorsList(input.competitors)
        : parseProfileCompetitors(existing.competitors);

    await this.compliance.assertAllowed({
      text: [
        nextName,
        nextBrandName,
        ...nextAliases,
        ...nextCompetitors.flatMap((comp) => [comp.name, ...comp.aliases]),
      ].join('\n'),
      action: 'visibility_profile_update',
      tenantId,
      userId,
    });

    try {
      if (nextName !== existing.brand.name) {
        await this.prisma.base.brand.update({
          where: { id: existing.brandId },
          data: { name: nextName },
        });
      }
      const updated = await this.prisma.base.brandMarket.update({
        where: { id },
        data: {
          localBrandName: nextBrandName,
          aliases: nextAliases,
          ownedDomains: nextOwnedDomains,
          competitors: nextCompetitors as unknown as Prisma.InputJsonValue,
        },
        include: {
          brand: { select: { id: true, name: true } },
        },
      });
      return toProfileRecord(updated, existing._count.visibilityRuns);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
      throw error;
    }
  }

  async deleteProfile(id: string): Promise<{ deleted: number }> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    const existing = await this.prisma.base.brandMarket.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const activeRuns = await this.prisma.base.visibilityRun.count({
      where: {
        tenantId,
        brandMarketId: id,
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeRuns > 0) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '该监测档案下仍有未结束的监测任务，请先终止或等待完成后再删除',
      );
    }

    await this.prisma.base.brandMarket.delete({ where: { id } });
    return { deleted: 1 };
  }

  async resolveProfileContext(tenantId: string, profileId?: string): Promise<ProfileContext> {
    if (profileId) {
      const bm = await this.prisma.base.brandMarket.findFirst({
        where: { id: profileId, tenantId },
      });
      if (!bm) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
      return {
        resolvedProfileId: bm.id,
        profileForMetrics: {
          brandName: bm.localBrandName,
          brandAliases: bm.aliases,
          ownedDomains: bm.ownedDomains,
          competitors: parseProfileCompetitors(bm.competitors),
        },
      };
    }

    const markets = await this.prisma.base.brandMarket.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (markets.length === 0) {
      return {
        resolvedProfileId: null,
        profileForMetrics: {
          brandName: '本品牌',
          brandAliases: [],
          ownedDomains: [],
          competitors: [],
        },
      };
    }

    if (markets.length === 1) {
      const only = markets[0]!;
      return {
        resolvedProfileId: only.id,
        profileForMetrics: {
          brandName: only.localBrandName,
          brandAliases: only.aliases,
          ownedDomains: only.ownedDomains,
          competitors: parseProfileCompetitors(only.competitors),
        },
      };
    }

    const primary = markets[0]!;
    const aliases = dedupeStringsCaseInsensitive(
      markets.flatMap((m) => [m.localBrandName, ...m.aliases]),
      primary.localBrandName,
    );
    const ownedDomains = [...new Set(markets.flatMap((m) => m.ownedDomains))];
    const competitors = normalizeCompetitorsList(
      markets.flatMap((m) => parseProfileCompetitors(m.competitors)),
    );

    return {
      resolvedProfileId: null,
      profileForMetrics: {
        brandName: primary.localBrandName,
        brandAliases: aliases,
        ownedDomains,
        competitors,
      },
    };
  }

  async loadOverviewProfileContexts(
    tenantId: string,
    profileId?: string,
  ): Promise<OverviewProfileContext> {
    const emptyFallback: ProfileForMetrics = {
      brandName: '本品牌',
      brandAliases: [],
      ownedDomains: [],
      competitors: [],
    };

    const markets = profileId
      ? await (async () => {
          const single = await this.prisma.base.brandMarket.findFirst({
            where: { id: profileId, tenantId },
          });
          if (!single) {
            throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
          }
          return [single];
        })()
      : await this.prisma.base.brandMarket.findMany({
          where: { tenantId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });

    if (markets.length === 0) {
      return {
        resolvedProfileId: null,
        profilesById: new Map(),
        brandEntries: [],
        fallbackProfileForMetrics: emptyFallback,
      };
    }

    const profilesById = new Map<string, ProfileForMetrics>();
    const brandMap = new Map<
      string,
      {
        brandName: string;
        profileIds: string[];
        rawAliases: string[];
        ownedDomains: string[];
        rawCompetitors: VisibilityCompetitor[];
      }
    >();

    for (const bm of markets) {
      const comps = parseProfileCompetitors(bm.competitors);
      profilesById.set(bm.id, {
        brandName: bm.localBrandName,
        brandAliases: bm.aliases,
        ownedDomains: bm.ownedDomains,
        competitors: comps,
      });

      const brandKey = bm.localBrandName.trim().toLowerCase() || bm.id;
      const existing = brandMap.get(brandKey);
      if (existing) {
        existing.profileIds.push(bm.id);
        existing.rawAliases.push(...bm.aliases);
        existing.ownedDomains.push(...bm.ownedDomains);
        existing.rawCompetitors.push(...comps);
      } else {
        brandMap.set(brandKey, {
          brandName: bm.localBrandName.trim() || '本品牌',
          profileIds: [bm.id],
          rawAliases: [...bm.aliases],
          ownedDomains: [...bm.ownedDomains],
          rawCompetitors: [...comps],
        });
      }
    }

    const brandEntries: OverviewBrandEntry[] = [...brandMap.values()].map((entry) => ({
      brandName: entry.brandName,
      profileIds: entry.profileIds,
      profileForMetrics: {
        brandName: entry.brandName,
        brandAliases: dedupeStringsCaseInsensitive(entry.rawAliases, entry.brandName),
        ownedDomains: [...new Set(entry.ownedDomains)],
        competitors: normalizeCompetitorsList(entry.rawCompetitors),
      },
    }));

    const resolvedProfileId = profileId
      ? markets[0]!.id
      : markets.length === 1
        ? markets[0]!.id
        : null;

    return {
      resolvedProfileId,
      profilesById,
      brandEntries,
      fallbackProfileForMetrics: brandEntries[0]?.profileForMetrics ?? emptyFallback,
    };
  }
}
