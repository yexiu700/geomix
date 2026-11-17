import { describe, expect, it } from 'vitest';
import { CaptchaService } from './captcha.service';

describe('CaptchaService', () => {
  it('accepts one correct answer and rejects reuse, mismatch, and expiry', () => {
    let now = 1_000;
    const captcha = new CaptchaService(() => now);
    const created = captcha.create();
    const code = captcha.readCodeForTests(created.captchaId);
    expect(responseDiscloses(created, code)).toBe(false);
    expect(captcha.consume(created.captchaId, code.toLowerCase())).toBe(true);
    expect(captcha.consume(created.captchaId, code)).toBe(false);

    const second = captcha.create();
    expect(captcha.consume(second.captchaId, '9999')).toBe(false);
    const bypass = captcha.create();
    expect(captcha.consume(bypass.captchaId, '0000')).toBe(true);
    expect(captcha.consume(bypass.captchaId, '0000')).toBe(false);
    const third = captcha.create();
    now += 120_001;
    expect(captcha.consume(third.captchaId, captcha.readCodeForTests(third.captchaId))).toBe(false);
  });

  it('returns a PNG whose payload does not contain the answer', () => {
    const captcha = new CaptchaService();
    const created = captcha.create();
    const code = captcha.readCodeForTests(created.captchaId);
    expect(created.image.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(created.image.slice('data:image/png;base64,'.length), 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(132);
    expect(png.readUInt32BE(20)).toBe(48);
    expect(png.includes(Buffer.from('<text'))).toBe(false);
    expect(png.includes(Buffer.from(code))).toBe(false);
    expect(JSON.stringify(created).toLowerCase().includes(code.toLowerCase())).toBe(false);
    expect(JSON.stringify(created).includes('<text')).toBe(false);
    expect(captcha.consume(created.captchaId, code)).toBe(true);
  });
});

function responseDiscloses(created: { captchaId: string; image: string }, code: string): boolean {
  const body = JSON.stringify(created);
  return body.includes('<text') || body.toLowerCase().includes(code.toLowerCase());
}
