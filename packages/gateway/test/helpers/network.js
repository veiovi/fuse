// In-test stand-ins for the Fuse network: a registry that serves /roots and
// /tree, and a shared log with the real fresh / replay / double-spend rules
// and a /revocations feed. Plus a member factory that makes real proofs.
import http from 'node:http';
import {
  MerkleTree,
  TREE_DEPTH,
  createFuseAuthorization,
  createIdentity,
  decodeToken,
  epochAt,
  identityCommitment,
  rateCommitment,
  recoverSecret,
  toField,
  toHex,
} from '@fuse/core';
import { nodeArtifacts } from '@fuse/core/node';

/** Serve a request handler on 127.0.0.1:0. */
export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * Credentials for the named members, registered in one tree.
 * @returns {{ members: Record<string, Member>, leaves: string[], root: string }}
 */
export function makeCast(names, limit = 20) {
  const members = {};
  const leaves = [];
  for (const name of names) {
    const identity = createIdentity();
    const member = { name, secret: identity.secret, limit, index: leaves.length };
    leaves.push(toHex(rateCommitment(identity.commitment, limit)));
    members[name] = member;
  }
  const root = toHex(MerkleTree.fromLeaves(leaves.map(toField)).root);
  for (const member of Object.values(members)) member.leaves = leaves;
  return { members, leaves, root };
}

/** Prove one slot for one challenge at one origin (a real Groth16 proof). */
export function prove(member, { origin, challenge, slot }) {
  return createFuseAuthorization({
    secret: member.secret,
    limit: member.limit,
    index: member.index,
    leaves: member.leaves,
    origin,
    challenge,
    epoch: epochAt(),
    slot,
    artifacts: nodeArtifacts,
  });
}

/** Stub registry: GET /roots and GET /tree for a fixed leaf list. */
export async function startStubRegistry({ leaves, root }) {
  const stub = { rootsRequests: 0, valid: [root] };
  const server = await listen((req, res) => {
    if (req.url === '/roots') {
      stub.rootsRequests += 1;
      return sendJson(res, 200, { current: stub.valid[0], valid: stub.valid });
    }
    if (req.url === '/tree') return sendJson(res, 200, { depth: TREE_DEPTH, size: leaves.length, root, leaves });
    sendJson(res, 404, { error: 'not-found' });
  });
  return Object.assign(stub, server);
}

/**
 * Stub shared log. Applies the protocol's rules to the slot tag (nullifier)
 * without re-verifying the proof (the gateway under test already did).
 */
export async function startStubLog() {
  const stub = { entries: [], revocations: [], submissions: [] };
  const byTag = new Map();

  stub.publishRevocation = (secret) => {
    const k = toField(secret);
    const revocation = {
      id: `rev-${stub.revocations.length + 1}`,
      at: new Date().toISOString(),
      epoch: epochAt(),
      nullifier: toHex(1n), // placeholder; a real revocation names the reused slot tag
      secret: toHex(k),
      commitment: toHex(identityCommitment(k)),
      shares: [],
      registry: null,
    };
    stub.revocations.push(revocation);
    return revocation;
  };

  const server = await listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/revocations') return sendJson(res, 200, { revocations: stub.revocations });
    if (req.method === 'POST' && req.url === '/entries') {
      const body = await readJson(req);
      stub.submissions.push(body);
      let outputs;
      let epoch;
      try {
        ({ outputs, epoch } = decodeToken(body.token));
      } catch {
        return sendJson(res, 400, { status: 'invalid', reason: 'malformed-token' });
      }
      const nullifier = toHex(outputs.nullifier);
      const share = { x: toHex(toField(body.x)), y: toHex(outputs.y) };
      const previous = byTag.get(nullifier);
      if (!previous) {
        const entry = { seq: stub.entries.length, epoch, nullifier, ...share, at: new Date().toISOString() };
        stub.entries.push(entry);
        byTag.set(nullifier, entry);
        return sendJson(res, 201, { status: 'fresh', entry, receipt: { seq: entry.seq, treeSize: stub.entries.length } });
      }
      if (previous.x === share.x && previous.y === share.y) return sendJson(res, 409, { status: 'replay', entry: previous });
      const secret = recoverSecret(previous, share);
      const revocation = stub.publishRevocation(secret);
      revocation.nullifier = nullifier;
      revocation.shares = [{ ...previous }, { ...share }];
      return sendJson(res, 409, { status: 'double-spend', revocation });
    }
    sendJson(res, 404, { error: 'not-found' });
  });
  return Object.assign(stub, server);
}

/** A registry + log pair for `names`; close() stops both. */
export async function startStubNetwork(names, limit) {
  const cast = makeCast(names, limit);
  const registry = await startStubRegistry(cast);
  const log = await startStubLog();
  return {
    ...cast,
    registry,
    log,
    close: () => Promise.all([registry.close(), log.close()]),
  };
}

/** The value of cookie `name` from a fetch Response's Set-Cookie headers, or undefined. */
export function cookieFrom(res, name) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** Raw HTTP request (lets a test set the Host header, which fetch forbids). */
export function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Wait until `predicate()` is truthy (polling every 25 ms), or fail after `ms`. */
export async function eventually(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}
