// Small HTTP helpers shared by the middleware and the proxy. They work on
// plain node:http request/response objects (Express adds to those).
import { randomBytes } from 'node:crypto';

export const MAX_BODY_BYTES = 1024 * 1024;

/** Response headers browser-based clients may read cross-origin. */
const EXPOSED_HEADERS = 'WWW-Authenticate, Fuse-Pseudonym, Retry-After, X-Fuse-Cache';

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Does the request carry a body (per RFC 9112 framing)? */
export function hasBody(req) {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/**
 * Buffer a request body, refusing more than `limit` bytes (413).
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload-too-large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'payload-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => failed || resolve(Buffer.concat(chunks)));
    req.on('error', (err) => failed || reject(err));
  });
}

/** Media type of a Content-Type header, lower-cased, without parameters. */
export function mediaType(req) {
  const value = req.headers['content-type'];
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Parse a buffered body the way Express apps expect: JSON and form bodies
 * become objects; anything else stays a Buffer.
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
export function parseBody(req, buffer) {
  if (buffer.length === 0) return { ok: true, value: undefined };
  const type = mediaType(req);
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
    } catch {
      return { ok: false };
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const value = {};
    for (const [key, v] of new URLSearchParams(buffer.toString('utf8'))) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        Object.defineProperty(value, key, { value: v, enumerable: true, writable: true, configurable: true });
      } else {
        value[key] = [].concat(value[key], v);
      }
    }
    return { ok: true, value };
  }
  return { ok: true, value: buffer };
}

/** Does the client want HTML (a browser navigation) rather than JSON? */
export function wantsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && /\btext\/html\b/i.test(accept);
}

export function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
}

/** Answer a CORS preflight. */
export function sendPreflight(res) {
  corsHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '600');
  res.statusCode = 204;
  res.end();
}

export function sendJson(res, status, body, headers = {}) {
  corsHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

/** Per-response nonce for inline scripts allowed by the page's CSP. */
export function cspNonce() {
  return randomBytes(16).toString('base64');
}

/**
 * Send a gateway-generated page. `strictCsp: false` is for the interstitial,
 * where the browser extension may need to fetch, spawn workers or compile
 * WebAssembly in the page's context; a tight script/connect policy there
 * could break proving.
 */
export function sendHtml(res, status, html, { nonce, headers = {}, strictCsp = true } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const policy = strictCsp
    ? [
        "default-src 'self'",
        "style-src 'unsafe-inline'",
        nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
      ]
    : [];
  res.setHeader('Content-Security-Policy', [...policy, "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'"].join('; '));
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(html);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Path and query of the request as received; null for anything but origin-form ("/…"). */
export function rawPathAndQuery(req) {
  const url = req.originalUrl ?? req.url ?? '/';
  return url.startsWith('/') ? url : null;
}

/** Raw query string (without "?") of the request. */
export function rawQuery(req) {
  const url = req.originalUrl ?? req.url ?? '';
  const q = url.indexOf('?');
  return q < 0 ? '' : url.slice(q + 1);
}
