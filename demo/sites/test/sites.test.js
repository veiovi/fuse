// The two demo sites against an in-test registry and log, with real proofs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pseudonymFor, shortPseudonym, toHex } from '@fuse/core';
import { releaseProver } from '@fuse/core/node';
import { cookieNameFor } from '@fuse/gateway';
import { cookieFrom, prove, rawRequest, startStubNetwork } from '../../../packages/gateway/test/helpers/network.js';
import { startApi } from '../api/app.js';
import { startForum } from '../forum/app.js';

after(releaseProver);

const dataDir = mkdtempSync(join(tmpdir(), 'fuse-sites-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

/** 401 → prove → retry: returns the response and a Cookie header for the new session. */
async function signIn(member, base, path, slot, init = {}) {
  const first = await fetch(base + path, { ...init, headers: { accept: 'application/json', ...init.headers } });
  assert.equal(first.status, 401);
  const { challenge } = await first.json();
  const auth = await prove(member, { origin: base, challenge, slot });
  const res = await fetch(base + path, { ...init, headers: { ...init.headers, authorization: auth.authorization } });
  const value = cookieFrom(res, cookieNameFor(base));
  return { res, cookie: value && `${cookieNameFor(base)}=${value}` };
}

describe('Acme Forum (reverse proxy)', () => {
  let net;
  let forum;
  let base;

  before(async () => {
    net = await startStubNetwork(['writer']);
    forum = await startForum({ port: 0, upstreamPort: 0, registryUrl: net.registry.url, logUrl: net.log.url, dataDir });
    base = forum.url;
  });

  after(async () => {
    await forum.close();
    await net.close();
  });

  test('answers on its own host name, forum.localhost', () => {
    assert.equal(forum.url, `http://forum.localhost:${forum.port}`);
  });

  test('public pages are free and cached', async () => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Sourdough starter smells like nail polish/);
    assert.equal(home.headers.get('x-fuse-cache'), 'MISS');
    assert.equal((await fetch(`${base}/`)).headers.get('x-fuse-cache'), 'HIT');
    assert.equal((await fetch(`${base}/t/2`)).status, 200);
    assert.equal((await fetch(`${base}/t/999`)).status, 404);
  });

  test('protected pages ask for a Fuse pass (interstitial for browsers)', async () => {
    const res = await fetch(`${base}/new`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /Acme Forum asks for a Fuse pass/);
    assert.match(html, /<meta name="fuse-challenge" content="[\w-]+\.[\w-]+">/);
  });

  test('post as a pseudonym, see it at once, and read what Acme knows', async () => {
    const writer = net.members.writer;
    const short = shortPseudonym(toHex(pseudonymFor(writer.secret, base)));
    const { res, cookie } = await signIn(writer, base, '/new', 0);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(`posting as <span class="chip"[^>]*><i></i>${short}`));

    await fetch(`${base}/`); // warm the cache; the post must invalidate it
    const posted = await fetch(`${base}/posts`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'Hello from a pseudonym', body: 'No account needed.' }),
    });
    assert.equal(posted.status, 303);
    const location = posted.headers.get('location');
    assert.match(location, /^\/t\/5#p\d+$/);
    const thread = await (await fetch(base + location.split('#')[0])).text();
    assert.match(thread, /Hello from a pseudonym/);
    assert.match(thread, new RegExp(short));
    const home = await fetch(`${base}/`);
    assert.equal(home.headers.get('x-fuse-cache'), 'MISS');
    assert.match(await home.text(), /Hello from a pseudonym/);

    const me = await fetch(`${base}/me`, { headers: { cookie } });
    const page = await me.text();
    assert.match(page, /This is everything Acme knows about you/);
    assert.match(page, new RegExp(toHex(pseudonymFor(writer.secret, base))));
    assert.match(page, /badge probation/);
    assert.equal(net.log.submissions.length, 1, 'one first contact for the whole visit');
  });

  test('protected pages reached under another host name are sent to the canonical origin', async () => {
    const viaIp = `http://127.0.0.1:${forum.port}`;
    const res = await fetch(`${viaIp}/new?thread=1`, { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), `${base}/new?thread=1`);
    assert.equal((await fetch(`${viaIp}/posts`, { method: 'POST' })).status, 421);
    assert.equal((await fetch(`${viaIp}/`)).status, 200, 'reading stays open under any name');
  });

  test('the upstream refuses requests that did not come through the gateway', async () => {
    const res = await fetch(`${forum.upstreamUrl}/me`);
    assert.equal(res.status, 401);
  });
});

describe('Bolt API (middleware)', () => {
  let net;
  let api;
  let base;

  before(async () => {
    net = await startStubNetwork(['agent']);
    api = await startApi({ port: 0, registryUrl: net.registry.url, logUrl: net.log.url, dataDir });
    base = api.url;
  });

  after(async () => {
    await api.close();
    await net.close();
  });

  test('answers on its own host name, api.localhost, apart from the forum', () => {
    assert.equal(api.url, `http://api.localhost:${api.port}`);
  });

  test('docs and status are public', async () => {
    const docs = await (await fetch(`${base}/`)).text();
    assert.match(docs, /Bolt API/);
    assert.ok(docs.includes(`npx fuse fetch &quot;${base}/v1/search?q=hello&quot;`));
    const status = await (await fetch(`${base}/v1/status`)).json();
    assert.equal(status.ok, true);
    assert.deepEqual(status.fuse.protected, ['/v1/search', '/v1/summarize', '/v1/me']);
    assert.deepEqual(status.fuse.origins, [base]);
  });

  test('requests outside the spec are refused before proof work', async () => {
    for (const [path, init, reason] of [
      ['/v1/delete-everything', {}, 'unknown-route'],
      ['/v1/search', {}, 'missing-query-param'],
      ['/v1/search?q=x&limit=500', {}, 'bad-query-param'],
      ['/v1/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":42}' }, 'bad-field'],
    ]) {
      const res = await fetch(base + path, init);
      assert.equal(res.status, 400, path);
      assert.equal((await res.json()).reason, reason);
    }
  });

  test('search, summarize and /v1/me with one first contact', async () => {
    const agent = net.members.agent;
    const pseudonym = toHex(pseudonymFor(agent.secret, base));
    const { res, cookie } = await signIn(agent, base, '/v1/search?q=pseudonym&limit=2', 0);
    assert.equal(res.status, 200);
    const found = await res.json();
    assert.equal(found.results[0].id, 'pseudonyms');
    assert.equal(found.results.length, 2);
    assert.equal(found.caller, shortPseudonym(pseudonym));

    const summary = await fetch(`${base}/v1/summarize`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Fuse gives every credential a daily budget. Each first contact spends one slot. Reusing a slot reveals the key. The weather was nice. Sessions make later requests free.',
        sentences: 2,
      }),
    });
    assert.equal(summary.status, 200);
    const body = await summary.json();
    assert.equal(body.sentences.length, 2);
    assert.equal(body.stats.inputSentences, 5);

    const me = await (await fetch(`${base}/v1/me`, { headers: { cookie } })).json();
    assert.equal(me.pseudonym, pseudonym);
    assert.equal(me.reputation, 'probation');
    assert.equal(net.log.submissions.length, 1);
  });

  test('the reputation stores persist in per-site folders', async () => {
    api.gateway.store.flush();
    assert.ok(existsSync(join(dataDir, 'api', 'reputation.json')));
  });
});

describe('explicit origins (a public name in front, as demo/run.js passes)', () => {
  let net;
  let api;

  before(async () => {
    net = await startStubNetwork(['visitor']);
    api = await startApi({
      port: 0,
      registryUrl: net.registry.url,
      logUrl: net.log.url,
      origins: ['https://bolt.example.ts.net', 'http://api.localhost:4720'],
    });
  });

  after(async () => {
    await api.close();
    await net.close();
  });

  test('url is the first origin; each listed host is served, others are redirected to it', async () => {
    assert.equal(api.url, 'https://bolt.example.ts.net');
    const local = `http://127.0.0.1:${api.port}`;
    const viaPublicName = await rawRequest(`${local}/v1/me`, { headers: { host: 'bolt.example.ts.net', accept: 'application/json' } });
    assert.equal(viaPublicName.status, 401);
    assert.match(viaPublicName.headers['www-authenticate'], /^Fuse challenge=/);
    const viaLocalName = await rawRequest(`${local}/v1/me`, { headers: { host: 'api.localhost:4720', accept: 'application/json' } });
    assert.equal(viaLocalName.status, 401);
    const viaIp = await rawRequest(`${local}/v1/me`, { headers: { accept: 'application/json' } });
    assert.equal(viaIp.status, 307);
    assert.equal(viaIp.headers.location, 'https://bolt.example.ts.net/v1/me');
    const docs = await rawRequest(`${local}/`, { headers: { host: 'api.localhost:4720' } });
    assert.ok(docs.text.includes('npx fuse fetch &quot;http://api.localhost:4720/v1/search?q=hello&quot;'), 'examples use the name the reader came by');
  });
});
