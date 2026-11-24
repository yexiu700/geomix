import { Inject, Injectable } from '@nestjs/common';
import type { QuotaKey } from '@prisma/client';
import {
  API_ERROR,
  articleQuotaEffect,
  quotaReleasePolicy,
  type QuotaKeyName,
} from '@geomix/shared';
import type { ArticleQuotaEvent, ArticleQuotaSource } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, type BillingTx, TX_OPTIONS } from './billing.sql';

type QuotaRow = { used: bigint; limit: bigint };

/**
 * 配额和业务写入必须放在同一个事务里。
 * 条件更新保证 used + n 不超过 limit。
 * 存量配额（含 SOCIAL_AUTH）删除时回退；AI_WRITE 与 PUBLISH 为累计配额，只增不减。
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async assertAvailable(tenantId: string, key: QuotaKeyName, amount: number): Promise<void> {
    const row = await this.readRow(tenantId, key);
    if (row.used + BigInt(this.amount(amount)) > row.limit) {
      throw new ApiError(409, API_ERROR.QUOTA_EXCEEDED, '配额不足');
    }
  }

  async consume(
    tenantId: string,
    key: QuotaKeyName,
    amount: number,
    tx?: BillingTx,
  ): Promise<QuotaRow> {
    const delta = this.amount(amount);
    if (tx) return this.consumeIn(tx, tenantId, key, delta);
    return this.prisma.base.$transaction(
      (inner) => this.consumeIn(inner, tenantId, key, delta),
      TX_OPTIONS,
    );
  }

  async release(
    tenantId: string,
    key: QuotaKeyName,
    amount: number,
    tx?: BillingTx,
  ): Promise<QuotaRow> {
    const policy = quotaReleasePolicy(key);
    if (policy === 'cumulative') {
      throw badRequest(key === 'AI_WRITE' ? 'AI写作数量只增不减' : '该配额为累计计数，只增不减');
    }
    if (policy === 'unconfirmed') throw badRequest('这项配额的回退口径未确认');
    const delta = this.amount(amount);
    if (tx) return this.releaseIn(tx, tenantId, key, delta);
    return this.prisma.base.$transaction(
      (inner) => this.releaseIn(inner, tenantId, key, delta),
      TX_OPTIONS,
    );
  }

  /**
   * 文章事件只在「创建写作任务的一篇」时增加 AI 写作数量。
   * 复刻、手动文章、改状态、删除都不改 AI 写作数量，也不改文章发布配额。
   */
  async applyArticleEvent(
    tenantId: string,
    source: ArticleQuotaSource,
    event: ArticleQuotaEvent,
    tx?: BillingTx,
  ): Promise<void> {
    const effect = articleQuotaEffect(source, event);
    if (effect.aiWrite > 0) await this.consume(tenantId, 'AI_WRITE', effect.aiWrite, tx);
    if (effect.publish !== 0) {
      throw badRequest('文章发布配额的变化口径未确认');
    }
  }

  async read(tenantId: string): Promise<
    Array<{
      key: QuotaKeyName;
      limit: bigint;
      used: bigint;
      measure: ReturnType<typeof quotaReleasePolicy>;
    }>
  > {
    const rows = await this.prisma.base.quota.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
    });
    return rows.map((row) => ({
      key: row.key,
      limit: row.limit,
      used: row.used,
      measure: quotaReleasePolicy(row.key),
    }));
  }

  private amount(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
      throw badRequest('配额数量不正确');
    }
    return value;
  }

  private async readRow(tenantId: string, key: QuotaKeyName): Promise<QuotaRow> {
    const row = await this.prisma.base.quota.findUnique({
      where: { tenantId_key: { tenantId, key: key as QuotaKey } },
    });
    if (!row) throw new ApiError(404, API_ERROR.BAD_REQUEST, '配额不存在');
    return { used: row.used, limit: row.limit };
  }

  private async lock(tx: BillingTx, tenantId: string, key: QuotaKeyName): Promise<QuotaRow> {
    const rows = await tx.$queryRaw<QuotaRow[]>`
      SELECT used, "limit"
      FROM "Quota"
      WHERE "tenantId" = ${tenantId} AND key::text = ${key}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, API_ERROR.BAD_REQUEST, '配额不存在');
    return { used: BigInt(row.used), limit: BigInt(row.limit) };
  }

  private async consumeIn(
    tx: BillingTx,
    tenantId: string,
    key: QuotaKeyName,
    amount: number,
  ): Promise<QuotaRow> {
    await this.lock(tx, tenantId, key);
    const delta = BigInt(amount);
    const updated = await tx.$executeRaw`
      UPDATE "Quota"
      SET used = used + ${delta}
      WHERE "tenantId" = ${tenantId}
        AND key::text = ${key}
        AND used + ${delta} <= "limit"
    `;
    if (updated !== 1) throw new ApiError(409, API_ERROR.QUOTA_EXCEEDED, '配额不足');
    return this.lock(tx, tenantId, key);
  }

  private async releaseIn(
    tx: BillingTx,
    tenantId: string,
    key: QuotaKeyName,
    amount: number,
  ): Promise<QuotaRow> {
    await this.lock(tx, tenantId, key);
    const delta = BigInt(amount);
    const updated = await tx.$executeRaw`
      UPDATE "Quota"
      SET used = used - ${delta}
      WHERE "tenantId" = ${tenantId}
        AND key::text = ${key}
        AND used >= ${delta}
    `;
    if (updated !== 1) throw badRequest('配额已用量不够回退');
    return this.lock(tx, tenantId, key);
  }
}
