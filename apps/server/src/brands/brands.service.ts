import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  GEO_MARKET_DEFAULTS,
  generateBrandSeedPrompts,
  normalizeBrandDomain,
  type BrandCompetitor,
  type BrandDeleteResponse,
  type BrandListResponse,
  type BrandMarketRecord,
  type BrandRecord,
  type GeoMarket,
  type ParsedCreateBrandInput,
  type ParsedUpdateBrandMarketInput,
  type ParsedUpsertBrandMarketInput,
  type UpdateBrandInput,
} from '@geomix/shared';
import { isUniqueViolation, TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { StorageService } from '../infra/storage';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeClientIp, objectNameFromKey } from './brands.http-utils';

const BRAND_DETAIL_INCLUDE = {
  markets: {
    orderBy: { market: 'asc' as const },
  },
  _count: {
    select: {
      facts: true,
      mediaAssets: true,
    },
  },
};

type BrandMarketRow = {
  id: string;
  brandId: string;
  market: string;
  locale: string;
  region: string;
  localBrandName: string;
  localCategory?: string | null;
  aliases: string[];
  ownedDomains: string[];
  competitors: Prisma.JsonValue;
  seedPrompts: string[];
  createdAt: Date;
  updatedAt: Date;
};

type BrandRow = {
  id: string;
  name: string;
  category: string;
  truthAgreementSignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  markets: BrandMarketRow[];
  _count?: {
    facts?: number;
    mediaAssets?: number;
  };
};

export type ResolvedBrandMarket = {
  brand: BrandRecord;
  market: BrandMarketRecord;
};

@Injectable()
export class BrandsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async list(): Promise<BrandListResponse> {
    const rows = await this.prisma.scoped.brand.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      include: BRAND_DETAIL_INCLUDE,
    });
    return { items: rows.map(presentBrand) };
  }

  async getById(brandId: string): Promise<BrandRecord> {
    const row = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: BRAND_DETAIL_INCLUDE,
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
    return presentBrand(row);
  }

  async create(
    tenantId: string,
    userId: string,
    input: ParsedCreateBrandInput,
    clientIp?: string | null,
  ): Promise<BrandRecord> {
    const name = input.name.trim();
    const category = input.category.trim();
    const fallbackAliases = dedupeStrings(input.aliases ?? []);
    const fallbackDomains = normalizeDomains(input.ownedDomains ?? []);
    const fallbackCompetitors = normalizeCompetitors(input.competitors ?? []);

    const normalizedMarkets = input.markets.map((m) => {
      const entry = m as {
        market: GeoMarket;
        locale?: string;
        region?: string;
        localBrandName?: string;
        localCategory?: string | null;
        aliases: string[];
        ownedDomains: string[];
        competitors: BrandCompetitor[];
        seedPrompts: string[];
      };
      const defaults = GEO_MARKET_DEFAULTS[entry.market];
      const localBrandName = entry.localBrandName?.trim() || name;
      const localCategory = entry.localCategory?.trim() || null;
      const aliases = dedupeStrings(entry.aliases.length > 0 ? entry.aliases : fallbackAliases);
      const ownedDomains = normalizeDomains(
        entry.ownedDomains.length > 0 ? entry.ownedDomains : fallbackDomains,
      );
      const competitors = normalizeCompetitors(
        entry.competitors.length > 0 ? entry.competitors : fallbackCompetitors,
      );
      const customSeeds = dedupeStrings(entry.seedPrompts);
      const seedPrompts =
        customSeeds.length > 0
          ? customSeeds
          : generateBrandSeedPrompts({
              market: entry.market,
              brandName: localBrandName,
              category,
              localCategory,
              competitors,
            });

      return {
        market: entry.market,
        locale: entry.locale?.trim() || defaults.locale,
        region: entry.region?.trim() || defaults.region,
        localBrandName,
        localCategory,
        aliases,
        ownedDomains,
        competitors,
        seedPrompts,
      };
    });

    const complianceText = [
      name,
      category,
      ...normalizedMarkets.flatMap((m) => [
        m.localBrandName,
        m.localCategory ?? '',
        ...m.aliases,
        ...m.competitors.flatMap((c) => [c.name, ...c.aliases]),
        ...m.seedPrompts,
      ]),
    ].join('\n');

    await this.compliance.assertAllowed({
      text: complianceText,
      action: 'brand_create',
      tenantId,
      userId,
    });

    const signedIp = normalizeClientIp(clientIp);

    try {
      const created = await this.prisma.scoped.brand.create({
        data: {
          tenantId,
          name,
          category,
          ...(input.truthAgreed
            ? { truthAgreementSignedAt: new Date(), truthAgreementIp: signedIp }
            : {}),
          markets: {
            create: normalizedMarkets.map((m) => ({
              tenantId,
              market: m.market,
              locale: m.locale,
              region: m.region,
              localBrandName: m.localBrandName,
              localCategory: m.localCategory,
              aliases: m.aliases,
              ownedDomains: m.ownedDomains,
              competitors: m.competitors as unknown as Prisma.InputJsonValue,
              seedPrompts: m.seedPrompts,
            })),
          },
        },
        include: BRAND_DETAIL_INCLUDE,
      });
      return presentBrand(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名品牌已存在');
      }
      throw error;
    }
  }

  async update(
    tenantId: string,
    userId: string,
    brandId: string,
    input: UpdateBrandInput,
    clientIp?: string | null,
  ): Promise<BrandRecord> {
    const existing = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        category: true,
        truthAgreementSignedAt: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextCategory = input.category !== undefined ? input.category.trim() : existing.category;

    if (input.name !== undefined || input.category !== undefined) {
      await this.compliance.assertAllowed({
        text: [nextName, nextCategory].join('\n'),
        action: 'brand_update',
        tenantId,
        userId,
      });
    }

    const data: Prisma.BrandUpdateInput = {};
    if (input.name !== undefined) data.name = nextName;
    if (input.category !== undefined) data.category = nextCategory;
    if (input.truthAgreed === true && !existing.truthAgreementSignedAt) {
      data.truthAgreementSignedAt = new Date();
      data.truthAgreementIp = normalizeClientIp(clientIp);
    }

    try {
      const updated = await this.prisma.scoped.brand.update({
        where: { id: brandId },
        data,
        include: BRAND_DETAIL_INCLUDE,
      });
      return presentBrand(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名品牌已存在');
      }
      throw error;
    }
  }

  async remove(tenantId: string, brandId: string): Promise<BrandDeleteResponse> {
    const { assets, totalBytes } = await this.prisma.base.$transaction(async (tx) => {
      const brand = await tx.brand.findFirst({
        where: { id: brandId, tenantId },
        select: { id: true },
      });
      if (!brand) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
      }

      const [activeRuns, activeBatches, runningObservations] = await Promise.all([
        tx.visibilityRun.count({
          where: { tenantId, brandId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        }),
        tx.geoBatchJob.count({
          where: { tenantId, brandId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        }),
        tx.visibilityObservation.count({
          where: { tenantId, brandId, status: 'RUNNING' },
        }),
      ]);
      if (activeRuns > 0 || activeBatches > 0) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '该品牌存在进行中的监测任务或批量写作任务，请等待完成或终止后再删除',
        );
      }
      if (runningObservations > 0) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '存在仍在执行中的监测请求，请等待数秒收尾后再删除',
        );
      }

      const mediaRows = await tx.brandMediaAsset.findMany({
        where: { tenantId, brandId },
        select: { objectKey: true, thumbKey: true, bytes: true },
      });
      const bytesSum = mediaRows.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);

      const deleted = await tx.brand.deleteMany({
        where: { id: brandId, tenantId },
      });
      if (deleted.count !== 1) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
      }

      if (bytesSum > 0) {
        await this.quota.release(tenantId, 'STORAGE_BYTES', bytesSum, tx);
      }

      return { assets: mediaRows, totalBytes: bytesSum };
    }, TX_OPTIONS);

    const objectNames = new Set<string>();
    for (const asset of assets) {
      const mainName = objectNameFromKey(tenantId, asset.objectKey);
      if (mainName) objectNames.add(mainName);
      const thumbName = objectNameFromKey(tenantId, asset.thumbKey);
      if (thumbName) objectNames.add(thumbName);
    }

    if (objectNames.size > 0) {
      await Promise.allSettled(
        Array.from(objectNames).map((name) => this.storage.delete(tenantId, name)),
      );
    }

    return {
      deleted: 1,
      id: brandId,
      releasedBytes: totalBytes,
    };
  }

  async enableMarket(
    tenantId: string,
    userId: string,
    brandId: string,
    market: GeoMarket,
    input: ParsedUpsertBrandMarketInput,
  ): Promise<BrandRecord> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: {
        markets: {
          orderBy: { market: 'asc' },
        },
      },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
    if (brand.markets.some((m) => m.market === market)) {
      throw new ApiError(409, BILLING_ERROR.CONFLICT, '该市场已开启');
    }

    const defaults = GEO_MARKET_DEFAULTS[market];
    const localBrandName = input.localBrandName?.trim() || brand.name;
    const localCategory = input.localCategory?.trim() || null;
    const aliases = dedupeStrings(input.aliases);
    const ownedDomains = normalizeDomains(input.ownedDomains);
    const competitors = normalizeCompetitors(input.competitors);
    const customSeeds = dedupeStrings(input.seedPrompts);
    const seedPrompts =
      customSeeds.length > 0
        ? customSeeds
        : generateBrandSeedPrompts({
            market,
            brandName: localBrandName,
            category: brand.category,
            localCategory,
            competitors,
          });

    const complianceText = [
      localBrandName,
      localCategory ?? '',
      ...aliases,
      ...competitors.flatMap((c) => [c.name, ...c.aliases]),
      ...seedPrompts,
    ].join('\n');

    await this.compliance.assertAllowed({
      text: complianceText,
      action: 'brand_market_enable',
      tenantId,
      userId,
    });

    try {
      await this.prisma.scoped.brandMarket.create({
        data: {
          tenantId,
          brandId: brand.id,
          market,
          locale: input.locale?.trim() || defaults.locale,
          region: input.region?.trim() || defaults.region,
          localBrandName,
          localCategory,
          aliases,
          ownedDomains,
          competitors: competitors as unknown as Prisma.InputJsonValue,
          seedPrompts,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '该市场已开启');
      }
      throw error;
    }

    return this.getById(brand.id);
  }

  async updateMarket(
    tenantId: string,
    userId: string,
    brandId: string,
    market: GeoMarket,
    input: ParsedUpdateBrandMarketInput,
  ): Promise<BrandRecord> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: {
        markets: {
          orderBy: { market: 'asc' },
        },
      },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
    const existingMarket = brand.markets.find((m) => m.market === market);
    if (!existingMarket) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该市场尚未开启');
    }

    const nextLocalBrandName =
      input.localBrandName !== undefined
        ? input.localBrandName.trim()
        : existingMarket.localBrandName;
    const nextLocalCategory =
      input.localCategory !== undefined
        ? input.localCategory?.trim() || null
        : (existingMarket.localCategory ?? null);
    const nextLocale = input.locale !== undefined ? input.locale.trim() : existingMarket.locale;
    const nextRegion = input.region !== undefined ? input.region.trim() : existingMarket.region;
    const nextAliases =
      input.aliases !== undefined ? dedupeStrings(input.aliases) : existingMarket.aliases;
    const nextOwnedDomains =
      input.ownedDomains !== undefined
        ? normalizeDomains(input.ownedDomains)
        : existingMarket.ownedDomains;
    const nextCompetitors =
      input.competitors !== undefined
        ? normalizeCompetitors(input.competitors)
        : parseStoredCompetitors(existingMarket.competitors);
    const nextSeedPrompts =
      input.seedPrompts !== undefined
        ? dedupeStrings(input.seedPrompts)
        : existingMarket.seedPrompts;

    const complianceText = [
      brand.name,
      brand.category,
      nextLocalBrandName,
      nextLocalCategory ?? '',
      ...nextAliases,
      ...nextCompetitors.flatMap((c) => [c.name, ...c.aliases]),
      ...nextSeedPrompts,
    ].join('\n');

    await this.compliance.assertAllowed({
      text: complianceText,
      action: 'brand_market_update',
      tenantId,
      userId,
    });

    await this.prisma.scoped.brandMarket.update({
      where: { id: existingMarket.id },
      data: {
        locale: nextLocale,
        region: nextRegion,
        localBrandName: nextLocalBrandName,
        localCategory: nextLocalCategory,
        aliases: nextAliases,
        ownedDomains: nextOwnedDomains,
        competitors: nextCompetitors as unknown as Prisma.InputJsonValue,
        seedPrompts: nextSeedPrompts,
      },
    });

    return this.getById(brand.id);
  }

  async resolveBrandMarket(brandId: string, market?: GeoMarket): Promise<ResolvedBrandMarket> {
    const brand = await this.getById(brandId);
    if (market) {
      const matched = brand.markets.find((m) => m.market === market);
      if (!matched) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未开启目标市场');
      }
      return { brand, market: matched };
    }
    if (brand.markets.length === 1) {
      return { brand, market: brand.markets[0]! };
    }
    if (brand.markets.length === 0) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未配置任何市场');
    }
    throw new ApiError(
      400,
      API_ERROR.BAD_REQUEST,
      '双市场品牌必须显式指定 market 参数（CN 或 GLOBAL）',
    );
  }
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeDomains(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const normalized = normalizeBrandDomain(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeCompetitors(values: readonly BrandCompetitor[]): BrandCompetitor[] {
  const seen = new Set<string>();
  const out: BrandCompetitor[] = [];
  for (const item of values) {
    const name = item.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      aliases: dedupeStrings(item.aliases ?? []),
      domains: normalizeDomains(item.domains ?? []),
    });
  }
  return out;
}

function parseStoredCompetitors(raw: Prisma.JsonValue): BrandCompetitor[] {
  if (!Array.isArray(raw)) return [];
  const out: BrandCompetitor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const aliases = Array.isArray(rec.aliases)
      ? rec.aliases.filter((v): v is string => typeof v === 'string')
      : [];
    const domains = Array.isArray(rec.domains)
      ? rec.domains.filter((v): v is string => typeof v === 'string')
      : [];
    out.push({
      name,
      aliases: dedupeStrings(aliases),
      domains: normalizeDomains(domains),
    });
  }
  return out;
}

function presentMarket(row: BrandMarketRow): BrandMarketRecord {
  return {
    id: row.id,
    brandId: row.brandId,
    market: row.market === 'GLOBAL' ? 'GLOBAL' : 'CN',
    locale: row.locale,
    region: row.region,
    localBrandName: row.localBrandName,
    localCategory: row.localCategory ?? null,
    aliases: row.aliases,
    ownedDomains: row.ownedDomains,
    competitors: parseStoredCompetitors(row.competitors),
    seedPrompts: row.seedPrompts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentBrand(row: BrandRow): BrandRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    truthAgreementSignedAt: row.truthAgreementSignedAt
      ? row.truthAgreementSignedAt.toISOString()
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    markets: row.markets.map(presentMarket),
    factCount: row._count?.facts ?? 0,
    mediaCount: row._count?.mediaAssets ?? 0,
  };
}
