// Minimal cookie jar for the agent (a subset of RFC 6265), keyed by origin:
// scheme + host + port. That is deliberately stricter than browsers, which
// share a host's cookies across ports and schemes. A session cookie from one
// site must never reach another site, even one on the same host, or that
// site could replay it and learn the first site's pseudonym.
// Supported attributes: Path, Max-Age, Expires, Secure. Domain is ignored
// (cookies are origin-only).

/** Hosts where Secure cookies may travel over plain http (RFC 6761 loopback names). */
function isLoopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Default cookie path for a request path (RFC 6265 §5.1.4): everything up to,
 * not including, the right-most "/".
 */
function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * Parse one Set-Cookie value received from `url`. Returns null for values a
 * user agent must ignore. `expires` is epoch milliseconds, or null for a
 * session cookie.
 */
export function parseSetCookie(header, url, now = Date.now()) {
  const u = new URL(url);
  const [pair, ...attributes] = String(header).split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let path = defaultPath(u.pathname);
  let maxAge;
  let expires;
  let secure = false;
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const val = at < 0 ? '' : attribute.slice(at + 1).trim();
    if (key === 'path') path = val.startsWith('/') ? val : defaultPath(u.pathname);
    else if (key === 'secure') secure = true;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === 'expires' && !Number.isNaN(Date.parse(val))) expires = Date.parse(val);
  }
  // Max-Age wins over Expires; a non-positive Max-Age deletes the cookie.
  if (maxAge !== undefined) expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  return { origin: u.origin, name, value, path, secure, expires: expires ?? null, created: now };
}

/** Per-origin cookie store that can be serialised into the wallet. */
export class CookieJar {
  #cookies = new Map(); // `${origin}\n${path}\n${name}` → cookie

  /** @param {object[]} [cookies] output of a previous toJSON(); entries without an origin are dropped */
  constructor(cookies = []) {
    for (const cookie of cookies) {
      if (cookie?.origin && cookie.name) this.#cookies.set(keyOf(cookie), { secure: false, ...cookie });
    }
  }

  /** Number of stored cookies, expired ones included until the next read. */
  get size() {
    return this.#cookies.size;
  }

  /**
   * Store one Set-Cookie value received from `url`.
   * @returns {boolean} whether the jar changed
   */
  setCookie(url, header, now = Date.now()) {
    const cookie = parseSetCookie(header, url, now);
    if (!cookie) return false;
    const key = keyOf(cookie);
    if (cookie.expires !== null && cookie.expires <= now) return this.#cookies.delete(key);
    const previous = this.#cookies.get(key);
    if (previous) cookie.created = previous.created; // keeps header ordering stable
    this.#cookies.set(key, cookie);
    return true;
  }

  /**
   * Store every Set-Cookie header of a fetch Response received from `url`.
   * @returns {boolean} whether the jar changed
   */
  setFromResponse(url, response, now = Date.now()) {
    let changed = false;
    for (const header of response.headers.getSetCookie()) changed = this.setCookie(url, header, now) || changed;
    return changed;
  }

  /** Value for the Cookie request header when requesting `url` ('' if none apply). */
  cookieHeader(url, now = Date.now()) {
    const u = new URL(url);
    const secureContext = u.protocol === 'https:' || isLoopback(u.hostname);
    const matching = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== null && cookie.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (cookie.origin !== u.origin || !pathMatches(u.pathname, cookie.path)) continue;
      if (cookie.secure && !secureContext) continue;
      matching.push(cookie);
    }
    // RFC 6265 §5.4: longer paths first, then oldest first.
    matching.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Drop every cookie, or only those of one origin (any URL on it will do). */
  clear(origin) {
    if (origin === undefined) return this.#cookies.clear();
    const target = new URL(origin).origin;
    for (const [key, cookie] of this.#cookies) if (cookie.origin === target) this.#cookies.delete(key);
  }

  /** Plain array for persistence; session cookies included. */
  toJSON() {
    return [...this.#cookies.values()].map((c) => ({ ...c }));
  }
}

function keyOf(cookie) {
  return `${cookie.origin}\n${cookie.path}\n${cookie.name}`;
}
