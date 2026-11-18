import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseFilters,
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
import { isProviderError, providerToApi } from '../infra/provider-error';
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

function decodeUploadFilename(raw?: string): string | undefined {
  if (!raw) return raw;
  let hasHighLatin1 = false;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code > 0xff) return raw;
    if (code >= 0x80) hasHighLatin1 = true;
  }
  if (!hasHighLatin1) return raw;
  const latin1Buf = Buffer.from(raw, 'latin1');
  const utf8 = latin1Buf.toString('utf8');
  if (utf8.includes('\ufffd')) return raw;
  return Buffer.from(utf8, 'utf8').equals(latin1Buf) ? utf8 : raw;
}

function readUploadHttpMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('；');
  }
  return exception.message;
}

function mapUploadMulterMessage(
  status: number,
  rawMsg: string,
): { status: number; code: number; msg: string } | null {
  if (status === 413 || rawMsg === 'File too large' || rawMsg === 'LIMIT_FILE_SIZE') {
    return { status: 413, code: API_ERROR.BAD_REQUEST, msg: GALLERY_FILE_TOO_LARGE_MSG };
  }
  if (rawMsg === 'Too many files' || rawMsg === 'LIMIT_FILE_COUNT') {
    return {
      status: 400,
      code: API_ERROR.BAD_REQUEST,
      msg: `单次最多上传 ${GALLERY_UPLOAD_MAX_FILES} 张图片`,
    };
  }
  if (rawMsg === 'Unexpected field' || rawMsg === 'LIMIT_UNEXPECTED_FILE') {
    return {
      status: 400,
      code: API_ERROR.BAD_REQUEST,
      msg: '上传字段不正确，请使用 files 字段上传图片',
    };
  }
  if (
    rawMsg === 'Boundary not found' ||
    rawMsg.startsWith('Multipart:') ||
    rawMsg === 'LIMIT_PART_COUNT' ||
    rawMsg === 'LIMIT_FIELD_KEY' ||
    rawMsg === 'LIMIT_FIELD_VALUE' ||
    rawMsg === 'LIMIT_FIELD_COUNT' ||
    rawMsg === 'Field name missing'
  ) {
    return {
      status: 400,
      code: API_ERROR.BAD_REQUEST,
      msg: '上传请求格式不正确，请使用 multipart/form-data 重试',
    };
  }
  return null;
}

@Catch()
class GalleryUploadExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GalleryUploadExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<DownloadResponse>();
    if (exception instanceof ApiError) {
      if (exception.retryAfterSeconds !== undefined) {
        response.setHeader('Retry-After', String(exception.retryAfterSeconds));
      }
      response.status(exception.status).json({
        code: exception.code,
        msg: exception.message,
        data: null,
      });
      return;
    }
    if (isProviderError(exception)) {
      const apiErr = providerToApi(exception);
      response.status(apiErr.status).json({
        code: apiErr.code,
        msg: apiErr.message,
        data: null,
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawMsg = readUploadHttpMessage(exception);
      const multerMapped = mapUploadMulterMessage(status, rawMsg);
      if (multerMapped) {
        response.status(multerMapped.status).json({
          code: multerMapped.code,
          msg: multerMapped.msg,
          data: null,
        });
        return;
      }
      if (status === 404) {
        response.status(404).json({ code: AUTH_ERROR.NOT_FOUND, msg: rawMsg, data: null });
        return;
      }
      if (status === 401) {
        response.status(401).json({ code: AUTH_ERROR.UNAUTHORIZED, msg: rawMsg, data: null });
        return;
      }
      if (status === 403) {
        response.status(403).json({ code: API_ERROR.TENANT_EXPIRED, msg: rawMsg, data: null });
        return;
      }
      if (status < 500) {
        response.status(status).json({ code: API_ERROR.BAD_REQUEST, msg: rawMsg, data: null });
        return;
      }
    }
    if (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      typeof (exception as { code?: unknown }).code === 'string'
    ) {
      const multerMapped = mapUploadMulterMessage(400, (exception as { code: string }).code);
      if (multerMapped) {
        response.status(multerMapped.status).json({
          code: multerMapped.code,
          msg: multerMapped.msg,
          data: null,
        });
        return;
      }
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({ code: 50000, msg: '服务器错误', data: null });
  }
}

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
  @UseFilters(GalleryUploadExceptionFilter)
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
      filename: decodeUploadFilename(file.originalname),
      buffer: Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0),
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
