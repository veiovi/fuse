import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startExplorer } from '../src/index.js';
import { freePort, makeNetwork, recordEvents, startStub, startStubNetwork, until } from './helpers.js';

const fast = { minDelay: 40, maxDelay: 200 };

describe('GET /api/events', () => {
  test('merges every source’s stream into one, tagged with source', async () => {
    const stubs = await startStubNetwork(makeNetwork({ members: 2, burned: 0, entries: 2 }));
    const explorer = await startExplorer({ port: 0, ...stubs.explorerOptions, reconnect: fast });
    const stream = recordEvents(`${explorer.url}/api/events`);
    try {
      const hello = await stream.waitFor((e) => e.type === 'hello' && e.source === 'explorer');
      assert.equal(hello.scenario, null);
      await until(() => [stubs.registry, stubs.log, stubs.forum, stubs.api].every((s) => s.clients() === 1));

      stubs.registry.push('member-joined', { index: 4, tier: 'pro' });
      stubs.log.push('entry', { entry: { seq: 9, nullifier: '0x01' } });
      stubs.forum.push('proof-accepted', { pseudonym: '0xabc', short: 'anon-00000abc' });
      stubs.api.push('challenge-issued', { path: '/v1/search' });

      const joined = await stream.waitFor((e) => e.type === 'member-joined');
      assert.equal(joined.source, 'registry');
      assert.equal(joined.sseType, 'member-joined', 'SSE event name is the type');
      assert.equal(joined.index, 4);
      assert.ok(joined.at);
      assert.equal((await stream.waitFor((e) => e.type === 'entry')).source, 'log');
      assert.equal((await stream.waitFor((e) => e.type === 'proof-accepted')).short, 'anon-00000abc');
      assert.equal((await stream.waitFor((e) => e.type === 'challenge-issued')).source, 'api');

      // Site events are kept for the "recent gateway events" list.
      const state = await (await fetch(`${explorer.url}/api/state`)).json();
      assert.deepEqual(state.sites.map((s) => s.recentEvents.map((e) => e.type)), [['proof-accepted'], ['challenge-issued']]);
    } finally {
      stream.close();
      await explorer.close();
      await stubs.close();
    }
  });

  test('tolerates a source that is down and picks it up when it starts', async () => {
    const stubs = await startStubNetwork(makeNetwork({ members: 1, burned: 0, entries: 1 }));
    const logPort = await freePort();
    const explorer = await startExplorer({
      port: 0,
      ...stubs.explorerOptions,
      logUrl: `http://127.0.0.1:${logPort}`,
      reconnect: fast,
    });
    const stream = recordEvents(`${explorer.url}/api/events`);
    let log;
    try {
      await stream.waitFor((e) => e.type === 'hello' && e.source === 'explorer');
      await until(async () => {
        const { sources } = await (await fetch(`${explorer.url}/api/state`)).json();
        return sources.log.status === 'closed' && sources.log.error === 'ECONNREFUSED' && sources.forum.status === 'open';
      });

      stubs.forum.push('proof-accepted', { short: 'anon-11111111' });
      await stream.waitFor((e) => e.type === 'proof-accepted');

      log = await startStub({ port: logPort, json: { '/info': { size: 0 } }, sse: ['/events'] });
      await stream.waitFor((e) => e.type === 'source-status' && e.source === 'log' && e.status === 'open');
      await until(() => log.clients() === 1);
      log.push('double-spend', { revocation: { id: 'rev-1' } });
      const burned = await stream.waitFor((e) => e.type === 'double-spend');
      assert.equal(burned.source, 'log');
      assert.equal(burned.revocation.id, 'rev-1');

      // ...and reconnects after the source restarts.
      const mark = stream.events.length;
      await log.close();
      await stream.waitFor(
        (e) => e.type === 'source-status' && e.source === 'log' && e.status === 'closed' && stream.events.indexOf(e) >= mark,
      );
      log = await startStub({ port: logPort, json: {}, sse: ['/events'] });
      await until(() => log.clients() === 1);
      log.push('entry', { entry: { seq: 1 } });
      assert.equal((await stream.waitFor((e) => e.type === 'entry')).source, 'log');
    } finally {
      stream.close();
      await explorer.close();
      await log?.close();
      await stubs.close();
    }
  });

  test('a gateway’s hello seeds its recent events', async () => {
    const network = makeNetwork({ members: 1, burned: 0, entries: 1 });
    const stubs = await startStubNetwork(network);
    const recent = [
      { type: 'challenge-issued', at: '2026-10-22T10:00:00.000Z', path: '/me' },
      { type: 'proof-accepted', at: '2026-10-22T10:00:01.000Z', short: 'anon-12345678' },
    ];
    const forum = await startStub({
      json: { '/.fuse/info': network.sites.forum.info, '/.fuse/admin/pseudonyms': { pseudonyms: [] } },
      sse: ['/.fuse/events'],
      hello: () => ({ siteName: 'Acme Forum', recent }),
    });
    const explorer = await startExplorer({
      port: 0,
      ...stubs.explorerOptions,
      sites: [{ id: 'forum', name: 'Acme Forum', url: forum.url, mode: 'proxy' }],
      reconnect: fast,
    });
    try {
      await until(() => forum.clients() === 1);
      await until(async () => {
        const state = await (await fetch(`${explorer.url}/api/state`)).json();
        return state.sites[0].recentEvents.length === 2;
      });
      forum.push('banned-request', { short: 'anon-12345678' });
      await until(async () => {
        const state = await (await fetch(`${explorer.url}/api/state`)).json();
        const types = state.sites[0].recentEvents.map((e) => e.type);
        return types.join() === 'challenge-issued,proof-accepted,banned-request';
      });
      const state = await (await fetch(`${explorer.url}/api/state`)).json();
      assert.ok(state.sites[0].recentEvents.every((e) => e.source === 'forum'));
    } finally {
      await explorer.close();
      await forum.close();
      await stubs.close();
    }
  });

  test('a page that reconnects with Last-Event-ID gets what it missed', async () => {
    const stubs = await startStubNetwork(makeNetwork({ members: 1, burned: 0, entries: 1 }));
    const explorer = await startExplorer({ port: 0, ...stubs.explorerOptions, reconnect: fast });
    const first = recordEvents(`${explorer.url}/api/events`);
    try {
      await until(() => stubs.forum.clients() === 1);
      stubs.forum.push('challenge-issued', { n: 1 });
      const one = await first.waitFor((e) => e.type === 'challenge-issued');
      first.close();

      stubs.forum.push('challenge-issued', { n: 2 });
      stubs.forum.push('challenge-issued', { n: 3 });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await fetch(`${explorer.url}/api/events`, { headers: { 'last-event-id': one.id } });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      while (!text.includes('"n":3')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
      await reader.cancel();
      assert.ok(text.indexOf('"n":2') < text.indexOf('"n":3'));
      assert.ok(!text.includes('"n":1'));
    } finally {
      first.close();
      await explorer.close();
      await stubs.close();
    }
  });
});
