// Fuse network explorer. One origin for the browser: aggregates the registry,
// the shared log and every site's gateway into /api/state, merges their event
// streams into /api/events, runs demo scenarios, and serves the page.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHub } from './hub.js';
import { renderInstallPage } from './install.js';
import { createScenarioRunner } from './scenarios.js';
import { followSources } from './sources.js';
import { createStateCollector } from './state.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
// The page imports the same SSE client the server uses. (sendFile gets a root:
// with an absolute path, `send` would refuse checkouts under a dot-directory.)
const srcDir = fileURLToPath(new URL('./', import.meta.url));

/** Upstream events kept per source for /api/state ("recent gateway events"). */
const RECENT_PER_SOURCE = 60;
const UNREMEMBERED = new Set(['hello', 'source-status']);

/**
 * startExplorer({ port, host, registryUrl, logUrl, sites, scenarios, links }) → { url, close() }
 *
 * registryUrl, logUrl and sites[].url are the internal URLs the explorer
 * fetches from. sites[].publicUrl and links.{registry,log} are what the page
 * links to; they default to the internal URLs.
 */
export async function startExplorer({
  port = 4700,
  host = '127.0.0.1',
  registryUrl,
  logUrl,
  sites = [],
  scenarios = [],
  links = {},
  reconnect,
} = {}) {
  if (!registryUrl || !logUrl) throw new TypeError('startExplorer needs registryUrl and logUrl');
  registryUrl = trimSlash(registryUrl);
  logUrl = trimSlash(logUrl);
  const siteList = sites.map((site) => ({
    id: site.id,
    name: site.name ?? site.id,
    url: trimSlash(site.url),
    publicUrl: trimSlash(site.publicUrl ?? site.url),
    mode: site.mode ?? 'proxy',
  }));
  const pageLinks = {
    ...links,
    registry: trimSlash(links.registry ?? registryUrl),
    log: trimSlash(links.log ?? logUrl),
  };
  const bootId = randomUUID();

  const hub = createHub();
  const recent = new Map();
  const publish = (event) => {
    if (event.type === 'hello' && Array.isArray(event.recent)) {
      // Gateways open their stream with their own recent events: start from those.
      const seeded = event.recent.filter((e) => e && typeof e === 'object').map((e) => ({ ...e, source: event.source }));
      recent.set(event.source, seeded.slice(-RECENT_PER_SOURCE));
    } else if (!UNREMEMBERED.has(event.type) && event.source !== 'explorer') {
      const list = recent.get(event.source) ?? [];
      list.push(event);
      if (list.length > RECENT_PER_SOURCE) list.shift();
      recent.set(event.source, list);
    }
    hub.publish(event);
  };

  const follower = followSources(
    [
      { id: 'registry', url: `${registryUrl}/events` },
      { id: 'log', url: `${logUrl}/events` },
      ...siteList.map((site) => ({ id: site.id, url: `${site.url}/.fuse/events` })),
    ],
    { publish, reconnect },
  );

  const runner = createScenarioRunner({
    scenarios,
    publish,
    context: {
      registryUrl,
      logUrl,
      sites: Object.fromEntries(siteList.map((site) => [site.id, site.url])),
    },
  });

  const collector = createStateCollector({
    registryUrl,
    logUrl,
    sites: siteList,
    extras: () => ({ sources: follower.status(), scenario: runner.current() }),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.set({ 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    next();
  });

  app.get('/api/state', async (req, res) => {
    const state = await collector.collect();
    res.json({
      ...state,
      bootId,
      links: pageLinks,
      registry: { ...state.registry, publicUrl: pageLinks.registry },
      log: { ...state.log, publicUrl: pageLinks.log },
      sites: state.sites.map((site) => ({ ...site, recentEvents: recent.get(site.id) ?? [] })),
    });
  });

  app.get('/api/events', (req, res) => {
    hub.attach(req, res, {
      type: 'hello',
      at: new Date().toISOString(),
      source: 'explorer',
      bootId,
      sources: follower.status(),
      scenario: runner.current(),
    });
  });

  app.get('/api/scenarios', (req, res) => {
    res.json({ scenarios: runner.list(), current: runner.current() });
  });

  app.post('/api/scenarios/:id/run', (req, res) => {
    const { status, body } = runner.start(req.params.id);
    res.status(status).json(body);
  });

  app.get('/install', (req, res) => {
    res.type('html').send(renderInstallPage({ sites: siteList, links: pageLinks }));
  });

  app.get('/sse.js', (req, res) => res.type('text/javascript').sendFile('sse.js', { root: srcDir }));
  app.use(express.static(publicDir));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'explorer-error', message: err.message });
  });

  const server = createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // The subscriptions are already retrying; stop them or they keep the process alive.
    follower.close();
    hub.close();
    await runner.close({ timeoutMs: 0 });
    throw err;
  }

  let closing = null;
  return {
    url: `http://${displayHost(host)}:${server.address().port}`,
    close() {
      closing ??= (async () => {
        follower.close();
        await runner.close();
        hub.close();
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

function trimSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

function displayHost(host) {
  if (['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost'].includes(host)) return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}
