import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkRequest } from '../src/spec.js';

const SPEC = {
  routes: [
    {
      method: 'GET',
      path: '/v1/search',
      query: { q: { required: true, maxLength: 20 }, limit: { pattern: '[0-9]{1,2}' } },
    },
    {
      method: 'POST',
      path: '/v1/summarize',
      contentTypes: ['application/json'],
      maxBodyBytes: 1000,
      fields: { text: { type: 'string', required: true, maxLength: 200 }, sentences: { type: 'number' }, loud: { type: 'boolean' } },
    },
    { method: 'GET', path: '/t/:id' },
  ],
};

const ok = (request) => checkRequest(SPEC, request);

describe('spec gate: declared routes', () => {
  test('accepts requests that match a route', () => {
    assert.deepEqual(ok({ method: 'GET', path: '/v1/search', query: 'q=hello&limit=5' }).ok, true);
    assert.equal(ok({ method: 'HEAD', path: '/v1/search', query: 'q=x' }).ok, true);
    const thread = ok({ method: 'GET', path: '/t/42', query: '' });
    assert.equal(thread.ok, true);
    assert.equal(thread.params.id, '42');
    const post = ok({
      method: 'POST',
      path: '/v1/summarize',
      contentType: 'application/json; charset=utf-8',
      bodyBytes: 40,
      body: { text: 'hello', sentences: 2, loud: false },
    });
    assert.equal(post.ok, true, JSON.stringify(post));
  });

  test('accepts an express-style parsed query object', () => {
    assert.equal(ok({ method: 'GET', path: '/v1/search', query: { q: 'hi' } }).ok, true);
    assert.equal(ok({ method: 'GET', path: '/v1/search', query: { q: ['a', 'b'] } }).reason, 'duplicate-query-param');
    assert.equal(ok({ method: 'GET', path: '/v1/search', query: { q: { nested: 'x' } } }).reason, 'nested-query-param');
  });

  const rejections = [
    [{ method: 'GET', path: '/v2/search', query: 'q=a' }, 'unknown-route'],
    [{ method: 'DELETE', path: '/v1/search', query: 'q=a' }, 'method-not-allowed'],
    [{ method: 'GET', path: '/v1/search/', query: 'q=a' }, 'unknown-route'],
    [{ method: 'GET', path: '/V1/search', query: 'q=a' }, 'unknown-route'],
    [{ method: 'GET', path: '/t/', query: '' }, 'unknown-route'],
    [{ method: 'GET', path: '/v1/search', query: '' }, 'missing-query-param'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a&q=b' }, 'duplicate-query-param'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a&debug=1' }, 'unknown-query-param'],
    [{ method: 'GET', path: '/v1/search', query: `q=${'x'.repeat(21)}` }, 'bad-query-param'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a&limit=100' }, 'bad-query-param'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a&limit=5;drop' }, 'bad-query-param'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a', bodyBytes: 3 }, 'body-too-large'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'text/plain', bodyBytes: 5, body: 'hello' }, 'unsupported-content-type'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 5000, body: {} }, 'body-too-large'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 2, body: {} }, 'missing-field'],
    [{ method: 'POST', path: '/v1/summarize', bodyBytes: 0 }, 'missing-field'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: [1, 2] }, 'body-not-object'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: { text: 5 } }, 'bad-field'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: { text: 'a', sentences: '2' } }, 'bad-field'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: { text: 'a', loud: 'yes' } }, 'bad-field'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: { text: 'a', admin: true } }, 'unknown-field'],
    [{ method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 9, body: JSON.parse('{"text":"a","__proto__":{"x":1}}') }, 'unknown-field'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a&constructor=1' }, 'unknown-query-param'],
    [{ method: 'GET\r\n', path: '/v1/search', query: 'q=a' }, 'malformed-method'],
    [{ method: 'GET', path: 'v1/search', query: 'q=a' }, 'malformed-path'],
    [{ method: 'GET', path: '/v1/search', query: 'q=a', bodyBytes: -1 }, 'malformed-body-size'],
    [{ method: 'GET', path: '/v1/search', query: 7 }, 'malformed-query'],
    [null, 'malformed-request'],
  ];
  for (const [request, reason] of rejections) {
    test(`rejects ${JSON.stringify(request)?.slice(0, 90)} → ${reason}`, () => {
      const verdict = ok(request);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, reason);
    });
  }

  test('allowUnknownQuery opts in to extra parameters', () => {
    const spec = { allowUnknownQuery: true, routes: [{ method: 'GET', path: '/a' }] };
    assert.equal(checkRequest(spec, { method: 'GET', path: '/a', query: 'utm=1' }).ok, true);
  });

  test('a broken spec fails closed', () => {
    assert.equal(checkRequest(undefined, { method: 'GET', path: '/' }).reason, 'invalid-spec');
    assert.equal(checkRequest({ routes: 'nope' }, { method: 'GET', path: '/' }).reason, 'invalid-spec');
    const badPattern = { routes: [{ method: 'GET', path: '/a', query: { q: { pattern: '(' } } }] };
    assert.equal(checkRequest(badPattern, { method: 'GET', path: '/a', query: 'q=x' }).reason, 'invalid-spec');
    const badType = { routes: [{ method: 'POST', path: '/a', fields: { f: { type: 'date' } } }] };
    assert.equal(checkRequest(badType, { method: 'POST', path: '/a', bodyBytes: 2, body: {} }).reason, 'invalid-spec');
  });
});

// ---------------------------------------------------------------------------
// Randomized junk: the gate must be total. Deterministic PRNG so failures replay.

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function junkFactory(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (n) => Math.floor(random() * n);
  const tricky = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'q', 'text', 'limit', 'id', ''];
  const strings = () =>
    pick([
      () => '',
      () => pick(tricky),
      () => '/v1/search',
      () => '/t/' + 'x'.repeat(int(300)),
      () => '/' + Array.from({ length: int(12) }, () => pick(['..', '.', '%2e', '', 'v1', 'search', '%00', '\u0000', '☃'])).join('/'),
      () => 'x'.repeat(int(5000)),
      () => String.fromCharCode(...Array.from({ length: int(40) }, () => int(0x10000))),
      () => '?q=' + 'a'.repeat(int(40)) + '&q=b',
      () => Array.from({ length: int(80) }, () => `${pick(tricky)}=${pick(['', '1', '%', '%zz', '[]', '&'])}`).join('&'),
      () => pick(['GET', 'get', 'POST', 'HEAD', 'DELETE', 'G E T', 'PROPFIND', 'GETGETGETGETGETGETGET']),
      () => pick(['application/json', 'APPLICATION/JSON; charset=utf-8', 'text/plain', ';;;', 'multipart/form-data; boundary=x']),
      () => '(' + 'a+'.repeat(int(10)) + ')',
    ])();
  const value = (depth = 0) => {
    const options = [
      () => undefined,
      () => null,
      () => random() < 0.5,
      () => int(2 ** 31) * (random() < 0.5 ? -1 : 1),
      () => pick([NaN, Infinity, -Infinity, -0, 0.5, Number.MAX_SAFE_INTEGER + 2, 1e308]),
      () => BigInt(int(1000)),
      () => Symbol('junk'),
      () => () => 'fn',
      strings,
      () => new Date(int(1e12)),
      () => /re/g,
      () => Buffer.from(strings()),
      () => new Uint8Array(int(10)),
    ];
    if (depth < 3) {
      options.push(
        () => Array.from({ length: int(6) }, () => value(depth + 1)),
        () => {
          // Own data properties, like JSON.parse makes (so "__proto__" is a key, not the prototype).
          const obj = random() < 0.2 ? Object.create(null) : {};
          for (let i = int(8); i > 0; i--) {
            const writable = random() < 0.9;
            Object.defineProperty(obj, pick([...tricky, strings()]), { value: value(depth + 1), enumerable: true, writable, configurable: true });
          }
          return obj;
        },
        () => new Map([[strings(), value(depth + 1)]]),
      );
    }
    return pick(options)();
  };
  // Half the requests keep a declared method and path, so the junk reaches the
  // query, size, content-type and field checks instead of stopping at routing.
  const declared = [['GET', '/v1/search'], ['POST', '/v1/summarize'], ['GET', '/t/7'], ['HEAD', '/v1/search']];
  const request = () => {
    if (random() < 0.1) return value();
    const [method, path] = random() < 0.5 ? pick(declared) : [random() < 0.7 ? strings() : value(), random() < 0.7 ? strings() : value()];
    return {
      method,
      path,
      query: random() < 0.6 ? strings() : value(),
      contentType: random() < 0.6 ? pick(['application/json', strings()]) : value(),
      bodyBytes: random() < 0.5 ? int(3000) : value(),
      body: random() < 0.3 ? { text: random() < 0.7 ? strings() : value(), sentences: value() } : value(),
    };
  };
  const spec = () =>
    random() < 0.5
      ? value()
      : { routes: Array.from({ length: int(5) }, () => (random() < 0.3 ? value() : { method: value(), path: random() < 0.5 ? strings() : value(), query: value(), fields: value(), contentTypes: value(), maxBodyBytes: value() })), allowUnknownQuery: value() };
  return { request, spec };
}

describe('spec gate: randomized junk', () => {
  test('never throws and never needs its safety net on 5,000 junk requests against a real spec', () => {
    const random = prng(0xf05e);
    const junk = junkFactory(random);
    const reasons = new Set();
    for (let i = 0; i < 5000; i++) {
      const request = junk.request();
      const verdict = checkRequest(SPEC, request);
      assert.equal(typeof verdict.ok, 'boolean');
      assert.notEqual(verdict.reason, 'gate-error', `request #${i} reached the catch-all`);
      reasons.add(verdict.ok ? 'ok' : verdict.reason);
    }
    // The junk must reach deep into the gate, not just bounce off routing.
    for (const deep of ['missing-query-param', 'bad-query-param', 'unknown-query-param', 'body-too-large', 'unsupported-content-type', 'missing-field', 'bad-field', 'malformed-body-size']) {
      assert.ok(reasons.has(deep), `never exercised ${deep}: ${[...reasons]}`);
    }
  });

  test('never throws on 5,000 junk specs paired with junk requests', () => {
    const random = prng(0xbeef);
    const junk = junkFactory(random);
    for (let i = 0; i < 5000; i++) {
      const verdict = checkRequest(junk.spec(), junk.request());
      assert.equal(typeof verdict.ok, 'boolean');
      assert.notEqual(verdict.reason, 'gate-error', `pair #${i} reached the catch-all`);
    }
  });

  test('mutations of valid requests are never accepted unless they still match the spec', () => {
    const random = prng(7);
    const valid = { method: 'POST', path: '/v1/summarize', contentType: 'application/json', bodyBytes: 40, body: { text: 'hello' } };
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const mutated = { ...valid, body: { ...valid.body } };
      const field = ['method', 'path', 'contentType', 'bodyBytes', 'body'][Math.floor(random() * 5)];
      if (field === 'body') mutated.body[['text', 'extra', 'sentences'][Math.floor(random() * 3)]] = [1, 'x', true, null][Math.floor(random() * 4)];
      else mutated[field] = [undefined, '', 'GET', '/v1/summarize/', 'text/html', 2000, -1, 41][Math.floor(random() * 8)];
      const verdict = checkRequest(SPEC, mutated);
      if (verdict.ok) {
        accepted += 1;
        // Only harmless mutations may pass: a still-valid text or a valid size.
        assert.equal(mutated.path, '/v1/summarize');
        assert.equal(typeof mutated.body.text, 'string');
        assert.deepEqual(Object.keys(mutated.body).filter((k) => !['text', 'sentences', 'loud'].includes(k)), []);
      }
    }
    assert.ok(accepted > 0);
  });

  test('exotic objects (throwing getters, proxies) are refused, not thrown', () => {
    const throwing = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    const getter = { method: 'GET', get path() { throw new Error('boom'); } };
    for (const request of [throwing, getter, { method: 'GET', path: '/v1/search', query: throwing }]) {
      const verdict = checkRequest(SPEC, request);
      assert.equal(verdict.ok, false);
    }
    assert.equal(checkRequest(throwing, { method: 'GET', path: '/' }).ok, false);
  });
});
