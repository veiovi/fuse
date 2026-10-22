// Test doubles for the explorer's upstream sources (registry, log, gateways),
// realistic network data built with @fuse/core, and an SSE recorder.
import { createServer } from 'node:http';
import {
  NETWORK,
  MerkleTree,
  add,
  epochAt,
  externalNullifierFor,
  identityCommitment,
  mul,
  poseidon,
  pseudonymFor,
  randomFieldElement,
  rateCommitment,
  shortPseudonym,
  toHex,
  xFor,
} from '@fuse/core';
import { subscribeSse } from '../src/sse.js';

/**
 * A tiny HTTP server: `json` maps paths to values or (url) => value, and
 * every path in `sse` is an event stream. push(type, data, path) emits.
 */
export async function startStub({ json = {}, sse = [], port = 0, hello = () => ({}) } = {}) {
  const streams = new Map(sse.map((path) => [path, new Set()]));
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const clients = streams.get(url.pathname);
    if (clients && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', at: new Date().toISOString(), ...hello() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const handler = json[url.pathname];
    if (handler === undefined || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not-found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(typeof handler === 'function' ? handler(url) : handler));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    clients: (path = sse[0]) => streams.get(path)?.size ?? 0,
    push(type, data = {}, path = sse[0]) {
      const frame = `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), ...data })}\n\n`;
      for (const res of streams.get(path)) res.write(frame);
    },
    async close() {
      for (const clients of streams.values()) for (const res of clients) res.end();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

/** A port that was free a moment ago (for "source comes up later" tests). */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Follow an SSE URL and record events (parsed JSON) for assertions. */
export function recordEvents(url, options = {}) {
  const events = [];
  const waiters = [];
  const sub = subscribeSse(url, {
    minDelay: 50,
    maxDelay: 200,
    ...options,
    onEvent: ({ type, data, id }) => {
      const event = { sseType: type, id, ...JSON.parse(data) };
      events.push(event);
      for (const w of [...waiters]) if (w.predicate(event)) w.resolve(event);
    },
  });
  return {
    events,
    waitFor(predicate, timeoutMs = 5000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            resolve(event);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for event; saw ${events.map((e) => `${e.source}:${e.type}`).join(', ')}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close: () => sub.close(),
  };
}

export async function until(check, { timeoutMs = 5000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const TIERS = [
  { id: 'starter', deposit: 5, limit: 10 },
  { id: 'pro', deposit: 50, limit: 200 },
  { id: 'fleet', deposit: 500, limit: 2000 },
];

/**
 * A consistent little network: members (some burned), log entries spread over
 * today and yesterday, and revocations whose shares really recover the key.
 */
export function makeNetwork({ members = 12, burned = 2, entries = 64, forum = 'http://127.0.0.1:4710', api = 'http://127.0.0.1:4720' } = {}) {
  const epoch = epochAt();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const tierCycle = ['pro', 'starter', 'pro', 'fleet', 'pro', 'starter'];

  const people = Array.from({ length: members }, (_, index) => {
    const secret = randomFieldElement();
    const tier = TIERS.find((t) => t.id === tierCycle[index % tierCycle.length]);
    return { secret, index, tier, status: index < burned ? 'burned' : 'active' };
  });
  const memberList = people.map((p) => ({
    index: p.index,
    commitment: toHex(identityCommitment(p.secret)),
    tier: p.tier.id,
    limit: p.tier.limit,
    status: p.status,
    joinedAt: iso((members - p.index) * 600_000),
    ...(p.status === 'burned' ? { endedAt: iso(60_000 * (p.index + 1)) } : {}),
    deposit: { id: `dep-${p.index + 1}`, amount: p.tier.deposit, currency: 'demo credits', status: p.status === 'burned' ? 'slashed' : 'locked' },
  }));
  const tree = MerkleTree.fromLeaves(
    people.map((p) => (p.status === 'burned' ? 0n : rateCommitment(identityCommitment(p.secret), p.tier.limit))),
  );

  const entryList = [];
  const share = (person, slot, origin, challenge) => {
    const a1 = poseidon([person.secret, externalNullifierFor(epoch), BigInt(slot)]);
    const x = xFor(origin, challenge);
    return { nullifier: toHex(poseidon([a1])), x: toHex(x), y: toHex(add(person.secret, mul(a1, x))) };
  };
  for (let seq = 0; seq < entries; seq++) {
    const person = people[(seq * 7) % people.length];
    const day = seq < entries / 4 ? epoch - 1 : epoch;
    const s = share(person, seq, seq % 2 ? forum : api, `challenge-${seq}`);
    entryList.push({ seq, epoch: day, ...s, at: iso((entries - seq) * 45_000) });
  }

  const revocations = people.slice(0, burned).map((person, i) => {
    const first = share(person, 0, forum, `double-${i}-a`);
    const second = share(person, 0, api, `double-${i}-b`);
    const seq = entryList.length;
    entryList.push({ seq, epoch, ...first, at: iso(120_000 - i * 1000) });
    entryList.push({ seq: seq + 1, epoch, ...second, at: iso(119_000 - i * 1000), revocation: `rev-${i + 1}` });
    return {
      id: `rev-${i + 1}`,
      at: iso(119_000 - i * 1000),
      epoch,
      nullifier: first.nullifier,
      secret: toHex(person.secret),
      commitment: memberList[person.index].commitment,
      shares: [
        { x: first.x, y: first.y, seq },
        { x: second.x, y: second.y, seq: seq + 1 },
      ],
      registry: { url: 'http://127.0.0.1:4701', index: person.index, slashed: { amount: person.tier.deposit, currency: 'demo credits' } },
    };
  });

  const pseudonymsAt = (origin, count) =>
    people.slice(0, count).map((person, i) => {
      const pseudonym = toHex(pseudonymFor(person.secret, origin));
      const banned = person.status === 'burned';
      return {
        pseudonym,
        short: shortPseudonym(pseudonym),
        firstSeen: iso(3_600_000 - i * 60_000),
        lastSeen: iso(30_000 * (i + 1)),
        firstContacts: 1 + (i % 3),
        requests: 3 + i * 4,
        reputation: i % 3 === 2 ? 'member' : 'probation',
        banned,
        ...(banned ? { bannedReason: 'credential burned' } : {}),
      };
    });

  const active = people.filter((p) => p.status === 'active');
  const lastTreeSize = entryList.length;
  return {
    epoch,
    people,
    registryInfo: {
      name: 'Fuse demo registry',
      backing: 'deposit',
      network: NETWORK,
      depth: 20,
      currency: 'demo credits',
      tiers: TIERS,
      size: people.length,
      active: active.length,
      burned,
      withdrawn: 0,
      root: toHex(tree.root),
      lockedDeposits: active.reduce((sum, p) => sum + p.tier.deposit, 0),
      slashedDeposits: people.filter((p) => p.status === 'burned').reduce((sum, p) => sum + p.tier.deposit, 0),
    },
    members: memberList,
    logInfo: {
      name: 'Fuse shared log',
      network: NETWORK,
      epochSeconds: 86400,
      epoch,
      size: lastTreeSize,
      revocations: revocations.length,
      publicKey: Buffer.from(toHex(randomFieldElement()).slice(2), 'hex').toString('base64'),
      sth: {
        treeSize: lastTreeSize,
        rootHash: toHex(randomFieldElement()).slice(2),
        timestamp: iso(5000),
        signature: Buffer.from(toHex(randomFieldElement()).slice(2).repeat(2), 'hex').toString('base64'),
      },
      registries: ['http://127.0.0.1:4701'],
    },
    entries: entryList,
    revocations,
    sites: {
      forum: {
        info: { siteName: 'Acme Forum', origins: [forum], protect: ['/login', '/post', '/api/*'], registries: ['http://127.0.0.1:4701'], log: 'http://127.0.0.1:4702', stats: { challenges: 41, accepted: 17, rejected: 2, sessions: 6 } },
        pseudonyms: pseudonymsAt(forum, Math.min(5, people.length)),
      },
      api: {
        info: { siteName: 'Bolt API', origins: [api], protect: ['/v1/*'], registries: ['http://127.0.0.1:4701'], log: 'http://127.0.0.1:4702', stats: { challenges: 23, accepted: 12, rejected: 0, sessions: 4 } },
        pseudonyms: pseudonymsAt(api, Math.min(3, people.length)),
      },
    },
  };
}

/** Stubs serving a makeNetwork() result, shaped like the real components. */
export async function startStubNetwork(network, { ports = {} } = {}) {
  const registry = await startStub({
    port: ports.registry,
    json: { '/info': () => network.registryInfo, '/members': () => ({ members: network.members }) },
    sse: ['/events'],
  });
  const log = await startStub({
    port: ports.log,
    json: {
      '/info': () => network.logInfo,
      '/revocations': () => ({ revocations: network.revocations }),
      '/entries': (url) => {
        const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : -1;
        const limit = Number(url.searchParams.get('limit') ?? 100);
        return { size: network.entries.length, entries: network.entries.filter((e) => e.seq > after).slice(0, Math.min(limit, 100)) };
      },
    },
    sse: ['/events'],
  });
  const siteStub = (site, port) =>
    startStub({
      port,
      json: { '/.fuse/info': () => site.info, '/.fuse/admin/pseudonyms': () => ({ pseudonyms: site.pseudonyms }) },
      sse: ['/.fuse/events'],
    });
  const forum = await siteStub(network.sites.forum, ports.forum);
  const api = await siteStub(network.sites.api, ports.api);
  return {
    registry,
    log,
    forum,
    api,
    explorerOptions: {
      registryUrl: registry.url,
      logUrl: log.url,
      sites: [
        { id: 'forum', name: 'Acme Forum', url: forum.url, mode: 'proxy' },
        { id: 'api', name: 'Bolt API', url: api.url, mode: 'middleware' },
      ],
    },
    close: () => Promise.all([registry.close(), log.close(), forum.close(), api.close()]),
  };
}
