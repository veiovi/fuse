import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { describe, test } from 'node:test';
import { Script } from 'node:vm';
import { siteIdFor, toHex } from '@fuse/core';
import { createChallenges } from '../src/challenge.js';
import { EventHub, MAX_QUEUED_BYTES } from '../src/events.js';
import { fuseGateway } from '../src/index.js';
import { adminPage, interstitialPage, noticePage } from '../src/pages.js';
import { compileProtect } from '../src/paths.js';
import { RateLimiter } from '../src/ratelimit.js';
import { SessionStore, cookieNameFor, readCookie, sessionCookie, stripCookies } from '../src/sessions.js';
import { ReputationStore } from '../src/store.js';
import { eventually, listen } from './helpers/network.js';

describe('challenges', () => {
  test('format: base64url(JSON{v,n,exp}) "." base64url(HMAC)', () => {
    const { issue } = createChallenges({ secret: 'a'.repeat(32), now: () => 1_000_000 });
    const { challenge, expiresAt } = issue();
    const [payload, mac] = challenge.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(body.v, 1);
    assert.equal(typeof body.n, 'string');
    assert.equal(body.exp, 1000 + 120);
    assert.equal(Buffer.from(mac, 'base64url').length, 32);
    assert.equal(expiresAt, new Date(1_120_000).toISOString());
  });

  test('single use', () => {
    const challenges = createChallenges();
    const { challenge } = challenges.issue();
    assert.equal(challenges.consume(challenge).ok, true);
    assert.deepEqual(challenges.consume(challenge), { ok: false, reason: 'challenge-used' });
  });

  test('expires after 120 s', () => {
    let now = 5_000_000;
    const challenges = createChallenges({ now: () => now });
    const { challenge } = challenges.issue();
    now += 119_000;
    assert.equal(challenges.inspect(challenge).ok, true);
    now += 1_000;
    assert.deepEqual(challenges.consume(challenge), { ok: false, reason: 'challenge-expired' });
  });

  test('MAC binds the payload and the secret', () => {
    const ours = createChallenges();
    const theirs = createChallenges();
    const { challenge } = ours.issue();
    assert.equal(theirs.consume(challenge).reason, 'challenge-invalid');
    const [payload, mac] = challenge.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const extended = Buffer.from(JSON.stringify({ ...body, exp: body.exp + 3600 })).toString('base64url');
    assert.equal(ours.consume(`${extended}.${mac}`).reason, 'challenge-invalid');
    for (const junk of ['', '.', 'a.b.c', `${payload}.`, `${payload}.${mac}x`, 'x'.repeat(600), null, 42]) {
      assert.equal(ours.consume(junk).ok, false, String(junk));
    }
    assert.equal(ours.consume(challenge).ok, true);
  });

  test('used nonces are forgotten once their challenge has expired', () => {
    let now = 1_000_000;
    const challenges = createChallenges({ now: () => now });
    challenges.consume(challenges.issue().challenge);
    assert.equal(challenges.pendingNonces, 1);
    now += 121_000;
    challenges.consume(challenges.issue().challenge);
    assert.equal(challenges.pendingNonces, 1);
  });

  test('a shared secret lets several gateway processes accept each other\'s challenges', () => {
    const a = createChallenges({ secret: 'shared-secret-for-a-cluster' });
    const b = createChallenges({ secret: 'shared-secret-for-a-cluster' });
    assert.equal(b.consume(a.issue().challenge).ok, true);
  });
});

describe('cookies and sessions', () => {
  test('cookie name is fuse_<first 8 hex of siteId>, distinct per port', () => {
    const forum = cookieNameFor('http://localhost:4710');
    assert.equal(forum, `fuse_${toHex(siteIdFor('http://localhost:4710')).slice(2, 10)}`);
    assert.match(forum, /^fuse_[0-9a-f]{8}$/);
    assert.notEqual(forum, cookieNameFor('http://localhost:4720'));
  });

  test('session cookie attributes', () => {
    assert.equal(sessionCookie('fuse_x', 'abc', { maxAgeSeconds: 60 }), 'fuse_x=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    assert.match(sessionCookie('fuse_x', 'abc', { maxAgeSeconds: 60, secure: true }), /; Secure$/);
  });

  test('reading and stripping a cookie', () => {
    const header = 'theme=dark; fuse_ab=one; other=x=y; fuse_ab="two"';
    assert.deepEqual(readCookie(header, 'fuse_ab'), ['one', 'two']);
    assert.deepEqual(readCookie(undefined, 'fuse_ab'), []);
    const fuseCookies = (name) => name.startsWith('fuse_');
    assert.equal(stripCookies(header, fuseCookies), 'theme=dark; other=x=y');
    assert.equal(stripCookies('fuse_ab=1; fuse_cd=2', fuseCookies), null);
    assert.equal(stripCookies('a=1; b=2', (name) => name === 'b'), 'a=1');
  });

  test('sessions expire, end on ban with a tombstone, and end silently on logout', () => {
    let now = 0;
    const store = new SessionStore({ ttlSeconds: 10, now: () => now });
    const a = store.create({ pseudonym: '0xa', origin: 'http://s' });
    const b = store.create({ pseudonym: '0xa', origin: 'http://s' });
    const c = store.create({ pseudonym: '0xc', origin: 'http://s' });
    assert.equal(a.id.length, 43); // 32 bytes, base64url
    assert.equal(store.get(a.id).pseudonym, '0xa');
    assert.equal(store.endForPseudonym('0xa', 'spam'), 2);
    assert.equal(store.get(a.id), undefined);
    assert.equal(store.tombstone(b.id).reason, 'spam');
    assert.equal(store.end(c.id), true);
    assert.equal(store.tombstone(c.id), undefined);
    const d = store.create({ pseudonym: '0xd', origin: 'http://s' });
    now = 10_000;
    assert.equal(store.get(d.id), undefined);
    assert.equal(store.size, 0);
  });
});

describe('protected paths', () => {
  const isProtected = compileProtect(['/new', '/posts', '/me', '/v1/*']);
  test('exact paths and prefixes', () => {
    for (const path of ['/new', '/posts', '/me', '/v1', '/v1/', '/v1/search', '/v1/a/b']) assert.equal(isProtected(path), true, path);
    for (const path of ['/', '/news', '/t/1', '/v10/x', '/mex', '/.fuse/info']) assert.equal(isProtected(path), false, path);
  });
  test('variants an upstream router would treat as the same path are protected too', () => {
    for (const path of ['/NEW', '/new/', '//new', '/./new', '/t/../new', '/%6Eew', '/V1/Search', '/v1//x', '/%2e%2e/me']) {
      assert.equal(isProtected(path), true, path);
    }
  });
  test('bad patterns are refused', () => {
    assert.throws(() => compileProtect(['new']));
  });
});

describe('reputation store', () => {
  test('probation for 24 h, then member; counts first contacts and requests', () => {
    let now = Date.parse('2026-10-22T00:00:00Z');
    const store = new ReputationStore({ now: () => now });
    store.recordFirstContact('0x01');
    store.recordRequest('0x01');
    assert.equal(store.reputation('0x01'), 'probation');
    now += 24 * 3600 * 1000;
    assert.equal(store.reputation('0x01'), 'member');
    const view = store.view('0x01');
    assert.equal(view.firstContacts, 1);
    assert.equal(view.requests, 2);
    assert.equal(view.firstSeen, '2026-10-22T00:00:00.000Z');
    assert.equal(view.short, 'anon-00000001');
  });

  test('bans persist across restarts, with origins and applied revocations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuse-gateway-store-'));
    try {
      const store = new ReputationStore({ dataDir: dir });
      store.recordFirstContact('0x02');
      assert.equal(store.setBanned('0x02', true, 'spam'), true);
      assert.equal(store.setBanned('0x02', true, 'spam'), false);
      store.addOrigin('http://localhost:4710');
      store.markRevocationApplied('rev-1|http://localhost:4710');
      store.flush();
      assert.ok(JSON.parse(readFileSync(join(dir, 'reputation.json'), 'utf8')).pseudonyms['0x02'].banned);
      const reopened = new ReputationStore({ dataDir: dir });
      assert.equal(reopened.isBanned('0x02'), true);
      assert.equal(reopened.bannedReason('0x02'), 'spam');
      assert.deepEqual([...reopened.origins], ['http://localhost:4710']);
      assert.equal(reopened.isRevocationApplied('rev-1|http://localhost:4710'), true);
      reopened.setBanned('0x02', false);
      assert.equal(reopened.view('0x02').bannedReason, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rate limiter', () => {
  test('token bucket: burst up to the minute, then refill at the rate', () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now });
    for (let i = 0; i < 60; i++) assert.equal(limiter.take('p', 60).ok, true);
    const refused = limiter.take('p', 60);
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterSeconds, 1);
    now += 1000;
    assert.equal(limiter.take('p', 60).ok, true);
    assert.equal(limiter.take('p', 60).ok, false);
    assert.equal(limiter.take('q', 60).ok, true);
  });
});

describe('gateway pages', () => {
  const scripts = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const interstitial = interstitialPage({
    siteName: 'Acme <Forum>',
    challenge: 'abc.def',
    registry: 'http://localhost:4701',
    installUrl: 'http://localhost:4700/install',
    url: "http://localhost:4710/new?x='1'",
    method: 'GET',
    reason: 'challenge-expired',
    nonce: 'n0nce',
  });

  test('inline scripts parse', () => {
    for (const html of [interstitial, adminPage({ siteName: 'Acme', nonce: 'n0nce' })]) {
      const found = scripts(html);
      assert.equal(found.length, 1);
      assert.doesNotThrow(() => new Script(found[0]));
    }
    assert.equal(scripts(noticePage({ siteName: 'Acme', title: 't', message: 'm' })).length, 0);
  });

  test('the interstitial carries the challenge for the extension and escapes site data', () => {
    assert.match(interstitial, /<meta name="fuse-challenge" content="abc\.def">/);
    assert.match(interstitial, /<meta name="fuse-registry" content="http:\/\/localhost:4701">/);
    assert.match(interstitial, /Acme &lt;Forum&gt; asks for a Fuse pass/);
    assert.match(interstitial, /the challenge had expired/);
    assert.ok(!interstitial.includes("x='1'"), 'quotes in URLs are escaped');
  });
});

describe('gateway configuration', () => {
  test('origins are mandatory: nothing is derived from the Host header', () => {
    const base = { protect: ['/x'], registries: ['http://127.0.0.1:9'], log: 'http://127.0.0.1:9' };
    assert.throws(() => fuseGateway(base), TypeError);
    assert.throws(() => fuseGateway({ ...base, origins: [] }), TypeError);
    assert.throws(() => fuseGateway({ ...base, origins: ['ftp://nope'] }), TypeError);
    const ok = fuseGateway({ ...base, origins: ['http://Forum.localhost:4710/ignored-path', 'http://forum.localhost:4710'] });
    assert.deepEqual(ok.gateway.config.origins, ['http://forum.localhost:4710']);
    assert.equal(ok.gateway.originForHost('FORUM.localhost:4710'), 'http://forum.localhost:4710');
    assert.equal(ok.gateway.originForHost('127.0.0.1:4710'), null);
    assert.equal(ok.gateway.originForHost('forum.localhost:99999'), null);
    ok.close();
  });
});

describe('event stream limits', () => {
  test('request-supplied strings are capped at 256 characters', () => {
    const hub = new EventHub({ snapshot: () => ({}) });
    const event = hub.emit('cache', { path: '/' + 'a'.repeat(8000), status: 'MISS', count: 3 });
    assert.equal(event.path.length, 256);
    assert.equal(event.status, 'MISS');
    assert.equal(event.count, 3);
    hub.close();
  });

  test('a subscriber that stops reading is dropped once 1 MB is queued', async () => {
    const hub = new EventHub({ snapshot: () => ({}) });
    const server = await listen((req, res) => hub.attach(req, res));
    const stalled = net.connect(server.port, '127.0.0.1');
    const controller = new AbortController();
    try {
      stalled.write(`GET /.fuse/events HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
      stalled.pause(); // never reads
      const reader = (await fetch(`${server.url}/.fuse/events`, { signal: controller.signal })).body.getReader();
      const draining = (async () => {
        while (!(await reader.read()).done); // a healthy subscriber keeps up
      })().catch(() => {});
      await eventually(() => hub.clients.size === 2);
      const filler = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'x'.repeat(256)]));
      for (let sent = 0; hub.clients.size === 2 && sent < 64 * MAX_QUEUED_BYTES; ) {
        for (let i = 0; i < 50; i++) sent += JSON.stringify(hub.emit('cache', filler)).length;
        await new Promise((resolve) => setImmediate(resolve)); // let sockets flush
      }
      assert.equal(hub.clients.size, 1, 'the stalled subscriber was dropped, the healthy one kept');
      controller.abort();
      await draining;
    } finally {
      controller.abort();
      stalled.destroy();
      hub.close();
      await server.close();
    }
  });
});
