import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AuthContextMiddleware } from './auth/auth-context.middleware';
import { AuthModule } from './auth/auth.module';
import { AdaptersModule } from './infra/adapters.module';
import { BillingModule } from './billing/billing.module';
import { QueueModule } from './queue/queue.module';
import { HealthController } from './health/health.controller';
import { SamplesModule } from './samples/samples.module';
import { HealthService } from './health/health.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AccountModule,
    BillingModule,
    AdaptersModule,
    QueueModule.forApi(),
    SamplesModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
