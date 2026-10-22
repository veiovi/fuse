#!/usr/bin/env node
// fuse-gateway: run the Fuse gateway as a reverse proxy in front of any HTTP app.
//
//   fuse-gateway --port 4710 --upstream http://127.0.0.1:4711 --protect /new,/posts,/me \
//     --registry http://localhost:4701 --log http://localhost:4702 --site-name "Acme Forum" \
//     [--origin http://forum.localhost:4710] [--data DIR]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startProxyGateway } from './index.js';

const USAGE = `Usage: fuse-gateway --upstream URL --protect PATHS --registry URL --log URL [options]

  --port N             listen port (default 4710)
  --host ADDR          bind address (default $FUSE_BIND or 127.0.0.1)
  --upstream URL       the app to protect, e.g. http://127.0.0.1:4711
  --protect LIST       comma-separated paths or prefixes, e.g. /new,/posts,/me,/api/*
  --registry URL       registry whose roots to accept (repeat or comma-separate for several)
  --registry-hint URL  registry URL to advertise to clients (default: the first --registry)
  --log URL            shared log
  --site-name NAME     shown on the interstitial and the moderator page
  --origin URL[,URL]   origins clients reach the site by (repeatable; default http://localhost:<port>).
                       Proofs are accepted only for these; other Host names are redirected (GET) or get 421.
  --data DIR           persist the reputation store in DIR
  --cookie-name NAME   session cookie name (default fuse_<site id prefix>)
  --cache-ttl SECONDS  public GET cache lifetime (default 30, 0 disables)
  --install-url URL    where the interstitial sends people for the extension
  --spec FILE          JSON spec for the spec gate
`;

const list = (values = []) => values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

function fail(message) {
  console.error(`fuse-gateway: ${message}\n\n${USAGE}`);
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: 'string', default: '4710' },
      host: { type: 'string' },
      upstream: { type: 'string' },
      protect: { type: 'string', multiple: true },
      registry: { type: 'string', multiple: true },
      'registry-hint': { type: 'string' },
      log: { type: 'string' },
      'site-name': { type: 'string' },
      origin: { type: 'string', multiple: true },
      data: { type: 'string' },
      'cookie-name': { type: 'string' },
      'cache-ttl': { type: 'string' },
      'install-url': { type: 'string' },
      spec: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(err.message);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.upstream) fail('--upstream is required');
if (!args.log) fail('--log is required');
const registries = list(args.registry);
if (registries.length === 0) fail('--registry is required');

let spec;
if (args.spec) {
  try {
    spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  } catch (err) {
    fail(`cannot read spec ${args.spec}: ${err.message}`);
  }
}

const proxy = await startProxyGateway({
  port: Number(args.port),
  ...(args.host ? { host: args.host } : {}),
  upstream: args.upstream,
  protect: list(args.protect),
  registries,
  registryHint: args['registry-hint'],
  log: args.log,
  siteName: args['site-name'] ?? 'Fuse site',
  origins: list(args.origin),
  dataDir: args.data,
  cookieName: args['cookie-name'],
  cacheTtlSeconds: args['cache-ttl'] === undefined ? 30 : Number(args['cache-ttl']),
  installUrl: args['install-url'],
  spec,
});

console.log(`fuse-gateway: ${proxy.gateway.config.origins.join(', ')} → ${args.upstream}`);
console.log(`  protected: ${list(args.protect).join(', ') || '(nothing)'}`);
console.log(`  moderator: ${proxy.url}/.fuse/admin`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await proxy.close();
    process.exit(0);
  });
}
