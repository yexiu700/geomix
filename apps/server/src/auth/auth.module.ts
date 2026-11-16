import { Module } from '@nestjs/common';
import { parseEnv } from '@geomix/shared';
import { AuthContextMiddleware } from './auth-context.middleware';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { PrismaAuthStore } from './prisma-auth.store';
import { AuthRateLimiter } from './rate-limiter';
import { ttlToSeconds } from './token';

@Module({
  controllers: [AuthController],
  providers: [
    PrismaAuthStore,
    { provide: CaptchaService, useFactory: () => new CaptchaService() },
    {
      provide: AuthRateLimiter,
      useFactory: () => {
        const env = parseEnv();
        return new AuthRateLimiter({
          captchaMax: env.AUTH_CAPTCHA_MAX,
          captchaWindowMs: env.AUTH_CAPTCHA_WINDOW_SECONDS * 1000,
          loginFailMax: env.AUTH_LOGIN_FAIL_MAX,
          loginFailWindowMs: env.AUTH_LOGIN_FAIL_WINDOW_SECONDS * 1000,
        });
      },
    },
    {
      provide: AuthService,
      inject: [PrismaAuthStore, CaptchaService, AuthRateLimiter],
      useFactory: (store: PrismaAuthStore, captcha: CaptchaService, rates: AuthRateLimiter) => {
        const env = parseEnv();
        return new AuthService(
          store,
          captcha,
          {
            accessSecret: env.JWT_ACCESS_SECRET,
            refreshSecret: env.JWT_REFRESH_SECRET,
            accessTtlSeconds: ttlToSeconds(env.JWT_ACCESS_TTL),
            refreshTtlSeconds: ttlToSeconds(env.JWT_REFRESH_TTL),
          },
          Date.now,
          rates,
        );
      },
    },
    AuthContextMiddleware,
  ],
  exports: [AuthService, CaptchaService, AuthContextMiddleware],
})
export class AuthModule {}
