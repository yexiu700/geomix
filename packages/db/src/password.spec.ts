import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hash', () => {
  it('round-trips a password and rejects the wrong one', () => {
    const encoded = hashPassword('geomix-admin-dev');
    expect(encoded.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(verifyPassword('geomix-admin-dev', encoded)).toBe(true);
    expect(verifyPassword('geomix-admin-dev ', encoded)).toBe(false);
  });

  it('uses the supplied salt so the same password can be reproduced', () => {
    const salt = 'ab'.repeat(16);
    expect(hashPassword('geomix-demo-dev', salt)).toBe(hashPassword('geomix-demo-dev', salt));
  });

  it('rejects malformed encodings instead of throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$16384$8$1$zz$abcd')).toBe(false);
    expect(verifyPassword('x', 'scrypt$99999999$8$1$aa$abcd')).toBe(false);
  });

  it('refuses an empty password', () => {
    expect(() => hashPassword('')).toThrow(/empty/);
  });
});
