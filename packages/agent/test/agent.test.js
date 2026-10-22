// SDK integration against stub registry/gateway servers, with real proofs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createIdentity, createWallet, epochAt, epochBounds, pseudonymFor, toHex } from '@fuse/core';
import { releaseProver } from '@fuse/core/node';
import { BannedError, BudgetExhaustedError, CredentialBurnedError, FuseAgent } from '../src/index.js';
import { startHostileSite, startStubGateway, startStubRegistry } from './helpers/stubs.js';

let registry;
let forum;
let api;
let dir;

before(async () => {
  registry = await startStubRegistry();
  forum = await startStubGateway({ registry });
  api = await startStubGateway({ registry });
  dir = await mkdtemp(join(tmpdir(), 'fuse-agent-test-'));
});

after(async () => {
  await Promise.all([registry.close(), forum.close(), api.close()]);
  await rm(dir, { recursive: true, force: true });
  await releaseProver();
});

const eventsOf = (events) => events.map((e) => e.type);

describe('FuseAgent with a wallet file', () => {
  const events = [];
  let agent;
  let walletPath;

  before(async () => {
    walletPath = join(dir, 'nested', 'wallet.json');
    agent = await FuseAgent.create({ registry: registry.url, tier: 'pro', walletPath, onEvent: (e) => events.push(e) });
  });

  test('create locks a deposit and saves a private wallet', async () => {
    const status = agent.status();
    assert.equal(status.tier, 'pro');
    assert.equal(status.limit, 200);
    assert.equal(status.used, 0);
    assert.equal(registry.counts.deposits, 1);
    assert.equal((await stat(walletPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
    const saved = JSON.parse(await readFile(walletPath, 'utf8'));
    assert.equal(saved.commitment, status.commitment);
    assert.equal(saved.deposit.status, 'locked');
    await assert.rejects(FuseAgent.create({ registry: registry.url, walletPath }), { code: 'wallet-exists' });
  });

  test('first contact: challenge, slot, proof, retry, session cookie', async () => {
    const res = await agent.fetch(`${forum.url}/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pseudonym, agent.pseudonymFor(forum.origin));
    assert.deepEqual(eventsOf(events), ['challenge', 'proving', 'proved']);
    assert.equal(events[1].slot, 0);
    assert.equal(events[2].short, body.short);
    assert.ok(events[2].provingMs > 0);

    const status = agent.status();
    assert.equal(status.used, 1);
    assert.equal(status.remaining, 199);
    assert.equal(status.resetsAt, new Date(epochBounds(status.epoch).end).toISOString());
    const [entry] = agent.history;
    assert.deepEqual(
      { origin: entry.origin, epoch: entry.epoch, slot: entry.slot, pseudonym: entry.pseudonym, status: entry.status },
      { origin: forum.origin, epoch: epochAt(), slot: 0, pseudonym: body.pseudonym, status: 200 },
    );

    const saved = JSON.parse(await readFile(walletPath, 'utf8'));
    assert.deepEqual(saved.spent[status.epoch], [0]);
    assert.equal(saved.cookies.length, 1);
    assert.equal(saved.history.length, 1);
  });

  test('a live session spends no slot', async () => {
    events.length = 0;
    const res = await agent.fetch(`${forum.url}/me`);
    assert.equal(res.status, 200);
    assert.deepEqual(eventsOf(events), ['session-reused']);
    assert.equal(agent.status().used, 1);
    assert.equal(forum.counts.sessionHits, 1);
  });

  test('another site gets an unlinkable pseudonym and costs one slot', async () => {
    const res = await agent.fetch(`${api.url}/v1/search?q=fuse`);
    const body = await res.json();
    assert.equal(body.pseudonym, agent.pseudonymFor(api.origin));
    assert.notEqual(body.pseudonym, agent.pseudonymFor(forum.origin));
    const status = agent.status();
    assert.equal(status.used, 2);
    assert.deepEqual(status.sites.map((s) => s.origin).sort(), [api.origin, forum.origin].sort());
    assert.ok(status.sites.every((s) => s.short.startsWith('anon-') && s.lastUsed));
  });

  test('load restores slots, history and session cookies from the file', async () => {
    const reloaded = await FuseAgent.load({ walletPath });
    assert.equal(reloaded.status().used, 2);
    assert.equal(reloaded.history.length, 2);
    const before = forum.counts.challenges;
    const res = await reloaded.fetch(`${forum.url}/me`);
    assert.equal(res.status, 200);
    assert.equal(forum.counts.challenges, before, 'no new challenge: the saved cookie was used');
    assert.equal(reloaded.status().used, 2);
  });
});

describe('FuseAgent requests', () => {
  test('a request body is buffered and sent again with the proof', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    const res = await agent.fetch(`${api.url}/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'fuse' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.method, 'POST');
    assert.deepEqual(JSON.parse(body.body), { hello: 'fuse' });
  });

  test('accepts a Request object, and a throwing onEvent listener cannot break the request', async () => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning.message);
    process.on('warning', onWarning);
    const agent = await FuseAgent.create({
      registry: registry.url,
      onEvent: () => {
        throw new Error('listener bug');
      },
    });
    const res = await agent.fetch(new Request(`${api.url}/v1/echo`, { method: 'PUT', body: 'payload' }));
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    assert.equal(res.status, 200);
    const echoed = await res.json();
    assert.deepEqual([echoed.method, echoed.body], ['PUT', 'payload']);
    assert.ok(warnings.some((m) => m.includes('listener bug')));
  });

  test('the session cookie set on a redirect is kept for the next hop', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    const before = api.counts.challenges;
    const res = await agent.fetch(`${api.url}/v1/submit`, { method: 'POST', body: 'x=1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.path, body.method], ['/me', 'GET'], '303 turned the POST into a GET');
    assert.equal(api.counts.challenges, before + 1, 'the redirected GET rode on the new session');
    assert.equal(agent.status().used, 1);
  });

  test('concurrent first contacts to one site share a single slot', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    const responses = await Promise.all([1, 2, 3].map((n) => agent.fetch(`${forum.url}/v1/item/${n}`)));
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200, 200],
    );
    assert.equal(agent.status().used, 1);
  });

  test('budget exhaustion is detected locally, before anything is sent', async () => {
    const events = [];
    const agent = await FuseAgent.create({ registry: registry.url, tier: 'tiny', onEvent: (e) => events.push(e) });
    for (let i = 0; i < 2; i++) {
      agent.clearCookies();
      assert.equal((await agent.fetch(`${forum.url}/me`)).status, 200);
    }
    agent.clearCookies();
    const authorizations = forum.counts.authorizations;
    const err = await agent.fetch(`${forum.url}/me`).then(
      () => assert.fail('expected BudgetExhaustedError'),
      (e) => e,
    );
    assert.ok(err instanceof BudgetExhaustedError);
    assert.equal(err.limit, 2);
    assert.equal(err.resetsAt, new Date(epochBounds(epochAt()).end).toISOString());
    assert.equal(forum.counts.authorizations, authorizations, 'no proof was sent');
    assert.equal(events.at(-1).type, 'budget-exhausted');
    const { used, remaining } = agent.status();
    assert.deepEqual({ used, remaining }, { used: 2, remaining: 0 });
  });

  test('a banned pseudonym stays banned with a fresh slot and no cookies', async () => {
    const events = [];
    const agent = await FuseAgent.create({ registry: registry.url, onEvent: (e) => events.push(e) });
    await agent.fetch(`${forum.url}/me`);
    const pseudonym = agent.pseudonymFor(forum.origin);
    forum.ban(pseudonym);
    agent.clearCookies();
    const err = await agent.fetch(`${forum.url}/me`).then(
      () => assert.fail('expected BannedError'),
      (e) => e,
    );
    assert.ok(err instanceof BannedError);
    assert.equal(err.pseudonym, pseudonym);
    assert.equal(err.status, 403);
    assert.equal(agent.status().used, 2, 'the proof was sent, so the slot is spent');
    assert.equal(agent.history.at(-1).status, 403);
    assert.equal(events.at(-1).type, 'rejected');
    assert.equal(events.at(-1).reason, 'banned');
  });

  test('403 credential-burned raises CredentialBurnedError', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    api.burnNextProof();
    await assert.rejects(agent.fetch(`${api.url}/v1/search`), (err) => {
      assert.ok(err instanceof CredentialBurnedError);
      assert.equal(err.reason, 'credential-burned');
      return true;
    });
  });

  test('a gateway that cannot finish checking a proof returns its answer; the slot stays spent', async () => {
    const events = [];
    const agent = await FuseAgent.create({ registry: registry.url, onEvent: (e) => events.push(e) });
    api.failNextProof();
    const res = await agent.fetch(`${api.url}/v1/search`);
    assert.equal(res.status, 503);
    assert.deepEqual([events.at(-1).type, events.at(-1).reason], ['rejected', 'log-unavailable']);
    assert.equal(agent.status().used, 1);
    assert.equal(agent.history.at(-1).status, 503);
  });

  test('a credential missing from the registry tree is reported burned; its slot is handed back', async () => {
    const events = [];
    const agent = await FuseAgent.create({ registry: registry.url, onEvent: (e) => events.push(e) });
    registry.burn(agent.status().index);
    await assert.rejects(agent.fetch(`${api.url}/v1/search`), (err) => {
      assert.ok(err instanceof CredentialBurnedError);
      assert.equal(err.reason, 'not-a-member');
      return true;
    });
    assert.equal(agent.status().used, 0, 'no proof existed, so the slot was handed back');
    assert.deepEqual(
      events.map((e) => [e.type, e.reason]),
      [
        ['challenge', undefined],
        ['rejected', 'not-a-member'],
      ],
    );
  });

  test('public paths and non-Fuse responses pass straight through', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    const res = await agent.fetch(`${forum.url}/`);
    assert.deepEqual(await res.json(), { public: true, path: '/' });
    assert.equal(agent.status().used, 0);
  });

  test('pseudonyms are computed locally from the origin alone', async () => {
    const agent = await FuseAgent.create({ registry: registry.url });
    const { secret } = agent.wallet;
    assert.equal(agent.pseudonymFor('http://localhost:4710/some/path'), toHex(pseudonymFor(secret, 'http://localhost:4710')));
    assert.notEqual(agent.pseudonymFor('http://localhost:4710'), agent.pseudonymFor('http://localhost:4720'));
  });
});

describe('budget safety', () => {
  const sites = [];
  after(() => Promise.all(sites.map((site) => site.close())));
  const hostile = async (options) => {
    const site = await startHostileSite(options);
    sites.push(site);
    return site;
  };
  const repeatChallenge = (err) => {
    assert.equal(err.code, 'repeat-challenge');
    return true;
  };

  test('a site that redirects every proof back to a challenge gets one slot per fetch()', async () => {
    const events = [];
    const site = await hostile();
    const agent = await FuseAgent.create({ registry: registry.url, tier: 'starter', onEvent: (e) => events.push(e) });
    await assert.rejects(agent.fetch(`${site.url}/loop`), repeatChallenge);
    assert.equal(agent.status().used, 1);
    assert.equal(site.proofs, 1);
    assert.deepEqual(
      events.map((e) => e.type),
      ['challenge', 'proving', 'proved', 'challenge', 'rejected'],
    );
    assert.deepEqual([events.at(-1).reason, events.at(-1).slot], ['repeat-challenge', null]);
  });

  test('a renewed challenge in answer to the proof is not answered twice', async () => {
    const site = await hostile({
      onProof: () => ({ status: 401, headers: { 'www-authenticate': 'Fuse challenge="again", network="fuse-demo-v1"' } }),
    });
    const agent = await FuseAgent.create({ registry: registry.url, tier: 'starter' });
    await assert.rejects(agent.fetch(`${site.url}/again`), repeatChallenge);
    assert.deepEqual([agent.status().used, site.proofs], [1, 1]);
  });

  test('a redirect chain across origins cannot spend a second slot either', async () => {
    const second = await hostile();
    const first = await hostile({ onProof: () => ({ status: 302, headers: { location: `${second.url}/loop` } }) });
    const agent = await FuseAgent.create({ registry: registry.url, tier: 'starter' });
    await assert.rejects(agent.fetch(`${first.url}/start`), repeatChallenge);
    assert.deepEqual([agent.status().used, first.proofs, second.proofs], [1, 1, 0]);
  });

  test('firstContactCooldownMs spaces first contacts at one origin', async () => {
    const wallet = createWallet({ secret: createIdentity().secret, registry: registry.url, index: 0, limit: 1, tier: 'x' });
    assert.throws(() => new FuseAgent({ wallet, firstContactCooldownMs: -1 }), TypeError);
    const clock = { now: Date.now() };
    const agent = await FuseAgent.create({ registry: registry.url, firstContactCooldownMs: 5000, now: () => clock.now });
    assert.equal((await agent.fetch(`${forum.url}/me`)).status, 200);
    agent.clearCookies();
    await assert.rejects(agent.fetch(`${forum.url}/me`), (err) => {
      assert.equal(err.code, 'first-contact-cooldown');
      assert.equal(Date.parse(err.retryAt), Date.parse(agent.history[0].at) + 5000);
      return true;
    });
    assert.equal(agent.status().used, 1, 'refused before reserving a slot');
    assert.equal((await agent.fetch(`${api.url}/v1/search`)).status, 200, 'other origins are not held back');
    clock.now += 5000;
    agent.clearCookies();
    assert.equal((await agent.fetch(`${forum.url}/me`)).status, 200);
    assert.equal(agent.status().used, 3);
  });

  test('a session cookie never reaches another origin on the same host', async () => {
    const sent = [];
    const spy = (url, init) => {
      sent.push({ origin: new URL(url).origin, cookie: new Headers(init?.headers).get('cookie') ?? '' });
      return fetch(url, init);
    };
    const agent = await FuseAgent.create({ registry: registry.url, fetch: spy });
    for (const url of [`${forum.url}/me`, `${api.url}/v1/search`, `${api.url}/v1/search`]) {
      await (await agent.fetch(url)).arrayBuffer();
    }
    assert.equal(new URL(forum.url).hostname, new URL(api.url).hostname, 'both sites share a host');
    const toApi = sent.filter((s) => s.origin === api.origin);
    assert.match(toApi.at(-1).cookie, new RegExp(`^${api.cookieName}=`), 'the api session cookie is reused');
    assert.ok(toApi.every((s) => !s.cookie.includes(forum.cookieName)), 'the forum cookie never went to the api');
  });
});
