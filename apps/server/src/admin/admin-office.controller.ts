import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  AccountQueryError,
  announcementSchema,
  createTenantSchema,
  ok,
  pricingUpdateSchema,
  quotaUpdateSchema,
  readIdempotencyKey,
  templateWriteSchema,
  updateTenantSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { AdminGuard } from '../billing/admin.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { AdminOfficeService } from './admin-office.service';

@Controller('admin')
@UseGuards(AuthGuard, TenantActiveGuard, AdminGuard)
export class AdminOfficeController {
  constructor(@Inject(AdminOfficeService) private readonly office: AdminOfficeService) {}

  @Get('tenants')
  async tenants(@Query() query: Record<string, unknown>) {
    const page = readPage(query);
    return ok(await this.office.listTenants(page.page, page.pageSize, page.keyword));
  }

  @Post('tenants')
  @HttpCode(200)
  async createTenant(@Req() request: unknown, @Body() body: unknown) {
    const actor = requireActor(request);
    const input = parseBody(createTenantSchema, body);
    return ok(await this.office.createTenant(actor, input, optionalKey(request)));
  }

  @Get('tenants/:id')
  async tenant(@Param('id') id: string) {
    return ok(await this.office.tenant(readId(id)));
  }

  @Patch('tenants/:id')
  async updateTenant(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    return ok(
      await this.office.updateTenant(
        requireActor(request),
        readId(id),
        parseBody(updateTenantSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Put('tenants/:id/quotas')
  async quotas(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    return ok(
      await this.office.updateQuotas(
        requireActor(request),
        readId(id),
        parseBody(quotaUpdateSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Get('pricing')
  async prices() {
    return ok(await this.office.listPrices());
  }

  @Patch('pricing')
  async updatePrice(@Req() request: unknown, @Body() body: unknown) {
    return ok(
      await this.office.updatePrice(
        requireActor(request),
        parseBody(pricingUpdateSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Get('announcements')
  async announcements() {
    return ok(await this.office.listAnnouncements());
  }

  @Post('announcements')
  @HttpCode(200)
  async createAnnouncement(@Req() request: unknown, @Body() body: unknown) {
    return ok(
      await this.office.createAnnouncement(
        requireActor(request),
        parseBody(announcementSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Patch('announcements/:id')
  async updateAnnouncement(
    @Req() request: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return ok(
      await this.office.updateAnnouncement(
        requireActor(request),
        readId(id),
        parseBody(announcementSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Get('templates')
  async templates() {
    return ok(await this.office.listTemplates());
  }

  @Post('templates')
  @HttpCode(200)
  async createTemplate(@Req() request: unknown, @Body() body: unknown) {
    return ok(
      await this.office.createTemplate(
        requireActor(request),
        parseBody(templateWriteSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Patch('templates/:id')
  async updateTemplate(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    return ok(
      await this.office.updateTemplate(
        requireActor(request),
        readId(id),
        parseBody(templateWriteSchema, body),
        optionalKey(request),
      ),
    );
  }

  @Get('llm-costs')
  async llmCosts(@Req() request: unknown, @Query() query: Record<string, unknown>) {
    return ok(await this.office.llmCostReport(requireActor(request), query));
  }
}

function requireActor(request: unknown): { userId: string; role: 'ADMIN' | 'MERCHANT' } {
  const http = asHttpRequest(request);
  if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  return { userId: http.auth.userId, role: http.auth.role };
}

function optionalKey(request: unknown): string | undefined {
  const http = asHttpRequest(request);
  const raw = http.header('idempotency-key');
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return readIdempotencyKey(raw.trim());
  } catch (error) {
    if (error instanceof AccountQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
    }
    throw error;
  }
}

function readId(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '编号不正确');
  }
  return value;
}

function readPage(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
  keyword: string;
} {
  const page = readPositive(query.page, 1);
  const pageSize = readPositive(query.pageSize, 10);
  if (![10, 25, 50].includes(pageSize)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '分页不正确');
  }
  const keyword = one(query.keyword) ?? '';
  if (keyword.length > 40) throw new ApiError(400, API_ERROR.BAD_REQUEST, '名称不正确');
  return { page, pageSize, keyword: keyword.trim() };
}

function readPositive(value: unknown, fallback: number): number {
  const raw = one(value);
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '分页不正确');
  return Number(raw);
}

function one(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}
