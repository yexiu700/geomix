import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { writeBlockReason } from './access-policy';
import { asHttpRequest } from './http-request';

@Injectable()
export class TenantActiveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = asHttpRequest(context.switchToHttp().getRequest());
    if (!request.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    const reason = writeBlockReason(request.auth, request.method, Date.now());
    if (reason === 'inactive') throw new ApiError(403, API_ERROR.TENANT_EXPIRED, '账号已停用');
    if (reason === 'expired') {
      throw new ApiError(403, API_ERROR.TENANT_EXPIRED, '账号已到期，当前为只读');
    }
    return true;
  }
}
