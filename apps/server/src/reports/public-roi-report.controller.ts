import { Controller, Get, Header, Inject, Param, Req } from '@nestjs/common';
import { ok } from '@geomix/shared';
import { clientAddress } from '../auth/client-address';
import { RoiReportPublicService } from './roi-report-public.service';

@Controller({ path: 'public/roi-reports', version: '2' })
export class PublicRoiReportController {
  constructor(
    @Inject(RoiReportPublicService)
    private readonly publicReports: RoiReportPublicService,
  ) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async getPublicReport(@Req() request: unknown, @Param('token') token: string) {
    const ip = clientAddress(request);
    return ok(await this.publicReports.getPublicReport(token, ip));
  }
}
