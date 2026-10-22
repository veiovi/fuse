// Sessions that take over after a first contact, and the cookie that carries
// them. Session ids are 32 random bytes; the server keeps
// { pseudonym, origin, expiresAt } in memory. Sessions ended by a ban leave a
// tombstone so the next request can say "banned" instead of asking the
// client to spend another slot only to be refused.
import { randomBytes } from 'node:crypto';
import { siteIdFor, toHex } from '@fuse/core';

export const SESSION_TTL_SECONDS = 86400;

/**
 * Default session cookie name for a site: fuse_<first 8 hex digits of siteId>.
 * Cookies are scoped to a host, not a port, so two gateways on one host need
 * different names.
 * @param {string} origin
 */
export function cookieNameFor(origin) {
  return `fuse_${toHex(siteIdFor(origin)).slice(2, 10)}`;
}

/** All values of cookie `name` in a Cookie header (a browser may send duplicates). */
export function readCookie(header, name) {
  if (typeof header !== 'string') return [];
  const values = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values.push(value);
  }
  return values;
}

/** The Cookie header without the cookies whose name matches `drop(name)` (null if nothing is left). */
export function stripCookies(header, drop) {
  if (typeof header !== 'string') return null;
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !drop(pair.slice(0, Math.max(0, pair.indexOf('='))).trim()));
  return kept.length ? kept.join('; ') : null;
}

/**
 * Set-Cookie value for a session (HttpOnly; SameSite=Lax; Path=/).
 * maxAgeSeconds 0 deletes the cookie.
 */
export function sessionCookie(name, value, { maxAgeSeconds, secure = false }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export class SessionStore {
  /** @param {{ ttlSeconds?: number, now?: () => number }} [options] */
  constructor({ ttlSeconds = SESSION_TTL_SECONDS, now = Date.now } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
    this.sessions = new Map(); // id -> { pseudonym, origin, createdAt, expiresAt }
    this.byPseudonym = new Map(); // pseudonym -> Set(id)
    this.tombstones = new Map(); // id -> { pseudonym, reason, expiresAt }
  }

  /** Start a session; returns { id, pseudonym, origin, createdAt, expiresAt } (times in ms). */
  create({ pseudonym, origin }) {
    this.#purge();
    const id = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const session = { id, pseudonym, origin, createdAt, expiresAt: createdAt + this.ttlMs };
    this.sessions.set(id, session);
    if (!this.byPseudonym.has(pseudonym)) this.byPseudonym.set(pseudonym, new Set());
    this.byPseudonym.get(pseudonym).add(id);
    return session;
  }

  /** Live session for an id, or undefined. */
  get(id) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.#remove(id);
      return undefined;
    }
    return session;
  }

  /** Why a dead session id ended, if it was ended rather than expired. */
  tombstone(id) {
    const stone = this.tombstones.get(id);
    if (stone && stone.expiresAt <= this.now()) {
      this.tombstones.delete(id);
      return undefined;
    }
    return stone;
  }

  /** End one session (logout: no tombstone). */
  end(id) {
    return this.#remove(id);
  }

  /** End every session of a pseudonym, leaving tombstones; returns how many ended. */
  endForPseudonym(pseudonym, reason) {
    const ids = [...(this.byPseudonym.get(pseudonym) ?? [])];
    let ended = 0;
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      this.#remove(id);
      this.tombstones.set(id, { pseudonym, reason, expiresAt: session.expiresAt });
      if (session.expiresAt > this.now()) ended += 1;
    }
    return ended;
  }

  get size() {
    this.#purge();
    return this.sessions.size;
  }

  #remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    const ids = this.byPseudonym.get(session.pseudonym);
    ids?.delete(id);
    if (ids?.size === 0) this.byPseudonym.delete(session.pseudonym);
    return true;
  }

  #purge() {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.#remove(id);
    for (const [id, stone] of this.tombstones) if (stone.expiresAt <= now) this.tombstones.delete(id);
  }
}
