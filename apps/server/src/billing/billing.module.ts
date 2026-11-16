import { Module } from '@nestjs/common';
import { parseEnv, readQueueConfig, readReconcileConfig } from '@geomix/shared';
import { hasLiveActiveWork } from '../queue/active-work';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AdminBillingController } from './admin-billing.controller';
import { BILLING_OPTIONS, type BillingOptions } from './billing.options';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { QuotaService } from './quota.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController, AdminBillingController],
  providers: [
    {
      provide: BILLING_OPTIONS,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): BillingOptions => {
        const timing = readReconcileConfig(process.env);
        return {
          globalMode: () => parseEnv().BILLING_MODE,
          orphanAfterMs: timing.orphanAfterMs,
          now: () => new Date(),
          hasActiveJob: (ref) =>
            hasLiveActiveWork(prisma, ref, new Date(), readQueueConfig(process.env).heartbeatTtlMs),
        };
      },
    },
    BillingService,
    QuotaService,
  ],
  exports: [BillingService, QuotaService, BILLING_OPTIONS],
})
export class BillingModule {}
