import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../src/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('enforces a limit and resets in the next window', () => {
    const limiter = new FixedWindowRateLimiter();
    expect(limiter.allow('device', 2, 1000, 0)).toBe(true);
    expect(limiter.allow('device', 2, 1000, 10)).toBe(true);
    expect(limiter.allow('device', 2, 1000, 20)).toBe(false);
    expect(limiter.allow('device', 2, 1000, 1000)).toBe(true);
  });

  it('can prune stale buckets without affecting fresh ones', () => {
    const limiter = new FixedWindowRateLimiter();
    limiter.allow('old', 1, 1000, 0);
    limiter.allow('fresh', 1, 1000, 9000);
    limiter.prune(10000, 5000);
    expect(limiter.allow('old', 1, 1000, 10000)).toBe(true);
    expect(limiter.allow('fresh', 1, 5000, 10000)).toBe(false);
  });
});
