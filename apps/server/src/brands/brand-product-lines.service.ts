import { Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  BRAND_ID_PATTERN,
  BRAND_MAX_PRODUCT_LINES,
  type BrandProductLineDeleteResponse,
  type BrandProductLineDto,
  type BrandProductLineListResponse,
  type ParsedCreateProductLineInput,
  type ParsedUpdateProductLineInput,
  type ProductLineCompetitors,
  type ProductLineLocalCategories,
  type ProductLineLocalNames,
  type ProductLineSeedPrompts,
  readProductLineMarketCompetitors,
  readProductLineMarketSeedPrompts,
  readProductLineMarketString,
} from '@geomix/shared';
import type { Prisma } from '@prisma/client';
import { isUniqueViolation } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';

export type BrandProductLineRow = {
  id: string;
  brandId: string;
  name: string;
  localNamesJson: Prisma.JsonValue;
  category: string;
  localCategoriesJson: Prisma.JsonValue;
  seedPromptsJson: Prisma.JsonValue;
  competitorsJson: Prisma.JsonValue;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 品牌多产品线服务（100% 走 prisma.scoped）：
 * - 单品牌可选配置 0–20 条产品线，保持同品牌下名称唯一
 * - 删除产品线触发数据库 ON DELETE SET NULL，保留历史事实卡 / 监测任务 / 意见卡 / 文章
 */
@Injectable()
export class BrandProductLinesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async list(brandId: string): Promise<BrandProductLineListResponse> {
    await this.assertBrandExists(brandId);
    const rows = await this.prisma.scoped.brandProductLine.findMany({
      where: { brandId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(presentProductLine) };
  }

  async create(
    tenantId: string,
    userId: string,
    brandId: string,
    input: ParsedCreateProductLineInput,
  ): Promise<BrandProductLineDto> {
    await this.assertBrandExists(brandId);

    const name = input.name.trim();
    const category = input.category.trim();
    const localNamesJson = normalizeLocalStringMap(input.localNamesJson);
    const localCategoriesJson = normalizeLocalStringMap(input.localCategoriesJson);
    const seedPromptsJson = normalizeSeedPromptsMap(input.seedPromptsJson);
    const competitorsJson = normalizeCompetitorsMap(input.competitorsJson);
    const sortOrder = input.sortOrder ?? 0;

    await this.compliance.assertAllowed({
      text: collectComplianceText({
        name,
        category,
        localNamesJson,
        localCategoriesJson,
        seedPromptsJson,
        competitorsJson,
      }),
      action: 'brand_product_line_create',
      tenantId,
      userId,
    });

    try {
      const created = await this.prisma.scoped.$transaction(async (tx) => {
        // Acquire a row-level lock on the parent Brand row so concurrent creates
        // for the same brand serialize before checking BRAND_MAX_PRODUCT_LINES.
        const locked = await tx.brand.updateMany({
          where: { id: brandId },
          data: { id: brandId },
        });
        if (locked.count !== 1) {
          throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
        }

        const existingCount = await tx.brandProductLine.count({
          where: { brandId },
        });
        if (existingCount >= BRAND_MAX_PRODUCT_LINES) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            `单品牌最多配置 ${BRAND_MAX_PRODUCT_LINES} 条产品线`,
          );
        }

        return tx.brandProductLine.create({
          data: {
            tenantId,
            brandId,
            name,
            localNamesJson: localNamesJson as unknown as Prisma.InputJsonValue,
            category,
            localCategoriesJson: localCategoriesJson as unknown as Prisma.InputJsonValue,
            seedPromptsJson: seedPromptsJson as unknown as Prisma.InputJsonValue,
            competitorsJson: competitorsJson as unknown as Prisma.InputJsonValue,
            sortOrder,
          },
        });
      });
      return presentProductLine(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同品牌下已存在同名产品线');
      }
      throw error;
    }
  }

  async update(
    tenantId: string,
    userId: string,
    brandId: string,
    lineId: string,
    input: ParsedUpdateProductLineInput,
  ): Promise<BrandProductLineDto> {
    await this.assertBrandExists(brandId);
    const existing = await this.prisma.scoped.brandProductLine.findFirst({
      where: { id: lineId, brandId },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '产品线不存在');
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextCategory = input.category !== undefined ? input.category.trim() : existing.category;
    const nextLocalNames =
      input.localNamesJson !== undefined
        ? normalizeLocalStringMap(input.localNamesJson)
        : readLocalStringMap(existing.localNamesJson);
    const nextLocalCategories =
      input.localCategoriesJson !== undefined
        ? normalizeLocalStringMap(input.localCategoriesJson)
        : readLocalStringMap(existing.localCategoriesJson);
    const nextSeedPrompts =
      input.seedPromptsJson !== undefined
        ? normalizeSeedPromptsMap(input.seedPromptsJson)
        : readSeedPromptsMap(existing.seedPromptsJson);
    const nextCompetitors =
      input.competitorsJson !== undefined
        ? normalizeCompetitorsMap(input.competitorsJson)
        : readCompetitorsMap(existing.competitorsJson);

    const hasTextChanges =
      input.name !== undefined ||
      input.category !== undefined ||
      input.localNamesJson !== undefined ||
      input.localCategoriesJson !== undefined ||
      input.seedPromptsJson !== undefined ||
      input.competitorsJson !== undefined;

    if (hasTextChanges) {
      await this.compliance.assertAllowed({
        text: collectComplianceText({
          name: nextName,
          category: nextCategory,
          localNamesJson: nextLocalNames,
          localCategoriesJson: nextLocalCategories,
          seedPromptsJson: nextSeedPrompts,
          competitorsJson: nextCompetitors,
        }),
        action: 'brand_product_line_update',
        tenantId,
        userId,
      });
    }

    const data: Prisma.BrandProductLineUpdateInput = {};
    if (input.name !== undefined) data.name = nextName;
    if (input.category !== undefined) data.category = nextCategory;
    if (input.localNamesJson !== undefined) {
      data.localNamesJson = nextLocalNames as unknown as Prisma.InputJsonValue;
    }
    if (input.localCategoriesJson !== undefined) {
      data.localCategoriesJson = nextLocalCategories as unknown as Prisma.InputJsonValue;
    }
    if (input.seedPromptsJson !== undefined) {
      data.seedPromptsJson = nextSeedPrompts as unknown as Prisma.InputJsonValue;
    }
    if (input.competitorsJson !== undefined) {
      data.competitorsJson = nextCompetitors as unknown as Prisma.InputJsonValue;
    }
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    try {
      const updated = await this.prisma.scoped.brandProductLine.update({
        where: { id: existing.id },
        data,
      });
      return presentProductLine(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, BILLING_ERROR.CONFLICT, '同品牌下已存在同名产品线');
      }
      throw error;
    }
  }

  async remove(brandId: string, lineId: string): Promise<BrandProductLineDeleteResponse> {
    await this.assertBrandExists(brandId);
    const res = await this.prisma.scoped.brandProductLine.deleteMany({
      where: { id: lineId, brandId },
    });
    if (res.count !== 1) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '产品线不存在');
    }
    return { deleted: 1, id: lineId };
  }

  async resolveOptionalForBrand(
    brandId: string,
    productLineId?: string | null,
  ): Promise<BrandProductLineDto | null> {
    if (productLineId === undefined || productLineId === null) {
      return null;
    }
    const trimmed = productLineId.trim();
    if (!trimmed) return null;
    if (!BRAND_ID_PATTERN.test(trimmed)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
    }
    const row = await this.prisma.scoped.brandProductLine.findFirst({
      where: { id: trimmed, brandId },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所属产品线不存在或不属于当前品牌');
    }
    return presentProductLine(row);
  }

  async assertBelongsToBrand(brandId: string, productLineId: string): Promise<BrandProductLineDto> {
    const resolved = await this.resolveOptionalForBrand(brandId, productLineId);
    if (!resolved) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
    }
    return resolved;
  }

  async assertAllBelongToBrand(
    brandId: string,
    productLineIds: readonly string[],
  ): Promise<Map<string, BrandProductLineDto>> {
    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const raw of productLineIds) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (!BRAND_ID_PATTERN.test(trimmed)) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '产品线编号不正确');
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        uniqueIds.push(trimmed);
      }
    }
    const out = new Map<string, BrandProductLineDto>();
    if (uniqueIds.length === 0) {
      return out;
    }
    const rows = await this.prisma.scoped.brandProductLine.findMany({
      where: { brandId, id: { in: uniqueIds } },
    });
    if (rows.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所属产品线不存在或不属于当前品牌');
    }
    for (const row of rows) {
      out.set(row.id, presentProductLine(row));
    }
    return out;
  }

  private async assertBrandExists(brandId: string): Promise<void> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }
  }
}

export function presentProductLine(row: BrandProductLineRow): BrandProductLineDto {
  return {
    id: row.id,
    brandId: row.brandId,
    name: row.name,
    localNamesJson: readLocalStringMap(row.localNamesJson),
    category: row.category,
    localCategoriesJson: readLocalStringMap(row.localCategoriesJson),
    seedPromptsJson: readSeedPromptsMap(row.seedPromptsJson),
    competitorsJson: readCompetitorsMap(row.competitorsJson),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeLocalStringMap(
  raw: ProductLineLocalNames | ProductLineLocalCategories | undefined,
): ProductLineLocalNames {
  if (!raw) return {};
  const out: ProductLineLocalNames = {};
  const cn = typeof raw.CN === 'string' ? raw.CN.trim() : '';
  const global = typeof raw.GLOBAL === 'string' ? raw.GLOBAL.trim() : '';
  if (cn) out.CN = cn;
  if (global) out.GLOBAL = global;
  return out;
}

function readLocalStringMap(raw: unknown): ProductLineLocalNames {
  const out: ProductLineLocalNames = {};
  const cn = readProductLineMarketString(raw, 'CN');
  const global = readProductLineMarketString(raw, 'GLOBAL');
  if (cn) out.CN = cn;
  if (global) out.GLOBAL = global;
  return out;
}

function normalizeSeedPromptsMap(raw: ProductLineSeedPrompts | undefined): ProductLineSeedPrompts {
  if (!raw) return {};
  const out: ProductLineSeedPrompts = {};
  if (Array.isArray(raw.CN)) {
    out.CN = readProductLineMarketSeedPrompts({ CN: raw.CN }, 'CN');
  }
  if (Array.isArray(raw.GLOBAL)) {
    out.GLOBAL = readProductLineMarketSeedPrompts({ GLOBAL: raw.GLOBAL }, 'GLOBAL');
  }
  return out;
}

function readSeedPromptsMap(raw: unknown): ProductLineSeedPrompts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = raw as Record<string, unknown>;
  const out: ProductLineSeedPrompts = {};
  if (Array.isArray(map.CN)) {
    out.CN = readProductLineMarketSeedPrompts(raw, 'CN');
  }
  if (Array.isArray(map.GLOBAL)) {
    out.GLOBAL = readProductLineMarketSeedPrompts(raw, 'GLOBAL');
  }
  return out;
}

function normalizeCompetitorsMap(raw: ProductLineCompetitors | undefined): ProductLineCompetitors {
  if (!raw) return {};
  const out: ProductLineCompetitors = {};
  if (Array.isArray(raw.CN)) {
    out.CN = readProductLineMarketCompetitors({ CN: raw.CN }, 'CN');
  }
  if (Array.isArray(raw.GLOBAL)) {
    out.GLOBAL = readProductLineMarketCompetitors({ GLOBAL: raw.GLOBAL }, 'GLOBAL');
  }
  return out;
}

function readCompetitorsMap(raw: unknown): ProductLineCompetitors {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = raw as Record<string, unknown>;
  const out: ProductLineCompetitors = {};
  if (Array.isArray(map.CN)) {
    out.CN = readProductLineMarketCompetitors(raw, 'CN');
  }
  if (Array.isArray(map.GLOBAL)) {
    out.GLOBAL = readProductLineMarketCompetitors(raw, 'GLOBAL');
  }
  return out;
}

function collectComplianceText(params: {
  name: string;
  category: string;
  localNamesJson: ProductLineLocalNames;
  localCategoriesJson: ProductLineLocalCategories;
  seedPromptsJson: ProductLineSeedPrompts;
  competitorsJson: ProductLineCompetitors;
}): string {
  return [
    params.name,
    params.category,
    params.localNamesJson.CN ?? '',
    params.localNamesJson.GLOBAL ?? '',
    params.localCategoriesJson.CN ?? '',
    params.localCategoriesJson.GLOBAL ?? '',
    ...(params.seedPromptsJson.CN ?? []),
    ...(params.seedPromptsJson.GLOBAL ?? []),
    ...(params.competitorsJson.CN ?? []).flatMap((c) => [c.name, ...c.aliases]),
    ...(params.competitorsJson.GLOBAL ?? []).flatMap((c) => [c.name, ...c.aliases]),
  ]
    .filter((item) => item.trim().length > 0)
    .join('\n');
}
