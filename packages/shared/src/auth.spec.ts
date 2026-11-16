import { describe, expect, it } from 'vitest';
import { AUTH_ERROR, changePasswordBodySchema, loginBodySchema } from './auth';

describe('auth contracts', () => {
  it('keeps the auth error codes next to the shared envelope', () => {
    expect(AUTH_ERROR).toEqual({ UNAUTHORIZED: 40101, NOT_FOUND: 40401 });
  });

  it('rejects a short new password and accepts a normal login body', () => {
    expect(
      loginBodySchema.safeParse({
        username: 'demo',
        password: 'geomix-demo-dev',
        captchaId: 'abc12345',
        captchaCode: 'ab12',
      }).success,
    ).toBe(true);
    const password = changePasswordBodySchema.safeParse({
      currentPassword: 'geomix-demo-dev',
      newPassword: 'short',
    });
    expect(password.success).toBe(false);
  });
});
