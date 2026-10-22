// FuseAgent: an HTTP client that holds one Fuse credential and answers Fuse
// challenges itself (protocol.md §4, §9). On a 401 challenge it reserves a
// slot and persists that, builds the Merkle path from the registry's full
// leaf list, proves, and retries once with an Authorization header. After a
// first contact the site's session cookie carries on, so no further slots are
// spent there while the session lives.
import {
  NotAMemberError,
  allocateSlot,
  createFuseAuthorization,
  createIdentity,
  createWallet,
  epochAt,
  epochBounds,
  identityCommitment,
  normalizeOrigin,
  parseFuseHeader,
  pseudonymFor,
  rateCommitment,
  releaseSlot,
  remainingSlots,
  shortPseudonym,
  slotsUsed,
  toField,
  toHex,
} from '@fuse/core';
import { nodeArtifacts } from '@fuse/core/node';
import { CookieJar } from './cookie-jar.js';
import { BannedError, BudgetExhaustedError, CredentialBurnedError, FuseAgentError } from './errors.js';
import { WalletStore } from './wallet-store.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const HISTORY_LIMIT = 1000;
const isoTime = (ms) => new Date(ms).toISOString();

/**
 * @typedef {object} AgentOptions
 * @property {{ wasm: string, zkey: string }} [artifacts] circuit files (default: the bundled ones)
 * @property {(event: { type: string, at: string } & object) => void} [onEvent]
 *   called with `challenge`, `proving`, `proved`, `session-reused`, `budget-exhausted`, `rejected`
 * @property {typeof globalThis.fetch} [fetch] transport (default: global fetch)
 * @property {() => number} [now] clock in ms; the epoch always comes from this, never from a server
 * @property {number} [firstContactCooldownMs] refuse a new first contact at an origin within
 *   this many ms of the previous one there (default 0: off). It caps how fast a site that keeps
 *   ending sessions or rejecting proofs can spend slots; refusals throw `first-contact-cooldown`.
 */

export class FuseAgent {
  #wallet;
  #store;
  #jar;
  #artifacts;
  #onEvent;
  #fetch;
  #now;
  #cooldownMs;
  #dirty = false;
  #firstContacts = new Map(); // origin → in-flight first contact

  /**
   * Prefer FuseAgent.create / FuseAgent.load.
   * @param {AgentOptions & { wallet: object, store?: WalletStore }} options
   */
  constructor({
    wallet,
    store = new WalletStore(),
    artifacts = nodeArtifacts,
    onEvent,
    fetch = globalThis.fetch,
    now = Date.now,
    firstContactCooldownMs = 0,
  }) {
    validateWallet(wallet);
    if (!(Number.isFinite(firstContactCooldownMs) && firstContactCooldownMs >= 0)) {
      throw new TypeError('firstContactCooldownMs must be a non-negative number of milliseconds');
    }
    wallet.spent ??= {};
    wallet.history ??= [];
    wallet.sites ??= {};
    this.#wallet = wallet;
    this.#store = store;
    this.#jar = new CookieJar(wallet.cookies ?? []);
    this.#artifacts = artifacts;
    this.#onEvent = onEvent;
    this.#fetch = fetch;
    this.#now = now;
    this.#cooldownMs = firstContactCooldownMs;
  }

  /**
   * New credential: generate a secret, lock a deposit at the registry
   * (POST /deposits) and save the wallet. Without walletPath the wallet lives
   * in memory only. Refuses to replace an existing wallet file.
   * @param {AgentOptions & { registry: string, tier?: string, walletPath?: string }} options
   */
  static async create({ registry, tier = 'pro', walletPath, ...options } = {}) {
    if (!registry) throw new TypeError('FuseAgent.create needs { registry }');
    const registryUrl = String(registry).replace(/\/+$/, '');
    const store = new WalletStore(walletPath);
    if (await store.exists()) {
      throw new FuseAgentError(`a wallet already exists at ${store.path}; refusing to replace it`, {
        code: 'wallet-exists',
      });
    }
    const transport = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const { secret, commitment } = createIdentity();
    const res = await transport(`${registryUrl}/deposits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ commitment: toHex(commitment), tier }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 201) {
      throw new FuseAgentError(`registry refused the deposit (${res.status}${body.error ? ` ${body.error}` : ''})`, {
        code: 'deposit-refused',
        status: res.status,
        body,
      });
    }
    // The leaf binds our commitment to the daily limit. If the registry stored
    // anything else, none of our proofs would ever verify.
    if (!Number.isInteger(body.index) || !Number.isInteger(body.limit) || !leafMatches(body.leaf, commitment, body.limit)) {
      throw new FuseAgentError('registry answered with a leaf that does not match this credential', {
        code: 'deposit-mismatch',
        body,
      });
    }
    const wallet = {
      ...createWallet({ secret, registry: registryUrl, index: body.index, limit: body.limit, tier: body.tier ?? tier }),
      deposit: body.deposit ?? null,
      createdAt: isoTime(now()),
      sites: {},
      cookies: [],
    };
    await store.commit(wallet);
    return new FuseAgent({ wallet, store, ...options });
  }

  /**
   * Open an existing wallet file.
   * @param {AgentOptions & { walletPath: string }} options
   */
  static async load({ walletPath, ...options } = {}) {
    if (!walletPath) throw new TypeError('FuseAgent.load needs { walletPath }');
    const store = new WalletStore(walletPath);
    const wallet = await store.read();
    if (!wallet) throw new FuseAgentError(`no wallet at ${store.path}`, { code: 'no-wallet' });
    return new FuseAgent({ wallet, store, ...options });
  }

  /** Where the wallet is saved, or null for an in-memory wallet. */
  get walletPath() {
    return this.#store.path;
  }

  /** A copy of the wallet. It contains the secret key: never log or send it. */
  get wallet() {
    return structuredClone(this.#wallet);
  }

  /** First contacts so far: [{ at, origin, epoch, slot, pseudonym, provingMs, status }], oldest first. */
  get history() {
    return structuredClone(this.#wallet.history);
  }

  /** Budget for the current epoch (by the local clock) and the sites that know this credential. */
  status() {
    const wallet = this.#wallet;
    const epoch = epochAt(this.#now());
    const sites = Object.entries(wallet.sites).map(([origin, site]) => ({
      origin,
      pseudonym: site.pseudonym,
      short: shortPseudonym(site.pseudonym),
      lastUsed: site.lastUsed,
      firstContacts: site.firstContacts,
    }));
    sites.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
    return {
      tier: wallet.tier,
      limit: wallet.limit,
      epoch,
      used: slotsUsed(wallet, epoch),
      remaining: remainingSlots(wallet, epoch),
      resetsAt: isoTime(epochBounds(epoch).end),
      commitment: wallet.commitment,
      registry: wallet.registry,
      index: wallet.index,
      sites,
    };
  }

  /** The pseudonym `origin` sees for this credential (0x-hex). Computed locally. */
  pseudonymFor(origin) {
    return toHex(pseudonymFor(this.#wallet.secret, normalizeOrigin(origin)));
  }

  /** Forget every session cookie; saved with the next request or save(). */
  clearCookies() {
    this.#jar.clear();
    this.#dirty = true;
  }

  /** Persist the wallet: slots, history, sites and cookies. */
  async save() {
    this.#wallet.cookies = this.#jar.toJSON();
    this.#dirty = false;
    await this.#store.commit(this.#wallet);
  }

  /**
   * fetch() that answers Fuse challenges. Same arguments and result as the
   * global fetch. The request body is buffered so it can be sent again with
   * proof; redirects are followed here so every hop's cookies are kept.
   *
   * One call spends at most one slot. If anything challenges again after the
   * call has proved (a renewed challenge, or a redirect to a challenge on any
   * origin), it throws `repeat-challenge` instead of proving again, so a
   * hostile URL cannot drain the budget through a redirect loop.
   * @throws {BudgetExhaustedError} no slot left this epoch (nothing was sent)
   * @throws {CredentialBurnedError} the network burned the credential, or it left the registry
   * @throws {BannedError} the site banned this credential's pseudonym
   * @throws {FuseAgentError} `repeat-challenge` or `first-contact-cooldown`: refused locally
   */
  async fetch(input, init = {}) {
    const redirect = init.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    let request = await bufferRequest(input, init);
    const call = { spentAt: null }; // origin where this call spent its slot
    for (let hops = 0; ; hops++) {
      const response = await this.#exchange(request, call);
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location || redirect === 'manual') return response;
      if (redirect === 'error') throw new TypeError(`fetch failed: redirected to ${location}`);
      if (hops >= MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects`);
      await drain(response);
      request = redirected(request, response.status, new URL(location, request.url));
    }
  }

  /** One hop: send with cookies, answer a Fuse challenge if one comes back. */
  async #exchange(request, call) {
    const sent = await this.#send(request);
    const challenge = fuseChallenge(sent.response);
    let response = sent.response;
    if (challenge) response = await this.#answer(request, response, challenge, call);
    else this.#noteSessionUse(request, sent);
    if (this.#dirty) await this.save();
    await this.#throwIfRefused(request.url.origin, response);
    return response;
  }

  async #send(request, authorization) {
    const headers = new Headers(request.headers);
    const cookies = this.#jar.cookieHeader(request.url, this.#now());
    if (cookies) headers.set('cookie', [headers.get('cookie'), cookies].filter(Boolean).join('; '));
    if (authorization) headers.set('authorization', authorization);
    const response = await this.#fetch(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      signal: request.signal,
    });
    if (this.#jar.setFromResponse(request.url, response, this.#now())) this.#dirty = true;
    return { response, sentCookies: cookies !== '' };
  }

  /**
   * Concurrent requests to a site without a session share one first contact:
   * the others wait for its cookie instead of spending slots of their own.
   */
  async #answer(request, unauthorized, challenge, call) {
    const origin = request.url.origin;
    const inFlight = this.#firstContacts.get(origin);
    if (inFlight) {
      const failure = await inFlight.then(() => null, (err) => err);
      if (failure instanceof BannedError || failure instanceof CredentialBurnedError) throw failure;
      await drain(unauthorized);
      const again = await this.#send(request);
      const next = fuseChallenge(again.response);
      if (!next) {
        this.#noteSessionUse(request, again);
        return again.response;
      }
      [unauthorized, challenge] = [again.response, next];
    }
    const blocked = this.#firstContactBlock(origin, call);
    if (blocked) {
      await drain(unauthorized);
      this.#emit('challenge', { origin, url: request.url.href, method: request.method, registry: challenge.registry ?? null });
      this.#emit('rejected', { origin, slot: null, status: unauthorized.status, reason: blocked.code });
      throw blocked;
    }
    call.spentAt = origin;
    const contact = this.#firstContact(request, unauthorized, challenge);
    this.#firstContacts.set(origin, contact);
    try {
      return await contact;
    } finally {
      if (this.#firstContacts.get(origin) === contact) this.#firstContacts.delete(origin);
    }
  }

  /** Why a first contact at `origin` must not happen now (a FuseAgentError), or null. */
  #firstContactBlock(origin, call) {
    if (call.spentAt) {
      const where = call.spentAt === origin ? '' : ` (at ${call.spentAt})`;
      return new FuseAgentError(
        `${origin} challenged again after this request already spent a slot${where}; refusing to prove twice in one fetch()`,
        { code: 'repeat-challenge', origin },
      );
    }
    const retryAt = Date.parse(this.#wallet.sites[origin]?.lastFirstContact ?? '') + this.#cooldownMs;
    if (this.#cooldownMs > 0 && retryAt > this.#now()) {
      return new FuseAgentError(
        `first contact at ${origin} refused: the previous one was less than ${this.#cooldownMs} ms ago (firstContactCooldownMs)`,
        { code: 'first-contact-cooldown', origin, retryAt: isoTime(retryAt) },
      );
    }
    return null;
  }

  async #firstContact(request, unauthorized, challenge) {
    // The origin comes from the URL we connected to, never from the server:
    // otherwise a site could ask for the pseudonym we use at another site.
    const origin = request.url.origin;
    const wallet = this.#wallet;
    const epoch = epochAt(this.#now());
    await drain(unauthorized);
    this.#emit('challenge', { origin, url: request.url.href, method: request.method, registry: challenge.registry ?? null });

    // Reserve and persist the slot BEFORE proving: once a proof exists the slot counts as spent.
    const slot = await this.#store.commit(wallet, (w) => allocateSlot(w, epoch));
    if (slot === null) {
      const resetsAt = isoTime(epochBounds(epoch).end);
      this.#emit('budget-exhausted', { origin, epoch, limit: wallet.limit, resetsAt });
      throw new BudgetExhaustedError({ origin, epoch, limit: wallet.limit, resetsAt });
    }
    let auth;
    try {
      const { leaves } = await this.#registryTree(request.signal);
      if (!holdsLeaf(leaves, wallet)) throw new NotAMemberError();
      this.#emit('proving', { origin, epoch, slot, limit: wallet.limit, remaining: remainingSlots(wallet, epoch) });
      auth = await createFuseAuthorization({
        secret: wallet.secret,
        limit: wallet.limit,
        index: wallet.index,
        leaves,
        origin,
        challenge: challenge.challenge,
        epoch,
        slot,
        artifacts: this.#artifacts,
      });
    } catch (err) {
      // No share has left this process, so handing the slot back is safe.
      await this.#store.commit(wallet, (w) => releaseSlot(w, epoch, slot));
      if (err instanceof NotAMemberError) {
        this.#emit('rejected', { origin, epoch, slot: null, status: null, reason: 'not-a-member' });
        throw new CredentialBurnedError({ origin, reason: 'not-a-member', cause: err });
      }
      throw err;
    }

    const entry = {
      at: isoTime(this.#now()),
      origin,
      epoch,
      slot,
      pseudonym: auth.pseudonym,
      provingMs: auth.provingMs,
      status: null,
    };
    let response;
    try {
      ({ response } = await this.#send(request, auth.authorization));
    } catch (err) {
      entry.status = 'network-error';
      await this.#recordContact(entry);
      throw err;
    }
    entry.status = response.status;
    await this.#recordContact(entry);

    const details = { origin, epoch, slot, pseudonym: auth.pseudonym, short: shortPseudonym(auth.pseudonym), provingMs: auth.provingMs, status: response.status };
    const refusal = (await fuseRefusal(response)) ?? (await serverFailure(response));
    if (refusal) this.#emit('rejected', { ...details, reason: refusal.reason });
    else this.#emit('proved', details);
    return response;
  }

  /**
   * Gateways mark every admitted protected response with Fuse-Pseudonym. One
   * that arrives without our having proved in this exchange rode on a session.
   */
  #noteSessionUse(request, { response, sentCookies }) {
    if (!sentCookies || !response.headers.has('fuse-pseudonym')) return;
    const origin = request.url.origin;
    const site = (this.#wallet.sites[origin] ??= { pseudonym: this.pseudonymFor(origin), firstContacts: 0 });
    site.lastUsed = isoTime(this.#now());
    this.#dirty = true;
    this.#emit('session-reused', {
      origin,
      url: request.url.href,
      method: request.method,
      status: response.status,
      pseudonym: site.pseudonym,
      short: shortPseudonym(site.pseudonym),
    });
  }

  async #throwIfRefused(origin, response) {
    const refusal = await fuseRefusal(response);
    if (!refusal) return;
    await drain(response);
    const { status } = response;
    if (refusal.error === 'fuse-required') {
      // Only reachable after this call proved: any other challenge was answered or refused earlier.
      throw new FuseAgentError(
        `${origin} answered our proof with another challenge (${refusal.reason}); refusing to prove twice in one fetch()`,
        { code: 'repeat-challenge', origin, status, body: refusal.body, reason: refusal.reason },
      );
    }
    if (refusal.error === 'banned') {
      throw new BannedError({ origin, pseudonym: this.pseudonymFor(origin), status, body: refusal.body });
    }
    throw new CredentialBurnedError({ origin, reason: 'credential-burned', status, body: refusal.body });
  }

  async #recordContact(entry) {
    const wallet = this.#wallet;
    wallet.history.push(entry);
    if (wallet.history.length > HISTORY_LIMIT) wallet.history.splice(0, wallet.history.length - HISTORY_LIMIT);
    const site = (wallet.sites[entry.origin] ??= { pseudonym: entry.pseudonym, firstContacts: 0 });
    site.firstContacts += 1;
    site.lastUsed = entry.at;
    site.lastFirstContact = entry.at;
    await this.save();
  }

  async #registryTree(signal) {
    const url = `${this.#wallet.registry.replace(/\/+$/, '')}/tree`;
    const res = await this.#fetch(url, { headers: { accept: 'application/json' }, signal });
    const tree = res.ok ? await res.json().catch(() => null) : await drain(res);
    if (!Array.isArray(tree?.leaves)) {
      throw new FuseAgentError(`registry tree unavailable (${res.status} from ${url})`, {
        code: 'registry-unavailable',
        status: res.status,
      });
    }
    return tree;
  }

  #emit(type, data) {
    if (!this.#onEvent) return;
    const warn = (err) => process.emitWarning(`FuseAgent onEvent listener failed: ${err?.message ?? err}`);
    try {
      const result = this.#onEvent({ type, at: isoTime(this.#now()), ...data });
      if (typeof result?.catch === 'function') result.catch(warn);
    } catch (err) {
      warn(err); // a listener must not break the request
    }
  }
}

function validateWallet(wallet) {
  if (!wallet || typeof wallet !== 'object') {
    throw new FuseAgentError('wallet must be an object', { code: 'bad-wallet' });
  }
  const bad = [
    ...['secret', 'commitment', 'registry'].filter((key) => typeof wallet[key] !== 'string'),
    ...['index', 'limit'].filter((key) => !Number.isInteger(wallet[key])),
  ];
  if (bad.length) throw new FuseAgentError(`wallet field(s) missing or invalid: ${bad.join(', ')}`, { code: 'bad-wallet' });
  if (identityCommitment(wallet.secret) !== toField(wallet.commitment)) {
    throw new FuseAgentError('wallet secret does not match its commitment', { code: 'bad-wallet' });
  }
}

function leafMatches(leaf, commitment, limit) {
  try {
    return toField(leaf) === rateCommitment(commitment, limit);
  } catch {
    return false;
  }
}

/** Is the wallet's leaf still in the registry's leaf list? (Burned leaves are zero.) */
function holdsLeaf(leaves, wallet) {
  return leafMatches(leaves[wallet.index], identityCommitment(wallet.secret), wallet.limit);
}

/** Snapshot a fetch request so it can be sent more than once. */
async function bufferRequest(input, init) {
  const request = new Request(input, init);
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  return {
    url: new URL(request.url),
    method: request.method,
    headers: new Headers(request.headers),
    body: bodyless ? null : new Uint8Array(await request.arrayBuffer()),
    signal: request.signal,
  };
}

/** The next hop of a redirect, following the fetch spec's method rewriting. */
function redirected(request, status, url) {
  const toGet = status === 303 ? request.method !== 'HEAD' : (status === 301 || status === 302) && request.method === 'POST';
  const headers = new Headers(request.headers);
  if (toGet) {
    for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
      headers.delete(name);
    }
  }
  if (url.origin !== request.url.origin) {
    headers.delete('authorization');
    headers.delete('cookie');
  }
  return { ...request, url, headers, method: toGet ? 'GET' : request.method, body: toGet ? null : request.body };
}

function fuseChallenge(response) {
  if (response.status !== 401) return null;
  const params = parseFuseHeader(response.headers.get('www-authenticate'));
  return params?.challenge ? params : null;
}

const refusals = new WeakMap();

/**
 * Whether a response refuses Fuse access: `{ error, reason, body }` for a 403
 * banned / credential-burned or a renewed 401 challenge, else null. Peeks at
 * the body through a clone so the caller can still read it.
 */
async function fuseRefusal(response) {
  if (refusals.has(response)) return refusals.get(response);
  let refusal = null;
  if (fuseChallenge(response)) {
    const body = await peekJson(response);
    refusal = { error: 'fuse-required', reason: body?.reason ?? body?.error ?? 'fuse-required', body };
  } else if (response.status === 403) {
    const body = await peekJson(response);
    if (body?.error === 'banned' || body?.error === 'credential-burned') refusal = { error: body.error, reason: body.error, body };
  }
  refusals.set(response, refusal);
  return refusal;
}

/**
 * A 5xx without Fuse-Pseudonym after a proof: the gateway could not finish
 * checking it (log or registry unreachable). The slot is spent all the same.
 */
async function serverFailure(response) {
  if (response.status < 500 || response.headers.has('fuse-pseudonym')) return null;
  const body = await peekJson(response);
  return { error: 'server-error', reason: body?.error ?? `http-${response.status}`, body };
}

async function peekJson(response) {
  if (!/json/i.test(response.headers.get('content-type') ?? '')) return null;
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

/** Read a response we are discarding so its connection can be reused. */
async function drain(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // already consumed or aborted
  }
}
