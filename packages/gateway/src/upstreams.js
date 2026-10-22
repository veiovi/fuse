// The gateway's view of the rest of the network: registry roots (which
// credentials currently count), the shared log (is this slot tag fresh?), and
// the log's revocations (whose keys burned).
import { toField, toHex } from '@fuse/core';

const FETCH_TIMEOUT_MS = 5000;

const trimSlash = (url) => String(url).replace(/\/+$/, '');

function normalizeRoot(value) {
  try {
    return toHex(toField(value));
  } catch {
    return null;
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Valid Merkle roots per registry, cached for `ttlMs`. An unknown root waits
 * for a fetch that started after the lookup (a member may just have joined),
 * rather than trusting roots fetched moments before they joined. Concurrent
 * lookups share a fetch, and fetches start at least `minRefetchMs` apart, so a
 * stream of proofs over a fake tree cannot hammer the registry.
 */
export class RootCache {
  /** @param {{ registries: string[], ttlMs?: number, minRefetchMs?: number }} options */
  constructor({ registries, ttlMs = 2000, minRefetchMs = 250 }) {
    this.registries = registries.map(trimSlash);
    this.ttlMs = ttlMs;
    this.minRefetchMs = minRefetchMs;
    // registry -> { roots: Set, startedAt, pending, pendingStartedAt, lastStart }
    this.entries = new Map();
  }

  #entry(registry) {
    let entry = this.entries.get(registry);
    if (!entry) {
      entry = { roots: null, startedAt: 0, pending: null, pendingStartedAt: 0, lastStart: 0 };
      this.entries.set(registry, entry);
    }
    return entry;
  }

  #fetch(registry, entry) {
    const startedAt = Date.now();
    entry.pendingStartedAt = entry.lastStart = startedAt;
    entry.pending = getJson(`${registry}/roots`)
      .then((body) => {
        const list = [body?.current, ...(Array.isArray(body?.valid) ? body.valid : [])];
        entry.roots = new Set(list.map(normalizeRoot).filter(Boolean));
        entry.startedAt = startedAt;
        return entry.roots;
      })
      .finally(() => {
        entry.pending = null;
      });
    return entry.pending;
  }

  /** Roots from a fetch that started at or after `since`. */
  async #roots(registry, since) {
    const entry = this.#entry(registry);
    try {
      for (;;) {
        if (entry.roots && entry.startedAt >= since) return entry.roots;
        if (entry.pending && entry.pendingStartedAt >= since) return await entry.pending;
        if (entry.pending) {
          await entry.pending.catch(() => {});
          continue;
        }
        const wait = entry.lastStart + this.minRefetchMs - Date.now();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        return await this.#fetch(registry, entry);
      }
    } catch {
      return entry.roots; // unreachable registry: fall back to the last roots we saw, if any
    }
  }

  async #find(root, since) {
    const results = await Promise.all(this.registries.map((r) => this.#roots(r, since)));
    const index = results.findIndex((roots) => roots?.has(root));
    return { registry: index >= 0 ? this.registries[index] : null, reachable: results.some(Boolean) };
  }

  /**
   * Is `root` currently valid at some configured registry?
   * @returns {Promise<{ ok: true, registry: string } | { ok: false, reason: 'unknown-root' | 'registry-unavailable' }>}
   */
  async check(rootValue) {
    const root = normalizeRoot(rootValue);
    if (!root) return { ok: false, reason: 'unknown-root' };
    const asked = Date.now();
    let found = await this.#find(root, asked - this.ttlMs);
    if (!found.registry) found = await this.#find(root, asked);
    if (found.registry) return { ok: true, registry: found.registry };
    return { ok: false, reason: found.reachable ? 'unknown-root' : 'registry-unavailable' };
  }
}

/**
 * Submit an accepted first contact to the shared log.
 * @returns {Promise<{ status: 'fresh'|'replay'|'double-spend'|'invalid'|'unavailable', body?: object, reason?: string }>}
 */
export async function submitToLog(logUrl, { token, x, siteId }) {
  let res;
  let body;
  try {
    res = await fetch(`${trimSlash(logUrl)}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, x: toHex(x), siteId: toHex(siteId) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    return { status: 'unavailable', reason: err.message };
  }
  const status = body?.status;
  if (res.ok && status === 'fresh') return { status, body };
  if (res.status === 409 && (status === 'replay' || status === 'double-spend')) return { status, body };
  if (res.status === 400 && status === 'invalid') return { status, body, reason: body.reason ?? 'invalid' };
  return { status: 'unavailable', body, reason: `log answered ${res.status}` };
}

/**
 * Poll the log's revocations every `intervalMs` and hand each batch to
 * `onRevocations`. Errors are swallowed and retried on the next tick.
 * @returns {{ stop(): void, pollNow(): Promise<void> }}
 */
export function followRevocations({ logUrl, intervalMs = 2000, onRevocations }) {
  const url = `${trimSlash(logUrl)}/revocations`;
  let timer = null;
  let stopped = false;
  let running = null;

  async function poll() {
    try {
      const body = await getJson(url);
      if (!stopped && Array.isArray(body?.revocations)) await onRevocations(body.revocations);
    } catch {
      // Log unreachable or malformed answer: try again next tick.
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      running = poll();
      await running;
      running = null;
      schedule();
    }, intervalMs);
    timer.unref?.();
  }

  running = poll().finally(() => {
    running = null;
    schedule();
  });

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    async pollNow() {
      if (running) await running;
      await poll();
    },
  };
}
