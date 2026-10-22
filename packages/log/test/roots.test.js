import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { toHex } from '@fuse/core';
import { RegistryRoots } from '../src/index.js';

const [A, B, C] = [1n, 2n, 3n].map(toHex);

/**
 * A stand-in registry serving GET /roots from a mutable list and counting
 * fetches. Each answer is the list as it was when the request arrived; set
 * `hold` to a promise to delay answers.
 */
async function stubRegistry() {
  const stub = { valid: [], fetches: 0, hold: null };
  const server = createServer(async (req, res) => {
    stub.fetches++;
    const valid = [...stub.valid];
    await stub.hold;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ current: valid[0], valid }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((resolve) => server.close(resolve));
  return stub;
}

/** A fake clock whose waits advance it instantly. */
function fakeTime() {
  const time = { now: 0, waits: [] };
  time.options = {
    now: () => time.now,
    wait: async (ms) => {
      time.waits.push(ms);
      time.now += ms;
    },
  };
  return time;
}

describe('registry root cache', () => {
  let first;
  let second;
  before(async () => {
    [first, second] = [await stubRegistry(), await stubRegistry()];
  });
  after(async () => {
    await first.close();
    await second.close();
  });

  test('reuses copies for the TTL and refetches on a miss at most once per interval', async () => {
    const time = fakeTime();
    first.valid = [A];
    first.fetches = 0;
    const roots = new RegistryRoots([first.url], { ttlMs: 2000, minRefetchMs: 1000, ...time.options });
    assert.equal(await roots.registryFor(A), first.url);
    time.now = 500;
    assert.equal(await roots.registryFor(A), first.url);
    assert.equal(first.fetches, 1, 'a copy younger than the TTL is reused');

    // A member joins: its root arrives by a refetch held back to 1 s after the last fetch.
    first.valid = [B, A];
    assert.equal(await roots.registryFor(B), first.url);
    assert.deepEqual([first.fetches, time.waits, time.now], [2, [500], 1000]);

    // A flood of unknown roots shares a single refetch per interval.
    time.now = 1200;
    const flood = await Promise.all(Array.from({ length: 25 }, () => roots.registryFor(C)));
    assert.ok(flood.every((url) => url === null));
    assert.deepEqual([first.fetches, time.waits, time.now], [3, [500, 800], 2000]);

    // A lookup that starts after the latest fetch does not refetch on a miss.
    assert.equal(await roots.registryFor(C), null);
    assert.equal(first.fetches, 3);

    // Past the TTL the copy is refreshed without waiting.
    time.now = 4500;
    assert.equal(await roots.registryFor(B), first.url);
    assert.deepEqual([first.fetches, time.waits.length], [4, 2]);
  });

  test('concurrent lookups share one fetch', async () => {
    first.valid = [A];
    first.fetches = 0;
    const roots = new RegistryRoots([first.url]);
    const found = await Promise.all(Array.from({ length: 20 }, () => roots.registryFor(A)));
    assert.ok(found.every((url) => url === first.url));
    assert.equal(first.fetches, 1);
  });

  test('invalidate() refetches at once and drops answers from before it', async () => {
    first.valid = [A];
    first.fetches = 0;
    let release;
    first.hold = new Promise((resolve) => (release = resolve));
    const roots = new RegistryRoots([first.url]);
    const early = roots.registryFor(A); // its answer, [A], is held back
    while (first.fetches === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    first.valid = []; // the registry removes A, as a slash does
    first.hold = null;
    roots.invalidate();
    assert.equal(await roots.registryFor(A), null, 'a new fetch, not the stale one in flight');
    assert.equal(first.fetches, 2);
    release();
    assert.equal(await early, null, 'the stale answer never counts');
  });

  test('accepts the union of registries and names the one that vouched', async () => {
    first.valid = [A];
    second.valid = [B];
    const roots = new RegistryRoots([first.url, second.url], fakeTime().options);
    assert.equal(await roots.registryFor(A), first.url);
    assert.equal(await roots.registryFor(B), second.url);
    assert.equal(await roots.registryFor(C), null);
  });

  test('an unreachable registry vouches for nothing and is reported', async () => {
    const dead = await stubRegistry();
    await dead.close();
    second.valid = [B];
    const roots = new RegistryRoots([dead.url, second.url], { timeoutMs: 1000, ...fakeTime().options });
    assert.equal(await roots.registryFor(B), second.url);
    assert.equal(await roots.registryFor(A), null);
    assert.equal(roots.errors().length, 1);
    assert.ok(roots.errors()[0].startsWith(dead.url));
  });
});
