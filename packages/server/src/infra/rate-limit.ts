/**
 * 基础设施 · TokenBucket（令牌桶限流）
 *
 * 用途：
 *  - Gateway 对 Login/Register 等操作按账号/IP 频控（KeyedTokenBuckets）。
 *  - main.ts 对 WebSocket 每连接消息频控（TokenBucket 直接使用）。
 *
 * 不依赖外部包；now 可由调用方注入（测试用假时钟）。
 */

/**
 * 单个令牌桶。
 * tryConsume() 返回 true=允许，false=超限。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    /** 最大令牌数（突发容量）。 */
    readonly capacity: number,
    /** 每秒补充令牌数。0=不补充（固定预算）。 */
    readonly refillRate: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  /** 尝试消费 n 个令牌。返回 true=通过，false=限流。 */
  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** 当前剩余令牌（测试/监控用）。 */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    if (this.refillRate <= 0) return;
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;
    }
  }
}

/**
 * 按字符串 key 管理多个令牌桶（自动 GC 过时桶）。
 * 用于 Login/Register 等操作的按账号名限流。
 */
export class KeyedTokenBuckets {
  private readonly buckets = new Map<string, { bucket: TokenBucket; usedAt: number }>();

  constructor(
    /** 每个桶的最大令牌数。 */
    private readonly capacity: number,
    /** 每秒补充令牌数。 */
    private readonly refillRate: number,
    private readonly now: () => number = Date.now,
    /** 桶在 ttlMs 内未被访问则 GC（默认 5 分钟）。 */
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  /** 对 key 尝试消费 n 个令牌。首次访问自动创建桶（从满容量开始）。 */
  tryConsume(key: string, n = 1): boolean {
    this.gc();
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacity, this.refillRate, this.now), usedAt: this.now() };
      this.buckets.set(key, entry);
    }
    entry.usedAt = this.now();
    return entry.bucket.tryConsume(n);
  }

  /** 当前活跃桶数（测试/监控用）。 */
  get size(): number {
    return this.buckets.size;
  }

  private gc(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.buckets) {
      if (entry.usedAt < cutoff) this.buckets.delete(key);
    }
  }
}
