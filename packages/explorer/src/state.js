// Snapshot of the whole network for GET /api/state: the registry, the shared
// log and every site, fetched in parallel. A source that is down shows up as
// { ok: false, error } with its last known data, and the rest of the
// snapshot is still served.
import {
  NETWORK,
  epochAt,
  normalizeOrigin,
  pseudonymFor,
  recoverSecret,
  shortPseudonym,
  toField,
  toHex,
} from '@fuse/core';
import { describeError, getJson } from './sources.js';

const RECENT_ENTRIES = 50;
const CACHE_MS = 150;

/**
 * collect() returns the snapshot. Concurrent callers share one in-flight
 * collection, and a result is reused for CACHE_MS so a burst of events from
 * several open pages does not fan out into a burst of upstream requests.
 */
export function createStateCollector({ registryUrl, logUrl, sites, extras = () => ({}) }) {
  const logIndex = createLogIndex(logUrl);
  let inflight = null;
  let cached = null;

  // When a source stops answering, the snapshot keeps its last known data and
  // marks the source { ok: false, error }, so the page can say so.
  const lastKnown = new Map();
  function settle(out, key, result, pick, fallback) {
    if (result.status === 'fulfilled') {
      const value = pick(result.value);
      lastKnown.set(key, value);
      return value;
    }
    fail(out, result.reason);
    return lastKnown.get(key) ?? fallback;
  }

  async function collectRegistry() {
    const out = { url: registryUrl, ok: true };
    const [info, members] = await Promise.allSettled([
      getJson(`${registryUrl}/info`),
      getJson(`${registryUrl}/members`),
    ]);
    out.info = settle(out, 'registry/info', info, (v) => v, null);
    out.members = settle(out, 'registry/members', members, (v) => v?.members ?? [], []);
    return out;
  }

  async function collectLog() {
    const out = { url: logUrl, ok: true };
    const [info, revocations] = await Promise.allSettled([
      getJson(`${logUrl}/info`),
      getJson(`${logUrl}/revocations`),
    ]);
    out.info = settle(out, 'log/info', info, (v) => v, null);
    if (info.status === 'fulfilled') {
      try {
        await logIndex.sync(info.value?.size);
      } catch (err) {
        fail(out, err);
      }
    }
    out.revocations = settle(out, 'log/revocations', revocations, (v) => v?.revocations ?? [], []);
    out.entries = logIndex.tail(RECENT_ENTRIES);
    out.entriesToday = logIndex.countInEpoch(out.info?.epoch ?? epochAt());
    return out;
  }

  async function collectSite(site) {
    const out = { ...site, ok: true };
    const [info, pseudonyms] = await Promise.allSettled([
      getJson(`${site.url}/.fuse/info`),
      getJson(`${site.url}/.fuse/admin/pseudonyms`),
    ]);
    out.info = settle(out, `${site.id}/info`, info, (v) => v, null);
    out.pseudonyms = settle(out, `${site.id}/pseudonyms`, pseudonyms, (v) => v?.pseudonyms ?? [], []);
    return out;
  }

  async function collectFresh() {
    const [registry, log, ...siteStates] = await Promise.all([
      collectRegistry(),
      collectLog(),
      ...sites.map(collectSite),
    ]);
    log.revocations = log.revocations.map((rev) => explainRevocation(rev, siteStates));
    return { at: new Date().toISOString(), network: NETWORK, epoch: epochAt(), registry, log, sites: siteStates, ...extras() };
  }

  return {
    async collect() {
      if (cached && Date.now() - cached.time < CACHE_MS) return { ...cached.state, ...extras() };
      inflight ??= collectFresh().finally(() => (inflight = null));
      const state = await inflight;
      cached = { time: Date.now(), state };
      return state;
    },
  };
}

function fail(out, err) {
  out.ok = false;
  out.error ??= describeError(err);
}

/**
 * Add what anyone can derive from a published key: whether both shares really
 * lie on one line through it, and the cheater's pseudonym at each site (the
 * one that site's gateway bans).
 */
export function explainRevocation(rev, siteStates) {
  let verified = false;
  try {
    const [first, second] = rev.shares;
    verified = recoverSecret(first, second) === toField(rev.secret);
  } catch {
    verified = false;
  }
  const pseudonyms = [];
  for (const site of siteStates) {
    try {
      const origins = [...new Set([site.url, site.publicUrl].filter(Boolean).map(normalizeOrigin))];
      const candidates = origins.map((origin) => cachedPseudonym(rev.secret, origin));
      const known = site.pseudonyms.find((p) => candidates.includes(asField(p.pseudonym)));
      const pseudonym = toHex(known ? asField(known.pseudonym) : candidates[0]);
      pseudonyms.push({
        site: site.id,
        name: site.name,
        pseudonym,
        short: shortPseudonym(pseudonym),
        seen: Boolean(known),
        banned: known ? Boolean(known.banned) : null,
      });
    } catch {
      // A malformed secret or site URL: leave this site out rather than fail the snapshot.
    }
  }
  return { ...rev, verified, pseudonyms };
}

// Burned keys never change, so their pseudonyms are worth remembering.
const pseudonymCache = new Map();
function cachedPseudonym(secret, origin) {
  const key = `${secret}|${origin}`;
  if (!pseudonymCache.has(key)) pseudonymCache.set(key, pseudonymFor(secret, origin));
  return pseudonymCache.get(key);
}

function asField(value) {
  try {
    return toField(value);
  } catch {
    return null;
  }
}

/**
 * Incremental index over the append-only log: follows new entries with
 * ?after=<last seq> so "entries today" stays exact without refetching
 * history, and keeps the most recent entries for the tape.
 */
export function createLogIndex(logUrl, { page = 200, keep = 200 } = {}) {
  let cursor = null;
  let count = 0;
  let perEpoch = new Map();
  let recent = [];

  function reset() {
    cursor = null;
    count = 0;
    perEpoch = new Map();
    recent = [];
  }

  return {
    async sync(size) {
      const known = Number.isInteger(size) ? size : Infinity;
      if (known < count) reset(); // the log was wiped and restarted
      for (let round = 0; round < 25 && count < known; round++) {
        const query = cursor === null ? `limit=${page}` : `after=${cursor}&limit=${page}`;
        const body = await getJson(`${logUrl}/entries?${query}`);
        const fresh = (body?.entries ?? [])
          .filter((e) => Number.isFinite(e?.seq) && (cursor === null || e.seq > cursor))
          .sort((a, b) => a.seq - b.seq);
        if (!fresh.length) break;
        for (const entry of fresh) perEpoch.set(entry.epoch, (perEpoch.get(entry.epoch) ?? 0) + 1);
        count += fresh.length;
        cursor = fresh.at(-1).seq;
        recent = recent.concat(fresh).slice(-keep);
      }
    },
    countInEpoch: (epoch) => perEpoch.get(epoch) ?? 0,
    tail: (n) => recent.slice(-n),
  };
}
