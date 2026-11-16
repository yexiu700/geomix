import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { asHttpRequest } from './http-request';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = asHttpRequest(context.switchToHttp().getRequest());
    if (request.authFailure) {
      throw new ApiError(
        request.authFailure.status,
        request.authFailure.code,
        request.authFailure.msg,
      );
    }
    if (!request.auth) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
    return true;
  }
}
