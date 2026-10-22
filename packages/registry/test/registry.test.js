import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  FIELD_MODULUS,
  MerkleTree,
  createFuseAuthorization,
  createIdentity,
  epochAt,
  rateCommitment,
  toField,
  toHex,
  verifyFuseToken,
} from '@fuse/core';
import { loadVerificationKey, nodeArtifacts, releaseProver } from '@fuse/core/node';
import { MAX_BUFFERED_BYTES } from '../src/events.js';
import { DEFAULT_TIERS, EventHub, MAX_VALID_ROOTS, startRegistry } from '../src/index.js';
import { client, events } from './helpers.js';

after(releaseProver);

const ZERO = toHex(0n);
const EMPTY_ROOT = toHex(MerkleTree.fromLeaves([]).root);
const hexCommitment = (identity) => toHex(identity.commitment);
const leafFor = (identity, limit) => toHex(rateCommitment(identity.commitment, limit));
const rootOf = (leaves) => toHex(MerkleTree.fromLeaves(leaves.map(toField)).root);
const isoDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

async function withRegistry(options, fn) {
  const registry = await startRegistry({ port: 0, ...options });
  try {
    await fn(client(registry.url), registry);
  } finally {
    await registry.close();
  }
}

describe('registry', () => {
  test('a deposit adds a leaf and shows up in /tree, /roots, /members and /info', () =>
    withRegistry({}, async (api) => {
      const alice = createIdentity();
      const bob = createIdentity();

      const a = await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
      assert.equal(a.status, 201);
      const rootAfterAlice = rootOf([leafFor(alice, 10)]);
      assert.equal(a.body.index, 0);
      assert.equal(a.body.leaf, leafFor(alice, 10));
      assert.equal(a.body.limit, 10);
      assert.equal(a.body.tier, 'starter');
      assert.equal(a.body.root, rootAfterAlice);
      assert.match(a.body.deposit.id, /^dep_[0-9a-f]{16}$/);
      assert.deepEqual(
        { ...a.body.deposit, id: undefined },
        { id: undefined, amount: 5, currency: 'demo credits', status: 'locked' },
      );

      const b = await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' });
      assert.equal(b.status, 201);
      assert.equal(b.body.index, 1);
      const leaves = [leafFor(alice, 10), leafFor(bob, 200)];
      const root = rootOf(leaves);
      assert.equal(b.body.root, root);

      const tree = await api.get('/tree');
      assert.deepEqual(tree.body, { depth: 20, size: 2, root, leaves });

      const roots = await api.get('/roots');
      assert.deepEqual(roots.body, { current: root, valid: [root, rootAfterAlice, EMPTY_ROOT] });

      const { members } = (await api.get('/members')).body;
      assert.deepEqual(
        members.map((m) => [m.index, m.commitment, m.tier, m.limit, m.status, m.deposit.status, m.endedAt]),
        [
          [0, hexCommitment(alice), 'starter', 10, 'active', 'locked', undefined],
          [1, hexCommitment(bob), 'pro', 200, 'active', 'locked', undefined],
        ],
      );
      assert.ok(members.every((m) => isoDate(m.joinedAt)));

      const info = (await api.get('/info')).body;
      assert.equal(info.backing, 'deposit');
      assert.equal(info.network, 'fuse-demo-v1');
      assert.equal(info.depth, 20);
      assert.equal(info.currency, 'demo credits');
      assert.deepEqual(info.tiers, DEFAULT_TIERS.map((t) => ({ ...t })));
      assert.deepEqual(
        [info.size, info.active, info.burned, info.root, info.lockedDeposits],
        [2, 2, 0, root, 55],
      );
    }));

  test('rejects bad commitments, unknown tiers, duplicates and oversized bodies', () =>
    withRegistry({}, async (api) => {
      const alice = createIdentity();
      for (const commitment of [undefined, 42, 'nope', '0x', toHex(0n), toHex(FIELD_MODULUS), '0x' + 'f'.repeat(65)]) {
        const res = await api.post('/deposits', { commitment, tier: 'starter' });
        assert.equal(res.status, 400, `commitment ${commitment}`);
        assert.equal(res.body.error, 'bad-commitment');
      }
      for (const tier of [undefined, 'gold', '']) {
        const res = await api.post('/deposits', { commitment: hexCommitment(alice), tier });
        assert.deepEqual([res.status, res.body.error], [400, 'unknown-tier']);
      }
      assert.equal((await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' })).status, 201);
      const dup = await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'pro' });
      assert.deepEqual([dup.status, dup.body.error], [409, 'already-registered']);

      const big = await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'pro', pad: 'x'.repeat(17_000) });
      assert.equal(big.status, 413);
      const garbled = await api.post('/deposits', '{"commitment":');
      assert.equal(garbled.status, 400);
      assert.equal((await api.get('/members')).body.members.length, 1);
    }));

  test('a full tree answers 507', () =>
    withRegistry({ capacity: 1 }, async (api) => {
      assert.equal((await api.post('/deposits', { commitment: hexCommitment(createIdentity()), tier: 'starter' })).status, 201);
      const full = await api.post('/deposits', { commitment: hexCommitment(createIdentity()), tier: 'starter' });
      assert.deepEqual([full.status, full.body.error], [507, 'registry-full']);
    }));

  test('slashing burns the member, zeroes its leaf and resets the valid roots', () =>
    withRegistry({}, async (api) => {
      const alice = createIdentity();
      const bob = createIdentity();
      await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
      await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' });
      const before = (await api.get('/roots')).body;
      assert.equal(before.valid.length, 3);

      const evidence = { log: 'http://log.example', shares: [{ x: '0x01', y: '0x02', seq: 0 }] };
      const slash = await api.post('/slash', { secret: toHex(alice.secret), evidence });
      assert.equal(slash.status, 200);
      const root = rootOf([ZERO, leafFor(bob, 200)]);
      assert.deepEqual(slash.body, {
        index: 0,
        commitment: hexCommitment(alice),
        root,
        slashed: { amount: 5, currency: 'demo credits' },
      });

      assert.deepEqual((await api.get('/tree')).body.leaves, [ZERO, leafFor(bob, 200)]);
      assert.deepEqual((await api.get('/roots')).body, { current: root, valid: [root] });
      const [burned] = (await api.get('/members')).body.members;
      assert.equal(burned.status, 'burned');
      assert.equal(burned.deposit.status, 'slashed');
      assert.ok(isoDate(burned.endedAt));
      assert.deepEqual(burned.evidence, evidence);

      const again = await api.post('/slash', { secret: toHex(alice.secret) });
      assert.deepEqual([again.status, again.body.alreadyBurned, again.body.index], [200, true, 0]);
      assert.deepEqual((await api.get('/roots')).body.valid, [root], 'a repeat slash changes nothing');

      const stranger = await api.post('/slash', { secret: toHex(createIdentity().secret) });
      assert.deepEqual([stranger.status, stranger.body.error], [404, 'unknown-key']);
      assert.equal((await api.post('/slash', { secret: 'not-a-key' })).status, 400);

      const rejoin = await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
      assert.deepEqual([rejoin.status, rejoin.body.error], [409, 'commitment-burned']);

      const info = (await api.get('/info')).body;
      assert.deepEqual([info.active, info.burned, info.lockedDeposits, info.slashedDeposits], [1, 1, 50, 5]);
    }));

  test('withdrawing refunds the deposit and removes the leaf', () =>
    withRegistry({}, async (api) => {
      const alice = createIdentity();
      const bob = createIdentity();
      await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
      await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' });
      await api.post('/slash', { secret: toHex(alice.secret) });

      const out = await api.post('/withdraw', { secret: toHex(bob.secret) });
      assert.equal(out.status, 200);
      assert.equal(out.body.index, 1);
      assert.deepEqual(out.body.refunded, { amount: 50, currency: 'demo credits' });
      const root = rootOf([ZERO, ZERO]);
      assert.deepEqual((await api.get('/roots')).body, { current: root, valid: [root] });
      const member = (await api.get('/members')).body.members[1];
      assert.deepEqual([member.status, member.deposit.status], ['withdrawn', 'refunded']);

      assert.deepEqual((await api.post('/withdraw', { secret: toHex(bob.secret) })).body.error, 'already-withdrawn');
      assert.deepEqual((await api.post('/withdraw', { secret: toHex(alice.secret) })).body.error, 'credential-burned');
      assert.equal((await api.post('/withdraw', { secret: toHex(createIdentity().secret) })).status, 404);

      // A withdrawn commitment may join again, at a new index.
      const rejoin = await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'starter' });
      assert.deepEqual([rejoin.status, rejoin.body.index], [201, 2]);
    }));

  test(`joins keep the newest ${MAX_VALID_ROOTS} roots valid`, () =>
    withRegistry({}, async (api) => {
      const roots = [EMPTY_ROOT];
      for (let i = 0; i < MAX_VALID_ROOTS + 6; i++) {
        roots.unshift((await api.post('/deposits', { commitment: hexCommitment(createIdentity()), tier: 'fleet' })).body.root);
      }
      const { body } = await api.get('/roots');
      assert.equal(body.current, roots[0]);
      assert.deepEqual(body.valid, roots.slice(0, MAX_VALID_ROOTS));
    }));

  test('the event stream opens with a snapshot and reports joins, slashes and withdrawals', () =>
    withRegistry({}, async (api, registry) => {
      const alice = createIdentity();
      const bob = createIdentity();
      await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
      const stream = events(`${registry.url}/events`);
      try {
        const headers = await stream.headers;
        assert.match(headers.get('content-type'), /^text\/event-stream/);
        assert.equal(headers.get('access-control-allow-origin'), '*');

        const hello = await stream.next('hello');
        assert.equal(hello.type, 'hello');
        assert.ok(isoDate(hello.at));
        assert.deepEqual([hello.size, hello.active, hello.backing], [1, 1, 'deposit']);

        const joined = (await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' })).body;
        const join = await stream.next('member-joined');
        assert.deepEqual([join.member.index, join.member.commitment, join.root, join.size], [1, hexCommitment(bob), joined.root, 2]);

        const slashed = (await api.post('/slash', { secret: toHex(alice.secret), evidence: { note: 'test' } })).body;
        const slash = await stream.next('member-slashed');
        assert.deepEqual([slash.member.status, slash.root, slash.slashed.amount], ['burned', slashed.root, 5]);

        await api.post('/withdraw', { secret: toHex(bob.secret) });
        const left = await stream.next('member-withdrawn');
        assert.deepEqual([left.member.status, left.refunded.amount], ['withdrawn', 50]);
      } finally {
        stream.close();
      }
    }));

  test('CORS: every response allows any origin and POST preflights succeed', () =>
    withRegistry({}, async (api) => {
      for (const path of ['/deposits', '/slash', '/withdraw']) {
        const res = await api.raw(path, {
          method: 'OPTIONS',
          headers: {
            Origin: 'chrome-extension://fuse',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
        assert.match(res.headers.get('access-control-allow-methods'), /POST/);
        assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);
      }
      for (const path of ['/info', '/tree', '/roots', '/members', '/missing']) {
        assert.equal((await api.get(path)).headers.get('access-control-allow-origin'), '*', path);
      }
      const refused = await api.post('/deposits', { commitment: 'bad' });
      assert.equal(refused.headers.get('access-control-allow-origin'), '*');
    }));

  test('state survives a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fuse-registry-test-'));
    try {
      const [alice, bob, carol] = [createIdentity(), createIdentity(), createIdentity()];
      let snapshot;
      await withRegistry({ dataDir }, async (api) => {
        await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
        await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' });
        await api.post('/slash', { secret: toHex(alice.secret), evidence: { reason: 'test' } });
        await api.post('/deposits', { commitment: hexCommitment(carol), tier: 'fleet' });
        snapshot = await Promise.all(['/tree', '/roots', '/members', '/info'].map(async (p) => (await api.get(p)).body));
      });
      assert.deepEqual(readdirSync(dataDir), ['registry.json'], 'no temp files left behind');
      const saved = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'));
      assert.equal(saved.members.length, 3);
      assert.equal(snapshot[1].valid.length, 2, 'the join after the slash extended the reset window');

      await withRegistry({ dataDir }, async (api) => {
        const restored = await Promise.all(['/tree', '/roots', '/members', '/info'].map(async (p) => (await api.get(p)).body));
        assert.deepEqual(restored, snapshot);
        assert.equal((await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' })).status, 409);
        assert.equal((await api.post('/slash', { secret: toHex(alice.secret) })).body.alreadyBurned, true);
        const dave = await api.post('/deposits', { commitment: hexCommitment(createIdentity()), tier: 'starter' });
        assert.equal(dave.body.index, 3);
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a failed write leaves the registry in its last saved state', { skip: process.getuid?.() === 0 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fuse-registry-test-'));
    try {
      await withRegistry({ dataDir }, async (api) => {
        const [alice, bob] = [createIdentity(), createIdentity()];
        await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' });
        const views = () => Promise.all(['/tree', '/roots', '/members'].map(async (p) => (await api.get(p)).body));
        const saved = await views();
        chmodSync(dataDir, 0o500);
        try {
          const refused = await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' });
          assert.deepEqual([refused.status, refused.body.error], [503, 'storage-unavailable']);
          assert.equal((await api.post('/slash', { secret: toHex(alice.secret) })).status, 503);
        } finally {
          chmodSync(dataDir, 0o700);
        }
        assert.deepEqual(await views(), saved);
        assert.equal((await api.post('/deposits', { commitment: hexCommitment(bob), tier: 'pro' })).status, 201);
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('event streams get keep-alive pings and end when the hub closes', async () => {
    const hub = new EventHub({ snapshot: () => ({ size: 0 }), pingMs: 20 });
    const server = createServer(hub.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/events`);
      const decoder = new TextDecoder();
      let text = '';
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes(': ping\n\n')) break;
      }
      assert.match(text, /event: hello\ndata: \{"type":"hello","at":"[^"]+","size":0\}\n\n/);
      assert.equal(hub.size, 1);
      hub.close();
      assert.equal(hub.size, 0);
    } finally {
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a subscriber that stops reading is dropped once 1 MB waits for it, while readers stay', { timeout: 10_000 }, async () => {
    const hub = new EventHub({ snapshot: () => ({}) });
    const server = createServer(hub.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const stalled = connect(port, '127.0.0.1');
    stalled.on('error', () => {});
    stalled.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    stalled.pause();
    const reader = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port, path: '/events' }, resolve).on('error', reject));
    let received = 0;
    reader.on('data', (chunk) => (received += chunk.length));
    try {
      while (hub.size < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      const blob = { blob: 'x'.repeat(16 * 1024) };
      let sent = 0;
      while (hub.size === 2 && sent < 64 * MAX_BUFFERED_BYTES) {
        for (let i = 0; i < 8; i++) hub.publish('blob', blob);
        sent += 8 * blob.blob.length;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(hub.size, 1, `the stalled subscriber is dropped (after ${sent} bytes)`);
      const connections = () => new Promise((resolve) => server.getConnections((err, n) => resolve(n)));
      while ((await connections()) > 1) await new Promise((resolve) => setTimeout(resolve, 5));
      // The one left is the reader: it keeps receiving.
      const before = received;
      hub.publish('blob', blob);
      while (received === before) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(hub.size, 1);
      assert.ok(received > MAX_BUFFERED_BYTES);
    } finally {
      reader.destroy();
      stalled.destroy();
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a credential proves membership against /tree until it is slashed', () =>
    withRegistry({}, async (api) => {
      const alice = createIdentity();
      const deposit = (await api.post('/deposits', { commitment: hexCommitment(alice), tier: 'starter' })).body;
      await api.post('/deposits', { commitment: hexCommitment(createIdentity()), tier: 'pro' });
      const { leaves } = (await api.get('/tree')).body;
      const origin = 'http://localhost:4710';
      const auth = await createFuseAuthorization({
        secret: alice.secret,
        limit: deposit.limit,
        index: deposit.index,
        leaves,
        origin,
        challenge: 'registry-test',
        epoch: epochAt(),
        slot: 0,
        artifacts: nodeArtifacts,
      });
      const verdict = await verifyFuseToken({ token: auth.token, challenge: 'registry-test', origin, vkey: loadVerificationKey() });
      assert.equal(verdict.ok, true);
      assert.ok((await api.get('/roots')).body.valid.includes(toHex(verdict.signals.root)));

      await api.post('/slash', { secret: toHex(alice.secret) });
      assert.ok(!(await api.get('/roots')).body.valid.includes(toHex(verdict.signals.root)));
    }));
});
