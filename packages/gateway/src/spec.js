// Spec gate: does a request match one of the routes the site declared?
//
// This is the prototype's stand-in for the machine-checked parser described in
// docs/design.md §8 (an EverParse-style parser with a proof that malformed
// input cannot crash or confuse it). Here it is a small hand-written function
// that must be total and side-effect free: for ANY spec and ANY request value
// it returns { ok: true, route, params } or { ok: false, reason, name? } and
// never throws. Randomized tests in test/spec.test.js hold it to that.
//
// Spec shape:
//   { routes: [{ method, path: '/v1/search' | '/t/:id', contentTypes?, maxBodyBytes?,
//                query?: { name: { pattern?, maxLength?, required? } },
//                fields?: { name: { type: 'string'|'number'|'boolean', maxLength?, pattern?, required? } },
//                allowUnknownQuery?, allowUnknownFields? }],
//     allowUnknownQuery?: false }
//
// Request shape (what the gateway passes):
//   { method, path, query: rawQueryString | { name: value }, contentType?, bodyBytes?, body? }
//
// Semantics worth knowing:
// - paths match segment by segment, case-sensitively; ":name" matches one non-empty segment;
// - a GET route also admits HEAD;
// - patterns are anchored (the whole value must match) and checked only after maxLength;
// - repeated or nested query parameters are rejected (parameter pollution);
// - without contentTypes or fields a route accepts no body unless maxBodyBytes says so.

const MAX_PATH_LENGTH = 2048;
const MAX_SEGMENT_LENGTH = 256;
const MAX_QUERY_LENGTH = 8192;
const MAX_QUERY_PARAMS = 64;
const MAX_FIELDS = 256;
const DEFAULT_QUERY_MAX_LENGTH = 1024;
const DEFAULT_FIELD_MAX_LENGTH = 65536;
const DEFAULT_BODY_LIMIT = 65536;
const FIELD_TYPES = new Set(['string', 'number', 'boolean']);

const reject = (reason, name) => (name === undefined ? { ok: false, reason } : { ok: false, reason, name });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Check a request against a spec. Total: never throws.
 * @param {object} spec
 * @param {object} request
 * @returns {{ ok: true, route: string, params: Record<string,string> } | { ok: false, reason: string, name?: string }}
 */
export function checkRequest(spec, request) {
  try {
    return check(spec, request);
  } catch {
    // Only reachable with exotic objects (throwing getters, proxies); plain
    // data is handled above without exceptions. Fail closed either way.
    return reject('gate-error');
  }
}

function check(spec, request) {
  const routes = own(spec, 'routes');
  if (!Array.isArray(routes)) return reject('invalid-spec');
  if (!isRecord(request)) return reject('malformed-request');

  const method = own(request, 'method');
  if (typeof method !== 'string' || !/^[A-Za-z]{1,16}$/.test(method)) return reject('malformed-method');
  const path = own(request, 'path');
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !path.startsWith('/')) {
    return reject('malformed-path');
  }
  const segments = path.split('/').slice(1);

  let firstFailure = null;
  let pathMatched = false;
  for (const route of routes) {
    if (!isRecord(route)) continue;
    const params = matchPath(own(route, 'path'), segments);
    if (!params) continue;
    pathMatched = true;
    if (!methodMatches(own(route, 'method'), method.toUpperCase())) continue;
    const verdict = checkRoute(spec, route, params, request, method.toUpperCase());
    if (verdict.ok) return verdict;
    firstFailure ??= verdict;
  }
  return firstFailure ?? reject(pathMatched ? 'method-not-allowed' : 'unknown-route');
}

function matchPath(pattern, segments) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) return null;
  const parts = pattern.split('/').slice(1);
  if (parts.length !== segments.length) return null;
  const params = Object.create(null); // no prototype: a ":__proto__" param is just a key
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const segment = segments[i];
    if (part.startsWith(':') && part.length > 1) {
      if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return null;
      params[part.slice(1)] = segment;
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}

function methodMatches(declared, method) {
  const list = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
  return list.some((m) => {
    if (typeof m !== 'string') return false;
    const want = m.toUpperCase();
    return want === method || (want === 'GET' && method === 'HEAD');
  });
}

function checkRoute(spec, route, params, request, method) {
  const routePath = own(route, 'path');

  // Query string.
  const query = readQuery(own(request, 'query'));
  if (!query.ok) return query;
  const declaredQuery = own(route, 'query');
  if (declaredQuery !== undefined && !isRecord(declaredQuery)) return reject('invalid-spec');
  const allowUnknownQuery = pickBoolean(own(route, 'allowUnknownQuery'), own(spec, 'allowUnknownQuery'));
  for (const [name, value] of query.entries) {
    const rule = own(declaredQuery, name);
    if (rule === undefined) {
      if (!allowUnknownQuery) return reject('unknown-query-param', name);
      continue;
    }
    const verdict = checkString(value, rule, DEFAULT_QUERY_MAX_LENGTH);
    if (verdict !== true) return reject(verdict === 'invalid-spec' ? verdict : 'bad-query-param', name);
  }
  if (declaredQuery) {
    for (const name of Object.keys(declaredQuery)) {
      if (own(own(declaredQuery, name), 'required') === true && !query.names.has(name)) {
        return reject('missing-query-param', name);
      }
    }
  }

  // Body size.
  const bodyBytes = own(request, 'bodyBytes') ?? 0;
  if (!isCount(bodyBytes)) return reject('malformed-body-size');
  const contentTypes = own(route, 'contentTypes');
  if (contentTypes !== undefined && !(Array.isArray(contentTypes) && contentTypes.every((t) => typeof t === 'string'))) {
    return reject('invalid-spec');
  }
  const fields = own(route, 'fields');
  if (fields !== undefined && !isRecord(fields)) return reject('invalid-spec');
  const declaredMax = own(route, 'maxBodyBytes');
  if (declaredMax !== undefined && !isCount(declaredMax)) return reject('invalid-spec');
  const maxBodyBytes = declaredMax ?? (contentTypes || fields ? DEFAULT_BODY_LIMIT : 0);
  if (bodyBytes > maxBodyBytes) return reject('body-too-large');

  // Content type (only meaningful when there is a body).
  if (bodyBytes > 0 && contentTypes) {
    const mediaType = readMediaType(own(request, 'contentType'));
    if (!mediaType || !contentTypes.some((t) => t.toLowerCase() === mediaType)) {
      return reject('unsupported-content-type');
    }
  }

  // Body fields.
  if (fields) {
    const body = bodyBytes === 0 ? undefined : own(request, 'body');
    const verdict = checkFields(fields, body ?? {}, own(route, 'allowUnknownFields') === true);
    if (verdict !== true) return verdict;
  }

  return { ok: true, route: routePath, method, params };
}

function pickBoolean(...values) {
  for (const v of values) if (typeof v === 'boolean') return v;
  return false;
}

/** Normalize a query into [name, value] pairs, rejecting repeats and nesting. */
function readQuery(query) {
  const entries = [];
  const names = new Set();
  const add = (name, value) => {
    if (typeof name !== 'string' || typeof value !== 'string') return reject('malformed-query');
    if (names.has(name)) return reject('duplicate-query-param', name);
    if (names.size >= MAX_QUERY_PARAMS) return reject('too-many-query-params');
    names.add(name);
    entries.push([name, value]);
    return null;
  };

  if (query === undefined || query === null || query === '') return { ok: true, entries, names };
  if (typeof query === 'string') {
    if (query.length > MAX_QUERY_LENGTH) return reject('query-too-long');
    for (const [name, value] of new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)) {
      const failure = add(name, value);
      if (failure) return failure;
    }
    return { ok: true, entries, names };
  }
  if (!isRecord(query)) return reject('malformed-query');
  const keys = Object.keys(query);
  if (keys.length > MAX_QUERY_PARAMS) return reject('too-many-query-params');
  for (const name of keys) {
    const value = own(query, name);
    if (Array.isArray(value)) return reject('duplicate-query-param', name);
    if (isRecord(value)) return reject('nested-query-param', name);
    const failure = add(name, value);
    if (failure) return failure;
  }
  return { ok: true, entries, names };
}

/** true if the value satisfies the rule, else a reason string. */
function checkString(value, rule, defaultMaxLength) {
  if (!isRecord(rule)) return 'invalid-spec';
  if (typeof value !== 'string') return 'type';
  const maxLength = own(rule, 'maxLength') ?? defaultMaxLength;
  if (!isCount(maxLength)) return 'invalid-spec';
  if (value.length > maxLength) return 'too-long';
  const pattern = own(rule, 'pattern');
  if (pattern !== undefined) {
    const regex = compilePattern(pattern);
    if (!regex) return 'invalid-spec';
    if (!regex.test(value)) return 'pattern';
  }
  return true;
}

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 512) return null;
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
}

function checkFields(fields, body, allowUnknown) {
  if (!isRecord(body) || ArrayBuffer.isView(body)) return reject('body-not-object');
  const keys = Object.keys(body);
  if (keys.length > MAX_FIELDS) return reject('too-many-fields');
  for (const name of keys) {
    if (own(fields, name) === undefined && !allowUnknown) return reject('unknown-field', name);
  }
  for (const name of Object.keys(fields)) {
    const rule = own(fields, name);
    if (!isRecord(rule) || !FIELD_TYPES.has(own(rule, 'type'))) return reject('invalid-spec', name);
    const present = Object.prototype.hasOwnProperty.call(body, name);
    if (!present) {
      if (own(rule, 'required') === true) return reject('missing-field', name);
      continue;
    }
    const value = body[name];
    const type = own(rule, 'type');
    if (type === 'string') {
      const verdict = checkString(value, rule, DEFAULT_FIELD_MAX_LENGTH);
      if (verdict !== true) return reject(verdict === 'invalid-spec' ? verdict : 'bad-field', name);
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return reject('bad-field', name);
    } else if (typeof value !== 'boolean') {
      return reject('bad-field', name);
    }
  }
  return true;
}

function readMediaType(contentType) {
  if (typeof contentType !== 'string' || contentType.length > 256) return null;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType || null;
}
