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
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityController } from './visibility.controller';
import { VisibilityJudgeService } from './visibility-judge.service';
import { VISIBILITY_RUN_HANDLER, VisibilityRunRunner } from './visibility-run.runner';
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
    VisibilityJudgeService,
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
    VisibilityJudgeService,
    VisibilityService,
    VisibilityRunRunner,
    VISIBILITY_RUN_HANDLER,
  ],
})
export class VisibilityModule implements OnModuleInit {
  private readonly logger = new Logger(VisibilityModule.name);

  constructor(@Inject(VISIBILITY_CONFIG) private readonly config: VisibilityConfig) {}

  onModuleInit(): void {
    if (this.config.collector === 'fake') {
      this.logger.warn(
        'VISIBILITY_COLLECTOR=fake 当前处于模拟演示采集模式；真实线上/预发请配置 VISIBILITY_COLLECTOR=llm_api 或 remote_scraper',
      );
    }
  }
}
