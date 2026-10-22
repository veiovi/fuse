// Fuse network explorer page. Renders /api/state, follows /api/events and
// runs scenarios. Panels always render from the latest snapshot; events only
// schedule a refresh (and feed the scenario console), so the page cannot
// drift from the network. Lists are keyed, so only new rows animate.
import { subscribeSse } from '/sse.js';
import { burnPlot, onePointPlot } from '/plot.js';
import {
  cacheHit,
  clock,
  count,
  describeEvent,
  esc,
  hostOf,
  isAlarmEvent,
  isRedundantEvent,
  lowBits,
  plural,
  safeUrl,
  seconds,
  shortHex,
  shortPseudonym,
  until,
} from '/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const field = (root, name) => $(`[data-field="${name}"]`, root);

const MAX_FUSES = 240;
const TAPE_ROWS = 50;
const SITE_EVENTS = 6;
const SITE_PSEUDONYMS = 12;
const CONSOLE_LINES = 500;
const EPOCH_MS = 86_400_000;

const MODES = {
  proxy: 'Gateway as a reverse proxy in front of an unchanged app',
  middleware: 'Gateway as Express middleware inside the app',
};

const view = {
  primed: new Set(), // sections that have rendered real data once; after that, new rows animate
  members: new Map(), // credential index → status at the last render
  epoch: null,
  bootId: null,
  scenarios: [],
  run: null,
};

// ---------------------------------------------------------------------------
// Snapshot refresh: trailing debounce, at most one request in flight, and
// never more than ~400 ms behind during a burst of events.

let refreshTimer = null;
let burstStart = 0;
let inFlight = false;
let pending = false;

function scheduleRefresh() {
  const now = Date.now();
  if (!refreshTimer) burstStart = now;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, Math.max(0, Math.min(120, burstStart + 400 - now)));
}

async function refresh() {
  refreshTimer = null;
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.ok) render(await res.json());
  } catch {
    // The event stream reports the outage; the next event or reconnect retries.
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      scheduleRefresh();
    }
  }
}

function render(state) {
  renderServices(state);
  renderRegistry(state.registry ?? {});
  renderLog(state.log ?? {}, state.epoch);
  renderBurned(state.log ?? {}, state.sites ?? []);
  renderSites(state.sites ?? []);
}

// ---------------------------------------------------------------------------
// Keyed list rendering: reuse elements by key, insert new ones in place.

function syncList(container, items, { key, create, update, section }) {
  const existing = new Map();
  for (const el of [...container.children]) {
    if (el.dataset.key) existing.set(el.dataset.key, el);
    else el.remove();
  }
  const wanted = new Set(items.map(key));
  for (const [k, el] of existing) {
    if (!wanted.has(k)) {
      el.remove();
      existing.delete(k);
    }
  }
  const animate = view.primed.has(section);
  items.forEach((item, i) => {
    const k = key(item);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      el.dataset.key = k;
      if (animate) flash(el, 'is-new');
    }
    update?.(el, item);
    const at = container.children[i];
    if (at !== el) container.insertBefore(el, at ?? null);
  });
}

const flashTimers = new WeakMap();

/**
 * (Re)start a one-shot CSS animation class, and drop it once every animation
 * it drives (children included) is over. A timer rather than animationend,
 * because children's animationend events bubble up early.
 */
function flash(el, className, ms = 2600) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  const timers = flashTimers.get(el) ?? new Map();
  clearTimeout(timers.get(className));
  timers.set(className, setTimeout(() => el.classList.remove(className), ms));
  flashTimers.set(el, timers);
}

function element(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setLink(panel, name, url) {
  const link = $(`[data-link="${name}"]`, panel);
  const href = safeUrl(url);
  if (!link || !href) return;
  link.href = href;
  link.textContent = hostOf(href);
}

function setDown(panel, part, label) {
  const note = $(':scope > .panel-down', panel);
  if (!note) return;
  note.hidden = part.ok !== false;
  if (part.ok === false) note.textContent = `Can’t reach the ${label} (${part.error ?? 'no answer'}). Showing what was last known; this updates when it’s back.`;
}

// ---------------------------------------------------------------------------
// Services strip (the explorer's own view of each component's event stream)

function renderServices(state) {
  const list = $('#services');
  for (const site of state.sites ?? []) {
    if (!$$('.service', list).some((li) => li.dataset.source === site.id)) {
      const li = document.createElement('li');
      li.className = 'service';
      li.dataset.source = site.id;
      li.textContent = site.name;
      list.append(li);
    }
  }
  for (const li of $$('.service', list)) {
    const status = state.sources?.[li.dataset.source];
    setServiceStatus(li.dataset.source, status?.status, status?.error);
  }
}

function setServiceStatus(source, status = 'connecting', error) {
  const li = $$('#services .service').find((el) => el.dataset.source === source);
  if (!li) return;
  li.dataset.status = status;
  li.title =
    status === 'open' ? `${li.textContent}: live` : status === 'closed' ? `${li.textContent}: not reachable${error ? ` (${error})` : ''}` : `${li.textContent}: connecting`;
}

// ---------------------------------------------------------------------------
// 1. Registry

function renderRegistry(registry) {
  const panel = $('#registry');
  setLink(panel, 'registry', registry.publicUrl ?? registry.url);
  setDown(panel, registry, 'registry');
  const info = registry.info;
  if (!info) return;
  const members = registry.members ?? [];

  field(panel, 'size').textContent = count(info.size ?? members.length);
  field(panel, 'active').textContent = count(info.active);
  field(panel, 'burned').textContent = count(info.burned);
  field(panel, 'withdrawn').textContent = count(info.withdrawn ?? 0);
  panel.classList.toggle('has-burned', info.burned > 0);
  const currency = info.currency ?? 'credits';
  field(panel, 'locked').textContent = count(info.lockedDeposits);
  field(panel, 'slashed').textContent = count(info.slashedDeposits ?? 0);
  $('.deposits dt', panel).textContent = `${currency} locked`;
  const root = field(panel, 'root');
  root.textContent = shortHex(info.root, 6, 6);
  root.title = info.root ?? '';

  $('#tiers').innerHTML = (info.tiers ?? [])
    .map(
      (t) =>
        `<tr><th scope="row"><span class="tier-name"><span class="fuse" data-tier="${esc(t.id)}" aria-hidden="true"></span>${esc(t.id)}</span></th><td>${count(t.deposit)}</td><td>${count(t.limit)}</td></tr>`,
    )
    .join('');

  renderFuses(members);
  view.primed.add('registry');
}

function renderFuses(members) {
  const box = $('#fusebox');
  const shown = members.slice(-MAX_FUSES);
  const hidden = members.length - shown.length;
  const animate = view.primed.has('registry');
  if (!members.length) {
    box.innerHTML = '<p class="fusebox-empty">No credentials yet. Every scenario starts with a deposit here.</p>';
    view.members.clear();
    return;
  }
  box.querySelector('.fusebox-empty')?.remove();

  syncList(
    box,
    shown.map((m) => ({ ...m, key: String(m.index) })),
    {
      section: 'registry',
      key: (m) => m.key,
      create: () => element('<span class="fuse"></span>'),
      update: (el, m) => {
        const before = view.members.get(m.index);
        el.dataset.tier = m.tier;
        el.classList.toggle('is-burned', m.status === 'burned');
        el.classList.toggle('is-withdrawn', m.status === 'withdrawn');
        el.title = `Credential #${m.index}: ${m.tier}, ${count(m.limit)} slots a day, ${m.status}`;
        if (animate && before === 'active' && m.status === 'burned') flash(el, 'just-burned');
        view.members.set(m.index, m.status);
      },
    },
  );
  box.dataset.more = hidden > 0 ? `+${count(hidden)} earlier` : '';
  box.setAttribute('aria-label', `${plural(members.length, 'credential', 'credentials')}, one fuse each`);
}

// ---------------------------------------------------------------------------
// 2. Shared log

function renderLog(log, epoch) {
  const panel = $('#log');
  setLink(panel, 'log', log.publicUrl ?? log.url);
  setDown(panel, log, 'shared log');
  view.epoch = log.info?.epoch ?? epoch ?? view.epoch;
  updateReset();
  if (!log.info) return;

  field(panel, 'today').textContent = count(log.entriesToday);
  field(panel, 'size').textContent = count(log.info.size);
  const sth = log.info.sth;
  const sthLine = field(panel, 'sth');
  sthLine.innerHTML = sth
    ? `Signed tree head: root <code>${esc(shortHex(sth.rootHash, 6, 4))}</code> over ${plural(sth.treeSize, 'entry', 'entries')}, signed at ${esc(clock(sth.timestamp))}.`
    : '';
  sthLine.title = sth ? `Root ${sth.rootHash}\nEd25519 signature ${sth.signature}` : '';

  const reused = new Set();
  for (const rev of log.revocations ?? []) for (const share of rev.shares ?? []) reused.add(share.seq);
  const entries = [...(log.entries ?? [])].sort((a, b) => b.seq - a.seq).slice(0, TAPE_ROWS);
  $('#tape-empty').hidden = entries.length > 0;
  syncList($('#tape'), entries, {
    section: 'tape',
    // seq alone is not enough: after a reset the log reuses sequence numbers.
    key: (e) => `${e.seq}:${e.nullifier}`,
    create: tapeRow,
    update: (li, e) => {
      const burned = Boolean(e.revocation) || reused.has(e.seq);
      li.classList.toggle('is-reused', burned);
      $('.tape-flag', li).textContent = burned ? 'reused' : '';
    },
  });
  view.primed.add('tape');
}

function tapeRow(entry) {
  return element(`<li class="tape-row" data-seq="${esc(entry.seq)}">
    <span class="tape-seq">${esc(entry.seq)}</span>
    ${holes(entry.nullifier)}
    <code class="tape-tag" title="Slot tag ${esc(entry.nullifier)}">${esc(shortHex(entry.nullifier))}</code>
    <span class="tape-meta"><span class="tape-flag"></span><time datetime="${esc(entry.at)}" title="Epoch ${esc(entry.epoch)}">${esc(clock(entry.at))}</time></span>
  </li>`);
}

/** The tag's low 12 bits as punched tape: hole = 1, faint guide = 0, sprocket hole in the middle. */
function holes(tag) {
  const bits = lowBits(tag, 12);
  let marks = '';
  for (let i = 0; i < 12; i++) {
    const x = 6 + i * 7 + (i >= 6 ? 7 : 0);
    const on = (bits >> (11 - i)) & 1;
    marks += on ? `<circle class="hole" cx="${x}" cy="8" r="2.5"/>` : `<circle class="blank" cx="${x}" cy="8" r="0.85"/>`;
  }
  return `<svg class="tape-holes" viewBox="0 0 96 16" aria-hidden="true">${marks}<circle class="sprocket" cx="48" cy="8" r="1.5"/></svg>`;
}

function updateReset() {
  const cell = field($('#log'), 'reset');
  if (!cell || view.epoch == null) return;
  const next = (view.epoch + 1) * EPOCH_MS;
  cell.textContent = until(next);
  cell.title = `Day ${view.epoch} ends at ${new Date(next).toUTCString()}`;
}

// ---------------------------------------------------------------------------
// Burned keys

function renderBurned(log, sites) {
  const panel = $('#burned');
  const container = $('#burns');
  const revs = [...(log.revocations ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  field(panel, 'burned-count').textContent = revs.length ? plural(revs.length, 'key', 'keys') : '';
  panel.classList.toggle('has-burned', revs.length > 0);

  if (!revs.length) {
    if (!$('.burn-empty', container)) container.replaceChildren(emptyBurn());
    view.primed.add('burns');
    return;
  }
  $('.burn-empty', container)?.remove();
  const animate = view.primed.has('burns');
  let fresh = null;
  syncList(container, revs, {
    section: 'burns',
    key: (rev) => String(rev.id),
    create: (rev) => (fresh = burnCard(rev, { fresh: animate })),
    update: (card, rev) => {
      $('.burn-banned', card).innerHTML = bannedAs(rev, sites);
    },
  });
  view.primed.add('burns');
  // A burn caused by a run started from this page is the answer to that
  // click, so make sure it is on screen.
  if (fresh && animate && view.run?.startedHere) {
    const box = fresh.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight) {
      fresh.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

function emptyBurn() {
  const doubleSpend = view.scenarios.find((s) => /double|reuse|cheat/i.test(`${s.id} ${s.title}`));
  return element(`<div class="burn-empty">
    <figure class="burn-figure">${onePointPlot()}<figcaption>One point reveals nothing: its line could meet the axis anywhere</figcaption></figure>
    <p>No keys burned yet. A client that spends the same slot twice puts a second point on its line; anyone holding both can draw the line back to the key. ${
      doubleSpend ? `Run <strong>${esc(doubleSpend.title)}</strong> to watch one burn.` : ''
    }</p>
  </div>`);
}

function burnCard(rev, { fresh }) {
  const [first, second] = rev.shares ?? [];
  const share = (s, n) =>
    s
      ? `<div><dt>${Number.isInteger(s.seq) ? `Entry ${esc(s.seq)}` : `Share ${n}`}</dt><dd><code title="x = ${esc(s.x)}">x ${esc(shortHex(s.x))}</code><code title="y = ${esc(s.y)}">y ${esc(shortHex(s.y))}</code></dd></div>`
      : '';
  const slashed = rev.registry?.slashed;
  const credential = rev.registry
    ? `${slashed ? `${count(slashed.amount)} ${esc(slashed.currency)}, ` : ''}credential #${esc(rev.registry.index)}`
    : 'Nothing yet: no registry answered';
  return element(`<article class="burn${fresh ? ' is-fresh' : ''}">
    <figure class="burn-figure">${burnPlot(rev, { fresh })}<figcaption>Two points from the same slot → the key</figcaption></figure>
    <dl class="burn-values">
      <div class="burn-key"><dt>Key</dt><dd><code title="k = ${esc(rev.secret)}">k ${esc(shortHex(rev.secret, 6, 6))}</code></dd></div>
      ${share(first, 1)}
      ${share(second, 2)}
      <div><dt>Slot tag</dt><dd><code title="${esc(rev.nullifier)}">${esc(shortHex(rev.nullifier))}</code></dd></div>
      <div><dt>Slashed</dt><dd>${credential}</dd></div>
      <div><dt>Banned as</dt><dd class="burn-banned"></dd></div>
    </dl>
    <p class="burn-check${rev.verified ? '' : ' is-suspect'}"><span>${
      rev.verified ? 'Checked here: both shares lie on one line through k.' : 'These shares do not recover this key. Treat it as suspect.'
    }</span><time datetime="${esc(rev.at)}">${esc(clock(rev.at))}</time></p>
  </article>`);
}

function bannedAs(rev, sites) {
  const names = rev.pseudonyms ?? [];
  if (!names.length) return '–';
  return names
    .map((p) => {
      const site = sites.find((s) => s.id === p.site);
      const status = p.seen ? (p.banned ? '' : ', not yet banned') : ', never visited';
      return `<span class="burn-pseudonym${p.seen ? '' : ' is-unseen'}"><code>${esc(p.short ?? shortPseudonym(p.pseudonym))}</code> at ${esc(site?.name ?? p.name ?? p.site)}${esc(status)}</span>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 3. Sites

function renderSites(sites) {
  const list = $('#site-list');
  for (const site of sites) {
    let card = $$('.site', list).find((el) => el.dataset.site === site.id);
    if (!card) {
      card = siteCard(site);
      list.append(card);
    }
    updateSite(card, site);
  }
}

function siteCard(site) {
  const href = safeUrl(site.publicUrl ?? site.url);
  const card = element(`<article class="site">
    <div class="site-head">
      <h3 class="site-name">${href ? `<a href="${esc(href)}">${esc(site.name)}</a>` : esc(site.name)}</h3>
      <span class="site-host">${esc(hostOf(href ?? ''))}</span>
    </div>
    <p class="site-mode">${esc(MODES[site.mode] ?? site.mode)}</p>
    <p class="panel-down" hidden></p>
    <dl class="tally">
      <div><dt>Pseudonyms</dt><dd data-field="pseudonyms">–</dd></div>
      <div><dt>First contacts</dt><dd data-field="contacts">–</dd></div>
      <div class="tally-burned"><dt>Banned</dt><dd data-field="banned">–</dd></div>
    </dl>
    <ul class="pseudonyms" aria-label="Pseudonyms at ${esc(site.name)}"></ul>
    <ol class="site-events" aria-label="Recent gateway events at ${esc(site.name)}" data-empty="No gateway activity yet. Challenges, proofs and bans show up here."></ol>
  </article>`);
  card.dataset.site = site.id;
  return card;
}

function updateSite(card, site) {
  const down = $('.panel-down', card);
  down.hidden = site.ok !== false;
  if (site.ok === false) down.textContent = `Can’t reach ${site.name} (${site.error ?? 'no answer'}).`;

  const seenAt = (p) => Date.parse(p.lastSeen ?? '') || 0;
  const pseudonyms = [...(site.pseudonyms ?? [])].sort((a, b) => seenAt(b) - seenAt(a));
  const banned = pseudonyms.filter((p) => p.banned).length;
  field(card, 'pseudonyms').textContent = count(pseudonyms.length);
  field(card, 'contacts').textContent = count(pseudonyms.reduce((n, p) => n + (p.firstContacts ?? 0), 0));
  field(card, 'banned').textContent = count(banned);
  card.classList.toggle('has-burned', banned > 0);

  const section = `site:${site.id}`;
  const shown = pseudonyms.slice(0, SITE_PSEUDONYMS);
  const pills = $('.pseudonyms', card);
  syncList(pills, shown, {
    section,
    key: (p) => p.pseudonym,
    create: (p) => element(`<li class="pseudonym"><code>${esc(p.short ?? shortPseudonym(p.pseudonym))}</code></li>`),
    update: (li, p) => {
      li.classList.toggle('is-banned', Boolean(p.banned));
      li.classList.toggle('is-probation', !p.banned && p.reputation === 'probation');
      const standing = p.banned
        ? `banned${p.bannedReason ? `: ${p.bannedReason}` : ''}`
        : p.reputation === 'probation'
          ? 'on probation'
          : p.reputation;
      const seen = p.firstSeen ? `first seen ${clock(p.firstSeen)}` : 'never visited';
      li.title = `${p.pseudonym}\n${standing}; ${plural(p.requests ?? 0, 'request', 'requests')}, ${seen}`;
    },
  });
  pills.dataset.more = pseudonyms.length > shown.length ? `+${count(pseudonyms.length - shown.length)} more` : '';
  pills.dataset.empty = pseudonyms.length ? '' : 'No visitors with a credential yet.';

  const events = collapseCache((site.recentEvents ?? []).filter((e) => e.type !== 'hello' && !isRedundantEvent(e)))
    .slice(-SITE_EVENTS)
    .reverse();
  syncList($('.site-events', card), events, {
    section,
    key: (e) => `${e.at}|${e.type}|${e.pseudonym ?? e.short ?? ''}|${e.repeat ?? 1}`,
    create: (e) =>
      element(`<li class="site-event${isAlarmEvent(e) ? ' is-alarm' : ''}" title="${esc(eventDetail(e))}"><time datetime="${esc(e.at)}">${esc(clock(e.at))}</time><span>${esc(
        e.repeat > 1 ? `${describeEvent(e)} (${e.repeat} times)` : describeEvent(e),
      )}</span></li>`),
  });
  view.primed.add(section);
}

/** Hover text: the request and anything measured. */
function eventDetail(e) {
  const parts = [];
  if (e.method || e.path) parts.push(`${e.method ?? ''} ${e.path ?? ''}`.trim());
  if (e.pseudonym) parts.push(e.pseudonym);
  if (Number.isFinite(e.verifyMs)) parts.push(`proof checked in ${e.verifyMs} ms`);
  if (Number.isInteger(e.seq)) parts.push(`log entry ${e.seq}`);
  if (e.reason) parts.push(`reason: ${e.reason}`);
  return parts.join('\n');
}

/** Fold runs of cache events into one line so browsing doesn't drown out proofs. */
function collapseCache(events) {
  const out = [];
  for (const e of events) {
    const last = out.at(-1);
    if (e.type === 'cache' && last?.type === 'cache' && cacheHit(last) === cacheHit(e)) {
      out[out.length - 1] = { ...e, path: last.path === e.path ? e.path : 'public pages', repeat: (last.repeat ?? 1) + 1 };
    } else {
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activity pulse on the three steps

const STEP_OF = { registry: 'registry', log: 'log' };

function pulse(source, type) {
  if (type === 'cache' || type === 'hello') return;
  const step = STEP_OF[source] ?? 'sites';
  const el = $(`.step[data-step="${step}"] .step-n`);
  if (el) flash(el, 'is-pulsing');
}

// ---------------------------------------------------------------------------
// Scenarios

async function loadScenarios() {
  try {
    const res = await fetch('/api/scenarios', { cache: 'no-store' });
    const { scenarios = [], current = null } = await res.json();
    view.scenarios = scenarios;
    renderScenarioList();
    if (current) showRun(current);
    const empty = $('.burn-empty');
    if (empty) empty.replaceWith(emptyBurn());
  } catch {
    // Retried on the next hello.
  }
}

function renderScenarioList() {
  const list = $('#scenario-list');
  if (!view.scenarios.length) {
    list.innerHTML = '<li class="scenario-none">No scenarios are loaded. Start the explorer with <code>npm run demo</code> to get them.</li>';
    return;
  }
  list.innerHTML = view.scenarios
    .map(
      (s) => `<li class="scenario" data-id="${esc(s.id)}">
        <div class="scenario-text"><h3>${esc(s.title)}</h3><p title="${esc(s.summary)}">${esc(s.summary)}</p></div>
        <button type="button" class="run-button" data-run="${esc(s.id)}" aria-label="Run ${esc(s.title)}">Run</button>
      </li>`,
    )
    .join('');
  updateRunButtons();
}

function updateRunButtons() {
  const running = view.run?.status === 'running' ? view.run.id : null;
  for (const button of $$('#scenario-list [data-run]')) {
    const isThis = button.dataset.run === running;
    button.disabled = Boolean(running);
    button.textContent = isThis ? 'Running' : 'Run';
    button.closest('.scenario').classList.toggle('is-running', isThis);
  }
}

$('#scenario-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-run]');
  if (!button || button.disabled) return;
  const id = button.dataset.run;
  button.disabled = true;
  try {
    const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}/run`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202) {
      showRun({ ...body, id, status: 'running', output: [] });
      if (view.run?.runId === body.runId) view.run.startedHere = true;
    }
    else if (res.status === 409) setConsoleStatus('Another scenario is still running.', 'failed');
    else setConsoleStatus(`Could not start it (${body.error ?? `HTTP ${res.status}`}).`, 'failed');
  } catch {
    setConsoleStatus('The explorer is not answering.', 'failed');
  }
  updateRunButtons();
});

/** Show a run (from the API or a scenario-started event); ignores a run already shown. */
function showRun(run) {
  if (view.run?.runId === run.runId && view.run.status !== 'running') {
    updateRunButtons(); // already finished; a late POST response must not revive it
    return;
  }
  if (view.run?.runId !== run.runId) {
    view.run = { ...run, output: [] };
    $('#console-title').textContent = run.title ?? scenarioTitle(run.id);
    const summary = view.scenarios.find((s) => s.id === run.id)?.summary;
    $('#console-summary').textContent = summary ?? '';
    $('#console-summary').title = summary ?? '';
    $('#console-summary').hidden = !summary;
    $('#console-lines').replaceChildren();
    for (const line of run.output ?? []) appendLine(line);
  }
  if (run.status && run.status !== 'running') finishRun(run);
  else setConsoleStatus('Running', 'running');
  $('#console-empty').hidden = true;
  updateRunButtons();
}

function finishRun(run) {
  Object.assign(view.run, run);
  const took = run.durationMs != null ? seconds(run.durationMs) : '';
  if (run.status === 'failed' || run.ok === false) {
    setConsoleStatus(`Failed${took ? ` after ${took}` : ''}`, 'failed');
    if (run.error?.message && !$('#console-lines .is-error')) appendLine(run.error.message, 'is-error');
  } else {
    setConsoleStatus(`Finished${took ? ` in ${took}` : ''}`, 'finished');
  }
  updateRunButtons();
}

function scenarioTitle(id) {
  return view.scenarios.find((s) => s.id === id)?.title ?? id;
}

function setConsoleStatus(text, state) {
  const status = $('#console-status');
  status.textContent = text;
  status.dataset.state = state;
}

function appendLine(text, className = '') {
  const lines = $('#console-lines');
  const stick = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;
  const li = document.createElement('li');
  if (className) li.className = className;
  li.textContent = text;
  lines.append(li);
  while (lines.children.length > CONSOLE_LINES) lines.firstElementChild.remove();
  if (stick) lines.scrollTop = lines.scrollHeight;
}

// ---------------------------------------------------------------------------
// Event stream

function handleEvent({ data }) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  switch (event.type) {
    case 'hello':
      if (event.source === 'explorer') {
        if (view.bootId && view.bootId !== event.bootId) loadScenarios();
        view.bootId = event.bootId;
        if (event.scenario) showRun(event.scenario);
      }
      scheduleRefresh();
      return;
    case 'scenario-started':
      showRun({ ...event, status: 'running', output: [] });
      return;
    case 'scenario-output':
      if (view.run?.runId !== event.runId) showRun({ runId: event.runId, id: event.id, status: 'running', output: [] });
      appendLine(event.line);
      return;
    case 'scenario-finished':
      if (view.run?.runId !== event.runId) showRun({ runId: event.runId, id: event.id, status: 'running', output: [] });
      finishRun({ ...event, status: event.ok ? 'finished' : 'failed' });
      scheduleRefresh();
      return;
    case 'source-status':
      setServiceStatus(event.source, event.status, event.error);
      scheduleRefresh();
      return;
    default:
      pulse(event.source, event.type);
      scheduleRefresh();
  }
}

subscribeSse('/api/events', {
  minDelay: 500,
  maxDelay: 5000,
  onEvent: handleEvent,
  onStatus: ({ status }) => {
    document.body.dataset.live = status;
    if (status === 'closed') for (const li of $$('#services .service')) setServiceStatus(li.dataset.source, 'closed', 'explorer offline');
  },
});

setInterval(updateReset, 15_000);
loadScenarios();
refresh();
