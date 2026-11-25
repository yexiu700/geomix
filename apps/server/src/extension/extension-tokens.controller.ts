import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ok } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { requireAuth } from '../brands/brands.http-utils';
import { parseEntityId } from '../studio/studio.controller';
import { ExtensionTokenService } from './extension-token.service';

@Controller({ path: 'extension/tokens', version: '2' })
@UseGuards(AuthGuard)
export class ExtensionTokensController {
  constructor(
    @Inject(ExtensionTokenService)
    private readonly tokenService: ExtensionTokenService,
  ) {}

  @Get()
  async listTokens() {
    const result = await this.tokenService.listTokens();
    return ok(result);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createToken(@Req() req: unknown, @Body() body: unknown) {
    const auth = requireAuth(req);
    const result = await this.tokenService.createToken(body, auth);
    return ok(result);
  }

  @Delete(':id')
  @UseGuards(TenantActiveGuard)
  async revokeToken(@Param('id') rawId: string) {
    const tokenId = parseEntityId(rawId, '扩展配对令牌编号');
    const result = await this.tokenService.revokeToken(tokenId);
    return ok(result);
  }
}
