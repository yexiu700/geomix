import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  SecretBoxError,
  decryptJson,
  encryptJson,
  maskSecret,
  parseEncryptionKey,
} from './secret-box';

const HEX_KEY_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX_KEY_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const BASE64_KEY_PADDED = Buffer.from(HEX_KEY_A, 'hex').toString('base64'); // 44 chars
const BASE64_KEY_UNPADDED = BASE64_KEY_PADDED.replace(/=+$/, ''); // 43 chars
const BASE64URL_KEY = Buffer.from(HEX_KEY_B, 'hex').toString('base64url'); // 43 chars

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips JSON payloads with 64-char hex, padded base64, unpadded base64, and base64url keys', () => {
    const payload = {
      accessToken: 'shpat_secret_live_token_9a2f',
      nested: { blogId: 'gid://shopify/Blog/123', flags: [true, 42] },
    };

    for (const key of [HEX_KEY_A, BASE64_KEY_PADDED, BASE64_KEY_UNPADDED, BASE64URL_KEY]) {
      const env1 = encryptJson(payload, { key });
      const env2 = encryptJson(payload, { key });

      expect(env1.keyVersion).toBe(1);
      // Distinct random 12-byte IVs guarantee distinct ciphertexts
      expect(env1.iv).not.toBe(env2.iv);
      expect(env1.ciphertext).not.toBe(env2.ciphertext);
      expect(Buffer.from(env1.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(env1.tag, 'base64')).toHaveLength(16);

      expect(decryptJson(env1, { key })).toEqual(payload);
      expect(decryptJson(env2, { key })).toEqual(payload);
    }

    // Hex and base64 representations of the same 32-byte key interoperate seamlessly
    const encHex = encryptJson(payload, { key: HEX_KEY_A });
    expect(decryptJson(encHex, { key: BASE64_KEY_PADDED })).toEqual(payload);
    expect(decryptJson(encHex, { key: BASE64_KEY_UNPADDED })).toEqual(payload);
  });

  it('does not throw on SecretBox construction when env key is absent, and validates lazily on use', () => {
    const box = new SecretBox({ env: {} });
    expect(box.maskSecret('shpat_1234567890abcdef9a2f')).toBe('shpat_****9a2f');

    expect(() => box.encryptJson({ token: 'abc' })).toThrow(SecretBoxError);
    try {
      box.encryptJson({ token: 'abc' });
    } catch (err) {
      expect(err).toBeInstanceOf(SecretBoxError);
      expect((err as SecretBoxError).code).toBe('MISSING_KEY');
    }

    const configuredBox = new SecretBox({ env: { CREDENTIAL_ENCRYPTION_KEY: HEX_KEY_A } });
    const env = configuredBox.encryptJson({ username: 'wp', appPassword: 'pw' });
    expect(configuredBox.decryptJson(env)).toEqual({ username: 'wp', appPassword: 'pw' });
  });

  it('rejects missing or malformed encryption keys without leaking the raw key in error messages', () => {
    const badKeys = [
      '',
      '   ',
      '0123456789abcdef', // too short hex
      'z'.repeat(64), // non-hex 64 chars
      randomBytes(31).toString('base64'), // 31 bytes
      randomBytes(33).toString('base64'), // 33 bytes
      `${BASE64_KEY_UNPADDED.slice(0, 42)}B`, // non-canonical trailing bits
      'not!valid@base64#key$string',
    ];

    for (const bad of badKeys) {
      let caught: unknown;
      try {
        parseEncryptionKey(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretBoxError);
      const err = caught as SecretBoxError;
      expect(err.code).toBe(bad.trim() ? 'INVALID_KEY' : 'MISSING_KEY');
      if (bad.trim().length > 0) {
        expect(err.message).not.toContain(bad.trim());
      }
    }
  });

  it('rejects wrong keys, tampered ciphertext/iv/tag, and malformed envelopes without leaking plaintext', () => {
    const secretPayload = { apiToken: 'super_secret_plaintext_value_999' };
    const envelope = encryptJson(secretPayload, { key: HEX_KEY_A });

    const assertFailsSafely = (
      fn: () => unknown,
      expectedCode: 'DECRYPT_FAILED' | 'INVALID_ENVELOPE',
    ) => {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretBoxError);
      const err = caught as SecretBoxError;
      expect(err.code).toBe(expectedCode);
      expect(err.message).not.toContain('super_secret_plaintext_value_999');
      expect(err.message).not.toContain(HEX_KEY_A);
      expect(err.message).not.toContain(HEX_KEY_B);
    };

    // Wrong key
    assertFailsSafely(() => decryptJson(envelope, { key: HEX_KEY_B }), 'DECRYPT_FAILED');

    // Tampered ciphertext byte
    const ctBuf = Buffer.from(envelope.ciphertext, 'base64');
    ctBuf[0] = (ctBuf[0] ?? 0) ^ 0xff;
    assertFailsSafely(
      () => decryptJson({ ...envelope, ciphertext: ctBuf.toString('base64') }, { key: HEX_KEY_A }),
      'DECRYPT_FAILED',
    );

    // Tampered IV byte
    const ivBuf = Buffer.from(envelope.iv, 'base64');
    ivBuf[0] = (ivBuf[0] ?? 0) ^ 0x01;
    assertFailsSafely(
      () => decryptJson({ ...envelope, iv: ivBuf.toString('base64') }, { key: HEX_KEY_A }),
      'DECRYPT_FAILED',
    );

    // Tampered auth tag byte
    const tagBuf = Buffer.from(envelope.tag, 'base64');
    tagBuf[0] = (tagBuf[0] ?? 0) ^ 0x80;
    assertFailsSafely(
      () => decryptJson({ ...envelope, tag: tagBuf.toString('base64') }, { key: HEX_KEY_A }),
      'DECRYPT_FAILED',
    );

    // Truncated tag & short IV
    assertFailsSafely(
      () =>
        decryptJson(
          { ...envelope, tag: tagBuf.subarray(0, 8).toString('base64') },
          { key: HEX_KEY_A },
        ),
      'INVALID_ENVELOPE',
    );
    assertFailsSafely(
      () =>
        decryptJson(
          { ...envelope, iv: ivBuf.subarray(0, 6).toString('base64') },
          { key: HEX_KEY_A },
        ),
      'INVALID_ENVELOPE',
    );
  });

  it('masks secrets safely across all length and prefix edge cases', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('   ')).toBe('');
    expect(maskSecret('a')).toBe('****');
    expect(maskSecret('1234')).toBe('****');
    expect(maskSecret('12345')).toBe('****45');
    expect(maskSecret('12345678')).toBe('****78');
    expect(maskSecret('123456789')).toBe('****6789');
    expect(maskSecret('abcdef1234567890')).toBe('abcd****7890');
    expect(maskSecret('shpat_1234567890abcdef9a2f')).toBe('shpat_****9a2f');
    expect(maskSecret('whsec_secret_value_9988')).toBe('whsec_****9988');

    for (const sample of ['a', '1234', '12345', '123456789', 'shpat_1234567890abcdef9a2f']) {
      const masked = maskSecret(sample);
      expect(masked).toContain('****');
      expect(masked).not.toBe(sample);
    }
  });
});
