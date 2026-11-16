import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  escapeLikeLiteral,
  type CrudListQuery,
  type SampleInput,
  type SampleRecord,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';

/**
 * 列表示例只读写当前租户的 CrudSample。
 * 查询走带 tenantId 的 Prisma 条件，不用原始 SQL，也不读取知识库切片。
 * 这里不调用计费，也不访问外部模型。
 */
@Injectable()
export class SamplesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async page(query: CrudListQuery): Promise<{
    items: SampleRecord[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.scoped.crudSample.count({ where }),
      this.prisma.scoped.crudSample.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(present),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async collect(query: CrudListQuery): Promise<SampleRecord[]> {
    const rows = await this.prisma.scoped.crudSample.findMany({
      where: this.where(query),
      orderBy: this.orderBy(query),
      take: CRUD_EXPORT_LIMIT + 1,
    });
    if (rows.length > CRUD_EXPORT_LIMIT) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '导出条数过多');
    }
    return rows.map(present);
  }

  async one(id: string): Promise<SampleRecord> {
    const row = await this.prisma.scoped.crudSample.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    if (!row) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    return present(row);
  }

  async create(input: SampleInput): Promise<SampleRecord> {
    try {
      const row = await this.prisma.scoped.crudSample.create({
        data: {
          tenantId: this.tenantId(),
          name: input.name,
          note: input.note,
          enabled: input.enabled,
        },
      });
      return present(row);
    } catch (error) {
      if (isUnique(error)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '名称已存在');
      throw error;
    }
  }

  async update(id: string, input: SampleInput): Promise<SampleRecord> {
    const tenantId = this.tenantId();
    const existing = await this.prisma.scoped.crudSample.findFirst({ where: { id, tenantId } });
    if (!existing) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    try {
      const row = await this.prisma.scoped.crudSample.update({
        where: { id },
        data: { name: input.name, note: input.note, enabled: input.enabled },
      });
      return present(row);
    } catch (error) {
      if (isUnique(error)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '名称已存在');
      throw error;
    }
  }

  async bulk(
    action: 'delete' | 'enable' | 'disable',
    ids: string[],
  ): Promise<{ affected: number }> {
    const tenantId = this.tenantId();
    const unique = [...new Set(ids)];
    const found = await this.prisma.scoped.crudSample.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    if (action === 'delete') {
      const result = await this.prisma.scoped.crudSample.deleteMany({
        where: { tenantId, id: { in: unique } },
      });
      return { affected: result.count };
    }
    const result = await this.prisma.scoped.crudSample.updateMany({
      where: { tenantId, id: { in: unique } },
      data: { enabled: action === 'enable' },
    });
    return { affected: result.count };
  }

  private where(query: CrudListQuery): Prisma.CrudSampleWhereInput {
    const where: Prisma.CrudSampleWhereInput = { tenantId: this.tenantId() };
    if (query.keyword) {
      const keyword = escapeLikeLiteral(query.keyword);
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { note: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    if (query.enabled !== undefined) where.enabled = query.enabled;
    return where;
  }

  private orderBy(query: CrudListQuery): Prisma.CrudSampleOrderByWithRelationInput {
    if (query.sort === 'name') return { name: query.order };
    if (query.sort === 'updatedAt') return { updatedAt: query.order };
    return { createdAt: query.order };
  }

  private tenantId(): string {
    const tenantId = currentTenantId();
    if (!tenantId) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return tenantId;
  }
}

function present(row: {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SampleRecord {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
