// Gateway end to end with real Groth16 proofs against an in-test registry and
// log. The same core flow runs in both integration styles: 401 → proof →
// session → reuse without a proof → bans stick → double-spend and
// revocations end sessions.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { pseudonymFor, shortPseudonym, toHex } from '@fuse/core';
import { releaseProver } from '@fuse/core/node';
import { cookieNameFor, fuseGateway, startProxyGateway } from '../src/index.js';
import { cookieFrom, eventually, listen, makeCast, prove, rawRequest, startStubNetwork } from './helpers/network.js';

after(releaseProver);

const json = { accept: 'application/json' };

/** Listen first, then build the app: a gateway needs its origin, which names the bound port. */
async function serve(build) {
  let app = null;
  const server = await listen((req, res) => app(req, res));
  app = build(server.url, server.port);
  return server;
}

async function challengeFor(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...json, ...init.headers } });
  assert.equal(res.status, 401, `expected a challenge from ${url}`);
  const body = await res.json();
  assert.equal(body.error, 'fuse-required');
  assert.match(res.headers.get('www-authenticate'), /^Fuse challenge="[\w-]+\.[\w-]+", network="fuse-demo-v1", registry="/);
  return body.challenge;
}

/** Answer a fresh challenge at `url` with a proof for `slot`. */
async function firstContact(member, { base, path, slot, init = {} }) {
  const challenge = await challengeFor(base + path, init);
  const auth = await prove(member, { origin: base, challenge, slot });
  const res = await fetch(base + path, { ...init, headers: { ...json, ...init.headers, authorization: auth.authorization } });
  return { res, auth };
}

/**
 * The flow both modes must support. `whoami(res)` extracts the pseudonym the
 * app saw (req.fuse in middleware mode, X-Fuse-Pseudonym upstream in proxy mode).
 */
function coreFlow(ctx) {
  let alice;
  let aliceCookie;

  test('a protected path answers 401 with a Fuse challenge', async () => {
    const res = await fetch(ctx.base + ctx.path, { headers: json });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['challenge', 'error', 'expiresAt', 'network', 'registry']);
    assert.equal(body.registry, ctx.net.registry.url);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('a valid proof is served in the same round trip and starts a session', async () => {
    alice = ctx.net.members.alice;
    const { res } = await firstContact(alice, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(res.status, 200);
    const expected = toHex(pseudonymFor(alice.secret, ctx.base));
    assert.equal(await ctx.whoami(res), expected);
    assert.equal(res.headers.get('fuse-pseudonym'), shortPseudonym(expected));
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(cookieNameFor(ctx.base) + '='));
    assert.ok(setCookie, 'session cookie named after the site');
    assert.match(setCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400$/);
    aliceCookie = `${cookieNameFor(ctx.base)}=${cookieFrom(res, cookieNameFor(ctx.base))}`;
    assert.equal(ctx.net.log.submissions.length, 1);
    assert.equal(ctx.events.some((e) => e.type === 'proof-accepted' && e.pseudonym === expected), true);
  });

  test('the session is reused without another proof', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(ctx.base + ctx.path, { headers: { ...json, cookie: aliceCookie } });
      assert.equal(res.status, 200);
      assert.equal(await ctx.whoami(res), toHex(pseudonymFor(alice.secret, ctx.base)));
    }
    assert.equal(ctx.net.log.submissions.length, 1, 'no new first contact');
    const session = await (await fetch(`${ctx.base}/.fuse/session`, { headers: { cookie: aliceCookie } })).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.reputation, 'probation');
    const listed = (await (await fetch(`${ctx.base}/.fuse/admin/pseudonyms`)).json()).pseudonyms;
    const record = listed.find((p) => p.pseudonym === session.pseudonym);
    assert.equal(record.firstContacts, 1);
    assert.equal(record.requests, 4);
  });

  test('a ban ends the session and sticks for a fresh proof from the same key', async () => {
    const pseudonym = toHex(pseudonymFor(alice.secret, ctx.base));
    const banned = await fetch(`${ctx.base}/.fuse/admin/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pseudonym, banned: true, reason: 'spam' }),
    });
    assert.equal(banned.status, 200);
    assert.equal((await banned.json()).pseudonym.banned, true);

    const withCookie = await fetch(ctx.base + ctx.path, { headers: { ...json, cookie: aliceCookie } });
    assert.equal(withCookie.status, 403);
    assert.deepEqual(await withCookie.json(), { error: 'banned', reason: 'spam' });

    // Drop the cookie and spend a new slot: same key, same pseudonym, same ban.
    const before = ctx.net.log.submissions.length;
    const { res } = await firstContact(alice, { base: ctx.base, path: ctx.path, slot: 1 });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'banned');
    assert.equal(ctx.net.log.submissions.length, before, 'a banned proof is not forwarded to the log');

    await fetch(`${ctx.base}/.fuse/admin/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pseudonym: shortPseudonym(pseudonym), banned: false }),
    });
    const again = await firstContact(alice, { base: ctx.base, path: ctx.path, slot: 2 });
    assert.equal(again.res.status, 200, 'unbanned');
  });

  test('reusing a slot burns the credential and ends its open session', async () => {
    const bob = ctx.net.members.bob;
    const first = await firstContact(bob, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(first.res.status, 200);
    const bobCookie = `${cookieNameFor(ctx.base)}=${cookieFrom(first.res, cookieNameFor(ctx.base))}`;

    const second = await firstContact(bob, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(second.res.status, 403);
    assert.equal((await second.res.json()).error, 'credential-burned');

    const ride = await fetch(ctx.base + ctx.path, { headers: { ...json, cookie: bobCookie } });
    assert.equal(ride.status, 403);
    assert.equal((await ride.json()).error, 'credential-burned');
    const applied = ctx.events.find((e) => e.type === 'revocation-applied' && e.pseudonym === toHex(pseudonymFor(bob.secret, ctx.base)));
    assert.equal(applied?.sessionsEnded, 1);
  });

  test("a revocation on the log ends the burned key's session here", async () => {
    const carol = ctx.net.members.carol;
    const { res } = await firstContact(carol, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(res.status, 200);
    const carolCookie = `${cookieNameFor(ctx.base)}=${cookieFrom(res, cookieNameFor(ctx.base))}`;

    ctx.net.log.publishRevocation(carol.secret); // carol double-spent somewhere else
    const pseudonym = toHex(pseudonymFor(carol.secret, ctx.base));
    await eventually(() => ctx.events.some((e) => e.type === 'revocation-applied' && e.pseudonym === pseudonym));

    const ride = await fetch(ctx.base + ctx.path, { headers: { ...json, cookie: carolCookie } });
    assert.equal(ride.status, 403);
    assert.equal((await ride.json()).error, 'credential-burned');
    const session = await (await fetch(`${ctx.base}/.fuse/session`, { headers: { cookie: carolCookie } })).json();
    assert.equal(session.authenticated, false);
    const record = (await (await fetch(`${ctx.base}/.fuse/admin/pseudonyms`)).json()).pseudonyms.find((p) => p.pseudonym === pseudonym);
    assert.equal(record.bannedReason, 'credential burned: reused a slot');
  });
}

// ---------------------------------------------------------------------------

describe('middleware mode', () => {
  const ctx = { path: '/v1/me', events: [] };
  let server;
  let gateway;

  before(async () => {
    ctx.net = await startStubNetwork(['alice', 'bob', 'carol', 'dave', 'erin', 'gina']);
    server = await serve((origin, port) => {
      gateway = fuseGateway({
        siteName: 'Test API',
        // A second origin for the same server shows that a proof must match the Host it arrives under.
        origins: [origin, `http://localhost:${port}`],
        protect: ['/v1/*'],
        registries: [ctx.net.registry.url],
        log: ctx.net.log.url,
        revocationPollMs: 50,
        secret: 'test-secret-shared-by-two-gateways',
        onEvent: (e) => ctx.events.push(e),
        spec: {
          routes: [
            { method: 'GET', path: '/v1/me' },
            { method: 'POST', path: '/v1/echo', contentTypes: ['application/json'], fields: { text: { type: 'string', required: true, maxLength: 50 } } },
          ],
        },
      });
      const app = express();
      app.get('/v1/status', (req, res) => res.json({ ok: true, fuse: req.fuse ?? null }));
      app.use(gateway);
      app.use(express.json());
      app.get('/v1/me', (req, res) => res.json({ fuse: req.fuse ?? null, spoofed: req.headers['x-fuse-pseudonym'] ?? null }));
      app.post('/v1/echo', (req, res) => res.json({ fuse: req.fuse, body: req.body }));
      app.get('/hello', (req, res) => res.json({ hello: true, fuse: req.fuse ?? null }));
      return app;
    });
    ctx.base = server.url;
    ctx.whoami = async (res) => (await res.json()).fuse.pseudonym;
  });

  after(async () => {
    gateway.close();
    await server.close();
    await ctx.net.close();
  });

  coreFlow(ctx);

  test('public routes pass untouched; client X-Fuse-* headers are dropped', async () => {
    const res = await fetch(`${ctx.base}/hello`, { headers: { 'x-fuse-pseudonym': '0xevil' } });
    assert.deepEqual(await res.json(), { hello: true, fuse: null });
    assert.equal((await fetch(`${ctx.base}/v1/status`)).status, 200);
  });

  test('JSON bodies survive the spec gate and reach the app', async () => {
    const dave = ctx.net.members.dave;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) };
    const { res } = await firstContact(dave, { base: ctx.base, path: '/v1/echo', slot: 0, init });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.body, { text: 'hi' });
    assert.equal(body.fuse.pseudonym, toHex(pseudonymFor(dave.secret, ctx.base)));
  });

  test('the spec gate refuses undeclared requests before any proof work', async () => {
    const before = { challenges: gateway.gateway.counters.challengesIssued, log: ctx.net.log.submissions.length };
    const cases = [
      [`${ctx.base}/v1/admin`, {}, 'unknown-route'],
      [`${ctx.base}/v1/me?debug=1`, {}, 'unknown-query-param'],
      [`${ctx.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text": 1}' }, 'bad-field'],
      [`${ctx.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }, 'invalid-json'],
      [`${ctx.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }, 'unsupported-content-type'],
    ];
    for (const [url, init, reason] of cases) {
      const res = await fetch(url, init);
      assert.equal(res.status, 400, url);
      assert.deepEqual(await res.json().then((b) => [b.error, b.reason]), ['request-not-in-spec', reason]);
    }
    assert.equal(gateway.gateway.counters.challengesIssued, before.challenges, 'no challenge issued');
    assert.equal(ctx.net.log.submissions.length, before.log);
  });

  test('a challenge is single use, and a token only works for the origin it was made for', async () => {
    const erin = ctx.net.members.erin;
    const challenge = await challengeFor(ctx.base + ctx.path);
    const auth = await prove(erin, { origin: ctx.base, challenge, slot: 0 });
    const first = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: auth.authorization } });
    assert.equal(first.status, 200);
    const again = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: auth.authorization } });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).reason, 'challenge-used');

    // Not one of our origins.
    const fresh = await challengeFor(ctx.base + ctx.path);
    const foreign = await prove(erin, { origin: 'http://127.0.0.1:1', challenge: fresh, slot: 1 });
    const res = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: foreign.authorization } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'origin-not-allowed');

    // One of ours, but not the Host this request arrived under.
    const fresh2 = await challengeFor(ctx.base + ctx.path);
    const sibling = await prove(erin, { origin: `http://localhost:${server.port}`, challenge: fresh2, slot: 3 });
    const res2 = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: sibling.authorization } });
    assert.equal(res2.status, 401);
    assert.equal((await res2.json()).reason, 'origin-mismatch');
  });

  test('a banned client cannot mint a fresh pseudonym through another Host name', async () => {
    const gina = ctx.net.members.gina;
    const port = server.port;
    const { res } = await firstContact(gina, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(res.status, 200);
    const pseudonym = toHex(pseudonymFor(gina.secret, ctx.base));
    await fetch(`${ctx.base}/.fuse/admin/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pseudonym, banned: true, reason: 'spam' }),
    });
    const logged = ctx.net.log.submissions.length;

    // An unconfigured Host never gets a challenge: reads go to the canonical origin, writes get 421.
    const host = `sock1.example:${port}`;
    const challenge = await rawRequest(`${ctx.base}/.fuse/challenge`, { headers: { host } });
    assert.equal(challenge.status, 307);
    assert.equal(challenge.headers.location, `${ctx.base}/.fuse/challenge`);
    const page = await rawRequest(`${ctx.base}/v1/me?x=1`, { headers: { host, ...json } });
    assert.equal(page.status, 307);
    assert.equal(page.headers.location, `${ctx.base}/v1/me?x=1`);
    assert.equal(page.headers['www-authenticate'], undefined);
    const write = await rawRequest(`${ctx.base}/v1/echo`, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(write.status, 421);
    assert.deepEqual(write.json, { error: 'misdirected-request', origin: ctx.base });
    const redeem = await rawRequest(`${ctx.base}/.fuse/redeem`, { method: 'POST', headers: { host } });
    assert.equal(redeem.status, 421);

    // A proof bound to that host name is never verified there, and is not ours anywhere else.
    const fresh = await challengeFor(ctx.base + ctx.path);
    const evasive = await prove(gina, { origin: `http://${host}`, challenge: fresh, slot: 1 });
    const viaOtherHost = await rawRequest(`${ctx.base}${ctx.path}`, { headers: { host, ...json, authorization: evasive.authorization } });
    assert.equal(viaOtherHost.status, 307);
    const viaCanonical = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: evasive.authorization } });
    assert.equal(viaCanonical.status, 401);
    assert.equal((await viaCanonical.json()).reason, 'origin-not-allowed');
    assert.equal(ctx.net.log.submissions.length, logged, 'nothing reached the log');

    // At the real origin the same key meets the same ban.
    const again = await firstContact(gina, { base: ctx.base, path: ctx.path, slot: 2 });
    assert.equal(again.res.status, 403);
    assert.equal((await again.res.json()).error, 'banned');
  });

  test('a replayed proof is refused by the log and earns a new challenge', async () => {
    // A second gateway sharing the challenge secret (as a cluster would) sees
    // the same token: its own nonce memory is empty, so only the log can tell.
    const twin = fuseGateway({
      siteName: 'Twin',
      origins: [ctx.base],
      protect: ['/v1/*'],
      registries: [ctx.net.registry.url],
      log: ctx.net.log.url,
      secret: 'test-secret-shared-by-two-gateways',
    });
    const app = express();
    app.use(twin);
    app.get('/v1/me', (req, res) => res.json({ fuse: req.fuse }));
    const twinServer = await listen(app);
    try {
      const challenge = await challengeFor(ctx.base + ctx.path);
      const auth = await prove(ctx.net.members.dave, { origin: ctx.base, challenge, slot: 1 });
      const first = await fetch(ctx.base + ctx.path, { headers: { ...json, authorization: auth.authorization } });
      assert.equal(first.status, 200);
      const replay = await rawRequest(`${twinServer.url}${ctx.path}`, {
        headers: { ...json, host: new URL(ctx.base).host, authorization: auth.authorization },
      });
      assert.equal(replay.status, 401);
      assert.equal(replay.json.reason, 'replay');
      assert.match(replay.headers['www-authenticate'], /^Fuse challenge=/);
    } finally {
      twin.close();
      await twinServer.close();
    }
  });

  test('a credential outside the accepted registries is refused (unknown root)', async () => {
    const stranger = makeCast(['mallory']).members.mallory; // valid proof, different tree
    const { res } = await firstContact(stranger, { base: ctx.base, path: ctx.path, slot: 0 });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, 'unknown-root');
    assert.ok(ctx.net.registry.rootsRequests >= 2, 'refetched roots once before refusing');
  });

  test('browsers get the interstitial with the challenge in meta tags', async () => {
    const res = await fetch(ctx.base + ctx.path, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    const challenge = html.match(/<meta name="fuse-challenge" content="([^"]+)">/)?.[1];
    assert.ok(challenge);
    assert.ok(res.headers.get('www-authenticate').includes(`challenge="${challenge}"`));
    assert.match(html, new RegExp(`<meta name="fuse-registry" content="${ctx.net.registry.url}">`));
    assert.match(html, /Install the Fuse extension/);
    assert.match(html, /href="http:\/\/localhost:4700\/install"/);
    assert.match(html, /npx fuse fetch/);
  });

  test('extension flow: /.fuse/challenge → /.fuse/redeem → session → logout', async () => {
    const info = await (await fetch(`${ctx.base}/.fuse/info`)).json();
    assert.equal(info.siteName, 'Test API');
    assert.deepEqual(info.protect, ['/v1/*']);
    assert.deepEqual(info.origins, [ctx.base, `http://localhost:${server.port}`]);

    const issued = await (await fetch(`${ctx.base}/.fuse/challenge`)).json();
    assert.equal(issued.network, 'fuse-demo-v1');
    assert.ok(Date.parse(issued.expiresAt) > Date.now());
    const auth = await prove(ctx.net.members.erin, { origin: ctx.base, challenge: issued.challenge, slot: 2 });
    const redeemed = await fetch(`${ctx.base}/.fuse/redeem`, { method: 'POST', headers: { authorization: auth.authorization } });
    assert.equal(redeemed.status, 200);
    const body = await redeemed.json();
    assert.equal(body.ok, true);
    assert.equal(body.pseudonym, toHex(pseudonymFor(ctx.net.members.erin.secret, ctx.base)));
    const cookie = `${cookieNameFor(ctx.base)}=${cookieFrom(redeemed, cookieNameFor(ctx.base))}`;
    assert.equal((await (await fetch(`${ctx.base}/.fuse/session`, { headers: { cookie } })).json()).short, body.short);

    const out = await fetch(`${ctx.base}/.fuse/logout`, { method: 'POST', headers: { cookie } });
    assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
    assert.equal((await (await fetch(`${ctx.base}/.fuse/session`, { headers: { cookie } })).json()).authenticated, false);
    assert.equal((await fetch(ctx.base + ctx.path, { headers: { ...json, cookie } })).status, 401);
  });

  test('the event stream opens with a hello snapshot', async () => {
    const controller = new AbortController();
    const res = await fetch(`${ctx.base}/.fuse/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    assert.match(text, /^event: hello\ndata: /);
    const hello = JSON.parse(text.split('\n')[1].slice('data: '.length));
    assert.equal(hello.type, 'hello');
    assert.equal(hello.siteName, 'Test API');
    assert.ok(Array.isArray(hello.recent));
  });

  test('the admin page is self-contained HTML', async () => {
    const res = await fetch(`${ctx.base}/.fuse/admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Test API · Fuse moderation<\/title>/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'nonce-/);
  });
});

describe('rate limits', () => {
  test('a pseudonym on probation is held to its per-minute budget', async () => {
    const net = await startStubNetwork(['fay']);
    let middleware;
    const server = await serve((origin) => {
      middleware = fuseGateway({
        origins: [origin],
        protect: ['/limited'],
        registries: [net.registry.url],
        log: net.log.url,
        reputation: { probationPerMinute: 3 },
      });
      const app = express();
      app.use(middleware);
      app.get('/limited', (req, res) => res.json({ ok: true }));
      return app;
    });
    try {
      const { res } = await firstContact(net.members.fay, { base: server.url, path: '/limited', slot: 0 });
      assert.equal(res.status, 200); // 1 of 3
      const cookie = `${cookieNameFor(server.url)}=${cookieFrom(res, cookieNameFor(server.url))}`;
      for (let i = 0; i < 2; i++) assert.equal((await fetch(`${server.url}/limited`, { headers: { cookie } })).status, 200);
      const limited = await fetch(`${server.url}/limited`, { headers: { cookie } });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '20');
      assert.deepEqual(await limited.json(), { error: 'rate-limited', reputation: 'probation', limit: 3, retryAfter: 20 });
    } finally {
      middleware.close();
      await server.close();
      await net.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('proxy mode', () => {
  const ctx = { path: '/me', events: [] };
  let upstream;
  let proxy;
  const seen = { home: 0, last: null };

  before(async () => {
    ctx.net = await startStubNetwork(['alice', 'bob', 'carol', 'dave']);
    const app = express();
    app.use((req, res, next) => {
      seen.last = { method: req.method, url: req.url, headers: { ...req.headers } };
      next();
    });
    app.get('/', (req, res) => {
      seen.home += 1;
      res.send(`<h1>home ${seen.home}</h1>`);
    });
    app.get('/private-page', (req, res) => res.set('cache-control', 'private').send('mine'));
    app.get('/varies', (req, res) => res.set('vary', 'Accept-Language').send(`hello in ${req.get('accept-language')}`));
    app.get('/me', (req, res) =>
      res.json({ pseudonym: req.get('x-fuse-pseudonym'), short: req.get('x-fuse-pseudonym-short'), reputation: req.get('x-fuse-reputation') }),
    );
    app.post('/posts', express.urlencoded({ extended: false }), (req, res) => {
      res.cookie('flash', 'posted');
      res.status(303).location('/').json({ author: req.get('x-fuse-pseudonym-short'), body: req.body });
    });
    upstream = await listen(app);
    proxy = await startProxyGateway({
      port: 0,
      upstream: upstream.url,
      origins: (port) => [`http://127.0.0.1:${port}`],
      siteName: 'Test Forum',
      protect: ['/me', '/posts'],
      registries: [ctx.net.registry.url],
      log: ctx.net.log.url,
      revocationPollMs: 50,
      onEvent: (e) => ctx.events.push(e),
    });
    ctx.base = proxy.url;
    ctx.whoami = async (res) => (await res.json()).pseudonym;
  });

  after(async () => {
    await proxy.close();
    await upstream.close();
    await ctx.net.close();
  });

  test('reports its first origin as its URL', () => {
    assert.equal(proxy.url, `http://127.0.0.1:${proxy.port}`);
  });

  test('without origins it serves http://localhost:<port> only; other Host names never get a challenge', async () => {
    const solo = await startProxyGateway({ port: 0, upstream: upstream.url, protect: ['/me'], registries: [ctx.net.registry.url], log: ctx.net.log.url });
    try {
      assert.equal(solo.url, `http://localhost:${solo.port}`);
      const viaIp = `http://127.0.0.1:${solo.port}`;
      const get = await fetch(`${viaIp}/me?tab=posts`, { redirect: 'manual', headers: json });
      assert.equal(get.status, 307);
      assert.equal(get.headers.get('location'), `${solo.url}/me?tab=posts`);
      assert.equal(get.headers.get('www-authenticate'), null);
      const post = await fetch(`${viaIp}/me`, { method: 'POST', headers: json });
      assert.equal(post.status, 421);
      assert.deepEqual(await post.json(), { error: 'misdirected-request', origin: solo.url });
      assert.equal((await fetch(`${viaIp}/.fuse/challenge`, { redirect: 'manual' })).status, 307);
      assert.equal((await fetch(`${viaIp}/.fuse/redeem`, { method: 'POST' })).status, 421);
      assert.equal(solo.gateway.counters.challengesIssued, 0);
      assert.equal((await fetch(`${viaIp}/`)).status, 200, 'public pages are not origin-gated');
      assert.equal((await fetch(`${viaIp}/.fuse/info`)).status, 200);
      assert.equal((await fetch(`${solo.url}/me`, { headers: json })).status, 401, 'the canonical origin is challenged');
    } finally {
      await solo.close();
    }
  });

  coreFlow(ctx);

  test('identity headers reach the upstream; Fuse credentials and spoofed headers do not', async () => {
    const dave = ctx.net.members.dave;
    const { res } = await firstContact(dave, {
      base: ctx.base,
      path: ctx.path,
      slot: 0,
      init: { headers: { cookie: 'theme=dark; fuse_0a1b2c3d=another-sites-session', 'x-fuse-pseudonym': '0xspoofed', 'x-fuse-reputation': 'member' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pseudonym, toHex(pseudonymFor(dave.secret, ctx.base)));
    assert.equal(body.reputation, 'probation');
    assert.equal(seen.last.headers.authorization, undefined);
    assert.equal(seen.last.headers.cookie, 'theme=dark', "no fuse_* cookie (ours or another site's) reaches the upstream");
    assert.equal(seen.last.headers['x-forwarded-host'], new URL(ctx.base).host);

    const cookie = `${cookieNameFor(ctx.base)}=${cookieFrom(res, cookieNameFor(ctx.base))}`;
    await fetch(ctx.base + '/', { headers: { cookie: `${cookie}; theme=dark`, 'x-fuse-pseudonym': '0xspoofed' } });
    assert.equal(seen.last.headers['x-fuse-pseudonym'], undefined, 'public requests carry no identity');
    assert.equal(seen.last.headers.cookie, 'theme=dark', 'session cookie stays at the gateway');
  });

  test('form posts are forwarded with the author pseudonym, and Set-Cookie from both sides survives', async () => {
    const dave = ctx.net.members.dave;
    const init = { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Hi&body=Hello+there' };
    const { res } = await firstContact(dave, { base: ctx.base, path: '/posts', slot: 1, init });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const body = await res.json();
    assert.equal(body.author, shortPseudonym(toHex(pseudonymFor(dave.secret, ctx.base))));
    assert.deepEqual(body.body, { title: 'Hi', body: 'Hello there' });
    const names = res.headers.getSetCookie().map((c) => c.split('=')[0]);
    assert.deepEqual(names.sort(), ['flash', cookieNameFor(ctx.base)].sort());
  });

  test('public GETs are cached briefly; writes and private responses are not', async () => {
    const first = await fetch(`${ctx.base}/?page=cache-test`);
    assert.equal(first.headers.get('x-fuse-cache'), 'MISS');
    const text = await first.text();
    const second = await fetch(`${ctx.base}/?page=cache-test`);
    assert.equal(second.headers.get('x-fuse-cache'), 'HIT');
    assert.equal(await second.text(), text);
    const head = await fetch(`${ctx.base}/?page=cache-test`, { method: 'HEAD' });
    assert.equal(head.headers.get('x-fuse-cache'), 'HIT');

    for (const [path, headers] of [['/private-page', {}], ['/varies', { 'accept-language': 'fr' }]]) {
      assert.equal((await fetch(ctx.base + path, { headers })).headers.get('x-fuse-cache'), 'MISS', path);
      assert.equal((await fetch(ctx.base + path, { headers })).headers.get('x-fuse-cache'), 'MISS', path);
    }
    // Requests carrying their own credentials are neither answered from nor stored in the cache.
    const bearer = { authorization: 'Bearer app-token' };
    assert.equal((await fetch(`${ctx.base}/?page=cache-test`, { headers: bearer })).headers.get('x-fuse-cache'), null);
    assert.equal(seen.last.headers.authorization, 'Bearer app-token', 'non-Fuse credentials pass through');

    // A successful write may change public pages: the cache is dropped.
    const dave = ctx.net.members.dave;
    const init = { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'body=x' };
    const { res } = await firstContact(dave, { base: ctx.base, path: '/posts', slot: 2, init });
    assert.equal(res.status, 303);
    assert.equal((await fetch(`${ctx.base}/?page=cache-test`)).headers.get('x-fuse-cache'), 'MISS');
    assert.ok(ctx.events.some((e) => e.type === 'cache' && e.status === 'HIT'));
  });

  test('bodies over 1 MB are refused', async () => {
    const res = await fetch(`${ctx.base}/posts`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(res.status, 413);
  });

  test('an unreachable upstream is a 502', async () => {
    const dead = await startProxyGateway({ port: 0, upstream: 'http://127.0.0.1:1', protect: [], registries: [ctx.net.registry.url], log: ctx.net.log.url });
    try {
      const res = await fetch(`http://127.0.0.1:${dead.port}/`);
      assert.equal(res.status, 502);
    } finally {
      await dead.close();
    }
  });
});
