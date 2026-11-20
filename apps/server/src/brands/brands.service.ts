import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AUTH_ERROR,
  BILLING_ERROR,
  GEO_MARKET_DEFAULTS,
  normalizeBrandDomain,
  type BrandCompetitor,
  type BrandListResponse,
  type BrandMarketRecord,
  type BrandRecord,
  type GeoMarket,
  type ParsedCreateBrandInput,
  type ParsedUpsertBrandMarketInput,
} from '@geomix/shared';
import { isUniqueViolation } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';

type BrandMarketRow = {
  id: string;
  brandId: string;
  market: string;
  locale: string;
  region: string;
  localBrandName: string;
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
};

@Injectable()
export class BrandsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async list(): Promise<BrandListResponse> {
    const rows = await this.prisma.scoped.brand.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      include: {
        markets: {
          orderBy: { market: 'asc' },
        },
      },
    });
    return { items: rows.map(presentBrand) };
  }

  async create(
    tenantId: string,
    userId: string,
    input: ParsedCreateBrandInput,
  ): Promise<BrandRecord> {
    const name = input.name.trim();
    const category = input.category.trim();
    const fallbackDomains = normalizeDomains(input.ownedDomains ?? []);
    const fallbackCompetitors = normalizeCompetitors(input.competitors ?? []);

    const normalizedMarkets = input.markets.map((m) => {
      const defaults = GEO_MARKET_DEFAULTS[m.market];
      const ownedDomains = normalizeDomains(
        m.ownedDomains.length > 0 ? m.ownedDomains : fallbackDomains,
      );
      const competitors = normalizeCompetitors(
        m.competitors.length > 0 ? m.competitors : fallbackCompetitors,
      );
      const entry = m as {
        market: GeoMarket;
        locale?: string;
        region?: string;
        localBrandName?: string;
        aliases: string[];
        ownedDomains: string[];
        competitors: BrandCompetitor[];
        seedPrompts: string[];
      };
      return {
        market: entry.market,
        locale: entry.locale?.trim() || defaults.locale,
        region: entry.region?.trim() || defaults.region,
        localBrandName: entry.localBrandName?.trim() || name,
        aliases: dedupeStrings(entry.aliases),
        ownedDomains,
        competitors,
        seedPrompts: dedupeStrings(entry.seedPrompts),
      };
    });

    const complianceText = [
      name,
      category,
      ...normalizedMarkets.flatMap((m) => [
        m.localBrandName,
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

    try {
      const created = await this.prisma.scoped.brand.create({
        data: {
          tenantId,
          name,
          category,
          ...(input.truthAgreed ? { truthAgreementSignedAt: new Date() } : {}),
          markets: {
            create: normalizedMarkets.map((m) => ({
              tenantId,
              market: m.market,
              locale: m.locale,
              region: m.region,
              localBrandName: m.localBrandName,
              aliases: m.aliases,
              ownedDomains: m.ownedDomains,
              competitors: m.competitors as unknown as Prisma.InputJsonValue,
              seedPrompts: m.seedPrompts,
            })),
          },
        },
        include: {
          markets: {
            orderBy: { market: 'asc' },
          },
        },
      });
      return presentBrand(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同名品牌已存在');
      }
      throw error;
    }
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
    const aliases = dedupeStrings(input.aliases);
    const ownedDomains = normalizeDomains(input.ownedDomains);
    const competitors = normalizeCompetitors(input.competitors);
    const seedPrompts = dedupeStrings(input.seedPrompts);

    const complianceText = [
      localBrandName,
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

    const refreshed = await this.prisma.scoped.brand.findFirst({
      where: { id: brand.id },
      include: {
        markets: {
          orderBy: { market: 'asc' },
        },
      },
    });
    if (!refreshed) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
    return presentBrand(refreshed);
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
  };
}
