import { AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';

export type ExtensionRequestAuth = {
  tokenId: string;
  tenantId: string;
  userId: string;
  tokenLabel: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date;
  tenantName: string;
};

export type ExtensionHttpRequest = {
  headers?: Record<string, unknown>;
  method?: string;
  extensionAuth?: ExtensionRequestAuth;
};

export function setExtensionAuth(request: unknown, auth: ExtensionRequestAuth): void {
  if (request && typeof request === 'object') {
    (request as ExtensionHttpRequest).extensionAuth = auth;
  }
}

export function getExtensionAuth(request: unknown): ExtensionRequestAuth {
  if (request && typeof request === 'object') {
    const auth = (request as ExtensionHttpRequest).extensionAuth;
    if (auth) {
      return auth;
    }
  }
  throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '缺少扩展配对令牌');
}
