import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PromptKind, QuotaKey } from '@prisma/client';
import { hashPassword } from '@geomix/db';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  QUOTA_DEFAULTS,
  formatMoney,
  isQuotaKeyName,
  parseEnv,
  resolveTenantBillingMode,
  type AnnouncementInput,
  type CreateTenantInput,
  type PricingUpdateInput,
  type QuotaUpdateInput,
  type TemplateWriteInput,
  type UpdateTenantInput,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

type Actor = { userId: string; role: 'ADMIN' | 'MERCHANT' };

type TenantRow = {
  id: string;
  name: string;
  expiresAt: Date;
  isActive: boolean;
  billingMode: 'SHADOW' | 'STRICT' | null;
  wallet: { points: number; pointsReserved: number; money: Prisma.Decimal } | null;
  users: Array<{ username: string; role: 'ADMIN' | 'MERCHANT' }>;
};

/**
 * 管理员开户、配额、价格、公告和系统模板。
 * 加点不在这里另做账，创建时的初始点数走 BillingService.adminAdjust。
 */
@Injectable()
export class AdminOfficeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  async listTenants(page: number, pageSize: number, keyword: string) {
    const where: Prisma.TenantWhereInput = keyword
      ? { name: { contains: keyword, mode: 'insensitive' } }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.base.tenant.count({ where }),
      this.prisma.base.tenant.findMany({
        where,
        include: tenantInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows.map((row) => presentTenant(row)) };
  }

  async tenant(id: string) {
    const row = await this.prisma.base.tenant.findUnique({ where: { id }, include: tenantInclude });
    if (!row) throw notFound('租户不存在');
    const quotas = await this.prisma.base.quota.findMany({
      where: { tenantId: id },
      orderBy: { key: 'asc' },
    });
    return {
      ...presentTenant(row),
      quotas: quotas.map((quota) => ({
        key: quota.key,
        used: quota.used.toString(),
        limit: quota.limit.toString(),
      })),
    };
  }

  async createTenant(actor: Actor, input: CreateTenantInput, idempotencyKey?: string) {
    assertAdmin(actor);
    const initialPoints = input.initialPoints ?? 0;
    if (initialPoints > 0 && !idempotencyKey) throw badRequest('加点必须带幂等键');
    if (idempotencyKey) {
      const prior = await this.findReplay('tenant_create', idempotencyKey);
      if (prior) return this.tenant(prior);
    }
    const expiresAt = new Date(input.expiresAt);
    let createdId = '';
    try {
      const created = await this.prisma.base.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: input.name,
            expiresAt,
            isActive: true,
            billingMode: input.billingMode ?? null,
          },
        });
        await tx.wallet.create({
          data: { tenantId: tenant.id, points: 0, pointsReserved: 0, money: 0 },
        });
        await tx.quota.createMany({
          data: QUOTA_DEFAULTS.map((item) => ({
            tenantId: tenant.id,
            key: item.key as QuotaKey,
            limit: BigInt(item.limit),
            used: 0n,
          })),
        });
        await tx.user.create({
          data: {
            tenantId: tenant.id,
            username: input.username,
            passwordHash: hashPassword(input.password),
            nickname: input.name,
            role: 'MERCHANT',
          },
        });
        return tenant;
      });
      createdId = created.id;
      if (initialPoints > 0 && idempotencyKey) {
        await this.billing.adminAdjust({
          actorUserId: actor.userId,
          actorRole: 'ADMIN',
          tenantId: created.id,
          delta: initialPoints,
          idempotencyKey: `${idempotencyKey}:points`,
          remark: '开户初始点数',
        });
      }
      await this.prisma.base.auditLog.create({
        data: {
          tenantId: created.id,
          userId: actor.userId,
          action: 'tenant_create',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: created.id,
            initialPoints,
            billingMode: input.billingMode ?? null,
          },
        },
      });
      return this.tenant(created.id);
    } catch (error) {
      if (createdId) {
        await this.prisma.base.tenant.delete({ where: { id: createdId } }).catch(() => undefined);
        throw error;
      }
      if (isUnique(error)) throw badRequest('用户名已存在');
      throw error;
    }
  }

  async updateTenant(actor: Actor, id: string, input: UpdateTenantInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('tenant_update', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return this.tenant(id);
      }
    }
    const existing = await this.prisma.base.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw notFound('租户不存在');
    await this.prisma.base.tenant.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      },
    });
    await this.audit(actor, id, 'tenant_update', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: id,
      patch: input,
    });
    return this.tenant(id);
  }

  async updateQuotas(actor: Actor, id: string, input: QuotaUpdateInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('quota_update', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return this.tenant(id);
      }
    }
    const tenant = await this.prisma.base.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!tenant) throw notFound('租户不存在');
    const seen = new Set<string>();
    for (const item of input.items) {
      if (seen.has(item.key)) throw badRequest('配额项重复');
      seen.add(item.key);
    }
    await this.prisma.base.$transaction(async (tx) => {
      for (const item of input.items) {
        if (!isQuotaKeyName(item.key)) throw badRequest('配额项不正确');
        const next = BigInt(item.limit);
        const current = await tx.quota.findUnique({
          where: { tenantId_key: { tenantId: id, key: item.key as QuotaKey } },
        });
        if (!current) throw notFound('配额不存在');
        if (next < current.used) throw badRequest('配额上限不能低于已用量');
        await tx.quota.update({
          where: { tenantId_key: { tenantId: id, key: item.key as QuotaKey } },
          data: { limit: next },
        });
      }
      await tx.auditLog.create({
        data: {
          tenantId: id,
          userId: actor.userId,
          action: 'quota_update',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: id,
            items: input.items,
          },
        },
      });
    });
    return this.tenant(id);
  }

  async listPrices() {
    const rows = await this.prisma.base.pricingItem.findMany({ orderBy: { action: 'asc' } });
    return {
      items: rows.map((row) => ({
        action: row.action,
        unitPoints: row.unitPoints,
        enabled: row.enabled,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async updatePrice(actor: Actor, input: PricingUpdateInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('pricing_update', idempotencyKey);
      if (prior) {
        if (prior !== input.action) throw conflict('幂等记录与本次请求不一致');
        return this.listPrices();
      }
    }
    const current = await this.prisma.base.pricingItem.findUnique({
      where: { action: input.action },
    });
    if (!current) throw notFound('价格项不存在');
    await this.prisma.base.$transaction(async (tx) => {
      await tx.pricingItem.update({
        where: { action: input.action },
        data: { unitPoints: input.unitPoints, enabled: input.enabled },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          action: 'pricing_update',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: input.action,
            action: input.action,
            from: { unitPoints: current.unitPoints, enabled: current.enabled },
            to: { unitPoints: input.unitPoints, enabled: input.enabled },
          },
        },
      });
    });
    return this.listPrices();
  }

  async listAnnouncements() {
    const rows = await this.prisma.base.announcement.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(presentAnnouncement) };
  }

  async createAnnouncement(actor: Actor, input: AnnouncementInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('announcement_save', idempotencyKey);
      if (prior) return this.oneAnnouncement(prior);
    }
    const row = await this.prisma.base.announcement.create({
      data: { content: input.content, enabled: input.enabled, sort: input.sort },
    });
    await this.audit(actor, null, 'announcement_save', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: row.id,
    });
    return presentAnnouncement(row);
  }

  async updateAnnouncement(
    actor: Actor,
    id: string,
    input: AnnouncementInput,
    idempotencyKey?: string,
  ) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('announcement_update', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return this.oneAnnouncement(id);
      }
    }
    const existing = await this.prisma.base.announcement.findUnique({ where: { id } });
    if (!existing) throw notFound('公告不存在');
    const row = await this.prisma.base.announcement.update({
      where: { id },
      data: { content: input.content, enabled: input.enabled, sort: input.sort },
    });
    await this.audit(actor, null, 'announcement_update', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: id,
    });
    return presentAnnouncement(row);
  }

  async listTemplates() {
    const rows = await this.prisma.base.promptTemplate.findMany({
      where: { tenantId: null },
      orderBy: [{ kind: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(presentTemplate) };
  }

  async createTemplate(actor: Actor, input: TemplateWriteInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('template_save', idempotencyKey);
      if (prior) return this.oneTemplate(prior);
    }
    const row = await this.prisma.base.promptTemplate.create({
      data: {
        tenantId: null,
        kind: input.kind as PromptKind,
        name: input.name,
        content: input.content,
        randomPool: input.randomPool,
        sort: input.sort,
      },
    });
    await this.audit(actor, null, 'template_save', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: row.id,
    });
    return presentTemplate(row);
  }

  async updateTemplate(
    actor: Actor,
    id: string,
    input: TemplateWriteInput,
    idempotencyKey?: string,
  ) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('template_update', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return this.oneTemplate(id);
      }
    }
    const existing = await this.prisma.base.promptTemplate.findFirst({
      where: { id, tenantId: null },
    });
    if (!existing) throw notFound('系统模板不存在');
    const row = await this.prisma.base.promptTemplate.update({
      where: { id },
      data: {
        kind: input.kind as PromptKind,
        name: input.name,
        content: input.content,
        randomPool: input.randomPool,
        sort: input.sort,
      },
    });
    await this.audit(actor, null, 'template_update', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: id,
    });
    return presentTemplate(row);
  }

  private async oneAnnouncement(id: string) {
    const row = await this.prisma.base.announcement.findUnique({ where: { id } });
    if (!row) throw notFound('公告不存在');
    return presentAnnouncement(row);
  }

  private async oneTemplate(id: string) {
    const row = await this.prisma.base.promptTemplate.findFirst({ where: { id, tenantId: null } });
    if (!row) throw notFound('系统模板不存在');
    return presentTemplate(row);
  }

  private async findReplay(action: string, key: string): Promise<string | null> {
    const row = await this.prisma.base.auditLog.findFirst({
      where: { action, payload: { path: ['idempotencyKey'], equals: key } },
      orderBy: { createdAt: 'desc' },
    });
    const payload = row?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const tenantId = (payload as { tenantId?: unknown }).tenantId;
    return typeof tenantId === 'string' ? tenantId : null;
  }

  private assertSame(found: string, expected: string): void {
    if (found !== expected) throw conflict('幂等记录与本次请求不一致');
  }

  private async audit(
    actor: Actor,
    tenantId: string | null,
    action: string,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.base.auditLog.create({
      data: { tenantId, userId: actor.userId, action, payload },
    });
  }
}

const tenantInclude = {
  wallet: true,
  users: {
    select: { username: true, role: true },
    orderBy: { createdAt: 'asc' as const },
    take: 1,
  },
} satisfies Prisma.TenantInclude;

function presentTenant(row: TenantRow) {
  const resolved = resolveTenantBillingMode(row.billingMode, parseEnv().BILLING_MODE);
  return {
    id: row.id,
    name: row.name,
    username: row.users[0]?.username ?? '',
    expiresAt: row.expiresAt.toISOString(),
    isActive: row.isActive,
    billingMode: row.billingMode,
    resolvedBillingMode: resolved.mode,
    points: row.wallet?.points ?? 0,
    pointsReserved: row.wallet?.pointsReserved ?? 0,
    money: formatMoney((row.wallet?.money ?? new Prisma.Decimal(0)).toString()),
  };
}

function presentAnnouncement(row: { id: string; content: string; enabled: boolean; sort: number }) {
  return { id: row.id, content: row.content, enabled: row.enabled, sort: row.sort };
}

function presentTemplate(row: {
  id: string;
  kind: PromptKind;
  name: string;
  content: string;
  randomPool: boolean;
  sort: number;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    content: row.content,
    randomPool: row.randomPool,
    sort: row.sort,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== 'ADMIN') throw notFound();
}

function badRequest(message: string): ApiError {
  return new ApiError(400, API_ERROR.BAD_REQUEST, message);
}

function notFound(message = '不存在'): ApiError {
  return new ApiError(404, AUTH_ERROR.NOT_FOUND, message);
}

function conflict(message: string): ApiError {
  return new ApiError(409, BILLING_ERROR.CONFLICT, message);
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
