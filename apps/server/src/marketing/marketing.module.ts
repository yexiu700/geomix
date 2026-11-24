import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminLeadsController } from './admin-leads.controller';
import { MarketingService } from './marketing.service';
import { PublicMarketingController } from './public-marketing.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PublicMarketingController, AdminLeadsController],
  providers: [MarketingService],
  exports: [MarketingService],
})
export class MarketingModule {}
