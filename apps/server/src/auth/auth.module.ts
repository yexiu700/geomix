import { Module } from '@nestjs/common';
import { parseEnv } from '@geomix/shared';
import { AuthContextMiddleware } from './auth-context.middleware';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { PrismaAuthStore } from './prisma-auth.store';
import { ttlToSeconds } from './token';

@Module({
  controllers: [AuthController],
  providers: [
    PrismaAuthStore,
    { provide: CaptchaService, useFactory: () => new CaptchaService() },
    {
      provide: AuthService,
      inject: [PrismaAuthStore, CaptchaService],
      useFactory: (store: PrismaAuthStore, captcha: CaptchaService) => {
        const env = parseEnv();
        return new AuthService(store, captcha, {
          accessSecret: env.JWT_ACCESS_SECRET,
          refreshSecret: env.JWT_REFRESH_SECRET,
          accessTtlSeconds: ttlToSeconds(env.JWT_ACCESS_TTL),
          refreshTtlSeconds: ttlToSeconds(env.JWT_REFRESH_TTL),
        });
      },
    },
    AuthContextMiddleware,
  ],
  exports: [AuthService, CaptchaService, AuthContextMiddleware],
})
export class AuthModule {}
