// Per-pseudonym reputation, persisted as one JSON file when a data directory is
// given. The gateway never learns more than this about anyone: when a
// pseudonym was first and last seen, how many first contacts (accepted proofs)
// and requests it made, and whether it is banned.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortPseudonym } from '@fuse/core';

export const PROBATION_SECONDS = 86400;
const SAVE_DELAY_MS = 200;

/**
 * @typedef {object} PseudonymView
 * @property {string} pseudonym 0x-hex
 * @property {string} short anon-xxxxxxxx
 * @property {string|null} firstSeen ISO time, null if only known from a ban
 * @property {string|null} lastSeen
 * @property {number} firstContacts proofs accepted
 * @property {number} requests authenticated requests served
 * @property {'probation'|'member'} reputation
 * @property {boolean} banned
 * @property {string} [bannedReason]
 */

export class ReputationStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir] persist to dataDir/reputation.json
   * @param {number} [options.probationSeconds]
   * @param {() => number} [options.now] clock in ms (tests)
   */
  constructor({ dataDir, probationSeconds = PROBATION_SECONDS, now = Date.now } = {}) {
    this.file = dataDir ? join(dataDir, 'reputation.json') : null;
    this.probationMs = probationSeconds * 1000;
    this.now = now;
    this.records = new Map();
    this.origins = new Set();
    this.appliedRevocations = new Set(); // "revocationId|origin"
    this.saveTimer = null;
    if (this.file) {
      mkdirSync(dataDir, { recursive: true });
      this.load();
    }
  }

  load() {
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`cannot read gateway store ${this.file}: ${err.message}`);
    }
    for (const [pseudonym, record] of Object.entries(data.pseudonyms ?? {})) this.records.set(pseudonym, record);
    for (const origin of data.origins ?? []) this.origins.add(origin);
    for (const key of data.appliedRevocations ?? []) this.appliedRevocations.add(key);
  }

  /** Persist soon; coalesces bursts of updates into one write. */
  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Write the store now (atomically: temp file, then rename). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const data = {
      version: 1,
      pseudonyms: Object.fromEntries(this.records),
      origins: [...this.origins],
      appliedRevocations: [...this.appliedRevocations],
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  has(pseudonym) {
    return this.records.has(pseudonym);
  }

  #record(pseudonym) {
    let record = this.records.get(pseudonym);
    if (!record) {
      record = { firstSeen: null, lastSeen: null, firstContacts: 0, requests: 0, banned: false };
      this.records.set(pseudonym, record);
    }
    return record;
  }

  /** 'probation' until probationSeconds after first sight, then 'member'. */
  reputation(pseudonym) {
    const firstSeen = this.records.get(pseudonym)?.firstSeen;
    if (!firstSeen) return 'probation';
    return this.now() - Date.parse(firstSeen) < this.probationMs ? 'probation' : 'member';
  }

  /** An accepted proof: a first contact, which is also a served request. */
  recordFirstContact(pseudonym) {
    const record = this.#record(pseudonym);
    const at = new Date(this.now()).toISOString();
    record.firstSeen ??= at;
    record.lastSeen = at;
    record.firstContacts += 1;
    record.requests += 1;
    this.scheduleSave();
  }

  /** A request served on an existing session. */
  recordRequest(pseudonym) {
    const record = this.#record(pseudonym);
    const at = new Date(this.now()).toISOString();
    record.firstSeen ??= at;
    record.lastSeen = at;
    record.requests += 1;
    this.scheduleSave();
  }

  isBanned(pseudonym) {
    return this.records.get(pseudonym)?.banned === true;
  }

  bannedReason(pseudonym) {
    return this.records.get(pseudonym)?.bannedReason;
  }

  /**
   * Ban or unban. Bans are sticky: they survive restarts and new proofs,
   * because the same key always yields the same pseudonym here.
   * @returns {boolean} whether the state changed
   */
  setBanned(pseudonym, banned, reason) {
    const record = this.#record(pseudonym);
    const changed = record.banned !== banned || (banned && reason && record.bannedReason !== reason);
    record.banned = banned;
    if (banned) {
      record.bannedReason = reason || 'banned by a moderator';
      record.bannedAt = new Date(this.now()).toISOString();
    } else {
      delete record.bannedReason;
      delete record.bannedAt;
    }
    this.scheduleSave();
    return changed;
  }

  addOrigin(origin) {
    if (this.origins.has(origin)) return false;
    this.origins.add(origin);
    this.scheduleSave();
    return true;
  }

  isRevocationApplied(key) {
    return this.appliedRevocations.has(key);
  }

  markRevocationApplied(key) {
    this.appliedRevocations.add(key);
    this.scheduleSave();
  }

  /** @returns {PseudonymView} */
  view(pseudonym) {
    const record = this.records.get(pseudonym) ?? { firstSeen: null, lastSeen: null, firstContacts: 0, requests: 0 };
    const view = {
      pseudonym,
      short: shortPseudonym(pseudonym),
      firstSeen: record.firstSeen ?? null,
      lastSeen: record.lastSeen ?? null,
      firstContacts: record.firstContacts ?? 0,
      requests: record.requests ?? 0,
      reputation: this.reputation(pseudonym),
      banned: record.banned === true,
    };
    if (view.banned) view.bannedReason = record.bannedReason;
    return view;
  }

  /** All pseudonyms, most recently seen first. */
  list() {
    const at = (v) => (v.lastSeen ? Date.parse(v.lastSeen) : 0);
    return [...this.records.keys()].map((p) => this.view(p)).sort((a, b) => at(b) - at(a));
  }

  counts() {
    let banned = 0;
    for (const record of this.records.values()) if (record.banned) banned += 1;
    return { pseudonyms: this.records.size, banned };
  }
}
