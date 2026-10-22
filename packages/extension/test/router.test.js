import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { FuseError } from '../src/errors.js';
import { createRouter } from '../src/router.js';
import { classifySender } from '../src/senders.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, senders } from './fakes.js';

const extension = { id: EXTENSION_ID, origin: EXTENSION_ORIGIN };
const SITE = 'https://forum.test';

let calls;
let aliveChecks;
let route;
beforeEach(() => {
  calls = [];
  aliveChecks = [];
  const service = new Proxy(
    {},
    {
      get: (_, name) => async (...args) => {
        calls.push([name, ...args]);
        if (args.some((a) => a?.challenge === 'explode')) throw new FuseError('budget-exhausted', undefined, { remaining: 0 });
        return { handled: name };
      },
    },
  );
  const isAlive = async (sender) => {
    aliveChecks.push(sender);
    return sender.documentId !== 'gone';
  };
  route = createRouter(service, extension, { isAlive });
});

describe('message routing', () => {
  test('the popup manages the credential', async () => {
    for (const type of ['status', 'registry-info', 'register', 'set-permission', 'delete-credential']) {
      const response = await route({ target: 'background', type }, senders.popup);
      assert.equal(response.ok, true, type);
    }
    assert.deepEqual(calls.map((c) => c[0]), ['status', 'registryInfo', 'register', 'setPermission', 'deleteCredential']);
  });

  test('the popup opened in a tab is still an extension page', async () => {
    const response = await route({ type: 'status' }, { ...senders.popup, tab: { id: 3 }, frameId: 0 });
    assert.equal(response.ok, true);
  });

  test('content scripts cannot reach credential management', async () => {
    for (const type of ['status', 'registry-info', 'register', 'set-permission', 'delete-credential', 'toString', '__proto__']) {
      const response = await route({ type }, senders.content(SITE));
      assert.deepEqual([response.ok, response.error.code], [false, 'forbidden'], type);
    }
    assert.equal(calls.length, 0);
  });

  test('the popup cannot spend slots', async () => {
    const response = await route({ type: 'prove', challenge: 'c' }, senders.popup);
    assert.equal(response.error.code, 'forbidden');
  });

  test('content scripts spend only for the origin the browser reports', async () => {
    await route({ type: 'prove', challenge: 'c1', origin: 'https://bank.test', remember: 'always', trigger: 'click' }, senders.content(SITE));
    await route({ type: 'challenge-state', origin: 'https://bank.test', network: 'n' }, senders.content(SITE));
    await route({ type: 'redeem-result', origin: 'https://bank.test', spendId: 'x' }, senders.content(SITE));
    assert.deepEqual(calls[0].slice(0, 3), ['prove', SITE, { challenge: 'c1', remember: 'always', trigger: 'click' }]);
    assert.deepEqual(calls[1], ['challengeState', SITE, { network: 'n', registry: undefined }]);
    assert.equal(calls[2][1], SITE);
  });

  test('a spend can check that the requesting document still exists', async () => {
    await route({ type: 'prove', challenge: 'c1' }, senders.content(SITE, '/members', 'doc-9'));
    await route({ type: 'prove', challenge: 'c2' }, senders.content(SITE, '/members', 'gone'));
    const [first, second] = calls.map((c) => c[3]);
    assert.deepEqual([await first.alive(), await second.alive()], [true, false]);
    assert.deepEqual(aliveChecks.map((s) => s.documentId), ['doc-9', 'gone']);
  });

  test('service errors come back as data', async () => {
    const response = await route({ type: 'prove', challenge: 'explode' }, senders.content(SITE));
    assert.deepEqual(response, { ok: false, error: { code: 'budget-exhausted', message: 'All of today’s slots are spent.', remaining: 0 } });
  });
});

describe('sender classification', () => {
  test('recognizes extension pages and top-frame content scripts', () => {
    assert.deepEqual(classifySender(senders.popup, extension), { kind: 'extension' });
    assert.deepEqual(classifySender(senders.content('http://forum.localhost:4710'), extension), {
      kind: 'content',
      origin: 'http://forum.localhost:4710',
      tabId: 7,
    });
  });

  test('refuses everything else', () => {
    const unknown = (sender) => assert.equal(classifySender(sender, extension).kind, 'unknown', JSON.stringify(sender));
    unknown(undefined);
    unknown({ ...senders.popup, id: 'another-extension' });
    unknown({ ...senders.content(SITE), frameId: 3 }); // subframe
    unknown({ ...senders.content(SITE), origin: 'null' }); // opaque origin
    unknown({ ...senders.content(SITE), url: 'https://other.test/page' }); // url and origin disagree
    unknown({ ...senders.content(SITE), tab: undefined }); // web origin without a tab
    unknown({ id: EXTENSION_ID, url: 'file:///etc/passwd', tab: { id: 1 }, frameId: 0 });
    unknown({ ...senders.popup, url: 'https://forum.test/popup.html' }); // claims extension origin, URL disagrees
  });
});
