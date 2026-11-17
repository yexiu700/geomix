import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  GalleryAssetsController,
  GalleryCategoriesController,
  GalleryPublicAssetsController,
} from './gallery.controller';
import {
  GALLERY_MAX_INPUT_BYTES_TOKEN,
  GalleryService,
  readGalleryMaxInputBytes,
} from './gallery.service';
import { KeywordsController } from './keywords.controller';
import { KEYWORDS_MIN_VALID_TOKEN, KeywordsService, readDistillMinValid } from './keywords.service';
import { KnowledgeIndexRunner } from './knowledge-index.runner';
import { AgreementsController, KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [
    KeywordsController,
    QuestionsController,
    GalleryCategoriesController,
    GalleryAssetsController,
    GalleryPublicAssetsController,
    AgreementsController,
    KnowledgeController,
  ],
  providers: [
    {
      provide: KEYWORDS_MIN_VALID_TOKEN,
      useFactory: () => () => readDistillMinValid(process.env),
    },
    {
      provide: GALLERY_MAX_INPUT_BYTES_TOKEN,
      useFactory: () => () => readGalleryMaxInputBytes(process.env),
    },
    KeywordsService,
    QuestionsService,
    GalleryService,
    KnowledgeService,
    KnowledgeIndexRunner,
  ],
  exports: [
    KeywordsService,
    QuestionsService,
    GalleryService,
    KnowledgeService,
    KnowledgeIndexRunner,
  ],
})
export class KeywordsModule {}
