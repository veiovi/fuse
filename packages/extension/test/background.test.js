// The real background.js, driven through a fake chrome, with a real Groth16
// proof standing in for the offscreen document.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createFuseAuthorization, parseFuseHeader, pseudonymFor, shortPseudonym, verifyFuseToken } from '@fuse/core';
import { loadVerificationKey, nodeArtifacts, releaseProver } from '@fuse/core/node';
import { createFakeChrome, createFakeRegistry, senders } from './fakes.js';

const SITE = 'http://forum.localhost:4710';
const registry = createFakeRegistry({ tiers: [{ id: 'starter', deposit: 5, limit: 10 }] });
const offscreenMessages = [];
const chrome = createFakeChrome({
  // What offscreen.js does, with the Node artifacts.
  async offscreen(message, sender) {
    offscreenMessages.push({ type: message.type, sender });
    if (message.type === 'warm') return { ok: true, result: { warmed: true } };
    const { authorization, pseudonym, nullifier, provingMs } = await createFuseAuthorization({ ...message.request, artifacts: nodeArtifacts });
    return { ok: true, result: { authorization, pseudonym, nullifier, provingMs } };
  },
});
const realFetch = globalThis.fetch;
const send = (message, sender) => chrome.dispatch({ target: 'background', ...message }, sender);

before(async () => {
  globalThis.chrome = chrome;
  globalThis.fetch = (url, init) => registry.fetch(url, init);
  await import('../src/background.js');
});

after(async () => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
  await releaseProver();
});

test('restricts chrome.storage.local to extension pages and the service worker at startup', () => {
  assert.equal(chrome.storage.local.accessLevel, 'TRUSTED_CONTEXTS');
});

test('ignores messages addressed to other contexts', async () => {
  assert.equal(await chrome.dispatch({ target: 'offscreen', type: 'prove' }, senders.popup), undefined);
  assert.equal(await chrome.dispatch({ type: 'status' }, senders.popup), undefined);
});

test('register from the popup, then answer a challenge from a page with a real proof', async () => {
  const registered = await send({ type: 'register', registry: registry.url, tier: 'starter' }, senders.popup);
  assert.equal(registered.ok, true, JSON.stringify(registered.error));
  assert.equal(registered.data.budget.remaining, 10);

  const page = senders.content(SITE);
  const state = await send({ type: 'challenge-state' }, page);
  assert.equal(state.data.action, 'ask');

  // Not clicked, not always-allowed: nothing is spent.
  const unasked = await send({ type: 'prove', challenge: 'challenge-0' }, page);
  assert.equal(unasked.error.code, 'needs-consent');

  // The person clicked Allow. The page also claims to be someone else: the claim is ignored.
  const proved = await send({ type: 'prove', challenge: 'challenge-1', trigger: 'click', origin: 'https://bank.test' }, page);
  assert.equal(proved.ok, true, JSON.stringify(proved.error));
  const { authorization, slot, remaining, provingMs, short } = proved.data;
  assert.deepEqual([slot, remaining], [0, 9]);
  assert.ok(provingMs > 0);

  const header = parseFuseHeader(authorization);
  assert.equal(header.origin, SITE);
  const vkey = loadVerificationKey();
  const verified = await verifyFuseToken({ token: header.token, challenge: 'challenge-1', origin: SITE, vkey });
  assert.equal(verified.ok, true);
  const elsewhere = await verifyFuseToken({ token: header.token, challenge: 'challenge-1', origin: 'https://bank.test', vkey });
  assert.equal(elsewhere.ok, false);

  const secret = chrome.storage.local.peek('wallet').secret;
  assert.equal(verified.signals.pseudonym, pseudonymFor(secret, SITE));
  assert.equal(short, shortPseudonym(verified.signals.pseudonym));

  // The prover ran in an offscreen document created for WORKERS, driven by the service worker.
  assert.deepEqual(chrome.offscreen.createdWith.map((o) => [o.url, o.reasons]), [['offscreen.html', ['WORKERS']]]);
  assert.ok(offscreenMessages.some((m) => m.type === 'prove'));

  // Before reserving, the worker asked that very document whether it still exists.
  assert.deepEqual(chrome.tabs.pings.at(-1), { tabId: 7, message: { target: 'content', type: 'alive' }, options: { documentId: 'doc-1' } });

  const status = await send({ type: 'status' }, senders.popup);
  assert.deepEqual(status.data.sites.map((s) => [s.origin, s.short, s.spends]), [[SITE, short, 1]]);
  assert.deepEqual(status.data.history.map((h) => [h.origin, h.slot, h.outcome]), [[SITE, 0, 'proved']]);
  assert.ok(!JSON.stringify(status).includes(secret.slice(2)), 'the popup never receives the secret');
});

test('a proof requested by a document that has since gone away is not made', async () => {
  chrome.goneDocuments.add('doc-reloaded');
  const before = (await send({ type: 'status' }, senders.popup)).data.budget.used;
  const answer = await send({ type: 'prove', challenge: 'challenge-2', trigger: 'click' }, senders.content(SITE, '/members', 'doc-reloaded'));
  assert.equal(answer.error.code, 'page-gone');
  assert.equal((await send({ type: 'status' }, senders.popup)).data.budget.used, before);
});
