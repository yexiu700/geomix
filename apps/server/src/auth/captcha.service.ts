import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CAPTCHA_TTL_MS } from '@geomix/shared';

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
    return { captchaId, image: svgDataUrl(renderCaptchaSvg(code)) };
  }

  /** 一次性消费。错误、过期、重复提交都返回 false。 */
  consume(captchaId: string, captchaCode: string): boolean {
    const entry = this.entries.get(captchaId);
    this.entries.delete(captchaId);
    if (!entry || entry.expiresAt <= this.now()) return false;
    const actual = Buffer.from(digest(captchaCode.trim().toLowerCase()));
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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderCaptchaSvg(code: string): string {
  const chars = [...code]
    .map((char, index) => {
      const x = 16 + index * 28;
      const y = index % 2 === 0 ? 30 : 36;
      const rotate = index % 2 === 0 ? -12 : 10;
      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-size="24" font-family="sans-serif" fill="#1f2937">${escapeXml(char)}</text>`;
    })
    .join('');
  const noise = [8, 18, 28, 38]
    .map(
      (y, index) =>
        `<line x1="0" y1="${y}" x2="132" y2="${y + (index % 2 === 0 ? 6 : -4)}" stroke="#94a3b8" stroke-width="1"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="48" viewBox="0 0 132 48"><rect width="132" height="48" fill="#f8fafc"/>${noise}${chars}</svg>`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
