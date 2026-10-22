// End-to-end: the built extension in a real Chromium against a minimal Fuse
// setup. Run with `node packages/extension/test/e2e.mjs` (not part of node --test).
//
//   FUSE_E2E_HEADED=1          start headed instead of trying headless first
//   FUSE_E2E_STUBS=1           use the stub registry/gateway even if the real ones exist
//   FUSE_E2E_SCREENSHOTS=dir   save screenshots of the card and popup
//   FUSE_E2E_DARK=1            emulate a dark colour scheme
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { releaseProver } from '@fuse/core/node';
import { chromium } from 'playwright-core';
import { buildExtension } from '../build.js';
import { startFuseSetup } from './e2e-setup.js';

const log = (...args) => console.log('[e2e]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshotDir = process.env.FUSE_E2E_SCREENSHOTS ? path.resolve(process.env.FUSE_E2E_SCREENSHOTS) : null;

async function waitFor(check, { what, timeout = 30_000, interval = 100 }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

async function screenshot(page, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await sleep(250); // let the card's entrance animation finish
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
}

// -- browser ------------------------------------------------------------------

async function launch(dist, userDataDir, headless) {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium (new headless); the headless shell cannot load extensions
    headless,
    viewport: { width: 1100, height: 760 },
    colorScheme: process.env.FUSE_E2E_DARK ? 'dark' : 'light',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
}

async function extensionWorker(context, timeout) {
  const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
  return context.serviceWorkers().find(isOurs) ?? (await context.waitForEvent('serviceworker', { predicate: isOurs, timeout }));
}

async function launchWithExtension(dist) {
  const modes = process.env.FUSE_E2E_HEADED ? [false] : [true, false];
  for (const headless of modes) {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'fuse-e2e-profile-'));
    const context = await launch(dist, userDataDir, headless);
    try {
      const worker = await extensionWorker(context, 10_000);
      log(`Chromium ${context.browser()?.version() ?? ''} ${headless ? 'headless' : 'headed'}, extension ${new URL(worker.url()).host}`);
      return { context, userDataDir, extensionId: new URL(worker.url()).host, headless };
    } catch {
      log(`extension did not load ${headless ? 'headless' : 'headed'}`);
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
  throw new Error('the extension did not load in Chromium');
}

// -- the in-page card lives in a closed shadow root: read and click it through CDP --

const cdpSessions = new WeakMap();
async function cdp(page) {
  if (!cdpSessions.has(page)) cdpSessions.set(page, await page.context().newCDPSession(page));
  return cdpSessions.get(page);
}

const attr = (node, name) => {
  const a = node?.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};

function* walk(node) {
  if (!node) return;
  yield node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) yield* walk(child);
}

async function readCard(page) {
  try {
    return await readCardOnce(page);
  } catch {
    return null; // the document is being replaced (reload in progress)
  }
}

async function readCardOnce(page) {
  const session = await cdp(page);
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  let card = null;
  for (const node of walk(root)) {
    if (node.localName === 'fuse-extension-card') {
      for (const inner of walk(node)) if (attr(inner, 'role') === 'region') card = inner;
    }
  }
  if (!card) return null;
  const { outerHTML } = await session.send('DOM.getOuterHTML', { nodeId: card.nodeId });
  const text = outerHTML
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const buttons = {};
  for (const node of walk(card)) if (node.localName === 'button' && attr(node, 'data-action')) buttons[attr(node, 'data-action')] = node.nodeId;
  return { state: attr(card, 'data-state'), text, buttons };
}

async function clickCardButton(page, action) {
  const card = await waitFor(async () => {
    const c = await readCard(page);
    return c?.buttons[action] ? c : null;
  }, { what: `the card's "${action}" button` });
  await sleep(250); // let the entrance animation settle
  const session = await cdp(page);
  const { model } = await session.send('DOM.getBoxModel', { nodeId: card.buttons[action] }).catch(async () => {
    const fresh = await readCard(page);
    return session.send('DOM.getBoxModel', { nodeId: fresh.buttons[action] });
  });
  const [x1, y1, , , x3, y3] = model.border;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2); // a trusted click, like a person's
}

async function waitForCardState(page, states, what) {
  return waitFor(async () => {
    const card = await readCard(page);
    if (card && card.state === 'error' && !states.includes('error')) throw new Error(`card error: ${card.text}`);
    return card && states.includes(card.state) ? card : null;
  }, { what });
}

// -- popup ----------------------------------------------------------------------

async function registerInPopup(popup, registryUrl) {
  await popup.fill('#registry-url', registryUrl);
  await popup.click('[data-action="load-tiers"]');
  await popup.click('label.tier:has(input[value="starter"])');
  await screenshot(popup, 'popup-setup');
  await popup.click('[data-action="register"]');
  await popup.waitForSelector('[data-role="remaining"]');
}

async function remainingInPopup(popup) {
  return Number(await popup.textContent('[data-role="remaining"]'));
}

// -- scenario -------------------------------------------------------------------

async function firstContact(context, siteUrl, button) {
  const port = new URL(siteUrl).port;
  const page = await context.newPage();
  const response = await page.goto(siteUrl);
  assert.equal(response.status(), 401, 'the protected page first answers 401 with the interstitial');
  const asking = await waitForCardState(page, ['ask'], 'the card to ask');
  log(`card: "${asking.text}"`);
  await screenshot(page, `card-ask-${port}`);
  await clickCardButton(page, button);
  // The success line, before the reload or (if the page reloads itself first) right after it.
  const done = await waitForCardState(page, ['success'], 'the proof to be accepted');
  log(`card: "${done.text}"`);
  await screenshot(page, `card-success-${port}`);
  // The page reloads and the gateway serves the protected content.
  await page.waitForSelector('#protected', { timeout: 15_000 });
  const confirmation = await waitForCardState(page, ['success'], 'the confirmation after the reload');
  assert.match(confirmation.text, /Signed in to /);
  await screenshot(page, `signed-in-${port}`);
  await waitFor(async () => (await readCard(page)) === null, { what: 'the confirmation to fade', timeout: 10_000 });
  return { page, summary: done.text };
}

/** Run `expression` in our content script's isolated world on `page` (where the page itself cannot reach). */
async function evaluateAsContentScript(page, expression) {
  const session = await page.context().newCDPSession(page);
  const contexts = [];
  session.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await session.send('Runtime.enable');
  const world = await waitFor(() => contexts.find((c) => c.auxData?.type === 'isolated' && c.name === 'Fuse'), {
    what: "the content script's isolated world",
    timeout: 10_000,
  });
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    contextId: world.id,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  await session.detach();
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/**
 * A hostile site: every page presents a fresh challenge and reloads itself
 * every 40 ms, until calm() (closing a tab mid-reload can hang Playwright,
 * with or without the extension).
 */
async function startHostileSite() {
  let reloading = true;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/plain' || !reloading) return res.end('<!doctype html><title>plain</title><p id="calm">Nothing to see.</p>');
    res.end(
      `<!doctype html><meta name="fuse-challenge" content="${randomBytes(16).toString('base64url')}">` +
        '<title>hostile</title><script>setTimeout(() => location.reload(), 40)</script>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://hostile.localhost:${server.address().port}`,
    calm: () => {
      reloading = false;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function main() {
  const startedAt = Date.now();
  const dist = await buildExtension();
  log(`built ${dist}`);
  const setup = await startFuseSetup({ stubsOnly: Boolean(process.env.FUSE_E2E_STUBS) });
  log(`fuse setup (${setup.kind}): registry ${setup.registryUrl}, sites ${setup.sites.map((s) => s.url).join(', ')}`);
  const hostile = await startHostileSite();
  let browser = null;
  try {
    browser = await launchWithExtension(dist);
    const { context, extensionId } = browser;
    const [siteA, siteB] = setup.sites;

    context.on('page', (page) => page.on('crash', () => log(`page crashed: ${page.url()}`)));
    context.on('close', () => log('browser context closed'));

    // 1. Get a credential through the popup page.
    const popup = await context.newPage();
    popup.on('close', () => log('popup page closed'));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await registerInPopup(popup, setup.registryUrl);
    assert.equal(await remainingInPopup(popup), 10);
    log('registered a starter credential: 10 slots today');

    // The wallet (with its secret) is out of reach of content scripts, let alone pages.
    const plain = await context.newPage();
    await plain.goto(`${hostile.origin}/plain`);
    const fromContentScript = await evaluateAsContentScript(
      plain,
      "chrome.storage.local.get(null).then((v) => 'read ' + Object.keys(v).join(','), (e) => 'denied: ' + e.message)",
    );
    assert.match(fromContentScript, /^denied/, `a content script could read storage: ${fromContentScript}`);
    await plain.close();
    log(`content script reading chrome.storage.local: ${fromContentScript}`);

    // 2. Visit a protected page, click Allow, land authenticated.
    const a = await firstContact(context, siteA.url, 'allow');
    assert.match(a.summary, /anon-[0-9a-f]{8} · slot 1\/10 · proved in \d+\.\d s/);
    const shortA = a.summary.match(/anon-[0-9a-f]{8}/)[0];
    assert.equal(await a.page.textContent('#pseudonym'), shortA, 'the site sees the pseudonym the card showed');

    // 3. The popup shows the site, one slot spent, and the spend log entry.
    await popup.bringToFront();
    await popup.reload();
    await popup.waitForSelector('[data-role="remaining"]');
    assert.equal(await remainingInPopup(popup), 9);
    const originA = new URL(siteA.url).origin;
    const siteRow = popup.locator(`[data-role="sites"] li[data-origin="${originA}"]`);
    assert.equal(await siteRow.count(), 1);
    assert.match(await siteRow.textContent(), new RegExp(shortA));
    await screenshot(popup, 'popup-sites');
    await popup.click('[data-tab="log"]');
    assert.equal(await popup.locator('[data-role="history"] li').count(), 1);
    await screenshot(popup, 'popup-log');
    const spends = await popup.evaluate(async () =>
      ((await chrome.storage.local.get('wallet')).wallet.history ?? []).map(({ origin, slot, provingMs, outcome }) => ({ origin, slot, provingMs, outcome })),
    );
    assert.deepEqual(spends.map((s) => [s.origin, s.slot, s.outcome]), [[originA, 0, 'accepted']]);
    log(`proving time in the browser (first proof): ${spends[0].provingMs} ms`);

    // 4. The session cookie carries later visits: no card, no slot.
    const again = await context.newPage();
    assert.equal((await again.goto(siteA.url)).status(), 200);
    assert.equal(await readCard(again), null);
    await again.close();

    // 5. "Always for this site" on a second site; its pseudonym is unrelated to the first.
    const b = await firstContact(context, siteB.url, 'always');
    const shortB = b.summary.match(/anon-[0-9a-f]{8}/)[0];
    assert.notEqual(shortB, shortA, 'different sites see unrelated pseudonyms');
    assert.match(b.summary, /slot 2\/10/);
    const after = await popup.evaluate(async () => {
      const { wallet, permissions } = await chrome.storage.local.get(['wallet', 'permissions']);
      return { provingMs: wallet.history.map((h) => h.provingMs), permissions };
    });
    const originB = new URL(siteB.url).origin;
    assert.equal(after.permissions[originB], 'always');
    log(`proving time in the browser (second proof): ${after.provingMs[1]} ms`);

    // The shared log holds exactly the slot tags this browser's spend log lists.
    if (setup.logUrl) {
      const { entries } = await (await fetch(`${setup.logUrl}/entries`)).json();
      const tags = await popup.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.history.map((h) => h.nullifier));
      assert.deepEqual(entries.map((e) => e.nullifier).sort(), [...tags].sort());
      log(`shared log: ${entries.length} entries, matching the extension's spend log`);
    }

    // 6. A site that asks again right after a first contact gets asked about, not auto-paid.
    await context.clearCookies();
    const retry = await context.newPage();
    await retry.goto(siteB.url);
    const cautious = await waitForCardState(retry, ['ask'], 'the cautious re-ask');
    assert.match(cautious.text, /already spent a slot here recently/);
    await clickCardButton(retry, 'dismiss');
    await waitFor(async () => (await readCard(retry)) === null, { what: 'the card to close' });
    log('always-allowed site re-asking within the cooldown was asked about, then dismissed');

    // 7. "Never" from the popup silences a site.
    await popup.bringToFront();
    await popup.click('[data-tab="sites"]');
    await popup.selectOption(`[data-role="sites"] li[data-origin="${originB}"] select`, 'never');
    await waitFor(async () => (await popup.evaluate(async () => (await chrome.storage.local.get('permissions')).permissions))?.[originB] === 'never', {
      what: 'the never permission',
    });
    const silenced = await context.newPage();
    await silenced.goto(siteB.url);
    await sleep(1500);
    assert.equal(await readCard(silenced), null, 'no card on a never site');
    assert.equal(await remainingInPopup(popup), 8);
    log('never: no card; 8 slots left');

    // 7b. An always-allowed site that keeps reloading itself with fresh challenges gets at most one slot.
    await popup.evaluate((origin) => chrome.runtime.sendMessage({ target: 'background', type: 'set-permission', origin, permission: 'always' }), hostile.origin);
    const burst = await context.newPage();
    burst.goto(`${hostile.origin}/reload`).catch(() => {}); // never settles while the page keeps reloading
    await sleep(3000);
    hostile.calm();
    await burst.waitForSelector('#calm', { timeout: 10_000 });
    await burst.close();
    await sleep(1000); // let any proof still in flight finish
    const hostileSpends = await popup.evaluate(
      async (origin) => (await chrome.storage.local.get('wallet')).wallet.history.filter((h) => h.origin === origin).length,
      hostile.origin,
    );
    assert.ok(hostileSpends <= 1, `a reloading always-allowed site got ${hostileSpends} slots`);
    assert.ok((await remainingInPopup(popup)) >= 7);
    log(`always-allowed site reloading every 40 ms for 3 s: ${hostileSpends} slot(s) spent`);

    // 8. Delete the credential (with confirmation); a challenge then points to the popup.
    await popup.click('[data-action="delete"]');
    await screenshot(popup, 'popup-delete-confirm');
    await popup.click('[data-action="confirm-delete"]');
    await popup.waitForSelector('[data-role="setup"]');
    const stored = await popup.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).sort());
    assert.deepEqual(stored, ['permissions'], 'the wallet is gone; only site permissions remain');
    await context.clearCookies();
    const orphan = await context.newPage();
    await orphan.goto(siteA.url);
    const missing = await waitForCardState(orphan, ['notice'], 'the no-credential card');
    assert.match(missing.text, /no Fuse credential yet/);
    assert.ok(missing.buttons['open-fuse'], 'offers to open the popup');
    await screenshot(orphan, 'card-no-credential');
    log('deleted the credential; the next challenge points to the popup');

    log(`PASS in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  } finally {
    if (browser) {
      await browser.context.close();
      await rm(browser.userDataDir, { recursive: true, force: true });
    }
    await hostile.close();
    await setup.close();
    await releaseProver();
  }
}

main().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
