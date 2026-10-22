// Reverse-proxy integration: put the gateway in front of any HTTP app. The
// upstream sees X-Fuse-Pseudonym / -Short / -Reputation on authenticated
// requests and never sees client-supplied X-Fuse-* headers, Fuse
// Authorization headers or any fuse_* session cookie (browsers share cookies
// across ports, so other sites' sessions may arrive too). Public GETs are
// cached briefly (X-Fuse-Cache: HIT|MISS), which is safe because public
// requests are forwarded without any identity.
import http from 'node:http';
import express from 'express';
import { createGateway } from './gateway.js';
import { HttpError, MAX_BODY_BYTES, rawPathAndQuery, readBody, sendJson } from './http.js';
import { stripCookies } from './sessions.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_CACHED_BODY = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;

/** Headers minus hop-by-hop ones (including any named in Connection). */
function endToEnd(headers) {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !named.includes(lower)) out[lower] = value;
  }
  return out;
}

/** Small TTL cache for public GET responses. */
class ResponseCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry;
    this.entries.delete(key);
    return undefined;
  }

  set(key, entry) {
    if (this.ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { ...entry, storedAt: Date.now(), expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > MAX_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }

  clear() {
    this.entries.clear();
  }
}

/** Shared-cache rules, simplified: only plain public 200s that no request header could have shaped. */
function isCacheable(req, upstream) {
  const cacheControl = String(upstream.headers['cache-control'] ?? '');
  return (
    req.method === 'GET' &&
    upstream.statusCode === 200 &&
    upstream.headers['set-cookie'] === undefined &&
    upstream.headers.vary === undefined &&
    !/\b(no-store|private|no-cache)\b/i.test(cacheControl)
  );
}

/**
 * Start a gateway in reverse-proxy mode.
 * @param {object} options gateway options (docs/protocol.md §8) plus:
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host] bind address (default FUSE_BIND or 127.0.0.1)
 * @param {string} options.upstream base URL of the app, e.g. http://127.0.0.1:4711
 * @param {string[] | ((port: number) => string[])} [options.origins] origins clients use;
 *   a function receives the bound port. Default [http://localhost:<port>].
 * @param {number} [options.cacheTtlSeconds] public GET cache lifetime (default 30, 0 disables)
 * @returns {Promise<{ url: string, port: number, gateway: object, close(): Promise<void> }>} url is origins[0]
 */
export async function startProxyGateway({
  port = 0,
  host = process.env.FUSE_BIND || '127.0.0.1',
  upstream,
  cacheTtlSeconds = 30,
  origins,
  ...options
}) {
  if (!upstream) throw new TypeError('startProxyGateway needs upstream: url');
  const target = new URL(upstream);
  if (target.protocol !== 'http:') throw new TypeError('upstream must be an http:// URL');
  const cache = new ResponseCache(cacheTtlSeconds * 1000);
  const agent = new http.Agent({ keepAlive: true });
  // Created once the port is bound, so the default origin can name it. No
  // request is handled before then: the listen callback runs first.
  let gateway;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Only origin-form targets ("/path?query"): the upstream host is fixed, never taken from the request.
  app.use((req, res, next) => {
    if (rawPathAndQuery(req) === null) return sendJson(res, 400, { error: 'bad-request-target' });
    next();
  });

  // Buffer bodies (≤ 1 MB) so the spec gate can inspect them and we can forward them.
  app.use(async (req, res, next) => {
    try {
      req.rawBody = await readBody(req, MAX_BODY_BYTES);
      next();
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      return sendJson(res, 400, { error: 'bad-request-body' });
    }
  });

  app.use((req, res, next) => gateway.handle(req, res, next));

  app.use((req, res) => {
    const path = req.path;
    // A request with its own (non-Fuse) credentials may get a personal answer: never cache those.
    const ownAuthorization = req.headers.authorization !== undefined && !/^\s*fuse\s/i.test(req.headers.authorization);
    const publicRequest = !gateway.isProtected(path) && (req.method === 'GET' || req.method === 'HEAD') && !ownAuthorization;
    const cacheKey = `${req.headers.host ?? ''} ${req.originalUrl}`;

    if (publicRequest) {
      const hit = cache.get(cacheKey);
      if (hit) {
        gateway.counters.cacheHits += 1;
        gateway.events.emit('cache', { status: 'HIT', method: req.method, path });
        for (const [name, value] of Object.entries(hit.headers)) res.setHeader(name, value);
        res.setHeader('Age', String(Math.floor((Date.now() - hit.storedAt) / 1000)));
        res.setHeader('X-Fuse-Cache', 'HIT');
        res.writeHead(hit.status);
        return res.end(req.method === 'HEAD' ? undefined : hit.body);
      }
      gateway.counters.cacheMisses += 1;
      gateway.events.emit('cache', { status: 'MISS', method: req.method, path });
    }

    const headers = endToEnd(req.headers);
    delete headers['content-length'];
    if (/^\s*fuse\s/i.test(headers.authorization ?? '')) delete headers.authorization;
    const cookie = stripCookies(headers.cookie, (name) => name.startsWith('fuse_') || name === gateway.config.cookieName);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    const remote = req.socket.remoteAddress ?? '';
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${remote}` : remote;
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    if (req.fuse) {
      headers['x-fuse-pseudonym'] = req.fuse.pseudonym;
      headers['x-fuse-pseudonym-short'] = req.fuse.short;
      headers['x-fuse-reputation'] = req.fuse.reputation;
    }
    const body = req.rawBody ?? Buffer.alloc(0);
    if (body.length > 0 || UNSAFE_METHODS.has(req.method)) headers['content-length'] = String(body.length);

    const upstreamReq = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.originalUrl,
      headers,
      agent,
    });

    upstreamReq.on('response', (upstreamRes) => {
      const responseHeaders = endToEnd(upstreamRes.headers);
      for (const [name, value] of Object.entries(responseHeaders)) {
        // Keep any session cookie the gateway just set alongside the app's own cookies.
        if (name === 'set-cookie') for (const c of value) res.appendHeader('Set-Cookie', c);
        else res.setHeader(name, value);
      }
      if (publicRequest) res.setHeader('X-Fuse-Cache', 'MISS');
      if (UNSAFE_METHODS.has(req.method) && upstreamRes.statusCode < 400) cache.clear(); // writes may change public pages
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage);

      if (publicRequest && isCacheable(req, upstreamRes)) {
        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_CACHED_BODY) chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          if (size <= MAX_CACHED_BODY) {
            cache.set(cacheKey, { status: upstreamRes.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) });
          }
        });
      }
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', () => {
      if (res.headersSent) return res.destroy();
      sendJson(res, 502, { error: 'upstream-unavailable' });
    });
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    upstreamReq.end(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const configured = typeof origins === 'function' ? origins(actualPort) : origins;
  try {
    gateway = createGateway({ ...options, origins: configured?.length ? configured : [`http://localhost:${actualPort}`] });
  } catch (err) {
    server.close();
    agent.destroy();
    throw err;
  }
  gateway.counters.cacheHits = 0;
  gateway.counters.cacheMisses = 0;

  return {
    url: gateway.config.origins[0],
    port: actualPort,
    gateway,
    async close() {
      gateway.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      agent.destroy();
    },
  };
}
