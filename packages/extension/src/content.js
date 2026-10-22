// Content script: answers a Fuse challenge page (protocol §8: the gateway's
// interstitial carries <meta name="fuse-challenge"> and <meta name="fuse-registry">,
// and may name its network in <meta name="fuse-network">). The background
// decides and proves; this script only talks to the page's own origin and
// shows the card.
import { createCard } from './card.js';
import { resetText, seconds } from './format.js';

const REDEEM_PATH = '/.fuse/redeem';
const CHALLENGE_PATH = '/.fuse/challenge';
// Gateways issue 120 s challenges. Past this page age, fetch a fresh one rather
// than spend a slot on a proof the site may reject as expired.
const FRESH_CHALLENGE_MS = 60_000;
const RELOAD_DELAY_MS = 1200;
const TOAST_MS = 4000;
// The interstitial may reload itself as soon as the session exists, so the
// success line is shown again after the reload. The page's sessionStorage
// carries only an opaque one-time id; the summary stays in the extension.
const TOAST_KEY = '__fuse_extension_toast';
const loadedAt = Date.now();

const REFUSALS = {
  'challenge-expired': 'its challenge had expired',
  'challenge-used': 'its challenge had already been used',
  'challenge-invalid': 'it did not recognize the challenge',
  'origin-mismatch': 'the proof was made for a different site',
  'origin-not-allowed': 'it does not serve this origin',
  'bad-proof': 'the proof did not verify',
  'wrong-epoch': 'it disagrees about today’s date (check your clock)',
  'unknown-root': 'it does not accept your registry, or has not seen your credential yet',
  replay: 'it had already seen this proof',
};

function meta(name) {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || null;
}

function takeToastId() {
  try {
    const id = sessionStorage.getItem(TOAST_KEY);
    if (id) sessionStorage.removeItem(TOAST_KEY);
    return id;
  } catch {
    return null; // storage disabled for this site
  }
}

function leaveToastId(id) {
  try {
    sessionStorage.setItem(TOAST_KEY, id);
  } catch {
    // no confirmation after the reload; nothing else depends on it
  }
}

async function background(type, fields = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ target: 'background', type, ...fields });
  } catch {
    throw Object.assign(new Error('The Fuse extension is not responding. Reload the page to try again.'), {
      code: 'extension-unavailable',
    });
  }
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? 'Fuse failed.'), response?.error ?? {});
  return response.data;
}

async function currentChallenge(pageChallenge) {
  if (Date.now() - loadedAt < FRESH_CHALLENGE_MS) return pageChallenge;
  try {
    const res = await fetch(new URL(CHALLENGE_PATH, location.origin), {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = await res.json();
    if (res.ok && typeof body?.challenge === 'string' && body.challenge) return body.challenge;
  } catch {
    // fall back to the page's challenge
  }
  return pageChallenge;
}

/** POST the Authorization header to the site's own redeem endpoint; the session cookie comes back. */
async function redeem(authorization) {
  let res;
  try {
    res = await fetch(new URL(REDEEM_PATH, location.origin), {
      method: 'POST',
      headers: { Authorization: authorization },
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'site-unreachable' };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok !== false) {
    return { ok: true, status: res.status, reputation: typeof body?.reputation === 'string' ? body.reputation : undefined };
  }
  return {
    ok: false,
    status: res.status,
    error: typeof body?.error === 'string' ? body.error : `http-${res.status}`,
    reason: typeof body?.reason === 'string' ? body.reason : undefined,
    origin: typeof body?.origin === 'string' ? body.origin : undefined,
  };
}

function views(card) {
  const site = card.site;
  const close = { label: 'Close', kind: 'secondary', action: 'close' };
  const reload = { label: 'Reload page', kind: 'primary', action: 'reload', handler: () => location.reload() };
  const openFuse = {
    label: 'Open Fuse',
    kind: 'primary',
    action: 'open-fuse',
    handler: async () => {
      const result = await background('open-popup').catch(() => ({ opened: false }));
      if (!result.opened) {
        card.error({
          title: 'Open Fuse from the toolbar',
          body: 'Click the Fuse icon next to the address bar (inside the puzzle-piece menu if it is not pinned).',
          actions: [close],
          tone: 'info',
        });
      }
    },
  };

  return {
    /** Problems found before any proof (nothing spent), from challenge-state or prove. */
    beforeSpend(info) {
      switch (info.code) {
        case 'no-credential':
          return {
            title: `${site} asks for a Fuse proof`,
            body: 'This browser has no Fuse credential yet. Get one in the Fuse extension, then reload this page.',
            actions: [openFuse, close],
            tone: 'info',
          };
        case 'budget-exhausted':
          return {
            title: 'No slots left today',
            body: `You have spent all ${info.limit} of today’s slots. Your budget ${resetText(info.resetsAt)}.`,
            actions: [close],
            tone: 'info',
          };
        case 'credential-burned':
          return {
            title: 'Credential burned',
            body: 'One of its slots was used twice, which revealed its key, so the network revoked it. Get a new credential in the Fuse extension.',
            actions: [openFuse, close],
          };
        case 'not-a-member':
          return {
            title: 'Credential not recognized',
            body: 'The registry no longer lists this credential. Delete it and get a new one in the Fuse extension.',
            actions: [openFuse, close],
          };
        case 'wrong-network':
          return {
            title: 'A different Fuse network',
            body: `${site} uses the Fuse network “${info.network}”, but your credential is for “${info.expected}”. Nothing was spent.`,
            actions: [close],
            tone: 'info',
          };
        case 'registry-unreachable':
        case 'registry-error':
        case 'proof-failed':
          return { title: 'Could not make a proof', body: `${info.message} No slot was spent.`, actions: [close] };
        default:
          return { title: 'Fuse could not answer', body: info.message ?? 'Something went wrong.', actions: [close] };
      }
    },

    /** The proof was made (the slot is spent) but the site did not sign us in. */
    afterSpend(outcome, proof, report) {
      if (outcome.error === 'banned') {
        return {
          title: `Banned on ${site}`,
          body: `${site} has banned ${proof.short}. Your pseudonyms on other sites are unrelated and unaffected. The slot is spent.`,
          actions: [close],
        };
      }
      if (outcome.error === 'credential-burned') {
        return report?.burned
          ? {
              title: 'Credential burned',
              body: 'A slot of this credential was used twice, which revealed its key. The registry has revoked it. Get a new credential in the Fuse extension.',
              actions: [openFuse, close],
            }
          : {
              title: 'Proof not accepted',
              body: `${site} says this credential is burned, but the registry still lists it. The slot is spent.`,
              actions: [close],
            };
      }
      if (outcome.error === 'site-unreachable') {
        return {
          title: `Could not reach ${site}`,
          body: 'The proof was made but not delivered. The slot is spent; reload to try again.',
          actions: [reload, close],
        };
      }
      if (outcome.status === 404) {
        return {
          title: 'This site cannot take the proof',
          body: `${site} shows a Fuse challenge but has no ${REDEEM_PATH} endpoint. The slot is spent.`,
          actions: [close],
        };
      }
      if (outcome.status === 421) {
        return {
          title: 'Wrong address for this site',
          body: `This site only accepts proofs at ${outcome.origin ?? 'its own address'}. The slot is spent; open the site there and try again.`,
          actions: [close],
        };
      }
      if (outcome.status === 401) {
        const why = REFUSALS[outcome.reason] ?? 'it may have expired';
        return {
          title: 'Proof not accepted',
          body: `${site} did not accept the proof: ${why}. The slot is spent. Reload the page to try again.`,
          actions: [reload, close],
        };
      }
      if (outcome.status === 503) {
        return {
          title: 'Fuse network unavailable',
          body: `${site} could not reach the Fuse ${outcome.error === 'registry-unavailable' ? 'registry' : 'log'} to check the proof. The slot is spent; try again shortly.`,
          actions: [reload, close],
        };
      }
      return {
        title: 'Proof not accepted',
        body: `${site} answered ${outcome.status} (${outcome.reason ?? outcome.error}). The slot is spent.`,
        actions: [close],
      };
    },
  };
}

function pageHints() {
  return { network: meta('fuse-network'), registry: meta('fuse-registry') };
}

/** The question. Only a real click on Allow or Always counts as consent. */
function ask(card, state, pageChallenge) {
  card.ask(state, {
    allow: () => spend(card, { pageChallenge, trigger: 'click' }),
    always: () => spend(card, { pageChallenge, trigger: 'click', remember: 'always' }),
  });
}

/** trigger: 'click' after the person answered the card, 'auto' for an always-allowed site. */
async function spend(card, { pageChallenge, trigger, remember }) {
  const view = views(card);
  const auto = trigger !== 'click';
  card.progress(auto ? `Always allowed on ${card.site}. Proving…` : 'Proving on this device…', 'Your key never leaves this browser.');
  let proof;
  try {
    proof = await background('prove', { challenge: await currentChallenge(pageChallenge), remember, trigger: auto ? 'auto' : 'click' });
  } catch (err) {
    if (err.code === 'page-gone') return card.remove();
    if (err.code === 'needs-consent') {
      // A first contact with this site happened moments ago (or is still being proved): ask instead.
      const state = await background('challenge-state', pageHints()).catch(() => null);
      if (!state || state.action === 'ignore') return card.remove();
      if (state.action === 'error') return card.error(view.beforeSpend(state));
      return ask(card, { ...state, reason: state.reason ?? err.reason ?? undefined }, pageChallenge);
    }
    return card.error(view.beforeSpend(err));
  }
  card.progress(`Proved in ${seconds(proof.provingMs)}. Signing in…`, `Sending the proof to ${card.site}.`);
  const toast = crypto.randomUUID();
  leaveToastId(toast); // before redeeming: the page may reload itself once the session exists
  const outcome = await redeem(proof.authorization);
  if (!outcome.ok) takeToastId();
  const report = await background('redeem-result', { spendId: proof.spendId, ...outcome, toast: outcome.ok ? toast : undefined }).catch(
    () => null,
  );
  if (!outcome.ok) return card.error(view.afterSpend(outcome, proof, report));
  card.success({ short: proof.short, slot: proof.slot, limit: proof.limit, provingMs: proof.provingMs, sub: 'Signed in. Reloading…' });
  setTimeout(() => location.reload(), RELOAD_DELAY_MS);
}

async function showToast(id) {
  const summary = await background('take-toast', { toast: id }).catch(() => null);
  if (!summary) return;
  const card = createCard({ origin: location.origin });
  card.success({ ...summary, sub: `Signed in to ${card.site}.`, autoCloseMs: TOAST_MS });
}

async function main() {
  if (window.top !== window) return;
  const toastId = takeToastId();
  const pageChallenge = meta('fuse-challenge');
  if (!pageChallenge) {
    if (toastId) await showToast(toastId);
    return;
  }
  // Before spending a slot for this page, the background checks it still exists.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === 'content' && message.type === 'alive' && sender.id === chrome.runtime.id) sendResponse({ alive: true });
    return false;
  });
  let state;
  try {
    state = await background('challenge-state', pageHints());
  } catch {
    return; // extension reloading or unavailable: stay out of the page
  }
  if (state.action === 'ignore') return;
  const card = createCard({ origin: location.origin });
  if (state.action === 'error') return card.error(views(card).beforeSpend(state));
  if (state.action === 'auto') return spend(card, { pageChallenge, trigger: 'auto' });
  ask(card, state, pageChallenge);
}

main();
