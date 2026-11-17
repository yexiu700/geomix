import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { REWRITE_BATCH_HANDLER, RewriteBatchRunner } from './rewrite-batch.runner';
import { RewriteBatchesController } from './rewrite-batches.controller';
import { RewriteBatchesService } from './rewrite-batches.service';
import { RewritesController } from './rewrites.controller';
import { RewritesService } from './rewrites.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [RewritesController, RewriteBatchesController],
  providers: [
    RewritesService,
    RewriteBatchesService,
    RewriteBatchRunner,
    { provide: REWRITE_BATCH_HANDLER, useExisting: RewriteBatchRunner },
  ],
  exports: [RewritesService, RewriteBatchesService, RewriteBatchRunner],
})
export class RewriteModule {}
