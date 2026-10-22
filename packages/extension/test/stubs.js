// Minimal stand-ins for the registry and a gateway, following docs/protocol.md
// §6 and §8 closely enough to exercise the extension end to end. Used by the
// e2e test when the real @fuse/registry / @fuse/gateway are not available.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  MerkleTree,
  NETWORK,
  TREE_DEPTH,
  formatChallengeHeader,
  parseFuseHeader,
  rateCommitment,
  shortPseudonym,
  siteIdFor,
  toField,
  toHex,
  verifyFuseToken,
} from '@fuse/core';
import { loadVerificationKey } from '@fuse/core/node';

const TIERS = [
  { id: 'starter', deposit: 5, limit: 10 },
  { id: 'pro', deposit: 50, limit: 200 },
  { id: 'fleet', deposit: 500, limit: 2000 },
];

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/html; charset=utf-8',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function closer(server) {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
}

export async function startStubRegistry() {
  const tree = new MerkleTree(TREE_DEPTH);
  const members = new Map(); // commitment hex -> index
  const roots = [];
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/info') {
        return send(res, 200, {
          name: 'Stub registry',
          backing: 'deposit',
          network: NETWORK,
          depth: TREE_DEPTH,
          currency: 'demo credits',
          tiers: TIERS,
          size: tree.size,
          active: members.size,
          burned: 0,
          root: toHex(tree.root),
          lockedDeposits: 0,
        });
      }
      if (req.method === 'POST' && pathname === '/deposits') {
        const { commitment, tier } = await readJson(req);
        const plan = TIERS.find((t) => t.id === tier);
        let value;
        try {
          value = toField(commitment);
        } catch {
          return send(res, 400, { error: 'bad-commitment' });
        }
        if (!plan) return send(res, 400, { error: 'unknown-tier' });
        if (members.has(toHex(value))) return send(res, 409, { error: 'already-registered' });
        const leaf = rateCommitment(value, plan.limit);
        const index = tree.insert(leaf);
        members.set(toHex(value), index);
        roots.unshift(toHex(tree.root));
        return send(res, 201, {
          index,
          leaf: toHex(leaf),
          limit: plan.limit,
          tier: plan.id,
          root: toHex(tree.root),
          deposit: { id: `dep-${index}`, amount: plan.deposit, currency: 'demo credits', status: 'locked' },
        });
      }
      if (req.method === 'GET' && pathname === '/tree') {
        return send(res, 200, { depth: TREE_DEPTH, size: tree.size, root: toHex(tree.root), leaves: tree.leaves().map(toHex) });
      }
      if (req.method === 'GET' && pathname === '/roots') {
        return send(res, 200, { current: toHex(tree.root), valid: roots.length ? roots : [toHex(tree.root)] });
      }
      send(res, 404, { error: 'not-found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
  const url = await listen(server);
  return { url, close: closer(server) };
}

/**
 * A protected site: `protectedPath` needs a Fuse session; /.fuse/redeem turns a
 * valid Authorization: Fuse header into a session cookie. Like the real
 * gateway it serves only its configured `origins` (an array, or a function of
 * the bound port): other hosts get a 307 to origins[0] (GET) or a 421.
 */
export async function startStubGateway({
  registry,
  origins = (port) => [`http://localhost:${port}`],
  protectedPath = '/members',
  siteName = 'Stub site',
}) {
  const vkey = loadVerificationKey();
  const challenges = new Map(); // challenge -> expiry ms
  const sessions = new Map(); // session id -> { pseudonym, short }
  const stats = { redeemed: 0, rejected: [] };
  let served = []; // configured origins, known once the port is bound
  let cookieName = null;

  const issueChallenge = () => {
    const challenge = randomBytes(24).toString('base64url');
    challenges.set(challenge, Date.now() + 120_000);
    return challenge;
  };
  const sessionOf = (req) => {
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    return sessions.get(cookies[cookieName]);
  };

  const server = createServer(async (req, res) => {
    try {
      const origin = served.find((o) => new URL(o).host === req.headers.host);
      if (!origin) {
        if (req.method === 'GET') {
          res.writeHead(307, { location: `${served[0]}${req.url}` });
          return res.end();
        }
        return send(res, 421, { error: 'misdirected-request', origin: served[0] });
      }
      const { pathname } = new URL(req.url, origin);

      if (req.method === 'GET' && pathname === protectedPath) {
        const session = sessionOf(req);
        if (session) {
          return send(
            res,
            200,
            `<!doctype html><title>${siteName}</title><h1 id="protected">Members area</h1><p>Signed in as <span id="pseudonym">${session.short}</span></p>`,
          );
        }
        const challenge = issueChallenge();
        return send(
          res,
          401,
          `<!doctype html><html><head><meta charset="utf-8"><title>${siteName}: proof required</title>` +
            `<meta name="fuse-challenge" content="${challenge}"><meta name="fuse-registry" content="${registry}"></head>` +
            `<body><h1>${siteName}</h1><p id="interstitial">This page needs a Fuse proof.</p></body></html>`,
          { 'www-authenticate': formatChallengeHeader({ challenge, registry }) },
        );
      }
      if (req.method === 'GET' && pathname === '/.fuse/challenge') {
        const challenge = issueChallenge();
        return send(res, 200, { challenge, network: NETWORK, registry, expiresAt: new Date(challenges.get(challenge)).toISOString() });
      }
      if (req.method === 'GET' && pathname === '/.fuse/session') {
        const session = sessionOf(req);
        return send(res, 200, session ? { authenticated: true, ...session } : { authenticated: false });
      }
      if (req.method === 'POST' && pathname === '/.fuse/redeem') {
        const auth = parseFuseHeader(req.headers.authorization);
        const reject = (status, error) => {
          stats.rejected.push(error);
          const challenge = issueChallenge();
          return send(res, status, { error, challenge }, { 'www-authenticate': formatChallengeHeader({ challenge, registry }) });
        };
        if (!auth?.token || !auth.challenge) return reject(401, 'missing-authorization');
        const expiry = challenges.get(auth.challenge);
        challenges.delete(auth.challenge);
        if (!expiry || expiry < Date.now()) return reject(401, 'stale-challenge');
        if (auth.origin !== origin) return reject(401, 'wrong-origin');
        const result = await verifyFuseToken({ token: auth.token, challenge: auth.challenge, origin, vkey });
        if (!result.ok) return reject(401, result.reason);
        const roots = await (await fetch(`${registry}/roots`)).json();
        if (!roots.valid.includes(toHex(result.signals.root))) return reject(401, 'unknown-root');
        const pseudonym = toHex(result.signals.pseudonym);
        const session = { pseudonym, short: shortPseudonym(pseudonym), reputation: 'probation' };
        const id = randomBytes(18).toString('base64url');
        sessions.set(id, session);
        stats.redeemed++;
        return send(res, 200, { ok: true, ...session }, { 'set-cookie': `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      send(res, 404, { error: 'not-found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
  const bound = await listen(server);
  const port = Number(new URL(bound).port);
  served = (typeof origins === 'function' ? origins(port) : origins).map((o) => new URL(o).origin);
  cookieName = `fuse_${toHex(siteIdFor(served[0])).slice(2, 10)}`;
  return { url: served[0], protectedPath, stats, close: closer(server) };
}
