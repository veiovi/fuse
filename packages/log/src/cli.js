#!/usr/bin/env node
// fuse-log: run the shared Fuse slot-tag log until interrupted.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startLog } from './index.js';

const USAGE = `Usage: fuse-log [--port 4702] [--host 127.0.0.1] [--data DIR] [--registry URL[,URL]] [--public-url URL]

  --port        TCP port (default 4702)
  --host        bind address (default $FUSE_BIND or 127.0.0.1)
  --data        directory for entries.jsonl, revocations.jsonl, log-key.pem
                (default: in-memory with a throwaway signing key)
  --registry    registry base URL(s) whose valid roots are accepted; comma-separated
                or repeated (default http://localhost:4701)
  --public-url  URL advertised to clients (default http://localhost:<port>)`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      data: { type: 'string' },
      registry: { type: 'string', multiple: true },
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

const port = values.port === undefined ? 4702 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port: ${values.port}`);
  process.exit(2);
}
const registries = (values.registry ?? [])
  .flatMap((v) => v.split(','))
  .map((v) => v.trim())
  .filter(Boolean);

const log = await startLog({
  port,
  host: values.host,
  dataDir: values.data,
  registries: registries.length ? registries : undefined,
  publicUrl: values['public-url'],
});
const storage = values.data ? `data: ${resolve(values.data)}` : 'in-memory';
console.log(`fuse-log listening on ${log.url} (${storage}; registries: ${log.log.registries.join(', ')})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await log.close();
    process.exit(0);
  });
}
