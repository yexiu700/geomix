import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PromptKind } from '@prisma/client';
import { buildSeedWrites, readSeedConfig } from '@geomix/db';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  PROMPT_NAME_MAX,
  PROMPT_SYSTEM_READONLY_MSG,
  analyzePromptWarnings,
  computePromptRandomPool,
  hasManualBrandSlot,
  type PromptCloneInput,
  type PromptKindName,
  type PromptListQuery,
  type PromptListResponse,
  type PromptOptionsResponse,
  type PromptTemplateRecord,
  type PromptWriteInput,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

type PromptRow = {
  id: string;
  tenantId: string | null;
  kind: PromptKindName;
  name: string;
  content: string;
  randomPool: boolean;
  sort: number;
  clonedFrom: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return tenantId;
}

@Injectable()
export class PromptsService {
  private seededOnce = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async ensureSystemTemplates(): Promise<void> {
    if (this.seededOnce) return;
    const existingCount = await this.prisma.base.promptTemplate.count({
      where: { tenantId: null },
    });
    if (existingCount > 0) {
      this.seededOnce = true;
      return;
    }
    const seed = buildSeedWrites({ config: readSeedConfig(), now: new Date() });
    await this.prisma.base.$transaction(async (tx) => {
      for (const tpl of seed.templates) {
        await tx.promptTemplate.upsert({
          where: { id: tpl.id },
          create: {
            id: tpl.id,
            tenantId: null,
            kind: PromptKind[tpl.kind],
            name: tpl.name,
            content: tpl.content,
            randomPool: tpl.randomPool,
            sort: tpl.sort,
          },
          update: {},
        });
      }
    }, TX_OPTIONS);
    this.seededOnce = true;
  }

  async pageUser(query: PromptListQuery): Promise<PromptListResponse> {
    const tenantId = requireTenant();
    const where = this.buildUserWhere(tenantId, query);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.base.promptTemplate.count({ where }),
      this.prisma.base.promptTemplate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
      }) as Promise<PromptRow[]>,
    ]);

    return {
      items: rows.map((row) => this.present(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async exportUserRows(query: PromptListQuery): Promise<PromptTemplateRecord[]> {
    const tenantId = requireTenant();
    const where = this.buildUserWhere(tenantId, query);
    const rows = (await this.prisma.base.promptTemplate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: CRUD_EXPORT_LIMIT,
    })) as PromptRow[];
    return rows.map((row) => this.present(row));
  }

  async listSystem(kind?: PromptKindName): Promise<{ items: PromptTemplateRecord[] }> {
    requireTenant();
    await this.ensureSystemTemplates();
    const rows = (await this.prisma.base.promptTemplate.findMany({
      where: {
        tenantId: null,
        ...(kind ? { kind } : {}),
      },
      orderBy: [{ kind: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
    })) as PromptRow[];
    return { items: rows.map((row) => this.present(row)) };
  }

  async optionsByKind(kind: PromptKindName): Promise<PromptOptionsResponse> {
    const tenantId = requireTenant();
    await this.ensureSystemTemplates();
    const [sysRows, userRows] = await Promise.all([
      this.prisma.base.promptTemplate.findMany({
        where: { tenantId: null, kind },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      }) as Promise<PromptRow[]>,
      this.prisma.base.promptTemplate.findMany({
        where: { tenantId, kind },
        orderBy: { createdAt: 'desc' },
      }) as Promise<PromptRow[]>,
    ]);
    return {
      kind,
      system: sysRows.map((row) => this.present(row)),
      user: userRows.map((row) => this.present(row)),
    };
  }

  async findOne(id: string): Promise<PromptTemplateRecord> {
    const tenantId = requireTenant();
    await this.ensureSystemTemplates();
    const row = (await this.prisma.base.promptTemplate.findFirst({
      where: {
        id,
        OR: [{ tenantId: null }, { tenantId }],
      },
    })) as PromptRow | null;
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作指令不存在');
    }
    return this.present(row);
  }

  async create(input: PromptWriteInput, userId: string): Promise<PromptTemplateRecord> {
    const tenantId = requireTenant();
    await this.compliance.assertAllowed({
      text: `${input.name}\n${input.content}`,
      action: 'prompt_write',
      tenantId,
      userId,
    });

    const randomPool = computePromptRandomPool(input.content);
    const created = (await this.prisma.base.promptTemplate.create({
      data: {
        tenantId,
        kind: PromptKind[input.kind],
        name: input.name,
        content: input.content,
        randomPool,
        sort: 0,
      },
    })) as PromptRow;
    return this.present(created);
  }

  async update(id: string, input: PromptWriteInput, userId: string): Promise<PromptTemplateRecord> {
    const tenantId = requireTenant();
    await this.ensureSystemTemplates();
    const existing = await this.prisma.base.promptTemplate.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作指令不存在');
    }
    if (existing.tenantId === null) {
      throw new ApiError(403, API_ERROR.BAD_REQUEST, PROMPT_SYSTEM_READONLY_MSG);
    }
    if (existing.tenantId !== tenantId) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作指令不存在');
    }

    await this.compliance.assertAllowed({
      text: `${input.name}\n${input.content}`,
      action: 'prompt_write',
      tenantId,
      userId,
    });

    const randomPool = computePromptRandomPool(input.content);
    const updated = (await this.prisma.base.promptTemplate.update({
      where: { id },
      data: {
        kind: PromptKind[input.kind],
        name: input.name,
        content: input.content,
        randomPool,
      },
    })) as PromptRow;
    return this.present(updated);
  }

  async clone(id: string, input: PromptCloneInput, userId: string): Promise<PromptTemplateRecord> {
    const tenantId = requireTenant();
    await this.ensureSystemTemplates();
    const source = (await this.prisma.base.promptTemplate.findFirst({
      where: {
        id,
        OR: [{ tenantId: null }, { tenantId }],
      },
    })) as PromptRow | null;
    if (!source) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '源指令不存在');
    }

    const customName = input.name?.trim();
    const defaultCloneName = Array.from(`${source.name}（副本）`)
      .slice(0, PROMPT_NAME_MAX)
      .join('');
    const nextName = customName && customName.length > 0 ? customName : defaultCloneName;

    await this.compliance.assertAllowed({
      text: `${nextName}\n${source.content}`,
      action: 'prompt_clone',
      tenantId,
      userId,
    });

    const cloned = (await this.prisma.base.promptTemplate.create({
      data: {
        tenantId,
        kind: PromptKind[source.kind],
        name: nextName,
        content: source.content,
        randomPool: computePromptRandomPool(source.content),
        sort: 0,
        clonedFrom: source.id,
      },
    })) as PromptRow;
    return this.present(cloned);
  }

  async removeMany(ids: readonly string[]): Promise<{ deleted: number }> {
    const tenantId = requireTenant();
    await this.ensureSystemTemplates();
    const uniqueIds = Array.from(new Set(ids));

    const found = await this.prisma.base.promptTemplate.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, tenantId: true },
    });
    if (found.some((row) => row.tenantId === null)) {
      throw new ApiError(403, API_ERROR.BAD_REQUEST, PROMPT_SYSTEM_READONLY_MSG);
    }
    const owned = found.filter((row) => row.tenantId === tenantId);
    if (owned.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '写作指令不存在');
    }

    const [activeAiTasks, activeBatches, activeRecords] = await Promise.all([
      this.prisma.base.aiTask.count({
        where: {
          tenantId,
          status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
          OR: [{ contentTplId: { in: uniqueIds } }, { titleTplId: { in: uniqueIds } }],
        },
      }),
      this.prisma.base.rewriteBatch.count({
        where: {
          tenantId,
          status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
          templateId: { in: uniqueIds },
        },
      }),
      this.prisma.base.rewriteRecord.count({
        where: {
          tenantId,
          status: { in: ['PENDING', 'RUNNING'] },
          templateId: { in: uniqueIds },
        },
      }),
    ]);

    if (activeAiTasks > 0 || activeBatches > 0 || activeRecords > 0) {
      throw new ApiError(409, API_ERROR.BAD_REQUEST, '所选指令正被进行中的任务引用，禁止删除');
    }

    const res = await this.prisma.base.promptTemplate.deleteMany({
      where: { tenantId, id: { in: uniqueIds } },
    });
    return { deleted: res.count };
  }

  private buildUserWhere(
    tenantId: string,
    query: PromptListQuery,
  ): Prisma.PromptTemplateWhereInput {
    const where: Prisma.PromptTemplateWhereInput = { tenantId };
    if (query.kind) {
      where.kind = query.kind;
    }
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { content: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  private present(row: PromptRow): PromptTemplateRecord {
    const manualSlot = hasManualBrandSlot(row.content);
    const effectiveRandomPool = row.randomPool && !manualSlot;
    return {
      id: row.id,
      tenantId: row.tenantId,
      isSystem: row.tenantId === null,
      kind: row.kind,
      name: row.name,
      content: row.content,
      randomPool: effectiveRandomPool,
      hasManualSlot: manualSlot,
      sort: row.sort,
      clonedFrom: row.clonedFrom,
      warnings: analyzePromptWarnings(row.kind, row.content),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
