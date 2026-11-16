import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { asHttpRequest } from '../auth/http-request';

/** 非管理员看到的是 404，避免把管理接口暴露成可探测的跨租户入口。 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = asHttpRequest(context.switchToHttp().getRequest());
    if (!request.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    if (request.auth.role !== 'ADMIN') throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '不存在');
    return true;
  }
}
