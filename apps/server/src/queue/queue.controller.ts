import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AUTH_ERROR, createRunBodySchema, ok } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { AdminGuard } from '../billing/admin.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { notFound } from '../billing/billing.sql';
import { QueueProducer } from './queue.producer';
import { WorkDriver } from './work-driver';

const RUN_ID = /^[A-Za-z0-9_-]{8,40}$/;

@Controller('queue/runs')
@UseGuards(AuthGuard, TenantActiveGuard)
export class QueueController {
  constructor(@Inject(WorkDriver) private readonly driver: WorkDriver) {}

  @Post()
  @HttpCode(200)
  async create(@Req() request: unknown, @Body() body: unknown) {
    const tenantId = requireTenant(request);
    const input = parseBody(createRunBodySchema, body);
    return ok(await this.driver.create(tenantId, input));
  }

  @Get(':id')
  async progress(@Req() request: unknown, @Param('id') id: string) {
    return ok(await this.driver.view(requireTenant(request), runId(id)));
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@Req() request: unknown, @Param('id') id: string) {
    return ok(await this.driver.pause(requireTenant(request), runId(id)));
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Req() request: unknown, @Param('id') id: string) {
    return ok(await this.driver.resume(requireTenant(request), runId(id)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Req() request: unknown, @Param('id') id: string) {
    return ok(await this.driver.cancel(requireTenant(request), runId(id)));
  }
}

@Controller('admin/queues')
@UseGuards(AuthGuard, AdminGuard)
export class QueueAdminController {
  constructor(@Inject(QueueProducer) private readonly producer: QueueProducer) {}

  @Get()
  async summary() {
    try {
      const queues = await this.producer.counts();
      return ok({ upstream: 'disabled' as const, queues });
    } catch {
      throw new ApiError(503, 50000, '队列暂不可用');
    }
  }
}

function requireTenant(request: unknown): string {
  const http = asHttpRequest(request);
  if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  return http.auth.tenantId;
}

function runId(id: string): string {
  if (!RUN_ID.test(id)) throw notFound('不存在');
  return id;
}
