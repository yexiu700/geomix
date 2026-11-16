import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { runInTenant } from '../tenant/tenant-context';
import { AuthService } from './auth.service';
import { asHttpRequest } from './http-request';

@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  use(request: unknown, _response: unknown, next: (error?: unknown) => void): void {
    void this.attach(request, next);
  }

  private async attach(request: unknown, next: (error?: unknown) => void): Promise<void> {
    try {
      const http = asHttpRequest(request);
      const header = http.header('authorization') ?? '';
      const match = /^Bearer\s+(\S+)$/.exec(header);
      if (!match?.[1]) {
        next();
        return;
      }
      const result = await this.auth.authenticateAccess(match[1]);
      if (!result.ok) {
        http.authFailure = { status: result.status, code: result.code, msg: result.msg };
        next();
        return;
      }
      http.auth = result.auth;
      runInTenant(result.auth.tenantId, () => {
        next();
      });
    } catch (error) {
      next(error);
    }
  }
}
