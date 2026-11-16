import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function scryptBuffer(
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derived));
    });
  });
}

type ScryptParts = { n: number; r: number; p: number; salt: string; expectedHex: string };

function parseScrypt(encoded: string): ScryptParts | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] ?? '';
  const expectedHex = parts[5] ?? '';
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n < 2 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(expectedHex)) return null;
  if (expectedHex.length === 0 || expectedHex.length % 2 !== 0) return null;
  return { n, r, p, salt, expectedHex };
}

function hashesMatch(actual: Buffer, expectedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}

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
  const parsed = parseScrypt(encoded);
  if (!parsed) return false;
  try {
    const actual = scryptSync(password, parsed.salt, parsed.expectedHex.length / 2, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
    return hashesMatch(actual, parsed.expectedHex);
  } catch {
    return false;
  }
}

/** 登录校验走异步 scrypt，避免并发时堵住事件循环。格式和同步版本相同。 */
export async function verifyPasswordAsync(password: string, encoded: string): Promise<boolean> {
  const parsed = parseScrypt(encoded);
  if (!parsed) return false;
  try {
    const actual = await scryptBuffer(password, parsed.salt, parsed.expectedHex.length / 2, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
    return hashesMatch(actual, parsed.expectedHex);
  } catch {
    return false;
  }
}
