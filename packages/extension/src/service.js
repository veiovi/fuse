// The extension's state machine: credential, daily slots, per-site records and
// permissions. Platform pieces (storage, fetch, the offscreen prover, opening
// the popup, the clock, restricting storage) are injected so the logic runs
// under node:test.
//
// Storage (chrome.storage.local, restricted to extension pages and the service worker):
//   wallet       the @fuse/core wallet JSON; history holds one entry per spent slot
//   credential   { createdAt, deposit, status: 'active' | 'burned' | 'not-a-member', endedAt? }
//   sites        { [origin]: { origin, pseudonym, short, firstContact, lastSpendAt, spends, bannedAt?, reputation? } }
//                lastSpendAt is written when a slot is reserved, so it also marks a proof in flight
//   permissions  { [origin]: 'always' | 'never' }   (absent means ask)
import {
  MAX_LIMIT,
  NETWORK,
  TREE_DEPTH,
  allocateSlot,
  createIdentity,
  createWallet,
  epochAt,
  epochBounds,
  normalizeOrigin,
  pseudonymFor,
  rateCommitment,
  releaseSlot,
  remainingSlots,
  shortPseudonym,
  slotsUsed,
  toField,
  toHex,
} from '@fuse/core';
import { FuseError } from './errors.js';
import { PERMISSIONS, decideFirstContact } from './policy.js';
import { createSerialQueue } from './queue.js';

export const DEFAULT_REGISTRY = 'http://localhost:4701';
export const STORAGE_KEYS = ['wallet', 'credential', 'sites', 'permissions'];
const HISTORY_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CHALLENGE_LENGTH = 4096;
// A success summary waits this long for the page to reload and claim it.
const TOAST_TTL_MS = 30_000;

const iso = (ms) => new Date(ms).toISOString();

/** Canonical registry base URL (no trailing slash), or a FuseError. */
export function normalizeRegistryUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new FuseError('bad-request', 'Enter a registry URL such as http://localhost:4701.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FuseError('bad-request', 'The registry URL must start with http:// or https://.');
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

export function budgetOf(wallet, epoch) {
  return {
    epoch,
    limit: wallet.limit,
    used: slotsUsed(wallet, epoch),
    remaining: remainingSlots(wallet, epoch),
    spentSlots: [...(wallet.spent?.[epoch] ?? [])],
    resetsAt: iso(epochBounds(epoch).end),
  };
}

/**
 * `protectStorage` resolves true once storage is unreadable from content
 * scripts; the secret is never written otherwise.
 */
export function createFuseService({
  storage,
  fetch,
  prove,
  protectStorage = async () => true,
  openPopup = async () => false,
  now = () => Date.now(),
}) {
  const serial = createSerialQueue();
  const toasts = new Map(); // one-time id -> success summary shown after the page reloads

  async function load() {
    const data = await storage.get(STORAGE_KEYS);
    return {
      wallet: data.wallet ?? null,
      credential: data.credential ?? null,
      sites: data.sites ?? {},
      permissions: data.permissions ?? {},
    };
  }

  async function requestJson(url, init = {}) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new FuseError('registry-unreachable', `Could not reach ${new URL(url).host}.`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
      throw new FuseError('registry-error', `The registry refused the request (${reason}).`, { status: res.status });
    }
    if (!body || typeof body !== 'object') throw new FuseError('registry-error', 'The registry sent an unreadable answer.');
    return body;
  }

  /** The registry's full leaf list, after checking this credential is still in it. */
  async function fetchMembership(wallet) {
    const tree = await requestJson(`${wallet.registry}/tree`);
    if (!Array.isArray(tree.leaves)) throw new FuseError('registry-error', 'The registry sent no leaf list.');
    if (tree.depth !== undefined && tree.depth !== TREE_DEPTH) {
      throw new FuseError('registry-error', `The registry uses tree depth ${tree.depth}; Fuse needs ${TREE_DEPTH}.`);
    }
    const leaf = tree.leaves[wallet.index];
    let value = null;
    try {
      value = leaf === undefined ? null : toField(leaf);
    } catch {
      throw new FuseError('registry-error', 'The registry sent a malformed leaf.');
    }
    if (value === 0n) {
      throw new FuseError('credential-burned', 'The registry has removed this credential (burned or withdrawn).');
    }
    if (value !== rateCommitment(toField(wallet.commitment), wallet.limit)) throw new FuseError('not-a-member');
    return tree.leaves;
  }

  function statusFrom({ wallet, credential, sites, permissions }) {
    const epoch = epochAt(now());
    const origins = new Set([...Object.keys(sites), ...Object.keys(permissions)]);
    const siteList = [...origins]
      .map((origin) => {
        const site = sites[origin];
        return {
          origin,
          short: site?.short ?? (wallet ? shortPseudonym(pseudonymFor(wallet.secret, origin)) : null),
          firstContact: site?.firstContact ?? null,
          lastSpendAt: site?.lastSpendAt ?? null,
          spends: site?.spends ?? 0,
          bannedAt: site?.bannedAt ?? null,
          reputation: site?.reputation ?? null,
          permission: permissions[origin] ?? 'ask',
        };
      })
      .sort((a, b) => (b.lastSpendAt ?? '').localeCompare(a.lastSpendAt ?? '') || a.origin.localeCompare(b.origin));
    return {
      network: NETWORK,
      defaultRegistry: DEFAULT_REGISTRY,
      now: iso(now()),
      credential: wallet
        ? {
            tier: wallet.tier,
            registry: wallet.registry,
            index: wallet.index,
            limit: wallet.limit,
            commitment: wallet.commitment,
            createdAt: credential?.createdAt ?? null,
            deposit: credential?.deposit ?? null,
            status: credential?.status ?? 'active',
            endedAt: credential?.endedAt ?? null,
          }
        : null,
      budget: wallet ? budgetOf(wallet, epoch) : null,
      sites: siteList,
      history: [...(wallet?.history ?? [])].reverse().map((entry) => ({
        id: entry.id,
        at: entry.at,
        epoch: entry.epoch,
        slot: entry.slot,
        origin: entry.origin,
        short: shortPseudonym(entry.pseudonym),
        nullifier: entry.nullifier,
        provingMs: entry.provingMs,
        outcome: entry.outcome,
      })),
    };
  }

  // -- extension pages (popup) ----------------------------------------------

  async function status() {
    return statusFrom(await load());
  }

  async function registryInfo(registryInput) {
    const registry = normalizeRegistryUrl(registryInput);
    const info = await requestJson(`${registry}/info`);
    if (!Array.isArray(info.tiers) || info.tiers.length === 0) {
      throw new FuseError('registry-error', 'The registry did not list any tiers.');
    }
    return {
      registry,
      name: info.name ?? null,
      network: info.network ?? null,
      compatible: info.network === NETWORK && (info.depth ?? TREE_DEPTH) === TREE_DEPTH,
      currency: info.currency ?? 'credits',
      tiers: info.tiers.map((t) => ({ id: String(t.id), deposit: Number(t.deposit), limit: Number(t.limit) })),
      members: info.active ?? info.size ?? null,
    };
  }

  function register({ registry: registryInput, tier }) {
    return serial(async () => {
      const state = await load();
      if (state.wallet) throw new FuseError('credential-exists');
      const registry = normalizeRegistryUrl(registryInput);
      if (typeof tier !== 'string' || tier.length === 0) throw new FuseError('bad-request', 'Pick a tier.');
      if (!(await protectStorage())) throw new FuseError('storage-unprotected');

      // The secret is created here and never leaves the extension; the registry sees only the commitment.
      const identity = createIdentity();
      const created = await requestJson(`${registry}/deposits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commitment: toHex(identity.commitment), tier }),
      });
      const index = Number(created.index);
      const limit = Number(created.limit);
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new FuseError('registry-error', 'The registry returned an invalid credential.');
      }
      if (created.leaf !== undefined && toField(created.leaf) !== rateCommitment(identity.commitment, limit)) {
        throw new FuseError('registry-error', 'The registry recorded a different leaf for this credential.');
      }
      const wallet = createWallet({ secret: identity.secret, registry, index, limit, tier: created.tier ?? tier });
      const credential = { createdAt: iso(now()), deposit: created.deposit ?? null, status: 'active' };
      const next = { wallet, credential, sites: {} };
      await storage.set(next);
      return statusFrom({ ...state, ...next });
    });
  }

  function setPermission({ origin, permission }) {
    return serial(async () => {
      if (!PERMISSIONS.includes(permission)) throw new FuseError('bad-request', 'Unknown permission.');
      let site;
      try {
        site = normalizeOrigin(origin);
      } catch {
        throw new FuseError('bad-request', 'Not a web origin.');
      }
      const state = await load();
      if (permission === 'ask') delete state.permissions[site];
      else state.permissions[site] = permission;
      await storage.set({ permissions: state.permissions });
      return statusFrom(state);
    });
  }

  function deleteCredential() {
    return serial(async () => {
      // Permissions are browsing preferences, not part of the credential: keep them.
      await storage.remove(['wallet', 'credential', 'sites']);
      return statusFrom(await load());
    });
  }

  // -- content scripts (origin comes from the sender, never the page) --------

  /**
   * What the card should do about a challenge. `hints` are the page's
   * fuse-network / fuse-registry meta tags: informational only.
   */
  async function challengeState(origin, hints = {}) {
    const state = await load();
    const permission = state.permissions[origin] ?? 'ask';
    const base = { origin, permission };
    if (permission === 'never') return { ...base, action: 'ignore' };
    if (typeof hints.network === 'string' && hints.network && hints.network !== NETWORK) {
      return { ...base, action: 'error', code: 'wrong-network', network: hints.network.slice(0, 64), expected: NETWORK };
    }
    if (!state.wallet) return { ...base, action: 'error', code: 'no-credential' };
    const credentialStatus = state.credential?.status ?? 'active';
    if (credentialStatus !== 'active') {
      return { ...base, action: 'error', code: credentialStatus === 'burned' ? 'credential-burned' : 'not-a-member' };
    }
    const budget = budgetOf(state.wallet, epochAt(now()));
    if (budget.remaining === 0) return { ...base, action: 'error', code: 'budget-exhausted', ...budget };
    const site = state.sites[origin];
    const decision = decideFirstContact({
      permission,
      lastSpendAt: site?.lastSpendAt ? Date.parse(site.lastSpendAt) : null,
      bannedAt: site?.bannedAt ?? null,
      now: now(),
    });
    // The pseudonym is shown only for sites that already know it.
    const returning = site ? { short: site.short, firstContact: site.firstContact, lastSpendAt: site.lastSpendAt } : null;
    let otherRegistry = null;
    try {
      const named = hints.registry ? normalizeRegistryUrl(hints.registry) : null;
      if (named && named !== state.wallet.registry) otherRegistry = named;
    } catch {
      // not a URL: ignore the hint
    }
    return { ...base, ...decision, ...budget, registry: state.wallet.registry, otherRegistry, returning };
  }

  /**
   * Spend one slot on `origin` for `challenge`.
   *
   * `trigger: 'click'` means the person clicked Allow or Always in the card;
   * anything else is an automatic ("always") spend, which must pass the
   * first-contact decision again here, in the queue: a page that reloads
   * while a proof is in flight must not queue more automatic spends.
   * `alive()` says whether the requesting page still exists; a request that
   * waited in the queue for a page that is gone is dropped before it reserves
   * anything.
   */
  function proveFor(origin, { challenge, remember, trigger } = {}, { alive = async () => true } = {}) {
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > MAX_CHALLENGE_LENGTH) {
      return Promise.reject(new FuseError('bad-request', 'The page presented an invalid challenge.'));
    }
    const clicked = trigger === 'click';
    return serial(async () => {
      if (!(await alive())) throw new FuseError('page-gone');
      const state = await load();
      if (clicked && remember === 'always') {
        state.permissions[origin] = 'always';
        await storage.set({ permissions: state.permissions });
      }
      const permission = state.permissions[origin] ?? 'ask';
      if (permission === 'never') throw new FuseError('blocked');
      const { wallet, credential } = state;
      if (!wallet) throw new FuseError('no-credential');
      const credentialStatus = credential?.status ?? 'active';
      if (credentialStatus !== 'active') {
        throw new FuseError(credentialStatus === 'burned' ? 'credential-burned' : 'not-a-member');
      }
      const previous = state.sites[origin] ?? null;
      if (!clicked) {
        const decision = decideFirstContact({
          permission,
          lastSpendAt: previous?.lastSpendAt ? Date.parse(previous.lastSpendAt) : null,
          bannedAt: previous?.bannedAt ?? null,
          now: now(),
        });
        if (decision.action !== 'auto') throw new FuseError('needs-consent', undefined, { reason: decision.reason ?? null });
      }

      // Client rule 2: reserve the slot and persist it before any proof exists.
      // The site's lastSpendAt is written in the same step, so the auto-spend
      // cooldown already covers a proof that is still being generated.
      const epoch = epochAt(now());
      const slot = allocateSlot(wallet, epoch);
      if (slot === null) throw new FuseError('budget-exhausted', undefined, budgetOf(wallet, epoch));
      const reservedAt = iso(now());
      const pseudonym = toHex(pseudonymFor(wallet.secret, origin));
      const site = previous ?? { origin, pseudonym, short: shortPseudonym(pseudonym), firstContact: reservedAt, spends: 0 };
      state.sites[origin] = { ...site, lastSpendAt: reservedAt };
      await storage.set({ wallet, sites: state.sites });

      let proof;
      try {
        const leaves = await fetchMembership(wallet);
        proof = await prove({
          secret: wallet.secret,
          limit: wallet.limit,
          index: wallet.index,
          leaves,
          origin,
          challenge,
          epoch,
          slot,
        });
      } catch (err) {
        // No proof left this device, so no share exists for this slot: it is safe to reuse,
        // and nothing was spent on this site.
        releaseSlot(wallet, epoch, slot);
        if (previous) state.sites[origin] = previous;
        else delete state.sites[origin];
        const updates = { wallet, sites: state.sites };
        if (err.code === 'credential-burned' || err.code === 'not-a-member') {
          updates.credential = {
            ...credential,
            status: err.code === 'credential-burned' ? 'burned' : 'not-a-member',
            endedAt: iso(now()),
          };
        }
        await storage.set(updates);
        if (err instanceof FuseError) throw err;
        throw new FuseError('proof-failed', `Generating the proof failed (${err.message}).`);
      }

      const entry = {
        id: `${epoch}:${slot}`,
        at: iso(now()),
        epoch,
        slot,
        origin,
        pseudonym: proof.pseudonym,
        nullifier: proof.nullifier,
        provingMs: proof.provingMs,
        outcome: 'proved',
        trigger: clicked ? 'click' : 'auto',
      };
      wallet.history = [...(wallet.history ?? []), entry].slice(-HISTORY_LIMIT);
      state.sites[origin] = { ...state.sites[origin], spends: (site.spends ?? 0) + 1 };
      await storage.set({ wallet, sites: state.sites });
      return {
        authorization: proof.authorization,
        spendId: entry.id,
        slot,
        short: site.short,
        provingMs: proof.provingMs,
        ...budgetOf(wallet, epoch),
      };
    });
  }

  /** The content script reports what the site answered to /.fuse/redeem. */
  function redeemResult(origin, { spendId, ok, status: httpStatus, error, reason, reputation, toast } = {}) {
    return serial(async () => {
      const state = await load();
      const entry = state.wallet?.history?.find((h) => h.id === spendId);
      // A content script may only annotate spends made for its own origin.
      if (!entry || entry.origin !== origin) return { recorded: false };
      const why = typeof reason === 'string' ? reason : error;
      entry.outcome = ok ? 'accepted' : typeof why === 'string' ? why.slice(0, 64) : 'rejected';
      if (Number.isInteger(httpStatus)) entry.httpStatus = httpStatus;
      const updates = { wallet: state.wallet };
      const site = state.sites[origin];
      if (ok && typeof toast === 'string' && toast.length <= 64) {
        for (const [id, t] of toasts) if (t.expires < now()) toasts.delete(id);
        toasts.set(toast, {
          origin,
          short: site?.short ?? shortPseudonym(entry.pseudonym),
          slot: entry.slot,
          limit: state.wallet.limit,
          provingMs: entry.provingMs,
          expires: now() + TOAST_TTL_MS,
        });
      }
      if (site) {
        if (ok) {
          delete site.bannedAt;
          if (typeof reputation === 'string') site.reputation = reputation.slice(0, 32);
        } else if (error === 'banned') {
          site.bannedAt = iso(now());
        }
        updates.sites = state.sites;
      }
      if (error === 'credential-burned') {
        // A site's word is not enough to give up a credential: ask the registry.
        try {
          await fetchMembership(state.wallet);
        } catch (err) {
          if (err.code === 'credential-burned' || err.code === 'not-a-member') {
            updates.credential = {
              ...state.credential,
              status: err.code === 'credential-burned' ? 'burned' : 'not-a-member',
              endedAt: iso(now()),
            };
          }
        }
      }
      await storage.set(updates);
      return { recorded: true, burned: updates.credential?.status === 'burned' };
    });
  }

  /**
   * After the reload, the page's content script claims the summary of the
   * first contact it just made (queued, so it cannot overtake that report).
   */
  function takeToast(origin, id) {
    return serial(async () => {
      const toast = toasts.get(id);
      if (!toast || toast.origin !== origin) return null;
      toasts.delete(id);
      if (toast.expires < now()) return null;
      const { short, slot, limit, provingMs } = toast;
      return { short, slot, limit, provingMs };
    });
  }

  return {
    status,
    registryInfo,
    register,
    setPermission,
    deleteCredential,
    challengeState,
    prove: proveFor,
    redeemResult,
    takeToast,
    openPopup: async () => ({ opened: Boolean(await openPopup()) }),
  };
}
