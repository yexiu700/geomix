import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { KeywordsModule } from '../material/keywords.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PromptsController } from './prompts.controller';
import { PromptsService } from './prompts.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule, KeywordsModule],
  controllers: [PromptsController],
  providers: [PromptsService],
  exports: [PromptsService],
})
export class WritingModule {}
