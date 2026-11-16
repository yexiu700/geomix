import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/**
 * 本地种子和后续登录共用的口令格式：
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * 参数写在字符串里，以后提高成本因子时旧口令仍能校验。
 */
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  if (password.length === 0) throw new Error('password must not be empty');
  if (password.length > 128) throw new Error('password must be at most 128 characters');
  const hash = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] ?? '';
  const expectedHex = parts[5] ?? '';
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  if (expectedHex.length === 0 || expectedHex.length % 2 !== 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expectedHex.length / 2, { N: n, r, p });
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}
