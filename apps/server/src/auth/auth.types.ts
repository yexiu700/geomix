export type UserRoleName = 'MERCHANT' | 'ADMIN';

export type AuthUiPrefs = {
  multiTab?: boolean;
  menuCollapsed?: boolean;
  submenusAlwaysVisible?: boolean;
  autoExpand?: boolean;
  multiLevel?: boolean;
};

export type AuthUser = {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: UserRoleName;
  uiPrefs?: unknown;
  tenantName: string;
  expiresAt: Date;
  isActive: boolean;
};

export type RequestAuth = {
  userId: string;
  tenantId: string;
  username: string;
  nickname: string | null;
  role: UserRoleName;
  tenantName: string;
  expiresAt: Date;
  isActive: boolean;
};

export type AuthFailure = {
  status: number;
  code: number;
  msg: string;
};

export type AccessResult = { ok: true; auth: RequestAuth } | ({ ok: false } & AuthFailure);

export interface AuthStore {
  findUserByUsername(username: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  touchLogin(id: string, at: Date): Promise<void>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  revoke(userId: string, tenantId: string, atMs: number): Promise<void>;
  latestRevokeAt(userId: string): Promise<number | null>;
}

export type AuthConfig = {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  user: {
    id: string;
    username: string;
    nickname: string | null;
    role: UserRoleName;
    tenantId: string;
    tenantName: string;
    expiresAt: string;
    readOnly: boolean;
  };
  account: {
    id: string;
    username: string;
    nickname: string | null;
    role: UserRoleName;
    uiPrefs: AuthUiPrefs | null;
    features: {
      aiImage: boolean;
      visibility: boolean;
    };
    tenant: {
      id: string;
      name: string;
      expiresAt: string;
      isActive: boolean;
      readOnly: boolean;
    };
  };
};
