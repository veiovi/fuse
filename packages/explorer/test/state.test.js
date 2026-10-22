import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startExplorer } from '../src/index.js';
import { freePort, makeNetwork, startStubNetwork } from './helpers.js';

const getJson = async (url) => {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url}`);
  return res.json();
};

describe('GET /api/state', () => {
  let network, stubs, explorer;

  before(async () => {
    const [forumPort, apiPort] = [await freePort(), await freePort()];
    network = makeNetwork({
      members: 9,
      burned: 2,
      entries: 70,
      forum: `http://127.0.0.1:${forumPort}`,
      api: `http://127.0.0.1:${apiPort}`,
    });
    stubs = await startStubNetwork(network, { ports: { forum: forumPort, api: apiPort } });
    explorer = await startExplorer({ port: 0, ...stubs.explorerOptions });
  });

  after(async () => {
    await explorer?.close();
    await stubs?.close();
  });

  test('aggregates the registry, the shared log and every site', async () => {
    const state = await getJson(`${explorer.url}/api/state`);

    assert.equal(state.registry.ok, true);
    assert.equal(state.registry.info.size, 9);
    assert.equal(state.registry.members.length, 9);
    assert.equal(state.registry.publicUrl, stubs.registry.url);

    assert.equal(state.log.ok, true);
    assert.equal(state.log.info.size, network.entries.length);
    assert.equal(state.log.entries.length, 50, 'last 50 entries');
    assert.deepEqual(
      state.log.entries.map((e) => e.seq),
      network.entries.slice(-50).map((e) => e.seq),
    );
    const today = network.entries.filter((e) => e.epoch === network.epoch).length;
    assert.equal(state.log.entriesToday, today);
    assert.equal(state.log.revocations.length, 2);

    assert.deepEqual(
      state.sites.map((s) => [s.id, s.name, s.mode, s.ok]),
      [
        ['forum', 'Acme Forum', 'proxy', true],
        ['api', 'Bolt API', 'middleware', true],
      ],
    );
    assert.equal(state.sites[0].info.siteName, 'Acme Forum');
    assert.equal(state.sites[0].pseudonyms.length, 5);
    assert.deepEqual(state.sites[0].recentEvents, []);
    assert.ok(state.sources.registry, 'source status included');
    assert.equal(state.scenario, null);
  });

  test('revocations are checked and mapped to each site’s pseudonym', async () => {
    const state = await getJson(`${explorer.url}/api/state`);
    for (const rev of state.log.revocations) {
      assert.equal(rev.verified, true, 'both shares lie on one line through the key');
      assert.deepEqual(rev.pseudonyms.map((p) => p.site), ['forum', 'api']);
      for (const p of rev.pseudonyms) {
        assert.equal(p.seen, true, `${p.site} has seen the cheater`);
        assert.equal(p.banned, true);
        assert.match(p.short, /^anon-[0-9a-f]{8}$/);
      }
    }
  });

  test('follows new log entries incrementally', async () => {
    const seen = stubs.log.requests.length;
    const last = network.entries.at(-1);
    for (let i = 1; i <= 3; i++) network.entries.push({ ...last, seq: last.seq + i, epoch: network.epoch });
    network.logInfo = { ...network.logInfo, size: network.entries.length };

    await new Promise((resolve) => setTimeout(resolve, 200)); // past the snapshot cache
    const state = await getJson(`${explorer.url}/api/state`);
    assert.equal(state.log.entries.at(-1).seq, last.seq + 3);
    assert.equal(state.log.entries.length, 50);
    const entryRequests = stubs.log.requests.slice(seen).filter((r) => r.startsWith('GET /entries'));
    assert.deepEqual(entryRequests, [`GET /entries?after=${last.seq}&limit=200`]);
  });

  test('serves the page, the shared SSE module and the install guide', async () => {
    const page = await fetch(`${explorer.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Fuse/);

    for (const path of ['/sse.js', '/app.js', '/plot.js', '/format.js', '/app.css', '/favicon.svg', '/install.js']) {
      const res = await fetch(`${explorer.url}${path}`);
      assert.equal(res.status, 200, path);
      assert.ok((await res.text()).length > 100, `${path} has content`);
    }
    const sse = await fetch(`${explorer.url}/sse.js`);
    assert.match(sse.headers.get('content-type'), /javascript/);
    assert.match(await sse.text(), /export function subscribeSse/);

    const install = await (await fetch(`${explorer.url}/install`)).text();
    for (const text of [
      'npm run build:extension',
      'chrome://extensions',
      'Load unpacked',
      'packages/extension/dist',
      'npx fuse init --tier pro',
      `npx fuse fetch ${stubs.api.url}/v1/search?q=hello`,
    ]) {
      assert.ok(install.includes(text), `install page mentions ${text}`);
    }
  });
});

describe('startExplorer', () => {
  test('a port that is taken fails with EADDRINUSE and leaves nothing running', async () => {
    const network = makeNetwork({ members: 1, burned: 0, entries: 1 });
    const stubs = await startStubNetwork(network);
    const first = await startExplorer({ port: 0, ...stubs.explorerOptions });
    try {
      const port = Number(new URL(first.url).port);
      await assert.rejects(startExplorer({ port, ...stubs.explorerOptions }), { code: 'EADDRINUSE' });
    } finally {
      await first.close();
      await stubs.close();
    }
  });
});

describe('GET /api/state across an outage', () => {
  test('a source that goes down keeps its last known data, marked not ok', async () => {
    const network = makeNetwork({ members: 4, burned: 1, entries: 6 });
    const stubs = await startStubNetwork(network);
    const explorer = await startExplorer({ port: 0, ...stubs.explorerOptions });
    try {
      const before = await getJson(`${explorer.url}/api/state`);
      assert.equal(before.log.revocations.length, 1);
      await stubs.log.close();
      await stubs.registry.close();
      await new Promise((resolve) => setTimeout(resolve, 200)); // past the snapshot cache
      const during = await getJson(`${explorer.url}/api/state`);
      assert.equal(during.log.ok, false);
      assert.equal(during.log.error, 'ECONNREFUSED');
      assert.deepEqual(during.log.revocations.map((r) => r.id), before.log.revocations.map((r) => r.id));
      assert.equal(during.log.entries.length, before.log.entries.length);
      assert.equal(during.registry.ok, false);
      assert.equal(during.registry.members.length, 4);
      assert.equal(during.registry.info.size, 4);
    } finally {
      await explorer.close();
      await stubs.close();
    }
  });
});

describe('GET /api/state with sources down', () => {
  test('a source that is down is reported, the rest is served', async () => {
    const network = makeNetwork({ members: 3, burned: 0, entries: 5 });
    const stubs = await startStubNetwork(network);
    const deadPort = await freePort();
    const explorer = await startExplorer({
      port: 0,
      ...stubs.explorerOptions,
      logUrl: `http://127.0.0.1:${deadPort}`,
      sites: [stubs.explorerOptions.sites[0], { id: 'api', name: 'Bolt API', url: `http://127.0.0.1:${deadPort}`, mode: 'middleware' }],
    });
    try {
      const state = await getJson(`${explorer.url}/api/state`);
      assert.equal(state.registry.ok, true);
      assert.equal(state.log.ok, false);
      assert.equal(state.log.error, 'ECONNREFUSED');
      assert.deepEqual(state.log.entries, []);
      assert.equal(state.sites[0].ok, true);
      assert.equal(state.sites[1].ok, false);
      assert.equal(state.sites[1].error, 'ECONNREFUSED');
    } finally {
      await explorer.close();
      await stubs.close();
    }
  });
});
