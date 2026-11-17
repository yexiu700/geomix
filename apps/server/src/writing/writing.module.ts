import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { KeywordsModule } from '../material/keywords.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ArticlesController, CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { PromptsController } from './prompts.controller';
import { PromptsService } from './prompts.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule, KeywordsModule],
  controllers: [CategoriesController, ArticlesController, PromptsController],
  providers: [CategoriesService, PromptsService],
  exports: [CategoriesService, PromptsService],
})
export class WritingModule {}
