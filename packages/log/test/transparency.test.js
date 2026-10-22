import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  EMPTY_ROOT_HASH,
  MerkleLog,
  canonicalJson,
  entryLeafHash,
  exportPublicKey,
  leafHash,
  signTreeHead,
  verifyInclusion,
  verifySignedTreeHead,
} from '../src/index.js';

// Test vectors from the Certificate Transparency reference implementation.
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];
const CT_PATHS = [
  {
    seq: 0,
    treeSize: 8,
    auditPath: [
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ],
  },
  {
    seq: 5,
    treeSize: 8,
    auditPath: [
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ],
  },
  { seq: 2, treeSize: 3, auditPath: ['fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125'] },
];

// RFC 6962 §2.1 definitions, written as directly as possible, as an oracle.
const sha = (...parts) => {
  const h = createHash('sha256');
  parts.forEach((p) => h.update(p));
  return h.digest();
};
const split = (n) => 2 ** Math.ceil(Math.log2(n) - 1);
function mth(leaves) {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return sha(Buffer.from([0]), leaves[0]);
  const k = split(leaves.length);
  return sha(Buffer.from([1]), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}
function path(m, leaves) {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...path(m, leaves.slice(0, k)), mth(leaves.slice(k))]
    : [...path(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}

describe('RFC 6962 Merkle tree', () => {
  const ct = new MerkleLog();
  CT_LEAVES.forEach((hex) => ct.append(leafHash(Buffer.from(hex, 'hex'))));

  test('matches the Certificate Transparency root vectors', () => {
    assert.equal(new MerkleLog().rootHash(), EMPTY_ROOT_HASH);
    CT_ROOTS.forEach((root, i) => assert.equal(ct.rootHash(i + 1), root, `tree size ${i + 1}`));
  });

  test('matches the Certificate Transparency audit path vectors', () => {
    for (const vector of CT_PATHS) {
      assert.deepEqual(ct.auditPath(vector.seq, vector.treeSize), vector.auditPath);
      const proof = {
        ...vector,
        leafHash: ct.leafHash(vector.seq).toString('hex'),
        rootHash: CT_ROOTS[vector.treeSize - 1],
      };
      assert.equal(verifyInclusion(proof), true);
    }
  });

  test('incremental roots and audit paths equal the RFC definitions for every size and leaf', () => {
    const data = Array.from({ length: 40 }, (_, i) => Buffer.from(`entry-${i}`));
    const tree = new MerkleLog();
    data.forEach((d) => tree.append(leafHash(d)));
    for (let n = 1; n <= data.length; n++) {
      const prefix = data.slice(0, n);
      assert.equal(tree.rootHash(n), mth(prefix).toString('hex'), `root of ${n}`);
      for (let m = 0; m < n; m++) {
        const auditPath = tree.auditPath(m, n);
        assert.deepEqual(auditPath, path(m, prefix).map((h) => h.toString('hex')), `path ${m}/${n}`);
        const proof = { seq: m, treeSize: n, leafHash: leafHash(data[m]).toString('hex'), auditPath, rootHash: tree.rootHash(n) };
        assert.equal(verifyInclusion(proof), true, `verify ${m}/${n}`);
      }
    }
  });

  test('inclusion proofs fail when any part is wrong', () => {
    const tree = new MerkleLog();
    for (let i = 0; i < 13; i++) tree.append(leafHash(`leaf ${i}`));
    const good = { seq: 6, treeSize: 13, leafHash: tree.leafHash(6).toString('hex'), auditPath: tree.auditPath(6, 13), rootHash: tree.rootHash(13) };
    assert.equal(verifyInclusion(good), true);
    const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    // Tree sizes whose path has the same shape (12, 14 here) also pass: the
    // signed tree head, not the audit path, authenticates the size.
    const bad = [
      { ...good, seq: 7 },
      { ...good, seq: 13 },
      { ...good, seq: -1 },
      { ...good, treeSize: 7 },
      { ...good, treeSize: 100 },
      { ...good, leafHash: tree.leafHash(5).toString('hex') },
      { ...good, rootHash: flip(good.rootHash) },
      { ...good, auditPath: good.auditPath.slice(0, -1) },
      { ...good, auditPath: [...good.auditPath, good.rootHash] },
      { ...good, auditPath: [flip(good.auditPath[0]), ...good.auditPath.slice(1)] },
      { ...good, auditPath: 'nope' },
      { ...good, leafHash: 'xyz' },
    ];
    bad.forEach((proof, i) => assert.equal(verifyInclusion(proof), false, `case ${i}`));
  });

  test('rejects tree sizes and leaves outside the log', () => {
    const tree = new MerkleLog();
    tree.append(leafHash('a'));
    assert.throws(() => tree.rootHash(2), RangeError);
    assert.throws(() => tree.auditPath(1, 1), RangeError);
    assert.deepEqual(tree.auditPath(0, 1), []);
  });
});

describe('entry hashing', () => {
  test('canonical JSON sorts keys at every level and skips undefined', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' }, u: undefined }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    const entry = { seq: 3, epoch: 20000, nullifier: '0x01', x: '0x02', y: '0x03', at: '2026-01-01T00:00:00.000Z' };
    const shuffled = { y: '0x03', at: entry.at, x: '0x02', seq: 3, nullifier: '0x01', epoch: 20000 };
    assert.equal(entryLeafHash(entry), entryLeafHash(shuffled));
    assert.equal(entryLeafHash(entry), leafHash(canonicalJson(entry)).toString('hex'));
  });
});

describe('signed tree heads', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = exportPublicKey(privateKey);
  const sth = signTreeHead({ treeSize: 5, rootHash: 'ab'.repeat(32), timestamp: '2026-10-22T00:00:00.000Z' }, privateKey);

  test('verify against the base64 SPKI public key', () => {
    assert.equal(Buffer.from(publicKey, 'base64').length, 44);
    assert.equal(Buffer.from(sth.signature, 'base64').length, 64);
    assert.equal(verifySignedTreeHead(sth, publicKey), true);
  });

  test('fail when a field, the key or the signature is wrong', () => {
    const other = exportPublicKey(generateKeyPairSync('ed25519').privateKey);
    assert.equal(verifySignedTreeHead({ ...sth, treeSize: 6 }, publicKey), false);
    assert.equal(verifySignedTreeHead({ ...sth, rootHash: 'cd'.repeat(32) }, publicKey), false);
    assert.equal(verifySignedTreeHead({ ...sth, timestamp: '2026-10-22T00:00:00.001Z' }, publicKey), false);
    assert.equal(verifySignedTreeHead({ ...sth, signature: 'AAAA' }, publicKey), false);
    assert.equal(verifySignedTreeHead(sth, other), false);
    assert.equal(verifySignedTreeHead(sth, 'not a key'), false);
    assert.equal(verifySignedTreeHead({ ...sth, signature: undefined }, publicKey), false);
  });
});
