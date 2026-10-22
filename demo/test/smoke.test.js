// Boots the whole demo with startDemo on free ports, checks that every
// service answers, runs the honest-agent scenario through the explorer's API
// (following its merged event stream, as the page does) and shuts down.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { subscribeSse } from '../../packages/explorer/src/sse.js';

const ROOT = new URL('../../', import.meta.url);
const REQUIRED = [
  'packages/registry/src/index.js',
  'packages/log/src/index.js',
  'packages/gateway/src/index.js',
  'packages/agent/src/index.js',
  'packages/explorer/src/index.js',
  'demo/sites/forum/app.js',
  'demo/sites/api/app.js',
  'demo/scenarios/index.js',
];
const missing = REQUIRED.filter((path) => !existsSync(new URL(path, ROOT)));
const skip = missing.length ? `the demo needs modules that do not exist yet: ${missing.join(', ')}` : false;

after(async () => {
  if (skip) return;
  const { releaseProver } = await import('@fuse/core/node');
  await releaseProver();
});

/** Distinct free ports, held open together so none is handed out twice. */
async function freePorts(names) {
  const servers = await Promise.all(
    names.map(
      () =>
        new Promise((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(server));
        }),
    ),
  );
  const ports = Object.fromEntries(names.map((name, i) => [name, servers[i].address().port]));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

async function json(url, init) {
  const res = await fetch(url, init);
  assert.ok(res.ok, `${init?.method ?? 'GET'} ${url} → ${res.status}`);
  return res.json();
}

test('the demo boots, every service answers, honest-agent runs from the explorer', { skip, timeout: 300_000 }, async () => {
  const { DEFAULT_PORTS, startDemo } = await import('../run.js');
  const ports = await freePorts(Object.keys(DEFAULT_PORTS));
  const dataDir = await mkdtemp(join(tmpdir(), 'fuse-demo-smoke-'));
  const demo = await startDemo({ ports, dataDir, bind: '127.0.0.1' });
  const events = [];
  let stream;
  try {
    const { urls, internalUrls } = demo;
    assert.equal(urls.explorer, `http://localhost:${ports.explorer}`);
    assert.equal(urls.install, `http://localhost:${ports.explorer}/install`);
    // Each site answers on its own host name, so browsers keep their cookies apart.
    assert.equal(urls.forum, `http://forum.localhost:${ports.forum}`);
    assert.equal(urls.api, `http://api.localhost:${ports.api}`);
    assert.equal(internalUrls.forum, urls.forum);

    const registry = await json(`${internalUrls.registry}/info`);
    assert.equal(registry.backing, 'deposit');
    const log = await json(`${internalUrls.log}/info`);
    assert.equal(log.network, 'fuse-demo-v1');
    assert.equal((await json(`${internalUrls.forum}/.fuse/info`)).siteName, 'Acme Forum');
    assert.equal((await json(`${internalUrls.api}/.fuse/info`)).siteName, 'Bolt API');
    assert.equal((await fetch(urls.forumUpstream)).ok, true, 'forum upstream app answers');
    assert.match(await (await fetch(urls.explorer)).text(), /<title>Fuse network explorer<\/title>/);
    const install = await (await fetch(urls.install)).text();
    assert.match(install, /npx fuse init --tier pro/);
    assert.ok(install.includes(`npx fuse fetch ${urls.api}/v1/search?q=hello`), 'the SDK quickstart points at the API');

    const state = await json(`${urls.explorer}/api/state`);
    assert.equal(state.registry.ok, true, state.registry.error);
    assert.equal(state.log.ok, true, state.log.error);
    assert.deepEqual(state.sites.map((s) => [s.id, s.ok]), [['forum', true], ['api', true]]);

    // Follow the merged stream the way the page does, then run a scenario.
    stream = subscribeSse(`${urls.explorer}/api/events`, { onEvent: (e) => events.push(JSON.parse(e.data)) });
    const waitFor = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (!events.some(predicate)) {
        if (Date.now() > deadline) throw new Error(`timed out; saw ${events.map((e) => `${e.source}:${e.type}`).join(', ')}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return events.find(predicate);
    };
    await waitFor((e) => e.type === 'hello' && e.source === 'explorer', 5000);
    // Every upstream stream is connected before the run starts.
    for (const deadline = Date.now() + 10_000; ; ) {
      const { sources } = await json(`${urls.explorer}/api/state`);
      if (['registry', 'log', 'forum', 'api'].every((id) => sources[id]?.status === 'open')) break;
      assert.ok(Date.now() < deadline, `explorer not following every source: ${JSON.stringify(sources)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const { scenarios } = await json(`${urls.explorer}/api/scenarios`);
    assert.ok(scenarios.some((s) => s.id === 'honest-agent'), 'honest-agent is offered');
    const res = await fetch(`${urls.explorer}/api/scenarios/honest-agent/run`, { method: 'POST' });
    assert.equal(res.status, 202);
    const { runId } = await res.json();

    const finished = await waitFor((e) => e.type === 'scenario-finished' && e.runId === runId, 240_000);
    const output = events.filter((e) => e.type === 'scenario-output' && e.runId === runId).map((e) => e.line);
    assert.equal(finished.ok, true, `honest-agent failed: ${finished.error?.message}\n${output.join('\n')}`);
    assert.ok(output.length > 0, 'the scenario printed its progress');

    // The real components' events came through the explorer, tagged by source.
    await waitFor((e) => e.source === 'registry' && e.type === 'member-joined', 5000);
    await waitFor((e) => e.source === 'log' && e.type === 'entry', 5000);
    await waitFor((e) => ['forum', 'api'].includes(e.source) && e.type === 'proof-accepted', 5000);

    const after = await json(`${urls.explorer}/api/state`);
    assert.ok(after.registry.info.size >= 1, 'a credential was registered');
    assert.ok(after.log.info.size >= 2, 'two first contacts were logged');
    assert.ok(after.log.entriesToday >= 2);
    assert.ok(after.sites.every((s) => s.pseudonyms.length >= 1), 'both sites saw a pseudonym');
    assert.ok(after.sites.every((s) => s.recentEvents.some((e) => e.type === 'proof-accepted')));
  } finally {
    stream?.close();
    await demo.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
