import { API_ERROR } from '@geomix/shared';
import { ApiError } from './api-error';

type ParseSuccess<T> = { success: true; data: T };
type ParseFailure = { success: false; error: { issues: { message: string }[] } };

type BodySchema<T> = {
  safeParse(data: unknown): ParseSuccess<T> | ParseFailure;
};

export function parseBody<T>(schema: BodySchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const msg = parsed.error.issues.map((issue) => issue.message).join('；') || '参数错误';
  throw new ApiError(400, API_ERROR.BAD_REQUEST, msg);
}
