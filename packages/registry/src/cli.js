#!/usr/bin/env node
// fuse-registry: run a Fuse registry server until interrupted.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startRegistry } from './index.js';

const USAGE = `Usage: fuse-registry [--port 4701] [--host 127.0.0.1] [--data DIR] [--public-url URL]

  --port        TCP port (default 4701)
  --host        bind address (default $FUSE_BIND or 127.0.0.1)
  --data        directory for registry.json (default: in-memory, lost on exit)
  --public-url  URL advertised to clients (default http://localhost:<port>)`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      data: { type: 'string' },
      'public-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = values.port === undefined ? 4701 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port: ${values.port}`);
  process.exit(2);
}

const registry = await startRegistry({
  port,
  host: values.host,
  dataDir: values.data,
  publicUrl: values['public-url'],
});
const storage = values.data ? `data: ${resolve(values.data)}` : 'in-memory';
console.log(`fuse-registry listening on ${registry.url} (${storage})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await registry.close();
    process.exit(0);
  });
}
