// Small in-process stand-ins for a registry and a gateway, just enough of
// protocol.md §6 and §8 to exercise the agent with real Groth16 proofs.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  MerkleTree,
  formatChallengeHeader,
  fromHex,
  parseFuseHeader,
  rateCommitment,
  shortPseudonym,
  siteIdFor,
  toField,
  toHex,
  verifyFuseToken,
} from '@fuse/core';
import { loadVerificationKey } from '@fuse/core/node';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Registry stub: POST /deposits, GET /tree, plus burn(index) to drop a member. */
export async function startStubRegistry({ tiers = { starter: 10, pro: 200, tiny: 2 } } = {}) {
  const leaves = [];
  const commitments = new Set();
  const root = () => toHex(MerkleTree.fromLeaves(leaves.map(fromHex)).root);
  const counts = { deposits: 0, trees: 0 };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://stub').pathname;
    if (req.method === 'POST' && path === '/deposits') {
      counts.deposits++;
      const { commitment, tier } = JSON.parse(await readBody(req));
      const limit = tiers[tier];
      if (!limit) return sendJson(res, 400, { error: 'unknown-tier' });
      if (commitments.has(commitment)) return sendJson(res, 409, { error: 'already-registered' });
      commitments.add(commitment);
      const leaf = toHex(rateCommitment(toField(commitment), limit));
      const index = leaves.push(leaf) - 1;
      return sendJson(res, 201, {
        index,
        leaf,
        limit,
        tier,
        root: root(),
        deposit: { id: `dep_${index}`, amount: 50, currency: 'demo-credits', status: 'locked' },
      });
    }
    if (req.method === 'GET' && path === '/tree') {
      counts.trees++;
      return sendJson(res, 200, { depth: 20, size: leaves.length, root: root(), leaves });
    }
    sendJson(res, 404, { error: 'not-found' });
  });
  const url = await listen(server);
  return {
    url,
    counts,
    root,
    burn(index) {
      leaves[index] = toHex(0n);
    },
    close: () => close(server),
  };
}

/**
 * Gateway stub. Protected: /me, /v1/*. /v1/echo echoes the request body;
 * /v1/submit answers 303 → /me (the session cookie rides on the redirect).
 * Anything else is public. Like the real gateway, every admitted protected
 * response carries Fuse-Pseudonym.
 */
export async function startStubGateway({ registry, cookieMaxAge = 3600 } = {}) {
  const vkey = loadVerificationKey();
  const challenges = new Set();
  const sessions = new Map(); // cookie value → pseudonym
  const banned = new Set();
  const counts = { challenges: 0, authorizations: 0, accepted: 0, sessionHits: 0 };
  const seen = []; // pseudonyms accepted, in order
  let burnNext = false;
  let failNext = false;
  let origin;
  let cookieName;

  const protectedPath = (path) => path === '/me' || path.startsWith('/v1/');

  function challengeResponse(res) {
    const challenge = randomBytes(16).toString('base64url');
    challenges.add(challenge);
    counts.challenges++;
    sendJson(
      res,
      401,
      { error: 'fuse-required', challenge, network: 'fuse-demo-v1', registry: registry.url },
      { 'www-authenticate': formatChallengeHeader({ challenge, registry: registry.url }) },
    );
  }

  function serve(req, res, path, pseudonym, body, extraHeaders = {}) {
    if (path === '/v1/submit') {
      res.writeHead(303, { location: '/me', ...extraHeaders });
      return res.end();
    }
    sendJson(res, 200, { pseudonym, short: shortPseudonym(pseudonym), path, method: req.method, body }, extraHeaders);
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    const body = await readBody(req);
    if (!protectedPath(path)) return sendJson(res, 200, { public: true, path });

    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .find(([name]) => name === cookieName);
    if (cookie && sessions.has(cookie[1])) {
      counts.sessionHits++;
      const pseudonym = sessions.get(cookie[1]);
      return serve(req, res, path, pseudonym, body, { 'fuse-pseudonym': shortPseudonym(pseudonym) });
    }

    const auth = parseFuseHeader(req.headers.authorization);
    if (!auth) return challengeResponse(res);
    counts.authorizations++;
    if (!challenges.delete(auth.challenge) || auth.origin !== origin) return challengeResponse(res);
    const result = await verifyFuseToken({ token: auth.token, challenge: auth.challenge, origin, vkey });
    if (!result.ok || toHex(result.signals.root) !== registry.root()) return challengeResponse(res);
    const pseudonym = toHex(result.signals.pseudonym);
    if (banned.has(pseudonym)) return sendJson(res, 403, { error: 'banned', reason: 'spam' });
    if (burnNext) {
      burnNext = false;
      return sendJson(res, 403, { error: 'credential-burned' });
    }
    if (failNext) {
      failNext = false;
      return sendJson(res, 503, { error: 'log-unavailable' });
    }
    counts.accepted++;
    seen.push(pseudonym);
    const session = randomBytes(12).toString('hex');
    sessions.set(session, pseudonym);
    serve(req, res, path, pseudonym, body, {
      'set-cookie': `${cookieName}=${session}; Path=/; Max-Age=${cookieMaxAge}; HttpOnly; SameSite=Lax`,
      'fuse-pseudonym': shortPseudonym(pseudonym),
    });
  });
  origin = await listen(server);
  cookieName = `fuse_${toHex(siteIdFor(origin)).slice(2, 10)}`;
  return {
    url: origin,
    origin,
    get cookieName() {
      return cookieName;
    },
    counts,
    seen,
    ban: (pseudonym) => banned.add(pseudonym),
    burnNextProof() {
      burnNext = true;
    },
    failNextProof() {
      failNext = true;
    },
    endSessions: () => sessions.clear(),
    close: () => close(server),
  };
}

/**
 * A hostile site that tries to make one fetch() spend many slots: it
 * challenges every request without Authorization and answers every proof with
 * `onProof(n)` (default: a 302 back to a fresh challenge on the same origin).
 * It never verifies anything.
 */
export async function startHostileSite({ onProof } = {}) {
  let proofs = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization) {
      proofs++;
      const answer = onProof?.(proofs) ?? { status: 302, headers: { location: `/loop?${proofs}` } };
      res.writeHead(answer.status, answer.headers);
      return res.end();
    }
    const challenge = randomBytes(16).toString('base64url');
    sendJson(res, 401, { error: 'fuse-required' }, { 'www-authenticate': formatChallengeHeader({ challenge }) });
  });
  const url = await listen(server);
  return {
    url,
    get proofs() {
      return proofs;
    },
    close: () => close(server),
  };
}
