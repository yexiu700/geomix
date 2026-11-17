export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type RateLimiterOptions = {
  now?: () => number;
  captchaMax?: number;
  captchaWindowMs?: number;
  loginFailMax?: number;
  loginFailWindowMs?: number;
  maxKeys?: number;
};

/**
 * 内存滑动窗口。键是已解析的客户端地址（默认取 TCP 对端，受信任反代下由 clientAddress 解析真实 IP），
 * 或「客户端地址 + 规范化用户名」。过期记录会删掉，键的数量有上限。
 */
export class AuthRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly captchaMax: number;
  private readonly captchaWindowMs: number;
  private readonly loginFailMax: number;
  private readonly loginFailWindowMs: number;
  private readonly maxKeys: number;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.captchaMax = options.captchaMax ?? 10;
    this.captchaWindowMs = options.captchaWindowMs ?? 600_000;
    this.loginFailMax = options.loginFailMax ?? 5;
    this.loginFailWindowMs = options.loginFailWindowMs ?? 900_000;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  takeCaptcha(ip: string): RateDecision {
    return this.take(`captcha\n${ip}`, this.captchaMax, this.captchaWindowMs);
  }

  loginStatus(ip: string, username: string): RateDecision {
    const stamps = this.prune(this.loginKey(ip, username), this.loginFailWindowMs);
    if (stamps.length < this.loginFailMax) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: retryAfter(stamps, this.loginFailWindowMs, this.now()),
    };
  }

  recordLoginFailure(ip: string, username: string): void {
    const key = this.loginKey(ip, username);
    const stamps = this.prune(key, this.loginFailWindowMs);
    if (stamps.length >= this.loginFailMax) return;
    stamps.push(this.now());
    this.store(key, stamps);
  }

  clearLoginFailures(ip: string, username: string): void {
    this.buckets.delete(this.loginKey(ip, username));
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  private loginKey(ip: string, username: string): string {
    return `login\n${ip}\n${username.trim().toLowerCase()}`;
  }

  private take(key: string, max: number, windowMs: number): RateDecision {
    const stamps = this.prune(key, windowMs);
    if (stamps.length >= max) {
      return { allowed: false, retryAfterSeconds: retryAfter(stamps, windowMs, this.now()) };
    }
    stamps.push(this.now());
    this.store(key, stamps);
    return { allowed: true };
  }

  private prune(key: string, windowMs: number): number[] {
    const now = this.now();
    const stamps = (this.buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length === 0) this.buckets.delete(key);
    else this.buckets.set(key, stamps);
    return stamps;
  }

  private store(key: string, stamps: number[]): void {
    this.buckets.delete(key);
    this.buckets.set(key, stamps);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

function retryAfter(stamps: number[], windowMs: number, now: number): number {
  const oldest = stamps[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}
