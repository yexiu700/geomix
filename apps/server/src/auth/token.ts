import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenKind = 'access' | 'refresh';

export type TokenClaims = {
  sub: string;
  tid: string;
  role: 'MERCHANT' | 'ADMIN';
  typ: TokenKind;
  fp: string;
  /** 签发时刻的毫秒时间，用来和撤销水位比较。 */
  lms: number;
  iat: number;
  exp: number;
};

export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(ttl.trim());
  if (!match) throw new Error(`Invalid JWT ttl "${ttl}"`);
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  const seconds = amount * factor;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 366 * 24 * 3600) {
    throw new Error(`Invalid JWT ttl "${ttl}"`);
  }
  return seconds;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(header: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
}

export function signToken(claims: TokenClaims, secret: string): string {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(claims);
  return `${header}.${body}.${sign(header, body, secret)}`;
}

export function readToken(token: string, secret: string, nowMs: number): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, bodyPart, signature] = parts;
  if (!headerPart || !bodyPart || !signature) return null;
  const expected = sign(headerPart, bodyPart, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf))
    return null;

  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
      alg?: unknown;
    };
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(
      Buffer.from(bodyPart, 'base64url').toString('utf8'),
    ) as Partial<TokenClaims>;
    if (payload.typ !== 'access' && payload.typ !== 'refresh') return null;
    if (payload.role !== 'MERCHANT' && payload.role !== 'ADMIN') return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    if (typeof payload.tid !== 'string' || payload.tid.length === 0) return null;
    if (typeof payload.fp !== 'string' || payload.fp.length === 0) return null;
    if (typeof payload.lms !== 'number' || !Number.isFinite(payload.lms)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    if (typeof payload.iat !== 'number') return null;
    return {
      sub: payload.sub,
      tid: payload.tid,
      role: payload.role,
      typ: payload.typ,
      fp: payload.fp,
      lms: payload.lms,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
