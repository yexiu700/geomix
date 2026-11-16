import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { ok } from '@geomix/shared';
import { AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { AccountService } from './account.service';

@Controller('account')
@UseGuards(AuthGuard, TenantActiveGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}

  @Get()
  async profile(@Req() request: unknown) {
    const http = asHttpRequest(request);
    if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return ok(await this.accounts.profile(http.auth.userId));
  }

  @Get('users/:id')
  async user(@Param('id') id: string) {
    return ok(await this.accounts.userInTenant(id));
  }
}
