import { describe, expect, it } from 'vitest';
import { readToken, signToken, ttlToSeconds, type TokenClaims } from './token';

const claims: TokenClaims = {
  sub: 'user_1',
  tid: 'tenant_1',
  role: 'MERCHANT',
  typ: 'access',
  fp: 'abc',
  lms: 1_700_000_000_000,
  iat: 1_700_000_000,
  exp: 1_700_000_900,
};

describe('token', () => {
  it('parses the configured ttl units', () => {
    expect(ttlToSeconds('15m')).toBe(900);
    expect(ttlToSeconds('7d')).toBe(7 * 86400);
    expect(() => ttlToSeconds('15')).toThrow(/ttl/);
  });

  it('round-trips a token and rejects tampering, expiry, and alg changes', () => {
    const token = signToken(claims, 'secret');
    expect(readToken(token, 'secret', claims.lms)).toEqual(claims);
    expect(readToken(token, 'other', claims.lms)).toBeNull();
    expect(readToken(token, 'secret', claims.exp * 1000)).toBeNull();
    const [header, body, signature] = token.split('.');
    expect(readToken(`${header}.${body}.${signature}x`, 'secret', claims.lms)).toBeNull();
    const badHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    expect(readToken(`${badHeader}.${body}.${signature}`, 'secret', claims.lms)).toBeNull();
  });
});
