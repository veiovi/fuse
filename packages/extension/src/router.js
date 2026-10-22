// Runtime message API of the background service worker.
//
// Every request is { target: 'background', type, ...fields } and every answer
// is { ok: true, data } or { ok: false, error: { code, message, ... } }.
// Extension pages (the popup) manage the credential; content scripts may only
// ask about, and spend for, the origin the browser says they run in.
import { FuseError, errorPayload } from './errors.js';
import { classifySender } from './senders.js';

/**
 * `isAlive(sender)` resolves whether the document that sent a message still
 * exists (not navigated away, reloaded or closed).
 */
export function createRouter(service, extension, { isAlive = async () => true } = {}) {
  const fromExtensionPage = {
    status: () => service.status(),
    'registry-info': (m) => service.registryInfo(m.registry),
    register: (m) => service.register({ registry: m.registry, tier: m.tier }),
    'set-permission': (m) => service.setPermission({ origin: m.origin, permission: m.permission }),
    'delete-credential': () => service.deleteCredential(),
  };
  // Any `origin` field in a content script's message is ignored on purpose.
  const fromContentScript = {
    'challenge-state': (m, origin) => service.challengeState(origin, { network: m.network, registry: m.registry }),
    prove: (m, origin, sender) =>
      service.prove(
        origin,
        { challenge: m.challenge, remember: m.remember, trigger: m.trigger },
        { alive: () => isAlive(sender) },
      ),
    'redeem-result': (m, origin) => service.redeemResult(origin, m),
    'take-toast': (m, origin) => service.takeToast(origin, m.toast),
    'open-popup': () => service.openPopup(),
  };

  return async function route(message, sender) {
    const who = classifySender(sender, extension);
    const table = who.kind === 'extension' ? fromExtensionPage : who.kind === 'content' ? fromContentScript : null;
    const type = message?.type;
    try {
      if (!table || typeof type !== 'string' || !Object.hasOwn(table, type)) {
        throw new FuseError('forbidden', `"${String(type)}" is not available to this sender.`);
      }
      return { ok: true, data: await table[type](message, who.origin, sender) };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  };
}
