import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  extractBrandFactsSchema,
  ok,
  upsertBrandFactsSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { clientAddress } from '../auth/client-address';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBody } from '../common/parse-body';
import { BrandFactsService } from './brand-facts.service';
import {
  BrandUploadExceptionFilter,
  decodeUploadFilename,
  parseBrandId,
  parseOptionalProductLineId,
  requireAuth,
  type UploadedFileLike,
} from './brands.http-utils';

@Controller({ path: 'brands', version: '2' })
@UseGuards(AuthGuard)
export class BrandFactsController {
  constructor(@Inject(BrandFactsService) private readonly brandFacts: BrandFactsService) {}

  @Get(':id/facts')
  async list(@Param('id') id: string, @Query('productLineId') rawProductLineId?: string) {
    const brandId = parseBrandId(id);
    const productLineId = parseOptionalProductLineId(rawProductLineId);
    return ok(await this.brandFacts.getFacts(brandId, productLineId));
  }

  @Put(':id/facts')
  @UseGuards(TenantActiveGuard)
  async upsert(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const input = parseBody(upsertBrandFactsSchema, body);
    return ok(
      await this.brandFacts.upsertFacts(
        auth.tenantId,
        auth.userId,
        brandId,
        input,
        clientAddress(request),
      ),
    );
  }

  @Post(':id/facts/extract')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  @UseFilters(BrandUploadExceptionFilter)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        fileSize: BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
        files: 1,
      },
    }),
  )
  async extract(
    @Req() request: unknown,
    @Param('id') id: string,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);

    const firstFile = Array.isArray(files) && files.length > 0 ? files[0] : undefined;
    if (firstFile) {
      return ok(
        await this.brandFacts.extractFacts(auth.tenantId, auth.userId, brandId, {
          sourceType: 'DOC_UPLOAD',
          file: {
            filename: decodeUploadFilename(firstFile.originalname),
            mimetype: firstFile.mimetype,
            buffer: firstFile.buffer,
          },
        }),
      );
    }

    const parsed = parseBody(extractBrandFactsSchema, body);
    return ok(
      await this.brandFacts.extractFacts(auth.tenantId, auth.userId, brandId, {
        sourceType: parsed.sourceType,
        url: parsed.url,
        rawText: parsed.rawText,
        text: parsed.text,
        fileName: parsed.fileName,
      }),
    );
  }
}
