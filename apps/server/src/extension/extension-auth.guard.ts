import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { setExtensionAuth, type ExtensionHttpRequest } from './extension-auth.types';
import { ExtensionTokenLookupService } from './extension-token-lookup.service';

const BEARER_HEADER_RE = /^Bearer ([A-Za-z0-9_-]+)$/;

/**
 * Chrome 扩展桥接专用守卫：
 * - 仅挂在 3 个薄桥接端点（`/me`、`/tasks`、`/tasks/:taskId/confirm-published`）；
 * - 直接解析 `Authorization: Bearer gmext_...`，完全忽略 `req.auth` 与 `req.authFailure`；
 * - 鉴权成功后仅写入 `req.extensionAuth`，绝不触碰控制台 `req.auth`。
 */
@Injectable()
export class ExtensionAuthGuard implements CanActivate {
  constructor(
    @Inject(ExtensionTokenLookupService)
    private readonly tokenLookup: ExtensionTokenLookupService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ExtensionHttpRequest>();
    const rawHeader = request?.headers?.authorization;
    if (typeof rawHeader !== 'string' || rawHeader.trim().length === 0) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '缺少扩展配对令牌');
    }

    const match = BEARER_HEADER_RE.exec(rawHeader);
    if (!match || !match[1]) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '扩展配对令牌无效或已失效');
    }

    const auth = await this.tokenLookup.authenticate(match[1]);
    setExtensionAuth(request, auth);
    return true;
  }
}
