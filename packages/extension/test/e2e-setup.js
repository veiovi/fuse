// Fuse services for the e2e test: the real registry, log and gateways when
// they are installed and start, otherwise the stubs in stubs.js.
//
// Each site gets its own host name (*.localhost resolves to loopback in
// Chromium), as the demo does, because browsers share cookies across ports
// on one host; each gateway is told exactly which origin it serves.
import { createServer } from 'node:http';
import { startStubGateway, startStubRegistry } from './stubs.js';

const PROTECTED_PATH = '/members';
const SITE_HOSTS = ['site-a.localhost', 'site-b.localhost'];

async function closeAll(closers) {
  for (const close of closers.reverse()) await close().catch(() => {});
}

function membersPage(siteName, short) {
  return `<!doctype html><meta charset="utf-8"><title>${siteName}</title><h1 id="protected">Members area</h1><p>Signed in as <span id="pseudonym">${short}</span></p>`;
}

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

async function startStubSetup() {
  const closers = [];
  try {
    const registry = await startStubRegistry();
    closers.push(registry.close);
    const sites = [];
    for (const host of SITE_HOSTS) {
      const site = await startStubGateway({
        registry: registry.url,
        siteName: host,
        protectedPath: PROTECTED_PATH,
        origins: (port) => [`http://${host}:${port}`],
      });
      closers.push(site.close);
      sites.push({ url: site.url + PROTECTED_PATH });
    }
    return { kind: 'stubs', registryUrl: registry.url, logUrl: null, sites, close: () => closeAll(closers) };
  } catch (err) {
    await closeAll(closers);
    throw err;
  }
}

/** Real registry and log; site A behind the reverse-proxy gateway, site B with the Express middleware. */
async function startRealSetup() {
  const [{ startRegistry }, { startLog }, { fuseGateway, startProxyGateway }, { default: express }] = await Promise.all([
    import('@fuse/registry'),
    import('@fuse/log'),
    import('@fuse/gateway'),
    import('express'),
  ]);
  const closers = [];
  try {
    const registry = await startRegistry({ port: 0 });
    closers.push(registry.close);
    const log = await startLog({ port: 0, registries: [registry.url] });
    closers.push(log.close);
    const options = { registries: [registry.url], log: log.url, protect: [PROTECTED_PATH] };

    const upstream = await listen((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(membersPage('Proxied site', req.headers['x-fuse-pseudonym-short'] ?? 'nobody'));
    });
    closers.push(upstream.close);
    const proxied = await startProxyGateway({
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
      siteName: 'Proxied site',
      origins: (port) => [`http://${SITE_HOSTS[0]}:${port}`],
      ...options,
    });
    closers.push(proxied.close);

    // The middleware needs its origin up front, so bind first and mount the gateway once the port is known.
    let gateway = null;
    const app = express();
    app.use((req, res, next) => gateway(req, res, next));
    app.get(PROTECTED_PATH, (req, res) => res.send(membersPage('Middleware site', req.fuse.short)));
    const direct = await listen(app);
    const directOrigin = `http://${SITE_HOSTS[1]}:${direct.port}`;
    gateway = fuseGateway({ siteName: 'Middleware site', origins: [directOrigin], ...options });
    closers.push(async () => {
      gateway.close();
      await direct.close();
    });

    return {
      kind: 'real @fuse/registry, @fuse/log, @fuse/gateway (proxy + middleware)',
      registryUrl: registry.url,
      logUrl: log.url,
      sites: [{ url: `${proxied.url}${PROTECTED_PATH}` }, { url: `${directOrigin}${PROTECTED_PATH}` }],
      close: () => closeAll(closers),
    };
  } catch (err) {
    await closeAll(closers);
    throw err;
  }
}

export async function startFuseSetup({ stubsOnly = false } = {}) {
  if (!stubsOnly) {
    try {
      return await startRealSetup();
    } catch (err) {
      console.log(`[e2e] real registry/log/gateway unavailable (${err.message}); using stubs`);
    }
  }
  return startStubSetup();
}
