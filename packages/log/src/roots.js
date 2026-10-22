// Which membership roots the log accepts: the union of every configured
// registry's `valid` list. Copies are reused for ttlMs. A root missing from
// them triggers a refetch (a member may just have joined), but no registry is
// fetched more than once per minRefetchMs and concurrent lookups share
// fetches, so floods of proofs over made-up trees cannot hammer registries.
import { toField, toHex } from '@fuse/core';

export const ROOTS_TTL_MS = 2000;
export const MIN_REFETCH_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RegistryRoots {
  // url → { copy: { at, valid: Set<hex>, error? } | null, next: { startsAt, promise } | null, lastStart }
  #state = new Map();
  #generation = 0;

  /**
   * @param {string[]} registries base URLs, in the order they are consulted
   * @param {object} [options]
   * @param {number} [options.ttlMs] how long a fetched copy is reused
   * @param {number} [options.minRefetchMs] minimum gap between fetch starts per registry
   * @param {number} [options.timeoutMs] per-fetch timeout
   * @param {() => number} [options.now] clock (ms)
   * @param {(ms: number) => Promise<void>} [options.wait] delay used to hold back a refetch
   */
  constructor(
    registries,
    { ttlMs = ROOTS_TTL_MS, minRefetchMs = MIN_REFETCH_MS, timeoutMs = 3000, now = Date.now, wait = sleep } = {},
  ) {
    this.registries = registries;
    this.ttlMs = ttlMs;
    this.minRefetchMs = minRefetchMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.wait = wait;
  }

  /** Increments on every invalidate(): a lookup from an older generation may predate a slash. */
  get generation() {
    return this.#generation;
  }

  /**
   * URL of the first registry whose valid roots include `root`, or null.
   * A miss waits for copies at least as new as the lookup (at most
   * minRefetchMs plus one fetch) before it is final.
   */
  async registryFor(root) {
    const hex = toHex(toField(root));
    const started = this.now();
    await Promise.all(this.registries.map((url) => this.#fetchedSince(url, started - this.ttlMs)));
    const hit = this.#match(hex);
    if (hit) return hit;
    await Promise.all(this.registries.map((url) => this.#fetchedSince(url, started)));
    return this.#match(hex);
  }

  /** Forget every copy, e.g. right after a slash reset a registry's valid list. Refetches are not held back. */
  invalidate() {
    this.#generation += 1;
    this.#state.clear();
  }

  /** "url: message" for each registry whose latest fetch failed. */
  errors() {
    return [...this.#state].filter(([, s]) => s.copy?.error).map(([url, s]) => `${url}: ${s.copy.error}`);
  }

  #match(hex) {
    return this.registries.find((url) => this.#state.get(url)?.copy?.valid.has(hex)) ?? null;
  }

  // Resolve once url's copy comes from a fetch started at or after `since`:
  // reuse it, join a fetch planned for then, or plan one no sooner than
  // minRefetchMs after the previous fetch started.
  #fetchedSince(url, since) {
    let state = this.#state.get(url);
    if (!state) this.#state.set(url, (state = { copy: null, next: null, lastStart: -Infinity }));
    if (state.copy && state.copy.at >= since) return state.copy;
    if (state.next && state.next.startsAt >= since) return state.next.promise;
    const next = { startsAt: Math.max(this.now(), state.lastStart + this.minRefetchMs) };
    state.lastStart = next.startsAt;
    state.next = next;
    next.promise = this.#fetch(url, state, next);
    return next.promise;
  }

  async #fetch(url, state, next) {
    const delay = next.startsAt - this.now();
    if (delay > 0) await this.wait(delay);
    const at = this.now();
    let copy;
    try {
      const res = await fetch(`${url}/roots`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`GET /roots answered ${res.status}`);
      const { valid } = await res.json();
      if (!Array.isArray(valid)) throw new Error('GET /roots returned no valid list');
      copy = { at, valid: new Set(valid.map((r) => toHex(toField(r)))) };
    } catch (err) {
      // Fail closed: an unreachable registry vouches for no roots.
      copy = { at, valid: new Set(), error: err.message };
    }
    // After invalidate() `state` is detached, so an answer from before the reset is dropped.
    if (!state.copy || copy.at >= state.copy.at) state.copy = copy;
    if (state.next === next) state.next = null;
    return copy;
  }
}
