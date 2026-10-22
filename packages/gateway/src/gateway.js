// The gateway core shared by the Express middleware and the reverse proxy:
// /.fuse/* endpoints, the protected-path pipeline (spec gate → session →
// Authorization: Fuse → 401 challenge), reputation, bans and revocations.
import {
  NETWORK,
  formatChallengeHeader,
  normalizeOrigin,
  parseFuseHeader,
  pseudonymFor,
  shortPseudonym,
  toField,
  toHex,
  verifyFuseToken,
} from '@fuse/core';
import { loadVerificationKey } from '@fuse/core/node';
import { createChallenges } from './challenge.js';
import { EventHub } from './events.js';
import {
  HttpError,
  MAX_BODY_BYTES,
  corsHeaders,
  cspNonce,
  hasBody,
  parseBody,
  rawQuery,
  readBody,
  sendHtml,
  sendJson,
  sendPreflight,
  wantsHtml,
} from './http.js';
import { adminPage, describeReason, interstitialPage, noticePage } from './pages.js';
import { compileProtect } from './paths.js';
import { DEFAULT_LIMITS, RateLimiter } from './ratelimit.js';
import { checkRequest } from './spec.js';
import { SESSION_TTL_SECONDS, SessionStore, cookieNameFor, readCookie, sessionCookie } from './sessions.js';
import { PROBATION_SECONDS, ReputationStore } from './store.js';
import { RootCache, followRevocations, submitToLog } from './upstreams.js';

export const DEFAULT_INSTALL_URL = 'http://localhost:4700/install';
export const BURNED_REASON = 'credential burned: reused a slot';
const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function resolveConfig(options) {
  const {
    siteName = 'Fuse site',
    origins,
    protect = [],
    registries,
    log,
    registryHint,
    secret,
    dataDir,
    cookieName,
    spec,
    reputation = {},
    admin = true,
    installUrl = DEFAULT_INSTALL_URL,
    sessionTtlSeconds = SESSION_TTL_SECONDS,
    revocationPollMs = 2000,
    rootsTtlMs = 2000,
  } = options;
  // The pseudonym is bound to the origin, so every origin a site answers on
  // is one more pseudonym per credential there. Sites name them explicitly;
  // nothing is derived from the client-controlled Host header.
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError('gateway needs origins: [url, …], the exact origins clients reach the site by');
  }
  if (!Array.isArray(registries) || registries.length === 0) throw new TypeError('gateway needs registries: [url, …]');
  if (typeof log !== 'string' || !log) throw new TypeError('gateway needs log: url');
  if (!Array.isArray(protect)) throw new TypeError('protect must be an array of path patterns');
  return {
    siteName,
    origins: [...new Set(origins.map((o) => normalizeOrigin(o)))],
    protect: [...protect],
    isProtected: compileProtect(protect),
    registries: registries.map(String),
    registryHint: registryHint ?? registries[0],
    log,
    secret,
    dataDir,
    cookieName,
    spec,
    admin: admin !== false,
    installUrl,
    sessionTtlSeconds,
    revocationPollMs,
    rootsTtlMs,
    probationSeconds: reputation.probationSeconds ?? PROBATION_SECONDS,
    limits: {
      probation: reputation.probationPerMinute ?? DEFAULT_LIMITS.probation,
      member: reputation.memberPerMinute ?? DEFAULT_LIMITS.member,
    },
  };
}

/**
 * Build a gateway. Most callers want fuseGateway() or startProxyGateway();
 * this is the shared core they wrap.
 *
 * @param {object} options see docs/protocol.md §8. `origins` is required: the
 *   exact origins clients use; challenges and proofs exist only for those.
 *   Also: installUrl, onEvent, sessionTtlSeconds, revocationPollMs and
 *   reputation: { probationSeconds, probationPerMinute, memberPerMinute }.
 */
export function createGateway(options = {}) {
  const config = resolveConfig(options);
  const vkey = loadVerificationKey();
  const challenges = createChallenges({ secret: config.secret });
  const store = new ReputationStore({ dataDir: config.dataDir, probationSeconds: config.probationSeconds });
  const sessions = new SessionStore({ ttlSeconds: config.sessionTtlSeconds });
  const limiter = new RateLimiter();
  const roots = new RootCache({ registries: config.registries, ttlMs: config.rootsTtlMs });
  const counters = {
    challengesIssued: 0,
    proofsAccepted: 0,
    proofsRejected: 0,
    specRejected: 0,
    bannedRequests: 0,
    rateLimited: 0,
    requests: 0,
    revocationsApplied: 0,
  };
  const events = new EventHub({ snapshot: () => info(), onEvent: options.onEvent });

  function stats() {
    return { ...counters, ...store.counts(), sessions: sessions.size };
  }

  function info() {
    return {
      siteName: config.siteName,
      network: NETWORK,
      origins: config.origins,
      protect: config.protect,
      registries: config.registries,
      registry: config.registryHint,
      log: config.log,
      spec: Boolean(config.spec),
      stats: stats(),
    };
  }

  // ---------------------------------------------------------------- origins & cookies

  const originUrls = config.origins.map((origin) => new URL(origin));

  /** Does a Host header name this origin's host (default ports normalized)? */
  function hostMatches(origin, hostHeader) {
    if (typeof hostHeader !== 'string' || !HOST_HEADER.test(hostHeader)) return false;
    const url = new URL(origin);
    try {
      return new URL(`${url.protocol}//${hostHeader}`).host === url.host;
    } catch {
      return false; // e.g. a port above 65535
    }
  }

  /** The configured origin a Host header addresses, or null. */
  function originForHost(hostHeader) {
    const i = originUrls.findIndex((url) => hostMatches(url.origin, hostHeader));
    return i < 0 ? null : config.origins[i];
  }

  function cookieName(req) {
    return config.cookieName ?? cookieNameFor(originForHost(req.headers.host) ?? config.origins[0]);
  }

  /**
   * Proofs and challenges exist only for configured origins. A request that
   * reached us under another Host name is sent to the canonical origin
   * (GET/HEAD) or refused with 421, so no Host value can mint a pseudonym.
   * @returns {boolean} true if the request was answered here
   */
  function redirectMisdirected(req, res) {
    if (originForHost(req.headers.host)) return false;
    const target = config.origins[0];
    if (req.method === 'GET' || req.method === 'HEAD') {
      const url = req.originalUrl ?? req.url ?? '/';
      const pathAndQuery = url.startsWith('/') ? url : (() => {
        const parsed = new URL(url, 'http://gateway.invalid');
        return parsed.pathname + parsed.search;
      })();
      corsHeaders(res);
      res.statusCode = 307;
      res.setHeader('Location', target + pathAndQuery);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } else {
      sendJson(res, 421, { error: 'misdirected-request', origin: target });
    }
    return true;
  }

  function setSessionCookie(req, res, session) {
    const secure = session.origin.startsWith('https:');
    res.appendHeader('Set-Cookie', sessionCookie(cookieName(req), session.id, { maxAgeSeconds: config.sessionTtlSeconds, secure }));
  }

  function clearSessionCookie(req, res) {
    res.appendHeader('Set-Cookie', sessionCookie(cookieName(req), '', { maxAgeSeconds: 0 }));
  }

  /**
   * Accept the client's claimed origin only if it is one of ours and names
   * the host it connected to. The proof is then checked against that origin,
   * so a token made for another site cannot verify.
   */
  function checkOrigin(claimed, req) {
    let origin;
    try {
      origin = normalizeOrigin(claimed);
    } catch {
      return { ok: false, reason: 'origin-invalid' };
    }
    if (!config.origins.includes(origin)) return { ok: false, reason: 'origin-not-allowed' };
    if (!hostMatches(origin, req.headers.host)) return { ok: false, reason: 'origin-mismatch' };
    return { ok: true, origin };
  }

  /** The request's live session, or the tombstone of one a ban ended. */
  function findSession(req) {
    const ids = readCookie(req.headers.cookie, cookieName(req));
    for (const id of ids) {
      const session = sessions.get(id);
      if (session && hostMatches(session.origin, req.headers.host)) return { session, cookie: true };
    }
    for (const id of ids) {
      const ended = sessions.tombstone(id);
      if (ended && store.isBanned(ended.pseudonym)) return { ended, cookie: true };
    }
    return { cookie: ids.length > 0 };
  }

  // ---------------------------------------------------------------- bans & revocations

  function ban(pseudonym, reason, by) {
    const changed = store.setBanned(pseudonym, true, reason);
    const sessionsEnded = sessions.endForPseudonym(pseudonym, reason);
    if (changed) events.emit('pseudonym-banned', { pseudonym, short: shortPseudonym(pseudonym), reason, by, sessionsEnded });
    return sessionsEnded;
  }

  function unban(pseudonym) {
    if (store.setBanned(pseudonym, false)) {
      events.emit('pseudonym-unbanned', { pseudonym, short: shortPseudonym(pseudonym) });
    }
  }

  /** Configured origins plus any accepted under an earlier configuration (revocations apply to all). */
  function allOrigins() {
    return [...new Set([...config.origins, ...store.origins])];
  }

  /**
   * A burned key is public, so compute its pseudonym at each of our origins,
   * ban it and end its sessions. Idempotent per (revocation, origin).
   */
  function applyRevocation(revocation) {
    if (!revocation || typeof revocation !== 'object') return;
    const { secret } = revocation;
    if (typeof secret !== 'string' && typeof secret !== 'bigint') return;
    const id = String(revocation.id ?? revocation.nullifier ?? secret);
    for (const origin of allOrigins()) {
      const key = `${id}|${origin}`;
      if (store.isRevocationApplied(key)) continue;
      let pseudonym;
      try {
        pseudonym = toHex(pseudonymFor(secret, origin));
      } catch {
        return; // not a field element: ignore the malformed record
      }
      const known = store.view(pseudonym).firstSeen !== null;
      const sessionsEnded = ban(pseudonym, BURNED_REASON, 'revocation');
      store.markRevocationApplied(key);
      counters.revocationsApplied += 1;
      events.emit('revocation-applied', {
        revocationId: id,
        pseudonym,
        short: shortPseudonym(pseudonym),
        origin,
        known,
        sessionsEnded,
        commitment: revocation.commitment,
      });
    }
  }

  const follower = followRevocations({
    logUrl: config.log,
    intervalMs: config.revocationPollMs,
    onRevocations: (list) => list.forEach(applyRevocation),
  });

  // ---------------------------------------------------------------- first contact

  /**
   * Check an `Authorization: Fuse` header and, if it holds, record the first
   * contact and open a session. Order follows docs/protocol.md §8 step 3.
   */
  async function redeem(req, auth, path) {
    const rejected = (status, reason, extra = {}) => {
      counters.proofsRejected += 1;
      events.emit('proof-rejected', { reason, method: req.method, path, ...extra });
      return { ok: false, status, reason, ...extra };
    };
    if (typeof auth.token !== 'string' || typeof auth.challenge !== 'string' || typeof auth.origin !== 'string') {
      return rejected(401, 'malformed-authorization');
    }
    const challenge = challenges.consume(auth.challenge);
    if (!challenge.ok) return rejected(401, challenge.reason);
    const claimed = checkOrigin(auth.origin, req);
    if (!claimed.ok) return rejected(401, claimed.reason);
    const origin = claimed.origin;

    const started = performance.now();
    const verified = await verifyFuseToken({ token: auth.token, challenge: auth.challenge, origin, vkey });
    const verifyMs = Math.round(performance.now() - started);
    if (!verified.ok) return rejected(401, verified.reason, { origin });

    const root = await roots.check(verified.signals.root);
    if (!root.ok) return rejected(root.reason === 'registry-unavailable' ? 503 : 401, root.reason, { origin });

    const pseudonym = toHex(verified.signals.pseudonym);
    const short = shortPseudonym(pseudonym);
    if (store.isBanned(pseudonym)) {
      counters.bannedRequests += 1;
      const reason = store.bannedReason(pseudonym);
      events.emit('banned-request', { pseudonym, short, reason, method: req.method, path });
      return { ok: false, status: 403, error: reason === BURNED_REASON ? 'credential-burned' : 'banned', reason };
    }

    const logged = await submitToLog(config.log, {
      token: auth.token,
      x: verified.signals.x,
      siteId: verified.signals.siteId,
    });
    if (logged.status === 'replay') return rejected(401, 'replay', { origin });
    if (logged.status === 'double-spend') {
      // The proof verified for this origin, so it is one of ours even if this
      // is its first proof; the burned key's pseudonym here is the one proven.
      store.addOrigin(origin);
      applyRevocation(logged.body?.revocation);
      if (!store.isBanned(pseudonym)) ban(pseudonym, BURNED_REASON, 'double-spend');
      const failure = rejected(403, 'double-spend', { origin, pseudonym, short });
      return { ...failure, error: 'credential-burned', reason: BURNED_REASON };
    }
    if (logged.status === 'invalid') return rejected(401, logged.reason, { origin });
    if (logged.status !== 'fresh') return rejected(503, 'log-unavailable', { origin });

    if (store.addOrigin(origin)) follower.pollNow().catch(() => {}); // revocations may apply to the new origin
    store.recordFirstContact(pseudonym);
    const session = sessions.create({ pseudonym, origin });
    const reputation = store.reputation(pseudonym);
    counters.proofsAccepted += 1;
    events.emit('proof-accepted', {
      pseudonym,
      short,
      reputation,
      origin,
      method: req.method,
      path,
      epoch: verified.epoch,
      nullifier: toHex(verified.signals.nullifier),
      seq: logged.body?.entry?.seq,
      verifyMs,
    });
    return { ok: true, pseudonym, short, reputation, session };
  }

  // ---------------------------------------------------------------- responses

  function issueChallenge(req, path, after) {
    const issued = challenges.issue();
    counters.challengesIssued += 1;
    events.emit('challenge-issued', { method: req.method, path, expiresAt: issued.expiresAt, ...(after ? { after } : {}) });
    return issued;
  }

  /** 401 with a fresh challenge: the interstitial for browsers, JSON for everyone else. */
  function sendChallenge(req, res, { path, reason, json = false, clearCookie = false }) {
    const { challenge, expiresAt } = issueChallenge(req, path, reason);
    res.setHeader('WWW-Authenticate', formatChallengeHeader({ challenge, registry: config.registryHint }));
    if (clearCookie) clearSessionCookie(req, res);
    if (!json && wantsHtml(req)) {
      const nonce = cspNonce();
      const url = `${originForHost(req.headers.host) ?? config.origins[0]}${req.originalUrl ?? req.url}`;
      const html = interstitialPage({
        siteName: config.siteName,
        challenge,
        registry: config.registryHint,
        installUrl: config.installUrl,
        url,
        method: req.method,
        reason,
        nonce,
      });
      return sendHtml(res, 401, html, { nonce, strictCsp: false });
    }
    const body = { error: 'fuse-required', challenge, network: NETWORK, registry: config.registryHint, expiresAt };
    if (reason) body.reason = reason;
    return sendJson(res, 401, body);
  }

  const NOTICES = {
    'request-not-in-spec': (b) => ({
      title: 'Request not accepted',
      message: `${config.siteName} only accepts requests that match its published spec, and this one did not (${b.reason}).`,
    }),
    banned: (b) => ({
      title: 'You are banned here',
      message: `${config.siteName} banned your pseudonym on this site${b.reason ? ` (${b.reason})` : ''}.`,
      detail: 'Your pseudonym comes from your credential, so a new session gets the same pseudonym and the ban holds. The site never learned who you are.',
    }),
    'credential-burned': () => ({
      title: 'Credential burned',
      message: 'This credential spent the same slot twice, which revealed its key. The registry burned it and every Fuse site ends its sessions.',
    }),
    'rate-limited': (b) => ({
      title: 'Slow down',
      message: `Your pseudonym is still on ${b.reputation} here and may make ${b.limit} requests a minute.`,
      detail: `Try again in ${b.retryAfter} s.`,
    }),
    'log-unavailable': () => ({
      title: 'Fuse network unavailable',
      message: 'The gateway could not reach the shared log to check your proof. Try again shortly.',
    }),
    'registry-unavailable': () => ({
      title: 'Fuse network unavailable',
      message: 'The gateway could not reach the registry to check your credential. Try again shortly.',
    }),
  };

  /** A refusal other than 401: JSON, or a short notice page for browsers. */
  function refuse(req, res, status, body, { json = false, headers = {} } = {}) {
    if (!json && wantsHtml(req) && NOTICES[body.error]) {
      const notice = NOTICES[body.error](body);
      return sendHtml(res, status, noticePage({ siteName: config.siteName, ...notice }), { headers });
    }
    return sendJson(res, status, body, headers);
  }

  function sendFailure(req, res, failure, { path, json = false }) {
    if (failure.status === 401) return sendChallenge(req, res, { path, reason: failure.reason, json });
    if (failure.status === 403) {
      return refuse(req, res, 403, { error: failure.error, reason: failure.reason }, { json });
    }
    return refuse(req, res, 503, { error: failure.reason }, { json, headers: { 'Retry-After': '5' } });
  }

  // ---------------------------------------------------------------- protected paths

  /** Let an authenticated request through, subject to its pseudonym's rate limit. */
  function admit(req, res, next, pseudonym, { firstContact, path }) {
    const short = shortPseudonym(pseudonym);
    const reputation = store.reputation(pseudonym);
    const limit = config.limits[reputation];
    const bucket = limiter.take(pseudonym, limit);
    if (!bucket.ok) {
      counters.rateLimited += 1;
      events.emit('rate-limited', { pseudonym, short, reputation, method: req.method, path });
      const body = { error: 'rate-limited', reputation, limit, retryAfter: bucket.retryAfterSeconds };
      return refuse(req, res, 429, body, { headers: { 'Retry-After': String(bucket.retryAfterSeconds) } });
    }
    if (!firstContact) store.recordRequest(pseudonym);
    counters.requests += 1;
    req.fuse = { pseudonym, short, reputation };
    res.setHeader('Fuse-Pseudonym', short);
    res.setHeader('Cache-Control', 'private, no-store');
    return next();
  }

  async function bodyForSpec(req) {
    const parsed = (buffer) => {
      const result = parseBody(req, buffer);
      return { ok: result.ok, bytes: buffer.length, value: result.ok ? result.value : undefined };
    };
    if (Buffer.isBuffer(req.rawBody)) return parsed(req.rawBody);
    if (req.body !== undefined) return { ok: true, bytes: Number(req.headers['content-length']) || 0, value: req.body };
    if (!hasBody(req)) return { ok: true, bytes: 0, value: undefined };
    const buffer = await readBody(req, MAX_BODY_BYTES);
    req.rawBody = buffer;
    const result = parsed(buffer);
    // The stream is consumed now; leave parsed JSON/form bodies where Express
    // body parsers would have put them (they skip finished requests).
    if (result.ok && result.value !== undefined && !Buffer.isBuffer(result.value)) req.body = result.value;
    return result;
  }

  async function guard(req, res, next, path) {
    if (redirectMisdirected(req, res)) return undefined;
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) return sendPreflight(res);

    // 1. Spec gate, before any proof work.
    if (config.spec) {
      const body = await bodyForSpec(req);
      const verdict = body.ok
        ? checkRequest(config.spec, {
            method: req.method,
            path,
            query: rawQuery(req),
            contentType: req.headers['content-type'],
            bodyBytes: body.bytes,
            body: body.value,
          })
        : { ok: false, reason: 'invalid-json' };
      if (!verdict.ok) {
        counters.specRejected += 1;
        events.emit('spec-rejected', { method: req.method, path, reason: verdict.reason, name: verdict.name });
        const answer = { error: 'request-not-in-spec', reason: verdict.reason };
        if (verdict.name !== undefined) answer.name = verdict.name;
        return refuse(req, res, 400, answer);
      }
    }

    // 2. Session cookie.
    const found = findSession(req);
    if (found.session) {
      const { pseudonym } = found.session;
      if (!store.isBanned(pseudonym)) return admit(req, res, next, pseudonym, { firstContact: false, path });
      sessions.endForPseudonym(pseudonym, store.bannedReason(pseudonym));
      found.ended = { pseudonym };
    }
    if (found.ended) {
      const { pseudonym } = found.ended;
      const reason = store.bannedReason(pseudonym);
      counters.bannedRequests += 1;
      events.emit('banned-request', { pseudonym, short: shortPseudonym(pseudonym), reason, method: req.method, path });
      clearSessionCookie(req, res);
      return refuse(req, res, 403, { error: reason === BURNED_REASON ? 'credential-burned' : 'banned', reason });
    }

    // 3. Authorization: Fuse.
    const auth = parseFuseHeader(req.headers.authorization);
    if (auth && (auth.token !== undefined || auth.challenge !== undefined)) {
      const result = await redeem(req, auth, path);
      if (!result.ok) return sendFailure(req, res, result, { path });
      setSessionCookie(req, res, result.session);
      return admit(req, res, next, result.pseudonym, { firstContact: true, path });
    }

    // 4. Ask for a proof.
    return sendChallenge(req, res, { path, clearCookie: found.cookie });
  }

  // ---------------------------------------------------------------- /.fuse/* endpoints

  async function readJson(req) {
    if (req.body !== undefined && !Buffer.isBuffer(req.body)) return req.body;
    const buffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : await readBody(req, 16 * 1024);
    try {
      return buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
    } catch {
      throw new HttpError(400, 'invalid-json');
    }
  }

  /** Full 0x-hex pseudonym, or a unique match for an anon-xxxxxxxx short form. */
  function resolvePseudonym(value) {
    if (typeof value !== 'string') return null;
    if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
      try {
        return toHex(toField(value));
      } catch {
        return null;
      }
    }
    if (/^anon-[0-9a-f]{8}$/.test(value)) {
      const matches = [...store.records.keys()].filter((p) => shortPseudonym(p) === value);
      return matches.length === 1 ? matches[0] : null;
    }
    return null;
  }

  async function fuseEndpoint(req, res, path) {
    if (req.method === 'OPTIONS') return sendPreflight(res);
    const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${path}`;

    if (key === 'GET /.fuse/info') return sendJson(res, 200, info());
    if (key === 'GET /.fuse/events') return events.attach(req, res);
    if ((key === 'GET /.fuse/challenge' || key === 'POST /.fuse/redeem') && redirectMisdirected(req, res)) return undefined;
    if (key === 'GET /.fuse/challenge') {
      const { challenge, expiresAt } = issueChallenge(req, path);
      return sendJson(res, 200, { challenge, network: NETWORK, registry: config.registryHint, expiresAt });
    }
    if (key === 'POST /.fuse/redeem') {
      const auth = parseFuseHeader(req.headers.authorization);
      if (!auth) return sendChallenge(req, res, { path, reason: 'missing-authorization', json: true });
      const result = await redeem(req, auth, path);
      if (!result.ok) return sendFailure(req, res, result, { path, json: true });
      setSessionCookie(req, res, result.session);
      res.setHeader('Fuse-Pseudonym', result.short);
      const { pseudonym, short, reputation } = result;
      return sendJson(res, 200, { ok: true, pseudonym, short, reputation });
    }
    if (key === 'GET /.fuse/session') {
      const { session } = findSession(req);
      if (!session || store.isBanned(session.pseudonym)) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        pseudonym: session.pseudonym,
        short: shortPseudonym(session.pseudonym),
        reputation: store.reputation(session.pseudonym),
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }
    if (key === 'POST /.fuse/logout') {
      for (const id of readCookie(req.headers.cookie, cookieName(req))) sessions.end(id);
      clearSessionCookie(req, res);
      if (wantsHtml(req)) {
        res.statusCode = 303;
        res.setHeader('Location', '/');
        return res.end();
      }
      return sendJson(res, 200, { ok: true });
    }

    if (config.admin) {
      if (key === 'GET /.fuse/admin') {
        const nonce = cspNonce();
        return sendHtml(res, 200, adminPage({ siteName: config.siteName, nonce }), { nonce });
      }
      if (key === 'GET /.fuse/admin/pseudonyms') return sendJson(res, 200, { pseudonyms: store.list() });
      if (key === 'POST /.fuse/admin/ban') {
        const body = await readJson(req);
        const pseudonym = resolvePseudonym(body?.pseudonym);
        if (!pseudonym) return sendJson(res, 400, { error: 'invalid-pseudonym' });
        if (typeof body.banned !== 'boolean') return sendJson(res, 400, { error: 'invalid-request', detail: 'banned must be a boolean' });
        if (body.banned) {
          const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'banned by a moderator';
          ban(pseudonym, reason, 'moderator');
        } else {
          unban(pseudonym);
        }
        return sendJson(res, 200, { ok: true, pseudonym: store.view(pseudonym) });
      }
    }
    return sendJson(res, 404, { error: 'not-found' });
  }

  // ---------------------------------------------------------------- entry point

  /**
   * Express-style handler: answers /.fuse/* and guards protected paths;
   * calls next() for everything else and for admitted requests (with req.fuse set).
   */
  async function handle(req, res, next) {
    try {
      // Only the gateway speaks for identity: drop client-supplied X-Fuse-* headers.
      for (const name of Object.keys(req.headers)) if (name.startsWith('x-fuse-')) delete req.headers[name];
      req.fuse = undefined;
      const path = req.path ?? new URL(req.url, 'http://gateway.invalid').pathname;
      if (path === '/.fuse' || path.startsWith('/.fuse/')) return await fuseEndpoint(req, res, path);
      if (!config.isProtected(path)) return next();
      return await guard(req, res, next, path);
    } catch (err) {
      if (res.headersSent) return res.destroy(err);
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      console.error('[fuse-gateway]', err);
      return sendJson(res, 500, { error: 'gateway-error' });
    }
  }

  function close() {
    follower.stop();
    events.close();
    store.flush();
  }

  return {
    config,
    store,
    sessions,
    events,
    counters,
    handle,
    close,
    info,
    stats,
    cookieName,
    originForHost,
    isProtected: config.isProtected,
    applyRevocation,
    pollRevocations: () => follower.pollNow(),
    describeReason,
  };
}
