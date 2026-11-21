import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AdminOfficeModule } from './admin/admin-office.module';
import { AuthContextMiddleware } from './auth/auth-context.middleware';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BrandsModule } from './brands/brands.module';
import { BriefsModule } from './briefs/briefs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { AdaptersModule } from './infra/adapters.module';
import { MeModule } from './me/me.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { VisibilityModule } from './visibility/visibility.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AccountModule,
    MeModule,
    BillingModule,
    AdminOfficeModule,
    AdaptersModule,
    QueueModule.forApi(),
    BrandsModule,
    DashboardModule,
    VisibilityModule,
    BriefsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
