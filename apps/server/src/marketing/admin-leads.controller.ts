import { Body, Controller, Get, Inject, Param, Patch, Query, UseGuards } from '@nestjs/common';
import {
  API_ERROR,
  listMarketingLeadsQuerySchema,
  ok,
  updateMarketingLeadStatusSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { AdminGuard } from '../billing/admin.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { MarketingService } from './marketing.service';

@Controller('admin/leads')
@UseGuards(AuthGuard, AdminGuard, TenantActiveGuard)
export class AdminLeadsController {
  constructor(@Inject(MarketingService) private readonly marketing: MarketingService) {}

  @Get()
  async listLeads(@Query() query: Record<string, unknown>) {
    const flat = flattenQuery(query);
    const input = parseBody(listMarketingLeadsQuerySchema, flat);
    return ok(await this.marketing.listLeads(input));
  }

  @Patch(':id')
  async updateLead(@Param('id') id: string, @Body() body: unknown) {
    const leadId = readLeadId(id);
    const input = parseBody(updateMarketingLeadStatusSchema, body);
    return ok(await this.marketing.updateLead(leadId, input));
  }
}

function flattenQuery(raw: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) {
      out[key] = undefined;
    } else if (typeof val === 'string') {
      out[key] = val;
    } else {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `查询参数 ${key} 格式不正确`);
    }
  }
  return out;
}

function readLeadId(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '线索编号不正确');
  }
  return value;
}
