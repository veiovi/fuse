// The page itself, in headless Chrome against stub sources: it renders the
// snapshot, follows events, runs a scenario and never scrolls sideways.
// Skips when playwright-core or a local Chrome is not available.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startExplorer } from '../src/index.js';
import { freePort, makeNetwork, startStubNetwork } from './helpers.js';

let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  // reported as a skip below
}

describe('explorer page', () => {
  let browser;
  let skipReason = null;
  let network;
  let stubs;
  let explorer;

  const scenarios = [
    {
      id: 'echo',
      title: 'Echo',
      summary: 'Prints two lines.',
      async run({ print }) {
        print('first line');
        print('  indented second line');
        return { ok: true };
      },
    },
  ];

  before(async () => {
    if (!chromium) {
      skipReason = 'playwright-core is not installed';
      return;
    }
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (err) {
      skipReason = `no local Chrome for playwright-core (${err.message.split('\n')[0]})`;
      return;
    }
    const [forumPort, apiPort] = [await freePort(), await freePort()];
    network = makeNetwork({
      members: 6,
      burned: 1,
      entries: 30,
      forum: `http://127.0.0.1:${forumPort}`,
      api: `http://127.0.0.1:${apiPort}`,
    });
    stubs = await startStubNetwork(network, { ports: { forum: forumPort, api: apiPort } });
    explorer = await startExplorer({ port: 0, ...stubs.explorerOptions, scenarios, reconnect: { minDelay: 50, maxDelay: 200 } });
  });

  after(async () => {
    await browser?.close();
    await explorer?.close();
    await stubs?.close();
  });

  test('renders the snapshot, follows new events and runs a scenario', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));

    await page.goto(explorer.url);
    await page.waitForSelector('#tape .tape-row');
    const count = (selector) => page.locator(selector).count();

    assert.equal(await page.textContent('#registry [data-field="size"]'), '6');
    assert.equal(await count('#fusebox .fuse'), 6);
    assert.equal(await count('#fusebox .fuse.is-burned'), 1);
    assert.equal(await count('#tape .tape-row'), network.entries.length);
    assert.equal(await count('#tape .tape-row.is-reused'), 2, 'both shares of the burned slot are marked');
    assert.equal(await count('#burns .burn'), 1);
    assert.equal(await count('#burns .burn .plot-key'), 1);
    assert.match(await page.textContent('#burns .burn'), /Checked here: both shares lie on one line through k/);
    assert.equal(await count('#site-list .site'), 2);
    assert.equal(await count('#site-list .site .pseudonym.is-banned'), 2, 'the burned key is banned at both sites');
    assert.equal(await count('#services .service[data-status="open"]'), 4);
    assert.doesNotMatch(await page.textContent('body'), /undefined|NaN|\[object Object\]/);

    // A new first contact arrives: the tape gains a row at the top.
    const last = network.entries.at(-1);
    const entry = { ...last, seq: last.seq + 1, nullifier: '0x0000000000000000000000000000000000000000000000000000000000abcdef', revocation: undefined };
    network.entries.push(entry);
    network.logInfo = { ...network.logInfo, size: network.entries.length };
    stubs.log.push('entry', { entry });
    await page.waitForSelector(`#tape .tape-row[data-seq="${entry.seq}"]`);
    assert.equal(await page.getAttribute('#tape .tape-row:first-child', 'data-seq'), String(entry.seq));

    // A gateway event shows up under its site.
    stubs.api.push('proof-accepted', { short: 'anon-feedbeef', pseudonym: '0xfeedbeef' });
    await page.waitForFunction(() => document.querySelector('#site-list').textContent.includes('Accepted a proof from anon-feedbeef'));

    // Run a scenario from the page.
    await page.click('[data-run="echo"]');
    await page.waitForFunction(() => document.querySelector('#console-status').dataset.state === 'finished');
    assert.deepEqual(await page.locator('#console-lines li').allTextContents(), ['first line', '  indented second line']);
    assert.equal(await page.textContent('#console-title'), 'Echo');
    assert.equal(await page.isEnabled('[data-run="echo"]'), true);

    assert.deepEqual(errors, []);
    await page.close();
  });

  test('no sideways scrolling from phone to wide screens, in both themes', async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const [width, height] of [[360, 740], [768, 1024], [1280, 800], [1920, 1080]]) {
      for (const colorScheme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height }, colorScheme });
        await page.goto(explorer.url);
        await page.waitForSelector('#burns .burn');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, `${width}px ${colorScheme}: page is ${overflow}px too wide`);
        await page.close();
      }
    }
  });
});
