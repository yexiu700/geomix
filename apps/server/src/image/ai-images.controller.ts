import {
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  aiImageBulkDeleteSchema,
  aiImageCreateSchema,
  aiImageExportTable,
  aiImageOptimizePromptSchema,
  aiImageSaveToGallerySchema,
  ok,
  parseAiImageJobListQuery,
  parseEnv,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { AiImagesService } from './ai-images.service';

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseJobId(raw: string): string {
  const trimmed = raw.trim();
  if (!JOB_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '生图任务编号不合法');
  }
  return trimmed;
}

@Injectable()
export class AiImageFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!parseEnv(process.env).FEATURE_AI_IMAGE) {
      throw new ApiError(403, API_ERROR.BAD_REQUEST, 'AI 生图功能暂未开启');
    }
    return true;
  }
}

@Controller('image-jobs')
@UseGuards(AuthGuard, AiImageFeatureGuard)
export class AiImagesController {
  constructor(@Inject(AiImagesService) private readonly aiImages: AiImagesService) {}

  @Get()
  async list(
    @Query() rawQuery: Record<string, unknown>,
    @Res() res: DownloadResponse,
  ): Promise<void> {
    const query = parseAiImageJobListQuery(rawQuery);
    const exportFormat = typeof rawQuery.export === 'string' ? rawQuery.export.trim() : '';

    if (exportFormat === 'csv' || exportFormat === 'xlsx') {
      const items = await this.aiImages.collectForExport(query);
      const table = aiImageExportTable(items);
      if (exportFormat === 'csv') {
        const csv = toCsv(table.headers, table.rows);
        res.status(200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="geomix-ai-images.csv"');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(csv);
        return;
      }
      const xlsx = Buffer.from(toXlsx(table.headers, table.rows));
      res.status(200);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="geomix-ai-images.xlsx"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(xlsx);
      return;
    }

    res.status(200).json(ok(await this.aiImages.list(query)));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.aiImages.detail(parseJobId(id)));
  }

  @Post('optimize-prompt')
  @UseGuards(TenantActiveGuard)
  @HttpCode(200)
  async optimizePrompt(@Req() req: unknown, @Body() body: unknown) {
    const input = parseBody(aiImageOptimizePromptSchema, body);
    const userId = asHttpRequest(req).auth?.userId;
    return ok(await this.aiImages.optimizePrompt(input, userId));
  }

  @Post()
  @UseGuards(TenantActiveGuard)
  @HttpCode(200)
  async create(@Req() req: unknown, @Body() body: unknown) {
    const input = parseBody(aiImageCreateSchema, body);
    const userId = asHttpRequest(req).auth?.userId;
    return ok(await this.aiImages.create(input, userId));
  }

  @Post(':id/save-to-gallery')
  @UseGuards(TenantActiveGuard)
  @HttpCode(200)
  async saveToGallery(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(aiImageSaveToGallerySchema, body);
    return ok(await this.aiImages.saveToGallery(parseJobId(id), input));
  }

  @Post('bulk-delete')
  @UseGuards(TenantActiveGuard)
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const input = parseBody(aiImageBulkDeleteSchema, body);
    return ok(await this.aiImages.bulkDelete(input.ids));
  }

  @Delete(':id')
  @UseGuards(TenantActiveGuard)
  async deleteOne(@Param('id') id: string) {
    return ok(await this.aiImages.bulkDelete([parseJobId(id)]));
  }
}
