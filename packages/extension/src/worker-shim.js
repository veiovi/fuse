// snarkjs proves on worker threads that its ffjavascript dependency starts
// from a blob: URL. The extension's CSP (worker-src falls back to
// script-src 'self') forbids blob: workers, so the pool would never start.
// Point those workers at the same thread code, shipped as a packaged file
// (prover-thread.js, built from ffjavascript's threadman_thread.js).
//
// Import this module before anything that loads snarkjs.

const NativeWorker = globalThis.Worker;

export function installWorkerShim(threadUrl) {
  if (!NativeWorker || globalThis.Worker !== NativeWorker) return;
  globalThis.Worker = class PackagedProverWorker extends NativeWorker {
    constructor(url, options) {
      super(String(url).startsWith('blob:') ? threadUrl : url, options);
    }
  };
}

installWorkerShim(chrome.runtime.getURL('prover-thread.js'));
