import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createFuseAuthorization,
  createIdentity,
  decodeToken,
  epochAt,
  pseudonymFor,
  rateCommitment,
  recoverSecret,
  siteIdFor,
  toHex,
  xFor,
} from '@fuse/core';
import { nodeArtifacts, releaseProver } from '@fuse/core/node';
import { startRegistry } from '@fuse/registry';
import { entryLeafHash, startLog, verifyInclusion, verifySignedTreeHead } from '../src/index.js';
import { client, events } from './helpers.js';

after(releaseProver);

const SITE_A = 'http://localhost:4710';
const SITE_B = 'http://localhost:4720';
const SITE_C = 'http://localhost:4730';
const isoDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

/** Deposit a fresh identity at the registry behind client `reg`. */
async function enroll(reg, tier = 'starter') {
  const identity = createIdentity();
  const res = await reg.post('/deposits', { commitment: toHex(identity.commitment), tier });
  assert.equal(res.status, 201);
  return { ...identity, index: res.body.index, limit: res.body.limit };
}

/** A gateway's POST /entries body for one real proof (leaves default to the registry's current tree). */
async function submission(reg, member, { origin = SITE_A, challenge, slot = 0, epoch = epochAt(), leaves } = {}) {
  leaves ??= (await reg.get('/tree')).body.leaves;
  const auth = await createFuseAuthorization({
    secret: member.secret,
    limit: member.limit,
    index: member.index,
    leaves,
    origin,
    challenge,
    epoch,
    slot,
    artifacts: nodeArtifacts,
  });
  const body = { token: auth.token, x: toHex(xFor(origin, challenge)), siteId: toHex(siteIdFor(origin)) };
  return { body, auth, y: toHex(decodeToken(auth.token).outputs.y), leaves };
}

describe('shared log', () => {
  let dataDir;
  let registry;
  let log;
  let reg;
  let api;
  let stream;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'fuse-log-test-'));
    registry = await startRegistry({ port: 0 });
    log = await startLog({ port: 0, dataDir, registries: [registry.url] });
    reg = client(registry.url);
    api = client(log.url);
    stream = events(`${log.url}/events`);
  });

  after(async () => {
    stream?.close();
    await log?.close();
    await registry?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  let alice;
  let first;
  let firstEntry;
  let firstReceipt;
  let carolShare;

  test('the event stream opens with a snapshot', async () => {
    const hello = await stream.next('hello');
    const info = (await api.get('/info')).body;
    assert.ok(isoDate(hello.at));
    assert.deepEqual(
      [hello.network, hello.epochSeconds, hello.size, hello.revocations, hello.publicKey],
      ['fuse-demo-v1', 86400, 0, 0, info.publicKey],
    );
    assert.equal(hello.sth.treeSize, 0);
  });

  test('a first use of a slot is logged as fresh, with a signed receipt', async () => {
    alice = await enroll(reg);
    first = await submission(reg, alice, { challenge: 'challenge-1' });
    const res = await api.post('/entries', first.body);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'fresh');
    firstEntry = res.body.entry;
    assert.deepEqual(
      { ...firstEntry, at: undefined },
      { seq: 0, epoch: epochAt(), nullifier: first.auth.nullifier, x: first.body.x, y: first.y, at: undefined },
    );
    assert.ok(isoDate(firstEntry.at));

    firstReceipt = res.body.receipt;
    const { publicKey } = (await api.get('/info')).body;
    assert.deepEqual([firstReceipt.seq, firstReceipt.treeSize], [0, 1]);
    assert.equal(firstReceipt.rootHash, entryLeafHash(firstEntry), 'a one-leaf tree root is the leaf hash');
    assert.equal(verifySignedTreeHead(firstReceipt, publicKey), true);

    assert.deepEqual((await api.get('/entries')).body, { size: 1, entries: [firstEntry] });
    const event = await stream.next('entry');
    assert.deepEqual(event.entry, firstEntry);
    assert.equal(event.sth.treeSize, 1);
  });

  test('the same share again is a replay', async () => {
    const res = await api.post('/entries', first.body);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { status: 'replay', entry: firstEntry });
    assert.equal((await api.get('/entries')).body.size, 1);
    assert.deepEqual((await stream.next('replay')).entry, firstEntry);
  });

  test('reusing the slot at another site reveals the key and burns the credential', async () => {
    const second = await submission(reg, alice, { origin: SITE_B, challenge: 'challenge-2', leaves: first.leaves });
    assert.equal(second.auth.nullifier, first.auth.nullifier, 'same slot, same tag');
    const res = await api.post('/entries', second.body);
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'double-spend');

    const { revocation } = res.body;
    assert.equal(revocation.secret, toHex(alice.secret), 'recovered exactly the secret');
    assert.equal(revocation.commitment, toHex(alice.commitment));
    assert.match(revocation.id, /^[0-9a-f-]{36}$/);
    assert.ok(isoDate(revocation.at));
    assert.deepEqual([revocation.epoch, revocation.nullifier], [firstEntry.epoch, firstEntry.nullifier]);
    assert.deepEqual(revocation.shares, [
      { x: first.body.x, y: first.y, seq: 0 },
      { x: second.body.x, y: second.y, seq: 1 },
    ]);
    assert.deepEqual(revocation.registry, {
      url: registry.url,
      index: alice.index,
      slashed: { amount: 5, currency: 'demo credits' },
    });

    // Anyone can check the confession and compute the cheater's pseudonym at their site.
    assert.equal(toHex(recoverSecret(revocation.shares[0], revocation.shares[1])), revocation.secret);
    assert.equal(toHex(pseudonymFor(revocation.secret, SITE_A)), first.auth.pseudonym);

    const member = (await reg.get('/members')).body.members[alice.index];
    assert.deepEqual([member.status, member.deposit.status], ['burned', 'slashed']);
    assert.deepEqual(member.evidence.shares, revocation.shares);
    assert.ok(!(await reg.get('/roots')).body.valid.includes(first.auth.root), 'old roots are no longer valid');

    assert.deepEqual((await api.get('/revocations')).body, { revocations: [revocation] });
    const evidence = (await api.get('/entries')).body.entries[1];
    assert.deepEqual({ ...evidence, at: undefined }, {
      seq: 1,
      epoch: firstEntry.epoch,
      nullifier: firstEntry.nullifier,
      x: second.body.x,
      y: second.y,
      at: undefined,
      revocation: revocation.id,
    });
    assert.equal((await stream.next('entry')).entry.revocation, revocation.id);
    assert.deepEqual((await stream.next('double-spend')).revocation, revocation);
  });

  test('a burned credential cannot open another slot', async () => {
    // Proved against the pre-slash tree, the only tree that still contains it.
    const next = await submission(reg, alice, { origin: SITE_C, challenge: 'challenge-3', slot: 1, leaves: first.leaves });
    const res = await api.post('/entries', next.body);
    assert.deepEqual([res.status, res.body.status, res.body.reason], [400, 'invalid', 'unknown-root']);
  });

  test('a root no configured registry vouches for is rejected', async () => {
    const mallory = { ...createIdentity(), index: 0, limit: 10 };
    const privateTree = [toHex(rateCommitment(mallory.commitment, 10))];
    const { body } = await submission(reg, mallory, { challenge: 'challenge-4', leaves: privateTree });
    const res = await api.post('/entries', body);
    assert.deepEqual([res.status, res.body.status, res.body.reason], [400, 'invalid', 'unknown-root']);
  });

  test('a proof checked against other public inputs, or tampered with, is a bad proof', async () => {
    const bob = await enroll(reg, 'pro');
    const { body } = await submission(reg, bob, { challenge: 'challenge-5' });
    const otherX = await api.post('/entries', { ...body, x: toHex(xFor(SITE_A, 'another-challenge')) });
    assert.deepEqual([otherX.status, otherX.body.reason], [400, 'bad-proof']);
    const otherSite = await api.post('/entries', { ...body, siteId: toHex(siteIdFor(SITE_B)) });
    assert.deepEqual([otherSite.status, otherSite.body.reason], [400, 'bad-proof']);
    const flipped = body.token.slice(0, 40) + (body.token[40] === 'A' ? 'B' : 'A') + body.token.slice(41);
    const tampered = await api.post('/entries', { ...body, token: flipped });
    assert.equal(tampered.status, 400);
    assert.equal(tampered.body.reason, 'bad-proof');
    // Rejected submissions consume nothing: the genuine one is still fresh.
    assert.equal((await api.post('/entries', body)).status, 201);
  });

  test('a token for another epoch is rejected', async () => {
    const bob = await enroll(reg);
    const { body } = await submission(reg, bob, { challenge: 'challenge-6', epoch: epochAt() - 2 });
    const res = await api.post('/entries', body);
    assert.deepEqual([res.status, res.body.status, res.body.reason], [400, 'invalid', 'wrong-epoch']);
  });

  test('malformed submissions are rejected before any proof work', async () => {
    const x = toHex(xFor(SITE_A, 'c'));
    const siteId = toHex(siteIdFor(SITE_A));
    for (const body of [{ x, siteId }, { token: 'abc', x, siteId }, { token: 'A'.repeat(519), x, siteId }, { token: first.body.token, siteId }, { token: first.body.token, x: 'zz', siteId }]) {
      const res = await api.post('/entries', body);
      assert.deepEqual([res.status, res.body.status, res.body.reason], [400, 'invalid', 'malformed-token'], JSON.stringify(body).slice(0, 60));
    }
    const garbled = await api.post('/entries', '{"token":');
    assert.deepEqual([garbled.status, garbled.body.reason], [400, 'malformed-token']);
    const huge = await api.post('/entries', { token: 'A'.repeat(20_000), x, siteId });
    assert.equal(huge.status, 413);
  });

  test('concurrent submissions of one slot tag produce exactly one fresh entry', async () => {
    const carol = await enroll(reg, 'pro');
    carolShare = await submission(reg, carol, { challenge: 'challenge-7' });
    const same = await Promise.all([api.post('/entries', carolShare.body), api.post('/entries', carolShare.body)]);
    assert.deepEqual(same.map((r) => `${r.status} ${r.body.status}`).sort(), ['201 fresh', '409 replay']);

    const dave = await enroll(reg);
    const leaves = (await reg.get('/tree')).body.leaves;
    const [atA, atB] = await Promise.all([
      submission(reg, dave, { origin: SITE_A, challenge: 'challenge-8', leaves }),
      submission(reg, dave, { origin: SITE_B, challenge: 'challenge-9', leaves }),
    ]);
    const raced = await Promise.all([api.post('/entries', atA.body), api.post('/entries', atB.body)]);
    assert.deepEqual(raced.map((r) => `${r.status} ${r.body.status}`).sort(), ['201 fresh', '409 double-spend']);
    const { revocation } = raced.find((r) => r.status === 409).body;
    assert.equal(revocation.secret, toHex(dave.secret));
    assert.equal(revocation.registry.index, dave.index);
  });

  test('a flood of proofs over a made-up tree costs the registry one fetch a second and holds no one up', async () => {
    const mallory = { ...createIdentity(), index: 0, limit: 10 };
    const fake = await submission(reg, mallory, { challenge: 'flood', leaves: [toHex(rateCommitment(mallory.commitment, 10))] });
    const frank = await enroll(reg);
    const leaves = (await reg.get('/tree')).body.leaves;
    const opening = await submission(reg, frank, { challenge: 'flood-1', leaves });
    const during = await submission(reg, frank, { challenge: 'flood-2', slot: 1, leaves });
    assert.equal((await api.post('/entries', opening.body)).status, 201, 'the log now holds roots with frank in them');

    let rootsFetches = 0;
    const count = (req) => {
      if (req.url === '/roots') rootsFetches++;
    };
    registry.server.prependListener('request', count);
    try {
      const started = performance.now();
      let floodDone;
      const flood = Promise.all(Array.from({ length: 50 }, () => api.post('/entries', fake.body))).then((results) => {
        floodDone = performance.now();
        return results;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const honest = await api.post('/entries', during.body);
      const honestDone = performance.now();
      assert.deepEqual([honest.status, honest.body.status], [201, 'fresh']);

      const rejected = await flood;
      assert.ok(rejected.every((r) => r.status === 400 && r.body.reason === 'unknown-root'));
      assert.ok(honestDone < floodDone, 'the honest submission did not wait behind the flood');
      const seconds = Math.ceil((floodDone - started) / 1000);
      assert.ok(rootsFetches <= 1 + seconds, `${rootsFetches} registry fetches in ${seconds} s`);
    } finally {
      registry.server.off('request', count);
    }
  });

  test('the signed tree head and every inclusion proof verify', async () => {
    const { publicKey } = (await api.get('/info')).body;
    const sth = (await api.get('/sth')).body;
    assert.equal(verifySignedTreeHead(sth, publicKey), true);
    const { size, entries } = (await api.get('/entries?limit=1000')).body;
    assert.equal(sth.treeSize, size);
    assert.equal(entries.length, size);
    assert.ok(size >= 6);

    for (const entry of entries) {
      const proof = (await api.get(`/entries/${entry.seq}/proof?treeSize=${sth.treeSize}`)).body;
      assert.equal(proof.leafHash, entryLeafHash(entry));
      assert.equal(proof.rootHash, sth.rootHash);
      assert.equal(verifyInclusion({ ...proof, leafHash: entryLeafHash(entry), rootHash: sth.rootHash }), true, `entry ${entry.seq}`);
      assert.equal(verifyInclusion({ ...proof, seq: (entry.seq + 1) % size, rootHash: sth.rootHash }), false);
    }

    // The very first receipt is still provable: inclusion at the tree size it signed.
    const old = (await api.get(`/entries/0/proof?treeSize=${firstReceipt.treeSize}`)).body;
    assert.equal(verifyInclusion({ ...old, leafHash: entryLeafHash(firstEntry), rootHash: firstReceipt.rootHash }), true);

    assert.deepEqual((await api.get('/entries?after=0&limit=2')).body.entries.map((e) => e.seq), [1, 2]);
    assert.equal((await api.get(`/entries/${size}/proof`)).status, 404);
    assert.equal((await api.get('/entries/x/proof')).status, 404);
    assert.equal((await api.get('/entries/0/proof?treeSize=0')).status, 400);
    assert.equal((await api.get('/entries?after=soon')).status, 400);
  });

  test('entries, revocations and the signing key survive a restart', async () => {
    const before = await Promise.all(['/info', '/entries?limit=1000', '/revocations'].map(async (p) => (await api.get(p)).body));
    stream.close();
    await log.close();
    assert.equal(statSync(join(dataDir, 'log-key.pem')).mode & 0o777, 0o600);
    // A crash mid-append leaves an unterminated line; it was never acknowledged.
    appendFileSync(join(dataDir, 'entries.jsonl'), '{"seq":99,"epoch":');

    log = await startLog({ port: 0, dataDir, registries: [registry.url] });
    api = client(log.url);
    const after = await Promise.all(['/info', '/entries?limit=1000', '/revocations'].map(async (p) => (await api.get(p)).body));
    assert.equal(after[0].publicKey, before[0].publicKey);
    assert.deepEqual([after[0].size, after[0].revocations], [before[0].size, before[0].revocations]);
    assert.deepEqual([after[0].sth.treeSize, after[0].sth.rootHash], [before[0].sth.treeSize, before[0].sth.rootHash]);
    assert.deepEqual(after[1], before[1]);
    assert.deepEqual(after[2], before[2]);
    const lines = readFileSync(join(dataDir, 'entries.jsonl'), 'utf8');
    assert.ok(lines.endsWith('\n'));
    assert.equal(lines.trim().split('\n').length, before[0].size);

    // The slot-tag index was rebuilt: a logged share is still recognised.
    const replay = await api.post('/entries', carolShare.body);
    assert.deepEqual([replay.status, replay.body.status], [409, 'replay']);
  });
});

describe('shared log when no registry accepts the slash', () => {
  test('the revocation is still published, with registry: null', async () => {
    const registry = await startRegistry({ port: 0 });
    // Vouches for the real registry's roots but refuses every slash.
    const refusing = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/roots') {
        const upstream = await fetch(`${registry.url}/roots`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"unavailable"}');
    });
    await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    const log = await startLog({ port: 0, registries: [`http://127.0.0.1:${refusing.address().port}`] });
    try {
      const reg = client(registry.url);
      const api = client(log.url);
      const erin = await enroll(reg);
      const leaves = (await reg.get('/tree')).body.leaves;
      const atA = await submission(reg, erin, { origin: SITE_A, challenge: 'refuse-1', leaves });
      const atB = await submission(reg, erin, { origin: SITE_B, challenge: 'refuse-2', leaves });
      assert.equal((await api.post('/entries', atA.body)).status, 201);
      const res = await api.post('/entries', atB.body);
      assert.deepEqual([res.status, res.body.status], [409, 'double-spend']);
      assert.equal(res.body.revocation.secret, toHex(erin.secret));
      assert.equal(res.body.revocation.registry, null);
      assert.deepEqual((await api.get('/revocations')).body.revocations, [res.body.revocation]);
      assert.equal((await reg.get('/members')).body.members[erin.index].status, 'active');
    } finally {
      await log.close();
      await new Promise((resolve) => refusing.close(resolve));
      await registry.close();
    }
  });
});

describe('shared log while a slash is in flight', () => {
  test('a root checked before the slash is checked again before anything is appended', async () => {
    const registry = await startRegistry({ port: 0 });
    let slashArrived;
    let releaseSlash;
    const arrived = new Promise((resolve) => (slashArrived = resolve));
    const released = new Promise((resolve) => (releaseSlash = resolve));
    // Passes everything through to the registry but holds each slash until released.
    const proxy = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.url === '/slash') {
        slashArrived();
        await released;
      }
      const upstream = await fetch(`${registry.url}${req.url}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(await upstream.text());
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const log = await startLog({ port: 0, registries: [`http://127.0.0.1:${proxy.address().port}`] });
    try {
      const reg = client(registry.url);
      const api = client(log.url);
      const gina = await enroll(reg);
      const leaves = (await reg.get('/tree')).body.leaves;
      const atA = await submission(reg, gina, { origin: SITE_A, challenge: 'held-1', leaves });
      const atB = await submission(reg, gina, { origin: SITE_B, challenge: 'held-2', leaves });
      const nextSlot = await submission(reg, gina, { origin: SITE_C, challenge: 'held-3', slot: 1, leaves });
      assert.equal((await api.post('/entries', atA.body)).status, 201);

      const doubleSpend = api.post('/entries', atB.body);
      await arrived; // the double-spend now holds the queue, waiting on its slash
      const sneaky = api.post('/entries', nextSlot.body);
      await new Promise((resolve) => setTimeout(resolve, 200)); // meanwhile its proof and still-valid root pass
      releaseSlash();
      assert.equal((await doubleSpend).body.status, 'double-spend');
      const late = await sneaky;
      assert.deepEqual([late.status, late.body.status, late.body.reason], [400, 'invalid', 'unknown-root']);
    } finally {
      releaseSlash();
      await log.close();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
      await registry.close();
    }
  });
});
