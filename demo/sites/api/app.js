// Bolt API: an Express app with the Fuse gateway as middleware. /v1/status
// is registered before the gateway, so it stays public; every other /v1/*
// route sits behind the spec gate and a Fuse pass.
import { join } from 'node:path';
import express from 'express';
import { NETWORK } from '@fuse/core';
import { fuseGateway } from '@fuse/gateway';
import { listen } from '../shared.js';
import { docsPage } from './docs.js';
import { search, summarize } from './engine.js';

/** What /v1/* may look like. Anything else is refused before proof work. */
export const API_SPEC = {
  routes: [
    {
      method: 'GET',
      path: '/v1/search',
      query: { q: { required: true, maxLength: 200 }, limit: { pattern: '[1-9]|1[0-9]|20' } },
    },
    {
      method: 'POST',
      path: '/v1/summarize',
      contentTypes: ['application/json'],
      maxBodyBytes: 32 * 1024,
      fields: { text: { type: 'string', required: true, maxLength: 20000 }, sentences: { type: 'number' } },
    },
    { method: 'GET', path: '/v1/me' },
  ],
  allowUnknownQuery: false,
};

const PROTECTED_ROUTES = API_SPEC.routes.map((r) => r.path);

/**
 * Start Bolt API on host:port. The site answers on `origins` (default
 * http://api.localhost:<port>: its own host name, so browsers keep its
 * cookies apart from other demo sites on this machine). Its reputation store
 * persists in dataDir/api when dataDir is given. `onEvent` receives gateway events.
 * @returns {Promise<{ url: string, port: number, gateway: object, close(): Promise<void> }>}
 *   url is origins[0]; port is where it listens
 */
export async function startApi({
  port = 4720,
  host = process.env.FUSE_BIND || '127.0.0.1',
  registryUrl = 'http://localhost:4701',
  logUrl = 'http://localhost:4702',
  registryHint,
  dataDir,
  installUrl,
  onEvent,
  origins,
} = {}) {
  const hint = registryHint ?? registryUrl;
  // The gateway is created once the port is bound (the default origin names
  // it); the listen callback runs before any request can arrive.
  let gateway;

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*'); // demo setting, as for every Fuse service
    next();
  });

  // Examples name the origin the reader used if it is one of ours, else the canonical one.
  const base = (req) => gateway.gateway.originForHost(req.headers.host) ?? gateway.gateway.config.origins[0];

  app.get('/', (req, res) => res.type('html').send(docsPage({ base: base(req), registry: hint })));

  app.get('/v1/status', (req, res) => {
    res.json({
      ok: true,
      service: 'Bolt API',
      version: '1.0.0',
      time: new Date().toISOString(),
      fuse: { network: NETWORK, registry: hint, origins: gateway.gateway.config.origins, protected: PROTECTED_ROUTES },
    });
  });

  app.use((req, res, next) => gateway(req, res, next));
  app.use(express.json({ limit: '32kb' }));

  app.get('/v1/search', (req, res) => {
    const started = performance.now();
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    const results = search(req.query.q, limit);
    res.json({ query: req.query.q, results, tookMs: Math.round((performance.now() - started) * 100) / 100, caller: req.fuse.short });
  });

  app.post('/v1/summarize', (req, res) => {
    const { text, sentences = 2 } = req.body;
    if (!Number.isInteger(sentences) || sentences < 1 || sentences > 5) {
      return res.status(400).json({ error: 'invalid-request', detail: 'sentences must be an integer from 1 to 5' });
    }
    const result = summarize(text, sentences);
    res.json({
      summary: result.summary,
      sentences: result.sentences,
      stats: { inputSentences: result.inputSentences, inputWords: result.inputWords, keptSentences: result.sentences.length },
      caller: req.fuse.short,
    });
  });

  app.get('/v1/me', (req, res) => {
    res.json({
      ...req.fuse,
      site: 'Bolt API',
      note: 'This is everything Bolt knows about you. Other sites see a different, unlinkable pseudonym.',
    });
  });

  app.use((req, res) => res.status(404).json({ error: 'not-found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: status === 500 ? 'internal-error' : err.type ?? 'bad-request' });
  });

  const server = await listen(app, port, host);
  try {
    gateway = fuseGateway({
      siteName: 'Bolt API',
      origins: origins?.length ? origins : [`http://api.localhost:${server.port}`],
      protect: ['/v1/*'],
      registries: [registryUrl],
      registryHint: hint,
      log: logUrl,
      dataDir: dataDir ? join(dataDir, 'api') : undefined,
      installUrl,
      onEvent,
      spec: API_SPEC,
    });
  } catch (err) {
    await server.close();
    throw err;
  }
  return {
    url: gateway.gateway.config.origins[0],
    port: server.port,
    gateway: gateway.gateway,
    async close() {
      gateway.close();
      await server.close();
    },
  };
}
