import type { AuthFailure, RequestAuth } from './auth.types';

export type HttpRequest = {
  header(name: string): string | undefined;
  method: string;
  auth?: RequestAuth;
  authFailure?: AuthFailure;
};

export function asHttpRequest(value: unknown): HttpRequest {
  return value as HttpRequest;
}
