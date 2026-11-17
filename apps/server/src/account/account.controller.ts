import { Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AUTH_ERROR, ok } from '@geomix/shared';
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

  @Patch('ui-prefs')
  async updateUiPrefs(@Req() request: unknown, @Body() body: unknown) {
    const http = asHttpRequest(request);
    if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return ok(await this.accounts.updateUiPrefs(http.auth.userId, body));
  }

  @Get('users/:id')
  async user(@Param('id') id: string) {
    return ok(await this.accounts.userInTenant(id));
  }
}
