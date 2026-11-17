import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AiImageFeatureGuard, AiImagesController } from './ai-images.controller';
import { AiImagesService } from './ai-images.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [AiImagesController],
  providers: [AiImageFeatureGuard, AiImagesService],
  exports: [AiImagesService],
})
export class AiImagesModule {}
