import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  AUTH_ERROR,
  RATE_LIMIT_MESSAGE,
  changePasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  ok,
  refreshBodySchema,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { clientAddress } from './client-address';
import { asHttpRequest } from './http-request';
import { AuthRateLimiter } from './rate-limiter';
import { TenantActiveGuard } from './tenant-active.guard';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
    @Inject(AuthRateLimiter) private readonly rates: AuthRateLimiter,
  ) {}

  @Post('captcha')
  @HttpCode(200)
  captchaImage(@Req() request: unknown) {
    const decision = this.rates.takeCaptcha(clientAddress(request));
    if (!decision.allowed) {
      throw new ApiError(
        429,
        AUTH_ERROR.TOO_MANY_REQUESTS,
        RATE_LIMIT_MESSAGE,
        decision.retryAfterSeconds,
      );
    }
    return ok(this.captcha.create());
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: unknown, @Body() body: unknown) {
    return ok(await this.auth.login(parseBody(loginBodySchema, body), clientAddress(request)));
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
