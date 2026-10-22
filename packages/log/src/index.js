// @fuse/log: the shared append-only slot-tag log (docs/protocol.md §7).
// Verifies forwarded first contacts, spots reused slots, recovers and
// publishes the cheater's key, and serves CT-style signed tree heads and
// inclusion proofs so anyone can audit what it recorded.
import express from 'express';
import { EventHub } from './events.js';
import { baseUrl, bodyOf, closeServer, cors, errorHandler, intParam, jsonBody, listen, notFound } from './http.js';
import { SlotLog } from './slotlog.js';

export { SlotLog } from './slotlog.js';
export { RegistryRoots, ROOTS_TTL_MS } from './roots.js';
export { EventHub } from './events.js';
export {
  EMPTY_ROOT_HASH,
  MerkleLog,
  canonicalJson,
  entryLeafHash,
  exportPublicKey,
  leafHash,
  nodeHash,
  signTreeHead,
  sthMessage,
  verifyInclusion,
  verifySignedTreeHead,
} from './transparency.js';

const MAX_PAGE = 1000;

/**
 * Express app serving one SlotLog's HTTP API and SSE stream.
 * @param {{ log: SlotLog, hub: EventHub }} deps
 */
export function createLogApp({ log, hub }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
  app.use(jsonBody);
  app.get('/info', (req, res) => res.json(log.info()));
  app.post('/entries', async (req, res) => {
    const { status, body } = await log.submit(bodyOf(req));
    res.status(status).json(body);
  });
  app.get('/entries', (req, res) => {
    const after = intParam(req.query.after, -1);
    const limit = intParam(req.query.limit, 100);
    if (after === null || limit === null || limit < 1) {
      res.status(400).json({ error: 'bad-query', message: 'after and limit must be integers (limit >= 1)' });
      return;
    }
    res.json(log.listEntries({ after, limit: Math.min(limit, MAX_PAGE) }));
  });
  app.get('/entries/:seq/proof', (req, res) => {
    const size = log.entries.length;
    const seq = intParam(req.params.seq, null);
    if (seq === null || seq < 0 || seq >= size) {
      res.status(404).json({ error: 'not-found', message: `no entry with seq ${req.params.seq}` });
      return;
    }
    const treeSize = intParam(req.query.treeSize, size);
    if (treeSize === null || treeSize <= seq || treeSize > size) {
      res.status(400).json({ error: 'bad-tree-size', message: `treeSize must be in [${seq + 1}, ${size}]` });
      return;
    }
    res.json(log.inclusionProof(seq, treeSize));
  });
  app.get('/sth', (req, res) => res.json(log.sth));
  app.get('/revocations', (req, res) => res.json({ revocations: log.revocations }));
  app.get('/events', hub.handler);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/**
 * Start a shared log server.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host] bind address (FUSE_BIND, else 127.0.0.1)
 * @param {string} [options.dataDir] persist entries, revocations and the signing key here; omit for in-memory
 * @param {string[]} [options.registries] registry base URLs whose valid roots are accepted
 * @param {string} [options.publicUrl] URL clients use (default http://localhost:<port>)
 * @param {string} [options.name]
 * @param {number} [options.rootsTtlMs] registry /roots cache lifetime (default 2000)
 * @returns {Promise<{ url: string, port: number, log: SlotLog, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function startLog({
  port = 4702,
  host = process.env.FUSE_BIND || '127.0.0.1',
  dataDir,
  registries = ['http://localhost:4701'],
  publicUrl,
  name,
  rootsTtlMs,
} = {}) {
  const log = new SlotLog({ dataDir, registries, name, rootsTtlMs });
  const hub = new EventHub({ snapshot: () => log.info() });
  log.onEvent = (type, data) => hub.publish(type, data);
  const server = await listen(createLogApp({ log, hub }), { port, host });
  const actualPort = server.address().port;
  log.publicUrl = baseUrl(publicUrl ?? `http://localhost:${actualPort}`);
  let closing;
  return {
    url: log.publicUrl,
    port: actualPort,
    log,
    server,
    close: () => (closing ??= Promise.all([closeServer(server, hub), log.idle()]).then(() => {})),
  };
}
