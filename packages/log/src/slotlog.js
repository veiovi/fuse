// The shared slot-tag log: every gateway on the network forwards first
// contacts here, so a reused slot shows up as a second point on the same line,
// which reveals the key. Slot-tag lookups and appends run strictly one at a
// time, so two concurrent uses of one slot tag can never both be "fresh".
import { randomUUID } from 'node:crypto';
import {
  EPOCH_SECONDS,
  NETWORK,
  epochAt,
  identityCommitment,
  recoverSecret,
  toField,
  toHex,
  verifyLogSubmission,
} from '@fuse/core';
import { loadVerificationKey } from '@fuse/core/node';
import { RegistryRoots } from './roots.js';
import { appendLine, loadOrCreateSigningKey, logFiles, readJsonLines } from './store.js';
import { MerkleLog, canonicalJson, exportPublicKey, leafHash, signTreeHead } from './transparency.js';

// Stays under the 5 s a gateway waits for the log, so a slow registry still yields an answer.
const SLASH_TIMEOUT_MS = 3000;

export class SlotLog {
  #queue = Promise.resolve();
  #pending = new Set();
  #verifierLane = Promise.resolve();
  #verifierWarm = false;

  /**
   * @param {object} [options]
   * @param {string} [options.dataDir] entries.jsonl, revocations.jsonl and log-key.pem live here; omit for in-memory
   * @param {string[]} [options.registries] registry base URLs whose valid roots are accepted
   * @param {string} [options.name]
   * @param {string} [options.publicUrl] this log's URL, cited in slash evidence
   * @param {object} [options.vkey] Groth16 verification key (default: the bundled one)
   * @param {number} [options.rootsTtlMs] how long fetched registry roots are trusted
   */
  constructor({
    dataDir,
    registries = ['http://localhost:4701'],
    name = 'Fuse Shared Log',
    publicUrl = null,
    vkey = loadVerificationKey(),
    rootsTtlMs,
  } = {}) {
    if (!Array.isArray(registries) || registries.length === 0) throw new TypeError('registries must list at least one URL');
    this.name = name;
    this.publicUrl = publicUrl;
    this.registries = [...new Set(registries.map((url) => String(url).replace(/\/+$/, '')))];
    this.vkey = vkey;
    this.roots = new RegistryRoots(this.registries, { ttlMs: rootsTtlMs });
    this.files = dataDir ? logFiles(dataDir) : null;
    /** Called as onEvent(type, data) for `entry`, `replay` and `double-spend`. */
    this.onEvent = null;
    this.signingKey = loadOrCreateSigningKey(this.files?.key);
    this.publicKey = exportPublicKey(this.signingKey);
    this.entries = [];
    this.tags = new Map(); // slot tag (nullifier) → seqs of entries carrying it
    this.revocations = [];
    this.revocationByTag = new Map();
    this.merkle = new MerkleLog();
    this.#load();
    this.sth = this.#signTreeHead();
  }

  /** GET /info */
  info() {
    return {
      name: this.name,
      network: NETWORK,
      epochSeconds: EPOCH_SECONDS,
      epoch: epochAt(),
      size: this.entries.length,
      revocations: this.revocations.length,
      publicKey: this.publicKey,
      sth: this.sth,
      registries: [...this.registries],
    };
  }

  /** GET /entries: entries with seq > after (seq is 0-based), oldest first. */
  listEntries({ after = -1, limit = 100 } = {}) {
    const start = Math.max(0, after + 1);
    return { size: this.entries.length, entries: this.entries.slice(start, start + limit) };
  }

  /** GET /entries/:seq/proof: RFC 6962 audit path for entry `seq` in the tree of the first treeSize entries. */
  inclusionProof(seq, treeSize = this.entries.length) {
    return {
      seq,
      treeSize,
      leafHash: this.merkle.leafHash(seq).toString('hex'),
      auditPath: this.merkle.auditPath(seq, treeSize),
      rootHash: this.merkle.rootHash(treeSize),
    };
  }

  /**
   * POST /entries. Resolves { status, body }: the HTTP status and JSON body
   * (protocol §7). Proof and root checks run concurrently; the slot-tag
   * lookup, append and any slash run one submission at a time.
   */
  submit(body) {
    const run = this.#submit(body ?? {});
    this.#pending.add(run);
    const settle = () => this.#pending.delete(run);
    run.then(settle, settle);
    return run;
  }

  /** Resolves once every submission received so far has been answered. */
  async idle() {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async #submit(body) {
    const checked = await this.#check(body);
    if (checked.response) return checked.response;
    const run = this.#queue.then(() => this.#record(checked));
    this.#queue = run.catch(() => {});
    return run;
  }

  // Everything that needs no log state, done before queueing so hostile
  // submissions cannot hold up the queue: shape, proof, and a registry
  // vouching for the root.
  async #check({ token, x, siteId }) {
    if (typeof token !== 'string') return { response: invalid('malformed-token', 'token must be a base64url string') };
    let xValue;
    let siteValue;
    try {
      xValue = toField(x);
      siteValue = toField(siteId);
    } catch {
      return { response: invalid('malformed-token', 'x and siteId must be field elements') };
    }
    const verdict = await this.#verify({ token, x: xValue, siteId: siteValue, vkey: this.vkey });
    if (!verdict.ok) {
      const detail = verdict.reason === 'wrong-epoch' ? `epoch ${verdict.epoch} is not accepted now` : verdict.detail;
      return { response: invalid(verdict.reason, detail) };
    }
    const generation = this.roots.generation;
    const registry = await this.roots.registryFor(verdict.signals.root);
    if (!registry) return { response: invalid('unknown-root', this.roots.errors().join('; ') || undefined) };
    return { epoch: verdict.epoch, signals: verdict.signals, registry, generation };
  }

  // snarkjs builds its curve and worker pool on first use with no in-flight
  // guard, so concurrent first verifications would each build one and leak all
  // but the last. Verify one at a time until a proof has reached the verifier.
  async #verify(input) {
    if (this.#verifierWarm) return verifyLogSubmission(input);
    const run = this.#verifierLane.then(() => verifyLogSubmission(input));
    this.#verifierLane = run.catch(() => {});
    const verdict = await run;
    if (verdict.ok || verdict.reason === 'bad-proof') this.#verifierWarm = true;
    return verdict;
  }

  // One submission at a time: the slot-tag lookup, the append and any slash.
  async #record({ epoch, signals, registry, generation }) {
    // A slash since this root was checked restarted a registry's valid-root
    // window. Check again, so a just-burned credential cannot get in on an old root.
    if (generation !== this.roots.generation) {
      registry = await this.roots.registryFor(signals.root);
      if (!registry) return invalid('unknown-root', this.roots.errors().join('; ') || undefined);
    }

    // From here on only the tag, epoch and share are kept; siteId and the
    // pseudonym were needed for the proof check alone.
    const nullifier = toHex(signals.nullifier);
    const share = { x: toHex(signals.x), y: toHex(signals.y) };
    const seqs = this.tags.get(nullifier);
    if (!seqs) return this.#fresh({ epoch, nullifier, ...share });

    const earlier = seqs.map((seq) => this.entries[seq]);
    const same = earlier.find((e) => e.x === share.x);
    if (same) {
      // A tag and x fix y on a valid proof, so a different y cannot get here.
      if (same.y !== share.y) return invalid('bad-proof', 'share conflicts with a logged share');
      this.#emit('replay', { entry: same });
      return { status: 409, body: { status: 'replay', entry: same } };
    }
    const known = this.revocationByTag.get(nullifier);
    if (known) return { status: 409, body: { status: 'double-spend', revocation: known } };
    return this.#doubleSpend({ epoch, nullifier, share, first: earlier[0], registry });
  }

  #fresh(fields) {
    const entry = this.#append(fields);
    this.#emit('entry', { entry, sth: this.sth });
    return { status: 201, body: { status: 'fresh', entry, receipt: { seq: entry.seq, ...this.sth } } };
  }

  // Second point on a line: recover the key, have the registry burn it, keep
  // the second share as evidence and publish the confession.
  async #doubleSpend({ epoch, nullifier, share, first, registry }) {
    const secret = toHex(recoverSecret(first, share));
    const id = randomUUID();
    // Processing is serialized, so the evidence entry lands at this seq.
    const shares = [
      { x: first.x, y: first.y, seq: first.seq },
      { x: share.x, y: share.y, seq: this.entries.length },
    ];
    const slashed = await this.#slash(
      { secret, evidence: { log: this.publicUrl, revocation: id, epoch, nullifier, shares } },
      registry,
    );
    const entry = this.#append({ epoch, nullifier, ...share, revocation: id });
    const revocation = {
      id,
      at: entry.at,
      epoch,
      nullifier,
      secret,
      commitment: toHex(identityCommitment(secret)),
      shares,
      registry: slashed,
    };
    if (this.files) appendLine(this.files.revocations, JSON.stringify(revocation));
    this.revocations.push(revocation);
    this.revocationByTag.set(nullifier, revocation);
    // The slash restarted the registry's valid-root window; do not keep
    // accepting the burned credential's root from the cache.
    this.roots.invalidate();
    this.#emit('entry', { entry, sth: this.sth });
    this.#emit('double-spend', { revocation });
    return { status: 409, body: { status: 'double-spend', revocation } };
  }

  // POST /slash to the registry that vouched for the root first, then the
  // others, until one accepts. null if none does (the revocation still stands).
  async #slash(payload, preferred) {
    const order = [preferred, ...this.registries.filter((url) => url !== preferred)];
    const failures = [];
    for (const url of order) {
      try {
        const res = await fetch(`${url}/slash`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(SLASH_TIMEOUT_MS),
        });
        if (res.status !== 200) {
          failures.push(`${url}: ${res.status}`);
          continue;
        }
        const body = await res.json();
        return { url, index: body.index, slashed: body.slashed, ...(body.alreadyBurned && { alreadyBurned: true }) };
      } catch (err) {
        failures.push(`${url}: ${err.message}`);
      }
    }
    console.warn(`fuse-log: no registry slashed the recovered key (${failures.join('; ')})`);
    return null;
  }

  #append({ epoch, nullifier, x, y, revocation }) {
    const entry = { seq: this.entries.length, epoch, nullifier, x, y, at: new Date().toISOString() };
    if (revocation) entry.revocation = revocation;
    if (this.files) appendLine(this.files.entries, canonicalJson(entry));
    this.#index(entry);
    this.sth = this.#signTreeHead();
    return entry;
  }

  #index(entry) {
    this.entries.push(entry);
    this.merkle.append(leafHash(canonicalJson(entry)));
    const seqs = this.tags.get(entry.nullifier);
    if (seqs) seqs.push(entry.seq);
    else this.tags.set(entry.nullifier, [entry.seq]);
  }

  #signTreeHead() {
    return signTreeHead(
      { treeSize: this.merkle.size, rootHash: this.merkle.rootHash(), timestamp: new Date().toISOString() },
      this.signingKey,
    );
  }

  #load() {
    if (!this.files) return;
    readJsonLines(this.files.entries).forEach(({ seq, epoch, nullifier, x, y, at, revocation }, i) => {
      if (seq !== i) throw new Error(`${this.files.entries}: line ${i + 1} has seq ${seq}`);
      const entry = { seq, epoch, nullifier, x, y, at };
      if (revocation) entry.revocation = revocation;
      this.#index(entry);
    });
    for (const revocation of readJsonLines(this.files.revocations)) {
      this.revocations.push(revocation);
      this.revocationByTag.set(revocation.nullifier, revocation);
    }
  }

  #emit(type, data) {
    try {
      this.onEvent?.(type, data);
    } catch (err) {
      console.error(`fuse-log: event subscriber failed: ${err.message}`);
    }
  }
}

function invalid(reason, detail) {
  return { status: 400, body: { status: 'invalid', reason, ...(detail && { detail }) } };
}
