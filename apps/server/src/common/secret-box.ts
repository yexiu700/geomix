import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';

const AES_GCM_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const SECRET_BOX_OPTIONS = Symbol('SECRET_BOX_OPTIONS');

export type SecretBoxErrorCode =
  'MISSING_KEY' | 'INVALID_KEY' | 'INVALID_ENVELOPE' | 'DECRYPT_FAILED';

export class SecretBoxError extends Error {
  constructor(
    readonly code: SecretBoxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

export type SecretBoxOptions = {
  key?: string;
  keyVersion?: number;
  env?: Record<string, string | undefined>;
};

function decodeStrictBase64(raw: string, expectedBytes?: number): Buffer | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (/[+/]/.test(raw) && /[-_]/.test(raw)) return null;
  const isStandard = /^[A-Za-z0-9+/]+={0,2}$/.test(raw);
  const isUrlSafe = !isStandard && /^[A-Za-z0-9_-]+={0,2}$/.test(raw);
  if (!isStandard && !isUrlSafe) return null;
  const normalized = isUrlSafe ? raw.replace(/-/g, '+').replace(/_/g, '/') : raw;
  const stripped = normalized.replace(/=+$/, '');
  const mod = stripped.length % 4;
  if (stripped.length === 0 || mod === 1) return null;
  const padLen = mod === 0 ? 0 : 4 - mod;
  const rawPad = raw.length - stripped.length;
  if (rawPad !== 0 && rawPad !== padLen) return null;
  const padded = `${stripped}${'='.repeat(padLen)}`;
  const buf = Buffer.from(padded, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== stripped) {
    return null;
  }
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    return null;
  }
  return buf;
}

/**
 * 延迟解析 32 字节 AES-256-GCM 密钥（支持 64 位 hex 或标准/URL-safe base64）。
 * 绝不在错误信息中回显任何密钥片段。
 */
export function parseEncryptionKey(raw?: string): Buffer {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    throw new SecretBoxError(
      'MISSING_KEY',
      'CREDENTIAL_ENCRYPTION_KEY 未配置，无法加密或解密渠道凭据（请配置 32 字节 hex 或 base64 密钥）',
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed) || /^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    const buf = decodeStrictBase64(trimmed, KEY_BYTES);
    if (buf) {
      return buf;
    }
  }

  throw new SecretBoxError(
    'INVALID_KEY',
    'CREDENTIAL_ENCRYPTION_KEY 格式无效，必须为 32 字节（64 位十六进制或 Base64 编码）',
  );
}

function resolveKey(options?: SecretBoxOptions): Buffer {
  const raw = options?.key ?? (options?.env ?? process.env).CREDENTIAL_ENCRYPTION_KEY;
  return parseEncryptionKey(raw);
}

export function encryptJson(payload: unknown, options?: SecretBoxOptions): EncryptedEnvelope {
  const key = resolveKey(options);
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new SecretBoxError('INVALID_ENVELOPE', '渠道凭据内容无法序列化为 JSON');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(serialized, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    keyVersion: options?.keyVersion ?? 1,
  };
}

export function decryptJson<T = unknown>(
  envelope: EncryptedEnvelope,
  options?: SecretBoxOptions,
): T {
  const key = resolveKey(options);

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string'
  ) {
    throw new SecretBoxError('INVALID_ENVELOPE', '渠道凭据密文结构无效');
  }

  const ivBuf = decodeStrictBase64(envelope.iv, IV_BYTES);
  const tagBuf = decodeStrictBase64(envelope.tag, AUTH_TAG_BYTES);
  const ctBuf = decodeStrictBase64(envelope.ciphertext);

  if (!ivBuf || !tagBuf || !ctBuf) {
    throw new SecretBoxError('INVALID_ENVELOPE', '渠道凭据密文格式损坏或长度不合法');
  }

  try {
    const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, ivBuf, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(tagBuf);
    const plaintext = Buffer.concat([decipher.update(ctBuf), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    throw new SecretBoxError('DECRYPT_FAILED', '渠道凭据解密失败：密钥不匹配或密文已被篡改');
  }
}

/**
 * 脱敏展示凭据（如 `shpat_****9a2f`），保证非空输入绝不回显完整明文。
 */
export function maskSecret(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '****';
  if (trimmed.length <= 8) return `****${trimmed.slice(-2)}`;

  const prefix = trimmed.match(/^([A-Za-z][A-Za-z0-9]{1,9}_)/)?.[1];
  if (prefix && trimmed.length - prefix.length >= 5) {
    return `${prefix}****${trimmed.slice(-4)}`;
  }

  if (trimmed.length >= 12) {
    return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
  }

  return `****${trimmed.slice(-4)}`;
}

@Injectable()
export class SecretBox {
  private readonly options?: SecretBoxOptions;

  constructor(@Optional() @Inject(SECRET_BOX_OPTIONS) options?: SecretBoxOptions) {
    // 故意不在构造函数中校验 CREDENTIAL_ENCRYPTION_KEY，避免本地仅写作/测试启动报错。
    this.options = options;
  }

  encryptJson(payload: unknown, override?: SecretBoxOptions): EncryptedEnvelope {
    return encryptJson(payload, override ?? this.options);
  }

  decryptJson<T = unknown>(envelope: EncryptedEnvelope, override?: SecretBoxOptions): T {
    return decryptJson<T>(envelope, override ?? this.options);
  }

  maskSecret(raw: string): string {
    return maskSecret(raw);
  }
}
