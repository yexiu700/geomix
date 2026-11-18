import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  CRUD_EXPORT_LIMIT,
  KB_AGREEMENT_KIND,
  KB_AGREEMENT_VERSION,
  KB_UNSIGNED_ERROR_MSG,
  emptyKbDetailFields,
  requiresKbVectorIndex,
  type AgreementSignInput,
  type AgreementStatusView,
  type KbDetailFields,
  type KbIndexStatusName,
  type KbModeName,
  type KnowledgeBaseListQuery,
  type KnowledgeBaseListResponse,
  type KnowledgeBaseRecord,
  type KnowledgeWriteInput,
} from '@geomix/shared';
import { TX_OPTIONS } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducer } from '../queue/queue.producer';
import { currentTenantId } from '../tenant/tenant-context';

type KbRow = {
  id: string;
  name: string;
  mode: KbModeName;
  companyName: string | null;
  brandShort: string | null;
  directions: string[];
  copyTypes: string[];
  fields: Prisma.JsonValue | null;
  summaryText: string | null;
  indexStatus: KbIndexStatusName;
  signatureId: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { chunks: number };
};

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return tenantId;
}

function normalizeDetailFields(raw: Prisma.JsonValue | null): KbDetailFields {
  const base = emptyKbDetailFields();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const obj = raw as Record<string, unknown>;
  return {
    productService: typeof obj.productService === 'string' ? obj.productService : '',
    productFeature: typeof obj.productFeature === 'string' ? obj.productFeature : '',
    brandStory: typeof obj.brandStory === 'string' ? obj.brandStory : '',
    painPoint: typeof obj.painPoint === 'string' ? obj.painPoint : '',
    trust: typeof obj.trust === 'string' ? obj.trust : '',
    cases: typeof obj.cases === 'string' ? obj.cases : '',
    other: typeof obj.other === 'string' ? obj.other : '',
  };
}

function collectWriteText(input: KnowledgeWriteInput): string {
  if (input.mode === 'SUMMARY') {
    return [input.name, input.companyName, input.summaryText].filter(Boolean).join('\n');
  }
  return [
    input.name,
    input.companyName,
    input.brandShort,
    input.fields.productService,
    input.fields.productFeature,
    input.fields.brandStory,
    input.fields.painPoint,
    input.fields.trust,
    input.fields.cases,
    input.fields.other,
  ]
    .filter(Boolean)
    .join('\n');
}

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(QueueProducer) private readonly producer: QueueProducer,
  ) {}

  async getAgreementStatus(
    kind: string = KB_AGREEMENT_KIND,
    version: string = KB_AGREEMENT_VERSION,
  ): Promise<AgreementStatusView> {
    const tenantId = requireTenant();
    const latest = await this.prisma.base.agreementSignature.findFirst({
      where: { tenantId, kind, version },
      orderBy: { signedAt: 'desc' },
    });
    return {
      kind,
      version,
      signed: Boolean(latest),
      signatureId: latest?.id ?? null,
      signedAt: latest ? latest.signedAt.toISOString() : null,
    };
  }

  async signAgreement(
    input: AgreementSignInput,
    meta: { userId: string; ip: string },
  ): Promise<AgreementStatusView> {
    const tenantId = requireTenant();
    const signed = await this.prisma.base.$transaction(async (tx) => {
      const created = await tx.agreementSignature.create({
        data: {
          tenantId,
          userId: meta.userId,
          kind: input.kind,
          version: input.version,
          ip: meta.ip,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: meta.userId,
          action: 'agreement_signed',
          payload: {
            kind: input.kind,
            version: input.version,
            signatureId: created.id,
            ip: meta.ip,
          },
        },
      });
      return created;
    }, TX_OPTIONS);

    return {
      kind: signed.kind,
      version: signed.version,
      signed: true,
      signatureId: signed.id,
      signedAt: signed.signedAt.toISOString(),
    };
  }

  async page(query: KnowledgeBaseListQuery): Promise<KnowledgeBaseListResponse> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows, agreement] = await Promise.all([
      this.prisma.base.knowledgeBase.count({ where }),
      this.prisma.base.knowledgeBase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        include: { _count: { select: { chunks: true } } },
      }) as Promise<KbRow[]>,
      this.getAgreementStatus(),
    ]);

    return {
      items: rows.map((row) => this.present(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      agreement,
    };
  }

  async exportRows(query: KnowledgeBaseListQuery): Promise<KnowledgeBaseRecord[]> {
    const tenantId = requireTenant();
    const where = this.buildWhere(tenantId, query);
    const rows = (await this.prisma.base.knowledgeBase.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: CRUD_EXPORT_LIMIT,
      include: { _count: { select: { chunks: true } } },
    })) as KbRow[];
    return rows.map((row) => this.present(row));
  }

  async findOne(id: string): Promise<KnowledgeBaseRecord> {
    const tenantId = requireTenant();
    const row = (await this.prisma.base.knowledgeBase.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { chunks: true } } },
    })) as KbRow | null;
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '企业知识库不存在');
    }
    return this.present(row);
  }

  async create(input: KnowledgeWriteInput, userId: string): Promise<KnowledgeBaseRecord> {
    const tenantId = requireTenant();
    const signature = await this.requireActiveSignature(tenantId);

    await this.compliance.assertAllowed({
      text: collectWriteText(input),
      action: 'kb_write',
      tenantId,
      userId,
    });

    const summaryText = input.mode === 'SUMMARY' ? input.summaryText : null;
    const needsIndex = requiresKbVectorIndex(input.mode, summaryText);

    const created = (await this.prisma.base.knowledgeBase.create({
      data:
        input.mode === 'DETAIL'
          ? {
              tenantId,
              name: input.name,
              mode: 'DETAIL',
              companyName: input.companyName,
              brandShort: input.brandShort,
              directions: input.directions,
              copyTypes: input.copyTypes,
              fields: input.fields,
              summaryText: null,
              indexStatus: 'NONE',
              signatureId: signature.id,
            }
          : {
              tenantId,
              name: input.name,
              mode: 'SUMMARY',
              companyName: input.companyName?.trim() || null,
              brandShort: null,
              directions: [],
              copyTypes: [],
              fields: Prisma.DbNull,
              summaryText: input.summaryText,
              indexStatus: needsIndex ? 'INDEXING' : 'NONE',
              signatureId: signature.id,
            },
      include: { _count: { select: { chunks: true } } },
    })) as KbRow;

    if (needsIndex) {
      await this.dispatchIndex(tenantId, created.id);
    }

    return this.present(created);
  }

  async update(
    id: string,
    input: KnowledgeWriteInput,
    userId: string,
  ): Promise<KnowledgeBaseRecord> {
    const tenantId = requireTenant();
    const existing = await this.prisma.base.knowledgeBase.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '企业知识库不存在');
    }

    const signature = await this.requireActiveSignature(tenantId);

    await this.compliance.assertAllowed({
      text: collectWriteText(input),
      action: 'kb_write',
      tenantId,
      userId,
    });

    const summaryText = input.mode === 'SUMMARY' ? input.summaryText : null;
    const needsIndex = requiresKbVectorIndex(input.mode, summaryText);

    const updated = (await this.prisma.base.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { kbId: id } });
      return tx.knowledgeBase.update({
        where: { id },
        data:
          input.mode === 'DETAIL'
            ? {
                name: input.name,
                mode: 'DETAIL',
                companyName: input.companyName,
                brandShort: input.brandShort,
                directions: input.directions,
                copyTypes: input.copyTypes,
                fields: input.fields,
                summaryText: null,
                indexStatus: 'NONE',
                signatureId: signature.id,
              }
            : {
                name: input.name,
                mode: 'SUMMARY',
                companyName: input.companyName?.trim() || null,
                brandShort: null,
                directions: [],
                copyTypes: [],
                fields: Prisma.DbNull,
                summaryText: input.summaryText,
                indexStatus: needsIndex ? 'INDEXING' : 'NONE',
                signatureId: signature.id,
              },
        include: { _count: { select: { chunks: true } } },
      });
    }, TX_OPTIONS)) as KbRow;

    if (needsIndex) {
      await this.dispatchIndex(tenantId, updated.id);
    }

    return this.present(updated);
  }

  async removeMany(ids: readonly string[]): Promise<{ deleted: number }> {
    const tenantId = requireTenant();
    const uniqueIds = Array.from(new Set(ids));
    const found = await this.prisma.base.knowledgeBase.findMany({
      where: { tenantId, id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '企业知识库不存在');
    }

    const activeTaskCount = await this.prisma.base.aiTask.count({
      where: {
        tenantId,
        kbId: { in: uniqueIds },
        status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      },
    });
    if (activeTaskCount > 0) {
      throw new ApiError(
        409,
        API_ERROR.BAD_REQUEST,
        '所选知识库正被进行中的写作任务引用，禁止删除',
      );
    }

    const res = await this.prisma.base.knowledgeBase.deleteMany({
      where: { tenantId, id: { in: uniqueIds } },
    });
    return { deleted: res.count };
  }

  async assertAgreementSigned(): Promise<{ id: string }> {
    const tenantId = requireTenant();
    return this.requireActiveSignature(tenantId);
  }

  private async requireActiveSignature(tenantId: string): Promise<{ id: string }> {
    const latest = await this.prisma.base.agreementSignature.findFirst({
      where: {
        tenantId,
        kind: KB_AGREEMENT_KIND,
        version: KB_AGREEMENT_VERSION,
      },
      orderBy: { signedAt: 'desc' },
      select: { id: true },
    });
    if (!latest) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, KB_UNSIGNED_ERROR_MSG);
    }
    return latest;
  }

  private async dispatchIndex(tenantId: string, kbId: string): Promise<void> {
    try {
      await this.producer.enqueueKbIndex({ tenantId, kbId });
    } catch (error) {
      await this.prisma.base.knowledgeBase
        .updateMany({
          where: { id: kbId, tenantId },
          data: { indexStatus: 'FAILED' },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private buildWhere(
    tenantId: string,
    query: KnowledgeBaseListQuery,
  ): Prisma.KnowledgeBaseWhereInput {
    const where: Prisma.KnowledgeBaseWhereInput = { tenantId };
    if (query.mode) {
      where.mode = query.mode;
    }
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { companyName: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  private present(row: KbRow): KnowledgeBaseRecord {
    const isDetail = row.mode === 'DETAIL';
    return {
      id: row.id,
      name: row.name,
      mode: row.mode,
      companyName: isDetail ? (row.companyName ?? '') : (row.companyName ?? null),
      brandShort: isDetail ? (row.brandShort ?? '') : null,
      directions: isDetail ? row.directions : [],
      copyTypes: isDetail ? row.copyTypes : [],
      fields: isDetail ? normalizeDetailFields(row.fields) : null,
      summaryText: isDetail ? null : (row.summaryText ?? ''),
      indexStatus: row.indexStatus,
      chunkCount: row._count.chunks,
      signatureId: row.signatureId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
