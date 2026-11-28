import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ACCOUNT_EXPORT_LIMIT,
  API_ERROR,
  AUTH_ERROR,
  AccountQueryError,
  MONEY_LEDGER_COLUMNS,
  POINT_LEDGER_COLUMNS,
  formatLedgerTime,
  ok,
  parseMoneyListQuery,
  parsePointListQuery,
  toCsv,
  toXlsx,
  verificationSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { MeService } from './me.service';

@Controller('me')
@UseGuards(AuthGuard, TenantActiveGuard)
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  @Get('points')
  async points(
    @Req() request: unknown,
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseQuery(() => parsePointListQuery(query));
    const tenantId = requireTenant(request);
    if (!parsed.export) {
      response.status(200).json(ok(await this.me.points(tenantId, parsed)));
      return;
    }
    const rows = await this.me.collectPoints(tenantId, parsed, ACCOUNT_EXPORT_LIMIT);
    sendTable(
      response,
      parsed.export,
      [...POINT_LEDGER_COLUMNS, '对账'],
      rows.map((row) => [row.title, row.pointsText, formatLedgerTime(row.createdAt), row.phrase]),
      'geomix-points',
    );
  }

  @Get('money')
  async money(
    @Req() request: unknown,
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseQuery(() => parseMoneyListQuery(query));
    const tenantId = requireTenant(request);
    if (!parsed.export) {
      response.status(200).json(ok(await this.me.money(tenantId, parsed)));
      return;
    }
    const rows = await this.me.collectMoney(tenantId, parsed, ACCOUNT_EXPORT_LIMIT);
    sendTable(
      response,
      parsed.export,
      [...MONEY_LEDGER_COLUMNS],
      rows.map((row) => [row.title, row.amount, row.remark, formatLedgerTime(row.createdAt)]),
      'geomix-money',
    );
  }

  @Get('rights')
  async rights(@Req() request: unknown) {
    return ok(await this.me.rights(requireTenant(request)));
  }

  @Get('verification')
  async verification(@Req() request: unknown) {
    return ok(await this.me.verification(requireTenant(request)));
  }

  @Post('verification')
  @HttpCode(200)
  async submitVerification(@Req() request: unknown, @Body() body: unknown) {
    const auth = requireAuth(request);
    return ok(
      await this.me.submitVerification(
        auth.tenantId,
        auth.userId,
        parseBody(verificationSchema, body),
      ),
    );
  }
}

@Controller()
@UseGuards(AuthGuard, TenantActiveGuard)
export class AnnouncementFeedController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  @Get('announcements')
  async list() {
    return ok(await this.me.announcements());
  }
}

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function requireAuth(request: unknown): { userId: string; tenantId: string } {
  const http = asHttpRequest(request);
  if (!http.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  return { userId: http.auth.userId, tenantId: http.auth.tenantId };
}

function requireTenant(request: unknown): string {
  return requireAuth(request).tenantId;
}

function parseQuery<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof AccountQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
    }
    throw error;
  }
}

function sendTable(
  response: DownloadResponse,
  format: 'csv' | 'xlsx',
  headers: string[],
  rows: string[][],
  stem: string,
): void {
  const body = format === 'csv' ? toCsv(headers, rows) : Buffer.from(toXlsx(headers, rows));
  const mime =
    format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  response.status(200);
  response.setHeader('content-type', mime);
  response.setHeader('content-disposition', `attachment; filename="${stem}.${format}"`);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.send(body);
}
