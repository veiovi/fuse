// Registry state: the member list, the Poseidon membership tree rebuilt from
// it, and the window of roots that proofs may be made against. Every mutation
// is synchronous and persisted before it returns, so concurrent requests never
// see or save a half-applied change.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_MODULUS,
  MAX_LIMIT,
  MerkleTree,
  NETWORK,
  TREE_DEPTH,
  identityCommitment,
  rateCommitment,
  toField,
  toHex,
} from '@fuse/core';
import { readJsonFile, writeJsonAtomic } from './files.js';

/** Demo tiers: a simulated deposit (in demo credits) buys a daily slot limit. */
export const DEFAULT_TIERS = Object.freeze([
  Object.freeze({ id: 'starter', deposit: 5, limit: 10 }),
  Object.freeze({ id: 'pro', deposit: 50, limit: 200 }),
  Object.freeze({ id: 'fleet', deposit: 500, limit: 2000 }),
]);

export const CURRENCY = 'demo credits';

/** Recent roots that stay valid while members only join (newest first). */
export const MAX_VALID_ROOTS = 64;

const STATE_VERSION = 1;

/** A refused request: `status` is the HTTP status, `code` a stable error id. */
export class RegistryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.code = code;
  }
}

export class Registry {
  #byCommitment = new Map();
  #treeView = null;

  /**
   * @param {object} [options]
   * @param {string} [options.dataDir] directory for registry.json; omit to keep state in memory
   * @param {{id: string, deposit: number, limit: number}[]} [options.tiers]
   * @param {number} [options.capacity] maximum number of members (default 2^TREE_DEPTH)
   * @param {string} [options.name]
   */
  constructor({ dataDir, tiers = DEFAULT_TIERS, capacity = 2 ** TREE_DEPTH, name = 'Fuse Demo Registry' } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2 ** TREE_DEPTH) {
      throw new RangeError(`capacity must be an integer in [1, 2^${TREE_DEPTH}]`);
    }
    this.name = name;
    this.tiers = validateTiers(tiers);
    this.capacity = capacity;
    this.file = dataDir ? join(dataDir, 'registry.json') : null;
    /** Called as onEvent(type, data) after each membership change. */
    this.onEvent = null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.#load();
  }

  get root() {
    return toHex(this.tree.root);
  }

  /** GET /info */
  info() {
    const counts = { active: 0, burned: 0, withdrawn: 0 };
    let lockedDeposits = 0;
    let slashedDeposits = 0;
    for (const m of this.members) {
      counts[m.status]++;
      if (m.status === 'active') lockedDeposits += m.deposit.amount;
      if (m.status === 'burned') slashedDeposits += m.deposit.amount;
    }
    return {
      name: this.name,
      backing: 'deposit',
      network: NETWORK,
      depth: TREE_DEPTH,
      currency: CURRENCY,
      tiers: this.tiers.map((t) => ({ ...t })),
      size: this.members.length,
      ...counts,
      root: this.root,
      lockedDeposits,
      slashedDeposits,
    };
  }

  /** GET /tree: every leaf, so clients can build their Merkle path without revealing their index. */
  treeView() {
    this.#treeView ??= {
      depth: TREE_DEPTH,
      size: this.members.length,
      root: this.root,
      leaves: this.tree.leaves().map(toHex),
    };
    return this.#treeView;
  }

  /** GET /roots */
  rootsView() {
    return { current: this.root, valid: [...this.validRoots] };
  }

  /** GET /members */
  membersView() {
    return { members: this.members.map(publicMember) };
  }

  /** POST /deposits: lock a (simulated) deposit and add the commitment's leaf to the tree. */
  deposit({ commitment, tier } = {}) {
    const value = parseCommitment(commitment);
    const plan = this.tiers.find((t) => t.id === tier);
    if (!plan) {
      throw new RegistryError(400, 'unknown-tier', `tier must be one of: ${this.tiers.map((t) => t.id).join(', ')}`);
    }
    const hex = toHex(value);
    const { active, burned } = this.#lookup(hex);
    if (active) throw new RegistryError(409, 'already-registered', `commitment is already registered at index ${active.index}`);
    if (burned) throw new RegistryError(409, 'commitment-burned', 'commitment was burned; its secret key is public');
    if (this.members.length >= this.capacity) throw new RegistryError(507, 'registry-full', 'registry tree is full');

    const leaf = rateCommitment(value, plan.limit);
    const member = {
      index: this.members.length,
      commitment: hex,
      tier: plan.id,
      limit: plan.limit,
      status: 'active',
      joinedAt: new Date().toISOString(),
      deposit: {
        id: `dep_${randomBytes(8).toString('hex')}`,
        amount: plan.deposit,
        currency: CURRENCY,
        status: 'locked',
      },
    };
    this.#commit(() => {
      this.members.push(member);
      this.#index(member);
      this.tree.insert(leaf);
      this.validRoots = [this.root, ...this.validRoots].slice(0, MAX_VALID_ROOTS);
    });
    this.#emit('member-joined', { member: publicMember(member), root: this.root, size: this.members.length });
    return {
      index: member.index,
      leaf: toHex(leaf),
      limit: plan.limit,
      tier: plan.id,
      root: this.root,
      deposit: { ...member.deposit },
    };
  }

  /**
   * POST /slash: whoever knows a member's secret key proves it leaked, so the
   * deposit is forfeited and the leaf zeroed. Idempotent for burned members.
   */
  slash({ secret, evidence } = {}) {
    const commitment = toHex(identityCommitment(parseSecret(secret)));
    const { active, burned } = this.#lookup(commitment);
    if (active) {
      this.#commit(() => {
        this.#remove(active, 'burned', 'slashed');
        active.evidence = evidence ?? null;
      });
      const slashed = amountOf(active);
      this.#emit('member-slashed', { member: publicMember(active), root: this.root, slashed });
      return { index: active.index, commitment, root: this.root, slashed };
    }
    if (burned) {
      return { index: burned.index, commitment, root: this.root, slashed: amountOf(burned), alreadyBurned: true };
    }
    throw new RegistryError(404, 'unknown-key', 'no active or burned member has that key');
  }

  /** POST /withdraw: prototype exit that refunds the deposit; reveals the key to the registry. */
  withdraw({ secret } = {}) {
    const commitment = toHex(identityCommitment(parseSecret(secret)));
    const { active, burned, withdrawn } = this.#lookup(commitment);
    if (!active) {
      if (burned) throw new RegistryError(409, 'credential-burned', 'the deposit behind this key was slashed');
      if (withdrawn) throw new RegistryError(409, 'already-withdrawn', 'this credential was already withdrawn');
      throw new RegistryError(404, 'unknown-key', 'no member has that key');
    }
    this.#commit(() => this.#remove(active, 'withdrawn', 'refunded'));
    const refunded = amountOf(active);
    this.#emit('member-withdrawn', { member: publicMember(active), root: this.root, refunded });
    return { index: active.index, commitment, root: this.root, refunded };
  }

  // Zero the leaf and restart the valid-root window: older roots still commit
  // to the removed leaf, so proofs against them must stop verifying.
  #remove(member, status, depositStatus) {
    this.tree.update(member.index, 0n);
    member.status = status;
    member.endedAt = new Date().toISOString();
    member.deposit.status = depositStatus;
    this.validRoots = [this.root];
  }

  #lookup(commitment) {
    const found = { active: null, burned: null, withdrawn: null };
    for (const m of this.#byCommitment.get(commitment) ?? []) found[m.status] ??= m;
    return found;
  }

  #index(member) {
    const list = this.#byCommitment.get(member.commitment);
    if (list) list.push(member);
    else this.#byCommitment.set(member.commitment, [member]);
  }

  // Apply a change in memory, then persist it. If the write fails, reload the
  // last good state from disk so memory never runs ahead of what was saved.
  #commit(apply) {
    apply();
    this.#treeView = null;
    if (!this.file) return;
    try {
      writeJsonAtomic(this.file, {
        version: STATE_VERSION,
        members: this.members.map(publicMember),
        validRoots: this.validRoots,
      });
    } catch (err) {
      this.#load();
      console.error(`fuse-registry: could not save ${this.file}: ${err.message}`);
      throw new RegistryError(503, 'storage-unavailable', 'could not save registry state; nothing changed');
    }
  }

  #load() {
    const state = this.file ? readJsonFile(this.file) : null;
    if (state && state.version !== STATE_VERSION) throw new Error(`unsupported registry state version ${state.version}`);
    this.members = (state?.members ?? []).map((m, i) => {
      if (m.index !== i) throw new Error(`corrupt registry state: member ${i} has index ${m.index}`);
      return structuredClone(m);
    });
    this.tree = MerkleTree.fromLeaves(this.members.map(leafOf));
    const saved = Array.isArray(state?.validRoots) ? state.validRoots : [];
    // Saved roots (newest first) are only trusted if they start at the rebuilt tree's root.
    this.validRoots = saved[0] === this.root ? saved.slice(0, MAX_VALID_ROOTS) : [this.root];
    this.#byCommitment.clear();
    this.members.forEach((m) => this.#index(m));
    this.#treeView = null;
  }

  #emit(type, data) {
    try {
      this.onEvent?.(type, data);
    } catch (err) {
      console.error(`fuse-registry: event subscriber failed: ${err.message}`);
    }
  }
}

function leafOf(member) {
  return member.status === 'active' ? rateCommitment(toField(member.commitment), member.limit) : 0n;
}

function amountOf(member) {
  return { amount: member.deposit.amount, currency: member.deposit.currency };
}

// Fixed key order, whatever order the fields were set in.
function publicMember({ index, commitment, tier, limit, status, joinedAt, endedAt, deposit, evidence }) {
  return {
    index,
    commitment,
    tier,
    limit,
    status,
    joinedAt,
    ...(endedAt && { endedAt }),
    deposit: { ...deposit },
    ...(evidence !== undefined && { evidence: structuredClone(evidence) }),
  };
}

function parseCommitment(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new RegistryError(400, 'bad-commitment', 'commitment must be a 0x-prefixed hex field element');
  }
  const v = BigInt(value);
  if (v === 0n || v >= FIELD_MODULUS) {
    throw new RegistryError(400, 'bad-commitment', 'commitment must be a nonzero element of the BN254 scalar field');
  }
  return v;
}

function parseSecret(value) {
  try {
    return toField(value);
  } catch {
    throw new RegistryError(400, 'bad-secret', 'secret must be a field element (0x-hex)');
  }
}

function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new TypeError('tiers must be a non-empty array');
  const seen = new Set();
  return tiers.map(({ id, deposit, limit }) => {
    if (typeof id !== 'string' || !id || seen.has(id)) throw new TypeError(`tier ids must be unique strings: ${id}`);
    if (typeof deposit !== 'number' || !Number.isFinite(deposit) || deposit < 0) {
      throw new TypeError(`tier ${id}: deposit must be a non-negative number`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TypeError(`tier ${id}: limit must be an integer in [1, ${MAX_LIMIT}]`);
    }
    seen.add(id);
    return Object.freeze({ id, deposit, limit });
  });
}
