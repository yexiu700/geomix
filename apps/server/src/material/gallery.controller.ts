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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  API_ERROR,
  AUTH_ERROR,
  GALLERY_FILE_TOO_LARGE_MSG,
  GALLERY_ID_PATTERN,
  GALLERY_UPLOAD_MAX_FILES,
  IMAGE_MAX_INPUT_BYTES,
  mediaAssetExportTable,
  mediaBulkSchema,
  mediaCategoryExportTable,
  mediaCategoryWriteSchema,
  mediaUploadJsonSchema,
  ok,
  parseMediaAssetListQuery,
  parseMediaCategoryListQuery,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { GalleryService, type RawUploadFile } from './gallery.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

type MulterMemoryFile = {
  originalname?: string;
  buffer: Buffer;
  size: number;
};

function readGalleryId(raw: string, label = '编号'): string {
  const id = raw.trim();
  if (!GALLERY_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, `${label}不合法`);
  }
  return id;
}

@Controller('media-categories')
@UseGuards(AuthGuard, TenantActiveGuard)
export class GalleryCategoriesController {
  constructor(@Inject(GalleryService) private readonly gallery: GalleryService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseMediaCategoryListQuery(query);
    const exportKind = query.export === 'csv' || query.export === 'xlsx' ? query.export : undefined;
    if (!exportKind) {
      response.status(200).json(ok(await this.gallery.pageCategories(parsed)));
      return;
    }
    const table = mediaCategoryExportTable(await this.gallery.collectCategories(parsed));
    const body =
      exportKind === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(exportKind));
    response.setHeader(
      'content-disposition',
      `attachment; filename="media-categories.${exportKind}"`,
    );
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(mediaCategoryWriteSchema, body);
    return ok(
      await this.gallery.createCategory({
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(mediaCategoryWriteSchema, body);
    return ok(
      await this.gallery.updateCategory(readGalleryId(id, '素材分类编号'), {
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return ok(await this.gallery.removeCategories([readGalleryId(id, '素材分类编号')]));
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const parsed = parseBody(mediaBulkSchema, body);
    return ok(await this.gallery.removeCategories(parsed.ids));
  }
}

@Controller('media-assets')
@UseGuards(AuthGuard, TenantActiveGuard)
export class GalleryAssetsController {
  constructor(@Inject(GalleryService) private readonly gallery: GalleryService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseMediaAssetListQuery(query);
    const exportKind = query.export === 'csv' || query.export === 'xlsx' ? query.export : undefined;
    if (!exportKind) {
      response.status(200).json(ok(await this.gallery.pageAssets(parsed)));
      return;
    }
    const table = mediaAssetExportTable(await this.gallery.collectAssets(parsed));
    const body =
      exportKind === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(exportKind));
    response.setHeader('content-disposition', `attachment; filename="media-assets.${exportKind}"`);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Post()
  @HttpCode(200)
  async uploadJson(@Body() body: unknown) {
    const parsed = parseBody(mediaUploadJsonSchema, body);
    return ok(await this.gallery.uploadJson(parsed));
  }

  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(
    FilesInterceptor('files', GALLERY_UPLOAD_MAX_FILES, {
      limits: {
        fileSize: IMAGE_MAX_INPUT_BYTES,
        files: GALLERY_UPLOAD_MAX_FILES,
      },
    }),
  )
  async uploadMultipart(
    @Body() body: Record<string, unknown>,
    @UploadedFiles() uploaded: MulterMemoryFile[] | undefined,
    @Req() req: { headers?: Record<string, string | string[] | undefined> },
  ) {
    const declaredSize = req.headers?.['x-declared-file-bytes'];
    if (typeof declaredSize === 'string') {
      const parsedBytes = Number.parseInt(declaredSize, 10);
      if (Number.isFinite(parsedBytes) && parsedBytes > IMAGE_MAX_INPUT_BYTES) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, GALLERY_FILE_TOO_LARGE_MSG);
      }
    }
    const rawCategoryId = typeof body?.categoryId === 'string' ? body.categoryId : '';
    const categoryId = readGalleryId(rawCategoryId, '素材分类编号');
    const files: RawUploadFile[] = (uploaded ?? []).map((file) => ({
      filename: file.originalname,
      buffer: file.buffer,
    }));
    return ok(await this.gallery.uploadBuffers(categoryId, files));
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return ok(await this.gallery.removeAssets([readGalleryId(id, '图片编号')]));
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const parsed = parseBody(mediaBulkSchema, body);
    return ok(await this.gallery.removeAssets(parsed.ids));
  }
}

@Controller('media-assets')
export class GalleryPublicAssetsController {
  constructor(@Inject(GalleryService) private readonly gallery: GalleryService) {}

  @Get(':id/file')
  async getFile(
    @Param('id') id: string,
    @Query('tid') tid: string | undefined,
    @Query('sig') sig: string | undefined,
    @Req() req: unknown,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    await this.serveVariant(id, 'file', tid, sig, req, response);
  }

  @Get(':id/thumb')
  async getThumb(
    @Param('id') id: string,
    @Query('tid') tid: string | undefined,
    @Query('sig') sig: string | undefined,
    @Req() req: unknown,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    await this.serveVariant(id, 'thumb', tid, sig, req, response);
  }

  private async serveVariant(
    rawId: string,
    variant: 'file' | 'thumb',
    tid: string | undefined,
    sig: string | undefined,
    req: unknown,
    response: DownloadResponse,
  ): Promise<void> {
    const assetId = readGalleryId(rawId, '图片编号');
    const auth = asHttpRequest(req).auth;
    let tenantId: string | null = null;
    if (auth?.tenantId) {
      tenantId = auth.tenantId;
    } else if (
      tid &&
      GALLERY_ID_PATTERN.test(tid) &&
      sig &&
      this.gallery.verifyAssetVariant(tid, assetId, variant, sig)
    ) {
      tenantId = tid;
    }
    if (!tenantId) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或图片签名无效');
    }
    const data = await this.gallery.readAssetBytes(tenantId, assetId, variant);
    response.status(200);
    response.setHeader('content-type', data.contentType);
    response.setHeader('cache-control', 'private, max-age=300');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(data.body);
  }
}
