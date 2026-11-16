import { createHash, timingSafeEqual } from 'node:crypto';
import { API_ERROR, AUTH_ERROR, type ChangePasswordBody, type LoginBody } from '@geomix/shared';
import { hashPassword, verifyPassword } from '@geomix/db';
import { ApiError } from '../common/api-error';
import { isReadOnly } from './access-policy';
import type {
  AccessResult,
  AuthConfig,
  AuthStore,
  AuthUser,
  IssuedSession,
  RequestAuth,
} from './auth.types';
import { CaptchaService } from './captcha.service';
import { readToken, signToken, type TokenClaims, type TokenKind } from './token';

let dummyHash: string | null = null;

function dummyPasswordHash(): string {
  dummyHash ??= hashPassword('geomix-dummy-timing');
  return dummyHash;
}

export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 32);
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly captcha: CaptchaService,
    private readonly config: AuthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async login(input: LoginBody): Promise<IssuedSession> {
    if (!this.captcha.consume(input.captchaId, input.captchaCode)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '验证码错误或已过期');
    }
    const user = await this.store.findUserByUsername(input.username);
    const hash = user?.passwordHash ?? dummyPasswordHash();
    const matched = verifyPassword(input.password, hash);
    if (!user || !matched) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '用户名或密码错误');
    }
    if (!user.isActive) {
      throw new ApiError(403, API_ERROR.TENANT_EXPIRED, '账号已停用');
    }
    await this.store.touchLogin(user.id, new Date(this.now()));
    return this.issue(user);
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const user = await this.requireUser(refreshToken, 'refresh');
    return this.issue(user);
  }

  async logout(refreshToken: string): Promise<{ revoked: true }> {
    const user = await this.requireUser(refreshToken, 'refresh');
    await this.store.revoke(user.id, user.tenantId, this.now());
    return { revoked: true };
  }

  async changePassword(auth: RequestAuth, input: ChangePasswordBody): Promise<IssuedSession> {
    const user = await this.store.findUserById(auth.userId);
    if (!user || user.tenantId !== auth.tenantId || !user.isActive) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '登录已失效');
    }
    if (!verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '当前密码不正确');
    }
    if (input.newPassword === input.currentPassword) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '新密码需要和当前密码不同');
    }
    const passwordHash = hashPassword(input.newPassword);
    const at = this.now();
    await this.store.updatePassword(user.id, passwordHash);
    await this.store.revoke(user.id, user.tenantId, at);
    user.passwordHash = passwordHash;
    return this.issue(user);
  }

  async authenticateAccess(token: string): Promise<AccessResult> {
    const claims = readToken(token, this.config.accessSecret, this.now());
    if (!claims || claims.typ !== 'access') {
      return { ok: false, status: 401, code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录' };
    }
    return this.authorize(claims);
  }

  private async requireUser(token: string, kind: TokenKind): Promise<AuthUser> {
    const secret = kind === 'access' ? this.config.accessSecret : this.config.refreshSecret;
    const claims = readToken(token, secret, this.now());
    if (!claims || claims.typ !== kind) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '登录已失效');
    }
    const result = await this.authorize(claims);
    if (!result.ok) throw new ApiError(result.status, result.code, result.msg);
    const user = await this.store.findUserById(result.auth.userId);
    if (!user) throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '登录已失效');
    return user;
  }

  private async authorize(claims: TokenClaims): Promise<AccessResult> {
    const user = await this.store.findUserById(claims.sub);
    if (!user || user.tenantId !== claims.tid) {
      return { ok: false, status: 401, code: AUTH_ERROR.UNAUTHORIZED, msg: '登录已失效' };
    }
    const fingerprint = passwordFingerprint(user.passwordHash);
    const actual = Buffer.from(claims.fp);
    const expected = Buffer.from(fingerprint);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, status: 401, code: AUTH_ERROR.UNAUTHORIZED, msg: '登录已失效' };
    }
    const revokedAt = await this.store.latestRevokeAt(user.id);
    if (revokedAt !== null && claims.lms <= revokedAt) {
      return { ok: false, status: 401, code: AUTH_ERROR.UNAUTHORIZED, msg: '登录已失效' };
    }
    if (!user.isActive) {
      return { ok: false, status: 403, code: API_ERROR.TENANT_EXPIRED, msg: '账号已停用' };
    }
    return {
      ok: true,
      auth: {
        userId: user.id,
        tenantId: user.tenantId,
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        tenantName: user.tenantName,
        expiresAt: user.expiresAt,
        isActive: user.isActive,
      },
    };
  }

  private async issue(user: AuthUser): Promise<IssuedSession> {
    const revokedAt = await this.store.latestRevokeAt(user.id);
    const lms = Math.max(this.now(), (revokedAt ?? 0) + 1);
    const fp = passwordFingerprint(user.passwordHash);
    const access = this.claims(user, 'access', fp, lms, this.config.accessTtlSeconds);
    const refresh = this.claims(user, 'refresh', fp, lms, this.config.refreshTtlSeconds);
    const now = this.now();
    return {
      accessToken: signToken(access, this.config.accessSecret),
      refreshToken: signToken(refresh, this.config.refreshSecret),
      accessExpiresAt: new Date(access.exp * 1000).toISOString(),
      refreshExpiresAt: new Date(refresh.exp * 1000).toISOString(),
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenantName,
        expiresAt: user.expiresAt.toISOString(),
        readOnly: isReadOnly(user, now),
      },
    };
  }

  private claims(
    user: AuthUser,
    typ: TokenKind,
    fp: string,
    lms: number,
    ttlSeconds: number,
  ): TokenClaims {
    const iat = Math.floor(lms / 1000);
    return {
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      typ,
      fp,
      lms,
      iat,
      exp: iat + ttlSeconds,
    };
  }
}
