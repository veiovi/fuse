// @fuse/registry: the deposit-backed membership registry (docs/protocol.md §6).
// Members lock a simulated deposit; their rate commitment becomes a leaf of the
// Merkle tree that every Fuse proof shows membership in.
import express from 'express';
import { EventHub } from './events.js';
import { baseUrl, bodyOf, closeServer, cors, errorHandler, jsonBody, listen, notFound } from './http.js';
import { Registry } from './registry.js';

export { CURRENCY, DEFAULT_TIERS, MAX_VALID_ROOTS, Registry, RegistryError } from './registry.js';
export { EventHub } from './events.js';

/**
 * Express app serving one Registry's HTTP API and SSE stream.
 * @param {{ registry: Registry, hub: EventHub }} deps
 */
export function createRegistryApp({ registry, hub }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
  app.use(jsonBody);
  app.get('/info', (req, res) => res.json(registry.info()));
  app.get('/tree', (req, res) => res.json(registry.treeView()));
  app.get('/roots', (req, res) => res.json(registry.rootsView()));
  app.get('/members', (req, res) => res.json(registry.membersView()));
  app.post('/deposits', (req, res) => res.status(201).json(registry.deposit(bodyOf(req))));
  app.post('/slash', (req, res) => res.json(registry.slash(bodyOf(req))));
  app.post('/withdraw', (req, res) => res.json(registry.withdraw(bodyOf(req))));
  app.get('/events', hub.handler);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/**
 * Start a registry server.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host] bind address (FUSE_BIND, else 127.0.0.1)
 * @param {string} [options.dataDir] persist to dataDir/registry.json; omit for in-memory
 * @param {string} [options.publicUrl] URL clients use (default http://localhost:<port>)
 * @param {{id: string, deposit: number, limit: number}[]} [options.tiers]
 * @param {number} [options.capacity] maximum number of members (default 2^20)
 * @param {string} [options.name]
 * @returns {Promise<{ url: string, port: number, registry: Registry, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function startRegistry({
  port = 4701,
  host = process.env.FUSE_BIND || '127.0.0.1',
  dataDir,
  publicUrl,
  tiers,
  capacity,
  name,
} = {}) {
  const registry = new Registry({ dataDir, tiers, capacity, name });
  const hub = new EventHub({ snapshot: () => registry.info() });
  registry.onEvent = (type, data) => hub.publish(type, data);
  const server = await listen(createRegistryApp({ registry, hub }), { port, host });
  const actualPort = server.address().port;
  let closing;
  return {
    url: baseUrl(publicUrl ?? `http://localhost:${actualPort}`),
    port: actualPort,
    registry,
    server,
    close: () => (closing ??= closeServer(server, hub)),
  };
}
