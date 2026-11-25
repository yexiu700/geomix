import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicRoiReportController } from './public-roi-report.controller';
import { RoiReportHtmlRenderer } from './roi-report-html.renderer';
import { RoiReportPublicService } from './roi-report-public.service';
import { BrandRoiReportsController, RoiReportsController } from './roi-reports.controller';
import { RoiReportsService } from './roi-reports.service';

@Module({
  imports: [PrismaModule, AuthModule, BrandsModule],
  controllers: [BrandRoiReportsController, RoiReportsController, PublicRoiReportController],
  providers: [RoiReportHtmlRenderer, RoiReportsService, RoiReportPublicService],
  exports: [RoiReportHtmlRenderer, RoiReportsService, RoiReportPublicService],
})
export class ReportsModule {}
