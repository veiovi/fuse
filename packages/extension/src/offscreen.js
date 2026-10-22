// Offscreen document: the only place proofs are generated. It holds no
// secrets of its own; the background passes the inputs for one proof at a time.
import './worker-shim.js';
import { createFuseAuthorization } from '@fuse/core';
import { curves } from 'snarkjs';

const ARTIFACTS = { wasm: 'artifacts/fuse.wasm', zkey: 'artifacts/fuse.zkey' };
const BACKGROUND_URL = chrome.runtime.getURL('background.js');
// The warm worker pool costs ~100 MB; after this long without work, ask to be closed.
const IDLE_CLOSE_MS = 2 * 60 * 1000;

let idleTimer = null;
function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ target: 'background', type: 'prover-idle' }).catch(() => {});
  }, IDLE_CLOSE_MS);
}

async function fetchBytes(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`missing ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

let artifactBytes = null;
function loadArtifacts() {
  artifactBytes ??= Promise.all([fetchBytes(ARTIFACTS.wasm), fetchBytes(ARTIFACTS.zkey)]).catch((err) => {
    artifactBytes = null;
    throw err;
  });
  return artifactBytes;
}

// One job at a time: concurrent first calls would each build a thread pool.
let tail = Promise.resolve();
function exclusive(task) {
  const result = tail.then(task);
  tail = result.catch(() => {});
  return result;
}

async function warm() {
  await loadArtifacts();
  await curves.getCurveFromName('bn128'); // starts and caches the worker pool
  return { warmed: true };
}

async function prove(request) {
  const [wasm, zkey] = await loadArtifacts();
  // Fresh copies per proof: snarkjs reads these in place and must not see a buffer another proof touched.
  const result = await createFuseAuthorization({
    ...request,
    artifacts: { wasm: { type: 'mem', data: wasm.slice() }, zkey: { type: 'mem', data: zkey.slice() } },
  });
  return {
    authorization: result.authorization,
    origin: result.origin,
    epoch: result.epoch,
    slot: result.slot,
    pseudonym: result.pseudonym,
    nullifier: result.nullifier,
    root: result.root,
    provingMs: result.provingMs,
  };
}

const handlers = { warm, prove: (message) => prove(message.request) };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || !Object.hasOwn(handlers, message.type)) return false;
  // Only the service worker may drive the prover (content-script messages also reach this page).
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== BACKGROUND_URL) return false;
  clearTimeout(idleTimer);
  exclusive(() => handlers[message.type](message))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    )
    .finally(scheduleIdleClose);
  return true;
});

loadArtifacts().catch(() => {});
scheduleIdleClose();
