// Demo configuration: environment parsing and the public/internal URL split.
// Importing run.js needs every demo module, so this skips like the smoke test.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const REQUIRED = ['packages/registry/src/index.js', 'packages/log/src/index.js', 'packages/gateway/src/index.js', 'packages/agent/src/index.js', 'demo/sites/forum/app.js', 'demo/sites/api/app.js', 'demo/scenarios/index.js'];
const missing = REQUIRED.filter((path) => !existsSync(new URL(path, ROOT)));
const skip = missing.length ? `the demo needs modules that do not exist yet: ${missing.join(', ')}` : false;

describe('demo configuration', { skip }, () => {
  test('defaults, port overrides and bad values', async () => {
    const { DEFAULT_PORTS, demoConfig } = await import('../run.js');
    const config = demoConfig({});
    assert.equal(config.bind, '127.0.0.1');
    assert.deepEqual(config.ports, DEFAULT_PORTS);
    assert.match(config.dataDir, /[/\\]\.data$/);
    assert.equal(config.publicBase, undefined);

    const custom = demoConfig({ FUSE_BIND: '0.0.0.0', FUSE_DATA_DIR: '/srv/fuse', FUSE_API_PORT: '5720', FUSE_PUBLIC_BASE: 'https://box.tail.ts.net' });
    assert.deepEqual([custom.bind, custom.dataDir, custom.ports.api, custom.ports.forum, custom.publicBase], ['0.0.0.0', '/srv/fuse', 5720, 4710, 'https://box.tail.ts.net']);
    assert.throws(() => demoConfig({ FUSE_LOG_PORT: 'eighty' }), /FUSE_LOG_PORT must be a port number/);
  });

  test('sites get their own *.localhost names; FUSE_PUBLIC_BASE only changes what is shown', async () => {
    const { DEFAULT_PORTS, demoUrls } = await import('../run.js');
    const local = demoUrls({});
    assert.equal(local.urls.explorer, 'http://localhost:4700');
    assert.equal(local.urls.install, 'http://localhost:4700/install');
    assert.equal(local.urls.forum, 'http://forum.localhost:4710');
    assert.equal(local.urls.forumUpstream, 'http://127.0.0.1:4711');
    assert.deepEqual(local.internalUrls, {
      explorer: 'http://localhost:4700',
      registry: 'http://localhost:4701',
      log: 'http://localhost:4702',
      forum: 'http://forum.localhost:4710',
      api: 'http://api.localhost:4720',
    });
    assert.deepEqual(local.siteOrigins, {}, 'by default the sites choose their own origins');

    const tailnet = demoUrls({ bind: '0.0.0.0', publicBase: 'https://box.tail.ts.net/', ports: DEFAULT_PORTS });
    assert.equal(tailnet.urls.registry, 'https://box.tail.ts.net:4701');
    assert.equal(tailnet.urls.install, 'https://box.tail.ts.net:4700/install');
    assert.equal(tailnet.urls.api, 'https://box.tail.ts.net:4720');
    assert.equal(tailnet.internalUrls.registry, 'http://localhost:4701');
    assert.equal(tailnet.internalUrls.api, 'http://api.localhost:4720');
    assert.deepEqual(tailnet.siteOrigins, {
      forum: ['https://box.tail.ts.net:4710', 'http://forum.localhost:4710'],
      api: ['https://box.tail.ts.net:4720', 'http://api.localhost:4720'],
    });

    const pinned = demoUrls({ bind: '100.64.0.7' });
    assert.equal(pinned.internalUrls.log, 'http://100.64.0.7:4702', 'a specific bind address is not reachable as localhost');
    assert.deepEqual(pinned.siteOrigins.forum, ['http://100.64.0.7:4710']);
    assert.throws(() => demoUrls({ publicBase: 'box.tail.ts.net' }), /FUSE_PUBLIC_BASE must be a URL/);
  });
});
