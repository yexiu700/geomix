import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  KB_AGREEMENT_KIND,
  KB_AGREEMENT_VERSION,
  KB_ID_PATTERN,
  agreementSignSchema,
  knowledgeBulkSchema,
  knowledgeExportTable,
  knowledgeWriteSchema,
  ok,
  parseKnowledgeListQuery,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { clientAddress } from '../auth/client-address';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { KnowledgeService } from './knowledge.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function readKbId(raw: string): string {
  const id = raw.trim();
  if (!KB_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '知识库编号不合法');
  }
  return id;
}

function requireUserId(req: unknown): string {
  const auth = asHttpRequest(req).auth;
  if (!auth?.userId) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return auth.userId;
}

@Controller('agreements')
@UseGuards(AuthGuard, TenantActiveGuard)
export class AgreementsController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get('status')
  async status(@Query() query: Record<string, string | string[] | undefined>) {
    const kindRaw = Array.isArray(query.kind) ? query.kind[0] : query.kind;
    const versionRaw = Array.isArray(query.version) ? query.version[0] : query.version;
    const kind = kindRaw?.trim() || KB_AGREEMENT_KIND;
    const version = versionRaw?.trim() || KB_AGREEMENT_VERSION;
    return ok(await this.knowledge.getAgreementStatus(kind, version));
  }

  @Post('sign')
  @HttpCode(200)
  async sign(@Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(agreementSignSchema, body ?? {});
    const userId = requireUserId(req);
    const ip = clientAddress(req);
    return ok(await this.knowledge.signAgreement(parsed, { userId, ip }));
  }
}

@Controller('knowledge-bases')
@UseGuards(AuthGuard, TenantActiveGuard)
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseKnowledgeListQuery(query);
    const exportKind = query.export === 'csv' || query.export === 'xlsx' ? query.export : undefined;
    if (!exportKind) {
      response.status(200).json(ok(await this.knowledge.page(parsed)));
      return;
    }
    const rows = await this.knowledge.exportRows(parsed);
    const table = knowledgeExportTable(rows);
    const body =
      exportKind === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(exportKind));
    response.setHeader(
      'content-disposition',
      `attachment; filename="knowledge-bases.${exportKind}"`,
    );
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.knowledge.findOne(readKbId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    await this.knowledge.assertAgreementSigned();
    const parsed = parseBody(knowledgeWriteSchema, body);
    return ok(await this.knowledge.create(parsed, userId));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const kbId = readKbId(id);
    const userId = requireUserId(req);
    await this.knowledge.assertAgreementSigned();
    const parsed = parseBody(knowledgeWriteSchema, body);
    return ok(await this.knowledge.update(kbId, parsed, userId));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const parsed = parseBody(knowledgeBulkSchema, body);
    return ok(await this.knowledge.removeMany(parsed.ids));
  }

  @Delete(':id')
  async removeOne(@Param('id') id: string) {
    return ok(await this.knowledge.removeMany([readKbId(id)]));
  }
}
