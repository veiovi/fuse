import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { allocateSlot, createIdentity, createWallet } from '@fuse/core';
import { WalletStore, mergeSpent } from '../src/wallet-store.js';

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fuse-wallet-test-'));
});
after(() => rm(dir, { recursive: true, force: true }));

const newWallet = (limit = 10) =>
  createWallet({ secret: createIdentity().secret, registry: 'http://registry.test', index: 0, limit, tier: 'starter' });

describe('WalletStore', () => {
  test('writes a 0600 file inside a new 0700 directory, atomically', async () => {
    const path = join(dir, 'a', 'b', 'wallet.json');
    const store = new WalletStore(path);
    assert.equal(await store.exists(), false);
    assert.equal(await store.read(), null);
    const wallet = newWallet();
    await store.commit(wallet);
    assert.equal(await store.exists(), true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'a', 'b'))).mode & 0o777, 0o700);
    assert.deepEqual(await store.read(), wallet);
    wallet.history.push({ note: 'second write' });
    await store.commit(wallet);
    assert.deepEqual((await store.read()).history, [{ note: 'second write' }]);
    assert.deepEqual(await readdir(join(dir, 'a', 'b')), ['wallet.json'], 'no temp or lock files left behind');
  });

  test('commit returns what the change returned', async () => {
    const store = new WalletStore(join(dir, 'result.json'));
    const wallet = newWallet();
    assert.equal(await store.commit(wallet, (w) => allocateSlot(w, 5)), 0);
    assert.deepEqual((await store.read()).spent, { 5: [0] });
  });

  test('two processes sharing a wallet never get the same slot', async () => {
    const path = join(dir, 'shared.json');
    const wallet = newWallet(50);
    await new WalletStore(path).commit(wallet);
    // Two independent stores and in-memory copies stand in for two processes.
    const copies = [structuredClone(wallet), structuredClone(wallet)];
    const stores = [new WalletStore(path), new WalletStore(path)];
    const slots = await Promise.all(
      Array.from({ length: 20 }, (_, i) => stores[i % 2].commit(copies[i % 2], (w) => allocateSlot(w, 9))),
    );
    assert.equal(new Set(slots).size, 20, `duplicate slot handed out: ${slots}`);
    assert.equal((await new WalletStore(path).read()).spent[9].length, 20);
  });

  test('refuses to overwrite a file that holds another credential', async () => {
    const path = join(dir, 'other.json');
    await new WalletStore(path).commit(newWallet());
    await assert.rejects(new WalletStore(path).commit(newWallet()), /different credential/);
  });

  test('a stale lock left by a crash is broken', async () => {
    const path = join(dir, 'stale.json');
    await writeFile(`${path}.lock`, '99999\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    await new WalletStore(path).commit(newWallet());
    assert.equal(await new WalletStore(path).exists(), true);
  });

  test('reports a corrupt wallet file instead of replacing it', async () => {
    const path = join(dir, 'corrupt.json');
    await writeFile(path, '{ not json');
    await assert.rejects(new WalletStore(path).read(), /not valid JSON/);
    await assert.rejects(new WalletStore(path).commit(newWallet()), /not valid JSON/);
  });

  test('without a path the wallet stays in memory', async () => {
    const store = new WalletStore();
    const wallet = newWallet();
    assert.equal(store.persistent, false);
    assert.equal(await store.commit(wallet, (w) => allocateSlot(w, 1)), 0);
    assert.equal(await store.read(), null);
  });
});

test('mergeSpent unions reservations per epoch', () => {
  const a = newWallet();
  const b = structuredClone(a);
  a.spent = { 7: [0, 2] };
  b.spent = { 7: [1, 2], 8: [0] };
  mergeSpent(a, b);
  assert.deepEqual(a.spent, { 7: [0, 1, 2], 8: [0] });
});
