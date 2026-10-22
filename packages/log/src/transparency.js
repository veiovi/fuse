// Certificate-Transparency-style auditability for the shared log: an RFC 6962
// Merkle tree over the entries, inclusion (audit path) proofs, and Ed25519
// signed tree heads. The verify helpers are what an auditor runs.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** MTH of the empty tree: SHA-256 of the empty string (hex). */
export const EMPTY_ROOT_HASH = sha256().toString('hex');

/**
 * Canonical JSON: object keys sorted, no whitespace. An entry's leaf data is
 * the UTF-8 of its canonical JSON, so auditors can recompute leaf hashes from
 * GET /entries output whatever key order their JSON parser keeps.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** RFC 6962 leaf hash: SHA-256(0x00 ‖ data). Returns a Buffer. */
export function leafHash(data) {
  return sha256(LEAF_PREFIX, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
}

/** RFC 6962 interior node hash: SHA-256(0x01 ‖ left ‖ right). Returns a Buffer. */
export function nodeHash(left, right) {
  return sha256(NODE_PREFIX, left, right);
}

/** Leaf hash (hex) of a log entry as served by GET /entries. */
export function entryLeafHash(entry) {
  return leafHash(canonicalJson(entry)).toString('hex');
}

/** Largest power of two strictly below n (n >= 2). */
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Append-only RFC 6962 Merkle tree. It keeps every complete perfect subtree
 * (levels[h][i] covers leaves [i·2^h, (i+1)·2^h)), so appends cost O(log n)
 * and any root or audit path for any tree size costs O(log² n).
 */
export class MerkleLog {
  constructor() {
    this.levels = [[]];
  }

  get size() {
    return this.levels[0].length;
  }

  /** Append a leaf hash (Buffer). */
  append(hash) {
    this.levels[0].push(hash);
    let level = 0;
    let index = this.levels[0].length - 1;
    // A right child completes its parent: hash upwards like a binary counter carry.
    while (index % 2 === 1) {
      const parent = nodeHash(this.levels[level][index - 1], this.levels[level][index]);
      level += 1;
      index = (index - 1) / 2;
      (this.levels[level] ??= []).push(parent);
    }
  }

  leafHash(index) {
    return this.levels[0][index];
  }

  /** MTH(D[start : start + count]) per RFC 6962 §2.1. */
  #subtreeHash(start, count) {
    if (count === 1) return this.levels[0][start];
    if ((count & (count - 1)) === 0 && start % count === 0) {
      const level = Math.log2(count);
      const stored = this.levels[level]?.[start / count];
      if (stored) return stored;
    }
    const k = splitPoint(count);
    return nodeHash(this.#subtreeHash(start, k), this.#subtreeHash(start + k, count - k));
  }

  /** Root hash (hex) of the first treeSize leaves. */
  rootHash(treeSize = this.size) {
    checkSize(treeSize, this.size);
    return treeSize === 0 ? EMPTY_ROOT_HASH : this.#subtreeHash(0, treeSize).toString('hex');
  }

  /** RFC 6962 §2.1.1 audit path (hex, leaf level first) for leaf `index` in a tree of treeSize leaves. */
  auditPath(index, treeSize = this.size) {
    checkSize(treeSize, this.size);
    if (!Number.isInteger(index) || index < 0 || index >= treeSize) {
      throw new RangeError(`leaf ${index} is not in a tree of size ${treeSize}`);
    }
    const path = [];
    const walk = (m, start, count) => {
      if (count <= 1) return;
      const k = splitPoint(count);
      if (m < k) {
        walk(m, start, k);
        path.push(this.#subtreeHash(start + k, count - k));
      } else {
        walk(m - k, start + k, count - k);
        path.push(this.#subtreeHash(start, k));
      }
    };
    walk(index, 0, treeSize);
    return path.map((h) => h.toString('hex'));
  }
}

function checkSize(treeSize, size) {
  if (!Number.isInteger(treeSize) || treeSize < 0 || treeSize > size) {
    throw new RangeError(`tree size ${treeSize} is outside [0, ${size}]`);
  }
}

/**
 * Check an RFC 6962 inclusion proof (RFC 9162 §2.1.3.2 algorithm).
 * `seq` is the entry's 0-based position (= leaf index). Pass a leafHash you
 * computed yourself (entryLeafHash) and a rootHash from a signed tree head
 * you verified, not values copied from the same response.
 *
 * @param {{ seq: number, treeSize: number, leafHash: string, auditPath: string[], rootHash: string }} proof
 * @returns {boolean}
 */
export function verifyInclusion({ seq, treeSize, leafHash: leaf, auditPath, rootHash }) {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(treeSize) || seq < 0 || seq >= treeSize) return false;
  if (!Array.isArray(auditPath) || !isHash(leaf) || !isHash(rootHash) || !auditPath.every(isHash)) return false;
  let fn = seq;
  let sn = treeSize - 1;
  let r = Buffer.from(leaf, 'hex');
  for (const hex of auditPath) {
    if (sn === 0) return false;
    const p = Buffer.from(hex, 'hex');
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.toString('hex') === rootHash.toLowerCase();
}

const isHash = (h) => typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h);

// ---------------------------------------------------------------------------
// Signed tree heads

/** The exact bytes (as a string) an STH signature covers. */
export function sthMessage({ treeSize, rootHash, timestamp }) {
  return `fuse-log-sth:v1:${treeSize}:${rootHash}:${timestamp}`;
}

/** Sign { treeSize, rootHash, timestamp } with an Ed25519 private KeyObject; signature is base64. */
export function signTreeHead({ treeSize, rootHash, timestamp }, privateKey) {
  const signature = sign(null, Buffer.from(sthMessage({ treeSize, rootHash, timestamp })), privateKey);
  return { treeSize, rootHash, timestamp, signature: signature.toString('base64') };
}

/** Base64 SPKI DER encoding of a public (or private) Ed25519 key, as in GET /info. */
export function exportPublicKey(key) {
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Check a signed tree head (or a fresh entry's receipt, which carries the same
 * fields) against the log's public key: base64 SPKI DER (GET /info) or a KeyObject.
 */
export function verifySignedTreeHead(sth, publicKey) {
  try {
    const key =
      typeof publicKey === 'string'
        ? createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
        : publicKey;
    if (key.asymmetricKeyType !== 'ed25519' || typeof sth?.signature !== 'string') return false;
    return verify(null, Buffer.from(sthMessage(sth)), key, Buffer.from(sth.signature, 'base64'));
  } catch {
    return false;
  }
}
