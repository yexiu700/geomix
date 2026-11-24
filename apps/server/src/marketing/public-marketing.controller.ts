import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ok } from '@geomix/shared';
import { clientAddress } from '../auth/client-address';
import { MarketingService } from './marketing.service';

@Controller({ path: 'public', version: '2' })
export class PublicMarketingController {
  constructor(@Inject(MarketingService) private readonly marketing: MarketingService) {}

  @Post('leads')
  @HttpCode(200)
  async submitLead(@Req() request: unknown, @Body() body: unknown) {
    const ip = clientAddress(request);
    return ok(await this.marketing.submitLead(body, ip));
  }

  @Get('pricing')
  async getPublicPricing() {
    return ok(await this.marketing.getPublicPricing());
  }
}
