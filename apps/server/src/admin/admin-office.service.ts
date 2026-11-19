import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PromptKind, QuotaKey } from '@prisma/client';
import { hashPassword } from '@geomix/db';
import {
  API_ERROR,
  AUTH_ERROR,
  BILLING_ERROR,
  LLM_COST_AUDIT_ACTION,
  PRICING_DEFAULTS,
  QUOTA_DEFAULTS,
  aggregateLlmDailyReport,
  escapeLikeLiteral,
  formatLlmTenantDisplayName,
  formatMoney,
  getPricingActionMeta,
  isQuotaKeyName,
  parseEnv,
  parseLlmCostQuery,
  parseLlmCostRates,
  resolveTenantBillingMode,
  shanghaiDayWindowUtc,
  type AnnouncementInput,
  type CreateTenantInput,
  type LlmDailyCostReport,
  type LlmUsageEventInput,
  type PricingBatchUpdateInput,
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
      ? { name: { contains: escapeLikeLiteral(keyword), mode: 'insensitive' } }
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
    const existingActions = new Set(rows.map((row) => row.action));
    const missingDefaults = PRICING_DEFAULTS.filter((item) => !existingActions.has(item.action));
    if (
      missingDefaults.length > 0 &&
      typeof this.prisma.base.pricingItem.createMany === 'function'
    ) {
      await this.prisma.base.pricingItem
        .createMany({
          data: missingDefaults.map((item) => ({
            action: item.action,
            unitPoints: item.unitPoints,
            enabled: true,
          })),
          skipDuplicates: true,
        })
        .catch(() => undefined);
    }
    const nowIso = new Date().toISOString();
    const items = [
      ...rows.map((row) => {
        const meta = getPricingActionMeta(row.action);
        return {
          action: row.action,
          unitPoints: row.unitPoints,
          enabled: row.enabled,
          updatedAt: row.updatedAt.toISOString(),
          label: meta.label,
          unit: meta.unit,
          description: meta.description,
        };
      }),
      ...missingDefaults.map((item) => {
        const meta = getPricingActionMeta(item.action);
        return {
          action: item.action,
          unitPoints: item.unitPoints,
          enabled: true,
          updatedAt: nowIso,
          label: meta.label,
          unit: meta.unit,
          description: meta.description,
        };
      }),
    ].sort((a, b) => a.action.localeCompare(b.action));
    return { items };
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
    const fallbackDefault = PRICING_DEFAULTS.find((item) => item.action === input.action);
    if (!current && !fallbackDefault) throw notFound('价格项不存在');
    const priorValues = current
      ? { unitPoints: current.unitPoints, enabled: current.enabled }
      : { unitPoints: fallbackDefault!.unitPoints, enabled: true };
    await this.prisma.base.$transaction(async (tx) => {
      if (current) {
        await tx.pricingItem.update({
          where: { action: input.action },
          data: { unitPoints: input.unitPoints, enabled: input.enabled },
        });
      } else {
        await tx.pricingItem.upsert({
          where: { action: input.action },
          create: { action: input.action, unitPoints: input.unitPoints, enabled: input.enabled },
          update: { unitPoints: input.unitPoints, enabled: input.enabled },
        });
      }
      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          action: 'pricing_update',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: input.action,
            action: input.action,
            from: priorValues,
            to: { unitPoints: input.unitPoints, enabled: input.enabled },
          },
        },
      });
    });
    return this.listPrices();
  }

  async updatePrices(actor: Actor, input: PricingBatchUpdateInput, idempotencyKey?: string) {
    assertAdmin(actor);
    const seen = new Set<string>();
    for (const item of input.items) {
      if (seen.has(item.action)) throw badRequest('存在重复的价格项目');
      seen.add(item.action);
    }
    const digest = [...input.items]
      .sort((a, b) => a.action.localeCompare(b.action))
      .map((item) => `${item.action}:${item.unitPoints}:${item.enabled ? 1 : 0}`)
      .join('|');
    if (idempotencyKey) {
      const prior = await this.findReplay('pricing_batch_update', idempotencyKey);
      if (prior) {
        if (prior !== digest) throw conflict('幂等记录与本次请求不一致');
        return this.listPrices();
      }
    }
    const actions = input.items.map((item) => item.action);
    const existingRows = await this.prisma.base.pricingItem.findMany({
      where: { action: { in: actions } },
    });
    const existingByAction = new Map(existingRows.map((row) => [row.action, row]));
    for (const item of input.items) {
      const hasExisting = existingByAction.has(item.action);
      const hasDefault = PRICING_DEFAULTS.some((def) => def.action === item.action);
      if (!hasExisting && !hasDefault) throw notFound('价格项不存在');
    }
    await this.prisma.base.$transaction(async (tx) => {
      const changes: Array<{
        action: string;
        from: { unitPoints: number; enabled: boolean };
        to: { unitPoints: number; enabled: boolean };
      }> = [];
      for (const item of input.items) {
        const current = existingByAction.get(item.action);
        const fallback = PRICING_DEFAULTS.find((def) => def.action === item.action);
        const priorValues = current
          ? { unitPoints: current.unitPoints, enabled: current.enabled }
          : { unitPoints: fallback!.unitPoints, enabled: true };
        if (current) {
          await tx.pricingItem.update({
            where: { action: item.action },
            data: { unitPoints: item.unitPoints, enabled: item.enabled },
          });
        } else {
          await tx.pricingItem.upsert({
            where: { action: item.action },
            create: { action: item.action, unitPoints: item.unitPoints, enabled: item.enabled },
            update: { unitPoints: item.unitPoints, enabled: item.enabled },
          });
        }
        changes.push({
          action: item.action,
          from: priorValues,
          to: { unitPoints: item.unitPoints, enabled: item.enabled },
        });
      }
      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          action: 'pricing_batch_update',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: digest,
            changes,
          },
        },
      });
    });
    return this.listPrices();
  }

  async listAnnouncements() {
    const rows = await this.prisma.base.announcement.findMany({
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    return { items: rows.map(presentAnnouncement) };
  }

  async createAnnouncement(actor: Actor, input: AnnouncementInput, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('announcement_save', idempotencyKey);
      if (prior) return this.oneAnnouncement(prior);
    }
    const operatorName = await this.resolveOperatorName(actor.userId);
    const row = await this.prisma.base.announcement.create({
      data: {
        content: input.content,
        enabled: input.enabled,
        sort: input.sort,
        operatorId: actor.userId,
        operatorName,
      },
    });
    await this.audit(actor, null, 'announcement_save', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: row.id,
      operatorName,
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
    const operatorName = await this.resolveOperatorName(actor.userId);
    const row = await this.prisma.base.announcement.update({
      where: { id },
      data: {
        content: input.content,
        enabled: input.enabled,
        sort: input.sort,
        operatorId: actor.userId,
        operatorName,
      },
    });
    await this.audit(actor, null, 'announcement_update', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: id,
      operatorName,
    });
    return presentAnnouncement(row);
  }

  async deleteAnnouncement(actor: Actor, id: string, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('announcement_delete', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return { deleted: true, id };
      }
    }
    const existing = await this.prisma.base.announcement.findUnique({ where: { id } });
    if (!existing) throw notFound('公告不存在');
    await this.prisma.base.$transaction(async (tx) => {
      await tx.announcement.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          tenantId: null,
          userId: actor.userId,
          action: 'announcement_delete',
          payload: {
            idempotencyKey: idempotencyKey ?? null,
            tenantId: id,
            announcementId: id,
            content: existing.content,
          },
        },
      });
    });
    return { deleted: true, id };
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

  async deleteTemplate(actor: Actor, id: string, idempotencyKey?: string) {
    assertAdmin(actor);
    if (idempotencyKey) {
      const prior = await this.findReplay('template_delete', idempotencyKey);
      if (prior) {
        this.assertSame(prior, id);
        return { deleted: true, id };
      }
    }
    const existing = await this.prisma.base.promptTemplate.findFirst({
      where: { id, tenantId: null },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('系统模板不存在');
    await this.prisma.base.promptTemplate.delete({ where: { id } });
    await this.audit(actor, null, 'template_delete', {
      idempotencyKey: idempotencyKey ?? null,
      tenantId: id,
      name: existing.name,
    });
    return { deleted: true, id };
  }

  async llmCostReport(
    actor: Actor,
    rawQuery: Record<string, unknown>,
    now: Date = new Date(),
  ): Promise<LlmDailyCostReport> {
    assertAdmin(actor);
    let query: ReturnType<typeof parseLlmCostQuery>;
    try {
      query = parseLlmCostQuery(rawQuery);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : '查询参数不正确');
    }

    const { startUtc, endUtc } = shanghaiDayWindowUtc(query.days, now);
    const [auditRows, taskItems, visObs] = await Promise.all([
      this.prisma.base.auditLog.findMany({
        where: {
          action: LLM_COST_AUDIT_ACTION,
          createdAt: { gte: startUtc, lte: endUtc },
          ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 50_000,
      }),
      this.prisma.base.aiTaskItem.findMany({
        where: {
          status: 'SUCCESS',
          finishedAt: { gte: startUtc, lte: endUtc },
          tokensIn: { not: null },
          ...(query.tenantId ? { task: { tenantId: query.tenantId } } : {}),
        },
        select: {
          id: true,
          model: true,
          tokensIn: true,
          tokensOut: true,
          finishedAt: true,
          task: { select: { tenantId: true } },
        },
        take: 20_000,
      }),
      this.prisma.base.visibilityObservation.findMany({
        where: {
          status: 'SUCCESS',
          checkedAt: { gte: startUtc, lte: endUtc },
          tokensIn: { not: null },
          ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        },
        select: {
          id: true,
          tenantId: true,
          judgeModel: true,
          tokensIn: true,
          tokensOut: true,
          checkedAt: true,
        },
        take: 20_000,
      }),
    ]);

    const coveredItemPrefixes = new Set<string>();
    const rawEvents: LlmUsageEventInput[] = [];
    const tenantIds = new Set<string>();

    for (const row of auditRows) {
      const p =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      const idem = typeof p.idempotencyKey === 'string' ? p.idempotencyKey : '';
      if (idem.startsWith('ai_body:')) {
        const parts = idem.split(':');
        if (parts[1]) coveredItemPrefixes.add(`item:${parts[1]}`);
      } else if (idem.includes('vis') && idem.includes(':')) {
        const parts = idem.split(':');
        if (parts[1]) coveredItemPrefixes.add(`obs:${parts[1]}`);
      }

      if (row.tenantId) tenantIds.add(row.tenantId);
      const model = typeof p.model === 'string' && p.model ? p.model : 'unknown';
      const provider = typeof p.provider === 'string' && p.provider ? p.provider : 'unknown';
      const fake = typeof p.fake === 'boolean' ? p.fake : model.startsWith('fake');

      rawEvents.push({
        tenantId: row.tenantId,
        scene: typeof p.scene === 'string' ? p.scene : 'other',
        provider,
        model,
        fake,
        tokensIn: typeof p.tokensIn === 'number' ? p.tokensIn : 0,
        tokensOut: typeof p.tokensOut === 'number' ? p.tokensOut : 0,
        ...(typeof p.costMicro === 'number' ? { costMicro: p.costMicro } : {}),
        createdAt: row.createdAt,
      });
    }

    for (const item of taskItems) {
      if (coveredItemPrefixes.has(`item:${item.id}`) || !item.finishedAt) continue;
      tenantIds.add(item.task.tenantId);
      const model = item.model ?? 'fake-quality';
      const fake = model.startsWith('fake');
      rawEvents.push({
        tenantId: item.task.tenantId,
        scene: 'body',
        provider: fake ? 'fake' : 'openai',
        model,
        fake,
        tokensIn: item.tokensIn ?? 0,
        tokensOut: item.tokensOut ?? 0,
        createdAt: item.finishedAt,
      });
    }

    for (const obs of visObs) {
      if (coveredItemPrefixes.has(`obs:${obs.id}`) || !obs.checkedAt) continue;
      tenantIds.add(obs.tenantId);
      const model = obs.judgeModel ?? 'fake-cheap';
      const isDeterministicSkip =
        model === 'deterministic-skip' || model.startsWith('deterministic-');
      const fake = model.startsWith('fake') || isDeterministicSkip;
      rawEvents.push({
        tenantId: obs.tenantId,
        scene: 'visibility_judge',
        provider: isDeterministicSkip ? 'local-rule' : fake ? 'fake' : 'openai',
        model,
        fake,
        tokensIn: obs.tokensIn ?? 0,
        tokensOut: obs.tokensOut ?? 0,
        createdAt: obs.checkedAt,
      });
    }

    const tenants =
      tenantIds.size > 0
        ? await this.prisma.base.tenant.findMany({
            where: { id: { in: [...tenantIds] } },
            select: { id: true, name: true },
          })
        : [];
    const tenantNameById = new Map(tenants.map((t) => [t.id, t.name]));

    const enriched = rawEvents.map((ev) => ({
      ...ev,
      tenantName: formatLlmTenantDisplayName(
        ev.tenantId ? tenantNameById.get(ev.tenantId) : null,
        ev.tenantId,
      ),
    }));

    let rates = {};
    try {
      rates = parseLlmCostRates(process.env.LLM_COST_RATES_JSON);
    } catch {
      rates = {};
    }

    return aggregateLlmDailyReport(enriched, {
      days: query.days,
      includeFake: query.includeFake,
      rates,
      now,
    });
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

  private async resolveOperatorName(userId: string): Promise<string> {
    const user = await this.prisma.base.user.findUnique({
      where: { id: userId },
      select: { username: true, nickname: true },
    });
    if (!user) return userId;
    const nick = user.nickname?.trim();
    return nick && nick !== user.username ? `${nick} (${user.username})` : user.username;
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

function presentAnnouncement(row: {
  id: string;
  content: string;
  enabled: boolean;
  sort: number;
  operatorId?: string | null;
  operatorName?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: row.id,
    content: row.content,
    enabled: row.enabled,
    sort: row.sort,
    operatorId: row.operatorId ?? null,
    operatorName: row.operatorName ?? null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
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
