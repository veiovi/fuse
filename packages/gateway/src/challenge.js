// One-time challenges: base64url(JSON{v:1,n,exp}) + "." + base64url(HMAC-SHA256(secret, payload)).
// Stateless to issue (the MAC proves we made it), stateful only to enforce
// single use: a consumed nonce is remembered until its challenge expires.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_TTL_SECONDS = 120;
const CHALLENGE_VERSION = 1;
const MAX_CHALLENGE_LENGTH = 512;

/**
 * @param {object} [options]
 * @param {string|Buffer} [options.secret] HMAC key; random per process by default
 * @param {number} [options.ttlSeconds]
 * @param {() => number} [options.now] clock in ms (tests)
 */
export function createChallenges({ secret, ttlSeconds = CHALLENGE_TTL_SECONDS, now = Date.now } = {}) {
  const key = secret === undefined ? randomBytes(32) : Buffer.from(secret);
  if (key.length < 16) throw new TypeError('challenge secret must be at least 16 bytes');
  const used = new Map(); // nonce -> exp (unix seconds)
  let lastPurge = 0;

  const mac = (payload) => createHmac('sha256', key).update(payload).digest();

  function purge(nowSeconds) {
    if (nowSeconds === lastPurge) return;
    lastPurge = nowSeconds;
    for (const [nonce, exp] of used) if (exp <= nowSeconds) used.delete(nonce);
  }

  /** Mint a fresh challenge. */
  function issue() {
    const exp = Math.floor(now() / 1000) + ttlSeconds;
    const body = { v: CHALLENGE_VERSION, n: randomBytes(16).toString('base64url'), exp };
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    return {
      challenge: `${payload}.${mac(payload).toString('base64url')}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Check MAC, version and expiry without consuming. */
  function inspect(challenge) {
    if (typeof challenge !== 'string' || challenge.length > MAX_CHALLENGE_LENGTH) {
      return { ok: false, reason: 'challenge-invalid' };
    }
    const parts = challenge.split('.');
    if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) {
      return { ok: false, reason: 'challenge-invalid' };
    }
    const [payload, tag] = parts;
    const expected = mac(payload);
    const provided = Buffer.from(tag, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return { ok: false, reason: 'challenge-invalid' };
    }
    let body;
    try {
      body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'challenge-invalid' };
    }
    if (body?.v !== CHALLENGE_VERSION || typeof body.n !== 'string' || !Number.isSafeInteger(body.exp)) {
      return { ok: false, reason: 'challenge-invalid' };
    }
    const nowSeconds = Math.floor(now() / 1000);
    if (body.exp <= nowSeconds) return { ok: false, reason: 'challenge-expired' };
    return { ok: true, nonce: body.n, exp: body.exp, nowSeconds };
  }

  /**
   * Validate and burn a challenge in one synchronous step, so two concurrent
   * requests carrying the same challenge cannot both pass.
   * @returns {{ ok: true, nonce: string, exp: number } | { ok: false, reason: string }}
   */
  function consume(challenge) {
    const result = inspect(challenge);
    if (!result.ok) return result;
    purge(result.nowSeconds);
    if (used.has(result.nonce)) return { ok: false, reason: 'challenge-used' };
    used.set(result.nonce, result.exp);
    return { ok: true, nonce: result.nonce, exp: result.exp };
  }

  return { issue, inspect, consume, get pendingNonces() { return used.size; } };
}
