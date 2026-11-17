import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AdminOfficeModule } from './admin/admin-office.module';
import { AuthContextMiddleware } from './auth/auth-context.middleware';
import { AuthModule } from './auth/auth.module';
import { MeModule } from './me/me.module';
import { AdaptersModule } from './infra/adapters.module';
import { BillingModule } from './billing/billing.module';
import { QueueModule } from './queue/queue.module';
import { HealthController } from './health/health.controller';
import { DashboardModule } from './dashboard/dashboard.module';
import { AiImagesModule } from './image/ai-images.module';
import { KeywordsModule } from './material/keywords.module';
import { RewriteModule } from './rewrite/rewrite.module';
import { SamplesModule } from './samples/samples.module';
import { WritingModule } from './writing/writing.module';
import { HealthService } from './health/health.service';
import { PrismaModule } from './prisma/prisma.module';

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
    SamplesModule,
    KeywordsModule,
    WritingModule,
    RewriteModule,
    AiImagesModule,
    DashboardModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
