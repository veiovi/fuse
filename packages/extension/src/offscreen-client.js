// Background side of the prover. Service workers cannot start the worker
// threads snarkjs proves with, so proofs run in an offscreen document
// (reason WORKERS). It stays open while in use and keeps its warmed-up
// prover; once idle it asks to be closed, which frees the worker pool.

const DOCUMENT_PATH = 'offscreen.html';
const PROVE_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createOffscreenProver(chrome, { timeoutMs = PROVE_TIMEOUT_MS } = {}) {
  const url = chrome.runtime.getURL(DOCUMENT_PATH);
  // Creating, using and closing the document never interleave.
  let tail = Promise.resolve();
  const exclusive = (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };

  async function isOpen() {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    return existing.length > 0;
  }

  async function ensureDocument() {
    if (await isOpen()) return;
    try {
      await chrome.offscreen.createDocument({
        url: DOCUMENT_PATH,
        reasons: ['WORKERS'],
        justification: 'Generates Fuse zero-knowledge proofs with WebAssembly worker threads.',
      });
    } catch (err) {
      // Another context created it first: the document exists, which is all we need.
      if (!/single offscreen document/i.test(err?.message ?? '')) throw err;
    }
  }

  function call(type, payload) {
    return exclusive(async () => {
      await ensureDocument();
      const response = await withTimeout(
        chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload }),
        timeoutMs,
        'The prover did not answer in time.',
      );
      if (!response?.ok) throw new Error(response?.error ?? 'The prover did not answer.');
      return response.result;
    });
  }

  return {
    url,
    /** createFuseAuthorization inputs (JSON-safe) → its result. */
    prove: (request) => call('prove', { request }),
    /** Load artifacts and start prover threads ahead of the first proof. */
    warm: () => call('warm', {}),
    /** Close the document (the offscreen page asks for this when idle). */
    close: () =>
      exclusive(async () => {
        if (await isOpen()) await chrome.offscreen.closeDocument();
      }),
  };
}
