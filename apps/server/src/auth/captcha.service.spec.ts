import { describe, expect, it } from 'vitest';
import { CaptchaService, renderCaptchaSvg } from './captcha.service';

describe('CaptchaService', () => {
  it('accepts one correct answer and rejects reuse, mismatch, and expiry', () => {
    let now = 1_000;
    const captcha = new CaptchaService(() => now);
    const created = captcha.create();
    expect(created.image.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const code = captcha.readCodeForTests(created.captchaId);
    expect(renderCaptchaSvg(code)).toContain(code[0]);
    expect(captcha.consume(created.captchaId, code.toLowerCase())).toBe(true);
    expect(captcha.consume(created.captchaId, code)).toBe(false);

    const second = captcha.create();
    expect(captcha.consume(second.captchaId, '0000')).toBe(false);
    const third = captcha.create();
    now += 120_001;
    expect(captcha.consume(third.captchaId, captcha.readCodeForTests(third.captchaId))).toBe(false);
  });
});
