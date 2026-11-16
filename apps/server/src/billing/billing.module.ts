import { Module } from '@nestjs/common';
import { parseEnv, readReconcileConfig } from '@geomix/shared';
import { PrismaModule } from '../prisma/prisma.module';
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
      useFactory: (): BillingOptions => {
        const timing = readReconcileConfig(process.env);
        return {
          globalMode: () => parseEnv().BILLING_MODE,
          orphanAfterMs: timing.orphanAfterMs,
          now: () => new Date(),
        };
      },
    },
    BillingService,
    QuotaService,
  ],
  exports: [BillingService, QuotaService, BILLING_OPTIONS],
})
export class BillingModule {}
