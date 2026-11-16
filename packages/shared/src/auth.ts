import { z } from 'zod';

/**
 * 认证模块自己的错误码。
 * 参数错误和账号到期继续用 infra 里已经公开的 40001 / 40301，这里只补登录态和租户内找不到资源。
 */
export const AUTH_ERROR = {
  UNAUTHORIZED: 40101,
  NOT_FOUND: 40401,
} as const;

export const CAPTCHA_TTL_MS = 120_000;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const loginBodySchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(32, '用户名过长'),
  password: z.string().min(1, '请输入密码').max(PASSWORD_MAX_LENGTH, '密码过长'),
  captchaId: z.string().trim().min(8, '请先获取验证码').max(64, '验证码无效'),
  captchaCode: z.string().trim().min(1, '请输入验证码').max(16, '验证码无效'),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, '缺少刷新令牌').max(8000, '刷新令牌无效'),
});

export const logoutBodySchema = refreshBodySchema;

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX_LENGTH, '密码过长'),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, '新密码至少 8 位')
    .max(PASSWORD_MAX_LENGTH, '新密码最多 128 位'),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
