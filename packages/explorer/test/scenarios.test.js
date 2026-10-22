import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { startExplorer } from '../src/index.js';
import { makeNetwork, recordEvents, startStubNetwork } from './helpers.js';

describe('scenarios', () => {
  let stubs, explorer, stream;
  const seen = [];
  let release;
  const gate = () => new Promise((resolve) => (release = resolve));

  const scenarios = [
    {
      id: 'echo',
      title: 'Echo',
      summary: 'Prints its context.',
      async run(ctx) {
        seen.push({ ...ctx, tmpExisted: existsSync(ctx.tmpDir) });
        ctx.print('registry', ctx.registryUrl);
        ctx.print('sites:', ctx.sites);
        ctx.print('\u001b[32mgreen\u001b[0m text');
        return { ok: true, big: 2n ** 70n };
      },
    },
    {
      id: 'slow',
      title: 'Slow',
      summary: 'Waits until the test releases it.',
      async run(ctx) {
        ctx.print('waiting');
        await gate();
        return 'released';
      },
    },
    {
      id: 'broken',
      title: 'Broken',
      summary: 'Throws.',
      async run(ctx) {
        ctx.print('about to fail');
        throw new TypeError('no credential');
      },
    },
  ];

  const run = (id) => fetch(`${explorer.url}/api/scenarios/${id}/run`, { method: 'POST' });

  before(async () => {
    stubs = await startStubNetwork(makeNetwork({ members: 1, burned: 0, entries: 1 }));
    explorer = await startExplorer({ port: 0, ...stubs.explorerOptions, scenarios });
    stream = recordEvents(`${explorer.url}/api/events`);
    await stream.waitFor((e) => e.type === 'hello');
  });

  after(async () => {
    release?.();
    stream?.close();
    await explorer?.close();
    await stubs?.close();
  });

  test('GET /api/scenarios lists id, title and summary', async () => {
    const body = await (await fetch(`${explorer.url}/api/scenarios`)).json();
    assert.deepEqual(body.scenarios, scenarios.map(({ id, title, summary }) => ({ id, title, summary })));
    assert.equal(body.current, null);
  });

  test('an unknown scenario is a 404', async () => {
    const res = await run('rm-rf');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown-scenario');
  });

  test('a run streams started, output and finished events', async () => {
    const res = await run('echo');
    assert.equal(res.status, 202);
    const { runId } = await res.json();

    const started = await stream.waitFor((e) => e.type === 'scenario-started' && e.runId === runId);
    assert.equal(started.id, 'echo');
    assert.equal(started.source, 'explorer');
    const finished = await stream.waitFor((e) => e.type === 'scenario-finished' && e.runId === runId);
    assert.equal(finished.ok, true);
    assert.deepEqual(finished.result, { ok: true, big: (2n ** 70n).toString() });
    assert.ok(finished.durationMs >= 0);

    const lines = stream.events.filter((e) => e.type === 'scenario-output' && e.runId === runId).map((e) => e.line);
    assert.equal(lines[0], `registry ${stubs.registry.url}`);
    assert.match(lines[1], /forum: 'http:\/\/127\.0\.0\.1:\d+'/);
    assert.equal(lines[2], 'green text', 'ANSI colour codes are stripped');

    const ctx = seen[0];
    assert.equal(ctx.logUrl, stubs.log.url);
    assert.deepEqual(ctx.sites, { forum: stubs.forum.url, api: stubs.api.url });
    assert.equal(ctx.tmpExisted, true);
    assert.equal(typeof ctx.print, 'function');

    const { current } = await (await fetch(`${explorer.url}/api/scenarios`)).json();
    assert.equal(current.status, 'finished');
    assert.deepEqual(current.output, lines);
  });

  test('each run gets a fresh temp dir, removed afterwards', async () => {
    const { runId } = await (await run('echo')).json();
    await stream.waitFor((e) => e.type === 'scenario-finished' && e.runId === runId);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].tmpDir, seen[1].tmpDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(seen[0].tmpDir), false);
    assert.equal(existsSync(seen[1].tmpDir), false);
  });

  test('one run at a time: a second start is a 409 until the first finishes', async () => {
    const first = await run('slow');
    assert.equal(first.status, 202);
    const { runId } = await first.json();
    await stream.waitFor((e) => e.type === 'scenario-output' && e.runId === runId);

    const busy = await run('echo');
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()).running, { id: 'slow', runId });
    const state = await (await fetch(`${explorer.url}/api/state`)).json();
    assert.equal(state.scenario.status, 'running');

    release();
    const done = await stream.waitFor((e) => e.type === 'scenario-finished' && e.runId === runId);
    assert.equal(done.result, 'released');
    const next = await run('echo');
    assert.equal(next.status, 202, 'free again as soon as scenario-finished is out');
    const { runId: nextId } = await next.json();
    await stream.waitFor((e) => e.type === 'scenario-finished' && e.runId === nextId);
  });

  test('a failing scenario finishes with its error', async () => {
    const { runId } = await (await run('broken')).json();
    const done = await stream.waitFor((e) => e.type === 'scenario-finished' && e.runId === runId);
    assert.equal(done.ok, false);
    assert.deepEqual(done.error, { name: 'TypeError', message: 'no credential' });
    const { current } = await (await fetch(`${explorer.url}/api/scenarios`)).json();
    assert.equal(current.status, 'failed');
    assert.deepEqual(current.output, ['about to fail']);
  });
});
