// The four demo scenarios against a real network on free ports: registry,
// shared log, Acme Forum (gateway as reverse proxy) and Bolt API (gateway
// middleware), then once more through the terminal runner. Skipped until the
// demo sites exist.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { releaseProver } from '@fuse/core/node';
import { scenarios } from '../index.js';

const siteApp = (name) => fileURLToPath(new URL(`../../sites/${name}/app.js`, import.meta.url));
const RUNNER = fileURLToPath(new URL('../cli.js', import.meta.url));
const sitesReady = existsSync(siteApp('forum')) && existsSync(siteApp('api'));

const EXPECTED = {
  'honest-agent': (r) => {
    assert.deepEqual([r.used, r.limit], [2, 200]);
    assert.notEqual(r.pseudonyms.forum, r.pseudonyms.api);
  },
  scanner: (r) => assert.deepEqual([r.limit, r.accepted, r.refusedAt, r.backingsFor1M], [10, 10, 11, 5000]),
  cheater: (r) => {
    assert.deepEqual([r.keyRecovered, r.memberStatus, r.freshAttempt], [true, 'burned', 'not-a-member']);
    assert.ok(r.apiSession === 401 || r.apiSession === 403, `api session still alive: ${r.apiSession}`);
  },
  'ban-sticks': (r) => assert.deepEqual([r.banned, r.slotsUsed], [true, 2]),
};

describe('demo scenarios on a live network', { skip: !sitesReady && 'demo/sites/{forum,api}/app.js not present yet' }, () => {
  const running = [];
  let context;
  let dir;

  before(async () => {
    const { startRegistry } = await import('@fuse/registry');
    const { startLog } = await import('@fuse/log');
    const { startForum } = await import(siteApp('forum'));
    const { startApi } = await import(siteApp('api'));
    dir = await mkdtemp(join(tmpdir(), 'fuse-scenarios-test-'));
    const registry = await startRegistry({ port: 0 });
    running.push(registry);
    const log = await startLog({ port: 0, registries: [registry.url] });
    running.push(log);
    const network = { registryUrl: registry.url, logUrl: log.url };
    const forum = await startForum({ port: 0, upstreamPort: 0, ...network });
    running.push(forum);
    const api = await startApi({ port: 0, ...network });
    running.push(api);
    context = { registryUrl: registry.url, logUrl: log.url, sites: { forum: forum.url, api: api.url } };
  });

  after(async () => {
    for (const service of running.reverse()) await service.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    await releaseProver();
  });

  for (const scenario of scenarios) {
    test(scenario.id, async () => {
      const lines = [];
      const tmpDir = await mkdtemp(join(dir, `${scenario.id}-`));
      const result = await scenario.run({ ...context, print: (line) => lines.push(line), tmpDir });
      EXPECTED[scenario.id](result);
      assert.ok(lines.length > 5, 'the scenario narrates what happens');
      // Full 64-hex values (secrets, pseudonyms, tags) never reach the console.
      assert.equal(lines.filter((line) => /0x[0-9a-f]{64}/i.test(line)).length, 0);
    });
  }

  test('the terminal runner runs every scenario', async () => {
    const env = {
      ...process.env,
      FUSE_REGISTRY_URL: context.registryUrl,
      FUSE_LOG_URL: context.logUrl,
      FUSE_FORUM_URL: context.sites.forum,
      FUSE_API_URL: context.sites.api,
      NO_COLOR: '1',
    };
    const { code, stdout } = await new Promise((resolve) =>
      execFile(process.execPath, [RUNNER, 'all'], { env }, (err, out) => resolve({ code: err ? err.code : 0, stdout: out })),
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /✓ all 4 scenarios passed/);
  });
});
