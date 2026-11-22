import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BrandsModule } from '../brands/brands.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VisibilityModule } from '../visibility/visibility.module';
import { VisibilityRunRunner } from '../visibility/visibility-run.runner';
import { HomeController, PublishRecordsController } from './delivery.controller';
import { GeoDeliveryService } from './geo-delivery.service';
import { RetestMetricsHookService } from './retest-metrics-hook.service';
import {
  ArticlesController,
  BrandStudioController,
  PromptPreferencesController,
} from './studio.controller';
import { StudioGenerationService } from './studio-generation.service';
import { StudioService } from './studio.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BillingModule,
    AdaptersModule,
    BrandsModule,
    VisibilityModule,
  ],
  controllers: [
    BrandStudioController,
    ArticlesController,
    PromptPreferencesController,
    PublishRecordsController,
    HomeController,
  ],
  providers: [StudioGenerationService, StudioService, GeoDeliveryService, RetestMetricsHookService],
  exports: [StudioService, StudioGenerationService, GeoDeliveryService, RetestMetricsHookService],
})
export class StudioModule implements OnModuleInit {
  constructor(
    @Inject(VisibilityRunRunner) private readonly visibilityRunner: VisibilityRunRunner,
    @Inject(RetestMetricsHookService) private readonly retestHook: RetestMetricsHookService,
  ) {}

  onModuleInit(): void {
    this.visibilityRunner.registerCompleteHook(this.retestHook);
  }
}
