import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { EPOCH_SECONDS, epochAt, pseudonymFor, shortPseudonym } from '@fuse/core';
import { AUTO_SPEND_COOLDOWN_MS, decideFirstContact } from '../src/policy.js';
import { createFuseService, normalizeRegistryUrl } from '../src/service.js';
import { createFakeProver, createFakeRegistry, createFakeStorage } from './fakes.js';

const SITE = 'http://forum.localhost:4710';
const OTHER = 'https://api.test';
const DAY_MS = EPOCH_SECONDS * 1000;

/** A spend the person confirmed by clicking Allow or Always in the card. */
const click = (challenge, extra = {}) => ({ challenge, trigger: 'click', ...extra });

function setup({ protect = async () => true, tiers } = {}) {
  const clock = { now: Date.UTC(2026, 9, 22, 12, 0, 0) };
  const storage = createFakeStorage();
  const registry = createFakeRegistry(tiers ? { tiers } : undefined);
  const prover = createFakeProver({ storage });
  const service = createFuseService({
    storage,
    fetch: (url, init) => registry.fetch(url, init),
    prove: (request) => prover.prove(request),
    protectStorage: protect,
    now: () => clock.now,
  });
  return { clock, storage, registry, prover, service };
}

async function registered(options) {
  const ctx = setup(options);
  await ctx.service.register({ registry: `${ctx.registry.url}/`, tier: 'starter' });
  return ctx;
}

const until = (condition) =>
  new Promise((resolve) => {
    const timer = setInterval(() => condition() && (clearInterval(timer), resolve()), 1);
  });

describe('registration', () => {
  test('creates the wallet locally and sends only the commitment', async () => {
    const { service, storage, registry } = setup();
    const status = await service.register({ registry: 'http://registry.test/', tier: 'starter' });
    const wallet = storage.peek('wallet');
    assert.equal(wallet.registry, 'http://registry.test');
    assert.deepEqual([wallet.index, wallet.limit, wallet.tier], [0, 3, 'starter']);
    assert.match(wallet.secret, /^0x[0-9a-f]{64}$/);
    const deposit = registry.requests.find((r) => r.method === 'POST');
    assert.deepEqual(JSON.parse(deposit.body), { commitment: wallet.commitment, tier: 'starter' });
    assert.ok(!deposit.body.includes(wallet.secret.slice(2)), 'the secret never goes to the registry');
    assert.equal(status.credential.status, 'active');
    assert.equal(status.budget.remaining, 3);
  });

  test('status never contains the secret', async () => {
    const { service, storage } = await registered();
    await service.prove(SITE, click('c1'));
    await service.setPermission({ origin: OTHER, permission: 'never' });
    const secret = storage.peek('wallet').secret;
    const serialized = JSON.stringify(await service.status());
    assert.ok(!serialized.includes(secret.slice(2)));
    assert.ok(!serialized.includes(BigInt(secret).toString()));
  });

  test('fails closed when storage cannot be kept from content scripts', async () => {
    const { service, storage, registry } = setup({ protect: async () => false });
    await assert.rejects(service.register({ registry: 'http://registry.test', tier: 'starter' }), { code: 'storage-unprotected' });
    assert.equal(storage.peek('wallet'), undefined, 'no secret was written');
    assert.equal(registry.requests.length, 0, 'no deposit was made');
  });

  test('refuses a second credential and a registry that records the wrong leaf', async () => {
    const { service } = await registered();
    await assert.rejects(service.register({ registry: 'http://registry.test', tier: 'starter' }), { code: 'credential-exists' });

    const other = setup();
    other.registry.lieAboutLeaf = true;
    await assert.rejects(other.service.register({ registry: 'http://registry.test', tier: 'starter' }), { code: 'registry-error' });
    assert.equal(other.storage.peek('wallet'), undefined);
  });

  test('reports an unreachable registry and lists tiers from /info', async () => {
    const { service } = setup();
    await assert.rejects(service.registryInfo('http://nowhere.test'), { code: 'registry-unreachable' });
    const info = await service.registryInfo('http://registry.test');
    assert.equal(info.compatible, true);
    assert.deepEqual(info.tiers, [{ id: 'starter', deposit: 5, limit: 3 }]);
  });

  test('registry URLs are normalized and must be http(s)', () => {
    assert.equal(normalizeRegistryUrl(' http://localhost:4701/ '), 'http://localhost:4701');
    assert.equal(normalizeRegistryUrl('https://r.example/fuse/?x=1#y'), 'https://r.example/fuse');
    assert.throws(() => normalizeRegistryUrl('ftp://r.example'), { code: 'bad-request' });
    assert.throws(() => normalizeRegistryUrl('not a url'), { code: 'bad-request' });
  });
});

describe('spending slots', () => {
  test('reserves and persists the slot before proving, then records the spend', async () => {
    const { service, storage, prover, clock } = await registered();
    const result = await service.prove(SITE, click('c1'));
    const epoch = epochAt(clock.now);

    assert.equal(prover.calls.length, 1);
    assert.deepEqual(prover.calls[0].persistedSlots, [0], 'slot 0 was in storage before the prover ran');
    assert.equal(prover.calls[0].request.origin, SITE);
    assert.equal(prover.calls[0].request.epoch, epoch);
    assert.match(result.authorization, /^Fuse origin="http:\/\/forum.localhost:4710"/);
    assert.deepEqual([result.slot, result.used, result.remaining, result.limit], [0, 1, 2, 3]);

    const wallet = storage.peek('wallet');
    assert.deepEqual(
      wallet.history.map((h) => [h.id, h.origin, h.slot, h.provingMs, h.outcome, h.trigger]),
      [[`${epoch}:0`, SITE, 0, 321, 'proved', 'click']],
    );
    const site = storage.peek('sites')[SITE];
    assert.equal(site.short, shortPseudonym(pseudonymFor(wallet.secret, SITE)));
    assert.equal(site.spends, 1);
  });

  test('concurrent requests are serialized and get distinct slots', async () => {
    const { service, prover } = await registered();
    const results = await Promise.all([
      service.prove(SITE, click('a')),
      service.prove(OTHER, click('b')),
      service.prove(SITE, click('c')),
    ]);
    assert.deepEqual(results.map((r) => r.slot).sort(), [0, 1, 2]);
    assert.equal(prover.maxActive, 1, 'never two proofs at once');
  });

  test('stops at the daily limit and resets the next epoch', async () => {
    const { service, prover, clock } = await registered();
    for (const challenge of ['a', 'b', 'c']) await service.prove(SITE, click(challenge));
    await assert.rejects(service.prove(SITE, click('d')), (err) => {
      assert.equal(err.code, 'budget-exhausted');
      assert.equal(err.details.remaining, 0);
      assert.equal(err.details.resetsAt, new Date((epochAt(clock.now) + 1) * DAY_MS).toISOString());
      return true;
    });
    assert.equal(prover.calls.length, 3);
    assert.equal((await service.challengeState(SITE)).code, 'budget-exhausted');

    clock.now += DAY_MS;
    const next = await service.prove(SITE, click('e'));
    assert.deepEqual([next.slot, next.remaining], [0, 2]);
  });

  test('a failed proof releases its slot and leaves no trace on the site', async () => {
    const { service, prover, storage, clock } = await registered();
    prover.failNext = new Error('wasm exploded');
    await assert.rejects(service.prove(SITE, click('c1')), { code: 'proof-failed' });
    assert.deepEqual(storage.peek('wallet').spent[epochAt(clock.now)], []);
    assert.equal(storage.peek('sites')[SITE], undefined, 'no first contact, no cooldown');
    const retry = await service.prove(SITE, click('c2'));
    assert.equal(retry.slot, 0);
  });

  test('a removed credential is detected before proving and marked burned', async () => {
    const { service, registry, prover, storage } = await registered();
    registry.burn(0);
    await assert.rejects(service.prove(SITE, click('c1')), { code: 'credential-burned' });
    assert.equal(prover.calls.length, 0);
    assert.equal(storage.peek('credential').status, 'burned');
    assert.equal((await service.challengeState(SITE)).code, 'credential-burned');
    assert.equal((await service.status()).budget.used, 0, 'the reserved slot was released');
  });

  test('rejects malformed challenges and blocked sites without spending', async () => {
    const { service, prover } = await registered();
    await assert.rejects(service.prove(SITE, click('')), { code: 'bad-request' });
    await assert.rejects(service.prove(SITE, click('x'.repeat(5000))), { code: 'bad-request' });
    await service.setPermission({ origin: SITE, permission: 'never' });
    await assert.rejects(service.prove(SITE, click('c1')), { code: 'blocked' });
    assert.equal(prover.calls.length, 0);
  });

  test('without a credential there is nothing to spend', async () => {
    const { service } = setup();
    await assert.rejects(service.prove(SITE, click('c1')), { code: 'no-credential' });
    assert.equal((await service.challengeState(SITE)).code, 'no-credential');
  });

  test('a request whose page is gone by the time it is served is dropped before reserving', async () => {
    const { service, prover, storage, clock } = await registered();
    let pageOpen = true;
    prover.hold = new Promise((resolve) => setTimeout(resolve, 20));
    const first = service.prove(SITE, click('c1'));
    const queued = service.prove(OTHER, click('c2'), { alive: async () => pageOpen });
    pageOpen = false; // the second page navigates away while the first proof runs
    await first;
    await assert.rejects(queued, { code: 'page-gone' });
    assert.equal(prover.calls.length, 1);
    assert.deepEqual(storage.peek('wallet').spent[epochAt(clock.now)], [0]);
  });
});

describe('automatic spends ("always")', () => {
  test('a page reloading itself during a proof gets one automatic spend, not one per load', async () => {
    // The review's repro: each load runs challenge-state, then proves if told 'auto'.
    const { service, prover, storage, clock } = await registered({ tiers: [{ id: 'starter', deposit: 5, limit: 10 }] });
    await service.setPermission({ origin: SITE, permission: 'always' });
    prover.hold = new Promise((resolve) => setTimeout(resolve, 100));
    const pending = [];
    const actions = [];
    for (let load = 0; load < 8; load++) {
      const state = await service.challengeState(SITE);
      actions.push(state.reason ?? state.action);
      if (state.action === 'auto') pending.push(service.prove(SITE, { challenge: `c${load}` }).catch((e) => e.code));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(pending);
    assert.deepEqual(storage.peek('wallet').spent[epochAt(clock.now)], [0], 'one slot');
    assert.equal(prover.calls.length, 1);
    assert.equal(actions[0], 'auto');
    assert.ok(actions.slice(1).every((a) => a === 'recent-spend'), actions.join());
  });

  test('automatic requests that slipped past challenge-state are re-decided in the queue', async () => {
    const { service, prover, storage, clock } = await registered({ tiers: [{ id: 'starter', deposit: 5, limit: 10 }] });
    await service.setPermission({ origin: SITE, permission: 'always' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => service.prove(SITE, { challenge: `c${i}`, trigger: 'auto' })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'needs-consent' && r.reason.details.reason === 'recent-spend'));
    assert.equal(prover.calls.length, 1);
    assert.deepEqual(storage.peek('wallet').spent[epochAt(clock.now)], [0]);
  });

  test('the cooldown covers a proof still in flight', async () => {
    const { service, prover } = await registered();
    await service.setPermission({ origin: SITE, permission: 'always' });
    let release;
    prover.hold = new Promise((resolve) => (release = resolve));
    const inFlight = service.prove(SITE, { challenge: 'c1', trigger: 'auto' });
    await until(() => prover.calls.length === 1);
    const state = await service.challengeState(SITE);
    assert.deepEqual([state.action, state.reason], ['ask', 'recent-spend']);
    release();
    await inFlight;
  });

  test('without "always", nothing is spent unless the person clicks', async () => {
    const { service, prover } = await registered();
    await assert.rejects(service.prove(SITE, { challenge: 'c1' }), { code: 'needs-consent' });
    await assert.rejects(service.prove(SITE, { challenge: 'c1', remember: 'always' }), { code: 'needs-consent' });
    assert.equal((await service.challengeState(SITE)).permission, 'ask', 'only a click can turn on "always"');
    assert.equal(prover.calls.length, 0);
    await service.prove(SITE, click('c2'));
    assert.equal(prover.calls.length, 1);
  });

  test('a click still spends during the cooldown; a banned site is never paid automatically', async () => {
    const { service, clock } = await registered();
    await service.prove(SITE, click('c1', { remember: 'always' }));
    await assert.rejects(service.prove(SITE, { challenge: 'c2', trigger: 'auto' }), { code: 'needs-consent' });
    const clicked = await service.prove(SITE, click('c3'));
    assert.equal(clicked.slot, 1);
    await service.redeemResult(SITE, { spendId: clicked.spendId, ok: false, status: 403, error: 'banned' });
    clock.now += AUTO_SPEND_COOLDOWN_MS + 1000;
    await assert.rejects(service.prove(SITE, { challenge: 'c4', trigger: 'auto' }), (err) => err.details.reason === 'banned');
  });

  test('a failed automatic proof does not start the cooldown', async () => {
    const { service, prover } = await registered();
    await service.setPermission({ origin: SITE, permission: 'always' });
    prover.failNext = new Error('wasm exploded');
    await assert.rejects(service.prove(SITE, { challenge: 'c1', trigger: 'auto' }), { code: 'proof-failed' });
    assert.equal((await service.challengeState(SITE)).action, 'auto');
  });
});

describe('permissions and the in-page decision', () => {
  test('ask by default; "always" auto-spends; "never" ignores', async () => {
    const { service, clock } = await registered();
    const first = await service.challengeState(SITE);
    assert.equal(first.action, 'ask');
    assert.equal(first.returning, null, 'no pseudonym is shown to a site that has not seen it');
    assert.deepEqual([first.remaining, first.limit], [3, 3]);

    await service.prove(SITE, click('c1', { remember: 'always' }));
    assert.equal((await service.status()).sites[0].permission, 'always');

    clock.now += AUTO_SPEND_COOLDOWN_MS + 1000;
    const later = await service.challengeState(SITE);
    assert.equal(later.action, 'auto');
    assert.match(later.returning.short, /^anon-[0-9a-f]{8}$/);

    await service.setPermission({ origin: SITE, permission: 'never' });
    assert.equal((await service.challengeState(SITE)).action, 'ignore');
    await service.setPermission({ origin: SITE, permission: 'ask' });
    assert.equal((await service.challengeState(SITE)).permission, 'ask');
  });

  test('an always-allowed site that asks again soon is asked about, not paid', async () => {
    const { service, clock } = await registered();
    await service.prove(SITE, click('c1', { remember: 'always' }));
    clock.now += 60_000;
    assert.deepEqual(
      [(await service.challengeState(SITE)).action, (await service.challengeState(SITE)).reason],
      ['ask', 'recent-spend'],
    );
  });

  test('page hints: another network is refused, another registry is flagged', async () => {
    const { service, prover } = await registered();
    const wrong = await service.challengeState(SITE, { network: 'other-net' });
    assert.deepEqual([wrong.action, wrong.code, wrong.network, wrong.expected], ['error', 'wrong-network', 'other-net', 'fuse-demo-v1']);
    const same = await service.challengeState(SITE, { network: 'fuse-demo-v1', registry: 'http://registry.test/' });
    assert.deepEqual([same.action, same.otherRegistry], ['ask', null]);
    const other = await service.challengeState(SITE, { registry: 'http://elsewhere.test' });
    assert.equal(other.otherRegistry, 'http://elsewhere.test');
    assert.equal((await service.challengeState(SITE, { registry: 'not a url' })).otherRegistry, null);
    assert.equal(prover.calls.length, 0);
  });

  test('decideFirstContact', () => {
    const now = 10 * AUTO_SPEND_COOLDOWN_MS;
    assert.deepEqual(decideFirstContact({ now }), { action: 'ask' });
    assert.deepEqual(decideFirstContact({ permission: 'never', now }), { action: 'ignore' });
    assert.deepEqual(decideFirstContact({ permission: 'always', now }), { action: 'auto' });
    assert.deepEqual(decideFirstContact({ permission: 'always', lastSpendAt: now - 1000, now }), { action: 'ask', reason: 'recent-spend' });
    assert.deepEqual(decideFirstContact({ permission: 'always', bannedAt: 'x', now }), { action: 'ask', reason: 'banned' });
  });

  test('permission-only sites are listed with their would-be pseudonym; delete keeps permissions', async () => {
    const { service, storage } = await registered();
    await service.setPermission({ origin: 'https://API.test:443/path', permission: 'never' });
    const status = await service.status();
    assert.deepEqual(status.sites.map((s) => [s.origin, s.permission, s.firstContact]), [[OTHER, 'never', null]]);
    assert.equal(status.sites[0].short, shortPseudonym(pseudonymFor(storage.peek('wallet').secret, OTHER)));
    await assert.rejects(service.setPermission({ origin: 'javascript:alert(1)', permission: 'never' }), { code: 'bad-request' });
    await assert.rejects(service.setPermission({ origin: OTHER, permission: 'sometimes' }), { code: 'bad-request' });

    const after = await service.deleteCredential();
    assert.equal(after.credential, null);
    assert.equal(storage.peek('wallet'), undefined);
    assert.deepEqual(storage.peek('permissions'), { [OTHER]: 'never' });
  });
});

describe('redeem results', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await registered();
  });

  test('a content script can only annotate its own origin’s spends', async () => {
    const { spendId } = await ctx.service.prove(SITE, click('c1'));
    assert.deepEqual(await ctx.service.redeemResult(OTHER, { spendId, ok: false, error: 'banned' }), { recorded: false });
    await ctx.service.redeemResult(SITE, { spendId, ok: true, status: 200, reputation: 'probation' });
    const status = await ctx.service.status();
    assert.equal(status.history[0].outcome, 'accepted');
    assert.equal(status.sites[0].reputation, 'probation');
  });

  test('the success summary survives the reload once, for the same origin only', async () => {
    const { spendId, short } = await ctx.service.prove(SITE, click('c1'));
    await ctx.service.redeemResult(SITE, { spendId, ok: true, status: 200, toast: 'toast-1' });
    assert.equal(await ctx.service.takeToast(OTHER, 'toast-1'), null);
    assert.deepEqual(await ctx.service.takeToast(SITE, 'toast-1'), { short, slot: 0, limit: 3, provingMs: 321 });
    assert.equal(await ctx.service.takeToast(SITE, 'toast-1'), null, 'claimed only once');

    const second = await ctx.service.prove(SITE, click('c2'));
    await ctx.service.redeemResult(SITE, { spendId: second.spendId, ok: false, status: 401, error: 'fuse-required', reason: 'replay', toast: 't2' });
    assert.equal(await ctx.service.takeToast(SITE, 't2'), null, 'no toast for a refused proof');
    assert.equal((await ctx.service.status()).history[0].outcome, 'replay');
  });

  test('a ban sticks to the site; an always site that banned us is asked about', async () => {
    const { spendId } = await ctx.service.prove(SITE, click('c1', { remember: 'always' }));
    await ctx.service.redeemResult(SITE, { spendId, ok: false, status: 403, error: 'banned' });
    ctx.clock.now += AUTO_SPEND_COOLDOWN_MS + 1000;
    const state = await ctx.service.challengeState(SITE);
    assert.deepEqual([state.action, state.reason], ['ask', 'banned']);
    assert.ok((await ctx.service.status()).sites[0].bannedAt);
  });

  test('"credential-burned" from a site is believed only if the registry agrees', async () => {
    const first = await ctx.service.prove(SITE, click('c1'));
    const lie = await ctx.service.redeemResult(SITE, { spendId: first.spendId, ok: false, status: 403, error: 'credential-burned' });
    assert.equal(lie.burned, false);
    assert.equal((await ctx.service.status()).credential.status, 'active');

    const second = await ctx.service.prove(SITE, click('c2'));
    ctx.registry.burn(0);
    const truth = await ctx.service.redeemResult(SITE, { spendId: second.spendId, ok: false, status: 403, error: 'credential-burned' });
    assert.equal(truth.burned, true);
    assert.equal((await ctx.service.status()).credential.status, 'burned');
  });
});
