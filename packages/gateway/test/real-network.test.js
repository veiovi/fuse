// End to end against the real @fuse/registry and @fuse/log (skipped until
// both packages exist): deposit → first contact → session → a slot reused at
// a second site burns the key, and the first site ends its session.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createIdentity, pseudonymFor, toHex } from '@fuse/core';
import { releaseProver } from '@fuse/core/node';
import { cookieNameFor, fuseGateway, startProxyGateway } from '../src/index.js';
import { cookieFrom, eventually, listen, prove } from './helpers/network.js';

const registryEntry = new URL('../../registry/src/index.js', import.meta.url);
const logEntry = new URL('../../log/src/index.js', import.meta.url);
const missing = !existsSync(registryEntry) || !existsSync(logEntry);

after(releaseProver);

describe('gateway against the real registry and log', { skip: missing && 'registry or log not available yet' }, () => {
  let registry;
  let log;
  let siteA;
  let siteB;
  let upstream;
  const events = [];

  async function deposit() {
    const identity = createIdentity();
    const res = await fetch(`${registry.url}/deposits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commitment: toHex(identity.commitment), tier: 'starter' }),
    });
    assert.equal(res.status, 201);
    const { index, limit } = await res.json();
    return { secret: identity.secret, index, limit };
  }

  async function withLeaves(member) {
    const tree = await (await fetch(`${registry.url}/tree`)).json();
    return { ...member, leaves: tree.leaves };
  }

  async function firstContact(member, base, path, slot) {
    const challenged = await fetch(base + path, { headers: { accept: 'application/json' } });
    assert.equal(challenged.status, 401);
    const { challenge } = await challenged.json();
    const auth = await prove(await withLeaves(member), { origin: base, challenge, slot });
    return fetch(base + path, { headers: { accept: 'application/json', authorization: auth.authorization } });
  }

  before(async () => {
    const { startRegistry } = await import(registryEntry);
    const { startLog } = await import(logEntry);
    registry = await startRegistry({ port: 0 });
    log = await startLog({ port: 0, registries: [registry.url] });

    // Site A: middleware (created once its port, and so its origin, is known).
    let appA = null;
    let gatewayA = null;
    const serverA = await listen((req, res) => appA(req, res));
    gatewayA = fuseGateway({
      siteName: 'Site A',
      origins: [serverA.url],
      protect: ['/me'],
      registries: [registry.url],
      log: log.url,
      revocationPollMs: 100,
      onEvent: (e) => events.push(e),
    });
    appA = express();
    appA.use(gatewayA);
    appA.get('/me', (req, res) => res.json(req.fuse));
    siteA = { url: serverA.url, close: async () => { gatewayA.close(); await serverA.close(); } };

    // Site B: reverse proxy in front of a tiny app.
    const app = express();
    app.get('/me', (req, res) => res.json({ pseudonym: req.get('x-fuse-pseudonym') }));
    upstream = await listen(app);
    const proxy = await startProxyGateway({
      port: 0,
      upstream: upstream.url,
      origins: (port) => [`http://127.0.0.1:${port}`],
      siteName: 'Site B',
      protect: ['/me'],
      registries: [registry.url],
      log: log.url,
    });
    siteB = { url: proxy.url, close: () => proxy.close() };
  });

  after(async () => {
    await siteA?.close();
    await siteB?.close();
    await upstream?.close();
    await log?.close();
    await registry?.close();
  });

  test('a deposit-backed credential gets in, and the session rides without proofs', async () => {
    const honest = await deposit();
    const res = await firstContact(honest, siteA.url, '/me', 0);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).pseudonym, toHex(pseudonymFor(honest.secret, siteA.url)));
    const cookie = `${cookieNameFor(siteA.url)}=${cookieFrom(res, cookieNameFor(siteA.url))}`;
    assert.equal((await fetch(`${siteA.url}/me`, { headers: { cookie } })).status, 200);
    const entries = await (await fetch(`${log.url}/entries`)).json();
    assert.equal(entries.size, 1);

    const viaProxy = await firstContact(honest, siteB.url, '/me', 1);
    assert.equal(viaProxy.status, 200);
    const seenB = (await viaProxy.json()).pseudonym;
    assert.equal(seenB, toHex(pseudonymFor(honest.secret, siteB.url)));
    assert.notEqual(seenB, toHex(pseudonymFor(honest.secret, siteA.url)), 'unlinkable across sites');
  });

  test('a slot reused at another site burns the key; the first site ends its session', async () => {
    const cheater = await deposit();
    const first = await firstContact(cheater, siteA.url, '/me', 0);
    assert.equal(first.status, 200);
    const cookie = `${cookieNameFor(siteA.url)}=${cookieFrom(first, cookieNameFor(siteA.url))}`;

    const second = await firstContact(cheater, siteB.url, '/me', 0); // same slot, new challenge
    assert.equal(second.status, 403);
    assert.equal((await second.json()).error, 'credential-burned');

    const revocations = (await (await fetch(`${log.url}/revocations`)).json()).revocations;
    assert.equal(revocations.length, 1);
    assert.equal(revocations[0].secret, toHex(cheater.secret));

    const pseudonymA = toHex(pseudonymFor(cheater.secret, siteA.url));
    await eventually(() => events.some((e) => e.type === 'revocation-applied' && e.pseudonym === pseudonymA), 5000);
    const ride = await fetch(`${siteA.url}/me`, { headers: { cookie } });
    assert.equal(ride.status, 403);
    assert.equal((await ride.json()).error, 'credential-burned');

    // The registry dropped the leaf: a fresh proof from the burned key no longer verifies against a valid root.
    const retry = await firstContact(cheater, siteA.url, '/me', 1).catch((err) => err);
    assert.ok(retry instanceof Error || retry.status === 401 || retry.status === 403);
  });
});
