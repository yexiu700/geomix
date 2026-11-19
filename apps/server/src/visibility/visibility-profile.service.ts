import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  VISIBILITY_BRAND_NAME_MAX,
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

    const [profiles, keywords, knowledgeBases] = await Promise.all([
      this.prisma.base.visibilityProfile.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          _count: { select: { runs: true } },
        },
      }),
      this.prisma.base.keyword.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { id: true, main: true, brands: true },
      }),
      this.prisma.base.knowledgeBase.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { id: true, name: true, companyName: true, brandShort: true },
      }),
    ]);

    return {
      items: profiles.map((row) => presentProfile(row, row._count.runs)),
      prefillSources: {
        keywords,
        knowledgeBases,
      },
    };
  }

  async getProfile(id: string): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();
    const row = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { runs: true } } },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }
    return presentProfile(row, row._count.runs);
  }

  async createProfile(
    input: VisibilityProfileCreateWithPrefillInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    this.assertFeatureEnabled();
    const tenantId = requireTenant();

    let resolvedBrandName = (input.brandName ?? '').trim();
    const extraAliases: string[] = [...(input.brandAliases ?? [])];

    if (input.importFromKeywordId) {
      const kw = await this.prisma.base.keyword.findFirst({
        where: { id: input.importFromKeywordId, tenantId },
        select: { id: true, main: true, brands: true },
      });
      if (!kw) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '用于预填的训练主词不存在');
      }
      const cleanBrands = kw.brands.map((b) => b.trim()).filter(Boolean);
      if (!resolvedBrandName && cleanBrands[0]) {
        resolvedBrandName = cleanBrands[0].slice(0, VISIBILITY_BRAND_NAME_MAX);
        extraAliases.push(...cleanBrands.slice(1));
      } else {
        extraAliases.push(...cleanBrands);
      }
    }

    if (input.importFromKbId) {
      const kb = await this.prisma.base.knowledgeBase.findFirst({
        where: { id: input.importFromKbId, tenantId },
        select: { id: true, name: true, companyName: true, brandShort: true },
      });
      if (!kb) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '用于预填的企业知识库不存在');
      }
      const kbTerms = [kb.brandShort, kb.companyName]
        .filter((val): val is string => typeof val === 'string' && val.trim().length > 0)
        .map((val) => val.trim());
      if (!resolvedBrandName && kbTerms[0]) {
        resolvedBrandName = kbTerms[0].slice(0, VISIBILITY_BRAND_NAME_MAX);
        extraAliases.push(...kbTerms.slice(1));
      } else {
        extraAliases.push(...kbTerms);
      }
    }

    if (!resolvedBrandName) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '所选来源暂无可用品牌词，请直接填写主品牌名称',
      );
    }

    const name = input.name.trim();
    const brandAliases = dedupeStringsCaseInsensitive(extraAliases, resolvedBrandName).slice(0, 20);
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

    const duplicate = await this.prisma.base.visibilityProfile.findFirst({
      where: { tenantId, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
    }

    try {
      const created = await this.prisma.base.visibilityProfile.create({
        data: {
          tenantId,
          name,
          brandName: resolvedBrandName,
          brandAliases,
          ownedDomains,
          competitors: competitors as unknown as Prisma.InputJsonValue,
        },
      });
      return presentProfile(created, 0);
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

    const existing = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { runs: true } } },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextBrandName =
      input.brandName !== undefined ? input.brandName.trim() : existing.brandName;
    const nextAliases =
      input.brandAliases !== undefined
        ? dedupeStringsCaseInsensitive(input.brandAliases, nextBrandName).slice(0, 20)
        : dedupeStringsCaseInsensitive(existing.brandAliases, nextBrandName).slice(0, 20);
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

    if (nextName !== existing.name) {
      const duplicate = await this.prisma.base.visibilityProfile.findFirst({
        where: { tenantId, name: nextName, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名监测档案已存在');
      }
    }

    try {
      const updated = await this.prisma.base.visibilityProfile.update({
        where: { id },
        data: {
          name: nextName,
          brandName: nextBrandName,
          brandAliases: nextAliases,
          ownedDomains: nextOwnedDomains,
          competitors: nextCompetitors as unknown as Prisma.InputJsonValue,
        },
      });
      return presentProfile(updated, existing._count.runs);
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

    const existing = await this.prisma.base.visibilityProfile.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
    }

    const activeRuns = await this.prisma.base.visibilityRun.count({
      where: {
        tenantId,
        profileId: id,
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

    await this.prisma.base.visibilityProfile.delete({ where: { id } });
    return { deleted: 1 };
  }

  async resolveProfileContext(tenantId: string, profileId?: string): Promise<ProfileContext> {
    if (profileId) {
      const profile = await this.prisma.base.visibilityProfile.findFirst({
        where: { id: profileId, tenantId },
      });
      if (!profile) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
      }
      return {
        resolvedProfileId: profile.id,
        profileForMetrics: {
          brandName: profile.brandName,
          brandAliases: profile.brandAliases,
          ownedDomains: profile.ownedDomains,
          competitors: parseProfileCompetitors(profile.competitors),
        },
      };
    }

    const profiles = await this.prisma.base.visibilityProfile.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (profiles.length === 0) {
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

    if (profiles.length === 1) {
      const only = profiles[0]!;
      return {
        resolvedProfileId: only.id,
        profileForMetrics: {
          brandName: only.brandName,
          brandAliases: only.brandAliases,
          ownedDomains: only.ownedDomains,
          competitors: parseProfileCompetitors(only.competitors),
        },
      };
    }

    const primary = profiles[0]!;
    const aliases = dedupeStringsCaseInsensitive(
      profiles.flatMap((p) => [p.brandName, ...p.brandAliases]),
      primary.brandName,
    );
    const ownedDomains = [...new Set(profiles.flatMap((p) => p.ownedDomains))];
    const competitors = normalizeCompetitorsList(
      profiles.flatMap((p) => parseProfileCompetitors(p.competitors)),
    );

    return {
      resolvedProfileId: null,
      profileForMetrics: {
        brandName: primary.brandName,
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

    const profiles = profileId
      ? await (async () => {
          const single = await this.prisma.base.visibilityProfile.findFirst({
            where: { id: profileId, tenantId },
          });
          if (!single) {
            throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '监测档案不存在');
          }
          return [single];
        })()
      : await this.prisma.base.visibilityProfile.findMany({
          where: { tenantId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });

    if (profiles.length === 0) {
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

    for (const prof of profiles) {
      const comps = parseProfileCompetitors(prof.competitors);
      profilesById.set(prof.id, {
        brandName: prof.brandName,
        brandAliases: prof.brandAliases,
        ownedDomains: prof.ownedDomains,
        competitors: comps,
      });

      const brandKey = prof.brandName.trim().toLowerCase() || prof.id;
      const existing = brandMap.get(brandKey);
      if (existing) {
        existing.profileIds.push(prof.id);
        existing.rawAliases.push(...prof.brandAliases);
        existing.ownedDomains.push(...prof.ownedDomains);
        existing.rawCompetitors.push(...comps);
      } else {
        brandMap.set(brandKey, {
          brandName: prof.brandName.trim() || '本品牌',
          profileIds: [prof.id],
          rawAliases: [...prof.brandAliases],
          ownedDomains: [...prof.ownedDomains],
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
      ? profiles[0]!.id
      : profiles.length === 1
        ? profiles[0]!.id
        : null;

    return {
      resolvedProfileId,
      profilesById,
      brandEntries,
      fallbackProfileForMetrics: brandEntries[0]?.profileForMetrics ?? emptyFallback,
    };
  }
}
