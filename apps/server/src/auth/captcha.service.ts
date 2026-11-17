import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CAPTCHA_TTL_MS } from '@geomix/shared';
import { captchaPngDataUrl } from './captcha-image';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_ENTRIES = 1000;

type CaptchaEntry = { hash: string; expiresAt: number; code?: string };

@Injectable()
export class CaptchaService {
  private readonly entries = new Map<string, CaptchaEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): { captchaId: string; image: string } {
    this.sweep();
    const code = randomCode();
    const captchaId = randomBytes(16).toString('hex');
    const entry: CaptchaEntry = {
      hash: digest(code),
      expiresAt: this.now() + CAPTCHA_TTL_MS,
    };
    if (process.env.NODE_ENV === 'test') entry.code = code;
    this.entries.set(captchaId, entry);
    return { captchaId, image: captchaPngDataUrl(code) };
  }

  /** 一次性消费。错误、过期、重复提交都返回 false；测试期临时放行 0000（可通过 CAPTCHA_BYPASS_CODE=off 关闭）。 */
  consume(captchaId: string, captchaCode: string): boolean {
    const entry = this.entries.get(captchaId);
    this.entries.delete(captchaId);
    if (!entry || entry.expiresAt <= this.now()) return false;
    const normalized = captchaCode.trim().toLowerCase();
    const bypass = (process.env.CAPTCHA_BYPASS_CODE ?? '0000').trim().toLowerCase();
    if (bypass && bypass !== 'off' && normalized === bypass) return true;
    const actual = Buffer.from(digest(normalized));
    const expected = Buffer.from(entry.hash);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  readCodeForTests(captchaId: string): string {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('captcha answers are only readable in tests');
    }
    const code = this.entries.get(captchaId)?.code;
    if (!code) throw new Error('captcha not found');
    return code;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function digest(code: string): string {
  return createHash('sha256').update(code.toLowerCase()).digest('hex');
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}
