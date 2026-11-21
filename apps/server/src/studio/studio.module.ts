import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BrandsModule } from '../brands/brands.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  ArticlesController,
  BrandStudioController,
  PromptPreferencesController,
} from './studio.controller';
import { StudioGenerationService } from './studio-generation.service';
import { StudioService } from './studio.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule, BrandsModule],
  controllers: [BrandStudioController, ArticlesController, PromptPreferencesController],
  providers: [StudioGenerationService, StudioService],
  exports: [StudioService, StudioGenerationService],
})
export class StudioModule {}
