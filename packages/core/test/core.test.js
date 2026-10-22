import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  MerkleTree,
  NotAMemberError,
  TOKEN_BYTES,
  acceptableEpochs,
  allocateSlot,
  createFuseAuthorization,
  createIdentity,
  createWallet,
  decodeToken,
  epochAt,
  fromHex,
  identityCommitment,
  inv,
  mul,
  parseFuseHeader,
  pseudonymFor,
  rateCommitment,
  recoverSecret,
  releaseSlot,
  remainingSlots,
  siteIdFor,
  toHex,
  verifyFuseToken,
  verifyLogSubmission,
  xFor,
  formatChallengeHeader,
} from '../src/index.js';
import { loadVerificationKey, nodeArtifacts, releaseProver } from '../src/node.js';

after(releaseProver);

describe('field and hashing', () => {
  test('inverse', () => {
    const a = 123456789n;
    assert.equal(mul(a, inv(a)), 1n);
  });

  test('site ids and x values are origin-normalized and distinct', () => {
    assert.equal(siteIdFor('https://Example.com:443/path'), siteIdFor('https://example.com'));
    assert.notEqual(siteIdFor('https://a.example'), siteIdFor('https://b.example'));
    assert.notEqual(xFor('https://a.example', 'c1'), xFor('https://a.example', 'c2'));
  });

  test('epoch window', () => {
    const day = 86400 * 1000;
    const mid = 20000 * day + day / 2;
    assert.deepEqual(acceptableEpochs(mid), [20000]);
    assert.deepEqual(acceptableEpochs(20000 * day + 10_000), [20000, 19999]);
    assert.deepEqual(acceptableEpochs(20001 * day - 10_000), [20000, 20001]);
  });

  test('header parsing', () => {
    const h = formatChallengeHeader({ challenge: 'abc.def', registry: 'http://r.example' });
    assert.deepEqual(parseFuseHeader(h), {
      challenge: 'abc.def',
      network: 'fuse-demo-v1',
      registry: 'http://r.example',
    });
    assert.equal(parseFuseHeader('Bearer xyz'), null);
  });
});

describe('merkle tree', () => {
  test('bulk build matches incremental inserts and paths verify', () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const incremental = new MerkleTree();
    leaves.forEach((l) => incremental.insert(l));
    const bulk = MerkleTree.fromLeaves(leaves);
    assert.equal(bulk.root, incremental.root);
    for (let i = 0; i < leaves.length; i++) {
      assert.equal(MerkleTree.rootFromPath(leaves[i], bulk.path(i)), bulk.root);
    }
    bulk.update(2, 0n);
    assert.notEqual(bulk.root, incremental.root);
  });
});

describe('wallet slots', () => {
  test('allocates each slot once and stops at the limit', () => {
    const w = createWallet({ secret: 5n, registry: 'r', index: 0, limit: 2, tier: 't' });
    assert.equal(allocateSlot(w, 7), 0);
    assert.equal(allocateSlot(w, 7), 1);
    assert.equal(allocateSlot(w, 7), null);
    assert.equal(remainingSlots(w, 7), 0);
    releaseSlot(w, 7, 1);
    assert.equal(allocateSlot(w, 7), 1);
    assert.equal(allocateSlot(w, 8), 0);
  });
});

describe('end-to-end proof (Groth16)', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const members = [
    { id: bob, limit: 200 },
    { id: alice, limit: 3 },
  ];
  const leaves = members.map((m) => toHex(rateCommitment(m.id.commitment, m.limit)));
  const vkey = loadVerificationKey();
  const epoch = epochAt();
  const siteA = 'https://forum.example';
  const siteB = 'https://api.example';

  const prove = (overrides) =>
    createFuseAuthorization({
      secret: alice.secret,
      limit: 3,
      index: 1,
      leaves,
      origin: siteA,
      challenge: 'challenge-1',
      epoch,
      slot: 0,
      artifacts: nodeArtifacts,
      ...overrides,
    });

  test('valid proof verifies and exposes only the site pseudonym', async () => {
    const auth = await prove();
    assert.equal(decodeToken(auth.token).epoch, epoch);
    assert.equal(auth.token.length, Math.ceil((TOKEN_BYTES * 4) / 3));
    const header = parseFuseHeader(auth.authorization);
    const result = await verifyFuseToken({ token: header.token, challenge: header.challenge, origin: siteA, vkey });
    assert.equal(result.ok, true);
    assert.equal(result.signals.pseudonym, pseudonymFor(alice.secret, siteA));
    assert.equal(
      result.signals.root,
      MerkleTree.fromLeaves(leaves.map(fromHex)).root,
    );
  });

  test('a token is bound to its origin and challenge', async () => {
    const auth = await prove();
    const wrongSite = await verifyFuseToken({ token: auth.token, challenge: 'challenge-1', origin: siteB, vkey });
    assert.deepEqual([wrongSite.ok, wrongSite.reason], [false, 'bad-proof']);
    const wrongChallenge = await verifyFuseToken({ token: auth.token, challenge: 'other', origin: siteA, vkey });
    assert.equal(wrongChallenge.ok, false);
    const log = await verifyLogSubmission({
      token: auth.token,
      x: xFor(siteA, 'challenge-1'),
      siteId: siteIdFor(siteA),
      vkey,
    });
    assert.equal(log.ok, true);
  });

  test('pseudonyms: sticky per site, unlinkable across sites; nullifiers fresh per slot', async () => {
    const a0 = await prove({ slot: 0, challenge: 'c-a0' });
    const a1 = await prove({ slot: 1, challenge: 'c-a1' });
    const b2 = await prove({ slot: 2, origin: siteB, challenge: 'c-b2' });
    assert.equal(a0.pseudonym, a1.pseudonym);
    assert.notEqual(a0.pseudonym, b2.pseudonym);
    assert.notEqual(a0.nullifier, a1.nullifier);
  });

  test('reusing a slot reveals the secret key', async () => {
    const first = await prove({ slot: 1, challenge: 'first' });
    const second = await prove({ slot: 1, origin: siteB, challenge: 'second' });
    assert.equal(first.nullifier, second.nullifier);
    const s1 = await verifyFuseToken({ token: first.token, challenge: 'first', origin: siteA, vkey });
    const s2 = await verifyFuseToken({ token: second.token, challenge: 'second', origin: siteB, vkey });
    const k = recoverSecret(s1.signals, s2.signals);
    assert.equal(k, alice.secret);
    assert.equal(identityCommitment(k), alice.commitment);
  });

  test('cannot prove a slot at or above the limit', async () => {
    await assert.rejects(prove({ slot: 3 }));
  });

  test('cannot prove for a credential that is not in the tree', async () => {
    await assert.rejects(prove({ index: 0 }), NotAMemberError);
  });
});
