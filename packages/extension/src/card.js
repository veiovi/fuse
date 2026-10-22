// The in-page Fuse card. It lives in a closed shadow root (page CSS cannot
// reach it, page scripts cannot read it) and, where supported, in the top
// layer, so page overlays cannot cover it. Buttons act only on trusted
// (real user) clicks.
import { glyph, h, meter } from './dom.js';
import { displayHost, resetText } from './format.js';

const HOST_TAG = 'fuse-extension-card';

const STYLES = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 16px 16px auto auto !important;
  z-index: 2147483647 !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
  width: auto !important;
  height: auto !important;
  color-scheme: light dark;
}
.card {
  --ink: #141b2d; --ink-2: #3b4458; --muted: #677086; --line: #e4e7ed;
  --surface: #ffffff; --soft: #f5f6f8; --accent: #e8950c; --ok: #127a4b;
  --warn-bg: #fff7e8; --warn-line: #f2d39b; --warn-ink: #6d4a0c;
  --bad: #b42318; --bad-bg: #fef3f2; --bad-line: #f5c6c0;
  box-sizing: border-box;
  width: 352px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px 16px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(20, 27, 45, 0.06), 0 14px 36px rgba(20, 27, 45, 0.18);
  animation: enter 160ms ease-out;
  text-align: left;
}
@media (prefers-color-scheme: dark) {
  .card {
    --ink: #eef1f6; --ink-2: #c4cad6; --muted: #959db0; --line: #2d3547;
    --surface: #161c2b; --soft: #1d2436; --accent: #f5a524; --ok: #4cc38a;
    --warn-bg: #2b2414; --warn-line: #5c4a1f; --warn-ink: #f3d48f;
    --bad: #ff8a80; --bad-bg: #2d1a1a; --bad-line: #5c2b2b;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 14px 36px rgba(0, 0, 0, 0.45);
  }
}
@keyframes enter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.card.leaving { opacity: 0; transform: translateY(-6px); transition: opacity 280ms ease-in, transform 280ms ease-in; }
* { box-sizing: border-box; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.head svg { flex: none; border-radius: 5px; box-shadow: 0 0 0 1px var(--line); }
.brand { font-weight: 650; letter-spacing: 0.01em; }
.tag { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
.nowrap { white-space: nowrap; }
.x { margin-left: auto; width: 26px; height: 26px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
.x:hover { background: var(--soft); color: var(--ink); }
.title { margin: 0 0 4px; font-size: 14px; font-weight: 650; line-height: 1.35; word-break: break-word; }
.body { margin: 0; color: var(--ink-2); }
.body b { color: var(--ink); font-weight: 600; }
.meter-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.meter { flex: 1; }
.segments { display: flex; gap: 3px; }
.seg { flex: 1; height: 6px; border-radius: 3px; background: var(--line); }
.seg.on { background: var(--ink); }
.low .seg.on, .low .fill { background: var(--accent); }
.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--ink); }
.meter-label { flex: none; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.note { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink); }
.known { margin-top: 8px; font-size: 12px; color: var(--muted); }
.pseudonym { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--ink); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
button.btn { height: 32px; padding: 0 12px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
button.btn:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--ink); color: var(--surface); }
.primary:hover { filter: brightness(1.15); }
.secondary { background: var(--surface); color: var(--ink); border-color: var(--line) !important; }
.secondary:hover { background: var(--soft); }
.ghost { background: transparent; color: var(--muted); margin-left: auto; }
.ghost:hover { color: var(--ink); }
.status { display: flex; align-items: center; gap: 10px; }
.spinner { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--ink); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.success-line { display: flex; align-items: center; gap: 8px; font-weight: 600; font-variant-numeric: tabular-nums; }
.success-line .pseudonym { font-size: 13px; }
.check { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--ok); color: var(--surface); font-size: 12px; }
.error .title { color: var(--bad); }
.error-box { margin-top: 2px; }
`;

let sheet = null;
function styleSheet() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
  }
  return sheet;
}

/** Wraps a handler so only genuine user clicks (not page-synthesized events) trigger it. */
function trusted(handler) {
  return (event) => {
    if (event.isTrusted) handler(event);
  };
}

export function createCard({ origin }) {
  document.querySelector(HOST_TAG)?.remove();
  const site = displayHost(origin);
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [styleSheet()];
  const card = h('div', { class: 'card', role: 'region', 'aria-label': 'Fuse', 'aria-live': 'polite' });
  root.append(card);
  document.documentElement.append(host);
  try {
    host.popover = 'manual';
    host.showPopover();
  } catch {
    // No top layer here; the fixed position and maximal z-index still apply.
  }

  const close = () => host.remove();

  function render(state, ...content) {
    card.dataset.state = state;
    card.className = `card ${state}`;
    const header = h(
      'div',
      { class: 'head' },
      glyph(20),
      h('span', { class: 'brand' }, 'Fuse'),
      h('span', { class: 'tag' }, site),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', dataset: { action: 'close' }, onclick: trusted(close) }, '×'),
    );
    card.replaceChildren(header, ...content.filter(Boolean));
  }

  function button(label, kind, action, handler) {
    return h('button', { class: `btn ${kind}`, type: 'button', dataset: { action }, onclick: trusted(handler) }, label);
  }

  return {
    site,

    /** The question. state: challenge-state answer; handlers: { allow, always }. */
    ask(state, { allow, always }) {
      const notes = [];
      if (state.reason === 'recent-spend') {
        notes.push(
          h('div', { class: 'note' }, `You already spent a slot here recently. Sites normally keep you signed in with a cookie, so repeated requests may be draining your budget.`),
        );
      } else if (state.reason === 'banned') {
        notes.push(h('div', { class: 'note' }, `This site has banned your pseudonym here. Trying again spends a slot and will probably fail.`));
      }
      if (state.otherRegistry) {
        notes.push(
          h(
            'div',
            { class: 'note' },
            `This site names the registry ${displayHost(state.otherRegistry)}, but your credential is from ${displayHost(state.registry)}. It may not accept it.`,
          ),
        );
      }
      render(
        'ask',
        h('p', { class: 'title' }, `${site} asks for a Fuse proof.`),
        h(
          'p',
          { class: 'body' },
          state.remaining === 1
            ? ['Spend your ', h('b', {}, 'last'), ' slot for today?']
            : ['Spend 1 of your ', h('b', {}, String(state.remaining)), ' remaining slots today?'],
          ' The site will see only a pseudonym unique to it.',
        ),
        state.returning
          ? h('div', { class: 'known' }, 'You have been here before as ', h('span', { class: 'pseudonym' }, state.returning.short), '.')
          : null,
        h(
          'div',
          { class: 'meter-row', title: `Slots ${resetText(state.resetsAt)}` },
          meter(state),
          h('span', { class: 'meter-label' }, `${state.remaining} of ${state.limit} left today`),
        ),
        ...notes,
        h(
          'div',
          { class: 'actions' },
          button('Allow', 'primary', 'allow', allow),
          button('Always for this site', 'secondary', 'always', always),
          button('Not now', 'ghost', 'dismiss', close),
        ),
      );
    },

    progress(title, sub) {
      render(
        'working',
        h('div', { class: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'title' }, title)),
        sub ? h('p', { class: 'sub' }, sub) : null,
      );
    },

    /** The success line; with `autoCloseMs` the card fades away by itself. */
    success({ short, slot, limit, provingMs, sub, autoCloseMs }) {
      if (autoCloseMs) {
        setTimeout(() => {
          card.classList.add('leaving');
          setTimeout(close, 300);
        }, autoCloseMs);
      }
      render(
        'success',
        h(
          'div',
          { class: 'success-line', dataset: { role: 'summary' } },
          h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'),
          h(
            'span',
            {},
            h('span', { class: 'pseudonym' }, short),
            h('span', { class: 'nowrap' }, ` · slot ${slot + 1}/${limit}`),
            h('span', { class: 'nowrap' }, ` · proved in ${(provingMs / 1000).toFixed(1)} s`),
          ),
        ),
        h('p', { class: 'sub' }, sub),
      );
    },

    /**
     * view: { title, body, actions: [{ label, kind, action, handler }], tone }
     * tone 'bad' (default) for failures, 'info' for a state to act on.
     */
    error({ title, body, actions = [], tone = 'bad' }) {
      render(
        tone === 'info' ? 'notice' : 'error',
        h('div', { class: 'error-box' }, h('p', { class: 'title' }, title), h('p', { class: 'body' }, body)),
        actions.length
          ? h('div', { class: 'actions' }, ...actions.map((a) => button(a.label, a.kind ?? 'secondary', a.action, a.handler ?? close)))
          : null,
      );
    },

    remove: close,
  };
}
