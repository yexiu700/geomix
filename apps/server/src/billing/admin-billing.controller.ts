import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AUTH_ERROR, ok, type BillingMode } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { AdminGuard } from './admin.guard';
import { badRequest } from './billing.sql';
import { BillingService } from './billing.service';

@Controller('admin/billing')
@UseGuards(AuthGuard, TenantActiveGuard, AdminGuard)
export class AdminBillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Post('adjust')
  @HttpCode(200)
  async adjust(@Req() request: unknown, @Body() body: unknown) {
    const auth = requireAdmin(request);
    const input = readAdjust(body);
    return ok(
      await this.billing.adminAdjust({
        actorUserId: auth.userId,
        actorRole: auth.role,
        tenantId: input.tenantId,
        delta: input.delta,
        idempotencyKey: input.idempotencyKey,
        remark: input.remark,
      }),
    );
  }

  @Post('mode')
  @HttpCode(200)
  async mode(@Req() request: unknown, @Body() body: unknown) {
    const auth = requireAdmin(request);
    const input = readMode(body);
    return ok(
      await this.billing.setBillingMode({
        actorUserId: auth.userId,
        actorRole: auth.role,
        tenantId: input.tenantId,
        billingMode: input.billingMode,
      }),
    );
  }
}

function requireAdmin(request: unknown): { userId: string; role: 'ADMIN' | 'MERCHANT' } {
  const http = asHttpRequest(request);
  if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  return { userId: http.auth.userId, role: http.auth.role };
}

function readObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('参数错误');
  return body as Record<string, unknown>;
}

function readId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(value))
    throw badRequest(message);
  return value;
}

function readKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9:_-]{8,160}$/.test(value) ||
    value.startsWith('close:')
  ) {
    throw badRequest('幂等键不正确');
  }
  return value;
}

function readAdjust(body: unknown): {
  tenantId: string;
  delta: number;
  idempotencyKey: string;
  remark?: string;
} {
  const record = readObject(body);
  const delta = record.delta;
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0) {
    throw badRequest('调整点数不正确');
  }
  const remark = record.remark;
  if (remark !== undefined && (typeof remark !== 'string' || remark.length > 200)) {
    throw badRequest('备注不正确');
  }
  return {
    tenantId: readId(record.tenantId, '租户不正确'),
    delta,
    idempotencyKey: readKey(record.idempotencyKey),
    remark,
  };
}

function readMode(body: unknown): { tenantId: string; billingMode: BillingMode | null } {
  const record = readObject(body);
  const mode = record.billingMode;
  if (mode !== null && mode !== 'SHADOW' && mode !== 'STRICT') throw badRequest('计费模式不正确');
  return { tenantId: readId(record.tenantId, '租户不正确'), billingMode: mode };
}
