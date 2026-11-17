import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { KeywordsController } from './keywords.controller';
import { KEYWORDS_MIN_VALID_TOKEN, KeywordsService, readDistillMinValid } from './keywords.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule],
  controllers: [KeywordsController],
  providers: [
    {
      provide: KEYWORDS_MIN_VALID_TOKEN,
      useFactory: () => () => readDistillMinValid(process.env),
    },
    KeywordsService,
  ],
  exports: [KeywordsService],
})
export class KeywordsModule {}
