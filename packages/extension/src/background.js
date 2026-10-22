// Service worker entry: wires the Fuse service to Chrome APIs.
import { createOffscreenProver } from './offscreen-client.js';
import { createRouter } from './router.js';
import { originOf } from './senders.js';
import { createFuseService } from './service.js';

const prover = createOffscreenProver(chrome);

// Content scripts may read chrome.storage.local by default, and the wallet
// holds the secret key: restrict it to extension pages and this worker. Chrome
// keeps the setting in the profile; applying it on every start covers a fresh
// install. If it cannot be set, the service refuses to store a secret.
let protection = null;
function protectStorage() {
  protection ??= Promise.resolve()
    .then(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .then(
      () => true,
      () => {
        protection = null;
        return false;
      },
    );
  return protection;
}
protectStorage();

/** Whether the document that sent a message still exists: its content script answers if so. */
async function senderDocumentAlive(sender) {
  if (sender.tab?.id === undefined) return false;
  const target = sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId ?? 0 };
  try {
    const reply = await chrome.tabs.sendMessage(sender.tab.id, { target: 'content', type: 'alive' }, target);
    return reply?.alive === true;
  } catch {
    return false; // closed, navigated away, reloaded, or parked in the back/forward cache
  }
}

const service = createFuseService({
  storage: chrome.storage.local,
  fetch: (...args) => fetch(...args),
  prove: (request) => prover.prove(request),
  protectStorage,
  openPopup: async () => {
    try {
      await chrome.action.openPopup();
      return true;
    } catch {
      return false; // needs a focused window; the card then points at the toolbar instead
    }
  },
});

const route = createRouter(
  service,
  { id: chrome.runtime.id, origin: originOf(chrome.runtime.getURL('')) },
  { isAlive: senderDocumentAlive },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;
  if (message.type === 'prover-idle') {
    if (sender.id === chrome.runtime.id && sender.url === prover.url) prover.close().catch(() => {});
    return false;
  }
  route(message, sender).then((response) => {
    sendResponse(response);
    // A page is showing a challenge we may answer: start the prover while the person decides.
    const action = message.type === 'challenge-state' ? response.data?.action : null;
    if (action === 'ask' || action === 'auto') prover.warm().catch(() => {});
  });
  return true;
});
