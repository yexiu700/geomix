import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { KeywordsModule } from '../material/keywords.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AI_TASK_HANDLER, AiTaskRunner } from './ai-task.runner';
import { AiTasksController } from './ai-tasks.controller';
import { AiTasksService } from './ai-tasks.service';
import { ArticlesController, CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { PromptsController } from './prompts.controller';
import { PromptsService } from './prompts.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule, KeywordsModule],
  controllers: [CategoriesController, ArticlesController, PromptsController, AiTasksController],
  providers: [
    CategoriesService,
    PromptsService,
    AiTasksService,
    AiTaskRunner,
    { provide: AI_TASK_HANDLER, useExisting: AiTaskRunner },
  ],
  exports: [CategoriesService, PromptsService, AiTasksService, AiTaskRunner],
})
export class WritingModule {}
