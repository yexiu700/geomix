import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  CrudQueryError,
  ok,
  parseCrudListQuery,
  SAMPLE_ID,
  sampleBulkSchema,
  sampleExportFilename,
  sampleExportMime,
  sampleExportTable,
  sampleInputSchema,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { SamplesService } from './samples.service';

@Controller('workbench/samples')
@UseGuards(AuthGuard, TenantActiveGuard)
export class SamplesController {
  constructor(@Inject(SamplesService) private readonly samples: SamplesService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseQuery(query);
    if (!parsed.export) {
      response.status(200).json(ok(await this.samples.page(parsed)));
      return;
    }
    const table = sampleExportTable(await this.samples.collect(parsed));
    const body =
      parsed.export === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(parsed.export));
    response.setHeader(
      'content-disposition',
      `attachment; filename="${sampleExportFilename(parsed.export)}"`,
    );
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    return ok(await this.samples.one(readId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown) {
    return ok(await this.samples.create(parseBody(sampleInputSchema, body)));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return ok(await this.samples.update(readId(id), parseBody(sampleInputSchema, body)));
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const input = parseBody(sampleBulkSchema, body);
    return ok(await this.samples.bulk(input.action, input.ids));
  }
}

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseQuery(query: Record<string, unknown>) {
  try {
    return parseCrudListQuery(query);
  } catch (error) {
    if (error instanceof CrudQueryError)
      throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
    throw error;
  }
}

function readId(id: string): string {
  if (!SAMPLE_ID.test(id)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '记录编号不正确');
  return id;
}
