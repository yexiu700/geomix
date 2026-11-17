import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { AUTH_ERROR, ok } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(AuthGuard, TenantActiveGuard)
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  async summary(@Req() request: unknown) {
    const http = asHttpRequest(request);
    if (!http.auth) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    }
    return ok(await this.dashboard.summary(http.auth.tenantId));
  }
}
