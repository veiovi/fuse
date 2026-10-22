// Test doubles: a chrome.* subset, a registry behind fetch, and a prover.
import { MerkleTree, NETWORK, TREE_DEPTH, pseudonymFor, rateCommitment, toField, toHex } from '@fuse/core';

export const EXTENSION_ID = 'fuseextensionidfortests';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** chrome.storage.local: values round-trip through JSON, as they do in the browser. */
export function createFakeStorage() {
  const data = new Map();
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    async setAccessLevel({ accessLevel }) {
      this.accessLevel = accessLevel;
    },
    async get(keys) {
      const list = keys === undefined || keys === null ? [...data.keys()] : [keys].flat();
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, copy(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, copy(v));
    },
    async remove(keys) {
      for (const k of [keys].flat()) data.delete(k);
    },
    /** Synchronous peek for assertions. */
    peek(key) {
      return copy(data.get(key));
    },
  };
}

/** The subset of chrome.* that background.js uses. `offscreen` handles messages sent to the offscreen document. */
export function createFakeChrome({ offscreen = async () => undefined } = {}) {
  const listeners = [];
  const contexts = [];
  const getURL = (path = '') => `${EXTENSION_ORIGIN}/${String(path).replace(/^\//, '')}`;
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      async getContexts({ contextTypes = [], documentUrls = [] } = {}) {
        return contexts.filter((c) => contextTypes.includes(c.contextType) && (!documentUrls.length || documentUrls.includes(c.documentUrl)));
      },
      async sendMessage(message) {
        if (message?.target === 'offscreen' && contexts.length > 0) return offscreen(message, { id: EXTENSION_ID, url: getURL('background.js') });
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
    offscreen: {
      createdWith: [],
      closed: 0,
      async createDocument(options) {
        if (contexts.length > 0) throw new Error('Only a single offscreen document may be created.');
        chrome.offscreen.createdWith.push(options);
        contexts.push({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: getURL(options.url) });
      },
      async closeDocument() {
        if (contexts.length === 0) throw new Error('No current offscreen document.');
        contexts.length = 0;
        chrome.offscreen.closed++;
      },
    },
    storage: { local: createFakeStorage(), onChanged: { addListener() {} } },
    action: { openPopup: async () => undefined },
    /** Documents (by documentId) that have navigated away, reloaded or closed. */
    goneDocuments: new Set(),
    tabs: {
      pings: [],
      // The content script answers 'alive' while its document exists.
      async sendMessage(tabId, message, options = {}) {
        chrome.tabs.pings.push({ tabId, message, options });
        if (options.documentId && chrome.goneDocuments.has(options.documentId)) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return message?.type === 'alive' ? { alive: true } : undefined;
      },
    },
    /** Deliver a runtime message to the registered listeners, like Chrome does. */
    dispatch(message, sender) {
      return new Promise((resolve) => {
        let pending = false;
        for (const listener of listeners) if (listener(message, sender, resolve) === true) pending = true;
        if (!pending) resolve(undefined);
      });
    },
  };
  return chrome;
}

export const senders = {
  popup: { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/popup.html`, origin: EXTENSION_ORIGIN },
  content(origin, path = '/members', documentId = 'doc-1') {
    return { id: EXTENSION_ID, url: `${origin}${path}`, origin, tab: { id: 7 }, frameId: 0, documentId };
  },
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A registry (protocol §6) behind a fetch function. */
export function createFakeRegistry({ url = 'http://registry.test', tiers = [{ id: 'starter', deposit: 5, limit: 3 }] } = {}) {
  const tree = new MerkleTree(TREE_DEPTH);
  const requests = [];
  const registry = {
    url,
    tree,
    requests,
    lieAboutLeaf: false,
    async fetch(input, init = {}) {
      const target = new URL(input);
      requests.push({ url: String(input), method: init.method ?? 'GET', body: init.body ?? null });
      if (target.origin !== url) throw new TypeError('fetch failed');
      if (target.pathname === '/info') return json(200, { name: 'Fake', network: NETWORK, depth: TREE_DEPTH, currency: 'demo credits', tiers, size: tree.size });
      if (target.pathname === '/deposits' && init.method === 'POST') {
        const { commitment, tier } = JSON.parse(init.body);
        const plan = tiers.find((t) => t.id === tier);
        if (!plan) return json(400, { error: 'unknown-tier' });
        const leaf = rateCommitment(toField(commitment), plan.limit);
        const index = tree.insert(leaf);
        return json(201, {
          index,
          leaf: toHex(registry.lieAboutLeaf ? leaf + 1n : leaf),
          limit: plan.limit,
          tier: plan.id,
          root: toHex(tree.root),
          deposit: { id: `d${index}`, amount: plan.deposit, currency: 'demo credits', status: 'locked' },
        });
      }
      if (target.pathname === '/tree') return json(200, { depth: TREE_DEPTH, size: tree.size, root: toHex(tree.root), leaves: tree.leaves().map(toHex) });
      return json(404, { error: 'not-found' });
    },
    burn(index) {
      tree.update(index, 0n);
    },
  };
  return registry;
}

/** A prover that records what it saw. `storage` lets it check the slot was persisted first. */
export function createFakeProver({ storage, delayMs = 5 } = {}) {
  const prover = {
    calls: [],
    active: 0,
    maxActive: 0,
    failNext: null,
    /** While set to a promise, proofs wait for it: lets a test look at a proof in flight. */
    hold: null,
    async prove(request) {
      prover.active++;
      prover.maxActive = Math.max(prover.maxActive, prover.active);
      try {
        const stored = storage ? (await storage.get('wallet')).wallet : null;
        prover.calls.push({ request, persistedSlots: stored?.spent?.[request.epoch] ?? null });
        if (prover.hold) await prover.hold;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (prover.failNext) {
          const err = prover.failNext;
          prover.failNext = null;
          throw err;
        }
        return {
          authorization: `Fuse origin="${request.origin}", challenge="${request.challenge}", token="fake-${request.slot}"`,
          origin: request.origin,
          epoch: request.epoch,
          slot: request.slot,
          pseudonym: toHex(pseudonymFor(request.secret, request.origin)),
          nullifier: toHex(BigInt(1000 + request.slot)),
          root: '0x00',
          provingMs: 321,
        };
      } finally {
        prover.active--;
      }
    },
  };
  return prover;
}
