import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  changePasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  ok,
  refreshBodySchema,
} from '@geomix/shared';
import { parseBody } from '../common/parse-body';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { asHttpRequest } from './http-request';
import { TenantActiveGuard } from './tenant-active.guard';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
  ) {}

  @Post('captcha')
  @HttpCode(200)
  captchaImage() {
    return ok(this.captcha.create());
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    return ok(await this.auth.login(parseBody(loginBodySchema, body)));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const input = parseBody(refreshBodySchema, body);
    return ok(await this.auth.refresh(input.refreshToken));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() body: unknown) {
    const input = parseBody(logoutBodySchema, body);
    return ok(await this.auth.logout(input.refreshToken));
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(AuthGuard, TenantActiveGuard)
  async changePassword(@Req() request: unknown, @Body() body: unknown) {
    const http = asHttpRequest(request);
    if (!http.auth) throw new Error('auth guard did not attach a session');
    return ok(await this.auth.changePassword(http.auth, parseBody(changePasswordBodySchema, body)));
  }
}
