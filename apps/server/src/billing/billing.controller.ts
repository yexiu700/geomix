import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { AUTH_ERROR, ok, quotaReleasePolicy } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { badRequest } from './billing.sql';
import { BillingService } from './billing.service';
import { QuotaService } from './quota.service';

@Controller()
@UseGuards(AuthGuard, TenantActiveGuard)
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quotas: QuotaService,
  ) {}

  @Get('pricing')
  async prices() {
    return ok({ items: await this.billing.listPrices() });
  }

  @Get('billing/quote')
  async quote(@Query() query: Record<string, unknown>) {
    const count = readCount(query.count);
    const taskName = readOptionalText(query.taskName, 80);
    return ok(
      await this.billing.quoteGeoWrite({
        count,
        taskName,
      }),
    );
  }

  @Get('billing/wallet')
  async wallet(@Req() request: unknown) {
    const tenantId = requireTenant(request);
    return ok(await this.billing.wallet(tenantId));
  }

  @Get('billing/ledger')
  async ledger(@Req() request: unknown, @Query() query: Record<string, unknown>) {
    const tenantId = requireTenant(request);
    const page = readPage(query.page, 1);
    const pageSize = readPage(query.pageSize, 20);
    if (pageSize > 100) throw badRequest('分页不正确');
    return ok(await this.billing.ledger(tenantId, page, pageSize));
  }

  @Get('billing/quotas')
  async quotaList(@Req() request: unknown) {
    const tenantId = requireTenant(request);
    const rows = await this.quotas.read(tenantId);
    return ok({
      items: rows.map((row) => ({
        key: row.key,
        limit: row.limit.toString(),
        used: row.used.toString(),
        measure: row.measure,
        releasesOnDelete: quotaReleasePolicy(row.key) === 'stock',
      })),
    });
  }
}

function requireTenant(request: unknown): string {
  const http = asHttpRequest(request);
  if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  return http.auth.tenantId;
}

function one(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function readCount(value: unknown): number {
  const raw = one(value);
  if (!raw || !/^[0-9]+$/.test(raw)) throw badRequest('报价参数不正确');
  return Number(raw);
}

function readOptionalText(value: unknown, max: number): string | undefined {
  const raw = one(value);
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw.length > max) throw badRequest('报价参数不正确');
  return raw;
}

function readPage(value: unknown, fallback: number): number {
  const raw = one(value);
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw badRequest('分页不正确');
  const parsed = Number(raw);
  if (parsed < 1) throw badRequest('分页不正确');
  return parsed;
}
