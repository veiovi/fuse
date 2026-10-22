import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { RootCache } from '../src/upstreams.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

/** Registry stub whose valid roots the test can change; counts /roots fetches. */
async function stubRegistry(roots) {
  const state = { roots, fetches: 0 };
  const server = http.createServer((req, res) => {
    state.fetches += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ current: state.roots[0], valid: state.roots }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

test('a member who joined just after the last fetch is accepted', async () => {
  const registry = await stubRegistry(['0x01']);
  const cache = new RootCache({ registries: [registry.url] });
  assert.deepEqual(await cache.check('0x01'), { ok: true, registry: registry.url });
  registry.state.roots = ['0x02', '0x01']; // a new member moved the root
  assert.deepEqual(await cache.check('0x02'), { ok: true, registry: registry.url });
});

test('unknown roots never fetch more than once per minRefetchMs', async () => {
  const registry = await stubRegistry(['0x01']);
  const cache = new RootCache({ registries: [registry.url], minRefetchMs: 100 });
  const started = Date.now();
  const burst = await Promise.all(Array.from({ length: 20 }, () => cache.check('0x99')));
  assert.ok(burst.every((r) => r.reason === 'unknown-root'));
  for (let i = 0; i < 5; i++) assert.equal((await cache.check('0x99')).reason, 'unknown-root');
  const elapsed = Date.now() - started;
  assert.ok(
    registry.state.fetches <= 2 + Math.ceil(elapsed / 100),
    `${registry.state.fetches} fetches in ${elapsed} ms`,
  );
});

test('an unreachable registry is reported as unavailable', async () => {
  const cache = new RootCache({ registries: ['http://127.0.0.1:9'], minRefetchMs: 10 });
  assert.deepEqual(await cache.check('0x01'), { ok: false, reason: 'registry-unavailable' });
});
