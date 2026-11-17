import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RewritesController } from './rewrites.controller';
import { RewritesService } from './rewrites.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [RewritesController],
  providers: [RewritesService],
  exports: [RewritesService],
})
export class RewriteModule {}
