import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOffscreenProver } from '../src/offscreen-client.js';
import { EXTENSION_ORIGIN, createFakeChrome } from './fakes.js';

function setup() {
  const seen = [];
  const chrome = createFakeChrome({
    async offscreen(message, sender) {
      seen.push({ type: message.type, request: message.request, sender });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (message.request?.fail) return { ok: false, error: 'witness failed' };
      return { ok: true, result: { type: message.type } };
    },
  });
  return { chrome, seen, prover: createOffscreenProver(chrome, { timeoutMs: 1000 }) };
}

test('creates one WORKERS offscreen document on demand and reuses it', async () => {
  const { chrome, seen, prover } = setup();
  assert.equal(prover.url, `${EXTENSION_ORIGIN}/offscreen.html`);
  const results = await Promise.all([prover.warm(), prover.prove({ slot: 0 }), prover.prove({ slot: 1 })]);
  assert.deepEqual(results.map((r) => r.type), ['warm', 'prove', 'prove']);
  assert.deepEqual(chrome.offscreen.createdWith, [
    { url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Generates Fuse zero-knowledge proofs with WebAssembly worker threads.' },
  ]);
  assert.deepEqual(seen.map((s) => s.sender.url), Array(3).fill(`${EXTENSION_ORIGIN}/background.js`));
});

test('prover errors surface as exceptions', async () => {
  const { prover } = setup();
  await assert.rejects(prover.prove({ fail: true }), /witness failed/);
});

test('closing when idle frees the document; the next proof opens a new one', async () => {
  const { chrome, prover } = setup();
  await prover.warm();
  const closing = prover.close();
  const next = prover.prove({ slot: 2 }); // queued behind the close, never sent to a closing document
  await closing;
  assert.equal(chrome.offscreen.closed, 1);
  assert.equal((await next).type, 'prove');
  assert.equal(chrome.offscreen.createdWith.length, 2);
  await prover.close();
  await prover.close(); // already closed: nothing to do
  assert.equal(chrome.offscreen.closed, 2);
});
