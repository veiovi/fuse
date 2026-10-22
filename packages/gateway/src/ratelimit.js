// Token buckets keyed by pseudonym. A bucket holds up to `perMinute` tokens
// and refills continuously at perMinute/60 tokens per second, so a client can
// burst up to its whole minute and then sustain the rate.

export const DEFAULT_LIMITS = { probation: 60, member: 600 };

export class RateLimiter {
  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.buckets = new Map();
  }

  /**
   * Take one token.
   * @param {string} key
   * @param {number} perMinute capacity and refill rate
   * @returns {{ ok: true, remaining: number } | { ok: false, retryAfterSeconds: number }}
   */
  take(key, perMinute) {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: perMinute, at: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) * perMinute) / 60000);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / perMinute)) };
    }
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  forget(key) {
    this.buckets.delete(key);
  }
}
