import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUTH_ERROR,
  MODEL_INCLUSION_CARDS,
  QUOTA_DEFAULTS,
  buildRightsCards,
  emptyModelInclusions,
  escapeLikeLiteral,
  formatLedgerTime,
  formatMoney,
  formatPointsCell,
  parseEnv,
  pointLedgerPhrase,
  resolveTenantBillingMode,
  type ModelInclusionKey,
  type MoneyListQuery,
  type PointListQuery,
  type QuotaKeyName,
  type VerificationInput,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { ComplianceService } from '../infra/compliance';
import { PrismaService } from '../prisma/prisma.service';

export type PointItem = {
  id: string;
  title: string;
  delta: number;
  listPrice: number;
  phrase: string;
  pointsText: string;
  createdAt: string;
  status: string;
};

export type MoneyItem = {
  id: string;
  title: string;
  amount: string;
  remark: string;
  createdAt: string;
};

export type LedgerPage<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

/**
 * 个人中心只读当前登录租户。
 * 查询条件里没有租户编号，调用方传入的 tenantId 来自登录态。
 */
@Injectable()
export class MeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(ComplianceService)
    private readonly compliance: ComplianceService = new ComplianceService(),
  ) {}

  async points(tenantId: string, query: PointListQuery): Promise<LedgerPage<PointItem>> {
    const where = pointWhere(tenantId, query);
    const orderBy = pointOrder(query);
    const [total, rows] = await Promise.all([
      this.prisma.base.pointLog.count({ where }),
      this.prisma.base.pointLog.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(presentPoint) };
  }

  async collectPoints(
    tenantId: string,
    query: PointListQuery,
    limit: number,
  ): Promise<PointItem[]> {
    const rows = await this.prisma.base.pointLog.findMany({
      where: pointWhere(tenantId, query),
      orderBy: pointOrder(query),
      take: limit,
    });
    return rows.map(presentPoint);
  }

  async money(tenantId: string, query: MoneyListQuery): Promise<LedgerPage<MoneyItem>> {
    const where = moneyWhere(tenantId, query);
    const orderBy = moneyOrder(query);
    const [total, rows] = await Promise.all([
      this.prisma.base.moneyLog.count({ where }),
      this.prisma.base.moneyLog.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(presentMoney) };
  }

  async collectMoney(tenantId: string, query: MoneyListQuery, limit: number): Promise<MoneyItem[]> {
    const rows = await this.prisma.base.moneyLog.findMany({
      where: moneyWhere(tenantId, query),
      orderBy: moneyOrder(query),
      take: limit,
    });
    return rows.map(presentMoney);
  }

  async rights(tenantId: string) {
    const tenant = await this.prisma.base.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, expiresAt: true, isActive: true, billingMode: true },
    });
    if (!tenant) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '账号不存在');
    const wallet = await this.prisma.base.wallet.findUnique({ where: { tenantId } });
    if (!wallet) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '钱包不存在');
    const [quotas, included, models, liveUsage] = await Promise.all([
      this.prisma.base.quota.findMany({ where: { tenantId } }),
      this.prisma.base.question.count({
        where: { tenantId, included: true },
      }),
      this.computeModelInclusions(tenantId),
      this.computeLiveQuotaUsage(tenantId),
    ]);
    const quotaByKey = new Map(quotas.map((row) => [row.key as QuotaKeyName, row]));
    const reconciledQuotas = QUOTA_DEFAULTS.map((item) => {
      const stored = quotaByKey.get(item.key);
      const storedUsed = stored?.used ?? 0n;
      const liveUsed = liveUsage[item.key] ?? 0n;
      return {
        key: item.key,
        used: liveUsed > storedUsed ? liveUsed : storedUsed,
        limit: stored?.limit ?? BigInt(item.limit),
      };
    });
    const resolved = resolveTenantBillingMode(tenant.billingMode, parseEnv().BILLING_MODE);
    const readOnly = !tenant.isActive || tenant.expiresAt.getTime() <= Date.now();
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        expiresAt: tenant.expiresAt.toISOString(),
        isActive: tenant.isActive,
        readOnly,
      },
      billingMode: resolved.mode,
      billingModeSource: resolved.source,
      points: wallet.points,
      pointsReserved: wallet.pointsReserved,
      available: wallet.points - wallet.pointsReserved,
      money: formatMoney(wallet.money.toString()),
      cards: buildRightsCards({
        quotas: reconciledQuotas,
        included,
        expiresOn: formatLedgerTime(tenant.expiresAt.toISOString()).slice(0, 10),
        points: wallet.points,
        money: wallet.money.toString(),
      }),
      models,
    };
  }

  private async computeLiveQuotaUsage(
    tenantId: string,
  ): Promise<Partial<Record<QuotaKeyName, bigint>>> {
    const base = this.prisma.base as unknown as {
      keyword?: { count?: (args: { where: { tenantId: string } }) => Promise<number> };
      question?: { count?: (args: { where: { tenantId: string } }) => Promise<number> };
      article?: {
        count?: (args: { where: { tenantId: string; source: 'AI_TASK' } }) => Promise<number>;
      };
      mediaAsset?: {
        aggregate?: (args: {
          where: { tenantId: string };
          _sum: { bytes: true };
        }) => Promise<{ _sum?: { bytes?: number | bigint | null } }>;
      };
    };

    const [keywordCount, questionCount, aiWriteCount, storageAgg] = await Promise.all([
      typeof base.keyword?.count === 'function'
        ? base.keyword.count({ where: { tenantId } })
        : Promise.resolve(0),
      typeof base.question?.count === 'function'
        ? base.question.count({ where: { tenantId } })
        : Promise.resolve(0),
      typeof base.article?.count === 'function'
        ? base.article.count({ where: { tenantId, source: 'AI_TASK' } })
        : Promise.resolve(0),
      typeof base.mediaAsset?.aggregate === 'function'
        ? base.mediaAsset.aggregate({ where: { tenantId }, _sum: { bytes: true } })
        : Promise.resolve({ _sum: { bytes: 0 } }),
    ]);

    const rawBytes = storageAgg?._sum?.bytes ?? 0;
    const storageBytes = typeof rawBytes === 'bigint' ? rawBytes : BigInt(Math.max(0, rawBytes));
    return {
      MAIN_KEYWORD: BigInt(Math.max(0, keywordCount)),
      QUESTION: BigInt(Math.max(0, questionCount)),
      AI_WRITE: BigInt(Math.max(0, aiWriteCount)),
      STORAGE_BYTES: storageBytes,
    };
  }

  private async computeModelInclusions(
    tenantId: string,
  ): Promise<Array<{ key: ModelInclusionKey; label: string; count: number }>> {
    const delegate = (
      this.prisma.base as unknown as {
        visibilityObservation?: {
          findMany?: (args: {
            where: {
              tenantId: string;
              status: 'SUCCESS';
              brandMentioned: true;
              engine: { in: string[] };
            };
            select: { engine: true; questionId: true; promptText: true };
          }) => Promise<Array<{ engine: string; questionId: string | null; promptText: string }>>;
        };
      }
    ).visibilityObservation;

    if (!delegate?.findMany) {
      return emptyModelInclusions();
    }

    const engineKeys = MODEL_INCLUSION_CARDS.map((card) => card.key);
    const rows = await delegate.findMany({
      where: {
        tenantId,
        status: 'SUCCESS',
        brandMentioned: true,
        engine: { in: engineKeys },
      },
      select: {
        engine: true,
        questionId: true,
        promptText: true,
      },
    });

    const dedupedByEngine = new Map<string, Set<string>>();
    for (const row of rows) {
      const engineKey = row.engine.trim().toLowerCase();
      const questionKey = row.questionId
        ? `q:${row.questionId}`
        : `p:${row.promptText.replace(/\s+/g, ' ').trim().toLowerCase()}`;
      let set = dedupedByEngine.get(engineKey);
      if (!set) {
        set = new Set<string>();
        dedupedByEngine.set(engineKey, set);
      }
      set.add(questionKey);
    }

    return MODEL_INCLUSION_CARDS.map((card) => ({
      key: card.key,
      label: card.label,
      count: dedupedByEngine.get(card.key)?.size ?? 0,
    }));
  }

  async verification(tenantId: string) {
    const row = await this.prisma.base.verification.findUnique({ where: { tenantId } });
    if (!row) return null;
    return presentVerification(row);
  }

  /** 占位提交。只把资料记成 SUBMITTED，不调用外部核验，也不会写成已通过。 */
  async submitVerification(tenantId: string, userId: string, input: VerificationInput) {
    await this.compliance.assertAllowed({
      text: [input.companyName, input.contact].filter(Boolean).join('\n'),
      action: 'verification_submit',
      tenantId,
      userId,
    });
    const row = await this.prisma.base.verification.upsert({
      where: { tenantId },
      create: {
        tenantId,
        companyName: input.companyName,
        creditCode: input.creditCode,
        contact: input.contact,
        phone: input.phone,
        status: 'SUBMITTED',
      },
      update: {
        companyName: input.companyName,
        creditCode: input.creditCode,
        contact: input.contact,
        phone: input.phone,
        status: 'SUBMITTED',
      },
    });
    await this.prisma.base.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'verification_submit',
        payload: { status: 'SUBMITTED' },
      },
    });
    return presentVerification(row);
  }

  async announcements() {
    const rows = await this.prisma.base.announcement.findMany({
      where: { enabled: true },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      select: { id: true, content: true, sort: true },
    });
    return { items: rows };
  }
}

function pointWhere(tenantId: string, query: PointListQuery): Prisma.PointLogWhereInput {
  const where: Prisma.PointLogWhereInput = { tenantId };
  if (query.title) where.title = { contains: escapeLikeLiteral(query.title), mode: 'insensitive' };
  if (query.delta !== undefined) where.delta = query.delta;
  const createdAt = timeRange(query.from, query.to);
  if (createdAt) where.createdAt = createdAt;
  return where;
}

function moneyWhere(tenantId: string, query: MoneyListQuery): Prisma.MoneyLogWhereInput {
  const where: Prisma.MoneyLogWhereInput = { tenantId };
  if (query.title) where.title = { contains: escapeLikeLiteral(query.title), mode: 'insensitive' };
  if (query.amount) where.amount = new Prisma.Decimal(query.amount);
  const createdAt = timeRange(query.from, query.to);
  if (createdAt) where.createdAt = createdAt;
  return where;
}

function timeRange(from: string | undefined, to: string | undefined) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lte: new Date(to) } : {}),
  };
}

function pointOrder(query: PointListQuery): Prisma.PointLogOrderByWithRelationInput[] {
  return [{ [query.sort]: query.order }, { id: 'desc' }];
}

function moneyOrder(query: MoneyListQuery): Prisma.MoneyLogOrderByWithRelationInput[] {
  return [{ [query.sort]: query.order }, { id: 'desc' }];
}

function presentPoint(row: {
  id: string;
  title: string;
  delta: number;
  listPrice: number;
  createdAt: Date;
  status: string;
}): PointItem {
  return {
    id: row.id,
    title: row.title,
    delta: row.delta,
    listPrice: row.listPrice,
    phrase: pointLedgerPhrase(row.delta, row.title),
    pointsText: formatPointsCell(row.delta, row.listPrice),
    createdAt: row.createdAt.toISOString(),
    status: row.status,
  };
}

function presentMoney(row: {
  id: string;
  title: string;
  amount: Prisma.Decimal;
  remark: string | null;
  createdAt: Date;
}): MoneyItem {
  return {
    id: row.id,
    title: row.title,
    amount: formatMoney(row.amount.toString()),
    remark: row.remark ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

function presentVerification(row: {
  companyName: string;
  creditCode: string;
  contact: string | null;
  phone: string | null;
  status: string;
  updatedAt: Date;
}) {
  return {
    companyName: row.companyName,
    creditCode: row.creditCode,
    contact: row.contact ?? '',
    phone: row.phone ?? '',
    status: row.status,
    placeholder: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}
