import { describe, expect, it } from 'vitest';
import { AuthRateLimiter } from './rate-limiter';

describe('AuthRateLimiter', () => {
  it('isolates buckets, resets, and allows a login again after the window', () => {
    let now = 1_000_000;
    const rates = new AuthRateLimiter({
      now: () => now,
      captchaMax: 2,
      captchaWindowMs: 60_000,
      loginFailMax: 2,
      loginFailWindowMs: 60_000,
      maxKeys: 2,
    });
    const other = new AuthRateLimiter({
      now: () => now,
      captchaMax: 2,
      captchaWindowMs: 60_000,
      loginFailMax: 2,
      loginFailWindowMs: 60_000,
    });

    expect(rates.takeCaptcha('10.0.0.1').allowed).toBe(true);
    expect(rates.takeCaptcha('10.0.0.1').allowed).toBe(true);
    const blockedCaptcha = rates.takeCaptcha('10.0.0.1');
    expect(blockedCaptcha.allowed).toBe(false);
    if (!blockedCaptcha.allowed) expect(blockedCaptcha.retryAfterSeconds).toBeGreaterThan(0);
    expect(other.takeCaptcha('10.0.0.1').allowed).toBe(true);

    rates.recordLoginFailure('10.0.0.1', 'Demo');
    rates.recordLoginFailure('10.0.0.1', 'demo');
    expect(rates.loginStatus('10.0.0.1', 'DEMO').allowed).toBe(false);
    expect(rates.loginStatus('10.0.0.8', 'demo').allowed).toBe(true);
    rates.recordLoginFailure('10.0.0.8', 'demo');
    rates.recordLoginFailure('10.0.0.8', 'DEMO');
    expect(rates.loginStatus('10.0.0.8', 'demo').allowed).toBe(false);

    now += 60_001;
    expect(rates.loginStatus('10.0.0.1', 'demo').allowed).toBe(true);
    expect(rates.takeCaptcha('10.0.0.1').allowed).toBe(true);

    rates.recordLoginFailure('10.1.0.1', 'a');
    rates.recordLoginFailure('10.1.0.2', 'b');
    rates.recordLoginFailure('10.1.0.3', 'c');
    expect(rates.size()).toBeLessThanOrEqual(2);
    rates.reset();
    expect(rates.size()).toBe(0);
    expect(rates.loginStatus('10.0.0.8', 'demo').allowed).toBe(true);
  });
});
