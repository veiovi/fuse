// Who sent a runtime message. A content script's origin comes only from what
// the browser reports about its frame; nothing in the message body can change
// it, so a page can never spend a slot (or learn a pseudonym) for another site.

/** scheme://host[:port] of a URL. URL.origin is "null" for chrome-extension: outside Chrome, so build it by hand. */
export function originOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function isWebOrigin(origin) {
  return typeof origin === 'string' && /^https?:\/\/[^/]+$/.test(origin);
}

/**
 * Classify a runtime.onMessage sender.
 *   { kind: 'extension' }                 popup, offscreen document, other extension pages
 *   { kind: 'content', origin, tabId }    our content script in a web page's top frame
 *   { kind: 'unknown' }                   anything else (refused)
 */
export function classifySender(sender, extension) {
  if (!sender || sender.id !== extension.id) return { kind: 'unknown' };
  const urlOrigin = originOf(sender.url);
  const origin = sender.origin ?? urlOrigin;
  if (origin === extension.origin && (urlOrigin === null || urlOrigin === origin)) {
    return { kind: 'extension' };
  }
  const topFrame = sender.frameId === undefined || sender.frameId === 0;
  if (sender.tab && topFrame && isWebOrigin(origin) && (urlOrigin === null || urlOrigin === origin)) {
    return { kind: 'content', origin: new URL(origin).origin, tabId: sender.tab.id };
  }
  return { kind: 'unknown' };
}
