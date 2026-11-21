import { randomUUID } from 'node:crypto';
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
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  API_ERROR,
  AUTH_ERROR,
  AccountQueryError,
  BRAND_MEDIA_FILE_TOO_LARGE_MSG,
  BRAND_MEDIA_UPLOAD_MAX_FILES,
  IMAGE_MAX_INPUT_BYTES,
  inlineAiImageGenSchema,
  ok,
  readIdempotencyKey,
  updateBrandMediaSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { BrandMediaService } from './brand-media.service';
import {
  BrandUploadExceptionFilter,
  GALLERY_MAX_INPUT_BYTES_TOKEN,
  decodeUploadFilename,
  parseBrandId,
  parseMediaId,
  requireAuth,
  type UploadedFileLike,
} from './brands.http-utils';

type BinaryResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): { send(body: Buffer): void };
};

function resolveIdempotencyHeader(req: unknown): string {
  const headers =
    req && typeof req === 'object' && 'headers' in req
      ? ((req as { headers?: Record<string, unknown> }).headers ?? {})
      : {};
  const raw = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (raw === undefined || raw === null || raw === '') {
    return `auto_${randomUUID().replace(/-/g, '')}`;
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Idempotency-Key 请求头格式不正确');
  }
  try {
    return readIdempotencyKey(raw);
  } catch (err) {
    if (err instanceof AccountQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, err.message);
    }
    throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Idempotency-Key 请求头格式不正确');
  }
}

@Controller({ path: 'brands', version: '2' })
@UseGuards(AuthGuard)
export class BrandMediaController {
  constructor(
    @Inject(BrandMediaService) private readonly brandMedia: BrandMediaService,
    @Inject(GALLERY_MAX_INPUT_BYTES_TOKEN) private readonly maxInputBytes: () => number,
  ) {}

  @Get(':id/media')
  async list(@Req() request: unknown, @Param('id') id: string) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    return ok(await this.brandMedia.listMedia(auth.tenantId, brandId));
  }

  @Post(':id/media')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  @UseFilters(BrandUploadExceptionFilter)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        fileSize: IMAGE_MAX_INPUT_BYTES,
        files: BRAND_MEDIA_UPLOAD_MAX_FILES,
      },
    }),
  )
  async upload(
    @Req() request: unknown,
    @Param('id') id: string,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);

    const declaredRaw = asHttpRequest(request).header('x-declared-file-bytes');
    if (declaredRaw && /^\d+$/.test(declaredRaw.trim())) {
      const declaredBytes = Number(declaredRaw.trim());
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > this.maxInputBytes()) {
        throw new ApiError(413, API_ERROR.BAD_REQUEST, BRAND_MEDIA_FILE_TOO_LARGE_MSG);
      }
    }

    const normalizedFiles = (files ?? []).map((file) => ({
      ...file,
      originalname: decodeUploadFilename(file.originalname),
    }));

    const title =
      body && typeof body === 'object' && typeof (body as { title?: unknown }).title === 'string'
        ? (body as { title: string }).title
        : undefined;

    return ok(
      await this.brandMedia.uploadMedia(
        auth.tenantId,
        auth.userId,
        brandId,
        normalizedFiles,
        title,
      ),
    );
  }

  @Post(':id/media/ai-gen')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async generateAiImage(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const input = parseBody(inlineAiImageGenSchema, body);
    const idempotencyKey = resolveIdempotencyHeader(request);
    return ok(
      await this.brandMedia.generateAiImage(
        auth.tenantId,
        auth.userId,
        brandId,
        input,
        idempotencyKey,
      ),
    );
  }

  @Patch(':id/media/:mediaId')
  @UseGuards(TenantActiveGuard)
  async update(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('mediaId') rawMediaId: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const mediaId = parseMediaId(rawMediaId);
    const input = parseBody(updateBrandMediaSchema, body);
    return ok(
      await this.brandMedia.updateMedia(auth.tenantId, auth.userId, brandId, mediaId, input),
    );
  }

  @Delete(':id/media/:mediaId')
  @UseGuards(TenantActiveGuard)
  async remove(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('mediaId') rawMediaId: string,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const mediaId = parseMediaId(rawMediaId);
    return ok(await this.brandMedia.removeMedia(auth.tenantId, brandId, mediaId));
  }
}

@Controller({ path: 'brands', version: '2' })
export class BrandMediaPublicController {
  constructor(@Inject(BrandMediaService) private readonly brandMedia: BrandMediaService) {}

  @Get(':id/media/:mediaId/file')
  async getFile(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('mediaId') rawMediaId: string,
    @Query('tid') tid: unknown,
    @Query('exp') exp: unknown,
    @Query('sig') sig: unknown,
    @Res() res: BinaryResponseLike,
  ) {
    await this.serveVariant(request, id, rawMediaId, 'file', tid, exp, sig, res);
  }

  @Get(':id/media/:mediaId/thumb')
  async getThumb(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('mediaId') rawMediaId: string,
    @Query('tid') tid: unknown,
    @Query('exp') exp: unknown,
    @Query('sig') sig: unknown,
    @Res() res: BinaryResponseLike,
  ) {
    await this.serveVariant(request, id, rawMediaId, 'thumb', tid, exp, sig, res);
  }

  private async serveVariant(
    request: unknown,
    rawBrandId: string,
    rawMediaId: string,
    variant: 'file' | 'thumb',
    tid: unknown,
    exp: unknown,
    sig: unknown,
    res: BinaryResponseLike,
  ): Promise<void> {
    const brandId = parseBrandId(rawBrandId);
    const mediaId = parseMediaId(rawMediaId);

    const authTenantId = asHttpRequest(request).auth?.tenantId;
    let resolvedTenantId: string | null = null;

    if (authTenantId) {
      resolvedTenantId = authTenantId;
    } else if (
      typeof tid === 'string' &&
      typeof exp === 'string' &&
      typeof sig === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(tid) &&
      this.brandMedia.verifyMediaVariant(tid, brandId, mediaId, variant, sig, exp)
    ) {
      resolvedTenantId = tid;
    }

    if (!resolvedTenantId) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或图片访问签名无效');
    }

    const asset = await this.brandMedia.readAssetBytes(resolvedTenantId, brandId, mediaId, variant);
    res.setHeader('content-type', asset.contentType);
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(asset.body);
  }
}
