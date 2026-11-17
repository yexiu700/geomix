import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminOfficeController } from './admin-office.controller';
import { AdminOfficeService } from './admin-office.service';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [AdminOfficeController],
  providers: [AdminOfficeService],
})
export class AdminOfficeModule {}
