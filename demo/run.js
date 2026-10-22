#!/usr/bin/env node
// One-command Fuse demo: the registry, the shared log, Acme Forum (gateway as
// a reverse proxy), Bolt API (gateway as middleware) and the explorer, all in
// one process.
//
//   npm run demo                 start, keeping state in <repo>/.data
//   npm run demo -- --reset      wipe the data dir first
//
// Environment:
//   FUSE_BIND          bind address for every server (default 127.0.0.1)
//   FUSE_DATA_DIR      state directory (default <repo>/.data)
//   FUSE_PUBLIC_BASE   e.g. https://myhost.tailnet.ts.net; public URLs (links,
//                      the registry hint, the install URL) become <base>:<port>
//   FUSE_EXPLORER_PORT, FUSE_REGISTRY_PORT, FUSE_LOG_PORT, FUSE_FORUM_PORT,
//   FUSE_FORUM_UPSTREAM_PORT, FUSE_API_PORT   override the default ports
//
// The two sites live on their own host names (http://forum.localhost:4710,
// http://api.localhost:4720) so browsers keep their cookies apart; *.localhost
// resolves to loopback. Services always reach each other over those local
// names and http://localhost:<port>, whatever the public base is (or over
// FUSE_BIND when it names one specific non-loopback address).
import { realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProver } from '@fuse/core/node';
import { startExplorer } from '@fuse/explorer';
import { startLog } from '@fuse/log';
import { startRegistry } from '@fuse/registry';
import scenarios from './scenarios/index.js';
import { startApi } from './sites/api/app.js';
import { startForum } from './sites/forum/app.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PORTS = Object.freeze({
  explorer: 4700,
  registry: 4701,
  log: 4702,
  forum: 4710,
  forumUpstream: 4711,
  api: 4720,
});

const PORT_ENV = {
  explorer: 'FUSE_EXPLORER_PORT',
  registry: 'FUSE_REGISTRY_PORT',
  log: 'FUSE_LOG_PORT',
  forum: 'FUSE_FORUM_PORT',
  forumUpstream: 'FUSE_FORUM_UPSTREAM_PORT',
  api: 'FUSE_API_PORT',
};

const USAGE = `Usage: node demo/run.js [--reset]

Starts the Fuse demo: registry, shared log, Acme Forum, Bolt API and the explorer.
  --reset   wipe the data directory first

Environment: FUSE_BIND, FUSE_DATA_DIR, FUSE_PUBLIC_BASE, ${Object.values(PORT_ENV).join(', ')}`;

/** Demo settings from environment variables. */
export function demoConfig(env = process.env) {
  const ports = { ...DEFAULT_PORTS };
  for (const [name, variable] of Object.entries(PORT_ENV)) {
    if (!env[variable]) continue;
    const port = Number(env[variable]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${variable} must be a port number, not "${env[variable]}"`);
    }
    ports[name] = port;
  }
  return {
    bind: env.FUSE_BIND || '127.0.0.1',
    dataDir: env.FUSE_DATA_DIR || join(ROOT, '.data'),
    publicBase: env.FUSE_PUBLIC_BASE || undefined,
    ports,
  };
}

/**
 * Start every service. Returns { urls, internalUrls, dataDir, close() }:
 * `urls` are the public URLs (what a browser or another machine uses),
 * `internalUrls` what the services use to reach each other.
 */
export async function startDemo({
  bind = '127.0.0.1',
  dataDir = join(ROOT, '.data'),
  publicBase,
  ports: portOverrides = {},
  reset = false,
} = {}) {
  const ports = { ...DEFAULT_PORTS, ...portOverrides };
  const { urls, internalUrls, siteOrigins } = demoUrls({ bind, publicBase, ports });
  dataDir = resolve(dataDir);
  if (reset) await wipe(dataDir);
  await mkdir(dataDir, { recursive: true });

  const running = [];
  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      // Explorer first (it stops scenarios and its subscriptions), registry last.
      for (const service of [...running].reverse()) {
        try {
          await service.close();
        } catch (err) {
          console.error(`fuse demo: error while stopping a service: ${err.message}`);
        }
      }
      await releaseProver();
    })());

  const shared = { host: bind, registryUrl: internalUrls.registry, logUrl: internalUrls.log, registryHint: urls.registry };
  try {
    running.push(
      await startRegistry({ port: ports.registry, host: bind, dataDir: join(dataDir, 'registry'), publicUrl: urls.registry }),
    );
    running.push(
      await startLog({
        port: ports.log,
        host: bind,
        dataDir: join(dataDir, 'log'),
        registries: [internalUrls.registry],
        publicUrl: urls.log,
      }),
    );
    // The sites keep their state in <dataDir>/forum and <dataDir>/api. Each
    // picks its own *.localhost origin unless told otherwise; it reports the
    // address it settled on as `url`.
    const site = (name) => ({ ...shared, dataDir, installUrl: urls.install, ...(siteOrigins[name] && { origins: siteOrigins[name] }) });
    const forum = await startForum({ ...site('forum'), port: ports.forum, upstreamPort: ports.forumUpstream });
    running.push(forum);
    const api = await startApi({ ...site('api'), port: ports.api });
    running.push(api);
    if (!siteOrigins.forum) urls.forum = internalUrls.forum = forum.url;
    if (!siteOrigins.api) urls.api = internalUrls.api = api.url;
    running.push(
      await startExplorer({
        port: ports.explorer,
        host: bind,
        registryUrl: internalUrls.registry,
        logUrl: internalUrls.log,
        sites: [
          { id: 'forum', name: 'Acme Forum', url: internalUrls.forum, publicUrl: urls.forum, mode: 'proxy' },
          { id: 'api', name: 'Bolt API', url: internalUrls.api, publicUrl: urls.api, mode: 'middleware' },
        ],
        scenarios,
        links: { registry: urls.registry, log: urls.log },
      }),
    );
  } catch (err) {
    await close();
    throw explainStartError(err, ports);
  }

  return { urls, internalUrls, dataDir, close };
}

/**
 * For one configuration: the public URLs (links, the registry hint, the
 * install URL), the internal URLs services use to reach each other, and the
 * origins to give each site when its default (<name>.localhost) is not enough.
 */
export function demoUrls({ bind = '127.0.0.1', publicBase, ports = DEFAULT_PORTS } = {}) {
  const loopback = isLoopbackOrAny(bind);
  const host = loopback ? 'localhost' : bind.includes(':') ? `[${bind}]` : bind;
  const internal = (port, siteName) => (loopback && siteName ? `http://${siteName}.localhost:${port}` : `http://${host}:${port}`);
  const external = (port, siteName) => (publicBase ? publicUrl(publicBase, port) : internal(port, siteName));

  const siteOrigins = {};
  for (const name of ['forum', 'api']) {
    const local = internal(ports[name], name);
    const shown = external(ports[name], name);
    // A site accepts only its listed origins: the public one first (what it
    // calls itself), then the local one scenarios and the explorer use.
    if (shown !== local || !loopback) siteOrigins[name] = [...new Set([shown, local])];
  }

  return {
    urls: {
      explorer: external(ports.explorer),
      install: `${external(ports.explorer)}/install`,
      registry: external(ports.registry),
      log: external(ports.log),
      forum: external(ports.forum, 'forum'),
      forumUpstream: `http://127.0.0.1:${ports.forumUpstream}`,
      api: external(ports.api, 'api'),
    },
    internalUrls: {
      explorer: internal(ports.explorer),
      registry: internal(ports.registry),
      log: internal(ports.log),
      forum: internal(ports.forum, 'forum'),
      api: internal(ports.api, 'api'),
    },
    siteOrigins,
  };
}

function isLoopbackOrAny(host) {
  return ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(host);
}

function publicUrl(base, port) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`FUSE_PUBLIC_BASE must be a URL like https://myhost.tailnet.ts.net, not "${base}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('FUSE_PUBLIC_BASE must be an http(s) URL');
  url.port = String(port);
  return url.origin;
}

/** Remove the data directory, refusing anything that is clearly not one. */
async function wipe(dir) {
  const refused = [parse(dir).root, homedir(), ROOT];
  if (refused.includes(dir) || ROOT.startsWith(dir + sep)) {
    throw new Error(`refusing to reset ${dir}: point FUSE_DATA_DIR at a dedicated directory`);
  }
  await rm(dir, { recursive: true, force: true });
}

function explainStartError(err, ports) {
  if (err?.code === 'EADDRINUSE') {
    const name = Object.keys(ports).find((key) => ports[key] === err.port);
    const hint = name ? ` Stop whatever holds it (another demo?) or set ${PORT_ENV[name]}.` : '';
    return Object.assign(new Error(`port ${err.port} is already in use.${hint}`), { code: err.code, cause: err });
  }
  return err;
}

function banner({ urls, dataDir }) {
  const rows = [
    ['Explorer', urls.explorer, 'network view and scenario runner'],
    ['Acme Forum', urls.forum, `gateway as a reverse proxy, app on ${urls.forumUpstream}`],
    ['Bolt API', urls.api, 'gateway as Express middleware'],
    ['Registry', urls.registry, 'deposits and the membership tree'],
    ['Shared log', urls.log, 'slot tags and burned keys'],
    ['Install', urls.install, 'Chrome extension and agent SDK'],
  ];
  const width = Math.max(...rows.map(([, url]) => url.length));
  return [
    '',
    '  Fuse demo is running',
    '',
    ...rows.map(([name, url, note]) => `  ${name.padEnd(11)} ${url.padEnd(width)}   ${note}`),
    '',
    `  State: ${dataDir}  (npm run demo -- --reset starts empty)`,
    '  Ctrl+C stops everything.',
    '',
  ].join('\n');
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const unknown = args.find((arg) => arg !== '--reset');
  if (unknown) throw new Error(`unknown option ${unknown}\n\n${USAGE}`);

  const demo = await startDemo({ ...demoConfig(), reset: args.includes('--reset') });
  console.log(banner(demo));

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) process.exit(1); // a second Ctrl+C does not wait
    stopping = true;
    console.log(`\n  ${signal}: stopping…`);
    await demo.close();
    console.log('  Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

const runDirectly =
  import.meta.main ?? (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (runDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`fuse demo: ${err.message}`);
    process.exit(1);
  });
}
