import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';
import { VisibilityAnalyticsService } from './visibility-analytics.service';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityController } from './visibility.controller';
import { VisibilityEngineHealthService } from './visibility-engine-health.service';
import { VisibilityJudgeService } from './visibility-judge.service';
import { VisibilityProfileService } from './visibility-profile.service';
import { VISIBILITY_RUN_HANDLER, VisibilityRunRunner } from './visibility-run.runner';
import { VisibilityRunLifecycleService } from './visibility-run-lifecycle.service';
import { VisibilityService } from './visibility.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [VisibilityController],
  providers: [
    {
      provide: VISIBILITY_CONFIG,
      useFactory: () => readVisibilityConfig(process.env),
    },
    VisibilityCollectorService,
    VisibilityEngineHealthService,
    VisibilityJudgeService,
    VisibilityProfileService,
    VisibilityRunLifecycleService,
    VisibilityAnalyticsService,
    VisibilityService,
    VisibilityRunRunner,
    {
      provide: VISIBILITY_RUN_HANDLER,
      useExisting: VisibilityRunRunner,
    },
  ],
  exports: [
    VISIBILITY_CONFIG,
    VisibilityCollectorService,
    VisibilityEngineHealthService,
    VisibilityJudgeService,
    VisibilityService,
    VisibilityRunRunner,
    VISIBILITY_RUN_HANDLER,
  ],
})
export class VisibilityModule implements OnModuleInit {
  private readonly logger = new Logger(VisibilityModule.name);

  constructor(
    @Inject(VISIBILITY_CONFIG) private readonly config: VisibilityConfig,
    @Inject(VisibilityEngineHealthService)
    private readonly engineHealth: VisibilityEngineHealthService,
  ) {}

  onModuleInit(): void {
    if (this.config.collector === 'fake') {
      this.logger.warn(
        'VISIBILITY_COLLECTOR=fake 当前处于模拟演示采集模式；真实线上/预发请配置 VISIBILITY_COLLECTOR=llm_api 或 remote_scraper',
      );
      return;
    }
    if (
      this.config.collector === 'remote_scraper' &&
      this.config.remoteUrl &&
      process.env.NODE_ENV !== 'test'
    ) {
      void this.engineHealth.refreshHealth().catch((err: unknown) => {
        this.logger.warn(
          `initial visibility engine health check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });
    }
  }
}
