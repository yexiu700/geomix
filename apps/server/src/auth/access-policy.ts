import type { RequestAuth } from './auth.types';

export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function isReadOnly(
  auth: Pick<RequestAuth, 'isActive' | 'expiresAt'>,
  nowMs: number,
): boolean {
  return !auth.isActive || auth.expiresAt.getTime() <= nowMs;
}

/** 停用账号任何请求都拒绝。到期账号只拒绝写。 */
export function writeBlockReason(
  auth: Pick<RequestAuth, 'isActive' | 'expiresAt'>,
  method: string,
  nowMs: number,
): 'inactive' | 'expired' | null {
  if (!auth.isActive) return 'inactive';
  if (isReadMethod(method)) return null;
  if (auth.expiresAt.getTime() <= nowMs) return 'expired';
  return null;
}
