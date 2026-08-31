export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.start >= windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  prune(now = Date.now(), maxAgeMs = 10 * 60_000): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start > maxAgeMs) this.buckets.delete(key);
    }
  }
}
