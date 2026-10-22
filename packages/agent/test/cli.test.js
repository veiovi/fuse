// The fuse CLI as a user runs it: one process per command, wallet on disk.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { releaseProver } from '@fuse/core/node';
import { startStubGateway, startStubRegistry } from './helpers/stubs.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
let registry;
let site;
let dir;
let wallet;

/** Run the CLI with FUSE_WALLET set; resolves { code, stdout, stderr } whatever the exit status. */
function fuse(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, FUSE_WALLET: wallet } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

before(async () => {
  registry = await startStubRegistry();
  site = await startStubGateway({ registry });
  dir = await mkdtemp(join(tmpdir(), 'fuse-cli-test-'));
  wallet = join(dir, 'wallet.json');
});

after(async () => {
  await Promise.all([registry.close(), site.close()]);
  await rm(dir, { recursive: true, force: true });
  await releaseProver();
});

test('init creates a private wallet and refuses to replace it', async () => {
  const first = await fuse('init', '--registry', registry.url, '--tier', 'tiny');
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /new tiny credential · 2 slots\/day/);
  assert.equal((await stat(wallet)).mode & 0o777, 0o600);
  const again = await fuse('init', '--registry', registry.url);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('fetch proves on first contact, then rides the saved session', async () => {
  const first = await fuse('fetch', `${site.url}/me`);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /spending slot 0 · 1 of 2 left today/);
  assert.match(first.stderr, /✓ proved in \d+ ms · this site knows you as anon-[0-9a-f]{8}/);
  const body = JSON.parse(first.stdout);

  const second = await fuse('fetch', '-i', '-d', 'q=1', '-H', 'X-Trace: t1', `${site.url}/v1/echo`);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /session cookie reused · no slot spent/);
  assert.match(second.stdout, /^HTTP\/1\.1 200 OK\n/);
  const echoed = JSON.parse(second.stdout.slice(second.stdout.indexOf('\n\n') + 2));
  assert.deepEqual([echoed.method, echoed.body], ['POST', 'q=1']);

  const pseudonym = await fuse('pseudonym', site.url, '--json');
  assert.equal(JSON.parse(pseudonym.stdout).pseudonym, body.pseudonym);
});

test('status and history report the spent slot', async () => {
  const status = JSON.parse((await fuse('status', '--json')).stdout);
  assert.deepEqual([status.used, status.remaining, status.sites.length], [1, 1, 1]);
  const history = await fuse('history');
  assert.match(history.stdout, new RegExp(`${site.url}\\s+0\\s+\\d+ ms\\s+200\\s+anon-`));
});

test('exit status 3 when the budget is gone, 4 when banned', async () => {
  const pseudonym = JSON.parse((await fuse('pseudonym', site.url, '--json')).stdout).pseudonym;
  site.endSessions();
  site.ban(pseudonym);
  const banned = await fuse('fetch', `${site.url}/me`);
  assert.equal(banned.code, 4, banned.stderr);
  assert.match(banned.stderr, /banned at .* as anon-/);
  const exhausted = await fuse('fetch', `${site.url}/me`);
  assert.equal(exhausted.code, 3, exhausted.stderr);
  assert.match(exhausted.stderr, /budget exhausted.*nothing was sent/);
});

test('usage errors exit with status 2', async () => {
  assert.equal((await fuse('nonsense')).code, 2);
  assert.equal((await fuse('fetch')).code, 2);
  const help = await fuse('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /fuse fetch <url>/);
});
