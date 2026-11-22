import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { FreeActionRateLimiter } from '../common/free-action-rate-limiter';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BrandFactIndexRunner } from './brand-fact-index.runner';
import { BrandFactsController } from './brand-facts.controller';
import { BrandFactsService } from './brand-facts.service';
import { BrandMediaController, BrandMediaPublicController } from './brand-media.controller';
import { BrandMediaService } from './brand-media.service';
import { BrandsController } from './brands.controller';
import { GALLERY_MAX_INPUT_BYTES_TOKEN, readGalleryMaxInputBytes } from './brands.http-utils';
import { BrandsService } from './brands.service';

@Module({
  imports: [PrismaModule, AuthModule, AdaptersModule, BillingModule],
  controllers: [
    BrandsController,
    BrandFactsController,
    BrandMediaController,
    BrandMediaPublicController,
  ],
  providers: [
    BrandsService,
    FreeActionRateLimiter,
    BrandFactIndexRunner,
    BrandFactsService,
    {
      provide: GALLERY_MAX_INPUT_BYTES_TOKEN,
      useFactory: () => () => readGalleryMaxInputBytes(process.env),
    },
    BrandMediaService,
  ],
  exports: [
    BrandsService,
    BrandFactsService,
    BrandFactIndexRunner,
    BrandMediaService,
    FreeActionRateLimiter,
  ],
})
export class BrandsModule {}
